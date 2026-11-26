import type {
  GridState,
  IServerSideDatasource,
  IServerSideGetRowsParams,
} from 'ag-grid-community';
import type {
  UserPage,
  UserPredicate,
  UserQuery,
  UserRow,
  UserSelectionKey,
} from '@campus/application-contracts';
import { USER_FIELDS, type UserAttributeColumn } from './user-fields';
import {
  EmptySetFilterError,
  mergeGridPredicates,
  predicatesFromFilterModel,
} from './user-filter-model';

export type UserSort = UserQuery['sort'];
/** The query behind the grid. */
export interface UserView {
  predicates: UserPredicate[];
  sort: UserSort;
  selection: UserSelectionKey | null;
}
export type UserLoader = (
  offset: number,
  limit: number,
  view: UserView,
) => Promise<UserPage | null>;

const defaultSort: UserSort = { field: 'fullName', direction: 'asc' };

/** The server sort field of a column, or the default for a column without one. */
export function sortFromModel(
  model: readonly { colId: string; sort: 'asc' | 'desc' }[] | undefined,
): UserSort {
  const first = model?.[0];
  const field = USER_FIELDS.find(
    (candidate) => candidate.id === first?.colId,
  ) as { id: UserSort['field'] } | undefined;
  return field && first
    ? { field: field.id, direction: first.sort }
    : defaultSort;
}

/** Partial, so columns keep the hidden and pinned settings of their definitions. */
export function defaultGridState(): GridState {
  return {
    sort: { sortModel: [{ colId: 'fullName', sort: 'asc' }] },
    partialColumnState: true,
  };
}

/** The server keeps the selection. Restoring row selection state would fight it. */
export function savedGridState(state: GridState): GridState {
  const rest = { ...state };
  delete rest.rowSelection;
  return rest;
}

/** The sort value of one static field, or null. A null sorts last in both directions. */
function sortValue(row: UserRow, field: UserSort['field']): string | null {
  switch (field) {
    case 'fullName':
      return row.fullName;
    case 'primaryEmail':
      return row.primaryEmail;
    case 'orgUnitPath':
      return row.orgUnitPath;
    case 'status':
      return row.archived ? 'archived' : row.suspended ? 'suspended' : 'active';
    case 'lastLoginTime':
      return row.lastLoginTime;
    case 'creationTime':
      return row.creationTime;
    case 'department':
      return row.department;
    case 'title':
      return row.title;
  }
}

/** The pending view's rows sorted by the grid's active sort model, then by user ID. */
export function sortPendingUserRows(
  rows: readonly UserRow[],
  sort: UserSort,
): UserRow[] {
  const direction = sort.direction === 'desc' ? -1 : 1;
  const byId = (left: UserRow, right: UserRow): number =>
    left.userId < right.userId
      ? -direction
      : left.userId > right.userId
        ? direction
        : 0;
  return [...rows].sort((left, right) => {
    const leftValue = sortValue(left, sort.field);
    const rightValue = sortValue(right, sort.field);
    if (leftValue === null && rightValue === null) return byId(left, right);
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    const order = leftValue.localeCompare(rightValue, 'en-US');
    return order === 0 ? byId(left, right) : order * direction;
  });
}

/**
 * The pending view's datasource (DRAFT-02). One read answers the whole view, because the
 * draft holds at most 500 users. Paging and a new sort reuse that answer, and the browser
 * sorts the rows by the grid's active sort model.
 */
export interface UserPendingDatasource extends IServerSideDatasource<UserRow> {
  /**
   * Replace cached records with newer observations. A live refresh updates the grid nodes;
   * this keeps the next sort or page from restoring the old row.
   */
  update(rows: readonly UserRow[]): void;
}

/** The selection of the tab, so Show All Selected narrows the pending rows (R1-A). */
export interface UserPendingSelection {
  key: UserSelectionKey;
  resolve: (ids: readonly string[]) => Promise<Record<string, boolean>>;
}

export function pendingUserDatasource(
  load: () => Promise<UserRow[] | null>,
  selection?: UserPendingSelection,
): UserPendingDatasource {
  let read: Promise<UserRow[] | null> | null = null;
  /** The rows of the one read, with every later observation applied. */
  let cached: UserRow[] | null = null;
  /** Observations that arrived before the read answered, by user ID. */
  const observed = new Map<string, UserRow>();
  /** The newer of the read row and an observation, so a late old answer never regresses. */
  const merge = (rows: readonly UserRow[]): UserRow[] =>
    rows.map((row) => {
      const seen = observed.get(row.userId);
      // An observation at the same version is newer than the read that it followed.
      return seen && seen.recordVersion >= row.recordVersion ? seen : row;
    });
  return {
    getRows(params: IServerSideGetRowsParams<UserRow>) {
      read ??= load();
      read.then(
        async (rows) => {
          if (!rows) return params.fail();
          cached = cached ? merge(cached) : merge(rows);
          let visible = cached;
          // Show All Selected asks the server for the selected rows of this tab, and the
          // pending view then keeps the ones that its users answer (R1-A).
          if (
            selection &&
            params.api.getGridOption('ssrmSelectionViewActive') === true
          ) {
            try {
              const selected = await selection.resolve(
                cached.map((row) => row.userId),
              );
              visible = cached.filter((row) => selected[row.userId] === true);
            } catch {
              // The selection answer failed, so the view cannot name its rows.
              return params.fail();
            }
          }
          const sorted = sortPendingUserRows(
            visible,
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
      for (const row of rows) {
        const seen = observed.get(row.userId);
        if (seen && seen.recordVersion > row.recordVersion) continue;
        observed.set(row.userId, row);
      }
      if (cached) cached = merge(cached);
    },
  };
}

/** Adapt LibreGrid block requests to the users query endpoint (GRID-01). */
export function userDatasource(
  load: UserLoader,
  onLoaded?: (page: UserPage) => void,
  selection?: UserSelectionKey,
  attributes: () => readonly UserAttributeColumn[] = () => [],
  /** The predicates that the grid has no column filter for, such as an alias. */
  kept: () => readonly UserPredicate[] = () => [],
  /** The model holds a filter that no query can express. The grid shows no row (R6). */
  unmatchable?: () => void,
): IServerSideDatasource<UserRow> {
  return {
    getRows(params: IServerSideGetRowsParams<UserRow>) {
      let predicates: UserPredicate[];
      try {
        predicates = mergeGridPredicates(
          predicatesFromFilterModel(params.request.filterModel, attributes()),
          kept(),
        );
      } catch (error) {
        // A set filter with no values matches nobody. Report an empty page instead
        // of a load failure, and let the page show the result and its recovery (R6).
        if (error instanceof EmptySetFilterError) {
          unmatchable?.();
          params.success({ rowData: [], rowCount: 0 });
          return;
        }
        params.fail();
        return;
      }
      const view: UserView = {
        predicates,
        sort: sortFromModel(params.request.sortModel),
        // Show All Selected limits the query to this tab's selection.
        selection:
          selection && params.api.getGridOption('ssrmSelectionViewActive')
            ? selection
            : null,
      };
      const offset = params.request.startRow ?? 0;
      const limit = Math.min(
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
