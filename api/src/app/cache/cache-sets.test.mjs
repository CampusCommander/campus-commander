import assert from 'node:assert/strict';
import test from 'node:test';
import { addMembersScript, memberChunks } from './cache-sets.ts';

test('addMembers chunks members so one EVAL stays small', () => {
  const members = Array.from({ length: 2300 }, (_, index) => `d${index}`);
  const chunks = memberChunks(members);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [1000, 1000, 300]);
});

test('the add script returns only newly added members and refreshes the expiry', () => {
  assert.match(addMembersScript, /SADD/);
  assert.match(addMembersScript, /EXPIRE/);
  assert.match(addMembersScript, /ARGV\[1\]/);
});
