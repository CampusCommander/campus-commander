import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CredentialCipher,
  CredentialError,
  validateServiceAccount,
} from './credential.ts';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
});
const account = {
  type: 'service_account',
  client_id: '123456789',
  client_email: 'fixture@project.iam.gserviceaccount.com',
  private_key: privateKey,
  private_key_id: 'fixture-key',
  token_uri: 'https://oauth2.googleapis.com/token',
};
const credential = {
  serviceAccount: account,
  subject: 'administrator@example.invalid',
};
const context = {
  recordId: randomUUID(),
  customerId: 'C0123456',
  generation: 1,
};
const key = randomBytes(32);
const cipher = new CredentialCipher('key-1', key);

const unavailable = (error) =>
  error instanceof CredentialError &&
  error.code === 'credential-unavailable' &&
  !String(error).includes(privateKey) &&
  !String(error).includes(credential.subject);

test('validates the fixed provider endpoint, account identity, and RSA strength', () => {
  assert.deepEqual(
    validateServiceAccount(
      { ...account, universe_domain: 'googleapis.com', ignored: 'discard' },
      account.client_id,
    ),
    account,
  );
  const weak = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  }).privateKey;
  for (const input of [
    null,
    {},
    { ...account, type: 'authorized_user' },
    { ...account, token_uri: 'https://attacker.invalid/token' },
    { ...account, universe_domain: 'other.invalid' },
    { ...account, private_key: weak },
    { ...account, private_key: 'invalid' },
    { ...account, client_email: 'user@example.invalid' },
  ]) {
    assert.throws(
      () => validateServiceAccount(input, account.client_id),
      (error) =>
        error instanceof CredentialError &&
        error.code === 'invalid-service-account-file',
    );
  }
  assert.throws(
    () => validateServiceAccount(account, '987654321'),
    CredentialError,
  );
});

test('encrypts randomized envelopes and recovers with an independent cipher', () => {
  const first = cipher.seal(credential, context);
  const second = cipher.seal(credential, context);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(
    new CredentialCipher('key-1', key).open(first, context),
    credential,
  );
  const stored = JSON.stringify(first);
  assert.equal(stored.includes(privateKey), false);
  assert.equal(stored.includes(credential.subject), false);
  assert.equal(stored.includes(account.client_email), false);
  assert.deepEqual(JSON.parse(JSON.stringify(cipher)), { keyId: 'key-1' });
});

test('binds envelopes to exact records, customers, generations, and key versions', () => {
  const envelope = cipher.seal(credential, context);
  for (const wrong of [
    { ...context, recordId: randomUUID() },
    { ...context, customerId: 'C9999999' },
    { ...context, generation: 0 },
    { ...context, generation: 2 },
  ])
    assert.throws(() => cipher.open(envelope, wrong), unavailable);
  assert.throws(
    () =>
      new CredentialCipher('key-1', randomBytes(32)).open(envelope, context),
    unavailable,
  );
  assert.throws(
    () =>
      new CredentialCipher('key-2', key).open(
        { ...envelope, keyId: 'key-2' },
        context,
      ),
    unavailable,
  );
  assert.throws(() => cipher.open({ ...envelope, keyId: 'key-2' }, context), {
    code: 'key-unavailable',
  });
  const staged = { ...context, customerId: null, generation: 0 };
  assert.deepEqual(
    cipher.open(cipher.seal(credential, staged), staged),
    credential,
  );
});

test('rejects altered envelopes and returns only bounded errors', () => {
  const envelope = cipher.seal(credential, context);
  for (const field of ['iv', 'tag', 'ciphertext']) {
    const bytes = Buffer.from(envelope[field], 'base64url');
    bytes[0] ^= 1;
    assert.throws(
      () =>
        cipher.open(
          { ...envelope, [field]: bytes.toString('base64url') },
          context,
        ),
      unavailable,
    );
  }
  for (const malformed of [
    null,
    {},
    { ...envelope, format: 2 },
    { ...envelope, iv: '' },
    { ...envelope, tag: '' },
    { ...envelope, ciphertext: 'x'.repeat(32769) },
    { ...envelope, unexpected: credential },
  ])
    assert.throws(() => cipher.open(malformed, context), unavailable);
  assert.throws(
    () => cipher.seal({ ...credential, subject: 'invalid' }, context),
    unavailable,
  );
});

test('requires exact encryption keys and isolates supplied key memory', () => {
  for (const invalid of [
    new Uint8Array(0),
    randomBytes(31),
    randomBytes(33),
    'secret',
    null,
  ])
    assert.throws(
      () => new CredentialCipher('key-1', invalid),
      (error) =>
        error instanceof CredentialError && error.code === 'key-unavailable',
    );
  assert.throws(() => new CredentialCipher('../key', key), CredentialError);
  const input = randomBytes(32);
  const copy = Buffer.from(input);
  const independent = new CredentialCipher('key-1', input);
  input.fill(0);
  assert.deepEqual(
    new CredentialCipher('key-1', copy).open(
      independent.seal(credential, context),
      context,
    ),
    credential,
  );
});

test('normalizes accepted PEM padding before producing a readable envelope', () => {
  const padded = { ...account, private_key: privateKey.padEnd(16384, '\n') };
  assert.deepEqual(validateServiceAccount(padded, account.client_id), account);
  const envelope = cipher.seal(
    { ...credential, serviceAccount: padded },
    context,
  );
  assert.ok(envelope.ciphertext.length <= 32768);
  assert.deepEqual(cipher.open(envelope, context), credential);
});

test('rejects oversized IV and tag strings before base64 decoding', () => {
  const envelope = cipher.seal(credential, context);
  const original = Buffer.from;
  let oversizedDecodes = 0;
  Buffer.from = function (value, ...args) {
    if (
      typeof value === 'string' &&
      value.length === 100000 &&
      args[0] === 'base64url'
    )
      oversizedDecodes++;
    return original(value, ...args);
  };
  try {
    for (const field of ['iv', 'tag'])
      assert.throws(
        () =>
          cipher.open({ ...envelope, [field]: 'a'.repeat(100000) }, context),
        unavailable,
      );
    assert.equal(oversizedDecodes, 0);
  } finally {
    Buffer.from = original;
  }
});

test('access tokens use a distinct authenticated payload purpose', () => {
  const token = {
    accessToken: 'ya29.synthetic-token',
    expiresAt: Date.now() + 3_500_000,
    scopeProfile: 'customer-domain-v1',
  };
  const encrypted = cipher.sealAccessToken(token, context);
  assert.deepEqual(
    new CredentialCipher('key-1', key).openAccessToken(encrypted, context),
    token,
  );
  assert.throws(() => cipher.open(encrypted, context), unavailable);
  assert.throws(
    () => cipher.openAccessToken(cipher.seal(credential, context), context),
    unavailable,
  );
  assert.throws(
    () => cipher.openAccessToken(encrypted, { ...context, generation: 2 }),
    unavailable,
  );
  assert.throws(
    () =>
      cipher.sealAccessToken(token, {
        ...context,
        customerId: null,
        generation: 0,
      }),
    unavailable,
  );
  assert.throws(
    () =>
      cipher.sealAccessToken(
        { ...token, accessToken: 'invalid\r\nheader' },
        context,
      ),
    unavailable,
  );
});

test('deployed key versions decrypt explicitly and preserve envelope authentication', () => {
  const nextKey = randomBytes(32);
  const ring = new CredentialCipher('key-1', key, [
    { keyId: 'key-2', key: nextKey },
  ]);
  const old = cipher.seal(credential, context);
  const nextContext = { ...context, generation: context.generation + 1 };
  const next = ring.forKey('key-2').seal(ring.open(old, context), nextContext);
  assert.equal(next.keyId, 'key-2');
  assert.deepEqual(ring.open(next, nextContext), credential);
  assert.deepEqual(
    new CredentialCipher('key-2', nextKey).open(next, nextContext),
    credential,
  );
  assert.throws(() => cipher.open(next, nextContext), {
    code: 'key-unavailable',
  });
  assert.throws(() => ring.open(next, context), unavailable);
  assert.throws(
    () => ring.open({ ...next, keyId: 'key-1' }, nextContext),
    unavailable,
  );
  assert.throws(() => ring.forKey('missing'), { code: 'key-unavailable' });
  assert.throws(
    () =>
      new CredentialCipher('key-1', key, [{ keyId: 'key-1', key: nextKey }]),
    { code: 'key-unavailable' },
  );
  assert.equal(ring.keyId, 'key-1');
  assert.equal(ring.forEnvelope(next).keyId, 'key-2');
  assert.deepEqual(JSON.parse(JSON.stringify(ring)), { keyId: 'key-1' });
  nextKey.fill(0);
  assert.deepEqual(ring.open(next, nextContext), credential);
});
