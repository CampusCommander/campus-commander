import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The D1 check of card t_085dd227. One command job sends its issue POST and Google never
// answers, so the worker stores no HTTP status. The job ends needs-review, and
// GET /api/jobs/<displayId>/operations answers HTTP 200 with the unknown row.
const workspace = resolve(import.meta.dirname, '../..');
const load = (path) => import(pathToFileURL(resolve(workspace, path)).href);
const require = createRequire(resolve(workspace, 'package.json'));
const { Module } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');

export async function qualifyDeviceCommandAnswers({
  runtime,
  migrator,
  issuer,
}) {
  const [
    worker,
    jobsModule,
    controllerModule,
    serviceModule,
    guardModule,
    authModule,
    eventsModule,
    orchestrationModule,
    securityModule,
  ] = await Promise.all([
    load('worker/src/device-update.ts'),
    load('api/src/app/jobs/jobs.ts'),
    load('api/src/app/jobs/jobs.controller.ts'),
    load('api/src/app/jobs/jobs.service.ts'),
    load('api/src/app/auth/auth.guard.ts'),
    load('api/src/app/auth/auth.service.ts'),
    load('api/src/app/devices/device-events.service.ts'),
    load('api/src/app/orchestration/orchestration.service.ts'),
    load('api/src/app/security.ts'),
  ]);
  const { DeviceUpdateJobs } = worker;
  const { Jobs } = jobsModule;
  const { JobsController } = controllerModule;
  const { JobsService } = serviceModule;
  const { AuthGuard } = guardModule;
  const { AuthService } = authModule;
  const { DeviceEventsService } = eventsModule;
  const { OrchestrationService } = orchestrationModule;
  const { ApplicationExceptionFilter, securityHeaders } = securityModule;
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const generation = connection.generation;
  const wasActive = connection.active;
  const results = [];
  const failures = [];
  const principals = [];
  const jobs = [];
  const previews = [];
  const result = (text, values = []) =>
    runtime.query(text, values).then((r) => r.rows[0].result);
  const admin = (text, values = []) =>
    migrator.query(text, values).then((r) => r.rows);
  const adminRow = (text, values = []) =>
    migrator.query(text, values).then((r) => r.rows[0]);
  const check = async (name, body) => {
    try {
      await body();
      results.push(`${name}: pass`);
    } catch (error) {
      failures.push(name);
      results.push(`${name}: FAIL ${error.message}`);
    }
    process.stderr.write(`check ${results.at(-1)}\n`);
  };
  let actor;
  let apiServer;
  try {
    await migrator.query('UPDATE cc.google_connection SET active=true');
    // The read path of the API: one principal with the jobs:read grant of this district.
    actor = randomUUID();
    principals.push(actor);
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
      [actor, issuer, `d1-reader-${randomUUID()}@example.org`],
    );
    await migrator.query(
      'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
      [
        actor,
        'jobs:read',
        JSON.stringify({ kind: 'district', customerId: customer }),
      ],
    );
    // The confirmer of the job holds the command write actions of this district.
    const confirmer = randomUUID();
    principals.push(confirmer);
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
      [confirmer, issuer, `d1-confirmer-${randomUUID()}@example.org`],
    );
    for (const action of ['devices:commands', 'devices:bulk-actions'])
      await migrator.query(
        'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
        [
          confirmer,
          action,
          JSON.stringify({ kind: 'district', customerId: customer }),
        ],
      );
    const version = (
      await adminRow(
        'SELECT permission_version FROM cc.application_principals WHERE id=$1',
        [confirmer],
      )
    ).permission_version;
    const session = {
      identity: {
        id: actor,
        displayName: 'D1 reader',
        permissions: ['identity:read'],
        permissionVersion: version,
        grants: [
          {
            action: 'jobs:read',
            scope: { kind: 'district', customerId: customer },
          },
        ],
        preferences: { theme: 'system', navigationCollapsed: false },
      },
      expiresAt: '2026-10-06T13:00:00.000Z',
      csrfToken: 'a'.repeat(64),
    };
    const api = new Jobs({
      connection: {
        query: (text, values) => runtime.query(text, values),
      },
    });

    // Mount the production controller, its guard boundary, and the exception filter that the
    // rehearsal's 400 passed through. The guard override supplies the seeded session only.
    Reflect.defineMetadata(
      'design:paramtypes',
      [JobsService, AuthService, DeviceEventsService, OrchestrationService],
      JobsController,
    );
    class DeviceCommandAnswersModule {}
    Module({
      controllers: [JobsController],
      providers: [
        { provide: JobsService, useValue: api },
        { provide: AuthService, useValue: {} },
        { provide: DeviceEventsService, useValue: {} },
        { provide: OrchestrationService, useValue: {} },
      ],
    })(DeviceCommandAnswersModule);
    const apiModule = await Test.createTestingModule({
      imports: [DeviceCommandAnswersModule],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context) => {
          context.switchToHttp().getRequest().session = session;
          return true;
        },
      })
      .compile();
    apiServer = apiModule.createNestApplication({ logger: ['error'] });
    apiServer.use(securityHeaders);
    apiServer.useGlobalFilters(new ApplicationExceptionFilter());
    await apiServer.listen(0, '127.0.0.1');
    const origin = await apiServer.getUrl();

    /** One accepted command job with one pending operation (the step 5 shape). */
    const makeJob = async () => {
      const jobId = randomUUID();
      const previewId = randomUUID();
      await admin(
        `INSERT INTO cc.device_update_previews(preview_id,display_id,customer_id,created_by,permission_version,
          generation,action,field,mode,value,selected,eligible,unchanged,excluded,manifest_digest,expires_at)
        VALUES($1,cc.job_display_id('PV',nextval('cc.preview_number_pv')),$2,$3,$4,$5,'reboot',NULL,NULL,NULL,1,1,0,0,
          'manifest-digest',clock_timestamp()+interval '1 hour')`,
        [previewId, customer, actor, version, generation],
      );
      const [job] = await admin(
        `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
          target_count,correlation_id)
        VALUES($1,cc.job_display_id('CMD',nextval('cc.job_number_cmd')),$2,'device-command','devices','accepted',
          $3,$4,1,$5)
        RETURNING display_id`,
        [jobId, customer, actor, generation, randomUUID()],
      );
      await admin(
        `INSERT INTO cc.device_update_jobs(job_id,preview_id,action,field,mode,value,confirmed_by,
          confirmer_permission_version,delegated_subject,batch_size,batch_count)
        VALUES($1,$2,'reboot',NULL,NULL,NULL,$3,$4,'admin@example.org',250,1)`,
        [jobId, previewId, confirmer, version],
      );
      await admin(
        `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,serial_number,
          org_unit_path,baseline_value,requested_value,batch,status)
        VALUES($1,1,'d1-lost-1','SN-d1-lost-1','/School A','ACTIVE',NULL,0,'pending')`,
        [jobId],
      );
      jobs.push(jobId);
      previews.push(previewId);
      const admitted = await result(
        'SELECT cc.admit_device_update_job($1,$2) AS result',
        [customer, false],
      );
      assert.equal(
        admitted.jobId,
        jobId,
        'The admission admits the seeded job.',
      );
      return {
        jobId,
        displayId: job.display_id,
        token: admitted.dispatchToken,
      };
    };

    await check(
      'D1 a lost issuance answer ends needs-review and GET /api/jobs/<displayId>/operations answers 200 with the unknown row',
      async () => {
        const job = await makeJob();
        /** Google receives the POST and never answers it before the call ends. */
        const stop = new AbortController();
        const reader = {
          aborted: false,
          async issueDeviceCommands(
            _credential,
            _customer,
            commands,
            _signal,
            options,
          ) {
            await options.onSend(commands.map((command) => command.deviceId));
            // The POST left the worker, and the call ends before its answer arrives.
            stop.abort();
            this.aborted = true;
            return { succeeded: new Map(), failed: new Map() };
          },
        };
        const cache = { publish: async () => undefined };
        const workerJobs = new DeviceUpdateJobs(
          { query: (text, values) => runtime.query(text, values) },
          { open: () => ({ subject: 'fixture@example.invalid' }) },
          reader,
          cache,
        );
        const batch = await workerJobs.runBatch(
          {
            customerId: customer,
            jobId: job.jobId,
            dispatchToken: job.token,
            batch: 0,
            correlationId: randomUUID(),
          },
          // The call ends while the POST waits, as the watchdog or a worker stop ends it.
          stop.signal,
        );
        assert.equal(batch.outcome, 'settled');
        assert.equal(reader.aborted, true, 'The POST left the worker.');
        const finished = await workerJobs.runFinish(
          {
            customerId: customer,
            jobId: job.jobId,
            dispatchToken: job.token,
            correlationId: randomUUID(),
          },
          AbortSignal.timeout(5000),
        );
        assert.equal(finished.outcome, 'finished');
        assert.equal(finished.status, 'needs-review');
        // GET /api/jobs/<displayId> through the production controller.
        const detailResponse = await fetch(
          `${origin}/api/jobs/${job.displayId}`,
        );
        const detail = await detailResponse.json();
        assert.equal(detailResponse.status, 200, JSON.stringify(detail));
        assert.equal(detail.status, 'needs-review');
        // GET /api/jobs/<displayId>/operations: the route that answered 400 in the rehearsal.
        const response = await fetch(
          `${origin}/api/jobs/${job.displayId}/operations`,
        );
        const page = await response.json();
        assert.equal(response.status, 200, JSON.stringify(page));
        assert.equal(page.operations.length, 1);
        assert.deepEqual(
          {
            deviceId: page.operations[0].deviceId,
            outcome: page.operations[0].outcome,
            googleStatus: page.operations[0].googleStatus,
          },
          { deviceId: 'd1-lost-1', outcome: 'unknown', googleStatus: null },
        );
        const stored = await adminRow(
          'SELECT status,outcome_reason,google_status,google_reason FROM cc.device_update_operations WHERE job_id=$1',
          [job.jobId],
        );
        assert.equal(stored.status, 'unknown');
        assert.equal(stored.outcome_reason, 'ambiguous');
        assert.equal(
          stored.google_status,
          null,
          'No HTTP answer, so no stored status.',
        );
      },
    );
  } finally {
    await apiServer?.close().catch(() => undefined);
    for (const jobId of jobs)
      await migrator
        .query('DELETE FROM cc.jobs WHERE job_id=$1', [jobId])
        .catch(() => undefined);
    for (const previewId of previews)
      await migrator
        .query('DELETE FROM cc.device_update_previews WHERE preview_id=$1', [
          previewId,
        ])
        .catch(() => undefined);
    for (const id of principals)
      await migrator
        .query('DELETE FROM cc.application_principals WHERE id=$1', [id])
        .catch(() => undefined);
    await migrator.query(
      'UPDATE cc.google_connection SET active=$1 WHERE customer_id=$2',
      [wasActive, customer],
    );
  }
  if (failures.length > 0)
    throw new Error(
      `Device command answer checks failed: ${failures.join(' | ')}`,
    );
  return results;
}
