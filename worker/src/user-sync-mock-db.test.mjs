/**
 * Runs the K7 user sync against a synthetic PostgreSQL and the admin SDK mock.
 * It stores every mock user with its raw customSchemas answer, marks a 404 removed, and proves that an
 * older refresh read cannot clear a removal that a newer absence made. A repeated 404 and a newer
 * empty full sync each move the removal fence forward. A 404 that a newer presence read predates
 * reports no removal and evicts no cache key.
 * Docker and the qualified image in deployment/postgres/qualification.json are required.
 * Run the file inside `nx run worker:test`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { JWT } from 'google-auth-library';
import pg from 'pg';
import { startMock } from '@campuscommander/admin-sdk-mock';
import { GOOGLE_CAPABILITIES } from '@campus/application-contracts';
import {
  GoogleUserReader,
  validateServiceAccount,
} from '@campus/google-connection';
import {
  loadMigrations,
  migrate,
  provision,
} from '../../deployment/postgres/index.mjs';
import { EntitySyncBatch } from './entity-sync.ts';
import { UserSync } from './user-sync.ts';

const qualification = JSON.parse(
  await readFile(
    new URL('../../deployment/postgres/qualification.json', import.meta.url),
    'utf8',
  ),
);
const timeout = 120_000;
const scopes = [
  GOOGLE_CAPABILITIES.find((capability) => capability.id === 'user-inventory')
    .scope,
];

let mock;
let domain;
let credential;
let container;
let port;
let admin;
let migrator;
let runtime;

const user = (userId, email = `${userId}@example.org`) => ({
  userId,
  primaryEmail: email,
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
});

/** The reader stands in for Google. It returns the answer the test names. */
const answerReader = (answer) => ({
  deviceBatch: async () => [],
  batteryBatch: async () => new Map(),
  userBatch: async () => answer,
});

const cache = () => ({
  extendMembers: async () => undefined,
  removeMembers: async () => undefined,
  remove: async () => undefined,
  setRecords: async () => undefined,
  increment: async () => undefined,
  publish: async () => undefined,
});

/** A cache that records each call, so a test can assert the effects of one batch. */
const recordingCache = () => {
  const calls = { remove: [], setRecords: [], publish: [] };
  return {
    calls,
    extendMembers: async () => undefined,
    removeMembers: async () => undefined,
    remove: async (keys) => {
      calls.remove.push(keys);
    },
    setRecords: async (entries) => {
      calls.setRecords.push(entries.map((entry) => entry.key));
    },
    increment: async () => undefined,
    publish: async (_channel, message) => {
      calls.publish.push(JSON.parse(message));
    },
  };
};

const cipher = { open: () => credential };

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

async function pool(userName, database) {
  const value = new pg.Pool({
    host: '127.0.0.1',
    port,
    user: userName,
    database,
    ['password']: secret,
    max: 4,
    connectionTimeoutMillis: 2_000,
  });
  await value.query('SELECT 1');
  return value;
}

const secret = randomUUID() + randomUUID();
const subject = 'k7-user-sync@example.test';

async function connectAdmin() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const client = new pg.Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      database: 'postgres',
      ['password']: secret,
      connectionTimeoutMillis: 1_000,
    });
    try {
      await client.connect();
      return client;
    } catch {
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error('The synthetic PostgreSQL did not start.');
}

/** Read the raw Google user resources through the mock, without a Campus Commander reader. */
async function rawUsers() {
  const auth = new JWT({
    email: credential.serviceAccount.client_email,
    key: credential.serviceAccount.private_key,
    keyId: credential.serviceAccount.private_key_id,
    scopes,
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
    for (const raw of data.users ?? []) found.set(raw.id, raw);
    pageToken = data.nextPageToken;
    if (!pageToken) return found;
  }
  throw new Error('The user read never ended.');
}

before(async () => {
  container = `cc-k7-user-${randomUUID().slice(0, 8)}`;
  docker(
    'run',
    '-d',
    '--name',
    container,
    '--label',
    'campus-commander.test=CC-K7',
    '-e',
    ['POSTGRES_PASSWORD', secret].join('='),
    '-p',
    '127.0.0.1::5432',
    qualification.image,
  );
  port = Number(docker('port', container, '5432/tcp').split(':').at(-1));
  admin = await connectAdmin();
  const credentials = Object.fromEntries([
    ['password', secret],
    ['migrationPassword', secret],
  ]);
  await provision(admin, {
    application: {
      database: 'cc-app',
      role: 'cc-app',
      migrationRole: 'cc-migrator',
      ...credentials,
    },
    kestra: { database: 'cc-kestra', role: 'cc-kestra', ...credentials },
  });
  await admin.end();
  migrator = await pool('cc-migrator', 'cc-app');
  await migrate(migrator, {
    runtimeRole: 'cc-app',
    migrations: await loadMigrations(),
  });
  runtime = await pool('cc-app', 'cc-app');

  mock = await startMock();
  mock.useInProcess();
  domain = await mock.createDomain({
    tier: 'small',
    seed: 'k7-user-sync-db',
    customSchemas: true,
  });
  const key = mock.credential(domain.customerId, scopes);
  credential = {
    serviceAccount: validateServiceAccount(key, key.client_id),
    subject: domain.adminEmail,
  };
  await migrator.query(
    `INSERT INTO cc.application_principals(id,issuer,subject,display_name)
     VALUES($1,$2,$3,'K7 user sync fixture')`,
    [randomUUID(), 'https://k7.example.test', subject],
  );
  await migrator.query(
    `INSERT INTO cc.application_grants(principal_id,action,scope)
     SELECT id,'users:read',jsonb_build_object('kind','district','customerId',$2::text)
     FROM cc.application_principals WHERE issuer=$1 AND subject=$3`,
    ['https://k7.example.test', domain.customerId, subject],
  );
  const credentialId = randomUUID();
  await migrator.query(
    `INSERT INTO cc.google_credentials(id,generation,customer_id,envelope,client_id,delegated_subject)
     VALUES($1,1,$2,$3,'1234567890',$4)`,
    [
      credentialId,
      domain.customerId,
      JSON.stringify({
        format: 1,
        keyId: 'fixture',
        iv: 'abcdefghijklmnop',
        tag: 'abcdefghijklmnopqrstuv',
        ciphertext: 'Zml4dHVyZQ',
      }),
      domain.adminEmail,
    ],
  );
  await migrator.query(
    `INSERT INTO cc.google_connection(customer_id,credential_id,generation,observation,observed_at,confirmed_by,encryption_key_id)
     SELECT $1,$2,1,$3,now(),id,'fixture' FROM cc.application_principals WHERE issuer=$4 AND subject=$5`,
    [
      domain.customerId,
      credentialId,
      JSON.stringify({
        customerId: domain.customerId,
        primaryDomain: domain.primaryDomain,
        domains: [
          {
            name: domain.primaryDomain,
            primary: true,
            verified: true,
            aliases: [],
          },
        ],
      }),
      'https://k7.example.test',
      subject,
    ],
  );
});

after(async () => {
  await runtime?.end().catch(() => undefined);
  await migrator?.end().catch(() => undefined);
  await mock?.close().catch(() => undefined);
  if (container) docker('rm', '-f', container);
});

async function principal() {
  const { rows } = await migrator.query(
    'SELECT id,permission_version FROM cc.application_principals WHERE issuer=$1 AND subject=$2',
    ['https://k7.example.test', subject],
  );
  return rows[0];
}

/** A full sync header and claim, run by the worker. */
async function fullSync(
  syncId = randomUUID(),
  reader = new GoogleUserReader(),
) {
  const actor = await principal();
  await runtime.query(
    'SELECT cc.request_user_sync($1,$2,$3,1,$4,$5) AS result',
    [
      actor.id,
      actor.permission_version,
      domain.customerId,
      syncId,
      randomUUID(),
    ],
  );
  const state = await new UserSync(runtime, cipher, reader, cache()).run(
    {
      customerId: domain.customerId,
      syncId,
      correlationId: randomUUID(),
    },
    AbortSignal.timeout(timeout),
  );
  return state;
}

async function refresh(ids, reader, cacheImpl = cache()) {
  const actor = await principal();
  const jobId = randomUUID();
  await runtime.query(
    'SELECT cc.create_entity_sync_job($1,$2,$3,$4,$5,$6,$7,$8) AS result',
    [
      actor.id,
      actor.permission_version,
      domain.customerId,
      'user',
      JSON.stringify(ids),
      1000,
      jobId,
      randomUUID(),
    ],
  );
  const result = await new EntitySyncBatch(runtime, cipher, reader, cacheImpl, {
    sleep: async () => undefined,
    backoff: () => 0,
  }).run(
    {
      customerId: domain.customerId,
      jobId,
      batch: 0,
      correlationId: randomUUID(),
    },
    AbortSignal.timeout(timeout),
  );
  return result;
}

async function stored(userId) {
  const { rows } = await runtime.query(
    'SELECT removed_at,last_entity_sync FROM cc.users WHERE customer_id=$1 AND user_id=$2',
    [domain.customerId, userId],
  );
  return rows[0];
}

test('the full sync stores every mock user with its raw customSchemas answer', async () => {
  const before = await rawUsers();
  const state = await fullSync();
  assert.equal(state.failure, null);
  assert.equal(
    state.userCount,
    before.size,
    'every mock user is present after the sync',
  );
  const { rows } = await runtime.query(
    'SELECT user_id,primary_email,custom_schemas,removed_at FROM cc.users WHERE customer_id=$1 ORDER BY user_id',
    [domain.customerId],
  );
  assert.equal(rows.length, before.size);
  for (const row of rows) {
    const raw = before.get(row.user_id);
    assert.ok(raw, `the stored user ${row.user_id} is a mock user`);
    assert.equal(row.primary_email, raw.primaryEmail);
    assert.deepEqual(
      row.custom_schemas,
      raw.customSchemas ?? {},
      `the raw customSchemas of ${row.user_id} is stored unchanged`,
    );
    assert.equal(row.removed_at, null);
  }
});

test('a refresh marks a deleted user removed, and a later presence read restores it', async () => {
  const { rows } = await runtime.query(
    'SELECT user_id FROM cc.users WHERE customer_id=$1 ORDER BY user_id LIMIT 1',
    [domain.customerId],
  );
  const userId = rows[0].user_id;
  const missing = await refresh(
    [userId],
    answerReader({ users: [], missing: [userId] }),
  );
  assert.equal(missing.failure, null);
  assert.deepEqual(missing.removed, [userId]);
  assert.notEqual((await stored(userId)).removed_at, null);

  const restored = await refresh(
    [userId],
    answerReader({
      users: [user(userId, `k7-${userId}@example.org`)],
      missing: [],
    }),
  );
  assert.equal(restored.failure, null);
  assert.deepEqual(restored.updated, [userId]);
  assert.equal(
    (await stored(userId)).removed_at,
    null,
    'a later presence read restores the user',
  );
});

test('an older 404 read that a newer presence read precedes reports no removal and evicts no cache key', async () => {
  const { rows } = await runtime.query(
    `SELECT user_id FROM cc.users WHERE customer_id=$1 AND removed_at IS NULL
     ORDER BY user_id LIMIT 1`,
    [domain.customerId],
  );
  const userId = rows[0].user_id;
  const email = `k7-newer-${userId}@example.org`;
  const missingEntered = deferred();
  const missingRelease = deferred();
  const olderCache = recordingCache();
  const older = refresh(
    [userId],
    {
      deviceBatch: async () => [],
      batteryBatch: async () => new Map(),
      userBatch: async () => {
        missingEntered.resolve();
        await missingRelease.promise;
        return { users: [], missing: [userId] };
      },
    },
    olderCache,
  );
  await missingEntered.promise;
  // The newer presence read starts later, commits first, and stamps the row.
  const newerCache = recordingCache();
  const newer = await refresh(
    [userId],
    answerReader({ users: [user(userId, email)], missing: [] }),
    newerCache,
  );
  assert.equal(newer.failure, null);
  assert.deepEqual(newer.updated, [userId]);
  // The 404 now writes with its older observation. The store refuses it, and the batch reports
  // nothing: no removal result, no cache eviction, and no removal in its event.
  missingRelease.resolve();
  const refused = await older;
  assert.equal(refused.failure, null);
  assert.deepEqual(refused.updated, []);
  assert.deepEqual(refused.removed, [], 'the store refused the older removal');
  const storedRow = await runtime.query(
    'SELECT removed_at,primary_email FROM cc.users WHERE customer_id=$1 AND user_id=$2',
    [domain.customerId, userId],
  );
  assert.equal(
    storedRow.rows[0].removed_at,
    null,
    'the newer presence read keeps the user',
  );
  assert.equal(storedRow.rows[0].primary_email, email);
  assert.deepEqual(
    olderCache.calls.remove,
    [],
    'a refused removal evicts no cache key',
  );
  const olderEvent = olderCache.calls.publish.find(
    (event) => event.type === 'entity-batch',
  );
  assert.deepEqual(olderEvent.removedIds, []);
  assert.deepEqual(olderEvent.deviceIds, []);
  const newerEvent = newerCache.calls.publish.find(
    (event) => event.type === 'entity-batch',
  );
  assert.deepEqual(newerEvent.deviceIds, [userId]);
  assert.deepEqual(newerEvent.removedIds, []);
});

test('a repeated 404 advances the removal fence, so a held presence read cannot resurrect the user', async () => {
  // Seed the inventory, so the test does not depend on the tests before it.
  assert.equal((await fullSync()).failure, null);
  const { rows } = await runtime.query(
    `SELECT user_id FROM cc.users WHERE customer_id=$1 AND removed_at IS NULL
     ORDER BY user_id LIMIT 1`,
    [domain.customerId],
  );
  const userId = rows[0].user_id;
  const first = await refresh(
    [userId],
    answerReader({ users: [], missing: [userId] }),
  );
  assert.equal(first.failure, null);
  assert.deepEqual(first.removed, [userId]);
  const firstRemoval = (await stored(userId)).removed_at;
  assert.notEqual(firstRemoval, null, 'the first 404 removes the user');

  // A later successful refresh reads the user and holds its answer.
  const entered = deferred();
  const release = deferred();
  const held = refresh([userId], {
    deviceBatch: async () => [],
    batteryBatch: async () => new Map(),
    userBatch: async () => {
      entered.resolve();
      await release.promise;
      return { users: [user(userId, `k7-${userId}@example.org`)], missing: [] };
    },
  });
  await entered.promise;
  // A newer 404 completes while the presence read is held.
  const newer = await refresh(
    [userId],
    answerReader({ users: [], missing: [userId] }),
  );
  assert.equal(newer.failure, null);
  assert.deepEqual(newer.removed, [userId]);
  const advanced = (await stored(userId)).removed_at;
  assert.ok(
    advanced > firstRemoval,
    'the newer absence moves the tombstone forward',
  );
  // The held presence read is older than the newer absence, so it cannot restore the user.
  release.resolve();
  const olderRead = await held;
  assert.equal(olderRead.failure, null);
  assert.deepEqual(
    olderRead.updated,
    [],
    'the older presence read stores no user',
  );
  assert.equal(
    (await stored(userId)).removed_at.toISOString(),
    advanced.toISOString(),
    'the newest removal stays',
  );

  // A presence read newer than the newest absence still restores the user.
  const restored = await refresh(
    [userId],
    answerReader({
      users: [user(userId, `k7-${userId}@example.org`)],
      missing: [],
    }),
  );
  assert.equal(restored.failure, null);
  assert.deepEqual(restored.updated, [userId]);
  assert.equal((await stored(userId)).removed_at, null);
});

test('a newer full-sync absence advances the fence, so a held presence read cannot resurrect the user', async () => {
  // Seed the inventory, so the test does not depend on the tests before it.
  assert.equal((await fullSync()).failure, null);
  const { rows } = await runtime.query(
    `SELECT user_id FROM cc.users WHERE customer_id=$1 AND removed_at IS NULL
     ORDER BY user_id LIMIT 1`,
    [domain.customerId],
  );
  const userId = rows[0].user_id;
  const first = await refresh(
    [userId],
    answerReader({ users: [], missing: [userId] }),
  );
  assert.equal(first.failure, null);
  assert.deepEqual(first.removed, [userId]);
  const firstRemoval = (await stored(userId)).removed_at;
  assert.notEqual(firstRemoval, null, 'the 404 removes the user');

  // A later successful refresh reads the user and holds its answer.
  const entered = deferred();
  const release = deferred();
  const held = refresh([userId], {
    deviceBatch: async () => [],
    batteryBatch: async () => new Map(),
    userBatch: async () => {
      entered.resolve();
      await release.promise;
      return { users: [user(userId, `k7-${userId}@example.org`)], missing: [] };
    },
  });
  await entered.promise;
  // A newer full sync observes every user and returns none, so the absence is newer than the hold.
  const state = await fullSync(randomUUID(), {
    async *userPages() {
      yield* [];
    },
  });
  assert.equal(state.failure, null);
  assert.equal(state.userCount, 0);
  const advanced = (await stored(userId)).removed_at;
  assert.ok(
    advanced > firstRemoval,
    'the full-sync absence moves the tombstone forward',
  );
  release.resolve();
  const olderRead = await held;
  assert.equal(olderRead.failure, null);
  assert.deepEqual(
    olderRead.updated,
    [],
    'the older presence read stores no user',
  );
  assert.equal(
    (await stored(userId)).removed_at.toISOString(),
    advanced.toISOString(),
    'the newer full-sync removal stays',
  );

  // The mock still holds every user, so a fresh full sync restores the inventory for later tests.
  const restored = await fullSync();
  assert.equal(restored.failure, null);
  assert.equal((await stored(userId)).removed_at, null);
});

test('a repeated full-sync absence advances the fence, so a held presence read cannot resurrect the user', async () => {
  // Seed the inventory, so the test does not depend on the tests before it.
  assert.equal((await fullSync()).failure, null);
  const { rows } = await runtime.query(
    `SELECT user_id FROM cc.users WHERE customer_id=$1 AND removed_at IS NULL
     ORDER BY user_id LIMIT 1`,
    [domain.customerId],
  );
  const userId = rows[0].user_id;
  // The first empty full sync removes every user that the domain does not return.
  const first = await fullSync(randomUUID(), {
    async *userPages() {
      yield* [];
    },
  });
  assert.equal(first.failure, null);
  const firstRemoval = (await stored(userId)).removed_at;
  assert.notEqual(firstRemoval, null, 'the full sync removes the user');

  // A later successful refresh reads the user and holds its answer.
  const entered = deferred();
  const release = deferred();
  const held = refresh([userId], {
    deviceBatch: async () => [],
    batteryBatch: async () => new Map(),
    userBatch: async () => {
      entered.resolve();
      await release.promise;
      return { users: [user(userId, `k7-${userId}@example.org`)], missing: [] };
    },
  });
  await entered.promise;
  // A second empty full sync observes the absence again, after the held read.
  const second = await fullSync(randomUUID(), {
    async *userPages() {
      yield* [];
    },
  });
  assert.equal(second.failure, null);
  const advanced = (await stored(userId)).removed_at;
  assert.ok(
    advanced > firstRemoval,
    'the repeated absence moves the tombstone forward',
  );
  release.resolve();
  const olderRead = await held;
  assert.equal(olderRead.failure, null);
  assert.deepEqual(
    olderRead.updated,
    [],
    'the older presence read stores no user',
  );
  assert.equal(
    (await stored(userId)).removed_at.toISOString(),
    advanced.toISOString(),
    'the repeated full-sync removal stays',
  );

  const restored = await fullSync();
  assert.equal(restored.failure, null);
  assert.equal((await stored(userId)).removed_at, null);
});

test('an older refresh read cannot clear a removal that a newer full sync made', async () => {
  const { rows } = await runtime.query(
    `SELECT user_id FROM cc.users WHERE customer_id=$1 AND removed_at IS NULL
     ORDER BY user_id LIMIT 1`,
    [domain.customerId],
  );
  const userId = rows[0].user_id;
  // The user returns in the refresh, and the read waits until a newer full sync removes it.
  const entered = deferred();
  const release = deferred();
  const held = refresh([userId], {
    deviceBatch: async () => [],
    batteryBatch: async () => new Map(),
    userBatch: async () => {
      entered.resolve();
      await release.promise;
      return { users: [user(userId, `k7-${userId}@example.org`)], missing: [] };
    },
  });
  await entered.promise;
  const state = await fullSync(randomUUID(), {
    async *userPages() {
      // The domain answers no users, so the full sync removes every user it does not see.
      yield* [];
    },
  });
  assert.equal(state.failure, null);
  const removed = (await stored(userId)).removed_at;
  assert.notEqual(removed, null, 'the newer full sync marks the user removed');
  release.resolve();
  const older = await held;
  assert.equal(older.failure, null);
  assert.equal(
    (await stored(userId)).removed_at.toISOString(),
    removed.toISOString(),
    'the older refresh read leaves the newer removal in place',
  );
  assert.deepEqual(older.updated, [], 'the older read writes no user row');

  const later = await refresh(
    [userId],
    answerReader({
      users: [user(userId, `k7-${userId}@example.org`)],
      missing: [],
    }),
  );
  assert.equal(later.failure, null);
  assert.deepEqual(later.updated, [userId]);
  assert.equal(
    (await stored(userId)).removed_at,
    null,
    'a read newer than the removal restores the user',
  );
});
