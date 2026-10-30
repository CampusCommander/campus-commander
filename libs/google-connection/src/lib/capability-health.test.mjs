import assert from 'node:assert/strict';
import test from 'node:test';
import { JWT, OAuth2Client } from 'google-auth-library';
import { GOOGLE_CAPABILITIES } from '@campus/application-contracts';
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
const orgUnits = { organizationUnits: [{ orgUnitId: 'id-1' }] };
const devices = { chromeosdevices: [{ deviceId: 'device-1' }] };
const telemetry = { devices: [{ deviceId: 'device-1' }] };
/** Every capability id and the one scope that its health check requests. */
const capabilities = GOOGLE_CAPABILITIES.map((capability) => capability.id);
const scopeOf = (id) =>
  GOOGLE_CAPABILITIES.find((capability) => capability.id === id).scope;

/** Record every token and API request the verifier sends. */
function stub(
  t,
  {
    tokenFailure,
    readFailure,
    infoScopes,
    observedCustomer = customer,
    observedDomains = domains,
  } = {},
) {
  const calls = [];
  t.mock.method(JWT.prototype, 'getAccessToken', async function () {
    calls.push({ operation: 'token', scopes: this.scopes });
    const denied = tokenFailure?.(this.scopes[0]);
    if (denied) throw denied;
    return { token: this.scopes[0] };
  });
  t.mock.method(JWT.prototype, 'getTokenInfo', async (token) => ({
    scopes: infoScopes ?? [token],
    expiry_date: Date.now() + 3_500_000,
  }));
  t.mock.method(OAuth2Client.prototype, 'request', async (options) => {
    calls.push({
      operation: 'read',
      url: options.url,
      method: options.method,
      params: options.params,
    });
    if (options.url.endsWith('/my_customer')) return { data: observedCustomer };
    if (readFailure) throw readFailure;
    if (options.url.endsWith('/domains')) return { data: observedDomains };
    if (options.url.endsWith('/orgunits')) return { data: orgUnits };
    if (options.url.endsWith('/devices/chromeos')) return { data: devices };
    if (options.url.endsWith('/telemetry/devices')) return { data: telemetry };
    if (options.url.endsWith('/files')) return { data: { files: [] } };
    throw new Error(`The verifier requested an unexpected URL: ${options.url}`);
  });
  return calls;
}
const check = (requested) =>
  new GoogleCustomerVerifier().checkCapabilities(
    credential,
    customer.id,
    requested,
    AbortSignal.timeout(30000),
  );
const reads = (calls) =>
  calls.filter((call) => call.operation === 'read' && call.url);

test('partial DWD authorization preserves the working capability and requests no optional scope', async (t) => {
  const calls = stub(t, {
    tokenFailure: (scope) =>
      scope.endsWith('domain.readonly')
        ? {
            response: { status: 400, data: { error: 'unauthorized_client' } },
          }
        : undefined,
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
  assert.equal(reads(calls).length, 1);
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
      tokenFailure: () => ({
        response: { status: 400, data: { error: reason } },
      }),
    });
    assert.deepEqual((await check(['domain-observations'])).results, [
      { capability: 'domain-observations', scopeVerified: false, failure },
    ]);
    t.mock.restoreAll();
  }
});

/** Live Google answers an ungranted scope with HTTP 401 unauthorized_client. */
test('a 401 token refusal records a delegation denial for the denied capability', async (t) => {
  stub(t, {
    tokenFailure: () => ({
      response: { status: 401, data: { error: 'unauthorized_client' } },
    }),
  });
  assert.deepEqual((await check(['domain-observations'])).results, [
    {
      capability: 'domain-observations',
      scopeVerified: false,
      failure: 'delegation-not-authorized',
    },
  ]);
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
  assert.equal(reads(calls).length, 0);
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

test('all seven capabilities request one exact scope each and read the smallest page', async (t) => {
  const calls = stub(t);
  const result = await check(capabilities);
  assert.deepEqual(
    result.results,
    capabilities.map((capability) => ({
      capability,
      scopeVerified: true,
      failure: null,
    })),
  );
  assert.equal(capabilities.length, 7);
  assert.equal(result.observation?.customerId, customer.id);
  const tokens = calls.filter((call) => call.operation === 'token');
  assert.equal(tokens.length, capabilities.length);
  assert.ok(tokens.every((call) => call.scopes.length === 1));
  assert.deepEqual(
    tokens.map((call) => call.scopes[0]).sort(),
    capabilities.map(scopeOf).sort(),
  );
  const read = reads(calls);
  assert.equal(read.length, 6, 'the device write capability reads nothing');
  assert.ok(read.every((call) => call.method === 'GET'));
  const orgUnitsRead = read.find((call) => call.url.endsWith('/orgunits'));
  assert.deepEqual(orgUnitsRead.params, {
    type: 'children',
    fields: 'organizationUnits(orgUnitId)',
  });
  const devicesRead = read.find((call) =>
    call.url.endsWith('/devices/chromeos'),
  );
  assert.equal(devicesRead.params.maxResults, 1);
  const telemetryRead = read.find((call) =>
    call.url.endsWith('/telemetry/devices'),
  );
  assert.equal(telemetryRead.params.pageSize, 1);
  const driveRead = read.find((call) => call.url.endsWith('/drive/v3/files'));
  assert.deepEqual(driveRead.params, { pageSize: 1, fields: 'files(id)' });
});

test('the drive-files check reads an empty file list with its own exact scope', async (t) => {
  const calls = stub(t);
  const result = await check(['drive-files']);
  assert.deepEqual(result.results, [
    { capability: 'drive-files', scopeVerified: true, failure: null },
  ]);
  assert.equal(result.observation, null);
  assert.deepEqual(calls[0], {
    operation: 'token',
    scopes: [scopeOf('drive-files')],
  });
  assert.equal(calls[1].operation, 'read');
  assert.equal(calls[1].url, 'https://www.googleapis.com/drive/v3/files');
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls.length, 2, 'the drive check sends no write');
});

test('a denied Drive scope fails drive-files only', async (t) => {
  stub(t, {
    tokenFailure: (scope) =>
      scope === scopeOf('drive-files')
        ? {
            response: { status: 401, data: { error: 'unauthorized_client' } },
          }
        : undefined,
  });
  const result = await check(capabilities);
  assert.deepEqual(
    result.results.map((entry) => [entry.capability, entry.failure]),
    capabilities.map((capability) => [
      capability,
      capability === 'drive-files' ? 'delegation-not-authorized' : null,
    ]),
  );
  assert.equal(result.observation?.customerId, customer.id);
});

test('the device-changes check requests its token only and sends no write request', async (t) => {
  const calls = stub(t);
  const result = await check(['device-changes']);
  assert.deepEqual(result.results, [
    { capability: 'device-changes', scopeVerified: true, failure: null },
  ]);
  assert.equal(result.observation, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, 'token');
  assert.deepEqual(calls[0].scopes, [scopeOf('device-changes')]);
  assert.equal(
    calls.some((call) => call.method === 'PATCH'),
    false,
    'the health check never sends a device write',
  );
});

test('a denied device write scope fails device-changes only', async (t) => {
  stub(t, {
    tokenFailure: (scope) =>
      scope === scopeOf('device-changes')
        ? {
            response: { status: 401, data: { error: 'unauthorized_client' } },
          }
        : undefined,
  });
  const result = await check(capabilities);
  assert.deepEqual(
    result.results.map((entry) => [entry.capability, entry.failure]),
    capabilities.map((capability) => [
      capability,
      capability === 'device-changes' ? 'delegation-not-authorized' : null,
    ]),
  );
  assert.equal(result.observation?.customerId, customer.id);
});

test('a denied org unit scope fails school-ou-references only', async (t) => {
  stub(t, {
    tokenFailure: (scope) =>
      scope === scopeOf('school-ou-references')
        ? {
            response: { status: 401, data: { error: 'unauthorized_client' } },
          }
        : undefined,
  });
  const result = await check(capabilities);
  assert.deepEqual(
    result.results.map((entry) => [entry.capability, entry.failure]),
    capabilities.map((capability) => [
      capability,
      capability === 'school-ou-references'
        ? 'delegation-not-authorized'
        : null,
    ]),
  );
});

test('an inconsistent customer/domain observation keeps every other capability result', async (t) => {
  stub(t, {
    // The domains read names example.invalid as primary, so the combined
    // observation contradicts the customer identity answer.
    observedCustomer: { ...customer, customerDomain: 'other.example.invalid' },
    tokenFailure: (scope) =>
      scope === scopeOf('device-changes')
        ? {
            response: { status: 401, data: { error: 'unauthorized_client' } },
          }
        : undefined,
  });
  const result = await check(capabilities);
  assert.deepEqual(result.results, [
    {
      capability: 'customer-identity',
      scopeVerified: true,
      failure: 'invalid-response',
    },
    {
      capability: 'domain-observations',
      scopeVerified: true,
      failure: 'invalid-response',
    },
    {
      capability: 'school-ou-references',
      scopeVerified: true,
      failure: null,
    },
    {
      capability: 'device-inventory',
      scopeVerified: true,
      failure: null,
    },
    {
      capability: 'device-telemetry',
      scopeVerified: true,
      failure: null,
    },
    {
      capability: 'device-changes',
      scopeVerified: false,
      failure: 'delegation-not-authorized',
    },
    {
      capability: 'drive-files',
      scopeVerified: true,
      failure: null,
    },
  ]);
  assert.equal(result.observation, null);
});
