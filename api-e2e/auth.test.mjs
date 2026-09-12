import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import https from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createClient } from 'redis';
import {
  loadMigrations,
  migrate,
  provision,
} from '../deployment/postgres/index.mjs';
import {
  applicationRedisAcl,
  redisImage,
  renderRedis,
} from '../deployment/redis/runtime.mjs';
import { changeApplicationAccess } from '../deployment/bootstrap/application-access.mjs';
import { createBootstrapEdge } from '../deployment/bootstrap/edge.mjs';
import { startKestraFixture } from './kestra-fixture.mjs';
import { chromium, expect } from '@playwright/test';
import { auditAccessibility } from './accessibility.mjs';

const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const packaged = process.env.CC_AUTH_PACKAGED_IMAGES === 'true';
const applicationImages = {
  api: process.env.CC_AUTH_API_IMAGE ?? 'campus-commander/api:cc-6',
  frontend:
    process.env.CC_AUTH_FRONTEND_IMAGE ?? 'campus-commander/frontend:cc-6',
  worker: process.env.CC_AUTH_WORKER_IMAGE ?? 'campus-commander/worker:cc-6',
};
async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function request(url, { ca, cookie, method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const target = new URL(url);
    const req = https.request(
      target,
      {
        ca,
        method,
        timeout: 10000,
        ...(target.hostname === 'host.docker.internal'
          ? {
              lookup: (_host, _options, done) =>
                done(null, [{ address: '127.0.0.1', family: 4 }]),
            }
          : {}),
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timed out.')));
    req.end(payload);
  });
}

test(
  'OIDC, Redis sessions, permission checks, CSRF, revocation, and API restart',
  { timeout: 300000 },
  async () => {
    const startedAt = Date.now();
    const id = randomUUID();
    const directory = await mkdtemp(join(tmpdir(), 'cc-phase2-auth-'));
    const secretRoot = join(directory, 'secrets');
    const names = [`cc-phase2-db-${id}`, `cc-phase2-redis-${id}`];
    const network = `cc-phase2-${id}`;
    const clients = [];
    const children = [];
    let issuerServer;
    let edgeServer;
    let browser;
    let redis;
    try {
      docker('network', 'create', network);
      await mkdir(secretRoot, { recursive: true, mode: 0o700 });
      const secret = async (name, value) => {
        await writeFile(join(secretRoot, name), value, { mode: 0o600 });
        return { provider: 'file', path: `/run/secrets/${name}` };
      };
      const password = randomUUID();
      let oidcPassword = password;
      const cert = join(directory, 'tls.crt'),
        privateKey = join(directory, 'tls.key');
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          privateKey,
          '-out',
          cert,
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1',
        ],
        { stdio: 'ignore' },
      );
      const ca = await readFile(cert);
      const tlsKey = await readFile(privateKey);
      const apiPort = await freePort();
      const edgePort = await freePort();
      const apiOrigin = `https://127.0.0.1:${apiPort}`;
      const publicOrigin = `https://127.0.0.1:${edgePort}`;
      const config = JSON.parse(
        await readFile('deployment/examples/all-docker.json', 'utf8'),
      );
      const dbImage = JSON.parse(
        await readFile('deployment/postgres/qualification.json', 'utf8'),
      ).image;
      docker(
        'run',
        '-d',
        '--name',
        names[0],
        '--network',
        network,
        '-e',
        `POSTGRES_PASSWORD=${password}`,
        '-p',
        '127.0.0.1::5432',
        dbImage,
      );
      const dbPort = Number(
        docker('port', names[0], '5432/tcp').split(':').at(-1),
      );
      let admin;
      for (let attempt = 0; attempt < 100; attempt++) {
        const candidate = new pg.Client({
          host: '127.0.0.1',
          port: dbPort,
          user: 'postgres',
          password,
          connectionTimeoutMillis: 1000,
        });
        try {
          await candidate.connect();
          admin = candidate;
          clients.push(admin);
          break;
        } catch {
          await candidate.end();
          await delay(100);
        }
      }
      assert.ok(admin, 'PostgreSQL did not start.');
      await provision(admin, {
        application: {
          database: 'cc-app',
          role: 'cc-app',
          password,
          migrationRole: 'cc-migrator',
          migrationPassword: password,
        },
        kestra: { database: 'cc-kestra', role: 'cc-kestra', password },
      });
      const migrator = new pg.Client({
        host: '127.0.0.1',
        port: dbPort,
        user: 'cc-migrator',
        database: 'cc-app',
        password,
      });
      await migrator.connect();
      clients.push(migrator);
      await migrate(migrator, {
        migrations: await loadMigrations(),
        runtimeRole: 'cc-app',
      });
      await migrate(migrator, {
        migrations: await loadMigrations(),
        runtimeRole: 'cc-app',
      });
      const runtime = new pg.Client({
        host: '127.0.0.1',
        port: dbPort,
        user: 'cc-app',
        database: 'cc-app',
        password,
      });
      await runtime.connect();
      clients.push(runtime);
      await assert.rejects(
        runtime.query('UPDATE cc.application_principals SET enabled=true'),
        /permission denied/,
      );
      await assert.rejects(
        runtime.query('DELETE FROM cc.security_events'),
        /permission denied/,
      );

      config.phase = 2;
      config.services.edge.access = 'application';
      config.services.applicationDatabase.endpoint.url = `postgresql://${names[0]}:5432`;
      config.services.applicationDatabase.database = 'cc-app';
      config.services.applicationDatabase.role = 'cc-app';
      config.services.applicationDatabase.passwordSecretRef = await secret(
        'database-password',
        password,
      );
      config.services.kestraDatabase.endpoint.url = `postgresql://${names[0]}:5432`;
      config.services.kestraDatabase.database = 'cc-kestra';
      config.services.kestraDatabase.role = 'cc-kestra';
      config.services.kestraDatabase.passwordSecretRef = await secret(
        'kestra-password',
        password,
      );
      config.services.redis.passwordSecretRef = await secret(
        'redis-password',
        password,
      );
      config.artifacts.location = join(directory, 'artifacts');
      await mkdir(config.artifacts.location, { mode: 0o700 });
      const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const jwk = {
        ...rsa.publicKey.export({ format: 'jwk' }),
        kid: 'synthetic-key',
        alg: 'RS256',
        use: 'sig',
      };
      const codes = new Map();
      let subject = 'administrator',
        invalidNonce = false,
        invalidAudience = false,
        invalidIssuer = false;
      const issuerPort = await freePort();
      const issuer = `https://host.docker.internal:${issuerPort}`;
      issuerServer = https
        .createServer({ cert: ca, key: tlsKey }, async (req, res) => {
          const url = new URL(req.url, issuer);
          const json = (body, status = 200) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
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
              subject,
            });
            const callback = new URL(`${publicOrigin}/api/auth/callback`);
            callback.searchParams.set('code', code);
            callback.searchParams.set('state', url.searchParams.get('state'));
            res.writeHead(303, { location: callback.href });
            return res.end();
          }
          if (url.pathname === '/token') {
            let body = '';
            for await (const bytes of req) body += bytes;
            const form = new URLSearchParams(body);
            const grant = codes.get(form.get('code'));
            codes.delete(form.get('code'));
            if (
              !grant ||
              form.get('client_secret') !== oidcPassword ||
              form.get('client_id') !== 'synthetic-client' ||
              form.get('redirect_uri') !==
                `${publicOrigin}/api/auth/callback` ||
              createHash('sha256')
                .update(form.get('code_verifier') ?? '')
                .digest('base64url') !== grant.challenge
            )
              return json({ error: 'invalid_grant' }, 400);
            const encoded = (value) =>
              Buffer.from(JSON.stringify(value)).toString('base64url');
            const input = `${encoded({ alg: 'RS256', kid: jwk.kid })}.${encoded(
              {
                iss: invalidIssuer ? 'https://invalid.example' : issuer,
                aud: invalidAudience ? 'wrong-client' : 'synthetic-client',
                sub: grant.subject,
                nonce: invalidNonce ? 'wrong' : grant.nonce,
                iat: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + 300,
              },
            )}`;
            return json({
              access_token: 'synthetic-access-token',
              token_type: 'Bearer',
              expires_in: 300,
              id_token: `${input}.${sign('RSA-SHA256', Buffer.from(input), rsa.privateKey).toString('base64url')}`,
            });
          }
          return json({ error: 'not_found' }, 404);
        })
        .listen(issuerPort, '0.0.0.0');
      await once(issuerServer, 'listening');
      config.applicationAuth = {
        issuer,
        clientId: 'synthetic-client',
        clientSecretRef: await secret('oidc-secret', password),
        publicOrigin,
        sessionLifetimeSeconds: 300,
        sessionIdleSeconds: 60,
      };
      const redisConfig = join(directory, 'redis.conf');
      const redisOperatorPassword = randomUUID();
      await writeFile(
        redisConfig,
        renderRedis(config, Buffer.from(password)).replace(
          'dir /data',
          'dir /tmp',
        ) +
          `user qualification-operator on #${createHash('sha256').update(redisOperatorPassword).digest('hex')} -@all +acl|setuser\n`,
      );
      docker(
        'run',
        '-d',
        '--name',
        names[1],
        '--network',
        network,
        '-v',
        `${redisConfig}:/tmp/redis.conf:ro`,
        '-p',
        '127.0.0.1::6379',
        redisImage,
        'redis-server',
        '/tmp/redis.conf',
      );
      const redisPort = Number(
        docker('port', names[1], '6379/tcp').split(':').at(-1),
      );
      config.services.redis.endpoint.url = `redis://${names[1]}:6379`;
      redis = createClient({ url: `redis://127.0.0.1:${redisPort}`, password });
      redis.on('error', () => undefined);
      await redis.connect();
      const configureRedisAccess = (...rules) => {
        assert.equal(
          docker(
            'exec',
            '-e',
            `REDISCLI_AUTH=${redisOperatorPassword}`,
            names[1],
            'redis-cli',
            '--user',
            'qualification-operator',
            'ACL',
            'SETUSER',
            'default',
            ...rules,
          ),
          'OK',
        );
      };
      const nodeImage = (
        await readFile('deployment/images/api.Dockerfile', 'utf8')
      ).match(/^FROM (node:\S+)/m)[1];
      const kestraFixture = await startKestraFixture({
        docker,
        directory,
        network,
        names,
        config,
        secret,
        password,
        nodeImage,
        workerImage: packaged ? applicationImages.worker : undefined,
      });
      const configPath = join(directory, 'profile.json');
      await writeFile(configPath, JSON.stringify(config));
      const initialize = {
        action: 'initialize',
        issuer,
        subject: 'administrator',
        displayName: 'Synthetic administrator',
      };
      const operatorPath = join(directory, 'operator.json');
      const operatorRequestPath = join(directory, 'access-request.json');
      await writeFile(
        operatorPath,
        JSON.stringify({
          migrationRole: 'cc-migrator',
          migrationPasswordSecretRef: await secret(
            'migration-password',
            password,
          ),
        }),
        { mode: 0o600 },
      );
      const callOperator = async (payload) => {
        await writeFile(operatorRequestPath, JSON.stringify(payload), {
          mode: 0o600,
        });
        return JSON.parse(
          docker(
            'run',
            '--rm',
            '--network',
            network,
            '--user',
            `${process.getuid()}:${process.getgid()}`,
            '--workdir',
            '/app',
            ...(packaged ? [] : ['-v', `${process.cwd()}:/app:ro`]),
            '-v',
            `${directory}:${directory}:ro`,
            '-v',
            `${secretRoot}:/run/secrets:ro`,
            packaged ? applicationImages.api : nodeImage,
            'node',
            'deployment/bootstrap/application-access-cli.mjs',
            configPath,
            operatorPath,
            operatorRequestPath,
          ),
        );
      };
      const { principalId } = await callOperator(initialize);
      const inspected = await callOperator({ action: 'inspect' });
      assert.equal(inspected.principals[0].id, principalId);
      assert.equal(inspected.principals[0].permission_version, 1);
      await assert.rejects(
        callOperator({
          ...initialize,
          issuer: 'https://untrusted.example.invalid',
        }),
      );
      await assert.rejects(
        changeApplicationAccess(migrator, initialize, issuer),
        /already exists/,
      );
      await assert.rejects(
        changeApplicationAccess(
          runtime,
          { action: 'revoke', principalId, expectedVersion: 1 },
          issuer,
        ),
        /permission denied/,
      );
      let output = '';
      const startApi = async (listenPort = apiPort) => {
        const name = `cc-phase2-api-${id}-${children.length}`;
        names.push(name);
        const image = (
          await readFile('deployment/images/api.Dockerfile', 'utf8')
        ).match(/^FROM (node:\S+)/m)[1];
        const child = spawn(
          'docker',
          [
            'run',
            '--rm',
            '--name',
            name,
            '--network',
            network,
            '-p',
            `127.0.0.1:${listenPort}:${listenPort}`,
            '--add-host',
            'host.docker.internal:host-gateway',
            '--user',
            `${process.getuid()}:${process.getgid()}`,
            '--workdir',
            '/app',
            ...(packaged ? [] : ['-v', `${process.cwd()}:/app:ro`]),
            '-v',
            `${directory}:${directory}`,
            '-v',
            `${secretRoot}:/run/secrets:ro`,
            '-e',
            'NODE_ENV=test',
            '-e',
            `PORT=${listenPort}`,
            '-e',
            `TLS_CERT_FILE=${cert}`,
            '-e',
            `TLS_KEY_FILE=${privateKey}`,
            '-e',
            `CC_CONFIG_FILE=${configPath}`,
            '-e',
            `NODE_EXTRA_CA_CERTS=${cert}`,
            packaged ? applicationImages.api : image,
            'node',
            packaged ? 'main.js' : 'dist/api/main.js',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        children.push(child);
        child.stdout.on('data', (bytes) => {
          output += bytes;
        });
        child.stderr.on('data', (bytes) => {
          output += bytes;
        });
        let lastProbe;
        for (let attempt = 0; attempt < 100; attempt++) {
          assert.equal(child.exitCode, null, `API exited: ${output}`);
          try {
            const result = await request(
              `https://127.0.0.1:${listenPort}/health/live`,
              { ca },
            );
            lastProbe = result;
            if (result.status === 200) return child;
          } catch (error) {
            lastProbe = { code: error.code, message: error.message };
          }
          await delay(100);
        }
        assert.fail(
          `API probe failed: ${JSON.stringify(lastProbe)}. Output: ${output}`,
        );
      };
      let api = await startApi();
      const frontendPort = await freePort();
      const frontendName = `cc-phase2-frontend-${id}`;
      names.push(frontendName);
      const image = (
        await readFile('deployment/images/frontend.Dockerfile', 'utf8')
      ).match(/^FROM (node:\S+)/m)[1];
      docker(
        'run',
        '-d',
        '--name',
        frontendName,
        '--network',
        network,
        '-p',
        `127.0.0.1:${frontendPort}:8080`,
        ...(packaged
          ? []
          : [
              '-v',
              `${process.cwd()}/dist/frontend/browser:/app/browser:ro`,
              '-v',
              `${process.cwd()}/deployment/images/frontend-server.mjs:/app/server.mjs:ro`,
            ]),
        packaged ? applicationImages.frontend : image,
        'node',
        '/app/server.mjs',
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          if ((await fetch(`http://127.0.0.1:${frontendPort}/health/live`)).ok)
            break;
        } catch {
          /* Await the frontend listener. */
        }
        await delay(100);
      }
      const edgeConfig = structuredClone(config);
      edgeConfig.services.frontend.endpoint.url = `http://127.0.0.1:${frontendPort}`;
      edgeConfig.services.api.endpoint = {
        url: apiOrigin,
        tls: {
          mode: 'private-ca',
          caSecretRef: { provider: 'file', path: '/run/secrets/synthetic-ca' },
        },
      };
      edgeConfig.services.api.serverTls = {
        certificateSecretRef: {
          provider: 'file',
          path: '/run/secrets/synthetic-certificate',
        },
        privateKeySecretRef: {
          provider: 'file',
          path: '/run/secrets/synthetic-private-key',
        },
      };
      edgeServer = await createBootstrapEdge({
        config: edgeConfig,
        verify: async () => false,
        resolveSecret: async (ref) =>
          ref.path.endsWith('private-key') ? tlsKey : ca,
      });
      await new Promise((resolve) =>
        edgeServer.listen(edgePort, '127.0.0.1', resolve),
      );
      assert.equal(
        (await request(`${publicOrigin}/api/bootstrap/verify`, { ca })).status,
        404,
      );
      assert.equal(
        (await request(`${publicOrigin}/api/v1/main/flows`, { ca })).status,
        404,
      );
      const login = async ({ wrongState = false } = {}) => {
        const start = await request(`${publicOrigin}/api/auth/login`, { ca });
        assert.equal(start.status, 303, start.text);
        const cookie = start.headers['set-cookie'][0].split(';')[0];
        assert.match(start.headers['set-cookie'][0], /Secure/);
        assert.match(start.headers['set-cookie'][0], /HttpOnly/);
        const authorize = await request(start.headers.location, { ca });
        const callback = new URL(authorize.headers.location);
        if (wrongState) callback.searchParams.set('state', 'wrong-state');
        const finish = await request(callback, { ca, cookie });
        return { finish, callback, cookie };
      };
      assert.equal(
        (await request(`${publicOrigin}/api/auth/session`, { ca })).status,
        401,
      );
      const valid = await login();
      assert.equal(valid.finish.headers.location, '/', valid.finish.text);
      const sessionCookie = valid.finish.headers['set-cookie']
        .find((entry) => entry.startsWith('__Host-cc-session='))
        .split(';')[0];
      const session = JSON.parse(
        (
          await request(`${publicOrigin}/api/auth/session`, {
            ca,
            cookie: sessionCookie,
          })
        ).text,
      );
      assert.equal(session.identity.id, principalId);
      await migrator.query(
        "UPDATE cc.application_principals SET permissions=ARRAY['identity:read'] WHERE id=$1",
        [principalId],
      );
      assert.equal(
        (
          await request(`${publicOrigin}/api/diagnostics`, {
            ca,
            cookie: sessionCookie,
          })
        ).status,
        403,
      );
      for (const operation of ['postgresql', 'redis', 'kestra', 'artifacts']) {
        assert.equal(
          (
            await request(`${publicOrigin}/api/diagnostics/${operation}`, {
              ca,
              cookie: sessionCookie,
              method: 'POST',
              body: {},
              headers: {
                origin: publicOrigin,
                'x-csrf-token': session.csrfToken,
              },
            })
          ).status,
          403,
          `Deny the ${operation} operation without execution permission.`,
        );
      }
      await migrator.query(
        "UPDATE cc.application_principals SET permissions=ARRAY['identity:read','diagnostics:read','diagnostics:run'] WHERE id=$1",
        [principalId],
      );
      for (const cookie of [
        `${sessionCookie}; ${sessionCookie}`,
        '__Host-cc-session=invalid',
        '__Host-cc-session=' + 'é'.repeat(64),
      ])
        assert.equal(
          (await request(`${publicOrigin}/api/auth/session`, { ca, cookie }))
            .status,
          401,
        );
      for (const operation of ['postgresql', 'redis', 'kestra', 'artifacts']) {
        const check = await request(
          `${publicOrigin}/api/diagnostics/${operation}`,
          {
            ca,
            cookie: sessionCookie,
            method: 'POST',
            body: {},
            headers: {
              origin: publicOrigin,
              'x-csrf-token': session.csrfToken,
            },
          },
        );
        assert.equal(check.status, 201, check.text);
        assert.equal(JSON.parse(check.text).status, 'passed', check.text);
      }
      assert.equal(
        (await runtime.query('SELECT id FROM cc.artifacts')).rowCount,
        0,
      );
      const runDiagnostic = async (operation) => {
        const response = await request(
          `${publicOrigin}/api/diagnostics/${operation}`,
          {
            ca,
            cookie: sessionCookie,
            method: 'POST',
            body: {},
            headers: {
              origin: publicOrigin,
              'x-csrf-token': session.csrfToken,
            },
          },
        );
        assert.equal(response.status, 201, response.text);
        const result = JSON.parse(response.text);
        assert.equal(
          result.correlationId,
          response.headers['x-correlation-id'],
        );
        return result;
      };
      await migrator.query(
        "ALTER TABLE cc.security_events ADD CONSTRAINT reject_synthetic_transaction CHECK(detail <> 'transaction-fixture')",
      );
      let failedTransaction;
      try {
        failedTransaction = await runDiagnostic('postgresql');
        assert.equal(failedTransaction.status, 'failed');
        assert.equal(
          failedTransaction.message,
          'The check failed. Inspect the service configuration and retry.',
        );
        assert.equal(
          (
            await migrator.query(
              "SELECT id FROM cc.security_events WHERE detail='transaction-fixture'",
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await migrator.query(
              "SELECT id FROM cc.security_events WHERE event='diagnostic-failed' AND correlation_id=$1",
              [failedTransaction.correlationId],
            )
          ).rowCount,
          1,
        );
      } finally {
        await migrator.query(
          'ALTER TABLE cc.security_events DROP CONSTRAINT reject_synthetic_transaction',
        );
      }
      assert.equal((await runDiagnostic('postgresql')).status, 'passed');

      configureRedisAccess(
        'resetkeys',
        '~cc:auth:*',
        '~cc:diagnostics:reservation',
        '~cc:diagnostics:health',
      );
      try {
        const failedRedis = await runDiagnostic('redis');
        assert.equal(failedRedis.status, 'failed');
        assert.equal(
          failedRedis.message,
          'The check failed. Inspect the service configuration and retry.',
        );
        assert.equal(
          (
            await request(`${publicOrigin}/api/auth/session`, {
              ca,
              cookie: sessionCookie,
            })
          ).status,
          200,
        );
      } finally {
        configureRedisAccess('resetkeys', ...applicationRedisAcl.split(' '));
      }
      assert.equal((await runDiagnostic('redis')).status, 'passed');
      const executions = await fetch(
        `${kestraFixture.origin}/api/v1/main/executions/search?namespace=campus.application`,
        { headers: { authorization: kestraFixture.authorization } },
      ).then((response) => response.json());
      assert.ok(
        executions.results.some(
          (execution) => execution.state.current === 'SUCCESS',
        ),
      );
      const duplicateFlow = await fetch(
        `${kestraFixture.origin}/api/v1/main/flows`,
        {
          method: 'POST',
          headers: {
            authorization: kestraFixture.authorization,
            'content-type': 'application/x-yaml',
          },
          body: await readFile('deployment/kestra/phase2-connection.yaml'),
        },
      );
      assert.equal(duplicateFlow.status, 422);
      const rotatedDispatch = randomUUID();
      await kestraFixture.rotateWorker(rotatedDispatch);
      const dispatchBody = {
        executionId: 'rotation-check',
        correlationId: randomUUID(),
        marker: 'synthetic',
      };
      for (const authorization of [undefined, `Bearer ${password}`]) {
        assert.equal(
          (
            await fetch(`${kestraFixture.workerOrigin}/dispatch/synthetic`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(authorization ? { authorization } : {}),
              },
              body: JSON.stringify(dispatchBody),
            })
          ).status,
          401,
        );
      }
      const failedDispatch = await request(
        `${publicOrigin}/api/diagnostics/kestra`,
        {
          ca,
          cookie: sessionCookie,
          method: 'POST',
          body: {},
          headers: { origin: publicOrigin, 'x-csrf-token': session.csrfToken },
        },
      );
      assert.equal(JSON.parse(failedDispatch.text).status, 'failed');
      await kestraFixture.rotateKestraDispatch(rotatedDispatch);
      const recoveredDispatch = await request(
        `${publicOrigin}/api/diagnostics/kestra`,
        {
          ca,
          cookie: sessionCookie,
          method: 'POST',
          body: {},
          headers: { origin: publicOrigin, 'x-csrf-token': session.csrfToken },
        },
      );
      assert.equal(JSON.parse(recoveredDispatch.text).status, 'passed');

      assert.equal(
        (await request(valid.callback, { ca, cookie: valid.cookie })).headers
          .location,
        '/login?error=sign-in-failed',
      );
      assert.equal(
        (await login({ wrongState: true })).finish.headers.location,
        '/login?error=sign-in-failed',
      );
      invalidNonce = true;
      assert.equal(
        (await login()).finish.headers.location,
        '/login?error=sign-in-failed',
      );
      invalidNonce = false;
      invalidAudience = true;
      assert.equal(
        (await login()).finish.headers.location,
        '/login?error=sign-in-failed',
      );
      invalidAudience = false;
      invalidIssuer = true;
      assert.equal(
        (await login()).finish.headers.location,
        '/login?error=sign-in-failed',
      );
      invalidIssuer = false;
      subject = 'uninvited';
      assert.equal(
        (await login()).finish.headers.location,
        '/login?error=sign-in-failed',
      );
      subject = 'administrator';
      for (const container of [names[0], names[1]]) {
        console.log(
          'Pause dependency:',
          container === names[0] ? 'PostgreSQL' : 'Redis',
        );
        docker('pause', container);
        try {
          const start = Date.now();
          assert.equal(
            (
              await request(`${publicOrigin}/api/auth/session`, {
                ca,
                cookie: sessionCookie,
              })
            ).status,
            503,
          );
          assert.ok(
            Date.now() - start < 8000,
            'Paused dependencies must fail within the request budget.',
          );
        } finally {
          docker('unpause', container);
          console.log('Resumed dependency.');
        }
        assert.equal(
          (
            await request(`${publicOrigin}/api/auth/session`, {
              ca,
              cookie: sessionCookie,
            })
          ).status,
          200,
        );
      }
      await redis.set('cc:diagnostics:reservation', randomUUID(), { EX: 60 });
      assert.equal(
        (
          await request(`${publicOrigin}/api/diagnostics/postgresql`, {
            ca,
            cookie: sessionCookie,
            method: 'POST',
            body: {},
            headers: {
              origin: publicOrigin,
              'x-csrf-token': session.csrfToken,
            },
          })
        ).status,
        429,
      );
      await redis.del('cc:diagnostics:reservation');
      const preferences = { theme: 'dark', navigationCollapsed: true };
      for (const headers of [
        {},
        { origin: publicOrigin },
        { origin: 'https://wrong.example', 'x-csrf-token': session.csrfToken },
        { origin: 'null', 'x-csrf-token': session.csrfToken },
        { origin: publicOrigin, 'x-csrf-token': '0'.repeat(64) },
        {
          origin: publicOrigin,
          'x-csrf-token': session.csrfToken,
          'content-type': 'text/plain',
        },
      ]) {
        const denied = await request(`${publicOrigin}/api/auth/preferences`, {
          ca,
          cookie: sessionCookie,
          method: 'POST',
          body: preferences,
          headers,
        });
        assert.equal(denied.status, 403);
        assert.equal(denied.headers['cache-control'], 'no-store');
        assert.equal(denied.headers['access-control-allow-origin'], undefined);
        assert.equal(JSON.parse(denied.text).code, 'forbidden');
        assert.ok(!denied.text.includes(session.csrfToken));
        assert.ok(!denied.text.includes(password));
      }
      const headers = {
        origin: publicOrigin,
        'x-csrf-token': session.csrfToken,
      };
      for (const body of [
        { ...preferences, theme: 'invalid' },
        { ...preferences, permissions: ['diagnostics:run'] },
      ]) {
        const invalid = await request(`${publicOrigin}/api/auth/preferences`, {
          ca,
          cookie: sessionCookie,
          method: 'POST',
          body,
          headers,
        });
        assert.equal(invalid.status, 400);
        assert.equal(JSON.parse(invalid.text).code, 'invalid-request');
        assert.equal(invalid.headers['cache-control'], 'no-store');
      }
      assert.deepEqual(
        (
          await migrator.query(
            'SELECT preferences FROM cc.application_principals WHERE id=$1',
            [principalId],
          )
        ).rows[0].preferences,
        session.identity.preferences,
      );
      assert.equal(
        (
          await request(`${publicOrigin}/api/auth/preferences`, {
            ca,
            cookie: sessionCookie,
            method: 'POST',
            body: preferences,
            headers,
          })
        ).status,
        201,
      );
      assert.deepEqual(
        JSON.parse(
          (
            await request(`${publicOrigin}/api/auth/session`, {
              ca,
              cookie: sessionCookie,
            })
          ).text,
        ).identity.preferences,
        preferences,
      );
      const exited = once(api, 'exit');
      oidcPassword = randomUUID();
      assert.equal(
        (await login()).finish.headers.location,
        '/login?error=sign-in-failed',
      );
      await secret('oidc-secret', oidcPassword);
      api.kill('SIGTERM');
      await exited;
      api = await startApi();
      assert.equal((await login()).finish.headers.location, '/');
      assert.equal(
        (
          await request(`${publicOrigin}/api/auth/session`, {
            ca,
            cookie: sessionCookie,
          })
        ).status,
        200,
      );
      await changeApplicationAccess(
        migrator,
        { action: 'revoke', principalId, expectedVersion: 1 },
        issuer,
      );
      assert.equal(
        (
          await request(`${publicOrigin}/api/auth/session`, {
            ca,
            cookie: sessionCookie,
          })
        ).status,
        401,
      );
      await assert.rejects(
        changeApplicationAccess(
          migrator,
          {
            action: 'replace',
            principalId,
            expectedVersion: 1,
            issuer,
            subject: 'administrator',
            displayName: 'Synthetic administrator',
          },
          issuer,
        ),
        /version changed/,
      );
      await changeApplicationAccess(
        migrator,
        {
          action: 'replace',
          principalId,
          expectedVersion: 2,
          issuer,
          subject: 'administrator',
          displayName: 'Synthetic administrator',
        },
        issuer,
      );
      const second = await login();
      const secondCookie = second.finish.headers['set-cookie']
        .find((entry) => entry.startsWith('__Host-cc-session='))
        .split(';')[0];
      const secondSession = JSON.parse(
        (
          await request(`${publicOrigin}/api/auth/session`, {
            ca,
            cookie: secondCookie,
          })
        ).text,
      );
      const replicaPort = await freePort();
      await startApi(replicaPort);
      const replicaOrigin = `https://127.0.0.1:${replicaPort}`;
      assert.equal(
        (
          await request(`${replicaOrigin}/api/auth/session`, {
            ca,
            cookie: secondCookie,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request(`${replicaOrigin}/api/auth/logout`, {
            ca,
            cookie: secondCookie,
            method: 'POST',
            body: {},
            headers: {
              origin: publicOrigin,
              'x-csrf-token': secondSession.csrfToken,
            },
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await request(`${publicOrigin}/api/auth/session`, {
            ca,
            cookie: secondCookie,
          })
        ).status,
        401,
      );
      for (const expiry of ['absolute', 'idle']) {
        const grant = await login();
        const cookie = grant.finish.headers['set-cookie']
          .find((entry) => entry.startsWith('__Host-cc-session='))
          .split(';')[0];
        const key = `cc:auth:session:${createHash('sha256').update(cookie.split('=')[1]).digest('hex')}`;
        if (expiry === 'absolute') {
          const value = JSON.parse(await redis.get(key));
          value.expiresAt = Date.now() - 1000;
          await redis.set(key, JSON.stringify(value), { EX: 60 });
        } else {
          await redis.expire(key, 1);
          await delay(1100);
        }
        assert.equal(
          (await request(`${publicOrigin}/api/auth/session`, { ca, cookie }))
            .status,
          401,
          expiry,
        );
        assert.equal(await redis.get(key), null);
      }
      const events = await migrator.query(
        'SELECT event,correlation_id FROM cc.security_events',
      );
      for (const event of [
        'access-granted',
        'access-revoked',
        'identity-replaced',
        'login-started',
        'login-succeeded',
        'login-denied',
        'logout',
        'preferences-changed',
        'diagnostic-passed',
      ])
        assert.ok(
          events.rows.some((row) => row.event === event),
          event,
        );
      assert.ok(!output.includes(password));
      assert.ok(!output.includes(session.csrfToken));
      assert.ok(!output.includes('synthetic-access-token'));
      assert.ok(events.rows.some((row) => row.event === 'access-denied'));
      browser = await chromium.launch({
        args: ['--host-resolver-rules=MAP host.docker.internal 127.0.0.1'],
      });
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        reducedMotion: 'reduce',
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      const browserErrors = [];
      page.on('pageerror', (error) => browserErrors.push(error.message));
      const policyErrors = [];
      page.on('console', (message) => {
        if (/Content Security Policy/i.test(message.text()))
          policyErrors.push(message.text());
      });
      await page.goto(publicOrigin);
      await expect(
        page.getByRole('heading', { name: 'Sign in', exact: true }),
      ).toBeVisible();
      await auditAccessibility(page, 'login');
      // Capture the status before navigation replaces the document.
      let signInProgressObserved = false;
      const recordSignInProgress = (message) => {
        if (message.text() === 'cc-qualification:sign-in-progress')
          signInProgressObserved = true;
      };
      page.on('console', recordSignInProgress);
      await page.evaluate(() => {
        const observer = new MutationObserver(() => {
          if (
            document.querySelector('[role="status"]')?.textContent?.trim() ===
            'Connecting to sign-in.'
          ) {
            console.debug('cc-qualification:sign-in-progress');
            observer.disconnect();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
      const signInResponse = Promise.withResolvers();
      await page.route('**/api/auth/login', async (route) => {
        await signInResponse.promise;
        await route.continue();
      });
      const signInNavigation = page
        .getByRole('link', { name: 'Sign in to Campus Commander' })
        .click();
      try {
        await expect.poll(() => signInProgressObserved).toBe(true);
      } finally {
        signInResponse.resolve();
        await signInNavigation;
        await page.unroute('**/api/auth/login');
        page.off('console', recordSignInProgress);
      }
      await expect(
        page.getByRole('heading', { name: 'Your account', exact: true }),
      ).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute(
        'data-theme',
        preferences.theme,
      );
      await expect(page.locator('#identity-title')).toHaveCSS(
        'color',
        'rgb(232, 234, 237)',
      );
      await auditAccessibility(page, 'account');
      if (packaged) {
        const metadata = JSON.parse(
          (await request(`${publicOrigin}/api/application`, { ca })).text,
        );
        const built = JSON.parse(
          docker('image', 'inspect', applicationImages.api),
        )[0];
        assert.equal(
          metadata.build,
          built.Config.Labels['org.opencontainers.image.revision'],
        );
        assert.equal(
          metadata.version,
          built.Config.Labels['org.opencontainers.image.version'],
        );
        await expect(page.locator('footer')).toContainText(metadata.build);
      }
      await page.getByRole('button', { name: 'Choose theme' }).click();
      await page.getByRole('menuitem', { name: 'Use dark theme' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page
        .getByRole('link', { name: 'Diagnostics', exact: true })
        .first()
        .click();
      await expect(
        page.getByRole('heading', { name: 'Diagnostics', exact: true }),
      ).toBeVisible();
      for (const label of [
        'PostgreSQL',
        'Redis',
        'Kestra',
        'Artifact storage',
      ]) {
        const card = page.getByRole('article').filter({
          has: page.getByRole('heading', { name: label, exact: true }),
        });
        await card
          .getByRole('button', { name: `Check ${label}`, exact: true })
          .click();
        await expect(
          card.getByText(
            'The check passed. The service returned the expected result.',
          ),
        ).toBeVisible();
      }
      const artifactDirectory = 'dist/phase-2-evidence';
      await mkdir(artifactDirectory, { recursive: true });
      await expect(page.locator('html')).toHaveCSS(
        'background-color',
        'rgb(18, 18, 18)',
      );
      await page.evaluate(() => document.fonts.ready);
      assert.equal(
        await page.evaluate(() =>
          document.fonts.check('24px "Material Symbols Outlined"'),
        ),
        true,
      );
      await page.screenshot({
        path: `${artifactDirectory}/diagnostics-dark.png`,
        fullPage: true,
      });
      await auditAccessibility(page, 'diagnostics-dark');
      await page.getByRole('button', { name: 'Choose theme' }).click();
      await page.getByRole('menuitem', { name: 'Use light theme' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect(page.locator('html')).toHaveCSS(
        'background-color',
        'rgb(248, 250, 252)',
      );
      await expect(page.getByRole('menu')).toHaveCount(0);
      await page.screenshot({
        path: `${artifactDirectory}/diagnostics-light.png`,
        fullPage: true,
      });
      await page.keyboard.press('Escape');
      await auditAccessibility(page, 'diagnostics-light');
      await page.getByRole('button', { name: 'Choose theme' }).click();
      await page.getByRole('menuitem', { name: 'Use system theme' }).click();
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await expect(page.locator('html')).toHaveCSS(
        'background-color',
        'rgb(18, 18, 18)',
      );
      await page.emulateMedia({ colorScheme: 'light' });
      await expect(page.locator('html')).toHaveCSS(
        'background-color',
        'rgb(248, 250, 252)',
      );
      await page.evaluate(() => {
        document.body.style.zoom = '2';
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.getByRole('button', { name: 'Refresh connections' }).focus();
      await expect(
        page.getByRole('button', { name: 'Refresh connections' }),
      ).toBeInViewport();
      await page.evaluate(() => {
        document.body.style.zoom = '';
      });
      const kestraCard = page.getByRole('article').filter({
        has: page.getByRole('heading', { name: 'Kestra', exact: true }),
      });
      docker('pause', kestraFixture.kestraName);
      try {
        await kestraCard
          .getByRole('button', { name: 'Check Kestra', exact: true })
          .click();
        await expect(
          kestraCard.getByText(
            'The service did not respond before the time limit. Check its connection and retry.',
          ),
        ).toBeVisible({ timeout: 12000 });
      } finally {
        docker('unpause', kestraFixture.kestraName);
      }
      await kestraCard
        .getByRole('button', { name: 'Check Kestra', exact: true })
        .click();
      await expect(
        kestraCard.getByText(
          'The check passed. The service returned the expected result.',
        ),
      ).toBeVisible();
      const storageCard = page.getByRole('article').filter({
        has: page.getByRole('heading', {
          name: 'Artifact storage',
          exact: true,
        }),
      });
      await chmod(config.artifacts.location, 0o000);
      try {
        await storageCard
          .getByRole('button', { name: 'Check Artifact storage', exact: true })
          .click();
        await expect(
          storageCard.getByText(
            'The check failed. Inspect the service configuration and retry.',
          ),
        ).toBeVisible();
      } finally {
        await chmod(config.artifacts.location, 0o700);
      }
      await storageCard
        .getByRole('button', { name: 'Check Artifact storage', exact: true })
        .click();
      await expect(
        storageCard.getByText(
          'The check passed. The service returned the expected result.',
        ),
      ).toBeVisible();
      await context.setOffline(true);
      await page.getByRole('button', { name: 'Refresh connections' }).click();
      await expect(page.getByRole('alert')).toContainText(
        'Connection status is unavailable.',
      );
      await expect(
        page.getByText('Stale observation', { exact: false }),
      ).toBeVisible();
      assert.equal(
        await page
          .getByText(
            'The check passed. The service returned the expected result.',
          )
          .count(),
        4,
      );
      await context.setOffline(false);
      await page.getByRole('button', { name: 'Refresh connections' }).click();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await page.getByRole('button', { name: 'Choose theme' }).focus();
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('menuitem', { name: 'Use system theme' }),
      ).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(
        page.getByRole('button', { name: 'Choose theme' }),
      ).toBeFocused();
      await page.setViewportSize({ width: 320, height: 720 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.keyboard.press('Tab');
      assert.ok(
        await page.evaluate(() => document.activeElement !== document.body),
      );
      await page.getByRole('button', { name: 'Open user menu' }).click();
      await page.getByRole('menuitem', { name: 'Sign out' }).click();
      await expect(
        page.getByRole('heading', { name: 'Sign in', exact: true }),
      ).toBeVisible();
      assert.deepEqual(browserErrors, []);
      assert.deepEqual(policyErrors, []);
      await context.close();
      docker('stop', names[1]);
      assert.equal(
        (
          await request(`${publicOrigin}/api/auth/session`, {
            ca,
            cookie: sessionCookie,
          })
        ).status,
        503,
      );
      await writeFile(
        `${artifactDirectory}/${packaged ? 'packaged' : 'source'}-integration.json`,
        JSON.stringify(
          {
            status: 'passed',
            recordedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            environment:
              'one Docker host, synthetic HTTPS OIDC provider, two API replicas, real PostgreSQL, Redis, Kestra, worker, artifact storage, and Chromium',
            browser: browser.version(),
            packagedApplicationImages: packaged,
            images: packaged
              ? Object.fromEntries(
                  Object.entries(applicationImages).map(([service, ref]) => {
                    const inspected = JSON.parse(
                      docker('image', 'inspect', ref),
                    )[0];
                    return [
                      service,
                      {
                        reference: ref,
                        id: inspected.Id,
                        labels: inspected.Config.Labels,
                      },
                    ];
                  }),
                )
              : undefined,
            checks: [
              'OIDC sign-in and forged callback denial',
              'OIDC client credential rotation',
              'worker credential rotation',
              'cross-replica sessions and logout',
              'absolute and idle expiry',
              'revocation and recovery',
              'database and Redis timeout recovery',
              'four live utility operations',
              'execution permission denial for all four utility operations',
              'PostgreSQL transaction rejection, rollback, audit, and retry',
              'Redis diagnostic key denial, preserved session, and retry',
              'origin, CSRF, content-type, and preference-tampering rejection',
              'uncached redacted errors without permissive CORS',
              'browser sign-in and sign-out',
              'persisted preferences',
              'system and explicit themes',
              'offline observation recovery',
              'keyboard focus and menus',
              'CSS zoom 200 percent',
              '320 pixel reflow',
            ],
            limits: [
              'Full deployment profile qualification remains separate.',
              'Human screen-reader walkthrough remains unperformed.',
              'Synthetic provider evidence does not qualify a district identity provider.',
            ],
          },
          null,
          2,
        ),
      );
    } finally {
      await browser?.close();
      if (edgeServer) {
        edgeServer.closeAllConnections();
        await new Promise((resolve) => edgeServer.close(resolve));
      }
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const ended = once(child, 'exit');
          child.kill('SIGTERM');
          await ended;
        }
      if (redis?.isOpen) redis.destroy();
      if (issuerServer)
        await new Promise((resolve) => issuerServer.close(resolve));
      await Promise.allSettled(clients.map((client) => client.end()));
      for (const name of names) {
        try {
          docker('rm', '-f', name);
        } catch {
          /* The test records ownership before startup. */
        }
      }
      try {
        docker('network', 'rm', network);
      } catch {
        /* Retain an occupied network for inspection. */
      }
      await rm(secretRoot, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
);
