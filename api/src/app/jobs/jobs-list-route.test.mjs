import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import esbuild from 'esbuild';

/**
 * Node's type stripping does not transform the Nest decorators of the API sources. Compile the
 * `api/src` TypeScript for this test only, as `jobs-cancel-route.test.mjs` does, so the real
 * Jobs controller and the real exception filter answer these requests.
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

/** One job header, with every column the list and the detail select. */
const jobRow = (overrides = {}) => ({
  job_id: '11111111-1111-4111-8111-111111111111',
  display_id: 'REF-001',
  customer_id: CUSTOMER,
  kind: 'inventory-refresh',
  scope_kind: 'devices',
  entity_type: 'device',
  status: 'completed',
  requested_by: REQUESTER,
  requested_by_name: 'Ada Lovelace',
  generation: 1,
  target_count: 4,
  target_org_unit_paths: ['/Schools/A'],
  succeeded: 4,
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

/** A database for one list or one detail read, with the two stored rows of the fixture. */
const readDatabase = (rows, { matching = rows.length } = {}) =>
  database([
    ['cc.job_reader', [{ customer_id: CUSTOMER }]],
    [
      'AS matching',
      [{ matching, observed_at: new Date('2026-11-18T12:10:00.000Z') }],
    ],
    ['ORDER BY j.created_at DESC', rows],
    ['LEFT JOIN cc.device_update_jobs u', rows],
    ['FROM cc.device_update_operations', []],
  ]);

const session = (actions) => ({
  identity: {
    id: ACTOR,
    displayName: 'Grace Hopper',
    permissions: ['identity:read'],
    permissionVersion: 1,
    grants: actions.map((action) => ({
      action,
      scope: { kind: 'district', customerId: CUSTOMER },
    })),
    preferences: { theme: 'system', navigationCollapsed: false },
  },
  expiresAt: '2026-11-19T13:00:00.000Z',
  csrfToken: 'a'.repeat(64),
});

let app;
let origin;
/** The signed-in caller of the next request. */
let currentSession;
/** The database behind the production JobsService. */
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

  // esbuild does not emit decorator metadata, so the harness names the constructor tokens.
  Reflect.defineMetadata(
    'design:paramtypes',
    [JobsService, AuthService, OrchestrationService],
    JobsController,
  );

  const jobs = new JobsService({
    // The production service decides; each test names the rows that PostgreSQL answers.
    connection: {
      query: (text, values) => activeDb.connection.query(text, values),
    },
  });

  class ListRouteModule {}
  Module({
    controllers: [JobsController],
    providers: [
      { provide: JobsService, useValue: jobs },
      // The list and the detail read no permission decision: `cc.job_reader` decides.
      { provide: AuthService, useValue: {} },
      { provide: OrchestrationService, useValue: {} },
    ],
  })(ListRouteModule);

  const moduleRef = await Test.createTestingModule({
    imports: [ListRouteModule],
  })
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

/** Name one test's caller and rows. */
function arrange(rows, options) {
  activeDb = readDatabase(rows, options);
  currentSession = session(['jobs:read']);
  return activeDb;
}

const statements = (db, needle) =>
  db.calls.filter(([text]) => text.includes(needle));

test('the list names the entity type of each job and filters on no type', async () => {
  const db = arrange([
    jobRow({ display_id: 'REF-004', entity_type: 'user', target_count: 4 }),
    jobRow({ display_id: 'REF-001', entity_type: 'device' }),
  ]);

  const answer = await get('/api/jobs');

  assert.equal(answer.status, 200);
  assert.deepEqual(
    answer.body.jobs.map((job) => job.entityType),
    ['user', 'device'],
  );
  // A full user sync keeps its all-devices scope, and the entity type names the count.
  const [counted] = statements(db, 'AS matching');
  assert.ok(!counted[0].includes('entity_type'));
});

test('the list accepts the user entity type and filters on the stored column', async () => {
  const db = arrange([jobRow({ display_id: 'REF-004', entity_type: 'user' })], {
    matching: 1,
  });

  const answer = await get('/api/jobs?entityType=user');

  assert.equal(answer.status, 200);
  assert.deepEqual(
    answer.body.jobs.map((job) => job.entityType),
    ['user'],
  );
  const [counted, countedValues] = statements(db, 'AS matching')[0];
  assert.ok(counted.includes('j.entity_type=ANY($4::text[])'));
  assert.deepEqual(countedValues[3], ['user']);
  const [paged, pagedValues] = statements(db, 'ORDER BY j.created_at DESC')[0];
  assert.ok(paged.includes('j.entity_type=ANY($4::text[])'));
  assert.deepEqual(pagedValues[3], ['user']);
});

test('the list accepts both entity types in one filter', async () => {
  const db = arrange([
    jobRow({ display_id: 'REF-004', entity_type: 'user' }),
    jobRow({ display_id: 'REF-001', entity_type: 'device' }),
  ]);

  // A repeated key and a comma-separated value both name a list of entity types.
  for (const query of [
    'entityType=user&entityType=device',
    'entityType=user,device',
  ]) {
    const answer = await get(`/api/jobs?${query}`);
    assert.equal(answer.status, 200, query);
    assert.deepEqual(
      answer.body.jobs.map((job) => job.entityType),
      ['user', 'device'],
      query,
    );
    const [counted, countedValues] = statements(db, 'AS matching').at(-1);
    assert.ok(counted.includes('j.entity_type=ANY($4::text[])'), query);
    assert.deepEqual(countedValues[3], ['user', 'device'], query);
  }
});

test('the list refuses an entity type outside the contract', async () => {
  for (const query of ['entityType=group', 'entityType=device,group']) {
    const db = arrange([jobRow()]);

    const answer = await get(`/api/jobs?${query}`);

    assert.equal(answer.status, 400, query);
    assert.equal(answer.body.code, 'invalid-request', query);
    assert.deepEqual(db.calls, [], query);
  }
});

test('the detail names the entity type of a user refresh', async () => {
  const db = arrange([
    jobRow({ display_id: 'REF-004', entity_type: 'user', target_count: 4 }),
  ]);

  const answer = await get('/api/jobs/REF-004');

  assert.equal(answer.status, 200);
  assert.equal(answer.body.entityType, 'user');
  assert.equal(answer.body.scope.deviceCount, 4);
  const [header] = statements(db, 'LEFT JOIN cc.device_update_jobs u')[0];
  assert.ok(header.includes('j.*'));
});
