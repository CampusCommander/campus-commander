import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from 'redis';
import {
  entityEventsChannel,
  jobEventsChannel,
} from '@campus/application-contracts';
import { redisImage } from '../redis/runtime.mjs';

// The B4 checks of design section 8.3: the jobs reads of section 2.5, the two eng-lead functions,
// and both live streams through the production controllers and a real Redis.
// Every check runs against the integration PostgreSQL instance through the runtime role.
const workspace = resolve(import.meta.dirname, '../..');
const load = (path) => import(pathToFileURL(resolve(workspace, path)).href);

export async function qualifyJobsApi({ runtime, migrator, issuer }) {
  const [
    { Jobs },
    { EventFanout, redisSubscriber },
    { JobsController },
    { JobsService },
    { DevicesController },
    { DevicesService },
  ] = await Promise.all([
    load('api/src/app/jobs/jobs.ts'),
    load('api/src/app/devices/device-events.ts'),
    load('api/src/app/jobs/jobs.controller.ts'),
    load('api/src/app/jobs/jobs.service.ts'),
    load('api/src/app/devices/devices.controller.ts'),
    load('api/src/app/devices/devices.service.ts'),
  ]);
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const generation = connection.generation;
  const wasActive = connection.active;
  const results = [];
  const failures = [];
  const principals = [];
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const statement = (text, values = []) =>
    runtime.query(text, values).then((rows) => rows.rows);
  const admin = (text, values = []) =>
    migrator.query(text, values).then((rows) => rows.rows);
  const adminRow = (text, values = []) =>
    migrator.query(text, values).then((rows) => rows.rows[0]);
  const query = (text, values = []) =>
    runtime.query(text, values).then((rows) => rows.rows);
  const jobs = new Jobs({
    connection: {
      query: (text, values) => runtime.query(text, values),
    },
  });
  const rejects = async (promise, code) => {
    try {
      await promise;
    } catch (error) {
      if (code && error.code !== code)
        throw new Error(`error ${error.code} instead of ${code}`);
      return error;
    }
    throw new Error(`expected a rejection ${code ?? ''}`);
  };
  const check = async (name, body) => {
    try {
      await body();
      results.push(`${name}: pass`);
    } catch (error) {
      failures.push(name);
      const detail =
        error.getResponse?.() ?? error.cause?.message ?? error.message;
      results.push(
        `${name}: FAIL ${typeof detail === 'string' ? detail : JSON.stringify(detail)}${error.cause?.message ? ` (${error.cause.message})` : ''}`,
      );
    }
    process.stderr.write(`check ${results.at(-1)}\n`);
  };
  await migrator.query('UPDATE cc.google_connection SET active=true');
  const principal = async (subject, grants = [], enabled = true) => {
    const id = randomUUID();
    principals.push(id);
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name,enabled) VALUES($1,$2,$3,$3,$4)',
      [id, issuer, subject, enabled],
    );
    for (const [action, scope] of grants)
      await migrator.query(
        'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
        [id, action, JSON.stringify(scope)],
      );
    return id;
  };
  const district = (customerId = customer) => ({
    kind: 'district',
    customerId,
  });
  const session = (id, grants) => ({
    identity: {
      id,
      displayName: String(id).slice(0, 8),
      permissions: ['identity:read'],
      permissionVersion: 1,
      grants,
      preferences: { theme: 'system', navigationCollapsed: false },
    },
    expiresAt: '2026-10-06T13:00:00.000Z',
    csrfToken: 'a'.repeat(64),
  });
  const reset = async () => {
    await migrator.query(
      'DELETE FROM cc.device_write_overlays WHERE customer_id=$1',
      [customer],
    );
    await migrator.query('DELETE FROM cc.jobs WHERE customer_id=$1', [
      customer,
    ]);
    await migrator.query(
      'DELETE FROM cc.device_update_previews WHERE customer_id=$1',
      [customer],
    );
    await migrator.query(
      'DELETE FROM cc.job_activity_seen WHERE principal_id=ANY($1::uuid[])',
      [principals.length ? principals : [randomUUID()]],
    );
    await migrator.query(
      `UPDATE cc.device_sync_state SET sync_id=NULL,sync_actor=NULL,sync_generation=NULL,sync_attempt=NULL,
        sync_expires_at=NULL,failure=NULL,failure_requested_by=NULL,telemetry_failure=NULL,
        telemetry_failure_requested_by=NULL WHERE customer_id=$1`,
      [customer],
    );
  };
  /** Insert one header. The display number comes from the 017 sequence. */
  const header = async ({
    kind = 'device-update',
    scope = 'devices',
    status = 'completed',
    requestedBy,
    targetCount = 1,
    displayId = null,
    createdAt = null,
    startedAt = null,
    finishedAt = null,
    failure = null,
    succeeded = 0,
    failed = 0,
    unknown = 0,
    skipped = 0,
  }) => {
    const jobId = randomUUID();
    const [row] = await admin(
      `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
        target_count,succeeded,failed,unknown,skipped,failure,correlation_id,created_at,started_at,finished_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        COALESCE($16,clock_timestamp()),COALESCE($17,$16,clock_timestamp()),$18)
      RETURNING *`,
      [
        jobId,
        displayId ?? (await nextDisplay(kind)),
        customer,
        kind,
        scope,
        status,
        requestedBy,
        generation,
        targetCount,
        succeeded,
        failed,
        unknown,
        skipped,
        failure,
        randomUUID(),
        createdAt,
        startedAt,
        finishedAt,
      ],
    );
    return row;
  };
  const nextDisplay = async (kind) =>
    (
      await adminRow(
        `SELECT cc.job_display_id($1,nextval($2::regclass)) AS id`,
        [
          kind === 'device-update' ? 'UPD' : 'REF',
          kind === 'device-update' ? 'cc.job_number_upd' : 'cc.job_number_ref',
        ],
      )
    ).id;
  /** One write job with its preview, detail row, and operations. */
  const writeJob = async ({
    requestedBy,
    operations = 1,
    failed = 0,
    unknown = 0,
    status = 'completed',
    createdAt = null,
  }) => {
    const job = await header({
      requestedBy,
      targetCount: operations,
      status,
      failed,
      unknown,
      succeeded: operations - failed - unknown,
      createdAt,
    });
    const previewId = randomUUID();
    await admin(
      `INSERT INTO cc.device_update_previews(preview_id,display_id,customer_id,created_by,permission_version,
        generation,action,field,mode,value,selected,eligible,unchanged,excluded,manifest_digest,expires_at)
      VALUES($1,cc.job_display_id('PV',nextval('cc.preview_number_pv')),$2,$3,1,$4,'annotated-location','annotatedLocation',
        'replace','Room 12',$5,$5,0,0,'digest',clock_timestamp()+interval '1 hour')`,
      [previewId, customer, requestedBy, generation, operations],
    );
    await admin(
      `INSERT INTO cc.device_update_jobs(job_id,preview_id,action,field,mode,value,confirmed_by,
        confirmer_permission_version,delegated_subject,batch_size,batch_count)
      VALUES($1,$2,'annotated-location','annotatedLocation','replace','Room 12',$3,1,'admin@example.org',250,$4)`,
      [
        job.job_id,
        previewId,
        requestedBy,
        Math.max(1, Math.ceil(operations / 250)),
      ],
    );
    for (let index = 1; index <= operations; index += 1) {
      const outcome =
        index <= failed
          ? 'failed'
          : index <= failed + unknown
            ? 'unknown'
            : 'succeeded';
      await admin(
        `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,serial_number,
          org_unit_path,baseline_value,requested_value,batch,status,outcome_reason,google_status,
          google_reason,updated_at)
        VALUES($1,$2,$3,$4,'/School A','Room 1','Room 12',$5,$6,
          CASE WHEN $6='failed' THEN 'not-found' WHEN $6='unknown' THEN 'ambiguous' END,
          CASE WHEN $6='failed' THEN 404 END,
          CASE WHEN $6='failed' THEN 'notFound' END,
          clock_timestamp()-(interval '1 second' * $2::int))`,
        [
          job.job_id,
          index,
          `device-${index}`,
          `SN-${index}`,
          Math.floor((index - 1) / 250),
          outcome,
        ],
      );
    }
    return job;
  };

  // --- The live stream harness: the production controllers, a real fanout on a test Redis, and
  // --- the jobs and Devices reads through the runtime role.
  const docker = (...args) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const redisContainer = `cc-b4-redis-${randomBytes(6).toString('hex')}`;
  const liveSessions = new Map();
  let publisher;
  let fanout;
  // The stream ping reads the session afresh. This stand-in returns what the session store holds,
  // so a revoked grant reaches the recheck as the real authenticate would return it.
  const streamAuth = {
    async authenticate(cookie) {
      const found = liveSessions.get(cookie);
      if (!found) throw new Error('session-expired');
      return found;
    },
    async authorize(streamSession, action, resource) {
      const allowed = streamSession.identity.grants.some(
        (grant) =>
          grant.action === action &&
          (grant.scope.kind === 'platform' ||
            (grant.scope.kind === 'district' &&
              grant.scope.customerId === resource.customerId)),
      );
      if (!allowed)
        throw Object.assign(new Error('forbidden'), { status: 403 });
    },
  };
  const jobsService = new JobsService({
    connection: { query: (text, values) => runtime.query(text, values) },
  });
  const devicesService = new DevicesService(
    { connection: { query: (text, values) => runtime.query(text, values) } },
    {},
    {},
  );
  /** One SSE response stand-in. The production controller writes its frames here. */
  const sseSink = () => {
    const emitter = new EventEmitter();
    const sink = {
      chunks: [],
      ended: false,
      headersSent: false,
      writableLength: 0,
      writeHead() {
        sink.headersSent = true;
      },
      write(chunk) {
        sink.chunks.push(chunk);
        return true;
      },
      end() {
        sink.ended = true;
      },
      once(name, listener) {
        emitter.once(name, listener);
      },
      disconnect() {
        emitter.emit('close');
      },
    };
    return sink;
  };
  const streamFrames = (sink) =>
    sink.chunks
      .filter((chunk) => chunk.startsWith('event: '))
      .map((chunk) => {
        const [head, data] = chunk.split('\n');
        return {
          name: head.slice('event: '.length),
          data: JSON.parse(data.slice('data: '.length)),
        };
      });
  const until = async (done, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (!done() && Date.now() < deadline) await sleep(10);
  };
  const openJobsStream = async (principalId, grants) => {
    const cookie = `cc-b4-${randomUUID()}`;
    const current = session(principalId, grants);
    liveSessions.set(cookie, current);
    const sink = sseSink();
    const controller = new JobsController(jobsService, streamAuth, { fanout });
    await controller.events(
      { session: current, headers: { cookie }, correlationId: randomUUID() },
      sink,
    );
    return { sink, cookie };
  };
  const openDevicesStream = async (principalId, grants) => {
    const cookie = `cc-b4-${randomUUID()}`;
    const current = session(principalId, grants);
    liveSessions.set(cookie, current);
    const sink = sseSink();
    const controller = new DevicesController(devicesService, streamAuth, {
      fanout,
    });
    await controller.events(
      { session: current, headers: { cookie }, correlationId: randomUUID() },
      sink,
    );
    return { sink, cookie };
  };
  /** Start the test Redis, the fanout on it, and the publisher. */
  const startStreams = async () => {
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      redisContainer,
      '-p',
      '127.0.0.1::6379',
      redisImage,
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
      '--protected-mode',
      'no',
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (docker('exec', redisContainer, 'redis-cli', 'ping') === 'PONG')
          break;
      } catch {
        /* Retry bounded startup. */
      }
      await sleep(100);
    }
    const port = Number(
      docker('port', redisContainer, '6379/tcp').split(':').at(-1),
    );
    const url = `redis://127.0.0.1:${port}`;
    publisher = createClient({
      url,
      disableOfflineQueue: true,
      socket: { reconnectStrategy: false },
    });
    publisher.on('error', () => {
      /* A failed command reports its own error. */
    });
    await publisher.connect();
    await publisher.ping();
    fanout = new EventFanout(async (lost) => {
      const client = createClient({
        url,
        disableOfflineQueue: true,
        socket: { reconnectStrategy: false },
      });
      client.on('error', () => {
        /* The loss listener reports the stream close. */
      });
      return redisSubscriber(client, lost);
    });
  };
  const publish = async (channel, event) => {
    await publisher.publish(channel, JSON.stringify(event));
  };
  const stopStreams = async () => {
    await fanout?.close().catch(() => undefined);
    try {
      publisher?.destroy();
    } catch {
      /* The client did not connect. */
    }
    try {
      docker('rm', '-f', redisContainer);
    } catch {
      /* The container was not created. */
    }
  };

  const owner = await principal(`owner-${randomUUID()}`, [
    ['devices:read', district()],
  ]);
  const reader = await principal(`reader-${randomUUID()}`, [
    ['devices:read', district()],
  ]);
  const auditor = await principal(`auditor-${randomUUID()}`, [
    ['devices:read', district()],
    ['jobs:read', district()],
  ]);
  const jobReader = await principal(`jobreader-${randomUUID()}`, [
    ['jobs:read', district()],
  ]);
  const platform = await principal(`platform-${randomUUID()}`, [
    ['devices:read', district()],
    ['jobs:read', { kind: 'platform' }],
  ]);
  const foreign = await principal(`foreign-${randomUUID()}`, [
    ['devices:read', district()],
    ['jobs:read', district('C-other')],
  ]);
  const disabled = await principal(
    `disabled-${randomUUID()}`,
    [['jobs:read', district()]],
    false,
  );
  const ownerSession = session(owner, [
    { action: 'devices:read', scope: district() },
  ]);
  const auditorSession = session(auditor, [
    { action: 'devices:read', scope: district() },
    { action: 'jobs:read', scope: district() },
  ]);
  const jobReaderSession = session(jobReader, [
    { action: 'jobs:read', scope: district() },
  ]);

  try {
    await check(
      'the two new functions are SECURITY DEFINER, revoked from PUBLIC, and granted',
      async () => {
        const rows = await admin(
          `SELECT proname,prosecdef,proconfig::text AS config,proacl::text AS acl
          FROM pg_proc WHERE proname IN ('job_reader','record_job_activity_seen') ORDER BY proname`,
        );
        assert.equal(rows.length, 2);
        for (const row of rows) {
          assert.equal(row.prosecdef, true);
          assert.match(row.config, /search_path=pg_catalog, cc/);
          assert.match(row.acl ?? '', /cc-app/);
          assert.equal(
            /(^|,)=X\//.test(row.acl ?? ''),
            false,
            `${row.proname} grants PUBLIC`,
          );
        }
      },
    );

    await check(
      'a caller with jobs:read and without devices:read lists, reads, posts seen, and opens the stream',
      async () => {
        await reset();
        const job = await writeJob({ requestedBy: jobReader });
        assert.equal(await jobs.customer(jobReaderSession), customer);
        const page = await jobs.list(
          jobReaderSession,
          customer,
          {},
          undefined,
          10,
        );
        assert.deepEqual(
          page.jobs.map((entry) => entry.displayId),
          [job.display_id],
        );
        const detail = await jobs.detail(
          jobReaderSession,
          customer,
          job.display_id,
        );
        assert.equal(detail.displayId, job.display_id);
        const activity = await jobs.activity(jobReaderSession, customer);
        assert.equal(activity.running.count, 0);
        const first = await jobs.seen(jobReaderSession);
        assert.ok(first.seenAt);
        assert.equal(
          await jobs.visible(jobReaderSession, customer, owner),
          true,
        );
        assert.equal(await jobs.visible(ownerSession, customer, reader), false);
        await sleep(10);
        const second = await jobs.seen(jobReaderSession);
        assert.ok(
          Date.parse(second.seenAt) > Date.parse(first.seenAt),
          'The second seen time is later.',
        );
      },
    );

    await check(
      'both functions reject a disabled principal and a stale permission version with 42501',
      async () => {
        await rejects(
          query('SELECT customer_id FROM cc.job_reader($1,$2)', [disabled, 1]),
          '42501',
        );
        await rejects(
          query('SELECT cc.record_job_activity_seen($1,$2)', [disabled, 1]),
          '42501',
        );
        const version = (
          await adminRow(
            'SELECT permission_version FROM cc.application_principals WHERE id=$1',
            [owner],
          )
        ).permission_version;
        await rejects(
          query('SELECT customer_id FROM cc.job_reader($1,$2)', [
            owner,
            version + 1,
          ]),
          '42501',
        );
        await rejects(
          query('SELECT cc.record_job_activity_seen($1,$2)', [
            owner,
            version + 1,
          ]),
          '42501',
        );
        const error = await rejects(
          query('SELECT cc.record_job_activity_seen($1,$2)', [disabled, 1]),
          '42501',
        );
        assert.equal(error.message, 'Job read authority is required.');
      },
    );

    await check(
      'the seen write locks only its own row and takes no advisory lock',
      async () => {
        await runtime.query('BEGIN');
        try {
          await runtime.query('SELECT cc.record_job_activity_seen($1,$2)', [
            owner,
            1,
          ]);
          const locks = await runtime.query(
            `SELECT count(*)::int AS count FROM pg_locks
            WHERE pid=pg_backend_pid() AND locktype='advisory'`,
          );
          assert.equal(locks.rows[0].count, 0);
        } finally {
          await runtime.query('ROLLBACK');
        }
      },
    );

    await check(
      'a stale-page refresh and a Refresh all show as REF- jobs with requesters',
      async () => {
        await reset();
        const refreshId = randomUUID();
        await statement(
          'SELECT cc.create_entity_sync_job($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            owner,
            1,
            customer,
            'device',
            JSON.stringify(['d1', 'd2']),
            100,
            refreshId,
            randomUUID(),
          ],
        );
        const syncId = randomUUID();
        await statement('SELECT cc.request_device_sync($1,$2,$3,$4,$5,$6)', [
          owner,
          1,
          customer,
          generation,
          syncId,
          randomUUID(),
        ]);
        const page = await jobs.list(
          auditorSession,
          customer,
          {},
          undefined,
          10,
        );
        const refresh = page.jobs.find((entry) => entry.jobId === refreshId);
        assert.ok(refresh);
        assert.equal(refresh.action, 'refresh-inventory');
        assert.equal(refresh.requestedBy.id, owner);
        assert.equal(refresh.scope.kind, 'devices');
        assert.equal(refresh.progress.total, 2);
        const fullSync = page.jobs.find((entry) => entry.jobId === syncId);
        assert.equal(fullSync.scope.kind, 'all-devices');
        assert.equal(fullSync.progress.total, null);
        assert.equal(fullSync.progress.pending, null);
        assert.equal(fullSync.status, 'running');
        const detail = await jobs.detail(
          auditorSession,
          customer,
          fullSync.displayId,
        );
        assert.equal(detail.confirmedBy, null);
        assert.deepEqual(detail.latestActivity.failed.operations, []);
        await statement('SELECT cc.abandon_device_sync($1,$2,$3,$4,$5)', [
          owner,
          1,
          customer,
          syncId,
          'orchestration-unavailable',
        ]);
      },
    );

    await check(
      'an empty inventory finishes completed with 0 devices',
      async () => {
        await reset();
        const syncId = randomUUID();
        const attempt = randomUUID();
        await statement('SELECT cc.request_device_sync($1,$2,$3,$4,$5,$6)', [
          owner,
          1,
          customer,
          generation,
          syncId,
          randomUUID(),
        ]);
        await statement('SELECT cc.claim_device_sync($1,$2,$3)', [
          customer,
          syncId,
          attempt,
        ]);
        await statement('SELECT cc.finish_device_sync($1,$2,$3,$4,$5)', [
          customer,
          syncId,
          attempt,
          null,
          null,
        ]);
        const job = await adminRow('SELECT * FROM cc.jobs WHERE job_id=$1', [
          syncId,
        ]);
        assert.equal(job.status, 'completed');
        assert.equal(job.target_count, 0);
        const detail = await jobs.detail(
          auditorSession,
          customer,
          job.display_id,
        );
        assert.equal(detail.progress.total, 0);
        assert.equal(detail.progress.pending, 0);
      },
    );

    await check('a large inventory shows its full count', async () => {
      await reset();
      const syncId = randomUUID();
      const attempt = randomUUID();
      await statement('SELECT cc.request_device_sync($1,$2,$3,$4,$5,$6)', [
        owner,
        1,
        customer,
        generation,
        syncId,
        randomUUID(),
      ]);
      await statement('SELECT cc.claim_device_sync($1,$2,$3)', [
        customer,
        syncId,
        attempt,
      ]);
      for (let start = 1; start <= 1001; start += 1000) {
        const devices = Array.from(
          { length: Math.min(1000, 1001 - start + 1) },
          (_, index) => ({
            deviceId: `bulk-${start + index}`,
            serialNumber: `SN-${start + index}`,
            orgUnitPath: '/School A',
            status: 'ACTIVE',
          }),
        );
        await statement('SELECT cc.stage_devices($1,$2,$3,$4)', [
          customer,
          syncId,
          attempt,
          JSON.stringify(devices),
        ]);
      }
      await statement('SELECT cc.finish_device_sync($1,$2,$3,$4,$5)', [
        customer,
        syncId,
        attempt,
        null,
        null,
      ]);
      const job = await adminRow('SELECT * FROM cc.jobs WHERE job_id=$1', [
        syncId,
      ]);
      assert.equal(job.target_count, 1001);
      assert.equal(job.status, 'completed');
      const detail = await jobs.detail(
        auditorSession,
        customer,
        job.display_id,
      );
      assert.equal(detail.progress.total, 1001);
      assert.equal(detail.progress.succeeded, 1001);
    });

    await check(
      'the list sorts by created time and display ID, and the keyset is stable',
      async () => {
        await reset();
        const base = Date.parse('2026-10-06T12:00:00.000Z');
        const created = [];
        for (let index = 0; index < 5; index += 1)
          created.push(
            await header({
              requestedBy: auditor,
              status: 'completed',
              createdAt: new Date(base + index * 60_000).toISOString(),
              finishedAt: new Date(base + index * 60_000).toISOString(),
            }),
          );
        const seen = [];
        let cursor;
        for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
          const page = await jobs.list(auditorSession, customer, {}, cursor, 2);
          assert.equal(page.matching, 5);
          seen.push(...page.jobs.map((entry) => entry.displayId));
          cursor = page.nextCursor ?? undefined;
          if (!cursor) break;
        }
        assert.deepEqual(
          seen,
          [...created]
            .sort(
              (left, right) =>
                right.created_at - left.created_at ||
                String(right.display_id).localeCompare(String(left.display_id)),
            )
            .map((entry) => entry.display_id),
        );
      },
    );

    await check('each list filter selects its rows', async () => {
      await reset();
      const old = new Date('2026-10-01T12:00:00.000Z').toISOString();
      const recent = new Date('2026-10-06T12:00:00.000Z').toISOString();
      const failed = await header({
        requestedBy: auditor,
        status: 'failed',
        failure: 'quota',
        createdAt: old,
        finishedAt: new Date('2026-10-01T12:01:00.000Z').toISOString(),
      });
      const running = await header({
        requestedBy: owner,
        status: 'running',
        createdAt: recent,
        finishedAt: null,
      });
      const refresh = await header({
        kind: 'inventory-refresh',
        requestedBy: owner,
        status: 'completed',
        createdAt: recent,
        finishedAt: new Date('2026-10-06T12:05:00.000Z').toISOString(),
      });
      const ids = async (filters) =>
        (
          await jobs.list(auditorSession, customer, filters, undefined, 100)
        ).jobs.map((entry) => entry.jobId);
      assert.deepEqual(await ids({ jobId: failed.display_id }), [
        failed.job_id,
      ]);
      assert.deepEqual(await ids({ status: ['failed'] }), [failed.job_id]);
      assert.deepEqual(await ids({ action: ['refresh-inventory'] }), [
        refresh.job_id,
      ]);
      assert.deepEqual(
        await ids({ requestedBy: [owner] }).then((rows) => rows.sort()),
        [running.job_id, refresh.job_id].sort(),
      );
      assert.deepEqual(
        await ids({ createdFrom: '2026-10-05T00:00:00.000Z' }).then((rows) =>
          rows.sort(),
        ),
        [running.job_id, refresh.job_id].sort(),
      );
      assert.deepEqual(await ids({ createdTo: '2026-10-02T00:00:00.000Z' }), [
        failed.job_id,
      ]);
      assert.deepEqual(
        await ids({ finishedFrom: '2026-10-06T00:00:00.000Z' }),
        [refresh.job_id],
      );
      assert.deepEqual(await ids({ finishedTo: '2026-10-02T00:00:00.000Z' }), [
        failed.job_id,
      ]);
      assert.deepEqual(
        await ids({ entityType: ['device'] }).then((rows) => rows.sort()),
        [failed.job_id, running.job_id, refresh.job_id].sort(),
      );
    });

    await check(
      'the activity badge follows a job that starts and finishes',
      async () => {
        await reset();
        const job = await header({
          requestedBy: auditor,
          status: 'queued',
          targetCount: 4,
          createdAt: new Date().toISOString(),
        });
        let activity = await jobs.activity(auditorSession, customer);
        assert.equal(activity.running.count, 0);
        assert.equal(activity.waiting.count, 1);
        await admin("UPDATE cc.jobs SET status='running' WHERE job_id=$1", [
          job.job_id,
        ]);
        activity = await jobs.activity(auditorSession, customer);
        assert.equal(activity.running.count, 1);
        assert.equal(activity.waiting.count, 0);
        await admin(
          "UPDATE cc.jobs SET status='failed',failure='quota',finished_at=clock_timestamp() WHERE job_id=$1",
          [job.job_id],
        );
        activity = await jobs.activity(auditorSession, customer);
        assert.equal(activity.running.count, 0);
        assert.equal(activity.recent.count, 1);
        assert.equal(activity.attention, true);
      },
    );

    await check(
      'the activity sections cap at 50 running, 50 waiting, and 10 recent rows',
      async () => {
        await reset();
        await admin(
          `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
          target_count,correlation_id,created_at,started_at)
        SELECT gen_random_uuid(),cc.job_display_id('REF',nextval('cc.job_number_ref')),$1,
          'inventory-refresh','devices','running',$2,$3,1,gen_random_uuid(),clock_timestamp(),clock_timestamp()
        FROM generate_series(1,51)`,
          [customer, auditor, generation],
        );
        await admin(
          `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
          target_count,correlation_id,created_at)
        SELECT gen_random_uuid(),cc.job_display_id('REF',nextval('cc.job_number_ref')),$1,
          'inventory-refresh','devices','queued',$2,$3,1,gen_random_uuid(),clock_timestamp()
        FROM generate_series(1,51)`,
          [customer, auditor, generation],
        );
        await admin(
          `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
          target_count,correlation_id,created_at,finished_at)
        SELECT gen_random_uuid(),cc.job_display_id('REF',nextval('cc.job_number_ref')),$1,
          'inventory-refresh','devices','failed',$2,$3,1,gen_random_uuid(),
          clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour'
        FROM generate_series(1,11)`,
          [customer, auditor, generation],
        );
        const activity = await jobs.activity(auditorSession, customer);
        assert.equal(activity.running.count, 51);
        assert.equal(activity.running.jobs.length, 50);
        assert.equal(activity.waiting.count, 51);
        assert.equal(activity.waiting.jobs.length, 50);
        assert.equal(activity.recent.count, 11);
        assert.equal(activity.recent.jobs.length, 10);
        assert.ok(activity.recent.nextExpiryAt);
      },
    );

    await check(
      'attention clears after seen, and the window expires from the oldest counted job',
      async () => {
        await reset();
        await admin(
          `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
          target_count,correlation_id,created_at,finished_at)
        SELECT gen_random_uuid(),cc.job_display_id('REF',nextval('cc.job_number_ref')),$1,
          'inventory-refresh','devices','failed',$2,$3,1,gen_random_uuid(),
          clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour'
        FROM generate_series(1,2)`,
          [customer, auditor, generation],
        );
        const oldest = await adminRow(
          `SELECT finished_at + interval '24 hours' AS expiry,
          (SELECT min(finished_at) FROM cc.jobs WHERE customer_id=$1
            AND finished_at IS NOT NULL) AS first FROM cc.jobs
          WHERE customer_id=$1 AND finished_at IS NOT NULL ORDER BY finished_at LIMIT 1`,
          [customer],
        );
        let activity = await jobs.activity(auditorSession, customer);
        assert.equal(activity.attention, true);
        assert.equal(activity.seenAt, null);
        assert.ok(
          Math.abs(
            Date.parse(activity.recent.nextExpiryAt) -
              (Date.parse(oldest.first) + 24 * 3_600_000),
          ) < 1000,
        );
        const seen = await jobs.seen(auditorSession);
        activity = await jobs.activity(auditorSession, customer);
        assert.equal(activity.attention, false);
        assert.equal(activity.seenAt, seen.seenAt);
        await reset();
        const empty = await jobs.activity(auditorSession, customer);
        assert.equal(empty.recent.count, 0);
        assert.equal(empty.recent.nextExpiryAt, null);
      },
    );

    await check(
      'each job read applies cc.job_visible: a devices:read caller sees only its own jobs',
      async () => {
        await reset();
        const finished = new Date().toISOString();
        const mine = await header({
          requestedBy: owner,
          status: 'completed',
          finishedAt: finished,
        });
        const other = await header({
          requestedBy: reader,
          status: 'completed',
          finishedAt: finished,
        });
        const page = await jobs.list(ownerSession, customer, {}, undefined, 10);
        assert.deepEqual(
          page.jobs.map((entry) => entry.jobId),
          [mine.job_id],
        );
        await assert.rejects(
          jobs.detail(ownerSession, customer, other.display_id),
          (error) => error.status === 404,
        );
        await assert.rejects(
          jobs.operations(
            ownerSession,
            customer,
            other.display_id,
            false,
            undefined,
            10,
          ),
          (error) => error.status === 404,
        );
        const activity = await jobs.activity(ownerSession, customer);
        assert.equal(activity.recent.count, 1);
        const requesters = await jobs.requesters(
          ownerSession,
          customer,
          '',
          20,
        );
        assert.deepEqual(
          requesters.requesters.map((entry) => entry.id),
          [owner],
        );
        const auditorPage = await jobs.list(
          auditorSession,
          customer,
          {},
          undefined,
          10,
        );
        assert.equal(auditorPage.jobs.length, 2);
        const platformPage = await jobs.list(
          session(platform, [
            { action: 'devices:read', scope: district() },
            { action: 'jobs:read', scope: { kind: 'platform' } },
          ]),
          customer,
          {},
          undefined,
          10,
        );
        assert.equal(platformPage.jobs.length, 2);
        const foreignPage = await jobs.list(
          session(foreign, [
            { action: 'devices:read', scope: district() },
            { action: 'jobs:read', scope: district('C-other') },
          ]),
          customer,
          {},
          undefined,
          10,
        );
        assert.equal(foreignPage.jobs.length, 0);
      },
    );

    await check(
      'the requesters answer lists each visible requester once, by prefix',
      async () => {
        await reset();
        await header({ requestedBy: auditor, status: 'completed' });
        await header({ requestedBy: auditor, status: 'completed' });
        const all = await jobs.requesters(auditorSession, customer, '', 20);
        assert.equal(
          all.requesters.filter((entry) => entry.id === auditor).length,
          1,
        );
        const none = await jobs.requesters(auditorSession, customer, 'zzz', 20);
        assert.deepEqual(none.requesters, []);
      },
    );

    await check(
      'the detail moves revision and Latest activity with each recorded change',
      async () => {
        await reset();
        const job = await writeJob({
          requestedBy: auditor,
          operations: 3,
          unknown: 2,
        });
        const first = await jobs.detail(
          auditorSession,
          customer,
          job.display_id,
        );
        assert.equal(first.revision, 1);
        const at = first.latestActivity.at;
        await admin(
          `UPDATE cc.device_update_operations SET status='succeeded',outcome_reason=NULL,verified_by='write-response',
          updated_at=clock_timestamp() WHERE job_id=$1 AND operation_number=1`,
          [job.job_id],
        );
        await admin(
          `UPDATE cc.jobs SET unknown=1,succeeded=2,revision=revision+1,changed_at=clock_timestamp() WHERE job_id=$1`,
          [job.job_id],
        );
        const second = await jobs.detail(
          auditorSession,
          customer,
          job.display_id,
        );
        assert.equal(second.revision, first.revision + 1);
        assert.ok(Date.parse(second.latestActivity.at) > Date.parse(at));
        assert.equal(second.latestActivity.unknown.count, 1);
        assert.equal(second.latestActivity.unknown.operations.length, 1);
      },
    );

    await check(
      'Latest activity names failures from the whole job, not the visible page',
      async () => {
        await reset();
        const job = await writeJob({
          requestedBy: auditor,
          operations: 300,
          failed: 0,
          unknown: 3,
        });
        await admin(
          `UPDATE cc.device_update_operations SET status='failed',outcome_reason='not-found',
          google_status=404,google_reason='notFound',updated_at=clock_timestamp()
        WHERE job_id=$1 AND operation_number IN (298,299,300)`,
          [job.job_id],
        );
        await admin(
          `UPDATE cc.jobs SET failed=5,unknown=3,succeeded=292,revision=revision+1,
          changed_at=clock_timestamp() WHERE job_id=$1`,
          [job.job_id],
        );
        const detail = await jobs.detail(
          auditorSession,
          customer,
          job.display_id,
        );
        assert.equal(detail.latestActivity.failed.count, 5);
        assert.equal(detail.latestActivity.failed.operations.length, 3);
        assert.equal(detail.latestActivity.unknown.operations.length, 3);
        for (const sample of [
          ...detail.latestActivity.failed.operations,
          ...detail.latestActivity.unknown.operations,
        ])
          assert.ok(sample.updatedAt);
        assert.ok(
          detail.latestActivity.failed.operations.some(
            (sample) => Number(sample.operationId.split('-').at(-1)) > 250,
          ),
          'A failed sample sits past the first operations page.',
        );
        const secondPage = await jobs.operations(
          auditorSession,
          customer,
          job.display_id,
          true,
          '100',
          100,
        );
        assert.ok(
          secondPage.operations.every((operation) =>
            ['failed', 'unknown'].includes(operation.outcome),
          ),
        );
        assert.equal(
          secondPage.operations.length,
          3,
          'The second page holds the failed operations beyond operation 100.',
        );
      },
    );

    await check(
      'a refresh job returns empty Latest activity samples',
      async () => {
        await reset();
        const refreshId = randomUUID();
        await statement(
          'SELECT cc.create_entity_sync_job($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            owner,
            1,
            customer,
            'device',
            JSON.stringify(['d1']),
            100,
            refreshId,
            randomUUID(),
          ],
        );
        const job = await adminRow('SELECT * FROM cc.jobs WHERE job_id=$1', [
          refreshId,
        ]);
        const detail = await jobs.detail(
          auditorSession,
          customer,
          job.display_id,
        );
        assert.deepEqual(detail.latestActivity.failed.operations, []);
        assert.deepEqual(detail.latestActivity.unknown.operations, []);
        assert.equal(detail.latestActivity.at, job.changed_at.toISOString());
      },
    );

    await check(
      'the list keyset keeps database microseconds and equal created times',
      async () => {
        await reset();
        const late = await header({
          requestedBy: auditor,
          status: 'completed',
          createdAt: '2026-10-06T12:00:00.123900Z',
        });
        const middle = await header({
          requestedBy: auditor,
          status: 'completed',
          createdAt: '2026-10-06T12:00:00.123800Z',
        });
        const early = await header({
          requestedBy: auditor,
          status: 'completed',
          createdAt: '2026-10-06T12:00:00.122000Z',
        });
        const seen = [];
        let cursor;
        for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
          const page = await jobs.list(auditorSession, customer, {}, cursor, 1);
          assert.equal(page.matching, 3);
          seen.push(...page.jobs.map((entry) => entry.displayId));
          cursor = page.nextCursor ?? undefined;
          if (!cursor) break;
        }
        assert.deepEqual(seen, [
          late.display_id,
          middle.display_id,
          early.display_id,
        ]);

        await reset();
        const first = await header({
          requestedBy: auditor,
          status: 'completed',
          createdAt: '2026-10-06T12:00:00.123900Z',
        });
        const second = await header({
          requestedBy: auditor,
          status: 'completed',
          createdAt: '2026-10-06T12:00:00.123900Z',
        });
        const firstPage = await jobs.list(
          auditorSession,
          customer,
          {},
          undefined,
          1,
        );
        assert.equal(firstPage.jobs.length, 1);
        assert.ok(firstPage.nextCursor);
        const secondPage = await jobs.list(
          auditorSession,
          customer,
          {},
          firstPage.nextCursor,
          1,
        );
        assert.equal(secondPage.jobs.length, 1);
        assert.equal(secondPage.nextCursor, null);
        assert.deepEqual(
          [firstPage.jobs[0].displayId, secondPage.jobs[0].displayId].sort(),
          [first.display_id, second.display_id].sort(),
        );
      },
    );

    await check(
      'attention compares the stored seen time at database precision',
      async () => {
        await reset();
        await header({
          requestedBy: auditor,
          status: 'failed',
          failure: 'quota',
          createdAt: '2026-10-06T12:00:00.000000Z',
          finishedAt: '2026-10-06T12:00:00.123800Z',
        });
        await admin(
          `INSERT INTO cc.job_activity_seen(principal_id,seen_at)
          VALUES($1,'2026-10-06T12:00:00.123900Z')`,
          [auditor],
        );
        const activity = await jobs.activity(auditorSession, customer);
        assert.equal(
          activity.attention,
          false,
          'A job finished before the stored seen time needs no attention.',
        );
        assert.equal(
          activity.seenAt,
          '2026-10-06T12:00:00.123Z',
          'The wire answer rounds the stored time.',
        );
      },
    );

    await startStreams();

    await check(
      'the jobs stream sends only job-changed events of visible jobs',
      async () => {
        await reset();
        // One job runs at a time per customer, so the two jobs wait in the queue.
        const mine = await header({ requestedBy: owner, status: 'queued' });
        const theirs = await header({ requestedBy: reader, status: 'queued' });
        const readGrant = { action: 'devices:read', scope: district() };
        const jobsGrant = { action: 'jobs:read', scope: district() };
        const ownerStream = await openJobsStream(owner, [readGrant]);
        const auditorStream = await openJobsStream(auditor, [
          readGrant,
          jobsGrant,
        ]);
        // jobs:read alone opens the stream, without devices:read.
        const jobsOnlyStream = await openJobsStream(jobReader, [jobsGrant]);
        const jobFrame = (row, revision = 2) => ({
          type: 'job-changed',
          jobId: row.job_id,
          displayId: row.display_id,
          revision,
          requestedBy: row.requested_by,
        });
        try {
          await publish(jobEventsChannel(customer), jobFrame(mine));
          await publish(jobEventsChannel(customer), jobFrame(theirs));
          // None of these may reach the Jobs stream.
          await publish(jobEventsChannel(customer), {
            type: 'entity-batch',
            jobId: mine.job_id,
            entityType: 'device',
            batch: 0,
            batchCount: 1,
            deviceIds: ['device-1'],
            removedIds: [],
          });
          await publish(entityEventsChannel(customer), jobFrame(mine));
          await publish(jobEventsChannel('C-other'), jobFrame(mine));
          await until(
            () =>
              streamFrames(ownerStream.sink).length >= 1 &&
              streamFrames(auditorStream.sink).length >= 2 &&
              streamFrames(jobsOnlyStream.sink).length >= 2,
          );
          await sleep(300);
          const ownerFrames = streamFrames(ownerStream.sink);
          const auditorFrames = streamFrames(auditorStream.sink);
          const jobsOnlyFrames = streamFrames(jobsOnlyStream.sink);
          assert.deepEqual(
            ownerFrames.map((frame) => frame.data.jobId),
            [mine.job_id],
            'A requester sees its own job only.',
          );
          assert.deepEqual(
            auditorFrames.map((frame) => frame.data.jobId).sort(),
            [mine.job_id, theirs.job_id].sort(),
            'A jobs:read holder sees every job of the customer.',
          );
          assert.deepEqual(
            jobsOnlyFrames.map((frame) => frame.data.jobId).sort(),
            [mine.job_id, theirs.job_id].sort(),
            'The stream opened with jobs:read alone.',
          );
          for (const frame of [
            ...ownerFrames,
            ...auditorFrames,
            ...jobsOnlyFrames,
          ])
            assert.equal(frame.name, 'job-changed');
        } finally {
          ownerStream.sink.disconnect();
          auditorStream.sink.disconnect();
          jobsOnlyStream.sink.disconnect();
        }
      },
    );

    await check(
      'the jobs stream answers 503 when the subscription is unavailable',
      async () => {
        const sink = sseSink();
        const unavailable = new EventFanout(async () => {
          throw new Error('redis down');
        });
        const controller = new JobsController(jobsService, streamAuth, {
          fanout: unavailable,
        });
        await assert.rejects(
          controller.events(
            {
              session: jobReaderSession,
              headers: { cookie: 'cc-b4-unavailable' },
              correlationId: randomUUID(),
            },
            sink,
          ),
          (error) => error.getStatus?.() === 503,
          'The stream answers 503.',
        );
        assert.deepEqual(sink.chunks, []);
      },
    );

    await check(
      'the jobs stream closes at the next ping when read access is revoked',
      async () => {
        await reset();
        await header({ requestedBy: owner, status: 'running' });
        const readGrant = { action: 'devices:read', scope: district() };
        const jobsGrant = { action: 'jobs:read', scope: district() };
        const everyJobStream = await openJobsStream(auditor, [
          readGrant,
          jobsGrant,
        ]);
        const jobsOnlyStream = await openJobsStream(jobReader, [jobsGrant]);
        try {
          await admin(
            "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='jobs:read'",
            [auditor],
          );
          liveSessions.set(
            everyJobStream.cookie,
            session(auditor, [readGrant]),
          );
          await admin(
            "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='jobs:read'",
            [jobReader],
          );
          liveSessions.set(jobsOnlyStream.cookie, session(jobReader, []));
          await until(
            () => everyJobStream.sink.ended && jobsOnlyStream.sink.ended,
            30_000,
          );
          assert.equal(
            everyJobStream.sink.ended,
            true,
            'A changed visibility closes the stream.',
          );
          assert.equal(
            jobsOnlyStream.sink.ended,
            true,
            'A removed read action closes the stream.',
          );
        } finally {
          everyJobStream.sink.disconnect();
          jobsOnlyStream.sink.disconnect();
        }
      },
    );

    await check(
      'the Devices stream gives A, B, and C their own columns and every device ID',
      async () => {
        await reset();
        const readGrant = { action: 'devices:read', scope: district() };
        const jobsGrant = { action: 'jobs:read', scope: district() };
        const a = await principal(`stream-a-${randomUUID()}`, [
          ['devices:read', district()],
        ]);
        const b = await principal(`stream-b-${randomUUID()}`, [
          ['devices:read', district()],
        ]);
        const c = await principal(`stream-c-${randomUUID()}`, [
          ['devices:read', district()],
          ['jobs:read', district()],
        ]);
        // Step 1 of section 2.1: B's Refresh all read the Directory and its telemetry read failed.
        await admin(
          `UPDATE cc.device_sync_state SET observed_at=clock_timestamp(),device_count=2,
          sync_id=NULL,sync_actor=NULL,sync_generation=NULL,sync_attempt=NULL,sync_expires_at=NULL,
          failure=NULL,failure_requested_by=NULL,
          telemetry_failure='quota',telemetry_failure_requested_by=$2 WHERE customer_id=$1`,
          [customer, b],
        );
        const aStream = await openDevicesStream(a, [readGrant]);
        const bStream = await openDevicesStream(b, [readGrant]);
        const cStream = await openDevicesStream(c, [readGrant, jobsGrant]);
        try {
          const stepOne = (
            await adminRow('SELECT cc.device_sync_projection($1) AS sync', [
              customer,
            ])
          ).sync;
          await publish(entityEventsChannel(customer), {
            type: 'full-sync',
            sync: stepOne,
          });
          await until(
            () =>
              streamFrames(aStream.sink).length >= 1 &&
              streamFrames(bStream.sink).length >= 1 &&
              streamFrames(cStream.sink).length >= 1,
          );
          const [aOne] = streamFrames(aStream.sink);
          const [bOne] = streamFrames(bStream.sink);
          const [cOne] = streamFrames(cStream.sink);
          assert.equal(aOne.data.sync.telemetryFailure, null);
          assert.equal(bOne.data.sync.telemetryFailure, 'quota');
          assert.equal(cOne.data.sync.telemetryFailure, 'quota');

          // Every readable device ID reaches every devices:read holder, without job identity.
          const job = await header({ requestedBy: b, status: 'running' });
          await publish(entityEventsChannel(customer), {
            type: 'entity-batch',
            jobId: job.job_id,
            entityType: 'device',
            batch: 0,
            batchCount: 1,
            deviceIds: ['device-alpha', 'device-beta'],
            removedIds: ['device-gone'],
          });
          await until(
            () =>
              streamFrames(aStream.sink).length >= 2 &&
              streamFrames(bStream.sink).length >= 2 &&
              streamFrames(cStream.sink).length >= 2,
          );
          const [, aBatch] = streamFrames(aStream.sink);
          assert.deepEqual(aBatch.data, {
            type: 'entity-batch',
            entityType: 'device',
            deviceIds: ['device-alpha', 'device-beta'],
            removedIds: ['device-gone'],
          });
          assert.deepEqual(Object.keys(aBatch.data).sort(), [
            'deviceIds',
            'entityType',
            'removedIds',
            'type',
          ]);

          // Step 3: A's Directory read fails. B keeps the telemetry failure it owns.
          await admin(
            `UPDATE cc.device_sync_state SET failure='network-failure',failure_requested_by=$2
            WHERE customer_id=$1`,
            [customer, a],
          );
          const stepThree = (
            await adminRow('SELECT cc.device_sync_projection($1) AS sync', [
              customer,
            ])
          ).sync;
          await publish(entityEventsChannel(customer), {
            type: 'full-sync',
            sync: stepThree,
          });
          await until(
            () =>
              streamFrames(aStream.sink).length >= 3 &&
              streamFrames(bStream.sink).length >= 3 &&
              streamFrames(cStream.sink).length >= 3,
          );
          const [, , aThree] = streamFrames(aStream.sink);
          const [, , bThree] = streamFrames(bStream.sink);
          const [, , cThree] = streamFrames(cStream.sink);
          assert.equal(aThree.data.sync.failure, 'network-failure');
          assert.equal(aThree.data.sync.telemetryFailure, null);
          assert.equal(bThree.data.sync.failure, null);
          assert.equal(bThree.data.sync.telemetryFailure, 'quota');
          assert.equal(cThree.data.sync.failure, 'network-failure');
          assert.equal(cThree.data.sync.telemetryFailure, 'quota');

          // The job failure of B reaches B and C, never A. This is DevicesService.jobFailure.
          await admin("UPDATE cc.jobs SET failure='quota' WHERE job_id=$1", [
            job.job_id,
          ]);
          await publish(entityEventsChannel(customer), {
            type: 'job-finished',
            job: {
              jobId: job.job_id,
              customerId: customer,
              entityType: 'device',
              batchCount: 1,
              completedBatches: 0,
              failedBatches: 1,
              failure: 'quota',
              createdAt: new Date(job.created_at).toISOString(),
              finishedAt: new Date().toISOString(),
            },
          });
          await until(
            () =>
              streamFrames(aStream.sink).length >= 4 &&
              streamFrames(bStream.sink).length >= 4 &&
              streamFrames(cStream.sink).length >= 4,
          );
          const [, , , aFinished] = streamFrames(aStream.sink);
          const [, , , bFinished] = streamFrames(bStream.sink);
          const [, , , cFinished] = streamFrames(cStream.sink);
          assert.equal(aFinished.data.failure, null);
          assert.equal(bFinished.data.failure, 'quota');
          assert.equal(cFinished.data.failure, 'quota');
          for (const frame of [aFinished, bFinished, cFinished])
            assert.deepEqual(Object.keys(frame.data).sort(), [
              'failure',
              'type',
            ]);

          // A job-finished event without a header row reads as a null failure.
          await publish(entityEventsChannel(customer), {
            type: 'job-finished',
            job: {
              jobId: randomUUID(),
              customerId: customer,
              entityType: 'device',
              batchCount: 1,
              completedBatches: 0,
              failedBatches: 1,
              failure: 'quota',
              createdAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
          });
          await until(
            () =>
              streamFrames(aStream.sink).length >= 5 &&
              streamFrames(bStream.sink).length >= 5,
          );
          assert.equal(
            streamFrames(aStream.sink)[4].data.failure,
            null,
            'A missing job row never carries a failure.',
          );
          assert.equal(streamFrames(bStream.sink)[4].data.failure, null);
        } finally {
          aStream.sink.disconnect();
          bStream.sink.disconnect();
          cStream.sink.disconnect();
        }
      },
    );

    await check(
      'a ping closes the Devices stream when jobs:read is revoked',
      async () => {
        await reset();
        const readGrant = { action: 'devices:read', scope: district() };
        const jobsGrant = { action: 'jobs:read', scope: district() };
        const c = await principal(`stream-r-${randomUUID()}`, [
          ['devices:read', district()],
          ['jobs:read', district()],
        ]);
        await admin(
          `UPDATE cc.device_sync_state SET observed_at=clock_timestamp(),device_count=0,
          sync_id=NULL,sync_actor=NULL,sync_generation=NULL,sync_attempt=NULL,sync_expires_at=NULL,
          failure=NULL,failure_requested_by=NULL,telemetry_failure=NULL,
          telemetry_failure_requested_by=NULL WHERE customer_id=$1`,
          [customer],
        );
        const stream = await openDevicesStream(c, [readGrant, jobsGrant]);
        try {
          await admin(
            "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='jobs:read'",
            [c],
          );
          liveSessions.set(stream.cookie, session(c, [readGrant]));
          await until(() => stream.sink.ended, 30_000);
          assert.equal(
            stream.sink.ended,
            true,
            'A changed visibility closes the Devices stream.',
          );
        } finally {
          stream.sink.disconnect();
        }
      },
    );
  } finally {
    await stopStreams().catch(() => undefined);
    await migrator
      .query('UPDATE cc.google_connection SET active=$1 WHERE customer_id=$2', [
        wasActive,
        customer,
      ])
      .catch(() => undefined);
    await reset().catch(() => undefined);
    for (const id of principals)
      await migrator
        .query('DELETE FROM cc.application_principals WHERE id=$1', [id])
        .catch(() => undefined);
  }
  // The caller prints the results and exits zero. A recorded failure must fail the target.
  if (failures.length)
    throw new Error(`Jobs API checks failed: ${failures.join(' | ')}`);
  return results;
}
