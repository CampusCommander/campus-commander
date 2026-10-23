import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

const terminalStates = new Set([
  'SUCCESS',
  'FAILED',
  'WARNING',
  'KILLED',
  'CANCELLED',
]);

/** The one channel that carries the write path's entity events. */
const entityChannel = (customer) => `cc:entity-events:${customer}`;

/** The reason every Deprovision job of this file sends. One job holds one reason (D11). */
const deprovisionReason = 'DEPROVISION_REASON_RETIRING_DEVICE';

/** Mint an access token for the mock's administrator through the control API. */
async function mockToken(mock, scope) {
  const response = await fetch(
    `${mock.controlUrl}/domains/${mock.customerId}/tokens`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: mock.adminEmail, scopes: [scope] }),
    },
  );
  assert.equal(
    response.status,
    200,
    `The mock token request answered ${response.status}.`,
  );
  return (await response.json()).access_token;
}

/** Read one Google path through the mock's published Google port. */
function mockGoogleGet({ mock, host, path, token }) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host,
        port: mock.googlePort,
        path,
        method: 'GET',
        ca: mock.ca,
        servername: host,
        lookup: (_name, _options, done) =>
          done(null, [{ address: '127.0.0.1', family: 4 }]),
        headers: {
          host,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        timeout: 20_000,
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, text }),
        );
      },
    );
    request.on('error', reject);
    request.on('timeout', () =>
      request.destroy(new Error('The mock Google request timed out.')),
    );
    request.end();
  });
}

/** The command IDs of the mock's first directory rows. */
const COMMAND_ID_BASE = 4_100_000_001;

/**
 * The commands that the mock holds for one device, read through the published Google port.
 * The mock lists no commands, so a bounded scan of the first IDs proves which ones exist.
 */
async function storedCommands({ mock, token, customer, deviceId, limit = 24 }) {
  const host = 'admin.googleapis.com';
  const commandPath = (id) =>
    `/admin/directory/v1/customer/${encodeURIComponent(customer)}/devices/chromeos/${encodeURIComponent(deviceId)}/commands/${id}`;
  const commands = [];
  for (let id = COMMAND_ID_BASE; id < COMMAND_ID_BASE + limit; id += 1) {
    const answer = await mockGoogleGet({
      mock,
      host,
      path: commandPath(id),
      token,
    });
    if (answer.status === 200) commands.push(JSON.parse(answer.text));
    else assert.equal(answer.status, 404, answer.text);
  }
  return commands;
}

/**
 * Design section 8.3, items 5, 9, 14, 15, and 24 on the mock stack.
 *
 * Each check seeds a write job through the migrator pattern of B2 and waits for the
 * job service to admit it and start the deployed device_update flow through the
 * Kestra API. The real worker writes to admin-sdk-mock.
 */
export async function qualifyDeviceWritesOnMock({
  migrator,
  mock,
  kestra,
  customer,
  call,
  headers,
  redis,
  writeScope,
  session,
}) {
  const results = [];
  const totalMs =
    Number(process.env.CC_MOCK_WRITE_TIMEOUT_SECONDS ?? 600) * 1000;
  // The flow is deployed by the job service at start (B5). This stack runs the
  // flow directly, so the check uploads the flow source first.
  const flowSource = await readFile(
    new URL('../deployment/kestra/device-update.yaml', import.meta.url),
    'utf8',
  );
  const uploaded = await fetch(`${kestra.origin}/api/v1/main/flows`, {
    method: 'POST',
    headers: {
      authorization: kestra.authorization,
      'content-type': 'application/x-yaml',
    },
    body: flowSource,
  });
  if (uploaded.status !== 200) {
    const updated = await fetch(
      `${kestra.origin}/api/v1/main/flows/campus.application/device_update`,
      {
        method: 'PUT',
        headers: {
          authorization: kestra.authorization,
          'content-type': 'application/x-yaml',
        },
        body: flowSource,
      },
    );
    assert.equal(updated.status, 200, await updated.text());
  }
  const control = async (path, options = {}) => {
    const response = await fetch(`${mock.controlUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    assert.ok(
      [200, 201, 204].includes(response.status),
      `The mock control API answered ${response.status} for ${path}.`,
    );
    return response.status === 204 ? null : response.json();
  };
  const addFault = (rule) =>
    control(`/domains/${mock.customerId}/faults`, {
      method: 'POST',
      body: rule,
    });
  const clearFaults = () =>
    control(`/domains/${mock.customerId}/faults`, { method: 'DELETE' });
  const faults = () => control(`/domains/${mock.customerId}/faults`);

  const principal = (
    await migrator.query(
      `SELECT p.id, p.permission_version FROM cc.application_principals p
        WHERE p.enabled AND EXISTS(
          SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p.id AND g.action='devices:bulk-actions')
        ORDER BY p.created_at ASC LIMIT 1`,
    )
  ).rows[0];
  assert.ok(
    principal,
    'The mock stack holds a principal with devices:bulk-actions.',
  );
  const connection = (
    await migrator.query(
      'SELECT customer_id, generation FROM cc.google_connection WHERE customer_id=$1 AND active',
      [customer],
    )
  ).rows[0];
  assert.ok(connection, 'The mock stack holds an active connection.');

  const deviceIds = (
    await migrator.query(
      'SELECT device_id FROM cc.devices WHERE customer_id=$1 AND removed_at IS NULL ORDER BY device_id LIMIT 2',
      [customer],
    )
  ).rows.map((row) => row.device_id);
  assert.equal(
    deviceIds.length,
    2,
    'The mock stack holds two devices to write.',
  );

  /**
   * The action of every job this file seeds. The first build's `command` flag names a Reboot job;
   * `action` names any other action of section 1.
   */
  const ACTIONS = {
    'annotated-location': {
      kind: 'device-update',
      prefix: 'UPD',
      sequence: 'cc.job_number_upd',
      requestedValue: null,
    },
    reboot: {
      kind: 'device-command',
      prefix: 'CMD',
      sequence: 'cc.job_number_cmd',
      requestedValue: null,
    },
    'wipe-users': {
      kind: 'device-command',
      prefix: 'CMD',
      sequence: 'cc.job_number_cmd',
      requestedValue: null,
    },
    powerwash: {
      kind: 'device-command',
      prefix: 'CMD',
      sequence: 'cc.job_number_cmd',
      requestedValue: null,
    },
    disable: {
      kind: 'device-status',
      prefix: 'STS',
      sequence: 'cc.job_number_sts',
      requestedValue: 'DISABLED',
    },
    reenable: {
      kind: 'device-status',
      prefix: 'STS',
      sequence: 'cc.job_number_sts',
      requestedValue: 'ACTIVE',
    },
    deprovision: {
      kind: 'device-status',
      prefix: 'STS',
      sequence: 'cc.job_number_sts',
      requestedValue: 'DEPROVISIONED',
    },
  };

  const seedJob = async ({
    devices,
    value,
    mode = 'replace',
    command = false,
    /** The job action of section 1. Its kind, prefix, sequence, and value follow the action. */
    action = command ? 'reboot' : 'annotated-location',
    /** The frozen Deprovision reason. A Deprovision job requires one (D11). */
    deprovisionReason = null,
    /** The field rows of every operation. The default is one `field` row from `value`. */
    fields = null,
    beforeStart,
  }) => {
    const plan = ACTIONS[action];
    assert.ok(plan, `A known job action: ${action}`);
    const update = action === 'annotated-location';
    const jobId = randomUUID();
    const previewId = randomUUID();
    // One transaction: the preview, the header, the detail, and the operations become visible together.
    // A tick that runs during the seed cannot admit a half-written job (R1-F2).
    await migrator.query('BEGIN');
    try {
      await migrator.query(
        `INSERT INTO cc.device_update_previews(preview_id,display_id,customer_id,created_by,permission_version,
          generation,action,action_version,deprovision_reason,selected,eligible,unchanged,excluded,field_changes,
          manifest_digest,expires_at)
      VALUES($1,cc.job_display_id('PV',nextval('cc.preview_number_pv')),$2,$3,$4,$5,$6,$7,$8,$9,$9,0,0,$10,
        'manifest-digest',clock_timestamp()+interval '1 hour')`,
        [
          previewId,
          customer,
          principal.id,
          principal.permission_version,
          connection.generation,
          action,
          // The first build's update action carries the second action version.
          update ? 2 : 1,
          deprovisionReason,
          devices.length,
          update ? devices.length * (fields?.length ?? 1) : 0,
        ],
      );
      // The frozen changes of the preview. Only an update carries them.
      // An edit preview holds no selection change row, and cc.device_update_changes keeps the four
      // selection fields until IB4 stores the edit rows. An Asset tag job seeds its field rows alone.
      if (update)
        for (const [field, fieldValue] of fields ?? [
          ['annotatedLocation', mode === 'clear' ? null : value],
        ])
          if (field !== 'annotatedAssetId')
            await migrator.query(
              'INSERT INTO cc.device_update_changes(preview_id,field,mode,value) VALUES($1,$2,$3,$4)',
              [
                previewId,
                field,
                fieldValue === null ? 'clear' : 'replace',
                fieldValue,
              ],
            );
      await migrator.query(
        `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
        target_count,correlation_id,created_at)
      VALUES($1,cc.job_display_id('${plan.prefix}',nextval('${plan.sequence}')),$2,'${plan.kind}','devices','accepted',$3,$4,
        $5,$6,clock_timestamp())`,
        [
          jobId,
          customer,
          principal.id,
          connection.generation,
          devices.length,
          randomUUID(),
        ],
      );
      await migrator.query(
        `INSERT INTO cc.device_update_jobs(job_id,preview_id,action,confirmed_by,confirmer_permission_version,
          delegated_subject,batch_size,batch_count)
      VALUES($1,$2,$3,$4,$5,$6,$7,1)`,
        [
          jobId,
          previewId,
          action,
          principal.id,
          principal.permission_version,
          mock.adminEmail,
          devices.length,
        ],
      );
      for (const [index, deviceId] of devices.entries()) {
        // An update keeps its values in the operation's field rows, so the value columns stay null.
        // A status change carries its requested status, as confirm writes it (section 5).
        await migrator.query(
          `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,serial_number,org_unit_path,
          baseline_value,requested_value,batch,status)
        VALUES($1,$2,$3,$4,'/School A',NULL,$5,0,'pending')`,
          [jobId, index + 1, deviceId, `SN-${deviceId}`, plan.requestedValue],
        );
        // An update operation carries its values in one row per field (addendum section 2).
        if (update)
          for (const [field, fieldValue] of fields ?? [
            ['annotatedLocation', mode === 'clear' ? null : value],
          ])
            await migrator.query(
              `INSERT INTO cc.device_update_operation_fields(job_id,operation_number,field,
            baseline_value,requested_value)
          VALUES($1,$2,$3,NULL,$4)`,
              [jobId, index + 1, field, fieldValue],
            );
      }
      // The fault exists before the job becomes visible, so the started worker always meets it.
      if (beforeStart) await beforeStart();
      await migrator.query('COMMIT');
    } catch (error) {
      await migrator.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    // The job service tick admits the accepted job and starts its flow (B5). Wait for that one
    // admission and one start, then read the execution the API recorded.
    const deadline = Date.now() + totalMs;
    let executionId;
    for (;;) {
      const state = (
        await migrator.query(
          `SELECT j.status,j.failure,d.kestra_execution_id
            FROM cc.jobs j JOIN cc.device_update_jobs d ON d.job_id=j.job_id WHERE j.job_id=$1`,
          [jobId],
        )
      ).rows[0];
      if (state.kestra_execution_id) {
        executionId = state.kestra_execution_id;
        break;
      }
      assert.notEqual(
        state.status,
        'failed',
        `The job service failed the seeded job: ${state.failure}`,
      );
      assert.ok(
        Date.now() < deadline,
        'The job service admitted and started the seeded job.',
      );
      await delay(250);
    }
    return { jobId, executionId };
  };

  const waitExecution = async (executionId) => {
    const deadline = Date.now() + totalMs;
    for (;;) {
      const response = await fetch(
        `${kestra.origin}/api/v1/main/executions/${executionId}`,
        {
          headers: { authorization: kestra.authorization },
          signal: AbortSignal.timeout(5000),
        },
      );
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const execution = JSON.parse(text);
      if (terminalStates.has(execution.state.current)) return execution;
      if (Date.now() > deadline)
        assert.fail(
          `Execution ${executionId} ended ${execution.state.current}. ${JSON.stringify(execution)}`,
        );
      await delay(500);
    }
  };

  const job = async (jobId) =>
    (
      await migrator.query(
        `SELECT j.status,j.failure,d.scope_observations,d.scope_failure
          FROM cc.jobs j JOIN cc.device_update_jobs d ON d.job_id=j.job_id WHERE j.job_id=$1`,
        [jobId],
      )
    ).rows[0];
  const operations = async (jobId) =>
    (
      await migrator.query(
        `SELECT o.operation_number,o.device_id,o.status,o.outcome_reason,o.verified_by,o.observed_value,
          o.google_status,o.command_id,o.command_state,f.observed_value AS field_observed_value
          FROM cc.device_update_operations o
          LEFT JOIN cc.device_update_operation_fields f
            ON f.job_id=o.job_id AND f.operation_number=o.operation_number AND f.field='annotatedLocation'
          WHERE o.job_id=$1 ORDER BY o.operation_number`,
        [jobId],
      )
    ).rows;
  // The field rows of a job, in contract order, with the value each settlement recorded.
  const fieldRows = async (jobId) =>
    (
      await migrator.query(
        `SELECT operation_number,field,requested_value,observed_value
          FROM cc.device_update_operation_fields WHERE job_id=$1
          ORDER BY operation_number,
            array_position(ARRAY['annotatedLocation','annotatedAssetId','annotatedUser','notes','orgUnitPath'],field)`,
        [jobId],
      )
    ).rows;
  // The review session idles out after 60 s (auth.test.mjs:560). A DB-only wait refreshes it.
  let sessionAt = 0;
  const keepSession = async () => {
    if (Date.now() - sessionAt < 20_000) return;
    await session();
    sessionAt = Date.now();
  };
  /** Wait for one job status. A failure the check does not expect ends the wait at once. */
  const waitJob = async (jobId, wanted, label) => {
    const deadline = Date.now() + totalMs;
    for (;;) {
      await keepSession();
      const state = await job(jobId);
      if (wanted.includes(state.status)) return state;
      if (state.status === 'failed' && !wanted.includes('failed'))
        assert.fail(`${label}: the job failed with ${state.failure}.`);
      assert.ok(
        Date.now() < deadline,
        `${label}: the job stayed ${state.status}.`,
      );
      await delay(500);
    }
  };
  /** Wait until every operation of the job holds the command ID of its issue answer. */
  const waitCommandIssued = async (jobId) => {
    const deadline = Date.now() + totalMs;
    for (;;) {
      await keepSession();
      const rows = await operations(jobId);
      if (rows.length > 0 && rows.every((row) => row.command_id !== null))
        return rows;
      assert.ok(Date.now() < deadline, 'The command issue settled.');
      await delay(250);
    }
  };
  const byIds = async (deviceIds) => {
    const response = await call('/api/devices/by-ids', {
      method: 'POST',
      headers: headers(),
      body: { deviceIds },
    });
    assert.equal(response.status, 200, response.text);
    return JSON.parse(response.text).rows;
  };
  const runSync = async () => {
    const started = await call('/api/devices/sync', {
      method: 'POST',
      headers: headers(),
      body: {},
    });
    assert.ok([200, 201].includes(started.status), started.text);
    const deadline = Date.now() + totalMs;
    for (;;) {
      const response = await call('/api/devices/sync');
      assert.equal(response.status, 200, response.text);
      const state = JSON.parse(response.text).sync;
      if (state.status !== 'running') {
        assert.equal(state.status, 'ready', JSON.stringify(state));
        return state;
      }
      if (Date.now() > deadline)
        assert.fail('The list did not settle before the timeout.');
      await delay(2000);
    }
  };

  await clearFaults();

  // B5 acceptance 2 and 3 (design section 8, lost issue answer): a 12 s hang loses the answer of a
  // command that Google stored. The rule sends no second POST, the operation settles unknown with
  // ambiguous, the job ends needs-review, and Reconcile answers 409.
  {
    let hang;
    const { jobId, executionId } = await seedJob({
      devices: [deviceIds[0]],
      command: true,
      beforeStart: async () => {
        const { scale } = await control('/clock');
        assert.ok(
          scale <= 50,
          `The hang test needs a scale of at most 50: ${scale}`,
        );
        hang = await addFault({
          kind: 'hang',
          method: 'directory.chromeos.issueCommand',
          ms: Math.ceil(12_000 * scale),
          count: 2,
        });
      },
    });
    try {
      const started = Date.now();
      const execution = await waitExecution(executionId);
      const elapsed = Date.now() - started;
      assert.equal(
        execution.state.current,
        'SUCCESS',
        JSON.stringify(execution),
      );
      assert.ok(
        elapsed >= 10_000,
        `The issue request met the 10 s timeout: ${elapsed} ms`,
      );
      const rule = (await faults()).find((one) => one.id === hang.id);
      assert.equal(
        rule.remaining,
        1,
        'The rule accepted exactly one issue POST.',
      );
      const state = await job(jobId);
      assert.equal(state.status, 'needs-review', JSON.stringify(state));
      const [operation] = await operations(jobId);
      assert.deepEqual(
        [operation.status, operation.outcome_reason, operation.command_id],
        ['unknown', 'ambiguous', null],
      );
      const displayId = (
        await migrator.query('SELECT display_id FROM cc.jobs WHERE job_id=$1', [
          jobId,
        ])
      ).rows[0].display_id;
      const reconciled = await call(
        `/api/jobs/${displayId}/operations/1/reconcile`,
        { method: 'POST', headers: headers(), body: {} },
      );
      assert.equal(reconciled.status, 409, reconciled.text);
      assert.equal(
        JSON.parse(reconciled.text).reason,
        'reconcile-unsupported',
        'A command operation has no Reconcile.',
      );
      // The mock stored the command that the worker could not read back.
      const token = await mockToken(mock, writeScope);
      const host = 'admin.googleapis.com';
      const commandPath = (id) =>
        `/admin/directory/v1/customer/${customer}/devices/chromeos/${encodeURIComponent(deviceIds[0])}/commands/${id}`;
      let stored;
      const deadline = Date.now() + 15_000;
      for (;;) {
        const answer = await mockGoogleGet({
          mock,
          host,
          path: commandPath('4100000001'),
          token,
        });
        if (answer.status === 200) {
          stored = JSON.parse(answer.text);
          break;
        }
        assert.ok(Date.now() < deadline, answer.text);
        await delay(250);
      }
      assert.equal(stored.commandId, '4100000001');
      assert.equal(stored.type, 'REBOOT');
      // No second command exists, so the rule accepted one POST.
      const second = await mockGoogleGet({
        mock,
        host,
        path: commandPath('4100000002'),
        token,
      });
      assert.equal(second.status, 404, second.text);
      results.push(
        'a 12 s hang on a Reboot issue sends one POST, stores one command the get reads, settles unknown ambiguous, ends needs-review, and refuses Reconcile with 409: pass',
      );
    } finally {
      await clearFaults();
    }
  }

  // B5 acceptance 4 (design section 8, transient refusal): a 503 with count 2 ends at remaining 1
  // and the operation settles unknown with ambiguous.
  {
    let refusal;
    const { jobId, executionId } = await seedJob({
      devices: [deviceIds[0]],
      command: true,
      beforeStart: async () => {
        refusal = await addFault({
          kind: 'status',
          method: 'directory.chromeos.issueCommand',
          status: 503,
          reason: 'backendError',
          count: 2,
        });
      },
    });
    try {
      const execution = await waitExecution(executionId);
      assert.equal(
        execution.state.current,
        'SUCCESS',
        JSON.stringify(execution),
      );
      const rule = (await faults()).find((one) => one.id === refusal.id);
      assert.equal(rule.remaining, 1, 'A refused issue POST is not repeated.');
      const state = await job(jobId);
      assert.equal(state.status, 'needs-review', JSON.stringify(state));
      const rows = await migrator.query(
        `SELECT status,outcome_reason,google_status,command_id
          FROM cc.device_update_operations WHERE job_id=$1`,
        [jobId],
      );
      assert.deepEqual(rows.rows, [
        {
          status: 'unknown',
          outcome_reason: 'ambiguous',
          google_status: 503,
          command_id: null,
        },
      ]);
      results.push(
        'a 503 refusal on a Reboot issue sends one POST, settles unknown ambiguous, and ends needs-review: pass',
      );
    } finally {
      await clearFaults();
    }
  }

  // B6 acceptance 1 (design section 4 steps 5 to 10): with the clock scaled, the online device
  // executes the Reboot, the poll settles it succeeded, and the job completes.
  {
    const online = (
      await migrator.query(
        `SELECT device_id FROM cc.devices
          WHERE customer_id=$1 AND removed_at IS NULL AND status='ACTIVE' AND last_contact IS NOT NULL
            AND last_contact > now() - interval '6 hours'
          ORDER BY device_id LIMIT 1`,
        [customer],
      )
    ).rows[0];
    assert.ok(online, 'The mock stack holds an online ACTIVE device.');
    const clock = await control('/clock');
    try {
      await control('/clock', { method: 'PUT', body: { scale: 60 } });
      const { jobId } = await seedJob({
        devices: [online.device_id],
        command: true,
      });
      const issued = await waitCommandIssued(jobId);
      assert.equal(issued[0].command_state, 'pending-delivery');
      const state = await waitJob(
        jobId,
        ['completed'],
        'The online command job',
      );
      assert.equal(state.status, 'completed', JSON.stringify(state));
      const rows = await operations(jobId);
      assert.deepEqual(
        rows.map((row) => row.status),
        ['succeeded'],
        JSON.stringify(rows),
      );
      const evidence = (
        await migrator.query(
          `SELECT command_expires_at,command_executed_at,poll_count
            FROM cc.device_update_operations WHERE job_id=$1`,
          [jobId],
        )
      ).rows[0];
      assert.ok(
        evidence.command_expires_at,
        'The first poll stores the expiry Google returned.',
      );
      assert.ok(
        evidence.command_executed_at,
        'The success stores the execution time Google returned.',
      );
      results.push(
        'with scale 60 an online Reboot reaches succeeded and its command job completes: pass',
      );
    } finally {
      await control('/clock', {
        method: 'PUT',
        body: { scale: clock.scale, delays: clock.delays },
      });
    }
  }

  // B6 acceptance 2: with a short commandExpirySeconds, the offline device reaches expired and the
  // job ends failed (no success, no unknown).
  {
    const offline = (
      await migrator.query(
        `SELECT device_id FROM cc.devices
          WHERE customer_id=$1 AND removed_at IS NULL AND status='ACTIVE'
            AND (last_contact IS NULL OR last_contact <= now() - interval '30 hours')
          ORDER BY device_id LIMIT 1`,
        [customer],
      )
    ).rows[0];
    assert.ok(offline, 'The mock stack holds an offline ACTIVE device.');
    const clock = await control('/clock');
    const record = await control(`/domains/${mock.customerId}`);
    const expiry = record.settings.writes.commandExpirySeconds;
    try {
      await control('/clock', { method: 'PUT', body: { scale: 60 } });
      await control(`/domains/${mock.customerId}/settings`, {
        method: 'PUT',
        body: { writes: { commandExpirySeconds: 120 } },
      });
      const { jobId } = await seedJob({
        devices: [offline.device_id],
        command: true,
      });
      await waitCommandIssued(jobId);
      const state = await waitJob(
        jobId,
        ['failed', 'completed-with-errors'],
        'The offline command job',
      );
      const rows = await operations(jobId);
      assert.deepEqual(
        rows.map((row) => row.status),
        ['expired'],
        JSON.stringify(rows),
      );
      assert.equal(
        state.status,
        'failed',
        `A job with one expired command ends failed: ${JSON.stringify(state)}`,
      );
      results.push(
        'with commandExpirySeconds 120 an offline Reboot reaches expired and its command job ends failed: pass',
      );
    } finally {
      await control(`/domains/${mock.customerId}/settings`, {
        method: 'PUT',
        body: { writes: { commandExpirySeconds: expiry } },
      });
      await control('/clock', {
        method: 'PUT',
        body: { scale: clock.scale, delays: clock.delays },
      });
    }
  }

  // B5 acceptance 4 (design section 7, lost issue answer): a 12 s hang loses the answer of a
  // Powerwash that Google stored. The rule accepts one POST, the mock holds one REMOTE_POWERWASH
  // command, the operation settles unknown ambiguous, and the job ends needs-review.
  {
    const clock = await control('/clock');
    assert.ok(
      clock.scale <= 50,
      `The hang test needs a scale of at most 50: ${clock.scale}`,
    );
    let hang;
    try {
      const { jobId, executionId } = await seedJob({
        devices: [deviceIds[0]],
        action: 'powerwash',
        beforeStart: async () => {
          hang = await addFault({
            kind: 'hang',
            method: 'directory.chromeos.issueCommand',
            ms: Math.ceil(12_000 * clock.scale),
            count: 2,
          });
        },
      });
      const execution = await waitExecution(executionId);
      assert.equal(
        execution.state.current,
        'SUCCESS',
        JSON.stringify(execution),
      );
      const rule = (await faults()).find((one) => one.id === hang.id);
      assert.equal(
        rule.remaining,
        1,
        'The rule accepted exactly one Powerwash issue POST.',
      );
      const state = await job(jobId);
      assert.equal(state.status, 'needs-review', JSON.stringify(state));
      const [operation] = await operations(jobId);
      assert.deepEqual(
        [operation.status, operation.outcome_reason, operation.command_id],
        ['unknown', 'ambiguous', null],
      );
      // The mock stores the command after its delayed handler runs, which follows the lost answer.
      // Poll the command surface until the stored command appears, as the Reboot check does.
      const token = await mockToken(mock, writeScope);
      const deadline = Date.now() + 20_000;
      let stored = [];
      for (;;) {
        stored = await storedCommands({
          mock,
          token,
          customer,
          deviceId: deviceIds[0],
        });
        if (
          stored.some((command) => command.type === 'REMOTE_POWERWASH') ||
          Date.now() >= deadline
        )
          break;
        await delay(250);
      }
      const powerwashes = stored.filter(
        (command) => command.type === 'REMOTE_POWERWASH',
      );
      assert.equal(
        powerwashes.length,
        1,
        `The mock holds one REMOTE_POWERWASH command: ${JSON.stringify(stored)}`,
      );
      results.push(
        'a 12 s hang on a Powerwash issue sends one POST, stores one REMOTE_POWERWASH command, settles unknown ambiguous, and ends needs-review: pass',
      );
    } finally {
      await clearFaults();
    }
  }

  // B5 acceptance 6 (design section 7): at scale 60 an online Wipe user data issues, executes, polls
  // to succeeded, and completes its command job.
  {
    const online = (
      await migrator.query(
        `SELECT device_id FROM cc.devices
          WHERE customer_id=$1 AND removed_at IS NULL AND status='ACTIVE' AND last_contact IS NOT NULL
            AND last_contact > now() - interval '6 hours'
          ORDER BY device_id LIMIT 1`,
        [customer],
      )
    ).rows[0];
    assert.ok(online, 'The mock stack holds an online ACTIVE device.');
    const clock = await control('/clock');
    try {
      await control('/clock', { method: 'PUT', body: { scale: 60 } });
      const { jobId } = await seedJob({
        devices: [online.device_id],
        action: 'wipe-users',
      });
      const issued = await waitCommandIssued(jobId);
      assert.equal(issued[0].command_state, 'pending-delivery');
      // The mock holds the command type of the job action, and the command carries no payload (D6).
      const token = await mockToken(mock, writeScope);
      const command = await mockGoogleGet({
        mock,
        host: 'admin.googleapis.com',
        path: `/admin/directory/v1/customer/${encodeURIComponent(customer)}/devices/chromeos/${encodeURIComponent(online.device_id)}/commands/${issued[0].command_id}`,
        token,
      });
      assert.equal(command.status, 200, command.text);
      const storedCommand = JSON.parse(command.text);
      assert.equal(storedCommand.type, 'WIPE_USERS', command.text);
      assert.equal('payload' in storedCommand, false, command.text);
      const state = await waitJob(
        jobId,
        ['completed'],
        'The online Wipe user data job',
      );
      assert.equal(state.status, 'completed', JSON.stringify(state));
      const rows = await operations(jobId);
      assert.deepEqual(
        rows.map((row) => row.status),
        ['succeeded'],
        JSON.stringify(rows),
      );
      results.push(
        'at scale 60 an online Wipe user data reaches succeeded and its command job completes: pass',
      );
    } finally {
      await control('/clock', {
        method: 'PUT',
        body: { scale: clock.scale, delays: clock.delays },
      });
    }
  }

  // B5 acceptance 6 (design section 7): with a commandExpirySeconds of 120, an offline Powerwash
  // reaches expired and the job ends failed.
  {
    const offline = (
      await migrator.query(
        `SELECT device_id FROM cc.devices
          WHERE customer_id=$1 AND removed_at IS NULL AND status='ACTIVE'
            AND (last_contact IS NULL OR last_contact <= now() - interval '30 hours')
          ORDER BY device_id LIMIT 1`,
        [customer],
      )
    ).rows[0];
    assert.ok(offline, 'The mock stack holds an offline ACTIVE device.');
    const clock = await control('/clock');
    const record = await control(`/domains/${mock.customerId}`);
    const expiry = record.settings.writes.commandExpirySeconds;
    try {
      await control('/clock', { method: 'PUT', body: { scale: 60 } });
      await control(`/domains/${mock.customerId}/settings`, {
        method: 'PUT',
        body: { writes: { commandExpirySeconds: 120 } },
      });
      const { jobId } = await seedJob({
        devices: [offline.device_id],
        action: 'powerwash',
      });
      await waitCommandIssued(jobId);
      const state = await waitJob(
        jobId,
        ['failed', 'completed-with-errors'],
        'The offline Powerwash job',
      );
      const rows = await operations(jobId);
      assert.deepEqual(
        rows.map((row) => row.status),
        ['expired'],
        JSON.stringify(rows),
      );
      assert.equal(
        state.status,
        'failed',
        `A job with one expired command ends failed: ${JSON.stringify(state)}`,
      );
      results.push(
        'with commandExpirySeconds 120 an offline Powerwash reaches expired and its command job ends failed: pass',
      );
    } finally {
      await control(`/domains/${mock.customerId}/settings`, {
        method: 'PUT',
        body: { writes: { commandExpirySeconds: expiry } },
      });
      await control('/clock', {
        method: 'PUT',
        body: { scale: clock.scale, delays: clock.delays },
      });
    }
  }

  // Item 24: Kestra runs device_update against the real worker; the job reaches
  // its terminal status through the mock.
  {
    const { jobId, executionId } = await seedJob({
      devices: [deviceIds[0]],
      value: 'Room 24',
    });
    const execution = await waitExecution(executionId);
    assert.equal(execution.state.current, 'SUCCESS', JSON.stringify(execution));
    const state = await job(jobId);
    assert.equal(state.status, 'completed', JSON.stringify(state));
    const rows = await operations(jobId);
    assert.deepEqual(
      rows.map((row) => [
        row.status,
        row.verified_by,
        row.field_observed_value,
      ]),
      [['succeeded', 'write-response', 'Room 24']],
    );
    const device = (await byIds([deviceIds[0]]))[0];
    assert.equal(device.annotatedLocation, 'Room 24');
    results.push(
      'Kestra runs device_update against the real worker on the mock and the job reaches completed: pass',
    );
  }

  // Items 5 and 15: a 12 s hang loses the answer of a write that takes effect.
  // The retry receives 403, and the read-back settles the operation succeeded,
  // publishing entity-batch with its device.
  {
    const subscriber = redis.duplicate();
    const events = [];
    subscriber.on('error', () => undefined);
    await subscriber.connect();
    await subscriber.subscribe(entityChannel(customer), (message) => {
      try {
        events.push(JSON.parse(message));
      } catch {
        /* The schema check below reports a malformed message. */
      }
    });
    try {
      let hang;
      const { jobId, executionId } = await seedJob({
        devices: [deviceIds[0]],
        value: 'Room 5',
        beforeStart: async () => {
          hang = await addFault({
            kind: 'hang',
            method: 'directory.chromeosdevices.patch',
            ms: 12000,
            count: 1,
          });
        },
      });
      const deadline = Date.now() + 60_000;
      let remaining;
      for (;;) {
        const rule = (await faults()).find((one) => one.id === hang.id);
        remaining = rule?.remaining;
        if (remaining === 0) break;
        assert.ok(
          Date.now() < deadline,
          `The hang rule still reads ${remaining} remaining.`,
        );
        await delay(200);
      }
      await addFault({
        kind: 'status',
        method: 'directory.chromeosdevices.patch',
        status: 403,
        reason: 'forbidden',
        count: 1,
      });
      const execution = await waitExecution(executionId);
      assert.equal(
        execution.state.current,
        'SUCCESS',
        JSON.stringify(execution),
      );
      const state = await job(jobId);
      assert.equal(state.status, 'completed', JSON.stringify(state));
      const rows = await operations(jobId);
      assert.deepEqual(
        rows.map((row) => [
          row.status,
          row.verified_by,
          row.field_observed_value,
        ]),
        [['succeeded', 'read-back', 'Room 5']],
      );
      const published = events.find(
        (event) =>
          event.type === 'entity-batch' &&
          event.deviceIds?.includes(deviceIds[0]),
      );
      assert.ok(
        published,
        `The read-back published entity-batch: ${JSON.stringify(events)}`,
      );
      assert.equal(published.type, 'entity-batch');
      assert.equal(published.jobId, jobId);
      assert.deepEqual(published.deviceIds, [deviceIds[0]]);
      assert.equal(published.batch, 0);
      assert.equal(published.batchCount, 1);
      const device = (await byIds([deviceIds[0]]))[0];
      assert.equal(device.annotatedLocation, 'Room 5');
      results.push(
        'a hang then a 403 reads back the applied write, publishes entity-batch, and by-ids returns the read-back value: pass',
      );
    } finally {
      await clearFaults();
      await subscriber.unsubscribe(entityChannel(customer));
      await subscriber.quit();
    }
  }

  // The lost answer of a job that writes Annotated user and Notes. The PATCH applies, the
  // answer is lost, the retry meets 403, and the read-back settles both fields (section 8).
  {
    const subscriber = redis.duplicate();
    const events = [];
    subscriber.on('error', () => undefined);
    await subscriber.connect();
    await subscriber.subscribe(entityChannel(customer), (message) => {
      try {
        events.push(JSON.parse(message));
      } catch {
        /* The schema check below reports a malformed message. */
      }
    });
    try {
      let hang;
      const { jobId, executionId } = await seedJob({
        devices: [deviceIds[0]],
        value: 'Ada Lovelace',
        fields: [
          ['annotatedUser', 'Ada Lovelace'],
          ['notes', 'Front desk'],
        ],
        beforeStart: async () => {
          hang = await addFault({
            kind: 'hang',
            method: 'directory.chromeosdevices.patch',
            ms: 12000,
            count: 1,
          });
        },
      });
      const deadline = Date.now() + 60_000;
      let remaining;
      for (;;) {
        const rule = (await faults()).find((one) => one.id === hang.id);
        remaining = rule?.remaining;
        if (remaining === 0) break;
        assert.ok(
          Date.now() < deadline,
          `The hang rule still reads ${remaining} remaining.`,
        );
        await delay(200);
      }
      await addFault({
        kind: 'status',
        method: 'directory.chromeosdevices.patch',
        status: 403,
        reason: 'forbidden',
        count: 1,
      });
      const execution = await waitExecution(executionId);
      assert.equal(
        execution.state.current,
        'SUCCESS',
        JSON.stringify(execution),
      );
      const state = await job(jobId);
      assert.equal(state.status, 'completed', JSON.stringify(state));
      const rows = await fieldRows(jobId);
      assert.deepEqual(
        rows.map((row) => [row.field, row.observed_value]),
        [
          ['annotatedUser', 'Ada Lovelace'],
          ['notes', 'Front desk'],
        ],
        'The read-back settles both fields with the values Google holds.',
      );
      const operations = await fieldRows(jobId);
      assert.ok(
        operations.every((row) => row.observed_value === row.requested_value),
        'Each field row keeps the value that the read-back observed.',
      );
      const published = events.find(
        (event) =>
          event.type === 'entity-batch' &&
          event.deviceIds?.includes(deviceIds[0]),
      );
      assert.ok(
        published,
        `The read-back published entity-batch: ${JSON.stringify(events)}`,
      );
      assert.deepEqual(published.deviceIds, [deviceIds[0]]);
      const device = (await byIds([deviceIds[0]]))[0];
      assert.equal(device.annotatedUser, 'Ada Lovelace');
      assert.equal(device.notes, 'Front desk');
      results.push(
        'a lost answer of annotated user and notes reads back both fields and publishes entity-batch: pass',
      );
    } finally {
      await clearFaults();
      await subscriber.unsubscribe(entityChannel(customer));
      await subscriber.quit();
    }
  }

  // Item 9: the write scope is missing during the batch.
  {
    const { jobId, executionId } = await seedJob({
      devices: [deviceIds[0]],
      value: 'Room 9',
      beforeStart: () =>
        addFault({
          kind: 'remove-scope',
          clientId: mock.key.client_id,
          scope: writeScope,
        }),
    });
    try {
      const execution = await waitExecution(executionId);
      assert.equal(
        execution.state.current,
        'SUCCESS',
        JSON.stringify(execution),
      );
      const state = await job(jobId);
      assert.equal(state.status, 'failed', JSON.stringify(state));
      assert.equal(state.failure, 'delegation-not-authorized');
      assert.equal(state.scope_observations, 1);
      assert.equal(state.scope_failure, 'delegation-not-authorized');
      const rows = await operations(jobId);
      assert.deepEqual(
        rows.map((row) => [row.status, row.outcome_reason]),
        [['skipped', 'delegation-not-authorized']],
      );
      results.push(
        'a removed write scope fails the job delegation-not-authorized, skips its operations, and records one scope observation: pass',
      );
    } finally {
      await clearFaults();
    }
  }

  // Item 14: Replace then a list behind the mock's search lag keeps the written
  // value. A flush and a later list delete the overlay.
  {
    const { jobId, executionId } = await seedJob({
      devices: [deviceIds[1]],
      value: 'Room 14',
    });
    const execution = await waitExecution(executionId);
    assert.equal(execution.state.current, 'SUCCESS', JSON.stringify(execution));
    assert.equal((await operations(jobId))[0].status, 'succeeded');
    let device = (await byIds([deviceIds[1]]))[0];
    assert.equal(device.annotatedLocation, 'Room 14');
    // The mock lists the old value until its search index catches up.
    await runSync();
    device = (await byIds([deviceIds[1]]))[0];
    assert.equal(
      device.annotatedLocation,
      'Room 14',
      'The lagged list keeps the accepted write.',
    );
    const overlays = await migrator.query(
      "SELECT 1 FROM cc.device_write_overlays WHERE customer_id=$1 AND device_id=$2 AND field='annotatedLocation'",
      [customer, deviceIds[1]],
    );
    assert.equal(
      overlays.rowCount,
      1,
      'The overlay waits for a converging list.',
    );
    await control(`/domains/${mock.customerId}/index/flush`, {
      method: 'POST',
    });
    await runSync();
    device = (await byIds([deviceIds[1]]))[0];
    assert.equal(device.annotatedLocation, 'Room 14');
    const after = await migrator.query(
      "SELECT 1 FROM cc.device_write_overlays WHERE customer_id=$1 AND device_id=$2 AND field='annotatedLocation'",
      [customer, deviceIds[1]],
    );
    assert.equal(after.rowCount, 0, 'A converging list deletes the overlay.');
    // Item 14: a Clear after the Replace leaves null in the row.
    const clear = await seedJob({
      devices: [deviceIds[1]],
      value: null,
      mode: 'clear',
    });
    const clearExecution = await waitExecution(clear.executionId);
    assert.equal(
      clearExecution.state.current,
      'SUCCESS',
      JSON.stringify(clearExecution),
    );
    assert.equal((await operations(clear.jobId))[0].status, 'succeeded');
    device = (await byIds([deviceIds[1]]))[0];
    assert.equal(
      device.annotatedLocation,
      null,
      'Clear leaves null in the row that by-ids returns.',
    );
    results.push(
      'Replace then a lagged list keeps the written value, a flush then a list deletes the overlay, and Clear leaves null: pass',
    );
  }

  // IB3 of the in-grid editing design: a seeded Asset tag job writes two tags on two mock devices.
  // The job ends completed, the mock holds both tags, and a Refresh all inside the mock's 300 s
  // search lag keeps both.
  {
    const tag = 'PV-CART-07';
    const { jobId, executionId } = await seedJob({
      devices: deviceIds,
      fields: [['annotatedAssetId', tag]],
    });
    const execution = await waitExecution(executionId);
    assert.equal(execution.state.current, 'SUCCESS', JSON.stringify(execution));
    const state = await waitJob(jobId, ['completed'], 'The Asset tag job');
    assert.equal(state.status, 'completed', JSON.stringify(state));
    assert.deepEqual(
      (await fieldRows(jobId)).map((row) => [
        row.operation_number,
        row.field,
        row.requested_value,
        row.observed_value,
      ]),
      [
        [1, 'annotatedAssetId', tag, tag],
        [2, 'annotatedAssetId', tag, tag],
      ],
      'Each operation carries the tag it wrote.',
    );
    const token = await mockToken(mock, writeScope);
    for (const deviceId of deviceIds) {
      const answer = await mockGoogleGet({
        mock,
        host: 'admin.googleapis.com',
        path: `/admin/directory/v1/customer/${encodeURIComponent(customer)}/devices/chromeos/${encodeURIComponent(deviceId)}`,
        token,
      });
      assert.equal(answer.status, 200, answer.text);
      assert.equal(
        JSON.parse(answer.text).annotatedAssetId,
        tag,
        'The mock holds the tag of the PATCH body.',
      );
    }
    let listed = await byIds(deviceIds);
    assert.deepEqual(
      listed.map((row) => row.assetTag),
      [tag, tag],
    );
    // The mock lists the old tags until its search index catches up (300 s).
    await runSync();
    listed = await byIds(deviceIds);
    assert.deepEqual(
      listed.map((row) => row.assetTag),
      [tag, tag],
      'The lagged Refresh all keeps both accepted tags.',
    );
    const overlays = await migrator.query(
      `SELECT device_id,value FROM cc.device_write_overlays
        WHERE customer_id=$1 AND field='annotatedAssetId' AND device_id=ANY($2::text[])
        ORDER BY device_id`,
      [customer, deviceIds],
    );
    assert.deepEqual(
      overlays.rows.map((row) => [row.device_id, row.value]),
      deviceIds.map((deviceId) => [deviceId, tag]),
      'Each tag waits in its overlay for a converging list.',
    );
    results.push(
      'a seeded Asset tag job sets two tags on two mock devices, ends completed, and keeps both through a Refresh all inside 300 s: pass',
    );
  }

  // B5 acceptance 5 (design section 4, Deprovision): a 12 s hang loses the answer of a status change
  // that Google applied. The worker reads the status back, settles the operation succeeded, and the
  // mock device holds the reason of the job. This block runs last, because it deprovisions its device.
  {
    const clock = await control('/clock');
    assert.ok(
      clock.scale <= 50,
      `The hang test needs a scale of at most 50: ${clock.scale}`,
    );
    const target = (
      await migrator.query(
        `SELECT device_id FROM cc.devices
          WHERE customer_id=$1 AND removed_at IS NULL AND status='ACTIVE'
          ORDER BY device_id LIMIT 1`,
        [customer],
      )
    ).rows[0];
    assert.ok(target, 'The mock stack holds an ACTIVE device to deprovision.');
    let hang;
    try {
      const { jobId, executionId } = await seedJob({
        devices: [target.device_id],
        action: 'deprovision',
        deprovisionReason,
        beforeStart: async () => {
          hang = await addFault({
            kind: 'hang',
            method: 'directory.chromeos.batchChangeStatus',
            ms: Math.ceil(12_000 * clock.scale),
            count: 2,
          });
        },
      });
      const execution = await waitExecution(executionId);
      assert.equal(
        execution.state.current,
        'SUCCESS',
        JSON.stringify(execution),
      );
      const rule = (await faults()).find((one) => one.id === hang.id);
      assert.equal(
        rule.remaining,
        1,
        'The rule accepted exactly one Deprovision part.',
      );
      const state = await waitJob(jobId, ['completed'], 'The Deprovision job');
      assert.equal(state.status, 'completed', JSON.stringify(state));
      const [operation] = await operations(jobId);
      assert.deepEqual(
        [operation.status, operation.verified_by, operation.observed_value],
        ['succeeded', 'read-back', 'DEPROVISIONED'],
        JSON.stringify(operation),
      );
      // The mock device holds the status and the reason that the job sent.
      const token = await mockToken(mock, writeScope);
      const answer = await mockGoogleGet({
        mock,
        host: 'admin.googleapis.com',
        path: `/admin/directory/v1/customer/${encodeURIComponent(customer)}/devices/chromeos/${encodeURIComponent(target.device_id)}`,
        token,
      });
      assert.equal(answer.status, 200, answer.text);
      const device = JSON.parse(answer.text);
      assert.equal(device.status, 'DEPROVISIONED');
      assert.equal(
        device.deprovisionReason,
        deprovisionReason,
        'The mock device holds the reason of the job.',
      );
      results.push(
        'a 12 s hang on a Deprovision part reads the applied status back as succeeded, and the mock device holds the reason of the job: pass',
      );
    } finally {
      await clearFaults();
    }
  }

  await clearFaults();
  return results;
}
