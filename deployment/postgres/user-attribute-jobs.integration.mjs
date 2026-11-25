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
      // A lost runner after its first claim becomes Unknown and the read-back owns the user.
      const attempt = randomUUID();
      await claim(job.jobId, recovered.starts[0].dispatchToken, attempt);
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
