import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, test } from 'node:test';
import esbuild from 'esbuild';

/**
 * Compile the API TypeScript for this test only, so the real users controller, the real users
 * service, and the real exception filter answer the requests (K8 acceptance 1).
 */
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.ts') && url.includes('/api/src/')) {
      const file = fileURLToPath(url);
      const { code } = esbuild.transformSync(readFileSync(file, 'utf8'), {
        loader: 'ts',
        format: 'esm',
        target: 'node22',
        tsconfigRaw: {
          compilerOptions: {
            experimentalDecorators: true,
            useDefineForClassFields: false,
          },
        },
        sourcefile: file,
      });
      return { format: 'module', shortCircuit: true, source: code };
    }
    return nextLoad(url, context);
  },
});

const require = createRequire(import.meta.url);
const { ForbiddenException, Module } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');

const customer = 'C0123456';
const actor = '11111111-1111-4111-8111-111111111111';
const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const correlationId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const observedAt = new Date().toISOString();

const state = {
  customerId: customer,
  generation: 1,
  status: 'ready',
  observedAt,
  userCount: 2,
  failure: null,
  startedAt: observedAt,
  checkedAt: observedAt,
  stale: false,
};

const row = (id) => ({
  user_id: id,
  primary_email: `${id}@example.org`,
  org_unit_path: '/Students',
  given_name: 'Robin',
  family_name: 'Avery',
  full_name: `User ${id}`,
  suspended: false,
  suspension_reason: null,
  archived: false,
  last_login_time: null,
  creation_time: observedAt,
  two_step_enrolled: true,
  department: null,
  title: null,
  aliases: [],
  custom_schemas: {},
  last_entity_sync: observedAt,
  removed_at: null,
  record_version: 1,
});

const categories = {
  categories: [],
  limits: {
    categories: 0,
    categoryLimit: 100,
    attributes: 0,
    attributeLimit: 100,
  },
  observedAt,
};

let app;
let origin;
let checks;
let allowed;
let respond;
let routeRespond;
let defaultRoute;
let swaps;
let selectionValue;
let orchestrationFake;

before(async () => {
  const [
    controllerModule,
    serviceModule,
    securityModule,
    guardModule,
    orchestrationModule,
    tasks,
  ] = await Promise.all([
    import('./users.controller.ts'),
    import('./users.service.ts'),
    import('../security.ts'),
    import('../auth/auth.guard.ts'),
    import('../orchestration/orchestration.service.ts'),
    Promise.resolve({
      CacheService: class CacheService {},
      DatabaseService: class DatabaseService {},
      AuthService: class AuthService {},
      GoogleConnectionService: class GoogleConnectionService {},
    }),
  ]);
  const { UsersController } = controllerModule;
  const { UsersService } = serviceModule;
  const { ApplicationExceptionFilter, securityHeaders } = securityModule;
  const { AuthGuard } = guardModule;
  const { OrchestrationService } = orchestrationModule;

  checks = [];
  allowed = new Set(['users:read']);
  swaps = [];
  selectionValue = null;
  const now = new Date().toISOString();
  defaultRoute = async (text) => {
    if (text.includes('cc.read_user_sync'))
      return { rows: [{ result: state }] };
    if (text.includes('cc.request_user_sync'))
      return { rows: [{ result: state }] };
    if (text.includes('cc.abandon_user_sync'))
      return { rows: [{ result: null }] };
    if (text.includes('cc.read_user_attribute_categories'))
      return { rows: [{ result: categories }] };
    if (text.includes('count(*)::integer AS matching'))
      return { rows: [{ matching: 2 }] };
    if (text.includes('count(*)::integer AS stale'))
      return { rows: [{ stale: 0 }] };
    if (text.includes('count(*)::integer AS selected'))
      return { rows: [{ selected: 2 }] };
    if (text.includes('u.last_entity_sync<')) return { rows: [] };
    if (text.includes('AS stale')) return { rows: [] };
    if (text.includes('FROM cc.user_sync_state WHERE customer_id'))
      return { rows: [{ user_count: 2, observed_at: new Date(now) }] };
    if (text.includes('GROUP BY u.org_unit_path'))
      return { rows: [{ org_unit_path: '/Students', users: 2 }] };
    if (text.includes('OFFSET')) return { rows: [row('u1'), row('u2')] };
    if (text.includes('ORDER BY u.user_id LIMIT')) return { rows: [] };
    return { rows: [] };
  };
  // Every route resolves the connection first. The reader answers it for each test.
  respond = async (text, values) => {
    if (text.includes('cc.user_reader'))
      return { rows: [{ customer_id: customer, generation: 1 }] };
    return routeRespond(text, values);
  };
  routeRespond = defaultRoute;

  const database = {
    connection: { query: (text, values) => respond(text, values) },
    transaction: async (run) =>
      run({ query: (text, values) => respond(text, values) }),
  };
  const cache = {
    async get(key) {
      // Only the stored selection answers. The query generation reads as absent.
      return key.startsWith('cc:user-selection:') ? selectionValue : null;
    },
    async getMany(keys) {
      return keys.map(() => null);
    },
    async listSlice() {
      return { length: 0, ids: [] };
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
    async swap(key, expected, value) {
      swaps.push([key, expected, value]);
      selectionValue = value;
      return true;
    },
  };
  const orchestration = {
    async startUserSync(input) {
      checks.push(['startUserSync', input]);
      return 'execution-1';
    },
    async startEntitySync() {
      return 'execution-2';
    },
  };
  orchestrationFake = orchestration;
  const auth = {
    async authorize(_session, action) {
      checks.push(action);
      if (!allowed.has(action))
        throw new ForbiddenException(
          'This action requires additional permission.',
        );
    },
  };
  const connection = {
    async userReadCredential() {
      return { customerId: customer, generation: 1, accessToken: 'x' };
    },
    async checkHealth() {
      return { capabilities: [], checkedAt: observedAt };
    },
  };

  Reflect.defineMetadata(
    'design:paramtypes',
    [tasks.UsersService ?? UsersService, tasks.AuthService],
    UsersController,
  );
  Reflect.defineMetadata(
    'design:paramtypes',
    [
      tasks.DatabaseService,
      OrchestrationService,
      tasks.CacheService,
      tasks.AuthService,
      tasks.GoogleConnectionService,
    ],
    UsersService,
  );

  class UserRoutesModule {}
  Module({
    controllers: [UsersController],
    providers: [
      {
        provide: UsersService,
        useFactory: () =>
          new UsersService(database, orchestration, cache, auth, connection),
      },
      { provide: tasks.AuthService, useValue: auth },
    ],
  })(UserRoutesModule);

  const moduleRef = await Test.createTestingModule({
    imports: [UserRoutesModule],
  })
    .overrideGuard(AuthGuard)
    .useValue({
      canActivate: (context) => {
        const request = context.switchToHttp().getRequest();
        request.session = {
          identity: {
            id: actor,
            displayName: 'Test person',
            permissions: [],
            permissionVersion: 1,
            grants: [],
            preferences: {},
          },
          expiresAt: '2027-01-01T00:00:00.000Z',
          csrfToken: 'a'.repeat(64),
        };
        request.correlationId = correlationId;
        return true;
      },
    })
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.use(securityHeaders);
  app.useGlobalFilters(new ApplicationExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app?.close();
});

beforeEach(() => {
  routeRespond = defaultRoute;
});

async function post(path, payload) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

async function get(path) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: await response.json() };
}

test('a person without users:read answers 403 from the SQL gate', async () => {
  allowed = new Set(['users:read']);
  routeRespond = async () => {
    throw Object.assign(new Error('refused'), { code: '42501' });
  };
  const answer = await get('/api/users/sync');
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'forbidden' });
});

test('a person without users:read answers 403 from the person check', async () => {
  allowed = new Set();
  routeRespond = async (text) =>
    text.includes('cc.read_user_sync')
      ? { rows: [{ result: state }] }
      : { rows: [] };
  checks = [];
  const answer = await get('/api/users/org-units');
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.deepEqual(checks, ['users:read']);
});

test('a customer without a connection answers connection-required', async () => {
  allowed = new Set(['users:read']);
  routeRespond = async (text) =>
    text.includes('cc.read_user_sync')
      ? { rows: [{ result: null }] }
      : { rows: [] };
  const sync = await get('/api/users/sync');
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.deepEqual(sync.body, { sync: null });
  const started = await post('/api/users/sync', {});
  assert.equal(started.status, 409, JSON.stringify(started.body));
  assert.deepEqual(started.body, { reason: 'connection-required' });
  const refresh = await post('/api/users/selection/refresh', {
    gridId: 'users',
    tabId,
  });
  assert.equal(refresh.status, 409, JSON.stringify(refresh.body));
});

test('Refresh Users starts one sync and answers its state', async () => {
  allowed = new Set(['users:read']);
  checks = [];
  let requested;
  routeRespond = async (text, values) => {
    if (text.includes('cc.read_user_sync'))
      return { rows: [{ result: state }] };
    if (text.includes('cc.request_user_sync')) {
      requested = values;
      return { rows: [{ result: state }] };
    }
    return { rows: [] };
  };
  const answer = await post('/api/users/sync', {});
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(answer.body.sync.customerId, customer);
  assert.equal(requested[0], actor);
  assert.equal(requested[1], 1);
  assert.equal(requested[2], customer);
  assert.equal(requested[3], 1);
  assert.match(requested[4], /^[0-9a-f-]{36}$/);
  assert.equal(requested[5], correlationId);
  const started = checks.find((entry) => Array.isArray(entry));
  assert.deepEqual(started, [
    'startUserSync',
    { customerId: customer, syncId: requested[4], correlationId },
  ]);
});

test('a failed flow start abandons the sync and answers 503', async () => {
  allowed = new Set(['users:read']);
  const abandoned = [];
  routeRespond = async (text, values) => {
    if (text.includes('cc.read_user_sync'))
      return { rows: [{ result: state }] };
    if (text.includes('cc.request_user_sync'))
      return { rows: [{ result: state }] };
    if (text.includes('cc.abandon_user_sync')) {
      abandoned.push(values);
      return { rows: [{ result: null }] };
    }
    return { rows: [] };
  };
  const original = orchestrationFake.startUserSync;
  orchestrationFake.startUserSync = async () => {
    throw new Error('kestra down');
  };
  const answer = await post('/api/users/sync', {});
  orchestrationFake.startUserSync = original;
  assert.equal(answer.status, 503, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'orchestration-unavailable' });
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0][2], customer);
});

test('a page read answers the rows and the inventory total', async () => {
  allowed = new Set(['users:read']);
  checks = [];
  selectionValue = JSON.stringify({
    terms: [],
    additions: ['u1', 'u2'],
    exceptions: [],
    changedAt: new Date().toISOString(),
  });
  const answer = await post('/api/users/query', {
    selection: { gridId: 'users', tabId },
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(
    answer.body.page.rows.map((entry) => entry.userId),
    ['u1', 'u2'],
  );
  assert.equal(answer.body.page.matching, 2);
  assert.equal(answer.body.page.total, 2);
  assert.equal(answer.body.page.refreshJobId, null);
  assert.deepEqual(checks, ['users:read']);
});

test('a paging request reads only the named slice of the cached list', async () => {
  allowed = new Set(['users:read']);
  selectionValue = null;
  let requestedIds;
  routeRespond = async (text, values) => {
    if (text.includes('cc.read_user_sync'))
      return { rows: [{ result: state }] };
    if (text.includes('count(*)::integer AS matching'))
      return { rows: [{ matching: 3 }] };
    if (text.includes('ORDER BY u.full_name') && !text.includes('OFFSET'))
      return {
        rows: [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u3' }],
      };
    if (text.includes('requested')) {
      requestedIds = values[1];
      return { rows: [{ ...row('u2'), entry_version: 1 }] };
    }
    return { rows: [] };
  };
  const answer = await post('/api/users/query', { offset: 1, limit: 1 });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(requestedIds, ['u2']);
  assert.deepEqual(
    answer.body.page.rows.map((entry) => entry.userId),
    ['u2'],
  );
  assert.equal(answer.body.page.refreshJobId, null);
});

test('by-ids answers the current row when the cache holds no entry', async () => {
  allowed = new Set(['users:read']);
  selectionValue = null;
  routeRespond = async (text) => {
    if (text.includes('cc.read_user_sync'))
      return { rows: [{ result: state }] };
    if (text.includes('requested'))
      return { rows: [{ ...row('u1'), entry_version: 1 }] };
    return { rows: [] };
  };
  const answer = await post('/api/users/by-ids', { userIds: ['u1'] });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.rows[0].userId, 'u1');
  assert.equal(answer.body.rows[0].recordVersion, 1);
});

test('the category tab reads the cached set, not the user route', async () => {
  allowed = new Set(['users:read']);
  routeRespond = async (text) =>
    text.includes('cc.read_user_sync')
      ? { rows: [{ result: state }] }
      : text.includes('cc.read_user_attribute_categories')
        ? { rows: [{ result: categories }] }
        : { rows: [] };
  const answer = await get('/api/users/attribute-categories');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.observedAt, categories.observedAt);
  assert.equal(answer.body.limits.categoryLimit, 100);
});

test('one user reads by ID and an unknown ID answers 404', async () => {
  allowed = new Set(['users:read']);
  routeRespond = async (text, values) => {
    if (text.includes('cc.read_user_sync'))
      return { rows: [{ result: state }] };
    if (text.includes('AND u.user_id=$2')) return { rows: [row(values[1])] };
    return { rows: [] };
  };
  const answer = await get('/api/users/u1');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.user.userId, 'u1');
  routeRespond = async (text) =>
    text.includes('cc.read_user_sync')
      ? { rows: [{ result: state }] }
      : { rows: [] };
  const missing = await get('/api/users/nope');
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  assert.deepEqual(missing.body, { reason: 'user-not-found' });
});

test('a selection write stores the change and answers its counts', async () => {
  allowed = new Set(['users:read']);
  swaps = [];
  selectionValue = null;
  routeRespond = async (text) => {
    if (text.includes('cc.read_user_sync'))
      return { rows: [{ result: state }] };
    if (text.includes('count(*)::integer AS selected'))
      return { rows: [{ selected: 2 }] };
    return { rows: [] };
  };
  const answer = await post('/api/users/selection/ops', {
    gridId: 'users',
    tabId,
    ops: [{ op: 'select', ids: ['u1', 'u2'] }],
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.selection.added, 2);
  assert.equal(answer.body.selection.selectedCount, 2);
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0][0], `cc:user-selection:${actor}:users:${tabId}`);
});

test('Refresh Selected refuses an empty selection', async () => {
  allowed = new Set(['users:read']);
  selectionValue = null;
  routeRespond = async (text) =>
    text.includes('cc.read_user_sync')
      ? { rows: [{ result: state }] }
      : { rows: [] };
  const answer = await post('/api/users/selection/refresh', {
    gridId: 'users',
    tabId,
  });
  assert.equal(answer.status, 422, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'nothing-selected' });
});

/** The plan answer of B section 10, as the SQL function builds it. */
const planId = '0e1f1a4e-6a0d-4f38-9f4c-2d2b5a3c1b7e';
const planAt = new Date().toISOString();
const planAnswer = {
  planId,
  kind: 'create-category',
  method: 'insert',
  schemaId: null,
  schemaName: 'StudentInfo',
  displayName: 'Student info',
  baseEtag: null,
  changes: [
    {
      change: 'added',
      fieldId: null,
      fieldName: 'Homeroom',
      displayName: 'Homeroom',
      properties: [],
      holders: null,
    },
  ],
  phrase: null,
  limits: {
    categories: 1,
    categoryLimit: 100,
    attributes: 1,
    attributeLimit: 100,
  },
  preparedAt: planAt,
  expiresAt: new Date(Date.parse(planAt) + 900_000).toISOString(),
  digest: 'a'.repeat(64),
};
const planBase = {
  categories: [
    {
      schemaId: 'schem=StaffInfo',
      schemaName: 'StaffInfo',
      displayName: 'Staff info',
      etag: 'etag-1',
      fields: [
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
      holders: 0,
      readAt: planAt,
    },
  ],
  limits: {
    categories: 1,
    categoryLimit: 100,
    attributes: 1,
    attributeLimit: 100,
  },
  observedAt: planAt,
  customerId: customer,
  generation: 1,
};

test('an absent users:schema-manage answers 403 from each plan route', async () => {
  for (const [method, path, payload] of [
    [
      'POST',
      '/api/users/attribute-categories/plans',
      {
        kind: 'delete-category',
        schemaId: 'schem=StudentInfo',
        baseEtag: 'etag-1',
      },
    ],
    ['GET', `/api/users/attribute-categories/plans/${planId}`, undefined],
    [
      'POST',
      `/api/users/attribute-categories/plans/${planId}/confirm`,
      { digest: 'a'.repeat(64), acknowledged: true },
    ],
  ]) {
    allowed = new Set(['users:read']);
    checks = [];
    routeRespond = async (text) => {
      if (text.includes('cc.read_user_category_plan_base'))
        return { rows: [{ result: planBase }] };
      if (text.includes('cc.read_user_category_plan'))
        return {
          rows: [
            {
              result: {
                outcome: 'plan',
                customerId: customer,
                plan: planAnswer,
              },
            },
          ],
        };
      return { rows: [] };
    };
    const answer =
      method === 'GET' ? await get(path) : await post(path, payload ?? {});
    assert.equal(
      answer.status,
      403,
      `${method} ${path}: ${JSON.stringify(answer.body)}`,
    );
    assert.ok(
      checks.includes('users:schema-manage'),
      `${method} ${path} checked ${JSON.stringify(checks)}`,
    );
  }
});

test('the plan route stores one plan under the schema-manage gate', async () => {
  allowed = new Set(['users:schema-manage']);
  checks = [];
  let stored;
  routeRespond = async (text, values) => {
    if (text.includes('cc.read_user_category_plan_base'))
      return { rows: [{ result: planBase }] };
    if (text.includes('cc.create_user_category_plan')) {
      stored = values;
      return { rows: [{ result: { outcome: 'created', plan: planAnswer } }] };
    }
    return { rows: [] };
  };
  const answer = await post('/api/users/attribute-categories/plans', {
    kind: 'create-category',
    draft: {
      schemaName: 'StudentInfo',
      displayName: 'Student info',
      fields: [
        {
          fieldId: null,
          fieldName: 'Homeroom',
          displayName: 'Homeroom',
          fieldType: 'STRING',
          multiValued: false,
          indexed: true,
          readAccessType: 'ADMINS_AND_SELF',
          numericIndexingSpec: null,
        },
      ],
    },
  });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(answer.body.planId, planId);
  assert.equal(answer.body.method, 'insert');
  assert.equal(stored[2], customer);
  assert.equal(stored[3], 1);
  assert.equal(stored[4], 'create-category');
  assert.equal(stored[5], null);
  assert.equal(stored[6], null);
  assert.equal(stored[13], 15);
  assert.deepEqual(checks, ['users:schema-manage']);
});

test('the plan route answers 412 when the category changed before the store', async () => {
  allowed = new Set(['users:schema-manage']);
  routeRespond = async (text) => {
    if (text.includes('cc.read_user_category_plan_base'))
      return { rows: [{ result: planBase }] };
    if (text.includes('cc.create_user_category_plan'))
      return { rows: [{ result: { outcome: 'category-changed' } }] };
    return { rows: [] };
  };
  const answer = await post('/api/users/attribute-categories/plans', {
    kind: 'delete-category',
    schemaId: 'schem=StaffInfo',
    baseEtag: 'etag-1',
  });
  assert.equal(answer.status, 412, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'category-changed' });
});

test('the plan read answers the stored plan and 410 after expiry', async () => {
  allowed = new Set(['users:schema-manage']);
  routeRespond = async (text) => {
    if (text.includes('cc.read_user_category_plan'))
      return {
        rows: [
          {
            result: { outcome: 'plan', customerId: customer, plan: planAnswer },
          },
        ],
      };
    return { rows: [] };
  };
  const answer = await get(`/api/users/attribute-categories/plans/${planId}`);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.planId, planId);
  assert.equal(answer.body.expiresAt, planAnswer.expiresAt);
  routeRespond = async () => ({
    rows: [{ result: { outcome: 'plan-expired', expiresAt: planAt } }],
  });
  const expired = await get(`/api/users/attribute-categories/plans/${planId}`);
  assert.equal(expired.status, 410, JSON.stringify(expired.body));
  assert.deepEqual(expired.body, {
    reason: 'plan-expired',
    expiresAt: planAt,
  });
});

test('a confirm answers the CAT receipt, and a repeated confirm answers it again', async () => {
  allowed = new Set(['users:schema-manage']);
  const receipt = {
    jobId: '5c6d7e8f-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
    displayId: 'CAT-100',
    status: 'accepted',
    action: 'create-category',
    changeCount: 1,
  };
  let confirmations = 0;
  routeRespond = async (text, values) => {
    if (text.includes('cc.read_user_category_plan'))
      return {
        rows: [
          {
            result: { outcome: 'plan', customerId: customer, plan: planAnswer },
          },
        ],
      };
    if (text.includes('cc.confirm_user_category_plan')) {
      confirmations += 1;
      assert.equal(values[2], planId);
      assert.equal(values[3], 'a'.repeat(64));
      assert.equal(values[4], 'Homeroom');
      return {
        rows: [
          {
            result: {
              outcome: confirmations === 1 ? 'created' : 'existing',
              receipt,
            },
          },
        ],
      };
    }
    return { rows: [] };
  };
  const first = await post(
    `/api/users/attribute-categories/plans/${planId}/confirm`,
    {
      digest: 'a'.repeat(64),
      acknowledged: true,
      typedPhrase: '  Homeroom ',
    },
  );
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual(first.body, receipt);
  const again = await post(
    `/api/users/attribute-categories/plans/${planId}/confirm`,
    {
      digest: 'a'.repeat(64),
      acknowledged: true,
      typedPhrase: 'Homeroom',
    },
  );
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body, receipt);
});

test('a confirm answers 422 phrase-mismatch', async () => {
  allowed = new Set(['users:schema-manage']);
  routeRespond = async (text) => {
    if (text.includes('cc.read_user_category_plan'))
      return {
        rows: [
          {
            result: { outcome: 'plan', customerId: customer, plan: planAnswer },
          },
        ],
      };
    if (text.includes('cc.confirm_user_category_plan'))
      return { rows: [{ result: { outcome: 'phrase-mismatch' } }] };
    return { rows: [] };
  };
  const answer = await post(
    `/api/users/attribute-categories/plans/${planId}/confirm`,
    {
      digest: 'a'.repeat(64),
      acknowledged: true,
      typedPhrase: 'Wrong',
    },
  );
  assert.equal(answer.status, 422, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'phrase-mismatch' });
});

test('the plan routes refuse a body outside the contract', async () => {
  allowed = new Set(['users:schema-manage']);
  const answer = await post('/api/users/attribute-categories/plans', {
    kind: 'delete-category',
    schemaId: 'schem=StudentInfo',
    baseEtag: 'etag-1',
    draft: { displayName: 'Student details', fields: [] },
  });
  assert.equal(answer.status, 400, JSON.stringify(answer.body));
});
