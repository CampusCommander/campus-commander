import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import esbuild from 'esbuild';
import * as oidc from 'openid-client';

/**
 * Login asks for the verified sign-in email and the session keeps it as the Drive subject
 * (design section 4, card DB4). The suite runs the real AuthService against a synthetic provider
 * configuration and fake database and cache, so the scope of the sign-in request and the stored
 * session are the service's own answers.
 *
 * The provider configuration carries a fake transport. No request leaves the process, and the
 * ID token needs no signature, because openid-client reads the claims the provider sent.
 */
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.ts') && url.includes('/api/src/')) {
      const file = fileURLToPath(url);
      const { code } = esbuild.transformSync(readFileSync(file, 'utf8'), {
        loader: 'ts',
        format: 'esm',
        target: 'node22',
        tsconfigRaw: {
          compilerOptions: {
            experimentalDecorators: true,
            useDefineForClassFields: false,
          },
        },
        sourcefile: file,
      });
      return { format: 'module', shortCircuit: true, source: code };
    }
    return nextLoad(url, context);
  },
});

const { AuthService, driveSubjectFromClaims, loginScope, sessionCookie } =
  await import('./auth.service.ts');

const issuer = 'https://identity.example.org';
const publicOrigin = 'https://campus.example.org';
const clientId = 'synthetic-client';
const clientSecret = 'synthetic-client-secret';
const principalId = '11111111-1111-4111-8111-111111111111';
const delegatedEmail = 'administrator@example.org';

const configuration = {
  auth: {
    issuer,
    clientId,
    clientSecretRef: { provider: 'file', path: '/synthetic/client-secret' },
    publicOrigin,
    sessionLifetimeSeconds: 3600,
    sessionIdleSeconds: 1800,
  },
  secret: () => Buffer.from(`${clientSecret}\n`),
};

const database = {
  connection: {
    async query() {
      return {
        rowCount: 1,
        rows: [{ id: principalId, permission_version: 4 }],
      };
    },
  },
  async audit() {},
};

function cacheDouble() {
  const values = new Map();
  const seconds = new Map();
  return {
    values,
    seconds,
    async get(key) {
      return values.get(key) ?? null;
    },
    async consume(key) {
      const value = values.get(key) ?? null;
      values.delete(key);
      return value;
    },
    async set(key, value, ttl) {
      values.set(key, value);
      seconds.set(key, ttl);
      return 'OK';
    },
    async remove(key) {
      return values.delete(key) ? 1 : 0;
    },
    async swap(key, _expected, value) {
      values.set(key, value);
      return true;
    },
    async exists(key) {
      return values.has(key) ? 1 : 0;
    },
    async expire(key) {
      return values.has(key) ? 1 : 0;
    },
  };
}

/** A provider configuration whose token endpoint answers one ID token for the login nonce. */
function provider() {
  const config = new oidc.Configuration(
    {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    },
    clientId,
    { client_secret: clientSecret },
  );
  const answered = { nonce: '', claims: {} };
  config[oidc.customFetch] = async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: issuer,
      aud: clientId,
      sub: 'administrator',
      nonce: answered.nonce,
      iat: now,
      exp: now + 300,
      ...answered.claims,
    };
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    return new Response(
      JSON.stringify({
        access_token: 'synthetic-access-token',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: `${encode({ alg: 'RS256' })}.${encode(claims)}.synthetic`,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { config, answered };
}

/** Sign in once through the real service. `claims` overrides the ID token claims. */
async function signIn(claims = { email: delegatedEmail, email_verified: true }) {
  const cache = cacheDouble();
  const service = new AuthService(
    configuration,
    database,
    cache,
    {},
    {},
  );
  const { config, answered } = provider();
  service.discovery = Promise.resolve(config);
  answered.claims = claims;
  const started = await service.start('synthetic-correlation');
  const target = new URL(started.url);
  const login = JSON.parse(
    [...cache.values.entries()].find(([key]) =>
      key.startsWith('cc:auth:login:'),
    )[1],
  );
  answered.nonce = login.nonce;
  const callback = `${publicOrigin}/api/auth/callback?state=${encodeURIComponent(login.state)}&code=synthetic-code`;
  const finished = await service.callback(
    callback,
    `__Host-cc-login=${started.token}`,
    'synthetic-correlation',
  );
  const sessionKey = [...cache.values.keys()].find((key) =>
    key.startsWith('cc:auth:session:'),
  );
  return {
    cache,
    service,
    target,
    finished,
    sessionKey,
    session: JSON.parse(cache.values.get(sessionKey)),
  };
}

test('login asks openid profile email and keeps the verified sign-in email', async () => {
  const { target, session, sessionKey, cache, service, finished } =
    await signIn();
  assert.equal(target.origin, issuer);
  assert.equal(target.searchParams.get('scope'), 'openid profile email');
  assert.equal(loginScope, 'openid profile email');
  assert.equal(
    sessionKey,
    `cc:auth:session:${createHash('sha256').update(finished.token).digest('hex')}`,
  );
  assert.equal(session.driveSubject, delegatedEmail);
  assert.equal(session.principalId, principalId);
  assert.equal(cache.seconds.get(sessionKey), 1800);
  assert.equal(
    await service.driveSubject(`${sessionCookie}=${finished.token}`),
    delegatedEmail,
  );
});

test('a false email_verified keeps a null Drive subject', async () => {
  const { session, service, finished } = await signIn({
    email: delegatedEmail,
    email_verified: false,
  });
  assert.equal(session.driveSubject, null);
  assert.equal(
    await service.driveSubject(`${sessionCookie}=${finished.token}`),
    null,
  );
});

test('an unverified email of any other type keeps a null Drive subject', async () => {
  for (const claims of [
    { email: delegatedEmail, email_verified: 'true' },
    { email: delegatedEmail, email_verified: 1 },
    { email_verified: true },
    { email: '', email_verified: true },
    { email: 42, email_verified: true },
  ]) {
    const { session } = await signIn(claims);
    assert.equal(session.driveSubject, null, JSON.stringify(claims));
  }
});

test('the Drive subject of a session answers null without a live session', async () => {
  const { service } = await signIn();
  assert.equal(await service.driveSubject(undefined), null);
  assert.equal(
    await service.driveSubject(`${sessionCookie}=${'b'.repeat(64)}`),
    null,
  );
  assert.equal(await service.driveSubject(`${sessionCookie}=not-a-token`), null);
});

test('the claim helper keeps only a verified non-empty email', () => {
  assert.equal(
    driveSubjectFromClaims({ email: delegatedEmail, email_verified: true }),
    delegatedEmail,
  );
  assert.equal(driveSubjectFromClaims(undefined), null);
  assert.equal(driveSubjectFromClaims({}), null);
  assert.equal(
    driveSubjectFromClaims({ email: delegatedEmail, email_verified: false }),
    null,
  );
  assert.equal(
    driveSubjectFromClaims({ email: delegatedEmail, email_verified: 'true' }),
    null,
  );
  assert.equal(driveSubjectFromClaims({ email: '', email_verified: true }), null);
  assert.equal(
    driveSubjectFromClaims({ email: 42, email_verified: true }),
    null,
  );
});