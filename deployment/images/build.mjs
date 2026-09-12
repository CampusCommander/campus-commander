import { execFileSync, spawnSync } from 'node:child_process';

const service = process.argv[2];
if (!['api', 'frontend', 'worker'].includes(service))
  throw new Error('Select api, frontend, or worker for the image build.');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const revision = git('rev-parse', 'HEAD');
const dirty = Boolean(git('status', '--porcelain'));
const build = `${revision}${dirty ? '-dirty' : ''}`;
const version = process.env.CC_IMAGE_VERSION ?? 'phase-2-development';
if (!/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,79}$/.test(version))
  throw new Error(
    'Use a bounded image version without spaces or shell characters.',
  );
const result = spawnSync(
  'docker',
  [
    'build',
    '--platform',
    'linux/amd64',
    '--provenance=false',
    '--build-arg',
    `SOURCE_DATE_EPOCH=${git('show', '-s', '--format=%ct', 'HEAD')}`,
    '--build-arg',
    `CC_VERSION=${version}`,
    '--build-arg',
    `CC_BUILD_ID=${build}`,
    '--file',
    `deployment/images/${service}.Dockerfile`,
    '--tag',
    `campus-commander/${service}:cc-6`,
    '.',
  ],
  { stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
