import assert from 'node:assert/strict';
import test from 'node:test';
import {
  backoffDelay,
  classifyStatus,
  nextPageToken,
  retryAfterMs,
} from './batch.ts';

const reason = (why) => ({ error: { errors: [{ reason: why }] } });

test('classifyStatus separates success, missing, quota, transient, auth, and rejected parts', () => {
  const cases = [
    [200, {}, 'success'],
    [204, null, 'success'],
    [404, reason('notFound'), 'not-found'],
    [429, reason('rateLimitExceeded'), 'quota'],
    [429, null, 'quota'],
    [403, reason('rateLimitExceeded'), 'quota'],
    [403, reason('userRateLimitExceeded'), 'quota'],
    [403, reason('quotaExceeded'), 'quota'],
    [500, null, 'transient'],
    [502, '<html>bad gateway</html>', 'transient'],
    [503, reason('backendError'), 'transient'],
    [504, null, 'transient'],
    [403, reason('backendError'), 'transient'],
    [401, reason('authError'), 'auth'],
    [403, reason('forbidden'), 'auth'],
    [403, reason('insufficientPermissions'), 'auth'],
    [403, null, 'auth'],
    [400, reason('invalid'), 'rejected'],
    [409, reason('duplicate'), 'rejected'],
    [412, null, 'rejected'],
  ];
  for (const [status, body, kind] of cases)
    assert.equal(
      classifyStatus(status, body).kind,
      kind,
      `${status} ${JSON.stringify(body)}`,
    );
  assert.deepEqual(classifyStatus(403, reason('forbidden')), {
    kind: 'auth',
    reason: 'forbidden',
  });
  assert.deepEqual(classifyStatus(200, reason('ignored')), {
    kind: 'success',
    reason: null,
  });
  assert.equal(
    classifyStatus(429, { error: { status: 'RESOURCE_EXHAUSTED' } }).reason,
    'RESOURCE_EXHAUSTED',
  );
});

test('backoffDelay grows by the multiplier, caps at the maximum, and applies full jitter', () => {
  const options = { initialDelayMs: 1_000, multiplier: 2, maxDelayMs: 60_000 };
  assert.deepEqual(
    [1, 2, 3, 6, 7, 25].map((retry) => backoffDelay(retry, options, () => 0.5)),
    [500, 1_000, 2_000, 16_000, 30_000, 30_000],
  );
  assert.equal(
    backoffDelay(3, options, () => 0),
    0,
  );
  assert.equal(
    backoffDelay(30, options, () => 0.999999),
    59_999,
  );
});

test('retryAfterMs reads seconds and HTTP dates', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  assert.equal(retryAfterMs('7', now), 7_000);
  assert.equal(retryAfterMs('Wed, 07 Oct 2026 12:00:30 GMT', now), 30_000);
  assert.equal(retryAfterMs('Wed, 07 Oct 2026 11:59:00 GMT', now), 0);
  assert.equal(retryAfterMs(undefined, now), null);
  assert.equal(retryAfterMs('soon', now), null);
});

test('nextPageToken reads a non-empty string token only', () => {
  assert.equal(nextPageToken({ nextPageToken: 'p2' }), 'p2');
  assert.equal(nextPageToken({ nextPageToken: '' }), null);
  assert.equal(nextPageToken({ nextPageToken: 7 }), null);
  assert.equal(nextPageToken('text'), null);
  assert.equal(nextPageToken(null), null);
});
