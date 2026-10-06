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
  assert.deepEqual(
    calls.map((call) => call.name),
    ['addMembers', 'create_entity_sync_job', 'startEntitySync'],
  );
  assert.equal(calls[0].key, 'cc:entity-inflight:device:C0123456');
  assert.equal(calls[0].seconds, 120);
  assert.equal(calls[1].values[3], 'device');
  assert.equal(calls[1].values[5], 100);
  assert.equal(calls[2].input.batchCount, 3);
});

test('overlapping stale queries dispatch each device once', async () => {
  const { calls, refresh } = fakes({
    added: (members) => members.filter((id) => id === 'd9'),
  });
  await refresh.dispatch(actor, 'C0123456', ['d1', 'd9'], correlation);
  assert.deepEqual(JSON.parse(calls[1].values[4]), ['d9']);
});

test('nothing new means no job', async () => {
  const { calls, refresh } = fakes({ added: () => [] });
  assert.equal(
    await refresh.dispatch(actor, 'C0123456', ['d1'], correlation),
    null,
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    ['addMembers'],
  );
});

test('a failed flow start abandons the job and frees the IDs', async () => {
  const { calls, refresh } = fakes({ startFails: true });
  assert.equal(
    await refresh.dispatch(actor, 'C0123456', ['d1'], correlation),
    null,
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      'addMembers',
      'create_entity_sync_job',
      'startEntitySync',
      'abandon_entity_sync_job',
      'removeMembers',
    ],
  );
});
