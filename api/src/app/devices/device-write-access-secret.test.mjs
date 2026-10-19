import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  CredentialCipher,
  GoogleConnectionError,
} from '@campus/google-connection';
import { GOOGLE_HEALTH_FRESH_SECONDS } from '@campus/application-contracts';
import { DeviceWriteAccess } from './device-write-access.ts';
import { DeviceWriteAccessRoutes } from './device-write-access-routes.ts';
import { createDeviceWriteAccessStore } from './device-write-access-store.ts';

/**
 * The secret guard over the real adapter, the real domain, and the route error
 * bodies. Every sentinel is made-up test material. The real cipher seals and
 * opens a real envelope, so the adapter's own open site runs.
 */
const customer = 'C0123456';
const generation = 1;
const credentialId = '33333333-3333-4333-8333-333333333333';
const secretPath = '/run/secrets/google-credential-key';
const envelopeSentinel = 'ENVELOPE-CIPHERTEXT-VALUE';
const keySentinel = 'KEY-MATERIAL-SENTINEL-32-BYTES!!';
const privateKeySentinel = 'PRIVATE-KEY-MATERIAL';
const tokenSentinel = 'ACCESS-TOKEN-VALUE';
const sentinels = [
  envelopeSentinel,
  keySentinel,
  privateKeySentinel,
  tokenSentinel,
];
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
});
const delegated = {
  serviceAccount: {
    type: 'service_account',
    client_id: '100000000000000000001',
    client_email: 'service@example.iam.gserviceaccount.com',
    private_key: privateKey,
    private_key_id: '1'.repeat(40),
    token_uri: 'https://oauth2.googleapis.com/token',
  },
  subject: 'administrator@example.org',
};
const context = { customerId: customer, generation };
const envelopeContext = {
  recordId: credentialId,
  customerId: customer,
  generation,
};
const envelope = new CredentialCipher(
  'test-key',
  Buffer.from(keySentinel),
).seal(delegated, envelopeContext);
const session = {
  identity: {
    id: '11111111-1111-4111-8111-111111111111',
    displayName: 'Test person',
    permissions: [],
    permissionVersion: 1,
    grants: [],
    preferences: {},
  },
  expiresAt: '2026-10-19T12:00:00.000Z',
  csrfToken: 'a'.repeat(64),
};
const configuration = {
  deployment: {
    googleConnection: {
      keyId: 'test-key',
      encryptionKeySecretRef: { provider: 'file', path: secretPath },
    },
  },
  secret() {
    // The loader clears the buffer it receives, so hand it a fresh copy.
    return Buffer.from(keySentinel);
  },
};

/** A database whose one credential query answers the configured claim or error. */
function createDatabase({ claim, error } = {}) {
  return {
    connection: {
      async query() {
        if (error) throw error;
        return { rows: [{ result: claim }] };
      },
    },
  };
}

/** A Redis stand-in for the projection and the reservation. */
function createCache() {
  const values = new Map();
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async reserve() {
      return 'OK';
    },
  };
}

const claim = { customerId: customer, generation, credentialId, envelope };
const store = createDeviceWriteAccessStore(
  createDatabase({ claim }),
  createCache(),
  configuration,
);

/** Answer one check with a factory that records the opened credential. */
async function check(factory) {
  const access = new DeviceWriteAccess(store, factory);
  return access.check(session, context);
}

/** The route port over the real store and the real domain. */
function createRoutes(access) {
  return new DeviceWriteAccessRoutes({
    connection: async () => context,
    read: async () => access.read(session, context),
    check: (received, target) => access.check(received, target),
  });
}

const settle = (call) =>
  call().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

test('the real adapter and the response bodies hold no envelope, key, private key, or token', async () => {
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
  const bodies = [];
  let opened = null;
  try {
    const granted = await check(async (received) => {
      opened = received;
      return { request: async () => ({ data: {} }) };
    });
    bodies.push(granted);
    assert.equal(granted.state, 'granted');
    assert.match(
      opened.serviceAccount.private_key,
      /BEGIN PRIVATE KEY/,
      'The real adapter opens the sealed credential.',
    );

    const denied = await check(async () => {
      throw new GoogleConnectionError('delegation-not-authorized');
    });
    bodies.push(denied);
    assert.equal(denied.state, 'denied');

    const unavailable = await check(async () => ({
      request: async () => {
        throw {
          response: {
            status: 403,
            data: { error: { errors: [{ reason: 'forbidden' }] } },
          },
        };
      },
    }));
    bodies.push(unavailable);
    assert.equal(unavailable.state, 'unavailable');
    assert.equal(unavailable.failure, 'permission-denied');

    const mint = await check(async () => {
      throw new Error(tokenSentinel);
    });
    bodies.push(mint);
    assert.equal(mint.state, 'unavailable');

    const unopened = createDeviceWriteAccessStore(
      createDatabase({
        claim: { ...claim, envelope: envelopeSentinel },
      }),
      createCache(),
      configuration,
    );
    const malformed = await settle(() =>
      createRoutes(new DeviceWriteAccess(unopened)).check(
        session,
        'correlation',
      ),
    );
    assert.ok(
      malformed.error instanceof ServiceUnavailableException,
      `An unreadable envelope answers 503: ${malformed.error}`,
    );
    bodies.push(malformed.error.getResponse());

    const failed = createDeviceWriteAccessStore(
      createDatabase({
        error: Object.assign(new Error(privateKeySentinel), {
          code: 'XX000',
        }),
      }),
      createCache(),
      configuration,
    );
    const storeFailure = await settle(() =>
      createRoutes(new DeviceWriteAccess(failed)).check(session, 'correlation'),
    );
    assert.ok(
      storeFailure.error instanceof ServiceUnavailableException,
      `A store failure answers 503: ${storeFailure.error}`,
    );
    bodies.push(storeFailure.error.getResponse());
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
  }
  const text = captured.join('\n');
  const body = JSON.stringify(bodies);
  for (const sentinel of sentinels) {
    assert.equal(
      text.includes(sentinel),
      false,
      `The process output holds no ${sentinel}.`,
    );
    assert.equal(
      body.includes(sentinel),
      false,
      `The response body holds no ${sentinel}.`,
    );
  }
});
