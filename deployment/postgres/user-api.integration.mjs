import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { UserAttributeCategoriesRoute } from '../../api/src/app/users/user-attribute-categories.ts';

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
  const waitForLock = async (pid) => {
    let blockers = [];
    for (let attempt = 0; attempt < 400; attempt++) {
      // pg_blocking_pids reads the lock manager and needs no pg_stat_activity visibility.
      const seen = await adminRow('SELECT pg_blocking_pids($1) AS blockers', [
        pid,
      ]);
      blockers = seen?.blockers ?? [];
      if (blockers.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `The call did not wait for its lock: ${JSON.stringify(blockers)}`,
    );
  };
  /** Start one user sync that the following call abandons. */
  const abandonJob = async (actor = reader, version = 1) => {
    const jobId = randomUUID();
    await result('SELECT cc.request_user_sync($1,$2,$3,$4,$5,$6) AS result', [
      actor,
      version,
      customer,
      generation,
      jobId,
      randomUUID(),
    ]);
    jobs.push(jobId);
    return jobId;
  };

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

    await check('K8 the abandon closes an undispatched user sync', async () => {
      const jobId = await abandonJob();
      const answer = await result(
        'SELECT cc.abandon_user_sync($1,$2,$3,$4,$5) AS result',
        [reader, 1, customer, jobId, 'orchestration-unavailable'],
      );
      assert.equal(answer.customerId, customer);
      assert.equal(answer.status, 'failed');
      const job = await adminRow(
        'SELECT status,failure FROM cc.jobs WHERE job_id=$1',
        [jobId],
      );
      assert.equal(job.status, 'failed');
      assert.equal(job.failure, 'orchestration-unavailable');
      const state = await adminRow(
        'SELECT sync_id FROM cc.user_sync_state WHERE customer_id=$1',
        [customer],
      );
      assert.equal(state.sync_id, null);
    });

    await check('K8 the abandon revalidates after a lock wait', async () => {
      const jobId = await abandonJob();
      const blocker = await connect('cc-migrator', 'cc-app');
      const worker = await connect('cc-app', 'cc-app');
      try {
        const pid = (await worker.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid;
        const before = await adminRow(
          'SELECT revision FROM cc.jobs WHERE job_id=$1',
          [jobId],
        );
        const publications = await adminRow(
          'SELECT count(*)::integer AS n FROM cc.job_publications WHERE job_id=$1',
          [jobId],
        );
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT 1 FROM cc.user_sync_state WHERE customer_id=$1 FOR UPDATE',
          [customer],
        );
        const pending = worker.query(
          'SELECT cc.abandon_user_sync($1,$2,$3,$4,$5) AS result',
          [reader, 1, customer, jobId, 'orchestration-unavailable'],
        );
        pending.catch(() => undefined);
        await waitForLock(pid);
        // The revocation commits while the abandon holds no principal lock.
        await migrator.query(
          'UPDATE cc.application_principals SET permission_version=2 WHERE id=$1',
          [reader],
        );
        await blocker.query('COMMIT');
        await assert.rejects(pending, (error) => error.code === '42501');
        const after = await adminRow(
          'SELECT status,failure,revision FROM cc.jobs WHERE job_id=$1',
          [jobId],
        );
        assert.equal(after.status, 'running');
        assert.equal(after.failure, null);
        assert.equal(after.revision, before.revision);
        const state = await adminRow(
          'SELECT sync_id FROM cc.user_sync_state WHERE customer_id=$1',
          [customer],
        );
        assert.equal(state.sync_id, jobId);
        const publicationsAfter = await adminRow(
          'SELECT count(*)::integer AS n FROM cc.job_publications WHERE job_id=$1',
          [jobId],
        );
        assert.equal(publicationsAfter.n, publications.n);
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        await close(blocker);
        await close(worker);
        await migrator.query(
          'UPDATE cc.application_principals SET permission_version=1 WHERE id=$1',
          [reader],
        );
        // The refused call leaves the sync running. The control abandons it for the next check.
        await result('SELECT cc.abandon_user_sync($1,$2,$3,$4,$5) AS result', [
          reader,
          1,
          customer,
          jobId,
          'orchestration-unavailable',
        ]).catch(() => undefined);
      }
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
          cc.user_attribute_numbers('["3","x"]'::jsonb) AS mixed,
          cc.user_attribute_numbers('"1e1000000000"'::jsonb) AS huge,
          cc.user_attribute_numbers('["3","1e1000000000",4]'::jsonb) AS huge_mixed,
          cc.user_attribute_number('1e1000000000') AS huge_bound,
          cc.user_attribute_number('8.5') AS ordinary_bound`,
        );
        assert.deepEqual(numbers.num, [7]);
        assert.deepEqual(numbers.text, [8.5]);
        assert.deepEqual(numbers.other, []);
        assert.deepEqual(numbers.mixed, [3]);
        // A legal text value that numeric cannot represent is omitted, never cast (R5).
        assert.deepEqual(numbers.huge, []);
        assert.deepEqual(numbers.huge_mixed, [3, 4]);
        assert.equal(numbers.huge_bound, null);
        assert.equal(Number(numbers.ordinary_bound), 8.5);
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
      // The successful empty read keeps its observation time (R2).
      assert.equal(stored.observedAt, '2026-01-02T00:00:00+00:00');
    });

    await check(
      'K8 an empty category read stays current for its day',
      async () => {
        const clock = { now: Date.parse('2026-02-10T00:00:00.000Z') };
        let googleReads = 0;
        const route = new UserAttributeCategoriesRoute(
          {
            connection: async () => ({ customerId: customer, generation }),
            cached: async () =>
              result(
                'SELECT cc.read_user_attribute_categories($1,$2) AS result',
                [reader, 1],
              ),
            credential: async () => ({ token: 'example' }),
            read: async () => {
              googleReads += 1;
              return [];
            },
            store: async (_session, customerId, categories, readAt) =>
              result(
                'SELECT cc.replace_user_attribute_categories($1,$2,$3,$4,$5) AS result',
                [reader, 1, customerId, JSON.stringify(categories), readAt],
              ),
          },
          { now: () => clock.now },
        );
        // An empty snapshot from a day and an hour ago is stale.
        await result(
          'SELECT cc.replace_user_attribute_categories($1,$2,$3,$4,$5) AS result',
          [
            reader,
            1,
            customer,
            '[]',
            new Date(clock.now - 25 * 3_600_000).toISOString(),
          ],
        );
        const first = await route.read({});
        assert.equal(googleReads, 1);
        assert.deepEqual(first.categories, []);
        assert.equal(Date.parse(first.observedAt), clock.now);
        const second = await route.read({});
        assert.equal(googleReads, 1);
        assert.equal(second.observedAt, first.observedAt);
        clock.now += 24 * 3_600_000;
        await route.read({});
        assert.equal(googleReads, 2);
      },
    );

    await check(
      'K8 concurrent replacements keep one complete snapshot',
      async () => {
        const snapshot = (names, readAt) => [
          JSON.stringify(
            names.map((name) => ({
              schemaId: `schema-${name}`,
              schemaName: name,
              displayName: `Category ${name}`,
              etag: null,
              fields: [field(`${name}Field`, 'STRING')],
            })),
          ),
          readAt,
        ];
        const first = await connect('cc-app', 'cc-app');
        const second = await connect('cc-app', 'cc-app');
        const stored = async () =>
          (
            await adminRow(
              'SELECT array_agg(schema_name ORDER BY schema_name) AS names FROM cc.user_attribute_categories WHERE customer_id=$1',
              [customer],
            )
          ).names;
        try {
          await result(
            'SELECT cc.replace_user_attribute_categories($1,$2,$3,$4,$5) AS result',
            [reader, 1, customer, '[]', '2026-01-03T00:00:00Z'],
          );
          const pid = (await second.query('SELECT pg_backend_pid() AS pid'))
            .rows[0].pid;
          // Disjoint snapshots: the second replaces the first whole.
          const [alpha, alphaAt] = snapshot(['Alpha'], '2026-01-04T00:00:00Z');
          const [beta, betaAt] = snapshot(['Beta'], '2026-01-05T00:00:00Z');
          await first.query('BEGIN');
          await first.query(
            'SELECT cc.replace_user_attribute_categories($1,$2,$3,$4,$5) AS result',
            [reader, 1, customer, alpha, alphaAt],
          );
          const pendingBeta = second.query(
            'SELECT cc.replace_user_attribute_categories($1,$2,$3,$4,$5) AS result',
            [reader, 1, customer, beta, betaAt],
          );
          pendingBeta.catch(() => undefined);
          await waitForLock(pid);
          await first.query('COMMIT');
          await pendingBeta;
          assert.deepEqual(await stored(), ['Beta']);
          // Overlapping snapshots: no unique conflict and no merged set.
          const [overlapA, overlapAAt] = snapshot(
            ['Beta', 'Gamma'],
            '2026-01-06T00:00:00Z',
          );
          const [overlapB, overlapBAt] = snapshot(
            ['Gamma', 'Delta'],
            '2026-01-07T00:00:00Z',
          );
          await first.query('BEGIN');
          await first.query(
            'SELECT cc.replace_user_attribute_categories($1,$2,$3,$4,$5) AS result',
            [reader, 1, customer, overlapA, overlapAAt],
          );
          const pendingOverlap = second.query(
            'SELECT cc.replace_user_attribute_categories($1,$2,$3,$4,$5) AS result',
            [reader, 1, customer, overlapB, overlapBAt],
          );
          pendingOverlap.catch(() => undefined);
          await waitForLock(pid);
          await first.query('COMMIT');
          await pendingOverlap;
          assert.deepEqual(await stored(), ['Delta', 'Gamma']);
        } finally {
          await first.query('ROLLBACK').catch(() => undefined);
          await close(first);
          await close(second);
        }
      },
    );

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
      'K8 every gated function keeps PUBLIC and an outsider out',
      async () => {
        const functions = [
          [
            'cc.user_reader(uuid,integer)',
            'SELECT * FROM cc.user_reader($1,$2)',
            [reader, 1],
          ],
          [
            'cc.visible_user_sync(uuid,integer,text)',
            'SELECT cc.visible_user_sync($1,$2,$3) AS result',
            [reader, 1, customer],
          ],
          [
            'cc.read_user_sync(uuid,integer)',
            'SELECT cc.read_user_sync($1,$2) AS result',
            [reader, 1],
          ],
          [
            'cc.abandon_user_sync(uuid,integer,text,uuid,text)',
            'SELECT cc.abandon_user_sync($1,$2,$3,$4,$5) AS result',
            [reader, 1, customer, randomUUID(), 'orchestration-unavailable'],
          ],
          [
            'cc.user_attribute_categories_projection(text)',
            'SELECT cc.user_attribute_categories_projection($1) AS result',
            [customer],
            false,
          ],
          [
            'cc.read_user_attribute_categories(uuid,integer)',
            'SELECT cc.read_user_attribute_categories($1,$2) AS result',
            [reader, 1],
          ],
          [
            'cc.replace_user_attribute_categories(uuid,integer,text,jsonb,timestamptz)',
            'SELECT cc.replace_user_attribute_categories($1,$2,$3,$4,$5) AS result',
            [reader, 1, customer, '[]', '2026-01-01T00:00:00Z'],
          ],
          [
            'cc.user_read_credential(uuid,integer,text,integer)',
            'SELECT cc.user_read_credential($1,$2,$3,$4) AS result',
            [reader, 1, customer, generation],
          ],
        ];
        for (const [signature, , , executable = true] of functions) {
          const allowed = (
            await adminRow(
              'SELECT has_function_privilege($1,$2,$3) AS allowed',
              [role, signature, 'EXECUTE'],
            )
          ).allowed;
          assert.equal(
            allowed,
            executable,
            executable
              ? `The runtime executes ${signature}.`
              : `The runtime cannot execute ${signature}.`,
          );
          // A null proacl carries the PostgreSQL default, which grants PUBLIC EXECUTE.
          const acl = await adminRow(
            `SELECT p.proacl IS NOT NULL AS acl_set,
              NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
                WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS no_public_grant
             FROM pg_proc p WHERE p.oid=to_regprocedure($1)`,
            [signature],
          );
          assert.equal(
            acl.acl_set,
            true,
            `${signature} carries an explicit ACL.`,
          );
          assert.equal(
            acl.no_public_grant,
            true,
            `PUBLIC cannot execute ${signature}.`,
          );
        }
        const name = `cc-k8-outsider-${randomUUID().slice(0, 8)}`;
        const admin = await connect('postgres', 'cc-app');
        let outsider;
        try {
          await admin.query(
            `CREATE ROLE "${name}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
          );
          await admin.query(`GRANT CONNECT ON DATABASE "cc-app" TO "${name}"`);
          await admin.query(`GRANT USAGE ON SCHEMA cc TO "${name}"`);
          outsider = await connect(name, 'cc-app');
          for (const [signature, text, values] of functions) {
            const denied = await rejects(outsider.query(text, values), '42501');
            assert.match(
              denied.message,
              /permission denied for function/,
              `An unrelated role cannot execute ${signature}.`,
            );
          }
        } finally {
          if (outsider !== undefined) await close(outsider);
          await admin
            .query(`DROP ROLE IF EXISTS "${name}"`)
            .catch(() => undefined);
          await close(admin);
        }
      },
    );
  } finally {
    // The state row references our principals. Clear the sync and its failure before they leave.
    await migrator.query(
      `UPDATE cc.user_sync_state SET failure=NULL,failure_requested_by=NULL,sync_actor=NULL,
        sync_id=NULL,sync_generation=NULL,sync_attempt=NULL,sync_started_at=NULL,
        sync_expires_at=NULL,correlation_id=NULL WHERE customer_id=$1`,
      [customer],
    );
    for (const id of jobs)
      await migrator.query('DELETE FROM cc.jobs WHERE job_id=$1', [id]);
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
    await migrator.query(
      'DELETE FROM cc.user_attribute_category_state WHERE customer_id=$1',
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
