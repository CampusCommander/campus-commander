import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import {
  EventFanout,
  MAX_BUFFERED_BYTES,
  frame,
  streamEvents,
} from './device-events.ts';

const batch = (deviceIds = ['d1']) => ({
  type: 'entity-batch',
  jobId: '33333333-3333-4333-8333-333333333333',
  entityType: 'device',
  batch: 0,
  batchCount: 1,
  deviceIds,
  removedIds: [],
});
const ping = 'event: ping\ndata: {}\n\n';

/** Redis subscriber stand-ins. `lost()` reports a dropped connection. */
function subscribers() {
  const opened = [];
  const open = async (lost) => {
    const handlers = new Map();
    const subscriber = {
      calls: [],
      closed: false,
      lost,
      async subscribe(channel, onMessage) {
        subscriber.calls.push(['subscribe', channel]);
        handlers.set(channel, onMessage);
      },
      async unsubscribe(channel) {
        subscriber.calls.push(['unsubscribe', channel]);
        handlers.delete(channel);
      },
      async close() {
        subscriber.closed = true;
      },
      publish(channel, message) {
        handlers.get(channel)?.(message);
      },
    };
    opened.push(subscriber);
    return subscriber;
  };
  return { opened, open };
}

const collector = () => {
  const listener = {
    events: [],
    closed: 0,
    event: (event) => listener.events.push(event),
    close: () => {
      listener.closed += 1;
    },
  };
  return listener;
};

test('one subscriber serves every stream and a channel unsubscribes after its last stream', async () => {
  const { opened, open } = subscribers();
  const fanout = new EventFanout(open);
  const leaveFirst = await fanout.listen('C0123456', collector());
  const leaveSecond = await fanout.listen('C0123456', collector());
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].calls, [['subscribe', 'cc:entity-events:C0123456']]);
  await leaveFirst();
  assert.equal(opened[0].calls.length, 1);
  await leaveSecond();
  assert.deepEqual(opened[0].calls.at(-1), [
    'unsubscribe',
    'cc:entity-events:C0123456',
  ]);
});

test('events reach only their customer and invalid messages are dropped', async () => {
  const { opened, open } = subscribers();
  const fanout = new EventFanout(open);
  const mine = collector();
  const other = collector();
  await fanout.listen('C0123456', mine);
  await fanout.listen('C0999999', other);
  opened[0].publish('cc:entity-events:C0123456', JSON.stringify(batch()));
  opened[0].publish('cc:entity-events:C0123456', '{"type":"entity-batch"}');
  opened[0].publish('cc:entity-events:C0123456', 'not json');
  assert.deepEqual(mine.events, [batch()]);
  assert.deepEqual(other.events, []);
});

test('a lost subscriber closes every stream and the next stream reconnects', async () => {
  const { opened, open } = subscribers();
  const fanout = new EventFanout(open);
  const first = collector();
  await fanout.listen('C0123456', first);
  opened[0].lost();
  assert.equal(first.closed, 1);
  const second = collector();
  await fanout.listen('C0123456', second);
  assert.equal(opened[0].closed, true);
  assert.equal(opened.length, 2);
  opened[0].lost();
  assert.equal(second.closed, 0, 'A late end event from the old connection changes nothing.');
});

test('a failed subscription rejects the stream and the next stream retries', async () => {
  let attempts = 0;
  const fanout = new EventFanout(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('redis down');
    return {
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
      close: async () => undefined,
    };
  });
  await assert.rejects(fanout.listen('C0123456', collector()));
  await fanout.listen('C0123456', collector());
  assert.equal(attempts, 2);
});

test('closing the fanout ends every stream', async () => {
  const { open } = subscribers();
  const fanout = new EventFanout(open);
  const listener = collector();
  await fanout.listen('C0123456', listener);
  await fanout.close();
  assert.equal(listener.closed, 1);
});

/** An SSE response stand-in. */
function sink() {
  const emitter = new EventEmitter();
  const response = {
    chunks: [],
    ended: false,
    began: 0,
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

test('a stream starts after the subscription and sends named events and pings', async () => {
  const listeners = [];
  const response = sink();
  let checks = 0;
  const started = await streamEvents(response, {
    customerId: 'C0123456',
    fanout: fanoutWith(listeners),
    begin: () => {
      response.began += 1;
    },
    recheck: async () => {
      checks += 1;
      return true;
    },
    pingMs: 10,
  });
  assert.equal(started, true);
  assert.equal(response.began, 1);
  assert.equal(listeners[0].customerId, 'C0123456');
  assert.equal(response.chunks[0], 'retry: 3000\n\n');
  listeners[0].listener.event(batch());
  assert.equal(response.chunks[1], frame('entity-batch', batch()));
  assert.equal(frame('ping', {}), ping);
  await wait(35);
  assert.ok(checks >= 2);
  assert.ok(response.chunks.filter((chunk) => chunk === ping).length >= 2);
  response.disconnect();
  assert.equal(listeners.length, 0, 'Leaving unsubscribes.');
});

test('a failed session check ends the stream', async () => {
  const listeners = [];
  const response = sink();
  await streamEvents(response, {
    customerId: 'C0123456',
    fanout: fanoutWith(listeners),
    begin: () => undefined,
    recheck: async () => false,
    pingMs: 10,
  });
  await wait(25);
  assert.equal(response.ended, true);
  assert.equal(listeners.length, 0);
  assert.equal(response.chunks.includes(ping), false);
});

test('a slow browser loses its stream instead of buffering without bound', async () => {
  const listeners = [];
  const response = sink();
  await streamEvents(response, {
    customerId: 'C0123456',
    fanout: fanoutWith(listeners),
    begin: () => undefined,
    recheck: async () => true,
    pingMs: 60_000,
  });
  response.writableLength = MAX_BUFFERED_BYTES + 1;
  listeners[0].listener.event(batch());
  assert.equal(response.ended, true);
  assert.equal(listeners.length, 0);
});

test('a stream whose subscription fails writes nothing', async () => {
  const response = sink();
  const started = await streamEvents(response, {
    customerId: 'C0123456',
    fanout: {
      listen: async () => {
        throw new Error('redis down');
      },
    },
    begin: () => {
      response.began += 1;
    },
    recheck: async () => true,
  });
  assert.equal(started, false);
  assert.equal(response.began, 0);
  assert.deepEqual(response.chunks, []);
});

test('a browser that leaves during the subscription unsubscribes', async () => {
  const response = sink();
  let left = false;
  let release;
  const started = streamEvents(response, {
    customerId: 'C0123456',
    fanout: {
      listen: () =>
        new Promise((resolve) => {
          release = () =>
            resolve(async () => {
              left = true;
            });
        }),
    },
    begin: () => {
      response.began += 1;
    },
    recheck: async () => true,
  });
  response.disconnect();
  release();
  assert.equal(await started, true);
  assert.equal(left, true);
  assert.equal(response.began, 0);
});
