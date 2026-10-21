import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accessChangedEntry,
  accessChangedSeconds,
  readSessionEntry,
  sessionSchema,
} from './session-entry.ts';

const principalId = '0f0d5a2e-5f43-4a8d-9a41-0d3f0f6f2f1a';
const stored = JSON.stringify({
  principalId,
  permissionVersion: 3,
  expiresAt: 1790000000000,
  csrfToken: 'a'.repeat(64),
});

test('a session entry keeps its stored session', () => {
  const entry = readSessionEntry(stored);
  assert.equal(entry.kind, 'session');
  assert.deepEqual(entry.session, JSON.parse(stored));
});

test('a revoked session entry reports the access change to every request', () => {
  const revoked = accessChangedEntry(principalId);
  for (let request = 0; request < 3; request++)
    assert.deepEqual(readSessionEntry(revoked), {
      kind: 'access-changed',
      principalId,
    });
});

test('a revoked session entry holds no session data and expires on a short bound', () => {
  const value = JSON.parse(accessChangedEntry(principalId));
  assert.deepEqual(Object.keys(value).sort(), ['accessChanged', 'principalId']);
  assert.equal(sessionSchema.safeParse(value).success, false);
  assert.equal(Number.isInteger(accessChangedSeconds), true);
  assert.equal(accessChangedSeconds > 0, true);
  assert.equal(accessChangedSeconds <= 60, true);
});
