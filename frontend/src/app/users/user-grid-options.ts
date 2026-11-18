import type {
  CellKeyDownEvent,
  FullWidthCellKeyDownEvent,
  GridApi,
  GridOptions,
  IStatusPanelComp,
  IStatusPanelParams,
  IRowNode,
} from 'ag-grid-community';
import type {
  ServerSideSelectionProvider,
  SsrmSelectionService,
} from '@libregrid/server-side-selection';
import { ColumnsToolPanel } from '@libregrid/columns-tool-panel';
import type { UserRow } from '@campus/application-contracts';
import { USER_GRID_ID } from './user-selection';

/**
 * Shows an element that the grid owns in the status bar.
 * LibreGrid creates status panels with new and no Angular injector, so Angular content renders into the host.
 */
export class HostedStatusPanel implements IStatusPanelComp {
  private gui!: HTMLElement;

  init(params: IStatusPanelParams & { host: HTMLElement }): void {
    this.gui = params.host;
  }

  /** LibreGrid's status bar calls agInit instead of init. */
  agInit(params: IStatusPanelParams & { host: HTMLElement }): void {
    this.init(params);
  }

  getGui(): HTMLElement {
    return this.gui;
  }

  refresh(): boolean {
    return true;
  }
}

export interface UserGridFeatures {
  provider: ServerSideSelectionProvider;
  tabId: string;
  /** Holds the LibreGrid selection footer (SELECT-01). */
  footer: HTMLElement;
  /** Holds the counts and freshness (GRID-01). */
  status: HTMLElement;
  /** The column panel groups that open on first view. */
  expandedGroups?: () => string[];
  /** Runs after the selection footer joins the status bar. */
  onSelectionReady?: (service: SsrmSelectionService) => void;
}

/** Paging, column tools, the status bar, and server-side selection. */
export function userGridFeatures(
  features: UserGridFeatures,
): GridOptions<UserRow> {
  return {
    pagination: true,
    paginationPageSize: 100,
    paginationPageSizeSelector: [50, 100, 250],
    sideBar: {
      toolPanels: [
        {
          id: 'columns',
          labelKey: 'columns',
          labelDefault: 'Columns',
          iconKey: 'columns',
          // The approved panel is 258 px wide, beside the 32 px side bar (state 02).
          width: 258,
          minWidth: 220,
          maxWidth: 380,
          toolPanel: ColumnsToolPanel,
          toolPanelParams: {
            suppressPivotMode: true,
            suppressValues: true,
            suppressPivots: true,
            suppressRowGroups: true,
            // The approved panel holds the search and the list only (screen 02).
            suppressColumnExpandAll: true,
            suppressColumnSelectAll: true,
            // Read when the panel first opens, so the loaded categories expand their groups.
            get initialState() {
              return { expandedGroupIds: features.expandedGroups?.() ?? [] };
            },
          },
        },
        'filters',
      ],
    },
    statusBar: {
      statusPanels: [
        {
          statusPanel: HostedStatusPanel,
          align: 'left',
          statusPanelParams: { host: features.status },
        },
        {
          statusPanel: HostedStatusPanel,
          align: 'right',
          statusPanelParams: { host: features.footer },
        },
      ],
    },
    rowSelection: {
      mode: 'multiRow',
      selectAll: 'currentPage',
      checkboxes: true,
      headerCheckbox: true,
      enableClickSelection: false,
    },
    selectionColumnDef: {
      pinned: 'left',
      // AG Grid passes this through, but its selection column type omits it.
      ...({ suppressColumnsToolPanel: true } as object),
    },
    ssrmSelection: {
      provider: features.provider,
      gridId: USER_GRID_ID,
      tabId: features.tabId,
      onReady: (service: SsrmSelectionService) => {
        service.attachFooter(features.footer);
        features.onSelectionReady?.(service);
      },
    },
  };
}

/**
 * Open the page that holds a row, then scroll to it. Next user can leave the page that
 * Back to users returns to (A section 4).
 */
export function showRow(
  api: Pick<
    GridApi,
    | 'paginationGetPageSize'
    | 'paginationGetCurrentPage'
    | 'paginationGoToPage'
    | 'ensureIndexVisible'
  >,
  index: number,
): void {
  const page = Math.floor(index / api.paginationGetPageSize());
  if (page !== api.paginationGetCurrentPage()) api.paginationGoToPage(page);
  api.ensureIndexVisible(index, 'middle');
}

/**
 * Enter on a focused details cell opens the user (UI-09). The details control is a
 * button, so its own Enter and Space activation stays with the button.
 */
export function detailsKeyHandler(
  onDetails: (row: UserRow, node: IRowNode<UserRow>) => void,
) {
  return (
    event: CellKeyDownEvent<UserRow> | FullWidthCellKeyDownEvent<UserRow>,
  ): void => {
    const keyboard = event.event as KeyboardEvent | null | undefined;
    if (!('column' in event) || event.column.getColId() !== 'details') return;
    if (keyboard?.key !== 'Enter') return;
    const target = keyboard.target;
    if (target instanceof HTMLElement && target.closest('button, a') !== null)
      return;
    if (!event.data || event.node.group) return;
    keyboard.preventDefault();
    onDetails(event.data, event.node);
  };
}
