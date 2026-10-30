import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import {
  GOOGLE_CAPABILITIES,
  GOOGLE_HEALTH_CAPABILITY_IDS,
  GOOGLE_SETUP_SCOPES,
  delegationLinkScopes,
  type GoogleConnection,
  type GoogleHealth,
} from '@campus/application-contracts';
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
  capabilities: GOOGLE_HEALTH_CAPABILITY_IDS.map((capability) => ({
    capability,
    scopeVerified: true,
    failure: null,
    checkedAt: new Date().toISOString(),
    lastSucceededAt: null,
    correlationId: null,
  })),
});
function fixture(
  request: ReturnType<typeof vi.fn>,
  connection: GoogleConnection | null = null,
) {
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
        useValue: { readable: () => true, connection: () => connection },
      },
    ],
  });
  const store = TestBed.inject(GoogleHealthStore);
  TestBed.tick();
  return { store, session };
}

function connected(): GoogleConnection {
  return {
    customerId: 'C0123456',
    generation: 1,
    clientId: '123456789',
    subject: 'admin@example.org',
    observedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    observation: {
      customerId: 'C0123456',
      primaryDomain: 'example.org',
      domains: [
        {
          name: 'example.org',
          primary: true,
          verified: true,
          aliases: [],
        },
      ],
    },
  };
}

const SCHOOL_OU =
  'https://www.googleapis.com/auth/admin.directory.orgunit.readonly';

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

it('reports a capability that was never checked as out of date', async () => {
  const health = initial();
  for (const item of health.capabilities)
    if (
      item.capability !== 'customer-identity' &&
      item.capability !== 'domain-observations'
    ) {
      item.scopeVerified = false;
      item.checkedAt = null;
      item.lastSucceededAt = null;
    }
  const request = vi.fn().mockResolvedValue(Response.json({ health }));
  const { store } = fixture(request);
  await store.refresh();
  expect(store.stale(null)).toBe(true);
  expect(store.summary()).toBe('Google results are out of date');
});

it('lists all seven capabilities in contract order', () => {
  const request = vi.fn().mockResolvedValue(Response.json({ health: null }));
  const { store } = fixture(request);
  expect(store.capabilities.map((item) => item.id)).toEqual(
    GOOGLE_HEALTH_CAPABILITY_IDS,
  );
});

it('requests all seven capabilities from Check Google access', async () => {
  const request = vi
    .fn()
    .mockResolvedValue(Response.json({ health: initial() }));
  const { store } = fixture(request);
  await vi.waitFor(() => expect(store.loaded()).toBe(true));
  await store.check();
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1][0]).toBe('/api/google-connection/health/check');
  expect(request.mock.calls[1][1]).toMatchObject({
    capabilities: GOOGLE_HEALTH_CAPABILITY_IDS,
  });
});

it('counts a failed school OU check, because setup grants its scope', async () => {
  const health = initial();
  const school = health.capabilities.find(
    (item) => item.capability === 'school-ou-references',
  )!;
  school.failure = 'scope-mismatch';
  school.scopeVerified = false;
  school.checkedAt = null;
  const request = vi.fn().mockResolvedValue(Response.json({ health }));
  const { store } = fixture(request);
  await vi.waitFor(() => expect(store.loaded()).toBe(true));
  expect(store.summary()).toBe('Google: 1 of 7 capabilities need attention');
});

it('counts a failed setup capability out of the seven', async () => {
  const health = initial();
  health.capabilities.find(
    (item) => item.capability === 'device-changes',
  )!.failure = 'scope-mismatch';
  const request = vi.fn().mockResolvedValue(Response.json({ health }));
  const { store } = fixture(request);
  await vi.waitFor(() => expect(store.loaded()).toBe(true));
  expect(store.summary()).toBe('Google: 1 of 7 capabilities need attention');
});

it('lists the setup scopes plus every verified scope once in the delegation link', async () => {
  const request = vi
    .fn()
    .mockResolvedValue(Response.json({ health: initial() }));
  const { store } = fixture(request, connected());
  await vi.waitFor(() => expect(store.loaded()).toBe(true));
  const href = store.delegationHref();
  expect(href).not.toBeNull();
  const url = new URL(href!);
  expect(url.searchParams.get('clientScopeToAdd')).toBe(
    delegationLinkScopes(
      GOOGLE_SETUP_SCOPES,
      GOOGLE_CAPABILITIES.map((capability) => capability.scope),
    ).join(','),
  );
  expect(url.searchParams.get('clientScopeToAdd')).toContain(SCHOOL_OU);
  expect(url.searchParams.get('clientIdToAdd')).toBe('123456789');
  expect(url.searchParams.get('overwriteClientId')).toBe('true');
  expect(url.searchParams.get('dn')).toBe('example.org');
});

it('keeps an unverified school OU scope in the delegation link', async () => {
  const health = initial();
  const school = health.capabilities.find(
    (item) => item.capability === 'school-ou-references',
  )!;
  school.failure = 'scope-mismatch';
  school.scopeVerified = false;
  const request = vi.fn().mockResolvedValue(Response.json({ health }));
  const { store } = fixture(request, connected());
  await vi.waitFor(() => expect(store.loaded()).toBe(true));
  const scopes = new URL(store.delegationHref()!).searchParams
    .get('clientScopeToAdd')!
    .split(',');
  expect(scopes).toEqual(delegationLinkScopes(GOOGLE_SETUP_SCOPES, []));
  expect(scopes).toContain(SCHOOL_OU);
});

it('shows no delegation link without a client ID', async () => {
  const request = vi
    .fn()
    .mockResolvedValue(Response.json({ health: initial() }));
  const { store } = fixture(request, null);
  await vi.waitFor(() => expect(store.loaded()).toBe(true));
  expect(store.delegationHref()).toBeNull();
});

it('shows no delegation link without a health answer', async () => {
  const request = vi.fn().mockResolvedValue(Response.json({ health: null }));
  const { store } = fixture(request, connected());
  await vi.waitFor(() => expect(store.loaded()).toBe(true));
  expect(store.delegationHref()).toBeNull();
});
