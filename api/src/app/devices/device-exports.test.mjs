import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import esbuild from 'esbuild';

/**
 * The export routes of the device export and import workflow (design section 5, card XB8). The
 * suite runs the real controller, the real export service, and the real exception filter against a
 * fake database, cache, store, and flow starter, so every status, refusal, and permission is the
 * route's own answer.
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
const { ConflictException, ForbiddenException, Module } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');

const customer = 'C0123456';
const otherCustomer = 'C0654321';
const actor = '11111111-1111-4111-8111-111111111111';
const jobId = '44444444-4444-4444-8444-444444444444';
const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const selectionKey = `cc:device-selection:${actor}:devices:${tabId}`;
const HOUR = 60 * 60 * 1000;
/**
 * A fixture time relative to the clock of the run. The selection lifetime is 12 hours, so an
 * absolute date would make this suite pass today and refuse its own fixtures tomorrow.
 */
const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

const session = {
  identity: {
    id: actor,
    displayName: 'Test person',
    permissions: [],
    permissionVersion: 1,
    grants: [],
    preferences: {},
  },
  expiresAt: at(HOUR),
  csrfToken: 'a'.repeat(64),
};

const connected = { customerId: customer, generation: 3 };
const bytes = Buffer.from('Device ID,Serial number\r\nabc,SN-abc\r\n');

let app;
let origin;
/** The actions that the signed-in person holds in the current test. */
let allowed;
/** The person checks that the route ran, in the order of the routes. */
let checks;
/** The Redis answer of the current test. */
let selectionRaw;
/** The rows that the selection query answers, in grid order. */
let selectionRows;
/** The create-function outcome of the current test. */
let createResult;
/** The export jobs that the file route may answer, by display ID. */
let jobs;
/** Whether the store answers a read of the artifact. */
let storeFails;
/** The number of artifact reads of the current test. */
let reads;
/** Whether the flow starter refuses. */
let startFails;
/** The recorded SQL statements and their values. */
let statements;
/** The recorded flow starts. */
let starts;
/** The recorded Drive exchanges. */
let driveCalls;
/** The subject that the Drive exchange answers. */
let driveSubjectAnswer;
/** The refusal that the Drive exchange raises, if any. */
let driveFails;

before(async () => {
  const [
    controllerModule,
    serviceModule,
    exportsModule,
    devicesModule,
    authModule,
    guardModule,
    securityModule,
  ] = await Promise.all([
    import('./device-exports.controller.ts'),
    import('./device-exports.service.ts'),
    import('./device-exports.ts'),
    import('./devices.service.ts'),
    import('../auth/auth.service.ts'),
    import('../auth/auth.guard.ts'),
    import('../security.ts'),
  ]);
  const { DeviceExportsController } = controllerModule;
  const { DeviceExportsService } = serviceModule;
  const { DevicesService } = devicesModule;
  const { AuthService } = authModule;
  const { AuthGuard } = guardModule;
  const { ApplicationExceptionFilter, securityHeaders } = securityModule;

  checks = [];
  allowed = new Set();
  statements = [];
  starts = [];
  jobs = new Map();

  const cache = {
    get: async (key) => {
      assert.equal(key, selectionKey, 'The route reads its own selection key.');
      return selectionRaw;
    },
  };
  const database = {
    connection: {
      query: async (text, values = []) => {
        statements.push({ text, values });
        if (text.includes('cc.create_device_export_job'))
          return { rows: [{ result: createResult }] };
        if (text.includes('FROM cc.jobs j JOIN cc.device_export_jobs e')) {
          const [, , requestedCustomer, displayId] = values;
          const job = jobs.get(displayId);
          // The statement filters the customer itself, so a foreign job answers no row.
          if (!job || job.customerId !== requestedCustomer) return { rows: [] };
          return {
            rows: [
              {
                purpose: job.purpose,
                file_artifact_id: job.artifactId ?? null,
                file_name: job.name ?? null,
                file_size_bytes: job.sizeBytes,
                file_expires_at: job.expiresAt ?? null,
                visible: job.visible,
              },
            ],
          };
        }
        // The one selection query of the create route, in grid order.
        return {
          rows: selectionRows.map((device) => ({ device_id: device })),
        };
      },
    },
  };
  const storage = {
    openRead: async (artifactId) => {
      reads += 1;
      assert.equal(artifactId, jobs.get('EXP-001')?.artifactId);
      if (storeFails) throw new Error('The artifact is missing.');
      return Readable.from([bytes]);
    },
  };
  const orchestration = {
    startDeviceExport: async (input) => {
      if (startFails) throw new Error('The flow refused the start.');
      starts.push(input);
      return 'execution-1';
    },
  };
  // The Drive exchange of the Sheet export. The production service answers a subject or the body
  // of a refused exchange; this double records each call.
  const drive = {
    sheetExportSubject: async (currentSession, cookie, current) => {
      driveCalls.push({ session: currentSession, cookie, current });
      if (driveFails) throw driveFails;
      return driveSubjectAnswer;
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
    authorize: async (_session, action) => {
      checks.push(action);
      if (!allowed.has(action))
        throw new ForbiddenException(
          'This action requires additional permission.',
        );
    },
  };

  // esbuild emits no decorator metadata, so the harness names the constructor tokens.
  Reflect.defineMetadata(
    'design:paramtypes',
    [DevicesService, DeviceExportsService, AuthService],
    DeviceExportsController,
  );

  class ExportRoutesModule {}
  Module({
    controllers: [DeviceExportsController],
    providers: [
      { provide: DevicesService, useValue: devices },
      {
        provide: DeviceExportsService,
        useValue: new DeviceExportsService(
          database,
          cache,
          storage,
          orchestration,
          drive,
        ),
      },
      { provide: AuthService, useValue: auth },
    ],
  })(ExportRoutesModule);

  const moduleRef = await Test.createTestingModule({
    imports: [ExportRoutesModule],
  })
    .overrideGuard(AuthGuard)
    .useValue({
      canActivate: (context) => {
        context.switchToHttp().getRequest().session = session;
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

/** Reset every stub to one granted person with a selection of two devices. */
function reset({
  actions = ['devices:read', 'devices:bulk-actions', 'devices:export'],
} = {}) {
  checks = [];
  allowed = new Set(actions);
  statements = [];
  starts = [];
  jobs = new Map();
  reads = 0;
  driveCalls = [];
  driveSubjectAnswer = 'person@example.org';
  driveFails = null;
  // A current selection: it stays inside the 12-hour lifetime of the run that reads it.
  selectionRaw = JSON.stringify({
    terms: [],
    groups: [],
    additions: ['d1', 'd2'],
    exceptions: [],
    changedAt: at(),
  });
  selectionRows = ['d1', 'd2'];
  storeFails = false;
  startFails = false;
  createResult = {
    outcome: 'created',
    receipt: { jobId, displayId: 'EXP-001', status: 'accepted', rows: 2 },
  };
}

const editRequest = (extra = {}) => ({
  gridId: 'devices',
  tabId,
  purpose: 'edit',
  format: 'csv',
  sort: { field: 'serialNumber', direction: 'asc' },
  columns: [],
  ...extra,
});

const reportRequest = (extra = {}) =>
  editRequest({
    purpose: 'report',
    columns: ['serialNumber', 'status', 'model'],
    ...extra,
  });

async function post(path, payload) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

async function get(path) {
  const response = await fetch(`${origin}${path}`);
  const body = response.headers
    .get('content-type')
    ?.includes('application/json')
    ? await response.json()
    : await response.arrayBuffer();
  return {
    status: response.status,
    headers: response.headers,
    body,
  };
}

/** One finished export job that the file route may answer. */
function finishedJob(extra = {}) {
  return {
    customerId: customer,
    purpose: 'edit',
    visible: true,
    artifactId: 'artifact-EXP-001',
    name: 'devices-for-editing-EXP-001.csv',
    // node-postgres answers a bigint column as text.
    sizeBytes: String(bytes.length),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    ...extra,
  };
}

const selectionStatement = () =>
  statements.find((statement) =>
    statement.text.includes('FROM cc.device_sync_state'),
  );
const createStatement = () =>
  statements.find((statement) =>
    statement.text.includes('cc.create_device_export_job'),
  );

test('an edit export freezes the selection in grid order and starts its flow', async () => {
  reset();
  const answer = await post('/api/devices/exports', editRequest());
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, {
    jobId,
    displayId: 'EXP-001',
    status: 'accepted',
    rows: 2,
  });
  assert.deepEqual(
    checks,
    ['devices:read', 'devices:bulk-actions', 'devices:export'],
    'The route checks the three export actions in order.',
  );
  const selection = selectionStatement();
  assert.ok(selection, 'The route resolves the selection.');
  assert.match(
    selection.text,
    /ORDER BY d\.serial_number ASC NULLS LAST,d\.device_id ASC LIMIT \$\d+$/,
    'The selection resolves in grid order with the device ID as the tie.',
  );
  assert.equal(
    selection.values.at(-1),
    50_001,
    'One query asks for one row above the limit.',
  );
  const create = createStatement();
  assert.ok(create, 'The route creates the job.');
  assert.equal(create.values[2], customer);
  assert.equal(create.values[3], 'edit');
  assert.equal(create.values[4], 'csv');
  assert.equal(create.values[5], 'serialNumber');
  assert.equal(create.values[6], 'asc');
  assert.deepEqual(create.values[7], [], 'An edit export names no column.');
  assert.deepEqual(
    JSON.parse(create.values[8]),
    ['d1', 'd2'],
    'The frozen scope keeps the order of the selection query.',
  );
  assert.match(
    create.values[9],
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'The job carries the correlation ID of the request.',
  );
  assert.equal(starts.length, 1, 'The route starts one flow run.');
  assert.equal(starts[0].customerId, customer);
  assert.equal(starts[0].jobId, jobId);
  assert.match(
    starts[0].leaseId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(
    starts[0].correlationId,
    create.values[9],
    'The flow run carries the correlation ID of the job.',
  );
});

test('a Sheet export runs the Drive exchange and stores its subject', async () => {
  reset();
  const answer = await post(
    '/api/devices/exports',
    editRequest({ format: 'sheet' }),
  );
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(driveCalls.length, 1, 'The route runs one exchange.');
  assert.equal(
    driveCalls[0].cookie,
    undefined,
    'The request carries no cookie, so the exchange names no session.',
  );
  assert.deepEqual(driveCalls[0].current, connected);
  const create = createStatement();
  assert.ok(create, 'The route creates the job.');
  assert.equal(create.values[4], 'sheet');
  assert.equal(
    create.values[10],
    'person@example.org',
    'The job stores the verified subject of the exchange.',
  );
  assert.equal(starts.length, 1);
});

test('a CSV export reads no Drive exchange and names no subject', async () => {
  reset();
  const answer = await post('/api/devices/exports', editRequest());
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(driveCalls.length, 0, 'A CSV export opens no exchange.');
  assert.equal(createStatement().values[10], null);
});

test('a refused Sheet exchange answers 409 with its cause and creates no job', async () => {
  reset();
  driveFails = new ConflictException({
    reason: 'drive-unavailable',
    cause: 'delegation',
  });
  const answer = await post(
    '/api/devices/exports',
    editRequest({ format: 'sheet' }),
  );
  assert.equal(answer.status, 409, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, {
    reason: 'drive-unavailable',
    cause: 'delegation',
  });
  assert.equal(
    selectionStatement(),
    undefined,
    'The refusal reads no selection and writes no job.',
  );
  assert.equal(createStatement(), undefined);
  assert.equal(starts.length, 0);
});

test('a report export sends its columns in grid order', async () => {
  reset();
  const answer = await post('/api/devices/exports', reportRequest());
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.deepEqual(createStatement().values[7], [
    'serialNumber',
    'status',
    'model',
  ]);
});

test('a descending battery sort resolves in the grid order of that column', async () => {
  reset();
  const answer = await post(
    '/api/devices/exports',
    editRequest({ sort: { field: 'battery', direction: 'desc' } }),
  );
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.match(
    selectionStatement().text,
    /END DESC NULLS LAST,d\.device_id DESC LIMIT \$\d+$/,
    'The battery order and the device ID tie follow the descending sort.',
  );
});

test('a person without devices:export receives 403 and creates no job', async () => {
  reset({ actions: ['devices:read', 'devices:bulk-actions'] });
  const answer = await post('/api/devices/exports', editRequest());
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.deepEqual(checks, [
    'devices:read',
    'devices:bulk-actions',
    'devices:export',
  ]);
  assert.equal(statementCount(), 0, 'The refusal reads no selection.');
  assert.equal(starts.length, 0);
});

test('a person without devices:bulk-actions receives 403 before devices:export', async () => {
  reset({ actions: ['devices:read', 'devices:export'] });
  const answer = await post('/api/devices/exports', editRequest());
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.deepEqual(checks, ['devices:read', 'devices:bulk-actions']);
  assert.equal(starts.length, 0);
});

test('a person without devices:read receives 403 before any action check', async () => {
  reset({ actions: ['devices:bulk-actions', 'devices:export'] });
  const answer = await post('/api/devices/exports', editRequest());
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.deepEqual(checks, [], 'The read refusal precedes every action check.');
});

test('an expired selection answers 409 and starts nothing', async () => {
  reset();
  selectionRaw = JSON.stringify({
    terms: [],
    groups: [],
    additions: ['d1'],
    exceptions: [],
    changedAt: at(-13 * HOUR),
  });
  const answer = await post('/api/devices/exports', editRequest());
  assert.equal(answer.status, 409, JSON.stringify(answer.body));
  assert.equal(answer.body.reason, 'selection-expired');
  assert.equal(typeof answer.body.expiredAt, 'string');
  assert.equal(statementCount(), 0, 'An expired selection reads no device.');
  assert.equal(starts.length, 0);
});

test('a selection without any chosen device answers 422', async () => {
  reset();
  selectionRaw = JSON.stringify({
    terms: [],
    groups: [],
    additions: [],
    exceptions: [],
  });
  const answer = await post('/api/devices/exports', editRequest());
  assert.equal(answer.status, 422, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'nothing-selected' });
  assert.equal(starts.length, 0);
});

test('a selection of 50,001 devices answers 422 for both purposes', async () => {
  reset();
  selectionRows = Array.from({ length: 50_001 }, (_, index) => `d${index}`);
  for (const payload of [editRequest(), reportRequest()]) {
    const answer = await post('/api/devices/exports', payload);
    assert.equal(answer.status, 422, JSON.stringify(answer.body));
    assert.deepEqual(answer.body, { reason: 'selection-too-large' });
  }
  assert.equal(
    createStatement(),
    undefined,
    'The refused scope creates no job.',
  );
  assert.equal(starts.length, 0);
});

test('a selection of 50,000 devices creates the job at the limit', async () => {
  reset();
  selectionRows = Array.from({ length: 50_000 }, (_, index) => `d${index}`);
  const answer = await post('/api/devices/exports', editRequest());
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(JSON.parse(createStatement().values[8]).length, 50_000);
});

test('a selection that resolves to no device still creates the job', async () => {
  reset();
  selectionRows = [];
  createResult = {
    outcome: 'created',
    receipt: { jobId, displayId: 'EXP-003', status: 'accepted', rows: 0 },
  };
  const answer = await post('/api/devices/exports', editRequest());
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(answer.body.rows, 0);
  assert.deepEqual(
    JSON.parse(createStatement().values[8]),
    [],
    'An empty scope writes the header row only.',
  );
});

test('an invalid body answers 400 before any person check', async () => {
  reset();
  const answer = await post(
    '/api/devices/exports',
    editRequest({ purpose: 'report', columns: [] }),
  );
  assert.equal(answer.status, 400, JSON.stringify(answer.body));
  assert.equal(answer.body.reason, 'invalid-export');
  assert.deepEqual(checks, [], 'A bad body reaches no person check.');
  assert.equal(starts.length, 0);
});

test('a report that names one column twice answers 400', async () => {
  reset();
  const answer = await post(
    '/api/devices/exports',
    reportRequest({ columns: ['status', 'status'] }),
  );
  assert.equal(answer.status, 400, JSON.stringify(answer.body));
  assert.equal(answer.body.reason, 'invalid-export');
  assert.deepEqual(checks, [], 'A repeated column reaches no person check.');
  assert.equal(starts.length, 0);
});

test('a create function that refuses the person answers 403', async () => {
  reset();
  createResult = { outcome: 'forbidden' };
  const answer = await post('/api/devices/exports', editRequest());
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.equal(starts.length, 0, 'A refused job starts no flow.');
});

test('a connection that changed answers 409', async () => {
  reset();
  createResult = { outcome: 'connection-changed' };
  const answer = await post('/api/devices/exports', editRequest());
  assert.equal(answer.status, 409, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'connection-changed' });
  assert.equal(starts.length, 0);
});

test('a refused flow start still answers the receipt', async () => {
  reset();
  startFails = true;
  const answer = await post('/api/devices/exports', editRequest());
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(answer.body.displayId, 'EXP-001');
  assert.equal(starts.length, 0, 'The starter recorded no run.');
});

test('a download streams the file with an attachment header', async () => {
  reset();
  jobs.set('EXP-001', finishedJob());
  const answer = await get('/api/devices/exports/EXP-001/file');
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(
    answer.headers.get('content-disposition'),
    'attachment; filename="devices-for-editing-EXP-001.csv"',
  );
  assert.equal(answer.headers.get('content-length'), String(bytes.length));
  assert.deepEqual(Buffer.from(answer.body), bytes);
});

test('a report download keeps its stored name, and an unsafe name falls back', async () => {
  reset();
  jobs.set(
    'EXP-001',
    finishedJob({
      purpose: 'report',
      name: 'device-report-EXP-001.csv',
    }),
  );
  const report = await get('/api/devices/exports/EXP-001/file');
  assert.equal(
    report.headers.get('content-disposition'),
    'attachment; filename="device-report-EXP-001.csv"',
  );

  reset();
  jobs.set('EXP-001', finishedJob({ name: 'evil"\r\nx-injected: 1.csv' }));
  const unsafe = await get('/api/devices/exports/EXP-001/file');
  assert.equal(
    unsafe.headers.get('content-disposition'),
    'attachment; filename="devices-for-editing-EXP-001.csv"',
    'A stored name that a header cannot carry never reaches the header.',
  );
  assert.equal(unsafe.headers.get('x-injected'), null);
});

test('a download before the file publishes answers 409', async () => {
  reset();
  jobs.set('EXP-001', finishedJob({ artifactId: null, expiresAt: null }));
  const answer = await get('/api/devices/exports/EXP-001/file');
  assert.equal(answer.status, 409, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'export-not-ready' });
  assert.equal(answer.headers.get('content-disposition'), null);
});

test('a download after the expiry answers 410', async () => {
  reset();
  const expiredAt = at(-24 * HOUR);
  jobs.set('EXP-001', finishedJob({ expiresAt: new Date(expiredAt) }));
  const answer = await get('/api/devices/exports/EXP-001/file');
  assert.equal(answer.status, 410, JSON.stringify(answer.body));
  assert.equal(answer.body.reason, 'export-expired');
  assert.equal(answer.body.expiresAt, expiredAt);
  assert.equal(reads, 0, 'An expired file opens no artifact.');
});

test("another customer's file answers 404", async () => {
  reset();
  jobs.set('EXP-001', finishedJob({ customerId: otherCustomer }));
  const answer = await get('/api/devices/exports/EXP-001/file');
  assert.equal(answer.status, 404, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'job-not-found' });
  const statement = statements.find((one) =>
    one.text.includes('JOIN cc.device_export_jobs'),
  );
  assert.ok(statement, 'The route looks the job up.');
  assert.match(
    statement.text,
    /WHERE j\.customer_id=\$3 AND j\.display_id=\$4 AND j\.kind='device-export'/,
    'The statement filters the connected customer and the export kind.',
  );
  assert.equal(
    statement.values[2],
    customer,
    'The route binds the connected customer, never a customer of the request.',
  );
  assert.equal(statement.values[3], 'EXP-001');
});

test('a job that the person cannot see answers 404', async () => {
  reset();
  jobs.set('EXP-001', finishedJob({ visible: false }));
  const answer = await get('/api/devices/exports/EXP-001/file');
  assert.equal(answer.status, 404, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'job-not-found' });
});

test('a display ID of another job kind answers 404 without a query', async () => {
  reset();
  for (const displayId of ['UPD-001', 'IMP-001', 'EXP-1', 'exp-001']) {
    const answer = await get(`/api/devices/exports/${displayId}/file`);
    assert.equal(
      answer.status,
      404,
      `${displayId}: ${JSON.stringify(answer.body)}`,
    );
  }
  assert.equal(statementCount(), 0, 'A malformed display ID reads no job.');
});

test('a person without devices:read answers 403 on the file route', async () => {
  reset({ actions: ['devices:bulk-actions', 'devices:export'] });
  jobs.set('EXP-001', finishedJob());
  const answer = await get('/api/devices/exports/EXP-001/file');
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.deepEqual(checks, [], 'The read refusal precedes every action check.');
  assert.equal(statementCount(), 0);
});

test('an unavailable artifact answers 503 without a download header', async () => {
  reset();
  storeFails = true;
  jobs.set('EXP-001', finishedJob());
  const answer = await get('/api/devices/exports/EXP-001/file');
  assert.equal(answer.status, 503, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'storage-unavailable' });
  assert.equal(answer.headers.get('content-disposition'), null);
});

/** The number of database statements of the current test. */
function statementCount() {
  return statements.length;
}
