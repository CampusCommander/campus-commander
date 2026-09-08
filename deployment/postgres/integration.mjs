import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  checkReadiness,
  connectDatabase,
  loadMigrations,
  migrate,
  provision,
  verifyConnection,
} from './index.mjs';
import {
  generateBootstrapCredential,
  initializeBootstrap,
  replaceBootstrap,
  revokeBootstrap,
  verifyBootstrap,
} from '../bootstrap/access.mjs';

const qualification = JSON.parse(
  await readFile(new URL('./qualification.json', import.meta.url), 'utf8'),
);
const name = `cc7-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), 'cc7-'));
const password = randomUUID();
const databaseSettings = {
  application: {
    database: 'cc-app',
    role: 'cc-app',
    password,
    migrationRole: 'cc-migrator',
    migrationPassword: password,
  },
  kestra: { database: 'cc-kestra', role: 'cc-kestra', password },
};
const clients = new Set();
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
let port;
async function connect(user = 'postgres', database = 'postgres') {
  const client = new pg.Client({
    host: '127.0.0.1',
    port,
    user,
    database,
    password,
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  clients.add(client);
  return client;
}
async function close(client) {
  clients.delete(client);
  await client.end();
}
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await connect();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  console.error(docker('logs', name));
  throw new Error('Synthetic PostgreSQL did not start.');
}
const results = [];
try {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      join(directory, 'server.key'),
      '-out',
      join(directory, 'server.crt'),
    ],
    { stdio: 'ignore' },
  );
  await writeFile(
    join(directory, 'postgres.env'),
    `POSTGRES_PASSWORD=${password}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  docker('volume', 'create', name);
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'campus-commander.test=CC-7',
    '--env-file',
    join(directory, 'postgres.env'),
    '-e',
    'POSTGRES_INITDB_ARGS=--encoding=UTF8',
    '-p',
    '127.0.0.1::5432',
    '-v',
    `${name}:/var/lib/postgresql`,
    '-v',
    `${directory}:/tls:ro`,
    '--entrypoint',
    '/bin/sh',
    qualification.image,
    '-c',
    'cp /tls/server.* /tmp/; chown postgres:postgres /tmp/server.*; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key',
  );
  port = Number(docker('port', name, '5432/tcp').split(':').at(-1));
  let admin = await ready();
  const cliConfig = JSON.parse(
    await readFile(
      new URL('../examples/all-docker.json', import.meta.url),
      'utf8',
    ),
  );
  for (const [key, label] of [
    ['applicationDatabase', 'app'],
    ['kestraDatabase', 'kestra'],
  ]) {
    Object.assign(cliConfig.services[key], {
      database: `cli-${label}`,
      role: `cli-${label}`,
      endpoint: {
        url: 'postgresql://127.0.0.1:5432',
        tls: { mode: 'disabled' },
      },
    });
  }
  const operator = {
    adminDatabase: 'postgres',
    adminRole: 'postgres',
    adminPasswordSecretRef: {
      provider: 'file',
      path: '/run/secrets/cli-admin',
    },
    migrationRole: 'cli-migrator',
    migrationPasswordSecretRef: {
      provider: 'file',
      path: '/run/secrets/cli-migrator',
    },
  };
  await writeFile(join(directory, 'cli-admin'), `${password}\n`, {
    mode: 0o600,
  });
  await writeFile(join(directory, 'cli-migrator'), `${password}\r\n`, {
    mode: 0o600,
  });
  await writeFile(
    join(directory, 'campus-database-password'),
    ` ${password} \r\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, 'kestra-database-password'),
    `${password}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, 'cli-profile.json'),
    JSON.stringify(cliConfig),
  );
  await writeFile(
    join(directory, 'cli-operator.json'),
    JSON.stringify(operator),
  );
  const nodeImage = (
    await readFile(new URL('../images/api.Dockerfile', import.meta.url), 'utf8')
  ).match(/^FROM (\S+)/m)[1];
  const runCli = (command) =>
    docker(
      'run',
      '--rm',
      '--network',
      `container:${name}`,
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '-v',
      `${fileURLToPath(new URL('../../', import.meta.url))}:/workspace:ro`,
      '-v',
      `${directory}:/run/secrets:ro`,
      '-w',
      '/workspace',
      nodeImage,
      'node',
      'deployment/postgres/cli.mjs',
      command,
      '/run/secrets/cli-profile.json',
      '/run/secrets/cli-operator.json',
    );
  runCli('provision');
  runCli('migrate');
  const runtimeService = structuredClone(
    cliConfig.services.applicationDatabase,
  );
  runtimeService.endpoint.url = `postgresql://127.0.0.1:${port}`;
  const resolveCli = (ref) =>
    readFile(join(directory, ref.path.split('/').at(-1)));
  const cliRuntime = await connectDatabase(runtimeService, resolveCli);
  clients.add(cliRuntime);
  assert.equal(await checkReadiness(cliRuntime), true);
  await writeFile(
    join(directory, 'campus-database-password'),
    'redacted-fixture-marker\n\n',
    { mode: 0o600 },
  );
  assert.throws(
    () => runCli('provision'),
    (error) => {
      assert.ok(!String(error.stderr).includes('redacted-fixture-marker'));
      assert.match(String(error.stderr), /PostgreSQL command failed/);
      return true;
    },
  );
  await assert.rejects(connectDatabase(runtimeService, resolveCli), (error) => {
    assert.equal(
      error.message,
      'Invalid PostgreSQL secret. Use one non-empty UTF-8 line.',
    );
    return true;
  });
  results.push(
    'actual CLI provisioning and migration accept LF/CRLF secrets; runtime preserves spaces and connects; multiline secrets fail redacted: pass',
  );
  await provision(admin, databaseSettings);
  await provision(admin, databaseSettings);
  const scopedSettings = {
    application: {
      ...databaseSettings.application,
      database: 'scoped-app',
      role: 'scoped-app',
      migrationRole: 'scoped-migrator',
    },
    kestra: {
      ...databaseSettings.kestra,
      database: 'scoped-kestra',
      role: 'scoped-kestra',
    },
  };
  await provision(admin, { ...scopedSettings, only: 'application' });
  assert.equal(
    (
      await admin.query(
        "SELECT 1 FROM pg_database WHERE datname='scoped-kestra'",
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (await admin.query("SELECT 1 FROM pg_roles WHERE rolname='scoped-kestra'"))
      .rowCount,
    0,
  );
  await provision(admin, { ...scopedSettings, only: 'kestra' });
  assert.equal(
    (
      await admin.query(
        "SELECT 1 FROM pg_database WHERE datname='scoped-kestra'",
      )
    ).rowCount,
    1,
  );
  results.push(
    'per-server provisioning creates only the selected database and roles: pass',
  );
  await admin.query(
    `CREATE DATABASE "cc-latin1" OWNER "cc-migrator" ENCODING 'LATIN1' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
  );
  const latin = await connect('cc-migrator', 'cc-latin1');
  await assert.rejects(verifyConnection(latin));
  await assert.rejects(
    provision(admin, {
      ...databaseSettings,
      application: { ...databaseSettings.application, database: 'cc-latin1' },
    }),
  );
  await close(latin);
  results.push('fresh and repeated provisioning: pass');
  results.push('non-UTF8 startup and existing database rejected: pass');
  const runtime = await connect('cc-app', 'cc-app');
  assert.equal(await checkReadiness(runtime), false);
  const migrators = await Promise.all(
    Array.from({ length: 8 }, () => connect('cc-migrator', 'cc-app')),
  );
  await Promise.all(
    migrators.map((client) => migrate(client, { runtimeRole: 'cc-app' })),
  );
  const ledger = await runtime.query(
    'SELECT count(*)::int AS count FROM cc.schema_migrations',
  );
  assert.equal(ledger.rows[0].count, 1);
  assert.equal(await checkReadiness(runtime), true);
  results.push('eight concurrent migrations apply one ledger entry: pass');
  const migrations = await loadMigrations();
  const broken = [
    ...migrations,
    {
      id: '002-broken',
      checksum: 'synthetic',
      sql: 'CREATE TABLE cc.rollback_probe(id int); SELECT 1/0;',
    },
  ];
  await assert.rejects(
    migrate(migrators[0], { runtimeRole: 'cc-app', migrations: broken }),
  );
  assert.equal(await checkReadiness(runtime, broken), false);
  assert.equal(
    (
      await migrators[0].query(
        "SELECT to_regclass('cc.rollback_probe') AS table_name",
      )
    ).rows[0].table_name,
    null,
  );
  await assert.rejects(
    migrate(migrators[0], {
      runtimeRole: 'cc-app',
      migrations: [{ ...migrations[0], checksum: 'altered' }],
    }),
  );
  results.push(
    'failed migration rolls back and blocks release readiness; changed checksum rejected: pass',
  );
  await assert.rejects(runtime.query('CREATE TABLE public.forbidden(id int)'));
  await assert.rejects(runtime.query('DELETE FROM cc.schema_migrations'));
  await assert.rejects(runtime.query('CREATE DATABASE forbidden'));
  await assert.rejects(connect('cc-app', 'cc-kestra'));
  await assert.rejects(connect('cc-kestra', 'cc-app'));
  await assert.rejects(connect('cc-migrator', 'cc-kestra'));
  const kestra = await connect('cc-kestra', 'cc-kestra');
  await verifyConnection(kestra);
  await kestra.query(
    'CREATE TABLE public.kestra_synthetic(id int PRIMARY KEY); INSERT INTO public.kestra_synthetic VALUES (1)',
  );
  await runtime.query(
    `INSERT INTO cc.artifacts(id,backend,locator,schema_version,attempt_id) VALUES ('fixture','local','synthetic/École-学校',1,'attempt-1')`,
  );
  results.push(
    'application DML only; cross-database access denied; Kestra owns its migrations: pass',
  );
  const credential = generateBootstrapCredential();
  assert.deepEqual(await initializeBootstrap(runtime, credential), {
    generation: '1',
    created: true,
  });
  const originalExpiry = (
    await runtime.query('SELECT expires_at FROM cc.bootstrap_access')
  ).rows[0].expires_at.toISOString();
  assert.deepEqual(await initializeBootstrap(runtime, credential), {
    generation: '1',
    created: false,
  });
  assert.equal(
    (
      await runtime.query('SELECT expires_at FROM cc.bootstrap_access')
    ).rows[0].expires_at.toISOString(),
    originalExpiry,
  );
  assert.equal(await verifyBootstrap(runtime, credential), true);
  assert.equal(
    await verifyBootstrap(runtime, generateBootstrapCredential()),
    false,
  );
  await runtime.query(
    "UPDATE cc.bootstrap_access SET expires_at = now() - interval '1 second'",
  );
  assert.equal(await verifyBootstrap(runtime, credential), false);
  const replacement = generateBootstrapCredential();
  assert.deepEqual(await replaceBootstrap(runtime, replacement, '1'), {
    generation: '2',
  });
  await assert.rejects(
    replaceBootstrap(runtime, generateBootstrapCredential(), '1'),
  );
  assert.equal(await verifyBootstrap(runtime, credential), false);
  assert.equal(await verifyBootstrap(runtime, replacement), true);
  assert.equal(await revokeBootstrap(runtime, '2'), true);
  assert.equal(await verifyBootstrap(runtime, replacement), false);
  results.push(
    'bootstrap resume preserves expiry; expiry, replacement CAS, old credential denial, and revocation: pass',
  );
  const ca = await readFile(join(directory, 'server.crt'), 'utf8');
  const external = {
    placement: { kind: 'external' },
    database: 'cc-app',
    role: 'cc-app',
    passwordSecretRef: { key: 'password' },
    endpoint: {
      url: `postgresql://localhost:${port}`,
      tls: { mode: 'private-ca', caSecretRef: { key: 'ca' } },
    },
  };
  const resolve = async (ref) => (ref.key === 'ca' ? ca : password);
  const tlsClient = await connectDatabase(external, resolve);
  clients.add(tlsClient);
  assert.equal(
    (
      await tlsClient.query(
        'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()',
      )
    ).rows[0].ssl,
    true,
  );
  await assert.rejects(
    connectDatabase(
      {
        ...external,
        endpoint: {
          ...external.endpoint,
          url: `postgresql://127.0.0.1:${port}`,
        },
      },
      resolve,
    ),
  );
  await assert.rejects(
    connectDatabase(
      {
        ...external,
        endpoint: { ...external.endpoint, tls: { mode: 'system-ca' } },
      },
      resolve,
    ),
  );
  await assert.rejects(verifyConnection(admin));
  results.push(
    'external adapter verifies CA and hostname; rejects wrong hostname, untrusted CA, and runtime superuser: pass',
  );
  await Promise.all([...clients].map(close));
  docker('restart', name);
  port = Number(docker('port', name, '5432/tcp').split(':').at(-1));
  admin = await ready();
  const restarted = await connect('cc-app', 'cc-app');
  assert.equal(
    (
      await restarted.query('SELECT locator FROM cc.artifacts WHERE id=$1', [
        'fixture',
      ])
    ).rows[0].locator,
    'synthetic/École-学校',
  );
  assert.equal(await checkReadiness(restarted), true);
  const restartedKestra = await connect('cc-kestra', 'cc-kestra');
  assert.equal(
    (
      await restartedKestra.query(
        'SELECT count(*)::int AS count FROM public.kestra_synthetic',
      )
    ).rows[0].count,
    1,
  );
  results.push(
    'application and Kestra fixtures survive PostgreSQL restart: pass',
  );
  console.log(
    JSON.stringify(
      {
        qualification,
        results,
        externalDistrictHost: 'not-run: no district endpoint supplied',
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.allSettled([...clients].map(close));
  try {
    docker('rm', '-f', name);
  } catch {
    /* The container was not created. */
  }
  try {
    docker('volume', 'rm', name);
  } catch {
    /* The volume was not created. */
  }
  await rm(directory, { recursive: true, force: true });
}
