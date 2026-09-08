import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSupportBundle } from './support.mjs';

test('support output drops secret-bearing diagnostics and preserves fixed readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-support-'));
  const marker = 'SENSITIVE-SYNTHETIC-MARKER';
  try {
    const config = JSON.parse(
      await readFile(
        new URL('../examples/all-docker.json', import.meta.url),
        'utf8',
      ),
    );
    const directory = join(root, 'bundle');
    const snapshot = await createSupportBundle({
      directory,
      config,
      readiness: {
        status: 'ready',
        authorization: marker,
        checks: [
          { name: 'api', status: 'ready', error: marker },
          { name: marker, status: 'ready' },
        ],
      },
      runtimeVersions: { node: '24.19.0', docker: marker },
    });
    const bytes = await readFile(join(directory, 'support.json'), 'utf8');
    assert.equal(bytes.includes(marker), false);
    assert.equal(bytes.includes('campus.example.org'), false);
    assert.equal(bytes.includes('/run/secrets'), false);
    assert.equal(snapshot.architecture, 'linux/amd64');
    assert.equal(snapshot.readiness.status, 'not-ready');
    assert.deepEqual(snapshot.readiness.checks, [
      { name: 'api', status: 'ready' },
    ]);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(directory, 'support.json'))).mode & 0o777,
      0o600,
    );
    await assert.rejects(createSupportBundle({ directory, config }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
