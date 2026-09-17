import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadPhase3UpdateTarget } from './phase3-update-fixture.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('guided update rejects the installed release, invalid targets, and changed inventory bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cc-update-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = 'fixture installer';
  const installed = { sourceRevision: 'a'.repeat(40) };
  const manifest = {
    schemaVersion: 1,
    phase: 3,
    sourceRevision: 'b'.repeat(40),
    architectures: ['linux/amd64'],
    validationScope: 'lab',
    qualification: 'candidate-only',
    images: Object.fromEntries(
      ['api', 'frontend', 'workers'].map((service) => [
        service,
        `ghcr.io/campuscommander/campus-commander-${service === 'workers' ? 'worker' : service}@sha256:${'c'.repeat(64)}`,
      ]),
    ),
    files: [{ path: 'cli.mjs', sizeBytes: cli.length, sha256: hash(cli) }],
  };
  const save = (value) =>
    writeFile(join(root, 'release-manifest.json'), JSON.stringify(value));
  await writeFile(join(root, 'cli.mjs'), cli);
  await save(manifest);
  assert.equal(
    (await loadPhase3UpdateTarget(root, installed)).manifest.sourceRevision,
    manifest.sourceRevision,
  );
  for (const changed of [
    { ...manifest, sourceRevision: installed.sourceRevision },
    { ...manifest, phase: 2 },
    { ...manifest, validationScope: 'full' },
    { ...manifest, qualification: 'accepted' },
    {
      ...manifest,
      images: { ...manifest.images, api: manifest.images.frontend },
    },
    { ...manifest, images: { ...manifest.images, extra: manifest.images.api } },
    {
      ...manifest,
      images: {
        ...manifest.images,
        api: 'ghcr.io/campuscommander/campus-commander-api:latest',
      },
    },
  ]) {
    await save(changed);
    await assert.rejects(loadPhase3UpdateTarget(root, installed));
  }
  await save(manifest);
  await writeFile(join(root, 'cli.mjs'), 'changed installer');
  await assert.rejects(loadPhase3UpdateTarget(root, installed));
});
