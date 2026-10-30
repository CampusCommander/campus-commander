import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GOOGLE_CAPABILITIES,
  GOOGLE_CUSTOMER_SCOPES,
} from './google-capabilities.ts';
import {
  GOOGLE_HEALTH_CAPABILITY_IDS,
  GOOGLE_HEALTH_RECOVERY,
  googleHealthCheckSchema,
  googleCapabilityResultSchema,
  googleHealthFailureSchema,
  googleHealthSchema,
} from './google-health.ts';

test('Phase 3 scope instructions exclude optional OUs and every inventory or mutation scope', () => {
  const enabled = GOOGLE_CAPABILITIES.filter(
    (capability) =>
      capability.requiredForConnection &&
      capability.enabled &&
      capability.qualified,
  );
  assert.deepEqual(
    enabled.map((capability) => capability.id),
    ['customer-identity', 'domain-observations'],
  );
  assert.deepEqual(GOOGLE_CUSTOMER_SCOPES, [
    'https://www.googleapis.com/auth/admin.directory.customer.readonly',
    'https://www.googleapis.com/auth/admin.directory.domain.readonly',
  ]);
  assert.deepEqual(
    GOOGLE_CAPABILITIES.filter(
      (capability) =>
        !capability.requiredForConnection &&
        capability.enabled &&
        capability.qualified,
    ).map((capability) => capability.scope),
    [
      'https://www.googleapis.com/auth/admin.directory.orgunit.readonly',
      'https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly',
      'https://www.googleapis.com/auth/chrome.management.telemetry.readonly',
    ],
  );
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
  assert.deepEqual(
    GOOGLE_HEALTH_CAPABILITY_IDS,
    GOOGLE_CAPABILITIES.map((capability) => capability.id),
  );
  assert.ok(
    googleHealthCheckSchema.safeParse({
      ...base,
      capabilities: GOOGLE_HEALTH_CAPABILITY_IDS,
    }).success,
  );
  for (const capability of GOOGLE_HEALTH_CAPABILITY_IDS)
    assert.ok(
      googleHealthCheckSchema.safeParse({ ...base, capabilities: [capability] })
        .success,
    );
  for (const capabilities of [
    [],
    ['customer-identity', 'customer-identity'],
    ['users'],
  ])
    assert.equal(
      googleHealthCheckSchema.safeParse({ ...base, capabilities }).success,
      false,
    );
});

test('the health state reports every capability once, with no missing result', () => {
  assert.equal(GOOGLE_HEALTH_CAPABILITY_IDS.length, 7);
  assert.deepEqual(GOOGLE_HEALTH_CAPABILITY_IDS, [
    'customer-identity',
    'domain-observations',
    'school-ou-references',
    'device-inventory',
    'device-telemetry',
    'device-changes',
    'drive-files',
  ]);
  const observedAt = new Date().toISOString();
  const capabilities = GOOGLE_HEALTH_CAPABILITY_IDS.map((capability) => ({
    capability,
    scopeVerified: true,
    failure: null,
    checkedAt: observedAt,
    lastSucceededAt: null,
    correlationId: null,
  }));
  const health = {
    customerId: 'C0123456',
    generation: 1,
    observedAt,
    backgroundFailure: null,
    check: null,
    capabilities,
  };
  assert.ok(googleHealthSchema.safeParse(health).success);
  assert.equal(
    googleHealthSchema.safeParse({
      ...health,
      capabilities: capabilities.slice(1),
    }).success,
    false,
  );
  assert.equal(
    googleHealthSchema.safeParse({
      ...health,
      capabilities: [...capabilities, capabilities[0]],
    }).success,
    false,
  );
});

test('an unchecked capability carries no check time or successful history', () => {
  const observedAt = new Date().toISOString();
  const setup = ['customer-identity', 'domain-observations'];
  const health = {
    customerId: 'C0123456',
    generation: 1,
    observedAt,
    backgroundFailure: null,
    check: null,
    capabilities: GOOGLE_HEALTH_CAPABILITY_IDS.map((capability) => ({
      capability,
      scopeVerified: setup.includes(capability),
      failure: null,
      checkedAt: setup.includes(capability) ? observedAt : null,
      lastSucceededAt: setup.includes(capability) ? observedAt : null,
      correlationId: null,
    })),
  };
  assert.ok(googleHealthSchema.safeParse(health).success);
  assert.equal(
    googleHealthSchema.safeParse({
      ...health,
      capabilities: health.capabilities.map((item) => ({
        ...item,
        checkedAt: undefined,
      })),
    }).success,
    false,
    'a check time is null, never missing',
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
