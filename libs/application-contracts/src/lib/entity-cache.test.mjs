import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENTITY_FRESHNESS_HOURS,
  ENTITY_EVENTS_PING_SECONDS,
  QUERY_CACHE_MAX_IDS,
  QUERY_CACHE_SECONDS,
  entityEventSchema,
  entityKey,
  entitySyncBatchRequestSchema,
  entitySyncJobSchema,
  freshnessCutoff,
  inflightKey,
  isStale,
  queryGenerationKey,
  entityEventsChannel,
  queryCacheKey,
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
  assert.equal(
    entityKey('device', 'C0123456', 'd1'),
    'cc:entity:device:C0123456:d1',
  );
  assert.equal(
    queryGenerationKey('device', 'C0123456'),
    'cc:query-gen:device:C0123456',
  );
  assert.equal(
    inflightKey('device', 'C0123456'),
    'cc:entity-inflight:device:C0123456',
  );
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
  assert.equal(
    entitySyncBatchRequestSchema.safeParse({ ...request, batch: -1 }).success,
    false,
  );
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
  assert.equal(
    entityEventSchema.parse({ type: 'job-finished', job }).type,
    'job-finished',
  );
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

test('the Redis record schema accepts cc.device_record output without removedAt and rejects stale', async () => {
  const { deviceRecordSchema } = await import('./devices.ts');
  const record = {
    deviceId: 'synthetic-device-0',
    serialNumber: 'C0A1-0000',
    model: 'Lenovo 100e Gen 4',
    assetTag: 'HS-0400',
    orgUnitPath: '/School A',
    lastContact: '2026-10-05T12:00:00+00:00',
    annotatedLocation: null,
    notes: null,
    battery: {
      status: 'reported',
      health: 'replace-soon',
      capacityPercent: 78,
      reportedAt: '2026-10-05T13:50:00+00:00',
    },
    lastEntitySync: '2026-10-06T12:00:00.123456+00:00',
  };
  assert.deepEqual(deviceRecordSchema.parse(record), record);
  assert.equal(
    deviceRecordSchema.safeParse({ ...record, stale: false }).success,
    false,
  );
  assert.equal(
    deviceRecordSchema.safeParse({ ...record, removedAt: null }).success,
    false,
  );
});

test('query cache names carry the query generation and expire after five minutes', () => {
  assert.equal(QUERY_CACHE_SECONDS, 300);
  assert.equal(QUERY_CACHE_MAX_IDS, 100_000);
  assert.equal(ENTITY_EVENTS_PING_SECONDS, 25);
  assert.equal(
    queryCacheKey('device', 'C0123456', '7', 'abc'),
    'cc:query:device:C0123456:7:abc',
  );
});
