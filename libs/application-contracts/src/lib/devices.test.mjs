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
  deviceGroupQuerySchema,
  deviceGroupingSchema,
  deviceDetailSchema,
  devicePageSchema,
  DEVICE_BY_IDS_LIMIT,
  deviceByIdsSchema,
  deviceFreshnessSchema,
  deviceRowsSchema,
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
  lastEntitySync: '2026-10-05T12:00:00.000Z',
  stale: false,
};

test('device queries default to the first serial page', () => {
  assert.deepEqual(deviceQuerySchema.parse({}), {
    predicates: [],
    sort: { field: 'serialNumber', direction: 'asc' },
    offset: 0,
    limit: 100,
    selection: null,
    group: { by: [], keys: [] },
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
  assert.equal(deviceQuerySchema.safeParse({ limit: 1001 }).success, false);
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

test('grouping names each field once and keys only grouped levels', () => {
  const ok = (value) => deviceGroupingSchema.safeParse(value).success;
  assert.equal(
    ok({ by: ['orgUnitPath', 'battery'], keys: ['/School A'] }),
    true,
  );
  assert.equal(ok({ by: ['model'], keys: [''] }), true);
  assert.equal(ok({ by: ['model', 'model'], keys: [] }), false);
  assert.equal(ok({ by: ['serialNumber'], keys: [] }), false);
  assert.equal(ok({ by: ['model'], keys: ['a', 'b'] }), false);
  assert.equal(
    ok({ by: ['orgUnitPath', 'model', 'battery', 'model'], keys: [] }),
    false,
  );
});

test('group requests need an unopened level', () => {
  const ok = (group) => deviceGroupQuerySchema.safeParse({ group }).success;
  assert.equal(ok({ by: ['battery'], keys: [] }), true);
  assert.equal(ok({ by: ['battery'], keys: ['normal'] }), false);
  assert.equal(ok({ by: [], keys: [] }), false);
  assert.equal(
    deviceQuerySchema.safeParse({ limit: 1000 }).success &&
      !deviceQuerySchema.safeParse({ limit: 1001 }).success,
    true,
  );
});

test('group selection operations carry the filters and grouped fields', () => {
  const ok = (op) =>
    deviceSelectionChangeSchema.safeParse({
      gridId: 'devices',
      tabId,
      ops: [op],
    }).success;
  const scope = {
    predicates: [],
    by: ['orgUnitPath', 'model'],
    route: ['/School A'],
  };
  assert.equal(ok({ op: 'selectGroup', ...scope }), true);
  assert.equal(
    ok({ op: 'deselectGroup', ...scope, route: ['/School A', ''] }),
    true,
  );
  assert.equal(
    ok({ op: 'selectGroup', ...scope, route: ['a', 'b', 'c'] }),
    false,
  );
  assert.equal(ok({ op: 'selectGroup', ...scope, route: [] }), false);
});

test('rows carry freshness and details carry removal', () => {
  const parsed = deviceRowSchema.parse({
    ...row,
    battery: { status: 'no-report' },
  });
  assert.equal(parsed.stale, false);
  assert.equal(
    deviceRowSchema.safeParse({
      ...row,
      battery: { status: 'no-report' },
      stale: undefined,
    }).success,
    false,
  );
  const detail = deviceDetailSchema.parse({
    ...row,
    battery: { status: 'no-report' },
    removedAt: null,
    batteryReports: [],
  });
  assert.equal(detail.removedAt, null);
  assert.equal('observedAt' in detail, false);
  assert.equal(
    devicePageSchema.parse({
      rows: [],
      matching: 0,
      total: 0,
      observedAt: null,
      refreshJobId: null,
    }).refreshJobId,
    null,
  );
});

test('by-ids takes 1 to 500 device IDs and nothing else', () => {
  assert.equal(DEVICE_BY_IDS_LIMIT, 500);
  assert.equal(deviceByIdsSchema.safeParse({ deviceIds: [] }).success, false);
  assert.equal(
    deviceByIdsSchema.safeParse({ deviceIds: ['d1'] }).success,
    true,
  );
  assert.equal(
    deviceByIdsSchema.safeParse({
      deviceIds: Array.from({ length: 501 }, (_, index) => `d${index}`),
    }).success,
    false,
  );
  assert.equal(
    deviceByIdsSchema.safeParse({ deviceIds: ['d1'], extra: 1 }).success,
    false,
  );
  assert.equal(deviceRowsSchema.safeParse([]).success, true);
});

test('freshness reports the stale count and whether a refresh runs', () => {
  assert.deepEqual(
    deviceFreshnessSchema.parse({ stale: 12, refreshing: true }),
    { stale: 12, refreshing: true },
  );
  assert.equal(
    deviceFreshnessSchema.safeParse({ stale: -1, refreshing: false }).success,
    false,
  );
});
