import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { GaxiosError, request } from 'gaxios';
import { JWT, OAuth2Client } from 'google-auth-library';
import {
  failure,
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
  t.mock.method(JWT.prototype, 'getTokenInfo', async () => ({
    scopes,
    expiry_date: Date.now() + 3_500_000,
  }));
  t.mock.method(OAuth2Client.prototype, 'request', async (options) => {
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

/** Live Google answers an ungranted scope with HTTP 401 unauthorized_client. */
test('a 401 token answer separates a delegation denial from a credential rejection', async (t) => {
  for (const [data, expected] of [
    [{ error: 'unauthorized_client' }, 'delegation-not-authorized'],
    [
      { error: { errors: [{ reason: 'unauthorized_client' }] } },
      'delegation-not-authorized',
    ],
    [{ error: 'access_denied' }, 'delegation-not-authorized'],
    [{ error: 'invalid_client' }, 'credential-rejected'],
    [{ error: 'invalid_grant' }, 'credential-rejected'],
    [{ error: 'deleted_client' }, 'credential-rejected'],
    [{ error: 'authError' }, 'credential-rejected'],
    ['<html>Unauthorized</html>', 'credential-rejected'],
    [undefined, 'credential-rejected'],
  ]) {
    t.mock.method(JWT.prototype, 'getAccessToken', async () => {
      throw { response: { status: 401, data } };
    });
    await assert.rejects(
      new GoogleCustomerVerifier().renew(credential, AbortSignal.timeout(5000)),
      { code: expected },
    );
    t.mock.restoreAll();
  }
});

/** The delegation rules run first. Every other answer keeps its previous category. */
test('the 401 rule and the read-stage policy rule keep every other category', () => {
  const mismatches = [];
  for (const [status, data, stage, expected] of [
    [401, { error: 'authError' }, 'read', 'credential-rejected'],
    [
      401,
      { error: { errors: [{ reason: 'forbidden' }] } },
      'read',
      'credential-rejected',
    ],
    [401, { error: 'access_denied' }, 'read', 'credential-rejected'],
    [401, '<html>Unauthorized</html>', 'read', 'credential-rejected'],
    [401, undefined, 'token', 'credential-rejected'],
    [403, { error: 'access_denied' }, 'read', 'policy-restricted'],
    [403, { error: 'domainPolicy' }, 'token', 'policy-restricted'],
  ]) {
    const code = failure({ response: { status, data } }, stage).code;
    if (code !== expected)
      mismatches.push({ status, data, stage, code, expected });
  }
  assert.deepEqual(mismatches, []);
});

/** The three non-abort fixtures from review round 1: the network-code rule is unchanged. */
test('non-abort causes keep their previous network-code mapping', () => {
  const mismatches = [];
  for (const [fixture, expected] of [
    [{ code: 'ERR_WRAPPER', cause: { code: 'ECONNRESET' } }, 'request-failed'],
    [{ cause: { cause: { code: 'ECONNRESET' } } }, 'request-failed'],
    [{ cause: { code: 'ENOTFOUND', name: 123 } }, 'network-failure'],
  ])
    for (const stage of ['token', 'read']) {
      const code = failure(fixture, stage).code;
      if (code !== expected)
        mismatches.push({ fixture, stage, code, expected });
    }
  assert.deepEqual(mismatches, []);
});

/** Build a cause chain of `depth` links ending in an error with the given name. */
function causeChain(depth, name) {
  let value = { name };
  for (let level = 0; level < depth; level += 1) value = { cause: value };
  return value;
}

test('nested aborts and timeouts map to network-failure inside the depth bound', () => {
  for (const name of ['AbortError', 'TimeoutError'])
    for (const depth of [1, 5])
      for (const stage of ['token', 'read'])
        assert.equal(
          failure(causeChain(depth, name), stage).code,
          'network-failure',
        );
});

test('an abort past the depth bound and a cyclic cause stay request-failed', () => {
  for (const name of ['AbortError', 'TimeoutError'])
    for (const stage of ['token', 'read'])
      assert.equal(failure(causeChain(6, name), stage).code, 'request-failed');
  const cyclic = {};
  cyclic.cause = cyclic;
  for (const stage of ['token', 'read'])
    assert.equal(failure(cyclic, stage).code, 'request-failed');
});

test('cached tokens within five minutes of expiry do not trigger an uncoordinated refresh', async (t) => {
  const calls = [];
  const transportPrototype = Object.getPrototypeOf(
    new OAuth2Client().transporter,
  );
  t.mock.method(transportPrototype, 'request', async (options) => {
    const url = new URL(options.url);
    calls.push(url.pathname);
    assert.equal(url.hostname, 'admin.googleapis.com');
    assert.equal(
      new Headers(options.headers).get('authorization'),
      'Bearer cached-fixture-token',
    );
    return {
      data: url.pathname.endsWith('/my_customer') ? customer : domains,
      status: 200,
    };
  });
  const result = await new GoogleCustomerVerifier().observe(
    {
      accessToken: 'cached-fixture-token',
      expiresAt: Date.now() + 90_000,
      scopeProfile: 'customer-domain-v1',
    },
    AbortSignal.timeout(5000),
  );
  assert.equal(result.customerId, customer.id);
  assert.equal(calls.length, 2);
});

/** Accept the connection and never answer, as the production token mint observed. */
async function silentServer(t) {
  const server = createServer(() => undefined);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/token`;
}

/** The request options of `boundClient` (provider.ts:224-233), with a local URL and a short test bound. */
function boundedOptions(url, overrides) {
  return {
    url,
    method: 'GET',
    retry: false,
    retryConfig: { retry: 0 },
    maxRedirects: 0,
    maxContentLength: 262144,
    size: 262144,
    ...overrides,
  };
}

async function rejection(pending) {
  try {
    await pending;
  } catch (reason) {
    return reason;
  }
  assert.fail('The request must fail.');
}

/** Record the shape from the production token mint. gaxios wraps the abort below the outer error. */
function assertWrappedAbort(error) {
  assert.equal(error instanceof GaxiosError, true);
  assert.equal(error.name, 'Error');
  assert.equal(error.code, undefined);
  assert.equal(error.cause.name, 'AbortError');
}

test('a gaxios request timeout maps to network-failure at both stages', async (t) => {
  const url = await silentServer(t);
  const error = await rejection(request(boundedOptions(url, { timeout: 100 })));
  assertWrappedAbort(error);
  for (const stage of ['token', 'read'])
    assert.equal(failure(error, stage).code, 'network-failure');
});

test('a caller abort maps to network-failure at both stages', async (t) => {
  const url = await silentServer(t);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const error = await rejection(
    request(boundedOptions(url, { signal: controller.signal, timeout: 5000 })),
  );
  clearTimeout(timer);
  assertWrappedAbort(error);
  for (const stage of ['token', 'read'])
    assert.equal(failure(error, stage).code, 'network-failure');
});
