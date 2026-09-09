#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { normalizePostgresSecret } from '../postgres/secrets.mjs';

const environment = process.env;

function required(name) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function secretText(value, name) {
  const normalized = value.replace(/\r?\n$/, '');
  if (!normalized || normalized.includes('\n') || normalized.includes('\r')) {
    throw new Error(`${name} must contain one non-empty line.`);
  }
  return normalized;
}

function yaml(value) {
  return JSON.stringify(value);
}

function shell(value) {
  if (value.includes("'")) {
    throw new Error('Runtime environment values cannot contain apostrophes.');
  }
  return `'${value}'`;
}

function temporaryPath(path) {
  return `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
}

async function replaceProtected(path, value) {
  const temporary = temporaryPath(path);
  try {
    await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

const profile = required('CC_KESTRA_PROFILE');
if (!['all-docker', 'hybrid', 'kubernetes'].includes(profile)) {
  throw new Error('CC_KESTRA_PROFILE is invalid.');
}

const runtimeDirectory = required('CC_KESTRA_RUNTIME_DIR');
if (!isAbsolute(runtimeDirectory)) {
  throw new Error('CC_KESTRA_RUNTIME_DIR must be absolute.');
}
await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
await chmod(runtimeDirectory, 0o700);
const runtimeMountPath =
  environment.CC_KESTRA_RUNTIME_MOUNT_PATH ?? runtimeDirectory;
if (!isAbsolute(runtimeMountPath)) {
  throw new Error('CC_KESTRA_RUNTIME_MOUNT_PATH must be absolute.');
}

const authentication = JSON.parse(
  await readFile(required('CC_KESTRA_AUTH_FILE'), 'utf8'),
);
const authenticationKeys = Object.keys(authentication).sort();
if (authenticationKeys.join(',') !== 'password,username') {
  throw new Error('CC_KESTRA_AUTH_FILE must match auth-secret.schema.json.');
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(authentication.username)) {
  throw new Error('Kestra Basic Auth username must be an email address.');
}
if (
  typeof authentication.password !== 'string' ||
  authentication.password.length < 8 ||
  !/[A-Z]/.test(authentication.password) ||
  !/[0-9]/.test(authentication.password)
) {
  throw new Error('Kestra Basic Auth password fails the required policy.');
}
const probeHeaderPath = join(runtimeDirectory, 'probe-header');
const basicCredential = Buffer.from(
  `${authentication.username}:${authentication.password}`,
).toString('base64');
await replaceProtected(
  probeHeaderPath,
  `Authorization: Basic ${basicCredential}\n`,
);

const databasePassword = normalizePostgresSecret(
  await readFile(required('CC_KESTRA_DATABASE_PASSWORD_FILE')),
);
const databaseUrl = required('CC_KESTRA_DATABASE_URL');
if (!databaseUrl.startsWith('jdbc:postgresql://')) {
  throw new Error('CC_KESTRA_DATABASE_URL must use jdbc:postgresql.');
}
if (
  profile !== 'all-docker' &&
  !/[?&]sslmode=verify-full(?:&|$)/.test(databaseUrl)
) {
  throw new Error(
    'Distributed profiles require PostgreSQL sslmode=verify-full.',
  );
}

const publicUrl = new URL(required('CC_KESTRA_URL'));
const tlsEnabled = environment.CC_KESTRA_TLS_ENABLED === 'true';
if (profile !== 'all-docker' && !tlsEnabled) {
  throw new Error('Distributed profiles require the Kestra HTTPS listener.');
}
if (tlsEnabled && publicUrl.protocol !== 'https:') {
  throw new Error('CC_KESTRA_URL must use HTTPS when TLS is enabled.');
}

const workerBaseUrl = environment.CC_KESTRA_WORKER_BASE_URL;
const workerUrl = workerBaseUrl ? new URL(workerBaseUrl) : undefined;
if (workerUrl && profile !== 'all-docker' && workerUrl.protocol !== 'https:') {
  throw new Error('Distributed worker endpoints require HTTPS.');
}

const lines = [
  'datasources:',
  '  postgres:',
  `    url: ${yaml(databaseUrl)}`,
  '    driverClassName: org.postgresql.Driver',
  `    username: ${yaml(required('CC_KESTRA_DATABASE_USERNAME'))}`,
  `    password: ${yaml(databasePassword)}`,
  '',
  'kestra:',
  '  server:',
  '    basic-auth:',
  `      username: ${yaml(authentication.username)}`,
  `      password: ${yaml(authentication.password)}`,
  `    termination-grace-period: ${yaml(environment.CC_KESTRA_TERMINATION_GRACE_PERIOD ?? '5m')}`,
  '  repository:',
  '    type: postgres',
  '  queue:',
  '    type: postgres',
  '  storage:',
  '    type: local',
  '    local:',
  `      base-path: ${yaml(environment.CC_KESTRA_STORAGE_PATH ?? '/app/storage')}`,
  '  tasks:',
  '    tmp-dir:',
  '      path: /tmp/kestra-wd/tmp',
  ...(workerUrl
    ? [
        '    http:',
        '      allowed-list:',
        `        - ${yaml(workerUrl.href.replace(/\/$/, ''))}`,
      ]
    : []),
  '  anonymous-usage-report:',
  '    enabled: false',
  '  ui-anonymous-usage-report:',
  '    enabled: false',
  '  tutorialFlows:',
  '    enabled: false',
  `  url: ${yaml(publicUrl.href)}`,
];
const runtimeEnvironment = {};

if (workerUrl) {
  runtimeEnvironment.ENV_CC_WORKER_BASE_URL = workerUrl.href.replace(/\/$/, '');
  const workerSecret = secretText(
    await readFile(required('CC_KESTRA_WORKER_DISPATCH_SECRET_FILE'), 'utf8'),
    'CC_KESTRA_WORKER_DISPATCH_SECRET_FILE',
  );
  runtimeEnvironment.SECRET_CC_WORKER_DISPATCH_TOKEN =
    Buffer.from(workerSecret).toString('base64');

  const workerCaFile = environment.CC_KESTRA_WORKER_CA_FILE;
  if (profile !== 'all-docker' && !workerCaFile) {
    throw new Error('Distributed worker HTTPS requires a CA file.');
  }
  if (workerCaFile) {
    const trustStorePath = join(runtimeDirectory, 'worker-truststore.p12');
    const temporaryTrustStorePath = temporaryPath(trustStorePath);
    const trustStorePassword = randomBytes(24).toString('base64url');
    try {
      execFileSync(
        'keytool',
        [
          '-importcert',
          '-noprompt',
          '-alias',
          'campus-worker-ca',
          '-file',
          workerCaFile,
          '-keystore',
          temporaryTrustStorePath,
          '-storetype',
          'PKCS12',
          '-storepass:env',
          'CC_KESTRA_TRUSTSTORE_PASSWORD',
        ],
        {
          env: {
            ...environment,
            CC_KESTRA_TRUSTSTORE_PASSWORD: trustStorePassword,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      await chmod(temporaryTrustStorePath, 0o600);
      await rename(temporaryTrustStorePath, trustStorePath);
    } finally {
      await unlink(temporaryTrustStorePath).catch(() => undefined);
    }
    runtimeEnvironment.JAVA_OPTS = [
      `-Djavax.net.ssl.trustStore=${join(runtimeMountPath, 'worker-truststore.p12')}`,
      `-Djavax.net.ssl.trustStorePassword=${trustStorePassword}`,
      '-Djavax.net.ssl.trustStoreType=PKCS12',
    ].join(' ');
  }
}

if (tlsEnabled) {
  const keyStorePath = join(runtimeDirectory, 'server.p12');
  const temporaryKeyStorePath = temporaryPath(keyStorePath);
  const keyStorePassword = randomBytes(24).toString('base64url');
  try {
    execFileSync(
      'openssl',
      [
        'pkcs12',
        '-export',
        '-out',
        temporaryKeyStorePath,
        '-inkey',
        required('CC_KESTRA_TLS_PRIVATE_KEY_FILE'),
        '-in',
        required('CC_KESTRA_TLS_CERTIFICATE_FILE'),
        '-passout',
        'env:CC_KESTRA_KEYSTORE_PASSWORD',
      ],
      {
        env: { ...environment, CC_KESTRA_KEYSTORE_PASSWORD: keyStorePassword },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    await chmod(temporaryKeyStorePath, 0o600);
    await rename(temporaryKeyStorePath, keyStorePath);
  } finally {
    await unlink(temporaryKeyStorePath).catch(() => undefined);
  }
  lines.push(
    '',
    'micronaut:',
    '  ssl:',
    '    enabled: true',
    '  server:',
    '    ssl:',
    '      enabled: true',
    '      port: 8080',
    '      keyStore:',
    `        path: ${yaml(`file:${join(runtimeMountPath, 'server.p12')}`)}`,
    `        password: ${yaml(keyStorePassword)}`,
    '        type: PKCS12',
  );
}

const outputPath = join(runtimeDirectory, 'application.yaml');
await replaceProtected(outputPath, `${lines.join('\n')}\n`);
const runtimeEnvironmentPath = join(
  runtimeDirectory,
  'runtime-environment.json',
);
await replaceProtected(
  runtimeEnvironmentPath,
  `${JSON.stringify(runtimeEnvironment, null, 2)}\n`,
);
if (workerUrl) {
  const flowEnvironmentPath = join(runtimeDirectory, 'flow-secrets.env');
  const flowEnvironment = Object.entries(runtimeEnvironment)
    .map(([name, value]) => `${name}=${shell(value)}`)
    .join('\n');
  await replaceProtected(flowEnvironmentPath, `${flowEnvironment}\n`);
}
process.stdout.write(`${outputPath}\n`);
