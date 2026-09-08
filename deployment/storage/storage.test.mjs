import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createArtifactStore } from './index.mjs';

test('storage rejects symbolic-link roots and unsupported backends without database access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-storage-unit-'));
  try {
    await symlink(directory, join(directory, 'link'));
    await assert.rejects(
      createArtifactStore({ root: join(directory, 'link'), pool: {} }),
    );
    await assert.rejects(
      createArtifactStore({ root: directory, pool: {}, backend: 's3' }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid artifact identities and integrity metadata fail before database access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-storage-unit-'));
  const store = await createArtifactStore({ root: directory, pool: {} });
  try {
    await assert.rejects(store.stage({ artifactId: '../escape' }, []));
    await assert.rejects(
      store.stage(
        { schemaVersion: 1, expectedSizeBytes: -1, expectedSha256: 'invalid' },
        [],
      ),
    );
    await assert.rejects(
      store.openRead('../escape'),
      (error) => !error.message.includes(directory),
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
