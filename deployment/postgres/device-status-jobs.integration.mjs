import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// The status change job checks of card B4 (addendum section 5). Every check reports its own name.
export async function qualifyDeviceStatusJobs({ runtime, migrator }) {
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
  try {
    await migrator.query('UPDATE cc.google_connection SET active=true');
    actor = randomUUID();
    principals.push(actor);
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
      [actor, 'status-jobs', `${randomUUID()}@example.org`],
    );
    // The revalidation of a dispatch needs the two write actions of a status change.
    for (const action of [
      'devices:read',
      'devices:bulk-actions',
      'devices:status',
    ])
      await migrator.query(
        'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
        [
          actor,
          action,
          JSON.stringify({ kind: 'district', customerId: customer }),
        ],
      );
    const device = (deviceId, extra = {}) => ({
      deviceId,
      serialNumber: `SN-${deviceId}`,
      model: 'Lenovo 100e Gen 4',
      assetTag: `HS-${deviceId}`,
      orgUnitPath: '/School A',
      lastContact: '2026-10-05T12:00:00.000Z',
      annotatedLocation: null,
      notes: null,
      status: 'ACTIVE',
      ...extra,
    });
    const upsert = (devices, at, observation = 'list') =>
      result('SELECT cc.upsert_devices($1,$2,$3,$4) AS result', [
        customer,
        JSON.stringify(devices),
        at,
        observation,
      ]);
    const deviceRow = (deviceId) =>
      adminRow(
        `SELECT annotated_location,annotated_location_observed_at,status,status_observed_at,removed_at
          FROM cc.devices WHERE customer_id=$1 AND device_id=$2`,
        [customer, deviceId],
      );
    const overlayOf = async (deviceId, field) =>
      (
        await admin(
          'SELECT * FROM cc.device_write_overlays WHERE customer_id=$1 AND device_id=$2 AND field=$3',
          [customer, deviceId, field],
        )
      )[0];
    const publications = (jobId) =>
      admin(
        'SELECT device_ids,status_changed FROM cc.job_publications WHERE job_id=$1',
        [jobId],
      );
    // One status job fixture: a preview, a header, a detail row, and one pending operation per device.
    const makeStatusJob = async ({
      devices,
      action = 'disable',
      requested = 'DISABLED',
      baseline = 'ACTIVE',
    }) => {
      const jobId = randomUUID();
      const previewId = randomUUID();
      const version = (
        await adminRow(
          'SELECT permission_version FROM cc.application_principals WHERE id=$1',
          [actor],
        )
      ).permission_version;
      await admin(
        `INSERT INTO cc.device_update_previews(preview_id, display_id, customer_id, created_by, permission_version, generation, action, action_version, selected, eligible, unchanged, excluded, manifest_digest, expires_at)
        VALUES($1, cc.job_display_id('PV',nextval('cc.preview_number_pv')), $2, $3, $4, $5, $6, CASE WHEN $6='annotated-location' THEN 2 ELSE 1 END, $7, $7, 0, 0, 'manifest-digest', clock_timestamp()+interval '1 hour')`,
        [
          previewId,
          customer,
          actor,
          version,
          generation,
          action,
          devices.length,
        ],
      );
      await admin(
        `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
          target_count,correlation_id)
        VALUES($1,cc.job_display_id('STS',nextval('cc.job_number_sts')),$2,'device-status','devices',
          'accepted',$3,$4,$5,$6)`,
        [jobId, customer, actor, generation, devices.length, randomUUID()],
      );
      await admin(
        `INSERT INTO cc.device_update_jobs(job_id, preview_id, action, confirmed_by, confirmer_permission_version, delegated_subject, batch_size, batch_count)
        VALUES($1, $2, $3, $4, $5, 'admin@example.org', 250, 1)`,
        [jobId, previewId, action, actor, version],
      );
      for (const [index, deviceId] of devices.entries())
        await admin(
          `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,serial_number,
            org_unit_path,baseline_value,requested_value,batch,status)
          VALUES($1,$2,$3,$4,'/School A',$5,$6,0,'pending')`,
          [jobId, index + 1, deviceId, `SN-${deviceId}`, baseline, requested],
        );
      jobs.push(jobId);
      return { jobId, previewId };
    };
    const admit = () =>
      result('SELECT cc.admit_device_update_job($1,$2) AS result', [
        customer,
        false,
      ]);
    // Admission takes the one write slot. Each check frees the slot when it is done: a job of an
    // earlier check that still runs is ended before the next admission.
    const finish = async (jobId) => {
      await migrator.query(
        `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()-interval '60 seconds'
          WHERE job_id=$1`,
        [jobId],
      );
      return migrator.query('SELECT cc.finalize_device_update_job($1,$2,$3)', [
        customer,
        jobId,
        null,
      ]);
    };
    const start = async (jobId) => {
      for (let tries = 0; tries < 3; tries += 1) {
        const admitted = await admit();
        if (admitted?.jobId === jobId) return admitted;
        // A leftover job of this file or of an earlier suite holds the slot. End it and admit again.
        const leftover =
          admitted?.jobId ??
          (
            await adminRow(
              `SELECT job_id FROM cc.jobs WHERE customer_id=$1 AND
                kind IN ('device-update','device-command','device-status') AND status='running'`,
              [customer],
            )
          )?.job_id;
        if (!leftover) break;
        await finish(leftover);
      }
      throw new Error('The status job was not admitted.');
    };
    const claim = (jobId, token, batch, attempt) =>
      result(
        'SELECT cc.claim_device_update_batch($1,$2,$3,$4,$5,$6) AS result',
        [customer, jobId, token, batch, attempt, 'kestra-execution'],
      );
    const settle = (jobId, token, attempt, kind, outcomes, observedAt) =>
      result(
        'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          customer,
          jobId,
          kind === 'write' ? token : null,
          attempt,
          kind,
          JSON.stringify(outcomes),
          observedAt,
        ],
      );
    const expireVerification = (jobId) =>
      migrator.query(
        `UPDATE cc.device_update_operations SET verify_lease_expires_at=clock_timestamp()-interval '1 minute'
          WHERE job_id=$1`,
        [jobId],
      );
    const claimVerification = (jobId, operations, attempt) =>
      result(
        'SELECT cc.claim_device_update_verification($1,$2,$3,$4) AS result',
        [customer, jobId, JSON.stringify(operations), attempt],
      );

    await check(
      'B4 a status settlement writes DISABLED, its overlay, and the entity-batch element',
      async () => {
        await upsert([device('sj1')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await makeStatusJob({ devices: ['sj1'] });
        const admitted = await start(job.jobId);
        const attempt = randomUUID();
        const claimed = await claim(
          job.jobId,
          admitted.dispatchToken,
          0,
          attempt,
        );
        assert.equal(claimed.outcome, 'claimed');
        assert.equal(claimed.action, 'disable');
        assert.deepEqual(
          claimed.operations.map((one) => [one.deviceId, one.requestedValue]),
          [['sj1', 'DISABLED']],
        );
        const observedAt = new Date();
        const settled = await settle(
          job.jobId,
          admitted.dispatchToken,
          attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              verifiedBy: 'write-response',
            },
          ],
          observedAt,
        );
        assert.deepEqual(
          settled.settled.map((one) => [one.deviceId, one.status]),
          [['sj1', 'succeeded']],
        );
        const row = await deviceRow('sj1');
        assert.equal(row.status, 'DISABLED');
        assert.equal(row.status_observed_at.getTime(), observedAt.getTime());
        assert.equal(row.annotated_location, null);
        const written = await overlayOf('sj1', 'status');
        assert.equal(written.value, 'DISABLED');
        assert.equal(written.source, 'write-response');
        assert.equal(written.job_id, job.jobId);
        assert.equal(
          written.expires_at.getTime(),
          observedAt.getTime() + 36 * 60 * 60 * 1000,
        );
        assert.equal(await overlayOf('sj1', 'annotatedLocation'), undefined);
        // The settlement publishes the row, so the grid reloads it through an entity-batch.
        assert.deepEqual(settled.publication.deviceIds, ['sj1']);
        assert.equal(settled.publication.statusChanged, false);
        const published = await publications(job.jobId);
        // The claim records a publication without devices. The settlement adds the one that names
        // the changed device.
        assert.deepEqual(
          published
            .map((one) => one.device_ids)
            .filter((deviceIds) => deviceIds.length > 0),
          [['sj1']],
        );
      },
    );

    await check(
      'B4 a list sync inside 300 s keeps DISABLED and a converging list clears the overlay',
      async () => {
        // Check 1 leaves a live DISABLED status and its overlay on sj1. The mock answers a list
        // inside its 300 s search delay from its before image, so the old status arrives here.
        await upsert([device('sj1')], new Date(Date.now() + 1_000));
        const kept = await deviceRow('sj1');
        assert.equal(kept.status, 'DISABLED');
        assert.equal((await overlayOf('sj1', 'status')).value, 'DISABLED');
        await upsert(
          [device('sj1', { status: 'DISABLED' })],
          new Date(Date.now() + 2_000),
        );
        const converged = await deviceRow('sj1');
        assert.equal(converged.status, 'DISABLED');
        assert.equal(await overlayOf('sj1', 'status'), undefined);
      },
    );

    await check(
      'B4 a refused status change writes no cache row and publishes no device',
      async () => {
        await upsert([device('sj2')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await makeStatusJob({ devices: ['sj2'] });
        const admitted = await start(job.jobId);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        const observedAt = new Date();
        const settled = await settle(
          job.jobId,
          admitted.dispatchToken,
          attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'failed',
              outcomeReason: 'status-conflict',
              googleReason:
                'A device with status DISABLED does not allow this action.',
              googleStatus: null,
              verifiedBy: 'write-response',
            },
          ],
          observedAt,
        );
        assert.deepEqual(
          settled.settled.map((one) => one.status),
          ['failed'],
        );
        assert.deepEqual(settled.published, []);
        assert.deepEqual(settled.publication.deviceIds, []);
        const row = await deviceRow('sj2');
        assert.equal(row.status, 'ACTIVE');
        assert.equal(await overlayOf('sj2', 'status'), undefined);
      },
    );

    await check(
      'B4 a status read-back settles the operation and moves the cache to DISABLED',
      async () => {
        await upsert([device('sj3')], new Date(Date.now() - 60 * 60 * 1000));
        const job = await makeStatusJob({ devices: ['sj3'] });
        const admitted = await start(job.jobId);
        const attempt = randomUUID();
        await claim(job.jobId, admitted.dispatchToken, 0, attempt);
        // A lost write answer leaves the operation unknown and open for a read-back.
        const lost = await settle(
          job.jobId,
          admitted.dispatchToken,
          attempt,
          'write',
          [
            {
              operationNumber: 1,
              outcome: 'unknown',
              outcomeReason: 'ambiguous',
            },
          ],
          new Date(),
        );
        assert.deepEqual(
          lost.settled.map((one) => one.status),
          ['unknown'],
        );
        await expireVerification(job.jobId);
        const verifyAttempt = randomUUID();
        const held = await claimVerification(job.jobId, [1], verifyAttempt);
        assert.deepEqual(
          held.map((one) => [one.deviceId, one.requestedValue]),
          [['sj3', 'DISABLED']],
        );
        const observedAt = new Date();
        const settled = await settle(
          job.jobId,
          null,
          verifyAttempt,
          'read-back',
          [
            {
              operationNumber: 1,
              outcome: 'succeeded',
              verifiedBy: 'read-back',
              value: 'DISABLED',
            },
          ],
          observedAt,
        );
        assert.deepEqual(
          settled.settled.map((one) => one.status),
          ['succeeded'],
        );
        assert.deepEqual(settled.publication.deviceIds, ['sj3']);
        const row = await deviceRow('sj3');
        assert.equal(row.status, 'DISABLED');
        assert.equal(row.status_observed_at.getTime(), observedAt.getTime());
        const written = await overlayOf('sj3', 'status');
        assert.equal(written.source, 'read-back');
        assert.equal(written.value, 'DISABLED');
      },
    );
  } finally {
    await migrator.query('UPDATE cc.google_connection SET active=$1', [
      wasActive,
    ]);
    await migrator.query(
      'UPDATE cc.google_connection SET generation=$2 WHERE customer_id=$1',
      [customer, generation],
    );
    for (const jobId of jobs)
      try {
        await migrator.query(
          `UPDATE cc.device_update_batches SET lease_expires_at=clock_timestamp()-interval '60 seconds'
            WHERE job_id=$1`,
          [jobId],
        );
        await migrator.query('SELECT cc.finalize_device_update_job($1,$2,$3)', [
          customer,
          jobId,
          null,
        ]);
      } catch {
        /* A job that another check ended stays. */
      }
    for (const id of principals)
      try {
        await migrator.query(
          'DELETE FROM cc.device_write_overlays WHERE customer_id=$1 AND device_id LIKE $2',
          [customer, 'sj%'],
        );
        await migrator.query('DELETE FROM cc.jobs WHERE requested_by=$1', [id]);
        await migrator.query(
          'DELETE FROM cc.device_update_previews WHERE created_by=$1',
          [id],
        );
        await migrator.query(
          'DELETE FROM cc.application_principals WHERE id=$1',
          [id],
        );
      } catch {
        /* A fixture row that another table still names stays. */
      }
    await migrator.query(
      "DELETE FROM cc.devices WHERE customer_id=$1 AND device_id LIKE 'sj%'",
      [customer],
    );
  }
  if (failures.length)
    throw new Error(`Device status job checks failed: ${failures.join(' | ')}`);
  return results;
}
