import assert from 'node:assert/strict';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertHybridFaultOwnership,
  createHybridFaultStateProbe,
} from './phase3-hybrid-fault-state.mjs';
import { backupHybridForUpgrade } from './phase3-hybrid-upgrade-fixture.mjs';
import { verifyHybridImages } from './hybrid-cli-upgrade-fixture.mjs';

/** Require a distributed update to pass through its worker handoff before completion. */
export function assertHybridUpdateSequence(commands) {
  assert.deepEqual(
    commands.map(({ command, status }) => ({ command, status })),
    [
      { command: 'update', status: 'cancelled' },
      { command: 'update', status: 'prepared-workers-pending' },
      { command: 'resume', status: 'ready' },
      { command: 'update', status: 'already-current' },
    ],
  );
  assert.ok(
    commands.every(
      ({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0,
    ),
  );
}

/** Execute the delivered guided update with native backup and separate worker handoff. */
export async function qualifyHybridUpdate(input) {
  assertHybridFaultOwnership(input);
  const {
    hosts,
    config,
    project,
    compose,
    cli,
    transfer,
    target,
    bin,
    activateTarget,
    verifyAfterUpdate,
    evidencePath,
    evidenceIdentity,
    setStage,
  } = input;
  const [controller, ...workers] = hosts.hosts;
  const root = controller.root;
  assert.equal(target.manifest.phase, 3);
  assert.notEqual(
    target.manifest.sourceRevision,
    evidenceIdentity.sourceRevision,
  );
  assert.equal(bin, join(root, 'qualification-bin'));
  const startedAt = Date.now();
  const report = {
    ...evidenceIdentity,
    schemaVersion: 1,
    phase: 3,
    profile: 'hybrid',
    status: 'in-progress',
    recordedAt: new Date().toISOString(),
    commands: [],
    target: {
      sourceRevision: target.manifest.sourceRevision,
      images: target.manifest.images,
      bundleManifestSha256: target.manifestSha256,
    },
    durationScope:
      'Durable-state setup, native cold backup, cancelled update, worker handoff, guided update, repeated update and resume, and preservation checks.',
    limits: [
      'Source and target are separately verified laboratory releases. Other source qualification does not transfer to the target.',
      'Three Docker daemons share one physical host and synthetic district services.',
      'The fixture records laboratory setup mode for an installation created through the delivered operator CLI.',
    ],
  };
  const save = async () => {
    report.durationMs = Date.now() - startedAt;
    await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
  };
  const stage = async (value) => {
    report.stage = value;
    setStage(value);
    await save();
  };
  try {
    await stage('baseline');
    const verifyDurable = await createHybridFaultStateProbe({
      ...input,
      allowAppendedMigrations: true,
    });
    report.sourceImages = await verifyHybridImages(
      { hosts, controller, workers, compose },
      config.images,
    );
    const operatorPath = join(root, 'operator.json');
    const configPath = join(root, 'deployment.json');
    const statePath = join(root, 'installer-state.json');
    await stage('native-cold-backup');
    for (const host of workers) await compose(host, ['stop']);
    await compose(controller, ['stop', 'edge', 'api', 'kestra']);
    const backup = await backupHybridForUpgrade({
      hosts,
      controller,
      config,
      project,
    });
    report.backup = {
      commands: backup.commands,
      execution: backup.execution,
      manifestSha256: backup.manifestSha256,
    };
    for (const host of workers) await compose(host, ['up', '-d']);
    assert.equal((await cli('resume')).status, 'ready');
    await verifyDurable();
    const beforeState = JSON.parse(await readFile(statePath));
    const beforeConfig = await readFile(configPath);
    const beforeOperator = await readFile(operatorPath);
    assert.equal(beforeState.phase, 'ready');
    const secrets = [];
    for (const host of hosts.hosts)
      for (const name of await readdir(join(host.root, 'private')))
        secrets.push({
          path: join(host.root, 'private', name),
          bytes: await readFile(join(host.root, 'private', name)),
        });
    await writeFile(
      join(root, 'setup-record.json'),
      JSON.stringify({
        schemaVersion: 1,
        qualification: true,
        candidateAcknowledgement: 'candidate-lab',
        selfSignedCertificate: false,
      }),
      { mode: 0o600, flag: 'wx' },
    );
    const invoke = async (command, answers, expectedStatus) => {
      const path = join(root, 'guided-update-answers.json');
      await writeFile(path, JSON.stringify(answers), { mode: 0o600 });
      const invocationStarted = Date.now();
      let output;
      try {
        output = await hosts.run(controller, [
          'env',
          `PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
          'node',
          '/update/deployment/installer/setup.mjs',
          '--release-root',
          '/update',
          '--root',
          root,
          '--command',
          command,
          '--qualification',
          '--answers',
          path,
        ]);
      } catch {
        throw new Error(
          'Delivered hybrid guided update failed. Inspect protected installation state.',
        );
      }
      assert.ok(
        output.includes(`Update status: ${expectedStatus}.`),
        'The delivered guided update must report the expected status.',
      );
      report.commands.push({
        command,
        status: expectedStatus,
        durationMs: Date.now() - invocationStarted,
      });
      await save();
    };
    await stage('cancelled-update');
    const answers = {
      'update.backupDirectory': backup.upgradeBackup.backupDirectory,
      confirmUpdate: 'cancel',
    };
    await invoke('update', answers, 'cancelled');
    assert.ok(beforeConfig.equals(await readFile(configPath)));
    assert.ok(beforeOperator.equals(await readFile(operatorPath)));
    assert.deepEqual(JSON.parse(await readFile(statePath)), beforeState);
    await verifyDurable();
    report.cancelledUpdatePreserved = true;
    await stage('prepare-worker-handoff');
    await invoke(
      'update',
      { ...answers, confirmUpdate: 'update', workersReady: 'no' },
      'prepared-workers-pending',
    );
    const prepared = JSON.parse(await readFile(statePath));
    assert.equal(prepared.phase, 'prepared');
    assert.equal(prepared.releaseHash, target.manifestSha256);
    assert.ok(beforeConfig.equals(await readFile(configPath)));
    assert.ok(beforeOperator.equals(await readFile(operatorPath)));
    await access(join(root, 'setup-update.json'));
    await transfer();
    for (const host of workers) await compose(host, ['up', '-d']);
    report.workerHandoff = {
      generatedFragmentsTransferred: true,
      daemonIds: workers.map(({ daemonId }) => daemonId),
    };
    await stage('resume-update');
    await invoke('resume', { workersReady: 'yes' }, 'ready');
    const afterState = JSON.parse(await readFile(statePath));
    assert.equal(afterState.phase, 'ready');
    assert.equal(afterState.releaseHash, target.manifestSha256);
    assert.notEqual(afterState.releaseHash, beforeState.releaseHash);
    assert.deepEqual(JSON.parse(await readFile(configPath)), {
      ...config,
      images: target.manifest.images,
    });
    const afterOperator = JSON.parse(await readFile(operatorPath));
    assert.equal(afterOperator.releaseRoot, '/update');
    assert.equal(afterOperator.configurationPath, configPath);
    await assert.rejects(access(join(root, 'setup-update.json')), {
      code: 'ENOENT',
    });
    for (const { path, bytes } of secrets)
      assert.ok(
        bytes.equals(await readFile(path)),
        'Guided update must preserve each original secret.',
      );
    report.targetImages = await verifyHybridImages(
      { hosts, controller, workers, compose },
      target.manifest.images,
    );
    report.durableState = await verifyDurable();
    await verifyAfterUpdate();
    await stage('repeat-update-and-resume');
    await invoke('update', {}, 'already-current');
    activateTarget();
    assert.equal((await cli('resume')).status, 'ready');
    report.durableState = await verifyDurable();
    await verifyAfterUpdate();
    assertHybridUpdateSequence(report.commands);
    report.checks = {
      backupVerified: true,
      configurationPreserved: true,
      originalSecretsPreserved: true,
      migrationChecksumsPreserved: true,
      targetImagesRunning: true,
      updateJournalRemoved: true,
      preservedWorkflowsReadable: true,
      workerHandoffRequired: true,
      repeatedUpdate: true,
      repeatedResume: true,
    };
    report.status = 'passed';
    await stage('complete');
    return report;
  } catch (error) {
    report.status = 'failed';
    await save();
    throw error;
  }
}
