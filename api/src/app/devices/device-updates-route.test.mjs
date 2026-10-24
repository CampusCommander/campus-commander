import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import esbuild from 'esbuild';

/**
 * Node's type stripping does not transform the Nest decorators of the API sources. Compile the
 * `api/src` TypeScript for this test only, as `deployment/postgres/api-types.mjs` does, so the
 * real controller and the real exception filter answer these requests.
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

const selection = {
  gridId: 'devices',
  tabId: '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
};
const body = (field, mode, value) => ({
  ...selection,
  changes: [{ field, mode, value }],
});
const session = {
  identity: {
    id: '11111111-1111-4111-8111-111111111111',
    displayName: 'Test person',
    permissions: [],
    permissionVersion: 1,
    grants: [],
    preferences: {},
  },
  expiresAt: '2026-10-19T12:00:00.000Z',
  csrfToken: 'a'.repeat(64),
};
const connected = { customerId: 'C0123456', generation: 1 };

let app;
let origin;
/** The preview inputs that reached the service double. A refusal must leave this empty. */
let previews;
/** The edit previews that reached the service double. A refused read must leave this empty. */
let editPreviews;
/** The read that the route asks for before it builds an edit preview. */
let freshRead;
/** The answers of the fresh-read double, in call order. */
let reads;

before(async () => {
  const [
    controllerModule,
    securityModule,
    guardModule,
    devicesModule,
    updatesModule,
    authModule,
    accessModule,
    jobsModule,
    freshReadModule,
  ] = await Promise.all([
    import('./device-updates.controller.ts'),
    import('../security.ts'),
    import('../auth/auth.guard.ts'),
    import('./devices.service.ts'),
    import('./device-updates.service.ts'),
    import('../auth/auth.service.ts'),
    import('./device-write-access.service.ts'),
    import('../jobs/job-service.ts'),
    import('./device-fresh-read.service.ts'),
  ]);
  const { DeviceUpdatesController } = controllerModule;
  const { ApplicationExceptionFilter, securityHeaders } = securityModule;
  const { AuthGuard } = guardModule;
  const { DevicesService } = devicesModule;
  const { DeviceUpdatesService } = updatesModule;
  const { AuthService } = authModule;
  const { DeviceWriteAccessService } = accessModule;
  const { JobService } = jobsModule;
  const { DeviceFreshReadService } = freshReadModule;

  // esbuild does not emit decorator metadata, so the harness names the constructor tokens.
  Reflect.defineMetadata(
    'design:paramtypes',
    [
      DevicesService,
      DeviceUpdatesService,
      AuthService,
      DeviceWriteAccessService,
      JobService,
      DeviceFreshReadService,
    ],
    DeviceUpdatesController,
  );

  previews = [];
  editPreviews = [];
  freshRead = [];
  reads = [];
  class PreviewRouteModule {}
  Module({
    controllers: [DeviceUpdatesController],
    providers: [
      { provide: DevicesService, useValue: { sync: async () => connected } },
      {
        provide: DeviceUpdatesService,
        useValue: {
          preview: async (_session, _connected, input) => {
            previews.push(input);
            return { changes: input.changes };
          },
          editPreview: async (_session, _connected, input, rows) => {
            editPreviews.push({ input, rows });
            return {
              previewId: '11111111-1111-4111-8111-111111111111',
              changes: null,
              rows: rows.length,
            };
          },
        },
      },
      { provide: AuthService, useValue: { authorize: async () => undefined } },
      { provide: DeviceWriteAccessService, useValue: {} },
      { provide: JobService, useValue: {} },
      {
        provide: DeviceFreshReadService,
        useValue: {
          read: async (_session, _connected, ids) => {
            freshRead.push(ids);
            const next = reads.shift();
            if (next?.failure) throw next.failure;
            return {
              rows: next?.rows ?? [],
              syncedAt: '2026-10-23T12:00:01.000Z',
            };
          },
        },
      },
    ],
  })(PreviewRouteModule);

  const moduleRef = await Test.createTestingModule({
    imports: [PreviewRouteModule],
  })
    // The signed-in session and the person checks are named test doubles; the route is real.
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

async function preview(payload) {
  const response = await fetch(`${origin}/api/devices/updates/previews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

test('the preview route refuses each 65,537-unit value with its field label and limit', async (t) => {
  const huge = 'x'.repeat(65_537);
  const cases = [
    [
      'annotatedLocation',
      'replace',
      huge,
      'Annotated location holds 1 to 200 characters.',
    ],
    [
      'annotatedUser',
      'replace',
      huge,
      'Annotated user holds 1 to 100 characters.',
    ],
    ['notes', 'replace', huge, 'Notes holds 1 to 500 characters.'],
    [
      'orgUnitPath',
      'move',
      `/${'a'.repeat(65_536)}`,
      'Organization unit needs a path that starts with / and holds at most 4096 characters.',
    ],
  ];
  for (const [field, mode, value, message] of cases) {
    await t.test(field, async () => {
      const before = previews.length;
      const answer = await preview(body(field, mode, value));
      // The wire body names the field and its limit; the generic filter body names neither.
      assert.deepEqual(answer, {
        status: 400,
        body: { reason: 'invalid-change', message },
      });
      assert.equal(
        previews.length,
        before,
        'A refused change reaches no preview.',
      );
    });
  }
});

test('the preview route refuses an Asset tag change in the bulk selection', async () => {
  const before = previews.length;
  const answer = await preview(body('annotatedAssetId', 'replace', 'AT-42'));
  assert.equal(answer.status, 400);
  assert.equal(answer.body.reason, 'invalid-change');
  assert.match(answer.body.message, /annotatedLocation/);
  assert.equal(
    previews.length,
    before,
    'A refused selection change reaches no preview.',
  );
});

test('the preview route refuses each ordinary over-limit value with its field label', async (t) => {
  const cases = [
    [
      'annotatedLocation',
      'replace',
      'x'.repeat(201),
      'Annotated location holds 1 to 200 characters.',
    ],
    [
      'annotatedUser',
      'replace',
      'x'.repeat(101),
      'Annotated user holds 1 to 100 characters.',
    ],
    ['notes', 'replace', 'x'.repeat(501), 'Notes holds 1 to 500 characters.'],
    [
      'orgUnitPath',
      'move',
      `/${'a'.repeat(4096)}`,
      'Organization unit needs a path that starts with / and holds at most 4096 characters.',
    ],
  ];
  for (const [field, mode, value, message] of cases) {
    await t.test(field, async () => {
      const before = previews.length;
      const answer = await preview(body(field, mode, value));
      assert.deepEqual(answer, {
        status: 400,
        body: { reason: 'invalid-change', message },
      });
      assert.equal(
        previews.length,
        before,
        'A refused change reaches no preview.',
      );
    });
  }
});

test('the preview route counts supplementary characters as code points', async () => {
  const accepted = '\u{1D306}'.repeat(100);
  const before = previews.length;
  const previewed = await preview(body('annotatedUser', 'replace', accepted));
  assert.equal(previewed.status, 201);
  assert.deepEqual(previewed.body.changes, [
    { field: 'annotatedUser', mode: 'replace', value: accepted },
  ]);
  assert.deepEqual(
    previews.at(-1)?.changes,
    [{ field: 'annotatedUser', mode: 'replace', value: accepted }],
    'The route passes the 100-character value to the service unchanged.',
  );
  assert.equal(previews.length, before + 1);

  const refused = await preview(
    body('annotatedUser', 'replace', '\u{1D306}'.repeat(101)),
  );
  assert.deepEqual(refused, {
    status: 400,
    body: {
      reason: 'invalid-change',
      message: 'Annotated user holds 1 to 100 characters.',
    },
  });
  assert.equal(
    previews.length,
    before + 1,
    'The 101-character value reaches no preview.',
  );
});

/** One edit of the wire body: a device, a field change, and the baseline that the person saw. */
const editBody = (edits) => ({ edits });

async function editPreview(payload) {
  const response = await fetch(`${origin}/api/devices/updates/edit-previews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

test('the edit route reads every edited device and builds the preview from the rows', async () => {
  reads.push({
    rows: [
      {
        device_id: 'd1',
        serial_number: 'SN-d1',
        org_unit_path: '/School A',
        notes: 'Old',
        removed_at: null,
        last_entity_sync: '2026-10-23T12:00:01.000Z',
      },
    ],
  });
  const before = editPreviews.length;
  const answer = await editPreview(
    editBody([
      {
        deviceId: 'd1',
        field: 'notes',
        mode: 'replace',
        value: 'New',
        baselineValue: 'Old',
      },
    ]),
  );
  assert.equal(answer.status, 201);
  assert.equal(answer.body.changes, null);
  assert.deepEqual(
    freshRead.at(-1),
    ['d1'],
    'The route reads the edited device.',
  );
  assert.equal(editPreviews.length, before + 1);
  assert.deepEqual(
    editPreviews.at(-1).rows.map((row) => row.device_id),
    ['d1'],
  );
});

test('an unknown device answers 422 unknown-device and creates no preview', async () => {
  const { UnprocessableEntityException } = await import('@nestjs/common');
  reads.push({
    failure: new UnprocessableEntityException({
      reason: 'unknown-device',
      deviceIds: ['d9'],
    }),
  });
  const before = editPreviews.length;
  const answer = await editPreview(
    editBody([
      {
        deviceId: 'd9',
        field: 'notes',
        mode: 'replace',
        value: 'New',
        baselineValue: 'Old',
      },
    ]),
  );
  assert.deepEqual(answer, {
    status: 422,
    body: { reason: 'unknown-device', deviceIds: ['d9'] },
  });
  assert.equal(
    editPreviews.length,
    before,
    'An unknown device creates no preview.',
  );
});

test('a failed read answers 503 device-read-failed and creates no preview', async () => {
  const { ServiceUnavailableException } = await import('@nestjs/common');
  reads.push({
    failure: new ServiceUnavailableException({
      reason: 'device-read-failed',
      failure: 'quota',
    }),
  });
  const before = editPreviews.length;
  const answer = await editPreview(
    editBody([
      {
        deviceId: 'd1',
        field: 'annotatedAssetId',
        mode: 'replace',
        value: 'AT-9',
        baselineValue: null,
      },
    ]),
  );
  assert.deepEqual(answer, {
    status: 503,
    body: { reason: 'device-read-failed', failure: 'quota' },
  });
  assert.equal(editPreviews.length, before, 'A failed read keeps the draft.');
});

test('the edit route refuses a body outside the edit list contract', async () => {
  const before = editPreviews.length;
  const readsBefore = freshRead.length;
  const answer = await editPreview({
    edits: [
      {
        deviceId: 'd1',
        field: 'annotatedAssetId',
        mode: 'clear',
        baselineValue: 'AT-1',
      },
    ],
  });
  assert.deepEqual(answer, {
    status: 400,
    body: {
      reason: 'invalid-change',
      message: 'Asset tag offers Replace only.',
    },
  });
  assert.equal(editPreviews.length, before);
  assert.equal(
    freshRead.length,
    readsBefore,
    'A refused body reads no device.',
  );
});
