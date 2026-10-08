import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addMembersScript,
  memberChunks,
  replaceListScript,
} from './cache-sets.ts';

test('addMembers chunks members so one EVAL stays small', () => {
  const members = Array.from({ length: 2300 }, (_, index) => `d${index}`);
  const chunks = memberChunks(members);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [1000, 1000, 300],
  );
});

test('the claim script gives each member its own expiry score from the Redis clock', () => {
  assert.doesNotMatch(addMembersScript, /SADD/);
  assert.match(addMembersScript, /redis\.call\('TIME'\)/);
  assert.match(
    addMembersScript,
    /redis\.call\('ZREMRANGEBYSCORE',KEYS\[1\],'-inf',now\)/,
  );
  assert.match(
    addMembersScript,
    /for i=2,#ARGV do if redis\.call\('ZADD',KEYS\[1\],'NX',now\+tonumber\(ARGV\[1\]\)\*1000,ARGV\[i\]\)==1/,
  );
  assert.match(addMembersScript, /redis\.call\('EXPIRE',KEYS\[1\],3600\)/);
  assert.ok(
    addMembersScript.indexOf('ZREMRANGEBYSCORE') <
      addMembersScript.indexOf('ZADD'),
    'Expired members leave before new claims.',
  );
});

test('the replace-list script sets the list expiry from its first argument', () => {
  assert.match(
    replaceListScript,
    /redis\.call\('EXPIRE',KEYS\[1\],tonumber\(ARGV\[1\]\)\)/,
  );
  assert.match(replaceListScript, /for i=2,#ARGV,1000 do/);
  assert.ok(
    replaceListScript.indexOf('RPUSH') < replaceListScript.indexOf('EXPIRE'),
    'The expiry applies after the push creates the list.',
  );
});
