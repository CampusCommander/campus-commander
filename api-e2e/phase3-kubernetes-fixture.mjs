import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Inspect actual key consumers without returning private bytes. */
export async function verifyKubernetesCredentialProjection({
  kube,
  root,
  project,
  images,
}) {
  assert.match(project, /^cc-capacity-kube-[a-f0-9]{12}$/);
  assert.ok(root.startsWith(`/tmp/${project}-`));
  const config = JSON.parse(
    await readFile(join(root, 'runtime/config.json'), 'utf8'),
  );
  assert.equal(config.phase, 3);
  const { keyId, encryptionKeySecretRef: ref } = config.googleConnection;
  assert.equal(ref.provider, 'kubernetes');
  const expected = await readFile(
    join(root, 'installer/private', ref.name, ref.key),
  );
  const pods = JSON.parse(
    await kube(['get', 'pods', '-o', 'json']),
  ).items.filter((pod) => !pod.metadata.deletionTimestamp);
  const observations = [];
  const consumers = [];
  for (const pod of pods) {
    const service = pod.metadata.labels?.['app.kubernetes.io/name'];
    const volumes = (pod.spec.volumes ?? []).filter(
      (volume) => volume.secret?.secretName === ref.name,
    );
    if (!['api', 'workers'].includes(service)) {
      assert.equal(
        volumes.length,
        0,
        'Unrelated pods must not receive the Google credential key.',
      );
      continue;
    }
    assert.equal(volumes.length, 1);
    assert.equal(volumes[0].secret.defaultMode, 0o440);
    for (const other of [
      ...pod.spec.containers,
      ...(pod.spec.initContainers ?? []),
    ])
      if (other.name !== service)
        assert.ok(
          !(other.volumeMounts ?? []).some(
            (mount) => mount.name === volumes[0].name,
          ),
          'Unrelated containers must not mount the Google credential key.',
        );
    const container = pod.spec.containers.find((item) => item.name === service);
    assert.equal(container.image, images[service]);
    const status = pod.status.containerStatuses.find(
      (item) => item.name === service,
    );
    assert.equal(status.ready, true);
    assert.ok(status.imageID.endsWith(images[service].split('@')[1]));
    const mount = container.volumeMounts.find(
      (item) => item.name === volumes[0].name,
    );
    assert.equal(mount.readOnly, true);
    const observed = JSON.parse(
      await kube(
        [
          'exec',
          '-i',
          pod.metadata.name,
          '--container',
          service,
          '--',
          'node',
          '--input-type=module',
          '-e',
          `import fs from 'node:fs';const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const input=JSON.parse(Buffer.concat(chunks));const bytes=fs.readFileSync(input.path),expected=Buffer.from(input.expected,'base64');
const stat=fs.statSync(input.path),config=JSON.parse(fs.readFileSync(process.env.CC_CONFIG_FILE));console.log(JSON.stringify({matches:bytes.equals(expected),mode:stat.mode&0o777,keyId:config.googleConnection.keyId}));bytes.fill(0);expected.fill(0);`,
        ],
        JSON.stringify({
          path: join(mount.mountPath, ref.key),
          expected: expected.toString('base64'),
        }),
      ),
    );
    assert.equal(observed.keyId, keyId);
    assert.equal(observed.matches, true);
    assert.equal(observed.mode, 0o440);
    consumers.push(service);
    observations.push({
      service,
      pod: pod.metadata.name,
      node: pod.spec.nodeName,
      keyId,
      readOnly: true,
      ...observed,
    });
  }
  expected.fill(0);
  assert.equal(consumers.filter((service) => service === 'api').length, 2);
  assert.equal(consumers.filter((service) => service === 'workers').length, 2);
  assert.equal(
    new Set(
      observations
        .filter((item) => item.service === 'workers')
        .map((item) => item.node),
    ).size,
    2,
  );
  return { status: 'passed', observations, unrelatedPodsExcludeKey: true };
}
