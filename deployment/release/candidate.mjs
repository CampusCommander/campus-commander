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
import {
  applicationReports,
  assertApplicationEvidence,
} from './application-evidence.mjs';

const run = promisify(execFile);
const services = { frontend: 'frontend', api: 'api', worker: 'workers' };
export { applicationReports } from './application-evidence.mjs';

/** Package committed installation sources and the build output without local secret files. */
export async function assembleCandidate({
  root,
  output,
  artifacts,
  sourceRevision,
  phase = 1,
  qualificationArtifacts,
}) {
  if (![1, 2].includes(phase)) throw new Error('Select release phase 1 or 2.');
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
    await run(
      'git',
      ['ls-files', '-z', 'deployment', 'LICENSE.md', 'install.sh'],
      { cwd: root },
    )
  ).stdout
    .split('\0')
    .filter(Boolean);
  for (const required of ['LICENSE.md', 'install.sh']) {
    if (!paths.includes(required))
      throw new Error(
        'Candidate requires the committed license and hosted installer.',
      );
  }
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
    for (const suffix of [
      'reference',
      'spdx.json',
      'verification.json',
      ...(phase === 2 ? ['vulnerabilities.json'] : []),
    ])
      await add(
        resolve(artifacts, `${service}.${suffix}`),
        `provenance/${service}.${suffix}`,
      );
  }
  const applicationEvidence = {};
  if (phase === 2) {
    if (!qualificationArtifacts)
      throw new Error('Phase 2 requires application qualification artifacts.');
    for (const [target, filename] of Object.entries(applicationReports)) {
      const source = resolve(
        qualificationArtifacts,
        `qualification-${target}`,
        filename,
      );
      const report = JSON.parse(await readFile(source, 'utf8'));
      assertApplicationEvidence(target, report, { sourceRevision, images });
      const reportPath = `qualification/${target}/${filename}`;
      await add(source, reportPath);
      applicationEvidence[target] = {
        reportPath,
        reportSha256: files.find((file) => file.path === reportPath).sha256,
      };
    }
    for (const filename of [
      'login-accessibility.json',
      'account-accessibility.json',
      'diagnostics-light-accessibility.json',
      'diagnostics-dark-accessibility.json',
      'diagnostics-light.png',
      'diagnostics-dark.png',
    ])
      await add(
        resolve(
          qualificationArtifacts,
          'qualification-auth-image-integration',
          filename,
        ),
        `qualification/accessibility/${filename}`,
      );
  }
  const manifest = {
    schemaVersion: 1,
    phase,
    sourceRevision,
    architectures: ['linux/amd64'],
    platform: 'linux/amd64',
    images,
    qualification: 'candidate-only',
    ...(phase === 2 ? { applicationEvidence } : {}),
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
  const [
    output,
    artifacts,
    sourceRevision,
    phase = '1',
    qualificationArtifacts,
  ] = process.argv.slice(2);
  if (!output || !artifacts || !sourceRevision)
    throw new Error(
      'Usage: candidate.mjs <new-output-directory> <image-artifacts> <source-revision> [phase] [qualification-artifacts]',
    );
  assembleCandidate({
    root: process.cwd(),
    output: resolve(output),
    artifacts: resolve(artifacts),
    sourceRevision,
    phase: Number(phase),
    qualificationArtifacts: qualificationArtifacts
      ? resolve(qualificationArtifacts)
      : undefined,
  }).catch(() => {
    process.stderr.write(
      'Candidate assembly failed. Check committed sources, build output, and signed image evidence.\n',
    );
    process.exitCode = 1;
  });
}
