import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Card Q1b: the adversarial attacks of the device-write slice on admin-sdk-mock.
 *
 * One fresh installation runs the P2 checks first and then this module when
 * `CC_Q1_ATTACKS=1`. Every attack reads durable state: Postgres rows, Redis
 * keys, the mock rule list, Kestra executions, and API answers. A failed
 * attack records a minimal reproduction and never changes product code.
 *
 * `CC_Q1_ATTACKS_ONLY` names a comma-separated subset for development. The
 * card contract runs every attack with the variable unset.
 */

const terminalJobStates = new Set([
  'completed',
  'completed-with-errors',
  'failed',
  'needs-review',
]);
const terminalExecutionStates = new Set([
  'SUCCESS',
  'WARNING',
  'FAILED',
  'KILLED',
  'CANCELLED',
]);
const PATCH_METHOD = 'directory.chromeosdevices.patch';
const GET_METHOD = 'directory.chromeosdevices.get';
const COUNTER_COUNT = 1_000_000;
const VALUE_MAX = 200;

/** A recorder keeps every check and its durable evidence for the hand-off. */
function recorder(id, title) {
  const checks = [];
  const observations = {};
  return {
    id,
    title,
    checks,
    observations,
    check(label, condition, detail) {
      checks.push({ label, pass: Boolean(condition), detail });
    },
    observe(name, value) {
      observations[name] = value;
    },
    result() {
      const failed = checks.filter((check) => !check.pass);
      // An observations-only attack has no acceptance item. `observed` says so.
      // An attack with a ruled Not verified window keeps its checks, and its
      // result never fails the run.
      const status =
        failed.length > 0
          ? 'fail'
          : observations.notVerified !== undefined
            ? 'unverified'
            : checks.length > 0
              ? 'pass'
              : observations.observationOnly === true
                ? 'observed'
                : 'unverified';
      return { id, title, status, checks, observations };
    },
  };
}

function cookieValue(headers, name) {
  const entries = headers['set-cookie'] ?? [];
  const match = entries.find((entry) => entry.startsWith(`${name}=`));
  return match === undefined ? null : match.split(';')[0];
}

function cookieHeader(headers) {
  return (headers['set-cookie'] ?? [])
    .map((entry) => entry.split(';')[0])
    .join('; ');
}

/** Wait for one condition. The caller names the state that never arrived. */
async function waitUntil(
  label,
  read,
  { timeout = 60_000, interval = 250 } = {},
) {
  const deadline = Date.now() + timeout;
  let value;
  let error;
  for (;;) {
    try {
      value = await read();
      error = undefined;
      if (value) return value;
    } catch (caught) {
      error = caught;
    }
    if (Date.now() >= deadline) {
      const detail = error === undefined ? '' : ` Last error: ${error.message}`;
      throw new Error(`${label} did not happen within ${timeout} ms.${detail}`);
    }
    await delay(interval);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not answer JSON: ${text.slice(0, 500)}`);
  }
}

/**
 * The harness session of one review identity. A 401 re-signs the identity,
 * because a Redis restart removes every session (scope item 11).
 */
function createSessions({ request, ca, publicOrigin }) {
  const signIn = async (identity) => {
    const start = await request(`${publicOrigin}/api/auth/login`, { ca });
    assert.equal(start.status, 303, start.text);
    const login = cookieValue(start.headers, '__Host-cc-login');
    assert.ok(login, 'The sign-in start set no login cookie.');
    const authorize = new URL(start.headers.location);
    authorize.searchParams.set('review_identity', identity);
    const granted = await request(authorize, { ca });
    assert.equal(granted.status, 303, granted.text);
    const finish = await request(new URL(granted.headers.location), {
      ca,
      cookie: login,
    });
    assert.equal(finish.status, 303, finish.text);
    const session = cookieValue(finish.headers, '__Host-cc-session');
    assert.ok(session, `Sign-in for ${identity} set no session cookie.`);
    const state = await request(`${publicOrigin}/api/auth/session`, {
      ca,
      cookie: session,
    });
    assert.equal(state.status, 200, state.text);
    const body = parseJson(state.text, 'The session read');
    return {
      identity,
      cookie: session,
      csrfToken: body.csrfToken,
      identityId: body.identity.id,
    };
  };
  return { signIn };
}

/** The mock control API: the faults list is the counter and the send barrier. */
function createMock({ mock }) {
  const control = async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(`${mock.controlUrl}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    const text = response.status === 204 ? '' : await response.text();
    assert.ok(
      [200, 201, 204].includes(response.status),
      `The mock control API answered ${response.status} for ${path}: ${text}`,
    );
    return text === '' ? null : JSON.parse(text);
  };
  const clearFaults = () =>
    control(`/domains/${mock.customerId}/faults`, { method: 'DELETE' });
  const addFault = (rule) =>
    control(`/domains/${mock.customerId}/faults`, {
      method: 'POST',
      body: rule,
    });
  const faults = () => control(`/domains/${mock.customerId}/faults`);
  /** The counter goes first: a status rule before it would answer unseen calls. */
  const addCounter = () =>
    addFault({
      kind: 'hang',
      method: PATCH_METHOD,
      ms: 1,
      count: COUNTER_COUNT,
    });
  const patchCounter = async () => {
    const list = await faults();
    const counter = list.find(
      (fault) =>
        fault.rule.kind === 'hang' &&
        fault.rule.method === PATCH_METHOD &&
        fault.rule.count === COUNTER_COUNT,
    );
    assert.ok(counter, 'The PATCH counter is missing from the rule list.');
    return counter;
  };
  const patchCount = async () =>
    COUNTER_COUNT - (await patchCounter()).remaining;
  const remainingOf = async (id) => {
    const list = await faults();
    return list.find((fault) => fault.id === id)?.remaining ?? null;
  };
  const waitRemaining = async (id, expected, timeout = 60000) =>
    waitUntil(
      `The fault rule ${id} did not read ${expected}`,
      async () => (await remainingOf(id)) === expected,
      { timeout },
    );
  return {
    control,
    clearFaults,
    addFault,
    faults,
    addCounter,
    patchCounter,
    patchCount,
    remainingOf,
    waitRemaining,
  };
}

function createDb({ migrator, customer }) {
  const query = (text, values = []) => migrator.query(text, values);
  const row = async (text, values = []) => (await query(text, values)).rows[0];
  const job = (jobId) =>
    row(
      `SELECT j.job_id,j.display_id,j.status,j.failure,j.revision,j.created_at,j.admitted_at,
        j.started_at,j.finished_at,j.succeeded,j.failed,j.unknown,j.skipped,j.target_count,
        j.correlation_id,u.preview_id,u.dispatch_token,u.dispatch_count,u.start_deadline_at,
        u.kestra_execution_id,u.first_claimed_at,u.heartbeat_at,u.hold_written_at,u.hold_cleaned_at,
        u.hold_attempt,u.hold_sequence,u.batch_size,u.batch_count,u.scope_observations,u.scope_failure
       FROM cc.jobs j JOIN cc.device_update_jobs u ON u.job_id=j.job_id WHERE j.job_id=$1`,
      [jobId],
    );
  const jobByDisplay = (displayId) =>
    row(
      `SELECT j.job_id,j.display_id,j.status,j.failure,j.revision,j.created_at,j.admitted_at,
        j.started_at,j.finished_at,j.succeeded,j.failed,j.unknown,j.skipped,j.target_count,
        u.preview_id,u.dispatch_token,u.batch_size,u.batch_count
       FROM cc.jobs j JOIN cc.device_update_jobs u ON u.job_id=j.job_id
       WHERE j.customer_id=$1 AND j.display_id=$2`,
      [customer, displayId],
    );
  const operations = async (jobId) =>
    (
      await query(
        `SELECT operation_number,device_id,serial_number,status,attempt_id,verified_by,
          observed_value,requested_value,observed_at,outcome_reason,google_status,google_reason,quota_retries,
          transient_retries,verify_attempt,verify_after,updated_at,batch
         FROM cc.device_update_operations WHERE job_id=$1 ORDER BY operation_number`,
        [jobId],
      )
    ).rows;
  const batches = async (jobId) =>
    (
      await query(
        `SELECT batch,attempt_id,execution_id,lease_expires_at,claimed_at,settled_at
         FROM cc.device_update_batches WHERE job_id=$1 ORDER BY batch`,
        [jobId],
      )
    ).rows;
  const overlay = async (deviceId) =>
    row(
      `SELECT value,observed_at,source,job_id,operation_number,expires_at
       FROM cc.device_write_overlays WHERE customer_id=$1 AND device_id=$2
         AND field='annotatedLocation'`,
      [customer, deviceId],
    );
  const device = async (deviceId) =>
    row(
      `SELECT device_id,serial_number,annotated_location,annotated_location_observed_at,
        last_entity_sync,removed_at,record_version
       FROM cc.devices WHERE customer_id=$1 AND device_id=$2`,
      [customer, deviceId],
    );
  const publications = async (jobId) =>
    (
      await query(
        `SELECT publication_id,revision,status_changed,device_ids,removed_ids,batch,created_at
         FROM cc.job_publications WHERE job_id=$1 ORDER BY publication_id`,
        [jobId],
      )
    ).rows;
  const syncState = () =>
    row(
      `SELECT failure,failure_requested_by,telemetry_failure,
        telemetry_failure_requested_by,generation,device_count,observed_at,checked_at
       FROM cc.device_sync_state WHERE customer_id=$1`,
      [customer],
    );
  const appointment = async (jobId) =>
    row(
      `SELECT job_id,preview_id,batch_size,batch_count,dispatch_token,dispatch_count,
        start_deadline_at,kestra_execution_id,first_claimed_at,heartbeat_at,hold_written_at,
        hold_cleaned_at
       FROM cc.device_update_jobs WHERE job_id=$1`,
      [jobId],
    );
  const writeJobCount = async (previewId) =>
    Number(
      (
        await row(
          'SELECT count(*)::integer AS count FROM cc.device_update_jobs WHERE preview_id=$1',
          [previewId],
        )
      ).count,
    );
  return {
    query,
    row,
    job,
    jobByDisplay,
    operations,
    batches,
    overlay,
    device,
    publications,
    syncState,
    appointment,
    writeJobCount,
  };
}

function createKestra({ kestra }) {
  const headers = { authorization: kestra.authorization };
  const execution = async (executionId) => {
    const response = await fetch(
      `${kestra.origin}/api/v1/main/executions/${executionId}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    assert.equal(
      response.status,
      200,
      `The Kestra execution read answered ${response.status}.`,
    );
    return response.json();
  };
  const waitExecution = async (executionId, timeout = 600_000) =>
    waitUntil(
      `Execution ${executionId} did not end`,
      async () => {
        const current = await execution(executionId);
        return terminalExecutionStates.has(current.state.current)
          ? current
          : null;
      },
      { timeout, interval: 500 },
    );
  const start = async (flowId, inputs) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(inputs))
      if (value !== undefined) form.set(key, String(value));
    const response = await fetch(
      `${kestra.origin}/api/v1/main/executions/campus.application/${flowId}`,
      { method: 'POST', headers, body: form },
    );
    const text = await response.text();
    assert.equal(
      response.status,
      200,
      `The Kestra start answered ${response.status}: ${text}`,
    );
    return JSON.parse(text).id;
  };
  const search = async (flowId, size = 100) => {
    const response = await fetch(
      `${kestra.origin}/api/v1/main/executions/search?namespace=campus.application&flowId=${flowId}&size=${size}&sort=state.startDate:desc`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    assert.equal(
      response.status,
      200,
      `The Kestra execution search answered ${response.status}.`,
    );
    return (await response.json()).results ?? [];
  };
  /** Every task output of an execution, including a ForEach iteration's tasks. */
  const taskOutputs = (detail) => {
    const out = [];
    const walk = (runs = []) => {
      for (const run of runs) {
        out.push({
          taskId: run.taskId,
          value: run.value,
          state: run.state?.current ?? null,
          outputs: run.outputs ?? null,
        });
        if (Array.isArray(run.taskRunList)) walk(run.taskRunList);
      }
    };
    walk(detail.taskRunList ?? []);
    return out;
  };
  const responseBody = (entry) => {
    const outputs = entry.outputs;
    if (outputs == null) return null;
    const body = outputs.body ?? outputs;
    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch {
        return body;
      }
    }
    return body;
  };
  return {
    start,
    execution,
    waitExecution,
    search,
    taskOutputs,
    responseBody,
    async waitReady(timeout = 180_000) {
      return waitUntil(
        'Kestra did not answer after the restart',
        async () => {
          try {
            const response = await fetch(
              `${kestra.origin}/api/v1/main/flows/search?size=1`,
              { headers, signal: AbortSignal.timeout(2000) },
            );
            return response.ok;
          } catch {
            return false;
          }
        },
        { timeout, interval: 500 },
      );
    },
  };
}

/** The Kestra and database seed of one write job, shaped like device-write-mock. */
function createSeeder({ db, mock, customer }) {
  return async function seedJob({
    devices,
    value,
    mode = 'replace',
    batchSize = devices.length,
    beforeStart,
    waitForStart = true,
    principal,
  }) {
    assert.ok(devices.length >= 1, 'A seeded job needs at least one device.');
    assert.ok(
      Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 250,
      'A seeded job needs a batch size from 1 to 250.',
    );
    const owner =
      principal ??
      (await db.row(
        `SELECT p.id, p.permission_version FROM cc.application_principals p
            WHERE p.enabled AND EXISTS(
              SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p.id
                AND g.action='devices:bulk-actions')
            ORDER BY p.created_at ASC LIMIT 1`,
      ));
    assert.ok(
      owner,
      'The installation holds a principal with devices:bulk-actions.',
    );
    const connection = await db.row(
      'SELECT customer_id, generation FROM cc.google_connection WHERE customer_id=$1 AND active',
      [customer],
    );
    assert.ok(connection, 'The installation holds an active connection.');
    const jobId = randomUUID();
    const previewId = randomUUID();
    const batchCount = Math.ceil(devices.length / batchSize);
    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO cc.device_update_previews(preview_id,display_id,customer_id,created_by,
          permission_version,generation,field,mode,value,selected,eligible,unchanged,excluded,
          manifest_digest,expires_at)
         VALUES($1,cc.job_display_id('PV',nextval('cc.preview_number_pv')),$2,$3,$4,$5,
           'annotatedLocation',$6,$7,$8,$8,0,0,'manifest-digest',clock_timestamp()+interval '1 hour')`,
        [
          previewId,
          customer,
          owner.id,
          owner.permission_version,
          connection.generation,
          mode,
          mode === 'clear' ? null : value,
          devices.length,
        ],
      );
      await db.query(
        `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,
          generation,target_count,correlation_id,created_at)
         VALUES($1,cc.job_display_id('UPD',nextval('cc.job_number_upd')),$2,'device-update',
           'devices','accepted',$3,$4,$5,$6,clock_timestamp())`,
        [
          jobId,
          customer,
          owner.id,
          connection.generation,
          devices.length,
          randomUUID(),
        ],
      );
      await db.query(
        `INSERT INTO cc.device_update_jobs(job_id,preview_id,field,mode,value,confirmed_by,
          confirmer_permission_version,delegated_subject,batch_size,batch_count)
         VALUES($1,$2,'annotatedLocation',$3,$4,$5,$6,$7,$8,$9)`,
        [
          jobId,
          previewId,
          mode,
          mode === 'clear' ? null : value,
          owner.id,
          owner.permission_version,
          mock.adminEmail,
          batchSize,
          batchCount,
        ],
      );
      for (const [index, deviceId] of devices.entries()) {
        const frozen = await db.row(
          `SELECT serial_number,org_unit_path FROM cc.devices
            WHERE customer_id=$1 AND device_id=$2`,
          [customer, deviceId],
        );
        assert.ok(
          frozen,
          `The device ${deviceId} is missing from the inventory.`,
        );
        await db.query(
          `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,
            serial_number,org_unit_path,baseline_value,requested_value,batch,status)
           VALUES($1,$2,$3,$4,$5,NULL,$6,$7,'pending')`,
          [
            jobId,
            index + 1,
            deviceId,
            frozen.serial_number,
            frozen.org_unit_path,
            mode === 'clear' ? null : value,
            Math.floor(index / batchSize),
          ],
        );
      }
      if (beforeStart) await beforeStart();
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    const record = { jobId, previewId, batchCount };
    if (!waitForStart) return record;
    const started = await waitUntil(
      'The job service did not admit and start the seeded job',
      async () => {
        const state = await db.appointment(jobId);
        if (state?.kestra_execution_id) return state;
        const header = await db.job(jobId);
        assert.notEqual(
          header?.status,
          'failed',
          `The job service failed the seeded job: ${header?.failure}`,
        );
        return null;
      },
      { timeout: 180_000, interval: 250 },
    );
    return { ...record, executionId: started.kestra_execution_id };
  };
}

/** One API helper around a session. A 401 re-signs and replays once. */
function createApi({ request, ca, publicOrigin, sessions }) {
  const call = async (
    session,
    path,
    { method = 'GET', body, headers = {} } = {},
  ) => {
    const send = () =>
      request(`${publicOrigin}${path}`, {
        ca,
        cookie: session.cookie,
        method,
        body,
        headers: {
          ...(method === 'GET'
            ? {}
            : { origin: publicOrigin, 'x-csrf-token': session.csrfToken }),
          ...headers,
        },
      });
    let response = await send();
    if (response.status === 401) {
      const fresh = await sessions.signIn(session.identity);
      Object.assign(session, fresh);
      response = await send();
    }
    return response;
  };
  return { call };
}

export async function runDeviceWriteAttacks(options) {
  const {
    docker,
    mock,
    kestra,
    migrator,
    redis,
    request,
    ca,
    publicOrigin,
    customer,
    restartApi,
    restartWorker,
    redisName,
    kestraName,
    workerName,
    connectRedis,
  } = options;
  const db = createDb({ migrator, customer });
  const faults = createMock({ mock });
  const kestraApi = createKestra({ kestra });
  const sessions = createSessions({ request, ca, publicOrigin });
  const api = createApi({ request, ca, publicOrigin, sessions });
  const seedJob = createSeeder({ db, mock, customer });
  const admin = await sessions.signIn('administrator');

  // Scope item 2: subscribe to the entity channel and the job channel for the whole run.
  const events = [];
  const subscribers = [];
  /** A subscriber for one Redis client. A restart replaces its port. */
  const subscribeOn = async (client) => {
    const next = client.duplicate();
    next.on('error', () => undefined);
    if (!next.isOpen) await next.connect();
    await next.subscribe(`cc:entity-events:${customer}`, (message) => {
      try {
        events.push({
          channel: 'entity',
          at: Date.now(),
          event: JSON.parse(message),
        });
      } catch {
        /* A malformed message is visible in the count and the hand-off. */
      }
    });
    await next.subscribe(`cc:job-events:${customer}`, (message) => {
      try {
        events.push({
          channel: 'job',
          at: Date.now(),
          event: JSON.parse(message),
        });
      } catch {
        /* A malformed message is visible in the count and the hand-off. */
      }
    });
    return next;
  };
  const resubscribe = async (client) => {
    // A replacement subscriber must stay in the tracking list, or the finalizer
    // cannot close it and the process never ends.
    const previous = subscribers.splice(0);
    let next;
    try {
      next = await subscribeOn(client);
    } catch (error) {
      // Keep the old subscribers tracked, so the finalizer still closes them.
      subscribers.push(...previous);
      throw error;
    }
    subscribers.push(next);
    // The old connections point at the stopped server. A command such as QUIT
    // would queue on a reconnect that never completes, so close them directly.
    for (const one of previous) one.destroy();
    return next;
  };
  const subscriber = await subscribeOn(await connectRedis());
  subscribers.push(subscriber);
  // Clients this run creates. The finally closes them, or the process never ends.
  const ownedClients = [];
  const trackClient = (client) => {
    ownedClients.push(client);
    return client;
  };
  // The Devices streams of S14. The finally closes them even if the attack fails.
  const streamClients = [];
  const trackStream = (stream) => {
    streamClients.push(stream);
    return stream;
  };

  const allDevices = (
    await db.query(
      'SELECT device_id FROM cc.devices WHERE customer_id=$1 AND removed_at IS NULL ORDER BY device_id',
      [customer],
    )
  ).rows.map((row) => row.device_id);
  // The first devices belong to the P2 checks. Each attack takes fresh ones.
  let cursor = Math.min(12, Math.max(0, allDevices.length - 1));
  const takeDevices = (count) => {
    assert.ok(
      cursor + count <= allDevices.length,
      `The inventory holds no ${count} fresh devices for an attack.`,
    );
    const taken = allDevices.slice(cursor, cursor + count);
    cursor += count;
    return taken;
  };

  const nothingToVerify = [];
  const results = [];
  const runAttack = async (id, title, body) => {
    if (only.length > 0 && !only.includes(id)) return null;
    const rec = recorder(id, title);
    const startedAt = Date.now();
    await faults.clearFaults().catch(() => undefined);
    try {
      await body(rec);
    } catch (error) {
      rec.check('The attack ran to its end', false, error.message);
      rec.observe('error', error.stack ?? error.message);
    } finally {
      // Every attack leaves the installation usable, whatever it observed.
      try {
        docker('unpause', redisName);
      } catch {
        /* The container was not paused. */
      }
      try {
        docker('start', kestraName);
      } catch {
        /* The container is running. */
      }
      try {
        docker('start', workerName);
      } catch {
        /* The container is running. */
      }
      await faults.clearFaults().catch(() => undefined);
      rec.observe(
        'durationSeconds',
        Math.round((Date.now() - startedAt) / 1000),
      );
      results.push(rec.result());
      // A long run prints each attack as it ends, so a stall is visible.
      for (const check of rec.checks)
        process.stdout.write(
          `Q1B ${id} ${check.pass ? 'PASS' : 'FAIL'} ${check.label}` +
            (check.pass
              ? ''
              : ` :: ${JSON.stringify(check.detail).slice(0, 1200)}`) +
            '\n',
        );
      if (rec.observations.error)
        process.stdout.write(`Q1B ${id} ERROR ${rec.observations.error}\n`);
      process.stdout.write(
        `Q1B ${id} end ${rec.observations.durationSeconds}s\n`,
      );
    }
    return rec.result();
  };

  const only = String(process.env.CC_Q1_ATTACKS_ONLY ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const identities = ['administrator', 'review-recipient', 'review-observer'];

  try {
    return await runCatalog({
      ...options,
      admin,
      api,
      db,
      faults,
      kestraApi,
      seedJob,
      sessions,
      events,
      subscriber,
      takeDevices,
      runAttack,
      results,
      nothingToVerify,
      docker,
      redisName,
      kestraName,
      workerName,
      restartApi,
      restartWorker,
      connectRedis,
      subscribeOn,
      resubscribe,
      trackClient,
      trackStream,
      identities,
      only,
    });
  } finally {
    // The subscribers hold open sockets. Without this close the process never
    // ends. A graceful QUIT would queue on a reconnecting client, so destroy.
    for (const one of subscribers.splice(0)) {
      try {
        one.destroy();
      } catch {
        /* The client is already closed. */
      }
    }
    for (const one of ownedClients.splice(0)) {
      try {
        one.destroy();
      } catch {
        /* The client is already closed. */
      }
    }
    for (const stream of streamClients.splice(0)) {
      try {
        stream.close();
      } catch {
        /* The stream is already closed. */
      }
    }
  }
}
/** A JSON answer or a plain-text one, for a check that only records the body. */
function bodyOf(response) {
  try {
    return JSON.parse(response.text);
  } catch {
    return response.text;
  }
}

/** The card's attack catalog. Each item reads its durable outcome. */
async function runCatalog(context) {
  const {
    admin,
    api,
    db,
    faults,
    kestraApi,
    seedJob,
    sessions,
    events,
    takeDevices,
    runAttack,
    results,
    nothingToVerify,
    docker,
    redisName,
    kestraName,
    kestra,
    workerName,
    restartApi,
    restartWorker,
    connectRedis,
    restartRedis,
    subscribeOn,
    resubscribe,
    trackClient,
    trackStream,
    only,
    mock,
    customer,
    redis,
    publicOrigin,
    request,
    ca,
  } = context;

  const tabId = () => randomUUID();
  // The harness Redis client. Scope item 11 replaces it after a restart.
  let cache = redis;
  const jobTerminal = (jobId, timeout = 600_000) =>
    waitUntil(
      `The job ${jobId} did not end`,
      async () => {
        const job = await db.job(jobId);
        return job && terminalJobStates.has(job.status) ? job : null;
      },
      { timeout, interval: 500 },
    );
  const apiJson = async (session, path, options = {}, expected = [200]) => {
    const response = await api.call(session, path, options);
    assert.ok(
      expected.includes(response.status),
      `${options.method ?? 'GET'} ${path} answered ${response.status}: ${response.text.slice(0, 800)}`,
    );
    return bodyOf(response);
  };
  const sessionNow = async (identity) => sessions.signIn(identity);
  const select = async (session, deviceIds) => {
    const grid = tabId();
    await apiJson(session, '/api/devices/selection/ops', {
      method: 'POST',
      body: {
        gridId: 'devices',
        tabId: grid,
        ops: [{ op: 'select', ids: deviceIds }],
      },
    });
    return grid;
  };
  const preview = async (session, deviceIds, body) => {
    const grid = await select(session, deviceIds);
    return apiJson(
      session,
      '/api/devices/updates/previews',
      { method: 'POST', body: { gridId: 'devices', tabId: grid, ...body } },
      [201],
    );
  };
  const confirm = async (session, previewId, digest) =>
    apiJson(
      session,
      `/api/devices/updates/previews/${previewId}/confirm`,
      { method: 'POST', body: { manifestDigest: digest, acknowledged: true } },
      [200, 201],
    );
  const refreshAll = async (session) =>
    apiJson(
      session,
      '/api/devices/sync',
      { method: 'POST', body: {} },
      [200, 201, 202],
    );
  const syncState = async (session) =>
    (await apiJson(session, '/api/devices/sync')).sync;
  const queryPage = async (session, options = {}) =>
    (
      await apiJson(session, '/api/devices/query', {
        method: 'POST',
        body: { limit: 50, offset: 0, ...options },
      })
    ).page;
  const byIds = async (session, deviceIds) =>
    (
      await apiJson(session, '/api/devices/by-ids', {
        method: 'POST',
        body: { deviceIds },
      })
    ).rows;
  const makeStale = async (deviceId, hours = 25) => {
    await db.query(
      `UPDATE cc.devices SET last_entity_sync=clock_timestamp()-($2||' hours')::interval
        WHERE customer_id=$1 AND device_id=$3`,
      [customer, String(hours), deviceId],
    );
  };
  const retrySums = async (jobId) => {
    const row = await db.row(
      `SELECT COALESCE(sum(quota_retries),0)::integer AS quota,
        COALESCE(sum(transient_retries),0)::integer AS transient,
        count(*)::integer AS operations
       FROM cc.device_update_operations WHERE job_id=$1`,
      [jobId],
    );
    return row;
  };
  const refreshJob = async (refreshJobId, timeout = 240_000) =>
    waitUntil(
      `The refresh job ${refreshJobId} did not end`,
      async () => {
        const row = await db.row(
          `SELECT j.job_id,j.display_id,j.status,j.failure FROM cc.jobs j
            WHERE j.customer_id=$1 AND j.job_id=$2`,
          [customer, refreshJobId],
        );
        return row && terminalJobStates.has(row.status) ? row : null;
      },
      { timeout, interval: 500 },
    );

  /** The Devices stream of one session. Frames carry the event type and payload. */
  const openStream = (session) => {
    const frames = [];
    let buffer = '';
    const target = new URL(`${publicOrigin}/api/devices/events`);
    const stream = https.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'GET',
        ca,
        headers: { cookie: session.cookie, accept: 'text/event-stream' },
      },
      (response) => {
        stream.status = response.statusCode;
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          buffer += chunk;
          for (;;) {
            const end = buffer.indexOf('\n\n');
            if (end < 0) break;
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const type = /^event: (.+)$/m.exec(frame)?.[1] ?? 'message';
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (data === undefined) continue;
            try {
              frames.push({ type, data: JSON.parse(data), at: Date.now() });
            } catch {
              frames.push({ type, data, at: Date.now() });
            }
          }
        });
      },
    );
    stream.on('error', (error) => {
      stream.error = error?.message ?? String(error);
    });
    stream.on('timeout', () => {
      stream.error = 'timeout';
    });
    stream.end();
    // `status` and `error` land on the request object. The returned wrapper must
    // read them, or a gate on `status` can never pass.
    return {
      frames,
      close: () => stream.destroy(),
      get status() {
        return stream.status;
      },
      get error() {
        return stream.error;
      },
    };
  };

  /** The accepted value of one device from the grid read. */
  const rowOf = async (session, deviceId) => {
    const page = await byIds(session, [deviceId]);
    return Array.isArray(page) ? page[0] : page.rows?.[0];
  };

  // Scope item 2: the whole-run subscriptions. `events` collects entity and job messages.
  const jobEvents = events;
  /** Scope item 16: every throttled job, for the retry sums. */
  const throttledJobs = [];

  // ---------------------------------------------------------------------------
  // Scope item 3: duplicate submission (design:578).
  // ---------------------------------------------------------------------------
  await runAttack('S3', 'Duplicate submission of one preview', async (rec) => {
    const [deviceId] = takeDevices(1);
    await faults.addCounter();
    const prepared = await preview(admin, [deviceId], {
      mode: 'replace',
      value: 'Duplicate room',
    });
    const send = () =>
      api.call(
        admin,
        `/api/devices/updates/previews/${prepared.previewId}/confirm`,
        {
          method: 'POST',
          body: { manifestDigest: prepared.manifestDigest, acknowledged: true },
        },
      );
    const [first, second] = await Promise.all([send(), send()]);
    const third = await send();
    const answers = [first, second, third];
    rec.observe(
      'confirmAnswers',
      answers.map((answer) => ({
        status: answer.status,
        body: bodyOf(answer),
      })),
    );
    const statuses = answers.map((answer) => answer.status).sort();
    rec.check(
      'One confirm answers 201 and the other two answer 200',
      statuses.length === 3 &&
        statuses[0] === 200 &&
        statuses[1] === 200 &&
        statuses[2] === 201,
      statuses,
    );
    const jobIds = new Set(
      answers
        .filter((answer) => answer.status < 300)
        .map((answer) => bodyOf(answer).jobId),
    );
    rec.check('All three answers carry one jobId', jobIds.size === 1, [
      ...jobIds,
    ]);
    const jobId = [...jobIds][0];
    const job = await jobTerminal(jobId);
    rec.observe('job', {
      status: job.status,
      targetCount: job.target_count,
      succeeded: job.succeeded,
    });
    rec.check(
      'The write job table holds one row for the preview',
      (await db.writeJobCount(prepared.previewId)) === 1,
      await db.writeJobCount(prepared.previewId),
    );
    rec.check(
      'The PATCH count equals the device count',
      (await faults.patchCount()) === 1,
      await faults.patchCount(),
    );
  });

  // ---------------------------------------------------------------------------
  // Scope item 4: duplicate dispatch (design:966-974).
  // ---------------------------------------------------------------------------
  await runAttack('S4', 'Duplicate dispatch of one job', async (rec) => {
    const devices = takeDevices(2);
    await faults.addCounter();
    const hang = await faults.addFault({
      kind: 'hang',
      method: PATCH_METHOD,
      ms: 8000,
      count: 2,
    });
    const seeded = await seedJob({
      devices,
      value: 'Duplicate dispatch',
      batchSize: 1,
    });
    await faults.waitRemaining(hang.id, 1, 120_000);
    const before = await db.appointment(seeded.jobId);
    const captured = [];
    for (const operation of await db.operations(seeded.jobId))
      if (operation.attempt_id !== null)
        captured.push({
          number: operation.operation_number,
          attempt: operation.attempt_id,
        });
    const secondExecution = await kestraApi.start('device_update', {
      customerId: customer,
      jobId: seeded.jobId,
      dispatchToken: before.dispatch_token,
      batches: '[0,1]',
      correlationId: randomUUID(),
    });
    // The first batch settles while the second execution is in flight. Capture
    // the attempt of every operation that the first attempt claims.
    const allCaptured = await waitUntil(
      'The first execution did not claim both batches',
      async () => {
        const operations = await db.operations(seeded.jobId);
        return operations.every((operation) => operation.attempt_id !== null)
          ? operations
          : null;
      },
      { timeout: 120_000, interval: 100 },
    );
    for (const operation of allCaptured)
      if (!captured.some((one) => one.number === operation.operation_number))
        captured.push({
          number: operation.operation_number,
          attempt: operation.attempt_id,
        });
    const [second, first] = await Promise.all([
      kestraApi.waitExecution(secondExecution),
      kestraApi.waitExecution(seeded.executionId),
    ]);
    const job = await jobTerminal(seeded.jobId);
    const outputs = kestraApi.taskOutputs(second).map((entry) => ({
      taskId: entry.taskId,
      state: entry.state,
      body: kestraApi.responseBody(entry),
    }));
    rec.observe('secondDispatchOutputs', outputs);
    rec.observe('executionStates', {
      first: first.state.current,
      second: second.state.current,
    });
    const done = outputs.some(
      (entry) => entry.taskId === 'dispatch' && entry.body?.outcome === 'done',
    );
    rec.check(
      'A dispatch task of the second execution answers done',
      done,
      outputs,
    );
    rec.check(
      'The second execution sends no PATCH',
      (await faults.patchCount()) === 2,
      await faults.patchCount(),
    );
    rec.check(
      'Both executions end SUCCESS',
      first.state.current === 'SUCCESS' && second.state.current === 'SUCCESS',
      {
        first: first.state.current,
        second: second.state.current,
      },
    );
    const after = await db.operations(seeded.jobId);
    const kept = captured.every(
      (one) =>
        after.find((op) => op.operation_number === one.number)?.attempt_id ===
        one.attempt,
    );
    rec.check(
      'Every operation keeps the attempt_id of the first attempt',
      kept,
      after.map((op) => ({
        number: op.operation_number,
        attempt: op.attempt_id,
      })),
    );
    rec.observe('job', {
      status: job.status,
      succeeded: job.succeeded,
      failed: job.failed,
    });
  });

  /** Kill a container and wait until Docker reports it stopped. */
  const killContainer = async (name) => {
    docker('kill', name);
    await waitUntil(
      `The container ${name} did not stop`,
      async () =>
        docker('inspect', '--format', '{{.State.Running}}', name).trim() ===
        'false',
      { timeout: 20_000, interval: 100 },
    );
  };

  /** Record why a container did not become ready after a restart. */
  const containerDiagnosis = (rec, name) => {
    try {
      rec.observe(
        `${name}.state`,
        docker(
          'inspect',
          '--format',
          '{{.State.Status}} {{.State.ExitCode}}',
          name,
        ),
      );
    } catch (error) {
      rec.observe(`${name}.state`, error.message);
    }
    try {
      rec.observe(`${name}.logs`, docker('logs', '--tail', '40', name));
    } catch (error) {
      rec.observe(`${name}.logs`, error.message);
    }
  };

  /** The worker answers on a host port that a restart can change. */
  const workerHealthUrl = () =>
    `http://127.0.0.1:${docker('port', workerName, '3001/tcp').split(':').at(-1).trim()}/health/live`;

  /** Kestra answers on a host port that a restart can change. */
  const refreshKestraOrigin = () => {
    const port = docker('port', kestraName, '8080/tcp')
      .split(':')
      .at(-1)
      .trim();
    kestra.origin = `http://127.0.0.1:${port}`;
    return kestra.origin;
  };

  // ---------------------------------------------------------------------------
  // Scope items 5 and 6: an API restart between admission and start, and a stale token.
  // ---------------------------------------------------------------------------
  await runAttack(
    'S5',
    'API restart between admission and start, then a stale token',
    async (rec) => {
      const [deviceId] = takeDevices(1);
      await faults.addCounter();
      const hang = await faults.addFault({
        kind: 'hang',
        method: PATCH_METHOD,
        ms: 8000,
        count: 1,
      });
      docker('stop', '--time', '90', kestraName);
      try {
        const before = await preview(admin, [deviceId], {
          mode: 'replace',
          value: 'Restart room',
        });
        const receipt = await confirm(
          admin,
          before.previewId,
          before.manifestDigest,
        );
        const jobId = receipt.jobId;
        const admitted = await waitUntil(
          'The job service did not admit the job',
          async () => {
            const job = await db.job(jobId);
            if (job?.status === 'running' && job.dispatch_count >= 1)
              return job;
            return null;
          },
          { timeout: 60_000, interval: 250 },
        );
        rec.observe('firstDispatch', {
          dispatchCount: admitted.dispatch_count,
          token: admitted.dispatch_token,
          executionId: admitted.kestra_execution_id,
          status: admitted.status,
        });
        rec.check(
          'The first dispatch records no execution while Kestra is stopped',
          admitted.kestra_execution_id === null,
          admitted.kestra_execution_id,
        );
        const firstToken = admitted.dispatch_token;
        await restartApi();
        docker('start', kestraName);
        refreshKestraOrigin();
        try {
          await kestraApi.waitReady();
        } catch (error) {
          containerDiagnosis(rec, kestraName);
          throw error;
        }
        const started = await waitUntil(
          'The job service did not start the flow after Kestra returned',
          async () => {
            const job = await db.job(jobId);
            if (job.dispatch_count >= 2 && job.kestra_execution_id !== null)
              return job;
            if (job.status === 'failed')
              throw new Error(`The job failed: ${job.failure}`);
            return null;
          },
          { timeout: 300_000, interval: 500 },
        );
        rec.observe('secondDispatch', {
          dispatchCount: started.dispatch_count,
          token: started.dispatch_token,
          executionId: started.kestra_execution_id,
        });
        rec.check(
          'A new dispatch token replaces the first token',
          started.dispatch_token !== firstToken,
          { firstToken, secondToken: started.dispatch_token },
        );
        rec.check(
          'dispatch_count reads 2 or 3',
          started.dispatch_count === 2 || started.dispatch_count === 3,
          started.dispatch_count,
        );
        const previous = await kestraApi.search('device_update');
        rec.check(
          'No earlier execution carries the first token',
          previous.every((execution) => {
            const body = JSON.stringify(execution.inputs ?? {});
            return !body.includes(firstToken);
          }),
          previous.map((execution) => execution.id),
        );
        // Scope item 6: start the flow with the first token while the new execution holds the hang.
        await faults.waitRemaining(hang.id, 0, 120_000);
        const stale = await kestraApi.start('device_update', {
          customerId: customer,
          jobId,
          dispatchToken: firstToken,
          batches: '[0]',
          correlationId: randomUUID(),
        });
        const staleExecution = await kestraApi.waitExecution(stale);
        // The worker answers are the task runs that carry an outcome. The ForEach
        // task run carries only its own state.
        const staleOutputs = kestraApi
          .taskOutputs(staleExecution)
          .map((entry) => ({
            taskId: entry.taskId,
            state: entry.state,
            body: kestraApi.responseBody(entry),
          }))
          .filter((entry) => entry.body && 'outcome' in entry.body);
        rec.observe('staleExecution', {
          state: staleExecution.state.current,
          outputs: staleOutputs,
        });
        rec.check(
          'Each worker answer of the first-token execution reads superseded',
          staleOutputs.length > 0 &&
            staleOutputs.every((entry) => entry.body?.outcome === 'superseded'),
          staleOutputs,
        );
        const countAtStale = await faults.patchCount();
        const job = await jobTerminal(jobId);
        rec.check(
          'The PATCH count does not change through the stale execution',
          (await faults.patchCount()) === countAtStale,
          {
            atStale: countAtStale,
            after: await faults.patchCount(),
          },
        );
        rec.observe('job', {
          status: job.status,
          succeeded: job.succeeded,
          failed: job.failed,
        });
        rec.check(
          'The job ends completed',
          job.status === 'completed',
          job.status,
        );
        rec.check(
          'The PATCH count equals the device count',
          (await faults.patchCount()) === 1,
          await faults.patchCount(),
        );
      } finally {
        try {
          docker('start', kestraName);
        } catch {
          /* Kestra was already running. */
        }
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Scope item 7: a worker killed mid-batch (P2 item 12).
  // ---------------------------------------------------------------------------
  const workerHealthy = async (timeout = 30_000) =>
    waitUntil(
      'The worker did not answer',
      async () => {
        try {
          const response = await fetch(workerHealthUrl(), {
            signal: AbortSignal.timeout(2000),
          });
          return response.ok;
        } catch {
          return false;
        }
      },
      { timeout, interval: 250 },
    );

  await runAttack('S7', 'A worker killed mid-batch', async (rec) => {
    const devices = takeDevices(2);
    await faults.addCounter();
    const hang = await faults.addFault({
      kind: 'hang',
      method: PATCH_METHOD,
      ms: 8000,
      count: 1,
    });
    const seeded = await seedJob({
      devices,
      value: 'Killed batch',
      batchSize: 2,
    });
    const firstClaim = await waitUntil(
      'The batch was not claimed',
      async () =>
        (await db.appointment(seeded.jobId))?.first_claimed_at ?? null,
      { timeout: 120_000, interval: 200 },
    );
    await faults.waitRemaining(hang.id, 0, 120_000);
    const killedAt = Date.now();
    await killContainer(workerName);
    docker('start', workerName);
    const startIssued = Date.now();
    try {
      await workerHealthy(60_000);
    } catch (error) {
      containerDiagnosis(rec, workerName);
      throw error;
    }
    rec.check(
      'The worker start is issued within 5 s of the kill',
      startIssued - killedAt <= 5000,
      startIssued - killedAt,
    );
    const job = await jobTerminal(seeded.jobId, 900_000);
    const operations = await db.operations(seeded.jobId);
    const batch = (await db.batches(seeded.jobId))[0];
    rec.observe(
      'operations',
      operations.map((one) => ({
        number: one.operation_number,
        status: one.status,
        verifiedBy: one.verified_by,
        attempt: one.attempt_id,
      })),
    );
    rec.observe('batch', {
      claimedAt: batch.claimed_at,
      settledAt: batch.settled_at,
      attempt: batch.attempt_id,
    });
    rec.check(
      'The retry claim is at least 210 s after the first claim',
      batch.claimed_at !== null &&
        new Date(batch.claimed_at).getTime() - new Date(firstClaim).getTime() >=
          210_000,
      {
        firstClaim,
        claimedAt: batch.claimed_at,
        seconds:
          batch.claimed_at === null
            ? null
            : Math.round(
                (new Date(batch.claimed_at).getTime() -
                  new Date(firstClaim).getTime()) /
                  1000,
              ),
      },
    );
    rec.check(
      'Both operations end succeeded with verified_by read-back',
      operations.length === 2 &&
        operations.every(
          (one) =>
            one.status === 'succeeded' && one.verified_by === 'read-back',
        ),
      operations.map((one) => [
        one.operation_number,
        one.status,
        one.verified_by,
      ]),
    );
    rec.check(
      'The PATCH count equals the device count',
      (await faults.patchCount()) === 2,
      await faults.patchCount(),
    );
    rec.check('The job ends completed', job.status === 'completed', job.status);
  });

  // ---------------------------------------------------------------------------
  // Scope item 8: a stale attempt after takeover (P2 item 13).
  // ---------------------------------------------------------------------------
  await runAttack('S8', 'A stale attempt after takeover', async (rec) => {
    const devices = takeDevices(2);
    await faults.addCounter();
    const hang = await faults.addFault({
      kind: 'hang',
      method: PATCH_METHOD,
      ms: 8000,
      count: 1,
    });
    const seeded = await seedJob({
      devices,
      value: 'Stale attempt',
      batchSize: 2,
    });
    await waitUntil(
      'The batch was not claimed',
      async () =>
        (await db.appointment(seeded.jobId))?.first_claimed_at ?? null,
      { timeout: 120_000, interval: 200 },
    );
    await faults.waitRemaining(hang.id, 0, 120_000);
    const pausedAttempt = (await db.batches(seeded.jobId))[0].attempt_id;
    docker('pause', workerName);
    rec.observe('pausedAttempt', pausedAttempt);
    await waitUntil(
      'The batch lease did not end',
      async () => {
        const row = await db.row(
          `SELECT lease_expires_at<=clock_timestamp() AS expired
             FROM cc.device_update_batches WHERE job_id=$1 AND batch=0`,
          [seeded.jobId],
        );
        return row?.expired === true;
      },
      { timeout: 240_000, interval: 1000 },
    );
    await db.query(
      `UPDATE cc.device_update_jobs SET heartbeat_at=clock_timestamp()-interval '11 minutes'
        WHERE job_id=$1`,
      [seeded.jobId],
    );
    const rotated = await waitUntil(
      'The reaper did not start a new execution',
      async () => {
        const state = await db.appointment(seeded.jobId);
        return state.dispatch_count >= 2 &&
          state.kestra_execution_id !== seeded.executionId
          ? state
          : null;
      },
      { timeout: 300_000, interval: 500 },
    );
    rec.observe('takeover', {
      dispatchCount: rotated.dispatch_count,
      executionId: rotated.kestra_execution_id,
    });
    const takeoverAttempt = waitUntil(
      'The new attempt did not claim the batch',
      async () => {
        const batch = (await db.batches(seeded.jobId))[0];
        // The paused attempt stays in the row until the new claim replaces it.
        return batch.attempt_id && batch.attempt_id !== pausedAttempt
          ? batch
          : null;
      },
      { timeout: 300_000, interval: 100 },
    );
    docker('unpause', workerName);
    const claimed = await takeoverAttempt;
    rec.observe('takeoverAttempt', claimed.attempt_id);
    const job = await jobTerminal(seeded.jobId, 900_000);
    const operations = await db.operations(seeded.jobId);
    rec.observe(
      'operations',
      operations.map((one) => ({
        number: one.operation_number,
        status: one.status,
        verifiedBy: one.verified_by,
        attempt: one.attempt_id,
        verifyAttempt: one.verify_attempt,
      })),
    );
    rec.check(
      'Both operations end succeeded with verified_by read-back',
      operations.length === 2 &&
        operations.every(
          (one) =>
            one.status === 'succeeded' && one.verified_by === 'read-back',
        ),
      operations.map((one) => [
        one.operation_number,
        one.status,
        one.verified_by,
      ]),
    );
    // 017-jobs.sql:1033 rewrites verify_attempt on every settle, so the end
    // state cannot show the read-back claim. The 2026-10-20 ruling replaced the
    // end-state criterion with the read-back outcome, one PATCH per device, and
    // the completed job. The claim stays an observation.
    rec.observe('pausedAttemptKept', {
      pausedAttempt,
      attempts: operations.map((one) => one.attempt_id),
      verifyAttempts: operations.map((one) => one.verify_attempt),
      criterionNote:
        'verify_attempt is the read-back claim (017-jobs.sql:1145) and every settle clears it unless the write outcome is unknown (017-jobs.sql:1033). The end state cannot show it; the 2026-10-20 ruling replaced the criterion.',
    });
    rec.check(
      'The PATCH count equals the device count',
      (await faults.patchCount()) === 2,
      await faults.patchCount(),
    );
    rec.observe('job', { status: job.status });
    rec.check('The job ends completed', job.status === 'completed', job.status);
  });

  // ---------------------------------------------------------------------------
  // Scope item 9: the kill of A1 (P2 item A1).
  // ---------------------------------------------------------------------------
  await runAttack('S9', 'The kill of A1', async (rec) => {
    const devices = takeDevices(4);
    // A replaced worker container gets a new address, and the JVM in Kestra
    // caches the old one. A Kestra restart makes the flow resolve the worker again.
    await restartWorker({ CC_DEVICE_UPDATE_BATCH_SIZE: '1' });
    docker('restart', kestraName);
    refreshKestraOrigin();
    await kestraApi.waitReady();
    try {
      await faults.addCounter();
      await faults.addFault({
        kind: 'status',
        method: PATCH_METHOD,
        status: 403,
        reason: 'forbidden',
        count: 1,
      });
      const hang = await faults.addFault({
        kind: 'hang',
        method: PATCH_METHOD,
        ms: 8000,
        count: 1,
      });
      const seeded = await seedJob({ devices, value: 'A1 kill', batchSize: 2 });
      let failedOperation;
      try {
        failedOperation = await waitUntil(
          'No operation failed with the forbidden answer',
          async () => {
            const operations = await db.operations(seeded.jobId);
            return operations.find((one) => one.status === 'failed') ?? null;
          },
          { timeout: 180_000, interval: 200 },
        );
      } catch (error) {
        const job = await db.job(seeded.jobId);
        rec.observe('jobAtTimeout', {
          status: job?.status,
          failure: job?.failure,
          dispatchCount: job?.dispatch_count,
          executionId: job?.kestra_execution_id,
        });
        rec.observe(
          'operationsAtTimeout',
          (await db.operations(seeded.jobId)).map((one) => [
            one.operation_number,
            one.status,
            one.outcome_reason,
            one.attempt_id,
          ]),
        );
        rec.observe('patchCountAtTimeout', await faults.patchCount());
        try {
          const execution = await kestraApi.execution(seeded.executionId);
          rec.observe('executionAtTimeout', {
            state: execution.state.current,
            tasks: kestraApi
              .taskOutputs(execution)
              .map((entry) => [entry.taskId, entry.state, entry.outputs]),
          });
        } catch (readError) {
          rec.observe('executionAtTimeout', readError.message);
        }
        throw error;
      }
      rec.observe('failedOperation', {
        number: failedOperation.operation_number,
        status: failedOperation.status,
        reason: failedOperation.outcome_reason,
        googleStatus: failedOperation.google_status,
        googleReason: failedOperation.google_reason,
      });
      await faults.waitRemaining(hang.id, 0, 120_000);
      await killContainer(workerName);
      docker('start', workerName);
      try {
        await workerHealthy(60_000);
      } catch (error) {
        containerDiagnosis(rec, workerName);
        throw error;
      }
      const job = await jobTerminal(seeded.jobId, 900_000);
      const latest = await db.job(seeded.jobId);
      const executionIds = [seeded.executionId];
      if (
        latest.kestra_execution_id &&
        latest.kestra_execution_id !== seeded.executionId
      )
        executionIds.push(latest.kestra_execution_id);
      for (const executionId of executionIds) {
        const execution = await kestraApi.waitExecution(executionId, 900_000);
        rec.observe(`execution.${executionId}`, {
          state: execution.state.current,
          outputs: kestraApi
            .taskOutputs(execution)
            .filter((entry) => entry.taskId === 'dispatch')
            .map((entry) => ({
              state: entry.state,
              body: kestraApi.responseBody(entry),
            })),
        });
      }
      rec.observe('job', {
        status: job.status,
        failure: job.failure,
        succeeded: job.succeeded,
        failed: job.failed,
        skipped: job.skipped,
        dispatchCount: latest.dispatch_count,
      });
      const operations = await db.operations(seeded.jobId);
      rec.observe(
        'operations',
        operations.map((one) => ({
          number: one.operation_number,
          batch: one.batch,
          status: one.status,
          reason: one.outcome_reason,
          verifiedBy: one.verified_by,
          verifyAttempt: one.verify_attempt,
        })),
      );
      rec.observe('patchCount', await faults.patchCount());
      const batchZero = operations.filter((one) => one.batch === 0);
      const flying = batchZero.find(
        (one) => one.operation_number !== failedOperation.operation_number,
      );
      rec.check(
        'The forbidden operation reads failed and the job failure reads permission-denied',
        failedOperation.status === 'failed' &&
          job.failure === 'permission-denied',
        { status: failedOperation.status, failure: job.failure },
      );
      rec.check(
        'The operations of batch 1 read skipped',
        operations
          .filter((one) => one.batch === 1)
          .every((one) => one.status === 'skipped'),
        operations.map((one) => [one.operation_number, one.batch, one.status]),
      );
      if (flying === undefined || flying.status !== 'dispatched') {
        // B5 ruling 6 and the 2026-10-20 ruling: the window never opened, so the
        // attack is Not verified with its observed states. The checks that do
        // hold stay in the record, and the result never fails the run.
        const notVerified =
          `A1: operation ${flying?.operation_number ?? 'absent'} read ${flying?.status ?? 'absent'} ` +
          `after the round 1 settlement, so the window never opened (dispatch count ` +
          `${latest.dispatch_count}, PATCH count ${await faults.patchCount()}).`;
        nothingToVerify.push(notVerified);
        rec.observe('notVerified', notVerified);
      }
    } finally {
      await restartWorker({});
      docker('restart', kestraName);
      refreshKestraOrigin();
      await kestraApi.waitReady();
    }
  });

  // ---------------------------------------------------------------------------
  // Scope item 10: a stop between a settle commit and its publication (P2 item 20).
  // ---------------------------------------------------------------------------
  const settleAndStop = (run) =>
    runAttack(`S10.${run}`, `Settle and stop, run ${run}`, async (rec) => {
      const [deviceId] = takeDevices(1);
      await faults.addCounter();
      const hang = await faults.addFault({
        kind: 'hang',
        method: PATCH_METHOD,
        ms: 3000,
        count: 1,
      });
      const generationKey = `cc:query-gen:device:${customer}`;
      const generationBefore = Number((await cache.get(generationKey)) ?? 0);
      const eventMark = events.length;
      const seeded = await seedJob({
        devices: [deviceId],
        value: `Settle stop ${run}`,
      });
      await faults.waitRemaining(hang.id, 0, 120_000);
      docker('pause', redisName);
      let publication;
      try {
        publication = await waitUntil(
          'The settlement row did not appear',
          async () => {
            const row = await db.row(
              `SELECT publication_id,revision,device_ids,created_at
                 FROM cc.job_publications
                WHERE job_id=$1 AND jsonb_array_length(device_ids)>0`,
              [seeded.jobId],
            );
            return row ?? null;
          },
          { timeout: 120_000, interval: 100 },
        );
        await killContainer(workerName);
      } finally {
        docker('unpause', redisName);
      }
      docker('start', workerName);
      rec.observe('publication', {
        revision: publication.revision,
        deviceIds: publication.device_ids,
        createdAt: publication.created_at,
      });
      const delivered = await waitUntil(
        'The relay did not publish the settlement within 15 s of the Redis return',
        async () => {
          const seen = events.slice(eventMark);
          const entity = seen.find(
            (one) =>
              one.channel === 'entity' &&
              one.event.type === 'entity-batch' &&
              (one.event.deviceIds ?? []).includes(deviceId),
          );
          const job = seen.find(
            (one) =>
              one.channel === 'job' &&
              one.event.type === 'job-changed' &&
              one.event.jobId === seeded.jobId &&
              Number(one.event.revision) >= Number(publication.revision),
          );
          return entity && job ? { entity, job } : null;
        },
        { timeout: 15_000, interval: 250 },
      );
      rec.check(
        'Within 15 s the subscriber receives entity-batch with the device',
        delivered.entity !== undefined,
        delivered.entity?.event,
      );
      rec.check(
        'Within 15 s the subscriber receives job-changed at or above the row revision',
        delivered.job !== undefined,
        { rowRevision: publication.revision, event: delivered.job?.event },
      );
      const generationAfter = Number((await cache.get(generationKey)) ?? 0);
      rec.check(
        'The query generation rises',
        generationAfter > generationBefore,
        { before: generationBefore, after: generationAfter },
      );
      const remaining = await db.row(
        'SELECT 1 AS present FROM cc.job_publications WHERE publication_id=$1',
        [publication.publication_id],
      );
      rec.check('The row is gone', remaining === undefined, remaining);
      const job = await jobTerminal(seeded.jobId, 900_000);
      rec.check(
        'The job reaches its terminal status',
        terminalJobStates.has(job.status),
        job.status,
      );
    });

  for (const run of [1, 2, 3]) await settleAndStop(run);

  // ---------------------------------------------------------------------------
  // Scope item 11: a Redis restart during a write job.
  // ---------------------------------------------------------------------------
  await runAttack('S11', 'A Redis restart during a write job', async (rec) => {
    const devices = takeDevices(3);
    await faults.addCounter();
    await faults.addFault({
      kind: 'status',
      method: PATCH_METHOD,
      status: 429,
      reason: 'rateLimitExceeded',
      count: 15,
    });
    const seeded = await seedJob({
      devices,
      value: 'Redis restart',
      batchSize: 3,
    });
    throttledJobs.push({ label: 'S11', jobId: seeded.jobId });
    await waitUntil(
      'The throttle did not take effect',
      async () => (await faults.patchCount()) >= 2,
      { timeout: 120_000, interval: 250 },
    );
    // A Redis restart can change the published port. The hook returns the
    // reconnected client, and the subscriber moves to the new port.
    cache = trackClient(await restartRedis());
    rec.observe('redisClientReplaced', true);
    await resubscribe(cache);
    await faults.clearFaults();
    const fresh = await sessions.signIn('administrator');
    Object.assign(admin, fresh);
    const job = await jobTerminal(seeded.jobId, 900_000);
    const operations = await db.operations(seeded.jobId);
    rec.observe('job', {
      status: job.status,
      succeeded: job.succeeded,
      failed: job.failed,
    });
    rec.observe(
      'operations',
      operations.map((one) => ({
        number: one.operation_number,
        status: one.status,
        value: one.observed_value,
      })),
    );
    rec.check(
      'The job ends completed with every operation succeeded',
      job.status === 'completed' &&
        operations.every((one) => one.status === 'succeeded'),
      { status: job.status, statuses: operations.map((one) => one.status) },
    );
    const serial = (await db.device(devices[0])).serial_number;
    const page = await queryPage(admin, {
      predicates: [
        { field: 'serialNumber', operator: 'equals', value: serial },
      ],
    });
    const rows = await byIds(admin, devices);
    rec.observe(
      'pageRows',
      page.rows.map((row) => ({
        id: row.deviceId,
        value: row.annotatedLocation,
      })),
    );
    rec.observe(
      'byIds',
      rows.map((row) => ({ id: row.deviceId, value: row.annotatedLocation })),
    );
    rec.check(
      'The grid page read returns the accepted values',
      page.rows.length === 1 &&
        page.rows[0].annotatedLocation === 'Redis restart',
      page.rows[0]?.annotatedLocation,
    );
    rec.check(
      'The by-ids read returns the accepted values',
      rows.length === 3 &&
        rows.every((row) => row.annotatedLocation === 'Redis restart'),
      rows.map((row) => row.annotatedLocation),
    );
    await delay(15_000);
    const leftover = await db.row(
      'SELECT count(*)::integer AS count FROM cc.job_publications WHERE job_id=$1',
      [seeded.jobId],
    );
    rec.check(
      'No publication row of the job remains 15 s after its end',
      Number(leftover.count) === 0,
      leftover,
    );
  });

  // ---------------------------------------------------------------------------
  // Scope item 12: a refresh interleaved with a write (design:1069, design:1106).
  // ---------------------------------------------------------------------------
  const refreshDuringWrite = (variant) =>
    runAttack(
      `S12.${variant}`,
      `Refresh during a write: ${variant}`,
      async (rec) => {
        const [deviceId] = takeDevices(1);
        const device = await db.device(deviceId);
        await faults.addCounter();
        const hang = await faults.addFault({
          kind: 'hang',
          method: PATCH_METHOD,
          ms: 8000,
          count: 1,
        });
        const value = `Refresh ${variant}`;
        const seeded = await seedJob({ devices: [deviceId], value });
        await faults.waitRemaining(hang.id, 0, 120_000);
        let refreshJobId;
        if (variant === 'id-list') {
          await makeStale(deviceId);
          const page = await queryPage(admin, {
            predicates: [
              {
                field: 'serialNumber',
                operator: 'equals',
                value: device.serial_number,
              },
            ],
          });
          refreshJobId = page.refreshJobId;
          rec.check(
            'The page read starts a refresh job',
            typeof refreshJobId === 'string',
            refreshJobId,
          );
        } else {
          const startedAt = new Date();
          await refreshAll(admin);
          const found = await waitUntil(
            'The Refresh all request started no refresh job',
            async () => {
              const row = await db.row(
                `SELECT job_id,display_id FROM cc.jobs
                WHERE customer_id=$1 AND kind='inventory-refresh'
                  AND scope_kind='all-devices' AND created_at >= $2
                ORDER BY created_at DESC LIMIT 1`,
                [customer, startedAt],
              );
              return row ?? null;
            },
            { timeout: 60_000, interval: 250 },
          );
          refreshJobId = found.job_id;
          rec.observe('refreshDisplayId', found.display_id);
        }
        const refresh =
          refreshJobId === null ? null : await refreshJob(refreshJobId);
        rec.check(
          'The refresh job ends completed',
          refresh?.status === 'completed',
          refresh,
        );
        const job = await jobTerminal(seeded.jobId, 900_000);
        rec.observe('writeJob', {
          status: job.status,
          succeeded: job.succeeded,
        });
        const row = await db.device(deviceId);
        const overlay = await db.overlay(deviceId);
        const rows = await byIds(admin, [deviceId]);
        rec.observe('device', {
          value: row.annotated_location,
          stamp: row.annotated_location_observed_at,
        });
        rec.observe('overlay', overlay);
        rec.check(
          'The device row holds the written value',
          row.annotated_location === value,
          row.annotated_location,
        );
        rec.check(
          'annotated_location_observed_at equals observed_at of the overlay row',
          overlay !== undefined &&
            new Date(row.annotated_location_observed_at).getTime() ===
              new Date(overlay.observed_at).getTime(),
          {
            stamp: row.annotated_location_observed_at,
            overlay: overlay?.observed_at,
          },
        );
        rec.check(
          'The overlay holds source write-response and the write job',
          overlay?.source === 'write-response' &&
            overlay?.job_id === seeded.jobId,
          overlay,
        );
        rec.check(
          'The by-ids read returns the written value',
          rows[0]?.annotatedLocation === value,
          rows[0]?.annotatedLocation,
        );
      },
    );

  const refreshSettled = (jobId) => refreshJob(jobId).catch(() => null);

  for (const variant of ['id-list', 'all']) await refreshDuringWrite(variant);

  // ---------------------------------------------------------------------------
  // Scope item 13: a read-back interleaved with newer observations (P2 items 16 and 17).
  // ---------------------------------------------------------------------------
  /** End one job R with one unknown operation whose write took effect. */
  const unknownJob = async (deviceId, value) => {
    await faults.addCounter();
    await faults.addFault({
      kind: 'status',
      method: GET_METHOD,
      status: 400,
      reason: 'invalid',
      count: 100,
    });
    const hang = await faults.addFault({
      kind: 'hang',
      method: PATCH_METHOD,
      ms: 12_000,
      count: 1,
    });
    const seeded = await seedJob({ devices: [deviceId], value });
    await faults.waitRemaining(hang.id, 0, 180_000);
    await faults.addFault({
      kind: 'status',
      method: PATCH_METHOD,
      status: 503,
      reason: 'backendError',
      count: 20,
    });
    const job = await jobTerminal(seeded.jobId, 900_000);
    return { ...seeded, job };
  };

  const readBackVariant = (variant) =>
    runAttack(
      `S13.${variant}`,
      `A read-back interleaved with newer observations: ${variant}`,
      async (rec) => {
        const [deviceId] = takeDevices(1);
        const device = await db.device(deviceId);
        const valueR = `Read back R ${variant}`;
        const seeded = await unknownJob(deviceId, valueR);
        rec.observe('jobR', {
          status: seeded.job.status,
          displayId: seeded.job.display_id,
          unknown: seeded.job.unknown,
        });
        const before = await db.operations(seeded.jobId);
        rec.observe(
          'operationBefore',
          before.map((one) => ({
            status: one.status,
            reason: one.outcome_reason,
          })),
        );
        let prepared;
        if (variant === 'n') {
          prepared = await preview(admin, [deviceId], {
            mode: 'replace',
            value: `Read back N ${variant}`,
          });
        }
        await faults.clearFaults();
        const hang = await faults.addFault({
          kind: 'hang',
          method: GET_METHOD,
          ms: variant === 'n' ? 9000 : 8000,
          count: 1,
        });
        const displayId = seeded.job.display_id;
        // The entity check below must cover the Reconcile publication, not only
        // the settlement commit. Mark the event log and the job revision before
        // the request.
        const eventMark = events.length;
        const revisionBeforeReconcile = Number(
          (await db.job(seeded.jobId)).revision,
        );
        const reconciled = await api.call(
          admin,
          `/api/jobs/${displayId}/operations/1/reconcile`,
          { method: 'POST', body: {} },
        );
        assert.equal(reconciled.status, 202, reconciled.text);
        await faults.waitRemaining(hang.id, 0, 60_000);
        let refresh = null;
        let refreshSettledAt = null;
        let stampAfterRefresh = null;
        let jobN = null;
        if (variant === 'refresh') {
          await makeStale(deviceId);
          const page = await queryPage(admin, {
            predicates: [
              {
                field: 'serialNumber',
                operator: 'equals',
                value: device.serial_number,
              },
            ],
          });
          rec.check(
            'The page read starts a refresh job',
            typeof page.refreshJobId === 'string',
            page.refreshJobId,
          );
          refresh =
            page.refreshJobId === null
              ? null
              : await refreshSettled(page.refreshJobId);
          refreshSettledAt = refresh === null ? null : Date.now();
          stampAfterRefresh =
            refresh === null
              ? null
              : (await db.device(deviceId)).annotated_location_observed_at;
          rec.observe('refreshJob', refresh);
          rec.check(
            'The refresh job ends completed',
            refresh?.status === 'completed',
            refresh?.status,
          );
        } else {
          const receipt = await confirm(
            admin,
            prepared.previewId,
            prepared.manifestDigest,
          );
          jobN = await jobTerminal(receipt.jobId, 600_000);
          rec.observe('jobN', {
            jobId: receipt.jobId,
            status: jobN.status,
            succeeded: jobN.succeeded,
            failed: jobN.failed,
          });
        }
        const settled = await waitUntil(
          'The reconciled operation did not settle',
          async () => {
            const operation = (await db.operations(seeded.jobId))[0];
            return operation.status === 'unknown' ? null : operation;
          },
          { timeout: 180_000, interval: 250 },
        );
        const settledAt = Date.now();
        const row = await db.device(deviceId);
        const overlay = await db.overlay(deviceId);
        const stampBefore = new Date(
          device.annotated_location_observed_at ?? 0,
        ).getTime();
        rec.observe('operationAfter', {
          status: settled.status,
          verifiedBy: settled.verified_by,
          observedValue: settled.observed_value,
          attempt: settled.attempt_id,
          verifyAttempt: settled.verify_attempt,
        });
        rec.observe('deviceAfter', {
          value: row.annotated_location,
          stamp: row.annotated_location_observed_at,
        });
        rec.observe('overlay', overlay);
        // The settlement commits before its publication. Wait for a job change
        // above the revision read before the Reconcile and for every publication
        // row of R to clear, so a late entity-batch cannot arrive after the
        // absence check. One quiet second covers the entity channel, which the
        // worker publishes before job-changed.
        const jobAfter = await db.job(seeded.jobId);
        const publicationWindow = await waitUntil(
          'The publication of job R did not complete',
          async () => {
            const pending = await db.publications(seeded.jobId);
            const changed = events
              .slice(eventMark)
              .find(
                (one) =>
                  one.channel === 'job' &&
                  one.event.type === 'job-changed' &&
                  one.event.jobId === seeded.jobId &&
                  Number(one.event.revision) > revisionBeforeReconcile,
              );
            return pending.length === 0 && changed !== undefined
              ? { changed }
              : null;
          },
          { timeout: 30_000, interval: 250 },
        );
        await delay(1000);
        rec.observe('publicationWindow', {
          revisionBeforeReconcile,
          revisionAfter: Number(jobAfter.revision),
          jobChangedRevision: publicationWindow.changed.event.revision,
          pendingRows: (await db.publications(seeded.jobId)).length,
          eventsAfterReconcile: events.length - eventMark,
        });
        const rEvents = events
          .slice(eventMark)
          .filter(
            (one) =>
              one.channel === 'entity' && one.event.jobId === seeded.jobId,
          );
        if (variant === 'refresh') {
          // A `read` observation stamps the column, a `list` observation does not
          // (worker/src/entity-sync.ts:222-227, 016-device-inventory.sql:421-424).
          // Read the stamp after the refresh records. R must not change it later.
          const stampFinal = row.annotated_location_observed_at;
          rec.observe('stampWindow', {
            stampBefore,
            stampAfterRefresh,
            stampFinal,
            refreshSettledAt:
              refreshSettledAt === null
                ? null
                : new Date(refreshSettledAt).toISOString(),
            settledAt: new Date(settledAt).toISOString(),
          });
          rec.check(
            'The stamped observation does not change when R settles',
            stampAfterRefresh !== null &&
              stampFinal !== null &&
              new Date(stampFinal).getTime() ===
                new Date(stampAfterRefresh).getTime(),
            { stampAfterRefresh, stampFinal, stampBefore },
          );
          rec.check('D holds no overlay row', overlay === undefined, overlay);
          rec.check(
            'The operation of R reads succeeded with verified_by read-back',
            settled.status === 'succeeded' &&
              settled.verified_by === 'read-back',
            { status: settled.status, verifiedBy: settled.verified_by },
          );
        } else {
          rec.check(
            'The row holds the value of N',
            row.annotated_location === `Read back N ${variant}`,
            row.annotated_location,
          );
          rec.check(
            'The overlay keeps source write-response and job N',
            overlay?.source === 'write-response' &&
              overlay?.job_id === jobN?.job_id,
            overlay,
          );
          rec.check(
            'The stamped observation is the one of N, not of R',
            row.annotated_location_observed_at !== null &&
              new Date(row.annotated_location_observed_at).getTime() ===
                new Date(overlay?.observed_at ?? 0).getTime(),
            {
              stamp: row.annotated_location_observed_at,
              overlayObservedAt: overlay?.observed_at,
              stampBefore,
            },
          );
          rec.check(
            'The operation of R reads failed with value-differs',
            settled.status === 'failed' &&
              settled.outcome_reason === 'value-differs',
            { status: settled.status, reason: settled.outcome_reason },
          );
        }
        rec.check(
          'No entity-batch of job R names D after the Reconcile',
          rEvents.every(
            (one) => !(one.event.deviceIds ?? []).includes(deviceId),
          ),
          rEvents.map((one) => one.event),
        );
      },
    );

  for (const variant of ['refresh', 'n']) await readBackVariant(variant);

  // ---------------------------------------------------------------------------
  // Scope item 14: the retained-failure sequence (design:502-514).
  // ---------------------------------------------------------------------------
  await runAttack('S14', 'The retained-failure sequence', async (rec) => {
    const [deviceId] = takeDevices(1);
    const device = await db.device(deviceId);
    /** Grant one review identity devices:read at platform scope through an invitation. */
    const inviteReader = async (identity, label) => {
      const already = await db.row(
        `SELECT 1 FROM cc.application_grants g
           JOIN cc.application_principals p ON p.id=g.principal_id
          WHERE p.subject=$1 AND g.action='devices:read'`,
        [identity],
      );
      if (already === undefined) {
        const created = await apiJson(
          admin,
          '/api/auth/invitations',
          {
            method: 'POST',
            body: {
              label,
              expectedSubject: identity,
              expiresInHours: 1,
              grants: [{ action: 'devices:read', scope: { kind: 'platform' } }],
            },
          },
          [201],
        );
        const token = new URL(created.url).hash.slice(1);
        const redeemed = await request(
          `${publicOrigin}/api/auth/invitations/redeem`,
          {
            ca,
            method: 'POST',
            body: { token },
            headers: { origin: publicOrigin },
          },
        );
        assert.ok([200, 201].includes(redeemed.status), redeemed.text);
        const login = cookieValue(redeemed.headers, '__Host-cc-login');
        const authorize = new URL(bodyOf(redeemed).url);
        authorize.searchParams.set('review_identity', identity);
        const granted = await request(authorize, { ca, cookie: login });
        assert.equal(granted.status, 303, granted.text);
        const finish = await request(
          new URL(granted.headers.location, publicOrigin),
          { ca, cookie: login },
        );
        assert.equal(finish.status, 303, finish.text);
        const invitations = await apiJson(admin, '/api/auth/invitations');
        const invitation = invitations.find((one) => one.id === created.id);
        assert.ok(invitation, 'The invitation is missing from the list.');
        await apiJson(
          admin,
          `/api/auth/invitations/${created.id}/confirm`,
          {
            method: 'POST',
            body: { version: invitation.version, subject: identity },
          },
          [200, 201],
        );
      }
      const session = await sessions.signIn(identity);
      const actions = (
        await db.query(
          `SELECT g.action FROM cc.application_grants g
            WHERE g.principal_id=$1 ORDER BY g.action`,
          [session.identityId],
        )
      ).rows.map((row) => row.action);
      rec.observe(`actions.${identity}`, actions);
      return session;
    };
    const readerA = await inviteReader('review-recipient', 'Review recipient');
    // The claim rate is one request per two seconds for one address.
    await delay(2500);
    const readerB = await inviteReader('review-observer', 'Review observer');
    rec.check(
      'A holds devices:read without jobs:read',
      (
        await db.query(
          `SELECT 1 FROM cc.application_grants WHERE principal_id=$1 AND action='jobs:read'`,
          [readerA.identityId],
        )
      ).rowCount === 0 &&
        (
          await db.query(
            `SELECT 1 FROM cc.application_grants WHERE principal_id=$1 AND action='devices:read'`,
            [readerA.identityId],
          )
        ).rowCount === 1,
      rec.observations['actions.review-recipient'],
    );
    rec.check(
      'B holds devices:read without jobs:read',
      (
        await db.query(
          `SELECT 1 FROM cc.application_grants WHERE principal_id=$1 AND action='jobs:read'`,
          [readerB.identityId],
        )
      ).rowCount === 0 &&
        (
          await db.query(
            `SELECT 1 FROM cc.application_grants WHERE principal_id=$1 AND action='devices:read'`,
            [readerB.identityId],
          )
        ).rowCount === 1,
      rec.observations['actions.review-observer'],
    );
    // The Devices stream visibility check is a Q1a item. Here the streams supply
    // the frames that item 14 names: three open streams and A's full-sync
    // projection of each step.
    const streams = {
      A: trackStream(openStream(readerA)),
      B: trackStream(openStream(readerB)),
      C: trackStream(openStream(admin)),
    };
    const streamGate = await waitUntil(
      'The Devices streams did not answer',
      async () =>
        [streams.A, streams.B, streams.C].every(
          (stream) => stream.status !== undefined || stream.error !== undefined,
        ),
      { timeout: 15_000, interval: 100 },
    ).then(
      () => null,
      (error) => error.message,
    );
    const streamStatus = {
      A: streams.A.status,
      B: streams.B.status,
      C: streams.C.status,
      errors: { A: streams.A.error, B: streams.B.error, C: streams.C.error },
      gate: streamGate,
    };
    rec.observe('streamStatus', streamStatus);
    // R4: a refused or unanswered stream, or a stream that is not 200, fails the
    // attack. The full-sync evidence below needs three open streams.
    rec.check(
      'The three Devices streams answer 200 with no error',
      streamGate === null &&
        [streams.A, streams.B, streams.C].every(
          (stream) => stream.status === 200 && stream.error === undefined,
        ),
      streamStatus,
    );
    const batteryOf = async (session) => {
      const page = await queryPage(session, {
        predicates: [
          {
            field: 'serialNumber',
            operator: 'equals',
            value: device.serial_number,
          },
        ],
      });
      return page.rows[0]?.battery?.status ?? null;
    };
    const refreshFor = async (session, since) =>
      waitUntil(
        'The refresh job did not start',
        async () => {
          const row = await db.row(
            `SELECT job_id,display_id,status FROM cc.jobs
              WHERE customer_id=$1 AND kind='inventory-refresh'
                AND requested_by=$2 AND created_at>=$3
              ORDER BY created_at DESC LIMIT 1`,
            [customer, session.identityId, since],
          );
          return row ?? null;
        },
        { timeout: 60_000, interval: 250 },
      );
    // Step 1: B runs Refresh all with a telemetry 403.
    const frameMarkStep1 = streams.A.frames.length;
    await faults.addCounter();
    await faults.addFault({
      kind: 'status',
      method: 'chrome.telemetry.devices.list',
      status: 403,
      reason: 'forbidden',
      count: 1,
    });
    const sinceB = new Date();
    const answerB = await refreshAll(readerB);
    const jobB = await refreshFor(readerB, sinceB);
    await refreshJob(jobB.job_id);
    const fullSyncStep1 = await waitUntil(
      'The step 1 full-sync did not reach the A stream',
      async () =>
        streams.A.frames
          .slice(frameMarkStep1)
          .find((frame) => frame.type === 'full-sync') ?? null,
      { timeout: 30_000, interval: 100 },
    );
    const state = await db.syncState();
    rec.observe('syncState', {
      failure: state.failure,
      telemetryFailure: state.telemetry_failure,
      failureRequestedBy: state.failure_requested_by,
      telemetryFailureRequestedBy: state.telemetry_failure_requested_by,
    });
    rec.check(
      'cc.device_sync_state holds telemetry_failure permission-denied with B as requester',
      state.telemetry_failure === 'permission-denied' &&
        state.telemetry_failure_requested_by === readerB.identityId,
      state,
    );
    const syncA1 = await syncState(readerA);
    const syncB1 = await syncState(readerB);
    const syncC1 = await syncState(admin);
    rec.observe('syncAfterStep1', {
      A: syncA1.telemetryFailure,
      B: syncB1.telemetryFailure,
      C: syncC1.telemetryFailure,
    });
    rec.check(
      'A reads telemetryFailure null, B and C read permission-denied',
      syncA1.telemetryFailure === null &&
        syncB1.telemetryFailure === 'permission-denied' &&
        syncC1.telemetryFailure === 'permission-denied',
      {
        A: syncA1.telemetryFailure,
        B: syncB1.telemetryFailure,
        C: syncC1.telemetryFailure,
      },
    );
    const batteries = {
      A: await batteryOf(readerA),
      B: await batteryOf(readerB),
      C: await batteryOf(admin),
    };
    rec.observe('batteryAfterStep1', batteries);
    rec.check(
      'The page rows of all three read battery unavailable',
      Object.values(batteries).every((value) => value === 'unavailable'),
      batteries,
    );

    // Step 2: a reset rule on the Directory list, then A starts Refresh all.
    const frameMarkStep2 = streams.A.frames.length;
    await faults.addFault({
      kind: 'reset',
      method: 'directory.chromeosdevices.list',
      count: 50,
    });
    const sinceA = new Date();
    const answerA = await refreshAll(readerA);
    const jobA = await refreshFor(readerA, sinceA);
    await refreshJob(jobA.job_id);
    const fullSyncStep2 = await waitUntil(
      'The step 2 full-sync did not reach the A stream',
      async () =>
        streams.A.frames
          .slice(frameMarkStep2)
          .find((frame) => frame.type === 'full-sync') ?? null,
      { timeout: 30_000, interval: 100 },
    );
    const syncA2 = await syncState(readerA);
    const syncB2 = await syncState(readerB);
    const syncC2 = await syncState(admin);
    rec.observe('syncAfterStep2', {
      A: { failure: syncA2.failure, telemetryFailure: syncA2.telemetryFailure },
      B: { failure: syncB2.failure, telemetryFailure: syncB2.telemetryFailure },
      C: { failure: syncC2.failure, telemetryFailure: syncC2.telemetryFailure },
    });
    rec.check(
      'A reads failure network-failure and telemetryFailure null',
      syncA2.failure === 'network-failure' && syncA2.telemetryFailure === null,
      { failure: syncA2.failure, telemetryFailure: syncA2.telemetryFailure },
    );
    rec.check(
      'B reads failure null and telemetryFailure permission-denied',
      syncB2.failure === null &&
        syncB2.telemetryFailure === 'permission-denied',
      { failure: syncB2.failure, telemetryFailure: syncB2.telemetryFailure },
    );
    rec.check(
      'C reads both failures',
      syncC2.failure === 'network-failure' &&
        syncC2.telemetryFailure === 'permission-denied',
      { failure: syncC2.failure, telemetryFailure: syncC2.telemetryFailure },
    );
    rec.check(
      'The POST answer of A never holds permission-denied',
      !JSON.stringify(answerA).includes('permission-denied'),
      answerA,
    );
    const fullSyncFrames = (stream) =>
      stream.frames
        .filter((frame) => frame.type === 'full-sync')
        .map((frame) => frame.data);
    const frames = {
      A: fullSyncFrames(streams.A),
      B: fullSyncFrames(streams.B),
      C: fullSyncFrames(streams.C),
    };
    rec.observe('fullSyncFrames', {
      step1: { frame: fullSyncStep1.data, at: fullSyncStep1.at },
      step2: { frame: fullSyncStep2.data, at: fullSyncStep2.at },
      A: frames.A,
      B: frames.B,
      C: frames.C,
    });
    rec.check(
      'The A stream holds a full-sync event for both steps',
      frames.A.length >= 2 &&
        fullSyncStep1.type === 'full-sync' &&
        fullSyncStep2.type === 'full-sync' &&
        !JSON.stringify(fullSyncStep1.data).includes('permission-denied') &&
        !JSON.stringify(fullSyncStep2.data).includes('permission-denied'),
      {
        step1: fullSyncStep1.data,
        step2: fullSyncStep2.data,
        frames: frames.A,
      },
    );
    rec.check(
      'The full-sync events of A never hold permission-denied',
      frames.A.length >= 2 &&
        frames.A.every(
          (data) => !JSON.stringify(data).includes('permission-denied'),
        ),
      frames.A,
    );
    for (const stream of Object.values(streams)) stream.close();
    rec.observe('step1Answer', { status: answerB.status });
  });

  // ---------------------------------------------------------------------------
  // Scope item 15: the policy scenarios (after ruling 9).
  // ---------------------------------------------------------------------------
  const holdKey = `cc:job-hold:${customer}:device-update`;
  const holdOf = async () => cache.get(holdKey);
  const holdTtl = async () => cache.ttl(holdKey);

  // Run 1: lines 77, 82, 83, and 90.
  await runAttack(
    'S15.1',
    'Policy run 1: lines 77, 82, 83, and 90',
    async (rec) => {
      const devicesE = takeDevices(2);
      const devicesF = takeDevices(3);
      const devicesG = takeDevices(1);
      await faults.addCounter();
      await faults.addFault({
        kind: 'status',
        method: PATCH_METHOD,
        status: 429,
        reason: 'rateLimitExceeded',
        count: 40,
      });
      const E = await seedJob({ devices: devicesE, value: 'Hold E' });
      throttledJobs.push({ label: 'E', jobId: E.jobId });
      const hold = await waitUntil(
        'The hold of E did not appear',
        async () => {
          const value = await holdOf();
          return value === E.jobId ? value : null;
        },
        { timeout: 240_000, interval: 500 },
      );
      const ttl = await holdTtl();
      rec.observe('hold', { value: hold, ttl });
      rec.check('The hold holds the ID of E', hold === E.jobId, hold);
      rec.check(
        'The hold has a TTL of at most 300 s',
        ttl > 0 && ttl <= 300,
        ttl,
      );
      const countAtHold = await faults.patchCount();
      await delay(5000);
      const countLater = await faults.patchCount();
      rec.observe('patchCounts', { atHold: countAtHold, later: countLater });
      rec.check(
        'The PATCH count of E keeps rising while the hold exists',
        countLater > countAtHold,
        { atHold: countAtHold, later: countLater },
      );
      const previewF = await preview(admin, devicesF, {
        mode: 'replace',
        value: 'Hold F',
      });
      const receiptF = await confirm(
        admin,
        previewF.previewId,
        previewF.manifestDigest,
      );
      const previewG = await preview(admin, devicesG, {
        mode: 'replace',
        value: 'Hold G',
      });
      const receiptG = await confirm(
        admin,
        previewG.previewId,
        previewG.manifestDigest,
      );
      const heldPair = await waitUntil(
        'F and G were not labelled held',
        async () => {
          const f = await db.job(receiptF.jobId);
          const g = await db.job(receiptG.jobId);
          return f?.status === 'held' && g?.status === 'held' ? { f, g } : null;
        },
        { timeout: 60_000, interval: 500 },
      );
      const statusF = heldPair.f.status;
      const statusG = heldPair.g.status;
      rec.observe('heldJobs', { F: statusF, G: statusG });
      rec.check(
        'F and G read held during the hold',
        statusF === 'held' && statusG === 'held',
        { F: statusF, G: statusG },
      );
      const refreshSince = new Date();
      await refreshAll(admin);
      const refreshJobRow = await waitUntil(
        'The Refresh all job did not appear',
        async () => {
          const row = await db.row(
            `SELECT job_id,display_id FROM cc.jobs
            WHERE customer_id=$1 AND kind='inventory-refresh' AND scope_kind='all-devices'
              AND created_at>=$2 ORDER BY created_at DESC LIMIT 1`,
            [customer, refreshSince],
          );
          return row ?? null;
        },
        { timeout: 60_000, interval: 250 },
      );
      const refreshOne = await refreshJob(refreshJobRow.job_id);
      rec.observe('refreshAll', {
        status: refreshOne.status,
        hold: await holdOf(),
      });
      rec.check(
        'The Refresh all job ends completed while the hold exists',
        refreshOne.status === 'completed' && (await holdOf()) === E.jobId,
        { status: refreshOne.status, hold: await holdOf() },
      );
      await makeStale(devicesF[0]);
      const serialF = (await db.device(devicesF[0])).serial_number;
      const page = await queryPage(admin, {
        predicates: [
          { field: 'serialNumber', operator: 'equals', value: serialF },
        ],
      });
      rec.check(
        'The page read starts an ID-list refresh',
        typeof page.refreshJobId === 'string',
        page.refreshJobId,
      );
      const refreshTwo =
        page.refreshJobId === null
          ? null
          : await refreshSettled(page.refreshJobId);
      rec.observe('refreshIdList', {
        status: refreshTwo?.status,
        hold: await holdOf(),
      });
      rec.check(
        'The ID-list refresh ends completed while the hold exists',
        refreshTwo?.status === 'completed' && (await holdOf()) === E.jobId,
        { status: refreshTwo?.status, hold: await holdOf() },
      );
      await faults.clearFaults();
      const jobE = await jobTerminal(E.jobId, 900_000);
      rec.observe('jobE', { status: jobE.status, succeeded: jobE.succeeded });
      rec.check(
        'E ends completed (line 77)',
        jobE.status === 'completed',
        jobE.status,
      );
      const admitted = await waitUntil(
        'F and G were not admitted after the cleanup of E',
        async () => {
          const f = await db.job(receiptF.jobId);
          const g = await db.job(receiptG.jobId);
          return f?.admitted_at && g?.admitted_at ? { f, g } : null;
        },
        { timeout: 300_000, interval: 500 },
      );
      rec.observe('admittedAt', {
        F: admitted.f.admitted_at,
        G: admitted.g.admitted_at,
      });
      rec.check(
        'admitted_at of G precedes admitted_at of F',
        new Date(admitted.g.admitted_at).getTime() <
          new Date(admitted.f.admitted_at).getTime(),
        { F: admitted.f.admitted_at, G: admitted.g.admitted_at },
      );
    },
  );

  // Run 2: lines 81 and 86.
  await runAttack('S15.2', 'Policy run 2: lines 81 and 86', async (rec) => {
    // Run 1 leaves the worker connection in its quota backoff. A fresh worker
    // starts this run from the state the card describes. A replaced container
    // changes the address that the Kestra JVM caches, so Kestra restarts too.
    await restartWorker({});
    docker('restart', kestraName);
    refreshKestraOrigin();
    await kestraApi.waitReady();
    const devicesH = takeDevices(2);
    const devicesJ = takeDevices(3);
    await faults.addCounter();
    await faults.addFault({
      kind: 'status',
      method: PATCH_METHOD,
      status: 429,
      reason: 'rateLimitExceeded',
      count: 24,
    });
    const H = await seedJob({
      devices: devicesH,
      value: 'Hold H',
      batchSize: 1,
    });
    throttledJobs.push({ label: 'H', jobId: H.jobId });
    await waitUntil(
      'The hold of H did not appear',
      async () => (await holdOf()) === H.jobId,
      { timeout: 240_000, interval: 500 },
    );
    const previewJ = await preview(admin, devicesJ, {
      mode: 'replace',
      value: 'Hold J',
    });
    const receiptJ = await confirm(
      admin,
      previewJ.previewId,
      previewJ.manifestDigest,
    );
    await faults.clearFaults();
    const settledFirst = await waitUntil(
      'Batch 0 of H did not settle',
      async () => {
        const batch = (await db.batches(H.jobId))[0];
        return batch?.settled_at ?? null;
      },
      { timeout: 300_000, interval: 100 },
    );
    rec.observe('batch0SettledAt', settledFirst);
    // KEEPTTL on a missing key would create a key with no expiry. The
    // harness then owns a 300 s lifetime for J.
    const ttlBefore = await holdTtl();
    await cache.set(
      holdKey,
      receiptJ.jobId,
      ttlBefore > 0 ? { KEEPTTL: true } : { EX: 300 },
    );
    rec.observe('holdTtlBeforeJ', ttlBefore);
    rec.check(
      'The hold now holds the ID of J',
      (await holdOf()) === receiptJ.jobId,
      await holdOf(),
    );
    const jobH = await jobTerminal(H.jobId, 900_000);
    const stateH = await db.job(H.jobId);
    rec.observe('jobH', {
      status: jobH.status,
      holdWrittenAt: stateH.hold_written_at,
      holdCleanedAt: stateH.hold_cleaned_at,
      hold: await holdOf(),
    });
    rec.check(
      'After H ends the hold still holds the ID of J',
      (await holdOf()) === receiptJ.jobId,
      await holdOf(),
    );
    rec.check(
      'H holds hold_cleaned_at (line 81)',
      stateH.hold_cleaned_at !== null,
      stateH.hold_cleaned_at,
    );
    const statusJ = await waitUntil(
      'J was not labelled held',
      async () => {
        const job = await db.job(receiptJ.jobId);
        return job?.status === 'held' ? job.status : null;
      },
      { timeout: 60_000, interval: 500 },
    );
    rec.observe('jobJStatus', statusJ);
    rec.check(
      'J reads held while the hold exists',
      statusJ === 'held',
      statusJ,
    );
    // R5: the durable admission state for the whole hold, up to the expiry
    // boundary. The job row is read before the key, so a key that still exists
    // proves the hold was live at the job read. A status other than held, or a
    // set admitted_at, at that point is an early admission.
    const holdSamples = {
      count: 0,
      statuses: new Set(),
      firstHeldAt: null,
      lastHeldAt: null,
      earlyAdmission: null,
    };
    const expired = await waitUntil(
      'The hold key did not expire',
      async () => {
        const job = await db.job(receiptJ.jobId);
        const exists = await cache.exists(holdKey);
        holdSamples.count += 1;
        if (exists !== 1) return Date.now();
        const at = new Date().toISOString();
        holdSamples.statuses.add(job?.status ?? 'absent');
        if (holdSamples.firstHeldAt === null) holdSamples.firstHeldAt = at;
        holdSamples.lastHeldAt = at;
        if (
          holdSamples.earlyAdmission === null &&
          (job?.status !== 'held' || job?.admitted_at !== null)
        )
          holdSamples.earlyAdmission = {
            at,
            status: job?.status ?? 'absent',
            admittedAt: job?.admitted_at ?? null,
          };
        return null;
      },
      { timeout: 330_000, interval: 1000 },
    );
    const heldSeconds = Math.round(
      (expired - new Date(stateH.hold_written_at).getTime()) / 1000,
    );
    rec.observe('holdAdmissionSamples', {
      count: holdSamples.count,
      statuses: [...holdSamples.statuses],
      firstHeldAt: holdSamples.firstHeldAt,
      lastHeldAt: holdSamples.lastHeldAt,
      earlyAdmission: holdSamples.earlyAdmission,
    });
    rec.check(
      'J stays held and unadmitted for the whole hold',
      holdSamples.count >= 2 && holdSamples.earlyAdmission === null,
      {
        count: holdSamples.count,
        statuses: [...holdSamples.statuses],
        earlyAdmission: holdSamples.earlyAdmission,
      },
    );
    rec.observe('holdExpiry', {
      expiresAt: new Date(expired).toISOString(),
      secondsAfterHoldWrittenAt: heldSeconds,
    });
    rec.check(
      'The key expires at most 300 s after hold_written_at of H (line 86)',
      // The expiry sampler polls once a second. The true expiry is at most 300 s.
      heldSeconds <= 301,
      heldSeconds,
    );
    const jobJ = await jobTerminal(receiptJ.jobId, 600_000);
    rec.observe('jobJ', { status: jobJ.status, succeeded: jobJ.succeeded });
    rec.check(
      'J then runs to completion',
      jobJ.status === 'completed',
      jobJ.status,
    );
  });

  // Run 3: line 87.
  await runAttack('S15.3', 'Policy run 3: line 87', async (rec) => {
    // Run 2 leaves the worker in its quota backoff. Start this run fresh.
    await restartWorker({});
    docker('restart', kestraName);
    refreshKestraOrigin();
    await kestraApi.waitReady();
    const devicesK = takeDevices(2);
    const devicesL = takeDevices(2);
    await faults.addCounter();
    await faults.addFault({
      kind: 'status',
      method: PATCH_METHOD,
      status: 429,
      reason: 'rateLimitExceeded',
      count: 24,
    });
    const K = await seedJob({
      devices: devicesK,
      value: 'Hold K',
      batchSize: 2,
    });
    throttledJobs.push({ label: 'K', jobId: K.jobId });
    await waitUntil(
      'The hold of K did not appear',
      async () => (await holdOf()) === K.jobId,
      { timeout: 240_000, interval: 500 },
    );
    const previewL = await preview(admin, devicesL, {
      mode: 'replace',
      value: 'Hold L',
    });
    const receiptL = await confirm(
      admin,
      previewL.previewId,
      previewL.manifestDigest,
    );
    const wroteAtKill = await db.job(K.jobId);
    const killedAt = Date.now();
    await killContainer(workerName);
    await faults.clearFaults();
    rec.observe('holdAtKill', {
      writtenAt: wroteAtKill.hold_written_at,
      ttl: await holdTtl(),
      value: await holdOf(),
    });
    await delay(60_000);
    const afterKill = await db.job(K.jobId);
    rec.check(
      'hold_written_at of K stops at its last value after the kill',
      new Date(afterKill.hold_written_at).getTime() ===
        new Date(wroteAtKill.hold_written_at).getTime(),
      { before: wroteAtKill.hold_written_at, after: afterKill.hold_written_at },
    );
    const expired = await waitUntil(
      'The hold key did not expire',
      async () => ((await cache.exists(holdKey)) === 0 ? Date.now() : null),
      { timeout: 300_000, interval: 1000 },
    );
    const heldSeconds = Math.round(
      (expired - new Date(wroteAtKill.hold_written_at).getTime()) / 1000,
    );
    rec.observe('holdExpiry', { secondsAfterHoldWrittenAt: heldSeconds });
    rec.check(
      'The key expires at most 300 s after hold_written_at of K',
      // The expiry sampler polls once a second. The true expiry is at most 300 s.
      heldSeconds <= 301,
      heldSeconds,
    );
    const statusL = await waitUntil(
      'L did not read queued after the hold expired',
      async () => {
        const job = await db.job(receiptL.jobId);
        return job?.status === 'queued' ? job.status : null;
      },
      { timeout: 120_000, interval: 500 },
    );
    const statusK = (await db.job(K.jobId)).status;
    rec.observe('afterExpiry', { K: statusK, L: statusL });
    rec.check(
      'L then reads queued while K reads running (line 87)',
      statusL === 'queued' && statusK === 'running',
      { K: statusK, L: statusL },
    );
    const waitUntilStart = killedAt + 6 * 60_000;
    const wait = waitUntilStart - Date.now();
    if (wait > 0) await delay(wait);
    docker('start', workerName);
    await workerHealthy(60_000);
    const jobK = await jobTerminal(K.jobId, 900_000);
    const operations = await db.operations(K.jobId);
    rec.observe('jobK', {
      status: jobK.status,
      succeeded: jobK.succeeded,
      failed: jobK.failed,
      skipped: jobK.skipped,
    });
    rec.observe(
      'operations',
      operations.map((one) => [one.operation_number, one.status]),
    );
    rec.check(
      'After the worker starts, K ends with every operation settled',
      operations.every(
        (one) => one.status !== 'pending' && one.status !== 'dispatched',
      ),
      operations.map((one) => [one.operation_number, one.status]),
    );
  });

  // ---------------------------------------------------------------------------
  // Scope item 16: observations. These pass or fail nothing.
  // ---------------------------------------------------------------------------
  await runAttack(
    'S16',
    'Observations: retry sums and 250-part latency',
    async (rec) => {
      rec.observe('observationOnly', true);
      const retries = [];
      for (const entry of throttledJobs) {
        const sums = await retrySums(entry.jobId);
        retries.push({ ...entry, ...sums });
      }
      rec.observe('retrySums', retries);
      const devices = takeDevices(250);
      const startedAt = Date.now();
      const seeded = await seedJob({
        devices,
        value: 'Latency batch',
        batchSize: 250,
      });
      const job = await jobTerminal(seeded.jobId, 900_000);
      const batch = (await db.batches(seeded.jobId))[0];
      const operations = await db.operations(seeded.jobId);
      rec.observe('latency', {
        mockTier: mock.tier,
        delays: mock.delays,
        deviceCount: devices.length,
        claimedAt: batch.claimed_at,
        settledAt: batch.settled_at,
        settledMinusClaimedMs:
          batch.settled_at === null
            ? null
            : new Date(batch.settled_at).getTime() -
              new Date(batch.claimed_at).getTime(),
        wallMs: Date.now() - startedAt,
        outcomeCounts: {
          succeeded: operations.filter((one) => one.status === 'succeeded')
            .length,
          failed: operations.filter((one) => one.status === 'failed').length,
          unknown: operations.filter((one) => one.status === 'unknown').length,
          skipped: operations.filter((one) => one.status === 'skipped').length,
        },
        jobStatus: job.status,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Scope item 17: value parity (design:1802).
  // ---------------------------------------------------------------------------
  await runAttack('S17', 'Value parity of three values', async (rec) => {
    const values = [
      { name: '200 code points', value: 'x'.repeat(200) },
      { name: 'non-ASCII letters', value: 'École François 日本' },
      { name: 'inner double spaces', value: 'Room  A 1' },
    ];
    for (const [index, entry] of values.entries()) {
      const [deviceId] = takeDevices(1);
      let prepared;
      try {
        prepared = await preview(admin, [deviceId], {
          mode: 'replace',
          value: entry.value,
        });
      } catch (error) {
        rec.observe(`preview.${entry.name}`, { refused: error.message });
        continue;
      }
      const receipt = await confirm(
        admin,
        prepared.previewId,
        prepared.manifestDigest,
      );
      await jobTerminal(receipt.jobId, 600_000);
      const operation = (await db.operations(receipt.jobId))[0];
      const rows = await byIds(admin, [deviceId]);
      rec.observe(`value.${entry.name}`, {
        requested: [...entry.value].length,
        observedValue: operation.observed_value,
        requestedValue: operation.requested_value,
        verifiedBy: operation.verified_by,
        status: operation.status,
        pageValue: rows[0]?.annotatedLocation,
      });
      rec.check(
        `The write of "${entry.name}" records the requested value with write-response`,
        operation.status === 'succeeded' &&
          operation.verified_by === 'write-response' &&
          operation.observed_value === entry.value &&
          operation.requested_value === entry.value,
        {
          status: operation.status,
          verifiedBy: operation.verified_by,
          observed: operation.observed_value,
        },
      );
      rec.check(
        `The by-ids read returns "${entry.name}"`,
        rows[0]?.annotatedLocation === entry.value,
        rows[0]?.annotatedLocation,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Scope item 18: the hand-off file.
  // ---------------------------------------------------------------------------
  const summary = {
    baseCommit: context.baseCommit ?? null,
    customer,
    mock: {
      version: mock.version,
      tier: mock.tier,
      delays: mock.delays,
      deviceCount: mock.deviceCount,
    },
    mockQuota: await mock.quota().catch(() => null),
    results,
    throttledRetries:
      results.find((one) => one.id === 'S16')?.observations.retrySums ?? [],
    latency:
      results.find((one) => one.id === 'S16')?.observations.latency ?? null,
    notVerified: [
      'Live Google write behavior: every write of this run reached admin-sdk-mock (design:1795).',
      'Scope item 13 held-answer orders: the mock reads the device after its hang, so the read-back observes the value at answer time. Orders design:1108-1110 do not occur on the mock.',
      'Line 89 (design:1302): the race cannot occur in this slice. Only a running job writes the hold (design:1258-1259), and admission admits only while no write job runs (design:1288-1291). B5 acceptance item 4 covers it.',
      ...nothingToVerify,
    ],
  };
  const directory = 'dist/q1b';
  await mkdir(directory, { recursive: true });
  await writeFile(
    `${directory}/attacks.json`,
    JSON.stringify(summary, null, 2),
  );
  process.stdout.write(`Q1B summary: ${directory}/attacks.json\n`);
  return summary;
}
