import { vi } from 'vitest';
import type { DeviceRow } from '@campus/application-contracts';
import { DeviceRowRefresh } from './device-row-refresh';

const rowFor = (deviceId: string, stale: boolean): DeviceRow => ({
  deviceId,
  serialNumber: deviceId.toUpperCase(),
  model: null,
  assetTag: null,
  orgUnitPath: '/',
  lastContact: null,
  annotatedLocation: null,
  notes: null,
  battery: { status: 'no-report' },
  lastEntitySync: '2026-10-06T11:00:00.000Z',
  stale,
});

function grid(rows: DeviceRow[]) {
  const nodes = rows.map((data) => ({
    id: data.deviceId,
    data,
    group: false,
    updateData: vi.fn(),
  }));
  const group = {
    id: 'group',
    data: { key: '/', devices: 2 },
    group: true,
    updateData: vi.fn(),
  };
  const api = {
    forEachNode: (visit: (node: unknown) => void) =>
      [...nodes, group].forEach(visit),
    getRowNode: (id: string) =>
      [...nodes, group].find((node) => node.id === id),
  };
  return { nodes, group, api: api as never };
}

it('lists the device rows the grid holds and skips group rows', () => {
  const refresh = new DeviceRowRefresh();
  expect(refresh.held()).toEqual([]);
  const { api } = grid([rowFor('d1', true), rowFor('d2', false)]);
  refresh.attach(api);
  expect(refresh.held()).toEqual(['d1', 'd2']);
  expect(refresh.held((row) => row.stale)).toEqual(['d1']);
});

it('updates held rows in place and ignores the rest', () => {
  const refresh = new DeviceRowRefresh();
  const { nodes, group, api } = grid([rowFor('d1', true)]);
  refresh.attach(api);
  refresh.apply([rowFor('d1', false), rowFor('d9', false)]);
  expect(nodes[0].updateData).toHaveBeenCalledWith(rowFor('d1', false));
  expect(group.updateData).not.toHaveBeenCalled();
});

it('forgets a grid that detached', () => {
  const refresh = new DeviceRowRefresh();
  const first = grid([rowFor('d1', true)]);
  const second = grid([rowFor('d2', true)]);
  refresh.attach(first.api);
  refresh.attach(second.api);
  refresh.detach(first.api);
  expect(refresh.held()).toEqual(['d2']);
  refresh.detach(second.api);
  expect(refresh.held()).toEqual([]);
});
