import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertReleaseEvidence,
  sha256,
  signRelease,
  verifyRelease,
} from './integrity.mjs';

test('release verification rejects tampering, missing qualification, and substituted files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc19-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const trustedPublicKey = publicKey.export({ type: 'spki', format: 'pem' });
  const report = Buffer.from(
    'Synthetic integrity-test evidence. This is not deployment acceptance.\n',
  );
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
    files: [
      { path: 'report.txt', sizeBytes: report.length, sha256: sha256(report) },
    ],
    evidence: {},
  };
  for (const profile of ['all-docker', 'hybrid', 'kubernetes']) {
    manifest.evidence[profile] = {
      workerHosts: ['synthetic-host-a', 'synthetic-host-b'],
    };
    for (const check of ['install', 'resume', 'upgrade', 'restore', 'faults']) {
      manifest.evidence[profile][check] = {
        status: 'passed',
        sourceRevision: manifest.sourceRevision,
        images,
        reportSha256: sha256(report),
      };
    }
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const signature = signRelease(manifestBytes, privateKey);
  const options = { root, manifestBytes, signature, trustedPublicKey };
  try {
    await writeFile(join(root, 'report.txt'), report);
    assert.equal(
      (await verifyRelease(options)).sourceRevision,
      manifest.sourceRevision,
    );
    await assert.rejects(
      verifyRelease({
        ...options,
        manifestBytes: Buffer.concat([manifestBytes, Buffer.from(' ')]),
      }),
      /signature/,
    );
    await writeFile(join(root, 'report.txt'), 'altered');
    await assert.rejects(verifyRelease(options), /integrity/);
    await rm(join(root, 'report.txt'));
    await writeFile(join(root, 'other.txt'), report);
    await symlink(join(root, 'other.txt'), join(root, 'report.txt'));
    await assert.rejects(verifyRelease(options), /symlinks/);
    manifest.evidence.kubernetes.restore.status = 'not-run';
    assert.throws(() => assertReleaseEvidence(manifest), /profile evidence/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
