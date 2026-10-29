import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { purgeExpiredArtifacts } from '../../api/src/app/storage/artifact-purge.ts';
import { createArtifactStore, writeArtifact } from './index.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = (path) => stat(path).then(() => true, () => false);

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

test('a streamed write records the size and the digest of the bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-storage-unit-'));
  try {
    const path = join(directory, 'attempt');
    const bytes = Buffer.from('Synthetic École stream\n');
    const written = await writeArtifact(
      path,
      (async function* () {
        yield bytes.subarray(0, 5);
        yield bytes.subarray(5);
      })(),
      1024,
    );
    assert.deepEqual(written, { sizeBytes: bytes.length, sha256: hash(bytes) });
    assert.deepEqual(await readFile(path), bytes);
    assert.equal((await stat(path)).mode & 0o777, 0o400);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a streamed write stops at its cap and removes the partial file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-storage-unit-'));
  try {
    const path = join(directory, 'attempt');
    const bytes = Buffer.from('Synthetic artifact');
    const written = await writeArtifact(path, [bytes], bytes.length);
    assert.equal(written.sizeBytes, bytes.length);
    await rm(path);
    await assert.rejects(
      writeArtifact(path, [bytes], bytes.length - 1),
      /Artifact exceeds its size limit/,
    );
    assert.equal(await exists(path), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed stream removes the partial file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-storage-unit-'));
  try {
    const path = join(directory, 'attempt');
    await assert.rejects(
      writeArtifact(
        path,
        (async function* () {
          yield Buffer.from('partial');
          throw new Error('Synthetic read failure.');
        })(),
        1024,
      ),
      /Synthetic read failure/,
    );
    assert.equal(await exists(path), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('streamed staging rejects invalid metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-storage-unit-'));
  const store = await createArtifactStore({ root: directory, pool: {} });
  try {
    await assert.rejects(store.stageStream({ schemaVersion: 1, maxBytes: -1 }));
    await assert.rejects(
      store.stageStream({ schemaVersion: 1, maxBytes: 1.5 }, []),
    );
    await assert.rejects(store.stageStream({ schemaVersion: 0, maxBytes: 1 }, []));
    await assert.rejects(
      store.stageStream({ schemaVersion: 1, maxBytes: 1, retentionDays: 0 }, []),
    );
    await assert.rejects(
      store.stageStream(
        {
          schemaVersion: 1,
          maxBytes: 1,
          retentionDays: 30,
          retentionUntil: new Date().toISOString(),
        },
        [],
      ),
    );
    await assert.rejects(
      store.stage(
        {
          schemaVersion: 1,
          expectedSizeBytes: 1,
          expectedSha256: 'a'.repeat(64),
          retentionUntil: 'not a date',
        },
        [],
      ),
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});