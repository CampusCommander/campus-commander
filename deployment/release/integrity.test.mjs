import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertReleaseEvidence,
  sha256,
  signRelease,
  verifyRelease,
} from './integrity.mjs';

const profiles = ['all-docker', 'hybrid', 'kubernetes'];
const checks = ['install', 'resume', 'upgrade', 'restore', 'faults'];

async function qualifiedFixture(root) {
  const images = Object.fromEntries(
    ['frontend', 'api', 'workers'].map((name, index) => [
      name,
      `registry.example.org/${name}@sha256:${String(index + 1).repeat(64)}`,
    ]),
  );
  const manifest = {
    schemaVersion: 1,
    sourceRevision: 'a'.repeat(40),
    architectures: ['linux/amd64'],
    images,
    files: [],
    evidence: {},
  };
  await mkdir(join(root, 'evidence'));
  for (const profile of profiles) {
    manifest.evidence[profile] = {
      workerHosts: ['synthetic-host-a', 'synthetic-host-b'],
    };
    for (const check of checks) {
      const reportPath = `evidence/${profile}-${check}.json`;
      const report = Buffer.from(
        JSON.stringify({
          status: 'passed',
          profile,
          check,
          sourceRevision: manifest.sourceRevision,
          images,
        }),
      );
      await writeFile(join(root, reportPath), report);
      manifest.files.push({
        path: reportPath,
        sizeBytes: report.length,
        sha256: sha256(report),
      });
      manifest.evidence[profile][check] = {
        status: 'passed',
        sourceRevision: manifest.sourceRevision,
        images,
        reportPath,
        reportSha256: sha256(report),
      };
    }
  }
  const unrelatedPath = 'unrelated.json';
  const unrelated = Buffer.from('{"kind":"unrelated"}');
  await writeFile(join(root, unrelatedPath), unrelated);
  manifest.files.push({
    path: unrelatedPath,
    sizeBytes: unrelated.length,
    sha256: sha256(unrelated),
  });
  return { manifest, unrelatedPath };
}

function signedOptions(root, manifest, privateKey, trustedPublicKey) {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return {
    root,
    manifestBytes,
    signature: signRelease(manifestBytes, privateKey),
    trustedPublicKey,
  };
}

test('release verification rejects tampering, missing qualification, and substituted files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc19-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const trustedPublicKey = publicKey.export({ type: 'spki', format: 'pem' });
  try {
    const { manifest } = await qualifiedFixture(root);
    const options = signedOptions(root, manifest, privateKey, trustedPublicKey);
    assert.equal(
      (await verifyRelease(options)).sourceRevision,
      manifest.sourceRevision,
    );
    await assert.rejects(
      verifyRelease({
        ...options,
        manifestBytes: Buffer.concat([options.manifestBytes, Buffer.from(' ')]),
      }),
      /signature/,
    );
    const reportPath = manifest.evidence['all-docker'].install.reportPath;
    await writeFile(join(root, reportPath), 'altered');
    await assert.rejects(verifyRelease(options), /integrity/);
    await rm(join(root, reportPath));
    await writeFile(join(root, 'substitute.json'), '{}');
    await symlink(join(root, 'substitute.json'), join(root, reportPath));
    await assert.rejects(verifyRelease(options), /symlinks/);
    manifest.evidence.kubernetes.restore.status = 'not-run';
    assert.throws(() => assertReleaseEvidence(manifest), /profile evidence/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release evidence binds each report hash to its exact inventory path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc19-path-'));
  try {
    const { manifest, unrelatedPath } = await qualifiedFixture(root);
    const evidence = manifest.evidence.hybrid.install;
    evidence.reportSha256 = manifest.files.find(
      (file) => file.path === unrelatedPath,
    ).sha256;
    assert.throws(() => assertReleaseEvidence(manifest), /profile evidence/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release verification rejects report claims that differ from the manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc19-claims-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const trustedPublicKey = publicKey.export({ type: 'spki', format: 'pem' });
  try {
    const { manifest } = await qualifiedFixture(root);
    const evidence = manifest.evidence.kubernetes.install;
    const path = join(root, evidence.reportPath);
    const report = JSON.parse(await readFile(path, 'utf8'));
    const inventory = manifest.files.find(
      (file) => file.path === evidence.reportPath,
    );
    for (const change of [
      (value) => (value.status = 'failed'),
      (value) => (value.profile = 'hybrid'),
      (value) => (value.check = 'restore'),
      (value) => (value.sourceRevision = 'b'.repeat(40)),
      (value) => (value.images.api = value.images.frontend),
    ]) {
      const changed = structuredClone(report);
      change(changed);
      const bytes = Buffer.from(JSON.stringify(changed));
      await writeFile(path, bytes);
      inventory.sizeBytes = bytes.length;
      inventory.sha256 = sha256(bytes);
      evidence.reportSha256 = sha256(bytes);
      await assert.rejects(
        verifyRelease(
          signedOptions(root, manifest, privateKey, trustedPublicKey),
        ),
        /claims do not match/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
