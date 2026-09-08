import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assembleCandidate } from './candidate.mjs';
import { assertReleaseEvidence, verifyReleaseFiles } from './integrity.mjs';

test('candidate inventory excludes untracked secrets and cannot pass release qualification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-candidate-'));
  try {
    await mkdir(join(root, 'deployment'));
    await mkdir(join(root, 'dist/deployment'), { recursive: true });
    await mkdir(join(root, 'artifacts'));
    await mkdir(join(root, 'deployment/release/runtime'), { recursive: true });
    await writeFile(
      join(root, 'deployment/release/runtime/package.json'),
      '{"name":"fixture","version":"1.0.0","dependencies":{}}',
    );
    await writeFile(
      join(root, 'deployment/release/runtime/package-lock.json'),
      '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}',
    );
    await writeFile(
      join(root, 'deployment/runtime.mjs'),
      'export const phase = 1;\n',
    );
    await writeFile(join(root, 'deployment/private-token'), 'do-not-publish');
    await writeFile(
      join(root, 'dist/deployment/cli.js'),
      'export const schema = 1;\n',
    );
    execFileSync('git', ['init', '--quiet', root]);
    execFileSync(
      'git',
      [
        'add',
        'deployment/runtime.mjs',
        'deployment/release/runtime/package.json',
        'deployment/release/runtime/package-lock.json',
      ],
      { cwd: root },
    );
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--quiet',
        '-m',
        'Synthetic release fixture',
      ],
      { cwd: root },
    );
    const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    for (const service of ['frontend', 'api', 'worker']) {
      await writeFile(
        join(root, `artifacts/${service}.reference`),
        `ghcr.io/campuscommander/campus-commander-${service}@sha256:${'a'.repeat(64)}\n`,
      );
      for (const suffix of ['spdx.json', 'verification.json'])
        await writeFile(join(root, `artifacts/${service}.${suffix}`), '{}');
    }
    const output = join(root, 'bundle');
    const manifest = await assembleCandidate({
      root,
      output,
      artifacts: join(root, 'artifacts'),
      sourceRevision,
    });
    assert.equal(
      manifest.files.some((file) => file.path.includes('private-token')),
      false,
    );
    await verifyReleaseFiles(output, manifest);
    assert.throws(
      () => assertReleaseEvidence(manifest),
      /matching profile evidence/,
    );
    await writeFile(join(output, 'deployment/runtime.mjs'), 'altered');
    await assert.rejects(
      verifyReleaseFiles(output, manifest),
      /integrity failed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
