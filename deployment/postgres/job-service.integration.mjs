import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ForbiddenException } from '@nestjs/common';
import { createClient } from 'redis';
import {
  entityEventsChannel,
  isAuthorized,
  jobEventsChannel,
} from '@campus/application-contracts';
import { redisImage } from '../redis/runtime.mjs';

// The B5 checks of design section 8.3: the job service of section 6, the relay of section 3.6,
// and the Reconcile route of section 2.6. Every check runs against the integration PostgreSQL
// instance through the runtime role, a real test Redis, and a recording fake orchestration.
const workspace = resolve(import.meta.dirname, '../..');
const load = (path) => import(pathToFileURL(resolve(workspace, path)).href);

export async function qualifyJobService({ runtime, migrator, issuer }) {
  const [
    { JobService, jobHoldKey, HOLD_WRITE_DEADLINE_MS },
    { CacheService },
    { Jobs },
    { JobsController },
    { ServiceResponseError },
    { DeviceUpdateJobs },
    { DeviceUpdatesController },
  ] = await Promise.all([
    load('api/src/app/jobs/job-service.ts'),
    load('api/src/app/cache/cache.service.ts'),
    load('api/src/app/jobs/jobs.ts'),
    load('api/src/app/jobs/jobs.controller.ts'),
    load('api/src/app/configuration/service-http.ts'),
    load('worker/src/device-update.ts'),
    load('api/src/app/devices/device-updates.controller.ts'),
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
      process.stderr.write(`check ${results.at(-1)}\n`);
      process.stderr.write(
        `${String(error.stack).split('\n').slice(0, 8).join('\n')}\n`,
      );
      return;
    }
    process.stderr.write(`check ${results.at(-1)}\n`);
  };
  const admin = (text, values = []) =>
    migrator.query(text, values).then((rows) => rows.rows);
  const adminRow = (text, values = []) =>
    migrator.query(text, values).then((rows) => rows.rows[0]);
  const statement = (text, values = []) =>
    runtime.query(text, values).then((rows) => rows.rows);
  const result = (text, values = []) =>
    runtime.query(text, values).then((rows) => rows.rows[0]?.result);

  await migrator.query('UPDATE cc.google_connection SET active=true');
  const principal = async (subject, grants = []) => {
    const id = randomUUID();
    principals.push(id);
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name,enabled) VALUES($1,$2,$3,$3,true)',
      [id, issuer, subject],
    );
    for (const [action, scope] of grants)
      await migrator.query(
        'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
        [id, action, JSON.stringify(scope)],
      );
    return id;
  };
  const district = { kind: 'district', customerId: customer };
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
  const owner = await principal(`b5-owner-${randomUUID()}`, [
    ['devices:read', district],
    ['devices:write', district],
    ['devices:bulk-actions', district],
    ['jobs:read', district],
  ]);
  const writeOnly = await principal(`b5-write-${randomUUID()}`, [
    ['devices:read', district],
    ['devices:write', district],
  ]);
  const readOnly = await principal(`b5-read-${randomUUID()}`, [
    ['devices:read', district],
    ['jobs:read', district],
  ]);
  const ownerSession = session(owner, [
    { action: 'devices:read', scope: district },
    { action: 'devices:write', scope: district },
    { action: 'devices:bulk-actions', scope: district },
    { action: 'jobs:read', scope: district },
  ]);
  const writeOnlySession = session(writeOnly, [
    { action: 'devices:read', scope: district },
    { action: 'devices:write', scope: district },
  ]);
  const readOnlySession = session(readOnly, [
    { action: 'devices:read', scope: district },
    { action: 'jobs:read', scope: district },
  ]);

  // The real Redis of this check, with the application user's commands.
  const container = `cc-b5-${randomUUID().slice(0, 8)}`;
  const redisSecret = randomUUID();
  const docker = (...args) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  let url;
  let publisher;
  let subscriber;
  let cache;
  const events = [];
  const startRedis = async () => {
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      container,
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
      '--requirepass',
      redisSecret,
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (
          docker('exec', container, 'redis-cli', '-a', redisSecret, 'ping') ===
          'PONG'
        )
          break;
      } catch {
        /* Retry bounded startup. */
      }
      await sleep(100);
    }
    const port = Number(
      docker('port', container, '6379/tcp').split(':').at(-1),
    );
    url = `redis://default:${encodeURIComponent(redisSecret)}@127.0.0.1:${port}`;
    const options = {
      url,
      disableOfflineQueue: true,
      socket: { reconnectStrategy: false },
    };
    publisher = createClient(options);
    publisher.on('error', () => {
      /* A failed command reports its own error. */
    });
    await publisher.connect();
    await publisher.ping();
    subscriber = createClient(options);
    subscriber.on('error', () => {
      /* The checks read only the messages they receive. */
    });
    await subscriber.connect();
    await subscriber.subscribe(jobEventsChannel(customer), (message) => {
      try {
        events.push({ channel: 'job', event: JSON.parse(message) });
      } catch {
        /* A malformed message fails its assertion below. */
      }
    });
    await subscriber.subscribe(entityEventsChannel(customer), (message) => {
      try {
        events.push({ channel: 'entity', event: JSON.parse(message) });
      } catch {
        /* A malformed message fails its assertion below. */
      }
    });
    cache = new CacheService({
      deployment: {
        services: {
          redis: {
            endpoint: { url, tls: { mode: 'disabled' } },
            passwordSecretRef: { key: 'password' },
          },
        },
        applicationAuth: {},
      },
      secret: () => Buffer.from(redisSecret),
    });
  };
  const stopRedis = async () => {
    await cache?.onApplicationShutdown().catch(() => undefined);
    await subscriber?.quit().catch(() => undefined);
    await publisher?.quit().catch(() => undefined);
    try {
      docker('rm', '-f', container);
    } catch {
      /* The container was not created. */
    }
  };
  const take = (channel) =>
    events
      .filter((entry) => entry.channel === channel)
      .map((entry) => entry.event);

  const database = {
    connection: { query: (text, values) => runtime.query(text, values) },
  };
  let now = 0;
  const starts = [];
  const reconciles = [];
  let startAnswer = () => `execution-${randomUUID()}`;
  const orchestration = {
    startDeviceUpdate: async (input) => {
      starts.push(input);
      return startAnswer(input);
    },
    startDeviceUpdateReconcile: async (input) => {
      reconciles.push(input);
      return `execution-${randomUUID()}`;
    },
  };
  const service = new JobService({
    database,
    cache: {
      get: (key) => cache.get(key),
      set: (key, value, seconds) => cache.set(key, value, seconds),
      release: (key, item) => cache.release(key, item),
      publish: (channel, message) => cache.publish(channel, message),
      increment: (key) => cache.increment(key),
    },
    orchestration,
    clock: () => now,
  });
  // A job service whose publisher fails the way a Redis outage fails it. Every other command works,
  // so the check isolates publication from the committed dispatch decision (R1-F1).
  const failingPublisher = () =>
    new JobService({
      database,
      cache: {
        get: (key) => cache.get(key),
        set: (key, value, seconds) => cache.set(key, value, seconds),
        release: (key, item) => cache.release(key, item),
        publish: async () => {
          throw new Error('redis unavailable');
        },
        increment: (key) => cache.increment(key),
      },
      orchestration,
      clock: () => now,
    });
  const workerCache = () => {
    const calls = [];
    return {
      calls,
      async setRecords(entries) {
        calls.push({ name: 'setRecords', entries });
      },
      async remove(keys) {
        calls.push({ name: 'remove', keys });
      },
      async removeMembers() {
        return undefined;
      },
      async extendMembers() {
        return undefined;
      },
      async increment(key) {
        calls.push({ name: 'increment', key });
      },
      async publish(channel, message) {
        calls.push({ name: 'publish', channel, message });
      },
      async close() {
        return undefined;
      },
    };
  };

  // One write job fixture: one preview, one header, one detail row, and one operation per device.
  const makeJob = async ({
    devices,
    batchSize = 250,
    mode = 'replace',
    value = 'Room 12',
    status = 'accepted',
  } = {}) => {
    const jobId = randomUUID();
    const previewId = randomUUID();
    const version = (
      await adminRow(
        'SELECT permission_version FROM cc.application_principals WHERE id=$1',
        [owner],
      )
    ).permission_version;
    await admin(
      `INSERT INTO cc.device_update_previews(preview_id,display_id,customer_id,created_by,permission_version,
        generation,action,action_version,selected,eligible,unchanged,excluded,field_changes,
        manifest_digest,expires_at)
      VALUES($1,cc.job_display_id('PV',nextval('cc.preview_number_pv')),$2,$3,$4,$5,'annotated-location',2,
        $6,$6,0,0,$6,'manifest-digest',clock_timestamp()+interval '1 hour')`,
      [previewId, customer, owner, version, generation, devices.length],
    );
    await admin(
      'INSERT INTO cc.device_update_changes(preview_id,field,mode,value) VALUES($1,$2,$3,$4)',
      [previewId, 'annotatedLocation', mode, mode === 'clear' ? null : value],
    );
    const displayId = (
      await adminRow(
        `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
          target_count,correlation_id,created_at)
        VALUES($1,cc.job_display_id('UPD',nextval('cc.job_number_upd')),$2,'device-update','devices',$3,$4,$5,
          $6,$7,clock_timestamp()) RETURNING display_id`,
        [
          jobId,
          customer,
          status,
          owner,
          generation,
          devices.length,
          randomUUID(),
        ],
      )
    ).display_id;
    await admin(
      `INSERT INTO cc.device_update_jobs(job_id,preview_id,action,confirmed_by,confirmer_permission_version,
        delegated_subject,batch_size,batch_count)
      VALUES($1,$2,'annotated-location',$3,$4,'admin@example.org',$5,$6)`,
      [
        jobId,
        previewId,
        owner,
        version,
        batchSize,
        Math.ceil(devices.length / batchSize),
      ],
    );
    for (const [index, deviceId] of devices.entries()) {
      await admin(
        `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,serial_number,org_unit_path,
          baseline_value,requested_value,batch,status)
        VALUES($1,$2,$3,$4,'/School A',NULL,NULL,$5,'pending')`,
        [jobId, index + 1, deviceId, `SN-${deviceId}`, Math.floor(index / batchSize)],
      );
      await admin(
        `INSERT INTO cc.device_update_operation_fields(job_id,operation_number,field,
          baseline_value,requested_value)
        VALUES($1,$2,'annotatedLocation',NULL,$3)`,
        [jobId, index + 1, mode === 'clear' ? null : value],
      );
    }
    return { jobId, displayId };
  };
  // One command job fixture: a Reboot preview, one header, one detail row, and one issued command.
  // The issued operation is what keeps the job in `awaiting-devices` after its finish (section 4 step 4).
  const makeCommandJob = async ({ devices }) => {
    const jobId = randomUUID();
    const previewId = randomUUID();
    const version = (
      await adminRow(
        'SELECT permission_version FROM cc.application_principals WHERE id=$1',
        [owner],
      )
    ).permission_version;
    await admin(
      `INSERT INTO cc.device_update_previews(preview_id, display_id, customer_id, created_by, permission_version, generation, action, action_version, selected, eligible, unchanged, excluded, manifest_digest, expires_at)
      VALUES($1, cc.job_display_id('PV',nextval('cc.preview_number_pv')), $2, $3, $4, $5, 'reboot', 1, $6, $6, 0, 0, 'manifest-digest', clock_timestamp()+interval '1 hour')`,
      [previewId, customer, owner, version, generation, devices.length],
    );
    const displayId = (
      await adminRow(
        `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
          target_count,correlation_id,created_at)
        VALUES($1,cc.job_display_id('CMD',nextval('cc.job_number_cmd')),$2,'device-command','devices','accepted',
          $3,$4,$5,$6,clock_timestamp()) RETURNING display_id`,
        [jobId, customer, owner, generation, devices.length, randomUUID()],
      )
    ).display_id;
    await admin(
      `INSERT INTO cc.device_update_jobs(job_id, preview_id, action, confirmed_by, confirmer_permission_version, delegated_subject, batch_size, batch_count)
      VALUES($1, $2, 'reboot', $3, $4, 'admin@example.org', 250, 1)`,
      [jobId, previewId, owner, version],
    );
    for (const [index, deviceId] of devices.entries())
      await admin(
        `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,serial_number,
          org_unit_path,baseline_value,requested_value,batch,status,command_id,command_state,poll_after,
          poll_deadline_at)
        VALUES($1,$2,$3,$4,'/School A','ACTIVE',NULL,0,'issued',$5,'pending-delivery',clock_timestamp(),
          clock_timestamp()+interval '7 days')`,
        [jobId, index + 1, deviceId, `SN-${deviceId}`, `41000000${index + 1}`],
      );
    return { jobId, displayId };
  };
  const refreshJob = async ({ status = 'running', progress = false } = {}) => {
    const jobId = randomUUID();
    const row = await adminRow(
      `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
        target_count,correlation_id,created_at,started_at)
      VALUES($1,cc.job_display_id('REF',nextval('cc.job_number_ref')),$2,'inventory-refresh','devices',$3,$4,$5,
        3,$6,clock_timestamp(),clock_timestamp()) RETURNING display_id`,
      [jobId, customer, status, owner, generation, randomUUID()],
    );
    await admin('SELECT cc.record_job_change($1,$2) AS result', [
      jobId,
      !progress,
    ]);
    return { jobId, displayId: row.display_id };
  };
  const jobRow = (jobId) =>
    adminRow('SELECT * FROM cc.jobs WHERE job_id=$1', [jobId]);
  const detail = (jobId) =>
    adminRow('SELECT * FROM cc.device_update_jobs WHERE job_id=$1', [jobId]);
  const operations = (jobId) =>
    admin(
      `SELECT operation_number,status,outcome_reason FROM cc.device_update_operations
        WHERE job_id=$1 ORDER BY operation_number`,
      [jobId],
    );
  const tokenOf = async (jobId) => (await detail(jobId)).dispatch_token;
  const claim = (jobId, token, batch, attempt) =>
    result('SELECT cc.claim_device_update_batch($1,$2,$3,$4,$5,$6) AS result', [
      customer,
      jobId,
      token,
      batch,
      attempt,
      'kestra-execution',
    ]);
  const report = (jobId, token, batch, attempt, sequence = 1) =>
    result(
      'SELECT cc.report_device_update_backoff($1,$2,$3,$4,$5,$6) AS result',
      [customer, jobId, token, batch, attempt, sequence],
    );
  const expireBatches = (jobId) =>
    admin(
      `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()-interval '120 seconds'
        WHERE job_id=$1`,
      [jobId],
    );
  const endJob = async (jobId) => {
    await expireBatches(jobId);
    return result('SELECT cc.finalize_device_update_job($1,$2,$3) AS result', [
      customer,
      jobId,
      null,
    ]);
  };
  const publications = (jobId) =>
    admin(
      'SELECT publication_id,status_changed,revision FROM cc.job_publications WHERE job_id=$1 ORDER BY publication_id',
      [jobId],
    );
  /** End every open write job and clear the hold state before a fresh admission check. */
  const settle = async () => {
    await admin(
      `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()-interval '3600 seconds'
        WHERE job_id IN (SELECT job_id FROM cc.jobs WHERE customer_id=$1 AND kind='device-update')`,
      [customer],
    );
    const running = await admin(
      `SELECT job_id FROM cc.jobs WHERE customer_id=$1 AND kind='device-update' AND status='running'`,
      [customer],
    );
    for (const row of running)
      await result('SELECT cc.finalize_device_update_job($1,$2,$3) AS result', [
        customer,
        row.job_id,
        null,
      ]);
    await admin(
      `UPDATE cc.jobs SET status='completed',finished_at=COALESCE(finished_at,clock_timestamp())
        WHERE customer_id=$1 AND kind='device-update' AND status NOT IN
          ('completed','completed-with-errors','failed','needs-review')`,
      [customer],
    );
    await admin(
      `UPDATE cc.device_update_jobs SET hold_written_at=NULL,hold_cleaned_at=NULL,backoff_attempt=NULL,
        backoff_sequence=NULL,backoff_reported_at=NULL
        WHERE job_id IN (SELECT job_id FROM cc.jobs WHERE customer_id=$1 AND kind='device-update')`,
      [customer],
    );
    await publisher.del(jobHoldKey(customer));
    await admin('DELETE FROM cc.job_publications WHERE customer_id=$1', [
      customer,
    ]);
    events.length = 0;
  };
  const cached = async (key) => publisher.get(key);
  const ttl = async (key) => publisher.ttl(key);

  // The Reconcile route runs through the production controller and the production Jobs reads.
  const jobs = new Jobs({
    connection: { query: (text, values) => runtime.query(text, values) },
  });
  const authorizer = {
    async authorize(current, action, resource) {
      if (!isAuthorized(current.identity.grants, action, resource))
        throw new ForbiddenException({ reason: 'forbidden' });
    },
  };
  const controller = new JobsController(jobs, authorizer, {}, orchestration);
  const request = (current) => ({
    session: current,
    headers: {},
    correlationId: randomUUID(),
  });
  const statusOf = (error) => error.getStatus?.() ?? error.status;

  await startRedis();
  try {
    await settle();

    await check(
      'hold write: SET replaces another owner and resets the TTL to 300 seconds',
      async () => {
        const { jobId } = await makeJob({ devices: ['b5-h1'] });
        assert.equal(await service.admit(customer), false);
        const token = await tokenOf(jobId);
        const attempt = randomUUID();
        const claimed = await claim(jobId, token, 0, attempt);
        assert.equal(claimed.outcome, 'claimed', JSON.stringify(claimed));
        assert.equal(await report(jobId, token, 0, attempt), true);
        await publisher.set(jobHoldKey(customer), 'previous-owner', {
          EX: 60,
        });
        assert.equal(await service.applyHold(customer), true);
        assert.equal(await cached(jobHoldKey(customer)), jobId);
        const remaining = await ttl(jobHoldKey(customer));
        assert.ok(remaining > 290 && remaining <= 300, `ttl ${remaining}`);
        assert.ok((await detail(jobId)).hold_written_at instanceof Date);
      },
    );

    await check(
      'cleanup: the owner deletes its hold and a previous owner keeps the newer hold',
      async () => {
        await settle();
        const first = await makeJob({ devices: ['b5-c1'] });
        await admin(
          `UPDATE cc.jobs SET status='completed',finished_at=clock_timestamp() WHERE job_id=$1`,
          [first.jobId],
        );
        await admin(
          'UPDATE cc.device_update_jobs SET hold_written_at=clock_timestamp() WHERE job_id=$1',
          [first.jobId],
        );
        await publisher.set(jobHoldKey(customer), 'newer-owner', { EX: 120 });
        assert.equal(await service.cleanup(customer), 1);
        assert.equal(await cached(jobHoldKey(customer)), 'newer-owner');
        assert.ok((await detail(first.jobId)).hold_cleaned_at instanceof Date);
        // The same job cleans again only when it is the owner.
        await admin(
          'UPDATE cc.device_update_jobs SET hold_cleaned_at=NULL WHERE job_id=$1',
          [first.jobId],
        );
        await publisher.set(jobHoldKey(customer), first.jobId, { EX: 120 });
        assert.equal(await service.cleanup(customer), 1);
        assert.equal(await cached(jobHoldKey(customer)), null);
        assert.ok((await detail(first.jobId)).hold_cleaned_at instanceof Date);
      },
    );

    await check(
      'the hold cleanup refuses a job that has not reached a terminal status',
      async () => {
        await settle();
        const { jobId } = await makeJob({ devices: ['b5-clean1'] });
        await service.admit(customer);
        await admin(
          'UPDATE cc.device_update_jobs SET hold_written_at=clock_timestamp() WHERE job_id=$1',
          [jobId],
        );
        assert.equal((await jobRow(jobId)).status, 'running');
        // A direct runtime-role call changes nothing for the running job (round 2, ruling 3).
        assert.equal(
          await result('SELECT cc.clean_device_update_hold($1,$2) AS result', [
            customer,
            jobId,
          ]),
          false,
        );
        assert.equal((await detail(jobId)).hold_cleaned_at, null);
        // The terminal status still takes the mark.
        await admin(
          `UPDATE cc.jobs SET status='completed',finished_at=clock_timestamp() WHERE job_id=$1`,
          [jobId],
        );
        assert.equal(
          await result('SELECT cc.clean_device_update_hold($1,$2) AS result', [
            customer,
            jobId,
          ]),
          true,
        );
        assert.ok((await detail(jobId)).hold_cleaned_at instanceof Date);
      },
    );

    await check(
      'a Redis error on the hold read fails admission closed, and the next tick admits',
      async () => {
        await settle();
        const { jobId } = await makeJob({ devices: ['b5-r1'] });
        const failing = new JobService({
          database,
          cache: {
            get: async () => {
              throw new Error('redis unavailable');
            },
            set: async () => undefined,
            release: async () => undefined,
            publish: async () => undefined,
            increment: async () => undefined,
          },
          orchestration,
          clock: () => now,
        });
        const before = starts.length;
        assert.equal(await failing.admit(customer), false);
        assert.equal((await jobRow(jobId)).status, 'held');
        assert.equal(starts.length, before);
        assert.equal(await service.admit(customer), false);
        assert.equal((await jobRow(jobId)).status, 'running');
        assert.equal(starts.length, before + 1);
      },
    );

    await check(
      'a hold written before the hold read labels the pending job held, and one after the admit leaves it running',
      async () => {
        await settle();
        const { jobId } = await makeJob({ devices: ['b5-a1'] });
        await publisher.set(jobHoldKey(customer), 'owner', { EX: 300 });
        const before = starts.length;
        assert.equal(await service.admit(customer), false);
        assert.equal((await jobRow(jobId)).status, 'held');
        assert.equal(starts.length, before);
        await publisher.del(jobHoldKey(customer));
        assert.equal(await service.admit(customer), false);
        assert.equal((await jobRow(jobId)).status, 'running');
        // A hold written after the admit commit treats the admitted job as existing work.
        await publisher.set(jobHoldKey(customer), 'another-owner', { EX: 300 });
        assert.equal(await service.admit(customer), false);
        assert.equal((await jobRow(jobId)).status, 'running');
      },
    );

    await check(
      'a delayed report after its lease ended writes no hold, and a report older than 30 seconds writes no hold',
      async () => {
        await settle();
        const late = await makeJob({ devices: ['b5-d1'] });
        await service.admit(customer);
        const lateToken = await tokenOf(late.jobId);
        const lateAttempt = randomUUID();
        await claim(late.jobId, lateToken, 0, lateAttempt);
        assert.equal(await report(late.jobId, lateToken, 0, lateAttempt), true);
        await expireBatches(late.jobId);
        assert.equal(await service.applyHold(customer), false);
        assert.equal(await cached(jobHoldKey(customer)), null);
        assert.equal((await detail(late.jobId)).hold_written_at, null);

        await settle();
        const old = await makeJob({ devices: ['b5-d2'] });
        await service.admit(customer);
        const oldToken = await tokenOf(old.jobId);
        const oldAttempt = randomUUID();
        await claim(old.jobId, oldToken, 0, oldAttempt);
        assert.equal(await report(old.jobId, oldToken, 0, oldAttempt), true);
        await admin(
          `UPDATE cc.device_update_jobs SET backoff_reported_at=clock_timestamp()-interval '31 seconds'
            WHERE job_id=$1`,
          [old.jobId],
        );
        assert.equal(await service.applyHold(customer), false);
        assert.equal(await cached(jobHoldKey(customer)), null);
        assert.equal((await detail(old.jobId)).hold_written_at, null);
      },
    );

    await check(
      'an apply that stalls beyond five seconds skips the SET and keeps the registry entry',
      async () => {
        await settle();
        const { jobId } = await makeJob({ devices: ['b5-s1'] });
        await service.admit(customer);
        const token = await tokenOf(jobId);
        const attempt = randomUUID();
        await claim(jobId, token, 0, attempt);
        assert.equal(await report(jobId, token, 0, attempt), true);
        now = 0;
        const served = new JobService({
          database,
          cache: {
            get: (key) => cache.get(key),
            set: (key, value, seconds) => cache.set(key, value, seconds),
            release: (key, item) => cache.release(key, item),
            publish: (channel, message) => cache.publish(channel, message),
            increment: (key) => cache.increment(key),
          },
          orchestration,
          clock: () => {
            const value = now;
            now = HOLD_WRITE_DEADLINE_MS + 1;
            return value;
          },
        });
        assert.equal(await served.applyHold(customer), true);
        assert.equal(await cached(jobHoldKey(customer)), null);
        assert.ok((await detail(jobId)).hold_written_at instanceof Date);
        now = 0;
      },
    );

    await check(
      'an exit between admission and start leaves a running job without a claim, and the tick restarts it after the deadline',
      async () => {
        await settle();
        const { jobId } = await makeJob({ devices: ['b5-e1'] });
        startAnswer = () => {
          throw new Error('network failure');
        };
        assert.equal(await service.admit(customer), false);
        const detailRow = await detail(jobId);
        assert.equal((await jobRow(jobId)).status, 'running');
        assert.equal(detailRow.kestra_execution_id, null);
        assert.equal(detailRow.dispatch_count, 1);
        await admin(
          `UPDATE cc.device_update_jobs SET start_deadline_at=clock_timestamp()-interval '1 second'
            WHERE job_id=$1`,
          [jobId],
        );
        startAnswer = () => `execution-${randomUUID()}`;
        const before = starts.length;
        assert.equal(await service.recover(customer), true);
        const rotated = await detail(jobId);
        assert.equal(rotated.dispatch_count, 2);
        assert.notEqual(rotated.dispatch_token, detailRow.dispatch_token);
        assert.equal(typeof rotated.kestra_execution_id, 'string');
        assert.equal(starts.length, before + 1);
      },
    );

    await check(
      'an ambiguous start whose late execution arrives after rotation answers superseded and sends nothing',
      async () => {
        await settle();
        const { jobId } = await makeJob({ devices: ['b5-late1'] });
        startAnswer = () => {
          throw new Error('timed out');
        };
        await service.admit(customer);
        const lateToken = await tokenOf(jobId);
        await admin(
          `UPDATE cc.device_update_jobs SET start_deadline_at=clock_timestamp()-interval '1 second'
            WHERE job_id=$1`,
          [jobId],
        );
        startAnswer = () => `execution-${randomUUID()}`;
        await service.recover(customer);
        const currentToken = await tokenOf(jobId);
        assert.notEqual(currentToken, lateToken);
        const reader = {
          calls: [],
          async patchDevices() {
            this.calls.push('patch');
            return { succeeded: new Map(), failed: new Map() };
          },
          async deviceStates() {
            this.calls.push('deviceStates');
            return [];
          },
        };
        const worker = new DeviceUpdateJobs(
          { query: (text, values) => runtime.query(text, values) },
          { open: () => ({ subject: 'fixture@example.invalid' }) },
          reader,
          workerCache(),
        );
        const answer = await worker.runBatch(
          {
            customerId: customer,
            jobId,
            dispatchToken: lateToken,
            batch: 0,
            correlationId: randomUUID(),
          },
          AbortSignal.timeout(30_000),
        );
        assert.equal(answer.outcome, 'superseded', JSON.stringify(answer));
        assert.deepEqual(reader.calls, []);
        const finished = await worker.runFinish(
          {
            customerId: customer,
            jobId,
            dispatchToken: lateToken,
            correlationId: randomUUID(),
          },
          AbortSignal.timeout(30_000),
        );
        assert.equal(finished.outcome, 'superseded', JSON.stringify(finished));
        assert.deepEqual(reader.calls, []);
      },
    );

    await check(
      'an execution that claims before the deadline runs normally',
      async () => {
        await settle();
        const { jobId } = await makeJob({ devices: ['b5-timely1'] });
        await service.admit(customer);
        const token = await tokenOf(jobId);
        const reader = {
          calls: [],
          async patchDevices(_credential, _customer, writes, _signal, options) {
            this.calls.push('patch');
            const succeeded = new Map();
            for (const write of writes) {
              const event = {
                id: write.deviceId,
                status: 200,
                attempts: { quota: 0, transient: 0 },
                request: {
                  id: write.deviceId,
                  method: 'PATCH',
                  path: `/devices/${write.deviceId}`,
                },
                outcome: {
                  kind: 'success',
                  page: {
                    deviceId: write.deviceId,
                    ...write.fields,
                  },
                  pageIndex: 0,
                  hasNextPage: false,
                },
              };
              succeeded.set(write.deviceId, [event.outcome.page]);
              await options.onResponse?.(event);
            }
            await options.onBatch?.({
              round: 1,
              sentCount: writes.length,
              outerStatus: 200,
              durationMs: 1,
              pending: 0,
            });
            return { succeeded, failed: new Map() };
          },
          async deviceStates() {
            this.calls.push('deviceStates');
            return [];
          },
        };
        const worker = new DeviceUpdateJobs(
          { query: (text, values) => runtime.query(text, values) },
          { open: () => ({ subject: 'fixture@example.invalid' }) },
          reader,
          workerCache(),
        );
        const answer = await worker.runBatch(
          {
            customerId: customer,
            jobId,
            dispatchToken: token,
            batch: 0,
            correlationId: randomUUID(),
          },
          AbortSignal.timeout(30_000),
        );
        assert.notEqual(answer.outcome, 'superseded', JSON.stringify(answer));
        assert.deepEqual(reader.calls, ['patch']);
        const settled = await operations(jobId);
        assert.deepEqual(
          settled.map((row) => row.status),
          ['succeeded'],
        );
      },
    );

    await check(
      'a Kestra 4xx answer fails the job with orchestration-unavailable and skips every operation',
      async () => {
        await settle();
        const { jobId, displayId } = await makeJob({
          devices: ['b5-f1', 'b5-f2'],
        });
        startAnswer = () => {
          throw new ServiceResponseError(400);
        };
        assert.equal(await service.admit(customer), true);
        startAnswer = () => `execution-${randomUUID()}`;
        const header = await jobRow(jobId);
        assert.equal(header.status, 'failed');
        assert.equal(header.failure, 'orchestration-unavailable');
        assert.deepEqual(
          (await operations(jobId)).map((row) => [
            row.status,
            row.outcome_reason,
          ]),
          [
            ['skipped', 'orchestration-unavailable'],
            ['skipped', 'orchestration-unavailable'],
          ],
        );
        const published = take('job').filter(
          (event) => event.jobId === jobId && event.displayId === displayId,
        );
        // The admission publishes one event and the refused start publishes the failure.
        assert.ok(published.length >= 1);
        assert.equal(published.at(-1).revision, Number(header.revision));
      },
    );

    await check(
      'runner loss restarts with a new token and at three executions the tick finalizes the job and starts reconcile for all',
      async () => {
        await settle();
        const { jobId } = await makeJob({ devices: ['b5-rl1'] });
        await service.admit(customer);
        const firstToken = await tokenOf(jobId);
        const attempt = randomUUID();
        await claim(jobId, firstToken, 0, attempt);
        await admin(
          `UPDATE cc.device_update_jobs SET heartbeat_at=clock_timestamp()-interval '11 minutes'
            WHERE job_id=$1`,
          [jobId],
        );
        await expireBatches(jobId);
        const before = starts.length;
        assert.equal(await service.recover(customer), true);
        const rotated = await detail(jobId);
        assert.equal(rotated.dispatch_count, 2);
        assert.notEqual(rotated.dispatch_token, firstToken);
        assert.equal(starts.length, before + 1);
        // The third execution reaches the reaper.
        await admin(
          `UPDATE cc.device_update_jobs SET dispatch_count=3,heartbeat_at=clock_timestamp()-interval '11 minutes'
            WHERE job_id=$1`,
          [jobId],
        );
        await expireBatches(jobId);
        const reconcileBefore = reconciles.length;
        assert.equal(await service.recover(customer), true);
        const header = await jobRow(jobId);
        assert.equal(header.status, 'needs-review', JSON.stringify(header));
        assert.deepEqual(
          (await operations(jobId)).map((row) => row.status),
          ['unknown'],
        );
        assert.equal(reconciles.length, reconcileBefore + 1);
        const flow = reconciles.at(-1);
        assert.equal(flow.jobId, jobId);
        assert.equal(flow.operationNumber, 'all');
        assert.equal('verifyAttempt' in flow, false);
      },
    );

    await check(
      'a failed publication after admission keeps its row for the relay and still starts the job',
      async () => {
        await settle();
        const { jobId } = await makeJob({ devices: ['b5-pubfail1'] });
        const before = starts.length;
        assert.equal(await failingPublisher().admit(customer), false);
        const row = await detail(jobId);
        assert.equal((await jobRow(jobId)).status, 'running');
        assert.equal(row.dispatch_count, 1);
        assert.equal(typeof row.kestra_execution_id, 'string');
        assert.equal(starts.length, before + 1);
        // The failed send left its row for the relay.
        const left = await publications(jobId);
        assert.ok(
          left.some((one) => one.status_changed),
          JSON.stringify(left),
        );
        await admin(
          `UPDATE cc.job_publications SET created_at=clock_timestamp()-interval '6 seconds'
            WHERE job_id=$1`,
          [jobId],
        );
        await service.relay();
        assert.equal((await publications(jobId)).length, 0);
        const event = take('job')
          .filter((one) => one.jobId === jobId)
          .at(-1);
        assert.ok(event, 'The relay published the row the admission left.');
        assert.equal(event.revision, Number((await jobRow(jobId)).revision));
      },
    );

    await check(
      'a failed publication after a reaper run keeps its row and still starts reconcile for all',
      async () => {
        await settle();
        const { jobId } = await makeJob({ devices: ['b5-pubfail2'] });
        await service.admit(customer);
        const token = await tokenOf(jobId);
        await claim(jobId, token, 0, randomUUID());
        await admin(
          `UPDATE cc.device_update_jobs SET dispatch_count=3,heartbeat_at=clock_timestamp()-interval '11 minutes'
            WHERE job_id=$1`,
          [jobId],
        );
        await expireBatches(jobId);
        const reconcileBefore = reconciles.length;
        assert.equal(await failingPublisher().recover(customer), true);
        const header = await jobRow(jobId);
        assert.equal(header.status, 'needs-review', JSON.stringify(header));
        assert.deepEqual(
          (await operations(jobId)).map((row) => row.status),
          ['unknown'],
        );
        assert.equal(reconciles.length, reconcileBefore + 1);
        const flow = reconciles.at(-1);
        assert.equal(flow.jobId, jobId);
        assert.equal(flow.operationNumber, 'all');
        assert.equal('verifyAttempt' in flow, false);
        const left = await publications(jobId);
        assert.ok(
          left.some((one) => one.status_changed),
          JSON.stringify(left),
        );
        await admin(
          `UPDATE cc.job_publications SET created_at=clock_timestamp()-interval '6 seconds'
            WHERE job_id=$1`,
          [jobId],
        );
        await service.relay();
        assert.equal((await publications(jobId)).length, 0);
      },
    );

    const unknownJob = async (devices = ['b5-u1', 'b5-u2']) => {
      const job = await makeJob({ devices });
      await service.admit(customer);
      await admin(
        `UPDATE cc.device_update_operations SET status='unknown',outcome_reason='interrupted',
          updated_at=clock_timestamp()
          WHERE job_id=$1 AND operation_number=1`,
        [job.jobId],
      );
      return job;
    };

    await check(
      'Reconcile answers 202 with the operation and starts one flow with its attempt',
      async () => {
        await settle();
        const { jobId, displayId } = await unknownJob();
        const before = reconciles.length;
        const answer = await controller.reconcile(
          request(ownerSession),
          displayId,
          '1',
        );
        assert.equal(answer.operationId, `${displayId}-1-annotatedLocation`);
        assert.equal(answer.outcome, 'unknown');
        assert.equal(reconciles.length, before + 1);
        const flow = reconciles.at(-1);
        assert.equal(flow.jobId, jobId);
        assert.equal(flow.operationNumber, 1);
        assert.match(flow.verifyAttempt, /^[0-9a-f-]{36}$/);
        const operation = await adminRow(
          `SELECT verify_attempt,verify_lease_expires_at FROM cc.device_update_operations
            WHERE job_id=$1 AND operation_number=1`,
          [jobId],
        );
        assert.equal(operation.verify_attempt, flow.verifyAttempt);
        assert.ok(operation.verify_lease_expires_at > new Date());
        // A second request under the live lease answers with the operation and starts nothing.
        const second = await controller.reconcile(
          request(ownerSession),
          displayId,
          '1',
        );
        assert.equal(second.outcome, 'unknown');
        assert.equal(reconciles.length, before + 1);
      },
    );

    await check(
      'Reconcile lease: a second request under the live read-back lease answers 202 and starts no second flow',
      async () => {
        await settle();
        const { displayId } = await unknownJob(['b5-lease']);
        const before = reconciles.length;
        const first = await controller.reconcile(
          request(ownerSession),
          displayId,
          '1',
        );
        const second = await controller.reconcile(
          request(ownerSession),
          displayId,
          '1',
        );
        assert.equal(first.outcome, 'unknown');
        assert.equal(second.outcome, 'unknown');
        assert.equal(reconciles.length, before + 1);
      },
    );

    await check(
      'Reconcile answers 409 operation-settled for a settled operation',
      async () => {
        await settle();
        const { jobId, displayId } = await unknownJob(['b5-settled']);
        await admin(
          `UPDATE cc.device_update_operations SET status='succeeded',verified_by='read-back',
            observed_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE job_id=$1 AND operation_number=1`,
          [jobId],
        );
        const before = reconciles.length;
        await assert.rejects(
          () => controller.reconcile(request(ownerSession), displayId, '1'),
          (error) => {
            assert.equal(statusOf(error), 409);
            assert.equal(error.getResponse().reason, 'operation-settled');
            return true;
          },
        );
        assert.equal(reconciles.length, before);
      },
    );

    await check(
      'Reconcile answers 403 without jobs:read and 403 without devices:write, and starts no flow',
      async () => {
        await settle();
        const { displayId } = await unknownJob(['b5-access']);
        const before = reconciles.length;
        await assert.rejects(
          () => controller.reconcile(request(writeOnlySession), displayId, '1'),
          (error) => {
            assert.equal(statusOf(error), 403);
            return true;
          },
        );
        await assert.rejects(
          () => controller.reconcile(request(readOnlySession), displayId, '1'),
          (error) => {
            assert.equal(statusOf(error), 403);
            return true;
          },
        );
        assert.equal(reconciles.length, before);
      },
    );

    await check(
      'Reconcile answers 404 for an unknown job, a refresh job, and an operation the job does not hold',
      async () => {
        await settle();
        const { displayId } = await unknownJob(['b5-404']);
        await assert.rejects(
          () => controller.reconcile(request(ownerSession), 'UPD-999999', '1'),
          (error) => {
            assert.equal(statusOf(error), 404);
            return true;
          },
        );
        const refresh = await refreshJob({ status: 'completed' });
        await assert.rejects(
          () =>
            controller.reconcile(request(ownerSession), refresh.displayId, '1'),
          (error) => {
            assert.equal(statusOf(error), 404);
            assert.equal(error.getResponse().reason, 'operation-not-found');
            return true;
          },
        );
        await assert.rejects(
          () => controller.reconcile(request(ownerSession), displayId, '99'),
          (error) => {
            assert.equal(statusOf(error), 404);
            assert.equal(error.getResponse().reason, 'operation-not-found');
            return true;
          },
        );
      },
    );

    await check(
      'a failed Reconcile start answers 503 and leaves the claim to expire',
      async () => {
        await settle();
        const { displayId } = await unknownJob(['b5-503']);
        const answer = orchestration.startDeviceUpdateReconcile;
        orchestration.startDeviceUpdateReconcile = async () => {
          throw new Error('kestra unavailable');
        };
        try {
          await assert.rejects(
            () => controller.reconcile(request(ownerSession), displayId, '1'),
            (error) => {
              assert.equal(statusOf(error), 503);
              assert.equal(error.getResponse().reason, 'reconcile-unavailable');
              return true;
            },
          );
        } finally {
          orchestration.startDeviceUpdateReconcile = answer;
        }
      },
    );

    await check(
      'the confirm route runs admission once after a created confirmation',
      async () => {
        const admissions = [];
        const receipt = {
          jobId: 'UPD-1',
          displayId: 'UPD-1',
          status: 'accepted',
          deviceCount: 1,
          updateCount: 1,
        };
        const updates = {
          confirm: async () => ({ receipt, existing: false }),
        };
        const confirmController = new DeviceUpdatesController(
          { sync: async () => ({ customerId: customer }) },
          updates,
          { authorize: async () => undefined },
          {},
          {
            admit: async (id) => {
              admissions.push(id);
              return false;
            },
          },
        );
        const response = { status: () => undefined };
        const body = { manifestDigest: 'a'.repeat(64), acknowledged: true };
        assert.deepEqual(
          await confirmController.confirm(
            request(ownerSession),
            randomUUID(),
            body,
            response,
          ),
          receipt,
        );
        assert.deepEqual(admissions, [customer]);
        updates.confirm = async () => ({ receipt, existing: true });
        await confirmController.confirm(
          request(ownerSession),
          randomUUID(),
          body,
          response,
        );
        assert.deepEqual(admissions, [customer]);
      },
    );

    await check(
      'the relay publishes a terminal change whose publisher left within 15 seconds',
      async () => {
        await settle();
        const { jobId } = await makeJob({ devices: ['b5-p1'] });
        await admin(
          `UPDATE cc.jobs SET status='completed',finished_at=clock_timestamp() WHERE job_id=$1`,
          [jobId],
        );
        const revision = await result(
          'SELECT cc.record_job_change($1,true) AS result',
          [jobId],
        );
        const deadline = Date.now() + 15_000;
        while (
          !take('job').some((event) => event.jobId === jobId) &&
          Date.now() < deadline
        ) {
          await service.relay();
          await sleep(250);
        }
        const event = take('job').find((one) => one.jobId === jobId);
        assert.ok(event, 'The relay published job-changed within 15 seconds.');
        assert.equal(event.revision, Number(revision.revision));
      },
    );

    await check(
      'a relayed row with devices increments the query generation and publishes entity-batch with its IDs',
      async () => {
        await settle();
        const { jobId } = await makeJob({ devices: ['b5-q1', 'b5-q2'] });
        const key = `cc:query-gen:device:${customer}`;
        const before = Number((await cached(key)) ?? 0);
        const element = await result(
          `SELECT cc.record_job_change($1,false,$2::jsonb,$3::jsonb,0) AS result`,
          [jobId, JSON.stringify(['b5-q1']), JSON.stringify(['b5-q2'])],
        );
        await admin(
          `UPDATE cc.job_publications SET created_at=clock_timestamp()-interval '6 seconds'
            WHERE publication_id=$1`,
          [element.publicationId],
        );
        const entityBefore = take('entity').length;
        await service.relay();
        assert.equal(Number((await cached(key)) ?? 0), before + 1);
        assert.equal(
          await publisher.keys('cc:entity:*').then((rows) => rows.length),
          0,
        );
        const published = take('entity').slice(entityBefore);
        assert.equal(published.length, 1);
        assert.deepEqual(published[0], {
          type: 'entity-batch',
          jobId,
          entityType: 'device',
          batch: 0,
          batchCount: 1,
          deviceIds: ['b5-q1'],
          removedIds: ['b5-q2'],
        });
        assert.equal((await publications(jobId)).length, 0);
      },
    );

    await check(
      'a Redis error keeps the relay row for the next run',
      async () => {
        await settle();
        const { jobId } = await makeJob({ devices: ['b5-x1'] });
        await result('SELECT cc.record_job_change($1,false) AS result', [
          jobId,
        ]);
        const failing = new JobService({
          database,
          cache: {
            get: (key) => cache.get(key),
            set: (key, value, seconds) => cache.set(key, value, seconds),
            release: (key, item) => cache.release(key, item),
            publish: async () => {
              throw new Error('redis unavailable');
            },
            increment: (key) => cache.increment(key),
          },
          orchestration,
          clock: () => now,
        });
        await failing.relay();
        assert.equal((await publications(jobId)).length, 1);
        await service.relay();
        assert.equal((await publications(jobId)).length, 0);
        assert.equal(
          take('job').filter((event) => event.jobId === jobId).length,
          1,
        );
      },
    );

    await check(
      'progress-only rows publish one job-changed per job per run',
      async () => {
        await settle();
        const { jobId } = await makeJob({ devices: ['b5-pg1'] });
        await result('SELECT cc.record_job_change($1,false) AS result', [
          jobId,
        ]);
        await result('SELECT cc.record_job_change($1,false) AS result', [
          jobId,
        ]);
        assert.equal((await publications(jobId)).length, 2);
        await service.relay();
        assert.equal(
          take('job').filter((event) => event.jobId === jobId).length,
          1,
        );
        assert.equal((await publications(jobId)).length, 0);
      },
    );

    await check(
      'three refresh rows reach the job channel on the next relay run without the grace, and publish no entity-batch',
      async () => {
        await settle();
        const created = await refreshJob({ status: 'running' });
        const batch = await refreshJob({ status: 'running', progress: true });
        const finished = await refreshJob({ status: 'completed' });
        const entityBefore = take('entity').length;
        await service.relay();
        const named = take('job').filter((event) =>
          [created.jobId, batch.jobId, finished.jobId].includes(event.jobId),
        );
        assert.equal(named.length, 3);
        assert.equal(take('entity').length, entityBefore);
      },
    );

    await check(
      'a second write job reads held while the hold exists and running after cleanup',
      async () => {
        await settle();
        const active = await makeJob({ devices: ['b5-held1'] });
        await service.admit(customer);
        await publisher.set(jobHoldKey(customer), active.jobId, { EX: 300 });
        const waiting = await makeJob({ devices: ['b5-held2'] });
        assert.equal(await service.admit(customer), false);
        assert.equal((await jobRow(waiting.jobId)).status, 'held');
        // The active job ends and cleanup deletes the hold.
        await admin(
          'UPDATE cc.device_update_jobs SET hold_written_at=clock_timestamp() WHERE job_id=$1',
          [active.jobId],
        );
        await endJob(active.jobId);
        assert.equal(await service.cleanup(customer), 1);
        assert.equal(await cached(jobHoldKey(customer)), null);
        assert.equal(await service.admit(customer), false);
        assert.equal((await jobRow(waiting.jobId)).status, 'running');
      },
    );

    await check(
      'a small arriving job waits during the hold and moves ahead of a larger pending job afterwards',
      async () => {
        await settle();
        const large = await makeJob({
          devices: ['b5-order1', 'b5-order2', 'b5-order3'],
        });
        await publisher.set(jobHoldKey(customer), 'owner', { EX: 300 });
        await service.admit(customer);
        const small = await makeJob({ devices: ['b5-order4'] });
        await service.admit(customer);
        assert.equal((await jobRow(large.jobId)).status, 'held');
        assert.equal((await jobRow(small.jobId)).status, 'held');
        await publisher.del(jobHoldKey(customer));
        await service.admit(customer);
        assert.equal((await jobRow(small.jobId)).status, 'running');
        assert.equal((await jobRow(large.jobId)).status, 'queued');
      },
    );

    await check('a refresh job runs while the hold exists', async () => {
      await settle();
      const { jobId } = await makeJob({ devices: ['b5-refresh-hold'] });
      await service.admit(customer);
      await publisher.set(jobHoldKey(customer), jobId, { EX: 300 });
      const refresh = await refreshJob({ status: 'running' });
      assert.equal(await service.admit(customer), false);
      assert.equal((await jobRow(refresh.jobId)).status, 'running');
      assert.equal((await jobRow(jobId)).status, 'running');
    });

    await check(
      'an admission, a label, a refused start, and a reaper run each publish job-changed at once',
      async () => {
        await settle();
        // An admission.
        const admitted = await makeJob({ devices: ['b5-pub1'] });
        assert.equal(await service.admit(customer), false);
        const admissionEvent = take('job').find(
          (event) => event.jobId === admitted.jobId,
        );
        assert.ok(admissionEvent);
        assert.equal(
          admissionEvent.revision,
          Number((await jobRow(admitted.jobId)).revision),
        );
        assert.equal((await publications(admitted.jobId)).length, 0);
        // A label.
        await settle();
        const labelled = await makeJob({ devices: ['b5-pub2'] });
        await publisher.set(jobHoldKey(customer), 'owner', { EX: 300 });
        assert.equal(await service.admit(customer), false);
        const labelEvent = take('job').find(
          (event) => event.jobId === labelled.jobId,
        );
        assert.ok(labelEvent);
        assert.equal((await jobRow(labelled.jobId)).status, 'held');
        assert.equal(
          labelEvent.revision,
          Number((await jobRow(labelled.jobId)).revision),
        );
        await publisher.del(jobHoldKey(customer));
        // A refused start.
        await settle();
        const refused = await makeJob({ devices: ['b5-pub3'] });
        startAnswer = () => {
          throw new ServiceResponseError(400);
        };
        assert.equal(await service.admit(customer), true);
        startAnswer = () => `execution-${randomUUID()}`;
        const refusedEvent = take('job')
          .filter((event) => event.jobId === refused.jobId)
          .at(-1);
        assert.ok(refusedEvent);
        assert.equal(
          refusedEvent.revision,
          Number((await jobRow(refused.jobId)).revision),
        );
        assert.equal((await publications(refused.jobId)).length, 0);
        // A reaper run.
        await settle();
        const reaped = await makeJob({ devices: ['b5-pub4'] });
        await service.admit(customer);
        const token = await tokenOf(reaped.jobId);
        await claim(reaped.jobId, token, 0, randomUUID());
        await admin(
          `UPDATE cc.device_update_jobs SET dispatch_count=3,heartbeat_at=clock_timestamp()-interval '11 minutes'
            WHERE job_id=$1`,
          [reaped.jobId],
        );
        await expireBatches(reaped.jobId);
        await service.recover(customer);
        const reaperEvent = take('job')
          .filter((event) => event.jobId === reaped.jobId)
          .at(-1);
        assert.ok(reaperEvent);
        assert.equal(
          reaperEvent.revision,
          Number((await jobRow(reaped.jobId)).revision),
        );
        const left = await publications(reaped.jobId);
        assert.equal(
          left.filter((row) => row.status_changed).length,
          0,
          JSON.stringify(left),
        );
      },
    );

    await check(
      'an awaiting-devices command job deletes its hold once and marks the registry entry',
      async () => {
        await settle();
        const { jobId } = await makeCommandJob({ devices: ['b5-wait1'] });
        assert.equal(await service.admit(customer), false);
        const token = await tokenOf(jobId);
        // The finish leaves the issued command behind, so the job waits without the write slot.
        const finished = await result(
          'SELECT cc.finish_device_update_job($1,$2,$3) AS result',
          [customer, jobId, token],
        );
        assert.equal(
          finished.status,
          'awaiting-devices',
          JSON.stringify(finished),
        );
        assert.equal((await jobRow(jobId)).finished_at, null);
        // The report that wrote the hold left its registry entry, and the key still belongs to the job.
        await admin(
          'UPDATE cc.device_update_jobs SET hold_written_at=clock_timestamp() WHERE job_id=$1',
          [jobId],
        );
        await publisher.set(jobHoldKey(customer), jobId, { EX: 120 });
        assert.equal(await service.cleanup(customer), 1);
        assert.equal(await cached(jobHoldKey(customer)), null);
        assert.ok((await detail(jobId)).hold_cleaned_at instanceof Date);
        // Cleanup removes the hold only. The command job keeps waiting for its issued operation.
        assert.equal((await jobRow(jobId)).status, 'awaiting-devices');
        // The mark ends the cleanup work: the next run reports nothing and keeps the first mark.
        const marked = (await detail(jobId)).hold_cleaned_at;
        assert.equal(await service.cleanup(customer), 0);
        assert.deepEqual((await detail(jobId)).hold_cleaned_at, marked);

        // The fence accepts the released status itself, and still refuses a live job.
        const released = await makeCommandJob({ devices: ['b5-wait2'] });
        assert.equal(await service.admit(customer), false);
        const releasedToken = await tokenOf(released.jobId);
        assert.equal(
          (
            await result(
              'SELECT cc.finish_device_update_job($1,$2,$3) AS result',
              [customer, released.jobId, releasedToken],
            )
          ).status,
          'awaiting-devices',
        );
        await admin(
          'UPDATE cc.device_update_jobs SET hold_written_at=clock_timestamp() WHERE job_id=$1',
          [released.jobId],
        );
        assert.equal(
          await result('SELECT cc.clean_device_update_hold($1,$2) AS result', [
            customer,
            released.jobId,
          ]),
          true,
        );
        assert.ok(
          (await detail(released.jobId)).hold_cleaned_at instanceof Date,
        );
        const running = await makeJob({ devices: ['b5-wait3'] });
        assert.equal(await service.admit(customer), false);
        await admin(
          'UPDATE cc.device_update_jobs SET hold_written_at=clock_timestamp() WHERE job_id=$1',
          [running.jobId],
        );
        assert.equal(
          await result('SELECT cc.clean_device_update_hold($1,$2) AS result', [
            customer,
            running.jobId,
          ]),
          false,
        );
        assert.equal((await detail(running.jobId)).hold_cleaned_at, null);
      },
    );
  } finally {
    await stopRedis().catch(() => undefined);
    await migrator
      .query('UPDATE cc.google_connection SET active=$1 WHERE customer_id=$2', [
        wasActive,
        customer,
      ])
      .catch(() => undefined);
    await migrator
      .query('DELETE FROM cc.job_publications WHERE customer_id=$1', [customer])
      .catch(() => undefined);
    for (const id of principals)
      await migrator
        .query('DELETE FROM cc.application_principals WHERE id=$1', [id])
        .catch(() => undefined);
  }
  if (failures.length)
    throw new Error(`Job service checks failed: ${failures.join(' | ')}`);
  return results;
}
