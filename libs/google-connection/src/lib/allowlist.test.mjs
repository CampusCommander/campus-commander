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
  'https://admin.googleapis.com/admin/directory/v1/users',
  'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/schemas',
  'https://www.googleapis.com/batch/admin/directory_v1',
  'https://www.googleapis.com/drive/v3/files',
  'https://www.googleapis.com/drive/v3/files/abc-123_DEF',
  'https://sheets.googleapis.com/v4/spreadsheets',
  'https://sheets.googleapis.com/v4/spreadsheets/fixture-spreadsheet',
  'https://sheets.googleapis.com/v4/spreadsheets/fixture-spreadsheet:batchUpdate',
  "https://sheets.googleapis.com/v4/spreadsheets/fixture-spreadsheet/values/'Devices'!A1%3AJ1000",
  'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices',
  'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices/abc-123_DEF',
];
const rejected = [
  'https://www.googleapis.com/batch/admin/directory_v1/extra',
  'https://www.googleapis.com/batch/other/v1',
  'https://www.googleapis.com/drive/v3/files/',
  'http://www.googleapis.com/drive/v3/files',
  'https://evil.example/drive/v3/files',
  'http://www.googleapis.com/batch/admin/directory_v1',
  'https://evil.example/batch/admin/directory_v1',
  'https://www.googleapis.com/drive/v3/files/abc/extra',
  'https://www.googleapis.com/drive/v3/files/a%2Fb',
  `https://www.googleapis.com/drive/v3/files/${'a'.repeat(129)}`,
  'https://sheets.googleapis.com/v5/spreadsheets/fixture-spreadsheet',
  'https://sheets.googleapis.com/v4/spreadsheets/',
  'http://sheets.googleapis.com/v4/spreadsheets/fixture-spreadsheet',
  'https://evil.example/v4/spreadsheets/fixture-spreadsheet',
  'https://sheets.googleapis.com/v4/spreadsheets/fixture-spreadsheet:batchUpdateExtra',
  'https://sheets.googleapis.com/v4/spreadsheets/fixture-spreadsheet:delete',
  'https://sheets.googleapis.com/v4/spreadsheets/fixture-spreadsheet/sheets',
  'https://sheets.googleapis.com/v4/spreadsheets/fixture-spreadsheet/values/',
  'https://sheets.googleapis.com/v4/spreadsheets/fixture-spreadsheet/values/a/b',
  'https://sheets.googleapis.com/v4/spreadsheets/fixture-spreadsheet/values/a%20%ZZ',
  'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices/a/b',
  'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices/',
  `https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices/${'a'.repeat(129)}`,
  'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/devices/chromeos/abc',
  'https://admin.googleapis.com/admin/directory/v1/users/u1',
  'http://admin.googleapis.com/admin/directory/v1/users',
  'https://evil.example/admin/directory/v1/users',
  'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/schemas/s1',
  'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/schemas/a/b',
  'https://admin.googleapis.com/admin/directory/v1/customer/C01/schemas',
  'http://admin.googleapis.com/admin/directory/v1/customer/C0123456/schemas',
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
  ['GET', '/admin/directory/v1/users/u1'],
  ['GET', '/admin/directory/v1/users/u%2F1'],
  ['PATCH', '/admin/directory/v1/users/u1'],
  ['PATCH', '/admin/directory/v1/users/u%2F1'],
  ['PUT', '/admin/directory/v1/users/u1'],
  ['PUT', '/admin/directory/v1/users/u%2F1'],
  ['GET', '/admin/directory/v1/customer/C0123456/schemas/SchemaName'],
  ['GET', '/admin/directory/v1/customer/C0123456/schemas/ab%2Fc%2Bd%3D%3D'],
  ['POST', '/admin/directory/v1/customer/C0123456/schemas'],
  ['PUT', '/admin/directory/v1/customer/C0123456/schemas/SchemaName'],
  ['PUT', '/admin/directory/v1/customer/C0123456/schemas/ab%2Fc%2Bd%3D%3D'],
  ['DELETE', '/admin/directory/v1/customer/C0123456/schemas/SchemaName'],
  ['DELETE', '/admin/directory/v1/customer/C0123456/schemas/ab%2Fc%2Bd%3D%3D'],
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
  ['GET', '/admin/directory/v1/users/u1/aliases'],
  ['PATCH', '/admin/directory/v1/users'],
  ['PATCH', '/admin/directory/v1/users/u1/aliases'],
  ['PATCH', '/admin/directory/v1/users/u1:signOut'],
  ['PUT', '/admin/directory/v1/users'],
  ['PUT', '/admin/directory/v1/users/u1/aliases'],
  ['PUT', '/admin/directory/v1/users/u1:signOut'],
  ['DELETE', '/admin/directory/v1/users/u1'],
  ['GET', '/admin/directory/v1/customer/C0123456/schemas'],
  ['GET', '/admin/directory/v1/customer/C0123456/schemas/'],
  ['GET', '/admin/directory/v1/customer/C0123456/schemas/a/b'],
  ['POST', '/admin/directory/v1/customer/C0123456/schemas/SchemaName'],
  ['POST', '/admin/directory/v1/customer/C0123456/schemas/'],
  ['PUT', '/admin/directory/v1/customer/C0123456/schemas'],
  ['PUT', '/admin/directory/v1/customer/C0123456/schemas/a/b'],
  ['PATCH', '/admin/directory/v1/customer/C0123456/schemas/SchemaName'],
  ['DELETE', '/admin/directory/v1/customer/C0123456/schemas'],
  ['DELETE', '/admin/directory/v1/customer/C0123456/schemas/'],
  ['DELETE', '/admin/directory/v1/customer/C0123456/schemas/a/b'],
  ['GET', '/admin/directory/v1/customer/C01/devices/chromeos/d1'],
  ['GET', '/admin/directory/v1/customer/C0123456/devices/chromeos/d1/'],
];

/** Each URL shape with a method it admits. Token exchange answers POST only. */
const allowedMethods = [
  ['https://oauth2.googleapis.com/token', 'POST'],
  ['https://oauth2.googleapis.com/tokeninfo', 'POST'],
  [
    'https://admin.googleapis.com/admin/directory/v1/customers/my_customer',
    'GET',
  ],
  [
    'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/domains',
    'GET',
  ],
  [
    'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/orgunits',
    'GET',
  ],
  [
    'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/devices/chromeos',
    'GET',
  ],
  ['https://admin.googleapis.com/admin/directory/v1/users', 'GET'],
  [
    'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/schemas',
    'GET',
  ],
  ['https://www.googleapis.com/batch/admin/directory_v1', 'POST'],
  ['https://www.googleapis.com/drive/v3/files', 'GET'],
  ['https://www.googleapis.com/drive/v3/files/abc-123_DEF', 'GET'],
  ['https://sheets.googleapis.com/v4/spreadsheets', 'POST'],
  ['https://sheets.googleapis.com/v4/spreadsheets/fixture-spreadsheet', 'GET'],
  [
    'https://sheets.googleapis.com/v4/spreadsheets/fixture-spreadsheet:batchUpdate',
    'POST',
  ],
  [
    "https://sheets.googleapis.com/v4/spreadsheets/fixture-spreadsheet/values/'Devices'!A1%3AJ1000",
    'GET',
  ],
  [
    "https://sheets.googleapis.com/v4/spreadsheets/fixture-spreadsheet/values/'Devices'!A1%3AJ1000",
    'PUT',
  ],
  [
    'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices',
    'GET',
  ],
];
/** A method each shape refuses. The two new collection shapes admit GET only. */
const refusedMethods = [
  ['https://oauth2.googleapis.com/token', 'GET'],
  ['https://oauth2.googleapis.com/tokeninfo', 'GET'],
  ['https://admin.googleapis.com/admin/directory/v1/users', 'POST'],
  ['https://admin.googleapis.com/admin/directory/v1/users', 'PUT'],
  ['https://admin.googleapis.com/admin/directory/v1/users', 'PATCH'],
  ['https://admin.googleapis.com/admin/directory/v1/users', 'DELETE'],
  // A user item is a batch part only, so no direct method reaches it.
  ['https://admin.googleapis.com/admin/directory/v1/users/u1', 'GET'],
  ['https://admin.googleapis.com/admin/directory/v1/users/u1', 'PATCH'],
  ['https://admin.googleapis.com/admin/directory/v1/users/u1', 'PUT'],
  [
    'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/schemas',
    'POST',
  ],
  [
    'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/schemas',
    'PUT',
  ],
  [
    'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/schemas',
    'PATCH',
  ],
  [
    'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/schemas',
    'DELETE',
  ],
  [
    'https://admin.googleapis.com/admin/directory/v1/customers/my_customer',
    'POST',
  ],
  [
    'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/devices/chromeos',
    'POST',
  ],
  ['https://www.googleapis.com/batch/admin/directory_v1', 'GET'],
  ['https://www.googleapis.com/drive/v3/files', 'POST'],
  ['https://www.googleapis.com/drive/v3/files/abc-123_DEF', 'DELETE'],
  ['https://sheets.googleapis.com/v4/spreadsheets', 'GET'],
  [
    'https://sheets.googleapis.com/v4/spreadsheets/fixture-spreadsheet:batchUpdate',
    'GET',
  ],
  [
    "https://sheets.googleapis.com/v4/spreadsheets/fixture-spreadsheet/values/'Devices'!A1%3AJ1000",
    'POST',
  ],
  [
    'https://chromemanagement.googleapis.com/v1/customers/C0123456/telemetry/devices',
    'POST',
  ],
];

for (const url of allowed)
  test(`allows ${url}`, () => {
    assert.equal(googleRequestAllowed(new URL(url)), true);
  });

for (const url of rejected)
  test(`rejects ${url.slice(0, 120)}`, () => {
    assert.equal(googleRequestAllowed(new URL(url)), false);
  });

for (const [url, method] of allowedMethods)
  test(`allows ${method} ${url}`, () => {
    assert.equal(googleRequestAllowed(new URL(url), method), true);
    // The method matches in either case.
    assert.equal(
      googleRequestAllowed(new URL(url), method.toLowerCase()),
      true,
    );
  });

for (const [url, method] of refusedMethods)
  test(`refuses ${method} ${url}`, () => {
    assert.equal(googleRequestAllowed(new URL(url), method), false);
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
  // The schema write shapes admit POST, PUT, and DELETE only on the paths this
  // repository builds. A PATCH is never sent (design C4), so the allowlist refuses it.
  assert.throws(
    () =>
      validateRequests([
        {
          id: 'schema',
          method: 'PATCH',
          path: '/admin/directory/v1/customer/C0123456/schemas/SchemaName',
        },
      ]),
    { name: 'BatchServiceError', code: 'invalid-request' },
  );
  // A user write is one PATCH or PUT part on the item, and nothing else. A
  // read of the same item keeps its GET shape (design section 4, C9).
  for (const method of ['GET', 'PATCH', 'PUT'])
    validateRequests([
      { id: 'user', method, path: '/admin/directory/v1/users/u1' },
    ]);
  for (const [method, path] of [
    ['PATCH', '/admin/directory/v1/users'],
    ['PUT', '/admin/directory/v1/users'],
    ['PUT', '/admin/directory/v1/users/u1/aliases'],
    ['PATCH', '/admin/directory/v1/users/u1:signOut'],
    ['POST', '/admin/directory/v1/users/u1'],
    ['DELETE', '/admin/directory/v1/users/u1'],
  ])
    assert.throws(() => validateRequests([{ id: 'user', method, path }]), {
      name: 'BatchServiceError',
      code: 'invalid-request',
    });
  // A write off the collection or the item path never leaves the process.
  for (const [method, path] of [
    ['POST', '/admin/directory/v1/customer/C0123456/schemas/SchemaName'],
    ['PUT', '/admin/directory/v1/customer/C0123456/schemas'],
    [
      'DELETE',
      '/admin/directory/v1/customer/C0123456/schemas/SchemaName/fields',
    ],
  ])
    assert.throws(() => validateRequests([{ id: 'schema', method, path }]), {
      name: 'BatchServiceError',
      code: 'invalid-request',
    });
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
  // A user detail is a batch part only, so a direct read or write never leaves
  // the process (design section 4, C9).
  for (const method of ['GET', 'PATCH', 'PUT', 'DELETE'])
    await assert.rejects(
      async () =>
        client.request({
          url: 'https://admin.googleapis.com/admin/directory/v1/users/u1',
          method,
        }),
      { code: 'request-failed' },
    );
  assert.equal(urls.length, 2);
  // The two new collection reads reach the transport with GET.
  const collections = [
    'https://admin.googleapis.com/admin/directory/v1/users',
    'https://admin.googleapis.com/admin/directory/v1/customer/C0123456/schemas',
  ];
  for (const url of collections) await client.request({ url, method: 'GET' });
  assert.equal(urls.length, 4);
  // Every write method fails before the transport for both collection shapes.
  for (const url of collections)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      await assert.rejects(async () => client.request({ url, method }), {
        code: 'request-failed',
      });
  assert.equal(urls.length, 4);
});
