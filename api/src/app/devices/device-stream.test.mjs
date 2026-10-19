import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceStreamEventSchema } from '@campus/application-contracts';
import { deviceForward, withoutFailures } from './device-stream.ts';

const job = {
  jobId: '33333333-3333-4333-8333-333333333333',
  customerId: 'C0123456',
  entityType: 'device',
  batchCount: 1,
  completedBatches: 0,
  failedBatches: 1,
  failure: 'quota',
  createdAt: '2026-10-06T12:00:00.000Z',
  finishedAt: '2026-10-06T12:01:00.000Z',
};
const sync = {
  customerId: 'C0123456',
  generation: 1,
  status: 'failed',
  observedAt: '2026-10-06T12:00:00.000Z',
  deviceCount: 10,
  failure: 'network-failure',
  telemetryFailure: 'quota',
  startedAt: '2026-10-06T11:00:00.000Z',
  checkedAt: '2026-10-06T12:00:00.000Z',
  stale: false,
};
const batch = {
  type: 'entity-batch',
  jobId: job.jobId,
  entityType: 'device',
  batch: 0,
  batchCount: 1,
  deviceIds: ['d1'],
  removedIds: ['d2'],
};
const reads = (overrides = {}) => ({
  jobFailure: async () => null,
  sync: async () => null,
  ...overrides,
});

test('an entity batch loses the job ID and the batch counters', async () => {
  const forwarded = await deviceForward(false, reads())(batch, false);
  assert.deepEqual(forwarded, {
    event: {
      type: 'entity-batch',
      entityType: 'device',
      deviceIds: ['d1'],
      removedIds: ['d2'],
    },
  });
  assert.equal(
    deviceStreamEventSchema.safeParse({
      ...forwarded.event,
      jobId: batch.jobId,
    }).success,
    false,
  );
});

test('a caller without jobs:read reads the failure of another job as null', async () => {
  const forwarded = await deviceForward(
    false,
    reads({ jobFailure: async () => null }),
  )({ type: 'job-finished', job }, false);
  assert.deepEqual(forwarded, {
    event: { type: 'job-finished', failure: null },
  });
});

test('a caller without jobs:read receives the failure of its own job', async () => {
  let asked;
  const forwarded = await deviceForward(
    false,
    reads({
      jobFailure: async (jobId) => {
        asked = jobId;
        return 'quota';
      },
    }),
  )({ type: 'job-finished', job }, false);
  assert.equal(asked, job.jobId);
  assert.deepEqual(forwarded, {
    event: { type: 'job-finished', failure: 'quota' },
  });
});

test('a holder of jobs:read receives the job failure without a read', async () => {
  let read = 0;
  const forwarded = await deviceForward(
    true,
    reads({
      jobFailure: async () => {
        read += 1;
        return null;
      },
    }),
  )({ type: 'job-finished', job }, false);
  assert.equal(read, 0);
  assert.deepEqual(forwarded, {
    event: { type: 'job-finished', failure: 'quota' },
  });
});

test('a failed job read sends a null failure and ends the stream', async () => {
  const forwarded = await deviceForward(
    false,
    reads({
      jobFailure: async () => {
        throw new Error('store down');
      },
    }),
  )({ type: 'job-finished', job }, true);
  assert.deepEqual(forwarded, {
    event: { type: 'job-finished', failure: null },
    end: true,
  });
});

test('a full sync of a caller without jobs:read reads its own projection', async () => {
  const forwarded = await deviceForward(
    false,
    reads({
      sync: async () => ({ ...sync, failure: null, telemetryFailure: null }),
    }),
  )({ type: 'full-sync', sync }, false);
  assert.deepEqual(forwarded?.event, {
    type: 'full-sync',
    sync: { ...sync, failure: null, telemetryFailure: null },
  });
});

test('a missing projection drops the failures of the event', async () => {
  const forwarded = await deviceForward(false, reads())(
    {
      type: 'full-sync',
      sync,
    },
    false,
  );
  assert.deepEqual(forwarded?.event, {
    type: 'full-sync',
    sync: withoutFailures(sync),
  });
});

test('a holder of jobs:read receives the sync unchanged', async () => {
  const forwarded = await deviceForward(true, reads())(
    {
      type: 'full-sync',
      sync,
    },
    false,
  );
  assert.deepEqual(forwarded?.event, { type: 'full-sync', sync });
});

test('a failed full-sync read sends null failures and ends the stream', async () => {
  const forwarded = await deviceForward(false, reads())(
    {
      type: 'full-sync',
      sync,
    },
    true,
  );
  assert.deepEqual(forwarded, {
    event: { type: 'full-sync', sync: withoutFailures(sync) },
    end: true,
  });
});

test('a job-changed event has no Devices stream event', async () => {
  const forwarded = await deviceForward(true, reads())(
    // The channel schema rejects this event. The mapping still maps it to none.
    {
      type: 'job-changed',
      jobId: job.jobId,
      displayId: 'UPD-006',
      revision: 1,
      requestedBy: job.jobId,
    },
    false,
  );
  assert.equal(forwarded, null);
});
