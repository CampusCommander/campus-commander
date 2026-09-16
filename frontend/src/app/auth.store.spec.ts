import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { vi } from 'vitest';
import { AuthStore } from './auth.store';

const session = (
  csrfToken = 'a'.repeat(64),
  id = '11111111-1111-4111-8111-111111111111',
) => ({
  identity: {
    id,
    displayName: 'Fixture',
    permissionVersion: 1,
    permissions: ['identity:read'],
    preferences: { theme: 'system', navigationCollapsed: false },
    grants: [{ action: 'platform-users:read', scope: { kind: 'platform' } }],
  },
  csrfToken,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

async function initialize(phase = 3) {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  const router = {
    url: '/platform-users',
    navigateByUrl: vi.fn().mockResolvedValue(true),
  };
  TestBed.configureTestingModule({
    providers: [{ provide: Router, useValue: router }],
  });
  const auth = TestBed.inject(AuthStore);
  fetcher.mockResolvedValueOnce(
    response({
      phase,
      authenticationConfigured: true,
      version: 'fixture',
      build: 'fixture',
    }),
  );
  await auth.metadataReady();
  fetcher.mockResolvedValueOnce(response(session()));
  await auth.restore();
  return { auth, fetcher, router };
}

afterEach(() => vi.unstubAllGlobals());

it('keeps the current page and blocks requests until the same principal restores access', async () => {
  const { auth, fetcher, router } = await initialize();
  fetcher.mockResolvedValueOnce(response({ code: 'access-changed' }, 401));
  await auth.request('/api/platform-users');
  expect(auth.interrupted()).toBe(true);
  expect(auth.can('platform-users:read', { kind: 'platform' })).toBe(false);
  expect(router.navigateByUrl).not.toHaveBeenCalled();
  const calls = fetcher.mock.calls.length;
  expect((await auth.request('/api/platform-users')).status).toBe(401);
  expect(fetcher.mock.calls.length).toBe(calls);
  fetcher.mockResolvedValueOnce(response(session('b'.repeat(64))));
  await auth.resume();
  expect(auth.interrupted()).toBe(false);
  expect(auth.can('platform-users:read', { kind: 'platform' })).toBe(true);
});

it('does not interrupt a renewed session when an older request returns 401', async () => {
  const { auth, fetcher } = await initialize();
  let resolveOld: (value: Response) => void = () => {
    throw new Error('Request not started');
  };
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const old = auth.request('/api/platform-users');
  fetcher.mockResolvedValueOnce(response({ code: 'access-changed' }, 401));
  await auth.request('/api/platform-users');
  fetcher.mockResolvedValueOnce(response(session('b'.repeat(64))));
  await auth.resume();
  resolveOld(response({ code: 'access-changed' }, 401));
  await old;
  expect(auth.interrupted()).toBe(false);
  expect(auth.session()?.csrfToken).toBe('b'.repeat(64));
});

it('closes the previous principal draft instead of resuming it under another identity', async () => {
  const { auth, fetcher, router } = await initialize();
  fetcher.mockResolvedValueOnce(response({ code: 'access-changed' }, 401));
  await auth.request('/api/platform-users');
  fetcher.mockResolvedValueOnce(
    response(session('b'.repeat(64), '22222222-2222-4222-8222-222222222222')),
  );
  await auth.resume();
  expect(router.navigateByUrl).toHaveBeenCalledWith('/login');
  expect(auth.session()).toBe(null);
  expect(auth.interrupted()).toBe(false);
});

it('revokes the current browser session when signing out from an interrupted tab', async () => {
  const { auth, fetcher, router } = await initialize();
  fetcher.mockResolvedValueOnce(response({ code: 'access-changed' }, 401));
  await auth.request('/api/platform-users');
  fetcher.mockResolvedValueOnce(response(session('b'.repeat(64))));
  fetcher.mockResolvedValueOnce(response({}));
  await auth.logout();
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/auth/logout',
    expect.objectContaining({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': 'b'.repeat(64),
      },
    }),
  );
  expect(router.navigateByUrl).toHaveBeenCalledWith('/login');
  expect(auth.interrupted()).toBe(false);
});

it('preserves the Phase 2 sign-in redirect after session expiry', async () => {
  const { auth, fetcher, router } = await initialize(2);
  fetcher.mockResolvedValueOnce(response({ code: 'unauthenticated' }, 401));
  await auth.request('/api/auth/session');
  expect(router.navigateByUrl).toHaveBeenCalledWith('/login');
  expect(auth.interrupted()).toBe(false);
});

it('ignores an old unauthorized body that finishes after access recovery', async () => {
  const { auth, fetcher } = await initialize();
  let finishBody: () => void = () => {
    throw new Error('Response not started');
  };
  const stream = new ReadableStream({
    start(controller) {
      finishBody = () => {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ code: 'access-changed' })),
        );
        controller.close();
      };
    },
  });
  const delayed = new Response(stream, { status: 401 });
  const clone = vi.spyOn(delayed, 'clone');
  fetcher.mockResolvedValueOnce(delayed);
  const old = auth.request('/api/platform-users');
  await vi.waitFor(() => expect(clone).toHaveBeenCalled());
  fetcher.mockResolvedValueOnce(response({ code: 'access-changed' }, 401));
  await auth.request('/api/platform-users');
  fetcher.mockResolvedValueOnce(response(session('b'.repeat(64))));
  await auth.resume();
  finishBody();
  await old;
  expect(auth.interrupted()).toBe(false);
  expect(auth.session()?.csrfToken).toBe('b'.repeat(64));
});
