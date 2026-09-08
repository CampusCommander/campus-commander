import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdir,
  readFile,
  writeFile,
  lstat,
  copyFile,
  readdir,
} from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from './integrity.mjs';

const run = promisify(execFile);
const services = { frontend: 'frontend', api: 'api', worker: 'workers' };

/** Package committed installation sources and the build output without local secret files. */
export async function assembleCandidate({
  root,
  output,
  artifacts,
  sourceRevision,
}) {
  if (!/^[a-f0-9]{40}$/.test(sourceRevision))
    throw new Error('Candidate requires a source revision.');
  const head = (
    await run('git', ['rev-parse', 'HEAD'], { cwd: root })
  ).stdout.trim();
  const changes = (
    await run('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: root,
    })
  ).stdout.trim();
  if (head !== sourceRevision || changes)
    throw new Error('Candidate source must match a clean committed revision.');
  if (output === root || relative(root, output).startsWith('deployment/'))
    throw new Error('Candidate output must remain outside deployment sources.');
  await mkdir(output, { recursive: false, mode: 0o700 });
  const paths = (
    await run('git', ['ls-files', '-z', 'deployment'], { cwd: root })
  ).stdout
    .split('\0')
    .filter(Boolean);
  const files = [];
  const add = async (source, path) => {
    const stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Candidate contains an unsupported file.');
    const bytes = await readFile(source);
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(
        bytes.toString('utf8'),
      )
    )
      throw new Error('Candidate contains private key material.');
    const destination = resolve(output, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    files.push({ path, sizeBytes: bytes.length, sha256: sha256(bytes) });
  };
  for (const path of paths) await add(resolve(root, path), path);
  for (const name of ['package.json', 'package-lock.json']) {
    if (!paths.includes(`deployment/release/runtime/${name}`))
      throw new Error('Installer runtime dependencies must be committed.');
    await add(resolve(root, 'deployment/release/runtime', name), name);
  }
  await run(
    'npm',
    ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    {
      cwd: output,
      timeout: 120000,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name.toLowerCase() !== 'npm_config_allow_scripts',
        ),
      ),
    },
  );
  const compiled = async (directory, base = root) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = resolve(directory, entry.name);
      if (entry.isDirectory()) await compiled(source, base);
      else if (base === output) {
        const bytes = await readFile(source);
        if (entry.isSymbolicLink())
          throw new Error('Runtime dependencies must contain ordinary files.');
        files.push({
          path: relative(output, source),
          sizeBytes: bytes.length,
          sha256: sha256(bytes),
        });
      } else await add(source, relative(base, source));
    }
  };
  await compiled(resolve(root, 'dist/deployment'));
  await mkdir(resolve(output, 'node_modules'), { recursive: true });
  await compiled(resolve(output, 'node_modules'), output);
  const images = {};
  for (const [service, key] of Object.entries(services)) {
    const reference = (
      await readFile(resolve(artifacts, `${service}.reference`), 'utf8')
    ).trim();
    if (
      !new RegExp(
        `^ghcr\\.io/campuscommander/campus-commander-${service}@sha256:[a-f0-9]{64}$`,
      ).test(reference)
    )
      throw new Error('Candidate image repository or digest is invalid.');
    images[key] = reference;
    for (const suffix of ['reference', 'spdx.json', 'verification.json'])
      await add(
        resolve(artifacts, `${service}.${suffix}`),
        `provenance/${service}.${suffix}`,
      );
  }
  const manifest = {
    schemaVersion: 1,
    sourceRevision,
    architectures: ['linux/amd64'],
    platform: 'linux/amd64',
    images,
    qualification: 'candidate-only',
    evidence: Object.fromEntries(
      ['all-docker', 'hybrid', 'kubernetes'].map((profile) => [
        profile,
        Object.fromEntries(
          ['install', 'resume', 'upgrade', 'restore', 'faults'].map((check) => [
            check,
            { status: 'not-run' },
          ]),
        ),
      ]),
    ),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
  await writeFile(
    resolve(output, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: 'wx' },
  );
  await writeFile(
    resolve(output, 'SHA256SUMS'),
    manifest.files.map((file) => `${file.sha256}  ${file.path}`).join('\n') +
      '\n',
    { flag: 'wx' },
  );
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [output, artifacts, sourceRevision] = process.argv.slice(2);
  if (!output || !artifacts || !sourceRevision)
    throw new Error(
      'Usage: candidate.mjs <new-output-directory> <image-artifacts> <source-revision>',
    );
  assembleCandidate({
    root: process.cwd(),
    output: resolve(output),
    artifacts: resolve(artifacts),
    sourceRevision,
  }).catch(() => {
    process.stderr.write(
      'Candidate assembly failed. Check committed sources, build output, and signed image evidence.\n',
    );
    process.exitCode = 1;
  });
}
