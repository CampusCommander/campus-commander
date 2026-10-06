import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { GoogleConnectionError } from '@campus/google-connection';
import { EntitySyncBatch } from './entity-sync.ts';
import { DeviceSyncError } from './device-sync.ts';
import { EntityCacheError } from './entity-cache.ts';

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

const clock = new Date('2026-10-06T11:59:59.123Z');
function database({ fail = {}, finish = job() } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      const name = (/cc\.(\w+)/.exec(sql) ?? /(\w+)\(\)/.exec(sql))[1];
      calls.push({ name, values });
      if (name === 'clock_timestamp') return { rows: [{ result: clock }] };
      if (fail[name])
        throw Object.assign(new Error(name), {
          code: 'P0001',
          detail: fail[name],
        });
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
      if (name === 'finish_entity_sync_batch')
        return { rows: [{ result: finish }] };
      return { rows: [{ result: 1 }] };
    },
  };
}
function cache() {
  const calls = [];
  const note =
    (name) =>
    async (...args) =>
      void calls.push({ name, args });
  return {
    calls,
    setRecords: note('setRecords'),
    remove: note('remove'),
    removeMembers: note('removeMembers'),
    extendMembers: note('extendMembers'),
    increment: note('increment'),
    publish: note('publish'),
    close: async () => undefined,
  };
}
const cipher = {
  open: () => ({ subject: 'fixture@example.invalid', serviceAccount: {} }),
};
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
    reader({
      devices: [{ devices: [device('d1'), device('d3')], missing: ['d2'] }],
    }),
    redis,
    noSleep,
  ).run(request, AbortSignal.timeout(5000));
  assert.deepEqual(names(db.calls), [
    'read_entity_sync_batch',
    'clock_timestamp',
    'upsert_devices',
    'upsert_device_batteries',
    'soft_delete_devices',
    'read_device_records',
    'finish_entity_sync_batch',
  ]);
  assert.deepEqual(
    JSON.parse(db.calls[2].values[1]).map((d) => d.deviceId),
    ['d1', 'd3'],
  );
  assert.equal(db.calls[2].values[2], clock.toISOString());
  assert.deepEqual(JSON.parse(db.calls[4].values[1]), ['d2']);
  assert.deepEqual(db.calls[6].values, [customerId, jobId, 0, null]);
  assert.deepEqual(names(redis.calls), [
    'setRecords',
    'remove',
    'removeMembers',
    'publish',
  ]);
  assert.deepEqual(
    redis.calls[0].args[0].map((entry) => entry.key),
    ['cc:entity:device:C0123456:d1', 'cc:entity:device:C0123456:d3'],
  );
  assert.equal(redis.calls[0].args[1], 86400);
  assert.equal(
    JSON.parse(redis.calls[0].args[0][0].value).stale,
    undefined,
    'Redis stores records without stale.',
  );
  assert.deepEqual(redis.calls[1].args[0], ['cc:entity:device:C0123456:d2']);
  assert.deepEqual(redis.calls[2].args, [
    'cc:entity-inflight:device:C0123456',
    ['d1', 'd2', 'd3'],
  ]);
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
  assert.deepEqual(result, {
    job: job(),
    updated: ['d1', 'd3'],
    removed: ['d2'],
    failure: null,
  });
});

test('the last batch publishes job-finished', async () => {
  const finished = job({
    completedBatches: 2,
    finishedAt: '2026-10-06T12:01:00.000Z',
  });
  const redis = cache();
  await new EntitySyncBatch(
    database({ finish: finished }),
    cipher,
    reader(),
    redis,
    noSleep,
  ).run({ ...request, batch: 1 }, AbortSignal.timeout(5000));
  assert.deepEqual(JSON.parse(redis.calls.at(-1).args[1]), {
    type: 'job-finished',
    job: finished,
  });
});

test('quota errors retry until Google answers', async () => {
  const waits = [];
  const runner = new EntitySyncBatch(
    database(),
    cipher,
    reader({
      devices: [
        new GoogleConnectionError('quota'),
        new GoogleConnectionError('quota'),
      ],
      batteries: [new GoogleConnectionError('quota')],
    }),
    cache(),
    {
      backoff: (attempt) => attempt * 10,
      sleep: async (ms) => void waits.push(ms),
    },
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
    (error) =>
      error instanceof DeviceSyncError && error.code === 'worker-stopping',
  );
});

test('any other Google error fails the batch and frees the in-flight IDs', async () => {
  const db = database({
    finish: job({
      completedBatches: 0,
      failedBatches: 1,
      failure: 'scope-mismatch',
    }),
  });
  const redis = cache();
  const result = await new EntitySyncBatch(
    db,
    cipher,
    reader({ devices: [new GoogleConnectionError('scope-mismatch')] }),
    redis,
    noSleep,
  ).run(request, AbortSignal.timeout(5000));
  assert.deepEqual(names(db.calls), [
    'read_entity_sync_batch',
    'clock_timestamp',
    'finish_entity_sync_batch',
  ]);
  assert.deepEqual(db.calls[2].values, [
    customerId,
    jobId,
    0,
    'scope-mismatch',
  ]);
  assert.deepEqual(names(redis.calls), ['removeMembers']);
  assert.equal(result.failure, 'scope-mismatch');
  assert.deepEqual(result.updated, []);
});

test('a changed job stops before Google access', async () => {
  const db = database({
    fail: { read_entity_sync_batch: 'entity-sync-changed' },
  });
  await assert.rejects(
    new EntitySyncBatch(db, cipher, reader(), cache(), noSleep).run(
      request,
      AbortSignal.timeout(5000),
    ),
    (error) =>
      error instanceof DeviceSyncError && error.code === 'entity-sync-changed',
  );
  assert.deepEqual(names(db.calls), ['read_entity_sync_batch']);
});

test('a cache fault propagates so Kestra retries the runner', async () => {
  const db = database();
  const redis = cache();
  redis.setRecords = async () => {
    throw new EntityCacheError();
  };
  await assert.rejects(
    new EntitySyncBatch(db, cipher, reader(), redis, noSleep).run(
      request,
      AbortSignal.timeout(5000),
    ),
    (error) => error instanceof EntityCacheError,
  );
  assert.ok(!names(db.calls).includes('finish_entity_sync_batch'));
});

test('shutdown during a Google read surfaces worker-stopping', async () => {
  const stopping = new AbortController();
  const source = reader();
  source.deviceBatch = async () => {
    stopping.abort();
    throw new GoogleConnectionError('network-failure');
  };
  await assert.rejects(
    new EntitySyncBatch(database(), cipher, source, cache(), noSleep).run(
      request,
      stopping.signal,
    ),
    (error) =>
      error instanceof DeviceSyncError && error.code === 'worker-stopping',
  );
});

test('a failed job-finished publish does not fail the batch', async () => {
  const finished = job({
    completedBatches: 2,
    finishedAt: '2026-10-06T12:01:00.000Z',
  });
  const redis = cache();
  redis.publish = async (_channel, message) => {
    if (message.includes('"job-finished"')) throw new EntityCacheError();
  };
  const result = await new EntitySyncBatch(
    database({ finish: finished }),
    cipher,
    reader(),
    redis,
    noSleep,
  ).run({ ...request, batch: 1 }, AbortSignal.timeout(5000));
  assert.ok(result.job.finishedAt);
});

test('a telemetry failure keeps the batch devices and skips the battery upsert', async () => {
  const db = database();
  const redis = cache();
  const result = await new EntitySyncBatch(
    db,
    cipher,
    reader({
      devices: [{ devices: [device('d1'), device('d3')], missing: ['d2'] }],
      batteries: [new GoogleConnectionError('permission-denied')],
    }),
    redis,
    noSleep,
  ).run(request, AbortSignal.timeout(5000));
  assert.deepEqual(names(db.calls), [
    'read_entity_sync_batch',
    'clock_timestamp',
    'upsert_devices',
    'soft_delete_devices',
    'read_device_records',
    'finish_entity_sync_batch',
  ]);
  assert.deepEqual(db.calls.at(-1).values, [customerId, jobId, 0, null]);
  assert.deepEqual(names(redis.calls), [
    'setRecords',
    'remove',
    'removeMembers',
    'publish',
  ]);
  assert.equal(JSON.parse(redis.calls[3].args[1]).type, 'entity-batch');
  assert.equal(result.failure, null);
  assert.deepEqual(result.updated, ['d1', 'd3']);
  assert.deepEqual(result.removed, ['d2']);
});

test('a quota answer from telemetry still retries and writes batteries', async () => {
  const db = database();
  const source = reader({
    batteries: [
      new GoogleConnectionError('quota'),
      [{ deviceId: 'd1', battery: { status: 'no-report' }, reports: [] }],
    ],
  });
  const result = await new EntitySyncBatch(
    db,
    cipher,
    source,
    cache(),
    noSleep,
  ).run(request, AbortSignal.timeout(5000));
  assert.equal(result.failure, null);
  assert.equal(
    names(source.calls).filter((name) => name === 'batteryBatch').length,
    2,
  );
  const upsert = db.calls.find((call) => call.name === 'upsert_device_batteries');
  assert.deepEqual(JSON.parse(upsert.values[1]).map((b) => b.deviceId), ['d1']);
});

test('the freshness stamp comes from Postgres before the Directory read', async () => {
  const db = database();
  const source = reader();
  const deviceBatch = source.deviceBatch;
  source.deviceBatch = async (...args) => {
    db.calls.push({ name: 'deviceBatch', values: [] });
    return deviceBatch(...args);
  };
  await new EntitySyncBatch(db, cipher, source, cache(), noSleep).run(
    request,
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(names(db.calls).slice(0, 4), [
    'read_entity_sync_batch',
    'clock_timestamp',
    'deviceBatch',
    'upsert_devices',
  ]);
  const upsert = db.calls.find((call) => call.name === 'upsert_devices');
  assert.equal(upsert.values[2], clock.toISOString());
});

test('a quota sleep extends the batch claim on its in-flight IDs', async () => {
  const redis = cache();
  const waits = [];
  await new EntitySyncBatch(
    database(),
    cipher,
    reader({
      devices: [new GoogleConnectionError('quota')],
      batteries: [new GoogleConnectionError('quota')],
    }),
    redis,
    { backoff: () => 0, sleep: async () => void waits.push(redis.calls.length) },
  ).run(request, AbortSignal.timeout(5000));
  const extended = redis.calls.filter((call) => call.name === 'extendMembers');
  assert.equal(extended.length, 2);
  for (const call of extended)
    assert.deepEqual(call.args, [
      'cc:entity-inflight:device:C0123456',
      ['d1', 'd2', 'd3'],
      120,
    ]);
  assert.deepEqual(
    waits.map((count) => redis.calls[count - 1].name),
    ['extendMembers', 'extendMembers'],
    'Each extension precedes its sleep.',
  );
});

test('a failed claim extension does not stop the quota retry', async () => {
  const redis = cache();
  redis.extendMembers = async () => {
    throw new EntityCacheError();
  };
  const result = await new EntitySyncBatch(
    database(),
    cipher,
    reader({ devices: [new GoogleConnectionError('quota')] }),
    redis,
    noSleep,
  ).run(request, AbortSignal.timeout(5000));
  assert.equal(result.failure, null);
  assert.deepEqual(result.updated, ['d1', 'd2', 'd3']);
});
