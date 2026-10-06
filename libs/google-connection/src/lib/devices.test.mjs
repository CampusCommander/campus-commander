import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { JWT, OAuth2Client } from 'google-auth-library';
import { GoogleDeviceReader, parseBatchResponse } from './devices.ts';

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

const multipart = { 'content-type': 'multipart/mixed; boundary=batch_response' };

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
    if (next && next.__multipart)
      return { data: next.body, headers: multipart, status: 200 };
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

const part = (id, status, body) =>
  [
    `--batch_response`,
    'Content-Type: application/http',
    `Content-ID: <response-item-${id}>`,
    '',
    `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(body),
    '',
  ].join('\r\n');
const batchBody = (parts) => `${parts.join('\r\n')}\r\n--batch_response--\r\n`;

test('parseBatchResponse splits parts by content id and status', () => {
  const parsed = parseBatchResponse(
    multipart['content-type'],
    batchBody([part('d1', 200, { deviceId: 'd1' }), part('d2', 404, { error: { code: 404 } })]),
  );
  assert.deepEqual(parsed, [
    { contentId: 'd1', status: 200, body: { deviceId: 'd1' } },
    { contentId: 'd2', status: 404, body: { error: { code: 404 } } },
  ]);
});

test('deviceBatch reads each device once and reports missing devices', async (t) => {
  const { calls, scopes } = stub(t, [
    {
      __multipart: true,
      body: batchBody([
        part('d1', 200, { deviceId: 'd1', serialNumber: 'C0A1-7F2D', orgUnitPath: '/School A' }),
        part('d2', 404, { error: { code: 404, message: 'Resource Not Found' } }),
      ]),
    },
  ]);
  const result = await new GoogleDeviceReader().deviceBatch(
    credential,
    'C0123456',
    ['d1', 'd2'],
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(scopes, [deviceScope]);
  assert.equal(calls[0].url, 'https://www.googleapis.com/batch/admin/directory_v1');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].headers['content-type'], /^multipart\/mixed; boundary=/);
  assert.match(calls[0].body, /GET \/admin\/directory\/v1\/customer\/C0123456\/devices\/chromeos\/d1\?projection=FULL/);
  assert.match(calls[0].body, /Content-ID: <item-d2>/);
  assert.deepEqual(result.devices.map((device) => device.serialNumber), ['C0A1-7F2D']);
  assert.deepEqual(result.missing, ['d2']);
});

test('deviceBatch maps a quota part to a quota failure', async (t) => {
  stub(t, [
    {
      __multipart: true,
      body: batchBody([
        part('d1', 403, { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } }),
      ]),
    },
  ]);
  await assert.rejects(
    new GoogleDeviceReader().deviceBatch(credential, 'C0123456', ['d1'], AbortSignal.timeout(5000)),
    (error) => error.code === 'quota',
  );
});

test('deviceBatch fails the batch on any other part error', async (t) => {
  // failure() maps a plain 403 to permission-denied. If it maps differently, assert that code.
  stub(t, [
    {
      __multipart: true,
      body: batchBody([part('d1', 403, { error: { code: 403, errors: [{ reason: 'forbidden' }] } })]),
    },
  ]);
  await assert.rejects(
    new GoogleDeviceReader().deviceBatch(credential, 'C0123456', ['d1'], AbortSignal.timeout(5000)),
    (error) => error.code === 'permission-denied',
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
