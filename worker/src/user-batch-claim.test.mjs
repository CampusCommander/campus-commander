/**
 * R2: a user refresh batch extends its in-flight claim on every batch service round, through the
 * production reader adapter. A quota wave longer than the 120-second claim lifetime keeps the claim.
 * No live Google call runs here: the transport is the repository batch fake.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';
import { JWT, OAuth2Client } from 'google-auth-library';
import {
  entitySyncBatchRequestSchema,
  inflightKey,
} from '@campus/application-contracts';
import {
  GoogleBatchService,
  GoogleUserReader,
} from '@campus/google-connection';
import { fakeGoogle } from '../../libs/google-connection/src/lib/batch-fake.mjs';
import { EntitySyncBatch } from './entity-sync.ts';
import { createEntityReader } from './entity-reader.ts';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
});
const credential = {
  subject: 'fixture@example.invalid',
  serviceAccount: {
    client_email: 'fixture@project.iam.gserviceaccount.com',
    private_key: privateKey,
    private_key_id: 'fixture',
  },
};
const customerId = 'C0123456';
const jobId = randomUUID();
const request = entitySyncBatchRequestSchema.parse({
  customerId,
  jobId,
  batch: 0,
  correlationId: randomUUID(),
});
const tokenExpiry = Date.now() + 3_500_000;
/** Three quota rounds, then one success. Each retry round advances the virtual clock by a minute. */
const quotaRounds = 3;
const roundMilliseconds = 60_000;
const claimMilliseconds = 120;

const user = {
  id: 'u1',
  primaryEmail: 'u1@example.org',
  orgUnitPath: '/Students',
  name: { givenName: 'Robin', familyName: 'Avery', fullName: 'Robin Avery' },
  suspended: false,
  archived: false,
  isEnrolledIn2Sv: true,
  aliases: [],
  customSchemas: { StudentInfo: { GradeLevel: 7 } },
};

function database() {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      const name = (/cc\.(\w+)/.exec(sql) ?? /(\w+)\(\)/.exec(sql))[1];
      calls.push({ name, values });
      if (name === 'read_entity_sync_batch')
        return {
          rows: [
            {
              result: {
                generation: 1,
                credentialId: randomUUID(),
                envelope: { sealed: true },
                batchCount: 1,
                entityType: 'user',
                ids: ['u1'],
              },
            },
          ],
        };
      if (name === 'clock_timestamp') return { rows: [{ result: new Date() }] };
      if (name === 'job_cancel_requested') return { rows: [{ result: false }] };
      if (name === 'read_user_records')
        return {
          rows: [
            {
              result: JSON.parse(values[1]).map((userId) => ({
                version: 1,
                record: {
                  userId,
                  primaryEmail: `${userId}@example.org`,
                  orgUnitPath: '/Students',
                  givenName: 'Robin',
                  familyName: 'Avery',
                  fullName: 'Robin Avery',
                  suspended: false,
                  suspensionReason: null,
                  archived: false,
                  lastLoginTime: null,
                  creationTime: null,
                  twoStepEnrolled: true,
                  department: null,
                  title: null,
                  aliases: [],
                  customSchemas: { StudentInfo: { GradeLevel: 7 } },
                  lastEntitySync: new Date(
                    Date.now() - 3_600_000,
                  ).toISOString(),
                },
              })),
            },
          ],
        };
      if (name === 'finish_entity_sync_batch')
        return {
          rows: [
            {
              result: {
                jobId,
                customerId,
                entityType: 'user',
                batchCount: 1,
                completedBatches: 1,
                failedBatches: 0,
                failure: null,
                createdAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
              },
            },
          ],
        };
      return { rows: [{ result: 1 }] };
    },
  };
}

function cache() {
  const calls = [];
  const note =
    (name) =>
    async (...args) =>
      void calls.push({ name, args });
  return {
    calls,
    setRecords: note('setRecords'),
    remove: note('remove'),
    removeMembers: note('removeMembers'),
    extendMembers: note('extendMembers'),
    increment: note('increment'),
    publish: note('publish'),
    close: async () => undefined,
  };
}

test('a user quota wave renews the batch claim on every round through the production reader', async (t) => {
  let virtualNow = Date.now();
  t.mock.method(JWT.prototype, 'getAccessToken', async function () {
    return { token: 'private-fixture-token' };
  });
  t.mock.method(JWT.prototype, 'getTokenInfo', async function () {
    return { scopes: [...this.scopes], expiry_date: tokenExpiry };
  });
  const google = fakeGoogle((_part, round) =>
    round < quotaRounds
      ? {
          status: 429,
          body: { error: { errors: [{ reason: 'quotaExceeded' }] } },
        }
      : { status: 200, body: user },
  );
  t.mock.method(OAuth2Client.prototype, 'request', (options) =>
    google.client.request(options),
  );
  const batch = new GoogleBatchService({
    now: () => virtualNow,
    // One retry round stands for a minute. Three rounds pass the claim lifetime of two minutes.
    sleep: async () => {
      virtualNow += roundMilliseconds;
    },
    random: () => 0.5,
  });
  const redis = cache();
  const store = database();
  const startedAt = virtualNow;
  const result = await new EntitySyncBatch(
    store,
    { open: () => credential },
    createEntityReader(undefined, new GoogleUserReader({ batch })),
    redis,
    { sleep: async () => undefined, backoff: () => 0 },
  ).run(request, AbortSignal.timeout(30_000));
  assert.equal(result.failure, null);
  assert.deepEqual(result.updated, ['u1']);
  const extensions = redis.calls.filter(
    (call) => call.name === 'extendMembers',
  );
  assert.equal(
    extensions.length,
    quotaRounds + 1,
    'each batch service round renews the claim, including the successful round',
  );
  for (const extension of extensions)
    assert.deepEqual(extension.args, [
      inflightKey('user', customerId),
      ['u1'],
      claimMilliseconds,
    ]);
  assert.ok(
    virtualNow - startedAt > claimMilliseconds * 1_000,
    'the quota wave outlasts the claim lifetime, so only the renewals keep it',
  );
});
