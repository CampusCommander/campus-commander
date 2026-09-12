import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { applicationReports, assembleCandidate } from './candidate.mjs';
import { assertReleaseEvidence, verifyReleaseFiles } from './integrity.mjs';

test('candidate inventory excludes untracked secrets and cannot pass release qualification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-candidate-'));
  try {
    await mkdir(join(root, 'deployment'));
    await mkdir(join(root, 'dist/deployment'), { recursive: true });
    await mkdir(join(root, 'artifacts'));
    await mkdir(join(root, 'deployment/release/runtime'), { recursive: true });
    await writeFile(
      join(root, 'deployment/release/runtime/package.json'),
      '{"name":"fixture","version":"1.0.0","dependencies":{}}',
    );
    await writeFile(
      join(root, 'deployment/release/runtime/package-lock.json'),
      '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}',
    );
    await writeFile(
      join(root, 'deployment/runtime.mjs'),
      'export const phase = 1;\n',
    );
    await writeFile(join(root, 'deployment/private-token'), 'do-not-publish');
    await writeFile(
      join(root, 'dist/deployment/cli.js'),
      'export const schema = 1;\n',
    );
    await writeFile(join(root, 'LICENSE.md'), 'Synthetic test license\n');
    await writeFile(join(root, 'install.sh'), '#!/bin/sh\nexit 0\n');
    execFileSync('git', ['init', '--quiet', root]);
    execFileSync(
      'git',
      [
        'add',
        'LICENSE.md',
        'install.sh',
        'deployment/runtime.mjs',
        'deployment/release/runtime/package.json',
        'deployment/release/runtime/package-lock.json',
      ],
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
        'Synthetic release fixture',
      ],
      { cwd: root },
    );
    const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    for (const service of ['frontend', 'api', 'worker']) {
      await writeFile(
        join(root, `artifacts/${service}.reference`),
        `ghcr.io/campuscommander/campus-commander-${service}@sha256:${'a'.repeat(64)}\n`,
      );
      for (const suffix of ['spdx.json', 'verification.json'])
        await writeFile(join(root, `artifacts/${service}.${suffix}`), '{}');
    }
    const output = join(root, 'bundle');
    const manifest = await assembleCandidate({
      root,
      output,
      artifacts: join(root, 'artifacts'),
      sourceRevision,
    });
    assert.equal(
      manifest.files.some((file) => file.path.includes('private-token')),
      false,
    );
    for (const path of ['LICENSE.md', 'install.sh'])
      assert.ok(manifest.files.some((file) => file.path === path));
    await verifyReleaseFiles(output, manifest);
    assert.throws(
      () => assertReleaseEvidence(manifest),
      /matching profile evidence/,
    );
    await assert.rejects(
      assembleCandidate({
        root,
        output: join(root, 'phase2-missing-scans'),
        artifacts: join(root, 'artifacts'),
        sourceRevision,
        phase: 2,
      }),
      { code: 'ENOENT' },
    );
    for (const service of ['frontend', 'api', 'worker']) {
      await writeFile(
        join(root, `artifacts/${service}.vulnerabilities.json`),
        JSON.stringify({ ArtifactName: service, Results: [] }),
      );
    }
    const phase2Output = join(root, 'phase2-bundle');
    const qualificationArtifacts = join(root, 'qualifications');
    for (const [target, filename] of Object.entries(applicationReports)) {
      const directory = join(qualificationArtifacts, `qualification-${target}`);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, filename),
        JSON.stringify({
          status: [
            'hybrid-integration',
            'hybrid-upgrade-integration',
            'kubernetes-integration',
            'kubernetes-upgrade-integration',
          ].includes(target)
            ? 'PASS'
            : 'passed',
          application: { status: 'passed' },
          upgrade: {
            status: 'passed',
            runtimeImageContentVerified: true,
            encryptedBackup: { status: 'verified' },
          },
          profile: 'hybrid',
          faults: {
            status: 'passed',
            recoveryBoundSeconds: 180,
            cases: [
              'api-interruption',
              'worker-host-interruption',
              'external-redis-interruption',
              'external-postgresql-interruption',
              'kestra-interruption',
              'shared-artifact-access-loss',
            ].map((name) => ({ name, status: 'passed', recoveryMs: 1000 })),
          },
          browser: { status: 'passed' },
          packagedApplicationImages: true,
          images: manifest.images,
          sourceRevision,
          ownedResourcesRemoved: true,
          hosts: [
            { role: 'controller', daemonId: 'controller' },
            { role: 'worker-1', daemonId: 'worker-1' },
            { role: 'worker-2', daemonId: 'worker-2' },
          ],
        }),
      );
    }
    for (const filename of [
      'login-accessibility.json',
      'account-accessibility.json',
      'diagnostics-light-accessibility.json',
      'diagnostics-dark-accessibility.json',
      'diagnostics-light.png',
      'diagnostics-dark.png',
    ])
      await writeFile(
        join(
          qualificationArtifacts,
          'qualification-auth-image-integration',
          filename,
        ),
        'synthetic evidence',
      );
    const phase2 = await assembleCandidate({
      root,
      output: phase2Output,
      artifacts: join(root, 'artifacts'),
      sourceRevision,
      phase: 2,
      qualificationArtifacts,
    });
    assert.equal(phase2.phase, 2);
    for (const service of ['frontend', 'api', 'worker']) {
      const path = `provenance/${service}.vulnerabilities.json`;
      assert.ok(phase2.files.some((file) => file.path === path));
      assert.deepEqual(
        await readFile(join(phase2Output, path)),
        await readFile(join(root, `artifacts/${service}.vulnerabilities.json`)),
      );
    }
    await verifyReleaseFiles(phase2Output, phase2);
    assert.equal(
      Object.keys(phase2.applicationEvidence).length,
      Object.keys(applicationReports).length,
    );
    for (const target of [
      'hybrid-cli-integration',
      'hybrid-cli-upgrade-integration',
    ])
      assert.ok(
        phase2.applicationEvidence[target],
        'Distributed CLI evidence must enter the signed inventory.',
      );
    const distributedPath = join(
      qualificationArtifacts,
      'qualification-hybrid-cli-upgrade-integration',
      'hybrid-cli-upgrade.json',
    );
    const distributed = JSON.parse(await readFile(distributedPath, 'utf8'));
    for (const [name, change] of [
      ['mixed-source', { sourceRevision: '0'.repeat(40) }],
      ['incomplete-cleanup', { ownedResourcesRemoved: false }],
      [
        'shared-host',
        {
          hosts: distributed.hosts.map((host) => ({
            ...host,
            daemonId: 'same-daemon',
          })),
        },
      ],
      ['missing-backup', { upgrade: { status: 'passed' } }],
    ]) {
      await writeFile(
        distributedPath,
        JSON.stringify({ ...distributed, ...change }),
      );
      await assert.rejects(
        assembleCandidate({
          root,
          output: join(root, name),
          artifacts: join(root, 'artifacts'),
          sourceRevision,
          phase: 2,
          qualificationArtifacts,
        }),
        /Distributed CLI qualification/,
      );
    }
    await writeFile(distributedPath, JSON.stringify(distributed));
    const faultPath = join(
      qualificationArtifacts,
      'qualification-hybrid-cli-process-fault-integration',
      'hybrid-cli-process-faults.json',
    );
    const faultReport = JSON.parse(await readFile(faultPath, 'utf8'));
    const incompleteFaultReport = structuredClone(faultReport);
    incompleteFaultReport.faults.cases.pop();
    await writeFile(faultPath, JSON.stringify(incompleteFaultReport));
    await assert.rejects(
      assembleCandidate({
        root,
        output: join(root, 'missing-process-fault'),
        artifacts: join(root, 'artifacts'),
        sourceRevision,
        phase: 2,
        qualificationArtifacts,
      }),
      /every interruption and recovery case/,
    );
    for (const [index, mutate] of [
      (report) => {
        delete report.faults.recoveryBoundSeconds;
      },
      (report) => {
        report.faults.recoveryBoundSeconds = 181;
      },
      (report) => {
        delete report.faults.cases[0].recoveryMs;
      },
      (report) => {
        report.faults.cases[0].recoveryMs = 180001;
      },
    ].entries()) {
      const invalid = structuredClone(faultReport);
      mutate(invalid);
      await writeFile(faultPath, JSON.stringify(invalid));
      await assert.rejects(
        assembleCandidate({
          root,
          output: join(root, `invalid-fault-timing-${index}`),
          artifacts: join(root, 'artifacts'),
          sourceRevision,
          phase: 2,
          qualificationArtifacts,
        }),
        /recovery timing/,
      );
    }
    await writeFile(faultPath, JSON.stringify(faultReport));
    const upgradeReportPath = join(
      qualificationArtifacts,
      'qualification-hybrid-upgrade-integration',
      'hybrid-upgrade.json',
    );
    const upgradeReport = await readFile(upgradeReportPath, 'utf8');
    const unverifiedUpgrade = JSON.parse(upgradeReport);
    delete unverifiedUpgrade.upgrade.runtimeImageContentVerified;
    await writeFile(upgradeReportPath, JSON.stringify(unverifiedUpgrade));
    await assert.rejects(
      assembleCandidate({
        root,
        output: join(root, 'phase2-unverified-upgrade'),
        artifacts: join(root, 'artifacts'),
        sourceRevision,
        phase: 2,
        qualificationArtifacts,
      }),
      /candidate images/,
    );
    await writeFile(upgradeReportPath, upgradeReport);
    const mismatchedReport = join(
      qualificationArtifacts,
      'qualification-all-docker-integration',
      'all-docker-profile.json',
    );
    await writeFile(
      mismatchedReport,
      JSON.stringify({
        status: 'passed',
        browser: { status: 'passed' },
        images: { ...manifest.images, api: 'wrong-image' },
      }),
    );
    await assert.rejects(
      assembleCandidate({
        root,
        output: join(root, 'phase2-mismatched-images'),
        artifacts: join(root, 'artifacts'),
        sourceRevision,
        phase: 2,
        qualificationArtifacts,
      }),
      /candidate images/,
    );
    assert.throws(
      () => assertReleaseEvidence(phase2),
      /matching profile evidence/,
    );
    await writeFile(join(output, 'deployment/runtime.mjs'), 'altered');
    await assert.rejects(
      verifyReleaseFiles(output, manifest),
      /integrity failed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
