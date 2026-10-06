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
