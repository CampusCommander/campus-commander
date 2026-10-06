import assert from 'node:assert/strict';
import test from 'node:test';
import {
  devicePredicateSchema,
  deviceQuerySchema,
  deviceRowSchema,
  deviceSyncStateSchema,
  deviceOrgUnitsSchema,
  deviceSelectionChangeSchema,
  deviceSelectionKeySchema,
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
    selection: null,
  });
});

test('predicates accept only the operators of their field type', () => {
  const ok = (value) => devicePredicateSchema.safeParse(value).success;
  assert.equal(
    ok({ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }),
    true,
  );
  assert.equal(ok({ field: 'assetTag', operator: 'isEmpty' }), true);
  assert.equal(
    ok({ field: 'assetTag', operator: 'isEmpty', value: 'x' }),
    false,
  );
  assert.equal(
    ok({ field: 'battery', operator: 'contains', value: 'x' }),
    false,
  );
  assert.equal(
    ok({ field: 'battery', operator: 'is', values: ['replace-soon'] }),
    true,
  );
  // An empty set filter is valid. It matches no devices.
  assert.equal(ok({ field: 'battery', operator: 'is', values: [] }), true);
  assert.equal(
    ok({ field: 'orgUnitPath', operator: 'in', values: ['School A'] }),
    false,
  );
  assert.equal(
    ok({ field: 'orgUnitPath', operator: 'in', values: ['/School A', '/'] }),
    true,
  );
  assert.equal(ok({ field: 'orgUnitPath', operator: 'in', values: [] }), true);
  assert.equal(
    ok({ field: 'orgUnitPath', operator: 'within', value: '/School A' }),
    false,
  );
  assert.equal(
    ok({
      field: 'lastContact',
      operator: 'after',
      value: '2026-10-01T00:00:00Z',
    }),
    true,
  );
  assert.equal(ok({ field: 'school', operator: 'equals', value: 'x' }), false);
});

test('queries bound page size, predicate count, and unknown keys', () => {
  assert.equal(deviceQuerySchema.safeParse({ limit: 201 }).success, false);
  assert.equal(
    deviceQuerySchema.safeParse({
      predicates: Array(21).fill({
        field: 'model',
        operator: 'contains',
        value: 'a',
      }),
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
  assert.equal(
    deviceRowSchema.safeParse({ ...row, battery: reported }).success,
    true,
  );
  for (const status of ['no-report', 'unavailable'])
    assert.equal(
      deviceRowSchema.safeParse({ ...row, battery: { status } }).success,
      true,
    );
  assert.equal(
    deviceRowSchema.safeParse({ ...row, battery: { status: 'reported' } })
      .success,
    false,
  );
  assert.equal(
    deviceRowSchema.safeParse({ ...row, battery: { status: 'unsupported' } })
      .success,
    false,
  );
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
    deviceSyncStateSchema.safeParse({
      ...state,
      failure: 'orchestration-unavailable',
    }).success,
    true,
  );
  assert.equal(
    deviceSyncStateSchema.safeParse({ ...state, failure: 'unknown' }).success,
    false,
  );
});

test('devices:read applies to platform and district scopes', () => {
  assert.ok(actionSchema.options.includes('devices:read'));
  assert.deepEqual(actionScopeKinds['devices:read'], ['platform', 'district']);
  const grants = [
    {
      action: 'devices:read',
      scope: { kind: 'district', customerId: 'C0123456' },
    },
  ];
  assert.equal(
    isAuthorized(grants, 'devices:read', {
      kind: 'district',
      customerId: 'C0123456',
    }),
    true,
  );
  assert.equal(
    isAuthorized(grants, 'devices:read', {
      kind: 'district',
      customerId: 'C9999999',
    }),
    false,
  );
});

test('organization unit lists carry a path and a device count', () => {
  assert.equal(
    deviceOrgUnitsSchema.safeParse([{ path: '/School A', devices: 150 }])
      .success,
    true,
  );
  assert.equal(
    deviceOrgUnitsSchema.safeParse([{ path: 'School A', devices: 1 }]).success,
    false,
  );
  assert.equal(
    deviceOrgUnitsSchema.safeParse([{ path: '/', devices: -1 }]).success,
    false,
  );
});

const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';

test('selection keys name the device grid and a tab UUID', () => {
  const key = { gridId: 'devices', tabId };
  assert.equal(deviceSelectionKeySchema.safeParse(key).success, true);
  assert.equal(
    deviceSelectionKeySchema.safeParse({ ...key, gridId: 'users' }).success,
    false,
  );
  assert.equal(
    deviceSelectionKeySchema.safeParse({ ...key, tabId: 'tab-1' }).success,
    false,
  );
  assert.deepEqual(deviceQuerySchema.parse({ selection: key }).selection, key);
});

test('selection changes accept the four row operations within bounds', () => {
  const ok = (ops) =>
    deviceSelectionChangeSchema.safeParse({ gridId: 'devices', tabId, ops })
      .success;
  assert.equal(
    ok([
      {
        op: 'selectAll',
        predicates: [
          { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
        ],
      },
      { op: 'deselect', ids: ['d1'] },
      { op: 'select', ids: ['d2'] },
      { op: 'deselectAll' },
    ]),
    true,
  );
  assert.equal(ok([]), false);
  assert.equal(ok([{ op: 'select', ids: [] }]), false);
  assert.equal(ok([{ op: 'select', ids: Array(2001).fill('d') }]), false);
  assert.equal(ok([{ op: 'selectGroup', route: ['/School A'] }]), false);
});
