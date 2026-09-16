import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import {
  backupFoundation,
  postgresToolArguments,
} from '../operations/index.mjs';
import { normalizePostgresSecret } from '../postgres/secrets.mjs';
import { runEdgeTlsFaults } from '../qualification/edge-tls-faults.mjs';

const execute = promisify(execFile);

export async function qualifyInstaller({ configureApplication } = {}) {
  const previousPath = process.env.PATH;
  const releasePaths = [
    process.env.CC_INSTALLER_RELEASE_A,
    process.env.CC_INSTALLER_RELEASE_B,
  ];
  if (releasePaths.some((path) => !path))
    throw new Error(
      'Set CC_INSTALLER_RELEASE_A and CC_INSTALLER_RELEASE_B to two image inventory files.',
    );
  const harnessRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const sourceState = execFileSync('git', ['status', '--porcelain'], {
    encoding: 'utf8',
  }).trim()
    ? 'uncommitted-candidate'
    : 'clean';
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
  const cli = async (command) =>
    JSON.parse(
      (
        await execute(
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
            timeout: 300000,
          },
        )
      ).stdout,
    );
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const server = net.createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  const config = JSON.parse(
    await readFile(
      new URL('../examples/all-docker.json', import.meta.url),
      'utf8',
    ),
  );
  const releases = [];
  for (const path of releasePaths) {
    const release = JSON.parse(await readFile(path, 'utf8'));
    releases.push(release);
  }
  assert.notDeepEqual(
    releases[0].images,
    releases[1].images,
    'Upgrade qualification requires different image inventories.',
  );
  let activeRelease = releases[0];
  config.images = releases[0].images;
  config.services.edge.endpoint.url = `https://campus.example.org:${port}`;
  const application = configureApplication
    ? await configureApplication({
        root,
        publicOrigin: config.services.edge.endpoint.url,
      })
    : undefined;
  const operator = {
    installationRoot: root,
    configurationPath: join(root, 'input.json'),
    releasePath: join(root, 'release.json'),
    releaseRoot: root,
    project,
    connectAddress: '127.0.0.1',
    bindAddress: '127.0.0.1',
    localRegistryHttp: process.env.CC_INSTALLER_LOCAL_REGISTRY_HTTP === '1',
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
    await writeFile(operator.releasePath, JSON.stringify(activeRelease), {
      mode: 0o600,
    });
    await writeFile(join(root, 'operator.json'), JSON.stringify(operator), {
      mode: 0o600,
    });
  };
  await mkdir(join(root, 'private'), { mode: 0o700 });
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(root, 'private/edge-private-key'),
      '-out',
      join(root, 'private/edge-certificate'),
      '-days',
      '2',
      '-subj',
      '/CN=campus.example.org',
      '-addext',
      'subjectAltName=DNS:campus.example.org',
    ],
    { stdio: 'ignore', timeout: 30000 },
  );
  for (const name of ['edge-certificate', 'edge-private-key'])
    await chmod(join(root, 'private', name), 0o600);
  const proxies = [];
  let prepared = false;
  try {
    await writeInputs();
    assert.equal((await cli('prepare')).status, 'prepared');
    prepared = true;
    const secret = await readFile(join(root, 'private/bootstrap'));
    assert.equal((await cli('resume')).status, 'ready');
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
    assert.equal((await cli('stop')).dataPreserved, true);
    assert.equal((await cli('resume')).status, 'ready');
    assert.deepEqual(
      JSON.parse(
        docker(['exec', '-i', id('api'), 'node', '--input-type=module'], probe),
      ),
      before,
    );
    assert.equal((await cli('uninstall')).dataPreserved, true);
    assert.equal((await cli('resume')).status, 'ready');
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
        '--no-healthcheck',
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
    backupConfig.services.kestra.internalStorage.location =
      roots.kestraInternal;
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
            PGPASSWORD: normalizePostgresSecret(
              await resolveSecret(service.passwordSecretRef),
            ),
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
    activeRelease = releases[1];
    config.images = releases[1].images;
    if (application) {
      config.phase = 2;
      config.services.edge.access = 'application';
      config.applicationAuth = application.auth;
      await writeFile(
        join(root, 'private', 'oidc-client'),
        application.password,
        { mode: 0o600 },
      );
      const realDocker = execFileSync('which', ['docker'], {
        encoding: 'utf8',
      }).trim();
      const bin = join(root, 'qualification-bin');
      await mkdir(bin, { mode: 0o700 });
      await writeFile(
        join(bin, 'docker'),
        `#!${process.execPath}
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2), file=args[args.indexOf('-f')+1];
if(args[0]==='compose' && file===${JSON.stringify(join(root, 'docker-compose.json'))} && fs.existsSync(file)){
  const doc=JSON.parse(fs.readFileSync(file));
  doc.services.api.environment.NODE_EXTRA_CA_CERTS='/run/qualification/provider-ca';
  doc.services.api.extra_hosts=['host.docker.internal:host-gateway'];
  if(!doc.services.api.volumes.some(v=>v.target==='/run/qualification/provider-ca'))doc.services.api.volumes.push({type:'bind',source:${JSON.stringify(application.caFile)},target:'/run/qualification/provider-ca',read_only:true});
  const runtimeFile=${JSON.stringify(join(root, 'qualification-runtime.json'))};
  fs.writeFileSync(runtimeFile,JSON.stringify(doc),{mode:0o600});
  args[args.indexOf('-f')+1]=runtimeFile;
}
const result=spawnSync(${JSON.stringify(realDocker)},args,{stdio:'inherit'});
process.exit(result.status??1);
`,
        { mode: 0o700 },
      );
      process.env.PATH = `${bin}:${previousPath}`;
    }
    await writeInputs();
    assert.equal((await cli('upgrade')).status, 'ready');
    let secretLineEndings;
    if (process.env.CC_INSTALLER_SECRET_LINE_ENDINGS === '1') {
      const cases = [
        [
          'applicationDatabase',
          basename(config.services.applicationDatabase.passwordSecretRef.path),
          '\n',
        ],
        [
          'kestraDatabase',
          basename(config.services.kestraDatabase.passwordSecretRef.path),
          '\r\n',
        ],
        ['migration', 'postgres-migrator', '\r\n'],
      ];
      for (const [, name, ending] of cases) {
        const path = join(root, 'private', name);
        assert.equal(/[\r\n]/.test(await readFile(path, 'utf8')), false);
        await appendFile(path, ending);
      }
      compose('run', '--rm', 'database-provision');
      compose('run', '--rm', 'database-migrate');
      compose('up', '-d', '--force-recreate', 'api', 'workers', 'kestra');
      assert.equal((await cli('resume')).status, 'ready');
      secretLineEndings = {
        status: 'passed',
        credentials: cases.map(([name, , ending]) => ({
          name,
          delimiter: ending === '\n' ? 'LF' : 'CRLF',
        })),
        localAdminFiles: 'unchanged exact bytes',
        readiness:
          'eight components ready after provisioning and process recreation',
      };
    }
    const after = JSON.parse(
      docker(['exec', '-i', id('api'), 'node', '--input-type=module'], probe),
    );
    if (application) {
      assert.deepEqual({ ...after, ledger: before.ledger }, before);
      assert.deepEqual(
        after.ledger.slice(0, before.ledger.length),
        before.ledger,
      );
      assert.deepEqual(
        after.ledger.map((row) => row.id),
        ['001-foundation', '002-application-auth'],
      );
    } else assert.deepEqual(after, before);
    assert.deepEqual(await readFile(join(root, 'private/bootstrap')), secret);
    const faults =
      process.env.CC_INSTALLER_FAULTS === '1'
        ? await runEdgeTlsFaults(
            {
              qualificationOnly: true,
              root,
              project,
              url: config.services.edge.endpoint.url,
              connectAddress: '127.0.0.1',
              images: releases[1].images,
              sourceState: {
                baseGitRevision: harnessRevision,
                workingTree: execFileSync('git', ['status', '--porcelain'], {
                  encoding: 'utf8',
                }).trim()
                  ? 'uncommitted-candidate'
                  : 'clean',
              },
            },
            {
              compose,
              verifyFixtures: async () =>
                assert.deepEqual(
                  JSON.parse(
                    docker(
                      ['exec', '-i', id('api'), 'node', '--input-type=module'],
                      probe,
                    ),
                  ),
                  before,
                ),
            },
          )
        : undefined;
    const browser =
      process.env.CC_INSTALLER_BROWSER === '1'
        ? await (
            await import('../qualification/profile-browser.mjs')
          ).runProfileBrowser({
            url: config.services.edge.endpoint.url,
            bootstrapFile: join(root, 'private', 'bootstrap'),
          })
        : undefined;
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'release.json'), 'utf8')),
      JSON.parse(await readFile(releasePaths[1], 'utf8')),
      'Installation must preserve the supplied release inventory.',
    );
    const applicationResult = application
      ? await application.check({
          root,
          config,
          release: releases[1],
          compose,
          id,
          cli,
          runTool,
          resolveSecret,
          keyRecovery,
        })
      : undefined;
    const report = {
      ...(applicationResult ? { application: applicationResult } : {}),
      status: 'passed',
      project,
      profile: 'all-docker',
      acceptedRelease: false,
      workingTree: sourceState,
      baseGitRevision: harnessRevision,
      artifact,
      before,
      after,
      releaseB: releases[1].images,
      releaseInventories: releases.map((release) => ({
        sourceRevision: release.sourceRevision,
        architectures: release.architectures,
        workingTree: release.workingTree,
        sourceRevisionMeaning: release.sourceRevisionMeaning,
        images: release.images,
      })),
      secretLineEndings,
      faults,
      browser,
      checks: [
        'actual CLI prepare and resume',
        'stop and resume preserve data',
        'uninstall and resume preserve volumes',
        'encrypted backup verified before upgrade',
        'different image digests upgrade with artifact and ledger preservation',
        'active secrets preserved',
        'input release inventory metadata preserved',
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
    assert.equal((await cli('erase')).dataPreserved, false);
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
    return report;
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
    process.env.PATH = previousPath;
    for (const name of proxies) docker(['rm', '-f', name]);
    if (existsSync(join(root, 'docker-compose.json'))) {
      if (prepared) compose('down', '--volumes');
      else compose('down');
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await qualifyInstaller();
