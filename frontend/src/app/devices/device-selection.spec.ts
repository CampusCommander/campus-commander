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
  groups: [],
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
      groups: [],
      added: 2,
      excluded: 0,
      selectedCount: 450,
    }),
  ).toBe('Selected by filter: All devices · 2 added');
});

const context = () => ({
  predicates: spec.terms[0].predicates,
  by: ['battery' as const],
});

it('sends group selections with the grid filters and grouped fields', async () => {
  const call = vi.fn().mockResolvedValue(Response.json({ selection: spec }));
  const provider = new DeviceSelectionProvider(call, context);
  await provider.applyOps({
    gridId: 'devices',
    tabId,
    ops: [{ op: 'selectGroup', route: ['replace-soon'] }],
  });
  expect(call.mock.calls[0][1].ops).toEqual([
    {
      op: 'selectGroup',
      predicates: spec.terms[0].predicates,
      by: ['battery'],
      route: ['replace-soon'],
    },
  ]);
});

it('resolves group rows even when no device rows are loaded', async () => {
  const call = vi
    .fn()
    .mockResolvedValue(Response.json({ selected: { 'replace-soon': true } }));
  const provider = new DeviceSelectionProvider(call, context);
  expect(
    await provider.resolveSelected({
      gridId: 'devices',
      tabId,
      rowIds: [],
      groupRoutes: ['replace-soon'],
    }),
  ).toEqual({ 'replace-soon': true });
  expect(call.mock.calls[0][1].by).toEqual(['battery']);
});

it('reports selected groups to LibreGrid and the status bar', async () => {
  const grouped: DeviceSelectionSpec = {
    terms: [],
    groups: [
      {
        predicates: [],
        by: ['orgUnitPath', 'battery'],
        route: ['/School A', 'replace-soon'],
      },
    ],
    added: 0,
    excluded: 0,
    selectedCount: 12,
  };
  const provider = new DeviceSelectionProvider(
    vi.fn().mockResolvedValue(Response.json({ selection: grouped })),
  );
  expect((await provider.getSpec({ gridId: 'devices', tabId })).terms).toEqual([
    { type: 'group', route: ['/School A', 'replace-soon'] },
  ]);
  expect(selectionScope(grouped)).toBe(
    'Selected groups: /School A › Replace soon',
  );
});

const deviceIds = (count: number) =>
  Array.from(
    { length: count },
    (_, index) =>
      `${String(index).padStart(8, '0')}-4c1e-4b8e-9a51-2b7f0f6d8a10`,
  );
const bodySizes = (call: ReturnType<typeof vi.fn>) =>
  call.mock.calls.map(
    ([, body]) => new TextEncoder().encode(JSON.stringify(body)).length,
  );

it('keeps each selection change inside the edge body limit', async () => {
  const call = vi
    .fn()
    .mockImplementation(async () => Response.json({ selection: spec }));
  const provider = new DeviceSelectionProvider(call);
  const ids = deviceIds(2500);
  await provider.applyOps({
    gridId: 'devices',
    tabId,
    ops: [{ op: 'select', ids }],
  });
  expect(Math.max(...bodySizes(call))).toBeLessThanOrEqual(65536);
  expect(
    call.mock.calls.flatMap(([, body]) =>
      body.ops.flatMap((op: { ids: string[] }) => op.ids),
    ),
  ).toEqual(ids);
});

it('keeps each resolve request inside the edge body limit', async () => {
  const call = vi
    .fn()
    .mockImplementation(async () => Response.json({ selected: {} }));
  const provider = new DeviceSelectionProvider(call, context);
  const rowIds = deviceIds(2000);
  const groupRoutes = Array.from(
    { length: 1500 },
    (_, index) => `/District/High schools/School ${index}`,
  );
  await provider.resolveSelected({
    gridId: 'devices',
    tabId,
    rowIds,
    groupRoutes,
  });
  expect(Math.max(...bodySizes(call))).toBeLessThanOrEqual(65536);
  expect(call.mock.calls.flatMap(([, body]) => body.rowIds)).toEqual(rowIds);
  expect(call.mock.calls.flatMap(([, body]) => body.groupRoutes)).toEqual(
    groupRoutes,
  );
});
