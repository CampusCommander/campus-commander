import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * K5: the user inventory tables, the schema cache, and the typed read gate of the refresh path.
 * A device refresh needs devices:read and a user refresh needs users:read (document A section 8).
 */
export async function qualifyUserInventory({
  runtime,
  migrator,
  issuer,
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
  await migrator.query('UPDATE cc.google_connection SET active=true');
  const principals = [];
  const jobs = [];
  const results = [];
  const failures = [];
  const result = (text, values = []) =>
    runtime.query(text, values).then((rows) => rows.rows[0]?.result);
  const adminRow = (text, values = []) =>
    migrator.query(text, values).then((rows) => rows.rows[0]);
  const role = (await runtime.query('SELECT current_user AS name')).rows[0]
    .name;
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
  const createPrincipal = async (label, grants) => {
    const id = randomUUID();
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$4)',
      [id, issuer, `k5-${label}-${id}`, `K5 ${label}`],
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
  const createJob = (actor, type, ids) => {
    const job = randomUUID();
    return result(
      'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
      [actor, customer, type, JSON.stringify(ids), 1000, job, randomUUID()],
    ).then((answer) => {
      if (answer?.jobId) jobs.push(answer.jobId);
      return answer;
    });
  };
  const countEntityJobs = async (type) =>
    Number(
      (
        await adminRow(
          'SELECT count(*) AS count FROM cc.entity_sync_jobs WHERE customer_id=$1 AND entity_type=$2',
          [customer, type],
        )
      ).count,
    );
  const user = (userId, extra = {}) => ({
    customer_id: customer,
    user_id: userId,
    primary_email: `${userId}@example.org`,
    org_unit_path: '/Students',
    given_name: 'Robin',
    family_name: 'Avery',
    full_name: 'Robin Avery',
    suspended: false,
    suspension_reason: null,
    archived: false,
    last_login_time: null,
    creation_time: null,
    two_step_enrolled: true,
    department: null,
    title: null,
    aliases: [],
    custom_schemas: {},
    last_entity_sync: new Date().toISOString(),
    ...extra,
  });
  try {
    const devicesOnly = await createPrincipal('devices-only', [
      district('devices:read'),
    ]);
    const usersOnly = await createPrincipal('users-only', [
      district('users:read'),
    ]);

    await check(
      'a fresh database runs every migration through 020',
      async () => {
        const ids = (
          await migrator.query(
            'SELECT id FROM cc.schema_migrations ORDER BY id',
          )
        ).rows.map((row) => row.id);
        assert.equal(ids.at(-1), '020-user-sync');
        assert.equal(ids.length, 20);
      },
    );

    await check(
      'the user inventory holds its tables, indexes, and record version',
      async () => {
        for (const table of [
          'cc.users',
          'cc.user_sync_state',
          'cc.user_attribute_categories',
        ])
          assert.notEqual(
            (await adminRow('SELECT to_regclass($1) AS name', [table])).name,
            null,
            `${table} exists`,
          );
        const indexes = (
          await migrator.query(
            "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='cc' AND tablename='users'",
          )
        ).rows;
        for (const index of [
          'users_name',
          'users_email',
          'users_org_unit',
          'users_last_login',
          'users_freshness',
          'users_custom_schemas',
        ])
          assert.ok(
            indexes.some((row) => row.indexname === index),
            `${index} exists`,
          );
        assert.match(
          indexes.find((row) => row.indexname === 'users_custom_schemas')
            .indexdef,
          /gin .*jsonb_path_ops/,
        );
        await migrator.query(
          'INSERT INTO cc.users(customer_id,user_id,primary_email,org_unit_path,suspended,archived,two_step_enrolled,custom_schemas,last_entity_sync) VALUES($1,$2,$3,$4,false,false,true,$5,clock_timestamp())',
          [
            customer,
            '107000000000000000001',
            'robin.avery@example.org',
            '/Students/Grade 7',
            JSON.stringify({ StudentInfo: { Homeroom: 'B12' } }),
          ],
        );
        const version = async () =>
          Number(
            (
              await adminRow(
                'SELECT record_version FROM cc.users WHERE customer_id=$1 AND user_id=$2',
                [customer, '107000000000000000001'],
              )
            ).record_version,
          );
        assert.equal(await version(), 1);
        await migrator.query(
          'UPDATE cc.users SET title=$2 WHERE customer_id=$1 AND user_id=$3',
          [customer, 'Science lead', '107000000000000000001'],
        );
        assert.equal(await version(), 2);
        await migrator.query(
          'UPDATE cc.users SET title=title WHERE customer_id=$1 AND user_id=$2',
          [customer, '107000000000000000001'],
        );
        assert.equal(
          await version(),
          2,
          'An update that changes nothing keeps the version.',
        );
        await rejects(
          migrator.query(
            'UPDATE cc.users SET custom_schemas=$3 WHERE customer_id=$1 AND user_id=$2',
            [customer, '107000000000000000001', JSON.stringify([])],
          ),
        );
        await migrator.query(
          'DELETE FROM cc.users WHERE customer_id=$1 AND user_id=$2',
          [customer, '107000000000000000001'],
        );
      },
    );

    await check(
      'the schema cache holds one row for each category and its fields',
      async () => {
        const fields = [
          {
            fieldId: '00f1',
            fieldName: 'Homeroom',
            displayName: 'Homeroom',
            fieldType: 'STRING',
            multiValued: false,
            indexed: true,
            readAccessType: 'ADMINS_AND_SELF',
          },
        ];
        const insert = (schemaId, schemaName) =>
          migrator.query(
            'INSERT INTO cc.user_attribute_categories(customer_id,schema_id,schema_name,display_name,etag,fields) VALUES($1,$2,$3,$4,$5,$6)',
            [
              customer,
              schemaId,
              schemaName,
              'Student information',
              '"abc123"',
              JSON.stringify(fields),
            ],
          );
        await insert('schem-1', 'StudentInfo');
        assert.deepEqual(
          (
            await adminRow(
              'SELECT fields FROM cc.user_attribute_categories WHERE customer_id=$1 AND schema_id=$2',
              [customer, 'schem-1'],
            )
          ).fields,
          fields,
        );
        await rejects(insert('schem-2', 'StudentInfo'));
        await rejects(
          migrator.query(
            'INSERT INTO cc.user_attribute_categories(customer_id,schema_id,schema_name,display_name,fields) VALUES($1,$2,$3,$4,$5)',
            [customer, 'schem-3', 'Student Info', 'Student information', '[]'],
          ),
        );
        await migrator.query(
          'DELETE FROM cc.user_attribute_categories WHERE customer_id=$1',
          [customer],
        );
      },
    );

    await check(
      'the entity type check accepts user and refuses another value',
      async () => {
        const refused = await rejects(
          migrator.query(
            "INSERT INTO cc.entity_sync_jobs(job_id,customer_id,entity_type,generation,ids,batch_size,batch_count,correlation_id) VALUES($1,$2,'group',1,$3,1000,1,$4)",
            [
              randomUUID(),
              customer,
              JSON.stringify(['107000000000000000001']),
              randomUUID(),
            ],
          ),
        );
        assert.equal(refused.constraint, 'entity_sync_jobs_entity_type_check');
      },
    );

    const userJobsBefore = await countEntityJobs('user');
    const deviceJobsBefore = await countEntityJobs('device');

    await check(
      'a principal with only devices:read lists no user refresh job',
      async () => {
        const denied = await rejects(
          result('SELECT cc.entity_job_reader($1,1,$2) AS result', [
            devicesOnly,
            'user',
          ]),
          '42501',
        );
        assert.equal(denied.message, 'User read authority is required.');
        const creation = await rejects(
          createJob(devicesOnly, 'user', ['107000000000000000001']),
          '42501',
        );
        assert.equal(creation.message, 'User read authority is required.');
        assert.equal(await countEntityJobs('user'), userJobsBefore);
        const created = await createJob(usersOnly, 'user', [
          '107000000000000000001',
          '107000000000000000002',
        ]);
        assert.equal(created.entityType, 'user');
        assert.equal(created.batchCount, 1);
        assert.equal(await countEntityJobs('user'), userJobsBefore + 1);
        // The jobs list applies cc.job_visible, so a devices:read-only principal lists no user job.
        const visible = (actor, requester) =>
          adminRow('SELECT cc.job_visible($1,1,$2,$3) AS visible', [
            actor,
            customer,
            requester,
          ]).then((row) => row.visible);
        assert.equal(await visible(devicesOnly, usersOnly), false);
        assert.equal(await visible(usersOnly, usersOnly), true);
        // The refusal covers the rest of the refresh path, not the creation alone.
        await rejects(
          result('SELECT cc.abandon_entity_sync_job($1,1,$2,$3) AS result', [
            devicesOnly,
            customer,
            created.jobId,
          ]),
          '42501',
        );
        const abandoned = await result(
          'SELECT cc.abandon_entity_sync_job($1,1,$2,$3) AS result',
          [usersOnly, customer, created.jobId],
        );
        assert.equal(abandoned.jobId, created.jobId);
        assert.equal(abandoned.failure, 'orchestration-unavailable');
        const header = await adminRow(
          'SELECT status,failure FROM cc.jobs WHERE job_id=$1',
          [created.jobId],
        );
        assert.deepEqual(header, {
          status: 'failed',
          failure: 'orchestration-unavailable',
        });
      },
    );

    await check(
      'a principal with only users:read starts no device refresh job',
      async () => {
        const denied = await rejects(
          createJob(usersOnly, 'device', ['k5-device-1']),
          '42501',
        );
        assert.equal(denied.message, 'Device read authority is required.');
        assert.equal(await countEntityJobs('device'), deviceJobsBefore);
        const created = await createJob(devicesOnly, 'device', ['k5-device-1']);
        assert.equal(created.entityType, 'device');
        assert.equal(await countEntityJobs('device'), deviceJobsBefore + 1);
        await result(
          'SELECT cc.abandon_entity_sync_job($1,1,$2,$3) AS result',
          [devicesOnly, customer, created.jobId],
        );
      },
    );

    await check(
      'the users:read action takes the platform and district scopes only',
      async () => {
        const action = await adminRow(
          'SELECT scope_kinds FROM cc.application_actions WHERE action=$1',
          ['users:read'],
        );
        assert.deepEqual(action.scope_kinds, ['platform', 'district']);
        await migrator.query(
          'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
          [devicesOnly, 'users:read', JSON.stringify({ kind: 'platform' })],
        );
        await rejects(
          migrator.query(
            'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
            [
              devicesOnly,
              'users:read',
              JSON.stringify({
                kind: 'school',
                customerId: customer,
                schoolId: randomUUID(),
              }),
            ],
          ),
        );
        await migrator.query(
          "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='users:read'",
          [devicesOnly],
        );
      },
    );

    await check(
      'the runtime reads the gate and writes no user row',
      async () => {
        assert.equal(
          (
            await adminRow(
              'SELECT has_function_privilege($1,$2,$3) AS allowed',
              [role, 'cc.entity_job_reader(uuid,integer,text)', 'EXECUTE'],
            )
          ).allowed,
          true,
          'The runtime calls the typed gate.',
        );
        assert.equal(
          (
            await adminRow(
              'SELECT has_function_privilege($1,$2,$3) AS allowed',
              [role, 'cc.bump_user_record_version()', 'EXECUTE'],
            )
          ).allowed,
          false,
          'The trigger function stays with the migrator.',
        );
        await rejects(
          runtime.query(
            'INSERT INTO cc.users(customer_id,user_id,primary_email,org_unit_path,suspended,archived,two_step_enrolled,last_entity_sync) VALUES($1,$2,$3,$4,false,false,true,clock_timestamp())',
            [
              customer,
              '107000000000000000009',
              'writer@example.org',
              '/Students',
            ],
          ),
          '42501',
        );
        await rejects(runtime.query('SELECT cc.bump_user_record_version()'));
      },
    );

    await check(
      'the typed gate keeps PUBLIC out and refuses an untrusted role',
      async () => {
        const acl = await adminRow(
          `SELECT p.proacl IS NOT NULL AS acl_set,
            NOT EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) AS no_public_grant
           FROM pg_proc p
           WHERE p.oid=to_regprocedure('cc.entity_job_reader(uuid,integer,text)')`,
        );
        assert.equal(acl.acl_set, true, 'The gate records an explicit ACL.');
        assert.equal(
          acl.no_public_grant,
          true,
          'The gate grants PUBLIC no EXECUTE.',
        );
        // A role with schema USAGE and no function grant is refused by the database.
        const name = `cc-k5-outsider-${randomUUID().slice(0, 8)}`;
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
          const granted = await outsider.query(
            `SELECT has_function_privilege(current_user,'cc.entity_job_reader(uuid,integer,text)','EXECUTE') AS granted`,
          );
          assert.equal(
            granted.rows[0].granted,
            false,
            'The gate grants an outsider no EXECUTE.',
          );
          const denied = await rejects(
            outsider.query('SELECT cc.entity_job_reader($1,1,$2) AS result', [
              usersOnly,
              'user',
            ]),
            '42501',
          );
          assert.match(
            denied.message,
            /permission denied for function entity_job_reader/,
          );
        } finally {
          if (outsider !== undefined) await close(outsider);
          await adminSession
            .query(`DROP ROLE IF EXISTS "${name}"`)
            .catch(() => undefined);
          await close(adminSession);
        }
      },
    );
    await check(
      'request_user_sync needs users:read and a matching connection generation',
      async () => {
        const syncId = randomUUID();
        const denied = await rejects(
          result('SELECT cc.request_user_sync($1,1,$2,$3,$4,$5) AS result', [
            devicesOnly,
            customer,
            generation,
            syncId,
            randomUUID(),
          ]),
          '42501',
        );
        assert.equal(denied.message, 'User read authority is required.');
        await rejects(
          result('SELECT cc.request_user_sync($1,1,$2,$3,$4,$5) AS result', [
            usersOnly,
            customer,
            generation + 1,
            syncId,
            randomUUID(),
          ]),
          'P0001',
        );
      },
    );

    await check(
      'a full user sync stores raw customSchemas and marks a missing user removed',
      async () => {
        const syncId = randomUUID();
        const correlationId = randomUUID();
        await migrator.query(
          'INSERT INTO cc.users(customer_id,user_id,primary_email,org_unit_path,suspended,archived,two_step_enrolled,custom_schemas,last_entity_sync) VALUES($1,$2,$3,$4,false,false,true,$5,clock_timestamp())',
          [
            customer,
            '107000000000000000002',
            'gone@example.org',
            '/Students',
            JSON.stringify({}),
          ],
        );
        const requested = await result(
          'SELECT cc.request_user_sync($1,1,$2,$3,$4,$5) AS result',
          [usersOnly, customer, generation, syncId, correlationId],
        );
        assert.equal(requested.status, 'running');
        jobs.push(syncId);
        const attempt = randomUUID();
        const claim = await result(
          'SELECT cc.claim_user_sync($1,$2,$3) AS result',
          [customer, syncId, attempt],
        );
        assert.equal(Number(claim.generation), generation);
        const raw = { StudentInfo: { GradeLevel: 7, Homeroom: 'B12' } };
        const staged = await result(
          'SELECT cc.stage_users($1,$2,$3,$4) AS result',
          [
            customer,
            syncId,
            attempt,
            JSON.stringify([
              {
                userId: '107000000000000000001',
                primaryEmail: 'robin.avery@example.org',
                orgUnitPath: '/Students/Grade 7',
                givenName: 'Robin',
                familyName: 'Avery',
                fullName: 'Robin Avery',
                suspended: false,
                suspensionReason: null,
                archived: false,
                lastLoginTime: null,
                creationTime: null,
                twoStepEnrolled: true,
                department: null,
                title: null,
                aliases: [],
                customSchemas: raw,
              },
            ]),
          ],
        );
        assert.equal(Number(staged), 1);
        const finished = await result(
          'SELECT cc.finish_user_sync($1,$2,$3,$4) AS result',
          [customer, syncId, attempt, null],
        );
        assert.equal(finished.status, 'ready');
        assert.equal(Number(finished.userCount), 1);
        const kept = await adminRow(
          'SELECT primary_email,custom_schemas,removed_at FROM cc.users WHERE customer_id=$1 AND user_id=$2',
          [customer, '107000000000000000001'],
        );
        assert.equal(kept.primary_email, 'robin.avery@example.org');
        assert.deepEqual(kept.custom_schemas, raw);
        assert.equal(kept.removed_at, null);
        const gone = await adminRow(
          'SELECT removed_at FROM cc.users WHERE customer_id=$1 AND user_id=$2',
          [customer, '107000000000000000002'],
        );
        assert.notEqual(
          gone.removed_at,
          null,
          'A user that Google no longer returns stays with removed_at.',
        );
        const records = await result(
          'SELECT cc.page_user_records($1,$2,$3) AS result',
          [customer, '', 1000],
        );
        assert.deepEqual(
          records.map((entry) => entry.record.userId),
          ['107000000000000000001'],
          'Removed users stay out of the page.',
        );
        assert.deepEqual(records[0].record.customSchemas, raw);
        const removed = await result(
          'SELECT cc.page_last_removed_user_ids($1,$2,$3) AS result',
          [customer, '', 1000],
        );
        assert.deepEqual(removed, ['107000000000000000002']);
      },
    );

    await check(
      '020 grants EXECUTE to the runtime and keeps PUBLIC and an outsider out',
      async () => {
        for (const signature of [
          'cc.request_user_sync(uuid,integer,text,integer,uuid,uuid)',
          'cc.claim_user_sync(text,uuid,uuid)',
          'cc.stage_users(text,uuid,uuid,jsonb)',
          'cc.finish_user_sync(text,uuid,uuid,text)',
          'cc.upsert_users(text,jsonb,timestamp with time zone)',
          'cc.soft_delete_users(text,jsonb)',
          'cc.page_user_records(text,text,integer)',
          'cc.page_last_removed_user_ids(text,text,integer)',
          'cc.user_record(cc.users)',
          'cc.user_sync_projection(text)',
        ])
          assert.equal(
            (
              await adminRow(
                'SELECT has_function_privilege($1,$2,$3) AS allowed',
                [role, signature, 'EXECUTE'],
              )
            ).allowed,
            true,
            `The runtime executes ${signature}.`,
          );
        const acl = await adminRow(
          `SELECT p.proacl IS NOT NULL AS acl_set,
            NOT EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) AS no_public_grant
           FROM pg_proc p
           WHERE p.oid=to_regprocedure('cc.request_user_sync(uuid,integer,text,integer,uuid,uuid)')`,
        );
        assert.equal(acl.acl_set, true);
        assert.equal(acl.no_public_grant, true);
        const name = `cc-k7-outsider-${randomUUID().slice(0, 8)}`;
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
          const denied = await rejects(
            outsider.query('SELECT cc.claim_user_sync($1,$2,$3) AS result', [
              customer,
              randomUUID(),
              randomUUID(),
            ]),
            '42501',
          );
          assert.match(
            denied.message,
            /permission denied for function claim_user_sync/,
          );
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
    try {
      await migrator.query('DELETE FROM cc.jobs WHERE job_id=ANY($1::uuid[])', [
        jobs,
      ]);
      await migrator.query(
        'DELETE FROM cc.application_grants WHERE principal_id=ANY($1::uuid[])',
        [principals],
      );
      await migrator.query(
        'DELETE FROM cc.application_principals WHERE id=ANY($1::uuid[])',
        [principals],
      );
      await migrator.query('DELETE FROM cc.users WHERE customer_id=$1', [
        customer,
      ]);
      await migrator.query(
        'DELETE FROM cc.user_sync_state WHERE customer_id=$1',
        [customer],
      );
      await migrator.query(
        'DELETE FROM cc.user_attribute_categories WHERE customer_id=$1',
        [customer],
      );
      await migrator.query('UPDATE cc.google_connection SET active=$1', [
        wasActive,
      ]);
    } catch {
      /* A failed cleanup leaves fixture rows in a disposable database. */
    }
  }
  if (failures.length)
    throw new Error(`User inventory checks failed: ${failures.join(' | ')}`);
  return results;
}
