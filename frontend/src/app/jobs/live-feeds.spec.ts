import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveFeeds, type LiveFeedHandlers } from './live-feeds';
import type { JobEventSource } from './job-stream';

/** A document whose visibility a test sets. */
class FakeDocument {
  visibilityState: DocumentVisibilityState = 'visible';
  private readonly listeners = new Set<() => void>();

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  show(): void {
    this.visibilityState = 'visible';
    for (const listener of this.listeners) listener();
  }

  hide(): void {
    this.visibilityState = 'hidden';
    for (const listener of this.listeners) listener();
  }
}

/** The parts of EventSource that the service uses. Tests set `readyState` directly. */
class FakeSource {
  readyState = 0;
  readonly listeners = new Map<string, ((event: Event) => void)[]>();

  addEventListener(name: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  close(): void {
    this.readyState = 2;
  }

  emit(name: string, event: Event = new Event(name)): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

const source = (fake: FakeSource) => fake as unknown as JobEventSource;

/** One store that follows a feed, with the calls that the service makes on it. */
function follower(sources: FakeSource[], events: string[] = ['job-changed']) {
  const opened = vi.fn();
  const changed = vi.fn();
  const closed = vi.fn();
  const open = vi.fn(() => {
    const fake = new FakeSource();
    sources.push(fake);
    return source(fake);
  });
  const handlers: LiveFeedHandlers = {
    open,
    events,
    opened,
    changed,
    closed,
  };
  return { handlers, open, opened, changed, closed };
}

function setup() {
  const doc = new FakeDocument();
  TestBed.configureTestingModule({
    providers: [{ provide: DOCUMENT, useValue: doc as unknown as Document }],
  });
  const feeds = TestBed.inject(LiveFeeds);
  return { feeds, doc };
}

const changedEvent = (name: string, data: string) =>
  new MessageEvent(name, { data });

afterEach(() => {
  vi.useRealTimers();
});

it('states the one reopen rule of the shared connection', () => {
  const { feeds } = setup();
  expect(feeds.reopenDelay).toBe(5000);
  expect(feeds.reopenCap).toBe(60_000);
  expect(feeds.timeout).toBe(60_000);
});

it('opens one connection for two subscribers of one feed URL', () => {
  const { feeds } = setup();
  const first: FakeSource[] = [];
  const second: FakeSource[] = [];
  const one = follower(first);
  const two = follower(second);
  const oneFeed = feeds.subscribe('/api/events', one.handlers);

  feeds.subscribe('/api/events', two.handlers);

  expect(first).toHaveLength(1);
  expect(second).toHaveLength(0);
  expect(one.open).toHaveBeenCalledTimes(1);

  const fake = first[0];
  fake.readyState = 1;
  fake.emit('open');
  expect(one.opened).toHaveBeenCalledTimes(1);
  expect(two.opened).toHaveBeenCalledTimes(1);
  expect(oneFeed.connected).toBe(true);

  fake.emit(
    'job-changed',
    changedEvent('job-changed', '{"type":"job-changed"}'),
  );
  expect(one.changed).toHaveBeenCalledWith('{"type":"job-changed"}');
  expect(two.changed).toHaveBeenCalledWith('{"type":"job-changed"}');

  // The first store leaves; the other one still follows the connection.
  oneFeed.close();
  expect(fake.readyState).toBe(1);
});

it('holds one connection for the job feed and the device feed', () => {
  const { feeds } = setup();
  const sources: FakeSource[] = [];
  const jobs = follower(sources, ['job-changed']);
  const devices = follower(sources, [
    'entity-batch',
    'job-finished',
    'full-sync',
  ]);
  feeds.subscribe('/api/events', jobs.handlers);
  feeds.subscribe('/api/events', devices.handlers);
  expect(sources).toHaveLength(1);

  const fake = sources[0];
  fake.readyState = 1;
  fake.emit('open');

  fake.emit(
    'job-changed',
    changedEvent('job-changed', '{"type":"job-changed"}'),
  );
  fake.emit(
    'entity-batch',
    changedEvent('entity-batch', '{"type":"entity-batch"}'),
  );
  fake.emit('full-sync', changedEvent('full-sync', '{"type":"full-sync"}'));

  expect(jobs.changed).toHaveBeenCalledTimes(1);
  expect(jobs.changed).toHaveBeenCalledWith('{"type":"job-changed"}');
  expect(devices.changed).toHaveBeenCalledTimes(2);
  expect(devices.changed).toHaveBeenCalledWith('{"type":"entity-batch"}');
  expect(devices.changed).toHaveBeenCalledWith('{"type":"full-sync"}');
});

it('closes the tab connection when the last subscriber leaves', () => {
  const { feeds } = setup();
  const sources: FakeSource[] = [];
  const one = follower(sources);
  const two = follower(sources);
  const oneFeed = feeds.subscribe('/api/events', one.handlers);
  const twoFeed = feeds.subscribe('/api/events', two.handlers);

  oneFeed.close();
  twoFeed.close();
  expect(sources[0].readyState).toBe(2);
});

it('reads at once for a store that subscribes to an open feed', () => {
  const { feeds } = setup();
  const sources: FakeSource[] = [];
  const first = follower(sources);
  const second = follower(sources);
  feeds.subscribe('/api/events', first.handlers);
  sources[0].readyState = 1;
  sources[0].emit('open');
  expect(first.opened).toHaveBeenCalledTimes(1);

  feeds.subscribe('/api/events', second.handlers);

  expect(second.opened).toHaveBeenCalledTimes(1);
  expect(sources).toHaveLength(1);
  expect(second.open).not.toHaveBeenCalled();
});

it('waits for the next open before a late subscriber reads on a reconnecting feed', () => {
  const { feeds } = setup();
  const sources: FakeSource[] = [];
  const first = follower(sources);
  const second = follower(sources);
  const one = feeds.subscribe('/api/events', first.handlers);
  sources[0].readyState = 1;
  sources[0].emit('open');
  first.opened.mockClear();

  // The connection drops and the browser retries it while it stays CONNECTING.
  sources[0].readyState = 0;
  sources[0].emit('error');
  expect(one.connected).toBe(false);

  feeds.subscribe('/api/events', second.handlers);

  // The connection is not open, so the late subscriber has nothing to read yet.
  expect(second.opened).not.toHaveBeenCalled();
  expect(sources).toHaveLength(1);

  sources[0].readyState = 1;
  sources[0].emit('open');
  expect(second.opened).toHaveBeenCalledTimes(1);
  expect(first.opened).toHaveBeenCalledTimes(1);
});

it('waits for the next open before a resume reads on a reconnecting feed', () => {
  const { feeds } = setup();
  const sources: FakeSource[] = [];
  const one = follower(sources);
  const feed = feeds.subscribe('/api/events', one.handlers);
  sources[0].readyState = 1;
  sources[0].emit('open');
  one.opened.mockClear();

  sources[0].readyState = 0;
  sources[0].emit('error');
  feed.resume();

  // The browser still owns the retry, and no read runs until its next open.
  expect(one.opened).not.toHaveBeenCalled();
  expect(sources).toHaveLength(1);
  sources[0].readyState = 1;
  sources[0].emit('open');
  expect(one.opened).toHaveBeenCalledTimes(1);
});

it('holds no connection while the tab is hidden and reopens it when it is visible', () => {
  const { feeds, doc } = setup();
  const sources: FakeSource[] = [];
  const first = follower(sources);
  const second = follower(sources);
  feeds.subscribe('/api/events', first.handlers);
  feeds.subscribe('/api/events', second.handlers);
  sources[0].readyState = 1;
  sources[0].emit('open');
  first.opened.mockClear();
  second.opened.mockClear();

  doc.hide();

  expect(sources[0].readyState).toBe(2);
  expect(first.closed).toHaveBeenCalledTimes(1);
  expect(second.closed).toHaveBeenCalledTimes(1);

  doc.show();

  // One connection for both stores, not one for each store.
  expect(sources).toHaveLength(2);
  sources[1].readyState = 1;
  sources[1].emit('open');
  expect(first.opened).toHaveBeenCalledTimes(1);
  expect(second.opened).toHaveBeenCalledTimes(1);
  // The replacement open tells each store that the connection is new.
  expect(first.opened).toHaveBeenCalledWith(true);
});

it('reopens a dead shared connection once for every subscriber', () => {
  vi.useFakeTimers();
  const { feeds } = setup();
  const sources: FakeSource[] = [];
  const one = follower(sources);
  const two = follower(sources);
  feeds.subscribe('/api/events', one.handlers);
  feeds.subscribe('/api/events', two.handlers);
  sources[0].readyState = 1;
  sources[0].emit('open');
  one.opened.mockClear();
  two.opened.mockClear();

  // No event for 60 s: the connection counts as dead and reopens after 5 s.
  vi.advanceTimersByTime(60_000);
  expect(sources[0].readyState).toBe(2);
  vi.advanceTimersByTime(5000);

  expect(sources).toHaveLength(2);
  sources[1].readyState = 1;
  sources[1].emit('open');
  expect(one.opened).toHaveBeenCalledTimes(1);
  expect(two.opened).toHaveBeenCalledTimes(1);
  // The first store's factory owns the connection. The second one never opens its own.
  expect(one.open).toHaveBeenCalledTimes(2);
  expect(two.open).not.toHaveBeenCalled();
});

it('reopens once when a shared connection closes', () => {
  vi.useFakeTimers();
  const { feeds } = setup();
  const sources: FakeSource[] = [];
  const one = follower(sources);
  const two = follower(sources);
  feeds.subscribe('/api/events', one.handlers);
  feeds.subscribe('/api/events', two.handlers);
  sources[0].readyState = 1;
  sources[0].emit('open');

  sources[0].readyState = 2;
  sources[0].emit('error');
  vi.advanceTimersByTime(5000);

  expect(sources).toHaveLength(2);
});

it('backs a failed reopen off to its cap', async () => {
  vi.useFakeTimers();
  const { feeds } = setup();
  feeds.reopenDelay = 1000;
  feeds.reopenCap = 4000;
  const sources: FakeSource[] = [];
  const one = follower(sources);
  feeds.subscribe('/api/events', one.handlers);
  sources[0].readyState = 1;
  sources[0].emit('open');

  /** Fails the open connection and checks the wait of the next attempt. */
  const failAndWait = async (index: number, wait: number) => {
    const before = sources.length;
    sources[index].readyState = 2;
    sources[index].emit('error');
    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(sources).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(before + 1);
  };

  // Each failed attempt doubles the wait until the cap holds it at 4 s.
  await failAndWait(0, 1000);
  await failAndWait(1, 2000);
  await failAndWait(2, 4000);
  await failAndWait(3, 4000);
});

it('replaces the connection for a new person and opens it for the same one', () => {
  const { feeds } = setup();
  const sources: FakeSource[] = [];
  const one = follower(sources);
  const second = follower(sources);
  feeds.subscribe('/api/events', one.handlers);
  const two = feeds.subscribe('/api/events', second.handlers);
  sources[0].readyState = 1;
  sources[0].emit('open');
  one.opened.mockClear();
  second.opened.mockClear();

  // A new person: one replacement connection for every store.
  two.restart();

  expect(sources).toHaveLength(2);
  expect(sources[0].readyState).toBe(2);
  sources[1].readyState = 1;
  sources[1].emit('open');
  expect(one.opened).toHaveBeenCalledWith(true);
  expect(second.opened).toHaveBeenCalledWith(true);
});
