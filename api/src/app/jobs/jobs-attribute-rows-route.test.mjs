import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import esbuild from 'esbuild';
import { JOB_ACTION_LABELS } from '@campus/application-contracts';

/**
 * The J4 routes of the category and value jobs: the list, the action filter, the detail rows of CA
 * state 07, and the value result rows of UM state 10. The harness compiles the API TypeScript and
 * serves the real Jobs controller, as `jobs-list-route.test.mjs` does.
 */
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.ts') && url.includes('/api/src/')) {
      const file = fileURLToPath(url);
      const { code } = esbuild.transformSync(readFileSync(file, 'utf8'), {
        loader: 'ts',
        format: 'esm',
        target: 'node22',
        tsconfigRaw: {
          compilerOptions: {
            experimentalDecorators: true,
            useDefineForClassFields: false,
          },
        },
        sourcefile: file,
      });
      return { format: 'module', shortCircuit: true, source: code };
    }
    return nextLoad(url, context);
  },
});

const require = createRequire(import.meta.url);
const { Module } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');

const CUSTOMER = 'C0123456';
const REQUESTER = '22222222-2222-4222-8222-222222222222';
const ACTOR = '44444444-4444-4444-8444-444444444444';

/** One job header, with every column the list, the detail, and the result rows select. */
const jobRow = (overrides = {}) => ({
  job_id: '11111111-1111-4111-8111-111111111111',
  display_id: 'CAT-001',
  customer_id: CUSTOMER,
  kind: 'user-schema-change',
  scope_kind: 'devices',
  entity_type: 'device',
  status: 'completed',
  requested_by: REQUESTER,
  requested_by_name: 'Ada Lovelace',
  generation: 1,
  target_count: 1,
  target_org_unit_paths: null,
  succeeded: 1,
  failed: 0,
  unknown: 0,
  skipped: 0,
  expired: 0,
  cancelled: 0,
  cancel_requested_at: null,
  cancel_requested_by: null,
  cancel_requested_by_name: null,
  failure: null,
  revision: 4,
  changed_at: new Date('2026-11-18T12:05:00.000Z'),
  correlation_id: '33333333-3333-4333-8333-333333333333',
  created_at: new Date('2026-11-18T12:00:00.000Z'),
  admitted_at: null,
  started_at: new Date('2026-11-18T12:00:00.000Z'),
  finished_at: new Date('2026-11-18T12:02:00.000Z'),
  confirmed_by: null,
  action: null,
  changes: null,
  deprovision_reason: null,
  confirmed_by_name: null,
  preview_display_id: null,
  export_purpose: null,
  import_mode: null,
  plan_state: null,
  plan_expires_at: null,
  proposed: null,
  rejected: null,
  refusal: null,
  // The category plan of the job (migration 030) and the value rows' display names.
  plan_action: null,
  plan_scope_name: null,
  plan_body: null,
  plan_changes: null,
  plan_previous_name: null,
  plan_field_types: null,
  ...overrides,
});

/**
 * A database whose answers match a needle of the statement text. Every call is recorded. The
 * bind-count check mirrors `jobs.test.mjs`: PostgreSQL refuses a statement whose placeholders and
 * values disagree.
 */
function database(routes) {
  const calls = [];
  return {
    calls,
    connection: {
      async query(text, values = []) {
        calls.push([text, values]);
        const used = new Set(
          [...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])),
        );
        const highest = used.size ? Math.max(...used) : 0;
        if (used.size !== highest || highest !== values.length)
          throw Object.assign(
            new Error(
              `bind message supplies ${values.length} parameters, but prepared statement requires ${highest}`,
            ),
            { code: '08P01' },
          );
        for (const [needle, answer] of routes) {
          if (text.includes(needle))
            return {
              rows:
                typeof answer === 'function' ? answer(values, text) : answer,
            };
        }
        throw new Error(`Unexpected statement: ${text}`);
      },
    },
  };
}

const session = () => ({
  identity: {
    id: ACTOR,
    displayName: 'Grace Hopper',
    permissions: ['identity:read'],
    permissionVersion: 1,
    grants: [
      {
        action: 'jobs:read',
        scope: { kind: 'district', customerId: CUSTOMER },
      },
    ],
    preferences: { theme: 'system', navigationCollapsed: false },
  },
  expiresAt: '2026-11-19T13:00:00.000Z',
  csrfToken: 'a'.repeat(64),
});

/** One frozen user and attribute row of a value job. */
const valueRow = (overrides = {}) => ({
  ordinal: 1,
  user_id: 'u1',
  user_name: 'Alex Rivera',
  primary_email: 'alex@example.org',
  schema_name: 'StudentInfo',
  field_name: 'Grade',
  current_value: 5,
  requested_value: 6,
  outcome: 'succeeded',
  failure: null,
  google_reason: null,
  display_name: 'Grade',
  operation: 1,
  ...overrides,
});

let app;
let origin;
let currentSession;
let activeDb;

before(async () => {
  const [
    controllerModule,
    securityModule,
    guardModule,
    jobsServiceModule,
    authModule,
    orchestrationModule,
  ] = await Promise.all([
    import('./jobs.controller.ts'),
    import('../security.ts'),
    import('../auth/auth.guard.ts'),
    import('./jobs.service.ts'),
    import('../auth/auth.service.ts'),
    import('../orchestration/orchestration.service.ts'),
  ]);
  const { JobsController } = controllerModule;
  const { ApplicationExceptionFilter, securityHeaders } = securityModule;
  const { AuthGuard } = guardModule;
  const { JobsService } = jobsServiceModule;
  const { AuthService } = authModule;
  const { OrchestrationService } = orchestrationModule;

  Reflect.defineMetadata(
    'design:paramtypes',
    [JobsService, AuthService, OrchestrationService],
    JobsController,
  );

  const jobs = new JobsService({
    connection: {
      query: (text, values) => activeDb.connection.query(text, values),
    },
  });

  class JobsJ4Module {}
  Module({
    controllers: [JobsController],
    providers: [
      { provide: JobsService, useValue: jobs },
      { provide: AuthService, useValue: {} },
      { provide: OrchestrationService, useValue: {} },
    ],
  })(JobsJ4Module);

  const moduleRef = await Test.createTestingModule({ imports: [JobsJ4Module] })
    .overrideGuard(AuthGuard)
    .useValue({
      canActivate: (context) => {
        context.switchToHttp().getRequest().session = currentSession;
        return true;
      },
    })
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.use(securityHeaders);
  app.useGlobalFilters(new ApplicationExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app?.close();
});

const get = async (path) => {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: await response.json() };
};

/** The list and detail read: one customer, one counted row, and the job rows. */
const readDatabase = (
  rows,
  { matching = rows.length, totals, values = [] } = {},
) =>
  database([
    ['cc.job_reader', [{ customer_id: CUSTOMER }]],
    [
      'AS matching',
      [{ matching, observed_at: new Date('2026-11-18T12:10:00.000Z') }],
    ],
    ['ORDER BY j.created_at DESC', rows],
    ['AS all_rows', totals ?? [{ all_rows: 0, failed_rows: 0 }]],
    ['row_number() OVER (ORDER BY o.ordinal)', values],
    ['LEFT JOIN cc.device_update_jobs u', rows],
    ['FROM cc.device_update_operations', []],
  ]);

const arrange = (rows, options) => {
  activeDb = readDatabase(rows, options);
  currentSession = session();
  return activeDb;
};

const statements = (db, needle) =>
  db.calls.filter(([text]) => text.includes(needle));

test('the list names the category and value actions, their labels, and the scope name', async () => {
  const db = arrange([
    jobRow({
      display_id: 'CAT-001',
      kind: 'user-schema-change',
      plan_action: 'create-category',
      plan_scope_name: 'Student info',
      status: 'completed',
    }),
    jobRow({
      job_id: '55555555-5555-4555-8555-555555555555',
      display_id: 'UAT-002',
      kind: 'user-attribute-update',
      entity_type: 'user',
      target_count: 18,
      succeeded: 0,
      pending: 0,
      status: 'running',
      plan_action: null,
      plan_scope_name: null,
    }),
  ]);

  const answer = await get('/api/jobs');

  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(
    answer.body.jobs.map((job) => job.action),
    ['create-category', 'set-attributes'],
  );
  // Item 1: the title takes the action, and the labels are the approved ones.
  assert.equal(JOB_ACTION_LABELS['create-category'], 'Create category');
  assert.equal(JOB_ACTION_LABELS['set-attributes'], 'Set attributes');
  // Item 2: the scope line takes the category display name, and a value job carries none.
  assert.deepEqual(answer.body.jobs[0].category, { scopeName: 'Student info' });
  assert.equal('category' in answer.body.jobs[1], false);
  // The scope of a value job counts the eligible users.
  assert.deepEqual(answer.body.jobs[1].scope, {
    kind: 'devices',
    deviceCount: 18,
  });
  // The list joins the plan row in the counted statement, and the plan itself in the page.
  const [counted] = statements(db, 'AS matching');
  assert.ok(counted[0].includes('cc.user_schema_change_jobs'));
  const [paged] = statements(db, 'ORDER BY j.created_at DESC');
  assert.ok(paged[0].includes('cc.user_category_plans'));
});

test('the action filter narrows each category action to its plan row', async () => {
  const db = arrange([jobRow({ plan_action: 'create-category' })]);

  for (const action of ['create-category', 'edit-category', 'delete-category'])
    assert.equal((await get(`/api/jobs?action=${action}`)).status, 200, action);
  const [counted, values] = statements(db, 'AS matching').at(-1);
  assert.ok(counted.includes('j.kind=ANY($4::text[])'));
  assert.deepEqual(values[3], ['user-schema-change']);
  assert.ok(
    counted.includes(
      "j.kind<>'user-schema-change' OR catp.action=ANY($5::text[])",
    ),
  );
  assert.deepEqual(values[4], ['delete-category']);

  // A value job filter selects the value kind alone, with no plan predicate.
  const valueDb = arrange([jobRow({ display_id: 'UAT-002' })]);
  assert.equal((await get('/api/jobs?action=set-attributes')).status, 200);
  const [valueCounted, valueValues] = statements(valueDb, 'AS matching')[0];
  assert.deepEqual(valueValues[3], ['user-attribute-update']);
  assert.ok(!valueCounted.includes('catp.action=ANY'));
});

test('the detail of a category job carries the state 07 row of a create', async () => {
  arrange([
    jobRow({
      display_id: 'CAT-001',
      plan_action: 'create-category',
      plan_scope_name: 'Student info',
      plan_body: {
        displayName: 'Student info',
        fields: [{ fieldName: 'Homeroom', fieldType: 'STRING' }],
      },
      plan_changes: [
        {
          change: 'added',
          fieldName: 'Homeroom',
          displayName: 'Homeroom',
          properties: [],
        },
      ],
      plan_field_types: { Homeroom: 'STRING' },
      status: 'completed',
    }),
  ]);

  const answer = await get('/api/jobs/CAT-001');

  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.action, 'create-category');
  assert.deepEqual(answer.body.category, {
    scopeName: 'Student info',
    previousName: null,
    rows: [
      {
        change: 'added',
        displayName: 'Homeroom',
        fieldType: 'STRING',
        range: null,
        holders: null,
        previousName: null,
        outcome: 'succeeded',
      },
    ],
  });
});

test('the detail carries the rename, the range, the holders, and the outcome', async () => {
  arrange([
    jobRow({
      display_id: 'CAT-002',
      plan_action: 'edit-category',
      plan_scope_name: 'Student records',
      plan_previous_name: 'Student info',
      plan_body: {
        displayName: 'Student records',
        fields: [
          {
            fieldName: 'Grade',
            fieldType: 'INT64',
            numericIndexingSpec: { minValue: 1, maxValue: 12 },
          },
        ],
      },
      plan_changes: [
        {
          change: 'changed',
          fieldName: 'Grade',
          displayName: 'Grade',
          properties: ['numericIndexingSpec'],
        },
        {
          change: 'removed',
          fieldName: 'Homeroom',
          displayName: 'Homeroom',
          holders: 0,
        },
      ],
      plan_field_types: { Grade: 'INT64', Homeroom: 'STRING' },
      status: 'failed',
    }),
  ]);

  const answer = await get('/api/jobs/CAT-002');

  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.action, 'edit-category');
  assert.equal(answer.body.category.scopeName, 'Student records');
  assert.equal(answer.body.category.previousName, 'Student info');
  assert.deepEqual(answer.body.category.rows, [
    {
      change: 'rename',
      displayName: 'Student records',
      fieldType: null,
      range: null,
      holders: null,
      previousName: 'Student info',
      outcome: 'failed',
    },
    {
      change: 'changed',
      displayName: 'Grade',
      fieldType: 'INT64',
      range: { minValue: 1, maxValue: 12 },
      holders: null,
      previousName: null,
      outcome: 'failed',
    },
    {
      change: 'removed',
      displayName: 'Homeroom',
      fieldType: 'STRING',
      range: null,
      holders: 0,
      previousName: null,
      outcome: 'failed',
    },
  ]);
});

test('the detail of a delete job keeps the cached scope name and reads cancelled', async () => {
  arrange([
    jobRow({
      display_id: 'CAT-003',
      plan_action: 'delete-category',
      plan_scope_name: 'Student records',
      plan_body: null,
      plan_changes: [
        {
          change: 'removed',
          fieldName: 'Grade',
          displayName: 'Grade',
          holders: 12,
        },
      ],
      plan_field_types: { Grade: 'INT64' },
      status: 'cancelled',
    }),
  ]);

  const answer = await get('/api/jobs/CAT-003');

  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.action, 'delete-category');
  assert.equal(answer.body.category.scopeName, 'Student records');
  assert.equal(answer.body.category.previousName, null);
  assert.deepEqual(answer.body.category.rows, [
    {
      change: 'removed',
      displayName: 'Grade',
      fieldType: 'INT64',
      range: null,
      holders: 12,
      previousName: null,
      outcome: 'cancelled',
    },
  ]);
});

test('the value rows page answers both views, their totals, and a cursor', async () => {
  const totals = [{ all_rows: 4, failed_rows: 1 }];
  const db = arrange(
    [
      jobRow({
        display_id: 'UAT-002',
        kind: 'user-attribute-update',
        entity_type: 'user',
      }),
    ],
    {
      totals,
      values: [
        valueRow(),
        valueRow({
          ordinal: 2,
          user_id: 'u2',
          user_name: 'Sam Lee',
          primary_email: 'sam@example.org',
          operation: 2,
        }),
        valueRow({
          ordinal: 2,
          user_id: 'u2',
          user_name: 'Sam Lee',
          primary_email: 'sam@example.org',
          field_name: 'Homeroom',
          display_name: 'Homeroom',
          current_value: 'B11',
          requested_value: 'B12',
          operation: 2,
        }),
      ],
    },
  );

  const all = await get('/api/jobs/UAT-002/attribute-rows?limit=2');

  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.totals, { all: 4, failed: 1 });
  assert.deepEqual(all.body.nextCursor, '2:StudentInfo.Grade');
  assert.deepEqual(all.body.rows, [
    {
      operation: 1,
      userId: 'u1',
      userName: 'Alex Rivera',
      primaryEmail: 'alex@example.org',
      attribute: 'attr:StudentInfo.Grade',
      displayName: 'Grade',
      currentValue: 5,
      newValue: 6,
      outcome: 'succeeded',
      failureText: null,
    },
    {
      operation: 2,
      userId: 'u2',
      userName: 'Sam Lee',
      primaryEmail: 'sam@example.org',
      attribute: 'attr:StudentInfo.Grade',
      displayName: 'Grade',
      currentValue: 5,
      newValue: 6,
      outcome: 'succeeded',
      failureText: null,
    },
  ]);
  const [paged, pagedValues] = statements(
    db,
    'row_number() OVER (ORDER BY o.ordinal)',
  )[0];
  // The All view passes false, and the page reads one row beyond its limit.
  assert.equal(pagedValues[4], false);
  assert.equal(pagedValues[8], 3);

  // The Failed view passes true, and its next cursor is the row that ended the page.
  const failed = await get(
    '/api/jobs/UAT-002/attribute-rows?view=failed&limit=2',
  );
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  const [failedQuery, failedValues] = statements(
    db,
    'row_number() OVER (ORDER BY o.ordinal)',
  ).at(-1);
  assert.ok(failedQuery.includes("COALESCE(t.outcome,'pending')='failed'"));
  assert.equal(failedValues[4], true);

  // A cursor page binds the ordinal, the schema, and the field.
  const next = await get(
    '/api/jobs/UAT-002/attribute-rows?cursor=2:StudentInfo.Grade',
  );
  assert.equal(next.status, 200, JSON.stringify(next.body));
  const [cursorQuery, cursorValues] = statements(
    db,
    'row_number() OVER (ORDER BY o.ordinal)',
  ).at(-1);
  assert.ok(cursorQuery.includes('(t.ordinal,v.schema_name,v.field_name)>'));
  assert.deepEqual(cursorValues.slice(5, 8), [2, 'StudentInfo', 'Grade']);
});

test('a failed row names the drafted text, or the Google reason', async () => {
  arrange([jobRow({ display_id: 'UAT-002', kind: 'user-attribute-update' })], {
    totals: [{ all_rows: 2, failed_rows: 2 }],
    values: [
      valueRow({
        outcome: 'failed',
        failure: 'not-found',
        google_reason: 'notFound',
      }),
      valueRow({
        ordinal: 2,
        user_id: 'u2',
        outcome: 'failed',
        failure: 'some-new-code',
        google_reason: 'reasonText',
      }),
    ],
  });

  const answer = await get('/api/jobs/UAT-002/attribute-rows?view=failed');

  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(
    answer.body.rows.map((row) => row.failureText),
    ['Google could not find this user.', 'reasonText'],
  );
});

test('the value rows route refuses a limit of 1,001 and a bad cursor before any read', async () => {
  const db = arrange([jobRow({ display_id: 'UAT-002' })]);

  for (const query of [
    '/api/jobs/UAT-002/attribute-rows?limit=1001',
    '/api/jobs/UAT-002/attribute-rows?limit=0',
    '/api/jobs/UAT-002/attribute-rows?view=some',
    '/api/jobs/UAT-002/attribute-rows?cursor=nope',
  ]) {
    const answer = await get(query);
    assert.equal(answer.status, 400, query);
    assert.equal(answer.body.code, 'invalid-request', query);
  }
  assert.deepEqual(db.calls, []);
});

test('a caller outside the job visibility gets 404', async () => {
  const db = arrange([]);

  const answer = await get('/api/jobs/UAT-002/attribute-rows');

  assert.equal(answer.status, 404);
  assert.deepEqual(answer.body, { reason: 'job-not-found' });
  // The header decides the 404 before any result row read.
  assert.equal(statements(db, 'AS all_rows').length, 0);
});
