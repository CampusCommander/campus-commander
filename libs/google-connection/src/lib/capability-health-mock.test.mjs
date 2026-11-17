/**
 * Runs the capability health check against the Admin SDK mock.
 * The mock answers the OAuth exchange, the Directory API, the Chrome Management API, and the
 * Drive API with real HTTP, so each capability proves its own delegated scope. No live Google
 * call. Run the file inside `nx run google-connection:test`.
 *
 * The credentials use the review harness grant. `GOOGLE_HARNESS_SCOPES` is the scope list that
 * the harness fixture writes into the service account. A scope that leaves that list stops the
 * token exchange here, so these tests fail with the harness.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startMock } from '@campuscommander/admin-sdk-mock';
import {
  GOOGLE_CAPABILITIES,
  GOOGLE_HARNESS_SCOPES,
} from '@campus/application-contracts';
import { GoogleCustomerVerifier } from './provider.ts';
import { validateServiceAccount } from './credential.ts';

const timeout = 60_000;
/** The capability ids that admin-sdk-mock 0.4.0 serves, in capability order. */
const capabilities = GOOGLE_CAPABILITIES.map((capability) => capability.id);
const scopeOf = (id) =>
  GOOGLE_CAPABILITIES.find((capability) => capability.id === id).scope;
const without = (id) => capabilities.filter((capability) => capability !== id);

let mock;
let domain;

before(async () => {
  mock = await startMock();
  // The proxy and its CA route every Google client of this process to the mock.
  mock.useInProcess();
  domain = await mock.createDomain({
    tier: 'small',
    seed: 'capability-health-fixture',
  });
});

after(async () => {
  await mock?.close();
});

/** A delegated credential whose service account is granted exactly these scopes. */
function credentialForScopes(scopes) {
  const key = mock.credential(domain.customerId, scopes);
  return {
    serviceAccount: validateServiceAccount(key, key.client_id),
    subject: domain.adminEmail,
  };
}

/**
 * A delegated credential over the harness grant, limited to these capabilities.
 * A scope that the harness grant leaves out stays out of the credential.
 */
function credentialFor(ids) {
  const wanted = new Set(ids.map(scopeOf));
  return credentialForScopes(
    GOOGLE_HARNESS_SCOPES.filter((scope) => wanted.has(scope)),
  );
}

function check(credential, requested = capabilities) {
  return new GoogleCustomerVerifier().checkCapabilities(
    credential,
    domain.customerId,
    requested,
    AbortSignal.timeout(timeout),
  );
}

test('the harness service-account grant passes every capability check', async () => {
  assert.equal(
    capabilities.length,
    9,
    'admin-sdk-mock 0.4.0 serves nine scopes',
  );
  // The harness grant names both new read scopes. A later edit that drops one
  // from the shared grant fails the token exchange below.
  for (const capability of ['user-inventory', 'user-schemas'])
    assert.ok(
      GOOGLE_HARNESS_SCOPES.includes(scopeOf(capability)),
      `The harness grant names the ${capability} scope.`,
    );
  const result = await check(credentialForScopes(GOOGLE_HARNESS_SCOPES));
  assert.deepEqual(
    result.results,
    capabilities.map((capability) => ({
      capability,
      scopeVerified: true,
      failure: null,
    })),
  );
  assert.equal(result.observation?.customerId, domain.customerId);
});

test('a client without the Drive scope fails only drive-files', async () => {
  const result = await check(credentialFor(without('drive-files')));
  assert.deepEqual(
    result.results.map((entry) => [entry.capability, entry.failure]),
    capabilities.map((capability) => [
      capability,
      capability === 'drive-files' ? 'delegation-not-authorized' : null,
    ]),
  );
});

test('a client without the device write scope fails only device-changes', async () => {
  const result = await check(credentialFor(without('device-changes')));
  assert.deepEqual(
    result.results.map((entry) => [entry.capability, entry.failure]),
    capabilities.map((capability) => [
      capability,
      capability === 'device-changes' ? 'delegation-not-authorized' : null,
    ]),
  );
});

test('a client without the org unit scope fails only school-ou-references', async () => {
  const result = await check(credentialFor(without('school-ou-references')));
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

/**
 * The harness grant without the schema read scope. The mock refuses that token
 * exchange, and no other capability loses its result.
 */
test('the harness grant without the user schema read scope fails only user-schemas', async () => {
  assert.ok(GOOGLE_HARNESS_SCOPES.includes(scopeOf('user-schemas')));
  const result = await check(credentialFor(without('user-schemas')));
  assert.deepEqual(
    result.results.map((entry) => [entry.capability, entry.failure]),
    capabilities.map((capability) => [
      capability,
      capability === 'user-schemas' ? 'delegation-not-authorized' : null,
    ]),
  );
});

/** The same grant check for the user read scope. */
test('the harness grant without the user read scope fails only user-inventory', async () => {
  assert.ok(GOOGLE_HARNESS_SCOPES.includes(scopeOf('user-inventory')));
  const result = await check(credentialFor(without('user-inventory')));
  assert.deepEqual(
    result.results.map((entry) => [entry.capability, entry.failure]),
    capabilities.map((capability) => [
      capability,
      capability === 'user-inventory' ? 'delegation-not-authorized' : null,
    ]),
  );
});

test('the device write capability passes with its token alone', async () => {
  const result = await check(credentialFor(['device-changes']), [
    'device-changes',
  ]);
  assert.deepEqual(result.results, [
    { capability: 'device-changes', scopeVerified: true, failure: null },
  ]);
  assert.equal(result.observation, null);
});
