import type { IServerSideGetRowsParams } from 'ag-grid-community';
import { vi } from 'vitest';
import type { DeviceRow } from '@campus/application-contracts';
import {
  pendingDatasource,
  sortPendingRows,
  type DeviceSort,
} from './device-datasource';

/**
 * The pending view of the in-grid editing record (addendum section 5): one read answers
 * the view, and the browser sorts its rows by the grid's active sort model.
 */

function row(overrides: Partial<DeviceRow> & { deviceId: string }): DeviceRow {
  return {
    serialNumber: overrides.deviceId.toUpperCase(),
    model: 'Dell Chromebook 3100',
    assetTag: null,
    orgUnitPath: '/Chrome Devices',
    lastContact: '2026-10-19T11:58:00Z',
    annotatedLocation: null,
    annotatedUser: null,
    notes: null,
    status: 'ACTIVE',
    battery: { status: 'no-report' },
    lastEntitySync: '2026-10-19T12:00:00.000Z',
    stale: false,
    ...overrides,
  };
}

interface Block {
  params: IServerSideGetRowsParams<DeviceRow>;
  success: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
}

function block(
  startRow: number | null,
  endRow: number | null,
  sort: Array<{ colId: string; sort: 'asc' | 'desc' }> = [
    { colId: 'serialNumber', sort: 'asc' },
  ],
): Block {
  const success = vi.fn();
  const fail = vi.fn();
  return {
    success,
    fail,
    params: {
      request: { startRow, endRow, sortModel: sort, filterModel: null },
      success,
      fail,
    } as unknown as IServerSideGetRowsParams<DeviceRow>,
  };
}

function rowDataOf(success: ReturnType<typeof vi.fn>): DeviceRow[] {
  return (success.mock.calls[0]![0] as { rowData: DeviceRow[] }).rowData;
}

it('reads the pending rows once and answers every block from that read', async () => {
  const rows = [row({ deviceId: 'd3' }), row({ deviceId: 'd1' })];
  const load = vi.fn().mockResolvedValue(rows);
  const datasource = pendingDatasource(load);

  const first = block(0, 1);
  datasource.getRows(first.params);
  await vi.waitFor(() => expect(first.success).toHaveBeenCalled());
  const second = block(1, 2);
  datasource.getRows(second.params);
  await vi.waitFor(() => expect(second.success).toHaveBeenCalled());

  expect(load).toHaveBeenCalledTimes(1);
  expect(rowDataOf(first.success).map((item) => item.deviceId)).toEqual(['d1']);
  expect(rowDataOf(second.success).map((item) => item.deviceId)).toEqual([
    'd3',
  ]);
  expect(first.success.mock.calls[0]![0]).toMatchObject({ rowCount: 2 });
});

it('sorts the pending rows by the active sort model', async () => {
  const rows = [
    row({ deviceId: 'd1', serialNumber: 'C0A1-0002' }),
    row({ deviceId: 'd2', serialNumber: 'C0A1-0003' }),
    row({ deviceId: 'd3', serialNumber: 'C0A1-0001' }),
  ];
  const load = vi.fn().mockResolvedValue(rows);
  const datasource = pendingDatasource(load);

  const ascending = block(0, 3);
  datasource.getRows(ascending.params);
  await vi.waitFor(() => expect(ascending.success).toHaveBeenCalled());
  expect(rowDataOf(ascending.success).map((item) => item.serialNumber)).toEqual(
    ['C0A1-0001', 'C0A1-0002', 'C0A1-0003'],
  );

  // A new sort reuses the read and orders the cached rows again.
  const descending = block(0, 3, [{ colId: 'serialNumber', sort: 'desc' }]);
  datasource.getRows(descending.params);
  await vi.waitFor(() => expect(descending.success).toHaveBeenCalled());
  expect(
    rowDataOf(descending.success).map((item) => item.serialNumber),
  ).toEqual(['C0A1-0003', 'C0A1-0002', 'C0A1-0001']);
  expect(load).toHaveBeenCalledTimes(1);
});

it('fails the block when the read fails', async () => {
  const failed = block(0, 100);
  pendingDatasource(() => Promise.resolve(null)).getRows(failed.params);
  await vi.waitFor(() => expect(failed.fail).toHaveBeenCalled());
});

it('keeps a refreshed row when the pending view sorts again', async () => {
  const rows = [row({ deviceId: 'd1', model: 'Dell Chromebook 3100' })];
  const load = vi.fn().mockResolvedValue(rows);
  const datasource = pendingDatasource(load);

  const first = block(0, 1);
  datasource.getRows(first.params);
  await vi.waitFor(() => expect(first.success).toHaveBeenCalled());

  // A live entity-batch refresh changes the row without a new pending read.
  datasource.update([row({ deviceId: 'd1', model: 'CURRENT-MODEL' })]);
  const sorted = block(0, 1, [{ colId: 'model', sort: 'asc' }]);
  datasource.getRows(sorted.params);
  await vi.waitFor(() => expect(sorted.success).toHaveBeenCalled());

  // The cache holds the refreshed observation, and sorting adds no read.
  expect(rowDataOf(sorted.success)[0].model).toBe('CURRENT-MODEL');
  expect(load).toHaveBeenCalledTimes(1);
});

it('applies a refresh that answers before the pending read', async () => {
  let finish: (rows: DeviceRow[]) => void = () => undefined;
  const load = vi.fn(
    () =>
      new Promise<DeviceRow[]>((resolve) => {
        finish = resolve;
      }),
  );
  const datasource = pendingDatasource(load);
  const first = block(0, 1);
  datasource.getRows(first.params);
  datasource.update([row({ deviceId: 'd1', model: 'CURRENT-MODEL' })]);
  finish([row({ deviceId: 'd1', model: 'Dell Chromebook 3100' })]);
  await vi.waitFor(() => expect(first.success).toHaveBeenCalled());
  expect(rowDataOf(first.success)[0].model).toBe('CURRENT-MODEL');
});

it('sorts a missing value last in both directions and breaks ties by device ID', () => {
  const rows = [
    row({ deviceId: 'd2', serialNumber: 'C0A1-0002', assetTag: null }),
    row({ deviceId: 'd1', serialNumber: 'C0A1-0001', assetTag: null }),
    row({ deviceId: 'd4', serialNumber: 'C0A1-0004', assetTag: 'HS-02' }),
    row({ deviceId: 'd3', serialNumber: 'C0A1-0003', assetTag: 'HS-01' }),
  ];
  const ids = (sort: DeviceSort) =>
    sortPendingRows(rows, sort).map((item) => item.deviceId);
  expect(ids({ field: 'assetTag', direction: 'asc' })).toEqual([
    'd3',
    'd4',
    'd1',
    'd2',
  ]);
  expect(ids({ field: 'assetTag', direction: 'desc' })).toEqual([
    'd4',
    'd3',
    'd2',
    'd1',
  ]);
});

it('sorts batteries by the class order of the device query', () => {
  const rows = [
    row({ deviceId: 'd1', battery: { status: 'unavailable' } }),
    row({ deviceId: 'd2', battery: { status: 'no-report' } }),
    row({
      deviceId: 'd3',
      battery: {
        status: 'reported',
        health: 'normal',
        capacityPercent: 80,
        reportedAt: '2026-10-19T11:00:00Z',
      },
    }),
    row({
      deviceId: 'd4',
      battery: {
        status: 'reported',
        health: 'replace-now',
        capacityPercent: 20,
        reportedAt: '2026-10-19T11:00:00Z',
      },
    }),
  ];
  expect(
    sortPendingRows(rows, { field: 'battery', direction: 'asc' }).map(
      (item) => item.deviceId,
    ),
  ).toEqual(['d4', 'd3', 'd2', 'd1']);
});
