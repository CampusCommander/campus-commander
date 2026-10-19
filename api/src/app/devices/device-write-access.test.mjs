import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
  GOOGLE_HEALTH_FRESH_SECONDS,
  deviceWriteAccessMessage,
  deviceWriteAccessSchema,
  googleFailureSchema,
} from '@campus/application-contracts';
import { GoogleConnectionError } from '@campus/google-connection';
import {
  DEVICE_WRITE_ACCESS_INTERVAL_SECONDS,
  DeviceWriteAccess,
  WriteAccessBusyError,
} from './device-write-access.ts';

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

/** A store that records each credential read and cache write. */
function createStore(overrides = {}) {
  const writes = [];
  const credentials = [];
  return {
    writes,
    credentials,
    reserve: async () => true,
    credential: async (_session, target) => {
      credentials.push(target);
      return credential;
    },
    read: async () => null,
    write: async (target, access, seconds) => {
      writes.push({ target, access, seconds });
    },
    ...overrides,
  };
}

/** A client factory that records each mint and answers the configured result. */
function createClient({ data = {}, error, mintError } = {}) {
  const requests = [];
  const calls = [];
  return {
    requests,
    calls,
    factory: async (received, scope, signal) => {
      calls.push({ received, scope, signal });
      if (mintError) throw mintError;
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
const writeMethods = ['PATCH', 'POST', 'PUT', 'DELETE'];

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
  assert.equal(fake.calls.length, 1, 'The check mints one token.');
  assert.equal(fake.calls[0].received, credential);
  assert.equal(
    typeof fake.calls[0].scope,
    'string',
    'The token request carries one scope.',
  );
  assert.equal(
    fake.calls[0].scope,
    writeScope,
    'The one scope is the write scope.',
  );
  assert.equal(fake.requests.length, 1, 'The check sends one request.');
  assert.equal(fake.requests[0].method, 'GET');
  assert.equal(
    fake.requests[0].url,
    `https://admin.googleapis.com/admin/directory/v1/customer/${customer}/devices/chromeos`,
  );
  assert.deepEqual(fake.requests[0].params, {
    maxResults: 1,
    fields: 'chromeosdevices(deviceId)',
  });
  assert.equal(
    fake.requests.some((request) => writeMethods.includes(request.method)),
    false,
    'The check sends no write method.',
  );
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
  const fake = createClient({ mintError: timeout });
  const result = await new DeviceWriteAccess(createStore(), fake.factory).check(
    session,
    context,
  );
  assert.equal(result.state, 'unavailable');
  assert.equal(result.failure, 'network-failure');
  assert.notEqual(result.state, 'denied');
  assert.equal(fake.calls.length, 1, 'The factory runs once.');
  assert.equal(
    fake.calls[0].scope,
    writeScope,
    'The token carries the write scope.',
  );
  assert.deepEqual(
    fake.requests,
    [],
    'The mint fails before any list request.',
  );
});

test('a provider-unavailable mint leaves access unavailable, never denied', async () => {
  const fake = createClient({ mintError: { response: { status: 503 } } });
  const result = await new DeviceWriteAccess(createStore(), fake.factory).check(
    session,
    context,
  );
  assert.equal(result.state, 'unavailable');
  assert.equal(result.failure, 'provider-unavailable');
  assert.notEqual(result.state, 'denied');
  assert.deepEqual(
    fake.requests,
    [],
    'The mint fails before any list request.',
  );
});

test('only a delegation or scope failure at the mint denies access', async () => {
  for (const code of googleFailureSchema.options) {
    const fake = createClient({ mintError: new GoogleConnectionError(code) });
    const result = await new DeviceWriteAccess(
      createStore(),
      fake.factory,
    ).check(session, context);
    const denied = ['delegation-not-authorized', 'scope-mismatch'].includes(
      code,
    );
    assert.equal(
      result.state,
      denied ? 'denied' : 'unavailable',
      `A ${code} mint answers ${denied ? 'denied' : 'unavailable'}.`,
    );
    assert.equal(result.failure, code, `A ${code} mint keeps its code.`);
    assert.deepEqual(
      fake.requests,
      [],
      `A ${code} mint sends no list request.`,
    );
  }
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

test('a second check inside the interval is busy before the credential read', async () => {
  let remaining = 1;
  const store = createStore({
    reserve: async () => {
      const free = remaining > 0;
      remaining -= 1;
      return free;
    },
  });
  const fake = createClient();
  const access = new DeviceWriteAccess(store, fake.factory);
  assert.equal((await access.check(session, context)).state, 'granted');
  const second = await access.check(session, context).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  assert.equal(
    second.value,
    undefined,
    `A repeat check inside the interval answers no state: ${JSON.stringify(second.value)}`,
  );
  assert.ok(
    second.error instanceof WriteAccessBusyError,
    `A repeat check rejects busy: ${second.error}`,
  );
  assert.equal(
    store.credentials.length,
    1,
    'Only the first check reads the credential.',
  );
  assert.equal(fake.calls.length, 1, 'Only the first check mints a token.');
  assert.equal(
    fake.requests.length,
    1,
    'Only the first check sends a list request.',
  );
});

test('two concurrent checks mint once', async () => {
  let free = true;
  const store = createStore({
    reserve: async () => {
      if (!free) return false;
      free = false;
      return true;
    },
  });
  const fake = createClient();
  const access = new DeviceWriteAccess(store, fake.factory);
  const results = await Promise.allSettled([
    access.check(session, context),
    access.check(session, context),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
    'One concurrent check answers the state.',
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === 'rejected' &&
        result.reason instanceof WriteAccessBusyError,
    ).length,
    1,
    'The other concurrent check answers busy.',
  );
  assert.equal(fake.calls.length, 1, 'Two concurrent checks mint one token.');
  assert.equal(
    store.credentials.length,
    1,
    'Two concurrent checks read one credential.',
  );
});

test('a check after the interval runs', async () => {
  assert.equal(DEVICE_WRITE_ACCESS_INTERVAL_SECONDS, 30);
  let now = 0;
  const until = new Map();
  const store = createStore({
    reserve: async (target) => {
      const expiry = until.get(target.customerId) ?? -1;
      if (expiry > now) return false;
      until.set(target.customerId, now + DEVICE_WRITE_ACCESS_INTERVAL_SECONDS);
      return true;
    },
  });
  const fake = createClient();
  const access = new DeviceWriteAccess(store, fake.factory);
  assert.equal((await access.check(session, context)).state, 'granted');
  now = DEVICE_WRITE_ACCESS_INTERVAL_SECONDS - 1;
  await assert.rejects(
    access.check(session, context),
    (error) => error instanceof WriteAccessBusyError,
    'A check one second before the interval is busy.',
  );
  now = DEVICE_WRITE_ACCESS_INTERVAL_SECONDS;
  assert.equal(
    (await access.check(session, context)).state,
    'granted',
    'A check at the interval runs.',
  );
  assert.equal(
    fake.calls.length,
    2,
    'The interval check mints a second token.',
  );
});

test('no check writes a secret to the process output', async () => {
  const secrets = [
    'PRIVATE-KEY-MATERIAL',
    'ENVELOPE-CIPHERTEXT-VALUE',
    'ACCESS-TOKEN-VALUE',
  ];
  const secretCredential = {
    serviceAccount: {
      client_email: 'service@example.org',
      private_key: secrets[0],
      private_key_id: '1'.repeat(40),
      client_id: '100000000000000000001',
    },
    subject: 'administrator@example.org',
  };
  const captured = [];
  const sink = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  const original = {
    out: process.stdout.write,
    err: process.stderr.write,
    log: console.log,
    error: console.error,
    warn: console.warn,
  };
  process.stdout.write = sink;
  process.stderr.write = sink;
  console.log = (...values) => captured.push(values.join(' '));
  console.error = (...values) => captured.push(values.join(' '));
  console.warn = (...values) => captured.push(values.join(' '));
  try {
    const granted = await new DeviceWriteAccess(
      createStore({ credential: async () => secretCredential }),
      createClient().factory,
    ).check(session, context);
    assert.equal(granted.state, 'granted');

    for (const code of [
      'delegation-not-authorized',
      'network-failure',
      'provider-unavailable',
      'permission-denied',
    ]) {
      const result = await new DeviceWriteAccess(
        createStore({ credential: async () => secretCredential }),
        createClient({ error: new GoogleConnectionError(code) }).factory,
      ).check(session, context);
      assert.ok(
        deviceWriteAccessSchema.safeParse(result).success,
        `A ${code} check answers the projection.`,
      );
    }

    const storeError = await new DeviceWriteAccess(
      createStore({
        credential: async () => {
          throw new Error(`${secrets[0]} ${secrets[1]} ${secrets[2]}`);
        },
      }),
      createClient().factory,
    )
      .check(session, context)
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    assert.ok(storeError.error, 'A store failure rejects.');

    const mintError = await new DeviceWriteAccess(
      createStore({ credential: async () => secretCredential }),
      createClient({ mintError: new Error(secrets[2]) }).factory,
    ).check(session, context);
    assert.equal(mintError.state, 'unavailable');
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
  }
  const text = captured.join('\n');
  for (const secret of secrets)
    assert.equal(
      text.includes(secret),
      false,
      `The process output holds no ${secret}.`,
    );
});
