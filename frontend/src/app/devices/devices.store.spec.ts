import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AuthStore } from '../auth.store';
import type { DevicePredicate, DeviceRow } from '@campus/application-contracts';
import { DevicesStore } from './devices.store';
import type { DeviceEventSource } from './devices.store';

const state = (status: string, extra: Record<string, unknown> = {}) => ({
  customerId: 'C0123456',
  generation: 1,
  status,
  observedAt: status === 'ready' ? '2026-10-05T12:00:00.000Z' : null,
  deviceCount: status === 'ready' ? 450 : 0,
  failure: null,
  telemetryFailure: null,
  startedAt: null,
  checkedAt: null,
  stale: false,
  ...extra,
});
const page = {
  rows: [],
  matching: 96,
  total: 450,
  observedAt: '2026-10-05T12:00:00.000Z',
  refreshJobId: null,
};

const sessionFor = (id: string) => ({
  identity: {
    id,
    permissionVersion: 1,
    grants: [{ action: 'devices:read', scope: { kind: 'platform' } }],
  },
  csrfToken: 'session',
});

function setup(
  request: ReturnType<typeof vi.fn>,
  session = signal(sessionFor('actor')),
) {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AuthStore,
        useValue: {
          request,
          metadata: () => ({ phase: 3 }),
          session,
          interrupted: () => false,
        },
      },
    ],
  });
  const store = TestBed.inject(DevicesStore);
  store.streamTimeout = 0;
  return store;
}

it('queries rows with the active filters and sort and keeps the counts', async () => {
  const request = vi.fn().mockResolvedValue(Response.json({ page }));
  const store = setup(request);
  store.setView({
    predicates: [{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }],
    sort: { field: 'assetTag', direction: 'desc' },
    selection: null,
  });
  await store.rows(100, 100);
  expect(request).toHaveBeenCalledWith('/api/devices/query', {
    predicates: [{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }],
    sort: { field: 'assetTag', direction: 'desc' },
    offset: 100,
    limit: 100,
    selection: null,
  });
  expect(store.page()).toEqual({
    matching: 96,
    total: 450,
    observedAt: page.observedAt,
  });
  expect(store.readable()).toBe(true);
});

it('keeps the last counts and reports offline when the network fails', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ page }))
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(Response.json({ sync: state('ready') }));
  const store = setup(request);
  await store.rows(0, 100);
  expect(await store.rows(100, 100)).toBeNull();
  expect(store.offline()).toBe(true);
  expect(store.page()?.matching).toBe(96);
  const before = store.revision();
  await store.reconnect();
  expect(store.offline()).toBe(false);
  expect(store.revision()).toBe(before + 1);
});

it('changing filters forgets the row position and leaves reloads to the grid', () => {
  const store = setup(vi.fn());
  store.position.set({ index: 4, deviceId: 'd4' });
  const before = store.revision();
  store.setPredicates([{ field: 'notes', operator: 'isEmpty' }]);
  expect(store.revision()).toBe(before);
  expect(store.position()).toBeNull();
  store.position.set({ index: 4, deviceId: 'd4' });
  store.setPredicates([{ field: 'notes', operator: 'isEmpty' }]);
  expect(store.position()).toEqual({ index: 4, deviceId: 'd4' });
});

it('a different grid query forgets the opened row and the same query keeps it', () => {
  const store = setup(vi.fn());
  const view = {
    predicates: [],
    sort: { field: 'serialNumber' as const, direction: 'asc' as const },
    selection: null,
  };
  store.position.set({ index: 4, deviceId: 'd4' });
  store.setView({ ...view });
  expect(store.position()).not.toBeNull();
  store.setView({
    ...view,
    selection: { gridId: 'devices', tabId: store.selectionTab },
  });
  expect(store.position()).toBeNull();
});

it('sends selection requests through the signed-in connection', async () => {
  const request = vi.fn().mockResolvedValue(
    Response.json({
      selection: { terms: [], added: 0, excluded: 0, selectedCount: 0 },
    }),
  );
  const store = setup(request);
  await store.selection.getSpec({
    gridId: 'devices',
    tabId: store.selectionTab,
  });
  expect(request).toHaveBeenCalledWith('/api/devices/selection', {
    gridId: 'devices',
    tabId: store.selectionTab,
  });
});

it('ignores counts from a query whose filters changed meanwhile', async () => {
  let finish: (response: Response) => void = () => undefined;
  const request = vi.fn().mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const store = setup(request);
  const pending = store.rows(0, 100);
  store.setView({
    predicates: [{ field: 'notes', operator: 'isEmpty' }],
    sort: { field: 'serialNumber', direction: 'asc' },
    selection: null,
  });
  finish(Response.json({ page }));
  await pending;
  expect(store.page()).toBeNull();
});

it('clears browsing state when a different person signs in', () => {
  const session = signal(sessionFor('actor'));
  const store = setup(vi.fn(), session);
  TestBed.tick();
  store.setPredicates([{ field: 'notes', operator: 'isEmpty' }]);
  store.position.set({ index: 2, deviceId: 'd2' });
  store.gridState.set({ pagination: { page: 3, pageSize: 100 } });
  store.selectedView.set(true);
  session.set(sessionFor('someone-else'));
  TestBed.tick();
  expect(store.predicates()).toEqual([]);
  expect(store.position()).toBeNull();
  expect(store.gridState()).toBeNull();
  expect(store.selectedView()).toBe(false);
  expect(store.view().predicates).toEqual([]);
});

const groupBody = {
  groups: [{ key: '/School A', devices: 150 }],
  groupCount: 2,
  matching: 450,
  total: 450,
  observedAt: page.observedAt,
};

it('only the outermost grouped query reports counts and the group limit', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ groups: groupBody }))
    .mockResolvedValueOnce(
      Response.json({ page: { ...page, matching: 150, rows: [] } }),
    );
  const store = setup(request);
  const root = {
    predicates: [],
    sort: { field: 'serialNumber' as const, direction: 'asc' as const },
    selection: null,
    group: { by: ['orgUnitPath' as const], keys: [] },
  };
  store.setView(root);
  await store.groups(root);
  expect(request).toHaveBeenCalledWith('/api/devices/groups', {
    ...root,
    offset: 0,
    limit: 1000,
  });
  expect(store.page()?.matching).toBe(450);
  expect(store.groupLimit()).toBe(true);
  store.setView({
    ...root,
    group: { by: ['orgUnitPath'], keys: ['/School A'] },
  });
  await store.rows(0, 1000);
  expect(store.page()?.matching).toBe(450);
});

it('describes the grid to the selection provider', async () => {
  const request = vi
    .fn()
    .mockResolvedValue(Response.json({ selected: { '/School A': true } }));
  const store = setup(request);
  store.setView({
    predicates: [{ field: 'notes', operator: 'isEmpty' }],
    sort: { field: 'serialNumber', direction: 'asc' },
    selection: null,
    group: { by: ['orgUnitPath'], keys: [] },
  });
  await store.selection.resolveSelected({
    gridId: 'devices',
    tabId: store.selectionTab,
    rowIds: [],
    groupRoutes: ['/School A'],
  });
  expect(request).toHaveBeenCalledWith('/api/devices/selection/resolve', {
    gridId: 'devices',
    tabId: store.selectionTab,
    rowIds: [],
    groupRoutes: ['/School A'],
    predicates: [{ field: 'notes', operator: 'isEmpty' }],
    by: ['orgUnitPath'],
  });
});

it('does not report the group limit for Next device inside a group', async () => {
  const request = vi
    .fn()
    .mockResolvedValue(Response.json({ page: { ...page, matching: 135 } }));
  const store = setup(request);
  store.view.set({
    predicates: [],
    sort: { field: 'serialNumber', direction: 'asc' },
    selection: null,
    group: { by: ['battery'], keys: ['replace-soon'] },
  });
  await store.neighbor(4);
  expect(store.groupLimit()).toBe(false);
});

const JOB = '33333333-3333-4333-8333-333333333333';
const job = (failure: string | null) => ({
  jobId: JOB,
  customerId: 'C0123456',
  entityType: 'device',
  batchCount: 1,
  completedBatches: failure ? 0 : 1,
  failedBatches: failure ? 1 : 0,
  failure,
  createdAt: '2026-10-06T12:00:00.000Z',
  finishedAt: '2026-10-06T12:01:00.000Z',
});
const batchEvent = (deviceIds: string[], removedIds: string[] = []) => ({
  type: 'entity-batch',
  jobId: JOB,
  entityType: 'device',
  batch: 0,
  batchCount: 1,
  deviceIds,
  removedIds,
});

/** Answers each request by path. A path without a route fails like the network. */
function routes(table: Record<string, (body: unknown) => Response>) {
  return vi.fn(async (path: string, body?: unknown) => {
    const route = table[path];
    if (!route) throw new TypeError('Failed to fetch');
    return route(body);
  });
}

/** A controllable EventSource. */
class FakeStream {
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();
  addEventListener(name: string, listener: (event: Event) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.fire('open');
  }
  send(name: string, data: unknown): void {
    this.fire(name, JSON.stringify(data));
  }
  fail(readyState: number): void {
    this.readyState = readyState;
    this.fire('error');
  }
  private fire(name: string, data?: string): void {
    for (const listener of this.listeners.get(name) ?? [])
      listener({ data } as unknown as Event);
  }
}

function streams(store: DevicesStore): FakeStream[] {
  const opened: FakeStream[] = [];
  store.eventSource = () => {
    const stream = new FakeStream();
    opened.push(stream);
    return stream as unknown as DeviceEventSource;
  };
  return opened;
}

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
  const api = {
    forEachNode: (visit: (node: unknown) => void) => nodes.forEach(visit),
    getRowNode: (id: string) => nodes.find((node) => node.id === id),
  };
  return { nodes, api: api as never };
}

const statusReads = (request: ReturnType<typeof routes>) =>
  request.mock.calls.filter(
    ([path, body]) => path === '/api/devices/sync' && body === undefined,
  ).length;

it('follows Refresh all through the event stream instead of polling', async () => {
  const request = routes({
    '/api/devices/sync': (body) =>
      body === undefined
        ? Response.json({ sync: state('ready') })
        : Response.json({ sync: state('running') }, { status: 201 }),
  });
  const store = setup(request);
  const opened = streams(store);
  await store.init();
  opened[0].open();
  await store.refreshAll();
  expect(store.sync()?.status).toBe('running');
  const before = store.revision();
  opened[0].send('full-sync', { type: 'full-sync', sync: state('ready') });
  expect(store.sync()?.status).toBe('ready');
  expect(store.revision()).toBe(before + 1);
  expect(statusReads(request)).toBe(1);
});

it('follows a refresh that is already running', async () => {
  const request = routes({
    '/api/devices/sync': (body) =>
      body === undefined
        ? Response.json({ sync: state('running') })
        : Response.json({ reason: 'device-sync-running' }, { status: 409 }),
  });
  const store = setup(request);
  await store.refreshAll();
  expect(store.sync()?.status).toBe('running');
  expect(store.error()).toBe('');
});

it('opens one stream while Devices is mounted and ignores it after leave', async () => {
  const request = routes({
    '/api/devices/sync': () => Response.json({ sync: state('ready') }),
  });
  const store = setup(request);
  const opened = streams(store);
  await store.init();
  await store.init();
  expect(opened).toHaveLength(1);
  store.leave();
  expect(opened[0].closed).toBe(true);
  opened[0].send('full-sync', { type: 'full-sync', sync: state('running') });
  expect(store.sync()?.status).toBe('ready');
});

it('opens no stream without a Google connection', async () => {
  const store = setup(
    routes({ '/api/devices/sync': () => Response.json({ sync: null }) }),
  );
  const opened = streams(store);
  await store.init();
  expect(opened).toHaveLength(0);
});

it('refetches only the held rows that a batch names and updates them in place', async () => {
  const request = routes({
    '/api/devices/sync': () => Response.json({ sync: state('ready') }),
    '/api/devices/by-ids': () =>
      Response.json({ rows: [rowFor('d1', false), rowFor('d2', false)] }),
    '/api/devices/freshness': () =>
      Response.json({ freshness: { stale: 0, refreshing: false } }),
  });
  const store = setup(request);
  store.recountDelay = 0;
  const opened = streams(store);
  const { nodes, api } = grid([
    rowFor('d1', true),
    rowFor('d2', true),
    rowFor('d3', true),
  ]);
  store.gridRows.attach(api);
  await store.init();
  opened[0].send('entity-batch', batchEvent(['d1', 'd9'], ['d2']));
  await vi.waitFor(() =>
    expect(nodes[0].updateData).toHaveBeenCalledWith(rowFor('d1', false)),
  );
  expect(request).toHaveBeenCalledWith('/api/devices/by-ids', {
    deviceIds: ['d1', 'd2'],
  });
  expect(nodes[2].updateData).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(store.freshness()).toEqual({ stale: 0, refreshing: false }),
  );
});

it('counts stale devices for the counted query when its counts change', async () => {
  const request = routes({
    '/api/devices/query': () => Response.json({ page }),
    '/api/devices/freshness': () =>
      Response.json({ freshness: { stale: 12, refreshing: true } }),
  });
  const store = setup(request);
  store.recountDelay = 0;
  const predicates: DevicePredicate[] = [
    { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
  ];
  store.setView({
    predicates,
    sort: { field: 'serialNumber', direction: 'asc' },
    selection: null,
  });
  await store.rows(0, 100);
  await vi.waitFor(() =>
    expect(store.freshness()).toEqual({ stale: 12, refreshing: true }),
  );
  expect(request).toHaveBeenCalledWith('/api/devices/freshness', {
    predicates,
    selection: null,
  });
});

it('keeps the cause of a failed refresh job until a new job starts', async () => {
  const request = routes({
    '/api/devices/sync': () => Response.json({ sync: state('ready') }),
    '/api/devices/query': () =>
      Response.json({ page: { ...page, refreshJobId: JOB } }),
    '/api/devices/freshness': () =>
      Response.json({ freshness: { stale: 3, refreshing: false } }),
  });
  const store = setup(request);
  const opened = streams(store);
  await store.init();
  opened[0].send('job-finished', { type: 'job-finished', job: job('quota') });
  expect(store.jobFailure()).toBe('quota');
  await store.rows(0, 100);
  expect(store.jobFailure()).toBeNull();
});

it('reconciles after a reconnect: one status read, held stale rows, and a recount', async () => {
  const request = routes({
    '/api/devices/sync': () => Response.json({ sync: state('ready') }),
    '/api/devices/by-ids': () =>
      Response.json({ rows: [rowFor('d1', false), rowFor('d3', false)] }),
    '/api/devices/freshness': () =>
      Response.json({ freshness: { stale: 0, refreshing: false } }),
  });
  const store = setup(request);
  const opened = streams(store);
  const { api } = grid([
    rowFor('d1', true),
    rowFor('d2', false),
    rowFor('d3', true),
  ]);
  store.gridRows.attach(api);
  await store.init();
  opened[0].open();
  expect(statusReads(request)).toBe(1);
  // The browser retries by itself while the stream is CONNECTING.
  opened[0].fail(0);
  opened[0].open();
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith('/api/devices/freshness', {
      predicates: [],
      selection: null,
    }),
  );
  expect(statusReads(request)).toBe(2);
  expect(request).toHaveBeenCalledWith('/api/devices/by-ids', {
    deviceIds: ['d1', 'd3'],
  });
  expect(opened).toHaveLength(1);
});

it('reopens a closed stream after a status read and stays closed after the session ends', async () => {
  let signedIn = true;
  const request = routes({
    '/api/devices/sync': () =>
      signedIn
        ? Response.json({ sync: state('ready') })
        : Response.json({ code: 'access-changed' }, { status: 401 }),
  });
  const store = setup(request);
  store.reopenDelay = 0;
  const opened = streams(store);
  await store.init();
  opened[0].open();
  opened[0].fail(2);
  await vi.waitFor(() => expect(opened).toHaveLength(2));
  expect(opened[0].closed).toBe(true);
  opened[0].send('full-sync', { type: 'full-sync', sync: state('running') });
  expect(store.sync()?.status).toBe('ready');
  signedIn = false;
  opened[1].fail(2);
  await vi.waitFor(() => expect(statusReads(request)).toBe(3));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(opened).toHaveLength(2);
});

it('reopens a stream that stays silent past the timeout', async () => {
  vi.useFakeTimers();
  try {
    const request = routes({
      '/api/devices/sync': () => Response.json({ sync: state('ready') }),
    });
    const store = setup(request);
    store.streamTimeout = 1000;
    store.reopenDelay = 0;
    const opened = streams(store);
    await store.init();
    opened[0].open();
    await vi.advanceTimersByTimeAsync(900);
    opened[0].send('ping', {});
    await vi.advanceTimersByTimeAsync(900);
    expect(opened).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(opened).toHaveLength(2));
  } finally {
    vi.useRealTimers();
  }
});

describe('reconcile after the stream closed', () => {
  async function dropped(observedAt: string) {
    let current = state('ready');
    const request = routes({
      '/api/devices/sync': () => Response.json({ sync: current }),
      '/api/devices/by-ids': () =>
        Response.json({ rows: [rowFor('d1', false)] }),
      '/api/devices/freshness': () =>
        Response.json({ freshness: { stale: 0, refreshing: false } }),
    });
    const store = setup(request);
    store.reopenDelay = 0;
    const opened = streams(store);
    const { api } = grid([rowFor('d1', true)]);
    store.gridRows.attach(api);
    await store.init();
    opened[0].open();
    const reads = statusReads(request);
    const before = store.revision();
    current = state('ready', { observedAt });
    opened[0].fail(2);
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    opened[1].open();
    return { request, store, reads, before };
  }

  it('reloads the grid when a full sync ended while the stream was closed', async () => {
    const { request, store, reads, before } = await dropped(
      '2026-10-06T12:00:00.000Z',
    );
    await vi.waitFor(() => expect(store.revision()).toBe(before + 1));
    expect(statusReads(request)).toBe(reads + 1);
  });

  it('refetches stale rows and recounts when the status did not change', async () => {
    const { request, store, reads, before } = await dropped(
      '2026-10-05T12:00:00.000Z',
    );
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('/api/devices/freshness', {
        predicates: [],
        selection: null,
      }),
    );
    expect(request).toHaveBeenCalledWith('/api/devices/by-ids', {
      deviceIds: ['d1'],
    });
    expect(store.revision()).toBe(before);
    expect(statusReads(request)).toBe(reads + 1);
  });
});
