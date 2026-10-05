import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { DevicesStore } from './devices.store';

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
  session = signal(sessionFor('actor')),
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
  store.pollInterval = 0;
  return store;
}

it('queries rows with the active filters and sort and keeps the counts', async () => {
  const request = vi.fn().mockResolvedValue(Response.json({ page }));
  const store = setup(request);
  store.setPredicates([
    { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
  ]);
  store.setSort({ field: 'assetTag', direction: 'desc' });
  await store.rows(100, 100);
  expect(request).toHaveBeenCalledWith('/api/devices/query', {
    predicates: [{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }],
    sort: { field: 'assetTag', direction: 'desc' },
    offset: 100,
    limit: 100,
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

it('polls a refresh until it settles and reloads with the same filters', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ sync: state('running') }, { status: 201 }),
    )
    .mockResolvedValueOnce(Response.json({ sync: state('running') }))
    .mockResolvedValueOnce(Response.json({ sync: state('ready') }));
  const store = setup(request);
  store.setPredicates([
    { field: 'model', operator: 'contains', value: 'Lenovo' },
  ]);
  const before = store.revision();
  await store.refreshAll();
  expect(request).toHaveBeenNthCalledWith(1, '/api/devices/sync', {});
  expect(store.sync()?.status).toBe('ready');
  expect(store.revision()).toBe(before + 1);
  expect(store.predicates()).toEqual([
    { field: 'model', operator: 'contains', value: 'Lenovo' },
  ]);
});

it('follows a refresh that is already running', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ reason: 'device-sync-running' }, { status: 409 }),
    )
    .mockResolvedValueOnce(Response.json({ sync: state('running') }))
    .mockResolvedValueOnce(Response.json({ sync: state('ready') }));
  const store = setup(request);
  await store.refreshAll();
  expect(store.sync()?.status).toBe('ready');
  expect(store.error()).toBe('');
});

it('changing filters reloads the grid and forgets the row position', () => {
  const store = setup(vi.fn());
  store.position.set({ index: 4, deviceId: 'd4' });
  const before = store.revision();
  store.setPredicates([{ field: 'notes', operator: 'isEmpty' }]);
  expect(store.revision()).toBe(before + 1);
  expect(store.position()).toBeNull();
});

it('resumes following a running refresh after Reconnect', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ sync: state('running') }, { status: 201 }),
    )
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(Response.json({ sync: state('running') }))
    .mockResolvedValueOnce(Response.json({ sync: state('ready') }));
  const store = setup(request);
  await store.refreshAll();
  expect(store.offline()).toBe(true);
  expect(store.sync()?.status).toBe('running');
  const before = store.revision();
  await store.reconnect();
  expect(store.sync()?.status).toBe('ready');
  expect(store.revision()).toBe(before + 1);
});

it('stops following a refresh when the session ends', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ sync: state('running') }, { status: 201 }),
    )
    .mockResolvedValue(
      Response.json({ code: 'access-changed' }, { status: 401 }),
    );
  const store = setup(request);
  await store.refreshAll();
  expect(request).toHaveBeenCalledTimes(2);
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
  store.setPredicates([{ field: 'notes', operator: 'isEmpty' }]);
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
  session.set(sessionFor('someone-else'));
  TestBed.tick();
  expect(store.predicates()).toEqual([]);
  expect(store.position()).toBeNull();
});
