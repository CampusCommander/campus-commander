import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { applicationReports, assembleCandidate } from './candidate.mjs';
import {
  assertReleaseEvidence,
  verifyReleaseFiles,
  verifyReleaseEvidence,
  sha256,
} from './integrity.mjs';
import {
  bundleTargets,
  recordBundleQualification,
} from './bundle-qualification.mjs';
import { assembleQualifiedRelease, profileWorkflows } from './qualified.mjs';

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
          certificates: {
            status: 'passed',
            originalSecretBytesRestored: true,
            recoveryBoundSeconds: 180,
            cases: [
              ['expired', 'CERT_HAS_EXPIRED'],
              ['wrong-host', 'ERR_TLS_CERT_ALTNAME_INVALID'],
            ].map(([name, tlsError]) => ({
              name,
              tlsError,
              status: 'passed',
              recoveryMs: 1000,
              durableState: {
                principalCount: 1,
                preservedSecurityEvents: 10,
                preservedKestraExecutions: 2,
                preservedInternalFiles: 1,
                internalStorageFiles: 1,
                artifactSha256: 'a'.repeat(64),
              },
            })),
          },
          capacity: {
            status: [
              'hybrid-cli-capacity-integration',
              'kubernetes-capacity-integration',
            ].includes(target)
              ? 'passed'
              : 'PASS',
            artifact: { artifactSha256: 'a'.repeat(64) },
            recoveryBoundSeconds: 180,
            recoveryMs: 1000,
            observations: [
              'controller',
              'controller',
              'worker-1',
              'worker-2',
            ].map((daemonId, index) => ({
              daemonId,
              podUid: `pod-${index}`,
              node: daemonId,
              role: daemonId === 'controller' ? 'api' : 'workers',
              processId: `process-${index}`,
              before: {
                filesystemType: 0x01021994,
                totalBytes: 16777216,
                availableBytes: 16773120,
              },
              during: {
                filesystemType: 0x01021994,
                totalBytes: 16777216,
                availableBytes: 0,
              },
              after: {
                filesystemType: 0x01021994,
                totalBytes: 16777216,
                availableBytes: 16773120,
              },
            })),
            topology: { componentCount: 8 },
            fault: {
              kind: 'ENOSPC',
              capacity: {
                filesystemType: 0x01021994,
                totalBytes: 16777216,
                availableBytesAfter: 0,
              },
              publicationRejected: true,
              readyRowsUnchanged: true,
            },
            authenticatedFailure: { status: 'failed', httpStatus: 201 },
            preserved: {
              artifactMetadataPreserved: true,
              artifactFilesPreserved: true,
              artifactSha256: 'a'.repeat(64),
              preservedKestraExecutions: 1,
              preservedInternalFiles: 1,
              identityAndPreferencesPreserved: true,
              failedDiagnosticArtifactsRemoved: true,
              migrationsPreserved: true,
              preservedSecurityEvents: 1,
            },
            recovery: {
              failedAttemptRemoved: true,
              originalArtifactPreserved: true,
            },
            cleanupPolicy: { removedOnlyOwnedResources: true },
          },
          operatorCli: {
            runner: 'operator-container-native',
            injectedDatabaseTool: false,
            secretMount: '/run/secrets',
            commands: ['backup', 'verify', 'restore'].map((command) => ({
              command,
              status: 'passed',
            })),
          },
          backup: {
            operatorCli: {
              runner: 'operator-native-existing-mount',
              injectedDatabaseTool: false,
              secretMount: '/run/secrets',
              commands: ['backup', 'verify'].map((command) => ({
                command,
                status: 'passed',
              })),
            },
          },
          verification: {
            operatorCli: {
              runner: 'operator-native-existing-mount',
              injectedDatabaseTool: false,
              secretMount: '/run/secrets',
              commands: [{ command: 'restore', status: 'passed' }],
            },
          },
          upgrade: {
            status: 'passed',
            runtimeImageContentVerified: true,
            encryptedBackup: { status: 'verified' },
          },
          profile: target.startsWith('kubernetes-')
            ? 'kubernetes'
            : target.startsWith('all-docker-')
              ? 'all-docker'
              : 'hybrid',
          faults: {
            status: 'passed',
            recoveryBoundSeconds: 180,
            cases: ([
              'all-docker-process-fault-integration',
              'kubernetes-process-fault-integration',
            ].includes(target)
              ? [
                  'api-interruption',
                  'worker-interruption',
                  'redis-interruption',
                  'application-postgresql-interruption',
                  'kestra-postgresql-interruption',
                  'kestra-interruption',
                  'artifact-access-loss',
                ]
              : [
                  'api-interruption',
                  'worker-host-interruption',
                  'external-redis-interruption',
                  'external-postgresql-interruption',
                  'kestra-interruption',
                  'shared-artifact-access-loss',
                ]
            ).map((name) => ({ name, status: 'passed', recoveryMs: 1000 })),
          },
          browser: { status: 'passed' },
          apiReplicaCount: 2,
          logoutRejectedAcrossReplicas: true,
          replacementPreservedOneReplica: true,
          replicaObservations:
            target === 'kubernetes-replica-integration'
              ? [
                  'initial-session',
                  'replacement-session',
                  'worker-reschedule-session',
                  'stop-revoked-session',
                  'stop-resume-session',
                  'uninstall-revoked-session',
                  'uninstall-resume-session',
                  'signed-out-session',
                ].flatMap((phase) =>
                  [1, 2].map((index) => ({
                    phase,
                    podUid:
                      phase === 'initial-session' && index === 1
                        ? 'old-pod'
                        : `pod-${index}`,
                    node: `node-${index}`,
                    status:
                      phase.includes('revoked') ||
                      phase === 'signed-out-session'
                        ? 401
                        : 200,
                    ...(phase.includes('revoked') ||
                    phase === 'signed-out-session'
                      ? {}
                      : {
                          principalId: '12345678-1234-1234-1234-123456789abc',
                        }),
                  })),
                )
              : [
                  'initial-session',
                  'restart-session',
                  'stop-resume-session',
                  'uninstall-resume-session',
                  'signed-out-session',
                ].flatMap((phase) =>
                  [1, 2].map((index) => ({
                    phase,
                    container: `api-${index}`,
                    status: phase === 'signed-out-session' ? 401 : 200,
                    ...(phase === 'signed-out-session'
                      ? {}
                      : { principalId: 'synthetic-principal' }),
                  })),
                ),
          packagedApplicationImages: true,
          images: manifest.images,
          sourceRevision,
          ownedResourcesRemoved: true,
          ownedClusterRemoved: true,
          ownedCapacityVolumeRemoved: true,
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
    const bundleQualifications = join(root, 'bundle-qualifications');
    const manifestSha256 = sha256(
      await readFile(join(phase2Output, 'release-manifest.json')),
    );
    for (const target of bundleTargets) {
      const report = JSON.parse(
        await readFile(
          join(
            qualificationArtifacts,
            `qualification-${target}`,
            applicationReports[target],
          ),
        ),
      );
      const profile = Object.entries(profileWorkflows).find(([, mapping]) =>
        Object.values(mapping).includes(target),
      )[0];
      report.profile = profile;
      const commands = [
        'prepare',
        'resume',
        'resume',
        'stop',
        'resume',
        'uninstall',
        'resume',
      ];
      const structuredCommands = commands.map((command) => ({
        command,
        status:
          { prepare: 'prepared', stop: 'stopped', uninstall: 'uninstalled' }[
            command
          ] ?? 'ready',
      }));
      report.installer = {
        source:
          profile === 'kubernetes'
            ? 'verified-extracted-bundle'
            : 'extracted-published-bundle',
        commands: profile === 'all-docker' ? commands : structuredCommands,
        bundleManifestSha256: manifestSha256,
        workerHosts: ['worker-a', 'worker-b'],
      };
      report.commands = structuredCommands;
      report.installerSource = 'extracted-published-bundle';
      report.bundleManifestSha256 = manifestSha256;
      report.qualificationSourceState =
        'Extracted published installer bundle with matching application images.';
      report.releaseInventories = [
        {
          sourceRevision: '0'.repeat(40),
          images: {
            ...manifest.images,
            api: 'registry.example.org/baseline@sha256:' + 'b'.repeat(64),
          },
        },
        { sourceRevision, images: manifest.images },
      ];
      report.checks = [
        'encrypted backup verified before upgrade',
        'different image digests upgrade with artifact and ledger preservation',
      ];
      report.oldSessionRejected = true;
      report.application.oldSessionRejected = true;
      report.preserved = {
        principals: 1,
        securityEvents: 1,
        artifactSha256: 'a'.repeat(64),
      };
      const state = {
        principals: 1,
        securityEvents: 1,
        exactIdentityAndPreferences: true,
        exactSecurityEvents: true,
      };
      report.applicationState = state;
      report.verification.application = state;
      for (const execution of [
        report.operatorCli,
        report.backup.operatorCli,
        report.verification.operatorCli,
      ]) {
        execution.source = 'extracted-published-bundle';
        execution.bundleManifestSha256 = manifestSha256;
      }
      const directory = join(
        bundleQualifications,
        `bundle-qualification-${target}`,
      );
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, applicationReports[target]),
        JSON.stringify(report),
      );
      if (target === 'all-docker-process-fault-integration')
        await writeFile(
          join(directory, 'all-docker-upgrade.json'),
          JSON.stringify(report),
        );
      await recordBundleQualification({
        bundleRoot: phase2Output,
        reportRoot: directory,
        target,
        sourceRevision,
        images: manifest.images,
      });
    }
    const qualifiedOutput = join(root, 'qualified');
    const qualified = await assembleQualifiedRelease({
      candidateRoot: phase2Output,
      qualifications: bundleQualifications,
      output: qualifiedOutput,
      sourceRevision,
    });
    assert.equal(qualified.qualification, 'profile-qualified');
    assert.equal(qualified.districtInfrastructureAcceptance, 'not-qualified');
    const checkPaths = Object.values(qualified.evidence).flatMap((profile) =>
      Object.values(profile)
        .filter((check) => check.reportPath)
        .map((check) => check.reportPath),
    );
    assert.equal(checkPaths.length, 15);
    assert.equal(new Set(checkPaths).size, 15);
    await verifyReleaseEvidence(qualifiedOutput, qualified);
    await verifyReleaseFiles(qualifiedOutput, qualified);
    assert.deepEqual(
      await readFile(
        join(qualifiedOutput, 'provenance/candidate-manifest.json'),
      ),
      await readFile(join(phase2Output, 'release-manifest.json')),
    );
    const contextPath = join(
      bundleQualifications,
      'bundle-qualification-all-docker-integration/bundle-qualification.json',
    );
    const contextBytes = await readFile(contextPath);
    const context = JSON.parse(contextBytes);
    let invalidIndex = 0;
    for (const invalid of [
      { ...context, bundleManifestSha256: '0'.repeat(64) },
      { ...context, sourceRevision: '0'.repeat(40) },
      { ...context, status: 'failed' },
      {
        ...context,
        reports: [{ ...context.reports[0], path: '../outside.json' }],
      },
    ]) {
      await writeFile(contextPath, JSON.stringify(invalid));
      await assert.rejects(
        assembleQualifiedRelease({
          candidateRoot: phase2Output,
          qualifications: bundleQualifications,
          output: join(root, `invalid-qualified-${invalidIndex++}`),
          sourceRevision,
        }),
      );
    }
    await writeFile(contextPath, contextBytes);
    const resumeReportPath = join(
      bundleQualifications,
      'bundle-qualification-all-docker-integration/all-docker-profile.json',
    );
    const resumeBytes = await readFile(resumeReportPath);
    const missingResume = JSON.parse(resumeBytes);
    missingResume.installer.commands = ['prepare', 'resume'];
    await writeFile(resumeReportPath, JSON.stringify(missingResume));
    await recordBundleQualification({
      bundleRoot: phase2Output,
      reportRoot: dirname(contextPath),
      target: 'all-docker-integration',
      sourceRevision,
      images: manifest.images,
    });
    await assert.rejects(
      assembleQualifiedRelease({
        candidateRoot: phase2Output,
        qualifications: bundleQualifications,
        output: join(root, 'missing-resume-qualified'),
        sourceRevision,
      }),
    );
    await writeFile(resumeReportPath, resumeBytes);
    await writeFile(contextPath, contextBytes);
    await rm(contextPath);
    await assert.rejects(
      assembleQualifiedRelease({
        candidateRoot: phase2Output,
        qualifications: bundleQualifications,
        output: join(root, 'missing-workflow-qualified'),
        sourceRevision,
      }),
      { code: 'ENOENT' },
    );
    await writeFile(contextPath, contextBytes);
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
    for (const target of [
      'restore-integration',
      'hybrid-restore-integration',
      'kubernetes-restore-integration',
    ]) {
      const path = join(
        qualificationArtifacts,
        `qualification-${target}`,
        applicationReports[target],
      );
      const original = JSON.parse(await readFile(path, 'utf8'));
      for (const [index, mutate] of [
        (report) => {
          delete report.operatorCli;
          delete report.backup.operatorCli;
        },
        (report) => {
          for (const cli of [
            report.operatorCli,
            report.backup.operatorCli,
            report.verification.operatorCli,
          ])
            cli.injectedDatabaseTool = true;
        },
        (report) => {
          for (const cli of [
            report.operatorCli,
            report.backup.operatorCli,
            report.verification.operatorCli,
          ])
            cli.commands = cli.commands.filter(
              ({ command }) => command !== 'restore',
            );
        },
      ].entries()) {
        const invalid = structuredClone(original);
        mutate(invalid);
        await writeFile(path, JSON.stringify(invalid));
        await assert.rejects(
          assembleCandidate({
            root,
            output: join(root, `invalid-${target}-cli-${index}`),
            artifacts: join(root, 'artifacts'),
            sourceRevision,
            phase: 2,
            qualificationArtifacts,
          }),
          /native operator CLI/,
        );
      }
      await writeFile(path, JSON.stringify(original));
    }
    for (const target of [
      'all-docker-certificate-integration',
      'kubernetes-certificate-integration',
      'hybrid-cli-certificate-integration',
    ]) {
      const certificatePath = join(
        qualificationArtifacts,
        `qualification-${target}`,
        applicationReports[target],
      );
      const certificateReport = JSON.parse(
        await readFile(certificatePath, 'utf8'),
      );
      for (const [index, mutate] of [
        (report) => {
          report.certificates.cases.pop();
        },
        (report) => {
          report.certificates.cases[0].tlsError = 'TLS_ACCEPTED';
        },
        (report) => {
          report.certificates.cases[0].recoveryMs = 180001;
        },
        (report) => {
          report.certificates.originalSecretBytesRestored = false;
        },
        (report) => {
          report.ownedClusterRemoved = false;
          report.ownedResourcesRemoved = false;
        },
        (report) => {
          report.sourceRevision = '0'.repeat(40);
        },
        (report) => {
          delete report.certificates.cases[0].durableState;
        },
        (report) => {
          report.certificates.cases[0].durableState.preservedKestraExecutions = 0;
        },
        (report) => {
          report.certificates.cases[0].durableState.artifactSha256 = 'invalid';
        },
      ].entries()) {
        const invalid = structuredClone(certificateReport);
        mutate(invalid);
        await writeFile(certificatePath, JSON.stringify(invalid));
        await assert.rejects(
          assembleCandidate({
            root,
            output: join(root, `invalid-certificate-${target}-${index}`),
            artifacts: join(root, 'artifacts'),
            sourceRevision,
            phase: 2,
            qualificationArtifacts,
          }),
          /(?:Kubernetes|Hybrid|All-Docker) certificate qualification/,
        );
      }
      await writeFile(certificatePath, JSON.stringify(certificateReport));
    }
    const capacityPath = join(
      qualificationArtifacts,
      'qualification-all-docker-capacity-integration',
      'all-docker-capacity.json',
    );
    const capacityReport = JSON.parse(await readFile(capacityPath, 'utf8'));
    for (const [index, mutate] of [
      (report) => {
        report.capacity.fault.capacity.totalBytes = 33554432;
      },
      (report) => {
        report.capacity.authenticatedFailure.status = 'passed';
      },
      (report) => {
        report.capacity.fault.publicationRejected = false;
      },
      (report) => {
        report.capacity.preserved.failedDiagnosticArtifactsRemoved = false;
      },
      (report) => {
        report.capacity.cleanupPolicy.removedOnlyOwnedResources = false;
      },
      (report) => {
        report.sourceRevision = '0'.repeat(40);
      },
    ].entries()) {
      const invalid = structuredClone(capacityReport);
      mutate(invalid);
      await writeFile(capacityPath, JSON.stringify(invalid));
      await assert.rejects(
        assembleCandidate({
          root,
          output: join(root, `invalid-capacity-${index}`),
          artifacts: join(root, 'artifacts'),
          sourceRevision,
          phase: 2,
          qualificationArtifacts,
        }),
        /Authenticated capacity qualification/,
      );
    }
    await writeFile(capacityPath, JSON.stringify(capacityReport));
    const hybridCapacityPath = join(
      qualificationArtifacts,
      'qualification-hybrid-cli-capacity-integration',
      'hybrid-capacity.json',
    );
    const hybridCapacity = JSON.parse(
      await readFile(hybridCapacityPath, 'utf8'),
    );
    for (const [index, mutate] of [
      (report) => {
        report.capacity.observations.pop();
      },
      (report) => {
        report.capacity.observations[2].daemonId = 'controller';
      },
      (report) => {
        report.capacity.observations[0].before.totalBytes = 33554432;
      },
      (report) => {
        report.capacity.observations[0].during.availableBytes = 1024;
      },
      (report) => {
        report.capacity.observations[0].after.availableBytes = 4096;
      },
      (report) => {
        report.capacity.recoveryMs = 180001;
      },
      (report) => {
        report.capacity.authenticatedFailure.status = 'passed';
      },
      (report) => {
        report.capacity.preserved.failedDiagnosticArtifactsRemoved = false;
      },
      (report) => {
        report.capacity.preserved.preservedKestraExecutions = 0;
      },
      (report) => {
        report.ownedResourcesRemoved = false;
      },
    ].entries()) {
      const invalid = structuredClone(hybridCapacity);
      mutate(invalid);
      await writeFile(hybridCapacityPath, JSON.stringify(invalid));
      await assert.rejects(
        assembleCandidate({
          root,
          output: join(root, `invalid-hybrid-capacity-${index}`),
          artifacts: join(root, 'artifacts'),
          sourceRevision,
          phase: 2,
          qualificationArtifacts,
        }),
        /Distributed (capacity|CLI) qualification/,
      );
    }
    await writeFile(hybridCapacityPath, JSON.stringify(hybridCapacity));
    for (const [target, filename, mutations, expectedError] of [
      [
        'kubernetes-replica-integration',
        'kubernetes-replicas.json',
        [
          (report) => {
            report.replicaObservations.pop();
          },
          (report) => {
            report.replicaObservations[0].principalId =
              '00000000-0000-0000-0000-000000000000';
          },
          (report) => {
            report.replicaObservations[0].podUid =
              report.replicaObservations[1].podUid;
          },
          (report) => {
            report.replicaObservations.find(
              (item) => item.phase === 'signed-out-session',
            ).status = 200;
          },
          (report) => {
            report.replicaObservations.find(
              (item) => item.phase === 'stop-revoked-session',
            ).status = 200;
          },
          (report) => {
            report.replicaObservations.find(
              (item) => item.phase === 'replacement-session',
            ).podUid = 'another-new-pod';
            report.replicaObservations[1].podUid = 'another-old-pod';
          },
          (report) => {
            report.ownedClusterRemoved = false;
          },
        ],
        /Kubernetes replica qualification/,
      ],
      [
        'kubernetes-capacity-integration',
        'kubernetes-capacity.json',
        [
          (report) => {
            report.capacity.observations.pop();
          },
          (report) => {
            report.capacity.observations[2].node =
              report.capacity.observations[3].node;
          },
          (report) => {
            report.capacity.observations[0].before.totalBytes = 33554432;
          },
          (report) => {
            report.capacity.observations[0].during.availableBytes = 4096;
          },
          (report) => {
            report.capacity.observations[0].after.availableBytes = 4096;
          },
          (report) => {
            report.capacity.preserved.failedDiagnosticArtifactsRemoved = false;
          },
          (report) => {
            report.capacity.authenticatedFailure.status = 'passed';
          },
          (report) => {
            report.capacity.recoveryMs = 180001;
          },
          (report) => {
            report.ownedCapacityVolumeRemoved = false;
          },
        ],
        /Kubernetes capacity qualification/,
      ],
    ]) {
      const path = join(
        qualificationArtifacts,
        `qualification-${target}`,
        filename,
      );
      const original = JSON.parse(await readFile(path, 'utf8'));
      for (const [index, mutate] of mutations.entries()) {
        const invalid = structuredClone(original);
        mutate(invalid);
        await writeFile(path, JSON.stringify(invalid));
        await assert.rejects(
          assembleCandidate({
            root,
            output: join(root, `invalid-${target}-${index}`),
            artifacts: join(root, 'artifacts'),
            sourceRevision,
            phase: 2,
            qualificationArtifacts,
          }),
          expectedError,
        );
      }
      await writeFile(path, JSON.stringify(original));
    }
    const replicaPath = join(
      qualificationArtifacts,
      'qualification-all-docker-integration',
      'all-docker-profile.json',
    );
    const replicaReport = JSON.parse(await readFile(replicaPath, 'utf8'));
    for (const [index, mutate] of [
      (report) => {
        report.replicaObservations.pop();
      },
      (report) => {
        report.replicaObservations[0].container =
          report.replicaObservations[1].container;
      },
      (report) => {
        report.replicaObservations.at(-1).status = 200;
      },
    ].entries()) {
      const invalid = structuredClone(replicaReport);
      mutate(invalid);
      await writeFile(replicaPath, JSON.stringify(invalid));
      await assert.rejects(
        assembleCandidate({
          root,
          output: join(root, `invalid-replica-${index}`),
          artifacts: join(root, 'artifacts'),
          sourceRevision,
          phase: 2,
          qualificationArtifacts,
        }),
        /both API replicas/,
      );
    }
    await writeFile(replicaPath, JSON.stringify(replicaReport));
    for (const profile of ['all-docker', 'kubernetes']) {
      const processPath = join(
        qualificationArtifacts,
        `qualification-${profile}-process-fault-integration`,
        `${profile}-process-faults.json`,
      );
      const processReport = JSON.parse(await readFile(processPath, 'utf8'));
      for (const [index, mutate] of [
        (report) => {
          report.faults.cases.pop();
        },
        (report) => {
          report.faults.cases[0].recoveryMs = 180001;
        },
        (report) => {
          report.sourceRevision = '0'.repeat(40);
        },
        (report) => {
          if (profile === 'kubernetes') report.ownedClusterRemoved = false;
          else report.ownedResourcesRemoved = false;
        },
      ].entries()) {
        const invalid = structuredClone(processReport);
        mutate(invalid);
        await writeFile(processPath, JSON.stringify(invalid));
        await assert.rejects(
          assembleCandidate({
            root,
            output: join(root, `invalid-${profile}-fault-${index}`),
            artifacts: join(root, 'artifacts'),
            sourceRevision,
            phase: 2,
            qualificationArtifacts,
          }),
          /process fault qualification/,
        );
      }
      await writeFile(processPath, JSON.stringify(processReport));
    }
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
        ...replicaReport,
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
