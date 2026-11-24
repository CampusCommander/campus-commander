import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, test } from 'node:test';
import esbuild from 'esbuild';

/**
 * The value preview routes of B section 10, through the real users controller, the real users
 * service, and the real exception filter. The SQL doubles match the prepared text, so the route
 * test reads the same argument positions that migration 028 takes.
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
const previewId = '22222222-2222-4222-8222-222222222222';
const jobId = '5c6d7e8f-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const correlationId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const at = new Date().toISOString();
const preparedAt = at;
const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
const digest = 'b'.repeat(64);
const etag = '"etag-1"';

const field = (overrides) => ({
  fieldId: 'fld-1',
  fieldName: 'Homeroom',
  displayName: 'Homeroom',
  fieldType: 'STRING',
  multiValued: false,
  indexed: true,
  readAccessType: 'ADMINS_AND_SELF',
  numericIndexingSpec: null,
  holders: 2,
  ...overrides,
});
const base = {
  customerId: customer,
  generation: 1,
  categories: [
    {
      schemaId: 'schem=StudentInfo',
      schemaName: 'StudentInfo',
      displayName: 'Student info',
      etag,
      holders: 2,
      readAt: at,
      fields: [
        field({}),
        field({
          fieldId: 'fld-2',
          fieldName: 'Programs',
          displayName: 'Programs',
          multiValued: true,
        }),
        field({
          fieldId: 'fld-3',
          fieldName: 'Grade',
          displayName: 'Grade',
          fieldType: 'INT64',
          numericIndexingSpec: { minValue: 0, maxValue: 12 },
        }),
      ],
    },
  ],
  limits: {
    categories: 1,
    categoryLimit: 100,
    attributes: 3,
    attributeLimit: 100,
  },
  observedAt: at,
};
const selectionPreview = {
  previewId,
  source: 'selection',
  changes: [
    {
      schemaName: 'StudentInfo',
      fieldName: 'Homeroom',
      mode: 'set',
      values: ['B12'],
    },
  ],
  attributeChanges: 1,
  selected: 2,
  eligible: 1,
  unchanged: 1,
  conflicts: 0,
  oldestObservedAt: at,
  stale: false,
  preparedAt,
  expiresAt,
  manifestDigest: digest,
};
const editPreview = {
  ...selectionPreview,
  source: 'edit-list',
  changes: null,
  selected: 2,
  eligible: 1,
  unchanged: 0,
  conflicts: 1,
};
const receipt = {
  jobId,
  displayId: 'UAT-101',
  status: 'accepted',
  userCount: 1,
  changeCount: 1,
};
const selectionRow = (id, homeroom) => ({
  user_id: id,
  primary_email: `${id}@example.org`,
  custom_schemas: { StudentInfo: { Homeroom: homeroom } },
  last_entity_sync: at,
});
const pageRow = (overrides) => ({
  ordinal: 0,
  userId: 'u1',
  primaryEmail: 'u1@example.org',
  schemaName: 'StudentInfo',
  fieldName: 'Homeroom',
  currentValue: 'B11',
  newValue: 'B12',
  disposition: 'eligible',
  observedAt: at,
  ...overrides,
});

let app;
let origin;
let service;
let checks;
let allowed;
let routeRespond;
let defaultRoute;
let readUserValues;
let readCalls;

before(async () => {
  const [controllerModule, serviceModule, securityModule, guardModule] =
    await Promise.all([
      import('./users.controller.ts'),
      import('./users.service.ts'),
      import('../security.ts'),
      import('../auth/auth.guard.ts'),
    ]);
  const { UsersController } = controllerModule;
  const { UsersService } = serviceModule;
  const { ApplicationExceptionFilter, securityHeaders } = securityModule;
  const { AuthGuard } = guardModule;
  class CacheService {}
  class DatabaseService {}
  class AuthService {}
  class GoogleConnectionService {}
  class OrchestrationService {}

  checks = [];
  allowed = new Set(['users:write', 'users:bulk-actions']);
  readCalls = [];
  defaultRoute = async (text) => {
    if (text.includes('cc.read_user_attribute_preview_base'))
      return { rows: [{ result: base }] };
    if (text.includes('cc.user_attribute_writer'))
      return { rows: [{ customer_id: customer, generation: 1 }] };
    if (text.includes('u.custom_schemas'))
      return { rows: [selectionRow('u1', 'B11'), selectionRow('u2', 'B12')] };
    if (text.includes('FROM cc.users'))
      return {
        rows: [
          { user_id: 'u1', primary_email: 'u1@example.org' },
          { user_id: 'u2', primary_email: 'u2@example.org' },
        ],
      };
    if (text.includes('cc.create_user_attribute_preview'))
      return {
        rows: [{ result: { outcome: 'created', preview: selectionPreview } }],
      };
    if (text.includes('cc.read_user_attribute_preview_targets'))
      return {
        rows: [
          {
            result: {
              outcome: 'page',
              customerId: customer,
              targets: [],
              nextCursor: null,
            },
          },
        ],
      };
    if (text.includes('cc.read_user_attribute_preview'))
      return {
        rows: [
          {
            result: {
              outcome: 'preview',
              customerId: customer,
              preview: selectionPreview,
            },
          },
        ],
      };
    if (text.includes('cc.confirm_user_attribute_preview'))
      return {
        rows: [{ result: { outcome: 'created', receipt } }],
      };
    return { rows: [] };
  };
  routeRespond = defaultRoute;
  // The service builds its Google reader itself. The test replaces it, so no request leaves.
  readUserValues = async () => ({ StudentInfo: { Homeroom: 'B11' } });

  const database = {
    connection: { query: (text, values) => routeRespond(text, values) },
    transaction: async (run) =>
      run({ query: (text, values) => routeRespond(text, values) }),
  };
  const cache = {
    async get(key) {
      return key.startsWith('cc:user-selection:')
        ? JSON.stringify({
            terms: [],
            additions: ['u1', 'u2'],
            exceptions: [],
            changedAt: at,
          })
        : null;
    },
    async getMany(keys) {
      return keys.map(() => null);
    },
  };
  const orchestration = {
    async startUserSync() {
      return 'execution-1';
    },
  };
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
    async userValueCredential() {
      return { customerId: customer, generation: 1, accessToken: 'x' };
    },
  };

  Reflect.defineMetadata(
    'design:paramtypes',
    [UsersService, AuthService],
    UsersController,
  );
  Reflect.defineMetadata(
    'design:paramtypes',
    [
      DatabaseService,
      OrchestrationService,
      CacheService,
      AuthService,
      GoogleConnectionService,
    ],
    UsersService,
  );

  class UserPreviewRoutesModule {}
  Module({
    controllers: [UsersController],
    providers: [
      {
        provide: UsersService,
        useFactory: () => {
          service = new UsersService(
            database,
            orchestration,
            cache,
            auth,
            connection,
          );
          // The Google reader is a private field of the service. Replace it for this test only.
          service.reader = {
            userValues: (...args) => {
              readCalls.push(args);
              return readUserValues(...args);
            },
          };
          return service;
        },
      },
      { provide: AuthService, useValue: auth },
    ],
  })(UserPreviewRoutesModule);

  const moduleRef = await Test.createTestingModule({
    imports: [UserPreviewRoutesModule],
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
  allowed = new Set(['users:write', 'users:bulk-actions']);
  checks = [];
  readCalls = [];
  readUserValues = async () => ({ StudentInfo: { Homeroom: 'B11' } });
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

const selectionBody = (changes) => ({
  gridId: 'users',
  tabId,
  changes: changes ?? [
    {
      schemaName: 'StudentInfo',
      fieldName: 'Homeroom',
      mode: 'set',
      values: ['B12'],
    },
  ],
});
const editBody = (edits) => ({
  edits: edits ?? [
    {
      userId: 'u1',
      attribute: 'attr:StudentInfo.Homeroom',
      mode: 'set',
      values: ['B12'],
      baselineValue: 'B11',
    },
  ],
});

test('a session without users:write answers 403 from each value preview route', async () => {
  allowed = new Set();
  routeRespond = async () => {
    throw Object.assign(new Error('refused'), { code: '42501' });
  };
  const answers = [
    await post('/api/users/attribute-previews', selectionBody()),
    await post('/api/users/attribute-previews', editBody()),
    await get(`/api/users/attribute-previews/${previewId}`),
    await get(`/api/users/attribute-previews/${previewId}/targets`),
    await post(`/api/users/attribute-previews/${previewId}/confirm`, {
      manifestDigest: digest,
      acknowledged: true,
    }),
  ];
  for (const answer of answers) {
    assert.equal(answer.status, 403, JSON.stringify(answer.body));
    assert.deepEqual(answer.body, { reason: 'forbidden' });
  }
});

test('a selection preview without users:bulk-actions answers 403 and stores nothing', async () => {
  allowed = new Set(['users:write']);
  let creates = 0;
  const fallback = routeRespond;
  routeRespond = async (text, values) => {
    if (text.includes('cc.create_user_attribute_preview')) creates += 1;
    return fallback(text, values);
  };
  const answer = await post('/api/users/attribute-previews', selectionBody());
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.deepEqual(checks, ['users:write', 'users:bulk-actions']);
  assert.equal(creates, 0);
});

test('a selection preview freezes its rows, counts, etag, and digest', async () => {
  let stored;
  const fallback = routeRespond;
  routeRespond = async (text, values) => {
    if (text.includes('cc.create_user_attribute_preview')) {
      stored = values;
      return {
        rows: [
          {
            result: {
              outcome: 'created',
              preview: { ...selectionPreview, manifestDigest: values[7] },
            },
          },
        ],
      };
    }
    return fallback(text, values);
  };
  const answer = await post('/api/users/attribute-previews', selectionBody());
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(answer.body.previewId, previewId);
  assert.equal(answer.body.selected, 2);
  assert.equal(answer.body.eligible, 1);
  assert.equal(answer.body.unchanged, 1);
  assert.equal(answer.body.conflicts, 0);
  assert.equal(answer.body.stale, false);
  assert.deepEqual(answer.body.changes, selectionPreview.changes);
  assert.deepEqual(checks, ['users:write', 'users:bulk-actions']);
  assert.equal(stored[0], actor);
  assert.equal(stored[1], 1);
  assert.equal(stored[2], customer);
  assert.equal(stored[3], 1);
  assert.equal(stored[4], 'selection');
  assert.deepEqual(JSON.parse(stored[5]), { gridId: 'users', tabId });
  assert.deepEqual(JSON.parse(stored[6]), selectionPreview.changes);
  assert.match(stored[7], /^[a-f0-9]{64}$/);
  assert.equal(answer.body.manifestDigest, stored[7]);
  const targets = JSON.parse(stored[8]);
  assert.deepEqual(
    targets.map((target) => [
      target.userId,
      target.ordinal,
      target.disposition,
    ]),
    [
      ['u1', 0, 'eligible'],
      ['u2', 1, 'unchanged'],
    ],
  );
  assert.deepEqual(
    targets[0].rows.map((row) => [
      row.fieldName,
      row.currentValue,
      row.newValue,
      row.disposition,
    ]),
    [['Homeroom', 'B11', 'B12', 'eligible']],
  );
  assert.deepEqual(JSON.parse(stored[9]), [
    { schemaName: 'StudentInfo', etag },
  ]);
  assert.equal(stored[10], 15);
});

test('an edit-list preview reads Google fresh and freezes a Conflict', async () => {
  let stored;
  const fallback = routeRespond;
  routeRespond = async (text, values) => {
    if (text.includes('cc.create_user_attribute_preview')) {
      stored = values;
      return {
        rows: [
          {
            result: {
              outcome: 'created',
              preview: { ...editPreview, manifestDigest: values[7] },
            },
          },
        ],
      };
    }
    return fallback(text, values);
  };
  readUserValues = async (_credential, userId) =>
    userId === 'u1'
      ? { StudentInfo: { Homeroom: 'B13' } }
      : { StudentInfo: { Homeroom: 'B11' } };
  const answer = await post(
    '/api/users/attribute-previews',
    editBody([
      {
        userId: 'u1',
        attribute: 'attr:StudentInfo.Homeroom',
        mode: 'set',
        values: ['B12'],
        baselineValue: 'B11',
      },
      {
        userId: 'u2',
        attribute: 'attr:StudentInfo.Homeroom',
        mode: 'set',
        values: ['B12'],
        baselineValue: 'B11',
      },
    ]),
  );
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(answer.body.source, 'edit-list');
  assert.equal(answer.body.changes, null);
  assert.equal(answer.body.conflicts, 1);
  assert.deepEqual(checks, ['users:write']);
  assert.equal(stored[4], 'edit-list');
  assert.equal(stored[5], null);
  assert.equal(stored[6], '[]');
  const targets = JSON.parse(stored[8]);
  assert.deepEqual(
    targets.map((target) => [target.userId, target.disposition]),
    [
      ['u1', 'conflict'],
      ['u2', 'eligible'],
    ],
  );
  assert.deepEqual(JSON.parse(stored[9]), [
    { schemaName: 'StudentInfo', etag },
  ]);
  assert.equal(readCalls.length, 2);
  assert.equal(readCalls[0][0].customerId, customer);
  assert.equal(readCalls[0][1], 'u1');
  assert.deepEqual(readCalls[0][2], ['StudentInfo']);
  assert.ok(readCalls[0][3] instanceof AbortSignal);
  assert.equal(readCalls[1][1], 'u2');
});

test('a Google 400 invalid answers 503 user-read-failed and stores nothing', async () => {
  let creates = 0;
  const fallback = routeRespond;
  routeRespond = async (text, values) => {
    if (text.includes('cc.create_user_attribute_preview')) creates += 1;
    return fallback(text, values);
  };
  readUserValues = async () => {
    throw {
      response: {
        status: 400,
        data: { error: { errors: [{ reason: 'invalid' }] } },
      },
    };
  };
  const answer = await post('/api/users/attribute-previews', editBody());
  assert.equal(answer.status, 503, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, {
    reason: 'user-read-failed',
    failure: 'request-failed',
  });
  assert.equal(creates, 0);
});

test('an unknown edit user answers 422 user-not-found before any Google read', async () => {
  readCalls = [];
  const fallback = routeRespond;
  routeRespond = async (text, values) => {
    if (text.includes('FROM cc.users'))
      return {
        rows: [{ user_id: 'u1', primary_email: 'u1@example.org' }],
      };
    return fallback(text, values);
  };
  const answer = await post(
    '/api/users/attribute-previews',
    editBody([
      {
        userId: 'u1',
        attribute: 'attr:StudentInfo.Homeroom',
        mode: 'set',
        values: ['B12'],
        baselineValue: 'B11',
      },
      {
        userId: 'u9',
        attribute: 'attr:StudentInfo.Homeroom',
        mode: 'set',
        values: ['B12'],
        baselineValue: 'B11',
      },
    ]),
  );
  assert.equal(answer.status, 422, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'user-not-found', userIds: ['u9'] });
  assert.equal(readCalls.length, 0);
});

test('a Google 404 answers 422 user-not-found', async () => {
  readUserValues = async () => null;
  const answer = await post('/api/users/attribute-previews', editBody());
  assert.equal(answer.status, 422, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'user-not-found', userIds: ['u1'] });
});

test('the value refusals of B section 8 answer 422 before the store', async () => {
  let creates = 0;
  const fallback = routeRespond;
  routeRespond = async (text, values) => {
    if (text.includes('cc.create_user_attribute_preview')) creates += 1;
    return fallback(text, values);
  };
  const cases = [
    [
      [
        {
          schemaName: 'StudentInfo',
          fieldName: 'Nope',
          mode: 'set',
          values: ['B12'],
        },
      ],
      'unknown-attribute',
    ],
    [
      [
        {
          schemaName: 'StudentInfo',
          fieldName: 'Programs',
          mode: 'set',
          values: ['Band'],
        },
      ],
      'invalid-mode',
    ],
    [
      [
        {
          schemaName: 'StudentInfo',
          fieldName: 'Grade',
          mode: 'set',
          values: [13],
        },
      ],
      'invalid-value',
    ],
    [
      [
        {
          schemaName: 'StudentInfo',
          fieldName: 'Homeroom',
          mode: 'add',
          values: ['B12'],
        },
      ],
      'invalid-mode',
    ],
  ];
  for (const [changes, reason] of cases) {
    const answer = await post(
      '/api/users/attribute-previews',
      selectionBody(changes),
    );
    assert.equal(
      answer.status,
      422,
      `${reason}: ${JSON.stringify(answer.body)}`,
    );
    assert.equal(answer.body.reason, reason);
  }
  const ranged = await post(
    '/api/users/attribute-previews',
    selectionBody([
      {
        schemaName: 'StudentInfo',
        fieldName: 'Grade',
        mode: 'set',
        values: [13],
      },
    ]),
  );
  assert.deepEqual(ranged.body, {
    reason: 'invalid-value',
    message: 'Grade holds a value from 0 to 12.',
  });
  assert.equal(creates, 0);
});

test('the preview summary answers its creator and 404 or 410 otherwise', async () => {
  const answer = await get(`/api/users/attribute-previews/${previewId}`);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.previewId, previewId);
  assert.equal(answer.body.stale, false);
  const fallback = routeRespond;
  routeRespond = async (text, values) => {
    if (text.includes('cc.read_user_attribute_preview'))
      return { rows: [{ result: { outcome: 'not-found' } }] };
    return fallback(text, values);
  };
  const missing = await get(`/api/users/attribute-previews/${previewId}`);
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  assert.deepEqual(missing.body, { reason: 'preview-not-found' });
  routeRespond = async (text, values) => {
    if (text.includes('cc.read_user_attribute_preview'))
      return {
        rows: [
          {
            result: { outcome: 'preview-expired', expiresAt },
          },
        ],
      };
    return fallback(text, values);
  };
  const expired = await get(`/api/users/attribute-previews/${previewId}`);
  assert.equal(expired.status, 410, JSON.stringify(expired.body));
  assert.deepEqual(expired.body, {
    reason: 'preview-expired',
    expiresAt,
  });
});

test('the targets page answers wire rows, parses the cursor, and filters', async () => {
  let requested;
  const fallback = routeRespond;
  routeRespond = async (text, values) => {
    if (text.includes('cc.read_user_attribute_preview_targets')) {
      requested = values;
      return {
        rows: [
          {
            result: {
              outcome: 'page',
              customerId: customer,
              targets: [
                pageRow({}),
                pageRow({
                  ordinal: 0,
                  fieldName: 'Programs',
                  currentValue: [{ value: 'ELL' }, { value: 'Band' }],
                  newValue: [{ value: 'ELL' }],
                  disposition: 'unchanged',
                }),
              ],
              nextCursor: '1:StudentInfo.Homeroom',
            },
          },
        ],
      };
    }
    return fallback(text, values);
  };
  const answer = await get(
    `/api/users/attribute-previews/${previewId}/targets?limit=2&disposition=eligible`,
  );
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.nextCursor, '1:StudentInfo.Homeroom');
  assert.deepEqual(answer.body.targets, [
    {
      userId: 'u1',
      primaryEmail: 'u1@example.org',
      attribute: 'attr:StudentInfo.Homeroom',
      currentValue: 'B11',
      newValue: 'B12',
      disposition: 'eligible',
      observedAt: at,
    },
    {
      userId: 'u1',
      primaryEmail: 'u1@example.org',
      attribute: 'attr:StudentInfo.Programs',
      currentValue: ['ELL', 'Band'],
      newValue: ['ELL'],
      disposition: 'unchanged',
      observedAt: at,
    },
  ]);
  assert.equal(requested[2], previewId);
  assert.equal(requested[3], 'eligible');
  assert.equal(requested[4], null);
  assert.equal(requested[7], 2);
  const cursored = await get(
    `/api/users/attribute-previews/${previewId}/targets?cursor=4%3AStudentInfo.Homeroom`,
  );
  assert.equal(cursored.status, 200, JSON.stringify(cursored.body));
  assert.deepEqual(requested.slice(4, 7), [4, 'StudentInfo', 'Homeroom']);
});

test('the targets page refuses a bad cursor, a bad ID, and a bad limit', async () => {
  let reads = 0;
  const fallback = routeRespond;
  routeRespond = async (text) => {
    if (text.includes('cc.read_user_attribute_preview_targets')) reads += 1;
    return fallback(text);
  };
  const cursor = await get(
    `/api/users/attribute-previews/${previewId}/targets?cursor=nope`,
  );
  assert.equal(cursor.status, 422, JSON.stringify(cursor.body));
  assert.deepEqual(cursor.body, { reason: 'invalid-cursor' });
  const id = await get('/api/users/attribute-previews/abc/targets');
  assert.equal(id.status, 400, JSON.stringify(id.body));
  const limit = await get(
    `/api/users/attribute-previews/${previewId}/targets?limit=1001`,
  );
  assert.equal(limit.status, 400, JSON.stringify(limit.body));
  assert.equal(reads, 0);
});

test('a confirm answers the UAT receipt and a repeated confirm answers it again', async () => {
  let confirmations = 0;
  const fallback = routeRespond;
  routeRespond = async (text, values) => {
    if (text.includes('cc.confirm_user_attribute_preview')) {
      confirmations += 1;
      assert.equal(values[2], previewId);
      assert.equal(values[3], digest);
      assert.match(values[4], /^[0-9a-f-]{36}$/);
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
    return fallback(text, values);
  };
  const body = { manifestDigest: digest, acknowledged: true };
  const first = await post(
    `/api/users/attribute-previews/${previewId}/confirm`,
    body,
  );
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual(first.body, receipt);
  const again = await post(
    `/api/users/attribute-previews/${previewId}/confirm`,
    body,
  );
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body, receipt);
  assert.deepEqual(checks, [
    'users:write',
    'users:bulk-actions',
    'users:write',
    'users:bulk-actions',
  ]);
});

test('a confirm maps the frozen failures of B section 13', async () => {
  const fallback = routeRespond;
  const cases = [
    ['category-changed', 409, { reason: 'category-changed' }],
    ['preview-conflict', 409, { reason: 'preview-conflict' }],
    ['preview-changed', 409, { reason: 'preview-changed' }],
    ['connection-changed', 409, { reason: 'connection-changed' }],
    ['permission-changed', 409, { reason: 'permission-changed' }],
    ['nothing-to-update', 422, { reason: 'nothing-to-update' }],
    ['preview-expired', 410, { reason: 'preview-expired', expiresAt }],
  ];
  for (const [outcome, status, body] of cases) {
    routeRespond = async (text, values) => {
      if (text.includes('cc.confirm_user_attribute_preview'))
        return {
          rows: [
            {
              result:
                outcome === 'preview-expired'
                  ? { outcome, expiresAt }
                  : { outcome },
            },
          ],
        };
      return fallback(text, values);
    };
    const answer = await post(
      `/api/users/attribute-previews/${previewId}/confirm`,
      { manifestDigest: digest, acknowledged: true },
    );
    assert.equal(
      answer.status,
      status,
      `${outcome}: ${JSON.stringify(answer.body)}`,
    );
    assert.deepEqual(answer.body, body, outcome);
  }
});

test('a selection confirm without users:bulk-actions answers 403 and creates no job', async () => {
  allowed = new Set(['users:write']);
  let confirmations = 0;
  const fallback = routeRespond;
  routeRespond = async (text, values) => {
    if (text.includes('cc.confirm_user_attribute_preview')) confirmations += 1;
    return fallback(text, values);
  };
  const answer = await post(
    `/api/users/attribute-previews/${previewId}/confirm`,
    { manifestDigest: digest, acknowledged: true },
  );
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.deepEqual(checks, ['users:write', 'users:bulk-actions']);
  assert.equal(confirmations, 0);
});

test('an edit-list confirm needs users:write alone and answers its receipt', async () => {
  allowed = new Set(['users:write']);
  const fallback = routeRespond;
  routeRespond = async (text, values) => {
    if (text.includes('cc.read_user_attribute_preview'))
      return {
        rows: [
          {
            result: {
              outcome: 'preview',
              customerId: customer,
              preview: editPreview,
            },
          },
        ],
      };
    return fallback(text, values);
  };
  const answer = await post(
    `/api/users/attribute-previews/${previewId}/confirm`,
    { manifestDigest: digest, acknowledged: true },
  );
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, receipt);
  assert.deepEqual(checks, ['users:write']);
});

test('a confirm body outside the contract answers 400', async () => {
  const cases = [
    {},
    { manifestDigest: digest },
    { manifestDigest: digest, acknowledged: false },
    { manifestDigest: 'abc', acknowledged: true },
  ];
  for (const body of cases) {
    const answer = await post(
      `/api/users/attribute-previews/${previewId}/confirm`,
      body,
    );
    assert.equal(answer.status, 400, JSON.stringify(answer.body));
  }
});

test('a preview body outside the contract answers 400', async () => {
  const cases = [
    {},
    { gridId: 'users', tabId, changes: [] },
    { edits: [] },
    { edits: [{ userId: 'u1' }] },
    { ...selectionBody(), edits: editBody().edits },
    {
      edits: [
        {
          userId: 'u1',
          attribute: 'StudentInfo.Homeroom',
          mode: 'set',
          values: ['B12'],
          baselineValue: 'B11',
        },
      ],
    },
  ];
  for (const body of cases) {
    const answer = await post('/api/users/attribute-previews', body);
    assert.equal(answer.status, 400, JSON.stringify(answer.body));
  }
});
