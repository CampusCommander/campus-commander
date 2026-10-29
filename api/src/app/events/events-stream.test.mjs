import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import {
  entityEventSchema,
  entityEventsChannel,
  jobEventSchema,
  jobEventsChannel,
} from '@campus/application-contracts';
import { streamEvents } from '../devices/device-events';
import { deviceReadable, recheckEventStream } from './events-stream';

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
 * One ping of the one stream. `device` opens the device feed; `canOpen` answers the probe of a
 * stream that leaves it out. Each answer is a value or a function of the session.
 */
function ping({
  next = session([district('devices:read')]),
  jobCustomer = CUSTOMER,
  device = false,
  deviceCustomer = { customerId: CUSTOMER },
  opened = false,
  visibility = opened,
  canOpen = false,
  failure = null,
} = {}) {
  const calls = {
    authenticate: [],
    customer: [],
    current: [],
    jobVisibility: [],
    canOpen: [],
  };
  const value = (answer, seen) =>
    typeof answer === 'function' ? answer(seen) : answer;
  return {
    calls,
    run: (everyJob = false) =>
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
            return value(jobCustomer, seen);
          },
        },
        cookie: 'sid=abc',
        correlationId: 'correlation-1',
        customerId: CUSTOMER,
        everyJob,
        device: device
          ? {
              seesEveryJob: opened,
              async current(seen) {
                calls.current.push(seen);
                return value(deviceCustomer, seen);
              },
              jobVisibility(seen, customerId) {
                calls.jobVisibility.push([seen, customerId]);
                return value(visibility, seen);
              },
            }
          : null,
        canOpenDevice: async (seen) => {
          calls.canOpen.push(seen);
          return value(canOpen, seen);
        },
      }),
  };
}

test('a ping keeps one stream open while the session and both feeds hold', async () => {
  const probe = ping({ device: true });

  const checked = await probe.run(false);

  assert.equal(checked.allowed, true);
  assert.equal(checked.session.identity.id, ACTOR);
  // The job feed and the open device feed each check the session, and neither slides it.
  assert.deepEqual(probe.calls.authenticate, [
    ['sid=abc', 'identity:read', 'correlation-1', { slide: false }],
    ['sid=abc', 'identity:read', 'correlation-1', { slide: false }],
  ]);
  assert.equal(probe.calls.customer.length, 1);
  assert.equal(probe.calls.current.length, 1);
  assert.deepEqual(probe.calls.jobVisibility, [
    [probe.calls.current[0], CUSTOMER],
  ]);
  // The device feed is open, so the probe of the left-out feed never runs.
  assert.deepEqual(probe.calls.canOpen, []);
});

test('a ping closes the stream when the job feed refuses', async () => {
  const probe = ping({ device: true, jobCustomer: OTHER });

  const checked = await probe.run(false);

  assert.deepEqual(checked, { allowed: false, session: null });
  // The job feed decides first, so the device feed is not read.
  assert.deepEqual(probe.calls.current, []);
  assert.deepEqual(probe.calls.canOpen, []);
});

test('a ping closes the stream when the job visibility of an open device feed changes', async () => {
  const probe = ping({ device: true, visibility: true });

  const checked = await probe.run(false);

  assert.deepEqual(checked, { allowed: false, session: null });
});

test('a ping closes the stream when devices:read was removed from an open device feed', async () => {
  const probe = ping({ device: true, deviceCustomer: null });

  const checked = await probe.run(false);

  assert.deepEqual(checked, { allowed: false, session: null });
});

test('a ping closes a job-only stream when the caller can now read the device feed', async () => {
  const probe = ping({ canOpen: true });

  const checked = await probe.run(false);

  assert.deepEqual(checked, { allowed: false, session: null });
  // The session of the job feed decides the probe, so the stream reads no second session.
  assert.equal(probe.calls.authenticate.length, 1);
  assert.equal(probe.calls.canOpen.length, 1);
  assert.equal(probe.calls.canOpen[0], probe.calls.customer[0]);
});

test('a ping keeps a job-only stream open while the caller still cannot read devices', async () => {
  const probe = ping({ canOpen: false });

  const checked = await probe.run(false);

  assert.equal(checked.allowed, true);
  assert.equal(checked.session.identity.id, ACTOR);
  assert.equal(probe.calls.canOpen.length, 1);
  assert.deepEqual(probe.calls.current, []);
});

test('a ping closes the stream when the session check fails', async () => {
  const checked = await ping({ failure: new Error('session-expired') }).run(
    false,
  );

  assert.deepEqual(checked, { allowed: false, session: null });
});

test('a ping closes the stream when the device probe fails', async () => {
  const checked = await ping({
    canOpen: () => {
      throw new Error('device-store-unavailable');
    },
  }).run(false);

  assert.deepEqual(checked, { allowed: false, session: null });
});

test('the device open rule needs the deployment phase and devices:read for the customer', () => {
  const reader = session([district('devices:read')]);
  assert.equal(deviceReadable(3, reader, CUSTOMER), true);
  // A platform grant covers every customer.
  assert.equal(
    deviceReadable(
      3,
      session([{ action: 'devices:read', scope: { kind: 'platform' } }]),
      CUSTOMER,
    ),
    true,
  );
  // A grant for another customer does not open this customer's device feed.
  assert.equal(deviceReadable(3, reader, OTHER), false);
  assert.equal(
    deviceReadable(3, session([district('jobs:read')]), CUSTOMER),
    false,
  );
  // Authorization applies in phase 3 only, as `authorizeAction` decides it.
  assert.equal(deviceReadable(2, reader, CUSTOMER), false);
  assert.equal(deviceReadable(undefined, reader, CUSTOMER), false);
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

const parseWith = (schema) => (message) => {
  try {
    const parsed = schema.safeParse(JSON.parse(message));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
const entityListener = {
  channel: entityEventsChannel,
  parse: parseWith(entityEventSchema),
};
const jobListener = {
  channel: jobEventsChannel,
  parse: parseWith(jobEventSchema),
};
const batch = {
  type: 'entity-batch',
  jobId: '33333333-3333-4333-8333-333333333333',
  entityType: 'device',
  batch: 0,
  batchCount: 1,
  deviceIds: ['device-1'],
  removedIds: [],
};

/** Poll until `done()` holds or two seconds pass. Timers fire late on a loaded runner. */
async function until(done) {
  const deadline = Date.now() + 2_000;
  while (!done() && Date.now() < deadline) await wait(5);
}

const pings = (response) =>
  response.chunks.filter((chunk) => chunk === 'event: ping\ndata: {}\n\n')
    .length;

test('a job-only stream stays open across pings and closes when devices:read arrives', async (t) => {
  const listeners = [];
  const response = sink();
  t.after(() => response.disconnect());
  let readable = false;
  const probe = ping({ canOpen: () => readable });

  await streamEvents(response, {
    customerId: CUSTOMER,
    fanout: fanoutWith(listeners),
    feeds: [{ listener: jobListener, forward: (event) => ({ event }) }],
    begin: () => undefined,
    recheck: async () => (await probe.run(false)).allowed,
    pingMs: 10,
  });

  await until(() => pings(response) >= 2);
  assert.ok(pings(response) >= 2, 'A ping that finds no change pings.');
  assert.equal(
    response.ended,
    false,
    'The stream stays open while the caller cannot read devices.',
  );

  readable = true;
  await until(() => response.ended);
  assert.equal(
    response.ended,
    true,
    'A grant that opens the device feed closes the stream.',
  );
  assert.equal(listeners.length, 0, 'The stream leaves its feed.');
});

test('one stream carries two feeds and one failed read ends both', async (t) => {
  const listeners = [];
  const response = sink();
  t.after(() => response.disconnect());
  const jobChanged = {
    type: 'job-changed',
    jobId: '33333333-3333-4333-8333-333333333333',
    displayId: 'UPD-006',
    revision: 3,
    requestedBy: ACTOR,
  };

  await streamEvents(response, {
    customerId: CUSTOMER,
    fanout: fanoutWith(listeners),
    begin: () => undefined,
    recheck: async () => true,
    pingMs: 60_000,
    feeds: [
      {
        listener: jobListener,
        forward: (event, failed) => (failed ? null : { event }),
      },
      {
        listener: entityListener,
        forward: (event, failed) => {
          if (failed)
            return {
              event: { type: 'job-finished', failure: null },
              end: true,
            };
          throw new Error('store down');
        },
      },
    ],
  });

  assert.equal(listeners.length, 2);
  assert.equal(
    response.chunks[0],
    'retry: 3000\n\n',
    'The stream starts only after both subscriptions are active.',
  );
  assert.equal(listeners[0].customerId, CUSTOMER);
  assert.equal(listeners[1].customerId, CUSTOMER);
  assert.equal(
    listeners[0].listener.channel(CUSTOMER),
    jobEventsChannel(CUSTOMER),
  );
  assert.equal(
    listeners[1].listener.channel(CUSTOMER),
    entityEventsChannel(CUSTOMER),
  );

  listeners[0].listener.event(jobChanged);
  listeners[1].listener.event(batch);
  await until(() => response.ended);

  assert.deepEqual(
    response.chunks.slice(1).map((chunk) => chunk.split('\n')[0]),
    ['event: job-changed', 'event: job-finished'],
    'The order of arrival decides the order of the frames.',
  );
  assert.equal(response.ended, true);
  assert.equal(listeners.length, 0, 'Both feeds leave the stream.');
});
