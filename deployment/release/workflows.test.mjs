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
