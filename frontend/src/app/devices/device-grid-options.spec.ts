import type { IStatusPanelComp, IStatusPanelParams } from 'ag-grid-community';
import type { SsrmSelectionService } from '@libregrid/server-side-selection';
import { vi } from 'vitest';
import { deviceGridFeatures, showRow } from './device-grid-options';

const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';

it('pages, shows column tools and the status bar, and selects on the server', () => {
  const footer = document.createElement('div');
  const status = document.createElement('div');
  const provider = {
    getSpec: vi.fn(),
    applyOps: vi.fn(),
    resolveSelected: vi.fn(),
  };
  const onSelectionReady = vi.fn();
  const options = deviceGridFeatures({
    provider,
    tabId,
    footer,
    status,
    onSelectionReady,
  });
  expect(options.pagination).toBe(true);
  expect(options.paginationPageSize).toBe(100);
  expect(options.paginationPageSizeSelector).toEqual([50, 100, 250]);
  const sideBar = options.sideBar as {
    toolPanels: ({ id: string; toolPanelParams: object } | string)[];
  };
  // Pivot, aggregation, and row grouping are outside this slice.
  expect(sideBar.toolPanels).toMatchObject([
    {
      id: 'columns',
      toolPanelParams: {
        suppressPivotMode: true,
        suppressRowGroups: true,
        suppressValues: true,
        suppressPivots: true,
      },
    },
    'filters',
  ]);
  expect(options.selectionColumnDef).toMatchObject({
    pinned: 'left',
    suppressColumnsToolPanel: true,
  });
  // LibreGrid creates status panels with new, no Angular injector, and agInit.
  const panels = (options.statusBar?.statusPanels ?? []).map((definition) => {
    const Panel = definition.statusPanel as new () => IStatusPanelComp & {
      agInit?: (params: IStatusPanelParams) => void;
    };
    const panel = new Panel();
    panel.agInit?.({
      ...definition.statusPanelParams,
    } as unknown as IStatusPanelParams);
    return [definition.align, panel.getGui()];
  });
  expect(panels).toEqual([
    ['left', status],
    ['right', footer],
  ]);
  expect(options.rowSelection).toMatchObject({
    mode: 'multiRow',
    selectAll: 'currentPage',
  });
  expect(options.ssrmSelection).toMatchObject({
    provider,
    gridId: 'devices',
    tabId,
  });
  const attachFooter = vi.fn();
  options.ssrmSelection?.onReady?.({
    attachFooter,
  } as unknown as SsrmSelectionService);
  expect(attachFooter).toHaveBeenCalledWith(footer);
  // The footer changes the status bar height, so the grid re-reveals its row.
  expect(onSelectionReady).toHaveBeenCalled();
});

it('opens the page that holds a remembered row', () => {
  const calls: unknown[] = [];
  showRow(
    {
      paginationGetPageSize: () => 100,
      paginationGetCurrentPage: () => 0,
      paginationGoToPage: (page: number) => void calls.push(['page', page]),
      ensureIndexVisible: (
        index: number,
        position?: 'top' | 'bottom' | 'middle' | null,
      ) => void calls.push(['row', index, position]),
    },
    150,
  );
  expect(calls).toEqual([
    ['page', 1],
    ['row', 150, 'middle'],
  ]);
});
