import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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

  const seedJob = async ({ devices, value, mode = 'replace', beforeStart }) => {
    const jobId = randomUUID();
    const previewId = randomUUID();
    // One transaction: the preview, the header, the detail, and the operations become visible together.
    // A tick that runs during the seed cannot admit a half-written job (R1-F2).
    await migrator.query('BEGIN');
    try {
      await migrator.query(
        `INSERT INTO cc.device_update_previews(preview_id,display_id,customer_id,created_by,permission_version,
        generation,field,mode,value,selected,eligible,unchanged,excluded,manifest_digest,expires_at)
      VALUES($1,cc.job_display_id('PV',nextval('cc.preview_number_pv')),$2,$3,$4,$5,'annotatedLocation',$6,$7,$8,$8,0,0,
        'manifest-digest',clock_timestamp()+interval '1 hour')`,
        [
          previewId,
          customer,
          principal.id,
          principal.permission_version,
          connection.generation,
          mode,
          mode === 'clear' ? null : value,
          devices.length,
        ],
      );
      await migrator.query(
        `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
        target_count,correlation_id,created_at)
      VALUES($1,cc.job_display_id('UPD',nextval('cc.job_number_upd')),$2,'device-update','devices','accepted',$3,$4,
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
        `INSERT INTO cc.device_update_jobs(job_id,preview_id,field,mode,value,confirmed_by,confirmer_permission_version,
        delegated_subject,batch_size,batch_count)
      VALUES($1,$2,'annotatedLocation',$3,$4,$5,$6,$7,$8,1)`,
        [
          jobId,
          previewId,
          mode,
          mode === 'clear' ? null : value,
          principal.id,
          principal.permission_version,
          mock.adminEmail,
          devices.length,
        ],
      );
      for (const [index, deviceId] of devices.entries())
        await migrator.query(
          `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,serial_number,org_unit_path,
          baseline_value,requested_value,batch,status)
        VALUES($1,$2,$3,$4,'/School A',NULL,$5,0,'pending')`,
          [
            jobId,
            index + 1,
            deviceId,
            `SN-${deviceId}`,
            mode === 'clear' ? null : value,
          ],
        );
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
        `SELECT operation_number,device_id,status,outcome_reason,verified_by,observed_value
          FROM cc.device_update_operations WHERE job_id=$1 ORDER BY operation_number`,
        [jobId],
      )
    ).rows;
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
      rows.map((row) => [row.status, row.verified_by, row.observed_value]),
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
        rows.map((row) => [row.status, row.verified_by, row.observed_value]),
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

  await clearFaults();
  return results;
}
