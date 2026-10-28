import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import esbuild from 'esbuild';

/**
 * Node's type stripping does not transform the Nest decorators of the API sources. Compile the
 * `api/src` TypeScript for this test only, as `jobs-reconcile-route.test.mjs` does, so the real
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
const CORRELATION = '33333333-3333-4333-8333-333333333333';

/** One job header, with every column the header query selects. */
const jobRow = (overrides = {}) => ({
  job_id: JOB_ID,
  display_id: 'UPD-001',
  customer_id: CUSTOMER,
  kind: 'device-update',
  scope_kind: 'devices',
  status: 'running',
  requested_by: REQUESTER,
  requested_by_name: 'Ada Lovelace',
  generation: 1,
  target_count: 3,
  target_org_unit_paths: ['/Schools/A'],
  succeeded: 0,
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
  changed_at: new Date('2026-10-26T12:05:00.000Z'),
  correlation_id: CORRELATION,
  created_at: new Date('2026-10-26T12:00:00.000Z'),
  admitted_at: null,
  started_at: new Date('2026-10-26T12:00:00.000Z'),
  finished_at: null,
  confirmed_by: null,
  action: 'annotated-location',
  changes: null,
  deprovision_reason: null,
  confirmed_by_name: null,
  preview_display_id: null,
  ...overrides,
});

/** The stored request of a job that a person asked to cancel. */
const request = {
  cancel_requested_at: new Date('2026-10-26T12:06:00.000Z'),
  cancel_requested_by: REQUESTER,
  cancel_requested_by_name: 'Ada Lovelace',
};

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

/** A refusal of `cc.request_job_cancel`, as PostgreSQL raises it (design section 1). */
const refusal = (reason) =>
  Object.assign(new Error('The cancel was refused.'), {
    code: 'P0001',
    detail: reason,
  });

/** A database for one cancel: the connected customer, the function, and the summary. */
function cancelDatabase({ outcome = 'requested', row = {}, error } = {}) {
  return database([
    ['cc.job_reader', [{ customer_id: CUSTOMER }]],
    [
      'cc.request_job_cancel',
      () => {
        if (error) throw error;
        return [{ result: { outcome } }];
      },
    ],
    ['p.display_name AS requested_by_name', [jobRow(row)]],
  ]);
}

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
  expiresAt: '2026-10-27T13:00:00.000Z',
  csrfToken: 'a'.repeat(64),
});

let app;
let origin;
/** The signed-in caller of the next request. */
let currentSession;
/** The database behind the production JobsService. */
let activeDb;
/** The audit rows that the production authorization wrote. */
let auditEvents;

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
  const jobs = new JobsService({
    // The production service decides; each test names the rows that PostgreSQL answers.
    connection: {
      query: (text, values) => activeDb.connection.query(text, values),
    },
  });

  class CancelRouteModule {}
  Module({
    controllers: [JobsController],
    providers: [
      { provide: JobsService, useValue: jobs },
      {
        // The session and the audit store are test doubles. The permission decision,
        // `authorizeAction`, and the guard are real.
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
          startDeviceUpdateReconcile: async () => 'execution',
        },
      },
    ],
  })(CancelRouteModule);

  const moduleRef = await Test.createTestingModule({
    imports: [CancelRouteModule],
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

/** One cancel request through the real route. */
async function cancel(displayId = 'UPD-001', body) {
  const response = await fetch(`${origin}/api/jobs/${displayId}/cancel`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  return {
    status: response.status,
    body: await response.json(),
    correlationId: response.headers.get('x-correlation-id'),
  };
}

/** Name one test's caller, rows, and audit store. */
function arrange(db, actions) {
  activeDb = db;
  currentSession = session(actions);
  auditEvents = [];
}

const statements = (db, needle) =>
  db.calls.filter(([text]) => text.includes(needle));

test('the cancel route answers 200 with the summary and passes the actor and permission version', async () => {
  const db = cancelDatabase({
    row: {
      status: 'cancelled',
      cancelled: 3,
      finished_at: new Date('2026-10-26T12:06:01.000Z'),
      revision: 5,
      ...request,
    },
  });
  arrange(db, ['jobs:read']);

  const answer = await cancel();

  assert.equal(answer.status, 200);
  assert.equal(answer.body.displayId, 'UPD-001');
  assert.equal(answer.body.status, 'cancelled');
  assert.equal(answer.body.revision, 5);
  assert.deepEqual(answer.body.progress, {
    total: 3,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 3,
    pending: 0,
  });
  assert.deepEqual(answer.body.cancelRequest, {
    at: '2026-10-26T12:06:00.000Z',
    by: { id: REQUESTER, displayName: 'Ada Lovelace' },
  });
  // The SQL function decides. The route passes the caller, its permission version, the customer,
  // the display ID, and the request's correlation ID.
  const [call] = statements(db, 'cc.request_job_cancel');
  assert.deepEqual(call[1], [
    ACTOR,
    1,
    CUSTOMER,
    'UPD-001',
    answer.correlationId,
  ]);
  // One request writes one audit row, and the SQL function writes it.
  assert.equal(statements(db, 'cc.request_job_cancel').length, 1);
  assert.deepEqual(auditEvents, []);
});

test('each cancel refusal answers its status and reason and reads no summary', async () => {
  const cases = [
    ['job-not-found', 404],
    ['cancel-not-permitted', 403],
    ['job-finished', 409],
    ['nothing-to-stop', 409],
  ];
  for (const [reason, status] of cases) {
    const db = cancelDatabase({ error: refusal(reason) });
    arrange(db, ['jobs:read']);

    const answer = await cancel();

    assert.equal(answer.status, status, reason);
    assert.deepEqual(answer.body, { reason }, reason);
    assert.equal(
      statements(db, 'p.display_name AS requested_by_name').length,
      0,
      `A ${reason} refusal reads no summary.`,
    );
    assert.deepEqual(
      auditEvents,
      [],
      `A ${reason} refusal writes no audit row.`,
    );
  }
});

test('a repeated request answers 200 with the current summary and writes one audit row', async () => {
  const db = cancelDatabase({
    outcome: 'repeated',
    row: {
      status: 'cancelled',
      cancelled: 2,
      finished_at: new Date('2026-10-26T12:07:00.000Z'),
      ...request,
    },
  });
  arrange(db, ['jobs:read']);

  const answer = await cancel();

  assert.equal(answer.status, 200);
  assert.equal(answer.body.status, 'cancelled');
  assert.deepEqual(answer.body.cancelRequest, {
    at: '2026-10-26T12:06:00.000Z',
    by: { id: REQUESTER, displayName: 'Ada Lovelace' },
  });
  // The second request is the same statement, so the SQL function keeps the first audit row and
  // answers `repeated`. The API writes none of its own.
  assert.equal(statements(db, 'cc.request_job_cancel').length, 1);
  assert.deepEqual(auditEvents, []);
});

test('a jobs:manage-only principal cancels the job of another person', async () => {
  const db = cancelDatabase({
    row: {
      status: 'cancelled',
      cancelled: 1,
      finished_at: new Date('2026-10-26T12:06:30.000Z'),
      ...request,
      cancel_requested_by: ACTOR,
      cancel_requested_by_name: 'Grace Hopper',
    },
  });
  // No jobs:read and no devices action: the manage grant carries the job read (record default 16).
  arrange(db, ['jobs:manage']);

  const answer = await cancel();

  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.cancelRequest, {
    at: '2026-10-26T12:06:00.000Z',
    by: { id: ACTOR, displayName: 'Grace Hopper' },
  });
  // The manager cancels another person's job: the job's requester is not the caller.
  assert.equal(answer.body.requestedBy.id, REQUESTER);
  // The route refuses nothing and records no access-denied row. The SQL function decides.
  assert.deepEqual(auditEvents, []);
  assert.deepEqual(statements(db, 'cc.request_job_cancel')[0][1].slice(0, 2), [
    ACTOR,
    1,
  ]);
});

test('a cancel request with a body answers 400 and calls no function', async () => {
  const db = cancelDatabase();
  arrange(db, ['jobs:read']);

  const answer = await cancel('UPD-001', { revision: 4 });

  assert.equal(answer.status, 400);
  assert.equal(answer.body.code, 'invalid-request');
  assert.equal(statements(db, 'cc.request_job_cancel').length, 0);
});

test('the cancel route answers 400 for a display ID of another shape', async () => {
  const db = cancelDatabase();
  arrange(db, ['jobs:read']);

  const answer = await cancel('UPD-1');

  assert.equal(answer.status, 400);
  assert.equal(answer.body.code, 'invalid-request');
  assert.equal(statements(db, 'cc.job_reader').length, 0);
});
