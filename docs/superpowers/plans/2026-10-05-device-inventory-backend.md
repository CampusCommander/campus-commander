# Device Inventory Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync ChromeOS devices and battery telemetry from Google into PostgreSQL through Kestra and the worker, and serve filtered device pages and device details from the API.

**Architecture:** The API records a sync lease and starts the `device_sync` Kestra flow. Kestra dispatches the worker. The worker pages through the Directory API and the Chrome Management telemetry API with exact-scope tokens, stages rows under the sync ID, and publishes by switching the current sync ID in one short transaction. The API answers grid queries with parameterized SQL over the published sync after a lock-free authority check.

**Tech Stack:** NestJS, PostgreSQL PL/pgSQL `SECURITY DEFINER` functions, Kestra 1.3 HTTP Request task, Node 24 worker, zod 4.4, google-auth-library, `node:test` with Node type stripping.

**Spec:** [docs/workflows/device-browsing.md](../../workflows/device-browsing.md). This plan covers the data path. A second plan covers the Devices UI after this API exists.

## Global Constraints

- Read Google data only. Use exactly `https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly` and `https://www.googleapis.com/auth/chrome.management.telemetry.readonly`.
- Battery class comes only from Google's `batteryHealth`: `BATTERY_HEALTH_NORMAL`, `BATTERY_REPLACE_SOON`, `BATTERY_REPLACE_NOW`. No district thresholds.
- No School column and no school entity.
- Run synchronization through Kestra and the worker. Do not run it in the API process. Do not add another job engine.
- Greenfield: no data migration, no backfill grants, no legacy compatibility. Development databases are disposable.
- Keep credential envelopes, private keys, and access tokens out of API responses and logs.
- Repository prose follows the writing rules in `AGENTS.md`: active voice, no hedging, no semicolons or contractions, 20 words maximum per instruction sentence.
- Run tasks through Nx: `npm exec nx run <project>:<target>`.

## Review Focus

1. **Duplicate Kestra dispatch for one sync ID.** The second worker attempt fails with `device-sync-claimed`. The first attempt publishes once. Tests: Task 3 integration, Task 4 unit.
2. **Google fails on a later device page.** The previous inventory stays published. State shows `failed` and `stale`. Tests: Task 3 integration, Task 4 unit, Task 6 end-to-end.
3. **Telemetry scope missing.** Devices still publish. Every battery shows `unavailable`, and the sync records `telemetryFailure`. Tests: Task 4 unit, Task 6 end-to-end.
4. **Filter text containing `%`, `_`, or `\`.** Matching treats them as literal characters. Test: Task 5 unit.
5. **Worker stops and its lease expires.** State shows `failed` with `interrupted`. A new sync starts. The late worker cannot publish. Test: Task 3 integration.

---

### Task 1: Device contracts and the `devices:read` action

**Files:**
- Create: `libs/application-contracts/src/lib/devices.ts`
- Create: `libs/application-contracts/src/lib/devices.test.mjs`
- Modify: `libs/application-contracts/src/index.ts`
- Modify: `libs/application-contracts/src/lib/authorization.ts:3-42`
- Modify: `frontend/src/app/action-labels.ts`
- Modify: `docs/workflows/device-browsing.md` (battery reason text)

**Interfaces:**
- Produces: `deviceObservationSchema`, `batteryObservationSchema`, `deviceRowSchema`, `deviceDetailSchema`, `devicePredicateSchema`, `deviceQuerySchema`, `devicePageSchema`, `deviceSyncStateSchema`, `deviceSyncFailureSchema`, `batteryHealthSchema`, and their inferred types `DeviceObservation`, `BatteryObservation`, `DeviceRow`, `DeviceDetail`, `DevicePredicate`, `DeviceQuery`, `DevicePage`, `DeviceSyncState`, `BatteryHealth`. Adds action `'devices:read'`.

Telemetry cannot distinguish a device without a battery from a device without the `ReportDevicePowerStatus` policy. Google withholds `batteryInfo` in both cases. The battery states are therefore `reported`, `no-report`, and `unavailable`.

- [ ] **Step 1: Write the failing test**

Create `libs/application-contracts/src/lib/devices.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  devicePredicateSchema,
  deviceQuerySchema,
  deviceRowSchema,
  deviceSyncStateSchema,
} from './devices.ts';
import {
  actionSchema,
  actionScopeKinds,
  isAuthorized,
} from './authorization.ts';

const row = {
  deviceId: 'd1',
  serialNumber: 'C0A1-7F2D',
  model: null,
  assetTag: null,
  orgUnitPath: '/',
  lastContact: null,
  annotatedLocation: null,
  notes: null,
};

test('device queries default to the first serial page', () => {
  assert.deepEqual(deviceQuerySchema.parse({}), {
    predicates: [],
    sort: { field: 'serialNumber', direction: 'asc' },
    offset: 0,
    limit: 100,
  });
});

test('predicates accept only the operators of their field type', () => {
  const ok = (value) => devicePredicateSchema.safeParse(value).success;
  assert.equal(ok({ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }), true);
  assert.equal(ok({ field: 'assetTag', operator: 'isEmpty' }), true);
  assert.equal(ok({ field: 'assetTag', operator: 'isEmpty', value: 'x' }), false);
  assert.equal(ok({ field: 'battery', operator: 'contains', value: 'x' }), false);
  assert.equal(ok({ field: 'battery', operator: 'is', values: ['replace-soon'] }), true);
  assert.equal(ok({ field: 'battery', operator: 'is', values: [] }), false);
  assert.equal(ok({ field: 'orgUnitPath', operator: 'within', value: 'School A' }), false);
  assert.equal(ok({ field: 'orgUnitPath', operator: 'within', value: '/School A' }), true);
  assert.equal(ok({ field: 'lastContact', operator: 'after', value: '2026-10-01T00:00:00Z' }), true);
  assert.equal(ok({ field: 'school', operator: 'equals', value: 'x' }), false);
});

test('queries bound page size, predicate count, and unknown keys', () => {
  assert.equal(deviceQuerySchema.safeParse({ limit: 201 }).success, false);
  assert.equal(
    deviceQuerySchema.safeParse({
      predicates: Array(21).fill({ field: 'model', operator: 'contains', value: 'a' }),
    }).success,
    false,
  );
  assert.equal(deviceQuerySchema.safeParse({ extra: true }).success, false);
});

test('battery values distinguish reported, missing, and unavailable data', () => {
  const reported = {
    status: 'reported',
    health: 'replace-soon',
    capacityPercent: 78,
    reportedAt: '2026-09-05T09:50:00-04:00',
  };
  assert.equal(deviceRowSchema.safeParse({ ...row, battery: reported }).success, true);
  for (const status of ['no-report', 'unavailable'])
    assert.equal(deviceRowSchema.safeParse({ ...row, battery: { status } }).success, true);
  assert.equal(deviceRowSchema.safeParse({ ...row, battery: { status: 'reported' } }).success, false);
  assert.equal(deviceRowSchema.safeParse({ ...row, battery: { status: 'unsupported' } }).success, false);
});

test('sync failures include orchestration and interruption codes', () => {
  const state = {
    customerId: 'C0123456',
    generation: 1,
    status: 'failed',
    observedAt: null,
    deviceCount: 0,
    failure: 'interrupted',
    telemetryFailure: null,
    startedAt: null,
    checkedAt: '2026-10-05T10:00:00Z',
    stale: false,
  };
  assert.equal(deviceSyncStateSchema.safeParse(state).success, true);
  assert.equal(
    deviceSyncStateSchema.safeParse({ ...state, failure: 'orchestration-unavailable' }).success,
    true,
  );
  assert.equal(deviceSyncStateSchema.safeParse({ ...state, failure: 'unknown' }).success, false);
});

test('devices:read applies to platform and district scopes', () => {
  assert.ok(actionSchema.options.includes('devices:read'));
  assert.deepEqual(actionScopeKinds['devices:read'], ['platform', 'district']);
  const grants = [{ action: 'devices:read', scope: { kind: 'district', customerId: 'C0123456' } }];
  assert.equal(isAuthorized(grants, 'devices:read', { kind: 'district', customerId: 'C0123456' }), true);
  assert.equal(isAuthorized(grants, 'devices:read', { kind: 'district', customerId: 'C9999999' }), false);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm exec nx run application-contracts:test --skip-nx-cache`
Expected: FAIL with `Cannot find module` for `devices.ts`.

- [ ] **Step 3: Write the contracts**

Create `libs/application-contracts/src/lib/devices.ts`:

```ts
import * as z from 'zod';
import { googleCustomerIdSchema, googleFailureSchema } from './google-connection';

const timestamp = z.iso.datetime({ offset: true });
const deviceId = z.string().min(1).max(128);
const orgUnitPath = z.string().min(1).max(4096).startsWith('/');
const percent = z.number().int().min(0).max(200);

export const batteryHealthSchema = z.enum(['normal', 'replace-soon', 'replace-now']);
export type BatteryHealth = z.infer<typeof batteryHealthSchema>;

export const batteryReportSchema = z.strictObject({
  reportedAt: timestamp,
  health: batteryHealthSchema.nullable(),
  capacityPercent: percent.nullable(),
});
export type BatteryReport = z.infer<typeof batteryReportSchema>;

export const deviceBatterySchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('reported'),
    health: batteryHealthSchema,
    capacityPercent: percent.nullable(),
    reportedAt: timestamp,
  }),
  z.strictObject({ status: z.literal('no-report') }),
  z.strictObject({ status: z.literal('unavailable') }),
]);
export type DeviceBattery = z.infer<typeof deviceBatterySchema>;

/** One device as the worker stages it. */
export const deviceObservationSchema = z.strictObject({
  deviceId,
  serialNumber: z.string().max(256),
  model: z.string().max(256).nullable(),
  assetTag: z.string().max(256).nullable(),
  orgUnitPath,
  lastContact: timestamp.nullable(),
  annotatedLocation: z.string().max(4096).nullable(),
  notes: z.string().max(4096).nullable(),
  status: z.string().max(64).nullable(),
});
export type DeviceObservation = z.infer<typeof deviceObservationSchema>;

/** One device's battery data as the worker stages it. The reader never reports unavailable. */
export const batteryObservationSchema = z.strictObject({
  deviceId,
  battery: deviceBatterySchema,
  reports: z.array(batteryReportSchema).max(30),
});
export type BatteryObservation = z.infer<typeof batteryObservationSchema>;

const rowShape = {
  deviceId,
  serialNumber: z.string().max(256),
  model: z.string().max(256).nullable(),
  assetTag: z.string().max(256).nullable(),
  orgUnitPath,
  lastContact: timestamp.nullable(),
  annotatedLocation: z.string().max(4096).nullable(),
  notes: z.string().max(4096).nullable(),
  battery: deviceBatterySchema,
};
export const deviceRowSchema = z.strictObject(rowShape);
export type DeviceRow = z.infer<typeof deviceRowSchema>;

export const deviceDetailSchema = z.strictObject({
  ...rowShape,
  observedAt: timestamp,
  batteryReports: z.array(batteryReportSchema).max(30),
});
export type DeviceDetail = z.infer<typeof deviceDetailSchema>;

export const deviceTextFieldSchema = z.enum([
  'serialNumber',
  'model',
  'assetTag',
  'annotatedLocation',
  'notes',
]);
export const deviceSortFieldSchema = z.enum([
  'serialNumber',
  'model',
  'assetTag',
  'orgUnitPath',
  'battery',
  'lastContact',
  'annotatedLocation',
  'notes',
]);
export const batteryFilterValueSchema = z.enum([
  'normal',
  'replace-soon',
  'replace-now',
  'no-report',
  'unavailable',
]);

const filterText = z.string().trim().min(1).max(256);

/** Each field type offers only its own operators. Chips combine with AND. */
export const devicePredicateSchema = z.union([
  z.strictObject({
    field: deviceTextFieldSchema,
    operator: z.enum(['contains', 'startsWith', 'equals']),
    value: filterText,
  }),
  z.strictObject({ field: deviceTextFieldSchema, operator: z.literal('isEmpty') }),
  z.strictObject({
    field: z.literal('orgUnitPath'),
    operator: z.enum(['equals', 'within']),
    value: orgUnitPath,
  }),
  z.strictObject({
    field: z.literal('battery'),
    operator: z.literal('is'),
    values: z.array(batteryFilterValueSchema).min(1).max(5),
  }),
  z.strictObject({
    field: z.literal('lastContact'),
    operator: z.enum(['before', 'after']),
    value: timestamp,
  }),
]);
export type DevicePredicate = z.infer<typeof devicePredicateSchema>;

export const deviceQuerySchema = z.strictObject({
  predicates: z.array(devicePredicateSchema).max(20).default([]),
  sort: z
    .strictObject({
      field: deviceSortFieldSchema,
      direction: z.enum(['asc', 'desc']),
    })
    .default({ field: 'serialNumber', direction: 'asc' }),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(200).default(100),
});
export type DeviceQuery = z.output<typeof deviceQuerySchema>;

export const devicePageSchema = z.strictObject({
  rows: z.array(deviceRowSchema).max(200),
  matching: z.number().int().min(0),
  total: z.number().int().min(0),
  observedAt: timestamp.nullable(),
});
export type DevicePage = z.infer<typeof devicePageSchema>;

export const deviceSyncFailureSchema = z.union([
  googleFailureSchema,
  z.enum(['key-unavailable', 'interrupted', 'orchestration-unavailable']),
]);
export type DeviceSyncFailure = z.infer<typeof deviceSyncFailureSchema>;

export const deviceSyncStateSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  generation: z.number().int().positive(),
  status: z.enum(['never', 'running', 'ready', 'failed']),
  observedAt: timestamp.nullable(),
  deviceCount: z.number().int().min(0),
  failure: deviceSyncFailureSchema.nullable(),
  telemetryFailure: googleFailureSchema.nullable(),
  startedAt: timestamp.nullable(),
  checkedAt: timestamp.nullable(),
  stale: z.boolean(),
});
export type DeviceSyncState = z.infer<typeof deviceSyncStateSchema>;
```

In `libs/application-contracts/src/index.ts`, add after the `school-scopes` export:

```ts
export * from './lib/devices';
```

In `libs/application-contracts/src/lib/authorization.ts`, add `'devices:read'` as the last entry of `actionSchema`, and add this entry to `actionScopeKinds`:

```ts
  'devices:read': ['platform', 'district'],
```

In `frontend/src/app/action-labels.ts`, add:

```ts
  'devices:read': 'View devices',
```

- [ ] **Step 4: Correct the battery reason in the workflow record**

In `docs/workflows/device-browsing.md`, replace the sentence `A device without battery data shows the reason when it is known: policy off, unsupported device, or no report yet.` with:

```markdown
A device without battery data shows "No battery report".
That message names two common causes: the `ReportDevicePowerStatus` policy is off, or the device has no battery.
Google withholds battery data in both cases, so Campus Commander cannot tell them apart.
A failed telemetry read shows battery data as unavailable for every device.
```

Replace the example `- A device without the power-status policy shows that battery reporting is off.` with:

```markdown
- A device without battery reports shows "No battery report" and names the power-status policy as a common cause.
```

Replace `4. Show each battery class and the no-report reasons.` with `4. Show each battery class, a device without reports, and unavailable telemetry.`

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm exec nx run application-contracts:test --skip-nx-cache`
Expected: PASS for all tests, including the existing school-scope tests.

Run: `npm exec nx run frontend:build`
Expected: PASS. The `Record<Action, string>` type requires a label for `devices:read`.

- [ ] **Step 6: Commit**

```bash
git add libs/application-contracts frontend/src/app/action-labels.ts docs/workflows/device-browsing.md
git commit -m "feat: add device inventory contracts and devices:read action"
```

---

### Task 2: Google device and telemetry reader

**Files:**
- Modify: `libs/application-contracts/src/lib/google-capabilities.ts` (two registry entries)
- Modify: `libs/google-connection/src/lib/provider.ts` (export `failure` and `scopedClient`, response limit parameter, URL allowlist)
- Create: `libs/google-connection/src/lib/devices.ts`
- Create: `libs/google-connection/src/lib/devices.test.mjs`
- Modify: `libs/google-connection/src/index.ts`

**Interfaces:**
- Consumes: `deviceObservationSchema`, `batteryObservationSchema`, `DeviceObservation`, `BatteryObservation`, `BatteryHealth` from Task 1.
- Produces: `class GoogleDeviceReader` with
  `devicePages(credential: DelegatedCredential, customerId: string, signal: AbortSignal): AsyncGenerator<DeviceObservation[]>` and
  `batteryPages(credential: DelegatedCredential, customerId: string, signal: AbortSignal): AsyncGenerator<BatteryObservation[]>`.
  Both throw `GoogleConnectionError` with a `GoogleFailure` code. Exported from `@campus/google-connection`.

- [ ] **Step 1: Write the failing test**

Create `libs/google-connection/src/lib/devices.test.mjs`:

```js
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { JWT, OAuth2Client } from 'google-auth-library';
import { GoogleDeviceReader } from './devices.ts';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
});
const credential = {
  subject: 'fixture@example.invalid',
  serviceAccount: {
    client_email: 'fixture@project.iam.gserviceaccount.com',
    private_key: privateKey,
    private_key_id: 'fixture',
  },
};
const deviceScope = 'https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly';
const telemetryScope = 'https://www.googleapis.com/auth/chrome.management.telemetry.readonly';

function stub(t, pages) {
  const calls = [];
  const scopes = [];
  t.mock.method(JWT.prototype, 'getAccessToken', async function () {
    scopes.push(...this.scopes);
    return { token: 'private-fixture-token' };
  });
  t.mock.method(JWT.prototype, 'getTokenInfo', async function () {
    return { scopes: [...this.scopes], expiry_date: Date.now() + 3_500_000 };
  });
  t.mock.method(OAuth2Client.prototype, 'request', async (options) => {
    calls.push(options);
    const next = pages.shift();
    if (next instanceof Error || (next && next.response)) throw next;
    return { data: next };
  });
  return { calls, scopes };
}

async function collect(iterable) {
  const pages = [];
  for await (const page of iterable) pages.push(page);
  return pages;
}

test('device pages follow page tokens and normalize fields', async (t) => {
  const { calls, scopes } = stub(t, [
    {
      nextPageToken: 'page-2',
      chromeosdevices: [
        {
          deviceId: 'd1',
          serialNumber: 'C0A1-7F2D',
          model: 'Lenovo 100e Gen 4',
          annotatedAssetId: 'HS-0417',
          orgUnitPath: '/School A',
          lastSync: '2026-09-05T14:28:12.345Z',
          annotatedLocation: 'Science wing',
          notes: '  ',
          status: 'ACTIVE',
        },
      ],
    },
    { chromeosdevices: [{ deviceId: 'd2', orgUnitPath: '/' }] },
  ]);
  const pages = await collect(
    new GoogleDeviceReader().devicePages(credential, 'C0123456', AbortSignal.timeout(5000)),
  );
  assert.deepEqual(scopes, [deviceScope]);
  assert.equal(calls[0].url, 'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/devices/chromeos');
  assert.equal(calls[0].params.maxResults, 300);
  assert.equal(calls[0].params.projection, 'FULL');
  assert.equal(calls[0].params.pageToken, undefined);
  assert.equal(calls[1].params.pageToken, 'page-2');
  assert.deepEqual(pages[0][0], {
    deviceId: 'd1',
    serialNumber: 'C0A1-7F2D',
    model: 'Lenovo 100e Gen 4',
    assetTag: 'HS-0417',
    orgUnitPath: '/School A',
    lastContact: '2026-09-05T14:28:12.345Z',
    annotatedLocation: 'Science wing',
    notes: null,
    status: 'ACTIVE',
  });
  assert.deepEqual(pages[1][0], {
    deviceId: 'd2',
    serialNumber: '',
    model: null,
    assetTag: null,
    orgUnitPath: '/',
    lastContact: null,
    annotatedLocation: null,
    notes: null,
    status: null,
  });
});

test('battery pages use the latest classified report and design capacity', async (t) => {
  const reports = Array.from({ length: 32 }, (_, index) => ({
    reportTime: new Date(Date.UTC(2026, 8, 1) + index * 86_400_000).toISOString(),
    fullChargeCapacity: String(4000 - index * 10),
    batteryHealth: 'BATTERY_REPLACE_SOON',
  }));
  const { calls, scopes } = stub(t, [
    {
      devices: [
        {
          deviceId: 'd1',
          batteryInfo: [{ designCapacity: '5000' }],
          batteryStatusReport: reports,
        },
        { deviceId: 'd2' },
        {
          deviceId: 'd3',
          batteryInfo: [{ designCapacity: '5000' }],
          batteryStatusReport: [
            { reportTime: '2026-09-05T13:50:00Z', fullChargeCapacity: '3900', batteryHealth: 'BATTERY_HEALTH_UNSPECIFIED' },
          ],
        },
        { serialNumber: 'no-device-id' },
      ],
    },
  ]);
  const [page] = await collect(
    new GoogleDeviceReader().batteryPages(credential, 'C0123456', AbortSignal.timeout(5000)),
  );
  assert.deepEqual(scopes, [telemetryScope]);
  assert.equal(calls[0].url, 'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices');
  assert.equal(calls[0].params.readMask, 'deviceId,batteryInfo,batteryStatusReport');
  assert.equal(page.length, 3);
  assert.deepEqual(page[0].battery, {
    status: 'reported',
    health: 'replace-soon',
    capacityPercent: 74,
    reportedAt: reports[31].reportTime,
  });
  assert.equal(page[0].reports.length, 30);
  assert.equal(page[0].reports[0].reportedAt, reports[31].reportTime);
  assert.deepEqual(page[1], { deviceId: 'd2', battery: { status: 'no-report' }, reports: [] });
  assert.deepEqual(page[2].battery, { status: 'no-report' });
  assert.equal(page[2].reports[0].capacityPercent, 78);
});

test('provider failures keep their classified codes', async (t) => {
  stub(t, [{ response: { status: 403, data: { error: { errors: [{ reason: 'forbidden' }] } } } }]);
  await assert.rejects(
    collect(new GoogleDeviceReader().devicePages(credential, 'C0123456', AbortSignal.timeout(5000))),
    { name: 'GoogleConnectionError', code: 'permission-denied' },
  );
});

test('malformed pages fail as invalid responses', async (t) => {
  stub(t, [{ chromeosdevices: [{ deviceId: 'd1', orgUnitPath: 'missing-slash' }] }]);
  await assert.rejects(
    collect(new GoogleDeviceReader().devicePages(credential, 'C0123456', AbortSignal.timeout(5000))),
    { name: 'GoogleConnectionError', code: 'invalid-response' },
  );
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm exec nx run google-connection:test --skip-nx-cache`
Expected: FAIL with `Cannot find module` for `devices.ts`.

- [ ] **Step 3: Register the two capabilities**

In `libs/application-contracts/src/lib/google-capabilities.ts`, append these entries inside the `GOOGLE_CAPABILITIES` array. They do not change the connection scopes because `requiredForConnection` is false.

```ts
  {
    id: 'device-inventory',
    requiredForConnection: false,
    label: 'ChromeOS device inventory',
    enabled: true,
    qualified: false,
    scope:
      'https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly',
    method: 'chromeosdevices.list',
    source:
      'https://developers.google.com/workspace/admin/directory/reference/rest/v1/chromeosdevices/list',
    evidence:
      'Device browsing workflow, 2026-10-05. Live qualification waits for owner scope configuration.',
  },
  {
    id: 'device-telemetry',
    requiredForConnection: false,
    label: 'ChromeOS battery telemetry',
    enabled: true,
    qualified: false,
    scope:
      'https://www.googleapis.com/auth/chrome.management.telemetry.readonly',
    method: 'customers.telemetry.devices.list',
    source:
      'https://developers.google.com/chrome/management/reference/rest/v1/customers.telemetry.devices/list',
    evidence:
      'Device browsing workflow, 2026-10-05. Live qualification waits for owner scope configuration.',
  },
```

- [ ] **Step 4: Open the provider helpers to the device reader**

In `libs/google-connection/src/lib/provider.ts`:

1. Change `function failure(` to `export function failure(`.
2. Replace the `boundClient` signature and allowlist with:

```ts
function boundClient(
  client: OAuth2Client,
  signal: AbortSignal,
  limit = responseLimit,
) {
  const request = client.transporter.request.bind(client.transporter);
  client.transporter.request = (options) => {
    const url = new URL(options?.url ?? '');
    const allowed =
      (url.origin === 'https://oauth2.googleapis.com' &&
        ['/token', '/tokeninfo'].includes(url.pathname)) ||
      (url.origin === 'https://admin.googleapis.com' &&
        (url.pathname === '/admin/directory/v1/customers/my_customer' ||
          /^\/admin\/directory\/v1\/customer\/C[A-Za-z0-9]{4,31}\/(?:domains|orgunits|devices\/chromeos)$/.test(
            url.pathname,
          ))) ||
      (url.origin === 'https://chromemanagement.googleapis.com' &&
        /^\/v1\/customers\/C[A-Za-z0-9]{4,31}\/telemetry\/devices$/.test(
          url.pathname,
        ));
    if (!allowed) throw new GoogleConnectionError('request-failed');
    return request({
      ...options,
      signal,
      timeout: 10_000,
      retry: false,
      retryConfig: { retry: 0 },
      maxRedirects: 0,
      maxContentLength: limit,
      size: limit,
    });
  };
}
```

3. Replace the `scopedClient` signature with an exported one that passes the limit to the data client only:

```ts
export async function scopedClient(
  credential: DelegatedCredential,
  scope: string,
  signal: AbortSignal,
  limit = responseLimit,
): Promise<OAuth2Client> {
```

Inside it, change the second `boundClient(client, signal);` call to `boundClient(client, signal, limit);`. Keep `boundClient(issuer, signal);` unchanged.

- [ ] **Step 5: Write the reader**

Create `libs/google-connection/src/lib/devices.ts`:

```ts
import { z } from 'zod';
import type { OAuth2Client } from 'google-auth-library';
import {
  GOOGLE_CAPABILITIES,
  batteryObservationSchema,
  deviceObservationSchema,
  googleCustomerIdSchema,
  type BatteryHealth,
  type BatteryObservation,
  type DeviceObservation,
} from '@campus/application-contracts';
import type { DelegatedCredential } from './credential';
import { GoogleConnectionError, failure, scopedClient } from './provider';

const directory = 'https://admin.googleapis.com/admin/directory/v1';
const management = 'https://chromemanagement.googleapis.com/v1';
const telemetryLimit = 8 * 1024 * 1024;
const maximumPages = 10_000;
const reportLimit = 30;
const tokenRenewalMilliseconds = 45 * 60_000;

const healthByGoogle: Readonly<Record<string, BatteryHealth>> = {
  BATTERY_HEALTH_NORMAL: 'normal',
  BATTERY_REPLACE_SOON: 'replace-soon',
  BATTERY_REPLACE_NOW: 'replace-now',
};

const devicePage = z.object({
  nextPageToken: z.string().min(1).max(4096).optional(),
  chromeosdevices: z
    .array(
      z.object({
        deviceId: z.string().min(1).max(128),
        serialNumber: z.string().max(256).optional(),
        model: z.string().max(256).optional(),
        annotatedAssetId: z.string().max(256).optional(),
        orgUnitPath: z.string().min(1).max(4096),
        lastSync: z.string().max(64).optional(),
        annotatedLocation: z.string().max(4096).optional(),
        notes: z.string().max(4096).optional(),
        status: z.string().max(64).optional(),
      }),
    )
    .max(300)
    .optional(),
});
type DirectoryDevice = NonNullable<
  z.infer<typeof devicePage>['chromeosdevices']
>[number];

const telemetryPage = z.object({
  nextPageToken: z.string().min(1).max(4096).optional(),
  devices: z
    .array(
      z.object({
        deviceId: z.string().min(1).max(128).optional(),
        batteryInfo: z
          .array(z.object({ designCapacity: z.coerce.number().optional() }))
          .max(16)
          .optional(),
        batteryStatusReport: z
          .array(
            z.object({
              reportTime: z.string().max(64),
              fullChargeCapacity: z.coerce.number().optional(),
              batteryHealth: z.string().max(64).optional(),
            }),
          )
          .max(1000)
          .optional(),
      }),
    )
    .max(1000)
    .optional(),
});
type TelemetryDevice = NonNullable<
  z.infer<typeof telemetryPage>['devices']
>[number];

function scopeFor(id: 'device-inventory' | 'device-telemetry'): string {
  return GOOGLE_CAPABILITIES.find((capability) => capability.id === id)!.scope;
}

function blank(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value;
}

function instant(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function deviceObservation(device: DirectoryDevice): DeviceObservation {
  return deviceObservationSchema.parse({
    deviceId: device.deviceId,
    serialNumber: device.serialNumber ?? '',
    model: blank(device.model),
    assetTag: blank(device.annotatedAssetId),
    orgUnitPath: device.orgUnitPath,
    lastContact: instant(device.lastSync),
    annotatedLocation: blank(device.annotatedLocation),
    notes: blank(device.notes),
    status: blank(device.status),
  });
}

/** Google classifies health. Campus Commander only converts capacities to a percentage. */
export function batteryObservation(
  device: TelemetryDevice,
): BatteryObservation | null {
  if (!device.deviceId) return null;
  const design = device.batteryInfo?.[0]?.designCapacity;
  const percent = (full: number | undefined) =>
    design !== undefined && design > 0 && full !== undefined && full >= 0
      ? Math.min(200, Math.round((full * 100) / design))
      : null;
  const reports = (device.batteryStatusReport ?? [])
    .flatMap((report) => {
      const reportedAt = instant(report.reportTime);
      if (!reportedAt) return [];
      const health =
        report.batteryHealth && Object.hasOwn(healthByGoogle, report.batteryHealth)
          ? healthByGoogle[report.batteryHealth]
          : null;
      return [{ reportedAt, health, capacityPercent: percent(report.fullChargeCapacity) }];
    })
    .sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt))
    .slice(0, reportLimit);
  const classified = reports.find((report) => report.health !== null);
  return batteryObservationSchema.parse({
    deviceId: device.deviceId,
    battery: classified?.health
      ? {
          status: 'reported',
          health: classified.health,
          capacityPercent: classified.capacityPercent,
          reportedAt: classified.reportedAt,
        }
      : { status: 'no-report' },
    reports,
  });
}

/** Read device inventory and battery telemetry with one exact-scope token per capability. */
export class GoogleDeviceReader {
  private async *pages<T>(
    credential: DelegatedCredential,
    scope: string,
    signal: AbortSignal,
    limit: number | undefined,
    load: (client: OAuth2Client, pageToken: string | undefined) => Promise<{
      items: T[];
      nextPageToken: string | undefined;
    }>,
  ): AsyncGenerator<T[]> {
    let client = await scopedClient(credential, scope, signal, limit);
    let issuedAt = Date.now();
    let pageToken: string | undefined;
    for (let page = 0; page < maximumPages; page++) {
      if (Date.now() - issuedAt > tokenRenewalMilliseconds) {
        client = await scopedClient(credential, scope, signal, limit);
        issuedAt = Date.now();
      }
      let result;
      try {
        result = await load(client, pageToken);
      } catch (error) {
        throw failure(error);
      }
      yield result.items;
      if (!result.nextPageToken) return;
      pageToken = result.nextPageToken;
    }
    throw new GoogleConnectionError('invalid-response');
  }

  devicePages(
    credential: DelegatedCredential,
    customerId: string,
    signal: AbortSignal,
  ): AsyncGenerator<DeviceObservation[]> {
    googleCustomerIdSchema.parse(customerId);
    return this.pages(
      credential,
      scopeFor('device-inventory'),
      signal,
      undefined,
      async (client, pageToken) => {
        const data = devicePage.parse(
          (
            await client.request({
              url: `${directory}/customer/${customerId}/devices/chromeos`,
              method: 'GET',
              params: {
                maxResults: 300,
                projection: 'FULL',
                fields:
                  'nextPageToken,chromeosdevices(deviceId,serialNumber,model,annotatedAssetId,orgUnitPath,lastSync,annotatedLocation,notes,status)',
                ...(pageToken ? { pageToken } : {}),
              },
            })
          ).data,
        );
        return {
          items: (data.chromeosdevices ?? []).map(deviceObservation),
          nextPageToken: data.nextPageToken,
        };
      },
    );
  }

  batteryPages(
    credential: DelegatedCredential,
    customerId: string,
    signal: AbortSignal,
  ): AsyncGenerator<BatteryObservation[]> {
    googleCustomerIdSchema.parse(customerId);
    return this.pages(
      credential,
      scopeFor('device-telemetry'),
      signal,
      telemetryLimit,
      async (client, pageToken) => {
        const data = telemetryPage.parse(
          (
            await client.request({
              url: `${management}/customers/${customerId}/telemetry/devices`,
              method: 'GET',
              params: {
                readMask: 'deviceId,batteryInfo,batteryStatusReport',
                pageSize: 200,
                ...(pageToken ? { pageToken } : {}),
              },
            })
          ).data,
        );
        return {
          items: (data.devices ?? []).flatMap((device) => {
            const observation = batteryObservation(device);
            return observation ? [observation] : [];
          }),
          nextPageToken: data.nextPageToken,
        };
      },
    );
  }
}
```

In `libs/google-connection/src/index.ts`, add:

```ts
export { GoogleDeviceReader } from './lib/devices';
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npm exec nx run google-connection:test --skip-nx-cache`
Expected: PASS for the new tests and the existing provider, credential, and capability tests.

Run: `npm exec nx run google-connection:typecheck --skip-nx-cache`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add libs/application-contracts/src/lib/google-capabilities.ts libs/google-connection
git commit -m "feat: read ChromeOS devices and battery telemetry from Google"
```

---

### Task 3: Device inventory storage

**Files:**
- Create: `deployment/postgres/migrations/016-device-inventory.sql`
- Modify: `deployment/postgres/index.mjs` (`loadMigrations` list and runtime grants)
- Create: `deployment/postgres/device-inventory.integration.mjs`
- Modify: `deployment/postgres/integration.mjs` (run the new qualification after `qualifySchoolReferences`)

**Interfaces:**
- Consumes: Task 1 field names and battery states.
- Produces these database functions. API functions take `(actor uuid, version integer)` and check `devices:read` without locks.
  - `cc.device_reader(uuid,integer) → cc.google_connection` (null row when no connection exists)
  - `cc.read_device_sync(uuid,integer) → jsonb` (`DeviceSyncState` or null)
  - `cc.request_device_sync(uuid,integer,text,integer,uuid,uuid) → jsonb` (actor, version, customer, generation, sync ID, correlation)
  - `cc.abandon_device_sync(uuid,integer,text,uuid,text) → jsonb`
  - Worker functions, fenced by sync ID and attempt ID:
  - `cc.claim_device_sync(text,uuid,uuid) → jsonb` returning `{generation, credentialId, envelope}`
  - `cc.stage_devices(text,uuid,uuid,jsonb) → integer`
  - `cc.stage_device_batteries(text,uuid,uuid,jsonb) → integer`
  - `cc.finish_device_sync(text,uuid,uuid,text,text) → jsonb` (failure, telemetry failure)
  - `cc.purge_device_syncs(text,integer) → integer`
- Produces tables `cc.devices` and `cc.device_sync_state`. The runtime role receives `SELECT` on both.
- Raises `P0001` with these `DETAIL` values: `device-sync-running`, `device-sync-changed`, `device-sync-claimed`, and `connection-changed`. It also passes through `credential-changed`, `connection-disconnected`, and `restore-revalidation-required` from `cc.google_current_generation`. Authority failures raise `42501`.

- [ ] **Step 1: Write the failing integration test**

Create `deployment/postgres/device-inventory.integration.mjs`:

```js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function qualifyDeviceInventory({ runtime, migrator, issuer }) {
  const connection = (
    await migrator.query('SELECT * FROM cc.google_connection')
  ).rows[0];
  const customer = connection.customer_id;
  const generation = connection.generation;
  const wasActive = connection.active;
  await migrator.query('UPDATE cc.google_connection SET active=true');
  const reader = randomUUID();
  const outsider = randomUUID();
  try {
    for (const id of [reader, outsider])
      await migrator.query(
        'INSERT INTO cc.application_principals(id,issuer,subject,display_name) VALUES($1,$2,$3,$3)',
        [id, issuer, id],
      );
    await migrator.query(
      'INSERT INTO cc.application_grants(principal_id,action,scope) VALUES($1,$2,$3)',
      [reader, 'devices:read', JSON.stringify({ kind: 'district', customerId: customer })],
    );
    const result = (sql, values) =>
      runtime.query(sql, values).then((r) => r.rows[0].result);
    const read = (who = reader) =>
      result('SELECT cc.read_device_sync($1,1) AS result', [who]);
    const request = (id = randomUUID()) =>
      result('SELECT cc.request_device_sync($1,1,$2,$3,$4,$5) AS result', [
        reader, customer, generation, id, randomUUID(),
      ]).then((state) => ({ id, state }));
    const claim = (id, attempt) =>
      result('SELECT cc.claim_device_sync($1,$2,$3) AS result', [customer, id, attempt]);
    const device = (deviceId, extra = {}) => ({
      deviceId,
      serialNumber: `SN-${deviceId}`,
      model: 'Lenovo 100e Gen 4',
      assetTag: `HS-${deviceId}`,
      orgUnitPath: '/School A',
      lastContact: '2026-10-05T12:00:00.000Z',
      annotatedLocation: null,
      notes: null,
      status: 'ACTIVE',
      ...extra,
    });
    const stage = (id, attempt, devices) =>
      result('SELECT cc.stage_devices($1,$2,$3,$4) AS result', [
        customer, id, attempt, JSON.stringify(devices),
      ]);
    const batteries = (id, attempt, values) =>
      result('SELECT cc.stage_device_batteries($1,$2,$3,$4) AS result', [
        customer, id, attempt, JSON.stringify(values),
      ]);
    const finish = (id, attempt, failure = null, telemetry = null) =>
      result('SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result', [
        customer, id, attempt, failure, telemetry,
      ]);
    const purge = () =>
      result('SELECT cc.purge_device_syncs($1,5000) AS result', [customer]);
    const published = async () =>
      (
        await runtime.query(
          'SELECT d.* FROM cc.devices d JOIN cc.device_sync_state s ON d.sync_id=s.current_sync_id WHERE s.customer_id=$1 ORDER BY d.device_id',
          [customer],
        )
      ).rows;
    const detail = (code) => (error) => error.detail === code;

    assert.equal((await read()).status, 'never');
    await assert.rejects(read(outsider), (error) => error.code === '42501');

    const first = await request();
    assert.equal(first.state.status, 'running');
    await assert.rejects(request(), detail('device-sync-running'));
    const attempt = randomUUID();
    const claimed = await claim(first.id, attempt);
    assert.equal(claimed.generation, generation);
    assert.ok(claimed.credentialId);
    await assert.rejects(claim(first.id, randomUUID()), detail('device-sync-claimed'));
    assert.equal(
      await stage(first.id, attempt, [device('d1'), device('d2'), device('d2', { model: 'HP' })]),
      2,
    );
    assert.equal(
      await batteries(first.id, attempt, [
        {
          deviceId: 'd1',
          battery: { status: 'reported', health: 'replace-soon', capacityPercent: 78, reportedAt: '2026-10-05T11:00:00.000Z' },
          reports: [{ reportedAt: '2026-10-05T11:00:00.000Z', health: 'replace-soon', capacityPercent: 78 }],
        },
        { deviceId: 'unknown', battery: { status: 'no-report' }, reports: [] },
      ]),
      1,
    );
    const ready = await finish(first.id, attempt);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.deviceCount, 2);
    assert.equal(ready.stale, false);
    let rows = await published();
    assert.deepEqual(rows.map((row) => row.model), ['Lenovo 100e Gen 4', 'HP']);
    assert.equal(rows[0].battery_health, 'replace-soon');
    assert.equal(rows[1].battery_status, 'no-report');
    await assert.rejects(finish(first.id, attempt), detail('device-sync-changed'));

    const failed = await request();
    const failedAttempt = randomUUID();
    await claim(failed.id, failedAttempt);
    await stage(failed.id, failedAttempt, [device('d9')]);
    const failure = await finish(failed.id, failedAttempt, 'permission-denied');
    assert.equal(failure.status, 'failed');
    assert.equal(failure.failure, 'permission-denied');
    assert.equal(failure.stale, true);
    assert.equal(failure.deviceCount, 2);
    assert.equal(failure.observedAt, ready.observedAt);
    assert.equal(await purge(), 1);
    assert.equal((await published()).length, 2);

    const blind = await request();
    const blindAttempt = randomUUID();
    await claim(blind.id, blindAttempt);
    await stage(blind.id, blindAttempt, [device('d1')]);
    const unavailable = await finish(blind.id, blindAttempt, null, 'permission-denied');
    assert.equal(unavailable.status, 'ready');
    assert.equal(unavailable.telemetryFailure, 'permission-denied');
    rows = await published();
    assert.deepEqual(rows.map((row) => row.battery_status), ['unavailable']);
    assert.equal(await purge(), 2);

    const lost = await request();
    const lostAttempt = randomUUID();
    await claim(lost.id, lostAttempt);
    await migrator.query(
      "UPDATE cc.device_sync_state SET sync_expires_at=clock_timestamp()-interval '1 second' WHERE customer_id=$1",
      [customer],
    );
    const interrupted = await read();
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.failure, 'interrupted');
    assert.equal(interrupted.stale, true);
    await assert.rejects(stage(lost.id, lostAttempt, [device('d5')]), detail('device-sync-changed'));
    await assert.rejects(finish(lost.id, lostAttempt), detail('device-sync-changed'));
    const next = await request();
    assert.equal(next.state.status, 'running');
    const abandoned = await result(
      'SELECT cc.abandon_device_sync($1,1,$2,$3,$4) AS result',
      [reader, customer, next.id, 'orchestration-unavailable'],
    );
    assert.equal(abandoned.failure, 'orchestration-unavailable');

    await migrator.query(
      'UPDATE cc.application_principals SET permission_version=2 WHERE id=$1',
      [reader],
    );
    await assert.rejects(read(), (error) => error.code === '42501');
    return [
      'device inventory reads require current devices:read authority: pass',
      'one worker attempt claims a device sync and duplicate dispatch is rejected: pass',
      'failed syncs keep the published inventory and mark it stale: pass',
      'telemetry failure publishes devices with unavailable battery data: pass',
      'expired leases report interruption and reject late publication: pass',
    ];
  } finally {
    await migrator.query('UPDATE cc.google_connection SET active=$1', [wasActive]);
  }
}
```

In `deployment/postgres/integration.mjs`, import `qualifyDeviceInventory` from `./device-inventory.integration.mjs` and add this block directly after the `qualifySchoolReferences` block:

```js
  results.push(
    ...(await qualifyDeviceInventory({
      runtime,
      migrator: migrators[0],
      issuer,
    })),
  );
```

- [ ] **Step 2: Run the integration and confirm it fails**

Run: `npm exec nx run deployment:postgres-integration`
Expected: FAIL with `relation "cc.device_sync_state" does not exist` or a missing `cc.read_device_sync` function.

- [ ] **Step 3: Write the migration**

Create `deployment/postgres/migrations/016-device-inventory.sql`:

```sql
-- Device inventory publishes one complete sync per customer. Reads never take connection locks.
INSERT INTO cc.application_actions(action,scope_kinds) VALUES('devices:read',ARRAY['platform','district']);

CREATE TABLE cc.device_sync_state (
  customer_id text PRIMARY KEY REFERENCES cc.google_connection(customer_id),
  current_sync_id uuid,
  generation integer,
  observed_at timestamptz,
  device_count integer NOT NULL DEFAULT 0 CHECK(device_count>=0),
  telemetry_failure text CHECK(telemetry_failure IN ('credential-rejected','delegation-not-authorized','api-not-enabled',
    'policy-restricted','network-failure','scope-mismatch','permission-denied','quota','provider-unavailable',
    'invalid-response','wrong-customer','request-failed')),
  failure text CHECK(failure IN ('credential-rejected','delegation-not-authorized','api-not-enabled',
    'policy-restricted','network-failure','scope-mismatch','permission-denied','quota','provider-unavailable',
    'invalid-response','wrong-customer','request-failed','key-unavailable','interrupted','orchestration-unavailable')),
  checked_at timestamptz,
  sync_id uuid,
  sync_actor uuid REFERENCES cc.application_principals(id),
  sync_generation integer,
  sync_attempt uuid,
  sync_started_at timestamptz,
  sync_expires_at timestamptz,
  correlation_id uuid,
  CHECK((current_sync_id IS NULL)=(observed_at IS NULL)),
  CHECK((sync_id IS NULL)=(sync_expires_at IS NULL))
);

CREATE TABLE cc.devices (
  customer_id text NOT NULL,
  sync_id uuid NOT NULL,
  device_id text NOT NULL CHECK(length(device_id) BETWEEN 1 AND 128),
  serial_number text NOT NULL CHECK(length(serial_number)<=256),
  model text CHECK(length(model)<=256),
  asset_tag text CHECK(length(asset_tag)<=256),
  org_unit_path text NOT NULL CHECK(left(org_unit_path,1)='/' AND length(org_unit_path)<=4096),
  last_contact timestamptz,
  annotated_location text CHECK(length(annotated_location)<=4096),
  notes text CHECK(length(notes)<=4096),
  status text CHECK(length(status)<=64),
  battery_status text NOT NULL DEFAULT 'no-report' CHECK(battery_status IN ('reported','no-report','unavailable')),
  battery_health text CHECK(battery_health IN ('normal','replace-soon','replace-now')),
  battery_capacity_percent integer CHECK(battery_capacity_percent BETWEEN 0 AND 200),
  battery_reported_at timestamptz,
  battery_reports jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK(jsonb_typeof(battery_reports)='array' AND jsonb_array_length(battery_reports)<=30),
  CHECK((battery_status='reported')=(battery_health IS NOT NULL AND battery_reported_at IS NOT NULL)),
  PRIMARY KEY(sync_id,device_id)
);
CREATE INDEX devices_customer ON cc.devices(customer_id,sync_id);
CREATE INDEX devices_serial ON cc.devices(sync_id,serial_number,device_id);
CREATE INDEX devices_model ON cc.devices(sync_id,model,device_id);
CREATE INDEX devices_asset ON cc.devices(sync_id,asset_tag,device_id);
CREATE INDEX devices_org_unit ON cc.devices(sync_id,org_unit_path text_pattern_ops);
CREATE INDEX devices_contact ON cc.devices(sync_id,last_contact,device_id);

CREATE FUNCTION cc.device_reader(p_actor uuid,p_version integer) RETURNS cc.google_connection
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  SELECT * INTO connection FROM cc.google_connection WHERE singleton;
  IF NOT EXISTS(SELECT 1 FROM cc.application_principals p
      WHERE p.id=p_actor AND p.enabled AND p.permission_version=p_version) OR
    NOT EXISTS(SELECT 1 FROM cc.application_grants g WHERE g.principal_id=p_actor AND g.action='devices:read' AND (
      g.scope='{"kind":"platform"}'::jsonb OR
      (g.scope->>'kind'='district' AND g.scope->>'customerId'=connection.customer_id))) THEN
    RAISE EXCEPTION 'Device read authority is required.' USING ERRCODE='42501';
  END IF;
  RETURN connection;
END;
$$;

CREATE FUNCTION cc.device_sync_projection(p_customer text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('customerId',c.customer_id,'generation',c.generation,'status',x.status,
    'observedAt',s.observed_at,'deviceCount',COALESCE(s.device_count,0),
    'failure',CASE WHEN x.status='failed' THEN COALESCE(CASE WHEN s.sync_id IS NOT NULL THEN 'interrupted' END,s.failure) END,
    'telemetryFailure',s.telemetry_failure,'startedAt',s.sync_started_at,'checkedAt',s.checked_at,
    'stale',COALESCE(s.observed_at IS NOT NULL AND
      (x.status='failed' OR s.observed_at<clock_timestamp()-interval '24 hours'),false))
  FROM cc.google_connection c
  LEFT JOIN cc.device_sync_state s ON s.customer_id=c.customer_id
  CROSS JOIN LATERAL (SELECT CASE
    WHEN s.sync_id IS NOT NULL AND s.sync_expires_at>clock_timestamp() THEN 'running'
    WHEN s.sync_id IS NOT NULL OR s.failure IS NOT NULL THEN 'failed'
    WHEN s.observed_at IS NOT NULL THEN 'ready'
    ELSE 'never' END AS status) x
  WHERE c.customer_id=p_customer;
$$;

CREATE FUNCTION cc.read_device_sync(p_actor uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection;
BEGIN
  connection:=cc.device_reader(p_actor,p_version);
  IF connection.customer_id IS NULL THEN RETURN NULL; END IF;
  RETURN cc.device_sync_projection(connection.customer_id);
END;
$$;

CREATE FUNCTION cc.request_device_sync(p_actor uuid,p_version integer,p_customer text,p_generation integer,
  p_id uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; prior cc.device_sync_state; now_at timestamptz:=clock_timestamp();
BEGIN
  connection:=cc.device_reader(p_actor,p_version);
  IF connection.customer_id IS DISTINCT FROM p_customer OR connection.generation IS DISTINCT FROM p_generation OR
    connection.active IS NOT TRUE THEN
    RAISE EXCEPTION 'The Google connection changed.' USING DETAIL='connection-changed';
  END IF;
  IF p_id IS NULL OR p_correlation IS NULL THEN
    RAISE EXCEPTION 'The sync identifier is required.' USING ERRCODE='22023';
  END IF;
  INSERT INTO cc.device_sync_state(customer_id) VALUES(p_customer) ON CONFLICT(customer_id) DO NOTHING;
  SELECT * INTO prior FROM cc.device_sync_state WHERE customer_id=p_customer FOR UPDATE;
  IF prior.sync_id IS NOT NULL AND prior.sync_expires_at>now_at THEN
    RAISE EXCEPTION 'A device sync is running.' USING DETAIL='device-sync-running';
  END IF;
  UPDATE cc.device_sync_state SET
    failure=CASE WHEN prior.sync_id IS NOT NULL THEN 'interrupted' ELSE failure END,
    checked_at=CASE WHEN prior.sync_id IS NOT NULL THEN prior.sync_expires_at ELSE checked_at END,
    sync_id=p_id,sync_actor=p_actor,sync_generation=p_generation,sync_attempt=NULL,
    sync_started_at=now_at,sync_expires_at=now_at+interval '15 minutes',correlation_id=p_correlation
  WHERE customer_id=p_customer;
  RETURN cc.device_sync_projection(p_customer);
END;
$$;

CREATE FUNCTION cc.abandon_device_sync(p_actor uuid,p_version integer,p_customer text,p_id uuid,p_failure text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  PERFORM cc.device_reader(p_actor,p_version);
  IF p_failure IS DISTINCT FROM 'orchestration-unavailable' THEN
    RAISE EXCEPTION 'Only an undispatched sync can be abandoned.' USING ERRCODE='22023';
  END IF;
  UPDATE cc.device_sync_state SET failure=p_failure,checked_at=clock_timestamp(),sync_id=NULL,sync_actor=NULL,
    sync_generation=NULL,sync_attempt=NULL,sync_expires_at=NULL
  WHERE customer_id=p_customer AND sync_id=p_id AND sync_attempt IS NULL;
  RETURN cc.device_sync_projection(p_customer);
END;
$$;

CREATE FUNCTION cc.claim_device_sync(p_customer text,p_id uuid,p_attempt uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE pending cc.device_sync_state; connection cc.google_connection; now_at timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO pending FROM cc.device_sync_state WHERE customer_id=p_customer FOR UPDATE;
  IF p_id IS NULL OR p_attempt IS NULL OR pending.sync_id IS DISTINCT FROM p_id OR pending.sync_expires_at<=now_at THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  IF pending.sync_attempt IS NOT NULL AND pending.sync_attempt<>p_attempt THEN
    RAISE EXCEPTION 'Another worker claimed this device sync.' USING DETAIL='device-sync-claimed';
  END IF;
  connection:=cc.google_current_generation(p_customer,pending.sync_generation);
  UPDATE cc.device_sync_state SET sync_attempt=p_attempt,sync_expires_at=now_at+interval '10 minutes'
  WHERE customer_id=p_customer;
  RETURN jsonb_build_object('generation',connection.generation,'credentialId',connection.credential_id,
    'envelope',(SELECT envelope FROM cc.google_credentials WHERE id=connection.credential_id));
END;
$$;

CREATE FUNCTION cc.device_sync_lease(p_customer text,p_id uuid,p_attempt uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE now_at timestamptz:=clock_timestamp();
BEGIN
  UPDATE cc.device_sync_state SET sync_expires_at=now_at+interval '10 minutes'
  WHERE customer_id=p_customer AND sync_id=p_id AND sync_attempt=p_attempt AND sync_expires_at>now_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
END;
$$;

CREATE FUNCTION cc.stage_devices(p_customer text,p_id uuid,p_attempt uuid,p_devices jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE staged integer;
BEGIN
  PERFORM cc.device_sync_lease(p_customer,p_id,p_attempt);
  IF jsonb_typeof(p_devices) IS DISTINCT FROM 'array' OR jsonb_array_length(p_devices)>1000 THEN
    RAISE EXCEPTION 'The device page is invalid.' USING ERRCODE='22023';
  END IF;
  INSERT INTO cc.devices(customer_id,sync_id,device_id,serial_number,model,asset_tag,org_unit_path,last_contact,
    annotated_location,notes,status)
  SELECT DISTINCT ON (d."deviceId") p_customer,p_id,d."deviceId",d."serialNumber",d.model,d."assetTag",d."orgUnitPath",
    d."lastContact",d."annotatedLocation",d.notes,d.status
  FROM jsonb_to_recordset(p_devices) WITH ORDINALITY AS d("deviceId" text,"serialNumber" text,model text,"assetTag" text,
    "orgUnitPath" text,"lastContact" timestamptz,"annotatedLocation" text,notes text,status text,position bigint)
  ORDER BY d."deviceId",d.position DESC
  ON CONFLICT(sync_id,device_id) DO UPDATE SET serial_number=EXCLUDED.serial_number,model=EXCLUDED.model,
    asset_tag=EXCLUDED.asset_tag,org_unit_path=EXCLUDED.org_unit_path,last_contact=EXCLUDED.last_contact,
    annotated_location=EXCLUDED.annotated_location,notes=EXCLUDED.notes,status=EXCLUDED.status;
  GET DIAGNOSTICS staged=ROW_COUNT;
  RETURN staged;
END;
$$;

CREATE FUNCTION cc.stage_device_batteries(p_customer text,p_id uuid,p_attempt uuid,p_batteries jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE staged integer;
BEGIN
  PERFORM cc.device_sync_lease(p_customer,p_id,p_attempt);
  IF jsonb_typeof(p_batteries) IS DISTINCT FROM 'array' OR jsonb_array_length(p_batteries)>1000 THEN
    RAISE EXCEPTION 'The battery page is invalid.' USING ERRCODE='22023';
  END IF;
  UPDATE cc.devices d SET battery_status=b.status,battery_health=b.health,battery_capacity_percent=b.capacity,
    battery_reported_at=b.reported_at,battery_reports=COALESCE(b.reports,'[]'::jsonb)
  FROM (SELECT DISTINCT ON (x."deviceId") x."deviceId" AS device_id,x.battery->>'status' AS status,
      x.battery->>'health' AS health,(x.battery->>'capacityPercent')::integer AS capacity,
      (x.battery->>'reportedAt')::timestamptz AS reported_at,x.reports
    FROM jsonb_to_recordset(p_batteries) AS x("deviceId" text,battery jsonb,reports jsonb)) b
  WHERE d.sync_id=p_id AND d.device_id=b.device_id;
  GET DIAGNOSTICS staged=ROW_COUNT;
  RETURN staged;
END;
$$;

CREATE FUNCTION cc.finish_device_sync(p_customer text,p_id uuid,p_attempt uuid,p_failure text,p_telemetry_failure text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE pending cc.device_sync_state; now_at timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO pending FROM cc.device_sync_state WHERE customer_id=p_customer FOR UPDATE;
  IF p_id IS NULL OR p_attempt IS NULL OR pending.sync_id IS DISTINCT FROM p_id OR
    pending.sync_attempt IS DISTINCT FROM p_attempt OR pending.sync_expires_at<=now_at THEN
    RAISE EXCEPTION 'The device sync expired or changed.' USING DETAIL='device-sync-changed';
  END IF;
  IF p_failure IS NULL THEN
    PERFORM cc.google_current_generation(p_customer,pending.sync_generation);
    IF p_telemetry_failure IS NOT NULL THEN
      UPDATE cc.devices SET battery_status='unavailable',battery_health=NULL,battery_capacity_percent=NULL,
        battery_reported_at=NULL,battery_reports='[]'::jsonb
      WHERE sync_id=p_id;
    END IF;
    UPDATE cc.device_sync_state SET current_sync_id=p_id,generation=pending.sync_generation,observed_at=now_at,
      device_count=(SELECT count(*) FROM cc.devices WHERE sync_id=p_id),telemetry_failure=p_telemetry_failure,failure=NULL
    WHERE customer_id=p_customer;
  ELSE
    UPDATE cc.device_sync_state SET failure=p_failure WHERE customer_id=p_customer;
  END IF;
  UPDATE cc.device_sync_state SET checked_at=now_at,sync_id=NULL,sync_actor=NULL,sync_generation=NULL,
    sync_attempt=NULL,sync_expires_at=NULL
  WHERE customer_id=p_customer;
  RETURN cc.device_sync_projection(p_customer);
END;
$$;

CREATE FUNCTION cc.purge_device_syncs(p_customer text,p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE state cc.device_sync_state; removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'The purge limit is invalid.' USING ERRCODE='22023';
  END IF;
  SELECT * INTO state FROM cc.device_sync_state WHERE customer_id=p_customer FOR SHARE;
  DELETE FROM cc.devices WHERE ctid IN (
    SELECT ctid FROM cc.devices WHERE customer_id=p_customer
      AND sync_id IS DISTINCT FROM state.current_sync_id AND sync_id IS DISTINCT FROM state.sync_id
    LIMIT p_limit);
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON cc.device_sync_state,cc.devices FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.device_reader(uuid,integer),cc.device_sync_projection(text),
  cc.read_device_sync(uuid,integer),cc.request_device_sync(uuid,integer,text,integer,uuid,uuid),
  cc.abandon_device_sync(uuid,integer,text,uuid,text),cc.claim_device_sync(text,uuid,uuid),
  cc.device_sync_lease(text,uuid,uuid),cc.stage_devices(text,uuid,uuid,jsonb),
  cc.stage_device_batteries(text,uuid,uuid,jsonb),cc.finish_device_sync(text,uuid,uuid,text,text),
  cc.purge_device_syncs(text,integer) FROM PUBLIC;
```

The `WITH ORDINALITY` ordering keeps the last duplicate of a device within one page.

- [ ] **Step 4: Register the migration and grants**

In `deployment/postgres/index.mjs`, add `'016-device-inventory',` after `'015-restore-revalidation',` in `loadMigrations`. Add this block after the `007-google-connection` grant block inside `migrate`:

```js
    if (migrations.some(({ id }) => id === '016-device-inventory')) {
      await client.query(`GRANT SELECT ON cc.devices, cc.device_sync_state TO ${role};
        GRANT EXECUTE ON FUNCTION cc.device_reader(uuid,integer),
        cc.read_device_sync(uuid,integer),
        cc.request_device_sync(uuid,integer,text,integer,uuid,uuid),
        cc.abandon_device_sync(uuid,integer,text,uuid,text),
        cc.claim_device_sync(text,uuid,uuid),
        cc.stage_devices(text,uuid,uuid,jsonb),
        cc.stage_device_batteries(text,uuid,uuid,jsonb),
        cc.finish_device_sync(text,uuid,uuid,text,text),
        cc.purge_device_syncs(text,integer) TO ${role}`);
    }
```

- [ ] **Step 5: Run the checks and confirm they pass**

Run: `npm exec nx run deployment:postgres-test --skip-nx-cache`
Expected: PASS. If a test asserts the migration count, update it to include `016-device-inventory`.

Run: `npm exec nx run deployment:postgres-integration`
Expected: PASS, with the five new device inventory lines in the output.

- [ ] **Step 6: Commit**

```bash
git add deployment/postgres
git commit -m "feat: store device inventory syncs in PostgreSQL"
```

---

### Task 4: Worker device sync

**Files:**
- Modify: `libs/application-contracts/test-register.mjs` (resolve `@campus/google-connection`)
- Create: `worker/src/device-sync.ts`
- Create: `worker/src/device-sync.test.mjs`
- Modify: `worker/src/google-connection.ts` (shared pool and cipher, `syncDevices`)
- Modify: `worker/src/dispatch.ts` (shared admission helper, `handleDeviceSyncDispatch`)
- Modify: `worker/src/main.ts` (route the new dispatch)
- Modify: `worker/project.json` (`test` target)

**Interfaces:**
- Consumes: `GoogleDeviceReader` (Task 2). Database functions `cc.claim_device_sync`, `cc.stage_devices`, `cc.stage_device_batteries`, `cc.finish_device_sync`, and `cc.purge_device_syncs` (Task 3). `deviceSyncStateSchema` (Task 1).
- Produces: `POST /dispatch/device-sync` on the worker. It requires the bearer dispatch secret and the body `{customerId, syncId, correlationId, executionId}`. It returns `200 {executionId, correlationId, status:'completed', sync}`. It returns `409 {error}` for a lost or claimed lease and `400` for an invalid payload.

- [ ] **Step 1: Let worker tests resolve the Google library**

In `libs/application-contracts/test-register.mjs`, add this branch after the `@campus/application-contracts` branch:

```js
    if (specifier === '@campus/google-connection') {
      return nextResolve(
        new URL('../google-connection/src/index.ts', import.meta.url).href,
        context,
      );
    }
```

In `worker/project.json`, add:

```json
    "test": {
      "executor": "nx:run-commands",
      "cache": true,
      "options": {
        "command": "node --import ./libs/application-contracts/test-register.mjs --test worker/src/*.test.mjs"
      }
    },
```

- [ ] **Step 2: Write the failing test**

Create `worker/src/device-sync.test.mjs`:

```js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { GoogleConnectionError } from '@campus/google-connection';
import { DeviceSync, DeviceSyncError } from './device-sync.ts';

const customerId = 'C0123456';
const request = { customerId, syncId: randomUUID(), correlationId: randomUUID() };
const state = {
  customerId,
  generation: 1,
  status: 'ready',
  observedAt: '2026-10-05T12:00:00.000Z',
  deviceCount: 2,
  failure: null,
  telemetryFailure: null,
  startedAt: '2026-10-05T11:59:00.000Z',
  checkedAt: '2026-10-05T12:00:00.000Z',
  stale: false,
};
const device = (deviceId) => ({
  deviceId,
  serialNumber: deviceId,
  model: null,
  assetTag: null,
  orgUnitPath: '/',
  lastContact: null,
  annotatedLocation: null,
  notes: null,
  status: null,
});

function database({ fail = {}, purged = [0] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      const name = /cc\.(\w+)/.exec(sql)[1];
      calls.push({ name, values });
      if (fail[name]) throw Object.assign(new Error(name), { code: 'P0001', detail: fail[name] });
      if (name === 'claim_device_sync')
        return { rows: [{ result: { generation: 1, credentialId: randomUUID(), envelope: { sealed: true } } }] };
      if (name === 'finish_device_sync') return { rows: [{ result: state }] };
      if (name === 'purge_device_syncs') return { rows: [{ result: purged.shift() ?? 0 }] };
      return { rows: [{ result: 1 }] };
    },
  };
}
const cipher = { open: () => ({ subject: 'fixture@example.invalid', serviceAccount: {} }) };
function reader({ devices = [[device('d1'), device('d2')]], batteries = [[]] } = {}) {
  return {
    async *devicePages() {
      for (const page of devices) {
        if (page instanceof Error) throw page;
        yield page;
      }
    },
    async *batteryPages() {
      for (const page of batteries) {
        if (page instanceof Error) throw page;
        yield page;
      }
    },
  };
}
const names = (calls) => calls.map((call) => call.name);

test('stages every page, publishes, and purges retired rows', async () => {
  const db = database({ purged: [5000, 12] });
  const result = await new DeviceSync(db, cipher, reader()).run(request, AbortSignal.timeout(5000));
  assert.deepEqual(result, state);
  assert.deepEqual(names(db.calls), [
    'claim_device_sync',
    'stage_devices',
    'stage_device_batteries',
    'finish_device_sync',
    'purge_device_syncs',
    'purge_device_syncs',
  ]);
  const attempt = db.calls[0].values[2];
  assert.ok(db.calls.slice(1, 4).every((call) => call.values[2] === attempt));
  assert.deepEqual(db.calls[3].values.slice(3), [null, null]);
});

test('telemetry failure still publishes devices', async () => {
  const db = database();
  await new DeviceSync(
    db,
    cipher,
    reader({ batteries: [new GoogleConnectionError('permission-denied')] }),
  ).run(request, AbortSignal.timeout(5000));
  const finish = db.calls.find((call) => call.name === 'finish_device_sync');
  assert.deepEqual(finish.values.slice(3), [null, 'permission-denied']);
});

test('a device page failure records the failure without reading telemetry', async () => {
  const db = database();
  await new DeviceSync(
    db,
    cipher,
    reader({ devices: [[device('d1')], new GoogleConnectionError('permission-denied')] }),
  ).run(request, AbortSignal.timeout(5000));
  assert.equal(names(db.calls).includes('stage_device_batteries'), false);
  const finish = db.calls.find((call) => call.name === 'finish_device_sync');
  assert.deepEqual(finish.values.slice(3), ['permission-denied', null]);
});

test('a second attempt for the same sync stops before Google access', async () => {
  const db = database({ fail: { claim_device_sync: 'device-sync-claimed' } });
  await assert.rejects(
    new DeviceSync(db, cipher, reader()).run(request, AbortSignal.timeout(5000)),
    (error) => error instanceof DeviceSyncError && error.code === 'device-sync-claimed',
  );
  assert.deepEqual(names(db.calls), ['claim_device_sync']);
});

test('a lost lease stops staging and never publishes', async () => {
  const db = database({ fail: { stage_devices: 'device-sync-changed' } });
  await assert.rejects(
    new DeviceSync(db, cipher, reader()).run(request, AbortSignal.timeout(5000)),
    (error) => error instanceof DeviceSyncError && error.code === 'device-sync-changed',
  );
  assert.equal(names(db.calls).includes('finish_device_sync'), false);
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npm exec nx run worker:test --skip-nx-cache`
Expected: FAIL with `Cannot find module` for `device-sync.ts`.

- [ ] **Step 4: Write the sync runner**

Create `worker/src/device-sync.ts`. It uses plain class fields so Node type stripping runs it in tests.

```ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  deviceSyncStateSchema,
  googleCustomerIdSchema,
  type BatteryObservation,
  type DeviceObservation,
  type DeviceSyncState,
} from '@campus/application-contracts';
import {
  CredentialError,
  GoogleConnectionError,
  type CredentialCipher,
  type DelegatedCredential,
} from '@campus/google-connection';

export interface DeviceSyncDatabase {
  query(
    sql: string,
    values: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface DeviceReader {
  devicePages(
    credential: DelegatedCredential,
    customerId: string,
    signal: AbortSignal,
  ): AsyncIterable<DeviceObservation[]>;
  batteryPages(
    credential: DelegatedCredential,
    customerId: string,
    signal: AbortSignal,
  ): AsyncIterable<BatteryObservation[]>;
}

export const deviceSyncRequestSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  syncId: z.uuid(),
  correlationId: z.uuid(),
});
export type DeviceSyncRequest = z.infer<typeof deviceSyncRequestSchema>;

const claimSchema = z.strictObject({
  generation: z.number().int().positive(),
  credentialId: z.uuid(),
  envelope: z.unknown(),
});
const leaseErrors = [
  'device-sync-changed',
  'device-sync-claimed',
  'credential-changed',
  'connection-disconnected',
  'restore-revalidation-required',
];
const purgeBatch = 5000;

export class DeviceSyncError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'DeviceSyncError';
    this.code = code;
  }
}

/** Run one claimed sync. Publication replaces the inventory only after every device page stages. */
export class DeviceSync {
  private readonly database: DeviceSyncDatabase;
  private readonly cipher: Pick<CredentialCipher, 'open'>;
  private readonly reader: DeviceReader;

  constructor(
    database: DeviceSyncDatabase,
    cipher: Pick<CredentialCipher, 'open'>,
    reader: DeviceReader,
  ) {
    this.database = database;
    this.cipher = cipher;
    this.reader = reader;
  }

  private async call(sql: string, values: unknown[]): Promise<unknown> {
    try {
      return (await this.database.query(sql, values)).rows[0]?.['result'];
    } catch (error) {
      const detail = z
        .object({ detail: z.string().optional() })
        .safeParse(error);
      const code = detail.success ? detail.data.detail : undefined;
      throw new DeviceSyncError(
        code && leaseErrors.includes(code) ? code : 'store-unavailable',
      );
    }
  }

  async run(
    request: DeviceSyncRequest,
    signal: AbortSignal,
  ): Promise<DeviceSyncState> {
    const input = deviceSyncRequestSchema.parse(request);
    const lease = [input.customerId, input.syncId, randomUUID()];
    const claim = claimSchema.parse(
      await this.call('SELECT cc.claim_device_sync($1,$2,$3) AS result', lease),
    );
    let failure: string | null = null;
    let telemetryFailure: string | null = null;
    try {
      const credential = this.cipher.open(claim.envelope, {
        recordId: claim.credentialId,
        customerId: input.customerId,
        generation: claim.generation,
      });
      for await (const page of this.reader.devicePages(
        credential,
        input.customerId,
        signal,
      ))
        await this.call('SELECT cc.stage_devices($1,$2,$3,$4) AS result', [
          ...lease,
          JSON.stringify(page),
        ]);
      try {
        for await (const page of this.reader.batteryPages(
          credential,
          input.customerId,
          signal,
        ))
          await this.call(
            'SELECT cc.stage_device_batteries($1,$2,$3,$4) AS result',
            [...lease, JSON.stringify(page)],
          );
      } catch (error) {
        if (!(error instanceof GoogleConnectionError)) throw error;
        telemetryFailure = error.code;
      }
    } catch (error) {
      if (error instanceof DeviceSyncError) throw error;
      failure =
        error instanceof GoogleConnectionError
          ? error.code
          : error instanceof CredentialError
            ? 'key-unavailable'
            : 'request-failed';
    }
    const state = deviceSyncStateSchema.parse(
      await this.call(
        'SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result',
        [...lease, failure, telemetryFailure],
      ),
    );
    for (let removed = purgeBatch; removed === purgeBatch && !signal.aborted; )
      removed = Number(
        await this.call('SELECT cc.purge_device_syncs($1,$2) AS result', [
          input.customerId,
          purgeBatch,
        ]),
      );
    return state;
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npm exec nx run worker:test --skip-nx-cache`
Expected: PASS for all five tests.

- [ ] **Step 6: Wire the worker process**

In `worker/src/google-connection.ts`, move the cipher and pool setup from `read` into one private method, and add `syncDevices`:

```ts
import {
  type CredentialCipher,
  loadCredentialCipher,
  GoogleConnectionProvider,
  GoogleDeviceReader,
  type GoogleReadRequest,
} from '@campus/google-connection';
import { DeviceSync, type DeviceSyncRequest } from './device-sync';
```

```ts
  /** Load the credential key and database pool once per process. */
  private resources(): { pool: Pool; cipher: CredentialCipher } {
    let cipher: CredentialCipher;
    try {
      const path = process.env['CC_CONFIG_FILE'];
      if (!path) throw new Error();
      this.config ??= parseDeploymentConfig(
        JSON.parse(readFileSync(path, 'utf8')),
      );
      const google = this.config.googleConnection;
      if (this.config.phase !== 3 || !google) throw new Error();
      cipher = loadCredentialCipher(google, secret);
    } catch {
      throw new Error('connection-key-unavailable');
    }
    if (!this.pool) {
      // Move the existing `new Pool({...})` construction, try/catch, and `on('error')` handler here unchanged.
    }
    return { pool: this.pool!, cipher };
  }

  async read(input: GoogleReadRequest, signal: AbortSignal) {
    const { pool, cipher } = this.resources();
    return new GoogleConnectionProvider(pool, cipher).read(input, signal);
  }

  async syncDevices(input: DeviceSyncRequest, signal: AbortSignal) {
    const { pool, cipher } = this.resources();
    return new DeviceSync(pool, cipher, new GoogleDeviceReader()).run(input, signal);
  }
```

The comment marks a move of existing code, not new behavior. Keep the pool options exactly as they are.

In `worker/src/dispatch.ts`, extract the bearer and content-type checks from `handleGoogleDispatch` into one helper, and add the device handler:

```ts
import { DeviceSyncError, deviceSyncRequestSchema } from './device-sync';

/** Reject unauthenticated or non-JSON dispatches. Returns true when the response is complete. */
function rejected(
  request: IncomingMessage,
  response: ServerResponse,
  context: DispatchContext,
): boolean {
  if (!authorized(request.headers.authorization, context.secret)) {
    respond(response, 401, { error: 'unauthorized' });
    request.resume();
    return true;
  }
  if (
    request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !==
    'application/json'
  ) {
    respond(response, 415, { error: 'application-json-required' });
    request.resume();
    return true;
  }
  return false;
}

const deviceSyncDispatchSchema = deviceSyncRequestSchema.extend({
  executionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});

export async function handleDeviceSyncDispatch(
  request: IncomingMessage,
  response: ServerResponse,
  context: DispatchContext,
  google: GoogleWorker,
): Promise<boolean> {
  if (request.method !== 'POST' || request.url !== '/dispatch/device-sync')
    return false;
  if (rejected(request, response, context)) return true;
  try {
    const { executionId, ...input } = deviceSyncDispatchSchema.parse(
      await readJson(request),
    );
    const sync = await google.syncDevices(input, context.signal);
    respond(response, 200, {
      executionId,
      correlationId: input.correlationId,
      status: 'completed',
      sync,
    });
  } catch (error) {
    if (error instanceof DispatchError)
      respond(response, error.statusCode, { error: error.code });
    else if (error instanceof z.ZodError)
      respond(response, 400, { error: 'invalid-payload' });
    else if (error instanceof DeviceSyncError)
      respond(response, 409, { error: error.code });
    else respond(response, 503, { error: 'device-sync-unavailable' });
  }
  return true;
}
```

Replace the two inline checks in `handleGoogleDispatch` with `if (rejected(request, response, context)) return true;`.

In `worker/src/main.ts`, import `handleDeviceSyncDispatch` and add this before the 404 response:

```ts
  if (
    await handleDeviceSyncDispatch(
      request,
      response,
      { secret: dispatchSecret, signal: stopping.signal },
      google,
    )
  )
    return;
```

- [ ] **Step 7: Build and lint the worker**

Run: `npm exec nx run-many -t lint build -p worker`
Expected: PASS.

Run: `npm exec nx run worker:test --skip-nx-cache`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add libs/application-contracts/test-register.mjs worker
git commit -m "feat: run device inventory syncs in the worker"
```

---

### Task 5: API device endpoints and the Kestra sync flow

**Files:**
- Create: `deployment/kestra/device-sync.yaml`
- Modify: `api/src/app/orchestration/orchestration.service.ts`
- Create: `api/src/app/devices/device-query.ts`
- Create: `api/src/app/devices/device-query.test.mjs`
- Create: `api/src/app/devices/devices.service.ts`
- Create: `api/src/app/devices/devices.controller.ts`
- Create: `api/src/app/devices/devices.module.ts`
- Modify: `api/src/app/app.module.ts`
- Modify: `api/project.json` (`test` target)

**Interfaces:**
- Consumes: Task 1 schemas, Task 3 functions and tables, the worker dispatch from Task 4.
- Produces HTTP endpoints, all behind `AuthGuard` and `devices:read`:
  - `GET /api/devices/sync` returns `{ sync: DeviceSyncState | null }`.
  - `POST /api/devices/sync` returns `201 { sync: DeviceSyncState }`. It returns `409 {reason}` for `connection-required`, `device-sync-running`, or `connection-changed`, and `503 {reason:'orchestration-unavailable'}` when Kestra rejects the start.
  - `POST /api/devices/query` takes a `DeviceQuery` body and returns `200 { page: DevicePage }`.
  - `GET /api/devices/:deviceId` returns `{ device: DeviceDetail }` or `404 {reason:'device-not-found'}`.
- Produces `OrchestrationService.startDeviceSync({customerId, syncId, correlationId}): Promise<string>`, which returns the Kestra execution ID.

- [ ] **Step 1: Write the failing query-builder test**

In `api/project.json`, add:

```json
    "test": {
      "executor": "nx:run-commands",
      "cache": true,
      "options": {
        "command": "node --import ./libs/application-contracts/test-register.mjs --test api/src/app/devices/*.test.mjs"
      }
    },
```

Create `api/src/app/devices/device-query.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceQuerySchema } from '@campus/application-contracts';
import { deviceDetail, devicePageSql, deviceRow, escapeLike } from './device-query.ts';

const query = (value) => devicePageSql('C0123456', deviceQuerySchema.parse(value));

test('the default page sorts by serial number with a stable tie-break', () => {
  const { rows, count } = query({});
  assert.match(rows.text, /WHERE s\.customer_id=\$1 ORDER BY d\.serial_number ASC NULLS LAST,d\.device_id ASC OFFSET \$2 LIMIT \$3$/);
  assert.deepEqual(rows.values, ['C0123456', 0, 100]);
  assert.deepEqual(count.values, ['C0123456']);
});

test('like wildcards in filter text match literally', () => {
  assert.equal(escapeLike('HS_04%\\'), 'HS\\_04\\%\\\\');
  const { rows } = query({ predicates: [{ field: 'assetTag', operator: 'startsWith', value: 'HS_04%' }] });
  assert.match(rows.text, /d\.asset_tag ILIKE \$2/);
  assert.equal(rows.values[1], 'HS\\_04\\%%');
  const contains = query({ predicates: [{ field: 'notes', operator: 'contains', value: 'a_b' }] });
  assert.equal(contains.rows.values[1], '%a\\_b%');
});

test('filter values never enter the SQL text', () => {
  const hostile = "x'; DROP TABLE cc.devices; --";
  const { rows, count } = query({
    predicates: [
      { field: 'serialNumber', operator: 'equals', value: hostile },
      { field: 'orgUnitPath', operator: 'within', value: `/${hostile}` },
    ],
  });
  assert.equal(rows.text.includes('DROP'), false);
  assert.equal(count.text.includes('DROP'), false);
});

test('organization unit scope includes descendants and treats root as everything', () => {
  const school = query({ predicates: [{ field: 'orgUnitPath', operator: 'within', value: '/School A' }] });
  assert.match(school.rows.text, /\(d\.org_unit_path=\$2 OR d\.org_unit_path LIKE \$3\)/);
  assert.deepEqual(school.rows.values.slice(1, 3), ['/School A', '/School A/%']);
  const root = query({ predicates: [{ field: 'orgUnitPath', operator: 'within', value: '/' }] });
  assert.deepEqual(root.rows.values, ['C0123456', 0, 100]);
});

test('battery filters combine Google classes and missing data with OR', () => {
  const { rows } = query({ predicates: [{ field: 'battery', operator: 'is', values: ['replace-soon', 'no-report'] }] });
  assert.match(rows.text, /\(\(d\.battery_status='reported' AND d\.battery_health=ANY\(\$2::text\[\]\)\) OR d\.battery_status=ANY\(\$3::text\[\]\)\)/);
  assert.deepEqual(rows.values.slice(1, 3), [['replace-soon'], ['no-report']]);
});

test('empty, date, and battery sorts use fixed expressions', () => {
  const empty = query({ predicates: [{ field: 'assetTag', operator: 'isEmpty' }] });
  assert.match(empty.rows.text, /\(d\.asset_tag IS NULL OR d\.asset_tag=''\)/);
  const date = query({ predicates: [{ field: 'lastContact', operator: 'before', value: '2026-10-01T00:00:00Z' }] });
  assert.match(date.rows.text, /d\.last_contact < \$2::timestamptz/);
  const battery = query({ sort: { field: 'battery', direction: 'desc' } });
  assert.match(battery.rows.text, /ORDER BY CASE d\.battery_status .* END DESC NULLS LAST,d\.device_id DESC/);
});

test('rows map database values to the device contract', () => {
  const base = {
    device_id: 'd1',
    serial_number: 'C0A1-7F2D',
    model: 'Lenovo 100e Gen 4',
    asset_tag: 'HS-0417',
    org_unit_path: '/School A',
    last_contact: new Date('2026-10-05T12:00:00Z'),
    annotated_location: null,
    notes: null,
    battery_status: 'reported',
    battery_health: 'replace-soon',
    battery_capacity_percent: 78,
    battery_reported_at: new Date('2026-10-05T11:00:00Z'),
  };
  assert.deepEqual(deviceRow(base).battery, {
    status: 'reported',
    health: 'replace-soon',
    capacityPercent: 78,
    reportedAt: '2026-10-05T11:00:00.000Z',
  });
  assert.equal(deviceRow(base).lastContact, '2026-10-05T12:00:00.000Z');
  assert.deepEqual(deviceRow({ ...base, battery_status: 'unavailable', battery_health: null }).battery, {
    status: 'unavailable',
  });
  const detail = deviceDetail({
    ...base,
    observed_at: new Date('2026-10-05T12:05:00Z'),
    battery_reports: [{ reportedAt: '2026-10-05T11:00:00.000Z', health: 'replace-soon', capacityPercent: 78 }],
  });
  assert.equal(detail.observedAt, '2026-10-05T12:05:00.000Z');
  assert.equal(detail.batteryReports.length, 1);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm exec nx run api:test --skip-nx-cache`
Expected: FAIL with `Cannot find module` for `device-query.ts`.

- [ ] **Step 3: Write the query builder**

Create `api/src/app/devices/device-query.ts`. It imports only the contracts package, so the test runner loads it directly.

```ts
import {
  deviceDetailSchema,
  deviceRowSchema,
  type DeviceDetail,
  type DevicePredicate,
  type DeviceQuery,
  type DeviceRow,
} from '@campus/application-contracts';

const columns = {
  serialNumber: 'd.serial_number',
  model: 'd.model',
  assetTag: 'd.asset_tag',
  orgUnitPath: 'd.org_unit_path',
  lastContact: 'd.last_contact',
  annotatedLocation: 'd.annotated_location',
  notes: 'd.notes',
} as const;
const batteryOrder =
  "CASE d.battery_status WHEN 'reported' THEN CASE d.battery_health WHEN 'replace-now' THEN 0 WHEN 'replace-soon' THEN 1 ELSE 2 END WHEN 'no-report' THEN 3 ELSE 4 END";
const healthValues = new Set(['normal', 'replace-soon', 'replace-now']);
const from =
  'FROM cc.device_sync_state s JOIN cc.devices d ON d.sync_id=s.current_sync_id';

export const deviceColumns =
  'd.device_id,d.serial_number,d.model,d.asset_tag,d.org_unit_path,d.last_contact,d.annotated_location,d.notes,d.battery_status,d.battery_health,d.battery_capacity_percent,d.battery_reported_at';

export interface SqlStatement {
  text: string;
  values: unknown[];
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Field names map to fixed columns. Values travel only as parameters. */
function deviceWhere(
  predicates: readonly DevicePredicate[],
  values: unknown[],
): string {
  const add = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const clauses = ['s.customer_id=$1'];
  for (const predicate of predicates) {
    if (predicate.field === 'orgUnitPath') {
      if (predicate.operator === 'equals')
        clauses.push(`d.org_unit_path=${add(predicate.value)}`);
      else if (predicate.value !== '/')
        clauses.push(
          `(d.org_unit_path=${add(predicate.value)} OR d.org_unit_path LIKE ${add(`${escapeLike(predicate.value)}/%`)})`,
        );
    } else if (predicate.field === 'battery') {
      const health = predicate.values.filter((value) => healthValues.has(value));
      const missing = predicate.values.filter((value) => !healthValues.has(value));
      const parts: string[] = [];
      if (health.length)
        parts.push(
          `(d.battery_status='reported' AND d.battery_health=ANY(${add(health)}::text[]))`,
        );
      if (missing.length)
        parts.push(`d.battery_status=ANY(${add(missing)}::text[])`);
      clauses.push(`(${parts.join(' OR ')})`);
    } else if (predicate.field === 'lastContact') {
      clauses.push(
        `d.last_contact ${predicate.operator === 'before' ? '<' : '>='} ${add(predicate.value)}::timestamptz`,
      );
    } else {
      const column = columns[predicate.field];
      if (predicate.operator === 'isEmpty')
        clauses.push(`(${column} IS NULL OR ${column}='')`);
      else if (predicate.operator === 'equals')
        clauses.push(`lower(${column})=lower(${add(predicate.value)})`);
      else
        clauses.push(
          `${column} ILIKE ${add(
            predicate.operator === 'contains'
              ? `%${escapeLike(predicate.value)}%`
              : `${escapeLike(predicate.value)}%`,
          )}`,
        );
    }
  }
  return clauses.join(' AND ');
}

export function devicePageSql(
  customerId: string,
  query: DeviceQuery,
): { rows: SqlStatement; count: SqlStatement } {
  const values: unknown[] = [customerId];
  const where = deviceWhere(query.predicates, values);
  const order =
    query.sort.field === 'battery' ? batteryOrder : columns[query.sort.field];
  const direction = query.sort.direction === 'desc' ? 'DESC' : 'ASC';
  return {
    rows: {
      text: `SELECT ${deviceColumns} ${from} WHERE ${where} ORDER BY ${order} ${direction} NULLS LAST,d.device_id ${direction} OFFSET $${values.length + 1} LIMIT $${values.length + 2}`,
      values: [...values, query.offset, query.limit],
    },
    count: {
      text: `SELECT count(*)::integer AS matching ${from} WHERE ${where}`,
      values: [...values],
    },
  };
}

export function deviceDetailSql(
  customerId: string,
  deviceId: string,
): SqlStatement {
  return {
    text: `SELECT ${deviceColumns},d.battery_reports,s.observed_at ${from} WHERE s.customer_id=$1 AND d.device_id=$2`,
    values: [customerId, deviceId],
  };
}

const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : (value ?? null);

export function deviceRow(row: Record<string, unknown>): DeviceRow {
  return deviceRowSchema.parse({
    deviceId: row['device_id'],
    serialNumber: row['serial_number'],
    model: row['model'],
    assetTag: row['asset_tag'],
    orgUnitPath: row['org_unit_path'],
    lastContact: iso(row['last_contact']),
    annotatedLocation: row['annotated_location'],
    notes: row['notes'],
    battery:
      row['battery_status'] === 'reported'
        ? {
            status: 'reported',
            health: row['battery_health'],
            capacityPercent: row['battery_capacity_percent'],
            reportedAt: iso(row['battery_reported_at']),
          }
        : { status: row['battery_status'] },
  });
}

export function deviceDetail(row: Record<string, unknown>): DeviceDetail {
  return deviceDetailSchema.parse({
    ...deviceRow(row),
    observedAt: iso(row['observed_at']),
    batteryReports: row['battery_reports'],
  });
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm exec nx run api:test --skip-nx-cache`
Expected: PASS for all seven tests.

- [ ] **Step 5: Add the Kestra flow and orchestration start**

Create `deployment/kestra/device-sync.yaml`:

```yaml
id: device_sync
namespace: campus.application
inputs:
  - id: customerId
    type: STRING
  - id: syncId
    type: STRING
  - id: correlationId
    type: STRING
tasks:
  - id: dispatch
    type: io.kestra.plugin.core.http.Request
    uri: '{{ envs.cc_worker_base_url }}/dispatch/device-sync'
    method: POST
    contentType: application/json
    headers:
      Authorization: "Bearer {{ secret('CC_WORKER_DISPATCH_TOKEN') }}"
    body: |
      {{ {
        "executionId": execution.id,
        "customerId": inputs.customerId,
        "syncId": inputs.syncId,
        "correlationId": inputs.correlationId
      } | json }}
    timeout: PT1H
    options:
      timeout:
        connectTimeout: PT3S
        readIdleTimeout: PT1H
```

In `api/src/app/orchestration/orchestration.service.ts`, extract flow deployment and execution creation from `check` into private methods, keep `check` behavior unchanged, and add `startDeviceSync`:

```ts
  /** Create or update one repository flow before each execution. */
  private async deployFlow(file: string, id: string) {
    const flow = await readFile(
      resolve(process.cwd(), 'deployment/kestra', file),
      'utf8',
    );
    const flowPath = `/api/v1/main/flows/campus.application/${id}`;
    let exists = true;
    try {
      await this.request(flowPath);
    } catch (error) {
      if (error instanceof ServiceResponseError && error.status === 404)
        exists = false;
      else throw error;
    }
    await this.request(
      exists ? flowPath : '/api/v1/main/flows',
      exists ? 'PUT' : 'POST',
      flow,
      'application/x-yaml',
    );
  }

  /** Start one execution. Inputs are validated identifiers without line breaks. */
  private async execute(id: string, inputs: Record<string, string>) {
    const boundary = `cc-${randomUUID()}`;
    const body =
      Object.entries(inputs)
        .map(
          ([name, value]) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        )
        .join('') + `--${boundary}--\r\n`;
    return z
      .object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) })
      .parse(
        JSON.parse(
          await this.request(
            `/api/v1/main/executions/campus.application/${id}`,
            'POST',
            body,
            `multipart/form-data; boundary=${boundary}`,
          ),
        ),
      ).id;
  }

  async startDeviceSync(input: {
    customerId: string;
    syncId: string;
    correlationId: string;
  }): Promise<string> {
    const values = z
      .strictObject({
        customerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        syncId: z.uuid(),
        correlationId: z.uuid(),
      })
      .parse(input);
    await this.deployFlow('device-sync.yaml', 'device_sync');
    return this.execute('device_sync', values);
  }
```

Inside `check`, replace the flow deployment lines with `await this.deployFlow('phase2-connection.yaml', 'phase2_connection');` and the execution creation with `const execution = { id: await this.execute('phase2_connection', { correlationId, marker }) };`. Keep the polling loop unchanged.

- [ ] **Step 6: Write the service, controller, and module**

Create `api/src/app/devices/devices.service.ts`:

```ts
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  devicePageSchema,
  deviceSyncStateSchema,
  type DeviceDetail,
  type DevicePage,
  type DeviceQuery,
  type DeviceSyncState,
  type SessionResponse,
} from '@campus/application-contracts';
import { DatabaseService } from '../database/database.service';
import { OrchestrationService } from '../orchestration/orchestration.service';
import {
  deviceDetail,
  deviceDetailSql,
  devicePageSql,
  deviceRow,
} from './device-query';

const conflicts = ['device-sync-running', 'connection-changed'];

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const parsed = z
    .object({ code: z.string(), detail: z.string().optional() })
    .safeParse(error);
  if (parsed.success && parsed.data.code === '42501')
    throw new ForbiddenException({ reason: 'forbidden' });
  if (
    parsed.success &&
    parsed.data.code === 'P0001' &&
    conflicts.includes(parsed.data.detail ?? '')
  )
    throw new ConflictException({ reason: parsed.data.detail });
  throw new ServiceUnavailableException({ reason: 'device-store-unavailable' });
}

@Injectable()
export class DevicesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly orchestration: OrchestrationService,
  ) {}

  private actor(session: SessionResponse) {
    return [session.identity.id, session.identity.permissionVersion];
  }

  private async result(sql: string, values: unknown[]) {
    try {
      return (await this.database.connection.query(sql, values)).rows[0]?.[
        'result'
      ];
    } catch (error) {
      translate(error);
    }
  }

  async sync(session: SessionResponse): Promise<DeviceSyncState | null> {
    return deviceSyncStateSchema
      .nullable()
      .parse(
        await this.result(
          'SELECT cc.read_device_sync($1,$2) AS result',
          this.actor(session),
        ),
      );
  }

  async requestSync(
    session: SessionResponse,
    current: DeviceSyncState,
    correlationId: string,
  ): Promise<DeviceSyncState> {
    const syncId = randomUUID();
    const started = deviceSyncStateSchema.parse(
      await this.result(
        'SELECT cc.request_device_sync($1,$2,$3,$4,$5,$6) AS result',
        [
          ...this.actor(session),
          current.customerId,
          current.generation,
          syncId,
          correlationId,
        ],
      ),
    );
    try {
      await this.orchestration.startDeviceSync({
        customerId: current.customerId,
        syncId,
        correlationId,
      });
    } catch {
      await this.result(
        'SELECT cc.abandon_device_sync($1,$2,$3,$4,$5) AS result',
        [...this.actor(session), current.customerId, syncId, 'orchestration-unavailable'],
      );
      throw new ServiceUnavailableException({
        reason: 'orchestration-unavailable',
      });
    }
    return started;
  }

  /** Check authority and read in one transaction. The check takes no locks. */
  private async read<T>(
    session: SessionResponse,
    run: (client: PoolClient, customerId: string) => Promise<T>,
    empty: T,
  ): Promise<T> {
    try {
      return await this.database.transaction(async (client) => {
        const customerId = (
          await client.query(
            'SELECT (cc.device_reader($1,$2)).customer_id AS customer_id',
            this.actor(session),
          )
        ).rows[0]?.['customer_id'];
        return typeof customerId === 'string'
          ? run(client, customerId)
          : empty;
      });
    } catch (error) {
      translate(error);
    }
  }

  async page(session: SessionResponse, query: DeviceQuery): Promise<DevicePage> {
    return this.read(
      session,
      async (client, customerId) => {
        const state = (
          await client.query(
            'SELECT device_count,observed_at FROM cc.device_sync_state WHERE customer_id=$1',
            [customerId],
          )
        ).rows[0];
        const sql = devicePageSql(customerId, query);
        const matching = (await client.query(sql.count.text, sql.count.values))
          .rows[0]?.['matching'];
        const rows = (await client.query(sql.rows.text, sql.rows.values)).rows;
        return devicePageSchema.parse({
          rows: rows.map(deviceRow),
          matching: matching ?? 0,
          total: state?.['device_count'] ?? 0,
          observedAt:
            state?.['observed_at'] instanceof Date
              ? state['observed_at'].toISOString()
              : null,
        });
      },
      { rows: [], matching: 0, total: 0, observedAt: null },
    );
  }

  async device(
    session: SessionResponse,
    deviceId: string,
  ): Promise<DeviceDetail> {
    const found = await this.read(
      session,
      async (client, customerId) => {
        const sql = deviceDetailSql(customerId, deviceId);
        const row = (await client.query(sql.text, sql.values)).rows[0];
        return row ? deviceDetail(row) : null;
      },
      null,
    );
    if (!found) throw new NotFoundException({ reason: 'device-not-found' });
    return found;
  }
}
```

Create `api/src/app/devices/devices.controller.ts`:

```ts
import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { deviceQuerySchema } from '@campus/application-contracts';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { DevicesService } from './devices.service';

const deviceIdSchema = z.string().min(1).max(128);

@Controller('api/devices')
@UseGuards(AuthGuard)
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly auth: AuthService,
  ) {}

  /** Resolve the connected customer, then require devices:read for it. */
  private async current(request: AuthenticatedRequest) {
    const sync = await this.devices.sync(request.session);
    if (sync)
      await this.auth.authorize(
        request.session,
        'devices:read',
        { kind: 'district', customerId: sync.customerId },
        request.correlationId,
      );
    return sync;
  }

  @Get('sync')
  async sync(@Req() request: AuthenticatedRequest) {
    return { sync: await this.current(request) };
  }

  @Post('sync')
  async requestSync(@Req() request: AuthenticatedRequest) {
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    return {
      sync: await this.devices.requestSync(
        request.session,
        current,
        request.correlationId,
      ),
    };
  }

  @Post('query')
  @HttpCode(200)
  async query(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = deviceQuerySchema.parse(body);
    await this.current(request);
    return { page: await this.devices.page(request.session, input) };
  }

  @Get(':deviceId')
  async device(
    @Req() request: AuthenticatedRequest,
    @Param('deviceId') deviceId: string,
  ) {
    const id = deviceIdSchema.parse(deviceId);
    await this.current(request);
    return { device: await this.devices.device(request.session, id) };
  }
}
```

Create `api/src/app/devices/devices.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConfigurationModule } from '../configuration/configuration.module';
import { DatabaseModule } from '../database/database.module';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

@Module({
  imports: [AuthModule, ConfigurationModule, DatabaseModule, OrchestrationModule],
  controllers: [DevicesController],
  providers: [DevicesService],
})
export class DevicesModule {}
```

In `api/src/app/app.module.ts`, add `DevicesModule` to the `imports` array after `DiagnosticsModule`.

Invalid request bodies return 400 through the existing `ZodError` handling in `api/src/app/security.ts`.

- [ ] **Step 7: Build, lint, and test the API**

Run: `npm exec nx run-many -t lint build test -p api`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add api deployment/kestra/device-sync.yaml
git commit -m "feat: serve device inventory and start syncs through Kestra"
```

---

### Task 6: Simulated devices and the end-to-end device check

**Files:**
- Modify: `api-e2e/google-connection-preload.cjs` (device and telemetry endpoints, tokens, and faults)
- Create: `api-e2e/devices-api.mjs`
- Modify: `api-e2e/auth.test.mjs` (run the device check after `qualifySchoolReferencesApi`)

**Interfaces:**
- Consumes: every earlier task, end to end through the real API, Kestra, worker, and PostgreSQL.
- Produces: 450 deterministic simulated devices for review and tests. `serialNumber` is `C0A1-` plus a four-digit hexadecimal index. `assetTag` is `HS-` plus `400 + index`, except every 25th device has none. Devices rotate through `/School A`, `/School B`, and `/`. Battery capacity rotates through 92%, 78%, and 72% of 5000 mAh. Every tenth device, at index 9, 19, and so on, has no telemetry. Fault modes `device-privilege-denied` and `telemetry-privilege-denied` use the existing `google-health-fault.json` file.

- [ ] **Step 1: Write the failing end-to-end check**

Create `api-e2e/devices-api.mjs`:

```js
import { evidenceSecurity } from './evidence-security.mjs';
import { qualificationSignIn } from './qualification-sign-in.mjs';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

export async function qualifyDevicesApi({
  browser,
  publicOrigin,
  directory,
  evidenceDirectory,
  setSubject,
}) {
  const context = await evidenceSecurity.newContext(browser, {
    ignoreHTTPSErrors: true,
  });
  const faultPath = join(directory, 'google-health-fault.json');
  try {
    setSubject('administrator');
    const page = await context.newPage();
    await qualificationSignIn(page, publicOrigin, evidenceDirectory, 'devices');
    const api = context.request;
    const session = await (await api.get(`${publicOrigin}/api/auth/session`)).json();
    evidenceSecurity.register('csrf-token', session.csrfToken);
    const headers = { origin: publicOrigin, 'x-csrf-token': session.csrfToken };
    const root = `${publicOrigin}/api/devices`;
    const sync = async () => {
      const response = await api.get(`${root}/sync`);
      assert.equal(response.status(), 200, await response.text());
      return (await response.json()).sync;
    };
    const run = async () => {
      const response = await api.post(`${root}/sync`, { headers, data: {} });
      assert.equal(response.status(), 201, await response.text());
      for (let attempt = 0; attempt < 240; attempt++) {
        const state = await sync();
        if (state.status !== 'running') return state;
        await setTimeout(500);
      }
      throw new Error('The device sync did not settle.');
    };
    const query = async (data) => {
      const response = await api.post(`${root}/query`, { headers, data });
      assert.equal(response.status(), 200, await response.text());
      return (await response.json()).page;
    };
    const fault = (mode) => writeFile(faultPath, JSON.stringify({ mode }));

    assert.equal((await sync()).status, 'never');
    assert.equal((await api.post(`${root}/sync`, { data: {} })).status(), 403);
    assert.equal((await api.post(`${root}/query`, { headers, data: { limit: 500 } })).status(), 400);

    const ready = await run();
    assert.equal(ready.status, 'ready');
    assert.equal(ready.deviceCount, 450);
    assert.equal(ready.telemetryFailure, null);
    const first = await query({});
    assert.equal(first.total, 450);
    assert.equal(first.matching, 450);
    assert.equal(first.rows.length, 100);
    assert.equal(first.rows[0].serialNumber, 'C0A1-0000');
    assert.equal(JSON.stringify(first).includes('envelope'), false);
    assert.equal(
      (await query({ predicates: [{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }] })).matching,
      96,
    );
    assert.equal(
      (await query({ predicates: [{ field: 'battery', operator: 'is', values: ['replace-soon'] }] })).matching,
      135,
    );
    assert.equal(
      (await query({ predicates: [{ field: 'orgUnitPath', operator: 'within', value: '/School A' }] })).matching,
      150,
    );
    const detail = await (await api.get(`${root}/synthetic-device-1`)).json();
    assert.deepEqual(
      { health: detail.device.battery.health, capacity: detail.device.battery.capacityPercent },
      { health: 'replace-soon', capacity: 78 },
    );
    assert.equal(detail.device.batteryReports.length, 3);
    assert.equal((await api.get(`${root}/synthetic-device-9`)).ok(), true);
    assert.equal(
      (await (await api.get(`${root}/synthetic-device-9`)).json()).device.battery.status,
      'no-report',
    );
    assert.equal((await api.get(`${root}/missing-device`)).status(), 404);

    await fault('telemetry-privilege-denied');
    const blind = await run();
    assert.equal(blind.status, 'ready');
    assert.equal(blind.telemetryFailure, 'permission-denied');
    assert.equal(
      (await query({ predicates: [{ field: 'battery', operator: 'is', values: ['unavailable'] }] })).matching,
      450,
    );

    await fault('device-privilege-denied');
    const failed = await run();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failure, 'permission-denied');
    assert.equal(failed.stale, true);
    assert.equal((await query({})).total, 450);
    return [
      'device sync runs through Kestra and the worker and publishes 450 simulated devices: pass',
      'device filters match asset tag, battery class, and organization unit counts: pass',
      'device details include Google battery class, capacity, and recent reports: pass',
      'telemetry denial publishes devices with unavailable battery data: pass',
      'inventory denial keeps the published devices and marks them stale: pass',
    ];
  } finally {
    await rm(faultPath, { force: true });
    await context.close();
  }
}
```

In `api-e2e/auth.test.mjs`, import `qualifyDevicesApi` from `./devices-api.mjs`. Add this block directly after the `qualifySchoolReferencesApi` block:

```js
      if (applicationPhase === 3)
        await qualifyDevicesApi({
          browser,
          publicOrigin,
          directory,
          evidenceDirectory,
          setSubject: (value) => {
            subject = value;
          },
        });
```

The expected counts follow from the fixture formula. Asset tags `HS-0400` through `HS-0499` cover indexes 0–99. Indexes 0, 25, 50, and 75 have none, which leaves 96. "Replace soon" covers indexes where `index % 3 === 1`, 150 devices. Fifteen of those fall on `index % 10 === 9` and have no telemetry, which leaves 135.

- [ ] **Step 2: Run the check and confirm it fails**

Run: `npm exec nx run api-e2e:phase3-auth-integration`
Expected: FAIL. `GET /api/devices/sync` returns 200, but the sync fails because the simulator throws `Unexpected synthetic Google endpoint.` for device requests.

- [ ] **Step 3: Simulate devices and telemetry**

In `api-e2e/google-connection-preload.cjs`:

1. Add the fleet definition after the `require` lines:

```js
const models = [
  'Lenovo 100e Gen 4',
  'Acer Chromebook 311',
  'HP Chromebook 11 G9',
  'Lenovo 300e Gen 3',
  'Acer Chromebook Spin 511',
];
const capacities = [4600, 3900, 3600];
const healthFor = (capacity) =>
  capacity / 5000 > 0.8
    ? 'BATTERY_HEALTH_NORMAL'
    : capacity / 5000 >= 0.75
      ? 'BATTERY_REPLACE_SOON'
      : 'BATTERY_REPLACE_NOW';
const fleet = Array.from({ length: 450 }, (_, index) => ({
  deviceId: `synthetic-device-${index}`,
  serialNumber: `C0A1-${index.toString(16).toUpperCase().padStart(4, '0')}`,
  model: models[index % models.length],
  ...(index % 25 === 0 ? {} : { annotatedAssetId: `HS-${String(400 + index).padStart(4, '0')}` }),
  orgUnitPath: ['/School A', '/School B', '/'][index % 3],
  lastSync: new Date(Date.UTC(2026, 9, 5, 16) - index * 60_000).toISOString(),
  ...(index % 4 === 0 ? { annotatedLocation: 'Science wing' } : {}),
  ...(index === 0 ? { notes: 'Review battery during support visit' } : {}),
  status: 'ACTIVE',
  capacity: index % 10 === 9 ? null : capacities[index % 3],
}));
const telemetry = ({ deviceId, capacity }) =>
  capacity === null
    ? { deviceId }
    : {
        deviceId,
        batteryInfo: [{ designCapacity: '5000' }],
        batteryStatusReport: [0, 1, 2].map((day) => ({
          reportTime: new Date(Date.UTC(2026, 9, 5 - day, 13, 50)).toISOString(),
          fullChargeCapacity: String(capacity + day * 10),
          batteryHealth: healthFor(capacity + day * 10),
        })),
      };
const pageOf = (options, url, size) => {
  const start = Number(options.params?.pageToken ?? url.searchParams.get('pageToken') ?? 0);
  const items = fleet.slice(start, start + size);
  return { items, next: start + size < fleet.length ? String(start + size) : undefined };
};
const forbidden = (options) => ({
  response: {
    config: options,
    status: 403,
    data: {
      error: {
        errors: [{ reason: 'forbidden' }],
        privateDiagnostic: 'synthetic-private-provider-diagnostic',
      },
    },
  },
});
```

2. Add `'chromemanagement.googleapis.com'` to the hostname list at the top of the patched `request`.

3. In the `/token` branch, add two cases before the domain-token fallback of the `access_token` expression:

```js
          : scope.endsWith('device.chromeos.readonly')
            ? 'synthetic-device-token'
            : scope.endsWith('telemetry.readonly')
              ? 'synthetic-telemetry-token'
```

4. In the `/tokeninfo` branch, add two cases before the final fallback:

```js
          : authorization === 'Bearer synthetic-device-token'
            ? 'https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly'
            : authorization === 'Bearer synthetic-telemetry-token'
              ? 'https://www.googleapis.com/auth/chrome.management.telemetry.readonly'
```

5. Before the final `else throw new Error('Unexpected synthetic Google endpoint.')`, add:

```js
  else if (url.pathname === '/admin/directory/v1/customer/C0123456/devices/chromeos') {
    if (fault === 'device-privilege-denied') throw forbidden(options);
    const { items, next } = pageOf(options, url, 300);
    data = {
      chromeosdevices: items.map(({ capacity: _capacity, ...device }) => device),
      ...(next ? { nextPageToken: next } : {}),
    };
  } else if (
    url.hostname === 'chromemanagement.googleapis.com' &&
    url.pathname === '/v1/customers/C0123456/telemetry/devices'
  ) {
    if (fault === 'telemetry-privilege-denied') throw forbidden(options);
    const { items, next } = pageOf(options, url, Number(options.params?.pageSize ?? 100));
    data = { devices: items.map(telemetry), ...(next ? { nextPageToken: next } : {}) };
  }
```

- [ ] **Step 4: Run the check and confirm it passes**

Run the same target as Step 2.
Expected: PASS, with the five device lines in the output.

Run: `npm exec nx run api-e2e:client-review`. Sign in, open `https://<printed host>/api/devices/sync` in the browser, and confirm the JSON shows the device sync state. Stop the command with Ctrl+C.

- [ ] **Step 5: Commit**

```bash
git add api-e2e
git commit -m "test: simulate ChromeOS devices and qualify the device API end to end"
```

---

## After this plan

- Write the Devices UI plan from the same workflow record. It brings in the `entity-grid` component from local commit `ae8ca2c` on `codex/phase-2-workspace-snapshot`. That commit conflicts only in `package.json` and `package-lock.json`.
- For live checks, the owner adds both device scopes to the delegation client in the Google Admin Console. The Easton fixture then supports a read-only device sync. An empty device list is a valid result.
