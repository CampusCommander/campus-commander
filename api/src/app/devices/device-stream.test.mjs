import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceStreamEventSchema } from '@campus/application-contracts';
import {
  deviceForward,
  recheckDeviceStream,
  withoutFailures,
} from './device-stream.ts';

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

const CUSTOMER = 'C0123456';
const ACTOR = '44444444-4444-4444-8444-444444444444';
const session = (grants = []) => ({
  identity: {
    id: ACTOR,
    displayName: 'Grace Hopper',
    permissions: ['identity:read'],
    permissionVersion: 1,
    grants,
    preferences: { theme: 'system', navigationCollapsed: false },
  },
  expiresAt: '2026-10-06T13:00:00.000Z',
  csrfToken: 'a'.repeat(64),
});

/** The ping of one Devices stream with the session, the sync, and the visibility of the caller. */
function ping({
  next = session([
    {
      action: 'devices:read',
      scope: { kind: 'district', customerId: CUSTOMER },
    },
  ]),
  sync_ = { customerId: CUSTOMER },
  visibility = false,
  failure = null,
} = {}) {
  const calls = { authenticate: [], current: [], jobVisibility: [] };
  return {
    calls,
    run: (seesEveryJob) =>
      recheckDeviceStream({
        auth: {
          async authenticate(cookie, action, correlationId, options) {
            calls.authenticate.push([cookie, action, correlationId, options]);
            if (failure) throw failure;
            return next;
          },
        },
        reads: {
          async current(seen) {
            calls.current.push(seen);
            return typeof sync_ === 'function' ? sync_(seen) : sync_;
          },
          jobVisibility(seen, customerId) {
            calls.jobVisibility.push([seen, customerId]);
            return typeof visibility === 'function'
              ? visibility(seen, customerId)
              : visibility;
          },
        },
        cookie: 'sid=abc',
        correlationId: 'correlation-1',
        customerId: CUSTOMER,
        seesEveryJob,
      }),
  };
}

test('a ping rechecks identity without sliding the session and keeps the Devices stream', async () => {
  const probe = ping();
  const checked = await probe.run(false);
  assert.equal(checked.allowed, true);
  assert.equal(checked.session.identity.id, ACTOR);
  assert.deepEqual(probe.calls.authenticate, [
    ['sid=abc', 'identity:read', 'correlation-1', { slide: false }],
  ]);
  assert.equal(probe.calls.current.length, 1);
});

test('a ping closes the Devices stream when devices:read was removed', async () => {
  const checked = await ping({ sync_: null }).run(false);
  assert.equal(checked.allowed, false);
});

test('a ping closes the Devices stream when jobs:read was removed from a holder of every job', async () => {
  const checked = await ping({ visibility: false }).run(true);
  assert.equal(checked.allowed, false);
});

test('a ping closes the Devices stream when jobs:read was granted to a caller that reads its own jobs', async () => {
  const checked = await ping({ visibility: true }).run(false);
  assert.equal(checked.allowed, false);
});

test('a ping closes the Devices stream when the session check fails', async () => {
  const checked = await ping({ failure: new Error('session-expired') }).run(
    false,
  );
  assert.deepEqual(checked, { allowed: false, session: null });
});
