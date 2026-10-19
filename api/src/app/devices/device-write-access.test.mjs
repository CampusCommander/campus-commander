import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
  GOOGLE_HEALTH_FRESH_SECONDS,
  deviceWriteAccessMessage,
  deviceWriteAccessSchema,
} from '@campus/application-contracts';
import { GoogleConnectionError } from '@campus/google-connection';
import { DeviceWriteAccess } from './device-write-access.ts';

const writeScope =
  'https://www.googleapis.com/auth/admin.directory.device.chromeos';
const customer = 'C0123456';
const actor = '11111111-1111-4111-8111-111111111111';
const session = {
  identity: {
    id: actor,
    displayName: 'Test person',
    permissions: [],
    permissionVersion: 1,
    grants: [],
    preferences: {},
  },
  expiresAt: '2026-10-19T12:00:00.000Z',
  csrfToken: 'a'.repeat(64),
};
const context = { customerId: customer, generation: 1 };
const credential = {
  serviceAccount: {
    client_email: 'service@example.org',
    private_key: 'unused',
    private_key_id: '1'.repeat(40),
    client_id: '100000000000000000001',
  },
  subject: 'administrator@example.org',
};

/** A store that records each cache write and answers the configured values. */
function createStore(overrides = {}) {
  const writes = [];
  return {
    writes,
    credential: async () => credential,
    read: async () => null,
    write: async (target, access, seconds) => {
      writes.push({ target, access, seconds });
    },
    ...overrides,
  };
}

/** A client factory that records each request and answers the configured result. */
function createClient({ data = {}, error } = {}) {
  const requests = [];
  const calls = [];
  return {
    requests,
    calls,
    factory: async (received, scope, signal) => {
      calls.push({ received, scope, signal });
      return {
        request: async (options) => {
          requests.push(options);
          if (error) throw error;
          return { data };
        },
      };
    },
  };
}

const exactMessage =
  'Google denied device changes. Add https://www.googleapis.com/auth/admin.directory.device.chromeos to the delegation client in the Google Admin Console.';

test('a check mints the write scope alone and lists one device without a write', async () => {
  const store = createStore();
  const fake = createClient();
  const result = await new DeviceWriteAccess(store, fake.factory).check(
    session,
    context,
  );
  assert.equal(result.state, 'granted');
  assert.equal(result.scope, writeScope);
  assert.equal(result.failure, null);
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].received, credential);
  assert.equal(fake.calls[0].scope, writeScope);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].method, 'GET');
  assert.equal(
    fake.requests[0].url,
    `https://admin.googleapis.com/admin/directory/v1/customer/${customer}/devices/chromeos`,
  );
  assert.equal(fake.requests[0].params.maxResults, 1);
  assert.equal(store.writes.length, 1);
  assert.deepEqual(store.writes[0].target, context);
  assert.deepEqual(store.writes[0].access, result);
  assert.equal(store.writes[0].seconds, GOOGLE_HEALTH_FRESH_SECONDS);
  assert.equal(
    deviceWriteAccessSchema.parse(store.writes[0].access).state,
    'granted',
  );
});

test('a removed write scope denies access with the exact message', async () => {
  const fake = createClient({
    error: {
      response: {
        status: 401,
        data: {
          error: 'unauthorized_client',
          error_description: 'Unauthorized',
        },
      },
    },
  });
  const result = await new DeviceWriteAccess(createStore(), fake.factory).check(
    session,
    context,
  );
  assert.equal(result.state, 'denied');
  assert.equal(result.failure, 'delegation-not-authorized');
  assert.equal(result.scope, writeScope);
  assert.equal(DEVICE_WRITE_ACCESS_DENIED_MESSAGE, exactMessage);
  assert.equal(deviceWriteAccessMessage(result), exactMessage);
});

test('a revoked delegation denies access', async () => {
  const fake = createClient({
    error: new GoogleConnectionError('delegation-not-authorized'),
  });
  const result = await new DeviceWriteAccess(createStore(), fake.factory).check(
    session,
    context,
  );
  assert.equal(result.state, 'denied');
  assert.equal(result.failure, 'delegation-not-authorized');
});

test('a scope mismatch denies access', async () => {
  const fake = createClient({
    error: new GoogleConnectionError('scope-mismatch'),
  });
  const result = await new DeviceWriteAccess(createStore(), fake.factory).check(
    session,
    context,
  );
  assert.equal(result.state, 'denied');
  assert.equal(result.failure, 'scope-mismatch');
});

test('a network-failure mint leaves access unavailable, never denied', async () => {
  const timeout = Object.assign(new Error('socket hang up'), {
    code: 'ETIMEDOUT',
  });
  const fake = createClient({ error: timeout });
  const result = await new DeviceWriteAccess(createStore(), fake.factory).check(
    session,
    context,
  );
  assert.equal(result.state, 'unavailable');
  assert.equal(result.failure, 'network-failure');
  assert.notEqual(result.state, 'denied');
});

test('a provider-unavailable mint leaves access unavailable, never denied', async () => {
  const fake = createClient({ error: { response: { status: 503 } } });
  const result = await new DeviceWriteAccess(createStore(), fake.factory).check(
    session,
    context,
  );
  assert.equal(result.state, 'unavailable');
  assert.equal(result.failure, 'provider-unavailable');
  assert.notEqual(result.state, 'denied');
});

test('a 403 on the list reads unavailable with permission-denied', async () => {
  const fake = createClient({
    error: {
      response: {
        status: 403,
        data: {
          error: {
            errors: [{ reason: 'forbidden' }],
          },
        },
      },
    },
  });
  const result = await new DeviceWriteAccess(createStore(), fake.factory).check(
    session,
    context,
  );
  assert.equal(result.state, 'unavailable');
  assert.equal(result.failure, 'permission-denied');
});

test('a check without a credential reads unchecked and sends no request', async () => {
  const store = createStore({ credential: async () => null });
  const fake = createClient();
  const result = await new DeviceWriteAccess(store, fake.factory).check(
    session,
    context,
  );
  assert.equal(result.state, 'unchecked');
  assert.equal(result.scope, null);
  assert.equal(result.failure, null);
  assert.equal(result.checkedAt, null);
  assert.equal(fake.calls.length, 0);
});

test('a read answers the cached state and unchecked without one', async () => {
  const cached = {
    state: 'denied',
    scope: writeScope,
    failure: 'delegation-not-authorized',
    checkedAt: '2026-10-19T10:00:00.000Z',
  };
  const stored = await new DeviceWriteAccess(
    createStore({ read: async () => cached }),
    createClient().factory,
  ).read(session, context);
  assert.deepEqual(stored, cached);
  const missing = await new DeviceWriteAccess(
    createStore({ read: async () => null }),
    createClient().factory,
  ).read(session, context);
  assert.deepEqual(missing, {
    state: 'unchecked',
    scope: null,
    failure: null,
    checkedAt: null,
  });
});
