import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcessFaults } from './faults.mjs';

test('rejects ordinary installation projects before executing Docker', async () => {
  await assert.rejects(
    runProcessFaults({ project: 'campus-commander' }),
    /dedicated/,
  );
});

test('rejects shared volumes before fault injection', async () => {
  const calls = [];
  await assert.rejects(
    runProcessFaults(
      {
        qualificationOnly: true,
        project: 'cc-fault-fixture',
        composeFile: '/tmp/fixture.json',
      },
      {
        command: async (...args) => {
          calls.push(args);
          return {
            stdout: JSON.stringify({
              name: 'cc-fault-fixture',
              services: {},
              volumes: { data: { name: 'production_data' } },
            }),
          };
        },
        observe: async () => ({ status: 'ready' }),
        verifyFixtures: async () => true,
      },
    ),
    /outside its project/,
  );
  assert.equal(calls.length, 1);
});

test('restarts the stopped service when diagnostics incorrectly report ready', async () => {
  const calls = [];
  await assert.rejects(
    runProcessFaults(
      {
        qualificationOnly: true,
        project: 'cc-fault-fixture',
        composeFile: '/tmp/fixture.json',
      },
      {
        command: async (_command, args) => {
          calls.push(args.slice(5));
          return {
            stdout: JSON.stringify({
              name: 'cc-fault-fixture',
              services: { api: {} },
              volumes: {},
            }),
          };
        },
        observe: async () => ({ status: 'ready' }),
        verifyFixtures: async () => true,
      },
    ),
    /reported readiness/,
  );
  assert.deepEqual(calls.at(-1), ['start', 'api']);
});

test('system CA startup probing accepts an omitted private CA file and fails closed on unavailable HTTPS', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { httpsStartup } = await import('./faults.mjs');
  const root = await mkdtemp(join(tmpdir(), 'cc-startup-system-ca-'));
  try {
    const bootstrapFile = join(root, 'bootstrap');
    await writeFile(bootstrapFile, 'a'.repeat(43), { mode: 0o600 });
    const result = await httpsStartup({
      url: 'https://localhost:1',
      connectAddress: '127.0.0.1',
      bootstrapFile,
    });
    assert.equal(result.status, 'unavailable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
