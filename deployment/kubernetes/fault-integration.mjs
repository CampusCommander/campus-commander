import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { qualificationImages } from '../qualification/images.mjs';

const kubeconfig = '/tmp/cc-kube-workload-kubeconfig';
const context = 'kind-cc-workload-validation';
const namespace = 'cc-kube-restore-synthetic';
const evidencePath = 'deployment/evidence/CC-18-kubernetes-result.json';
const restoreEvidencePath = 'deployment/evidence/CC-17-kubernetes-result.json';
const descriptorPath = `/tmp/cc-kubernetes-fault-artifact-${process.pid}.json`;

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
const kube = (args, input) =>
  command(['--namespace', namespace, ...args], input);
const json = (args) => JSON.parse(kube([...args, '-o', 'json']));
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function waitFor(check, label, attempts = 180) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw new Error(
    `${label} did not complete.${lastError ? ` ${lastError.message}` : ''}`,
  );
}

function secretBytes(name, key) {
  const secret = json(['get', 'secret', name]);
  return Buffer.from(secret.data[key], 'base64');
}

function portForward(service, remotePort) {
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
      `:${remotePort}`,
      '--address',
      '127.0.0.1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Port forward for ${service} did not start.`)),
      10000,
    );
    const inspect = (chunk) => {
      const match = chunk.toString().match(/127\.0\.0\.1:(\d+) ->/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code) reject(new Error(`Port forward for ${service} exited.`));
    });
  });
  return {
    ready,
    close() {
      child.kill('SIGTERM');
    },
  };
}

function request({ port, servername, ca, path, authorization }) {
  return new Promise((resolve) => {
    const client = https.get(
      {
        hostname: '127.0.0.1',
        port,
        servername,
        path,
        ca,
        rejectUnauthorized: true,
        headers: {
          host: servername,
          ...(authorization ? { authorization } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    client.setTimeout(10000, () => client.destroy());
    client.on('error', () => resolve({ statusCode: 0, body: Buffer.alloc(0) }));
  });
}

function normalizeReport(body) {
  const value = JSON.parse(body.toString('utf8'));
  const report =
    value.message && typeof value.message === 'object' ? value.message : value;
  return {
    status: report.status,
    checks: Array.isArray(report.checks) ? report.checks : [],
  };
}

async function observeStartup() {
  const forward = portForward('edge', 443);
  try {
    const port = await forward.ready;
    const ca = secretBytes('campus-installation', 'district-ca');
    const token = secretBytes('campus-installation', 'bootstrap')
      .toString('utf8')
      .trim();
    const response = await request({
      port,
      servername: 'campus.example.org',
      ca,
      path: '/api/startup',
      authorization: `Basic ${Buffer.from(`operator:${token}`).toString('base64')}`,
    });
    if (![200, 503].includes(response.statusCode))
      return { status: 'unavailable', checks: [] };
    try {
      return normalizeReport(response.body);
    } catch {
      return { status: 'unavailable', checks: [] };
    }
  } finally {
    forward.close();
  }
}

function diagnoseApi() {
  const source = String.raw`const https=require('node:https'),fs=require('node:fs');const host=process.env.TLS_SERVER_NAME;const request=https.get({hostname:'127.0.0.1',port:process.env.PORT,servername:host,path:'/health/ready',ca:fs.readFileSync(process.env.TLS_CA_FILE),rejectUnauthorized:true,headers:{host}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>process.stdout.write(Buffer.concat(chunks)))});request.setTimeout(10000,()=>request.destroy());request.on('error',()=>process.exit(1));`;
  return normalizeReport(
    Buffer.from(
      kube(['exec', 'deployment/api', '--', 'node', '-e', source]),
      'utf8',
    ),
  );
}

function artifactFixture(descriptor) {
  const pod = json([
    'get',
    'pods',
    '-l',
    'app.kubernetes.io/name=workers',
  ]).items.find(({ status }) => status.phase === 'Running');
  assert.ok(pod, 'A running worker is required for the artifact probe.');
  return JSON.parse(
    kube(
      [
        'exec',
        '-i',
        pod.metadata.name,
        '--',
        'sh',
        '-ec',
        `cat > ${descriptorPath} && node /app/deployment/storage/cross-host.mjs read /config/deployment.json ${descriptorPath}`,
      ],
      `${JSON.stringify(descriptor)}\n`,
    ),
  );
}

async function kestraFixture(expected) {
  const forward = portForward('kestra', 8080);
  try {
    const port = await forward.ready;
    const ca = secretBytes('campus-installation', 'district-ca');
    const auth = JSON.parse(
      secretBytes('campus-installation', 'kestra-auth').toString('utf8'),
    );
    const authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
    const servername = `kestra.${namespace}.svc.cluster.local`;
    const flow = await request({
      port,
      servername,
      ca,
      path: '/api/v1/main/flows/campus.validation/cc11_external_worker',
      authorization,
    });
    const marker = await request({
      port,
      servername,
      ca,
      path: '/api/v1/main/namespaces/campus.validation/files?path=/cc17-kubernetes-marker.bin',
      authorization,
    });
    assert.equal(flow.statusCode, 200);
    assert.equal(marker.statusCode, 200);
    const value = JSON.parse(flow.body.toString('utf8'));
    const result = {
      flow: `${value.namespace}/${value.id}`,
      markerSha256: sha256(marker.body),
    };
    assert.deepEqual(result, expected);
    return result;
  } finally {
    forward.close();
  }
}

async function durableFixtures(descriptor, expectedKestra) {
  const artifact = artifactFixture(descriptor);
  assert.equal(artifact.integrity, 'pass');
  assert.equal(artifact.sha256, descriptor.sha256);
  return {
    artifact: {
      artifactId: artifact.artifactId,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
    },
    kestra: await kestraFixture(expectedKestra),
  };
}

function deploymentInventory() {
  return json(['get', 'deployments'])
    .items.map(({ metadata, spec, status }) => ({
      name: metadata.name,
      replicas: spec.replicas,
      ready: status.readyReplicas ?? 0,
      image: spec.template.spec.containers[0].image,
      resources: spec.template.spec.containers[0].resources,
      readinessPath:
        spec.template.spec.containers[0].readinessProbe?.exec?.command?.at(-1),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function podInventory() {
  return json(['get', 'pods'])
    .items.filter(({ status }) => status.phase === 'Running')
    .map(({ metadata, spec, status }) => ({
      name: metadata.name,
      node: spec.nodeName,
      restarts: status.containerStatuses?.[0]?.restartCount ?? 0,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function artifactMode() {
  return kube([
    'exec',
    'deployment/workers',
    '--',
    'stat',
    '-c',
    '%a',
    '/var/lib/campus-commander/artifacts',
  ]);
}

function selectedPods(deployment) {
  const selector = json(['get', 'deployment', deployment]).spec.selector
    .matchLabels;
  const label = Object.entries(selector)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return json(['get', 'pods', '-l', label]).items;
}

function scale(deployment, replicas) {
  kube(['scale', `deployment/${deployment}`, `--replicas=${replicas}`]);
}

async function interruptDeployment(deployment) {
  scale(deployment, 0);
  await waitFor(
    () => selectedPods(deployment).length === 0,
    `${deployment} termination`,
    300,
  );
}

async function recoverDeployment(deployment, replicas) {
  scale(deployment, replicas);
  kube(['rollout', 'status', `deployment/${deployment}`, '--timeout=10m']);
}

function redactLogs(deployment) {
  try {
    return kube(['logs', `deployment/${deployment}`, '--tail=12'])
      .split('\n')
      .filter(Boolean)
      .map((line) =>
        line
          .replace(
            /(authorization|password|secret|token)([=:]\s*)\S+/gi,
            '$1$2[REDACTED]',
          )
          .slice(0, 500),
      );
  } catch {
    return [];
  }
}

const restoreEvidence = JSON.parse(await readFile(restoreEvidencePath, 'utf8'));
assert.equal(restoreEvidence.status, 'pass');
assert.equal(restoreEvidence.targetNamespace, namespace);
const images = qualificationImages({
  frontend: restoreEvidence.images.frontend,
  api: restoreEvidence.images.api,
  worker: restoreEvidence.images.workers,
});
const baselineDeployments = deploymentInventory();
assert.equal(baselineDeployments.length, 8);
assert.ok(
  baselineDeployments.every(
    ({ replicas, ready }) => replicas === ready && replicas > 0,
  ),
);
for (const [deployment, expected] of [
  ['frontend', images.frontend],
  ['api', images.api],
  ['edge', images.api],
  ['workers', images.worker],
])
  assert.equal(
    baselineDeployments.find(({ name }) => name === deployment).image,
    expected,
  );
const originalReplicas = new Map(
  baselineDeployments.map(({ name, replicas }) => [name, replicas]),
);
const descriptor = restoreEvidence.fixtures.artifact.after;
const expectedKestra = restoreEvidence.fixtures.kestra.after;
const baselineStartup = await waitFor(async () => {
  const report = await observeStartup();
  return report.status === 'ready' && report.checks.length === 8
    ? report
    : undefined;
}, 'Fault baseline');
const baselineFixtures = await durableFixtures(descriptor, expectedKestra);
const baselineArtifactMode = artifactMode();
assert.equal(baselineArtifactMode, '700');

const cases = [
  { component: 'api', deployment: 'api' },
  { component: 'workers', deployment: 'workers' },
  { component: 'redis', deployment: 'redis' },
  {
    component: 'application-database',
    deployment: 'application-postgres',
  },
  { component: 'kestra', deployment: 'kestra' },
  { component: 'artifacts', deployment: null },
];
const records = [];

for (const fault of cases) {
  const started = performance.now();
  let recovered = false;
  try {
    const ready = await observeStartup();
    assert.equal(ready.status, 'ready');
    if (fault.deployment) {
      await interruptDeployment(fault.deployment);
    } else {
      kube([
        'exec',
        'deployment/workers',
        '--',
        'chmod',
        '000',
        '/var/lib/campus-commander/artifacts',
      ]);
    }
    const observed = await waitFor(
      async () => {
        const publicReport = await observeStartup();
        if (publicReport.status === 'ready') return undefined;
        if (fault.component === 'api')
          return { public: publicReport, diagnostic: null };
        const diagnostic = publicReport.checks.some(
          ({ name, status }) =>
            name === fault.component && status === 'not-ready',
        )
          ? publicReport
          : diagnoseApi();
        return diagnostic.checks.some(
          ({ name, status }) =>
            name === fault.component && status === 'not-ready',
        )
          ? { public: publicReport, diagnostic }
          : undefined;
      },
      `${fault.component} failure`,
      180,
    );
    if (fault.component !== 'api') {
      assert.ok(observed.diagnostic.checks.length > 0);
      assert.equal(
        baselineDeployments.find(({ name }) => name === 'api').replicas,
        2,
      );
    }
    if (fault.deployment) {
      await recoverDeployment(
        fault.deployment,
        originalReplicas.get(fault.deployment),
      );
    } else {
      kube([
        'exec',
        'deployment/workers',
        '--',
        'chmod',
        '700',
        '/var/lib/campus-commander/artifacts',
      ]);
    }
    recovered = true;
    const recovery = await waitFor(
      async () => {
        const report = await observeStartup();
        return report.status === 'ready' && report.checks.length === 8
          ? report
          : undefined;
      },
      `${fault.component} recovery`,
      300,
    );
    const fixtures = await durableFixtures(descriptor, expectedKestra);
    assert.deepEqual(fixtures, baselineFixtures);
    records.push({
      component: fault.component,
      deployment: fault.deployment,
      status: 'pass',
      apiDiagnosticAvailable: fault.component !== 'api',
      failure: observed,
      recovery,
      recoveryMilliseconds: Math.round(performance.now() - started),
      fixtures,
      logs: redactLogs(fault.deployment ?? 'api'),
    });
  } finally {
    if (!recovered) {
      if (fault.deployment) {
        await recoverDeployment(
          fault.deployment,
          originalReplicas.get(fault.deployment),
        );
      } else {
        kube([
          'exec',
          'deployment/workers',
          '--',
          'chmod',
          '700',
          '/var/lib/campus-commander/artifacts',
        ]);
      }
      await waitFor(
        async () => (await observeStartup()).status === 'ready',
        `${fault.component} cleanup`,
        300,
      );
    }
  }
}

const finalFixtures = await durableFixtures(descriptor, expectedKestra);
assert.deepEqual(finalFixtures, baselineFixtures);
const finalArtifactMode = artifactMode();
assert.equal(finalArtifactMode, baselineArtifactMode);
const finalDeployments = deploymentInventory();
assert.ok(
  finalDeployments.every(
    ({ name, replicas, ready }) =>
      replicas === originalReplicas.get(name) && ready === replicas,
  ),
);
const kubernetesVersion = JSON.parse(command(['version', '-o', 'json']))
  .serverVersion.gitVersion;
const result = {
  schemaVersion: 1,
  status: 'pass',
  profile: 'kubernetes',
  scope: 'synthetic-kind-process-and-shared-artifact-interruption',
  qualifiesProfile: false,
  cluster: 'cc-workload-validation',
  context,
  kubeconfig,
  namespace,
  sourceNamespace: restoreEvidence.sourceNamespace,
  sourcePreserved: true,
  nodeImage: restoreEvidence.nodeImage,
  nodes: restoreEvidence.nodes,
  sourceRevision: restoreEvidence.sourceRevision,
  sourceState: restoreEvidence.sourceState,
  images,
  kubernetesVersion,
  baselineStartup,
  baselineDeployments,
  baselinePods: podInventory(),
  baselineFixtures,
  baselineArtifactMode,
  finalFixtures,
  finalArtifactMode,
  finalDeployments,
  originalReplicasRestored: true,
  resourceObservation: {
    configuredRequestsAndLimits: true,
    metricsServerAvailable: false,
  },
  records,
  limitations: [
    'Kind hostPath shares one Docker host and does not qualify district RWX storage.',
    'Kind default networking does not qualify an enforcing district CNI.',
    'The fixture did not exercise a district LoadBalancer.',
    'The run used local immutable images from an uncommitted worktree.',
  ],
  testedAt: new Date().toISOString(),
};
await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ status: result.status, faults: records.length })}\n`,
);
