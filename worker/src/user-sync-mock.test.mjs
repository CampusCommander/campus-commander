/**
 * One full user sync against admin-sdk-mock (design card K7, acceptance 1).
 * The mock answers users.list in process. No live Google call runs here.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { JWT } from 'google-auth-library';
import { startMock } from '@campuscommander/admin-sdk-mock';
import {
  GoogleUserReader,
  validateServiceAccount,
} from '@campus/google-connection';
import { GOOGLE_CAPABILITIES } from '@campus/application-contracts';
import { UserSync } from './user-sync.ts';

const scopes = ['user-inventory', 'user-schemas'].map(
  (id) => GOOGLE_CAPABILITIES.find((capability) => capability.id === id).scope,
);
const customerId = 'C0123456';
const timeout = 60_000;

let mock;
let domain;
let credential;
let staged;

/** The cache stand-in of the mock test. The mock is the subject, so no call is recorded. */
const cache = {
  publish: async () => undefined,
  increment: async () => undefined,
  remove: async () => undefined,
  removeMembers: async () => undefined,
  extendMembers: async () => undefined,
  setRecords: async () => undefined,
  close: async () => undefined,
};

/** A database that answers the full sync path and keeps every staged page. */
function database() {
  return {
    async query(sql, values) {
      const name = (/cc\.(\w+)/.exec(sql) ?? /(\w+)\(\)/.exec(sql))[1];
      if (name === 'claim_user_sync')
        return {
          rows: [
            {
              result: {
                generation: 1,
                credentialId: randomUUID(),
                envelope: { sealed: true },
              },
            },
          ],
        };
      if (name === 'stage_users') {
        staged.push(...JSON.parse(values[3]));
        return { rows: [{ result: 1 }] };
      }
      if (name === 'finish_user_sync')
        return {
          rows: [
            {
              result: {
                customerId: values[0],
                generation: 1,
                status: 'ready',
                observedAt: new Date().toISOString(),
                userCount: staged.length,
                failure: null,
                startedAt: new Date().toISOString(),
                checkedAt: new Date().toISOString(),
                stale: false,
              },
            },
          ],
        };
      if (name === 'page_last_removed_user_ids')
        return { rows: [{ result: [] }] };
      if (name === 'page_user_records') return { rows: [{ result: [] }] };
      return { rows: [{ result: 1 }] };
    },
  };
}

/** Read the raw user resources with an unmodified Google client. */
async function rawUsers() {
  const auth = new JWT({
    email: credential.serviceAccount.client_email,
    key: credential.serviceAccount.private_key,
    keyId: credential.serviceAccount.private_key_id,
    scopes: [scopes[0]],
    subject: credential.subject,
  });
  const found = new Map();
  let pageToken;
  for (let page = 0; page < 100; page += 1) {
    const url = new URL(
      'https://admin.googleapis.com/admin/directory/v1/users',
    );
    url.searchParams.set('customer', domain.customerId);
    url.searchParams.set('projection', 'full');
    url.searchParams.set('maxResults', '500');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const { data } = await auth.request({ url: url.href, method: 'GET' });
    for (const user of data.users ?? []) found.set(user.id, user);
    pageToken = data.nextPageToken;
    if (!pageToken) return found;
  }
  throw new Error('The user read never ended.');
}

before(async () => {
  mock = await startMock();
  // The proxy and its CA route every Google client of this process to the mock.
  mock.useInProcess();
  domain = await mock.createDomain({
    tier: 'small',
    seed: 'user-sync-fixture',
    customSchemas: true,
  });
  const key = mock.credential(domain.customerId, scopes);
  credential = {
    serviceAccount: validateServiceAccount(key, key.client_id),
    subject: domain.adminEmail,
  };
  staged = [];
});

after(async () => {
  await mock?.close();
});

test('the full sync stages every mock user once with its raw customSchemas', async () => {
  const state = await new UserSync(
    database(),
    { open: () => credential },
    new GoogleUserReader(),
    cache,
  ).run(
    {
      customerId: domain.customerId,
      syncId: randomUUID(),
      correlationId: randomUUID(),
    },
    AbortSignal.timeout(timeout),
  );
  const listed = (await mock.control('GET', '/domains')).find(
    (entry) => entry.customerId === domain.customerId,
  );
  assert.ok(listed, 'the mock reports the seeded domain');
  assert.equal(
    staged.length,
    listed.counts.users,
    'the sync stages the user count the mock reports',
  );
  assert.equal(
    new Set(staged.map((user) => user.userId)).size,
    staged.length,
    'every user appears once',
  );
  assert.equal(state.userCount, staged.length);
  const raw = await rawUsers();
  for (const user of staged)
    assert.deepEqual(
      user.customSchemas,
      raw.get(user.userId).customSchemas,
      `user ${user.userId} keeps the raw customSchemas answer`,
    );
});
