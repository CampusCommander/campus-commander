import assert from 'node:assert/strict';
import test from 'node:test';
import {
  devicePredicateSchema,
  deviceQuerySchema,
  deviceRowSchema,
  deviceSyncStateSchema,
} from './devices.ts';
import {
  actionSchema,
  actionScopeKinds,
  isAuthorized,
} from './authorization.ts';

const row = {
  deviceId: 'd1',
  serialNumber: 'C0A1-7F2D',
  model: null,
  assetTag: null,
  orgUnitPath: '/',
  lastContact: null,
  annotatedLocation: null,
  notes: null,
};

test('device queries default to the first serial page', () => {
  assert.deepEqual(deviceQuerySchema.parse({}), {
    predicates: [],
    sort: { field: 'serialNumber', direction: 'asc' },
    offset: 0,
    limit: 100,
  });
});

test('predicates accept only the operators of their field type', () => {
  const ok = (value) => devicePredicateSchema.safeParse(value).success;
  assert.equal(ok({ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }), true);
  assert.equal(ok({ field: 'assetTag', operator: 'isEmpty' }), true);
  assert.equal(ok({ field: 'assetTag', operator: 'isEmpty', value: 'x' }), false);
  assert.equal(ok({ field: 'battery', operator: 'contains', value: 'x' }), false);
  assert.equal(ok({ field: 'battery', operator: 'is', values: ['replace-soon'] }), true);
  assert.equal(ok({ field: 'battery', operator: 'is', values: [] }), false);
  assert.equal(ok({ field: 'orgUnitPath', operator: 'within', value: 'School A' }), false);
  assert.equal(ok({ field: 'orgUnitPath', operator: 'within', value: '/School A' }), true);
  assert.equal(ok({ field: 'lastContact', operator: 'after', value: '2026-10-01T00:00:00Z' }), true);
  assert.equal(ok({ field: 'school', operator: 'equals', value: 'x' }), false);
});

test('queries bound page size, predicate count, and unknown keys', () => {
  assert.equal(deviceQuerySchema.safeParse({ limit: 201 }).success, false);
  assert.equal(
    deviceQuerySchema.safeParse({
      predicates: Array(21).fill({ field: 'model', operator: 'contains', value: 'a' }),
    }).success,
    false,
  );
  assert.equal(deviceQuerySchema.safeParse({ extra: true }).success, false);
});

test('battery values distinguish reported, missing, and unavailable data', () => {
  const reported = {
    status: 'reported',
    health: 'replace-soon',
    capacityPercent: 78,
    reportedAt: '2026-09-05T09:50:00-04:00',
  };
  assert.equal(deviceRowSchema.safeParse({ ...row, battery: reported }).success, true);
  for (const status of ['no-report', 'unavailable'])
    assert.equal(deviceRowSchema.safeParse({ ...row, battery: { status } }).success, true);
  assert.equal(deviceRowSchema.safeParse({ ...row, battery: { status: 'reported' } }).success, false);
  assert.equal(deviceRowSchema.safeParse({ ...row, battery: { status: 'unsupported' } }).success, false);
});

test('sync failures include orchestration and interruption codes', () => {
  const state = {
    customerId: 'C0123456',
    generation: 1,
    status: 'failed',
    observedAt: null,
    deviceCount: 0,
    failure: 'interrupted',
    telemetryFailure: null,
    startedAt: null,
    checkedAt: '2026-10-05T10:00:00Z',
    stale: false,
  };
  assert.equal(deviceSyncStateSchema.safeParse(state).success, true);
  assert.equal(
    deviceSyncStateSchema.safeParse({ ...state, failure: 'orchestration-unavailable' }).success,
    true,
  );
  assert.equal(deviceSyncStateSchema.safeParse({ ...state, failure: 'unknown' }).success, false);
});

test('devices:read applies to platform and district scopes', () => {
  assert.ok(actionSchema.options.includes('devices:read'));
  assert.deepEqual(actionScopeKinds['devices:read'], ['platform', 'district']);
  const grants = [{ action: 'devices:read', scope: { kind: 'district', customerId: 'C0123456' } }];
  assert.equal(isAuthorized(grants, 'devices:read', { kind: 'district', customerId: 'C0123456' }), true);
  assert.equal(isAuthorized(grants, 'devices:read', { kind: 'district', customerId: 'C9999999' }), false);
});
