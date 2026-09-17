import {
  readFile,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { backupFoundation } from '../deployment/operations/index.mjs';
import { parseDeploymentConfig } from '../dist/deployment/lib/deployment.js';
import {
  createHybridRestoreConfiguration,
  prepareHybridRestoreSecrets,
} from './phase3-hybrid-restore-target.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertHybridRestoreOwnership,
  qualifyHybridRestore,
} from './phase3-hybrid-restore-fixture.mjs';
import { assertHybridRestoreSnapshot } from './phase3-hybrid-restore-state.mjs';

function owned() {
  const project = 'cc-phase3-hybrid-012345abcdef';
  const root = `/tmp/${project}-ABCDEF`;
  const hosts = {
    shared: `${root}/shared`,
    hosts: ['controller', 'worker-1', 'worker-2'].map((role) => ({
      role,
      root: `${root}/${role}`,
      daemonId: role,
    })),
  };
  return {
    hosts,
    controller: hosts.hosts[0],
    workers: hosts.hosts.slice(1),
    config: {
      phase: 3,
      profile: 'hybrid',
      artifacts: { location: `${root}/shared/artifacts` },
      services: {
        kestra: { internalStorage: { location: `${root}/shared/kestra` } },
      },
    },
    operator: {
      project,
      installationRoot: hosts.hosts[0].root,
      releaseRoot: '/release',
    },
    services: { database: `${project}-postgres`, redis: `${project}-redis` },
  };
}

test('Restore rejects foreign resources before fixture commands or writes', async () => {
  assert.doesNotThrow(() => assertHybridRestoreOwnership(owned()));
  for (const mutate of [
    (value) => {
      value.operator.project = 'production';
    },
    (value) => {
      value.controller.root += '/../production';
    },
    (value) => {
      value.workers[0].root = '/tmp/foreign/worker';
    },
    (value) => {
      value.workers[0].daemonId = value.controller.daemonId;
    },
    (value) => {
      value.hosts.shared = '/tmp/foreign/shared';
    },
    (value) => {
      value.config.artifacts.location = '/srv/artifacts';
    },
    (value) => {
      value.config.services.kestra.internalStorage.location = '/srv/kestra';
    },
    (value) => {
      value.services.database = 'production-postgres';
    },
    (value) => {
      value.services.redis = 'production-redis';
    },
    (value) => {
      value.config.phase = 2;
    },
    (value) => {
      value.operator.releaseRoot = '/workspace';
    },
  ]) {
    const value = owned();
    mutate(value);
    let called = false;
    value.hosts.run = async () => {
      called = true;
      throw new Error('Unexpected fixture command.');
    };
    await assert.rejects(qualifyHybridRestore(value), {
      code: 'ERR_ASSERTION',
    });
    assert.equal(called, false);
  }
});

function snapshots() {
  const before = {
    principals: [
      { value: { id: 'admin', preferences: { theme: 'dark' } } },
      { value: { id: 'reader', permission_version: 2 } },
    ],
    artifacts: [
      { value: { id: 'artifact', sha256: 'a'.repeat(64), size_bytes: 32 } },
    ],
    events: [{ value: { id: 'event', detail: 'original' } }],
    ledger: [{ id: '001-foundation', checksum: 'b'.repeat(64) }],
    executionRows: 1,
    executionSha256: 'c'.repeat(64),
    kestraFiles: [{ path: 'execution.json', sha256: 'd'.repeat(64) }],
    invitations: ['issued', 'pending', 'redeeming'].map((status, index) => ({
      value: {
        id: `invitation-${index}`,
        status,
        token_hash: 'private-token-hash',
        browser_hash: 'private-browser-hash',
        version: 1,
        label: status,
      },
    })),
  };
  const after = structuredClone(before);
  after.events.push({
    value: { id: 'recovery', detail: 'restore-invalidated' },
  });
  for (const row of after.invitations)
    Object.assign(row.value, {
      status: 'revoked',
      token_hash: null,
      browser_hash: null,
      version: 2,
    });
  return { before, after };
}

test('Restore evidence rejects missing or changed durable records and live admission material', () => {
  const valid = snapshots();
  assert.doesNotThrow(() =>
    assertHybridRestoreSnapshot(valid.before, valid.after),
  );
  for (const mutate of [
    ({ after }) => {
      after.principals[0].value.preferences.theme = 'light';
    },
    ({ after }) => {
      after.principals.pop();
    },
    ({ after }) => {
      after.artifacts[0].value.size_bytes++;
    },
    ({ after }) => {
      after.events.shift();
    },
    ({ after }) => {
      after.events[0].value.detail = 'changed';
    },
    ({ after }) => {
      after.events.pop();
    },
    ({ after }) => {
      after.ledger[0].checksum = 'e'.repeat(64);
    },
    ({ after }) => {
      after.executionRows = 0;
    },
    ({ after }) => {
      after.executionSha256 = 'e'.repeat(64);
    },
    ({ after }) => {
      after.kestraFiles = [];
    },
    ({ after }) => {
      after.invitations[0].value.status = 'issued';
    },
    ({ after }) => {
      after.invitations[1].value.browser_hash = 'still-live';
    },
    ({ after }) => {
      after.invitations[2].value.token_hash = 'still-live';
    },
    ({ after }) => {
      after.invitations[0].value.version = 1;
    },
    ({ after }) => {
      after.invitations[0].value.label = 'changed';
    },
    ({ before, after }) => {
      before.artifacts = [];
      after.artifacts = [];
    },
  ]) {
    const value = snapshots();
    mutate(value);
    assert.throws(() => assertHybridRestoreSnapshot(value.before, value.after));
  }
});

test('Derived restore configuration satisfies the delivered deployment contract', async () => {
  const source = JSON.parse(
    await readFile(
      new URL('../deployment/examples/hybrid.json', import.meta.url),
    ),
  );
  source.phase = 3;
  source.services.edge.access = 'application';
  source.applicationAuth = {
    issuer: 'https://identity.example.org',
    clientId: 'qualification',
    publicOrigin: 'https://campus.example.org',
    clientSecretRef: { provider: 'file', path: '/run/secrets/oidc-client' },
  };
  source.googleConnection = {
    keyId: 'restore-fixture-key',
    encryptionKeySecretRef: {
      provider: 'file',
      path: '/run/secrets/google-qualification-key',
    },
  };
  const original = structuredClone(source);
  assert.doesNotThrow(() => parseDeploymentConfig(source));
  const target = createHybridRestoreConfiguration(source, {
    databaseHostname: 'restore-postgres.fixture.test',
    redisHostname: 'restore-redis.fixture.test',
    targetDirectory: '/tmp/cc-phase3-hybrid-fixture/shared/isolated-restore',
  });
  assert.doesNotThrow(() => parseDeploymentConfig(target));
  assert.deepEqual(source, original);
  for (const name of ['applicationDatabase', 'kestraDatabase']) {
    assert.notEqual(
      target.services[name].endpoint.url,
      source.services[name].endpoint.url,
    );
    assert.notEqual(
      target.services[name].database,
      source.services[name].database,
    );
  }
  assert.notEqual(
    target.services.redis.endpoint.url,
    source.services.redis.endpoint.url,
  );
  assert.notEqual(target.artifacts.location, source.artifacts.location);
  assert.notEqual(
    target.services.kestra.internalStorage.location,
    source.services.kestra.internalStorage.location,
  );
  assert.deepEqual(target.googleConnection, source.googleConnection);
  assert.deepEqual(target.applicationAuth, source.applicationAuth);
});

test('Restore target prepares every required recovery secret before native restore', async (t) => {
  const root = await mkdtemp('/tmp/cc-hybrid-restore-secrets-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source'),
    targetRoot = join(root, 'target');
  await mkdir(sourceRoot, { mode: 0o700 });
  await mkdir(targetRoot, { mode: 0o700 });
  const config = JSON.parse(
    await readFile(
      new URL('../deployment/examples/hybrid.json', import.meta.url),
    ),
  );
  config.phase = 3;
  config.services.edge.access = 'application';
  config.applicationAuth = {
    issuer: 'https://identity.example.org',
    clientId: 'qualification',
    publicOrigin: 'https://campus.example.org',
    clientSecretRef: { provider: 'file', path: '/run/secrets/oidc-client' },
  };
  config.googleConnection = {
    keyId: 'restore-fixture-key',
    encryptionKeySecretRef: {
      provider: 'file',
      path: '/run/secrets/google-qualification-key',
    },
  };
  const names = new Set();
  const collect = (value) => {
    if (value && typeof value === 'object') {
      if (value.provider === 'file') names.add(value.path.split('/').at(-1));
      else Object.values(value).forEach(collect);
    }
  };
  collect(config);
  for (const name of names) {
    await writeFile(join(sourceRoot, name), Buffer.alloc(32, 1), {
      mode: 0o600,
    });
    if (
      ![
        'bootstrap',
        'oidc-client',
        'worker-dispatch',
        'kestra-auth',
        'google-qualification-key',
      ].includes(name)
    )
      await writeFile(join(targetRoot, name), Buffer.alloc(32, 2), {
        mode: 0o600,
      });
  }
  await prepareHybridRestoreSecrets(config, sourceRoot, targetRoot);
  await writeFile(join(targetRoot, 'backup-key'), Buffer.alloc(32, 3), {
    mode: 0o600,
  });
  // The real backup precondition checks all recovery secrets before rejecting this destination.
  await assert.rejects(
    backupFoundation({
      config,
      release: {
        schemaVersion: 1,
        sourceRevision: 'a'.repeat(40),
        architectures: ['linux/amd64'],
        images: config.images,
      },
      backupDirectory: 'deliberately-relative',
      keyRecovery: {
        id: 'fixture',
        version: 1,
        reference: { provider: 'file', path: '/run/secrets/backup-key' },
      },
      quiesce: {
        operator: 'fixture',
        stoppedAt: new Date().toISOString(),
        stoppedServices: ['api', 'workers', 'kestra'],
      },
      resolveSecret: (ref) =>
        readFile(join(targetRoot, ref.path.split('/').at(-1))),
    }),
    { message: 'Backup destination must be absolute.' },
  );
  for (const name of names) {
    assert.ok((await readFile(join(targetRoot, name))).length >= 32);
    assert.equal((await stat(join(targetRoot, name))).mode & 0o777, 0o600);
  }
  assert.deepEqual(
    await readFile(join(targetRoot, 'campus-database-password')),
    Buffer.alloc(32, 2),
  );
  assert.deepEqual(
    await readFile(join(targetRoot, 'google-qualification-key')),
    Buffer.alloc(32, 1),
  );
});
