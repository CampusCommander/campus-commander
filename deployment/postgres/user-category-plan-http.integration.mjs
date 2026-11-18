import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  userAttributeCategoryJobReceiptSchema,
  userAttributeCategoryPlanSchema,
} from '../../libs/application-contracts/src/lib/users.ts';

const require = createRequire(import.meta.url);

/**
 * K15 round 1: the database-backed HTTP regressions of the category plan routes (R1-R3). The real
 * Nest controller, service, guard boundary, and exception filter answer real requests over the
 * restricted runtime role. Session authentication, the route-level authorization service, and the
 * Google connection service are controlled here; the database and its SQL are real.
 */
export async function qualifyUserCategoryPlanHttp({
  runtime,
  migrator,
  issuer,
}) {
  const { Module } = require('@nestjs/common');
  const { Test } = require('@nestjs/testing');
  const [
    { UsersController },
    { UsersService },
    { ApplicationExceptionFilter, securityHeaders },
    { AuthGuard },
  ] = await Promise.all([
    import('../../api/src/app/users/users.controller.ts'),
    import('../../api/src/app/users/users.service.ts'),
    import('../../api/src/app/security.ts'),
    import('../../api/src/app/auth/auth.guard.ts'),
  ]);

  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const actor = randomUUID();
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

  await migrator.query(
    'INSERT INTO cc.application_principals(id,issuer,subject,display_name,permission_version,enabled) VALUES($1,$2,$3,$4,$5,$6)',
    [actor, issuer, `k15-http-${actor}`, 'K15 HTTP', 1, true],
  );
  await migrator.query(
    'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
    [
      actor,
      'users:schema-manage',
      JSON.stringify({ kind: 'district', customerId: customer }),
    ],
  );

  const counts = async () =>
    one(
      `SELECT count(*)::integer AS categories,
        COALESCE(sum(jsonb_array_length(fields)),0)::integer AS attributes
       FROM cc.user_attribute_categories WHERE customer_id=$1`,
      [customer],
    );
  const field = (index, name, overrides = {}) => ({
    fieldId: `fld-http-${index}`,
    fieldName: name,
    displayName: name,
    fieldType: 'STRING',
    multiValued: false,
    indexed: true,
    readAccessType: 'ADMINS_AND_SELF',
    numericIndexingSpec: null,
    holders: 0,
    ...overrides,
  });
  /** One draft field: the editor sends no holder count. */
  const draft = (index, name) => ({
    fieldId: `fld-http-${index}`,
    fieldName: name,
    displayName: name,
    fieldType: 'STRING',
    multiValued: false,
    indexed: true,
    readAccessType: 'ADMINS_AND_SELF',
    numericIndexingSpec: null,
  });
  const seed = async (schemaId, schemaName, displayName, etag, fields) => {
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
  const removeSeed = (schemaIds) =>
    migrator.query(
      `DELETE FROM cc.user_attribute_categories
       WHERE customer_id=$1 AND schema_id=ANY($2::text[])`,
      [customer, schemaIds],
    );

  const database = { connection: runtime };
  const orchestration = {
    async startUserSync() {
      return 'execution-1';
    },
    async startEntitySync() {
      return 'execution-2';
    },
  };
  const cache = {
    async get() {
      return null;
    },
    async getMany(keys) {
      return keys.map(() => null);
    },
    async remove() {
      return undefined;
    },
    async replaceList() {
      return undefined;
    },
    async listSlice() {
      return { length: 0, ids: [] };
    },
  };
  const auth = {
    async authorize() {
      return undefined;
    },
  };
  const google = {
    async userReadCredential() {
      throw new Error('No Google calls permitted');
    },
    async checkHealth() {
      throw new Error('No Google calls permitted');
    },
  };
  const tokens = {
    CacheService: class CacheService {},
    DatabaseService: class DatabaseService {},
    AuthService: class AuthService {},
    GoogleConnectionService: class GoogleConnectionService {},
  };
  Reflect.defineMetadata(
    'design:paramtypes',
    [UsersService, tokens.AuthService],
    UsersController,
  );
  class UserCategoryPlanHttpModule {}
  Module({
    controllers: [UsersController],
    providers: [
      {
        provide: UsersService,
        useValue: new UsersService(
          database,
          orchestration,
          cache,
          auth,
          google,
        ),
      },
      { provide: tokens.AuthService, useValue: auth },
    ],
  })(UserCategoryPlanHttpModule);
  const moduleRef = await Test.createTestingModule({
    imports: [UserCategoryPlanHttpModule],
  })
    .overrideGuard(AuthGuard)
    .useValue({
      canActivate: (context) => {
        const request = context.switchToHttp().getRequest();
        request.session = {
          identity: {
            id: actor,
            displayName: 'K15 HTTP',
            permissions: [],
            permissionVersion: 1,
            grants: [],
            preferences: {},
          },
          expiresAt: '2027-01-01T00:00:00.000Z',
          csrfToken: 'a'.repeat(64),
        };
        request.correlationId = randomUUID();
        return true;
      },
    })
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.use(securityHeaders);
  app.useGlobalFilters(new ApplicationExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const request = async (method, suffix, body) => {
    const response = await fetch(
      `${origin}/api/users/attribute-categories/plans${suffix}`,
      {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  const jobCount = async (planId) =>
    (
      await one(
        'SELECT count(*)::integer AS jobs FROM cc.user_schema_change_jobs WHERE plan_id=$1',
        [planId],
      )
    ).jobs;

  const schemaId = 'schema=StudentInfo';
  const etag = '"etag-1"';
  try {
    await seed(schemaId, 'StudentInfo', 'Student info', etag, [
      field(1, 'First'),
      field(2, 'Second'),
      field(3, 'Third'),
    ]);

    await check(
      'K15 a delete plan answers a valid after-save plan from POST and GET',
      async () => {
        const before = await counts();
        const answer = await request('POST', '', {
          kind: 'delete-category',
          schemaId,
          baseEtag: etag,
        });
        assert.equal(answer.status, 201, JSON.stringify(answer.body));
        const plan = userAttributeCategoryPlanSchema.parse(answer.body);
        assert.deepEqual(plan.limits, {
          categories: before.categories - 1,
          categoryLimit: 100,
          attributes: before.attributes - 3,
          attributeLimit: 100,
        });
        const read = await request('GET', `/${plan.planId}`);
        assert.equal(read.status, 200, JSON.stringify(read.body));
        assert.equal(
          userAttributeCategoryPlanSchema.parse(read.body).planId,
          plan.planId,
        );
        assert.deepEqual(read.body.limits, plan.limits);
      },
    );

    await check(
      'K15 a first confirmation refuses an edit or delete whose cached etag moved',
      async () => {
        const edit = await request('POST', '', {
          kind: 'edit-category',
          schemaId,
          baseEtag: etag,
          draft: {
            displayName: 'Student details',
            fields: [draft(1, 'First'), draft(2, 'Second'), draft(3, 'Third')],
          },
        });
        assert.equal(edit.status, 201, JSON.stringify(edit.body));
        const deletion = await request('POST', '', {
          kind: 'delete-category',
          schemaId,
          baseEtag: etag,
        });
        assert.equal(deletion.status, 201, JSON.stringify(deletion.body));
        await migrator.query(
          `UPDATE cc.user_attribute_categories SET etag='"etag-2"'
           WHERE customer_id=$1 AND schema_id=$2`,
          [customer, schemaId],
        );
        for (const plan of [edit.body, deletion.body]) {
          const answer = await request('POST', `/${plan.planId}/confirm`, {
            digest: plan.digest,
            acknowledged: true,
            ...(plan.phrase === null ? {} : { typedPhrase: plan.phrase }),
          });
          assert.equal(answer.status, 412, JSON.stringify(answer.body));
          assert.deepEqual(answer.body, { reason: 'category-changed' });
          assert.equal(await jobCount(plan.planId), 0);
        }
        await migrator.query(
          `UPDATE cc.user_attribute_categories SET etag=$3
           WHERE customer_id=$1 AND schema_id=$2`,
          [customer, schemaId, etag],
        );
      },
    );

    await check(
      'K15 a first confirmation refuses a vanished category',
      async () => {
        const deletion = await request('POST', '', {
          kind: 'delete-category',
          schemaId,
          baseEtag: etag,
        });
        assert.equal(deletion.status, 201, JSON.stringify(deletion.body));
        await removeSeed([schemaId]);
        const answer = await request(
          'POST',
          `/${deletion.body.planId}/confirm`,
          {
            digest: deletion.body.digest,
            acknowledged: true,
            typedPhrase: deletion.body.phrase,
          },
        );
        assert.equal(answer.status, 412, JSON.stringify(answer.body));
        assert.equal(await jobCount(deletion.body.planId), 0);
        await seed(schemaId, 'StudentInfo', 'Student info', etag, [
          field(1, 'First'),
          field(2, 'Second'),
          field(3, 'Third'),
        ]);
      },
    );

    await check(
      'K15 a repeated confirmation answers its receipt after the cached etag moved',
      async () => {
        const deletion = await request('POST', '', {
          kind: 'delete-category',
          schemaId,
          baseEtag: etag,
        });
        assert.equal(deletion.status, 201, JSON.stringify(deletion.body));
        const first = await request(
          'POST',
          `/${deletion.body.planId}/confirm`,
          {
            digest: deletion.body.digest,
            acknowledged: true,
            typedPhrase: deletion.body.phrase,
          },
        );
        assert.equal(first.status, 201, JSON.stringify(first.body));
        assert.equal(
          userAttributeCategoryJobReceiptSchema.parse(first.body).displayId,
          first.body.displayId,
        );
        await migrator.query(
          `UPDATE cc.user_attribute_categories SET etag='"etag-3"'
           WHERE customer_id=$1 AND schema_id=$2`,
          [customer, schemaId],
        );
        const replay = await request(
          'POST',
          `/${deletion.body.planId}/confirm`,
          {
            digest: deletion.body.digest,
            acknowledged: true,
            typedPhrase: deletion.body.phrase,
          },
        );
        assert.equal(replay.status, 200, JSON.stringify(replay.body));
        assert.deepEqual(replay.body, first.body);
        assert.equal(await jobCount(deletion.body.planId), 1);
        await migrator.query(
          `UPDATE cc.user_attribute_categories SET etag=$3
           WHERE customer_id=$1 AND schema_id=$2`,
          [customer, schemaId, etag],
        );
      },
    );

    await check(
      'K15 a padded category label passes the trimmed confirmation and refuses a wrong case',
      async () => {
        await migrator.query(
          `UPDATE cc.user_attribute_categories SET display_name='  Student info  ',etag='"etag-padded"'
           WHERE customer_id=$1 AND schema_id=$2`,
          [customer, schemaId],
        );
        const deletion = await request('POST', '', {
          kind: 'delete-category',
          schemaId,
          baseEtag: '"etag-padded"',
        });
        assert.equal(deletion.status, 201, JSON.stringify(deletion.body));
        assert.equal(deletion.body.phrase, '  Student info  ');
        assert.equal(deletion.body.displayName, '  Student info  ');
        const confirmed = await request(
          'POST',
          `/${deletion.body.planId}/confirm`,
          {
            digest: deletion.body.digest,
            acknowledged: true,
            typedPhrase: '  Student info  ',
          },
        );
        assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
        assert.equal(confirmed.body.action, 'delete-category');
        const second = await request('POST', '', {
          kind: 'delete-category',
          schemaId,
          baseEtag: '"etag-padded"',
        });
        assert.equal(second.status, 201, JSON.stringify(second.body));
        const refused = await request(
          'POST',
          `/${second.body.planId}/confirm`,
          {
            digest: second.body.digest,
            acknowledged: true,
            typedPhrase: 'student info',
          },
        );
        assert.equal(refused.status, 422, JSON.stringify(refused.body));
        assert.deepEqual(refused.body, { reason: 'phrase-mismatch' });
      },
    );
  } finally {
    await app.close();
    await migrator.query(
      `DELETE FROM cc.jobs WHERE job_id IN (SELECT d.job_id FROM cc.user_schema_change_jobs d
        JOIN cc.user_category_plans p ON p.plan_id=d.plan_id WHERE p.created_by=$1)`,
      [actor],
    );
    await migrator.query(
      'DELETE FROM cc.user_category_plans WHERE created_by=$1',
      [actor],
    );
    await removeSeed([schemaId, 'schema=StaffInfo', 'schema=PaddedInfo']);
    await migrator.query(
      'DELETE FROM cc.application_grants WHERE principal_id=$1',
      [actor],
    );
    await migrator.query('DELETE FROM cc.application_principals WHERE id=$1', [
      actor,
    ]);
  }

  if (failures.length)
    throw new Error(
      `${failures.length} category plan HTTP checks failed: ${failures.join(', ')}`,
    );
  return results;
}
