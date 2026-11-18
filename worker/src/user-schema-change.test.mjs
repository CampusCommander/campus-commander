import assert from 'node:assert/strict';
import test from 'node:test';
import { CategorySendRefused } from '@campus/google-connection';
import { UserSchemaChangeJobs } from './user-schema-change.ts';

const CUSTOMER = 'C0123456';
const JOB = '11111111-1111-4111-8111-111111111111';
const TOKEN = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_EXISTS = true;
const PLAN = '55555555-5555-4555-8555-555555555555';
const CREDENTIAL = '66666666-6666-4666-8666-666666666666';
const CORRELATION = '77777777-7777-4777-8777-777777777777';
const OBSERVED_AT = '2026-11-18T12:00:00.000Z';

const field = (overrides = {}) => ({
  fieldId: 'field-1',
  fieldName: 'Homeroom',
  displayName: 'Homeroom',
  fieldType: 'STRING',
  multiValued: false,
  indexed: true,
  readAccessType: 'ALL_DOMAIN_USERS',
  numericIndexingSpec: null,
  ...overrides,
});

const observation = (overrides = {}) => ({
  schemaId: 'schema-1',
  schemaName: 'StudentInfo',
  displayName: 'Student Info',
  etag: 'etag-1',
  fields: [field()],
  ...overrides,
});

const body = (overrides = {}) => ({
  schemaName: 'StudentInfo',
  displayName: 'Student Info',
  fields: [
    {
      fieldName: 'Homeroom',
      displayName: 'Homeroom',
      fieldType: 'STRING',
    },
  ],
  ...overrides,
});

const claimOf = (overrides = {}) => ({
  outcome: 'claimed',
  generation: 1,
  credentialId: CREDENTIAL,
  envelope: { ciphertext: 'fixture' },
  action: 'create-category',
  schemaId: null,
  schemaName: 'StudentInfo',
  body: body(),
  baseEtag: null,
  planId: PLAN,
  resume: false,
  ...overrides,
});

const attempts = (overrides = {}) => ({
  quota: 0,
  transient: 0,
  ...overrides,
});

/** One part answer: a value, or one failure. */
const answer = (value) => ({
  succeeded: new Map([['category', [value]]]),
  failed: new Map(),
});
const failed = (failure) => ({
  succeeded: new Map(),
  failed: new Map([['category', failure]]),
});

/** A store that answers the claim, the send gate, the clock, and the settlement, and records every
 * call. */
function storeOf(claim = claimOf(), options = {}) {
  const calls = [];
  return {
    calls,
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes('cc.claim_user_schema_change'))
        return { rows: [{ result: claim }] };
      if (text.includes('cc.begin_user_schema_change_write'))
        return {
          rows: [{ result: options.beginWrite ?? { outcome: 'writing' } }],
        };
      if (text.includes('clock_timestamp'))
        return { rows: [{ result: new Date(OBSERVED_AT) }] };
      if (text.includes('cc.settle_user_schema_change'))
        return {
          rows: [
            {
              result: {
                outcome: 'settled',
                status: options.status ?? 'completed',
                schemaChanged: options.schemaChanged ?? true,
              },
            },
          ],
        };
      throw new Error(`Unexpected statement: ${text}`);
    },
    settlement: () =>
      calls.find((call) => call.text.includes('cc.settle_user_schema_change')),
    begin: () =>
      calls.find((call) =>
        call.text.includes('cc.begin_user_schema_change_write'),
      ),
  };
}

const cipherOf = () => ({
  open: () => ({ serviceAccount: { clientEmail: 'worker@example.org' } }),
});

const jobsOf = (store, writer, reader, options = {}) =>
  new UserSchemaChangeJobs(store, cipherOf(), {
    writer,
    reader: reader ?? { categories: async () => [] },
    writeTimeoutMilliseconds: 1_000,
    readTimeoutMilliseconds: 1_000,
    ...options,
  });

const request = () => ({
  customerId: CUSTOMER,
  jobId: JOB,
  dispatchToken: TOKEN,
  correlationId: CORRELATION,
});

const runOf = (store, writer, reader, options) =>
  jobsOf(store, writer, reader, options).run(
    request(),
    new AbortController().signal,
  );

/**
 * A fake category writer. Each write call records the call, then runs the send gate it received as
 * its last argument, exactly where the real writer runs it: after the token mint and before the
 * part. A refused gate throws `CategorySendRefused` and returns no part (R4).
 */
const writerOf = (overrides = {}) => {
  const calls = [];
  const gated = async (record) => {
    const gate = record.values.at(-1);
    if (typeof gate !== 'function')
      throw new Error('The write call carries no send gate.');
    if (!(await gate())) throw new CategorySendRefused();
    record.gated = true;
  };
  return {
    calls,
    category: async (...values) => {
      calls.push({ name: 'category', values });
      return overrides.category ? overrides.category() : null;
    },
    insertCategory: async (...values) => {
      const record = { name: 'insertCategory', values, gated: false };
      calls.push(record);
      await gated(record);
      return overrides.insertCategory
        ? overrides.insertCategory()
        : answer(observation());
    },
    updateCategory: async (...values) => {
      const record = { name: 'updateCategory', values, gated: false };
      calls.push(record);
      await gated(record);
      return overrides.updateCategory
        ? overrides.updateCategory()
        : answer(observation());
    },
    deleteCategory: async (...values) => {
      const record = { name: 'deleteCategory', values, gated: false };
      calls.push(record);
      await gated(record);
      return overrides.deleteCategory
        ? overrides.deleteCategory()
        : answer(null);
    },
  };
};

test('a fenced claim sends no Google call', async () => {
  const store = storeOf({ outcome: 'fenced' });
  const writer = writerOf();
  assert.deepEqual(await runOf(store, writer), { outcome: 'fenced' });
  assert.equal(writer.calls.length, 0);
  assert.equal(store.settlement(), undefined);
});

test('a new category sends one POST and settles Succeeded with the answered schema', async () => {
  const store = storeOf();
  const writer = writerOf();
  assert.deepEqual(await runOf(store, writer), {
    outcome: 'settled',
    status: 'completed',
  });
  assert.equal(writer.calls.length, 1);
  assert.equal(writer.calls[0].name, 'insertCategory');
  const settlement = store.settlement();
  assert.equal(settlement.values[4], 'succeeded');
  assert.equal(settlement.values[5], null);
  assert.deepEqual(JSON.parse(settlement.values[7]), observation());
  assert.equal(settlement.values[8], null);
});

test('a changed etag fails category-changed and sends no write', async () => {
  // C7 and the acceptance: the fresh compare is the only guard.
  const store = storeOf(
    claimOf({
      action: 'edit-category',
      schemaId: 'schema-1',
      baseEtag: 'etag-1',
    }),
  );
  const writer = writerOf({
    category: () => observation({ etag: 'etag-2' }),
  });
  await runOf(store, writer);
  assert.equal(
    writer.calls.some((call) => call.name === 'updateCategory'),
    false,
  );
  const settlement = store.settlement();
  assert.equal(settlement.values[4], 'failed');
  assert.equal(settlement.values[5], 'category-changed');
  // The fresh observation refreshes the cache in the same transaction.
  assert.deepEqual(
    JSON.parse(settlement.values[7]),
    observation({ etag: 'etag-2' }),
  );
});

test('an unchanged etag sends the update with If-Match and settles Succeeded', async () => {
  const store = storeOf(
    claimOf({
      action: 'edit-category',
      schemaId: 'schema-1',
      baseEtag: 'etag-1',
    }),
  );
  const writer = writerOf({ category: () => observation() });
  await runOf(store, writer);
  const update = writer.calls.find((call) => call.name === 'updateCategory');
  assert.equal(update.values[2], 'schema-1');
  assert.equal(update.values[3], 'etag-1');
  assert.equal(store.settlement().values[4], 'succeeded');
});

test('a guard read that finds no category fails not-found and sends nothing', async () => {
  const store = storeOf(
    claimOf({
      action: 'delete-category',
      schemaId: 'schema-1',
      baseEtag: 'etag-1',
      body: null,
    }),
  );
  const writer = writerOf({ category: () => null });
  await runOf(store, writer);
  assert.equal(writer.calls.length, 1);
  assert.equal(store.settlement().values[5], 'not-found');
});

test('an insert answer of 409 settles Failed name-in-use and refreshes the cache', async () => {
  // C6: the name is taken.
  const store = storeOf();
  const writer = writerOf({
    insertCategory: () =>
      failed({
        kind: 'rejected',
        status: 409,
        reason: 'duplicate',
        attempts: attempts(),
        body: { error: { errors: [{ reason: 'duplicate' }] } },
      }),
  });
  const reader = { categories: async () => [observation()] };
  await runOf(store, writer, reader);
  const settlement = store.settlement();
  assert.equal(settlement.values[4], 'failed');
  assert.equal(settlement.values[5], 'name-in-use');
  assert.equal(settlement.values[6], 'duplicate');
  assert.deepEqual(JSON.parse(settlement.values[8]), [observation()]);
});

test('an insert answer of 412 settles Failed name-in-use', async () => {
  const store = storeOf();
  const writer = writerOf({
    insertCategory: () =>
      failed({
        kind: 'rejected',
        status: 412,
        reason: 'conditionNotMet',
        attempts: attempts(),
        body: { error: { errors: [{ reason: 'conditionNotMet' }] } },
      }),
  });
  await runOf(store, writer);
  assert.equal(store.settlement().values[5], 'name-in-use');
});

test('an update answer of 412 settles Failed category-changed', async () => {
  // C7: the category changed between the guard and the write.
  const store = storeOf(
    claimOf({
      action: 'edit-category',
      schemaId: 'schema-1',
      baseEtag: 'etag-1',
    }),
  );
  const writer = writerOf({
    category: () => observation(),
    updateCategory: () =>
      failed({
        kind: 'rejected',
        status: 412,
        reason: 'conditionNotMet',
        attempts: attempts(),
        body: { error: { errors: [{ reason: 'conditionNotMet' }] } },
      }),
  });
  const reader = { categories: async () => [observation({ etag: 'etag-2' })] };
  await runOf(store, writer, reader);
  const settlement = store.settlement();
  assert.equal(settlement.values[5], 'category-changed');
  assert.deepEqual(JSON.parse(settlement.values[8]), [
    observation({ etag: 'etag-2' }),
  ]);
});

test('a delete answer of 412 settles Failed category-changed', async () => {
  const store = storeOf(
    claimOf({
      action: 'delete-category',
      schemaId: 'schema-1',
      baseEtag: 'etag-1',
      body: null,
    }),
  );
  const writer = writerOf({
    category: () => observation(),
    deleteCategory: () =>
      failed({
        kind: 'rejected',
        status: 412,
        reason: 'conditionNotMet',
        attempts: attempts(),
        body: { error: { errors: [{ reason: 'conditionNotMet' }] } },
      }),
  });
  await runOf(store, writer);
  assert.equal(store.settlement().values[5], 'category-changed');
});

test('a delete answer of 204 settles Succeeded with no schema', async () => {
  const store = storeOf(
    claimOf({
      action: 'delete-category',
      schemaId: 'schema-1',
      baseEtag: 'etag-1',
      body: null,
    }),
  );
  const writer = writerOf({ category: () => observation() });
  await runOf(store, writer);
  const settlement = store.settlement();
  assert.equal(settlement.values[4], 'succeeded');
  assert.equal(settlement.values[7], null);
  assert.equal(settlement.values[8], null);
});

test('a transient insert answer that applied settles Succeeded from the read-back', async () => {
  // Document B section 7.3: a transient insert ends Unknown, then the read-back decides.
  const store = storeOf();
  const writer = writerOf({
    insertCategory: () =>
      failed({
        kind: 'transient',
        status: 503,
        reason: 'backendError',
        attempts: attempts({ transient: 1 }),
        body: { error: { errors: [{ reason: 'backendError' }] } },
      }),
    category: () => observation(),
  });
  await runOf(store, writer);
  const settlement = store.settlement();
  assert.equal(settlement.values[4], 'succeeded');
  // The stored schema comes from the read, apart from the part answer.
  assert.deepEqual(JSON.parse(settlement.values[7]), observation());
});

test('an insert with no answer that did not apply stays Unknown', async () => {
  const store = storeOf();
  const writer = writerOf({
    insertCategory: () =>
      failed({
        kind: 'transient',
        status: 0,
        reason: null,
        attempts: attempts(),
        body: null,
      }),
    category: () => null,
  });
  await runOf(store, writer);
  const settlement = store.settlement();
  assert.equal(settlement.values[4], 'unknown');
  assert.equal(settlement.values[5], 'network-failure');
  assert.equal(settlement.values[7], null);
});

test('a repeated claim reads Google back and never sends the insert again', async () => {
  const store = storeOf(claimOf({ resume: ATTEMPT_EXISTS }));
  const writer = writerOf({ category: () => observation() });
  await runOf(store, writer);
  assert.equal(
    writer.calls.some((call) => call.name === 'insertCategory'),
    false,
  );
  assert.equal(writer.calls[0].name, 'category');
  assert.equal(writer.calls[0].values[2], 'StudentInfo');
  assert.equal(store.settlement().values[4], 'succeeded');
});

test('a credential that cannot open fails key-unavailable before any Google call', async () => {
  const store = storeOf();
  const writer = writerOf();
  const jobs = new UserSchemaChangeJobs(
    store,
    {
      open: () => {
        throw new Error('credential-key-invalid');
      },
    },
    { writer, reader: { categories: async () => [] } },
  );
  await jobs.run(request(), new AbortController().signal);
  assert.equal(writer.calls.length, 0);
  const settlement = store.settlement();
  assert.equal(settlement.values[4], 'failed');
  assert.equal(settlement.values[5], 'key-unavailable');
});

test('an auth refusal fails the job and never reads back', async () => {
  const store = storeOf();
  const writer = writerOf({
    insertCategory: () =>
      failed({
        kind: 'auth',
        status: 401,
        reason: 'authError',
        attempts: attempts(),
        body: { error: { errors: [{ reason: 'authError' }] } },
      }),
  });
  await runOf(store, writer);
  assert.equal(
    writer.calls.some((call) => call.name === 'category'),
    false,
  );
  assert.equal(store.settlement().values[5], 'credential-rejected');
});

test('a quota answer fails the job with quota', async () => {
  const store = storeOf();
  const writer = writerOf({
    insertCategory: () =>
      failed({
        kind: 'quota',
        status: 429,
        reason: 'rateLimitExceeded',
        attempts: attempts({ quota: 25 }),
        body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } },
      }),
  });
  await runOf(store, writer);
  assert.equal(store.settlement().values[5], 'quota');
});

test('a live owner fences a second runner and the second runner sends nothing (R1)', async () => {
  // The claim answers busy while another attempt holds its lease.
  const store = storeOf({ outcome: 'busy' });
  const writer = writerOf();
  assert.deepEqual(await runOf(store, writer), { outcome: 'busy' });
  assert.equal(writer.calls.length, 0);
  assert.equal(store.settlement(), undefined);
});

test('a cancelled or expired job stops at the send gate and sends nothing (R4)', async () => {
  // The gate reads the cancel flag, the attempt, and the lease under one lock. The writer enters
  // its one write call, and the gate refuses before any part leaves.
  const store = storeOf(claimOf(), { beginWrite: { outcome: 'fenced' } });
  const writer = writerOf();
  assert.deepEqual(await runOf(store, writer), { outcome: 'fenced' });
  assert.deepEqual(
    writer.calls.map((call) => call.name),
    ['insertCategory'],
  );
  assert.equal(writer.calls[0].gated, false);
  assert.equal(store.settlement(), undefined);
});

test('the send gate runs after the guard and inside the one write call (R4)', async () => {
  const store = storeOf(
    claimOf({
      action: 'edit-category',
      schemaId: 'schema-1',
      baseEtag: 'etag-1',
    }),
  );
  const writer = writerOf({ category: () => observation() });
  await runOf(store, writer);
  const names = store.calls.map((call) =>
    call.text.includes('cc.claim_user_schema_change')
      ? 'claim'
      : call.text.includes('cc.begin_user_schema_change_write')
        ? 'begin'
        : 'other',
  );
  assert.deepEqual(names.slice(0, 2), ['claim', 'begin']);
  // The guard read is the first writer call, and the gate runs inside the write call that follows.
  assert.deepEqual(
    writer.calls.map((call) => call.name),
    ['category', 'updateCategory'],
  );
  assert.equal(writer.calls[1].gated, true);
  assert.equal(store.settlement().values[4], 'succeeded');
});

test('a repeated claim reads back without the send gate or a second call', async () => {
  const store = storeOf(claimOf({ resume: ATTEMPT_EXISTS }));
  const writer = writerOf({ category: () => observation() });
  await runOf(store, writer);
  assert.equal(store.begin(), undefined);
  assert.equal(
    writer.calls.some((call) => call.name === 'insertCategory'),
    false,
  );
});

test('a successful answer with another number range is Unknown, not Succeeded (R5)', async () => {
  const store = storeOf(
    claimOf({
      body: body({
        fields: [
          {
            fieldName: 'Homeroom',
            displayName: 'Homeroom',
            fieldType: 'INT64',
            numericIndexingSpec: { minValue: 1, maxValue: 9 },
          },
        ],
      }),
    }),
  );
  const writer = writerOf({
    insertCategory: () =>
      answer(
        observation({
          fields: [
            field({
              fieldType: 'INT64',
              numericIndexingSpec: { minValue: 0, maxValue: 12 },
            }),
          ],
        }),
      ),
  });
  await runOf(store, writer);
  const settlement = store.settlement();
  assert.equal(settlement.values[4], 'unknown');
  assert.equal(settlement.values[5], 'invalid-response');
  // The observed schema stays in the cache, apart from the outcome.
  assert.equal(
    JSON.parse(settlement.values[7]).fields[0].numericIndexingSpec.maxValue,
    12,
  );
});

test('a successful answer with another kept field is Unknown, not Succeeded (R5)', async () => {
  const store = storeOf(
    claimOf({
      action: 'edit-category',
      schemaId: 'schema-1',
      baseEtag: 'etag-1',
      body: body({ fields: [{ ...body().fields[0], fieldId: 'field-1' }] }),
    }),
  );
  const writer = writerOf({
    category: () => observation(),
    updateCategory: () =>
      answer(observation({ fields: [field({ fieldId: 'field-2' })] })),
  });
  await runOf(store, writer);
  const settlement = store.settlement();
  assert.equal(settlement.values[4], 'unknown');
  assert.equal(settlement.values[5], 'invalid-response');
});

test('a matching successful answer still settles Succeeded (control)', async () => {
  const store = storeOf(
    claimOf({
      action: 'edit-category',
      schemaId: 'schema-1',
      baseEtag: 'etag-1',
      body: body({
        fields: [
          {
            fieldId: 'field-1',
            fieldName: 'Homeroom',
            displayName: 'Homeroom',
            fieldType: 'INT64',
            numericIndexingSpec: { minValue: 1, maxValue: 9 },
          },
        ],
      }),
    }),
  );
  const writer = writerOf({
    category: () => observation(),
    updateCategory: () =>
      answer(
        observation({
          fields: [
            field({
              fieldType: 'INT64',
              numericIndexingSpec: { minValue: 1, maxValue: 9 },
            }),
          ],
        }),
      ),
  });
  await runOf(store, writer);
  assert.equal(store.settlement().values[4], 'succeeded');
});

test('a settled schema change publishes one event and moves the user generation (R6)', async () => {
  const events = [];
  const store = storeOf();
  const writer = writerOf();
  await runOf(store, writer, undefined, {
    cache: {
      increment: async (key) => {
        events.push({ kind: 'increment', key });
      },
      publish: async (channel, message) => {
        events.push({ kind: 'publish', channel, message });
      },
    },
  });
  assert.deepEqual(events[0], {
    kind: 'increment',
    key: `cc:query-gen:user:${CUSTOMER}`,
  });
  assert.equal(events[1].kind, 'publish');
  assert.equal(events[1].channel, `cc:entity-events:${CUSTOMER}`);
  assert.deepEqual(JSON.parse(events[1].message), {
    type: 'schema-change',
    entityType: 'user',
  });
});

test('a settlement that stores no schema publishes nothing (control)', async () => {
  const events = [];
  const store = storeOf(claimOf(), { schemaChanged: false });
  const writer = writerOf();
  await runOf(store, writer, undefined, {
    cache: {
      increment: async () => events.push('increment'),
      publish: async () => events.push('publish'),
    },
  });
  assert.deepEqual(events, []);
});
