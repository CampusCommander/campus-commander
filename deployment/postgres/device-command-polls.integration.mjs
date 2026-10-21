import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// The command poll checks of card B6 (addendum section 4 steps 5 to 10 and section 8). Every check
// reports its own name, like the other integration files.
export async function qualifyDeviceCommandPolls({ runtime, migrator }) {
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
  try {
    await migrator.query('UPDATE cc.google_connection SET active=true');
    // The claim reads the envelope of the current credential. The earlier Google checks leave one.
    const credential = await adminRow(
      'SELECT * FROM cc.google_credentials WHERE id=$1',
      [connection.credential_id],
    );
    assert.ok(credential, 'The Google connection names a stored credential.');
    actor = randomUUID();
    principals.push(actor);
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
      [actor, 'command-polls', `${randomUUID()}@example.org`],
    );
    const version = (
      await adminRow(
        'SELECT permission_version FROM cc.application_principals WHERE id=$1',
        [actor],
      )
    ).permission_version;

    // A command job in awaiting-devices with one issued operation per device (the B5 shape).
    const makeJob = async ({
      devices = ['cmd-poll-a'],
      pollAfter = '-1 second',
      deadline = '7 days',
      lease = null,
      status = 'awaiting-devices',
    } = {}) => {
      const jobId = randomUUID();
      const previewId = randomUUID();
      await admin(
        `INSERT INTO cc.device_update_previews(preview_id,display_id,customer_id,created_by,permission_version,
          generation,action,field,mode,value,selected,eligible,unchanged,excluded,manifest_digest,expires_at)
        VALUES($1,cc.job_display_id('PV',nextval('cc.preview_number_pv')),$2,$3,$4,$5,'reboot',NULL,NULL,NULL,$6,$6,0,0,
          'manifest-digest',clock_timestamp()+interval '1 hour')`,
        [previewId, customer, actor, version, generation, devices.length],
      );
      await admin(
        `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,generation,
          target_count,correlation_id)
        VALUES($1,cc.job_display_id('CMD',nextval('cc.job_number_cmd')),$2,'device-command','devices',$3,$4,$5,
          $6,$7)`,
        [
          jobId,
          customer,
          status,
          actor,
          generation,
          devices.length,
          randomUUID(),
        ],
      );
      await admin(
        `INSERT INTO cc.device_update_jobs(job_id,preview_id,action,field,mode,value,confirmed_by,
          confirmer_permission_version,delegated_subject,batch_size,batch_count,poll_lease_expires_at)
        VALUES($1,$2,'reboot',NULL,NULL,NULL,$3,$4,'admin@example.org',250,1,
          CASE WHEN $5::text IS NULL THEN NULL ELSE clock_timestamp()+$5::interval END)`,
        [jobId, previewId, actor, version, lease],
      );
      for (const [index, deviceId] of devices.entries())
        await admin(
          `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,serial_number,
            org_unit_path,baseline_value,requested_value,batch,status,command_id,command_state,poll_after,
            poll_deadline_at)
          VALUES($1,$2,$3,$4,'/School A','ACTIVE',NULL,0,'issued',$5,'pending-delivery',
            clock_timestamp()+$6::interval,clock_timestamp()+$7::interval)`,
          [
            jobId,
            index + 1,
            deviceId,
            `SN-${deviceId}`,
            String(4100000000 + index + 1),
            pollAfter,
            deadline,
          ],
        );
      jobs.push(jobId);
      previews.push(previewId);
      return jobId;
    };
    const jobRow = (jobId) =>
      adminRow(
        `SELECT status,finished_at,succeeded,failed,unknown,expired,revision
          FROM cc.jobs WHERE job_id=$1`,
        [jobId],
      );
    const opRow = (jobId, number) =>
      adminRow(
        `SELECT status,command_state,command_expires_at,command_executed_at,poll_count,poll_after,
          poll_deadline_at,poll_attempt,poll_lease_expires_at,outcome_reason,google_status,google_reason
          FROM cc.device_update_operations WHERE job_id=$1 AND operation_number=$2`,
        [jobId, number],
      );
    const due = () =>
      result('SELECT cc.due_device_command_polls($1) AS result', [customer]);
    /** The due call returns at most ten jobs, so it repeats until this one holds its lease. */
    const dueFor = async (jobId) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const leased = await due();
        if (leased.some((one) => one.jobId === jobId)) return leased;
      }
      throw new Error(`The due call never returned job ${jobId}.`);
    };
    const claim = (jobId, attempt = randomUUID()) =>
      result('SELECT cc.claim_device_command_polls($1,$2,$3) AS result', [
        customer,
        jobId,
        attempt,
      ]).then((answer) => ({ ...answer, attempt }));
    const settle = (jobId, attempt, observed, observedAt = null) =>
      result(
        'SELECT cc.settle_device_command_polls($1,$2,$3,$4,$5) AS result',
        [
          customer,
          jobId,
          attempt,
          JSON.stringify(observed),
          observedAt ?? new Date().toISOString(),
        ],
      );
    const release = (jobId) =>
      result('SELECT cc.release_device_command_poll($1,$2) AS result', [
        customer,
        jobId,
      ]);
    const recordStart = (jobId, execution) =>
      result('SELECT cc.record_device_command_poll_start($1,$2,$3) AS result', [
        customer,
        jobId,
        execution,
      ]);
    /** A due job with one claimed operation. */
    const claimed = async (options = {}) => {
      const jobId = await makeJob(options);
      await dueFor(jobId);
      const attempt = randomUUID();
      const answer = await claim(jobId, attempt);
      assert.equal(answer.outcome, 'claimed');
      return { jobId, attempt, answer };
    };
    const settledIn = async (jobId, attempt, observed, observedAt = null) => {
      const answer = await settle(jobId, attempt, observed, observedAt);
      assert.equal(answer.outcome, 'settled');
      return answer;
    };
    const expiry = new Date(Date.now() + 5 * 86_400_000).toISOString();

    await check('poll delay follows the section 4 step 7 ladder', async () => {
      const rows = await admin(
        `SELECT cc.device_command_poll_delay(n)::text AS delay
          FROM unnest(ARRAY[NULL,0,1,2,3,4,5,6,7,9]::integer[]) AS n`,
      );
      assert.deepEqual(
        rows.map((row) => row.delay),
        [
          '00:00:15',
          '00:00:15',
          '00:00:15',
          '00:00:30',
          '00:01:00',
          '00:02:00',
          '00:05:00',
          '00:15:00',
          '01:00:00',
          '01:00:00',
        ],
      );
    });

    await check(
      'a due command job leases once and records the poll start',
      async () => {
        const jobId = await makeJob();
        await dueFor(jobId);
        assert.equal(
          (await due()).some((one) => one.jobId === jobId),
          false,
          'A live lease keeps the next tick off the job.',
        );
        assert.equal(await recordStart(jobId, 'kestra-execution-1'), true);
        assert.equal(
          (
            await adminRow(
              'SELECT poll_execution_id FROM cc.device_update_jobs WHERE job_id=$1',
              [jobId],
            )
          ).poll_execution_id,
          'kestra-execution-1',
        );
        assert.equal(await release(jobId), true);
        await dueFor(jobId);
        assert.equal(
          await recordStart(jobId, 'kestra-execution-2'),
          true,
          'A fresh lease records its flow.',
        );
        await release(jobId);
      },
    );

    await check(
      'a claim without the job lease answers not-held and changes nothing',
      async () => {
        const jobId = await makeJob({ lease: null });
        const answer = await claim(jobId);
        assert.equal(answer.outcome, 'not-held');
        assert.equal(answer.status, 'awaiting-devices');
        const row = await opRow(jobId, 1);
        assert.equal(row.poll_count, 0);
        assert.equal(row.poll_attempt, null);
      },
    );

    await check(
      'a poll claim returns the credential and leases the operation',
      async () => {
        const jobId = await makeJob();
        await dueFor(jobId);
        const attempt = randomUUID();
        const answer = await claim(jobId, attempt);
        assert.equal(answer.outcome, 'claimed');
        assert.equal(answer.generation, generation);
        assert.equal(answer.credentialId, connection.credential_id);
        assert.deepEqual(answer.envelope, credential.envelope);
        assert.deepEqual(answer.operations, [
          {
            operationNumber: 1,
            deviceId: 'cmd-poll-a',
            commandId: '4100000001',
          },
        ]);
        const row = await opRow(jobId, 1);
        assert.equal(row.poll_count, 1);
        assert.equal(row.poll_attempt, attempt);
        assert.ok(row.poll_lease_expires_at > new Date(Date.now() + 110_000));
        await release(jobId);
      },
    );

    await check(
      'a second claim answers idle while the operation is leased',
      async () => {
        const { jobId } = await claimed();
        const second = await claim(jobId);
        assert.equal(second.outcome, 'idle');
        assert.equal((await opRow(jobId, 1)).poll_count, 1);
        await release(jobId);
      },
    );

    await check(
      'a release keeps the operation lease so the next poll waits it out',
      async () => {
        const { jobId } = await claimed();
        assert.equal(await release(jobId), true);
        const row = await opRow(jobId, 1);
        assert.ok(
          row.poll_lease_expires_at > new Date(Date.now() + 110_000),
          'An unanswered GET keeps its 120 s lease.',
        );
        await dueFor(jobId);
        assert.equal(
          (await claim(jobId)).outcome,
          'idle',
          'The next run sends no second GET inside the lease.',
        );
      },
    );

    await check(
      'a pending observation keeps the operation issued and waits 15 s',
      async () => {
        const { jobId, attempt } = await claimed();
        const answer = await settledIn(jobId, attempt, [
          {
            operationNumber: 1,
            outcome: 'pending',
            commandState: 'sent',
            commandExpiresAt: expiry,
          },
        ]);
        assert.equal(answer.jobStatusChanged, false);
        assert.equal(answer.status, 'awaiting-devices');
        const row = await opRow(jobId, 1);
        assert.equal(row.status, 'issued');
        assert.equal(row.command_state, 'sent');
        assert.equal(row.poll_attempt, null);
        assert.equal(row.poll_lease_expires_at, null);
        assert.equal(
          row.command_expires_at.toISOString(),
          new Date(expiry).toISOString(),
        );
        assert.equal(
          row.poll_deadline_at.toISOString(),
          new Date(new Date(expiry).getTime() + 86_400_000).toISOString(),
          'The deadline becomes the Google expiry plus 24 hours (step 8).',
        );
        assert.ok(
          row.poll_after.getTime() > Date.now() + 10_000 &&
            row.poll_after.getTime() < Date.now() + 20_000,
          `The next poll waits 15 s, not ${row.poll_after.toISOString()}.`,
        );
        assert.equal((await jobRow(jobId)).status, 'awaiting-devices');
        await release(jobId);
      },
    );

    await check('the second non-terminal observation waits 30 s', async () => {
      const { jobId, attempt } = await claimed();
      await settledIn(jobId, attempt, [
        { operationNumber: 1, outcome: 'pending', commandState: 'sent' },
      ]);
      await admin(
        'UPDATE cc.device_update_operations SET poll_after=clock_timestamp() WHERE job_id=$1',
        [jobId],
      );
      const second = await claim(jobId);
      assert.equal(second.outcome, 'claimed');
      await settledIn(jobId, second.attempt, [
        {
          operationNumber: 1,
          outcome: 'pending',
          commandState: 'acknowledged',
        },
      ]);
      const row = await opRow(jobId, 1);
      assert.equal(row.poll_count, 2);
      assert.ok(
        row.poll_after.getTime() > Date.now() + 25_000 &&
          row.poll_after.getTime() < Date.now() + 35_000,
        `The second wait is 30 s, not ${row.poll_after.toISOString()}.`,
      );
      await release(jobId);
    });

    await check(
      'a succeeded observation settles the operation and completes the job',
      async () => {
        const executedAt = new Date().toISOString();
        const { jobId, attempt } = await claimed();
        const answer = await settledIn(jobId, attempt, [
          {
            operationNumber: 1,
            outcome: 'succeeded',
            googleStatus: 200,
            commandExecutedAt: executedAt,
          },
        ]);
        assert.equal(answer.jobStatusChanged, true);
        assert.equal(answer.status, 'completed');
        assert.ok(answer.publication, 'The completion publishes a change.');
        const row = await opRow(jobId, 1);
        assert.equal(row.status, 'succeeded');
        assert.equal(
          row.command_executed_at.toISOString(),
          new Date(executedAt).toISOString(),
        );
        assert.equal(row.poll_lease_expires_at, null);
        const job = await jobRow(jobId);
        assert.equal(job.status, 'completed');
        assert.ok(job.finished_at, 'A completed job sets finished_at.');
        assert.equal(job.succeeded, 1);
      },
    );

    await check('an expired observation fails the job', async () => {
      const { jobId, attempt } = await claimed();
      const answer = await settledIn(jobId, attempt, [
        { operationNumber: 1, outcome: 'expired', googleStatus: 200 },
      ]);
      assert.equal(answer.status, 'failed');
      const job = await jobRow(jobId);
      assert.equal(job.expired, 1);
      assert.equal(job.status, 'failed');
    });

    await check('one success and one expiry complete with errors', async () => {
      const { jobId, attempt, answer } = await claimed({
        devices: ['cmd-poll-a', 'cmd-poll-b'],
      });
      assert.equal(answer.operations.length, 2);
      const settled = await settledIn(jobId, attempt, [
        { operationNumber: 1, outcome: 'succeeded', googleStatus: 200 },
        { operationNumber: 2, outcome: 'expired', googleStatus: 200 },
      ]);
      assert.equal(settled.status, 'completed-with-errors');
      const job = await jobRow(jobId);
      assert.equal(job.succeeded, 1);
      assert.equal(job.expired, 1);
    });

    await check(
      'an operation past its deadline settles unknown and needs review',
      async () => {
        const jobId = await makeJob({ deadline: '-1 second' });
        await dueFor(jobId);
        const answer = await claim(jobId);
        assert.equal(answer.outcome, 'completed');
        assert.equal(answer.status, 'needs-review');
        const row = await opRow(jobId, 1);
        assert.equal(row.status, 'unknown');
        assert.equal(row.outcome_reason, 'not-observed');
        assert.equal((await jobRow(jobId)).status, 'needs-review');
      },
    );

    await check(
      'a settlement with a lapsed job lease changes nothing',
      async () => {
        const { jobId, attempt } = await claimed();
        await admin(
          "UPDATE cc.device_update_jobs SET poll_lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [jobId],
        );
        const answer = await settle(jobId, attempt, [
          { operationNumber: 1, outcome: 'succeeded', googleStatus: 200 },
        ]);
        assert.equal(answer.outcome, 'fenced');
        assert.equal((await opRow(jobId, 1)).status, 'issued');
        assert.equal((await jobRow(jobId)).status, 'awaiting-devices');
      },
    );

    await check(
      'a settlement for another attempt settles nothing',
      async () => {
        const { jobId } = await claimed();
        const answer = await settle(jobId, randomUUID(), [
          { operationNumber: 1, outcome: 'succeeded', googleStatus: 200 },
        ]);
        assert.equal(answer.outcome, 'settled');
        assert.deepEqual(answer.settled, []);
        assert.equal((await opRow(jobId, 1)).status, 'issued');
        await release(jobId);
      },
    );

    await check(
      'a poll result outside the domain is rejected before any change',
      async () => {
        const { jobId, attempt } = await claimed();
        await assert.rejects(
          settle(jobId, attempt, [{ operationNumber: 1, outcome: 'pending' }]),
          (error) => error.code === '22023',
          'pending without a command state is invalid',
        );
        await assert.rejects(
          settle(jobId, attempt, [{ operationNumber: 1, outcome: 'finished' }]),
          (error) => error.code === '22023',
        );
        assert.equal((await opRow(jobId, 1)).status, 'issued');
        await release(jobId);
      },
    );

    await check(
      'a poll without a usable connection answers unavailable and keeps the operation',
      async () => {
        const jobId = await makeJob();
        await dueFor(jobId);
        await migrator.query(
          'UPDATE cc.google_connection SET active=false WHERE customer_id=$1',
          [customer],
        );
        try {
          const answer = await claim(jobId);
          assert.equal(answer.outcome, 'unavailable');
          assert.equal(answer.status, 'awaiting-devices');
          assert.equal(
            (await opRow(jobId, 1)).poll_attempt,
            null,
            'The claim leases nothing when the credential read fails.',
          );
          assert.equal((await opRow(jobId, 1)).poll_count, 0);
        } finally {
          await migrator.query(
            'UPDATE cc.google_connection SET active=true WHERE customer_id=$1',
            [customer],
          );
        }
        await release(jobId);
      },
    );

    await check(
      'the deadline settles an operation while the connection is unusable',
      async () => {
        const jobId = await makeJob({ deadline: '-1 second' });
        await dueFor(jobId);
        await migrator.query(
          'UPDATE cc.google_connection SET active=false WHERE customer_id=$1',
          [customer],
        );
        try {
          const answer = await claim(jobId);
          assert.equal(answer.outcome, 'completed');
          assert.equal(answer.status, 'needs-review');
        } finally {
          await migrator.query(
            'UPDATE cc.google_connection SET active=true WHERE customer_id=$1',
            [customer],
          );
        }
        assert.equal((await opRow(jobId, 1)).outcome_reason, 'not-observed');
      },
    );

    await check('a finished job answers not-held', async () => {
      const { jobId } = await claimed();
      await admin(
        "UPDATE cc.jobs SET status='completed',finished_at=clock_timestamp() WHERE job_id=$1",
        [jobId],
      );
      const answer = await claim(jobId);
      assert.equal(answer.outcome, 'not-held');
      assert.equal(answer.status, 'completed');
    });
  } finally {
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
    await migrator.query('UPDATE cc.google_connection SET active=$1', [
      wasActive,
    ]);
  }
  if (failures.length > 0)
    throw new Error(
      `Device command poll checks failed: ${failures.join(' | ')}`,
    );
  return results;
}
