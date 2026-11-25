import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ValueSendRefused } from '@campus/google-connection';
import {
  READ_BACK_DELAY_SECONDS,
  UserAttributeUpdateJobs,
  changedValues,
  classifyPart,
  sameValue,
} from './user-attribute-update.ts';

const customerId = 'C0123456';
const jobId = randomUUID();
const dispatchToken = randomUUID();
const correlationId = randomUUID();
const request = { customerId, jobId, dispatchToken, correlationId };
const reconcileRequest = { customerId, jobId, correlationId };
const field = {
  schemaName: 'StudentInfo',
  fieldName: 'Homeroom',
  fieldType: 'STRING',
  multiValued: false,
};
const stamp = new Date('2026-11-25T12:00:00.000Z');

/** One claimed user of the preview. A `null` requested value is a clear (C9). */
const person = (ordinal, userId, value) => ({
  ordinal,
  userId,
  primaryEmail: `${userId}@example.org`,
  customSchemas: { StudentInfo: { Homeroom: value } },
});

const claimed = (users, extra = {}) => ({
  outcome: 'claimed',
  generation: 1,
  credentialId: randomUUID(),
  envelope: { sealed: true },
  source: 'edit-list',
  fields: [field],
  mask: ['StudentInfo'],
  users,
  remaining: false,
  ...extra,
});

const verified = (users, waitMilliseconds = 0, remaining = users.length) => ({
  ...claimed(users),
  remaining,
  waitMilliseconds,
});

/**
 * A scripted store. Each check answers the call of one `cc.*` function, and every call keeps its
 * values so a test can inspect the settlement that the worker sent (B section 7.3).
 */
function database(options = {}) {
  const calls = [];
  const settlements = [];
  const verifications = [];
  const observations = [];
  const claims = [...(options.claims ?? [])];
  const readBacks = [...(options.readBacks ?? [])];
  const finished = [...(options.finished ?? [])];
  const users = new Map();
  for (const claim of options.claims ?? [])
    for (const one of claim.users ?? []) users.set(one.ordinal, one.userId);
  return {
    calls,
    settlements,
    verifications,
    observations,
    get pending() {
      return claims.length;
    },
    async query(sql, values) {
      const name = (/cc\.(\w+)/.exec(sql) ?? /(\w+)\(\)/.exec(sql))[1];
      calls.push({ name, values });
      if (options.fail?.[name]) throw options.fail[name];
      switch (name) {
        case 'clock_timestamp':
          return { rows: [{ result: stamp }] };
        case 'begin_user_attribute_write':
          return {
            rows: [
              { result: { outcome: options.fenced ? 'fenced' : 'writing' } },
            ],
          };
        case 'extend_user_attribute_attempt':
          return { rows: [{ result: { outcome: 'extended' } }] };
        case 'claim_user_attribute_updates': {
          const next = claims.shift() ?? {
            outcome: 'done',
            status: 'completed',
          };
          for (const one of next.users ?? [])
            users.set(one.ordinal, one.userId);
          return { rows: [{ result: next }] };
        }
        case 'settle_user_attribute_updates': {
          const results = JSON.parse(String(values[4]));
          settlements.push(results);
          for (const result of results) observations.push(result);
          const changed = results
            .filter((result) => result.outcome === 'succeeded')
            .map((result) => users.get(result.ordinal));
          const removed = results
            .filter((result) => result.failure === 'not-found')
            .map((result) => users.get(result.ordinal));
          return {
            rows: [
              {
                result: {
                  outcome: 'settled',
                  status: 'running',
                  changed,
                  removed,
                  remaining: false,
                },
              },
            ],
          };
        }
        case 'claim_user_attribute_verification': {
          const next = readBacks.shift() ?? {
            outcome: 'done',
            status: options.doneStatus ?? 'completed',
          };
          return { rows: [{ result: next }] };
        }
        case 'claim_user_attribute_verification_one':
          return {
            rows: [{ result: { outcome: options.oneOutcome ?? 'claimed' } }],
          };
        case 'read_user_attribute_verification':
          return { rows: [{ result: options.read ?? { outcome: 'fenced' } }] };
        case 'settle_user_attribute_verification': {
          verifications.push(values);
          const removed =
            values[5] === 'not-found' ? [users.get(values[3])] : [];
          return {
            rows: [
              {
                result: {
                  outcome: 'settled',
                  status:
                    values[4] === 'unknown' ? 'needs-review' : 'completed',
                  removed,
                  outcomeOf: values[4],
                },
              },
            ],
          };
        }
        case 'finish_user_attribute_job': {
          const next = finished.shift() ?? {
            outcome: 'finished',
            status: options.doneStatus ?? 'completed',
          };
          for (const result of next.results ?? []) observations.push(result);
          return { rows: [{ result: next }] };
        }
        default:
          throw new Error(`unexpected call ${name}`);
      }
    },
  };
}

/** The batch writer. Each call answers its parts, or refuses the envelope after the send gate. */
function writer(answer) {
  return {
    calls: [],
    async writeValues(_credential, writes, signal, onRound, beforeSend) {
      const call = {
        writes: writes.map((write) => ({ ...write })),
        aborted: signal.aborted,
      };
      this.calls.push(call);
      if (beforeSend && !(await beforeSend())) throw new ValueSendRefused();
      await onRound?.();
      return answer(call.writes, signal);
    },
  };
}

/** The masked reader. A `missing` user answers 404, and a `failed` user answers its failure. */
function reader(answer) {
  return {
    calls: [],
    async valueReads(_credential, ids, mask, signal) {
      this.calls.push({
        ids: [...ids],
        mask: [...mask],
        aborted: signal.aborted,
      });
      return answer([...ids], [...mask]);
    },
  };
}

const values = (entries) => ({
  values: new Map(Object.entries(entries).map(([id, page]) => [id, page])),
  missing: [],
  failed: new Map(),
});

const cache = () => ({
  calls: [],
  async increment(key) {
    this.calls.push({ name: 'increment', args: [key] });
  },
  async publish(channel, body) {
    this.calls.push({ name: 'publish', args: [channel, JSON.parse(body)] });
  },
  async remove(keys) {
    this.calls.push({ name: 'remove', args: [keys] });
  },
});

/** One run with the fake clock, so no test waits a real second. */
function jobs(options = {}) {
  const sleeps = [];
  const events = options.events ?? [];
  const instance = new UserAttributeUpdateJobs(
    options.db ?? database(),
    options.cipher ?? { open: () => ({ subject: 'fixture@example.invalid' }) },
    {
      writer: options.writer,
      reader: options.reader,
      cache: options.cache,
      maximumPauseMilliseconds: options.maximumPauseMilliseconds,
      writeTimeoutMilliseconds: 5_000,
      readTimeoutMilliseconds: 5_000,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        events.push(`sleep ${milliseconds}`);
      },
    },
  );
  return { instance, sleeps, events };
}

test('a write answer that holds the values settles Succeeded `write-response`', async () => {
  const db = database({
    claims: [claimed([person(0, 'u1', 'A')]), claimed([])],
  });
  const store = cache();
  const source = writer((writes) => ({
    succeeded: new Map(
      writes.map((write) => [
        write.userId,
        [{ userId: write.userId, customSchemas: write.customSchemas }],
      ]),
    ),
    failed: new Map(),
  }));
  const { instance } = jobs({ db, writer: source, cache: store });
  const answer = await instance.run(request, AbortSignal.timeout(5_000));
  assert.deepEqual(answer, { outcome: 'settled', status: 'completed' });
  // One envelope, one part, one PATCH (the requested value is not a clear).
  assert.equal(source.calls.length, 1);
  assert.deepEqual(source.calls[0].writes, [
    { userId: 'u1', customSchemas: { StudentInfo: { Homeroom: 'A' } } },
  ]);
  const [settled] = db.settlements;
  assert.deepEqual(settled, [
    {
      ordinal: 0,
      outcome: 'succeeded',
      failure: null,
      reason: null,
      googleStatus: 200,
      googleReason: null,
      verifiedBy: 'write-response',
      observed: { StudentInfo: { Homeroom: 'A' } },
    },
  ]);
  // B section 9: the settled user publishes one users feed event and moves the query generation.
  assert.deepEqual(
    store.calls.find((call) => call.name === 'remove'),
    undefined,
  );
  assert.deepEqual(
    store.calls.find((call) => call.name === 'increment')?.args,
    [`cc:query-gen:user:${customerId}`],
  );
  assert.deepEqual(
    store.calls.find((call) => call.name === 'publish')?.args[1],
    {
      type: 'entity-batch',
      jobId,
      entityType: 'user',
      batch: 0,
      batchCount: 1,
      deviceIds: ['u1'],
      removedIds: [],
    },
  );
});

test('a 2xx answer without the values stays Unknown and the read-back settles it (C11)', async () => {
  const db = database({
    claims: [claimed([person(0, 'u1', 'A')]), claimed([])],
    readBacks: [
      verified([], READ_BACK_DELAY_SECONDS * 1000, 1),
      verified([person(0, 'u1', 'A')]),
    ],
  });
  const store = cache();
  const events = [];
  // The batch answer echoes the user without the requested category value.
  const source = writer((writes) => ({
    succeeded: new Map(
      writes.map((write) => [write.userId, [{ userId: write.userId }]]),
    ),
    failed: new Map(),
  }));
  const read = reader((ids) => {
    events.push(`read ${ids.join(',')}`);
    return values({ u1: { StudentInfo: { Homeroom: 'A' } } });
  });
  const { instance, sleeps } = jobs({
    db,
    writer: source,
    reader: read,
    cache: store,
    events,
  });
  const answer = await instance.run(request, AbortSignal.timeout(5_000));
  assert.deepEqual(answer, { outcome: 'settled', status: 'completed' });
  // The write answer proved nothing, so the first settlement stays Unknown.
  assert.equal(db.settlements[0][0].outcome, 'unknown');
  assert.equal(db.settlements[0][0].failure, 'invalid-response');
  // The read-back waits the 30 seconds of C11 before it reads, and never a shorter time.
  assert.deepEqual(sleeps, [30_000]);
  assert.ok(
    events.indexOf('sleep 30000') < events.indexOf('read u1'),
    'The read-back starts after the wait.',
  );
  // The read-back settles Succeeded and publishes the user again.
  assert.equal(db.settlements[1][0].outcome, 'succeeded');
  assert.equal(db.settlements[1][0].verifiedBy, 'read-back');
  // Only the settlement that changed a user publishes: an Unknown answer changes nothing.
  assert.equal(store.calls.filter((call) => call.name === 'publish').length, 1);
});

test('a read-back that answers 400 `invalid` leaves the operation Unknown (C10)', async () => {
  const db = database({
    claims: [claimed([person(0, 'u1', 'A')]), claimed([])],
    readBacks: [
      verified([], 30_000, 1),
      verified([person(0, 'u1', 'A')]),
      { outcome: 'done', status: 'needs-review' },
    ],
    doneStatus: 'needs-review',
  });
  const source = writer((writes) => ({
    succeeded: new Map(
      writes.map((write) => [write.userId, [{ userId: write.userId }]]),
    ),
    failed: new Map(),
  }));
  const read = reader(() => ({
    values: new Map(),
    missing: [],
    failed: new Map([
      [
        'u1',
        {
          status: 400,
          reason: 'invalid',
          kind: 'failed',
          attempts: { quota: 0, transient: 0 },
          body: null,
        },
      ],
    ]),
  }));
  const { instance } = jobs({ db, writer: source, reader: read });
  const answer = await instance.run(request, AbortSignal.timeout(5_000));
  assert.deepEqual(answer, { outcome: 'settled', status: 'needs-review' });
  const settled = db.settlements.at(-1)[0];
  assert.equal(settled.outcome, 'unknown');
  assert.equal(settled.googleStatus, 400);
  assert.equal(settled.googleReason, 'invalid');
  assert.equal(settled.verifiedBy, 'read-back');
});

test('a clear settles Succeeded only when the answer shows no value', async () => {
  // The answer holds no value, so the clear is proven and settles.
  const won = database({
    claims: [claimed([person(0, 'u1', null)]), claimed([])],
  });
  const wonWriter = writer((writes) => ({
    succeeded: new Map(
      writes.map((write) => [
        write.userId,
        [{ userId: write.userId, customSchemas: {} }],
      ]),
    ),
    failed: new Map(),
  }));
  const first = jobs({ db: won, writer: wonWriter });
  assert.deepEqual(
    await first.instance.run(request, AbortSignal.timeout(5_000)),
    { outcome: 'settled', status: 'completed' },
  );
  assert.equal(won.settlements[0][0].outcome, 'succeeded');
  assert.deepEqual(won.settlements[0][0].observed, {});
  // The answer still holds the value, so the clear is not proven.
  const differs = database({
    claims: [claimed([person(0, 'u1', null)]), claimed([])],
  });
  const differsWriter = writer((writes) => ({
    succeeded: new Map(
      writes.map((write) => [
        write.userId,
        [
          {
            userId: write.userId,
            customSchemas: { StudentInfo: { Homeroom: 'A' } },
          },
        ],
      ]),
    ),
    failed: new Map(),
  }));
  const second = jobs({ db: differs, writer: differsWriter });
  await second.instance.run(request, AbortSignal.timeout(5_000));
  assert.equal(differs.settlements[0][0].outcome, 'unknown');
  assert.equal(differs.settlements[0][0].failure, 'invalid-response');
});

test('a 404 settles Failed `not-found`, removes the user, and names the drafted text', async () => {
  const db = database({
    claims: [claimed([person(0, 'u1', 'A')]), claimed([])],
  });
  const store = cache();
  const source = writer(() => ({
    succeeded: new Map(),
    failed: new Map([
      [
        'u1',
        {
          status: 404,
          reason: 'notFound',
          kind: 'not-found',
          attempts: { quota: 0, transient: 0 },
          body: null,
        },
      ],
    ]),
  }));
  const { instance } = jobs({ db, writer: source, cache: store });
  const answer = await instance.run(request, AbortSignal.timeout(5_000));
  assert.deepEqual(answer, { outcome: 'settled', status: 'completed' });
  const settled = db.settlements[0][0];
  assert.equal(settled.outcome, 'failed');
  assert.equal(settled.failure, 'not-found');
  assert.equal(settled.reason, 'Google could not find this user.');
  assert.equal(settled.googleStatus, 404);
  // B section 13 and section 9: the user leaves the cache and the feed event names it removed.
  assert.deepEqual(store.calls.find((call) => call.name === 'remove')?.args, [
    [`cc:entity:user:${customerId}:u1`],
  ]);
  assert.deepEqual(
    store.calls.find((call) => call.name === 'publish')?.args[1].removedIds,
    ['u1'],
  );
});

test('a definitive envelope failure settles every part Failed with that code', async () => {
  const db = database({
    claims: [
      claimed([person(0, 'u1', 'A'), person(1, 'u2', 'B')]),
      claimed([]),
    ],
  });
  const source = writer(() => {
    throw Object.assign(new Error('forbidden'), { code: 'permission-denied' });
  });
  const { instance } = jobs({ db, writer: source });
  await instance.run(request, AbortSignal.timeout(5_000));
  assert.deepEqual(
    db.settlements[0].map((result) => [result.outcome, result.failure]),
    [
      ['failed', 'permission-denied'],
      ['failed', 'permission-denied'],
    ],
  );
});

test('an envelope that may have left stays Unknown for the read-back', async () => {
  const db = database({
    claims: [claimed([person(0, 'u1', 'A')]), claimed([])],
    readBacks: [{ outcome: 'done', status: 'needs-review' }],
    doneStatus: 'needs-review',
  });
  const source = writer(() => {
    throw Object.assign(new Error('timeout'), { code: 'network-failure' });
  });
  const { instance } = jobs({ db, writer: source });
  const answer = await instance.run(request, AbortSignal.timeout(5_000));
  assert.deepEqual(answer, { outcome: 'settled', status: 'needs-review' });
  assert.equal(db.settlements[0][0].outcome, 'unknown');
  assert.equal(db.settlements[0][0].failure, 'network-failure');
});

test('the send gate fences the envelope after a cancel', async () => {
  const db = database({
    claims: [claimed([person(0, 'u1', 'A')]), claimed([])],
    fenced: true,
  });
  const source = writer(() => ({
    succeeded: new Map(),
    failed: new Map(),
  }));
  const { instance } = jobs({ db, writer: source });
  const answer = await instance.run(request, AbortSignal.timeout(5_000));
  assert.deepEqual(answer, { outcome: 'fenced' });
  // The refused gate sends nothing and settles nothing.
  assert.equal(db.settlements.length, 0);
});

test('a claim that answers done ends the job without a settlement', async () => {
  const db = database({ claims: [{ outcome: 'done', status: 'cancelled' }] });
  const store = cache();
  const { instance } = jobs({ db, cache: store });
  assert.deepEqual(await instance.run(request, AbortSignal.timeout(5_000)), {
    outcome: 'settled',
    status: 'cancelled',
  });
  assert.equal(db.settlements.length, 0);
  assert.equal(store.calls.length, 0);
});

test('a claim that answers busy leaves the job to its owner', async () => {
  const db = database({ claims: [{ outcome: 'busy' }] });
  const { instance } = jobs({ db });
  assert.deepEqual(await instance.run(request, AbortSignal.timeout(5_000)), {
    outcome: 'busy',
  });
});

test('the reconcile of one Unknown operation settles it from the masked read', async () => {
  const db = database({
    oneOutcome: 'claimed',
    read: {
      outcome: 'read',
      ordinal: 4,
      generation: 1,
      credentialId: randomUUID(),
      envelope: { sealed: true },
      mask: ['StudentInfo'],
      fields: [field],
      user: person(4, 'u5', 'B'),
    },
  });
  const read = reader(() => values({ u5: { StudentInfo: { Homeroom: 'B' } } }));
  const { instance } = jobs({ db, reader: read });
  const answer = await instance.reconcile(
    { ...reconcileRequest, operationNumber: 5, verifyAttempt: randomUUID() },
    AbortSignal.timeout(5_000),
  );
  assert.deepEqual(answer, { outcome: 'settled', status: 'completed' });
  assert.deepEqual(read.calls[0], {
    ids: ['u5'],
    mask: ['StudentInfo'],
    aborted: false,
  });
  assert.equal(db.verifications[0][3], 4);
  assert.equal(db.verifications[0][4], 'succeeded');
});

test('a reconcile read that differs settles Failed `value-differs`', async () => {
  const db = database({
    read: {
      outcome: 'read',
      ordinal: 0,
      generation: 1,
      credentialId: randomUUID(),
      envelope: { sealed: true },
      mask: ['StudentInfo'],
      fields: [field],
      user: person(0, 'u1', 'A'),
    },
  });
  const read = reader(() => values({ u1: { StudentInfo: { Homeroom: 'C' } } }));
  const { instance } = jobs({ db, reader: read });
  await instance.reconcile(
    { ...reconcileRequest, operationNumber: 1 },
    AbortSignal.timeout(5_000),
  );
  assert.equal(db.verifications[0][4], 'failed');
  assert.equal(db.verifications[0][5], 'request-failed');
  assert.equal(db.verifications[0][6], 'value-differs');
});

test('a reconcile read that proves nothing keeps the operation Unknown', async () => {
  const db = database({
    read: {
      outcome: 'read',
      ordinal: 0,
      generation: 1,
      credentialId: randomUUID(),
      envelope: { sealed: true },
      mask: ['StudentInfo'],
      fields: [field],
      user: person(0, 'u1', 'A'),
    },
  });
  const read = reader(() => {
    throw new Error('read failed');
  });
  const { instance } = jobs({ db, reader: read });
  const answer = await instance.reconcile(
    { ...reconcileRequest, operationNumber: 1 },
    AbortSignal.timeout(5_000),
  );
  assert.deepEqual(answer, { outcome: 'settled', status: 'needs-review' });
  assert.equal(db.verifications[0][4], 'unknown');
});

test('a reconcile of a settled operation is fenced and reads nothing', async () => {
  const db = database({ read: { outcome: 'fenced' } });
  const read = reader(() => values({}));
  const { instance } = jobs({ db, reader: read });
  assert.deepEqual(
    await instance.reconcile(
      { ...reconcileRequest, operationNumber: 1 },
      AbortSignal.timeout(5_000),
    ),
    { outcome: 'fenced' },
  );
  assert.equal(read.calls.length, 0);
});

test('the value comparison reads the canonical form of each field type', () => {
  const numeric = { ...field, fieldType: 'INT64' };
  const email = { ...field, fieldType: 'EMAIL' };
  const flag = { ...field, fieldType: 'BOOL' };
  assert.equal(sameValue(10, '10', numeric), true);
  assert.equal(
    sameValue('Student@Example.org', 'student@example.org', email),
    true,
  );
  assert.equal(sameValue(true, 'true', flag), true);
  assert.equal(sameValue(null, null, field), true);
  assert.equal(sameValue(null, 'A', field), false);
  assert.equal(sameValue('A', null, field), false);
  assert.equal(
    sameValue([{ value: 'A' }, { value: 'B' }], ['A', 'B'], field),
    true,
  );
  assert.equal(
    sameValue([{ value: 'A' }, { value: 'B' }], ['B', 'A'], field),
    false,
  );
  assert.equal(
    changedValues({ StudentInfo: { Homeroom: 'A' } }, {}, [field]),
    true,
  );
  assert.equal(
    changedValues(
      { StudentInfo: { Homeroom: 'A' } },
      { StudentInfo: { Homeroom: 'A' } },
      [field],
    ),
    false,
  );
});

test('a part without an answer stays Unknown', () => {
  assert.equal(
    classifyPart(person(0, 'u1', 'A'), undefined, [field]).outcome,
    'unknown',
  );
  assert.equal(
    classifyPart(person(0, 'u1', 'A'), { observation: { userId: 'u1' } }, [
      field,
    ]).outcome,
    'unknown',
  );
});
