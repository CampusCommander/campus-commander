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
    [{ deviceId: early.deviceId, commandId: command.commandId }],
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

/** The reason every Deprovision call of this file sends. One job holds one reason (D11). */
const deprovisionReason = 'DEPROVISION_REASON_RETIRING_DEVICE';

/** The devices the Deprovision test moved, for the conflict test that follows it. */
let deprovisioned = [];

/** Read the live devices, so a status change of an earlier test cannot stale a choice. */
async function currentDevices() {
  return collect(
    reader.devicePages(
      credential,
      domain.customerId,
      AbortSignal.timeout(timeout),
    ),
  );
}

/**
 * Devices of one status, confirmed by a direct read.
 * A list read lags a write by the mock's search delay, so only a direct read is current.
 */
async function liveDevices(status, count, keep = () => true, pool = 60) {
  const candidates = (await currentDevices())
    .filter((device) => device.status === status && keep(device))
    .slice(0, pool);
  assert.ok(candidates.length > 0, `the list offers a ${status} candidate`);
  const { devices } = await reader.deviceBatch(
    credential,
    domain.customerId,
    candidates.map((device) => device.deviceId),
    AbortSignal.timeout(timeout),
  );
  const found = devices.filter((device) => device.status === status);
  assert.ok(
    found.length >= count,
    `the domain holds ${count} ${status} device(s)`,
  );
  return found.slice(0, count);
}

/**
 * Read one device with an unmodified Google client, so the answer comes from the mock.
 * The device observation drops the deprovision reason, so a raw read proves what Google stored.
 */
async function rawDevice(deviceId) {
  const auth = new JWT({
    email: credential.serviceAccount.client_email,
    key: credential.serviceAccount.private_key,
    keyId: credential.serviceAccount.private_key_id,
    scopes: [readerScopes[0]],
    subject: credential.subject,
  });
  const { data } = await auth.request({
    url: `https://admin.googleapis.com/admin/directory/v1/customer/${encodeURIComponent(domain.customerId)}/devices/chromeos/${encodeURIComponent(deviceId)}`,
    method: 'GET',
    params: { projection: 'FULL' },
    retry: false,
  });
  return data;
}

test('deprovision moves an active and a disabled device, and each device answers the reason', async () => {
  const [active] = await liveDevices('ACTIVE', 1);
  const [disabled] = await liveDevices('DISABLED', 1);
  const targets = [active.deviceId, disabled.deviceId];
  const result = await reader.changeDeviceStatus(
    credential,
    domain.customerId,
    targets.map((deviceId) => ({
      deviceId,
      action: 'deprovision',
      deprovisionReason,
    })),
    AbortSignal.timeout(timeout),
  );
  assert.deepEqual(
    result.parts.map((part) => [part.action, part.deprovisionReason]),
    [['deprovision', deprovisionReason]],
    'Both devices travel in one part under one reason.',
  );
  assert.deepEqual(
    result.answers.map((answer) => [
      answer.deviceId,
      answer.result?.outcome,
      answer.result?.reason,
    ]),
    targets.map((deviceId) => [deviceId, 'succeeded', null]),
  );
  const { devices: moved } = await reader.deviceBatch(
    credential,
    domain.customerId,
    targets,
    AbortSignal.timeout(timeout),
  );
  assert.deepEqual(
    moved.map((device) => [device.deviceId, device.status]),
    targets.map((deviceId) => [deviceId, 'DEPROVISIONED']),
    'An active device and a disabled device both reach DEPROVISIONED.',
  );
  for (const deviceId of targets) {
    const stored = await rawDevice(deviceId);
    assert.equal(stored.status, 'DEPROVISIONED', deviceId);
    assert.equal(
      stored.deprovisionReason,
      deprovisionReason,
      `${deviceId} answers the reason the part carried`,
    );
  }
  deprovisioned = targets;
});

test('a second deprovision and a re-enable of a deprovisioned device answer status-conflict', async () => {
  assert.equal(
    deprovisioned.length,
    2,
    'the Deprovision test moved two devices',
  );
  const [deviceId] = deprovisioned;
  const second = await reader.changeDeviceStatus(
    credential,
    domain.customerId,
    [{ deviceId, action: 'deprovision', deprovisionReason }],
    AbortSignal.timeout(timeout),
  );
  assert.deepEqual(
    [second.answers[0].result.outcome, second.answers[0].result.reason],
    ['failed', 'status-conflict'],
  );
  assert.match(
    second.answers[0].result.googleReason,
    /DEPROVISIONED does not allow this action/,
  );
  const reenabled = await reader.changeDeviceStatus(
    credential,
    domain.customerId,
    [{ deviceId, action: 'reenable' }],
    AbortSignal.timeout(timeout),
  );
  assert.deepEqual(
    [reenabled.answers[0].result.outcome, reenabled.answers[0].result.reason],
    ['failed', 'status-conflict'],
  );
  assert.match(
    reenabled.answers[0].result.googleReason,
    /DEPROVISIONED does not allow this action/,
  );
});

test('wipe user data and powerwash issue and poll through their states', async () => {
  const now = Date.now();
  const [wipe, powerwash] = await liveDevices(
    'ACTIVE',
    2,
    (device) =>
      device.lastContact !== null &&
      now - Date.parse(device.lastContact) <= 24 * 3_600_000,
    400,
  );
  const commands = [
    { device: wipe, commandType: 'WIPE_USERS' },
    { device: powerwash, commandType: 'REMOTE_POWERWASH' },
  ];
  // The mock refuses a payload for either type, so a 2xx answer proves the part sent none.
  await mock.control('PUT', '/clock', { scale: 20 });
  try {
    const issued = await reader.issueDeviceCommands(
      credential,
      domain.customerId,
      commands.map(({ device, commandType }) => ({
        deviceId: device.deviceId,
        commandType,
      })),
      AbortSignal.timeout(timeout),
    );
    for (const { device, commandType } of commands) {
      const [command] = issued.succeeded.get(device.deviceId) ?? [];
      assert.ok(command, `${commandType} was issued to ${device.deviceId}`);
      assert.match(command.commandId, /^\d{1,20}$/);
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
          [{ deviceId: device.deviceId, commandId: command.commandId }],
          AbortSignal.timeout(timeout),
        );
        observed = polled.succeeded.get(device.deviceId)[0];
        states.push(observed.state);
      } while (
        !['EXECUTED_BY_CLIENT', 'EXPIRED'].includes(observed.state) &&
        Date.now() - started < 10_000
      );
      let reached = 0;
      for (const state of states) {
        const next = order.indexOf(state);
        assert.ok(next >= 0, `${commandType} reports a known state: ${state}`);
        assert.ok(
          next >= reached,
          `${commandType} states advance in order: ${states.join(', ')}`,
        );
        reached = next;
      }
      assert.equal(
        observed.state,
        'EXECUTED_BY_CLIENT',
        `${commandType} executed after ${states.join(', ')}`,
      );
      assert.equal(observed.commandId, command.commandId);
      assert.ok(
        observed.expiresAt,
        `${commandType} carries the provider expiry`,
      );
      assert.ok(observed.executedAt);
      assert.ok(['SUCCESS', 'FAILURE'].includes(observed.result));
    }
  } finally {
    await mock.control('PUT', '/clock', { scale: 1 });
  }
});

test('one PATCH sets three annotations and moves the device', async () => {
  const device = inventory.find((entry) => entry.status === 'ACTIVE');
  assert.ok(device, 'the seed holds an active device');
  const destination = inventory.find(
    (entry) => entry.orgUnitPath !== device.orgUnitPath,
  );
  assert.ok(destination, 'the seed holds a second organization unit');
  const fields = {
    annotatedLocation: 'Room 214',
    annotatedUser: 'avery.chen@example.org',
    notes: 'Assigned to the science wing.',
    orgUnitPath: destination.orgUnitPath,
  };
  const patches = [];
  const result = await reader.patchDevices(
    credential,
    domain.customerId,
    [{ deviceId: device.deviceId, fields }],
    AbortSignal.timeout(timeout),
    {
      onResponse: (event) => {
        if (event.outcome.kind === 'success')
          patches.push({
            method: event.request.method,
            body: event.request.body,
          });
      },
    },
  );
  assert.deepEqual(
    patches,
    [{ method: 'PATCH', body: fields }],
    'one PATCH carries every changed field',
  );
  const [written] = result.succeeded.get(device.deviceId);
  assert.deepEqual(
    {
      annotatedLocation: written.annotatedLocation,
      annotatedUser: written.annotatedUser,
      notes: written.notes,
      orgUnitPath: written.orgUnitPath,
    },
    fields,
    'the answer maps through the device observation',
  );
  const { devices } = await reader.deviceBatch(
    credential,
    domain.customerId,
    [device.deviceId],
    AbortSignal.timeout(timeout),
  );
  assert.deepEqual(
    {
      annotatedLocation: devices[0].annotatedLocation,
      annotatedUser: devices[0].annotatedUser,
      notes: devices[0].notes,
      orgUnitPath: devices[0].orgUnitPath,
    },
    fields,
    'a later read shows every written field',
  );
});

test('a PATCH with null clears a field', async () => {
  const device = inventory.filter((entry) => entry.status === 'ACTIVE')[1];
  assert.ok(device, 'the seed holds a second active device');
  const set = await reader.patchDevices(
    credential,
    domain.customerId,
    [{ deviceId: device.deviceId, fields: { notes: 'Cart 12' } }],
    AbortSignal.timeout(timeout),
  );
  assert.equal(set.succeeded.get(device.deviceId)[0].notes, 'Cart 12');
  const cleared = await reader.patchDevices(
    credential,
    domain.customerId,
    [{ deviceId: device.deviceId, fields: { notes: null } }],
    AbortSignal.timeout(timeout),
  );
  assert.equal(cleared.succeeded.get(device.deviceId)[0].notes, null);
  const { devices } = await reader.deviceBatch(
    credential,
    domain.customerId,
    [device.deviceId],
    AbortSignal.timeout(timeout),
  );
  assert.equal(devices[0].notes, null, 'the stored value is cleared');
});

test('a refused PATCH changes no field', async () => {
  const device = inventory.filter((entry) => entry.status === 'ACTIVE')[2];
  assert.ok(device, 'the seed holds a third active device');
  const read = async () => {
    const { devices } = await reader.deviceBatch(
      credential,
      domain.customerId,
      [device.deviceId],
      AbortSignal.timeout(timeout),
    );
    return devices[0];
  };
  const before = await read();

  const longNotes = await reader.patchDevices(
    credential,
    domain.customerId,
    [
      {
        deviceId: device.deviceId,
        fields: { annotatedLocation: 'Room 999', notes: 'x'.repeat(501) },
      },
    ],
    AbortSignal.timeout(timeout),
  );
  const notesFailure = longNotes.failed.get(device.deviceId);
  assert.ok(notesFailure, 'the part failed');
  assert.deepEqual(
    [notesFailure.kind, notesFailure.status],
    ['rejected', 400],
    'Notes over 500 answers 400',
  );
  assert.equal(longNotes.succeeded.size, 0);

  const unknownUnit = await reader.patchDevices(
    credential,
    domain.customerId,
    [
      {
        deviceId: device.deviceId,
        fields: {
          annotatedLocation: 'Room 998',
          orgUnitPath: '/No Such Unit',
        },
      },
    ],
    AbortSignal.timeout(timeout),
  );
  const unitFailure = unknownUnit.failed.get(device.deviceId);
  assert.ok(unitFailure, 'the part failed');
  assert.deepEqual(
    [unitFailure.kind, unitFailure.status],
    ['rejected', 400],
    'An unknown organization unit answers 400',
  );

  assert.deepEqual(await read(), before, 'a refused PATCH changes no field');
});

test('the mock releases every listener', async () => {
  const ports = [mock.googleUrl, mock.controlUrl, mock.proxyUrl]
    .filter(Boolean)
    .map((url) => Number(new URL(url).port));
  await mock.close();
  for (const port of ports) await assertRefused(port);
});
