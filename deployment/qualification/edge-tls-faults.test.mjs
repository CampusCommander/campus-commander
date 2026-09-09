import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceEdgeTlsSecrets, runEdgeTlsFaults } from './edge-tls-faults.mjs';

test('edge TLS faults reject ordinary projects before accessing secrets or Docker', async () => {
  let commands = 0;
  await assert.rejects(
    runEdgeTlsFaults(
      {
        qualificationOnly: true,
        project: 'campus-commander',
        root: '/tmp/cc-installer-fixture',
      },
      { compose: () => commands++ },
    ),
    /disposable installer/,
  );
  assert.equal(commands, 0);
});

test('edge TLS replacement stages changed secrets before restarting edge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-edge-tls-secrets-'));
  const certPath = join(root, 'edge-certificate');
  const keyPath = join(root, 'edge-private-key');
  const commands = [];
  await writeFile(certPath, 'original certificate');
  await writeFile(keyPath, 'original key');
  const compose = (...args) => {
    commands.push(args);
    if (args[0] === 'run') {
      assert.equal(readFileSync(certPath, 'utf8'), 'replacement certificate');
      assert.equal(readFileSync(keyPath, 'utf8'), 'replacement key');
    }
  };

  try {
    await replaceEdgeTlsSecrets({
      compose,
      certPath,
      keyPath,
      cert: 'replacement certificate',
      key: 'replacement key',
    });
    assert.deepEqual(commands, [
      ['stop', '--timeout', '5', 'edge'],
      ['run', '--rm', '--no-deps', 'volume-permissions'],
      ['start', 'edge'],
    ]);
    assert.equal(await readFile(certPath, 'utf8'), 'replacement certificate');
    assert.equal(await readFile(keyPath, 'utf8'), 'replacement key');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
