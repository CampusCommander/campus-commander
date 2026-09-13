import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import https from 'node:https';

/** Run a synthetic HTTPS provider with real signed authorization-code exchanges. */
export async function startProvider({
  certificate,
  privateKey,
  publicOrigin,
  password,
}) {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...rsa.publicKey.export({ format: 'jwk' }),
    kid: 'qualification',
    alg: 'RS256',
    use: 'sig',
  };
  const codes = new Map();
  const server = https
    .createServer(
      { cert: certificate, key: privateKey },
      async (request, response) => {
        const url = new URL(request.url, issuer);
        const json = (value, status = 200) => {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(value));
        };
        if (url.pathname === '/.well-known/openid-configuration')
          return json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            token_endpoint_auth_methods_supported: ['client_secret_post'],
            code_challenge_methods_supported: ['S256'],
          });
        if (url.pathname === '/jwks') return json({ keys: [jwk] });
        if (url.pathname === '/authorize') {
          assert.equal(url.searchParams.get('scope'), 'openid profile');
          assert.equal(
            url.searchParams.get('redirect_uri'),
            `${publicOrigin}/api/auth/callback`,
          );
          assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
          const code = randomUUID();
          codes.set(code, {
            nonce: url.searchParams.get('nonce'),
            challenge: url.searchParams.get('code_challenge'),
          });
          const callback = new URL(`${publicOrigin}/api/auth/callback`);
          callback.searchParams.set('state', url.searchParams.get('state'));
          callback.searchParams.set('code', code);
          response.writeHead(303, { location: callback.href });
          return response.end();
        }
        if (url.pathname === '/token') {
          let body = '';
          for await (const chunk of request) body += chunk;
          const form = new URLSearchParams(body);
          const grant = codes.get(form.get('code'));
          codes.delete(form.get('code'));
          if (
            !grant ||
            form.get('client_secret') !== password ||
            form.get('client_id') !== 'qualification' ||
            form.get('redirect_uri') !== `${publicOrigin}/api/auth/callback` ||
            createHash('sha256')
              .update(form.get('code_verifier') ?? '')
              .digest('base64url') !== grant.challenge
          )
            return json({ error: 'invalid_grant' }, 400);
          const encode = (value) =>
            Buffer.from(JSON.stringify(value)).toString('base64url');
          const input = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({
            iss: issuer,
            aud: 'qualification',
            sub: 'administrator',
            nonce: grant.nonce,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 300,
          })}`;
          return json({
            access_token: 'synthetic-unused',
            token_type: 'Bearer',
            expires_in: 300,
            id_token: `${input}.${sign('RSA-SHA256', Buffer.from(input), rsa.privateKey).toString('base64url')}`,
          });
        }
        json({ error: 'not_found' }, 404);
      },
    )
    .listen(0, '0.0.0.0');
  await once(server, 'listening');
  const issuer = `https://host.docker.internal:${server.address().port}`;
  return {
    issuer,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}
