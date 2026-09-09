#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDeploymentConfig } from '../../../dist/deployment/lib/deployment.js';
import { prepareSecrets } from '../../installer/secrets.mjs';
import { normalizePostgresSecret } from '../../postgres/secrets.mjs';

async function ensureCredential(path) {
  let file;
  try {
    file = await open(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    await file.writeFile(randomBytes(32).toString('base64url'));
    await file.sync();
    return 'created';
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      stat.size < 32
    )
      throw new Error(
        'Existing operator credential is invalid or unprotected.',
      );
    return 'preserved';
  } finally {
    await file?.close();
  }
}

export async function prepareAllDocker(configPath, outputRoot) {
  const root = resolve(outputRoot);
  const privateRoot = resolve(root, 'private');
  const runtimeRoot = resolve(root, 'runtime');
  const input = JSON.parse(await readFile(configPath, 'utf8'));
  const config = parseDeploymentConfig(input);
  if (config.profile !== 'all-docker')
    throw new Error('Preparation requires the all-docker profile.');
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const results = await prepareSecrets(input, privateRoot);
  for (const name of [
    'application-postgres-admin-password',
    'kestra-postgres-admin-password',
    'postgres-migrator',
  ]) {
    results.push({
      reference: name,
      status: await ensureCredential(resolve(privateRoot, name)),
    });
    if (name.endsWith('-admin-password')) {
      const bytes = await readFile(resolve(privateRoot, name));
      normalizePostgresSecret(bytes);
      if (bytes.includes(10) || bytes.includes(13))
        throw new Error(
          'Local PostgreSQL administrator files require exact UTF-8 password bytes without CR or LF.',
        );
    }
  }
  const operator = {
    adminDatabase: 'postgres',
    adminRole: 'postgres',
    adminPasswordSecretRef: {
      provider: 'file',
      path: '/run/secrets/application-postgres-admin-password',
    },
    migrationRole: 'application-installer',
    migrationPasswordSecretRef: {
      provider: 'file',
      path: '/run/secrets/postgres-migrator',
    },
    kestraAdmin: {
      adminDatabase: 'postgres',
      adminRole: 'postgres',
      adminPasswordSecretRef: {
        provider: 'file',
        path: '/run/secrets/kestra-postgres-admin-password',
      },
    },
  };
  await writeFile(
    resolve(runtimeRoot, 'operator.json'),
    `${JSON.stringify(operator, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    resolve(runtimeRoot, 'profile.json'),
    `${JSON.stringify(input, null, 2)}\n`,
    { mode: 0o600 },
  );
  return results;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [configPath, outputRoot = '.'] = process.argv.slice(2);
  if (!configPath) {
    process.stderr.write(
      'Usage: prepare.mjs <config> [installation-directory]\n',
    );
    process.exitCode = 2;
  } else {
    prepareAllDocker(configPath, outputRoot)
      .then((results) =>
        process.stdout.write(`${JSON.stringify(results, null, 2)}\n`),
      )
      .catch(() => {
        process.stderr.write(
          'All-Docker preparation failed. Check private directory permissions and existing credential files.\n',
        );
        process.exitCode = 1;
      });
  }
}
