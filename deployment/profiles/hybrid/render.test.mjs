import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { renderHybrid, renderWorkerHost } from './render.mjs';

const config = JSON.parse(
  await readFile(
    new URL('../../examples/hybrid.json', import.meta.url),
    'utf8',
  ),
);
const release = {
  schemaVersion: 1,
  platform: 'linux/amd64',
  images: config.images,
};
const mounted = (compose, name) =>
  new Set(
    compose.services['runtime-files'].command[2]
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('cp ') && line.includes(`'/staged/${name}-secrets/`),
      )
      .map((line) => line.match(/^cp '\/run\/secrets\/([^']+)'/)[1]),
  );

test('renders a placement-aware controller with verified TLS', () => {
  const compose = renderHybrid(config, release);
  for (const name of [
    'application-postgres',
    'kestra-postgres',
    'redis',
    'redis-config',
    'database-provision',
    'kestra-config',
    'workers',
    'volume-permissions',
  ]) {
    assert.equal(name in compose.services, false);
  }
  assert.equal(compose.services.api.environment.TLS_SERVER_NAME, 'api');
  assert.equal(compose.services.api.healthcheck, undefined);
  assert.equal(compose.services.frontend.healthcheck, undefined);
  assert.match(
    compose.services.edge.healthcheck.test.at(-1),
    /hostname:'127\.0\.0\.1'.*servername:host.*timeout:3000/,
  );
  assert.doesNotMatch(
    compose.services.edge.healthcheck.test.at(-1),
    /edge-certificate/,
  );
  assert.equal(compose.networks.internal.internal, true);
  assert.equal(compose.networks.ingress.internal, undefined);
  assert.equal(compose.networks.egress.driver, 'bridge');
  assert.equal(
    compose.services.api.volumes.find(
      (mount) =>
        mount.type === 'bind' && mount.source === config.artifacts.location,
    ).target,
    config.artifacts.location,
  );
  assert.equal(
    compose.services['storage-preflight'].command[2].includes('chown'),
    false,
  );
  assert.ok(
    compose.services.kestra.volumes.includes(
      'kestra-runtime-files:/run/kestra-runtime:ro',
    ),
  );
  assert.equal(
    Object.values(compose.services).some((service) => 'build' in service),
    false,
  );
});

test('uses the endpoint private CA for the edge health check', () => {
  const privateEdge = structuredClone(config);
  privateEdge.services.edge.endpoint.tls = {
    mode: 'private-ca',
    caSecretRef: { provider: 'file', path: '/run/secrets/district-ca' },
  };
  const compose = renderHybrid(privateEdge, release);
  assert.match(
    compose.services.edge.healthcheck.test.at(-1),
    /ca:fs\.readFileSync\('\/run\/secrets\/district-ca'\)/,
  );
  assert.equal(mounted(compose, 'edge').has('district-ca'), true);
});

test('mounts only credentials required by each process', () => {
  const compose = renderHybrid(config, release);
  assert.deepEqual(
    mounted(compose, 'frontend'),
    new Set(['frontend-certificate', 'frontend-private-key', 'district-ca']),
  );
  assert.deepEqual(
    mounted(compose, 'edge'),
    new Set(['edge-certificate', 'edge-private-key', 'district-ca']),
  );
  assert.equal(mounted(compose, 'api').has('bootstrap'), false);
  assert.equal(mounted(compose, 'api').has('worker-dispatch'), false);
  assert.deepEqual(
    mounted(compose, 'database-migrate'),
    new Set(['postgres-migrator', 'district-ca']),
  );
});

test('renders one district-bound worker fragment for each host', () => {
  const first = renderWorkerHost(config, release, {
    hostIndex: 0,
    bindAddress: '10.20.30.41',
  });
  const second = renderWorkerHost(config, release, {
    hostIndex: 1,
    bindAddress: '10.20.30.42',
  });
  assert.equal(first.name, 'campus-commander-worker-1');
  assert.equal(second.name, 'campus-commander-worker-2');
  assert.deepEqual(first.services.workers.ports, ['10.20.30.41:3001:3001']);
  assert.deepEqual(first.services.workers.networks, ['egress']);
  assert.equal(first.services.workers.environment.REQUIRE_TLS, 'true');
  assert.equal(first.services.workers.healthcheck, undefined);
  assert.equal(
    first.services.workers.volumes.find(
      (mount) =>
        mount.type === 'bind' && mount.source === config.artifacts.location,
    ).target,
    config.artifacts.location,
  );
  assert.deepEqual(
    mounted(first, 'workers'),
    new Set([
      'worker-dispatch',
      'workers-certificate',
      'workers-private-key',
      'campus-database-password',
      'district-ca',
    ]),
  );
});

test('removes an externally owned Kestra workload', () => {
  const external = structuredClone(config);
  external.services.kestra.placement = {
    kind: 'external',
    operator: 'district-platform',
  };
  external.services.kestra.internalStorage = {
    kind: 'external-managed',
    location: '/var/lib/campus-commander/kestra-district',
    capacityGiB: 10,
    operator: 'district-platform',
  };
  delete external.services.kestra.serverTls;
  const compose = renderHybrid(external, release);
  assert.equal('kestra' in compose.services, false);
  assert.equal('kestra-config' in compose.services, false);
  assert.equal('kestra' in compose.services.api.depends_on, false);
});

test('keeps a selected local Redis service and TLS material', () => {
  const localRedis = structuredClone(config);
  localRedis.services.redis.placement = {
    kind: 'local',
    replicas: 1,
    resources: {
      cpuRequestMillis: 100,
      cpuLimitMillis: 500,
      memoryRequestMiB: 128,
      memoryLimitMiB: 512,
    },
  };
  localRedis.services.redis.persistence = {
    kind: 'shared-filesystem',
    location: '/var/lib/campus-commander/redis-runtime',
    capacityGiB: 1,
    operator: 'district-storage',
  };
  localRedis.services.redis.serverTls = {
    certificateSecretRef: {
      provider: 'file',
      path: '/run/secrets/redis-certificate',
    },
    privateKeySecretRef: {
      provider: 'file',
      path: '/run/secrets/redis-private-key',
    },
  };
  const compose = renderHybrid(localRedis, release);
  assert.ok(compose.services.redis);
  assert.ok(compose.services['redis-config']);
  assert.equal(mounted(compose, 'redis').has('redis-certificate'), true);
  assert.equal(mounted(compose, 'redis').has('redis-private-key'), true);
});

test('keeps a supported local PostgreSQL pair on one host', () => {
  const localDatabases = structuredClone(config);
  localDatabases.host.workerHosts = 1;
  localDatabases.services.workers.placement.replicas = 1;
  for (const [name, host] of [
    ['applicationDatabase', 'application-postgres'],
    ['kestraDatabase', 'kestra-postgres'],
  ]) {
    const database = localDatabases.services[name];
    database.placement = {
      kind: 'local',
      replicas: 1,
      resources: {
        cpuRequestMillis: 250,
        cpuLimitMillis: 1000,
        memoryRequestMiB: 512,
        memoryLimitMiB: 1024,
      },
    };
    database.endpoint.url = `postgresql://${host}:5432`;
    database.persistence = {
      kind: 'local-volume',
      location: `/var/lib/campus-commander/${host}`,
      capacityGiB: 10,
      operator: 'application-installer',
    };
    database.serverTls = {
      certificateSecretRef: {
        provider: 'file',
        path: `/run/secrets/${host}-certificate`,
      },
      privateKeySecretRef: {
        provider: 'file',
        path: `/run/secrets/${host}-private-key`,
      },
    };
  }
  const compose = renderHybrid(localDatabases, release);
  assert.ok(compose.services['application-postgres']);
  assert.ok(compose.services['kestra-postgres']);
  assert.ok(compose.services['database-provision']);
  assert.ok(compose.services.workers);
  assert.match(compose.services['application-postgres'].command[0], /ssl=on/);
});

test('rejects unsafe or incomplete distributed worker layouts', () => {
  assert.throws(
    () =>
      renderWorkerHost(config, release, {
        hostIndex: 0,
        bindAddress: '0.0.0.0',
      }),
    /district interface/,
  );
  assert.throws(
    () =>
      renderWorkerHost(config, release, {
        hostIndex: 2,
        bindAddress: '10.20.30.43',
      }),
    /outside the declared host count/,
  );
  const replicaMismatch = structuredClone(config);
  replicaMismatch.services.workers.placement.replicas = 3;
  assert.throws(
    () => renderHybrid(replicaMismatch, release),
    /one worker replica per declared worker host/,
  );
});

test('controller and remote workers stage private files before nonroot startup', () => {
  const controller = renderHybrid(config, release);
  const worker = renderWorkerHost(config, release, {
    hostIndex: 0,
    bindAddress: '10.20.30.41',
  });
  for (const [compose, consumers] of [
    [
      controller,
      [
        'frontend',
        'api',
        'edge',
        'kestra',
        'database-migrate',
        'bootstrap-initialize',
      ],
    ],
    [worker, ['workers']],
  ]) {
    const initializer = compose.services['runtime-files'];
    assert.ok(
      initializer,
      'A root initializer must stage private source files',
    );
    assert.equal(initializer.user, '0:0');
    assert.equal(initializer.read_only, true);
    assert.deepEqual(initializer.cap_add, ['CHOWN', 'DAC_OVERRIDE', 'FOWNER']);
    assert.ok(
      initializer.volumes
        .filter((mount) => typeof mount === 'object')
        .every(
          (mount) => mount.read_only && mount.bind.create_host_path === false,
        ),
    );
    for (const name of consumers) {
      const service = compose.services[name];
      assert.equal(service.user, '1000:1000');
      assert.equal(service.secrets, undefined);
      assert.equal(
        service.depends_on['runtime-files'].condition,
        'service_completed_successfully',
      );
      assert.ok(
        service.volumes.every(
          (mount) =>
            typeof mount === 'string' || !mount.target.startsWith('/run/'),
        ),
      );
    }
  }
  assert.ok(
    controller.services.kestra.volumes.includes(
      'kestra-runtime-files:/run/kestra-runtime:ro',
    ),
  );
  assert.ok(
    controller.services.api.volumes.some(
      (mount) =>
        mount.type === 'bind' &&
        mount.source === config.artifacts.location &&
        mount.target === config.artifacts.location,
    ),
  );
  assert.ok(
    worker.services.workers.volumes.some(
      (mount) =>
        mount.type === 'bind' &&
        mount.source === config.artifacts.location &&
        mount.target === config.artifacts.location,
    ),
  );
  assert.deepEqual(worker.services.workers.ports, ['10.20.30.41:3001:3001']);
  assert.deepEqual(worker.services.workers.networks, ['egress']);
  assert.deepEqual(worker.services['runtime-files'].networks, ['egress']);
  assert.equal(controller.networks.internal.internal, true);
});
