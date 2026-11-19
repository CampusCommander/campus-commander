import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceResponseError } from '../configuration/service-http.ts';
import { JobService } from './job-service.ts';

// K16: the JobService side of the category job. The device paths keep their own tests in
// job-service.test.mjs, and these checks cover only the new branch.

const CUSTOMER = 'C0123456';
const JOB = '11111111-1111-4111-8111-111111111111';
const TOKEN = '33333333-3333-4333-8333-333333333333';
const CORRELATION = '44444444-4444-4444-8444-444444444444';
const REQUESTER = '55555555-5555-4555-8555-555555555555';
const DISPLAY = 'CAT-006';

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

const cacheOf = () => {
  const calls = [];
  const record =
    (name) =>
    async (...values) => {
      calls.push({ name, values });
      return 1;
    };
  return {
    calls,
    get: async () => null,
    set: record('set'),
    release: record('release'),
    publish: record('publish'),
    increment: record('increment'),
  };
};

const orchestrationOf = (overrides = {}) => {
  const calls = [];
  const call = (name, answer) => async (input) => {
    calls.push({ name, input });
    if (answer) return answer(input);
    return `${name}-execution`;
  };
  return {
    calls,
    startDeviceUpdate: call('startDeviceUpdate', overrides.startDeviceUpdate),
    startDeviceUpdateReconcile: call(
      'startDeviceUpdateReconcile',
      overrides.startDeviceUpdateReconcile,
    ),
    startDeviceCommandPoll: call(
      'startDeviceCommandPoll',
      overrides.startDeviceCommandPoll,
    ),
    startUserSchemaChange: call(
      'startUserSchemaChange',
      overrides.startUserSchemaChange,
    ),
  };
};

const admitted = (overrides = {}) => ({
  jobId: JOB,
  displayId: DISPLAY,
  dispatchToken: TOKEN,
  correlationId: CORRELATION,
  targetCount: 1,
  kind: 'user-schema-change',
  ...overrides,
});

const serviceOf = ({ database, cache, orchestration }) =>
  new JobService({
    database,
    cache,
    orchestration,
    clock: () => 0,
  });

const admissionDatabase = ({ job = admitted(), publications = [] } = {}) =>
  databaseOf([
    ['SELECT COALESCE(max(publication_id),0)', () => [{ value: '0' }]],
    ['SELECT cc.admit_device_update_job', () => [{ result: job }]],
    ['SELECT p.publication_id,p.job_id', () => publications],
    ['SELECT cc.record_user_schema_change_start', () => [{ result: null }]],
    ['SELECT cc.abandon_user_schema_change_start', () => [{ result: null }]],
    ['SELECT cc.complete_job_publications', () => [{ result: 1 }]],
  ]);

test('an admitted category job starts user_schema_change and records its execution', async () => {
  const database = admissionDatabase();
  const cache = cacheOf();
  const orchestration = orchestrationOf();
  const service = serviceOf({ database, cache, orchestration });
  assert.equal(await service.admit(CUSTOMER), false);
  assert.deepEqual(orchestration.calls[0], {
    name: 'startUserSchemaChange',
    input: {
      customerId: CUSTOMER,
      jobId: JOB,
      dispatchToken: TOKEN,
      correlationId: CORRELATION,
    },
  });
  // The device start and its batch detail read never run for a category job.
  assert.equal(
    database.calls.some((call) =>
      call.text.includes('SELECT batch_count FROM cc.device_update_jobs'),
    ),
    false,
  );
  const recorded = database.calls.find((call) =>
    call.text.includes('cc.record_user_schema_change_start'),
  );
  assert.deepEqual(recorded.values, [
    CUSTOMER,
    JOB,
    TOKEN,
    'startUserSchemaChange-execution',
  ]);
});

test('an admitted category job header publishes one row at once', async () => {
  const rows = [
    {
      publication_id: '7',
      job_id: JOB,
      display_id: DISPLAY,
      revision: '4',
      requested_by: REQUESTER,
    },
  ];
  // The fake answers the publication read only for a header whose kind the statement admits, as
  // the SQL filter does. Without the category kind the read finds no row and publishes nothing.
  const database = databaseOf([
    ['SELECT COALESCE(max(publication_id),0)', () => [{ value: '0' }]],
    ['SELECT cc.admit_device_update_job', () => [{ result: admitted() }]],
    [
      'SELECT p.publication_id,p.job_id',
      (values, text) => (text.includes("'user-schema-change'") ? rows : []),
    ],
    ['SELECT cc.record_user_schema_change_start', () => [{ result: null }]],
    ['SELECT cc.complete_job_publications', () => [{ result: 1 }]],
  ]);
  const cache = cacheOf();
  const orchestration = orchestrationOf();
  const service = serviceOf({ database, cache, orchestration });
  assert.equal(await service.admit(CUSTOMER), false);
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

test('a 4xx category start runs the refused start and publishes its row', async () => {
  const rows = [
    {
      publication_id: '7',
      job_id: JOB,
      display_id: DISPLAY,
      revision: '4',
      requested_by: REQUESTER,
    },
  ];
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
    startUserSchemaChange: () => {
      throw new ServiceResponseError(400);
    },
  });
  const service = serviceOf({ database, cache, orchestration });
  assert.equal(await service.admit(CUSTOMER), true);
  const abandoned = database.calls.find((call) =>
    call.text.includes('cc.abandon_user_schema_change_start'),
  );
  assert.deepEqual(abandoned.values, [CUSTOMER, JOB, TOKEN]);
  assert.equal(
    database.calls.some((call) =>
      call.text.includes('cc.record_user_schema_change_start'),
    ),
    false,
  );
});

for (const [label, failure] of [
  ['a 5xx answer', new ServiceResponseError(503)],
  ['a timeout', new Error('timed out')],
]) {
  test(`${label} on a category start changes nothing at once`, async () => {
    const database = admissionDatabase();
    const cache = cacheOf();
    const orchestration = orchestrationOf({
      startUserSchemaChange: () => {
        throw failure;
      },
    });
    const service = serviceOf({ database, cache, orchestration });
    assert.equal(await service.admit(CUSTOMER), false);
    assert.equal(
      database.calls.some((call) =>
        call.text.includes('cc.abandon_user_schema_change_start'),
      ),
      false,
    );
    assert.equal(
      database.calls.some((call) =>
        call.text.includes('cc.record_user_schema_change_start'),
      ),
      false,
    );
  });
}

test('a recovery start of a category job starts its own flow', async () => {
  const database = databaseOf([
    ['SELECT COALESCE(max(publication_id),0)', () => [{ value: '0' }]],
    [
      'SELECT cc.recover_device_update_jobs',
      () => [{ result: { starts: [] } }],
    ],
    ['SELECT cc.recover_device_file_jobs', () => [{ result: { failed: [] } }]],
    [
      'SELECT cc.recover_user_schema_change_jobs',
      () => [{ result: { starts: [admitted()] } }],
    ],
    ['SELECT p.publication_id,p.job_id', () => []],
    ['SELECT cc.record_user_schema_change_start', () => [{ result: null }]],
    ['SELECT cc.complete_job_publications', () => [{ result: 1 }]],
  ]);
  const cache = cacheOf();
  const orchestration = orchestrationOf();
  const service = serviceOf({ database, cache, orchestration });
  assert.equal(await service.recover(CUSTOMER), true);
  assert.equal(orchestration.calls.length, 1);
  assert.equal(orchestration.calls[0].name, 'startUserSchemaChange');
  assert.equal(orchestration.calls[0].input.jobId, JOB);
});

test('a terminal category job runs cleanup and admission, and the customer list names the kind', async () => {
  const database = databaseOf([
    ['SELECT DISTINCT j.customer_id', () => [{ customer_id: CUSTOMER }]],
    ['SELECT 1 FROM cc.jobs j WHERE', () => [{ '?column?': 1 }]],
    ['SELECT j.job_id FROM cc.jobs j JOIN cc.device_update_jobs u', () => []],
    ['SELECT COALESCE(max(publication_id),0)', () => [{ value: '0' }]],
    ['SELECT cc.admit_device_update_job', () => [{ result: null }]],
    ['SELECT p.publication_id,p.job_id', () => []],
  ]);
  const cache = cacheOf();
  const orchestration = orchestrationOf();
  const service = serviceOf({ database, cache, orchestration });
  assert.deepEqual(await service.customers(), [CUSTOMER]);
  const customersCall = database.calls.find((call) =>
    call.text.includes('SELECT DISTINCT j.customer_id'),
  );
  assert.ok(customersCall.text.includes("'user-schema-change'"));
  await service.changed(CUSTOMER, JOB);
  const changedCall = database.calls.find((call) =>
    call.text.includes('SELECT 1 FROM cc.jobs j WHERE'),
  );
  assert.ok(changedCall.text.includes("'user-schema-change'"));
  assert.deepEqual(changedCall.values, [CUSTOMER, JOB]);
});
