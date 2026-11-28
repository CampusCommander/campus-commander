import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';
import { generateBootstrapCredential } from '../bootstrap/access.mjs';

export function installationSecretPath(root, reference) {
  return reference.provider === 'file'
    ? join(root, reference.path.split('/').at(-1))
    : join(root, reference.name, reference.key);
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (await realpath(path)) !== path
  )
    throw new Error(
      'Secret directories must be private and exclude symbolic links.',
    );
}

async function ensureFile(path, generate, exactSize) {
  await privateDirectory(dirname(path));
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
    await file.writeFile(generate());
    await file.sync();
    await file.close();
    file = undefined;
    const directory = await open(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return 'created';
  } catch (error) {
    await file?.close();
    if (error.code !== 'EEXIST')
      throw new Error(
        'Credential file creation failed. Preserve existing credentials before retrying.',
      );
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      (exactSize === undefined ? stat.size < 32 : stat.size !== exactSize)
    )
      throw new Error(
        exactSize === undefined
          ? 'Existing credential file is invalid or unprotected.'
          : 'The Google connection encryption key must contain exactly 32 raw bytes.',
      );
    return 'preserved';
  }
}

/** Create only installer-owned service credentials and preserve every existing credential. */
export async function prepareSecrets(
  input,
  root,
  { kestraUsername = 'installation@localhost.invalid' } = {},
) {
  const config = parseDeploymentConfig(input);
  if (resolve(root) !== root)
    throw new Error('Use an absolute private secret directory.');
  if (!/^[^\s@:]+@[^\s@:]+$/.test(kestraUsername))
    throw new Error('Kestra requires an installation email username.');
  await privateDirectory(root);
  const definitions = new Map();
  const add = (reference, generate, exactSize) => {
    const path = installationSecretPath(root, reference);
    if (definitions.has(path))
      throw new Error(
        'Independent services require distinct credential references.',
      );
    definitions.set(path, { generate, exactSize });
  };
  add(config.services.edge.bootstrapSecretRef, generateBootstrapCredential);
  add(config.services.workers.dispatchSecretRef, () =>
    randomBytes(32).toString('base64url'),
  );
  for (const name of ['applicationDatabase', 'kestraDatabase', 'redis']) {
    if (config.services[name].placement.kind === 'local')
      add(config.services[name].passwordSecretRef, () =>
        randomBytes(32).toString('base64url'),
      );
  }
  if (config.services.kestra.placement.kind === 'local') {
    add(config.services.kestra.authSecretRef, () =>
      JSON.stringify({
        username: kestraUsername,
        password: `A1${randomBytes(32).toString('base64url')}`,
      }),
    );
  }
  if (config.googleConnection?.encryptionKeySecretRef.provider === 'file')
    add(
      config.googleConnection.encryptionKeySecretRef,
      () => randomBytes(32),
      32,
    );
  const results = [];
  for (const [path, definition] of definitions)
    results.push({
      reference: path.slice(root.length + 1),
      status: await ensureFile(path, definition.generate, definition.exactSize),
    });
  return results;
}
