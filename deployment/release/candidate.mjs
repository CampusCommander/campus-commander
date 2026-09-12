import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdir,
  readFile,
  writeFile,
  lstat,
  copyFile,
  readdir,
} from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from './integrity.mjs';
import { faultRecoveryTimeoutSeconds } from '../qualification/faults.mjs';

const run = promisify(execFile);
const services = { frontend: 'frontend', api: 'api', worker: 'workers' };
export const applicationReports = {
  'auth-image-integration': 'packaged-integration.json',
  'all-docker-integration': 'all-docker-profile.json',
  'all-docker-process-fault-integration': 'all-docker-process-faults.json',
  'all-docker-capacity-integration': 'all-docker-capacity.json',
  'hybrid-integration': 'hybrid-profile.json',
  'hybrid-cli-integration': 'hybrid-cli.json',
  'hybrid-cli-upgrade-integration': 'hybrid-cli-upgrade.json',
  'hybrid-cli-process-fault-integration': 'hybrid-cli-process-faults.json',
  'hybrid-cli-capacity-integration': 'hybrid-capacity.json',
  'hybrid-cli-certificate-integration': 'hybrid-certificates.json',
  'hybrid-upgrade-integration': 'hybrid-upgrade.json',
  'hybrid-restore-integration': 'hybrid-restore.json',
  'kubernetes-integration': 'kubernetes-profile.json',
  'kubernetes-upgrade-integration': 'kubernetes-upgrade.json',
  'kubernetes-process-fault-integration': 'kubernetes-process-faults.json',
  'kubernetes-certificate-integration': 'kubernetes-certificates.json',
  'kubernetes-replica-integration': 'kubernetes-replicas.json',
  'kubernetes-capacity-integration': 'kubernetes-capacity.json',
  'kubernetes-restore-integration': 'kubernetes-restore.json',
  'upgrade-integration': 'all-docker-upgrade.json',
  'restore-integration': 'all-docker-restore.json',
  'screen-reader-integration': 'screen-reader.json',
};

/** Package committed installation sources and the build output without local secret files. */
export async function assembleCandidate({
  root,
  output,
  artifacts,
  sourceRevision,
  phase = 1,
  qualificationArtifacts,
}) {
  if (![1, 2].includes(phase)) throw new Error('Select release phase 1 or 2.');
  if (!/^[a-f0-9]{40}$/.test(sourceRevision))
    throw new Error('Candidate requires a source revision.');
  const head = (
    await run('git', ['rev-parse', 'HEAD'], { cwd: root })
  ).stdout.trim();
  const changes = (
    await run('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: root,
    })
  ).stdout.trim();
  if (head !== sourceRevision || changes)
    throw new Error('Candidate source must match a clean committed revision.');
  if (output === root || relative(root, output).startsWith('deployment/'))
    throw new Error('Candidate output must remain outside deployment sources.');
  await mkdir(output, { recursive: false, mode: 0o700 });
  const paths = (
    await run(
      'git',
      ['ls-files', '-z', 'deployment', 'LICENSE.md', 'install.sh'],
      { cwd: root },
    )
  ).stdout
    .split('\0')
    .filter(Boolean);
  for (const required of ['LICENSE.md', 'install.sh']) {
    if (!paths.includes(required))
      throw new Error(
        'Candidate requires the committed license and hosted installer.',
      );
  }
  const files = [];
  const add = async (source, path) => {
    const stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Candidate contains an unsupported file.');
    const bytes = await readFile(source);
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(
        bytes.toString('utf8'),
      )
    )
      throw new Error('Candidate contains private key material.');
    const destination = resolve(output, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    files.push({ path, sizeBytes: bytes.length, sha256: sha256(bytes) });
  };
  for (const path of paths) await add(resolve(root, path), path);
  for (const name of ['package.json', 'package-lock.json']) {
    if (!paths.includes(`deployment/release/runtime/${name}`))
      throw new Error('Installer runtime dependencies must be committed.');
    await add(resolve(root, 'deployment/release/runtime', name), name);
  }
  await run(
    'npm',
    ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    {
      cwd: output,
      timeout: 120000,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name.toLowerCase() !== 'npm_config_allow_scripts',
        ),
      ),
    },
  );
  const compiled = async (directory, base = root) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = resolve(directory, entry.name);
      if (entry.isDirectory()) await compiled(source, base);
      else if (base === output) {
        const bytes = await readFile(source);
        if (entry.isSymbolicLink())
          throw new Error('Runtime dependencies must contain ordinary files.');
        files.push({
          path: relative(output, source),
          sizeBytes: bytes.length,
          sha256: sha256(bytes),
        });
      } else await add(source, relative(base, source));
    }
  };
  await compiled(resolve(root, 'dist/deployment'));
  await mkdir(resolve(output, 'node_modules'), { recursive: true });
  await compiled(resolve(output, 'node_modules'), output);
  const images = {};
  for (const [service, key] of Object.entries(services)) {
    const reference = (
      await readFile(resolve(artifacts, `${service}.reference`), 'utf8')
    ).trim();
    if (
      !new RegExp(
        `^ghcr\\.io/campuscommander/campus-commander-${service}@sha256:[a-f0-9]{64}$`,
      ).test(reference)
    )
      throw new Error('Candidate image repository or digest is invalid.');
    images[key] = reference;
    for (const suffix of [
      'reference',
      'spdx.json',
      'verification.json',
      ...(phase === 2 ? ['vulnerabilities.json'] : []),
    ])
      await add(
        resolve(artifacts, `${service}.${suffix}`),
        `provenance/${service}.${suffix}`,
      );
  }
  const applicationEvidence = {};
  if (phase === 2) {
    if (!qualificationArtifacts)
      throw new Error('Phase 2 requires application qualification artifacts.');
    for (const [target, filename] of Object.entries(applicationReports)) {
      const source = resolve(
        qualificationArtifacts,
        `qualification-${target}`,
        filename,
      );
      const report = JSON.parse(await readFile(source, 'utf8'));
      if (target === 'kubernetes-replica-integration') {
        const phases = [
          'initial-session',
          'replacement-session',
          'worker-reschedule-session',
          'stop-revoked-session',
          'stop-resume-session',
          'uninstall-revoked-session',
          'uninstall-resume-session',
          'signed-out-session',
        ];
        const observations = report.replicaObservations;
        if (
          report.profile !== 'kubernetes' ||
          report.sourceRevision !== sourceRevision ||
          report.ownedClusterRemoved !== true ||
          report.apiReplicaCount !== 2 ||
          report.upgrade?.status !== 'passed' ||
          report.logoutRejectedAcrossReplicas !== true ||
          report.replacementPreservedOneReplica !== true ||
          !Array.isArray(observations) ||
          observations.length !== phases.length * 2 ||
          phases.some((phase) => {
            const rows = observations.filter((item) => item.phase === phase);
            const status =
              phase.includes('revoked') || phase === 'signed-out-session'
                ? 401
                : 200;
            return (
              rows.length !== 2 ||
              new Set(rows.map((item) => item.podUid)).size !== 2 ||
              rows.some(
                (item) =>
                  item.status !== status ||
                  !item.podUid ||
                  !item.node ||
                  (status === 200
                    ? !/^[a-f0-9-]{36}$/.test(item.principalId ?? '')
                    : item.principalId !== undefined),
              )
            );
          }) ||
          new Set(
            observations
              .filter((item) => item.status === 200)
              .map((item) => item.principalId),
          ).size !== 1 ||
          observations.filter(
            (item) =>
              item.phase === 'replacement-session' &&
              observations.some(
                (original) =>
                  original.phase === 'initial-session' &&
                  original.podUid === item.podUid,
              ),
          ).length !== 1 ||
          observations
            .filter((item) => item.phase === 'signed-out-session')
            .some(
              (item) =>
                !observations.some(
                  (previous) =>
                    previous.phase === 'uninstall-resume-session' &&
                    previous.podUid === item.podUid,
                ),
            )
        )
          throw new Error(
            'Kubernetes replica qualification requires direct session and revocation checks through both API pods.',
          );
      }
      if (target === 'kubernetes-capacity-integration') {
        const capacity = report.capacity,
          observations = capacity?.observations;
        if (
          report.profile !== 'kubernetes' ||
          report.sourceRevision !== sourceRevision ||
          report.ownedClusterRemoved !== true ||
          report.ownedCapacityVolumeRemoved !== true ||
          capacity?.status !== 'passed' ||
          capacity.recoveryBoundSeconds !== faultRecoveryTimeoutSeconds ||
          !Number.isFinite(capacity.recoveryMs) ||
          capacity.recoveryMs < 0 ||
          capacity.recoveryMs > faultRecoveryTimeoutSeconds * 1000 ||
          capacity?.fault?.kind !== 'ENOSPC' ||
          capacity.fault.publicationRejected !== true ||
          capacity.fault.readyRowsUnchanged !== true ||
          capacity?.authenticatedFailure?.httpStatus !== 201 ||
          capacity.authenticatedFailure.status !== 'failed' ||
          capacity?.preserved?.failedDiagnosticArtifactsRemoved !== true ||
          capacity.preserved.identityAndPreferencesPreserved !== true ||
          capacity.preserved.migrationsPreserved !== true ||
          !(capacity.preserved.preservedSecurityEvents > 0) ||
          !(capacity.preserved.preservedKestraExecutions > 0) ||
          !(capacity.preserved.preservedInternalFiles > 0) ||
          !/^[a-f0-9]{64}$/.test(capacity.preserved.artifactSha256 ?? '') ||
          capacity.preserved.artifactSha256 !==
            capacity.artifact?.artifactSha256 ||
          !Array.isArray(observations) ||
          observations.length !== 4 ||
          new Set(observations.map((item) => item.podUid)).size !== 4 ||
          observations.some((item) => !item.podUid || !item.node) ||
          observations.filter((item) => item.role === 'api').length !== 2 ||
          observations.filter((item) => item.role === 'workers').length !== 2 ||
          new Set(
            observations
              .filter((item) => item.role === 'workers')
              .map((item) => item.node),
          ).size !== 2 ||
          observations.some(
            (item) =>
              ['before', 'during', 'after'].some(
                (stage) =>
                  item[stage]?.filesystemType !== 0x01021994 ||
                  item[stage].totalBytes !== 16777216,
              ) ||
              !Number.isSafeInteger(item.before.availableBytes) ||
              item.before.availableBytes <= 0 ||
              item.before.availableBytes > 16777216 ||
              item.during.availableBytes !== 0 ||
              item.after.availableBytes !== item.before.availableBytes,
          )
        )
          throw new Error(
            'Kubernetes capacity qualification requires a shared capped volume, authenticated failure, preserved state, recovery, and cleanup.',
          );
      }
      if (target === 'hybrid-cli-capacity-integration') {
        const capacity = report.capacity;
        const observations = capacity?.observations;
        if (
          capacity?.status !== 'passed' ||
          capacity.recoveryBoundSeconds !== faultRecoveryTimeoutSeconds ||
          !Number.isFinite(capacity.recoveryMs) ||
          capacity.recoveryMs < 0 ||
          capacity.recoveryMs > faultRecoveryTimeoutSeconds * 1000 ||
          capacity?.fault?.kind !== 'ENOSPC' ||
          capacity.fault.publicationRejected !== true ||
          capacity.fault.readyRowsUnchanged !== true ||
          capacity?.authenticatedFailure?.httpStatus !== 201 ||
          capacity.authenticatedFailure.status !== 'failed' ||
          capacity?.preserved?.failedDiagnosticArtifactsRemoved !== true ||
          capacity.preserved.identityAndPreferencesPreserved !== true ||
          capacity.preserved.migrationsPreserved !== true ||
          capacity.preserved.artifactMetadataPreserved !== true ||
          capacity.preserved.artifactFilesPreserved !== true ||
          !(capacity.preserved.preservedSecurityEvents > 0) ||
          !(capacity.preserved.preservedKestraExecutions > 0) ||
          !(capacity.preserved.preservedInternalFiles > 0) ||
          !/^[a-f0-9]{64}$/.test(capacity.preserved.artifactSha256 ?? '') ||
          !Array.isArray(observations) ||
          observations.length !== 4 ||
          new Set(observations.map((item) => item.processId)).size !== 4 ||
          observations.some(
            (item) => typeof item.processId !== 'string' || !item.processId,
          ) ||
          !Array.isArray(report.hosts) ||
          report.hosts.some(
            (host) =>
              observations.filter(
                (item) =>
                  item.daemonId === host.daemonId &&
                  item.role ===
                    (host.role === 'controller' ? 'api' : 'workers'),
              ).length !== (host.role === 'controller' ? 2 : 1),
          ) ||
          observations.some(
            (item) =>
              !Number.isSafeInteger(item.before?.totalBytes) ||
              item.before.totalBytes <= 0 ||
              item.before.totalBytes > 16777216 ||
              !Number.isSafeInteger(item.before.availableBytes) ||
              item.before.availableBytes <= 0 ||
              item.before.availableBytes > item.before.totalBytes ||
              ['before', 'during', 'after'].some(
                (stage) =>
                  item[stage]?.filesystemType !== 0x01021994 ||
                  item[stage]?.totalBytes !== item.before.totalBytes,
              ) ||
              item.during.availableBytes !== 0 ||
              item.after.availableBytes !== item.before.availableBytes,
          )
        )
          throw new Error(
            'Distributed capacity qualification requires capped shared storage, authenticated failure, preserved state, and bounded recovery.',
          );
      }
      if (
        [
          'kubernetes-certificate-integration',
          'hybrid-cli-certificate-integration',
        ].includes(target)
      ) {
        const profile = target.startsWith('kubernetes-')
          ? 'kubernetes'
          : 'hybrid';
        const certificate = report.certificates;
        const cases = certificate?.cases;
        if (
          report.profile !== profile ||
          report.sourceRevision !== sourceRevision ||
          (profile === 'kubernetes'
            ? report.ownedClusterRemoved !== true
            : report.ownedResourcesRemoved !== true) ||
          certificate?.status !== 'passed' ||
          certificate.originalSecretBytesRestored !== true ||
          certificate.recoveryBoundSeconds !== faultRecoveryTimeoutSeconds ||
          !Array.isArray(cases) ||
          cases.length !== 2 ||
          [
            ['expired', 'CERT_HAS_EXPIRED'],
            ['wrong-host', 'ERR_TLS_CERT_ALTNAME_INVALID'],
          ].some(
            ([name, code]) =>
              cases.filter(
                (item) =>
                  item.name === name &&
                  item.tlsError === code &&
                  item.status === 'passed',
              ).length !== 1,
          ) ||
          cases.some(
            (item) =>
              !Number.isFinite(item.recoveryMs) ||
              item.recoveryMs < 0 ||
              item.recoveryMs > faultRecoveryTimeoutSeconds * 1000 ||
              item.durableState?.principalCount !== 1 ||
              !Number.isSafeInteger(
                item.durableState.preservedSecurityEvents,
              ) ||
              item.durableState.preservedSecurityEvents <= 0 ||
              !Number.isSafeInteger(
                item.durableState.preservedKestraExecutions,
              ) ||
              item.durableState.preservedKestraExecutions <= 0 ||
              !Number.isSafeInteger(
                item.durableState[
                  profile === 'hybrid'
                    ? 'internalStorageFiles'
                    : 'preservedInternalFiles'
                ],
              ) ||
              item.durableState[
                profile === 'hybrid'
                  ? 'internalStorageFiles'
                  : 'preservedInternalFiles'
              ] <= 0 ||
              !/^[a-f0-9]{64}$/.test(item.durableState.artifactSha256 ?? ''),
          )
        )
          throw new Error(
            `${profile === 'kubernetes' ? 'Kubernetes' : 'Hybrid'} certificate qualification requires both TLS rejections, bounded recovery, durable state, original secrets, and fixture cleanup.`,
          );
      }
      if (target === 'all-docker-capacity-integration') {
        const capacity = report.capacity;
        const filesystem = capacity?.fault?.capacity;
        if (
          report.profile !== 'all-docker' ||
          report.sourceRevision !== sourceRevision ||
          report.ownedResourcesRemoved !== true ||
          capacity?.status !== 'PASS' ||
          capacity?.topology?.componentCount !== 8 ||
          filesystem?.filesystemType !== 0x01021994 ||
          !Number.isSafeInteger(filesystem?.totalBytes) ||
          filesystem.totalBytes <= 0 ||
          filesystem.totalBytes > 16777216 ||
          !Number.isSafeInteger(filesystem?.availableBytesAfter) ||
          filesystem.availableBytesAfter < 0 ||
          filesystem.availableBytesAfter >= 65536 ||
          capacity?.fault?.kind !== 'ENOSPC' ||
          capacity.fault.publicationRejected !== true ||
          capacity.fault.readyRowsUnchanged !== true ||
          capacity?.authenticatedFailure?.status !== 'failed' ||
          capacity.authenticatedFailure.httpStatus !== 201 ||
          capacity?.preserved?.failedDiagnosticArtifactsRemoved !== true ||
          capacity?.preserved?.identityAndPreferencesPreserved !== true ||
          capacity.preserved.migrationsPreserved !== true ||
          !(capacity.preserved.preservedSecurityEvents > 0) ||
          capacity?.recovery?.failedAttemptRemoved !== true ||
          capacity.recovery.originalArtifactPreserved !== true ||
          capacity?.cleanupPolicy?.removedOnlyOwnedResources !== true
        )
          throw new Error(
            'Authenticated capacity qualification requires bounded ENOSPC, rejected publication, preserved state, recovery, and cleanup.',
          );
      }
      if (target === 'all-docker-integration') {
        const observations = report.replicaObservations;
        const phases = [
          'initial-session',
          'restart-session',
          'stop-resume-session',
          'uninstall-resume-session',
          'signed-out-session',
        ];
        if (
          report.apiReplicaCount !== 2 ||
          report.logoutRejectedAcrossReplicas !== true ||
          !Array.isArray(observations) ||
          observations.length !== 10 ||
          phases.some((phase) => {
            const matches = observations.filter((item) => item.phase === phase);
            return (
              matches.length !== 2 ||
              new Set(matches.map((item) => item.container)).size !== 2 ||
              matches.some(
                (item) =>
                  typeof item.container !== 'string' ||
                  !item.container ||
                  item.status !== (phase === 'signed-out-session' ? 401 : 200),
              )
            );
          }) ||
          new Set(
            observations
              .filter((item) => item.status === 200)
              .map((item) => item.principalId),
          ).size !== 1 ||
          observations.some(
            (item) =>
              item.status === 200 &&
              (typeof item.principalId !== 'string' || !item.principalId),
          )
        )
          throw new Error(
            'All-Docker qualification requires shared sessions and logout rejection on both API replicas.',
          );
      }
      if (
        [
          'all-docker-process-fault-integration',
          'kubernetes-process-fault-integration',
        ].includes(target)
      ) {
        const profile = target.startsWith('kubernetes-')
          ? 'kubernetes'
          : 'all-docker';
        const required = [
          'api-interruption',
          'worker-interruption',
          'redis-interruption',
          'application-postgresql-interruption',
          'kestra-postgresql-interruption',
          'kestra-interruption',
          'artifact-access-loss',
        ];
        const cases = report.faults?.cases;
        if (
          report.profile !== profile ||
          report.sourceRevision !== sourceRevision ||
          (profile === 'kubernetes'
            ? report.ownedClusterRemoved !== true
            : report.ownedResourcesRemoved !== true) ||
          report.faults?.status !== 'passed' ||
          report.faults.recoveryBoundSeconds !== faultRecoveryTimeoutSeconds ||
          !Array.isArray(cases) ||
          cases.length !== required.length ||
          required.some(
            (name) =>
              cases.filter(
                (item) => item.name === name && item.status === 'passed',
              ).length !== 1,
          ) ||
          cases.some(
            (item) =>
              !Number.isFinite(item.recoveryMs) ||
              item.recoveryMs < 0 ||
              item.recoveryMs > faultRecoveryTimeoutSeconds * 1000,
          )
        )
          throw new Error(
            `${profile === 'kubernetes' ? 'Kubernetes' : 'All-Docker'} process fault qualification requires every case, matching source, cleanup, and bounded recovery.`,
          );
      }
      if (
        [
          'restore-integration',
          'hybrid-restore-integration',
          'kubernetes-restore-integration',
        ].includes(target)
      ) {
        const executions =
          target === 'hybrid-restore-integration'
            ? [report.backup?.operatorCli, report.verification?.operatorCli]
            : [report.operatorCli];
        const commands = executions.flatMap(
          (execution) => execution?.commands ?? [],
        );
        if (
          executions.some(
            (execution) =>
              !execution ||
              ![
                'operator-container-native',
                'operator-host-native',
                'operator-native-existing-mount',
              ].includes(execution.runner) ||
              execution.injectedDatabaseTool !== false ||
              execution.secretMount !== '/run/secrets' ||
              !Array.isArray(execution.commands),
          ) ||
          ['backup', 'verify', 'restore'].some(
            (command) =>
              !commands.some(
                (item) => item.command === command && item.status === 'passed',
              ),
          )
        )
          throw new Error(
            'Application restore qualification requires the native operator CLI backup, verify, and restore commands.',
          );
      }
      if (target.startsWith('hybrid-cli-')) {
        const workers =
          report.hosts?.filter((host) => host.role?.startsWith('worker-')) ??
          [];
        const controller =
          report.hosts?.filter((host) => host.role === 'controller') ?? [];
        if (
          report.profile !== 'hybrid' ||
          report.sourceRevision !== sourceRevision ||
          report.ownedResourcesRemoved !== true ||
          workers.length !== 2 ||
          controller.length !== 1 ||
          new Set(report.hosts.map((host) => host.daemonId)).size !== 3 ||
          report.hosts.some(
            (host) => typeof host.daemonId !== 'string' || !host.daemonId,
          ) ||
          (target !== 'hybrid-cli-integration' &&
            (report.upgrade?.status !== 'passed' ||
              report.upgrade.encryptedBackup?.status !== 'verified'))
        )
          throw new Error(
            'Distributed CLI qualification requires matching source, independent hosts, cleanup, and verified upgrade recovery.',
          );
      }
      if (target === 'hybrid-cli-process-fault-integration') {
        const required = [
          'api-interruption',
          'worker-host-interruption',
          'external-redis-interruption',
          'external-postgresql-interruption',
          'kestra-interruption',
          'shared-artifact-access-loss',
        ];
        const cases = report.faults?.cases;
        if (
          report.faults?.status !== 'passed' ||
          !Array.isArray(cases) ||
          cases.length !== required.length ||
          required.some(
            (name) =>
              cases.filter(
                (item) => item.name === name && item.status === 'passed',
              ).length !== 1,
          )
        )
          throw new Error(
            'Distributed process fault qualification requires every interruption and recovery case.',
          );
        if (
          report.faults.recoveryBoundSeconds !== faultRecoveryTimeoutSeconds ||
          cases.some(
            (item) =>
              !Number.isFinite(item.recoveryMs) ||
              item.recoveryMs < 0 ||
              item.recoveryMs > faultRecoveryTimeoutSeconds * 1000,
          )
        )
          throw new Error(
            'Distributed process fault qualification requires measured recovery timing within the foundation budget.',
          );
      }
      const actual = report.releaseB ?? report.images;
      const applicationPassed =
        target === 'auth-image-integration'
          ? report.packagedApplicationImages === true
          : (target === 'all-docker-integration'
              ? report.browser
              : report.application
            )?.status === 'passed';
      if (
        report.status !==
          ([
            'hybrid-integration',
            'hybrid-upgrade-integration',
            'kubernetes-integration',
            'kubernetes-upgrade-integration',
          ].includes(target)
            ? 'PASS'
            : 'passed') ||
        !applicationPassed ||
        ([
          'hybrid-upgrade-integration',
          'kubernetes-upgrade-integration',
        ].includes(target) &&
          (report.upgrade?.status !== 'passed' ||
            report.upgrade.runtimeImageContentVerified !== true)) ||
        Object.entries(services).some(([service, key]) => {
          const value = actual?.[key] ?? actual?.[service];
          return (
            (typeof value === 'string' ? value : value?.reference) !==
            images[key]
          );
        })
      )
        throw new Error(
          'Application qualification must pass against the candidate images.',
        );
      const reportPath = `qualification/${target}/${filename}`;
      await add(source, reportPath);
      applicationEvidence[target] = {
        reportPath,
        reportSha256: files.find((file) => file.path === reportPath).sha256,
      };
    }
    for (const filename of [
      'login-accessibility.json',
      'account-accessibility.json',
      'diagnostics-light-accessibility.json',
      'diagnostics-dark-accessibility.json',
      'diagnostics-light.png',
      'diagnostics-dark.png',
    ])
      await add(
        resolve(
          qualificationArtifacts,
          'qualification-auth-image-integration',
          filename,
        ),
        `qualification/accessibility/${filename}`,
      );
  }
  const manifest = {
    schemaVersion: 1,
    phase,
    sourceRevision,
    architectures: ['linux/amd64'],
    platform: 'linux/amd64',
    images,
    qualification: 'candidate-only',
    ...(phase === 2 ? { applicationEvidence } : {}),
    evidence: Object.fromEntries(
      ['all-docker', 'hybrid', 'kubernetes'].map((profile) => [
        profile,
        Object.fromEntries(
          ['install', 'resume', 'upgrade', 'restore', 'faults'].map((check) => [
            check,
            { status: 'not-run' },
          ]),
        ),
      ]),
    ),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
  await writeFile(
    resolve(output, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: 'wx' },
  );
  await writeFile(
    resolve(output, 'SHA256SUMS'),
    manifest.files.map((file) => `${file.sha256}  ${file.path}`).join('\n') +
      '\n',
    { flag: 'wx' },
  );
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [
    output,
    artifacts,
    sourceRevision,
    phase = '1',
    qualificationArtifacts,
  ] = process.argv.slice(2);
  if (!output || !artifacts || !sourceRevision)
    throw new Error(
      'Usage: candidate.mjs <new-output-directory> <image-artifacts> <source-revision> [phase] [qualification-artifacts]',
    );
  assembleCandidate({
    root: process.cwd(),
    output: resolve(output),
    artifacts: resolve(artifacts),
    sourceRevision,
    phase: Number(phase),
    qualificationArtifacts: qualificationArtifacts
      ? resolve(qualificationArtifacts)
      : undefined,
  }).catch(() => {
    process.stderr.write(
      'Candidate assembly failed. Check committed sources, build output, and signed image evidence.\n',
    );
    process.exitCode = 1;
  });
}
