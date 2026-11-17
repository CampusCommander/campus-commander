import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QUERY_CACHE_SECONDS,
  queryCacheKey,
  queryGenerationKey,
  entityKey,
} from '@campus/application-contracts';
import { UserPager, userQueryHash } from './user-pager.ts';

const customer = 'C0123456';
const now = Date.parse('2026-11-17T12:00:00.000Z');

const user = (id, overrides = {}) => ({
  user_id: id,
  primary_email: `${id}@example.org`,
  org_unit_path: '/Students',
  given_name: 'Robin',
  family_name: 'Avery',
  full_name: `User ${id}`,
  suspended: false,
  suspension_reason: null,
  archived: false,
  last_login_time: null,
  creation_time: '2026-11-01T00:00:00.000Z',
  two_step_enrolled: true,
  department: null,
  title: null,
  aliases: [],
  custom_schemas: {},
  last_entity_sync: '2026-11-16T00:00:00.000Z',
  removed_at: null,
  record_version: 1,
  ...overrides,
});

const query = (overrides = {}) => ({
  predicates: [],
  sort: { field: 'fullName', direction: 'asc' },
  offset: 0,
  limit: 100,
  ...overrides,
});

function fakeCache(seed = {}) {
  const values = new Map(Object.entries(seed));
  const lists = new Map();
  const calls = { get: [], getMany: 0, listSlice: [], replaceList: [] };
  const cache = {
    calls,
    values,
    lists,
    async get(key) {
      calls.get.push(key);
      return values.get(key) ?? null;
    },
    async getMany(keys) {
      calls.getMany += 1;
      return keys.map((key) => values.get(key) ?? null);
    },
    async listSlice(key, start, count) {
      calls.listSlice.push([key, start, count]);
      const list = lists.get(key);
      if (!list) return { length: 0, ids: [] };
      return {
        length: list.length,
        ids: list.slice(start, start + count),
      };
    },
    async replaceList(key, ids, seconds) {
      calls.replaceList.push([key, ids, seconds]);
      lists.set(key, [...ids]);
    },
    async remove(key) {
      lists.delete(key);
    },
  };
  return cache;
}

/** A stand-in Postgres that answers each statement the pager writes. */
function fakeRows(users, options = {}) {
  const issued = [];
  const rows = async (statement) => {
    issued.push(statement.text);
    if (statement.text.includes('count(*)::integer AS matching'))
      return [{ matching: options.matching ?? users.length }];
    if (statement.text.includes('count(*)::integer AS stale'))
      return [{ stale: options.stale ?? 0 }];
    if (statement.text.includes('AS stale'))
      return (options.staleIds ?? []).map((user_id) => ({ user_id }));
    if (statement.text.includes('u.last_entity_sync<'))
      return (options.staleIds ?? []).map((user_id) => ({ user_id }));
    if (statement.text.includes('requested')) {
      const ids = statement.values[1];
      const requested = statement.values[2];
      return ids.flatMap((id, index) => {
        const found = users.find((row) => row.user_id === id);
        if (!found) return [];
        // The statement selects the record columns only when the entry version is absent or
        // outdated, and always selects the current version (R1).
        const entryVersion = options.versions?.[id] ?? found.record_version;
        const requestedVersion = requested[index];
        const changed =
          requestedVersion === null ||
          String(requestedVersion) !== String(entryVersion);
        return [
          changed
            ? {
                ...found,
                entry_version: entryVersion,
                record_version: entryVersion,
              }
            : {
                user_id: id,
                entry_version: entryVersion,
                record_version: entryVersion,
              },
        ];
      });
    }
    if (
      statement.text.includes('ORDER BY u.full_name') &&
      !statement.text.includes('OFFSET')
    )
      return (options.cachedIds ?? users.map((row) => row.user_id)).map(
        (user_id) => ({ user_id }),
      );
    if (statement.text.includes('OFFSET')) {
      const [offset, limit] = [
        statement.values.at(-2),
        statement.values.at(-1),
      ];
      return users
        .slice(Number(offset), Number(offset) + Number(limit))
        .map((row) => ({ ...row }));
    }
    return [];
  };
  return { rows, issued };
}

const entry = (record, version) => JSON.stringify({ version, record });

test('a cache miss reads the count, the stale set, and the ordered ID list', async () => {
  const users = [user('u1'), user('u2'), user('u3')];
  const cache = fakeCache();
  const { rows, issued } = fakeRows(users);
  const pager = new UserPager(cache);
  const read = await pager.page({
    customerId: customer,
    connectionGeneration: 2,
    actor: ['p1', 1],
    query: query({ limit: 2 }),
    selection: null,
    rows,
    now,
  });
  assert.equal(read.matching, 3);
  assert.deepEqual(
    read.rows.map((row) => row.userId),
    ['u1', 'u2'],
  );
  assert.equal(cache.calls.replaceList.length, 1);
  assert.equal(cache.calls.replaceList[0][2], QUERY_CACHE_SECONDS);
  assert.equal(cache.calls.replaceList[0][1].length, 3);
  assert.equal(
    issued.some((text) => text.includes('count(*)::integer AS matching')),
    true,
  );
});

test('a later page turns without reading the count again', async () => {
  const users = [user('u1'), user('u2'), user('u3')];
  const cache = fakeCache({
    [queryGenerationKey('user', customer)]: '7',
  });
  const key = queryCacheKey(
    'user',
    customer,
    '7',
    userQueryHash({
      actor: ['p1', 1],
      connectionGeneration: 2,
      query: query(),
    }),
  );
  cache.lists.set(key, ['u1', 'u2', 'u3']);
  const { rows, issued } = fakeRows(users);
  const pager = new UserPager(cache);
  const read = await pager.page({
    customerId: customer,
    connectionGeneration: 2,
    actor: ['p1', 1],
    query: query({ offset: 2, limit: 1 }),
    selection: null,
    rows,
    now,
  });
  assert.equal(
    issued.some((text) => text.includes('AS matching')),
    false,
  );
  assert.deepEqual(
    read.rows.map((row) => row.userId),
    ['u3'],
  );
  assert.equal(cache.calls.listSlice[0][1], 2);
});

test('paging is not part of the query hash', () => {
  const base = { actor: ['p1', 1], connectionGeneration: 2 };
  assert.equal(
    userQueryHash({ ...base, query: query({ offset: 0, limit: 100 }) }),
    userQueryHash({ ...base, query: query({ offset: 500, limit: 50 }) }),
  );
  assert.notEqual(
    userQueryHash({ ...base, query: query() }),
    userQueryHash({
      ...base,
      query: query({ predicates: [{ field: 'title', operator: 'isEmpty' }] }),
    }),
  );
  assert.notEqual(
    userQueryHash({ ...base, query: query() }),
    userQueryHash({ ...base, connectionGeneration: 3, query: query() }),
  );
  assert.notEqual(
    userQueryHash({ ...base, query: query() }),
    userQueryHash({ ...base, actor: ['p2', 1], query: query() }),
  );
});

test('a current entry serves its record and a stale version does not', async () => {
  const users = [user('u1'), user('u2', { record_version: 5 })];
  const record = {
    userId: 'u1',
    primaryEmail: 'u1@example.org',
    orgUnitPath: '/Students',
    givenName: 'Robin',
    familyName: 'Avery',
    fullName: 'Cached Name',
    suspended: false,
    suspensionReason: null,
    archived: false,
    lastLoginTime: null,
    creationTime: '2026-11-01T00:00:00.000Z',
    twoStepEnrolled: true,
    department: null,
    title: null,
    aliases: [],
    customSchemas: {},
    lastEntitySync: '2026-11-16T00:00:00.000Z',
  };
  const cache = fakeCache({
    [entityKey('user', customer, 'u1')]: entry(record, 4),
    [entityKey('user', customer, 'u2')]: entry(
      { ...record, userId: 'u2', fullName: 'Cached Name' },
      2,
    ),
  });
  const { rows } = fakeRows(users, { versions: { u1: 4, u2: 5 } });
  const pager = new UserPager(cache);
  const read = await pager.hydrate(customer, ['u1', 'u2'], rows, now);
  assert.deepEqual(
    read.rows.map((row) => [row.userId, row.fullName, row.recordVersion]),
    [
      ['u1', 'Cached Name', 4],
      ['u2', 'User u2', 5],
    ],
  );
  assert.deepEqual(read.missing, []);
});

test('a missing or outdated entry hydrates the current row', async () => {
  const users = [
    user('u1', { record_version: 3, full_name: 'Fresh u1' }),
    user('u2', { record_version: 7, full_name: 'Fresh u2' }),
  ];
  const record = {
    userId: 'u2',
    primaryEmail: 'u2@example.org',
    orgUnitPath: '/Students',
    givenName: 'Robin',
    familyName: 'Avery',
    fullName: 'Old u2',
    suspended: false,
    suspensionReason: null,
    archived: false,
    lastLoginTime: null,
    creationTime: '2026-11-01T00:00:00.000Z',
    twoStepEnrolled: true,
    department: null,
    title: null,
    aliases: [],
    customSchemas: {},
    lastEntitySync: '2026-11-16T00:00:00.000Z',
  };
  const cache = fakeCache({
    [entityKey('user', customer, 'u2')]: entry(record, 2),
  });
  const { rows } = fakeRows(users, { versions: { u1: 3, u2: 7 } });
  const read = await new UserPager(cache).hydrate(
    customer,
    ['u1', 'u2'],
    rows,
    now,
  );
  assert.deepEqual(
    read.rows.map((row) => [row.userId, row.fullName, row.recordVersion]),
    [
      ['u1', 'Fresh u1', 3],
      ['u2', 'Fresh u2', 7],
    ],
  );
  assert.deepEqual(read.missing, []);
});

test('a Redis fault reads the page from Postgres and stops asking Redis', async () => {
  const users = [user('u1')];
  let reads = 0;
  const fault = () => {
    reads += 1;
    return Promise.reject(new Error('redis down'));
  };
  const cache = {
    get: fault,
    getMany: fault,
    listSlice: fault,
    replaceList: fault,
    remove: fault,
  };
  const { rows } = fakeRows(users);
  const pager = new UserPager(cache);
  const read = await pager.page({
    customerId: customer,
    connectionGeneration: 1,
    actor: ['p1', 1],
    query: query(),
    selection: null,
    rows,
    now,
  });
  assert.equal(reads, 1);
  assert.deepEqual(
    read.rows.map((row) => row.userId),
    ['u1'],
  );
  assert.equal(read.matching, 1);
});

test('a Redis fault while hydrating reads every row from Postgres', async () => {
  const users = [user('u1'), user('u2')];
  let reads = 0;
  const fault = () => {
    reads += 1;
    return Promise.reject(new Error('redis down'));
  };
  const cache = {
    get: fault,
    getMany: fault,
    listSlice: fault,
    replaceList: fault,
    remove: fault,
  };
  const { rows } = fakeRows(users);
  const read = await new UserPager(cache).hydrate(
    customer,
    ['u1', 'u2'],
    rows,
    now,
  );
  assert.equal(reads, 1);
  assert.deepEqual(
    read.rows.map((row) => row.userId),
    ['u1', 'u2'],
  );
});

test('a cached list that names an unknown user is dropped and re-read', async () => {
  const users = [user('u1')];
  const cache = fakeCache({
    [queryGenerationKey('user', customer)]: '1',
  });
  const key = queryCacheKey(
    'user',
    customer,
    '1',
    userQueryHash({
      actor: ['p1', 1],
      connectionGeneration: 1,
      query: query(),
    }),
  );
  cache.lists.set(key, ['u1', 'gone']);
  const { rows, issued } = fakeRows(users);
  const pager = new UserPager(cache);
  const read = await pager.page({
    customerId: customer,
    connectionGeneration: 1,
    actor: ['p1', 1],
    query: query(),
    selection: null,
    rows,
    now,
  });
  assert.deepEqual(
    read.rows.map((row) => row.userId),
    ['u1'],
  );
  assert.equal(
    issued.some((text) => text.includes('AS matching')),
    true,
  );
  assert.equal(cache.lists.has(key), true);
});

test('a result set over the cache bound reads rows without a stored list', async () => {
  const users = [user('u1'), user('u2')];
  const cache = fakeCache();
  const { rows } = fakeRows(users, { matching: 200_000 });
  const pager = new UserPager(cache);
  const read = await pager.page({
    customerId: customer,
    connectionGeneration: 1,
    actor: ['p1', 1],
    query: query(),
    selection: null,
    rows,
    now,
  });
  assert.equal(read.matching, 200_000);
  assert.equal(cache.calls.replaceList.length, 0);
  assert.equal(read.rows.length, 2);
});

test('a selection page never reads or writes the query cache', async () => {
  const users = [user('u1')];
  const cache = fakeCache();
  const { rows } = fakeRows(users);
  const pager = new UserPager(cache);
  await pager.page({
    customerId: customer,
    connectionGeneration: 1,
    actor: ['p1', 1],
    query: query({ selection: { gridId: 'users', tabId: 't1' } }),
    selection: { terms: [], additions: ['u1'], exceptions: [] },
    rows,
    now,
  });
  assert.equal(cache.calls.listSlice.length, 0);
  assert.equal(cache.calls.replaceList.length, 0);
});

test('a miss refreshes the whole result set and a hit refreshes the page', async () => {
  const users = [
    user('u1'),
    user('u2', { last_entity_sync: '2026-11-17T00:00:00.000Z' }),
    user('u3'),
  ];
  const cache = fakeCache({
    [queryGenerationKey('user', customer)]: '1',
  });
  const { rows } = fakeRows(users, { staleIds: ['u1', 'u3'] });
  const pager = new UserPager(cache);
  const miss = await pager.page({
    customerId: customer,
    connectionGeneration: 1,
    actor: ['p1', 1],
    query: query({ limit: 2 }),
    selection: null,
    rows,
    now,
  });
  assert.deepEqual(miss.stale, ['u1', 'u3']);
  const hit = await pager.page({
    customerId: customer,
    connectionGeneration: 1,
    actor: ['p1', 1],
    query: query({ limit: 1 }),
    selection: null,
    rows,
    now,
  });
  assert.deepEqual(hit.stale, ['u1']);
  // One probe on the miss, one on the hit. The miss stored the list.
  assert.equal(cache.calls.listSlice.length, 2);
});
