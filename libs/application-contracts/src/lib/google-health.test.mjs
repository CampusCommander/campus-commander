import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GOOGLE_CAPABILITIES,
  GOOGLE_CUSTOMER_SCOPES,
} from './google-capabilities.ts';
import {
  GOOGLE_HEALTH_RECOVERY,
  googleHealthCheckSchema,
  googleCapabilityResultSchema,
  googleHealthFailureSchema,
} from './google-health.ts';

test('Phase 3 scope instructions exclude optional OUs and every inventory or mutation scope', () => {
  const enabled = GOOGLE_CAPABILITIES.filter(
    (capability) => capability.enabled && capability.qualified,
  );
  assert.deepEqual(
    enabled.map((capability) => capability.id),
    ['customer-identity', 'domain-observations'],
  );
  assert.deepEqual(GOOGLE_CUSTOMER_SCOPES, [
    'https://www.googleapis.com/auth/admin.directory.customer.readonly',
    'https://www.googleapis.com/auth/admin.directory.domain.readonly',
  ]);
  assert.ok(
    enabled.every(
      (capability) =>
        capability.source.startsWith('https://developers.google.com/') &&
        capability.evidence,
    ),
  );
  const base = {
    customerId: 'C0123456',
    generation: 1,
    capabilities: ['customer-identity'],
  };
  assert.ok(googleHealthCheckSchema.safeParse(base).success);
  for (const capabilities of [
    [],
    ['school-ou-references'],
    ['customer-identity', 'customer-identity'],
    ['users'],
  ])
    assert.equal(
      googleHealthCheckSchema.safeParse({ ...base, capabilities }).success,
      false,
    );
});

test('scope evidence remains distinct from successful operations and every failure has recovery guidance', () => {
  assert.equal(
    googleCapabilityResultSchema.safeParse({
      capability: 'domain-observations',
      scopeVerified: false,
      failure: null,
    }).success,
    false,
  );
  assert.ok(
    googleCapabilityResultSchema.safeParse({
      capability: 'domain-observations',
      scopeVerified: true,
      failure: 'permission-denied',
    }).success,
  );
  for (const failure of googleHealthFailureSchema.options) {
    assert.ok(GOOGLE_HEALTH_RECOVERY[failure].label);
    assert.ok(GOOGLE_HEALTH_RECOVERY[failure].recovery);
  }
});
