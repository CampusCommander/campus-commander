import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareHybrid } from './prepare.mjs';

const example = JSON.parse(
  await readFile(
    new URL('../../examples/hybrid.json', import.meta.url),
    'utf8',
  ),
);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cc-hybrid-prepare-'));
  const privateRoot = join(root, 'private');
  const storageRoot = join(root, 'kestra-internal');
  await mkdir(privateRoot, { mode: 0o700 });
  await mkdir(storageRoot, { mode: 0o700 });
  const protectedValues = {
    bootstrap: 'existing-bootstrap-credential-1234567890',
    'district-ca': 'test-private-ca-material-1234567890',
    'kestra-certificate': 'test-server-certificate-1234567890',
    'kestra-database-password': 'test-database-password-1234567890',
    'kestra-private-key': 'test-server-private-key-1234567890',
  };
  for (const [name, value] of Object.entries(protectedValues)) {
    await writeFile(join(privateRoot, name), value, { mode: 0o600 });
  }
  const config = structuredClone(example);
  config.services.kestra.internalStorage.location = storageRoot;
  const configPath = join(root, 'profile.json');
  await writeFile(configPath, JSON.stringify(config));
  return { config, configPath, root };
}

async function fakeRenderer(environment) {
  assert.equal(environment.CC_KESTRA_PROFILE, 'hybrid');
  assert.equal(environment.CC_KESTRA_RUNTIME_MOUNT_PATH, '/run/kestra-runtime');
  assert.equal(environment.CC_KESTRA_TLS_ENABLED, 'true');
  assert.equal(environment.CC_KESTRA_WORKER_BASE_URL, 'https://workers:3001');
  assert.equal(
    environment.CC_KESTRA_DATABASE_URL,
    'jdbc:postgresql://postgres.district.example.org:5432/kestra?sslmode=verify-full&sslrootcert=/run/kestra-runtime/database-ca.pem',
  );
  for (const name of [
    'application.yaml',
    'flow-secrets.env',
    'probe-header',
    'runtime-environment.json',
    'server.p12',
    'worker-truststore.p12',
  ]) {
    await writeFile(join(environment.CC_KESTRA_RUNTIME_DIR, name), name, {
      mode: 0o600,
    });
  }
}

test('prepares protected runtime files and preserves credentials', async () => {
  const { configPath, root } = await fixture();
  const commands = [];
  const run = async (file, args) => commands.push([file, args]);

  const first = await prepareHybrid(configPath, root, {
    run,
    render: fakeRenderer,
  });
  const bootstrapBefore = await readFile(join(root, 'private', 'bootstrap'));
  const second = await prepareHybrid(configPath, root, {
    run,
    render: fakeRenderer,
  });

  assert.equal(first.profile, 'hybrid');
  assert.equal(first.kestraPlacement, 'local');
  assert.equal(first.databasePlacement, 'external');
  assert.equal(first.externalDatabase, true);
  assert.equal(commands.length, 8);
  assert.equal(commands[0][0], process.execPath);
  assert.equal(commands[1][0], 'openssl');
  assert.equal(commands[2][0], 'keytool');
  assert.ok(first.secrets.some(({ status }) => status === 'created'));
  assert.ok(second.secrets.every(({ status }) => status === 'preserved'));
  assert.deepEqual(
    await readFile(join(root, 'private', 'bootstrap')),
    bootstrapBefore,
  );
  assert.deepEqual(
    await readFile(join(root, 'runtime', 'kestra', 'database-ca.pem')),
    await readFile(join(root, 'private', 'district-ca')),
  );
  assert.deepEqual(
    await readFile(join(root, 'runtime', 'kestra', 'server-ca.pem')),
    await readFile(join(root, 'private', 'district-ca')),
  );
  assert.equal(
    (await stat(join(root, 'runtime', 'kestra'))).mode & 0o777,
    0o700,
  );
  for (const name of first.runtimeFiles) {
    assert.equal(
      (await stat(join(root, 'runtime', 'kestra', name))).mode & 0o777,
      0o600,
    );
  }
});

test('fails before rendering when a required tool is absent', async () => {
  const { configPath, root } = await fixture();
  const run = async (file) => {
    if (file === 'openssl') throw new Error('missing');
  };
  await assert.rejects(
    prepareHybrid(configPath, root, { run, render: fakeRenderer }),
    /OpenSSL is required/,
  );
});

test('rejects an external Kestra placement', async () => {
  const { config, root } = await fixture();
  config.services.kestra.placement = {
    kind: 'external',
    operator: 'district-platform',
  };
  config.services.kestra.internalStorage = {
    ...config.services.kestra.internalStorage,
    kind: 'external-managed',
  };
  delete config.services.kestra.serverTls;
  const configPath = join(root, 'external-kestra.json');
  await writeFile(configPath, JSON.stringify(config));
  await assert.rejects(
    prepareHybrid(configPath, root, { render: fakeRenderer }),
    /requires a local Kestra service/,
  );
});

test('supports paired local PostgreSQL services on one host', async () => {
  const { config, root } = await fixture();
  config.host.workerHosts = 1;
  config.services.workers.placement.replicas = 1;
  for (const name of ['applicationDatabase', 'kestraDatabase']) {
    const service = config.services[name];
    service.placement = {
      kind: 'local',
      replicas: 1,
      resources: {
        cpuRequestMillis: 250,
        cpuLimitMillis: 1000,
        memoryRequestMiB: 512,
        memoryLimitMiB: 1024,
      },
    };
    service.persistence = {
      kind: 'local-volume',
      location: join(root, `${name}-data`),
      capacityGiB: 10,
      operator: 'district-platform',
    };
    service.serverTls = {
      certificateSecretRef: {
        provider: 'file',
        path: '/run/secrets/kestra-certificate',
      },
      privateKeySecretRef: {
        provider: 'file',
        path: '/run/secrets/kestra-private-key',
      },
    };
  }
  const configPath = join(root, 'local-databases.json');
  await writeFile(configPath, JSON.stringify(config));
  const result = await prepareHybrid(configPath, root, {
    run: async () => undefined,
    render: fakeRenderer,
  });
  assert.equal(result.databasePlacement, 'local');
  assert.equal(result.externalDatabase, false);
});

test('preserves running TLS material on resume and regenerates changed or damaged runtime files', async () => {
  const { configPath, root } = await fixture();
  let generation = 0;
  const render = async (environment) => {
    await fakeRenderer(environment);
    generation++;
    await writeFile(
      join(environment.CC_KESTRA_RUNTIME_DIR, 'worker-truststore.p12'),
      `truststore-generation-${generation}`,
      { mode: 0o600 },
    );
  };
  const options = { run: async () => undefined, render };
  const first = await prepareHybrid(configPath, root, options);
  const runtime = join(root, 'runtime', 'kestra');
  const before = await Promise.all(
    first.runtimeFiles.map((name) => readFile(join(runtime, name))),
  );
  await prepareHybrid(configPath, root, options);
  assert.deepEqual(
    await Promise.all(
      first.runtimeFiles.map((name) => readFile(join(runtime, name))),
    ),
    before,
  );
  assert.equal(generation, 1);
  await writeFile(
    join(root, 'private', 'worker-dispatch'),
    'replacement-worker-credential-1234567890',
    { mode: 0o600 },
  );
  await prepareHybrid(configPath, root, options);
  assert.equal(generation, 2);
  await writeFile(join(runtime, 'worker-truststore.p12'), 'damaged', {
    mode: 0o600,
  });
  await prepareHybrid(configPath, root, options);
  assert.equal(generation, 3);
  assert.equal(
    await readFile(join(runtime, 'worker-truststore.p12'), 'utf8'),
    'truststore-generation-3',
  );
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.services.kestra.endpoint.url = 'https://kestra-next:8080';
  await writeFile(configPath, JSON.stringify(config));
  await prepareHybrid(configPath, root, options);
  assert.equal(generation, 4);
});
