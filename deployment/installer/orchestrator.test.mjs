import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
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
import {
  authenticateRelease,
  executeInstaller,
  generatedManifestRecord,
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
      { code: 'PREREQUISITES' },
    );
    assert.equal(
      f.calls.some(([file, args]) => file === 'docker' && args.includes('up')),
      false,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
