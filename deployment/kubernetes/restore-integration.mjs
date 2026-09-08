import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import pg from 'pg';
import {
  backupFoundation,
  postgresToolArguments,
  restoreFoundation,
} from '../operations/index.mjs';
import { replaceBootstrap } from '../bootstrap/access.mjs';
import { connectionOptions } from '../postgres/index.mjs';
import { renderKubernetes } from './render.mjs';

const kubeconfig = '/tmp/cc-kube-workload-kubeconfig';
const context = 'kind-cc-workload-validation';
const sourceNamespace = 'cc-kube-synthetic';
const targetNamespace = 'cc-kube-restore-synthetic';
const sharedRoot = '/tmp/cc-kube-synthetic-shared';
const targetDirectory = join(sharedRoot, 'restore-qualification');
const artifactEvidencePath = `/tmp/cc-kubernetes-restore-artifact-${process.pid}.json`;
let nextForwardPort = 25000 + (process.pid % 1000) * 10;
const command = (args, input) =>
  execFileSync(
    'kubectl',
    ['--kubeconfig', kubeconfig, '--context', context, ...args],
    {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 900000,
    },
  ).trim();
const kube = (namespace, args, input) =>
  command(['--namespace', namespace, ...args], input);
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const json = (namespace, args) => JSON.parse(kube(namespace, args));
const apply = (value) => command(['apply', '-f', '-'], JSON.stringify(value));
const secretBytes = (namespace, name, key) => {
  const secret = json(namespace, ['get', 'secret', name, '-o', 'json']);
  return Buffer.from(secret.data[key], 'base64');
};

async function waitFor(check, label, attempts = 180) {
  let result;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await Promise.resolve()
      .then(check)
      .catch(() => undefined);
    if (result) return result;
    await sleep(1000);
  }
  throw new Error(`${label} did not become ready.`);
}

function portForward(namespace, service, remotePort) {
  const localPort = nextForwardPort;
  nextForwardPort += 1;
  const child = spawn(
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      '--context',
      context,
      '--namespace',
      namespace,
      'port-forward',
      `service/${service}`,
      `${localPort}:${remotePort}`,
      '--address',
      '127.0.0.1',
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    setTimeout(
      () =>
        child.exitCode === null
          ? resolve(localPort)
          : reject(
              new Error(`Port forward stopped with status ${child.exitCode}.`),
            ),
      750,
    );
  });
  return {
    child,
    ready,
    close() {
      child.kill('SIGTERM');
    },
  };
}

function assertForwardAlive(forward, label) {
  assert.equal(
    forward.child.exitCode,
    null,
    `${label} stopped before the operations connection started.`,
  );
}

async function request({
  port,
  servername,
  ca,
  path,
  method = 'GET',
  authorization,
  contentType,
  body,
}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : undefined;
    const request = https.request(
      {
        hostname: '127.0.0.1',
        port,
        servername,
        path,
        method,
        ca,
        rejectUnauthorized: true,
        headers: {
          host: servername,
          ...(authorization ? { authorization } : {}),
          ...(contentType ? { 'content-type': contentType } : {}),
          ...(payload ? { 'content-length': payload.length } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.setTimeout(5000, () => request.destroy());
    request.on('error', reject);
    request.end(payload);
  });
}

function multipart(fields) {
  const boundary = `cc-${randomBytes(12).toString('hex')}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  }
  parts.push(`--${boundary}--\r\n`);
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: parts.join(''),
  };
}

function fileMultipart(name, filename, bytes) {
  const boundary = `cc-${randomBytes(12).toString('hex')}`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function workloadInventory(namespace) {
  return json(namespace, ['get', 'deployments', '-o', 'json'])
    .items.map(({ metadata, spec, status }) => ({
      name: metadata.name,
      desired: spec.replicas,
      ready: status.readyReplicas ?? 0,
      image: spec.template.spec.containers[0].image,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function protectedStartup(namespace, root, attempts = 180) {
  const forward = portForward(namespace, 'edge', 443);
  try {
    const port = await forward.ready;
    const credential = secretBytes(
      namespace,
      'campus-installation',
      'bootstrap',
    )
      .toString('utf8')
      .trim();
    const ca = await readFile(join(root, 'ca.pem'));
    return await waitFor(
      async () => {
        const response = await request({
          port,
          servername: 'campus.example.org',
          ca,
          path: '/api/startup',
          authorization: `Basic ${Buffer.from(`operator:${credential}`).toString('base64')}`,
        });
        if (response.status !== 200) return undefined;
        const report = JSON.parse(response.body.toString('utf8'));
        return report.status === 'ready' && report.checks?.length === 8
          ? report
          : undefined;
      },
      'Protected startup',
      attempts,
    );
  } finally {
    forward.close();
  }
}

function execWorker(pod, mode, descriptor) {
  if (mode === 'write')
    return JSON.parse(
      kube(sourceNamespace, [
        'exec',
        pod,
        '--',
        'node',
        '/app/deployment/storage/cross-host.mjs',
        'write',
        '/config/deployment.json',
        artifactEvidencePath,
      ]),
    );
  return JSON.parse(
    kube(
      mode === 'target' ? targetNamespace : sourceNamespace,
      [
        'exec',
        '-i',
        pod,
        '--',
        'sh',
        '-ec',
        `cat > ${artifactEvidencePath} && node /app/deployment/storage/cross-host.mjs read /config/deployment.json ${artifactEvidencePath}`,
      ],
      `${JSON.stringify(descriptor)}\n`,
    ),
  );
}

async function seedKestra(root) {
  const forward = portForward(sourceNamespace, 'kestra', 8080);
  try {
    const port = await forward.ready;
    const ca = await readFile(join(root, 'ca.pem'));
    const auth = JSON.parse(
      await readFile(join(root, 'campus-installation', 'kestra-auth'), 'utf8'),
    );
    const authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
    const flow = await readFile(
      new URL('../kestra/cc11-external-worker.yaml', import.meta.url),
    );
    const uploaded = await request({
      port,
      servername: `kestra.${sourceNamespace}.svc.cluster.local`,
      ca,
      path: '/api/v1/main/flows',
      method: 'POST',
      authorization,
      contentType: 'application/x-yaml',
      body: flow,
    });
    assert.ok([200, 422].includes(uploaded.status));
    const directory = await request({
      port,
      servername: `kestra.${sourceNamespace}.svc.cluster.local`,
      ca,
      path: '/api/v1/main/namespaces/campus.validation/files/directory?path=/',
      method: 'POST',
      authorization,
    });
    assert.ok([200, 201, 204].includes(directory.status));
    const marker = randomBytes(256);
    const uploadedMarker = await request({
      port,
      servername: `kestra.${sourceNamespace}.svc.cluster.local`,
      ca,
      path: '/api/v1/main/namespaces/campus.validation/files?path=/cc17-kubernetes-marker.bin',
      method: 'POST',
      authorization,
      ...fileMultipart('fileContent', 'cc17-kubernetes-marker.bin', marker),
    });
    assert.ok([200, 201, 204].includes(uploadedMarker.status));
    const started = await request({
      port,
      servername: `kestra.${sourceNamespace}.svc.cluster.local`,
      ca,
      path: '/api/v1/main/executions/campus.validation/cc11_external_worker',
      method: 'POST',
      authorization,
      ...multipart({
        correlationId: `kubernetes-${randomBytes(8).toString('hex')}`,
        marker: 'kubernetes-restore-marker',
        delayMilliseconds: '0',
      }),
    });
    assert.equal(started.status, 200);
    const executionId = JSON.parse(started.body.toString('utf8')).id;
    const execution = await waitFor(async () => {
      const current = await request({
        port,
        servername: `kestra.${sourceNamespace}.svc.cluster.local`,
        ca,
        path: `/api/v1/main/executions/${executionId}`,
        authorization,
      });
      if (current.status !== 200) return undefined;
      const value = JSON.parse(current.body.toString('utf8'));
      return ['SUCCESS', 'WARNING', 'FAILED', 'KILLED', 'CANCELLED'].includes(
        value.state.current,
      )
        ? value
        : undefined;
    }, 'Kestra execution');
    assert.equal(execution.state.current, 'SUCCESS');
    return {
      flow: 'campus.validation/cc11_external_worker',
      executionId,
      executionState: execution.state.current,
      markerSha256: sha256(marker),
    };
  } finally {
    forward.close();
  }
}

async function verifyTargetKestra(root, expected) {
  const forward = portForward(targetNamespace, 'kestra', 8080);
  try {
    const port = await forward.ready;
    const ca = await readFile(join(root, 'ca.pem'));
    const auth = JSON.parse(
      await readFile(join(root, 'campus-installation', 'kestra-auth'), 'utf8'),
    );
    const authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
    const flow = await request({
      port,
      servername: `kestra.${targetNamespace}.svc.cluster.local`,
      ca,
      path: '/api/v1/main/flows/campus.validation/cc11_external_worker',
      authorization,
    });
    assert.equal(flow.status, 200);
    const marker = await request({
      port,
      servername: `kestra.${targetNamespace}.svc.cluster.local`,
      ca,
      path: '/api/v1/main/namespaces/campus.validation/files?path=/cc17-kubernetes-marker.bin',
      authorization,
    });
    assert.equal(marker.status, 200);
    assert.equal(sha256(marker.body), expected.markerSha256);
    return {
      flow: `${JSON.parse(flow.body.toString('utf8')).namespace}/cc11_external_worker`,
      markerSha256: sha256(marker.body),
    };
  } finally {
    forward.close();
  }
}

async function kubernetesTool(tool, { service, input, output }) {
  const namespace = service.database.endsWith('-restore')
    ? targetNamespace
    : sourceNamespace;
  const deployment = service.database.startsWith('campus')
    ? 'application-postgres'
    : 'kestra-postgres';
  const child = spawn(
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      '--context',
      context,
      '--namespace',
      namespace,
      'exec',
      '-i',
      `deployment/${deployment}`,
      '--',
      tool,
      '--username',
      service.role,
      ...(tool === 'pg_dump' ? ['--dbname', service.database] : []),
      ...postgresToolArguments(tool, service),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`Kubernetes PostgreSQL ${tool} failed: ${stderr.trim()}`),
          ),
    );
  });
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const tasks = [completed, pipeline(child.stdout, output ?? sink)];
  if (input) tasks.push(pipeline(createReadStream(input), child.stdin));
  else child.stdin.end();
  await Promise.all(tasks);
}

function postgresSql(namespace, deployment, sql) {
  kube(
    namespace,
    [
      'exec',
      '-i',
      `deployment/${deployment}`,
      '--',
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    sql,
  );
}

function redisExists(namespace, key) {
  return Number(
    kube(namespace, [
      'exec',
      'deployment/redis',
      '--',
      'sh',
      '-ec',
      'export REDISCLI_AUTH="$(cat /run/secrets/campus-installation/redis-password)"; exec redis-cli --no-auth-warning --tls --cacert /run/secrets/campus-installation/district-ca --sni "$1" -h 127.0.0.1 -p 6379 EXISTS "$2"',
      'redis-probe',
      `redis.${namespace}.svc.cluster.local`,
      key,
    ]),
  );
}

function setRedis(namespace, key) {
  kube(namespace, [
    'exec',
    'deployment/redis',
    '--',
    'sh',
    '-ec',
    'export REDISCLI_AUTH="$(cat /run/secrets/campus-installation/redis-password)"; exec redis-cli --no-auth-warning --tls --cacert /run/secrets/campus-installation/district-ca --sni "$1" -h 127.0.0.1 -p 6379 SET "$2" source-cache >/dev/null',
    'redis-probe',
    `redis.${namespace}.svc.cluster.local`,
    key,
  ]);
}

function cloneSecrets() {
  const list = json(sourceNamespace, ['get', 'secrets', '-o', 'json']);
  for (const source of list.items) {
    if (source.type === 'kubernetes.io/service-account-token') continue;
    apply({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: source.metadata.name, namespace: targetNamespace },
      type: source.type,
      data: source.data,
    });
  }
}

async function renderTargetKestra(root, config, operator) {
  const runtime = join(root, 'target-kestra-runtime');
  const file = (reference) => join(root, reference.name, reference.key);
  execFileSync('node', ['deployment/kestra/render-config.mjs'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      CC_KESTRA_PROFILE: 'kubernetes',
      CC_KESTRA_RUNTIME_DIR: runtime,
      CC_KESTRA_RUNTIME_MOUNT_PATH: '/run/kestra-runtime',
      CC_KESTRA_AUTH_FILE: file(config.services.kestra.authSecretRef),
      CC_KESTRA_DATABASE_PASSWORD_FILE: file(
        config.services.kestraDatabase.passwordSecretRef,
      ),
      CC_KESTRA_DATABASE_URL: `jdbc:${config.services.kestraDatabase.endpoint.url}/${config.services.kestraDatabase.database}?sslmode=verify-full&sslrootcert=/run/secrets/${config.services.kestraDatabase.endpoint.tls.caSecretRef.name}/${config.services.kestraDatabase.endpoint.tls.caSecretRef.key}`,
      CC_KESTRA_DATABASE_USERNAME: config.services.kestraDatabase.role,
      CC_KESTRA_URL: config.services.kestra.endpoint.url,
      CC_KESTRA_STORAGE_PATH: config.services.kestra.internalStorage.location,
      CC_KESTRA_TLS_ENABLED: 'true',
      CC_KESTRA_TLS_CERTIFICATE_FILE: file(
        config.services.kestra.serverTls.certificateSecretRef,
      ),
      CC_KESTRA_TLS_PRIVATE_KEY_FILE: file(
        config.services.kestra.serverTls.privateKeySecretRef,
      ),
      CC_KESTRA_WORKER_BASE_URL: config.services.workers.endpoint.url,
      CC_KESTRA_WORKER_DISPATCH_SECRET_FILE: file(
        config.services.workers.dispatchSecretRef,
      ),
      CC_KESTRA_WORKER_CA_FILE: join(root, 'ca.pem'),
    },
  });
  const environment = JSON.parse(
    await readFile(join(runtime, 'runtime-environment.json'), 'utf8'),
  );
  const files = {
    'application-yaml': await readFile(join(runtime, 'application.yaml')),
    'server-p12': await readFile(join(runtime, 'server.p12')),
    'probe-header': await readFile(join(runtime, 'probe-header')),
    'worker-truststore-p12': await readFile(
      join(runtime, 'worker-truststore.p12'),
    ),
    'java-options': Buffer.from(environment.JAVA_OPTS),
    'dispatch-token': Buffer.from(environment.SECRET_CC_WORKER_DISPATCH_TOKEN),
  };
  apply({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: operator.kestraRuntime.name, namespace: targetNamespace },
    type: 'Opaque',
    data: Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [
        name,
        bytes.toString('base64'),
      ]),
    ),
  });
}

const startedAt = Date.now();
const runtimeRoot = (
  await readFile('/tmp/cc-kube-runtime-current', 'utf8')
).trim();
const runtimeConfig = JSON.parse(
  await readFile(join(runtimeRoot, 'config.json'), 'utf8'),
);
const sourceOperator = JSON.parse(
  await readFile(join(runtimeRoot, 'operator.json'), 'utf8'),
);
const nodes = json('', ['get', 'nodes', '-o', 'json']);
assert.equal(nodes.items.length, 3);
assert.ok(
  nodes.items.every(({ metadata }) =>
    metadata.name.startsWith('cc-workload-validation-'),
  ),
);
const sourceWorkloads = await waitFor(
  () => {
    const inventory = workloadInventory(sourceNamespace);
    return inventory.length === 8 &&
      inventory.every(({ desired, ready }) => desired === ready)
      ? inventory
      : undefined;
  },
  'Source workloads',
  900,
);
assert.equal(sourceWorkloads.length, 8);
const sourceStartup = await protectedStartup(sourceNamespace, runtimeRoot);

const workersBefore = json(sourceNamespace, [
  'get',
  'pods',
  '-l',
  'app.kubernetes.io/name=workers',
  '-o',
  'json',
]).items;
assert.equal(workersBefore.length, 2);
assert.notEqual(workersBefore[0].spec.nodeName, workersBefore[1].spec.nodeName);
const writer = workersBefore[0];
const reader = workersBefore[1];
const artifact = execWorker(writer.metadata.name, 'write');
const crossNodeRead = execWorker(reader.metadata.name, 'read', artifact);
assert.equal(crossNodeRead.integrity, 'pass');
assert.notEqual(artifact.writerHost, crossNodeRead.readerHost);

const controlPlane = nodes.items.find(({ metadata }) =>
  metadata.name.endsWith('-control-plane'),
).metadata.name;
try {
  command([
    'taint',
    'nodes',
    controlPlane,
    'node-role.kubernetes.io/control-plane:NoSchedule-',
  ]);
} catch {
  // The dedicated fixture can already expose its spare node.
}
command(['cordon', writer.spec.nodeName]);
kube(sourceNamespace, ['delete', 'pod', writer.metadata.name, '--wait=true']);
kube(sourceNamespace, [
  'rollout',
  'status',
  'deployment/workers',
  '--timeout=5m',
]);
command(['uncordon', writer.spec.nodeName]);
const workersAfter = json(sourceNamespace, [
  'get',
  'pods',
  '-l',
  'app.kubernetes.io/name=workers',
  '-o',
  'json',
]).items;
const replacement = workersAfter.find(
  ({ metadata }) =>
    !workersBefore.some((pod) => pod.metadata.uid === metadata.uid),
);
assert.ok(replacement);
assert.notEqual(replacement.spec.nodeName, writer.spec.nodeName);
const rescheduledRead = execWorker(replacement.metadata.name, 'read', artifact);
assert.equal(rescheduledRead.integrity, 'pass');

const kestraFixture = await seedKestra(runtimeRoot);
const redisSentinel = `cc:kubernetes-restore:${randomUUID()}`;
setRedis(sourceNamespace, redisSentinel);
assert.equal(redisExists(sourceNamespace, redisSentinel), 1);

for (const name of ['api', 'workers', 'kestra']) {
  kube(sourceNamespace, ['scale', `deployment/${name}`, '--replicas=0']);
  kube(sourceNamespace, [
    'rollout',
    'status',
    `deployment/${name}`,
    '--timeout=5m',
  ]);
  kube(sourceNamespace, ['rollout', 'pause', `deployment/${name}`]);
}
await waitFor(
  () => {
    const pods = json(sourceNamespace, ['get', 'pods', '-o', 'json']).items;
    return pods.every(
      ({ metadata }) =>
        !['api', 'workers', 'kestra'].includes(
          metadata.labels?.['app.kubernetes.io/name'],
        ),
    );
  },
  'Source writer termination',
  420,
);
const stopped = workloadInventory(sourceNamespace).filter(({ name }) =>
  ['api', 'workers', 'kestra'].includes(name),
);
assert.ok(stopped.every(({ desired, ready }) => desired === 0 && ready === 0));

const sourceApplicationForward = portForward(
  sourceNamespace,
  'application-postgres',
  5432,
);
const sourceKestraForward = portForward(
  sourceNamespace,
  'kestra-postgres',
  5432,
);
const forwards = [sourceApplicationForward, sourceKestraForward];
let targetApplicationForward;
let targetKestraForward;
try {
  const sourceApplicationPort = await sourceApplicationForward.ready;
  const sourceKestraPort = await sourceKestraForward.ready;
  const sourceConfig = structuredClone(runtimeConfig);
  sourceConfig.services.applicationDatabase.endpoint.url = `postgresql://localhost:${sourceApplicationPort}`;
  sourceConfig.services.kestraDatabase.endpoint.url = `postgresql://localhost:${sourceKestraPort}`;
  sourceConfig.artifacts.location = join(
    sharedRoot,
    'campus-artifacts',
    'artifacts',
  );
  sourceConfig.services.kestra.internalStorage.location = join(
    sharedRoot,
    'kestra-internal',
    'kestra',
  );

  const sourceSecrets = json(sourceNamespace, ['get', 'secrets', '-o', 'json']);
  const secretValues = new Map();
  for (const secret of sourceSecrets.items)
    for (const [key, value] of Object.entries(secret.data ?? {}))
      secretValues.set(
        `${secret.metadata.name}/${key}`,
        Buffer.from(value, 'base64'),
      );
  const recoveryReference = {
    provider: 'kubernetes',
    name: 'qualification-recovery',
    key: 'backup-key',
  };
  secretValues.set('qualification-recovery/backup-key', randomBytes(32));
  const resolveSecret = async (reference) => {
    const value = secretValues.get(`${reference.name}/${reference.key}`);
    if (!value) throw new Error('A synthetic secret is absent.');
    return value;
  };
  const version = kube(sourceNamespace, [
    'exec',
    'deployment/application-postgres',
    '--',
    'pg_dump',
    '--version',
  ]);
  assert.match(version, /PostgreSQL\) 18\.6(?:\s|$)/);
  const applicationCredentials = {
    role: sourceOperator.migrationRole,
    passwordSecretRef: sourceOperator.migrationPasswordSecretRef,
  };
  const backupRoot = await mkdtemp(join(tmpdir(), 'cc-kube-backup-'));
  const backupDirectory = join(backupRoot, 'encrypted-backup');
  const keyRecovery = {
    id: 'synthetic-kubernetes-recovery',
    version: 1,
    reference: recoveryReference,
  };
  const quiesce = {
    operator: 'synthetic-kubernetes-qualification',
    stoppedServices: ['api', 'workers', 'kestra'],
    stoppedAt: new Date().toISOString(),
  };
  assertForwardAlive(
    sourceApplicationForward,
    'Source application database port forward',
  );
  assertForwardAlive(
    sourceKestraForward,
    'Source Kestra database port forward',
  );
  const manifest = await backupFoundation({
    config: sourceConfig,
    release: sourceOperator.release,
    backupDirectory,
    sourceRoots: {
      artifacts: sourceConfig.artifacts.location,
      kestraInternal: sourceConfig.services.kestra.internalStorage.location,
    },
    keyRecovery,
    quiesce,
    resolveSecret,
    applicationCredentials,
    runTool: kubernetesTool,
  });

  const targetRuntime = structuredClone(runtimeConfig);
  const sourceSuffix = `.${sourceNamespace}.svc.cluster.local`;
  const targetSuffix = `.${targetNamespace}.svc.cluster.local`;
  for (const service of Object.values(targetRuntime.services)) {
    const endpoint = new URL(service.endpoint.url);
    if (endpoint.hostname.endsWith(sourceSuffix)) {
      endpoint.hostname = endpoint.hostname.replace(sourceSuffix, targetSuffix);
      service.endpoint.url = endpoint.href.replace(/\/$/, '');
    }
  }
  targetRuntime.services.applicationDatabase.database = 'campus-restore';
  targetRuntime.services.kestraDatabase.database = 'kestra-restore';
  const targetOperator = structuredClone(sourceOperator);
  targetOperator.namespace = targetNamespace;
  targetOperator.storageClasses.artifacts = 'cc-synthetic-rwx-restore';
  targetOperator.storageClasses.kestraInternal = 'cc-synthetic-rwx-restore';
  const targetList = renderKubernetes(targetRuntime, targetOperator);
  apply(targetList.items.find((item) => item.kind === 'Namespace'));
  cloneSecrets();
  const initialKinds = new Set(['ServiceAccount', 'ConfigMap']);
  const initial = targetList.items.filter(
    (item) =>
      initialKinds.has(item.kind) ||
      (item.kind === 'PersistentVolumeClaim' &&
        item.metadata.name.endsWith('-postgres-data')) ||
      (item.kind === 'Deployment' &&
        ['application-postgres', 'kestra-postgres'].includes(
          item.metadata.name,
        )) ||
      (item.kind === 'Service' &&
        ['application-postgres', 'kestra-postgres'].includes(
          item.metadata.name,
        )),
  );
  apply({ apiVersion: 'v1', kind: 'List', items: initial });
  for (const name of ['application-postgres', 'kestra-postgres'])
    kube(targetNamespace, [
      'rollout',
      'status',
      `deployment/${name}`,
      '--timeout=10m',
    ]);
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  postgresSql(
    targetNamespace,
    'application-postgres',
    `CREATE ROLE "${targetRuntime.services.applicationDatabase.role}" LOGIN PASSWORD ${quote(String(await resolveSecret(targetRuntime.services.applicationDatabase.passwordSecretRef)))};\nCREATE ROLE "${sourceOperator.migrationRole}" LOGIN PASSWORD ${quote(String(await resolveSecret(sourceOperator.migrationPasswordSecretRef)))};\nCREATE DATABASE "${targetRuntime.services.applicationDatabase.database}" OWNER "${sourceOperator.migrationRole}" ENCODING 'UTF8' TEMPLATE template0;\n`,
  );
  postgresSql(
    targetNamespace,
    'kestra-postgres',
    `CREATE ROLE "${targetRuntime.services.kestraDatabase.role}" LOGIN PASSWORD ${quote(String(await resolveSecret(targetRuntime.services.kestraDatabase.passwordSecretRef)))};\nCREATE DATABASE "${targetRuntime.services.kestraDatabase.database}" OWNER "${targetRuntime.services.kestraDatabase.role}" ENCODING 'UTF8' TEMPLATE template0;\n`,
  );

  targetApplicationForward = portForward(
    targetNamespace,
    'application-postgres',
    5432,
  );
  targetKestraForward = portForward(targetNamespace, 'kestra-postgres', 5432);
  forwards.push(targetApplicationForward, targetKestraForward);
  const targetApplicationPort = await targetApplicationForward.ready;
  const targetKestraPort = await targetKestraForward.ready;
  const targetConfig = structuredClone(targetRuntime);
  targetConfig.services.applicationDatabase.endpoint.url = `postgresql://localhost:${targetApplicationPort}`;
  targetConfig.services.kestraDatabase.endpoint.url = `postgresql://localhost:${targetKestraPort}`;
  targetConfig.artifacts.location = join(targetDirectory, 'artifacts');
  targetConfig.services.kestra.internalStorage.location = join(
    targetDirectory,
    'kestra-internal',
  );
  assertForwardAlive(
    targetApplicationForward,
    'Target application database port forward',
  );
  assertForwardAlive(
    targetKestraForward,
    'Target Kestra database port forward',
  );
  const report = await restoreFoundation({
    backupDirectory,
    targetConfig,
    targetDirectory,
    keyRecovery,
    resolveSecret,
    applicationCredentials,
    runTool: kubernetesTool,
  });
  assert.equal(report.status, 'verified-services-disabled');
  assert.equal(
    (await readFile(join(targetDirectory, 'RESTORE_DISABLED'), 'utf8')).trim(),
    'Keep application, workers, and Kestra stopped until operator acceptance.',
  );
  const restoredConfiguration = JSON.parse(
    await readFile(join(targetDirectory, 'configuration.json'), 'utf8'),
  );
  const restoredRelease = JSON.parse(
    await readFile(join(targetDirectory, 'release.json'), 'utf8'),
  );
  assert.deepEqual(restoredConfiguration, sourceConfig);
  assert.deepEqual(restoredRelease, sourceOperator.release);

  targetApplicationForward.close();
  const acceptanceForward = portForward(
    targetNamespace,
    'application-postgres',
    5432,
  );
  forwards.push(acceptanceForward);
  const acceptancePort = await acceptanceForward.ready;
  assertForwardAlive(
    acceptanceForward,
    'Target bootstrap acceptance port forward',
  );
  const application = new pg.Client(
    await connectionOptions(
      {
        ...targetConfig.services.applicationDatabase,
        ...applicationCredentials,
        endpoint: {
          ...targetConfig.services.applicationDatabase.endpoint,
          url: `postgresql://localhost:${acceptancePort}`,
        },
      },
      resolveSecret,
    ),
  );
  await application.connect();
  try {
    const row = (
      await application.query(
        'SELECT generation, revoked_at IS NOT NULL AS revoked FROM cc.bootstrap_access WHERE id=1',
      )
    ).rows[0];
    assert.equal(row.revoked, true);
    const bootstrap = String(
      await resolveSecret(targetRuntime.services.api.bootstrapSecretRef),
    );
    await replaceBootstrap(application, bootstrap, row.generation);
  } finally {
    await application.end();
  }

  const artifactVolume = join(targetDirectory, 'artifact-volume', 'artifacts');
  const kestraVolume = join(targetDirectory, 'kestra-volume', 'kestra');
  await mkdir(artifactVolume, { recursive: true, mode: 0o700 });
  await mkdir(kestraVolume, { recursive: true, mode: 0o700 });
  await cp(join(targetDirectory, 'artifacts'), artifactVolume, {
    recursive: true,
  });
  await cp(join(targetDirectory, 'kestra-internal'), kestraVolume, {
    recursive: true,
  });
  await rm(join(targetDirectory, 'RESTORE_DISABLED'));
  await writeFile(
    join(targetDirectory, 'offline-acceptance.json'),
    `${JSON.stringify({ status: 'verified', applicationTables: report.applicationTables, kestraTables: report.kestraTables }, null, 2)}\n`,
    { mode: 0o600 },
  );

  await renderTargetKestra(runtimeRoot, targetRuntime, targetOperator);
  apply({
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: { name: 'cc-synthetic-rwx-restore' },
    provisioner: 'kubernetes.io/no-provisioner',
    volumeBindingMode: 'Immediate',
  });
  for (const [claim, hostPath] of [
    [
      'campus-artifacts',
      '/var/local/cc-synthetic-shared/restore-qualification/artifact-volume',
    ],
    [
      'kestra-internal',
      '/var/local/cc-synthetic-shared/restore-qualification/kestra-volume',
    ],
  ])
    apply({
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: { name: `cc-synthetic-restore-${claim}` },
      spec: {
        capacity: { storage: '100Gi' },
        accessModes: ['ReadWriteMany'],
        persistentVolumeReclaimPolicy: 'Retain',
        storageClassName: 'cc-synthetic-rwx-restore',
        claimRef: { namespace: targetNamespace, name: claim },
        hostPath: { path: hostPath, type: 'Directory' },
      },
    });
  apply(targetList);
  const preparation = targetList.items.find((item) => item.kind === 'Job');
  kube(targetNamespace, [
    'wait',
    '--for=condition=complete',
    `job/${preparation.metadata.name}`,
    '--timeout=15m',
  ]);
  kube(targetNamespace, ['rollout', 'status', 'deployment', '--timeout=15m']);
  const targetWorkloads = workloadInventory(targetNamespace);
  assert.equal(targetWorkloads.length, 8);
  assert.ok(targetWorkloads.every(({ desired, ready }) => desired === ready));
  const targetStartup = await protectedStartup(targetNamespace, runtimeRoot);
  assert.equal(redisExists(targetNamespace, redisSentinel), 0);
  const targetWorker = json(targetNamespace, [
    'get',
    'pods',
    '-l',
    'app.kubernetes.io/name=workers',
    '-o',
    'json',
  ]).items[0];
  const restoredArtifact = execWorker(
    targetWorker.metadata.name,
    'target',
    artifact,
  );
  assert.equal(restoredArtifact.integrity, 'pass');
  const restoredKestra = await verifyTargetKestra(runtimeRoot, kestraFixture);

  const targetPvcs = json(targetNamespace, ['get', 'pvc', '-o', 'json'])
    .items.map(({ metadata, spec, status }) => ({
      name: metadata.name,
      uid: metadata.uid,
      volumeName: spec.volumeName,
      phase: status.phase,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sourcePvcs = json(sourceNamespace, ['get', 'pvc', '-o', 'json'])
    .items.map(({ metadata, spec }) => ({
      name: metadata.name,
      uid: metadata.uid,
      volumeName: spec.volumeName,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const target of targetPvcs)
    assert.ok(sourcePvcs.every((source) => source.uid !== target.uid));

  const common = {
    scope: 'synthetic-kind-three-node-shared-host-directory',
    cluster: 'cc-workload-validation',
    context,
    kubeconfig,
    nodeImage:
      'kindest/node:v1.35.8@sha256:07b2536e30b803ed61d1677a79df6115f798ce64c80f9e22f6ed45afd09323c0',
    nodes: nodes.items.map(({ metadata }) => metadata.name).sort(),
    images: sourceOperator.release.images,
    sourceRevision: sourceOperator.release.sourceRevision,
    sourceState: 'uncommitted-implementation',
    qualifiesDistrictStorage: false,
    networkPolicyEnforced: false,
    loadBalancerQualified: false,
  };
  await writeFile(
    'deployment/evidence/CC-15-workload-result.json',
    `${JSON.stringify(
      {
        ...common,
        namespace: sourceNamespace,
        startup: sourceStartup,
        workloads: sourceWorkloads,
        crossNode: {
          writerPod: writer.metadata.name,
          writerNode: writer.spec.nodeName,
          readerPod: reader.metadata.name,
          readerNode: reader.spec.nodeName,
          replacementPod: replacement.metadata.name,
          replacementNode: replacement.spec.nodeName,
          descriptor: artifact,
          read: crossNodeRead,
          rescheduledRead,
        },
        testedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    'deployment/evidence/CC-17-kubernetes-result.json',
    `${JSON.stringify(
      {
        ...common,
        status: 'pass',
        sourceNamespace,
        targetNamespace,
        operatorAdapter: {
          sourceApplicationPort,
          sourceKestraPort,
          targetApplicationPort,
          targetKestraPort,
          tlsServerName: 'localhost',
          kubernetesPostgresTools: version,
          postgresTransport:
            'One verified TLS database session per kubectl port-forward process.',
        },
        quiesce,
        sourceWorkloads,
        targetWorkloads,
        sourceStartup,
        targetStartup,
        sourcePvcs,
        targetPvcs,
        backup: {
          profile: manifest.profile,
          postgresVersion: manifest.postgresVersion,
          redisRecovery: manifest.redisRecovery,
          componentPaths: manifest.files.map(({ path }) => path),
          configurationSha256: sha256(JSON.stringify(restoredConfiguration)),
          releaseSha256: sha256(JSON.stringify(restoredRelease)),
        },
        restore: {
          status: report.status,
          disabledMarkerObserved: true,
          disabledMarkerRemovedAfterAcceptance: true,
          applicationTables: report.applicationTables,
          kestraTables: report.kestraTables,
          artifactFiles: report.artifactFiles,
        },
        fixtures: {
          artifact: {
            before: crossNodeRead,
            after: restoredArtifact,
          },
          kestra: { before: kestraFixture, after: restoredKestra },
          redis: { sourceMarkerExists: 1, targetMarkerExists: 0 },
        },
        isolation: {
          namespaceMapping: {
            source: sourceNamespace,
            target: targetNamespace,
          },
          sourceWritersStopped: stopped,
          distinctNamespaces: true,
          distinctPvcUids: true,
          sourceResourcesRetained: true,
          targetDirectory,
          sourceRoots: {
            artifacts: sourceConfig.artifacts.location,
            kestraInternal:
              sourceConfig.services.kestra.internalStorage.location,
          },
          restoredRoots: {
            artifacts: targetConfig.artifacts.location,
            kestraInternal:
              targetConfig.services.kestra.internalStorage.location,
          },
          mountedTargetRoots: {
            artifacts: artifactVolume,
            kestraInternal: kestraVolume,
          },
        },
        durationMilliseconds: Date.now() - startedAt,
        testedAt: new Date().toISOString(),
        limitations: [
          'Kind hostPath shares one Docker host and does not qualify district RWX storage.',
          'Kind default networking does not qualify an enforcing district CNI.',
          'Port forwarding qualifies the operator adapter, not district control-plane routing.',
          'Local immutable images do not qualify a published signed release.',
        ],
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ status: 'pass', sourceNamespace, targetNamespace, readyChecks: targetStartup.checks.length, durationMilliseconds: Date.now() - startedAt })}\n`,
  );
} finally {
  for (const forward of forwards) forward.close();
}
