import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CredentialError,
  loadCredentialCipher,
} from '@campus/google-connection';
import {
  GOOGLE_HEALTH_FRESH_SECONDS,
  deviceWriteAccessSchema,
} from '@campus/application-contracts';
import {
  createDeviceWriteAccessStore,
  createWriteAccessConnection,
} from './device-write-access-store.ts';
import { DEVICE_WRITE_ACCESS_INTERVAL_SECONDS } from './device-write-access.ts';

const customer = 'C0123456';
const generation = 1;
const actor = '11111111-1111-4111-8111-111111111111';
const credentialId = '33333333-3333-4333-8333-333333333333';
const keyMaterial = Buffer.alloc(32, 7);
const secretPath = '/run/secrets/google-credential-key';
const configuration = {
  deployment: {
    googleConnection: {
      keyId: 'test-key',
      encryptionKeySecretRef: { provider: 'file', path: secretPath },
    },
  },
  reads: [],
  secret(reference) {
    this.reads.push(reference);
    return keyMaterial;
  },
};
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
const context = { customerId: customer, generation };
const delegated = {
  serviceAccount: {
    client_email: 'service@example.iam.gserviceaccount.com',
    private_key: 'PRIVATE-KEY-MATERIAL',
    private_key_id: '1'.repeat(40),
    client_id: '100000000000000000001',
  },
  subject: 'administrator@example.org',
};
const claim = {
  customerId: customer,
  generation,
  credentialId,
  envelope: { valid: true },
};

/** A database whose one query answers the configured result or error. */
function createDatabase({ result = claim, error, row } = {}) {
  const queries = [];
  return {
    queries,
    connection: {
      async query(text, values) {
        queries.push({ text, values });
        if (error) throw error;
        return { rows: [row ?? { result }] };
      },
    },
  };
}

/** A Redis stand-in with the reserve semantics of one key. */
function createCache() {
  const values = new Map();
  const reserved = new Map();
  const expiries = new Map();
  return {
    values,
    reserved,
    expiries,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value, seconds) {
      values.set(key, value);
      expiries.set(key, seconds);
    },
    async reserve(key, owner, seconds) {
      if (reserved.has(key)) return null;
      reserved.set(key, owner);
      expiries.set(key, seconds);
      return 'OK';
    },
  };
}

/**
 * A cipher that records each open. It reads the key like the real cipher so the
 * store's per-call key read stays observable.
 */
class RecordingCipher {
  constructor(key, context) {
    this.key = key;
    this.context = context;
    this.opens = [];
  }
  open(envelope, openContext) {
    this.opens.push({ envelope, context: openContext });
    if (envelope?.valid !== true)
      throw new CredentialError('credential-unavailable');
    return delegated;
  }
}

/** A cipher loader that records each instance and reads the key first. */
function createCipherLoader() {
  const calls = [];
  return {
    calls,
    load(config, read) {
      const instance = new RecordingCipher(
        read(config.encryptionKeySecretRef),
        config.keyId,
      );
      calls.push(instance);
      return instance;
    },
  };
}

const settle = (call) =>
  call().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

test('every credential opens with a fresh key read and a fresh cipher', async () => {
  configuration.reads = [];
  const loader = createCipherLoader();
  const store = createDeviceWriteAccessStore(
    createDatabase(),
    createCache(),
    configuration,
    loader.load,
  );
  const first = await store.credential(session, context);
  const second = await store.credential(session, context);
  assert.deepEqual(first, delegated);
  assert.deepEqual(second, delegated);
  assert.equal(
    configuration.reads.length,
    2,
    'Each check reads the encryption key once.',
  );
  assert.equal(loader.calls.length, 2, 'Each check builds one cipher.');
  assert.notEqual(
    loader.calls[0],
    loader.calls[1],
    'The two checks use distinct cipher instances.',
  );
  assert.equal(
    loader.calls[0].opens.length,
    1,
    'Each cipher opens one credential.',
  );
  assert.deepEqual(loader.calls[0].opens[0], {
    envelope: claim.envelope,
    context: {
      recordId: credentialId,
      customerId: customer,
      generation,
    },
  });
  assert.deepEqual(
    loader.calls[1].opens[0],
    loader.calls[0].opens[0],
    'The second check opens the same projection with its own cipher.',
  );
  assert.equal(
    loader.calls[0].key,
    keyMaterial,
    'The cipher reads the deployment key.',
  );
  const fields = Object.values(store);
  for (const value of fields)
    assert.equal(
      value instanceof RecordingCipher || value === delegated,
      false,
      'No store field holds a cipher or a credential.',
    );
  assert.equal(
    JSON.stringify({ first, second }).includes('ACCESS-TOKEN-VALUE'),
    false,
    'No token reaches the caller.',
  );
});

test('the cache holds only the four-field projection under the customer key', async () => {
  const cache = createCache();
  const store = createDeviceWriteAccessStore(
    createDatabase(),
    cache,
    configuration,
    createCipherLoader().load,
  );
  const projection = {
    state: 'denied',
    scope: 'https://www.googleapis.com/auth/admin.directory.device.chromeos',
    failure: 'delegation-not-authorized',
    checkedAt: '2026-10-19T10:00:00.000Z',
  };
  await store.write(context, projection, GOOGLE_HEALTH_FRESH_SECONDS);
  assert.deepEqual(
    [...cache.values.keys()],
    [`cc:device-write-access:${customer}:${generation}`],
  );
  const key = `cc:device-write-access:${customer}:${generation}`;
  assert.equal(
    cache.expiries.get(key),
    GOOGLE_HEALTH_FRESH_SECONDS,
    'The projection lives for the health fresh window.',
  );
  const stored = JSON.parse(cache.values.get(key));
  assert.deepEqual(Object.keys(stored).sort(), [
    'checkedAt',
    'failure',
    'scope',
    'state',
  ]);
  assert.equal(deviceWriteAccessSchema.safeParse(stored).success, true);
  const text = JSON.stringify(stored);
  for (const secret of [
    'envelope',
    'ciphertext',
    'tag',
    'PRIVATE-KEY-MATERIAL',
    'ACCESS-TOKEN-VALUE',
  ])
    assert.equal(text.includes(secret), false, `The cache holds no ${secret}.`);
  assert.deepEqual(await store.read(context), projection);
  assert.equal(
    await store.read({ ...context, generation: generation + 1 }),
    null,
    'The next generation misses the cache.',
  );
});

test('the store reserves one check interval per customer and generation', async () => {
  const cache = createCache();
  const store = createDeviceWriteAccessStore(
    createDatabase(),
    cache,
    configuration,
    createCipherLoader().load,
  );
  assert.equal(await store.reserve(context), true, 'The first check reserves.');
  assert.equal(
    await store.reserve(context),
    false,
    'A second check inside the interval is busy.',
  );
  const key = `cc:device-write-access-busy:${customer}:${generation}`;
  assert.deepEqual([...cache.reserved.keys()], [key]);
  assert.equal(
    cache.expiries.get(key),
    DEVICE_WRITE_ACCESS_INTERVAL_SECONDS,
    'The reservation lives for the interval.',
  );
  assert.equal(
    await store.reserve({ ...context, generation: generation + 1 }),
    true,
    'The next generation reserves its own interval.',
  );
});

test('an unreadable credential field answers 403 without an envelope', async () => {
  const store = createDeviceWriteAccessStore(
    createDatabase({
      error: Object.assign(new Error('permission denied'), { code: '42501' }),
    }),
    createCache(),
    configuration,
    createCipherLoader().load,
  );
  const answer = await settle(() => store.credential(session, context));
  assert.ok(
    answer.error instanceof ForbiddenException,
    `A revoked principal answers 403: ${answer.error}`,
  );
  assert.equal(answer.error.getStatus(), 403);
  assert.equal(
    JSON.stringify(answer.error.getResponse()).includes('envelope'),
    false,
    'A 403 carries no envelope.',
  );
});

test('a stale generation answers 409 without an envelope', async () => {
  const store = createDeviceWriteAccessStore(
    createDatabase({
      error: Object.assign(new Error('credential generation changed'), {
        code: 'P0001',
        detail: 'credential-changed',
      }),
    }),
    createCache(),
    configuration,
    createCipherLoader().load,
  );
  const answer = await settle(() => store.credential(session, context));
  assert.ok(
    answer.error instanceof ConflictException,
    `A stale generation answers 409: ${answer.error}`,
  );
  assert.equal(answer.error.getStatus(), 409);
  assert.equal(
    JSON.stringify(answer.error.getResponse()).includes('envelope'),
    false,
    'A 409 carries no envelope.',
  );
});

test('a disconnected connection answers 503 without an envelope', async () => {
  for (const detail of [
    'connection-disconnected',
    'restore-revalidation-required',
  ]) {
    const store = createDeviceWriteAccessStore(
      createDatabase({
        error: Object.assign(new Error('store unavailable'), {
          code: 'P0001',
          detail,
        }),
      }),
      createCache(),
      configuration,
      createCipherLoader().load,
    );
    const answer = await settle(() => store.credential(session, context));
    assert.ok(
      answer.error instanceof ServiceUnavailableException,
      `A ${detail} store error answers 503: ${answer.error}`,
    );
    assert.equal(answer.error.getStatus(), 503);
    assert.equal(
      JSON.stringify(answer.error.getResponse()).includes('envelope'),
      false,
      `A ${detail} answer carries no envelope.`,
    );
  }
});

test('a malformed envelope answers 503 without an envelope', async () => {
  const store = createDeviceWriteAccessStore(
    createDatabase({
      result: { ...claim, envelope: { format: 1, keyId: 'test-key' } },
    }),
    createCache(),
    configuration,
    loadCredentialCipher,
  );
  const answer = await settle(() => store.credential(session, context));
  assert.ok(
    answer.error instanceof ServiceUnavailableException,
    `A malformed envelope answers 503: ${answer.error}`,
  );
  assert.equal(answer.error.getStatus(), 503);
  assert.equal(
    JSON.stringify(answer.error.getResponse()).includes('envelope'),
    false,
  );
});

test('an unreadable key answers 503 without an envelope', async () => {
  const unreadable = {
    ...configuration,
    secret() {
      throw new Error('PRIVATE-KEY-MATERIAL');
    },
  };
  const store = createDeviceWriteAccessStore(
    createDatabase(),
    createCache(),
    unreadable,
    loadCredentialCipher,
  );
  const answer = await settle(() => store.credential(session, context));
  assert.ok(
    answer.error instanceof ServiceUnavailableException,
    `An unreadable key answers 503: ${answer.error}`,
  );
  assert.equal(answer.error.getStatus(), 503);
  assert.equal(
    JSON.stringify(answer.error.getResponse()).includes('PRIVATE-KEY-MATERIAL'),
    false,
  );
});

test('the connection resolver answers the stored generation for a writer', async () => {
  const database = createDatabase({
    row: { customer_id: customer, generation },
  });
  const connection = createWriteAccessConnection(database);
  const answer = await settle(() => connection(session));
  assert.equal(
    answer.error,
    undefined,
    `cc.device_writer answers a writer: ${answer.error}`,
  );
  assert.deepEqual(answer.value, context);
  assert.match(database.queries[0].text, /cc\.device_writer/);
  assert.deepEqual(database.queries[0].values, [
    actor,
    session.identity.permissionVersion,
  ]);
});

test('the connection resolver answers null without a connection', async () => {
  const database = createDatabase({
    row: { customer_id: null, generation: null },
  });
  const connection = createWriteAccessConnection(database);
  const answer = await settle(() => connection(session));
  assert.equal(
    answer.error,
    undefined,
    `A writer may hold no connection: ${answer.error}`,
  );
  assert.equal(answer.value, null);
});

test('the connection resolver maps 42501 to 403 before any credential read', async () => {
  const database = createDatabase({
    error: Object.assign(new Error('permission denied'), { code: '42501' }),
  });
  const connection = createWriteAccessConnection(database);
  const answer = await settle(() => connection(session));
  assert.ok(
    answer.error instanceof ForbiddenException,
    `A caller without devices:write answers 403: ${answer.error}`,
  );
  assert.equal(answer.error.getStatus(), 403);
  assert.equal(
    database.queries[0].text.includes('device_write_credential'),
    false,
    'The resolver reads no credential.',
  );
});
