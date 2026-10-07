import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleBatchService } from './batch.ts';
import { GoogleConnectionError } from './provider.ts';
import { fakeGoogle, testClock, thing } from './batch-fake.mjs';

const batchUrl = 'https://www.googleapis.com/batch/admin/directory_v1';
const ok = (key) => ({ status: 200, body: { name: key } });
const rateLimited = (headers) => ({
  status: 429,
  body: { error: { code: 429, errors: [{ reason: 'rateLimitExceeded' }] } },
  ...(headers ? { headers } : {}),
});

function setup() {
  const clock = testClock();
  return {
    clock,
    batch: new GoogleBatchService({
      now: clock.now,
      sleep: clock.sleep,
      random: clock.random,
    }),
  };
}

function call(google, requests, extra = {}) {
  return {
    batchUrl,
    requests,
    parse: (body) => body,
    getClient: google.getClient,
    signal: AbortSignal.timeout(5_000),
    ...extra,
  };
}

test('an outer server error retries the whole batch, except a POST', async () => {
  const google = fakeGoogle((part) => ok(part.key), {
    outer: (round) =>
      round === 0 ? { status: 503, data: '{"error":{"code":503}}' } : undefined,
  });
  const { batch, clock } = setup();
  const result = await batch.execute(
    call(google, [thing('a'), thing('p', { method: 'POST', body: {} })]),
  );
  assert.deepEqual(google.keys(), [['a', 'p'], ['a']]);
  assert.deepEqual(result.succeeded.get('a'), [{ name: 'a' }]);
  assert.deepEqual(
    [result.failed.get('p').kind, result.failed.get('p').status],
    ['transient', 503],
  );
  assert.deepEqual(clock.waits, [500]);
});

test('an outer 429 retries every part, a POST included, and honors Retry-After', async () => {
  const google = fakeGoogle((part) => ok(part.key), {
    outer: (round) =>
      round === 0
        ? { status: 429, headers: { 'retry-after': '3' } }
        : undefined,
  });
  const { batch, clock } = setup();
  const result = await batch.execute(
    call(google, [thing('a'), thing('p', { method: 'POST', body: {} })]),
  );
  assert.deepEqual(google.keys(), [
    ['a', 'p'],
    ['a', 'p'],
  ]);
  assert.deepEqual(clock.waits, [3_000]);
  assert.equal(result.succeeded.size, 2);
});

test('an outer network error retries as transient with the error code as reason', async () => {
  const events = [];
  const google = fakeGoogle((part) => ok(part.key), {
    outer: (round) =>
      round === 0
        ? Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
        : undefined,
  });
  const result = await setup().batch.execute(
    call(google, [thing('a')], {
      onResponse: (event) => void events.push(event),
    }),
  );
  assert.deepEqual(google.keys(), [['a'], ['a']]);
  assert.deepEqual(result.succeeded.get('a'), [{ name: 'a' }]);
  assert.deepEqual(
    [
      events[0].outcome.kind,
      events[0].status,
      events[0].outcome.failure.reason,
    ],
    ['retry', 0, 'ECONNRESET'],
  );
});

test('an outer 401 fails only the parts in that batch', async () => {
  const google = fakeGoogle((part) => ok(part.key), {
    outer: (round) =>
      round === 0
        ? {
            status: 401,
            data: '{"error":{"code":401,"errors":[{"reason":"authError"}]}}',
          }
        : undefined,
  });
  const result = await setup().batch.execute(
    call(google, [thing('a'), thing('b'), thing('c')], {
      options: { batchSize: 2 },
    }),
  );
  assert.deepEqual(google.keys(), [['a', 'b'], ['c']]);
  assert.deepEqual(
    [
      result.failed.get('a').kind,
      result.failed.get('a').status,
      result.failed.get('a').reason,
    ],
    ['auth', 401, 'authError'],
  );
  assert.equal(result.failed.get('b').kind, 'auth');
  assert.deepEqual(result.succeeded.get('c'), [{ name: 'c' }]);
});

test('an outer 400 or a malformed reply rejects the run', async () => {
  const rejected = fakeGoogle((part) => ok(part.key), {
    outer: () => ({ status: 400, data: '{}' }),
  });
  await assert.rejects(setup().batch.execute(call(rejected, [thing('a')])), {
    name: 'BatchServiceError',
    code: 'outer-rejected',
  });
  const garbled = fakeGoogle((part) => ok(part.key), {
    outer: () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      data: '<html>',
    }),
  });
  await assert.rejects(setup().batch.execute(call(garbled, [thing('a')])), {
    name: 'BatchServiceError',
    code: 'malformed-response',
  });
});

test('a GoogleConnectionError from the transport rejects the run', async () => {
  const google = fakeGoogle((part) => ok(part.key), {
    outer: () => new GoogleConnectionError('request-failed'),
  });
  await assert.rejects(setup().batch.execute(call(google, [thing('a')])), {
    name: 'GoogleConnectionError',
    code: 'request-failed',
  });
});

test('the token is minted again 45 minutes after the last mint', async () => {
  const mintedAt = [];
  const google = fakeGoogle((part, round) =>
    round < 3 ? rateLimited({ 'Retry-After': '900' }) : ok(part.key),
  );
  const { batch, clock } = setup();
  const result = await batch.execute(
    call(google, [thing('a')], {
      options: { maxDelayMs: 900_000 },
      getClient: async () => {
        mintedAt.push(clock.time);
        return google.client;
      },
    }),
  );
  assert.deepEqual(mintedAt, [0, 2_700_000]);
  assert.deepEqual(result.succeeded.get('a'), [{ name: 'a' }]);
});

test('a mint failure fails every pending request as auth with the mint code', async () => {
  const google = fakeGoogle((part) => ok(part.key));
  const result = await setup().batch.execute(
    call(google, [thing('a'), thing('b')], {
      getClient: async () => {
        throw new GoogleConnectionError('credential-rejected');
      },
    }),
  );
  assert.deepEqual(result.failed.get('a'), {
    kind: 'auth',
    status: 0,
    reason: 'credential-rejected',
    attempts: { quota: 0, transient: 0 },
    body: null,
  });
  assert.equal(result.failed.size, 2);
  assert.equal(google.sent.length, 0);
});
