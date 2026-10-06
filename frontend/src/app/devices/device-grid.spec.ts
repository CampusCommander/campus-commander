import type {
  CellKeyDownEvent,
  IServerSideGetRowsParams,
} from 'ag-grid-community';
import { vi } from 'vitest';
import type { DeviceRow } from '@campus/application-contracts';
import {
  detailsKeyHandler,
  deviceColumnDefs,
  DeviceGroupCell,
  deviceGroupColumn,
} from './device-columns';
import { detailsTarget } from './device-grid-options';
import {
  GROUP_LIMIT,
  defaultGridState,
  deviceDatasource,
  savedGridState,
  sortFromModel,
} from './device-datasource';

const row: DeviceRow = {
  deviceId: 'synthetic-device-1',
  serialNumber: 'C0A1-0001',
  model: 'Lenovo 100e Gen 4',
  assetTag: 'HS-0401',
  orgUnitPath: '/School A',
  lastContact: '2026-10-05T11:58:00Z',
  annotatedLocation: null,
  notes: null,
  battery: {
    status: 'reported',
    health: 'replace-soon',
    capacityPercent: 78,
    reportedAt: '2026-10-05T11:00:00Z',
  },
};
type Getter = (params: { data: DeviceRow }) => unknown;

it('orders columns after the details icon and hides optional fields', () => {
  const columns = deviceColumnDefs(() => undefined, {
    now: () => Date.parse('2026-10-05T12:00:00Z'),
  });
  expect(columns.map((column) => column.colId)).toEqual([
    'details',
    'serialNumber',
    'model',
    'assetTag',
    'orgUnitPath',
    'battery',
    'lastContact',
    'annotatedLocation',
    'notes',
  ]);
  expect(columns[0].pinned).toBe('left');
  // GRID-03: the details icon stays right after the checkbox, before a group column.
  expect(columns[0].lockPosition).toBe('left');
  expect(
    columns.filter((column) => column.hide).map((column) => column.colId),
  ).toEqual(['annotatedLocation', 'notes']);
  const value = (id: string) =>
    (columns.find((column) => column.colId === id)!.valueGetter as Getter)({
      data: row,
    });
  expect(value('battery')).toBe('Replace soon');
  expect(value('lastContact')).toBe('2 min ago');
  expect(value('notes')).toBe('');
});

it('loads grid blocks with the column filters and the header sort', async () => {
  const load = vi.fn().mockResolvedValue({
    rows: [row],
    matching: 96,
    total: 450,
    observedAt: null,
  });
  const success = vi.fn();
  const fail = vi.fn();
  deviceDatasource(load).getRows({
    request: {
      startRow: 100,
      endRow: 200,
      sortModel: [{ colId: 'assetTag', sort: 'desc' }],
      filterModel: {
        assetTag: { filterType: 'text', type: 'startsWith', filter: 'HS-04' },
      },
    },
    success,
    fail,
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  await vi.waitFor(() => expect(success).toHaveBeenCalled());
  expect(load).toHaveBeenCalledWith(100, 100, {
    predicates: [{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }],
    sort: { field: 'assetTag', direction: 'desc' },
    selection: null,
  });
  expect(success).toHaveBeenCalledWith({ rowData: [row], rowCount: 96 });
  expect(fail).not.toHaveBeenCalled();
});

it('fails the block for a filter the device query cannot express', () => {
  const load = vi.fn();
  const fail = vi.fn();
  deviceDatasource(load).getRows({
    request: {
      startRow: 0,
      endRow: 100,
      sortModel: [],
      filterModel: {
        model: { filterType: 'text', type: 'notContains', filter: 'x' },
      },
    },
    success: vi.fn(),
    fail,
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  expect(fail).toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
});

it('fails the block when the query fails', async () => {
  const fail = vi.fn();
  deviceDatasource(vi.fn().mockResolvedValue(null)).getRows({
    request: { startRow: 0, endRow: 100, sortModel: [] },
    success: vi.fn(),
    fail,
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  await vi.waitFor(() => expect(fail).toHaveBeenCalled());
});

it('falls back to serial order for columns without a query field', () => {
  expect(sortFromModel([{ colId: 'details', sort: 'asc' }])).toEqual({
    field: 'serialNumber',
    direction: 'asc',
  });
  expect(sortFromModel(undefined)).toEqual({
    field: 'serialNumber',
    direction: 'asc',
  });
});

it('starts in serial order and saves grid state without row selection', () => {
  // Partial state keeps the column definitions' hidden and pinned columns.
  expect(defaultGridState()).toEqual({
    sort: { sortModel: [{ colId: 'serialNumber', sort: 'asc' }] },
    partialColumnState: true,
  });
  const sort = { sortModel: [{ colId: 'assetTag', sort: 'desc' as const }] };
  const filter = {
    filterModel: { notes: { filterType: 'text', type: 'blank' } },
  };
  expect(
    savedGridState({
      sort,
      filter,
      rowSelection: ['d1'],
      pagination: { page: 2, pageSize: 100 },
    }),
  ).toEqual({ sort, filter, pagination: { page: 2, pageSize: 100 } });
});

it('reports each loaded page after the grid receives its rows', async () => {
  const order: string[] = [];
  deviceDatasource(
    vi.fn().mockResolvedValue({
      rows: [row],
      matching: 96,
      total: 450,
      observedAt: null,
    }),
    (page) => order.push(`loaded ${page.matching}`),
  ).getRows({
    request: { startRow: 0, endRow: 100, sortModel: [] },
    success: () => order.push('success'),
    fail: vi.fn(),
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  await vi.waitFor(() => expect(order).toEqual(['success', 'loaded 96']));
});

it('opens details with Enter and leaves Space to row selection', () => {
  const onDetails = vi.fn();
  const handler = detailsKeyHandler(onDetails);
  const node = { rowIndex: 3, group: false };
  const press = (colId: string, key: string, target = node) =>
    handler({
      column: { getColId: () => colId },
      data: row,
      node: target,
      event: new KeyboardEvent('keydown', { key }),
    } as unknown as CellKeyDownEvent<DeviceRow>);
  press('details', 'Enter');
  press('details', ' ');
  press('serialNumber', 'Enter');
  press('details', 'Enter', { rowIndex: 0, group: true });
  expect(onDetails.mock.calls).toEqual([[row, node]]);
});

it('gives each data column the filter of its field type', () => {
  const columns = deviceColumnDefs(() => undefined, {
    orgUnits: () => ['/', '/School A'],
  });
  const column = (id: string) =>
    columns.find((candidate) => candidate.colId === id)!;
  expect(column('details').filter).toBe(false);
  expect(column('assetTag').filter).toBe('agTextColumnFilter');
  expect(column('assetTag').filterParams.filterOptions).toEqual([
    'contains',
    'startsWith',
    'equals',
    'blank',
  ]);
  expect(
    column('lastContact').filterParams.filterOptions.map(
      (option: { displayKey: string }) => option.displayKey,
    ),
  ).toEqual(['before', 'after']);
  expect(column('battery').filter).toBe('agSetColumnFilter');
  expect(column('battery').filterParams.values).toEqual([
    'normal',
    'replace-soon',
    'replace-now',
    'no-report',
    'unavailable',
  ]);
  expect(column('battery').filterParams.suppressSorting).toBe(true);
  expect(
    column('battery').filterParams.valueFormatter({ value: 'no-report' }),
  ).toBe('No battery report');
  const units: string[][] = [];
  column('orgUnitPath').filterParams.values({
    success: (values: string[]) => units.push(values),
  });
  expect(units).toEqual([['/', '/School A']]);
  expect(
    column('orgUnitPath').filterParams.treeListPathGetter('/School A'),
  ).toEqual(['/', 'School A']);
});

it('limits the query to the selection while Show All Selected is on', async () => {
  const load = vi.fn().mockResolvedValue({
    rows: [],
    matching: 0,
    total: 450,
    observedAt: null,
  });
  const key = {
    gridId: 'devices' as const,
    tabId: '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  };
  deviceDatasource(load, undefined, key).getRows({
    request: { startRow: 0, endRow: 100, sortModel: [], filterModel: {} },
    api: {
      getGridOption: (name: string) => name === 'ssrmSelectionViewActive',
    },
    success: vi.fn(),
    fail: vi.fn(),
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  await vi.waitFor(() => expect(load).toHaveBeenCalled());
  expect(load.mock.calls[0][2].selection).toEqual(key);
});

const groupPage = {
  groups: [
    { key: 'normal', devices: 300 },
    { key: 'replace-soon', devices: 135 },
  ],
  groupCount: 2,
  matching: 435,
  total: 450,
  observedAt: null,
};

it('loads one grouped level with its device counts', async () => {
  const load = vi.fn();
  const loadGroups = vi.fn().mockResolvedValue(groupPage);
  const success = vi.fn();
  deviceDatasource(load, undefined, undefined, loadGroups).getRows({
    request: {
      sortModel: [],
      filterModel: {},
      rowGroupCols: [{ id: 'battery', displayName: 'Battery' }],
      groupKeys: [],
    },
    api: { getGridOption: () => false },
    success,
    fail: vi.fn(),
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  await vi.waitFor(() => expect(success).toHaveBeenCalled());
  expect(loadGroups).toHaveBeenCalledWith({
    predicates: [],
    sort: { field: 'serialNumber', direction: 'asc' },
    selection: null,
    group: { by: ['battery'], keys: [] },
  });
  expect(success).toHaveBeenCalledWith({
    rowData: groupPage.groups,
    rowCount: 2,
  });
  expect(load).not.toHaveBeenCalled();
});

it('loads an open group in one request up to the group limit', async () => {
  const load = vi.fn().mockResolvedValue({
    rows: [row],
    matching: 135,
    total: 450,
    observedAt: null,
  });
  deviceDatasource(load, undefined, undefined, vi.fn()).getRows({
    request: {
      sortModel: [],
      filterModel: {},
      rowGroupCols: [{ id: 'battery', displayName: 'Battery' }],
      groupKeys: ['replace-soon'],
    },
    api: { getGridOption: () => false },
    success: vi.fn(),
    fail: vi.fn(),
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  await vi.waitFor(() => expect(load).toHaveBeenCalled());
  expect(load.mock.calls[0].slice(0, 2)).toEqual([0, GROUP_LIMIT]);
  expect(load.mock.calls[0][2].group).toEqual({
    by: ['battery'],
    keys: ['replace-soon'],
  });
});

it('fails a grouped level that the device query cannot group', () => {
  const fail = vi.fn();
  deviceDatasource(vi.fn(), undefined, undefined, vi.fn()).getRows({
    request: {
      sortModel: [],
      filterModel: {},
      rowGroupCols: [{ id: 'serialNumber', displayName: 'Serial' }],
      groupKeys: [],
    },
    api: { getGridOption: () => false },
    success: vi.fn(),
    fail,
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  expect(fail).toHaveBeenCalled();
});

it('groups by organization unit, model, and battery with counts', () => {
  const columns = deviceColumnDefs(() => undefined);
  expect(
    columns
      .filter((column) => column.enableRowGroup)
      .map((column) => column.colId),
  ).toEqual(['model', 'orgUnitPath', 'battery']);
  const battery = columns.find((column) => column.colId === 'battery')!;
  const groupNode = { group: true, field: 'battery' };
  const groupRow = { key: 'replace-soon', devices: 1350 };
  expect(
    (battery.valueGetter as Getter)({
      data: groupRow,
      node: groupNode,
    } as never),
  ).toBe('');
  // AG Grid formats group values with the grouped column, so the cell builds its own label.
  expect(deviceGroupColumn.cellRenderer).toBe(DeviceGroupCell);
  const cell = new DeviceGroupCell();
  cell.init({
    node: {
      ...groupNode,
      key: 'replace-soon',
      expanded: false,
      childrenAfterGroup: [],
      addEventListener: () => undefined,
    },
    data: groupRow,
    value: 'replace-soon',
    api: { getGridOption: () => 'serverSide' },
  } as never);
  expect(cell.getGui().textContent).toBe('Replace soon (1,350)');
});

it('finds a grouped device by its index inside the group', () => {
  const parent = { group: true, __lgrSsrmRoute: ['replace-soon'] };
  expect(
    detailsTarget({ rowIndex: 40, sourceRowIndex: 7, parent } as never),
  ).toEqual({ index: 7, route: ['replace-soon'] });
  expect(
    detailsTarget({ rowIndex: 40, sourceRowIndex: 40, parent: null } as never),
  ).toEqual({ index: 40, route: null });
  expect(detailsTarget({ rowIndex: null, parent: null } as never)).toBeNull();
});
