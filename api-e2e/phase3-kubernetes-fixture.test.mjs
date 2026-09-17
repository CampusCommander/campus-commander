import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { configureKubernetesProvider } from '../deployment/kubernetes/qualification-provider.mjs';
import { verifyKubernetesCredentialProjection } from './phase3-kubernetes-fixture.mjs';

const pod = (service, index = 0) => ({
  metadata: {
    name: `${service}-${index}`,
    labels: { 'app.kubernetes.io/name': service },
  },
  spec: {
    nodeName: `worker-${index}`,
    volumes: [
      { name: 'key', secret: { secretName: 'google-key', defaultMode: 0o440 } },
    ],
    containers: [
      {
        name: service,
        image: `fixture/${service}@sha256:${'a'.repeat(64)}`,
        volumeMounts: [
          { name: 'key', mountPath: '/run/secrets/google-key', readOnly: true },
        ],
        env: [],
      },
    ],
  },
  status: {
    containerStatuses: [
      { name: service, ready: true, imageID: `sha256:${'a'.repeat(64)}` },
    ],
  },
});

test('credential projection rejects unauthorized consumers, writable mounts, and changed bytes', async (t) => {
  const project = `cc-capacity-kube-${randomBytes(6).toString('hex')}`;
  const root = await mkdtemp(`/tmp/${project}-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runtime'));
  await mkdir(join(root, 'installer/private/google-key'), { recursive: true });
  await writeFile(
    join(root, 'runtime/config.json'),
    JSON.stringify({
      phase: 3,
      googleConnection: {
        keyId: 'version-1',
        encryptionKeySecretRef: {
          provider: 'kubernetes',
          name: 'google-key',
          key: 'encryption-key',
        },
      },
    }),
  );
  const privateMarker = randomBytes(32).toString('base64');
  await writeFile(
    join(root, 'installer/private/google-key/encryption-key'),
    privateMarker,
    { mode: 0o600 },
  );
  const images = Object.fromEntries(
    ['api', 'workers'].map((name) => [
      name,
      `fixture/${name}@sha256:${'a'.repeat(64)}`,
    ]),
  );
  const original = [
    pod('api', 0),
    pod('api', 1),
    pod('workers', 0),
    pod('workers', 1),
  ];
  let pods = structuredClone(original),
    matches = true;
  const kube = async (args, input) => {
    if (args[0] === 'get') return JSON.stringify({ items: pods });
    assert.equal(
      Buffer.from(JSON.parse(input).expected, 'base64').toString(),
      privateMarker,
    );
    return JSON.stringify({ matches, mode: 0o440, keyId: 'version-1' });
  };
  const run = () =>
    verifyKubernetesCredentialProjection({ kube, root, project, images });
  const report = await run();
  assert.equal(report.status, 'passed');
  assert.ok(!JSON.stringify(report).includes(privateMarker));
  pods.push(pod('frontend'));
  await assert.rejects(run, /Unrelated pods/);
  pods = structuredClone(original);
  pods[0].spec.containers[0].volumeMounts[0].readOnly = false;
  await assert.rejects(run);
  pods = structuredClone(original);
  pods[0].spec.initContainers = [
    { name: 'unrelated-init', volumeMounts: [{ name: 'key' }] },
  ];
  await assert.rejects(run, /Unrelated containers/);
  pods = structuredClone(original);
  matches = false;
  await assert.rejects(run);
});

test('synthetic transport targets API only in Phase 2 and API plus workers in Phase 3', () => {
  const resources = () => ({
    items: ['api', 'workers', 'frontend'].map((name) => ({
      kind: 'Deployment',
      metadata: { name },
      spec: { template: { spec: pod(name).spec } },
    })),
  });
  for (const phase of [2, 3]) {
    const list = resources();
    configureKubernetesProvider(list, { phase, hostGateway: '172.17.0.1' });
    for (const item of list.items) {
      const enabled =
        item.metadata.name === 'api' ||
        (phase === 3 && item.metadata.name === 'workers');
      const env = item.spec.template.spec.containers[0].env;
      assert.equal(
        env.some((entry) => entry.name === 'NODE_EXTRA_CA_CERTS'),
        enabled,
      );
      assert.equal(
        env.some((entry) => entry.name === 'NODE_OPTIONS'),
        phase === 3 && enabled,
      );
    }
  }
});
