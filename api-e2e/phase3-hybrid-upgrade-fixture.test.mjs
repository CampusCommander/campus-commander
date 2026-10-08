import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertHybridUpgradePreservation,
  qualifyHybridPhase2Upgrade,
} from './phase3-hybrid-upgrade-fixture.mjs';

const before = {
  principals: [
    { id: 'first', subject: 'administrator', preferences: { theme: 'light' } },
    {
      id: 'second',
      subject: 'phase2-preserved-reader',
      preferences: { theme: 'dark', navigationCollapsed: true },
    },
  ],
  ledger: [
    { id: '001-foundation', checksum: 'a'.repeat(64) },
    { id: '002-application-auth', checksum: 'b'.repeat(64) },
  ],
  events: [{ value: { id: 1, event: 'preferences-changed' } }],
  artifactId: '10000000-0000-4000-8000-000000000001',
  artifactSha256: 'c'.repeat(64),
  artifactMetadata: [{ value: { state: 'published', size_bytes: 64 } }],
};
const upgraded = () => ({
  ...structuredClone(before),
  events: before.events.map((row) => ({
    value: { ...row.value, target_id: null, resource_scope: null },
  })),
  ledger: [
    ...before.ledger,
    { id: '003-application-grants', checksum: 'd'.repeat(64) },
  ],
});

test('hybrid upgrade evidence rejects lost state and rewritten migration checksums', () => {
  assert.doesNotThrow(() =>
    assertHybridUpgradePreservation(before, upgraded()),
  );
  for (const corrupt of [
    (value) => value.principals.pop(),
    (value) => {
      value.principals[0].preferences.theme = 'system';
    },
    (value) => {
      value.artifactSha256 = 'e'.repeat(64);
    },
    (value) => {
      value.artifactMetadata[0].value.state = 'deleted';
    },
    (value) => {
      value.events = [];
    },
    (value) => {
      value.events[0].value.event = 'logout';
    },
    (value) => {
      value.events[0].value.resource_scope = { kind: 'installation' };
    },
    (value) => {
      value.ledger = structuredClone(before.ledger);
    },
    (value) => {
      value.ledger[0] = { ...value.ledger[0], checksum: 'e'.repeat(64) };
    },
  ]) {
    const after = upgraded();
    corrupt(after);
    assert.throws(() => assertHybridUpgradePreservation(before, after));
  }
});

test('hybrid upgrade evidence requires nonempty baseline state', () => {
  for (const field of ['principals', 'ledger', 'events', 'artifactMetadata']) {
    const empty = { ...structuredClone(before), [field]: [] };
    assert.throws(() => assertHybridUpgradePreservation(empty, empty));
  }
});

test('hybrid upgrade rejects foreign fixture roots before accessing services', async () => {
  const project = 'cc-phase3-hybrid-0123456789ab';
  const controller = {
    daemonId: 'one',
    root: `/tmp/${project}-test/controller`,
  };
  const workers = [
    { daemonId: 'two', root: `/tmp/${project}-test/worker-1` },
    { daemonId: 'three', root: '/tmp/unrelated/worker-2' },
  ];
  await assert.rejects(
    qualifyHybridPhase2Upgrade({
      operator: { project },
      controller,
      workers,
      hosts: {
        run: () =>
          assert.fail('No command can precede fixture ownership checks.'),
      },
    }),
  );
  workers[1] = { ...workers[0] };
  await assert.rejects(
    qualifyHybridPhase2Upgrade({
      operator: { project },
      controller,
      workers,
      hosts: {
        run: () =>
          assert.fail('No command can precede daemon isolation checks.'),
      },
    }),
  );
});
