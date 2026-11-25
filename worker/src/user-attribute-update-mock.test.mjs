/**
 * K24: every row of B section 7.3 against admin-sdk-mock 0.4.0. The real value writer sends the
 * PATCH and PUT parts and the real masked reader answers the read-back, so each outcome comes from
 * a real batch answer. The mock runs in process, and the store is a scripted fake. No live Google
 * call runs here.
 *
 * Run the file inside `nx run worker:test`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { startMock } from '@campuscommander/admin-sdk-mock';
import { GOOGLE_CAPABILITIES } from '@campus/application-contracts';
import {
  GoogleBatchService,
  GoogleUserReader,
  GoogleUserWriter,
  validateServiceAccount,
} from '@campus/google-connection';
import { UserAttributeUpdateJobs } from './user-attribute-update.ts';

const scopeOf = (id) =>
  GOOGLE_CAPABILITIES.find((capability) => capability.id === id).scope;
const timeout = 60_000;
const field = {
  schemaName: 'StudentInfo',
  fieldName: 'Homeroom',
  fieldType: 'STRING',
  multiValued: false,
};
const stamp = new Date('2026-11-25T12:00:00.000Z');

let mock;
let domain;
let credential;
let reader;
let writer;
let person;

/**
 * A batch service on a virtual clock: a retry wait advances the clock instead of sleeping, so a
 * quota test runs 25 retries at once and never waits a real backoff.
 */
class QuickBatch extends GoogleBatchService {
  constructor() {
    let time = Date.parse('2026-11-25T12:00:00.000Z');
    super({
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
    });
  }
}

function signal() {
  return AbortSignal.timeout(timeout);
}

/** A delegated credential whose grant holds these scopes. */
function credentialFor(scopes) {
  const key = mock.credential(domain.customerId, scopes);
  return {
    serviceAccount: validateServiceAccount(key, key.client_id),
    subject: domain.adminEmail,
  };
}

/** One claimed user of the preview, with the final value of the changed attribute. */
const claimedUser = (ordinal, userId, value) => ({
  ordinal,
  userId,
  primaryEmail: `${userId}@example.org`,
  customSchemas: { StudentInfo: { Homeroom: value } },
});

/**
 * A scripted store. The claim answers the envelope under test, the settlement records its results,
 * and a read-back claim answers the scripted read. Every call keeps its values.
 */
function store({
  users,
  readBacks = [],
  read = null,
  claimOne = 'claimed',
} = {}) {
  const calls = [];
  const settlements = [];
  const stops = [];
  const claims =
    users === undefined
      ? []
      : [users, { outcome: 'done', status: 'completed' }];
  const readQueue = [...readBacks];
  return {
    calls,
    settlements,
    stops,
    async query(sql, values) {
      const name = (/cc\.(\w+)/.exec(sql) ?? /(\w+)\(\)/.exec(sql))[1];
      calls.push({ name, values });
      switch (name) {
        case 'clock_timestamp':
          return { rows: [{ result: stamp }] };
        case 'begin_user_attribute_write':
          return { rows: [{ result: { outcome: 'writing' } }] };
        case 'extend_user_attribute_attempt':
          return { rows: [{ result: { outcome: 'extended' } }] };
        case 'claim_user_attribute_updates': {
          const next = claims.shift() ?? {
            outcome: 'done',
            status: 'completed',
          };
          return { rows: [{ result: next }] };
        }
        case 'settle_user_attribute_updates': {
          const results = JSON.parse(String(values[4]));
          settlements.push(results);
          return {
            rows: [
              {
                result: {
                  outcome: 'settled',
                  status: 'running',
                  changed: [],
                  removed: [],
                  remaining: false,
                },
              },
            ],
          };
        }
        case 'claim_user_attribute_verification': {
          const next = readQueue.shift() ?? {
            outcome: 'done',
            status: 'needs-review',
          };
          return { rows: [{ result: next }] };
        }
        case 'claim_user_attribute_verification_one':
          return { rows: [{ result: { outcome: claimOne } }] };
        case 'read_user_attribute_verification':
          return { rows: [{ result: read }] };
        case 'settle_user_attribute_verification': {
          settlements.push(values);
          return {
            rows: [
              {
                result: {
                  outcome: 'settled',
                  status: 'needs-review',
                  changed: [],
                  removed: [],
                  outcomeOf: values[4],
                },
              },
            ],
          };
        }
        case 'stop_user_attribute_job': {
          stops.push(values);
          return {
            rows: [
              {
                result: { outcome: 'stopped', status: 'failed' },
              },
            ],
          };
        }
        case 'finish_user_attribute_job':
          return {
            rows: [{ result: { outcome: 'finished', status: 'needs-review' } }],
          };
        default:
          throw new Error(`unexpected call ${name}`);
      }
    },
  };
}

/** One run of the job against the mock. */
function job(fake, options = {}) {
  return new UserAttributeUpdateJobs(
    fake,
    { open: () => credential },
    {
      writer,
      reader,
      writeTimeoutMilliseconds: options.writeTimeoutMilliseconds ?? 5_000,
      readTimeoutMilliseconds: 5_000,
      sleep: async () => undefined,
    },
  );
}

const request = () => ({
  customerId: domain.customerId,
  jobId: randomUUID(),
  dispatchToken: randomUUID(),
  correlationId: randomUUID(),
});

const envelope = (users, extra = {}) => ({
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

/** Add one fault rule to the mock, in the order the mock checks them. */
const fault = (rule) =>
  mock.control('POST', `/domains/${domain.customerId}/faults`, rule);

before(async () => {
  mock = await startMock();
  mock.useInProcess();
  domain = await mock.createDomain({
    tier: 'small',
    seed: 'k24-value-jobs',
    customSchemas: true,
  });
  credential = credentialFor([
    scopeOf('user-inventory'),
    scopeOf('user-changes'),
  ]);
  const batch = new QuickBatch();
  reader = new GoogleUserReader({ batch });
  writer = new GoogleUserWriter({ batch });
  const users = [];
  for await (const page of reader.userPages(
    credential,
    domain.customerId,
    signal(),
  ))
    users.push(...page);
  // A student that holds a Homeroom, so each write changes a real value.
  person =
    users.find(
      (user) => user.customSchemas?.StudentInfo?.Homeroom !== undefined,
    ) ?? users[0];
  assert.ok(person !== undefined, 'The seed holds a user.');
});

after(async () => {
  await mock?.close();
});

// Each test starts with no fault rule, so one case never inherits another.
beforeEach(async () => {
  await mock.control('DELETE', `/domains/${domain.customerId}/faults`);
});

test('a 2xx answer with the requested values settles Succeeded', async () => {
  const fake = store({
    users: envelope([claimedUser(0, person.userId, 'B12')]),
  });
  const answer = await job(fake).run(request(), signal());
  assert.deepEqual(answer, { outcome: 'settled', status: 'completed' });
  const [settled] = fake.settlements;
  assert.equal(settled[0].outcome, 'succeeded');
  assert.equal(settled[0].verifiedBy, 'write-response');
  assert.equal(settled[0].observed.StudentInfo.Homeroom, 'B12');
});

test('a 2xx clear answer with no value settles Succeeded', async () => {
  const fake = store({
    users: envelope([claimedUser(0, person.userId, null)]),
  });
  const answer = await job(fake).run(request(), signal());
  assert.deepEqual(answer, { outcome: 'settled', status: 'completed' });
  const [settled] = fake.settlements;
  assert.equal(settled[0].outcome, 'succeeded');
  assert.equal(settled[0].observed.StudentInfo?.Homeroom, undefined);
});

test('a first-attempt 400 settles Failed with its Google reason', async () => {
  await fault({
    kind: 'status',
    method: 'directory.users.patch',
    status: 400,
    reason: 'invalid',
    count: 1,
  });
  const fake = store({
    users: envelope([claimedUser(0, person.userId, 'B14')]),
  });
  await job(fake).run(request(), signal());
  const [settled] = fake.settlements;
  assert.equal(settled[0].outcome, 'failed');
  assert.equal(settled[0].failure, 'request-failed');
  assert.equal(settled[0].googleStatus, 400);
  assert.equal(settled[0].googleReason, 'invalid');
});

for (const status of [409, 412]) {
  test(`a first-attempt ${status} settles Failed with its Google reason`, async () => {
    await fault({
      kind: 'status',
      method: 'directory.users.patch',
      status,
      reason: 'conditionNotMet',
      count: 1,
    });
    const fake = store({
      users: envelope([claimedUser(0, person.userId, 'B15')]),
    });
    await job(fake).run(request(), signal());
    const [settled] = fake.settlements;
    assert.equal(settled[0].outcome, 'failed');
    assert.equal(settled[0].googleStatus, status);
    assert.equal(settled[0].googleReason, 'conditionNotMet');
  });
}

test('a first-attempt 404 settles Failed `not-found` and names the drafted text', async () => {
  await fault({
    kind: 'status',
    method: 'directory.users.patch',
    status: 404,
    reason: 'notFound',
    count: 1,
  });
  const fake = store({
    users: envelope([claimedUser(0, person.userId, 'B16')]),
  });
  await job(fake).run(request(), signal());
  const [settled] = fake.settlements;
  assert.equal(settled[0].outcome, 'failed');
  assert.equal(settled[0].failure, 'not-found');
  assert.equal(settled[0].reason, 'Google could not find this user.');
  assert.equal(settled[0].googleStatus, 404);
});

test('an exhausted quota settles Failed `quota`', { timeout }, async () => {
  // One answer for each attempt: the part keeps its quota retries, so the last one is definitive.
  await fault({
    kind: 'status',
    method: 'directory.users.patch',
    status: 429,
    reason: 'rateLimitExceeded',
    count: 40,
  });
  const fake = store({
    users: envelope([claimedUser(0, person.userId, 'B17')]),
  });
  await job(fake).run(request(), signal());
  const [settled] = fake.settlements;
  assert.equal(settled[0].outcome, 'failed');
  assert.equal(settled[0].failure, 'quota');
  assert.equal(settled[0].googleStatus, 429);
});

test('a refusal after a transient retry stays Unknown for the read-back', async () => {
  // The transient answer comes first, so the refusal follows a retry of the same part.
  await fault({
    kind: 'status',
    method: 'directory.users.patch',
    status: 503,
    reason: 'backendError',
    count: 1,
  });
  await fault({
    kind: 'status',
    method: 'directory.users.patch',
    status: 400,
    reason: 'invalid',
    count: 1,
  });
  const fake = store({
    users: envelope([claimedUser(0, person.userId, 'B18')]),
    readBacks: [{ outcome: 'claimed', users: [], remaining: 0 }],
  });
  await job(fake).run(request(), signal());
  const [settled] = fake.settlements;
  assert.equal(settled[0].outcome, 'unknown');
  assert.equal(settled[0].googleStatus, 400);
  assert.notEqual(settled[0].reason, 'Google could not find this user.');
});

test('a returned auth answer settles Failed and stops the job', async () => {
  await fault({
    kind: 'status',
    method: 'directory.users.patch',
    status: 403,
    reason: 'forbidden',
    count: 1,
  });
  const fake = store({
    users: envelope([claimedUser(0, person.userId, 'B19')]),
  });
  const answer = await job(fake).run(request(), signal());
  assert.deepEqual(answer, { outcome: 'settled', status: 'failed' });
  const [settled] = fake.settlements;
  assert.equal(settled[0].outcome, 'failed');
  assert.equal(settled[0].failure, 'permission-denied');
  assert.equal(fake.stops.length, 1);
  assert.equal(fake.stops[0][4], 'permission-denied');
  assert.equal(fake.stops[0][5], false);
});

test('a read-back that answers 400 `invalid` keeps the operation Unknown (C10)', async () => {
  const operation = {
    outcome: 'read',
    ordinal: 0,
    generation: 1,
    credentialId: randomUUID(),
    envelope: { sealed: true },
    // The second category is not in the mock, so its mask answers 400 `invalid` (C10).
    mask: ['StudentInfo', 'K24MissingCategory'],
    fields: [field],
    user: claimedUser(0, person.userId, 'B20'),
  };
  const fake = store({ read: operation });
  const answer = await job(fake).reconcile(
    {
      customerId: domain.customerId,
      jobId: randomUUID(),
      operationNumber: 1,
      verifyAttempt: randomUUID(),
      correlationId: randomUUID(),
    },
    signal(),
  );
  assert.deepEqual(answer, { outcome: 'settled', status: 'needs-review' });
  const settled = fake.settlements.at(-1);
  assert.equal(settled[4], 'unknown');
  assert.equal(settled[5], 'request-failed');
  assert.equal(settled[6], 'verification-failed');
  assert.equal(settled[7], 400);
  assert.equal(settled[8], 'invalid');
});
