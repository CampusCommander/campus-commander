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
  deviceSelectionRefreshSchema,
  deviceSelectionSpecSchema,
  deviceDomainRefreshSchema,
  deviceGroupQuerySchema,
  deviceGroupingSchema,
  deviceDetailSchema,
  devicePageSchema,
  DEVICE_BY_IDS_LIMIT,
  deviceByIdsSchema,
  deviceFreshnessSchema,
  deviceRowsSchema,
  deviceSortFieldSchema,
  deviceTextFieldSchema,
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
  annotatedUser: null,
  notes: null,
  status: 'ACTIVE',
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

test('status filters take the three Google values and a status sort', () => {
  const ok = (value) => devicePredicateSchema.safeParse(value).success;
  assert.equal(
    ok({
      field: 'status',
      operator: 'is',
      values: ['ACTIVE', 'DISABLED', 'DEPROVISIONED'],
    }),
    true,
  );
  assert.equal(
    ok({ field: 'status', operator: 'is', values: ['DISABLED'] }),
    true,
  );
  // An empty set filter is valid. It matches no devices.
  assert.equal(ok({ field: 'status', operator: 'is', values: [] }), true);
  assert.equal(
    ok({ field: 'status', operator: 'is', values: ['RETIRED'] }),
    false,
  );
  assert.equal(
    ok({ field: 'status', operator: 'is', values: ['disabled'] }),
    false,
  );
  assert.equal(
    ok({
      field: 'status',
      operator: 'is',
      values: ['ACTIVE', 'DISABLED', 'DEPROVISIONED', 'ACTIVE'],
    }),
    false,
  );
  assert.equal(
    ok({ field: 'status', operator: 'contains', value: 'ACTIVE' }),
    false,
  );
  assert.equal(
    deviceQuerySchema.safeParse({
      sort: { field: 'status', direction: 'desc' },
    }).success,
    true,
  );
});

test('a device row carries the Google status, including an unknown value and null', () => {
  const battery = { status: 'no-report' };
  for (const status of ['ACTIVE', 'DISABLED', 'DEPROVISIONED', 'RETIRED', null])
    assert.equal(
      deviceRowSchema.safeParse({ ...row, status, battery }).success,
      true,
    );
  const missing = Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== 'status'),
  );
  assert.equal(
    deviceRowSchema.safeParse({ ...missing, battery }).success,
    false,
  );
});

test('a device row carries the annotated user, and requires the key', () => {
  const battery = { status: 'no-report' };
  assert.equal(
    deviceRowSchema.safeParse({
      ...row,
      annotatedUser: 'avery.chen@example.org',
      battery,
    }).success,
    true,
  );
  assert.equal(
    deviceRowSchema.safeParse({ ...row, annotatedUser: null, battery }).success,
    true,
  );
  const missing = Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== 'annotatedUser'),
  );
  assert.equal(
    deviceRowSchema.safeParse({ ...missing, battery }).success,
    false,
  );
  assert.equal(deviceTextFieldSchema.safeParse('annotatedUser').success, true);
  assert.equal(deviceSortFieldSchema.safeParse('annotatedUser').success, true);
});

test('a device row carries every Asset tag that Google stores', () => {
  const battery = { status: 'no-report' };
  const longTag = 'A'.repeat(1024);
  // A supplementary character is one code point and two UTF-16 units.
  const supplementaryTag = '𠮷'.repeat(300);
  const parsed = deviceRowSchema.parse({
    ...row,
    assetTag: longTag,
    battery,
  });
  assert.equal(parsed.assetTag, longTag);
  assert.equal(
    deviceRowSchema.safeParse({ ...row, assetTag: supplementaryTag, battery })
      .success,
    true,
  );
  assert.equal(
    deviceRowSchema.safeParse({ ...row, assetTag: 'A'.repeat(4097), battery })
      .success,
    false,
    'A tag above 4,096 UTF-16 units fails the contract.',
  );
  assert.equal(
    deviceDetailSchema.safeParse({
      ...row,
      assetTag: supplementaryTag,
      battery,
      removedAt: null,
      batteryReports: [],
    }).success,
    true,
    'Device details carry the same tag bound.',
  );
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

test('the selection spec requires expiredAt as a timestamp or null', () => {
  const base = {
    terms: [],
    groups: [],
    added: 0,
    excluded: 0,
    selectedCount: 0,
  };
  assert.equal(deviceSelectionSpecSchema.safeParse(base).success, false);
  assert.deepEqual(
    deviceSelectionSpecSchema.parse({ ...base, expiredAt: null }),
    { ...base, expiredAt: null },
  );
  assert.equal(
    deviceSelectionSpecSchema.safeParse({
      ...base,
      expiredAt: '2026-10-18T12:00:00.000Z',
    }).success,
    true,
  );
  assert.equal(
    deviceSelectionSpecSchema.safeParse({
      ...base,
      expiredAt: '2026-10-18T12:00:00',
    }).success,
    false,
  );
  assert.equal(
    deviceSelectionSpecSchema.safeParse({ ...base, expiredAt: 'yesterday' })
      .success,
    false,
  );
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

const syncState = {
  customerId: 'C0123456',
  generation: 1,
  status: 'running',
  observedAt: null,
  deviceCount: 0,
  failure: null,
  telemetryFailure: null,
  startedAt: '2026-10-20T12:00:00.000Z',
  checkedAt: null,
  stale: false,
};

test('a selection refresh answer names its job and its device count', () => {
  const jobId = '33333333-3333-4333-8333-333333333333';
  assert.deepEqual(deviceSelectionRefreshSchema.parse({ jobId, selected: 3 }), {
    jobId,
    selected: 3,
  });
  assert.equal(
    deviceSelectionRefreshSchema.safeParse({ jobId: null, selected: 3 })
      .success,
    true,
  );
  assert.equal(
    deviceSelectionRefreshSchema.safeParse({ jobId: null, selected: 0 })
      .success,
    false,
  );
  assert.equal(
    deviceSelectionRefreshSchema.safeParse({ jobId: 'job-1', selected: 3 })
      .success,
    false,
  );
  assert.equal(
    deviceSelectionRefreshSchema.safeParse({ jobId, selected: 100_001 })
      .success,
    false,
  );
  assert.equal(
    deviceSelectionRefreshSchema.safeParse({ jobId, selected: 3, extra: true })
      .success,
    false,
  );
});

test('a domain refresh answer pairs a status with exactly one reason rule', () => {
  assert.deepEqual(
    deviceDomainRefreshSchema.parse({
      sync: syncState,
      domain: { status: 'refreshed', reason: null },
    }),
    { sync: syncState, domain: { status: 'refreshed', reason: null } },
  );
  assert.deepEqual(
    deviceDomainRefreshSchema.parse({
      sync: syncState,
      domain: { status: 'failed', reason: 'quota' },
    }).domain,
    { status: 'failed', reason: 'quota' },
  );
  for (const reason of ['busy', 'unavailable', 'permission-denied'])
    assert.equal(
      deviceDomainRefreshSchema.safeParse({
        sync: syncState,
        domain: { status: 'failed', reason },
      }).success,
      true,
    );
  assert.equal(
    deviceDomainRefreshSchema.safeParse({
      sync: syncState,
      domain: { status: 'refreshed', reason: 'quota' },
    }).success,
    false,
  );
  assert.equal(
    deviceDomainRefreshSchema.safeParse({
      sync: syncState,
      domain: { status: 'failed', reason: null },
    }).success,
    false,
  );
  assert.equal(
    deviceDomainRefreshSchema.safeParse({
      sync: syncState,
      domain: { status: 'failed', reason: 'unknown' },
    }).success,
    false,
  );
});
