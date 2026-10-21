import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  JobDetail,
  JobOperation,
  JobOperationsPage,
} from '@campus/application-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { JobDetailStore } from './job-detail.store';
import type { JobEventSource } from './job-stream';

const jobId = '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'District Admin',
};

const detail = (overrides: Partial<JobDetail> = {}): JobDetail => ({
  jobId,
  displayId: 'UPD-006',
  revision: 4,
  action: 'update-device-annotations',
  status: 'needs-review',
  scope: { kind: 'devices', deviceCount: 6 },
  requestedBy: person,
  createdAt: '2026-10-19T10:31:00.000Z',
  startedAt: '2026-10-19T10:31:00.000Z',
  finishedAt: '2026-10-19T10:36:02.000Z',
  progress: {
    total: 6,
    succeeded: 4,
    failed: 1,
    unknown: 1,
    skipped: 0,
    expired: 0,
    pending: 0,
  },
  failure: null,
  confirmedBy: person,
  previewDisplayId: 'PV-006',
  field: 'annotatedLocation',
  mode: 'replace',
  commandType: null,
  statusAction: null,
  requestedValue: 'North lab',
  targetOrgUnitPaths: ['/School A'],
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: '2026-10-19T10:36:00.000Z',
    failed: { count: 1, operations: [] },
    unknown: { count: 1, operations: [] },
  },
  ...overrides,
});

const operation = (overrides: Partial<JobOperation> = {}): JobOperation => ({
  operationId: 'UPD-006-6',
  deviceId: 'synthetic-device-6',
  serialNumber: 'C0A1-7F84',
  orgUnitPath: '/School A',
  operation: 'replace',
  baselineValue: 'Science wing',
  requestedValue: 'North lab',
  outcome: 'unknown',
  outcomeReason: null,
  googleStatus: null,
  googleReason: null,
  observedValue: null,
  verifiedBy: null,
  commandId: null,
  commandState: null,
  commandExpiresAt: null,
  commandExecutedAt: null,
  updatedAt: '2026-10-19T10:36:00.000Z',
  ...overrides,
});

const operationsPage = (
  operations: JobOperation[] = [operation()],
  nextCursor: string | null = null,
): JobOperationsPage => ({ operations, nextCursor });

const sessionFor = (id: string) => ({
  identity: {
    id,
    displayName: 'District Admin',
    permissionVersion: 1,
    permissions: [],
    grants: [
      {
        action: 'jobs:read',
        scope: { kind: 'district', customerId: 'C0123456' },
      },
    ],
    preferences: { theme: 'light', navigationCollapsed: false },
  },
  csrfToken: 'a'.repeat(64),
  expiresAt: '2026-10-20T12:00:00.000Z',
});

class FakeStream {
  readyState = 0;
  readonly listeners = new Map<
    string,
    ((event: MessageEvent<string>) => void)[]
  >();
  addEventListener(
    name: string,
    listener: (event: MessageEvent<string>) => void,
  ) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  close(): void {
    this.readyState = 2;
  }
  emit(
    name: string,
    event: MessageEvent<string> = new MessageEvent(name),
  ): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

function setup(
  request: (path: string, body?: unknown) => Promise<Response> = async (
    path,
  ) =>
    path.includes('/operations')
      ? Response.json(operationsPage())
      : Response.json(detail()),
  session: WritableSignal<ReturnType<typeof sessionFor> | null> = signal(
    sessionFor(person.id),
  ),
) {
  const stream = new FakeStream();
  const requestMock = vi.fn(request);
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AuthStore,
        useValue: {
          session,
          metadata: signal({ phase: 3 }),
          request: requestMock,
        },
      },
    ],
  });
  const store = TestBed.inject(JobDetailStore);
  store.eventSource = () => stream as unknown as JobEventSource;
  return { store, stream, requestMock, session };
}

const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

it('reads the job, Latest activity, and the first operations page', async () => {
  const { store, stream, requestMock } = setup();
  await store.init('UPD-006');
  expect(stream.listeners.has('job-changed')).toBe(true);
  expect(requestMock.mock.calls[0][0]).toBe('/api/jobs/UPD-006');
  expect(requestMock.mock.calls[1][0]).toBe(
    '/api/jobs/UPD-006/operations?limit=6',
  );
  expect(store.job()?.displayId).toBe('UPD-006');
  expect(store.operations()).toHaveLength(1);
  expect(store.loading()).toBe(false);
  expect(store.loaded()).toBe(true);
  expect(store.error()).toBe('');
});

it('reads with attention=true and clears it again', async () => {
  const { store, requestMock } = setup();
  await store.init('UPD-006');
  requestMock.mockClear();
  store.setAttention(true);
  await vi.waitFor(() => expect(store.reading()).toBe(false));
  expect(requestMock.mock.calls[1][0]).toBe(
    '/api/jobs/UPD-006/operations?attention=true&limit=6',
  );
  expect(store.attention()).toBe(true);
  expect(store.operations()).toHaveLength(1);

  requestMock.mockClear();
  store.setAttention(false);
  await vi.waitFor(() => expect(store.reading()).toBe(false));
  expect(requestMock.mock.calls[1][0]).toBe(
    '/api/jobs/UPD-006/operations?limit=6',
  );
});

it('pages with the operations cursor and back', async () => {
  const { store, requestMock } = setup(async (path) => {
    if (!path.includes('/operations')) return Response.json(detail());
    return path.includes('cursor=6')
      ? Response.json(
          operationsPage([operation({ operationId: 'UPD-006-12' })], null),
        )
      : Response.json(operationsPage([operation()], '6'));
  });
  await store.init('UPD-006');
  expect(store.hasNext()).toBe(true);
  expect(store.hasPrevious()).toBe(false);

  store.next();
  await vi.waitFor(() => expect(store.shownIndex()).toBe(1));
  expect(
    requestMock.mock.calls.some(([path]) => path.includes('cursor=6')),
  ).toBe(true);
  expect(store.operations()[0].operationId).toBe('UPD-006-12');
  expect(store.hasPrevious()).toBe(true);
  expect(store.hasNext()).toBe(false);

  store.previous();
  await vi.waitFor(() => expect(store.shownIndex()).toBe(0));
  expect(store.operations()[0].operationId).toBe('UPD-006-6');
});

it('ignores another job event and reads on a higher revision after 250 ms', async () => {
  vi.useFakeTimers();
  const { store, stream, requestMock } = setup();
  await store.init('UPD-006');
  await flush();
  const before = requestMock.mock.calls.length;

  stream.emit(
    'job-changed',
    new MessageEvent('job-changed', {
      data: JSON.stringify({
        type: 'job-changed',
        jobId: '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
        displayId: 'UPD-007',
        revision: 9,
        requestedBy: person.id,
      }),
    }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(requestMock).toHaveBeenCalledTimes(before);

  stream.emit(
    'job-changed',
    new MessageEvent('job-changed', {
      data: JSON.stringify({
        type: 'job-changed',
        jobId,
        displayId: 'UPD-006',
        revision: 4,
        requestedBy: person.id,
      }),
    }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(requestMock).toHaveBeenCalledTimes(before);

  stream.emit(
    'job-changed',
    new MessageEvent('job-changed', {
      data: JSON.stringify({
        type: 'job-changed',
        jobId,
        displayId: 'UPD-006',
        revision: 5,
        requestedBy: person.id,
      }),
    }),
  );
  await vi.advanceTimersByTimeAsync(249);
  expect(requestMock).toHaveBeenCalledTimes(before);
  await vi.advanceTimersByTimeAsync(1);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(before + 2);
});

it('reads on every stream open', async () => {
  vi.useFakeTimers();
  const { store, stream, requestMock } = setup();
  await store.init('UPD-006');
  await flush();
  const before = requestMock.mock.calls.length;
  stream.emit('open');
  await vi.advanceTimersByTimeAsync(250);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(before + 2);
});

it('keeps the job visible when the operations read fails', async () => {
  const { store } = setup(async (path) =>
    path.includes('/operations')
      ? new Response(null, { status: 500 })
      : Response.json(detail()),
  );
  await store.init('UPD-006');
  expect(store.job()?.displayId).toBe('UPD-006');
  expect(store.loaded()).toBe(true);
  expect(store.operations()).toHaveLength(0);
  expect(store.operationsError()).toBe('Operation results are unavailable.');
  expect(store.stale()).toBe(false);
  store.leave();
});

it('shows the missing state for a 404 job and stops reading', async () => {
  vi.useFakeTimers();
  const { store, requestMock } = setup(
    async () => new Response(null, { status: 404 }),
  );
  await store.init('UPD-006');
  await flush();
  expect(store.missing()).toBe(true);
  expect(store.job()).toBeNull();
  expect(store.loading()).toBe(false);
  expect(store.error()).toBe('');
  await vi.advanceTimersByTimeAsync(10_000);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(1);
});

it('keeps the last job state and marks it offline after a network failure', async () => {
  vi.useFakeTimers();
  let offline = false;
  const { store } = setup(async (path) => {
    if (offline) throw new Error('offline');
    return path.includes('/operations')
      ? Response.json(operationsPage())
      : Response.json(detail());
  });
  await store.init('UPD-006');
  await flush();
  offline = true;
  await store.refresh();
  expect(store.offline()).toBe(true);
  expect(store.stale()).toBe(false);
  expect(store.job()?.displayId).toBe('UPD-006');
  store.leave();
});

it('shows unavailable when the first job read fails', async () => {
  const { store } = setup(async () => {
    throw new Error('offline');
  });
  await store.init('UPD-006');
  expect(store.loading()).toBe(false);
  expect(store.missing()).toBe(false);
  expect(store.error()).toBe('Job details are unavailable.');
  expect(store.offline()).toBe(true);
  store.leave();
});

it('retries a failed read after 5 s', async () => {
  vi.useFakeTimers();
  let fail = true;
  const { store, requestMock } = setup(async (path) => {
    if (fail) throw new Error('network');
    return path.includes('/operations')
      ? Response.json(operationsPage())
      : Response.json(detail());
  });
  await store.init('UPD-006');
  await flush();
  const before = requestMock.mock.calls.length;
  fail = false;
  await vi.advanceTimersByTimeAsync(4999);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(before);
  await vi.advanceTimersByTimeAsync(1);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(before + 2);
  expect(store.job()?.displayId).toBe('UPD-006');
});

describe('Reconcile', () => {
  it('marks the row as reconciling after a 202 and clears it on the next read', async () => {
    const { store } = setup(async (path, body) => {
      if (body !== undefined) return new Response(null, { status: 202 });
      return path.includes('/operations')
        ? Response.json(operationsPage())
        : Response.json(detail());
    });
    await store.init('UPD-006');
    await store.reconcile(operation());
    expect(store.reconciling().has('UPD-006-6')).toBe(true);
    expect(store.notice()).toBe('Reconcile started for C0A1-7F84.');
    expect(store.reconcileError()).toBe('');

    await store.refresh();
    expect(store.reconciling().has('UPD-006-6')).toBe(false);
    expect(store.notice()).toBe('');
  });

  it('reads the job again after a 409 operation-settled answer', async () => {
    let settled = false;
    const { store, requestMock } = setup(async (path, body) => {
      if (body !== undefined) {
        settled = true;
        return Response.json({ reason: 'operation-settled' }, { status: 409 });
      }
      return path.includes('/operations')
        ? Response.json(operationsPage())
        : Response.json(detail());
    });
    await store.init('UPD-006');
    const before = requestMock.mock.calls.length;
    await store.reconcile(operation());
    expect(settled).toBe(true);
    expect(store.reconciling().has('UPD-006-6')).toBe(false);
    expect(store.notice()).toBe(
      'The operation settled. Reading the job again.',
    );
    expect(requestMock.mock.calls.length).toBeGreaterThan(before + 1);
  });

  it('shows a permission message after a 403 answer', async () => {
    const { store } = setup(async (path, body) =>
      body !== undefined
        ? new Response(null, { status: 403 })
        : path.includes('/operations')
          ? Response.json(operationsPage())
          : Response.json(detail()),
    );
    await store.init('UPD-006');
    await store.reconcile(operation());
    expect(store.reconcileError()).toBe(
      'You do not have permission to reconcile this operation.',
    );
    expect(store.reconciling().has('UPD-006-6')).toBe(false);
  });

  it('shows a message for an unexpected answer', async () => {
    const { store } = setup(async (path, body) =>
      body !== undefined
        ? new Response(null, { status: 500 })
        : path.includes('/operations')
          ? Response.json(operationsPage())
          : Response.json(detail()),
    );
    await store.init('UPD-006');
    await store.reconcile(operation());
    expect(store.reconcileError()).toBe(
      'Reconcile could not start. Try again.',
    );
  });

  it('shows an offline message when the request cannot reach the server', async () => {
    const { store } = setup(async (path, body) => {
      if (body !== undefined) throw new Error('offline');
      return path.includes('/operations')
        ? Response.json(operationsPage())
        : Response.json(detail());
    });
    await store.init('UPD-006');
    await store.reconcile(operation());
    expect(store.reconcileError()).toBe(
      'Cannot reach Campus Commander. Reconcile did not start.',
    );
    expect(store.reconciling().has('UPD-006-6')).toBe(false);
  });
});

it('leaves the page and stops the stream', async () => {
  const { store, stream } = setup();
  await store.init('UPD-006');
  store.leave();
  expect(stream.readyState).toBe(2);
});

describe('principal boundary', () => {
  const otherPerson = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('clears the previous person data before another person reads', async () => {
    const session = signal<ReturnType<typeof sessionFor> | null>(
      sessionFor(person.id),
    );
    const pending: ((response: Response) => void)[] = [];
    const { store } = setup(
      () => new Promise<Response>((resolve) => pending.push(resolve)),
      session,
    );
    TestBed.tick();
    const init = store.init('UPD-006');
    await flush();
    expect(pending).toHaveLength(1);
    pending[0](Response.json(detail()));
    await flush();
    pending[1](Response.json(operationsPage()));
    await init;
    expect(store.job()?.displayId).toBe('UPD-006');
    expect(store.operations()).toHaveLength(1);
    expect(store.loaded()).toBe(true);

    session.set(null);
    TestBed.tick();
    session.set(sessionFor(otherPerson));
    TestBed.tick();
    // The previous person's job, rows, and revision baseline are gone before the read.
    expect(store.job()).toBeNull();
    expect(store.operations()).toHaveLength(0);
    expect(store.loaded()).toBe(false);
    expect(store.loading()).toBe(true);
    expect(pending).toHaveLength(3);

    pending[2](new Response(null, { status: 500 }));
    await vi.waitFor(() => expect(store.loading()).toBe(false));
    expect(store.job()).toBeNull();
    expect(store.error()).toBe('Job details are unavailable.');
  });

  it('rejects the previous person held answer', async () => {
    const session = signal<ReturnType<typeof sessionFor> | null>(
      sessionFor(person.id),
    );
    const pending: ((response: Response) => void)[] = [];
    const { store } = setup(
      () => new Promise<Response>((resolve) => pending.push(resolve)),
      session,
    );
    TestBed.tick();
    const init = store.init('UPD-006');
    await flush();
    expect(pending).toHaveLength(1);

    session.set(null);
    TestBed.tick();
    session.set(sessionFor(otherPerson));
    TestBed.tick();
    expect(store.job()).toBeNull();

    // The previous person's detail answer arrives after the next person signed in.
    pending[0](Response.json(detail()));
    await flush();
    expect(store.job()).toBeNull();
    expect(store.loaded()).toBe(false);
    expect(store.loading()).toBe(true);
    expect(pending).toHaveLength(2);

    pending[1](new Response(null, { status: 500 }));
    await vi.waitFor(() => expect(store.loading()).toBe(false));
    expect(store.job()).toBeNull();
    await init;
  });

  it('keeps the state while the same person resumes', async () => {
    const session = signal<ReturnType<typeof sessionFor> | null>(
      sessionFor(person.id),
    );
    const { store, requestMock } = setup(undefined, session);
    TestBed.tick();
    await store.init('UPD-006');
    const reads = requestMock.mock.calls.length;

    session.set(null);
    TestBed.tick();
    session.set(sessionFor(person.id));
    TestBed.tick();
    expect(store.job()?.displayId).toBe('UPD-006');
    expect(store.operations()).toHaveLength(1);
    // The resumed session rereads on the next stream open only.
    expect(requestMock.mock.calls.length).toBe(reads);
  });
});

describe('operations query boundary', () => {
  it('drops an unfiltered operations answer after attention changes', async () => {
    let hold = false;
    let failDetail = false;
    const pages: ((response: Response) => void)[] = [];
    const { store } = setup(async (path) => {
      if (path.includes('/operations')) {
        if (hold)
          return new Promise<Response>((resolve) => pages.push(resolve));
        return Response.json(operationsPage([operation()], '6'));
      }
      return failDetail
        ? new Response(null, { status: 500 })
        : Response.json(detail());
    });
    await store.init('UPD-006');
    expect(store.operations()).toHaveLength(1);
    expect(store.nextCursor()).toBe('6');

    hold = true;
    const refreshing = store.refresh();
    await flush();
    expect(pages).toHaveLength(1);

    store.setAttention(true);
    failDetail = true;
    pages[0](Response.json(operationsPage([operation()], '6')));
    await refreshing;
    await vi.waitFor(() => expect(store.reading()).toBe(false));

    // The obsolete answer does not restore the unfiltered rows or its cursor.
    expect(store.attention()).toBe(true);
    expect(store.operations()).toHaveLength(0);
    expect(store.nextCursor()).toBeNull();
    expect(store.shownIndex()).toBe(0);
    expect(store.job()?.displayId).toBe('UPD-006');
    expect(store.stale()).toBe(true);
  });

  it('does not restore the old page index or cursor after attention changes', async () => {
    let hold = false;
    let failDetail = false;
    const pages: ((response: Response) => void)[] = [];
    const { store } = setup(async (path) => {
      if (path.includes('/operations')) {
        if (hold)
          return new Promise<Response>((resolve) => pages.push(resolve));
        return path.includes('cursor=6')
          ? Response.json(
              operationsPage([operation({ operationId: 'UPD-006-7' })], null),
            )
          : Response.json(operationsPage([operation()], '6'));
      }
      return failDetail
        ? new Response(null, { status: 500 })
        : Response.json(detail());
    });
    await store.init('UPD-006');
    store.next();
    await vi.waitFor(() => expect(store.shownIndex()).toBe(1));
    expect(store.hasPrevious()).toBe(true);

    hold = true;
    const refreshing = store.refresh();
    await flush();
    expect(pages).toHaveLength(1);
    store.setAttention(true);
    failDetail = true;
    pages[0](
      Response.json(
        operationsPage([operation({ operationId: 'UPD-006-7' })], null),
      ),
    );
    await refreshing;
    await vi.waitFor(() => expect(store.reading()).toBe(false));

    expect(store.shownIndex()).toBe(0);
    expect(store.hasPrevious()).toBe(false);
    expect(store.operations()).toHaveLength(0);
  });
});

describe('Reconcile concurrency', () => {
  it('keeps a 202 mark when a read completes before the answer', async () => {
    const held: ((response: Response) => void)[] = [];
    const { store } = setup(async (path, body) => {
      if (body !== undefined)
        return new Promise<Response>((resolve) => held.push(resolve));
      return path.includes('/operations')
        ? Response.json(operationsPage())
        : Response.json(detail());
    });
    await store.init('UPD-006');
    const reconciling = store.reconcile(operation());
    await flush();
    expect(store.reconciling().has('UPD-006-6')).toBe(true);

    // A read that finishes while the request is held must not clear the mark.
    await store.refresh();
    expect(store.reconciling().has('UPD-006-6')).toBe(true);

    held[0](new Response(null, { status: 202 }));
    await reconciling;
    expect(store.reconciling().has('UPD-006-6')).toBe(true);
    expect(store.notice()).toBe('Reconcile started for C0A1-7F84.');

    // A later completed read clears the accepted mark and its notice.
    await store.refresh();
    expect(store.reconciling().has('UPD-006-6')).toBe(false);
    expect(store.notice()).toBe('');
  });

  it('keeps accepted marks independent for two operations', async () => {
    const held: ((response: Response) => void)[] = [];
    const { store } = setup(async (path, body) => {
      if (body !== undefined)
        return new Promise<Response>((resolve) => held.push(resolve));
      return path.includes('/operations')
        ? Response.json(operationsPage())
        : Response.json(detail());
    });
    await store.init('UPD-006');
    const first = store.reconcile(operation());
    await flush();
    await store.refresh();
    held[0](new Response(null, { status: 202 }));
    await first;

    const second = store.reconcile(operation({ operationId: 'UPD-006-7' }));
    await flush();
    expect(store.reconciling().has('UPD-006-6')).toBe(true);
    expect(store.reconciling().has('UPD-006-7')).toBe(true);

    // The read clears the first accepted mark only. The second request is held.
    await store.refresh();
    expect(store.reconciling().has('UPD-006-6')).toBe(false);
    expect(store.reconciling().has('UPD-006-7')).toBe(true);

    held[1](new Response(null, { status: 202 }));
    await second;
    expect(store.reconciling().has('UPD-006-6')).toBe(false);
    expect(store.reconciling().has('UPD-006-7')).toBe(true);

    await store.refresh();
    expect(store.reconciling().has('UPD-006-7')).toBe(false);
  });

  it('drops a held answer after the route opens another job', async () => {
    const otherJobId = '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
    const held: ((response: Response) => void)[] = [];
    const { store } = setup(async (path, body) => {
      if (body !== undefined)
        return new Promise<Response>((resolve) => held.push(resolve));
      if (path.includes('/operations')) return Response.json(operationsPage());
      return path.includes('UPD-014')
        ? Response.json(
            detail({ displayId: 'UPD-014', jobId: otherJobId, revision: 1 }),
          )
        : Response.json(detail());
    });
    await store.init('UPD-006');
    const reconciling = store.reconcile(operation());
    await flush();
    await store.init('UPD-014');
    expect(store.displayId()).toBe('UPD-014');

    held[0](new Response(null, { status: 202 }));
    await reconciling;
    expect(store.notice()).toBe('');
    expect(store.reconciling()).toHaveLength(0);
  });

  it('does not read again when a held 409 answers after leave', async () => {
    const held: ((response: Response) => void)[] = [];
    const { store, requestMock } = setup(async (path, body) => {
      if (body !== undefined)
        return new Promise<Response>((resolve) => held.push(resolve));
      return path.includes('/operations')
        ? Response.json(operationsPage())
        : Response.json(detail());
    });
    await store.init('UPD-006');
    const reconciling = store.reconcile(operation());
    await flush();
    store.leave();
    const reads = requestMock.mock.calls.length;

    held[0](Response.json({ reason: 'operation-settled' }, { status: 409 }));
    await reconciling;
    await flush();
    expect(requestMock.mock.calls.length).toBe(reads);
    expect(store.notice()).toBe('');
    expect(store.reconciling()).toHaveLength(0);
  });

  it('reads the job again after a 404 answer', async () => {
    const { store, requestMock } = setup(async (path, body) => {
      if (body !== undefined) return new Response(null, { status: 404 });
      return path.includes('/operations')
        ? Response.json(operationsPage())
        : Response.json(detail());
    });
    await store.init('UPD-006');
    const before = requestMock.mock.calls.length;
    await store.reconcile(operation());
    expect(store.reconcileError()).toBe(
      'This job or operation no longer exists.',
    );
    expect(store.reconciling().has('UPD-006-6')).toBe(false);
    expect(requestMock.mock.calls.length).toBeGreaterThan(before + 1);
    expect(store.job()?.displayId).toBe('UPD-006');
  });

  it('does not clear a newer request mark when an abandoned answer arrives', async () => {
    const held: ((response: Response) => void)[] = [];
    const { store } = setup(async (path, body) => {
      if (body !== undefined)
        return new Promise<Response>((resolve) => held.push(resolve));
      return path.includes('/operations')
        ? Response.json(operationsPage())
        : Response.json(detail());
    });
    await store.init('UPD-006');
    const first = store.reconcile(operation());
    await flush();
    store.leave();

    // A new mount starts its own request for the same operation.
    await store.init('UPD-006');
    const second = store.reconcile(operation());
    await flush();
    expect(store.reconciling().has('UPD-006-6')).toBe(true);

    // The abandoned request terminates. It must not clear the newer mark or notice.
    held[0](new Response(null, { status: 202 }));
    await first;
    expect(store.reconciling().has('UPD-006-6')).toBe(true);
    expect(store.notice()).toBe('');

    held[1](new Response(null, { status: 202 }));
    await second;
    expect(store.reconciling().has('UPD-006-6')).toBe(true);
    expect(store.notice()).toBe('Reconcile started for C0A1-7F84.');

    await store.refresh();
    expect(store.reconciling().has('UPD-006-6')).toBe(false);
  });
});

describe('Reconcile interruption', () => {
  it('releases a terminated request mark when a 401 interrupts the session', async () => {
    const session = signal<ReturnType<typeof sessionFor> | null>(
      sessionFor(person.id),
    );
    // AuthStore clears the session before it returns 401 (auth.store.ts:159-183).
    const { store, requestMock } = setup(async (path, body) => {
      if (body !== undefined) {
        session.set(null);
        return new Response(null, { status: 401 });
      }
      return path.includes('/operations')
        ? Response.json(operationsPage())
        : Response.json(detail());
    }, session);
    TestBed.tick();
    await store.init('UPD-006');
    await store.reconcile(operation());
    // The request terminated without acceptance, so no orphan mark remains.
    expect(store.reconciling().has('UPD-006-6')).toBe(false);
    expect(store.notice()).toBe('');
    expect(store.reconcileError()).toBe('');

    // The session is interrupted, then the same person recovers.
    TestBed.tick();
    expect(store.job()?.displayId).toBe('UPD-006');
    session.set(sessionFor(person.id));
    TestBed.tick();

    const before = requestMock.mock.calls.length;
    await store.refresh();
    expect(requestMock.mock.calls.length).toBeGreaterThan(before);
    // The operation still reads as unknown, and Reconcile is offered again.
    expect(store.operations()).toHaveLength(1);
    expect(store.operations()[0].outcome).toBe('unknown');
    expect(store.reconciling().has('UPD-006-6')).toBe(false);
  });

  it('releases a held request that terminates while the session is interrupted', async () => {
    const session = signal<ReturnType<typeof sessionFor> | null>(
      sessionFor(person.id),
    );
    const held: ((response: Response) => void)[] = [];
    const { store } = setup(async (path, body) => {
      if (body !== undefined)
        return new Promise<Response>((resolve) => held.push(resolve));
      return path.includes('/operations')
        ? Response.json(operationsPage())
        : Response.json(detail());
    }, session);
    TestBed.tick();
    await store.init('UPD-006');
    const reconciling = store.reconcile(operation());
    await flush();
    expect(store.reconciling().has('UPD-006-6')).toBe(true);

    session.set(null);
    TestBed.tick();
    held[0](new Response(null, { status: 202 }));
    await reconciling;
    // The answer arrived after the session ended, so it cannot mark this page.
    expect(store.reconciling().has('UPD-006-6')).toBe(false);
    expect(store.notice()).toBe('');

    session.set(sessionFor(person.id));
    TestBed.tick();
    await store.refresh();
    expect(store.reconciling().has('UPD-006-6')).toBe(false);
    expect(store.operations()[0].outcome).toBe('unknown');
  });
});
