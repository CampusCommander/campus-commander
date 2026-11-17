import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { UserRefresh } from './user-refresh.ts';
import {
  MAX_REFRESH_USERS,
  UserSelectionRefresh,
  userSelectionRefreshStatus,
} from './user-selection-refresh.ts';
import { userSelectionStorageKey } from './user-selection.ts';

const customer = 'C0123456';
const actor = ['p1', 1];
const correlationId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const jobId = '3f9b1c2d-4e5a-4b6c-8d7e-9f0a1b2c3d4e';
const session = { identity: { id: 'p1', permissionVersion: 1 } };

const job = (id, batchCount) => ({
  jobId: id,
  customerId: customer,
  entityType: 'user',
  batchCount,
  completedBatches: 0,
  failedBatches: 0,
  failure: null,
  createdAt: new Date().toISOString(),
  finishedAt: null,
});

function fakeJobStore(options = {}) {
  const calls = [];
  const store = async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('purge_jobs')) return 0;
    if (sql.includes('create_entity_sync_job')) {
      if (options.createFails) throw new Error('constraint');
      const ids = JSON.parse(values[4]);
      return job(values[6], Math.ceil(ids.length / values[5]));
    }
    if (sql.includes('abandon_entity_sync_job')) return null;
    throw new Error(`unexpected statement ${sql}`);
  };
  return { store, calls };
}

function fakeClaims(options = {}) {
  const calls = { add: [], remove: [] };
  const cache = {
    calls,
    async addMembers(key, ids) {
      calls.add.push([key, ids]);
      if (options.claimFails) throw new Error('redis down');
      return options.fresh ? options.fresh(ids) : [...ids];
    },
    async removeMembers(key, ids) {
      calls.remove.push([key, ids]);
    },
  };
  return cache;
}

function fakeOrchestration(options = {}) {
  const calls = [];
  return {
    calls,
    async startEntitySync(input) {
      calls.push(input);
      if (options.fails) throw new Error('kestra down');
      return 'execution-1';
    },
  };
}

test('an empty refresh starts no job and claims nothing', async () => {
  const { store, calls } = fakeJobStore();
  const claims = fakeClaims();
  const flow = fakeOrchestration();
  const refresh = new UserRefresh(claims, flow, store);
  assert.equal(await refresh.request(actor, customer, [], correlationId), null);
  assert.equal(calls.length, 0);
  assert.equal(claims.calls.add.length, 0);
});

test('a refresh claims the users and starts one job', async () => {
  const { store, calls } = fakeJobStore();
  const claims = fakeClaims();
  const flow = fakeOrchestration();
  const refresh = new UserRefresh(claims, flow, store);
  const started = await refresh.request(
    actor,
    customer,
    ['u1', 'u2', 'u3'],
    correlationId,
  );
  assert.equal(typeof started, 'string');
  const create = calls.find((call) =>
    call.sql.includes('create_entity_sync_job'),
  );
  assert.equal(create.values[0], 'p1');
  assert.equal(create.values[1], 1);
  assert.equal(create.values[2], customer);
  assert.equal(create.values[3], 'user');
  assert.equal(create.values[4], '["u1","u2","u3"]');
  assert.equal(create.values[5], 100);
  assert.equal(create.values[7], correlationId);
  assert.equal(flow.calls.length, 1);
  assert.equal(flow.calls[0].jobId, started);
  assert.equal(flow.calls[0].correlationId, correlationId);
  assert.ok(flow.calls[0].batchCount >= 1);
});

test('a fully claimed set starts no job', async () => {
  const { store, calls } = fakeJobStore();
  const claims = fakeClaims({ fresh: () => [] });
  const flow = fakeOrchestration();
  const refresh = new UserRefresh(claims, flow, store);
  assert.equal(
    await refresh.request(actor, customer, ['u1'], correlationId),
    null,
  );
  assert.equal(
    calls.some((call) => call.sql.includes('create_entity_sync_job')),
    false,
  );
  assert.equal(flow.calls.length, 0);
});

test('a failed claim answers user-store-unavailable', async () => {
  const { store } = fakeJobStore();
  const claims = fakeClaims({ claimFails: true });
  const refresh = new UserRefresh(claims, fakeOrchestration(), store);
  await assert.rejects(
    refresh.request(actor, customer, ['u1'], correlationId),
    (error) => {
      assert.equal(error instanceof ServiceUnavailableException, true);
      assert.deepEqual(error.getResponse(), {
        reason: 'user-store-unavailable',
      });
      return true;
    },
  );
});

test('a failed job creation releases the claims', async () => {
  const { store } = fakeJobStore({ createFails: true });
  const claims = fakeClaims();
  const refresh = new UserRefresh(claims, fakeOrchestration(), store);
  await assert.rejects(
    refresh.request(actor, customer, ['u1', 'u2'], correlationId),
    (error) => {
      assert.equal(error instanceof ServiceUnavailableException, true);
      assert.deepEqual(error.getResponse(), {
        reason: 'user-store-unavailable',
      });
      return true;
    },
  );
  assert.deepEqual(claims.calls.remove[0][1], ['u1', 'u2']);
});

test('a failed flow start abandons the job and releases the claims', async () => {
  const { store, calls } = fakeJobStore();
  const claims = fakeClaims();
  const refresh = new UserRefresh(
    claims,
    fakeOrchestration({ fails: true }),
    store,
  );
  await assert.rejects(
    refresh.request(actor, customer, ['u1'], correlationId),
    (error) => {
      assert.equal(error instanceof ServiceUnavailableException, true);
      assert.deepEqual(error.getResponse(), {
        reason: 'orchestration-unavailable',
      });
      return true;
    },
  );
  const abandon = calls.find((call) =>
    call.sql.includes('abandon_entity_sync_job'),
  );
  assert.equal(abandon.values[2], customer);
  assert.deepEqual(claims.calls.remove.at(-1)[1], ['u1']);
});

test('a page dispatch hides a refresh failure', async () => {
  const { store } = fakeJobStore({ createFails: true });
  const refresh = new UserRefresh(fakeClaims(), fakeOrchestration(), store);
  assert.equal(
    await refresh.dispatch(actor, customer, ['u1'], correlationId),
    null,
  );
});

function fakeSelectionCache(raw) {
  return {
    calls: [],
    async get(key) {
      this.calls.push(key);
      return raw;
    },
  };
}

function fakeSelectionDatabase(rows) {
  const calls = [];
  return {
    calls,
    async transaction(run) {
      return run({
        async query(text, values) {
          calls.push({ text, values });
          return { rows: typeof rows === 'function' ? rows() : rows };
        },
      });
    },
  };
}

const selectionRaw = (rows, changedAt = new Date().toISOString()) =>
  JSON.stringify({
    terms: [[{ field: 'status', operator: 'is', values: ['active'] }]],
    additions: [],
    exceptions: [],
    changedAt,
  });

test('an expired selection answers the conflict with its expiry', async () => {
  const raw = selectionRaw(
    [],
    new Date(Date.now() - 13 * 3_600_000).toISOString(),
  );
  const refresh = new UserSelectionRefresh(
    fakeSelectionDatabase([]),
    fakeSelectionCache(raw),
    {
      async request() {
        return jobId;
      },
    },
  );
  await assert.rejects(
    refresh.request(
      session,
      customer,
      { gridId: 'users', tabId: 'tab' },
      correlationId,
    ),
    (error) => {
      assert.equal(error.getStatus(), 409);
      assert.equal(error.getResponse().reason, 'selection-expired');
      assert.equal(typeof error.getResponse().expiredAt, 'string');
      return true;
    },
  );
});

test('an empty selection answers nothing-selected', async () => {
  const refresh = new UserSelectionRefresh(
    fakeSelectionDatabase([]),
    fakeSelectionCache(null),
    {
      async request() {
        return jobId;
      },
    },
  );
  await assert.rejects(
    refresh.request(
      session,
      customer,
      { gridId: 'users', tabId: 'tab' },
      correlationId,
    ),
    (error) => {
      assert.equal(error.getStatus(), 422);
      assert.equal(error.getResponse().reason, 'nothing-selected');
      return true;
    },
  );
});

test('the job carries plain user IDs and leaves a removed user out', async () => {
  const rows = [
    { user_id: 'u1', removed_at: null },
    { user_id: 'u2', removed_at: new Date().toISOString() },
    { user_id: 'bad id', removed_at: null },
  ];
  const asked = [];
  const refresh = new UserSelectionRefresh(
    fakeSelectionDatabase(rows),
    fakeSelectionCache(selectionRaw(rows)),
    {
      async request(_actor, _customer, ids) {
        asked.push(ids);
        return jobId;
      },
    },
  );
  const answer = await refresh.request(
    session,
    customer,
    { gridId: 'users', tabId: 'tab' },
    correlationId,
  );
  assert.deepEqual(asked, [['u1']]);
  assert.equal(answer.selected, 1);
  assert.equal(answer.jobId, jobId);
  assert.equal(userSelectionRefreshStatus(answer), 201);
});

test('a selection whose users are all claimed answers 200', async () => {
  const rows = [{ user_id: 'u1', removed_at: null }];
  const refresh = new UserSelectionRefresh(
    fakeSelectionDatabase(rows),
    fakeSelectionCache(selectionRaw(rows)),
    {
      async request() {
        return null;
      },
    },
  );
  const answer = await refresh.request(
    session,
    customer,
    { gridId: 'users', tabId: 'tab' },
    correlationId,
  );
  assert.equal(answer.jobId, null);
  assert.equal(userSelectionRefreshStatus(answer), 200);
});

test('a selection over the refresh bound is refused', async () => {
  const rows = Array.from({ length: MAX_REFRESH_USERS + 1 }, (_, index) => ({
    user_id: `u${index}`,
    removed_at: null,
  }));
  const refresh = new UserSelectionRefresh(
    fakeSelectionDatabase(rows),
    fakeSelectionCache(selectionRaw(rows)),
    {
      async request() {
        return jobId;
      },
    },
  );
  await assert.rejects(
    refresh.request(
      session,
      customer,
      { gridId: 'users', tabId: 'tab' },
      correlationId,
    ),
    (error) => {
      assert.equal(error.getStatus(), 422);
      assert.equal(error.getResponse().reason, 'selection-too-large');
      return true;
    },
  );
});

test('a selection store fault answers user-store-unavailable', async () => {
  const refresh = new UserSelectionRefresh(
    fakeSelectionDatabase([]),
    {
      async get() {
        throw new Error('redis down');
      },
    },
    {
      async request() {
        return jobId;
      },
    },
  );
  await assert.rejects(
    refresh.request(
      session,
      customer,
      { gridId: 'users', tabId: 'tab' },
      correlationId,
    ),
    (error) => {
      assert.equal(error instanceof ServiceUnavailableException, true);
      assert.deepEqual(error.getResponse(), {
        reason: 'user-store-unavailable',
      });
      return true;
    },
  );
});

test('the selection read uses the stored key of this person and tab', async () => {
  const cache = fakeSelectionCache(null);
  const refresh = new UserSelectionRefresh(fakeSelectionDatabase([]), cache, {
    async request() {
      return null;
    },
  });
  await assert.rejects(
    refresh.request(
      session,
      customer,
      { gridId: 'users', tabId: 'tab' },
      correlationId,
    ),
  );
  assert.deepEqual(cache.calls, [
    userSelectionStorageKey('p1', { gridId: 'users', tabId: 'tab' }),
  ]);
});
