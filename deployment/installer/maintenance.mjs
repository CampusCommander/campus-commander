import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  readFile,
  mkdir,
  open,
  rename,
  rm,
  realpath,
} from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { verifyBackup } from '../operations/index.mjs';
import { installationSecretPath } from './secrets.mjs';
import { withProgress } from './progress.mjs';
import { OnboardingError } from './google-client.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => {
  throw new OnboardingError(message);
};
async function read(path, privateFile = true) {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (privateFile && stat.mode & 0o077) ||
    stat.size > 4 * 1024 * 1024 ||
    (await realpath(path)) !== path
  )
    fail('Use protected regular installation files without symbolic links.');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function write(path, value) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await realpath(parent)) !== parent || (await lstat(parent)).mode & 0o077)
    fail('Use a private installation directory without symbolic links.');
  try {
    await read(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${randomUUID()}`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(parent, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function pendingUpdate(root) {
  let journal;
  try {
    journal = await read(join(root, 'setup-update.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (
    journal.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(journal.configurationFileHash) ||
    !/^[a-f0-9]{64}$/.test(journal.previousReleaseHash) ||
    !/^[a-f0-9]{64}$/.test(journal.targetReleaseHash) ||
    !/^[a-f0-9]{40}$/.test(journal.revision) ||
    journal.previousOperator?.installationRoot !== root ||
    journal.previousOperator.configurationPath !==
      join(root, 'deployment.json') ||
    journal.targetOperator?.installationRoot !== root ||
    journal.targetOperator.configurationPath !==
      join(root, 'updates', journal.revision, 'deployment.json') ||
    !journal.targetOperator.releaseRoot ||
    resolve(journal.targetOperator.releaseRoot) !==
      journal.targetOperator.releaseRoot
  )
    fail(
      'The pending update record is invalid. Preserve the installation for recovery.',
    );
  return journal;
}

export async function updateOperator(root, journal) {
  const state = await read(join(root, 'installer-state.json'));
  if (state.releaseHash === journal.previousReleaseHash)
    return journal.previousOperator;
  if (state.releaseHash === journal.targetReleaseHash)
    return journal.targetOperator;
  fail(
    'The installation differs from its pending update. Preserve both records for recovery.',
  );
}

/** Keep original inputs until the existing backup-gated upgrade admits the target. */
export async function updateInstallation({
  root,
  releaseRoot,
  operator,
  config,
  qualification,
  q,
  output,
  installer,
  verify = verifyBackup,
  publish = write,
}) {
  const lock = join(root, '.setup-update-lock');
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    fail(
      'Another update holds the setup lock. Confirm it stopped before removing a stale lock.',
    );
  }
  try {
    let journal = await pendingUpdate(root);
    if (!journal) {
      const state = await read(join(root, 'installer-state.json'));
      if (state.phase !== 'ready')
        fail('Resume this installation to readiness before updating.');
      const manifestPath = join(releaseRoot, 'release-manifest.json');
      const target = await read(manifestPath, false);
      if (
        !/^[a-f0-9]{40}$/.test(target.sourceRevision ?? '') ||
        (target.phase ?? 1) !== (config.phase ?? 1)
      )
        fail(
          'Guided update requires a release for the installed phase. Use the phase migration procedure to change phases.',
        );
      const targetHash = hash(await readFile(manifestPath));
      if (targetHash === state.releaseHash) {
        output(
          'This release is already installed. Configuration and credentials remain unchanged.',
        );
        return { status: 'already-current' };
      }
      output(
        `Installed release: ${(await read(operator.releasePath, false)).sourceRevision}. Target release: ${target.sourceRevision}.`,
      );
      const backupDirectory = await q(
        'update.backupDirectory',
        'Verified recovery backup directory',
        undefined,
        (value) => typeof value === 'string' && resolve(value) === value,
      );
      const backupInput = await read(join(backupDirectory, 'manifest.json'));
      const upgradeBackup = {
        backupDirectory,
        keyRecovery: backupInput.keyRecovery,
      };
      const backup = await withProgress(
        () =>
          verify({
            ...upgradeBackup,
            resolveSecret: (ref) =>
              readFile(installationSecretPath(join(root, 'private'), ref)),
          }),
        output,
        'verifying the recovery backup',
      );
      if (
        backup.profile !== config.profile ||
        !isDeepStrictEqual(backup.release.images, config.images)
      )
        fail(
          'The recovery backup does not match the installed release. Create and verify a matching backup.',
        );
      output(
        'Update preserves application data, credentials, and administrator access. Services restart during the update.',
      );
      const confirmed = await q(
        'confirmUpdate',
        'Type update to apply this release, or cancel',
        'cancel',
        (value) => ['update', 'cancel'].includes(value),
      );
      if (confirmed !== 'update') {
        q.finish();
        return { status: 'cancelled' };
      }
      const configurationPath = join(
        root,
        'updates',
        target.sourceRevision,
        'deployment.json',
      );
      await write(configurationPath, { ...config, images: target.images });
      const targetOperator = {
        ...operator,
        configurationPath,
        releaseRoot,
        releasePath: manifestPath,
        trust:
          operator.trust?.kind === 'cosign'
            ? {
                ...operator.trust,
                bundlePath: join(releaseRoot, 'release-manifest.sigstore.json'),
              }
            : operator.trust,
        upgradeFromReleaseHash: state.releaseHash,
        upgradeBackup,
        backupManifestSha256: hash(
          await readFile(join(backupDirectory, 'manifest.json')),
        ),
      };
      if (!qualification && targetOperator.trust?.kind !== 'cosign')
        fail(
          'Guided update requires the hosted signing configuration. Use the operator upgrade procedure for another trust provider.',
        );
      await write(
        join(root, 'updates', target.sourceRevision, 'operator.json'),
        targetOperator,
      );
      journal = {
        schemaVersion: 1,
        configurationFileHash: hash(await readFile(configurationPath)),
        revision: target.sourceRevision,
        previousReleaseHash: state.releaseHash,
        targetReleaseHash: targetHash,
        previousOperator: operator,
        targetOperator,
      };
      await write(join(root, 'setup-update.json'), journal);
    } else {
      q.reserve('update.backupDirectory');
      q.reserve('confirmUpdate');
      output(
        'Resuming the recorded update. The target release and recovery backup remain fixed.',
      );
    }
    q.reserve('workersReady');
    q.finish();
    await read(journal.targetOperator.configurationPath);
    if (
      hash(await readFile(journal.targetOperator.configurationPath)) !==
      journal.configurationFileHash
    )
      fail(
        'The staged configuration changed. Restore its verified contents before resuming the update.',
      );
    let state = await read(join(root, 'installer-state.json'));
    if (state.releaseHash === journal.previousReleaseHash) {
      if (['stopped', 'uninstalled'].includes(state.phase)) {
        await withProgress(
          (onProgress) =>
            installer({
              command: 'resume',
              operator: journal.previousOperator,
              qualification,
              onProgress,
            }),
          output,
          'restoring services before the pending update',
        );
      }
      await withProgress(
        (onProgress) =>
          installer({
            command: 'upgrade',
            prepareOnly: true,
            operator: journal.targetOperator,
            qualification,
            onProgress,
          }),
        output,
        'preparing the verified update',
      );
      state = await read(join(root, 'installer-state.json'));
    }
    if (state.releaseHash !== journal.targetReleaseHash)
      fail(
        'The installation differs from the recorded update. Preserve its recovery records.',
      );
    if (state.phase !== 'ready') {
      if (config.profile === 'hybrid') {
        output(
          'Update each declared worker host with its generated docker-compose.worker-*.json file and existing protected mounts.',
        );
        if (
          (await q(
            'workersReady',
            'Have all declared worker hosts received this update (yes/no)',
            'no',
            (value) => ['yes', 'no'].includes(value),
          )) !== 'yes'
        )
          return { status: 'prepared-workers-pending' };
      }
      await withProgress(
        (onProgress) =>
          installer({
            command: 'resume',
            operator: journal.targetOperator,
            qualification,
            onProgress,
          }),
        output,
        'starting updated services',
      );
      state = await read(join(root, 'installer-state.json'));
    }
    if (
      state.phase !== 'ready' ||
      state.releaseHash !== journal.targetReleaseHash
    )
      fail(
        'The updated services are not ready. Resume the same update after correcting service failures.',
      );
    const next = await read(journal.targetOperator.configurationPath);
    if (
      hash(await readFile(journal.targetOperator.configurationPath)) !==
      journal.configurationFileHash
    )
      fail(
        'The staged configuration changed. Restore its verified contents before resuming the update.',
      );
    await publish(join(root, 'deployment.json'), next);
    await publish(join(root, 'operator.json'), {
      ...journal.targetOperator,
      configurationPath: join(root, 'deployment.json'),
    });
    await rm(join(root, 'setup-update.json'));
    output(
      'Update completed. Application data, credentials, and administrator access remain in place.',
    );
    return { status: 'ready', updated: true };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
