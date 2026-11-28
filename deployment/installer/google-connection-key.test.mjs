import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadCredentialCipher } from '../../libs/google-connection/src/lib/credential.ts';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';
import { renderAllDocker } from '../profiles/all-docker/render.mjs';
import { prepareAllDocker } from '../profiles/all-docker/prepare.mjs';
import { renderKubernetes } from '../kubernetes/render.mjs';
import { prepareSecrets } from './secrets.mjs';
import { configure, createQuestions, runSetup } from './setup.mjs';

const releaseRoot = resolve(import.meta.dirname, '../..');
const images = Object.fromEntries(
  ['frontend', 'api', 'workers'].map((name, index) => [
    name,
    `ghcr.io/campuscommander/${name}@sha256:${String(index + 2).repeat(64)}`,
  ]),
);
const manifest = (phase) => ({
  schemaVersion: 1,
  phase,
  images,
  sourceRevision: 'a'.repeat(40),
  architectures: ['linux/amd64'],
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cc-google-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function releaseFixture(t, phase) {
  const base = await fixture(t);
  const release = join(base, 'release');
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
  await mkdir(join(release, 'deployment/kubernetes'), { recursive: true });
  await cp(
    join(releaseRoot, 'deployment/kubernetes/operator.example.json'),
    join(release, 'deployment/kubernetes/operator.example.json'),
  );
  await writeFile(
    join(release, 'release-manifest.json'),
    JSON.stringify(manifest(phase)),
  );
  const protectedRoot = join(base, 'protected');
  await mkdir(protectedRoot, { mode: 0o700 });
  return { base, release, protectedRoot };
}

async function protectedSource(
  root,
  key,
  bytes = Buffer.from(`${key}-example`),
) {
  const path = join(root, key.replaceAll('.', '_'));
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}

const labRun = async (file, args) => {
  assert.equal(file, 'openssl');
  await writeFile(args[args.indexOf('-out') + 1], 'certificate');
  await writeFile(args[args.indexOf('-keyout') + 1], 'private-key');
};

const allDockerAnswers = (phase, oidcClient, root) => ({
  phase,
  profile: 'all-docker',
  root,
  candidateAcknowledgement: 'candidate-lab',
  labCertificate: 'yes',
  'applicationAuth.provider': 'oidc',
  'applicationAuth.issuer': 'https://accounts.example.org',
  'applicationAuth.clientId': 'campus-client',
  'files.oidc-client': oidcClient,
});

test('all-docker Phase 3 setup provisions, preserves, and renders the Google key', async (t) => {
  const { base, release } = await releaseFixture(t, 3);
  const root = join(base, 'installation');
  const oidcClient = await protectedSource(base, 'oidc-client');
  await runSetup(
    { releaseRoot: release, root, profile: 'all-docker', qualification: true },
    {
      answers: allDockerAnswers(3, oidcClient, root),
      run: labRun,
      installer: async ({ command }) => {
        assert.equal(command, 'install');
        return { status: 'ready' };
      },
      enroll: async () => undefined,
      output: () => undefined,
    },
  );
  const config = JSON.parse(
    await readFile(join(root, 'deployment.json'), 'utf8'),
  );
  assert.deepEqual(config.googleConnection, {
    keyId: 'google-key-1',
    encryptionKeySecretRef: {
      provider: 'file',
      path: '/run/secrets/google-key-1',
    },
  });
  const parsed = parseDeploymentConfig(config);
  const privateRoot = join(root, 'private');
  const first = await prepareAllDocker(join(root, 'deployment.json'), root);
  assert.equal(
    first.find((item) => item.reference === 'google-key-1').status,
    'created',
  );
  const keyPath = join(privateRoot, 'google-key-1');
  const bytes = await readFile(keyPath);
  assert.equal(bytes.length, 32);
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  const second = await prepareAllDocker(join(root, 'deployment.json'), root);
  assert.equal(
    second.find((item) => item.reference === 'google-key-1').status,
    'preserved',
  );
  assert.ok(
    (await readFile(keyPath)).equals(bytes),
    'Preparation must keep the existing Google connection key bytes.',
  );
  assert.ok(
    loadCredentialCipher(parsed.googleConnection, () => Buffer.from(bytes)),
  );

  const compose = renderAllDocker(parsed, manifest(3));
  const initializer = compose.services['volume-permissions'].command.join('\n');
  assert.deepEqual(
    [
      ...initializer.matchAll(
        /cp '\/run\/secrets\/google-key-1' '\/staged\/([^/']+)\/google-key-1'/g,
      ),
    ]
      .map((match) => match[1])
      .sort(),
    ['api-secrets', 'workers-secrets'],
  );
  for (const name of ['api', 'workers'])
    assert.ok(
      compose.services[name].volumes.includes(
        `${name}-secrets:/run/secrets:ro`,
      ),
    );
  for (const [name, service] of Object.entries(compose.services)) {
    if (['api', 'workers'].includes(name)) continue;
    assert.ok(
      !(service.volumes ?? []).some(
        (volume) =>
          typeof volume === 'string' &&
          /^(api|workers)-secrets:\/run\/secrets:ro$/.test(volume),
      ),
    );
  }
  assert.ok(compose.services.workers.networks.includes('google-egress'));
  assert.ok(compose.networks['google-egress']);
});

test('Phase 2 setup writes no Google connection configuration', async (t) => {
  const { base, release } = await releaseFixture(t, 2);
  const root = join(base, 'installation');
  const oidcClient = await protectedSource(base, 'oidc-client');
  await runSetup(
    { releaseRoot: release, root, profile: 'all-docker', qualification: true },
    {
      answers: allDockerAnswers(2, oidcClient, root),
      run: labRun,
      installer: async () => ({ status: 'ready' }),
      enroll: async () => undefined,
      output: () => undefined,
    },
  );
  const config = JSON.parse(
    await readFile(join(root, 'deployment.json'), 'utf8'),
  );
  assert.equal(config.phase, 2);
  assert.equal(Object.hasOwn(config, 'googleConnection'), false);
  parseDeploymentConfig(config);
});

test('hybrid Phase 3 setup lists the Google key file for every worker host', async (t) => {
  const { base, release, protectedRoot } = await releaseFixture(t, 3);
  const root = join(base, 'installation');
  const answers = {
    phase: 3,
    candidateAcknowledgement: 'candidate-lab',
    publicUrl: 'https://campus.district.edu',
    'workerBindAddresses.0': '192.0.2.10',
    'workerBindAddresses.1': '192.0.2.11',
    'services.frontend.url': 'https://frontend.district.edu:8443',
    'services.api.url': 'https://api.district.edu:8443',
    'services.workers.url': 'https://workers.district.edu:8443',
    'services.applicationDatabase.url':
      'postgresql://database.district.edu:5432',
    'services.applicationDatabase.operator': 'district-platform',
    'services.applicationDatabase.persistence.location': '/srv/shared/app-db',
    'services.kestraDatabase.url': 'postgresql://database.district.edu:5432',
    'services.kestraDatabase.operator': 'district-platform',
    'services.kestraDatabase.persistence.location': '/srv/shared/kestra-db',
    'services.redis.url': 'rediss://redis.district.edu:6379',
    'services.redis.operator': 'district-platform',
    'services.redis.persistence.location': '/srv/shared/redis',
    'services.kestra.url': 'https://kestra.district.edu:8443',
    'services.kestra.internalStorage.location': '/srv/shared/kestra',
    'artifacts.location': '/srv/shared/artifacts',
    'applicationAuth.provider': 'oidc',
    'applicationAuth.issuer': 'https://accounts.example.org',
    'applicationAuth.clientId': 'campus-client',
  };
  for (const key of [
    'files.district-ca',
    'files.frontend-certificate',
    'files.frontend-private-key',
    'files.api-certificate',
    'files.api-private-key',
    'files.workers-certificate',
    'files.workers-private-key',
    'files.campus-database-password',
    'files.kestra-database-password',
    'files.redis-password',
    'files.kestra-certificate',
    'files.kestra-private-key',
    'files.edge-certificate',
    'files.edge-private-key',
    'files.oidc-client',
    'files.postgres-migrator',
  ])
    answers[key] = await protectedSource(protectedRoot, key);
  const lines = [];
  const result = await runSetup(
    { releaseRoot: release, root, profile: 'hybrid', qualification: true },
    {
      answers,
      installer: async ({ command }) => ({
        status: command === 'prepare' ? 'prepared' : 'ready',
      }),
      output: (line) => lines.push(line),
    },
  );
  assert.equal(result.status, 'prepared-workers-pending');
  const config = JSON.parse(
    await readFile(join(root, 'deployment.json'), 'utf8'),
  );
  assert.deepEqual(config.googleConnection, {
    keyId: 'google-key-1',
    encryptionKeySecretRef: {
      provider: 'file',
      path: '/run/secrets/google-key-1',
    },
  });
  assert.ok(lines.includes(join(root, 'private/google-key-1')));
});

const kubernetesFiles = [
  'files.campus-installation.district-ca',
  'files.campus-installation.frontend-certificate',
  'files.campus-installation.frontend-private-key',
  'files.campus-installation.bootstrap',
  'files.campus-installation.api-certificate',
  'files.campus-installation.api-private-key',
  'files.campus-installation.worker-dispatch',
  'files.campus-installation.workers-certificate',
  'files.campus-installation.workers-private-key',
  'files.campus-installation.campus-database-password',
  'files.campus-installation.application-postgres-certificate',
  'files.campus-installation.application-postgres-private-key',
  'files.campus-installation.kestra-database-password',
  'files.campus-installation.kestra-postgres-certificate',
  'files.campus-installation.kestra-postgres-private-key',
  'files.campus-installation.redis-password',
  'files.campus-installation.redis-certificate',
  'files.campus-installation.redis-private-key',
  'files.campus-installation.kestra-auth',
  'files.campus-installation.kestra-certificate',
  'files.campus-installation.kestra-private-key',
  'files.campus-installation.edge-certificate',
  'files.campus-installation.edge-private-key',
  'files.campus-oidc.client-secret',
  'files.campus-installation.google-key-1',
];

async function kubernetesAnswers(protectedRoot) {
  const answers = {
    phase: 3,
    publicUrl: 'https://campus.district.edu',
    'cluster.context': 'district-cluster',
    'kubernetes.storageClasses.postgres': 'district-rwo',
    'kubernetes.storageClasses.artifacts': 'district-rwx',
    'kubernetes.storageClasses.kestraInternal': 'district-rwx',
    'kubernetes.sourceRanges': '192.0.2.0/24',
    'kubernetes.externalEgress.identityProvider': '203.0.113.0/24',
    'kubernetes.externalEgress.googleProvider': '192.0.2.0/24, 198.51.100.0/24',
    'services.applicationDatabase.persistence.location': '/srv/shared/app-db',
    'services.kestraDatabase.persistence.location': '/srv/shared/kestra-db',
    'services.redis.persistence.location': '/srv/shared/redis',
    'services.kestra.internalStorage.location': '/srv/shared/kestra',
    'artifacts.location': '/srv/shared/artifacts',
    'applicationAuth.provider': 'oidc',
    'applicationAuth.issuer': 'https://accounts.example.org',
    'applicationAuth.clientId': 'campus-client',
  };
  for (const key of kubernetesFiles)
    answers[key] = await protectedSource(
      protectedRoot,
      key,
      key === 'files.campus-installation.google-key-1'
        ? Buffer.alloc(32, 7)
        : undefined,
    );
  return answers;
}

function googleEgressPolicy(list, name) {
  const policy = list.items.find((item) => item.metadata.name === name);
  assert.ok(policy, `${name} must exist`);
  return policy.spec.egress.find((rule) =>
    rule.to?.some((entry) => entry.ipBlock?.cidr === '198.51.100.0/24'),
  );
}

test('Kubernetes Phase 3 setup asks for the Google Secret and renders provider egress', async (t) => {
  const { base, release, protectedRoot } = await releaseFixture(t, 3);
  const answers = await kubernetesAnswers(protectedRoot);
  const questions = createQuestions(answers);
  const plan = await configure({
    releaseRoot: release,
    root: join(base, 'installation'),
    profile: 'kubernetes',
    questions,
    manifest: manifest(3),
  });
  questions.finish();
  const parsed = parseDeploymentConfig(plan.config);
  assert.deepEqual(parsed.googleConnection, {
    keyId: 'google-key-1',
    encryptionKeySecretRef: {
      provider: 'kubernetes',
      name: 'campus-installation',
      key: 'google-key-1',
    },
  });
  assert.deepEqual(plan.operator.kubernetes.externalEgress.googleProvider, [
    '192.0.2.0/24',
    '198.51.100.0/24',
  ]);
  assert.equal(
    plan.files.get(
      join(base, 'installation/private/campus-installation/google-key-1'),
    ),
    answers['files.campus-installation.google-key-1'],
  );
  const list = renderKubernetes(parsed, {
    ...plan.operator.kubernetes,
    release: manifest(3),
  });
  for (const name of ['api-egress', 'workers-egress']) {
    assert.deepEqual(googleEgressPolicy(list, name), {
      to: [
        { ipBlock: { cidr: '192.0.2.0/24' } },
        { ipBlock: { cidr: '198.51.100.0/24' } },
      ],
      ports: [{ protocol: 'TCP', port: 443 }],
    });
  }
});

test('Kubernetes Phase 3 setup walks a custom Google Secret reference', async (t) => {
  const { base, release, protectedRoot } = await releaseFixture(t, 3);
  const answers = await kubernetesAnswers(protectedRoot);
  delete answers['files.campus-installation.google-key-1'];
  const custom = await protectedSource(
    protectedRoot,
    'files.district-google.primary-key',
    Buffer.alloc(32, 9),
  );
  Object.assign(answers, {
    'googleConnection.encryptionKeySecretRef.name': 'district-google',
    'googleConnection.encryptionKeySecretRef.key': 'primary-key',
    'files.district-google.primary-key': custom,
  });
  const questions = createQuestions(answers);
  const plan = await configure({
    releaseRoot: release,
    root: join(base, 'installation'),
    profile: 'kubernetes',
    questions,
    manifest: manifest(3),
  });
  questions.finish();
  assert.deepEqual(plan.config.googleConnection, {
    keyId: 'google-key-1',
    encryptionKeySecretRef: {
      provider: 'kubernetes',
      name: 'district-google',
      key: 'primary-key',
    },
  });
  assert.equal(
    plan.files.get(
      join(base, 'installation/private/district-google/primary-key'),
    ),
    custom,
  );
});

test('Kubernetes Phase 3 setup refuses a non-CIDR Google egress answer', async (t) => {
  const { base, release, protectedRoot } = await releaseFixture(t, 3);
  const answers = await kubernetesAnswers(protectedRoot);
  answers['kubernetes.externalEgress.googleProvider'] = 'google.example.org';
  const questions = createQuestions(answers);
  await assert.rejects(
    configure({
      releaseRoot: release,
      root: join(base, 'installation'),
      profile: 'kubernetes',
      questions,
      manifest: manifest(3),
    }),
    /kubernetes\.externalEgress\.googleProvider/,
  );
});

async function phase3Config(t) {
  const base = await fixture(t);
  const answers = {
    phase: 3,
    labCertificate: 'yes',
    'applicationAuth.provider': 'oidc',
    'applicationAuth.issuer': 'https://accounts.example.org',
    'applicationAuth.clientId': 'campus-client',
    'files.oidc-client': '/protected/oidc-client',
  };
  const questions = createQuestions(answers);
  const plan = await configure({
    releaseRoot,
    root: join(base, 'installation'),
    profile: 'all-docker',
    qualification: true,
    questions,
    manifest: manifest(3),
  });
  questions.finish();
  return { base, config: plan.config };
}

test('preparation refuses an existing Google key of another size without printing it', async (t) => {
  const { base, config } = await phase3Config(t);
  const privateRoot = join(base, 'private');
  await mkdir(privateRoot, { mode: 0o700 });
  const material = Buffer.alloc(31, 65);
  await writeFile(join(privateRoot, 'google-key-1'), material, { mode: 0o600 });
  await assert.rejects(prepareSecrets(config, privateRoot), (error) => {
    assert.equal(
      error.message,
      'The Google connection encryption key must contain exactly 32 raw bytes.',
    );
    assert.ok(!error.message.includes(material.toString()));
    return true;
  });
});

test('Kubernetes preparation verifies the projected Google key against its Secret', async (t) => {
  const { base, release, protectedRoot } = await releaseFixture(t, 3);
  const root = join(base, 'installation');
  const answers = await kubernetesAnswers(protectedRoot);
  answers.candidateAcknowledgement = 'candidate-lab';
  const verified = [];
  await runSetup(
    { releaseRoot: release, root, profile: 'kubernetes', qualification: true },
    {
      answers,
      run: async (file, args) => {
        assert.equal(file, 'kubectl');
        const name = args[args.indexOf('secret') + 1];
        const directory = join(root, 'private', name);
        const data = {};
        for (const key of await readdir(directory))
          data[key] = (await readFile(join(directory, key))).toString('base64');
        verified.push({ name, keys: Object.keys(data) });
        return { stdout: JSON.stringify({ data }) };
      },
      installer: async () => ({ status: 'ready' }),
      enroll: async () => undefined,
      output: () => undefined,
    },
  );
  assert.ok(
    verified.some(
      (secret) =>
        secret.name === 'campus-installation' &&
        secret.keys.includes('google-key-1'),
    ),
  );
  const config = JSON.parse(
    await readFile(join(root, 'deployment.json'), 'utf8'),
  );
  assert.deepEqual(config.googleConnection, {
    keyId: 'google-key-1',
    encryptionKeySecretRef: {
      provider: 'kubernetes',
      name: 'campus-installation',
      key: 'google-key-1',
    },
  });
  assert.equal(
    (await readFile(join(root, 'private/campus-installation/google-key-1')))
      .length,
    32,
  );
});
