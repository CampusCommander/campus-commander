import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { GoogleConnectionError } from '@campus/google-connection';
import { UserSync } from './user-sync.ts';
import { DeviceSyncError } from './device-sync.ts';
import { EntityCacheError, noEntityCache } from './entity-cache.ts';

const customerId = 'C0123456';
const request = {
  customerId,
  syncId: randomUUID(),
  correlationId: randomUUID(),
};
const state = {
  customerId,
  generation: 1,
  status: 'ready',
  observedAt: '2026-10-05T12:00:00.000Z',
  userCount: 2,
  failure: null,
  startedAt: '2026-10-05T11:59:00.000Z',
  checkedAt: '2026-10-05T12:00:00.000Z',
  stale: false,
};
const user = (userId) => ({
  userId,
  primaryEmail: `${userId}@example.org`,
  orgUnitPath: '/Students',
  givenName: 'Robin',
  familyName: 'Avery',
  fullName: 'Robin Avery',
  suspended: false,
  suspensionReason: null,
  archived: false,
  lastLoginTime: null,
  creationTime: null,
  twoStepEnrolled: true,
  department: null,
  title: null,
  aliases: [],
  // The raw object is stored unchanged.
  customSchemas: { StudentInfo: { GradeLevel: 7 } },
});

function database({
  fail = {},
  onPage = () => undefined,
  removed = [],
  cancels = [],
  onFinish = async () => undefined,
} = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      const name = /cc\.(\w+)/.exec(sql)[1];
      calls.push({ name, values });
      if (fail[name])
        throw Object.assign(new Error(name), {
          code: 'P0001',
          detail: fail[name],
        });
      if (name === 'job_cancel_requested') {
        const next = cancels.length > 0 ? cancels.shift() : false;
        if (next === 'fail')
          throw Object.assign(new Error(name), {
            code: 'P0001',
            detail: 'store-down',
          });
        return { rows: [{ result: next }] };
      }
      if (name === 'claim_user_sync')
        return {
          rows: [
            {
              result: {
                generation: 1,
                credentialId: randomUUID(),
                envelope: { sealed: true },
              },
            },
          ],
        };
      if (name === 'finish_user_sync') {
        await onFinish();
        return { rows: [{ result: state }] };
      }
      if (name === 'page_last_removed_user_ids')
        return { rows: [{ result: values[1] === '' ? removed : [] }] };
      if (name === 'page_user_records') onPage();
      if (name === 'page_user_records')
        return {
          rows: [
            { result: values[1] === '' ? [record('u1'), record('u2')] : [] },
          ],
        };
      return { rows: [{ result: 1 }] };
    },
  };
}
const record = (userId) => ({
  version: 1,
  record: {
    ...user(userId),
    // One hour old, so Redis keeps the record for the 23 hours it stays fresh.
    lastEntitySync: new Date(Date.now() - 3_600_000).toISOString(),
  },
});
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
function reader({ users = [[user('u1'), user('u2')]] } = {}) {
  return {
    async *userPages() {
      for (const page of users) {
        if (page instanceof Error) throw page;
        yield page;
      }
    },
  };
}
const names = (calls) => calls.map((call) => call.name);

/** Timers whose interval the test fires by hand. */
function timers() {
  const intervals = new Map();
  let sequence = 0;
  return {
    handle: {
      setInterval(callback) {
        const id = ++sequence;
        intervals.set(id, callback);
        return id;
      },
      clearInterval(id) {
        intervals.delete(id);
      },
    },
    async fire() {
      for (const callback of [...intervals.values()]) await callback();
    },
    get count() {
      return intervals.size;
    },
  };
}

const untilAborted = (signal) =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', resolve, { once: true });
  });

/** One page, then a read that ends only when the run signal aborts. */
function stallingReader() {
  let staged;
  const started = new Promise((resolve) => (staged = resolve));
  return {
    started,
    async *userPages(_credential, _customer, signal) {
      yield [user('u1'), user('u2')];
      staged();
      await untilAborted(signal);
      throw new GoogleConnectionError('network-failure');
    },
  };
}

test('stages every page, publishes the sync, and fills Redis with user records', async () => {
  const db = database();
  const redis = cache();
  const result = await new UserSync(db, cipher, reader(), redis).run(
    request,
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(result, state);
  assert.deepEqual(names(db.calls), [
    'claim_user_sync',
    'stage_users',
    'finish_user_sync',
    'page_last_removed_user_ids',
    'page_user_records',
    'page_user_records',
  ]);
  const stage = db.calls.find((call) => call.name === 'stage_users');
  assert.deepEqual(stage.values.slice(0, 3), [
    customerId,
    request.syncId,
    stage.values[2],
  ]);
  assert.deepEqual(
    JSON.parse(stage.values[3]).map((entry) => entry.userId),
    ['u1', 'u2'],
  );
  assert.deepEqual(JSON.parse(stage.values[3])[0].customSchemas, {
    StudentInfo: { GradeLevel: 7 },
  });
  assert.deepEqual(db.calls[4].values, [customerId, '', 1000]);
  assert.deepEqual(db.calls[5].values, [customerId, 'u2', 1000]);
  assert.deepEqual(names(redis.calls), ['setRecords', 'increment', 'publish']);
  assert.deepEqual(
    redis.calls[0].args[0].map((entry) => entry.key),
    ['cc:entity:user:C0123456:u1', 'cc:entity:user:C0123456:u2'],
  );
  assert.deepEqual(
    redis.calls[0].args[0].map((entry) => entry.seconds),
    [82800, 82800],
  );
  assert.deepEqual(redis.calls[1].args, ['cc:query-gen:user:C0123456']);
  assert.deepEqual(JSON.parse(redis.calls[2].args[1]), {
    type: 'user-full-sync',
    sync: state,
  });
});

test('a page failure records the failure and writes no records', async () => {
  const db = database();
  const redis = cache();
  await new UserSync(
    db,
    cipher,
    reader({
      users: [[user('u1')], new GoogleConnectionError('permission-denied')],
    }),
    redis,
  ).run(request, AbortSignal.timeout(5000));
  const finish = db.calls.find((call) => call.name === 'finish_user_sync');
  assert.deepEqual(finish.values.slice(3), ['permission-denied']);
  assert.deepEqual(names(redis.calls), ['publish']);
});

test('a second attempt for the same sync stops before Google access', async () => {
  const db = database({ fail: { claim_user_sync: 'user-sync-claimed' } });
  await assert.rejects(
    new UserSync(db, cipher, reader(), cache()).run(
      request,
      AbortSignal.timeout(5000),
    ),
    (error) =>
      error instanceof DeviceSyncError && error.code === 'user-sync-claimed',
  );
  assert.deepEqual(names(db.calls), ['claim_user_sync']);
});

test('a lost lease stops staging and never publishes', async () => {
  const db = database({ fail: { stage_users: 'user-sync-changed' } });
  await assert.rejects(
    new UserSync(db, cipher, reader(), cache()).run(
      request,
      AbortSignal.timeout(5000),
    ),
    (error) =>
      error instanceof DeviceSyncError && error.code === 'user-sync-changed',
  );
  assert.equal(names(db.calls).includes('finish_user_sync'), false);
});

test('a full sync deletes the cached records of the users it removed', async () => {
  const db = database({ removed: ['r1', 'r2'] });
  const redis = cache();
  await new UserSync(db, cipher, reader(), redis).run(
    request,
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(names(redis.calls), [
    'remove',
    'setRecords',
    'increment',
    'publish',
  ]);
  assert.deepEqual(redis.calls[0].args[0], [
    'cc:entity:user:C0123456:r1',
    'cc:entity:user:C0123456:r2',
  ]);
});

test('a Redis fault after publication does not fail the sync', async () => {
  const db = database();
  const redis = cache();
  redis.setRecords = async (...args) => {
    redis.calls.push({ name: 'setRecords', args });
    throw new EntityCacheError();
  };
  const result = await new UserSync(db, cipher, reader(), redis).run(
    request,
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(result, state);
  assert.ok(names(db.calls).includes('finish_user_sync'));
  assert.deepEqual(names(redis.calls), ['setRecords', 'publish']);
});

test('the no-op cache lets a full sync publish without Redis', async () => {
  const db = database();
  const result = await new UserSync(db, cipher, reader(), noEntityCache).run(
    request,
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(result, state);
  assert.ok(names(db.calls).includes('finish_user_sync'));
});

test('the cancel tick aborts the stalled read and the raising finish leaves Redis untouched', async () => {
  const db = database({
    cancels: [true],
    fail: { finish_user_sync: 'user-sync-changed' },
  });
  const redis = cache();
  const clock = timers();
  const source = stallingReader();
  const run = new UserSync(db, cipher, source, redis, {
    timers: clock.handle,
  }).run(request, AbortSignal.timeout(5000));
  await source.started;
  await clock.fire();
  await assert.rejects(
    run,
    (error) =>
      error instanceof DeviceSyncError && error.code === 'user-sync-changed',
  );
  assert.deepEqual(names(db.calls), [
    'claim_user_sync',
    'stage_users',
    'job_cancel_requested',
    'finish_user_sync',
  ]);
  assert.deepEqual(names(redis.calls), []);
  assert.equal(clock.count, 0, 'The tick stops at the end of the run.');
});
