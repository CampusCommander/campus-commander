import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assembleCandidate } from './candidate.mjs';
import { inspectPhase3Evidence } from './phase3-evidence.mjs';
import { sha256, verifyReleaseFiles } from './integrity.mjs';
import { assembleQualifiedRelease } from './qualified.mjs';
import { phase3ProtectedRoutes } from '../qualification/phase3-routes.mjs';
import { phase3BrowserEvidence } from './phase3-browser-evidence.mjs';

async function fixture(root) {
  await mkdir(join(root, 'deployment/release/runtime'), { recursive: true });
  await mkdir(join(root, 'dist/deployment'), { recursive: true });
  await mkdir(join(root, 'artifacts'));
  const pkg = { name: 'fixture', version: '1.0.0', dependencies: {} };
  await writeFile(
    join(root, 'deployment/release/runtime/package.json'),
    JSON.stringify(pkg),
  );
  await writeFile(
    join(root, 'deployment/release/runtime/package-lock.json'),
    JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { '': pkg } }),
  );
  await writeFile(join(root, 'LICENSE.md'), 'Synthetic license');
  await writeFile(join(root, 'install.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(join(root, 'install.sh'), 0o751);
  await writeFile(
    join(root, 'dist/deployment/runtime.mjs'),
    'export const phase = 3;\n',
  );
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync(
    'git',
    ['add', 'LICENSE.md', 'install.sh', 'deployment/release/runtime'],
    { cwd: root },
  );
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'Synthetic Phase 3 source',
    ],
    { cwd: root },
  );
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const images = {};
  for (const name of ['frontend', 'api', 'worker']) {
    const ref = `ghcr.io/campuscommander/campus-commander-${name}@sha256:${'a'.repeat(64)}`;
    images[name === 'worker' ? 'workers' : name] = ref;
    await writeFile(join(root, `artifacts/${name}.reference`), ref);
    for (const suffix of [
      'spdx.json',
      'verification.json',
      'vulnerabilities.json',
    ])
      await writeFile(join(root, `artifacts/${name}.${suffix}`), '{}');
  }
  const directory = join(
    root,
    'evidence/qualification-phase3-auth-integration',
  );
  await mkdir(directory, { recursive: true });
  const reports = {
    'packaged-integration.json': {
      phase: 3,
      status: 'passed',
      sourceRevision,
      packagedApplicationImages: true,
      images,
      checks: ['packaged authorization'],
    },
    'phase3-route-security.json': {
      schemaVersion: 1,
      sourceRevision,
      routes: phase3ProtectedRoutes.length,
      checks: phase3ProtectedRoutes.flatMap(([method, path]) =>
        [
          ['missing-session', 401],
          ...(method === 'POST'
            ? [
                ['missing-csrf', 403],
                ['wrong-origin', 403],
                ['wrong-content-type', 403],
                ['valid-browser-checks-invalid-input-or-action', 400],
              ]
            : []),
        ].map(([boundary, status]) => ({
          route: `${method} ${path}`,
          boundary,
          status,
        })),
      ),
    },
  };
  for (const name of [
    'google-connection-api',
    'google-connection-browser',
    'google-connection-worker',
    'customer-settings',
    'google-health-api',
    'google-lifecycle-api',
    'invitations-browser',
    'platform-access-api',
    'platform-access-browser',
    'access-revocation-api',
    'access-revocation-browser',
    'school-references-api',
    'school-definitions-api',
  ])
    reports[`${name}.json`] = { schemaVersion: 1, checks: ['synthetic check'] };
  const scanner = {
    schemaVersion: 1,
    status: 'passed',
    sourceRevision,
    secretCategories: Object.fromEntries(
      [
        'service-account-key',
        'browser-cookie',
        'response-secret',
        'authorization-code',
        'provider-secret',
        'deployment-secret',
        'invitation-token',
        'redis-operator-password',
        'tls-private-key',
        'operator-credential',
        'operator-authorization',
        'authorization-state',
        'identity-nonce',
        'pkce-challenge',
        'identity-token',
        'pairing-code',
        'worker-dispatch',
        'service-authorization',
      ].map((name) => [name, 1]),
    ),
    scannedSources: ['api', 'worker', 'kestra', 'audit', 'support'],
    screenshotChecks: phase3BrowserEvidence.filter((name) =>
      name.endsWith('.png'),
    ).length,
    files: [],
  };
  for (const name of phase3BrowserEvidence.filter((name) =>
    name.endsWith('.json'),
  ))
    reports[name] = {
      name: name.replace('-accessibility.json', ''),
      engine: { name: 'axe-core' },
      violations: [],
      passedRuleIds: ['button-name'],
      accessibilityTree: 'Synthetic tree',
    };
  const save = async () => {
    scanner.files = [];
    for (const [name, report] of Object.entries(reports)) {
      const bytes = JSON.stringify(report);
      await writeFile(join(directory, name), bytes);
      scanner.files.push({ name, sha256: sha256(bytes) });
    }
    const bytes = Buffer.from('synthetic screenshot bytes');
    for (const name of phase3BrowserEvidence.filter((name) =>
      name.endsWith('.png'),
    )) {
      await writeFile(join(directory, name), bytes);
      scanner.files.push({ name, sha256: sha256(bytes) });
    }
    await writeFile(
      join(directory, 'evidence-redaction.json'),
      JSON.stringify(scanner),
    );
  };
  await save();
  return { directory, sourceRevision, images, reports, scanner, save };
}

test('Phase 3 assembly binds scanned packaged evidence and retains unqualified profile gates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-phase3-candidate-'));
  try {
    const f = await fixture(root);
    const output = join(root, 'candidate');
    const options = {
      root,
      output,
      artifacts: join(root, 'artifacts'),
      qualificationArtifacts: join(root, 'evidence'),
      sourceRevision: f.sourceRevision,
      phase: 3,
      mode: 'lab',
    };
    const manifest = await assembleCandidate(options);
    assert.equal(manifest.phase, 3);
    assert.equal(manifest.qualification, 'candidate-only');
    assert.equal(manifest.validationScope, 'lab');
    for (const profile of Object.values(manifest.evidence))
      for (const result of Object.values(profile))
        assert.equal(result.status, 'not-run');
    await verifyReleaseFiles(output, manifest);
    assert.equal((await stat(join(output, 'install.sh'))).mode & 0o777, 0o751);
    for (const { name, sha256: digest } of f.scanner.files) {
      const reference = manifest.applicationEvidence[name];
      assert.equal(reference.reportSha256, digest);
      assert.equal(
        sha256(await readFile(join(output, reference.reportPath))),
        digest,
      );
    }
    await assert.rejects(
      assembleCandidate({
        ...options,
        output: join(root, 'full'),
        mode: 'full',
      }),
      /profile qualification/,
    );
    await assert.rejects(
      assembleQualifiedRelease({
        candidateRoot: output,
        qualifications: join(root, 'qualifications'),
        output: join(root, 'qualified'),
        sourceRevision: f.sourceRevision,
      }),
      /Lab builds require a full qualification run/,
    );
    for (const mutate of [
      () => {
        f.reports['packaged-integration.json'].phase = 2;
      },
      () => {
        f.reports['packaged-integration.json'].packagedApplicationImages =
          false;
      },
      () => {
        f.reports['packaged-integration.json'].sourceRevision = 'b'.repeat(40);
      },
      () => {
        f.reports['packaged-integration.json'].images = {};
      },
      () => {
        delete f.reports['school-definitions-api.json'];
      },
      () => {
        f.reports['platform-access-api.json'].status = 'failed';
      },
      () => {
        f.scanner.status = 'failed';
      },
      () => {
        f.scanner.sourceRevision = 'b'.repeat(40);
      },
      () => {
        f.scanner.secretCategories['service-account-key'] = 0;
      },
      () => {
        delete f.scanner.secretCategories['redis-operator-password'];
      },
      () => {
        f.scanner.secretCategories['redis-operator-password'] = 0;
      },
      () => {
        delete f.reports['school-draft-light-accessibility.json'];
      },
      () => {
        f.reports[
          'google-connection-review-light-accessibility.json'
        ].violations = [{ id: 'button-name' }];
      },
      () => {
        f.reports['phase3-route-security.json'].checks[0].status = 200;
      },
      () => {
        f.reports['phase3-route-security.json'].checks.pop();
      },
      () => {
        const checks = f.reports['phase3-route-security.json'].checks;
        checks[1] = { ...checks[0] };
      },
    ]) {
      const reports = structuredClone(f.reports),
        scanner = structuredClone(f.scanner);
      mutate();
      await f.save();
      await assert.rejects(inspectPhase3Evidence(f.directory, f));
      for (const key of Object.keys(f.reports)) delete f.reports[key];
      Object.assign(f.reports, reports);
      Object.assign(f.scanner, scanner);
    }
    await f.save();
    f.scanner.files = f.scanner.files.filter(
      ({ name }) => name !== 'scoped-grants-light.png',
    );
    f.scanner.screenshotChecks--;
    await writeFile(
      join(f.directory, 'evidence-redaction.json'),
      JSON.stringify(f.scanner),
    );
    await assert.rejects(inspectPhase3Evidence(f.directory, f));
    f.scanner.screenshotChecks++;
    await f.save();
    await writeFile(join(f.directory, 'customer-settings.json'), '{}');
    await assert.rejects(inspectPhase3Evidence(f.directory, f));
    await f.save();
    f.scanner.files.push({ name: '../outside.json', sha256: 'a'.repeat(64) });
    await writeFile(
      join(f.directory, 'evidence-redaction.json'),
      JSON.stringify(f.scanner),
    );
    await assert.rejects(inspectPhase3Evidence(f.directory, f));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
