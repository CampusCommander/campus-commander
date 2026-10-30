import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import esbuild from 'esbuild';

/**
 * The Drive settings of the Google connection page (design section 3, card DB7). `GET` reads the
 * saved settings or null. `POST` saves them, and each change writes one audit event inside the SQL
 * function. This suite boots the real controller, the real service, and the real permission
 * decision against a database double, so each answer is the production path.
 *
 * The database double raises the SQLSTATE that the SQL functions raise for a denied caller
 * (`42501`), so the refusal path is the store's own answer and not a fake row.
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
const { Module } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');

const ACTOR = '44444444-4444-4444-8444-444444444444';
const PERMISSION_VERSION = 7;
const CUSTOMER = 'C0123456';
/** A 39-character example key. It is not a real key and carries no secret. */
const KEY = `example-picker-key-a${'0'.repeat(19)}`;
const PROJECT = '123456789012';
const SETTINGS = { pickerApiKey: KEY, projectNumber: PROJECT };

const platform = (action) => ({ action, scope: { kind: 'platform' } });
const READER = [platform('connection:read')];
const MANAGER = [platform('connection:read'), platform('connection:manage')];
const DISTRICT_MANAGER = [
  platform('connection:read'),
  {
    action: 'connection:manage',
    scope: { kind: 'district', customerId: CUSTOMER },
  },
];

/**
 * A database whose answers match a needle of the statement text. Every call is recorded. The
 * bind-count check mirrors `jobs-cancel-route.test.mjs`: PostgreSQL refuses a statement whose
 * placeholders and values disagree.
 */
function database(routes) {
  const calls = [];
  return {
    calls,
    connection: {
      async query(text, values = []) {
        calls.push([text, values]);
        const used = new Set(
          [...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])),
        );
        const highest = used.size ? Math.max(...used) : 0;
        if (used.size !== highest || highest !== values.length)
          throw Object.assign(
            new Error(
              `bind message supplies ${values.length} parameters, but prepared statement requires ${highest}`,
            ),
            { code: '08P01' },
          );
        for (const [needle, answer] of routes) {
          if (text.includes(needle))
            return {
              rows:
                typeof answer === 'function' ? answer(values, text) : answer,
            };
        }
        throw new Error(`Unexpected statement: ${text}`);
      },
    },
  };
}

/** A refusal of a SQL function, as PostgreSQL raises it for a denied caller. */
const denied = () =>
  Object.assign(new Error('Current connection authority is required.'), {
    code: '42501',
  });

/**
 * The statements that the service always issues behind a route request. `onModuleInit` runs one
 * bounded expiry pass when the service starts.
 */
const housekeeping = ['cc.expire_google_candidates', [{ result: 0 }]];

/** The database of one read: the settings row, or a refusal. */
function readDatabase({ settings = null, error } = {}) {
  return database([
    housekeeping,
    [
      'cc.read_google_drive_settings',
      () => {
        if (error) throw error;
        return [{ result: settings }];
      },
    ],
  ]);
}

/** The database of one save: the saved row, or a refusal. */
function saveDatabase({ settings = SETTINGS, error } = {}) {
  return database([
    housekeeping,
    [
      'cc.save_google_drive_settings',
      () => {
        if (error) throw error;
        return [{ result: settings }];
      },
    ],
  ]);
}

/** The session of the next request. `grants` are the permission grants of the person. */
const session = (grants) => ({
  identity: {
    id: ACTOR,
    displayName: 'Grace Hopper',
    permissions: ['identity:read'],
    permissionVersion: PERMISSION_VERSION,
    grants,
    preferences: { theme: 'system', navigationCollapsed: false },
  },
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  csrfToken: 'a'.repeat(64),
});

let app;
let origin;
/** The signed-in caller of the next request. */
let currentSession;
/** The database behind the production GoogleConnectionService. */
let activeDb;
/** The audit rows that the production authorization wrote. */
let auditEvents;

before(async () => {
  const [
    controllerModule,
    securityModule,
    guardModule,
    connectionServiceModule,
    authModule,
    authzModule,
  ] = await Promise.all([
    import('./google-connection.controller.ts'),
    import('../security.ts'),
    import('./auth.guard.ts'),
    import('./google-connection.service.ts'),
    import('./auth.service.ts'),
    import('./authorize-action.ts'),
  ]);
  const { GoogleConnectionController } = controllerModule;
  const { ApplicationExceptionFilter, securityHeaders } = securityModule;
  const { AuthGuard } = guardModule;
  const { GoogleConnectionService } = connectionServiceModule;
  const { AuthService } = authModule;
  const { authorizeAction } = authzModule;

  // esbuild does not emit decorator metadata, so the harness names the constructor tokens.
  Reflect.defineMetadata(
    'design:paramtypes',
    [GoogleConnectionService, AuthService],
    GoogleConnectionController,
  );

  auditEvents = [];
  const connection = new GoogleConnectionService(
    { deployment: { phase: 3 } },
    {
      // The production service decides; each test names the rows that PostgreSQL answers.
      connection: {
        query: (text, values) => activeDb.connection.query(text, values),
      },
    },
  );

  class DriveSettingsModule {}
  Module({
    controllers: [GoogleConnectionController],
    providers: [
      { provide: GoogleConnectionService, useValue: connection },
      {
        // The session is a test double. The permission decision, `authorizeAction`, is real.
        provide: AuthService,
        useValue: {
          authorize: (value, action, resource, correlationId) =>
            authorizeAction(
              {
                phase: 3,
                audit: async (...entry) => auditEvents.push(entry),
              },
              value,
              action,
              resource,
              correlationId,
            ),
        },
      },
    ],
  })(DriveSettingsModule);

  const moduleRef = await Test.createTestingModule({
    imports: [DriveSettingsModule],
  })
    .overrideGuard(AuthGuard)
    .useValue({
      canActivate: (context) => {
        context.switchToHttp().getRequest().session = currentSession;
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

/** Name one test's caller and rows. */
function arrange(db, grants) {
  activeDb = db;
  currentSession = session(grants);
  auditEvents = [];
}

const statements = (db, needle) =>
  db.calls.filter(([text]) => text.includes(needle));

/** One settings read through the real route. */
async function read() {
  const response = await fetch(`${origin}/api/google-connection/drive`);
  return {
    status: response.status,
    body: await response.json(),
    correlationId: response.headers.get('x-correlation-id'),
  };
}

/** One settings save through the real route. */
async function save(body) {
  const response = await fetch(`${origin}/api/google-connection/drive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
    correlationId: response.headers.get('x-correlation-id'),
  };
}

test('the settings read answers null before the first save', async () => {
  const db = readDatabase();
  arrange(db, READER);

  const answer = await read();

  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { drive: null });
  const reads = statements(db, 'cc.read_google_drive_settings');
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0][1], [ACTOR, PERMISSION_VERSION]);
  assert.equal(statements(db, 'cc.save_google_drive_settings').length, 0);
  assert.deepEqual(auditEvents, []);
});

test('the settings read answers the saved settings', async () => {
  const db = readDatabase({ settings: SETTINGS });
  arrange(db, READER);

  const answer = await read();

  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { drive: SETTINGS });
  assert.deepEqual(auditEvents, []);
});

test('a person without connection:read receives 403 and reads no settings', async () => {
  const db = readDatabase({ error: denied() });
  arrange(db, [platform('devices:read')]);

  const answer = await read();

  assert.equal(answer.status, 403);
  assert.deepEqual(answer.body, { reason: 'forbidden' });
  assert.equal(statements(db, 'cc.read_google_drive_settings').length, 1);
  assert.equal(statements(db, 'cc.save_google_drive_settings').length, 0);
});

test('the save answers the saved settings and passes the actor, values, and correlation', async () => {
  const db = saveDatabase();
  arrange(db, MANAGER);

  const answer = await save(SETTINGS);

  // The sibling settings save, `POST /api/customer/settings`, answers 201 as a POST does.
  assert.equal(answer.status, 201);
  assert.deepEqual(answer.body, { drive: SETTINGS });
  const saves = statements(db, 'cc.save_google_drive_settings');
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0][1], [
    ACTOR,
    PERMISSION_VERSION,
    KEY,
    PROJECT,
    answer.correlationId,
  ]);
  assert.equal(statements(db, 'cc.read_google_drive_settings').length, 0);
  assert.deepEqual(auditEvents, []);
});

test('a person without connection:manage receives 403 and the table stays unchanged', async () => {
  const db = saveDatabase();
  arrange(db, READER);

  const answer = await save(SETTINGS);

  assert.equal(answer.status, 403);
  assert.equal(statements(db, 'cc.save_google_drive_settings').length, 0);
  assert.deepEqual(auditEvents, [
    ['access-denied', answer.correlationId, ACTOR, 'connection:manage'],
  ]);
});

test('a district connection:manage grant receives 403, because the save needs platform scope', async () => {
  const db = saveDatabase();
  arrange(db, DISTRICT_MANAGER);

  const answer = await save(SETTINGS);

  assert.equal(answer.status, 403);
  assert.equal(statements(db, 'cc.save_google_drive_settings').length, 0);
  assert.deepEqual(auditEvents, [
    ['access-denied', answer.correlationId, ACTOR, 'connection:manage'],
  ]);
});

test('a save the store refuses receives 403 and answers no settings', async () => {
  const db = saveDatabase({ error: denied() });
  arrange(db, MANAGER);

  const answer = await save(SETTINGS);

  assert.equal(answer.status, 403);
  assert.deepEqual(answer.body, { reason: 'forbidden' });
  assert.equal(statements(db, 'cc.save_google_drive_settings').length, 1);
});

test('each field refusal answers 422 with the field and saves nothing', async () => {
  const cases = [
    [`${'k'.repeat(38)}`, '123456789012', 'pickerApiKey'],
    [`${'k'.repeat(40)}`, '123456789012', 'pickerApiKey'],
    [`${'k'.repeat(38)}.`, '123456789012', 'pickerApiKey'],
    [KEY, '0123456', 'projectNumber'],
    [KEY, '0', 'projectNumber'],
    [KEY, '1'.repeat(21), 'projectNumber'],
    [KEY, '12345x', 'projectNumber'],
    [KEY, '', 'projectNumber'],
    [`${'k'.repeat(38)}`, '0123456', 'pickerApiKey'],
  ];
  for (const [pickerApiKey, projectNumber, field] of cases) {
    const db = saveDatabase();
    arrange(db, MANAGER);

    const answer = await save({ pickerApiKey, projectNumber });

    const label = JSON.stringify({ pickerApiKey, projectNumber });
    assert.equal(answer.status, 422, label);
    assert.deepEqual(
      answer.body,
      { reason: 'invalid-drive-settings', field },
      label,
    );
    assert.equal(
      statements(db, 'cc.save_google_drive_settings').length,
      0,
      label,
    );
    assert.deepEqual(auditEvents, [], label);
  }
});

test('a body with an unknown field answers 400 and saves nothing', async () => {
  const db = saveDatabase();
  arrange(db, MANAGER);

  const answer = await save({ ...SETTINGS, savedBy: ACTOR });

  assert.equal(answer.status, 400);
  assert.deepEqual(answer.body, { reason: 'invalid-drive-settings' });
  assert.equal(statements(db, 'cc.save_google_drive_settings').length, 0);
});
