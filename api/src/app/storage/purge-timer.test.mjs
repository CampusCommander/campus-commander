import assert from 'node:assert/strict';
import test from 'node:test';
import { ARTIFACT_PURGE_MS, startArtifactPurge } from './purge-timer.ts';

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
