import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ConflictException } from '@nestjs/common';
import { GoogleConnectionError } from '@campus/google-connection';
import { DeviceFreshRead } from './device-fresh-read.ts';

const customer = 'C0123456';
const actor = '11111111-1111-4111-8111-111111111111';
const connected = { customerId: customer, generation: 3 };
const session = {
  identity: {
    id: actor,
    displayName: 'Test person',
    permissions: [],
    permissionVersion: 1,
    grants: [],
    preferences: {},
  },
  expiresAt: '2026-10-23T12:00:00.000Z',
  csrfToken: 'a'.repeat(64),
};
const credential = {
  subject: 'admin@example.org',
  serviceAccount: {
    client_email: 'fixture@example.iam.gserviceaccount.com',
    private_key: 'synthetic',
    private_key_id: 'fixture',
  },
};
const observation = (deviceId, extra = {}) => ({
  deviceId,
  serialNumber: `SN-${deviceId}`,
  model: null,
  assetTag: null,
  orgUnitPath: '/School A',
  lastContact: null,
  annotatedLocation: null,
  annotatedUser: null,
  notes: null,
  status: 'ACTIVE',
  ...extra,
});
const row = (deviceId, extra = {}) => ({
  device_id: deviceId,
  serial_number: `SN-${deviceId}`,
  org_unit_path: '/School A',
  asset_tag: null,
  annotated_location: null,
  annotated_user: null,
  notes: null,
  removed_at: null,
  last_entity_sync: '2026-10-23T12:00:00.000Z',
  ...extra,
});

/** Settle a call into a value or an error so a wrong answer reads as an assertion. */
const settle = (call) =>
  call().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

/**
 * The fresh-read harness. `queries` records the SQL of every call, `order` records the stamp and
 * the Google read, and `writes` records the store calls.
 */
function createRead({
  inventory = () => [row('d1')],
  rows,
  read = async () => ({ devices: [observation('d1')], missing: [] }),
  credential: openCredential = async () => credential,
  options = {},
} = {}) {
  const order = [];
  const writes = [];
  const queries = [];
  const readCalls = [];
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes('clock_timestamp')) {
        order.push('stamp');
        return { rows: [{ stamp: new Date('2026-10-23T12:00:01.000Z') }] };
      }
      if (text.includes('SELECT device_id FROM cc.devices'))
        return { rows: inventory(values[1]) };
      if (/SELECT device_id,serial_number,org_unit_path/.test(text))
        return {
          rows: rows ?? values[1].map((id) => row(id)),
        };
      throw new Error(`Unexpected SQL: ${text}`);
    },
  };
  const route = new DeviceFreshRead(
    {
      connection: client,
      async transaction(run) {
        return run({
          async query(text, values) {
            writes.push({ text, values });
            queries.push({ text, values });
            return { rows: [{ result: 1 }] };
          },
        });
      },
    },
    {
      credential: openCredential,
      read: async (opened, customerId, ids, signal) => {
        order.push('read');
        readCalls.push({ credential: opened, customerId, ids, signal });
        return read(opened, customerId, ids, signal);
      },
    },
    options,
  );
  return { route, order, writes, queries, readCalls };
}

test('the stamp precedes the Google read and the read stores as a read observation', async () => {
  const harness = createRead({
    inventory: () => [row('d1'), row('d2')],
    read: async () => ({
      devices: [observation('d1'), observation('d2')],
      missing: [],
    }),
  });
  const answer = await harness.route.read(session, connected, ['d1', 'd2']);

  assert.deepEqual(
    harness.order,
    ['stamp', 'read'],
    'Postgres stamps the read time before the Google call.',
  );
  assert.equal(harness.readCalls[0].customerId, customer);
  assert.deepEqual(harness.readCalls[0].ids, ['d1', 'd2']);
  assert.equal(harness.readCalls[0].credential, credential);
  assert.deepEqual(
    harness.writes.map((write) => [
      write.values[3],
      JSON.parse(write.values[1]).length,
    ]),
    [['read', 2]],
    'The read stores through cc.upsert_devices with the read observation.',
  );
  assert.match(harness.writes[0].text, /cc\.upsert_devices/);
  assert.equal(harness.writes[0].values[0], customer);
  assert.equal(harness.writes[0].values[2], '2026-10-23T12:00:01.000Z');
  assert.equal(answer.syncedAt, '2026-10-23T12:00:01.000Z');
  assert.deepEqual(
    answer.rows.map((device) => device.device_id),
    ['d1', 'd2'],
    'The route reads the stored rows from Postgres, not from the Google answer.',
  );
});

test('the read skips telemetry and keeps the stored battery values', async () => {
  const harness = createRead();
  await harness.route.read(session, connected, ['d1']);
  const stored = harness.queries.map((query) => query.text).join('\n');
  assert.equal(
    /upsert_device_batteries|batteryBatch/.test(stored),
    false,
    'The fresh read stores no battery observation.',
  );
});

test('an unknown device ID answers 422 unknown-device before any Google call', async () => {
  const harness = createRead({ inventory: () => [row('d1')] });
  const answer = await settle(() =>
    harness.route.read(session, connected, ['d1', 'd2']),
  );

  assert.ok(answer.error instanceof Error);
  assert.equal(answer.error.getStatus(), 422);
  assert.deepEqual(answer.error.getResponse(), {
    reason: 'unknown-device',
    deviceIds: ['d2'],
  });
  assert.deepEqual(harness.order, [], 'No stamp and no Google call run.');
  assert.deepEqual(harness.readCalls, [], 'No device read runs.');
  assert.deepEqual(harness.writes, [], 'No read is stored.');
});

test('a Google read failure answers 503 device-read-failed with its code and stores nothing', async () => {
  for (const code of ['quota', 'permission-denied', 'invalid-response']) {
    const harness = createRead({
      read: async () => {
        throw new GoogleConnectionError(code);
      },
    });
    const answer = await settle(() =>
      harness.route.read(session, connected, ['d1']),
    );
    assert.ok(answer.error instanceof Error, code);
    assert.equal(answer.error.getStatus(), 503, code);
    assert.deepEqual(
      answer.error.getResponse(),
      { reason: 'device-read-failed', failure: code },
      code,
    );
    assert.deepEqual(harness.writes, [], 'A failed read is not stored.');
  }
});

test('the 25-second deadline answers device-read-failed with network-failure', async () => {
  const harness = createRead({
    credential: async () => {
      // A credential that never arrives holds the call until the deadline ends it.
      await new Promise(() => undefined);
      return credential;
    },
    options: { deadlineMilliseconds: 30 },
  });
  const started = Date.now();
  const answer = await settle(() =>
    harness.route.read(session, connected, ['d1']),
  );

  assert.ok(Date.now() - started < 5_000, 'The deadline ends the call.');
  assert.ok(answer.error instanceof Error);
  assert.equal(answer.error.getStatus(), 503);
  assert.deepEqual(answer.error.getResponse(), {
    reason: 'device-read-failed',
    failure: 'network-failure',
  });
  assert.deepEqual(harness.readCalls, [], 'The Google read never starts.');
  assert.deepEqual(harness.writes, [], 'A timed-out read is not stored.');
});

test('a read that the deadline aborts answers network-failure', async () => {
  const harness = createRead({
    options: { deadlineMilliseconds: 30 },
    read: async (_credential, _customer, _ids, signal) => {
      // The batch service reports its abort as an AbortError.
      await new Promise((resolve) =>
        signal.addEventListener('abort', resolve, { once: true }),
      );
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    },
  });
  const answer = await settle(() =>
    harness.route.read(session, connected, ['d1']),
  );

  assert.ok(answer.error instanceof Error);
  assert.equal(answer.error.getStatus(), 503);
  assert.deepEqual(answer.error.getResponse(), {
    reason: 'device-read-failed',
    failure: 'network-failure',
  });
});

test('a device that Google no longer returns is soft-deleted', async () => {
  const harness = createRead({
    inventory: () => [row('d1'), row('d2')],
    read: async () => ({ devices: [observation('d1')], missing: ['d2'] }),
  });
  await harness.route.read(session, connected, ['d1', 'd2']);

  assert.deepEqual(
    harness.writes.map((write) => write.text.match(/cc\.\w+/)[0]),
    ['cc.upsert_devices', 'cc.soft_delete_devices'],
  );
  assert.deepEqual(harness.writes[1].values, [customer, '["d2"]']);
});

test('a missing device credential answers 409 connection-required', async () => {
  const harness = createRead({ credential: async () => null });
  const answer = await settle(() =>
    harness.route.read(session, connected, ['d1']),
  );
  assert.ok(answer.error instanceof ConflictException);
  assert.deepEqual(answer.error.getResponse(), {
    reason: 'connection-required',
  });
  assert.deepEqual(harness.readCalls, []);
});

test('a Postgres fault answers 503 device-store-unavailable without a preview', async () => {
  const client = {
    async query() {
      throw new Error('connection terminated');
    },
  };
  const route = new DeviceFreshRead(
    {
      connection: client,
      transaction: async (run) => run(client),
    },
    {
      credential: async () => credential,
      read: async () => ({ devices: [], missing: [] }),
    },
  );
  const answer = await settle(() => route.read(session, connected, ['d1']));
  assert.ok(answer.error instanceof Error);
  assert.equal(answer.error.getStatus(), 503);
  assert.deepEqual(answer.error.getResponse(), {
    reason: 'device-store-unavailable',
  });
});

test('a device ID repeats once in the Google read', async () => {
  const harness = createRead();
  await harness.route.read(session, connected, ['d1', 'd1']);
  assert.deepEqual(harness.readCalls[0].ids, ['d1']);
});

test('a list over 1,000 devices reads in batches of 1,000', async () => {
  const ids = Array.from({ length: 1001 }, (_, index) => `d${index + 1}`);
  const harness = createRead({
    inventory: () => ids.map((id) => row(id)),
    read: async (_opened, _customer, batch, signal) => {
      // One round is one credential-backed batch, so the signal must stay live.
      assert.equal(signal.aborted, false);
      return { devices: batch.map((id) => observation(id)), missing: [] };
    },
  });
  const answer = await harness.route.read(session, connected, ids);

  assert.deepEqual(
    harness.readCalls.map((call) => call.ids.length),
    [1000, 1],
    'deviceBatch carries at most 1,000 IDs, so the route splits the list.',
  );
  assert.deepEqual(
    harness.readCalls.flatMap((call) => call.ids),
    ids,
    'The batches keep the requested order.',
  );
  assert.equal(answer.rows.length, 1001);
  assert.deepEqual(
    harness.writes.map((write) => JSON.parse(write.values[1]).length),
    [1000, 1],
    'The route stores the read in calls of at most 1,000 devices.',
  );
});
