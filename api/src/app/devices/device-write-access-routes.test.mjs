import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { DeviceWriteAccessRoutes } from './device-write-access-routes.ts';

const customer = 'C0123456';
const actor = '11111111-1111-4111-8111-111111111111';
const correlationId = '22222222-2222-4222-8222-222222222222';
const writeScope =
  'https://www.googleapis.com/auth/admin.directory.device.chromeos';
const session = {
  identity: {
    id: actor,
    displayName: 'Test person',
    permissions: [],
    permissionVersion: 1,
    grants: [],
    preferences: {},
  },
  expiresAt: '2026-10-19T12:00:00.000Z',
  csrfToken: 'a'.repeat(64),
};
const sync = {
  customerId: customer,
  generation: 3,
  status: 'ready',
  observedAt: null,
  deviceCount: 0,
  failure: null,
  telemetryFailure: null,
  startedAt: null,
  checkedAt: null,
  stale: false,
};
const granted = {
  state: 'granted',
  scope: writeScope,
  failure: null,
  checkedAt: '2026-10-19T10:00:00.000Z',
};

/** An authorizer that allows the listed actions and records every check. */
function createAuth(allowed = ['devices:write']) {
  const calls = [];
  return {
    calls,
    authorize: async (_session, action, resource, received) => {
      calls.push({ action, resource, correlationId: received });
      if (!allowed.includes(action))
        throw new ForbiddenException(
          'This action requires additional permission.',
        );
    },
  };
}

function createRoutes({ allowed, access, current = sync } = {}) {
  const auth = createAuth(allowed);
  const accessCalls = [];
  const routes = new DeviceWriteAccessRoutes(
    { sync: async () => current },
    auth,
    {
      read: async (_session, received) => {
        accessCalls.push(['read', received]);
        return access ?? granted;
      },
      check: async (_session, received) => {
        accessCalls.push(['check', received]);
        return access ?? granted;
      },
    },
  );
  return { routes, auth, accessCalls };
}

test('the access routes require only devices:write at the district scope', async () => {
  const { routes, auth } = createRoutes();
  assert.deepEqual(await routes.read(session, correlationId), granted);
  assert.deepEqual(await routes.check(session, correlationId), granted);
  assert.deepEqual(auth.calls, [
    {
      action: 'devices:write',
      resource: { kind: 'district', customerId: customer },
      correlationId,
    },
    {
      action: 'devices:write',
      resource: { kind: 'district', customerId: customer },
      correlationId,
    },
  ]);
});

test('a caller without devices:write receives 403 on both access routes', async () => {
  const { routes, accessCalls } = createRoutes({ allowed: [] });
  for (const call of [
    () => routes.read(session, correlationId),
    () => routes.check(session, correlationId),
  ]) {
    await assert.rejects(call, (error) => {
      assert.ok(error instanceof ForbiddenException);
      assert.equal(error.getStatus(), 403);
      return true;
    });
  }
  assert.deepEqual(accessCalls, []);
});

test('a request without a connection reads unchecked and checks nothing', async () => {
  const { routes, auth, accessCalls } = createRoutes({ current: null });
  const unchecked = {
    state: 'unchecked',
    scope: null,
    failure: null,
    checkedAt: null,
  };
  assert.deepEqual(await routes.read(session, correlationId), unchecked);
  assert.deepEqual(await routes.check(session, correlationId), unchecked);
  assert.deepEqual(auth.calls, []);
  assert.deepEqual(accessCalls, []);
});
