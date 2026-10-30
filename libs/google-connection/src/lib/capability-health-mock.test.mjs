/**
 * Runs the capability health check against the Admin SDK mock.
 * The mock answers the OAuth exchange, the Directory API, and the Chrome Management API
 * with real HTTP, so each capability proves its own delegated scope. No live Google call.
 * Run the file inside `nx run google-connection:test`.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startMock } from '@campuscommander/admin-sdk-mock';
import { GOOGLE_CAPABILITIES } from '@campus/application-contracts';
import { GoogleCustomerVerifier } from './provider.ts';
import { validateServiceAccount } from './credential.ts';

const timeout = 60_000;
/**
 * The capability ids that admin-sdk-mock 0.2.0 serves. The mock has no Drive
 * method, so this test leaves `drive-files` out until DM2 pins 0.3.0.
 */
const capabilities = GOOGLE_CAPABILITIES.map(
  (capability) => capability.id,
).filter((capability) => capability !== 'drive-files');
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

/** A delegated credential whose client is granted exactly these capability scopes. */
function credentialFor(ids) {
  const key = mock.credential(domain.customerId, ids.map(scopeOf));
  return {
    serviceAccount: validateServiceAccount(key, key.client_id),
    subject: domain.adminEmail,
  };
}

function check(credential, requested = capabilities) {
  return new GoogleCustomerVerifier().checkCapabilities(
    credential,
    domain.customerId,
    requested,
    AbortSignal.timeout(timeout),
  );
}

test('a client with the six scopes of admin-sdk-mock 0.2.0 passes every capability check', async () => {
  assert.equal(
    capabilities.length,
    6,
    'admin-sdk-mock 0.2.0 serves six scopes',
  );
  const result = await check(credentialFor(capabilities));
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

test('the device write capability passes with its token alone', async () => {
  const result = await check(credentialFor(['device-changes']), [
    'device-changes',
  ]);
  assert.deepEqual(result.results, [
    { capability: 'device-changes', scopeVerified: true, failure: null },
  ]);
  assert.equal(result.observation, null);
});
