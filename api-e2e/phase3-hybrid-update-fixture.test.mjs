import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertHybridUpdateSequence,
  qualifyHybridUpdate,
} from './phase3-hybrid-update-fixture.mjs';

test('Hybrid update requires cancelled, worker-pending, resumed, and repeated command evidence', () => {
  const commands = [
    { command: 'update', status: 'cancelled', durationMs: 10 },
    { command: 'update', status: 'prepared-workers-pending', durationMs: 20 },
    { command: 'resume', status: 'ready', durationMs: 30 },
    { command: 'update', status: 'already-current', durationMs: 10 },
  ];
  assert.doesNotThrow(() => assertHybridUpdateSequence(commands));
  for (const mutate of [
    (value) => {
      value.splice(1, 1);
    },
    (value) => {
      value[1].status = 'ready';
    },
    (value) => {
      value[2].command = 'update';
    },
    (value) => {
      value[3].status = 'ready';
    },
    (value) => {
      value[0].durationMs = -1;
    },
  ]) {
    const invalid = structuredClone(commands);
    mutate(invalid);
    assert.throws(() => assertHybridUpdateSequence(invalid));
  }
});

test('Hybrid update rejects foreign installations before backup or installer access', async () => {
  let commands = 0;
  await assert.rejects(
    qualifyHybridUpdate({
      project: 'production',
      cli: async () => {
        commands++;
      },
    }),
    { code: 'ERR_ASSERTION' },
  );
  assert.equal(commands, 0);
});
