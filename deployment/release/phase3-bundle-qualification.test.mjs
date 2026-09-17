import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha256 } from './integrity.mjs';
import { recordPhase3BundleQualification } from './phase3-bundle-qualification.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cc-phase3-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundleRoot = join(root, 'bundle');
  const reportRoot = join(root, 'reports');
  await mkdir(bundleRoot);
  await mkdir(reportRoot);
  const sourceRevision = 'a'.repeat(40);
  const images = Object.fromEntries(
    ['frontend', 'api', 'workers'].map((name) => [
      name,
      `registry.example/${name}@sha256:${'b'.repeat(64)}`,
    ]),
  );
  const bytes = Buffer.from('export const fixture = true;\n');
  await writeFile(join(bundleRoot, 'cli.mjs'), bytes);
  const manifestBytes = JSON.stringify({
    schemaVersion: 1,
    phase: 3,
    sourceRevision,
    images,
    architectures: ['linux/amd64'],
    files: [
      { path: 'cli.mjs', sizeBytes: bytes.length, sha256: sha256(bytes) },
    ],
  });
  await writeFile(join(bundleRoot, 'release-manifest.json'), manifestBytes);
  const bundleManifestSha256 = sha256(manifestBytes);
  const common = {
    phase: 3,
    sourceRevision,
    images,
    status: 'passed',
    profile: 'all-docker',
    command: 'npm exec -- nx run api-e2e:phase3-restore-integration',
    environment: {
      nodeVersion: 'v24.19.0',
      platform: 'linux',
      architecture: 'x64',
    },
    durationMs: 1200,
  };
  const profile = {
    ...common,
    browser: { status: 'passed' },
    apiReplicaCount: 2,
    logoutRejectedAcrossReplicas: true,
    replicaObservations: [
      'initial-session',
      'restart-session',
      'stop-resume-session',
      'uninstall-resume-session',
      'signed-out-session',
    ].flatMap((phase) =>
      ['one', 'two'].map((container) => ({
        phase,
        container,
        status: phase === 'signed-out-session' ? 401 : 200,
        principalId: 'principal',
      })),
    ),
    installer: {
      source: 'extracted-published-bundle',
      bundleManifestSha256,
      repeatedResume: true,
      commands: ['prepare', 'resume', 'resume', 'stop', 'uninstall'],
    },
  };
  const restoration = {
    ...common,
    application: { status: 'passed' },
    oldSessionRejected: true,
    operatorCli: {
      source: 'extracted-published-bundle',
      bundleManifestSha256,
      runner: 'operator-container-native',
      secretMount: '/run/secrets',
      injectedDatabaseTool: false,
      commands: ['backup', 'verify', 'restore', 'revalidate-google'].map(
        (command) => ({ command, status: 'passed' }),
      ),
    },
    phase3State: {
      status: 'passed',
      ...Object.fromEntries(
        [
          'accessChangeReceiptsPreserved',
          'healthHistoryPreserved',
          'ordinaryPrincipalSchoolReadPreserved',
          'oldSettingsReceiptPreserved',
          'approvedSchoolScopePreserved',
          'markerPreserved',
        ].map((key) => [key, true]),
      ),
    },
    admissionRecovery: {
      status: 'passed',
      recipientBindingsRejected: 2,
      issuedInvitationRejected: true,
      pendingLoginRejected: true,
      pendingInvitationCallbackRejected: true,
      sourcePendingLoginStillValid: true,
    },
  };
  const save = async () => {
    await writeFile(
      join(reportRoot, 'all-docker-profile.json'),
      JSON.stringify(profile),
    );
    await writeFile(
      join(reportRoot, 'all-docker-restore.json'),
      JSON.stringify(restoration),
    );
  };
  await save();
  return {
    bundleRoot,
    reportRoot,
    sourceRevision,
    images,
    profile,
    restoration,
    save,
    bundleManifestSha256,
  };
}

test('Phase 3 extracted qualification binds both reports without claiming upgrade or faults', async (t) => {
  const f = await fixture(t);
  const result = await recordPhase3BundleQualification(f);
  assert.equal(result.bundleManifestSha256, f.bundleManifestSha256);
  assert.deepEqual(result.checks, {
    install: 'passed',
    resume: 'passed',
    restore: 'passed',
    upgrade: 'not-run',
    faults: 'not-run',
  });
  for (const item of result.reports) {
    const bytes = await readFile(join(f.reportRoot, item.path));
    assert.equal(item.sizeBytes, bytes.length);
    assert.equal(item.sha256, sha256(bytes));
  }
  assert.deepEqual(
    JSON.parse(await readFile(join(f.reportRoot, 'bundle-qualification.json'))),
    result,
  );
});

const mutations = {
  'missing duration': (f) => {
    delete f.profile.durationMs;
  },
  'wrong command': (f) => {
    f.restoration.command = 'different';
  },
  'missing environment': (f) => {
    delete f.profile.environment;
  },
  'wrong phase': (f) => {
    f.profile.phase = 2;
  },
  'wrong source': (f) => {
    f.restoration.sourceRevision = 'c'.repeat(40);
  },
  'wrong images': (f) => {
    f.profile.images = {};
  },
  'workspace installer': (f) => {
    f.profile.installer.source = 'workspace';
  },
  'workspace operator': (f) => {
    f.restoration.operatorCli.source = 'workspace';
  },
  'different installer bundle': (f) => {
    f.profile.installer.bundleManifestSha256 = 'c'.repeat(64);
  },
  'different operator bundle': (f) => {
    f.restoration.operatorCli.bundleManifestSha256 = 'c'.repeat(64);
  },
  'single resume': (f) => {
    f.profile.installer.commands.splice(1, 1);
  },
  'missing uninstall': (f) => {
    f.profile.installer.commands.pop();
  },
  'failed browser': (f) => {
    f.profile.browser.status = 'failed';
  },
  'missing replica': (f) => {
    f.profile.replicaObservations.pop();
  },
  'injected database tool': (f) => {
    f.restoration.operatorCli.injectedDatabaseTool = true;
  },
  'missing revalidation': (f) => {
    f.restoration.operatorCli.commands.pop();
  },
  'failed restore': (f) => {
    f.restoration.operatorCli.commands[2].status = 'failed';
  },
  'copied session accepted': (f) => {
    f.restoration.oldSessionRejected = false;
  },
  'lost access receipt': (f) => {
    f.restoration.phase3State.accessChangeReceiptsPreserved = false;
  },
  'lost health history': (f) => {
    f.restoration.phase3State.healthHistoryPreserved = false;
  },
  'pending callback accepted': (f) => {
    f.restoration.admissionRecovery.pendingLoginRejected = false;
  },
  'missing source control': (f) => {
    f.restoration.admissionRecovery.sourcePendingLoginStillValid = false;
  },
  'missing recipient binding': (f) => {
    f.restoration.admissionRecovery.recipientBindingsRejected = 1;
  },
  'modified extracted code': async (f) => {
    await writeFile(join(f.bundleRoot, 'cli.mjs'), 'changed');
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`Phase 3 extracted qualification rejects ${name}`, async (t) => {
    const f = await fixture(t);
    await mutate(f);
    await f.save();
    await assert.rejects(recordPhase3BundleQualification(f));
    await assert.rejects(
      readFile(join(f.reportRoot, 'bundle-qualification.json')),
      { code: 'ENOENT' },
    );
  });
