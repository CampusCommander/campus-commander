import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  rm,
  copyFile,
  chmod,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore, ProofError } from './store.mjs';
import {
  DwdProof,
  DIRECTORY_SCOPES,
  createDelegatedClient,
  sanitizeError,
  validateServiceAccount,
} from './dwd.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = {
  type: 'service_account',
  client_id: '123456',
  client_email: 'proof@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  private_key_id: 'fixture-key',
  token_uri: 'https://oauth2.googleapis.com/token',
};

function fixture(options = {}) {
  const requests = [];
  const counter = { tokenRequests: 0 };
  let scopes;
  const client = {
    credentials: { expiry_date: 1 },
    async getAccessToken() {
      if (this.credentials.expiry_date <= Date.now()) {
        counter.tokenRequests++;
        this.credentials = {
          access_token: `fixture-${counter.tokenRequests}`,
          expiry_date: Date.now() + 3_600_000,
        };
      }
      return { token: this.credentials.access_token };
    },
    async getTokenInfo() {
      return { scopes: options.scopes ?? scopes };
    },
    async request({ url, method }) {
      assert.equal(method, 'GET');
      requests.push(url);
      await this.getAccessToken();
      if (options.failure && url.includes('/domains')) throw options.failure;
      return {
        status: 200,
        data: url.includes('/domains')
          ? {
              domains: [
                {
                  isPrimary: true,
                  domainAliases: [{ domainAliasName: 'private-alias.invalid' }],
                },
                { isPrimary: false },
              ],
            }
          : url.includes('/orgunits')
            ? { organizationUnits: [{ orgUnitId: 'fixture-ou' }] }
            : {
                id: options.customer ?? 'Cfixture',
                customerDomain: 'private-domain.invalid',
              },
      };
    },
  };
  const proof = new DwdProof({
    credential: serviceAccount,
    subject: 'admin@example.invalid',
    orgunits: true,
    expectedCustomerId: options.expectedCustomerId,
    createClient: (_credential, _subject, requested) => {
      scopes = requested;
      return { client, counter };
    },
  });
  return { proof, requests, counter };
}

test('service-account import validates the expected client, RSA key, and Google endpoint', () => {
  assert.equal(
    validateServiceAccount(serviceAccount, '123456').client_id,
    '123456',
  );
  for (const bad of [
    { ...serviceAccount, type: 'web' },
    { ...serviceAccount, client_id: '987' },
    { ...serviceAccount, token_uri: 'https://attacker.invalid/token' },
    { ...serviceAccount, private_key: 'secret-invalid-key' },
  ])
    assert.throws(() => validateServiceAccount(bad, '123456'), {
      code: 'invalid-service-account-file',
    });
});

test('Google library signs the delegated JWT and limits token and API requests', async () => {
  const { client, counter } = createDelegatedClient(
    serviceAccount,
    'admin@example.invalid',
    [DIRECTORY_SCOPES.customer],
  );
  const requests = [];
  client.transporter.defaults.adapter = async (options) => {
    requests.push(options);
    assert.equal(options.retry, false);
    assert.equal(options.timeout, 10_000);
    assert.equal(options.maxRedirects, 0);
    const form = new URLSearchParams(options.data);
    const claims = JSON.parse(
      Buffer.from(form.get('assertion').split('.')[1], 'base64url'),
    );
    assert.equal(claims.sub, 'admin@example.invalid');
    assert.equal(claims.iss, serviceAccount.client_email);
    assert.equal(claims.scope, DIRECTORY_SCOPES.customer);
    assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
    return {
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      config: options,
      data: {
        access_token: 'fixture-token',
        expires_in: 3600,
        token_type: 'Bearer',
      },
    };
  };
  assert.equal((await client.getAccessToken()).token, 'fixture-token');
  assert.equal((await client.getAccessToken()).token, 'fixture-token');
  assert.equal(counter.tokenRequests, 1);
  client.credentials.expiry_date = 1;
  await client.getAccessToken();
  assert.equal(counter.tokenRequests, 2);
  assert.equal(requests.length, 2);
});

test('read proof verifies exact scopes, customer binding, reuse, renewal, and domain counts', async () => {
  const { proof } = fixture({ expectedCustomerId: 'Cfixture' });
  const { report } = await proof.run();
  assert.equal(report.customerMatches, true);
  assert.equal(report.tokenRequests, 2);
  assert.deepEqual(report.coverage, {
    primary: 1,
    secondary: 1,
    aliases: 1,
    orgunits: 1,
  });
  assert.equal(report.tokenReuse, 'passed');
  assert.equal(report.renewal, 'passed');
  assert.ok(!JSON.stringify(report).includes('private-domain'));
  assert.ok(!JSON.stringify(report).includes('fixture-token'));
});

test('wrong-customer replacement stops before domain or OU reads', async () => {
  const { proof, requests } = fixture({ expectedCustomerId: 'Cother' });
  await assert.rejects(proof.run(), { code: 'wrong-customer' });
  assert.equal(requests.length, 1);
});

test('missing and extra granted scopes fail before Directory reads', async () => {
  for (const scopes of [
    [DIRECTORY_SCOPES.customer],
    [
      ...Object.values(DIRECTORY_SCOPES),
      'https://www.googleapis.com/auth/drive',
    ],
  ]) {
    const { proof, requests } = fixture({ scopes });
    await assert.rejects(proof.run(), { code: 'scope-mismatch' });
    assert.equal(requests.length, 0);
  }
});

test('provider errors distinguish delegation, privileges, quota, and network failure without raw payloads', async () => {
  const cases = [
    [400, 'unauthorized_client', 'delegation-not-authorized'],
    [400, 'invalid_grant', 'credential-or-subject-rejected'],
    [403, 'forbidden', 'permission-denied'],
    [403, 'rateLimitExceeded', 'quota'],
    [503, 'backendError', 'provider-unavailable'],
  ];
  for (const [status, reason, expected] of cases) {
    const error = {
      message: 'secret',
      config: { headers: { Authorization: 'secret' } },
      response: {
        status,
        data: {
          error:
            status === 400
              ? reason
              : { errors: [{ reason }], message: 'secret' },
        },
      },
    };
    assert.equal(sanitizeError(error).reason, expected);
    assert.ok(!JSON.stringify(sanitizeError(error)).includes('secret'));
  }
  const { proof } = fixture({
    failure: {
      response: {
        status: 403,
        data: { error: { errors: [{ reason: 'forbidden' }] } },
      },
    },
  });
  await assert.rejects(proof.run(), { code: 'permission-denied' });
  assert.equal(proof.events.at(-1).status, 403);
});

test('encrypted credentials survive independent key restore and reject absent or incorrect keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-dwd-'));
  try {
    const store = new CredentialStore(
      join(dir, 'credentials'),
      join(dir, 'key'),
    );
    await store.initializeKey();
    await store.replace(0, {
      customerId: 'Cfixture',
      credential: serviceAccount,
    });
    const encrypted = await readFile(store.credentialPath, 'utf8');
    assert.ok(!encrypted.includes('PRIVATE KEY'));
    assert.ok(!encrypted.includes(serviceAccount.client_email));
    await copyFile(store.credentialPath, join(dir, 'restored-credentials'));
    await copyFile(store.keyPath, join(dir, 'restored-key'));
    const restored = new CredentialStore(
      join(dir, 'restored-credentials'),
      join(dir, 'restored-key'),
    );
    assert.equal(
      (await restored.read()).credential.private_key,
      serviceAccount.private_key,
    );
    await rm(restored.keyPath);
    await assert.rejects(restored.read(), { code: 'key-unavailable' });
    await writeFile(restored.keyPath, Buffer.alloc(32), { mode: 0o600 });
    await assert.rejects(restored.read(), { code: 'credential-unavailable' });
    await copyFile(store.keyPath, restored.keyPath);
    await chmod(restored.keyPath, 0o644);
    await assert.rejects(restored.read(), { code: 'key-unavailable' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent and stale writes cannot replace the customer or a newer credential generation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-dwd-'));
  try {
    const store = new CredentialStore(
      join(dir, 'credentials'),
      join(dir, 'key'),
    );
    await store.initializeKey();
    const outcomes = await Promise.allSettled([
      store.replace(0, { customerId: 'Cfixture' }),
      store.replace(0, { customerId: 'Cother' }),
    ]);
    assert.equal(
      outcomes.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    const current = await store.read();
    await assert.rejects(store.replace(0, current), {
      code: 'credential-conflict',
    });
    await assert.rejects(store.replace(1, { customerId: 'Cwrong' }), {
      code: 'wrong-customer',
    });
    await assert.rejects(
      store.locked(async () => {
        throw new ProofError('injected-failure');
      }),
      { code: 'injected-failure' },
    );
    assert.deepEqual(await store.read(), current);
    assert.equal((await store.replace(1, current)).version, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
