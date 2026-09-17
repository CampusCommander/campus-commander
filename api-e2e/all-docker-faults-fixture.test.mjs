import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { faultAllDocker } from './all-docker-faults-fixture.mjs';

test('fault evidence retains ownership rejection without invoking Docker', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-fault-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidencePath = join(directory, 'failed.json');
  let composeCalls = 0;
  await assert.rejects(
    faultAllDocker({
      root: '/unowned',
      project: 'production',
      config: { phase: 3 },
      release: { sourceRevision: 'a'.repeat(40), images: {} },
      compose: () => {
        composeCalls++;
        throw new Error('Must not execute Docker.');
      },
      page: {
        context: () => ({
          browser: () => ({ version: () => 'fixture-browser' }),
        }),
      },
      evidencePath,
      evidenceIdentity: {
        harnessRevision: 'b'.repeat(40),
        bundleManifestSha256: 'c'.repeat(64),
      },
    }),
    { code: 'ERR_ASSERTION' },
  );
  assert.equal(composeCalls, 0);
  const report = JSON.parse(await readFile(evidencePath));
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.cases, []);
  assert.equal(report.phase, 3);
  assert.equal(report.sourceRevision, 'a'.repeat(40));
  assert.equal(report.harnessRevision, 'b'.repeat(40));
  assert.equal(report.bundleManifestSha256, 'c'.repeat(64));
  assert.equal(report.environment.nodeVersion, process.version);
  assert.ok(Number.isFinite(report.durationMs));
  assert.ok(report.durationScope);
});
