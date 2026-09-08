import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
const digestReference = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const profiles = ['all-docker', 'hybrid', 'kubernetes'];

export function assertReleaseEvidence(manifest) {
  if (
    manifest.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceRevision)
  )
    throw new Error('Release identity is invalid.');
  if (JSON.stringify(manifest.architectures) !== '["linux/amd64"]')
    throw new Error('Release architecture is unqualified.');
  for (const name of ['frontend', 'api', 'workers']) {
    if (!digestReference.test(manifest.images?.[name]))
      throw new Error('Application image digest is missing.');
  }
  for (const profile of profiles) {
    for (const check of ['install', 'resume', 'upgrade', 'restore', 'faults']) {
      const evidence = manifest.evidence?.[profile]?.[check];
      if (
        evidence?.status !== 'passed' ||
        evidence.sourceRevision !== manifest.sourceRevision ||
        !/^[a-f0-9]{64}$/.test(evidence.reportSha256) ||
        !manifest.files?.some((file) => file.sha256 === evidence.reportSha256)
      ) {
        throw new Error('Release requires matching profile evidence.');
      }
      for (const name of ['frontend', 'api', 'workers']) {
        if (evidence.images?.[name] !== manifest.images[name])
          throw new Error(
            'Profile evidence uses different application images.',
          );
      }
    }
    if (profile !== 'all-docker') {
      const hosts = manifest.evidence[profile].workerHosts;
      if (
        !Array.isArray(hosts) ||
        hosts.length < 2 ||
        new Set(hosts).size !== hosts.length ||
        hosts.some((host) => typeof host !== 'string' || !host)
      ) {
        throw new Error(
          'Distributed profiles require distinct worker-host evidence.',
        );
      }
    }
  }
}

async function releaseFile(root, path) {
  if (
    typeof path !== 'string' ||
    !/^[A-Za-z0-9_./-]+$/.test(path) ||
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Release file path is invalid.');
  }
  const base = resolve(root);
  let current = base;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    if (
      !current.startsWith(`${base}${sep}`) ||
      (await lstat(current)).isSymbolicLink()
    )
      throw new Error('Release files cannot use symlinks.');
  }
  const info = await lstat(current);
  if (!info.isFile() || info.size > 64 * 1024 * 1024)
    throw new Error('Release file is invalid or oversized.');
  return readFile(current);
}

export async function verifyReleaseFiles(root, manifest) {
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > 10000
  )
    throw new Error('Release file inventory is missing.');
  const seen = new Set();
  for (const file of manifest.files) {
    if (seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256))
      throw new Error('Release inventory contains invalid or duplicate files.');
    seen.add(file.path);
    const bytes = await releaseFile(root, file.path);
    if (bytes.length !== file.sizeBytes || sha256(bytes) !== file.sha256)
      throw new Error('Release file integrity failed.');
  }
}

export function signRelease(manifestBytes, privateKey) {
  if (createPublicKey(privateKey).asymmetricKeyType !== 'ed25519')
    throw new Error('Release signing requires Ed25519.');
  return sign(null, manifestBytes, privateKey);
}

export async function verifyRelease({
  root,
  manifestBytes,
  signature,
  trustedPublicKey,
}) {
  const key = createPublicKey(trustedPublicKey);
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(null, manifestBytes, key, signature)
  )
    throw new Error('Release signature verification failed.');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assertReleaseEvidence(manifest);
  await verifyReleaseFiles(root, manifest);
  return manifest;
}
