import type {
  ColumnState,
  FilterModel,
  GridState,
  IServerSideDatasource,
  IServerSideGetRowsParams,
} from 'ag-grid-community';
import {
  deviceGroupFieldSchema,
  type DeviceGroupField,
  type DeviceGroupPage,
  type DeviceGrouping,
  type DevicePage,
  type DevicePredicate,
  type DeviceQuery,
  type DeviceRow,
  type DeviceSelectionKey,
} from '@campus/application-contracts';
import { DEVICE_FIELDS, type DeviceSortField } from './device-fields';
import { predicatesFromFilterModel } from './device-filter-model';

export type DeviceSort = DeviceQuery['sort'];
/** The query behind the grid. Next device follows the same query. */
export interface DeviceView {
  predicates: DevicePredicate[];
  sort: DeviceSort;
  selection: DeviceSelectionKey | null;
  /** Grouped fields and the keys of the open group. Absent while the grid is flat. */
  group?: DeviceGrouping;
}
export type DeviceLoader = (
  offset: number,
  limit: number,
  view: DeviceView,
) => Promise<DevicePage | null>;
/** LibreGrid loads an open group in one request, so each request lists at most this many groups or devices. */
export const GROUP_LIMIT = 1000;
export type DeviceGroupLoader = (
  view: DeviceView,
) => Promise<DeviceGroupPage | null>;
/** Reads the pending view's rows: the device IDs of the grid draft. */
export type DevicePendingLoader = (
  ids: readonly string[],
) => Promise<DeviceRow[] | null>;

const defaultSort: DeviceSort = { field: 'serialNumber', direction: 'asc' };

export function sortFromModel(
  model: readonly { colId: string; sort: 'asc' | 'desc' }[] | undefined,
): DeviceSort {
  const first = model?.[0];
  const field = DEVICE_FIELDS.find(
    (candidate) => candidate.id === first?.colId,
  );
  return field && first
    ? { field: field.id, direction: first.sort }
    : defaultSort;
}

/** Partial, so columns keep the hidden and pinned settings of their definitions. */
export function defaultGridState(): GridState {
  return {
    sort: { sortModel: [{ colId: 'serialNumber', sort: 'asc' }] },
    partialColumnState: true,
  };
}

/** The server keeps the selection. Restoring row selection state would fight it. */
export function savedGridState(state: GridState): GridState {
  const rest = { ...state };
  delete rest.rowSelection;
  return rest;
}

/**
 * A saved sort model orders its entries by priority. Column state arrives in column
 * order, so sortIndex decides which sort comes first (B5).
 */
export function sortModelFromColumnState(
  state: readonly ColumnState[],
): { colId: string; sort: 'asc' | 'desc' }[] {
  return state
    .filter(
      (item): item is ColumnState & { sort: 'asc' | 'desc' } =>
        item.sort === 'asc' || item.sort === 'desc',
    )
    .sort(
      (left, right) =>
        (left.sortIndex ?? Number.MAX_SAFE_INTEGER) -
        (right.sortIndex ?? Number.MAX_SAFE_INTEGER),
    )
    .map((item) => ({ colId: item.colId, sort: item.sort }));
}

/** Adapt LibreGrid block requests to the device query endpoint (GRID-01). */
export function deviceDatasource(
  load: DeviceLoader,
  onLoaded?: (page: DevicePage) => void,
  selection?: DeviceSelectionKey,
  loadGroups?: DeviceGroupLoader,
): IServerSideDatasource<DeviceRow> {
  return {
    getRows(params: IServerSideGetRowsParams<DeviceRow>) {
      let predicates: DevicePredicate[];
      let by: DeviceGroupField[];
      try {
        predicates = predicatesFromFilterModel(
          params.request.filterModel as FilterModel | null,
        );
        by = (params.request.rowGroupCols ?? []).map((column) =>
          deviceGroupFieldSchema.parse(column.id),
        );
      } catch {
        params.fail();
        return;
      }
      const keys = params.request.groupKeys ?? [];
      const view: DeviceView = {
        predicates,
        sort: sortFromModel(params.request.sortModel),
        // Show All Selected limits the query to this tab's selection.
        selection:
          selection && params.api.getGridOption('ssrmSelectionViewActive')
            ? selection
            : null,
        ...(by.length ? { group: { by, keys } } : {}),
      };
      if (by.length && keys.length < by.length) {
        if (!loadGroups) return params.fail();
        loadGroups(view).then(
          (page) => {
            if (!page) return params.fail();
            // LibreGrid reads each group row's key and keeps the record for the group column.
            params.success({
              rowData: page.groups as unknown as DeviceRow[],
              rowCount: page.groupCount,
            });
          },
          () => params.fail(),
        );
        return;
      }
      const offset = params.request.startRow ?? 0;
      const limit = by.length
        ? GROUP_LIMIT
        : Math.min(
            200,
            Math.max(1, (params.request.endRow ?? offset + 100) - offset),
          );
      load(offset, limit, view).then(
        (page) => {
          if (!page) return params.fail();
          params.success({ rowData: page.rows, rowCount: page.matching });
          onLoaded?.(page);
        },
        () => params.fail(),
      );
    },
  };
}

/** The battery classes in the order of the device query (`device-query.ts`). */
const batteryOrder: Readonly<Record<string, number>> = {
  'replace-now': 0,
  'replace-soon': 1,
  normal: 2,
  'no-report': 3,
  unavailable: 4,
};

/** The value that the device query orders by, or null for a missing value. */
function sortValue(
  row: DeviceRow,
  field: DeviceSortField,
): string | number | null {
  switch (field) {
    case 'serialNumber':
      return row.serialNumber;
    case 'model':
      return row.model;
    case 'assetTag':
      return row.assetTag;
    case 'orgUnitPath':
      return row.orgUnitPath;
    case 'status':
      return row.status;
    case 'lastContact':
      return row.lastContact;
    case 'annotatedLocation':
      return row.annotatedLocation;
    case 'annotatedUser':
      return row.annotatedUser;
    case 'notes':
      return row.notes;
    case 'battery':
      return row.battery.status === 'reported'
        ? (batteryOrder[row.battery.health] ?? 2)
        : (batteryOrder[row.battery.status] ?? 4);
  }
}

/**
 * Sort the pending view's rows in the browser. The server orders a query by its sort
 * column with nulls last, then by device ID in the same direction (`device-query.ts`).
 * The pending view has no server query, so it follows the same order here.
 */
export function sortPendingRows(
  rows: readonly DeviceRow[],
  sort: DeviceSort,
): DeviceRow[] {
  const direction = sort.direction === 'desc' ? -1 : 1;
  const byId = (left: DeviceRow, right: DeviceRow): number =>
    left.deviceId < right.deviceId
      ? -direction
      : left.deviceId > right.deviceId
        ? direction
        : 0;
  return [...rows].sort((left, right) => {
    const leftValue = sortValue(left, sort.field);
    const rightValue = sortValue(right, sort.field);
    // A missing value sorts last in both directions, as NULLS LAST does.
    if (leftValue === null && rightValue === null) return byId(left, right);
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    const order =
      typeof leftValue === 'number' && typeof rightValue === 'number'
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue), 'en-US');
    return order === 0 ? byId(left, right) : order * direction;
  });
}

/**
 * The pending view's datasource (addendum section 5). One read answers the whole view,
 * because a draft holds at most 500 devices. Paging and a new sort reuse that answer,
 * and the browser sorts the rows by the grid's active sort model.
 */
export interface DevicePendingDatasource
  extends IServerSideDatasource<DeviceRow> {
  /**
   * Replace cached records with newer observations. A live refresh updates the grid
   * nodes; this keeps the next sort or page from restoring the old row (D7).
   */
  update(rows: readonly DeviceRow[]): void;
}

export function pendingDatasource(
  load: () => Promise<DeviceRow[] | null>,
): DevicePendingDatasource {
  let read: Promise<DeviceRow[] | null> | null = null;
  /** The rows of the one read, with every later observation applied. */
  let cached: DeviceRow[] | null = null;
  /** Observations that arrived before the read answered, by device ID. */
  const observed = new Map<string, DeviceRow>();
  const merge = (rows: readonly DeviceRow[]): DeviceRow[] =>
    rows.map((row) => observed.get(row.deviceId) ?? row);
  return {
    getRows(params: IServerSideGetRowsParams<DeviceRow>) {
      read ??= load();
      read.then(
        (rows) => {
          if (!rows) return params.fail();
          cached = merge(rows);
          const sorted = sortPendingRows(
            cached,
            sortFromModel(params.request.sortModel),
          );
          const start = params.request.startRow ?? 0;
          const end = Math.min(
            params.request.endRow ?? start + 100,
            sorted.length,
          );
          params.success({
            rowData: sorted.slice(start, end),
            rowCount: sorted.length,
          });
        },
        () => params.fail(),
      );
    },
    update(rows) {
      for (const row of rows) observed.set(row.deviceId, row);
      if (cached) cached = merge(cached);
    },
  };
}
