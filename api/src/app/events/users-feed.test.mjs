import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import {
  entityEventSchema,
  entityEventsChannel,
} from '@campus/application-contracts';
import { streamEvents } from '../devices/device-events';
import { recheckEventStream } from './events-stream';

const CUSTOMER = 'C0123456';
const OTHER = 'C0999999';
const ACTOR = '44444444-4444-4444-8444-444444444444';

/** One session with the grants that the case names. */
const session = (grants = []) => ({
  identity: {
    id: ACTOR,
    displayName: 'Grace Hopper',
    permissions: ['identity:read'],
    permissionVersion: 1,
    grants,
    preferences: { theme: 'system', navigationCollapsed: false },
  },
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  csrfToken: 'a'.repeat(64),
});
const district = (action, customerId = CUSTOMER) => ({
  action,
  scope: { kind: 'district', customerId },
});

/**
 * One ping of the one stream. The device feed stays left out, so `canOpenDevice` answers its
 * probe. `users: true` opens the users feed, and its answers are values or functions of the
 * session.
 */
function probe({
  next = session([district('users:read')]),
  jobCustomer = CUSTOMER,
  users = false,
  usersCustomer = { customerId: CUSTOMER },
  visibility = false,
  canOpenDevice = false,
  canOpenUsers = false,
  failure = null,
} = {}) {
  const calls = {
    authenticate: [],
    customer: [],
    usersCurrent: [],
    usersVisibility: [],
    canOpenDevice: [],
    canOpenUsers: [],
  };
  const value = (answer, seen) =>
    typeof answer === 'function' ? answer(seen) : answer;
  return {
    calls,
    run: () =>
      recheckEventStream({
        auth: {
          async authenticate(cookie, action, correlationId, options) {
            calls.authenticate.push([cookie, action, correlationId, options]);
            if (failure) throw failure;
            return next;
          },
        },
        jobs: {
          async customer(seen) {
            calls.customer.push(seen);
            return jobCustomer;
          },
        },
        cookie: 'sid=abc',
        correlationId: 'correlation-1',
        customerId: CUSTOMER,
        everyJob: false,
        device: null,
        users: users
          ? {
              seesEveryJob: false,
              async current(seen) {
                calls.usersCurrent.push(seen);
                return value(usersCustomer, seen);
              },
              jobVisibility(seen, customerId) {
                calls.usersVisibility.push([seen, customerId]);
                return value(visibility, seen);
              },
            }
          : null,
        canOpenDevice: async (seen) => {
          calls.canOpenDevice.push(seen);
          return value(canOpenDevice, seen);
        },
        canOpenUsers: async (seen) => {
          calls.canOpenUsers.push(seen);
          return value(canOpenUsers, seen);
        },
      }),
  };
}

test('a ping keeps both feeds open while the job feed and the users feed hold', async () => {
  const ping = probe({ users: true });

  const checked = await ping.run();

  assert.equal(checked.allowed, true);
  assert.equal(checked.session.identity.id, ACTOR);
  // The job feed and the open users feed each check the session, and neither slides it.
  assert.deepEqual(ping.calls.authenticate, [
    ['sid=abc', 'identity:read', 'correlation-1', { slide: false }],
    ['sid=abc', 'identity:read', 'correlation-1', { slide: false }],
  ]);
  assert.equal(ping.calls.customer.length, 1);
  assert.equal(ping.calls.usersCurrent.length, 1);
  assert.deepEqual(ping.calls.usersVisibility, [
    [ping.calls.usersCurrent[0], CUSTOMER],
  ]);
  // The device feed is left out, so its open rule runs. The users feed is open, so its open rule
  // does not run.
  assert.equal(ping.calls.canOpenDevice.length, 1);
  assert.deepEqual(ping.calls.canOpenUsers, []);
});

test('a ping closes the stream after a revoke of users:read', async () => {
  const ping = probe({ users: true, usersCustomer: null });

  assert.deepEqual(await ping.run(), { allowed: false, session: null });
  // The protected user sync read denies the revoked caller, as `userFeed` answers it.
  assert.equal(ping.calls.usersCurrent.length, 1);
});

test('a ping closes the stream when the users sync belongs to another customer', async () => {
  assert.deepEqual(
    await probe({
      users: true,
      usersCustomer: { customerId: OTHER },
    }).run(),
    { allowed: false, session: null },
  );
});

test('a ping closes the stream when the job visibility of the users feed changes', async () => {
  assert.deepEqual(await probe({ users: true, visibility: true }).run(), {
    allowed: false,
    session: null,
  });
});

test('a ping closes a job-only stream when the caller can now read users', async () => {
  const ping = probe({ canOpenUsers: true });

  assert.deepEqual(await ping.run(), { allowed: false, session: null });
  // The session of the job feed decides the probe, so the stream reads no second session.
  assert.equal(ping.calls.authenticate.length, 1);
  assert.equal(ping.calls.canOpenUsers.length, 1);
  assert.equal(ping.calls.canOpenUsers[0], ping.calls.customer[0]);
});

test('a ping keeps a job-only stream open while the caller still cannot read users', async () => {
  const ping = probe({ canOpenUsers: false });

  const checked = await ping.run();

  assert.equal(checked.allowed, true);
  assert.equal(ping.calls.canOpenUsers.length, 1);
});

test('a ping closes the stream when the users probe fails', async () => {
  assert.deepEqual(
    await probe({
      canOpenUsers: () => {
        throw new Error('user-store-unavailable');
      },
    }).run(),
    { allowed: false, session: null },
  );
});

/** An SSE response stand-in. */
function sink() {
  const emitter = new EventEmitter();
  const response = {
    chunks: [],
    ended: false,
    writableLength: 0,
    write(chunk) {
      response.chunks.push(chunk);
      return true;
    },
    end() {
      response.ended = true;
    },
    once: (name, listener) => emitter.once(name, listener),
    disconnect: () => emitter.emit('close'),
  };
  return response;
}

const fanoutWith = (listeners) => ({
  async listen(customerId, listener) {
    listeners.push({ customerId, listener });
    return async () => {
      listeners.splice(
        listeners.findIndex((entry) => entry.listener === listener),
        1,
      );
    };
  },
});

const entityListener = {
  channel: entityEventsChannel,
  parse: (message) => {
    try {
      const parsed = entityEventSchema.safeParse(JSON.parse(message));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
};

/** Poll until `done()` holds or two seconds pass. Timers fire late on a loaded runner. */
async function until(done) {
  const deadline = Date.now() + 2_000;
  while (!done() && Date.now() < deadline) await wait(5);
}

const pings = (response) =>
  response.chunks.filter((chunk) => chunk === 'event: ping\ndata: {}\n\n')
    .length;

test('an open users feed stays open across pings and closes when users:read is revoked', async (t) => {
  const listeners = [];
  const response = sink();
  t.after(() => response.disconnect());
  let revoked = false;
  const ping = probe({
    users: true,
    usersCustomer: () => (revoked ? null : { customerId: CUSTOMER }),
  });

  await streamEvents(response, {
    customerId: CUSTOMER,
    fanout: fanoutWith(listeners),
    feeds: [{ listener: entityListener, forward: (event) => ({ event }) }],
    begin: () => undefined,
    recheck: async () => (await ping.run()).allowed,
    pingMs: 10,
  });

  await until(() => pings(response) >= 2);
  assert.ok(pings(response) >= 2, 'A ping that finds no change pings.');
  assert.equal(
    response.ended,
    false,
    'The stream stays open while users:read holds.',
  );

  revoked = true;
  await until(() => response.ended);
  assert.equal(
    response.ended,
    true,
    'A revoke of users:read closes the stream at the next ping.',
  );
  assert.equal(listeners.length, 0, 'The stream leaves its feed.');
});
