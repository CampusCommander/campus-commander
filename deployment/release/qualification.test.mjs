import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha256 } from './integrity.mjs';
import { loadQualificationBundle } from './qualification.mjs';

test('bundle qualification binds the image revision and exact extracted CLI bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-bundle-qualification-'));
  try {
    await mkdir(join(root, 'deployment/installer'), { recursive: true });
    const cliPath = 'deployment/installer/cli.mjs';
    const cli = Buffer.from('export const release = "original";\n');
    await writeFile(join(root, cliPath), cli);
    const expected = {
      sourceRevision: 'a'.repeat(40),
      images: Object.fromEntries(
        ['frontend', 'api', 'workers'].map((name) => [
          name,
          `registry.example.org/${name}@sha256:${'b'.repeat(64)}`,
        ]),
      ),
    };
    const manifest = {
      schemaVersion: 1,
      phase: 2,
      architectures: ['linux/amd64'],
      ...expected,
      files: [{ path: cliPath, sizeBytes: cli.length, sha256: sha256(cli) }],
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(join(root, 'release-manifest.json'), bytes);
    const bundle = await loadQualificationBundle(root, expected);
    assert.equal(bundle.root, root);
    assert.equal(bundle.manifestSha256, sha256(bytes));
    assert.deepEqual(bundle.manifest, manifest);
    for (const changed of [
      { ...expected, sourceRevision: 'c'.repeat(40) },
      {
        ...expected,
        images: { ...expected.images, api: expected.images.workers },
      },
    ])
      await assert.rejects(loadQualificationBundle(root, changed));
    for (const changed of [
      { ...manifest, phase: 1 },
      { ...manifest, files: [] },
    ]) {
      await writeFile(
        join(root, 'release-manifest.json'),
        JSON.stringify(changed),
      );
      await assert.rejects(loadQualificationBundle(root, expected));
    }
    await writeFile(join(root, 'release-manifest.json'), bytes);
    await writeFile(join(root, cliPath), 'export const release = "changed";\n');
    await assert.rejects(
      loadQualificationBundle(root, expected),
      /integrity failed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
