import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { effectiveConfig, renderAllDocker } from './render.mjs';

const config = JSON.parse(
  await readFile(
    new URL('../../examples/all-docker.json', import.meta.url),
    'utf8',
  ),
);
const release = {
  schemaVersion: 1,
  platform: 'linux/amd64',
  images: config.images,
};

test('renders a pinned all-Docker profile without build instructions', () => {
  const compose = renderAllDocker(config, release);
  assert.equal(
    Object.values(compose.services).some((service) => 'build' in service),
    false,
  );
  assert.deepEqual(compose.services.edge.ports, ['443:8443']);
  assert.equal(
    Object.values(compose.services).filter((service) => service.ports).length,
    1,
  );
  assert.equal(
    compose.services['application-postgres'].volumes[0],
    'application-postgres:/var/lib/postgresql',
  );
  assert.equal(
    compose.services['kestra-postgres'].volumes[0],
    'kestra-postgres:/var/lib/postgresql',
  );
  assert.equal('redis' in compose.volumes, false);
  assert.equal(
    compose.services['database-migrate'].depends_on['database-provision']
      .condition,
    'service_completed_successfully',
  );
  assert.equal(
    compose.services.api.depends_on['bootstrap-initialize'].condition,
    'service_completed_successfully',
  );
  assert.equal(compose.services.api.deploy.resources.limits.memory, '512M');
  assert.equal(
    compose.services['application-postgres'].deploy.resources.reservations.cpus,
    '0.25',
  );
  for (const image of [
    compose.services.frontend.image,
    compose.services.api.image,
    compose.services.workers.image,
  ])
    assert.match(image, /@sha256:[a-f0-9]{64}$/);
});

test('rejects mutable release references', () => {
  assert.throws(
    () =>
      renderAllDocker(config, {
        ...release,
        images: { ...release.images, api: 'example/api:latest' },
      }),
    /repository digests/,
  );
});

test('accepts the release inventory architectures contract', () => {
  assert.doesNotThrow(() =>
    renderAllDocker(config, {
      schemaVersion: 1,
      architectures: ['linux/amd64'],
      sourceRevision: 'fixture',
      images: release.images,
    }),
  );
});

test('normalizes runtime images without mutating operator input', () => {
  const original = structuredClone(config.images);
  const effective = effectiveConfig(config, release);
  assert.deepEqual(effective.images, release.images);
  assert.deepEqual(config.images, original);
});

test('stages private files per service without inheriting the installer identity', () => {
  const compose = renderAllDocker(config, release);
  const initializer = compose.services['volume-permissions'];
  assert.equal(initializer.user, '0:0');
  assert.equal(initializer.read_only, true);
  assert.deepEqual(initializer.cap_add, ['CHOWN', 'DAC_OVERRIDE', 'FOWNER']);
  for (const [name, service] of Object.entries(compose.services)) {
    if (name === 'volume-permissions' || name.endsWith('-postgres')) continue;
    assert.equal(service.user, '1000:1000');
    assert.equal(service.secrets, undefined);
    assert.equal(
      service.volumes.some((mount) => typeof mount === 'object'),
      false,
    );
    for (const kind of ['secrets', 'config']) {
      const volume = `${name}-${kind}`;
      if (!(volume in compose.volumes)) continue;
      assert.ok(service.volumes.includes(`${volume}:/run/${kind}:ro`));
      assert.ok(initializer.volumes.includes(`${volume}:/staged/${volume}`));
      assert.ok(
        initializer.command[2].includes(
          `chown -R 1000:1000 '/staged/${volume}'`,
        ),
      );
      assert.equal(
        service.depends_on['volume-permissions'].condition,
        'service_completed_successfully',
      );
    }
  }
  assert.ok(
    initializer.command[2].includes(
      "chmod 600 '/staged/database-migrate-secrets/postgres-migrator'",
    ),
  );
  assert.equal(
    initializer.command[2].includes('/staged/api-secrets/postgres-migrator'),
    false,
  );
  assert.equal(
    initializer.command[2].includes('/staged/workers-secrets/redis-password'),
    false,
  );
  assert.deepEqual(compose.services['database-migrate'].volumes, [
    'database-migrate-secrets:/run/secrets:ro',
    'database-migrate-config:/run/config:ro',
  ]);
});

test('private source mounts reject missing daemon paths instead of creating directories', () => {
  const compose = renderAllDocker(config, release);
  assert.equal(compose.secrets, undefined);
  for (const service of Object.values(compose.services)) {
    assert.equal(service.secrets, undefined);
    for (const mount of service.volumes ?? []) {
      if (typeof mount !== 'object' || mount.type !== 'bind') continue;
      assert.equal(mount.read_only, true);
      assert.equal(mount.bind.create_host_path, false);
    }
  }
  assert.ok(
    compose.services['volume-permissions'].volumes.some(
      (mount) =>
        mount.source === './private/redis-password' &&
        mount.target === '/run/secrets/redis-password',
    ),
  );
});

test('applies API replica counts without duplicating migration jobs', () => {
  const replicated = structuredClone(config);
  replicated.services.api.placement.replicas = 2;
  const compose = renderAllDocker(replicated, release);
  assert.equal(compose.services.api.deploy.replicas, 2);
  assert.deepEqual(
    compose.services.api.deploy.resources,
    renderAllDocker(config, release).services.api.deploy.resources,
  );
  for (const name of [
    'database-migrate',
    'bootstrap-initialize',
    'volume-permissions',
  ])
    assert.equal(compose.services[name].deploy.replicas, undefined);
});
