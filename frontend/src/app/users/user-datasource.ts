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
