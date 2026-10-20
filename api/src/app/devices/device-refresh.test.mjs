import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
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

function fakes({
  added = (members) => members,
  startFails = false,
  purgeFails = false,
  addFails = false,
  createFails = false,
} = {}) {
  const calls = [];
  const cache = {
    async addMembers(key, members, seconds) {
      calls.push({ name: 'addMembers', key, members, seconds });
      if (addFails) throw new Error('redis down');
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
    if (name === 'purge_jobs' && purgeFails) throw new Error('store down');
    if (name === 'purge_jobs') return 0;
    if (name === 'create_entity_sync_job' && createFails)
      throw new Error('store down');
    if (name === 'create_entity_sync_job') return job(JSON.parse(values[4]));
    return job([]);
  };
  return { calls, refresh: new DeviceRefresh(cache, orchestration, store) };
}

/** Settle a call into a value or an error so a wrong answer reads as an assertion. */
const settle = (call) =>
  call().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

test('stale IDs create one job and start the flow with its batch count', async () => {
  const ids = Array.from({ length: 250 }, (_, index) => `d${index}`);
  const { calls, refresh } = fakes();
  const jobId = await refresh.dispatch(actor, 'C0123456', ids, correlation);
  assert.equal(jobId, '33333333-3333-4333-8333-333333333333');
  assert.deepEqual(
    calls.map((call) => call.name),
    ['purge_jobs', 'addMembers', 'create_entity_sync_job', 'startEntitySync'],
  );
  assert.equal(calls[1].key, 'cc:entity-inflight:device:C0123456');
  assert.equal(calls[1].seconds, 120);
  assert.equal(calls[2].values[3], 'device');
  assert.equal(calls[2].values[5], 100);
  assert.equal(calls[3].input.batchCount, 3);
});

test('overlapping stale queries dispatch each device once', async () => {
  const { calls, refresh } = fakes({
    added: (members) => members.filter((id) => id === 'd9'),
  });
  await refresh.dispatch(actor, 'C0123456', ['d1', 'd9'], correlation);
  assert.deepEqual(JSON.parse(calls[2].values[4]), ['d9']);
});

test('nothing new means no job', async () => {
  const { calls, refresh } = fakes({ added: () => [] });
  assert.equal(
    await refresh.dispatch(actor, 'C0123456', ['d1'], correlation),
    null,
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    ['purge_jobs', 'addMembers'],
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
      'purge_jobs',
      'addMembers',
      'create_entity_sync_job',
      'startEntitySync',
      'abandon_entity_sync_job',
      'removeMembers',
    ],
  );
});

test('dispatch purges old jobs for the customer before it claims IDs', async () => {
  const { calls, refresh } = fakes();
  await refresh.dispatch(actor, 'C0123456', ['d1'], correlation);
  assert.equal(calls[0].name, 'purge_jobs');
  assert.deepEqual(calls[0].values, ['C0123456', 100]);
});

test('a purge failure does not stop the job', async () => {
  const { calls, refresh } = fakes({ purgeFails: true });
  assert.equal(
    await refresh.dispatch(actor, 'C0123456', ['d1'], correlation),
    '33333333-3333-4333-8333-333333333333',
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    ['purge_jobs', 'addMembers', 'create_entity_sync_job', 'startEntitySync'],
  );
});

test('an explicit request answers null when every ID is in flight', async () => {
  const { calls, refresh } = fakes({ added: () => [] });
  assert.equal(
    await refresh.request(actor, 'C0123456', ['d1', 'd2'], correlation),
    null,
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    ['purge_jobs', 'addMembers'],
    'Every ID is claimed, so no job is created.',
  );
});

test('an explicit request creates a job with the newly claimed IDs only', async () => {
  const { calls, refresh } = fakes({
    added: (members) => members.filter((id) => id === 'd9'),
  });
  assert.equal(
    await refresh.request(actor, 'C0123456', ['d1', 'd9'], correlation),
    '33333333-3333-4333-8333-333333333333',
  );
  assert.deepEqual(JSON.parse(calls[2].values[4]), ['d9']);
  assert.equal(calls[3].input.batchCount, 1);
});

test('a flow start failure answers 503 and abandons the job', async () => {
  const { calls, refresh } = fakes({ startFails: true });
  const answer = await settle(() =>
    refresh.request(actor, 'C0123456', ['d1'], correlation),
  );
  assert.ok(answer.error instanceof ServiceUnavailableException);
  assert.equal(answer.error.getStatus(), 503);
  assert.deepEqual(answer.error.getResponse(), {
    reason: 'orchestration-unavailable',
  });
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      'purge_jobs',
      'addMembers',
      'create_entity_sync_job',
      'startEntitySync',
      'abandon_entity_sync_job',
      'removeMembers',
    ],
  );
});

test('a Redis failure answers 503 device-store-unavailable', async () => {
  const { calls, refresh } = fakes({ addFails: true });
  const answer = await settle(() =>
    refresh.request(actor, 'C0123456', ['d1'], correlation),
  );
  assert.ok(answer.error instanceof ServiceUnavailableException);
  assert.equal(answer.error.getStatus(), 503);
  assert.deepEqual(answer.error.getResponse(), {
    reason: 'device-store-unavailable',
  });
  assert.deepEqual(
    calls.map((call) => call.name),
    ['purge_jobs', 'addMembers'],
  );
});

test('a store failure answers 503 and frees the claims', async () => {
  const { calls, refresh } = fakes({ added: () => ['d1'], createFails: true });
  const answer = await settle(() =>
    refresh.request(actor, 'C0123456', ['d1'], correlation),
  );
  assert.ok(answer.error instanceof ServiceUnavailableException);
  assert.equal(answer.error.getResponse().reason, 'device-store-unavailable');
  assert.deepEqual(
    calls.map((call) => call.name),
    ['purge_jobs', 'addMembers', 'create_entity_sync_job', 'removeMembers'],
    'No job row exists, so no job is abandoned.',
  );
  assert.deepEqual(calls[3].members, ['d1']);
});
