import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AuthStore } from '../auth.store';
import type { DevicePredicate, DeviceRow } from '@campus/application-contracts';
import { deviceSyncStateSchema } from '@campus/application-contracts';
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
  session: WritableSignal<ReturnType<typeof sessionFor> | null> = signal(
    sessionFor('actor'),
  ),
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
      selection: {
        terms: [],
        added: 0,
        excluded: 0,
        selectedCount: 0,
        expiredAt: null,
      },
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
    // One read before the new stream opens and one after it.
    expect(statusReads(request)).toBe(reads + 2);
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
    expect(statusReads(request)).toBe(reads + 2);
  });

  it('reloads the grid when a full sync ends between the reopen status read and the open', async () => {
    let current = state('ready');
    const request = routes({
      '/api/devices/sync': () => Response.json({ sync: current }),
      '/api/devices/freshness': () =>
        Response.json({ freshness: { stale: 0, refreshing: false } }),
    });
    const store = setup(request);
    store.reopenDelay = 0;
    const opened = streams(store);
    await store.init();
    opened[0].open();
    current = state('running');
    opened[0].send('full-sync', { type: 'full-sync', sync: current });
    opened[0].fail(2);
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    // The full sync ends before the new subscription is active, so its event is lost.
    current = state('ready', { observedAt: '2026-10-06T12:00:00.000Z' });
    const before = store.revision();
    opened[1].open();
    await vi.waitFor(() => expect(store.revision()).toBe(before + 1));
    expect(store.sync()?.status).toBe('ready');
  });
});

describe('reopen after a failed status read', () => {
  /** Answers status reads with `statuses` in turn, then with a ready status. */
  function statusSequence(statuses: number[]) {
    return routes({
      '/api/devices/sync': () => {
        const status = statuses.shift() ?? 200;
        return status === 200
          ? Response.json({ sync: state('ready') })
          : Response.json({}, { status });
      },
      '/api/devices/freshness': () =>
        Response.json({ freshness: { stale: 0, refreshing: false } }),
    });
  }

  it('retries after a server error and opens once the status read succeeds', async () => {
    const request = statusSequence([200, 502, 503]);
    const store = setup(request);
    store.reopenDelay = 0;
    const opened = streams(store);
    await store.init();
    opened[0].open();
    opened[0].fail(2);
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    expect(statusReads(request)).toBe(4);
    expect(store.error()).toBe('');
  });

  it.each([401, 403])('stays closed after a %i status read', async (status) => {
    const request = statusSequence([200, status]);
    const store = setup(request);
    store.reopenDelay = 0;
    const opened = streams(store);
    await store.init();
    opened[0].open();
    opened[0].fail(2);
    await vi.waitFor(() => expect(statusReads(request)).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(statusReads(request)).toBe(2);
    expect(opened).toHaveLength(1);
  });

  it('backs off up to the cap and starts over after an open', async () => {
    vi.useFakeTimers();
    try {
      let status = 200;
      const reads: number[] = [];
      const request = routes({
        '/api/devices/sync': () => {
          reads.push(Date.now());
          return status === 200
            ? Response.json({ sync: state('ready') })
            : Response.json({}, { status });
        },
        '/api/devices/freshness': () =>
          Response.json({ freshness: { stale: 0, refreshing: false } }),
      });
      const store = setup(request);
      store.reopenDelay = 1000;
      store.reopenCap = 4000;
      const opened = streams(store);
      await store.init();
      opened[0].open();
      status = 503;
      opened[0].fail(2);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(reads.slice(1).map((time, index) => time - reads[index])).toEqual([
        1000, 2000, 4000, 4000,
      ]);
      status = 200;
      await vi.advanceTimersByTimeAsync(4000);
      expect(opened).toHaveLength(2);
      opened[1].open();
      await vi.advanceTimersByTimeAsync(0);
      const before = reads.length;
      opened[1].fail(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(reads).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads).toHaveLength(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reopens the stream when the same person resumes an interrupted session', async () => {
    let signedIn = true;
    const session = signal<ReturnType<typeof sessionFor> | null>(
      sessionFor('actor'),
    );
    const request = routes({
      '/api/devices/sync': () =>
        signedIn
          ? Response.json({ sync: state('ready') })
          : Response.json({ code: 'access-changed' }, { status: 401 }),
    });
    const store = setup(request, session);
    store.reopenDelay = 0;
    const opened = streams(store);
    TestBed.tick();
    await store.init();
    opened[0].open();
    signedIn = false;
    opened[0].fail(2);
    await vi.waitFor(() => expect(statusReads(request)).toBe(2));
    // AuthStore clears the session on the 401 and restores it on resume.
    session.set(null);
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opened).toHaveLength(1);
    signedIn = true;
    session.set(sessionFor('actor'));
    TestBed.tick();
    await vi.waitFor(() => expect(opened).toHaveLength(2));
  });

  it('a first stream that closes before it opens leaves no baseline behind', async () => {
    let current = state('ready');
    const request = routes({
      '/api/devices/sync': () => Response.json({ sync: current }),
      '/api/devices/freshness': () =>
        Response.json({ freshness: { stale: 0, refreshing: false } }),
    });
    const store = setup(request);
    store.reopenDelay = 0;
    const opened = streams(store);
    await store.init();
    opened[0].fail(2);
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    opened[1].open();
    current = state('ready', { observedAt: '2026-10-06T12:00:00.000Z' });
    opened[1].send('full-sync', { type: 'full-sync', sync: current });
    const before = store.revision();
    // The browser retries by itself while the stream is CONNECTING.
    opened[1].fail(0);
    opened[1].open();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('/api/devices/freshness', {
        predicates: [],
        selection: null,
      }),
    );
    expect(store.revision()).toBe(before);
  });
});

it('recounts when a page that scrolling loads starts a refresh job', async () => {
  let refreshJobId: string | null = null;
  let stale = 0;
  const request = routes({
    '/api/devices/query': () =>
      Response.json({ page: { ...page, refreshJobId } }),
    '/api/devices/freshness': () =>
      Response.json({ freshness: { stale, refreshing: stale > 0 } }),
  });
  const store = setup(request);
  store.recountDelay = 0;
  await store.rows(0, 100);
  await vi.waitFor(() =>
    expect(store.freshness()).toEqual({ stale: 0, refreshing: false }),
  );
  refreshJobId = JOB;
  stale = 12;
  await store.rows(100, 100);
  await vi.waitFor(() =>
    expect(store.freshness()).toEqual({ stale: 12, refreshing: true }),
  );
});

const LATER = '2026-10-06T12:00:00.000Z';
const EARLIER = '2026-10-06T11:00:00.000Z';
/** A running status with the start and check times that order status answers (S2). */
const running = (startedAt: string | null, checkedAt: string | null = null) =>
  state('running', { startedAt, checkedAt });
const unreadable = () => new Response('{"sync":', { status: 200 });
/** A finished sync with the start and check times of the reviewer probes (F1). */
const CHECK = '2026-10-06T12:30:00.000Z';
const finished = (startedAt: string, checkedAt: string) =>
  state('ready', { observedAt: LATER, startedAt, checkedAt });

/**
 * Held-out answers that predate the current status (F1).
 * The first two repeat the start instant in another spelling, so the check decides.
 * The rest carry precision below a millisecond, which a millisecond parse loses.
 */
const earlierProbes = [
  {
    name: 'an equal start in the seconds form and an earlier check',
    current: finished(LATER, CHECK),
    answer: running('2026-10-06T12:00:00Z', EARLIER),
  },
  {
    name: 'an equal start in an offset form and an earlier check',
    current: finished(LATER, CHECK),
    answer: running('2026-10-06T13:00:00.000+01:00', EARLIER),
  },
  {
    name: 'an older finish that repeats the start in the seconds form',
    current: finished(LATER, CHECK),
    answer: state('ready', {
      observedAt: LATER,
      startedAt: '2026-10-06T12:00:00Z',
      checkedAt: EARLIER,
    }),
  },
  {
    name: 'an earlier start below a millisecond',
    current: running('2026-10-06T12:00:00.456999Z'),
    answer: running('2026-10-06T12:00:00.456001Z'),
  },
  {
    name: 'an earlier check below a millisecond in another start spelling',
    current: running(LATER, '2026-10-06T12:30:00.456999+00:00'),
    answer: running('2026-10-06T12:00:00Z', '2026-10-06T12:30:00.456001+00:00'),
  },
  {
    name: 'an earlier check below a millisecond after the same start',
    current: running(LATER, '2026-10-06T12:30:00.456999+00:00'),
    answer: running(LATER, '2026-10-06T12:30:00.456001+00:00'),
  },
  {
    name: 'an earlier check at nanosecond precision',
    current: running(LATER, '2026-10-06T12:30:00.456001002Z'),
    answer: running(LATER, '2026-10-06T12:30:00.456001001Z'),
  },
  // The F1 review round 2 cases: minute-only timestamps are valid contract values.
  {
    name: 'an older start in the minute form against a nanosecond start',
    current: finished('2026-10-06T12:00:00.000000001Z', CHECK),
    answer: finished('2026-10-06T12:00Z', CHECK),
  },
  {
    name: 'an older check in the minute form against a nanosecond check',
    current: running(LATER, '2026-10-06T12:30:00.000000001Z'),
    answer: running(LATER, '2026-10-06T12:30Z'),
  },
  {
    name: 'an older check in the minute form with an offset',
    current: running(LATER, '2026-10-06T12:30:00.000000001Z'),
    answer: running('2026-10-06T12:00:00Z', '2026-10-06T13:30+01:00'),
  },
];

/** Answers that outdate the current status by less than a millisecond (F1). Each one replaces. */
const laterProbes = [
  {
    name: 'an equal start in the seconds form and a later check below a millisecond',
    current: running(LATER, '2026-10-06T12:30:00.456001+00:00'),
    answer: running('2026-10-06T12:00:00Z', '2026-10-06T12:30:00.456999+00:00'),
  },
  {
    name: 'a later start below a millisecond',
    current: running('2026-10-06T12:00:00.456001Z'),
    answer: running('2026-10-06T12:00:00.456999Z'),
  },
  {
    name: 'a later check below a millisecond after the same start',
    current: running(LATER, '2026-10-06T12:30:00.456001+00:00'),
    answer: running(LATER, '2026-10-06T12:30:00.456999+00:00'),
  },
  {
    name: 'a later check at nanosecond precision',
    current: running(LATER, '2026-10-06T12:30:00.456001001Z'),
    answer: running(LATER, '2026-10-06T12:30:00.456001002Z'),
  },
  // The reverse of the F1 review round 2 cases. Each one replaces.
  {
    name: 'a newer start in the nanosecond form against a minute start',
    current: finished('2026-10-06T12:00Z', CHECK),
    answer: finished('2026-10-06T12:00:00.000000001Z', CHECK),
  },
  {
    name: 'a newer check in the nanosecond form against a minute check',
    current: running(LATER, '2026-10-06T12:30Z'),
    answer: running(LATER, '2026-10-06T12:30:00.000000001Z'),
  },
  {
    name: 'a newer check in the nanosecond form against a minute check with an offset',
    current: running(LATER, '2026-10-06T13:30+01:00'),
    answer: running('2026-10-06T12:00:00Z', '2026-10-06T12:30:00.000000001Z'),
  },
];

describe('the order of status answers', () => {
  /** Reads `current`, then `answer`, and returns the store. */
  async function answered(current: object, answer: object) {
    let status = current;
    const request = routes({
      '/api/devices/sync': () => Response.json({ sync: status }),
    });
    const store = setup(request);
    await store.loadSync();
    expect(store.sync()).toEqual(current);
    status = answer;
    await store.loadSync();
    return store;
  }

  const older = [
    {
      name: 'an earlier start',
      current: running(LATER),
      answer: running(EARLIER),
    },
    {
      name: 'the same start and an earlier check',
      current: running(LATER, LATER),
      answer: running(LATER, EARLIER),
    },
    { name: 'a missing start', current: running(LATER), answer: running(null) },
    {
      name: 'a missing check after the same start',
      current: running(LATER, LATER),
      answer: running(LATER, null),
    },
  ];
  it.each(older)(
    'keeps the current status when the answer has $name',
    async ({ current, answer }) => {
      const store = await answered(current, answer);
      expect(store.sync()).toEqual(current);
    },
  );

  const newer = [
    {
      name: 'a later start',
      current: running(EARLIER),
      answer: running(LATER),
    },
    {
      name: 'the same start and a later check',
      current: running(EARLIER, EARLIER),
      answer: running(EARLIER, LATER),
    },
    {
      name: 'a missing current start',
      current: running(null),
      answer: running(LATER),
    },
  ];
  it.each(newer)(
    'replaces the current status when the answer has $name',
    async ({ current, answer }) => {
      const store = await answered(current, answer);
      expect(store.sync()).toEqual(answer);
    },
  );

  it.each(earlierProbes)(
    'keeps the current status when a status read answers with $name',
    async ({ current, answer }) => {
      const store = await answered(current, answer);
      expect(store.sync()).toEqual(current);
    },
  );

  it.each(laterProbes)(
    'replaces the current status when a status read answers with $name',
    async ({ current, answer }) => {
      const store = await answered(current, answer);
      expect(store.sync()).toEqual(answer);
    },
  );

  /**
   * Every timestamp spelling that the contract accepts (F1 review round 2).
   * Both operands use one spelling, so a spelling without an exact parse reaches no
   * order and the replacing answer fails the rejection case.
   */
  const spellings = [
    {
      name: 'minutes with Z',
      older: '2026-10-06T12:30Z',
      newer: '2026-10-06T12:31Z',
    },
    {
      name: 'minutes with a positive offset',
      older: '2026-10-06T13:30+01:00',
      newer: '2026-10-06T13:31+01:00',
    },
    {
      name: 'minutes with a negative offset',
      older: '2026-10-06T06:30-06:00',
      newer: '2026-10-06T06:31-06:00',
    },
    {
      name: 'seconds without a fraction',
      older: '2026-10-06T12:30:00Z',
      newer: '2026-10-06T12:30:01Z',
    },
    {
      name: 'one fraction digit',
      older: '2026-10-06T12:30:00.1Z',
      newer: '2026-10-06T12:30:00.2Z',
    },
    {
      name: 'three fraction digits',
      older: '2026-10-06T12:30:00.123Z',
      newer: '2026-10-06T12:30:00.124Z',
    },
    {
      name: 'six fraction digits',
      older: '2026-10-06T12:30:00.123456Z',
      newer: '2026-10-06T12:30:00.123457Z',
    },
    {
      name: 'nine fraction digits',
      older: '2026-10-06T12:30:00.000000001Z',
      newer: '2026-10-06T12:30:00.000000002Z',
    },
    {
      name: 'seconds with a positive offset',
      older: '2026-10-06T13:30:00+01:00',
      newer: '2026-10-06T13:30:01+01:00',
    },
    {
      name: 'nine fraction digits with a negative offset',
      older: '2026-10-06T06:30:00.000000001-06:00',
      newer: '2026-10-06T06:30:00.000000002-06:00',
    },
  ];

  it.each(spellings)(
    'keeps the current status when the answer is older in $name',
    async ({ older, newer }) => {
      const store = await answered(
        running(LATER, newer),
        running(LATER, older),
      );
      expect(store.sync()).toEqual(running(LATER, newer));
    },
  );

  it.each(spellings)(
    'replaces the current status when the answer is newer in $name',
    async ({ older, newer }) => {
      const store = await answered(
        running(LATER, older),
        running(LATER, newer),
      );
      expect(store.sync()).toEqual(running(LATER, newer));
    },
  );

  it.each([
    { name: 'the seconds form', answer: '2026-10-06T12:30:00Z' },
    { name: 'the fraction form', answer: '2026-10-06T12:30:00.000Z' },
    { name: 'the offset form', answer: '2026-10-06T13:30+01:00' },
  ])(
    'replaces a minute-form check with the same instant in $name',
    async ({ answer }) => {
      const store = await answered(
        running(LATER, '2026-10-06T12:30Z'),
        running(LATER, answer),
      );
      expect(store.sync()?.checkedAt).toBe(answer);
    },
  );

  it('replaces the current status with an equal answer and its stale value', async () => {
    const store = await answered(
      state('ready', { stale: false }),
      state('ready', { stale: true }),
    );
    expect(store.sync()?.stale).toBe(true);
  });

  it.each([
    { name: 'another customer', answer: { customerId: 'C0654321' } },
    { name: 'a new generation', answer: { generation: 3 } },
  ])('replaces the current status for $name', async ({ answer }) => {
    const store = await answered(running(LATER), {
      ...state('ready', { observedAt: LATER, startedAt: EARLIER }),
      ...answer,
    });
    expect(store.sync()?.status).toBe('ready');
  });

  it('ignores a full-sync event older than the current status', async () => {
    const request = routes({
      '/api/devices/sync': () => Response.json({ sync: running(LATER) }),
      '/api/devices/freshness': () =>
        Response.json({ freshness: { stale: 0, refreshing: false } }),
    });
    const store = setup(request);
    const opened = streams(store);
    await store.init();
    opened[0].open();
    const current = store.sync();
    const before = store.revision();
    opened[0].send('full-sync', {
      type: 'full-sync',
      sync: state('ready', { observedAt: LATER, startedAt: EARLIER }),
    });
    expect(store.sync()).toEqual(current);
    expect(store.revision()).toBe(before);
  });

  /** Opens a stream on `current` and reports the revision before the event. */
  async function answeredByEvent(current: object, answer: object) {
    const request = routes({
      '/api/devices/sync': () => Response.json({ sync: current }),
      '/api/devices/freshness': () =>
        Response.json({ freshness: { stale: 0, refreshing: false } }),
    });
    const store = setup(request);
    const opened = streams(store);
    await store.init();
    opened[0].open();
    const before = store.revision();
    opened[0].send('full-sync', { type: 'full-sync', sync: answer });
    return { store, before };
  }

  it.each(earlierProbes)(
    'ignores a full-sync event that carries $name and keeps the revision',
    async ({ current, answer }) => {
      const { store, before } = await answeredByEvent(current, answer);
      expect(store.sync()).toEqual(current);
      expect(store.revision()).toBe(before);
    },
  );

  it.each(laterProbes)(
    'replaces the current status when a full-sync event carries $name',
    async ({ current, answer }) => {
      const { store } = await answeredByEvent(current, answer);
      expect(store.sync()).toEqual(answer);
    },
  );

  it('keeps the current status when a refresh answer is older', async () => {
    let answer = running(LATER);
    const request = routes({
      '/api/devices/sync': (body) =>
        body === undefined
          ? Response.json({ sync: state('ready') })
          : Response.json({ sync: answer }, { status: 201 }),
    });
    const store = setup(request);
    await store.loadSync();
    await store.refreshAll();
    const current = store.sync();
    expect(current?.status).toBe('running');
    answer = state('ready', { observedAt: LATER, startedAt: EARLIER });
    await store.refreshAll();
    expect(store.sync()).toEqual(current);
  });

  /** Reads `current`, then starts a refresh whose answer is `answer`. */
  async function answeredByRefresh(current: object, answer: object) {
    const request = routes({
      '/api/devices/sync': (body) =>
        body === undefined
          ? Response.json({ sync: current })
          : Response.json({ sync: answer }, { status: 201 }),
    });
    const store = setup(request);
    await store.loadSync();
    await store.refreshAll();
    return store;
  }

  it.each(earlierProbes)(
    'keeps the current status when a refresh answers with $name',
    async ({ current, answer }) => {
      const store = await answeredByRefresh(current, answer);
      expect(store.sync()).toEqual(current);
    },
  );

  it.each(laterProbes)(
    'replaces the current status when a refresh answers with $name',
    async ({ current, answer }) => {
      const store = await answeredByRefresh(current, answer);
      expect(store.sync()).toEqual(answer);
    },
  );
});

/**
 * The status contract decides which timestamp strings the store can receive (F1 review round 2).
 * The store parses every one of them exactly, so this test pins the grammar.
 * A Zod upgrade that widens the grammar must fail here instead of reaching the store.
 */
describe('the timestamp grammar of the status contract', () => {
  /** A ready status whose three timestamps all use `timestamp`. */
  const status = (timestamp: string) =>
    state('ready', {
      observedAt: timestamp,
      startedAt: timestamp,
      checkedAt: timestamp,
    });

  const accepted = [
    // Minutes alone. Zod 4.4.2 accepts a timestamp without seconds.
    '2026-10-06T12:30Z',
    '2026-10-06T12:30+01:00',
    '2026-10-06T12:30-05:30',
    // Seconds with and without a fraction.
    '2026-10-06T12:30:00Z',
    '2026-10-06T12:30:00+01:00',
    '2026-10-06T12:30:00.1Z',
    '2026-10-06T12:30:00.12Z',
    '2026-10-06T12:30:00.123Z',
    '2026-10-06T12:30:00.1234Z',
    '2026-10-06T12:30:00.12345Z',
    '2026-10-06T12:30:00.123456Z',
    '2026-10-06T12:30:00.1234567Z',
    '2026-10-06T12:30:00.12345678Z',
    '2026-10-06T12:30:00.123456789Z',
    // Zod allows any number of fraction digits. The store keeps every digit.
    '2026-10-06T12:30:00.000000000000000000000001Z',
  ];

  const rejected = [
    '2026-10-06T12:30:00',
    '2026-10-06T12:30:00z',
    '2026-10-06T12:30.5Z',
    '2026-10-06 12:30:00Z',
    '2026-10-6T12:30Z',
    '2026-10-06T12:30:00+0100',
    '2026-10-06T12:30:00.Z',
    '2026-10-06T12:60:00Z',
    '2026-10-06T12:30:60Z',
    '2026-02-30T12:30:00Z',
  ];

  it.each(accepted)('accepts the status timestamp %s', (timestamp) => {
    expect(deviceSyncStateSchema.safeParse(status(timestamp)).success).toBe(
      true,
    );
  });

  it.each(rejected)('rejects the status timestamp %s', (timestamp) => {
    expect(deviceSyncStateSchema.safeParse(status(timestamp)).success).toBe(
      false,
    );
  });
});

describe('a status answer with an unreadable body', () => {
  const bodies = [
    { name: 'a body that is not JSON', body: unreadable },
    {
      name: 'a body that fails the status schema',
      body: () => Response.json({ sync: { status: 'nope' } }),
    },
  ];

  it.each(bodies)('reports $name as a failed status read', async ({ body }) => {
    const store = setup(
      vi.fn().mockImplementation(() => Promise.resolve(body())),
    );
    await expect(store.loadSync()).resolves.toBe(false);
    expect(store.error()).toBe('Device inventory status is unavailable.');
    expect(store.sync()).toBeNull();
  });

  it.each(bodies)('reopens the stream after $name', async ({ body }) => {
    let bad = true;
    const request = routes({
      '/api/devices/sync': () =>
        bad ? body() : Response.json({ sync: state('ready') }),
    });
    const store = setup(request);
    store.reopenDelay = 0;
    const opened = streams(store);
    await store.init();
    expect(opened).toHaveLength(0);
    bad = false;
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(statusReads(request)).toBe(2);
  });

  it.each(bodies)(
    'reports $name as a failed refresh start',
    async ({ body }) => {
      const store = setup(
        vi.fn().mockImplementation(() => Promise.resolve(body())),
      );
      await store.refreshAll();
      expect(store.error()).toBe('The refresh could not start.');
    },
  );
});

describe('a failed post-open read', () => {
  const failed = () => new Response('{"sync":', { status: 503 });

  /** A store whose stream dropped while a sync ran. `failNext()` breaks the next status read. */
  async function dropped(current: object) {
    const status = current;
    let failures = 0;
    const request = routes({
      '/api/devices/sync': () => {
        if (failures < 1) return Response.json({ sync: status });
        failures -= 1;
        return failed();
      },
      '/api/devices/freshness': () =>
        Response.json({ freshness: { stale: 0, refreshing: false } }),
    });
    const store = setup(request);
    store.reopenDelay = 0;
    const opened = streams(store);
    await store.init();
    opened[0].open();
    opened[0].send('full-sync', { type: 'full-sync', sync: running(null) });
    const before = store.revision();
    opened[0].fail(2);
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    return { request, store, opened, before, failNext: () => (failures = 1) };
  }

  it('reloads the grid when the gate read shows the sync ended', async () => {
    const { request, store, opened, before, failNext } = await dropped(
      state('ready', { observedAt: LATER }),
    );
    failNext();
    opened[1].open();
    await vi.waitFor(() => expect(store.revision()).toBe(before + 1));
    expect(store.sync()?.status).toBe('ready');
    expect(store.error()).toBe('Device inventory status is unavailable.');
    expect(statusReads(request)).toBe(3);
  });

  it('keeps the baseline when the gate read matches the status from before the drop', async () => {
    const { store, opened, before, failNext } = await dropped(running(null));
    failNext();
    opened[1].open();
    await vi.waitFor(() =>
      expect(store.error()).toBe('Device inventory status is unavailable.'),
    );
    expect(store.revision()).toBe(before);
    expect(store.sync()?.status).toBe('running');
  });

  it('compares the next reconnect against the gate read', async () => {
    const { request, store, opened, before, failNext } = await dropped(
      state('ready', { observedAt: LATER }),
    );
    failNext();
    opened[1].open();
    await vi.waitFor(() => expect(store.revision()).toBe(before + 1));
    opened[1].fail(2);
    await vi.waitFor(() => expect(opened).toHaveLength(3));
    opened[2].open();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('/api/devices/freshness', {
        predicates: [],
        selection: null,
      }),
    );
    expect(store.revision()).toBe(before + 1);
  });
});

describe('the first open after a running status', () => {
  it('reloads the grid when the sync ends before the stream subscribes', async () => {
    let current = running(null);
    const request = routes({
      '/api/devices/sync': () => Response.json({ sync: current }),
      '/api/devices/freshness': () =>
        Response.json({ freshness: { stale: 0, refreshing: false } }),
    });
    const store = setup(request);
    const opened = streams(store);
    await store.init();
    expect(opened).toHaveLength(1);
    const before = store.revision();
    current = state('ready', { observedAt: LATER });
    opened[0].open();
    await vi.waitFor(() => expect(store.revision()).toBe(before + 1));
    expect(store.sync()?.status).toBe('ready');
    expect(statusReads(request)).toBe(2);
  });

  it('makes no extra status read when the first open follows a ready status', async () => {
    const request = routes({
      '/api/devices/sync': () => Response.json({ sync: state('ready') }),
      '/api/devices/freshness': () =>
        Response.json({ freshness: { stale: 0, refreshing: false } }),
    });
    const store = setup(request);
    const opened = streams(store);
    await store.init();
    opened[0].open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(statusReads(request)).toBe(1);
  });

  it('reconciles the first open after a refresh started before the stream opened', async () => {
    let current = state('ready');
    const request = routes({
      '/api/devices/sync': (body) =>
        body === undefined
          ? Response.json({ sync: current })
          : Response.json({ sync: running(null) }, { status: 201 }),
      '/api/devices/freshness': () =>
        Response.json({ freshness: { stale: 0, refreshing: false } }),
    });
    const store = setup(request);
    const opened = streams(store);
    await store.init();
    expect(statusReads(request)).toBe(1);
    // Refresh all starts a full sync before the stream subscribes.
    await store.refreshAll();
    expect(store.sync()?.status).toBe('running');
    const before = store.revision();
    current = state('ready', { observedAt: LATER });
    opened[0].open();
    // The current status is running, so the first open reads after the open and reloads the grid.
    await vi.waitFor(() => expect(store.revision()).toBe(before + 1));
    expect(store.sync()?.status).toBe('ready');
    expect(statusReads(request)).toBe(2);
  });
});

describe('a resumed session', () => {
  function signedIn() {
    let signedIn = true;
    const session = signal<ReturnType<typeof sessionFor> | null>(
      sessionFor('actor'),
    );
    const request = routes({
      '/api/devices/sync': () =>
        signedIn
          ? Response.json({ sync: state('ready') })
          : Response.json({ code: 'access-changed' }, { status: 401 }),
    });
    const store = setup(request, session);
    store.reopenDelay = 0;
    const opened = streams(store);
    TestBed.tick();
    return {
      session,
      store,
      opened,
      reads: () => statusReads(request),
      signOut: () => (signedIn = false),
      signIn: () => (signedIn = true),
    };
  }

  it('asks the grid to retry the failed blocks when the same person resumes', async () => {
    const { session, store, opened, reads, signOut, signIn } = signedIn();
    await store.init();
    opened[0].open();
    signOut();
    opened[0].fail(2);
    // The gate read denies the ended session, so the stream stays closed.
    await vi.waitFor(() => expect(reads()).toBe(2));
    expect(opened).toHaveLength(1);
    const before = store.resumeRevision();
    session.set(null);
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    signIn();
    session.set(sessionFor('actor'));
    TestBed.tick();
    await vi.waitFor(() => expect(store.resumeRevision()).toBe(before + 1));
    // The stream reopens as before.
    await vi.waitFor(() => expect(opened).toHaveLength(2));
  });

  it('keeps the reset of another sign-in without a retry', () => {
    const { session, store, opened } = signedIn();
    const before = store.resumeRevision();
    session.set(sessionFor('someone-else'));
    TestBed.tick();
    expect(store.resumeRevision()).toBe(before);
    expect(store.revision()).toBe(1);
    expect(opened).toHaveLength(0);
  });
});

describe('the stale count of a new query', () => {
  const notes = {
    predicates: [{ field: 'notes' as const, operator: 'isEmpty' as const }],
    sort: { field: 'serialNumber' as const, direction: 'asc' as const },
    selection: null,
  };

  it('keeps the shown count until the new count arrives and counts at once', async () => {
    let stale = 12;
    let hold = Promise.resolve();
    const request = vi.fn(async (path: string) => {
      if (path === '/api/devices/query') return Response.json({ page });
      await hold;
      return Response.json({ freshness: { stale, refreshing: true } });
    });
    // recountDelay stays at 1000 ms. A new query must not wait for it.
    const store = setup(request);
    await store.rows(0, 100);
    await vi.waitFor(() => expect(store.freshness()?.stale).toBe(12), {
      timeout: 500,
    });
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stale = 3;
    store.setView(notes);
    await store.rows(0, 100);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4), {
      timeout: 500,
    });
    expect(store.freshness()?.stale).toBe(12);
    release();
    await vi.waitFor(() => expect(store.freshness()?.stale).toBe(3));
  });

  it('drops the previous query count when the new count fails', async () => {
    let available = true;
    const request = vi.fn(async (path: string) =>
      path === '/api/devices/query'
        ? Response.json({ page })
        : available
          ? Response.json({ freshness: { stale: 12, refreshing: true } })
          : Response.json({}, { status: 503 }),
    );
    const store = setup(request);
    store.recountDelay = 0;
    await store.rows(0, 100);
    await vi.waitFor(() => expect(store.freshness()?.stale).toBe(12));
    available = false;
    store.setView(notes);
    await store.rows(0, 100);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(store.freshness()).toBeNull());
  });
});
