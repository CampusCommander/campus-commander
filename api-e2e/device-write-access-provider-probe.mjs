import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { OAuth2Client } from 'google-auth-library';
import { DeviceWriteAccess } from '../api/src/app/devices/device-write-access.ts';
import { scopedClient } from '../libs/google-connection/src/lib/provider.ts';

/**
 * B6 C4: run the real write-access check through the real scoped client
 * against the Admin SDK mock. A recording transport sits at the request bound
 * of the provider. It keeps the method, the host, the path, and the maxResults
 * value of a Directory list request. It keeps no header, body, token, or other
 * query value. The introspection answer supplies the issued scope set.
 */
const writeScope =
  'https://www.googleapis.com/auth/admin.directory.device.chromeos';
const ca = await readFile(process.env.CC_PROBE_CA, 'utf8');
const port = Number(process.env.CC_PROBE_PORT);
const customer = process.env.CC_PROBE_CUSTOMER;
const subject = process.env.CC_PROBE_SUBJECT;
const key = JSON.parse(await readFile(process.env.CC_PROBE_KEY, 'utf8'));
assert.ok(Number.isInteger(port) && port > 0, 'The mock port is set.');
assert.match(customer, /^C[A-Za-z0-9]{4,31}$/, 'The mock customer is set.');

const records = [];
const responses = [];
const transport = Object.getPrototypeOf(new OAuth2Client().transporter);
const original = transport.request;
const agent = new https.Agent({
  ca,
  lookup: (_hostname, options, done) =>
    options?.all
      ? done(null, [{ address: '127.0.0.1', family: 4 }])
      : done(null, '127.0.0.1', 4),
});
transport.request = function request(options) {
  const url = new URL(options.url);
  // A Gaxios request may carry its query values in `params` instead of the URL.
  const maxResults =
    url.searchParams.get('maxResults') ?? options.params?.maxResults ?? null;
  const record = {
    method: String(options.method ?? 'GET').toUpperCase(),
    host: url.hostname,
    path: url.pathname,
    maxResults: maxResults === null ? null : Number(maxResults),
  };
  records.push(record);
  const pending = original.call(this, {
    ...options,
    url: `https://${url.hostname}:${port}${url.pathname}${url.search}`,
    agent,
  });
  responses.push(
    pending.then(
      (response) => {
        if (url.pathname === '/tokeninfo')
          record.scopes = String(response.data?.scope ?? '')
            .split(' ')
            .filter(Boolean);
      },
      () => undefined,
    ),
  );
  return pending;
};
try {
  const store = {
    reserve: async () => true,
    credential: async () => ({ serviceAccount: key, subject }),
    read: async () => null,
    write: async () => undefined,
  };
  const access = new DeviceWriteAccess(store, (credential, scope, signal) =>
    scopedClient(credential, scope, signal),
  );
  const result = await access.check(
    { identity: { id: '11111111-1111-4111-8111-111111111111' } },
    { customerId: customer, generation: 1 },
  );
  await Promise.allSettled(responses);

  const token = records.filter(
    (record) =>
      record.host === 'oauth2.googleapis.com' && record.path === '/token',
  );
  const introspection = records.filter(
    (record) =>
      record.host === 'oauth2.googleapis.com' && record.path === '/tokeninfo',
  );
  const directory = records.filter(
    (record) => record.host === 'admin.googleapis.com',
  );
  assert.equal(
    result.state,
    'granted',
    `The check grants: ${result.state} ${result.failure} ${JSON.stringify(
      records,
    )}`,
  );
  assert.equal(token.length, 1, 'The check sends one token exchange.');
  assert.equal(token[0].method, 'POST');
  assert.equal(introspection.length, 1, 'The check introspects one token.');
  assert.equal(introspection[0].method, 'POST');
  assert.deepEqual(
    introspection[0].scopes,
    [writeScope],
    'The issued token carries the write scope alone.',
  );
  assert.equal(directory.length, 1, 'The check sends one Directory request.');
  for (const record of directory) {
    assert.equal(record.method, 'GET', 'The Directory request is a GET.');
    assert.equal(
      record.path,
      `/admin/directory/v1/customer/${customer}/devices/chromeos`,
      'The Directory request lists ChromeOS devices.',
    );
    assert.equal(record.maxResults, 1, 'The list reads one device.');
  }
  assert.deepEqual(
    records
      .filter(
        (record) =>
          record.host === 'admin.googleapis.com' &&
          ['PATCH', 'POST', 'PUT', 'DELETE'].includes(record.method),
      )
      .map((record) => `${record.method} ${record.path}`),
    [],
    'The check sends no write method.',
  );
  process.stdout.write(`${JSON.stringify({ result, records })}\n`);
} finally {
  transport.request = original;
}
