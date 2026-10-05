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

function database({ fail = {}, purged = [0] } = {}) {
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
      if (name === 'purge_device_syncs') return { rows: [{ result: purged.shift() ?? 0 }] };
      return { rows: [{ result: 1 }] };
    },
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

test('stages every page, publishes, and purges retired rows', async () => {
  const db = database({ purged: [5000, 12] });
  const result = await new DeviceSync(db, cipher, reader()).run(request, AbortSignal.timeout(5000));
  assert.deepEqual(result, state);
  assert.deepEqual(names(db.calls), [
    'claim_device_sync',
    'stage_devices',
    'stage_device_batteries',
    'finish_device_sync',
    'purge_device_syncs',
    'purge_device_syncs',
  ]);
  const attempt = db.calls[0].values[2];
  assert.ok(db.calls.slice(1, 4).every((call) => call.values[2] === attempt));
  assert.deepEqual(db.calls[3].values.slice(3), [null, null]);
});

test('telemetry failure still publishes devices', async () => {
  const db = database();
  await new DeviceSync(
    db,
    cipher,
    reader({ batteries: [new GoogleConnectionError('permission-denied')] }),
  ).run(request, AbortSignal.timeout(5000));
  const finish = db.calls.find((call) => call.name === 'finish_device_sync');
  assert.deepEqual(finish.values.slice(3), [null, 'permission-denied']);
});

test('a device page failure records the failure without reading telemetry', async () => {
  const db = database();
  await new DeviceSync(
    db,
    cipher,
    reader({ devices: [[device('d1')], new GoogleConnectionError('permission-denied')] }),
  ).run(request, AbortSignal.timeout(5000));
  assert.equal(names(db.calls).includes('stage_device_batteries'), false);
  const finish = db.calls.find((call) => call.name === 'finish_device_sync');
  assert.deepEqual(finish.values.slice(3), ['permission-denied', null]);
});

test('a second attempt for the same sync stops before Google access', async () => {
  const db = database({ fail: { claim_device_sync: 'device-sync-claimed' } });
  await assert.rejects(
    new DeviceSync(db, cipher, reader()).run(request, AbortSignal.timeout(5000)),
    (error) => error instanceof DeviceSyncError && error.code === 'device-sync-claimed',
  );
  assert.deepEqual(names(db.calls), ['claim_device_sync']);
});

test('a lost lease stops staging and never publishes', async () => {
  const db = database({ fail: { stage_devices: 'device-sync-changed' } });
  await assert.rejects(
    new DeviceSync(db, cipher, reader()).run(request, AbortSignal.timeout(5000)),
    (error) => error instanceof DeviceSyncError && error.code === 'device-sync-changed',
  );
  assert.equal(names(db.calls).includes('finish_device_sync'), false);
});
