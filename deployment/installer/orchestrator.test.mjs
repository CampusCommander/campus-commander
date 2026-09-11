import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { replaceBootstrap } from '../bootstrap/access.mjs';
import {
  authenticateRelease,
  archiveKubernetesManifest,
  executeInstaller,
  generatedManifestRecord,
  kubernetesLifecycleItems,
  runCommand,
  verifyGeneratedManifests,
} from './orchestrator.mjs';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cc-installer-unit-'));
  const config = JSON.parse(
    await readFile(
      new URL('../examples/all-docker.json', import.meta.url),
      'utf8',
    ),
  );
  const release = {
    schemaVersion: 1,
    sourceRevision: 'a'.repeat(40),
    architectures: ['linux/amd64'],
    images: config.images,
  };
  const operator = {
    installationRoot: join(root, 'installation'),
    configurationPath: join(root, 'config.json'),
    releasePath: join(root, 'release.json'),
    releaseRoot: root,
    project: 'cc-installer-unit',
  };
  await writeFile(operator.configurationPath, JSON.stringify(config));
  await writeFile(operator.releasePath, JSON.stringify(release));
  const calls = [];
  const dependencies = {
    run: async (file, args) => {
      calls.push([file, args]);
      return '';
    },
    preflight: async () => ({
      status: 'passed',
      checks: [{ name: 'runtime', status: 'passed' }],
    }),
    readiness: async () => ({
      status: 'ready',
      checks: Array.from({ length: 8 }, (_, index) => ({
        name: String(index),
        status: 'ready',
      })),
    }),
    readinessAttempts: 1,
    pollMilliseconds: 0,
  };
  return { root, config, release, operator, dependencies, calls };
}

test('Kubernetes uninstall includes retired upgrade resources and preserves external resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-kube-history-'));
  const project = 'cc-kube-history';
  const resource = (kind, name) => ({
    apiVersion: kind === 'Job' ? 'batch/v1' : 'v1',
    kind,
    metadata: { name, namespace: project },
  });
  const shared = [
    resource('PersistentVolumeClaim', 'data'),
    resource('Secret', 'operator-secret'),
  ];
  const previous = {
    apiVersion: 'v1',
    kind: 'List',
    items: [
      resource('ConfigMap', 'config-before'),
      resource('Job', 'prepare-before'),
      ...shared,
    ],
  };
  const current = {
    apiVersion: 'v1',
    kind: 'List',
    items: [
      resource('ConfigMap', 'config-after'),
      resource('Job', 'prepare-after'),
      ...shared,
    ],
  };
  const state = {
    phase: 'ready',
    steps: ['prepared', 'started', 'ready'],
    generatedManifests: {
      'kubernetes.json': generatedManifestRecord(
        'kubernetes.json',
        previous,
        project,
      ),
    },
  };
  try {
    await writeFile(join(root, 'kubernetes.json'), JSON.stringify(previous));
    await archiveKubernetesManifest({ root, state, project, next: current });
    assert.equal(Object.keys(state.kubernetesHistory).length, 1);
    await writeFile(join(root, 'kubernetes.json'), JSON.stringify(current));
    state.generatedManifests['kubernetes.json'] = generatedManifestRecord(
      'kubernetes.json',
      current,
      project,
    );
    await verifyGeneratedManifests({ root, state, project });
    await archiveKubernetesManifest({ root, state, project, next: current });
    assert.equal(Object.keys(state.kubernetesHistory).length, 1);
    const uninstall = await kubernetesLifecycleItems({
      root,
      state,
      project,
      current,
      command: 'uninstall',
    });
    assert.deepEqual(uninstall.map((item) => item.metadata.name).sort(), [
      'config-after',
      'config-before',
      'prepare-after',
      'prepare-before',
    ]);
    const erase = await kubernetesLifecycleItems({
      root,
      state,
      project,
      current,
      command: 'erase',
    });
    assert.deepEqual(
      erase.map((item) => item.metadata.name),
      ['data'],
    );
    const archive = Object.keys(state.kubernetesHistory)[0];
    const altered = structuredClone(previous);
    altered.items[0].metadata.name = 'unowned-config';
    await writeFile(join(root, archive), JSON.stringify(altered));
    await assert.rejects(verifyGeneratedManifests({ root, state, project }), {
      code: 'MANIFEST_BINDING',
    });
    await assert.rejects(
      kubernetesLifecycleItems({
        root,
        state,
        project,
        current,
        command: 'uninstall',
      }),
      { code: 'MANIFEST_BINDING' },
    );
    altered.items[0].metadata.namespace = 'another-installation';
    await writeFile(join(root, archive), JSON.stringify(altered));
    await assert.rejects(verifyGeneratedManifests({ root, state, project }), {
      code: 'MANIFEST_OWNERSHIP',
    });
    state.kubernetesHistory = {
      '../outside.json': state.kubernetesHistory[archive],
    };
    await assert.rejects(verifyGeneratedManifests({ root, state, project }), {
      code: 'MANIFEST_BINDING',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Kubernetes manifest history remains verified across persisted rendering interruptions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-kube-interrupted-history-'));
  const project = 'cc-kube-interrupted-history';
  const manifest = (name) => ({
    apiVersion: 'v1',
    kind: 'List',
    items: [
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name, namespace: project },
        data: { fixture: name },
      },
    ],
  });
  const previous = manifest('configuration-before');
  const next = manifest('configuration-after');
  const state = {
    phase: 'rendering',
    steps: ['prepared', 'started', 'ready'],
    generatedManifests: {
      'kubernetes.json': generatedManifestRecord(
        'kubernetes.json',
        previous,
        project,
      ),
    },
  };
  const statePath = join(root, 'installer-state.json');
  try {
    await writeFile(join(root, 'kubernetes.json'), JSON.stringify(previous));
    await archiveKubernetesManifest({ root, state, project, next });
    state.pendingGeneratedManifests = {
      'kubernetes.json': generatedManifestRecord(
        'kubernetes.json',
        next,
        project,
      ),
    };
    await writeFile(statePath, JSON.stringify(state));
    for (const current of [previous, next]) {
      await writeFile(join(root, 'kubernetes.json'), JSON.stringify(current));
      const resumed = JSON.parse(await readFile(statePath, 'utf8'));
      await verifyGeneratedManifests({
        root,
        state: resumed,
        project,
        allowPending: true,
      });
      const lifecycle = {
        root,
        state: resumed,
        project,
        current,
        command: 'uninstall',
      };
      if (current === next) {
        await assert.rejects(kubernetesLifecycleItems(lifecycle), {
          code: 'MANIFEST_BINDING',
        });
        await assert.rejects(
          verifyGeneratedManifests({ root, state: resumed, project }),
          {
            code: 'MANIFEST_BINDING',
          },
        );
        continue;
      }
      const cleanup = await kubernetesLifecycleItems(lifecycle);
      assert.ok(
        cleanup.some((item) => item.metadata.name === 'configuration-before'),
      );
      assert.equal(cleanup.length, 1);
    }
    const changed = manifest('configuration-changed-after-interruption');
    const interrupted = JSON.parse(await readFile(statePath, 'utf8'));
    await archiveKubernetesManifest({
      root,
      state: interrupted,
      project,
      next: changed,
    });
    assert.equal(Object.keys(interrupted.kubernetesHistory).length, 1);
    interrupted.generatedManifests['kubernetes.json'] = generatedManifestRecord(
      'kubernetes.json',
      changed,
      project,
    );
    const interruptedCleanup = await kubernetesLifecycleItems({
      root,
      state: interrupted,
      project,
      current: changed,
      command: 'uninstall',
    });
    assert.deepEqual(
      interruptedCleanup.map((item) => item.metadata.name).sort(),
      ['configuration-before', 'configuration-changed-after-interruption'],
    );
    state.generatedManifests = state.pendingGeneratedManifests;
    delete state.pendingGeneratedManifests;
    state.phase = 'prepared';
    await writeFile(statePath, JSON.stringify(state));
    const resumed = JSON.parse(await readFile(statePath, 'utf8'));
    await verifyGeneratedManifests({ root, state: resumed, project });
    const cleanup = await kubernetesLifecycleItems({
      root,
      state: resumed,
      project,
      current: next,
      command: 'uninstall',
    });
    assert.equal(cleanup.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Kubernetes installation rejects local administrator line endings before apply without changing Secrets', async () => {
  const f = await setup();
  try {
    const config = JSON.parse(
      await readFile(
        new URL('../examples/kubernetes.json', import.meta.url),
        'utf8',
      ),
    );
    const kubernetes = JSON.parse(
      await readFile(
        new URL('../kubernetes/operator.example.json', import.meta.url),
        'utf8',
      ),
    );
    kubernetes.namespace = 'cc-installer-kube-admin';
    config.services.api.placement.replicas = 2;
    for (const [name, service] of Object.entries(config.services)) {
      if (name !== 'edge')
        service.endpoint.url = service.endpoint.url.replace(
          '.campus-commander.svc.',
          `.${kubernetes.namespace}.svc.`,
        );
    }
    f.operator.kubernetes = kubernetes;
    f.operator.cluster = { context: 'synthetic-qualified-context' };
    await writeFile(f.operator.configurationPath, JSON.stringify(config));
    const data = {};
    const collectStrings = (value) => {
      if (typeof value === 'string')
        data[value] = Buffer.from('synthetic-service-value\r\n').toString(
          'base64',
        );
      else if (value && typeof value === 'object')
        Object.values(value).forEach(collectStrings);
    };
    collectStrings(config);
    collectStrings(kubernetes);
    const adminName = kubernetes.databaseAdmins.applicationDatabase.name;
    const valid = 'private-fixture-marker-kept-redacted';
    let adminData = {};
    f.dependencies.run = async (file, args) => {
      f.calls.push([file, args]);
      if (
        file === 'kubectl' &&
        args.includes('get') &&
        args.includes('secret')
      ) {
        return JSON.stringify({
          data: { ...data, ...(args.includes(adminName) ? adminData : {}) },
        });
      }
      return '';
    };
    for (const database of ['applicationDatabase', 'kestraDatabase']) {
      for (const delimiter of ['\n', '\r\n']) {
        adminData = Object.fromEntries(
          Object.values(kubernetes.databaseAdmins).map((ref) => [
            ref.key,
            Buffer.from(valid).toString('base64'),
          ]),
        );
        adminData[kubernetes.databaseAdmins[database].key] = Buffer.from(
          valid + delimiter,
        ).toString('base64');
        const original = JSON.stringify(adminData);
        f.calls.length = 0;
        await assert.rejects(
          executeInstaller({
            command: 'install',
            operator: f.operator,
            qualification: true,
            dependencies: f.dependencies,
          }),
          (error) => {
            assert.equal(error.code, 'SECRETS');
            assert.match(error.message, /without CR or LF/);
            assert.ok(!error.message.includes(valid));
            return true;
          },
        );
        assert.ok(
          !f.calls.some(
            ([file, args]) => file === 'kubectl' && args.includes('apply'),
          ),
        );
        assert.equal(JSON.stringify(adminData), original);
        assert.ok(
          !f.calls.some(
            ([file, args]) =>
              file === 'kubectl' &&
              ['patch', 'replace', 'create'].some((command) =>
                args.includes(command),
              ),
          ),
        );
      }
    }
    adminData = Object.fromEntries(
      Object.values(kubernetes.databaseAdmins).map((ref) => [
        ref.key,
        Buffer.from(valid).toString('base64'),
      ]),
    );
    const result = await executeInstaller({
      command: 'install',
      operator: f.operator,
      qualification: true,
      dependencies: f.dependencies,
    });
    assert.equal(result.status, 'ready');
    assert.ok(
      f.calls.some(
        ([file, args]) => file === 'kubectl' && args.includes('apply'),
      ),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('interruption resumes with existing secrets and rejects changed inputs', async () => {
  const f = await setup();
  try {
    let interrupt = true;
    f.dependencies.run = async (file, args) => {
      f.calls.push([file, args]);
      if (interrupt && args.includes('up'))
        throw new Error('password=DO_NOT_EXPOSE');
      return '';
    };
    await assert.rejects(
      executeInstaller({
        command: 'install',
        operator: f.operator,
        qualification: true,
        dependencies: f.dependencies,
      }),
      (error) => !error.message.includes('DO_NOT_EXPOSE'),
    );
    const profileInode = (
      await lstat(join(f.operator.installationRoot, 'runtime/profile.json'))
    ).ino;
    const secret = await readFile(
      join(f.operator.installationRoot, 'private/bootstrap'),
    );
    interrupt = false;
    assert.equal(
      (
        await executeInstaller({
          command: 'resume',
          operator: f.operator,
          qualification: true,
          dependencies: f.dependencies,
        })
      ).status,
      'ready',
    );
    assert.deepEqual(
      await readFile(join(f.operator.installationRoot, 'private/bootstrap')),
      secret,
    );
    assert.equal(
      (await lstat(join(f.operator.installationRoot, 'runtime/profile.json')))
        .ino,
      profileInode,
    );
    const state = await readFile(
      join(f.operator.installationRoot, 'installer-state.json'),
      'utf8',
    );
    assert.ok(!state.includes(secret.toString()));
    f.config.artifacts.capacityGiB++;
    await writeFile(f.operator.configurationPath, JSON.stringify(f.config));
    await assert.rejects(
      executeInstaller({
        command: 'resume',
        operator: f.operator,
        qualification: true,
        dependencies: f.dependencies,
      }),
      { code: 'STATE_MISMATCH' },
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('restore marker and qualification ownership fail before mutations', async () => {
  const f = await setup();
  try {
    await mkdir(f.operator.installationRoot, { mode: 0o700 });
    await writeFile(
      join(f.operator.installationRoot, 'RESTORE_DISABLED'),
      'disabled',
    );
    await assert.rejects(
      executeInstaller({
        command: 'install',
        operator: f.operator,
        qualification: true,
        dependencies: f.dependencies,
      }),
      { code: 'RESTORE_DISABLED' },
    );
    await assert.rejects(
      executeInstaller({
        command: 'install',
        operator: { ...f.operator, project: 'district' },
        qualification: true,
        dependencies: f.dependencies,
      }),
      { code: 'QUALIFICATION' },
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('stop and uninstall preserve volumes while erase needs explicit owned project', async () => {
  const f = await setup();
  try {
    await executeInstaller({
      command: 'install',
      operator: f.operator,
      qualification: true,
      dependencies: f.dependencies,
    });
    for (const command of ['stop', 'uninstall'])
      assert.equal(
        (
          await executeInstaller({
            command,
            operator: f.operator,
            qualification: true,
            dependencies: f.dependencies,
          })
        ).dataPreserved,
        true,
      );
    assert.ok(f.calls.every(([, args]) => !args.includes('--volumes')));
    await assert.rejects(
      executeInstaller({
        command: 'erase',
        operator: f.operator,
        qualification: true,
        dependencies: f.dependencies,
      }),
      { code: 'ERASURE' },
    );
    await executeInstaller({
      command: 'erase',
      operator: { ...f.operator, confirmErase: f.operator.project },
      qualification: true,
      dependencies: f.dependencies,
    });
    assert.ok(f.calls.some(([, args]) => args.includes('--volumes')));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('normal installation rejects unsigned and incomplete signed releases', async () => {
  const f = await setup();
  try {
    await assert.rejects(
      executeInstaller({
        command: 'validate',
        operator: f.operator,
        dependencies: f.dependencies,
      }),
      { code: 'TRUST' },
    );
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const bytes = await readFile(f.operator.releasePath);
    await writeFile(join(f.root, 'signature'), sign(null, bytes, privateKey));
    await writeFile(
      join(f.root, 'public.pem'),
      publicKey.export({ type: 'spki', format: 'pem' }),
    );
    await assert.rejects(
      authenticateRelease(
        {
          ...f.operator,
          trust: {
            kind: 'ed25519',
            signaturePath: join(f.root, 'signature'),
            publicKeyPath: join(f.root, 'public.pem'),
          },
        },
        { qualification: false },
      ),
      /evidence/,
    );
    const calls = [];
    await assert.rejects(
      authenticateRelease(
        {
          ...f.operator,
          trust: {
            kind: 'cosign',
            identity: 'https://github.com/district/repo/workflow@ref',
            issuer: 'https://token.actions.githubusercontent.com',
            bundlePath: join(f.root, 'bundle'),
          },
        },
        {
          qualification: false,
          run: async (file, args) => {
            calls.push([file, args]);
            return 'verified';
          },
        },
      ),
      /evidence/,
    );
    assert.ok(calls[0][1].includes('--certificate-identity'));
    assert.ok(!calls[0][1].some((value) => value.includes('insecure')));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('restore markers leave diagnostic and stop commands available', async () => {
  const f = await setup();
  try {
    await executeInstaller({
      command: 'install',
      operator: f.operator,
      qualification: true,
      dependencies: f.dependencies,
    });
    await writeFile(
      join(f.operator.installationRoot, 'RESTORE_DISABLED'),
      'disabled',
    );
    assert.equal(
      (
        await executeInstaller({
          command: 'status',
          operator: f.operator,
          qualification: true,
          dependencies: f.dependencies,
        })
      ).state.phase,
      'ready',
    );
    assert.equal(
      (
        await executeInstaller({
          command: 'stop',
          operator: f.operator,
          qualification: true,
          dependencies: f.dependencies,
        })
      ).status,
      'stopped',
    );
    await assert.rejects(
      executeInstaller({
        command: 'resume',
        operator: f.operator,
        qualification: true,
        dependencies: f.dependencies,
      }),
      { code: 'RESTORE_DISABLED' },
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('edited Compose volume ownership blocks erasure before Docker execution', async () => {
  const f = await setup();
  try {
    await executeInstaller({
      command: 'install',
      operator: f.operator,
      qualification: true,
      dependencies: f.dependencies,
    });
    const path = join(f.operator.installationRoot, 'docker-compose.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.volumes.artifacts = { name: 'district_existing_volume' };
    await writeFile(path, JSON.stringify(manifest));
    f.calls.length = 0;
    await assert.rejects(
      executeInstaller({
        command: 'erase',
        operator: { ...f.operator, confirmErase: f.operator.project },
        qualification: true,
        dependencies: f.dependencies,
      }),
      { code: 'MANIFEST_OWNERSHIP' },
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('generated worker fragments and namespace resources remain bound through interrupted publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-manifest-binding-')),
    project = 'cc-binding';
  try {
    const filename = 'docker-compose.worker-1.json';
    const old = {
      name: `${project}-worker-1`,
      services: { workers: { image: 'candidate-a' } },
      volumes: {},
    };
    const next = { ...old, services: { workers: { image: 'candidate-b' } } };
    const state = {
      phase: 'rendering',
      steps: ['prepared'],
      generatedManifests: {
        [filename]: generatedManifestRecord(filename, old, project),
      },
      pendingGeneratedManifests: {
        [filename]: generatedManifestRecord(filename, next, project),
      },
    };
    await writeFile(join(root, filename), JSON.stringify(old));
    await verifyGeneratedManifests({
      root,
      state,
      project,
      allowPending: true,
    });
    await writeFile(join(root, filename), JSON.stringify(next));
    await verifyGeneratedManifests({
      root,
      state,
      project,
      allowPending: true,
    });
    await assert.rejects(verifyGeneratedManifests({ root, state, project }), {
      code: 'MANIFEST_BINDING',
    });
    next.services.workers.command = ['unreviewed'];
    await writeFile(join(root, filename), JSON.stringify(next));
    await assert.rejects(
      verifyGeneratedManifests({ root, state, project, allowPending: true }),
      { code: 'MANIFEST_BINDING' },
    );
    assert.throws(
      () =>
        generatedManifestRecord(
          'kubernetes.json',
          {
            kind: 'List',
            items: [
              {
                kind: 'PersistentVolumeClaim',
                metadata: { name: 'existing', namespace: 'other-district' },
              },
            ],
          },
          project,
        ),
      { code: 'MANIFEST_OWNERSHIP' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('daemon filesystem failure stops installation before Compose startup', async () => {
  const f = await setup();
  try {
    f.dependencies.preflight = async () => ({
      status: 'failed',
      checks: [
        {
          name: 'docker-installation-filesystem',
          status: 'failed',
          instruction: 'Run the installer on the Docker daemon host.',
        },
      ],
    });
    await assert.rejects(
      executeInstaller({
        command: 'install',
        operator: f.operator,
        qualification: true,
        dependencies: f.dependencies,
      }),
      {
        code: 'PREREQUISITES',
        message:
          /docker-installation-filesystem: Run the installer on the Docker daemon host\./,
      },
    );
    assert.equal(
      f.calls.some(([file, args]) => file === 'docker' && args.includes('up')),
      false,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('reset-bootstrap reaches an internal-only database through the bound Compose service', async () => {
  const f = await setup();
  try {
    f.config.services.applicationDatabase.endpoint.url =
      'postgresql://application-postgres:5432';
    await writeFile(f.operator.configurationPath, JSON.stringify(f.config));
    await executeInstaller({
      command: 'install',
      operator: f.operator,
      qualification: true,
      dependencies: f.dependencies,
    });
    const manifest = JSON.parse(
      await readFile(
        join(f.operator.installationRoot, 'docker-compose.json'),
        'utf8',
      ),
    );
    assert.deepEqual(manifest.services['bootstrap-initialize'].networks, [
      'internal',
    ]);
    assert.equal(manifest.services['application-postgres'].ports, undefined);
    let current = { generation: '1', credential_hash: 'expired' };
    let updates = 0;
    let disconnects = 0;
    let interrupt = true;
    const pending = join(
      f.operator.installationRoot,
      'private/bootstrap.pending',
    );
    const active = join(f.operator.installationRoot, 'private/bootstrap');
    const previous = await readFile(active, 'utf8');
    f.dependencies.run = async (file, args, options) => {
      assert.equal(file, 'docker');
      assert.deepEqual(args.slice(0, 6), [
        'compose',
        '-f',
        join(f.operator.installationRoot, 'docker-compose.json'),
        '-p',
        f.operator.project,
        'run',
      ]);
      assert.ok(args.includes('--no-deps'));
      assert.ok(args.includes('--rm'));
      assert.ok(args.includes('-T'));
      assert.ok(args.includes('bootstrap-initialize'));
      const token = await readFile(pending, 'utf8');
      assert.ok(!args.join(' ').includes(token));
      assert.equal((await lstat(pending)).mode & 0o777, 0o600);
      await assert.rejects(
        executeInstaller({
          command: 'reset-bootstrap',
          operator: { ...f.operator, expectedBootstrapGeneration: '1' },
          qualification: true,
          dependencies: f.dependencies,
        }),
        { code: 'BUSY' },
      );
      let output = '';
      const syntheticProcess = {
        stdin: (async function* () {
          yield options.input;
        })(),
        stdout: {
          write: (value) => {
            output += value;
          },
        },
      };
      const connect = async (service) => {
        assert.equal(
          new URL(service.endpoint.url).hostname,
          'application-postgres',
        );
        return {
          query: async (sql, parameters) => {
            if (sql.startsWith('SELECT')) return { rows: [current] };
            assert.match(sql, /WHERE id = 1 AND generation = \$3/);
            if (String(parameters[2]) !== current.generation)
              return { rowCount: 0, rows: [] };
            updates++;
            current = {
              generation: String(BigInt(current.generation) + 1n),
              credential_hash: parameters[0],
            };
            return { rowCount: 1, rows: [current] };
          },
          end: async () => {
            disconnects++;
          },
        };
      };
      const source = args.at(-1).replace(/^import .*;$/gm, '');
      const AsyncFunction = Object.getPrototypeOf(
        async () => undefined,
      ).constructor;
      await new AsyncFunction(
        'process',
        'readFile',
        'connectDatabase',
        'secretPath',
        'createHash',
        'replaceBootstrap',
        source,
      )(
        syntheticProcess,
        async () => JSON.stringify(f.config),
        connect,
        (ref) => ref.path,
        createHash,
        replaceBootstrap,
      );
      if (interrupt) {
        interrupt = false;
        throw new Error('Simulated lost command response');
      }
      return output;
    };
    const reset = (generation = '1') =>
      executeInstaller({
        command: 'reset-bootstrap',
        operator: { ...f.operator, expectedBootstrapGeneration: generation },
        qualification: true,
        dependencies: f.dependencies,
      });
    await assert.rejects(reset(), { code: 'INSTALLATION_FAILED' });
    assert.equal(updates, 1);
    assert.equal(await readFile(active, 'utf8'), previous);
    const token = await readFile(pending, 'utf8');
    assert.deepEqual(await reset(), { status: 'replaced', generation: '2' });
    assert.equal(updates, 1);
    assert.equal(disconnects, 2);
    assert.equal(await readFile(active, 'utf8'), token);
    await assert.rejects(lstat(pending), { code: 'ENOENT' });
    await assert.rejects(reset(), { code: 'INSTALLATION_FAILED' });
    assert.equal(updates, 1);
    assert.equal(await readFile(active, 'utf8'), token);
    manifest.services['bootstrap-initialize'].networks = ['ingress'];
    await writeFile(
      join(f.operator.installationRoot, 'docker-compose.json'),
      JSON.stringify(manifest),
    );
    await assert.rejects(reset('2'), { code: 'MANIFEST_BINDING' });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('command runner sends recovery input through stdin and redacts process failures', async () => {
  const input = 'private-recovery-credential';
  assert.equal(
    await runCommand(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { createHash } from 'node:crypto';
    let value = '';
    for await (const chunk of process.stdin) value += chunk;
    process.stdout.write(createHash('sha256').update(value).digest('hex'));
  `,
      ],
      { input },
    ),
    createHash('sha256').update(input).digest('hex'),
  );
  await assert.rejects(
    runCommand(
      process.execPath,
      [
        '-e',
        'process.stdin.pipe(process.stderr); process.stdin.on("end", () => process.exit(1))',
      ],
      { input },
    ),
    (error) => {
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.ok(!error.message.includes(input));
      return true;
    },
  );
});
