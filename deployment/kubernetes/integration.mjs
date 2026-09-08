import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderKubernetes } from './render.mjs';

// This adapter targets only the explicitly named disposable Kind cluster.
const kubeconfig = '/tmp/cc-kube-workload-kubeconfig';
const namespace = 'cc-kube-synthetic';
const kube = (args, input) =>
  execFileSync(
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      '--context',
      'kind-cc-workload-validation',
      ...args,
    ],
    {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
    },
  ).trim();
const nodes = JSON.parse(kube(['get', 'nodes', '-o', 'json']));
if (
  nodes.items.length !== 3 ||
  nodes.items.some(
    (node) => !node.metadata.name.startsWith('cc-workload-validation-'),
  )
)
  throw new Error('Use the dedicated three-node Kind fixture.');
if (kube(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name']))
  throw new Error(
    'The synthetic namespace already exists. Preserve its credentials and use a fresh fixture.',
  );
const root = await mkdtemp(join(tmpdir(), 'cc-kube-runtime-'));
await writeFile('/tmp/cc-kube-runtime-current', root, { mode: 0o600 });
const raw = JSON.parse(
  await readFile(
    new URL('../examples/kubernetes.json', import.meta.url),
    'utf8',
  ),
);
const config = JSON.parse(
  JSON.stringify(raw).replaceAll(
    '.campus-commander.svc.cluster.local',
    `.${namespace}.svc.cluster.local`,
  ),
);
config.services.api.placement.replicas = 2;
config.services.edge.endpoint.tls = structuredClone(
  config.services.frontend.endpoint.tls,
);
config.images = {
  frontend:
    'localhost:15000/campus-commander/frontend@sha256:b04173623f38f71f11fcab57d9fb7e98ef19ecca4bb9d593741e423c74b3cbf2',
  api: 'localhost:15000/campus-commander/api@sha256:84486fed9aca5654dc3f951c619f24186626f1f4a5f5f43f7c7d04078187ddcb',
  workers:
    'localhost:15000/campus-commander/worker@sha256:ff996977c7e017c853baabcadc329614f51ea306d1480eecdf406f042429df39',
};
const operator = JSON.parse(
  await readFile(new URL('./operator.example.json', import.meta.url), 'utf8'),
);
operator.namespace = namespace;
operator.storageClasses = {
  postgres: 'standard',
  artifacts: 'cc-synthetic-rwx',
  kestraInternal: 'cc-synthetic-rwx',
};
operator.edgeIngress.sourceRanges = ['127.0.0.1/32'];
operator.release = {
  schemaVersion: 1,
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  architectures: ['linux/amd64'],
  images: config.images,
};

for (const node of nodes.items) {
  execFileSync('docker', [
    'exec',
    node.metadata.name,
    'mkdir',
    '-p',
    '/etc/containerd/certs.d/localhost:15000',
  ]);
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      node.metadata.name,
      'cp',
      '/dev/stdin',
      '/etc/containerd/certs.d/localhost:15000/hosts.toml',
    ],
    {
      input: '[host."http://cc13-registry:5000"]\n',
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );
}
const network = JSON.parse(
  execFileSync(
    'docker',
    [
      'inspect',
      '--format',
      '{{json .NetworkSettings.Networks}}',
      'cc13-registry',
    ],
    { encoding: 'utf8' },
  ),
);
if (!network.kind)
  execFileSync('docker', ['network', 'connect', 'kind', 'cc13-registry']);

const openssl = (...args) =>
  execFileSync('openssl', args, { cwd: root, stdio: 'ignore' });
openssl(
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  'ca.key',
  '-out',
  'ca.pem',
  '-days',
  '2',
  '-subj',
  '/CN=Disposable Kubernetes qualification CA',
);
const ca = await readFile(join(root, 'ca.pem'));
const secrets = new Map();
const id = (ref) => `${ref.name}/${ref.key}`;
const put = (ref, bytes) => secrets.set(id(ref), Buffer.from(bytes));
const pathFor = async (ref) => {
  const path = join(root, ref.name, ref.key);
  await mkdir(join(root, ref.name), { recursive: true, mode: 0o700 });
  await writeFile(path, secrets.get(id(ref)), { mode: 0o600 });
  return path;
};
for (const [name, service] of Object.entries(config.services)) {
  if (service.endpoint.tls.caSecretRef)
    put(service.endpoint.tls.caSecretRef, ca);
  if (service.passwordSecretRef)
    put(service.passwordSecretRef, randomBytes(32).toString('hex'));
  if (service.authSecretRef)
    put(
      service.authSecretRef,
      JSON.stringify({
        username: 'qualification@example.invalid',
        password: `A1${randomBytes(32).toString('base64url')}`,
      }),
    );
  if (service.bootstrapSecretRef)
    put(service.bootstrapSecretRef, randomBytes(32).toString('base64url'));
  if (service.dispatchSecretRef)
    put(service.dispatchSecretRef, randomBytes(32).toString('base64url'));
  if (!service.serverTls) continue;
  const host = new URL(service.endpoint.url).hostname;
  openssl(
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    `${name}.key`,
    '-out',
    `${name}.csr`,
    '-subj',
    `/CN=${host}`,
  );
  await writeFile(
    join(root, `${name}.ext`),
    `subjectAltName=DNS:${host}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n`,
  );
  openssl(
    'x509',
    '-req',
    '-in',
    `${name}.csr`,
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    `${name}.pem`,
    '-days',
    '2',
    '-extfile',
    `${name}.ext`,
  );
  put(
    service.serverTls.certificateSecretRef,
    await readFile(join(root, `${name}.pem`)),
  );
  put(
    service.serverTls.privateKeySecretRef,
    await readFile(join(root, `${name}.key`)),
  );
}
put(operator.migrationPasswordSecretRef, randomBytes(32).toString('hex'));
for (const ref of Object.values(operator.databaseAdmins))
  put(ref, randomBytes(32).toString('hex'));
const kestra = config.services.kestra;
const database = config.services.kestraDatabase;
const runtime = join(root, 'kestra-runtime');
execFileSync('node', ['deployment/kestra/render-config.mjs'], {
  stdio: ['ignore', 'ignore', 'pipe'],
  env: {
    ...process.env,
    CC_KESTRA_PROFILE: 'kubernetes',
    CC_KESTRA_RUNTIME_DIR: runtime,
    CC_KESTRA_RUNTIME_MOUNT_PATH: '/run/kestra-runtime',
    CC_KESTRA_AUTH_FILE: await pathFor(kestra.authSecretRef),
    CC_KESTRA_DATABASE_PASSWORD_FILE: await pathFor(database.passwordSecretRef),
    CC_KESTRA_DATABASE_URL: `jdbc:${database.endpoint.url}/${database.database}?sslmode=verify-full&sslrootcert=/run/secrets/${database.endpoint.tls.caSecretRef.name}/${database.endpoint.tls.caSecretRef.key}`,
    CC_KESTRA_DATABASE_USERNAME: database.role,
    CC_KESTRA_URL: kestra.endpoint.url,
    CC_KESTRA_STORAGE_PATH: kestra.internalStorage.location,
    CC_KESTRA_TLS_ENABLED: 'true',
    CC_KESTRA_TLS_CERTIFICATE_FILE: await pathFor(
      kestra.serverTls.certificateSecretRef,
    ),
    CC_KESTRA_TLS_PRIVATE_KEY_FILE: await pathFor(
      kestra.serverTls.privateKeySecretRef,
    ),
    CC_KESTRA_WORKER_BASE_URL: config.services.workers.endpoint.url,
    CC_KESTRA_WORKER_DISPATCH_SECRET_FILE: await pathFor(
      config.services.workers.dispatchSecretRef,
    ),
    CC_KESTRA_WORKER_CA_FILE: join(root, 'ca.pem'),
  },
});
const environment = JSON.parse(
  await readFile(join(runtime, 'runtime-environment.json'), 'utf8'),
);
const runtimeKeys = {
  'application-yaml': await readFile(join(runtime, 'application.yaml')),
  'server-p12': await readFile(join(runtime, 'server.p12')),
  'probe-header': await readFile(join(runtime, 'probe-header')),
  'worker-truststore-p12': await readFile(
    join(runtime, 'worker-truststore.p12'),
  ),
  'java-options': Buffer.from(environment.JAVA_OPTS),
  'dispatch-token': Buffer.from(environment.SECRET_CC_WORKER_DISPATCH_TOKEN),
};
for (const [key, bytes] of Object.entries(runtimeKeys))
  put({ name: operator.kestraRuntime.name, key }, bytes);
const grouped = new Map();
for (const [reference, bytes] of secrets) {
  const [name, key] = reference.split('/');
  if (!grouped.has(name)) grouped.set(name, {});
  grouped.get(name)[key] = bytes.toString('base64');
}
const list = renderKubernetes(config, operator);
await writeFile(join(root, 'config.json'), JSON.stringify(config, null, 2), {
  mode: 0o600,
});
await writeFile(
  join(root, 'operator.json'),
  JSON.stringify(operator, null, 2),
  { mode: 0o600 },
);
await writeFile(join(root, 'resources.json'), JSON.stringify(list, null, 2), {
  mode: 0o600,
});
kube(
  ['apply', '-f', '-'],
  JSON.stringify(list.items.find((item) => item.kind === 'Namespace')),
);
for (const [name, data] of grouped)
  kube(
    ['apply', '-f', '-'],
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, namespace },
      type: 'Opaque',
      data,
    }),
  );
kube(
  ['apply', '-f', '-'],
  JSON.stringify({
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: { name: 'cc-synthetic-rwx' },
    provisioner: 'kubernetes.io/no-provisioner',
    volumeBindingMode: 'Immediate',
  }),
);
for (const [claim, subPath] of [
  ['campus-artifacts', 'artifacts'],
  ['kestra-internal', 'kestra'],
]) {
  await mkdir(`/tmp/cc-kube-synthetic-shared/${claim}/${subPath}`, {
    recursive: true,
    mode: 0o700,
  });
  kube(
    ['apply', '-f', '-'],
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: { name: `cc-synthetic-${claim}` },
      spec: {
        capacity: { storage: '100Gi' },
        accessModes: ['ReadWriteMany'],
        persistentVolumeReclaimPolicy: 'Retain',
        storageClassName: 'cc-synthetic-rwx',
        claimRef: { namespace, name: claim },
        hostPath: {
          path: `/var/local/cc-synthetic-shared/${claim}`,
          type: 'Directory',
        },
      },
    }),
  );
}
kube(['apply', '-f', join(root, 'resources.json')]);
process.stdout.write(
  `Synthetic Kubernetes resources applied. Private fixture directory: ${root}\n`,
);
