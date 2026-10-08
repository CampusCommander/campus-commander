import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForKubernetesShutdown } from './kubernetes-installer-fixture.mjs';
const rendered = {
  items: [
    {
      kind: 'Deployment',
      metadata: { name: 'kestra' },
      spec: { template: { spec: { terminationGracePeriodSeconds: 360 } } },
    },
  ],
};

test('shutdown waits for the rendered Kestra grace period', async () => {
  let elapsed = 0;
  await waitForKubernetesShutdown(
    async () =>
      JSON.stringify({
        items: elapsed < 360000 ? [{ metadata: { name: 'kestra' } }] : [],
      }),
    rendered,
    {
      now: () => elapsed,
      delay: async (ms) => {
        elapsed += ms;
      },
    },
  );
  assert.equal(elapsed, 360000);
});

test('shutdown rejects pods that remain beyond the rendered grace and observation allowance', async () => {
  let elapsed = 0;
  await assert.rejects(
    waitForKubernetesShutdown(
      async () => JSON.stringify({ items: [{}] }),
      rendered,
      {
        now: () => elapsed,
        delay: async (ms) => {
          elapsed += ms;
        },
      },
    ),
    /must stop every application pod/,
  );
  assert.equal(elapsed, 390000);
});

test('shutdown returns immediately when all application pods are absent', async () => {
  await waitForKubernetesShutdown(
    async () => JSON.stringify({ items: [] }),
    rendered,
    {
      delay: async () => {
        assert.fail('An empty installation requires no wait.');
      },
    },
  );
});
