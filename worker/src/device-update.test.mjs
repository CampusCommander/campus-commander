import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { z } from 'zod';
import {
  entityEventSchema,
  jobEventSchema,
} from '@campus/application-contracts';
import { BatchServiceError } from '@campus/google-connection';
import {
  DEVICE_UPDATE_BATCH_SIZE_LIMIT,
  DeviceUpdateJobs,
  classifyCommandPoll,
  classifyWrite,
  deviceCommandPollRequestSchema,
  deviceUpdateReconcileRequestSchema,
  resolveDeviceUpdateBatchSize,
} from './device-update.ts';
import {
  handleDeviceCommandPollDispatch,
  handleDeviceUpdateBatchDispatch,
  handleDeviceUpdateReconcileDispatch,
} from './dispatch.ts';
import { DeviceSyncError } from './device-sync.ts';
import { EntityCacheError, deferredEntityCache } from './entity-cache.ts';

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

/** One claimed operation of the write path, with its one annotatedLocation field row. */
const op = (number, deviceId, value = `Room ${number}`, fields = null) => ({
  operationNumber: number,
  deviceId,
  serialNumber: `serial-${number}`,
  baselineValue: null,
  requestedValue: value,
  fields: fields ?? [
    { field: 'annotatedLocation', baselineValue: null, requestedValue: value },
  ],
});

/** One claimed operation of a status action: no field rows. */
const statusOp = (number, deviceId, value) => op(number, deviceId, value, []);

const claimed = (
  operations,
  readBack = [],
  action = 'annotated-location',
  extra = {},
) => ({
  outcome: 'claimed',
  generation: 1,
  credentialId: randomUUID(),
  envelope: { sealed: true },
  batchCount: 2,
  action,
  ...extra,
  operations,
  readBack,
});

const part = (
  id,
  {
    kind = 'success',
    status = 200,
    reason = null,
    value = undefined,
    commandId = undefined,
    fields = undefined,
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
          page:
            commandId !== undefined
              ? { commandId }
              : fields !== undefined
                ? { deviceId: id, ...fields }
                : value === undefined
                  ? { deviceId: id }
                  : { deviceId: id, annotatedLocation: value },
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
function reader(rounds = [], states = [], statusRounds = [], pollRounds = []) {
  return {
    calls: [],
    async patchDevices(_credential, _customer, writes, signal, options) {
      const call = {
        name: 'patchDevices',
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
        // A part stays in flight across this gate, so a test can act mid-round.
        if (round.answerGate) await round.answerGate;
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
          // A 2xx body names the value it wrote, so an answer without an explicit
          // value echoes the fields of its write.
          const echo =
            answer.kind === 'success' &&
            answer.value === undefined &&
            answer.fields === undefined &&
            answer.commandId === undefined
              ? {
                  fields:
                    writes.find((write) => write.deviceId === id)?.fields ?? {},
                }
              : {};
          const event = {
            ...part(id, { ...answer, ...echo }),
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
    /** The command issue path: one POST part per operation, each 2xx naming a command ID. */
    async issueDeviceCommands(
      _credential,
      _customer,
      commands,
      signal,
      options,
    ) {
      const call = {
        name: 'issueDeviceCommands',
        commands: commands.map((command) => ({ ...command })),
        batchSize: options.batchSize,
        aborted: false,
        rounds: 0,
      };
      this.calls.push(call);
      const result = { succeeded: new Map(), failed: new Map() };
      let next = 0;
      let number = 0;
      let lastIds = [];
      let commandNumber = 4_100_000_000;
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
          : commands
              .slice(next, next + size)
              .map((command) => command.deviceId);
        if (!round.reuse) next += ids.length;
        lastIds = ids;
        await options.onSend?.(ids);
        call.rounds += 1;
        // A part stays in flight across this gate, so a test can act mid-round.
        if (round.answerGate) await round.answerGate;
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
          commandNumber += 1;
          const answer = round.parts?.[id] ?? {
            kind: 'success',
            commandId: String(commandNumber),
          };
          const event = {
            ...part(id, answer),
            request: {
              id,
              method: 'POST',
              path: `/admin/directory/v1/customer/${customerId}/devices/chromeos/${id}:issueCommand`,
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
          pending: commands.length - next,
        });
      }
      return result;
    },
    /** The poll path: one GET part per issued operation, answered by `pollRounds`. */
    async deviceCommands(_credential, _customer, polls, signal, options) {
      const call = {
        name: 'deviceCommands',
        polls: polls.map((poll) => ({ ...poll })),
        batchSize: options.batchSize,
        aborted: false,
        rounds: 0,
      };
      this.calls.push(call);
      const result = { succeeded: new Map(), failed: new Map() };
      // A plan is one round list per call, or one round list for the single call.
      const calls = this.calls.filter((one) => one.name === 'deviceCommands');
      const plan = Array.isArray(pollRounds[0])
        ? (pollRounds[calls.length - 1] ?? [])
        : pollRounds;
      let next = 0;
      let number = 0;
      let lastIds = [];
      for (const round of plan) {
        if (signal.aborted) {
          call.aborted = true;
          break;
        }
        number += 1;
        if (round.mint) throw round.mint;
        const size = round.size ?? options.batchSize ?? 250;
        const ids = round.reuse
          ? lastIds
          : polls.slice(next, next + size).map((poll) => poll.deviceId);
        if (!round.reuse) next += ids.length;
        lastIds = ids;
        await options.onSend?.(ids);
        call.rounds += 1;
        if (round.fatal) throw round.fatal;
        for (const id of ids) {
          const answer = round.parts?.[id] ?? {
            kind: 'success',
            observation: {
              commandId: '4100000001',
              state: 'PENDING',
              issuedAt: null,
              expiresAt: null,
              result: null,
              executedAt: null,
              errorMessage: null,
            },
          };
          const event =
            answer.kind === 'success'
              ? {
                  id,
                  status: answer.status ?? 200,
                  attempts: { quota: 0, transient: 0 },
                  outcome: {
                    kind: 'success',
                    page: answer.observation,
                    pageIndex: 0,
                    hasNextPage: false,
                  },
                  request: { id, method: 'GET', path: '' },
                }
              : {
                  ...part(id, answer),
                  request: { id, method: 'GET', path: '' },
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
          pending: polls.length - next,
        });
      }
      return result;
    },
    async changeDeviceStatus(_credential, _customer, changes, signal, options) {
      const call = {
        name: 'changeDeviceStatus',
        changes: changes.map((change) => ({ ...change })),
        batchSize: options.batchSize,
        aborted: false,
        parts: [],
        rounds: 0,
      };
      this.calls.push(call);
      // Group the changes into parts of up to 50, in request order, as the real reader does.
      // A new action or a new deprovision reason starts a new part (addendum section 5).
      const parts = [];
      for (const change of changes) {
        const last = parts[parts.length - 1];
        if (
          last !== undefined &&
          last.action === change.action &&
          last.deprovisionReason === change.deprovisionReason &&
          last.deviceIds.length < 50
        ) {
          last.deviceIds.push(change.deviceId);
          continue;
        }
        parts.push({
          id: `status-${parts.length + 1}`,
          action: change.action,
          ...(change.deprovisionReason === undefined
            ? {}
            : { deprovisionReason: change.deprovisionReason }),
          deviceIds: [change.deviceId],
        });
      }
      const perRound = options.batchSize ?? 250;
      let number = 0;
      for (let start = 0; start < parts.length; start += perRound) {
        if (signal.aborted) {
          call.aborted = true;
          break;
        }
        const round = statusRounds[number] ?? {};
        number += 1;
        if (round.gate) await round.gate;
        const sent = parts.slice(start, start + perRound);
        await options.onSend?.(sent);
        call.rounds += 1;
        for (const part of sent)
          call.parts.push({
            id: part.id,
            action: part.action,
            ...(part.deprovisionReason === undefined
              ? {}
              : { deprovisionReason: part.deprovisionReason }),
            deviceIds: [...part.deviceIds],
          });
        if (round.gate) await round.gate;
        for (const part of sent) {
          if (round.failure) {
            await options.onResponse?.({
              id: part.id,
              request: { id: part.id, method: 'POST', path: '' },
              attempts: round.failure.attempts,
              status: round.failure.status,
              outcome: { kind: 'failed', failure: round.failure },
            });
            continue;
          }
          const page = part.deviceIds.map(
            (deviceId) =>
              round.results?.[deviceId] ?? {
                deviceId,
                outcome: 'succeeded',
                reason: null,
                googleReason: null,
              },
          );
          await options.onResponse?.({
            id: part.id,
            request: { id: part.id, method: 'POST', path: '' },
            attempts: { quota: 0, transient: 0 },
            status: 200,
            outcome: {
              kind: 'success',
              page,
              pageIndex: 0,
              hasNextPage: false,
            },
          });
        }
        await options.onBatch?.({
          round: number,
          sentCount: sent.length,
          outerStatus: 200,
          durationMs: 1,
          pending: parts.length - start - sent.length,
        });
      }
      return { answers: [], parts };
    },
    async deviceStates(_credential, _customer, ids, signal) {
      const call = {
        name: 'deviceStates',
        ids: [...ids],
        aborted: signal.aborted,
      };
      this.calls.push(call);
      const nextState = states.shift();
      if (nextState instanceof Error) throw nextState;
      // A held read-back waits for the abort of its window, as a real GET does.
      if (nextState?.hang === true) {
        await new Promise((resolve) => {
          if (signal.aborted) resolve(undefined);
          else signal.addEventListener('abort', resolve, { once: true });
        });
        call.aborted = signal.aborted;
        throw Object.assign(new Error('read-back aborted'), {
          name: 'AbortError',
        });
      }
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
  const stamp = () =>
    overrides.clock
      ? new Date(overrides.clock())
      : new Date(base + ++ticks * 1000);
  const answer = (name, values) => {
    if (name === 'claim_device_update_batch')
      return overrides.claim ? overrides.claim(values) : claimed([op(1, 'd1')]);
    if (name === 'renew_device_update_batch')
      return overrides.renew ? overrides.renew(values) : stamp();
    if (name === 'job_cancel_requested')
      return overrides.cancel ? overrides.cancel(values) : false;
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
            expired: 0,
            finishedAt: stamp().toISOString(),
            publication: null,
          };
    if (name === 'complete_job_publications') return 1;
    if (name === 'claim_device_command_polls')
      return overrides.pollClaim
        ? overrides.pollClaim(values)
        : { outcome: 'not-held' };
    if (name === 'settle_device_command_polls') {
      if (overrides.pollSettle) {
        const answer = overrides.pollSettle(values);
        if (answer !== undefined) return answer;
      }
      const results = JSON.parse(values[4]);
      return {
        outcome: 'settled',
        settled: results.map((result) => ({
          operationNumber: result.operationNumber,
          deviceId: `d${result.operationNumber}`,
          status: result.outcome === 'pending' ? 'issued' : result.outcome,
        })),
        publication: null,
        status: 'awaiting-devices',
        jobStatusChanged: false,
      };
    }
    if (name === 'release_device_command_poll') return true;
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
    options.cipher ?? { open: () => ({ subject: 'fixture@example.invalid' }) },
    options.reader ?? reader(),
    options.cache ?? cache(),
    {
      batchSize: options.batchSize,
      timers,
      now: options.now ?? Date.now,
      sleep:
        options.sleep ??
        (async (milliseconds) => {
          sleeps.push(milliseconds);
          if (options.onSleep) await options.onSleep(milliseconds);
        }),
    },
  );
  return { create, timers: timerSet, sleeps };
}

/** Timers whose callbacks the test fires by hand. Each one records its delay. */
function realishTimers() {
  const timeouts = new Map();
  const intervals = new Map();
  let sequence = 0;
  const timers = {
    setTimeout(callback, delay) {
      const id = ++sequence;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(callback, delay) {
      const id = ++sequence;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
  };
  return {
    timers,
    fireTimeout() {
      const [id, entry] = [...timeouts.entries()][0] ?? [];
      if (entry === undefined) return false;
      timeouts.delete(id);
      entry.callback();
      return true;
    },
    fireInterval() {
      for (const entry of [...intervals.values()]) entry.callback();
    },
    get timeoutCount() {
      return timeouts.size;
    },
    get intervalCount() {
      return intervals.size;
    },
    delays() {
      return [...timeouts.values(), ...intervals.values()].map(
        (entry) => entry.delay,
      );
    },
  };
}

/**
 * Timers and a clock that the test advances together. A due callback runs when
 * `advance` reaches its delay, and every scheduled delay is recorded.
 */
function advancingTimers(start = 0) {
  let now = start;
  let sequence = 0;
  const timers = new Map();
  const schedule = (kind) => (callback, delay) => {
    const id = ++sequence;
    timers.set(id, { kind, due: now + delay, delay, callback });
    return id;
  };
  const handle = {
    setTimeout: schedule('timeout'),
    clearTimeout: (id) => timers.delete(id),
    setInterval: schedule('interval'),
    clearInterval: (id) => timers.delete(id),
  };
  return {
    timers: handle,
    get now() {
      return now;
    },
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, entry]) => entry.due <= target)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (next === undefined) break;
        const [id, entry] = next;
        now = entry.due;
        if (entry.kind === 'timeout') timers.delete(id);
        else entry.due = now + entry.delay;
        entry.callback();
      }
      now = target;
    },
    delays() {
      return [...timers.values()].map((entry) => entry.delay);
    },
    get count() {
      return timers.size;
    },
  };
}

/** Let queued promise work run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Let queued promise work run until the condition holds. */
async function until(predicate, limit = 50) {
  for (let count = 0; count < limit; count += 1) {
    if (predicate()) return;
    await flush();
  }
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
    observed: null,
    status: null,
    attempts: { quota: 0, transient: 0 },
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

  assert.deepEqual(
    run(
      tracked({
        succeeded: true,
        status: 200,
        observed: { annotatedLocation: 'Normalized Room 1' },
        attempts: { quota: 0, transient: 1 },
      }),
    ),
    {
      operationNumber: 1,
      outcome: 'failed',
      outcomeReason: 'value-differs',
      verifiedBy: 'write-response',
      googleStatus: 200,
      googleReason: null,
      quotaRetries: 0,
      transientRetries: 1,
      values: { annotatedLocation: 'Normalized Room 1' },
    },
  );
  // A 2xx body that names the requested value verifies the write by its response.
  assert.deepEqual(
    run(
      tracked({
        succeeded: true,
        status: 200,
        observed: { annotatedLocation: 'Room 1' },
      }),
    ),
    {
      operationNumber: 1,
      outcome: 'succeeded',
      verifiedBy: 'write-response',
      googleStatus: 200,
      googleReason: null,
      quotaRetries: 0,
      transientRetries: 0,
      values: { annotatedLocation: 'Room 1' },
    },
  );
  // A 2xx body without the field reads null, so a requested value differs (section 4).
  assert.deepEqual(run(tracked({ succeeded: true, status: 200 })), {
    operationNumber: 1,
    outcome: 'failed',
    outcomeReason: 'value-differs',
    verifiedBy: 'write-response',
    googleStatus: 200,
    googleReason: null,
    quotaRetries: 0,
    transientRetries: 0,
    values: { annotatedLocation: null },
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

test('item 18: the round-1 settlement takes the renewal stamp, so a later refresh wins', async () => {
  // A refresh read stamped after round 1's renewal must beat the write. The
  // worker proves it by stamping the settlement with that renewal time.
  const renewalStamp = new Date(base + 50_000);
  const refreshStamp = new Date(base + 60_000);
  const db = database({
    claim: () => claimed([op(1, 'd1'), op(2, 'd2')]),
    renew: () => renewalStamp,
  });
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
  assert.deepEqual(
    names(db.calls).filter((name) => name !== 'clock_timestamp'),
    [
      'claim_device_update_batch',
      'renew_device_update_batch',
      'settle_device_update_operations',
      'release_device_update_batch',
    ],
  );
  assert.equal(
    names(db.calls).includes('report_device_update_backoff'),
    false,
    'The worker makes no separate heartbeat call (ruling 7).',
  );
  const settled = settlements(db)[0];
  assert.equal(settled.values[4], 'write');
  assert.equal(
    settled.values[3],
    db.calls.find((call) => call.name === 'claim_device_update_batch')
      .values[4],
  );
  assert.equal(
    settled.values[6],
    renewalStamp.toISOString(),
    'The settlement carries the renewal time after round 1.',
  );
  assert.ok(
    refreshStamp.getTime() > Date.parse(settled.values[6]),
    'A refresh read after that renewal carries the later stamp.',
  );
  assert.deepEqual(
    JSON.parse(settled.values[5]).map((result) => result.outcome),
    ['succeeded', 'succeeded'],
  );
  assert.deepEqual(source.calls[0].writes, [
    { deviceId: 'd1', fields: { annotatedLocation: 'Room 1' } },
    { deviceId: 'd2', fields: { annotatedLocation: 'Room 2' } },
  ]);
});

test('a clear sends a null value', async () => {
  const db = database({ claim: () => claimed([op(1, 'd1', null)]) });
  const source = reader([{ parts: { d1: { kind: 'success' } } }]);
  const { create } = jobs({ db, reader: source });
  await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.deepEqual(source.calls[0].writes, [
    { deviceId: 'd1', fields: { annotatedLocation: null } },
  ]);
});

test('an Asset tag write sends annotatedAssetId and records the answer assetTag', async () => {
  const db = database({
    claim: () =>
      claimed([
        op(1, 'd1', 'HS-0417', [
          {
            field: 'annotatedAssetId',
            baselineValue: 'HS-0001',
            requestedValue: 'HS-0417',
          },
        ]),
      ]),
  });
  const source = reader([
    { parts: { d1: { kind: 'success', fields: { assetTag: 'HS-0417' } } } },
  ]);
  const { create } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  assert.deepEqual(
    source.calls[0].writes,
    [{ deviceId: 'd1', fields: { annotatedAssetId: 'HS-0417' } }],
    'The write names the field by its Google property.',
  );
  assert.deepEqual(JSON.parse(settlements(db)[0].values[5]), [
    {
      operationNumber: 1,
      outcome: 'succeeded',
      verifiedBy: 'write-response',
      googleStatus: 200,
      googleReason: null,
      quotaRetries: 0,
      transientRetries: 0,
      values: { annotatedAssetId: 'HS-0417' },
    },
  ]);
});

test('an Asset tag answer compares exactly', async () => {
  const db = database({
    claim: () =>
      claimed([
        op(1, 'd1', 'HS-0417', [
          {
            field: 'annotatedAssetId',
            baselineValue: 'HS-0001',
            requestedValue: 'HS-0417',
          },
        ]),
      ]),
  });
  const source = reader([
    { parts: { d1: { kind: 'success', fields: { assetTag: 'hs-0417' } } } },
  ]);
  const { create } = jobs({ db, reader: source });
  await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.deepEqual(JSON.parse(settlements(db)[0].values[5]), [
    {
      operationNumber: 1,
      outcome: 'failed',
      outcomeReason: 'value-differs',
      verifiedBy: 'write-response',
      googleStatus: 200,
      googleReason: null,
      quotaRetries: 0,
      transientRetries: 0,
      values: { annotatedAssetId: 'hs-0417' },
    },
  ]);
});

test('an Asset tag read-back compares the answer assetTag', async () => {
  const db = database({
    claim: () =>
      claimed([
        op(1, 'd1', 'HS-0417', [
          {
            field: 'annotatedAssetId',
            baselineValue: 'HS-0001',
            requestedValue: 'HS-0417',
          },
        ]),
      ]),
  });
  const source = reader(
    [
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
    ],
    [
      [
        {
          deviceId: 'd1',
          status: 'found',
          device: { deviceId: 'd1', assetTag: 'HS-0417' },
        },
      ],
    ],
  );
  const { create } = jobs({ db, reader: source, cache: cache() });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.failure, 'permission-denied');
  const results = JSON.parse(settlements(db).at(-1).values[5]);
  assert.deepEqual(
    results.map((result) => [result.outcome, result.verifiedBy, result.values]),
    [['succeeded', 'read-back', { annotatedAssetId: 'HS-0417' }]],
    'The read-back reads the assetTag of the device answer under the field ID.',
  );
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
  assert.equal(verified.values.annotatedLocation, 'Room 1');
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

test('a Disable claim sends one status part and settles each device element', async () => {
  const db = database({
    claim: () =>
      claimed(
        [statusOp(1, 'd1', 'DISABLED'), statusOp(2, 'd2', 'DISABLED')],
        [],
        'disable',
      ),
    settle: (values) => {
      if (values[4] === 'read-back') return undefined;
      const results = JSON.parse(values[5]);
      return {
        outcome: 'settled',
        settled: results.map((result) => ({
          operationNumber: result.operationNumber,
          deviceId: result.operationNumber === 1 ? 'd1' : 'd2',
          status: result.outcome,
          batch: 0,
        })),
        published: ['d1'],
        removed: [],
        publication: {
          publicationId: 9,
          jobId,
          displayId,
          requestedBy,
          revision: 1,
          statusChanged: false,
          deviceIds: ['d1'],
          removedIds: [],
          batch: 0,
          batchCount: 1,
        },
      };
    },
  });
  const source = reader(
    [],
    [],
    [
      {
        results: {
          d1: {
            deviceId: 'd1',
            outcome: 'succeeded',
            reason: null,
            googleReason: null,
          },
          d2: {
            deviceId: 'd2',
            outcome: 'failed',
            reason: 'status-conflict',
            googleReason:
              'A device with status DISABLED does not allow this action.',
          },
        },
      },
    ],
  );
  const store = cache();
  const { create } = jobs({ db, reader: source, cache: store });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.deepEqual(answer, {
    outcome: 'settled',
    failure: null,
    published: 1,
    removed: 0,
  });
  const call = source.calls.find((one) => one.name === 'changeDeviceStatus');
  assert.deepEqual(call.changes, [
    { deviceId: 'd1', action: 'disable' },
    { deviceId: 'd2', action: 'disable' },
  ]);
  assert.equal(
    call.batchSize,
    250,
    'One multipart request holds up to 250 status parts.',
  );
  // Both device IDs travel in one part of at most 50 (addendum section 5).
  assert.deepEqual(
    call.parts.map((one) => one.deviceIds),
    [['d1', 'd2']],
  );
  assert.deepEqual(JSON.parse(settlements(db)[0].values[5]), [
    {
      operationNumber: 1,
      outcome: 'succeeded',
      verifiedBy: 'write-response',
      googleStatus: null,
      googleReason: null,
      quotaRetries: 0,
      transientRetries: 0,
    },
    {
      operationNumber: 2,
      outcome: 'failed',
      outcomeReason: 'status-conflict',
      googleReason: 'A device with status DISABLED does not allow this action.',
      value: null,
      googleStatus: null,
      quotaRetries: 0,
      transientRetries: 0,
    },
  ]);
  // Only the accepted device enters the entity-batch publication of the grid.
  const entity = JSON.parse(
    store.calls.find((one) => one.name === 'publish').args[1],
  );
  assert.equal(entityEventSchema.parse(entity).type, 'entity-batch');
  assert.deepEqual(entity.deviceIds, ['d1']);
});

test('a Re-enable claim sends the re-enable action', async () => {
  const db = database({
    claim: () => claimed([statusOp(1, 'd1', 'ACTIVE')], [], 'reenable'),
  });
  const source = reader([], [], [{ results: {} }]);
  const { create } = jobs({ db, reader: source });
  await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.deepEqual(
    source.calls.find((one) => one.name === 'changeDeviceStatus').changes,
    [{ deviceId: 'd1', action: 'reenable' }],
  );
});

test('a Deprovision claim sends its action and reason, and a deprovisioned target fails status-conflict', async () => {
  const deprovisionReason = 'DEPROVISION_REASON_RETIRING_DEVICE';
  const db = database({
    claim: () =>
      claimed(
        [
          statusOp(1, 'd1', 'DEPROVISIONED'),
          statusOp(2, 'd2', 'DEPROVISIONED'),
        ],
        [],
        'deprovision',
        { deprovisionReason },
      ),
  });
  const source = reader(
    [],
    [],
    [
      {
        results: {
          d1: {
            deviceId: 'd1',
            outcome: 'succeeded',
            reason: null,
            googleReason: null,
          },
          d2: {
            deviceId: 'd2',
            outcome: 'failed',
            reason: 'status-conflict',
            googleReason:
              'A device with status DEPROVISIONED does not allow this action.',
          },
        },
      },
    ],
  );
  const { create } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  const call = source.calls.find((one) => one.name === 'changeDeviceStatus');
  // The reason of the job travels with every change and in its part (B2, section 4).
  assert.deepEqual(call.changes, [
    { deviceId: 'd1', action: 'deprovision', deprovisionReason },
    { deviceId: 'd2', action: 'deprovision', deprovisionReason },
  ]);
  assert.deepEqual(call.parts, [
    {
      id: 'status-1',
      action: 'deprovision',
      deprovisionReason,
      deviceIds: ['d1', 'd2'],
    },
  ]);
  assert.deepEqual(JSON.parse(settlements(db)[0].values[5]), [
    {
      operationNumber: 1,
      outcome: 'succeeded',
      verifiedBy: 'write-response',
      googleStatus: null,
      googleReason: null,
      quotaRetries: 0,
      transientRetries: 0,
    },
    {
      operationNumber: 2,
      outcome: 'failed',
      outcomeReason: 'status-conflict',
      googleReason:
        'A device with status DEPROVISIONED does not allow this action.',
      value: null,
      googleStatus: null,
      quotaRetries: 0,
      transientRetries: 0,
    },
  ]);
});

test('a Deprovision claim without its reason is refused before any status call', async () => {
  const db = database({
    claim: () =>
      claimed([statusOp(1, 'd1', 'DEPROVISIONED')], [], 'deprovision'),
  });
  const source = reader([], [], [{ results: {} }]);
  const { create } = jobs({ db, reader: source });
  await assert.rejects(
    create.runBatch(batchRequest, AbortSignal.timeout(5000)),
    (error) =>
      error instanceof z.ZodError &&
      error.issues.some(
        (issue) => issue.path.join('.') === 'deprovisionReason',
      ),
  );
  assert.equal(
    source.calls.some((one) => one.name === 'changeDeviceStatus'),
    false,
    'No status call leaves the worker without a reason (B2 requires one).',
  );
});

test('a status read-back compares the device status', async () => {
  const db = database({
    claim: () =>
      claimed(
        [statusOp(1, 'd1', 'DISABLED'), statusOp(2, 'd2', 'DISABLED')],
        [],
        'disable',
      ),
  });
  const source = reader(
    [],
    [
      [
        {
          deviceId: 'd1',
          status: 'found',
          device: { deviceId: 'd1', status: 'DISABLED' },
        },
        {
          deviceId: 'd2',
          status: 'found',
          device: { deviceId: 'd2', status: 'ACTIVE' },
        },
      ],
    ],
    [
      {
        failure: {
          kind: 'transient',
          status: 503,
          reason: 'unavailable',
          attempts: { quota: 0, transient: 0 },
          body: null,
        },
      },
    ],
  );
  const { create } = jobs({ db, reader: source, batchSize: 2 });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  assert.deepEqual(
    source.calls.find((one) => one.name === 'deviceStates').ids,
    ['d1', 'd2'],
  );
  assert.deepEqual(JSON.parse(settlements(db).at(-1).values[5]), [
    {
      operationNumber: 1,
      outcome: 'succeeded',
      verifiedBy: 'read-back',
      value: 'DISABLED',
    },
    {
      operationNumber: 2,
      outcome: 'failed',
      outcomeReason: 'value-differs',
      verifiedBy: 'read-back',
      value: 'ACTIVE',
    },
  ]);
});

test('a failed status part settles every device it held by the step 4 rules', async () => {
  const db = database({
    claim: () =>
      claimed(
        [statusOp(1, 'd1', 'ACTIVE'), statusOp(2, 'd2', 'ACTIVE')],
        [],
        'reenable',
      ),
  });
  const source = reader(
    [],
    [],
    [
      {
        failure: {
          kind: 'transient',
          status: 503,
          reason: 'unavailable',
          attempts: { quota: 2, transient: 0 },
          body: null,
        },
      },
    ],
  );
  const { create } = jobs({ db, reader: source, batchSize: 2 });
  await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.deepEqual(JSON.parse(settlements(db)[0].values[5]), [
    {
      operationNumber: 1,
      outcome: 'unknown',
      outcomeReason: 'ambiguous',
      googleStatus: 503,
      googleReason: 'unavailable',
      quotaRetries: 2,
      transientRetries: 0,
    },
    {
      operationNumber: 2,
      outcome: 'unknown',
      outcomeReason: 'ambiguous',
      googleStatus: 503,
      googleReason: 'unavailable',
      quotaRetries: 2,
      transientRetries: 0,
    },
  ]);
});

test('a failed read-back part leaves the operation unknown with verification-failed', async () => {
  const db = database({ claim: () => claimed([op(1, 'd1')]) });
  const source = reader(
    [
      {
        parts: {
          d1: { kind: 'retry', status: 0, reason: 'timeout', transient: 1 },
        },
      },
      {
        reuse: true,
        parts: {
          d1: {
            kind: 'auth',
            status: 403,
            reason: 'forbidden',
            transient: 1,
          },
        },
      },
    ],
    [
      [
        {
          deviceId: 'd1',
          status: 'failed',
          failure: {
            kind: 'auth',
            status: 403,
            reason: 'forbidden',
            attempts: { quota: 0, transient: 0 },
            body: null,
          },
        },
      ],
    ],
  );
  const { create } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'stopped');
  const readBack = settlements(db).at(-1);
  assert.equal(readBack.values[4], 'read-back');
  const result = JSON.parse(readBack.values[5])[0];
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.outcomeReason, 'verification-failed');
  assert.equal(
    source.calls.filter((call) => call.name === 'deviceStates').length,
    1,
    'The failed part settles without a later GET.',
  );
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
  const original = source.patchDevices;
  source.patchDevices = async (...args) => {
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
  let cancelReadCalls = 0;
  const db = database({
    claim: () => claimed([op(1, 'd1'), op(2, 'd2')]),
    renew: () => {
      throw Object.assign(new Error('renew'), {
        code: 'P0001',
        detail: 'attempt-fenced',
      });
    },
    // A fenced renewal is a lost lease, not a cancel: it reads no request.
    cancel: () => {
      cancelReadCalls += 1;
      return true;
    },
  });
  const source = reader([
    { parts: { d1: { kind: 'success' } } },
    { parts: { d2: { kind: 'success' } } },
  ]);
  const { create } = jobs({ db, reader: source, batchSize: 1 });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.deepEqual(answer, { outcome: 'attempt-fenced' });
  assert.equal(cancelReadCalls, 0);
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
  assert.deepEqual(
    names(db.calls).filter((name) => name !== 'clock_timestamp'),
    ['claim_device_update_batch'],
  );
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
            fields: [
              {
                field: 'annotatedLocation',
                baselineValue: null,
                requestedValue: 'Room 1',
              },
            ],
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
      action: 'annotated-location',
      operations: [
        {
          operationNumber: 1,
          deviceId: 'd1',
          serialNumber: 's1',
          baselineValue: null,
          requestedValue: 'Room 1',
          fields: [
            {
              field: 'annotatedLocation',
              baselineValue: null,
              requestedValue: 'Room 1',
            },
          ],
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
      expired: 0,
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

test('a command issue classifies its accepted, refused, and lost answers', () => {
  const tracked = (extra = {}) => ({
    operation: op(1, 'd1'),
    sent: true,
    succeeded: false,
    observed: null,
    commandId: null,
    status: null,
    attempts: { quota: 0, transient: 0 },
    final: null,
    settled: false,
    ...extra,
  });
  const failed = (
    kind,
    status,
    reason,
    attempts = { quota: 0, transient: 0 },
  ) => ({ kind, status, reason, attempts, body: null });
  const run = (entry) => classifyWrite(entry, null, true).outcome;
  assert.deepEqual(
    run(tracked({ succeeded: true, status: 200, commandId: '4100000001' })),
    {
      operationNumber: 1,
      outcome: 'issued',
      commandId: '4100000001',
      googleStatus: 200,
      googleReason: null,
      quotaRetries: 0,
      transientRetries: 0,
    },
  );
  // A success without a command ID cannot be stored as issued (section 3).
  const unreadable = run(tracked({ succeeded: true, status: 200 }));
  assert.equal(unreadable.outcome, 'unknown');
  assert.equal(unreadable.outcomeReason, 'invalid-response');
  // A 503 part tells nothing about whether Google stored the command.
  const transient = run(
    tracked({ final: failed('transient', 503, 'backendError') }),
  );
  assert.equal(transient.outcome, 'unknown');
  assert.equal(transient.outcomeReason, 'ambiguous');
  // A final quota answer fails the operation. It never repeats the POST.
  const quota = run(
    tracked({ final: failed('quota', 429, 'rateLimitExceeded') }),
  );
  assert.equal(quota.outcome, 'failed');
  assert.equal(quota.outcomeReason, 'quota');
  // A sent POST with no answer stays ambiguous and stores no HTTP status (fix D1).
  const lost = run(tracked());
  assert.equal(lost.outcome, 'unknown');
  assert.equal(lost.outcomeReason, 'ambiguous');
  assert.equal(lost.googleStatus, null);
});

test('a command batch issues one POST part per operation and settles issued', async () => {
  const db = database({
    claim: () => claimed([statusOp(1, 'd1'), statusOp(2, 'd2')], [], 'reboot'),
  });
  const source = reader([
    {
      parts: {
        d1: { kind: 'success', commandId: '4100000001' },
        d2: { kind: 'success', commandId: '4100000002' },
      },
    },
  ]);
  const { create } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  assert.equal(answer.failure, null);
  assert.equal(source.calls[0].name, 'issueDeviceCommands');
  assert.deepEqual(source.calls[0].commands, [
    { deviceId: 'd1', commandType: 'REBOOT' },
    { deviceId: 'd2', commandType: 'REBOOT' },
  ]);
  // One settlement carries both answers under the issue kind.
  const [settlement] = settlements(db);
  assert.equal(settlement.values[4], 'issue');
  assert.deepEqual(
    JSON.parse(settlement.values[5]).map((result) => [
      result.operationNumber,
      result.outcome,
      result.commandId ?? null,
      result.outcomeReason ?? null,
    ]),
    [
      [1, 'issued', '4100000001', null],
      [2, 'issued', '4100000002', null],
    ],
  );
  // The write path never reads a command back.
  assert.equal(
    names(db.calls).includes('claim_device_update_verification'),
    false,
  );
  assert.equal(
    source.calls.some((call) => call.name === 'deviceStates'),
    false,
  );
});

test('a Wipe user data and a Powerwash issue their Google command type with no payload', async () => {
  for (const [action, commandType] of [
    ['wipe-users', 'WIPE_USERS'],
    ['powerwash', 'REMOTE_POWERWASH'],
  ]) {
    const db = database({
      claim: () => claimed([statusOp(1, 'd1')], [], action),
    });
    const source = reader([
      { parts: { d1: { kind: 'success', commandId: '4100000001' } } },
    ]);
    const { create } = jobs({ db, reader: source });
    const answer = await create.runBatch(
      batchRequest,
      AbortSignal.timeout(5000),
    );
    assert.equal(answer.outcome, 'settled', action);
    assert.equal(source.calls[0].name, 'issueDeviceCommands', action);
    assert.deepEqual(
      source.calls[0].commands,
      [{ deviceId: 'd1', commandType }],
      action,
    );
    // D6: neither command carries a payload, and the mock refuses one (B2).
    assert.equal('payload' in source.calls[0].commands[0], false, action);
    const [settlement] = settlements(db);
    assert.equal(settlement.values[4], 'issue', action);
    assert.deepEqual(
      JSON.parse(settlement.values[5]).map((result) => [
        result.outcome,
        result.commandId,
      ]),
      [['issued', '4100000001']],
      action,
    );
    // A command job skips the read-back of section 4 step 4.
    assert.equal(
      names(db.calls).includes('claim_device_update_verification'),
      false,
      action,
    );
  }
});

test('a CANCELLED answer settles a Reboot and a Powerwash command failed with command-cancelled', async () => {
  // The poll claim names no job action: every command job settles through this classifier (D14).
  for (const action of ['reboot', 'powerwash']) {
    const db = database({
      pollClaim: claimsOf(pollClaimed([pollOperation(1, 'd1', '4100000001')]), {
        outcome: 'idle',
        status: 'awaiting-devices',
        operations: [],
      }),
    });
    const source = reader(
      [],
      [],
      [],
      [
        [
          {
            parts: {
              d1: {
                kind: 'success',
                observation: pollObservation('CANCELLED'),
              },
            },
          },
        ],
      ],
    );
    const { create } = jobs({ db, reader: source });
    const answer = await create.runPoll(pollRequest, AbortSignal.timeout(5000));
    assert.equal(answer.failed, 1, action);
    assert.deepEqual(
      pollSettled(db).map((one) => [one.outcome, one.outcomeReason]),
      [['failed', 'command-cancelled']],
      action,
    );
  }
});

test('an IGNORED result settles a Reboot, a Wipe user data, and a Powerwash command failed with command-failed', async () => {
  // The poll claim names no job action: every command job settles through this classifier (D14).
  const observation = pollObservation('EXECUTED_BY_CLIENT', {
    result: 'IGNORED',
    executedAt: '2026-10-21T12:00:00.000Z',
  });
  for (const action of ['reboot', 'wipe-users', 'powerwash']) {
    const db = database({
      pollClaim: claimsOf(pollClaimed([pollOperation(1, 'd1', '4100000001')]), {
        outcome: 'idle',
        status: 'awaiting-devices',
        operations: [],
      }),
    });
    const source = reader(
      [],
      [],
      [],
      [[{ parts: { d1: { kind: 'success', observation } } }]],
    );
    const { create } = jobs({ db, reader: source });
    const answer = await create.runPoll(pollRequest, AbortSignal.timeout(5000));
    assert.equal(answer.failed, 1, action);
    assert.deepEqual(
      pollSettled(db).map((one) => [one.outcome, one.outcomeReason]),
      [['failed', 'command-failed']],
      action,
    );
  }
});

test('a command finish skips the read-back and answers awaiting-devices', async () => {
  const db = database({
    claim: () => claimed([statusOp(1, 'd1')], [], 'reboot'),
    prepare: () => ({ outcome: 'ready', failure: null, action: 'reboot' }),
    finish: () => ({
      jobId,
      status: 'awaiting-devices',
      succeeded: 0,
      failed: 0,
      unknown: 0,
      skipped: 0,
      expired: 0,
      finishedAt: null,
      publication: null,
    }),
  });
  const { create } = jobs({ db });
  const answer = await create.runFinish(
    { customerId, jobId, dispatchToken, correlationId },
    AbortSignal.timeout(5000),
  );
  assert.equal(answer.outcome, 'finished');
  assert.equal(answer.status, 'awaiting-devices');
  assert.deepEqual(answer.readBack, {
    claimed: 0,
    notHeld: 0,
    settled: 0,
    verified: 0,
    failed: 0,
    unknown: 0,
  });
  assert.deepEqual(
    names(db.calls).filter((name) => name !== 'clock_timestamp'),
    ['prepare_device_update_finish', 'finish_device_update_job'],
  );
});

test('a transient command refusal settles unknown ambiguous without a retry', async () => {
  const db = database({
    claim: () => claimed([statusOp(1, 'd1')], [], 'reboot'),
  });
  const source = reader([
    {
      parts: { d1: { kind: 'transient', status: 503, reason: 'backendError' } },
    },
  ]);
  const { create } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  assert.equal(source.calls[0].rounds, 1, 'A refused POST is not repeated.');
  const [settlement] = settlements(db);
  assert.equal(settlement.values[4], 'issue');
  assert.deepEqual(
    JSON.parse(settlement.values[5]).map((result) => [
      result.outcome,
      result.outcomeReason,
      result.googleStatus,
    ]),
    [['unknown', 'ambiguous', 503]],
  );
});

test('a command POST with no answer settles unknown ambiguous', async () => {
  const db = database({
    claim: () => claimed([statusOp(1, 'd1')], [], 'reboot'),
  });
  const source = reader([{ abortBeforeAnswer: true }]);
  const { create } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  assert.equal(source.calls[0].aborted, true);
  const [settlement] = settlements(db);
  assert.equal(settlement.values[4], 'issue');
  assert.deepEqual(
    JSON.parse(settlement.values[5]).map((result) => [
      result.outcome,
      result.outcomeReason,
      result.googleStatus,
    ]),
    [['unknown', 'ambiguous', null]],
  );
});

test('a lost issuance answer stores no HTTP status', async () => {
  const db = database({
    claim: () => claimed([statusOp(1, 'd1')], [], 'reboot'),
  });
  // The POST leaves the worker and Google never answers it before the call ends.
  const source = reader([{ hang: true }]);
  const { create } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(250));
  assert.equal(answer.outcome, 'settled');
  assert.equal(source.calls[0].aborted, true);
  const [settlement] = settlements(db);
  assert.equal(settlement.values[4], 'issue');
  assert.deepEqual(
    JSON.parse(settlement.values[5]).map((result) => [
      result.outcome,
      result.outcomeReason,
      result.googleStatus,
    ]),
    [['unknown', 'ambiguous', null]],
  );
});

test('a transport-level part failure stores no HTTP status', async () => {
  const db = database({
    claim: () => claimed([statusOp(1, 'd1')], [], 'reboot'),
  });
  // The batch service reports a transport failure with status 0 (no HTTP answer).
  const source = reader([
    {
      parts: { d1: { kind: 'transient', status: 0, reason: 'network' } },
    },
  ]);
  const { create } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  const [settlement] = settlements(db);
  assert.equal(settlement.values[4], 'issue');
  assert.deepEqual(
    JSON.parse(settlement.values[5]).map((result) => [
      result.outcome,
      result.outcomeReason,
      result.googleStatus,
    ]),
    [['unknown', 'ambiguous', null]],
  );
});

test('an invalid-response failure stores no HTTP status', async () => {
  const db = database({ claim: () => claimed([op(1, 'd1')], [], 'reboot') });
  // A part that never arrived fails as invalid-response with no HTTP status.
  const source = reader([
    {
      parts: {
        d1: { kind: 'invalid-response', status: 0, reason: 'missing-part' },
      },
    },
  ]);
  const { create } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  const [settlement] = settlements(db);
  assert.equal(settlement.values[4], 'issue');
  assert.deepEqual(
    JSON.parse(settlement.values[5]).map((result) => [
      result.outcome,
      result.outcomeReason,
      result.googleStatus,
    ]),
    [['unknown', 'invalid-response', null]],
  );
});

test('a multi-field update with no answer stores no HTTP status', async () => {
  const fields = [
    {
      field: 'annotatedUser',
      baselineValue: null,
      requestedValue: 'Ada Lovelace',
    },
    { field: 'notes', baselineValue: null, requestedValue: 'Front desk' },
  ];
  const db = database({ claim: () => claimed([op(1, 'd1', null, fields)]) });
  // The PATCH leaves the worker and Google never answers it.
  const source = reader([{ abortBeforeAnswer: true }]);
  const { create } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  const [settlement] = settlements(db);
  assert.equal(settlement.values[4], 'write');
  assert.deepEqual(
    JSON.parse(settlement.values[5]).map((result) => [
      result.outcome,
      result.outcomeReason,
      result.googleStatus,
    ]),
    [['unknown', 'ambiguous', null]],
  );
});

test('a multi-field update keeps a real HTTP status and drops a transport zero', async () => {
  for (const [status, stored] of [
    [0, null],
    [503, 503],
  ]) {
    const fields = [
      { field: 'annotatedUser', baselineValue: null, requestedValue: 'Ada' },
      { field: 'notes', baselineValue: null, requestedValue: 'Front desk' },
    ];
    const db = database({ claim: () => claimed([op(1, 'd1', null, fields)]) });
    const source = reader([
      {
        parts: {
          d1: { kind: 'transient', status, reason: 'backendError' },
        },
      },
    ]);
    const { create } = jobs({ db, reader: source });
    const answer = await create.runBatch(
      batchRequest,
      AbortSignal.timeout(5000),
    );
    assert.equal(answer.outcome, 'settled');
    const [settlement] = settlements(db);
    assert.deepEqual(
      JSON.parse(settlement.values[5]).map((result) => [
        result.outcome,
        result.outcomeReason,
        result.googleStatus,
      ]),
      [['unknown', 'ambiguous', stored]],
      `Status ${status} stores ${stored}.`,
    );
  }
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
      action: 'annotated-location',
      operations: [
        {
          operationNumber: 3,
          deviceId: 'd3',
          serialNumber: 's3',
          baselineValue: null,
          requestedValue: 'Room 3',
          fields: [
            {
              field: 'annotatedLocation',
              baselineValue: null,
              requestedValue: 'Room 3',
            },
          ],
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
          fields: [
            {
              field: 'annotatedLocation',
              baselineValue: null,
              requestedValue: `Room ${claims}`,
            },
          ],
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
        action: 'annotated-location',
        operations: [
          {
            operationNumber: number,
            deviceId: `d${number}`,
            serialNumber: null,
            baselineValue: null,
            requestedValue: `Room ${number}`,
            fields: [
              {
                field: 'annotatedLocation',
                baselineValue: null,
                requestedValue: `Room ${number}`,
              },
            ],
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

test('an empty or partial write recording fences the attempt and releases nothing', async () => {
  for (const complete of [false, true]) {
    const db = database({
      claim: () => claimed([op(1, 'd1'), op(2, 'd2')]),
      settle: () => ({
        outcome: 'settled',
        settled: complete
          ? [
              {
                operationNumber: 1,
                deviceId: 'd1',
                status: 'succeeded',
                batch: 0,
              },
            ]
          : [],
        published: complete ? ['d1'] : [],
        removed: [],
        publication: null,
      }),
    });
    const source = reader([
      { parts: { d1: { kind: 'success' }, d2: { kind: 'success' } } },
    ]);
    const { create } = jobs({ db, reader: source });
    const answer = await create.runBatch(
      batchRequest,
      AbortSignal.timeout(5000),
    );
    assert.deepEqual(
      answer,
      { outcome: 'attempt-fenced' },
      complete
        ? 'A partial recording fences too.'
        : 'An empty recording fences.',
    );
    assert.equal(
      names(db.calls).includes('release_device_update_batch'),
      false,
      'A fenced attempt never releases its lease.',
    );
    assert.equal(
      source.calls.filter((call) => call.name === 'deviceStates').length,
      0,
      'No read-back runs after the fence.',
    );
  }
});

test('a success records the observed values, its status, and the retry history', async () => {
  const db = database({ claim: () => claimed([op(1, 'd1')]) });
  const source = reader([
    {
      parts: {
        d1: {
          kind: 'retry',
          status: 503,
          reason: 'backendError',
          transient: 1,
        },
      },
    },
    {
      reuse: true,
      parts: {
        d1: { kind: 'success', value: 'Room 1', transient: 1 },
      },
    },
  ]);
  const { create } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  const result = JSON.parse(settlements(db)[0].values[5])[0];
  assert.deepEqual(result, {
    operationNumber: 1,
    outcome: 'succeeded',
    verifiedBy: 'write-response',
    googleStatus: 200,
    googleReason: null,
    quotaRetries: 0,
    transientRetries: 1,
    values: { annotatedLocation: 'Room 1' },
  });
});

test('a 2xx answer that names another value settles value-differs', async () => {
  const db = database({ claim: () => claimed([op(1, 'd1')]) });
  const source = reader([
    {
      parts: {
        d1: { kind: 'success', value: 'Normalized Room 1' },
      },
    },
  ]);
  const { create } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  assert.deepEqual(JSON.parse(settlements(db)[0].values[5]), [
    {
      operationNumber: 1,
      outcome: 'failed',
      outcomeReason: 'value-differs',
      verifiedBy: 'write-response',
      googleStatus: 200,
      googleReason: null,
      quotaRetries: 0,
      transientRetries: 0,
      values: { annotatedLocation: 'Normalized Room 1' },
    },
  ]);
});

test('a cache that cannot be configured keeps its publication row', async () => {
  const element = {
    publicationId: 11,
    jobId,
    displayId,
    requestedBy,
    revision: 2,
    statusChanged: false,
    deviceIds: ['d1'],
    removedIds: [],
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
      removed: [],
      publication: element,
    }),
  });
  const { create } = jobs({
    db,
    reader: reader([{ parts: { d1: { kind: 'success' } } }]),
    cache: deferredEntityCache(() => {
      throw new Error('connection-store-unavailable');
    }),
  });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  assert.equal(
    names(db.calls).includes('complete_job_publications'),
    false,
    'A no-op cache never acknowledges publication.',
  );
});

test('a verification read with a credential error settles unknown and the finish continues', async () => {
  for (const detail of [
    'credential-changed',
    'connection-disconnected',
    'restore-revalidation-required',
  ]) {
    const db = database({
      fail: { read_device_update_verification: detail },
      verificationClaim: (() => {
        let claimedChunks = 0;
        return () => {
          claimedChunks += 1;
          if (claimedChunks > 1) return [];
          return [
            {
              operationNumber: 1,
              deviceId: 'd1',
              serialNumber: null,
              baselineValue: null,
              requestedValue: 'Room 1',
              fields: [
                {
                  field: 'annotatedLocation',
                  baselineValue: null,
                  requestedValue: 'Room 1',
                },
              ],
            },
          ];
        };
      })(),
    });
    const { create } = jobs({ db });
    const answer = await create.runFinish(
      { customerId, jobId, dispatchToken, correlationId },
      AbortSignal.timeout(5000),
    );
    assert.equal(answer.outcome, 'finished', detail);
    assert.equal(answer.readBack.unknown, 1);
    const readBack = settlements(db)[0];
    assert.equal(readBack.values[4], 'read-back');
    assert.deepEqual(JSON.parse(readBack.values[5]), [
      {
        operationNumber: 1,
        outcome: 'unknown',
        outcomeReason: 'verification-failed',
      },
    ]);
    assert.equal(
      names(db.calls).includes('finish_device_update_job'),
      true,
      'The finish reaches its final step.',
    );
  }
});

test('an envelope that cannot open is a read-back failure, not a request failure', async () => {
  const db = database({
    verificationClaim: (() => {
      let claimedChunks = 0;
      return () => {
        claimedChunks += 1;
        if (claimedChunks > 1) return [];
        return [
          {
            operationNumber: 1,
            deviceId: 'd1',
            serialNumber: null,
            baselineValue: null,
            requestedValue: 'Room 1',
            fields: [
              {
                field: 'annotatedLocation',
                baselineValue: null,
                requestedValue: 'Room 1',
              },
            ],
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
      action: 'annotated-location',
      operations: [
        {
          operationNumber: 1,
          deviceId: 'd1',
          serialNumber: null,
          baselineValue: null,
          requestedValue: 'Room 1',
          fields: [
            {
              field: 'annotatedLocation',
              baselineValue: null,
              requestedValue: 'Room 1',
            },
          ],
          verifyAfter: new Date(base).toISOString(),
          verifyLeaseExpiresAt: new Date(base + 120_000).toISOString(),
        },
      ],
    }),
  });
  const { create } = jobs({
    db,
    cipher: {
      open: () => {
        throw new Error('envelope-unavailable');
      },
    },
  });
  const answer = await create.runFinish(
    { customerId, jobId, dispatchToken, correlationId },
    AbortSignal.timeout(5000),
  );
  assert.equal(answer.outcome, 'finished');
  const readBack = settlements(db)[0];
  assert.equal(readBack.values[4], 'read-back');
  assert.equal(
    JSON.parse(readBack.values[5])[0].outcomeReason,
    'verification-failed',
  );
});

test('a verification-read store failure stays a request failure', async () => {
  const db = database({
    fail: { read_device_update_verification: 'store down' },
    verificationClaim: () => [
      {
        operationNumber: 1,
        deviceId: 'd1',
        serialNumber: null,
        baselineValue: null,
        requestedValue: 'Room 1',
        fields: [
          {
            field: 'annotatedLocation',
            baselineValue: null,
            requestedValue: 'Room 1',
          },
        ],
      },
    ],
  });
  const { create } = jobs({ db });
  await assert.rejects(
    create.runFinish(
      { customerId, jobId, dispatchToken, correlationId },
      AbortSignal.timeout(5000),
    ),
    (error) =>
      error instanceof DeviceSyncError && error.code === 'store-unavailable',
  );
});

test('a takeover read-back runs under the claim bounds', async () => {
  let clockAt = new Date(base);
  const db = database({
    claim: () => {
      // The claim reads its fence time between these two clock reads.
      clockAt = new Date(base + 1_000);
      return claimed([], [op(1, 'd1')]);
    },
    clock: () => clockAt,
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
    ],
  );
  const { create, sleeps } = jobs({
    db,
    reader: source,
    // A worker clock 60 s ahead must not shorten or extend the window.
    now: () => base + 60_000,
  });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  assert.deepEqual(sleeps, [], 'The claim time is already past the fence.');
  assert.deepEqual(source.calls[0].ids, ['d1']);
  assert.equal(
    JSON.parse(settlements(db)[0].values[5])[0].verifiedBy,
    'read-back',
  );
});

test('a takeover read-back past its lease settles unknown without a GET', async () => {
  let clockCalls = 0;
  const db = database({
    claim: () => claimed([], [op(1, 'd1')]),
    // The claim reads twice. The read-back then finds the 120 s lease near its end.
    clock: () => new Date(base + (clockCalls++ < 2 ? 0 : 110_000)),
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
    ],
  );
  const { create } = jobs({ db, reader: source });
  const answer = await create.runBatch(batchRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  assert.equal(
    source.calls.filter((call) => call.name === 'deviceStates').length,
    0,
    'No GET leaves inside the 15 s margin.',
  );
  const readBack = settlements(db).at(-1);
  assert.equal(readBack.values[4], 'read-back');
  assert.equal(
    JSON.parse(readBack.values[5])[0].outcomeReason,
    'verification-failed',
  );
});

test('verifyAfter is measured on the database clock, not a worker clock ahead', async () => {
  let dbNow = base;
  const db = database({
    clock: () => new Date(dbNow),
    verificationClaim: (() => {
      let claimedChunks = 0;
      return () => {
        claimedChunks += 1;
        if (claimedChunks > 1) return [];
        return [
          {
            operationNumber: 3,
            deviceId: 'd3',
            serialNumber: null,
            baselineValue: null,
            requestedValue: 'Room 3',
            fields: [
              {
                field: 'annotatedLocation',
                baselineValue: null,
                requestedValue: 'Room 3',
              },
            ],
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
      action: 'annotated-location',
      operations: [
        {
          operationNumber: 3,
          deviceId: 'd3',
          serialNumber: null,
          baselineValue: null,
          requestedValue: 'Room 3',
          fields: [
            {
              field: 'annotatedLocation',
              baselineValue: null,
              requestedValue: 'Room 3',
            },
          ],
          verifyAfter: new Date(base + 30_000).toISOString(),
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
  const sleeps = [];
  const { create } = jobs({
    db,
    reader: source,
    // The worker clock is 60 s ahead of the database clock.
    now: () => base + 60_000,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      dbNow += milliseconds;
    },
  });
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
  assert.equal(answer.outcome, 'settled');
  assert.equal(
    sleeps[0],
    30_000,
    'The wait is 30 s on the database clock although the worker clock is ahead.',
  );
  assert.equal(answer.readBack.verified, 1);
});

test('a read-back inside the 15 s lease margin settles unknown without a GET', async () => {
  const db = database({
    clock: () => new Date(base),
    verificationClaim: (() => {
      let claimedChunks = 0;
      return () => {
        claimedChunks += 1;
        if (claimedChunks > 1) return [];
        return [
          {
            operationNumber: 3,
            deviceId: 'd3',
            serialNumber: null,
            baselineValue: null,
            requestedValue: 'Room 3',
            fields: [
              {
                field: 'annotatedLocation',
                baselineValue: null,
                requestedValue: 'Room 3',
              },
            ],
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
      action: 'annotated-location',
      operations: [
        {
          operationNumber: 3,
          deviceId: 'd3',
          serialNumber: null,
          baselineValue: null,
          requestedValue: 'Room 3',
          fields: [
            {
              field: 'annotatedLocation',
              baselineValue: null,
              requestedValue: 'Room 3',
            },
          ],
          verifyAfter: new Date(base).toISOString(),
          // The lease ends inside the 15 s margin.
          verifyLeaseExpiresAt: new Date(base + 10_000).toISOString(),
        },
      ],
    }),
  });
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
  assert.equal(answer.outcome, 'settled');
  assert.equal(source.calls.length, 0, 'No GET leaves inside the margin.');
  assert.equal(
    JSON.parse(settlements(db)[0].values[5])[0].outcomeReason,
    'verification-failed',
  );
});

test('a delayed database clock read aborts the read-back GET at the lease-minus-15-second boundary', async () => {
  const clock = advancingTimers(base);
  let clockReads = 0;
  const db = database({
    clock: () => {
      const value = new Date(clock.now);
      clockReads += 1;
      // The read-back clock read captures t=0 and answers 2 s later.
      if (clockReads === 1) clock.advance(2_000);
      return value;
    },
    verificationRead: () => ({
      outcome: 'held',
      checkedAt: new Date(base).toISOString(),
      generation: 1,
      credentialId: randomUUID(),
      envelope: { sealed: true },
      action: 'annotated-location',
      operations: [
        {
          operationNumber: 3,
          deviceId: 'd3',
          serialNumber: null,
          baselineValue: null,
          requestedValue: 'Room 3',
          fields: [
            {
              field: 'annotatedLocation',
              baselineValue: null,
              requestedValue: 'Room 3',
            },
          ],
          verifyAfter: new Date(base).toISOString(),
          verifyLeaseExpiresAt: new Date(base + 120_000).toISOString(),
        },
      ],
    }),
  });
  const source = reader([], [{ hang: true }]);
  const { create } = jobs({
    db,
    reader: source,
    timers: clock.timers,
    now: () => clock.now,
  });
  const running = create.runReconcile(
    {
      customerId,
      jobId,
      operationNumber: 3,
      verifyAttempt: randomUUID(),
      correlationId,
    },
    new AbortController().signal,
  );
  await flush();
  await flush();
  assert.equal(source.calls.length, 1, 'One GET is in flight.');
  // The read-back clock read answered at t=2 s. The lease ends at t=120 s, so the
  // GET must abort at t=105 s even though the response value names t=0.
  clock.advance(102_000);
  await flush();
  assert.equal(
    source.calls[0].aborted,
    false,
    'The GET stays open until the lease margin.',
  );
  clock.advance(1_000);
  await flush();
  assert.equal(
    source.calls[0].aborted,
    true,
    'The GET aborts at the lease-minus-15-second boundary.',
  );
  const answer = await running;
  assert.equal(answer.outcome, 'settled');
  assert.equal(answer.readBack.unknown, 1);
  assert.equal(
    JSON.parse(settlements(db)[0].values[5])[0].outcomeReason,
    'verification-failed',
  );
});

test('the worker renews the lease every 30 s while a part waits', async () => {
  const clock = advancingTimers(base);
  const db = database({ claim: () => claimed([op(1, 'd1')]) });
  const source = reader([{ hang: true }]);
  const stopping = new AbortController();
  const { create } = jobs({
    db,
    reader: source,
    timers: clock.timers,
    now: () => clock.now,
  });
  const running = create.runBatch(batchRequest, stopping.signal);
  await flush();
  await flush();
  assert.ok(
    clock.delays().includes(30_000),
    'The renewal interval runs every 30 s.',
  );
  const renewals = () =>
    db.calls.filter((call) => call.name === 'renew_device_update_batch').length;
  assert.equal(renewals(), 0, 'No round ended yet.');
  clock.advance(30_000);
  await flush();
  assert.equal(renewals(), 1);
  clock.advance(30_000);
  await flush();
  assert.equal(renewals(), 2);
  clock.advance(30_000);
  await flush();
  assert.equal(renewals(), 3);
  stopping.abort();
  const answer = await running;
  assert.equal(answer.outcome, 'settled');
  assert.equal(source.calls[0].aborted, true);
});

test('a pending renewal keeps the previous watchdog deadline and the call aborts at 150 s', async () => {
  const clock = advancingTimers(base);
  let releaseRenew;
  const pending = new Promise((resolve) => {
    releaseRenew = resolve;
  });
  const db = database({
    claim: () => claimed([op(1, 'd1')]),
    renew: async () => {
      await pending;
      return new Date(clock.now);
    },
  });
  const source = reader([{ hang: true }]);
  const stopping = new AbortController();
  const { create } = jobs({
    db,
    reader: source,
    timers: clock.timers,
    now: () => clock.now,
  });
  const running = create.runBatch(batchRequest, stopping.signal);
  await flush();
  await flush();
  clock.advance(30_000);
  await flush();
  assert.equal(
    db.calls.filter((call) => call.name === 'renew_device_update_batch').length,
    1,
    'The renewal request is in flight.',
  );
  // The claim started the deadline at the base time. The unanswered renewal at
  // 30 s must not move it (R2-F1).
  clock.advance(119_000);
  await flush();
  assert.equal(
    source.calls[0].aborted,
    false,
    'The claim deadline still holds while the renewal is unanswered.',
  );
  clock.advance(1_000);
  await flush();
  assert.equal(
    source.calls[0].aborted,
    true,
    'The watchdog aborts 150 s after the successful claim.',
  );
  releaseRenew();
  const answer = await running;
  assert.equal(answer.outcome, 'settled');
});

test('a renewal that fails during the final drain answers non-2xx and releases nothing', async () => {
  const clock = advancingTimers(base);
  let renewals = 0;
  let rejectPeriodic;
  const held = new Promise((_, reject) => {
    rejectPeriodic = reject;
  });
  const db = database({
    claim: () => claimed([op(1, 'd1')]),
    renew: async () => {
      renewals += 1;
      // The periodic renewal stays in flight. The after-round renewal succeeds.
      if (renewals === 1) await held;
      return new Date(clock.now);
    },
  });
  let openRound;
  const gate = new Promise((resolve) => {
    openRound = resolve;
  });
  const source = reader([{ gate, parts: { d1: { kind: 'success' } } }]);
  const { create } = jobs({
    db,
    reader: source,
    timers: clock.timers,
    now: () => clock.now,
  });
  const signal = new AbortController().signal;
  const request = Readable.from([
    Buffer.from(
      JSON.stringify({
        executionId: 'exec-1',
        customerId,
        jobId,
        dispatchToken,
        batch: 0,
        correlationId,
      }),
    ),
  ]);
  request.method = 'POST';
  request.url = '/dispatch/device-update-batch';
  request.headers = {
    authorization: `Bearer ${'s'.repeat(32)}`,
    'content-type': 'application/json',
  };
  const response = {
    statusCode: 0,
    payload: null,
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(text) {
      this.payload = JSON.parse(text);
    },
  };
  const handled = handleDeviceUpdateBatchDispatch(
    request,
    response,
    { secret: 's'.repeat(32), signal },
    { updateDevices: (input) => create.runBatch(input, signal) },
  );
  await flush();
  await flush();
  clock.advance(30_000);
  await flush();
  assert.equal(renewals, 1, 'The periodic renewal is in flight.');
  openRound();
  await until(() => settlements(db).length === 1);
  assert.equal(renewals, 2, 'The after-round renewal succeeded.');
  rejectPeriodic(new Error('pool timeout'));
  await handled;
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.payload, { error: 'store-unavailable' });
  assert.equal(
    names(db.calls).includes('release_device_update_batch'),
    false,
    'A renewal failure never releases the lease.',
  );
});

/** The cancel reads of one run: one after every successful renewal. */
const cancelReads = (db) =>
  db.calls.filter((call) => call.name === 'job_cancel_requested');

test('a cancel read at the renewal tick stops the next round and settles unsent operations pending', async () => {
  const clock = advancingTimers(base);
  const db = database({
    claim: () => claimed([op(1, 'd1'), op(2, 'd2')]),
    cancel: () => true,
  });
  let openAnswer;
  const answerGate = new Promise((resolve) => {
    openAnswer = resolve;
  });
  const source = reader([{ answerGate, parts: { d1: { kind: 'success' } } }]);
  const { create } = jobs({
    db,
    reader: source,
    batchSize: 1,
    timers: clock.timers,
    now: () => clock.now,
  });
  const running = create.runBatch(batchRequest, AbortSignal.timeout(5000));
  await until(() => source.calls[0]?.rounds === 1);
  // The first part is in flight. The tick renews and reads the request.
  clock.advance(30_000);
  await until(() => cancelReads(db).length === 1);
  assert.equal(cancelReads(db)[0].values[1], jobId, 'The read names the job.');
  openAnswer();
  const answer = await running;
  // The round in flight settles from its own answer, not from the cancel.
  assert.equal(
    JSON.parse(settlements(db)[0].values[5])[0].outcome,
    'succeeded',
  );
  // The second operation never left the worker.
  assert.equal(source.calls[0].rounds, 1);
  assert.equal(source.calls[0].aborted, false, 'A drain aborts no call.');
  const leftover = JSON.parse(settlements(db)[1].values[5]);
  assert.deepEqual(
    leftover.map((one) => one.outcome),
    ['pending'],
    'An unsent operation returns to pending.',
  );
  assert.equal(answer.outcome, 'settled');
  assert.equal(answer.failure, null);
  assert.equal(names(db.calls).at(-1), 'release_device_update_batch');
  // The worker never writes `cancelled`: the next claim settles those rows.
  assert.equal(
    JSON.stringify(settlements(db).map((call) => call.values[5])).includes(
      'cancelled',
    ),
    false,
  );
});

test('a failed cancel read leaves the flag unset and the next tick reads again', async () => {
  const clock = advancingTimers(base);
  let reads = 0;
  const db = database({
    claim: () => claimed([op(1, 'd1'), op(2, 'd2')]),
    cancel: () => {
      reads += 1;
      if (reads === 1) throw new Error('the cancel read failed');
      return true;
    },
  });
  let openAnswer;
  const answerGate = new Promise((resolve) => {
    openAnswer = resolve;
  });
  let openSecond;
  const secondGate = new Promise((resolve) => {
    openSecond = resolve;
  });
  const source = reader([
    { answerGate, parts: { d1: { kind: 'success' } } },
    { gate: secondGate, parts: { d2: { kind: 'success' } } },
  ]);
  const { create } = jobs({
    db,
    reader: source,
    batchSize: 1,
    timers: clock.timers,
    now: () => clock.now,
  });
  const running = create.runBatch(batchRequest, AbortSignal.timeout(5000));
  await until(() => source.calls[0]?.rounds === 1);
  clock.advance(30_000);
  await until(() => reads === 1);
  // A failed read answers no cancel. Round 1 finishes, and round 2 reaches its send.
  openAnswer();
  await until(() => settlements(db).length === 1);
  assert.equal(source.calls[0].rounds, 1);
  clock.advance(30_000);
  await until(() => reads === 2);
  openSecond();
  const answer = await running;
  assert.equal(reads, 2, 'The next tick reads the request again.');
  assert.equal(source.calls[0].rounds, 1, 'The second round never left.');
  assert.deepEqual(
    JSON.parse(settlements(db)[1].values[5]).map((one) => one.outcome),
    ['pending'],
  );
  assert.equal(answer.outcome, 'settled');
});

test('a cancelled job keeps the read-back of a written field and renews until the release', async () => {
  const clock = advancingTimers(base);
  const db = database({
    claim: () => claimed([op(1, 'd1'), op(2, 'd2')]),
    cancel: () => true,
  });
  let openAnswer;
  const answerGate = new Promise((resolve) => {
    openAnswer = resolve;
  });
  let openRead;
  const readGate = new Promise((resolve) => {
    openRead = resolve;
  });
  const source = reader([
    {
      answerGate,
      parts: {
        d1: { kind: 'retry', status: 0, reason: 'timeout', transient: 1 },
      },
    },
    { parts: { d2: { kind: 'success' } } },
  ]);
  source.deviceStates = async (_credential, _customer, ids) => {
    source.calls.push({ name: 'deviceStates', ids: [...ids] });
    await readGate;
    return [
      {
        deviceId: 'd1',
        status: 'found',
        device: { deviceId: 'd1', annotatedLocation: 'Room 1' },
      },
    ];
  };
  const { create } = jobs({
    db,
    reader: source,
    batchSize: 1,
    timers: clock.timers,
    now: () => clock.now,
  });
  const running = create.runBatch(batchRequest, AbortSignal.timeout(5000));
  await until(() => source.calls[0]?.rounds === 1);
  clock.advance(30_000);
  await until(() => cancelReads(db).length === 1);
  openAnswer();
  // The lost answer stays unknown and goes to the read-back.
  await until(() => source.calls.some((call) => call.name === 'deviceStates'));
  const renewals = () =>
    db.calls.filter((call) => call.name === 'renew_device_update_batch').length;
  const before = renewals();
  clock.advance(30_000);
  await until(() => renewals() === before + 1);
  assert.ok(
    clock.delays().includes(30_000),
    'The renewal interval still runs while the read-back waits.',
  );
  openRead();
  const answer = await running;
  // The cancel request stopped the second operation before it left the worker.
  assert.equal(source.calls[0].rounds, 1);
  assert.equal(cancelReads(db)[0].values[1], jobId);
  // The written field keeps its read-back after the cancel request.
  const readBack = settlements(db).at(-1);
  assert.equal(readBack.values[4], 'read-back');
  const verified = JSON.parse(readBack.values[5])[0];
  assert.equal(verified.outcome, 'succeeded');
  assert.equal(verified.verifiedBy, 'read-back');
  assert.equal(verified.values.annotatedLocation, 'Room 1');
  assert.equal(answer.outcome, 'settled');
  assert.equal(names(db.calls).at(-1), 'release_device_update_batch');
  assert.equal(clock.count, 0, 'No timer outlives the release.');
});

test('a drained command batch leaves its issued rows issued', async () => {
  const clock = advancingTimers(base);
  const db = database({
    claim: () =>
      claimed(
        [statusOp(1, 'd1'), statusOp(2, 'd2'), statusOp(3, 'd3')],
        [],
        'reboot',
      ),
    cancel: () => true,
  });
  let openSecond;
  const secondGate = new Promise((resolve) => {
    openSecond = resolve;
  });
  const source = reader([
    { parts: { d1: { kind: 'success', commandId: '4100000001' } } },
    {
      gate: secondGate,
      parts: { d2: { kind: 'success', commandId: '4100000002' } },
    },
  ]);
  const { create } = jobs({
    db,
    reader: source,
    batchSize: 1,
    timers: clock.timers,
    now: () => clock.now,
  });
  const running = create.runBatch(batchRequest, AbortSignal.timeout(5000));
  await until(() => settlements(db).length === 1);
  clock.advance(30_000);
  await until(() => cancelReads(db).length === 1);
  openSecond();
  const answer = await running;
  assert.equal(source.calls[0].name, 'issueDeviceCommands');
  assert.equal(source.calls[0].rounds, 1, 'The second command never left.');
  const [issued, leftover] = settlements(db);
  assert.equal(issued.values[4], 'issue');
  assert.deepEqual(
    JSON.parse(issued.values[5]).map((one) => [
      one.outcome,
      one.commandId ?? null,
    ]),
    [['issued', '4100000001']],
    'An issued command stays issued.',
  );
  assert.equal(leftover.values[4], 'issue');
  assert.deepEqual(
    JSON.parse(leftover.values[5]).map((one) => one.outcome),
    ['pending', 'pending'],
    'An unissued command returns to pending.',
  );
  assert.equal(answer.outcome, 'settled');
  assert.equal(answer.failure, null);
});

test('a drained status batch sends no further part', async () => {
  const clock = advancingTimers(base);
  const operations = Array.from({ length: 51 }, (_, index) =>
    statusOp(index + 1, `d${index + 1}`),
  );
  const db = database({
    claim: () => claimed(operations, [], 'disable'),
    cancel: () => true,
  });
  let openSecond;
  const secondGate = new Promise((resolve) => {
    openSecond = resolve;
  });
  // One part holds up to 50 devices, so the 51 operations make two parts.
  const source = reader([], [], [{}, { gate: secondGate }]);
  const { create } = jobs({
    db,
    reader: source,
    batchSize: 1,
    timers: clock.timers,
    now: () => clock.now,
  });
  const running = create.runBatch(batchRequest, AbortSignal.timeout(5000));
  await until(() => settlements(db).length === 1);
  clock.advance(30_000);
  await until(() => cancelReads(db).length === 1);
  openSecond();
  const answer = await running;
  assert.equal(source.calls[0].name, 'changeDeviceStatus');
  assert.equal(source.calls[0].rounds, 1, 'The second part never left.');
  assert.deepEqual(
    source.calls[0].parts.map((part) => part.deviceIds.length),
    [50],
  );
  const [first, leftover] = settlements(db);
  assert.equal(JSON.parse(first.values[5]).length, 50);
  assert.deepEqual(
    JSON.parse(leftover.values[5]).map((one) => one.outcome),
    ['pending'],
    'The unread operation returns to pending.',
  );
  assert.equal(answer.outcome, 'settled');
  assert.equal(answer.failure, null);
});

test('a numeric Reconcile request requires a verification attempt', async () => {
  const request = { customerId, jobId, operationNumber: 3, correlationId };
  for (const verifyAttempt of [undefined, null, '', 'not-a-uuid'])
    assert.equal(
      deviceUpdateReconcileRequestSchema.safeParse({
        ...request,
        verifyAttempt,
      }).success,
      false,
      String(verifyAttempt),
    );
  assert.equal(
    deviceUpdateReconcileRequestSchema.safeParse({
      ...request,
      verifyAttempt: randomUUID(),
    }).success,
    true,
  );
  assert.equal(
    deviceUpdateReconcileRequestSchema.safeParse({
      customerId,
      jobId,
      operationNumber: 'all',
      correlationId,
    }).success,
    true,
    '`all` claims its own attempts.',
  );
  const source = reader();
  const { create } = jobs({ db: database(), reader: source });
  await assert.rejects(
    create.runReconcile(request, AbortSignal.timeout(5000)),
    (error) => error instanceof z.ZodError,
  );
  assert.equal(source.calls.length, 0);
});

test('a Reconcile request without its attempt answers invalid-payload', async () => {
  const context = { secret: 's'.repeat(32), signal: AbortSignal.timeout(5000) };
  const received = [];
  const google = {
    reconcileDeviceUpdate: async (input) => {
      received.push(input);
      return { outcome: 'not-held' };
    },
  };
  const send = (body) => {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    request.method = 'POST';
    request.url = '/dispatch/device-update-reconcile';
    request.headers = {
      authorization: `Bearer ${context.secret}`,
      'content-type': 'application/json',
    };
    const response = {
      statusCode: 0,
      payload: null,
      writeHead(statusCode) {
        this.statusCode = statusCode;
      },
      end(text) {
        this.payload = JSON.parse(text);
      },
    };
    return { request, response };
  };
  const body = {
    executionId: 'exec-1',
    customerId,
    jobId,
    operationNumber: '3',
    correlationId,
  };
  for (const verifyAttempt of [undefined, null, 'not-a-uuid']) {
    const { request, response } = send({ ...body, verifyAttempt });
    assert.equal(
      await handleDeviceUpdateReconcileDispatch(
        request,
        response,
        context,
        google,
      ),
      true,
    );
    assert.equal(response.statusCode, 400, String(verifyAttempt));
    assert.deepEqual(response.payload, { error: 'invalid-payload' });
  }
  assert.equal(
    received.length,
    0,
    'An invalid request never reaches the worker.',
  );
  const valid = send({ ...body, verifyAttempt: randomUUID() });
  await handleDeviceUpdateReconcileDispatch(
    valid.request,
    valid.response,
    context,
    google,
  );
  assert.equal(valid.response.statusCode, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].verifyAttempt === undefined, false);
});
const pollRequest = {
  customerId,
  jobId,
  leaseId: '77777777-7777-4777-8777-777777777777',
  correlationId,
};
const pollOperation = (number, deviceId, commandId) => ({
  operationNumber: number,
  deviceId,
  commandId,
});
const pollClaimed = (operations) => ({
  outcome: 'claimed',
  generation: 1,
  credentialId: randomUUID(),
  envelope: { sealed: true },
  operations,
});
const pollObservation = (state, extra = {}) => ({
  commandId: '4100000001',
  state,
  issuedAt: null,
  expiresAt: '2026-10-28T12:00:00.000Z',
  result: null,
  executedAt: null,
  errorMessage: null,
  ...extra,
});
/** A poll reader of one call whose parts the test answers by hand. */
const pollReader = (answer) => ({
  calls: [],
  async deviceCommands(_credential, _customer, polls, signal, options) {
    this.calls.push({
      name: 'deviceCommands',
      polls: polls.map((poll) => ({ ...poll })),
      batchSize: options.batchSize,
      aborted: false,
    });
    await answer(options, signal);
    return { succeeded: new Map(), failed: new Map() };
  },
});
const pollSuccess = (id, observation) => ({
  id,
  status: 200,
  attempts: { quota: 0, transient: 0 },
  outcome: {
    kind: 'success',
    page: observation,
    pageIndex: 0,
    hasNextPage: false,
  },
  request: { id, method: 'GET', path: '' },
});
const pollRetry = (id, status = 429) => ({
  id,
  status,
  attempts: { quota: 1, transient: 0 },
  outcome: {
    kind: 'retry',
    failure: {
      kind: 'quota',
      status,
      reason: 'rateLimitExceeded',
      attempts: { quota: 1, transient: 0 },
      body: null,
    },
    retryInMs: 60_000,
  },
  request: { id, method: 'GET', path: '' },
});
/** Every poll result that the fake store received, in settlement order. */
const pollSettled = (db) =>
  db.calls
    .filter((one) => one.name === 'settle_device_command_polls')
    .flatMap((one) => JSON.parse(one.values[4]));
/** A claim answer that returns the given claims in order, then an idle answer. */
const claimsOf = (...claims) => {
  let index = 0;
  return () => claims[Math.min(index++, claims.length - 1)];
};

test('one poll run claims, reads, settles, and releases the job lease', async () => {
  const db = database({
    pollClaim: claimsOf(
      pollClaimed([
        pollOperation(1, 'd1', '4100000001'),
        pollOperation(2, 'd2', '4100000002'),
      ]),
      { outcome: 'idle', status: 'awaiting-devices', operations: [] },
    ),
  });
  const source = reader(
    [],
    [],
    [],
    [
      [
        {
          parts: {
            d1: { kind: 'success', observation: pollObservation('PENDING') },
            d2: {
              kind: 'success',
              observation: pollObservation('EXECUTED_BY_CLIENT', {
                result: 'SUCCESS',
                executedAt: '2026-10-21T12:00:00.000Z',
              }),
            },
          },
        },
      ],
    ],
  );
  const { create } = jobs({ db, reader: source });
  const answer = await create.runPoll(pollRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  assert.equal(answer.claimed, 2);
  assert.equal(answer.settled, 2);
  assert.equal(answer.pending, 1);
  assert.equal(answer.succeeded, 1);
  const call = source.calls.find((one) => one.name === 'deviceCommands');
  assert.deepEqual(call.polls, [
    { deviceId: 'd1', commandId: '4100000001' },
    { deviceId: 'd2', commandId: '4100000002' },
  ]);
  assert.equal(call.batchSize, 250);
  const settle = db.calls.filter(
    (one) => one.name === 'settle_device_command_polls',
  );
  assert.deepEqual(
    settle
      .flatMap((one) => JSON.parse(one.values[4]))
      .sort((a, b) => a.operationNumber - b.operationNumber)
      .map((one) => [
        one.operationNumber,
        one.outcome,
        one.commandState ?? null,
        one.commandExpiresAt ?? null,
      ]),
    [
      [1, 'pending', 'pending-delivery', '2026-10-28T12:00:00.000Z'],
      [2, 'succeeded', null, '2026-10-28T12:00:00.000Z'],
    ],
    'Each answer settles on its own (R3).',
  );
  assert.equal(
    names(db.calls).includes('release_device_command_poll'),
    true,
    'A finished run releases the job lease.',
  );
});

test('a poll run repeats while due operations remain', async () => {
  const db = database({
    pollClaim: claimsOf(
      pollClaimed([pollOperation(1, 'd1', '4100000001')]),
      pollClaimed([pollOperation(2, 'd2', '4100000002')]),
      { outcome: 'idle', status: 'awaiting-devices', operations: [] },
    ),
  });
  const source = reader(
    [],
    [],
    [],
    [
      [
        {
          parts: {
            d1: { kind: 'success', observation: pollObservation('PENDING') },
          },
        },
      ],
      [
        {
          parts: {
            d2: { kind: 'success', observation: pollObservation('EXPIRED') },
          },
        },
      ],
    ],
  );
  const { create } = jobs({ db, reader: source });
  const answer = await create.runPoll(pollRequest, AbortSignal.timeout(5000));
  assert.equal(answer.claimed, 2);
  assert.equal(answer.settled, 2);
  assert.equal(answer.pending, 1);
  assert.equal(answer.expired, 1);
  const calls = source.calls.filter((one) => one.name === 'deviceCommands');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].polls, [
    { deviceId: 'd2', commandId: '4100000002' },
  ]);
  assert.equal(
    db.calls.filter((one) => one.name === 'settle_device_command_polls').length,
    2,
  );
});

test('a completing poll settlement publishes job-changed and stops', async () => {
  const publication = {
    publicationId: 5,
    jobId,
    displayId: 'CMD-001',
    requestedBy,
    revision: 3,
    statusChanged: true,
    deviceIds: [],
    removedIds: [],
    batch: null,
    batchCount: null,
  };
  const db = database({
    pollClaim: () => ({
      outcome: 'completed',
      status: 'completed',
      publication,
    }),
  });
  const source = reader();
  const cacheSource = cache();
  const { create } = jobs({ db, reader: source, cache: cacheSource });
  const answer = await create.runPoll(pollRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'completed');
  assert.equal(source.calls.length, 0, 'A completed job sends no GET.');
  const publish = cacheSource.calls.find((one) => one.name === 'publish');
  assert.ok(publish, 'The completion publishes at once.');
  assert.equal(JSON.parse(publish.args[1]).type, 'job-changed');
  assert.equal(names(db.calls).includes('release_device_command_poll'), true);
});

test('a final answer that is not a poll result settles nothing and keeps the lease for the next poll', async () => {
  const db = database({
    pollClaim: claimsOf(pollClaimed([pollOperation(1, 'd1', '4100000001')]), {
      outcome: 'idle',
      status: 'awaiting-devices',
      operations: [],
    }),
  });
  const source = reader(
    [],
    [],
    [],
    [
      [
        {
          parts: {
            d1: {
              kind: 'failed',
              status: 503,
              reason: 'backendError',
            },
          },
        },
      ],
    ],
  );
  const { create } = jobs({ db, reader: source });
  const answer = await create.runPoll(pollRequest, AbortSignal.timeout(5000));
  assert.equal(answer.settled, 0);
  assert.equal(
    names(db.calls).includes('settle_device_command_polls'),
    false,
    'A transient refusal changes no operation.',
  );
  assert.equal(names(db.calls).includes('release_device_command_poll'), true);
});

test('a claim without a usable connection stops the run and releases the job lease', async () => {
  const db = database({
    pollClaim: () => ({
      outcome: 'unavailable',
      status: 'awaiting-devices',
      detail: 'The credential generation changed.',
    }),
  });
  const source = reader();
  const { create } = jobs({ db, reader: source });
  const answer = await create.runPoll(pollRequest, AbortSignal.timeout(5000));
  assert.equal(answer.outcome, 'settled');
  assert.equal(answer.claimed, 0);
  assert.equal(source.calls.length, 0, 'No GET without a usable connection.');
  assert.equal(names(db.calls).includes('release_device_command_poll'), true);
});

test('a 404 answer settles unknown with command-not-found', async () => {
  const db = database({
    pollClaim: claimsOf(pollClaimed([pollOperation(1, 'd1', '4100000001')]), {
      outcome: 'not-held',
      status: 'awaiting-devices',
    }),
  });
  const source = reader(
    [],
    [],
    [],
    [
      [
        {
          parts: { d1: { kind: 'not-found', status: 404, reason: 'notFound' } },
        },
      ],
    ],
  );
  const { create } = jobs({ db, reader: source });
  await create.runPoll(pollRequest, AbortSignal.timeout(5000));
  const settle = db.calls.find(
    (one) => one.name === 'settle_device_command_polls',
  );
  assert.deepEqual(JSON.parse(settle.values[4]), [
    {
      operationNumber: 1,
      outcome: 'unknown',
      outcomeReason: 'command-not-found',
      googleStatus: 404,
      googleReason: null,
    },
  ]);
});

test('a retrying sibling does not cost an answered terminal result (R3)', async () => {
  const db = database({
    pollClaim: claimsOf(
      pollClaimed([
        pollOperation(1, 'd1', '4100000001'),
        pollOperation(2, 'd2', '4100000002'),
      ]),
      { outcome: 'idle', status: 'awaiting-devices', operations: [] },
    ),
  });
  let settledBeforeRetry = false;
  const source = pollReader(async (options) => {
    await options.onResponse(
      pollSuccess(
        'd1',
        pollObservation('EXECUTED_BY_CLIENT', {
          result: 'SUCCESS',
          executedAt: '2026-10-21T12:00:00.000Z',
        }),
      ),
    );
    // The call has not returned and the sibling still retries.
    settledBeforeRetry = db.calls.some(
      (one) => one.name === 'settle_device_command_polls',
    );
    await options.onResponse(pollRetry('d2'));
    await options.onResponse(pollRetry('d2'));
  });
  const { create } = jobs({ db, reader: source });
  const answer = await create.runPoll(pollRequest, AbortSignal.timeout(5000));
  assert.equal(
    settledBeforeRetry,
    true,
    'The success settles while the sibling retries.',
  );
  assert.equal(answer.settled, 1);
  assert.equal(answer.succeeded, 1);
  assert.deepEqual(
    pollSettled(db).map((one) => [one.operationNumber, one.outcome]),
    [[1, 'succeeded']],
  );
});

test('an answered terminal result stays settled when the reader throws (R3)', async () => {
  const db = database({
    pollClaim: claimsOf(
      pollClaimed([
        pollOperation(1, 'd1', '4100000001'),
        pollOperation(2, 'd2', '4100000002'),
      ]),
      { outcome: 'idle', status: 'awaiting-devices', operations: [] },
    ),
  });
  const source = pollReader(async (options) => {
    await options.onResponse(pollSuccess('d1', pollObservation('EXPIRED')));
    throw new Error('The batch client failed after the answer.');
  });
  const { create } = jobs({ db, reader: source });
  await assert.rejects(
    create.runPoll(pollRequest, AbortSignal.timeout(5000)),
    /failed after the answer/,
  );
  assert.deepEqual(
    pollSettled(db).map((one) => [one.operationNumber, one.outcome]),
    [[1, 'expired']],
  );
});

test('every poll call carries the acquired lease identity (R4)', async () => {
  const db = database({
    pollClaim: claimsOf(pollClaimed([pollOperation(1, 'd1', '4100000001')]), {
      outcome: 'idle',
      status: 'awaiting-devices',
      operations: [],
    }),
  });
  const source = pollReader(async (options) => {
    await options.onResponse(pollSuccess('d1', pollObservation('PENDING')));
  });
  const { create } = jobs({ db, reader: source });
  await create.runPoll(pollRequest, AbortSignal.timeout(5000));
  const valuesOf = (name) =>
    db.calls.filter((one) => one.name === name).map((one) => one.values);
  assert.deepEqual(valuesOf('claim_device_command_polls')[0], [
    customerId,
    jobId,
    valuesOf('claim_device_command_polls')[0][2],
    pollRequest.leaseId,
  ]);
  assert.equal(
    valuesOf('settle_device_command_polls')[0][3],
    pollRequest.leaseId,
  );
  assert.deepEqual(valuesOf('release_device_command_poll')[0], [
    customerId,
    jobId,
    pollRequest.leaseId,
  ]);
});

test('each row of the poll settlement table classifies as section 4 step 9 says', () => {
  const operation = { operationNumber: 7 };
  const run = (state, extra, failure = null) =>
    classifyCommandPoll(operation, pollObservation(state, extra), failure);
  const failed = (status, kind = 'transient') => ({
    kind,
    status,
    reason: 'backendError',
    attempts: { quota: 0, transient: 10 },
    body: null,
  });
  assert.deepEqual(run('PENDING'), {
    operationNumber: 7,
    outcome: 'pending',
    commandState: 'pending-delivery',
    commandExpiresAt: '2026-10-28T12:00:00.000Z',
  });
  assert.equal(run('SENT_TO_CLIENT').commandState, 'sent');
  assert.equal(run('ACKED_BY_CLIENT').commandState, 'acknowledged');
  assert.deepEqual(
    run('EXECUTED_BY_CLIENT', {
      result: 'SUCCESS',
      executedAt: '2026-10-21T12:00:00.000Z',
    }),
    {
      operationNumber: 7,
      outcome: 'succeeded',
      googleStatus: 200,
      commandExecutedAt: '2026-10-21T12:00:00.000Z',
      commandExpiresAt: '2026-10-28T12:00:00.000Z',
    },
  );
  // DEVICE-02: no command result forbids a success. The command stays acknowledged.
  assert.deepEqual(run('EXECUTED_BY_CLIENT', { result: null }), {
    operationNumber: 7,
    outcome: 'pending',
    commandState: 'acknowledged',
    commandExpiresAt: '2026-10-28T12:00:00.000Z',
  });
  assert.deepEqual(
    run('EXECUTED_BY_CLIENT', {
      result: 'FAILURE',
      errorMessage: 'The device failed to execute the command.',
    }),
    {
      operationNumber: 7,
      outcome: 'failed',
      outcomeReason: 'command-failed',
      googleStatus: 200,
      googleReason: 'The device failed to execute the command.',
      commandExpiresAt: '2026-10-28T12:00:00.000Z',
    },
  );
  assert.equal(run('EXPIRED').outcome, 'expired');
  // D14: a reported IGNORED result settles failed with command-failed, as FAILURE does.
  assert.deepEqual(run('EXECUTED_BY_CLIENT', { result: 'IGNORED' }), {
    operationNumber: 7,
    outcome: 'failed',
    outcomeReason: 'command-failed',
    googleStatus: 200,
    googleReason: null,
    commandExpiresAt: '2026-10-28T12:00:00.000Z',
  });
  // D14: STATE_UNSPECIFIED and another unknown state value keep the unknown default.
  assert.deepEqual(run('STATE_UNSPECIFIED'), {
    operationNumber: 7,
    outcome: 'unknown',
    outcomeReason: 'unrecognized-state',
    googleStatus: 200,
    commandExpiresAt: '2026-10-28T12:00:00.000Z',
  });
  // D14: CANCELLED settles failed with command-cancelled for every command type.
  assert.deepEqual(run('CANCELLED'), {
    operationNumber: 7,
    outcome: 'failed',
    outcomeReason: 'command-cancelled',
    googleStatus: 200,
    commandExpiresAt: '2026-10-28T12:00:00.000Z',
  });
  assert.deepEqual(run('SOMETHING_NEW'), {
    operationNumber: 7,
    outcome: 'unknown',
    outcomeReason: 'unrecognized-state',
    googleStatus: 200,
    commandExpiresAt: '2026-10-28T12:00:00.000Z',
  });
  assert.deepEqual(
    classifyCommandPoll(operation, null, failed(404, 'not-found')),
    {
      operationNumber: 7,
      outcome: 'unknown',
      outcomeReason: 'command-not-found',
      googleStatus: 404,
      googleReason: null,
    },
  );
  for (const failure of [
    failed(429, 'quota'),
    failed(503, 'transient'),
    failed(403, 'rejected'),
    failed(200, 'invalid-response'),
  ])
    assert.equal(
      classifyCommandPoll(operation, null, failure),
      null,
      `${failure.kind} changes nothing`,
    );
});

test('a poll request requires the customer, the job, the lease, and the correlation', () => {
  assert.equal(
    deviceCommandPollRequestSchema.safeParse(pollRequest).success,
    true,
  );
  for (const field of ['customerId', 'jobId', 'leaseId', 'correlationId'])
    assert.equal(
      deviceCommandPollRequestSchema.safeParse({
        ...pollRequest,
        [field]: undefined,
      }).success,
      false,
      field,
    );
});

test('the poll dispatch route answers 200 with the run summary', async () => {
  const context = { secret: 's'.repeat(32), signal: AbortSignal.timeout(5000) };
  const received = [];
  const google = {
    pollDeviceCommands: async (input) => {
      received.push(input);
      return {
        outcome: 'completed',
        claimed: 2,
        settled: 2,
        succeeded: 2,
        failed: 0,
        expired: 0,
        unknown: 0,
        pending: 0,
      };
    },
  };
  const request = Readable.from([
    Buffer.from(JSON.stringify({ ...pollRequest, executionId: 'exec-1' })),
  ]);
  request.method = 'POST';
  request.url = '/dispatch/device-command-poll';
  request.headers = {
    authorization: `Bearer ${context.secret}`,
    'content-type': 'application/json',
  };
  const response = {
    statusCode: 0,
    payload: null,
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(text) {
      this.payload = JSON.parse(text);
    },
  };
  assert.equal(
    await handleDeviceCommandPollDispatch(request, response, context, google),
    true,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.status, 'completed');
  assert.equal(response.payload.executionId, 'exec-1');
  assert.deepEqual(received, [pollRequest]);
});
