import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createArtifactStore, purgeRows, writeArtifact } from './index.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

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
    await assert.rejects(
      store.stageStream({ schemaVersion: 0, maxBytes: 1 }, []),
    );
    await assert.rejects(
      store.stageStream(
        { schemaVersion: 1, maxBytes: 1, retentionDays: 0 },
        [],
      ),
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

test('the sweep removes each expired artifact that the store accepts', async () => {
  const removals = [];
  const removed = await purgeRows(
    [
      { id: '0f0e0d0c-0000-4000-8000-00000000a001', attempt_id: 'a' },
      { id: '0f0e0d0c-0000-4000-8000-00000000a002', attempt_id: 'b' },
      { id: '0f0e0d0c-0000-4000-8000-00000000a003', attempt_id: 'c' },
    ],
    async (manifest) => {
      removals.push(manifest);
      if (manifest.attemptId === 'a') throw new Error('Synthetic failure.');
      return manifest.attemptId !== 'b';
    },
  );
  assert.equal(removed, 1);
  assert.deepEqual(removals, [
    { artifactId: '0f0e0d0c-0000-4000-8000-00000000a001', attemptId: 'a' },
    { artifactId: '0f0e0d0c-0000-4000-8000-00000000a002', attemptId: 'b' },
    { artifactId: '0f0e0d0c-0000-4000-8000-00000000a003', attemptId: 'c' },
  ]);
});

/** The client of a caller transaction: it records the statements and answers the store query. */
function transactionClient() {
  const queries = [];
  return {
    queries,
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.includes('SELECT * FROM cc.artifacts')) return { rows: [] };
      return { rows: [], rowCount: 1 };
    },
  };
}

test('a caller transaction stages a stream to ready without a pool connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-storage-unit-'));
  const pool = {
    query: async () => ({ rows: [] }),
    connect: async () => {
      throw new Error('The stage took a second connection.');
    },
  };
  const store = await createArtifactStore({ root: directory, pool });
  try {
    const client = transactionClient();
    const bytes = Buffer.from('Synthetic manifest é\n');
    const artifactId = '0f0e0d0c-0000-4000-8000-00000000b001';
    const attemptId = '0f0e0d0c-0000-4000-8000-00000000b002';
    const descriptor = await store.stageStreamWithin(
      client,
      { artifactId, attemptId, schemaVersion: 1, maxBytes: 1024 },
      [bytes],
    );
    assert.deepEqual(descriptor, {
      artifactId,
      attemptId,
      schemaVersion: 1,
      sizeBytes: bytes.length,
      sha256: hash(bytes),
    });
    assert.deepEqual(
      await readFile(join(directory, `${artifactId}.${attemptId}`)),
      bytes,
    );
    const statements = client.queries.map((one) => one.text);
    assert.ok(
      statements.some((text) => text.includes('pg_advisory_xact_lock')),
      'The artifact lock belongs to the caller transaction.',
    );
    assert.ok(
      statements.some((text) => text.includes('INSERT INTO cc.artifacts')),
      'The reservation belongs to the caller transaction.',
    );
    assert.ok(
      statements.some((text) => text.includes("publication_state='ready'")),
      'The ready state belongs to the caller transaction.',
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a rolled-back stage removes its attempt file and a committed one keeps it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-storage-unit-'));
  let committed = [];
  const pool = { query: async () => ({ rows: committed }) };
  const store = await createArtifactStore({ root: directory, pool });
  try {
    const bytes = Buffer.from('Synthetic manifest\n');
    const rolledBack = {
      artifactId: '0f0e0d0c-0000-4000-8000-00000000c001',
      attemptId: '0f0e0d0c-0000-4000-8000-00000000c002',
    };
    await store.stageStreamWithin(
      transactionClient(),
      { ...rolledBack, schemaVersion: 1, maxBytes: 1024 },
      [bytes],
    );
    const path = join(directory, `${rolledBack.artifactId}.${rolledBack.attemptId}`);
    assert.equal(await exists(path), true);
    assert.equal(await store.discardStaged(rolledBack), true);
    assert.equal(await exists(path), false);

    const committedStage = {
      artifactId: '0f0e0d0c-0000-4000-8000-00000000c003',
      attemptId: '0f0e0d0c-0000-4000-8000-00000000c004',
    };
    await store.stageStreamWithin(
      transactionClient(),
      { ...committedStage, schemaVersion: 1, maxBytes: 1024 },
      [bytes],
    );
    const kept = join(
      directory,
      `${committedStage.artifactId}.${committedStage.attemptId}`,
    );
    committed = [{ publication_state: 'ready' }];
    assert.equal(await store.discardStaged(committedStage), false);
    assert.equal(await exists(kept), true);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
