import assert from 'node:assert/strict';
import test from 'node:test';
import { recheckJobStream } from './jobs-stream.ts';

const CUSTOMER = 'C0123456';
const ACTOR = '44444444-4444-4444-8444-444444444444';

const session = (grants = []) => ({
  identity: {
    id: ACTOR,
    displayName: 'Grace Hopper',
    permissions: ['identity:read'],
    permissionVersion: 1,
    grants,
    preferences: { theme: 'system', navigationCollapsed: false },
  },
  expiresAt: '2026-10-06T13:00:00.000Z',
  csrfToken: 'a'.repeat(64),
});

const district = (customerId = CUSTOMER) => ({ kind: 'district', customerId });

/** The session check, the read of the customer, and the arguments each call received. */
function ping({
  next = session([{ action: 'jobs:read', scope: district() }]),
  customer = CUSTOMER,
  failure = null,
} = {}) {
  const calls = { authenticate: [], customer: [] };
  const auth = {
    async authenticate(cookie, action, correlationId, options) {
      calls.authenticate.push([cookie, action, correlationId, options]);
      if (failure) throw failure;
      return next;
    },
  };
  const jobs = {
    async customer(seen) {
      calls.customer.push(seen);
      return typeof customer === 'function' ? customer(seen) : customer;
    },
  };
  return {
    calls,
    run: (everyJob, overrides = {}) =>
      recheckJobStream({
        auth,
        jobs,
        cookie: 'sid=abc',
        correlationId: 'correlation-1',
        customerId: CUSTOMER,
        everyJob,
        ...overrides,
      }),
  };
}

test('a ping rechecks identity without sliding the session and keeps the stream', async () => {
  const probe = ping();
  const checked = await probe.run(true);
  assert.equal(checked.allowed, true);
  assert.equal(checked.session.identity.id, ACTOR);
  assert.deepEqual(probe.calls.authenticate, [
    ['sid=abc', 'identity:read', 'correlation-1', { slide: false }],
  ]);
});

test('a ping closes the stream when the caller may no longer read the customer', async () => {
  const checked = await ping({ customer: 'C0999999' }).run(true);
  assert.equal(checked.allowed, false);
  assert.equal(checked.session.identity.id, ACTOR);
});

test('a ping closes the stream when jobs:read is removed from a holder of every job', async () => {
  const checked = await ping({
    next: session([{ action: 'devices:read', scope: district() }]),
  }).run(true);
  assert.equal(checked.allowed, false);
});

test('a ping keeps the stream of a caller that reads only its own jobs', async () => {
  const checked = await ping({
    next: session([{ action: 'devices:read', scope: district() }]),
  }).run(false);
  assert.equal(checked.allowed, true);
});

test('a ping closes the stream when the session check fails', async () => {
  const checked = await ping({ failure: new Error('session-expired') }).run(
    true,
  );
  assert.deepEqual(checked, { allowed: false, session: null });
});

test('a ping closes the stream when the read actions were removed', async () => {
  const checked = await ping({
    next: session([]),
    customer: () => {
      throw Object.assign(new Error('forbidden'), { code: '42501' });
    },
  }).run(false);
  assert.deepEqual(checked, { allowed: false, session: null });
});
