import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import esbuild from 'esbuild';

/**
 * Node's type stripping does not transform the Nest decorators of the API sources. Compile the
 * `api/src` TypeScript for this test only, as `device-updates-route.test.mjs` does, so the real
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
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTER = '22222222-2222-4222-8222-222222222222';
const ACTOR = '44444444-4444-4444-8444-444444444444';

/** One job header, with every column the header query selects. */
const jobRow = (overrides = {}) => ({
  job_id: JOB_ID,
  display_id: 'STS-002',
  customer_id: CUSTOMER,
  kind: 'device-status',
  scope_kind: 'devices',
  status: 'running',
  requested_by: REQUESTER,
  requested_by_name: 'Ada Lovelace',
  generation: 1,
  target_count: 1,
  target_org_unit_paths: ['/Schools/A'],
  succeeded: 0,
  failed: 0,
  unknown: 1,
  skipped: 0,
  expired: 0,
  failure: null,
  revision: 4,
  changed_at: new Date('2026-10-21T12:05:00.000Z'),
  correlation_id: '33333333-3333-4333-8333-333333333333',
  created_at: new Date('2026-10-21T12:00:00.000Z'),
  admitted_at: null,
  started_at: new Date('2026-10-21T12:00:00.000Z'),
  finished_at: null,
  confirmed_by: null,
  changes: null,
  deprovision_reason: 'retiring',
  confirmed_by_name: null,
  preview_display_id: 'PRV-002',
  ...overrides,
});

/** One operation row, with every column the reconcile query selects. */
const operationRow = (overrides = {}) => ({
  operation_number: 1,
  device_id: 'device-1',
  serial_number: 'C0A1-0001',
  org_unit_path: '/Schools/A',
  action: 'deprovision',
  mode: null,
  baseline_value: null,
  requested_value: 'DEPROVISIONED',
  status: 'unknown',
  outcome_reason: null,
  google_status: null,
  google_reason: null,
  observed_value: null,
  verified_by: null,
  command_id: null,
  command_state: null,
  command_expires_at: null,
  command_executed_at: null,
  updated_at: new Date('2026-10-21T12:00:00.000Z'),
  ...overrides,
});

/**
 * A database whose answers match a needle of the statement text. Every call is recorded.
 * The bind-count check mirrors `jobs.test.mjs`: PostgreSQL refuses a statement whose
 * placeholders and values disagree.
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

/** A database for one Reconcile: the connected customer, the header, the row, and the claim. */
function reconcileDatabase(job = {}, operation = {}) {
  return database([
    ['cc.job_reader', [{ customer_id: CUSTOMER }]],
    ['p.display_name AS requested_by_name', [jobRow(job)]],
    ['o.operation_number=$5', [operationRow(operation)]],
    [
      'claim_device_update_verification',
      [{ result: [{ operationNumber: 1 }] }],
    ],
  ]);
}

const claimCount = (db) =>
  db.calls.filter(([text]) => text.includes('claim_device_update_verification'))
    .length;

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
  expiresAt: '2026-10-23T13:00:00.000Z',
  csrfToken: 'a'.repeat(64),
});

let app;
let origin;
/** The signed-in caller of the next request. */
let currentSession;
/** The database behind the production JobsService. */
let activeDb;
/** The permission checks that the production authorization ran, and the audit rows it wrote. */
let auditEvents;
/** The reconcile flows that the production controller started. */
let startedFlows;

before(async () => {
  const [
    controllerModule,
    securityModule,
    guardModule,
    jobsServiceModule,
    authModule,
    authzModule,
    eventsModule,
    orchestrationModule,
  ] = await Promise.all([
    import('./jobs.controller.ts'),
    import('../security.ts'),
    import('../auth/auth.guard.ts'),
    import('./jobs.service.ts'),
    import('../auth/auth.service.ts'),
    import('../auth/authorize-action.ts'),
    import('../devices/device-events.service.ts'),
    import('../orchestration/orchestration.service.ts'),
  ]);
  const { JobsController } = controllerModule;
  const { ApplicationExceptionFilter, securityHeaders } = securityModule;
  const { AuthGuard } = guardModule;
  const { JobsService } = jobsServiceModule;
  const { AuthService } = authModule;
  const { authorizeAction } = authzModule;
  const { DeviceEventsService } = eventsModule;
  const { OrchestrationService } = orchestrationModule;

  // esbuild does not emit decorator metadata, so the harness names the constructor tokens.
  Reflect.defineMetadata(
    'design:paramtypes',
    [JobsService, AuthService, DeviceEventsService, OrchestrationService],
    JobsController,
  );

  auditEvents = [];
  startedFlows = [];
  const jobs = new JobsService({
    // The production service decides; each test names the rows that PostgreSQL answers.
    connection: {
      query: (text, values) => activeDb.connection.query(text, values),
    },
  });

  class ReconcileRouteModule {}
  Module({
    controllers: [JobsController],
    providers: [
      { provide: JobsService, useValue: jobs },
      {
        // The session and the audit store are test doubles. The permission decision,
        // `authorizeAction`, and the action selection in `requireReconcileActions` are real.
        provide: AuthService,
        useValue: {
          authorize: (value, action, resource, correlationId) =>
            authorizeAction(
              {
                phase: 3,
                audit: async (...entry) => auditEvents.push(entry),
              },
              value,
              action,
              resource,
              correlationId,
            ),
        },
      },
      { provide: DeviceEventsService, useValue: {} },
      {
        provide: OrchestrationService,
        useValue: {
          startDeviceUpdateReconcile: async (input) => {
            startedFlows.push(input);
            return 'execution';
          },
        },
      },
    ],
  })(ReconcileRouteModule);

  const moduleRef = await Test.createTestingModule({
    imports: [ReconcileRouteModule],
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

/** One request through the real route. */
async function reconcile(displayId) {
  const response = await fetch(
    `${origin}/api/jobs/${displayId}/operations/1/reconcile`,
    { method: 'POST' },
  );
  return {
    status: response.status,
    body: await response.json(),
    correlationId: response.headers.get('x-correlation-id'),
  };
}

/** Name one test's caller, rows, audit store, and flows. */
function arrange(db, actions) {
  activeDb = db;
  currentSession = session(actions);
  auditEvents = [];
  startedFlows = [];
}

test('the reconcile route answers 202 and the Deprovision operation with devices:deprovision', async () => {
  const db = reconcileDatabase();
  // The caller holds the read action and the Deprovision action only: neither devices:write
  // nor devices:status may be required for this operation.
  arrange(db, ['jobs:read', 'devices:deprovision']);

  const answer = await reconcile('STS-002');

  assert.equal(answer.status, 202);
  assert.deepEqual(answer.body, {
    operationId: 'STS-002-1',
    deviceId: 'device-1',
    serialNumber: 'C0A1-0001',
    orgUnitPath: '/Schools/A',
    field: null,
    operation: 'deprovision',
    baselineValue: null,
    requestedValue: 'DEPROVISIONED',
    outcome: 'unknown',
    outcomeReason: null,
    googleStatus: null,
    googleReason: null,
    observedValue: null,
    verifiedBy: null,
    commandId: null,
    commandState: null,
    commandExpiresAt: null,
    commandExecutedAt: null,
    updatedAt: '2026-10-21T12:00:00.000Z',
  });
  assert.equal(claimCount(db), 1, 'The accepted request claims the read-back.');
  assert.equal(startedFlows.length, 1, 'The accepted request starts one flow.');
  const [flow] = startedFlows;
  assert.equal(flow.customerId, CUSTOMER);
  assert.equal(flow.jobId, JOB_ID);
  assert.equal(flow.operationNumber, 1);
  assert.match(flow.verifyAttempt, /^[0-9a-f-]{36}$/);
  assert.equal(flow.correlationId, answer.correlationId);
  // No refusal reached the audit store.
  assert.deepEqual(auditEvents, []);
});

test('the reconcile route answers 403 without devices:deprovision and starts no flow', async () => {
  const db = reconcileDatabase();
  // The caller holds devices:status, which is the permission of the Disable and Re-enable
  // operations, and jobs:read. A Deprovision takes devices:deprovision.
  arrange(db, ['jobs:read', 'devices:status']);

  const answer = await reconcile('STS-002');

  assert.equal(answer.status, 403);
  assert.match(String(answer.body.message), /permission/);
  assert.equal(claimCount(db), 0, 'A refused request claims nothing.');
  assert.deepEqual(startedFlows, [], 'A refused request starts no flow.');
  // The production authorization records the refused action before it answers 403.
  assert.deepEqual(
    auditEvents.map((entry) => [entry[0], entry[3]]),
    [['access-denied', 'devices:deprovision']],
  );
});

test('the reconcile route answers 403 without jobs:read before it reads the job', async () => {
  const db = reconcileDatabase();
  arrange(db, ['devices:deprovision']);

  const answer = await reconcile('STS-002');

  assert.equal(answer.status, 403);
  assert.equal(
    db.calls.some(([text]) =>
      text.includes('p.display_name AS requested_by_name'),
    ),
    false,
    'The job read runs after the read check.',
  );
  assert.deepEqual(
    auditEvents.map((entry) => [entry[0], entry[3]]),
    [['access-denied', 'jobs:read']],
  );
  assert.deepEqual(startedFlows, []);
});

test('the reconcile route answers 409 reconcile-unsupported for Wipe user data', async () => {
  const db = reconcileDatabase(
    { kind: 'device-command', action: 'wipe-users', deprovision_reason: null },
    {
      action: 'wipe-users',
      mode: null,
      baseline_value: null,
      requested_value: null,
    },
  );
  // Every permission a caller could hold. The rule is the operation kind, not the grants.
  arrange(db, [
    'jobs:read',
    'devices:write',
    'devices:status',
    'devices:deprovision',
  ]);

  const answer = await reconcile('CMD-003');

  assert.equal(answer.status, 409);
  assert.deepEqual(answer.body, { reason: 'reconcile-unsupported' });
  assert.equal(claimCount(db), 0, 'A command operation claims nothing.');
  assert.deepEqual(startedFlows, [], 'A command operation starts no flow.');
});

test('the reconcile route answers 409 reconcile-unsupported for Powerwash', async () => {
  const db = reconcileDatabase(
    { kind: 'device-command', action: 'powerwash', deprovision_reason: null },
    {
      action: 'powerwash',
      mode: null,
      baseline_value: null,
      requested_value: null,
    },
  );
  arrange(db, [
    'jobs:read',
    'devices:write',
    'devices:status',
    'devices:deprovision',
  ]);

  const answer = await reconcile('CMD-004');

  assert.equal(answer.status, 409);
  assert.deepEqual(answer.body, { reason: 'reconcile-unsupported' });
  assert.equal(claimCount(db), 0, 'A command operation claims nothing.');
  assert.deepEqual(startedFlows, [], 'A command operation starts no flow.');
});

/** A database for one operations read: the connected customer, the header, and no operation. */
function operationsDatabase() {
  return database([
    ['cc.job_reader', [{ customer_id: CUSTOMER }]],
    [
      'p.display_name AS requested_by_name',
      [jobRow({ display_id: 'UPD-006', kind: 'device-update' })],
    ],
    ['FROM cc.device_update_operations o', []],
  ]);
}

test('the operations route reads at most ten operation numbers', async () => {
  const db = operationsDatabase();
  arrange(db, ['jobs:read']);
  const url = new URL(`${origin}/api/jobs/UPD-006/operations`);
  for (const number of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    url.searchParams.append('number', String(number));

  const answer = await fetch(url);

  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { operations: [], nextCursor: null });
  const [text, values] = db.calls.find(([sql]) =>
    sql.includes('FROM cc.device_update_operations o'),
  );
  // The repeated key reaches the statement as one array of numbers.
  assert.ok(text.includes('o.operation_number=ANY($10::integer[])'));
  assert.deepEqual(values[9], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  // An eleventh number answers 400 before the route reads the job.
  url.searchParams.append('number', '11');
  const before = db.calls.length;
  const refused = await fetch(url);
  assert.equal(refused.status, 400);
  assert.equal(db.calls.length, before, 'A refused query reads nothing.');
});
