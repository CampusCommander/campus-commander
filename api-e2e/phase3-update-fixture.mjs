import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadQualificationBundle } from '../deployment/release/qualification.mjs';
import { createOperationsCliFixture } from '../deployment/operations/cli-fixture.mjs';
import { createAllDockerDurableProbe } from './all-docker-faults-fixture.mjs';

const execute = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 240000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();

/** Admit a separately verified Phase 3 release before any update operation. */
export async function loadPhase3UpdateTarget(root, installed) {
  assert.ok(root, 'Provide the verified Phase 3 update directory.');
  const target = JSON.parse(
    await readFile(join(root, 'release-manifest.json')),
  );
  assert.equal(target.phase, 3);
  assert.equal(target.validationScope, 'lab');
  assert.equal(target.qualification, 'candidate-only');
  assert.match(target.sourceRevision, /^[a-f0-9]{40}$/);
  assert.notEqual(target.sourceRevision, installed.sourceRevision);
  assert.deepEqual(Object.keys(target.images).sort(), [
    'api',
    'frontend',
    'workers',
  ]);
  for (const [service, name] of [
    ['api', 'api'],
    ['frontend', 'frontend'],
    ['workers', 'worker'],
  ])
    assert.match(
      target.images[service],
      new RegExp(
        `^ghcr\\.io/campuscommander/campus-commander-${name}@sha256:[a-f0-9]{64}$`,
      ),
    );
  const bundle = await loadQualificationBundle(root, target);
  return { ...bundle, root: resolve(root) };
}

/** Execute the delivered guided update with a native backup and preserved application state. */
export async function qualifyInstalledUpdate({
  root,
  project,
  config,
  release,
  compose,
  id,
  bin,
  cli,
  evidencePath,
  evidenceIdentity,
  verifyAfterUpdate,
  activateTarget,
}) {
  const startedAt = Date.now();
  const report = {
    ...evidenceIdentity,
    schemaVersion: 1,
    phase: 3,
    profile: 'all-docker',
    sourceRevision: release.sourceRevision,
    images: release.images,
    recordedAt: new Date().toISOString(),
    status: 'in-progress',
    durationScope:
      'Target admission, durable-state setup, native cold backup, cancelled update, guided update, repeated update, and state checks.',
    limits: [
      'The installation uses synthetic Google and application sign-in providers.',
      'The fixture records laboratory setup mode for an installation created through the delivered operator CLI.',
      'Source and target identities remain distinct. This report does not transfer other release evidence to the target.',
    ],
  };
  const save = async () => {
    report.durationMs = Date.now() - startedAt;
    await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
  };
  await save();
  const proxies = [];
  try {
    assert.equal(config.phase, 3);
    const target = await loadPhase3UpdateTarget(
      process.env.CC_AUTH_UPDATE_INSTALLER_ROOT,
      release,
    );
    report.target = {
      sourceRevision: target.manifest.sourceRevision,
      images: target.manifest.images,
      bundleManifestSha256: target.manifestSha256,
    };
    for (const reference of Object.values(target.manifest.images)) {
      const image = JSON.parse(docker('image', 'inspect', reference))[0];
      assert.equal(
        image.Config.Labels['org.opencontainers.image.revision'],
        target.manifest.sourceRevision,
      );
    }
    const verifyDurable = await createAllDockerDurableProbe({
      root,
      project,
      config,
      release,
      compose,
      id,
      allowAppendedMigrations: true,
    });
    const privateRoot = join(root, 'private');
    const secrets = new Map(
      await Promise.all(
        (await readdir(privateRoot)).map(async (name) => [
          name,
          await readFile(join(privateRoot, name)),
        ]),
      ),
    );
    const statePath = join(root, 'installer-state.json');
    const beforeState = JSON.parse(await readFile(statePath));
    const beforeConfig = await readFile(join(root, 'deployment.json'));
    const beforeOperator = await readFile(join(root, 'operator.json'));
    assert.equal(beforeState.phase, 'ready');
    const ledger = () =>
      JSON.parse(
        docker(
          'exec',
          id('api'),
          'node',
          '--input-type=module',
          '-e',
          `
import fs from 'node:fs/promises';import pg from 'pg';import {connectionOptions} from '/app/deployment/postgres/index.mjs';import {secretPath} from '/app/deployment/redis/runtime.mjs';
const c=JSON.parse(await fs.readFile('/run/config/profile.json'));const pool=new pg.Pool(await connectionOptions(c.services.applicationDatabase,r=>fs.readFile(secretPath(r))));
console.log(JSON.stringify((await pool.query('SELECT id,checksum FROM cc.schema_migrations ORDER BY id')).rows));await pool.end();`,
        ),
      );
    const beforeLedger = ledger();
    compose('stop', 'edge', 'api', 'workers', 'kestra');
    const sourceRoots = {
      artifacts: join(root, 'update-artifacts'),
      kestraInternal: join(root, 'update-kestra'),
    };
    for (const path of Object.values(sourceRoots))
      await mkdir(path, { mode: 0o700 });
    docker(
      'cp',
      `${compose('ps', '-a', '-q', 'api').split('\n')[0]}:${config.artifacts.location}/.`,
      sourceRoots.artifacts,
    );
    docker(
      'cp',
      `${compose('ps', '-a', '-q', 'kestra')}:/app/storage/.`,
      sourceRoots.kestraInternal,
    );
    const backupConfig = structuredClone(config);
    for (const [key, service] of [
      ['applicationDatabase', 'application-postgres'],
      ['kestraDatabase', 'kestra-postgres'],
    ]) {
      const inspected = JSON.parse(docker('inspect', id(service)))[0];
      const [network, connection] = Object.entries(
        inspected.NetworkSettings.Networks,
      )[0];
      const name = `cc-update-proxy-${randomUUID()}`;
      docker(
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
        release.images.api,
        '-e',
        `const n=require('node:net');n.createServer(s=>{const t=n.connect(5432,${JSON.stringify(connection.IPAddress)});s.pipe(t).pipe(s);s.on('error',()=>t.destroy());t.on('error',()=>s.destroy());}).listen(5432,'0.0.0.0')`,
      );
      proxies.push(name);
      docker('network', 'connect', 'bridge', name);
      backupConfig.services[key].endpoint.url =
        `postgresql://127.0.0.1:${docker('port', name, '5432/tcp').split(':').at(-1)}`;
    }
    backupConfig.artifacts.location = sourceRoots.artifacts;
    backupConfig.services.kestra.internalStorage.location =
      sourceRoots.kestraInternal;
    const keyRecovery = {
      id: 'phase3-update-backup',
      version: 1,
      reference: { provider: 'file', path: '/run/secrets/update-backup-key' },
    };
    await writeFile(join(privateRoot, 'update-backup-key'), randomBytes(32), {
      mode: 0o600,
    });
    const backupDirectory = join(root, 'phase3-update-backup');
    const operatorCli = await createOperationsCliFixture(
      join(root, 'update-operator-cli'),
      (ref) => readFile(join(privateRoot, basename(ref.path))),
      { container: true, mountDirectories: [root] },
    );
    assert.equal(
      (
        await operatorCli.run('backup', {
          config: backupConfig,
          release,
          backupDirectory,
          sourceRoots,
          keyRecovery,
          quiesce: {
            operator: 'phase3-update-fixture',
            stoppedAt: new Date().toISOString(),
            stoppedServices: ['api', 'workers', 'kestra'],
          },
          applicationCredentials: {
            role: 'application-installer',
            passwordSecretRef: {
              provider: 'file',
              path: '/run/secrets/postgres-migrator',
            },
          },
        })
      ).result.status,
      'complete',
    );
    assert.equal(
      (await operatorCli.run('verify', { backupDirectory, keyRecovery })).result
        .status,
      'verified',
    );
    report.operations = {
      commands: operatorCli.commands,
      execution: operatorCli.execution,
    };
    compose('up', '-d', '--wait', '--wait-timeout', '120');
    assert.equal(
      JSON.parse(await readFile(join(root, 'setup-record.json'))).qualification,
      true,
    );
    const answersPath = join(root, 'update-answers.json');
    const invoke = async (confirmation, expectedStatus) => {
      const invocationStarted = Date.now();
      await writeFile(
        answersPath,
        JSON.stringify(
          confirmation === undefined
            ? {}
            : {
                'update.backupDirectory': backupDirectory,
                confirmUpdate: confirmation,
              },
        ),
        { mode: 0o600 },
      );
      let stdout;
      try {
        ({ stdout } = await execute(
          process.execPath,
          [
            join(target.root, 'deployment/installer/setup.mjs'),
            '--release-root',
            target.root,
            '--root',
            root,
            '--command',
            'update',
            '--qualification',
            '--answers',
            answersPath,
          ],
          {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
            timeout: 300000,
            maxBuffer: 4 * 1024 * 1024,
          },
        ));
      } catch {
        throw new Error(
          'Delivered guided update failed. Inspect protected installation state.',
        );
      }
      assert.ok(
        stdout.includes(`Update status: ${expectedStatus}.`),
        'The delivered guided update must report its expected status.',
      );
      return {
        command: 'setup update',
        status: expectedStatus,
        durationMs: Date.now() - invocationStarted,
      };
    };
    report.commands = [await invoke('cancel', 'cancelled')];
    assert.ok(
      beforeConfig.equals(await readFile(join(root, 'deployment.json'))),
    );
    assert.ok(
      beforeOperator.equals(await readFile(join(root, 'operator.json'))),
    );
    assert.deepEqual(JSON.parse(await readFile(statePath)), beforeState);
    verifyDurable();
    report.cancelledUpdatePreserved = true;
    await save();
    report.commands.push(await invoke('update', 'ready'));
    const afterState = JSON.parse(await readFile(statePath));
    assert.equal(afterState.phase, 'ready');
    assert.equal(afterState.releaseHash, target.manifestSha256);
    assert.notEqual(afterState.releaseHash, beforeState.releaseHash);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'deployment.json'))),
      { ...config, images: target.manifest.images },
    );
    const afterOperator = JSON.parse(
      await readFile(join(root, 'operator.json')),
    );
    assert.equal(afterOperator.releaseRoot, target.root);
    assert.equal(
      afterOperator.configurationPath,
      join(root, 'deployment.json'),
    );
    await assert.rejects(access(join(root, 'setup-update.json')), {
      code: 'ENOENT',
    });
    for (const [name, bytes] of secrets)
      assert.ok(
        bytes.equals(await readFile(join(privateRoot, name))),
        'Guided update must preserve every existing secret.',
      );
    const afterLedger = ledger();
    for (const migration of beforeLedger)
      assert.deepEqual(
        afterLedger.find((item) => item.id === migration.id),
        migration,
      );
    for (const [service, key] of [
      ['api', 'api'],
      ['frontend', 'frontend'],
      ['workers', 'workers'],
    ])
      for (const container of compose('ps', '-q', service).split('\n'))
        assert.equal(
          JSON.parse(docker('inspect', container))[0].Config.Image,
          target.manifest.images[key],
        );
    report.durableState = verifyDurable();
    await verifyAfterUpdate();
    report.commands.push(await invoke(undefined, 'already-current'));
    activateTarget(target.root);
    assert.equal((await cli('resume')).status, 'ready');
    report.durableState = verifyDurable();
    await verifyAfterUpdate();
    report.checks = {
      backupVerified: true,
      configurationPreserved: true,
      existingSecretsPreserved: true,
      migrationChecksumsPreserved: true,
      targetImagesRunning: true,
      updateJournalRemoved: true,
      preservedWorkflowsReadable: true,
      repeatedUpdate: true,
      repeatedResume: true,
    };
    report.status = 'passed';
    await save();
    return report;
  } catch (error) {
    report.status = 'failed';
    await save();
    throw error;
  } finally {
    for (const name of proxies.reverse()) docker('rm', '-f', name);
  }
}
