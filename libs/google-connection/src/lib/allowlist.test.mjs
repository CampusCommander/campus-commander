import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { JWT, OAuth2Client } from 'google-auth-library';
import {
  googleRequestAllowed,
  googlePartAllowed,
  scopedClient,
} from './provider.ts';
import { validateRequests } from './batch.ts';

const allowed = [
  'https://oauth2.googleapis.com/token',
  'https://oauth2.googleapis.com/tokeninfo',
  'https://admin.googleapis.com/admin/directory/v1/customers/my_customer',
  'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/domains',
  'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/orgunits',
  'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/devices/chromeos',
  'https://www.googleapis.com/batch/admin/directory_v1',
  'https://www.googleapis.com/drive/v3/files',
  'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices',
  'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices/abc-123_DEF',
];
const rejected = [
  'https://www.googleapis.com/batch/admin/directory_v1/extra',
  'https://www.googleapis.com/batch/other/v1',
  'https://www.googleapis.com/drive/v3/files/abc',
  'https://www.googleapis.com/drive/v3/files/',
  'http://www.googleapis.com/drive/v3/files',
  'https://evil.example/drive/v3/files',
  'http://www.googleapis.com/batch/admin/directory_v1',
  'https://evil.example/batch/admin/directory_v1',
  'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices/a/b',
  'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices/',
  `https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices/${'a'.repeat(129)}`,
  'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/devices/chromeos/abc',
];

/** The batch part shapes the repository builds, with the three command and status shapes. */
const allowedParts = [
  ['GET', '/admin/directory/v1/customer/C0123456/orgunits/id:03ph8a2z1'],
  ['GET', '/admin/directory/v1/customer/C0123456/devices/chromeos/d1'],
  ['PATCH', '/admin/directory/v1/customer/C0123456/devices/chromeos/d1'],
  [
    'POST',
    '/admin/directory/v1/customer/C0123456/devices/chromeos/d1:issueCommand',
  ],
  [
    'GET',
    '/admin/directory/v1/customer/C0123456/devices/chromeos/d1/commands/4100000001',
  ],
  [
    'POST',
    '/admin/directory/v1/customer/C0123456/devices/chromeos:batchChangeStatus',
  ],
];
const rejectedParts = [
  ['GET', '/admin/directory/v1/customer/C0123456/devices/chromeos'],
  [
    'GET',
    '/admin/directory/v1/customer/C0123456/devices/chromeos/d1/commands/abc',
  ],
  [
    'GET',
    '/admin/directory/v1/customer/C0123456/devices/chromeos/d1/commands/410000000123456789012',
  ],
  ['PUT', '/admin/directory/v1/customer/C0123456/devices/chromeos/d1'],
  ['DELETE', '/admin/directory/v1/customer/C0123456/devices/chromeos/d1'],
  ['POST', '/admin/directory/v1/customer/C0123456/devices/chromeos/d1'],
  ['POST', '/admin/directory/v1/customer/C0123456/devices/chromeos/d1:wipe'],
  [
    'GET',
    '/admin/directory/v1/customer/C0123456/devices/chromeos/d1:issueCommand',
  ],
  [
    'POST',
    '/admin/directory/v1/customer/C0123456/devices/chromeos/d1/commands/4100000001',
  ],
  ['GET', '/admin/directory/v1/users'],
  ['GET', '/admin/directory/v1/customer/C01/devices/chromeos/d1'],
  ['GET', '/admin/directory/v1/customer/C0123456/devices/chromeos/d1/'],
];

for (const url of allowed)
  test(`allows ${url}`, () => {
    assert.equal(googleRequestAllowed(new URL(url)), true);
  });

for (const url of rejected)
  test(`rejects ${url.slice(0, 120)}`, () => {
    assert.equal(googleRequestAllowed(new URL(url)), false);
  });

for (const [method, path] of allowedParts)
  test(`allows part ${method} ${path}`, () => {
    assert.equal(googlePartAllowed(method, path), true);
  });

for (const [method, path] of rejectedParts)
  test(`rejects part ${method} ${path}`, () => {
    assert.equal(googlePartAllowed(method, path), false);
  });

test('validateRequests refuses a part outside the allowlist', () => {
  validateRequests(
    allowedParts.map(([method, path], index) => ({
      id: `part-${index}`,
      method,
      path,
    })),
  );
  assert.throws(
    () =>
      validateRequests([
        { id: 'user', method: 'GET', path: '/admin/directory/v1/users' },
      ]),
    { name: 'BatchServiceError', code: 'invalid-request' },
  );
});

test('a scoped client reaches the transport for batch and per-device URLs only', async (t) => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
  const scope =
    'https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly';
  t.mock.method(JWT.prototype, 'getAccessToken', async () => ({
    token: 'private-fixture-token',
  }));
  t.mock.method(JWT.prototype, 'getTokenInfo', async function () {
    return { scopes: [...this.scopes], expiry_date: Date.now() + 3_500_000 };
  });
  const transporter = Object.getPrototypeOf(new OAuth2Client().transporter);
  const urls = [];
  t.mock.method(transporter, 'request', async (options) => {
    urls.push(options.url);
    return { data: '', status: 200, headers: {} };
  });
  const client = await scopedClient(
    {
      subject: 'fixture@example.invalid',
      serviceAccount: {
        client_email: 'fixture@project.iam.gserviceaccount.com',
        private_key: privateKey,
        private_key_id: 'fixture',
      },
    },
    scope,
    AbortSignal.timeout(5000),
  );
  await client.request({
    url: 'https://www.googleapis.com/batch/admin/directory_v1',
    method: 'POST',
  });
  await client.request({
    url: 'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices/d1',
  });
  assert.equal(urls.length, 2);
  await assert.rejects(
    async () =>
      client.request({
        url: 'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/devices/chromeos/abc',
      }),
    { code: 'request-failed' },
  );
  assert.equal(urls.length, 2);
});
