import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applicationReports } from './candidate.mjs';
import { sha256 } from './integrity.mjs';
import { loadQualificationBundle } from './qualification.mjs';

export const bundleTargets = [
  'all-docker-integration',
  'upgrade-integration',
  'restore-integration',
  'all-docker-process-fault-integration',
  'hybrid-cli-integration',
  'hybrid-cli-upgrade-integration',
  'hybrid-restore-integration',
  'hybrid-cli-process-fault-integration',
  'kubernetes-integration',
  'kubernetes-upgrade-integration',
  'kubernetes-restore-integration',
  'kubernetes-process-fault-integration',
];

/** Record passed workflow evidence against the independently verified bundle. */
export async function recordBundleQualification({
  bundleRoot,
  reportRoot,
  target,
  sourceRevision,
  images,
}) {
  assert.ok(bundleTargets.includes(target));
  const bundle = await loadQualificationBundle(bundleRoot, {
    sourceRevision,
    images,
  });
  const reports = new Map();
  const read = async (name) => {
    const bytes = await readFile(join(reportRoot, name));
    const report = JSON.parse(bytes);
    assert.ok(['passed', 'PASS'].includes(report.status));
    reports.set(name, {
      path: name,
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
    });
    return report;
  };
  const primary = await read(applicationReports[target]);
  const reportedImages = primary.images ?? primary.releaseB;
  for (const [name, reference] of Object.entries(images))
    assert.equal(
      reportedImages[name] ??
        (name === 'workers' ? reportedImages.worker : undefined),
      reference,
    );
  if (primary.sourceRevision)
    assert.equal(primary.sourceRevision, sourceRevision);
  const operator = (record) => {
    assert.equal(record.source, 'extracted-published-bundle');
    assert.equal(record.bundleManifestSha256, bundle.manifestSha256);
    assert.equal(record.injectedDatabaseTool, false);
  };
  if (target === 'all-docker-integration') {
    assert.equal(primary.installer.source, 'extracted-published-bundle');
  } else if (
    target === 'upgrade-integration' ||
    target === 'all-docker-process-fault-integration'
  ) {
    const upgrade =
      target === 'upgrade-integration'
        ? primary
        : await read('all-docker-upgrade.json');
    assert.equal(upgrade.installerSource, 'extracted-published-bundle');
    assert.equal(upgrade.bundleManifestSha256, bundle.manifestSha256);
    assert.equal(
      upgrade.releaseInventories.at(-1).sourceRevision,
      sourceRevision,
    );
  } else if (target === 'restore-integration') {
    operator(primary.operatorCli);
  } else if (target === 'hybrid-restore-integration') {
    operator(primary.backup.operatorCli);
    operator(primary.verification.operatorCli);
  } else if (target.startsWith('hybrid-cli-')) {
    assert.equal(
      primary.qualificationSourceState,
      'Extracted published installer bundle with matching application images.',
    );
    assert.equal(primary.bundleManifestSha256, bundle.manifestSha256);
    assert.equal(primary.ownedResourcesRemoved, true);
  } else {
    const profile = primary.installer
      ? primary
      : await read('kubernetes-profile.json');
    assert.equal(profile.installer.source, 'verified-extracted-bundle');
    assert.equal(profile.installer.bundleManifestSha256, bundle.manifestSha256);
    if (target === 'kubernetes-restore-integration')
      operator(primary.operatorCli);
  }
  const result = {
    schemaVersion: 1,
    status: 'passed',
    target,
    sourceRevision,
    images,
    bundleManifestSha256: bundle.manifestSha256,
    reports: [...reports.values()],
    limits: [
      'This record binds one executed candidate workflow. It does not establish release acceptance.',
    ],
  };
  await writeFile(
    join(reportRoot, 'bundle-qualification.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await recordBundleQualification({
    bundleRoot: process.env.CC_AUTH_INSTALLER_ROOT,
    reportRoot: 'dist/phase-2-evidence',
    target: process.env.QUALIFICATION_TARGET,
    sourceRevision: process.env.GITHUB_SHA,
    images: {
      frontend: process.env.CC_AUTH_FRONTEND_IMAGE,
      api: process.env.CC_AUTH_API_IMAGE,
      workers: process.env.CC_AUTH_WORKER_IMAGE,
    },
  });
  console.log(
    JSON.stringify({
      target: result.target,
      status: result.status,
      bundleManifestSha256: result.bundleManifestSha256,
    }),
  );
}
