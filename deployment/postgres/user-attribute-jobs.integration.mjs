import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * K24: the value job of document B sections 7.2, 7.3, 7.4, 8.4, 9, and 13. The checks drive the
 * admission under the one write slot (E8), the claim, every settlement outcome, the 30-second
 * read-back fence, the user row and the drafted 404 text, the cancel, the recovery, and the attempt
 * lease through the runtime role.
 */
export async function qualifyUserAttributeJobs({ runtime, migrator, issuer }) {
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const generation = connection.generation;
  const originalActive = connection.active;
  await migrator.query('UPDATE cc.google_connection SET active=true');
  // The claim answers the sealed credential. An earlier check may leave the envelope null (011), so
  // this suite seals an example envelope and restores the stored value in its cleanup.
  const stored = (
    await migrator.query('SELECT * FROM cc.google_credentials WHERE id=$1', [
      connection.credential_id,
    ])
  ).rows[0];
  const originalEnvelope = stored.envelope;
  if (originalEnvelope === null)
    await migrator.query(
      'UPDATE cc.google_credentials SET envelope=$2 WHERE id=$1',
      [
        connection.credential_id,
        {
          format: 1,
          keyId: 'k24-key-1',
          iv: 'a'.repeat(16),
          tag: 'a'.repeat(22),
          ciphertext: 'k24-example-ciphertext',
        },
      ],
    );
  const principals = [];
  const results = [];
  const failures = [];
  const check = async (name, body) => {
    try {
      // End every job a failed check left open, so one failure never poisons the checks after it.
      await migrator.query(
        `UPDATE cc.jobs SET status='failed',failure='interrupted',finished_at=clock_timestamp()
         WHERE customer_id=$1 AND kind IN ('user-attribute-update','device-update','user-schema-change')
           AND status IN ('accepted','queued','held','running')`,
        [customer],
      );
      await body();
      results.push(`${name}: pass`);
    } catch (error) {
      failures.push(name);
      results.push(`${name}: FAIL ${error.message}`);
    }
    process.stderr.write(`check ${results.at(-1)}\n`);
  };
  const one = (text, values = []) =>
    migrator.query(text, values).then((rows) => rows.rows[0]);
  const result = (text, values = []) =>
    runtime.query(text, values).then((rows) => rows.rows[0].result);
  const principal = async (label, grants = []) => {
    const id = randomUUID();
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$4)',
      [id, issuer, `k24-${label}-${id}`, `K24 ${label}`],
    );
    for (const [action, scope] of grants)
      await migrator.query(
        'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
        [id, action, JSON.stringify(scope)],
      );
    principals.push(id);
    return id;
  };
  const district = { kind: 'district', customerId: customer };
  const manager = await principal('manager', [
    ['users:write', district],
    ['users:bulk-actions', district],
    ['jobs:manage', district],
  ]);
  const fields = [
    {
      fieldId: 'fld-homeroom',
      fieldName: 'Homeroom',
      displayName: 'Homeroom',
      fieldType: 'STRING',
      multiValued: false,
      indexed: true,
      readAccessType: 'ADMINS_AND_SELF',
      numericIndexingSpec: null,
    },
  ];
  await migrator
    .query(
      `INSERT INTO cc.user_attribute_categories(customer_id,schema_id,schema_name,display_name,
      etag,fields,read_at) VALUES($1,'schema-1','StudentInfo','Student Info','etag-1',$2,
      clock_timestamp())`,
      [customer, JSON.stringify(fields)],
    )
    .catch(() => undefined);
  const storeUser = async (userId, customSchemas = {}) => {
    await migrator.query(
      `INSERT INTO cc.users(customer_id,user_id,primary_email,org_unit_path,suspended,archived,
        two_step_enrolled,custom_schemas,last_entity_sync)
       VALUES($1,$2,$3,'/Students',false,false,false,$4,clock_timestamp()-interval '1 hour')
       ON CONFLICT(customer_id,user_id) DO UPDATE SET custom_schemas=EXCLUDED.custom_schemas,
         removed_at=NULL,last_entity_sync=clock_timestamp()-interval '1 hour'`,
      [
        customer,
        userId,
        `${userId}@example.org`,
        JSON.stringify(customSchemas),
      ],
    );
  };
  const customSchemas = async (userId) =>
    (await one(
      'SELECT custom_schemas,removed_at FROM cc.users WHERE customer_id=$1 AND user_id=$2',
      [customer, userId],
    )) ?? {};
  /**
   * One preview and its job, as `cc.confirm_user_attribute_preview` writes them. Each entry names one
   * user and its requested values, and the preview carries one Set value change.
   */
  const makeJob = async ({
    users,
    source = 'edit-list',
    schemaName = 'StudentInfo',
    fieldName = 'Homeroom',
    mode = 'set',
    values = ['A'],
  }) => {
    const previewId = randomUUID();
    await migrator.query(
      `INSERT INTO cc.user_attribute_previews(preview_id,customer_id,created_by,
        permission_version,generation,source,selection,selected,eligible,unchanged,conflicts,
        attribute_changes,prepared_at,expires_at)
       VALUES($1,$2,$3,1,$4,$5,$6,$7,$7,0,0,$8,clock_timestamp(),clock_timestamp()+interval '15 minutes')`,
      [
        previewId,
        customer,
        manager,
        generation,
        source,
        source === 'selection'
          ? JSON.stringify({ grid: 'users', tab: 'custom' })
          : null,
        users.length,
        users.length,
      ],
    );
    await migrator.query(
      `INSERT INTO cc.user_attribute_preview_changes(preview_id,ordinal,schema_name,field_name,
        mode,values) VALUES($1,0,$2,$3,$4,$5)`,
      [previewId, schemaName, fieldName, mode, JSON.stringify(values)],
    );
    for (const [index, user] of users.entries()) {
      await migrator.query(
        `INSERT INTO cc.user_attribute_preview_targets(preview_id,ordinal,user_id,primary_email,
          disposition,observed_at) VALUES($1,$2,$3,$4,'eligible',clock_timestamp())`,
        [previewId, index, user.userId, `${user.userId}@example.org`],
      );
      await storeUser(user.userId);
      await migrator.query(
        `INSERT INTO cc.user_attribute_target_values(preview_id,ordinal,schema_name,field_name,
          current_value,requested_value,disposition) VALUES($1,$2,$3,$4,$5,$6,'eligible')`,
        [
          previewId,
          index,
          schemaName,
          fieldName,
          user.current === undefined || user.current === null
            ? null
            : JSON.stringify(user.current),
          user.requested === undefined || user.requested === null
            ? null
            : JSON.stringify(user.requested),
        ],
      );
    }
    const jobId = randomUUID();
    const number = (await one("SELECT nextval('cc.job_number_uat') AS number"))
      .number;
    const row = (
      await migrator.query(
        `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,entity_type,status,
          requested_by,generation,target_count,correlation_id)
         VALUES($1,cc.job_display_id('UAT',$2),$3,'user-attribute-update','devices','user','accepted',
           $4,$5,$6,$7)
         RETURNING display_id`,
        [
          jobId,
          number,
          customer,
          manager,
          generation,
          users.length,
          randomUUID(),
        ],
      )
    ).rows[0];
    await migrator.query(
      `INSERT INTO cc.user_attribute_update_jobs(job_id,preview_id,confirmed_by,
        confirmer_permission_version) VALUES($1,$2,$3,1)`,
      [jobId, previewId, manager],
    );
    return { jobId, previewId, displayId: row.display_id };
  };
  const admit = (held = false) =>
    result('SELECT cc.admit_device_update_job($1,$2) AS result', [
      customer,
      held,
    ]);
  const header = async (jobId) =>
    (await one(
      'SELECT j.*,u.dispatch_token,u.dispatch_count,u.attempt FROM cc.jobs j LEFT JOIN cc.user_attribute_update_jobs u USING(job_id) WHERE j.job_id=$1',
      [jobId],
    )) ?? {};
  const claim = (jobId, token, attempt = randomUUID(), limit = 250) =>
    result('SELECT cc.claim_user_attribute_updates($1,$2,$3,$4,$5) AS result', [
      customer,
      jobId,
      token,
      attempt,
      limit,
    ]);
  const settle = (
    jobId,
    token,
    attempt,
    outcomes,
    observedAt,
    failure = null,
  ) =>
    result(
      'SELECT cc.settle_user_attribute_updates($1,$2,$3,$4,$5,$6,$7) AS result',
      [
        customer,
        jobId,
        token,
        attempt,
        JSON.stringify(outcomes),
        observedAt,
        failure,
      ],
    );
  const finish = (jobId, token, attempt, failure = null) =>
    result('SELECT cc.finish_user_attribute_job($1,$2,$3,$4,$5) AS result', [
      customer,
      jobId,
      token,
      attempt,
      failure,
    ]);
  const target = (previewId, ordinal = 0) =>
    one(
      'SELECT * FROM cc.user_attribute_preview_targets WHERE preview_id=$1 AND ordinal=$2',
      [previewId, ordinal],
    );
  const admitted = async (options) => {
    await migrator.query(
      `UPDATE cc.jobs SET status='completed',finished_at=clock_timestamp()
       WHERE customer_id=$1 AND kind='user-attribute-update' AND status='running'`,
      [customer],
    );
    const job = await makeJob(options);
    const admission = await admit();
    assert.equal(admission.jobId, job.jobId);
    return { ...job, token: admission.dispatchToken };
  };
  const won = (result, kind) => {
    const answer = {
      ordinal: result.ordinal,
      outcome: kind,
      failure: kind === 'unknown' ? 'invalid-response' : null,
      reason: null,
      googleStatus: 200,
      googleReason: null,
      verifiedBy: kind === 'succeeded' ? 'write-response' : null,
      observed: { StudentInfo: { Homeroom: 'A' } },
    };
    return answer;
  };
  /** Every eligible target of one preview, in ordinal order. */
  const targets = async (previewId) =>
    (
      await migrator.query(
        'SELECT * FROM cc.user_attribute_preview_targets WHERE preview_id=$1 ORDER BY ordinal',
        [previewId],
      )
    ).rows;
  /** One recovery run of the customer (B section 7.4). */
  const recover = () =>
    result('SELECT cc.recover_user_attribute_jobs($1) AS result', [customer]);
  /** Move the startup window of a job into the past, so its next recovery may dispatch. */
  const expireStart = (jobId) =>
    migrator.query(
      `UPDATE cc.user_attribute_update_jobs SET start_deadline_at=clock_timestamp()-interval '1 second'
       WHERE job_id=$1`,
      [jobId],
    );
  /** Move the attempt lease of a job into the past, so its recovery may take over. */
  const expireAttempt = (jobId) =>
    migrator.query(
      `UPDATE cc.user_attribute_update_jobs SET attempt_expires_at=clock_timestamp()-interval '1 second'
       WHERE job_id=$1`,
      [jobId],
    );
  /** Move the read-back fence of one target into the past, so the next claim reads it. */
  const expireReadBack = (previewId, ordinal = 0) =>
    migrator.query(
      `UPDATE cc.user_attribute_preview_targets SET verify_after=clock_timestamp()-interval '1 second'
       WHERE preview_id=$1 AND ordinal=$2`,
      [previewId, ordinal],
    );

  try {
    await check(
      'K24 a value job admits under the write slot and holds it',
      async () => {
        const job = await makeJob({
          users: [{ userId: 'k24-slot-1', requested: 'A' }],
        });
        const admission = await admit();
        assert.equal(admission.jobId, job.jobId);
        assert.equal(admission.kind, 'user-attribute-update');
        assert.match(admission.dispatchToken, /^[0-9a-f-]{36}$/);
        assert.equal((await header(job.jobId)).status, 'running');
        // A device candidate keeps the queue while the value job runs (E8).
        const deviceJobId = randomUUID();
        await migrator.query(
          `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,
            generation,target_count,correlation_id)
           VALUES($1,'UPD-9401',$2,'device-update','devices','accepted',$3,$4,1,$5)`,
          [deviceJobId, customer, manager, generation, randomUUID()],
        );
        assert.equal(await admit(), null);
        assert.equal((await header(deviceJobId)).status, 'queued');
        await migrator.query('DELETE FROM cc.jobs WHERE job_id=$1', [
          deviceJobId,
        ]);
        // The value job ends, so the slot frees. A running device job then blocks the next value job.
        await migrator.query(
          `UPDATE cc.jobs SET status='completed',finished_at=clock_timestamp() WHERE job_id=$1`,
          [job.jobId],
        );
        const second = await makeJob({
          users: [{ userId: 'k24-slot-2', requested: 'A' }],
        });
        const running = randomUUID();
        await migrator.query(
          `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,
            generation,target_count,correlation_id)
           VALUES($1,'UPD-9403',$2,'device-update','devices','running',$3,$4,1,$5)`,
          [running, customer, manager, generation, randomUUID()],
        );
        assert.equal(await admit(), null);
        assert.equal((await header(second.jobId)).status, 'queued');
        await migrator.query('DELETE FROM cc.jobs WHERE job_id=$1', [running]);
        await migrator.query(
          `UPDATE cc.jobs SET status='failed',failure='interrupted',finished_at=clock_timestamp()
           WHERE job_id=$1`,
          [second.jobId],
        );
      },
    );

    await check(
      'K24 the claim answers the eligible users and their final values',
      async () => {
        const job = await admitted({
          users: [
            { userId: 'k24-claim-1', current: 'B', requested: 'A' },
            { userId: 'k24-claim-2', current: null, requested: 'C' },
          ],
        });
        const attempt = randomUUID();
        const answer = await claim(job.jobId, job.token, attempt, 1);
        assert.equal(answer.outcome, 'claimed', JSON.stringify(answer));
        assert.equal(answer.users.length, 1);
        assert.equal(answer.users[0].userId, 'k24-claim-1');
        assert.deepEqual(answer.users[0].customSchemas, {
          StudentInfo: { Homeroom: 'A' },
        });
        assert.equal(answer.remaining, true);
        assert.deepEqual(answer.mask, ['StudentInfo']);
        assert.deepEqual(answer.fields, [
          {
            schemaName: 'StudentInfo',
            fieldName: 'Homeroom',
            fieldType: 'STRING',
            multiValued: false,
          },
        ]);
        // The second envelope of the same attempt answers the remaining user, in ordinal order.
        const next = await claim(job.jobId, job.token, attempt);
        assert.equal(next.users[0].userId, 'k24-claim-2');
        assert.equal(next.remaining, false);
        // A clear keeps the attribute with a JSON null value, so the write leaves as users.update.
        const clear = await admitted({
          users: [{ userId: 'k24-claim-3', current: 'A', requested: null }],
          mode: 'clear',
          values: [],
        });
        const cleared = await claim(clear.jobId, clear.token);
        assert.equal(cleared.outcome, 'claimed', JSON.stringify(cleared));
        assert.deepEqual(cleared.users[0].customSchemas, {
          StudentInfo: { Homeroom: null },
        });
        await migrator.query(
          `UPDATE cc.jobs SET status='failed',failure='interrupted',finished_at=clock_timestamp()
           WHERE job_id=$1`,
          [clear.jobId],
        );
      },
    );

    await check(
      'K24 the claim fences a foreign token and a live attempt is busy',
      async () => {
        const job = await admitted({
          users: [{ userId: 'k24-fence-1', requested: 'A' }],
        });
        const attempt = randomUUID();
        const answer = await claim(job.jobId, job.token, attempt);
        assert.equal(answer.outcome, 'claimed');
        // Another attempt inside the live lease changes nothing.
        assert.equal(
          (await claim(job.jobId, job.token, randomUUID())).outcome,
          'busy',
        );
        // A superseded dispatch token is fenced.
        assert.equal(
          (await claim(job.jobId, randomUUID(), attempt)).outcome,
          'fenced',
        );
        // The send gate answers `writing` for the owner and `fenced` for another attempt.
        const begin = (value) =>
          result(
            'SELECT cc.begin_user_attribute_write($1,$2,$3,$4) AS result',
            [customer, job.jobId, job.token, value],
          );
        assert.equal((await begin(attempt)).outcome, 'writing');
        assert.equal((await begin(randomUUID())).outcome, 'fenced');
      },
    );

    await check(
      'K24 a successful settlement writes the user row and completes the job',
      async () => {
        const job = await admitted({
          users: [{ userId: 'k24-won-1', current: 'B', requested: 'A' }],
        });
        const attempt = randomUUID();
        const claimed = await claim(job.jobId, job.token, attempt);
        const settled = await settle(
          job.jobId,
          job.token,
          attempt,
          [won({ ordinal: 0 }, 'succeeded')],
          new Date().toISOString(),
        );
        assert.equal(settled.outcome, 'settled', JSON.stringify(settled));
        assert.deepEqual(
          settled.changed,
          ['k24-won-1'],
          JSON.stringify(settled),
        );
        assert.deepEqual(settled.removed, []);
        assert.equal((await target(job.previewId)).outcome, 'succeeded');
        assert.equal(
          (await target(job.previewId)).verified_by,
          'write-response',
        );
        assert.deepEqual((await customSchemas('k24-won-1')).custom_schemas, {
          StudentInfo: { Homeroom: 'A' },
        });
        assert.equal(claimed.users.length, 1);
        const done = await finish(job.jobId, job.token, attempt);
        assert.equal(done.outcome, 'finished');
        assert.equal(done.status, 'completed');
      },
    );

    await check(
      'K24 an unknown settlement schedules the read-back no earlier than 30 seconds',
      async () => {
        const job = await admitted({
          users: [{ userId: 'k24-unknown-1', current: 'A', requested: 'B' }],
        });
        const attempt = randomUUID();
        await claim(job.jobId, job.token, attempt);
        const answered = new Date();
        await settle(
          job.jobId,
          job.token,
          attempt,
          [won({ ordinal: 0 }, 'unknown')],
          answered.toISOString(),
        );
        const row = await target(job.previewId);
        assert.equal(row.outcome, 'unknown');
        const wait = (new Date(row.verify_after) - answered) / 1000;
        assert.ok(
          wait >= 30,
          `the read-back waits ${wait} seconds instead of 30 or more`,
        );
        // The read-back claim answers nothing inside the window and names the wait.
        const early = await result(
          'SELECT cc.claim_user_attribute_verification($1,$2,$3,$4,$5) AS result',
          [customer, job.jobId, attempt, null, 250],
        );
        assert.equal(early.outcome, 'claimed');
        assert.equal(early.users.length, 0);
        assert.equal(early.remaining, 1);
        assert.ok(early.waitMilliseconds > 0);
        await migrator.query(
          `UPDATE cc.jobs SET status='needs-review',finished_at=clock_timestamp() WHERE job_id=$1`,
          [job.jobId],
        );
      },
    );

    await check(
      'K24 a not-found settlement removes the user and stores the drafted reason',
      async () => {
        const job = await admitted({
          users: [{ userId: 'k24-missing-1', current: 'A', requested: 'B' }],
        });
        const attempt = randomUUID();
        await claim(job.jobId, job.token, attempt);
        const settled = await settle(
          job.jobId,
          job.token,
          attempt,
          [
            {
              ordinal: 0,
              outcome: 'failed',
              failure: 'not-found',
              reason: 'Google could not find this user.',
              googleStatus: 404,
              googleReason: 'notFound',
              verifiedBy: null,
              observed: null,
            },
          ],
          new Date().toISOString(),
        );
        assert.deepEqual(
          settled.removed,
          ['k24-missing-1'],
          JSON.stringify(settled),
        );
        const row = await target(job.previewId);
        assert.equal(row.outcome, 'failed');
        assert.equal(row.failure, 'not-found');
        assert.equal(row.outcome_reason, 'Google could not find this user.');
        assert.equal(row.google_status, 404);
        assert.notEqual(
          (await customSchemas('k24-missing-1')).removed_at,
          null,
        );
        await finish(job.jobId, job.token, attempt);
      },
    );

    await check(
      'K24 the reconcile claim reads one operation and settles it succeeded',
      async () => {
        const job = await admitted({
          users: [{ userId: 'k24-read-1', current: 'A', requested: 'B' }],
        });
        const attempt = randomUUID();
        await claim(job.jobId, job.token, attempt);
        await settle(
          job.jobId,
          job.token,
          attempt,
          [won({ ordinal: 0 }, 'unknown')],
          new Date().toISOString(),
        );
        // The route waits for the 30-second window, so this check moves the fence into the past.
        await migrator.query(
          `UPDATE cc.user_attribute_preview_targets SET verify_after=clock_timestamp()-interval '1 second'
           WHERE preview_id=$1 AND ordinal=0`,
          [job.previewId],
        );
        const claimOne = (value) =>
          result(
            'SELECT cc.claim_user_attribute_verification_one($1,$2,$3,$4) AS result',
            [customer, job.jobId, value, 1],
          );
        const verify = randomUUID();
        assert.equal((await claimOne(verify)).outcome, 'claimed');
        // A second caller inside the lease changes nothing.
        assert.equal((await claimOne(randomUUID())).outcome, 'busy');
        const read = await result(
          'SELECT cc.read_user_attribute_verification($1,$2,$3,$4) AS result',
          [customer, job.jobId, verify, 1],
        );
        assert.equal(read.outcome, 'read');
        assert.equal(read.user.userId, 'k24-read-1');
        assert.deepEqual(read.mask, ['StudentInfo']);
        const settled = await result(
          'SELECT cc.settle_user_attribute_verification($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result',
          [
            customer,
            job.jobId,
            verify,
            0,
            'succeeded',
            null,
            null,
            200,
            null,
            JSON.stringify({ StudentInfo: { Homeroom: 'B' } }),
            new Date().toISOString(),
          ],
        );
        assert.equal(settled.outcome, 'settled', JSON.stringify(settled));
        assert.equal(settled.outcomeOf, 'succeeded', JSON.stringify(settled));
        assert.deepEqual((await customSchemas('k24-read-1')).custom_schemas, {
          StudentInfo: { Homeroom: 'B' },
        });
        assert.equal(
          (await finish(job.jobId, job.token, attempt)).status,
          'completed',
        );
      },
    );

    await check(
      'K24 a read-back that proves nothing keeps the operation unknown',
      async () => {
        const job = await admitted({
          users: [{ userId: 'k24-unproven-1', current: 'A', requested: 'B' }],
        });
        const attempt = randomUUID();
        await claim(job.jobId, job.token, attempt);
        await settle(
          job.jobId,
          job.token,
          attempt,
          [won({ ordinal: 0 }, 'unknown')],
          new Date().toISOString(),
        );
        await migrator.query(
          `UPDATE cc.user_attribute_preview_targets SET verify_after=clock_timestamp()-interval '1 second'
           WHERE preview_id=$1 AND ordinal=0`,
          [job.previewId],
        );
        const verify = randomUUID();
        await result(
          'SELECT cc.claim_user_attribute_verification_one($1,$2,$3,$4) AS result',
          [customer, job.jobId, verify, 1],
        );
        const settled = await result(
          'SELECT cc.settle_user_attribute_verification($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result',
          [
            customer,
            job.jobId,
            verify,
            0,
            'unknown',
            'invalid-response',
            null,
            400,
            'invalid',
            null,
            new Date().toISOString(),
          ],
        );
        assert.equal(settled.outcomeOf, 'unknown');
        const row = await target(job.previewId);
        assert.equal(row.outcome, 'unknown');
        assert.equal(row.verify_attempt, null);
        assert.equal(row.google_status, 400);
        // A job with an Unknown operation ends Needs review, never completed (C11).
        const done = await finish(job.jobId, job.token, attempt);
        assert.equal(done.status, 'needs-review');
      },
    );

    await check(
      'K24 the cancel request ends a running value job and cancels its users',
      async () => {
        const job = await admitted({
          users: [
            { userId: 'k24-cancel-1', requested: 'A' },
            { userId: 'k24-cancel-2', requested: 'A' },
          ],
        });
        const attempt = randomUUID();
        await claim(job.jobId, job.token, attempt, 1);
        // The first envelope leaves through the send gate, so the request cannot end the job at
        // once (B section 7.4).
        const gate = await result(
          'SELECT cc.begin_user_attribute_write($1,$2,$3,$4) AS result',
          [customer, job.jobId, job.token, attempt],
        );
        assert.equal(gate.outcome, 'writing', JSON.stringify(gate));
        const cancelled = await result(
          'SELECT cc.request_job_cancel($1,$2,$3,$4,$5) AS result',
          [manager, 1, customer, job.displayId, randomUUID()],
        );
        assert.equal(cancelled.outcome, 'requested', JSON.stringify(cancelled));
        const requested = await header(job.jobId);
        assert.notEqual(
          requested.cancel_requested_at,
          null,
          JSON.stringify(requested),
        );
        // The send gate refuses the next envelope once the cancel request landed (B section 7.4).
        assert.equal(requested.status, 'running', JSON.stringify(requested));
        assert.equal(
          (
            await result(
              'SELECT cc.begin_user_attribute_write($1,$2,$3,$4) AS result',
              [customer, job.jobId, job.token, attempt],
            )
          ).outcome,
          'fenced',
        );
        // The claim of the next envelope ends the job and cancels the user it never wrote.
        const ended = await claim(job.jobId, job.token, attempt);
        assert.equal(ended.outcome, 'done', JSON.stringify(ended));
        assert.equal(ended.status, 'cancelled', JSON.stringify(ended));
        // B section 7.4: the user whose envelope may have left stays Unknown for the read-back, and
        // the user that never left counts cancelled.
        const written = await target(job.previewId, 0);
        assert.equal(written.outcome, 'unknown', JSON.stringify(written));
        assert.equal(written.outcome_reason, 'interrupted');
        assert.notEqual(written.verify_after, null);
        const skipped = await target(job.previewId, 1);
        assert.equal(skipped.outcome, 'cancelled', JSON.stringify(skipped));
        const endedHeader = await header(job.jobId);
        assert.equal(
          endedHeader.status,
          'cancelled',
          JSON.stringify(endedHeader),
        );
      },
    );

    await check('K24 the recovery dispatches a lost start again', async () => {
      const job = await admitted({
        users: [{ userId: 'k24-lost-1', requested: 'A' }],
      });
      await migrator.query(
        `UPDATE cc.user_attribute_update_jobs SET start_deadline_at=clock_timestamp()-interval '1 second'
           WHERE job_id=$1`,
        [job.jobId],
      );
      const recovered = await result(
        'SELECT cc.recover_user_attribute_jobs($1) AS result',
        [customer],
      );
      assert.equal(recovered.starts.length, 1, JSON.stringify(recovered));
      assert.equal(recovered.starts[0].jobId, job.jobId);
      assert.equal(recovered.starts[0].kind, 'user-attribute-update');
      assert.notEqual(recovered.starts[0].dispatchToken, job.token);
      assert.equal((await header(job.jobId)).dispatch_count, 2);
      // A lost runner after its first claim: the envelope left through the send gate, so the user
      // becomes Unknown and the read-back owns it (B section 7.3, R8).
      const attempt = randomUUID();
      await claim(job.jobId, recovered.starts[0].dispatchToken, attempt);
      const gate = await result(
        'SELECT cc.begin_user_attribute_write($1,$2,$3,$4) AS result',
        [customer, job.jobId, recovered.starts[0].dispatchToken, attempt],
      );
      assert.equal(gate.outcome, 'writing', JSON.stringify(gate));
      await migrator.query(
        `UPDATE cc.user_attribute_update_jobs SET attempt_expires_at=clock_timestamp()-interval '1 second'
           WHERE job_id=$1`,
        [job.jobId],
      );
      const again = await result(
        'SELECT cc.recover_user_attribute_jobs($1) AS result',
        [customer],
      );
      assert.equal(again.starts.length, 1);
      const row = await target(job.previewId);
      assert.equal(row.outcome, 'unknown');
      assert.equal(row.outcome_reason, 'interrupted');
      await migrator.query(
        `UPDATE cc.jobs SET status='needs-review',finished_at=clock_timestamp() WHERE job_id=$1`,
        [job.jobId],
      );
    });

    await check(
      'K24 R4 a recorded start keeps its 120-second window',
      async () => {
        const job = await admitted({
          users: [{ userId: 'k24-window-1', requested: 'A' }],
        });
        const recorded = await result(
          'SELECT cc.record_user_attribute_start($1,$2,$3,$4) AS result',
          [customer, job.jobId, job.token, 'k24-execution-1'],
        );
        assert.equal(recorded.outcome, 'recorded', JSON.stringify(recorded));
        // The window survives the receipt, so a recovery run before it expires consumes no start.
        assert.notEqual((await header(job.jobId)).start_deadline_at, null);
        assert.deepEqual((await recover()).starts, []);
        assert.deepEqual((await recover()).starts, []);
        assert.equal((await header(job.jobId)).dispatch_count, 1);
        // The second start runs after the window, and its own window holds the third.
        await expireStart(job.jobId);
        const second = await recover();
        assert.equal(second.starts.length, 1, JSON.stringify(second));
        assert.equal((await header(job.jobId)).dispatch_count, 2);
        assert.deepEqual((await recover()).starts, []);
        await expireStart(job.jobId);
        const third = await recover();
        assert.equal(third.starts.length, 1, JSON.stringify(third));
        assert.equal((await header(job.jobId)).dispatch_count, 3);
        await result(
          'SELECT cc.record_user_attribute_start($1,$2,$3,$4) AS result',
          [
            customer,
            job.jobId,
            third.starts[0].dispatchToken,
            'k24-execution-3',
          ],
        );
        assert.deepEqual((await recover()).starts, []);
        // Genuine exhaustion ends the job instead of leaving it running with no start left.
        await expireStart(job.jobId);
        assert.deepEqual((await recover()).starts, []);
        const ended = await header(job.jobId);
        assert.equal(ended.status, 'failed', JSON.stringify(ended));
        assert.equal(ended.failure, 'orchestration-unavailable');
        assert.equal((await targets(job.previewId))[0].outcome, 'skipped');
      },
    );

    await check(
      'K24 R4 a replacement start after a claim keeps its window',
      async () => {
        const job = await admitted({
          users: [{ userId: 'k24-replacement-1', requested: 'A' }],
        });
        await claim(job.jobId, job.token, randomUUID());
        await expireAttempt(job.jobId);
        const second = await recover();
        assert.equal(second.starts.length, 1, JSON.stringify(second));
        assert.equal((await header(job.jobId)).dispatch_count, 2);
        // Two immediate runs before the replacement window expires start nothing and keep the job.
        assert.deepEqual((await recover()).starts, []);
        assert.deepEqual((await recover()).starts, []);
        assert.equal((await header(job.jobId)).dispatch_count, 2);
        assert.equal((await header(job.jobId)).status, 'running');
        await expireStart(job.jobId);
        const third = await recover();
        assert.equal(third.starts.length, 1, JSON.stringify(third));
        assert.equal((await header(job.jobId)).dispatch_count, 3);
        await expireStart(job.jobId);
        assert.deepEqual((await recover()).starts, []);
        assert.equal((await header(job.jobId)).status, 'failed');
      },
    );

    await check(
      'K24 R5 a clear drops the covered category and keeps an unrelated one',
      async () => {
        const job = await admitted({
          users: [{ userId: 'k24-clear-1', current: 'old', requested: null }],
        });
        await storeUser('k24-clear-1', {
          StudentInfo: { Homeroom: 'old' },
          StaffInfo: { Title: 'keep' },
        });
        const attempt = randomUUID();
        await claim(job.jobId, job.token, attempt);
        const settled = await settle(
          job.jobId,
          job.token,
          attempt,
          [
            {
              ordinal: 0,
              outcome: 'succeeded',
              failure: null,
              reason: null,
              googleStatus: 200,
              googleReason: null,
              verifiedBy: 'write-response',
              // Google omits a category after its last value clears.
              observed: {},
            },
          ],
          new Date().toISOString(),
        );
        assert.deepEqual(
          settled.changed,
          ['k24-clear-1'],
          JSON.stringify(settled),
        );
        const cached = await customSchemas('k24-clear-1');
        assert.equal(cached.custom_schemas.StudentInfo, undefined);
        assert.equal(cached.custom_schemas.StaffInfo.Title, 'keep');
      },
    );

    await check(
      'K24 R5 the reconcile read-back drops the covered category too',
      async () => {
        const job = await admitted({
          users: [{ userId: 'k24-clear-2', current: 'old', requested: null }],
        });
        await storeUser('k24-clear-2', {
          StudentInfo: { Homeroom: 'old' },
          StaffInfo: { Title: 'keep' },
        });
        const attempt = randomUUID();
        await claim(job.jobId, job.token, attempt);
        await settle(
          job.jobId,
          job.token,
          attempt,
          [won({ ordinal: 0 }, 'unknown')],
          new Date().toISOString(),
        );
        await expireReadBack(job.previewId);
        const verify = randomUUID();
        await result(
          'SELECT cc.claim_user_attribute_verification_one($1,$2,$3,$4) AS result',
          [customer, job.jobId, verify, 1],
        );
        const settled = await result(
          'SELECT cc.settle_user_attribute_verification($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result',
          [
            customer,
            job.jobId,
            verify,
            0,
            'succeeded',
            null,
            null,
            200,
            null,
            JSON.stringify({}),
            new Date().toISOString(),
          ],
        );
        assert.equal(settled.outcomeOf, 'succeeded', JSON.stringify(settled));
        assert.deepEqual(settled.changed, ['k24-clear-2']);
        const cached = await customSchemas('k24-clear-2');
        assert.equal(cached.custom_schemas.StudentInfo, undefined);
        assert.equal(cached.custom_schemas.StaffInfo.Title, 'keep');
      },
    );

    await check(
      'K24 R6 an older settlement never overwrites a newer cached row',
      async () => {
        const job = await admitted({
          users: [{ userId: 'k24-stale-1', current: 'old', requested: 'new' }],
        });
        await storeUser('k24-stale-1', {
          StudentInfo: { Homeroom: 'newer-inventory' },
        });
        await migrator.query(
          `UPDATE cc.users SET last_entity_sync=clock_timestamp()
           WHERE customer_id=$1 AND user_id='k24-stale-1'`,
          [customer],
        );
        const attempt = randomUUID();
        await claim(job.jobId, job.token, attempt);
        const settled = await settle(
          job.jobId,
          job.token,
          attempt,
          [
            {
              ordinal: 0,
              outcome: 'succeeded',
              failure: null,
              reason: null,
              googleStatus: 200,
              googleReason: null,
              verifiedBy: 'write-response',
              observed: { StudentInfo: { Homeroom: 'older-response' } },
            },
          ],
          new Date(Date.now() - 3_600_000).toISOString(),
        );
        // The observation is older than the cached row, so it settles the user but changes no cache
        // row and publishes nothing (R6).
        assert.deepEqual(settled.changed, [], JSON.stringify(settled));
        const cached = await customSchemas('k24-stale-1');
        assert.equal(
          cached.custom_schemas.StudentInfo.Homeroom,
          'newer-inventory',
        );
      },
    );

    await check(
      'K24 R6 an older read-back never overwrites a newer cached row',
      async () => {
        const job = await admitted({
          users: [{ userId: 'k24-stale-2', current: 'old', requested: 'new' }],
        });
        await storeUser('k24-stale-2', {
          StudentInfo: { Homeroom: 'newer-inventory' },
        });
        await migrator.query(
          `UPDATE cc.users SET last_entity_sync=clock_timestamp()
           WHERE customer_id=$1 AND user_id='k24-stale-2'`,
          [customer],
        );
        const attempt = randomUUID();
        await claim(job.jobId, job.token, attempt);
        await settle(
          job.jobId,
          job.token,
          attempt,
          [won({ ordinal: 0 }, 'unknown')],
          new Date().toISOString(),
        );
        await expireReadBack(job.previewId);
        const verify = randomUUID();
        await result(
          'SELECT cc.claim_user_attribute_verification_one($1,$2,$3,$4) AS result',
          [customer, job.jobId, verify, 1],
        );
        const settled = await result(
          'SELECT cc.settle_user_attribute_verification($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result',
          [
            customer,
            job.jobId,
            verify,
            0,
            'succeeded',
            null,
            null,
            200,
            null,
            JSON.stringify({ StudentInfo: { Homeroom: 'older-response' } }),
            new Date(Date.now() - 3_600_000).toISOString(),
          ],
        );
        assert.deepEqual(settled.changed, [], JSON.stringify(settled));
        const cached = await customSchemas('k24-stale-2');
        assert.equal(
          cached.custom_schemas.StudentInfo.Homeroom,
          'newer-inventory',
        );
      },
    );

    await check('K24 R7 an expired attempt settles nothing', async () => {
      const job = await admitted({
        users: [{ userId: 'k24-expired-1', requested: 'A' }],
      });
      const attempt = randomUUID();
      await claim(job.jobId, job.token, attempt);
      await expireAttempt(job.jobId);
      const settled = await settle(
        job.jobId,
        job.token,
        attempt,
        [won({ ordinal: 0 }, 'succeeded')],
        new Date().toISOString(),
      );
      assert.equal(settled.outcome, 'fenced', JSON.stringify(settled));
      assert.equal((await target(job.previewId)).outcome, 'dispatched');
    });

    await check(
      'K24 R7 a target the attempt never claimed settles nothing',
      async () => {
        const job = await admitted({
          users: [
            { userId: 'k24-unowned-1', requested: 'A' },
            { userId: 'k24-unowned-2', requested: 'A' },
          ],
        });
        const attempt = randomUUID();
        await claim(job.jobId, job.token, attempt, 1);
        const settled = await settle(
          job.jobId,
          job.token,
          attempt,
          [won({ ordinal: 1 }, 'succeeded')],
          new Date().toISOString(),
        );
        assert.equal(settled.ignored, 1, JSON.stringify(settled));
        assert.equal((await target(job.previewId, 1)).outcome, null);
        assert.equal((await target(job.previewId, 0)).outcome, 'dispatched');
      },
    );

    await check(
      'K24 R7 an obsolete attempt cannot renew across a replacement dispatch',
      async () => {
        const job = await admitted({
          users: [{ userId: 'k24-obsolete-1', requested: 'A' }],
        });
        const attempt = randomUUID();
        await claim(job.jobId, job.token, attempt);
        await expireAttempt(job.jobId);
        const recovered = await recover();
        assert.equal(recovered.starts.length, 1, JSON.stringify(recovered));
        const extended = await result(
          'SELECT cc.extend_user_attribute_attempt($1,$2,$3,$4) AS result',
          [customer, job.jobId, job.token, attempt],
        );
        assert.equal(extended.outcome, 'fenced', JSON.stringify(extended));
        const replacement = randomUUID();
        const claimed = await claim(
          job.jobId,
          recovered.starts[0].dispatchToken,
          replacement,
        );
        assert.equal(claimed.outcome, 'claimed', JSON.stringify(claimed));
        assert.equal(claimed.users.length, 1);
      },
    );

    await check(
      'K24 R8 a cancel before the send gate cancels the unsent claim',
      async () => {
        const job = await admitted({
          users: [
            { userId: 'k24-unsent-1', requested: 'A' },
            { userId: 'k24-unsent-2', requested: 'A' },
          ],
        });
        await claim(job.jobId, job.token, randomUUID());
        const cancelled = await result(
          'SELECT cc.request_job_cancel($1,$2,$3,$4,$5) AS result',
          [manager, 1, customer, job.displayId, randomUUID()],
        );
        assert.equal(cancelled.outcome, 'requested', JSON.stringify(cancelled));
        // No envelope left the worker, so the request ends the job at once with no Unknown row.
        const ended = await header(job.jobId);
        assert.equal(ended.status, 'cancelled', JSON.stringify(ended));
        const rows = await targets(job.previewId);
        assert.deepEqual(
          rows.map((row) => row.outcome),
          ['cancelled', 'cancelled'],
        );
        assert.equal(ended.unknown, 0);
      },
    );

    await check(
      'K24 R9 a reconcile decides the terminal status of the job',
      async () => {
        const job = await admitted({
          users: [{ userId: 'k24-reconcile-1', current: 'A', requested: 'B' }],
        });
        const attempt = randomUUID();
        await claim(job.jobId, job.token, attempt);
        await settle(
          job.jobId,
          job.token,
          attempt,
          [won({ ordinal: 0 }, 'unknown')],
          new Date().toISOString(),
        );
        const done = await finish(job.jobId, job.token, attempt);
        assert.equal(done.status, 'needs-review', JSON.stringify(done));
        await expireReadBack(job.previewId);
        const verify = randomUUID();
        await result(
          'SELECT cc.claim_user_attribute_verification_one($1,$2,$3,$4) AS result',
          [customer, job.jobId, verify, 1],
        );
        const settled = await result(
          'SELECT cc.settle_user_attribute_verification($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS result',
          [
            customer,
            job.jobId,
            verify,
            0,
            'succeeded',
            null,
            null,
            200,
            null,
            JSON.stringify({ StudentInfo: { Homeroom: 'B' } }),
            new Date().toISOString(),
          ],
        );
        // The settlement itself leaves Needs review, so the caller needs no second finish (R9).
        assert.equal(settled.status, 'completed', JSON.stringify(settled));
        const ended = await header(job.jobId);
        assert.equal(ended.status, 'completed', JSON.stringify(ended));
        assert.equal(ended.unknown, 0);
        assert.equal(ended.succeeded, 1);
      },
    );

    await check(
      'K24 R3 the automatic read-back settles through the bulk functions',
      async () => {
        const job = await admitted({
          users: [{ userId: 'k24-auto-1', current: 'A', requested: 'B' }],
        });
        const attempt = randomUUID();
        await claim(job.jobId, job.token, attempt);
        await settle(
          job.jobId,
          job.token,
          attempt,
          [won({ ordinal: 0 }, 'unknown')],
          new Date().toISOString(),
        );
        await expireReadBack(job.previewId);
        const verified = await result(
          'SELECT cc.claim_user_attribute_verification($1,$2,$3,$4,$5) AS result',
          [customer, job.jobId, attempt, null, 250],
        );
        assert.equal(verified.outcome, 'claimed', JSON.stringify(verified));
        assert.deepEqual(
          verified.users.map((user) => user.userId),
          ['k24-auto-1'],
        );
        // The read-back result settles through the same settlement, because the attempt owns the
        // verification claim of that row (R7).
        const settled = await settle(
          job.jobId,
          job.token,
          attempt,
          [
            {
              ordinal: 0,
              outcome: 'succeeded',
              failure: null,
              reason: null,
              googleStatus: 200,
              googleReason: null,
              verifiedBy: 'read-back',
              observed: { StudentInfo: { Homeroom: 'B' } },
            },
          ],
          new Date().toISOString(),
        );
        assert.equal(settled.ignored, 0, JSON.stringify(settled));
        assert.deepEqual(settled.changed, ['k24-auto-1']);
        const row = await target(job.previewId);
        assert.equal(row.outcome, 'succeeded');
        assert.equal(row.verified_by, 'read-back');
        assert.equal(row.verify_attempt, null);
        assert.equal(
          (await customSchemas('k24-auto-1')).custom_schemas.StudentInfo
            .Homeroom,
          'B',
        );
      },
    );

    await check(
      'K24 R3 three automatic passes leave the operation for a person',
      async () => {
        const job = await admitted({
          users: [{ userId: 'k24-bound-1', current: 'A', requested: 'B' }],
        });
        const attempt = randomUUID();
        await claim(job.jobId, job.token, attempt);
        await settle(
          job.jobId,
          job.token,
          attempt,
          [won({ ordinal: 0 }, 'unknown')],
          new Date().toISOString(),
        );
        for (let pass = 1; pass <= 3; pass += 1) {
          await expireReadBack(job.previewId);
          const claimed = await result(
            'SELECT cc.claim_user_attribute_verification($1,$2,$3,$4,$5) AS result',
            [customer, job.jobId, attempt, null, 250],
          );
          assert.equal(claimed.users.length, 1, `pass ${pass}`);
          await settle(
            job.jobId,
            job.token,
            attempt,
            [
              {
                ordinal: 0,
                outcome: 'unknown',
                failure: 'invalid-response',
                reason: 'verification-failed',
                googleStatus: 400,
                googleReason: 'invalid',
                verifiedBy: 'read-back',
                observed: null,
              },
            ],
            new Date().toISOString(),
          );
        }
        // The fourth pass claims nothing and leaves no work, so the job finishes Needs review.
        await expireReadBack(job.previewId);
        const exhausted = await result(
          'SELECT cc.claim_user_attribute_verification($1,$2,$3,$4,$5) AS result',
          [customer, job.jobId, attempt, null, 250],
        );
        assert.equal(exhausted.outcome, 'claimed', JSON.stringify(exhausted));
        assert.equal(exhausted.users.length, 0);
        assert.equal(exhausted.remaining, 0);
        assert.equal((await target(job.previewId)).verify_count, 3);
        const done = await finish(job.jobId, job.token, attempt);
        assert.equal(done.status, 'needs-review', JSON.stringify(done));
      },
    );

    await check(
      'K24 every new function denies PUBLIC and allows the runtime role',
      async () => {
        const names = [
          'user_attribute_terminal_status',
          'refresh_user_attribute_counters',
          'user_attribute_stop_reason',
          'user_attribute_work_fields',
          'user_attribute_work_row',
          'claim_user_attribute_updates',
          'settle_user_attribute_updates',
          'finish_user_attribute_job',
          'claim_user_attribute_verification',
          'skip_user_attribute_pending',
          'recover_user_attribute_jobs',
          'claim_user_attribute_verification_one',
          'settle_user_attribute_verification',
          'record_user_attribute_start',
          'abandon_user_attribute_start',
          'read_user_attribute_verification',
          'begin_user_attribute_write',
          'extend_user_attribute_attempt',
          'stop_user_attribute_job',
        ];
        const rows = (
          await migrator.query(
            `SELECT p.oid::regprocedure::text AS signature,
              has_function_privilege($1, p.oid, 'EXECUTE') AS runtime,
              EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND
                a.privilege_type='EXECUTE') AS public
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='cc' AND p.proname=ANY($2::text[])
            ORDER BY p.proname`,
            [runtime.user, names],
          )
        ).rows;
        assert.equal(rows.length, names.length, JSON.stringify(rows));
        for (const row of rows) {
          assert.equal(row.public, false, `${row.signature} grants PUBLIC`);
          assert.equal(
            row.runtime,
            true,
            `${row.signature} denies the runtime role`,
          );
        }
        // A role that is not the owner and not the runtime role holds no EXECUTE on any of them.
        const others = (
          await migrator.query(
            `SELECT p.oid::regprocedure::text AS signature, r.rolname,
              has_function_privilege(r.oid, p.oid, 'EXECUTE') AS allowed
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            CROSS JOIN pg_roles r
            WHERE n.nspname='cc' AND p.proname=ANY($2::text[]) AND NOT r.rolsuper AND
              r.rolname<>current_user AND r.rolname<>$1 AND
              has_function_privilege(r.oid, p.oid, 'EXECUTE')`,
            [runtime.user, names],
          )
        ).rows;
        assert.deepEqual(others, [], JSON.stringify(others));
      },
    );
  } finally {
    // End every job this suite left open, so the suites after it see a free write slot.
    await migrator
      .query(
        `UPDATE cc.jobs SET status='failed',finished_at=clock_timestamp()
         WHERE customer_id=$1 AND kind='user-attribute-update'
           AND status IN ('accepted','queued','held','running')`,
        [customer],
      )
      .catch(() => undefined);
    // The previews and jobs of this suite name its principals, so they leave first.
    await migrator
      .query(
        `DELETE FROM cc.user_attribute_previews p
          USING cc.user_attribute_update_jobs u, cc.jobs j
          WHERE u.preview_id=p.preview_id AND j.job_id=u.job_id AND j.customer_id=$1
            AND j.requested_by=ANY($2::uuid[])`,
        [customer, principals],
      )
      .catch(() => undefined);
    await migrator
      .query(
        'DELETE FROM cc.jobs WHERE customer_id=$1 AND requested_by=ANY($2::uuid[])',
        [customer, principals],
      )
      .catch(() => undefined);
    await migrator.query(
      'DELETE FROM cc.application_grants WHERE principal_id=ANY($1::uuid[])',
      [principals],
    );
    // A cancel writes one security event that names its actor, so the principal can stay behind.
    // The row is disposable with the suite database (owner direction, 2026-09-17).
    await migrator
      .query('DELETE FROM cc.application_principals WHERE id=ANY($1::uuid[])', [
        principals,
      ])
      .catch(() => undefined);
    if (originalEnvelope === null)
      await migrator.query(
        'UPDATE cc.google_credentials SET envelope=NULL WHERE id=$1',
        [connection.credential_id],
      );
    // The restore suite reads every active connection, so this suite puts the flag back.
    await migrator.query(
      'UPDATE cc.google_connection SET active=$1 WHERE customer_id=$2',
      [originalActive, customer],
    );
  }
  if (failures.length > 0)
    throw new Error(`K24 value job checks failed: ${failures.join(', ')}`);
  return results;
}
