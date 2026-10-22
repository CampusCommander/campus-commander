import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// The command poll checks of card B6 (addendum section 4 steps 5 to 10 and section 8). Every check
// reports its own name, like the other integration files.
export async function qualifyDeviceCommandPolls({
  runtime,
  migrator,
  connect,
  close,
  password,
}) {
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
        const one = leased.find((entry) => entry.jobId === jobId);
        if (one !== undefined) return one;
      }
      throw new Error(`The due call never returned job ${jobId}.`);
    };
    const claim = (jobId, attempt = randomUUID(), leaseId) =>
      result('SELECT cc.claim_device_command_polls($1,$2,$3,$4) AS result', [
        customer,
        jobId,
        attempt,
        leaseId,
      ]).then((answer) => ({ ...answer, attempt }));
    const settle = (jobId, attempt, leaseId, observed, observedAt = null) =>
      result(
        'SELECT cc.settle_device_command_polls($1,$2,$3,$4,$5,$6) AS result',
        [
          customer,
          jobId,
          attempt,
          leaseId,
          JSON.stringify(observed),
          observedAt ?? new Date().toISOString(),
        ],
      );
    const release = (jobId, leaseId) =>
      result('SELECT cc.release_device_command_poll($1,$2,$3) AS result', [
        customer,
        jobId,
        leaseId,
      ]);
    const recordStart = (jobId, leaseId, execution) =>
      result(
        'SELECT cc.record_device_command_poll_start($1,$2,$3,$4) AS result',
        [customer, jobId, leaseId, execution],
      );
    /** A due job with one claimed operation under the lease the due call granted. */
    const claimed = async (options = {}) => {
      const jobId = await makeJob(options);
      const leaseId = (await dueFor(jobId)).leaseId;
      const attempt = randomUUID();
      const answer = await claim(jobId, attempt, leaseId);
      assert.equal(answer.outcome, 'claimed');
      return { jobId, attempt, leaseId, answer };
    };
    const settledIn = async (
      jobId,
      attempt,
      leaseId,
      observed,
      observedAt = null,
    ) => {
      const answer = await settle(
        jobId,
        attempt,
        leaseId,
        observed,
        observedAt,
      );
      assert.equal(answer.outcome, 'settled');
      return answer;
    };
    const leaseRow = (jobId) =>
      adminRow(
        'SELECT poll_lease_id,poll_lease_expires_at,poll_execution_id FROM cc.device_update_jobs WHERE job_id=$1',
        [jobId],
      );
    /** Make the next poll due now. */
    const dueNow = (jobId) =>
      admin(
        "UPDATE cc.device_update_operations SET poll_after=clock_timestamp()-interval '1 second' WHERE job_id=$1",
        [jobId],
      );
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
        const first = await dueFor(jobId);
        assert.equal(typeof first.leaseId, 'string');
        assert.equal(
          (await due()).some((one) => one.jobId === jobId),
          false,
          'A live lease keeps the next tick off the job.',
        );
        assert.equal(
          await recordStart(jobId, first.leaseId, 'kestra-execution-1'),
          true,
        );
        assert.equal(
          (await leaseRow(jobId)).poll_execution_id,
          'kestra-execution-1',
        );
        assert.equal(await release(jobId, first.leaseId), true);
        const second = await dueFor(jobId);
        assert.equal(
          await recordStart(jobId, second.leaseId, 'kestra-execution-2'),
          true,
          'A fresh lease records its flow.',
        );
        await release(jobId, second.leaseId);
      },
    );

    await check(
      'a claim without the job lease answers not-held and changes nothing',
      async () => {
        const jobId = await makeJob({ lease: null });
        const answer = await claim(jobId, randomUUID(), randomUUID());
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
        const leaseId = (await dueFor(jobId)).leaseId;
        const attempt = randomUUID();
        const answer = await claim(jobId, attempt, leaseId);
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
        await release(jobId, leaseId);
      },
    );

    await check(
      'a second claim answers idle while the operation is leased',
      async () => {
        const { jobId, leaseId } = await claimed();
        const second = await claim(jobId, randomUUID(), leaseId);
        assert.equal(second.outcome, 'idle');
        assert.equal((await opRow(jobId, 1)).poll_count, 1);
        await release(jobId, leaseId);
      },
    );

    await check(
      'a release keeps the operation lease so the next poll waits it out',
      async () => {
        const { jobId, leaseId } = await claimed();
        assert.equal(await release(jobId, leaseId), true);
        const row = await opRow(jobId, 1);
        assert.ok(
          row.poll_lease_expires_at > new Date(Date.now() + 110_000),
          'An unanswered GET keeps its 120 s lease.',
        );
        const next = await dueFor(jobId);
        assert.equal(
          (await claim(jobId, randomUUID(), next.leaseId)).outcome,
          'idle',
          'The next run sends no second GET inside the lease.',
        );
      },
    );

    await check(
      'a pending observation keeps the operation issued and waits 15 s',
      async () => {
        const { jobId, attempt, leaseId } = await claimed();
        const answer = await settledIn(jobId, attempt, leaseId, [
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
        await release(jobId, leaseId);
      },
    );

    await check('the second non-terminal observation waits 30 s', async () => {
      const { jobId, attempt, leaseId } = await claimed();
      await settledIn(jobId, attempt, leaseId, [
        { operationNumber: 1, outcome: 'pending', commandState: 'sent' },
      ]);
      await dueNow(jobId);
      const second = await claim(jobId, randomUUID(), leaseId);
      assert.equal(second.outcome, 'claimed');
      await settledIn(jobId, second.attempt, leaseId, [
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
      await release(jobId, leaseId);
    });

    await check(
      'a succeeded observation settles the operation and completes the job',
      async () => {
        const executedAt = new Date().toISOString();
        const { jobId, attempt, leaseId } = await claimed();
        const answer = await settledIn(jobId, attempt, leaseId, [
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

    await check(
      'a poll answer with no HTTP status stores null, and a refusal keeps its status (D1)',
      async () => {
        // A transport failure reports status 0, and the stored value stays an HTTP status or null.
        const pending = await claimed();
        await settledIn(pending.jobId, pending.attempt, pending.leaseId, [
          {
            operationNumber: 1,
            outcome: 'pending',
            commandState: 'sent',
            googleStatus: 0,
          },
        ]);
        assert.equal((await opRow(pending.jobId, 1)).google_status, null);
        // A 404 answer is a real HTTP status and keeps it.
        const refused = await claimed();
        await settledIn(refused.jobId, refused.attempt, refused.leaseId, [
          {
            operationNumber: 1,
            outcome: 'unknown',
            outcomeReason: 'command-not-found',
            googleStatus: 404,
          },
        ]);
        assert.equal((await opRow(refused.jobId, 1)).google_status, 404);
      },
    );

    await check('an expired observation fails the job', async () => {
      const { jobId, attempt, leaseId } = await claimed();
      const answer = await settledIn(jobId, attempt, leaseId, [
        { operationNumber: 1, outcome: 'expired', googleStatus: 200 },
      ]);
      assert.equal(answer.status, 'failed');
      const job = await jobRow(jobId);
      assert.equal(job.expired, 1);
      assert.equal(job.status, 'failed');
    });

    await check('one success and one expiry complete with errors', async () => {
      const { jobId, attempt, leaseId, answer } = await claimed({
        devices: ['cmd-poll-a', 'cmd-poll-b'],
      });
      assert.equal(answer.operations.length, 2);
      const settled = await settledIn(jobId, attempt, leaseId, [
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
        const leaseId = (await dueFor(jobId)).leaseId;
        const answer = await claim(jobId, randomUUID(), leaseId);
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
        const { jobId, attempt, leaseId } = await claimed();
        await admin(
          "UPDATE cc.device_update_jobs SET poll_lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [jobId],
        );
        const answer = await settle(jobId, attempt, leaseId, [
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
        const { jobId, leaseId } = await claimed();
        const answer = await settle(jobId, randomUUID(), leaseId, [
          { operationNumber: 1, outcome: 'succeeded', googleStatus: 200 },
        ]);
        assert.equal(answer.outcome, 'settled');
        assert.deepEqual(answer.settled, []);
        assert.equal((await opRow(jobId, 1)).status, 'issued');
        await release(jobId, leaseId);
      },
    );

    await check(
      'a poll result outside the domain is rejected before any change',
      async () => {
        const { jobId, attempt, leaseId } = await claimed();
        await assert.rejects(
          settle(jobId, attempt, leaseId, [
            { operationNumber: 1, outcome: 'pending' },
          ]),
          (error) => error.code === '22023',
          'pending without a command state is invalid',
        );
        await assert.rejects(
          settle(jobId, attempt, leaseId, [
            { operationNumber: 1, outcome: 'finished' },
          ]),
          (error) => error.code === '22023',
        );
        assert.equal((await opRow(jobId, 1)).status, 'issued');
        await release(jobId, leaseId);
      },
    );

    await check(
      'a poll without a usable connection answers unavailable and keeps the operation',
      async () => {
        const jobId = await makeJob();
        const leaseId = (await dueFor(jobId)).leaseId;
        await migrator.query(
          'UPDATE cc.google_connection SET active=false WHERE customer_id=$1',
          [customer],
        );
        try {
          const answer = await claim(jobId, randomUUID(), leaseId);
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
        await release(jobId, leaseId);
      },
    );

    await check(
      'the deadline settles an operation while the connection is unusable',
      async () => {
        const jobId = await makeJob({ deadline: '-1 second' });
        const leaseId = (await dueFor(jobId)).leaseId;
        await migrator.query(
          'UPDATE cc.google_connection SET active=false WHERE customer_id=$1',
          [customer],
        );
        try {
          const answer = await claim(jobId, randomUUID(), leaseId);
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
      const { jobId, leaseId } = await claimed();
      await admin(
        "UPDATE cc.jobs SET status='completed',finished_at=clock_timestamp() WHERE job_id=$1",
        [jobId],
      );
      const answer = await claim(jobId, randomUUID(), leaseId);
      assert.equal(answer.outcome, 'not-held');
      assert.equal(answer.status, 'completed');
    });

    // R4: the lease identity fences a delayed flow of a previous lease.
    await check(
      'a replaced lease cannot record, claim, settle, or release its replacement (R4)',
      async () => {
        const jobId = await makeJob();
        const first = await dueFor(jobId);
        assert.equal(
          await recordStart(jobId, first.leaseId, 'kestra-execution-old'),
          true,
        );
        await admin(
          "UPDATE cc.device_update_jobs SET poll_lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [jobId],
        );
        const second = await dueFor(jobId);
        assert.notEqual(second.leaseId, first.leaseId);
        assert.equal(
          await recordStart(jobId, second.leaseId, 'kestra-execution-new'),
          true,
        );
        // The delayed record of the previous owner changes nothing.
        assert.equal(
          await recordStart(jobId, first.leaseId, 'kestra-execution-stale'),
          false,
        );
        assert.equal(
          (await leaseRow(jobId)).poll_execution_id,
          'kestra-execution-new',
        );
        // The previous owner holds no claim and settles nothing.
        assert.equal(
          (await claim(jobId, randomUUID(), first.leaseId)).outcome,
          'not-held',
        );
        const attempt = randomUUID();
        assert.equal(
          (await claim(jobId, attempt, second.leaseId)).outcome,
          'claimed',
        );
        const stale = await settle(jobId, attempt, first.leaseId, [
          { operationNumber: 1, outcome: 'succeeded', googleStatus: 200 },
        ]);
        assert.equal(stale.outcome, 'fenced');
        assert.equal((await opRow(jobId, 1)).status, 'issued');
        // The delayed release leaves the replacement lease live.
        assert.equal(await release(jobId, first.leaseId), false);
        const row = await leaseRow(jobId);
        assert.equal(row.poll_lease_id, second.leaseId);
        assert.ok(row.poll_lease_expires_at > new Date(Date.now() + 500_000));
        // The valid owner control settles the operation and completes the job.
        const done = await settledIn(jobId, attempt, second.leaseId, [
          { operationNumber: 1, outcome: 'succeeded', googleStatus: 200 },
        ]);
        assert.equal(done.jobStatusChanged, true);
      },
    );

    // R1: a JSON null or missing provider expiry keeps the finite deadline.
    await check(
      'a null or missing provider expiry keeps the command deadline (R1)',
      async () => {
        const { jobId, attempt, leaseId } = await claimed();
        const before = await opRow(jobId, 1);
        assert.ok(
          before.poll_deadline_at,
          'The issue sets the seven-day deadline.',
        );
        const explicitNull = await settledIn(jobId, attempt, leaseId, [
          {
            operationNumber: 1,
            outcome: 'pending',
            commandState: 'sent',
            commandExpiresAt: null,
          },
        ]);
        assert.equal(explicitNull.jobStatusChanged, false);
        let row = await opRow(jobId, 1);
        assert.equal(row.command_expires_at, null);
        assert.equal(
          row.poll_deadline_at.toISOString(),
          before.poll_deadline_at.toISOString(),
          'An explicit null expiry keeps the deadline.',
        );
        // A missing key takes the same path.
        await dueNow(jobId);
        const second = await claim(jobId, randomUUID(), leaseId);
        assert.equal(second.outcome, 'claimed');
        await settledIn(jobId, second.attempt, leaseId, [
          {
            operationNumber: 1,
            outcome: 'pending',
            commandState: 'acknowledged',
          },
        ]);
        row = await opRow(jobId, 1);
        assert.equal(
          row.poll_deadline_at.toISOString(),
          before.poll_deadline_at.toISOString(),
          'A missing expiry keeps the deadline.',
        );
        // A later valid expiry stores the provider time and moves the deadline once.
        await dueNow(jobId);
        const third = await claim(jobId, randomUUID(), leaseId);
        assert.equal(third.outcome, 'claimed');
        await settledIn(jobId, third.attempt, leaseId, [
          {
            operationNumber: 1,
            outcome: 'pending',
            commandState: 'sent',
            commandExpiresAt: expiry,
          },
        ]);
        row = await opRow(jobId, 1);
        assert.equal(
          row.command_expires_at.toISOString(),
          new Date(expiry).toISOString(),
        );
        assert.equal(
          row.poll_deadline_at.toISOString(),
          new Date(new Date(expiry).getTime() + 86_400_000).toISOString(),
        );
        // The kept deadline still settles the operation when it passes.
        await admin(
          "UPDATE cc.device_update_operations SET poll_deadline_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [jobId],
        );
        const answer = await claim(jobId, randomUUID(), leaseId);
        assert.equal(answer.outcome, 'completed');
        assert.equal(answer.status, 'needs-review');
        row = await opRow(jobId, 1);
        assert.equal(row.status, 'unknown');
        assert.equal(row.outcome_reason, 'not-observed');
      },
    );

    // R2: the privileged functions are private and the runtime holds only the entry points.
    await check(
      'the six privileged command functions keep PUBLIC out and grant the runtime entry points (R2)',
      async () => {
        const functions = [
          ['complete_device_command_job(uuid,timestamptz)', false],
          ['due_device_command_polls(text)', true],
          ['record_device_command_poll_start(text,uuid,uuid,text)', true],
          ['release_device_command_poll(text,uuid,uuid)', true],
          ['claim_device_command_polls(text,uuid,uuid,uuid)', true],
          [
            'settle_device_command_polls(text,uuid,uuid,uuid,jsonb,timestamptz)',
            true,
          ],
        ];
        for (const [signature, granted] of functions) {
          const row = await adminRow(
            `SELECT bool_and(p.prosecdef) AS prosecdef,
              COALESCE(bool_or(a.grantee=0),false) AS public_grant,
              COALESCE(bool_or(a.grantee=(SELECT oid FROM pg_roles WHERE rolname='cc-app')),false) AS app_grant
             FROM pg_proc p LEFT JOIN aclexplode(p.proacl) a ON true
             WHERE p.oid=to_regprocedure('cc.${signature}')`,
          );
          assert.ok(row, `${signature} exists.`);
          assert.equal(
            row.prosecdef,
            true,
            `${signature} is SECURITY DEFINER.`,
          );
          assert.equal(
            row.public_grant,
            false,
            `${signature} grants PUBLIC EXECUTE.`,
          );
          assert.equal(row.app_grant, granted, `${signature} runtime grant`);
        }
        const delay = await adminRow(
          `SELECT COALESCE(bool_or(a.grantee=0),false) AS public_grant
           FROM pg_proc p LEFT JOIN aclexplode(p.proacl) a ON true
           WHERE p.oid=to_regprocedure('cc.device_command_poll_delay(integer)')`,
        );
        assert.equal(
          delay.public_grant,
          false,
          'The delay function grants PUBLIC EXECUTE.',
        );
        const helper = await adminRow(
          `SELECT has_function_privilege('cc-app','cc.complete_device_command_job(uuid,timestamptz)','EXECUTE') AS granted`,
        );
        assert.equal(
          helper.granted,
          false,
          'The completion helper stays private to its definer.',
        );
      },
    );

    // R2: a schema user with no function grant is denied by the database, not by the caller.
    await check(
      'a schema user without a function grant cannot call the privileged command functions (R2)',
      async () => {
        const name = `cc-schema-${randomUUID().slice(0, 8)}`;
        const adminSession = await connect('postgres', 'cc-app');
        let outsider;
        try {
          await adminSession.query(
            `CREATE ROLE "${name}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
          );
          await adminSession.query(
            `GRANT CONNECT ON DATABASE "cc-app" TO "${name}"`,
          );
          await adminSession.query(`GRANT USAGE ON SCHEMA cc TO "${name}"`);
          outsider = await connect(name, 'cc-app');
          await assert.rejects(
            outsider.query('SELECT cc.due_device_command_polls($1)', [
              customer,
            ]),
            (error) => error.code === '42501',
            'The due call needs EXECUTE.',
          );
          await assert.rejects(
            outsider.query(
              'SELECT cc.claim_device_command_polls($1,$2,$3,$4)',
              [customer, randomUUID(), randomUUID(), randomUUID()],
            ),
            (error) => error.code === '42501',
            'The claim would return the credential envelope.',
          );
          for (const signature of [
            'record_device_command_poll_start(text,uuid,uuid,text)',
            'release_device_command_poll(text,uuid,uuid)',
            'settle_device_command_polls(text,uuid,uuid,uuid,jsonb,timestamptz)',
            'complete_device_command_job(uuid,timestamptz)',
            'device_command_poll_delay(integer)',
          ]) {
            const { rows } = await outsider.query(
              `SELECT has_function_privilege(current_user,'cc.${signature}','EXECUTE') AS granted`,
            );
            assert.equal(
              rows[0].granted,
              false,
              `${signature} must not be executable.`,
            );
          }
        } finally {
          if (outsider !== undefined) await close(outsider);
          await adminSession
            .query(`DROP ROLE IF EXISTS "${name}"`)
            .catch(() => undefined);
          await close(adminSession);
        }
      },
    );
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
