import assert from 'node:assert/strict';
import test from 'node:test';
import { enrollAdministrator } from './application-enrollment.mjs';

const identity = {
  issuer: 'https://accounts.google.com',
  subject: 'verified-subject',
  displayName: 'Test administrator',
};
function fixture() {
  const calls = [];
  return {
    calls,
    options: {
      config: {
        applicationAuth: {
          issuer: identity.issuer,
          publicOrigin: 'https://localhost:8443',
        },
      },
      operator: {},
      output: () => undefined,
      privateOutput: () => undefined,
      ask: async () => 'yes',
      access: async (_operator, input) => {
        calls.push(input.action);
        return input.action === 'inspect'
          ? { principals: [] }
          : {
              principalId: 'principal',
              correlationId: 'e73895b2-d76c-4c22-8ca6-96a07f5ec9ed',
            };
      },
      request: async (_config, _operator, input) => {
        calls.push(input.action);
        if (input.action === 'start')
          return {
            id: 'a'.repeat(64),
            code: 'b'.repeat(64),
            expires: Date.now() + 60000,
          };
        return { status: 'verified', candidate: identity };
      },
    },
  };
}
test('enrollment consumes verified identity only after explicit confirmation', async () => {
  const f = fixture();
  assert.equal((await enrollAdministrator(f.options)).status, 'enrolled');
  assert.deepEqual(f.calls, [
    'inspect',
    'cancel',
    'start',
    'inspect',
    'claim',
    'initialize',
    'cancel',
  ]);
});
test('cancel, changed identity, and interruption never grant access', async () => {
  for (const failure of ['cancel', 'changed', 'disk']) {
    const f = fixture();
    if (failure === 'cancel') f.options.ask = async () => 'no';
    else {
      const request = f.options.request;
      f.options.request = async (...args) => {
        if (args[2].action === 'claim') {
          if (failure === 'disk') throw new Error('Interrupted');
          return { candidate: { ...identity, subject: 'different' } };
        }
        return request(...args);
      };
    }
    if (failure === 'cancel')
      assert.equal((await enrollAdministrator(f.options)).status, 'cancelled');
    else await assert.rejects(enrollAdministrator(f.options));
    assert.equal(f.calls.includes('initialize'), false);
  }
});
test('resume after a committed grant preserves the existing administrator', async () => {
  const f = fixture();
  f.options.access = async () => ({ principals: [{ id: 'existing' }] });
  f.options.request = () =>
    assert.fail('Do not replace an existing administrator.');
  assert.equal(
    (await enrollAdministrator(f.options)).status,
    'already-enrolled',
  );
});

test('pairing codes use private output and cancellation survives a missing terminal', async () => {
  const f = fixture(),
    ordinary = [],
    privateLines = [];
  f.options.output = (line) => ordinary.push(line);
  f.options.privateOutput = (line) => privateLines.push(line);
  await enrollAdministrator(f.options);
  assert.equal(privateLines.length, 1);
  assert.ok(privateLines[0].includes('b'.repeat(64)));
  assert.ok(ordinary.every((line) => !line.includes('b'.repeat(64))));
  const closed = fixture();
  closed.options.privateOutput = () => {
    throw new Error('Terminal disconnected');
  };
  await assert.rejects(enrollAdministrator(closed.options));
  assert.equal(closed.calls.at(-1), 'cancel');
  assert.equal(closed.calls.includes('initialize'), false);
});
