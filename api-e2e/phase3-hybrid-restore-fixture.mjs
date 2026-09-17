import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, cp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import { postgresImage } from '../deployment/profiles/all-docker/render.mjs';
import { outerDocker } from './hybrid-hosts-fixture.mjs';
import { createHybridOperationsCli } from './hybrid-operations-fixture.mjs';
import { readHybridReplica } from './hybrid-replica-fixture.mjs';
import { createHybridRestoreTarget } from './phase3-hybrid-restore-target.mjs';
import { prepareRestoreAdmissions } from './restore-admission-fixture.mjs';
import { readApplicationPhase3 } from './phase3-restore-fixture.mjs';
import { applicationBrowser } from './profile-browser.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path, value) =>
  writeFile(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' });

/** Reject foreign resources before creating or stopping a recovery fixture. */
export function assertHybridRestoreOwnership({
  hosts,
  controller,
  workers,
  config,
  operator,
  services,
}) {
  assert.match(operator.project, /^cc-phase3-hybrid-[a-f0-9]{12}$/);
  assert.equal(config.phase, 3);
  assert.equal(config.profile, 'hybrid');
  assert.equal(operator.releaseRoot, '/release');
  assert.equal(operator.installationRoot, controller.root);
  assert.equal(hosts.hosts[0], controller);
  assert.deepEqual(hosts.hosts.slice(1), workers);
  assert.equal(workers.length, 2);
  assert.equal(new Set(hosts.hosts.map((host) => host.daemonId)).size, 3);
  const ownerRoot = controller.root.split('/').slice(0, 3).join('/');
  assert.ok(ownerRoot.startsWith(`/tmp/${operator.project}-`));
  for (const path of [...hosts.hosts.map((host) => host.root), hosts.shared]) {
    assert.equal(resolve(path), path);
    assert.ok(path.startsWith(`${ownerRoot}/`));
  }
  assert.equal(config.artifacts.location, join(hosts.shared, 'artifacts'));
  assert.equal(
    config.services.kestra.internalStorage.location,
    join(hosts.shared, 'kestra'),
  );
  assert.equal(services.database, `${operator.project}-postgres`);
  assert.equal(services.redis, `${operator.project}-redis`);
}

async function stateProbe(hosts, controller, mode, input) {
  const script = join(controller.root, 'restore-state.mjs');
  await copyFile('api-e2e/phase3-hybrid-restore-state.mjs', script);
  const request = join(controller.root, `restore-state-${mode}.json`);
  await json(request, input);
  return JSON.parse(
    await hosts.run(controller, [
      'docker',
      'run',
      '--rm',
      '--network',
      'host',
      '--user',
      '1000:1000',
      '--read-only',
      '--tmpfs',
      '/tmp:uid=1000,gid=1000,mode=0700',
      '--mount',
      'type=bind,source=/qualification-node,target=/fixture-node,readonly',
      '--mount',
      'type=bind,source=/release,target=/release,readonly',
      '--mount',
      `type=bind,source=${controller.root},target=${controller.root}`,
      '--mount',
      `type=bind,source=${hosts.shared},target=${hosts.shared}`,
      '--mount',
      `type=bind,source=${join(controller.root, 'private')},target=/run/secrets,readonly`,
      '--entrypoint',
      '/fixture-node',
      postgresImage,
      script,
      mode,
      request,
    ]),
  );
}

/** Restore the installed hybrid application while source services cannot serve requests. */
export async function qualifyHybridRestore(input) {
  assertHybridRestoreOwnership(input);
  const {
    hosts,
    controller,
    workers,
    config,
    operator,
    services,
    databaseOperator,
    release,
    page,
    context,
    provider,
    principalId,
    compose,
    cli,
  } = input;
  const stage = (value) =>
    input.setStage?.(`isolated hybrid restore: ${value}`);
  stage('target service preparation');
  const started = Date.now();
  const publicOrigin = config.applicationAuth.publicOrigin;
  const applicationCredentials = {
    role: databaseOperator.migrationRole,
    passwordSecretRef: databaseOperator.migrationPasswordSecretRef,
  };
  const target = await createHybridRestoreTarget({
    hosts,
    controller,
    workers,
    config,
    operator,
    databaseOperator,
    release,
  });
  let admissions;
  let sourceStopped = false;
  let externalStopped = false;
  let sourceRedisPaused = false;
  let targetClosed = false;
  let report;
  const failures = [];
  const sourceContainers = [];
  const offlineObservations = [];
  const checkOffline = async (stage) => {
    for (const item of sourceContainers) {
      const actual = JSON.parse(
        await hosts.run(item.host, ['docker', 'inspect', item.id]),
      )[0];
      assert.equal(actual.State.Running, false);
      assert.equal(
        actual.Config.Labels['com.docker.compose.project'],
        item.project,
      );
    }
    const external = JSON.parse(
      await outerDocker(['inspect', services.database, services.redis]),
    );
    assert.equal(external.length, 2);
    assert.equal(external[0].State.Running, false);
    assert.equal(external[1].State.Running, true);
    assert.equal(external[1].State.Paused, true);
    offlineObservations.push({
      stage,
      stoppedApplicationContainers: sourceContainers.length,
      quiescedExternalServices: external.map(({ Id, Name, State }) => ({
        id: Id,
        name: Name.slice(1),
        state: State.Paused ? 'paused' : 'stopped',
      })),
      observedAt: new Date().toISOString(),
    });
  };
  try {
    stage('pending admissions');
    admissions = await prepareRestoreAdmissions(page, publicOrigin, provider);
    const cookie = (await context.cookies())
      .filter(({ name }) => name.startsWith('__Host-'))
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
    assert.ok(cookie);
    for (const host of hosts.hosts) {
      const project =
        host === controller
          ? operator.project
          : `${operator.project}-${host.role}`;
      const ids = (await compose(host, ['ps', '--quiet']))
        .split('\n')
        .filter(Boolean);
      assert.ok(ids.length > 0);
      for (const container of JSON.parse(
        await hosts.run(host, ['docker', 'inspect', ...ids]),
      )) {
        assert.equal(
          container.Config.Labels['com.docker.compose.project'],
          project,
        );
        sourceContainers.push({ host, project, id: container.Id });
      }
    }
    stage('source quiescence');
    sourceStopped = true;
    for (const host of hosts.hosts) await compose(host, ['stop']);
    const proofPath = join(controller.root, 'restore-source-proof.json');
    const stateInput = {
      configurationPath: join(controller.root, 'deployment.json'),
      applicationCredentials,
      principalId,
      invitationIds: admissions.invitationIds,
      proofPath,
    };
    stage('source state seed');
    const seeded = await stateProbe(hosts, controller, 'seed', stateInput);
    assert.equal(seeded.status, 'seeded');
    const backupDirectory = join(controller.root, 'isolated-restore-backup');
    const keyRecovery = {
      id: 'phase3-hybrid-restore',
      version: 1,
      reference: { provider: 'file', path: '/run/secrets/restore-backup-key' },
    };
    const sourceCli = await createHybridOperationsCli({
      hosts,
      controller,
      project: operator.project,
    });
    await sourceCli.generateKey('restore-backup-key');
    stage('native encrypted backup');
    const backup = await sourceCli.run('backup', {
      config,
      release,
      backupDirectory,
      keyRecovery,
      applicationCredentials,
      sourceRoots: {
        artifacts: config.artifacts.location,
        kestraInternal: config.services.kestra.internalStorage.location,
      },
      quiesce: {
        operator: 'phase3-hybrid-restore-fixture',
        stoppedAt: new Date().toISOString(),
        stoppedServices: ['api', 'workers', 'kestra'],
      },
    });
    assert.equal(backup.result.status, 'complete');
    assert.equal(
      (await sourceCli.run('verify', { backupDirectory, keyRecovery })).result
        .status,
      'verified',
    );
    const manifest = JSON.parse(
      await readFile(join(backupDirectory, 'manifest.json')),
    );
    assert.ok(manifest.files.length > 0);
    assert.ok(
      manifest.files.every((file) => file.encryptedPath.endsWith('.enc')),
    );
    const targetBackup = join(target.controller.root, 'backup');
    await cp(backupDirectory, targetBackup, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await copyFile(
      join(controller.root, 'private/restore-backup-key'),
      join(target.services.privateRoot, 'restore-backup-key'),
    );
    const targetProof = join(
      target.controller.root,
      'restore-source-proof.json',
    );
    await copyFile(proofPath, targetProof);
    stage('source external service isolation');
    externalStopped = true;
    await outerDocker(['stop', services.database]);
    await outerDocker(['pause', services.redis]);
    sourceRedisPaused = true;
    await checkOffline('before-restore');
    const targetCli = await createHybridOperationsCli({
      hosts,
      controller: target.controller,
      project: operator.project,
      googlePreload: join(
        target.controller.root,
        'google-connection-preload.cjs',
      ),
    });
    assert.equal(
      (
        await targetCli.run('verify', {
          backupDirectory: targetBackup,
          keyRecovery,
        })
      ).result.status,
      'verified',
    );
    stage('native restore');
    const restored = await targetCli.run('restore', {
      targetConfig: target.config,
      targetDirectory: target.targetDirectory,
      backupDirectory: targetBackup,
      keyRecovery,
      applicationCredentials,
    });
    assert.equal(restored.result.status, 'verified-services-disabled');
    assert.equal(restored.result.redisRecovery.releaseRequiresFreshRedis, true);
    const markerPath = join(target.targetDirectory, 'RESTORE_DISABLED');
    const marker = await readFile(markerPath);
    stage('restored state verification');
    const phase3State = await stateProbe(hosts, target.controller, 'verify', {
      ...stateInput,
      configurationPath: target.configPath,
      proofPath: targetProof,
      targetDirectory: target.targetDirectory,
    });
    assert.equal(phase3State.status, 'preserved-awaiting-revalidation');
    stage('Google revalidation');
    const revalidation = (
      await targetCli.run('revalidate-google', {
        targetConfig: target.config,
        targetDirectory: target.targetDirectory,
        applicationCredentials,
      })
    ).result;
    assert.equal(revalidation.status, 'revalidated');
    assert.equal(revalidation.customerId, seeded.customerId);
    assert.equal(revalidation.generation, 1);
    assert.deepEqual(await readFile(markerPath), marker);
    stage('startup lock rejection');
    await assert.rejects(target.cli('prepare'), (error) => {
      try {
        return JSON.parse(error.stderr.trim()).code === 'RESTORE_DISABLED';
      } catch {
        return false;
      }
    });
    assert.deepEqual(await readFile(markerPath), marker);
    await checkOffline('after-revalidation');
    const freshServices = JSON.parse(
      await outerDocker([
        'inspect',
        target.services.database,
        target.services.redis,
      ]),
    );
    assert.equal(freshServices.length, 2);
    for (const container of freshServices) {
      assert.equal(container.State.Running, true);
      assert.ok(new Date(container.Created).getTime() >= started);
    }
    // The fixture operator accepts the verified state before enabling target services.
    await rm(markerPath);
    stage('delivered target installation');
    await target.start();
    stage('bootstrap revocation after target startup');
    const bootstrap = await stateProbe(hosts, target.controller, 'bootstrap', {
      configurationPath: target.configPath,
      applicationCredentials,
    });
    assert.equal(bootstrap.status, 'passed');
    phase3State.bootstrapRevokedAfterStartup =
      bootstrap.bootstrapRevokedAfterStartup;

    const replicas = (
      await target.compose(target.controller, ['ps', '--quiet', 'api'])
    )
      .split('\n')
      .filter(Boolean);
    assert.equal(replicas.length, 2);
    assert.equal(new Set(replicas).size, 2);
    const sessionChecks = [];
    for (const replica of replicas) {
      const result = await readHybridReplica({
        hosts,
        controller: target.controller,
        replica,
        path: '/api/auth/session',
        cookie,
      });
      assert.equal(result.status, 401);
      sessionChecks.push({ replica, status: result.status });
    }
    stage('target admission rejection');
    const admissionRecovery = await admissions.verifyTarget();
    stage('target application checks');
    const application = await applicationBrowser(
      publicOrigin,
      async ({ page: restoredPage }) => {
        await expect(restoredPage.locator('html')).toHaveAttribute(
          'data-theme',
          'dark',
        );
        return readApplicationPhase3(restoredPage, publicOrigin, seeded);
      },
      { recoverySeconds: 120 },
    );
    await checkOffline('after-target-browser-verification');
    stage('target cleanup');
    await target.close();
    targetClosed = true;
    await outerDocker(['start', services.database]);
    externalStopped = false;
    await outerDocker(['unpause', services.redis]);
    sourceRedisPaused = false;
    for (const host of workers) await compose(host, ['up', '-d']);
    assert.equal((await cli('resume')).status, 'ready');
    sourceStopped = false;
    stage('source callback control');
    assert.equal(await admissions.verifySourceControl(principalId), true);
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Diagnostics', exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    report = {
      status: 'passed',
      durationMs: Date.now() - started,
      backup: {
        manifestSha256: hash(
          await readFile(join(backupDirectory, 'manifest.json')),
        ),
        createdAt: manifest.createdAt,
        encryptedFiles: manifest.files.length,
      },
      operatorCli: {
        ...targetCli.execution,
        sourceCommands: sourceCli.commands,
        targetCommands: targetCli.commands,
      },
      targetInstallerCommands: target.commands,
      phase3State: {
        ...phase3State,
        status: 'passed',
        revalidation,
        markerPreserved: true,
        startupBlockedBeforeAcceptance: true,
      },
      isolation: {
        targetProject: target.project,
        sourceContainers: sourceContainers.map(({ host, project, id }) => ({
          host: host.role,
          daemonId: host.daemonId,
          project,
          id,
        })),
        observations: offlineObservations,
        freshExternalServices: freshServices.map(({ Id, Name }) => ({
          id: Id,
          name: Name.slice(1),
        })),
        targetStorageSeparate: true,
      },
      sessionChecks,
      admissionRecovery: {
        ...admissionRecovery,
        sourceCallbackControlPassed: true,
      },
      application,
      limits: [
        'Separate Compose projects and storage trees reuse three Docker daemons on one physical host.',
        'Fresh external PostgreSQL and Redis containers share the synthetic district network.',
        'Source Redis remains paused to preserve the pending authorization control. Other source services remain stopped.',
        'The fixture seeds customer state after source shutdown and uses a synthetic Google provider.',
        'The source and target reuse the same HTTPS origin and synthetic sign-in provider.',
      ],
    };
  } catch (error) {
    failures.push(error);
  } finally {
    if (!targetClosed)
      try {
        await target.close();
      } catch (error) {
        failures.push(error);
      }
    if (externalStopped)
      try {
        await outerDocker(['start', services.database]);
      } catch (error) {
        failures.push(error);
      }
    if (sourceRedisPaused)
      try {
        await outerDocker(['unpause', services.redis]);
      } catch (error) {
        failures.push(error);
      }
    if (sourceStopped)
      try {
        for (const host of workers) await compose(host, ['up', '-d']);
        await cli('resume');
      } catch (error) {
        failures.push(error);
      }
    try {
      await admissions?.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      'Hybrid restore qualification or cleanup failed.',
    );
  return report;
}
