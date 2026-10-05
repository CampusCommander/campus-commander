import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { JWT, OAuth2Client } from 'google-auth-library';
import { GoogleDeviceReader } from './devices.ts';

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
