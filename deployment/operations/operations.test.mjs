import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { backupFoundation, postgresToolArguments } from './index.mjs';

test('restore tools target the named database without destructive cleanup flags', () => {
  const args = postgresToolArguments('pg_restore', {
    database: 'isolated-restore',
  });
  assert.deepEqual(args.slice(-2), ['--dbname', 'isolated-restore']);
  assert.ok(args.includes('--single-transaction'));
  assert.ok(args.includes('--exit-on-error'));
  assert.ok(!args.includes('--clean'));
  assert.ok(!args.includes('--create'));
  assert.throws(() => postgresToolArguments('dropdb', {}));
});

test('backup rejects missing quiescence evidence before database access', async () => {
  const config = JSON.parse(
    await readFile(
      new URL('../examples/all-docker.json', import.meta.url),
      'utf8',
    ),
  );
  const release = {
    schemaVersion: 1,
    sourceRevision: 'a'.repeat(40),
    architectures: ['linux/amd64'],
    images: config.images,
  };
  await assert.rejects(
    backupFoundation({ config, release, quiesce: { confirmed: true } }),
    /operator record/,
  );
});
