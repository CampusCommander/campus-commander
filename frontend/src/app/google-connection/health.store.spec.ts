import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { type GoogleHealth } from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { ConnectionStore } from './connection.store';
import { GoogleHealthStore } from './health.store';

function deferred() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const initial = (): GoogleHealth => ({
  customerId: 'C0123456',
  generation: 1,
  observedAt: new Date().toISOString(),
  backgroundFailure: null,
  check: null,
  capabilities: [
    {
      capability: 'customer-identity',
      scopeVerified: true,
      failure: null,
      checkedAt: new Date().toISOString(),
      lastSucceededAt: null,
      correlationId: null,
    },
    {
      capability: 'domain-observations',
      scopeVerified: true,
      failure: null,
      checkedAt: new Date().toISOString(),
      lastSucceededAt: null,
      correlationId: null,
    },
  ],
});
function fixture(request: ReturnType<typeof vi.fn>) {
  const session = signal({
    identity: { id: 'actor', permissionVersion: 1 },
    csrfToken: 'first',
  });
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AuthStore,
        useValue: {
          request,
          session,
          interrupted: () => false,
          can: () => true,
        },
      },
      {
        provide: ConnectionStore,
        useValue: { readable: () => true, connection: () => null },
      },
    ],
  });
  const store = TestBed.inject(GoogleHealthStore);
  TestBed.tick();
  return { store, session };
}

it('discards an older read that completes after the newer observation', async () => {
  const pending = deferred();
  const health = initial();
  const request = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(Response.json({ health }));
  const { store } = fixture(request);
  await store.refresh();
  pending.resolve(Response.json({ health: null }));
  await Promise.resolve();
  await Promise.resolve();
  expect(store.health()).toEqual(health);
  expect(store.unavailable()).toBe(false);
});

it('discards a delayed check response from the previous permission version', async () => {
  const health = initial();
  const pending = deferred();
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ health }))
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(Response.json({ health: null }));
  const { store, session } = fixture(request);
  await vi.waitFor(() => expect(store.loaded()).toBe(true));
  const checking = store.check(['domain-observations']);
  session.set({
    identity: { id: 'actor', permissionVersion: 2 },
    csrfToken: 'second',
  });
  TestBed.tick();
  await vi.waitFor(() => expect(store.health()).toBeNull());
  pending.resolve(Response.json({ health }));
  await checking;
  expect(store.health()).toBeNull();
  expect(store.message()).toBe('');
  expect(store.running()).toBe(false);
});

it('blocks duplicate checks and retains only historical results after an uncertain response', async () => {
  const health = initial();
  const pending = deferred();
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ health }))
    .mockReturnValueOnce(pending.promise);
  const { store } = fixture(request);
  await vi.waitFor(() => expect(store.loaded()).toBe(true));
  const first = store.check(['domain-observations']);
  await store.check(['customer-identity']);
  expect(request).toHaveBeenCalledTimes(2);
  pending.reject(new Error('offline'));
  await first;
  expect(store.health()).toEqual(health);
  expect(store.disabled()).toBe(true);
  expect(store.unavailable()).toBe(true);
  expect(store.summary()).toBe('Google status unavailable');
});
