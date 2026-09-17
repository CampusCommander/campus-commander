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

test('provider fault evidence retains ownership rejection without resetting an unowned path', async (t) => {
  const { qualifyInstalledProviderFaults } = await import(
    './phase3-provider-faults.mjs'
  );
  const directory = await mkdtemp(join(tmpdir(), 'cc-provider-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidencePath = join(directory, 'failed.json');
  let composeCalls = 0;
  await assert.rejects(
    qualifyInstalledProviderFaults({
      root: join(directory, 'unowned'),
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
      evidenceIdentity: { harnessRevision: 'b'.repeat(40) },
    }),
    { code: 'ERR_ASSERTION' },
  );
  assert.equal(composeCalls, 0);
  const report = JSON.parse(await readFile(evidencePath));
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.cases, []);
  assert.equal(report.harnessRevision, 'b'.repeat(40));
  assert.ok(Number.isFinite(report.durationMs));
});

test('certificate fault evidence retains ownership rejection before reading private files', async (t) => {
  const { qualifyAllDockerCertificates } = await import(
    './all-docker-certificates-fixture.mjs'
  );
  const directory = await mkdtemp(join(tmpdir(), 'cc-certificate-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidencePath = join(directory, 'failed.json');
  let composeCalls = 0;
  await assert.rejects(
    qualifyAllDockerCertificates({
      root: join(directory, 'unowned'),
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
      evidenceIdentity: { harnessRevision: 'b'.repeat(40) },
    }),
    { code: 'ERR_ASSERTION' },
  );
  assert.equal(composeCalls, 0);
  const report = JSON.parse(await readFile(evidencePath));
  assert.equal(report.status, 'failed');
  assert.equal(report.originalSecretBytesRestored, false);
  assert.deepEqual(report.cases, []);
  assert.equal(report.harnessRevision, 'b'.repeat(40));
  assert.ok(Number.isFinite(report.durationMs));
});

test('capacity faults reject unowned and unbounded volumes before writing', async () => {
  const { assertCapacityVolume } = await import('./phase3-capacity-faults.mjs');
  const project = 'cc-phase3-12345678-abc';
  const owned = {
    Name: `${project}_artifacts`,
    Driver: 'local',
    Labels: {
      'com.docker.compose.project': project,
      'com.docker.compose.volume': 'artifacts',
    },
    Options: {
      type: 'tmpfs',
      device: 'tmpfs',
      o: 'size=16m,uid=1000,gid=1000,mode=0700',
    },
  };
  assert.doesNotThrow(() => assertCapacityVolume(owned, project));
  for (const changed of [
    { ...owned, Name: 'shared-artifacts' },
    { ...owned, Driver: 'nfs' },
    { ...owned, Labels: {} },
    {
      ...owned,
      Labels: { ...owned.Labels, 'com.docker.compose.project': 'production' },
    },
    { ...owned, Options: null },
    { ...owned, Options: { ...owned.Options, type: 'ext4' } },
    { ...owned, Options: { ...owned.Options, o: 'size=1g' } },
  ])
    assert.throws(() => assertCapacityVolume(changed, project));
  assert.throws(() => assertCapacityVolume(owned, 'production'));
});

test('lifecycle qualification rejects an unowned project before erasure commands', async (t) => {
  const { createInstalledLifecycleProof } = await import(
    './phase3-lifecycle-fixture.mjs'
  );
  const directory = await mkdtemp(join(tmpdir(), 'cc-lifecycle-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let commands = 0;
  await assert.rejects(
    createInstalledLifecycleProof({
      root: '/unowned',
      project: 'production',
      config: { phase: 3 },
      release: { sourceRevision: 'a'.repeat(40), images: {} },
      compose: () => {
        commands++;
      },
      cli: () => {
        commands++;
      },
      evidenceDirectory: directory,
      evidenceIdentity: { harnessRevision: 'b'.repeat(40) },
      installerInvocations: [],
    }),
    { code: 'ERR_ASSERTION' },
  );
  assert.equal(commands, 0);
  const report = JSON.parse(
    await readFile(join(directory, 'all-docker-lifecycle.json')),
  );
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.stages, []);
});
