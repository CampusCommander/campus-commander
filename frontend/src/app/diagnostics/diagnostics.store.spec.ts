import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { DiagnosticsStore } from './diagnostics.store';

const maya = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const alex = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const person = (id: string, permissions: string[] = ['diagnostics:read']) => ({
  identity: {
    id,
    displayName: id === alex ? 'Alex Rivera' : 'Maya Chen',
    permissionVersion: 1,
    permissions,
    grants: [],
    preferences: { theme: 'light' as const, navigationCollapsed: false },
  },
  csrfToken: 'a'.repeat(64),
  expiresAt: '2026-10-20T12:00:00.000Z',
});

const serviceHealth = (status: 'ready' | 'not-ready') => ({
  status,
  observedAt: new Date().toISOString(),
  checks: [{ name: 'PostgreSQL', status }],
});

const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

/**
 * Drains microtasks until the condition holds. Node 22 resolves a Response body
 * through more microtasks than Node 24, so a fixed tick count is not portable.
 */
const settle = async (condition: () => boolean) => {
  for (let index = 0; index < 100 && !condition(); index++) {
    await Promise.resolve();
  }
};

function setup(
  request: (path: string) => Promise<Response>,
  permissions = ['diagnostics:read'],
) {
  const session = signal<ReturnType<typeof person> | null>(
    person(maya, permissions),
  );
  TestBed.configureTestingModule({
    providers: [{ provide: AuthStore, useValue: { session, request } }],
  });
  return { store: TestBed.inject(DiagnosticsStore), session };
}

afterEach(() => vi.useRealTimers());

it('keeps the status fresh while the timed reads continue', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
  const request = vi.fn(async () => Response.json(serviceHealth('ready')));
  const { store } = setup(request);
  store.watch();
  await flush();

  await vi.advanceTimersByTimeAsync(61_000);
  await flush();

  expect(request).toHaveBeenCalledTimes(3);
  expect(store.stale()).toBe(false);
  expect(store.ageSeconds()).toBeLessThan(60);
});

it('keeps one read in flight', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
  const answers: ((response: Response) => void)[] = [];
  const request = vi.fn(
    () => new Promise<Response>((resolve) => answers.push(resolve)),
  );
  const { store } = setup(request);
  store.watch();
  expect(request).toHaveBeenCalledTimes(1);

  // The timed read joins the read that has not answered yet.
  await vi.advanceTimersByTimeAsync(30_000);
  expect(request).toHaveBeenCalledTimes(1);

  answers[0](Response.json(serviceHealth('ready')));
  await flush();
  expect(store.health()?.status).toBe('ready');
});

it('drops a late answer for an earlier person', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
  const answers: ((response: Response) => void)[] = [];
  const request = vi.fn(
    () => new Promise<Response>((resolve) => answers.push(resolve)),
  );
  const { store, session } = setup(request);
  store.watch();
  expect(request).toHaveBeenCalledTimes(1);

  session.set(person(alex));
  TestBed.tick();
  expect(request).toHaveBeenCalledTimes(2);

  // Maya's answer arrives after Alex signed in. It changes nothing.
  answers[0](Response.json(serviceHealth('not-ready')));
  await flush();
  expect(store.health()).toBeNull();

  answers[1](Response.json(serviceHealth('ready')));
  await flush();
  expect(store.health()?.status).toBe('ready');
});

it('stops the timed reads after a sign-out', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
  const request = vi.fn(async () => Response.json(serviceHealth('ready')));
  const { store, session } = setup(request);
  store.watch();
  await flush();
  expect(request).toHaveBeenCalledTimes(1);

  session.set(null);
  TestBed.tick();
  await vi.advanceTimersByTimeAsync(61_000);
  await flush();

  expect(request).toHaveBeenCalledTimes(1);
});

it('starts no read without diagnostics:read', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
  const request = vi.fn(async () => Response.json(serviceHealth('ready')));
  const { store } = setup(request, ['schools:read']);
  store.watch();

  await vi.advanceTimersByTimeAsync(61_000);
  await flush();

  expect(request).not.toHaveBeenCalled();
});

it('runs a queued manual read after the active read for the same person', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
  const answers: ((response: Response) => void)[] = [];
  const request = vi.fn(
    () => new Promise<Response>((resolve) => answers.push(resolve)),
  );
  const { store } = setup(request);
  store.watch();
  const refresh = store.refresh();
  expect(request).toHaveBeenCalledTimes(1);

  answers[0](Response.json(serviceHealth('ready')));
  await settle(() => request.mock.calls.length === 2);
  expect(request).toHaveBeenCalledTimes(2);

  answers[1](Response.json(serviceHealth('not-ready')));
  await refresh;
  await flush();

  expect(request).toHaveBeenCalledTimes(2);
  expect(store.health()?.status).toBe('not-ready');
  expect(store.refreshing()).toBe(false);
});

it('drops a queued manual read after a sign-out', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
  const answers: ((response: Response) => void)[] = [];
  const request = vi.fn(
    () => new Promise<Response>((resolve) => answers.push(resolve)),
  );
  const { store, session } = setup(request);
  store.watch();
  const refresh = store.refresh();

  // The person signs out while the timed read has not answered.
  session.set(null);
  TestBed.tick();
  store.unwatch();
  answers[0](Response.json(serviceHealth('ready')));
  await refresh;
  await flush();
  await vi.advanceTimersByTimeAsync(61_000);
  await flush();

  // The queued read did not start under the empty session.
  expect(request).toHaveBeenCalledTimes(1);
  expect(store.health()).toBeNull();
  expect(store.error()).toBeNull();
  expect(store.stale()).toBe(false);
  expect(store.refreshing()).toBe(false);
});

it('drops a queued manual read when another person signs in', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
  const answers: ((response: Response) => void)[] = [];
  const request = vi.fn(
    () => new Promise<Response>((resolve) => answers.push(resolve)),
  );
  const { store, session } = setup(request);
  store.watch();
  const refresh = store.refresh();

  session.set(person(alex));
  TestBed.tick();
  expect(request).toHaveBeenCalledTimes(2);

  // Maya's timed read answers late. The refresh she queued must not follow it.
  answers[0](Response.json(serviceHealth('not-ready')));
  await refresh;
  await flush();
  expect(request).toHaveBeenCalledTimes(2);

  answers[1](Response.json(serviceHealth('ready')));
  await flush();

  expect(store.health()?.status).toBe('ready');
  expect(store.error()).toBeNull();
});
