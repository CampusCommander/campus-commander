import assert from 'node:assert/strict';
import test from 'node:test';
import { retainSession } from './session-retention.ts';

const key = 'cc:auth:session:a';
const now = Date.parse('2026-10-07T12:00:00.000Z');

/** Session keys with their remaining seconds, like Redis TTL. */
function sessionKeys(seconds) {
  const keys = new Map([[key, seconds]]);
  const store = {
    calls: [],
    async expire(name, value) {
      store.calls.push('expire');
      if (!keys.has(name)) return 0;
      keys.set(name, value);
      return 1;
    },
    async exists(name) {
      store.calls.push('exists');
      return keys.has(name) ? 1 : 0;
    },
    ttl: () => keys.get(key),
    end: () => keys.delete(key),
  };
  return store;
}

test('a request slides the idle timeout up to the absolute lifetime', async () => {
  const store = sessionKeys(100);
  const slide = (expiresAt) =>
    retainSession(store, key, {
      slide: true,
      idleSeconds: 1800,
      expiresAt,
      now,
    });
  assert.equal(await slide(now + 8 * 3600_000), true);
  assert.equal(store.ttl(), 1800);
  assert.equal(await slide(now + 600_000), true);
  assert.equal(store.ttl(), 600);
  assert.equal(await slide(now + 500), true);
  assert.equal(store.ttl(), 1);
});

test('a stream recheck leaves the session TTL unchanged', async () => {
  const store = sessionKeys(100);
  assert.equal(
    await retainSession(store, key, {
      slide: false,
      idleSeconds: 1800,
      expiresAt: now + 8 * 3600_000,
      now,
    }),
    true,
  );
  assert.equal(store.ttl(), 100);
  assert.deepEqual(store.calls, ['exists']);
});

test('a session that ended meanwhile is not retained', async () => {
  for (const slide of [true, false]) {
    const store = sessionKeys(100);
    store.end();
    assert.equal(
      await retainSession(store, key, {
        slide,
        idleSeconds: 1800,
        expiresAt: now + 3600_000,
        now,
      }),
      false,
    );
  }
});
