import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARTIFACT_PURGE_MS,
  purgeExpiredArtifacts,
  startArtifactPurge,
} from './artifact-purge.ts';

const database = (rows) => ({
  async query() {
    return { rows };
  },
});

test('the sweep removes each expired artifact that the store accepts', async () => {
  const removals = [];
  const removed = await purgeExpiredArtifacts(
    database([
      { id: '0f0e0d0c-0000-4000-8000-00000000a001', attempt_id: 'a' },
      { id: '0f0e0d0c-0000-4000-8000-00000000a002', attempt_id: 'b' },
      { id: '0f0e0d0c-0000-4000-8000-00000000a003', attempt_id: 'c' },
    ]),
    {
      async remove(manifest) {
        removals.push(manifest);
        return manifest.attemptId !== 'b';
      },
    },
  );
  assert.equal(removed, 2);
  assert.deepEqual(removals, [
    { artifactId: '0f0e0d0c-0000-4000-8000-00000000a001', attemptId: 'a' },
    { artifactId: '0f0e0d0c-0000-4000-8000-00000000a002', attemptId: 'b' },
    { artifactId: '0f0e0d0c-0000-4000-8000-00000000a003', attemptId: 'c' },
  ]);
});

test('a failed removal keeps the artifact and the sweep continues', async () => {
  const removed = await purgeExpiredArtifacts(
    database([
      { id: '0f0e0d0c-0000-4000-8000-00000000a001', attempt_id: 'a' },
      { id: '0f0e0d0c-0000-4000-8000-00000000a002', attempt_id: 'b' },
    ]),
    {
      async remove(manifest) {
        if (manifest.attemptId === 'a')
          throw new Error('Synthetic removal failure.');
        return true;
      },
    },
  );
  assert.equal(removed, 1);
});

test('the sweep selects only artifacts whose retention passed', async () => {
  let sql;
  const removed = await purgeExpiredArtifacts(
    {
      async query(text) {
        sql = text;
        return { rows: [] };
      },
    },
    {
      async remove() {
        throw new Error('No artifact is selected.');
      },
    },
  );
  assert.equal(removed, 0);
  assert.match(sql, /FROM cc\.artifacts/);
  assert.match(sql, /retention_until <= now\(\)/);
});

test('the purge repeats hourly until its timer stops', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let runs = 0;
  const stop = startArtifactPurge(async () => {
    runs += 1;
  });
  t.mock.timers.tick(ARTIFACT_PURGE_MS - 1);
  assert.equal(runs, 0);
  t.mock.timers.tick(1);
  assert.equal(runs, 1);
  t.mock.timers.tick(ARTIFACT_PURGE_MS);
  assert.equal(runs, 2);
  stop();
  t.mock.timers.tick(ARTIFACT_PURGE_MS);
  assert.equal(runs, 2);
});

test('a failed sweep does not stop the hourly timer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let runs = 0;
  const stop = startArtifactPurge(async () => {
    runs += 1;
    throw new Error('Synthetic storage failure.');
  });
  t.mock.timers.tick(ARTIFACT_PURGE_MS);
  t.mock.timers.tick(ARTIFACT_PURGE_MS);
  stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 2);
});