import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { migrate, provision } from '../postgres/index.mjs';
import { createArtifactStore } from '../storage/index.mjs';
import { changeApplicationAccess } from '../bootstrap/application-access.mjs';
import { createOperationsCliFixture } from './cli-fixture.mjs';
import { noOtherConnections } from './quiescence.mjs';
import {
  backupFoundation,
  postgresToolArguments,
  restoreFoundation,
  verifyBackup,
} from './index.mjs';

const name = `cc-restore-${randomUUID()}`,
  root = await mkdtemp(join(tmpdir(), 'cc-restore-'));
const cli = process.env.CC_OPERATIONS_CLI === '1';
const native = cli || process.env.CC_OPERATIONS_NATIVE === '1';
const toolVersions = native
  ? Object.fromEntries(
      ['pg_dump', 'pg_restore'].map((tool) => [
        tool,
        execFileSync(tool, ['--version'], { encoding: 'utf8' }).trim(),
      ]),
    )
  : undefined;
const password = randomUUID();
let encryptionKey = randomBytes(32);
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const pin = JSON.parse(
  await readFile(
    new URL('../postgres/qualification.json', import.meta.url),
    'utf8',
  ),
);
const keyRecovery = {
  id: 'synthetic-backup-key',
  version: 1,
  reference: { provider: 'file', path: '/run/secrets/backup-key' },
};
const resolveSecret = async (reference) =>
  reference.path === '/run/secrets/backup-key'
    ? encryptionKey
    : Buffer.from(`${password}\r\n`);
let admin, pool, store, operatorCli;
const clients = [];
try {
  if (cli) {
    operatorCli = await createOperationsCliFixture(
      join(root, 'operator-cli'),
      resolveSecret,
      {
        container: process.env.CC_OPERATIONS_CLI_CONTAINER === '1',
        mountDirectories: [root],
      },
    );
    encryptionKey.fill(0);
    encryptionKey = await operatorCli.generateKey();
    assert.equal(encryptionKey.length, 32);
    await assert.rejects(operatorCli.generateKey());
  }
  await writeFile(
    join(root, 'postgres.env'),
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
    'campus-commander.test=restore',
    '--env-file',
    join(root, 'postgres.env'),
    '-p',
    '127.0.0.1::5432',
    '-v',
    `${name}:/var/lib/postgresql`,
    pin.image,
  );
  const port = Number(docker('port', name, '5432/tcp').split(':').at(-1));
  const connection = { host: '127.0.0.1', port, password };
  for (let attempt = 0; attempt < 100; attempt++) {
    admin = new pg.Client({
      ...connection,
      user: 'postgres',
      database: 'postgres',
    });
    try {
      await admin.connect();
      break;
    } catch {
      await admin.end();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const settings = (suffix) => ({
    application: {
      database: `app-${suffix}`,
      role: `app-${suffix}`,
      password,
      migrationRole: `migrator-${suffix}`,
      migrationPassword: password,
    },
    kestra: {
      database: `kestra-${suffix}`,
      role: `kestra-${suffix}`,
      password,
    },
  });
  await provision(admin, settings('source'));
  await provision(admin, settings('target'));
  await provision(admin, settings('failed'));
  await admin.end();
  admin = undefined;
  const migration = new pg.Client({
    ...connection,
    user: 'migrator-source',
    database: 'app-source',
  });
  await migration.connect();
  await migrate(migration, { runtimeRole: 'app-source' });
  const { principalId } = await changeApplicationAccess(
    migration,
    {
      action: 'initialize',
      issuer: 'https://identity.example.invalid',
      subject: 'restore-administrator',
      displayName: 'Restore administrator',
    },
    'https://identity.example.invalid',
  );
  await migration.query(
    'UPDATE cc.application_principals SET preferences=$1 WHERE id=$2',
    [{ theme: 'dark', navigationCollapsed: true }, principalId],
  );
  const originalPrincipals = (
    await migration.query('SELECT * FROM cc.application_principals ORDER BY id')
  ).rows;
  const originalEvents = (
    await migration.query('SELECT * FROM cc.security_events ORDER BY id')
  ).rows;
  await migration.end();
  const sourceRoots = {
    artifacts: join(root, 'source-artifacts'),
    kestraInternal: join(root, 'source-kestra'),
  };
  await mkdir(sourceRoots.artifacts, { mode: 0o700 });
  await mkdir(sourceRoots.kestraInternal, { mode: 0o700 });
  await mkdir(join(sourceRoots.kestraInternal, 'executions'), { mode: 0o700 });
  const bytes = Buffer.from('Synthetic restore École 学校');
  await writeFile(
    join(sourceRoots.kestraInternal, 'executions', 'fixture.json'),
    JSON.stringify({ executionId: 'synthetic-1', state: 'SUCCESS' }),
  );
  pool = new pg.Pool({
    ...connection,
    user: 'app-source',
    database: 'app-source',
  });
  store = await createArtifactStore({ pool, root: sourceRoots.artifacts });
  const artifact = await store.stage(
    {
      schemaVersion: 1,
      expectedSizeBytes: bytes.length,
      expectedSha256: createHash('sha256').update(bytes).digest('hex'),
    },
    [bytes],
  );
  await store.publish(artifact);
  await store.close();
  store = undefined;
  await pool.end();
  pool = undefined;
  const kestra = new pg.Client({
    ...connection,
    user: 'kestra-source',
    database: 'kestra-source',
  });
  await kestra.connect();
  await kestra.query(
    "CREATE TABLE synthetic_execution(id text PRIMARY KEY,state text NOT NULL); INSERT INTO synthetic_execution VALUES ('synthetic-1','SUCCESS')",
  );
  await kestra.end();
  const config = JSON.parse(
    await readFile(
      new URL('../examples/all-docker.json', import.meta.url),
      'utf8',
    ),
  );
  for (const [key, database, role] of [
    ['applicationDatabase', 'app-source', 'app-source'],
    ['kestraDatabase', 'kestra-source', 'kestra-source'],
  ])
    Object.assign(config.services[key], {
      endpoint: {
        url: `postgresql://127.0.0.1:${port}`,
        tls: { mode: 'disabled' },
      },
      database,
      role,
    });
  config.phase = 2;
  config.services.edge.access = 'application';
  config.applicationAuth = {
    issuer: 'https://identity.example.invalid',
    clientId: 'restore-fixture',
    clientSecretRef: {
      provider: 'file',
      path: '/run/secrets/oidc-client-secret',
    },
    publicOrigin: 'https://campus.example.invalid',
    sessionLifetimeSeconds: 28800,
    sessionIdleSeconds: 1800,
  };
  config.artifacts.location = sourceRoots.artifacts;
  config.services.kestra.internalStorage.location = sourceRoots.kestraInternal;
  const release = {
    schemaVersion: 1,
    sourceRevision: 'b'.repeat(40),
    architectures: ['linux/amd64'],
    images: config.images,
  };
  const applicationCredentials = {
    role: 'migrator-source',
    passwordSecretRef: config.services.applicationDatabase.passwordSecretRef,
  };
  const dockerTool = async (tool, { service, input, output }) => {
    const env = { ...process.env, PGPASSWORD: password };
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'PGPASSWORD',
        '-e',
        `PGUSER=${service.role}`,
        '-e',
        `PGDATABASE=${service.database}`,
        '-e',
        'PGHOST=127.0.0.1',
        name,
        tool,
        ...postgresToolArguments(tool, service),
      ],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stderr.resume();
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error('Synthetic PostgreSQL command failed.')),
      );
    });
    const tasks = [done];
    if (input) tasks.push(pipeline(createReadStream(input), child.stdin));
    else child.stdin.end();
    tasks.push(
      pipeline(
        child.stdout,
        output
          ? typeof output === 'string'
            ? createWriteStream(output, { flags: 'wx', mode: 0o600 })
            : output
          : new Writable({
              write(_chunk, _encoding, done) {
                done();
              },
            }),
      ),
    );
    await Promise.all(tasks);
  };
  // Undefined selects the production native runner without an injected adapter.
  const runTool = native ? undefined : dockerTool;
  const quiesce = {
    operator: 'synthetic-operator',
    stoppedAt: new Date().toISOString(),
    stoppedServices: ['api', 'workers', 'kestra'],
  };
  const backupDirectory = join(root, 'backup');
  const observer = new pg.Client({
    ...connection,
    user: 'migrator-source',
    database: 'app-source',
  });
  const closingClient = new pg.Client({
    ...connection,
    user: 'app-source',
    database: 'app-source',
  });
  let closed;
  try {
    await observer.connect();
    await closingClient.connect();
    await observer.query('BEGIN');
    assert.equal(
      (
        await observer.query(
          'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
        )
      ).rows[0].count,
      1,
    );
    closed = new Promise((done) => setTimeout(done, 100)).then(() =>
      closingClient.end(),
    );
    await noOtherConnections(observer);
    await closed;
    assert.equal(
      (
        await observer.query(
          'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
        )
      ).rows[0].count,
      0,
    );
    await observer.query('ROLLBACK');
  } finally {
    if (closed) await closed;
    else await closingClient.end();
    await observer.end();
  }
  const busy = new pg.Client({
    ...connection,
    user: 'app-source',
    database: 'app-source',
  });
  await busy.connect();
  await assert.rejects(
    backupFoundation({
      config,
      release,
      backupDirectory,
      sourceRoots,
      keyRecovery,
      quiesce,
      resolveSecret,
      applicationCredentials,
      runTool,
    }),
    /Stop every/,
  );
  if (cli)
    await assert.rejects(
      operatorCli.run('backup', {
        config,
        release,
        backupDirectory,
        sourceRoots,
        keyRecovery,
        quiesce,
        applicationCredentials,
      }),
    );
  await busy.end();
  await assert.rejects(
    backupFoundation({
      config,
      release,
      backupDirectory,
      sourceRoots: {
        ...sourceRoots,
        kestraInternal: join(root, 'absent-volume'),
      },
      keyRecovery,
      quiesce,
      resolveSecret,
      applicationCredentials,
      runTool,
    }),
  );
  if (cli) {
    const backup = await operatorCli.run('backup', {
      config,
      release,
      backupDirectory,
      sourceRoots,
      keyRecovery,
      quiesce,
      applicationCredentials,
    });
    assert.equal(backup.result.status, 'complete');
    const verified = await operatorCli.run('verify', {
      backupDirectory,
      keyRecovery,
    });
    assert.equal(verified.result.status, 'verified');
  }
  const manifest = cli
    ? await verifyBackup({ backupDirectory, keyRecovery, resolveSecret })
    : await backupFoundation({
        config,
        release,
        backupDirectory,
        sourceRoots,
        keyRecovery,
        quiesce,
        resolveSecret,
        applicationCredentials,
        runTool,
      });
  assert.ok(
    manifest.files.every((file) => file.encryptedPath.endsWith('.enc')),
  );
  assert.ok(!(await readdir(backupDirectory)).includes('work'));
  assert.equal(
    (await verifyBackup({ backupDirectory, keyRecovery, resolveSecret })).files
      .length,
    manifest.files.length,
  );
  await assert.rejects(
    verifyBackup({
      backupDirectory,
      keyRecovery,
      resolveSecret: async () => Buffer.alloc(0),
    }),
  );
  await assert.rejects(
    verifyBackup({
      backupDirectory,
      keyRecovery,
      resolveSecret: async () => randomBytes(32),
    }),
  );
  const corrupt = join(root, 'corrupt');
  await cp(backupDirectory, corrupt, { recursive: true });
  await writeFile(join(corrupt, manifest.files[0].encryptedPath), 'corrupt');
  if (cli)
    await assert.rejects(
      operatorCli.run('verify', { backupDirectory: corrupt, keyRecovery }),
    );
  await assert.rejects(
    verifyBackup({ backupDirectory: corrupt, keyRecovery, resolveSecret }),
  );
  const missing = join(root, 'missing');
  await cp(backupDirectory, missing, { recursive: true });
  await rm(
    join(
      missing,
      manifest.files.find((file) => file.path === 'kestra.dump').encryptedPath,
    ),
  );
  await assert.rejects(
    verifyBackup({ backupDirectory: missing, keyRecovery, resolveSecret }),
  );
  await assert.rejects(
    backupFoundation({
      config,
      release,
      backupDirectory: join(sourceRoots.artifacts, 'backup'),
      sourceRoots,
      keyRecovery,
      quiesce,
      resolveSecret,
      applicationCredentials,
      runTool,
    }),
    /separately/,
  );
  const targetDirectory = join(root, 'restored'),
    targetConfig = structuredClone(config);
  targetConfig.artifacts.location = join(targetDirectory, 'artifacts');
  targetConfig.services.kestra.internalStorage.location = join(
    targetDirectory,
    'kestra-internal',
  );
  targetConfig.services.applicationDatabase.database = 'app-target';
  targetConfig.services.applicationDatabase.role = 'app-target';
  targetConfig.services.kestraDatabase.database = 'kestra-target';
  targetConfig.services.kestraDatabase.role = 'kestra-target';
  const targetCredentials = {
    ...applicationCredentials,
    role: 'migrator-target',
  };
  const failedDirectory = join(root, 'failed-restore'),
    failedConfig = structuredClone(targetConfig);
  failedConfig.artifacts.location = join(failedDirectory, 'artifacts');
  failedConfig.services.kestra.internalStorage.location = join(
    failedDirectory,
    'kestra-internal',
  );
  failedConfig.services.applicationDatabase.database = 'app-failed';
  failedConfig.services.applicationDatabase.role = 'app-failed';
  failedConfig.services.kestraDatabase.database = 'kestra-failed';
  failedConfig.services.kestraDatabase.role = 'kestra-failed';
  await assert.rejects(
    restoreFoundation({
      backupDirectory,
      targetConfig: failedConfig,
      targetDirectory: failedDirectory,
      keyRecovery,
      resolveSecret,
      applicationCredentials: {
        ...applicationCredentials,
        role: 'migrator-failed',
      },
      runTool: async () => {
        throw new Error('Synthetic restore failure.');
      },
    }),
  );
  assert.ok(
    (
      await readFile(join(failedDirectory, 'RESTORE_DISABLED'), 'utf8')
    ).includes('stopped'),
  );
  await assert.rejects(readFile(join(failedDirectory, 'restore-report.json')));
  const cliRestore = cli
    ? await operatorCli.run('restore', {
        backupDirectory,
        targetConfig,
        targetDirectory,
        keyRecovery,
        applicationCredentials: targetCredentials,
      })
    : undefined;
  const report = cli
    ? JSON.parse(
        await readFile(join(targetDirectory, 'restore-report.json'), 'utf8'),
      )
    : await restoreFoundation({
        backupDirectory,
        targetConfig,
        targetDirectory,
        keyRecovery,
        resolveSecret,
        applicationCredentials: targetCredentials,
        runTool,
      });
  assert.equal(report.status, 'verified-services-disabled');
  if (cli) assert.equal(cliRestore.result.status, 'verified-services-disabled');
  assert.deepEqual(report.redisRecovery, {
    policy: 'discard-cache',
    releaseRequiresFreshRedis: true,
  });
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(targetDirectory, 'target-configuration.json'),
        'utf8',
      ),
    ),
    cliRestore?.configuration ?? targetConfig,
  );
  assert.ok(
    (
      await readFile(join(targetDirectory, 'RESTORE_DISABLED'), 'utf8')
    ).includes('stopped'),
  );
  assert.equal(
    await readFile(
      join(targetDirectory, 'kestra-internal', 'executions', 'fixture.json'),
      'utf8',
    ),
    JSON.stringify({ executionId: 'synthetic-1', state: 'SUCCESS' }),
  );
  const restored = new pg.Client({
    ...connection,
    user: 'kestra-target',
    database: 'kestra-target',
  });
  await restored.connect();
  assert.equal(
    (await restored.query('SELECT state FROM synthetic_execution')).rows[0]
      .state,
    'SUCCESS',
  );
  await restored.end();
  pool = new pg.Pool({
    ...connection,
    user: 'app-target',
    database: 'app-target',
  });
  assert.deepEqual(
    (await pool.query('SELECT * FROM cc.application_principals ORDER BY id'))
      .rows,
    originalPrincipals,
  );
  assert.deepEqual(
    (await pool.query('SELECT * FROM cc.security_events ORDER BY id')).rows,
    originalEvents,
  );
  store = await createArtifactStore({
    pool,
    root: targetConfig.artifacts.location,
  });
  const chunks = [];
  for await (const chunk of await store.openRead(artifact.artifactId))
    chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  await store.close();
  store = undefined;
  await pool.end();
  pool = undefined;
  await assert.rejects(
    restoreFoundation({
      backupDirectory,
      targetConfig,
      targetDirectory,
      keyRecovery,
      resolveSecret,
      applicationCredentials: targetCredentials,
      runTool,
    }),
    /empty/,
  );
  if (cli)
    await assert.rejects(
      operatorCli.run('restore', {
        backupDirectory,
        targetConfig,
        targetDirectory,
        keyRecovery,
        applicationCredentials: targetCredentials,
      }),
    );
  console.log(
    JSON.stringify(
      {
        runner: cli
          ? 'operator-cli-native'
          : native
            ? 'default-native'
            : 'injected-docker',
        ...(cli ? { commands: operatorCli.commands } : {}),
        ...(cli ? { operatorCli: operatorCli.execution } : {}),
        toolVersions,
        backupMilliseconds: manifest.durationMilliseconds,
        restoreMilliseconds: report.durationMilliseconds,
        encryptedFiles: manifest.files.length,
        results: [
          'actual connection quiescence enforced',
          'delayed connection teardown observed through fresh transaction statistics',
          'both database dumps restored',
          'Phase 2 identity, preferences, permission version, and security events restored',
          'artifact identity and Unicode bytes restored',
          'Kestra synthetic state and internal files restored',
          'missing/wrong keys rejected',
          'corrupt and missing backup files rejected',
          'backup inside primary volume rejected',
          'nonempty target rejected',
          'absent source volume rejected',
          'failed restore retains disabled marker without success report',
          'services remain disabled; Redis requires fresh instance',
        ],
        hybrid: 'not-run: district shared mount absent',
        kubernetes: 'not-run: qualified RWX storage absent',
      },
      null,
      2,
    ),
  );
} finally {
  await store?.close();
  await pool?.end();
  await admin?.end();
  for (const client of clients) await client.end();
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
  await rm(root, { recursive: true, force: true });
  encryptionKey.fill(0);
}
