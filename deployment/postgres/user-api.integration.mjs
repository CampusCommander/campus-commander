import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * K8: the users API SQL. The read gate accepts users:read, the sync state reads as the connection
 * answers, the abandon reads its one failure, the attribute helpers answer the filter of
 * baseline default 4, and the category cache of document B section 9 replaces its whole set.
 */
export async function qualifyUserApi({
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
  const users = [];
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
  const rejects = async (promise, code, detail) => {
    try {
      await promise;
    } catch (error) {
      if (code && error.code !== code)
        throw new Error(
          `error ${error.code} instead of ${code}: ${error.message}`,
        );
      if (detail && error.detail !== detail)
        throw new Error(
          `detail ${error.detail} instead of ${detail}: ${error.message}`,
        );
      return error;
    }
    throw new Error(`expected a rejection ${code ?? ''}`);
  };
  const createPrincipal = async (label, grants, options = {}) => {
    const id = randomUUID();
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name,permission_version,enabled) VALUES($1,$2,$3,$4,$5,$6)',
      [
        id,
        issuer,
        `k8-${label}-${id}`,
        `K8 ${label}`,
        options.version ?? 1,
        options.enabled ?? true,
      ],
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

  const reader = await createPrincipal('reader', [district('users:read')]);
  const deviceOnly = await createPrincipal('device-only', [
    district('devices:read'),
  ]);
  const disabled = await createPrincipal('disabled', [district('users:read')], {
    enabled: false,
  });
  const staleVersion = await createPrincipal('stale-version', [
    district('users:read'),
  ]);
  const platform = await createPrincipal('platform', [
    ['users:read', { kind: 'platform' }],
  ]);

  try {
    await check(
      'K8 the read gate accepts users:read for the district',
      async () => {
        const row = await adminRow('SELECT * FROM cc.user_reader($1,$2)', [
          reader,
          1,
        ]);
        assert.equal(row.customer_id, customer);
        assert.equal(row.generation, generation);
        const platformRow = await adminRow(
          'SELECT * FROM cc.user_reader($1,$2)',
          [platform, 1],
        );
        assert.equal(platformRow.customer_id, customer);
      },
    );

    await check('K8 the read gate refuses a device-only grant', async () => {
      await rejects(
        result('SELECT cc.read_user_sync($1,$2) AS result', [deviceOnly, 1]),
        '42501',
      );
      await rejects(
        adminRow('SELECT * FROM cc.user_reader($1,$2)', [deviceOnly, 1]),
        '42501',
      );
    });

    await check('K8 the read gate refuses a disabled principal', async () => {
      await rejects(
        result('SELECT cc.read_user_sync($1,$2) AS result', [disabled, 1]),
        '42501',
      );
    });

    await check(
      'K8 the read gate refuses a stale permission version',
      async () => {
        await rejects(
          result('SELECT cc.read_user_sync($1,$2) AS result', [reader, 2]),
          '42501',
        );
      },
    );

    await check(
      'K8 the sync state carries the projection of the customer',
      async () => {
        const state = await result(
          'SELECT cc.read_user_sync($1,$2) AS result',
          [reader, 1],
        );
        assert.equal(state.customerId, customer);
        assert.equal(typeof state.generation, 'number');
        assert.equal(typeof state.status, 'string');
        assert.equal(typeof state.userCount, 'number');
        assert.equal(typeof state.stale, 'boolean');
        assert.equal(
          state.observedAt === null || typeof state.observedAt === 'string',
          true,
        );
      },
    );

    await check('K8 the abandon refuses any other failure', async () => {
      await rejects(
        result('SELECT cc.abandon_user_sync($1,$2,$3,$4,$5) AS result', [
          reader,
          1,
          customer,
          randomUUID(),
          'other',
        ]),
        '22023',
      );
      await rejects(
        result('SELECT cc.abandon_user_sync($1,$2,$3,$4,$5) AS result', [
          reader,
          1,
          customer,
          null,
          'orchestration-unavailable',
        ]),
        '22023',
      );
    });

    await check('K8 the abandon refuses a device-only grant', async () => {
      await rejects(
        result('SELECT cc.abandon_user_sync($1,$2,$3,$4,$5) AS result', [
          deviceOnly,
          1,
          customer,
          randomUUID(),
          'orchestration-unavailable',
        ]),
        '42501',
      );
    });

    await check('K8 an unknown sync abandons nothing', async () => {
      const answer = await result(
        'SELECT cc.abandon_user_sync($1,$2,$3,$4,$5) AS result',
        [reader, 1, customer, randomUUID(), 'orchestration-unavailable'],
      );
      assert.equal(answer.customerId, customer);
      assert.equal(typeof answer.status, 'string');
    });

    await check(
      'K8 the attribute helpers read a value, a list, and a number',
      async () => {
        const single = await adminRow(
          `SELECT cc.user_attribute_values('"B12"'::jsonb) AS values,
          cc.user_attribute_has_value('"No"'::jsonb) AS present`,
        );
        assert.deepEqual(single.values, ['B12']);
        assert.equal(single.present, true);

        const list = await adminRow(
          `SELECT cc.user_attribute_values('[{"value":"a"},{"value":"b"}]'::jsonb) AS values`,
        );
        assert.deepEqual(list.values, ['a', 'b']);

        const empty = await adminRow(
          `SELECT cc.user_attribute_values('[]'::jsonb) AS values,
          cc.user_attribute_has_value('[]'::jsonb) AS present,
          cc.user_attribute_has_value('null'::jsonb) AS absent,
          cc.user_attribute_has_value('false'::jsonb) AS no_answer,
          cc.user_attribute_has_value(NULL::jsonb) AS nothing`,
        );
        assert.deepEqual(empty.values, []);
        assert.equal(empty.present, false);
        assert.equal(empty.absent, false);
        assert.equal(empty.no_answer, true);
        assert.equal(empty.nothing, false);

        const numbers = await adminRow(
          `SELECT cc.user_attribute_numbers('7'::jsonb) AS num,
          cc.user_attribute_numbers('"8.5"'::jsonb) AS text,
          cc.user_attribute_numbers('"abc"'::jsonb) AS other,
          cc.user_attribute_numbers('["3","x"]'::jsonb) AS mixed`,
        );
        assert.deepEqual(numbers.num, [7]);
        assert.deepEqual(numbers.text, [8.5]);
        assert.deepEqual(numbers.other, []);
        assert.deepEqual(numbers.mixed, [3]);
      },
    );

    const userId = `k8-${randomUUID()}`;
    users.push(userId);
    await migrator.query(
      `INSERT INTO cc.users(customer_id,user_id,primary_email,org_unit_path,suspended,archived,
        two_step_enrolled,last_entity_sync,custom_schemas)
       VALUES($1,$2,$3,'/K8',false,false,true,clock_timestamp(),$4)`,
      [
        customer,
        userId,
        `${userId}@example.org`,
        JSON.stringify({
          StudentInfo: { Homeroom: 'B12', GradeLevel: 7, Programs: ['A', 'B'] },
        }),
      ],
    );
    const field = (fieldName, fieldType) => ({
      fieldId: `${fieldName}-id`,
      fieldName,
      displayName: fieldName,
      fieldType,
      multiValued: fieldName === 'Programs',
      indexed: true,
      readAccessType: 'ADMINS_AND_SELF',
      numericIndexingSpec: null,
    });
    const categories = [
      {
        schemaId: 'student-info',
        schemaName: 'StudentInfo',
        displayName: 'Student info',
        etag: '"etag-1"',
        fields: [
          field('Homeroom', 'STRING'),
          field('GradeLevel', 'INT64'),
          field('Programs', 'STRING'),
          field('Empty', 'BOOL'),
        ],
      },
    ];

    await check(
      'K8 a category read answers the holders of each attribute',
      async () => {
        const stored = await result(
          'SELECT cc.replace_user_attribute_categories($1,$2,$3,$4,$5) AS result',
          [
            reader,
            1,
            customer,
            JSON.stringify(categories),
            '2026-01-01T00:00:00Z',
          ],
        );
        assert.equal(stored.categories.length, 1);
        const [category] = stored.categories;
        assert.equal(category.schemaName, 'StudentInfo');
        assert.equal(category.holders, 1);
        assert.deepEqual(
          category.fields.map((entry) => [entry.fieldName, entry.holders]),
          [
            ['Homeroom', 1],
            ['GradeLevel', 1],
            ['Programs', 1],
            ['Empty', 0],
          ],
        );
        assert.equal(category.readAt, '2026-01-01T00:00:00+00:00');
        assert.deepEqual(stored.limits, {
          categories: 1,
          categoryLimit: 100,
          attributes: 4,
          attributeLimit: 100,
        });
        assert.equal(stored.observedAt, '2026-01-01T00:00:00+00:00');
      },
    );

    await check('K8 a second read replaces the whole cached set', async () => {
      const stored = await result(
        'SELECT cc.replace_user_attribute_categories($1,$2,$3,$4,$5) AS result',
        [reader, 1, customer, '[]', '2026-01-02T00:00:00Z'],
      );
      assert.deepEqual(stored.categories, []);
      assert.deepEqual(stored.limits, {
        categories: 0,
        categoryLimit: 100,
        attributes: 0,
        attributeLimit: 100,
      });
      assert.equal(stored.observedAt, null);
    });

    await check('K8 the category store refuses an invalid set', async () => {
      await rejects(
        result(
          'SELECT cc.replace_user_attribute_categories($1,$2,$3,$4,$5) AS result',
          [reader, 1, customer, '{"a":1}', '2026-01-02T00:00:00Z'],
        ),
        '22023',
      );
      await rejects(
        result(
          'SELECT cc.replace_user_attribute_categories($1,$2,$3,$4,$5) AS result',
          [reader, 1, customer, '[]', null],
        ),
        '22023',
      );
      await rejects(
        result(
          'SELECT cc.replace_user_attribute_categories($1,$2,$3,$4,$5) AS result',
          [reader, 1, 'C0000000', '[]', '2026-01-02T00:00:00Z'],
        ),
        'P0001',
        'connection-changed',
      );
    });

    await check(
      'K8 the category read refuses a device-only grant',
      async () => {
        await rejects(
          result('SELECT cc.read_user_attribute_categories($1,$2) AS result', [
            deviceOnly,
            1,
          ]),
          '42501',
        );
      },
    );

    await check('K8 the category credential needs users:read', async () => {
      await rejects(
        result('SELECT cc.user_read_credential($1,$2,$3,$4) AS result', [
          deviceOnly,
          1,
          customer,
          generation,
        ]),
        '42501',
      );
      const expected = await adminRow(
        'SELECT envelope FROM cc.google_credentials WHERE id=$1',
        [connection.credential_id],
      );
      const claim = await result(
        'SELECT cc.user_read_credential($1,$2,$3,$4) AS result',
        [reader, 1, customer, generation],
      );
      assert.equal(claim.customerId, customer);
      assert.equal(claim.generation, generation);
      assert.equal(claim.credentialId, connection.credential_id);
      assert.deepEqual(claim.envelope, expected.envelope);
      await rejects(
        result('SELECT cc.user_read_credential($1,$2,$3,$4) AS result', [
          reader,
          1,
          customer,
          generation + 1,
        ]),
        'P0001',
        'credential-changed',
      );
    });

    await check(
      'K8 the runtime role cannot read a credential table',
      async () => {
        await rejects(
          runtime.query('SELECT envelope FROM cc.google_credentials'),
          '42501',
        );
      },
    );

    await check(
      'K8 PUBLIC holds no EXECUTE on the gated functions',
      async () => {
        const privileges = await adminRow(
          `SELECT count(DISTINCT p.oid)::integer AS present,
          COALESCE(bool_or(a.grantee=0),false) AS public_grant,
          COALESCE(bool_or(a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1)),false) AS role_grant
         FROM pg_proc p LEFT JOIN aclexplode(p.proacl) a ON true
         WHERE p.oid=ANY(ARRAY[
           to_regprocedure('cc.user_reader(uuid,integer)'),
           to_regprocedure('cc.visible_user_sync(uuid,integer,text)'),
           to_regprocedure('cc.read_user_sync(uuid,integer)'),
           to_regprocedure('cc.abandon_user_sync(uuid,integer,text,uuid,text)'),
           to_regprocedure('cc.user_attribute_categories_projection(text)'),
           to_regprocedure('cc.read_user_attribute_categories(uuid,integer)'),
           to_regprocedure('cc.replace_user_attribute_categories(uuid,integer,text,jsonb,timestamptz)'),
           to_regprocedure('cc.user_read_credential(uuid,integer,text,integer)')])`,
          [role],
        );
        assert.equal(privileges.present, 8);
        assert.equal(privileges.public_grant, false);
        assert.equal(privileges.role_grant, true);
      },
    );
  } finally {
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
    for (const id of users)
      await migrator.query('DELETE FROM cc.users WHERE user_id=$1', [id]);
    await migrator.query(
      'DELETE FROM cc.user_attribute_categories WHERE customer_id=$1',
      [customer],
    );
    await migrator.query('UPDATE cc.google_connection SET active=$1', [
      wasActive,
    ]);
  }

  if (failures.length)
    throw new Error(
      `${failures.length} user API checks failed: ${failures.join(', ')}`,
    );
  return results;
}
