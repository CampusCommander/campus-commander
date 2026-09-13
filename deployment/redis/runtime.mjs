import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';

export const redisImage =
  'redis:8.0.5-alpine@sha256:6c8e66693fa71bad36ae06c75c990446ad01dbd4b081dd847eb9869f20d7c6ee';

export const applicationRedisAcl =
  '~cc:* &cc:* -@all +ping +get +getdel +set +del +exists +expire +ttl +eval';

export function secretPath(reference) {
  return reference.provider === 'file'
    ? reference.path
    : `/run/secrets/${reference.name}/${reference.key}`;
}

export function renderRedis(config, password) {
  const service = parseDeploymentConfig(config).services.redis;
  if (service.placement.kind !== 'local') {
    throw new Error('The district operator owns external Redis configuration.');
  }
  if (password.length < 32 || password.length > 4096) {
    throw new Error('Redis credentials require 32 through 4096 bytes.');
  }
  const port = Number(new URL(service.endpoint.url).port || 6379);
  const encrypted = service.endpoint.tls.mode !== 'disabled';
  const memory = Math.floor(service.placement.resources.memoryLimitMiB / 2);
  const passwordHash = createHash('sha256').update(password).digest('hex');
  const lines = [
    'bind 0.0.0.0',
    'protected-mode yes',
    'daemonize no',
    'logfile ""',
    'dir /data',
    'save ""',
    'appendonly no',
    `maxmemory ${memory}mb`,
    'maxmemory-policy noeviction',
    'enable-debug-command no',
    'enable-module-command no',
    `user default on #${passwordHash} ${applicationRedisAcl}`,
    `port ${encrypted ? 0 : port}`,
  ];
  if (encrypted) {
    lines.push(
      `tls-port ${port}`,
      `tls-cert-file ${secretPath(service.serverTls.certificateSecretRef)}`,
      `tls-key-file ${secretPath(service.serverTls.privateKeySecretRef)}`,
      'tls-auth-clients no',
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const [configPath, outputPath] = process.argv.slice(2);
  if (!configPath || !outputPath)
    throw new Error('Provide a configuration file and private output file.');
  const config = parseDeploymentConfig(
    JSON.parse(await readFile(configPath, 'utf8')),
  );
  const password = await readFile(
    secretPath(config.services.redis.passwordSecretRef),
  );
  await writeFile(outputPath, renderRedis(config, password), {
    mode: 0o600,
    flag: 'wx',
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch(() => {
    process.stderr.write(
      'Redis configuration failed. Check the profile, credential file, and new private output path.\n',
    );
    process.exitCode = 1;
  });
}
