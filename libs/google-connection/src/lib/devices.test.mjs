import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { JWT, OAuth2Client } from 'google-auth-library';
import { GoogleDeviceReader } from './devices.ts';
import { GoogleBatchService } from './batch.ts';
import { fakeGoogle } from './batch-fake.mjs';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
});
const credential = {
  subject: 'fixture@example.invalid',
  serviceAccount: {
    client_email: 'fixture@project.iam.gserviceaccount.com',
    private_key: privateKey,
    private_key_id: 'fixture',
  },
};
const deviceScope =
  'https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly';
const telemetryScope =
  'https://www.googleapis.com/auth/chrome.management.telemetry.readonly';

function stub(t, pages) {
  const calls = [];
  const scopes = [];
  t.mock.method(JWT.prototype, 'getAccessToken', async function () {
    scopes.push(...this.scopes);
    return { token: 'private-fixture-token' };
  });
  t.mock.method(JWT.prototype, 'getTokenInfo', async function () {
    return { scopes: [...this.scopes], expiry_date: Date.now() + 3_500_000 };
  });
  t.mock.method(OAuth2Client.prototype, 'request', async (options) => {
    calls.push(options);
    const next = pages.shift();
    if (next instanceof Error || (next && next.response)) throw next;
    return { data: next };
  });
  return { calls, scopes };
}

async function collect(iterable) {
  const pages = [];
  for await (const page of iterable) pages.push(page);
  return pages;
}

test('device pages follow page tokens and normalize fields', async (t) => {
  const { calls, scopes } = stub(t, [
    {
      nextPageToken: 'page-2',
      chromeosdevices: [
        {
          deviceId: 'd1',
          serialNumber: 'C0A1-7F2D',
          model: 'Lenovo 100e Gen 4',
          annotatedAssetId: 'HS-0417',
          orgUnitPath: '/School A',
          lastSync: '2026-09-05T14:28:12.345Z',
          annotatedLocation: 'Science wing',
          notes: '  ',
          status: 'ACTIVE',
        },
      ],
    },
    { chromeosdevices: [{ deviceId: 'd2', orgUnitPath: '/' }] },
  ]);
  const pages = await collect(
    new GoogleDeviceReader().devicePages(
      credential,
      'C0123456',
      AbortSignal.timeout(5000),
    ),
  );
  assert.deepEqual(scopes, [deviceScope]);
  assert.equal(
    calls[0].url,
    'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/devices/chromeos',
  );
  assert.equal(calls[0].params.maxResults, 300);
  assert.equal(calls[0].params.projection, 'FULL');
  assert.equal(calls[0].params.pageToken, undefined);
  assert.equal(calls[1].params.pageToken, 'page-2');
  assert.deepEqual(pages[0][0], {
    deviceId: 'd1',
    serialNumber: 'C0A1-7F2D',
    model: 'Lenovo 100e Gen 4',
    assetTag: 'HS-0417',
    orgUnitPath: '/School A',
    lastContact: '2026-09-05T14:28:12.345Z',
    annotatedLocation: 'Science wing',
    notes: null,
    status: 'ACTIVE',
  });
  assert.deepEqual(pages[1][0], {
    deviceId: 'd2',
    serialNumber: '',
    model: null,
    assetTag: null,
    orgUnitPath: '/',
    lastContact: null,
    annotatedLocation: null,
    notes: null,
    status: null,
  });
});

test('battery pages use the latest classified report and design capacity', async (t) => {
  const reports = Array.from({ length: 32 }, (_, index) => ({
    reportTime: new Date(
      Date.UTC(2026, 8, 1) + index * 86_400_000,
    ).toISOString(),
    fullChargeCapacity: String(4000 - index * 10),
    batteryHealth: 'BATTERY_REPLACE_SOON',
  }));
  const { calls, scopes } = stub(t, [
    {
      devices: [
        {
          deviceId: 'd1',
          batteryInfo: [{ designCapacity: '5000' }],
          batteryStatusReport: reports,
        },
        { deviceId: 'd2' },
        {
          deviceId: 'd3',
          batteryInfo: [{ designCapacity: '5000' }],
          batteryStatusReport: [
            {
              reportTime: '2026-09-05T13:50:00Z',
              fullChargeCapacity: '3900',
              batteryHealth: 'BATTERY_HEALTH_UNSPECIFIED',
            },
          ],
        },
        { serialNumber: 'no-device-id' },
      ],
    },
  ]);
  const [page] = await collect(
    new GoogleDeviceReader().batteryPages(
      credential,
      'C0123456',
      AbortSignal.timeout(5000),
    ),
  );
  assert.deepEqual(scopes, [telemetryScope]);
  assert.equal(
    calls[0].url,
    'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices',
  );
  assert.equal(
    calls[0].params.readMask,
    'deviceId,batteryInfo,batteryStatusReport',
  );
  assert.equal(page.length, 3);
  assert.deepEqual(page[0].battery, {
    status: 'reported',
    health: 'replace-soon',
    capacityPercent: 74,
    reportedAt: reports[31].reportTime,
  });
  assert.equal(page[0].reports.length, 30);
  assert.equal(page[0].reports[0].reportedAt, reports[31].reportTime);
  assert.deepEqual(page[1], {
    deviceId: 'd2',
    battery: { status: 'no-report' },
    reports: [],
  });
  assert.deepEqual(page[2].battery, { status: 'no-report' });
  assert.equal(page[2].reports[0].capacityPercent, 78);
});

test('provider failures keep their classified codes', async (t) => {
  stub(t, [
    {
      response: {
        status: 403,
        data: { error: { errors: [{ reason: 'forbidden' }] } },
      },
    },
  ]);
  await assert.rejects(
    collect(
      new GoogleDeviceReader().devicePages(
        credential,
        'C0123456',
        AbortSignal.timeout(5000),
      ),
    ),
    { name: 'GoogleConnectionError', code: 'permission-denied' },
  );
});

test('malformed pages fail as invalid responses', async (t) => {
  stub(t, [
    { chromeosdevices: [{ deviceId: 'd1', orgUnitPath: 'missing-slash' }] },
  ]);
  await assert.rejects(
    collect(
      new GoogleDeviceReader().devicePages(
        credential,
        'C0123456',
        AbortSignal.timeout(5000),
      ),
    ),
    { name: 'GoogleConnectionError', code: 'invalid-response' },
  );
});

test('device pages allow long notes across a full page', async (t) => {
  t.mock.method(JWT.prototype, 'getAccessToken', async () => ({
    token: 'private-fixture-token',
  }));
  t.mock.method(JWT.prototype, 'getTokenInfo', async function () {
    return { scopes: [...this.scopes], expiry_date: Date.now() + 3_500_000 };
  });
  const transporter = Object.getPrototypeOf(new OAuth2Client().transporter);
  const limits = [];
  t.mock.method(transporter, 'request', async (options) => {
    limits.push(options.maxContentLength);
    return { data: { chromeosdevices: [] }, status: 200, headers: {} };
  });
  await collect(
    new GoogleDeviceReader().devicePages(
      credential,
      'C0123456',
      AbortSignal.timeout(5000),
    ),
  );
  assert.equal(limits.length, 1);
  assert.ok(limits[0] >= 4 * 1024 * 1024, `limit ${limits[0]}`);
});

const fastBatch = () => new GoogleBatchService({ sleep: async () => undefined, random: () => 0 });
const signal = () => AbortSignal.timeout(5000);

function stubBatch(t, answer, options) {
  const google = fakeGoogle(answer, options);
  const scopes = [];
  t.mock.method(JWT.prototype, 'getAccessToken', async function () {
    scopes.push(...this.scopes);
    return { token: 'private-fixture-token' };
  });
  t.mock.method(JWT.prototype, 'getTokenInfo', async function () {
    return { scopes: [...this.scopes], expiry_date: Date.now() + 3_500_000 };
  });
  t.mock.method(OAuth2Client.prototype, 'request', (options) => google.client.request(options));
  return { google, scopes };
}

const directoryDevice = (id) => ({
  status: 200,
  body: { deviceId: id, serialNumber: `S-${id}`, orgUnitPath: '/School A' },
});
const quotaPart = {
  status: 403,
  body: { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } },
};

test('deviceBatch reads each device once and reports missing devices', async (t) => {
  const { google, scopes } = stubBatch(t, (part) =>
    part.key === 'd2'
      ? { status: 404, body: { error: { code: 404, message: 'Resource Not Found' } } }
      : directoryDevice(part.key),
  );
  const result = await new GoogleDeviceReader({ batch: fastBatch() }).deviceBatch(
    credential,
    'C0123456',
    ['d1', 'd2', 'd1'],
    signal(),
  );
  assert.deepEqual(scopes, [deviceScope]);
  assert.equal(google.requests[0].url, 'https://www.googleapis.com/batch/admin/directory_v1');
  assert.deepEqual(
    google.sent[0].map((part) => [part.method, part.path, part.query.projection]),
    [
      ['GET', '/admin/directory/v1/customer/C0123456/devices/chromeos/d1', 'FULL'],
      ['GET', '/admin/directory/v1/customer/C0123456/devices/chromeos/d2', 'FULL'],
    ],
  );
  assert.match(google.sent[0][0].query.fields, /^deviceId,serialNumber,/);
  assert.deepEqual(result.devices.map((device) => device.serialNumber), ['S-d1']);
  assert.deepEqual(result.missing, ['d2']);
});

test('deviceBatch retries a quota part and keeps the parts that succeeded', async (t) => {
  let throttled = false;
  const { google } = stubBatch(t, (part) => {
    if (part.key === 'd1' && !throttled) {
      throttled = true;
      return quotaPart;
    }
    return directoryDevice(part.key);
  });
  const result = await new GoogleDeviceReader({ batch: fastBatch() }).deviceBatch(
    credential,
    'C0123456',
    ['d1', 'd2'],
    signal(),
  );
  assert.deepEqual(google.keys(), [['d1', 'd2'], ['d1']]);
  assert.deepEqual(result.devices.map((device) => device.deviceId), ['d1', 'd2']);
});

test('deviceBatch fails with quota after 25 quota retries', async (t) => {
  const { google } = stubBatch(t, () => quotaPart);
  await assert.rejects(
    new GoogleDeviceReader({ batch: fastBatch() }).deviceBatch(credential, 'C0123456', ['d1'], signal()),
    { name: 'GoogleConnectionError', code: 'quota' },
  );
  assert.equal(google.sent.length, 26);
});

test('deviceBatch maps a malformed batch answer to invalid-response', async (t) => {
  stubBatch(t, () => quotaPart, {
    outer: () => ({ status: 200, headers: { 'content-type': 'text/html' }, data: '<html>' }),
  });
  await assert.rejects(
    new GoogleDeviceReader({ batch: fastBatch() }).deviceBatch(credential, 'C0123456', ['d1'], signal()),
    { name: 'GoogleConnectionError', code: 'invalid-response' },
  );
});

test('deviceBatch surfaces a shutdown during a quota wait as network-failure', async (t) => {
  const stopping = new AbortController();
  stubBatch(t, () => {
    stopping.abort();
    return quotaPart;
  });
  await assert.rejects(
    new GoogleDeviceReader({ batch: fastBatch() }).deviceBatch(credential, 'C0123456', ['d1'], stopping.signal),
    { name: 'GoogleConnectionError', code: 'network-failure' },
  );
});

test('deviceBatch fails the batch on any other part error', async (t) => {
  stubBatch(t, (part) =>
    part.key === 'd2'
      ? { status: 403, body: { error: { code: 403, errors: [{ reason: 'forbidden' }] } } }
      : directoryDevice(part.key),
  );
  await assert.rejects(
    new GoogleDeviceReader({ batch: fastBatch() }).deviceBatch(credential, 'C0123456', ['d1', 'd2'], signal()),
    { name: 'GoogleConnectionError', code: 'permission-denied' },
  );
});

test('deviceBatch reports each round to the caller', async (t) => {
  let throttled = false;
  stubBatch(t, (part) => {
    if (!throttled) {
      throttled = true;
      return quotaPart;
    }
    return directoryDevice(part.key);
  });
  let rounds = 0;
  await new GoogleDeviceReader({ batch: fastBatch() }).deviceBatch(
    credential,
    'C0123456',
    ['d1'],
    signal(),
    async () => {
      rounds += 1;
    },
  );
  assert.equal(rounds, 2);
});

test('deviceBatch surfaces a token failure with its own code', async (t) => {
  t.mock.method(JWT.prototype, 'getAccessToken', async () => {
    throw Object.assign(new Error('invalid_grant'), {
      response: { status: 400, data: { error: 'invalid_grant' } },
    });
  });
  await assert.rejects(
    new GoogleDeviceReader({ batch: fastBatch() }).deviceBatch(credential, 'C0123456', ['d1'], signal()),
    { name: 'GoogleConnectionError', code: 'credential-rejected' },
  );
});

test('batteryBatch reads one telemetry record per device and treats 404 as no report', async (t) => {
  const missing = new Error('not found');
  missing.response = { status: 404, data: { error: { code: 404 } } };
  const { calls, scopes } = stub(t, [
    {
      deviceId: 'd1',
      batteryInfo: [{ designCapacity: '5000' }],
      batteryStatusReport: [
        { reportTime: '2026-10-05T13:50:00.000Z', fullChargeCapacity: '3900', batteryHealth: 'BATTERY_REPLACE_SOON' },
      ],
    },
    missing,
  ]);
  const result = await new GoogleDeviceReader().batteryBatch(
    credential,
    'C0123456',
    ['d1', 'd2'],
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(scopes, [telemetryScope]);
  assert.deepEqual(
    calls.map((call) => call.url).sort(),
    [
      'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices/d1',
      'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices/d2',
    ],
  );
  assert.deepEqual(
    result.map((observation) => [observation.deviceId, observation.battery.status]),
    [['d1', 'reported'], ['d2', 'no-report']],
  );
});

test('batteryBatch stops issuing reads after the first hard failure', async (t) => {
  const forbidden = new Error('forbidden');
  forbidden.response = { status: 403, data: { error: { errors: [{ reason: 'forbidden' }] } } };
  const ids = Array.from({ length: 8 }, (_, index) => `d${index + 1}`);
  const { calls } = stub(t, [forbidden, ...ids.slice(1).map((deviceId) => ({ deviceId }))]);
  await assert.rejects(
    new GoogleDeviceReader().batteryBatch(credential, 'C0123456', ids, AbortSignal.timeout(5000)),
    { name: 'GoogleConnectionError', code: 'permission-denied' },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 4, 'Only the reads already in flight finish.');
});

const quotaAnswer = () =>
  Object.assign(new Error('quota'), {
    response: { status: 429, data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } },
  });

test('a quota answer retries the same page until Google answers', async (t) => {
  const { calls } = stub(t, [
    { nextPageToken: 'page-2', chromeosdevices: [{ deviceId: 'd1', orgUnitPath: '/' }] },
    quotaAnswer(),
    quotaAnswer(),
    { chromeosdevices: [{ deviceId: 'd2', orgUnitPath: '/' }] },
  ]);
  const waits = [];
  const pages = await collect(
    new GoogleDeviceReader({
      backoff: (attempt) => attempt * 10,
      sleep: async (milliseconds) => void waits.push(milliseconds),
    }).devicePages(credential, 'C0123456', AbortSignal.timeout(5000)),
  );
  assert.deepEqual(
    pages.map((page) => page.map((device) => device.deviceId)),
    [['d1'], ['d2']],
  );
  assert.deepEqual(waits, [0, 10]);
  assert.deepEqual(
    calls.slice(1).map((call) => call.params.pageToken),
    ['page-2', 'page-2', 'page-2'],
  );
});

test('a quota page stops after 25 retries', async (t) => {
  const { calls } = stub(t, Array.from({ length: 27 }, () => quotaAnswer()));
  const waits = [];
  await assert.rejects(
    collect(
      new GoogleDeviceReader({
        backoff: () => 0,
        sleep: async (milliseconds) => void waits.push(milliseconds),
      }).devicePages(credential, 'C0123456', AbortSignal.timeout(5000)),
    ),
    { name: 'GoogleConnectionError', code: 'quota' },
  );
  assert.equal(calls.length, 26);
  assert.equal(waits.length, 25);
});

test('an abort during a quota wait rejects with quota', async (t) => {
  stub(t, [quotaAnswer()]);
  const stopping = new AbortController();
  await assert.rejects(
    collect(
      new GoogleDeviceReader({
        backoff: () => 60_000,
        sleep: async () => stopping.abort(),
      }).devicePages(credential, 'C0123456', stopping.signal),
    ),
    { name: 'GoogleConnectionError', code: 'quota' },
  );
});

test('the default quota wait ends when the signal aborts', async (t) => {
  stub(t, [quotaAnswer()]);
  const stopping = new AbortController();
  const started = Date.now();
  setTimeout(() => stopping.abort(), 20);
  await assert.rejects(
    collect(
      new GoogleDeviceReader({ backoff: () => 60_000 }).devicePages(
        credential,
        'C0123456',
        stopping.signal,
      ),
    ),
    { name: 'GoogleConnectionError', code: 'quota' },
  );
  assert.ok(Date.now() - started < 5_000);
});

test('other page failures do not retry', async (t) => {
  const forbidden = Object.assign(new Error('forbidden'), {
    response: { status: 403, data: { error: { errors: [{ reason: 'forbidden' }] } } },
  });
  const { calls } = stub(t, [forbidden]);
  let slept = false;
  await assert.rejects(
    collect(
      new GoogleDeviceReader({
        sleep: async () => {
          slept = true;
        },
      }).devicePages(credential, 'C0123456', AbortSignal.timeout(5000)),
    ),
    { name: 'GoogleConnectionError', code: 'permission-denied' },
  );
  assert.equal(calls.length, 1);
  assert.equal(slept, false);
});
