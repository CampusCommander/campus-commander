import {
  probeApi,
  probeKestra,
  probeExternal,
  createBackup,
} from './hybrid-lifecycle-probes.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The descriptor names disposable hosts prepared outside this lifecycle runner.
// Generated Compose files cross the host boundary without modifications.
async function execute(args, input) {
  return new Promise((done, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (bytes) => {
      stdout += bytes;
    });
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) done(stdout.trim());
      else
        reject(
          Object.assign(new Error('Lifecycle fixture command failed.'), {
            code,
            stdout,
            stderr,
          }),
        );
    });
    child.stdin.end(input);
  });
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function runHybridLifecycle(fixture) {
  const { controller, workers, root, project, releases, outputDirectory } =
    fixture;
  assert.equal(workers.length, 2);
  assert.equal(new Set([controller, ...workers]).size, 3);
  assert.equal(fixture.qualificationOnly, true);
  assert.equal(project, 'cc-16-hybrid');
  assert.equal(controller, 'cc16-hybrid-controller');
  assert.deepEqual(workers, ['cc16-hybrid-worker-1', 'cc16-hybrid-worker-2']);
  assert.equal(root, '/opt/cc16-hybrid');
  assert.equal(releases.length, 2);
  assert.notEqual(releases[0], releases[1]);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const raw = { steps: [], remoteActions: [], status: 'running' };
  const node = (source, value = {}) =>
    execute(
      [
        'exec',
        '-i',
        controller,
        'node',
        '--input-type=module',
        '-',
        JSON.stringify(value),
      ],
      source,
    );
  const read = (path) =>
    node(
      "import fs from 'node:fs/promises';process.stdout.write(await fs.readFile(JSON.parse(process.argv[2]).path,'utf8'));",
      { path },
    );
  const json = async (path) => JSON.parse(await read(path));
  const write = (path, value) =>
    node(
      "import fs from 'node:fs/promises';const {path,value}=JSON.parse(process.argv[2]);await fs.writeFile(path,JSON.stringify(value,null,2)+String.fromCharCode(10),{mode:0o600});",
      { path, value },
    );
  let release = releases[0];
  const cli = async (command) =>
    JSON.parse(
      await execute([
        'exec',
        controller,
        'node',
        `${release}/deployment/installer/cli.mjs`,
        command,
        `${root}/operator.json`,
        '--qualification',
      ]),
    );
  const compose = (host, index, args) =>
    execute([
      'exec',
      host,
      'docker',
      'compose',
      '-f',
      `${root}/docker-compose${index ? `.worker-${index}` : ''}.json`,
      '-p',
      index ? `${project}-worker-${index}` : project,
      ...args,
    ]);
  const service = async (name) =>
    (await compose(controller, 0, ['ps', '-a', '-q', name])).trim();
  const api = async (source) =>
    execute(
      [
        'exec',
        '-i',
        controller,
        'docker',
        'exec',
        '-i',
        await service('api'),
        'node',
        '--input-type=module',
      ],
      source,
    );
  const save = () =>
    writeFile(
      join(outputDirectory, 'raw-result.json'),
      JSON.stringify(raw, null, 2) + '\n',
      { mode: 0o600 },
    );
  const workerAction = async (action) => {
    for (const [offset, host] of workers.entries()) {
      const args =
        action === 'start'
          ? ['up', '-d']
          : action === 'erase'
            ? ['down', '--volumes']
            : action === 'uninstall'
              ? ['down']
              : ['stop'];
      await compose(host, offset + 1, args);
      raw.remoteActions.push({ host, action, completed: true });
    }
  };
  const transfer = async () => {
    for (const [offset, host] of workers.entries()) {
      const stage = join(outputDirectory, `transfer-${offset + 1}`);
      await mkdir(stage, { recursive: true, mode: 0o700 });
      await execute([
        'exec',
        host,
        'mkdir',
        '-p',
        `${root}/private`,
        `${root}/runtime`,
      ]);
      const fragment = `docker-compose.worker-${offset + 1}.json`;
      const topology = await json(`${root}/${fragment}`);
      const references = new Set(['runtime/profile.json', fragment]);
      for (const service of Object.values(topology.services)) {
        for (const mount of service.volumes ?? []) {
          if (
            typeof mount === 'object' &&
            mount.type === 'bind' &&
            mount.source.startsWith('./private/')
          ) {
            assert.match(mount.source, /^\.\/private\/[a-zA-Z0-9_-]+$/);
            references.add(mount.source.slice(2));
          }
        }
      }
      await execute([
        'exec',
        host,
        'rm',
        '-rf',
        `${root}/private`,
        `${root}/runtime`,
      ]);
      await execute([
        'exec',
        host,
        'mkdir',
        '-p',
        `${root}/private`,
        `${root}/runtime`,
      ]);
      for (const path of references) {
        const local = join(stage, path.replaceAll('/', '-'));
        await execute(['cp', `${controller}:${root}/${path}`, local]);
        await execute(['cp', local, `${host}:${root}/${path}`]);
      }
      await execute([
        'exec',
        host,
        'chmod',
        '700',
        root,
        `${root}/private`,
        `${root}/runtime`,
      ]);
    }
  };
  const probeSource = `process.stdout.write(JSON.stringify(await (${probeApi.toString()})(false)));`;
  const controllerProbe = async (probe, mode) =>
    JSON.parse(
      await node(
        `const value = JSON.parse(process.argv[2]); process.stdout.write(JSON.stringify(await (${probe.toString()})(value.operatorPath, value.mode)));`,
        { operatorPath: `${root}/operator.json`, mode },
      ),
    );
  const kestra = (mode) => controllerProbe(probeKestra, mode);
  let kestraBaseline;
  const verify = async (baseline, label) => {
    const value = JSON.parse(await api(probeSource));
    assert.deepEqual(value, baseline, `${label} changed durable fixtures`);
    assert.deepEqual(
      await kestra('read'),
      kestraBaseline,
      `${label} changed Kestra internal storage`,
    );
    raw.steps.push({ operation: label, durableFixturesPreserved: true });
    await save();
  };
  try {
    const config = await json(`${root}/deployment.json`);
    assert.equal(config.profile, 'hybrid');
    assert.equal(config.host.workerHosts, 2);
    const manifests = await Promise.all(
      releases.map((path) => json(`${path}/release-manifest.json`)),
    );
    assert.notDeepEqual(manifests[0].images, manifests[1].images);
    assert.deepEqual(config.images, manifests[0].images);
    await cli('prepare');
    await transfer();
    await workerAction('start');
    assert.equal((await cli('install')).status, 'ready');
    const baseline = JSON.parse(
      await api(
        `process.stdout.write(JSON.stringify(await (${probeApi.toString()})(true)));`,
      ),
    );
    kestraBaseline = await kestra('seed');
    raw.steps.push({ operation: 'install', ready: true });
    for (const command of ['stop', 'uninstall']) {
      await workerAction(command);
      const result = await cli(command);
      assert.equal(result.dataPreserved, true);
      assert.equal(result.remoteWorkerActionRequired, true);
      if (command === 'uninstall') await transfer();
      await workerAction('start');
      assert.equal((await cli('resume')).status, 'ready');
      await verify(baseline, `${command}/resume`);
    }
    // The fixture backup entry uses the production backup API and native PostgreSQL tools.
    await workerAction('stop');
    await compose(controller, 0, ['stop']);
    const backup = await controllerProbe(createBackup);
    assert.equal(backup.status, 'verified');
    await workerAction('start');
    assert.equal((await cli('resume')).status, 'ready');
    const operator = await json(`${root}/operator.json`);
    const state = await json(`${root}/installer-state.json`);
    config.images = manifests[1].images;
    operator.releaseRoot = releases[1];
    operator.releasePath = `${releases[1]}/release-manifest.json`;
    operator.trust.bundlePath = `${releases[1]}/release-manifest.sigstore.json`;
    await write(`${root}/deployment.json`, config);
    await write(`${root}/operator.json`, operator);
    release = releases[1];
    await assert.rejects(cli('upgrade'), (error) =>
      error.stderr.includes('UPGRADE'),
    );
    raw.steps.push({
      operation: 'upgrade-without-backup-binding',
      rejected: true,
    });
    operator.upgradeFromReleaseHash = state.releaseHash;
    operator.backupManifestSha256 = backup.manifestSha256;
    operator.upgradeBackup = backup.upgradeBackup;
    await write(`${root}/operator.json`, operator);
    await workerAction('stop');
    const previous = await read(`${root}/docker-compose.worker-1.json`);
    const upgrade = cli('upgrade');
    // Upgrade renders the new fragments before it waits for remote readiness.
    let changed = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if ((await read(`${root}/docker-compose.worker-1.json`)) !== previous) {
        changed = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 1000));
    }
    assert.ok(changed, 'Upgrade did not publish new worker fragments.');
    await transfer();
    await workerAction('start');
    assert.equal((await upgrade).status, 'ready');
    await verify(baseline, 'backup-gated-upgrade');
    for (const [offset, host] of workers.entries()) {
      const id = await compose(host, offset + 1, ['ps', '-q', 'workers']);
      assert.equal(
        await execute([
          'exec',
          host,
          'docker',
          'inspect',
          '--format',
          '{{.Config.Image}}',
          id,
        ]),
        manifests[1].images.workers,
      );
    }
    operator.confirmErase = project;
    await write(`${root}/operator.json`, operator);
    await workerAction('erase');
    await cli('stop');
    await controllerProbe(probeExternal, 'seed');
    assert.equal((await cli('erase')).dataPreserved, false);
    for (const [offset, host] of [controller, ...workers].entries()) {
      const ownedProject = offset ? `${project}-worker-${offset}` : project;
      for (const kind of ['container', 'volume', 'network']) {
        const args = kind === 'container' ? ['ps', '-aq'] : [kind, 'ls', '-q'];
        assert.equal(
          await execute([
            'exec',
            host,
            'docker',
            ...args,
            '--filter',
            `label=com.docker.compose.project=${ownedProject}`,
          ]),
          '',
        );
      }
    }
    const external = await controllerProbe(probeExternal, 'read');
    assert.equal(external.preserved, true);
    raw.steps.push({
      operation: 'erase',
      ownedResourcesRemoved: true,
      externalResourcesPreserved: true,
    });
    raw.status = 'passed';
    await save();
    const result = {
      schemaVersion: 1,
      status: 'passed',
      profile: 'hybrid',
      steps: raw.steps,
      remoteActionsCompleted: raw.remoteActions.length,
      releases: manifests.map((manifest) => ({
        images: manifest.images,
        sourceRevision: manifest.sourceRevision,
      })),
      probeSha256: digest(probeSource),
      limitations: [
        'Three Docker hosts share one physical host.',
        'Shared POSIX volumes do not qualify a district network filesystem.',
      ],
    };
    await writeFile(
      join(outputDirectory, 'result.json'),
      JSON.stringify(result, null, 2) + '\n',
      { mode: 0o600 },
    );
    return result;
  } catch (error) {
    raw.status = 'failed';
    raw.error = error.message;
    await save();
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const path = process.env.CC_HYBRID_LIFECYCLE_FIXTURE;
  assert.ok(
    path,
    'Set CC_HYBRID_LIFECYCLE_FIXTURE to the protected fixture descriptor.',
  );
  const fixture = JSON.parse(await readFile(path, 'utf8'));
  const result = await runHybridLifecycle(fixture);
  await chmod(join(fixture.outputDirectory, 'result.json'), 0o600);
  console.log(JSON.stringify(result));
}

/** Verify preserved fixtures after an observer failure at the erasure boundary. */
export async function verifyHybridErasure(fixture) {
  assert.equal(fixture.qualificationOnly, true);
  assert.equal(fixture.controller, 'cc16-hybrid-controller');
  assert.equal(fixture.root, '/opt/cc16-hybrid');
  assert.equal(fixture.project, 'cc-16-hybrid');
  assert.deepEqual(fixture.workers, [
    'cc16-hybrid-worker-1',
    'cc16-hybrid-worker-2',
  ]);
  const prior = JSON.parse(
    await readFile(join(fixture.outputDirectory, 'raw-result.json'), 'utf8'),
  );
  assert.equal(prior.status, 'failed');
  assert.deepEqual(
    prior.steps.map((step) => step.operation),
    [
      'install',
      'stop/resume',
      'uninstall/resume',
      'upgrade-without-backup-binding',
      'backup-gated-upgrade',
    ],
  );
  assert.ok(
    prior.steps.slice(1, 3).every((step) => step.durableFixturesPreserved),
  );
  assert.equal(prior.steps[3].rejected, true);
  assert.equal(prior.steps[4].durableFixturesPreserved, true);
  const inspect = `const fs=await import('node:fs/promises');const args=JSON.parse(process.argv[2]);const root=args.root;const releases=await Promise.all(args.releases.map(async p=>{const m=JSON.parse(await fs.readFile(p+'/release-manifest.json'));return {sourceRevision:m.sourceRevision,images:m.images}}));const state=JSON.parse(await fs.readFile(root+'/installer-state.json'));const op=JSON.parse(await fs.readFile(root+'/operator.json'));const config=JSON.parse(await fs.readFile(op.configurationPath));const manifest=JSON.parse(await fs.readFile(op.releasePath));console.log(JSON.stringify({phase:state.phase,images:config.images,manifestImages:manifest.images,sourceRevision:manifest.sourceRevision,releases}));`;
  const current = JSON.parse(
    await execute(
      [
        'exec',
        '-i',
        fixture.controller,
        'node',
        '--input-type=module',
        '-',
        JSON.stringify({ root: fixture.root, releases: fixture.releases }),
      ],
      inspect,
    ),
  );
  assert.equal(current.phase, 'erased');
  assert.deepEqual(current.images, current.manifestImages);
  for (const [offset, host] of [
    fixture.controller,
    ...fixture.workers,
  ].entries()) {
    const project = offset
      ? `${fixture.project}-worker-${offset}`
      : fixture.project;
    for (const kind of ['container', 'volume', 'network']) {
      const args = kind === 'container' ? ['ps', '-aq'] : [kind, 'ls', '-q'];
      assert.equal(
        await execute([
          'exec',
          host,
          'docker',
          ...args,
          '--filter',
          `label=com.docker.compose.project=${project}`,
        ]),
        '',
      );
    }
  }
  const external = JSON.parse(
    await execute(
      [
        'exec',
        '-i',
        fixture.controller,
        'node',
        '--input-type=module',
        '-',
        `${fixture.root}/operator.json`,
      ],
      `console.log(JSON.stringify(await (${probeExternal.toString()})(process.argv[2], 'read')));`,
    ),
  );
  assert.equal(external.preserved, true);
  const result = {
    schemaVersion: 1,
    profile: 'hybrid',
    status: 'passed',
    steps: [
      ...prior.steps,
      {
        operation: 'erase',
        ownedResourcesRemoved: true,
        externalResourcesPreserved: true,
      },
    ],
    remoteActionsCompleted: prior.remoteActions.filter(
      (entry) => entry.completed,
    ).length,
    checkedAt: new Date().toISOString(),
    releases: current.releases,
    fixtureDigests: {
      baseline: external.baselineSha256,
      recovered: external.recoveredSha256,
    },
    finalImages: current.images,
    sourceRevision: current.sourceRevision,
    externalArtifactFiles: external.artifactFileCount,
    externalKestraFiles: external.kestraFileCount,
    observerCorrection:
      'Lifecycle actions completed once. The final database timestamp comparison normalized Date objects to their unchanged serialized values.',
    originalFailurePreserved: true,
    limitations: [
      'Three Docker hosts share one physical host.',
      'Shared POSIX volumes do not qualify a district network filesystem.',
      'The controller required private cgroup initialization before resource-limited workloads could start.',
    ],
  };
  await writeFile(
    join(fixture.outputDirectory, 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
    { mode: 0o600 },
  );
  return result;
}
