import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthStore } from './auth.store';
import { CustomerStore } from './customer-settings/customer.store';
import { DevicesStore } from './devices/devices.store';
import { ConnectionStore } from './google-connection/connection.store';
import { JobActivityStore } from './jobs/job-activity.store';
import { LiveFeeds } from './jobs/live-feeds';
import type { JobEventSource } from './jobs/job-stream';

const customerId = 'C0123456';
const actor = '44444444-4444-4444-8444-444444444444';
const now = Date.now();

const sessionFor = (actions: string[], id = actor) => ({
  identity: {
    id,
    displayName: 'District operator',
    permissionVersion: 1,
    grants: actions.map((action) => ({
      action,
      scope: { kind: 'district', customerId },
    })),
    preferences: { theme: 'light', navigationCollapsed: false },
  },
  csrfToken: 'a'.repeat(64),
});

const activity = () => ({
  running: { count: 1, jobs: [] },
  waiting: { count: 0, jobs: [] },
  recent: { count: 0, jobs: [], nextExpiryAt: null },
  attention: false,
  seenAt: null,
  observedAt: new Date(now - 60_000).toISOString(),
});

const syncState = (observedAt = new Date(now - 60_000).toISOString()) => ({
  customerId,
  generation: 1,
  status: 'ready',
  observedAt,
  deviceCount: 10,
  failure: null,
  telemetryFailure: null,
  startedAt: null,
  checkedAt: null,
  stale: false,
});

/** A controllable EventSource. It records the URL that the page asked for. */
class FakeSource {
  readyState = 0;
  readonly url: string;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(name: string, listener: (event: Event) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  close(): void {
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

/**
 * The Devices page with the shell: the activity store follows the job feed and the devices store
 * follows the device feed. Both use the one `LiveFeeds` connection.
 */
function setup(actions: string[], sync: () => Response | Promise<Response>) {
  const sources: FakeSource[] = [];
  const requests: string[] = [];
  const route = (path: string): Response | Promise<Response> => {
    if (path === '/api/jobs/activity') return Response.json(activity());
    if (path === '/api/devices/sync') return sync();
    if (path === '/api/devices/freshness')
      return Response.json({ freshness: { stale: 0, refreshing: false } });
    if (path === '/api/devices/by-ids') return Response.json({ rows: [] });
    return new Response(null, { status: 404 });
  };
  const request = vi.fn(async (path: string) => {
    requests.push(path);
    return route(path);
  });
  const session = signal(sessionFor(actions));
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AuthStore,
        useValue: {
          request,
          metadata: signal({ phase: 3 }),
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
    ],
  });
  const feeds = TestBed.inject(LiveFeeds);
  feeds.timeout = 0;
  feeds.reopenDelay = 0;
  const open = (url: string): JobEventSource => {
    const fake = new FakeSource(url);
    sources.push(fake);
    return fake as unknown as JobEventSource;
  };
  const activityStore = TestBed.inject(JobActivityStore);
  activityStore.eventSource = open;
  const devicesStore = TestBed.inject(DevicesStore);
  devicesStore.eventSource = open;
  return {
    activity: activityStore,
    devices: devicesStore,
    feeds,
    session,
    sources,
    requests,
    reads: (path: string) => requests.filter((item) => item === path).length,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

it('carries the job feed and the device feed on one connection through a reopen', async () => {
  vi.useFakeTimers();
  const { activity, devices, sources, reads } = setup(
    ['jobs:read', 'devices:read'],
    () => Response.json({ sync: syncState() }),
  );
  TestBed.tick();
  await devices.init();

  // One EventSource for both stores. The status read came before the device events.
  expect(sources).toHaveLength(1);
  expect(sources.map((fake) => fake.url)).toEqual(['/api/events']);
  expect(reads('/api/devices/sync')).toBe(1);
  expect(activity.live()).toBe(false);

  sources[0].open();
  await vi.advanceTimersByTimeAsync(250);
  expect(activity.live()).toBe(true);
  expect(reads('/api/jobs/activity')).toBe(2);
  // The first open after the status read recovers nothing.
  expect(reads('/api/devices/sync')).toBe(1);

  // Each store follows its own frame names on the one connection.
  sources[0].send('job-changed', {
    type: 'job-changed',
    jobId: '33333333-3333-4333-8333-333333333333',
    displayId: 'UPD-014',
    revision: 5,
    requestedBy: actor,
  });
  await vi.advanceTimersByTimeAsync(250);
  expect(reads('/api/jobs/activity')).toBe(3);
  const revision = devices.revision();
  sources[0].send('full-sync', {
    type: 'full-sync',
    sync: syncState(new Date(now - 30_000).toISOString()),
  });
  expect(devices.revision()).toBe(revision + 1);

  // A replaced connection: each store reads once more on its open.
  const events = reads('/api/jobs/activity');
  const statuses = reads('/api/devices/sync');
  sources[0].fail(2);
  await vi.advanceTimersByTimeAsync(0);
  expect(sources).toHaveLength(2);
  sources[1].open();
  await vi.advanceTimersByTimeAsync(250);
  expect(reads('/api/jobs/activity')).toBe(events + 1);
  // The status read before the device events and the read after the open.
  expect(reads('/api/devices/sync')).toBe(statuses + 2);
  expect(sources.map((fake) => fake.url)).toEqual([
    '/api/events',
    '/api/events',
  ]);
});

it('keeps the job feed live when a denied device read stops the devices store', async () => {
  vi.useFakeTimers();
  const { activity, devices, sources, reads } = setup(['jobs:read'], () =>
    Response.json({ code: 'forbidden' }, { status: 403 }),
  );
  TestBed.tick();
  await devices.init();

  // The denied status read left this store out. The jobs feed opened the one connection.
  expect(devices.sync()).toBeNull();
  expect(sources).toHaveLength(1);
  sources[0].open();
  await vi.advanceTimersByTimeAsync(250);
  expect(activity.live()).toBe(true);

  sources[0].send('job-changed', {
    type: 'job-changed',
    jobId: '33333333-3333-4333-8333-333333333333',
    displayId: 'UPD-014',
    revision: 5,
    requestedBy: actor,
  });
  await vi.advanceTimersByTimeAsync(250);
  // The live job feed reads again. The stopped device store reads no status.
  expect(reads('/api/jobs/activity')).toBe(3);
  expect(reads('/api/devices/sync')).toBe(1);
  expect(sources).toHaveLength(1);
});

it('reads the new person status when both stores follow a replaced connection', async () => {
  vi.useFakeTimers();
  const { activity, devices, session, sources, reads } = setup(
    ['jobs:read', 'devices:read'],
    () => Response.json({ sync: syncState() }),
  );
  TestBed.tick();
  await devices.init();
  sources[0].open();
  await vi.advanceTimersByTimeAsync(250);
  expect(activity.live()).toBe(true);
  const jobReads = reads('/api/jobs/activity');
  const statusReads = reads('/api/devices/sync');

  // The next person gets a replaced connection. Both stores read on it.
  session.set(sessionFor(['jobs:read', 'devices:read'], 'someone-else'));
  TestBed.tick();
  await vi.advanceTimersByTimeAsync(0);
  const live = sources[sources.length - 1];
  live.open();
  await vi.advanceTimersByTimeAsync(250);
  // The job feed stays live and the devices store loads the new person's status.
  expect(activity.live()).toBe(true);
  expect(reads('/api/jobs/activity')).toBeGreaterThan(jobReads);
  expect(reads('/api/devices/sync')).toBeGreaterThan(statusReads);
  expect(devices.sync()?.status).toBe('ready');
  expect(devices.syncLoaded()).toBe(true);
  // Every replacement source but the live one is closed.
  expect(sources.filter((source) => source.readyState !== 2)).toHaveLength(1);
});

it('keeps the device store stopped when a newer denial follows a held admission', async () => {
  vi.useFakeTimers();
  let statusReads = 0;
  let release: () => void = () => undefined;
  let denied = false;
  const { activity, devices, sources, session, reads } = setup(
    ['jobs:read', 'devices:read'],
    async () => {
      statusReads += 1;
      // The second read is the new person's admission. Its answer waits for the test.
      if (statusReads === 2) {
        await new Promise<void>((resolve) => (release = resolve));
        return Response.json({ sync: syncState() });
      }
      return denied
        ? Response.json({ code: 'forbidden' }, { status: 403 })
        : Response.json({ sync: syncState() });
    },
  );
  TestBed.tick();
  await devices.init();
  sources[0].open();
  await vi.advanceTimersByTimeAsync(250);
  expect(activity.live()).toBe(true);

  // The next person's admission read is in flight. The reset source fails before it opens.
  session.set(sessionFor(['jobs:read', 'devices:read'], 'someone-else'));
  TestBed.tick();
  await vi.advanceTimersByTimeAsync(0);
  sources[sources.length - 1].fail(2);
  await vi.advanceTimersByTimeAsync(0);

  // The replacement open reads a denial. It stops the devices store and leaves jobs live.
  denied = true;
  const live = sources[sources.length - 1];
  live.open();
  await vi.advanceTimersByTimeAsync(250);
  expect(devices.sync()).toBeNull();
  expect(activity.live()).toBe(true);
  expect(sources.filter((source) => source.readyState !== 2)).toHaveLength(1);

  // The older successful admission answer arrives. It must not follow the device events again.
  release();
  await vi.advanceTimersByTimeAsync(0);
  const revision = devices.revision();
  live.send('full-sync', { type: 'full-sync', sync: syncState() });
  expect(devices.revision()).toBe(revision);
  expect(devices.sync()).toBeNull();
  expect(sources.filter((source) => source.readyState !== 2)).toHaveLength(1);

  // The job feed keeps its one connection and its reads.
  const events = reads('/api/jobs/activity');
  live.send('job-changed', {
    type: 'job-changed',
    jobId: '33333333-3333-4333-8333-333333333333',
    displayId: 'UPD-014',
    revision: 6,
    requestedBy: actor,
  });
  await vi.advanceTimersByTimeAsync(250);
  expect(activity.live()).toBe(true);
  expect(reads('/api/jobs/activity')).toBeGreaterThan(events);
});

it('does not restart a stopped device store when the person before answers', async () => {
  vi.useFakeTimers();
  let reads = 0;
  let release: () => void = () => undefined;
  let denied = false;
  const {
    activity,
    devices,
    sources,
    session,
    reads: count,
  } = setup(['jobs:read', 'devices:read'], async () => {
    reads += 1;
    // The first read is the person before. It answers only when the test says so.
    if (reads === 1) {
      await new Promise<void>((resolve) => (release = resolve));
      return Response.json({ sync: syncState() });
    }
    return denied
      ? Response.json({ code: 'forbidden' }, { status: 403 })
      : Response.json({ sync: syncState() });
  });
  const feeds = TestBed.inject(LiveFeeds);
  // The production reopen delay. The replacement open follows the failed reset source.
  feeds.reopenDelay = 5000;
  TestBed.tick();
  const first = devices.init();

  // The job feed owns the tab's one connection while the device admission is in flight.
  expect(sources).toHaveLength(1);
  session.set(sessionFor(['jobs:read', 'devices:read'], 'someone-else'));
  TestBed.tick();
  // The shared connection restarts for the new session. The reset source closes before its first
  // open, and its replacement reads a denial.
  expect(sources).toHaveLength(2);
  sources[1].fail(2);
  await vi.advanceTimersByTimeAsync(5000);
  denied = true;
  const live = sources[sources.length - 1];
  expect(sources).toHaveLength(3);
  live.open();
  await vi.advanceTimersByTimeAsync(250);
  expect(devices.sync()).toBeNull();
  expect(activity.live()).toBe(true);
  expect(sources.filter((source) => source.readyState !== 2)).toHaveLength(1);

  // The person before answers after the newer stop. It starts no admission and follows nothing.
  denied = false;
  release();
  await first;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(count('/api/devices/sync')).toBe(2);
  const revision = devices.revision();
  live.send('full-sync', { type: 'full-sync', sync: syncState() });
  expect(devices.revision()).toBe(revision);
  expect(devices.sync()).toBeNull();

  // The job feed keeps its one connection and its reads.
  const events = count('/api/jobs/activity');
  live.send('job-changed', {
    type: 'job-changed',
    jobId: '33333333-3333-4333-8333-333333333333',
    displayId: 'UPD-014',
    revision: 6,
    requestedBy: actor,
  });
  await vi.advanceTimersByTimeAsync(250);
  expect(activity.live()).toBe(true);
  expect(count('/api/jobs/activity')).toBeGreaterThan(events);
  expect(sources.filter((source) => source.readyState !== 2)).toHaveLength(1);
});

it('recovers the stopped device store on an explicit init after the person before answers', async () => {
  vi.useFakeTimers();
  let reads = 0;
  let release: () => void = () => undefined;
  let denied = false;
  const {
    activity,
    devices,
    sources,
    session,
    reads: count,
  } = setup(['jobs:read', 'devices:read'], async () => {
    reads += 1;
    // The first read is the person before. It answers only when the test says so.
    if (reads === 1) {
      await new Promise<void>((resolve) => (release = resolve));
      return Response.json({ sync: syncState() });
    }
    return denied
      ? Response.json({ code: 'forbidden' }, { status: 403 })
      : Response.json({ sync: syncState() });
  });
  const feeds = TestBed.inject(LiveFeeds);
  // The production reopen delay. The replacement open follows the failed reset source.
  feeds.reopenDelay = 5000;
  TestBed.tick();
  const first = devices.init();

  // The job feed owns the tab's one connection while the device admission is in flight.
  expect(sources).toHaveLength(1);
  session.set(sessionFor(['jobs:read', 'devices:read'], 'someone-else'));
  TestBed.tick();
  expect(sources).toHaveLength(2);
  sources[1].fail(2);
  await vi.advanceTimersByTimeAsync(5000);
  denied = true;
  const live = sources[sources.length - 1];
  expect(sources).toHaveLength(3);
  live.open();
  await vi.advanceTimersByTimeAsync(250);
  expect(devices.sync()).toBeNull();
  expect(activity.live()).toBe(true);
  expect(sources.filter((source) => source.readyState !== 2)).toHaveLength(1);

  // The stopped Devices page asks for recovery while the person before still answers.
  denied = false;
  void devices.init();
  await vi.advanceTimersByTimeAsync(0);
  // The old admission still owns the request. No read starts before it answers.
  expect(count('/api/devices/sync')).toBe(2);

  // The former principal's answer completes, and the current person's admission follows.
  release();
  await first;
  await vi.advanceTimersByTimeAsync(250);
  expect(count('/api/devices/sync')).toBe(3);
  expect(devices.sync()?.status).toBe('ready');
  expect(devices.syncLoaded()).toBe(true);

  // The restored device subscription follows the one live connection. Jobs keep reading.
  const revision = devices.revision();
  live.send('full-sync', {
    type: 'full-sync',
    sync: syncState(new Date(now - 30_000).toISOString()),
  });
  expect(devices.revision()).toBe(revision + 1);
  const events = count('/api/jobs/activity');
  live.send('job-changed', {
    type: 'job-changed',
    jobId: '33333333-3333-4333-8333-333333333333',
    displayId: 'UPD-014',
    revision: 6,
    requestedBy: actor,
  });
  await vi.advanceTimersByTimeAsync(250);
  expect(activity.live()).toBe(true);
  expect(count('/api/jobs/activity')).toBeGreaterThan(events);
  expect(sources.filter((source) => source.readyState !== 2)).toHaveLength(1);
});

it('keeps the job feed live when the customer has no device sync', async () => {
  vi.useFakeTimers();
  const { activity, devices, sources } = setup(
    ['jobs:read', 'devices:read'],
    () => Response.json({ sync: null }),
  );
  TestBed.tick();
  await devices.init();

  expect(devices.sync()).toBeNull();
  expect(sources).toHaveLength(1);
  sources[0].open();
  await vi.advanceTimersByTimeAsync(250);
  expect(activity.live()).toBe(true);
});
