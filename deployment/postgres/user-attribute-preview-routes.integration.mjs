import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { selectionTargetsSql } from '../../api/src/app/users/user-query.ts';

/**
 * K23: the value preview routes of document B section 10. The functions run as the restricted
 * runtime role, so the grants of migration 028 and the write gate are the ones that production
 * reads. A preview freezes the category `etag` that the route read, and a confirm re-reads that
 * stored row: a category that changed after the preview answers `category-changed` before any job
 * exists. A first confirm creates one `UAT-` job and a repeated confirm answers the same receipt.
 */
export async function qualifyUserAttributePreviewRoutes({
  runtime,
  migrator,
  issuer,
}) {
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const generation = connection.generation;
  const schemaName = 'K23Info';
  const etag = '"etag-k23-1"';
  const schemaId = `schema=k23-${randomUUID()}`;
  const field = (fieldId, fieldName, multiValued) => ({
    fieldId,
    fieldName,
    displayName: fieldName,
    fieldType: 'STRING',
    multiValued,
    indexed: true,
    readAccessType: 'ADMINS_AND_SELF',
    numericIndexingSpec: null,
    holders: 3,
  });
  const fields = [
    field('fld-k23-homeroom', 'Homeroom', false),
    field('fld-k23-programs', 'Programs', true),
  ];
  const principals = [];
  const previews = [];
  const jobs = [];
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
  const one = (text, values = []) =>
    migrator.query(text, values).then((rows) => rows.rows[0]);
  const call = async (text, values) =>
    (await runtime.query(text, values)).rows[0]?.result;
  const createPrincipal = async (label, grants = []) => {
    const id = randomUUID();
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$4)',
      [id, issuer, `k23-${label}-${id}`, `K23 ${label}`],
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
  const writer = await createPrincipal('writer', [district('users:write')]);
  const author = await createPrincipal('author', [
    district('users:write'),
    district('users:bulk-actions'),
  ]);
  const reader = await createPrincipal('reader', [district('users:read')]);
  const bulkOnly = await createPrincipal('bulk-only', [
    district('users:bulk-actions'),
  ]);

  const seed = async (tag) => {
    await migrator.query(
      `INSERT INTO cc.user_attribute_categories(customer_id,schema_id,schema_name,display_name,
        etag,fields,read_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())`,
      [customer, schemaId, schemaName, 'K23 info', tag, JSON.stringify(fields)],
    );
  };
  const removeSeed = () =>
    migrator.query(
      'DELETE FROM cc.user_attribute_categories WHERE customer_id=$1 AND schema_id=$2',
      [customer, schemaId],
    );
  const changes = [
    { schemaName, fieldName: 'Homeroom', mode: 'set', values: ['B12'] },
    { schemaName, fieldName: 'Programs', mode: 'remove', values: ['Band'] },
  ];
  const observed = [
    '2026-11-24T18:00:00.000Z',
    '2026-11-25T18:00:00.000Z',
    '2026-11-26T18:00:00.000Z',
  ];
  /**
   * Three selected users with two rows each: user 1 is Eligible, user 2 is Unchanged, and user 3
   * is Eligible. Four rows are Eligible and two are Unchanged, so the preview writes four rows of
   * two distinct attributes for two users (B section 8.4, B section 10).
   */
  const row = (fieldName, currentValue, newValue, disposition) => ({
    schemaName,
    fieldName,
    currentValue,
    newValue,
    disposition,
  });
  const selectionTargets = [
    {
      ordinal: 0,
      userId: 'k23-user-1',
      primaryEmail: 'k23-user-1@example.org',
      observedAt: observed[0],
      disposition: 'eligible',
      rows: [
        row('Homeroom', 'B11', 'B12', 'eligible'),
        row(
          'Programs',
          [{ value: 'ELL' }, { value: 'Band' }],
          [{ value: 'ELL' }],
          'eligible',
        ),
      ],
    },
    {
      ordinal: 1,
      userId: 'k23-user-2',
      primaryEmail: 'k23-user-2@example.org',
      observedAt: observed[1],
      disposition: 'unchanged',
      rows: [
        row('Homeroom', 'B12', 'B12', 'unchanged'),
        row('Programs', [{ value: 'ELL' }], [{ value: 'ELL' }], 'unchanged'),
      ],
    },
    {
      ordinal: 2,
      userId: 'k23-user-3',
      primaryEmail: 'k23-user-3@example.org',
      observedAt: observed[2],
      disposition: 'eligible',
      rows: [
        row('Homeroom', 'B13', 'B12', 'eligible'),
        row('Programs', [{ value: 'Band' }], null, 'eligible'),
      ],
    },
  ];
  const digest = 'b'.repeat(64);
  const etags = [{ schemaName, etag }];
  const create = async (actor, version, options = {}) =>
    call(
      `SELECT cc.create_user_attribute_preview($1::uuid,$2::integer,$3::text,$4::integer,
        $5::text,$6::jsonb,$7::jsonb,$8::text,$9::jsonb,$10::jsonb,$11::integer) AS result`,
      [
        actor,
        version,
        customer,
        generation,
        options.source ?? 'selection',
        options.selection === undefined
          ? JSON.stringify({ gridId: 'users', tabId: randomUUID() })
          : options.selection,
        JSON.stringify(options.changes ?? changes),
        options.digest ?? digest,
        JSON.stringify(options.targets ?? selectionTargets),
        JSON.stringify(options.etags ?? etags),
        options.expires ?? 15,
      ],
    ).then((answer) => {
      if (answer?.outcome === 'created')
        previews.push(answer.preview.previewId);
      return answer;
    });
  const confirm = (actor, version, previewId, input = digest) =>
    call(
      `SELECT cc.confirm_user_attribute_preview($1::uuid,$2::integer,$3::uuid,$4::text,
        $5::uuid) AS result`,
      [actor, version, previewId, input, randomUUID()],
    ).then((answer) => {
      if (answer?.outcome === 'created') jobs.push(answer.receipt.jobId);
      return answer;
    });
  const page = (actor, version, previewId, disposition, cursor, limit) =>
    call(
      `SELECT cc.read_user_attribute_preview_targets($1::uuid,$2::integer,$3::uuid,$4::text,
        $5::integer,$6::text,$7::text,$8::integer) AS result`,
      [
        actor,
        version,
        previewId,
        disposition,
        cursor?.[0] ?? null,
        cursor?.[1] ?? null,
        cursor?.[2] ?? null,
        limit,
      ],
    );

  try {
    await seed(etag);

    await check(
      'K23 the selection read answers the cached users and leaves removed users out',
      async () => {
        const ids = ['k23-sel-1', 'k23-sel-2', 'k23-sel-3'];
        await migrator.query(
          `INSERT INTO cc.users(customer_id,user_id,primary_email,org_unit_path,suspended,archived,
                two_step_enrolled,custom_schemas,last_entity_sync,removed_at)
               VALUES($1,$2,$3,'/Students',false,false,true,$4,clock_timestamp(),
                 CASE WHEN $2='k23-sel-3' THEN clock_timestamp() ELSE NULL END)`,
          [
            customer,
            ids[0],
            'k23-sel-1@example.org',
            JSON.stringify({ StudentInfo: { Homeroom: 'B11' } }),
          ],
        );
        for (const [index, id] of ids.slice(1).entries())
          await migrator.query(
            `INSERT INTO cc.users(customer_id,user_id,primary_email,org_unit_path,suspended,archived,
                  two_step_enrolled,custom_schemas,last_entity_sync,removed_at)
                 VALUES($1,$2,$3,'/Students',false,false,true,$4,clock_timestamp(),
                   CASE WHEN $2='k23-sel-3' THEN clock_timestamp() ELSE NULL END)`,
            [
              customer,
              id,
              `${id}@example.org`,
              JSON.stringify({
                StudentInfo: { Homeroom: index === 0 ? 'B12' : 'B13' },
              }),
            ],
          );
        const state = {
          terms: [],
          additions: ids,
          exceptions: [],
          changedAt: new Date().toISOString(),
        };
        const sql = selectionTargetsSql(customer, state);
        const rows = (await migrator.query(sql.text, sql.values)).rows;
        assert.deepEqual(
          rows.map((row) => row.user_id),
          ['k23-sel-1', 'k23-sel-2'],
        );
        assert.deepEqual(rows[0].custom_schemas, {
          StudentInfo: { Homeroom: 'B11' },
        });
        assert.ok(rows[0].last_entity_sync instanceof Date);
        const bounded = selectionTargetsSql(customer, state, 1);
        const one = (await migrator.query(bounded.text, bounded.values)).rows;
        assert.equal(one.length, 1);
        await migrator.query(
          'DELETE FROM cc.users WHERE customer_id=$1 AND user_id=ANY($2::text[])',
          [customer, ids],
        );
      },
    );

    await check(
      'K23 the runtime reads the new table and cannot write it',
      async () => {
        const read = await runtime.query(
          `SELECT count(*)::integer AS rows FROM cc.user_attribute_preview_categories
         WHERE schema_name=$1`,
          [schemaName],
        );
        assert.equal(read.rows[0].rows, 0);
        await rejects(
          runtime.query(
            `INSERT INTO cc.user_attribute_preview_categories(preview_id,schema_name,etag)
           VALUES($1,$2,$3)`,
            [randomUUID(), schemaName, etag],
          ),
          '42501',
        );
      },
    );

    await check(
      'K23 a reader without users:write reads no preview base',
      async () => {
        await rejects(
          runtime.query(
            'SELECT cc.read_user_attribute_preview_base($1::uuid,$2::integer) AS result',
            [reader, 1],
          ),
          '42501',
        );
        await rejects(
          runtime.query(
            'SELECT cc.user_value_credential($1::uuid,$2::integer,$3::text,$4::integer) AS result',
            [reader, 1, customer, generation],
          ),
          '42501',
        );
      },
    );

    await check(
      'K23 the write gate answers the cached categories and the generation',
      async () => {
        const base = await call(
          'SELECT cc.read_user_attribute_preview_base($1::uuid,$2::integer) AS result',
          [writer, 1],
        );
        assert.equal(base.customerId, customer);
        assert.equal(base.generation, generation);
        assert.equal(base.categories.length, 1);
        assert.equal(base.categories[0].etag, etag);
        assert.equal(base.categories[0].fields.length, 2);
      },
    );

    await check(
      'K23 a selection preview without users:bulk-actions is forbidden',
      async () => {
        assert.deepEqual(await create(writer, 1), { outcome: 'forbidden' });
        assert.deepEqual(await create(bulkOnly, 1), { outcome: 'forbidden' });
      },
    );

    await check(
      'K23 a selection preview freezes its rows, counts, etag, and digest',
      async () => {
        const answer = await create(author, 1);
        assert.equal(answer.outcome, 'created', JSON.stringify(answer));
        const preview = answer.preview;
        assert.equal(preview.source, 'selection');
        assert.equal(preview.selected, 3);
        assert.equal(preview.eligible, 2);
        assert.equal(preview.unchanged, 1);
        assert.equal(preview.conflicts, 0);
        assert.equal(preview.attributeChanges, 4);
        assert.equal(preview.manifestDigest, digest);
        assert.deepEqual(preview.changes, changes);
        assert.equal(
          Date.parse(preview.oldestObservedAt),
          Date.parse(observed[0]),
        );
        const stored = await one(
          'SELECT schema_name,etag FROM cc.user_attribute_preview_categories WHERE preview_id=$1',
          [preview.previewId],
        );
        assert.deepEqual(stored, { schema_name: schemaName, etag });
      },
    );

    await check(
      'K23 the rows page by cursor and filter by disposition',
      async () => {
        const created = await create(author, 1);
        const previewId = created.preview.previewId;
        const first = await page(author, 1, previewId, null, null, 2);
        assert.equal(first.outcome, 'page');
        assert.equal(first.targets.length, 2);
        assert.equal(first.nextCursor, '0:K23Info.Programs');
        const [ordinal, schema, fieldName] = first.nextCursor.split(/[:.]/);
        const second = await page(
          author,
          1,
          previewId,
          null,
          [Number(ordinal), schema, fieldName],
          2,
        );
        assert.equal(second.targets.length, 2);
        const last = second.targets.at(-1);
        const third = await page(
          author,
          1,
          previewId,
          null,
          [last.ordinal, last.schemaName, last.fieldName],
          2,
        );
        assert.equal(third.targets.length, 2);
        assert.equal(third.nextCursor, null);
        const ids = [...first.targets, ...second.targets, ...third.targets].map(
          (target) =>
            `${target.ordinal}:${target.schemaName}.${target.fieldName}`,
        );
        assert.equal(new Set(ids).size, 6);
        const unchanged = await page(
          author,
          1,
          previewId,
          'unchanged',
          null,
          10,
        );
        assert.equal(unchanged.targets.length, 2);
        assert.ok(unchanged.targets.every((target) => target.ordinal === 1));
      },
    );

    await check(
      'K23 a category that changed after the preview answers 409 category-changed',
      async () => {
        const created = await create(author, 1);
        const previewId = created.preview.previewId;
        await migrator.query(
          `UPDATE cc.user_attribute_categories SET etag='"etag-k23-2"'
         WHERE customer_id=$1 AND schema_id=$2`,
          [customer, schemaId],
        );
        assert.deepEqual(await confirm(author, 1, previewId), {
          outcome: 'category-changed',
        });
        const counted = await one(
          'SELECT count(*)::integer AS jobs FROM cc.user_attribute_update_jobs WHERE preview_id=$1',
          [previewId],
        );
        assert.equal(counted.jobs, 0);
        await migrator.query(
          `UPDATE cc.user_attribute_categories SET etag=$3
         WHERE customer_id=$1 AND schema_id=$2`,
          [customer, schemaId, etag],
        );
      },
    );

    await check(
      'K23 a vanished category answers 409 category-changed',
      async () => {
        const created = await create(author, 1);
        await removeSeed();
        assert.deepEqual(await confirm(author, 1, created.preview.previewId), {
          outcome: 'category-changed',
        });
        await seed(etag);
      },
    );

    await check(
      'K23 a first confirm answers one UAT receipt and a repeat answers it again',
      async () => {
        const created = await create(author, 1);
        const previewId = created.preview.previewId;
        const first = await confirm(author, 1, previewId);
        assert.equal(first.outcome, 'created', JSON.stringify(first));
        assert.match(first.receipt.displayId, /^UAT-[0-9]{3,}$/);
        assert.equal(first.receipt.status, 'accepted');
        assert.equal(first.receipt.userCount, 2);
        assert.equal(first.receipt.changeCount, 2);
        const replay = await confirm(author, 1, previewId);
        assert.equal(replay.outcome, 'existing');
        assert.deepEqual(replay.receipt, first.receipt);
        const header = await one(
          `SELECT kind,scope_kind,entity_type,target_count,status,requested_by
         FROM cc.jobs WHERE job_id=$1`,
          [first.receipt.jobId],
        );
        assert.deepEqual(header, {
          kind: 'user-attribute-update',
          scope_kind: 'devices',
          entity_type: 'user',
          target_count: 2,
          status: 'accepted',
          requested_by: author,
        });
        const details = await one(
          'SELECT count(*)::integer AS jobs FROM cc.user_attribute_update_jobs WHERE preview_id=$1',
          [previewId],
        );
        assert.equal(details.jobs, 1);
        // A confirmed preview answers its receipt even after the cached etag moved (B section 10).
        await migrator.query(
          `UPDATE cc.user_attribute_categories SET etag='"etag-k23-2"'
           WHERE customer_id=$1 AND schema_id=$2`,
          [customer, schemaId],
        );
        const after = await confirm(author, 1, previewId);
        assert.equal(after.outcome, 'existing');
        assert.deepEqual(after.receipt, first.receipt);
        await migrator.query(
          `UPDATE cc.user_attribute_categories SET etag=$3
           WHERE customer_id=$1 AND schema_id=$2`,
          [customer, schemaId, etag],
        );
      },
    );

    await check(
      'K23 a preview that froze a conflict never confirms',
      async () => {
        const editTargets = [
          {
            ordinal: 0,
            userId: 'k23-user-4',
            primaryEmail: 'k23-user-4@example.org',
            observedAt: observed[0],
            disposition: 'conflict',
            rows: [row('Homeroom', 'B13', 'B12', 'conflict')],
          },
        ];
        const created = await create(author, 1, {
          source: 'edit-list',
          selection: null,
          changes: [],
          targets: editTargets,
        });
        assert.equal(created.outcome, 'created', JSON.stringify(created));
        assert.equal(created.preview.conflicts, 1);
        assert.equal(created.preview.changes, null);
        assert.deepEqual(await confirm(author, 1, created.preview.previewId), {
          outcome: 'preview-conflict',
        });
      },
    );

    await check(
      'K23 a preview with no eligible row creates no job',
      async () => {
        const targets = [
          {
            ordinal: 0,
            userId: 'k23-user-5',
            primaryEmail: 'k23-user-5@example.org',
            observedAt: observed[0],
            disposition: 'unchanged',
            rows: [row('Homeroom', 'B12', 'B12', 'unchanged')],
          },
        ];
        const created = await create(author, 1, {
          source: 'edit-list',
          selection: null,
          changes: [],
          targets,
        });
        assert.equal(created.outcome, 'created', JSON.stringify(created));
        assert.equal(created.preview.eligible, 0);
        assert.equal(created.preview.unchanged, 1);
        assert.deepEqual(await confirm(author, 1, created.preview.previewId), {
          outcome: 'nothing-to-update',
        });
        const counted = await one(
          'SELECT count(*)::integer AS jobs FROM cc.user_attribute_update_jobs WHERE preview_id=$1',
          [created.preview.previewId],
        );
        assert.equal(counted.jobs, 0);
      },
    );

    await check('K23 an expired preview answers preview-expired', async () => {
      const created = await create(author, 1, { expires: 1 });
      await migrator.query(
        `UPDATE cc.user_attribute_previews
         SET prepared_at=clock_timestamp()-interval '2 minutes',
           expires_at=clock_timestamp()-interval '1 minute'
         WHERE preview_id=$1`,
        [created.preview.previewId],
      );
      const expired = await confirm(author, 1, created.preview.previewId);
      assert.equal(expired.outcome, 'preview-expired');
      assert.ok(Number.isFinite(Date.parse(expired.expiresAt)));
    });

    await check(
      'K23 a frozen permission version refuses a caller whose version moved',
      async () => {
        const created = await create(author, 1);
        await migrator.query(
          'UPDATE cc.application_principals SET permission_version=2 WHERE id=$1',
          [author],
        );
        assert.deepEqual(await confirm(author, 2, created.preview.previewId), {
          outcome: 'forbidden',
        });
        await migrator.query(
          'UPDATE cc.application_principals SET permission_version=1 WHERE id=$1',
          [author],
        );
      },
    );

    await check(
      'K23 another writer reads no preview, and a moved generation refuses',
      async () => {
        const created = await create(author, 1);
        const previewId = created.preview.previewId;
        const other = await call(
          'SELECT cc.read_user_attribute_preview($1::uuid,$2::integer,$3::uuid) AS result',
          [writer, 1, previewId],
        );
        assert.deepEqual(other, { outcome: 'not-found' });
        // The preview froze the generation of its create. A connection generation that moved after
        // the create refuses the confirm, and the preview row alone carries that evidence.
        await migrator.query(
          'UPDATE cc.user_attribute_previews SET generation=generation+1 WHERE preview_id=$1',
          [previewId],
        );
        assert.deepEqual(await confirm(author, 1, previewId), {
          outcome: 'connection-changed',
        });
      },
    );

    await check('K23 another digest answers preview-changed', async () => {
      const created = await create(author, 1);
      assert.deepEqual(
        await confirm(author, 1, created.preview.previewId, 'c'.repeat(64)),
        { outcome: 'preview-changed' },
      );
    });
  } finally {
    await migrator.query(
      'UPDATE cc.google_connection SET generation=$1 WHERE singleton',
      [generation],
    );
    for (const id of jobs)
      await migrator.query('DELETE FROM cc.jobs WHERE job_id=$1', [id]);
    for (const id of previews)
      await migrator.query(
        'DELETE FROM cc.user_attribute_previews WHERE preview_id=$1',
        [id],
      );
    await removeSeed();
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
      `User attribute preview route checks failed: ${failures.join(' | ')}`,
    );
  return results;
}
