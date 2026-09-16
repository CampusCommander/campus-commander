import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGoogleClient } from './google-client.mjs';
import { createQuestions, importGoogleClient } from './setup.mjs';
import { startSetupUpload } from './setup-upload.mjs';
import http from 'node:http';

const publicOrigin = 'https://localhost:8443';
const client = () => ({
  web: {
    client_id: '123-example.apps.googleusercontent.com',
    client_secret: 'synthetic-client-secret',
    project_id: 'campus-test',
    redirect_uris: [`${publicOrigin}/api/auth/callback`],
  },
});

test('Google import validates the client type, endpoints, size, and exact callback without exposing secrets', () => {
  assert.equal(
    parseGoogleClient(JSON.stringify(client()), publicOrigin).clientId,
    client().web.client_id,
  );
  const malformed = [
    JSON.stringify({ installed: client().web }),
    JSON.stringify({ type: 'service_account' }),
    '{secret',
    ' '.repeat(65537),
  ];
  for (const override of [
    { redirect_uris: ['https://localhost:8443/api/auth/callback/'] },
    { token_uri: 'https://untrusted.example.invalid/token' },
    { client_id: 'wrong' },
  ])
    malformed.push(JSON.stringify({ web: { ...client().web, ...override } }));
  for (const input of malformed)
    assert.throws(
      () => parseGoogleClient(input, publicOrigin),
      (error) => !error.message.includes('synthetic-client-secret'),
    );
});

test('Google import stores credentials privately and resumes after a missing secret write', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cc-google-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'download.json');
  await writeFile(source, JSON.stringify(client()), { mode: 0o600 });
  const output = [];
  const q = createQuestions({
    'applicationAuth.googleImport': 'file',
    'applicationAuth.googleClientFile': source,
  });
  const first = await importGoogleClient({
    root,
    publicOrigin,
    q,
    output: (line) => output.push(line),
  });
  q.finish();
  assert.equal((await stat(first.secretPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'private'))).mode & 0o777, 0o700);
  await rm(first.secretPath);
  const restored = await importGoogleClient({
    root,
    publicOrigin,
    q: createQuestions(),
    output: (line) => output.push(line),
    upload: () => assert.fail('Resume must retain the completed import.'),
  });
  assert.equal(
    await readFile(restored.secretPath, 'utf8'),
    client().web.client_secret,
  );
  assert.ok(output.every((line) => !line.includes(client().web.client_secret)));
  await assert.rejects(
    importGoogleClient({
      root,
      publicOrigin: 'https://another.example.invalid',
      q: createQuestions(),
      output: () => undefined,
    }),
  );
  assert.equal(
    await readFile(restored.secretPath, 'utf8'),
    client().web.client_secret,
  );
});

test('loopback upload requires exact origin, one-time pairing, browser cookie, and CSRF proof', async (t) => {
  const server = await startSetupUpload({ publicOrigin, port: 0 });
  t.after(() => server.close());
  const post = (path, body, headers = {}) =>
    fetch(server.origin + path, {
      method: 'POST',
      headers: {
        origin: server.origin,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    await new Promise((resolve, reject) => {
      const request = http.get(
        server.origin,
        { headers: { host: 'untrusted.example.invalid' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
    }),
    403,
  );
  assert.equal(
    (
      await post(
        '/pair',
        { code: server.pairingCode },
        { origin: 'https://untrusted.example.invalid' },
      )
    ).status,
    403,
  );
  assert.equal(
    (await post('/import', { content: JSON.stringify(client()) })).status,
    403,
  );
  const paired = await post('/pair', { code: server.pairingCode });
  assert.equal(paired.status, 200);
  const cookie = paired.headers.get('set-cookie').split(';')[0];
  const { csrf } = await paired.json();
  assert.equal((await post('/pair', { code: server.pairingCode })).status, 403);
  assert.equal(
    (await post('/import', { content: JSON.stringify(client()) }, { cookie }))
      .status,
    403,
  );
  const headers = { cookie, 'x-setup-csrf': csrf };
  assert.equal(
    (await post('/import', { content: '{invalid' }, headers)).status,
    400,
  );
  assert.equal(
    (await post('/import', { content: JSON.stringify(client()) }, headers))
      .status,
    200,
  );
  assert.deepEqual(JSON.parse(await server.result), client());
  assert.equal(
    (await post('/import', { content: JSON.stringify(client()) }, headers))
      .status,
    409,
  );
});

test('expired browser setup closes without accepting credentials', async () => {
  const server = await startSetupUpload({
    publicOrigin,
    port: 0,
    lifetime: 20,
  });
  await assert.rejects(server.result, /expired/);
  await server.close();
});
