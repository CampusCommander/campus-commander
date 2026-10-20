import { afterEach, expect, it, vi } from 'vitest';
import { JobStream, type JobEventSource } from './job-stream';

/** The parts of EventSource that the stream uses. Tests set `readyState` directly. */
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

function streamOf(sources: FakeSource[]) {
  const opened = vi.fn();
  const closed = vi.fn();
  const stream = new JobStream({
    open: () => source(sources.shift() as FakeSource),
    reopenDelay: () => 5000,
    timeout: () => 0,
    opened,
    changed: vi.fn(),
    closed,
  });
  return { stream, opened, closed };
}

afterEach(() => {
  vi.useRealTimers();
});

it('ends live updates while the browser reconnects the stream', () => {
  const fake = new FakeSource();
  const { stream, opened, closed } = streamOf([fake]);
  stream.start();
  fake.emit('open');
  expect(opened).toHaveBeenCalledTimes(1);
  // Opening the first stream also reports the initial closed state.
  const closes = closed.mock.calls.length;

  // A lost connection leaves a native EventSource in CONNECTING. It retries on its own.
  fake.readyState = 0;
  fake.emit('error');
  expect(closed).toHaveBeenCalledTimes(closes + 1);
  expect(stream.active).toBe(true);

  fake.readyState = 1;
  fake.emit('open');
  expect(opened).toHaveBeenCalledTimes(2);
  stream.stop();
});

it('reopens a stream that the browser closed', () => {
  vi.useFakeTimers();
  const first = new FakeSource();
  const second = new FakeSource();
  const { stream, opened } = streamOf([first, second]);
  stream.start();
  first.emit('open');

  first.readyState = 2;
  first.emit('error');
  expect(stream.active).toBe(false);
  vi.advanceTimersByTime(5000);

  second.emit('open');
  expect(opened).toHaveBeenCalledTimes(2);
  stream.stop();
});

it('ignores a lost connection of a replaced stream', () => {
  const first = new FakeSource();
  const second = new FakeSource();
  const { stream, opened, closed } = streamOf([first, second]);
  stream.start();
  first.emit('open');

  stream.restart();
  const closes = closed.mock.calls.length;
  // The replaced stream may also report a lost connection. It must not end the
  // live state of the stream that replaced it.
  first.readyState = 0;
  first.emit('error');
  expect(closed).toHaveBeenCalledTimes(closes);

  first.emit('open');
  expect(opened).toHaveBeenCalledTimes(1);
  second.emit('open');
  expect(opened).toHaveBeenCalledTimes(2);
  stream.stop();
});
