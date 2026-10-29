import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import {
  entityEventsChannel,
  jobEventsChannel,
} from '@campus/application-contracts';
import esbuild from 'esbuild';

/**
 * Node's type stripping does not transform the Nest decorators of the API sources. Compile the
 * `api/src` TypeScript for this test only, as `jobs-cancel-route.test.mjs` does, so the real
 * Events controller and the real exception filter answer these requests.
 */
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.ts') && url.includes('/api/src/')) {
      const file = fileURLToPath(url);
      const { code } = esbuild.transformSync(readFileSync(file, 'utf8'), {
        loader: 'ts',
        format: 'esm',
        target: 'node22',
        tsconfigRaw: {
          compilerOptions: {
            experimentalDecorators: true,
            useDefineForClassFields: false,
          },
        },
        sourcefile: file,
      });
      return { format: 'module', shortCircuit: true, source: code };
    }
    return nextLoad(url, context);
  },
});

const require = createRequire(import.meta.url);
const { Module } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');

const CUSTOMER = 'C0123456';
const OTHER = 'C0999999';
const ACTOR = '44444444-4444-4444-8444-444444444444';
const REQUESTER = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';

/** The sync state of the customer. Its times sit next to the test clock. */
const syncState = (customerId = CUSTOMER) => {
  const now = Date.now();
  return {
    customerId,
    generation: 1,
    status: 'ready',
    observedAt: new Date(now - 60_000).toISOString(),
    deviceCount: 10,
    failure: null,
    telemetryFailure: null,
    startedAt: new Date(now - 120_000).toISOString(),
    checkedAt: new Date(now - 60_000).toISOString(),
    stale: false,
  };
};

const jobChanged = {
  type: 'job-changed',
  jobId: JOB_ID,
  displayId: 'UPD-006',
  revision: 3,
  requestedBy: ACTOR,
};

const entityBatch = {
  type: 'entity-batch',
  jobId: JOB_ID,
  entityType: 'device',
  batch: 0,
  batchCount: 1,
  deviceIds: ['device-1'],
  removedIds: [],
};

const finishedJob = {
  type: 'job-finished',
  job: {
    jobId: JOB_ID,
    customerId: CUSTOMER,
    entityType: 'device',
    batchCount: 1,
    completedBatches: 0,
    failedBatches: 1,
    failure: 'quota',
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    finishedAt: new Date(Date.now() - 60_000).toISOString(),
  },
};

/** A database whose answers match a needle of the statement text. Every call is recorded. */
function database(routes) {
  const calls = [];
  return {
    calls,
    connection: {
      async query(text, values = []) {
        calls.push([text, values]);
        for (const [needle, answer] of routes) {
          if (text.includes(needle))
            return {
              rows:
                typeof answer === 'function' ? answer(values, text) : answer,
            };
        }
        throw new Error(`Unexpected statement: ${text}`);
      },
    },
  };
}

const session = (actions) => ({
  identity: {
    id: ACTOR,
    displayName: 'Grace Hopper',
    permissions: ['identity:read'],
    permissionVersion: 1,
    grants: actions.map((action) => ({
      action,
      scope: { kind: 'district', customerId: CUSTOMER },
    })),
    preferences: { theme: 'system', navigationCollapsed: false },
  },
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  csrfToken: 'a'.repeat(64),
});

/**
 * The one subscriber connection of the API instance. It answers the channel of each listener, as
 * `EventFanout.listen` does, and parses one published message with that channel's schema.
 */
const fanout = {
  feeds: [],
  listen(customerId, listener) {
    const feed = {
      customerId,
      listener,
      channel: listener.channel(customerId),
    };
    fanout.feeds.push(feed);
    return Promise.resolve(async () => {
      const index = fanout.feeds.indexOf(feed);
      if (index >= 0) fanout.feeds.splice(index, 1);
    });
  },
  /** Publish one channel message. A message outside the schema reaches no listener. */
  publish(channel, event) {
    for (const feed of [...fanout.feeds])
      if (feed.channel === channel) {
        const parsed = feed.listener.parse(JSON.stringify(event));
        if (parsed !== null) feed.listener.event(parsed);
      }
  },
};

let app;
let origin;
/** The signed-in caller of the next request. */
let currentSession;
/** The database behind the production services. */
let activeDb;
/** The audit rows that the production authorization wrote. */
let auditEvents;
/** The authorization decisions of the production rule. */
let authorizeCalls;
/** Every open response, so a failed assertion cannot hold the process open. */
const openStreams = [];

before(async () => {
  const [
    eventsControllerModule,
    jobsControllerModule,
    securityModule,
    guardModule,
    jobsServiceModule,
    devicesServiceModule,
    authModule,
    authzModule,
    eventsModule,
    orchestrationModule,
  ] = await Promise.all([
    import('./events.controller.ts'),
    import('../jobs/jobs.controller.ts'),
    import('../security.ts'),
    import('../auth/auth.guard.ts'),
    import('../jobs/jobs.service.ts'),
    import('../devices/devices.service.ts'),
    import('../auth/auth.service.ts'),
    import('../auth/authorize-action.ts'),
    import('../devices/device-events.service.ts'),
    import('../orchestration/orchestration.service.ts'),
  ]);
  const { EventsController } = eventsControllerModule;
  const { JobsController } = jobsControllerModule;
  const { ApplicationExceptionFilter, securityHeaders } = securityModule;
  const { AuthGuard } = guardModule;
  const { JobsService } = jobsServiceModule;
  const { DevicesService } = devicesServiceModule;
  const { AuthService } = authModule;
  const { authorizeAction } = authzModule;
  const { DeviceEventsService } = eventsModule;
  const { OrchestrationService } = orchestrationModule;

  // The real ConfigurationService reads the deployment file, which a unit test does not have.
  // The harness names the phase-3 configuration that the route reads its deployment phase from.
  class TestConfiguration {}
  const configuration = { deployment: { phase: 3 } };

  // esbuild does not emit decorator metadata, so the harness names the constructor tokens.
  Reflect.defineMetadata(
    'design:paramtypes',
    [
      JobsService,
      DevicesService,
      AuthService,
      DeviceEventsService,
      TestConfiguration,
    ],
    EventsController,
  );
  Reflect.defineMetadata(
    'design:paramtypes',
    [JobsService, AuthService, DeviceEventsService, OrchestrationService],
    JobsController,
  );

  const store = {
    connection: {
      query: (text, values) => activeDb.connection.query(text, values),
    },
  };
  // The production services decide. Each test names the rows that PostgreSQL answers.
  const jobs = new JobsService(store);
  const devices = new DevicesService(store, {}, {});

  class EventRoutesModule {}
  Module({
    controllers: [EventsController, JobsController],
    providers: [
      { provide: JobsService, useValue: jobs },
      { provide: DevicesService, useValue: devices },
      {
        // The session and the audit store are test doubles. The permission decision,
        // `authorizeAction`, is the real rule.
        provide: AuthService,
        useValue: {
          authorize: (value, action, resource, correlationId) => {
            authorizeCalls.push([action, resource]);
            return authorizeAction(
              {
                phase: 3,
                audit: async (...entry) => auditEvents.push(entry),
              },
              value,
              action,
              resource,
              correlationId,
            );
          },
        },
      },
      { provide: DeviceEventsService, useValue: { fanout } },
      {
        provide: OrchestrationService,
        useValue: { startDeviceUpdateReconcile: async () => 'execution' },
      },
      { provide: TestConfiguration, useValue: configuration },
    ],
  })(EventRoutesModule);

  const moduleRef = await Test.createTestingModule({
    imports: [EventRoutesModule],
  })
    .overrideGuard(AuthGuard)
    .useValue({
      canActivate: (context) => {
        context.switchToHttp().getRequest().session = currentSession;
        return true;
      },
    })
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.use(securityHeaders);
  app.useGlobalFilters(new ApplicationExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  for (const stream of openStreams.splice(0)) stream.close();
  app?.getHttpServer().closeAllConnections?.();
  await app?.close();
});

/**
 * Open one event stream and parse its frames. The pump reads the body as it arrives, so a test
 * awaits the next frame instead of the end of a stream that stays open.
 */
async function open(path) {
  const response = await fetch(`${origin}${path}`, {
    headers: { accept: 'text/event-stream' },
  });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = '';
  let ended = reader === undefined;
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end < 0) break;
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
          const data = /^data: (.+)$/m.exec(block)?.[1];
          // The `retry` frame carries no data and is not an event.
          if (data !== undefined) frames.push({ type, data: JSON.parse(data) });
        }
      }
    } catch {
      // A cancelled reader ends the stream too.
    } finally {
      ended = true;
    }
  })();
  const stream = {
    status: response.status,
    contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
    frames,
    get ended() {
      return ended;
    },
    /** The next frame, or null when the body ended. */
    async next(ms = 3000) {
      const limit = Date.now() + ms;
      while (!frames.length) {
        if (ended) return null;
        if (Date.now() > limit) throw new Error('The stream sent no frame.');
        await wait(10);
      }
      return frames.shift();
    },
    /** True once the body ends, within `ms`. */
    async end(ms = 3000) {
      const limit = Date.now() + ms;
      while (!ended && Date.now() < limit) await wait(10);
      return ended;
    },
    close() {
      void reader?.cancel().catch(() => undefined);
      void pump.catch(() => undefined);
    },
  };
  openStreams.push(stream);
  return stream;
}

/** One plain answer, for a route that refuses the stream before it starts. */
async function answer(path) {
  const response = await fetch(`${origin}${path}`, {
    headers: { accept: 'text/event-stream' },
  });
  return { status: response.status, body: await response.json() };
}

/** Name one test's caller, rows, and audit store. */
function arrange(db, actions) {
  activeDb = db;
  currentSession = session(actions);
  auditEvents = [];
  authorizeCalls = [];
  fanout.feeds.splice(0);
}

test('one stream carries the job feed and the device feed of a caller with devices:read', async () => {
  const db = database([
    ['cc.job_reader', [{ customer_id: CUSTOMER }]],
    ['cc.read_device_sync', [{ result: syncState() }]],
    ['cc.job_visible', [{ visible: true }]],
  ]);
  arrange(db, ['jobs:read', 'devices:read']);

  const stream = await open('/api/events');

  assert.equal(stream.status, 200);
  assert.equal(stream.contentType, 'text/event-stream; charset=utf-8');
  assert.equal(stream.cacheControl, 'no-store');
  // Both feeds of the customer are subscribed before the stream writes its first byte.
  assert.deepEqual(
    fanout.feeds.map((feed) => feed.channel),
    [jobEventsChannel(CUSTOMER), entityEventsChannel(CUSTOMER)],
  );
  // The device feed opens under devices:read for the customer of the job feed.
  assert.deepEqual(authorizeCalls, [
    ['devices:read', { kind: 'district', customerId: CUSTOMER }],
  ]);

  fanout.publish(jobEventsChannel(CUSTOMER), jobChanged);
  assert.deepEqual(await stream.next(), {
    type: 'job-changed',
    data: jobChanged,
  });

  fanout.publish(entityEventsChannel(CUSTOMER), entityBatch);
  assert.deepEqual(await stream.next(), {
    type: 'entity-batch',
    data: {
      type: 'entity-batch',
      entityType: 'device',
      deviceIds: ['device-1'],
      removedIds: [],
    },
  });

  fanout.publish(entityEventsChannel(CUSTOMER), finishedJob);
  assert.deepEqual(await stream.next(), {
    type: 'job-finished',
    data: { type: 'job-finished', failure: 'quota' },
  });

  const sync = syncState();
  fanout.publish(entityEventsChannel(CUSTOMER), { type: 'full-sync', sync });
  assert.deepEqual(await stream.next(), {
    type: 'full-sync',
    data: { type: 'full-sync', sync },
  });
});

test('a caller without devices:read receives the job feed alone and the stream stays open', async () => {
  const db = database([
    ['cc.job_reader', [{ customer_id: CUSTOMER }]],
    ['cc.read_device_sync', [{ result: syncState() }]],
  ]);
  arrange(db, ['jobs:read']);

  const stream = await open('/api/events');

  assert.equal(stream.status, 200);
  // Only the job channel is subscribed.
  assert.deepEqual(
    fanout.feeds.map((feed) => feed.channel),
    [jobEventsChannel(CUSTOMER)],
  );
  // The refused device open writes one access-denied row, as the Devices stream does.
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0][0], 'access-denied');
  assert.deepEqual(auditEvents[0].slice(2), [ACTOR, 'devices:read']);

  // An entity event reaches no caller on this stream. The job event after it still arrives.
  fanout.publish(entityEventsChannel(CUSTOMER), entityBatch);
  fanout.publish(jobEventsChannel(CUSTOMER), jobChanged);
  assert.deepEqual(await stream.next(), {
    type: 'job-changed',
    data: jobChanged,
  });
  assert.equal(stream.ended, false, 'The job-only stream stays open.');
});

test('a customer without a sync receives the job feed alone', async () => {
  const db = database([
    ['cc.job_reader', [{ customer_id: CUSTOMER }]],
    ['cc.read_device_sync', [{ result: null }]],
  ]);
  arrange(db, ['jobs:read', 'devices:read']);

  const stream = await open('/api/events');

  assert.equal(stream.status, 200);
  assert.deepEqual(
    fanout.feeds.map((feed) => feed.channel),
    [jobEventsChannel(CUSTOMER)],
  );
  // No sync is no device feed, and no refusal of devices:read either.
  assert.deepEqual(authorizeCalls, []);
  assert.deepEqual(auditEvents, []);

  fanout.publish(entityEventsChannel(CUSTOMER), entityBatch);
  fanout.publish(jobEventsChannel(CUSTOMER), jobChanged);
  assert.deepEqual(await stream.next(), {
    type: 'job-changed',
    data: jobChanged,
  });
  assert.equal(stream.ended, false, 'The job-only stream stays open.');
});

test('a sync of another customer leaves the device feed out', async () => {
  const db = database([
    ['cc.job_reader', [{ customer_id: CUSTOMER }]],
    ['cc.read_device_sync', [{ result: syncState(OTHER) }]],
  ]);
  arrange(db, ['jobs:read', 'devices:read']);

  const stream = await open('/api/events');

  assert.equal(stream.status, 200);
  // The stream never reads the entity channel of another customer.
  assert.deepEqual(
    fanout.feeds.map((feed) => feed.channel),
    [jobEventsChannel(CUSTOMER)],
  );
  assert.deepEqual(authorizeCalls, []);
});

test('a caller that the Jobs stream refuses receives the same refusal', async () => {
  const db = database([['cc.job_reader', []]]);
  arrange(db, ['jobs:read', 'devices:read']);

  const refused = await answer('/api/events');

  assert.equal(refused.status, 503);
  assert.deepEqual(refused.body, { reason: 'connection-required' });
  assert.deepEqual(refused, await answer('/api/jobs/events'));
  assert.deepEqual(fanout.feeds, [], 'A refused stream subscribes nothing.');
});

test('a failed device read sends its final event and ends the stream', async () => {
  const db = database([
    ['cc.job_reader', [{ customer_id: CUSTOMER }]],
    ['cc.read_device_sync', [{ result: syncState() }]],
    [
      'FROM cc.jobs j WHERE j.customer_id',
      () => {
        throw new Error('store down');
      },
    ],
  ]);
  // The caller reads devices and no jobs, so the failure of a finished job needs a read.
  arrange(db, ['devices:read']);

  const stream = await open('/api/events');
  assert.equal(stream.status, 200);

  fanout.publish(entityEventsChannel(CUSTOMER), finishedJob);

  assert.deepEqual(await stream.next(), {
    type: 'job-finished',
    data: { type: 'job-finished', failure: null },
  });
  assert.equal(await stream.end(), true, 'The failed read ends the stream.');
  assert.deepEqual(fanout.feeds, [], 'Both feeds leave the stream.');
});
