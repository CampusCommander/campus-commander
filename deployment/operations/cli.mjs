import { randomBytes } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { backupFoundation, restoreFoundation, verifyBackup } from './index.mjs';
import { secretPath } from '../redis/runtime.mjs';
import { operationFailureReason } from './failure.mjs';

try {
  const [command, inputPath] = process.argv.slice(2);
  if (command === 'generate-key') {
    const file = await open(inputPath, 'wx', 0o600);
    try {
      await file.writeFile(randomBytes(32));
      await file.sync();
    } finally {
      await file.close();
    }
    console.log(
      'A protected backup key was created. Preserve it separately from backup material.',
    );
  } else {
    if (!['backup', 'verify', 'restore'].includes(command) || !inputPath)
      throw new Error('Invalid backup command.');
    const operator = JSON.parse(await readFile(inputPath, 'utf8'));
    const resolveSecret = (reference) => readFile(secretPath(reference));
    const common = {
      backupDirectory: operator.backupDirectory,
      keyRecovery: operator.keyRecovery,
      resolveSecret,
    };
    if (command === 'verify') {
      const manifest = await verifyBackup(common);
      console.log(
        JSON.stringify({
          status: 'verified',
          createdAt: manifest.createdAt,
          files: manifest.files.length,
        }),
      );
    } else if (command === 'backup') {
      const config = JSON.parse(
        await readFile(operator.configurationPath, 'utf8'),
      );
      const release = JSON.parse(
        await readFile(operator.releaseInventoryPath, 'utf8'),
      );
      const manifest = await backupFoundation({
        ...common,
        config,
        release,
        sourceRoots: operator.sourceRoots,
        quiesce: operator.quiesce,
        applicationCredentials: operator.applicationCredentials,
      });
      console.log(
        JSON.stringify({
          status: 'complete',
          createdAt: manifest.createdAt,
          durationMilliseconds: manifest.durationMilliseconds,
        }),
      );
    } else {
      const targetConfig = JSON.parse(
        await readFile(operator.configurationPath, 'utf8'),
      );
      const report = await restoreFoundation({
        ...common,
        targetConfig,
        targetDirectory: operator.targetDirectory,
        applicationCredentials: operator.applicationCredentials,
      });
      console.log(
        JSON.stringify({
          status: report.status,
          durationMilliseconds: report.durationMilliseconds,
          redisRecovery: report.redisRecovery,
        }),
      );
    }
  }
} catch (error) {
  console.error(
    'Foundation backup or restore failed. Check quiescence, key recovery, component integrity, and isolated target prerequisites.',
  );
  console.error(`Reason: ${operationFailureReason(error)}.`);
  process.exitCode = 1;
}
