import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

const label = 'app.kubernetes.io/name';
const selector = (service) => ({
  matchLabels: {
    [label]: service,
    'app.kubernetes.io/part-of': 'campus-commander',
  },
});

/** Measure internal pod policy boundaries with positive controls. */
export async function qualifyKubernetesNetworkPolicies({
  kube,
  project,
  images,
  onFailure,
  now = Date.now,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  assert.match(project, /^cc-capacity-kube-[a-f0-9]{12}$/);
  for (const service of ['api', 'workers'])
    assert.match(
      images[service],
      /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/,
    );
  const started = now();
  const observations = [];
  const controls = [];
  const limits = [
    'This report measures worker-to-Redis and worker-to-Kestra TCP pod paths only.',
    'Service-address behavior, Google egress, district TLS, and independent physical hosts require separate evidence.',
  ];
  try {
    const policies = async () => {
      const result = JSON.parse(
        await kube(['get', 'networkpolicies', '-o', 'json']),
      );
      return result.items
        .map(({ metadata, spec }) => {
          assert.equal(metadata.namespace, project);
          return {
            name: metadata.name,
            uid: metadata.uid,
            specSha256: createHash('sha256')
              .update(JSON.stringify(spec))
              .digest('hex'),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    };
    const originalPolicies = await policies();
    assert.ok(originalPolicies.some(({ name }) => name === 'default-deny'));
    const pods = JSON.parse(
      await kube(['get', 'pods', '-o', 'json']),
    ).items.filter((pod) => !pod.metadata.deletionTimestamp);
    const ready = (service) => {
      const matches = pods.filter(
        (pod) => pod.metadata.labels?.[label] === service,
      );
      for (const pod of matches) {
        assert.equal(pod.metadata.namespace, project);
        assert.equal(
          pod.metadata.labels['app.kubernetes.io/part-of'],
          'campus-commander',
        );
        assert.ok(isIP(pod.status.podIP));
        const container = pod.spec.containers.find(
          (item) => item.name === service,
        );
        const status = pod.status.containerStatuses.find(
          (item) => item.name === service,
        );
        assert.equal(status.ready, true);
        if (images[service]) {
          assert.equal(container.image, images[service]);
          assert.ok(status.imageID.endsWith(images[service].split('@')[1]));
        }
      }
      return matches;
    };
    const apis = ready('api');
    const workers = ready('workers');
    assert.equal(apis.length, 2);
    assert.equal(workers.length, 2);
    assert.equal(new Set(workers.map((pod) => pod.spec.nodeName)).size, 2);
    const identify = (pod) => ({
      pod: pod.metadata.name,
      uid: pod.metadata.uid,
      node: pod.spec.nodeName,
    });
    const budget = (deadline) => {
      const timeout = deadline - now();
      assert.ok(
        timeout > 0,
        'Network policies must converge within 30 seconds.',
      );
      return { timeout };
    };
    const connect = async (source, target, port, stage, deadline) => {
      const result = JSON.parse(
        await kube(
          [
            'exec',
            '-i',
            source.metadata.name,
            '--container',
            source.metadata.labels[label],
            '--',
            'node',
            '--input-type=module',
            '-e',
            `import net from 'node:net';const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const {host,port}=JSON.parse(Buffer.concat(chunks));const started=Date.now();
const socket=net.createConnection({host,port});let finished=false;
const finish=outcome=>{if(finished)return;finished=true;clearTimeout(timer);socket.destroy();console.log(JSON.stringify({outcome,durationMs:Date.now()-started}));};
const timer=setTimeout(()=>finish('timeout'),2000);socket.once('connect',()=>finish('connected'));socket.once('error',()=>finish('socket-error'));`,
          ],
          JSON.stringify({ host: target.status.podIP, port }),
          budget(deadline),
        ),
      );
      assert.ok(
        ['connected', 'timeout', 'socket-error'].includes(result.outcome),
      );
      assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
      observations.push({
        stage,
        source: identify(source),
        target: identify(target),
        port,
        outcome: result.outcome,
        durationMs: result.durationMs,
      });
      return result.outcome;
    };
    const assertStablePods = async (deadline) => {
      const current = JSON.parse(
        await kube(['get', 'pods', '-o', 'json'], undefined, budget(deadline)),
      ).items;
      for (const original of pods) {
        const actual = current.find(
          (pod) => pod.metadata.uid === original.metadata.uid,
        );
        assert.ok(
          actual && !actual.metadata.deletionTimestamp,
          'Policy probes require stable pod identities.',
        );
        assert.equal(actual.status.podIP, original.status.podIP);
      }
    };
    const probe = async (target, port, expected, stage) => {
      const deadline = now() + 30000;
      while (true) {
        assert.equal(
          await connect(
            apis[0],
            target,
            port,
            `${stage}:control-before`,
            deadline,
          ),
          'connected',
        );
        const results = await Promise.all(
          workers.map((worker) =>
            connect(worker, target, port, stage, deadline),
          ),
        );
        assert.equal(
          await connect(
            apis[0],
            target,
            port,
            `${stage}:control-after`,
            deadline,
          ),
          'connected',
        );
        assert.ok(
          !results.includes('socket-error'),
          'Socket errors do not prove policy denial.',
        );
        assert.ok(
          now() < deadline,
          'Network policies must converge within 30 seconds.',
        );
        if (results.every((outcome) => outcome === expected)) break;
        await delay(Math.min(500, deadline - now()));
      }
      await assertStablePods(deadline);
      budget(deadline);
    };
    for (const service of ['redis', 'kestra']) {
      const targets = ready(service);
      assert.equal(targets.length, 1);
      const target = targets[0];
      const container = target.spec.containers.find(
        (item) => item.name === service,
      );
      assert.equal(container.ports.length, 1);
      const port = container.ports[0].containerPort;
      assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
      await probe(target, port, 'timeout', `${service}:denied-before`);
      const suffix = randomBytes(6).toString('hex');
      const attempts = [];
      try {
        for (const direction of ['egress', 'ingress']) {
          const name = `qualification-${service}-${direction}-${suffix}`;
          const rule = {
            apiVersion: 'networking.k8s.io/v1',
            kind: 'NetworkPolicy',
            metadata: {
              name,
              namespace: project,
              labels: { 'campus-commander/qualification-control': suffix },
            },
            spec: {
              podSelector: selector(
                direction === 'egress' ? 'workers' : service,
              ),
              policyTypes: [direction === 'egress' ? 'Egress' : 'Ingress'],
              [direction]: [
                {
                  [direction === 'egress' ? 'to' : 'from']: [
                    {
                      namespaceSelector: {
                        matchLabels: { 'kubernetes.io/metadata.name': project },
                      },
                      podSelector: selector(
                        direction === 'egress' ? service : 'workers',
                      ),
                    },
                  ],
                  ports: [{ protocol: 'TCP', port }],
                },
              ],
            },
          };
          attempts.push(rule);
          controls.push({ name, spec: rule.spec, removed: false });
          await kube(['create', '-f', '-'], JSON.stringify(rule), {
            timeout: 15000,
          });
        }
        await probe(target, port, 'connected', `${service}:allowed-control`);
      } finally {
        const cleanup = await Promise.allSettled(
          attempts.map(async (rule) => {
            const name = rule.metadata.name;
            const text = await kube(
              [
                'get',
                'networkpolicy',
                name,
                '--ignore-not-found=true',
                '-o',
                'json',
              ],
              undefined,
              { timeout: 15000 },
            );
            if (!text.trim()) {
              controls.find((item) => item.name === name).removed = true;
              return;
            }
            const actual = JSON.parse(text);
            assert.equal(actual.metadata.namespace, project);
            assert.equal(
              actual.metadata.labels?.[
                'campus-commander/qualification-control'
              ],
              suffix,
            );
            assert.deepEqual(actual.spec, rule.spec);
            await kube(
              [
                'delete',
                'networkpolicy',
                name,
                '--wait=true',
                '--ignore-not-found=true',
              ],
              undefined,
              { timeout: 15000 },
            );
            controls.find((item) => item.name === name).removed = true;
          }),
        );
        assert.ok(
          cleanup.every((result) => result.status === 'fulfilled'),
          'Remove every temporary control policy.',
        );
      }
      await probe(target, port, 'timeout', `${service}:denied-after`);
      assert.deepEqual(await policies(), originalPolicies);
    }
    const nodes = JSON.parse(await kube(['get', 'nodes', '-o', 'json'])).items;
    const cni = JSON.parse(
      await kube([
        'get',
        'pods',
        '-n',
        'kube-system',
        '-l',
        'app=kindnet',
        '-o',
        'json',
      ]),
    ).items;
    assert.equal(cni.length, nodes.length);
    assert.deepEqual(
      cni.map((pod) => pod.spec.nodeName).sort(),
      nodes.map((node) => node.metadata.name).sort(),
    );
    for (const pod of cni)
      assert.ok(
        pod.status.containerStatuses.every(
          (container) => container.ready && container.imageID,
        ),
      );
    return {
      status: 'passed',
      durationMs: now() - started,
      originalPolicies,
      controls,
      observations,
      convergenceBoundMs: 30000,
      socketTimeoutMs: 2000,
      nodes: nodes.map(({ metadata, status }) => ({
        name: metadata.name,
        kubeletVersion: status.nodeInfo.kubeletVersion,
        kernelVersion: status.nodeInfo.kernelVersion,
        containerRuntimeVersion: status.nodeInfo.containerRuntimeVersion,
        osImage: status.nodeInfo.osImage,
        operatingSystem: status.nodeInfo.operatingSystem,
        architecture: status.nodeInfo.architecture,
      })),
      cni: cni.map(({ metadata, spec, status }) => ({
        pod: metadata.name,
        node: spec.nodeName,
        images: spec.containers.map((container) => ({
          name: container.name,
          image: container.image,
          imageID: status.containerStatuses.find(
            (item) => item.name === container.name,
          ).imageID,
        })),
      })),
      limits,
    };
  } catch (error) {
    await onFailure?.({
      status: 'failed',
      durationMs: now() - started,
      observations,
      controls,
      limits,
      error: 'Kubernetes network-policy qualification failed.',
    });
    throw new Error('Kubernetes network-policy qualification failed.', {
      cause: error,
    });
  }
}
