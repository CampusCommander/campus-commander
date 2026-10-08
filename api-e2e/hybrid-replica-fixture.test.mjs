import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readHybridReplica,
  verifyHybridRecipientAccess,
} from './hybrid-replica-fixture.mjs';

test('replica reads reject unrelated routes and keep cookies out of process arguments', async () => {
  const cookie = '__Host-session=private-fixture-cookie';
  const calls = [];
  const hosts = {
    async run(host, args, options) {
      calls.push({ args, options });
      return JSON.stringify({ status: 401, hiddenSchoolResponse: false });
    },
  };
  const input = {
    hosts,
    controller: {},
    replica: 'a'.repeat(64),
    cookie,
    path: '/api/auth/session',
  };
  for (const path of [
    '/api/google-connection',
    '/api/schools?count=true',
    '/api/auth/session?cookie=secret',
  ])
    await assert.rejects(readHybridReplica({ ...input, path }), {
      name: 'AssertionError',
    });
  await assert.rejects(
    readHybridReplica({ ...input, replica: 'unowned-container' }),
    { name: 'AssertionError' },
  );
  assert.equal(calls.length, 0);
  const result = await readHybridReplica(input);
  assert.equal(result.status, 401);
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0].args).includes(cookie), false);
  assert.deepEqual(JSON.parse(calls[0].options.input), {
    cookie,
    path: input.path,
  });
  assert.equal(JSON.stringify(result).includes(cookie), false);
});

test('permission checks replay the supplied stale cookie against both replicas', async () => {
  const cookie = '__Host-session=retired-fixture-session';
  const calls = [];
  const result = await verifyHybridRecipientAccess(
    {
      hosts: {
        async run(host, args, { input }) {
          calls.push(JSON.parse(input));
          return JSON.stringify({ status: 401, hiddenSchoolResponse: false });
        },
      },
      controller: {},
      compose: async () => 'a'.repeat(64) + '\n' + 'b'.repeat(64),
    },
    {
      cookies: [{ name: '__Host-session', value: 'retired-fixture-session' }],
      principalId: 'principal',
      schoolId: '01234567-89ab-cdef-0123-456789abcdef',
      hiddenSchoolId: '12345678-9abc-def0-1234-56789abcdef0',
      expectedStatus: 401,
      stage: 'revoked',
    },
  );
  assert.equal(calls.length, 4);
  assert.ok(calls.every((entry) => entry.cookie === cookie));
  assert.equal(new Set(result.map((entry) => entry.replica)).size, 2);
  assert.equal(result.length, 4);
  assert.ok(
    result.every((entry) => entry.status === 401 && entry.stage === 'revoked'),
  );
  assert.equal(
    JSON.stringify(result).includes('retired-fixture-session'),
    false,
  );
});
