import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { configureKubernetesProvider } from '../deployment/kubernetes/qualification-provider.mjs';
import {
  readKubernetesReplica,
  verifyKubernetesRecipientAccess,
} from './kubernetes-replicas-fixture.mjs';
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

test('Kubernetes replica reads keep cookies out of arguments and reject unrelated routes', async () => {
  const calls = [];
  const kube = async (args, input) => {
    calls.push({ args, input });
    return JSON.stringify({ status: 401 });
  };
  const request = {
    kube,
    replica: 'api-123-abc',
    path: '/api/auth/session',
    cookie: '__Host-session=private-cookie',
  };
  for (const path of [
    '/api/google-connection',
    '/api/schools?count=true',
    '/api/auth/session?token=value',
  ])
    await assert.rejects(readKubernetesReplica({ ...request, path }));
  await assert.rejects(
    readKubernetesReplica({ ...request, replica: 'workers-123-abc' }),
  );
  assert.equal(calls.length, 0);
  const result = await readKubernetesReplica(request);
  assert.equal(result.status, 401);
  assert.ok(!JSON.stringify(calls[0].args).includes(request.cookie));
  assert.equal(JSON.parse(calls[0].input).cookie, request.cookie);
});

test('Kubernetes permission checks replay stale sessions and hide ungranted and unknown schools', async () => {
  const principalId = 'principal';
  const schoolId = '01234567-89ab-cdef-0123-456789abcdef';
  const hiddenSchoolId = '12345678-9abc-def0-1234-56789abcdef0';
  for (const stage of ['grants-changed', 'scoped-access', 'revoked']) {
    const expectedStatus = stage === 'scoped-access' ? 200 : 401;
    const calls = [];
    const kube = async (args, input) => {
      if (args[0] === 'get')
        return JSON.stringify({
          items: ['api-a-123', 'api-b-456'].map((name) => ({
            metadata: { name },
            status: {
              phase: 'Running',
              containerStatuses: [{ name: 'api', ready: true }],
            },
          })),
        });
      const request = JSON.parse(input);
      calls.push(request);
      if (expectedStatus === 401) return JSON.stringify({ status: 401 });
      if (request.path === '/api/auth/session')
        return JSON.stringify({ status: 200, principalId });
      if (request.path === `/api/schools/${schoolId}`)
        return JSON.stringify({ status: 200, schoolId });
      return JSON.stringify({ status: 404, hiddenSchoolResponse: true });
    };
    const observations = await verifyKubernetesRecipientAccess(kube, {
      principalId,
      schoolId,
      hiddenSchoolId,
      expectedStatus,
      stage,
      cookies: [{ name: '__Host-session', value: 'saved-cookie' }],
    });
    assert.equal(observations.length, stage === 'scoped-access' ? 8 : 4);
    assert.equal(new Set(observations.map((item) => item.replica)).size, 2);
    assert.ok(
      calls.every((item) => item.cookie === '__Host-session=saved-cookie'),
    );
    assert.ok(!JSON.stringify(observations).includes('saved-cookie'));
  }
});
