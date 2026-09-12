import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recordBundleQualification } from './bundle-qualification.mjs';
import { sha256 } from './integrity.mjs';

test('bundle workflow evidence rejects workspace execution and a different image inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-bundle-report-'));
  try {
    const bundleRoot = join(root, 'bundle'),
      reportRoot = join(root, 'reports');
    await mkdir(bundleRoot);
    await mkdir(reportRoot);
    const bytes = Buffer.from('qualified source');
    await writeFile(join(bundleRoot, 'source.mjs'), bytes);
    const sourceRevision = 'a'.repeat(40);
    const images = Object.fromEntries(
      ['frontend', 'api', 'workers'].map((name) => [
        name,
        `registry.example.org/${name}@sha256:${'b'.repeat(64)}`,
      ]),
    );
    const manifest = {
      schemaVersion: 1,
      phase: 2,
      architectures: ['linux/amd64'],
      sourceRevision,
      images,
      files: [
        { path: 'source.mjs', sizeBytes: bytes.length, sha256: sha256(bytes) },
      ],
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(join(bundleRoot, 'release-manifest.json'), manifestBytes);
    const report = {
      status: 'passed',
      sourceRevision,
      images,
      installer: { source: 'extracted-published-bundle' },
    };
    const reportPath = join(reportRoot, 'all-docker-profile.json');
    await writeFile(reportPath, JSON.stringify(report));
    const input = {
      bundleRoot,
      reportRoot,
      target: 'all-docker-integration',
      sourceRevision,
      images,
    };
    const result = await recordBundleQualification(input);
    assert.equal(result.bundleManifestSha256, sha256(manifestBytes));
    assert.equal(result.reports[0].sha256, sha256(await readFile(reportPath)));
    for (const invalid of [
      { ...report, status: 'failed' },
      { ...report, sourceRevision: 'c'.repeat(40) },
      { ...report, images: { ...images, api: images.workers } },
      { ...report, installer: { source: 'workspace' } },
    ]) {
      await writeFile(reportPath, JSON.stringify(invalid));
      await assert.rejects(recordBundleQualification(input));
    }
    await writeFile(reportPath, JSON.stringify(report));
    await writeFile(join(bundleRoot, 'source.mjs'), 'modified source');
    await assert.rejects(recordBundleQualification(input), /integrity failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
