import { spawnSync } from 'node:child_process';

const [service, imageReference] = process.argv.slice(2);
const services = new Set(['api', 'frontend', 'worker']);

if (!services.has(service) || !imageReference?.startsWith('ghcr.io/')) {
  console.error(
    'Usage: node deployment/images/publish-candidate.mjs <api|frontend|worker> <ghcr.io image reference>',
  );
  process.exit(2);
}

const build = spawnSync(
  'docker',
  [
    'buildx',
    'build',
    '--platform',
    'linux/amd64',
    '--provenance=false',
    '--build-arg',
    'SOURCE_DATE_EPOCH=0',
    '--file',
    `deployment/images/${service}.Dockerfile`,
    '--tag',
    imageReference,
    '--push',
    '.',
  ],
  { stdio: 'inherit' },
);

if (build.status !== 0) process.exit(build.status ?? 1);

const inspect = spawnSync(
  'docker',
  ['buildx', 'imagetools', 'inspect', imageReference],
  { stdio: 'inherit' },
);
process.exit(inspect.status ?? 1);
