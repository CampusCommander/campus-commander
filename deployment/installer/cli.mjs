#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { executeInstaller, InstallerError } from './orchestrator.mjs';

try {
  let [command, operatorPath] = process.argv.slice(2);
  const flags = process.argv.slice(4);
  if (flags.some((flag) => flag !== '--qualification'))
    throw new InstallerError(
      'ARGUMENT',
      'Use only documented command arguments.',
    );
  if (!command || !operatorPath) {
    if (!process.stdin.isTTY)
      throw new InstallerError(
        'ARGUMENT',
        'Provide a command and operator JSON file for noninteractive installation.',
      );
    const prompt = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      command =
        command ||
        (await prompt.question(
          'Command (validate, preflight, prepare, install, resume, upgrade, status, stop, uninstall, erase, support, reset-bootstrap): ',
        ));
      const profile = await prompt.question(
        'Profile (all-docker, hybrid, kubernetes): ',
      );
      if (!['all-docker', 'hybrid', 'kubernetes'].includes(profile))
        throw new InstallerError(
          'PROFILE',
          'Select a supported installation profile.',
        );
      operatorPath = await prompt.question('Operator JSON file: ');
      const operator = JSON.parse(await readFile(operatorPath, 'utf8'));
      const config = JSON.parse(
        await readFile(operator.configurationPath, 'utf8'),
      );
      if (config.profile !== profile)
        throw new InstallerError(
          'PROFILE',
          'Selected profile differs from the authoritative configuration.',
        );
    } finally {
      prompt.close();
    }
  }
  const operator = JSON.parse(await readFile(operatorPath, 'utf8'));
  const result = await executeInstaller({
    command,
    operator,
    qualification: flags.includes('--qualification'),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  const safe =
    error instanceof InstallerError
      ? error
      : new InstallerError(
          'INPUT',
          'Read the operator and configuration files before retrying.',
        );
  process.stderr.write(
    JSON.stringify({
      status: 'failed',
      code: safe.code,
      instruction: safe.message,
    }) + '\n',
  );
  process.exitCode = 1;
}
