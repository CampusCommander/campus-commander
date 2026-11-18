import { signal, type Provider, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type {
  UserAttributeCategories,
  UserFreshness,
  UserPage,
  UserPredicate,
  UserRow,
  UserSelectionSpec,
  UserSyncState,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { CustomerStore } from '../customer-settings/customer.store';
import { ConnectionStore } from '../google-connection/connection.store';
import { LiveFeeds } from '../jobs/live-feeds';
import { UsersStore } from './users.store';
import type { UserEventSource } from './users.store';
import type { UserView } from './user-datasource';
import { userSelectionTab } from './user-selection';
import { SELECTION_EXPIRED_TEXT } from './user-refresh-messages';

const sync = (
  status: string,
  extra: Partial<UserSyncState> = {},
): UserSyncState => ({
  customerId: 'C0123456',
  generation: 1,
  status: status as UserSyncState['status'],
  observedAt: status === 'ready' ? '2026-11-16T12:00:00.000Z' : null,
  userCount: status === 'ready' ? 450 : 0,
  failure: null,
  startedAt: null,
  checkedAt: null,
  stale: false,
  ...extra,
});

const page = (extra: Partial<UserPage> = {}): UserPage => ({
  rows: [],
  matching: 96,
  total: 450,
  observedAt: '2026-11-16T12:00:00.000Z',
  refreshJobId: null,
  ...extra,
});

const categories: UserAttributeCategories = {
  categories: [
    {
      schemaId: 'schema-student',
      schemaName: 'Student',
      displayName: 'Student information',
      etag: '"schema-etag"',
      fields: [
        {
          fieldId: 'Student.grade_level',
          fieldName: 'grade_level',
          displayName: 'Grade level',
          fieldType: 'INT64',
          multiValued: false,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: null,
          holders: 120,
        },
      ],
      holders: 300,
      readAt: '2026-11-16T12:00:00.000Z',
    },
  ],
  limits: {
    categories: 1,
    categoryLimit: 100,
    attributes: 1,
    attributeLimit: 100,
  },
  observedAt: '2026-11-16T12:00:00.000Z',
};

const freshness: UserFreshness = {
  stale: 2,
  refreshing: false,
};

const userRow = (extra: Partial<UserRow> = {}): UserRow => ({
  userId: '110000000000000000001',
  primaryEmail: 'aaliyah.brooks@example.org',
  orgUnitPath: '/Students/High School',
  givenName: 'Aaliyah',
  familyName: 'Brooks',
  fullName: 'Aaliyah Brooks',
  suspended: false,
  suspensionReason: null,
  archived: false,
  lastLoginTime: '2026-11-01T12:00:00.000Z',
  creationTime: '2020-08-01T12:00:00.000Z',
  twoStepEnrolled: true,
  department: null,
  title: null,
  aliases: [],
  customSchemas: {},
  lastEntitySync: '2026-11-16T12:00:00.000Z',
  stale: false,
  recordVersion: 1,
  ...extra,
});

const selectionSpec = (
  extra: Partial<UserSelectionSpec> = {},
): UserSelectionSpec => ({
  terms: [{ type: 'all', predicates: [] }],
  added: 0,
  excluded: 0,
  selectedCount: 0,
  expiredAt: null,
  ...extra,
});

/** A response that the test releases. */
function held<T>() {
  let release: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const sessionFor = (id: string, actions = ['users:read']) => ({
  identity: {
    id,
    permissionVersion: 1,
    grants: actions.map((action) => ({
      action,
      scope: { kind: 'platform' },
    })),
  },
  csrfToken: 'session',
});

const answers: Record<string, unknown> = {
  '/api/users/sync': { sync: sync('ready') },
  '/api/users/attribute-categories': categories,
  '/api/users/org-units': {
    orgUnits: [
      { path: '/Students/High School', users: 120 },
      { path: '/Staff', users: 30 },
    ],
  },
  '/api/users/query': { page: page() },
  '/api/users/freshness': { freshness },
  '/api/users/selection': {
    selection: {
      terms: [{ type: 'all', predicates: [] }],
      added: 0,
      excluded: 0,
      selectedCount: 0,
      expiredAt: null,
    },
  },
};

function setup(
  request: ReturnType<typeof vi.fn>,
  session: WritableSignal<ReturnType<typeof sessionFor> | null> = signal(
    sessionFor('actor'),
  ),
) {
  const providers: Provider[] = [
    {
      provide: AuthStore,
      useValue: {
        request,
        metadata: () => ({ phase: 3 }),
        session,
        interrupted: () => false,
      },
    },
    {
      provide: CustomerStore,
      useValue: { refresh: vi.fn().mockResolvedValue(undefined) },
    },
    {
      provide: ConnectionStore,
      useValue: { refresh: vi.fn().mockResolvedValue(undefined) },
    },
  ];
  TestBed.configureTestingModule({ providers });
  const store = TestBed.inject(UsersStore);
  const feeds = TestBed.inject(LiveFeeds);
  feeds.timeout = 0;
  feeds.reopenDelay = 0;
  store.recountDelay = 0;
  return store;
}

const answer = () =>
  vi.fn((path: string) => Promise.resolve(Response.json(answers[path] ?? {})));

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
  private fire(name: string, data?: string): void {
    for (const listener of this.listeners.get(name) ?? [])
      listener({ data } as unknown as Event);
  }
}

/** Replaces the browser's EventSource before the store opens the stream. */
function streams(store: UsersStore): FakeStream[] {
  const opened: FakeStream[] = [];
  (
    store as unknown as {
      eventSource: (url: string) => UserEventSource;
    }
  ).eventSource = () => {
    const stream = new FakeStream();
    opened.push(stream);
    return stream as unknown as UserEventSource;
  };
  return opened;
}

describe('the users store', () => {
  it('reads the directory status and the attribute categories', async () => {
    const request = answer();
    const store = setup(request);
    streams(store);
    await store.init();
    expect(store.sync()?.customerId).toBe('C0123456');
    expect(store.syncLoaded()).toBe(true);
    expect(store.attributes().map((attribute) => attribute.label)).toEqual([
      'Grade level',
    ]);
    expect(store.orgUnits()).toHaveLength(2);
    store.leave();
  });

  it('denies the status read with a permission message', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({ code: 'forbidden' }, { status: 403 }));
    const store = setup(request);
    expect(await store.loadSync()).toBe(false);
    expect(store.statusError()).toBe(
      'You do not have permission to read users for this customer.',
    );
    expect(store.statusRetryable()).toBe(false);
  });

  it('queries one page with the filters on screen and keeps the counts', async () => {
    const request = answer();
    const store = setup(request);
    const predicates: UserPredicate[] = [
      { field: 'status', operator: 'is', values: ['active'] },
    ];
    store.setPredicates(predicates);
    store.setView({
      predicates,
      sort: { field: 'fullName', direction: 'asc' },
      selection: null,
    });
    const rows = await store.rows(100, 100);
    expect(request).toHaveBeenCalledWith('/api/users/query', {
      predicates,
      sort: { field: 'fullName', direction: 'asc' },
      selection: null,
      offset: 100,
      limit: 100,
    });
    expect(rows?.matching).toBe(96);
    expect(store.page()).toEqual({
      matching: 96,
      total: 450,
      observedAt: '2026-11-16T12:00:00.000Z',
    });
  });

  it('keeps one filter for each field in the same order', () => {
    const store = setup(answer());
    store.setPredicates([
      { field: 'fullName', operator: 'contains', value: 'A' },
      { field: 'status', operator: 'is', values: ['active'] },
    ]);
    // The same filters in another order are the same query.
    store.setPredicates([
      { field: 'status', operator: 'is', values: ['active'] },
      { field: 'fullName', operator: 'contains', value: 'A' },
    ]);
    expect(store.predicates()).toHaveLength(2);
    expect(store.predicates()[0].field).toBe('fullName');
  });

  it('counts the stale users of the counted query', async () => {
    const request = answer();
    const store = setup(request);
    store.setView({
      predicates: [],
      sort: { field: 'fullName', direction: 'asc' },
      selection: null,
    });
    await store.rows(0, 100);
    await store.recount();
    expect(request).toHaveBeenCalledWith('/api/users/freshness', {
      predicates: [],
      selection: null,
    });
    expect(store.freshness()?.stale).toBe(2);
  });

  it('reports a missing category read without failing the grid', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        Response.json({ code: 'connection-unavailable' }, { status: 409 }),
      );
    const store = setup(request);
    await store.loadCategories();
    expect(store.categories()).toBeNull();
    expect(store.categoriesError()).toBe(
      'Custom attribute columns need a Google Workspace connection.',
    );
  });

  it('starts a full sync and takes its status', async () => {
    const request = vi.fn((path: string) =>
      path === '/api/users/sync'
        ? Promise.resolve(
            Response.json({
              sync: sync('running', { startedAt: '2026-11-16T12:00:00.000Z' }),
            }),
          )
        : Promise.resolve(Response.json({})),
    );
    const store = setup(request);
    await store.refreshAll();
    expect(request).toHaveBeenCalledWith('/api/users/sync', {});
    expect(store.sync()?.status).toBe('running');
    expect(store.refreshing()).toBe(true);
  });

  it('keeps the sync of a full-sync event and reloads the rows', async () => {
    answers['/api/users/query'] = { page: page() };
    const store = setup(answer());
    const opened = streams(store);
    await store.init();
    const revision = store.revision();
    const stream = opened[0];
    stream.open();
    stream.send('user-full-sync', {
      type: 'user-full-sync',
      entityType: 'user',
      sync: sync('ready', { observedAt: '2026-11-16T13:00:00.000Z' }),
    });
    expect(store.sync()?.observedAt).toBe('2026-11-16T13:00:00.000Z');
    expect(store.revision()).toBeGreaterThan(revision);
    store.leave();
  });

  it('keeps a selection tab per browser tab', () => {
    const store = setup(answer());
    expect(store.selectionTab).toBe(userSelectionTab());
  });

  it('drops the status answer of a person who signed out (R1)', async () => {
    const first = held<Response>();
    const session = signal(sessionFor('actor'));
    let reads = 0;
    const request = vi.fn((path: string) => {
      if (path === '/api/users/sync') {
        reads++;
        return reads === 1
          ? first.promise
          : Promise.resolve(
              Response.json({ code: 'forbidden' }, { status: 403 }),
            );
      }
      return Promise.resolve(Response.json(answers[path] ?? {}));
    });
    const store = setup(request, session);
    streams(store);
    const loading = store.init();
    // The next person may not read users. Their denial lands before the old answer.
    session.set(sessionFor('second', []));
    TestBed.tick();
    await vi.waitFor(() => expect(reads).toBe(2));
    first.release(Response.json({ sync: sync('ready') }));
    await loading;
    expect(store.sync()).toBeNull();
    expect(store.syncLoaded()).toBe(false);
    expect(store.statusError()).toBe(
      'You do not have permission to read users for this customer.',
    );
  });

  it('keeps a completed sync when an older running answer arrives (R2)', async () => {
    const started = '2026-11-16T12:00:00.000Z';
    const answerLater = sync('ready', {
      startedAt: started,
      observedAt: '2026-11-16T12:05:00.000Z',
      checkedAt: '2026-11-16T12:05:00.000Z',
    });
    const running = sync('running', { startedAt: started });
    const heldRefresh = held<Response>();
    const request = vi.fn((path: string, body?: unknown) => {
      if (path === '/api/users/sync' && body !== undefined)
        return heldRefresh.promise;
      return Promise.resolve(Response.json(answers[path] ?? {}));
    });
    const store = setup(request);
    const opened = streams(store);
    await store.init();
    opened[0].open();
    const refreshing = store.refreshAll();
    opened[0].send('user-full-sync', {
      type: 'user-full-sync',
      entityType: 'user',
      sync: answerLater,
    });
    heldRefresh.release(Response.json({ sync: running }));
    await refreshing;
    expect(store.sync()?.status).toBe('ready');
    expect(store.sync()?.observedAt).toBe(answerLater.observedAt);
    store.leave();
  });

  it('keeps the expired failure of a run over its held running answer (R2)', async () => {
    // The production projection of an expired lease reports Failed with the start
    // of the expired run and the checkedAt of the prior completed run.
    const started = '2026-11-16T12:00:00.000Z';
    const priorChecked = '2026-11-16T11:55:00.000Z';
    const running = sync('running', {
      startedAt: started,
      checkedAt: priorChecked,
    });
    const expired = sync('failed', {
      startedAt: started,
      checkedAt: priorChecked,
      failure: 'interrupted',
    });
    const heldRefresh = held<Response>();
    const request = vi.fn((path: string, body?: unknown) => {
      if (path === '/api/users/sync' && body !== undefined)
        return heldRefresh.promise;
      if (path === '/api/users/sync')
        return Promise.resolve(Response.json({ sync: expired }));
      return Promise.resolve(Response.json(answers[path] ?? {}));
    });
    const store = setup(request);
    const refreshing = store.refreshAll();
    // A later status read learns that the run expired before its start answer lands.
    await store.loadSync();
    expect(store.sync()?.status).toBe('failed');
    heldRefresh.release(Response.json({ sync: running }));
    await refreshing;
    expect(store.sync()?.status).toBe('failed');
    expect(store.sync()?.failure).toBe('interrupted');
    expect(store.refreshing()).toBe(false);
  });

  it('reconciles a completion that landed before the first stream open (R3)', async () => {
    const started = '2026-11-16T12:00:00.000Z';
    const running = sync('running', { startedAt: started });
    const ready = sync('ready', {
      startedAt: started,
      observedAt: '2026-11-16T12:05:00.000Z',
      checkedAt: '2026-11-16T12:05:00.000Z',
    });
    let reads = 0;
    const request = vi.fn((path: string) => {
      if (path === '/api/users/sync') {
        reads++;
        return Promise.resolve(
          Response.json({ sync: reads === 1 ? running : ready }),
        );
      }
      return Promise.resolve(Response.json(answers[path] ?? {}));
    });
    const store = setup(request);
    const opened = streams(store);
    await store.init();
    const revision = store.revision();
    opened[0].open();
    await vi.waitFor(() => expect(store.sync()?.status).toBe('ready'));
    expect(reads).toBe(2);
    expect(store.revision()).toBeGreaterThan(revision);
    store.leave();
  });

  it('keeps the first open of a current status without another read (R3)', async () => {
    let reads = 0;
    const request = vi.fn((path: string) => {
      if (path === '/api/users/sync') reads++;
      return Promise.resolve(Response.json(answers[path] ?? {}));
    });
    const store = setup(request);
    const opened = streams(store);
    await store.init();
    opened[0].open();
    await Promise.resolve();
    expect(reads).toBe(1);
    store.leave();
  });

  it('requeries rows and counts when a batch removes a user (R7)', async () => {
    const request = answer();
    const store = setup(request);
    const opened = streams(store);
    await store.init();
    const row = userRow();
    const node = { group: false, data: row, updateData: vi.fn() };
    store.rowRefresh.attach({
      forEachNode: (callback: (item: typeof node) => void) => callback(node),
      getRowNode: () => node,
    } as never);
    const revision = store.revision();
    opened[0].open();
    opened[0].send('entity-batch', {
      type: 'entity-batch',
      entityType: 'user',
      userIds: [],
      removedIds: [row.userId],
    });
    expect(store.revision()).toBeGreaterThan(revision);
    expect(request).not.toHaveBeenCalledWith(
      '/api/users/by-ids',
      expect.anything(),
      expect.anything(),
    );
    store.leave();
  });

  it('empties the visible selection when the API says it expired (R10)', async () => {
    const request = vi.fn((path: string) => {
      if (path === '/api/users/selection/refresh')
        return Promise.resolve(
          Response.json({ reason: 'selection-expired' }, { status: 409 }),
        );
      return Promise.resolve(Response.json(answers[path] ?? {}));
    });
    const store = setup(request);
    store.selection.spec.set(selectionSpec({ selectedCount: 41 }));
    const revision = store.selectionRevision();
    await store.refreshSelection();
    expect(store.selectedCount()).toBe(0);
    expect(store.selectionRevision()).toBeGreaterThan(revision);
    expect(store.refreshStatus()).toBe(SELECTION_EXPIRED_TEXT);
  });

  it('offers recovery when the status read fails (R11)', async () => {
    const request = vi.fn((path: string) => {
      if (path === '/api/users/sync')
        return Promise.resolve(Response.json({}, { status: 503 }));
      return Promise.resolve(Response.json(answers[path] ?? {}));
    });
    const store = setup(request);
    const opened = streams(store);
    await store.init();
    expect(store.statusError()).toBe('User directory status is unavailable.');
    expect(store.statusRetryable()).toBe(true);
    expect(store.syncLoaded()).toBe(false);
    // The feed follows the stream too, so a full-sync event can recover the page.
    expect(opened).toHaveLength(1);
    store.leave();
  });

  it('names the schema scope when the category read misses it (R11)', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { reason: 'user-schema-read-failed', failure: 'scope-mismatch' },
          { status: 503 },
        ),
      );
    const store = setup(request);
    await store.loadCategories();
    expect(store.categoriesError()).toBe(
      'Custom attribute columns are unavailable. Add https://www.googleapis.com/auth/admin.directory.userschema.readonly to the delegation client in the Google Admin Console.',
    );
    expect(store.categoriesRecovery()).toBe(true);
  });

  it('takes a newer refresh run over the completed run before it (R2)', async () => {
    const first = sync('ready', {
      startedAt: '2026-11-16T12:00:00.000Z',
      observedAt: '2026-11-16T12:05:00.000Z',
      checkedAt: '2026-11-16T12:05:00.000Z',
    });
    const running = sync('running', { startedAt: '2026-11-16T13:00:00.000Z' });
    const request = vi.fn((path: string, body?: unknown) => {
      if (path !== '/api/users/sync')
        return Promise.resolve(Response.json(answers[path] ?? {}));
      // The status read answers the first run, and Refresh Users starts the next one.
      return Promise.resolve(
        Response.json({ sync: body === undefined ? first : running }),
      );
    });
    const store = setup(request);
    await store.loadSync();
    await store.refreshAll();
    expect(store.sync()?.status).toBe('running');
    expect(store.sync()?.startedAt).toBe('2026-11-16T13:00:00.000Z');
    expect(store.refreshing()).toBe(true);
  });

  it('takes a running refresh over a directory that never synced (R2)', async () => {
    const never = sync('never');
    const running = sync('running', { startedAt: '2026-11-16T13:00:00.000Z' });
    const request = vi.fn((path: string, body?: unknown) => {
      if (path !== '/api/users/sync')
        return Promise.resolve(Response.json(answers[path] ?? {}));
      return Promise.resolve(
        Response.json({ sync: body === undefined ? never : running }),
      );
    });
    const store = setup(request);
    await store.loadSync();
    await store.refreshAll();
    expect(store.sync()?.status).toBe('running');
  });

  it('keeps a newer running run when the completion of an older run lands (R2)', async () => {
    const running = sync('running', { startedAt: '2026-11-16T13:00:00.000Z' });
    const older = sync('ready', {
      startedAt: '2026-11-16T12:00:00.000Z',
      observedAt: '2026-11-16T12:05:00.000Z',
      checkedAt: '2026-11-16T12:05:00.000Z',
    });
    const request = vi.fn((path: string) =>
      path === '/api/users/sync'
        ? Promise.resolve(Response.json({ sync: running }))
        : Promise.resolve(Response.json(answers[path] ?? {})),
    );
    const store = setup(request);
    const opened = streams(store);
    await store.init();
    opened[0].open();
    opened[0].send('user-full-sync', {
      type: 'user-full-sync',
      entityType: 'user',
      sync: older,
    });
    expect(store.sync()?.startedAt).toBe('2026-11-16T13:00:00.000Z');
    expect(store.sync()?.status).toBe('running');
    store.leave();
  });

  it('never takes an older connection generation over a newer one (R2)', async () => {
    const current = sync('ready', {
      generation: 2,
      observedAt: '2026-11-16T12:00:00.000Z',
    });
    const older = sync('ready', {
      generation: 1,
      observedAt: '2026-11-16T14:00:00.000Z',
    });
    const request = vi.fn((path: string) =>
      path === '/api/users/sync'
        ? Promise.resolve(Response.json({ sync: current }))
        : Promise.resolve(Response.json(answers[path] ?? {})),
    );
    const store = setup(request);
    const opened = streams(store);
    await store.init();
    opened[0].open();
    opened[0].send('user-full-sync', {
      type: 'user-full-sync',
      entityType: 'user',
      sync: older,
    });
    expect(store.sync()?.generation).toBe(2);
    store.leave();
  });

  it('keeps a dated status when the answer carries no time (R2)', async () => {
    const current = sync('ready', {
      observedAt: '2026-11-16T12:00:00.000Z',
    });
    const undated = sync('ready', { observedAt: null, userCount: 0 });
    const request = vi.fn((path: string) =>
      path === '/api/users/sync'
        ? Promise.resolve(Response.json({ sync: current }))
        : Promise.resolve(Response.json(answers[path] ?? {})),
    );
    const store = setup(request);
    const opened = streams(store);
    await store.init();
    opened[0].open();
    opened[0].send('user-full-sync', {
      type: 'user-full-sync',
      entityType: 'user',
      sync: undated,
    });
    expect(store.sync()?.observedAt).toBe('2026-11-16T12:00:00.000Z');
    store.leave();
  });

  it('shows no matching user for a filter that matches no row (R6)', async () => {
    const store = setup(answer());
    store.setView({
      predicates: [],
      sort: { field: 'fullName', direction: 'asc' },
      selection: null,
    });
    await store.rows(0, 100);
    store.freshness.set(freshness);
    store.setEmptyFilter(true);
    // No row matches, and the district total of the former query stays.
    expect(store.page()).toEqual({
      matching: 0,
      total: 450,
      observedAt: '2026-11-16T12:00:00.000Z',
    });
    expect(store.freshness()).toBeNull();
    // Clear filters recovers from a filter that has no chip and no predicate.
    store.clearFilters();
    expect(store.emptyFilter()).toBe(false);
    expect(store.predicates()).toEqual([]);
  });

  it('clears the chips and the empty filter together (R6)', () => {
    const store = setup(answer());
    store.setPredicates([
      { field: 'status', operator: 'is', values: ['active'] },
    ]);
    store.setEmptyFilter(true);
    store.clearFilters();
    expect(store.predicates()).toEqual([]);
    expect(store.emptyFilter()).toBe(false);
  });

  it('keeps the empty result when an older query answers later (R6)', async () => {
    const heldQuery = held<Response>();
    let queries = 0;
    const request = vi.fn((path: string) => {
      if (path === '/api/users/query') {
        queries++;
        return queries === 2
          ? heldQuery.promise
          : Promise.resolve(Response.json({ page: page() }));
      }
      return Promise.resolve(Response.json(answers[path] ?? {}));
    });
    const store = setup(request);
    const view = (sort: UserView['sort']): UserView => ({
      predicates: [],
      sort,
      selection: null,
    });
    store.setView(view({ field: 'fullName', direction: 'asc' }));
    await store.rows(0, 100);
    expect(store.page()?.total).toBe(450);
    // A sort starts a new query. The empty filter replaces its result meanwhile.
    store.setView(view({ field: 'lastLoginTime', direction: 'desc' }));
    const loading = store.rows(0, 100);
    store.setEmptyFilter(true);
    heldQuery.release(Response.json({ page: page({ matching: 6, total: 6 }) }));
    await loading;
    expect(store.emptyFilter()).toBe(true);
    expect(store.page()).toEqual({
      matching: 0,
      total: 450,
      observedAt: '2026-11-16T12:00:00.000Z',
    });
  });

  it('keeps the empty result when an older freshness answer lands later (R6)', async () => {
    const heldFreshness = held<Response>();
    const request = vi.fn((path: string) =>
      path === '/api/users/freshness'
        ? heldFreshness.promise
        : Promise.resolve(Response.json(answers[path] ?? {})),
    );
    const store = setup(request);
    store.page.set({
      matching: 96,
      total: 450,
      observedAt: '2026-11-16T12:00:00.000Z',
    });
    const counting = store.recount();
    store.setEmptyFilter(true);
    heldFreshness.release(
      Response.json({ freshness: { stale: 3, refreshing: true } }),
    );
    await counting;
    expect(store.freshness()).toBeNull();
    expect(store.page()).toEqual({
      matching: 0,
      total: 450,
      observedAt: '2026-11-16T12:00:00.000Z',
    });
  });

  it('does not count the previous dataset while the empty result holds (R6)', async () => {
    const request = answer();
    const store = setup(request);
    const opened = streams(store);
    await store.init();
    await store.rows(0, 100);
    store.setEmptyFilter(true);
    const counts = () =>
      request.mock.calls.filter(([path]) => path === '/api/users/freshness')
        .length;
    const before = counts();
    // An entity event recounts the counted query. The empty result queries nothing.
    opened[0].send('entity-batch', {
      type: 'entity-batch',
      entityType: 'user',
      userIds: [],
      removedIds: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(counts()).toBe(before);
    expect(store.page()).toEqual({
      matching: 0,
      total: 450,
      observedAt: '2026-11-16T12:00:00.000Z',
    });
    expect(store.freshness()).toBeNull();
    store.leave();
  });

  it('keeps the empty count when the grid reports the empty filter again (R6)', () => {
    const store = setup(answer());
    store.page.set({
      matching: 96,
      total: 450,
      observedAt: '2026-11-16T12:00:00.000Z',
    });
    store.freshness.set(freshness);
    store.setEmptyFilter(true);
    // A later publication put the former dataset back. The repeated notice restores zero.
    store.page.set({
      matching: 6,
      total: 6,
      observedAt: '2026-11-16T12:00:00.000Z',
    });
    store.freshness.set(freshness);
    store.setEmptyFilter(true);
    expect(store.page()).toEqual({
      matching: 0,
      total: 450,
      observedAt: '2026-11-16T12:00:00.000Z',
    });
    expect(store.freshness()).toBeNull();
  });

  it('recovers the counts and freshness when the empty filter clears (R6)', async () => {
    const request = answer();
    const store = setup(request);
    await store.rows(0, 100);
    store.setEmptyFilter(true);
    store.setEmptyFilter(false);
    await store.rows(0, 100);
    expect(store.page()?.matching).toBe(96);
    await vi.waitFor(() => expect(store.freshness()?.stale).toBe(2));
  });
});
