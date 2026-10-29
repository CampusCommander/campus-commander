import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import esbuild from 'esbuild';
import {
  DEVICE_EDIT_TEMPLATE_HEADERS,
  createCsvReader,
  deviceEditEscapeCell,
  deviceEditUnescapeCell,
} from '@campus/application-contracts';

/**
 * The import routes of the device export and import workflow (design section 1, card XB9). The
 * suite runs the real controller, the real import service, the real `AuthGuard`, and the real
 * exception filter against a fake database, store, and flow starter, so every status, refusal, and
 * permission is the route's own answer.
 *
 * The guard is not stubbed: the upload passes `text/csv` and every other route refuses it, and the
 * origin and CSRF checks run on each request, as they do in production.
 *
 * The database double applies the bind rule of PostgreSQL, so a statement that names fewer
 * parameters than the route supplies fails here. It reads each page from the statement's own LIMIT
 * and OFFSET clause and orders the rows that the statement orders.
 *
 * `device-actions-route.test.mjs` compiles the TypeScript the same way, because Node's type
 * stripping does not transform the Nest decorators.
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
const { ForbiddenException, Module } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { Reflector } = require('@nestjs/core');

const customer = 'C0123456';
const otherCustomer = 'C0654321';
const actor = '11111111-1111-4111-8111-111111111111';
const jobId = '44444444-4444-4444-8444-444444444444';
const newJobId = '55555555-5555-4555-8555-555555555555';
const planId = '66666666-6666-4666-8666-666666666666';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/**
 * A fixture time relative to the clock of the run. The plan lifetime is one hour and the file
 * retention is 30 days, so an absolute date would refuse its own fixtures after that date.
 */
const at = (offsetMs = 0) => new Date(Date.now() + offsetMs);

/**
 * The value that one SQL clause binds. The double reads the page from the statement itself, so a
 * page clause that binds no parameter answers no page.
 */
function clauseValue(text, clause, values) {
  const match = new RegExp(`${clause} \\$(\\d+)`).exec(text);
  assert.ok(match, `The statement binds its ${clause}: ${text}`);
  return values[Number(match[1]) - 1];
}

/**
 * The bind rule of PostgreSQL: one value for each named parameter, with no gap. A statement that
 * names two parameters and supplies four values is refused with `08P01`, so the double refuses it
 * too instead of hiding the defect.
 */
function assertBound(text, values) {
  const named = new Set();
  for (const match of text.matchAll(/\$(\d+)/g)) named.add(Number(match[1]));
  const highest = Math.max(0, ...named);
  assert.equal(
    values.length,
    highest,
    `The statement binds ${values.length} values for ${highest} parameters: ${text}`,
  );
  for (let index = 1; index <= highest; index += 1)
    assert.ok(named.has(index), `The statement skips parameter $${index}.`);
}

const session = {
  identity: {
    id: actor,
    displayName: 'Test person',
    permissions: [],
    permissionVersion: 7,
    grants: [],
    preferences: {},
  },
  expiresAt: at(HOUR).toISOString(),
  csrfToken: 'a'.repeat(64),
};

const connected = { customerId: customer, generation: 3 };
const csv = Buffer.from(
  'Device ID,Serial number\r\nabc,SN-abc\r\ndef,SN-def\r\n',
);
/** The plan of a job row, as the job statement answers it. */
const plan = (overrides = {}) => ({
  planId,
  revision: 1,
  state: 'open',
  expiresAt: at(HOUR).toISOString(),
  changedBy: null,
  changedAt: null,
  ...overrides,
});
/**
 * The plan of `cc.cancel_device_import_plan`, as the function builds it: `changedBy` is the
 * principal ID of the actor, never a person object (017-jobs.sql).
 */
const sqlPlan = (overrides = {}) => ({
  planId,
  revision: 1,
  state: 'open',
  expiresAt: at(HOUR).toISOString(),
  changedBy: null,
  changedAt: null,
  ...overrides,
});

let app;
let origin;
/** The action checks that the route ran, in order. */
let checks;
/** The actions that the signed-in person holds in the current test. */
let allowed;
/** The session grants of the current test. */
let grants;
/** Header checks that the guard refused, by correlation ID. */
let denied;
/** The recorded SQL statements and their values. */
let statements;
/** The validation jobs that the routes may answer, by display ID. */
let jobs;
/** The ready artifacts by job ID. */
let artifacts;
/** The report tables of the current test. */
let report;
/** The recorded store stages, discards, and flow starts. */
let stages;
let discarded;
let starts;
/** The create-function answer of the current test. */
let createResult;
/** Whether the create statement runs and then loses its answer. */
let createThrows;
/** The plan-cancel-function answer of the current test. */
let cancelResult;
/** The application principals that the plan lookup answers. */
let people;
/** Whether the store refuses a stage. */
let stageFails;
/** Whether the flow starter refuses. */
let startFails;
/** The probe of the streaming upload test. */
let probe;

const statusGrant = (action) => ({
  action: action === 'deprovision' ? 'devices:deprovision' : 'devices:status',
  scope: { kind: 'district', customerId: customer },
});

before(async () => {
  const [
    controllerModule,
    serviceModule,
    executeModule,
    devicesModule,
    authModule,
    guardModule,
    securityModule,
  ] = await Promise.all([
    import('./device-imports.controller.ts'),
    import('./device-imports.service.ts'),
    import('./device-import-execute.service.ts'),
    import('./devices.service.ts'),
    import('../auth/auth.service.ts'),
    import('../auth/auth.guard.ts'),
    import('../security.ts'),
  ]);
  const { DeviceImportsController } = controllerModule;
  const { DeviceImportsService } = serviceModule;
  const { DeviceImportExecuteService } = executeModule;
  const { DevicesService } = devicesModule;
  const { AuthService } = authModule;
  const { AuthGuard } = guardModule;
  const { ApplicationExceptionFilter, securityHeaders } = securityModule;

  checks = [];
  allowed = new Set();
  grants = [];
  denied = [];
  statements = [];
  jobs = new Map();
  artifacts = new Map();
  people = new Map();
  stages = [];
  discarded = [];
  starts = [];

  const answer = (text, values) => {
    if (text.includes('cc.create_device_import_job')) {
      // The statement runs, then its answer is lost: the job may already be committed.
      if (createThrows) throw new Error('The connection dropped the answer.');
      return { rows: [{ result: createResult }] };
    }
    if (text.includes('cc.cancel_device_import_plan'))
      return { rows: [{ result: cancelResult }] };
    if (text.includes('FROM cc.jobs j JOIN cc.device_import_jobs i')) {
      const [, , requestedCustomer, displayId] = values;
      const job = jobs.get(displayId);
      // The statement filters the customer itself, so a foreign job answers no row.
      if (!job || job.customerId !== requestedCustomer) return { rows: [] };
      return { rows: [jobRow(job)] };
    }
    if (text.includes('FROM cc.artifacts a')) {
      const artifact = artifacts.get(values[0]);
      return { rows: artifact ? [artifact] : [] };
    }
    if (text.includes('cc.application_principals p WHERE p.id=$1')) {
      const person = people.get(values[0]);
      return { rows: person ? [person] : [] };
    }
    if (text.includes('count(*)::integer AS total')) {
      if (text.includes('o.status=ANY('))
        return {
          rows: [
            {
              total: report.changes.filter((row) =>
                values[1].includes(row.operation_status),
              ).length,
            },
          ],
        };
      if (text.includes('FROM cc.device_import_rejections'))
        return { rows: [{ total: report.rejections.length }] };
      if (text.includes('FROM cc.device_import_warnings'))
        return { rows: [{ total: report.warnings.length }] };
      return { rows: [{ total: report.changes.length }] };
    }
    if (text.includes('field_changes')) return { rows: [report.summary] };
    if (text.includes('FROM cc.device_import_changes c')) {
      const limit = clauseValue(text, 'LIMIT', values);
      const offset = clauseValue(text, 'OFFSET', values);
      assert.match(
        text,
        /ORDER BY c\.source_row,c\.ordinal/,
        'A change page is ordered by source row and ordinal.',
      );
      const outcomes = /ANY\(\$(\d+)/.exec(text);
      const rows = outcomes
        ? report.changes.filter((row) =>
            values[Number(outcomes[1]) - 1].includes(row.operation_status),
          )
        : report.changes;
      return {
        rows: [...rows]
          .sort(
            (left, right) =>
              left.source_row - right.source_row ||
              left.ordinal - right.ordinal,
          )
          .slice(offset, offset + limit),
      };
    }
    if (text.includes('string_agg(r.reason'))
      return { rows: report.fileRows.slice(values[2], values[2] + values[1]) };
    if (text.includes('FROM cc.device_import_rejections r'))
      return {
        rows: report.rejections.slice(values[2], values[2] + values[1]),
      };
    if (text.includes('FROM cc.device_import_warnings w'))
      return { rows: report.warnings.slice(values[2], values[2] + values[1]) };
    throw new Error(`The test answered no statement: ${text}`);
  };

  const database = {
    connection: {
      query: async (text, values = []) => {
        statements.push({ text, values });
        assertBound(text, values);
        return answer(text, values);
      },
    },
  };
  const storage = {
    stageUpload: async (source) => {
      stages.push({ at: Date.now() });
      if (stageFails) throw new Error('The store is unavailable.');
      assert.equal(
        typeof source?.[Symbol.asyncIterator],
        'function',
        'The route hands the store an async iterable, never a buffer.',
      );
      const chunks = [];
      for await (const chunk of source) {
        if (chunks.length === 0 && probe) {
          probe.firstChunkBeforeBodyEnd = !probe.bodyEnded;
          probe.firstChunk.resolve();
        }
        chunks.push(chunk);
      }
      return {
        artifactId: 'artifact-IMP-001',
        attemptId: 'attempt-IMP-001',
        sizeBytes: Buffer.concat(chunks).length,
        sha256: 'a'.repeat(64),
      };
    },
    discardUpload: async (descriptor) => {
      discarded.push(descriptor);
      return true;
    },
  };
  const orchestration = {
    startDeviceImport: async (input) => {
      if (startFails) throw new Error('The flow refused the start.');
      starts.push(input);
      return 'execution-1';
    },
  };
  const devices = {
    sync: async () => {
      // `cc.read_device_sync` refuses a caller without devices:read.
      if (!allowed.has('devices:read'))
        throw new ForbiddenException({ reason: 'forbidden' });
      return connected;
    },
  };
  const auth = {
    authenticate: async () => session,
    recordDeniedRequest: async (correlationId, actorId) => {
      denied.push({ correlationId, actorId });
    },
    authorize: async (_session, action) => {
      checks.push(action);
      if (!allowed.has(action))
        throw new ForbiddenException(
          'This action requires additional permission.',
        );
    },
  };
  // The guard reads the public origin from the configuration. The app listens on a free port, so
  // the origin becomes known after `listen`.
  const configuration = {
    auth: {
      get publicOrigin() {
        return origin;
      },
    },
  };
  const guard = new AuthGuard(auth, new Reflector(), configuration);

  // esbuild emits no decorator metadata, so the harness names the constructor tokens.
  Reflect.defineMetadata(
    'design:paramtypes',
    [
      DevicesService,
      DeviceImportsService,
      DeviceImportExecuteService,
      AuthService,
    ],
    DeviceImportsController,
  );

  class ImportRoutesModule {}
  Module({
    controllers: [DeviceImportsController],
    providers: [
      { provide: DevicesService, useValue: devices },
      {
        provide: DeviceImportsService,
        useValue: new DeviceImportsService(database, storage, orchestration),
      },
      {
        provide: DeviceImportExecuteService,
        useValue: new DeviceImportExecuteService(database, storage, {
          admit: async () => true,
        }),
      },
      { provide: AuthService, useValue: auth },
    ],
  })(ImportRoutesModule);

  const moduleRef = await Test.createTestingModule({
    imports: [ImportRoutesModule],
  })
    .overrideGuard(AuthGuard)
    .useValue(guard)
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

const importActions = ['devices:read', 'devices:write', 'devices:bulk-actions'];

/** Reset every stub to one granted person and one completed job with a report. */
function reset({
  actions = importActions,
  statusActions = ['disable', 'reenable', 'deprovision'],
} = {}) {
  checks = [];
  allowed = new Set(actions);
  grants = statusActions.map(statusGrant);
  denied = [];
  statements = [];
  jobs = new Map();
  artifacts = new Map();
  people = new Map([[actor, { id: actor, display_name: 'Test person' }]]);
  stages = [];
  discarded = [];
  starts = [];
  probe = undefined;
  stageFails = false;
  createThrows = false;
  startFails = false;
  report = {
    summary: {
      field_changes: 1,
      field_change_devices: 1,
      disable: 0,
      reenable: 0,
      deprovision: [],
    },
    changes: [changeRow()],
    rejections: [],
    warnings: [],
    fileRows: [],
  };
  createResult = {
    outcome: 'created',
    receipt: {
      jobId,
      displayId: 'IMP-001',
      status: 'accepted',
      mode: 'sync-changes',
      name: 'devices.csv',
      sizeBytes: csv.length,
    },
  };
  cancelResult = {
    outcome: 'cancelled',
    plan: sqlPlan({
      revision: 2,
      state: 'cancelled',
      changedBy: actor,
      changedAt: at().toISOString(),
    }),
  };
  session.identity.grants = grants;
}

/** One completed validation job that the routes may answer. */
function importJob(overrides = {}) {
  return {
    customerId: customer,
    status: 'completed',
    visible: true,
    mode: 'sync-changes',
    sourceName: 'devices.csv',
    sourceSizeBytes: 2048,
    rowsRead: 1,
    unchanged: 0,
    noChangeNeeded: 0,
    proposed: 1,
    rejected: 0,
    staleDevicesRead: 2,
    oldestObservedAt: at(-HOUR),
    job: plan(),
    ...overrides,
  };
}

function jobRow(job) {
  const stored = job.job;
  return {
    job_id: job.jobId ?? jobId,
    display_id: job.displayId ?? 'IMP-001',
    status: job.status,
    mode: job.mode,
    source_name: job.sourceName,
    source_size_bytes: String(job.sourceSizeBytes),
    rows_read: job.rowsRead,
    unchanged: job.unchanged,
    no_change_needed: job.noChangeNeeded,
    proposed: job.proposed,
    rejected: job.rejected,
    stale_devices_read: job.staleDevicesRead,
    oldest_observed_at: job.oldestObservedAt,
    plan_id: stored?.planId ?? null,
    plan_revision: stored?.revision ?? null,
    plan_state: stored?.state ?? null,
    plan_expires_at: stored?.expiresAt ?? null,
    plan_changed_at: stored?.changedAt ?? null,
    plan_changed_by_id: stored?.changedBy?.id ?? null,
    plan_changed_by_name: stored?.changedBy?.displayName ?? null,
    visible: job.visible,
  };
}

/** One change line of the report, joined with its device and operation. */
function changeRow(overrides = {}) {
  return {
    source_row: 2,
    ordinal: 1,
    device_id: 'dev-1',
    serial_number: 'SN-dev-1',
    change_type: 'field',
    field: 'notes',
    mode: 'replace',
    status_action: null,
    deprovision_reason: null,
    current_value: 'old',
    new_value: 'new',
    not_run_reason: null,
    linked_display_id: null,
    operation_number: null,
    operation_status: null,
    ...overrides,
  };
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      origin,
      'x-csrf-token': session.csrfToken,
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A CSV answer stays text.
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

/** One JSON POST of the import routes. */
async function post(path, payload, headers = {}) {
  return request(path, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** One raw CSV upload. */
async function upload(path, body) {
  return request(path, {
    method: 'POST',
    body,
    headers: { 'content-type': 'text/csv' },
  });
}

const uploadPath = '/api/devices/imports?mode=sync-changes&name=devices.csv';
const statementCount = () => statements.length;
const createStatement = () =>
  statements.find((statement) =>
    statement.text.includes('cc.create_device_import_job'),
  );

test('an upload streams the file into the store and creates its job', async () => {
  reset();
  const answer = await upload(uploadPath, csv);
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, {
    jobId,
    displayId: 'IMP-001',
    status: 'accepted',
    mode: 'sync-changes',
    name: 'devices.csv',
    sizeBytes: csv.length,
  });
  assert.deepEqual(
    checks,
    ['devices:read', 'devices:write', 'devices:bulk-actions'],
    'The route checks the three import actions in order.',
  );
  assert.equal(stages.length, 1, 'The route stages the file once.');
  const create = createStatement();
  assert.ok(create, 'The route creates the job.');
  assert.equal(create.values[2], customer);
  assert.equal(create.values[3], 'sync-changes');
  assert.equal(create.values[4], 'csv');
  assert.equal(create.values[5], 'devices.csv');
  assert.equal(create.values[6], csv.length, 'The job takes the staged size.');
  assert.deepEqual(
    create.values[7],
    ['disable', 'reenable', 'deprovision'],
    'The job records the status permissions that the requester holds.',
  );
  assert.match(
    create.values[8],
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'The job carries the correlation ID of the request.',
  );
  assert.equal(
    create.values[9],
    'artifact-IMP-001',
    'The job creation links the staged artifact.',
  );
  assert.equal(starts.length, 1, 'The route starts one flow run.');
  assert.equal(starts[0].customerId, customer);
  assert.equal(starts[0].jobId, jobId);
  assert.match(
    starts[0].leaseId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(starts[0].correlationId, create.values[8]);
});

test('the upload hands the store each chunk while the body is still sending', async () => {
  reset();
  probe = {
    bodyEnded: false,
    firstChunkBeforeBodyEnd: null,
    firstChunk: Promise.withResolvers(),
  };
  const first = Buffer.from('Device ID,Serial number\r\n');
  const second = Buffer.from('dev-1,SN-1\r\n');
  const body = (async function* () {
    yield first;
    // The store must answer the first chunk before this generator can produce the rest. If the
    // route buffered the body first, the deadline passes and the flag below stays false.
    const deadline = setTimeout(() => probe.firstChunk.resolve(), 2000);
    await probe.firstChunk.promise;
    clearTimeout(deadline);
    probe.bodyEnded = true;
    yield second;
  })();
  const response = await fetch(`${origin}${uploadPath}`, {
    method: 'POST',
    headers: {
      origin,
      'x-csrf-token': session.csrfToken,
      'content-type': 'text/csv',
    },
    body,
    duplex: 'half',
  });
  const answer = await response.json();
  assert.equal(response.status, 201, JSON.stringify(answer));
  assert.equal(
    probe.firstChunkBeforeBodyEnd,
    true,
    'The store received the first chunk before the request body ended.',
  );
  assert.equal(probe.bodyEnded, true, 'The body finished sending.');
  assert.equal(
    createStatement().values[6],
    first.length + second.length,
    'The job takes the size that the store counted.',
  );
});

test('the guard accepts text/csv on the upload only', async () => {
  reset();
  // A JSON body to the upload is refused: the route names text/csv alone.
  const json = await post(uploadPath, {});
  assert.equal(json.status, 403, JSON.stringify(json.body));
  assert.equal(stages.length, 0, 'A refused body never reaches the store.');
  assert.equal(denied.length, 1, 'The refusal is recorded.');

  // Every other route keeps the JSON-only rule, so a text/csv body is refused there.
  reset();
  const other = await request('/api/devices/imports/IMP-001/cancel', {
    method: 'POST',
    body: Buffer.from('Device ID\r\n'),
    headers: { 'content-type': 'text/csv' },
  });
  assert.equal(other.status, 403, JSON.stringify(other.body));
  assert.deepEqual(checks, [], 'The guard refuses before any person check.');
});

test('the upload keeps the origin and CSRF checks', async () => {
  reset();
  const noOrigin = await fetch(`${origin}${uploadPath}`, {
    method: 'POST',
    headers: { 'x-csrf-token': session.csrfToken, 'content-type': 'text/csv' },
    body: csv,
  });
  assert.equal(noOrigin.status, 403);
  const wrongToken = await fetch(`${origin}${uploadPath}`, {
    method: 'POST',
    headers: {
      origin,
      'x-csrf-token': 'b'.repeat(64),
      'content-type': 'text/csv',
    },
    body: csv,
  });
  assert.equal(wrongToken.status, 403);
  assert.equal(stages.length, 0, 'A refused request never reaches the store.');
  assert.equal(denied.length, 2, 'Each refusal is recorded.');
});

test('a person without devices:bulk-actions receives 403 and stores nothing', async () => {
  reset({ actions: ['devices:read', 'devices:write'] });
  const answer = await upload(uploadPath, csv);
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.deepEqual(checks, [
    'devices:read',
    'devices:write',
    'devices:bulk-actions',
  ]);
  assert.equal(stages.length, 0);
  assert.equal(starts.length, 0);
});

test('a person without devices:read receives 403 before any action check', async () => {
  reset({ actions: ['devices:write', 'devices:bulk-actions'] });
  const answer = await upload(uploadPath, csv);
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.deepEqual(checks, [], 'The read refusal precedes every action check.');
  assert.equal(stages.length, 0);
});

test('the job records only the status permissions of the requester', async () => {
  reset({ statusActions: ['disable', 'reenable'] });
  const answer = await upload(uploadPath, csv);
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.deepEqual(
    createStatement().values[7],
    ['disable', 'reenable'],
    'A status action without its permission never reaches the job row.',
  );
});

test('an invalid upload query answers 400 before any store write', async () => {
  reset();
  for (const path of [
    '/api/devices/imports?name=devices.csv',
    '/api/devices/imports?mode=wrong&name=devices.csv',
    '/api/devices/imports?mode=sync-changes',
    '/api/devices/imports?mode=sync-changes&name=devices.csv&extra=1',
  ]) {
    const answer = await upload(path, csv);
    assert.equal(answer.status, 400, `${path}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.reason, 'invalid-import');
  }
  assert.deepEqual(checks, []);
  assert.equal(stages.length, 0);
});

test('a storage fault answers 503 and creates no job', async () => {
  reset();
  stageFails = true;
  const answer = await upload(uploadPath, csv);
  assert.equal(answer.status, 503, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'storage-unavailable' });
  assert.equal(createStatement(), undefined);
  assert.equal(starts.length, 0);
});

test('a lost create answer keeps the staged file that a committed job may own', async () => {
  reset();
  // The create statement runs and its transaction may commit. Its answer never arrives.
  createThrows = true;
  const answer = await upload(uploadPath, csv);
  assert.equal(answer.status, 503, JSON.stringify(answer.body));
  assert.equal(
    createStatement()?.values[9],
    'artifact-IMP-001',
    'The create ran with the staged file.',
  );
  assert.equal(
    discarded.length,
    0,
    'An uncertain create never deletes the file that its committed job owns.',
  );
  assert.equal(starts.length, 0, 'An unanswered create starts no flow.');
});

test('a create that answers no result keeps the staged file', async () => {
  reset();
  createResult = undefined;
  const answer = await upload(uploadPath, csv);
  assert.equal(answer.status, 503, JSON.stringify(answer.body));
  assert.equal(
    discarded.length,
    0,
    'A missing answer is not a confirmed refusal.',
  );
  assert.equal(starts.length, 0);
});

test('an unrecognized create outcome keeps the staged file', async () => {
  reset();
  createResult = { outcome: 'unexpected' };
  const answer = await upload(uploadPath, csv);
  assert.equal(answer.status, 503, JSON.stringify(answer.body));
  assert.equal(
    discarded.length,
    0,
    'An outcome that the route cannot read may hold a committed job.',
  );
});

test('a refused create removes the staged file', async () => {
  reset();
  createResult = { outcome: 'forbidden' };
  const answer = await upload(uploadPath, csv);
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.equal(discarded.length, 1, 'The refused upload leaves no file.');
  assert.equal(discarded[0].artifactId, 'artifact-IMP-001');
  assert.equal(starts.length, 0);
});

test('a create that names no file answers 410 and removes the staged file', async () => {
  reset();
  createResult = { outcome: 'artifact-unavailable' };
  const answer = await upload(uploadPath, csv);
  assert.equal(answer.status, 410, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'source-expired' });
  assert.equal(discarded.length, 1);
});

test('a refused flow start still answers the receipt', async () => {
  reset();
  startFails = true;
  const answer = await upload(uploadPath, csv);
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(answer.body.displayId, 'IMP-001');
  assert.equal(starts.length, 0, 'The starter recorded no run.');
  assert.equal(discarded.length, 0, 'A created job keeps its file.');
});

test('the report answers the counts, the change line, and the plan', async () => {
  reset();
  const job = importJob();
  jobs.set('IMP-001', job);
  const answer = await request('/api/devices/imports/IMP-001/report');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body.counts, {
    rows: 1,
    unchanged: 0,
    noChangeNeeded: 0,
    proposed: 1,
    rejected: 0,
  });
  assert.equal(answer.body.view, 'proposed');
  assert.equal(answer.body.page, 0);
  assert.equal(answer.body.pageCount, 1);
  assert.equal(answer.body.total, 1);
  assert.equal(answer.body.refresh.staleDevicesRead, 2);
  assert.equal(
    answer.body.refresh.oldestObservedAt,
    new Date(job.oldestObservedAt).toISOString(),
  );
  assert.deepEqual(answer.body.changes, {
    fieldChanges: 1,
    fieldChangeDevices: 1,
    disable: 0,
    reenable: 0,
    deprovision: [],
  });
  assert.deepEqual(answer.body.lines, [
    {
      row: 2,
      deviceId: 'dev-1',
      serialNumber: 'SN-dev-1',
      change: {
        type: 'field',
        field: 'notes',
        operation: 'replace',
        currentValue: 'old',
        newValue: 'new',
      },
      column: null,
      submittedValue: null,
      reason: null,
      notRun: null,
      jobDisplayId: null,
      operationNumber: null,
      outcome: null,
    },
  ]);
  assert.deepEqual(answer.body.plan, job.job);
});

test('a status change names its action and its reason', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  report.changes = [
    changeRow({
      source_row: 4,
      change_type: 'status',
      field: null,
      mode: null,
      status_action: 'deprovision',
      deprovision_reason: 'DEPROVISION_REASON_RETIRING_DEVICE',
      current_value: 'ACTIVE',
      new_value: 'DEPROVISIONED',
    }),
  ];
  const answer = await request('/api/devices/imports/IMP-001/report');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body.lines[0].change, {
    type: 'status',
    action: 'deprovision',
    reason: 'DEPROVISION_REASON_RETIRING_DEVICE',
    currentValue: 'ACTIVE',
    newValue: 'DEPROVISIONED',
  });
});

test('a proposed line after Execute names its job, operation, and outcome', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  report.changes = [
    changeRow({
      linked_display_id: 'UPD-001',
      operation_number: 3,
      operation_status: 'dispatched',
    }),
    changeRow({
      source_row: 3,
      not_run_reason: 'changed-after-validation',
      current_value: 'a',
      new_value: 'b',
    }),
  ];
  const answer = await request('/api/devices/imports/IMP-001/report');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.lines[0].jobDisplayId, 'UPD-001');
  assert.equal(answer.body.lines[0].operationNumber, 3);
  assert.equal(
    answer.body.lines[0].outcome,
    'pending',
    'A dispatched operation reads pending.',
  );
  assert.deepEqual(answer.body.lines[1].notRun, {
    reason: 'changed-after-validation',
    text: 'Value changed after validation',
  });
  assert.equal(answer.body.lines[1].jobDisplayId, null);
});

test('the failed view lists one change of each outcome and only the failed ones', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  const outcomes = [
    'succeeded',
    'failed',
    'unknown',
    'skipped',
    'expired',
    'cancelled',
    'pending',
    'dispatched',
    'issued',
  ];
  report.changes = outcomes.map((status, index) =>
    changeRow({
      source_row: index + 2,
      linked_display_id: 'UPD-001',
      operation_number: index + 1,
      operation_status: status,
    }),
  );
  // A change that no operation ran never joins the failed view.
  report.changes.push(
    changeRow({
      source_row: 20,
      not_run_reason: 'no-change-needed',
    }),
  );
  const answer = await request(
    '/api/devices/imports/IMP-001/report?view=failed',
  );
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(
    answer.body.total,
    2,
    'The failed total counts the failed and unknown outcomes.',
  );
  assert.deepEqual(
    answer.body.lines.map((line) => [line.row, line.outcome]),
    [
      [3, 'failed'],
      [4, 'unknown'],
    ],
  );
  const failed = statements
    .filter((statement) => statement.text.includes('o.status=ANY('))
    .at(-1);
  assert.deepEqual(
    failed.values[4],
    ['failed', 'unknown'],
    'The failed view passes the outcomes of its constant.',
  );
  assert.equal(
    report.changes.filter((row) => row.not_run_reason !== null).length,
    1,
    'The not-run fixture stays out of the failed lines.',
  );
  assert.equal(
    answer.body.lines.some((line) => line.notRun !== null),
    false,
  );
});

test('a page past the last page answers the last page', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  report.changes = Array.from({ length: 25 }, (_, index) =>
    changeRow({ source_row: index + 2 }),
  );
  const answer = await request('/api/devices/imports/IMP-001/report?page=9');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.page, 2);
  assert.equal(answer.body.pageCount, 3);
  assert.equal(answer.body.total, 25);
  assert.equal(answer.body.lines.length, 5);
  const page = statements.find((statement) =>
    statement.text.includes('FROM cc.device_import_changes c'),
  );
  assert.equal(page.values[3], 20, 'The last page reads its own offset.');
});

test('a proposed page holds ten ordered lines and keeps the links of a later page', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  // The rows arrive in another order, as a heap read does. The statement must order them.
  report.changes = [12, 3, 10, 1, 8, 5, 11, 2, 9, 4, 7, 6].map((row, index) =>
    changeRow({
      source_row: row,
      ordinal: index + 1,
      linked_display_id: row > 10 ? 'UPD-001' : null,
      operation_number: row > 10 ? row : null,
      operation_status: row > 10 ? 'failed' : null,
    }),
  );
  const first = await request('/api/devices/imports/IMP-001/report?page=0');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.total, 12);
  assert.equal(first.body.pageCount, 2);
  assert.equal(first.body.lines.length, 10, 'A page holds ten lines at most.');
  assert.deepEqual(
    first.body.lines.map((line) => line.row),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    'The page is ordered by source row.',
  );
  const second = await request('/api/devices/imports/IMP-001/report?page=1');
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.page, 1);
  assert.deepEqual(
    second.body.lines.map((line) => line.row),
    [11, 12],
  );
  for (const line of second.body.lines) {
    assert.equal(line.jobDisplayId, 'UPD-001');
    assert.equal(line.operationNumber, line.row);
    assert.equal(
      line.outcome,
      'failed',
      'A post-Execute line keeps its outcome on a later page.',
    );
  }
  const page = statements
    .filter((statement) =>
      statement.text.includes('FROM cc.device_import_changes c'),
    )
    .at(-1);
  assert.equal(page.values[2], 10, 'The statement binds the page size.');
  assert.equal(page.values[3], 10, 'The statement binds the page offset.');
});

test('the rejected and warning views answer their own lines', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  report.rejections = [
    {
      source_row: 4,
      device_id: 'dev-bad',
      column_name: 'Notes',
      submitted_value: 'x'.repeat(10),
      reason: 'The Notes value holds 1 to 1,024 characters.',
      serial_number: 'SN-bad',
    },
  ];
  report.warnings = [
    {
      source_row: null,
      device_id: null,
      warning: 'An unknown column "Owner" arrived.',
    },
    {
      source_row: 5,
      device_id: 'dev-2',
      warning: 'Asset tag AT-1 is also on another device.',
    },
  ];
  const rejected = await request(
    '/api/devices/imports/IMP-001/report?view=rejected',
  );
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.total, 1);
  assert.deepEqual(rejected.body.lines[0], {
    row: 4,
    deviceId: 'dev-bad',
    serialNumber: 'SN-bad',
    change: null,
    column: 'Notes',
    submittedValue: 'x'.repeat(10),
    reason: 'The Notes value holds 1 to 1,024 characters.',
    notRun: null,
    jobDisplayId: null,
    operationNumber: null,
    outcome: null,
  });
  const warnings = await request(
    '/api/devices/imports/IMP-001/report?view=warnings',
  );
  assert.equal(warnings.status, 200, JSON.stringify(warnings.body));
  assert.equal(warnings.body.total, 2);
  assert.equal(
    warnings.body.lines[0].row,
    null,
    'A header warning names no source row.',
  );
  assert.equal(warnings.body.lines[1].deviceId, 'dev-2');
});

test('an expired open plan reads expired in the report', async () => {
  reset();
  const job = importJob({ job: plan({ expiresAt: at(-1).toISOString() }) });
  jobs.set('IMP-001', job);
  const answer = await request('/api/devices/imports/IMP-001/report');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.plan.state, 'expired');
  assert.equal(answer.body.plan.expiresAt, job.job.expiresAt);
});

test('a job without a plan answers a null plan', async () => {
  reset();
  jobs.set('IMP-001', importJob({ job: null }));
  const answer = await request('/api/devices/imports/IMP-001/report');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.plan, null);
});

test('a report before the job completes answers 409', async () => {
  reset();
  jobs.set('IMP-001', importJob({ status: 'running' }));
  const answer = await request('/api/devices/imports/IMP-001/report');
  assert.equal(answer.status, 409, JSON.stringify(answer.body));
  assert.equal(answer.body.reason, 'report-not-ready');
  assert.deepEqual(
    checks,
    importActions,
    'The permissions precede the state read.',
  );
});

test('the rejected file streams a CSV attachment with every reason of a row', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  report.fileRows = [
    {
      source_row: 4,
      template_cells: [
        'dev-bad',
        'SN-bad',
        'Model 1',
        'ACTIVE',
        'AT-1',
        '\t=formula',
        'user@example.org',
        'note',
        '/Schools/A',
        '0000',
      ],
      reasons: 'The row holds no Device ID.; Another row uses this Device ID.',
    },
  ];
  const answer = await request('/api/devices/imports/IMP-001/rejected');
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(
    answer.headers.get('content-disposition'),
    'attachment; filename="device-import-IMP-001-rejected.csv"',
  );
  const text = String(answer.body);
  assert.ok(
    text.startsWith(
      'Device ID,Serial number,Model,Status,Asset tag,Annotated location,Annotated user,Notes,Organization unit,Checksum,Row,Reason\r\n',
    ),
    text,
  );
  assert.match(
    text,
    /\r\ndev-bad,SN-bad,Model 1,ACTIVE,AT-1,\t=formula,user@example\.org,note,\/Schools\/A,0000,4,The row holds no Device ID\.; Another row uses this Device ID\.\r\n$/,
    'One row carries the ten cells, its row, and every reason.',
  );
  const file = statements.find((statement) =>
    statement.text.includes('string_agg(r.reason'),
  );
  assert.ok(file, 'The route reads the rejected file.');
});

test('the rejected file keeps the formula protection of a cell', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  // An unprotected formula, a protected one, two other formula starts, and cells that the CSV
  // writer must quote. The download writes every template column through the shared escape.
  const stored = [
    '=HYPERLINK("http://example.org","x")',
    'SN, with a comma',
    'Model 1',
    'ACTIVE',
    '@AT-1',
    '+1+1',
    'user@example.org',
    'Line 1\nLine 2',
    '/Schools/A',
    '\t=1+1',
  ];
  const reasons =
    'An unknown column "=Owner, notes\nsecond line" arrived.; The row holds no Device ID.';
  report.fileRows = [{ source_row: 4, template_cells: stored, reasons }];
  const answer = await request('/api/devices/imports/IMP-001/rejected');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const reader = createCsvReader();
  const records = [...reader.push(String(answer.body)), ...reader.end()];
  assert.equal(records.length, 2, 'The file holds a header and one row.');
  assert.deepEqual(
    records[0].cells.slice(0, DEVICE_EDIT_TEMPLATE_HEADERS.length),
    [...DEVICE_EDIT_TEMPLATE_HEADERS],
  );
  assert.deepEqual(
    records[0].cells.slice(DEVICE_EDIT_TEMPLATE_HEADERS.length),
    ['Row', 'Reason'],
  );
  const row = records[1].cells;
  assert.equal(row.length, DEVICE_EDIT_TEMPLATE_HEADERS.length + 2);
  for (const [index, value] of stored.entries()) {
    assert.equal(
      row[index],
      deviceEditEscapeCell(deviceEditUnescapeCell(value)),
      `The rejected cell ${index} keeps its text protection.`,
    );
    assert.equal(
      deviceEditUnescapeCell(row[index]),
      deviceEditUnescapeCell(value),
      `The rejected cell ${index} reads back as the value of its row.`,
    );
  }
  assert.equal(
    row.some((cell) => /^[=+\-@]/.test(cell)),
    false,
    'No rejected cell starts a formula.',
  );
  assert.equal(row[DEVICE_EDIT_TEMPLATE_HEADERS.length], '4');
  assert.equal(
    row[DEVICE_EDIT_TEMPLATE_HEADERS.length + 1],
    reasons,
    'One row carries every reason of its source row, quoted and whole.',
  );
});

test('the rejected file needs devices:read and the job visibility', async () => {
  reset({ actions: ['devices:write', 'devices:bulk-actions'] });
  jobs.set('IMP-001', importJob());
  const answer = await request('/api/devices/imports/IMP-001/rejected');
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.deepEqual(checks, []);
  assert.equal(statementCount(), 0, 'The refusal reads no job.');

  reset();
  jobs.set('IMP-001', importJob({ visible: false }));
  const hidden = await request('/api/devices/imports/IMP-001/rejected');
  assert.equal(hidden.status, 404, JSON.stringify(hidden.body));
  assert.equal(hidden.body.reason, 'job-not-found');
});

test('the plan cancel answers the cancelled plan', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  const answer = await post('/api/devices/imports/IMP-001/cancel', {
    planId,
    planRevision: 1,
  });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  // The function answers the actor of the change as a principal ID. The route names the person.
  assert.equal(cancelResult.plan.changedBy, actor);
  assert.deepEqual(answer.body, {
    plan: {
      planId: cancelResult.plan.planId,
      revision: 2,
      state: 'cancelled',
      expiresAt: cancelResult.plan.expiresAt,
      changedBy: { id: actor, displayName: 'Test person' },
      changedAt: cancelResult.plan.changedAt,
    },
  });
  const lookups = statements.filter((statement) =>
    statement.text.includes('cc.application_principals p WHERE p.id=$1'),
  );
  assert.deepEqual(
    lookups.map((statement) => statement.values[0]),
    [actor],
    'The route resolves the person of the plan once.',
  );
  assert.deepEqual(checks, importActions);
  const cancel = statements.find((statement) =>
    statement.text.includes('cc.cancel_device_import_plan'),
  );
  assert.deepEqual(cancel.values, [actor, 7, customer, jobId, planId, 1]);
});

test('a cancelled plan answers the same plan on a replay, and the report stays', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  cancelResult = {
    outcome: 'cancelled',
    plan: sqlPlan({
      revision: 3,
      state: 'cancelled',
      changedBy: actor,
      changedAt: at(-HOUR).toISOString(),
    }),
  };
  const answer = await post('/api/devices/imports/IMP-001/cancel', {
    planId,
    planRevision: 3,
  });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(answer.body.plan.state, 'cancelled');
  assert.equal(answer.body.plan.revision, 3);
  assert.deepEqual(answer.body.plan.changedBy, {
    id: actor,
    displayName: 'Test person',
  });
  // Nothing ran, and the report of the job is still there (design section 7, state 20).
  assert.equal(starts.length, 0, 'A cancel starts no flow.');
  const reportAnswer = await request('/api/devices/imports/IMP-001/report');
  assert.equal(reportAnswer.status, 200, JSON.stringify(reportAnswer.body));
});

test('a plan of another actor keeps its person in the answer', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  const other = '22222222-2222-4222-8222-222222222222';
  people.set(other, { id: other, display_name: 'Other person' });
  cancelResult = {
    outcome: 'cancelled',
    plan: sqlPlan({ revision: 2, state: 'cancelled', changedBy: other }),
  };
  const answer = await post('/api/devices/imports/IMP-001/cancel', {
    planId,
    planRevision: 1,
  });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.deepEqual(answer.body.plan.changedBy, {
    id: other,
    displayName: 'Other person',
  });
});

test('another plan revision answers 409 and an expired plan answers 410', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  cancelResult = {
    outcome: 'conflict',
    plan: sqlPlan({ revision: 3 }),
  };
  const conflict = await post('/api/devices/imports/IMP-001/cancel', {
    planId,
    planRevision: 1,
  });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.reason, 'plan-conflict');
  assert.equal(
    conflict.body.plan.changedBy,
    null,
    'The echo of an open plan names no person.',
  );
  assert.equal(conflict.body.plan.revision, 3);

  reset();
  jobs.set('IMP-001', importJob());
  const expiresAt = at(-1).toISOString();
  cancelResult = {
    outcome: 'expired',
    plan: sqlPlan({ expiresAt }),
    expiresAt,
  };
  const expired = await post('/api/devices/imports/IMP-001/cancel', {
    planId,
    planRevision: 1,
  });
  assert.equal(expired.status, 410, JSON.stringify(expired.body));
  assert.equal(expired.body.reason, 'plan-expired');
  assert.equal(
    expired.body.plan.state,
    'expired',
    'An open plan past its expiry reads expired, as the report reads it.',
  );
  assert.equal(expired.body.plan.expiresAt, expiresAt);
});

test('the plan cancel accepts the requester only', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  cancelResult = { outcome: 'not-found' };
  const answer = await post('/api/devices/imports/IMP-001/cancel', {
    planId,
    planRevision: 1,
  });
  assert.equal(answer.status, 404, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'job-not-found' });
});

test('an invalid cancel body answers 400 before any person check', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  const answer = await post('/api/devices/imports/IMP-001/cancel', {
    planId: 'not-a-uuid',
    planRevision: 0,
  });
  assert.equal(answer.status, 400, JSON.stringify(answer.body));
  assert.deepEqual(checks, []);
  assert.equal(
    statements.find((statement) =>
      statement.text.includes('cc.cancel_device_import_plan'),
    ),
    undefined,
  );
});

test('a revalidation creates a job from the stored file of the named job', async () => {
  reset();
  jobs.set('IMP-001', importJob({ mode: 'sync-all-rows', job: null }));
  artifacts.set(jobId, {
    id: 'artifact-IMP-001',
    size_bytes: '2048',
    retention_until: at(30 * DAY),
  });
  createResult = {
    outcome: 'created',
    receipt: {
      jobId: newJobId,
      displayId: 'IMP-002',
      status: 'accepted',
      mode: 'sync-all-rows',
      name: 'devices.csv',
      sizeBytes: 2048,
    },
  };
  const answer = await post('/api/devices/imports/IMP-001/revalidate', {});
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(answer.body.displayId, 'IMP-002');
  assert.deepEqual(checks, importActions);
  const create = createStatement();
  assert.equal(
    create.values[3],
    'sync-all-rows',
    'The new job keeps the mode.',
  );
  assert.equal(create.values[5], 'devices.csv');
  assert.equal(create.values[6], 2048);
  assert.deepEqual(create.values[7], ['disable', 'reenable', 'deprovision']);
  assert.equal(
    create.values[9],
    'artifact-IMP-001',
    'The new job links the stored file, which moves the link.',
  );
  assert.equal(starts.length, 1);
  assert.equal(starts[0].jobId, newJobId);
  assert.equal(discarded.length, 0, 'A moved link keeps its file.');
});

test('a file past its retention answers 410 and creates no job', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  const expiresAt = at(-DAY).toISOString();
  artifacts.set(jobId, {
    id: 'artifact-IMP-001',
    size_bytes: '2048',
    retention_until: expiresAt,
  });
  const answer = await post('/api/devices/imports/IMP-001/revalidate', {});
  assert.equal(answer.status, 410, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, {
    reason: 'source-expired',
    expiresAt,
  });
  assert.equal(createStatement(), undefined);
  assert.equal(starts.length, 0);
});

test('a job without a stored file answers 410', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  const answer = await post('/api/devices/imports/IMP-001/revalidate', {});
  assert.equal(answer.status, 410, JSON.stringify(answer.body));
  assert.equal(answer.body.reason, 'source-expired');
  assert.equal(createStatement(), undefined);
});

test('a revalidation asks for the import permissions before it reads the file', async () => {
  reset({ actions: ['devices:read', 'devices:bulk-actions'] });
  jobs.set('IMP-001', importJob());
  artifacts.set(jobId, {
    id: 'artifact-IMP-001',
    size_bytes: '2048',
    retention_until: at(DAY),
  });
  const answer = await post('/api/devices/imports/IMP-001/revalidate', {});
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.deepEqual(checks, ['devices:read', 'devices:write']);
  assert.equal(statementCount(), 0);
});

test('another customer reads 404 on every route that names a display ID', async () => {
  reset();
  jobs.set('IMP-001', importJob({ customerId: otherCustomer }));
  artifacts.set(jobId, {
    id: 'artifact-IMP-001',
    size_bytes: '2048',
    retention_until: at(DAY),
  });
  const answers = [
    await request('/api/devices/imports/IMP-001/report'),
    await request('/api/devices/imports/IMP-001/rejected'),
    await post('/api/devices/imports/IMP-001/cancel', {
      planId,
      planRevision: 1,
    }),
    await post('/api/devices/imports/IMP-001/revalidate', {}),
  ];
  for (const answer of answers)
    assert.equal(answer.status, 404, JSON.stringify(answer.body));
  for (const answer of answers)
    assert.deepEqual(answer.body, { reason: 'job-not-found' });
  const lookups = statements.filter((statement) =>
    statement.text.includes('FROM cc.jobs j JOIN cc.device_import_jobs i'),
  );
  assert.equal(lookups.length, 4, 'Each route looks the job up.');
  for (const lookup of lookups)
    assert.equal(
      lookup.values[2],
      customer,
      'The route binds the connected customer, never a customer of the request.',
    );
  assert.equal(
    statements.filter((statement) =>
      statement.text.includes('cc.create_device_import_job'),
    ).length,
    0,
    'A foreign job creates no job.',
  );
});

test('a display ID of another job kind answers 404 without a query', async () => {
  reset();
  for (const displayId of ['EXP-001', 'UPD-001', 'IMP-1', 'imp-001']) {
    const answer = await request(`/api/devices/imports/${displayId}/report`);
    assert.equal(
      answer.status,
      404,
      `${displayId}: ${JSON.stringify(answer.body)}`,
    );
  }
  assert.equal(statementCount(), 0, 'A malformed display ID reads no job.');
});

test('an invisible job answers 404 on the report and the revalidation', async () => {
  reset();
  jobs.set('IMP-001', importJob({ visible: false }));
  artifacts.set(jobId, {
    id: 'artifact-IMP-001',
    size_bytes: '2048',
    retention_until: at(DAY),
  });
  const report = await request('/api/devices/imports/IMP-001/report');
  assert.equal(report.status, 404, JSON.stringify(report.body));
  const revalidate = await post('/api/devices/imports/IMP-001/revalidate', {});
  assert.equal(revalidate.status, 404, JSON.stringify(revalidate.body));
});

test('the report and the revalidation ask for the import permissions', async () => {
  reset({ actions: ['devices:read', 'devices:write'] });
  jobs.set('IMP-001', importJob());
  const report = await request('/api/devices/imports/IMP-001/report');
  assert.equal(report.status, 403, JSON.stringify(report.body));
  assert.deepEqual(checks, [
    'devices:read',
    'devices:write',
    'devices:bulk-actions',
  ]);
  assert.equal(statementCount(), 0);

  reset({ actions: ['devices:bulk-actions'] });
  const revalidate = await post('/api/devices/imports/IMP-001/revalidate', {});
  assert.equal(revalidate.status, 403, JSON.stringify(revalidate.body));
  assert.deepEqual(checks, []);
});

test('an invalid report query answers 400 before any person check', async () => {
  reset();
  jobs.set('IMP-001', importJob());
  for (const query of ['view=wrong', 'page=-1', 'view=failed&other=1']) {
    const answer = await request(
      `/api/devices/imports/IMP-001/report?${query}`,
    );
    assert.equal(
      answer.status,
      400,
      `${query}: ${JSON.stringify(answer.body)}`,
    );
  }
  assert.deepEqual(checks, []);
});
