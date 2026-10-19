import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import type { DeviceWriteAccess } from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { DEVICE_WRITE_ACCESS_BUSY_MESSAGE } from './device-update-messages';
import { DeviceWriteAccessStore } from './device-write-access.store';

const granted: DeviceWriteAccess = {
  state: 'granted',
  scope: 'https://www.googleapis.com/auth/admin.directory.device.chromeos',
  failure: null,
  checkedAt: '2026-10-19T12:00:00.000Z',
};

function setup(answer: (path: string) => Promise<Response>) {
  const request = vi.fn(answer);
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AuthStore,
        useValue: { session: signal(null), request },
      },
    ],
  });
  return { store: TestBed.inject(DeviceWriteAccessStore), request };
}

it('reads and keeps the write access state', async () => {
  const { store, request } = setup(async () =>
    Response.json(granted, { status: 200 }),
  );
  expect(await store.load()).toEqual(granted);
  expect(request).toHaveBeenCalledWith('/api/devices/updates/access');
  expect(store.access()).toEqual(granted);
  expect(store.state()).toBe('granted');
  expect(store.message()).toBe('');
});

it('keeps a message when the read is denied', async () => {
  const { store } = setup(async () =>
    Response.json({ reason: 'forbidden' }, { status: 403 }),
  );
  expect(await store.load()).toBeNull();
  expect(store.message()).toBe('You do not have permission to change devices.');
});

it('reports an unreadable read answer', async () => {
  const { store } = setup(async () => Response.json({ state: 'maybe' }));
  expect(await store.load()).toBeNull();
  expect(store.message()).toBe(
    'The Google write access answer was not readable. Check it again.',
  );
});

it('shares one read between concurrent callers and reads again later', async () => {
  const { store, request } = setup(async () =>
    Response.json(granted, { status: 200 }),
  );
  await Promise.all([store.load(), store.load()]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(await store.load()).toEqual(granted);
  expect(request).toHaveBeenCalledTimes(2);
});

it('replaces a granted answer when a later read is denied', async () => {
  let state: DeviceWriteAccess['state'] = 'granted';
  const { store, request } = setup(async () =>
    Response.json({
      ...granted,
      state,
      failure: state === 'denied' ? 'scope-mismatch' : null,
    }),
  );
  expect(await store.load()).toMatchObject({ state: 'granted' });
  state = 'denied';
  expect(await store.load()).toMatchObject({ state: 'denied' });
  expect(store.state()).toBe('denied');
  expect(request).toHaveBeenCalledTimes(2);
});

it('returns from denied to granted on a later read', async () => {
  let state: DeviceWriteAccess['state'] = 'denied';
  const { store, request } = setup(async () =>
    Response.json({
      ...granted,
      state,
      failure: state === 'denied' ? 'scope-mismatch' : null,
    }),
  );
  expect(await store.load()).toMatchObject({ state: 'denied' });
  state = 'granted';
  expect(await store.load()).toMatchObject({ state: 'granted' });
  expect(store.state()).toBe('granted');
  expect(request).toHaveBeenCalledTimes(2);
});

it('drops a kept grant when a later read fails', async () => {
  let fail = false;
  const { store } = setup(async () =>
    fail
      ? Response.json({ reason: 'unavailable' }, { status: 503 })
      : Response.json(granted),
  );
  expect(await store.load()).toEqual(granted);
  fail = true;
  expect(await store.load()).toBeNull();
  expect(store.access()).toBeNull();
  expect(store.message()).toBe('Google write access is unavailable.');
});

it('drops a kept grant when a later read cannot reach the server', async () => {
  let fail = false;
  const { store } = setup(async () => {
    if (fail) throw new Error('offline');
    return Response.json(granted);
  });
  expect(await store.load()).toEqual(granted);
  fail = true;
  expect(await store.load()).toBeNull();
  expect(store.access()).toBeNull();
  expect(store.message()).toBe(
    'Cannot reach Campus Commander. Check Google write access when the connection returns.',
  );
});

it('runs the check and keeps its answer', async () => {
  const { store, request } = setup(async (path) =>
    path.endsWith('/check')
      ? Response.json({
          ...granted,
          state: 'denied',
          failure: 'scope-mismatch',
        })
      : Response.json(granted),
  );
  await store.check();
  expect(request).toHaveBeenCalledWith('/api/devices/updates/access/check', {});
  expect(store.access()?.state).toBe('denied');
  expect(store.message()).toBe('');
});

it('shows the busy message on a 429 busy answer', async () => {
  const { store } = setup(async () =>
    Response.json({ reason: 'busy' }, { status: 429 }),
  );
  await store.load();
  store.access.set(granted);
  await store.check();
  expect(store.message()).toBe(DEVICE_WRITE_ACCESS_BUSY_MESSAGE);
  expect(store.access()).toEqual(granted);
});

it('reports a check that did not finish', async () => {
  const { store } = setup(async () =>
    Response.json({ reason: 'unavailable' }, { status: 503 }),
  );
  await store.check();
  expect(store.message()).toBe(
    'The Google write access check did not finish. Try again.',
  );
});
