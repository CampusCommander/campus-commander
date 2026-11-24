import assert from 'node:assert/strict';
import test from 'node:test';
import {
  USER_ATTRIBUTE_CATEGORY_LIMIT,
  USER_ATTRIBUTE_EDITS_LIMIT,
  USER_ATTRIBUTE_FIELD_LIMIT,
  USER_ATTRIBUTE_VALUES_LIMIT,
  USER_BY_IDS_LIMIT,
  userAttributeCategoriesSchema,
  userAttributeCategoryCreateDraftSchema,
  userAttributeCategoryJobReceiptSchema,
  userAttributeCategoryPlanChangeSchema,
  userAttributeCategoryPlanConfirmRequestSchema,
  userAttributeCategoryPlanRequestSchema,
  userAttributeCategoryPlanSchema,
  userAttributeCategorySchema,
  userAttributeChangeSchema,
  userAttributeChangesSchema,
  userAttributeChangeModeSchema,
  userAttributeEditPreviewRequestSchema,
  userAttributeEditSchema,
  userAttributeEditsSchema,
  userAttributeFieldSchema,
  userAttributeKey,
  userAttributeKeySchema,
  userAttributeOperatorSchema,
  userAttributePreviewConfirmRequestSchema,
  userAttributePreviewRequestSchema,
  userAttributePreviewSchema,
  userAttributeJobReceiptSchema,
  userAttributeTargetSchema,
  userAttributeTargetsPageSchema,
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
  userCustomSchemasSchema,
  userSelectionChangeSchema,
  userSelectionKeySchema,
  userSelectionRefreshSchema,
  userSelectionResolveSchema,
  userSelectionSpecSchema,
  userStreamEventSchema,
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
  const id = userAttributeKey('StudentInfo', 'Homeroom');
  // One ID serves the grid column, the filter chip and predicate, and the draft key.
  assert.equal(id, 'attr:StudentInfo.Homeroom');
  assert.ok(userAttributeKeySchema.safeParse(id).success);
  // The design supersedes the `attribute:` field ID of document A section 9 (C1).
  assert.equal(
    userAttributeKeySchema.safeParse('attribute:StudentInfo.Homeroom').success,
    false,
  );
  // A name with a dot would make the ID ambiguous, and Google allows letters, digits, _ and - only.
  for (const [schemaName, fieldName] of [
    ['Student.Info', 'Homeroom'],
    ['StudentInfo', 'Home room'],
    ['', 'Homeroom'],
    ['StudentInfo', ''],
  ])
    assert.throws(() => userAttributeKey(schemaName, fieldName));
});

test('a user record carries the raw custom schemas and the last Google read', () => {
  assert.deepEqual(userRecordSchema.parse(record), record);
  assert.equal(
    userRecordSchema.safeParse({ ...record, stale: false }).success,
    false,
  );
  assert.equal(
    userRecordSchema.safeParse({ ...record, removedAt: null }).success,
    false,
  );
  assert.equal(
    userRecordSchema.safeParse({ ...record, customSchemas: [] }).success,
    false,
  );
  assert.equal(
    userRecordSchema.safeParse({ ...record, primaryEmail: 'not-an-email' })
      .success,
    false,
  );
  assert.equal(
    userRecordSchema.safeParse({ ...record, orgUnitPath: 'Students' }).success,
    false,
  );
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

test('the raw custom schemas keep a legal own __proto__ category and field', () => {
  const raw = JSON.parse(
    '{"__proto__":{"__proto__":"alpha","Grade":7},"StudentInfo":{"Grade":8}}',
  );
  const parsed = userCustomSchemasSchema.parse(raw);
  assert.deepEqual(parsed, raw);
  assert.deepEqual(Object.keys(parsed).sort(), ['StudentInfo', '__proto__']);
  const reserved = parsed['__proto__'];
  assert.deepEqual(Object.keys(reserved).sort(), ['Grade', '__proto__']);
  assert.equal(reserved['__proto__'], 'alpha');
  // The reserved key stays an own property and no prototype changes.
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.getPrototypeOf(reserved), Object.prototype);
  assert.equal(Object.getPrototypeOf(raw), Object.prototype);
  assert.equal(
    userCustomSchemasSchema.safeParse({ StudentInfo: { Grade: undefined } })
      .success,
    false,
  );
});

test('a user row and the user details add stale, the removal time, and the record version', () => {
  const row = { ...record, stale: true, recordVersion: 4 };
  assert.deepEqual(userRowSchema.parse(row), row);
  assert.equal(
    userRowSchema.safeParse({ ...record, stale: true }).success,
    false,
  );
  assert.equal(
    userRowSchema.safeParse({ ...record, stale: true, recordVersion: 0 })
      .success,
    false,
  );
  const detail = { ...record, stale: false, removedAt: at, recordVersion: 7 };
  assert.deepEqual(userDetailSchema.parse(detail), detail);
  assert.equal(
    userDetailSchema.safeParse({ ...record, stale: false, recordVersion: 7 })
      .success,
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
    userQuerySchema.safeParse({
      predicates: Array.from({ length: 21 }, () => ({
        field: 'fullName',
        operator: 'equals',
        value: 'x',
      })),
    }).success,
    false,
  );
  assert.equal(
    userQuerySchema.safeParse({ sort: { field: 'password', direction: 'asc' } })
      .success,
    false,
  );
  assert.deepEqual(
    userQuerySchema.parse({
      sort: { field: 'lastLoginTime', direction: 'desc' },
      selection: {
        gridId: 'users',
        tabId: '7f5f3b2e-2d4e-4f7a-9b1a-1c2d3e4f5a6b',
      },
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
    assert.ok(
      userPredicateSchema.safeParse(predicate).success,
      JSON.stringify(predicate),
    );
  for (const predicate of [
    { field: 'aliases', operator: 'startsWith', value: 'x' },
    { field: 'status', operator: 'is', values: ['disabled'] },
    { field: 'twoStep', operator: 'is', values: ['yes'] },
    { field: 'lastLoginTime', operator: 'is', value: at },
    { field: 'orgUnitPath', operator: 'in', values: ['Students'] },
    { field: 'fullName', operator: 'contains', value: '' },
  ])
    assert.equal(
      userPredicateSchema.safeParse(predicate).success,
      false,
      JSON.stringify(predicate),
    );
});

test('an attribute predicate names the category, the attribute, and its info type operator', () => {
  for (const predicate of [
    {
      field: 'attribute',
      schemaName: 'StudentInfo',
      fieldName: 'Homeroom',
      operator: 'contains',
      value: 'B12',
    },
    {
      field: 'attribute',
      schemaName: 'StudentInfo',
      fieldName: 'GradeLevel',
      operator: 'numberRange',
      from: 0,
      to: 12,
    },
    {
      field: 'attribute',
      schemaName: 'StudentInfo',
      fieldName: 'Enrolled',
      operator: 'dateRange',
      from: '2026-01-01',
      to: '2026-06-30',
    },
    {
      field: 'attribute',
      schemaName: 'StudentInfo',
      fieldName: 'Graduating',
      operator: 'is',
      value: false,
    },
    {
      field: 'attribute',
      schemaName: 'StudentInfo',
      fieldName: 'Programs',
      operator: 'hasValue',
    },
  ])
    assert.ok(
      userPredicateSchema.safeParse(predicate).success,
      JSON.stringify(predicate),
    );
  for (const predicate of [
    {
      field: 'attribute',
      fieldName: 'Homeroom',
      operator: 'contains',
      value: 'B12',
    },
    {
      field: 'attribute',
      schemaName: 'StudentInfo',
      fieldName: 'Homeroom',
      operator: 'hasValue',
      value: 'B12',
    },
    {
      field: 'attribute',
      schemaName: 'StudentInfo',
      fieldName: 'GradeLevel',
      operator: 'numberRange',
      from: 12,
      to: 0,
    },
    {
      field: 'attribute',
      schemaName: 'StudentInfo',
      fieldName: 'Enrolled',
      operator: 'dateRange',
      from: '2026-06-30',
      to: '2026-01-01',
    },
  ])
    assert.equal(
      userPredicateSchema.safeParse(predicate).success,
      false,
      JSON.stringify(predicate),
    );
});

test('each attribute operator names one info type and refuses another', () => {
  const operators = ['contains', 'numberRange', 'dateRange', 'is', 'hasValue'];
  assert.deepEqual(userAttributeOperatorSchema.options, operators);
  for (const operator of operators)
    assert.equal(
      userAttributeOperatorSchema.parse(operator),
      operator,
      operator,
    );
  for (const operator of ['startsWith', 'equals', 'isEmpty', ''])
    assert.equal(
      userAttributeOperatorSchema.safeParse(operator).success,
      false,
      operator,
    );
  assert.equal(userAttributeOperatorSchema.safeParse(null).success, false);
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
  assert.equal(
    userPageSchema.safeParse({ ...page, refreshJobId: null }).success,
    true,
  );
  assert.equal(
    userPageSchema.safeParse({ ...page, rows: [{ ...record }] }).success,
    false,
  );
});

test('the by-ids and freshness reads copy the device limits', () => {
  assert.equal(USER_BY_IDS_LIMIT, 500);
  assert.equal(
    userByIdsSchema.safeParse({
      userIds: Array.from(
        { length: USER_BY_IDS_LIMIT },
        (_, index) => `id-${index}`,
      ),
    }).success,
    true,
  );
  assert.equal(
    userByIdsSchema.safeParse({
      userIds: Array.from(
        { length: USER_BY_IDS_LIMIT + 1 },
        (_, index) => `id-${index}`,
      ),
    }).success,
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
  assert.equal(
    userSyncStateSchema.safeParse({ ...sync, failure: 'quota' }).success,
    true,
  );
  assert.equal(
    userSyncStateSchema.safeParse({ ...sync, status: 'done' }).success,
    false,
  );
  assert.equal(
    userSyncStateSchema.safeParse({ ...sync, telemetryFailure: null }).success,
    false,
  );
});

test('every users feed event names the user entity type', () => {
  const sync = {
    customerId,
    generation: 2,
    status: 'ready',
    observedAt: at,
    userCount: 4,
    failure: 'quota',
    startedAt: at,
    checkedAt: at,
    stale: false,
  };
  assert.deepEqual(
    userStreamEventSchema.parse({
      type: 'entity-batch',
      entityType: 'user',
      userIds: ['107000000000000000001'],
      removedIds: [],
    }),
    {
      type: 'entity-batch',
      entityType: 'user',
      userIds: ['107000000000000000001'],
      removedIds: [],
    },
  );
  assert.deepEqual(
    userStreamEventSchema.parse({
      type: 'job-finished',
      entityType: 'user',
      failure: 'quota',
    }),
    { type: 'job-finished', entityType: 'user', failure: 'quota' },
  );
  assert.deepEqual(
    userStreamEventSchema.parse({
      type: 'user-full-sync',
      entityType: 'user',
      sync,
    }),
    { type: 'user-full-sync', entityType: 'user', sync },
  );
  // A device event and an event without the entity type are refused.
  assert.equal(
    userStreamEventSchema.safeParse({
      type: 'entity-batch',
      entityType: 'device',
      userIds: [],
      removedIds: [],
    }).success,
    false,
  );
  assert.equal(
    userStreamEventSchema.safeParse({ type: 'job-finished', failure: null })
      .success,
    false,
  );
  assert.equal(
    userStreamEventSchema.safeParse({
      type: 'full-sync',
      sync,
    }).success,
    false,
  );
  // The feed drops a job ID and the batch counters.
  assert.equal(
    userStreamEventSchema.safeParse({
      type: 'entity-batch',
      entityType: 'user',
      jobId: '33333333-3333-4333-8333-333333333333',
      userIds: [],
      removedIds: [],
    }).success,
    false,
  );
});

test('the selection keeps the device form under the users grid', () => {
  const key = {
    gridId: 'users',
    tabId: '7f5f3b2e-2d4e-4f7a-9b1a-1c2d3e4f5a6b',
  };
  assert.deepEqual(userSelectionKeySchema.parse(key), key);
  assert.equal(
    userSelectionKeySchema.safeParse({ ...key, gridId: 'devices' }).success,
    false,
  );
  for (const op of [
    {
      op: 'selectAll',
      predicates: [{ field: 'status', operator: 'is', values: ['active'] }],
    },
    { op: 'deselectAll' },
    { op: 'select', ids: ['107000000000000000001'] },
    { op: 'deselect', ids: ['107000000000000000001'] },
  ])
    assert.ok(
      userSelectionChangeSchema.safeParse({ ...key, ops: [op] }).success,
      JSON.stringify(op),
    );
  assert.equal(
    userSelectionChangeSchema.safeParse({
      ...key,
      ops: [{ op: 'select', ids: [] }],
    }).success,
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
  assert.deepEqual(
    userSelectionRefreshSchema.parse({ jobId: null, selected: 4 }),
    {
      jobId: null,
      selected: 4,
    },
  );
});

test('a selection resolve names the Users grid, defaults its predicates, and bounds its row IDs', () => {
  const tabId = '7f5f3b2e-2d4e-4f7a-9b1a-1c2d3e4f5a6b';
  const request = {
    gridId: 'users',
    tabId,
    rowIds: ['107000000000000000001', '107000000000000000002'],
  };
  assert.deepEqual(userSelectionResolveSchema.parse(request), {
    ...request,
    predicates: [],
  });
  const filtered = {
    ...request,
    predicates: [{ field: 'status', operator: 'is', values: ['active'] }],
  };
  assert.deepEqual(userSelectionResolveSchema.parse(filtered), filtered);
  // A Select All answers at most 2,000 row IDs in one resolve.
  assert.equal(
    userSelectionResolveSchema.safeParse({
      ...request,
      rowIds: Array.from({ length: 2000 }, (_, index) => `id-${index}`),
    }).success,
    true,
  );
  for (const invalid of [
    { ...request, gridId: 'devices' },
    { ...request, tabId: 'not-a-uuid' },
    { ...request, rowIds: undefined },
    {
      ...request,
      rowIds: Array.from({ length: 2001 }, () => '107000000000000000001'),
    },
    {
      ...request,
      predicates: Array.from({ length: 21 }, () => ({
        field: 'fullName',
        operator: 'equals',
        value: 'x',
      })),
    },
    {
      ...request,
      predicates: [{ field: 'password', operator: 'equals', value: 'x' }],
    },
  ])
    assert.equal(
      userSelectionResolveSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
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
    userDomainRefreshSchema.safeParse({
      sync,
      domain: { status: 'failed', reason: 'quota' },
    }).success,
    true,
  );
  // A refreshed check carries no reason, and a failed check names one.
  assert.equal(
    userDomainRefreshSchema.safeParse({
      sync,
      domain: { status: 'refreshed', reason: 'quota' },
    }).success,
    false,
  );
  assert.equal(
    userDomainRefreshSchema.safeParse({
      sync,
      domain: { status: 'failed', reason: null },
    }).success,
    false,
  );
});

test('the OrgUnit read lists the path and the user count', () => {
  const units = [
    { path: '/Students', users: 12 },
    { path: '/Staff', users: 3 },
  ];
  assert.deepEqual(userOrgUnitsSchema.parse(units), units);
  assert.equal(
    userOrgUnitsSchema.safeParse([{ path: 'Students', users: 12 }]).success,
    false,
  );
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
    userAttributeFieldSchema.safeParse({ ...field, numericIndexingSpec: null })
      .success,
    true,
  );
  assert.equal(
    userAttributeFieldSchema.safeParse({
      ...field,
      numericIndexingSpec: { minValue: 0, maxValue: null },
    }).success,
    true,
  );
  assert.equal(
    userAttributeFieldSchema.safeParse({ ...field, fieldType: 'NUMBER' })
      .success,
    false,
  );
  assert.equal(
    userAttributeFieldSchema.safeParse({ ...field, holders: -1 }).success,
    false,
  );
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
  assert.equal(
    userAttributeCategorySchema.safeParse({ ...category, fields: [] }).success,
    false,
  );
  assert.equal(
    userAttributeCategorySchema.safeParse({ ...category, readAt: null })
      .success,
    true,
  );
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
      categories: Array.from(
        { length: USER_ATTRIBUTE_CATEGORY_LIMIT + 1 },
        () => category,
      ),
    }).success,
    false,
  );
  assert.equal(
    userAttributeCategoriesSchema.safeParse({ ...answer, observedAt: null })
      .success,
    true,
  );
  assert.equal(
    userAttributeCategoriesSchema.safeParse({
      ...answer,
      limits: { categories: 1 },
    }).success,
    false,
  );
});

const planId = '00000000-0000-4000-8000-000000000001';
const planDigest = 'a'.repeat(64);
const planExpiry = '2026-11-16T12:15:00.000Z';
const planLimits = {
  categories: 3,
  categoryLimit: USER_ATTRIBUTE_CATEGORY_LIMIT,
  attributes: 10,
  attributeLimit: USER_ATTRIBUTE_FIELD_LIMIT,
};
/** A cached attribute and a new one, as the category editor sends them (B section 6.1). */
const keptAttribute = {
  fieldId: '00f1',
  fieldName: 'Homeroom',
  displayName: 'Homeroom',
  fieldType: 'STRING',
  multiValued: false,
  indexed: true,
  readAccessType: 'ADMINS_AND_SELF',
  numericIndexingSpec: null,
};
const newAttribute = {
  fieldId: null,
  fieldName: 'GradeLevel',
  displayName: 'Grade level',
  fieldType: 'INT64',
  multiValued: false,
  indexed: true,
  readAccessType: 'ALL_DOMAIN_USERS',
  numericIndexingSpec: { minValue: 0, maxValue: 12 },
};
/** The `schemaId` of check L2 holds characters outside `[A-Za-z0-9_-]` and stays opaque (C8). */
const opaqueSchemaId = 'schem=Id/1';

test('a category plan request names its kind, the cached category, and the draft', () => {
  const create = {
    kind: 'create-category',
    draft: {
      schemaName: 'StudentInfo',
      displayName: 'Student information',
      fields: [newAttribute],
    },
  };
  assert.deepEqual(
    userAttributeCategoryPlanRequestSchema.parse(create),
    create,
  );
  const edit = {
    kind: 'edit-category',
    schemaId: opaqueSchemaId,
    baseEtag: '"abc123"',
    draft: {
      displayName: 'Student information',
      fields: [keptAttribute, newAttribute],
    },
  };
  assert.deepEqual(userAttributeCategoryPlanRequestSchema.parse(edit), edit);
  const remove = {
    kind: 'delete-category',
    schemaId: opaqueSchemaId,
    baseEtag: '"abc123"',
  };
  assert.deepEqual(
    userAttributeCategoryPlanRequestSchema.parse(remove),
    remove,
  );
  // A create names no cached category; an edit and a delete name one and its etag.
  assert.equal(
    userAttributeCategoryPlanRequestSchema.safeParse({
      ...create,
      schemaId: opaqueSchemaId,
    }).success,
    false,
  );
  assert.equal(
    userAttributeCategoryPlanRequestSchema.safeParse({
      kind: 'edit-category',
      schemaId: opaqueSchemaId,
      draft: edit.draft,
    }).success,
    false,
  );
  assert.equal(
    userAttributeCategoryPlanRequestSchema.safeParse({
      ...remove,
      draft: edit.draft,
    }).success,
    false,
  );
  // A new category holds at least one attribute, and none of them carries a field ID.
  assert.equal(
    userAttributeCategoryCreateDraftSchema.safeParse({
      ...create.draft,
      fields: [],
    }).success,
    false,
  );
  assert.equal(
    userAttributeCategoryCreateDraftSchema.safeParse({
      ...create.draft,
      fields: [keptAttribute],
    }).success,
    false,
  );
  // K19: only a whole-number or a decimal attribute carries a number range.
  assert.equal(
    userAttributeCategoryCreateDraftSchema.safeParse({
      ...create.draft,
      fields: [{ ...newAttribute, fieldType: 'STRING' }],
    }).success,
    false,
  );
  assert.equal(
    userAttributeCategoryCreateDraftSchema.safeParse({
      ...create.draft,
      fields: [{ ...newAttribute, fieldType: 'DOUBLE' }],
    }).success,
    true,
  );
});

test('a category plan change names the attribute and what moved', () => {
  const added = {
    change: 'added',
    fieldId: null,
    fieldName: 'GradeLevel',
    displayName: 'Grade level',
    properties: [],
    holders: null,
  };
  assert.deepEqual(userAttributeCategoryPlanChangeSchema.parse(added), added);
  const changed = {
    change: 'changed',
    fieldId: '00f1',
    fieldName: 'Homeroom',
    displayName: 'Homeroom',
    properties: ['displayName', 'readAccessType'],
    holders: null,
  };
  assert.deepEqual(
    userAttributeCategoryPlanChangeSchema.parse(changed),
    changed,
  );
  const removed = {
    change: 'removed',
    fieldId: '00f2',
    fieldName: 'Nickname',
    displayName: 'Nickname',
    properties: [],
    holders: 1988,
  };
  assert.deepEqual(
    userAttributeCategoryPlanChangeSchema.parse(removed),
    removed,
  );
  // A removed attribute alone carries its holder count.
  assert.equal(
    userAttributeCategoryPlanChangeSchema.safeParse({
      ...removed,
      holders: null,
    }).success,
    false,
  );
  assert.equal(
    userAttributeCategoryPlanChangeSchema.safeParse({
      ...changed,
      holders: 3,
    }).success,
    false,
  );
  // A changed attribute names at least one property; an added one names none.
  assert.equal(
    userAttributeCategoryPlanChangeSchema.safeParse({
      ...changed,
      properties: [],
    }).success,
    false,
  );
  assert.equal(
    userAttributeCategoryPlanChangeSchema.safeParse({
      ...added,
      properties: ['displayName'],
    }).success,
    false,
  );
  // A changed attribute is cached, so it carries its ID.
  assert.equal(
    userAttributeCategoryPlanChangeSchema.safeParse({
      ...changed,
      fieldId: null,
    }).success,
    false,
  );
  assert.equal(
    userAttributeCategoryPlanChangeSchema.safeParse({
      ...added,
      fieldId: '00f3',
    }).success,
    false,
  );
});

test('a category plan answers its Google method, its changes, and its typed phrase', () => {
  const plan = {
    planId,
    kind: 'edit-category',
    method: 'update',
    schemaId: opaqueSchemaId,
    schemaName: 'StudentInfo',
    displayName: 'Student information',
    baseEtag: '"abc123"',
    changes: [
      {
        change: 'added',
        fieldId: null,
        fieldName: 'GradeLevel',
        displayName: 'Grade level',
        properties: [],
        holders: null,
      },
      {
        change: 'changed',
        fieldId: '00f1',
        fieldName: 'Homeroom',
        displayName: 'Homeroom',
        properties: ['displayName'],
        holders: null,
      },
      {
        change: 'removed',
        fieldId: '00f2',
        fieldName: 'Nickname',
        displayName: 'Nickname',
        properties: [],
        holders: 1988,
      },
    ],
    phrase: 'Nickname',
    limits: planLimits,
    preparedAt: at,
    expiresAt: planExpiry,
    digest: planDigest,
  };
  assert.deepEqual(userAttributeCategoryPlanSchema.parse(plan), plan);
  // The Google method follows the kind.
  assert.equal(
    userAttributeCategoryPlanSchema.safeParse({ ...plan, method: 'insert' })
      .success,
    false,
  );
  // A creation plan inserts, and a deletion plan deletes.
  const create = {
    ...plan,
    kind: 'create-category',
    method: 'insert',
    schemaId: null,
    baseEtag: null,
    changes: [plan.changes[0]],
    phrase: null,
  };
  assert.deepEqual(userAttributeCategoryPlanSchema.parse(create), create);
  const remove = {
    ...plan,
    kind: 'delete-category',
    method: 'delete',
    changes: [],
    phrase: 'Student information',
  };
  assert.deepEqual(userAttributeCategoryPlanSchema.parse(remove), remove);
  // A create carries no cached ID; an edit and a delete carry one.
  assert.equal(
    userAttributeCategoryPlanSchema.safeParse({
      ...create,
      schemaId: opaqueSchemaId,
    }).success,
    false,
  );
  assert.equal(
    userAttributeCategoryPlanSchema.safeParse({ ...plan, schemaId: null })
      .success,
    false,
  );
  assert.equal(
    userAttributeCategoryPlanSchema.safeParse({
      ...create,
      baseEtag: '"abc123"',
    }).success,
    false,
  );
  // A removal and a delete require the typed phrase, and another plan carries none.
  assert.equal(
    userAttributeCategoryPlanSchema.safeParse({ ...plan, phrase: null })
      .success,
    false,
  );
  assert.equal(
    userAttributeCategoryPlanSchema.safeParse({ ...create, phrase: 'Homeroom' })
      .success,
    false,
  );
  // A create adds attributes, a delete removes them, and neither carries another change.
  assert.equal(
    userAttributeCategoryPlanSchema.safeParse({
      ...create,
      changes: [plan.changes[2]],
      phrase: null,
    }).success,
    false,
  );
  assert.equal(
    userAttributeCategoryPlanSchema.safeParse({
      ...remove,
      changes: [plan.changes[0]],
    }).success,
    false,
  );
  // The digest is the 64-unit hexadecimal form of the device previews.
  assert.equal(
    userAttributeCategoryPlanSchema.safeParse({
      ...plan,
      digest: 'a'.repeat(63),
    }).success,
    false,
  );
  // A plan expires after it was prepared.
  assert.equal(
    userAttributeCategoryPlanSchema.safeParse({
      ...plan,
      expiresAt: plan.preparedAt,
    }).success,
    false,
  );
  assert.equal(
    userAttributeCategoryPlanSchema.safeParse({ ...plan, extra: true }).success,
    false,
  );
});

test('an edit plan labels a category without an attribute change', () => {
  const request = {
    kind: 'edit-category',
    schemaId: opaqueSchemaId,
    baseEtag: '"abc123"',
    draft: {
      displayName: 'Student information and programs',
      fields: [keptAttribute],
    },
  };
  assert.deepEqual(
    userAttributeCategoryPlanRequestSchema.parse(request),
    request,
  );
  const plan = {
    planId,
    kind: 'edit-category',
    method: 'update',
    schemaId: opaqueSchemaId,
    schemaName: 'StudentInfo',
    displayName: 'Student information and programs',
    baseEtag: '"abc123"',
    changes: [],
    phrase: null,
    limits: planLimits,
    preparedAt: at,
    expiresAt: planExpiry,
    digest: planDigest,
  };
  assert.deepEqual(userAttributeCategoryPlanSchema.parse(plan), plan);
  // A create still adds the attributes of its draft.
  assert.equal(
    userAttributeCategoryPlanSchema.safeParse({
      ...plan,
      kind: 'create-category',
      method: 'insert',
      schemaId: null,
      baseEtag: null,
    }).success,
    false,
  );
});

test('a category plan confirm carries the digest, the acknowledgment, and the typed phrase', () => {
  const confirm = { digest: planDigest, acknowledged: true };
  assert.deepEqual(
    userAttributeCategoryPlanConfirmRequestSchema.parse(confirm),
    confirm,
  );
  const withPhrase = { ...confirm, typedPhrase: 'Device program' };
  assert.deepEqual(
    userAttributeCategoryPlanConfirmRequestSchema.parse(withPhrase),
    withPhrase,
  );
  assert.equal(
    userAttributeCategoryPlanConfirmRequestSchema.safeParse({
      ...confirm,
      acknowledged: false,
    }).success,
    false,
  );
  assert.equal(
    userAttributeCategoryPlanConfirmRequestSchema.safeParse({
      acknowledged: true,
    }).success,
    false,
  );
  assert.equal(
    userAttributeCategoryPlanConfirmRequestSchema.safeParse({
      ...confirm,
      typedPhrase: '',
    }).success,
    false,
  );
});

test('a category job receipt names the CAT job and its change count', () => {
  const receipt = {
    jobId: planId,
    displayId: 'CAT-007',
    status: 'accepted',
    action: 'create-category',
    changeCount: 2,
  };
  assert.deepEqual(
    userAttributeCategoryJobReceiptSchema.parse(receipt),
    receipt,
  );
  assert.equal(
    userAttributeCategoryJobReceiptSchema.safeParse({
      ...receipt,
      status: 'queued',
    }).success,
    false,
  );
  assert.equal(
    userAttributeCategoryJobReceiptSchema.safeParse({
      ...receipt,
      changeCount: -1,
    }).success,
    false,
  );
  // A category receipt names a CAT job, not another job kind.
  assert.equal(
    userAttributeCategoryJobReceiptSchema.safeParse({
      ...receipt,
      displayId: 'UPD-007',
    }).success,
    false,
  );
});

// K22: the value preview and confirm contracts of document B section 10. Every fixture time is
// relative to the test clock, so the contract check never depends on the calendar day.
const previewAt = new Date(Date.now() - 60_000).toISOString();
const previewExpiry = new Date(Date.now() + 14 * 60_000).toISOString();

test('the five value modes carry their own values', () => {
  assert.deepEqual(userAttributeChangeModeSchema.options, [
    'set',
    'clear',
    'add',
    'remove',
    'replace',
  ]);
  for (const change of [
    {
      schemaName: 'StudentInfo',
      fieldName: 'Homeroom',
      mode: 'set',
      values: ['B12'],
    },
    {
      schemaName: 'StudentInfo',
      fieldName: 'Homeroom',
      mode: 'clear',
      values: [],
    },
    {
      schemaName: 'StudentInfo',
      fieldName: 'Programs',
      mode: 'add',
      values: ['ELL', 'Band'],
    },
    {
      schemaName: 'StudentInfo',
      fieldName: 'Programs',
      mode: 'remove',
      values: ['ELL'],
    },
    {
      schemaName: 'StudentInfo',
      fieldName: 'Programs',
      mode: 'replace',
      values: ['Robotics'],
    },
  ])
    assert.equal(
      userAttributeChangeSchema.safeParse(change).success,
      true,
      `${change.mode} parses`,
    );
  // A clear carries no value, and every other mode carries at least one. Set carries exactly one.
  for (const change of [
    {
      schemaName: 'StudentInfo',
      fieldName: 'Homeroom',
      mode: 'clear',
      values: ['B12'],
    },
    {
      schemaName: 'StudentInfo',
      fieldName: 'Homeroom',
      mode: 'add',
      values: [],
    },
    {
      schemaName: 'StudentInfo',
      fieldName: 'Homeroom',
      mode: 'set',
      values: [],
    },
    {
      schemaName: 'StudentInfo',
      fieldName: 'Homeroom',
      mode: 'set',
      values: ['B12', 'B13'],
    },
  ])
    assert.equal(
      userAttributeChangeSchema.safeParse(change).success,
      false,
      `${change.mode} refuses ${JSON.stringify(change.values)}`,
    );
  assert.equal(
    userAttributeChangeSchema.safeParse({
      schemaName: 'StudentInfo',
      fieldName: 'Homeroom',
      mode: 'append',
      values: ['B12'],
    }).success,
    false,
  );
  // An attribute name keeps the Google characters, and an unknown key never parses.
  for (const change of [
    {
      schemaName: 'Student Info',
      fieldName: 'Homeroom',
      mode: 'set',
      values: ['B12'],
    },
    {
      schemaName: 'StudentInfo',
      fieldName: 'Homeroom',
      mode: 'set',
      values: ['B12'],
      extra: 1,
    },
  ])
    assert.equal(userAttributeChangeSchema.safeParse(change).success, false);
});

test('one value keeps the text, number, and yes or no forms of the info types', () => {
  const change = (values) => ({
    schemaName: 'StudentInfo',
    fieldName: 'Programs',
    mode: 'replace',
    values,
  });
  // B section 8.1: text to 500 code points, a finite number, and true or false.
  assert.equal(
    userAttributeChangeSchema.safeParse(change(['x'.repeat(500)])).success,
    true,
  );
  assert.equal(userAttributeChangeSchema.safeParse(change([7])).success, true);
  assert.equal(
    userAttributeChangeSchema.safeParse(change([1.5])).success,
    true,
  );
  assert.equal(
    userAttributeChangeSchema.safeParse(change([true])).success,
    true,
  );
  assert.equal(
    userAttributeChangeSchema.safeParse(change(['2026-11-17'])).success,
    true,
  );
  assert.equal(
    userAttributeChangeSchema.safeParse(change(['sidney@example.org'])).success,
    true,
  );
  // The limit counts code points, so 500 astral characters pass and 501 fail.
  assert.equal(
    userAttributeChangeSchema.safeParse(change(['\u{1f600}'.repeat(500)]))
      .success,
    true,
  );
  assert.equal(
    userAttributeChangeSchema.safeParse(change(['x'.repeat(501)])).success,
    false,
  );
  assert.equal(
    userAttributeChangeSchema.safeParse(change([''])).success,
    false,
  );
  assert.equal(
    userAttributeChangeSchema.safeParse(change(['   '])).success,
    false,
  );
  assert.equal(
    userAttributeChangeSchema.safeParse(change([Number.NaN])).success,
    false,
  );
  assert.equal(
    userAttributeChangeSchema.safeParse(change([Number.POSITIVE_INFINITY]))
      .success,
    false,
  );
  assert.equal(
    userAttributeChangeSchema.safeParse(change([{ value: 'B12' }])).success,
    false,
  );
  // Google's largest list holds 150 values (B section 3).
  assert.equal(USER_ATTRIBUTE_VALUES_LIMIT, 150);
  assert.equal(
    userAttributeChangeSchema.safeParse(
      change(Array.from({ length: 150 }, (_, i) => `v${i}`)),
    ).success,
    true,
  );
  assert.equal(
    userAttributeChangeSchema.safeParse(
      change(Array.from({ length: 151 }, (_, i) => `v${i}`)),
    ).success,
    false,
  );
});

test('a change set names each attribute once', () => {
  const changes = [
    {
      schemaName: 'StudentInfo',
      fieldName: 'Homeroom',
      mode: 'set',
      values: ['B12'],
    },
    {
      schemaName: 'StudentInfo',
      fieldName: 'Programs',
      mode: 'clear',
      values: [],
    },
  ];
  assert.equal(userAttributeChangesSchema.safeParse(changes).success, true);
  assert.equal(userAttributeChangesSchema.safeParse([]).success, false);
  assert.equal(
    userAttributeChangesSchema.safeParse([changes[0], changes[0]]).success,
    false,
    'An attribute occurs once.',
  );
  // The account holds at most 100 attributes over all categories (B section 5).
  const many = Array.from(
    { length: USER_ATTRIBUTE_FIELD_LIMIT + 1 },
    (_, index) => ({
      schemaName: `Category${index}`,
      fieldName: 'Value',
      mode: 'set',
      values: ['x'],
    }),
  );
  assert.equal(userAttributeChangesSchema.safeParse(many).success, false);
});

test('a selection preview request copies the device form under the users grid', () => {
  const request = {
    gridId: 'users',
    tabId: '00000000-0000-4000-8000-000000000002',
    changes: [
      {
        schemaName: 'StudentInfo',
        fieldName: 'Homeroom',
        mode: 'set',
        values: ['B12'],
      },
    ],
  };
  assert.deepEqual(userAttributePreviewRequestSchema.parse(request), request);
  assert.equal(
    userAttributePreviewRequestSchema.safeParse({
      ...request,
      gridId: 'devices',
    }).success,
    false,
  );
  assert.equal(
    userAttributePreviewRequestSchema.safeParse({
      ...request,
      tabId: 'not-a-uuid',
    }).success,
    false,
  );
  assert.equal(
    userAttributePreviewRequestSchema.safeParse({ ...request, changes: [] })
      .success,
    false,
  );
});

test('an edit preview carries the C1 key and the baseline of each edit', () => {
  const edit = {
    userId: '107000000000000000001',
    attribute: 'attr:StudentInfo.Homeroom',
    mode: 'set',
    values: ['B13'],
    baselineValue: 'B12',
  };
  assert.deepEqual(userAttributeEditSchema.parse(edit), edit);
  // The C1 key names the attribute, and a separate schema and field name never parse.
  assert.equal(
    userAttributeEditSchema.safeParse({
      ...edit,
      attribute: 'StudentInfo.Homeroom',
    }).success,
    false,
  );
  assert.equal(
    userAttributeEditSchema.safeParse({
      ...edit,
      attribute: 'attribute:StudentInfo.Homeroom',
    }).success,
    false,
  );
  // A baseline is the value that the person saw, a list or nothing at all.
  assert.equal(
    userAttributeEditSchema.safeParse({
      ...edit,
      attribute: 'attr:StudentInfo.Programs',
      mode: 'add',
      values: ['Band'],
      baselineValue: ['ELL'],
    }).success,
    true,
  );
  // A person enters values, so an entry object of the Google body never reaches the wire.
  assert.equal(
    userAttributeEditSchema.safeParse({
      ...edit,
      attribute: 'attr:StudentInfo.Programs',
      mode: 'add',
      values: [{ value: 'Band' }],
      baselineValue: [{ value: 'ELL' }],
    }).success,
    false,
  );
  assert.equal(
    userAttributeEditSchema.safeParse({ ...edit, baselineValue: null }).success,
    true,
  );
  assert.equal(
    userAttributeEditPreviewRequestSchema.safeParse({ edits: [edit] }).success,
    true,
  );
  assert.equal(
    userAttributeEditPreviewRequestSchema.safeParse({ edits: [] }).success,
    false,
  );
  // A user and an attribute occur once, and an edit list holds 2,500 edits on 500 users (E17).
  assert.equal(
    userAttributeEditsSchema.safeParse([edit, edit]).success,
    false,
    'A user and attribute occur once.',
  );
  assert.equal(USER_ATTRIBUTE_EDITS_LIMIT, 2500);
  assert.equal(
    userAttributeEditsSchema.safeParse(
      Array.from({ length: USER_BY_IDS_LIMIT + 1 }, (_, index) => ({
        ...edit,
        userId: `user-${index}`,
      })),
    ).success,
    false,
    'An edit list holds at most 500 users.',
  );
});

test('a value preview answers its counts, its digest, and its expiry', () => {
  const preview = {
    previewId: '00000000-0000-4000-8000-000000000003',
    source: 'selection',
    changes: [
      {
        schemaName: 'StudentInfo',
        fieldName: 'Homeroom',
        mode: 'set',
        values: ['B12'],
      },
    ],
    attributeChanges: 3,
    selected: 10,
    eligible: 6,
    unchanged: 3,
    conflicts: 1,
    oldestObservedAt: previewAt,
    stale: false,
    preparedAt: previewAt,
    expiresAt: previewExpiry,
    manifestDigest: 'b'.repeat(64),
  };
  assert.deepEqual(userAttributePreviewSchema.parse(preview), preview);
  // An edit list answers null changes, because each of its rows carries its own request.
  assert.equal(
    userAttributePreviewSchema.safeParse({
      ...preview,
      source: 'edit-list',
      changes: null,
    }).success,
    true,
  );
  // A selection names its changes, and an edit list names none.
  assert.equal(
    userAttributePreviewSchema.safeParse({ ...preview, source: 'edit-list' })
      .success,
    false,
  );
  assert.equal(
    userAttributePreviewSchema.safeParse({ ...preview, changes: null }).success,
    false,
  );
  assert.equal(
    userAttributePreviewSchema.safeParse({ ...preview, source: 'bulk' })
      .success,
    false,
  );
  // The selected count adds up its four dispositions, and the digest keeps its form.
  assert.equal(
    userAttributePreviewSchema.safeParse({ ...preview, selected: 11 }).success,
    false,
  );
  assert.equal(
    userAttributePreviewSchema.safeParse({
      ...preview,
      manifestDigest: 'b'.repeat(63),
    }).success,
    false,
  );
  assert.equal(
    userAttributePreviewSchema.safeParse({
      ...preview,
      previewId: 'not-a-uuid',
    }).success,
    false,
  );
});

test('a preview target names the C1 attribute, its values, and its disposition', () => {
  const target = {
    userId: '107000000000000000001',
    primaryEmail: 'student@example.org',
    attribute: 'attr:StudentInfo.Homeroom',
    currentValue: 'B12',
    newValue: 'B13',
    disposition: 'eligible',
    observedAt: previewAt,
  };
  assert.deepEqual(userAttributeTargetSchema.parse(target), target);
  for (const disposition of ['eligible', 'unchanged', 'conflict'])
    assert.equal(
      userAttributeTargetSchema.safeParse({ ...target, disposition }).success,
      true,
      `${disposition} parses`,
    );
  assert.equal(
    userAttributeTargetSchema.safeParse({ ...target, disposition: 'excluded' })
      .success,
    false,
  );
  // A clear row carries no new value, and a list row carries each entry's value.
  assert.equal(
    userAttributeTargetSchema.safeParse({ ...target, newValue: null }).success,
    true,
  );
  assert.equal(
    userAttributeTargetSchema.safeParse({
      ...target,
      attribute: 'attr:StudentInfo.Programs',
      currentValue: ['ELL', 'Band'],
      newValue: ['Robotics'],
    }).success,
    true,
  );
  // An empty list is no value, so a row names null instead.
  assert.equal(
    userAttributeTargetSchema.safeParse({ ...target, currentValue: [] })
      .success,
    false,
  );
  assert.equal(
    userAttributeTargetSchema.safeParse({
      ...target,
      attribute: 'attr:StudentInfo',
    }).success,
    false,
  );
  assert.equal(
    userAttributeTargetSchema.safeParse({
      ...target,
      primaryEmail: 'not-an-email',
    }).success,
    false,
  );
  const page = { targets: [target], nextCursor: null };
  assert.deepEqual(userAttributeTargetsPageSchema.parse(page), page);
});

test('a value preview confirm carries the digest and the acknowledgment', () => {
  const confirm = { manifestDigest: 'c'.repeat(64), acknowledged: true };
  assert.deepEqual(
    userAttributePreviewConfirmRequestSchema.parse(confirm),
    confirm,
  );
  for (const body of [
    { ...confirm, acknowledged: false },
    { ...confirm, manifestDigest: 'c'.repeat(63) },
    { ...confirm, typedPhrase: 'Student information' },
  ])
    assert.equal(
      userAttributePreviewConfirmRequestSchema.safeParse(body).success,
      false,
    );
});

test('a value job receipt names the UAT job and its counts', () => {
  const receipt = {
    jobId: '00000000-0000-4000-8000-000000000004',
    displayId: 'UAT-007',
    status: 'accepted',
    userCount: 6,
    changeCount: 2,
  };
  assert.deepEqual(userAttributeJobReceiptSchema.parse(receipt), receipt);
  assert.equal(
    userAttributeJobReceiptSchema.safeParse({ ...receipt, status: 'queued' })
      .success,
    false,
  );
  assert.equal(
    userAttributeJobReceiptSchema.safeParse({ ...receipt, userCount: -1 })
      .success,
    false,
  );
  // A value receipt names a UAT job, not another job kind.
  assert.equal(
    userAttributeJobReceiptSchema.safeParse({
      ...receipt,
      displayId: 'CAT-007',
    }).success,
    false,
  );
});
