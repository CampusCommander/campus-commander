import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertApplicationEvidence } from './application-evidence.mjs';
import { sha256 } from './integrity.mjs';
import { loadQualificationBundle } from './qualification.mjs';

/** Bind actual Phase 3 installation, resume, and restore to the extracted candidate. */
export async function recordPhase3BundleQualification({
  bundleRoot,
  reportRoot,
  sourceRevision,
  images,
}) {
  const startedAt = performance.now();
  const bundle = await loadQualificationBundle(bundleRoot, {
    phase: 3,
    sourceRevision,
    images,
  });
  const inventory = [];
  const read = async (name) => {
    const bytes = await readFile(join(reportRoot, name));
    inventory.push({
      path: name,
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
    });
    const report = JSON.parse(bytes);
    assert.equal(report.phase, 3);
    assert.equal(report.sourceRevision, sourceRevision);
    assert.deepEqual(report.images, images);
    assert.equal(
      report.command,
      'npm exec -- nx run api-e2e:phase3-restore-integration',
    );
    assert.ok(Number.isFinite(report.durationMs) && report.durationMs >= 0);
    for (const key of ['nodeVersion', 'platform', 'architecture'])
      assert.ok(
        typeof report.environment?.[key] === 'string' &&
          report.environment[key],
      );
    return report;
  };
  const profile = await read('all-docker-profile.json');
  assertApplicationEvidence('all-docker-integration', profile, {
    sourceRevision,
    images,
  });
  assert.equal(profile.installer.source, 'extracted-published-bundle');
  assert.equal(profile.installer.bundleManifestSha256, bundle.manifestSha256);
  assert.equal(profile.installer.repeatedResume, true);
  assert.ok(
    profile.installer.commands.filter((name) => name === 'resume').length >= 2,
  );
  for (const command of ['prepare', 'stop', 'uninstall'])
    assert.ok(profile.installer.commands.includes(command));
  const restoration = await read('all-docker-restore.json');
  assertApplicationEvidence('restore-integration', restoration, {
    sourceRevision,
    images,
  });
  assert.equal(restoration.operatorCli.source, 'extracted-published-bundle');
  assert.equal(
    restoration.operatorCli.bundleManifestSha256,
    bundle.manifestSha256,
  );
  assert.equal(restoration.operatorCli.injectedDatabaseTool, false);
  for (const command of ['backup', 'verify', 'restore', 'revalidate-google'])
    assert.ok(
      restoration.operatorCli.commands.some(
        (item) => item.command === command && item.status === 'passed',
      ),
    );
  assert.equal(restoration.oldSessionRejected, true);
  for (const key of [
    'accessChangeReceiptsPreserved',
    'healthHistoryPreserved',
    'ordinaryPrincipalSchoolReadPreserved',
    'oldSettingsReceiptPreserved',
    'approvedSchoolScopePreserved',
    'markerPreserved',
  ])
    assert.equal(restoration.phase3State[key], true);
  assert.equal(restoration.phase3State.status, 'passed');
  for (const key of [
    'issuedInvitationRejected',
    'pendingLoginRejected',
    'pendingInvitationCallbackRejected',
    'sourcePendingLoginStillValid',
  ])
    assert.equal(restoration.admissionRecovery[key], true);
  assert.equal(restoration.admissionRecovery.recipientBindingsRejected, 2);
  assert.equal(restoration.admissionRecovery.status, 'passed');
  const result = {
    schemaVersion: 1,
    status: 'passed',
    phase: 3,
    profile: 'all-docker',
    sourceRevision,
    images,
    bundleManifestSha256: bundle.manifestSha256,
    checks: {
      install: 'passed',
      resume: 'passed',
      restore: 'passed',
      upgrade: 'not-run',
      faults: 'not-run',
    },
    command: 'node deployment/release/phase3-bundle-qualification.mjs',
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      ci: process.env.CI === 'true',
    },
    durationMs: Math.round(performance.now() - startedAt),
    durationScope:
      'Evidence validation and bundle inventory verification only.',
    qualificationDurations: [
      {
        report: 'all-docker-profile.json',
        durationMs: profile.durationMs,
        scope: 'Complete installer, lifecycle, browser, and restore fixture.',
      },
      {
        report: 'all-docker-restore.json',
        durationMs: restoration.durationMs,
        scope:
          'Isolated restore target before source cleanup and pending-login control.',
      },
    ],
    reports: inventory,
    limits: [
      'This laboratory report does not establish full profile or release acceptance.',
      'Synthetic Google and identity providers do not qualify district privileges or browser trust.',
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
)
  await recordPhase3BundleQualification({
    bundleRoot: process.env.CC_AUTH_INSTALLER_ROOT,
    reportRoot: 'dist/phase-3-recovery',
    sourceRevision: process.env.GITHUB_SHA,
    images: {
      frontend: process.env.CC_AUTH_FRONTEND_IMAGE,
      api: process.env.CC_AUTH_API_IMAGE,
      workers: process.env.CC_AUTH_WORKER_IMAGE,
    },
  });
