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
  const storeUser = async (userId, customSchemas) => {
    await migrator.query(
      `INSERT INTO cc.users(customer_id,user_id,primary_email,org_unit_path,suspended,archived,
        two_step_enrolled,custom_schemas,last_entity_sync)
       VALUES($1,$2,$3,'/Students',false,false,false,$4,clock_timestamp())`,
      [
        customer,
        userId,
        `${userId}@example.org`,
        JSON.stringify(customSchemas),
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
  }) => {
    const planId = randomUUID();
    await migrator.query(
      `INSERT INTO cc.user_category_plans(plan_id,customer_id,created_by,permission_version,
        generation,action,schema_id,schema_name,base_etag,body,changes,limits,phrase,digest,expires_at)
       VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,'[]','{}',$10,$11,clock_timestamp()+interval '15 minutes')`,
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
        // A second claim of a claimed job only reads back.
        const again = await claim(job.jobId, admitted.dispatchToken);
        assert.equal(again.outcome, 'claimed');
        assert.equal(again.resume, true);
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
          EditInfo: { Alpha: { value: 'one' }, Beta: { value: 'two' } },
        });
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
          EditInfo: { Alpha: { value: 'one' } },
        });
      },
    );

    await check(
      'K16 an edit to multiple values wraps each cached value (C12)',
      async () => {
        await storeCategory('schema-wide', 'WideInfo', 'Wide Info', 'etag-w', [
          field({ fieldId: 'fld-tag', fieldName: 'Tag', displayName: 'Tag' }),
        ]);
        await storeUser('user-wide-1', { WideInfo: { Tag: { value: 'one' } } });
        await storeUser('user-wide-2', { WideInfo: { Tag: { value: 'two' } } });
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
        assert.deepEqual(await customSchemas('user-wide-1'), {
          WideInfo: { Tag: [{ value: 'one' }] },
        });
        assert.deepEqual(await customSchemas('user-wide-2'), {
          WideInfo: { Tag: [{ value: 'two' }] },
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
      'K16 a cancel ends an unclaimed job and refuses a claimed one (B section 7.4)',
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
        // A claimed job cannot stop its one call.
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
        await runningJob(claimedJob);
        await rejectsDetail(
          result('SELECT cc.request_job_cancel($1,1,$2,$3,$4) AS result', [
            manager,
            customer,
            claimedJob.displayId,
            randomUUID(),
          ]),
          'nothing-to-stop',
        );
        assert.equal((await header(claimedJob.jobId)).status, 'running');
        await endJob(claimedJob.jobId, 'cancelled');
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
        // A claimed call whose attempt lease lapsed ends needs-review with `interrupted`.
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
        const claimed = await claim(lost.jobId, lostStart.dispatchToken);
        assert.equal(claimed.outcome, 'claimed');
        await migrator.query(
          "UPDATE cc.user_schema_change_jobs SET attempt_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
          [lost.jobId],
        );
        const ended = await result(
          'SELECT cc.recover_user_schema_change_jobs($1) AS result',
          [customer],
        );
        assert.deepEqual(ended.starts, []);
        const lostRow = await header(lost.jobId);
        assert.equal(lostRow.status, 'needs-review');
        assert.equal(lostRow.unknown, 1);
        assert.equal(lostRow.failure, 'interrupted');
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
