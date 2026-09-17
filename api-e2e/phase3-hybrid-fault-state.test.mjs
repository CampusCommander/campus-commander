import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertHybridFaultOwnership,
  assertHybridFaultState,
  createHybridFaultStateProbe,
} from './phase3-hybrid-fault-state.mjs';

function owned() {
  const project = 'cc-phase3-hybrid-012345abcdef';
  const root = `/tmp/${project}-ABCDEF`;
  return {
    project,
    hosts: {
      shared: `${root}/shared`,
      hosts: ['controller', 'worker-1', 'worker-2'].map((role) => ({
        root: `${root}/${role}`,
        role,
        daemonId: role,
      })),
    },
    services: { database: `${project}-postgres`, redis: `${project}-redis` },
    config: {
      phase: 3,
      profile: 'hybrid',
      artifacts: { location: `${root}/shared/artifacts` },
      services: {
        kestra: { internalStorage: { location: `${root}/shared/kestra` } },
      },
    },
  };
}

test('Hybrid fault probes reject foreign resources before filesystem or service access', async () => {
  assert.doesNotThrow(() => assertHybridFaultOwnership(owned()));
  for (const mutate of [
    (v) => {
      v.project = 'production';
    },
    (v) => {
      v.config.phase = 2;
    },
    (v) => {
      v.config.profile = 'all-docker';
    },
    (v) => {
      v.hosts.hosts[1].daemonId = 'controller';
    },
    (v) => {
      v.hosts.hosts[0].root += '/../foreign';
    },
    (v) => {
      v.hosts.hosts[2].root = '/tmp/foreign';
    },
    (v) => {
      v.hosts.shared += '/../foreign';
    },
    (v) => {
      v.services.database = 'production-postgres';
    },
    (v) => {
      v.services.redis = 'production-redis';
    },
    (v) => {
      v.config.artifacts.location += '/../foreign';
    },
    (v) => {
      v.config.services.kestra.internalStorage.location = '/srv/kestra';
    },
  ]) {
    const input = owned();
    mutate(input);
    await assert.rejects(createHybridFaultStateProbe(input), {
      code: 'ERR_ASSERTION',
    });
  }
});

function state() {
  return {
    principals: [
      { id: 'admin', preferences: { theme: 'dark' } },
      { id: 'recipient', enabled: false },
    ],
    events: [{ id: 'audit', detail: { generation: 2 } }],
    migrations: [{ id: '001-foundation', checksum: 'original' }],
    artifacts: [{ id: 'artifact', size_bytes: 42 }],
    executions: [{ key: 'execution', sha256: 'original' }],
    artifactSha256: 'artifact-hash',
    internalStorageSha256: 'internal-hash',
    policy: Object.fromEntries(
      [
        ['google_connection', 1],
        ['google_credentials', 2],
        ['customer_settings_revisions', 2],
        ['school_definitions', 2],
        ['application_grants', 3],
        ['application_access_changes', 2],
      ].map(([name, count]) => [name, { count, sha256: name + '-hash' }]),
    ),
  };
}

test('Hybrid fault verification rejects changed durable state and accepts appended diagnostic records', () => {
  const before = state();
  const appended = structuredClone(before);
  appended.events.push({ id: 'new-event' });
  appended.artifacts.push({ id: 'diagnostic-artifact' });
  appended.executions.push({ key: 'diagnostic-execution' });
  assert.doesNotThrow(() => assertHybridFaultState(before, appended));
  for (const mutate of [
    (v) => {
      v.principals[0].preferences.theme = 'light';
    },
    (v) => {
      v.principals[1].enabled = true;
    },
    (v) => {
      v.events[0].detail.generation = 3;
    },
    (v) => {
      v.events = [];
    },
    (v) => {
      v.migrations[0].checksum = 'changed';
    },
    (v) => {
      v.artifacts[0].size_bytes = 0;
    },
    (v) => {
      v.artifacts = [];
    },
    (v) => {
      v.executions[0].sha256 = 'changed';
    },
    (v) => {
      v.executions = [];
    },
    (v) => {
      v.artifactSha256 = 'changed';
    },
    (v) => {
      v.internalStorageSha256 = 'changed';
    },
    ...Object.keys(before.policy).map((name) => (v) => {
      v.policy[name].sha256 = 'changed';
    }),
  ]) {
    const after = structuredClone(before);
    mutate(after);
    assert.throws(() => assertHybridFaultState(before, after), {
      code: 'ERR_ASSERTION',
    });
  }
});

for (const failureAt of [1, 4])
  test(`Hybrid fault retains failed case evidence at check ${failureAt}`, async () => {
    const { mkdtemp, mkdir, readFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { faultDistributedHybrid } = await import(
      './hybrid-cli-faults-fixture.mjs'
    );
    const root = await mkdtemp('/tmp/cc-phase3-hybrid-012345abcdef-');
    try {
      const artifacts = join(root, 'artifacts');
      await mkdir(artifacts);
      const evidencePath = join(root, 'uploaded-fault-progress.json');
      let cases = 0;
      let requests = 0;
      const commands = [];
      await assert.rejects(
        faultDistributedHybrid({
          hosts: {
            shared: root,
            hosts: [
              {
                name: 'cc-phase3-hybrid-012345abcdef-controller',
                root,
                daemonId: 'controller',
              },
              { daemonId: 'worker-1' },
              { daemonId: 'worker-2' },
            ],
          },
          services: {
            database: 'cc-phase3-hybrid-012345abcdef-postgres',
            redis: 'cc-phase3-hybrid-012345abcdef-redis',
          },
          config: { phase: 3, artifacts: { location: artifacts } },
          compose: async (_host, args) => {
            commands.push(args);
          },
          page: {
            evaluate: async () =>
              [
                { httpStatus: 503 },
                { httpStatus: 200 },
                {
                  httpStatus: 201,
                  status: 'failed',
                  correlationId: '12345678-1234-1234-1234-123456789012',
                },
                { httpStatus: 200 },
              ][requests++],
          },
          checks: async () => {
            if (++cases === failureAt)
              throw new Error('private-exception-marker');
          },
          verifyDurableState: async () => ({ preserved: true }),
          verifyWorkflows: async () => true,
          verifyReplicas: async () => true,
          evidencePath,
          evidenceIdentity: { harnessRevision: 'a'.repeat(40) },
        }),
        /private-exception-marker/,
      );
      const bytes = await readFile(evidencePath, 'utf8');
      const report = JSON.parse(bytes);
      assert.equal(report.status, 'failed');
      assert.ok(report.durationMs >= 0);
      assert.ok(Number.isFinite(Date.parse(report.recordedAt)));
      assert.ok(report.durationScope.includes('verification'));
      assert.equal(report.harnessRevision, 'a'.repeat(40));
      if (failureAt === 1) {
        assert.equal(report.cases.length, 1);
        assert.equal(report.cases[0].status, 'failed');
        assert.equal(report.cases[0].stage, 'baseline');
        assert.equal(report.cases[0].observed, undefined);
        assert.equal(bytes.includes('private-exception-marker'), false);
        assert.deepEqual(commands, []);
        return;
      }
      assert.equal(report.cases.length, 2);
      assert.equal(report.cases[0].name, 'api-interruption');
      assert.equal(report.cases[0].status, 'passed');
      assert.deepEqual(report.cases[0].durableState, { preserved: true });
      assert.equal(report.cases[1].status, 'failed');
      assert.equal(report.cases[1].stage, 'verification');
      assert.equal(report.cases[1].name, 'worker-host-interruption');
      assert.deepEqual(report.cases[0].observed, { httpStatus: 503 });
      assert.ok(report.cases[1].elapsedMs >= 0);
      assert.equal(bytes.includes('private-exception-marker'), false);
      assert.deepEqual(commands, [
        ['stop', 'api'],
        ['start', 'api'],
        ['stop', 'workers'],
        ['stop', 'workers'],
        ['start', 'workers'],
        ['start', 'workers'],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
