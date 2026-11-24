import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * K22: the value preview storage and the value job contract. The `users:write` and
 * `users:bulk-actions` rows reach a fresh platform administrator, a `user-attribute-update` job
 * takes a `UAT-` display ID and the one write slot, and a preview stores its frozen changes and
 * target values under the constraints of document B sections 8 and 10. The preview routes (K23)
 * and the worker (K24) build the behavior over these rows.
 */
export async function qualifyUserAttributeValues({
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
  const previews = [];
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
      [id, issuer, `k22-${label}-${id}`, `K22 ${label}`],
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
  /** One value job header of the kind that 027 adds. */
  const createValueJob = async (actor, displayId, status = 'accepted') => {
    const jobId = randomUUID();
    await migrator.query(
      `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,entity_type,status,
        requested_by,generation,target_count,correlation_id)
       VALUES($1,$2,$3,'user-attribute-update','devices','user',$4,$5,$6,3,$7)`,
      [jobId, displayId, customer, status, actor, generation, randomUUID()],
    );
    jobs.push(jobId);
    return jobId;
  };
  /** One preview row with the answer of document B section 10, its changes, and its rows. */
  const createPreview = async (actor, overrides = {}) => {
    const previewId = randomUUID();
    const values = {
      source: 'selection',
      selection: { gridId: 'users', tabId: randomUUID() },
      selected: 3,
      eligible: 1,
      unchanged: 1,
      conflicts: 1,
      attributeChanges: 2,
      digest: 'a'.repeat(64),
      changes: [
        {
          schemaName: 'StudentInfo',
          fieldName: 'Homeroom',
          mode: 'set',
          values: ['B12'],
        },
        {
          schemaName: 'StudentInfo',
          fieldName: 'Programs',
          mode: 'remove',
          values: ['ELL'],
        },
      ],
      targets: [
        {
          userId: 'k22-user-1',
          primaryEmail: 'jdoe@example.org',
          disposition: 'eligible',
          rows: [
            {
              schemaName: 'StudentInfo',
              fieldName: 'Homeroom',
              currentValue: 'B11',
              requestedValue: 'B12',
              disposition: 'eligible',
            },
            {
              schemaName: 'StudentInfo',
              fieldName: 'Programs',
              currentValue: [{ value: 'ELL' }, { value: 'Band' }],
              requestedValue: [{ value: 'Band' }],
              disposition: 'eligible',
            },
          ],
        },
        {
          userId: 'k22-user-2',
          primaryEmail: 'jsmith@example.org',
          disposition: 'conflict',
          rows: [
            {
              schemaName: 'StudentInfo',
              fieldName: 'Homeroom',
              currentValue: 'B13',
              requestedValue: 'B12',
              disposition: 'conflict',
            },
          ],
        },
      ],
      ...overrides,
    };
    await migrator.query(
      `INSERT INTO cc.user_attribute_previews(preview_id,customer_id,created_by,permission_version,
        generation,source,selection,selected,eligible,unchanged,conflicts,attribute_changes,
        manifest_digest,expires_at)
       VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp()+interval '15 minutes')`,
      [
        previewId,
        customer,
        actor,
        generation,
        values.source,
        values.selection === null ? null : JSON.stringify(values.selection),
        values.selected,
        values.eligible,
        values.unchanged,
        values.conflicts,
        values.attributeChanges,
        values.digest,
      ],
    );
    previews.push(previewId);
    for (const [ordinal, change] of values.changes.entries())
      await migrator.query(
        `INSERT INTO cc.user_attribute_preview_changes(preview_id,ordinal,schema_name,field_name,mode,values)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          previewId,
          ordinal,
          change.schemaName,
          change.fieldName,
          change.mode,
          JSON.stringify(change.values),
        ],
      );
    for (const [ordinal, target] of values.targets.entries()) {
      await migrator.query(
        `INSERT INTO cc.user_attribute_preview_targets(preview_id,ordinal,user_id,primary_email,
          disposition,observed_at)
         VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '2 minutes')`,
        [
          previewId,
          ordinal,
          target.userId,
          target.primaryEmail,
          target.disposition,
        ],
      );
      for (const row of target.rows)
        await migrator.query(
          `INSERT INTO cc.user_attribute_target_values(preview_id,ordinal,schema_name,field_name,
            current_value,requested_value,disposition)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            previewId,
            ordinal,
            row.schemaName,
            row.fieldName,
            row.currentValue === null ? null : JSON.stringify(row.currentValue),
            row.requestedValue === null
              ? null
              : JSON.stringify(row.requestedValue),
            row.disposition,
          ],
        );
    }
    return previewId;
  };

  const platformAdministrator = await adminRow(
    `SELECT id FROM cc.application_principals p
     WHERE cc.full_platform_administrator(p.id) ORDER BY p.created_at,p.id LIMIT 1`,
  );
  const writer = await createPrincipal('value-writer', [
    district('users:write'),
  ]);

  try {
    await check(
      'K22 users:write and users:bulk-actions take the platform and district scopes',
      async () => {
        for (const action of ['users:write', 'users:bulk-actions']) {
          const row = await adminRow(
            'SELECT scope_kinds FROM cc.application_actions WHERE action=$1',
            [action],
          );
          assert.deepEqual(row.scope_kinds, ['platform', 'district']);
          await migrator.query(
            `INSERT INTO cc.application_grants(principal_id,action,scope)
             VALUES($1,$2,$3)`,
            [writer, action, JSON.stringify({ kind: 'platform' })],
          );
          // A school scope holds neither action (B section 11).
          await rejects(
            migrator.query(
              `INSERT INTO cc.application_grants(principal_id,action,scope)
               VALUES($1,$2,$3)`,
              [
                writer,
                action,
                JSON.stringify({
                  kind: 'school',
                  customerId: customer,
                  schoolId: randomUUID(),
                }),
              ],
            ),
            'P0001',
          );
        }
      },
    );

    await check(
      'K22 a fresh platform administrator session holds both value actions',
      async () => {
        assert.ok(
          platformAdministrator,
          'The harness confirms one platform administrator.',
        );
        for (const action of ['users:write', 'users:bulk-actions']) {
          const grants = await adminRow(
            `SELECT count(*)::integer AS grants FROM cc.application_grants
             WHERE principal_id=$1 AND action=$2 AND scope='{"kind":"platform"}'::jsonb`,
            [platformAdministrator.id, action],
          );
          assert.equal(
            grants.grants,
            1,
            `${action} reaches the administrator.`,
          );
        }
        for (const table of [
          'cc.user_attribute_previews',
          'cc.user_attribute_preview_changes',
          'cc.user_attribute_preview_targets',
          'cc.user_attribute_target_values',
          'cc.user_attribute_update_jobs',
        ])
          await runtime.query(`SELECT count(*) FROM ${table}`);
      },
    );

    await check(
      'K22 the runtime role reads the previews and cannot write them',
      async () => {
        const previewId = await createPreview(writer);
        await runtime.query(
          'SELECT count(*) FROM cc.user_attribute_target_values WHERE preview_id=$1',
          [previewId],
        );
        await rejects(
          runtime.query(
            `INSERT INTO cc.user_attribute_previews(preview_id,customer_id,created_by,
              permission_version,generation,source,selected,eligible,unchanged,conflicts,
              expires_at)
             VALUES($1,$2,$3,1,$4,'edit-list',1,1,0,0,now())`,
            [randomUUID(), customer, writer, generation],
          ),
          '42501',
        );
      },
    );

    await check(
      'K22 a value job takes a UAT display ID of the jobs table',
      async () => {
        const number = await adminRow(
          "SELECT cc.job_display_id('UAT',nextval('cc.job_number_uat')) AS display_id",
        );
        assert.match(number.display_id, /^UAT-\d{3,}$/);
        await createValueJob(writer, number.display_id);
        await rejects(
          adminRow(
            `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,entity_type,status,
              requested_by,generation,target_count,correlation_id)
             VALUES($1,'UAT-1',$2,'user-attribute-update','devices','user','accepted',$3,$4,3,$5)`,
            [randomUUID(), customer, writer, generation, randomUUID()],
          ),
          '23514',
        );
      },
    );

    await check(
      'K22 a running value job holds the one write slot',
      async () => {
        const first = jobs[0];
        await migrator.query(
          "UPDATE cc.jobs SET status='running' WHERE job_id=$1",
          [first],
        );
        await rejects(createValueJob(writer, 'UAT-900', 'running'), '23505');
        await rejects(
          adminRow(
            `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,
              requested_by,generation,target_count,correlation_id)
             VALUES($1,'UPD-998',$2,'device-update','devices','running',$3,$4,1,$5)`,
            [randomUUID(), customer, writer, generation, randomUUID()],
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
      'K22 a preview stores its frozen counts, changes, and target values',
      async () => {
        const previewId = await createPreview(writer);
        const header = await adminRow(
          `SELECT source,selected,eligible,unchanged,conflicts,attribute_changes,manifest_digest
           FROM cc.user_attribute_previews WHERE preview_id=$1`,
          [previewId],
        );
        assert.deepEqual(header, {
          source: 'selection',
          selected: 3,
          eligible: 1,
          unchanged: 1,
          conflicts: 1,
          attribute_changes: 2,
          manifest_digest: 'a'.repeat(64),
        });
        const changes = await migrator.query(
          `SELECT ordinal,schema_name,field_name,mode,values
           FROM cc.user_attribute_preview_changes WHERE preview_id=$1 ORDER BY ordinal`,
          [previewId],
        );
        assert.deepEqual(changes.rows, [
          {
            ordinal: 0,
            schema_name: 'StudentInfo',
            field_name: 'Homeroom',
            mode: 'set',
            values: ['B12'],
          },
          {
            ordinal: 1,
            schema_name: 'StudentInfo',
            field_name: 'Programs',
            mode: 'remove',
            values: ['ELL'],
          },
        ]);
        const rows = await migrator.query(
          `SELECT ordinal,schema_name,field_name,current_value,requested_value,disposition
           FROM cc.user_attribute_target_values WHERE preview_id=$1
           ORDER BY ordinal,schema_name,field_name`,
          [previewId],
        );
        assert.deepEqual(rows.rows, [
          {
            ordinal: 0,
            schema_name: 'StudentInfo',
            field_name: 'Homeroom',
            current_value: 'B11',
            requested_value: 'B12',
            disposition: 'eligible',
          },
          {
            ordinal: 0,
            schema_name: 'StudentInfo',
            field_name: 'Programs',
            current_value: [{ value: 'ELL' }, { value: 'Band' }],
            requested_value: [{ value: 'Band' }],
            disposition: 'eligible',
          },
          {
            ordinal: 1,
            schema_name: 'StudentInfo',
            field_name: 'Homeroom',
            current_value: 'B13',
            requested_value: 'B12',
            disposition: 'conflict',
          },
        ]);
        // A clear stores a null request, and the change mode names the removal.
        await createPreview(writer, {
          selected: 1,
          eligible: 1,
          unchanged: 0,
          conflicts: 0,
          changes: [
            {
              schemaName: 'StudentInfo',
              fieldName: 'Homeroom',
              mode: 'clear',
              values: [],
            },
          ],
          targets: [
            {
              userId: 'k22-user-3',
              primaryEmail: 'jroe@example.org',
              disposition: 'eligible',
              rows: [
                {
                  schemaName: 'StudentInfo',
                  fieldName: 'Homeroom',
                  currentValue: 'B12',
                  requestedValue: null,
                  disposition: 'eligible',
                },
              ],
            },
          ],
        });
      },
    );

    await check(
      'K22 the preview constraints refuse a malformed preview',
      async () => {
        const previewId = previews[0];
        // The three dispositions cover every frozen user.
        await rejects(
          adminRow(
            `UPDATE cc.user_attribute_previews SET selected=4 WHERE preview_id=$1`,
            [previewId],
          ),
          '23514',
        );
        // Only a selection names its grid, and only an edit list names none.
        await rejects(
          adminRow(
            `UPDATE cc.user_attribute_previews SET source='edit-list' WHERE preview_id=$1`,
            [previewId],
          ),
          '23514',
        );
        // A preview expires after it was prepared.
        await rejects(
          adminRow(
            `UPDATE cc.user_attribute_previews SET expires_at=prepared_at WHERE preview_id=$1`,
            [previewId],
          ),
          '23514',
        );
        // A clear carries no value, every other mode carries one, and Set value carries one.
        for (const [mode, values] of [
          ['clear', ['B12']],
          ['add', []],
          ['set', ['B12', 'B13']],
        ])
          await rejects(
            migrator.query(
              `INSERT INTO cc.user_attribute_preview_changes(preview_id,ordinal,schema_name,
                field_name,mode,values)
               VALUES($1,9,'StudentInfo','GradeLevel',$2,$3)`,
              [previewId, mode, JSON.stringify(values)],
            ),
            '23514',
          );
        // A list holds at most 150 values (B section 3), and an attribute occurs once.
        await rejects(
          migrator.query(
            `INSERT INTO cc.user_attribute_preview_changes(preview_id,ordinal,schema_name,
              field_name,mode,values)
             VALUES($1,9,'StudentInfo','GradeLevel','replace',$2)`,
            [previewId, JSON.stringify(Array.from({ length: 151 }, () => 'x'))],
          ),
          '23514',
        );
        await rejects(
          migrator.query(
            `INSERT INTO cc.user_attribute_preview_changes(preview_id,ordinal,schema_name,
              field_name,mode,values)
             VALUES($1,9,'StudentInfo','Homeroom','set','["B12"]')`,
            [previewId],
          ),
          '23505',
        );
        // A target names its user once, and its value rows name a frozen target.
        await rejects(
          migrator.query(
            `INSERT INTO cc.user_attribute_preview_targets(preview_id,ordinal,user_id,
              primary_email,disposition)
             VALUES($1,9,'k22-user-1','jdoe@example.org','eligible')`,
            [previewId],
          ),
          '23505',
        );
        await rejects(
          migrator.query(
            `INSERT INTO cc.user_attribute_target_values(preview_id,ordinal,schema_name,
              field_name,requested_value,disposition)
             VALUES($1,9,'StudentInfo','Homeroom','"B12"','eligible')`,
            [previewId],
          ),
          '23503',
        );
        // A disposition outside the three of B section 8.4 never parses, and a JSON null never
        // stands for an absent value.
        await rejects(
          migrator.query(
            `INSERT INTO cc.user_attribute_preview_targets(preview_id,ordinal,user_id,
              primary_email,disposition)
             VALUES($1,9,'k22-user-9','jdoe@example.org','excluded')`,
            [previewId],
          ),
          '23514',
        );
        await rejects(
          migrator.query(
            `UPDATE cc.user_attribute_target_values SET current_value='null'
             WHERE preview_id=$1 AND ordinal=0 AND field_name='Homeroom'`,
            [previewId],
          ),
          '23514',
        );
      },
    );

    await check(
      'K22 one value job runs one preview, and the job keeps its confirmer',
      async () => {
        const jobId = jobs[0];
        const previewId = previews[0];
        await migrator.query(
          `INSERT INTO cc.user_attribute_update_jobs(job_id,preview_id,confirmed_by,
            confirmer_permission_version)
           VALUES($1,$2,$3,1)`,
          [jobId, previewId, writer],
        );
        const nextJob = await createValueJob(writer, 'UAT-901');
        await rejects(
          migrator.query(
            `INSERT INTO cc.user_attribute_update_jobs(job_id,preview_id,confirmed_by,
              confirmer_permission_version)
             VALUES($1,$2,$3,1)`,
            [nextJob, previewId, writer],
          ),
          '23505',
        );
        await rejects(
          migrator.query(
            `INSERT INTO cc.user_attribute_update_jobs(job_id,preview_id,confirmed_by,
              confirmer_permission_version)
             VALUES($1,$2,$3,1)`,
            [nextJob, randomUUID(), writer],
          ),
          '23503',
        );
        const detail = await adminRow(
          `SELECT confirmed_by,confirmer_permission_version
           FROM cc.user_attribute_update_jobs WHERE job_id=$1`,
          [jobId],
        );
        assert.deepEqual(detail, {
          confirmed_by: writer,
          confirmer_permission_version: 1,
        });
      },
    );

    await check(
      'K22 deleting a value job removes its detail row and not its preview',
      async () => {
        const jobId = jobs[0];
        const previewId = previews[0];
        await migrator.query('DELETE FROM cc.jobs WHERE job_id=$1', [jobId]);
        jobs.splice(jobs.indexOf(jobId), 1);
        const detail = await adminRow(
          'SELECT count(*)::integer AS rows FROM cc.user_attribute_update_jobs WHERE job_id=$1',
          [jobId],
        );
        assert.equal(detail.rows, 0);
        const preview = await adminRow(
          'SELECT count(*)::integer AS rows FROM cc.user_attribute_previews WHERE preview_id=$1',
          [previewId],
        );
        assert.equal(preview.rows, 1);
      },
    );
  } finally {
    for (const id of jobs)
      await migrator.query('DELETE FROM cc.jobs WHERE job_id=$1', [id]);
    for (const id of previews)
      await migrator.query(
        'DELETE FROM cc.user_attribute_previews WHERE preview_id=$1',
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
      `User attribute value checks failed: ${failures.join(' | ')}`,
    );
  return results;
}
