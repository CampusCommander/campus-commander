/**
 * Reads a seeded mock tenant through Campus Commander's own Google readers.
 * The mock answers the OAuth exchange, the Directory API, and the Chrome Management API in process.
 * Run the file inside `nx run google-connection:test`. It uses no Docker and no live Google call.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { JWT } from 'google-auth-library';
import { startMock } from '@campuscommander/admin-sdk-mock';
import { GOOGLE_CAPABILITIES } from '@campus/application-contracts';
import { GoogleDeviceReader } from './devices.ts';
import { validateServiceAccount } from './credential.ts';

/** The device readers request one exact scope per capability. */
const readerScopes = [
  'device-inventory',
  'device-telemetry',
  'device-changes',
].map(
  (id) => GOOGLE_CAPABILITIES.find((capability) => capability.id === id).scope,
);
const telemetryScope = readerScopes[1];

/** Google's health values and the Campus Commander class of each one. */
const HEALTH_CLASS = {
  BATTERY_HEALTH_NORMAL: 'normal',
  BATTERY_REPLACE_SOON: 'replace-soon',
  BATTERY_REPLACE_NOW: 'replace-now',
};

/** A device ID that no seed can hold, for the removed-device path. */
const unknownDeviceId = '00000000-0000-4000-8000-000000000000';
const timeout = 60_000;

let mock;
let domain;
let credential;
let reader;
let inventory;
let telemetry;

async function collect(iterable) {
  const items = [];
  for await (const page of iterable) items.push(...page);
  return items;
}

/** Read raw telemetry with an unmodified Google client, so the expectations come from the mock. */
async function rawTelemetry() {
  const auth = new JWT({
    email: credential.serviceAccount.client_email,
    key: credential.serviceAccount.private_key,
    keyId: credential.serviceAccount.private_key_id,
    scopes: [telemetryScope],
    subject: credential.subject,
  });
  const devices = new Map();
  let pageToken;
  for (let page = 0; page < 100; page += 1) {
    const url = new URL(
      `https://chromemanagement.googleapis.com/v1/customers/${encodeURIComponent(domain.customerId)}/telemetry/devices`,
    );
    url.searchParams.set(
      'readMask',
      'deviceId,batteryInfo,batteryStatusReport',
    );
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const { data } = await auth.request({
      url: url.href,
      method: 'GET',
      retry: false,
    });
    for (const device of data.devices ?? [])
      devices.set(device.deviceId, device.batteryStatusReport ?? []);
    pageToken = data.nextPageToken;
    if (!pageToken) return devices;
  }
  throw new Error('The telemetry read never ended.');
}

/** Fail unless the port refuses a connection, which shows that no listener holds it. */
function assertRefused(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error(`Port ${port} answered no refusal.`));
    });
    socket.on('connect', () => {
      socket.destroy();
      reject(new Error(`Port ${port} still holds a listener.`));
    });
    socket.on('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
  });
}

before(async () => {
  mock = await startMock();
  // The proxy and its CA route every Google client of this process to the mock.
  mock.useInProcess();
  domain = await mock.createDomain({ tier: 'small', seed: 'reader-fixture' });
  const key = mock.credential(domain.customerId, readerScopes);
  credential = {
    serviceAccount: validateServiceAccount(key, key.client_id),
    subject: domain.adminEmail,
  };
  reader = new GoogleDeviceReader();
});

after(async () => {
  await mock?.close();
});

test('the inventory reader reads every device of the mock domain', async () => {
  inventory = await collect(
    reader.devicePages(
      credential,
      domain.customerId,
      AbortSignal.timeout(timeout),
    ),
  );
  const listed = (await mock.control('GET', '/domains')).find(
    (entry) => entry.customerId === domain.customerId,
  );
  assert.ok(listed, 'the mock reports the seeded domain');
  assert.equal(
    inventory.length,
    listed.counts.devices,
    'the reader reads the device count the mock reports',
  );
  assert.ok(
    listed.counts.devices > 300,
    'the domain holds more devices than one Directory page',
  );
  assert.equal(
    new Set(inventory.map((device) => device.deviceId)).size,
    inventory.length,
    'every device appears once',
  );
});

test('the telemetry reader reads every telemetry device and maps Google health', async () => {
  telemetry = await collect(
    reader.batteryPages(
      credential,
      domain.customerId,
      AbortSignal.timeout(timeout),
    ),
  );
  const raw = await rawTelemetry();
  assert.deepEqual(
    telemetry.map((entry) => entry.deviceId).sort(),
    [...raw.keys()].sort(),
    'the reader reads every telemetry device the mock holds',
  );
  const googleHealth = new Set();
  let reported = 0;
  for (const observation of telemetry) {
    const reports = [...raw.get(observation.deviceId)].sort(
      (left, right) =>
        Date.parse(right.reportTime) - Date.parse(left.reportTime),
    );
    assert.equal(
      observation.reports.length,
      reports.length,
      observation.deviceId,
    );
    if (reports.length === 0) {
      assert.equal(
        observation.battery.status,
        'no-report',
        observation.deviceId,
      );
      continue;
    }
    reported += 1;
    const expected = HEALTH_CLASS[reports[0].batteryHealth];
    assert.ok(
      expected,
      `the mock reports a known Google health value: ${reports[0].batteryHealth}`,
    );
    assert.equal(observation.battery.status, 'reported', observation.deviceId);
    assert.equal(observation.battery.health, expected, observation.deviceId);
    assert.equal(
      observation.battery.reportedAt,
      new Date(reports[0].reportTime).toISOString(),
      observation.deviceId,
    );
    for (const report of reports) googleHealth.add(report.batteryHealth);
  }
  assert.ok(reported > 0, 'battery telemetry arrives for devices that have it');
  assert.deepEqual(
    [...googleHealth].sort(),
    Object.keys(HEALTH_CLASS).sort(),
    'the seeded fleet covers every Google health value',
  );
  assert.deepEqual(
    [
      ...new Set(
        telemetry
          .filter((entry) => entry.battery.status === 'reported')
          .map((entry) => entry.battery.health),
      ),
    ].sort(),
    Object.values(HEALTH_CLASS).sort(),
    'every Campus Commander class appears',
  );
});

test('the per-device telemetry read keeps an unknown device apart', async () => {
  const sample = inventory.slice(0, 3).map((device) => device.deviceId);
  const batch = await reader.batteryBatch(
    credential,
    domain.customerId,
    [...sample, unknownDeviceId],
    AbortSignal.timeout(timeout),
  );
  assert.equal(batch.length, sample.length + 1);
  const listed = new Map(telemetry.map((entry) => [entry.deviceId, entry]));
  for (const deviceId of sample)
    assert.deepEqual(
      batch.find((entry) => entry.deviceId === deviceId),
      listed.get(deviceId),
      deviceId,
    );
  assert.deepEqual(
    batch.find((entry) => entry.deviceId === unknownDeviceId),
    {
      deviceId: unknownDeviceId,
      battery: { status: 'no-report' },
      reports: [],
    },
  );
});

test('a batch get resolves known devices and reports an unknown device as removed', async () => {
  const known = inventory.slice(0, 5).map((device) => device.deviceId);
  let rounds = 0;
  const { devices, missing } = await reader.deviceBatch(
    credential,
    domain.customerId,
    [...known, unknownDeviceId],
    AbortSignal.timeout(timeout),
    async () => {
      rounds += 1;
    },
  );
  assert.ok(rounds > 0, 'the batch service sent at least one multipart round');
  assert.deepEqual(missing, [unknownDeviceId]);
  assert.deepEqual(
    devices.map((device) => device.deviceId).sort(),
    [...known].sort(),
  );
  const expected = new Map(
    inventory.map((device) => [device.deviceId, device]),
  );
  for (const device of devices)
    assert.deepEqual(device, expected.get(device.deviceId));
});

/** Active devices whose last contact is inside the mock's 24-hour online window. */
function onlineDevices(count) {
  const now = Date.now();
  return inventory
    .filter(
      (device) =>
        device.status === 'ACTIVE' &&
        device.lastContact !== null &&
        now - Date.parse(device.lastContact) <= 24 * 3_600_000,
    )
    .slice(0, count);
}

test('a reboot command is issued once and polled through its states', async () => {
  const [early, late] = onlineDevices(2);
  assert.ok(early && late, 'the seed holds two active online devices');
  const issued = await reader.issueDeviceCommands(
    credential,
    domain.customerId,
    [{ deviceId: early.deviceId, commandType: 'REBOOT' }],
    AbortSignal.timeout(timeout),
  );
  const command = issued.succeeded.get(early.deviceId)[0];
  assert.match(command.commandId, /^\d{1,20}$/);
  const atOnce = await reader.deviceCommands(
    credential,
    domain.customerId,
    [command && { deviceId: early.deviceId, commandId: command.commandId }],
    AbortSignal.timeout(timeout),
  );
  const first = atOnce.succeeded.get(early.deviceId)[0];
  assert.equal(
    first.state,
    'PENDING',
    'Google holds the command before delivery.',
  );
  assert.equal(first.commandId, command.commandId);
  assert.ok(first.expiresAt, 'The answer carries the provider expiry.');

  await mock.control('PUT', '/clock', { scale: 20 });
  try {
    const later = await reader.issueDeviceCommands(
      credential,
      domain.customerId,
      [{ deviceId: late.deviceId, commandType: 'REBOOT' }],
      AbortSignal.timeout(timeout),
    );
    const second = later.succeeded.get(late.deviceId)[0];
    assert.match(second.commandId, /^\d{1,20}$/);
    const order = [
      'PENDING',
      'SENT_TO_CLIENT',
      'ACKED_BY_CLIENT',
      'EXECUTED_BY_CLIENT',
    ];
    const states = [];
    let observed;
    const started = Date.now();
    do {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const polled = await reader.deviceCommands(
        credential,
        domain.customerId,
        [{ deviceId: late.deviceId, commandId: second.commandId }],
        AbortSignal.timeout(timeout),
      );
      observed = polled.succeeded.get(late.deviceId)[0];
      states.push(observed.state);
    } while (
      !['EXECUTED_BY_CLIENT', 'EXPIRED'].includes(observed.state) &&
      Date.now() - started < 10_000
    );
    let reached = 0;
    for (const state of states) {
      const next = order.indexOf(state);
      assert.ok(next >= 0, `a known command state: ${state}`);
      assert.ok(
        next >= reached,
        `the states advance in order: ${states.join(', ')}`,
      );
      reached = next;
    }
    assert.equal(
      observed.state,
      'EXECUTED_BY_CLIENT',
      `the online device executed after ${states.join(', ')}`,
    );
    assert.equal(observed.commandId, second.commandId);
    assert.ok(observed.expiresAt);
    assert.ok(observed.executedAt);
    assert.ok(['SUCCESS', 'FAILURE'].includes(observed.result));
  } finally {
    await mock.control('PUT', '/clock', { scale: 1 });
  }
});

test('an issue command for a disabled device fails with the provider refusal', async () => {
  const device = inventory.find((entry) => entry.status === 'DISABLED');
  assert.ok(device, 'the seed holds a disabled device');
  const issued = await reader.issueDeviceCommands(
    credential,
    domain.customerId,
    [{ deviceId: device.deviceId, commandType: 'REBOOT' }],
    AbortSignal.timeout(timeout),
  );
  const failure = issued.failed.get(device.deviceId);
  assert.deepEqual(
    [failure.kind, failure.status, failure.reason],
    ['rejected', 400, 'failedPrecondition'],
  );
  assert.equal(issued.succeeded.size, 0);
});

test('a status change answers per device, and a second disable is a status conflict', async () => {
  const [device] = inventory.filter((entry) => entry.status === 'ACTIVE');
  const first = await reader.changeDeviceStatus(
    credential,
    domain.customerId,
    [
      { deviceId: device.deviceId, action: 'disable' },
      { deviceId: unknownDeviceId, action: 'disable' },
    ],
    AbortSignal.timeout(timeout),
  );
  assert.equal(first.answers[0].result.outcome, 'succeeded');
  assert.deepEqual(
    [
      first.answers[1].result.outcome,
      first.answers[1].result.reason,
      first.answers[1].result.googleReason,
    ],
    ['failed', 'not-found', 'Device not found.'],
  );
  const second = await reader.changeDeviceStatus(
    credential,
    domain.customerId,
    [{ deviceId: device.deviceId, action: 'disable' }],
    AbortSignal.timeout(timeout),
  );
  assert.deepEqual(
    [second.answers[0].result.outcome, second.answers[0].result.reason],
    ['failed', 'status-conflict'],
  );
  assert.match(
    second.answers[0].result.googleReason,
    /does not allow this action/,
  );
  const reenabled = await reader.changeDeviceStatus(
    credential,
    domain.customerId,
    [{ deviceId: device.deviceId, action: 'reenable' }],
    AbortSignal.timeout(timeout),
  );
  assert.equal(reenabled.answers[0].result.outcome, 'succeeded');
});

test('a status change of 51 devices splits into parts of 50 and 1', async () => {
  const ids = inventory
    .filter((entry) => entry.status === 'ACTIVE')
    .slice(0, 51)
    .map((entry) => entry.deviceId);
  assert.equal(ids.length, 51);
  const result = await reader.changeDeviceStatus(
    credential,
    domain.customerId,
    ids.map((deviceId) => ({ deviceId, action: 'disable' })),
    AbortSignal.timeout(timeout),
  );
  assert.deepEqual(
    result.parts.map((part) => part.deviceIds.length),
    [50, 1],
  );
  assert.equal(result.answers.length, 51);
  assert.deepEqual(
    result.answers.flatMap((answer) =>
      answer.result?.outcome === 'succeeded' ? [] : [answer.deviceId],
    ),
    [],
  );
});

test('the mock releases every listener', async () => {
  const ports = [mock.googleUrl, mock.controlUrl, mock.proxyUrl]
    .filter(Boolean)
    .map((url) => Number(new URL(url).port));
  await mock.close();
  for (const port of ports) await assertRefused(port);
});
