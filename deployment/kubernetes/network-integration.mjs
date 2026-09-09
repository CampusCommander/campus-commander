import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const fixturePath = process.argv[2];
if (!fixturePath) throw new Error('Provide an absolute network fixture path.');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const startedAt = Date.now();
if (
  fixture.qualificationOnly !== true ||
  !fixture.kubeconfig?.startsWith('/tmp/cc-closeout-kube') ||
  !fixture.context?.startsWith('kind-cc-closeout-kube') ||
  !fixture.namespace?.startsWith('cc-closeout-kube') ||
  !fixture.detailPath?.startsWith('/tmp/cc-closeout-kube') ||
  !isAbsolute(fixture.resultPath ?? '') ||
  !/^\/tmp\/cc-closeout-kube[^/]*\//.test(resolve(fixture.resultPath)) ||
  !fixture.operatorPath?.startsWith('/tmp/cc-closeout-kube')
) {
  throw new Error(
    'Network qualification requires the isolated closeout fixture.',
  );
}
const operator = JSON.parse(await readFile(fixture.operatorPath, 'utf8'));
assert.equal(operator.project, fixture.namespace);
assert.equal(operator.cluster.context, fixture.context);
const release = JSON.parse(await readFile(operator.releasePath, 'utf8'));

const kube = (args, input) =>
  execFileSync(
    'kubectl',
    ['--kubeconfig', fixture.kubeconfig, '--context', fixture.context, ...args],
    {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    },
  ).trim();
const namespaced = (args, input) =>
  kube(['--namespace', fixture.namespace, ...args], input);
const json = (args) => JSON.parse(kube([...args, '-o', 'json']));
const namespacedJson = (args) =>
  JSON.parse(namespaced([...args, '-o', 'json']));

const nodes = json(['get', 'nodes']);
assert.equal(nodes.items.length, 3, 'The fixture requires three nodes.');
assert.equal(
  nodes.items.filter(
    (node) =>
      node.metadata.labels?.['node-role.kubernetes.io/control-plane'] !==
      undefined,
  ).length,
  1,
  'The fixture requires one control-plane node.',
);
assert.equal(
  nodes.items.filter((node) =>
    node.status.conditions?.some(
      (condition) => condition.type === 'Ready' && condition.status === 'True',
    ),
  ).length,
  3,
  'Every fixture node must be ready.',
);
const serverVersion = json(['version']).serverVersion.gitVersion;
assert.match(
  serverVersion,
  /^v1\.35\./,
  'Use the qualified Kubernetes major and minor.',
);

const calicoPods = json([
  '--namespace',
  'kube-system',
  'get',
  'pods',
  '--selector',
  'k8s-app=calico-node',
]);
assert.equal(calicoPods.items.length, 3, 'Calico must run on every node.');
for (const pod of calicoPods.items) {
  assert.equal(pod.status.phase, 'Running');
  assert.ok(
    pod.status.containerStatuses?.every((container) => container.ready),
    'Every Calico container must be ready.',
  );
}
const calicoImages = [
  ...new Set(
    calicoPods.items.flatMap((pod) =>
      pod.spec.containers.map((container) => container.image),
    ),
  ),
];
assert.deepEqual(calicoImages, ['quay.io/calico/node:v3.32.2']);

const deployments = namespacedJson(['get', 'deployments']);
const requiredDeployments = [
  'api',
  'application-postgres',
  'edge',
  'frontend',
  'kestra',
  'kestra-postgres',
  'redis',
  'workers',
];
function assertReadyDeployments(inventory) {
  for (const name of requiredDeployments) {
    const deployment = inventory.items.find(
      (item) => item.metadata.name === name,
    );
    assert.ok(deployment, `Missing ${name} deployment.`);
    assert.equal(
      deployment.status.readyReplicas,
      deployment.spec.replicas,
      `${name} must be ready.`,
    );
    assert.ok(deployment.spec.replicas > 0);
  }
}
assertReadyDeployments(deployments);
const apiImage = deployments.items.find((item) => item.metadata.name === 'api')
  .spec.template.spec.containers[0].image;

const relations = [
  ['edge', 'frontend', 8080, true],
  ['edge', 'api', 3000, true],
  ['api', 'frontend', 8080, true],
  ['api', 'workers', 3001, true],
  ['api', 'application-postgres', 5432, true],
  ['api', 'kestra-postgres', 5432, true],
  ['api', 'redis', 6379, true],
  ['api', 'kestra', 8080, true],
  ['workers', 'application-postgres', 5432, true],
  ['kestra', 'kestra-postgres', 5432, true],
  ['kestra', 'workers', 3001, true],
  ['untrusted', 'frontend', 8080, false],
  ['untrusted', 'api', 3000, false],
  ['untrusted', 'workers', 3001, false],
  ['untrusted', 'application-postgres', 5432, false],
  ['untrusted', 'kestra-postgres', 5432, false],
  ['untrusted', 'redis', 6379, false],
  ['untrusted', 'kestra', 8080, false],
  ['edge', 'workers', 3001, false],
  ['edge', 'application-postgres', 5432, false],
  ['edge', 'redis', 6379, false],
  ['frontend', 'application-postgres', 5432, false],
  ['api', 'edge', 8443, false],
];
const sourceNames = [...new Set(relations.map(([source]) => source))];
const records = [];
const tcpProbe = String.raw`
const net=require('node:net');
const socket=net.createConnection({host:process.argv[1],port:Number(process.argv[2])});
const timer=setTimeout(()=>{console.log('TIMEOUT');socket.destroy();process.exit(2)},3000);
socket.once('connect',()=>{clearTimeout(timer);console.log('CONNECTED');socket.destroy();process.exit(0)});
socket.once('error',(error)=>{clearTimeout(timer);console.log('ERROR:'+error.code);process.exit(1)});
`;
const dnsProbe = String.raw`
require('node:dns').lookup(process.argv[1],(error)=>{if(error){console.log('ERROR:'+error.code);process.exit(1)}console.log('RESOLVED')});
`;
const untrustedPod = `cc-network-probe-${randomUUID().slice(0, 12)}`;
let probeCreated = false;
const createUntrustedProbe = () => {
  namespaced(
    ['create', '-f', '-'],
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: untrustedPod,
        labels: { 'campus-commander.test': 'network-policy' },
      },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: 'Never',
        terminationGracePeriodSeconds: 1,
        readinessGates: [
          { conditionType: 'campus-commander.test/traffic-disabled' },
        ],
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        containers: [
          {
            name: 'probe',
            image: apiImage,
            imagePullPolicy: 'IfNotPresent',
            command: ['node', '-e', 'setInterval(() => {}, 60000)'],
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
              readOnlyRootFilesystem: true,
            },
            resources: {
              requests: { cpu: '5m', memory: '16Mi' },
              limits: { cpu: '100m', memory: '64Mi' },
            },
          },
        ],
      },
    }),
  );
  probeCreated = true;
  namespaced([
    'wait',
    '--for=jsonpath={.status.phase}=Running',
    `pod/${untrustedPod}`,
    '--timeout=120s',
  ]);
};

function workloadPod(source) {
  if (source === 'untrusted') return untrustedPod;
  const pods = namespacedJson([
    'get',
    'pods',
    '--selector',
    `app.kubernetes.io/part-of=campus-commander,app.kubernetes.io/name=${source}`,
  ]).items;
  const pod = pods.find(
    (item) =>
      item.status.phase === 'Running' &&
      item.status.containerStatuses?.every((container) => container.ready) &&
      item.metadata.labels?.['campus-commander.test'] !== 'network-policy',
  );
  assert.ok(pod, `A ready ${source} workload pod is required.`);
  return pod.metadata.name;
}

function executeProbe(source, podName, code, host, port) {
  const common = ['exec', podName];
  if (source === 'kestra') common.push('--container', 'kestra');
  if (source === 'kestra') {
    const destination = `${host}/${port}`;
    try {
      namespaced([
        ...common,
        '--',
        'timeout',
        '4',
        'bash',
        '-c',
        'cat < /dev/null > /dev/tcp/${1%/*}/${1#*/}',
        'probe',
        destination,
      ]);
      return 'CONNECTED';
    } catch (error) {
      return error.status === 124 ? 'TIMEOUT' : 'ERROR';
    }
  }
  try {
    return namespaced([
      ...common,
      '--',
      'node',
      '-e',
      code,
      host,
      String(port),
    ]);
  } catch (error) {
    return String(error.stdout ?? '').trim();
  }
}

let probeError;
let cleanupError;
try {
  createUntrustedProbe();
  for (const source of sourceNames) {
    const podName = workloadPod(source);
    const apiHost = `api.${fixture.namespace}.svc.cluster.local`;
    const dns =
      source === 'kestra'
        ? namespaced([
            'exec',
            podName,
            '--container',
            'kestra',
            '--',
            'getent',
            'hosts',
            apiHost,
          ])
        : executeProbe(source, podName, dnsProbe, apiHost, 53);
    if (source === 'kestra') assert.ok(dns, 'Kestra must reach cluster DNS.');
    else assert.equal(dns, 'RESOLVED', `${source} must reach cluster DNS.`);
    records.push({
      source,
      target: 'cluster-dns',
      port: 53,
      expected: 'allowed',
      observed: 'allowed',
    });

    for (const [relationSource, target, port, allowed] of relations) {
      if (relationSource !== source) continue;
      const observed = executeProbe(
        source,
        podName,
        tcpProbe,
        `${target}.${fixture.namespace}.svc.cluster.local`,
        port,
      );
      const accepted = observed === 'CONNECTED';
      if (allowed)
        assert.equal(accepted, true, `${source} must reach ${target}:${port}.`);
      else
        assert.equal(
          observed,
          'TIMEOUT',
          `${source} must be denied from ${target}:${port}.`,
        );
      records.push({
        source,
        target,
        port,
        expected: allowed ? 'allowed' : 'denied',
        observed: accepted ? 'allowed' : 'denied',
      });
    }
  }
} catch (error) {
  probeError = error;
} finally {
  try {
    if (probeCreated)
      namespaced([
        'delete',
        'pod',
        untrustedPod,
        '--ignore-not-found=true',
        '--wait=true',
      ]);
  } catch (error) {
    cleanupError = error;
  }
}
if (probeError && cleanupError)
  throw new AggregateError(
    [probeError, cleanupError],
    'Network probes and fixture cleanup failed.',
  );
if (probeError) throw probeError;
if (cleanupError) throw cleanupError;
assertReadyDeployments(namespacedJson(['get', 'deployments']));

const state = JSON.parse(
  await readFile(
    join(operator.installationRoot, 'installer-state.json'),
    'utf8',
  ),
);
assert.equal(state.phase, 'ready');
const result = {
  schemaVersion: 1,
  ticket: 'CC-15',
  status: 'passed',
  checkedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  scope: 'synthetic-kind-enforcing-network-policy',
  testedReleaseSourceRevision: release.sourceRevision,
  images: release.images,
  platform: {
    kubernetesVersion: serverVersion,
    nodeCount: 3,
    controlPlaneNodeCount: 1,
    workerNodeCount: 2,
    cni: { name: 'Calico', version: 'v3.32.2', readyNodeCount: 3 },
  },
  assertions: {
    deploymentCount: requiredDeployments.length,
    allDeploymentsReady: true,
    dnsAllowedForEveryProbe: true,
    allowedServicePathsPassed:
      records.filter((record) => record.expected === 'allowed').length -
      sourceNames.length,
    dnsPathsPassed: sourceNames.length,
    deniedPathsPassed: records.filter((record) => record.expected === 'denied')
      .length,
  },
  networkChecks: records,
  boundaries: [
    'The fixture uses one Docker host and does not qualify district infrastructure.',
    'The test validates rendered pod ingress and egress policy through Calico.',
  ],
};
await writeFile(fixture.resultPath, `${JSON.stringify(result, null, 2)}\n`, {
  mode: 0o600,
  flag: 'wx',
});
await writeFile(
  fixture.detailPath,
  `${JSON.stringify({ ...result, context: fixture.context, namespace: fixture.namespace }, null, 2)}\n`,
  { mode: 0o600, flag: 'wx' },
);
process.stdout.write(
  `${JSON.stringify({ status: result.status, checks: records.length })}\n`,
);
