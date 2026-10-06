import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { GoogleConnectionError } from '@campus/google-connection';
import { DeviceSync, DeviceSyncError } from './device-sync.ts';

const customerId = 'C0123456';
const request = { customerId, syncId: randomUUID(), correlationId: randomUUID() };
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
  notes: null,
  status: null,
});

function database({ fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      const name = /cc\.(\w+)/.exec(sql)[1];
      calls.push({ name, values });
      if (fail[name]) throw Object.assign(new Error(name), { code: 'P0001', detail: fail[name] });
      if (name === 'claim_device_sync')
        return { rows: [{ result: { generation: 1, credentialId: randomUUID(), envelope: { sealed: true } } }] };
      if (name === 'finish_device_sync') return { rows: [{ result: state }] };
      if (name === 'page_device_records')
        return { rows: [{ result: values[1] === '' ? [record('d1'), record('d2')] : [] }] };
      return { rows: [{ result: 1 }] };
    },
  };
}
const record = (deviceId) => ({
  deviceId,
  serialNumber: deviceId,
  model: null,
  assetTag: null,
  orgUnitPath: '/',
  lastContact: null,
  annotatedLocation: null,
  notes: null,
  battery: { status: 'no-report' },
  lastEntitySync: '2026-10-06T12:00:00.000Z',
  removedAt: null,
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
    increment: note('increment'),
    publish: note('publish'),
    close: async () => undefined,
  };
}
const cipher = { open: () => ({ subject: 'fixture@example.invalid', serviceAccount: {} }) };
function reader({ devices = [[device('d1'), device('d2')]], batteries = [[]] } = {}) {
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

test('stages every page, publishes, fills Redis, and bumps the query generation', async () => {
  const db = database();
  const redis = cache();
  const result = await new DeviceSync(db, cipher, reader(), redis).run(request, AbortSignal.timeout(5000));
  assert.deepEqual(result, state);
  assert.deepEqual(names(db.calls), [
    'claim_device_sync',
    'stage_devices',
    'stage_device_batteries',
    'finish_device_sync',
    'page_device_records',
    'page_device_records',
  ]);
  assert.deepEqual(db.calls[4].values, [customerId, '', 1000]);
  assert.deepEqual(db.calls[5].values, [customerId, 'd2', 1000]);
  assert.deepEqual(names(redis.calls), ['setRecords', 'increment', 'publish']);
  assert.deepEqual(redis.calls[0].args[0].map((entry) => entry.key), [
    'cc:entity:device:C0123456:d1',
    'cc:entity:device:C0123456:d2',
  ]);
  assert.deepEqual(redis.calls[1].args, ['cc:query-gen:device:C0123456']);
  assert.deepEqual(JSON.parse(redis.calls[2].args[1]), { type: 'full-sync', sync: state });
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
    reader({ devices: [[device('d1')], new GoogleConnectionError('permission-denied')] }),
    redis,
  ).run(request, AbortSignal.timeout(5000));
  assert.equal(names(db.calls).includes('stage_device_batteries'), false);
  const finish = db.calls.find((call) => call.name === 'finish_device_sync');
  assert.deepEqual(finish.values.slice(3), ['permission-denied', null]);
  assert.deepEqual(names(redis.calls), ['publish'], 'A failed sync signals but writes no records.');
});

test('a second attempt for the same sync stops before Google access', async () => {
  const db = database({ fail: { claim_device_sync: 'device-sync-claimed' } });
  await assert.rejects(
    new DeviceSync(db, cipher, reader(), cache()).run(request, AbortSignal.timeout(5000)),
    (error) => error instanceof DeviceSyncError && error.code === 'device-sync-claimed',
  );
  assert.deepEqual(names(db.calls), ['claim_device_sync']);
});

test('a lost lease stops staging and never publishes', async () => {
  const db = database({ fail: { stage_devices: 'device-sync-changed' } });
  await assert.rejects(
    new DeviceSync(db, cipher, reader(), cache()).run(request, AbortSignal.timeout(5000)),
    (error) => error instanceof DeviceSyncError && error.code === 'device-sync-changed',
  );
  assert.equal(names(db.calls).includes('finish_device_sync'), false);
});
