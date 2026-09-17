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
