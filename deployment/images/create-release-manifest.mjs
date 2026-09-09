import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [outputPath, frontendReference, apiReference, workerReference] =
  process.argv.slice(2);
const references = {
  frontend: frontendReference,
  api: apiReference,
  workers: workerReference,
};

if (!outputPath || Object.values(references).some((value) => !value)) {
  console.error(
    'Usage: node deployment/images/create-release-manifest.mjs <output> <frontend> <api> <worker>',
  );
  process.exit(2);
}

const images = Object.fromEntries(
  Object.entries(references).map(([service, reference]) => {
    const result = spawnSync(
      'docker',
      ['image', 'inspect', reference, '--format', '{{json .}}'],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(`Missing ${service} image.`);
    const image = JSON.parse(result.stdout);
    if (image.Os !== 'linux' || image.Architecture !== 'amd64') {
      throw new Error(`${service} does not match linux/amd64.`);
    }
    if (image.Config.User !== 'node') {
      throw new Error(`${service} does not use the node runtime account.`);
    }
    const lastSlash = reference.lastIndexOf('/');
    const lastColon = reference.lastIndexOf(':');
    const repository =
      lastColon > lastSlash ? reference.slice(0, lastColon) : reference;
    const digest = image.RepoDigests?.find((value) =>
      value.startsWith(`${repository}@sha256:`),
    );
    if (!digest) throw new Error(`${service} has no pulled repository digest.`);
    return [service, digest];
  }),
);

writeFileSync(
  outputPath,
  `${JSON.stringify(
    { schemaVersion: 1, platform: 'linux/amd64', images },
    null,
    2,
  )}\n`,
  { flag: 'wx' },
);
console.log(`Release manifest created at ${outputPath}`);
