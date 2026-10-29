import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { expiryClock, MAX_NATIVE_TIMER_MS } from './expiry-clock';

const DAY = 24 * 60 * 60 * 1000;
/** The retention of a fresh export file (design section 1). */
const RETENTION = 30 * DAY;

@Component({
  selector: 'app-expiry-probe',
  template: '',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class ExpiryProbe {
  readonly deadline = signal<string | null>(null);
  readonly now = expiryClock(() => this.deadline());
}

/** Every delay that a native timer receives, in call order. */
function recordNativeDelays(): number[] {
  const delays: number[] = [];
  const fakeSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    delays.push(delay ?? 0);
    return fakeSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout);
  return delays;
}

function setup() {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(ExpiryProbe);
  fixture.detectChanges();
  return { fixture, probe: fixture.componentInstance };
}

/** Runs the armed waits, the effect, and the view at the current fake time. */
function settle(fixture: { detectChanges: () => void }) {
  TestBed.tick();
  fixture.detectChanges();
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('reaches a 30-day deadline through bounded native waits', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T12:00:00.000Z'));
  const delays = recordNativeDelays();
  const { fixture, probe } = setup();
  const start = Date.now();
  const deadline = start + RETENTION;
  probe.deadline.set(new Date(deadline).toISOString());
  settle(fixture);
  expect(probe.now()).toBe(start);
  // The retention exceeds the native range, so one wait cannot carry it.
  expect(Math.max(...delays)).toBe(MAX_NATIVE_TIMER_MS);
  expect(Math.max(...delays)).toBeLessThan(RETENTION);

  // A day before the deadline the file is still ready.
  await vi.advanceTimersByTimeAsync(RETENTION - DAY);
  expect(probe.now()).toBeLessThan(deadline);

  // The bounded waits continue, so the deadline still arrives without a job event.
  await vi.advanceTimersByTimeAsync(2 * DAY);
  expect(probe.now()).toBeGreaterThanOrEqual(deadline);
  expect(delays.every((delay) => delay <= MAX_NATIVE_TIMER_MS)).toBe(true);
});

it('reaches a short deadline at its millisecond', async () => {
  vi.useFakeTimers();
  const { fixture, probe } = setup();
  const start = Date.now();
  const deadline = start + 1_000;
  probe.deadline.set(new Date(deadline).toISOString());
  settle(fixture);

  await vi.advanceTimersByTimeAsync(999);
  expect(probe.now()).toBe(start);
  await vi.advanceTimersByTimeAsync(2);
  expect(probe.now()).toBeGreaterThanOrEqual(deadline);
});

it('stops watching when the deadline clears', async () => {
  vi.useFakeTimers();
  const { fixture, probe } = setup();
  const start = Date.now();
  probe.deadline.set(new Date(start + RETENTION).toISOString());
  settle(fixture);
  probe.deadline.set(null);
  settle(fixture);
  const held = probe.now();

  await vi.advanceTimersByTimeAsync(RETENTION + DAY);
  expect(probe.now()).toBe(held);
});

it('stops the pending wait when the host is destroyed', async () => {
  vi.useFakeTimers();
  const { fixture, probe } = setup();
  const start = Date.now();
  probe.deadline.set(new Date(start + RETENTION).toISOString());
  settle(fixture);
  const held = probe.now();
  fixture.destroy();

  await vi.advanceTimersByTimeAsync(RETENTION + DAY);
  expect(probe.now()).toBe(held);
});
