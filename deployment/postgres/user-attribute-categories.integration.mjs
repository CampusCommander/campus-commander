import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * K14: the category plan storage and the category job contract. The `users:schema-manage` row
 * reaches a fresh platform administrator, a `user-schema-change` job takes a `CAT-` display ID and
 * the one write slot, and a plan stores its frozen call under the constraints of document B
 * section 10. The plan routes (K15) and the worker (K16) build the behavior over these rows.
 */
export async function qualifyUserAttributeCategories({
  runtime,
  migrator,
  issuer,
}) {
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const generation = connection.generation;
  const principals = [];
  const jobs = [];
  const plans = [];
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
  const rejects = async (promise, code) => {
    try {
      await promise;
    } catch (error) {
      if (code && error.code !== code)
        throw new Error(
          `error ${error.code} instead of ${code}: ${error.message}`,
        );
      return error;
    }
    throw new Error(`expected a rejection ${code ?? ''}`);
  };
  const adminRow = (text, values = []) =>
    migrator.query(text, values).then((rows) => rows.rows[0]);
  const createPrincipal = async (label, grants = []) => {
    const id = randomUUID();
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$4)',
      [id, issuer, `k14-${label}-${id}`, `K14 ${label}`],
    );
    for (const [action, scope] of grants)
      await migrator.query(
        'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
        [id, action, JSON.stringify(scope)],
      );
    principals.push(id);
    return id;
  };
  const district = (action) => [
    action,
    { kind: 'district', customerId: customer },
  ];
  /** One category job header of the kind that 024 adds. */
  const createCategoryJob = async (actor, displayId, status = 'accepted') => {
    const jobId = randomUUID();
    await migrator.query(
      `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,entity_type,status,
        requested_by,generation,target_count,correlation_id)
       VALUES($1,$2,$3,'user-schema-change','devices','user',$4,$5,$6,1,$7)`,
      [jobId, displayId, customer, status, actor, generation, randomUUID()],
    );
    jobs.push(jobId);
    return jobId;
  };
  /** One plan row with the plan answer of document B section 10. */
  const createPlan = async (actor, action, overrides = {}) => {
    const planId = randomUUID();
    const create = action === 'create-category';
    const remove = action === 'delete-category';
    const values = {
      action,
      schemaId: create ? null : 'schem=Id/1',
      schemaName: 'StudentInfo',
      baseEtag: create ? null : '"etag-1"',
      body: remove
        ? null
        : { schemaName: 'StudentInfo', displayName: 'Student information' },
      changes: remove
        ? []
        : [
            {
              change: 'added',
              fieldId: null,
              fieldName: 'GradeLevel',
              displayName: 'Grade level',
              properties: [],
              holders: null,
            },
          ],
      limits: {
        categories: 1,
        categoryLimit: 100,
        attributes: 1,
        attributeLimit: 100,
      },
      phrase: remove ? 'Student information' : null,
      digest: 'a'.repeat(64),
      ...overrides,
    };
    await migrator.query(
      `INSERT INTO cc.user_category_plans(plan_id,customer_id,created_by,permission_version,
        generation,action,schema_id,schema_name,base_etag,body,changes,limits,phrase,digest,expires_at)
       VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp()+interval '15 minutes')`,
      [
        planId,
        customer,
        actor,
        generation,
        values.action,
        values.schemaId,
        values.schemaName,
        values.baseEtag,
        values.body === null ? null : JSON.stringify(values.body),
        JSON.stringify(values.changes),
        JSON.stringify(values.limits),
        values.phrase,
        values.digest,
      ],
    );
    plans.push(planId);
    return planId;
  };

  const platformAdministrator = await adminRow(
    `SELECT id FROM cc.application_principals p
     WHERE cc.full_platform_administrator(p.id) ORDER BY p.created_at,p.id LIMIT 1`,
  );
  const manager = await createPrincipal('schema-manager', [
    district('users:schema-manage'),
  ]);

  try {
    await check(
      'K14 users:schema-manage takes the platform and district scopes',
      async () => {
        const row = await adminRow(
          "SELECT scope_kinds FROM cc.application_actions WHERE action='users:schema-manage'",
        );
        assert.deepEqual(row.scope_kinds, ['platform', 'district']);
        await migrator.query(
          `INSERT INTO cc.application_grants(principal_id,action,scope)
           VALUES($1,'users:schema-manage',$2)`,
          [manager, JSON.stringify({ kind: 'platform' })],
        );
        await rejects(
          migrator.query(
            `INSERT INTO cc.application_grants(principal_id,action,scope)
             VALUES($1,'users:schema-manage',$2)`,
            [
              manager,
              JSON.stringify({
                kind: 'school',
                customerId: customer,
                schoolId: randomUUID(),
              }),
            ],
          ),
          'P0001',
        );
      },
    );

    await check(
      'K14 a fresh platform administrator session holds users:schema-manage',
      async () => {
        assert.ok(
          platformAdministrator,
          'The harness confirms one platform administrator.',
        );
        const grants = await adminRow(
          `SELECT count(*)::integer AS grants FROM cc.application_grants
           WHERE principal_id=$1 AND action='users:schema-manage'
             AND scope='{"kind":"platform"}'::jsonb`,
          [platformAdministrator.id],
        );
        assert.equal(grants.grants, 1);
        // The runtime role reads the action row and both tables of this migration.
        const actions = await adminRow(
          "SELECT count(*)::integer AS actions FROM cc.application_actions WHERE action='users:schema-manage'",
        );
        assert.equal(actions.actions, 1);
        await runtime.query('SELECT count(*) FROM cc.user_category_plans');
        await runtime.query('SELECT count(*) FROM cc.user_schema_change_jobs');
      },
    );

    await check(
      'K14 the runtime role reads the plans and cannot write them',
      async () => {
        await rejects(
          runtime.query(
            `INSERT INTO cc.user_category_plans(plan_id,customer_id,created_by,permission_version,
              generation,action,schema_name,changes,limits,digest,expires_at)
             VALUES($1,$2,$3,1,$4,'create-category','StudentInfo','[]','{}',$5,now())`,
            [randomUUID(), customer, manager, generation, 'a'.repeat(64)],
          ),
          '42501',
        );
      },
    );

    await check(
      'K14 a category job takes a CAT display ID of the jobs table',
      async () => {
        const number = await adminRow(
          "SELECT cc.job_display_id('CAT',nextval('cc.job_number_cat')) AS display_id",
        );
        assert.match(number.display_id, /^CAT-\d{3,}$/);
        await createCategoryJob(manager, number.display_id);
        await rejects(
          adminRow(
            `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,entity_type,status,
              requested_by,generation,target_count,correlation_id)
             VALUES($1,'CAT-1',$2,'user-schema-change','devices','user','accepted',$3,$4,1,$5)`,
            [randomUUID(), customer, manager, generation, randomUUID()],
          ),
          '23514',
        );
      },
    );

    await check(
      'K14 a running category job holds the one write slot',
      async () => {
        const first = jobs[0];
        await migrator.query(
          "UPDATE cc.jobs SET status='running' WHERE job_id=$1",
          [first],
        );
        await rejects(
          adminRow(
            `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,entity_type,status,
              requested_by,generation,target_count,correlation_id)
             VALUES($1,$2,$3,'user-schema-change','devices','user','running',$4,$5,1,$6)`,
            [
              randomUUID(),
              'CAT-002',
              customer,
              manager,
              generation,
              randomUUID(),
            ],
          ),
          '23505',
        );
        await rejects(
          adminRow(
            `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,
              requested_by,generation,target_count,correlation_id)
             VALUES($1,'UPD-999',$2,'device-update','devices','running',$3,$4,1,$5)`,
            [randomUUID(), customer, manager, generation, randomUUID()],
          ),
          '23505',
        );
        await migrator.query(
          "UPDATE cc.jobs SET status='completed',finished_at=clock_timestamp() WHERE job_id=$1",
          [first],
        );
      },
    );

    await check(
      'K14 a plan stores its frozen call under the plan constraints',
      async () => {
        await createPlan(manager, 'create-category');
        await createPlan(manager, 'edit-category');
        await createPlan(manager, 'delete-category');
        // A delete sends no body, and a create names no cached category or etag.
        await rejects(
          createPlan(manager, 'delete-category', {
            body: { schemaName: 'StudentInfo' },
          }),
          '23514',
        );
        await rejects(
          createPlan(manager, 'create-category', { baseEtag: '"etag-1"' }),
          '23514',
        );
        await rejects(
          createPlan(manager, 'create-category', { schemaId: 'schem-1' }),
          '23514',
        );
        // The digest is the 64-unit hexadecimal form of a frozen preview.
        await rejects(
          createPlan(manager, 'edit-category', { digest: 'not-a-digest' }),
          '23514',
        );
        // A plan expires after it was prepared.
        await rejects(
          adminRow(
            `INSERT INTO cc.user_category_plans(plan_id,customer_id,created_by,permission_version,
              generation,action,schema_name,base_etag,body,changes,limits,digest,prepared_at,expires_at)
             VALUES($1,$2,$3,1,$4,'edit-category','StudentInfo','"etag-1"','{}','[]','{}',$5,
               clock_timestamp(),clock_timestamp()-interval '1 minute')`,
            [randomUUID(), customer, manager, generation, 'a'.repeat(64)],
          ),
          '23514',
        );
      },
    );

    await check(
      'K14 one category job runs one plan, and the job keeps its confirmer',
      async () => {
        const jobId = jobs[0];
        const planId = plans[0];
        await migrator.query(
          `INSERT INTO cc.user_schema_change_jobs(job_id,plan_id,confirmed_by,confirmer_permission_version)
           VALUES($1,$2,$3,1)`,
          [jobId, planId, manager],
        );
        const nextJob = await createCategoryJob(manager, 'CAT-003');
        await rejects(
          migrator.query(
            `INSERT INTO cc.user_schema_change_jobs(job_id,plan_id,confirmed_by,confirmer_permission_version)
             VALUES($1,$2,$3,1)`,
            [nextJob, planId, manager],
          ),
          '23505',
        );
        await rejects(
          migrator.query(
            `INSERT INTO cc.user_schema_change_jobs(job_id,plan_id,confirmed_by,confirmer_permission_version)
             VALUES($1,$2,$3,1)`,
            [nextJob, randomUUID(), manager],
          ),
          '23503',
        );
        // The plan row answers the action that the worker runs, and the confirmer stays stored.
        const detail = await adminRow(
          `SELECT p.action,j.confirmed_by,j.confirmer_permission_version
           FROM cc.user_schema_change_jobs j JOIN cc.user_category_plans p ON p.plan_id=j.plan_id
           WHERE j.job_id=$1`,
          [jobId],
        );
        assert.deepEqual(detail, {
          action: 'create-category',
          confirmed_by: manager,
          confirmer_permission_version: 1,
        });
      },
    );

    await check(
      'K14 deleting a category job removes its detail row and not its plan',
      async () => {
        const jobId = jobs[0];
        const planId = plans[0];
        await migrator.query('DELETE FROM cc.jobs WHERE job_id=$1', [jobId]);
        jobs.splice(jobs.indexOf(jobId), 1);
        const detail = await adminRow(
          'SELECT count(*)::integer AS rows FROM cc.user_schema_change_jobs WHERE job_id=$1',
          [jobId],
        );
        assert.equal(detail.rows, 0);
        const plan = await adminRow(
          'SELECT count(*)::integer AS rows FROM cc.user_category_plans WHERE plan_id=$1',
          [planId],
        );
        assert.equal(plan.rows, 1);
      },
    );
  } finally {
    for (const id of jobs)
      await migrator.query('DELETE FROM cc.jobs WHERE job_id=$1', [id]);
    for (const id of plans)
      await migrator.query(
        'DELETE FROM cc.user_category_plans WHERE plan_id=$1',
        [id],
      );
    for (const id of principals) {
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
    throw new Error(
      `User attribute category checks failed: ${failures.join(' | ')}`,
    );
  return results;
}
