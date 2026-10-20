import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  entityEventSchema,
  jobEventSchema,
} from '@campus/application-contracts';
import {
  BatchServiceError,
  GoogleConnectionError,
} from '@campus/google-connection';
import {
  DEVICE_UPDATE_BATCH_SIZE_LIMIT,
  DeviceUpdateJobs,
  classifyWrite,
  resolveDeviceUpdateBatchSize,
} from './device-update.ts';
import { DeviceSyncError } from './device-sync.ts';
import { EntityCacheError } from './entity-cache.ts';

const customerId = 'C0123456';
const jobId = randomUUID();
const dispatchToken = randomUUID();
const correlationId = randomUUID();
const displayId = 'UPD-001';
const requestedBy = randomUUID();
const batchRequest = {
  customerId,
  jobId,
  dispatchToken,
  batch: 0,
  correlationId,
};
const base = Date.now() - 5_000;

/** One claimed operation of the write path. */
const op = (number, deviceId, value = `Room ${number}`) => ({
  operationNumber: number,
  deviceId,
  serialNumber: `serial-${number}`,
  baselineValue: null,
  requestedValue: value,
});

const claimed = (operations, readBack = []) => ({
  outcome: 'claimed',
  generation: 1,
  credentialId: randomUUID(),
  envelope: { sealed: true },
  batchCount: 2,
  operations,
  readBack,
});

const part = (
  id,
  {
    kind = 'success',
    status = 200,
    reason = null,
    quota = 0,
    transient = 0,
  } = {},
) => ({
  id,
  status,
  attempts: { quota, transient },
  outcome:
    kind === 'success'
      ? {
          kind: 'success',
          page: { deviceId: id },
          pageIndex: 0,
          hasNextPage: false,
        }
      : kind === 'retry'
        ? {
            kind: 'retry',
            failure: {
              kind: reason === 'quota' ? 'quota' : 'transient',
              status,
              reason,
              attempts: { quota: quota + 1, transient: transient + 1 },
              body: null,
            },
            retryInMs: 1000,
          }
        : {
            kind: 'failed',
            failure: {
              kind,
              status,
              reason,
              attempts: { quota, transient },
              body: null,
            },
          },
});

/**
 * A stand-in for the batch service. It reports the same events in the same order:
 * `onSend`, each part answer, then `onBatch`. A fatal error throws after `onSend`
 * and before `onBatch`, as `send` does. An aborted signal sends nothing more.
 */
function reader(rounds = [], states = []) {
  return {
    calls: [],
    async patchAnnotatedLocations(
      _credential,
      _customer,
      writes,
      signal,
      options,
    ) {
      const call = {
        name: 'patchAnnotatedLocations',
        writes: writes.map((write) => ({ ...write })),
        batchSize: options.batchSize,
        aborted: false,
        rounds: 0,
      };
      this.calls.push(call);
      const result = { succeeded: new Map(), failed: new Map() };
      let next = 0;
      let number = 0;
      let lastIds = [];
      for (const round of rounds) {
        if (signal.aborted) {
          call.aborted = true;
          break;
        }
        number += 1;
        if (round.mint) throw round.mint;
        if (round.gate) await round.gate;
        const size = round.size ?? options.batchSize ?? 250;
        const ids = round.reuse
          ? lastIds
          : writes.slice(next, next + size).map((w) => w.deviceId);
        if (!round.reuse) next += ids.length;
        lastIds = ids;
        await options.onSend?.(ids);
        call.rounds += 1;
        if (round.gate) await round.gate;
        if (round.abortBeforeAnswer) {
          call.aborted = true;
          break;
        }
        if (round.hang) {
          await new Promise((resolve) =>
            signal.addEventListener('abort', resolve, { once: true }),
          );
          call.aborted = true;
          break;
        }
        if (round.fatal) throw round.fatal;
        for (const id of ids) {
          const answer = round.parts?.[id] ?? { kind: 'success' };
          const event = {
            ...part(id, answer),
            request: {
              id,
              method: 'PATCH',
              path: `/admin/directory/v1/customer/${customerId}/devices/chromeos/${id}`,
            },
          };
          if (event.outcome.kind === 'success')
            result.succeeded.set(id, [event.outcome.page]);
          else result.failed.set(id, event.outcome.failure);
          await options.onResponse?.(event);
        }
        await options.onBatch?.({
          round: number,
          sentCount: ids.length,
          outerStatus: 200,
          durationMs: 1,
          pending: writes.length - next,
        });
      }
      return result;
    },
    async deviceStates(_credential, _customer, ids, signal) {
      this.calls.push({
        name: 'deviceStates',
        ids: [...ids],
        aborted: signal.aborted,
      });
      const nextState = states.shift();
      if (nextState instanceof Error) throw nextState;
      return (
        nextState ??
        ids.map((id) => ({
          deviceId: id,
          status: 'found',
          device: { deviceId: id, annotatedLocation: null },
        }))
      );
    },
  };
}

/** A cache that records the order of its calls. */
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

/** A database that answers each `cc.*` call and records its values. */
function database(overrides = {}) {
  const calls = [];
  const operations = new Map();
  let ticks = 0;
  const stamp = () => new Date(base + ++ticks * 1000);
  const answer = (name, values) => {
    if (name === 'claim_device_update_batch')
      return overrides.claim ? overrides.claim(values) : claimed([op(1, 'd1')]);
    if (name === 'renew_device_update_batch')
      return overrides.renew ? overrides.renew(values) : stamp();
    if (name === 'clock_timestamp') return stamp();
    if (name === 'release_device_update_batch') return null;
    if (name === 'report_device_update_backoff') return true;
    if (name === 'settle_device_update_operations') {
      if (overrides.settle) {
        const answer = overrides.settle(values);
        if (answer !== undefined) return answer;
      }
      const results = JSON.parse(values[5]);
      return {
        outcome: 'settled',
        settled: results.map((result) => ({
          operationNumber: result.operationNumber,
          deviceId: operations.get(result.operationNumber) ?? 'd1',
          status: result.outcome,
          batch: 0,
        })),
        published: results
          .filter((result) => result.outcome === 'succeeded')
          .map((result) => operations.get(result.operationNumber) ?? 'd1'),
        removed: results
          .filter((result) => result.outcomeReason === 'not-found')
          .map((result) => operations.get(result.operationNumber) ?? 'd1'),
        publication: null,
      };
    }
    if (name === 'claim_device_update_verification')
      return overrides.verificationClaim
        ? overrides.verificationClaim(values)
        : [];
    if (name === 'read_device_update_verification')
      return overrides.verificationRead
        ? overrides.verificationRead(values)
        : { outcome: 'not-held' };
    if (name === 'prepare_device_update_finish')
      return overrides.prepare
        ? overrides.prepare(values)
        : { outcome: 'ready', failure: null };
    if (name === 'finish_device_update_job')
      return overrides.finish
        ? overrides.finish(values)
        : {
            jobId,
            status: 'succeeded',
            succeeded: 1,
            failed: 0,
            unknown: 0,
            skipped: 0,
            finishedAt: stamp().toISOString(),
            publication: null,
          };
    if (name === 'complete_job_publications') return 1;
    throw new Error(`Unexpected call ${name}`);
  };
  return {
    calls,
    operations,
    async query(sql, values) {
      const name = (/cc\.(\w+)/.exec(sql) ?? /(\w+)\(\)/.exec(sql))[1];
      calls.push({ name, values });
      if (overrides.fail?.[name]) {
        const failure = overrides.fail[name];
        if (failure instanceof Error) throw failure;
        throw Object.assign(new Error(name), {
          code: 'P0001',
          detail: failure,
        });
      }
      if (name === 'claim_device_update_batch') {
        const body = overrides.claim
          ? overrides.claim(values)
          : claimed([op(1, 'd1')]);
        for (const operation of body.operations ?? [])
          operations.set(operation.operationNumber, operation.deviceId);
        return { rows: [{ result: body }] };
      }
      return { rows: [{ result: answer(name, values) }] };
    },
  };
}

function jobs(options = {}) {
  const timerSet = options.timers ?? realishTimers();
  const timers = timerSet.timers ?? timerSet;
  const sleeps = [];
  const create = new DeviceUpdateJobs(
    options.db ?? database(options.database),
    { open: () => ({ subject: 'fixture@example.invalid' }) },
    options.reader ?? reader(),
    options.cache ?? cache(),
    {
      batchSize: options.batchSize,
      timers,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        if (options.onSleep) await options.onSleep(milliseconds);
      },
    },
  );
  return { create, timers: timerSet, sleeps };
}

/** Timers whose callbacks the test fires by hand. */
function realishTimers() {
  const timeouts = new Map();
  const intervals = new Map();
  let sequence = 0;
  const timers = {
    setTimeout(callback) {
      const id = ++sequence;
      timeouts.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(callback) {
      const id = ++sequence;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
  };
  return {
    timers,
    fireTimeout() {
      const [id, callback] = [...timeouts.entries()][0] ?? [];
      if (callback === undefined) return false;
      timeouts.delete(id);
      callback();
      return true;
    },
    fireInterval() {
      for (const callback of [...intervals.values()]) callback();
    },
    get timeoutCount() {
      return timeouts.size;
    },
    get intervalCount() {
      return intervals.size;
    },
  };
}

const names = (calls) => calls.map((call) => call.name);
const settlements = (db) =>
  db.calls.filter((call) => call.name === 'settle_device_update_operations');

test('the write batch size defaults to 250 and rejects a value outside 1 to 250', () => {
  assert.equal(DEVICE_UPDATE_BATCH_SIZE_LIMIT, 250);
  assert.equal(resolveDeviceUpdateBatchSize(undefined), 250);
  assert.equal(resolveDeviceUpdateBatchSize(''), 250);
  assert.equal(resolveDeviceUpdateBatchSize('1'), 1);
  assert.equal(resolveDeviceUpdateBatchSize('250'), 250);
  for (const value of ['0', '251', '1.5', 'abc', '-1'])
    assert.throws(() => resolveDeviceUpdateBatchSize(value), /1 to 250/);
});

test('classification covers each row of section 7.1', () => {
  const tracked = (extra = {}) => ({
    operation: op(1, 'd1'),
    sent: false,
    succeeded: false,
    final: null,
    settled: false,
    ...extra,
  });
  const failed = (
    kind,
    status,
    reason,
    attempts = { quota: 0, transient: 0 },
  ) => ({
    kind,
    status,
    reason,
    attempts,
    body: null,
  });
  const run = (entry, stop = null) => classifyWrite(entry, stop).outcome;

  assert.deepEqual(run(tracked({ succeeded: true })), {
    operationNumber: 1,
    outcome: 'succeeded',
    verifiedBy: 'write-response',
  });
  assert.deepEqual(
    run(tracked({ sent: true, final: failed('rejected', 403, 'forbidden') })),
    {
      operationNumber: 1,
      outcome: 'failed',
      googleStatus: 403,
      googleReason: 'forbidden',
      quotaRetries: 0,
      transientRetries: 0,
      outcomeReason: 'forbidden',
    },
  );
  assert.equal(
    run(tracked({ sent: true, final: failed('not-found', 404, 'notFound') }))
      .outcomeReason,
    'not-found',
  );
  assert.equal(
    run(
      tracked({ sent: true, final: failed('quota', 429, 'rateLimitExceeded') }),
    ).outcomeReason,
    'quota',
  );
  const transient = run(
    tracked({
      sent: true,
      final: failed('transient', 503, 'backendError', {
        quota: 0,
        transient: 2,
      }),
    }),
  );
  assert.equal(transient.outcome, 'unknown');
  assert.equal(transient.outcomeReason, 'ambiguous');
  assert.equal(
    run(tracked({ sent: true, final: failed('invalid-response', 200, null) }))
      .outcomeReason,
    'invalid-response',
  );
  // A request left the worker and no event arrived.
  const lost = run(tracked({ sent: true }));
  assert.equal(lost.outcome, 'unknown');
  assert.equal(lost.outcomeReason, 'ambiguous');
  // No request left the worker and the job continues.
  assert.equal(run(tracked()).outcome, 'pending');
  // No request left the worker and the job stops.
  assert.equal(run(tracked(), 'permission-denied').outcome, 'skipped');
  // A mint failure with no request: skipped under the stop, unknown after a send.
  const mint = failed('auth', 0, 'network-failure');
  assert.equal(
    run(tracked({ final: mint }), 'network-failure').outcome,
    'skipped',
  );
  assert.equal(
    run(tracked({ sent: true, final: mint }), 'network-failure').outcome,
    'unknown',
  );
});

test('a batch claims, writes, stamps the round with its renewal, and releases', async () => {
  const db = database({ claim: () => claimed([op(1, 'd1'), op(2, 'd2')]) });
  const redis = cache();
  const source = reader([
    { parts: { d1: { kind: 'success' }, d2: { kind: 'success' } } },
  ]);
  const { create } = jobs({ db, reader: source, cache: redis });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));

  assert.deepEqual(answer, {
    outcome: 'settled',
    failure: null,
    published: 2,
    removed: 0,
  });
  assert.deepEqual(names(db.calls), [
    'claim_device_update_batch',
    'renew_device_update_batch',
    'settle_device_update_operations',
    'release_device_update_batch',
  ]);
  assert.equal(
    names(db.calls).includes('clock_timestamp'),
    false,
    'A round renewal stamps its settlement; the worker makes no separate heartbeat call.',
  );
  const settled = settlements(db)[0];
  assert.equal(settled.values[4], 'write');
  assert.equal(settled.values[3], db.calls[0].values[4]);
  assert.equal(
    settled.values[6],
    new Date(base + 1000).toISOString(),
    'The settlement carries the renewal time after the round.',
  );
  assert.deepEqual(
    JSON.parse(settled.values[5]).map((result) => result.outcome),
    ['succeeded', 'succeeded'],
  );
  assert.deepEqual(source.calls[0].writes, [
    { deviceId: 'd1', value: 'Room 1' },
    { deviceId: 'd2', value: 'Room 2' },
  ]);
});

test('a clear sends a null value', async () => {
  const db = database({ claim: () => claimed([op(1, 'd1', null)]) });
  const source = reader([{ parts: { d1: { kind: 'success' } } }]);
  const { create } = jobs({ db, reader: source });
  await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.deepEqual(source.calls[0].writes, [{ deviceId: 'd1', value: null }]);
});

test('first-attempt refusals fail without a read-back', async () => {
  for (const answer of [
    { kind: 'auth', status: 403, reason: 'forbidden' },
    { kind: 'rejected', status: 400, reason: 'badRequest' },
    { kind: 'not-found', status: 404, reason: 'notFound' },
  ]) {
    const db = database({ claim: () => claimed([op(1, 'd1')]) });
    const source = reader([{ parts: { d1: answer } }]);
    const { create } = jobs({ db, reader: source });
    const result = await create.runBatch(
      batchRequest,
      AbortSignal.timeout(5000),
    );
    assert.equal(
      result.outcome,
      answer.kind === 'auth' ? 'stopped' : 'settled',
    );
    if (answer.kind === 'auth')
      assert.equal(result.failure, 'permission-denied');
    const settled = settlements(db)[0];
    assert.equal(JSON.parse(settled.values[5])[0].outcome, 'failed');
    assert.equal(
      settled.values[7],
      answer.kind === 'auth' ? 'permission-denied' : null,
      'Only a stopping observation records a job failure.',
    );
    assert.equal(source.calls.length, 1, 'No read-back runs for a refusal.');
    assert.equal(names(db.calls).at(-1), 'release_device_update_batch');
  }
});

test('R3 response loss then refusal: the read-back settles the applied write', async () => {
  const db = database({ claim: () => claimed([op(1, 'd1')]) });
  const source = reader([
    {
      parts: {
        d1: { kind: 'retry', status: 0, reason: 'timeout', transient: 1 },
      },
    },
    {
      reuse: true,
      parts: {
        d1: { kind: 'auth', status: 403, reason: 'forbidden', transient: 1 },
      },
    },
  ]);
  source.deviceStates = async (_c, _customer, ids) => {
    source.calls.push({ name: 'deviceStates', ids: [...ids] });
    return [
      {
        deviceId: 'd1',
        status: 'found',
        device: { deviceId: 'd1', annotatedLocation: 'Room 1' },
      },
    ];
  };
  const { create, sleeps } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'stopped');
  assert.equal(answer.failure, 'permission-denied');
  assert.ok(
    sleeps[0] >= 20_000,
    'The read-back starts no GET before verifyAfter.',
  );
  const [write, readBack] = settlements(db);
  assert.equal(JSON.parse(write.values[5])[0].outcome, 'unknown');
  assert.equal(JSON.parse(write.values[5])[0].outcomeReason, 'ambiguous');
  assert.equal(readBack.values[4], 'read-back');
  const verified = JSON.parse(readBack.values[5])[0];
  assert.equal(verified.outcome, 'succeeded');
  assert.equal(verified.verifiedBy, 'read-back');
  assert.equal(verified.value, 'Room 1');
});

test('R3 response loss then a 400 or 404: the read-back settles the applied write', async () => {
  for (const answer of [
    { kind: 'rejected', status: 400, reason: 'badRequest' },
    { kind: 'not-found', status: 404, reason: 'notFound' },
  ]) {
    const db = database({ claim: () => claimed([op(1, 'd1')]) });
    const source = reader([
      {
        parts: {
          d1: { kind: 'retry', status: 0, reason: 'timeout', transient: 1 },
        },
      },
      { reuse: true, parts: { d1: { ...answer, transient: 1 } } },
    ]);
    source.deviceStates = async (_c, _customer, ids) => {
      source.calls.push({ name: 'deviceStates', ids: [...ids] });
      return [
        {
          deviceId: 'd1',
          status: 'found',
          device: { deviceId: 'd1', annotatedLocation: 'Room 1' },
        },
      ];
    };
    const { create, sleeps } = jobs({ db, reader: source });
    const result = await create.runBatch(
      batchRequest,
      AbortSignal.timeout(5000),
    );
    assert.equal(result.outcome, 'settled');
    assert.ok(sleeps[0] >= 20_000, 'No GET starts before verifyAfter.');
    const [write, readBack] = settlements(db);
    assert.equal(JSON.parse(write.values[5])[0].outcome, 'unknown');
    assert.equal(readBack.values[4], 'read-back');
    const verified = JSON.parse(readBack.values[5])[0];
    assert.equal(verified.outcome, 'succeeded');
    assert.equal(verified.verifiedBy, 'read-back');
  }
});

test('a read-back compares blank and reports a missing device as not-found', async () => {
  const db = database({
    claim: () => claimed([op(1, 'd1'), op(2, 'd2')]),
    settle: (values) => {
      const kind = values[4];
      const results = JSON.parse(values[5]);
      const deviceOf = (number) => (number === 1 ? 'd1' : 'd2');
      const removed = results
        .filter((result) => result.outcomeReason === 'not-found')
        .map((result) => deviceOf(result.operationNumber));
      const published = results
        .filter((result) => result.outcome === 'succeeded')
        .map((result) => deviceOf(result.operationNumber));
      return {
        outcome: 'settled',
        settled: results.map((result) => ({
          operationNumber: result.operationNumber,
          deviceId: deviceOf(result.operationNumber),
          status: result.outcome,
          batch: 0,
        })),
        published,
        removed,
        publication:
          kind === 'read-back' && removed.length === 0
            ? null
            : {
                publicationId: 7,
                jobId,
                displayId,
                requestedBy,
                revision: 1,
                statusChanged: false,
                deviceIds: published,
                removedIds: removed,
                batch: 0,
                batchCount: 1,
              },
      };
    },
  });
  const source = reader(
    [
      {
        parts: {
          d1: { kind: 'retry', status: 0, reason: 'timeout', transient: 1 },
          d2: { kind: 'retry', status: 0, reason: 'timeout', transient: 1 },
        },
      },
      {
        reuse: true,
        parts: {
          d1: { kind: 'auth', status: 403, reason: 'forbidden', transient: 1 },
          d2: { kind: 'auth', status: 403, reason: 'forbidden', transient: 1 },
        },
      },
    ],
    [
      [
        { deviceId: 'd1', status: 'missing' },
        {
          deviceId: 'd2',
          status: 'found',
          device: { deviceId: 'd2', annotatedLocation: 'Other' },
        },
      ],
    ],
  );
  const store = cache();
  const { create } = jobs({ db, reader: source, batchSize: 2, cache: store });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.failure, 'permission-denied');
  const readBack = settlements(db).at(-1);
  const results = JSON.parse(readBack.values[5]);
  assert.deepEqual(
    results.map((result) => [result.outcome, result.outcomeReason]),
    [
      ['failed', 'not-found'],
      ['failed', 'value-differs'],
    ],
  );
  // The read-back settlement publishes: a missing device deletes its key.
  assert.deepEqual(
    store.calls.find((call) => call.name === 'remove')?.args[0],
    [`cc:entity:device:${customerId}:d1`],
  );
  assert.ok(
    store.calls.some((call) => call.name === 'publish'),
    'The read-back settlement publishes after the commit.',
  );
});

test('a failed read-back part leaves the operation unknown with verification-failed', async () => {
  const db = database({ claim: () => claimed([op(1, 'd1')]) });
  const source = reader([
    { mint: new GoogleConnectionError('network-failure') },
  ]);
  const { create } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'stopped');
  assert.equal(answer.failure, 'network-failure');
  const settled = settlements(db)[0];
  assert.equal(JSON.parse(settled.values[5])[0].outcome, 'skipped');
  assert.equal(settled.values[7], 'network-failure');
  assert.equal(source.calls[0].rounds, 0, 'A mint failure sends no part.');
});

test('a fatal batch error settles sent operations unknown and keeps a 2xx', async () => {
  const db = database({ claim: () => claimed([op(1, 'd1'), op(2, 'd2')]) });
  const source = reader([
    { parts: { d1: { kind: 'success' } } },
    {
      size: 1,
      fatal: new BatchServiceError('malformed-response', 'malformed multipart'),
    },
  ]);
  const { create } = jobs({ db, reader: source, batchSize: 1 });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'stopped');
  assert.equal(answer.failure, 'invalid-response');
  const last = settlements(db).at(-2);
  assert.deepEqual(
    JSON.parse(last.values[5]).map((result) => result.outcome),
    ['unknown'],
  );
  assert.equal(last.values[7], 'invalid-response');
});

test('a graceful stop returns unsent operations to pending and releases', async () => {
  const stopping = new AbortController();
  const db = database({ claim: () => claimed([op(1, 'd1'), op(2, 'd2')]) });
  const source = reader([{ abortBefore: true }]);
  const { create } = jobs({
    db,
    reader: source,
    onSleep: async () => stopping.abort(),
  });
  // Abort during the claim poll-free path: abort after the claim, before the write.
  const original = source.patchAnnotatedLocations;
  source.patchAnnotatedLocations = async (...args) => {
    stopping.abort();
    return original.apply(source, args);
  };
  const answer = await create.runBatch(batchRequest, stopping.signal);
  assert.equal(answer.outcome, 'settled');
  const settled = settlements(db)[0];
  assert.deepEqual(
    JSON.parse(settled.values[5]).map((result) => result.outcome),
    ['pending', 'pending'],
  );
  assert.equal(names(db.calls).at(-1), 'release_device_update_batch');
  assert.equal(source.calls[0].rounds, 0, 'No request leaves after the abort.');
});

test('an in-flight part at a graceful stop becomes unknown', async () => {
  const stopping = new AbortController();
  const db = database({ claim: () => claimed([op(1, 'd1')]) });
  const source = reader([{ hang: true }]);
  const { create, timers } = jobs({ db, reader: source });
  const running = create.runBatch(batchRequest, stopping.signal);
  await new Promise((resolve) => setImmediate(resolve));
  stopping.abort();
  const answer = await running;
  assert.equal(answer.outcome, 'settled');
  const settled = settlements(db)[0];
  assert.equal(JSON.parse(settled.values[5])[0].outcome, 'unknown');
  assert.equal(JSON.parse(settled.values[5])[0].outcomeReason, 'ambiguous');
  assert.equal(timers.timeoutCount, 0, 'The watchdog is cleared at the end.');
});

test('a rejected renewal fences the attempt and sends no later round', async () => {
  const db = database({
    claim: () => claimed([op(1, 'd1'), op(2, 'd2')]),
    renew: () => {
      throw Object.assign(new Error('renew'), {
        code: 'P0001',
        detail: 'attempt-fenced',
      });
    },
  });
  const source = reader([
    { parts: { d1: { kind: 'success' } } },
    { parts: { d2: { kind: 'success' } } },
  ]);
  const { create } = jobs({ db, reader: source, batchSize: 1 });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.deepEqual(answer, { outcome: 'attempt-fenced' });
  assert.equal(source.calls[0].rounds, 1);
  assert.equal(source.calls[0].aborted, true);
  assert.equal(
    names(db.calls).includes('release_device_update_batch'),
    false,
    'A fenced attempt never releases its lease.',
  );
});

test('the watchdog aborts the call 150 s after the last renewal', async () => {
  const db = database({ claim: () => claimed([op(1, 'd1')]) });
  const source = reader([{ hang: true }]);
  const { create, timers } = jobs({ db, reader: source });
  const running = create.runBatch(batchRequest, AbortSignal.timeout(5000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    timers.fireTimeout(),
    true,
    'The watchdog is armed after the claim.',
  );
  const answer = await running;
  assert.equal(answer.outcome, 'settled');
  assert.equal(source.calls[0].aborted, true);
  assert.equal(JSON.parse(settlements(db)[0].values[5])[0].outcome, 'unknown');
});

test('a recording that fails once with 40P01 settles on its second run', async () => {
  let attempts = 0;
  const db = database({
    claim: () => claimed([op(1, 'd1')]),
    settle: () => {
      attempts += 1;
      if (attempts === 1)
        throw Object.assign(new Error('deadlock'), { code: '40P01' });
      return undefined;
    },
  });
  const { create } = jobs({
    db,
    reader: reader([{ parts: { d1: { kind: 'success' } } }]),
  });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  assert.equal(attempts, 2);
});

test('a fenced write settlement stops the batch and answers attempt-fenced', async () => {
  const db = database({
    claim: () => claimed([op(1, 'd1')]),
    settle: () => ({ outcome: 'fenced' }),
  });
  const { create } = jobs({
    db,
    reader: reader([{ parts: { d1: { kind: 'success' } } }]),
  });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.deepEqual(answer, { outcome: 'attempt-fenced' });
  assert.equal(names(db.calls).includes('release_device_update_batch'), false);
});

test('a busy claim polls every 10 s and answers busy at the bound', async () => {
  let claims = 0;
  const db = database({
    claim: () => {
      claims += 1;
      return claims === 1 ? { outcome: 'busy' } : claimed([op(1, 'd1')]);
    },
  });
  const { create, sleeps } = jobs({
    db,
    reader: reader([{ parts: { d1: { kind: 'success' } } }]),
  });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  assert.deepEqual(sleeps, [10_000]);
});

test('a duplicate dispatch answers done and sends no part', async () => {
  const db = database({ claim: () => ({ outcome: 'done' }) });
  const source = reader();
  const { create } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.deepEqual(answer, { outcome: 'done' });
  assert.deepEqual(names(db.calls), ['claim_device_update_batch']);
  assert.equal(source.calls.length, 0);
});

test('a stopped claim answers stopped and sends no part', async () => {
  const db = database({
    claim: () => ({ outcome: 'stopped', failure: 'permission-denied' }),
  });
  const source = reader();
  const { create } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.deepEqual(answer, {
    outcome: 'stopped',
    failure: 'permission-denied',
  });
  assert.equal(source.calls.length, 0);
});

test('quota backoff reports start at the first retry and repeat every 60 s', async () => {
  const db = database({ claim: () => claimed([op(1, 'd1')]) });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const source = reader([
    {
      parts: { d1: { kind: 'retry', status: 429, reason: 'quota', quota: 1 } },
    },
    { gate, reuse: true, parts: { d1: { kind: 'success' } } },
  ]);
  const { create, timers } = jobs({ db, reader: source });
  const running = create.runBatch(batchRequest, AbortSignal.timeout(5000));
  const reports = () =>
    db.calls.filter((call) => call.name === 'report_device_update_backoff');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reports().length, 1, 'The first quota retry reports at once.');
  timers.fireInterval();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reports().length, 2);
  timers.fireInterval();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reports().length, 3);
  release();
  const answer = await running;
  assert.equal(answer.outcome, 'settled');
  assert.equal(timers.intervalCount, 0, 'The final answer stops the reporter.');
  timers.fireInterval();
  assert.equal(reports().length, 3);
  assert.deepEqual(
    reports().map((call) => call.values[5]),
    [1, 2, 3],
  );
});

test('publication removes keys, increments once, and publishes both events', async () => {
  const element = {
    publicationId: 7,
    jobId,
    displayId,
    requestedBy,
    revision: 3,
    statusChanged: true,
    deviceIds: ['d1'],
    removedIds: ['d2'],
    batch: 0,
    batchCount: 2,
  };
  const db = database({
    claim: () => claimed([op(1, 'd1')]),
    settle: () => ({
      outcome: 'settled',
      settled: [
        { operationNumber: 1, deviceId: 'd1', status: 'succeeded', batch: 0 },
      ],
      published: ['d1'],
      removed: ['d2'],
      publication: element,
    }),
  });
  const redis = cache();
  const { create } = jobs({
    db,
    reader: reader([{ parts: { d1: { kind: 'success' } } }]),
    cache: redis,
  });
  await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.deepEqual(names(redis.calls), [
    'remove',
    'increment',
    'publish',
    'publish',
  ]);
  assert.deepEqual(redis.calls[0].args[0], ['cc:entity:device:C0123456:d2']);
  assert.equal(redis.calls[1].args[0], 'cc:query-gen:device:C0123456');
  const entity = JSON.parse(redis.calls[2].args[1]);
  assert.equal(redis.calls[2].args[0], 'cc:entity-events:C0123456');
  assert.equal(entityEventSchema.parse(entity).type, 'entity-batch');
  assert.deepEqual(entity.deviceIds, ['d1']);
  assert.deepEqual(entity.removedIds, ['d2']);
  const job = JSON.parse(redis.calls[3].args[1]);
  assert.equal(redis.calls[3].args[0], 'cc:job-events:C0123456');
  assert.equal(jobEventSchema.parse(job).revision, 3);
  assert.equal(
    names(db.calls).indexOf('complete_job_publications') <
      names(db.calls).indexOf('release_device_update_batch'),
    true,
    'The publication row is deleted before the release.',
  );
});

test('a progress-only publication leaves its row to the relay', async () => {
  const db = database({
    claim: () => claimed([op(1, 'd1')]),
    settle: () => ({
      outcome: 'settled',
      settled: [],
      published: [],
      removed: [],
      publication: {
        publicationId: 8,
        jobId,
        displayId,
        requestedBy,
        revision: 1,
        statusChanged: false,
        deviceIds: [],
        removedIds: [],
        batch: 0,
        batchCount: 2,
      },
    }),
  });
  const redis = cache();
  const { create } = jobs({
    db,
    reader: reader([{ parts: { d1: { kind: 'success' } } }]),
    cache: redis,
  });
  await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.deepEqual(redis.calls, []);
  assert.equal(names(db.calls).includes('complete_job_publications'), false);
});

test('a Redis failure keeps the publication row for the relay', async () => {
  const db = database({
    claim: () => claimed([op(1, 'd1')]),
    settle: () => ({
      outcome: 'settled',
      settled: [
        { operationNumber: 1, deviceId: 'd1', status: 'succeeded', batch: 0 },
      ],
      published: ['d1'],
      removed: [],
      publication: {
        publicationId: 8,
        jobId,
        displayId,
        requestedBy,
        revision: 1,
        statusChanged: true,
        deviceIds: ['d1'],
        removedIds: [],
        batch: 0,
        batchCount: 2,
      },
    }),
  });
  const redis = cache();
  redis.increment = async () => {
    throw new EntityCacheError();
  };
  const { create } = jobs({
    db,
    reader: reader([{ parts: { d1: { kind: 'success' } } }]),
    cache: redis,
  });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  assert.equal(names(db.calls).includes('complete_job_publications'), false);
});

test('the finish prepares, reads back a chunk, and returns the publication', async () => {
  const element = {
    publicationId: 9,
    jobId,
    displayId,
    requestedBy,
    revision: 4,
    statusChanged: true,
    deviceIds: ['d1'],
    removedIds: [],
    batch: null,
    batchCount: null,
  };
  const db = database({
    claim: () => claimed([]),
    verificationClaim: (() => {
      let claimedChunks = 0;
      return () => {
        claimedChunks += 1;
        if (claimedChunks > 1) return [];
        return [
          {
            operationNumber: 1,
            deviceId: 'd1',
            serialNumber: 's1',
            baselineValue: null,
            requestedValue: 'Room 1',
            verifyAfter: null,
          },
        ];
      };
    })(),
    verificationRead: () => ({
      outcome: 'held',
      checkedAt: new Date(base).toISOString(),
      generation: 1,
      credentialId: randomUUID(),
      envelope: { sealed: true },
      operations: [
        {
          operationNumber: 1,
          deviceId: 'd1',
          serialNumber: 's1',
          baselineValue: null,
          requestedValue: 'Room 1',
          verifyAfter: new Date(base).toISOString(),
          verifyLeaseExpiresAt: new Date(base + 120_000).toISOString(),
        },
      ],
    }),
    finish: () => ({
      jobId,
      status: 'succeeded',
      succeeded: 1,
      failed: 0,
      unknown: 0,
      skipped: 0,
      finishedAt: new Date(base).toISOString(),
      publication: element,
    }),
  });
  const redis = cache();
  const source = reader(
    [],
    [
      [
        {
          deviceId: 'd1',
          status: 'found',
          device: { deviceId: 'd1', annotatedLocation: 'Room 1' },
        },
      ],
    ],
  );
  const { create } = jobs({ db, reader: source, cache: redis });
  const answer = await create.runFinish(
    { customerId, jobId, dispatchToken, correlationId },
    AbortSignal.timeout(5000),
  );
  assert.equal(answer.outcome, 'finished');
  assert.equal(answer.status, 'succeeded');
  assert.equal(answer.failure, null);
  assert.equal(answer.readBack.verified, 1);
  const order = names(db.calls).filter((name) => name !== 'clock_timestamp');
  assert.deepEqual(order, [
    'prepare_device_update_finish',
    'claim_device_update_verification',
    'read_device_update_verification',
    'settle_device_update_operations',
    'claim_device_update_verification',
    'finish_device_update_job',
    'complete_job_publications',
  ]);
  assert.equal(
    JSON.parse(settlements(db)[0].values[5])[0].verifiedBy,
    'read-back',
  );
  assert.equal(names(redis.calls).at(-1), 'publish');
});

test('the finish polls a busy preparation every 10 s', async () => {
  let preparations = 0;
  const db = database({
    claim: () => claimed([]),
    prepare: () => {
      preparations += 1;
      return preparations === 1
        ? { outcome: 'busy' }
        : { outcome: 'ready', failure: null };
    },
  });
  const { create, sleeps } = jobs({ db });
  const answer = await create.runFinish(
    { customerId, jobId, dispatchToken, correlationId },
    AbortSignal.timeout(5000),
  );
  assert.equal(answer.outcome, 'finished');
  assert.deepEqual(sleeps, [10_000]);
});

test('reconcile with a number answers not-held when the attempt holds nothing', async () => {
  const db = database({ verificationRead: () => ({ outcome: 'not-held' }) });
  const source = reader();
  const { create } = jobs({ db, reader: source });
  const answer = await create.runReconcile(
    {
      customerId,
      jobId,
      operationNumber: 3,
      verifyAttempt: randomUUID(),
      correlationId,
    },
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(answer, { outcome: 'not-held' });
  assert.equal(source.calls.length, 0, 'A not-held answer sends no GET.');
  assert.deepEqual(names(db.calls), ['read_device_update_verification']);
});

test('reconcile with a number reads its operation and settles it', async () => {
  const attempt = randomUUID();
  const db = database({
    verificationRead: () => ({
      outcome: 'held',
      checkedAt: new Date(base).toISOString(),
      generation: 1,
      credentialId: randomUUID(),
      envelope: { sealed: true },
      operations: [
        {
          operationNumber: 3,
          deviceId: 'd3',
          serialNumber: 's3',
          baselineValue: null,
          requestedValue: 'Room 3',
          verifyAfter: new Date(base - 1000).toISOString(),
          verifyLeaseExpiresAt: new Date(base + 120_000).toISOString(),
        },
      ],
    }),
  });
  const source = reader(
    [],
    [
      [
        {
          deviceId: 'd3',
          status: 'found',
          device: { deviceId: 'd3', annotatedLocation: 'Room 3' },
        },
      ],
    ],
  );
  const { create } = jobs({ db, reader: source });
  const answer = await create.runReconcile(
    {
      customerId,
      jobId,
      operationNumber: '3',
      verifyAttempt: attempt,
      correlationId,
    },
    AbortSignal.timeout(5000),
  );
  assert.equal(answer.outcome, 'settled');
  assert.equal(answer.readBack.verified, 1);
  assert.deepEqual(db.calls[0].values, [customerId, jobId, attempt, '[3]']);
  assert.deepEqual(source.calls[0].ids, ['d3']);
});

test('reconcile for all claims chunks until an empty claim', async () => {
  let claims = 0;
  const db = database({
    verificationClaim: () => {
      claims += 1;
      if (claims > 2) return [];
      return [
        {
          operationNumber: claims,
          deviceId: `d${claims}`,
          serialNumber: null,
          baselineValue: null,
          requestedValue: `Room ${claims}`,
          verifyAfter: null,
        },
      ];
    },
    verificationRead: (values) => {
      const number = JSON.parse(values[3])[0];
      return {
        outcome: 'held',
        checkedAt: new Date(base).toISOString(),
        generation: 1,
        credentialId: randomUUID(),
        envelope: { sealed: true },
        operations: [
          {
            operationNumber: number,
            deviceId: `d${number}`,
            serialNumber: null,
            baselineValue: null,
            requestedValue: `Room ${number}`,
            verifyAfter: new Date(base).toISOString(),
            verifyLeaseExpiresAt: new Date(base + 120_000).toISOString(),
          },
        ],
      };
    },
  });
  const source = reader(
    [],
    [
      [
        {
          deviceId: 'd1',
          status: 'found',
          device: { deviceId: 'd1', annotatedLocation: 'Room 1' },
        },
      ],
      [
        {
          deviceId: 'd2',
          status: 'found',
          device: { deviceId: 'd2', annotatedLocation: 'Room 2' },
        },
      ],
    ],
  );
  const { create } = jobs({ db, reader: source });
  const answer = await create.runReconcile(
    { customerId, jobId, operationNumber: 'all', correlationId },
    AbortSignal.timeout(5000),
  );
  assert.equal(answer.outcome, 'settled');
  assert.equal(answer.readBack.claimed, 2);
  assert.equal(answer.readBack.verified, 2);
  assert.deepEqual(
    db.calls
      .filter((call) => call.name === 'claim_device_update_verification')
      .map((call) => call.values.slice(4)),
    [
      [null, 250],
      [1, 250],
      [2, 250],
    ],
  );
});

test('a store failure answers nothing and leaves the lease to lapse', async () => {
  const db = database({
    claim: () => claimed([op(1, 'd1')]),
    fail: { settle_device_update_operations: 'store down' },
  });
  const { create } = jobs({
    db,
    reader: reader([{ parts: { d1: { kind: 'success' } } }]),
  });
  await assert.rejects(
    create.runBatch(batchRequest, AbortSignal.timeout(5000)),
    (error) =>
      error instanceof DeviceSyncError && error.code === 'store-unavailable',
  );
  assert.equal(names(db.calls).includes('release_device_update_batch'), false);
});
