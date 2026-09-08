import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDeploymentConfig } from '../../dist/deployment/lib/deployment.js';

const components = new Set([
  'application-database',
  'kestra-database',
  'redis',
  'frontend',
  'api',
  'workers',
  'artifacts',
  'kestra',
]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Construct support output from explicit fields instead of redacting arbitrary logs. */
export async function createSupportBundle({
  directory,
  config: input,
  readiness,
  runtimeVersions = {},
}) {
  const config = parseDeploymentConfig(input);
  if (!isAbsolute(directory))
    throw new Error('Support output requires a new absolute directory.');
  await mkdir(directory, { mode: 0o700 });
  const snapshot = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    profile: config.profile,
    architecture: `${config.host.os}/${config.host.architecture}`,
    images: config.images,
    artifactBackend: config.artifacts.kind,
    services: Object.fromEntries(
      Object.entries(config.services).map(([name, service]) => [
        name,
        {
          placement: service.placement.kind,
          tls: service.endpoint.tls.mode,
          ...(service.placement.kind === 'local'
            ? {
                replicas: service.placement.replicas,
                resources: service.placement.resources,
              }
            : {}),
        },
      ]),
    ),
    readiness: {
      status: ['ready', 'not-ready'].includes(readiness?.status)
        ? readiness.status
        : 'unavailable',
      checks: Array.isArray(readiness?.checks)
        ? readiness.checks
            .filter((check) => components.has(check.name))
            .map((check) => ({
              name: check.name,
              status: check.status === 'ready' ? 'ready' : 'not-ready',
            }))
        : [],
    },
    runtimeVersions: Object.fromEntries(
      ['node', 'docker', 'compose', 'kubectl', 'postgres', 'redis', 'kestra']
        .filter(
          (name) =>
            typeof runtimeVersions[name] === 'string' &&
            /^v?\d+\.\d+(?:\.\d+)?(?:[-+][a-zA-Z0-9.-]+)?$/.test(
              runtimeVersions[name],
            ),
        )
        .map((name) => [name, runtimeVersions[name]]),
    ),
    omissions: [
      'secret values and references',
      'endpoint hostnames',
      'filesystem paths',
      'container environments',
      'raw logs',
      'authentication headers',
    ],
  };
  if (
    new Set(snapshot.readiness.checks.map((check) => check.name)).size !==
      components.size ||
    snapshot.readiness.checks.some((check) => check.status !== 'ready')
  ) {
    snapshot.readiness.status =
      snapshot.readiness.status === 'unavailable' ? 'unavailable' : 'not-ready';
  }
  const bytes = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(join(directory, 'support.json'), bytes, {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(
    join(directory, 'SHA256SUMS'),
    `${hash(bytes)}  support.json\n`,
    { mode: 0o600, flag: 'wx' },
  );
  return snapshot;
}
