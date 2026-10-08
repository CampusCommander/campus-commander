import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { operationFailureReason } from './failure.mjs';

test('failure codes do not expose nested credential or database details', () => {
  const marker =
    'postgresql://private-user:PRIVATE-PASSWORD@private-host/private-database';
  assert.equal(
    operationFailureReason(new Error(marker)),
    'UNCLASSIFIED_FAILURE',
  );
  assert.equal(
    operationFailureReason(
      new Error(marker, {
        cause: Object.assign(new Error(marker), { code: '28P01' }),
      }),
    ),
    'DATABASE_AUTHENTICATION_FAILED',
  );
  assert.equal(
    operationFailureReason(Object.assign(new Error(marker), { code: marker })),
    'UNCLASSIFIED_FAILURE',
  );
});

test('the operator CLI identifies rejected quiescence without exposing private input', async () => {
  const root = await mkdtemp('/tmp/cc-operations-failure-');
  const marker = 'PRIVATE-OPERATOR-INPUT-MARKER';
  try {
    const config = JSON.parse(
      await readFile(new URL('../examples/all-docker.json', import.meta.url)),
    );
    const configPath = join(root, 'config.json'),
      releasePath = join(root, 'release.json'),
      inputPath = join(root, 'operator.json');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await writeFile(
      releasePath,
      JSON.stringify({
        schemaVersion: 1,
        sourceRevision: 'a'.repeat(40),
        architectures: ['linux/amd64'],
        images: config.images,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      inputPath,
      JSON.stringify({
        configurationPath: configPath,
        releaseInventoryPath: releasePath,
        quiesce: { operator: marker },
        keyRecovery: { privateMarker: marker },
      }),
      { mode: 0o600 },
    );
    let failure;
    try {
      await promisify(execFile)(process.execPath, [
        'deployment/operations/cli.mjs',
        'backup',
        inputPath,
      ]);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, 1);
    assert.match(failure.stderr, /Reason: QUIESCENCE_REQUIRED\./);
    assert.ok(!failure.stderr.includes(marker));
    assert.ok(!failure.stderr.includes(root));
    assert.equal(failure.stdout, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
