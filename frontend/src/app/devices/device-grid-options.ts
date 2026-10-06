import type {
  GridApi,
  IRowNode,
  GridOptions,
  IStatusPanelComp,
  IStatusPanelParams,
} from 'ag-grid-community';
import type {
  ServerSideSelectionProvider,
  SsrmSelectionService,
} from '@libregrid/server-side-selection';
import { ColumnsToolPanel } from '@libregrid/columns-tool-panel';
import { getSsrmRoute } from '@libregrid/server-side-row-model';
import type { DeviceRow } from '@campus/application-contracts';
import { deviceGroupColumn } from './device-columns';
import { DEVICE_GRID_ID } from './device-selection';

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

export interface DeviceGridFeatures {
  provider: ServerSideSelectionProvider;
  tabId: string;
  /** Holds the LibreGrid selection footer (SELECT-01). */
  footer: HTMLElement;
  /** Holds the counts and freshness (GRID-01). */
  status: HTMLElement;
  /** Runs after the selection footer joins the status bar. */
  onSelectionReady?: (service: SsrmSelectionService) => void;
}

/** Paging, column tools, the status bar, and server-side selection. */
export function deviceGridFeatures(
  features: DeviceGridFeatures,
): GridOptions<DeviceRow> {
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
          width: 260,
          minWidth: 220,
          maxWidth: 380,
          toolPanel: ColumnsToolPanel,
          // Pivot and aggregation are outside this slice.
          toolPanelParams: {
            suppressPivotMode: true,
            suppressValues: true,
            suppressPivots: true,
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
    autoGroupColumnDef: deviceGroupColumn,
    // LibreGrid offers grouping items only to menus that ask for them.
    getColumnMenuItems: (params) => [
      ...params.defaultItems,
      'separator',
      'rowGroup',
      'rowUnGroup',
    ],
    ssrmSelection: {
      provider: features.provider,
      gridId: DEVICE_GRID_ID,
      tabId: features.tabId,
      onReady: (service: SsrmSelectionService) => {
        service.attachFooter(features.footer);
        features.onSelectionReady?.(service);
      },
    },
  };
}

/** Open the page that holds a row, then scroll to it. Next device can leave the page that Back returns to. */
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

/** Where a device sits for Next device: its group and its index there, or its index in the flat grid. */
export function detailsTarget(
  node: Pick<IRowNode, 'rowIndex' | 'sourceRowIndex' | 'parent'>,
): { index: number; route: string[] | null } | null {
  const route = node.parent?.group ? (getSsrmRoute(node.parent) ?? null) : null;
  const index = route ? node.sourceRowIndex : node.rowIndex;
  return index === null || index < 0 ? null : { index, route };
}
