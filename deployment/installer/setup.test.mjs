import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  writeFile,
  stat,
  rm,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';
import { renderAllDocker } from '../profiles/all-docker/render.mjs';
import { renderHybrid } from '../profiles/hybrid/render.mjs';
import { renderKubernetes } from '../kubernetes/render.mjs';
import {
  configure,
  createQuestions,
  parseArguments,
  runSetup,
  prepareLabCertificate,
  verifyClusterSecrets,
} from './setup.mjs';

const releaseRoot = resolve(import.meta.dirname, '../..');
const images = Object.fromEntries(
  ['frontend', 'api', 'workers'].map((n, i) => [
    n,
    `ghcr.io/campuscommander/${n}@sha256:${String(i + 2).repeat(64)}`,
  ]),
);
const manifest = {
  schemaVersion: 1,
  images,
  sourceRevision: 'a'.repeat(40),
  architectures: ['linux/amd64'],
};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cc-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('arguments reject duplicate, relative, destructive, and unknown options', () => {
  assert.deepEqual(
    parseArguments([
      '--release-root',
      '/release',
      '--qualification',
      '--profile',
      'hybrid',
    ]),
    { releaseRoot: '/release', qualification: true, profile: 'hybrid' },
  );
  for (const args of [
    [],
    ['--release-root', 'relative'],
    ['--release-root', '/a', '--command', 'erase'],
    ['--release-root', '/a', '--root', '/x', '--root', '/y'],
    ['--release-root', '/a', '--secret', 'raw'],
  ])
    assert.throws(() => parseArguments(args));
});

test('automation rejects unknown answers and missing required answers', async () => {
  const q = createQuestions({ ignored: 'value' });
  await assert.rejects(q('required', 'Required answer'));
  assert.throws(() => q.finish());
  const exact = createQuestions({ count: 2 });
  assert.equal(await exact('count', 'Count', 1, (v) => v === 2), 2);
  exact.finish();
});

test('interactive questions repeat invalid answers without restarting setup or echoing the answer', async () => {
  const prompts = [];
  const replies = ['private-invalid-value', 'yes'];
  const q = createQuestions({}, async (label) => {
    prompts.push(label);
    return replies.shift();
  });
  assert.equal(
    await q('choice', 'Continue (yes/no)', 'no', (v) =>
      ['yes', 'no'].includes(v),
    ),
    'yes',
  );
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /That answer is invalid/);
  assert.doesNotMatch(prompts.join('\n'), /private-invalid-value/);
});

test('guided all-docker storage matches writable application volume mounts', async () => {
  const prompts = [];
  const questions = createQuestions(
    { labCertificate: 'yes' },
    async (label) => {
      prompts.push(label);
      return '';
    },
  );
  const plan = await configure({
    releaseRoot,
    root: '/opt/cc-hosted-live',
    profile: 'all-docker',
    qualification: true,
    questions,
    manifest,
  });
  questions.finish();
  const compose = renderAllDocker(plan.config, manifest);
  for (const name of ['api', 'workers']) {
    const mount = compose.services[name].volumes.find((value) =>
      typeof value === 'string'
        ? value.split(':')[1] === plan.config.artifacts.location
        : value.target === plan.config.artifacts.location,
    );
    assert.ok(mount, `${name} must mount the configured artifact directory`);
    if (typeof mount === 'string') {
      assert.equal(mount.split(':')[0], 'artifacts');
      assert.notEqual(mount.split(':')[2], 'ro');
    } else {
      assert.equal(mount.type, 'volume');
      assert.equal(mount.source, 'artifacts');
      assert.notEqual(mount.read_only, true);
    }
  }
  assert.ok(
    prompts.every(
      (label) => !label.includes('storage path or managed storage identifier'),
    ),
  );
  assert.equal(
    plan.config.artifacts.location,
    '/var/lib/campus-commander/artifacts',
  );
  assert.equal(
    plan.config.services.applicationDatabase.persistence.location,
    '/var/lib/campus-commander/campus-postgres',
  );
  assert.equal(
    plan.config.services.kestraDatabase.persistence.location,
    '/var/lib/campus-commander/kestra-postgres',
  );
  assert.equal(
    plan.config.services.redis.persistence.location,
    '/var/lib/campus-commander/redis',
  );
  assert.equal(
    plan.config.services.kestra.internalStorage.location,
    '/var/lib/campus-commander/kestra-internal',
  );
});

test('all-docker lab requires explicit certificate and exception choices', async () => {
  const q = createQuestions({
    labCertificate: 'yes',
    exceptions: 'time-synchronization',
    'exceptions.time-synchronization.reason':
      'Disposable laboratory lacks systemd',
  });
  const plan = await configure({
    releaseRoot,
    root: '/tmp/cc-test',
    profile: 'all-docker',
    qualification: true,
    questions: q,
    manifest,
  });
  q.finish();
  parseDeploymentConfig(plan.config);
  assert.equal(plan.lab, true);
  assert.equal(plan.operator.bindAddress, '127.0.0.1');
  assert.equal(
    plan.config.services.edge.endpoint.url,
    'https://localhost:8443',
  );
  assert.equal(plan.files.size, 0);
  assert.deepEqual(plan.config.images, images);
  assert.deepEqual(plan.operator.preflightExceptions, [
    {
      name: 'time-synchronization',
      reason: 'Disposable laboratory lacks systemd',
    },
  ]);
  const missing = createQuestions({
    publicUrl: 'https://campus.district.edu',
    exceptions: 'host-memory',
  });
  await assert.rejects(
    configure({
      releaseRoot,
      root: '/tmp/cc-test',
      profile: 'all-docker',
      qualification: true,
      questions: missing,
      manifest,
    }),
    /exceptions.host-memory.reason/,
  );
});

test('hybrid and Kubernetes retain real topology and guide operational inputs', async () => {
  for (const profile of ['hybrid', 'kubernetes']) {
    const seen = new Set();
    const q = async (key, _label, fallback) => {
      seen.add(key);
      if (key === 'publicUrl') return 'https://campus.district.edu';
      if (key.startsWith('workerBindAddresses.'))
        return `192.0.2.${Number(key.split('.').at(-1)) + 10}`;
      if (key.endsWith('.url'))
        return (
          fallback ??
          (key.includes('Database')
            ? 'postgresql://database.district.edu:5432'
            : key.includes('redis')
              ? 'rediss://redis.district.edu:6379'
              : `https://${key.split('.')[1]}.district.edu:8443`)
        );
      if (key.startsWith('files.')) return `/protected/${key.slice(6)}`;
      if (key === 'kubernetes.sourceRanges') return '192.0.2.0/24';
      if (fallback !== undefined) return fallback;
      if (key.endsWith('.location'))
        return `/srv/shared/${key.replaceAll('.', '-')}`;
      return 'district-platform';
    };
    const plan = await configure({
      releaseRoot,
      root: '/tmp/cc-test',
      profile,
      questions: q,
      manifest,
    });
    parseDeploymentConfig(plan.config);
    if (profile === 'hybrid') renderHybrid(plan.config, manifest);
    else
      renderKubernetes(plan.config, {
        ...plan.operator.kubernetes,
        release: manifest,
      });
    assert.equal(plan.config.profile, profile);
    assert.equal(plan.config.host.workerHosts, 2);
    assert.equal(plan.config.artifacts.kind, 'shared-filesystem');
    assert.equal(plan.lab, false);
    assert.ok(plan.files.size > 2);
    if (profile === 'hybrid') {
      assert.equal(
        plan.config.services.applicationDatabase.placement.kind,
        'external',
      );
      assert.equal(plan.config.services.redis.placement.kind, 'external');
      assert.deepEqual(plan.operator.workerBindAddresses, [
        '192.0.2.10',
        '192.0.2.11',
      ]);
      assert.equal(plan.migration.migrationRole, 'application-installer');
      assert.ok(seen.has('files.postgres-migrator'));
    } else {
      assert.ok(seen.has('kubernetes.databaseAdmins.applicationDatabase.name'));
      assert.ok(seen.has('kubernetes.kestraRuntime.applicationKey'));
      assert.ok(seen.has('kubernetes.migrationPasswordSecretRef.name'));
      assert.equal(plan.operator.kubernetes.namespace, 'campus-commander');
      assert.equal(plan.operator.cluster.storageClasses.length, 3);
    }
  }
});

for (const phase of [1, 2])
  test(`runSetup Phase ${phase} preserves configuration and integrates enrollment during resume`, async (t) => {
    const root = join(await fixture(t), 'installation');
    const release = join(await fixture(t), 'release');
    const { cp } = await import('node:fs/promises');
    await mkdir(release);
    await cp(
      join(releaseRoot, 'deployment/examples'),
      join(release, 'deployment/examples'),
      { recursive: true },
    );
    await mkdir(join(release, 'deployment/installer'), { recursive: true });
    await cp(
      join(releaseRoot, 'deployment/installer/operator.example.json'),
      join(release, 'deployment/installer/operator.example.json'),
    );
    await writeFile(
      join(release, 'release-manifest.json'),
      JSON.stringify(manifest),
    );
    const calls = [],
      output = [];
    const enrollments = [];
    const googleFile = join(release, 'google.json');
    await writeFile(
      googleFile,
      JSON.stringify({
        web: {
          client_id: '123-test.apps.googleusercontent.com',
          client_secret: 'synthetic-client-secret',
          project_id: 'campus-test',
          redirect_uris: ['https://localhost:8443/api/auth/callback'],
        },
      }),
      { mode: 0o600 },
    );
    const deps = {
      answers: {
        phase,
        ...(phase === 2
          ? {
              'applicationAuth.provider': 'google',
              'applicationAuth.googleImport': 'file',
              'applicationAuth.googleClientFile': googleFile,
            }
          : {}),
        profile: 'all-docker',
        root,
        candidateAcknowledgement: 'candidate-lab',
        labCertificate: 'yes',
      },
      enroll: async (input) => enrollments.push(input),
      validate: (config) => assert.equal(config.profile, 'all-docker'),
      run: async (file, args) => {
        assert.equal(file, 'openssl');
        await writeFile(args[args.indexOf('-out') + 1], 'certificate');
        await writeFile(args[args.indexOf('-keyout') + 1], 'private-key');
      },
      installer: async (call) => {
        calls.push(call);
        call.onProgress('Waiting for service readiness');
        return { status: 'ready' };
      },
      output: (line) => output.push(line),
    };
    await runSetup(
      {
        releaseRoot: release,
        root,
        profile: 'all-docker',
        qualification: true,
      },
      deps,
    );
    const before = await readFile(join(root, 'operator.json'));
    assert.equal((await stat(join(root, 'operator.json'))).mode & 0o777, 0o600);
    assert.equal(
      (await stat(join(root, 'private/edge-private-key'))).mode & 0o777,
      0o600,
    );
    assert.equal(
      JSON.parse(await readFile(join(root, 'setup-record.json'))).qualification,
      true,
    );
    await runSetup(
      { releaseRoot: '/different-release', root, command: 'resume' },
      { ...deps, answers: {} },
    );
    assert.deepEqual(await readFile(join(root, 'operator.json')), before);
    assert.equal(calls[1].command, 'resume');
    assert.equal(calls[1].qualification, true);
    assert.equal(calls[1].operator.releaseRoot, release);
    assert.ok(output.some((line) => line.includes('https://localhost:8443')));
    assert.equal(
      output.filter((line) =>
        line.includes('Working: Waiting for service readiness'),
      ).length,
      2,
    );
    assert.ok(!output.some((line) => line.includes('private-key')));
    assert.equal(enrollments.length, phase === 2 ? 2 : 0);
    await runSetup(
      { releaseRoot: release, root, command: 'status' },
      { ...deps, answers: {} },
    );
    assert.equal(enrollments.length, phase === 2 ? 2 : 0);
    const uninstallOptions = {
      releaseRoot: release,
      root,
      command: 'uninstall',
    };
    assert.equal(
      (
        await runSetup(uninstallOptions, {
          ...deps,
          answers: {},
          installer: () => assert.fail('Cancellation must preserve services.'),
        })
      ).status,
      'cancelled',
    );
    assert.equal(
      (
        await runSetup(uninstallOptions, {
          ...deps,
          answers: { confirmUninstall: JSON.parse(before).project },
          installer: async (input) => {
            assert.equal(input.command, 'uninstall');
            return { status: 'uninstalled', dataPreserved: true };
          },
        })
      ).status,
      'uninstalled',
    );
    assert.equal(enrollments.length, phase === 2 ? 2 : 0);
    assert.deepEqual(await readFile(join(root, 'operator.json')), before);
    if (phase === 2)
      assert.equal(
        enrollments[0].config.applicationAuth.clientId,
        '123-test.apps.googleusercontent.com',
      );
  });

test('candidate acknowledgement and unknown answers block installation', async (t) => {
  const root = join(await fixture(t), 'installation');
  const release = await fixture(t);
  await writeFile(
    join(release, 'release-manifest.json'),
    JSON.stringify(manifest),
  );
  await assert.rejects(
    runSetup(
      { root, releaseRoot: release, qualification: true },
      { installer: () => assert.fail('installer must not run') },
    ),
    /candidateAcknowledgement/,
  );
});

test('pending setup resumes after interruption without repeating configuration or replacing credentials', async (t) => {
  const root = join(await fixture(t), 'installation');
  const release = await fixture(t);
  const { cp } = await import('node:fs/promises');
  await cp(
    join(releaseRoot, 'deployment/examples'),
    join(release, 'deployment/examples'),
    { recursive: true },
  );
  await mkdir(join(release, 'deployment/installer'), { recursive: true });
  await cp(
    join(releaseRoot, 'deployment/installer/operator.example.json'),
    join(release, 'deployment/installer/operator.example.json'),
  );
  await writeFile(
    join(release, 'release-manifest.json'),
    JSON.stringify(manifest),
  );
  const options = {
    root,
    releaseRoot: release,
    profile: 'all-docker',
    qualification: true,
  };
  await assert.rejects(
    runSetup(options, {
      answers: {
        candidateAcknowledgement: 'candidate-lab',
        labCertificate: 'yes',
      },
      run: async () => {
        throw new Error('Interrupted certificate generation');
      },
      output: () => undefined,
    }),
    /Interrupted/,
  );
  const pendingBytes = await readFile(join(root, 'setup-pending.json'));
  const pending = JSON.parse(pendingBytes);
  await writeFile(
    join(root, 'deployment.json'),
    JSON.stringify(pending.plan.config, null, 2) + '\n',
    { mode: 0o600 },
  );
  await runSetup(options, {
    run: async (_file, args) => {
      await writeFile(args[args.indexOf('-out') + 1], 'certificate');
      await writeFile(args[args.indexOf('-keyout') + 1], 'key');
    },
    installer: async ({ command }) => {
      assert.equal(command, 'install');
      return { status: 'ready' };
    },
    output: () => undefined,
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(root, 'deployment.json'))),
    pending.plan.config,
  );
  await assert.rejects(readFile(join(root, 'setup-pending.json')), {
    code: 'ENOENT',
  });
});

test('hybrid preparation pauses for workers and status reports nested readiness', async (t) => {
  const root = await fixture(t);
  const config = JSON.parse(
    await readFile(join(releaseRoot, 'deployment/examples/hybrid.json')),
  );
  const operator = {
    installationRoot: root,
    configurationPath: join(root, 'deployment.json'),
    releaseRoot,
    project: 'cc-test',
    workerBindAddresses: ['192.0.2.10', '192.0.2.11'],
  };
  for (const [name, value] of [
    ['operator.json', operator],
    ['deployment.json', config],
    ['setup-record.json', { qualification: true }],
  ])
    await writeFile(join(root, name), JSON.stringify(value), { mode: 0o600 });
  const calls = [],
    lines = [];
  const installer = async ({ command }) => {
    calls.push(command);
    return command === 'status'
      ? { state: { phase: 'started' }, readiness: { status: 'degraded' } }
      : { status: command === 'prepare' ? 'prepared' : 'ready' };
  };
  const options = { root, releaseRoot, command: 'resume' };
  assert.equal(
    (await runSetup(options, { installer, output: (line) => lines.push(line) }))
      .status,
    'prepared-workers-pending',
  );
  assert.deepEqual(calls, ['prepare']);
  assert.ok(
    lines.some((line) =>
      line.includes(join(root, 'docker-compose.worker-2.json')),
    ),
  );
  assert.ok(lines.some((line) => line.includes("-p 'cc-test-worker-1' up -d")));
  await runSetup(options, {
    installer,
    answers: { workersReady: 'yes' },
    output: () => undefined,
  });
  assert.deepEqual(calls, ['prepare', 'prepare', 'resume']);
  await runSetup(
    { ...options, command: 'status' },
    { installer, output: (line) => lines.push(line) },
  );
  assert.ok(lines.some((line) => line.startsWith('Readiness: degraded.')));
});

test('certificate publication recovers its matching staged key after interruption', async (t) => {
  const root = await fixture(t);
  const stage = join(root, 'private/.setup-certificate');
  await mkdir(stage, { recursive: true, mode: 0o700 });
  const cert = Buffer.from('original certificate'),
    key = Buffer.from('original matching private key');
  await writeFile(join(stage, 'certificate'), cert, { mode: 0o600 });
  await writeFile(join(stage, 'key'), key, { mode: 0o600 });
  await writeFile(
    join(stage, 'ready.json'),
    JSON.stringify({ hostname: 'localhost' }),
    { mode: 0o600 },
  );
  await writeFile(join(root, 'private/edge-certificate'), cert, {
    mode: 0o600,
  });
  await prepareLabCertificate(root, 'localhost', () =>
    assert.fail('Do not generate another certificate'),
  );
  assert.deepEqual(
    await readFile(join(root, 'private/edge-certificate')),
    cert,
  );
  assert.deepEqual(await readFile(join(root, 'private/edge-private-key')), key);
  await assert.rejects(readFile(join(stage, 'ready.json')), { code: 'ENOENT' });
});

test('Kubernetes verification binds private credential bytes to explicit cluster references', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'private/existing'), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from('bootstrap-credential-value-must-remain-private');
  await writeFile(join(root, 'private/existing/bootstrap'), bytes, {
    mode: 0o600,
  });
  const reference = {
    provider: 'kubernetes',
    name: 'existing',
    key: 'bootstrap',
  };
  const config = {
    services: {
      edge: { bootstrapSecretRef: reference },
      api: { bootstrapSecretRef: reference },
    },
  };
  const operator = {
    installationRoot: root,
    cluster: { context: 'district' },
    kubernetes: { namespace: 'cc-school' },
  };
  let calls = 0;
  await verifyClusterSecrets(config, operator, async (file, args) => {
    calls++;
    assert.equal(file, 'kubectl');
    assert.deepEqual(args, [
      '--context',
      'district',
      '-n',
      'cc-school',
      'get',
      'secret',
      'existing',
      '-o',
      'json',
    ]);
    return {
      stdout: JSON.stringify({ data: { bootstrap: bytes.toString('base64') } }),
    };
  });
  assert.equal(calls, 1);
  await assert.rejects(
    verifyClusterSecrets(config, operator, async () => ({
      stdout: JSON.stringify({
        data: { bootstrap: Buffer.from('different-secret').toString('base64') },
      }),
    })),
    (error) => {
      assert.match(error.message, /Match every protected credential/);
      assert.ok(!error.message.includes(bytes.toString()));
      assert.ok(!error.message.includes('different-secret'));
      return true;
    },
  );
  await assert.rejects(
    verifyClusterSecrets(config, operator, async () => {
      throw new Error(bytes.toString());
    }),
    (error) => !error.message.includes(bytes.toString()),
  );
});

test('reruns reject public or symbolic setup configuration files', async (t) => {
  const root = await fixture(t);
  const operator = {
    installationRoot: root,
    configurationPath: join(root, 'deployment.json'),
  };
  await writeFile(join(root, 'operator.json'), JSON.stringify(operator), {
    mode: 0o600,
  });
  await writeFile(join(root, 'deployment.json'), '{}', { mode: 0o644 });
  await assert.rejects(
    runSetup(
      { root, releaseRoot, command: 'status' },
      {
        installer: () =>
          assert.fail('Do not execute with public configuration'),
      },
    ),
    /private regular setup file/,
  );
  const { symlink } = await import('node:fs/promises');
  const source = join(root, 'private-source.json');
  await writeFile(source, '{}', { mode: 0o600 });
  await rm(join(root, 'deployment.json'));
  await symlink(source, join(root, 'deployment.json'));
  await assert.rejects(
    runSetup(
      { root, releaseRoot, command: 'status' },
      { installer: () => assert.fail('Do not follow configuration symlinks') },
    ),
    /private regular setup file/,
  );
});

test('CLI rejects public and symbolic answers files before setup', async (t) => {
  const root = await fixture(t);
  const { chmod, symlink } = await import('node:fs/promises');
  const source = join(root, 'answers.json');
  await writeFile(source, '{}');
  await chmod(source, 0o644);
  const invoke = promisify(execFile);
  const rejectsBeforeSetup = async (path) => {
    await assert.rejects(
      invoke(process.execPath, [
        join(releaseRoot, 'deployment/installer/setup.mjs'),
        '--release-root',
        releaseRoot,
        '--root',
        join(root, 'installation'),
        '--answers',
        path,
      ]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /private regular setup file/);
        return true;
      },
    );
    await assert.rejects(stat(join(root, 'installation')), { code: 'ENOENT' });
  };
  await rejectsBeforeSetup(source);
  await chmod(source, 0o600);
  const symbolic = join(root, 'linked-answers.json');
  await symlink(source, symbolic);
  await rejectsBeforeSetup(symbolic);
});
