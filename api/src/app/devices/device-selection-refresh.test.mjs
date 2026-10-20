import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConflictException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DeviceSelectionRefresh } from './device-selection-refresh.ts';
import { selectionRefreshStatus } from './device-selection-refresh.ts';

const actor = '11111111-1111-4111-8111-111111111111';
const customerId = 'C0123456';
const correlationId = '22222222-2222-4222-8222-222222222222';
const key = {
  gridId: 'devices',
  tabId: '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
};
const session = {
  identity: { id: actor, permissionVersion: 1 },
};

/** Settle a call into a value or an error so a wrong answer reads as an assertion. */
const settle = (call) =>
  call().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

const selection = (state) => JSON.stringify(state);

function fakes({ raw = null, rows = [], getFails = false, jobId } = {}) {
  const calls = { get: 0, transaction: 0, request: [] };
  const cache = {
    async get(storageKey) {
      calls.get += 1;
      calls.storageKey = storageKey;
      if (getFails) throw new Error('redis down');
      return raw;
    },
  };
  const database = {
    async transaction(run) {
      calls.transaction += 1;
      return run({
        query: async () => ({ rows }),
      });
    },
  };
  const refresh = {
    async request(actorPair, customer, ids, correlation) {
      calls.request.push({ actorPair, customer, ids, correlation });
      return jobId === undefined
        ? '33333333-3333-4333-8333-333333333333'
        : jobId;
    },
  };
  return {
    calls,
    refresh: new DeviceSelectionRefresh(database, cache, refresh),
  };
}

test('an expired selection answers 409 with its expiry and starts no job', async () => {
  const changedAt = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
  const expected = new Date(
    Date.parse(changedAt) + 12 * 60 * 60 * 1000,
  ).toISOString();
  const { calls, refresh } = fakes({
    raw: selection({
      terms: [],
      groups: [],
      additions: ['d1'],
      exceptions: [],
      changedAt,
    }),
  });
  const answer = await settle(() =>
    refresh.request(session, customerId, key, correlationId),
  );
  assert.ok(answer.error instanceof ConflictException);
  assert.equal(answer.error.getStatus(), 409);
  assert.deepEqual(answer.error.getResponse(), {
    reason: 'selection-expired',
    expiredAt: expected,
  });
  assert.equal(
    calls.transaction,
    0,
    'An expired selection reads no device rows.',
  );
  assert.deepEqual(calls.request, []);
});

test('an empty selection answers 422 nothing-selected and starts no job', async () => {
  const { calls, refresh } = fakes({});
  const answer = await settle(() =>
    refresh.request(session, customerId, key, correlationId),
  );
  assert.ok(answer.error instanceof UnprocessableEntityException);
  assert.equal(answer.error.getStatus(), 422);
  assert.deepEqual(answer.error.getResponse(), { reason: 'nothing-selected' });
  assert.equal(calls.transaction, 0);
  assert.deepEqual(calls.request, []);
});

test('a selection of only exceptions answers 422 nothing-selected', async () => {
  const { calls, refresh } = fakes({
    raw: selection({
      terms: [],
      groups: [],
      additions: [],
      exceptions: ['d1'],
    }),
  });
  const answer = await settle(() =>
    refresh.request(session, customerId, key, correlationId),
  );
  assert.ok(answer.error instanceof UnprocessableEntityException);
  assert.deepEqual(answer.error.getResponse(), { reason: 'nothing-selected' });
  assert.equal(calls.transaction, 0);
  assert.deepEqual(calls.request, []);
});

test('a 100,001-row selection answers 422 selection-too-large and starts no job', async () => {
  const rows = Array.from({ length: 100_001 }, (_, index) => ({
    device_id: `d${index}`,
    removed_at: null,
  }));
  const { calls, refresh } = fakes({
    raw: selection({
      terms: [],
      groups: [],
      additions: ['d1'],
      exceptions: [],
    }),
    rows,
  });
  const answer = await settle(() =>
    refresh.request(session, customerId, key, correlationId),
  );
  assert.ok(answer.error instanceof UnprocessableEntityException);
  assert.equal(answer.error.getStatus(), 422);
  assert.deepEqual(answer.error.getResponse(), {
    reason: 'selection-too-large',
  });
  assert.equal(calls.transaction, 1);
  assert.deepEqual(calls.request, []);
});

test('removed devices and non-plain IDs stay out of the job', async () => {
  const rows = [
    { device_id: 'd1', removed_at: null },
    { device_id: 'd2', removed_at: new Date() },
    { device_id: 'not a device', removed_at: null },
    { device_id: 'd3', removed_at: null },
  ];
  const { calls, refresh } = fakes({
    raw: selection({
      terms: [],
      groups: [],
      additions: ['d1', 'd2'],
      exceptions: [],
    }),
    rows,
  });
  const answer = await settle(() =>
    refresh.request(session, customerId, key, correlationId),
  );
  assert.equal(answer.error, undefined, `The request answers: ${answer.error}`);
  assert.deepEqual(answer.value, {
    jobId: '33333333-3333-4333-8333-333333333333',
    selected: 2,
  });
  assert.deepEqual(calls.request, [
    {
      actorPair: [actor, 1],
      customer: customerId,
      ids: ['d1', 'd3'],
      correlation: correlationId,
    },
  ]);
  assert.equal(
    calls.storageKey,
    `cc:device-selection:${actor}:devices:${key.tabId}`,
    'The selection reads under its per-person storage key.',
  );
});

test('a removed-only selection answers 422 nothing-selected and starts no job', async () => {
  const { calls, refresh } = fakes({
    raw: selection({
      terms: [],
      groups: [],
      additions: ['d2'],
      exceptions: [],
    }),
    rows: [{ device_id: 'd2', removed_at: new Date() }],
  });
  const answer = await settle(() =>
    refresh.request(session, customerId, key, correlationId),
  );
  assert.ok(answer.error instanceof UnprocessableEntityException);
  assert.deepEqual(answer.error.getResponse(), { reason: 'nothing-selected' });
  assert.deepEqual(calls.request, []);
});

test('a Redis failure answers 503 device-store-unavailable', async () => {
  const { calls, refresh } = fakes({ getFails: true });
  const answer = await settle(() =>
    refresh.request(session, customerId, key, correlationId),
  );
  assert.ok(answer.error instanceof ServiceUnavailableException);
  assert.equal(answer.error.getStatus(), 503);
  assert.deepEqual(answer.error.getResponse(), {
    reason: 'device-store-unavailable',
  });
  assert.equal(calls.transaction, 0);
  assert.deepEqual(calls.request, []);
});

test('a store failure answers 503 device-store-unavailable', async () => {
  const cache = {
    async get() {
      return selection({
        terms: [],
        groups: [],
        additions: ['d1'],
        exceptions: [],
      });
    },
  };
  const database = {
    async transaction() {
      throw new Error('postgres down');
    },
  };
  const calls = [];
  const refresh = new DeviceSelectionRefresh(database, cache, {
    async request(...args) {
      calls.push(args);
      return null;
    },
  });
  const answer = await settle(() =>
    refresh.request(session, customerId, key, correlationId),
  );
  assert.ok(answer.error instanceof ServiceUnavailableException);
  assert.equal(answer.error.getStatus(), 503);
  assert.deepEqual(answer.error.getResponse(), {
    reason: 'device-store-unavailable',
  });
  assert.deepEqual(calls, []);
});

test('every ID in flight answers a null job with the selected count', async () => {
  const { calls, refresh } = fakes({
    raw: selection({
      terms: [],
      groups: [],
      additions: ['d1'],
      exceptions: [],
    }),
    rows: [{ device_id: 'd1', removed_at: null }],
    jobId: null,
  });
  const answer = await settle(() =>
    refresh.request(session, customerId, key, correlationId),
  );
  assert.equal(answer.error, undefined, `The request answers: ${answer.error}`);
  assert.deepEqual(answer.value, { jobId: null, selected: 1 });
  assert.deepEqual(calls.request, [
    {
      actorPair: [actor, 1],
      customer: customerId,
      ids: ['d1'],
      correlation: correlationId,
    },
  ]);
});

test('a started job answers 201 and a fully claimed selection answers 200', () => {
  assert.equal(
    selectionRefreshStatus({
      jobId: '33333333-3333-4333-8333-333333333333',
      selected: 3,
    }),
    201,
  );
  assert.equal(selectionRefreshStatus({ jobId: null, selected: 3 }), 200);
});
