import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  applicationRedisAcl,
  redisImage,
} from '../deployment/redis/runtime.mjs';
import { postgresImage } from '../deployment/profiles/all-docker/render.mjs';
import { outerDocker } from './hybrid-hosts-fixture.mjs';

const execute = promisify(execFile);

/** Prepare synthetic district certificates and externally managed services. */
export async function createHybridServices(fixture, project) {
  const root = fixture.hosts[0].root;
  const privateRoot = join(root, 'private');
  await mkdir(privateRoot, { mode: 0o700 });
  const certificate = join(privateRoot, 'district-ca');
  const key = join(privateRoot, 'district-ca-private-key');
  const openssl = (args) => execute('openssl', args, { timeout: 30000 });
  await openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=Phase 2 distributed hybrid fixture',
    '-keyout',
    key,
    '-out',
    certificate,
  ]);
  await chmod(key, 0o600);
  await chmod(certificate, 0o600);
  for (const [name, hostname] of [
    ['frontend', 'frontend'],
    ['api', 'api'],
    ['workers', 'workers.fixture.test'],
    ['kestra', 'kestra'],
    ['edge', 'campus.example.org'],
    ['district-postgres', 'district-postgres.fixture.test'],
    ['district-redis', 'district-redis.fixture.test'],
    ['provider', 'host.docker.internal'],
  ]) {
    const path = (suffix) => join(privateRoot, `${name}-${suffix}`);
    await openssl([
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      `/CN=${hostname}`,
      '-keyout',
      path('private-key'),
      '-out',
      path('request'),
    ]);
    await writeFile(
      path('extensions'),
      `subjectAltName=DNS:${hostname}\nextendedKeyUsage=serverAuth\n`,
    );
    await openssl([
      'x509',
      '-req',
      '-days',
      '1',
      '-in',
      path('request'),
      '-CA',
      certificate,
      '-CAkey',
      key,
      '-CAcreateserial',
      '-extfile',
      path('extensions'),
      '-out',
      path('certificate'),
    ]);
    await chmod(path('private-key'), 0o600);
    await chmod(path('certificate'), 0o600);
  }
  for (const name of [
    'district-postgres-admin-password',
    'campus-database-password',
    'kestra-database-password',
    'postgres-migrator',
    'redis-password',
    'oidc-client',
  ])
    await writeFile(
      join(privateRoot, name),
      randomBytes(32).toString('base64url'),
      { mode: 0o600 },
    );
  const owned = [];
  const close = async () => {
    const failures = [];
    for (const name of [...owned].reverse()) {
      try {
        await outerDocker(['rm', '-f', '-v', name]);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        'District service fixture cleanup failed.',
      );
  };
  try {
    const database = `${project}-postgres`;
    await outerDocker([
      'run',
      '-d',
      '--name',
      database,
      '--network',
      fixture.network,
      '-e',
      'POSTGRES_PASSWORD_FILE=/run/secrets/admin-password',
      '--mount',
      `type=bind,source=${join(privateRoot, 'district-postgres-admin-password')},target=/run/secrets/admin-password,readonly`,
      '--mount',
      `type=bind,source=${join(privateRoot, 'district-postgres-certificate')},target=/input/server.crt,readonly`,
      '--mount',
      `type=bind,source=${join(privateRoot, 'district-postgres-private-key')},target=/input/server.key,readonly`,
      '--tmpfs',
      '/run/postgres-tls:mode=0700',
      '--entrypoint',
      '/bin/sh',
      postgresImage,
      '-ec',
      'cp /input/server.crt /run/postgres-tls/server.crt\ncp /input/server.key /run/postgres-tls/server.key\nchown -R postgres:postgres /run/postgres-tls\nchmod 600 /run/postgres-tls/server.key\nexec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/run/postgres-tls/server.crt -c ssl_key_file=/run/postgres-tls/server.key',
    ]);
    owned.push(database);
    let databaseReady = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await outerDocker(['exec', database, 'pg_isready', '-U', 'postgres']);
        databaseReady = true;
        break;
      } catch {
        await new Promise((done) => setTimeout(done, 1000));
      }
    }
    if (!databaseReady)
      throw new Error('The synthetic district database did not start.');
    const redis = `${project}-redis`;
    const redisConfig = join(privateRoot, 'redis.conf');
    const passwordHash = createHash('sha256')
      .update(await readFile(join(privateRoot, 'redis-password')))
      .digest('hex');
    await writeFile(
      redisConfig,
      [
        'bind 0.0.0.0',
        'protected-mode yes',
        'daemonize no',
        'logfile ""',
        'save ""',
        'appendonly no',
        'enable-debug-command no',
        'enable-module-command no',
        `user default on #${passwordHash} ${applicationRedisAcl}`,
        'port 0',
        'tls-port 6379',
        'tls-cert-file /run/tls/server.crt',
        'tls-key-file /run/tls/server.key',
        'tls-auth-clients no',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    await outerDocker([
      'run',
      '-d',
      '--name',
      redis,
      '--network',
      fixture.network,
      '--user',
      '1000:1000',
      '--read-only',
      '--tmpfs',
      '/data:uid=1000,gid=1000,mode=0700',
      '--mount',
      `type=bind,source=${redisConfig},target=/run/redis.conf,readonly`,
      '--mount',
      `type=bind,source=${join(privateRoot, 'district-redis-certificate')},target=/run/tls/server.crt,readonly`,
      '--mount',
      `type=bind,source=${join(privateRoot, 'district-redis-private-key')},target=/run/tls/server.key,readonly`,
      redisImage,
      'redis-server',
      '/run/redis.conf',
    ]);
    owned.push(redis);
    const address = async (name) =>
      JSON.parse(await outerDocker(['inspect', name]))[0].NetworkSettings
        .Networks[fixture.network].IPAddress;
    await fixture.mapHosts({
      'district-postgres.fixture.test': [await address(database)],
      'district-redis.fixture.test': [await address(redis)],
    });
    return { root, privateRoot, database, redis, close };
  } catch (error) {
    await close();
    throw error;
  }
}
