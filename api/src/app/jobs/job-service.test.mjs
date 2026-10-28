import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceResponseError } from '../configuration/service-http.ts';
import {
  HOLD_WRITE_DEADLINE_MS,
  JOB_HOLD_SECONDS,
  JobService,
  jobHoldKey,
} from './job-service.ts';

const CUSTOMER = 'C0123456';
const JOB = '11111111-1111-4111-8111-111111111111';
const OTHER_JOB = '22222222-2222-4222-8222-222222222222';
const TOKEN = '33333333-3333-4333-8333-333333333333';
const CORRELATION = '44444444-4444-4444-8444-444444444444';
const LEASE = '66666666-6666-4666-8666-666666666666';
const REQUESTER = '55555555-5555-4555-8555-555555555555';
const DISPLAY = 'UPD-006';

/** A database that answers one programmed result for each statement it matches. */
const databaseOf = (routes) => {
  const calls = [];
  return {
    calls,
    connection: {
      query: async (text, values = []) => {
        calls.push({ text, values });
        for (const [matches, answer] of routes) {
          if (text.includes(matches)) {
            const rows = await answer(values, text);
            return { rows: rows ?? [] };
          }
        }
        throw new Error(`Unexpected statement: ${text}`);
      },
    },
  };
};

const cacheOf = (overrides = {}) => {
  const calls = [];
  const record =
    (name) =>
    async (...values) => {
      calls.push({ name, values });
      return 1;
    };
  return {
    calls,
    get: overrides.get ?? (async () => null),
    set: overrides.set ?? record('set'),
    release: overrides.release ?? record('release'),
    publish: overrides.publish ?? record('publish'),
    increment: overrides.increment ?? record('increment'),
  };
};

const orchestrationOf = (overrides = {}) => {
  const calls = [];
  return {
    calls,
    startDeviceUpdate: async (input) => {
      calls.push({ name: 'startDeviceUpdate', input });
      if (overrides.startDeviceUpdate)
        return overrides.startDeviceUpdate(input);
      return 'execution-1';
    },
    startDeviceUpdateReconcile: async (input) => {
      calls.push({ name: 'startDeviceUpdateReconcile', input });
      if (overrides.startDeviceUpdateReconcile)
        return overrides.startDeviceUpdateReconcile(input);
      return 'execution-2';
    },
    startDeviceCommandPoll: async (input) => {
      calls.push({ name: 'startDeviceCommandPoll', input });
      if (overrides.startDeviceCommandPoll)
        return overrides.startDeviceCommandPoll(input);
      return 'poll-execution-1';
    },
  };
};

const admitted = (overrides = {}) => ({
  jobId: JOB,
  displayId: DISPLAY,
  dispatchToken: TOKEN,
  correlationId: CORRELATION,
  targetCount: 1,
  ...overrides,
});

const serviceOf = ({ database, cache, orchestration, clock }) =>
  new JobService({
    database,
    cache,
    orchestration,
    clock: clock ?? (() => 0),
  });

const admissionDatabase = ({ heldAnswer = null, publications = [] } = {}) =>
  databaseOf([
    ['SELECT COALESCE(max(publication_id),0)', () => [{ value: '0' }]],
    [
      'SELECT cc.admit_device_update_job',
      (values) => (values[1] === true ? [] : [{ result: admitted() }]),
    ],
    [
      'SELECT batch_count FROM cc.device_update_jobs',
      () => [{ batch_count: 1 }],
    ],
    ['SELECT p.publication_id,p.job_id', () => publications],
    ['SELECT cc.record_device_update_start', () => [{ result: null }]],
    ['SELECT cc.abandon_device_update_start', () => [{ result: null }]],
    ['SELECT cc.complete_job_publications', () => [{ result: 1 }]],
    [
      'SELECT cc.accept_device_update_hold',
      () => (heldAnswer ? [{ result: heldAnswer }] : []),
    ],
  ]);

test('an admission starts device_update and records the execution with the same token', async () => {
  const database = admissionDatabase();
  const cache = cacheOf();
  const orchestration = orchestrationOf();
  const service = serviceOf({ database, cache, orchestration });
  assert.equal(await service.admit(CUSTOMER), false);
  assert.deepEqual(orchestration.calls[0], {
    name: 'startDeviceUpdate',
    input: {
      customerId: CUSTOMER,
      jobId: JOB,
      dispatchToken: TOKEN,
      batchCount: 1,
      correlationId: CORRELATION,
    },
  });
  const recorded = database.calls.find((call) =>
    call.text.includes('cc.record_device_update_start'),
  );
  assert.deepEqual(recorded.values, [CUSTOMER, JOB, TOKEN, 'execution-1']);
});

test('a 4xx start runs the refused start and publishes its row at once', async () => {
  const rows = [
    {
      publication_id: '7',
      job_id: JOB,
      display_id: DISPLAY,
      revision: '4',
      requested_by: REQUESTER,
    },
  ];
  // The admission call commits no row here. The refused start commits the published row.
  const database = admissionDatabase();
  const originalQuery = database.connection.query.bind(database.connection);
  let reads = 0;
  database.connection.query = (text, values = []) => {
    if (text.includes('SELECT p.publication_id,p.job_id')) {
      reads += 1;
      return Promise.resolve({ rows: reads > 1 ? rows : [] });
    }
    return originalQuery(text, values);
  };
  const cache = cacheOf();
  const orchestration = orchestrationOf({
    startDeviceUpdate: () => {
      throw new ServiceResponseError(400);
    },
  });
  const service = serviceOf({ database, cache, orchestration });
  assert.equal(await service.admit(CUSTOMER), true);
  assert.ok(
    database.calls.some((call) =>
      call.text.includes('cc.abandon_device_update_start'),
    ),
  );
  const published = cache.calls.filter((call) => call.name === 'publish');
  assert.equal(published.length, 1);
  assert.deepEqual(JSON.parse(published[0].values[1]), {
    type: 'job-changed',
    jobId: JOB,
    displayId: DISPLAY,
    revision: 4,
    requestedBy: REQUESTER,
  });
  assert.ok(
    database.calls.some((call) =>
      call.text.includes('cc.complete_job_publications'),
    ),
  );
});

for (const [label, failure] of [
  ['a 5xx answer', new ServiceResponseError(503)],
  ['a timeout', new Error('timed out')],
]) {
  test(`${label} changes nothing at once`, async () => {
    const database = admissionDatabase();
    const cache = cacheOf();
    const orchestration = orchestrationOf({
      startDeviceUpdate: () => {
        throw failure;
      },
    });
    const service = serviceOf({ database, cache, orchestration });
    assert.equal(await service.admit(CUSTOMER), false);
    assert.ok(
      !database.calls.some((call) =>
        call.text.includes('cc.abandon_device_update_start'),
      ),
    );
    assert.ok(
      !database.calls.some((call) =>
        call.text.includes('cc.record_device_update_start'),
      ),
    );
  });
}

test('a Redis error on the hold read admits nothing, and the next call admits the job', async () => {
  const database = admissionDatabase();
  let fail = true;
  const cache = cacheOf({
    get: async (key) => {
      if (fail) throw new Error('redis unavailable');
      return null;
    },
  });
  const orchestration = orchestrationOf();
  const service = serviceOf({ database, cache, orchestration });
  assert.equal(await service.admit(CUSTOMER), false);
  assert.equal(orchestration.calls.length, 0);
  fail = false;
  assert.equal(await service.admit(CUSTOMER), false);
  assert.equal(orchestration.calls.length, 1);
});

test('the hold write uses SET with EX 300 and no NX or XX', async () => {
  const database = admissionDatabase({
    heldAnswer: { jobId: JOB, displayId: DISPLAY },
  });
  const cache = cacheOf();
  const service = serviceOf({
    database,
    cache,
    orchestration: orchestrationOf(),
    clock: () => 0,
  });
  assert.equal(await service.applyHold(CUSTOMER), true);
  assert.deepEqual(cache.calls, [
    {
      name: 'set',
      values: [jobHoldKey(CUSTOMER), JOB, JOB_HOLD_SECONDS],
    },
  ]);
});

test('an apply that stalls beyond five seconds skips the SET and keeps the registry entry', async () => {
  const database = admissionDatabase({
    heldAnswer: { jobId: JOB, displayId: DISPLAY },
  });
  const cache = cacheOf();
  const ticks = [0, HOLD_WRITE_DEADLINE_MS + 1];
  const service = serviceOf({
    database,
    cache,
    orchestration: orchestrationOf(),
    clock: () => ticks.shift() ?? 0,
  });
  assert.equal(await service.applyHold(CUSTOMER), true);
  assert.ok(!cache.calls.some((call) => call.name === 'set'));
});

test('cleanup deletes through the compare-and-delete script and marks the registry entry', async () => {
  const database = databaseOf([
    [
      'SELECT j.job_id FROM cc.jobs j JOIN cc.device_update_jobs u',
      () => [{ job_id: JOB }],
    ],
    ['SELECT cc.clean_device_update_hold', () => [{ result: true }]],
  ]);
  const cache = cacheOf();
  const service = serviceOf({
    database,
    cache,
    orchestration: orchestrationOf(),
  });
  assert.equal(await service.cleanup(CUSTOMER), 1);
  assert.deepEqual(cache.calls, [
    { name: 'release', values: [jobHoldKey(CUSTOMER), JOB] },
  ]);
  assert.ok(
    database.calls.some((call) =>
      call.text.includes('cc.clean_device_update_hold'),
    ),
  );
});

test('a Redis error during cleanup keeps the registry entry for the next run', async () => {
  const database = databaseOf([
    [
      'SELECT j.job_id FROM cc.jobs j JOIN cc.device_update_jobs u',
      () => [{ job_id: JOB }],
    ],
  ]);
  const cache = cacheOf({
    release: async () => {
      throw new Error('redis unavailable');
    },
  });
  const service = serviceOf({
    database,
    cache,
    orchestration: orchestrationOf(),
  });
  assert.equal(await service.cleanup(CUSTOMER), 0);
  assert.ok(
    !database.calls.some((call) =>
      call.text.includes('cc.clean_device_update_hold'),
    ),
  );
});

test('recovery starts each element with its new token and starts one reconcile flow for all', async () => {
  const database = databaseOf([
    ['SELECT COALESCE(max(publication_id),0)', () => [{ value: '0' }]],
    [
      'SELECT cc.recover_device_update_jobs',
      () => [
        {
          result: {
            starts: [admitted({ dispatchToken: TOKEN })],
            reconciles: [OTHER_JOB],
          },
        },
      ],
    ],
    [
      'SELECT batch_count FROM cc.device_update_jobs',
      () => [{ batch_count: 2 }],
    ],
    ['SELECT cc.record_device_update_start', () => [{ result: null }]],
    ['SELECT p.publication_id', () => []],
    ['SELECT cc.complete_job_publications', () => [{ result: 0 }]],
  ]);
  const orchestration = orchestrationOf();
  const service = serviceOf({
    database,
    cache: cacheOf(),
    orchestration,
  });
  assert.equal(await service.recover(CUSTOMER), true);
  assert.deepEqual(orchestration.calls[0], {
    name: 'startDeviceUpdate',
    input: {
      customerId: CUSTOMER,
      jobId: JOB,
      dispatchToken: TOKEN,
      batchCount: 2,
      correlationId: CORRELATION,
    },
  });
  const reconcile = orchestration.calls[1];
  assert.equal(reconcile.name, 'startDeviceUpdateReconcile');
  assert.equal(reconcile.input.operationNumber, 'all');
  assert.equal('verifyAttempt' in reconcile.input, false);
  assert.equal(reconcile.input.jobId, OTHER_JOB);
});

test('a failed publication after admission leaves the row for the relay and still starts the job', async () => {
  const row = {
    publication_id: '7',
    job_id: JOB,
    display_id: DISPLAY,
    revision: '4',
    requested_by: REQUESTER,
  };
  const database = admissionDatabase({ publications: [row] });
  const cache = cacheOf({
    publish: async () => {
      throw new Error('redis unavailable');
    },
  });
  const orchestration = orchestrationOf();
  const service = serviceOf({ database, cache, orchestration });
  assert.equal(await service.admit(CUSTOMER), false);
  assert.equal(orchestration.calls.length, 1);
  assert.equal(orchestration.calls[0].name, 'startDeviceUpdate');
  // The publisher failed, so the row stays for the relay.
  assert.ok(
    !database.calls.some((call) =>
      call.text.includes('cc.complete_job_publications'),
    ),
  );
});

test('a failed publication after a refused start still reports the refusal', async () => {
  const database = admissionDatabase();
  const originalQuery = database.connection.query.bind(database.connection);
  let reads = 0;
  database.connection.query = (text, values = []) => {
    if (text.includes('SELECT p.publication_id,p.job_id')) {
      reads += 1;
      return Promise.resolve({
        rows: reads > 1 ? [{ publication_id: '7' }] : [],
      });
    }
    return originalQuery(text, values);
  };
  const cache = cacheOf({
    publish: async () => {
      throw new Error('redis unavailable');
    },
  });
  const orchestration = orchestrationOf({
    startDeviceUpdate: () => {
      throw new ServiceResponseError(400);
    },
  });
  const service = serviceOf({ database, cache, orchestration });
  assert.equal(await service.admit(CUSTOMER), true);
  assert.ok(
    database.calls.some((call) =>
      call.text.includes('cc.abandon_device_update_start'),
    ),
  );
  assert.ok(
    !database.calls.some((call) =>
      call.text.includes('cc.complete_job_publications'),
    ),
  );
});

test('a failed publication after a reaper run still starts the reconcile flow for all', async () => {
  const database = databaseOf([
    ['SELECT COALESCE(max(publication_id),0)', () => [{ value: '0' }]],
    [
      'SELECT cc.recover_device_update_jobs',
      () => [{ result: { starts: [], reconciles: [OTHER_JOB] } }],
    ],
    [
      'SELECT p.publication_id,p.job_id',
      () => [
        {
          publication_id: '9',
          job_id: OTHER_JOB,
          display_id: DISPLAY,
          revision: '5',
          requested_by: REQUESTER,
        },
      ],
    ],
  ]);
  const cache = cacheOf({
    publish: async () => {
      throw new Error('redis unavailable');
    },
  });
  const orchestration = orchestrationOf();
  const service = serviceOf({ database, cache, orchestration });
  assert.equal(await service.recover(CUSTOMER), true);
  const reconcile = orchestration.calls.find(
    (call) => call.name === 'startDeviceUpdateReconcile',
  );
  assert.ok(reconcile, 'The reaper started the reconcile flow.');
  assert.equal(reconcile.input.jobId, OTHER_JOB);
  assert.equal(reconcile.input.operationNumber, 'all');
  assert.equal('verifyAttempt' in reconcile.input, false);
  assert.equal(
    orchestration.calls.filter(
      (call) => call.name === 'startDeviceUpdateReconcile',
    ).length,
    1,
  );
  assert.ok(
    !database.calls.some((call) =>
      call.text.includes('cc.complete_job_publications'),
    ),
  );
});

test('a failed reconcile start after a reaper run is not retried', async () => {
  const database = databaseOf([
    ['SELECT COALESCE(max(publication_id),0)', () => [{ value: '0' }]],
    [
      'SELECT cc.recover_device_update_jobs',
      () => [{ result: { starts: [], reconciles: [OTHER_JOB] } }],
    ],
    ['SELECT p.publication_id', () => []],
  ]);
  const orchestration = orchestrationOf({
    startDeviceUpdateReconcile: () => {
      throw new Error('kestra unavailable');
    },
  });
  const service = serviceOf({
    database,
    cache: cacheOf(),
    orchestration,
  });
  assert.equal(await service.recover(CUSTOMER), true);
  assert.equal(
    orchestration.calls.filter(
      (call) => call.name === 'startDeviceUpdateReconcile',
    ).length,
    1,
  );
});

const relayDatabase = (elements) =>
  databaseOf([
    [
      'SELECT DISTINCT customer_id FROM cc.job_publications',
      () => [{ customer_id: CUSTOMER }],
    ],
    ['SELECT cc.read_job_publications', () => [{ result: elements }]],
    ['SELECT cc.complete_job_publications', () => [{ result: 1 }]],
  ]);

const element = (overrides = {}) => ({
  publicationId: 1,
  jobId: JOB,
  displayId: DISPLAY,
  requestedBy: REQUESTER,
  revision: 3,
  statusChanged: false,
  deviceIds: [],
  removedIds: [],
  batch: null,
  batchCount: null,
  ...overrides,
});

test('the relay increments once per row with devices and publishes one job-changed per job', async () => {
  const database = relayDatabase([
    element({ publicationId: 1 }),
    element({ publicationId: 2 }),
    element({
      publicationId: 3,
      deviceIds: ['device-1'],
      removedIds: ['device-2'],
      batch: 0,
      batchCount: 2,
    }),
  ]);
  const cache = cacheOf();
  const service = serviceOf({
    database,
    cache,
    orchestration: orchestrationOf(),
  });
  assert.equal(await service.relay(), true);
  assert.deepEqual(
    cache.calls
      .filter((call) => call.name === 'increment')
      .map((call) => call.values),
    [[`cc:query-gen:device:${CUSTOMER}`]],
  );
  const published = cache.calls
    .filter((call) => call.name === 'publish')
    .map((call) => [call.values[0], JSON.parse(call.values[1])]);
  assert.equal(published.length, 2);
  const entity = published.find(([channel]) =>
    channel.includes('entity-events'),
  );
  assert.deepEqual(entity[1], {
    type: 'entity-batch',
    jobId: JOB,
    entityType: 'device',
    batch: 0,
    batchCount: 2,
    deviceIds: ['device-1'],
    removedIds: ['device-2'],
  });
  const job = published.find(([channel]) => channel.includes('job-events'));
  assert.deepEqual(job[1], {
    type: 'job-changed',
    jobId: JOB,
    displayId: DISPLAY,
    revision: 3,
    requestedBy: REQUESTER,
  });
  const completed = database.calls.find((call) =>
    call.text.includes('cc.complete_job_publications'),
  );
  assert.deepEqual(JSON.parse(completed.values[1]), [1, 2, 3]);
});

test('a Redis failure keeps the relay rows for the next run', async () => {
  const database = relayDatabase([element({ revision: 3 })]);
  const cache = cacheOf({
    publish: async () => {
      throw new Error('redis unavailable');
    },
  });
  const service = serviceOf({
    database,
    cache,
    orchestration: orchestrationOf(),
  });
  await service.relay();
  assert.ok(
    !database.calls.some((call) =>
      call.text.includes('cc.complete_job_publications'),
    ),
  );
});

test('an unavailable database makes the relay wait for the next run', async () => {
  const database = {
    calls: [],
    connection: {
      query: async () => {
        throw new Error('database unavailable');
      },
    },
  };
  const service = serviceOf({
    database,
    cache: cacheOf(),
    orchestration: orchestrationOf(),
  });
  assert.equal(await service.relay(), true);
});

test('one relay run executes at a time', async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const database = databaseOf([
    [
      'SELECT DISTINCT customer_id FROM cc.job_publications',
      async () => {
        await blocked;
        return [];
      },
    ],
  ]);
  const service = serviceOf({
    database,
    cache: cacheOf(),
    orchestration: orchestrationOf(),
  });
  const first = service.relay();
  assert.equal(await service.relay(), false);
  release();
  assert.equal(await first, true);
});

test('a terminal job-changed runs cleanup and admission, and another status runs neither', async () => {
  const database = databaseOf([
    ['SELECT 1 FROM cc.jobs j WHERE', () => [{ '?column?': 1 }]],
    [
      'SELECT j.job_id FROM cc.jobs j JOIN cc.device_update_jobs u',
      () => [{ job_id: JOB }],
    ],
    ['SELECT cc.clean_device_update_hold', () => [{ result: true }]],
    ['SELECT COALESCE(max(publication_id),0)', () => [{ value: '0' }]],
    ['SELECT cc.admit_device_update_job', () => [{ result: admitted() }]],
    [
      'SELECT batch_count FROM cc.device_update_jobs',
      () => [{ batch_count: 1 }],
    ],
    ['SELECT p.publication_id,p.job_id', () => []],
    ['SELECT cc.record_device_update_start', () => [{ result: null }]],
  ]);
  const cache = cacheOf();
  const orchestration = orchestrationOf();
  const service = serviceOf({ database, cache, orchestration });
  await service.changed(CUSTOMER, JOB);
  assert.deepEqual(
    cache.calls.map((call) => call.name),
    ['release'],
  );
  assert.equal(cache.calls[0].values[1], JOB);
  assert.ok(
    database.calls.some((call) =>
      call.text.includes('cc.clean_device_update_hold'),
    ),
  );
  assert.ok(
    database.calls.some((call) =>
      call.text.includes('cc.admit_device_update_job'),
    ),
  );
  assert.equal(orchestration.calls.length, 1);

  // A job that is not terminal changes nothing.
  const idle = databaseOf([['SELECT 1 FROM cc.jobs j WHERE', () => []]]);
  const idleCache = cacheOf();
  const idleOrchestration = orchestrationOf();
  await serviceOf({
    database: idle,
    cache: idleCache,
    orchestration: idleOrchestration,
  }).changed(CUSTOMER, JOB);
  assert.equal(idle.calls.length, 1);
  assert.deepEqual(idleCache.calls, []);
  assert.deepEqual(idleOrchestration.calls, []);
});

test('an awaiting-devices command job releases its hold and admits the next job', async () => {
  const database = databaseOf([
    ['SELECT 1 FROM cc.jobs j WHERE', () => [{ '?column?': 1 }]],
    [
      'SELECT j.job_id FROM cc.jobs j JOIN cc.device_update_jobs u',
      () => [{ job_id: JOB }],
    ],
    ['SELECT cc.clean_device_update_hold', () => [{ result: true }]],
    ['SELECT COALESCE(max(publication_id),0)', () => [{ value: '0' }]],
    ['SELECT cc.admit_device_update_job', () => [{ result: admitted() }]],
    [
      'SELECT batch_count FROM cc.device_update_jobs',
      () => [{ batch_count: 1 }],
    ],
    ['SELECT p.publication_id,p.job_id', () => []],
    ['SELECT cc.record_device_update_start', () => [{ result: null }]],
  ]);
  const cache = cacheOf();
  const orchestration = orchestrationOf();
  const service = serviceOf({ database, cache, orchestration });
  await service.changed(CUSTOMER, JOB);
  // A command job in awaiting-devices still waits for Google. It keeps no write slot, so its
  // hold is released and the next job admits (design section 1, section 4 step 4).
  const changedCall = database.calls.find((call) =>
    call.text.includes('SELECT 1 FROM cc.jobs j WHERE'),
  );
  assert.ok(changedCall.text.includes("'awaiting-devices'"));
  const cleanupCall = database.calls.find((call) =>
    call.text.includes(
      'SELECT j.job_id FROM cc.jobs j JOIN cc.device_update_jobs u',
    ),
  );
  assert.ok(cleanupCall.text.includes("'awaiting-devices'"));
  assert.deepEqual(
    cache.calls.map((call) => call.name),
    ['release'],
  );
  assert.equal(orchestration.calls.length, 1);
});

test('a cancelled job releases its hold and admits the next job', async () => {
  const database = databaseOf([
    ['SELECT 1 FROM cc.jobs j WHERE', () => [{ '?column?': 1 }]],
    [
      'SELECT j.job_id FROM cc.jobs j JOIN cc.device_update_jobs u',
      () => [{ job_id: JOB }],
    ],
    ['SELECT cc.clean_device_update_hold', () => [{ result: true }]],
    ['SELECT COALESCE(max(publication_id),0)', () => [{ value: '0' }]],
    ['SELECT cc.admit_device_update_job', () => [{ result: admitted() }]],
    [
      'SELECT batch_count FROM cc.device_update_jobs',
      () => [{ batch_count: 1 }],
    ],
    ['SELECT p.publication_id,p.job_id', () => []],
    ['SELECT cc.record_device_update_start', () => [{ result: null }]],
  ]);
  const cache = cacheOf();
  const orchestration = orchestrationOf();
  const service = serviceOf({ database, cache, orchestration });
  await service.changed(CUSTOMER, JOB);
  // A cancelled job is finished. Its hold leaves, and the write slot admits the next job.
  const changedCall = database.calls.find((call) =>
    call.text.includes('SELECT 1 FROM cc.jobs j WHERE'),
  );
  assert.ok(changedCall.text.includes("'cancelled'"));
  const cleanupCall = database.calls.find((call) =>
    call.text.includes(
      'SELECT j.job_id FROM cc.jobs j JOIN cc.device_update_jobs u',
    ),
  );
  assert.ok(cleanupCall.text.includes("'cancelled'"));
  assert.deepEqual(
    cache.calls.map((call) => call.name),
    ['release'],
  );
  assert.equal(cache.calls[0].values[1], JOB);
  assert.ok(
    database.calls.some((call) =>
      call.text.includes('cc.clean_device_update_hold'),
    ),
  );
  assert.equal(orchestration.calls.length, 1);
});

test('a recovery answer without a start dispatches nothing', async () => {
  const database = databaseOf([
    ['SELECT COALESCE(max(publication_id),0)', () => [{ value: '0' }]],
    [
      'SELECT cc.recover_device_update_jobs',
      () => [{ result: { starts: [], reconciles: [] } }],
    ],
    ['SELECT p.publication_id', () => []],
  ]);
  const orchestration = orchestrationOf();
  const service = serviceOf({
    database,
    cache: cacheOf(),
    orchestration,
  });
  // A cancelled lost runner ends through the finalizer, which asks for no start.
  assert.equal(await service.recover(CUSTOMER), false);
  assert.deepEqual(orchestration.calls, []);
});

test('a slow tick never delays the relay', async () => {
  let finishStart;
  const starting = new Promise((resolve) => {
    finishStart = resolve;
  });
  const database = databaseOf([
    [
      'SELECT DISTINCT j.customer_id FROM cc.jobs j',
      () => [{ customer_id: CUSTOMER }],
    ],
    ['SELECT cc.accept_device_update_hold', () => []],
    ['SELECT COALESCE(max(publication_id),0)', () => [{ value: '0' }]],
    [
      'SELECT cc.recover_device_update_jobs',
      () => [{ result: { starts: [admitted()], reconciles: [] } }],
    ],
    [
      'SELECT batch_count FROM cc.device_update_jobs',
      () => [{ batch_count: 1 }],
    ],
    ['SELECT cc.record_device_update_start', () => [{ result: null }]],
    ['SELECT cc.complete_job_publications', () => [{ result: 0 }]],
    [
      'SELECT DISTINCT customer_id FROM cc.job_publications',
      () => [{ customer_id: CUSTOMER }],
    ],
    ['SELECT cc.read_job_publications', () => [{ result: [element()] }]],
  ]);
  const orchestration = orchestrationOf({
    startDeviceUpdate: async () => {
      await starting;
      return 'execution-1';
    },
  });
  const cache = cacheOf();
  const service = serviceOf({ database, cache, orchestration });
  const tick = service.tick();
  assert.equal(await service.relay(), true);
  assert.ok(cache.calls.some((call) => call.name === 'publish'));
  finishStart();
  await tick;
});

/** The statements of one tick with no work, plus a due poll job. */
const pollTickDatabase = (due = [{ jobId: OTHER_JOB, leaseId: LEASE }]) =>
  databaseOf([
    [
      'SELECT DISTINCT j.customer_id FROM cc.jobs j',
      () => [{ customer_id: CUSTOMER }],
    ],
    ['SELECT cc.accept_device_update_hold', () => []],
    ['SELECT COALESCE(max(publication_id),0)', () => [{ value: '0' }]],
    ['SELECT cc.admit_device_update_job', () => []],
    ['SELECT p.publication_id,p.job_id', () => []],
    [
      'SELECT cc.recover_device_update_jobs',
      () => [{ result: { starts: [], reconciles: [] } }],
    ],
    ['SELECT j.job_id FROM cc.jobs j JOIN', () => []],
    ['SELECT cc.due_device_command_polls', () => [{ result: due }]],
    ['SELECT cc.record_device_command_poll_start', () => [{ result: true }]],
  ]);

test('the tick starts one poll flow for each due command job and records it', async () => {
  const database = pollTickDatabase();
  const orchestration = orchestrationOf();
  const service = serviceOf({
    database,
    cache: cacheOf(),
    orchestration,
  });
  await service.tick();
  const started = orchestration.calls.filter(
    (call) => call.name === 'startDeviceCommandPoll',
  );
  assert.equal(started.length, 1);
  assert.equal(started[0].input.customerId, CUSTOMER);
  assert.equal(started[0].input.jobId, OTHER_JOB);
  assert.equal(started[0].input.leaseId, LEASE);
  assert.match(
    started[0].input.correlationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const recorded = database.calls.find((call) =>
    call.text.includes('cc.record_device_command_poll_start'),
  );
  assert.deepEqual(recorded.values, [
    CUSTOMER,
    OTHER_JOB,
    LEASE,
    'poll-execution-1',
  ]);
});

test('a poll start that fails leaves the lease to lapse and runs the rest of the tick', async () => {
  const database = pollTickDatabase([
    { jobId: JOB, leaseId: LEASE },
    { jobId: OTHER_JOB, leaseId: LEASE },
  ]);
  const orchestration = orchestrationOf({
    startDeviceCommandPoll: async (input) => {
      if (input.jobId === JOB) throw new Error('kestra unavailable');
      return 'poll-execution-2';
    },
  });
  const service = serviceOf({ database, cache: cacheOf(), orchestration });
  await service.tick();
  const recorded = database.calls.filter((call) =>
    call.text.includes('cc.record_device_command_poll_start'),
  );
  assert.equal(
    recorded.length,
    1,
    'Only the started flow records an execution.',
  );
  assert.deepEqual(recorded[0].values, [
    CUSTOMER,
    OTHER_JOB,
    LEASE,
    'poll-execution-2',
  ]);
});

test('the tick reads a customer with an awaiting-devices command job', async () => {
  const database = pollTickDatabase([]);
  const service = serviceOf({
    database,
    cache: cacheOf(),
    orchestration: orchestrationOf(),
  });
  await service.customers();
  assert.match(database.calls[0].text, /awaiting-devices/);
});
