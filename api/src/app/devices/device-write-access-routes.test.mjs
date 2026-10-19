import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  WriteAccessBusyError,
  WriteAccessDeadlineError,
} from './device-write-access.ts';
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
const connected = { customerId: customer, generation: 3 };
const granted = {
  state: 'granted',
  scope: writeScope,
  failure: null,
  checkedAt: '2026-10-19T10:00:00.000Z',
};
const unchecked = {
  state: 'unchecked',
  scope: null,
  failure: null,
  checkedAt: null,
};

/** Settle a call into a value or an error so a wrong answer reads as an assertion. */
const settle = (call) =>
  call().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

/**
 * The write-access port. `connection` models cc.device_writer: it requires
 * devices:write and answers the connected generation. `sync` and `authorize`
 * are API-compatible stubs for the parent revision, whose routes resolved
 * through DevicesService.sync, which requires devices:read (design 8.2).
 */
function createRoutes({
  actions = ['devices:write'],
  current = connected,
  access = granted,
  check,
} = {}) {
  const calls = { connection: [], read: [], check: [], sync: 0 };
  const writer = actions.includes('devices:write');
  const reader = actions.includes('devices:read');
  const port = {
    sync: async () => {
      calls.sync += 1;
      return current && reader ? current : null;
    },
    authorize: async () => undefined,
    connection: async (received) => {
      calls.connection.push(received);
      if (!writer)
        throw new ForbiddenException(
          'This action requires additional permission.',
        );
      return current;
    },
    read: async (_received, context) => {
      calls.read.push(context);
      return access;
    },
    check:
      check ??
      (async (_received, context) => {
        calls.check.push(context);
        return access;
      }),
  };
  return {
    routes: new DeviceWriteAccessRoutes(port),
    calls,
  };
}

test('a principal with devices:write alone resolves both routes through cc.device_writer', async () => {
  const { routes, calls } = createRoutes({ actions: ['devices:write'] });
  const read = await settle(() => routes.read(session, correlationId));
  assert.equal(
    read.error,
    undefined,
    `GET answers the access state to a devices:write writer: ${read.error}`,
  );
  assert.deepEqual(read.value, granted);
  const check = await settle(() => routes.check(session, correlationId));
  assert.equal(
    check.error,
    undefined,
    `POST answers the access state to a devices:write writer: ${check.error}`,
  );
  assert.deepEqual(check.value, granted);
  assert.equal(
    calls.connection.length,
    2,
    'Both routes authorize through cc.device_writer.',
  );
  assert.equal(calls.sync, 0, 'Neither route reads the device inventory.');
  assert.deepEqual(calls.read, [connected]);
  assert.deepEqual(calls.check, [connected]);
});

test('a caller without devices:write receives 403 on both access routes', async () => {
  const { routes, calls } = createRoutes({ actions: ['devices:read'] });
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
  assert.equal(calls.connection.length, 2);
  assert.deepEqual(calls.read, [], 'A 403 reads no cached state.');
  assert.deepEqual(calls.check, [], 'A 403 starts no check.');
});

test('a caller without devices:write receives 403 without a connection', async () => {
  const { routes, calls } = createRoutes({
    actions: ['devices:read'],
    current: null,
  });
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
  assert.equal(calls.connection.length, 2);
  assert.equal(calls.sync, 0, 'Neither route reads the device inventory.');
});

test('a principal without devices:write gets no unchecked answer without a connection', async () => {
  const { routes } = createRoutes({ actions: [], current: null });
  await assert.rejects(routes.read(session, correlationId), (error) => {
    assert.ok(error instanceof ForbiddenException);
    assert.equal(error.getStatus(), 403);
    return true;
  });
});

test('a principal with devices:write and no connection reads unchecked and checks nothing', async () => {
  const { routes, calls } = createRoutes({
    actions: ['devices:write'],
    current: null,
  });
  const read = await settle(() => routes.read(session, correlationId));
  assert.equal(
    read.error,
    undefined,
    `GET answers unchecked without a connection: ${read.error}`,
  );
  assert.deepEqual(read.value, unchecked);
  const check = await settle(() => routes.check(session, correlationId));
  assert.equal(
    check.error,
    undefined,
    `POST answers unchecked without a connection: ${check.error}`,
  );
  assert.deepEqual(check.value, unchecked);
  assert.equal(
    calls.connection.length,
    2,
    'Both routes authorize before they answer unchecked.',
  );
  assert.deepEqual(calls.read, []);
  assert.deepEqual(calls.check, []);
});

test('a repeat check inside the interval answers 429 busy', async () => {
  const { routes, calls } = createRoutes({
    check: async () => {
      throw new WriteAccessBusyError();
    },
  });
  const read = await settle(() => routes.read(session, correlationId));
  assert.equal(read.error, undefined, `GET stays available: ${read.error}`);
  const check = await settle(() => routes.check(session, correlationId));
  assert.equal(check.value, undefined, 'A busy check answers no projection.');
  assert.ok(
    check.error instanceof HttpException,
    `A busy check answers an HTTP error: ${check.error}`,
  );
  assert.equal(check.error.getStatus(), 429, 'A busy check answers 429.');
  assert.deepEqual(check.error.getResponse(), { reason: 'busy' });
  assert.equal(calls.connection.length, 2, 'The busy check authorized first.');
  assert.deepEqual(calls.read, [connected]);
});

test('a check that reaches its deadline answers 503 without a credential', async () => {
  const { routes, calls } = createRoutes({
    check: async () => {
      throw new WriteAccessDeadlineError();
    },
  });
  const check = await settle(() => routes.check(session, correlationId));
  assert.equal(check.value, undefined, 'A deadline answers no projection.');
  assert.ok(
    check.error instanceof ServiceUnavailableException,
    `A deadline answers 503: ${check.error}`,
  );
  assert.equal(check.error.getStatus(), 503);
  assert.deepEqual(check.error.getResponse(), {
    reason: 'device-store-unavailable',
  });
  assert.equal(
    calls.connection.length,
    1,
    'The deadline check authorized first.',
  );
});
