import assert from 'node:assert/strict';
import test from 'node:test';
import {
  USER_ATTRIBUTE_CATEGORY_LIMIT,
  USER_ATTRIBUTE_FIELD_LIMIT,
  USER_BY_IDS_LIMIT,
  userAttributeCategoriesSchema,
  userAttributeCategorySchema,
  userAttributeFieldSchema,
  userAttributeKeySchema,
  userAttributeKeys,
  userByIdsSchema,
  userDetailSchema,
  userDomainRefreshSchema,
  userFreshnessSchema,
  userOrgUnitsSchema,
  userPageSchema,
  userPredicateSchema,
  userQuerySchema,
  userRecordSchema,
  userRowSchema,
  userSelectionChangeSchema,
  userSelectionKeySchema,
  userSelectionRefreshSchema,
  userSelectionSpecSchema,
  userSyncStateSchema,
} from './users.ts';

const customerId = 'C0123456';
const at = '2026-11-16T12:00:00.000Z';

const customSchemas = {
  StudentInfo: {
    Homeroom: 'B12',
    Programs: [{ value: 'ELL' }, { value: 'Band' }],
    GradeLevel: 7,
    Graduating: false,
  },
};

const record = {
  userId: '107000000000000000001',
  primaryEmail: 'student@example.org',
  orgUnitPath: '/Students/Grade 7',
  givenName: 'Robin',
  familyName: 'Avery',
  fullName: 'Robin Avery',
  suspended: false,
  suspensionReason: null,
  archived: false,
  lastLoginTime: at,
  creationTime: at,
  twoStepEnrolled: true,
  department: null,
  title: null,
  aliases: ['robina@example.org'],
  customSchemas,
  lastEntitySync: at,
};

test('the C1 builder gives the column ID, the filter key, and the draft key', () => {
  const keys = userAttributeKeys('StudentInfo', 'Homeroom');
  assert.deepEqual(keys, {
    columnId: 'attr:StudentInfo.Homeroom',
    filterKey: 'attr:StudentInfo.Homeroom',
    draftKey: 'attr:StudentInfo.Homeroom',
  });
  assert.ok(userAttributeKeySchema.safeParse(keys.columnId).success);
  assert.ok(userAttributeKeySchema.safeParse(keys.draftKey).success);
  // The design supersedes the `attribute:` field ID of document A section 9 (C1).
  assert.equal(userAttributeKeySchema.safeParse('attribute:StudentInfo.Homeroom').success, false);
  // A name with a dot would make the ID ambiguous, and Google allows letters, digits, _ and - only.
  for (const [schemaName, fieldName] of [
    ['Student.Info', 'Homeroom'],
    ['StudentInfo', 'Home room'],
    ['', 'Homeroom'],
    ['StudentInfo', ''],
  ])
    assert.throws(() => userAttributeKeys(schemaName, fieldName));
});

test('a user record carries the raw custom schemas and the last Google read', () => {
  assert.deepEqual(userRecordSchema.parse(record), record);
  assert.equal(userRecordSchema.safeParse({ ...record, stale: false }).success, false);
  assert.equal(userRecordSchema.safeParse({ ...record, removedAt: null }).success, false);
  assert.equal(userRecordSchema.safeParse({ ...record, customSchemas: [] }).success, false);
  assert.equal(userRecordSchema.safeParse({ ...record, primaryEmail: 'not-an-email' }).success, false);
  assert.equal(userRecordSchema.safeParse({ ...record, orgUnitPath: 'Students' }).success, false);
  // A raw value stays exactly as Google answered it.
  const raw = {
    ...customSchemas,
    StudentInfo: { ...customSchemas.StudentInfo, Notes: null },
  };
  assert.deepEqual(
    userRecordSchema.parse({ ...record, customSchemas: raw }).customSchemas,
    raw,
  );
});

test('a user row and the user details add stale, the removal time, and the record version', () => {
  const row = { ...record, stale: true, recordVersion: 4 };
  assert.deepEqual(userRowSchema.parse(row), row);
  assert.equal(userRowSchema.safeParse({ ...record, stale: true }).success, false);
  assert.equal(
    userRowSchema.safeParse({ ...record, stale: true, recordVersion: 0 }).success,
    false,
  );
  const detail = { ...record, stale: false, removedAt: at, recordVersion: 7 };
  assert.deepEqual(userDetailSchema.parse(detail), detail);
  assert.equal(
    userDetailSchema.safeParse({ ...record, stale: false, recordVersion: 7 }).success,
    false,
  );
});

test('a query holds at most 20 predicates, 1,000 rows, and the Name sort by default', () => {
  const query = userQuerySchema.parse({});
  assert.deepEqual(query.predicates, []);
  assert.deepEqual(query.sort, { field: 'fullName', direction: 'asc' });
  assert.equal(query.offset, 0);
  assert.equal(query.limit, 100);
  assert.equal(query.selection, null);
  assert.equal(userQuerySchema.safeParse({ limit: 1001 }).success, false);
  assert.equal(userQuerySchema.safeParse({ limit: 0 }).success, false);
  assert.equal(
    userQuerySchema.safeParse({ predicates: Array.from({ length: 21 }, () => ({ field: 'fullName', operator: 'equals', value: 'x' })) })
      .success,
    false,
  );
  assert.equal(userQuerySchema.safeParse({ sort: { field: 'password', direction: 'asc' } }).success, false);
  assert.deepEqual(
    userQuerySchema.parse({
      sort: { field: 'lastLoginTime', direction: 'desc' },
      selection: { gridId: 'users', tabId: '7f5f3b2e-2d4e-4f7a-9b1a-1c2d3e4f5a6b' },
    }).selection.gridId,
    'users',
  );
});

test('each filter field offers its own operators', () => {
  for (const predicate of [
    { field: 'fullName', operator: 'contains', value: 'Robin' },
    { field: 'primaryEmail', operator: 'startsWith', value: 'student' },
    { field: 'department', operator: 'equals', value: 'Science' },
    { field: 'title', operator: 'isEmpty' },
    { field: 'fullName', operator: 'isEmpty' },
    { field: 'aliases', operator: 'contains', value: 'robina' },
    { field: 'aliases', operator: 'isEmpty' },
    { field: 'orgUnitPath', operator: 'in', values: ['/Students'] },
    { field: 'status', operator: 'is', values: ['active', 'archived'] },
    { field: 'twoStep', operator: 'is', values: ['not-enrolled'] },
    { field: 'lastLoginTime', operator: 'before', value: at },
    { field: 'creationTime', operator: 'after', value: at },
  ])
    assert.ok(userPredicateSchema.safeParse(predicate).success, JSON.stringify(predicate));
  for (const predicate of [
    { field: 'aliases', operator: 'startsWith', value: 'x' },
    { field: 'status', operator: 'is', values: ['disabled'] },
    { field: 'twoStep', operator: 'is', values: ['yes'] },
    { field: 'lastLoginTime', operator: 'is', value: at },
    { field: 'orgUnitPath', operator: 'in', values: ['Students'] },
    { field: 'fullName', operator: 'contains', value: '' },
  ])
    assert.equal(userPredicateSchema.safeParse(predicate).success, false, JSON.stringify(predicate));
});

test('an attribute predicate names the category, the attribute, and its info type operator', () => {
  for (const predicate of [
    { field: 'attribute', schemaName: 'StudentInfo', fieldName: 'Homeroom', operator: 'contains', value: 'B12' },
    { field: 'attribute', schemaName: 'StudentInfo', fieldName: 'GradeLevel', operator: 'numberRange', from: 0, to: 12 },
    { field: 'attribute', schemaName: 'StudentInfo', fieldName: 'Enrolled', operator: 'dateRange', from: '2026-01-01', to: '2026-06-30' },
    { field: 'attribute', schemaName: 'StudentInfo', fieldName: 'Graduating', operator: 'is', value: false },
    { field: 'attribute', schemaName: 'StudentInfo', fieldName: 'Programs', operator: 'hasValue' },
  ])
    assert.ok(userPredicateSchema.safeParse(predicate).success, JSON.stringify(predicate));
  for (const predicate of [
    { field: 'attribute', fieldName: 'Homeroom', operator: 'contains', value: 'B12' },
    { field: 'attribute', schemaName: 'StudentInfo', fieldName: 'Homeroom', operator: 'hasValue', value: 'B12' },
    { field: 'attribute', schemaName: 'StudentInfo', fieldName: 'GradeLevel', operator: 'numberRange', from: 12, to: 0 },
    { field: 'attribute', schemaName: 'StudentInfo', fieldName: 'Enrolled', operator: 'dateRange', from: '2026-06-30', to: '2026-01-01' },
  ])
    assert.equal(userPredicateSchema.safeParse(predicate).success, false, JSON.stringify(predicate));
});

test('a user page carries the rows, the counts, and the refresh it started', () => {
  const page = {
    rows: [{ ...record, stale: false, recordVersion: 1 }],
    matching: 1,
    total: 12,
    observedAt: at,
    refreshJobId: '7f5f3b2e-2d4e-4f7a-9b1a-1c2d3e4f5a6b',
  };
  assert.deepEqual(userPageSchema.parse(page), page);
  assert.equal(userPageSchema.safeParse({ ...page, refreshJobId: null }).success, true);
  assert.equal(userPageSchema.safeParse({ ...page, rows: [{ ...record }] }).success, false);
});

test('the by-ids and freshness reads copy the device limits', () => {
  assert.equal(USER_BY_IDS_LIMIT, 500);
  assert.equal(
    userByIdsSchema.safeParse({ userIds: Array.from({ length: USER_BY_IDS_LIMIT }, (_, index) => `id-${index}`) }).success,
    true,
  );
  assert.equal(
    userByIdsSchema.safeParse({ userIds: Array.from({ length: USER_BY_IDS_LIMIT + 1 }, (_, index) => `id-${index}`) }).success,
    false,
  );
  assert.deepEqual(userFreshnessSchema.parse({ stale: 3, refreshing: true }), {
    stale: 3,
    refreshing: true,
  });
});

test('the user sync state carries the count, the failure, and no telemetry', () => {
  const sync = {
    customerId,
    generation: 2,
    status: 'ready',
    observedAt: at,
    userCount: 4,
    failure: null,
    startedAt: at,
    checkedAt: at,
    stale: false,
  };
  assert.deepEqual(userSyncStateSchema.parse(sync), sync);
  assert.equal(userSyncStateSchema.safeParse({ ...sync, failure: 'quota' }).success, true);
  assert.equal(userSyncStateSchema.safeParse({ ...sync, status: 'done' }).success, false);
  assert.equal(userSyncStateSchema.safeParse({ ...sync, telemetryFailure: null }).success, false);
});

test('the selection keeps the device form under the users grid', () => {
  const key = { gridId: 'users', tabId: '7f5f3b2e-2d4e-4f7a-9b1a-1c2d3e4f5a6b' };
  assert.deepEqual(userSelectionKeySchema.parse(key), key);
  assert.equal(userSelectionKeySchema.safeParse({ ...key, gridId: 'devices' }).success, false);
  for (const op of [
    { op: 'selectAll', predicates: [{ field: 'status', operator: 'is', values: ['active'] }] },
    { op: 'deselectAll' },
    { op: 'select', ids: ['107000000000000000001'] },
    { op: 'deselect', ids: ['107000000000000000001'] },
  ])
    assert.ok(userSelectionChangeSchema.safeParse({ ...key, ops: [op] }).success, JSON.stringify(op));
  assert.equal(
    userSelectionChangeSchema.safeParse({ ...key, ops: [{ op: 'select', ids: [] }] }).success,
    false,
  );
  const spec = {
    terms: [{ type: 'all', predicates: [] }],
    added: 2,
    excluded: 1,
    selectedCount: 9,
    expiredAt: null,
  };
  assert.deepEqual(userSelectionSpecSchema.parse(spec), spec);
  assert.deepEqual(userSelectionRefreshSchema.parse({ jobId: null, selected: 4 }), {
    jobId: null,
    selected: 4,
  });
});

test('Refresh Domain answers its sync and its domain read apart', () => {
  const sync = {
    customerId,
    generation: 1,
    status: 'ready',
    observedAt: at,
    userCount: 0,
    failure: null,
    startedAt: null,
    checkedAt: at,
    stale: false,
  };
  const refreshed = { sync, domain: { status: 'refreshed', reason: null } };
  assert.deepEqual(userDomainRefreshSchema.parse(refreshed), refreshed);
  assert.equal(
    userDomainRefreshSchema.safeParse({ sync, domain: { status: 'failed', reason: 'quota' } }).success,
    true,
  );
  // A refreshed check carries no reason, and a failed check names one.
  assert.equal(
    userDomainRefreshSchema.safeParse({ sync, domain: { status: 'refreshed', reason: 'quota' } }).success,
    false,
  );
  assert.equal(
    userDomainRefreshSchema.safeParse({ sync, domain: { status: 'failed', reason: null } }).success,
    false,
  );
});

test('the OrgUnit read lists the path and the user count', () => {
  const units = [
    { path: '/Students', users: 12 },
    { path: '/Staff', users: 3 },
  ];
  assert.deepEqual(userOrgUnitsSchema.parse(units), units);
  assert.equal(userOrgUnitsSchema.safeParse([{ path: 'Students', users: 12 }]).success, false);
});

test('an attribute field carries the Google schema metadata and its holder count', () => {
  const field = {
    fieldId: '00f1',
    fieldName: 'GradeLevel',
    displayName: 'Grade level',
    fieldType: 'INT64',
    multiValued: false,
    indexed: true,
    readAccessType: 'ALL_DOMAIN_USERS',
    numericIndexingSpec: { minValue: 0, maxValue: 12 },
    holders: 1188,
  };
  assert.deepEqual(userAttributeFieldSchema.parse(field), field);
  assert.equal(
    userAttributeFieldSchema.safeParse({ ...field, numericIndexingSpec: null }).success,
    true,
  );
  assert.equal(
    userAttributeFieldSchema.safeParse({ ...field, numericIndexingSpec: { minValue: 0, maxValue: null } }).success,
    true,
  );
  assert.equal(userAttributeFieldSchema.safeParse({ ...field, fieldType: 'NUMBER' }).success, false);
  assert.equal(userAttributeFieldSchema.safeParse({ ...field, holders: -1 }).success, false);
  assert.equal(
    userAttributeFieldSchema.safeParse({ ...field, multiValued: 'no' }).success,
    false,
  );
});

test('a category carries its fields, its holder count, and the read time', () => {
  const category = {
    schemaId: 'schem-1',
    schemaName: 'StudentInfo',
    displayName: 'Student information',
    etag: '"abc123"',
    fields: [
      {
        fieldId: '00f1',
        fieldName: 'Homeroom',
        displayName: 'Homeroom',
        fieldType: 'STRING',
        multiValued: false,
        indexed: true,
        readAccessType: 'ADMINS_AND_SELF',
        numericIndexingSpec: null,
        holders: 1188,
      },
    ],
    holders: 1188,
    readAt: at,
  };
  assert.deepEqual(userAttributeCategorySchema.parse(category), category);
  assert.equal(userAttributeCategorySchema.safeParse({ ...category, fields: [] }).success, false);
  assert.equal(userAttributeCategorySchema.safeParse({ ...category, readAt: null }).success, true);
});

test('the category read carries the limit counts of the Google account', () => {
  assert.equal(USER_ATTRIBUTE_CATEGORY_LIMIT, 100);
  assert.equal(USER_ATTRIBUTE_FIELD_LIMIT, 100);
  const field = {
    fieldId: '00f1',
    fieldName: 'Homeroom',
    displayName: 'Homeroom',
    fieldType: 'STRING',
    multiValued: false,
    indexed: true,
    readAccessType: 'ADMINS_AND_SELF',
    numericIndexingSpec: null,
    holders: 2,
  };
  const category = {
    schemaId: 'schem-1',
    schemaName: 'StudentInfo',
    displayName: 'Student information',
    etag: '"abc123"',
    fields: [field],
    holders: 2,
    readAt: at,
  };
  const answer = {
    categories: [category],
    limits: {
      categories: 1,
      categoryLimit: USER_ATTRIBUTE_CATEGORY_LIMIT,
      attributes: 1,
      attributeLimit: USER_ATTRIBUTE_FIELD_LIMIT,
    },
    observedAt: at,
  };
  assert.deepEqual(userAttributeCategoriesSchema.parse(answer), answer);
  assert.equal(
    userAttributeCategoriesSchema.safeParse({
      ...answer,
      categories: Array.from({ length: USER_ATTRIBUTE_CATEGORY_LIMIT + 1 }, () => category),
    }).success,
    false,
  );
  assert.equal(userAttributeCategoriesSchema.safeParse({ ...answer, observedAt: null }).success, true);
  assert.equal(
    userAttributeCategoriesSchema.safeParse({ ...answer, limits: { categories: 1 } }).success,
    false,
  );
});