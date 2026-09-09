#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseDeploymentConfig } from '../../../dist/deployment/lib/deployment.js';
import {
  installationSecretPath,
  prepareSecrets,
} from '../../installer/secrets.mjs';

const execute = promisify(execFile);
const kestraRenderer = resolve(
  import.meta.dirname,
  '../../kestra/render-config.mjs',
);

async function defaultRun(file, args, options = {}) {
  return execute(file, args, {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

async function protectedFile(path, label) {
  const stat = await lstat(path).catch(() => undefined);
  if (
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (await realpath(path)) !== path
  ) {
    throw new Error(`${label} must be a protected regular file.`);
  }
  return path;
}

function requirePrivateCa(service, label) {
  if (service.endpoint.tls.mode !== 'private-ca') {
    throw new Error(`${label} requires a private CA reference.`);
  }
  return service.endpoint.tls.caSecretRef;
}

function databaseUrl(database, rootCertificatePath) {
  const endpoint = database.endpoint.url.replace(/\/$/, '');
  return `jdbc:${endpoint}/${database.database}?sslmode=verify-full&sslrootcert=${rootCertificatePath}`;
}

/** Prepare protected Kestra runtime files for a local hybrid Kestra service. */
export async function prepareHybrid(
  configPath,
  outputRoot,
  { run = defaultRun, render = undefined } = {},
) {
  const installationRoot = resolve(outputRoot);
  const privateRoot = resolve(installationRoot, 'private');
  const runtimeRoot = resolve(installationRoot, 'runtime', 'kestra');
  const input = JSON.parse(await readFile(configPath, 'utf8'));
  const config = parseDeploymentConfig(input);

  if (config.profile !== 'hybrid') {
    throw new Error('Preparation requires the hybrid profile.');
  }
  if (config.services.kestra.placement.kind !== 'local') {
    throw new Error('Hybrid preparation requires a local Kestra service.');
  }
  if (config.services.kestra.internalStorage.kind !== 'shared-filesystem') {
    throw new Error(
      'Hybrid preparation requires shared Kestra internal storage.',
    );
  }

  for (const [file, args, label] of [
    [process.execPath, ['--version'], 'Node.js'],
    ['openssl', ['version'], 'OpenSSL'],
    ['keytool', ['-help'], 'Java keytool'],
  ]) {
    try {
      await run(file, args);
    } catch {
      throw new Error(`${label} is required for hybrid Kestra preparation.`);
    }
  }

  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  const runtimeStat = await lstat(runtimeRoot);
  if (
    runtimeStat.isSymbolicLink() ||
    (await realpath(runtimeRoot)) !== runtimeRoot
  ) {
    throw new Error(
      'The Kestra runtime directory must exclude symbolic links.',
    );
  }
  const storagePath = config.services.kestra.internalStorage.location;
  await access(storagePath, constants.R_OK | constants.W_OK).catch(() => {
    throw new Error(
      'Kestra shared internal storage requires read and write access.',
    );
  });
  if (!(await lstat(storagePath)).isDirectory()) {
    throw new Error('Kestra shared internal storage must be a directory.');
  }

  const secrets = await prepareSecrets(input, privateRoot);
  const secretPath = async (reference, label) =>
    protectedFile(installationSecretPath(privateRoot, reference), label);

  const kestra = config.services.kestra;
  const workers = config.services.workers;
  const database = config.services.kestraDatabase;
  const databaseCa = await secretPath(
    requirePrivateCa(database, 'The district Kestra database'),
    'The district database CA',
  );
  const serverCa = await secretPath(
    requirePrivateCa(kestra, 'The Kestra endpoint'),
    'The Kestra server CA',
  );
  const workerCa = await secretPath(
    requirePrivateCa(workers, 'The worker endpoint'),
    'The worker CA',
  );
  for (const [path, label] of new Map([
    [databaseCa, 'district database CA'],
    [serverCa, 'Kestra server CA'],
    [workerCa, 'worker CA'],
  ])) {
    try {
      await run('openssl', ['x509', '-in', path, '-noout']);
    } catch {
      throw new Error(`The ${label} must contain an X.509 certificate.`);
    }
  }
  const databaseCaRuntimePath = resolve(runtimeRoot, 'database-ca.pem');
  await copyFile(databaseCa, databaseCaRuntimePath);
  await chmod(databaseCaRuntimePath, 0o600);
  const serverCaRuntimePath = resolve(runtimeRoot, 'server-ca.pem');
  await copyFile(serverCa, serverCaRuntimePath);
  await chmod(serverCaRuntimePath, 0o600);

  const environment = {
    ...process.env,
    CC_KESTRA_PROFILE: 'hybrid',
    CC_KESTRA_RUNTIME_DIR: runtimeRoot,
    CC_KESTRA_RUNTIME_MOUNT_PATH: '/run/kestra-runtime',
    CC_KESTRA_AUTH_FILE: await secretPath(
      kestra.authSecretRef,
      'The Kestra authentication file',
    ),
    CC_KESTRA_DATABASE_PASSWORD_FILE: await secretPath(
      database.passwordSecretRef,
      'The Kestra database password',
    ),
    CC_KESTRA_DATABASE_URL: databaseUrl(
      database,
      '/run/kestra-runtime/database-ca.pem',
    ),
    CC_KESTRA_DATABASE_USERNAME: database.role,
    CC_KESTRA_URL: kestra.endpoint.url,
    CC_KESTRA_TLS_ENABLED: 'true',
    CC_KESTRA_TLS_CERTIFICATE_FILE: await secretPath(
      kestra.serverTls.certificateSecretRef,
      'The Kestra server certificate',
    ),
    CC_KESTRA_TLS_PRIVATE_KEY_FILE: await secretPath(
      kestra.serverTls.privateKeySecretRef,
      'The Kestra server private key',
    ),
    CC_KESTRA_STORAGE_PATH: '/app/storage',
    CC_KESTRA_WORKER_BASE_URL: workers.endpoint.url,
    CC_KESTRA_WORKER_DISPATCH_SECRET_FILE: await secretPath(
      workers.dispatchSecretRef,
      'The worker dispatch secret',
    ),
    CC_KESTRA_WORKER_CA_FILE: workerCa,
  };

  if (render) await render(environment);
  else await run(process.execPath, [kestraRenderer], { env: environment });

  const runtimeFiles = [
    'application.yaml',
    'database-ca.pem',
    'flow-secrets.env',
    'probe-header',
    'runtime-environment.json',
    'server-ca.pem',
    'server.p12',
    'worker-truststore.p12',
  ];
  for (const name of runtimeFiles) {
    await protectedFile(
      resolve(runtimeRoot, name),
      `Kestra runtime file ${name}`,
    );
  }

  return {
    profile: 'hybrid',
    kestraPlacement: 'local',
    databasePlacement: database.placement.kind,
    externalDatabase: database.placement.kind === 'external',
    secrets,
    runtimeDirectory: 'runtime/kestra',
    runtimeFiles,
  };
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
    prepareHybrid(configPath, outputRoot)
      .then((result) =>
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
      )
      .catch((error) => {
        process.stderr.write(
          `Hybrid Kestra preparation failed: ${error.message}\n`,
        );
        process.exitCode = 1;
      });
  }
}
