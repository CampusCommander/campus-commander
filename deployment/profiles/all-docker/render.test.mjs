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
