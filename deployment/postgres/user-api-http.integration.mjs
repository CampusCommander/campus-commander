import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { entityKey } from '@campus/application-contracts';

const require = createRequire(import.meta.url);

/**
 * K8 round 1: the database-backed HTTP regressions of the users routes (R1). The real Nest
 * controller, service, guard boundary, and exception filter answer real requests over the
 * restricted runtime role. Redis, session authentication, Google, and orchestration boundaries
 * are controlled here; the database and its SQL are real.
 */
export async function qualifyUserApiHttp({
  runtime,
  migrator,
  issuer,
  connect,
  close,
}) {
  const { Module } = require('@nestjs/common');
  const { Test } = require('@nestjs/testing');
  const [
    { UsersController },
    { UsersService },
    { ApplicationExceptionFilter, securityHeaders },
    { AuthGuard },
    { OrchestrationService },
  ] = await Promise.all([
    import('../../api/src/app/users/users.controller.ts'),
    import('../../api/src/app/users/users.service.ts'),
    import('../../api/src/app/security.ts'),
    import('../../api/src/app/auth/auth.guard.ts'),
    import('../../api/src/app/orchestration/orchestration.service.ts'),
  ]);

  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const generation = connection.generation;
  const actor = randomUUID();
  const userIds = ['k8-http-1', 'k8-http-2', 'k8-http-3'];
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

  await migrator.query(
    'INSERT INTO cc.application_principals(id,issuer,subject,display_name,permission_version,enabled) VALUES($1,$2,$3,$4,$5,$6)',
    [actor, issuer, `k8-http-${actor}`, 'K8 HTTP', 1, true],
  );
  await migrator.query(
    'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
    [
      actor,
      'users:read',
      JSON.stringify({ kind: 'district', customerId: customer }),
    ],
  );

  const grades = {
    'k8-http-1': JSON.stringify({ StudentInfo: { GradeLevel: 7 } }),
    'k8-http-2': JSON.stringify({
      StudentInfo: { GradeLevel: '1e1000000000' },
    }),
    'k8-http-3': JSON.stringify({ StudentInfo: { GradeLevel: '8' } }),
  };
  const fullNames = {
    'k8-http-1': 'HTTP One',
    'k8-http-2': 'HTTP Two',
    'k8-http-3': 'HTTP Three',
  };
  const stored = {};
  for (const id of userIds) {
    await migrator.query(
      `INSERT INTO cc.users(customer_id,user_id,primary_email,org_unit_path,full_name,suspended,archived,
        two_step_enrolled,last_entity_sync,custom_schemas)
       VALUES($1,$2,$3,'/Students',$4,false,false,true,clock_timestamp(),$5)`,
      [customer, id, `${id}@example.org`, fullNames[id], grades[id]],
    );
    stored[id] = (
      await migrator.query('SELECT * FROM cc.users WHERE user_id=$1', [id])
    ).rows[0];
  }

  const iso = (value) =>
    value instanceof Date ? value.toISOString() : (value ?? null);
  const recordOf = (row) => ({
    userId: row.user_id,
    primaryEmail: row.primary_email,
    orgUnitPath: row.org_unit_path,
    givenName: row.given_name,
    familyName: row.family_name,
    fullName: row.full_name,
    suspended: row.suspended,
    suspensionReason: row.suspension_reason,
    archived: row.archived,
    lastLoginTime: iso(row.last_login_time),
    creationTime: iso(row.creation_time),
    twoStepEnrolled: row.two_step_enrolled,
    department: row.department,
    title: row.title,
    aliases: row.aliases,
    customSchemas: row.custom_schemas,
    lastEntitySync: iso(row.last_entity_sync),
  });
  const entryFor = (id, version, overrides = {}) =>
    JSON.stringify({
      version,
      record: { ...recordOf(stored[id]), ...overrides },
    });

  const cacheState = { entries: new Map(), failGetMany: false, list: null };
  const cache = {
    async get() {
      return null;
    },
    async getMany(keys) {
      if (cacheState.failGetMany) throw new Error('redis down');
      return keys.map((key) => cacheState.entries.get(key) ?? null);
    },
    async listSlice() {
      return cacheState.list ?? { length: 0, ids: [] };
    },
    async replaceList() {
      return undefined;
    },
    async remove() {
      return undefined;
    },
    async addMembers(_key, ids) {
      return [...ids];
    },
    async removeMembers() {
      return undefined;
    },
    async swap() {
      return true;
    },
    async increment() {
      return undefined;
    },
  };
  const database = {
    connection: { query: (text, values) => runtime.query(text, values) },
    transaction: async (run) => {
      const client = await connect('cc-app', 'cc-app');
      try {
        await client.query('BEGIN');
        const answer = await run(client);
        await client.query('COMMIT');
        return answer;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        await close(client);
      }
    },
  };
  const orchestration = {
    async startUserSync() {
      return 'execution-1';
    },
    async startEntitySync() {
      return 'execution-2';
    },
  };
  const auth = {
    async authorize() {
      return undefined;
    },
  };
  const google = {
    async userReadCredential() {
      return { customerId: customer, generation, accessToken: 'example' };
    },
    async checkHealth() {
      return { capabilities: [], checkedAt: new Date().toISOString() };
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
  Reflect.defineMetadata(
    'design:paramtypes',
    [
      tokens.DatabaseService,
      OrchestrationService,
      tokens.CacheService,
      tokens.AuthService,
      tokens.GoogleConnectionService,
    ],
    UsersService,
  );
  class UserHttpModule {}
  Module({
    controllers: [UsersController],
    providers: [
      {
        provide: UsersService,
        useFactory: () =>
          new UsersService(database, orchestration, cache, auth, google),
      },
      { provide: tokens.AuthService, useValue: auth },
    ],
  })(UserHttpModule);
  const moduleRef = await Test.createTestingModule({
    imports: [UserHttpModule],
  })
    .overrideGuard(AuthGuard)
    .useValue({
      canActivate: (context) => {
        const request = context.switchToHttp().getRequest();
        request.session = {
          identity: {
            id: actor,
            displayName: 'K8 HTTP',
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
  const post = async (path, body) => {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const reset = () => {
    cacheState.entries.clear();
    cacheState.failGetMany = false;
    cacheState.list = null;
  };

  try {
    await check(
      'K8 by-ids serves a current entity entry without Postgres',
      async () => {
        reset();
        const version = Number(stored['k8-http-1'].record_version);
        cacheState.entries.set(
          entityKey('user', customer, 'k8-http-1'),
          entryFor('k8-http-1', version, { fullName: 'Cached HTTP One' }),
        );
        const answer = await post('/api/users/by-ids', {
          userIds: ['k8-http-1'],
        });
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        assert.equal(answer.body.rows[0].fullName, 'Cached HTTP One');
        assert.equal(answer.body.rows[0].recordVersion, version);
      },
    );

    await check(
      'K8 by-ids hydrates a row when the cache holds no entry',
      async () => {
        reset();
        const answer = await post('/api/users/by-ids', {
          userIds: ['k8-http-1'],
        });
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        assert.equal(answer.body.rows[0].fullName, 'HTTP One');
        assert.equal(
          answer.body.rows[0].recordVersion,
          Number(stored['k8-http-1'].record_version),
        );
      },
    );

    await check(
      'K8 by-ids hydrates a row when the entry version is outdated',
      async () => {
        await migrator.query(
          "UPDATE cc.users SET title='bumped' WHERE user_id='k8-http-1'",
        );
        stored['k8-http-1'] = (
          await migrator.query('SELECT * FROM cc.users WHERE user_id=$1', [
            'k8-http-1',
          ])
        ).rows[0];
        const version = Number(stored['k8-http-1'].record_version);
        assert.ok(version > 1, 'the update advanced the record version');
        reset();
        cacheState.entries.set(
          entityKey('user', customer, 'k8-http-1'),
          entryFor('k8-http-1', version - 1, { fullName: 'Old HTTP One' }),
        );
        const answer = await post('/api/users/by-ids', {
          userIds: ['k8-http-1'],
        });
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        assert.equal(answer.body.rows[0].fullName, 'HTTP One');
        assert.equal(answer.body.rows[0].recordVersion, version);
      },
    );

    await check('K8 by-ids reads Postgres during a cache failure', async () => {
      reset();
      cacheState.failGetMany = true;
      const answer = await post('/api/users/by-ids', {
        userIds: ['k8-http-1', 'k8-http-3'],
      });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      assert.deepEqual(
        answer.body.rows.map((row) => row.userId),
        ['k8-http-1', 'k8-http-3'],
      );
    });

    await check(
      'K8 an initial page hydrates its rows from Postgres',
      async () => {
        reset();
        const answer = await post('/api/users/query', {
          predicates: [
            {
              field: 'primaryEmail',
              operator: 'contains',
              value: 'k8-http',
            },
          ],
          sort: { field: 'primaryEmail', direction: 'asc' },
          limit: 10,
        });
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        assert.equal(answer.body.page.matching, 3);
        assert.deepEqual(
          answer.body.page.rows.map((row) => row.userId),
          userIds,
        );
      },
    );

    await check(
      'K8 a cached page hydrates its rows from Postgres',
      async () => {
        reset();
        cacheState.list = { length: 3, ids: [...userIds] };
        const answer = await post('/api/users/query', {
          predicates: [
            {
              field: 'primaryEmail',
              operator: 'contains',
              value: 'k8-http',
            },
          ],
          sort: { field: 'primaryEmail', direction: 'asc' },
          limit: 10,
        });
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        assert.deepEqual(
          answer.body.page.rows.map((row) => row.userId),
          userIds,
        );
      },
    );

    await check(
      'K8 a numeric range omits an overflowing stored value',
      async () => {
        reset();
        const answer = await post('/api/users/query', {
          predicates: [
            {
              field: 'primaryEmail',
              operator: 'contains',
              value: 'k8-http',
            },
            {
              field: 'attribute',
              schemaName: 'StudentInfo',
              fieldName: 'GradeLevel',
              operator: 'numberRange',
              from: 6,
              to: 8,
            },
          ],
          limit: 10,
        });
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        assert.deepEqual(
          answer.body.page.rows.map((row) => row.userId),
          ['k8-http-1', 'k8-http-3'],
        );
      },
    );
  } finally {
    await app.close();
    for (const id of userIds)
      await migrator.query('DELETE FROM cc.users WHERE user_id=$1', [id]);
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
      `${failures.length} user API HTTP checks failed: ${failures.join(', ')}`,
    );
  return results;
}
