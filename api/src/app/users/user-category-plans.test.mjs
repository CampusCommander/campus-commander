import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  UserCategoryPlans,
  buildCategoryPlan,
  categoryPlanDigest,
  userCategoryPlanBaseSchema,
} from './user-category-plans.ts';

const at = '2026-11-17T12:00:00.000Z';
const session = {
  identity: { id: 'principal-1', permissionVersion: 3 },
};

const cached = () => ({
  categories: [
    {
      schemaId: 'schem=StudentInfo',
      schemaName: 'StudentInfo',
      displayName: 'Student info',
      etag: 'etag-1',
      fields: [
        {
          fieldId: 'fld-homeroom',
          fieldName: 'Homeroom',
          displayName: 'Homeroom',
          fieldType: 'STRING',
          multiValued: false,
          indexed: true,
          readAccessType: 'ADMINS_AND_SELF',
          numericIndexingSpec: null,
          holders: 12,
        },
        {
          fieldId: 'fld-grade',
          fieldName: 'GradeLevel',
          displayName: 'Grade level',
          fieldType: 'INT64',
          multiValued: false,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: { minValue: 0, maxValue: 12 },
          holders: 0,
        },
      ],
      holders: 12,
      readAt: at,
    },
    {
      schemaId: 'schem=StaffInfo',
      schemaName: 'StaffInfo',
      displayName: 'Staff info',
      etag: 'etag-2',
      fields: [
        {
          fieldId: 'fld-department',
          fieldName: 'Department',
          displayName: 'Department',
          fieldType: 'STRING',
          multiValued: false,
          indexed: true,
          readAccessType: 'ADMINS_AND_SELF',
          numericIndexingSpec: null,
          holders: 0,
        },
      ],
      holders: 0,
      readAt: at,
    },
  ],
  limits: {
    categories: 2,
    categoryLimit: 100,
    attributes: 3,
    attributeLimit: 100,
  },
  observedAt: at,
  customerId: 'C01example',
  generation: 4,
});

const draftField = (overrides = {}) => ({
  fieldId: null,
  fieldName: 'NewField',
  displayName: 'New field',
  fieldType: 'STRING',
  multiValued: false,
  indexed: true,
  readAccessType: 'ADMINS_AND_SELF',
  numericIndexingSpec: null,
  ...overrides,
});

/** One kept attribute, copied from the cache as K17 sends it. */
const keptField = (overrides = {}) => ({
  fieldId: 'fld-homeroom',
  fieldName: 'Homeroom',
  displayName: 'Homeroom',
  fieldType: 'STRING',
  multiValued: false,
  indexed: true,
  readAccessType: 'ADMINS_AND_SELF',
  numericIndexingSpec: null,
  ...overrides,
});

const gradeField = (overrides = {}) => ({
  fieldId: 'fld-grade',
  fieldName: 'GradeLevel',
  displayName: 'Grade level',
  fieldType: 'INT64',
  multiValued: false,
  indexed: true,
  readAccessType: 'ALL_DOMAIN_USERS',
  numericIndexingSpec: { minValue: 0, maxValue: 12 },
  ...overrides,
});

const createPlan = (fields, overrides = {}) => ({
  kind: 'create-category',
  draft: {
    schemaName: 'NewCategory',
    displayName: 'New category',
    fields,
    ...overrides,
  },
});

const editPlan = (fields, overrides = {}) => ({
  kind: 'edit-category',
  schemaId: 'schem=StudentInfo',
  baseEtag: 'etag-1',
  draft: { displayName: 'Student info', fields, ...overrides },
});

const deletePlan = (overrides = {}) => ({
  kind: 'delete-category',
  schemaId: 'schem=StudentInfo',
  baseEtag: 'etag-1',
  ...overrides,
});

/** The status and the reason code of one refusal. */
function refusal(run) {
  try {
    run();
  } catch (error) {
    assert.ok(
      error instanceof HttpException,
      `expected an HTTP refusal, received ${error}`,
    );
    return { status: error.getStatus(), body: error.getResponse() };
  }
  assert.fail('the plan accepted a request that the rules refuse');
}

test('a create plan freezes one insert call', () => {
  const plan = buildCategoryPlan(
    createPlan([
      draftField({ fieldName: 'Homeroom', displayName: 'Homeroom' }),
      draftField({
        fieldName: 'GradeLevel',
        displayName: 'Grade level',
        fieldType: 'INT64',
        numericIndexingSpec: { minValue: 0, maxValue: 12 },
      }),
    ]),
    cached(),
  );
  assert.equal(plan.kind, 'create-category');
  assert.equal(plan.method, 'insert');
  assert.equal(plan.schemaId, null);
  assert.equal(plan.baseEtag, null);
  assert.equal(plan.schemaName, 'NewCategory');
  assert.equal(plan.displayName, 'New category');
  assert.equal(plan.phrase, null);
  assert.equal(plan.changes.length, 2);
  assert.deepEqual(
    plan.changes.map((change) => change.change),
    ['added', 'added'],
  );
  assert.deepEqual(
    plan.changes.map((change) => change.fieldId),
    [null, null],
  );
  assert.deepEqual(plan.body.fields[1].numericIndexingSpec, {
    minValue: 0,
    maxValue: 12,
  });
  assert.equal('fieldId' in plan.body.fields[0], false);
  assert.match(plan.digest, /^[a-f0-9]{64}$/);
});

test('a create plan refuses a category name that the cache holds, without letter case', () => {
  for (const schemaName of ['StudentInfo', 'studentinfo', 'STUDENTINFO']) {
    const { status, body } = refusal(() =>
      buildCategoryPlan(createPlan([draftField()], { schemaName }), cached()),
    );
    assert.equal(status, 422);
    assert.deepEqual(body, { reason: 'name-in-use' });
  }
});

test('an attribute name differs from every other name in its category', () => {
  // B section 5 uniqueness: a create compares its new names, and an edit compares a new name with
  // each kept one. Both compare without letter case.
  for (const [label, request] of [
    [
      'create',
      createPlan([
        draftField({ fieldName: 'Team', displayName: 'Team' }),
        draftField({ fieldName: 'team', displayName: 'Squad' }),
      ]),
    ],
    [
      'edit',
      editPlan([
        keptField(),
        gradeField(),
        draftField({ fieldName: 'homeroom', displayName: 'Homeroom note' }),
      ]),
    ],
  ]) {
    const { status, body } = refusal(() =>
      buildCategoryPlan(request, cached()),
    );
    assert.equal(status, 422, label);
    assert.deepEqual(body, { reason: 'name-in-use' }, label);
  }
});

test('C2 refuses a repeated display name after trimming and case folding', () => {
  const { status, body } = refusal(() =>
    buildCategoryPlan(
      createPlan([
        draftField({ fieldName: 'First', displayName: 'Homeroom' }),
        draftField({ fieldName: 'Second', displayName: '  homeroom ' }),
      ]),
      cached(),
    ),
  );
  assert.equal(status, 422);
  assert.deepEqual(body, { reason: 'display-name-in-use' });
});

test('C2 leaves a display name that Google holds valid until the person changes it', () => {
  // The kept attribute keeps its cached label, and the new attribute repeats it: the new name is
  // the one that collides.
  const { status, body } = refusal(() =>
    buildCategoryPlan(
      editPlan([
        keptField(),
        gradeField(),
        draftField({ fieldName: 'NewField', displayName: 'HOMEROOM' }),
      ]),
      cached(),
    ),
  );
  assert.equal(status, 422);
  assert.deepEqual(body, { reason: 'display-name-in-use' });
});

test('C2 permits two unchanged display names that differ only in letter case', () => {
  const base = cached();
  base.categories[0].fields[0].displayName = 'Homeroom';
  base.categories[0].fields[1].displayName = 'homeroom';
  const plan = buildCategoryPlan(
    editPlan([
      keptField(),
      gradeField({ displayName: 'homeroom' }),
      draftField({ fieldName: 'Third', displayName: 'Third' }),
    ]),
    base,
  );
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].change, 'added');
});

test('C3 keeps the cached number range of a kept attribute', () => {
  const plan = buildCategoryPlan(
    editPlan([
      keptField(),
      gradeField({ displayName: 'Grade' }),
      draftField({ fieldName: 'Third', displayName: 'Third' }),
    ]),
    cached(),
  );
  const changed = plan.changes.find((change) => change.change === 'changed');
  assert.deepEqual(changed.properties, ['displayName']);
  const body = plan.body.fields.find((field) => field.fieldId === 'fld-grade');
  assert.deepEqual(body.numericIndexingSpec, { minValue: 0, maxValue: 12 });
  assert.equal(body.fieldType, 'INT64');
  assert.equal(body.fieldName, 'GradeLevel');
});

test('C3 copies a named range into the frozen call', () => {
  const plan = buildCategoryPlan(
    editPlan([
      keptField(),
      gradeField({ numericIndexingSpec: { minValue: 0, maxValue: 20 } }),
      draftField({ fieldName: 'Third', displayName: 'Third' }),
    ]),
    cached(),
  );
  const changed = plan.changes.find((change) => change.change === 'changed');
  assert.deepEqual(changed.properties, ['numericIndexingSpec']);
  const body = plan.body.fields.find((field) => field.fieldId === 'fld-grade');
  assert.deepEqual(body.numericIndexingSpec, { minValue: 0, maxValue: 20 });
});

test('an edit refuses a renamed attribute', () => {
  const { status, body } = refusal(() =>
    buildCategoryPlan(
      editPlan([
        keptField({ fieldName: 'HomeRoom' }),
        gradeField(),
        draftField({ fieldName: 'Third', displayName: 'Third' }),
      ]),
      cached(),
    ),
  );
  assert.equal(status, 422);
  assert.equal(body.reason, 'locked-property');
});

test('an edit refuses an attribute info type change', () => {
  const { status, body } = refusal(() =>
    buildCategoryPlan(
      editPlan([
        keptField({ fieldType: 'INT64' }),
        gradeField(),
        draftField({ fieldName: 'Third', displayName: 'Third' }),
      ]),
      cached(),
    ),
  );
  assert.equal(status, 422);
  assert.equal(body.reason, 'locked-property');
});

test('an edit refuses a many-value attribute that returns to one value', () => {
  const base = cached();
  base.categories[0].fields[0].multiValued = true;
  const { status, body } = refusal(() =>
    buildCategoryPlan(
      editPlan([
        keptField({ multiValued: false }),
        gradeField(),
        draftField({ fieldName: 'Third', displayName: 'Third' }),
      ]),
      base,
    ),
  );
  assert.equal(status, 422);
  assert.equal(body.reason, 'locked-property');
});

test('an edit refuses a field that the cached category does not hold', () => {
  const { status, body } = refusal(() =>
    buildCategoryPlan(
      editPlan([
        keptField({ fieldId: 'fld-unknown' }),
        gradeField(),
        draftField({ fieldName: 'Third', displayName: 'Third' }),
      ]),
      cached(),
    ),
  );
  assert.equal(status, 400);
  assert.equal(body.reason, 'invalid-plan');
});

test('an edit refuses a repeated field', () => {
  const { status, body } = refusal(() =>
    buildCategoryPlan(
      editPlan([keptField(), keptField(), gradeField()]),
      cached(),
    ),
  );
  assert.equal(status, 400);
  assert.equal(body.reason, 'invalid-plan');
});

test('an edit refuses a save that changes nothing', () => {
  const { status, body } = refusal(() =>
    buildCategoryPlan(editPlan([keptField(), gradeField()]), cached()),
  );
  assert.equal(status, 422);
  assert.deepEqual(body, { reason: 'nothing-to-update' });
});

test('an edit changes only the category label with no attribute change', () => {
  const plan = buildCategoryPlan(
    editPlan([keptField(), gradeField()], { displayName: 'Student details' }),
    cached(),
  );
  assert.equal(plan.method, 'update');
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.phrase, null);
  assert.equal(plan.body.displayName, 'Student details');
  assert.equal(plan.body.fields.length, 2);
});

test('an edit names a removal phrase and its holder count', () => {
  const plan = buildCategoryPlan(
    editPlan([gradeField(), draftField({ fieldName: 'Third' })]),
    cached(),
  );
  assert.equal(plan.phrase, 'Homeroom');
  const removed = plan.changes.find((change) => change.change === 'removed');
  assert.deepEqual(removed, {
    change: 'removed',
    fieldId: 'fld-homeroom',
    fieldName: 'Homeroom',
    displayName: 'Homeroom',
    properties: [],
    holders: 12,
  });
});

test('the frozen call lists every kept field before each new field', () => {
  const plan = buildCategoryPlan(
    editPlan([
      draftField({ fieldName: 'NewFirst', displayName: 'New first' }),
      keptField(),
      gradeField(),
    ]),
    cached(),
  );
  assert.deepEqual(
    plan.body.fields.map((field) => field.fieldName),
    ['Homeroom', 'GradeLevel', 'NewFirst'],
  );
});

test('an edit names each property that moves and freezes its new value', () => {
  // B section 6.1: a save changes labels, visibility, searchable, the range, and one value to
  // multiple values. Each moving property enters the change list, and the body carries the draft.
  const plan = buildCategoryPlan(
    editPlan([
      keptField({
        multiValued: true,
        indexed: false,
        readAccessType: 'ALL_DOMAIN_USERS',
      }),
      gradeField(),
    ]),
    cached(),
  );
  const changed = plan.changes.find((change) => change.change === 'changed');
  assert.deepEqual(changed.properties, [
    'multiValued',
    'indexed',
    'readAccessType',
  ]);
  const body = plan.body.fields.find(
    (field) => field.fieldId === 'fld-homeroom',
  );
  assert.equal(body.multiValued, true);
  assert.equal(body.indexed, false);
  assert.equal(body.readAccessType, 'ALL_DOMAIN_USERS');
});

test('a delete plan freezes the cached label as its phrase', () => {
  const plan = buildCategoryPlan(deletePlan(), cached());
  assert.equal(plan.method, 'delete');
  assert.equal(plan.schemaId, 'schem=StudentInfo');
  assert.equal(plan.displayName, 'Student info');
  assert.equal(plan.phrase, 'Student info');
  assert.equal(plan.body, null);
  assert.deepEqual(
    plan.changes.map((change) => change.change),
    ['removed', 'removed'],
  );
  assert.deepEqual(
    plan.changes.map((change) => change.holders),
    [12, 0],
  );
});

test('a stale etag answers 412 category-changed before any plan is built', () => {
  for (const request of [
    editPlan([keptField(), gradeField()], {}),
    deletePlan(),
  ]) {
    const stale = { ...request, baseEtag: 'etag-old' };
    const { status, body } = refusal(() => buildCategoryPlan(stale, cached()));
    assert.equal(status, 412);
    assert.deepEqual(body, { reason: 'category-changed' });
  }
});

test('an unknown category answers 412 category-changed', () => {
  const { status } = refusal(() =>
    buildCategoryPlan(deletePlan({ schemaId: 'schem=Unknown' }), cached()),
  );
  assert.equal(status, 412);
});

test('the category limit refuses one more category', () => {
  const base = cached();
  base.limits.categories = 100;
  const { status, body } = refusal(() =>
    buildCategoryPlan(createPlan([draftField()]), base),
  );
  assert.equal(status, 422);
  assert.deepEqual(body, { reason: 'category-limit' });
});

test('the attribute limit counts the unsaved attributes', () => {
  const base = cached();
  base.limits.attributes = 99;
  const { status, body } = refusal(() =>
    buildCategoryPlan(
      createPlan([
        draftField(),
        draftField({ fieldName: 'Second', displayName: 'Second' }),
      ]),
      base,
    ),
  );
  assert.equal(status, 422);
  assert.deepEqual(body, { reason: 'attribute-limit' });
});

test('an edit drops the removed attributes from the attribute count', () => {
  const base = cached();
  base.limits.attributes = 100;
  const plan = buildCategoryPlan(
    editPlan([
      gradeField(),
      draftField({ fieldName: 'Third', displayName: 'Third' }),
    ]),
    base,
  );
  assert.equal(plan.changes.length, 2);
});

test('a display name needs a visible character', () => {
  const { status, body } = refusal(() =>
    buildCategoryPlan(
      createPlan([draftField({ displayName: '   ' })]),
      cached(),
    ),
  );
  assert.equal(status, 422);
  assert.deepEqual(body, { reason: 'invalid-display-name' });
});

test('the digest covers the frozen call and the change plan', () => {
  const plan = buildCategoryPlan(
    editPlan([keptField(), gradeField(), draftField({ fieldName: 'Third' })]),
    cached(),
  );
  const again = buildCategoryPlan(
    editPlan([keptField(), gradeField(), draftField({ fieldName: 'Third' })]),
    cached(),
  );
  assert.equal(plan.digest, again.digest);
  const moved = buildCategoryPlan(
    editPlan([
      keptField(),
      gradeField(),
      draftField({ fieldName: 'Third', displayName: 'Third' }),
    ]),
    cached(),
  );
  assert.notEqual(plan.digest, moved.digest);
});

test('the plan base carries the customer and the generation', () => {
  const base = userCategoryPlanBaseSchema.parse(cached());
  assert.equal(base.customerId, 'C01example');
  assert.equal(base.generation, 4);
});

/** One fake port for the route rules. */
function port(overrides = {}) {
  const calls = { authorize: [], create: [], read: [], confirm: [] };
  return {
    calls,
    async base() {
      return 'base' in overrides ? overrides.base : cached();
    },
    async authorize(_session, customerId, correlationId) {
      calls.authorize.push({ customerId, correlationId });
    },
    async create(_session, plan) {
      calls.create.push(plan);
      return 'create' in overrides
        ? overrides.create
        : { outcome: 'created', plan: storedPlan(plan) };
    },
    async read(_session, planId) {
      calls.read.push(planId);
      return 'read' in overrides ? overrides.read : { outcome: 'plan' };
    },
    async confirm(_session, planId, digest, phrase, correlationId) {
      calls.confirm.push({ planId, digest, phrase, correlationId });
      return 'confirm' in overrides ? overrides.confirm : created();
    },
  };
}

/** A stored plan, as the function answers it. */
function storedPlan(plan) {
  return {
    planId: '0e1f1a4e-6a0d-4f38-9f4c-2d2b5a3c1b7e',
    kind: plan.kind,
    method: plan.method,
    schemaId: plan.schemaId,
    schemaName: plan.schemaName,
    displayName: plan.displayName,
    baseEtag: plan.baseEtag,
    changes: plan.changes,
    phrase: plan.phrase,
    limits: {
      categories: 2,
      categoryLimit: 100,
      attributes: 2,
      attributeLimit: 100,
    },
    preparedAt: at,
    expiresAt: '2026-11-17T12:15:00.000Z',
    digest: plan.digest,
  };
}

function created() {
  return {
    outcome: 'created',
    receipt: {
      jobId: '5c6d7e8f-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
      displayId: 'CAT-100',
      status: 'accepted',
      action: 'create-category',
      changeCount: 1,
    },
  };
}

test('the plan route stores one plan under the schema-manage gate', async () => {
  const fake = port();
  const route = new UserCategoryPlans(fake);
  const plan = await route.plan(
    session,
    createPlan([draftField()]),
    'correlation-1',
  );
  assert.equal(plan.method, 'insert');
  assert.deepEqual(fake.calls.authorize, [
    { customerId: 'C01example', correlationId: 'correlation-1' },
  ]);
  const stored = fake.calls.create[0];
  assert.equal(stored.customerId, 'C01example');
  assert.equal(stored.generation, 4);
  assert.equal(stored.expiresMinutes, 15);
  assert.match(stored.digest, /^[a-f0-9]{64}$/);
});

test('the plan route answers 409 connection-required without a connection', async () => {
  const fake = port({ base: null });
  const route = new UserCategoryPlans(fake);
  await assert.rejects(
    route.plan(session, createPlan([draftField()]), 'correlation-1'),
    (error) =>
      error instanceof ConflictException &&
      error.getResponse().reason === 'connection-required',
  );
  assert.equal(fake.calls.create.length, 0);
});

test('the plan route answers 412 when the store reports a changed category', async () => {
  const route = new UserCategoryPlans(
    port({ create: { outcome: 'category-changed' } }),
  );
  await assert.rejects(
    route.plan(session, createPlan([draftField()]), 'correlation-1'),
    (error) =>
      error instanceof HttpException &&
      error.getStatus() === 412 &&
      error.getResponse().reason === 'category-changed',
  );
});

test('the plan route answers each limit and name code of B section 13', async () => {
  for (const [outcome, status] of [
    ['category-limit', 422],
    ['attribute-limit', 422],
    ['name-in-use', 422],
  ]) {
    const route = new UserCategoryPlans(port({ create: { outcome } }));
    await assert.rejects(
      route.plan(session, createPlan([draftField()]), 'correlation-1'),
      (error) =>
        error instanceof UnprocessableEntityException &&
        error.getStatus() === status &&
        error.getResponse().reason === outcome,
    );
  }
});

test('the plan read answers 404 for another creator', async () => {
  const fake = port({ read: { outcome: 'not-found' } });
  const route = new UserCategoryPlans(fake);
  await assert.rejects(
    route.byId(session, '0e1f1a4e-6a0d-4f38-9f4c-2d2b5a3c1b7e', 'c-1'),
    (error) =>
      error instanceof NotFoundException &&
      error.getResponse().reason === 'plan-not-found',
  );
  assert.equal(fake.calls.authorize.length, 0);
});

test('the plan read authorizes the customer of the stored plan', async () => {
  const fake = port({
    read: {
      outcome: 'plan',
      customerId: 'C01example',
      plan: storedPlan({
        ...buildCategoryPlan(createPlan([draftField()]), cached()),
      }),
    },
  });
  const route = new UserCategoryPlans(fake);
  const plan = await route.byId(
    session,
    '0e1f1a4e-6a0d-4f38-9f4c-2d2b5a3c1b7e',
    'c-1',
  );
  assert.equal(plan.kind, 'create-category');
  assert.deepEqual(fake.calls.authorize, [
    { customerId: 'C01example', correlationId: 'c-1' },
  ]);
});

test('the plan read answers 410 with the expiry of a lapsed plan', async () => {
  const route = new UserCategoryPlans(
    port({
      read: {
        outcome: 'plan-expired',
        expiresAt: '2026-11-17T12:15:00.000Z',
      },
    }),
  );
  await assert.rejects(
    route.byId(session, '0e1f1a4e-6a0d-4f38-9f4c-2d2b5a3c1b7e', 'c-1'),
    (error) =>
      error instanceof GoneException &&
      error.getResponse().reason === 'plan-expired' &&
      error.getResponse().expiresAt === '2026-11-17T12:15:00.000Z',
  );
});

test('the confirm trims the typed phrase and answers the receipt', async () => {
  const fake = port();
  const route = new UserCategoryPlans(fake);
  const result = await route.confirm(
    session,
    '0e1f1a4e-6a0d-4f38-9f4c-2d2b5a3c1b7e',
    {
      digest: 'a'.repeat(64),
      acknowledged: true,
      typedPhrase: '  Homeroom  ',
    },
    'c-1',
  );
  assert.equal(result.existing, false);
  assert.equal(result.receipt.displayId, 'CAT-100');
  assert.deepEqual(fake.calls.confirm, [
    {
      planId: '0e1f1a4e-6a0d-4f38-9f4c-2d2b5a3c1b7e',
      digest: 'a'.repeat(64),
      phrase: 'Homeroom',
      correlationId: 'c-1',
    },
  ]);
});

test('the confirm sends no phrase when the body names none', async () => {
  const fake = port();
  const route = new UserCategoryPlans(fake);
  await route.confirm(
    session,
    '0e1f1a4e-6a0d-4f38-9f4c-2d2b5a3c1b7e',
    { digest: 'a'.repeat(64), acknowledged: true },
    'c-1',
  );
  assert.equal(fake.calls.confirm[0].phrase, null);
});

test('a repeated confirm answers the same receipt', async () => {
  const route = new UserCategoryPlans(
    port({ confirm: { ...created(), outcome: 'existing' } }),
  );
  const result = await route.confirm(
    session,
    '0e1f1a4e-6a0d-4f38-9f4c-2d2b5a3c1b7e',
    { digest: 'a'.repeat(64), acknowledged: true },
    'c-1',
  );
  assert.equal(result.existing, true);
  assert.equal(result.receipt.displayId, 'CAT-100');
});

test('a confirm answers 422 phrase-mismatch', async () => {
  const route = new UserCategoryPlans(
    port({ confirm: { outcome: 'phrase-mismatch' } }),
  );
  await assert.rejects(
    route.confirm(
      session,
      '0e1f1a4e-6a0d-4f38-9f4c-2d2b5a3c1b7e',
      { digest: 'a'.repeat(64), acknowledged: true, typedPhrase: 'Wrong' },
      'c-1',
    ),
    (error) =>
      error instanceof UnprocessableEntityException &&
      error.getResponse().reason === 'phrase-mismatch',
  );
});

test('a confirm answers 412 category-changed after the category moved', async () => {
  const route = new UserCategoryPlans(
    port({ confirm: { outcome: 'category-changed' } }),
  );
  await assert.rejects(
    route.confirm(
      session,
      '0e1f1a4e-6a0d-4f38-9f4c-2d2b5a3c1b7e',
      { digest: 'a'.repeat(64), acknowledged: true },
      'c-1',
    ),
    (error) =>
      error instanceof HttpException &&
      error.getStatus() === 412 &&
      error.getResponse().reason === 'category-changed',
  );
});

test('a confirm answers 409 plan-changed after a different plan', async () => {
  const route = new UserCategoryPlans(
    port({ confirm: { outcome: 'plan-changed' } }),
  );
  await assert.rejects(
    route.confirm(
      session,
      '0e1f1a4e-6a0d-4f38-9f4c-2d2b5a3c1b7e',
      { digest: 'b'.repeat(64), acknowledged: true },
      'c-1',
    ),
    (error) =>
      error instanceof ConflictException &&
      error.getResponse().reason === 'plan-changed',
  );
});

test('a confirm answers 410 for a lapsed plan and creates no job', async () => {
  const fake = port({ read: { outcome: 'plan-expired', expiresAt: at } });
  const route = new UserCategoryPlans(fake);
  await assert.rejects(
    route.confirm(
      session,
      '0e1f1a4e-6a0d-4f38-9f4c-2d2b5a3c1b7e',
      { digest: 'a'.repeat(64), acknowledged: true },
      'c-1',
    ),
    (error) =>
      error instanceof GoneException &&
      error.getResponse().reason === 'plan-expired',
  );
  assert.equal(fake.calls.confirm.length, 0);
});

test('a confirm answers 403 without users:schema-manage', async () => {
  const fake = port();
  fake.authorize = async () => {
    throw new ForbiddenException({ reason: 'forbidden' });
  };
  const route = new UserCategoryPlans(fake);
  await assert.rejects(
    route.confirm(
      session,
      '0e1f1a4e-6a0d-4f38-9f4c-2d2b5a3c1b7e',
      { digest: 'a'.repeat(64), acknowledged: true },
      'c-1',
    ),
    (error) => error instanceof ForbiddenException,
  );
  assert.equal(fake.calls.confirm.length, 0);
});

test('a function answer that is not an object answers 503', async () => {
  const route = new UserCategoryPlans(port({ read: null }));
  await assert.rejects(
    route.byId(session, '0e1f1a4e-6a0d-4f38-9f4c-2d2b5a3c1b7e', 'c-1'),
    (error) =>
      error instanceof ServiceUnavailableException &&
      error.getResponse().reason === 'user-schema-unavailable',
  );
});
