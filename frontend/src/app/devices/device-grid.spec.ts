import type {
  CellKeyDownEvent,
  IServerSideGetRowsParams,
} from 'ag-grid-community';
import { vi } from 'vitest';
import type { DeviceRow } from '@campus/application-contracts';
import { detailsKeyHandler, deviceColumnDefs } from './device-columns';
import {
  deviceDatasource,
  initialSortState,
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
  const columns = deviceColumnDefs(
    () => undefined,
    () => Date.parse('2026-10-05T12:00:00Z'),
  );
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

it('loads grid blocks from the device query with the header sort', async () => {
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
    },
    success,
    fail,
  } as unknown as IServerSideGetRowsParams<DeviceRow>);
  await vi.waitFor(() => expect(success).toHaveBeenCalled());
  expect(load).toHaveBeenCalledWith(100, 100, {
    field: 'assetTag',
    direction: 'desc',
  });
  expect(success).toHaveBeenCalledWith({ rowData: [row], rowCount: 96 });
  expect(fail).not.toHaveBeenCalled();
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

it('starts the grid with the stored sort', () => {
  expect(initialSortState({ field: 'assetTag', direction: 'desc' })).toEqual({
    sort: { sortModel: [{ colId: 'assetTag', sort: 'desc' }] },
  });
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

it('opens details with Enter or Space on the details cell', () => {
  const onDetails = vi.fn();
  const handler = detailsKeyHandler(onDetails);
  const press = (colId: string, key: string) =>
    handler({
      column: { getColId: () => colId },
      data: row,
      rowIndex: 3,
      event: new KeyboardEvent('keydown', { key }),
    } as unknown as CellKeyDownEvent<DeviceRow>);
  press('details', 'Enter');
  press('details', ' ');
  press('serialNumber', 'Enter');
  press('details', 'a');
  expect(onDetails.mock.calls).toEqual([
    [row, 3],
    [row, 3],
  ]);
});
