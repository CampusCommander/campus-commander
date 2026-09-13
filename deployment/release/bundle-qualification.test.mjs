import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  inspectBundleQualification,
  recordBundleQualification,
} from './bundle-qualification.mjs';
import { sha256 } from './integrity.mjs';

test('Kubernetes restore binds its executed upgrade companion report', async () => {
  const reportRoot = await mkdtemp(join(tmpdir(), 'cc-kube-restore-report-'));
  try {
    for (const name of ['kubernetes-restore', 'kubernetes-upgrade'])
      await writeFile(
        join(reportRoot, `${name}.json`),
        await readFile(
          new URL(
            `../evidence/CC-37-phase-2-bundle-${name}-be11ad2.json`,
            import.meta.url,
          ),
        ),
      );
    const primary = JSON.parse(
      await readFile(join(reportRoot, 'kubernetes-restore.json')),
    );
    const companionPath = join(reportRoot, 'kubernetes-upgrade.json');
    const companion = JSON.parse(await readFile(companionPath));
    const input = {
      reportRoot,
      target: 'kubernetes-restore-integration',
      sourceRevision: primary.sourceRevision,
      images: primary.images,
      bundleManifestSha256: primary.operatorCli.bundleManifestSha256,
    };
    const result = await inspectBundleQualification(input);
    assert.deepEqual(
      result.reports.map((report) => report.path),
      ['kubernetes-restore.json', 'kubernetes-upgrade.json'],
    );
    assert.equal(
      result.reports[1].sha256,
      sha256(await readFile(companionPath)),
    );
    for (const invalid of [
      { ...companion, status: 'failed' },
      { ...companion, sourceRevision: 'c'.repeat(40) },
      {
        ...companion,
        images: { ...companion.images, api: companion.images.workers },
      },
      {
        ...companion,
        installer: { ...companion.installer, source: 'workspace' },
      },
      {
        ...companion,
        installer: {
          ...companion.installer,
          bundleManifestSha256: 'd'.repeat(64),
        },
      },
    ]) {
      await writeFile(companionPath, JSON.stringify(invalid));
      await assert.rejects(inspectBundleQualification(input));
    }
    await rm(companionPath);
    await assert.rejects(inspectBundleQualification(input), /ENOENT/);
  } finally {
    await rm(reportRoot, { recursive: true, force: true });
  }
});

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
      ...JSON.parse(
        await readFile(
          new URL(
            '../evidence/CC-37-phase-2-extracted-all-docker-a807c35.json',
            import.meta.url,
          ),
        ),
      ),
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
