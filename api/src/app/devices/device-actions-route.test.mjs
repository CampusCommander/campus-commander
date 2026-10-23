import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import esbuild from 'esbuild';

/**
 * Node's type stripping does not transform the Nest decorators of the API sources. Compile the
 * `api/src` TypeScript for this test only, as `device-updates-route.test.mjs` does, so the real
 * controllers, the real device action service, and the real exception filter answer the requests.
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

const selection = {
  gridId: 'devices',
  tabId: '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
};
const actor = '11111111-1111-4111-8111-111111111111';
const session = {
  identity: {
    id: actor,
    displayName: 'Test person',
    permissions: [],
    permissionVersion: 1,
    grants: [],
    preferences: {},
  },
  expiresAt: '2026-10-23T12:00:00.000Z',
  csrfToken: 'a'.repeat(64),
};
const connected = { customerId: 'C0123456', generation: 1 };
const previewId = '33333333-3333-4333-8333-333333333333';
const digest = 'a'.repeat(64);
const RETIRING = 'DEPROVISION_REASON_RETIRING_DEVICE';

const previewRow = (extra = {}) => ({
  preview_id: previewId,
  display_id: 'PV-001',
  customer_id: connected.customerId,
  created_by: actor,
  permission_version: 1,
  generation: 1,
  action: 'reboot',
  field: null,
  mode: null,
  value: null,
  deprovision_reason: null,
  selected: 1,
  eligible: 1,
  unchanged: 0,
  excluded: 0,
  oldest_observed_at: null,
  manifest_digest: digest,
  prepared_at: new Date(),
  expires_at: new Date(Date.now() + 600_000),
  job_id: null,
  ...extra,
});

let app;
let origin;
/** The person checks that the route ran, in order. */
let checks;
/** The actions that the signed-in person holds in the current test. */
let allowed;
/** The database answers of the current test. */
let respond;
let storeJsonCalls;

before(async () => {
  const [
    controllerModule,
    securityModule,
    guardModule,
    devicesModule,
    actionsModule,
    serviceModule,
    authModule,
    jobsModule,
  ] = await Promise.all([
    import('./device-actions.controller.ts'),
    import('../security.ts'),
    import('../auth/auth.guard.ts'),
    import('./devices.service.ts'),
    import('./device-actions.ts'),
    import('./device-actions.service.ts'),
    import('../auth/auth.service.ts'),
    import('../jobs/job-service.ts'),
  ]);
  const { DeviceCommandsController, DeviceStatusChangesController } =
    controllerModule;
  const { ApplicationExceptionFilter, securityHeaders } = securityModule;
  const { AuthGuard } = guardModule;
  const { DevicesService } = devicesModule;
  const { DeviceActions } = actionsModule;
  const { DeviceActionsService } = serviceModule;
  const { AuthService } = authModule;
  const { JobService } = jobsModule;

  checks = [];
  allowed = new Set();
  storeJsonCalls = 0;
  respond = async () => ({ rows: [] });
  const database = {
    connection: { query: (text, values) => respond(text, values) },
    transaction: async (run) => run({ query: async () => ({ rows: [] }) }),
  };
  const actions = new DeviceActions(
    database,
    {
      get: async () =>
        JSON.stringify({
          terms: [],
          groups: [],
          additions: ['d1'],
          exceptions: [],
          changedAt: new Date().toISOString(),
        }),
    },
    {
      storeJson: async () => {
        storeJsonCalls += 1;
        return 'artifact';
      },
    },
  );
  const auth = {
    authorize: async (_session, action) => {
      checks.push(action);
      if (!allowed.has(action))
        throw new ForbiddenException(
          'This action requires additional permission.',
        );
    },
  };

  // esbuild does not emit decorator metadata, so the harness names the constructor tokens.
  for (const controller of [
    DeviceCommandsController,
    DeviceStatusChangesController,
  ])
    Reflect.defineMetadata(
      'design:paramtypes',
      [DevicesService, DeviceActionsService, AuthService, JobService],
      controller,
    );

  class ActionRoutesModule {}
  Module({
    controllers: [DeviceCommandsController, DeviceStatusChangesController],
    providers: [
      { provide: DevicesService, useValue: { sync: async () => connected } },
      { provide: DeviceActionsService, useValue: actions },
      { provide: AuthService, useValue: auth },
      { provide: JobService, useValue: { admit: async () => undefined } },
    ],
  })(ActionRoutesModule);

  const moduleRef = await Test.createTestingModule({
    imports: [ActionRoutesModule],
  })
    .overrideGuard(AuthGuard)
    .useValue({
      canActivate: (context) => {
        context.switchToHttp().getRequest().session = session;
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

test('a person with only devices:commands previews Reboot and receives 403 for Powerwash', async () => {
  checks = [];
  allowed = new Set([
    'devices:read',
    'devices:bulk-actions',
    'devices:commands',
  ]);
  respond = async (text) => {
    if (text.includes('FROM cc.device_sync_state'))
      return {
        rows: [
          {
            device_id: 'd1',
            serial_number: 'SN-d1',
            org_unit_path: '/School A',
            status: 'ACTIVE',
            status_observed_at: new Date(),
            removed_at: null,
          },
        ],
      };
    if (text.includes('cc.create_device_update_preview'))
      return {
        rows: [{ result: { outcome: 'created', preview: previewRow() } }],
      };
    return { rows: [] };
  };
  const reboot = await post('/api/devices/commands/previews', {
    ...selection,
    commandType: 'REBOOT',
  });
  assert.equal(reboot.status, 201, JSON.stringify(reboot.body));
  assert.equal(reboot.body.action, 'reboot');
  assert.equal(reboot.body.commandType, 'REBOOT');
  assert.equal(reboot.body.deprovisionReason, null);
  assert.deepEqual(checks, [
    'devices:read',
    'devices:bulk-actions',
    'devices:commands',
  ]);

  checks = [];
  const powerwash = await post('/api/devices/commands/previews', {
    ...selection,
    commandType: 'REMOTE_POWERWASH',
  });
  assert.equal(powerwash.status, 403, JSON.stringify(powerwash.body));
  assert.deepEqual(checks, [
    'devices:read',
    'devices:bulk-actions',
    'devices:wipe',
  ]);
});

test('a person with only devices:status receives 403 for a Deprovision preview', async () => {
  checks = [];
  allowed = new Set(['devices:read', 'devices:bulk-actions', 'devices:status']);
  respond = async (text) => {
    if (text.includes('FROM cc.device_sync_state'))
      return {
        rows: [
          {
            device_id: 'd1',
            serial_number: 'SN-d1',
            org_unit_path: '/School A',
            status: 'ACTIVE',
            status_observed_at: new Date(),
            removed_at: null,
          },
        ],
      };
    return { rows: [] };
  };
  const answer = await post('/api/devices/status-changes/previews', {
    ...selection,
    statusAction: 'deprovision',
    deprovisionReason: RETIRING,
  });
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.deepEqual(checks, [
    'devices:read',
    'devices:bulk-actions',
    'devices:deprovision',
  ]);
});

test('a Deprovision preview without a reason answers 400 before the family guard', async () => {
  checks = [];
  allowed = new Set([
    'devices:read',
    'devices:bulk-actions',
    'devices:deprovision',
  ]);
  const answer = await post('/api/devices/status-changes/previews', {
    ...selection,
    statusAction: 'deprovision',
  });
  assert.equal(answer.status, 400, JSON.stringify(answer.body));
  assert.equal(answer.body.code, 'invalid-request');
  assert.equal(
    answer.body.message,
    'The request is invalid. Check the values and retry.',
  );
  assert.deepEqual(checks, [], 'A bad body reaches no person check.');
});

test("another person's preview answers 404 before the action check", async () => {
  checks = [];
  allowed = new Set([
    'devices:read',
    'devices:bulk-actions',
    'devices:deprovision',
  ]);
  respond = async (text) =>
    text.includes('FROM cc.device_update_previews')
      ? {
          rows: [
            previewRow({
              action: 'deprovision',
              deprovision_reason: RETIRING,
              created_by: 'other-person',
            }),
          ],
        }
      : { rows: [] };
  const answer = await get(
    `/api/devices/status-changes/previews/00000000-0000-4000-8000-000000000000`,
  );
  assert.equal(answer.status, 404, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'preview-not-found' });
  assert.deepEqual(
    checks,
    ['devices:read', 'devices:bulk-actions'],
    'The refused lookup checks no action.',
  );
});

test('a preview whose action the person lacks answers 403 after the family guard', async () => {
  checks = [];
  allowed = new Set(['devices:read', 'devices:bulk-actions']);
  respond = async (text) =>
    text.includes('FROM cc.device_update_previews')
      ? {
          rows: [
            previewRow({
              action: 'deprovision',
              deprovision_reason: RETIRING,
            }),
          ],
        }
      : { rows: [] };
  const answer = await get(`/api/devices/status-changes/previews/${previewId}`);
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.deepEqual(checks, [
    'devices:read',
    'devices:bulk-actions',
    'devices:deprovision',
  ]);
});

test('WIPE on a Powerwash preview answers 422 and stores no manifest', async () => {
  checks = [];
  allowed = new Set(['devices:read', 'devices:bulk-actions', 'devices:wipe']);
  storeJsonCalls = 0;
  respond = async (text) => {
    if (text.includes('FROM cc.device_update_previews'))
      return { rows: [previewRow({ action: 'powerwash' })] };
    if (text.includes('cc.read_device_update_preview_manifest'))
      return {
        rows: [
          {
            result: {
              outcome: 'manifest',
              manifest: {
                preview: {
                  previewId,
                  action: 'powerwash',
                  manifestDigest: digest,
                },
                targets: [],
              },
            },
          },
        ],
      };
    return { rows: [] };
  };
  const answer = await post(
    `/api/devices/commands/previews/${previewId}/confirm`,
    { manifestDigest: digest, acknowledged: true, typedPhrase: 'WIPE' },
  );
  assert.equal(answer.status, 422, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'phrase-mismatch' });
  assert.equal(storeJsonCalls, 0, 'A mismatch stores no manifest.');
  assert.deepEqual(checks, [
    'devices:read',
    'devices:bulk-actions',
    'devices:wipe',
  ]);
});

test('a trimmed DEPROVISION phrase creates a status job', async () => {
  checks = [];
  allowed = new Set([
    'devices:read',
    'devices:bulk-actions',
    'devices:deprovision',
  ]);
  storeJsonCalls = 0;
  let confirmValues;
  respond = async (text, values) => {
    if (text.includes('FROM cc.device_update_previews'))
      return {
        rows: [
          previewRow({ action: 'deprovision', deprovision_reason: RETIRING }),
        ],
      };
    if (text.includes('cc.read_device_update_preview_manifest'))
      return {
        rows: [
          {
            result: {
              outcome: 'manifest',
              manifest: {
                preview: {
                  previewId,
                  action: 'deprovision',
                  deprovisionReason: RETIRING,
                  manifestDigest: digest,
                },
                targets: [],
              },
            },
          },
        ],
      };
    if (text.includes('cc.confirm_device_update_preview')) {
      confirmValues = values;
      return {
        rows: [
          {
            result: {
              outcome: 'created',
              receipt: {
                jobId: '44444444-4444-4444-8444-444444444444',
                displayId: 'STS-001',
                status: 'accepted',
                deviceCount: 1,
                updateCount: 1,
              },
            },
          },
        ],
      };
    }
    return { rows: [] };
  };
  const answer = await post(
    `/api/devices/status-changes/previews/${previewId}/confirm`,
    {
      manifestDigest: digest,
      acknowledged: true,
      typedPhrase: ' DEPROVISION ',
    },
  );
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(answer.body.displayId, 'STS-001');
  assert.equal(answer.body.status, 'accepted');
  assert.equal(confirmValues[7], 'DEPROVISION', 'The route trims the phrase.');
  assert.equal(storeJsonCalls, 1, 'The matching phrase stores the manifest.');
});

test('a Reboot confirm refuses a typed phrase', async () => {
  checks = [];
  allowed = new Set([
    'devices:read',
    'devices:bulk-actions',
    'devices:commands',
  ]);
  storeJsonCalls = 0;
  respond = async (text) => {
    if (text.includes('FROM cc.device_update_previews'))
      return { rows: [previewRow()] };
    if (text.includes('cc.read_device_update_preview_manifest'))
      return {
        rows: [
          {
            result: {
              outcome: 'manifest',
              manifest: {
                preview: {
                  previewId,
                  action: 'reboot',
                  deprovisionReason: null,
                  manifestDigest: digest,
                },
                targets: [],
              },
            },
          },
        ],
      };
    return { rows: [] };
  };
  const answer = await post(
    `/api/devices/commands/previews/${previewId}/confirm`,
    { manifestDigest: digest, acknowledged: true, typedPhrase: 'REBOOT' },
  );
  assert.equal(answer.status, 422, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'phrase-mismatch' });
  assert.equal(
    storeJsonCalls,
    0,
    'An action without a phrase stores no manifest.',
  );
  assert.deepEqual(checks, [
    'devices:read',
    'devices:bulk-actions',
    'devices:commands',
  ]);
});
