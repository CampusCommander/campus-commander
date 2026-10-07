import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createOperationsCliFixture } from '../deployment/operations/cli-fixture.mjs';
import { installationSecretPath } from '../deployment/installer/secrets.mjs';
import { loadQualificationBundle } from '../deployment/release/qualification.mjs';
import { isolatedPortForward } from '../deployment/kubernetes/isolated-port-forward.mjs';
import { waitForKubernetesShutdown } from './kubernetes-installer-fixture.mjs';

/** Reject backup evidence for another release or an empty application. */
export function assertKubernetesBackupContents(manifest, release, verified) {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.profile, 'kubernetes');
  assert.deepEqual(manifest.release, release);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.files, manifest.files.length);
  assert.ok(Number.isSafeInteger(verified.files) && verified.files >= 4);
  for (const path of [
    'configuration.json',
    'release.json',
    'application.dump',
    'kestra.dump',
  ]) {
    const entries = manifest.files.filter((file) => file.path === path);
    assert.equal(entries.length, 1);
    assert.ok(
      Number.isSafeInteger(entries[0].sizeBytes) && entries[0].sizeBytes > 0,
    );
  }
  const requiredTables = ['application_principals', 'security_events'];
  if (release.phase === 3)
    requiredTables.push('google_credentials', 'google_access_tokens');
  for (const name of requiredTables) {
    const entries = manifest.applicationTables.filter(
      (table) => table.schema === 'cc' && table.name === name,
    );
    assert.equal(entries.length, 1);
    assert.match(entries[0].count, /^[1-9][0-9]*$/);
  }
}

/** Verify a native cold backup through the delivered operator CLI. */
export async function qualifyKubernetesNativeBackup({
  root,
  project,
  kube,
  kubeconfig,
}) {
  assert.match(project, /^cc-capacity-kube-[a-f0-9]{12}$/);
  assert.ok(root.startsWith(`/tmp/${project}-`));
  assert.equal(await realpath(root), root);
  assert.equal(kubeconfig, join(root, 'kubeconfig'));
  assert.ok(process.env.CC_AUTH_INSTALLER_ROOT);
  const started = Date.now();
  const installationRoot = join(root, 'installer');
  const config = JSON.parse(await readFile(join(root, 'runtime/config.json')));
  const operator = JSON.parse(
    await readFile(join(root, 'runtime/operator.json')),
  );
  const release = JSON.parse(
    await readFile(join(installationRoot, 'release.json')),
  );
  assert.equal(config.profile, 'kubernetes');
  assert.ok([2, 3].includes(config.phase));
  assert.equal(release.phase, config.phase);
  assert.deepEqual(config.images, release.images);
  assert.equal(operator.namespace, project);
  const bundle = await loadQualificationBundle(
    process.env.CC_AUTH_INSTALLER_ROOT,
    release,
  );
  const privateRoot = join(installationRoot, 'private');
  const resolveSecret = (reference) =>
    readFile(installationSecretPath(privateRoot, reference));
  const cli = await createOperationsCliFixture(
    join(root, 'native-backup-cli'),
    resolveSecret,
    {
      container: true,
      mountDirectories: [root],
    },
  );
  assert.equal(cli.execution.source, 'extracted-published-bundle');
  assert.equal(cli.execution.injectedDatabaseTool, false);
  assert.equal(cli.execution.bundleManifestSha256, bundle.manifestSha256);
  const commands = [];
  const timed = async (command, action) => {
    const start = Date.now();
    const result = await action();
    commands.push({
      command,
      durationMs: Date.now() - start,
      status: command === 'generate-key' ? 'created' : result.result.status,
    });
    return result;
  };
  const keyRecovery = {
    id: `phase${config.phase}-kubernetes-native-backup`,
    version: 1,
    reference: {
      provider: 'file',
      path: '/run/secrets/kubernetes-native-backup-key',
    },
  };
  const recoveryKey = await timed('generate-key', () => cli.generateKey());
  try {
    assert.equal(recoveryKey.length, 32);
    await writeFile(
      installationSecretPath(privateRoot, keyRecovery.reference),
      recoveryKey,
      { mode: 0o600, flag: 'wx' },
    );
  } finally {
    recoveryKey.fill(0);
  }
  const writers = ['api', 'workers', 'kestra'];
  const rendered = JSON.parse(
    await kube(['get', 'deployments', ...writers, '-o', 'json']),
  );
  assert.equal(rendered.items.length, writers.length);
  assert.deepEqual(
    rendered.items.map((item) => item.metadata.name).sort(),
    [...writers].sort(),
  );
  for (const deployment of rendered.items)
    assert.equal(deployment.metadata.namespace, project);
  for (const name of writers)
    await kube(['scale', `deployment/${name}`, '--replicas=0']);
  await waitForKubernetesShutdown(kube, rendered);
  const stoppedAt = new Date().toISOString();
  const forwards = [];
  const forward = async (service) => {
    assert.ok(['application-postgres', 'kestra-postgres'].includes(service));
    const tunnel = isolatedPortForward({
      localPort: 0,
      remotePort: 5432,
      arguments: [
        '--kubeconfig',
        kubeconfig,
        '--context',
        `kind-${project}`,
        '-n',
        project,
        'port-forward',
        `service/${service}`,
        ':5432',
        '--address=127.0.0.1',
      ],
    });
    forwards.push({ service, tunnel });
    return tunnel.ready;
  };
  try {
    const backupConfig = structuredClone(config);
    for (const [key, service] of [
      ['applicationDatabase', 'application-postgres'],
      ['kestraDatabase', 'kestra-postgres'],
    ])
      backupConfig.services[key].endpoint.url =
        `postgresql://localhost:${await forward(service)}`;
    const sourceRoots = {
      artifacts: join(root, 'shared/campus-artifacts/artifacts'),
      kestraInternal: join(root, 'shared/kestra-internal/kestra'),
    };
    backupConfig.artifacts.location = sourceRoots.artifacts;
    backupConfig.services.kestra.internalStorage.location =
      sourceRoots.kestraInternal;
    const backupDirectory = join(root, 'native-backup');
    const backup = await timed('backup', () =>
      cli.run('backup', {
        config: backupConfig,
        release,
        backupDirectory,
        sourceRoots,
        keyRecovery,
        quiesce: {
          operator: 'phase3-kubernetes-native-backup-fixture',
          stoppedAt,
          stoppedServices: writers,
        },
        applicationCredentials: {
          role: operator.migrationRole,
          passwordSecretRef: operator.migrationPasswordSecretRef,
        },
      }),
    );
    assert.equal(backup.result.status, 'complete');
    const verified = await timed('verify', () =>
      cli.run('verify', { backupDirectory, keyRecovery }),
    );
    assert.equal(verified.result.status, 'verified');
    const manifest = await readFile(join(backupDirectory, 'manifest.json'));
    const contents = JSON.parse(manifest);
    assertKubernetesBackupContents(contents, release, verified.result);
    for (const { tunnel } of forwards)
      assert.ok(tunnel.observation.peakConnections >= 2);
    return {
      report: {
        status: 'passed',
        phase: config.phase,
        profile: config.profile,
        sourceRevision: release.sourceRevision,
        images: release.images,
        durationMs: Date.now() - started,
        durationScope:
          'Native key generation, writer shutdown, cold backup, and backup verification.',
        commands,
        execution: cli.execution,
        backupManifestSha256: createHash('sha256')
          .update(manifest)
          .digest('hex'),
        verifiedFiles: verified.result.files,
        storageFiles: {
          artifacts: contents.files.filter((file) =>
            file.path.startsWith('artifacts/'),
          ).length,
          kestraInternal: contents.files.filter((file) =>
            file.path.startsWith('kestra-internal/'),
          ).length,
        },
        applicationTables: contents.applicationTables,
        kestraTables: contents.kestraTables,
        writersStopped: true,
        databaseForwards: forwards.map(({ service, tunnel }) => ({
          service,
          ...tunnel.observation,
          transport: 'independent-process-per-database-connection',
        })),
        limits: [
          'The fixture forwards PostgreSQL through loopback and retains TLS verification.',
          'Shared host storage does not establish district storage or independent physical failure domains.',
          'Backup verification does not establish isolated restore or complete operator recovery acceptance.',
          'The installation fixture does not seed nonempty artifact content for this backup check.',
        ],
      },
      upgradeBackup: { backupDirectory, keyRecovery },
    };
  } finally {
    const results = await Promise.allSettled(
      forwards.map(({ tunnel }) => tunnel.close()),
    );
    assert.ok(
      results.every((result) => result.status === 'fulfilled'),
      'Stop every owned database forward.',
    );
  }
}
