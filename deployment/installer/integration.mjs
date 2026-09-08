import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import net from 'node:net';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  backupFoundation,
  postgresToolArguments,
} from '../operations/index.mjs';

const root = await mkdtemp(join(tmpdir(), 'cc-installer-')),
  project = `cc-installer-${randomUUID().slice(0, 10)}`;
const docker = (args, input) =>
  execFileSync('docker', args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
const compose = (...args) =>
  docker([
    'compose',
    '-f',
    join(root, 'docker-compose.json'),
    '-p',
    project,
    ...args,
  ]);
const id = (service) => compose('ps', '-a', '-q', service);
const cli = (command) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        'deployment/installer/cli.mjs',
        command,
        join(root, 'operator.json'),
        '--qualification',
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 8 * 1024 * 1024,
      },
    ),
  );
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const server = net.createServer();
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
await new Promise((done) => server.close(done));
const config = JSON.parse(
  await readFile('/tmp/cc13-render/runtime/profile.json', 'utf8'),
);
const releases = [];
for (const name of ['a', 'b']) {
  const release = JSON.parse(
    await readFile(`/tmp/cc16-release-${name}.json`, 'utf8'),
  );
  release.sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  release.architectures = ['linux/amd64'];
  release.workingTree = 'uncommitted-candidate';
  releases.push(release);
}
config.images = releases[0].images;
config.services.edge.endpoint.url = `https://campus.example.org:${port}`;
const operator = {
  installationRoot: root,
  configurationPath: join(root, 'input.json'),
  releasePath: join(root, 'release.json'),
  releaseRoot: root,
  project,
  connectAddress: '127.0.0.1',
  bindAddress: '127.0.0.1',
  localRegistryHttp: true,
  preflightExceptions: [
    {
      name: 'district-dns',
      reason:
        'Synthetic hostname resolves through explicit loopback connection override.',
    },
    {
      name: 'time-synchronization',
      reason:
        'Disposable development host does not expose district time-service evidence.',
    },
    {
      name: 'storage-capacity',
      reason:
        'Synthetic fixture uses small data rather than declared district capacity reservation.',
    },
  ],
};
const writeInputs = async () => {
  await writeFile(operator.configurationPath, JSON.stringify(config), {
    mode: 0o600,
  });
  await writeFile(operator.releasePath, JSON.stringify(releases[0]), {
    mode: 0o600,
  });
  await writeFile(join(root, 'operator.json'), JSON.stringify(operator), {
    mode: 0o600,
  });
};
await mkdir(join(root, 'private'), { mode: 0o700 });
for (const name of ['edge-certificate', 'edge-private-key'])
  await cp(`/tmp/cc13-render/private/${name}`, join(root, 'private', name));
const proxies = [];
let prepared = false;
try {
  await writeInputs();
  assert.equal(cli('prepare').status, 'prepared');
  prepared = true;
  const secret = await readFile(join(root, 'private/bootstrap'));
  assert.equal(cli('resume').status, 'ready');
  assert.deepEqual(await readFile(join(root, 'private/bootstrap')), secret);
  const seed = `import fs from 'node:fs/promises';import crypto from 'node:crypto';import pg from 'pg';import {connectionOptions} from '/app/deployment/postgres/index.mjs';import {createArtifactStore} from '/app/deployment/storage/index.mjs';import {secretPath} from '/app/deployment/redis/runtime.mjs';const c=JSON.parse(await fs.readFile(process.env.CC_CONFIG_FILE));const pool=new pg.Pool(await connectionOptions(c.services.applicationDatabase,r=>fs.readFile(secretPath(r))));const s=await createArtifactStore({pool,root:c.artifacts.location});const bytes=Buffer.from('CC16 preserved École 学校');const a=await s.stage({schemaVersion:1,expectedSizeBytes:bytes.length,expectedSha256:crypto.createHash('sha256').update(bytes).digest('hex')},[bytes]);await s.publish(a);await fs.writeFile(c.artifacts.location+'/.cc16-fixture.json',JSON.stringify(a));await s.close();await pool.end();process.stdout.write(JSON.stringify(a));`;
  const artifact = JSON.parse(
    docker(['exec', '-i', id('api'), 'node', '--input-type=module'], seed),
  );
  const probe =
    seed.slice(0, seed.indexOf('const bytes=Buffer.from')) +
    `const a=JSON.parse(await fs.readFile(c.artifacts.location+'/.cc16-fixture.json'));const h=crypto.createHash('sha256');for await(const b of await s.openRead(a.artifactId))h.update(b);const ledger=(await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows;await s.close();await pool.end();process.stdout.write(JSON.stringify({artifactId:a.artifactId,sha256:h.digest('hex'),ledger}));`;
  const before = JSON.parse(
    docker(['exec', '-i', id('api'), 'node', '--input-type=module'], probe),
  );
  assert.equal(cli('stop').dataPreserved, true);
  assert.equal(cli('resume').status, 'ready');
  assert.deepEqual(
    JSON.parse(
      docker(['exec', '-i', id('api'), 'node', '--input-type=module'], probe),
    ),
    before,
  );
  assert.equal(cli('uninstall').dataPreserved, true);
  assert.equal(cli('resume').status, 'ready');
  assert.deepEqual(
    JSON.parse(
      docker(['exec', '-i', id('api'), 'node', '--input-type=module'], probe),
    ),
    before,
  );
  compose('stop', 'api', 'workers', 'kestra');
  const roots = {
    artifacts: join(root, 'snapshot-artifacts'),
    kestraInternal: join(root, 'snapshot-kestra'),
  };
  for (const path of Object.values(roots)) await mkdir(path, { mode: 0o700 });
  docker([
    'cp',
    `${id('api')}:${config.artifacts.location}/.`,
    roots.artifacts,
  ]);
  docker(['cp', `${id('kestra')}:/app/storage/.`, roots.kestraInternal]);
  const backupConfig = structuredClone(config),
    databaseContainers = new Map();
  for (const [key, service] of [
    ['applicationDatabase', 'application-postgres'],
    ['kestraDatabase', 'kestra-postgres'],
  ]) {
    const container = id(service),
      inspect = JSON.parse(docker(['inspect', container]))[0],
      network = Object.keys(inspect.NetworkSettings.Networks)[0],
      address = Object.values(inspect.NetworkSettings.Networks)[0].IPAddress,
      name = `${project}-backup-${proxies.length}`;
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
      config.images.api,
      '-e',
      `const n=require('node:net');n.createServer(s=>{const t=n.connect(5432,'${address}');s.pipe(t);t.pipe(s);s.on('error',()=>t.destroy());t.on('error',()=>s.destroy());}).listen(5432,'0.0.0.0')`,
    ]);
    proxies.push(name);
    docker(['network', 'connect', 'bridge', name]);
    const endpoint = `postgresql://127.0.0.1:${docker(['port', name, '5432/tcp']).split(':').at(-1)}`;
    backupConfig.services[key].endpoint.url = endpoint;
    databaseContainers.set(endpoint, container);
  }
  backupConfig.artifacts.location = roots.artifacts;
  backupConfig.services.kestra.internalStorage.location = roots.kestraInternal;
  const keyRecovery = {
    id: 'cc16-backup',
    version: 1,
    reference: { provider: 'file', path: '/run/secrets/backup-key' },
  };
  await writeFile(join(root, 'private/backup-key'), randomBytes(32), {
    mode: 0o600,
  });
  const resolveSecret = (ref) =>
    readFile(join(root, 'private', basename(ref.path)));
  const runTool = async (tool, { service, input, output }) => {
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
        databaseContainers.get(service.endpoint.url),
        tool,
        ...postgresToolArguments(tool, service),
      ],
      {
        env: {
          ...process.env,
          PGPASSWORD: String(await resolveSecret(service.passwordSecretRef)),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child.stderr.resume();
    const done = new Promise((done, reject) => {
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? done()
          : reject(new Error('Synthetic backup command failed.')),
      );
    });
    const tasks = [
      done,
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
  const backupDirectory = join(root, 'upgrade-backup');
  await backupFoundation({
    config: backupConfig,
    release: releases[0],
    backupDirectory,
    sourceRoots: roots,
    keyRecovery,
    quiesce: {
      operator: 'cc16-fixture',
      stoppedAt: new Date().toISOString(),
      stoppedServices: ['api', 'workers', 'kestra'],
    },
    resolveSecret,
    applicationCredentials: {
      role: 'application-installer',
      passwordSecretRef: {
        provider: 'file',
        path: '/run/secrets/postgres-migrator',
      },
    },
    runTool,
  });
  const state = JSON.parse(
    await readFile(join(root, 'installer-state.json'), 'utf8'),
  );
  operator.upgradeFromReleaseHash = state.releaseHash;
  operator.backupManifestSha256 = digest(
    await readFile(join(backupDirectory, 'manifest.json')),
  );
  operator.upgradeBackup = { backupDirectory, keyRecovery };
  releases[0] = releases[1];
  config.images = releases[1].images;
  await writeInputs();
  assert.equal(cli('upgrade').status, 'ready');
  const after = JSON.parse(
    docker(['exec', '-i', id('api'), 'node', '--input-type=module'], probe),
  );
  assert.deepEqual(after, before);
  assert.deepEqual(await readFile(join(root, 'private/bootstrap')), secret);
  const report = {
    status: 'passed',
    project,
    profile: 'all-docker',
    acceptedRelease: false,
    workingTree: 'uncommitted-candidate',
    baseGitRevision: releases[1].sourceRevision,
    artifact,
    before,
    after,
    releaseB: releases[1].images,
    checks: [
      'actual CLI prepare and resume',
      'stop and resume preserve data',
      'uninstall and resume preserve volumes',
      'encrypted backup verified before upgrade',
      'different image digests upgrade with artifact and ledger preservation',
      'active secrets preserved',
    ],
    prerequisiteExceptions: operator.preflightExceptions,
  };
  await writeFile(
    process.env.CC_INSTALLER_EVIDENCE ?? join(root, 'installer-result.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  operator.confirmErase = project;
  await writeInputs();
  assert.equal(cli('erase').dataPreserved, false);
  prepared = false;
  assert.equal(
    docker([
      'volume',
      'ls',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--format',
      '{{.Name}}',
    ]),
    '',
  );
  console.log(
    JSON.stringify({
      status: 'passed',
      evidencePath:
        process.env.CC_INSTALLER_EVIDENCE ??
        join(root, 'installer-result.json'),
      fixtureDirectory: root,
      explicitErasure: true,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      fixtureDirectory: root,
      instruction:
        'Inspect protected installer state and prerequisite results.',
    }),
  );
  throw error;
} finally {
  for (const name of proxies) docker(['rm', '-f', name]);
  if (prepared) compose('down', '--volumes');
  else compose('down');
}
