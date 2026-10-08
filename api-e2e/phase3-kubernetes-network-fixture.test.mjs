import assert from 'node:assert/strict';
import test from 'node:test';
import { qualifyKubernetesNetworkPolicies } from './phase3-kubernetes-network-fixture.mjs';

function fixture(mode) {
  const project = 'cc-capacity-kube-0123456789ab';
  const images = {
    api: `api@sha256:${'a'.repeat(64)}`,
    workers: `workers@sha256:${'b'.repeat(64)}`,
  };
  const pods = ['api', 'api', 'workers', 'workers', 'redis', 'kestra'].map(
    (service, index) => ({
      metadata: {
        name: `${service}-${index}`,
        uid: `uid-${index}`,
        namespace: project,
        labels: {
          'app.kubernetes.io/name': service,
          'app.kubernetes.io/part-of': 'campus-commander',
        },
      },
      spec: {
        nodeName: `node-${index % 2}`,
        containers: [
          {
            name: service,
            image: images[service] ?? service,
            ports: [{ containerPort: 6400 + index }],
          },
        ],
      },
      status: {
        podIP: `10.0.0.${index + 1}`,
        containerStatuses: [
          { name: service, ready: true, imageID: images[service] ?? service },
        ],
      },
    }),
  );
  const policies = new Map([
    [
      'default-deny',
      {
        metadata: {
          name: 'default-deny',
          uid: 'policy-original',
          namespace: project,
        },
        spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] },
      },
    ],
  ]);
  let clock = 0;
  const created = [];
  const failures = [];
  const kube = async (args, input, options) => {
    if (options) assert.ok(options.timeout > 0 && options.timeout <= 30000);
    if (args[0] === 'get' && args[1] === 'networkpolicy')
      return policies.has(args[2]) ? JSON.stringify(policies.get(args[2])) : '';
    if (args[0] === 'get' && args[1] === 'networkpolicies')
      return JSON.stringify({ items: [...policies.values()] });
    if (args[0] === 'get' && args[1] === 'nodes')
      return JSON.stringify({
        items: [0, 1].map((index) => ({
          metadata: { name: `node-${index}` },
          status: { nodeInfo: { kubeletVersion: 'fixture' } },
        })),
      });
    if (args[0] === 'get' && args[1] === 'pods' && args.includes('kube-system'))
      return JSON.stringify({
        items: [0, 1].map((index) => ({
          metadata: { name: `kindnet-${index}` },
          spec: {
            nodeName: `node-${index}`,
            containers: [{ name: 'kindnet', image: 'kindnet-fixture' }],
          },
          status: {
            containerStatuses: [
              {
                name: 'kindnet',
                imageID: 'kindnet-fixture-digest',
                ready: true,
              },
            ],
          },
        })),
      });
    if (args[0] === 'get' && args[1] === 'pods')
      return JSON.stringify({ items: pods });
    if (args[0] === 'create') {
      const policy = JSON.parse(input);
      assert.equal(policy.metadata.namespace, project);
      assert.ok(!policies.has(policy.metadata.name));
      const direction = policy.spec.policyTypes[0].toLowerCase();
      assert.equal(policy.spec[direction].length, 1);
      const peer =
        policy.spec[direction][0][direction === 'egress' ? 'to' : 'from'][0];
      assert.equal(
        peer.namespaceSelector.matchLabels['kubernetes.io/metadata.name'],
        project,
      );
      assert.ok(
        ['workers', 'redis', 'kestra'].includes(
          peer.podSelector.matchLabels['app.kubernetes.io/name'],
        ),
      );
      if (mode === 'missing-create' && created.length === 1)
        throw new Error('Synthetic rejected creation.');
      if (mode === 'foreign-create' && created.length === 1)
        policy.metadata.labels['campus-commander/qualification-control'] =
          'foreign-owner';
      created.push(policy.metadata.name);
      policies.set(policy.metadata.name, policy);
      if (
        ['ambiguous-create', 'foreign-create'].includes(mode) &&
        created.length === 2
      )
        throw new Error('Synthetic lost creation response.');
      return '{}';
    }
    if (args[0] === 'delete') {
      assert.ok(created.includes(args[2]));
      policies.delete(args[2]);
      return '';
    }
    if (args[0] === 'exec') {
      const { host, port } = JSON.parse(input);
      const target = pods.find((pod) => pod.status.podIP === host);
      assert.equal(target.spec.containers[0].ports[0].containerPort, port);
      const allowed = policies.size === 3;
      const api = args[2].startsWith('api-');
      const outcome =
        mode === 'unavailable'
          ? 'socket-error'
          : mode === 'allow-failure' && allowed && !api
            ? 'socket-error'
            : api || allowed || mode === 'unenforced'
              ? 'connected'
              : 'timeout';
      clock += mode === 'late-success' && allowed ? 40000 : 1000;
      return JSON.stringify({
        outcome,
        durationMs: outcome === 'timeout' ? 2000 : 1,
      });
    }
    assert.fail('Unexpected fixture command.');
  };
  return {
    policies,
    created,
    failures,
    run: () =>
      qualifyKubernetesNetworkPolicies({
        kube,
        project,
        images,
        onFailure: async (report) => failures.push(report),
        now: () => clock,
        delay: async (ms) => {
          clock += ms;
        },
      }),
  };
}

test('policy proof requires denial, narrow allowance, and denial on both worker nodes', async () => {
  const state = fixture();
  const report = await state.run();
  assert.equal(report.status, 'passed');
  for (const service of ['redis', 'kestra']) {
    for (const stage of ['denied-before', 'allowed-control', 'denied-after']) {
      const observed = report.observations.filter(
        (item) => item.stage === `${service}:${stage}`,
      );
      assert.equal(observed.length, 2);
      assert.equal(new Set(observed.map((item) => item.source.node)).size, 2);
      assert.ok(
        observed.every(
          (item) =>
            item.outcome ===
            (stage === 'allowed-control' ? 'connected' : 'timeout'),
        ),
      );
    }
  }
  assert.equal(state.created.length, 4);
  assert.deepEqual([...state.policies.keys()], ['default-deny']);
});

for (const mode of ['unenforced', 'unavailable', 'allow-failure'])
  test(`policy proof rejects ${mode} and removes temporary policies`, async () => {
    const state = fixture(mode);
    await assert.rejects(state.run());
    assert.equal(state.failures.length, 1);
    assert.equal(state.failures[0].status, 'failed');
    assert.equal(state.failures[0].limits.length, 2);
    assert.match(state.failures[0].limits[0], /TCP pod paths only/);
    assert.ok(state.failures[0].observations.length > 0);
    assert.deepEqual([...state.policies.keys()], ['default-deny']);
    assert.equal(state.created.length, mode === 'allow-failure' ? 2 : 0);
  });

for (const mode of ['ambiguous-create', 'missing-create', 'late-success'])
  test(`policy proof rejects ${mode} without retaining an allowance`, async () => {
    const state = fixture(mode);
    await assert.rejects(state.run());
    assert.deepEqual([...state.policies.keys()], ['default-deny']);
    assert.equal(state.failures.length, 1);
  });

test('policy cleanup preserves a resource with a different ownership marker', async () => {
  const state = fixture('foreign-create');
  await assert.rejects(state.run());
  assert.equal(state.policies.size, 2);
  assert.ok(
    [...state.policies.values()].some(
      (policy) =>
        policy.metadata.labels?.['campus-commander/qualification-control'] ===
        'foreign-owner',
    ),
  );
});
