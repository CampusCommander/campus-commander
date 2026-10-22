import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  DEVICE_ORG_UNIT_TREE_DENIED_MESSAGE,
  deviceOrgUnitTreeMessage,
} from '@campus/application-contracts';
import { GoogleConnectionError } from '@campus/google-connection';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DEVICE_ORG_UNIT_SCOPE,
  DeviceOrgUnitTreeRoute,
} from './device-org-unit-tree.ts';

const customer = 'C0123456';
const actor = '11111111-1111-4111-8111-111111111111';
const correlationId = '22222222-2222-4222-8222-222222222222';
const orgUnitScope =
  'https://www.googleapis.com/auth/admin.directory.orgunit.readonly';
const session = {
  identity: {
    id: actor,
    displayName: 'Test person',
    permissions: [],
    permissionVersion: 1,
    grants: [],
    preferences: {},
  },
  expiresAt: '2026-10-21T12:00:00.000Z',
  csrfToken: 'a'.repeat(64),
};
const connected = { customerId: customer, generation: 3 };
const credential = {
  subject: 'admin@example.org',
  serviceAccount: {
    client_email: 'fixture@example.iam.gserviceaccount.com',
    private_key: 'synthetic',
    private_key_id: 'fixture',
  },
};
/** The seeded tree of the mock: the root, one school, and one class. */
const tree = [
  {
    orgUnitId: 'id:01',
    name: 'District',
    orgUnitPath: '/',
    parentOrgUnitId: null,
  },
  {
    orgUnitId: 'id:02',
    name: 'School A',
    orgUnitPath: '/School A',
    parentOrgUnitId: 'id:01',
  },
  {
    orgUnitId: 'id:03',
    name: 'Class 1',
    orgUnitPath: '/School A/Class 1',
    parentOrgUnitId: 'id:02',
  },
];

/** Settle a call into a value or an error so a wrong answer reads as an assertion. */
const settle = (call) =>
  call().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

/**
 * The tree port. `connection` models cc.device_writer, `authorize` models
 * DEVICE_UPDATE_ACTIONS, and `credential` models cc.device_write_credential.
 */
function createRoute({
  actions = ['devices:read', 'devices:write', 'devices:bulk-actions'],
  current = connected,
  credential: openCredential = async () => credential,
  read = async () => tree,
  options = {},
  authorize,
} = {}) {
  const calls = { connection: [], authorize: [], credential: [], read: [] };
  // cc.device_writer accepts any write action of the update family.
  const writer = actions.some((action) =>
    ['devices:write', 'devices:commands', 'devices:status'].includes(action),
  );
  // DEVICE_UPDATE_ACTIONS requires all three of its actions at the district scope.
  const updates = [
    'devices:read',
    'devices:write',
    'devices:bulk-actions',
  ].every((action) => actions.includes(action));
  const route = new DeviceOrgUnitTreeRoute(
    {
      connection: async (received) => {
        calls.connection.push(received);
        if (!writer)
          throw new ForbiddenException('Update devices requires permission.');
        return current;
      },
      authorize:
        authorize ??
        (async (received, customerId, receivedCorrelation) => {
          calls.authorize.push([received, customerId, receivedCorrelation]);
          if (!updates)
            throw new ForbiddenException(
              'This action requires additional permission.',
            );
        }),
      credential: async (received, context) => {
        calls.credential.push(context);
        return openCredential(received, context);
      },
      read: async (received, customerId, signal) => {
        calls.read.push({ credential: received, customerId, signal });
        return read(received, customerId, signal);
      },
    },
    options,
  );
  return { route, calls };
}

test('a person with the update actions reads the whole tree as granted', async () => {
  const { route, calls } = createRoute();
  const answer = await route.read(session, correlationId);
  assert.equal(answer.state, 'granted');
  assert.equal(answer.scope, orgUnitScope);
  assert.equal(answer.failure, null);
  assert.deepEqual(answer.orgUnits, tree);
  assert.match(answer.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(calls.authorize, [[session, customer, correlationId]]);
  assert.deepEqual(calls.credential, [connected]);
  assert.equal(calls.read.length, 1);
  assert.equal(calls.read[0].credential, credential);
  assert.equal(calls.read[0].customerId, customer);
  assert.ok(
    calls.read[0].signal instanceof AbortSignal,
    'the Google read carries an abort signal',
  );
  assert.equal(calls.read[0].signal.aborted, false);
});

test('the setup scope list names the organization unit read scope', () => {
  assert.equal(DEVICE_ORG_UNIT_SCOPE, orgUnitScope);
});

test('a person without devices:write receives 403 and opens no credential', async () => {
  const { route, calls } = createRoute({ actions: ['devices:read'] });
  await assert.rejects(route.read(session, correlationId), (error) => {
    assert.ok(error instanceof ForbiddenException);
    assert.equal(error.getStatus(), 403);
    return true;
  });
  assert.deepEqual(calls.credential, [], 'a 403 opens no credential');
  assert.deepEqual(calls.read, [], 'a 403 reads no tree');
});

test('a person with a write action but without devices:write and bulk actions receives 403', async () => {
  const { route, calls } = createRoute({ actions: ['devices:status'] });
  await assert.rejects(route.read(session, correlationId), (error) => {
    assert.ok(error instanceof ForbiddenException);
    assert.equal(error.getStatus(), 403);
    return true;
  });
  assert.equal(calls.authorize.length, 1);
  assert.deepEqual(
    calls.credential,
    [],
    'a person check refusal opens no credential',
  );
  assert.deepEqual(calls.read, [], 'a person check refusal reads no tree');
});

test('a removed organization unit scope answers denied with the scope and its message', async () => {
  const { route, calls } = createRoute({
    read: async () => {
      throw new GoogleConnectionError('delegation-not-authorized');
    },
  });
  const answer = await route.read(session, correlationId);
  assert.equal(answer.state, 'denied');
  assert.equal(answer.scope, orgUnitScope);
  assert.equal(answer.failure, 'delegation-not-authorized');
  assert.equal(answer.orgUnits, null);
  assert.equal(
    deviceOrgUnitTreeMessage(answer),
    DEVICE_ORG_UNIT_TREE_DENIED_MESSAGE,
  );
  assert.match(DEVICE_ORG_UNIT_TREE_DENIED_MESSAGE, /orgunit\.readonly/);
  assert.equal(calls.read.length, 1, 'a denial runs the Google read once');
});

test('a scope mismatch is denied the same way', async () => {
  const { route } = createRoute({
    read: async () => {
      throw new GoogleConnectionError('scope-mismatch');
    },
  });
  const answer = await route.read(session, correlationId);
  assert.equal(answer.state, 'denied');
  assert.equal(answer.failure, 'scope-mismatch');
  assert.equal(answer.orgUnits, null);
  assert.equal(
    deviceOrgUnitTreeMessage(answer),
    DEVICE_ORG_UNIT_TREE_DENIED_MESSAGE,
  );
});

test('every other Google failure answers unavailable with its code', async () => {
  for (const code of [
    'network-failure',
    'quota',
    'permission-denied',
    'invalid-response',
  ]) {
    const { route } = createRoute({
      read: async () => {
        throw new GoogleConnectionError(code);
      },
    });
    const answer = await route.read(session, correlationId);
    assert.equal(answer.state, 'unavailable', code);
    assert.equal(answer.failure, code);
    assert.equal(answer.orgUnits, null);
    assert.equal(deviceOrgUnitTreeMessage(answer), null);
  }
});

test('a tree that fails the response schema answers unavailable', async () => {
  const { route } = createRoute({
    read: async () => [{ orgUnitId: 'id:01', name: 'District' }],
  });
  const answer = await route.read(session, correlationId);
  assert.equal(answer.state, 'unavailable');
  assert.equal(answer.failure, 'invalid-response');
  assert.equal(answer.orgUnits, null);
});

test('a person with the actions and no connection answers 409 connection-required', async () => {
  const { route, calls } = createRoute({ current: null });
  const settled = await settle(() => route.read(session, correlationId));
  assert.ok(settled.error instanceof ConflictException);
  assert.equal(settled.error.getStatus(), 409);
  assert.deepEqual(settled.error.getResponse(), {
    reason: 'connection-required',
  });
  assert.deepEqual(calls.credential, [], 'no connection opens no credential');
  assert.deepEqual(calls.read, []);
});

test('a credential that arrives after the deadline answers unavailable', async () => {
  const { route, calls } = createRoute({
    credential: () => delay(50).then(() => credential),
    options: { deadlineMilliseconds: 20 },
  });
  const answer = await route.read(session, correlationId);
  assert.equal(answer.state, 'unavailable');
  assert.equal(answer.failure, 'network-failure');
  assert.equal(answer.orgUnits, null);
  assert.deepEqual(calls.read, [], 'a deadline minted no token');
});

test('a Google read that fails the deadline answers unavailable', async () => {
  const { route } = createRoute({
    read: async (_credential, _customerId, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(new GoogleConnectionError('network-failure')),
        );
      }),
    options: { deadlineMilliseconds: 20 },
  });
  const answer = await route.read(session, correlationId);
  assert.equal(answer.state, 'unavailable');
  assert.equal(answer.failure, 'network-failure');
});
