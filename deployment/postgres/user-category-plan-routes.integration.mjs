import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  userAttributeCategoryJobReceiptSchema,
  userAttributeCategoryPlanSchema,
} from '../../libs/application-contracts/src/lib/users.ts';

/**
 * K15: the category plan and confirm routes of document B section 10. The store re-reads the
 * category cache and answers `category-changed` on a changed etag (C7). A confirm creates one
 * `user-schema-change` job with a `CAT-` display ID, and a repeated confirm answers the same
 * receipt. Only `users:schema-manage` reaches the functions, and only through the runtime role.
 */
export async function qualifyUserCategoryPlans({
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
  const createPrincipal = async (label, grants = []) => {
    const id = randomUUID();
    await migrator.query(
      'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$4)',
      [id, issuer, `k15-${label}-${id}`, `K15 ${label}`],
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
  /** One cached category of the schema cache that K8 reads. */
  const attributes = (count) =>
    Array.from({ length: count }, (_, index) => ({
      fieldId: `fld-bulk-${index}`,
      fieldName: `Bulk${index}`,
      displayName: `Bulk ${index}`,
      fieldType: 'STRING',
      multiValued: false,
      indexed: true,
      readAccessType: 'ADMINS_AND_SELF',
      numericIndexingSpec: null,
      holders: 0,
    }));
  const storeCategory = async (
    schemaId,
    schemaName,
    displayName,
    etag,
    fields,
  ) => {
    await migrator.query(
      `INSERT INTO cc.user_attribute_categories(customer_id,schema_id,schema_name,display_name,
        etag,fields,read_at)
       VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())`,
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
  const planBase = (actor) =>
    one('SELECT cc.read_user_category_plan_base($1,1) AS result', [actor]);
  const createPlan = (actor, values) =>
    one(
      `SELECT cc.create_user_category_plan($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS result`,
      [
        actor,
        customer,
        generation,
        values.kind,
        values.schemaId ?? null,
        values.baseEtag ?? null,
        values.schemaName,
        values.displayName,
        values.body === undefined || values.body === null
          ? null
          : JSON.stringify(values.body),
        JSON.stringify(values.changes ?? []),
        values.phrase ?? null,
        values.digest ?? 'a'.repeat(64),
        15,
      ],
    );
  const readPlan = (actor, planId) =>
    one('SELECT cc.read_user_category_plan($1,1,$2) AS result', [
      actor,
      planId,
    ]);
  const confirmPlan = (actor, planId, digest, phrase) =>
    one('SELECT cc.confirm_user_category_plan($1,1,$2,$3,$4,$5) AS result', [
      actor,
      planId,
      digest,
      phrase,
      randomUUID(),
    ]);

  const manager = await createPrincipal('schema-manager', [
    district('users:schema-manage'),
  ]);
  const other = await createPrincipal('other-manager', [
    district('users:schema-manage'),
  ]);
  const reader = await createPrincipal('reader', [district('users:read')]);

  try {
    await storeCategory(
      'schem=StudentInfo',
      'StudentInfo',
      'Student info',
      '"etag-1"',
      [
        {
          fieldId: 'fld-homeroom',
          fieldName: 'Homeroom',
          displayName: 'Homeroom',
          fieldType: 'STRING',
          multiValued: false,
          indexed: true,
          readAccessType: 'ADMINS_AND_SELF',
          numericIndexingSpec: null,
          holders: 12,
        },
        {
          fieldId: 'fld-grade',
          fieldName: 'GradeLevel',
          displayName: 'Grade level',
          fieldType: 'INT64',
          multiValued: false,
          indexed: true,
          readAccessType: 'ALL_DOMAIN_USERS',
          numericIndexingSpec: { minValue: 0, maxValue: 12 },
          holders: 0,
        },
      ],
    );
    await storeCategory(
      'schem=StaffInfo',
      'StaffInfo',
      'Staff info',
      '"etag-2"',
      [
        {
          fieldId: 'fld-department',
          fieldName: 'Department',
          displayName: 'Department',
          fieldType: 'STRING',
          multiValued: false,
          indexed: true,
          readAccessType: 'ADMINS_AND_SELF',
          numericIndexingSpec: null,
          holders: 0,
        },
      ],
    );

    await check(
      'K15 the category plan base is under users:schema-manage',
      async () => {
        const answer = await planBase(manager);
        assert.equal(answer.result.customerId, customer);
        assert.equal(answer.result.generation, generation);
        assert.equal(answer.result.categories.length, 2);
        assert.deepEqual(answer.result.limits, {
          categories: 2,
          categoryLimit: 100,
          attributes: 3,
          attributeLimit: 100,
        });
        await rejects(
          migrator.query('SELECT cc.read_user_category_plan_base($1,1)', [
            reader,
          ]),
          '42501',
        );
        // The runtime role calls the functions, and the kestra role cannot.
        await runtime.query('SELECT cc.read_user_category_plan_base($1,1)', [
          manager,
        ]);
        const kestra = await connect('cc-kestra', 'cc-kestra');
        try {
          try {
            await kestra.query('SELECT cc.read_user_category_plan_base($1,1)', [
              manager,
            ]);
            assert.fail('the kestra role reached a category plan function');
          } catch (error) {
            assert.ok(
              ['42501', '3F000'].includes(error.code),
              `the kestra role answered ${error.code}: ${error.message}`,
            );
          }
        } finally {
          await close(kestra);
        }
      },
    );

    await check(
      'K15 the runtime role executes each plan function, and no other role does',
      async () => {
        for (const signature of [
          'cc.read_user_category_plan_base(uuid,integer)',
          'cc.create_user_category_plan(uuid,integer,text,integer,text,text,text,text,text,jsonb,jsonb,text,text,integer)',
          'cc.read_user_category_plan(uuid,integer,uuid)',
          'cc.confirm_user_category_plan(uuid,integer,uuid,text,text,uuid)',
        ]) {
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
      },
    );

    await check(
      'K15 a create plan refuses a category name that the cache holds',
      async () => {
        const answer = await createPlan(manager, {
          kind: 'create-category',
          schemaName: 'studentinfo',
          displayName: 'Student info',
          body: {
            schemaName: 'studentinfo',
            displayName: 'Student info',
            fields: [
              {
                fieldName: 'Nickname',
                displayName: 'Nickname',
                fieldType: 'STRING',
                multiValued: false,
                indexed: true,
                readAccessType: 'ADMINS_AND_SELF',
              },
            ],
          },
          changes: [
            {
              change: 'added',
              fieldId: null,
              fieldName: 'Nickname',
              displayName: 'Nickname',
              properties: [],
              holders: null,
            },
          ],
        });
        assert.equal(
          answer.result.outcome,
          'name-in-use',
          JSON.stringify(answer.result),
        );
      },
    );

    let createPlanId;
    await check('K15 a create plan stores one frozen insert call', async () => {
      const answer = await createPlan(manager, {
        kind: 'create-category',
        schemaName: 'AthleticsInfo',
        displayName: 'Athletics info',
        body: {
          schemaName: 'AthleticsInfo',
          displayName: 'Athletics info',
          fields: [
            {
              fieldName: 'Team',
              displayName: 'Team',
              fieldType: 'STRING',
              multiValued: false,
              indexed: true,
              readAccessType: 'ADMINS_AND_SELF',
            },
            {
              fieldName: 'JerseyNumber',
              displayName: 'Jersey number',
              fieldType: 'INT64',
              multiValued: false,
              indexed: true,
              readAccessType: 'ADMINS_AND_SELF',
              numericIndexingSpec: { minValue: 0, maxValue: 99 },
            },
          ],
        },
        changes: [
          {
            change: 'added',
            fieldId: null,
            fieldName: 'Team',
            displayName: 'Team',
            properties: [],
            holders: null,
          },
          {
            change: 'added',
            fieldId: null,
            fieldName: 'JerseyNumber',
            displayName: 'Jersey number',
            properties: [],
            holders: null,
          },
        ],
      });
      assert.equal(
        answer.result.outcome,
        'created',
        JSON.stringify(answer.result),
      );
      const plan = answer.result.plan;
      createPlanId = plan.planId;
      assert.equal(plan.kind, 'create-category');
      assert.equal(plan.method, 'insert');
      assert.equal(plan.schemaId, null);
      assert.equal(plan.baseEtag, null);
      assert.equal(plan.phrase, null);
      assert.equal(plan.changes.length, 2);
      assert.deepEqual(plan.limits, {
        categories: 3,
        categoryLimit: 100,
        attributes: 5,
        attributeLimit: 100,
      });
      assert.match(plan.digest, /^[a-f0-9]{64}$/);
      assert.ok(Date.parse(plan.expiresAt) > Date.parse(plan.preparedAt));
      // The stored answer parses as the contract that the route answers.
      assert.equal(
        userAttributeCategoryPlanSchema.parse(plan).planId,
        plan.planId,
      );
    });

    await check('K15 a plan reads for its creator only', async () => {
      const answer = await readPlan(manager, createPlanId);
      assert.equal(answer.result.outcome, 'plan');
      assert.equal(answer.result.customerId, customer);
      assert.equal(answer.result.plan.planId, createPlanId);
      assert.equal(
        (await readPlan(other, createPlanId)).result.outcome,
        'not-found',
      );
      await rejects(
        migrator.query('SELECT cc.read_user_category_plan($1,1,$2)', [
          reader,
          createPlanId,
        ]),
        '42501',
      );
    });

    let editPlanId;
    await check(
      'C7 an edit plan compares the etag of the category cache',
      async () => {
        const stale = await createPlan(manager, {
          kind: 'edit-category',
          schemaId: 'schem=StudentInfo',
          baseEtag: '"etag-old"',
          schemaName: 'StudentInfo',
          displayName: 'Student info',
          body: {
            schemaName: 'StudentInfo',
            displayName: 'Student info',
            fields: [
              {
                fieldId: 'fld-homeroom',
                fieldName: 'Homeroom',
                displayName: 'Homeroom',
                fieldType: 'STRING',
                multiValued: false,
                indexed: true,
                readAccessType: 'ADMINS_AND_SELF',
              },
            ],
          },
          changes: [],
        });
        assert.equal(stale.result.outcome, 'category-changed');
        const answer = await createPlan(manager, {
          kind: 'edit-category',
          schemaId: 'schem=StudentInfo',
          baseEtag: '"etag-1"',
          schemaName: 'StudentInfo',
          displayName: 'Student details',
          body: {
            schemaName: 'StudentInfo',
            displayName: 'Student details',
            fields: [
              {
                fieldId: 'fld-homeroom',
                fieldName: 'Homeroom',
                displayName: 'Homeroom',
                fieldType: 'STRING',
                multiValued: false,
                indexed: true,
                readAccessType: 'ADMINS_AND_SELF',
              },
              {
                fieldId: 'fld-grade',
                fieldName: 'GradeLevel',
                displayName: 'Grade level',
                fieldType: 'INT64',
                multiValued: false,
                indexed: true,
                readAccessType: 'ALL_DOMAIN_USERS',
                numericIndexingSpec: { minValue: 0, maxValue: 12 },
              },
              {
                fieldName: 'Nickname',
                displayName: 'Nickname',
                fieldType: 'STRING',
                multiValued: false,
                indexed: true,
                readAccessType: 'ADMINS_AND_SELF',
              },
            ],
          },
          changes: [
            {
              change: 'added',
              fieldId: null,
              fieldName: 'Nickname',
              displayName: 'Nickname',
              properties: [],
              holders: null,
            },
            {
              change: 'changed',
              fieldId: 'fld-grade',
              fieldName: 'GradeLevel',
              displayName: 'Grade level',
              properties: ['displayName'],
              holders: null,
            },
          ],
        });
        assert.equal(answer.result.outcome, 'created');
        editPlanId = answer.result.plan.planId;
        assert.equal(answer.result.plan.method, 'update');
        assert.equal(answer.result.plan.baseEtag, '"etag-1"');
        assert.deepEqual(answer.result.plan.limits, {
          categories: 2,
          categoryLimit: 100,
          attributes: 4,
          attributeLimit: 100,
        });
        assert.equal(answer.result.plan.changes.length, 2);
      },
    );

    await check(
      'K15 the store refuses a locked attribute property',
      async () => {
        await rejects(
          createPlan(manager, {
            kind: 'edit-category',
            schemaId: 'schem=StudentInfo',
            baseEtag: '"etag-1"',
            schemaName: 'StudentInfo',
            displayName: 'Student info',
            body: {
              schemaName: 'StudentInfo',
              displayName: 'Student info',
              fields: [
                {
                  fieldId: 'fld-homeroom',
                  fieldName: 'HomeRoom',
                  displayName: 'Homeroom',
                  fieldType: 'STRING',
                  multiValued: false,
                  indexed: true,
                  readAccessType: 'ADMINS_AND_SELF',
                },
              ],
            },
            changes: [],
          }),
          '22023',
        );
      },
    );

    await check(
      'K15 an edit plan counts the unsaved attributes against the limit',
      async () => {
        await storeCategory(
          'schem=BulkInfo',
          'BulkInfo',
          'Bulk info',
          '"etag-b"',
          attributes(97),
        );
        const answer = await createPlan(manager, {
          kind: 'edit-category',
          schemaId: 'schem=StudentInfo',
          baseEtag: '"etag-1"',
          schemaName: 'StudentInfo',
          displayName: 'Student info',
          body: {
            schemaName: 'StudentInfo',
            displayName: 'Student info',
            fields: [
              {
                fieldId: 'fld-homeroom',
                fieldName: 'Homeroom',
                displayName: 'Homeroom',
                fieldType: 'STRING',
                multiValued: false,
                indexed: true,
                readAccessType: 'ADMINS_AND_SELF',
              },
              {
                fieldId: 'fld-grade',
                fieldName: 'GradeLevel',
                displayName: 'Grade level',
                fieldType: 'INT64',
                multiValued: false,
                indexed: true,
                readAccessType: 'ALL_DOMAIN_USERS',
              },
              {
                fieldName: 'Nickname',
                displayName: 'Nickname',
                fieldType: 'STRING',
                multiValued: false,
                indexed: true,
                readAccessType: 'ADMINS_AND_SELF',
              },
            ],
          },
          changes: [
            {
              change: 'added',
              fieldId: null,
              fieldName: 'Nickname',
              displayName: 'Nickname',
              properties: [],
              holders: null,
            },
          ],
        });
        assert.equal(answer.result.outcome, 'attribute-limit');
        await migrator.query(
          "DELETE FROM cc.user_attribute_categories WHERE customer_id=$1 AND schema_name='BulkInfo'",
          [customer],
        );
      },
    );

    await check(
      'K15 the category limit refuses the 101st category',
      async () => {
        for (let index = 0; index < 98; index += 1)
          await storeCategory(
            `schem=Limit${index}`,
            `Limit${index}`,
            `Limit ${index}`,
            '"etag-l"',
            attributes(1),
          );
        const answer = await createPlan(manager, {
          kind: 'create-category',
          schemaName: 'ExtraInfo',
          displayName: 'Extra info',
          body: {
            schemaName: 'ExtraInfo',
            displayName: 'Extra info',
            fields: [
              {
                fieldName: 'Team',
                displayName: 'Team',
                fieldType: 'STRING',
                multiValued: false,
                indexed: true,
                readAccessType: 'ADMINS_AND_SELF',
              },
            ],
          },
          changes: [
            {
              change: 'added',
              fieldId: null,
              fieldName: 'Team',
              displayName: 'Team',
              properties: [],
              holders: null,
            },
          ],
        });
        assert.equal(answer.result.outcome, 'category-limit');
        await migrator.query(
          "DELETE FROM cc.user_attribute_categories WHERE customer_id=$1 AND schema_name LIKE 'Limit%'",
          [customer],
        );
      },
    );

    let deletePlanId;
    await check(
      'K15 a delete plan freezes its phrase, and one confirm creates one CAT job',
      async () => {
        const created = await createPlan(manager, {
          kind: 'delete-category',
          schemaId: 'schem=StudentInfo',
          baseEtag: '"etag-1"',
          schemaName: 'StudentInfo',
          displayName: 'Student info',
          phrase: 'Student info',
          changes: [
            {
              change: 'removed',
              fieldId: 'fld-homeroom',
              fieldName: 'Homeroom',
              displayName: 'Homeroom',
              properties: [],
              holders: 12,
            },
            {
              change: 'removed',
              fieldId: 'fld-grade',
              fieldName: 'GradeLevel',
              displayName: 'Grade level',
              properties: [],
              holders: 0,
            },
          ],
        });
        assert.equal(
          created.result.outcome,
          'created',
          JSON.stringify(created.result),
        );
        deletePlanId = created.result.plan.planId;
        assert.equal(created.result.plan.phrase, 'Student info');
        assert.equal(created.result.plan.displayName, 'Student info');
        // A delete removes the category and its two attributes. The plan answer carries the
        // after-save counts as numbers, and it parses as the contract that the route answers.
        assert.deepEqual(created.result.plan.limits, {
          categories: 1,
          categoryLimit: 100,
          attributes: 1,
          attributeLimit: 100,
        });
        assert.equal(
          userAttributeCategoryPlanSchema.parse(created.result.plan).planId,
          deletePlanId,
        );
        // The digest and the typed phrase guard the confirm.
        const wrongDigest = await confirmPlan(
          manager,
          deletePlanId,
          'b'.repeat(64),
          'Student info',
        );
        assert.equal(wrongDigest.result.outcome, 'plan-changed');
        const wrongPhrase = await confirmPlan(
          manager,
          deletePlanId,
          'a'.repeat(64),
          'Student',
        );
        assert.equal(wrongPhrase.result.outcome, 'phrase-mismatch');
        const confirmed = await confirmPlan(
          manager,
          deletePlanId,
          'a'.repeat(64),
          'Student info',
        );
        assert.equal(confirmed.result.outcome, 'created');
        const receipt = confirmed.result.receipt;
        assert.match(receipt.displayId, /^CAT-\d{3,}$/);
        assert.equal(receipt.status, 'accepted');
        assert.equal(receipt.action, 'delete-category');
        assert.equal(receipt.changeCount, 2);
        assert.equal(
          userAttributeCategoryJobReceiptSchema.parse(receipt).jobId,
          receipt.jobId,
        );
        const job = await one(
          'SELECT kind,entity_type,status,display_id FROM cc.jobs WHERE job_id=$1',
          [receipt.jobId],
        );
        assert.deepEqual(job, {
          kind: 'user-schema-change',
          entity_type: 'user',
          status: 'accepted',
          display_id: receipt.displayId,
        });
        const detail = await one(
          'SELECT plan_id,confirmed_by FROM cc.user_schema_change_jobs WHERE job_id=$1',
          [receipt.jobId],
        );
        assert.deepEqual(detail, {
          plan_id: deletePlanId,
          confirmed_by: manager,
        });
        const repeated = await confirmPlan(
          manager,
          deletePlanId,
          'a'.repeat(64),
          'Student info',
        );
        assert.equal(repeated.result.outcome, 'existing');
        assert.equal(repeated.result.receipt.jobId, receipt.jobId);
        assert.equal(repeated.result.receipt.displayId, receipt.displayId);
        const jobs = await one(
          `SELECT count(*)::integer AS jobs FROM cc.user_schema_change_jobs WHERE plan_id=$1`,
          [deletePlanId],
        );
        assert.equal(jobs.jobs, 1);
        // The plan keeps its answer after the confirm, and the read answers the same valid plan.
        const read = await readPlan(manager, deletePlanId);
        assert.equal(read.result.outcome, 'plan');
        assert.equal(read.result.plan.planId, deletePlanId);
        assert.deepEqual(read.result.plan.limits, {
          categories: 1,
          categoryLimit: 100,
          attributes: 1,
          attributeLimit: 100,
        });
        assert.equal(
          userAttributeCategoryPlanSchema.parse(read.result.plan).planId,
          deletePlanId,
        );
      },
    );

    await check(
      'K15 another manager confirms no plan of the creator',
      async () => {
        const answer = await confirmPlan(
          other,
          deletePlanId,
          'a'.repeat(64),
          'Student info',
        );
        assert.equal(answer.result.outcome, 'not-found');
        // A person without the grant learns nothing of a plan, because the creator check comes
        // first. A creator whose grant was removed receives a refusal.
        const refused = await confirmPlan(
          reader,
          deletePlanId,
          'a'.repeat(64),
          'Student info',
        );
        assert.equal(refused.result.outcome, 'not-found');
        const revoked = await createPrincipal('revoked-manager', [
          district('users:schema-manage'),
        ]);
        const own = await createPlan(revoked, {
          kind: 'create-category',
          schemaName: 'RevokedInfo',
          displayName: 'Revoked info',
          body: {
            schemaName: 'RevokedInfo',
            displayName: 'Revoked info',
            fields: [
              {
                fieldName: 'Team',
                displayName: 'Team',
                fieldType: 'STRING',
                multiValued: false,
                indexed: true,
                readAccessType: 'ADMINS_AND_SELF',
              },
            ],
          },
          changes: [
            {
              change: 'added',
              fieldId: null,
              fieldName: 'Team',
              displayName: 'Team',
              properties: [],
              holders: null,
            },
          ],
        });
        assert.equal(own.result.outcome, 'created');
        await migrator.query(
          "DELETE FROM cc.application_grants WHERE principal_id=$1 AND action='users:schema-manage'",
          [revoked],
        );
        const revokedConfirm = await confirmPlan(
          revoked,
          own.result.plan.planId,
          'a'.repeat(64),
          null,
        );
        assert.equal(revokedConfirm.result.outcome, 'forbidden');
      },
    );

    await check(
      'K15 a lapsed plan answers plan-expired and creates no job',
      async () => {
        const planId = randomUUID();
        await migrator.query(
          `INSERT INTO cc.user_category_plans(plan_id,customer_id,created_by,permission_version,
          generation,action,schema_id,schema_name,base_etag,body,changes,limits,phrase,digest,
          prepared_at,expires_at)
         VALUES($1,$2,$3,1,$4,'delete-category','schem=StaffInfo','StaffInfo','"etag-2"',null,
           '[]','{}','StaffInfo',$5,clock_timestamp()-interval '16 minutes',
           clock_timestamp()-interval '1 minute')`,
          [planId, customer, manager, generation, 'c'.repeat(64)],
        );
        const read = await readPlan(manager, planId);
        assert.equal(read.result.outcome, 'plan-expired');
        const answer = await confirmPlan(
          manager,
          planId,
          'c'.repeat(64),
          'StaffInfo',
        );
        assert.equal(answer.result.outcome, 'plan-expired');
        const jobs = await one(
          'SELECT count(*)::integer AS jobs FROM cc.user_schema_change_jobs WHERE plan_id=$1',
          [planId],
        );
        assert.equal(jobs.jobs, 0);
        await migrator.query(
          'DELETE FROM cc.user_category_plans WHERE plan_id=$1',
          [planId],
        );
      },
    );

    await check(
      'K15 a changed connection generation refuses the store',
      async () => {
        const answer = await one(
          `SELECT cc.create_user_category_plan($1,1,$2,$3,$4,null,null,$5,$6,$7,$8,null,$9,15) AS result`,
          [
            manager,
            customer,
            generation + 1,
            'create-category',
            'GenerationInfo',
            'Generation info',
            JSON.stringify({
              schemaName: 'GenerationInfo',
              displayName: 'Generation info',
              fields: [
                {
                  fieldName: 'Team',
                  displayName: 'Team',
                  fieldType: 'STRING',
                  multiValued: false,
                  indexed: true,
                  readAccessType: 'ADMINS_AND_SELF',
                },
              ],
            }),
            JSON.stringify([
              {
                change: 'added',
                fieldId: null,
                fieldName: 'Team',
                displayName: 'Team',
                properties: [],
                holders: null,
              },
            ]),
            'a'.repeat(64),
          ],
        );
        assert.equal(answer.result.outcome, 'connection-changed');
      },
    );

    await check(
      'K15 a first confirmation refuses an edit or delete whose cached etag moved',
      async () => {
        const edit = await createPlan(manager, {
          kind: 'edit-category',
          schemaId: 'schem=StudentInfo',
          baseEtag: '"etag-1"',
          schemaName: 'StudentInfo',
          displayName: 'Student details',
          body: {
            schemaName: 'StudentInfo',
            displayName: 'Student details',
            fields: [
              {
                fieldId: 'fld-homeroom',
                fieldName: 'Homeroom',
                displayName: 'Homeroom',
                fieldType: 'STRING',
                multiValued: false,
                indexed: true,
                readAccessType: 'ADMINS_AND_SELF',
              },
              {
                fieldId: 'fld-grade',
                fieldName: 'GradeLevel',
                displayName: 'Grade level',
                fieldType: 'INT64',
                multiValued: false,
                indexed: true,
                readAccessType: 'ALL_DOMAIN_USERS',
                numericIndexingSpec: { minValue: 0, maxValue: 12 },
              },
            ],
          },
          changes: [],
        });
        assert.equal(
          edit.result.outcome,
          'created',
          JSON.stringify(edit.result),
        );
        const deletion = await createPlan(manager, {
          kind: 'delete-category',
          schemaId: 'schem=StudentInfo',
          baseEtag: '"etag-1"',
          schemaName: 'StudentInfo',
          displayName: 'Student info',
          phrase: 'Student info',
          changes: [
            {
              change: 'removed',
              fieldId: 'fld-homeroom',
              fieldName: 'Homeroom',
              displayName: 'Homeroom',
              properties: [],
              holders: 12,
            },
            {
              change: 'removed',
              fieldId: 'fld-grade',
              fieldName: 'GradeLevel',
              displayName: 'Grade level',
              properties: [],
              holders: 0,
            },
          ],
        });
        assert.equal(
          deletion.result.outcome,
          'created',
          JSON.stringify(deletion.result),
        );
        // Another change reaches the category after both plans were prepared (B section 6.2).
        await migrator.query(
          `UPDATE cc.user_attribute_categories SET etag='"etag-2"'
           WHERE schema_id='schem=StudentInfo'`,
        );
        for (const plan of [edit.result.plan, deletion.result.plan]) {
          const answer = await confirmPlan(
            manager,
            plan.planId,
            plan.digest,
            plan.phrase,
          );
          assert.equal(
            answer.result.outcome,
            'category-changed',
            JSON.stringify(answer.result),
          );
          const jobs = await one(
            'SELECT count(*)::integer AS jobs FROM cc.user_schema_change_jobs WHERE plan_id=$1',
            [plan.planId],
          );
          assert.equal(jobs.jobs, 0);
        }
        await migrator.query(
          `UPDATE cc.user_attribute_categories SET etag='"etag-1"'
           WHERE schema_id='schem=StudentInfo'`,
        );
      },
    );

    await check(
      'K15 a first confirmation refuses a vanished category',
      async () => {
        const deletion = await createPlan(manager, {
          kind: 'delete-category',
          schemaId: 'schem=StaffInfo',
          baseEtag: '"etag-2"',
          schemaName: 'StaffInfo',
          displayName: 'Staff info',
          phrase: 'Staff info',
          changes: [
            {
              change: 'removed',
              fieldId: 'fld-department',
              fieldName: 'Department',
              displayName: 'Department',
              properties: [],
              holders: 0,
            },
          ],
        });
        assert.equal(
          deletion.result.outcome,
          'created',
          JSON.stringify(deletion.result),
        );
        await migrator.query(
          `DELETE FROM cc.user_attribute_categories WHERE schema_id='schem=StaffInfo'`,
        );
        const answer = await confirmPlan(
          manager,
          deletion.result.plan.planId,
          deletion.result.plan.digest,
          'Staff info',
        );
        assert.equal(answer.result.outcome, 'category-changed');
        const jobs = await one(
          'SELECT count(*)::integer AS jobs FROM cc.user_schema_change_jobs WHERE plan_id=$1',
          [deletion.result.plan.planId],
        );
        assert.equal(jobs.jobs, 0);
        await storeCategory(
          'schem=StaffInfo',
          'StaffInfo',
          'Staff info',
          '"etag-2"',
          [
            {
              fieldId: 'fld-department',
              fieldName: 'Department',
              displayName: 'Department',
              fieldType: 'STRING',
              multiValued: false,
              indexed: true,
              readAccessType: 'ADMINS_AND_SELF',
              numericIndexingSpec: null,
              holders: 0,
            },
          ],
        );
      },
    );

    await check(
      'K15 a confirmed plan answers its receipt after the cached etag moved',
      async () => {
        const deletion = await createPlan(manager, {
          kind: 'delete-category',
          schemaId: 'schem=StaffInfo',
          baseEtag: '"etag-2"',
          schemaName: 'StaffInfo',
          displayName: 'Staff info',
          phrase: 'Staff info',
          changes: [
            {
              change: 'removed',
              fieldId: 'fld-department',
              fieldName: 'Department',
              displayName: 'Department',
              properties: [],
              holders: 0,
            },
          ],
        });
        assert.equal(
          deletion.result.outcome,
          'created',
          JSON.stringify(deletion.result),
        );
        const first = await confirmPlan(
          manager,
          deletion.result.plan.planId,
          deletion.result.plan.digest,
          'Staff info',
        );
        assert.equal(first.result.outcome, 'created');
        await migrator.query(
          `UPDATE cc.user_attribute_categories SET etag='"etag-3"'
           WHERE schema_id='schem=StaffInfo'`,
        );
        const replay = await confirmPlan(
          manager,
          deletion.result.plan.planId,
          deletion.result.plan.digest,
          'Staff info',
        );
        assert.equal(replay.result.outcome, 'existing');
        assert.equal(replay.result.receipt.jobId, first.result.receipt.jobId);
        assert.equal(
          replay.result.receipt.displayId,
          first.result.receipt.displayId,
        );
        await migrator.query(
          `UPDATE cc.user_attribute_categories SET etag='"etag-2"'
           WHERE schema_id='schem=StaffInfo'`,
        );
      },
    );

    await check(
      'K15 a padded category label passes the trimmed confirmation for each whitespace class and refuses a wrong case',
      async () => {
        // Every character that JavaScript String.prototype.trim removes: ASCII space, nonbreaking
        // space, vertical tab, em space, and the byte-order mark. The route trims the typed phrase
        // with trim(), so the SQL comparison must remove the same characters from the frozen label.
        const pads = ['  ', '\u00a0', '\u000b', '\u2003', '\ufeff'];
        const fields = [
          {
            fieldId: 'fld-padded-note',
            fieldName: 'Note',
            displayName: 'Note',
            fieldType: 'STRING',
            multiValued: false,
            indexed: true,
            readAccessType: 'ADMINS_AND_SELF',
            numericIndexingSpec: null,
            holders: 0,
          },
        ];
        const changes = [
          {
            change: 'removed',
            fieldId: 'fld-padded-note',
            fieldName: 'Note',
            displayName: 'Note',
            properties: [],
            holders: 0,
          },
        ];
        await storeCategory(
          'schem=PaddedInfo',
          'PaddedInfo',
          '  Padded info  ',
          '"etag-padded"',
          fields,
        );
        for (const [index, pad] of pads.entries()) {
          const label = `${pad}Padded info${pad}`;
          const etag = `"etag-padded-${index}"`;
          await migrator.query(
            `UPDATE cc.user_attribute_categories SET display_name=$2,etag=$3
             WHERE schema_id=$1`,
            ['schem=PaddedInfo', label, etag],
          );
          const stored = await createPlan(manager, {
            kind: 'delete-category',
            schemaId: 'schem=PaddedInfo',
            baseEtag: etag,
            schemaName: 'PaddedInfo',
            displayName: label,
            phrase: label,
            changes,
          });
          assert.equal(
            stored.result.outcome,
            'created',
            JSON.stringify(stored.result),
          );
          // The plan answer keeps the cached label and phrase with their padding.
          assert.equal(stored.result.plan.phrase, label);
          assert.equal(stored.result.plan.displayName, label);
          // The route trims the typed phrase, and the function trims the frozen phrase the same
          // way.
          const confirmed = await confirmPlan(
            manager,
            stored.result.plan.planId,
            stored.result.plan.digest,
            'Padded info',
          );
          assert.equal(
            confirmed.result.outcome,
            'created',
            `${JSON.stringify(pad)} ${JSON.stringify(confirmed.result)}`,
          );
          const second = await createPlan(manager, {
            kind: 'delete-category',
            schemaId: 'schem=PaddedInfo',
            baseEtag: etag,
            schemaName: 'PaddedInfo',
            displayName: label,
            phrase: label,
            changes,
          });
          assert.equal(
            second.result.outcome,
            'created',
            JSON.stringify(second.result),
          );
          const refused = await confirmPlan(
            manager,
            second.result.plan.planId,
            second.result.plan.digest,
            'padded info',
          );
          assert.equal(
            refused.result.outcome,
            'phrase-mismatch',
            JSON.stringify(pad),
          );
        }
        await migrator.query(
          `DELETE FROM cc.user_attribute_categories WHERE schema_id='schem=PaddedInfo'`,
        );
      },
    );

    await check(
      'J4 a plan stores the rename label and the info type of every change, and a create or delete stores none',
      async () => {
        const field = (fieldName, fieldType, extra = {}) => ({
          fieldId: `fld-j4-${fieldName.toLowerCase()}`,
          fieldName,
          displayName: fieldName,
          fieldType,
          multiValued: false,
          indexed: true,
          readAccessType: 'ADMINS_AND_SELF',
          numericIndexingSpec: null,
          holders: 0,
          ...extra,
        });
        await storeCategory('schem=J4Info', 'J4Info', 'J4 info', 'etag-j4-1', [
          field('Grade', 'INT64'),
          field('Homeroom', 'STRING'),
        ]);
        const stored = (planId) =>
          one(
            `SELECT previous_display_name, change_field_types,
              COALESCE(body->>'displayName',phrase) AS scope_name
              FROM cc.user_category_plans WHERE plan_id=$1`,
            [planId],
          );
        // An edit that renames the category, adds one attribute, changes the range of one, and
        // removes one stores the old label and the info type of all three changes.
        const edit = await createPlan(manager, {
          kind: 'edit-category',
          schemaId: 'schem=J4Info',
          baseEtag: 'etag-j4-1',
          schemaName: 'J4Info',
          displayName: 'J4 records',
          body: {
            schemaName: 'J4Info',
            displayName: 'J4 records',
            fields: [
              field('Grade', 'INT64', {
                numericIndexingSpec: { minValue: 1, maxValue: 12 },
              }),
              field('House', 'STRING', { fieldId: null }),
            ],
          },
          changes: [
            {
              change: 'changed',
              fieldId: 'fld-j4-grade',
              fieldName: 'Grade',
              displayName: 'Grade',
              properties: ['numericIndexingSpec'],
              holders: null,
            },
            {
              change: 'added',
              fieldName: 'House',
              displayName: 'House',
              properties: [],
              holders: null,
            },
            {
              change: 'removed',
              fieldId: 'fld-j4-homeroom',
              fieldName: 'Homeroom',
              displayName: 'Homeroom',
              properties: [],
              holders: 3,
            },
          ],
          phrase: 'Homeroom',
        });
        assert.equal(
          edit.result.outcome,
          'created',
          JSON.stringify(edit.result),
        );
        const editRow = await stored(edit.result.plan.planId);
        assert.equal(editRow.previous_display_name, 'J4 info');
        assert.deepEqual(editRow.change_field_types, [
          { fieldName: 'Grade', fieldType: 'INT64' },
          { fieldName: 'House', fieldType: 'STRING' },
          { fieldName: 'Homeroom', fieldType: 'STRING' },
        ]);

        // A create names no earlier label, and its body names each type.
        const created = await createPlan(manager, {
          kind: 'create-category',
          schemaName: 'J4New',
          displayName: 'J4 new',
          body: {
            schemaName: 'J4New',
            displayName: 'J4 new',
            fields: [field('Club', 'STRING', { fieldId: null })],
          },
          changes: [
            {
              change: 'added',
              fieldName: 'Club',
              displayName: 'Club',
              properties: [],
              holders: null,
            },
          ],
        });
        assert.equal(
          created.result.outcome,
          'created',
          JSON.stringify(created.result),
        );
        const createRow = await stored(created.result.plan.planId);
        assert.equal(createRow.previous_display_name, null);
        assert.deepEqual(createRow.change_field_types, [
          { fieldName: 'Club', fieldType: 'STRING' },
        ]);

        // A delete keeps the cached label as its scope name, names no earlier label, and stores
        // the type of each removed attribute.
        await migrator.query(
          `UPDATE cc.user_attribute_categories SET etag='etag-j4-2'
            WHERE schema_id='schem=J4Info'`,
        );
        const deleted = await createPlan(manager, {
          kind: 'delete-category',
          schemaId: 'schem=J4Info',
          baseEtag: 'etag-j4-2',
          schemaName: 'J4Info',
          displayName: 'J4 info',
          body: null,
          changes: [
            {
              change: 'removed',
              fieldId: 'fld-j4-grade',
              fieldName: 'Grade',
              displayName: 'Grade',
              properties: [],
              holders: 0,
            },
            {
              change: 'removed',
              fieldId: 'fld-j4-homeroom',
              fieldName: 'Homeroom',
              displayName: 'Homeroom',
              properties: [],
              holders: 0,
            },
          ],
          phrase: 'J4 info',
        });
        assert.equal(
          deleted.result.outcome,
          'created',
          JSON.stringify(deleted.result),
        );
        const deleteRow = await stored(deleted.result.plan.planId);
        assert.equal(deleteRow.previous_display_name, null);
        assert.equal(deleteRow.scope_name, 'J4 info');
        assert.deepEqual(deleteRow.change_field_types, [
          { fieldName: 'Grade', fieldType: 'INT64' },
          { fieldName: 'Homeroom', fieldType: 'STRING' },
        ]);

        // A same-name replacement keeps the cached type of the Removed row and the body type of
        // the Added row, so a name-keyed map can never answer both rows (card J4, R1-C).
        await storeCategory(
          'schem=J4Swap',
          'J4Swap',
          'J4 swap',
          'etag-j4-swap',
          [field('Example', 'STRING')],
        );
        const swapped = await createPlan(manager, {
          kind: 'edit-category',
          schemaId: 'schem=J4Swap',
          baseEtag: 'etag-j4-swap',
          schemaName: 'J4Swap',
          displayName: 'J4 swap',
          body: {
            schemaName: 'J4Swap',
            displayName: 'J4 swap',
            fields: [
              field('Example', 'BOOL', {
                fieldId: null,
                displayName: 'Example',
              }),
            ],
          },
          changes: [
            {
              change: 'removed',
              fieldId: 'fld-j4-example',
              fieldName: 'Example',
              displayName: 'Example',
              properties: [],
              holders: 2,
            },
            {
              change: 'added',
              fieldName: 'Example',
              displayName: 'Example',
              properties: [],
              holders: null,
            },
          ],
        });
        assert.equal(
          swapped.result.outcome,
          'created',
          JSON.stringify(swapped.result),
        );
        const swapRow = await stored(swapped.result.plan.planId);
        assert.deepEqual(swapRow.change_field_types, [
          { fieldName: 'Example', fieldType: 'STRING' },
          { fieldName: 'Example', fieldType: 'BOOL' },
        ]);
        await migrator.query(
          `DELETE FROM cc.user_attribute_categories WHERE schema_id='schem=J4Swap'`,
        );
      },
    );
  } finally {
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
      `User category plan checks failed: ${failures.join(' | ')}`,
    );
  return results;
}
