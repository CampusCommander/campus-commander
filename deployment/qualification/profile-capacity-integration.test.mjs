import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundedCapacityCompose,
  verifyBoundedFilesystem,
  verifyOwnedVolume,
} from './profile-capacity-integration.mjs';

function fixture() {
  return {
    name: 'campus-commander',
    services: {
      api: {
        volumes: ['artifacts:/var/lib/campus-commander/artifacts'],
      },
      workers: {
        volumes: ['artifacts:/var/lib/campus-commander/artifacts'],
      },
      edge: { ports: ['443:8443'] },
      'volume-permissions': { volumes: ['artifacts:/artifacts'] },
    },
    volumes: { artifacts: {}, other: {} },
  };
}

const project = 'cc-fault-capacity-profile-012345abcdef';

test('preserves shared mounts and caps the artifact volume', () => {
  const compose = boundedCapacityCompose(fixture(), project, 24443);
  assert.equal(
    compose.volumes.artifacts.driver_opts.o,
    'size=16m,uid=1000,gid=1000,mode=0700',
  );
  assert.equal(compose.volumes.artifacts.driver_opts.type, 'tmpfs');
  assert.deepEqual(compose.services.edge.ports, ['127.0.0.1:24443:8443']);
  assert.deepEqual(compose.services.api.logging, {
    driver: 'json-file',
    options: { 'max-size': '1m', 'max-file': '1' },
  });
  assert.equal(
    compose.services.api.volumes[0],
    'artifacts:/var/lib/campus-commander/artifacts',
  );
  assert.equal(compose.volumes.other.labels['campus-commander.owner'], project);
});

test('rejects projects and volumes outside the fixture boundary', () => {
  assert.throws(
    () => boundedCapacityCompose(fixture(), 'campus-commander', 24443),
    /unique owned project/,
  );
  const external = fixture();
  external.volumes.artifacts = { external: true };
  assert.throws(
    () => boundedCapacityCompose(external, project, 24443),
    /rendered volume/,
  );
  const bind = fixture();
  bind.services.api.volumes = [
    {
      type: 'bind',
      source: '/tmp/unowned',
      target: '/var/lib/campus-commander/artifacts',
    },
  ];
  assert.throws(
    () => boundedCapacityCompose(bind, project, 24443),
    /share the rendered artifact mount/,
  );
});

test('requires every ownership label before volume removal', () => {
  const volume = {
    Name: `${project}_artifacts`,
    Labels: {
      'com.docker.compose.project': project,
      'com.docker.compose.volume': 'artifacts',
      'campus-commander.test': 'bounded-profile-capacity',
      'campus-commander.owner': project,
      'campus-commander.volume': 'artifacts',
    },
  };
  assert.equal(verifyOwnedVolume(volume, project, 'artifacts'), volume.Name);
  delete volume.Labels['campus-commander.owner'];
  assert.throws(
    () => verifyOwnedVolume(volume, project, 'artifacts'),
    /Refusing to remove/,
  );
});

test('requires the Linux tmpfs type and sixteen MiB capacity bound', () => {
  const observation = {
    filesystemType: 0x01021994,
    totalBytes: 16 * 1024 * 1024,
    availableBytesAfter: 0,
  };
  assert.equal(verifyBoundedFilesystem(observation), observation);
  assert.throws(
    () =>
      verifyBoundedFilesystem({
        ...observation,
        filesystemType: 0xef53,
      }),
    /bounded tmpfs/,
  );
  assert.throws(
    () =>
      verifyBoundedFilesystem({
        ...observation,
        totalBytes: 17 * 1024 * 1024,
      }),
    /bounded tmpfs/,
  );
});
