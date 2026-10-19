import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { JobPerson, JobSummary } from '@campus/application-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { JOBS_PAGE_SIZE, JobsStore, jobsReadable } from './jobs.store';
import type { JobEventSource } from './jobs.store';

const customerId = 'C0123456';

const job = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  jobId: '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'UPD-014',
  revision: 1,
  action: 'update-device-annotations',
  status: 'running',
  scope: { kind: 'devices', deviceCount: 48 },
  requestedBy: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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
    pending: 12,
  },
  failure: null,
  ...overrides,
});

const list = (
  jobs: JobSummary[],
  nextCursor: string | null = null,
  matching = jobs.length,
) =>
  Response.json({
    jobs,
    matching,
    nextCursor,
    observedAt: '2026-10-19T12:01:00.000Z',
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
  request: (path: string) => Promise<Response> = async () => list([job()]),
) {
  const stream = new FakeStream();
  const requestMock = vi.fn(request);
  const session = signal({
    identity: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      displayName: 'District operator',
      permissionVersion: 1,
      permissions: [],
      grants: [
        { action: 'jobs:read', scope: { kind: 'district', customerId } },
      ],
      preferences: { theme: 'light', navigationCollapsed: false },
    },
    csrfToken: 'a'.repeat(64),
    expiresAt: '2026-10-20T12:00:00.000Z',
  });
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
  const store = TestBed.inject(JobsStore);
  store.eventSource = () => stream as unknown as JobEventSource;
  return { store, stream, requestMock, session };
}

const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('jobsReadable', () => {
  const auth = (grants: { action: string }[] | null, phase = 3) =>
    ({
      metadata: () => ({ phase }),
      session: () => (grants === null ? null : { identity: { grants } }),
    }) as unknown as InstanceType<typeof AuthStore>;

  it('shows Jobs to a jobs:read holder', () => {
    expect(jobsReadable(auth([{ action: 'jobs:read' }]))).toBe(true);
  });

  it('shows Jobs to a devices:read holder', () => {
    expect(jobsReadable(auth([{ action: 'devices:read' }]))).toBe(true);
  });

  it('hides Jobs without either action', () => {
    expect(jobsReadable(auth([{ action: 'schools:read' }]))).toBe(false);
  });

  it('hides Jobs before phase 3', () => {
    expect(jobsReadable(auth([{ action: 'jobs:read' }], 1))).toBe(false);
  });
});

it('opens the Jobs stream and reads the first page without a filter', async () => {
  const { store, stream, requestMock } = setup();
  await store.init();
  expect(stream.listeners.has('job-changed')).toBe(true);
  expect(requestMock).toHaveBeenCalledWith(`/api/jobs?limit=${JOBS_PAGE_SIZE}`);
  expect(store.loading()).toBe(false);
  expect(store.loaded()).toBe(true);
  expect(store.page()?.jobs).toHaveLength(1);
  expect(store.offline()).toBe(false);
  expect(store.error()).toBe('');
});

it('maps each filter to the server query and starts a new page', async () => {
  const { store, requestMock } = setup();
  await store.init();
  store.setFilters([
    { field: 'status', values: ['needs-review'] },
    {
      field: 'requestedBy',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      displayName: 'Maya Chen',
    },
  ]);
  await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
  const path = requestMock.mock.calls[1][0];
  const params = new URLSearchParams(path.split('?')[1]);
  expect(params.get('status')).toBe('needs-review');
  expect(params.get('requestedBy')).toBe(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  expect(params.get('cursor')).toBeNull();
  expect(store.pageIndex()).toBe(0);
});

it('pages with the API cursor and returns with Previous', async () => {
  const { store, requestMock } = setup(async (path) =>
    path.includes('cursor=cursor-2')
      ? list([job({ displayId: 'UPD-002' })], null, 2)
      : list([job()], 'cursor-2', 2),
  );
  await store.init();
  expect(store.hasNext()).toBe(true);
  store.next();
  await vi.waitFor(() =>
    expect(store.page()?.jobs[0].displayId).toBe('UPD-002'),
  );
  expect(
    requestMock.mock.calls.some(([path]) => path.includes('cursor=cursor-2')),
  ).toBe(true);
  expect(store.hasPrevious()).toBe(true);
  expect(store.hasNext()).toBe(false);
  store.previous();
  await vi.waitFor(() =>
    expect(store.page()?.jobs[0].displayId).toBe('UPD-014'),
  );
  expect(store.pageIndex()).toBe(0);
});

it('ignores an event at the held revision and reads above it after 250 ms', async () => {
  vi.useFakeTimers();
  const { store, stream, requestMock } = setup();
  await store.init();
  await flush();
  const before = requestMock.mock.calls.length;
  stream.emit(
    'job-changed',
    new MessageEvent('job-changed', {
      data: JSON.stringify({
        type: 'job-changed',
        jobId: job().jobId,
        displayId: 'UPD-014',
        revision: 1,
        requestedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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
        jobId: job().jobId,
        displayId: 'UPD-014',
        revision: 2,
        requestedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    }),
  );
  await vi.advanceTimersByTimeAsync(249);
  expect(requestMock).toHaveBeenCalledTimes(before);
  await vi.advanceTimersByTimeAsync(1);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(before + 1);
});

it('marks the reader dirty on every stream open', async () => {
  vi.useFakeTimers();
  const { store, stream, requestMock } = setup();
  await store.init();
  await flush();
  const before = requestMock.mock.calls.length;
  stream.emit('open');
  await vi.advanceTimersByTimeAsync(250);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(before + 1);
});

it('keeps the last received state and marks the page offline after a failed read', async () => {
  let offline = false;
  const { store } = setup(async () => {
    if (offline) throw new Error('offline');
    return list([job()]);
  });
  await store.init();
  offline = true;
  await store.refresh();
  expect(store.offline()).toBe(true);
  expect(store.page()?.jobs).toHaveLength(1);
  expect(store.stale()).toBe(false);
});

it('shows unavailable when the first read fails without rows', async () => {
  const { store } = setup(async () => {
    throw new Error('offline');
  });
  await store.init();
  expect(store.loading()).toBe(false);
  expect(store.page()).toBeNull();
  expect(store.error()).toBe('Job status is unavailable.');
  expect(store.offline()).toBe(true);
});

it('retries a failed read after 5 s', async () => {
  vi.useFakeTimers();
  let fail = false;
  const { store, stream, requestMock } = setup(async () => {
    if (fail) throw new Error('network');
    return list([job()]);
  });
  await store.init();
  await flush();
  fail = true;
  const before = requestMock.mock.calls.length;
  stream.emit(
    'job-changed',
    new MessageEvent('job-changed', {
      data: JSON.stringify({
        type: 'job-changed',
        jobId: job().jobId,
        displayId: 'UPD-014',
        revision: 2,
        requestedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    }),
  );
  await vi.advanceTimersByTimeAsync(250);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(before + 1);
  await vi.advanceTimersByTimeAsync(4999);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(before + 1);
  await vi.advanceTimersByTimeAsync(1);
  await flush();
  expect(requestMock).toHaveBeenCalledTimes(before + 2);
});

it('reads requesters for the actor autocomplete', async () => {
  const requesters: JobPerson[] = [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      displayName: 'Maya Chen',
    },
  ];
  const { store, requestMock } = setup(async () =>
    Response.json({ requesters }),
  );
  await expect(store.requesters('May')).resolves.toEqual(requesters);
  expect(requestMock).toHaveBeenCalledWith(
    '/api/jobs/requesters?query=May&limit=20',
  );
});

it('leaves the page and stops the stream', async () => {
  const { store, stream } = setup();
  await store.init();
  store.leave();
  expect(stream.readyState).toBe(2);
});
