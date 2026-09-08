import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { renderKubernetes } from './render.mjs';

const profile = JSON.parse(
  await readFile(
    new URL('../examples/kubernetes.json', import.meta.url),
    'utf8',
  ),
);
profile.services.api.placement.replicas = 2;
const operator = JSON.parse(
  await readFile(new URL('./operator.example.json', import.meta.url), 'utf8'),
);
const render = () =>
  renderKubernetes(structuredClone(profile), structuredClone(operator));
const workload = (list, key) =>
  list.items.find(
    (item) =>
      item.kind === 'Deployment' &&
      item.spec.template.metadata.labels['app.kubernetes.io/name'] === key,
  );

test('rendering is deterministic and preserves shared release images with multiple instances', () => {
  assert.deepEqual(render(), render());
  const list = render();
  for (const key of ['frontend', 'api', 'workers'])
    assert.equal(
      workload(list, key).spec.template.spec.containers[0].image,
      operator.release.images[key],
    );
  assert.equal(workload(list, 'api').spec.replicas, 2);
  assert.equal(workload(list, 'workers').spec.replicas, 2);
  assert.ok(
    workload(list, 'workers').spec.template.spec.containers[0].env.some(
      ({ name, value }) =>
        name === 'WORKER_DISPATCH_SECRET_FILE' &&
        value.endsWith('/worker-dispatch'),
    ),
  );
  assert.ok(
    workload(list, 'workers').spec.template.spec.affinity.podAntiAffinity
      .requiredDuringSchedulingIgnoredDuringExecution,
  );
  assert.deepEqual(workload(list, 'workers').spec.strategy.rollingUpdate, {
    maxSurge: 0,
    maxUnavailable: 1,
  });
});

test('rendering rejects unmet replica, image, namespace, storage, and trust prerequisites', () => {
  const cases = [
    (config) => {
      config.services.api.placement.replicas = 1;
    },
    (_config, input) => {
      input.workerNodeCount = 1;
    },
    (_config, input) => {
      input.release.images.api = input.release.images.frontend;
    },
    (_config, input) => {
      input.namespace = 'another-namespace';
    },
    (_config, input) => {
      delete input.storageClasses.postgres;
    },
    (_config, input) => {
      delete input.kestraRuntime.workerTrustStoreKey;
    },
  ];
  for (const change of cases) {
    const config = structuredClone(profile),
      input = structuredClone(operator);
    change(config, input);
    assert.throws(() => renderKubernetes(config, input));
  }
});

test('secrets remain references and administration credentials stay outside application pods', () => {
  const list = render();
  assert.equal(list.items.filter((item) => item.kind === 'Secret').length, 0);
  for (const key of ['frontend', 'api', 'workers', 'edge']) {
    const spec = workload(list, key).spec.template.spec;
    assert.ok(
      !spec.volumes.some(
        (volume) => volume.secret?.secretName === 'campus-database-admin',
      ),
    );
    assert.ok(
      !spec.volumes.some(
        (volume) => volume.secret?.secretName === 'campus-migration',
      ),
    );
    assert.equal(spec.automountServiceAccountToken, false);
    assert.equal(spec.securityContext.runAsNonRoot, true);
  }
  const edge = workload(list, 'edge').spec.template.spec;
  const keys = edge.volumes.flatMap(
    (volume) => volume.secret?.items.map((item) => item.key) ?? [],
  );
  assert.ok(!keys.includes('campus-database-password'));
  assert.ok(!keys.includes('bootstrap'));
});

test('durable databases and separate shared trees coexist with discardable Redis', () => {
  const list = render(),
    claims = list.items.filter((item) => item.kind === 'PersistentVolumeClaim');
  assert.equal(claims.length, 4);
  assert.notEqual(
    claims.find((item) => item.metadata.name === 'campus-artifacts'),
    claims.find((item) => item.metadata.name === 'kestra-internal'),
  );
  assert.deepEqual(
    claims.find((item) => item.metadata.name === 'campus-artifacts').spec
      .accessModes,
    ['ReadWriteMany'],
  );
  assert.ok(
    workload(list, 'redis').spec.template.spec.volumes.find(
      (volume) => volume.name === 'data',
    ).emptyDir,
  );
  assert.ok(
    workload(list, 'api').spec.template.spec.initContainers.some(
      (container) => container.name === 'wait-database',
    ),
  );
  assert.equal(list.items.filter((item) => item.kind === 'Job').length, 1);
});

test('external dependencies omit local workloads and receive explicit network paths', () => {
  const config = structuredClone(profile),
    input = structuredClone(operator);
  for (const key of [
    'applicationDatabase',
    'kestraDatabase',
    'redis',
    'kestra',
  ]) {
    const service = config.services[key];
    service.placement = { kind: 'external', operator: 'district' };
    delete service.serverTls;
    (service.persistence ?? service.internalStorage).kind = 'external-managed';
    service.endpoint.url = service.endpoint.url.replace(
      '.campus-commander.svc.cluster.local',
      '.district.example',
    );
    input.externalEgress[key] = ['198.51.100.0/24'];
  }
  delete input.kestraRuntime;
  delete input.storageClasses.postgres;
  delete input.storageClasses.kestraInternal;
  input.databaseAdmins = {};
  const list = renderKubernetes(config, input);
  for (const key of [
    'applicationDatabase',
    'kestraDatabase',
    'redis',
    'kestra',
  ])
    assert.equal(workload(list, key), undefined);
  assert.equal(
    list.items.filter((item) => item.kind === 'PersistentVolumeClaim').length,
    1,
  );
  const workersIngress = list.items.find(
    (item) =>
      item.kind === 'NetworkPolicy' && item.metadata.name === 'workers-ingress',
  );
  assert.ok(
    workersIngress.spec.ingress.some((rule) =>
      rule.from.some((peer) => peer.ipBlock?.cidr === '198.51.100.0/24'),
    ),
  );
});

test('TLS probes preserve certificate verification and edge egress reaches only frontend and API', () => {
  const list = render();
  for (const key of ['frontend', 'api', 'workers', 'edge'])
    assert.ok(
      workload(list, key).spec.template.spec.containers[0].readinessProbe.exec,
    );
  const config = list.items.find((item) => item.kind === 'ConfigMap');
  assert.match(config.data['http-probe.cjs'], /rejectUnauthorized:true/);
  assert.match(config.data['http-probe.cjs'], /checkServerIdentity/);
  assert.match(config.data['pg_hba.conf'], /hostnossl all all all reject/);
  const edge = list.items.find(
    (item) =>
      item.kind === 'NetworkPolicy' && item.metadata.name === 'edge-egress',
  );
  assert.deepEqual(
    edge.spec.egress.map(
      (rule) => rule.to[0].podSelector.matchLabels['app.kubernetes.io/name'],
    ),
    ['frontend', 'api'],
  );
});
