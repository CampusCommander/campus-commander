import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, matchesGlob } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { applicationReports } from './application-evidence.mjs';
import { bundleTargets } from './bundle-qualification.mjs';

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
      "inputs.phase3Only != true && (github.event_name == 'push' || inputs.full == true)",
    );
  assert.equal(ci.jobs['phase3-authorization'].if, 'inputs.phase3Only == true');
  assert.equal(ci.jobs.main.if, 'inputs.phase3Only != true');
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
  for (const name of ['ci', 'phase-2-candidate']) {
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
