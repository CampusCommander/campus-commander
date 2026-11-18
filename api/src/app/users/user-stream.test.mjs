import assert from 'node:assert/strict';
import test from 'node:test';
import {
  recheckUserStream,
  userForward,
  userWithoutFailures,
} from './user-stream.ts';

const CUSTOMER = 'C0123456';
const OTHER = 'C0999999';
const ACTOR = '44444444-4444-4444-8444-444444444444';
const JOB_ID = '33333333-3333-4333-8333-333333333333';

/** The user sync state of the customer. Its times sit next to the test clock. */
const syncState = (customerId = CUSTOMER, failure = null) => {
  const now = Date.now();
  return {
    customerId,
    generation: 1,
    status: 'ready',
    observedAt: new Date(now - 60_000).toISOString(),
    userCount: 5,
    failure,
    startedAt: new Date(now - 120_000).toISOString(),
    checkedAt: new Date(now - 60_000).toISOString(),
    stale: false,
  };
};

/** One channel event of the entity channel, as the worker publishes it. */
const batch = (entityType = 'user') => ({
  type: 'entity-batch',
  jobId: JOB_ID,
  entityType,
  batch: 0,
  batchCount: 1,
  deviceIds: ['user-1', 'user-2'],
  removedIds: ['user-3'],
});

const finished = (entityType = 'user', failure = 'quota') => ({
  type: 'job-finished',
  job: {
    jobId: JOB_ID,
    customerId: CUSTOMER,
    entityType,
    batchCount: 1,
    completedBatches: 0,
    failedBatches: 1,
    failure,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    finishedAt: new Date(Date.now() - 60_000).toISOString(),
  },
});

/** One session with the grants that the case names. */
const session = (grants = []) => ({
  identity: {
    id: ACTOR,
    displayName: 'Grace Hopper',
    permissions: ['identity:read'],
    permissionVersion: 1,
    grants,
    preferences: { theme: 'system', navigationCollapsed: false },
  },
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  csrfToken: 'a'.repeat(64),
});
const district = (action, customerId = CUSTOMER) => ({
  action,
  scope: { kind: 'district', customerId },
});

test('the users feed forwards a user batch with its entity type and user IDs', async () => {
  const forward = userForward(false, {
    jobFailure: async () => null,
    sync: async () => null,
  });

  assert.deepEqual(await forward(batch(), false), {
    event: {
      type: 'entity-batch',
      entityType: 'user',
      userIds: ['user-1', 'user-2'],
      removedIds: ['user-3'],
    },
  });
  // A device batch, a device job, and the device sync stay off the users feed.
  assert.equal(await forward(batch('device'), false), null);
  assert.equal(await forward(finished('device'), false), null);
  assert.equal(
    await forward({ type: 'full-sync', sync: { customerId: CUSTOMER } }, false),
    null,
  );
});

test('a job-finished user event carries the failure that the caller may see', async () => {
  const reads = [];
  const forward = userForward(false, {
    jobFailure: async (jobId) => {
      reads.push(jobId);
      return null;
    },
    sync: async () => null,
  });

  assert.deepEqual(await forward(finished(), false), {
    event: { type: 'job-finished', entityType: 'user', failure: null },
  });
  assert.deepEqual(reads, [JOB_ID], 'The feed reads the visible failure once.');

  const everyJob = userForward(true, {
    jobFailure: async () => {
      throw new Error('A jobs holder reads no failure.');
    },
    sync: async () => null,
  });
  assert.deepEqual(await everyJob(finished(), false), {
    event: { type: 'job-finished', entityType: 'user', failure: 'quota' },
  });
  // A failed read sends its final event with no failure and ends the stream.
  assert.deepEqual(await forward(finished(), true), {
    event: { type: 'job-finished', entityType: 'user', failure: null },
    end: true,
  });
});

test('a user-full-sync event carries the sync state of the caller', async () => {
  const state = syncState(CUSTOMER, 'quota');
  const everyJob = userForward(true, {
    jobFailure: async () => null,
    sync: async () => null,
  });
  assert.deepEqual(
    await everyJob({ type: 'user-full-sync', sync: state }, false),
    {
      event: { type: 'user-full-sync', entityType: 'user', sync: state },
    },
  );

  const projected = syncState(CUSTOMER, null);
  const forward = userForward(false, {
    jobFailure: async () => null,
    sync: async () => projected,
  });
  assert.deepEqual(
    await forward({ type: 'user-full-sync', sync: state }, false),
    {
      event: { type: 'user-full-sync', entityType: 'user', sync: projected },
    },
  );

  // A failed read sends the event state without its failure and ends the stream.
  const failed = userForward(false, {
    jobFailure: async () => null,
    sync: async () => {
      throw new Error('store down');
    },
  });
  assert.deepEqual(
    await failed({ type: 'user-full-sync', sync: state }, true),
    {
      event: {
        type: 'user-full-sync',
        entityType: 'user',
        sync: { ...state, failure: null },
      },
      end: true,
    },
  );
  assert.deepEqual(userWithoutFailures(state), { ...state, failure: null });
});

/** One ping of the users feed. Each answer is a value or a function of the session. */
function ping({
  next = session([district('users:read')]),
  currentCustomer = { customerId: CUSTOMER },
  visibility = false,
  seesEveryJob = false,
  failure = null,
} = {}) {
  const calls = { authenticate: [], current: [], jobVisibility: [] };
  const value = (answer, seen) =>
    typeof answer === 'function' ? answer(seen) : answer;
  return {
    calls,
    run: () =>
      recheckUserStream({
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
            return value(currentCustomer, seen);
          },
          jobVisibility(seen, customerId) {
            calls.jobVisibility.push([seen, customerId]);
            return value(visibility, seen);
          },
        },
        cookie: 'sid=abc',
        correlationId: 'correlation-1',
        customerId: CUSTOMER,
        seesEveryJob,
      }),
  };
}

test('a users feed ping keeps the stream open while users:read and visibility hold', async () => {
  const probe = ping();

  const checked = await probe.run();

  assert.equal(checked.allowed, true);
  assert.equal(checked.session.identity.id, ACTOR);
  // The ping reads the session without sliding it, as the Devices stream ping does.
  assert.deepEqual(probe.calls.authenticate, [
    ['sid=abc', 'identity:read', 'correlation-1', { slide: false }],
  ]);
  assert.equal(probe.calls.current.length, 1);
  assert.deepEqual(probe.calls.jobVisibility, [
    [probe.calls.current[0], CUSTOMER],
  ]);
});

test('a users feed ping closes the stream after a revoke of users:read', async () => {
  const probe = ping({ currentCustomer: null });

  const checked = await probe.run();

  assert.equal(checked.allowed, false);
  // The protected sync read denies the revoked caller, and `userFeed` reads that denial as null.
  assert.equal(probe.calls.current.length, 1);
});

test('a users feed ping closes the stream when the sync belongs to another customer', async () => {
  const checked = await ping({
    currentCustomer: { customerId: OTHER },
  }).run();
  assert.equal(checked.allowed, false);
});

test('a users feed ping closes the stream when the job visibility changes', async () => {
  const checked = await ping({ visibility: true }).run();
  assert.equal(checked.allowed, false);
});

test('a users feed ping closes the stream when the session check fails', async () => {
  assert.deepEqual(
    await ping({ failure: new Error('session-expired') }).run(),
    { allowed: false, session: null },
  );
});

test('a users feed ping closes the stream when the sync read fails', async () => {
  const checked = await ping({
    currentCustomer: () => {
      throw new Error('user-store-unavailable');
    },
  }).run();
  assert.equal(checked.allowed, false);
});
