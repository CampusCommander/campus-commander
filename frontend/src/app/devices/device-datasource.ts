import type {
  FilterModel,
  GridState,
  IServerSideDatasource,
  IServerSideGetRowsParams,
} from 'ag-grid-community';
import type {
  DevicePage,
  DevicePredicate,
  DeviceQuery,
  DeviceRow,
  DeviceSelectionKey,
} from '@campus/application-contracts';
import { DEVICE_FIELDS } from './device-fields';
import { predicatesFromFilterModel } from './device-filter-model';

export type DeviceSort = DeviceQuery['sort'];
/** The query behind the grid. Next device follows the same query. */
export interface DeviceView {
  predicates: DevicePredicate[];
  sort: DeviceSort;
  selection: DeviceSelectionKey | null;
}
export type DeviceLoader = (
  offset: number,
  limit: number,
  view: DeviceView,
) => Promise<DevicePage | null>;

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

/** Adapt LibreGrid block requests to the device query endpoint (GRID-01). */
export function deviceDatasource(
  load: DeviceLoader,
  onLoaded?: (page: DevicePage) => void,
  selection?: DeviceSelectionKey,
): IServerSideDatasource<DeviceRow> {
  return {
    getRows(params: IServerSideGetRowsParams<DeviceRow>) {
      const offset = params.request.startRow ?? 0;
      const limit = Math.min(
        200,
        Math.max(1, (params.request.endRow ?? offset + 100) - offset),
      );
      let predicates: DevicePredicate[];
      try {
        predicates = predicatesFromFilterModel(
          params.request.filterModel as FilterModel | null,
        );
      } catch {
        params.fail();
        return;
      }
      const view: DeviceView = {
        predicates,
        sort: sortFromModel(params.request.sortModel),
        // Show All Selected limits the query to this tab's selection.
        selection:
          selection && params.api.getGridOption('ssrmSelectionViewActive')
            ? selection
            : null,
      };
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
