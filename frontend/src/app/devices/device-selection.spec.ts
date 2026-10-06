import { vi } from 'vitest';
import type { DeviceSelectionSpec } from '@campus/application-contracts';
import {
  DeviceSelectionProvider,
  deviceSelectionTab,
  selectionScope,
} from './device-selection';

const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const spec: DeviceSelectionSpec = {
  terms: [
    {
      type: 'all',
      predicates: [
        { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
      ],
    },
  ],
  added: 0,
  excluded: 1,
  selectedCount: 95,
};

it('sends Select All with the grid filters as device predicates', async () => {
  const call = vi.fn().mockResolvedValue(Response.json({ selection: spec }));
  const provider = new DeviceSelectionProvider(call);
  await provider.applyOps({
    gridId: 'devices',
    tabId,
    ops: [
      {
        op: 'selectAll',
        filter: {
          assetTag: { filterType: 'text', type: 'startsWith', filter: 'HS-04' },
        },
      },
      { op: 'deselect', ids: ['d1'] },
    ],
  });
  expect(call).toHaveBeenCalledWith('/api/devices/selection/ops', {
    gridId: 'devices',
    tabId,
    ops: [
      { op: 'selectAll', predicates: spec.terms[0].predicates },
      { op: 'deselect', ids: ['d1'] },
    ],
  });
  expect(provider.spec()?.selectedCount).toBe(95);
});

it('reports the selection in the grid filter form', async () => {
  const provider = new DeviceSelectionProvider(
    vi.fn().mockResolvedValue(Response.json({ selection: spec })),
  );
  expect(await provider.getSpec({ gridId: 'devices', tabId })).toEqual({
    terms: [
      {
        type: 'all',
        filter: {
          assetTag: { filterType: 'text', type: 'startsWith', filter: 'HS-04' },
        },
      },
    ],
    selectedCount: 95,
  });
});

it('resolves loaded rows and fails when the API is unreachable', async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ selected: { d1: true, d2: false } }))
    .mockResolvedValueOnce(null);
  const provider = new DeviceSelectionProvider(call);
  expect(
    await provider.resolveSelected({
      gridId: 'devices',
      tabId,
      rowIds: ['d1', 'd2'],
      groupRoutes: [],
    }),
  ).toEqual({ d1: true, d2: false });
  await expect(provider.getSpec({ gridId: 'devices', tabId })).rejects.toThrow(
    'The device selection is unavailable.',
  );
});

it('splits large row batches to the API limit', async () => {
  const call = vi.fn().mockResolvedValue(Response.json({ selection: spec }));
  const provider = new DeviceSelectionProvider(call);
  const ids = Array.from({ length: 2500 }, (_, index) => `d${index}`);
  await provider.applyOps({
    gridId: 'devices',
    tabId,
    ops: [{ op: 'select', ids }],
  });
  expect(
    call.mock.calls[0][1].ops.map((op: { ids: string[] }) => op.ids.length),
  ).toEqual([2000, 500]);
});

it('keeps one selection tab per browser tab', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => void values.set(name, value),
  };
  const first = deviceSelectionTab(storage);
  expect(deviceSelectionTab(storage)).toBe(first);
  const blocked = {
    getItem: (): string | null => {
      throw new Error('blocked');
    },
    setItem: () => undefined,
  };
  expect(deviceSelectionTab(blocked)).toMatch(/^[0-9a-f-]{36}$/);
});

it('describes what Select All captured', () => {
  expect(selectionScope(null)).toBe('');
  expect(selectionScope(spec)).toBe(
    'Selected by filter: Asset tag starts with: HS-04 · 1 excluded',
  );
  expect(
    selectionScope({
      terms: [{ type: 'all', predicates: [] }],
      added: 2,
      excluded: 0,
      selectedCount: 450,
    }),
  ).toBe('Selected by filter: All devices · 2 added');
});
