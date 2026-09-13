import assert from 'node:assert/strict';
import test from 'node:test';
import { noOtherConnections } from './quiescence.mjs';

test('connection teardown waits for a fresh zero observation within a transaction', async () => {
  let elapsed = 0;
  let snapshot;
  const client = {
    async query(sql) {
      if (sql.includes('pg_stat_clear_snapshot')) {
        snapshot = undefined;
        return { rows: [] };
      }
      snapshot ??= elapsed < 300 ? 1 : 0;
      return { rows: [{ count: snapshot }] };
    },
  };
  await noOtherConnections(client, {
    now: () => elapsed,
    delay: async (ms) => {
      elapsed += ms;
    },
  });
  assert.equal(elapsed, 300);
});

test('persistent connections still reject backup after the observation budget', async () => {
  let elapsed = 0;
  await assert.rejects(
    noOtherConnections(
      {
        async query() {
          return { rows: [{ count: 1 }] };
        },
      },
      {
        now: () => elapsed,
        delay: async (ms) => {
          elapsed += ms;
        },
      },
    ),
    /Stop every application and Kestra database connection/,
  );
  assert.equal(elapsed, 5000);
});

test('an idle database requires no polling delay', async () => {
  await noOtherConnections(
    {
      async query() {
        return { rows: [{ count: 0 }] };
      },
    },
    {
      delay: async () => {
        assert.fail('An idle database needs no delay.');
      },
    },
  );
});
