import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createHybridProviderFaultRuntime } from './phase3-hybrid-provider-fixture.mjs';
import { qualifyInstalledProviderFaults } from './phase3-provider-faults.mjs';

async function fixture(t) {
  const project = 'cc-phase3-hybrid-012345abcdef';
  const root = await mkdtemp(`/tmp/${project}-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const hosts = {
    shared: join(root, 'shared'),
    hosts: ['controller', 'worker-1', 'worker-2'].map((role) => ({
      role,
      daemonId: role,
      root: join(root, role),
    })),
  };
  for (const host of hosts.hosts) {
    await mkdir(host.root);
    await writeFile(
      join(host.root, 'google-health-fault.json'),
      '{"mode":""}',
      { mode: 0o600 },
    );
  }
  return {
    root,
    project,
    hosts,
    services: { database: `${project}-postgres`, redis: `${project}-redis` },
    config: {
      phase: 3,
      profile: 'hybrid',
      artifacts: { location: join(hosts.shared, 'artifacts') },
      services: {
        kestra: { internalStorage: { location: join(hosts.shared, 'kestra') } },
      },
    },
    verifyWorkflows: async () => true,
    verifyReplicas: async () => true,
  };
}

test('Hybrid provider faults update all owned hosts and reject foreign resources and symbolic links', async (t) => {
  const input = await fixture(t);
  assert.throws(() =>
    createHybridProviderFaultRuntime({ ...input, project: 'production' }),
  );
  const runtime = createHybridProviderFaultRuntime(input);
  for (const mode of [
    'network',
    'quota',
    'domain-privilege-denied',
    'wrong-customer',
    '',
  ]) {
    await runtime.fault(mode);
    for (const host of input.hosts.hosts)
      assert.deepEqual(
        JSON.parse(await readFile(join(host.root, 'google-health-fault.json'))),
        { mode },
      );
  }
  await assert.rejects(runtime.fault('unknown'));
  const foreign = join(input.root, 'foreign.json');
  await writeFile(foreign, 'unchanged');
  const faultPath = join(input.hosts.hosts[0].root, 'google-health-fault.json');
  await rm(faultPath);
  await symlink(foreign, faultPath);
  await assert.rejects(runtime.fault('network'), { code: 'ELOOP' });
  assert.equal(await readFile(foreign, 'utf8'), 'unchanged');
});

test('Hybrid provider failure retains public evidence and clears faults after diagnostic failure', async (t) => {
  const input = await fixture(t);
  let mode = '';
  let readiness = 0;
  const modes = [];
  const evidencePath = join(input.root, 'report.json');
  const health = () => ({
    capabilities: ['customer-identity', 'domain-observations'].map(
      (capability) => ({
        capability,
        failure:
          mode && capability === 'domain-observations'
            ? 'network-failure'
            : null,
        lastSucceededAt: '2026-09-17T00:00:00Z',
      }),
    ),
  });
  await assert.rejects(
    qualifyInstalledProviderFaults({
      config: input.config,
      release: { sourceRevision: 'a'.repeat(40), images: {} },
      evidencePath,
      evidenceIdentity: { harnessRevision: 'b'.repeat(40) },
      page: {
        context: () => ({
          browser: () => ({ version: () => 'fixture-browser' }),
        }),
        evaluate: async (_fn, { path, data }) => {
          if (path === '/api/google-connection')
            return {
              status: 200,
              body: { connection: { customerId: 'C0123456', generation: 2 } },
            };
          if (path === '/api/customer')
            return {
              status: 200,
              body: { customer: { customerId: 'C0123456' } },
            };
          if (path.endsWith('/check') && data.generation === 1)
            return { status: 409, body: { reason: 'credential-changed' } };
          return { status: data ? 201 : 200, body: { health: health() } };
        },
      },
      checks: async () => {
        throw new Error('private-provider-exception');
      },
      runtime: {
        createDurableProbe: async () => async () => ({ preserved: true }),
        ready: async () => {
          readiness++;
        },
        fault: async (value) => {
          modes.push(value);
          mode = value;
        },
        verifyRecovery: async () => {
          assert.fail('Failed diagnostics cannot pass recovery.');
        },
      },
    }),
    /private-provider-exception/,
  );
  assert.equal(readiness, 3);
  assert.deepEqual(modes, ['network', '', '']);
  const bytes = await readFile(evidencePath, 'utf8');
  const report = JSON.parse(bytes);
  assert.equal(report.profile, 'hybrid');
  assert.equal(report.status, 'failed');
  assert.equal(report.cases[0].status, 'failed');
  assert.equal(report.cases[0].failure, 'network-failure');
  assert.equal(report.retiredGenerationRejected, true);
  assert.equal(report.harnessRevision, 'b'.repeat(40));
  assert.ok(report.durationMs >= 0);
  assert.equal(bytes.includes('private-provider-exception'), false);
});
