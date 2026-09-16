import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { JWT } from 'google-auth-library';
import {
  GoogleCustomerVerifier,
  GOOGLE_CONNECTION_SCOPES,
} from './provider.ts';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
});
const credential = {
  subject: 'fixture@example.invalid',
  serviceAccount: {
    client_email: 'fixture@project.iam.gserviceaccount.com',
    private_key: privateKey,
    private_key_id: 'fixture',
  },
};
const customer = { id: 'C0123456', customerDomain: 'example.invalid' };
const domains = {
  domains: [
    {
      domainName: 'example.invalid',
      isPrimary: true,
      verified: true,
      domainAliases: [
        {
          domainAliasName: 'alias.invalid',
          parentDomainName: 'example.invalid',
          verified: true,
        },
      ],
    },
    { domainName: 'secondary.invalid', isPrimary: false, verified: false },
  ],
};

function stub(
  t,
  { scopes = [...GOOGLE_CONNECTION_SCOPES], response = domains, error } = {},
) {
  const calls = [];
  t.mock.method(JWT.prototype, 'getAccessToken', async function () {
    assert.deepEqual(this.scopes, [...GOOGLE_CONNECTION_SCOPES]);
    assert.equal(this.subject, credential.subject);
    return { token: 'private-fixture-token' };
  });
  t.mock.method(JWT.prototype, 'getTokenInfo', async () => ({ scopes }));
  t.mock.method(JWT.prototype, 'request', async (options) => {
    calls.push(options);
    if (error) throw error;
    return { data: calls.length === 1 ? customer : response };
  });
  return calls;
}

test('customer verification returns bounded primary, secondary, and alias observations', async (t) => {
  const calls = stub(t);
  const result = await new GoogleCustomerVerifier().verify(credential);
  assert.equal(result.customerId, customer.id);
  assert.equal(result.domains[0].aliases[0].name, 'alias.invalid');
  assert.equal(result.domains[1].verified, false);
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['GET', 'GET'],
  );
  assert.equal(
    calls[1].url,
    'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/domains',
  );
  assert.equal(JSON.stringify(result).includes('private-fixture-token'), false);
});

test('missing or extra scopes prevent Directory requests', async (t) => {
  for (const scopes of [
    [GOOGLE_CONNECTION_SCOPES[0]],
    [...GOOGLE_CONNECTION_SCOPES, 'extra'],
  ]) {
    const calls = stub(t, { scopes });
    await assert.rejects(new GoogleCustomerVerifier().verify(credential), {
      code: 'scope-mismatch',
    });
    assert.equal(calls.length, 0);
    t.mock.restoreAll();
  }
});

test('inconsistent primary, duplicate domains, and unrelated aliases fail closed', async (t) => {
  for (const response of [
    { domains: [{ ...domains.domains[0], isPrimary: false }] },
    { domains: [domains.domains[0], domains.domains[0]] },
    {
      domains: [
        {
          ...domains.domains[0],
          domainAliases: [
            {
              ...domains.domains[0].domainAliases[0],
              parentDomainName: 'unrelated.invalid',
            },
          ],
        },
      ],
    },
  ]) {
    stub(t, { response });
    await assert.rejects(new GoogleCustomerVerifier().verify(credential), {
      code: 'invalid-response',
    });
    t.mock.restoreAll();
  }
});

test('provider failures expose bounded codes without response data', async (t) => {
  for (const [status, reason, expected] of [
    [401, 'invalid_grant', 'credential-rejected'],
    [403, 'forbidden', 'permission-denied'],
    [403, 'rateLimitExceeded', 'quota'],
    [503, 'backendError', 'provider-unavailable'],
  ]) {
    stub(t, {
      error: {
        response: {
          status,
          data: { error: { errors: [{ reason }], secret: privateKey } },
        },
      },
    });
    await assert.rejects(
      new GoogleCustomerVerifier().verify(credential),
      (error) => {
        assert.equal(error.code, expected);
        assert.equal(error.message, expected);
        assert.equal('response' in error, false);
        return true;
      },
    );
    t.mock.restoreAll();
  }
});

test('SDK token and Directory transport enforce time, size, redirect, and retry bounds', async (t) => {
  const calls = [];
  const transportPrototype = Object.getPrototypeOf(new JWT().transporter);
  t.mock.method(transportPrototype, 'request', async (options) => {
    calls.push(options);
    assert.equal(options.timeout, 10000);
    assert.equal(options.retry, false);
    assert.equal(options.retryConfig.retry, 0);
    assert.equal(options.maxRedirects, 0);
    assert.equal(options.maxContentLength, 262144);
    assert.equal(options.size, 262144);
    assert.equal(options.signal instanceof AbortSignal, true);
    const url = new URL(options.url);
    let data;
    if (url.pathname === '/token')
      data = {
        access_token: 'private-fixture-token',
        expires_in: 3600,
        token_type: 'Bearer',
      };
    else if (url.pathname === '/tokeninfo')
      data = { scope: GOOGLE_CONNECTION_SCOPES.join(' '), expires_in: 3500 };
    else if (url.pathname.endsWith('/my_customer')) data = customer;
    else if (url.pathname.endsWith('/domains')) data = domains;
    else assert.fail('Unexpected Google endpoint.');
    return { data, status: 200 };
  });
  const result = await new GoogleCustomerVerifier().verify(credential);
  assert.equal(result.customerId, customer.id);
  assert.equal(calls.length, 4);
  assert.equal(
    calls.filter((call) => new URL(call.url).pathname === '/token').length,
    1,
  );
  assert.equal(
    calls.every((call) => call.signal === calls[0].signal),
    true,
  );
});

test('HTTP status survives a malformed error body', async (t) => {
  for (const [status, expected] of [
    [401, 'credential-rejected'],
    [403, 'permission-denied'],
    [429, 'quota'],
    [503, 'provider-unavailable'],
  ]) {
    stub(t, {
      error: { response: { status, data: '<html>Unavailable</html>' } },
    });
    await assert.rejects(new GoogleCustomerVerifier().verify(credential), {
      code: expected,
    });
    t.mock.restoreAll();
  }
});

test('aborts and delegation failures retain actionable categories', async (t) => {
  for (const [error, expected] of [
    [new DOMException('Synthetic abort', 'AbortError'), 'network-failure'],
    [{ code: 'ENOTFOUND' }, 'network-failure'],
    [
      { response: { status: 400, data: { error: 'unauthorized_client' } } },
      'delegation-not-authorized',
    ],
    [
      {
        response: {
          status: 403,
          data: { error: { errors: [{ reason: 'accessNotConfigured' }] } },
        },
      },
      'api-not-enabled',
    ],
    [
      { response: { status: 403, data: { error: 'admin_policy_enforced' } } },
      'policy-restricted',
    ],
  ]) {
    stub(t, { error });
    await assert.rejects(new GoogleCustomerVerifier().verify(credential), {
      code: expected,
    });
    t.mock.restoreAll();
  }
});
