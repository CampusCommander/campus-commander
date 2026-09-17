import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, verify } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startProvider } from './provider-fixture.mjs';
import { withInstalledAdmission } from './phase3-installed-workflows.mjs';

test('provider binds the subject to the authorization code and retains PKCE and replay rejection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cc-provider-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = join(root, 'key.pem'),
    certificate = join(root, 'certificate.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      certificate,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:host.docker.internal,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const publicOrigin = 'https://campus.example.org:8443';
  const password = 'synthetic-provider-password';
  const ca = await readFile(certificate);
  const provider = await startProvider({
    certificate: ca,
    privateKey: await readFile(key),
    publicOrigin,
    password,
  });
  t.after(() => provider.close());
  const request = (path, data) =>
    new Promise((resolve, reject) => {
      const target = new URL(path, provider.issuer);
      target.hostname = '127.0.0.1';
      const call = https.request(
        target,
        {
          ca,
          method: data ? 'POST' : 'GET',
          headers: data
            ? { 'content-type': 'application/x-www-form-urlencoded' }
            : {},
        },
        (response) => {
          let body = '';
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('end', () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body,
            }),
          );
        },
      );
      call.on('error', reject);
      call.end(data?.toString());
    });
  const verifier = 'synthetic-pkce-verifier';
  const authorize = async () => {
    const query = new URLSearchParams({
      scope: 'openid profile',
      redirect_uri: `${publicOrigin}/api/auth/callback`,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      nonce: 'synthetic-nonce',
      state: 'synthetic-state',
    });
    const response = await request(`/authorize?${query}`);
    assert.equal(response.status, 303);
    return new URL(response.headers.location).searchParams.get('code');
  };
  const exchange = (code, codeVerifier = verifier) =>
    request(
      '/token',
      new URLSearchParams({
        code,
        code_verifier: codeVerifier,
        client_secret: password,
        client_id: 'qualification',
        redirect_uri: `${publicOrigin}/api/auth/callback`,
      }),
    );
  provider.setSubject('ordinary-principal');
  const code = await authorize();
  provider.setSubject('administrator');
  const response = await exchange(code);
  assert.equal(response.status, 200);
  const token = JSON.parse(response.body).id_token.split('.');
  const claims = JSON.parse(Buffer.from(token[1], 'base64url'));
  assert.equal(claims.sub, 'ordinary-principal');
  assert.equal(claims.nonce, 'synthetic-nonce');
  const { keys } = JSON.parse((await request('/jwks')).body);
  assert.equal(
    verify(
      'RSA-SHA256',
      Buffer.from(token.slice(0, 2).join('.')),
      { key: keys[0], format: 'jwk' },
      Buffer.from(token[2], 'base64url'),
    ),
    true,
  );
  assert.equal((await exchange(code)).status, 400);
  assert.equal(
    (await exchange(await authorize(), 'wrong-verifier')).status,
    400,
  );
  const next = JSON.parse(
    (await exchange(await authorize())).body,
  ).id_token.split('.')[1];
  assert.equal(JSON.parse(Buffer.from(next, 'base64url')).sub, 'administrator');
  for (const subject of ['', null, 'a'.repeat(256)])
    assert.throws(() => provider.setSubject(subject));
});

test('installed admission errors omit invitation fragments and authorization codes', async () => {
  const token = 'synthetic-invitation-secret';
  const code = 'synthetic-authorization-code';
  await assert.rejects(
    withInstalledAdmission(async () => {
      throw new Error(
        `page.goto failed for https://campus.example.org/invitation#${token} callback?code=${code}`,
      );
    }),
    (error) => {
      assert.equal(
        error.message,
        'Installed invitation and access qualification failed.',
      );
      assert.doesNotMatch(error.stack, new RegExp(`${token}|${code}`));
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.equal(await withInstalledAdmission(async () => 'passed'), 'passed');
});

test('installed admission reports only allowlisted qualification stages', async () => {
  await assert.rejects(
    withInstalledAdmission(async (checkpoint) => {
      checkpoint('confirm identity');
      throw new Error('synthetic-token');
    }),
    (error) => {
      assert.equal(
        error.message,
        'Installed invitation and access qualification failed at confirm identity.',
      );
      assert.doesNotMatch(error.stack, /synthetic-token/);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  await assert.rejects(
    withInstalledAdmission(async (checkpoint) => checkpoint('synthetic-token')),
    (error) => {
      assert.equal(
        error.message,
        'Installed invitation and access qualification failed.',
      );
      assert.doesNotMatch(error.stack, /synthetic-token/);
      return true;
    },
  );
});
