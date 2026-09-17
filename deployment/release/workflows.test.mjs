import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, mkdir, writeFile, cp } from 'node:fs/promises';
import { join, matchesGlob } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { applicationReports } from './application-evidence.mjs';
import { bundleTargets } from './bundle-qualification.mjs';
import { sha256 } from './integrity.mjs';

const workflow = async (name) =>
  parse(await readFile(`.github/workflows/${name}.yml`, 'utf8'));

test('release triggers skip prose and evidence but include installer and application changes', async () => {
  const release = await workflow('phase-2-candidate');
  const triggers = (path) =>
    release.on.push.paths.reduce((selected, pattern) => {
      const exclude = pattern.startsWith('!');
      return matchesGlob(path, exclude ? pattern.slice(1) : pattern)
        ? !exclude
        : selected;
    }, false);
  for (const path of [
    'docs/testing/phase-2-ubuntu-google.md',
    'deployment/installer/HOSTED.md',
    'deployment/evidence/result.json',
    'README.md',
  ])
    assert.equal(triggers(path), false, path);
  for (const path of [
    'install.sh',
    'deployment/installer/setup.mjs',
    'frontend/src/app/setup/setup.ts',
    'api/src/app/auth/auth.service.ts',
    'worker/src/main.ts',
    'package-lock.json',
    '.github/workflows/phase-2-candidate.yml',
  ])
    assert.equal(triggers(path), true, path);
  assert.equal(release.on.workflow_dispatch.inputs.mode.default, 'lab');
  assert.equal(release.jobs['qualified-bundle'].if, "inputs.mode == 'full'");
  assert.equal(release.jobs.capacity.if, "inputs.mode == 'full'");
  assert.equal(
    release.jobs.bundle.steps.find(
      (step) => step.name === 'Publish project candidate release',
    ).if,
    "inputs.mode == 'full'",
  );
  const labPublisher = release.jobs['bundle-application'].steps.find(
    (step) => step.name === 'Publish tested lab release',
  );
  assert.equal(labPublisher.if, "inputs.mode != 'full'");
  assert.match(labPublisher.run, /phase-2-lab-/);
  assert.doesNotMatch(labPublisher.if, /always|cancelled/);
  // A skipped capacity ancestor must not suppress the successful lab bundle.
  assert.equal(
    release.jobs['bundle-application'].if,
    "${{ !cancelled() && needs.bundle.result == 'success' && needs.plan.result == 'success' }}",
  );
});

test('the executed workflow plan keeps lab checks focused and retains the complete full matrix', async (t) => {
  const release = await workflow('phase-2-candidate');
  const root = await mkdtemp(join(tmpdir(), 'cc-workflow-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mode of ['lab', 'full']) {
    const output = join(root, mode);
    execFileSync('bash', ['-e', '-c', release.jobs.plan.steps[0].run], {
      env: { ...process.env, MODE: mode, GITHUB_OUTPUT: output },
    });
    const plan = Object.fromEntries(
      (await readFile(output, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => {
          const separator = line.indexOf('=');
          return [
            line.slice(0, separator),
            JSON.parse(line.slice(separator + 1)),
          ];
        }),
    );
    assert.deepEqual(
      plan.application.toSorted(),
      mode === 'lab'
        ? ['auth-image-integration']
        : Object.keys(applicationReports).toSorted(),
    );
    assert.deepEqual(
      plan.bundle.toSorted(),
      mode === 'lab' ? ['all-docker-integration'] : bundleTargets.toSorted(),
    );
  }
});

test('pull requests and focused authorization runs avoid duplicate qualification', async () => {
  const ci = await workflow('ci');
  for (const name of [
    'foundation-integration',
    'browser',
    'application-integration',
  ])
    assert.equal(
      ci.jobs[name].if,
      "inputs.phase3Release == '' && inputs.phase3Only != true && (github.event_name == 'push' || inputs.full == true)",
    );
  assert.equal(
    ci.jobs['phase3-authorization'].if,
    "inputs.phase3Release == '' && inputs.phase3Only == true",
  );
  assert.equal(
    ci.jobs.main.if,
    "inputs.phase3Only != true && inputs.phase3Release == ''",
  );
  assert.equal(ci.on.workflow_dispatch.inputs.phase3Only.default, false);
  assert.equal(ci.concurrency['cancel-in-progress'], true);
  assert.ok(
    ci.jobs.main.steps.some((step) => step.run?.includes('nx affected')),
  );
});

test('workflow shell steps remain valid and image pulls have bounded retries', async () => {
  const release = await workflow('phase-2-candidate');
  for (const name of ['application', 'bundle-application']) {
    const prepare = release.jobs[name].steps.find(
      (step) => step.name === 'Prepare published image references',
    );
    assert.match(prepare.run, /for attempt in 1 2 3/);
    assert.match(prepare.run, /if \[ "\$attempt" -eq 3 \]; then exit 1; fi/);
  }
  for (const name of [
    'ci',
    'phase-2-candidate',
    'phase-3-candidate',
    'phase-3-profile-check',
  ]) {
    const parsed = await workflow(name);
    for (const job of Object.values(parsed.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.run)
          execFileSync('bash', ['-n'], {
            input: step.run.replace(/\$\{\{.*?\}\}/gs, 'workflow-value'),
          });
      }
    }
  }
});

test('Phase 3 dispatch rejects full mode and gates publication on extracted qualification', async () => {
  const caller = await workflow('phase-2-candidate');
  const release = await workflow('phase-3-candidate');
  assert.deepEqual(caller.on.workflow_dispatch.inputs.phase.options, [
    '2',
    '3',
  ]);
  assert.equal(caller.jobs.phase3.if, "inputs.phase == '3'");
  assert.equal(
    caller.jobs.phase3.uses,
    './.github/workflows/phase-3-candidate.yml',
  );
  assert.equal(caller.jobs.phase3.with.mode, '${{ inputs.mode }}');
  for (const name of ['plan', 'validate'])
    assert.equal(caller.jobs[name].if, "inputs.phase != '3'");
  const guard = release.jobs.validate.steps[0];
  for (const mode of ['lab', 'full', '']) {
    let accepted = false;
    try {
      execFileSync('bash', ['-e', '-c', guard.run], {
        env: { ...process.env, BUILD_MODE: mode },
        stdio: 'pipe',
      });
      accepted = true;
    } catch {
      /* The guard must reject unsupported modes. */
    }
    assert.equal(accepted, mode === 'lab');
  }
  assert.equal(release.jobs.publish.needs, 'validate');
  assert.equal(release.jobs.application.needs, 'publish');
  assert.deepEqual(release.jobs.bundle.needs, ['publish', 'application']);
  assert.equal(release.jobs.extracted.needs, 'bundle');
  assert.match(
    release.env.CC_SIGNING_IDENTITY,
    /phase-3-candidate.yml@\$\{\{ github.ref \}\}/,
  );
  for (const job of ['application', 'extracted']) {
    const steps = release.jobs[job].steps;
    const prepare = steps.find(
      (step) => step.name === 'Prepare published image references',
    );
    assert.ok(
      prepare.run.indexOf('cosign verify') < prepare.run.indexOf('docker pull'),
    );
    assert.match(prepare.run, /--certificate-identity="\$CC_SIGNING_IDENTITY"/);
  }
  const steps = release.jobs.extracted.steps;
  const extract = steps.find(
    (step) => step.name === 'Verify and extract the candidate bundle',
  );
  assert.equal((extract.run.match(/cosign verify-blob/g) || []).length, 2);
  assert.ok(
    extract.run.lastIndexOf('cosign verify-blob') <
      extract.run.indexOf('tar --extract'),
  );
  assert.match(extract.run, /loadQualificationBundle/);
  const qualify = steps.findIndex(
    (step) => step.name === 'Qualify extracted Phase 3 installer and restore',
  );
  const bind = steps.findIndex(
    (step) => step.name === 'Bind extracted Phase 3 evidence',
  );
  const publish = steps.findIndex(
    (step) => step.name === 'Publish tested lab release',
  );
  assert.ok(qualify < bind && bind < publish);
  assert.equal(steps[publish].if, undefined);
  assert.match(steps[publish].run, /--prerelease/);
  assert.match(steps[publish].run, /phase-3-lab-/);
  assert.doesNotMatch(steps[publish].run, /--clobber|--latest/);
});

test('published Phase 3 profile checks bind release identity before executing the installer', async (t) => {
  const ci = await workflow('ci');
  assert.equal(
    ci.jobs['phase3-profile'].uses,
    './.github/workflows/phase-3-profile-check.yml',
  );
  assert.equal(
    ci.jobs['phase3-profile'].with.release,
    '${{ inputs.phase3Release }}',
  );
  const profile = await workflow('phase-3-profile-check');
  assert.deepEqual(profile.permissions, { contents: 'read', packages: 'read' });
  const steps = profile.jobs.installation.steps;
  const download = steps.find(
    (step) =>
      step.name === 'Download and verify the published laboratory bundle',
  );
  assert.equal((download.run.match(/cosign verify-blob/g) || []).length, 2);
  assert.ok(
    download.run.lastIndexOf('cosign verify-blob') <
      download.run.indexOf('tar --extract'),
  );
  assert.ok(
    steps.indexOf(download) <
      steps.findIndex(
        (step) => step.name === 'Prepare published image references',
      ),
  );
  assert.equal(
    steps.find((step) => step.name === 'Qualify installed Phase 3 workflows')
      .run,
    'npm exec nx run api-e2e:phase3-install-integration',
  );
  const script = download.run.match(
    /node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/,
  )[1];
  const root = await mkdtemp(join(tmpdir(), 'cc-profile-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of [
    'published-bundle',
    'extracted-candidate',
    'image-evidence',
    'deployment/release',
  ])
    await mkdir(join(root, dir), { recursive: true });
  for (const file of ['qualification.mjs', 'integrity.mjs'])
    await cp(
      `deployment/release/${file}`,
      join(root, 'deployment/release', file),
    );
  const cli = 'fixture installer';
  await writeFile(join(root, 'extracted-candidate/cli.mjs'), cli);
  const manifest = {
    schemaVersion: 1,
    phase: 3,
    sourceRevision: 'a'.repeat(40),
    validationScope: 'lab',
    qualification: 'candidate-only',
    architectures: ['linux/amd64'],
    images: Object.fromEntries(
      [
        ['frontend', 'frontend'],
        ['api', 'api'],
        ['workers', 'worker'],
      ].map(([key, service]) => [
        key,
        `ghcr.io/campuscommander/campus-commander-${service}@sha256:${'b'.repeat(64)}`,
      ]),
    ),
    files: [{ path: 'cli.mjs', sizeBytes: cli.length, sha256: sha256(cli) }],
  };
  const run = async (
    value = manifest,
    release = 'phase-3-lab-' + manifest.sourceRevision.slice(0, 12),
  ) => {
    for (const dir of ['published-bundle', 'extracted-candidate'])
      await writeFile(
        join(root, dir, 'release-manifest.json'),
        JSON.stringify(value),
      );
    return execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: root,
        env: {
          ...process.env,
          RELEASE_TAG: release,
          GITHUB_ENV: join(root, 'env'),
        },
        stdio: 'pipe',
      },
    );
  };
  await run();
  assert.equal(
    await readFile(join(root, 'image-evidence/api.reference'), 'utf8'),
    manifest.images.api + '\n',
  );
  assert.equal(
    await readFile(join(root, 'env'), 'utf8'),
    'CC_AUTH_INSTALLER_ROOT=' + root + '/extracted-candidate\n',
  );
  for (const changed of [
    { ...manifest, phase: 2 },
    { ...manifest, validationScope: 'full' },
    {
      ...manifest,
      images: { ...manifest.images, api: manifest.images.workers },
    },
    {
      ...manifest,
      images: {
        ...manifest.images,
        api: manifest.images.api.replace('ghcr.io', 'ghcrXio'),
      },
    },
    { ...manifest, files: [{ ...manifest.files[0], sha256: 'c'.repeat(64) }] },
  ])
    await assert.rejects(run(changed));
  await assert.rejects(run(manifest, 'phase-3-lab-' + 'c'.repeat(12)));
});

test('upgrade dispatch verifies the pinned baseline before running the delivered upgrade', async (t) => {
  const ci = await workflow('ci');
  const profile = await workflow('phase-3-profile-check');
  assert.equal(ci.on.workflow_dispatch.inputs.phase3Upgrade.default, false);
  assert.equal(
    ci.jobs['phase3-profile'].with.upgrade,
    '${{ inputs.phase3Upgrade == true }}',
  );
  const steps = profile.jobs.installation.steps;
  const baseline = steps.find(
    (step) => step.name === 'Verify the pinned Phase 2 upgrade bundle',
  );
  const upgrade = steps.find(
    (step) => step.name === 'Qualify Phase 2-to-3 upgrade and workflows',
  );
  assert.equal(baseline.if, 'inputs.upgrade');
  assert.equal(upgrade.if, "inputs.profile == 'all-docker' && inputs.upgrade");
  assert.equal(
    upgrade.run,
    'npm exec nx run api-e2e:phase3-upgrade-integration',
  );
  assert.ok(steps.indexOf(baseline) < steps.indexOf(upgrade));
  assert.equal(
    steps.find((step) => step.name === 'Qualify installed Phase 3 workflows')
      .if,
    "inputs.profile == 'all-docker' && inputs.upgrade != true && inputs.faults != true && inputs.lifecycle != true && inputs.updateRelease == ''",
  );
  assert.equal(
    baseline.env.BASELINE_IDENTITY,
    'https://github.com/CampusCommander/campus-commander/.github/workflows/phase-2-candidate.yml@refs/heads/implementation/phase-2-cc-22',
  );
  assert.ok(
    baseline.run.lastIndexOf('cosign verify-blob') <
      baseline.run.indexOf('tar --extract'),
  );
  assert.ok(
    baseline.run.indexOf('cosign verify "$reference"') <
      baseline.run.indexOf('docker pull "$reference"'),
  );
  const script = baseline.run.match(
    /node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/,
  )[1];
  const root = await mkdtemp(join(tmpdir(), 'cc-upgrade-baseline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'deployment/qualification'), { recursive: true });
  await mkdir(join(root, 'published-baseline'));
  await mkdir(join(root, 'bundle'));
  const cli = 'fixture installer';
  const manifest = {
    schemaVersion: 1,
    phase: 2,
    sourceRevision: 'a'.repeat(40),
    architectures: ['linux/amd64'],
    qualification: 'candidate-only',
    images: Object.fromEntries(
      ['api', 'frontend', 'workers'].map((service) => [
        service,
        `ghcr.io/campuscommander/campus-commander-${service === 'workers' ? 'worker' : service}@sha256:${'b'.repeat(64)}`,
      ]),
    ),
    files: [{ path: 'cli.mjs', sizeBytes: cli.length, sha256: sha256(cli) }],
  };
  const manifestBytes = JSON.stringify(manifest);
  const pinned = {
    ...manifest,
    sourceArchiveSha256: sha256('archive'),
    sourceManifestSha256: sha256(manifestBytes),
  };
  const pinPath = join(
    root,
    'deployment/qualification/phase-2-upgrade-baseline.json',
  );
  await writeFile(pinPath, JSON.stringify(pinned));
  await writeFile(
    join(root, 'published-baseline/phase-2-candidate.tar.gz'),
    'archive',
  );
  await writeFile(
    join(root, 'published-baseline/release-manifest.json'),
    manifestBytes,
  );
  const runChecksums = () =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      stdio: 'pipe',
    });
  runChecksums();
  await writeFile(
    join(root, 'published-baseline/phase-2-candidate.tar.gz'),
    'changed',
  );
  assert.throws(runChecksums);
  await writeFile(join(root, 'bundle/release-manifest.json'), manifestBytes);
  await writeFile(join(root, 'bundle/cli.mjs'), cli);
  const moduleUrl = new URL(
    '../../api-e2e/phase3-upgrade-fixture.mjs',
    import.meta.url,
  ).href;
  const runBundle = () =>
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {loadPhase2UpgradeBaseline} from ${JSON.stringify(moduleUrl)};await loadPhase2UpgradeBaseline(process.argv[1]);`,
        join(root, 'bundle'),
      ],
      { cwd: root, stdio: 'pipe' },
    );
  runBundle();
  for (const changed of [
    { ...pinned, sourceManifestSha256: 'c'.repeat(64) },
    { ...pinned, sourceRevision: 'c'.repeat(40) },
    { ...pinned, images: { ...pinned.images, api: pinned.images.frontend } },
  ]) {
    await writeFile(pinPath, JSON.stringify(changed));
    assert.throws(runBundle);
  }
  await writeFile(pinPath, JSON.stringify(pinned));
  await writeFile(join(root, 'bundle/cli.mjs'), 'changed');
  assert.throws(runBundle);
});

test('service fault dispatch rejects upgrade mode before starting containers', async () => {
  const ci = await workflow('ci');
  const profile = await workflow('phase-3-profile-check');
  assert.equal(ci.on.workflow_dispatch.inputs.phase3Faults.default, false);
  assert.equal(
    ci.jobs['phase3-profile'].with.faults,
    '${{ inputs.phase3Faults == true }}',
  );
  const steps = profile.jobs.installation.steps;
  const guard = steps[0];
  for (const [upgrade, faults, success] of [
    ['false', 'false', true],
    ['true', 'false', true],
    ['false', 'true', true],
    ['true', 'true', false],
  ]) {
    const run = () =>
      execFileSync('bash', ['-e', '-c', guard.run], {
        env: {
          ...process.env,
          UPGRADE: upgrade,
          FAULTS: faults,
          FAULT_KIND: 'services',
        },
        stdio: 'pipe',
      });
    if (success) assert.doesNotThrow(run);
    else assert.throws(run);
  }
  assert.throws(() =>
    execFileSync('bash', ['-e', '-c', guard.run], {
      env: {
        ...process.env,
        UPGRADE: 'false',
        FAULTS: 'true',
        FAULT_KIND: 'unknown',
      },
      stdio: 'pipe',
    }),
  );
  assert.doesNotThrow(() =>
    execFileSync('bash', ['-e', '-c', guard.run], {
      env: {
        ...process.env,
        UPGRADE: 'false',
        FAULTS: 'true',
        FAULT_KIND: 'provider',
      },
      stdio: 'pipe',
    }),
  );
  assert.doesNotThrow(() =>
    execFileSync('bash', ['-e', '-c', guard.run], {
      env: {
        ...process.env,
        UPGRADE: 'false',
        FAULTS: 'true',
        FAULT_KIND: 'certificates',
      },
      stdio: 'pipe',
    }),
  );
  assert.doesNotThrow(() =>
    execFileSync('bash', ['-e', '-c', guard.run], {
      env: {
        ...process.env,
        UPGRADE: 'false',
        FAULTS: 'true',
        FAULT_KIND: 'capacity',
      },
      stdio: 'pipe',
    }),
  );
  const capacity = steps.find(
    (step) => step.name === 'Qualify Phase 3 capacity failure',
  );
  assert.equal(
    capacity.if,
    "inputs.profile == 'all-docker' && inputs.faults && inputs.faultKind == 'capacity'",
  );
  assert.equal(
    capacity.run,
    'npm exec nx run api-e2e:phase3-capacity-fault-integration',
  );
  const certificates = steps.find(
    (step) => step.name === 'Qualify Phase 3 certificate failures',
  );
  assert.equal(
    certificates.if,
    "inputs.profile == 'all-docker' && inputs.faults && inputs.faultKind == 'certificates'",
  );
  assert.equal(
    certificates.run,
    'npm exec nx run api-e2e:phase3-certificate-fault-integration',
  );
  const provider = steps.find(
    (step) => step.name === 'Qualify Phase 3 provider failures',
  );
  assert.equal(
    provider.if,
    "inputs.profile == 'all-docker' && inputs.faults && inputs.faultKind == 'provider'",
  );
  assert.equal(
    provider.run,
    'npm exec nx run api-e2e:phase3-provider-fault-integration',
  );
  const fault = steps.find(
    (step) => step.name === 'Qualify Phase 3 service interruptions',
  );
  assert.equal(
    fault.if,
    "inputs.profile == 'all-docker' && inputs.faults && inputs.faultKind == 'services'",
  );
  assert.equal(fault.run, 'npm exec nx run api-e2e:phase3-fault-integration');
  assert.ok(
    steps.indexOf(fault) >
      steps.findIndex(
        (step) => step.name === 'Prepare published image references',
      ),
  );
});

test('lifecycle and guided update dispatch exclude simultaneous qualification modes', async () => {
  const ci = await workflow('ci');
  const profile = await workflow('phase-3-profile-check');
  assert.equal(ci.on.workflow_dispatch.inputs.phase3Lifecycle.default, false);
  assert.equal(
    ci.jobs['phase3-profile'].with.lifecycle,
    '${{ inputs.phase3Lifecycle == true }}',
  );
  const steps = profile.jobs.installation.steps;
  const selected = steps.find(
    (step) => step.name === 'Qualify Phase 3 installer lifecycle',
  );
  assert.equal(selected.if, 'inputs.lifecycle');
  assert.equal(
    selected.run,
    'npm exec nx run api-e2e:phase3-lifecycle-integration',
  );
  for (const upgrade of [false, true])
    for (const faults of [false, true])
      for (const lifecycle of [false, true])
        for (const update of [false, true]) {
          const run = () =>
            execFileSync('bash', ['-e', '-c', steps[0].run], {
              env: {
                ...process.env,
                UPGRADE: String(upgrade),
                FAULTS: String(faults),
                LIFECYCLE: String(lifecycle),
                UPDATE_RELEASE: update ? 'phase-3-lab-' + 'a'.repeat(12) : '',
                FAULT_KIND: 'services',
              },
              stdio: 'pipe',
            });
          if ([upgrade, faults, lifecycle, update].filter(Boolean).length <= 1)
            assert.doesNotThrow(run);
          else assert.throws(run);
        }
});

test('guided update verifies both target blobs and images before executing the delivered update', async () => {
  const ci = await workflow('ci');
  const profile = await workflow('phase-3-profile-check');
  assert.equal(
    ci.jobs['phase3-profile'].with.updateRelease,
    "${{ inputs.phase3UpdateRelease || '' }}",
  );
  const steps = profile.jobs.installation.steps;
  const download = steps.find(
    (s) => s.name === 'Download and verify the guided update bundle',
  );
  const images = steps.find(
    (s) => s.name === 'Prepare guided update image references',
  );
  const execute = steps.find((s) => s.name === 'Qualify Phase 3 guided update');
  for (const step of [download, images, execute])
    assert.equal(step.if, "inputs.updateRelease != ''");
  assert.equal((download.run.match(/cosign verify-blob/g) || []).length, 2);
  assert.ok(
    download.run.lastIndexOf('cosign verify-blob') <
      download.run.indexOf('tar --extract'),
  );
  assert.ok(download.run.includes('assert.notEqual(manifest.sourceRevision'));
  assert.ok(download.run.includes('CC_AUTH_UPDATE_INSTALLER_ROOT='));
  assert.ok(images.run.includes('cosign verify "$reference"'));
  assert.ok(!images.run.includes('GITHUB_ENV'));
  assert.ok(steps.indexOf(download) < steps.indexOf(images));
  assert.ok(steps.indexOf(images) < steps.indexOf(execute));
  assert.equal(
    execute.run,
    'npm exec nx run api-e2e:phase3-update-integration',
  );
  assert.ok(
    steps
      .find((s) => s.name === 'Qualify installed Phase 3 workflows')
      .if.includes("inputs.updateRelease == ''"),
  );
});

test('Phase 3 assembly downloads the successful application artifact by job output ID', async () => {
  const candidate = await workflow('phase-3-candidate');
  const application = candidate.jobs.application;
  const upload = application.steps.find(
    (step) => step.id === 'application-evidence',
  );
  assert.ok(upload.uses.startsWith('actions/upload-artifact@'));
  assert.equal(
    upload.with.name,
    'qualification-phase3-auth-integration-${{ github.run_attempt }}',
  );
  assert.equal(
    application.outputs['evidence-artifact-id'],
    '${{ steps.application-evidence.outputs.artifact-id }}',
  );
  assert.ok(candidate.jobs.bundle.needs.includes('application'));
  const download = candidate.jobs.bundle.steps.find(
    (step) => step.with?.['artifact-ids'],
  );
  assert.equal(
    download.with['artifact-ids'],
    '${{ needs.application.outputs.evidence-artifact-id }}',
  );
  assert.equal(
    download.with.path,
    'qualification-evidence/qualification-phase3-auth-integration',
  );
  assert.equal(download.with['merge-multiple'], true);
  const guard = candidate.jobs.bundle.steps.find(
    (step) => step.name === 'Require the successful application artifact',
  );
  for (const id of ['', 'invalid', '1,2', '0'])
    assert.throws(() =>
      execFileSync('bash', ['-e', '-c', guard.run], {
        env: { ...process.env, EVIDENCE_ARTIFACT_ID: id },
        stdio: 'pipe',
      }),
    );
  assert.doesNotThrow(() =>
    execFileSync('bash', ['-e', '-c', guard.run], {
      env: { ...process.env, EVIDENCE_ARTIFACT_ID: '10498771741' },
      stdio: 'pipe',
    }),
  );
  assert.equal(download.with.pattern, undefined);
  assert.equal(download.with.name, undefined);
});

test('Phase 3 hybrid dispatch verifies signed images and rejects unsupported mode combinations', async () => {
  const ci = await workflow('ci');
  const profile = await workflow('phase-3-profile-check');
  assert.deepEqual(ci.on.workflow_dispatch.inputs.phase3Profile.options, [
    'all-docker',
    'hybrid',
  ]);
  assert.equal(
    ci.jobs['phase3-profile'].with.profile,
    "${{ inputs.phase3Profile || 'all-docker' }}",
  );
  assert.equal(profile.on.workflow_call.inputs.profile.default, 'all-docker');
  const steps = profile.jobs.installation.steps;
  const hybrid = steps.find(
    (s) => s.name === 'Qualify installed Phase 3 hybrid workflows',
  );
  assert.equal(
    hybrid.if,
    "inputs.profile == 'hybrid' && inputs.upgrade != true && inputs.restore != true && inputs.faults != true",
  );
  const hybridUpgrade = steps.find(
    (s) => s.name === 'Qualify Phase 2-to-3 hybrid upgrade',
  );
  assert.equal(
    hybridUpgrade.if,
    "inputs.profile == 'hybrid' && inputs.upgrade",
  );
  assert.match(hybridUpgrade.run, /CC_AUTH_BASELINE_INSTALLER_ROOT/);
  assert.match(hybridUpgrade.run, /sudo -H -u '#1000' -g '#1000'/);
  assert.match(hybridUpgrade.run, /api-e2e:phase3-hybrid-upgrade-integration/);
  assert.equal(hybridUpgrade.env.NX_DAEMON, 'false');
  assert.match(hybrid.run, /sudo -H -u '#1000' -g '#1000'/);
  assert.match(hybrid.run, /CC_AUTH_INSTALLER_ROOT/);
  assert.match(hybrid.run, /PLAYWRIGHT_BROWSERS_PATH,DOCKER_CONFIG/);
  assert.match(
    hybrid.run,
    /npm exec nx run api-e2e:phase3-hybrid-install-integration/,
  );
  assert.equal(hybrid.env.NX_DAEMON, 'false');
  const account = steps.find(
    (s) => s.name === 'Prepare the shared-storage fixture account',
  );
  const restore = steps.find((s) => s.name === 'Restore evidence ownership');
  const browsers = steps.find(
    (s) => s.name === 'Select shared browser storage',
  );
  assert.equal(account?.if, "inputs.profile == 'hybrid'");
  assert.match(account.run, /sudo chown -R 1000:1000/);
  assert.match(account.run, /sudo setfacl -m u:1000:rw/);
  assert.match(account.run, /sudo setfacl -m u:1000:x/);
  assert.match(account.run, /DOCKER_CONFIG/);
  assert.equal(restore?.if, "always() && inputs.profile == 'hybrid'");
  assert.match(restore.run, /sudo chown -R "\$\(id -u\):\$\(id -g\)"/);
  assert.match(browsers?.run, /PLAYWRIGHT_BROWSERS_PATH/);
  assert.ok(
    steps.indexOf(browsers) <
      steps.findIndex(
        (s) => s.run === 'npx playwright install --with-deps chromium',
      ),
  );
  assert.ok(steps.indexOf(account) < steps.indexOf(hybrid));
  assert.ok(steps.indexOf(restore) > steps.indexOf(hybrid));
  assert.ok(
    steps.indexOf(hybrid) >
      steps.findIndex((s) => s.name === 'Prepare published image references'),
  );
  const upload = steps.find((s) =>
    s.uses?.startsWith('actions/upload-artifact@'),
  );
  assert.ok(
    upload.with.name.startsWith(
      "${{ inputs.profile == 'hybrid' && inputs.restore && 'phase-3-hybrid-restore'",
    ),
  );
  assert.ok(
    upload.with.path.startsWith(
      "${{ inputs.profile == 'hybrid' && inputs.restore && 'dist/phase-3-hybrid-restore/'",
    ),
  );
  for (const selectedProfile of ['hybrid', 'invalid'])
    for (const upgrade of [false, true])
      for (const faults of [false, true])
        for (const lifecycle of [false, true])
          for (const update of [false, true]) {
            const run = () =>
              execFileSync('bash', ['-e', '-c', steps[0].run], {
                env: {
                  ...process.env,
                  PROFILE: selectedProfile,
                  UPGRADE: String(upgrade),
                  FAULTS: String(faults),
                  LIFECYCLE: String(lifecycle),
                  UPDATE_RELEASE: update ? 'phase-3-lab-' + 'a'.repeat(12) : '',
                  FAULT_KIND: 'services',
                },
                stdio: 'pipe',
              });
            if (
              selectedProfile === 'hybrid' &&
              ![lifecycle, update].some(Boolean) &&
              !(upgrade && faults)
            )
              assert.doesNotThrow(run);
            else assert.throws(run);
          }
});

test('Hybrid restore dispatch rejects mixed modes and selects its own evidence', async () => {
  const ci = await workflow('ci');
  const profile = await workflow('phase-3-profile-check');
  assert.equal(ci.on.workflow_dispatch.inputs.phase3Restore.default, false);
  assert.equal(
    ci.jobs['phase3-profile'].with.restore,
    '${{ inputs.phase3Restore == true }}',
  );
  assert.equal(profile.on.workflow_call.inputs.restore.default, false);
  const steps = profile.jobs.installation.steps;
  const restore = steps.find(
    (step) => step.name === 'Qualify isolated Phase 3 hybrid restore',
  );
  assert.equal(restore.if, "inputs.profile == 'hybrid' && inputs.restore");
  assert.match(restore.run, /api-e2e:phase3-hybrid-restore-integration/);
  assert.match(restore.run, /sudo -H -u '#1000' -g '#1000'/);
  assert.match(restore.run, /CC_AUTH_INSTALLER_ROOT/);
  assert.equal(restore.env.NX_DAEMON, 'false');
  for (const selectedProfile of ['hybrid', 'all-docker', 'invalid'])
    for (const upgrade of [false, true])
      for (const faults of [false, true])
        for (const lifecycle of [false, true])
          for (const update of [false, true]) {
            const run = () =>
              execFileSync('bash', ['-e', '-c', steps[0].run], {
                env: {
                  ...process.env,
                  PROFILE: selectedProfile,
                  RESTORE: 'true',
                  UPGRADE: String(upgrade),
                  FAULTS: String(faults),
                  LIFECYCLE: String(lifecycle),
                  UPDATE_RELEASE: update ? 'phase-3-lab-' + 'a'.repeat(12) : '',
                  FAULT_KIND: 'services',
                },
                stdio: 'pipe',
              });
            if (
              selectedProfile === 'hybrid' &&
              ![upgrade, faults, lifecycle, update].some(Boolean)
            )
              assert.doesNotThrow(run);
            else assert.throws(run);
          }
});

test('Hybrid faults use their own targets and reject unsupported fault kinds', async () => {
  const profile = await workflow('phase-3-profile-check');
  const steps = profile.jobs.installation.steps;
  const fault = steps.find(
    (step) => step.name === 'Qualify Phase 3 hybrid service interruptions',
  );
  assert.equal(
    fault.if,
    "inputs.profile == 'hybrid' && inputs.faults && inputs.faultKind == 'services'",
  );
  assert.match(fault.run, /api-e2e:phase3-hybrid-fault-integration/);
  assert.match(fault.run, /sudo -H -u '#1000' -g '#1000'/);
  assert.match(fault.run, /CC_AUTH_INSTALLER_ROOT/);
  assert.equal(fault.env.NX_DAEMON, 'false');
  const certificate = steps.find(
    (step) => step.name === 'Qualify Phase 3 hybrid certificate failures',
  );
  assert.equal(
    certificate.if,
    "inputs.profile == 'hybrid' && inputs.faults && inputs.faultKind == 'certificates'",
  );
  assert.match(
    certificate.run,
    /api-e2e:phase3-hybrid-certificate-fault-integration/,
  );
  assert.match(certificate.run, /sudo -H -u '#1000' -g '#1000'/);
  assert.equal(certificate.env.NX_DAEMON, 'false');
  const upload = steps.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  assert.ok(
    upload.with.name.includes(
      "inputs.profile == 'hybrid' && inputs.faults && 'phase-3-hybrid-service-faults'",
    ),
  );
  assert.ok(
    upload.with.path.includes(
      "inputs.profile == 'hybrid' && inputs.faults && 'dist/phase-3-hybrid-faults/'",
    ),
  );
  assert.ok(
    upload.with.name.includes(
      "inputs.profile == 'hybrid' && inputs.faults && inputs.faultKind == 'certificates' && 'phase-3-hybrid-certificate-faults'",
    ),
  );
  assert.ok(
    upload.with.path.includes(
      "inputs.profile == 'hybrid' && inputs.faults && inputs.faultKind == 'certificates' && 'dist/phase-3-hybrid-certificate-faults/'",
    ),
  );
  const capacity = steps.find(
    (step) => step.name === 'Qualify Phase 3 hybrid capacity failure',
  );
  assert.equal(
    capacity.if,
    "inputs.profile == 'hybrid' && inputs.faults && inputs.faultKind == 'capacity'",
  );
  assert.match(
    capacity.run,
    /api-e2e:phase3-hybrid-capacity-fault-integration/,
  );
  assert.match(capacity.run, /sudo -H -u '#1000' -g '#1000'/);
  assert.equal(capacity.env.NX_DAEMON, 'false');
  assert.ok(
    upload.with.name.includes(
      "inputs.profile == 'hybrid' && inputs.faults && inputs.faultKind == 'capacity' && 'phase-3-hybrid-capacity-faults'",
    ),
  );
  assert.ok(
    upload.with.path.includes(
      "inputs.profile == 'hybrid' && inputs.faults && inputs.faultKind == 'capacity' && 'dist/phase-3-hybrid-capacity-faults/'",
    ),
  );
  for (const kind of [
    'services',
    'provider',
    'certificates',
    'capacity',
    'unknown',
  ]) {
    const run = () =>
      execFileSync('bash', ['-e', '-c', steps[0].run], {
        env: {
          ...process.env,
          PROFILE: 'hybrid',
          UPGRADE: 'false',
          RESTORE: 'false',
          FAULTS: 'true',
          FAULT_KIND: kind,
          LIFECYCLE: 'false',
          UPDATE_RELEASE: '',
        },
        stdio: 'pipe',
      });
    if (['services', 'certificates', 'capacity'].includes(kind))
      assert.doesNotThrow(run);
    else assert.throws(run);
  }
});
