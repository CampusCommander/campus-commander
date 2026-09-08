import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  backupFoundation,
  restoreFoundation,
  postgresToolArguments,
} from './index.mjs';
import { connectDatabase } from '../postgres/index.mjs';
import { normalizePostgresSecret } from '../postgres/secrets.mjs';
import {
  generateBootstrapCredential,
  replaceBootstrap,
} from '../bootstrap/access.mjs';
import { renderAllDocker } from '../profiles/all-docker/render.mjs';
import { prepareAllDocker } from '../profiles/all-docker/prepare.mjs';
import { httpsStartup } from '../qualification/faults.mjs';

// The explicit release flag prevents accidental interruption of the retained source fixture.
if (process.env.CC_RESTORE_SOURCE_RELEASED !== 'yes')
  throw new Error('Wait for the source fixture owner to release its writers.');
const sourceRoot = resolve(
  process.env.CC_RESTORE_SOURCE_ROOT ?? '/tmp/cc13-render',
);
const sourceProject = process.env.CC_RESTORE_SOURCE_PROJECT ?? 'cc-fault-cc13';
if (!/^cc-fault-[a-z0-9-]+$/.test(sourceProject))
  throw new Error('Use a dedicated synthetic source project.');
const root = await mkdtemp(join(tmpdir(), 'cc-profile-restore-')),
  project = `cc-restore-${randomUUID().slice(0, 12)}`;
const targetCompose = join(root, 'docker-compose.json');
const docker = (args, input) =>
  execFileSync('docker', args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
const compose = (target, ...args) =>
  docker([
    'compose',
    '-f',
    target ? targetCompose : join(sourceRoot, 'docker-compose.yml'),
    '-p',
    target ? project : sourceProject,
    ...args,
  ]);
const container = (target, service) =>
  compose(target, 'ps', '-a', '-q', service);
const ip = (id) => {
  const inspect = JSON.parse(docker(['inspect', id]))[0];
  return Object.values(inspect.NetworkSettings.Networks)[0].IPAddress;
};
const fixtureCode = await readFile(
  new URL('../qualification/fixture-probe.mjs', import.meta.url),
  'utf8',
);
const fixture = (target) =>
  JSON.parse(
    docker(
      ['exec', '-i', container(target, 'api'), 'node', '--input-type=module'],
      fixtureCode,
    ),
  );
const redisSentinel = `cc:restore:${randomUUID()}`;
const key = randomBytes(32),
  keyRecovery = {
    id: 'synthetic-profile-restore',
    version: 1,
    reference: { provider: 'file', path: '/run/secrets/backup-key' },
  };
const privateRoot = join(root, 'private');
const resolveSecret = (ref) =>
  ref.path === '/run/secrets/backup-key'
    ? Promise.resolve(key)
    : readFile(join(privateRoot, basename(ref.path)));
const proxies = [];
function proxy(id, image) {
  const address = ip(id),
    name = `${project}-proxy-${proxies.length}`;
  const network = Object.keys(
    JSON.parse(docker(['inspect', id]))[0].NetworkSettings.Networks,
  )[0];
  const code = `const net=require('node:net');net.createServer(s=>{const t=net.connect(5432,'${address}');s.pipe(t);t.pipe(s);s.on('error',()=>t.destroy());t.on('error',()=>s.destroy());}).listen(5432,'0.0.0.0')`;
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--network',
    network,
    '-p',
    '127.0.0.1::5432',
    '--entrypoint',
    'node',
    image,
    '-e',
    code,
  ]);
  proxies.push(name);
  docker(['network', 'connect', 'bridge', name]);
  return `postgresql://127.0.0.1:${docker(['port', name, '5432/tcp']).split(':').at(-1)}`;
}
let targetStarted = false;
try {
  let before;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      before = fixture(false);
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
  if (!before) throw new Error('Source fixture is unavailable.');
  assert.equal(
    docker([
      'exec',
      container(false, 'redis'),
      'sh',
      '-c',
      'REDISCLI_AUTH="$(cat /run/secrets/redis-password)" redis-cli --no-auth-warning SET "$1" source-cache',
      'sh',
      redisSentinel,
    ]),
    'OK',
  );
  const runtime = JSON.parse(
    await readFile(join(sourceRoot, 'runtime/profile.json'), 'utf8'),
  );
  const originalRelease = JSON.parse(
    await readFile(join(sourceRoot, 'release.json'), 'utf8'),
  );
  const release = {
    ...originalRelease,
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    architectures: ['linux/amd64'],
  };
  runtime.images = release.images;
  await cp(join(sourceRoot, 'private'), privateRoot, { recursive: true });
  await writeFile(join(privateRoot, 'backup-key'), key, {
    mode: 0o600,
    flag: 'wx',
  });
  compose(false, 'stop', 'api', 'workers', 'kestra');
  const quiesce = {
    operator: 'synthetic-profile-fixture',
    stoppedAt: new Date().toISOString(),
    stoppedServices: ['api', 'workers', 'kestra'],
  };
  const sourceRoots = {
    artifacts: join(root, 'source-artifacts'),
    kestraInternal: join(root, 'source-kestra'),
  };
  await mkdir(sourceRoots.artifacts, { mode: 0o700 });
  await mkdir(sourceRoots.kestraInternal, { mode: 0o700 });
  docker([
    'cp',
    `${container(false, 'api')}:${runtime.artifacts.location}/.`,
    sourceRoots.artifacts,
  ]);
  docker([
    'cp',
    `${container(false, 'kestra')}:/app/storage/.`,
    sourceRoots.kestraInternal,
  ]);
  const sourceConfig = structuredClone(runtime),
    databaseContainers = new Map();
  for (const [key, service] of [
    ['applicationDatabase', 'application-postgres'],
    ['kestraDatabase', 'kestra-postgres'],
  ]) {
    const id = container(false, service),
      address = proxy(id, release.images.api);
    sourceConfig.services[key].endpoint.url = address;
    databaseContainers.set(address, id);
  }
  sourceConfig.artifacts.location = sourceRoots.artifacts;
  sourceConfig.services.kestra.internalStorage.location =
    sourceRoots.kestraInternal;
  const credentials = {
    role: 'application-installer',
    passwordSecretRef: {
      provider: 'file',
      path: '/run/secrets/postgres-migrator',
    },
  };
  const runTool = async (tool, { service, input, output }) => {
    const id = databaseContainers.get(service.endpoint.url);
    if (!id) throw new Error('Unknown synthetic database target.');
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
        id,
        tool,
        ...postgresToolArguments(tool, service),
      ],
      {
        env: {
          ...process.env,
          PGPASSWORD: normalizePostgresSecret(
            await resolveSecret(service.passwordSecretRef),
          ),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child.stderr.resume();
    const complete = new Promise((done, reject) => {
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? done()
          : reject(new Error('Profile database command failed.')),
      );
    });
    const tasks = [
      complete,
      pipeline(
        child.stdout,
        output ??
          new Writable({
            write(_chunk, _encoding, done) {
              done();
            },
          }),
      ),
    ];
    if (input) tasks.push(pipeline(createReadStream(input), child.stdin));
    else child.stdin.end();
    await Promise.all(tasks);
  };
  const backupDirectory = join(root, 'encrypted-backup');
  const manifest = await backupFoundation({
    config: sourceConfig,
    release,
    backupDirectory,
    sourceRoots,
    keyRecovery,
    quiesce,
    resolveSecret,
    applicationCredentials: credentials,
    runTool,
  });
  const targetRuntime = structuredClone(runtime);
  targetRuntime.services.applicationDatabase.database = 'campus-restore';
  targetRuntime.services.kestraDatabase.database = 'kestra-restore';
  const configPath = join(root, 'target.json');
  await writeFile(configPath, JSON.stringify(targetRuntime), { mode: 0o600 });
  await prepareAllDocker(configPath, root);
  const topology = renderAllDocker(targetRuntime, release);
  topology.name = project;
  topology.services.edge.ports = ['127.0.0.1::8443'];
  await writeFile(targetCompose, JSON.stringify(topology), { mode: 0o600 });
  targetStarted = true;
  compose(
    true,
    'up',
    '-d',
    'application-postgres',
    'kestra-postgres',
    'volume-permissions',
  );
  compose(true, 'run', '--rm', 'database-provision');
  const targetConfig = structuredClone(targetRuntime),
    targetDirectory = join(root, 'restored');
  for (const [key, service] of [
    ['applicationDatabase', 'application-postgres'],
    ['kestraDatabase', 'kestra-postgres'],
  ]) {
    const id = container(true, service),
      address = proxy(id, release.images.api);
    targetConfig.services[key].endpoint.url = address;
    databaseContainers.set(address, id);
  }
  targetConfig.artifacts.location = join(targetDirectory, 'artifacts');
  targetConfig.services.kestra.internalStorage.location = join(
    targetDirectory,
    'kestra-internal',
  );
  const report = await restoreFoundation({
    backupDirectory,
    targetConfig,
    targetDirectory,
    keyRecovery,
    resolveSecret,
    applicationCredentials: credentials,
    runTool,
  });
  assert.equal(report.status, 'verified-services-disabled');
  // Copy only verified restored trees into the newly created target volumes.
  for (const [tree, volume] of [
    ['artifacts', 'artifacts'],
    ['kestra-internal', 'kestra-storage'],
  ]) {
    docker([
      'run',
      '--rm',
      '--user',
      '0:0',
      '--entrypoint',
      '/bin/sh',
      '-v',
      `${join(targetDirectory, tree)}:/restore:ro`,
      '-v',
      `${project}_${volume}:/target`,
      release.images.api,
      '-c',
      'cp -a /restore/. /target/ && chown -R 1000:1000 /target',
    ]);
  }
  const application = await connectDatabase(
    { ...targetConfig.services.applicationDatabase, ...credentials },
    resolveSecret,
  );
  try {
    const generation = (
      await application.query(
        'SELECT generation FROM cc.bootstrap_access WHERE id=1',
      )
    ).rows[0].generation;
    const token = generateBootstrapCredential();
    await replaceBootstrap(application, token, generation);
    await writeFile(join(privateRoot, 'bootstrap'), token, { mode: 0o600 });
  } finally {
    await application.end();
  }
  // Explicit fixture acceptance releases startup only after offline integrity verification.
  await writeFile(
    join(targetDirectory, 'offline-acceptance.json'),
    JSON.stringify({
      status: 'verified',
      applicationTables: report.applicationTables,
      kestraTables: report.kestraTables,
    }),
    { mode: 0o600 },
  );
  await rm(join(targetDirectory, 'RESTORE_DISABLED'));
  compose(true, 'up', '-d');
  const edgePort = Number(
    compose(true, 'port', 'edge', '8443').split(':').at(-1),
  );
  let startup;
  for (let attempt = 0; attempt < 90; attempt++) {
    startup = await httpsStartup({
      url: `https://campus.example.org:${edgePort}`,
      connectAddress: '127.0.0.1',
      caFile: join(privateRoot, 'edge-certificate'),
      bootstrapFile: join(privateRoot, 'bootstrap'),
    });
    if (startup.status === 'ready') break;
    await new Promise((done) => setTimeout(done, 1000));
  }
  assert.equal(startup.status, 'ready');
  assert.equal(startup.checks.length, 8);
  const after = fixture(true);
  assert.deepEqual(after.artifact, before.artifact);
  assert.deepEqual(after.kestra, before.kestra);
  assert.deepEqual(after.migrations, before.migrations);
  const redis = container(true, 'redis');
  const redisSize = docker([
    'exec',
    redis,
    'sh',
    '-c',
    'REDISCLI_AUTH="$(cat /run/secrets/redis-password)" redis-cli --no-auth-warning EXISTS "$1"',
    'sh',
    redisSentinel,
  ]);
  assert.equal(redisSize, '0');
  const evidence = {
    status: 'passed',
    profile: 'all-docker',
    sourceProject,
    targetProject: project,
    images: release.images,
    backupMilliseconds: manifest.durationMilliseconds,
    restoreMilliseconds: report.durationMilliseconds,
    encryptedFiles: manifest.files.length,
    before,
    after,
    startup,
    sourceRedisFixtureWritten: true,
    redisFixtureExists: 0,
    freshRedisTmpfs: true,
    sourceStopped: true,
    baseGitRevision: release.sourceRevision,
    workingTree: 'uncommitted-candidate',
    provenance:
      'Source snapshot image pins normalized from retained release. Base Git revision does not identify committed candidate code.',
    districtQualification: false,
  };
  const evidencePath =
    process.env.CC_RESTORE_PROFILE_EVIDENCE ??
    join(root, 'profile-restore-evidence.json');
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      status: 'passed',
      evidencePath,
      backupMilliseconds: manifest.durationMilliseconds,
      restoreMilliseconds: report.durationMilliseconds,
      encryptedFiles: manifest.files.length,
      readyChecks: startup.checks.length,
      sourceRedisFixtureWritten: true,
      redisFixtureExists: 0,
      freshRedisTmpfs: true,
    }),
  );
} finally {
  key.fill(0);
  for (const name of proxies) docker(['rm', '-f', name]);
  if (targetStarted) compose(true, 'down', '--volumes', '--remove-orphans');
  // Preserve encrypted evidence and private staging for the fixture owner's explicit cleanup.
  console.log(
    JSON.stringify({
      fixtureDirectory: root,
      sourceProject,
      sourceWriters: 'stopped after release',
    }),
  );
}
