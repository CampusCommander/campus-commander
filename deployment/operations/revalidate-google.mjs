import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';
import { connectDatabase } from '../postgres/index.mjs';
import { revalidateGoogleRestore } from './google-restore.mjs';
import { noOtherConnections } from './quiescence.mjs';

async function readPrivateFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0)
      throw new Error('Restored target evidence is invalid.');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

/** Keep services disabled until the operator completes every recovery check. */
export async function revalidateRestoredGoogle({
  targetDirectory,
  targetConfig: input,
  applicationCredentials,
  resolveSecret,
}) {
  const targetConfig = parseDeploymentConfig(input);
  if (
    typeof targetDirectory !== 'string' ||
    resolve(targetDirectory) !== targetDirectory ||
    (await realpath(targetDirectory)) !== targetDirectory
  )
    throw new Error('Restored target evidence is invalid.');
  const directory = await lstat(targetDirectory);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0)
    throw new Error('Restored target evidence is invalid.');
  await readPrivateFile(join(targetDirectory, 'RESTORE_DISABLED'));
  const saved = parseDeploymentConfig(
    JSON.parse(
      await readPrivateFile(join(targetDirectory, 'target-configuration.json')),
    ),
  );
  const report = JSON.parse(
    await readPrivateFile(join(targetDirectory, 'restore-report.json')),
  );
  const google = report.accessRecovery?.googleConnection;
  if (
    !isDeepStrictEqual(saved, targetConfig) ||
    report.status !== 'verified-services-disabled' ||
    report.schemaVersion !== 1 ||
    report.profile !== targetConfig.profile ||
    google?.status !== 'revalidation-required' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
      google.recoveryId ?? '',
    )
  )
    throw new Error('Restored target evidence is invalid.');
  if (
    !applicationCredentials ||
    Object.keys(applicationCredentials).some(
      (key) => !['role', 'passwordSecretRef'].includes(key),
    )
  )
    throw new Error(
      'Restore migration credentials must not change the target database.',
    );
  let application, kestra;
  const temporary = join(
    targetDirectory,
    `.google-revalidation-${randomUUID()}.json`,
  );
  try {
    application = await connectDatabase(
      {
        ...targetConfig.services.applicationDatabase,
        ...applicationCredentials,
      },
      resolveSecret,
    );
    kestra = await connectDatabase(
      targetConfig.services.kestraDatabase,
      resolveSecret,
    );
    await noOtherConnections(application);
    await noOtherConnections(kestra);
    const result = await revalidateGoogleRestore({
      client: application,
      recoveryId: google.recoveryId,
      keyConfiguration: targetConfig.googleConnection,
      resolveSecret,
    });
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(result, null, 2) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(targetDirectory, 'google-revalidation.json'));
    const parent = await open(
      targetDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return result;
  } finally {
    await application?.end();
    await kestra?.end();
    await rm(temporary, { force: true });
  }
}
