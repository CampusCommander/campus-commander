import assert from 'node:assert/strict';
import test from 'node:test';
import { reloadAfterNetworkChange } from './navigation-fixture.mjs';

test('a network change retries only the interrupted page reload', async () => {
  let attempts = 0;
  const page = {
    async reload() {
      if (++attempts === 1)
        throw Error('page.reload: net::ERR_NETWORK_CHANGED');
      return {};
    },
  };
  assert.deepEqual(await reloadAfterNetworkChange(page, { retryDelayMs: 0 }), {
    attempts: 2,
    networkChanges: 1,
  });
  assert.equal(attempts, 2);
});

test('other navigation errors fail without retry', async () => {
  let attempts = 0;
  await assert.rejects(
    reloadAfterNetworkChange({
      async reload() {
        attempts++;
        throw Error('page.reload: net::ERR_CERT_AUTHORITY_INVALID');
      },
    }),
    /ERR_CERT_AUTHORITY_INVALID/,
  );
  assert.equal(attempts, 1);
});

test('persistent network changes stop after three navigation attempts', async () => {
  let attempts = 0;
  await assert.rejects(
    reloadAfterNetworkChange(
      {
        async reload() {
          attempts++;
          throw Error('page.reload: net::ERR_NETWORK_CHANGED');
        },
      },
      { retryDelayMs: 0 },
    ),
    /ERR_NETWORK_CHANGED/,
  );
  assert.equal(attempts, 3);
});
