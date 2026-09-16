import assert from 'node:assert/strict';
import test from 'node:test';
import { JWT, OAuth2Client } from 'google-auth-library';
import { GoogleCustomerVerifier } from './provider.ts';

const credential = {
  subject: 'fixture@example.invalid',
  serviceAccount: {
    client_email: 'fixture@project.iam.gserviceaccount.com',
    private_key: 'synthetic-private-key',
    private_key_id: 'fixture',
  },
};
const customer = { id: 'C0123456', customerDomain: 'example.invalid' };
const domains = {
  domains: [{ domainName: 'example.invalid', isPrimary: true, verified: true }],
};
function stub(
  t,
  { tokenFailure, readFailure, infoScopes, observedCustomer = customer } = {},
) {
  const calls = [];
  t.mock.method(JWT.prototype, 'getAccessToken', async function () {
    calls.push({ operation: 'token', scopes: this.scopes });
    if (tokenFailure && this.scopes[0].includes('domain.readonly'))
      throw tokenFailure;
    return { token: this.scopes[0] };
  });
  t.mock.method(JWT.prototype, 'getTokenInfo', async (token) => ({
    scopes: infoScopes ?? [token],
    expiry_date: Date.now() + 3_500_000,
  }));
  t.mock.method(OAuth2Client.prototype, 'request', async (options) => {
    calls.push({ operation: 'read', url: options.url });
    if (options.url.endsWith('/my_customer')) return { data: observedCustomer };
    if (readFailure) throw readFailure;
    return { data: domains };
  });
  return calls;
}
const check = (capabilities) =>
  new GoogleCustomerVerifier().checkCapabilities(
    credential,
    customer.id,
    capabilities,
    AbortSignal.timeout(30000),
  );

test('partial DWD authorization preserves the working capability and requests no optional scope', async (t) => {
  const calls = stub(t, {
    tokenFailure: {
      response: { status: 400, data: { error: 'unauthorized_client' } },
    },
  });
  const result = await check(['customer-identity', 'domain-observations']);
  assert.deepEqual(result.results, [
    { capability: 'customer-identity', scopeVerified: true, failure: null },
    {
      capability: 'domain-observations',
      scopeVerified: false,
      failure: 'delegation-not-authorized',
    },
  ]);
  assert.equal(result.observation, null);
  assert.equal(calls.filter((call) => call.operation === 'read').length, 1);
  assert.ok(
    calls
      .filter((call) => call.operation === 'token')
      .every(
        (call) =>
          call.scopes.length === 1 && !call.scopes[0].includes('orgunit'),
      ),
  );
});

test('a targeted domain check requests only its scope and distinguishes token scope from privileges', async (t) => {
  const calls = stub(t, {
    readFailure: {
      response: {
        status: 403,
        data: { error: { errors: [{ reason: 'forbidden' }] } },
      },
    },
  });
  const result = await check(['domain-observations']);
  assert.deepEqual(result.results, [
    {
      capability: 'domain-observations',
      scopeVerified: true,
      failure: 'permission-denied',
    },
  ]);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].scopes[0].endsWith('domain.readonly'));
  assert.ok(calls[1].url.endsWith('/customer/C0123456/domains'));
  assert.equal(result.observation, null);
});

test('DWD scope denial and policy restriction remain separate from credential rejection', async (t) => {
  for (const [reason, failure] of [
    ['access_denied', 'delegation-not-authorized'],
    ['admin_policy_enforced', 'policy-restricted'],
    ['invalid_scope', 'scope-mismatch'],
    ['invalid_grant', 'credential-rejected'],
    ['deleted_client', 'credential-rejected'],
  ]) {
    stub(t, {
      tokenFailure: { response: { status: 400, data: { error: reason } } },
    });
    assert.deepEqual((await check(['domain-observations'])).results, [
      { capability: 'domain-observations', scopeVerified: false, failure },
    ]);
    t.mock.restoreAll();
  }
});

test('API quota and network errors do not become authorization or license claims', async (t) => {
  for (const [readFailure, failure] of [
    [
      {
        response: {
          status: 403,
          data: { error: { errors: [{ reason: 'quotaExceeded' }] } },
        },
      },
      'quota',
    ],
    [{ response: { status: 429 } }, 'quota'],
    [{ code: 'ECONNRESET' }, 'network-failure'],
    [{ response: { status: 503 } }, 'provider-unavailable'],
    [{ response: { status: 403 } }, 'permission-denied'],
  ]) {
    stub(t, { readFailure });
    assert.equal(
      (await check(['domain-observations'])).results[0].failure,
      failure,
    );
    t.mock.restoreAll();
  }
});

test('extra token scopes prevent API reads and wrong-customer responses do not update observations', async (t) => {
  const calls = stub(t, { infoScopes: ['unexpected'] });
  assert.equal(
    (await check(['customer-identity'])).results[0].failure,
    'scope-mismatch',
  );
  assert.equal(calls.filter((call) => call.operation === 'read').length, 0);
  t.mock.restoreAll();
  stub(t, { observedCustomer: { ...customer, id: 'C9999999' } });
  const result = await check(['customer-identity', 'domain-observations']);
  assert.equal(result.results[0].failure, 'wrong-customer');
  assert.equal(result.observation, null);
});

test('successful capability checks produce one consistent customer observation without credentials', async (t) => {
  stub(t);
  const result = await check(['customer-identity', 'domain-observations']);
  assert.ok(
    result.results.every(
      (result) => result.scopeVerified && result.failure === null,
    ),
  );
  assert.equal(result.observation.customerId, customer.id);
  assert.equal(result.observation.primaryDomain, customer.customerDomain);
  assert.equal(JSON.stringify(result).includes('synthetic-private-key'), false);
});
