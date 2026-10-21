import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { JobActivity, JobSummary } from '@campus/application-contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthStore } from '../auth.store';
import {
  ACTIVITY_EXPIRY_FLOOR_MS,
  JobActivityStore,
} from './job-activity.store';
import type { JobEventSource } from './job-stream';

const customerId = 'C0123456';
const maya = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const alex = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const mayaJob = '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const alexJob = '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';

const sessionFor = (id: string, grants = ['jobs:read']) => ({
  identity: {
    id,
    displayName: id === alex ? 'Alex Rivera' : 'Maya Chen',
    permissionVersion: 1,
    permissions: [],
    grants: grants.map((action) => ({
      action,
      scope: { kind: 'district', customerId },
    })),
    preferences: { theme: 'light', navigationCollapsed: false },
  },
  csrfToken: 'a'.repeat(64),
  expiresAt: '2026-10-20T12:00:00.000Z',
});

const job = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  jobId: mayaJob,
  displayId: 'UPD-014',
  revision: 1,
  action: 'update-device-annotations',
  status: 'running',
  scope: { kind: 'devices', deviceCount: 48 },
  requestedBy: {
    id: maya,
    displayName: 'Maya Chen',
  },
  createdAt: '2026-10-19T12:00:00.000Z',
  startedAt: '2026-10-19T12:00:00.000Z',
  finishedAt: null,
  progress: {
    total: 48,
    succeeded: 36,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    pending: 12,
  },
  failure: null,
  ...overrides,
});

const activity = (overrides: Partial<JobActivity> = {}): JobActivity => ({
  running: { count: 0, jobs: [] },
  waiting: { count: 0, jobs: [] },
  recent: { count: 0, jobs: [], nextExpiryAt: null },
  attention: false,
  seenAt: null,
  observedAt: '2026-10-19T12:00:00.000Z',
  ...overrides,
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
  request: (path: string) => Promise<Response> = async () =>
    Response.json(activity()),
  session: WritableSignal<ReturnType<typeof sessionFor> | null> = signal(
    sessionFor(maya),
  ),
) {
  const stream = new FakeStream();
  const requestMock = vi.fn(request);
  const openSource = vi.fn(() => stream as unknown as JobEventSource);
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
  const store = TestBed.inject(JobActivityStore);
  store.eventSource = openSource;
  TestBed.tick();
  return { store, stream, requestMock, openSource, session };
}

const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

const changed = (revision: number, jobId = mayaJob) =>
  new MessageEvent('job-changed', {
    data: JSON.stringify({
      type: 'job-changed',
      jobId,
      displayId: 'UPD-014',
      revision,
      requestedBy: maya,
    }),
  });

afterEach(() => {
  vi.useRealTimers();
});

it('reads the activity summary and exposes the badge and the dot', async () => {
  const { store, requestMock, openSource } = setup(async () =>
    Response.json(
      activity({
        running: { count: 2, jobs: [job()] },
        attention: true,
      }),
    ),
  );
  await vi.waitFor(() => expect(store.loaded()).toBe(true));
  expect(requestMock).toHaveBeenCalledWith('/api/jobs/activity');
  expect(openSource).toHaveBeenCalledWith('/api/jobs/events');
  expect(store.runningCount()).toBe(2);
  expect(store.attention()).toBe(true);
  expect(store.loading()).toBe(false);
});

it('names an unreachable first read on the panel', async () => {
  const { store } = setup(() =>
    Promise.reject(new TypeError('Failed to fetch')),
  );
  await flush();
  expect(store.summary()).toBeNull();
  expect(store.loaded()).toBe(false);
  expect(store.error()).toBe(
    'Cannot reach Campus Commander. Activity is unavailable.',
  );
});

it('starts no read and no stream without jobs:read', async () => {
  const { requestMock, openSource } = setup(
    undefined,
    signal(sessionFor(maya, ['schools:read'])),
  );
  await flush();
  expect(requestMock).not.toHaveBeenCalled();
  expect(openSource).not.toHaveBeenCalled();
});

it('moves the badge after a relayed job-changed event without a reconnect', async () => {
  vi.useFakeTimers();
  let running = 1;
  const { store, stream, requestMock, openSource } = setup(async () =>
    Response.json(
      activity({
        running: { count: running, jobs: [job({ revision: running + 1 })] },
      }),
    ),
  );
  await flush();
  expect(store.runningCount()).toBe(1);
  const reads = requestMock.mock.calls.length;
  expect(openSource).toHaveBeenCalledTimes(1);

  running = 0;
  stream.emit('job-changed', changed(5));
  await vi.advanceTimersByTimeAsync(249);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(reads);
  await vi.advanceTimersByTimeAsync(1);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(reads + 1);
  expect(store.runningCount()).toBe(0);
  // No reconnect took part.
  expect(openSource).toHaveBeenCalledTimes(1);
});

it('rereads after a reconnect open', async () => {
  vi.useFakeTimers();
  const { store, stream, requestMock } = setup();
  await flush();
  const reads = requestMock.mock.calls.length;
  stream.emit('open');
  expect(store.live()).toBe(true);
  await vi.advanceTimersByTimeAsync(250);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(reads + 1);
});

it('ends live updates while the stream reconnects and rereads on the next open', async () => {
  vi.useFakeTimers();
  const { store, stream, requestMock, openSource } = setup();
  await flush();
  stream.emit('open');
  expect(store.live()).toBe(true);
  const reads = requestMock.mock.calls.length;

  // A lost connection leaves a native EventSource in CONNECTING (readyState 0).
  stream.readyState = 0;
  stream.emit('error');
  expect(store.live()).toBe(false);
  // The browser keeps its own retry. No close and no client reopen take part.
  expect(openSource).toHaveBeenCalledTimes(1);

  stream.emit('open');
  expect(store.live()).toBe(true);
  await vi.advanceTimersByTimeAsync(250);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(reads + 1);
  expect(openSource).toHaveBeenCalledTimes(1);
});

it('clears the dot after seen succeeds, without an event or a reconnect', async () => {
  vi.useFakeTimers();
  let attention = true;
  const failed = job({
    displayId: 'UPD-002',
    status: 'failed',
    finishedAt: '2026-10-19T11:58:00.000Z',
  });
  const { store, requestMock, openSource } = setup(async (path) =>
    path === '/api/jobs/activity/seen'
      ? Response.json({ seenAt: '2026-10-19T12:00:05.000Z' })
      : Response.json(
          activity({
            attention,
            recent: { count: 1, jobs: [failed], nextExpiryAt: null },
          }),
        ),
  );
  await flush();
  expect(store.attention()).toBe(true);
  const reads = requestMock.mock.calls.filter(
    ([path]) => path === '/api/jobs/activity',
  ).length;

  attention = false;
  await store.seen();
  expect(requestMock).toHaveBeenCalledWith('/api/jobs/activity/seen', {});
  expect(store.attention()).toBe(true);
  await vi.advanceTimersByTimeAsync(250);
  await flush();
  expect(store.attention()).toBe(false);
  expect(
    requestMock.mock.calls.filter(([path]) => path === '/api/jobs/activity'),
  ).toHaveLength(reads + 1);
  expect(openSource).toHaveBeenCalledTimes(1);
});

it('leaves the dot after a failed seen request and sends it again next time', async () => {
  let seenCalls = 0;
  const { store } = setup(async (path) => {
    if (path !== '/api/jobs/activity/seen')
      return Response.json(activity({ attention: true }));
    seenCalls++;
    return new Response(null, { status: 500 });
  });
  await flush();
  await store.seen();
  expect(store.attention()).toBe(true);
  expect(seenCalls).toBe(1);
  await store.seen();
  expect(seenCalls).toBe(2);
});

it('clears the summary and the indicators when seen is denied', async () => {
  const { store, requestMock, openSource } = setup(async (path) =>
    path === '/api/jobs/activity/seen'
      ? new Response(null, { status: 403 })
      : Response.json(
          activity({
            running: { count: 1, jobs: [job()] },
            attention: true,
          }),
        ),
  );
  await flush();
  expect(store.runningCount()).toBe(1);
  expect(store.attention()).toBe(true);

  await store.seen();
  expect(store.summary()).toBeNull();
  expect(store.runningCount()).toBe(0);
  expect(store.attention()).toBe(false);
  expect(store.loading()).toBe(false);
  expect(store.error()).toBe('Activity is unavailable.');
  // No job event and no reconnect take part, and no reread follows the denial.
  expect(openSource).toHaveBeenCalledTimes(1);
  expect(
    requestMock.mock.calls.filter(([path]) => path === '/api/jobs/activity'),
  ).toHaveLength(1);
});

it('rereads no sooner than 60 s after a read when the next expiry is closer', async () => {
  vi.useFakeTimers();
  let recent = true;
  const { store, requestMock } = setup(async () =>
    Response.json(
      activity({
        recent: recent
          ? {
              count: 1,
              jobs: [
                job({
                  displayId: 'UPD-012',
                  status: 'completed',
                  finishedAt: '2026-10-19T11:30:30.000Z',
                  progress: {
                    total: 48,
                    succeeded: 48,
                    failed: 0,
                    unknown: 0,
                    skipped: 0,
                    expired: 0,
                    pending: 0,
                  },
                }),
              ],
              nextExpiryAt: '2026-10-19T12:00:30.000Z',
            }
          : { count: 0, jobs: [], nextExpiryAt: null },
      }),
    ),
  );
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(1);
  recent = false;
  await vi.advanceTimersByTimeAsync(ACTIVITY_EXPIRY_FLOOR_MS - 1);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(2);
  expect(store.summary()?.recent.count).toBe(0);
});

it('drops a Recent job at its 24-hour expiry without an event or a reconnect', async () => {
  vi.useFakeTimers();
  const observedAt = '2026-10-19T12:00:00.000Z';
  const finishedAt = '2026-10-19T11:30:30.000Z';
  const nextExpiryAt = '2026-10-20T11:30:30.000Z';
  let expired = false;
  const { store, requestMock, openSource } = setup(async () =>
    Response.json(
      expired
        ? activity({ observedAt: nextExpiryAt })
        : activity({
            observedAt,
            recent: {
              count: 1,
              jobs: [
                job({
                  displayId: 'UPD-012',
                  status: 'completed',
                  finishedAt,
                  progress: {
                    total: 48,
                    succeeded: 48,
                    failed: 0,
                    unknown: 0,
                    skipped: 0,
                    expired: 0,
                    pending: 0,
                  },
                }),
              ],
              nextExpiryAt,
            },
          }),
    ),
  );
  await flush();
  expect(store.summary()?.recent.count).toBe(1);
  expect(store.summary()?.recent.jobs).toHaveLength(1);
  const reads = requestMock.mock.calls.length;
  const delay = Date.parse(nextExpiryAt) - Date.parse(observedAt);
  // The 24-hour delay comes from observedAt, not from finishedAt, and exceeds the floor.
  expect(delay).toBeGreaterThan(ACTIVITY_EXPIRY_FLOOR_MS);

  expired = true;
  await vi.advanceTimersByTimeAsync(delay - 1);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(reads);
  expect(store.summary()?.recent.jobs).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(1);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(reads + 1);
  expect(store.summary()?.recent.count).toBe(0);
  expect(store.summary()?.recent.jobs).toHaveLength(0);
  // No job event and no reconnect take part.
  expect(openSource).toHaveBeenCalledTimes(1);
});

it('drops a held answer of the previous person', async () => {
  const session = signal<ReturnType<typeof sessionFor> | null>(
    sessionFor(maya),
  );
  const held: ((response: Response) => void)[] = [];
  const { store } = setup(
    () => new Promise<Response>((resolve) => held.push(resolve)),
    session,
  );
  await flush();
  expect(held).toHaveLength(1);

  session.set(null);
  TestBed.tick();
  expect(store.summary()).toBeNull();
  session.set(sessionFor(alex));
  TestBed.tick();

  // The previous person's answer arrives after the next person signed in.
  held[0](Response.json(activity({ running: { count: 1, jobs: [job()] } })));
  await flush();
  expect(store.summary()).toBeNull();
  expect(store.runningCount()).toBe(0);

  // The reader now runs the next person's read. It returns that person's state.
  expect(held).toHaveLength(2);
  held[1](
    Response.json(
      activity({
        running: {
          count: 1,
          jobs: [job({ jobId: alexJob, displayId: 'UPD-101' })],
        },
      }),
    ),
  );
  await vi.waitFor(() => expect(store.loaded()).toBe(true));
  expect(store.summary()?.running.jobs[0].displayId).toBe('UPD-101');
});

it('ignores a held seen answer of the previous person', async () => {
  const session = signal<ReturnType<typeof sessionFor> | null>(
    sessionFor(maya),
  );
  const heldSeen: ((response: Response) => void)[] = [];
  const { store, requestMock } = setup(
    (path) =>
      path === '/api/jobs/activity/seen'
        ? new Promise<Response>((resolve) => heldSeen.push(resolve))
        : Promise.resolve(Response.json(activity())),
    session,
  );
  await flush();
  const seen = store.seen();
  await flush();
  expect(heldSeen).toHaveLength(1);

  session.set(null);
  TestBed.tick();
  session.set(sessionFor(alex));
  TestBed.tick();
  const reads = requestMock.mock.calls.filter(
    ([path]) => path === '/api/jobs/activity',
  ).length;

  heldSeen[0](Response.json({ seenAt: '2026-10-19T12:00:05.000Z' }));
  await seen;
  await flush();
  // The new person's reader was not invalidated by the previous person's answer.
  expect(
    requestMock.mock.calls.filter(([path]) => path === '/api/jobs/activity'),
  ).toHaveLength(reads);
});

it('ignores a held seen 403 of the previous person', async () => {
  const session = signal<ReturnType<typeof sessionFor> | null>(
    sessionFor(maya),
  );
  const heldSeen: ((response: Response) => void)[] = [];
  const { store } = setup(
    (path) =>
      path === '/api/jobs/activity/seen'
        ? new Promise<Response>((resolve) => heldSeen.push(resolve))
        : Promise.resolve(
            Response.json(activity({ running: { count: 1, jobs: [job()] } })),
          ),
    session,
  );
  await flush();
  const seen = store.seen();
  await flush();
  expect(heldSeen).toHaveLength(1);

  session.set(null);
  TestBed.tick();
  session.set(sessionFor(alex));
  TestBed.tick();
  await vi.waitFor(() => expect(store.loaded()).toBe(true));
  expect(store.runningCount()).toBe(1);

  // The previous person's denial arrives after the next person signed in.
  heldSeen[0](new Response(null, { status: 403 }));
  await seen;
  await flush();
  expect(store.summary()).not.toBeNull();
  expect(store.runningCount()).toBe(1);
  expect(store.error()).toBe('');
});

it('leaves no stale state after a 401 seen answer and a new sign-in', async () => {
  const session = signal<ReturnType<typeof sessionFor> | null>(
    sessionFor(maya),
  );
  const heldSeen: ((response: Response) => void)[] = [];
  const { store, requestMock } = setup(
    (path) =>
      path === '/api/jobs/activity/seen'
        ? new Promise<Response>((resolve) => heldSeen.push(resolve))
        : Promise.resolve(Response.json(activity())),
    session,
  );
  await flush();
  const seen = store.seen();
  await flush();

  session.set(null);
  TestBed.tick();
  session.set(sessionFor(maya));
  TestBed.tick();
  heldSeen[0](new Response(null, { status: 401 }));
  await seen;
  await vi.waitFor(() => expect(store.loaded()).toBe(true));
  expect(store.runningCount()).toBe(0);

  // The interrupted request left no pending state. A later opening sends again.
  const reads = requestMock.mock.calls.filter(
    ([path]) => path === '/api/jobs/activity',
  ).length;
  const again = store.seen();
  await flush();
  expect(heldSeen).toHaveLength(2);
  heldSeen[1](Response.json({ seenAt: '2026-10-19T12:01:00.000Z' }));
  await again;
  await vi.waitFor(() =>
    expect(
      requestMock.mock.calls.filter(([path]) => path === '/api/jobs/activity'),
    ).toHaveLength(reads + 1),
  );
});

it('clears the summary and the indicators on a 403 answer', async () => {
  const { store } = setup(async () => new Response(null, { status: 403 }));
  await vi.waitFor(() => expect(store.loading()).toBe(false));
  expect(store.summary()).toBeNull();
  expect(store.runningCount()).toBe(0);
  expect(store.attention()).toBe(false);
  expect(store.error()).toBe('Activity is unavailable.');
});

it('stops the stream and the timers and clears the summary on sign-out', async () => {
  vi.useFakeTimers();
  const session = signal<ReturnType<typeof sessionFor> | null>(
    sessionFor(maya),
  );
  const { store, stream, requestMock } = setup(
    async () =>
      Response.json(
        activity({
          running: { count: 1, jobs: [job()] },
          recent: {
            count: 1,
            jobs: [
              job({
                displayId: 'UPD-012',
                status: 'completed',
                finishedAt: '2026-10-19T11:30:30.000Z',
              }),
            ],
            nextExpiryAt: '2026-10-19T12:00:30.000Z',
          },
        }),
      ),
    session,
  );
  await flush();
  expect(store.runningCount()).toBe(1);
  const reads = requestMock.mock.calls.length;

  session.set(null);
  TestBed.tick();
  expect(store.summary()).toBeNull();
  expect(store.runningCount()).toBe(0);
  expect(store.attention()).toBe(false);
  expect(stream.readyState).toBe(2);

  await vi.advanceTimersByTimeAsync(120_000);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(reads);
});
