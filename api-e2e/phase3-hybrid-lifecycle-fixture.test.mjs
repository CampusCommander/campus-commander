import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertHybridExternalRetention,
  createHybridLifecycleProof,
} from './phase3-hybrid-lifecycle-fixture.mjs';

function retained() {
  return {
    services: [
      { id: 'postgres-original', running: true },
      { id: 'redis-original', running: true },
    ],
    tables: Object.fromEntries(
      [
        'application_principals',
        'application_grants',
        'application_access_changes',
        'security_events',
        'schema_migrations',
        'artifacts',
        'google_connection',
        'google_credentials',
        'customer_settings_revisions',
        'school_definitions',
      ].map((table) => [table, { count: 1, sha256: table + '-original' }]),
    ),
    executions: { count: 1, sha256: 'execution-original' },
    artifacts: [{ path: 'artifact', sha256: 'artifact-original' }],
    kestraFiles: [{ path: 'marker', sha256: 'internal-original' }],
  };
}

test('Hybrid erasure rejects empty controls, lost records, changed storage, and replaced external services', () => {
  const before = retained();
  assert.doesNotThrow(() =>
    assertHybridExternalRetention(before, structuredClone(before)),
  );
  for (const mutate of [
    (value) => {
      value.services[0].id = 'replacement';
    },
    (value) => {
      value.services[1].running = false;
    },
    (value) => {
      value.executions.count = 0;
    },
    (value) => {
      value.artifacts = [];
    },
    (value) => {
      value.kestraFiles[0].sha256 = 'changed';
    },
    ...Object.keys(before.tables).map((table) => (value) => {
      value.tables[table].sha256 = 'changed';
    }),
  ]) {
    const after = structuredClone(before);
    mutate(after);
    assert.throws(() => assertHybridExternalRetention(before, after));
  }
  for (const mutate of [
    (value) => {
      value.services = [];
    },
    (value) => {
      value.services[0].running = false;
    },
    (value) => {
      value.artifacts = [];
    },
    (value) => {
      value.kestraFiles = [];
    },
    (value) => {
      value.executions.count = 0;
    },
    ...Object.keys(before.tables).map((table) => (value) => {
      value.tables[table].count = 0;
    }),
  ]) {
    const empty = structuredClone(before);
    mutate(empty);
    assert.throws(() => assertHybridExternalRetention(empty, empty));
  }
});

test('Hybrid lifecycle rejects an unowned installation before erasure or service access', async () => {
  let commands = 0;
  await assert.rejects(
    createHybridLifecycleProof({
      project: 'production',
      cli: async () => {
        commands++;
      },
    }),
    { code: 'ERR_ASSERTION' },
  );
  assert.equal(commands, 0);
});
