import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * K16: the category job worker of document B sections 6.2, 7.3, 7.4, and 9. The checks drive the
 * admission, the claim, the settlement, the schema cache write, the purge, C12, the cancel, and the
 * recovery through the runtime role. A device job header proves the one write slot is shared (E8).
 */
export async function qualifyUserCategoryJobs({
  runtime,
  migrator,
  issuer,
  connect,
  close,
}) {
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const generation = connection.generation;
  const wasActive = connection.active;
  await migrator.query('UPDATE cc.google_connection SET active=true');
  // The claim answers the sealed credential. An earlier check may leave the envelope null (011), so
  // this suite seals an example envelope and restores the stored value in its cleanup.
  const stored = (
    await migrator.query('SELECT * FROM cc.google_credentials WHERE id=$1', [
      connection.credential_id,
    ])
  ).rows[0];
  const originalEnvelope = stored.envelope;
  const envelope = {
    format: 1,
    keyId: stored.envelope?.keyId ?? 'k16-key-1',
    iv: 'a'.repeat(16),
    tag: 'a'.repeat(22),
    ciphertext: 'k16-example-ciphertext',
  };
  if (originalEnvelope === null)
    await migrator.query(
      'UPDATE cc.google_credentials SET envelope=$2 WHERE id=$1',
      [connection.credential_id, envelope],
    );
  const principals = [];
  const results = [];
  const failures = [];
  const check = async (name, body) => {
    try {
      // End any job a failed check left open, so one failure does not poison the checks after it.
      // A category job carries its cancel request. Another kind ends failed, because no cancel
      // principal is available for it here.
      await migrator.query(
        `UPDATE cc.jobs SET status='cancelled',cancel_requested_at=clock_timestamp(),
          cancel_requested_by=$2,finished_at=clock_timestamp()
         WHERE customer_id=$1 AND kind='user-schema-change' AND status IN ('accepted','running')`,
        [customer, manager],
      );
      await migrator.query(
        `UPDATE cc.jobs SET status='failed',failure='interrupted',finished_at=clock_timestamp()
         WHERE customer_id=$1 AND kind<>'user-schema-change' AND status IN ('accepted','running')`,
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
  const rejectsDetail = async (promise, detail) => {
    try {
      await promise;
    } catch (error) {
      if (error.detail !== detail)
        throw new Error(
          `detail ${error.detail} instead of ${detail}: ${error.message}`,
        );
      return;
    }
    throw new Error(`expected a rejection ${detail}`);
  };
  const principal = async (label, grants = []) => {
    const id = randomUUID();
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$4)',
      [id, issuer, `k16-${label}-${id}`, `K16 ${label}`],
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
  const field = (overrides = {}) => ({
    fieldId: 'fld-homeroom',
    fieldName: 'Homeroom',
    displayName: 'Homeroom',
    fieldType: 'STRING',
    multiValued: false,
    indexed: true,
    readAccessType: 'ADMINS_AND_SELF',
    numericIndexingSpec: null,
    ...overrides,
  });
  const observation = (overrides = {}) => ({
    schemaId: 'schema-1',
    schemaName: 'StudentInfo',
    displayName: 'Student Info',
    etag: 'etag-1',
    fields: [field()],
    ...overrides,
  });
  const storeCategory = async (
    schemaId,
    schemaName,
    displayName,
    etag,
    fields,
  ) => {
    await migrator.query(
      `INSERT INTO cc.user_attribute_categories(customer_id,schema_id,schema_name,display_name,
        etag,fields,read_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())`,
      [
        customer,
        schemaId,
        schemaName,
        displayName,
        etag,
        JSON.stringify(fields),
      ],
    );
  };
  const storeUser = async (userId, customSchemas, lastEntitySync = null) => {
    await migrator.query(
      `INSERT INTO cc.users(customer_id,user_id,primary_email,org_unit_path,suspended,archived,
        two_step_enrolled,custom_schemas,last_entity_sync)
       VALUES($1,$2,$3,'/Students',false,false,false,$4,
         COALESCE($5::text::timestamptz,clock_timestamp()))`,
      [
        customer,
        userId,
        `${userId}@example.org`,
        JSON.stringify(customSchemas),
        lastEntitySync,
      ],
    );
  };
  const customSchemas = async (userId) =>
    (
      await one(
        'SELECT custom_schemas FROM cc.users WHERE customer_id=$1 AND user_id=$2',
        [customer, userId],
      )
    ).custom_schemas;
  /** One plan and its job, exactly as `cc.confirm_user_category_plan` writes them. */
  const makeJob = async ({
    action,
    schemaId,
    schemaName,
    baseEtag,
    body,
    phrase,
    changes = [],
  }) => {
    const planId = randomUUID();
    await migrator.query(
      `INSERT INTO cc.user_category_plans(plan_id,customer_id,created_by,permission_version,
        generation,action,schema_id,schema_name,base_etag,body,changes,limits,phrase,digest,expires_at)
       VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,'{}',$11,$12,clock_timestamp()+interval '15 minutes')`,
      [
        planId,
        customer,
        manager,
        generation,
        action,
        schemaId ?? null,
        schemaName,
        baseEtag ?? null,
        body === undefined || body === null ? null : JSON.stringify(body),
        JSON.stringify(changes),
        phrase ?? null,
        'a'.repeat(64),
      ],
    );
    const jobId = randomUUID();
    const number = (await one("SELECT nextval('cc.job_number_cat') AS number"))
      .number;
    const row = (
      await migrator.query(
        `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,entity_type,status,
          requested_by,generation,target_count,correlation_id)
         VALUES($1,cc.job_display_id('CAT',$2),$3,'user-schema-change','devices','user','accepted',$4,$5,1,$6)
         RETURNING display_id`,
        [jobId, number, customer, manager, generation, randomUUID()],
      )
    ).rows[0];
    await migrator.query(
      `INSERT INTO cc.user_schema_change_jobs(job_id,plan_id,confirmed_by,confirmer_permission_version)
       VALUES($1,$2,$3,1)`,
      [jobId, planId, manager],
    );
    return { jobId, planId, displayId: row.display_id };
  };
  const admit = (held = false) =>
    result('SELECT cc.admit_device_update_job($1,$2) AS result', [
      customer,
      held,
    ]);
  const claim = (jobId, token, attempt = randomUUID()) =>
    result('SELECT cc.claim_user_schema_change($1,$2,$3,$4) AS result', [
      customer,
      jobId,
      token,
      attempt,
    ]);
  /** The atomic send gate of R4, as the worker calls it immediately before the one Google call. */
  const beginWrite = (jobId, token, attempt) =>
    result('SELECT cc.begin_user_schema_change_write($1,$2,$3,$4) AS result', [
      customer,
      jobId,
      token,
      attempt,
    ]);
  /**
   * The read time of one R7 observation. The text form keeps the microseconds that the `pg` driver
   * drops when it parses a `timestamptz` into a `Date`, so an observation read in the same
   * millisecond as a user write still sorts after that write. The checks pass no `at` value; the
   * regression passes a pinned instant through the same conversion.
   */
  const observationTime = async (at = null) =>
    (
      await one(
        'SELECT COALESCE($1::text::timestamptz, clock_timestamp())::text AS now',
        [at],
      )
    ).now;
  /** One user page observation at a chosen read time, as the user sync delivers it (R7). */
  const observeUser = (userId, customSchemas, observedAt) =>
    result('SELECT cc.upsert_users($1,$2,$3) AS result', [
      customer,
      JSON.stringify([
        {
          userId,
          primaryEmail: `${userId}@example.org`,
          orgUnitPath: '/Students',
          givenName: 'K16',
          familyName: 'Observation',
          fullName: 'K16 Observation',
          suspended: false,
          archived: false,
          twoStepEnrolled: false,
          aliases: [],
          customSchemas,
        },
      ]),
      observedAt,
    ]);
  const settle = (jobId, token, attempt, values) =>
    result(
      'SELECT cc.settle_user_schema_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
      [
        customer,
        jobId,
        token,
        attempt,
        values.outcome,
        values.failure ?? null,
        values.reason ?? null,
        values.schema === undefined || values.schema === null
          ? null
          : JSON.stringify(values.schema),
        values.categories === undefined || values.categories === null
          ? null
          : JSON.stringify(values.categories),
        values.observedAt ?? new Date().toISOString(),
      ],
    );
  const header = (jobId) =>
    one('SELECT * FROM cc.jobs WHERE job_id=$1', [jobId]);
  const detail = (jobId) =>
    one('SELECT * FROM cc.user_schema_change_jobs WHERE job_id=$1', [jobId]);
  /** Admit one job and claim it, so the checks below settle a real running job. */
  const runningJob = async (job) => {
    const admitted = await admit();
    assert.equal(admitted.jobId, job.jobId);
    const attempt = randomUUID();
    const claimed = await claim(job.jobId, admitted.dispatchToken, attempt);
    assert.equal(claimed.outcome, 'claimed');
    return { token: admitted.dispatchToken, attempt };
  };
  const endJob = async (jobId, status = 'failed') => {
    // A cancelled job carries its request (jobs_check8), so the cleanup names the manager.
    if (status === 'cancelled') {
      await migrator.query(
        `UPDATE cc.jobs SET status='cancelled',cancel_requested_at=clock_timestamp(),
          cancel_requested_by=$2,finished_at=clock_timestamp() WHERE job_id=$1`,
        [jobId, manager],
      );
      return;
    }
    await migrator.query(
      'UPDATE cc.jobs SET status=$2,finished_at=clock_timestamp() WHERE job_id=$1',
      [jobId, status],
    );
  };

  // A manager holds users:schema-manage and jobs:manage at the customer, so it confirms and cancels.
  const manager = await principal('manager', [
    ['users:schema-manage', district],
    ['users:read', district],
    ['jobs:manage', district],
  ]);

  try {
    await check(
      'K16 the migration adds the claim, the settlement, and the recovery',
      async () => {
        const functions = [
          'cc.claim_user_schema_change(text,uuid,uuid,uuid)',
          'cc.begin_user_schema_change_write(text,uuid,uuid,uuid)',
          'cc.settle_user_schema_change(text,uuid,uuid,uuid,text,text,text,jsonb,jsonb,timestamptz)',
          'cc.recover_user_schema_change_jobs(text)',
          'cc.record_user_schema_change_start(text,uuid,uuid,text)',
          'cc.abandon_user_schema_change_start(text,uuid,uuid)',
        ];
        for (const signature of functions) {
          const allowed = await one(
            `SELECT has_function_privilege('cc-app',$1,'EXECUTE') AS allowed`,
            [signature],
          );
          assert.equal(allowed.allowed, true, signature);
          const denied = await one(
            `SELECT has_function_privilege('cc-kestra',$1,'EXECUTE') AS allowed`,
            [signature],
          );
          assert.equal(denied.allowed, false, signature);
        }
        const kestra = await connect('cc-kestra', 'cc-kestra');
        try {
          await assert.rejects(
            kestra.query('SELECT cc.claim_user_schema_change($1,$2,$3,$4)', [
              customer,
              randomUUID(),
              randomUUID(),
              randomUUID(),
            ]),
            (error) => ['42501', '3F000'].includes(error.code),
          );
        } finally {
          await close(kestra);
        }
      },
    );

    await check(
      'K16 the job failure vocabulary holds the three category codes',
      async () => {
        const job = await makeJob({
          action: 'create-category',
          schemaName: 'VocabularyInfo',
          body: {
            schemaName: 'VocabularyInfo',
            displayName: 'Vocabulary Info',
            fields: [
              { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
            ],
          },
        });
        for (const failure of [
          'name-in-use',
          'category-changed',
          'not-found',
        ]) {
          await migrator.query(
            'UPDATE cc.jobs SET failure=$2 WHERE job_id=$1',
            [job.jobId, failure],
          );
        }
        await assert.rejects(
          migrator.query(
            "UPDATE cc.jobs SET failure='not-a-code' WHERE job_id=$1",
            [job.jobId],
          ),
          (error) => error.code === '23514',
        );
        await endJob(job.jobId, 'cancelled');
      },
    );

    await check(
      'K16 a category job admits under the write slot and holds it',
      async () => {
        // A running device job of the same customer blocks the category candidate.
        const deviceJobId = randomUUID();
        await migrator.query(
          `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,
          generation,target_count,correlation_id)
         VALUES($1,'UPD-9001',$2,'device-update','devices','running',$3,$4,1,$5)`,
          [deviceJobId, customer, manager, generation, randomUUID()],
        );
        const blocked = await makeJob({
          action: 'create-category',
          schemaName: 'BlockedInfo',
          body: {
            schemaName: 'BlockedInfo',
            displayName: 'Blocked Info',
            fields: [
              { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
            ],
          },
        });
        assert.equal(await admit(), null);
        assert.equal((await header(blocked.jobId)).status, 'queued');
        await migrator.query('DELETE FROM cc.jobs WHERE job_id=$1', [
          deviceJobId,
        ]);
        // The category job admits next, and the write slot is now its own.
        const admitted = await admit();
        assert.equal(admitted.jobId, blocked.jobId);
        assert.equal(admitted.kind, 'user-schema-change');
        assert.match(admitted.dispatchToken, /^[0-9a-f-]{36}$/);
        const next = await makeJob({
          action: 'create-category',
          schemaName: 'NextInfo',
          body: {
            schemaName: 'NextInfo',
            displayName: 'Next Info',
            fields: [
              { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
            ],
          },
        });
        assert.equal(await admit(), null);
        assert.equal((await header(next.jobId)).status, 'queued');
        // A device candidate waits while the category job runs: it keeps the queue.
        const waitingDevice = randomUUID();
        await migrator.query(
          `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,requested_by,
          generation,target_count,correlation_id)
         VALUES($1,'UPD-9002',$2,'device-update','devices','accepted',$3,$4,1,$5)`,
          [waitingDevice, customer, manager, generation, randomUUID()],
        );
        assert.equal(await admit(), null);
        assert.equal((await header(waitingDevice)).status, 'queued');
        await migrator.query('DELETE FROM cc.jobs WHERE job_id=$1', [
          waitingDevice,
        ]);
        await endJob(blocked.jobId, 'cancelled');
        await endJob(next.jobId, 'cancelled');
      },
    );

    await check(
      'K16 the claim fences the attempt and answers the plan and the credential',
      async () => {
        const job = await makeJob({
          action: 'create-category',
          schemaName: 'ClaimInfo',
          body: {
            schemaName: 'ClaimInfo',
            displayName: 'Claim Info',
            fields: [
              { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
            ],
          },
        });
        const admitted = await admit();
        assert.equal(admitted.jobId, job.jobId);
        // A wrong token is fenced and changes nothing.
        assert.deepEqual(await claim(job.jobId, randomUUID()), {
          outcome: 'fenced',
        });
        const attempt = randomUUID();
        const claimed = await claim(job.jobId, admitted.dispatchToken, attempt);
        assert.equal(
          claimed.outcome,
          'claimed',
          `The claim answered ${JSON.stringify(claimed)}`,
        );
        assert.equal(claimed.action, 'create-category');
        assert.equal(claimed.schemaName, 'ClaimInfo');
        assert.equal(claimed.resume, false);
        assert.equal(claimed.credentialId, connection.credential_id);
        assert.equal(claimed.generation, generation);
        assert.ok(claimed.envelope !== null);
        const first = await detail(job.jobId);
        assert.ok(first.first_claimed_at !== null);
        assert.equal(first.attempt, attempt);
        // A same-owner repeat claim answers the plan and reads Google back only after the call began.
        const again = await claim(job.jobId, admitted.dispatchToken, attempt);
        assert.equal(again.outcome, 'claimed');
        assert.equal(again.resume, false);
        // R1: another attempt while the lease is live never takes ownership.
        const intruder = await claim(
          job.jobId,
          admitted.dispatchToken,
          randomUUID(),
        );
        assert.deepEqual(intruder, { outcome: 'busy' });
        assert.equal((await detail(job.jobId)).attempt, attempt);
        await settle(
          job.jobId,
          admitted.dispatchToken,
          (await detail(job.jobId)).attempt,
          {
            outcome: 'failed',
            failure: 'request-failed',
            reason: 'fixture',
          },
        );
        await endJob(job.jobId, 'failed');
      },
    );

    await check(
      'K16 an expired attempt cannot settle, and a new claim takes over for the read-back (R1)',
      async () => {
        const job = await makeJob({
          action: 'create-category',
          schemaName: 'LeaseInfo',
          body: {
            schemaName: 'LeaseInfo',
            displayName: 'Lease Info',
            fields: [
              { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
            ],
          },
        });
        const admitted = await admit();
        assert.equal(admitted.jobId, job.jobId);
        const first = randomUUID();
        assert.equal(
          (await claim(job.jobId, admitted.dispatchToken, first)).outcome,
          'claimed',
        );
        assert.deepEqual(
          await beginWrite(job.jobId, admitted.dispatchToken, first),
          { outcome: 'writing' },
        );
        // The runner stalls past its lease. Its settlement is fenced and writes nothing.
        await migrator.query(
          "UPDATE cc.user_schema_change_jobs SET attempt_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [job.jobId],
        );
        assert.deepEqual(
          await settle(job.jobId, admitted.dispatchToken, first, {
            outcome: 'succeeded',
            schema: observation({
              schemaId: 'schema-lease',
              schemaName: 'LeaseInfo',
              displayName: 'Lease Info',
            }),
          }),
          { outcome: 'fenced' },
        );
        assert.equal(
          (
            await one(
              'SELECT count(*)::integer AS count FROM cc.user_attribute_categories WHERE customer_id=$1 AND schema_id=$2',
              [customer, 'schema-lease'],
            )
          ).count,
          0,
        );
        assert.equal((await header(job.jobId)).status, 'running');
        // A new runner takes ownership because the lease expired. The call began, so it reads back.
        const second = randomUUID();
        const taken = await claim(job.jobId, admitted.dispatchToken, second);
        assert.equal(taken.outcome, 'claimed');
        assert.equal(taken.resume, true);
        assert.equal((await detail(job.jobId)).attempt, second);
        // The old owner never writes after the transfer.
        assert.deepEqual(
          await beginWrite(job.jobId, admitted.dispatchToken, first),
          { outcome: 'fenced' },
        );
        const settled = await settle(
          job.jobId,
          admitted.dispatchToken,
          second,
          {
            outcome: 'failed',
            failure: 'request-failed',
            reason: 'fixture',
          },
        );
        assert.equal(settled.status, 'failed');
      },
    );

    await check(
      'K16 a lease that lapses during a cached-user wait fences the settlement (R1)',
      async () => {
        await storeCategory(
          'schema-lease-wait',
          'LeaseWaitInfo',
          'Lease Wait Info',
          'etag-lw',
          [
            field({
              fieldId: 'fld-lw',
              fieldName: 'Code',
              displayName: 'Code',
            }),
          ],
        );
        await storeUser('user-lease-wait', {
          LeaseWaitInfo: { Code: { value: 'one' } },
        });
        const job = await makeJob({
          action: 'delete-category',
          schemaId: 'schema-lease-wait',
          schemaName: 'LeaseWaitInfo',
          baseEtag: 'etag-lw',
          body: null,
        });
        const { token, attempt } = await runningJob(job);
        // Hold the affected cached user row in another transaction. The purge below waits on it,
        // and that wait is independent of the category lock.
        const holder = await connect('cc-migrator', 'cc-app');
        const settler = await connect('cc-app', 'cc-app');
        try {
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM cc.users WHERE customer_id=$1 AND user_id=$2 FOR UPDATE',
            [customer, 'user-lease-wait'],
          );
          const holderPid = (
            await holder.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          // The attempt lease ends while the settlement waits on that row.
          await migrator.query(
            "UPDATE cc.user_schema_change_jobs SET attempt_expires_at=clock_timestamp()+interval '2 seconds' WHERE job_id=$1",
            [job.jobId],
          );
          const settlerPid = (
            await settler.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const settlement = settler.query(
            'SELECT cc.settle_user_schema_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
            [
              customer,
              job.jobId,
              token,
              attempt,
              'succeeded',
              null,
              null,
              null,
              null,
              new Date().toISOString(),
            ],
          );
          // Confirm the settlement waits on the held row before the lease ends.
          let waiting = false;
          for (let poll = 0; poll < 100 && !waiting; poll += 1) {
            waiting = (
              await one(
                'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS waiting',
                [settlerPid, holderPid],
              )
            ).waiting;
            if (!waiting)
              await new Promise((resolve) => setTimeout(resolve, 50));
          }
          assert.equal(waiting, true, 'the settlement waits on the user row');
          // Release the row after the lease lapsed.
          await new Promise((resolve) => setTimeout(resolve, 2_200));
          await holder.query('COMMIT');
          assert.deepEqual((await settlement).rows[0].result, {
            outcome: 'fenced',
          });
          // Nothing committed: the header, the cache row, and the cached user value remain.
          assert.equal((await header(job.jobId)).status, 'running');
          assert.deepEqual(await customSchemas('user-lease-wait'), {
            LeaseWaitInfo: { Code: { value: 'one' } },
          });
          assert.equal(
            (
              await one(
                'SELECT count(*)::integer AS count FROM cc.user_attribute_categories WHERE customer_id=$1 AND schema_id=$2',
                [customer, 'schema-lease-wait'],
              )
            ).count,
            1,
          );
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await close(holder);
          await close(settler);
        }
        await endJob(job.jobId, 'cancelled');
      },
    );

    await check(
      'K16 a lease that lapses during a later membership wait fences the settlement (R1)',
      async () => {
        // A user that joins the cache after the pre-lock snapshot makes the purge acquire one more
        // row lock. The lease lapses during that wait, and the settlement must roll back instead of
        // committing over the expired attempt. The committed observation of the new user stays.
        await storeCategory(
          'schema-membership-wait',
          'MembershipWaitInfo',
          'Membership Wait Info',
          'etag-mw',
          [
            field({
              fieldId: 'fld-mw',
              fieldName: 'Code',
              displayName: 'Code',
            }),
          ],
        );
        await storeUser('user-membership-a', {
          MembershipWaitInfo: { Code: { value: 'a' } },
        });
        await storeUser('user-membership-b', {});
        const job = await makeJob({
          action: 'delete-category',
          schemaId: 'schema-membership-wait',
          schemaName: 'MembershipWaitInfo',
          baseEtag: 'etag-mw',
          body: null,
        });
        const { token, attempt } = await runningJob(job);
        const before = await header(job.jobId);
        const publicationsBefore = (
          await one(
            'SELECT count(*)::integer AS count FROM cc.job_publications WHERE job_id=$1',
            [job.jobId],
          )
        ).count;
        // The attempt lease ends during the second wait. The settlement reads this value with its
        // detail lock, so the shortened lease must exist before the settlement query starts.
        await migrator.query(
          "UPDATE cc.user_schema_change_jobs SET attempt_expires_at=clock_timestamp()+interval '5 seconds' WHERE job_id=$1",
          [job.jobId],
        );
        const holderA = await connect('cc-migrator', 'cc-app');
        const holderB = await connect('cc-migrator', 'cc-app');
        const settler = await connect('cc-app', 'cc-app');
        let settlement = null;
        try {
          await holderA.query('BEGIN');
          await holderA.query(
            'SELECT 1 FROM cc.users WHERE customer_id=$1 AND user_id=$2 FOR UPDATE',
            [customer, 'user-membership-a'],
          );
          const holderAPid = (
            await holderA.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          const settlerPid = (
            await settler.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          settlement = settler.query(
            'SELECT cc.settle_user_schema_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
            [
              customer,
              job.jobId,
              token,
              attempt,
              'succeeded',
              null,
              null,
              null,
              null,
              new Date().toISOString(),
            ],
          );
          // The pre-lock query waits on the user that matched its snapshot.
          let waitingOnA = false;
          for (let poll = 0; poll < 200 && !waitingOnA; poll += 1) {
            waitingOnA = (
              await one(
                'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS waiting',
                [settlerPid, holderAPid],
              )
            ).waiting;
            if (!waitingOnA)
              await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.equal(
            waitingOnA,
            true,
            'the pre-lock waits on the original matching user',
          );
          // A production observation adds the category to a second user after that snapshot.
          await observeUser(
            'user-membership-b',
            { MembershipWaitInfo: { Code: { value: 'b' } } },
            new Date(Date.now() + 60_000).toISOString(),
          );
          assert.deepEqual(await customSchemas('user-membership-b'), {
            MembershipWaitInfo: { Code: { value: 'b' } },
          });
          // Hold the newly matching row, so the purge itself waits on it.
          await holderB.query('BEGIN');
          await holderB.query(
            'SELECT 1 FROM cc.users WHERE customer_id=$1 AND user_id=$2 FOR UPDATE',
            [customer, 'user-membership-b'],
          );
          const holderBPid = (
            await holderB.query('SELECT pg_backend_pid() AS pid')
          ).rows[0].pid;
          // Release the first row while the lease is live. The purge then waits on the new one.
          await holderA.query('COMMIT');
          let waitingOnB = false;
          for (let poll = 0; poll < 200 && !waitingOnB; poll += 1) {
            waitingOnB = (
              await one(
                'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS waiting',
                [settlerPid, holderBPid],
              )
            ).waiting;
            if (!waitingOnB)
              await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.equal(
            waitingOnB,
            true,
            'the purge waits on the newly matching user',
          );
          // Let the lease lapse while the purge waits.
          for (let poll = 0; poll < 100; poll += 1) {
            const live = (
              await one(
                'SELECT attempt_expires_at>clock_timestamp() AS live FROM cc.user_schema_change_jobs WHERE job_id=$1',
                [job.jobId],
              )
            ).live;
            if (!live) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.equal(
            (
              await one(
                'SELECT attempt_expires_at<=clock_timestamp() AS expired FROM cc.user_schema_change_jobs WHERE job_id=$1',
                [job.jobId],
              )
            ).expired,
            true,
            'the lease lapses during the wait',
          );
          await holderB.query('COMMIT');
          assert.deepEqual((await settlement).rows[0].result, {
            outcome: 'fenced',
          });
          settlement = null;
          // Nothing committed: header, revision, publications, cache, and both users remain.
          const after = await header(job.jobId);
          assert.equal(after.status, 'running');
          assert.equal(after.revision, before.revision);
          assert.equal(after.finished_at, null);
          assert.equal(
            (
              await one(
                'SELECT count(*)::integer AS count FROM cc.job_publications WHERE job_id=$1',
                [job.jobId],
              )
            ).count,
            publicationsBefore,
          );
          assert.equal(
            (
              await one(
                'SELECT count(*)::integer AS count FROM cc.user_attribute_categories WHERE customer_id=$1 AND schema_id=$2',
                [customer, 'schema-membership-wait'],
              )
            ).count,
            1,
          );
          assert.deepEqual(await customSchemas('user-membership-a'), {
            MembershipWaitInfo: { Code: { value: 'a' } },
          });
          // The observation that added the second user committed before the refusal and stays.
          assert.deepEqual(await customSchemas('user-membership-b'), {
            MembershipWaitInfo: { Code: { value: 'b' } },
          });
        } finally {
          await settlement?.catch(() => undefined);
          await holderA.query('ROLLBACK').catch(() => undefined);
          await holderB.query('ROLLBACK').catch(() => undefined);
          await close(holderA);
          await close(holderB);
          await close(settler);
        }
        await endJob(job.jobId, 'cancelled');
      },
    );

    await check('K16 a created category is written to the cache', async () => {
      const job = await makeJob({
        action: 'create-category',
        schemaName: 'CacheInfo',
        body: {
          schemaName: 'CacheInfo',
          displayName: 'Cache Info',
          fields: [
            { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
          ],
        },
      });
      const { token, attempt } = await runningJob(job);
      const schema = observation({
        schemaId: 'schema-cache',
        schemaName: 'CacheInfo',
        displayName: 'Cache Info',
        fields: [
          field({
            fieldId: 'fld-code',
            fieldName: 'Code',
            displayName: 'Code',
          }),
        ],
      });
      const settled = await settle(job.jobId, token, attempt, {
        outcome: 'succeeded',
        schema,
      });
      assert.equal(settled.outcome, 'settled');
      assert.equal(settled.status, 'completed');
      const cached = await one(
        'SELECT * FROM cc.user_attribute_categories WHERE customer_id=$1 AND schema_id=$2',
        [customer, 'schema-cache'],
      );
      assert.equal(cached.schema_name, 'CacheInfo');
      assert.equal(cached.display_name, 'Cache Info');
      assert.equal(cached.etag, 'etag-1');
      assert.deepEqual(cached.fields, [
        field({ fieldId: 'fld-code', fieldName: 'Code', displayName: 'Code' }),
      ]);
      const jobRow = await header(job.jobId);
      assert.equal(jobRow.status, 'completed');
      assert.equal(jobRow.succeeded, 1);
      assert.ok(jobRow.finished_at !== null);
    });

    await check(
      'K16 a delete purges the category from every cached user',
      async () => {
        // Acceptance 3: the cache row and every cached user value leave.
        await storeCategory(
          'schema-delete',
          'DeleteInfo',
          'Delete Info',
          'etag-d',
          [
            field({
              fieldId: 'fld-a',
              fieldName: 'Alpha',
              displayName: 'Alpha',
            }),
            field({ fieldId: 'fld-b', fieldName: 'Beta', displayName: 'Beta' }),
          ],
        );
        await storeUser('user-delete-1', {
          DeleteInfo: { Alpha: { value: 'one' }, Beta: { value: 'two' } },
          KeepInfo: { Code: { value: 'kept' } },
        });
        await storeUser('user-delete-2', {
          DeleteInfo: { Alpha: { value: 'three' } },
        });
        // R7: the observation below reads Google before the delete, so it must not restore the value.
        const before = await observationTime();
        const versionOf = async (userId) =>
          (
            await one(
              'SELECT record_version FROM cc.users WHERE customer_id=$1 AND user_id=$2',
              [customer, userId],
            )
          ).record_version;
        const versionBefore = await versionOf('user-delete-1');
        const job = await makeJob({
          action: 'delete-category',
          schemaId: 'schema-delete',
          schemaName: 'DeleteInfo',
          baseEtag: 'etag-d',
          body: null,
          phrase: 'Delete Info',
        });
        const { token, attempt } = await runningJob(job);
        const settled = await settle(job.jobId, token, attempt, {
          outcome: 'succeeded',
        });
        assert.equal(settled.status, 'completed');
        assert.equal(
          (
            await one(
              'SELECT count(*)::integer AS count FROM cc.user_attribute_categories WHERE customer_id=$1 AND schema_id=$2',
              [customer, 'schema-delete'],
            )
          ).count,
          0,
        );
        assert.deepEqual(await customSchemas('user-delete-1'), {
          KeepInfo: { Code: { value: 'kept' } },
        });
        assert.deepEqual(await customSchemas('user-delete-2'), {});
        // R6: the purge moves the record version, so a warm cache entry fails its version check and a
        // warm query is unreachable through the moved query generation.
        assert.ok(
          (await versionOf('user-delete-1')) > versionBefore,
          'The purge moves the user record version.',
        );
        // R7: an observation older than the delete writes no value back, though the row still stores
        // the newer read of its other columns.
        assert.equal(
          await observeUser(
            'user-delete-1',
            {
              DeleteInfo: { Alpha: { value: 'one' }, Beta: { value: 'two' } },
              KeepInfo: { Code: { value: 'stale' } },
            },
            before,
          ),
          1,
        );
        assert.deepEqual(await customSchemas('user-delete-1'), {
          KeepInfo: { Code: { value: 'kept' } },
        });
      },
    );

    await check(
      'K16 an edit that removes an attribute purges it from every cached user',
      async () => {
        await storeCategory('schema-edit', 'EditInfo', 'Edit Info', 'etag-e', [
          field({ fieldId: 'fld-a', fieldName: 'Alpha', displayName: 'Alpha' }),
          field({ fieldId: 'fld-b', fieldName: 'Beta', displayName: 'Beta' }),
        ]);
        await storeUser('user-edit-1', {
          EditInfo: { Alpha: 'one', Beta: 'two' },
          OtherInfo: { Code: 'keep' },
        });
        const removedBefore = await observationTime();
        const job = await makeJob({
          action: 'edit-category',
          schemaId: 'schema-edit',
          schemaName: 'EditInfo',
          baseEtag: 'etag-e',
          body: {
            schemaName: 'EditInfo',
            displayName: 'Edit Info',
            fields: [
              {
                fieldId: 'fld-a',
                fieldName: 'Alpha',
                displayName: 'Alpha',
                fieldType: 'STRING',
              },
            ],
          },
          // The plan's own change list names the removal, so a cache refresh cannot drop it (R3).
          changes: [
            {
              change: 'removed',
              fieldId: 'fld-b',
              fieldName: 'Beta',
              displayName: 'Beta',
              properties: [],
              holders: 1,
            },
          ],
        });
        const { token, attempt } = await runningJob(job);
        await settle(job.jobId, token, attempt, {
          outcome: 'succeeded',
          schema: observation({
            schemaId: 'schema-edit',
            schemaName: 'EditInfo',
            displayName: 'Edit Info',
            etag: 'etag-e2',
            fields: [
              field({
                fieldId: 'fld-a',
                fieldName: 'Alpha',
                displayName: 'Alpha',
              }),
            ],
          }),
        });
        assert.deepEqual(await customSchemas('user-edit-1'), {
          EditInfo: { Alpha: 'one' },
          OtherInfo: { Code: 'keep' },
        });
        // R7: an observation that predates the removal cannot restore the removed value.
        assert.equal(
          await observeUser(
            'user-edit-1',
            { EditInfo: { Alpha: 'one', Beta: 'two' } },
            removedBefore,
          ),
          1,
        );
        assert.deepEqual(await customSchemas('user-edit-1'), {
          EditInfo: { Alpha: 'one' },
          OtherInfo: { Code: 'keep' },
        });
      },
    );

    await check(
      'K16 an edit to multiple values wraps each cached value (C12)',
      async () => {
        await storeCategory('schema-wide', 'WideInfo', 'Wide Info', 'etag-w', [
          field({ fieldId: 'fld-tag', fieldName: 'Tag', displayName: 'Tag' }),
        ]);
        await storeUser('user-wide-1', { WideInfo: { Tag: 'one' } });
        await storeUser('user-wide-2', {
          WideInfo: { Tag: ['one', 'two'] },
          OtherInfo: { Code: 'keep' },
        });
        const wideBefore = await observationTime();
        const job = await makeJob({
          action: 'edit-category',
          schemaId: 'schema-wide',
          schemaName: 'WideInfo',
          baseEtag: 'etag-w',
          body: {
            schemaName: 'WideInfo',
            displayName: 'Wide Info',
            fields: [
              {
                fieldId: 'fld-tag',
                fieldName: 'Tag',
                displayName: 'Tag',
                fieldType: 'STRING',
                multiValued: true,
              },
            ],
          },
          changes: [
            {
              change: 'changed',
              fieldId: 'fld-tag',
              fieldName: 'Tag',
              displayName: 'Tag',
              properties: ['multiValued'],
              holders: null,
            },
          ],
        });
        const { token, attempt } = await runningJob(job);
        await settle(job.jobId, token, attempt, {
          outcome: 'succeeded',
          schema: observation({
            schemaId: 'schema-wide',
            schemaName: 'WideInfo',
            displayName: 'Wide Info',
            etag: 'etag-w2',
            fields: [
              field({
                fieldId: 'fld-tag',
                fieldName: 'Tag',
                displayName: 'Tag',
                multiValued: true,
              }),
            ],
          }),
        });
        // C12: a raw scalar becomes one entry object. A list keeps its own entries (R2).
        assert.deepEqual(await customSchemas('user-wide-1'), {
          WideInfo: { Tag: [{ value: 'one' }] },
        });
        assert.deepEqual(await customSchemas('user-wide-2'), {
          WideInfo: { Tag: ['one', 'two'] },
          OtherInfo: { Code: 'keep' },
        });
        // R7: an observation that predates the conversion cannot restore the scalar.
        assert.equal(
          await observeUser(
            'user-wide-1',
            { WideInfo: { Tag: 'one' } },
            wideBefore,
          ),
          1,
        );
        assert.deepEqual(await customSchemas('user-wide-1'), {
          WideInfo: { Tag: [{ value: 'one' }] },
        });
      },
    );

    await check(
      'K16 an observation time keeps the microseconds of its read (R7)',
      async () => {
        // The `pg` driver parses a `timestamptz` into a `Date`, which holds milliseconds only. Pin
        // an instant 500 microseconds into its millisecond, then store a write one microsecond into
        // that same millisecond. The text read keeps its microseconds and sorts after the write;
        // the Date form of the same instant drops them and sorts before it. Neither outcome depends
        // on where the clock falls inside its millisecond.
        const pinned = (
          await one(
            "SELECT (date_trunc('milliseconds', clock_timestamp()) + interval '500 microseconds')::text AS at",
          )
        ).at;
        const observed = await observationTime(pinned);
        const synced = (
          await one(
            "SELECT (date_trunc('milliseconds', $1::timestamptz) + interval '1 microsecond')::text AS at",
            [observed],
          )
        ).at;
        // The fix: the observation keeps the pinned microseconds, so the newer read writes the row.
        await storeUser(
          'user-observation-1',
          { ObservationInfo: { Code: 'one' } },
          synced,
        );
        assert.equal(
          await observeUser(
            'user-observation-1',
            { ObservationInfo: { Code: 'two' } },
            observed,
          ),
          1,
        );
        assert.deepEqual(await customSchemas('user-observation-1'), {
          ObservationInfo: { Code: 'two' },
        });
        // The defect: the Date form the driver built before the fix truncates the same instant to
        // its millisecond, so the observation is older than the write and the upsert refuses it.
        const truncated = (
          await one('SELECT $1::timestamptz AS at', [observed])
        ).at;
        assert.ok(truncated instanceof Date);
        await storeUser(
          'user-observation-2',
          { ObservationInfo: { Code: 'one' } },
          synced,
        );
        assert.equal(
          await observeUser(
            'user-observation-2',
            { ObservationInfo: { Code: 'two' } },
            truncated,
          ),
          0,
        );
        assert.deepEqual(await customSchemas('user-observation-2'), {
          ObservationInfo: { Code: 'one' },
        });
      },
    );

    await check(
      'K16 C12 wraps text, zero, and false from production-shaped scalars (R2)',
      async () => {
        await storeCategory(
          'schema-scale',
          'ScaleInfo',
          'Scale Info',
          'etag-s2',
          [
            field({
              fieldId: 'fld-note',
              fieldName: 'Note',
              displayName: 'Note',
            }),
            field({
              fieldId: 'fld-count',
              fieldName: 'Count',
              displayName: 'Count',
              fieldType: 'INT64',
            }),
            field({
              fieldId: 'fld-flag',
              fieldName: 'Flag',
              displayName: 'Flag',
              fieldType: 'BOOL',
            }),
          ],
        );
        // The production reader stores raw scalars: a string, a number, and a boolean.
        await storeUser('user-scale-1', {
          ScaleInfo: { Note: 'note', Count: 0, Flag: false },
        });
        await storeUser('user-scale-2', {
          ScaleInfo: { Note: 'kept', Count: [{ value: 4 }], Flag: true },
          KeepInfo: { Code: 'same' },
        });
        const job = await makeJob({
          action: 'edit-category',
          schemaId: 'schema-scale',
          schemaName: 'ScaleInfo',
          baseEtag: 'etag-s2',
          body: {
            schemaName: 'ScaleInfo',
            displayName: 'Scale Info',
            fields: [
              {
                fieldId: 'fld-note',
                fieldName: 'Note',
                displayName: 'Note',
                fieldType: 'STRING',
                multiValued: true,
              },
              {
                fieldId: 'fld-count',
                fieldName: 'Count',
                displayName: 'Count',
                fieldType: 'INT64',
                multiValued: true,
              },
              {
                fieldId: 'fld-flag',
                fieldName: 'Flag',
                displayName: 'Flag',
                fieldType: 'BOOL',
                multiValued: true,
              },
            ],
          },
          changes: ['Note', 'Count', 'Flag'].map((name) => ({
            change: 'changed',
            fieldId:
              name === 'Note'
                ? 'fld-note'
                : name === 'Count'
                  ? 'fld-count'
                  : 'fld-flag',
            fieldName: name,
            displayName: name,
            properties: ['multiValued'],
            holders: null,
          })),
        });
        const { token, attempt } = await runningJob(job);
        await settle(job.jobId, token, attempt, {
          outcome: 'succeeded',
          schema: observation({
            schemaId: 'schema-scale',
            schemaName: 'ScaleInfo',
            displayName: 'Scale Info',
            etag: 'etag-s3',
            fields: [
              field({
                fieldId: 'fld-note',
                fieldName: 'Note',
                displayName: 'Note',
                multiValued: true,
              }),
              field({
                fieldId: 'fld-count',
                fieldName: 'Count',
                displayName: 'Count',
                fieldType: 'INT64',
                multiValued: true,
              }),
              field({
                fieldId: 'fld-flag',
                fieldName: 'Flag',
                displayName: 'Flag',
                fieldType: 'BOOL',
                multiValued: true,
              }),
            ],
          }),
        });
        assert.deepEqual(await customSchemas('user-scale-1'), {
          ScaleInfo: {
            Note: [{ value: 'note' }],
            Count: [{ value: 0 }],
            Flag: [{ value: false }],
          },
        });
        assert.deepEqual(await customSchemas('user-scale-2'), {
          ScaleInfo: {
            Note: [{ value: 'kept' }],
            Count: [{ value: 4 }],
            Flag: [{ value: true }],
          },
          KeepInfo: { Code: 'same' },
        });
      },
    );

    await check(
      'K16 a cache refresh before the settlement keeps the purge and the conversion (R3)',
      async () => {
        await storeCategory(
          'schema-mixed',
          'MixedInfo',
          'Mixed Info',
          'etag-m',
          [
            field({
              fieldId: 'fld-a',
              fieldName: 'Alpha',
              displayName: 'Alpha',
            }),
            field({ fieldId: 'fld-b', fieldName: 'Beta', displayName: 'Beta' }),
          ],
        );
        await storeUser('user-mixed-1', {
          MixedInfo: { Alpha: 'one', Beta: 'two' },
        });
        const job = await makeJob({
          action: 'edit-category',
          schemaId: 'schema-mixed',
          schemaName: 'MixedInfo',
          baseEtag: 'etag-m',
          body: {
            schemaName: 'MixedInfo',
            displayName: 'Mixed Info',
            fields: [
              {
                fieldId: 'fld-a',
                fieldName: 'Alpha',
                displayName: 'Alpha',
                fieldType: 'STRING',
                multiValued: true,
              },
            ],
          },
          changes: [
            {
              change: 'changed',
              fieldId: 'fld-a',
              fieldName: 'Alpha',
              displayName: 'Alpha',
              properties: ['multiValued'],
              holders: null,
            },
            {
              change: 'removed',
              fieldId: 'fld-b',
              fieldName: 'Beta',
              displayName: 'Beta',
              properties: [],
              holders: 1,
            },
          ],
        });
        const { token, attempt } = await runningJob(job);
        // A real schema-list read replaces the category cache after the plan and before the settle.
        await migrator.query(
          'SELECT cc.store_user_attribute_categories($1,$2,$3) AS result',
          [
            customer,
            JSON.stringify([
              observation({
                schemaId: 'schema-mixed',
                schemaName: 'MixedInfo',
                displayName: 'Mixed Info',
                etag: 'etag-m2',
                fields: [
                  field({
                    fieldId: 'fld-a',
                    fieldName: 'Alpha',
                    displayName: 'Alpha',
                    multiValued: true,
                  }),
                ],
              }),
            ]),
            new Date().toISOString(),
          ],
        );
        await settle(job.jobId, token, attempt, {
          outcome: 'succeeded',
          schema: observation({
            schemaId: 'schema-mixed',
            schemaName: 'MixedInfo',
            displayName: 'Mixed Info',
            etag: 'etag-m2',
            fields: [
              field({
                fieldId: 'fld-a',
                fieldName: 'Alpha',
                displayName: 'Alpha',
                multiValued: true,
              }),
            ],
          }),
        });
        assert.deepEqual(await customSchemas('user-mixed-1'), {
          MixedInfo: { Alpha: [{ value: 'one' }] },
        });
      },
    );

    await check(
      'K16 a name-in-use answer settles Failed and refreshes the cache (C6)',
      async () => {
        await storeCategory(
          'schema-stale',
          'StaleInfo',
          'Stale Info',
          'etag-s',
          [
            field({
              fieldId: 'fld-a',
              fieldName: 'Alpha',
              displayName: 'Alpha',
            }),
          ],
        );
        const job = await makeJob({
          action: 'create-category',
          schemaName: 'StudentInfo',
          body: {
            schemaName: 'StudentInfo',
            displayName: 'Student Info',
            fields: [
              { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
            ],
          },
        });
        const { token, attempt } = await runningJob(job);
        const fresh = observation({
          schemaId: 'schema-fresh',
          schemaName: 'FreshInfo',
          displayName: 'Fresh Info',
          etag: 'etag-f',
          fields: [
            field({ fieldId: 'fld-f', fieldName: 'Code', displayName: 'Code' }),
          ],
        });
        const settled = await settle(job.jobId, token, attempt, {
          outcome: 'failed',
          failure: 'name-in-use',
          reason: 'duplicate',
          categories: [fresh],
        });
        assert.equal(settled.status, 'failed');
        const jobRow = await header(job.jobId);
        assert.equal(jobRow.failure, 'name-in-use');
        assert.equal(jobRow.failed, 1);
        assert.equal((await detail(job.jobId)).failure_reason, 'duplicate');
        const names = (
          await migrator.query(
            'SELECT schema_name FROM cc.user_attribute_categories WHERE customer_id=$1 ORDER BY schema_name',
            [customer],
          )
        ).rows.map((row) => row.schema_name);
        assert.deepEqual(names, ['FreshInfo']);
      },
    );

    await check(
      'K16 a changed etag refreshes the cache and fails category-changed (C7)',
      async () => {
        await storeCategory(
          'schema-guard',
          'GuardInfo',
          'Guard Info',
          'etag-g',
          [
            field({
              fieldId: 'fld-a',
              fieldName: 'Alpha',
              displayName: 'Alpha',
            }),
          ],
        );
        await storeUser('user-guard-1', {
          GuardInfo: { Alpha: { value: 'one' }, Beta: { value: 'two' } },
        });
        const job = await makeJob({
          action: 'edit-category',
          schemaId: 'schema-guard',
          schemaName: 'GuardInfo',
          baseEtag: 'etag-g',
          body: {
            schemaName: 'GuardInfo',
            displayName: 'Guard Info',
            fields: [
              {
                fieldId: 'fld-a',
                fieldName: 'Alpha',
                displayName: 'Alpha',
                fieldType: 'STRING',
              },
            ],
          },
        });
        const { token, attempt } = await runningJob(job);
        const settled = await settle(job.jobId, token, attempt, {
          outcome: 'failed',
          failure: 'category-changed',
          schema: observation({
            schemaId: 'schema-guard',
            schemaName: 'GuardInfo',
            displayName: 'Guard Info',
            etag: 'etag-g2',
            fields: [
              field({
                fieldId: 'fld-a',
                fieldName: 'Alpha',
                displayName: 'Alpha',
              }),
            ],
          }),
        });
        assert.equal(settled.status, 'failed');
        const cached = await one(
          'SELECT etag FROM cc.user_attribute_categories WHERE customer_id=$1 AND schema_id=$2',
          [customer, 'schema-guard'],
        );
        assert.equal(cached.etag, 'etag-g2');
        // The refreshed schema replaces the cache. A changed etag removes no cached value, so the
        // user keeps the value that the category does not declare.
        assert.deepEqual(await customSchemas('user-guard-1'), {
          GuardInfo: { Alpha: { value: 'one' }, Beta: { value: 'two' } },
        });
      },
    );

    await check(
      'K16 an unanswered call settles needs-review with unknown',
      async () => {
        const job = await makeJob({
          action: 'create-category',
          schemaName: 'UnknownInfo',
          body: {
            schemaName: 'UnknownInfo',
            displayName: 'Unknown Info',
            fields: [
              { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
            ],
          },
        });
        const { token, attempt } = await runningJob(job);
        const settled = await settle(job.jobId, token, attempt, {
          outcome: 'unknown',
          failure: 'network-failure',
        });
        assert.equal(settled.status, 'needs-review');
        const jobRow = await header(job.jobId);
        assert.equal(jobRow.unknown, 1);
        assert.equal(jobRow.failure, 'network-failure');
        // No category row appears, because the read-back found none.
        assert.equal(
          (
            await one(
              'SELECT count(*)::integer AS count FROM cc.user_attribute_categories WHERE customer_id=$1 AND schema_name=$2',
              [customer, 'UnknownInfo'],
            )
          ).count,
          0,
        );
      },
    );

    await check(
      'K16 a stale attempt is fenced and writes nothing',
      async () => {
        const job = await makeJob({
          action: 'create-category',
          schemaName: 'FenceInfo',
          body: {
            schemaName: 'FenceInfo',
            displayName: 'Fence Info',
            fields: [
              { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
            ],
          },
        });
        const { token } = await runningJob(job);
        const stale = await settle(job.jobId, token, randomUUID(), {
          outcome: 'succeeded',
          schema: observation({
            schemaId: 'schema-fence',
            schemaName: 'FenceInfo',
            displayName: 'Fence Info',
          }),
        });
        assert.deepEqual(stale, { outcome: 'fenced' });
        assert.equal(
          (
            await one(
              'SELECT count(*)::integer AS count FROM cc.user_attribute_categories WHERE customer_id=$1 AND schema_id=$2',
              [customer, 'schema-fence'],
            )
          ).count,
          0,
        );
        assert.equal((await header(job.jobId)).status, 'running');
        await endJob(job.jobId, 'cancelled');
      },
    );

    await check(
      'K16 a cancel ends a job until its call begins and refuses after (B section 7.4, R4)',
      async () => {
        const pending = await makeJob({
          action: 'create-category',
          schemaName: 'CancelInfo',
          body: {
            schemaName: 'CancelInfo',
            displayName: 'Cancel Info',
            fields: [
              { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
            ],
          },
        });
        const answer = await result(
          'SELECT cc.request_job_cancel($1,1,$2,$3,$4) AS result',
          [manager, customer, pending.displayId, randomUUID()],
        );
        assert.equal(answer.outcome, 'requested');
        const cancelled = await header(pending.jobId);
        assert.equal(cancelled.status, 'cancelled');
        assert.equal(cancelled.cancelled, 1);
        assert.ok(cancelled.finished_at !== null);
        // A claimed job whose call has not begun still ends at once, and its gate then refuses.
        const claimedJob = await makeJob({
          action: 'create-category',
          schemaName: 'ClaimedCancelInfo',
          body: {
            schemaName: 'ClaimedCancelInfo',
            displayName: 'Claimed Cancel Info',
            fields: [
              { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
            ],
          },
        });
        const admitted = await admit();
        assert.equal(admitted.jobId, claimedJob.jobId);
        const attempt = randomUUID();
        assert.equal(
          (await claim(claimedJob.jobId, admitted.dispatchToken, attempt))
            .outcome,
          'claimed',
        );
        const claimedAnswer = await result(
          'SELECT cc.request_job_cancel($1,1,$2,$3,$4) AS result',
          [manager, customer, claimedJob.displayId, randomUUID()],
        );
        assert.equal(claimedAnswer.outcome, 'requested');
        assert.equal((await header(claimedJob.jobId)).status, 'cancelled');
        assert.deepEqual(
          await beginWrite(claimedJob.jobId, admitted.dispatchToken, attempt),
          { outcome: 'fenced' },
        );
        // A job whose call began cannot stop its one call.
        const sentJob = await makeJob({
          action: 'create-category',
          schemaName: 'SentCancelInfo',
          body: {
            schemaName: 'SentCancelInfo',
            displayName: 'Sent Cancel Info',
            fields: [
              { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
            ],
          },
        });
        const sent = await admit();
        assert.equal(sent.jobId, sentJob.jobId);
        const sentAttempt = randomUUID();
        assert.equal(
          (await claim(sentJob.jobId, sent.dispatchToken, sentAttempt)).outcome,
          'claimed',
        );
        assert.deepEqual(
          await beginWrite(sentJob.jobId, sent.dispatchToken, sentAttempt),
          { outcome: 'writing' },
        );
        await rejectsDetail(
          result('SELECT cc.request_job_cancel($1,1,$2,$3,$4) AS result', [
            manager,
            customer,
            sentJob.displayId,
            randomUUID(),
          ]),
          'nothing-to-stop',
        );
        assert.equal((await header(sentJob.jobId)).status, 'running');
        await endJob(sentJob.jobId, 'cancelled');
      },
    );

    await check(
      'K16 the recovery restarts an unclaimed start and ends a lost runner',
      async () => {
        const unclaimed = await makeJob({
          action: 'create-category',
          schemaName: 'RecoverInfo',
          body: {
            schemaName: 'RecoverInfo',
            displayName: 'Recover Info',
            fields: [
              { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
            ],
          },
        });
        const admitted = await admit();
        assert.equal(admitted.jobId, unclaimed.jobId);
        await migrator.query(
          "UPDATE cc.user_schema_change_jobs SET start_deadline_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [unclaimed.jobId],
        );
        const recovered = await result(
          'SELECT cc.recover_user_schema_change_jobs($1) AS result',
          [customer],
        );
        assert.equal(recovered.starts.length, 1);
        assert.equal(recovered.starts[0].jobId, unclaimed.jobId);
        assert.notEqual(
          recovered.starts[0].dispatchToken,
          admitted.dispatchToken,
        );
        assert.equal((await detail(unclaimed.jobId)).dispatch_count, 2);
        // A claimed call whose attempt lease lapsed gets one new start for the read-back (R1).
        const lost = await makeJob({
          action: 'create-category',
          schemaName: 'LostInfo',
          body: {
            schemaName: 'LostInfo',
            displayName: 'Lost Info',
            fields: [
              { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
            ],
          },
        });
        await endJob(unclaimed.jobId, 'cancelled');
        const lostStart = await admit();
        assert.equal(lostStart.jobId, lost.jobId);
        const lostAttempt = randomUUID();
        const claimed = await claim(
          lost.jobId,
          lostStart.dispatchToken,
          lostAttempt,
        );
        assert.equal(claimed.outcome, 'claimed');
        assert.deepEqual(
          await beginWrite(lost.jobId, lostStart.dispatchToken, lostAttempt),
          { outcome: 'writing' },
        );
        await migrator.query(
          "UPDATE cc.user_schema_change_jobs SET attempt_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [lost.jobId],
        );
        const restarted = await result(
          'SELECT cc.recover_user_schema_change_jobs($1) AS result',
          [customer],
        );
        assert.equal(restarted.starts.length, 1);
        assert.equal(restarted.starts[0].jobId, lost.jobId);
        assert.notEqual(
          restarted.starts[0].dispatchToken,
          lostStart.dispatchToken,
        );
        // The new claim transfers ownership because the lease expired, and only reads Google back.
        const taken = await claim(
          lost.jobId,
          restarted.starts[0].dispatchToken,
          randomUUID(),
        );
        assert.equal(taken.outcome, 'claimed');
        assert.equal(taken.resume, true);
        assert.equal((await header(lost.jobId)).status, 'running');
        await endJob(lost.jobId, 'cancelled');
        // A job that used its three starts ends needs-review with `interrupted`.
        const spent = await makeJob({
          action: 'create-category',
          schemaName: 'SpentInfo',
          body: {
            schemaName: 'SpentInfo',
            displayName: 'Spent Info',
            fields: [
              { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
            ],
          },
        });
        const spentStart = await admit();
        assert.equal(spentStart.jobId, spent.jobId);
        const spentAttempt = randomUUID();
        assert.equal(
          (await claim(spent.jobId, spentStart.dispatchToken, spentAttempt))
            .outcome,
          'claimed',
        );
        await migrator.query(
          `UPDATE cc.user_schema_change_jobs SET attempt_expires_at=clock_timestamp()-interval '1 second',
            dispatch_count=3 WHERE job_id=$1`,
          [spent.jobId],
        );
        const ended = await result(
          'SELECT cc.recover_user_schema_change_jobs($1) AS result',
          [customer],
        );
        assert.deepEqual(ended.starts, []);
        const spentRow = await header(spent.jobId);
        assert.equal(spentRow.status, 'needs-review');
        assert.equal(spentRow.unknown, 1);
        assert.equal(spentRow.failure, 'interrupted');
      },
    );

    await check(
      'K16 a recovery start keeps its window before the next recovery (R8)',
      async () => {
        const job = await makeJob({
          action: 'create-category',
          schemaName: 'WindowInfo',
          body: {
            schemaName: 'WindowInfo',
            displayName: 'Window Info',
            fields: [
              { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
            ],
          },
        });
        const admitted = await admit();
        assert.equal(admitted.jobId, job.jobId);
        const first = randomUUID();
        assert.equal(
          (await claim(job.jobId, admitted.dispatchToken, first)).outcome,
          'claimed',
        );
        assert.deepEqual(
          await beginWrite(job.jobId, admitted.dispatchToken, first),
          { outcome: 'writing' },
        );
        await migrator.query(
          "UPDATE cc.user_schema_change_jobs SET attempt_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [job.jobId],
        );
        const lost = await result(
          'SELECT cc.recover_user_schema_change_jobs($1) AS result',
          [customer],
        );
        assert.equal(lost.starts.length, 1);
        const keptToken = lost.starts[0].dispatchToken;
        const issued = await detail(job.jobId);
        assert.equal(issued.dispatch_count, 2);
        assert.equal(issued.attempt, null);
        assert.ok(
          new Date(issued.start_deadline_at).getTime() > Date.now() + 60_000,
          'the recovery start keeps a full start window',
        );
        // Repeated recovery before a runner claims the new start changes nothing (R8).
        for (let again = 0; again < 3; again += 1) {
          const repeated = await result(
            'SELECT cc.recover_user_schema_change_jobs($1) AS result',
            [customer],
          );
          assert.deepEqual(repeated.starts, []);
        }
        const kept = await detail(job.jobId);
        assert.equal(kept.dispatch_count, 2);
        assert.equal(kept.dispatch_token, keptToken);
        assert.equal((await header(job.jobId)).status, 'running');
        // The new runner claims the kept start, and only reads Google back.
        const taken = await claim(job.jobId, keptToken, randomUUID());
        assert.equal(taken.outcome, 'claimed');
        assert.equal(taken.resume, true);
        await endJob(job.jobId, 'cancelled');
        // A recovery start whose window ends with no claim gets the next start, up to the bound.
        const delayed = await makeJob({
          action: 'create-category',
          schemaName: 'DelayedInfo',
          body: {
            schemaName: 'DelayedInfo',
            displayName: 'Delayed Info',
            fields: [
              { fieldName: 'Code', displayName: 'Code', fieldType: 'STRING' },
            ],
          },
        });
        const delayedStart = await admit();
        assert.equal(delayedStart.jobId, delayed.jobId);
        const delayedAttempt = randomUUID();
        assert.equal(
          (
            await claim(
              delayed.jobId,
              delayedStart.dispatchToken,
              delayedAttempt,
            )
          ).outcome,
          'claimed',
        );
        await migrator.query(
          "UPDATE cc.user_schema_change_jobs SET attempt_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [delayed.jobId],
        );
        const nextStart = await result(
          'SELECT cc.recover_user_schema_change_jobs($1) AS result',
          [customer],
        );
        assert.equal(nextStart.starts.length, 1);
        assert.equal((await detail(delayed.jobId)).dispatch_count, 2);
        // No runner claims it, and its window ends.
        await migrator.query(
          "UPDATE cc.user_schema_change_jobs SET start_deadline_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [delayed.jobId],
        );
        const thirdStart = await result(
          'SELECT cc.recover_user_schema_change_jobs($1) AS result',
          [customer],
        );
        assert.equal(thirdStart.starts.length, 1);
        assert.equal((await detail(delayed.jobId)).dispatch_count, 3);
        // The last start also goes unclaimed, so the job ends needs-review.
        await migrator.query(
          "UPDATE cc.user_schema_change_jobs SET start_deadline_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [delayed.jobId],
        );
        const exhausted = await result(
          'SELECT cc.recover_user_schema_change_jobs($1) AS result',
          [customer],
        );
        assert.deepEqual(exhausted.starts, []);
        const delayedRow = await header(delayed.jobId);
        assert.equal(delayedRow.status, 'needs-review');
        assert.equal(delayedRow.unknown, 1);
        assert.equal(delayedRow.failure, 'interrupted');
      },
    );
  } finally {
    if (originalEnvelope === null)
      await migrator.query(
        'UPDATE cc.google_credentials SET envelope=NULL WHERE id=$1',
        [connection.credential_id],
      );
    await migrator.query(
      'UPDATE cc.google_connection SET active=$2 WHERE customer_id=$1',
      [customer, wasActive],
    );
    await migrator.query(
      `DELETE FROM cc.jobs WHERE job_id IN (SELECT job_id FROM cc.user_schema_change_jobs
        WHERE plan_id IN (SELECT plan_id FROM cc.user_category_plans WHERE customer_id=$1))`,
      [customer],
    );
    await migrator.query(
      'DELETE FROM cc.user_category_plans WHERE customer_id=$1',
      [customer],
    );
    await migrator.query(
      'DELETE FROM cc.user_attribute_categories WHERE customer_id=$1',
      [customer],
    );
    await migrator.query('DELETE FROM cc.users WHERE customer_id=$1', [
      customer,
    ]);
    for (const id of principals) {
      // The cancel writes its audit row, and that row names the principal (007).
      await migrator.query('DELETE FROM cc.security_events WHERE actor_id=$1', [
        id,
      ]);
      await migrator.query(
        'DELETE FROM cc.application_grants WHERE principal_id=$1',
        [id],
      );
      await migrator.query(
        'DELETE FROM cc.application_principals WHERE id=$1',
        [id],
      );
    }
  }

  if (failures.length)
    throw new Error(`User category job checks failed: ${failures.join(' | ')}`);
  return results;
}
