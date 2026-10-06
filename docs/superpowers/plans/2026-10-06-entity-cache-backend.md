# Entity Cache Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the whole-inventory device snapshot with one row per device that carries its last Google read time, refresh stale devices in parallel Kestra batches, and have the worker fill the Redis entity cache and publish refresh events.

**Architecture:** Migration 016 is rewritten: `cc.devices` becomes `(customer_id, device_id)` with `last_entity_sync` and `removed_at`, and `cc.entity_sync_jobs` holds the ID list of each refresh job. A grid query that returns stale rows creates a job, adds the IDs to a Redis in-flight set, and starts the `entity_sync` Kestra flow. The flow runs batches in parallel. Each batch runner reads devices through the Directory batch endpoint, upserts Postgres, writes the rows to Redis, publishes an `entity-batch` event, and records the batch. The full sync keeps its lease protocol, soft-deletes devices that Google stopped returning, fills Redis, bumps the query generation, and publishes a `full-sync` event. The API still serves grid pages from Postgres and still polls. The query cache, `by-ids`, SSE, and the grid UI follow in the second plan.

**Tech Stack:** PostgreSQL functions (SECURITY DEFINER), NestJS, `redis` 5.11.0, `node:test`, Zod 4, Kestra 1.3.37 core `ForEach`, Google Directory API batch endpoint, Chrome Management telemetry `get`, Angular 22 (contract adaptation only), Playwright (existing e2e harness).

**Spec:** [docs/superpowers/specs/2026-10-06-entity-cache-decisions.md](../specs/2026-10-06-entity-cache-decisions.md), decisions D3, D4, D5, D8, D9, D10 (generation bump only), D13, D14, D15. The workflow is [docs/workflows/device-browsing.md](../../workflows/device-browsing.md). Plan B (query cache, `by-ids`, SSE, grid UI) implements D1, D2, D6, D7, D11, D12 after this plan lands.

## Global Constraints

- Branch `codex/entity-cache`. Development data is disposable: rewrite `016-device-inventory.sql` in place. Do not add a migration 017.
- Entity type is `'device'` only. Names, keys, events, and the threshold map are generic. Code is device-specific. No abstract base classes or registries (D14).
- Freshness threshold: 24 hours for devices, a code constant evaluated at read time (D8). Redis entity TTL equals the threshold (D9).
- Redis keys: `cc:entity:{type}:{customer}:{id}`, `cc:query-gen:{type}:{customer}`, `cc:entity-inflight:{type}:{customer}`. Channel: `cc:entity-events:{customer}`. Redis stores the device record without the `stale` flag. Readers add `stale` at read time.
- Batch size 100. Kestra runs at most 4 batches concurrently. The in-flight set expires after 120 seconds.
- Worker logic owns Google outcomes: 404 soft-deletes that device, `quota` retries with backoff until success or shutdown, every other error fails the batch with the existing failure vocabulary. Kestra retry covers only a dead batch runner (D15).
- Nothing is hard-deleted. `removed_at` marks a device Google no longer returns. Grid queries exclude removed devices. The detail read returns them with `removedAt`.
- Directory batch endpoint: `https://www.googleapis.com/batch/admin/directory_v1`, at most 1,000 calls per request, each inner call counts against quota. Telemetry uses `customers.telemetry.devices.get` per device, 4 at a time.
- Redis ACL: the API keeps `default`. The worker authenticates as user `worker` with the same password and a narrower ACL (D13).
- Call the API only through existing Nest services. Keep every `cc.*` function `SECURITY DEFINER` with `search_path=pg_catalog,cc`. Repository prose follows the writing rules in `AGENTS.md`.
- Run tasks through Nx: `npm exec -- nx run <project>:<target> --skip-nx-cache`. Single test files run with the same command the target wraps: `node --import ./libs/application-contracts/test-register.mjs --test <file>`.

## Review Focus

1. **A device that Google returns in an entity batch after a full sync soft-deleted it.** The upsert must clear `removed_at`, so the device reappears. Test: Task 2 integration (`upsert clears removed_at`).
2. **A batch runner that Kestra re-dispatches after a crash.** `finish_entity_sync_batch` must count that batch once. Test: Task 2 integration (`finishing a batch twice counts once`).
3. **A full sync whose last page fails.** No soft-delete scan runs, `observed_at` stays, and the previous rows remain. Test: Task 2 integration (`a failed full sync removes nothing`).
4. **A quota error on the second batch of a job.** The worker backs off and retries that batch only; the other batches finish. Test: Task 4 (`quota errors retry until Google answers`).
5. **Two grid queries that overlap within two minutes.** The second query dispatches only IDs the first did not. Test: Task 7 (`overlapping stale queries dispatch each device once`).

---

### Task 1: Freshness contracts, entity sync job, and events

**Files:**
- Create: `libs/application-contracts/src/lib/entity-cache.ts`
- Create: `libs/application-contracts/src/lib/entity-cache.test.mjs`
- Modify: `libs/application-contracts/src/lib/devices.ts`
- Modify: `libs/application-contracts/src/lib/devices.test.mjs`
- Modify: `libs/application-contracts/src/index.ts`

**Interfaces:**
- Produces, from `@campus/application-contracts`:
  - `entityTypeSchema`, type `EntityType = 'device'`.
  - `ENTITY_FRESHNESS_HOURS: Record<EntityType, number>` (`{ device: 24 }`), `ENTITY_SYNC_BATCH_SIZE = 100`, `ENTITY_INFLIGHT_SECONDS = 120`, `ENTITY_CACHE_SECONDS: Record<EntityType, number>` (`{ device: 86400 }`).
  - `freshnessCutoff(type, now = Date.now()): Date` and `isStale(type, lastEntitySync: string, now = Date.now()): boolean`.
  - `entityKey(type, customerId, id)`, `queryGenerationKey(type, customerId)`, `inflightKey(type, customerId)`, `entityEventsChannel(customerId)`.
  - `entitySyncJobSchema`, type `EntitySyncJob = { jobId; customerId; entityType; batchCount; completedBatches; failedBatches; failure: DeviceSyncFailure | null; createdAt; finishedAt: string | null }`.
  - `entitySyncBatchRequestSchema`, type `EntitySyncBatchRequest = { customerId; jobId; batch: number; correlationId }`. `batch` coerces from a string because Kestra passes loop values as text.
  - `entityEventSchema`, type `EntityEvent`: `{ type: 'entity-batch'; jobId; entityType; batch; batchCount; deviceIds: string[]; removedIds: string[] } | { type: 'job-finished'; job: EntitySyncJob } | { type: 'full-sync'; sync: DeviceSyncState }`.
  - `deviceRecordSchema`, type `DeviceRecord`: the row shape plus `lastEntitySync`, without `stale`. This is what Redis stores.
  - `deviceRowSchema` = record plus `stale: boolean`. `deviceDetailSchema` = row plus `removedAt: string | null` and `batteryReports`. `observedAt` leaves the detail.
  - `devicePageSchema` gains `refreshJobId: string | null`.

- [ ] **Step 1: Write the failing contract tests**

Create `libs/application-contracts/src/lib/entity-cache.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENTITY_FRESHNESS_HOURS,
  entityEventSchema,
  entityKey,
  entitySyncBatchRequestSchema,
  entitySyncJobSchema,
  freshnessCutoff,
  inflightKey,
  isStale,
  queryGenerationKey,
  entityEventsChannel,
} from './entity-cache.ts';

const now = Date.parse('2026-10-06T12:00:00.000Z');

test('devices are stale 24 hours after their last Google read', () => {
  assert.equal(ENTITY_FRESHNESS_HOURS.device, 24);
  assert.equal(
    freshnessCutoff('device', now).toISOString(),
    '2026-10-05T12:00:00.000Z',
  );
  assert.equal(isStale('device', '2026-10-05T12:00:00.000Z', now), false);
  assert.equal(isStale('device', '2026-10-05T11:59:59.999Z', now), true);
});

test('redis names carry the entity type and customer', () => {
  assert.equal(entityKey('device', 'C0123456', 'd1'), 'cc:entity:device:C0123456:d1');
  assert.equal(queryGenerationKey('device', 'C0123456'), 'cc:query-gen:device:C0123456');
  assert.equal(inflightKey('device', 'C0123456'), 'cc:entity-inflight:device:C0123456');
  assert.equal(entityEventsChannel('C0123456'), 'cc:entity-events:C0123456');
});

test('batch requests coerce the Kestra loop value to a number', () => {
  const request = entitySyncBatchRequestSchema.parse({
    customerId: 'C0123456',
    jobId: '7f5f3b2e-2d4e-4f7a-9b1a-1c2d3e4f5a6b',
    batch: '3',
    correlationId: '7f5f3b2e-2d4e-4f7a-9b1a-1c2d3e4f5a6c',
  });
  assert.equal(request.batch, 3);
  assert.equal(entitySyncBatchRequestSchema.safeParse({ ...request, batch: -1 }).success, false);
});

test('events are a discriminated union', () => {
  const job = {
    jobId: '7f5f3b2e-2d4e-4f7a-9b1a-1c2d3e4f5a6b',
    customerId: 'C0123456',
    entityType: 'device',
    batchCount: 2,
    completedBatches: 1,
    failedBatches: 1,
    failure: 'quota',
    createdAt: '2026-10-06T12:00:00.000Z',
    finishedAt: '2026-10-06T12:01:00.000Z',
  };
  assert.deepEqual(entitySyncJobSchema.parse(job), job);
  assert.equal(entityEventSchema.parse({ type: 'job-finished', job }).type, 'job-finished');
  assert.equal(
    entityEventSchema.parse({
      type: 'entity-batch',
      jobId: job.jobId,
      entityType: 'device',
      batch: 0,
      batchCount: 2,
      deviceIds: ['d1'],
      removedIds: [],
    }).deviceIds[0],
    'd1',
  );
  assert.equal(entityEventSchema.safeParse({ type: 'other' }).success, false);
});
```

In `libs/application-contracts/src/lib/devices.test.mjs`, change the `row` fixture to include the new fields and add one test:

```js
const row = {
  deviceId: 'd1',
  serialNumber: 'C0A1-7F2D',
  model: null,
  assetTag: null,
  orgUnitPath: '/',
  lastContact: null,
  annotatedLocation: null,
  notes: null,
  lastEntitySync: '2026-10-05T12:00:00.000Z',
  stale: false,
};
```

Append:

```js
test('rows carry freshness and details carry removal', () => {
  const parsed = deviceRowSchema.parse({ ...row, battery: { status: 'no-report' } });
  assert.equal(parsed.stale, false);
  assert.equal(deviceRowSchema.safeParse({ ...row, battery: { status: 'no-report' }, stale: undefined }).success, false);
  const detail = deviceDetailSchema.parse({
    ...row,
    battery: { status: 'no-report' },
    removedAt: null,
    batteryReports: [],
  });
  assert.equal(detail.removedAt, null);
  assert.equal('observedAt' in detail, false);
  assert.equal(
    devicePageSchema.parse({ rows: [], matching: 0, total: 0, observedAt: null, refreshJobId: null }).refreshJobId,
    null,
  );
});
```

Add `deviceDetailSchema` and `devicePageSchema` to that file's import from `./devices.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import ./libs/application-contracts/test-register.mjs --test libs/application-contracts/src/lib/entity-cache.test.mjs libs/application-contracts/src/lib/devices.test.mjs`
Expected: FAIL. `entity-cache.ts` does not exist. The row fixture fails `strictObject` with unknown keys.

- [ ] **Step 3: Write the contracts**

Create `libs/application-contracts/src/lib/entity-cache.ts`:

```ts
import * as z from 'zod';
import { googleCustomerIdSchema } from './google-connection';
import { deviceSyncFailureSchema, deviceSyncStateSchema } from './devices';

const timestamp = z.iso.datetime({ offset: true });
const deviceId = z.string().min(1).max(128);
const count = z.number().int().min(0);

export const entityTypeSchema = z.enum(['device']);
export type EntityType = z.infer<typeof entityTypeSchema>;

/** Hours after the last Google read when an entity counts as stale. Evaluated at read time. */
export const ENTITY_FRESHNESS_HOURS: Readonly<Record<EntityType, number>> = {
  device: 24,
};
/** Redis keeps a record as long as it stays fresh. */
export const ENTITY_CACHE_SECONDS: Readonly<Record<EntityType, number>> = {
  device: ENTITY_FRESHNESS_HOURS.device * 3600,
};
/** Devices per Kestra batch. The Directory batch endpoint allows 1,000. */
export const ENTITY_SYNC_BATCH_SIZE = 100;
/** Seconds an ID waits in the in-flight set when no batch removes it. */
export const ENTITY_INFLIGHT_SECONDS = 120;

export function freshnessCutoff(type: EntityType, now = Date.now()): Date {
  return new Date(now - ENTITY_FRESHNESS_HOURS[type] * 3_600_000);
}

export function isStale(
  type: EntityType,
  lastEntitySync: string,
  now = Date.now(),
): boolean {
  return Date.parse(lastEntitySync) < freshnessCutoff(type, now).getTime();
}

export const entityKey = (type: EntityType, customerId: string, id: string) =>
  `cc:entity:${type}:${customerId}:${id}`;
export const queryGenerationKey = (type: EntityType, customerId: string) =>
  `cc:query-gen:${type}:${customerId}`;
export const inflightKey = (type: EntityType, customerId: string) =>
  `cc:entity-inflight:${type}:${customerId}`;
export const entityEventsChannel = (customerId: string) =>
  `cc:entity-events:${customerId}`;

export const entitySyncJobSchema = z.strictObject({
  jobId: z.uuid(),
  customerId: googleCustomerIdSchema,
  entityType: entityTypeSchema,
  batchCount: z.number().int().min(1),
  completedBatches: count,
  failedBatches: count,
  failure: deviceSyncFailureSchema.nullable(),
  createdAt: timestamp,
  finishedAt: timestamp.nullable(),
});
export type EntitySyncJob = z.infer<typeof entitySyncJobSchema>;

/** One Kestra batch dispatch. Kestra passes loop values as text. */
export const entitySyncBatchRequestSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  jobId: z.uuid(),
  batch: z.coerce.number().int().min(0),
  correlationId: z.uuid(),
});
export type EntitySyncBatchRequest = z.infer<typeof entitySyncBatchRequestSchema>;

export const entityEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('entity-batch'),
    jobId: z.uuid(),
    entityType: entityTypeSchema,
    batch: count,
    batchCount: z.number().int().min(1),
    deviceIds: z.array(deviceId).max(1000),
    removedIds: z.array(deviceId).max(1000),
  }),
  z.strictObject({ type: z.literal('job-finished'), job: entitySyncJobSchema }),
  z.strictObject({ type: z.literal('full-sync'), sync: deviceSyncStateSchema }),
]);
export type EntityEvent = z.infer<typeof entityEventSchema>;
```

In `libs/application-contracts/src/lib/devices.ts`, replace the `rowShape` block through `deviceDetailSchema` with:

```ts
const recordShape = {
  deviceId,
  serialNumber: z.string().max(256),
  model: z.string().max(256).nullable(),
  assetTag: z.string().max(256).nullable(),
  orgUnitPath,
  lastContact: timestamp.nullable(),
  annotatedLocation: z.string().max(4096).nullable(),
  notes: z.string().max(4096).nullable(),
  battery: deviceBatterySchema,
  /** When Campus Commander last read this device from Google. */
  lastEntitySync: timestamp,
};
/** One device as Redis stores it. Readers add `stale` at read time. */
export const deviceRecordSchema = z.strictObject(recordShape);
export type DeviceRecord = z.infer<typeof deviceRecordSchema>;

export const deviceRowSchema = z.strictObject({
  ...recordShape,
  stale: z.boolean(),
});
export type DeviceRow = z.infer<typeof deviceRowSchema>;

export const deviceDetailSchema = z.strictObject({
  ...recordShape,
  stale: z.boolean(),
  /** Set when Google no longer returns the device. The row stays in the database. */
  removedAt: timestamp.nullable(),
  batteryReports: z.array(batteryReportSchema).max(30),
});
export type DeviceDetail = z.infer<typeof deviceDetailSchema>;
```

In `devicePageSchema`, add after `observedAt`:

```ts
  /** The refresh job this page started for its stale devices, when one started. */
  refreshJobId: z.uuid().nullable(),
```

In `libs/application-contracts/src/index.ts`, append `export * from './lib/entity-cache';`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm exec -- nx run application-contracts:test --skip-nx-cache`
Expected: PASS for `entity-cache.test.mjs` and `devices.test.mjs`. Other contract tests are unchanged.

- [ ] **Step 5: Commit**

```bash
git add libs/application-contracts
git commit -m "feat: add entity freshness contracts and sync job events"
```

---

### Task 2: Rewrite migration 016 for one row per device

**Files:**
- Modify: `deployment/postgres/migrations/016-device-inventory.sql` (full rewrite)
- Modify: `deployment/postgres/index.mjs:249-260` (grants)
- Modify: `deployment/postgres/device-inventory.integration.mjs` (full rewrite)

**Interfaces:**
- Produces these `cc.*` functions. Unchanged signatures: `device_reader(uuid,integer)`, `device_sync_projection(text)`, `read_device_sync(uuid,integer)`, `request_device_sync(uuid,integer,text,integer,uuid,uuid)`, `abandon_device_sync(uuid,integer,text,uuid,text)`, `claim_device_sync(text,uuid,uuid)`, `device_sync_lease(text,uuid,uuid)`, `stage_devices(text,uuid,uuid,jsonb)`, `stage_device_batteries(text,uuid,uuid,jsonb)`, `finish_device_sync(text,uuid,uuid,text,text)`.
- New: `device_record(cc.devices,text) RETURNS jsonb` (one `DeviceRecord` plus `removedAt`), `upsert_devices(text,jsonb,timestamptz) RETURNS integer`, `upsert_device_batteries(text,jsonb) RETURNS integer`, `soft_delete_devices(text,jsonb) RETURNS integer`, `read_device_records(text,jsonb) RETURNS jsonb`, `page_device_records(text,text,integer) RETURNS jsonb`, `create_entity_sync_job(uuid,integer,text,text,jsonb,integer,uuid,uuid) RETURNS jsonb`, `abandon_entity_sync_job(uuid,integer,text,uuid) RETURNS jsonb`, `read_entity_sync_batch(text,uuid,integer) RETURNS jsonb`, `finish_entity_sync_batch(text,uuid,integer,text) RETURNS jsonb`, `purge_entity_sync_jobs(text,integer) RETURNS integer`.
- Removed: `purge_device_syncs`. Tables: `cc.devices(customer_id, device_id, …, last_entity_sync, removed_at)`, `cc.entity_sync_jobs`, `cc.entity_sync_batches`. `cc.device_sync_state` loses `current_sync_id`.
- Job projection JSON matches `entitySyncJobSchema` from Task 1. Batch read JSON is `{ generation, credentialId, envelope, ids, batchCount }`.

- [ ] **Step 1: Write the failing integration test**

Replace `deployment/postgres/device-inventory.integration.mjs` with:

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
    const rows = async () =>
      (
        await runtime.query(
          'SELECT device_id,model,last_entity_sync,removed_at,battery_status FROM cc.devices WHERE customer_id=$1 ORDER BY device_id',
          [customer],
        )
      ).rows;
    const detail = (code) => (error) => error.detail === code;
    const fullSync = async (devices, failure = null) => {
      const { id } = await request();
      const attempt = randomUUID();
      await claim(id, attempt);
      await stage(id, attempt, devices);
      return finish(id, attempt, failure);
    };

    assert.equal((await read()).status, 'never');
    await assert.rejects(read(outsider), (error) => error.code === '42501');

    // Full sync: upsert, battery, publication.
    const first = await request();
    assert.equal(first.state.status, 'running');
    await assert.rejects(request(), detail('device-sync-running'));
    const attempt = randomUUID();
    const claimed = await claim(first.id, attempt);
    assert.equal(claimed.generation, generation);
    await assert.rejects(claim(first.id, randomUUID()), detail('device-sync-claimed'));
    assert.equal(
      await stage(first.id, attempt, [device('d1'), device('d2'), device('d2', { model: 'HP' })]),
      2,
      'The last page entry for a device wins and the count is distinct devices.',
    );
    assert.equal(
      await batteries(first.id, attempt, [
        {
          deviceId: 'd1',
          battery: {
            status: 'reported', health: 'replace-soon', capacityPercent: 78,
            reportedAt: '2026-10-05T13:50:00.000Z',
          },
          reports: [{ reportedAt: '2026-10-05T13:50:00.000Z', health: 'replace-soon', capacityPercent: 78 }],
        },
      ]),
      1,
    );
    const ready = await finish(first.id, attempt);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.deviceCount, 2);
    assert.equal(ready.stale, false);
    let current = await rows();
    assert.deepEqual(current.map((row) => [row.device_id, row.model, row.battery_status, row.removed_at]), [
      ['d1', 'Lenovo 100e Gen 4', 'reported', null],
      ['d2', 'HP', 'no-report', null],
    ]);
    assert.ok(current.every((row) => row.last_entity_sync instanceof Date));

    // A full sync without d2 soft-deletes d2 and keeps its row.
    const second = await fullSync([device('d1'), device('d3')]);
    assert.equal(second.deviceCount, 2);
    current = await rows();
    assert.deepEqual(current.map((row) => [row.device_id, row.removed_at !== null]), [
      ['d1', false], ['d2', true], ['d3', false],
    ]);

    // A failed full sync removes nothing and keeps the publication.
    const failed = await fullSync([device('d1')], 'provider-unavailable');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.stale, true);
    assert.equal(failed.deviceCount, 2);
    assert.deepEqual((await rows()).map((row) => row.removed_at !== null), [false, true, false]);

    // Entity sync job: slices, upsert with an explicit read time, soft delete, idempotent finish.
    const jobId = randomUUID();
    const job = await result(
      'SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result',
      [reader, customer, 'device', JSON.stringify(['d1', 'd2', 'd3']), 2, jobId, randomUUID()],
    );
    assert.equal(job.batchCount, 2);
    assert.equal(job.entityType, 'device');
    assert.equal(job.finishedAt, null);
    await assert.rejects(
      result('SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result', [
        outsider, customer, 'device', '["d1"]', 2, randomUUID(), randomUUID(),
      ]),
      (error) => error.code === '42501',
    );
    const batch0 = await result('SELECT cc.read_entity_sync_batch($1,$2,$3) AS result', [customer, jobId, 0]);
    assert.deepEqual(batch0.ids, ['d1', 'd2']);
    assert.equal(batch0.batchCount, 2);
    assert.equal(batch0.generation, generation);
    assert.ok(batch0.credentialId);
    const batch1 = await result('SELECT cc.read_entity_sync_batch($1,$2,$3) AS result', [customer, jobId, 1]);
    assert.deepEqual(batch1.ids, ['d3']);
    await assert.rejects(
      result('SELECT cc.read_entity_sync_batch($1,$2,$3) AS result', [customer, jobId, 2]),
      detail('entity-sync-changed'),
    );
    const syncedAt = '2026-10-06T09:00:00.000Z';
    assert.equal(
      await result('SELECT cc.upsert_devices($1,$2,$3) AS result', [
        customer, JSON.stringify([device('d2', { model: 'Acer' })]), syncedAt,
      ]),
      1,
    );
    const d2 = (await rows()).find((row) => row.device_id === 'd2');
    assert.equal(d2.removed_at, null, 'An upsert clears removed_at.');
    assert.equal(d2.last_entity_sync.toISOString(), syncedAt);
    assert.equal(
      await result('SELECT cc.soft_delete_devices($1,$2) AS result', [customer, JSON.stringify(['d3', 'missing'])]),
      1,
    );
    const records = await result('SELECT cc.read_device_records($1,$2) AS result', [
      customer, JSON.stringify(['d1', 'd2', 'd3']),
    ]);
    assert.deepEqual(records.map((record) => record.deviceId), ['d1', 'd2'], 'Removed devices stay out of records.');
    assert.equal(records[1].model, 'Acer');
    assert.equal(records[1].battery.status, 'no-report');
    assert.equal(typeof records[1].lastEntitySync, 'string');
    const page = await result('SELECT cc.page_device_records($1,$2,$3) AS result', [customer, '', 1]);
    assert.deepEqual(page.map((record) => record.deviceId), ['d1']);
    assert.deepEqual(
      (await result('SELECT cc.page_device_records($1,$2,$3) AS result', [customer, 'd1', 10])).map((r) => r.deviceId),
      ['d2'],
    );
    const once = await result('SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result', [customer, jobId, 0, null]);
    assert.equal(once.completedBatches, 1);
    assert.equal(once.finishedAt, null);
    const twice = await result('SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result', [customer, jobId, 0, null]);
    assert.equal(twice.completedBatches, 1, 'Finishing a batch twice counts once.');
    const done = await result('SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result', [customer, jobId, 1, 'quota']);
    assert.equal(done.failedBatches, 1);
    assert.equal(done.failure, 'quota');
    assert.ok(done.finishedAt);
    await assert.rejects(
      result('SELECT cc.read_entity_sync_batch($1,$2,$3) AS result', [customer, jobId, 0]),
      detail('entity-sync-changed'),
    );
    const abandonedId = randomUUID();
    await result('SELECT cc.create_entity_sync_job($1,1,$2,$3,$4,$5,$6,$7) AS result', [
      reader, customer, 'device', '["d1"]', 100, abandonedId, randomUUID(),
    ]);
    const abandoned = await result('SELECT cc.abandon_entity_sync_job($1,1,$2,$3) AS result', [reader, customer, abandonedId]);
    assert.equal(abandoned.failure, 'orchestration-unavailable');
    assert.ok(abandoned.finishedAt);
    await migrator.query(
      "UPDATE cc.entity_sync_jobs SET finished_at=finished_at-interval '2 days' WHERE job_id=$1",
      [abandonedId],
    );
    assert.equal(await result('SELECT cc.purge_entity_sync_jobs($1,$2) AS result', [customer, 100]), 1);

    // Expired leases still report interruption.
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
    await assert.rejects(stage(lost.id, lostAttempt, [device('d5')]), detail('device-sync-changed'));
    await assert.rejects(finish(lost.id, lostAttempt), detail('device-sync-changed'));
    const next = await request();
    const abandonedSync = await result('SELECT cc.abandon_device_sync($1,1,$2,$3,$4) AS result', [
      reader, customer, next.id, 'orchestration-unavailable',
    ]);
    assert.equal(abandonedSync.failure, 'orchestration-unavailable');

    await migrator.query('UPDATE cc.application_principals SET permission_version=2 WHERE id=$1', [reader]);
    await assert.rejects(read(), (error) => error.code === '42501');
    return [
      'device inventory reads require current devices:read authority: pass',
      'one worker attempt claims a device sync and duplicate dispatch is rejected: pass',
      'a full sync soft-deletes devices Google no longer returns and a failed sync removes nothing: pass',
      'entity sync jobs slice IDs into batches and count each batch once: pass',
      'upserts stamp last_entity_sync and clear removed_at: pass',
      'expired leases report interruption and reject late publication: pass',
    ];
  } finally {
    await migrator.query('UPDATE cc.google_connection SET active=$1', [wasActive]);
  }
}
```

- [ ] **Step 2: Run the integration to verify it fails**

Run: `npm exec -- nx run deployment:postgres-integration --skip-nx-cache`
Expected: FAIL at `cc.create_entity_sync_job` (function does not exist) or earlier at the `rows()` query (`last_entity_sync` column missing). The run needs a local PostgreSQL; the target starts one the same way the existing integration does.

- [ ] **Step 3: Rewrite the migration**

Replace `deployment/postgres/migrations/016-device-inventory.sql` with:

```sql
-- Device inventory keeps one row per device with the time of its last Google read.
-- A full sync enumerates the inventory under a lease. An entity sync refreshes a list of devices in batches.
-- Nothing is deleted. removed_at marks a device that Google no longer returns.
INSERT INTO cc.application_actions(action,scope_kinds) VALUES('devices:read',ARRAY['platform','district']);

CREATE TABLE cc.device_sync_state (
  customer_id text PRIMARY KEY REFERENCES cc.google_connection(customer_id),
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
  CHECK((sync_id IS NULL)=(sync_expires_at IS NULL))
);

CREATE TABLE cc.devices (
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
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
  last_entity_sync timestamptz NOT NULL,
  removed_at timestamptz,
  CHECK((battery_status='reported')=(battery_health IS NOT NULL AND battery_reported_at IS NOT NULL)),
  PRIMARY KEY(customer_id,device_id)
);
CREATE INDEX devices_serial ON cc.devices(customer_id,serial_number,device_id);
CREATE INDEX devices_model ON cc.devices(customer_id,model,device_id);
CREATE INDEX devices_asset ON cc.devices(customer_id,asset_tag,device_id);
CREATE INDEX devices_org_unit ON cc.devices(customer_id,org_unit_path text_pattern_ops);
CREATE INDEX devices_contact ON cc.devices(customer_id,last_contact,device_id);
CREATE INDEX devices_freshness ON cc.devices(customer_id,last_entity_sync);

-- One refresh job: the ID list, its batch size, and the connection generation it reads with.
CREATE TABLE cc.entity_sync_jobs (
  job_id uuid PRIMARY KEY,
  customer_id text NOT NULL REFERENCES cc.google_connection(customer_id),
  entity_type text NOT NULL CHECK(entity_type IN ('device')),
  generation integer NOT NULL,
  ids jsonb NOT NULL CHECK(jsonb_typeof(ids)='array' AND jsonb_array_length(ids) BETWEEN 1 AND 100000),
  batch_size integer NOT NULL CHECK(batch_size BETWEEN 1 AND 1000),
  batch_count integer NOT NULL CHECK(batch_count>=1),
  requested_by uuid REFERENCES cc.application_principals(id),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  failure text CHECK(failure IN ('credential-rejected','delegation-not-authorized','api-not-enabled',
    'policy-restricted','network-failure','scope-mismatch','permission-denied','quota','provider-unavailable',
    'invalid-response','wrong-customer','request-failed','key-unavailable','interrupted','orchestration-unavailable')),
  finished_at timestamptz
);
CREATE INDEX entity_sync_jobs_customer ON cc.entity_sync_jobs(customer_id,created_at);

-- Each batch records once. A re-dispatched batch replaces its own record.
CREATE TABLE cc.entity_sync_batches (
  job_id uuid NOT NULL REFERENCES cc.entity_sync_jobs(job_id) ON DELETE CASCADE,
  batch integer NOT NULL CHECK(batch>=0),
  status text NOT NULL CHECK(status IN ('completed','failed')),
  failure text,
  finished_at timestamptz NOT NULL,
  PRIMARY KEY(job_id,batch)
);

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
  -- An unclaimed sync expires quickly. A worker claim extends the lease while pages stage.
  INSERT INTO cc.device_sync_state(customer_id) VALUES(p_customer) ON CONFLICT(customer_id) DO NOTHING;
  SELECT * INTO prior FROM cc.device_sync_state WHERE customer_id=p_customer FOR UPDATE;
  IF prior.sync_id IS NOT NULL AND prior.sync_expires_at>now_at THEN
    RAISE EXCEPTION 'A device sync is running.' USING DETAIL='device-sync-running';
  END IF;
  UPDATE cc.device_sync_state SET
    failure=CASE WHEN prior.sync_id IS NOT NULL THEN 'interrupted' ELSE failure END,
    checked_at=CASE WHEN prior.sync_id IS NOT NULL THEN prior.sync_expires_at ELSE checked_at END,
    sync_id=p_id,sync_actor=p_actor,sync_generation=p_generation,sync_attempt=NULL,
    sync_started_at=now_at,sync_expires_at=now_at+interval '2 minutes',correlation_id=p_correlation
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

-- One device as the API and Redis carry it. Battery reads as unavailable after a telemetry failure.
CREATE FUNCTION cc.device_record(d cc.devices,p_telemetry_failure text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('deviceId',d.device_id,'serialNumber',d.serial_number,'model',d.model,'assetTag',d.asset_tag,
    'orgUnitPath',d.org_unit_path,'lastContact',d.last_contact,'annotatedLocation',d.annotated_location,'notes',d.notes,
    'battery',CASE WHEN p_telemetry_failure IS NOT NULL THEN jsonb_build_object('status','unavailable')
      WHEN d.battery_status='reported' THEN jsonb_build_object('status','reported','health',d.battery_health,
        'capacityPercent',d.battery_capacity_percent,'reportedAt',d.battery_reported_at)
      ELSE jsonb_build_object('status',d.battery_status) END,
    'lastEntitySync',d.last_entity_sync,'removedAt',d.removed_at);
$$;

-- Both sync kinds write through this upsert. A returned device is present again.
CREATE FUNCTION cc.upsert_devices(p_customer text,p_devices jsonb,p_synced_at timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE written integer;
BEGIN
  IF jsonb_typeof(p_devices) IS DISTINCT FROM 'array' OR jsonb_array_length(p_devices)>1000 OR p_synced_at IS NULL THEN
    RAISE EXCEPTION 'The device page is invalid.' USING ERRCODE='22023';
  END IF;
  INSERT INTO cc.devices(customer_id,device_id,serial_number,model,asset_tag,org_unit_path,last_contact,
    annotated_location,notes,status,last_entity_sync)
  SELECT DISTINCT ON (e.value->>'deviceId') p_customer,e.value->>'deviceId',e.value->>'serialNumber',
    e.value->>'model',e.value->>'assetTag',e.value->>'orgUnitPath',(e.value->>'lastContact')::timestamptz,
    e.value->>'annotatedLocation',e.value->>'notes',e.value->>'status',p_synced_at
  FROM jsonb_array_elements(p_devices) WITH ORDINALITY AS e(value,position)
  ORDER BY e.value->>'deviceId',e.position DESC
  ON CONFLICT(customer_id,device_id) DO UPDATE SET serial_number=EXCLUDED.serial_number,model=EXCLUDED.model,
    asset_tag=EXCLUDED.asset_tag,org_unit_path=EXCLUDED.org_unit_path,last_contact=EXCLUDED.last_contact,
    annotated_location=EXCLUDED.annotated_location,notes=EXCLUDED.notes,status=EXCLUDED.status,
    last_entity_sync=EXCLUDED.last_entity_sync,removed_at=NULL;
  GET DIAGNOSTICS written=ROW_COUNT;
  RETURN written;
END;
$$;

CREATE FUNCTION cc.upsert_device_batteries(p_customer text,p_batteries jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE written integer;
BEGIN
  IF jsonb_typeof(p_batteries) IS DISTINCT FROM 'array' OR jsonb_array_length(p_batteries)>1000 THEN
    RAISE EXCEPTION 'The battery page is invalid.' USING ERRCODE='22023';
  END IF;
  UPDATE cc.devices d SET battery_status=b.status,battery_health=b.health,battery_capacity_percent=b.capacity,
    battery_reported_at=b.reported_at,battery_reports=COALESCE(b.reports,'[]'::jsonb)
  FROM (SELECT DISTINCT ON (x."deviceId") x."deviceId" AS device_id,x.battery->>'status' AS status,
      x.battery->>'health' AS health,(x.battery->>'capacityPercent')::integer AS capacity,
      (x.battery->>'reportedAt')::timestamptz AS reported_at,x.reports
    FROM jsonb_to_recordset(p_batteries) AS x("deviceId" text,battery jsonb,reports jsonb)) b
  WHERE d.customer_id=p_customer AND d.device_id=b.device_id;
  GET DIAGNOSTICS written=ROW_COUNT;
  RETURN written;
END;
$$;

-- Google answered 404 for these devices. The rows stay.
CREATE FUNCTION cc.soft_delete_devices(p_customer text,p_ids jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE removed integer;
BEGIN
  IF jsonb_typeof(p_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(p_ids)>1000 THEN
    RAISE EXCEPTION 'The device list is invalid.' USING ERRCODE='22023';
  END IF;
  UPDATE cc.devices SET removed_at=clock_timestamp()
  WHERE customer_id=p_customer AND removed_at IS NULL
    AND device_id IN (SELECT jsonb_array_elements_text(p_ids));
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;

CREATE FUNCTION cc.read_device_records(p_customer text,p_ids jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT COALESCE(jsonb_agg(cc.device_record(d,s.telemetry_failure) ORDER BY d.device_id),'[]'::jsonb)
  FROM cc.devices d LEFT JOIN cc.device_sync_state s ON s.customer_id=d.customer_id
  WHERE d.customer_id=p_customer AND d.removed_at IS NULL
    AND d.device_id IN (SELECT jsonb_array_elements_text(p_ids));
$$;

-- Present devices after p_after in device_id order. An empty p_after starts at the first device.
CREATE FUNCTION cc.page_device_records(p_customer text,p_after text,p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT COALESCE(jsonb_agg(record ORDER BY device_id),'[]'::jsonb) FROM (
    SELECT d.device_id,cc.device_record(d,s.telemetry_failure) AS record
    FROM cc.devices d LEFT JOIN cc.device_sync_state s ON s.customer_id=d.customer_id
    WHERE d.customer_id=p_customer AND d.removed_at IS NULL AND d.device_id>COALESCE(p_after,'')
    ORDER BY d.device_id LIMIT LEAST(GREATEST(p_limit,1),1000)) page;
$$;

CREATE FUNCTION cc.stage_devices(p_customer text,p_id uuid,p_attempt uuid,p_devices jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  PERFORM cc.device_sync_lease(p_customer,p_id,p_attempt);
  RETURN cc.upsert_devices(p_customer,p_devices,clock_timestamp());
END;
$$;

CREATE FUNCTION cc.stage_device_batteries(p_customer text,p_id uuid,p_attempt uuid,p_batteries jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
BEGIN
  PERFORM cc.device_sync_lease(p_customer,p_id,p_attempt);
  RETURN cc.upsert_device_batteries(p_customer,p_batteries);
END;
$$;

-- A successful full sync marks every device the enumeration did not touch as removed.
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
    UPDATE cc.devices SET removed_at=now_at
    WHERE customer_id=p_customer AND removed_at IS NULL AND last_entity_sync<pending.sync_started_at;
    UPDATE cc.device_sync_state SET generation=pending.sync_generation,observed_at=now_at,
      device_count=(SELECT count(*) FROM cc.devices WHERE customer_id=p_customer AND removed_at IS NULL),
      telemetry_failure=p_telemetry_failure,failure=NULL
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

CREATE FUNCTION cc.entity_sync_job_projection(j cc.entity_sync_jobs) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
  SELECT jsonb_build_object('jobId',j.job_id,'customerId',j.customer_id,'entityType',j.entity_type,
    'batchCount',j.batch_count,
    'completedBatches',(SELECT count(*) FROM cc.entity_sync_batches b WHERE b.job_id=j.job_id AND b.status='completed'),
    'failedBatches',(SELECT count(*) FROM cc.entity_sync_batches b WHERE b.job_id=j.job_id AND b.status='failed'),
    'failure',j.failure,'createdAt',j.created_at,'finishedAt',j.finished_at);
$$;

CREATE FUNCTION cc.create_entity_sync_job(p_actor uuid,p_version integer,p_customer text,p_type text,p_ids jsonb,
  p_batch_size integer,p_job uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE connection cc.google_connection; job cc.entity_sync_jobs;
BEGIN
  connection:=cc.device_reader(p_actor,p_version);
  IF connection.customer_id IS DISTINCT FROM p_customer OR connection.active IS NOT TRUE THEN
    RAISE EXCEPTION 'The Google connection changed.' USING DETAIL='connection-changed';
  END IF;
  IF p_job IS NULL OR p_correlation IS NULL OR jsonb_typeof(p_ids) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'The job is invalid.' USING ERRCODE='22023';
  END IF;
  INSERT INTO cc.entity_sync_jobs(job_id,customer_id,entity_type,generation,ids,batch_size,batch_count,requested_by,correlation_id)
  VALUES(p_job,p_customer,p_type,connection.generation,p_ids,p_batch_size,
    ceil(jsonb_array_length(p_ids)::numeric/p_batch_size)::integer,p_actor,p_correlation)
  RETURNING * INTO job;
  RETURN cc.entity_sync_job_projection(job);
END;
$$;

CREATE FUNCTION cc.abandon_entity_sync_job(p_actor uuid,p_version integer,p_customer text,p_job uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.entity_sync_jobs;
BEGIN
  PERFORM cc.device_reader(p_actor,p_version);
  UPDATE cc.entity_sync_jobs SET failure='orchestration-unavailable',finished_at=clock_timestamp()
  WHERE job_id=p_job AND customer_id=p_customer AND finished_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM cc.entity_sync_batches b WHERE b.job_id=p_job)
  RETURNING * INTO job;
  IF job.job_id IS NULL THEN
    RAISE EXCEPTION 'The job changed.' USING DETAIL='entity-sync-changed';
  END IF;
  RETURN cc.entity_sync_job_projection(job);
END;
$$;

-- The batch runner reads its slice and the credential envelope for the job's generation.
CREATE FUNCTION cc.read_entity_sync_batch(p_customer text,p_job uuid,p_batch integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.entity_sync_jobs; connection cc.google_connection;
BEGIN
  SELECT * INTO job FROM cc.entity_sync_jobs WHERE job_id=p_job AND customer_id=p_customer;
  IF job.job_id IS NULL OR job.finished_at IS NOT NULL OR p_batch IS NULL OR p_batch<0 OR p_batch>=job.batch_count THEN
    RAISE EXCEPTION 'The entity sync job changed.' USING DETAIL='entity-sync-changed';
  END IF;
  connection:=cc.google_current_generation(p_customer,job.generation);
  RETURN jsonb_build_object('generation',connection.generation,'credentialId',connection.credential_id,
    'envelope',(SELECT envelope FROM cc.google_credentials WHERE id=connection.credential_id),
    'batchCount',job.batch_count,
    'ids',(SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ordinality),'[]'::jsonb)
      FROM jsonb_array_elements(job.ids) WITH ORDINALITY e
      WHERE e.ordinality>p_batch*job.batch_size AND e.ordinality<=(p_batch+1)*job.batch_size));
END;
$$;

CREATE FUNCTION cc.finish_entity_sync_batch(p_customer text,p_job uuid,p_batch integer,p_failure text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE job cc.entity_sync_jobs; recorded integer; now_at timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO job FROM cc.entity_sync_jobs WHERE job_id=p_job AND customer_id=p_customer FOR UPDATE;
  IF job.job_id IS NULL OR p_batch IS NULL OR p_batch<0 OR p_batch>=job.batch_count THEN
    RAISE EXCEPTION 'The entity sync job changed.' USING DETAIL='entity-sync-changed';
  END IF;
  INSERT INTO cc.entity_sync_batches(job_id,batch,status,failure,finished_at)
  VALUES(p_job,p_batch,CASE WHEN p_failure IS NULL THEN 'completed' ELSE 'failed' END,p_failure,now_at)
  ON CONFLICT(job_id,batch) DO UPDATE SET status=EXCLUDED.status,failure=EXCLUDED.failure,finished_at=EXCLUDED.finished_at;
  SELECT count(*) INTO recorded FROM cc.entity_sync_batches WHERE job_id=p_job;
  UPDATE cc.entity_sync_jobs SET
    failure=COALESCE(failure,p_failure),
    finished_at=CASE WHEN recorded>=batch_count THEN now_at ELSE finished_at END
  WHERE job_id=p_job RETURNING * INTO job;
  RETURN cc.entity_sync_job_projection(job);
END;
$$;

CREATE FUNCTION cc.purge_entity_sync_jobs(p_customer text,p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cc AS $$
DECLARE removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'The purge limit is invalid.' USING ERRCODE='22023';
  END IF;
  DELETE FROM cc.entity_sync_jobs WHERE job_id IN (
    SELECT job_id FROM cc.entity_sync_jobs
    WHERE customer_id=p_customer AND finished_at<clock_timestamp()-interval '1 day'
    ORDER BY finished_at LIMIT p_limit);
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON cc.device_sync_state,cc.devices,cc.entity_sync_jobs,cc.entity_sync_batches FROM PUBLIC;
REVOKE ALL ON FUNCTION cc.device_reader(uuid,integer),cc.device_sync_projection(text),
  cc.read_device_sync(uuid,integer),cc.request_device_sync(uuid,integer,text,integer,uuid,uuid),
  cc.abandon_device_sync(uuid,integer,text,uuid,text),cc.claim_device_sync(text,uuid,uuid),
  cc.device_sync_lease(text,uuid,uuid),cc.device_record(cc.devices,text),
  cc.upsert_devices(text,jsonb,timestamptz),cc.upsert_device_batteries(text,jsonb),cc.soft_delete_devices(text,jsonb),
  cc.read_device_records(text,jsonb),cc.page_device_records(text,text,integer),
  cc.stage_devices(text,uuid,uuid,jsonb),cc.stage_device_batteries(text,uuid,uuid,jsonb),
  cc.finish_device_sync(text,uuid,uuid,text,text),cc.entity_sync_job_projection(cc.entity_sync_jobs),
  cc.create_entity_sync_job(uuid,integer,text,text,jsonb,integer,uuid,uuid),
  cc.abandon_entity_sync_job(uuid,integer,text,uuid),cc.read_entity_sync_batch(text,uuid,integer),
  cc.finish_entity_sync_batch(text,uuid,integer,text),cc.purge_entity_sync_jobs(text,integer) FROM PUBLIC;
```

In `deployment/postgres/index.mjs`, replace the `016-device-inventory` grant block with:

```js
    if (migrations.some(({ id }) => id === '016-device-inventory')) {
      await client.query(`GRANT SELECT ON cc.devices, cc.device_sync_state, cc.entity_sync_jobs TO ${role};
        GRANT EXECUTE ON FUNCTION cc.device_reader(uuid,integer),
        cc.read_device_sync(uuid,integer),
        cc.request_device_sync(uuid,integer,text,integer,uuid,uuid),
        cc.abandon_device_sync(uuid,integer,text,uuid,text),
        cc.claim_device_sync(text,uuid,uuid),
        cc.device_record(cc.devices,text),
        cc.upsert_devices(text,jsonb,timestamptz),
        cc.upsert_device_batteries(text,jsonb),
        cc.soft_delete_devices(text,jsonb),
        cc.read_device_records(text,jsonb),
        cc.page_device_records(text,text,integer),
        cc.stage_devices(text,uuid,uuid,jsonb),
        cc.stage_device_batteries(text,uuid,uuid,jsonb),
        cc.finish_device_sync(text,uuid,uuid,text,text),
        cc.create_entity_sync_job(uuid,integer,text,text,jsonb,integer,uuid,uuid),
        cc.abandon_entity_sync_job(uuid,integer,text,uuid),
        cc.read_entity_sync_batch(text,uuid,integer),
        cc.finish_entity_sync_batch(text,uuid,integer,text),
        cc.purge_entity_sync_jobs(text,integer) TO ${role}`);
    }
```

- [ ] **Step 4: Run the integration and unit tests to verify they pass**

Run: `npm exec -- nx run deployment:postgres-integration --skip-nx-cache` and `npm exec -- nx run deployment:test --skip-nx-cache`
Expected: the device inventory section returns six `pass` lines. `postgres.test.mjs` still lists `016-device-inventory` and passes.

- [ ] **Step 5: Commit**

```bash
git add deployment/postgres
git commit -m "feat: keep one device row with last_entity_sync and entity sync jobs"
```

---

### Task 3: Read devices by ID through the Directory batch endpoint

**Files:**
- Modify: `libs/google-connection/src/lib/devices.ts`
- Modify: `libs/google-connection/src/lib/devices.test.mjs`

**Interfaces:**
- Produces, on `GoogleDeviceReader`:
  - `deviceBatch(credential, customerId, deviceIds: readonly string[], signal): Promise<{ devices: DeviceObservation[]; missing: string[] }>`. One POST to `https://www.googleapis.com/batch/admin/directory_v1` with up to 1,000 `GET …/devices/chromeos/{id}` parts. A 404 part puts the ID in `missing`. A 429 part, or a 403 part whose reason is `quotaExceeded`, `rateLimitExceeded`, or `userRateLimitExceeded`, throws `GoogleConnectionError('quota')`. Any other non-200 part throws the `failure()` mapping of that part.
  - `batteryBatch(credential, customerId, deviceIds: readonly string[], signal): Promise<BatteryObservation[]>`. One `GET https://chromemanagement.googleapis.com/v1/customers/{customerId}/telemetry/devices/{id}` per device, four at a time. A 404 yields `{ deviceId, battery: { status: 'no-report' }, reports: [] }`. A 429 throws `GoogleConnectionError('quota')`.
- Exported helpers for tests: `parseBatchResponse(contentType: string, body: string): { contentId: string; status: number; body: unknown }[]`.

- [ ] **Step 1: Write the failing reader tests**

Append to `libs/google-connection/src/lib/devices.test.mjs` (the file already defines `credential`, `deviceScope`, `telemetryScope`, and `stub`):

```js
import { parseBatchResponse } from './devices.ts';

const part = (id, status, body) =>
  [
    `--batch_response`,
    'Content-Type: application/http',
    `Content-ID: <response-item-${id}>`,
    '',
    `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(body),
    '',
  ].join('\r\n');
const batchBody = (parts) => `${parts.join('\r\n')}\r\n--batch_response--\r\n`;
const multipart = { 'content-type': 'multipart/mixed; boundary=batch_response' };

test('parseBatchResponse splits parts by content id and status', () => {
  const parsed = parseBatchResponse(
    multipart['content-type'],
    batchBody([part('d1', 200, { deviceId: 'd1' }), part('d2', 404, { error: { code: 404 } })]),
  );
  assert.deepEqual(parsed, [
    { contentId: 'd1', status: 200, body: { deviceId: 'd1' } },
    { contentId: 'd2', status: 404, body: { error: { code: 404 } } },
  ]);
});

test('deviceBatch reads each device once and reports missing devices', async (t) => {
  const { calls, scopes } = stub(t, [
    {
      __multipart: true,
      body: batchBody([
        part('d1', 200, { deviceId: 'd1', serialNumber: 'C0A1-7F2D', orgUnitPath: '/School A' }),
        part('d2', 404, { error: { code: 404, message: 'Resource Not Found' } }),
      ]),
    },
  ]);
  const result = await new GoogleDeviceReader().deviceBatch(
    credential,
    'C0123456',
    ['d1', 'd2'],
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(scopes, [deviceScope]);
  assert.equal(calls[0].url, 'https://www.googleapis.com/batch/admin/directory_v1');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].headers['content-type'], /^multipart\/mixed; boundary=/);
  assert.match(calls[0].body, /GET \/admin\/directory\/v1\/customer\/C0123456\/devices\/chromeos\/d1\?projection=FULL/);
  assert.match(calls[0].body, /Content-ID: <item-d2>/);
  assert.deepEqual(result.devices.map((device) => device.serialNumber), ['C0A1-7F2D']);
  assert.deepEqual(result.missing, ['d2']);
});

test('deviceBatch maps a quota part to a quota failure', async (t) => {
  stub(t, [
    {
      __multipart: true,
      body: batchBody([
        part('d1', 403, { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } }),
      ]),
    },
  ]);
  await assert.rejects(
    new GoogleDeviceReader().deviceBatch(credential, 'C0123456', ['d1'], AbortSignal.timeout(5000)),
    (error) => error.code === 'quota',
  );
});

test('deviceBatch fails the batch on any other part error', async (t) => {
  // failure() maps a plain 403 to permission-denied. If it maps differently, assert that code.
  stub(t, [
    {
      __multipart: true,
      body: batchBody([part('d1', 403, { error: { code: 403, errors: [{ reason: 'forbidden' }] } })]),
    },
  ]);
  await assert.rejects(
    new GoogleDeviceReader().deviceBatch(credential, 'C0123456', ['d1'], AbortSignal.timeout(5000)),
    (error) => error.code === 'permission-denied',
  );
});

test('batteryBatch reads one telemetry record per device and treats 404 as no report', async (t) => {
  const missing = new Error('not found');
  missing.response = { status: 404, data: { error: { code: 404 } } };
  const { calls, scopes } = stub(t, [
    {
      deviceId: 'd1',
      batteryInfo: [{ designCapacity: '5000' }],
      batteryStatusReport: [
        { reportTime: '2026-10-05T13:50:00.000Z', fullChargeCapacity: '3900', batteryHealth: 'BATTERY_REPLACE_SOON' },
      ],
    },
    missing,
  ]);
  const result = await new GoogleDeviceReader().batteryBatch(
    credential,
    'C0123456',
    ['d1', 'd2'],
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(scopes, [telemetryScope]);
  assert.deepEqual(
    calls.map((call) => call.url).sort(),
    [
      'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices/d1',
      'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices/d2',
    ],
  );
  assert.deepEqual(
    result.map((observation) => [observation.deviceId, observation.battery.status]),
    [['d1', 'reported'], ['d2', 'no-report']],
  );
});
```

Update the `stub` helper in that file so a page marked `__multipart` returns the multipart text with its header:

```js
  t.mock.method(OAuth2Client.prototype, 'request', async (options) => {
    calls.push(options);
    const next = pages.shift();
    if (next instanceof Error || (next && next.response)) throw next;
    if (next && next.__multipart)
      return { data: next.body, headers: multipart, status: 200 };
    return { data: next };
  });
```

Move the `multipart` constant above `stub`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import ./libs/application-contracts/test-register.mjs --test libs/google-connection/src/lib/devices.test.mjs`
Expected: FAIL. `parseBatchResponse` is not exported. `deviceBatch` and `batteryBatch` are not functions.

- [ ] **Step 3: Implement the batch readers**

In `libs/google-connection/src/lib/devices.ts`, add after the `telemetryPage` schema:

```ts
const batchEndpoint = 'https://www.googleapis.com/batch/admin/directory_v1';
const directoryPath = '/admin/directory/v1';
const deviceFields =
  'deviceId,serialNumber,model,annotatedAssetId,orgUnitPath,lastSync,annotatedLocation,notes,status';
const batchLimit = 1000;
const telemetryConcurrency = 4;
const quotaReasons = new Set([
  'quotaExceeded',
  'rateLimitExceeded',
  'userRateLimitExceeded',
]);
const telemetryDevice = telemetryPage.shape.devices.unwrap().element;
const batchError = z.object({
  error: z
    .object({
      code: z.number().optional(),
      errors: z.array(z.object({ reason: z.string() })).optional(),
    })
    .optional(),
});

/** Split a multipart/mixed batch response into its HTTP parts. */
export function parseBatchResponse(
  contentType: string,
  body: string,
): { contentId: string; status: number; body: unknown }[] {
  const boundary = /boundary="?([^";]+)"?/.exec(contentType)?.[1];
  if (!boundary) throw new GoogleConnectionError('invalid-response');
  return body
    .split(`--${boundary}`)
    .slice(1)
    .filter((part) => part.trim() !== '' && part.trim() !== '--')
    .map((part) => {
      const normalized = part.replace(/\r\n/g, '\n');
      const contentId = /Content-ID:\s*<response-(?:item-)?([^>]+)>/i.exec(
        normalized,
      )?.[1];
      const http = normalized.slice(normalized.indexOf('\n\n') + 2);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(http)?.[1]);
      const json = http.slice(http.indexOf('\n\n') + 2).trim();
      if (!contentId || !Number.isFinite(status))
        throw new GoogleConnectionError('invalid-response');
      let parsed: unknown = null;
      if (json) {
        try {
          parsed = JSON.parse(json);
        } catch {
          throw new GoogleConnectionError('invalid-response');
        }
      }
      return { contentId, status, body: parsed };
    });
}

function partFailure(status: number, body: unknown): GoogleConnectionError {
  const reason = batchError.safeParse(body).data?.error?.errors?.[0]?.reason;
  if (status === 429 || (status === 403 && quotaReasons.has(reason ?? '')))
    return new GoogleConnectionError('quota');
  return failure({ response: { status, data: body } });
}
```

Add these methods to `GoogleDeviceReader` after `batteryPages`:

```ts
  /** One Directory batch request. 404 parts name removed devices. Quota parts abort the whole batch. */
  async deviceBatch(
    credential: DelegatedCredential,
    customerId: string,
    deviceIds: readonly string[],
    signal: AbortSignal,
  ): Promise<{ devices: DeviceObservation[]; missing: string[] }> {
    googleCustomerIdSchema.parse(customerId);
    if (deviceIds.length === 0) return { devices: [], missing: [] };
    if (deviceIds.length > batchLimit)
      throw new GoogleConnectionError('invalid-response');
    const client = await scopedClient(
      credential,
      scopeFor('device-inventory'),
      signal,
      devicePageLimit,
    );
    const boundary = `batch_cc_${Math.random().toString(36).slice(2)}`;
    const body =
      deviceIds
        .map(
          (id) =>
            `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item-${id}>\r\n\r\n` +
            `GET ${directoryPath}/customer/${customerId}/devices/chromeos/${encodeURIComponent(id)}?projection=FULL&fields=${deviceFields}\r\n\r\n`,
        )
        .join('') + `--${boundary}--\r\n`;
    let response;
    try {
      response = await client.request<string>({
        url: batchEndpoint,
        method: 'POST',
        headers: { 'content-type': `multipart/mixed; boundary=${boundary}` },
        body,
        responseType: 'text',
      });
    } catch (error) {
      throw failure(error);
    }
    // gaxios 7 exposes a Headers instance. Older stubs and versions expose a plain object.
    const headers = response.headers as unknown as
      | { get?: (name: string) => string | null }
      | Record<string, string | undefined>;
    const contentType = String(
      (typeof (headers as { get?: unknown }).get === 'function'
        ? (headers as { get: (name: string) => string | null }).get('content-type')
        : (headers as Record<string, string | undefined>)['content-type']) ?? '',
    );
    const parts = parseBatchResponse(contentType, String(response.data));
    const devices: DeviceObservation[] = [];
    const missing: string[] = [];
    for (const part of parts) {
      if (part.status === 404) missing.push(part.contentId);
      else if (part.status === 200) {
        try {
          devices.push(
            deviceObservation(devicePage.shape.chromeosdevices.unwrap().element.parse(part.body)),
          );
        } catch {
          throw new GoogleConnectionError('invalid-response');
        }
      } else throw partFailure(part.status, part.body);
    }
    return { devices, missing };
  }

  /** One telemetry read per device, four at a time. A device without telemetry has no report. */
  async batteryBatch(
    credential: DelegatedCredential,
    customerId: string,
    deviceIds: readonly string[],
    signal: AbortSignal,
  ): Promise<BatteryObservation[]> {
    googleCustomerIdSchema.parse(customerId);
    if (deviceIds.length === 0) return [];
    const client = await scopedClient(
      credential,
      scopeFor('device-telemetry'),
      signal,
      telemetryLimit,
    );
    const results: BatteryObservation[] = [];
    const queue = [...deviceIds];
    const readOne = async (id: string) => {
      try {
        const data = telemetryDevice.parse(
          (
            await client.request({
              url: `${management}/customers/${customerId}/telemetry/devices/${encodeURIComponent(id)}`,
              method: 'GET',
              params: { readMask: 'deviceId,batteryInfo,batteryStatusReport' },
            })
          ).data,
        );
        const observation = batteryObservation({ ...data, deviceId: id });
        if (observation) results.push(observation);
      } catch (error) {
        const status = z
          .object({ response: z.object({ status: z.number() }) })
          .safeParse(error).data?.response.status;
        if (status === 404) {
          results.push({ deviceId: id, battery: { status: 'no-report' }, reports: [] });
          return;
        }
        throw failure(error);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(telemetryConcurrency, queue.length) }, async () => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift())
          await readOne(id);
      }),
    );
    return results.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }
```

`failure()` already maps HTTP 429 to `quota`, so the telemetry path needs no extra mapping.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm exec -- nx run google-connection:test --skip-nx-cache`
Expected: PASS, including the four existing page tests.

- [ ] **Step 5: Commit**

```bash
git add libs/google-connection
git commit -m "feat: read devices by ID through the Directory batch endpoint"
```

---

### Task 4: Worker Redis client and the entity sync batch runner

**Files:**
- Create: `worker/src/entity-cache.ts`
- Create: `worker/src/entity-sync.ts`
- Create: `worker/src/entity-sync.test.mjs`

**Interfaces:**
- Produces `worker/src/entity-cache.ts`:
  ```ts
  export interface EntityCache {
    setRecords(entries: { key: string; value: string }[], seconds: number): Promise<void>;
    remove(keys: string[]): Promise<void>;
    removeMembers(key: string, members: string[]): Promise<void>;
    increment(key: string): Promise<void>;
    publish(channel: string, message: string): Promise<void>;
    close(): Promise<void>;
  }
  export class WorkerRedis implements EntityCache {
    constructor(options: { url: string; password: string; tls: { servername: string; ca?: Buffer } | null });
  }
  ```
  `WorkerRedis` uses `createClient` from `redis` with `username: 'worker'`, `disableOfflineQueue: true`, `commandOptions: { timeout: 3000 }`, `reconnectStrategy: false`, and connects lazily on first use. Every method throws `EntityCacheError('cache-unavailable')` on a Redis failure.
- Produces `worker/src/entity-sync.ts`:
  ```ts
  export interface EntityReader {
    deviceBatch(credential, customerId, ids: readonly string[], signal): Promise<{ devices: DeviceObservation[]; missing: string[] }>;
    batteryBatch(credential, customerId, ids: readonly string[], signal): Promise<BatteryObservation[]>;
  }
  export interface EntitySyncBatchResult { job: EntitySyncJob; updated: string[]; removed: string[]; failure: string | null }
  export class EntitySyncBatch {
    constructor(database: DeviceSyncDatabase, cipher: Pick<CredentialCipher, 'open'>, reader: EntityReader, cache: EntityCache,
      options?: { backoff?: (attempt: number) => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> });
    run(request: EntitySyncBatchRequest, signal: AbortSignal): Promise<EntitySyncBatchResult>;
  }
  ```
  `DeviceSyncError` from `./device-sync` is reused for store failures (`entity-sync-changed`, `store-unavailable`). Default backoff: `min(60_000, 1_000 * 2 ** attempt)` plus up to 500 ms jitter.

- [ ] **Step 1: Write the failing batch runner tests**

Create `worker/src/entity-sync.test.mjs`:

```js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { GoogleConnectionError } from '@campus/google-connection';
import { EntitySyncBatch } from './entity-sync.ts';
import { DeviceSyncError } from './device-sync.ts';

const customerId = 'C0123456';
const jobId = randomUUID();
const request = { customerId, jobId, batch: 0, correlationId: randomUUID() };
const job = (extra = {}) => ({
  jobId,
  customerId,
  entityType: 'device',
  batchCount: 2,
  completedBatches: 1,
  failedBatches: 0,
  failure: null,
  createdAt: '2026-10-06T12:00:00.000Z',
  finishedAt: null,
  ...extra,
});
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
const record = (deviceId) => ({
  deviceId,
  serialNumber: deviceId,
  model: null,
  assetTag: null,
  orgUnitPath: '/',
  lastContact: null,
  annotatedLocation: null,
  notes: null,
  battery: { status: 'no-report' },
  lastEntitySync: '2026-10-06T12:00:00.000Z',
  removedAt: null,
});

function database({ fail = {}, finish = job() } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      const name = /cc\.(\w+)/.exec(sql)[1];
      calls.push({ name, values });
      if (fail[name]) throw Object.assign(new Error(name), { code: 'P0001', detail: fail[name] });
      if (name === 'read_entity_sync_batch')
        return {
          rows: [
            {
              result: {
                generation: 1,
                credentialId: randomUUID(),
                envelope: { sealed: true },
                batchCount: 2,
                ids: ['d1', 'd2', 'd3'],
              },
            },
          ],
        };
      if (name === 'read_device_records')
        return { rows: [{ result: JSON.parse(values[1]).map(record) }] };
      if (name === 'finish_entity_sync_batch') return { rows: [{ result: finish }] };
      return { rows: [{ result: 1 }] };
    },
  };
}
function cache() {
  const calls = [];
  const note = (name) => async (...args) => void calls.push({ name, args });
  return {
    calls,
    setRecords: note('setRecords'),
    remove: note('remove'),
    removeMembers: note('removeMembers'),
    increment: note('increment'),
    publish: note('publish'),
    close: async () => undefined,
  };
}
const cipher = { open: () => ({ subject: 'fixture@example.invalid', serviceAccount: {} }) };
function reader({ devices = [], batteries = [] } = {}) {
  const calls = [];
  return {
    calls,
    async deviceBatch(_credential, _customer, ids) {
      calls.push({ name: 'deviceBatch', ids });
      const next = devices.shift();
      if (next instanceof Error) throw next;
      return next ?? { devices: ids.map(device), missing: [] };
    },
    async batteryBatch(_credential, _customer, ids) {
      calls.push({ name: 'batteryBatch', ids });
      const next = batteries.shift();
      if (next instanceof Error) throw next;
      return next ?? [];
    },
  };
}
const names = (calls) => calls.map((call) => call.name);
const noSleep = { sleep: async () => undefined, backoff: () => 0 };

test('a batch upserts, caches, removes in-flight IDs, and publishes one event', async () => {
  const db = database();
  const redis = cache();
  const result = await new EntitySyncBatch(
    db,
    cipher,
    reader({ devices: [{ devices: [device('d1'), device('d3')], missing: ['d2'] }] }),
    redis,
    noSleep,
  ).run(request, AbortSignal.timeout(5000));
  assert.deepEqual(names(db.calls), [
    'read_entity_sync_batch',
    'upsert_devices',
    'upsert_device_batteries',
    'soft_delete_devices',
    'read_device_records',
    'finish_entity_sync_batch',
  ]);
  assert.deepEqual(JSON.parse(db.calls[1].values[1]).map((d) => d.deviceId), ['d1', 'd3']);
  assert.match(db.calls[1].values[2], /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(JSON.parse(db.calls[3].values[1]), ['d2']);
  assert.deepEqual(db.calls[5].values, [customerId, jobId, 0, null]);
  assert.deepEqual(names(redis.calls), ['setRecords', 'remove', 'removeMembers', 'publish']);
  assert.deepEqual(
    redis.calls[0].args[0].map((entry) => entry.key),
    ['cc:entity:device:C0123456:d1', 'cc:entity:device:C0123456:d3'],
  );
  assert.equal(redis.calls[0].args[1], 86400);
  assert.equal(JSON.parse(redis.calls[0].args[0][0].value).stale, undefined, 'Redis stores records without stale.');
  assert.deepEqual(redis.calls[1].args[0], ['cc:entity:device:C0123456:d2']);
  assert.deepEqual(redis.calls[2].args, ['cc:entity-inflight:device:C0123456', ['d1', 'd2', 'd3']]);
  assert.equal(redis.calls[3].args[0], 'cc:entity-events:C0123456');
  assert.deepEqual(JSON.parse(redis.calls[3].args[1]), {
    type: 'entity-batch',
    jobId,
    entityType: 'device',
    batch: 0,
    batchCount: 2,
    deviceIds: ['d1', 'd3'],
    removedIds: ['d2'],
  });
  assert.deepEqual(result, { job: job(), updated: ['d1', 'd3'], removed: ['d2'], failure: null });
});

test('the last batch publishes job-finished', async () => {
  const finished = job({ completedBatches: 2, finishedAt: '2026-10-06T12:01:00.000Z' });
  const redis = cache();
  await new EntitySyncBatch(database({ finish: finished }), cipher, reader(), redis, noSleep).run(
    { ...request, batch: 1 },
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(JSON.parse(redis.calls.at(-1).args[1]), { type: 'job-finished', job: finished });
});

test('quota errors retry until Google answers', async () => {
  const waits = [];
  const runner = new EntitySyncBatch(
    database(),
    cipher,
    reader({
      devices: [new GoogleConnectionError('quota'), new GoogleConnectionError('quota')],
      batteries: [new GoogleConnectionError('quota')],
    }),
    cache(),
    { backoff: (attempt) => attempt * 10, sleep: async (ms) => void waits.push(ms) },
  );
  const result = await runner.run(request, AbortSignal.timeout(5000));
  assert.equal(result.failure, null);
  assert.deepEqual(waits, [0, 10, 0]);
});

test('a quota retry stops when the worker shuts down', async () => {
  const stopping = new AbortController();
  const runner = new EntitySyncBatch(
    database(),
    cipher,
    reader({ devices: [new GoogleConnectionError('quota')] }),
    cache(),
    {
      backoff: () => 1,
      sleep: async () => {
        stopping.abort();
        throw new DeviceSyncError('worker-stopping');
      },
    },
  );
  await assert.rejects(
    runner.run(request, stopping.signal),
    (error) => error instanceof DeviceSyncError && error.code === 'worker-stopping',
  );
});

test('any other Google error fails the batch and frees the in-flight IDs', async () => {
  const db = database({ finish: job({ completedBatches: 0, failedBatches: 1, failure: 'scope-mismatch' }) });
  const redis = cache();
  const result = await new EntitySyncBatch(
    db,
    cipher,
    reader({ devices: [new GoogleConnectionError('scope-mismatch')] }),
    redis,
    noSleep,
  ).run(request, AbortSignal.timeout(5000));
  assert.deepEqual(names(db.calls), ['read_entity_sync_batch', 'finish_entity_sync_batch']);
  assert.deepEqual(db.calls[1].values, [customerId, jobId, 0, 'scope-mismatch']);
  assert.deepEqual(names(redis.calls), ['removeMembers']);
  assert.equal(result.failure, 'scope-mismatch');
  assert.deepEqual(result.updated, []);
});

test('a changed job stops before Google access', async () => {
  const db = database({ fail: { read_entity_sync_batch: 'entity-sync-changed' } });
  await assert.rejects(
    new EntitySyncBatch(db, cipher, reader(), cache(), noSleep).run(request, AbortSignal.timeout(5000)),
    (error) => error instanceof DeviceSyncError && error.code === 'entity-sync-changed',
  );
  assert.deepEqual(names(db.calls), ['read_entity_sync_batch']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import ./libs/application-contracts/test-register.mjs --test worker/src/entity-sync.test.mjs`
Expected: FAIL. `./entity-sync.ts` does not exist.

- [ ] **Step 3: Add `entity-sync-changed` and `worker-stopping` to the worker's lease errors**

In `worker/src/device-sync.ts`, change `leaseErrors` to:

```ts
const leaseErrors = [
  'device-sync-changed',
  'device-sync-claimed',
  'entity-sync-changed',
  'credential-changed',
  'connection-disconnected',
  'restore-revalidation-required',
];
```

Export the `call` logic for reuse. Add above the `DeviceSync` class:

```ts
/** Run one cc.* function. Known lease details keep their code. Everything else is a store failure. */
export async function callStore(
  database: DeviceSyncDatabase,
  sql: string,
  values: unknown[],
): Promise<unknown> {
  try {
    return (await database.query(sql, values)).rows[0]?.['result'];
  } catch (error) {
    const detail = z.object({ detail: z.string().optional() }).safeParse(error);
    const code = detail.success ? detail.data.detail : undefined;
    throw new DeviceSyncError(
      code && leaseErrors.includes(code) ? code : 'store-unavailable',
    );
  }
}
```

Replace the body of the private `call` method in `DeviceSync` with `return callStore(this.database, sql, values);`.

- [ ] **Step 4: Write the Redis client**

Create `worker/src/entity-cache.ts`:

```ts
import { createClient } from 'redis';

export class EntityCacheError extends Error {
  readonly code = 'cache-unavailable';
  constructor() {
    super('cache-unavailable');
    this.name = 'EntityCacheError';
  }
}

/** The worker's view of Redis: records, in-flight IDs, the query generation, and events. */
export interface EntityCache {
  setRecords(entries: { key: string; value: string }[], seconds: number): Promise<void>;
  remove(keys: string[]): Promise<void>;
  removeMembers(key: string, members: string[]): Promise<void>;
  increment(key: string): Promise<void>;
  publish(channel: string, message: string): Promise<void>;
  close(): Promise<void>;
}

const chunk = 500;

export class WorkerRedis implements EntityCache {
  private readonly client;
  private connecting?: Promise<void>;

  constructor(options: {
    url: string;
    password: string;
    tls: { servername: string; ca?: Buffer } | null;
  }) {
    const url = new URL(options.url);
    this.client = createClient({
      username: 'worker',
      password: options.password,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 1000,
      commandOptions: { timeout: 3000 },
      socket: {
        host: url.hostname,
        port: Number(url.port || 6379),
        connectTimeout: 3000,
        reconnectStrategy: false,
        ...(options.tls
          ? {
              tls: true as const,
              servername: options.tls.servername,
              rejectUnauthorized: true,
              ...(options.tls.ca ? { ca: options.tls.ca } : {}),
            }
          : {}),
      },
    });
    this.client.on('error', () => {
      /* Batch runners report cache-unavailable. */
    });
  }

  private async run<T>(work: (client: NonNullable<WorkerRedis['client']>) => Promise<T>): Promise<T> {
    try {
      if (!this.client.isReady) {
        this.connecting ??= this.client
          .connect()
          .then(() => undefined)
          .finally(() => {
            this.connecting = undefined;
          });
        await this.connecting;
      }
      return await work(this.client);
    } catch {
      if (this.client.isOpen) this.client.destroy();
      throw new EntityCacheError();
    }
  }

  async setRecords(entries: { key: string; value: string }[], seconds: number) {
    for (let start = 0; start < entries.length; start += chunk) {
      await this.run(async (client) => {
        const multi = client.multi();
        for (const entry of entries.slice(start, start + chunk))
          multi.set(entry.key, entry.value, { EX: seconds });
        await multi.exec();
      });
    }
  }

  async remove(keys: string[]) {
    if (keys.length) await this.run((client) => client.del(keys));
  }

  async removeMembers(key: string, members: string[]) {
    if (members.length) await this.run((client) => client.sRem(key, members));
  }

  async increment(key: string) {
    await this.run((client) => client.incr(key));
  }

  async publish(channel: string, message: string) {
    await this.run((client) => client.publish(channel, message));
  }

  async close() {
    if (this.client.isOpen) this.client.destroy();
  }
}
```

- [ ] **Step 5: Write the batch runner**

Create `worker/src/entity-sync.ts`:

```ts
import { z } from 'zod';
import {
  ENTITY_CACHE_SECONDS,
  entityEventsChannel,
  entityKey,
  entitySyncBatchRequestSchema,
  entitySyncJobSchema,
  inflightKey,
  type BatteryObservation,
  type DeviceObservation,
  type EntityEvent,
  type EntitySyncBatchRequest,
  type EntitySyncJob,
} from '@campus/application-contracts';
import {
  CredentialError,
  GoogleConnectionError,
  type CredentialCipher,
  type DelegatedCredential,
} from '@campus/google-connection';
import type { EntityCache } from './entity-cache';
import { DeviceSyncError, callStore, type DeviceSyncDatabase } from './device-sync';

export interface EntityReader {
  deviceBatch(
    credential: DelegatedCredential,
    customerId: string,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<{ devices: DeviceObservation[]; missing: string[] }>;
  batteryBatch(
    credential: DelegatedCredential,
    customerId: string,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<BatteryObservation[]>;
}

export interface EntitySyncBatchResult {
  job: EntitySyncJob;
  updated: string[];
  removed: string[];
  failure: string | null;
}

const batchSchema = z.strictObject({
  generation: z.number().int().positive(),
  credentialId: z.uuid(),
  envelope: z.unknown(),
  batchCount: z.number().int().min(1),
  ids: z.array(z.string().min(1).max(128)).max(1000),
});
const recordsSchema = z.array(z.object({ deviceId: z.string() }).passthrough());

const defaultBackoff = (attempt: number) =>
  Math.min(60_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 500);

async function defaultSleep(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) throw new DeviceSyncError('worker-stopping');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new DeviceSyncError('worker-stopping'));
    };
    signal.addEventListener('abort', abort, { once: true });
    timer.unref();
  });
}

/**
 * One Kestra batch: read the slice, fetch from Google, upsert, cache, signal, record.
 * Quota errors retry inside the worker. Every other Google error fails the batch once.
 */
export class EntitySyncBatch {
  constructor(
    private readonly database: DeviceSyncDatabase,
    private readonly cipher: Pick<CredentialCipher, 'open'>,
    private readonly reader: EntityReader,
    private readonly cache: EntityCache,
    private readonly options: {
      backoff?: (attempt: number) => number;
      sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    } = {},
  ) {}

  private call(sql: string, values: unknown[]) {
    return callStore(this.database, sql, values);
  }

  /** Retry only quota answers. A shutdown signal ends the wait with worker-stopping. */
  private async untilQuotaClears<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    const backoff = this.options.backoff ?? defaultBackoff;
    const sleep = this.options.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt++) {
      try {
        return await read();
      } catch (error) {
        if (!(error instanceof GoogleConnectionError) || error.code !== 'quota') throw error;
        await sleep(backoff(attempt), signal);
      }
    }
  }

  private async publish(customerId: string, event: EntityEvent) {
    await this.cache.publish(entityEventsChannel(customerId), JSON.stringify(event));
  }

  async run(request: EntitySyncBatchRequest, signal: AbortSignal): Promise<EntitySyncBatchResult> {
    const input = entitySyncBatchRequestSchema.parse(request);
    const batch = batchSchema.parse(
      await this.call('SELECT cc.read_entity_sync_batch($1,$2,$3) AS result', [
        input.customerId,
        input.jobId,
        input.batch,
      ]),
    );
    const inflight = inflightKey('device', input.customerId);
    let updated: string[] = [];
    let removed: string[] = [];
    let failure: string | null = null;
    try {
      const credential = this.cipher.open(batch.envelope, {
        recordId: batch.credentialId,
        customerId: input.customerId,
        generation: batch.generation,
      });
      const read = await this.untilQuotaClears(signal, () =>
        this.reader.deviceBatch(credential, input.customerId, batch.ids, signal),
      );
      const present = read.devices.map((device) => device.deviceId);
      const batteries = await this.untilQuotaClears(signal, () =>
        this.reader.batteryBatch(credential, input.customerId, present, signal),
      );
      const syncedAt = new Date().toISOString();
      await this.call('SELECT cc.upsert_devices($1,$2,$3) AS result', [
        input.customerId,
        JSON.stringify(read.devices),
        syncedAt,
      ]);
      await this.call('SELECT cc.upsert_device_batteries($1,$2) AS result', [
        input.customerId,
        JSON.stringify(batteries),
      ]);
      await this.call('SELECT cc.soft_delete_devices($1,$2) AS result', [
        input.customerId,
        JSON.stringify(read.missing),
      ]);
      const records = recordsSchema.parse(
        await this.call('SELECT cc.read_device_records($1,$2) AS result', [
          input.customerId,
          JSON.stringify(present),
        ]),
      );
      updated = records.map((record) => record.deviceId);
      removed = read.missing;
      await this.cache.setRecords(
        records.map(({ removedAt: _removedAt, ...record }) => ({
          key: entityKey('device', input.customerId, record.deviceId),
          value: JSON.stringify(record),
        })),
        ENTITY_CACHE_SECONDS.device,
      );
      await this.cache.remove(removed.map((id) => entityKey('device', input.customerId, id)));
    } catch (error) {
      if (error instanceof DeviceSyncError) throw error;
      failure =
        error instanceof GoogleConnectionError
          ? error.code
          : error instanceof CredentialError
            ? 'key-unavailable'
            : 'request-failed';
    }
    // Freed IDs let the next stale read dispatch them again.
    await this.cache.removeMembers(inflight, batch.ids);
    if (failure === null)
      await this.publish(input.customerId, {
        type: 'entity-batch',
        jobId: input.jobId,
        entityType: 'device',
        batch: input.batch,
        batchCount: batch.batchCount,
        deviceIds: updated,
        removedIds: removed,
      });
    const job = entitySyncJobSchema.parse(
      await this.call('SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result', [
        input.customerId,
        input.jobId,
        input.batch,
        failure,
      ]),
    );
    if (job.finishedAt) await this.publish(input.customerId, { type: 'job-finished', job });
    return { job, updated, removed, failure };
  }
}
```

The `removeMembers` call runs on both outcomes, so the test for "any other Google error" expects exactly `['removeMembers']` on the cache and the success test expects it after `remove`. In the failure path the `publish` for `job-finished` is skipped because the fixture job is unfinished.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm exec -- nx run worker:test --skip-nx-cache`
Expected: PASS for `entity-sync.test.mjs`. `device-sync.test.mjs` still passes (the `call` refactor keeps behavior).

- [ ] **Step 7: Commit**

```bash
git add worker/src/entity-cache.ts worker/src/entity-sync.ts worker/src/entity-sync.test.mjs worker/src/device-sync.ts
git commit -m "feat: run entity sync batches in the worker with Redis records and events"
```

---

### Task 5: Full sync fills Redis and signals, and the worker exposes the batch dispatch

**Files:**
- Modify: `worker/src/device-sync.ts`
- Modify: `worker/src/device-sync.test.mjs`
- Modify: `worker/src/google-connection.ts`
- Modify: `worker/src/dispatch.ts`
- Modify: `worker/src/main.ts`

**Interfaces:**
- `DeviceSync` constructor becomes `(database, cipher, reader, cache: EntityCache)`. After a successful `finish_device_sync` it pages `cc.page_device_records` in 1,000s into Redis with `ENTITY_CACHE_SECONDS.device`, increments `queryGenerationKey('device', customerId)`, then publishes `{ type: 'full-sync', sync }`. After a failed finish it publishes `full-sync` only. The purge loop is gone.
- `GoogleWorker` gains `syncEntityBatch(input: EntitySyncBatchRequest, signal): Promise<EntitySyncBatchResult>` and a lazily built `WorkerRedis` from `config.services.redis`. `close()` also closes Redis.
- `POST /dispatch/entity-sync-batch` accepts `entitySyncBatchRequestSchema` plus `executionId`. 200 `{ executionId, correlationId, status: 'completed' | 'failed', failure, job }`. 409 `{ error }` for `DeviceSyncError` codes. 503 `{ error: 'entity-sync-unavailable' }` otherwise.

- [ ] **Step 1: Update the full sync tests**

In `worker/src/device-sync.test.mjs`:
- Remove the `purged` option and the `purge_device_syncs` branch from `database()`. Add a `page_device_records` branch:
  ```js
      if (name === 'page_device_records')
        return { rows: [{ result: values[1] === '' ? [record('d1'), record('d2')] : [] }] };
  ```
  and define `record` as in `entity-sync.test.mjs` (same shape with `removedAt: null`).
- Add the `cache()` fake from `entity-sync.test.mjs` and pass it as the fourth constructor argument in every `new DeviceSync(...)`.
- Replace the first test with:

```js
test('stages every page, publishes, fills Redis, and bumps the query generation', async () => {
  const db = database();
  const redis = cache();
  const result = await new DeviceSync(db, cipher, reader(), redis).run(request, AbortSignal.timeout(5000));
  assert.deepEqual(result, state);
  assert.deepEqual(names(db.calls), [
    'claim_device_sync',
    'stage_devices',
    'stage_device_batteries',
    'finish_device_sync',
    'page_device_records',
    'page_device_records',
  ]);
  assert.deepEqual(db.calls[4].values, [customerId, '', 1000]);
  assert.deepEqual(db.calls[5].values, [customerId, 'd2', 1000]);
  assert.deepEqual(names(redis.calls), ['setRecords', 'increment', 'publish']);
  assert.deepEqual(redis.calls[0].args[0].map((entry) => entry.key), [
    'cc:entity:device:C0123456:d1',
    'cc:entity:device:C0123456:d2',
  ]);
  assert.deepEqual(redis.calls[1].args, ['cc:query-gen:device:C0123456']);
  assert.deepEqual(JSON.parse(redis.calls[2].args[1]), { type: 'full-sync', sync: state });
});
```

- Add to the `a device page failure records the failure` test:

```js
  assert.deepEqual(names(redis.calls), ['publish'], 'A failed sync signals but writes no records.');
```

(create `redis = cache()` in that test and pass it).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import ./libs/application-contracts/test-register.mjs --test worker/src/device-sync.test.mjs`
Expected: FAIL. `purge_device_syncs` is still called and no Redis calls happen.

- [ ] **Step 3: Update `DeviceSync`**

In `worker/src/device-sync.ts`:
- Import `ENTITY_CACHE_SECONDS, entityEventsChannel, entityKey, queryGenerationKey` from `@campus/application-contracts` and `type EntityCache` from `./entity-cache`.
- Remove `const purgeBatch = 5000;`.
- Add a `cache: EntityCache` constructor parameter and field.
- Replace the purge loop at the end of `run` with:

```ts
    if (failure === null) {
      const recordPage = z.array(z.object({ deviceId: z.string() }).passthrough());
      for (let after = ''; ; ) {
        const records = recordPage.parse(
          await this.call('SELECT cc.page_device_records($1,$2,$3) AS result', [
            input.customerId,
            after,
            1000,
          ]),
        );
        if (records.length === 0) break;
        await this.cache.setRecords(
          records.map(({ removedAt: _removedAt, ...record }) => ({
            key: entityKey('device', input.customerId, record.deviceId),
            value: JSON.stringify(record),
          })),
          ENTITY_CACHE_SECONDS.device,
        );
        after = records[records.length - 1].deviceId;
      }
      await this.cache.increment(queryGenerationKey('device', input.customerId));
    }
    await this.cache.publish(
      entityEventsChannel(input.customerId),
      JSON.stringify({ type: 'full-sync', sync: state }),
    );
    return state;
```

Update the class comment to: `/** Run one claimed full sync. Publication soft-deletes untouched devices, fills Redis, and signals. */`

- [ ] **Step 4: Wire Redis and the batch runner into `GoogleWorker`**

In `worker/src/google-connection.ts`:
- Import `GoogleDeviceReader` is already there. Add `import { EntitySyncBatch } from './entity-sync';` and `import { WorkerRedis } from './entity-cache';` and `type EntitySyncBatchRequest` from `@campus/application-contracts`.
- Add a field `private redis?: WorkerRedis;` and a method:

```ts
  /** Redis for records, in-flight IDs, and events. The worker user shares the application password. */
  private cache(): WorkerRedis {
    if (this.redis) return this.redis;
    const config = this.config;
    if (!config) throw new Error('connection-store-unavailable');
    const service = config.services.redis;
    const transport = service.endpoint.tls;
    this.redis = new WorkerRedis({
      url: service.endpoint.url,
      password: secret(service.passwordSecretRef).toString('utf8').replace(/\r?\n$/, ''),
      tls:
        transport.mode === 'disabled'
          ? null
          : {
              servername: new URL(service.endpoint.url).hostname,
              ...(transport.mode === 'private-ca' ? { ca: secret(transport.caSecretRef) } : {}),
            },
    });
    return this.redis;
  }
```

- Change `syncDevices` to pass `this.cache()` as the fourth argument, and add:

```ts
  async syncEntityBatch(input: EntitySyncBatchRequest, signal: AbortSignal) {
    const { pool, cipher } = this.resources();
    return new EntitySyncBatch(pool, cipher, new GoogleDeviceReader(), this.cache()).run(input, signal);
  }
```

- In `close()`: `await Promise.all([this.pool?.end(), this.redis?.close()]);`

- [ ] **Step 5: Add the dispatch route**

In `worker/src/dispatch.ts`, import `entitySyncBatchRequestSchema` from `@campus/application-contracts` and `EntityCacheError` from `./entity-cache`. Add:

```ts
const entitySyncDispatchSchema = entitySyncBatchRequestSchema.extend({
  executionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});

export async function handleEntitySyncDispatch(
  request: IncomingMessage,
  response: ServerResponse,
  context: DispatchContext,
  google: GoogleWorker,
): Promise<boolean> {
  if (request.method !== 'POST' || request.url !== '/dispatch/entity-sync-batch')
    return false;
  if (rejected(request, response, context)) return true;
  try {
    const { executionId, ...input } = entitySyncDispatchSchema.parse(await readJson(request));
    const result = await google.syncEntityBatch(input, context.signal);
    respond(response, 200, {
      executionId,
      correlationId: input.correlationId,
      status: result.failure === null ? 'completed' : 'failed',
      failure: result.failure,
      job: result.job,
    });
  } catch (error) {
    if (error instanceof DispatchError) respond(response, error.statusCode, { error: error.code });
    else if (error instanceof z.ZodError) respond(response, 400, { error: 'invalid-payload' });
    else if (error instanceof DeviceSyncError) respond(response, 409, { error: error.code });
    else if (error instanceof EntityCacheError) respond(response, 503, { error: error.code });
    else respond(response, 503, { error: 'entity-sync-unavailable' });
  }
  return true;
}
```

A Google failure returns 200 with `status: 'failed'`, so Kestra does not retry it. A 409 or 503 lets Kestra's retry cover a dead or misconfigured runner.

In `worker/src/main.ts`, import `handleEntitySyncDispatch` and add after the device sync dispatch block:

```ts
  if (
    await handleEntitySyncDispatch(
      request,
      response,
      { secret: dispatchSecret, signal: stopping.signal },
      google,
    )
  )
    return;
```

- [ ] **Step 6: Run the worker tests, lint, and build**

Run: `npm exec -- nx run-many -t test lint build -p worker --skip-nx-cache`
Expected: all PASS. If `lint` flags the unused `_removedAt` destructure, keep it: the rest pattern is how the record drops `removedAt` before caching.

- [ ] **Step 7: Commit**

```bash
git add worker/src
git commit -m "feat: fill Redis after a full sync and dispatch entity sync batches"
```

---

### Task 6: Kestra flow, Redis ACL for the worker, secret mounts, and API Redis set operations

**Files:**
- Create: `deployment/kestra/entity-sync.yaml`
- Modify: `api/src/app/orchestration/orchestration.service.ts`
- Modify: `deployment/redis/runtime.mjs`
- Modify: `docker-compose.yml` (workers `secrets`)
- Modify: `deployment/installer/setup.mjs:1101-1111` (hybrid worker credential list)
- Modify: `deployment/profiles/hybrid/integration.mjs:360-380` (worker container mounts)
- Modify: `api/src/app/cache/cache.service.ts`
- Create: `api/src/app/cache/cache-sets.ts` (plain module: the Lua script and chunking, importable from `node:test`)
- Create: `api/src/app/cache/cache-sets.test.mjs`
- Modify: `api/project.json` (test command also runs `api/src/app/cache/*.test.mjs`)

**Interfaces:**
- `OrchestrationService.startEntitySync({ customerId, jobId, batchCount, correlationId }): Promise<string>` deploys `entity-sync.yaml` as flow `entity_sync` and starts it with inputs `customerId`, `jobId`, `batches` (JSON array string of `0..batchCount-1`), `correlationId`.
- `CacheService.addMembers(key, members: string[], seconds): Promise<string[]>` returns the members that were not already in the set. `CacheService.removeMembers(key, members: string[]): Promise<void>`.
- Redis users: `default` (API) adds `+sadd +srem`. New `worker` user: `~cc:entity:* ~cc:query-gen:* ~cc:entity-inflight:* &cc:entity-events:* -@all +ping +set +del +publish +incr +srem +multi +exec`, same password hash.

- [ ] **Step 1: Write the failing cache and ACL tests**

Create `api/src/app/cache/cache-sets.test.mjs`. `cache.service.ts` carries Nest decorators, which Node's type stripping rejects, so the helpers live in a plain module:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { addMembersScript, memberChunks } from './cache-sets.ts';

test('addMembers chunks members so one EVAL stays small', () => {
  const members = Array.from({ length: 2300 }, (_, index) => `d${index}`);
  const chunks = memberChunks(members);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [1000, 1000, 300]);
});

test('the add script returns only newly added members and refreshes the expiry', () => {
  assert.match(addMembersScript, /SADD/);
  assert.match(addMembersScript, /EXPIRE/);
  assert.match(addMembersScript, /ARGV\[1\]/);
});
```

Add a test to `deployment/redis/probe.test.mjs` (it already imports from `./runtime.mjs`; if it does not, add `import { applicationRedisAcl, workerRedisAcl, renderRedis } from './runtime.mjs';`):

```js
test('the worker user is limited to entity keys, the generation, in-flight sets, and events', () => {
  assert.match(applicationRedisAcl, /\+sadd \+srem/);
  assert.equal(
    workerRedisAcl,
    '~cc:entity:* ~cc:query-gen:* ~cc:entity-inflight:* &cc:entity-events:* -@all +ping +set +del +publish +incr +srem +multi +exec',
  );
});
```

Open `deployment/redis/probe.test.mjs` first. If it renders a configuration through `renderRedis`, also assert the rendered text contains `user worker on #`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import ./libs/application-contracts/test-register.mjs --test api/src/app/cache/cache-sets.test.mjs deployment/redis/probe.test.mjs`
Expected: FAIL. `cache-sets.ts` does not exist and `workerRedisAcl` is not exported.

- [ ] **Step 3: Extend `CacheService`**

Create `api/src/app/cache/cache-sets.ts`:

```ts
/** SADD each member. Return the members that were new. Refresh the set's expiry. */
export const addMembersScript =
  "local added={} for i=2,#ARGV do if redis.call('SADD',KEYS[1],ARGV[i])==1 then added[#added+1]=ARGV[i] end end redis.call('EXPIRE',KEYS[1],tonumber(ARGV[1])) return added";

export function memberChunks(members: readonly string[], size = 1000): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < members.length; start += size)
    chunks.push(members.slice(start, start + size));
  return chunks;
}
```

In `api/src/app/cache/cache.service.ts`, add `import { addMembersScript, memberChunks } from './cache-sets';` and these methods after `expire`:

```ts
  /** Add members to a set with an expiry. Returns the members that were not already present. */
  async addMembers(key: string, members: readonly string[], seconds: number): Promise<string[]> {
    const added: string[] = [];
    for (const chunk of memberChunks(members)) {
      const result = await this.execute((client) =>
        client.eval(addMembersScript, {
          keys: [key],
          arguments: [String(seconds), ...chunk],
        }),
      );
      if (Array.isArray(result)) added.push(...result.map(String));
    }
    return added;
  }
  async removeMembers(key: string, members: readonly string[]): Promise<void> {
    for (const chunk of memberChunks(members))
      await this.execute((client) => client.sRem(key, [...chunk]));
  }
```

- [ ] **Step 4: Add the worker Redis user**

In `deployment/redis/runtime.mjs`:

```js
export const applicationRedisAcl =
  '~cc:* &cc:* -@all +ping +get +getdel +set +del +exists +expire +ttl +eval +sadd +srem';
/** The worker writes records, bumps the query generation, frees in-flight IDs, and publishes events. */
export const workerRedisAcl =
  '~cc:entity:* ~cc:query-gen:* ~cc:entity-inflight:* &cc:entity-events:* -@all +ping +set +del +publish +incr +srem +multi +exec';
```

In `renderRedis`, after the `user default` line add:

```js
    `user worker on #${passwordHash} ${workerRedisAcl}`,
```

Redis checks commands inside `EVAL` scripts against the caller's ACL, so `default` needs `+sadd +srem` for the add script.

- [ ] **Step 5: Mount the Redis password for the workers**

In `docker-compose.yml`, inside `services.workers.secrets`, add after the `campus-database-password` entry:

```yaml
              { 'source': 'redis-password', 'target': 'redis-password' },
```

In `deployment/installer/setup.mjs`, in the `references` array near line 1101 (the hybrid worker credential list), add after `database.endpoint.tls.caSecretRef,`:

```js
      config.services.redis.passwordSecretRef,
      config.services.redis.endpoint.tls.caSecretRef,
```

In `deployment/profiles/hybrid/integration.mjs`, in the `docker run` argument list for the worker container (near line 372), add after the worker-dispatch mount:

```js
      '-v',
      `${join(privateRoot, 'redis-password')}:/run/secrets/redis-password:ro`,
```

Then read the hybrid profile's `profile.json` rendering in that file to confirm `services.redis.passwordSecretRef.path` is `/run/secrets/redis-password` for the worker container. If the path differs, mount at the configured path instead. Kubernetes already mounts every referenced secret into each pod (`deployment/kubernetes/render.mjs` `secrets.map((item) => item.mount)`), so it needs no change.

- [ ] **Step 6: Write the Kestra flow and orchestration method**

Create `deployment/kestra/entity-sync.yaml`:

```yaml
id: entity_sync
namespace: campus.application
inputs:
  - id: customerId
    type: STRING
  - id: jobId
    type: STRING
  - id: batches
    type: STRING
  - id: correlationId
    type: STRING
tasks:
  - id: batches
    type: io.kestra.plugin.core.flow.ForEach
    values: '{{ inputs.batches }}'
    concurrencyLimit: 4
    tasks:
      - id: dispatch
        type: io.kestra.plugin.core.http.Request
        uri: '{{ envs.cc_worker_base_url }}/dispatch/entity-sync-batch'
        method: POST
        contentType: application/json
        headers:
          Authorization: "Bearer {{ secret('CC_WORKER_DISPATCH_TOKEN') }}"
        body: |
          {{ {
            "executionId": execution.id,
            "customerId": inputs.customerId,
            "jobId": inputs.jobId,
            "batch": taskrun.value,
            "correlationId": inputs.correlationId
          } | json }}
        timeout: PT1H
        options:
          timeout:
            connectTimeout: PT3S
            readIdleTimeout: PT1H
        # Only a dead batch runner retries here. Google outcomes return 200 and never retry.
        retry:
          type: constant
          interval: PT5S
          maxAttempts: 3
          warningOnRetry: false
```

`values` accepts a JSON array string. `taskrun.value` is text, which the worker coerces (Task 1).

In `api/src/app/orchestration/orchestration.service.ts`, add after `startDeviceSync`:

```ts
  async startEntitySync(input: {
    customerId: string;
    jobId: string;
    batchCount: number;
    correlationId: string;
  }): Promise<string> {
    const values = z
      .strictObject({
        customerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        jobId: z.uuid(),
        batchCount: z.number().int().min(1).max(1000),
        correlationId: z.uuid(),
      })
      .parse(input);
    await this.deployFlow('entity-sync.yaml', 'entity_sync');
    return this.execute('entity_sync', {
      customerId: values.customerId,
      jobId: values.jobId,
      batches: JSON.stringify(Array.from({ length: values.batchCount }, (_, index) => index)),
      correlationId: values.correlationId,
    });
  }
```

In `api/project.json`, change the `test` command to:

```json
"command": "node --import ./libs/application-contracts/test-register.mjs --test api/src/app/devices/*.test.mjs api/src/app/cache/*.test.mjs"
```

- [ ] **Step 7: Run the tests and lint**

Run: `node --import ./libs/application-contracts/test-register.mjs --test api/src/app/cache/cache-sets.test.mjs deployment/redis/probe.test.mjs` then `npm exec -- nx run-many -t lint test -p api deployment --skip-nx-cache`
Expected: PASS. Open `deployment/release/workflows.test.mjs` and `deployment/kubernetes/render.test.mjs` if either fails on the ACL text and update their expected strings to the new `applicationRedisAcl`.

- [ ] **Step 8: Commit**

```bash
git add deployment/kestra/entity-sync.yaml deployment/redis/runtime.mjs deployment/redis/probe.test.mjs docker-compose.yml deployment/installer/setup.mjs deployment/profiles/hybrid/integration.mjs api/project.json api/src/app/cache api/src/app/orchestration deployment/release deployment/kubernetes
git commit -m "feat: run entity sync batches through Kestra with a worker Redis user"
```

---

### Task 7: API reads one row per device and dispatches stale devices

**Files:**
- Modify: `api/src/app/devices/device-query.ts`
- Modify: `api/src/app/devices/device-query.test.mjs`
- Modify: `api/src/app/devices/devices.service.ts`
- Modify: `api/src/app/devices/devices.controller.ts`
- Create: `api/src/app/devices/device-refresh.ts`
- Create: `api/src/app/devices/device-refresh.test.mjs`

**Interfaces:**
- `device-query.ts`: `from` joins on `customer_id`. Every grid `WHERE` includes `d.removed_at IS NULL`. `deviceColumns` adds `d.last_entity_sync`. `deviceRow(row, cutoff: number): DeviceRow` sets `lastEntitySync` and `stale`. `deviceDetail(row, cutoff): DeviceDetail` sets `removedAt`. New `staleIdsSql(customerId, query, selection, cutoff: Date): SqlStatement` selects the device IDs of the whole result set with `last_entity_sync < cutoff`, capped at 100,000.
- `device-refresh.ts`: `class DeviceRefresh` with `constructor(cache: Pick<CacheService,'addMembers'|'removeMembers'>, orchestration: Pick<OrchestrationService,'startEntitySync'>, store: (sql: string, values: unknown[]) => Promise<unknown>)` and `dispatch(actor: [string, number], customerId: string, ids: string[], correlationId: string): Promise<string | null>`. Returns the job ID, or `null` when nothing new needed a refresh or the refresh could not start.
- `DevicesService.page(session, query, correlationId)` returns `refreshJobId`.

- [ ] **Step 1: Write the failing SQL and refresh tests**

In `api/src/app/devices/device-query.test.mjs`:
- Change the first test's regex to:
  ```js
  /WHERE s\.customer_id=\$1 AND d\.removed_at IS NULL ORDER BY d\.serial_number ASC NULLS LAST,d\.device_id ASC OFFSET \$2 LIMIT \$3$/
  ```
- Every other assertion that matches `WHERE s.customer_id=$1 AND …` gains `AND d.removed_at IS NULL` right after `$1`. Run the file after the implementation and fix each remaining regex the same way.
- Add `staleIdsSql` to the import and append:

```js
test('stale IDs cover the whole result set below the cutoff', () => {
  const cutoff = new Date('2026-10-05T12:00:00.000Z');
  const sql = staleIdsSql('C0123456', deviceQuerySchema.parse({ predicates: hs04Selection, offset: 300, limit: 100 }), null, cutoff);
  assert.match(sql.text, /^SELECT d\.device_id FROM cc\.device_sync_state s JOIN cc\.devices d ON d\.customer_id=s\.customer_id WHERE s\.customer_id=\$1 AND d\.removed_at IS NULL AND d\.asset_tag ILIKE \$2 AND d\.last_entity_sync<\$3::timestamptz ORDER BY d\.device_id LIMIT 100000$/);
  assert.deepEqual(sql.values, ['C0123456', 'HS-04%', cutoff.toISOString()]);
});

test('rows report freshness against the cutoff and details report removal', () => {
  const cutoff = Date.parse('2026-10-05T12:00:00.000Z');
  const base = {
    device_id: 'd1', serial_number: 'S', model: null, asset_tag: null, org_unit_path: '/',
    last_contact: null, annotated_location: null, notes: null, battery_status: 'no-report',
    battery_health: null, battery_capacity_percent: null, battery_reported_at: null,
  };
  const fresh = deviceRow({ ...base, last_entity_sync: new Date('2026-10-05T12:00:00.000Z') }, cutoff);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.lastEntitySync, '2026-10-05T12:00:00.000Z');
  assert.equal(deviceRow({ ...base, last_entity_sync: new Date('2026-10-05T11:00:00.000Z') }, cutoff).stale, true);
  const detail = deviceDetail(
    { ...base, last_entity_sync: new Date('2026-10-06T00:00:00.000Z'), removed_at: new Date('2026-10-06T01:00:00.000Z'), battery_reports: [] },
    cutoff,
  );
  assert.equal(detail.removedAt, '2026-10-06T01:00:00.000Z');
  assert.equal('observedAt' in detail, false);
});
```

Create `api/src/app/devices/device-refresh.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceRefresh } from './device-refresh.ts';

const actor = ['11111111-1111-4111-8111-111111111111', 1];
const correlation = '22222222-2222-4222-8222-222222222222';
const job = (ids) => ({
  jobId: '33333333-3333-4333-8333-333333333333',
  customerId: 'C0123456',
  entityType: 'device',
  batchCount: Math.ceil(ids.length / 100),
  completedBatches: 0,
  failedBatches: 0,
  failure: null,
  createdAt: '2026-10-06T12:00:00.000Z',
  finishedAt: null,
});

function fakes({ added = (members) => members, startFails = false } = {}) {
  const calls = [];
  const cache = {
    async addMembers(key, members, seconds) {
      calls.push({ name: 'addMembers', key, members, seconds });
      return added(members);
    },
    async removeMembers(key, members) {
      calls.push({ name: 'removeMembers', key, members });
    },
  };
  const orchestration = {
    async startEntitySync(input) {
      calls.push({ name: 'startEntitySync', input });
      if (startFails) throw new Error('kestra down');
      return 'execution';
    },
  };
  const store = async (sql, values) => {
    const name = /cc\.(\w+)/.exec(sql)[1];
    calls.push({ name, values });
    if (name === 'create_entity_sync_job') return job(JSON.parse(values[4]));
    return job([]);
  };
  return { calls, refresh: new DeviceRefresh(cache, orchestration, store) };
}

test('stale IDs create one job and start the flow with its batch count', async () => {
  const ids = Array.from({ length: 250 }, (_, index) => `d${index}`);
  const { calls, refresh } = fakes();
  const jobId = await refresh.dispatch(actor, 'C0123456', ids, correlation);
  assert.equal(jobId, '33333333-3333-4333-8333-333333333333');
  assert.deepEqual(calls.map((call) => call.name), ['addMembers', 'create_entity_sync_job', 'startEntitySync']);
  assert.equal(calls[0].key, 'cc:entity-inflight:device:C0123456');
  assert.equal(calls[0].seconds, 120);
  assert.equal(calls[1].values[3], 'device');
  assert.equal(calls[1].values[5], 100);
  assert.equal(calls[2].input.batchCount, 3);
});

test('overlapping stale queries dispatch each device once', async () => {
  const { calls, refresh } = fakes({ added: (members) => members.filter((id) => id === 'd9') });
  await refresh.dispatch(actor, 'C0123456', ['d1', 'd9'], correlation);
  assert.deepEqual(JSON.parse(calls[1].values[4]), ['d9']);
});

test('nothing new means no job', async () => {
  const { calls, refresh } = fakes({ added: () => [] });
  assert.equal(await refresh.dispatch(actor, 'C0123456', ['d1'], correlation), null);
  assert.deepEqual(calls.map((call) => call.name), ['addMembers']);
});

test('a failed flow start abandons the job and frees the IDs', async () => {
  const { calls, refresh } = fakes({ startFails: true });
  assert.equal(await refresh.dispatch(actor, 'C0123456', ['d1'], correlation), null);
  assert.deepEqual(calls.map((call) => call.name), [
    'addMembers',
    'create_entity_sync_job',
    'startEntitySync',
    'abandon_entity_sync_job',
    'removeMembers',
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import ./libs/application-contracts/test-register.mjs --test api/src/app/devices/device-query.test.mjs api/src/app/devices/device-refresh.test.mjs`
Expected: FAIL. `staleIdsSql` is not exported, `deviceRow` ignores the cutoff, and `device-refresh.ts` does not exist.

- [ ] **Step 3: Update the SQL builders**

In `api/src/app/devices/device-query.ts`:
- `const from = 'FROM cc.device_sync_state s JOIN cc.devices d ON d.customer_id=s.customer_id';`
- `export const deviceColumns = \`d.device_id,d.serial_number,d.model,d.asset_tag,d.org_unit_path,d.last_contact,d.annotated_location,d.notes,${batteryStatus} AS battery_status,d.battery_health,d.battery_capacity_percent,d.battery_reported_at,d.last_entity_sync\`;`
- In `deviceWhere`, the base clauses become `['s.customer_id=$1', 'd.removed_at IS NULL', ...]`.
- Add after `devicePageSql`:

```ts
/** Every stale device in the result set, not only the page. The API refreshes them all. */
export function staleIdsSql(
  customerId: string,
  query: DeviceQuery,
  selection: SelectionState | null,
  cutoff: Date,
): SqlStatement {
  const values: unknown[] = [customerId];
  const where = deviceWhere(query.predicates, values, selection, query.group);
  values.push(cutoff.toISOString());
  return {
    text: `SELECT d.device_id ${from} WHERE ${where} AND d.last_entity_sync<$${values.length}::timestamptz ORDER BY d.device_id LIMIT 100000`,
    values,
  };
}
```

- `deviceDetailSql` text becomes: `` `SELECT ${deviceColumns},CASE WHEN s.telemetry_failure IS NOT NULL THEN '[]'::jsonb ELSE d.battery_reports END AS battery_reports,d.removed_at ${from} WHERE s.customer_id=$1 AND d.device_id=$2` `` (a removed device still has details).
- Replace `deviceRow` and `deviceDetail`:

```ts
export function deviceRow(row: Record<string, unknown>, cutoff: number): DeviceRow {
  const lastEntitySync = iso(row['last_entity_sync']);
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
    lastEntitySync,
    stale: typeof lastEntitySync === 'string' && Date.parse(lastEntitySync) < cutoff,
  });
}

export function deviceDetail(row: Record<string, unknown>, cutoff: number): DeviceDetail {
  return deviceDetailSchema.parse({
    ...deviceRow(row, cutoff),
    removedAt: iso(row['removed_at']),
    batteryReports: row['battery_reports'],
  });
}
```

- [ ] **Step 4: Write the refresh dispatcher**

Create `api/src/app/devices/device-refresh.ts`:

```ts
import { randomUUID } from 'node:crypto';
import {
  ENTITY_INFLIGHT_SECONDS,
  ENTITY_SYNC_BATCH_SIZE,
  entitySyncJobSchema,
  inflightKey,
} from '@campus/application-contracts';
import type { CacheService } from '../cache/cache.service';
import type { OrchestrationService } from '../orchestration/orchestration.service';

/**
 * Start one refresh job for stale devices. The in-flight set keeps overlapping
 * queries from dispatching the same device twice within two minutes.
 */
export class DeviceRefresh {
  constructor(
    private readonly cache: Pick<CacheService, 'addMembers' | 'removeMembers'>,
    private readonly orchestration: Pick<OrchestrationService, 'startEntitySync'>,
    private readonly store: (sql: string, values: unknown[]) => Promise<unknown>,
  ) {}

  /** Returns the job ID, or null when nothing new needed a refresh or the flow could not start. */
  async dispatch(
    actor: readonly [string, number],
    customerId: string,
    ids: readonly string[],
    correlationId: string,
  ): Promise<string | null> {
    if (ids.length === 0) return null;
    const key = inflightKey('device', customerId);
    let fresh: string[];
    try {
      fresh = await this.cache.addMembers(key, ids, ENTITY_INFLIGHT_SECONDS);
    } catch {
      return null;
    }
    if (fresh.length === 0) return null;
    const jobId = randomUUID();
    let created = false;
    try {
      const job = entitySyncJobSchema.parse(
        await this.store('SELECT cc.create_entity_sync_job($1,$2,$3,$4,$5,$6,$7,$8) AS result', [
          ...actor,
          customerId,
          'device',
          JSON.stringify(fresh),
          ENTITY_SYNC_BATCH_SIZE,
          jobId,
          correlationId,
        ]),
      );
      created = true;
      await this.orchestration.startEntitySync({
        customerId,
        jobId,
        batchCount: job.batchCount,
        correlationId,
      });
      return jobId;
    } catch {
      if (created)
        await this.store('SELECT cc.abandon_entity_sync_job($1,$2,$3,$4) AS result', [
          ...actor,
          customerId,
          jobId,
        ]).catch(() => undefined);
      await this.cache.removeMembers(key, fresh).catch(() => undefined);
      return null;
    }
  }
}
```

- [ ] **Step 5: Use the cutoff and the dispatcher in the service**

In `api/src/app/devices/devices.service.ts`:
- Import `freshnessCutoff` from `@campus/application-contracts`, `staleIdsSql` from `./device-query`, and `DeviceRefresh` from `./device-refresh`.
- Add a field and assign it in the constructor body. A field initializer would run before the parameter properties exist under ES2022 class-field semantics:

```ts
  private readonly refresh: DeviceRefresh;

  constructor(
    private readonly database: DatabaseService,
    private readonly orchestration: OrchestrationService,
    private readonly cache: CacheService,
  ) {
    this.refresh = new DeviceRefresh(cache, orchestration, (sql, values) =>
      this.result(sql, values),
    );
  }
```

- Change `page` to:

```ts
  async page(
    session: SessionResponse,
    query: DeviceQuery,
    correlationId: string,
  ): Promise<DevicePage> {
    const cutoff = freshnessCutoff('device');
    const read = await this.read(
      session,
      async (client, customerId) => {
        const inventory = await this.inventory(client, customerId);
        const selection = query.selection
          ? await this.storedSelection(session, query.selection)
          : null;
        const sql = devicePageSql(customerId, query, selection);
        const matching = (await client.query(sql.count.text, sql.count.values)).rows[0]?.['matching'];
        const rows = (await client.query(sql.rows.text, sql.rows.values)).rows;
        const stale = await this.deviceIds(client, staleIdsSql(customerId, query, selection, cutoff));
        return {
          customerId,
          stale,
          page: { rows: rows.map((row) => deviceRow(row, cutoff.getTime())), matching: matching ?? 0, ...inventory },
        };
      },
      null,
    );
    if (!read) return { rows: [], matching: 0, total: 0, observedAt: null, refreshJobId: null };
    // The flow starts after the read transaction closes, so the page never waits on Kestra inside Postgres.
    const refreshJobId = await this.refresh.dispatch(
      this.actor(session) as [string, number],
      read.customerId,
      read.stale,
      correlationId,
    );
    return devicePageSchema.parse({ ...read.page, refreshJobId });
  }
```

- In `device`, pass the cutoff: `return row ? deviceDetail(row, freshnessCutoff('device').getTime()) : null;`
- Change `actor` to return a tuple type: `private actor(session: SessionResponse): [string, number] { return [session.identity.id, session.identity.permissionVersion]; }` and remove the `as [string, number]` cast above.

In `api/src/app/devices/devices.controller.ts`, change the query route to pass the correlation ID:

```ts
    return { page: await this.devices.page(request.session, input, request.correlationId) };
```

- [ ] **Step 6: Run the API tests, lint, and build**

Run: `npm exec -- nx run-many -t test lint build -p api --skip-nx-cache`
Expected: PASS. Fix every regex in `device-query.test.mjs` that still lacks `AND d.removed_at IS NULL` after `$1`. The `groups` and `orgUnits` queries also gain it through `deviceWhere`; `deviceOrgUnitsSql` builds its own `WHERE s.customer_id=$1`, so add `AND d.removed_at IS NULL` there too and update its test.

- [ ] **Step 7: Commit**

```bash
git add api/src/app/devices
git commit -m "feat: read one row per device and refresh stale devices from grid queries"
```

---

### Task 8: Adapt the client to the row contract

**Files:**
- Modify: `frontend/src/app/devices/device-detail.html:38-41`
- Modify: `frontend/src/app/devices/device-detail.spec.ts`
- Modify: `frontend/src/app/devices/device-grid.spec.ts`, `device-columns.spec.ts` (if present), `devices.store.spec.ts`, `device-selection.spec.ts`, `devices.spec.ts` (row fixtures)

**Interfaces:**
- Consumes `DeviceRow.lastEntitySync`, `DeviceRow.stale`, `DeviceDetail.removedAt` from Task 1. No new UI behavior beyond the two detail lines. The stale banner, per-row marker, and SSE arrive in Plan B.

- [ ] **Step 1: Update the detail template**

In `frontend/src/app/devices/device-detail.html`, replace the "Inventory observed" paragraph with:

```html
      <p class="secondary">
        Read from Google {{ current.lastEntitySync | date: 'MMM d, h:mm a' }}
      </p>
      @if (current.removedAt) {
        <p class="secondary">
          Google no longer returns this device (since
          {{ current.removedAt | date: 'MMM d, h:mm a' }}).
        </p>
      }
```

- [ ] **Step 2: Update the spec fixtures**

Run: `grep -rn "observedAt\|serialNumber: '" frontend/src/app/devices/*.spec.ts`

For every object literal that builds a `DeviceRow` or `DeviceDetail` (it has `deviceId` and `serialNumber`), add `lastEntitySync: '2026-10-05T12:00:00.000Z', stale: false`. For every `DeviceDetail` literal (it has `batteryReports`), replace `observedAt: …` with `removedAt: null`. Leave `page.observedAt` and `sync.observedAt` fixtures as they are: the page and sync state keep that field. Add `refreshJobId: null` to each `page` fixture.

In `device-detail.spec.ts`, where the test asserts the "Inventory observed" text, assert `Read from Google` instead, and add one test:

```ts
it('names a removed device', async () => {
  const { fixture } = await setup({ ...detail, removedAt: '2026-10-06T01:00:00.000Z' });
  expect(fixture.nativeElement.textContent).toContain('Google no longer returns this device');
});
```

Use that file's existing `setup` helper and `detail` fixture names. Read the file before editing: if the helper has a different name, call that one.

- [ ] **Step 3: Run the frontend tests, lint, and build**

Run: `npm exec -- nx run-many -t test lint build -p frontend --skip-nx-cache`
Expected: PASS. A failing `strictObject` parse in a spec means a fixture still lacks the new fields.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/devices
git commit -m "feat: show each device's last Google read and removal in details"
```

---

### Task 9: Simulator, end-to-end checks, and documentation

**Files:**
- Modify: `api-e2e/google-connection-preload.cjs`
- Modify: `api-e2e/devices-api.mjs`
- Modify: `api-e2e/auth.test.mjs:2373-2381` (pass `migrator`)
- Modify: `docs/workflows/device-browsing.md` (implementation defaults)
- Modify: `docs/document-index.csv`

**Interfaces:**
- The simulator answers `POST https://www.googleapis.com/batch/admin/directory_v1` with a multipart response, one part per `GET …/devices/chromeos/{id}` in the body. Unknown IDs get a 404 part. Fault `device-removed` makes `synthetic-device-3` a 404 part. Fault `device-quota` answers the first batch call with a 429 part and later calls normally. It answers `GET https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices/{id}` with that device's telemetry or 404.
- `qualifyDevicesApi` gains an optional `migrator` (a `pg` client on the application database) and uses it to age rows.

- [ ] **Step 1: Extend the simulator**

In `api-e2e/google-connection-preload.cjs`, add before the `else throw new Error('Unexpected synthetic Google endpoint.')` branch:

```js
  } else if (
    url.hostname === 'www.googleapis.com' &&
    url.pathname === '/batch/admin/directory_v1'
  ) {
    if (fault === 'device-privilege-denied') throw forbidden(options);
    quotaCalls += 1;
    const ids = [
      ...String(options.body).matchAll(
        /GET \/admin\/directory\/v1\/customer\/C0123456\/devices\/chromeos\/([A-Za-z0-9_-]+)/g,
      ),
    ].map((match) => decodeURIComponent(match[1]));
    const parts = ids.map((id) => {
      const found = fleet.find((device) => device.deviceId === id);
      const removed = fault === 'device-removed' && id === 'synthetic-device-3';
      const quota = fault === 'device-quota' && quotaCalls === 1;
      const status = quota ? 429 : found && !removed ? 200 : 404;
      const body =
        status === 200
          ? (({ capacity: _capacity, ...device }) => device)(found)
          : { error: { code: status, message: status === 429 ? 'Rate Limit Exceeded' : 'Resource Not Found: deviceId' } };
      return [
        '--batch_synthetic',
        'Content-Type: application/http',
        `Content-ID: <response-item-${id}>`,
        '',
        `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify(body),
        '',
      ].join('\r\n');
    });
    return {
      data: `${parts.join('\r\n')}\r\n--batch_synthetic--\r\n`,
      status: 200,
      headers: { 'content-type': 'multipart/mixed; boundary=batch_synthetic' },
    };
  } else if (
    url.hostname === 'chromemanagement.googleapis.com' &&
    url.pathname.startsWith('/v1/customers/C0123456/telemetry/devices/')
  ) {
    if (fault === 'telemetry-privilege-denied') throw forbidden(options);
    const id = decodeURIComponent(url.pathname.split('/').at(-1));
    const found = fleet.find((device) => device.deviceId === id);
    if (!found) {
      const missing = new Error('not found');
      missing.response = { config: options, status: 404, data: { error: { code: 404 } } };
      throw missing;
    }
    data = telemetry(found);
```

Declare `let quotaCalls = 0;` near the top of the file, next to `fleet`. Read how the existing handler returns `data` at the end of the function and keep the telemetry branch consistent with it (it falls through to `return { data, status: 200 }`).

- [ ] **Step 2: Extend the API end-to-end check**

In `api-e2e/devices-api.mjs`, add `migrator` to the destructured parameters. After the `first` page assertions, add:

```js
    assert.equal(first.refreshJobId, null);
    assert.equal(first.rows[0].stale, false);
    assert.match(first.rows[0].lastEntitySync, /^\d{4}-\d{2}-\d{2}T/);
    const detail = await api.get(`${root}/synthetic-device-0`);
    assert.equal(detail.status(), 200, await detail.text());
    assert.equal((await detail.json()).device.removedAt, null);
```

After the groups assertions (end of the existing flow, before the `finally`), add:

```js
    if (migrator) {
      await migrator.query(
        "UPDATE cc.devices SET last_entity_sync=now()-interval '2 days' WHERE device_id IN ('synthetic-device-0','synthetic-device-1','synthetic-device-3')",
      );
      await fault('device-removed');
      const stalePage = await query({ predicates: [{ field: 'orgUnitPath', operator: 'in', values: ['/School A', '/School B', '/'] }], limit: 5 });
      assert.ok(stalePage.refreshJobId, 'Stale rows start a refresh job.');
      assert.equal(stalePage.rows.find((row) => row.deviceId === 'synthetic-device-0').stale, true);
      const again = await query({ limit: 5 });
      assert.equal(again.refreshJobId, null, 'The in-flight set stops a second dispatch.');
      let refreshed;
      for (let attempt = 0; attempt < 120; attempt++) {
        refreshed = await query({ predicates: [{ field: 'serialNumber', operator: 'equals', value: 'C0A1-0000' }] });
        if (refreshed.rows[0]?.stale === false) break;
        await setTimeout(500);
      }
      assert.equal(refreshed.rows[0].stale, false, 'The batch refreshed the device.');
      assert.equal(refreshed.total, 449, 'The 404 device left the inventory count.');
      const removed = await api.get(`${root}/synthetic-device-3`);
      assert.equal(removed.status(), 200);
      assert.ok((await removed.json()).device.removedAt);
      assert.equal((await query({ predicates: [{ field: 'serialNumber', operator: 'equals', value: 'C0A1-0003' }] })).matching, 0);
      await fault('none');
      const restored = await run();
      assert.equal(restored.deviceCount, 450, 'A full sync returns the device.');
    }
```

Read the rest of `devices-api.mjs` first: `total` comes from `device_sync_state.device_count`, which a full sync sets. If the entity batch does not change `total`, drop the `449` assertion and assert `matching` for serial `C0A1-0003` is `0` only. `fault('none')` must match how the simulator reads a cleared fault; use the existing convention in that file (an `rm` of the fault file if that is what the simulator expects).

In `api-e2e/auth.test.mjs`, add `migrator,` to the `qualifyDevicesApi({ … })` call (the sibling call directly above already passes `migrator`).

- [ ] **Step 3: Run the end-to-end checks**

Run: `npm exec -- nx run api-e2e:phase3-auth-integration --skip-nx-cache`
Expected: PASS, including the devices API and devices browser sections. The browser section still passes because the stale banner and `Refresh inventory` flow are unchanged in this plan.

If the batch dispatch 503s with `cache-unavailable`, check that the workers container received the `redis-password` secret (Task 6) and that the Redis ACL renders the `worker` user.

- [ ] **Step 4: Record the implementation defaults**

In `docs/workflows/device-browsing.md`, under `## Implementation defaults — 2026-10-05`, append:

```markdown
- A refresh job holds 100 devices per batch. Kestra runs four batches at a time. The in-flight set expires after two minutes.
- The grid and counts exclude removed devices. Device details still open a removed device and name the removal time.
- A refresh that cannot start leaves the page as it is. The next query tries again.
- The status bar and group counts still show the last full sync time. Device details show the device's own last Google read.
```

In `docs/document-index.csv`, append one line for `docs/superpowers/plans/2026-10-06-entity-cache-backend.md` in the same format as the other plan rows:

```
docs/superpowers/plans/2026-10-06-entity-cache-backend.md,Implementation plan,Entity Cache Backend Implementation Plan,Task plan for per-device freshness and entity sync batches; implements docs/superpowers/specs/2026-10-06-entity-cache-decisions.md,"Plan written, 2026-10-06","Global Constraints; Review Focus; Task 1 through Task 9; After this plan"
```

- [ ] **Step 5: Run every affected project once**

Run: `npm exec -- nx run-many -t lint test build -p application-contracts google-connection worker api frontend deployment --skip-nx-cache`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api-e2e docs
git commit -m "test: refresh stale devices end to end and record the defaults"
```

---

## After this plan

Plan B (`2026-10-06-entity-cache-client.md`, to be written after this plan lands) implements:

- D1 and D2: the Redis query cache (`cc:query:device:{customer}:{gen}:{hash}`, whole ordered ID list, 5 minute TTL) in `DevicesService.page`, hydrated from `cc:entity:*` with Postgres for misses.
- D7: `POST /api/devices/by-ids`, Redis-first per ID.
- D6 and D12: `GET /api/devices/events` (SSE) backed by one Redis subscriber per API instance on `cc:entity-events:{customer}`, the edge route allowance and its 45 second upstream timeout exemption for that path, and the store's `EventSource` with reconnect reconciliation. The 2 second poll is removed.
- D11: the repurposed banner ("Refreshing N of M devices") and the muted Last contact cell with the tooltip "Refreshing from Google", after re-inspecting Figma frame `108:605`.
- The browser e2e for the stale → refresh → in-place update flow and the evidence update.
