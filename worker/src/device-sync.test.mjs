import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { GoogleConnectionError } from '@campus/google-connection';
import { DeviceSync, DeviceSyncError } from './device-sync.ts';
import {
  EntityCacheError,
  noEntityCache,
  recordSeconds,
} from './entity-cache.ts';

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
  deviceCount: 2,
  failure: null,
  telemetryFailure: null,
  startedAt: '2026-10-05T11:59:00.000Z',
  checkedAt: '2026-10-05T12:00:00.000Z',
  stale: false,
};
const device = (deviceId) => ({
  deviceId,
  serialNumber: deviceId,
  model: null,
  assetTag: null,
  orgUnitPath: '/',
  lastContact: null,
  annotatedLocation: null,
  annotatedUser: null,
  notes: null,
  status: null,
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
      if (name === 'claim_device_sync')
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
      if (name === 'finish_device_sync') {
        await onFinish();
        return { rows: [{ result: state }] };
      }
      if (name === 'page_last_removed_device_ids')
        return { rows: [{ result: values[1] === '' ? removed : [] }] };
      if (name === 'page_device_records') onPage();
      if (name === 'page_device_records')
        return {
          rows: [
            { result: values[1] === '' ? [record('d1'), record('d2')] : [] },
          ],
        };
      return { rows: [{ result: 1 }] };
    },
  };
}
const record = (deviceId) => ({
  version: 1,
  record: {
    deviceId,
    serialNumber: deviceId,
    model: null,
    assetTag: null,
    orgUnitPath: '/',
    lastContact: null,
    annotatedLocation: null,
    annotatedUser: null,
    notes: null,
    status: 'ACTIVE',
    battery: { status: 'no-report' },
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
function reader({
  devices = [[device('d1'), device('d2')]],
  batteries = [[]],
} = {}) {
  return {
    async *devicePages() {
      for (const page of devices) {
        if (page instanceof Error) throw page;
        yield page;
      }
    },
    async *batteryPages() {
      for (const page of batteries) {
        if (page instanceof Error) throw page;
        yield page;
      }
    },
  };
}
const names = (calls) => calls.map((call) => call.name);

/** Timers whose interval the test fires by hand. The delay of each one is recorded. */
function timers() {
  const intervals = new Map();
  const scheduled = [];
  let sequence = 0;
  const handle = {
    setInterval(callback, delay) {
      const id = ++sequence;
      intervals.set(id, { callback, delay });
      scheduled.push(delay);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
  };
  return {
    handle,
    async fire() {
      for (const entry of [...intervals.values()]) await entry.callback();
    },
    delays() {
      return scheduled;
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
    async *devicePages(_credential, _customer, signal) {
      yield [device('d1'), device('d2')];
      staged();
      await untilAborted(signal);
      throw new GoogleConnectionError('network-failure');
    },
    async *batteryPages() {
      yield [];
    },
  };
}

test('stages every page, publishes, fills Redis, and bumps the query generation', async () => {
  const db = database();
  const redis = cache();
  const result = await new DeviceSync(db, cipher, reader(), redis).run(
    request,
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(result, state);
  assert.deepEqual(names(db.calls), [
    'claim_device_sync',
    'stage_devices',
    'stage_device_batteries',
    'finish_device_sync',
    'page_last_removed_device_ids',
    'page_device_records',
    'page_device_records',
  ]);
  assert.deepEqual(db.calls[5].values, [customerId, '', 1000]);
  assert.deepEqual(db.calls[6].values, [customerId, 'd2', 1000]);
  assert.deepEqual(names(redis.calls), ['setRecords', 'increment', 'publish']);
  assert.deepEqual(
    redis.calls[0].args[0].map((entry) => entry.key),
    ['cc:entity:device:C0123456:d1', 'cc:entity:device:C0123456:d2'],
  );
  assert.deepEqual(
    redis.calls[0].args[0].map((entry) => entry.seconds),
    [82800, 82800],
  );
  assert.equal(redis.calls[0].args.length, 1);
  assert.deepEqual(redis.calls[1].args, ['cc:query-gen:device:C0123456']);
  assert.deepEqual(JSON.parse(redis.calls[2].args[1]), {
    type: 'full-sync',
    sync: state,
  });
});

test('telemetry failure still publishes devices', async () => {
  const db = database();
  await new DeviceSync(
    db,
    cipher,
    reader({ batteries: [new GoogleConnectionError('permission-denied')] }),
    cache(),
  ).run(request, AbortSignal.timeout(5000));
  const finish = db.calls.find((call) => call.name === 'finish_device_sync');
  assert.deepEqual(finish.values.slice(3), [null, 'permission-denied']);
});

test('a device page failure records the failure without reading telemetry', async () => {
  const db = database();
  const redis = cache();
  await new DeviceSync(
    db,
    cipher,
    reader({
      devices: [[device('d1')], new GoogleConnectionError('permission-denied')],
    }),
    redis,
  ).run(request, AbortSignal.timeout(5000));
  assert.equal(names(db.calls).includes('stage_device_batteries'), false);
  const finish = db.calls.find((call) => call.name === 'finish_device_sync');
  assert.deepEqual(finish.values.slice(3), ['permission-denied', null]);
  assert.deepEqual(
    names(redis.calls),
    ['publish'],
    'A failed sync signals but writes no records.',
  );
});

test('a second attempt for the same sync stops before Google access', async () => {
  const db = database({ fail: { claim_device_sync: 'device-sync-claimed' } });
  await assert.rejects(
    new DeviceSync(db, cipher, reader(), cache()).run(
      request,
      AbortSignal.timeout(5000),
    ),
    (error) =>
      error instanceof DeviceSyncError && error.code === 'device-sync-claimed',
  );
  assert.deepEqual(names(db.calls), ['claim_device_sync']);
});

test('a lost lease stops staging and never publishes', async () => {
  const db = database({ fail: { stage_devices: 'device-sync-changed' } });
  await assert.rejects(
    new DeviceSync(db, cipher, reader(), cache()).run(
      request,
      AbortSignal.timeout(5000),
    ),
    (error) =>
      error instanceof DeviceSyncError && error.code === 'device-sync-changed',
  );
  assert.equal(names(db.calls).includes('finish_device_sync'), false);
});

test('a Redis fault after publication does not fail the sync', async () => {
  const db = database();
  const redis = cache();
  redis.setRecords = async (...args) => {
    redis.calls.push({ name: 'setRecords', args });
    throw new EntityCacheError();
  };
  const result = await new DeviceSync(db, cipher, reader(), redis).run(
    request,
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(result, state);
  assert.ok(names(db.calls).includes('finish_device_sync'));
  assert.deepEqual(names(redis.calls), ['setRecords', 'publish']);
});

test('shutdown stops the Redis fill', async () => {
  const controller = new AbortController();
  const db = database({ onPage: () => controller.abort() });
  const redis = cache();
  const result = await new DeviceSync(db, cipher, reader(), redis).run(
    request,
    controller.signal,
  );
  assert.deepEqual(result, state);
  assert.equal(
    names(db.calls).filter((name) => name === 'page_device_records').length,
    1,
  );
  assert.ok(names(redis.calls).includes('publish'));
});

test('the no-op cache lets a full sync publish without Redis', async () => {
  const db = database();
  const result = await new DeviceSync(db, cipher, reader(), noEntityCache).run(
    request,
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(result, state);
  assert.deepEqual(names(db.calls), [
    'claim_device_sync',
    'stage_devices',
    'stage_device_batteries',
    'finish_device_sync',
    'page_last_removed_device_ids',
    'page_device_records',
    'page_device_records',
  ]);
  for (const method of [
    'setRecords',
    'remove',
    'removeMembers',
    'extendMembers',
    'increment',
    'publish',
    'close',
  ])
    assert.equal(await noEntityCache[method]('key', []), undefined);
});

test('a full sync deletes the cached records of the devices it removed', async () => {
  const db = database({ removed: ['r1', 'r2'] });
  const redis = cache();
  await new DeviceSync(db, cipher, reader(), redis).run(
    request,
    AbortSignal.timeout(5000),
  );
  const pages = db.calls.filter(
    (call) => call.name === 'page_last_removed_device_ids',
  );
  assert.deepEqual(
    pages.map((call) => call.values),
    [
      [customerId, '', 1000],
      [customerId, 'r2', 1000],
    ],
  );
  assert.deepEqual(names(redis.calls), [
    'remove',
    'setRecords',
    'increment',
    'publish',
  ]);
  assert.deepEqual(redis.calls[0].args[0], [
    'cc:entity:device:C0123456:r1',
    'cc:entity:device:C0123456:r2',
  ]);
});

test('a failed removed-device read does not fail the sync', async () => {
  const db = database({ fail: { page_last_removed_device_ids: 'store-down' } });
  const redis = cache();
  const result = await new DeviceSync(db, cipher, reader(), redis).run(
    request,
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(result, state);
  assert.deepEqual(names(redis.calls), ['publish']);
});

test('record expiry follows the freshness that remains', () => {
  const now = Date.parse('2026-10-06T12:00:00.000Z');
  assert.equal(recordSeconds('2026-10-06T11:00:00.000Z', now), 82800);
  assert.equal(recordSeconds('2026-10-06T10:59:59.500000+00:00', now), 82800);
  assert.equal(
    recordSeconds('2026-10-04T12:00:00.000Z', now),
    1,
    'A stale record expires at once.',
  );
  assert.equal(
    recordSeconds('2026-10-07T12:00:00.000Z', now),
    86400,
    'A future stamp keeps the full threshold.',
  );
  assert.equal(recordSeconds('not a time', now), 1);
});

test('the cancel tick aborts the stalled read and the raising finish leaves Redis untouched', async () => {
  const db = database({ fail: { finish_device_sync: 'device-sync-changed' } });
  const redis = cache();
  const clock = timers();
  const source = stallingReader();
  const run = new DeviceSync(db, cipher, source, redis, {
    timers: clock.handle,
  }).run(request, AbortSignal.timeout(5000));
  await source.started;
  await clock.fire();
  await assert.rejects(
    run,
    (error) =>
      error instanceof DeviceSyncError && error.code === 'device-sync-changed',
  );
  assert.deepEqual(names(db.calls), [
    'claim_device_sync',
    'stage_devices',
    'job_cancel_requested',
    'finish_device_sync',
  ]);
  assert.equal(
    names(db.calls).includes('stage_device_batteries'),
    false,
    'No stage follows the abort.',
  );
  const cancel = db.calls.find((call) => call.name === 'job_cancel_requested');
  assert.deepEqual(cancel.values, [customerId, request.syncId]);
  assert.deepEqual(names(redis.calls), []);
  assert.deepEqual(clock.delays(), [30_000]);
  assert.equal(clock.count, 0, 'The tick stops at the end of the run.');
});

test('a cancel that the finish does not refuse still runs no Redis step and publishes no event', async () => {
  const clock = timers();
  const db = database({ cancels: [true], onFinish: () => clock.fire() });
  const redis = cache();
  const result = await new DeviceSync(db, cipher, reader(), redis, {
    timers: clock.handle,
  }).run(request, AbortSignal.timeout(5000));
  assert.deepEqual(result, state);
  assert.deepEqual(names(db.calls), [
    'claim_device_sync',
    'stage_devices',
    'stage_device_batteries',
    'finish_device_sync',
    'job_cancel_requested',
  ]);
  assert.deepEqual(names(redis.calls), []);
});

test('a failed cancel read leaves the sync running and the next tick reads again', async () => {
  const db = database({
    cancels: ['fail', true],
    fail: { finish_device_sync: 'device-sync-changed' },
  });
  const clock = timers();
  const source = stallingReader();
  const run = new DeviceSync(db, cipher, source, cache(), {
    timers: clock.handle,
  }).run(request, AbortSignal.timeout(5000));
  await source.started;
  await clock.fire();
  assert.equal(
    names(db.calls).includes('finish_device_sync'),
    false,
    'A failed read does not abort the sync.',
  );
  await clock.fire();
  await assert.rejects(
    run,
    (error) =>
      error instanceof DeviceSyncError && error.code === 'device-sync-changed',
  );
  assert.deepEqual(names(db.calls), [
    'claim_device_sync',
    'stage_devices',
    'job_cancel_requested',
    'job_cancel_requested',
    'finish_device_sync',
  ]);
});
