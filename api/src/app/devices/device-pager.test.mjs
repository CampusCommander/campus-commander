import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceQuerySchema } from '@campus/application-contracts';
import { DevicePager, queryHash } from './device-pager.ts';

const customerId = 'C0123456';
const now = Date.parse('2026-10-06T12:00:00.000Z');
const actor = ['11111111-1111-4111-8111-111111111111', 3];
const query = (value = {}) => deviceQuerySchema.parse(value);
const old = new Date('2026-10-01T00:00:00.000Z');

const dbRow = (id, extra = {}) => ({
  device_id: id,
  serial_number: `S-${id}`,
  model: null,
  asset_tag: null,
  org_unit_path: '/',
  last_contact: null,
  annotated_location: null,
  notes: null,
  battery_status: 'no-report',
  battery_health: null,
  battery_capacity_percent: null,
  battery_reported_at: null,
  last_entity_sync: new Date('2026-10-06T11:00:00.000Z'),
  removed_at: null,
  ...extra,
});

const record = (id) =>
  JSON.stringify({
    deviceId: id,
    serialNumber: `R-${id}`,
    model: null,
    assetTag: null,
    orgUnitPath: '/',
    lastContact: null,
    annotatedLocation: null,
    notes: null,
    battery: { status: 'no-report' },
    lastEntitySync: '2026-10-06T11:30:00.000Z',
  });

/** An in-memory Redis with the calls the pager makes. Names in `fail` throw. */
function memoryCache({ fail = new Set() } = {}) {
  const strings = new Map();
  const lists = new Map();
  const calls = [];
  const guard = (name) => {
    calls.push(name);
    if (fail.has(name)) throw new Error(`${name} down`);
  };
  return {
    strings,
    lists,
    calls,
    async get(key) {
      guard('get');
      return strings.get(key) ?? null;
    },
    async getMany(keys) {
      guard('getMany');
      return keys.map((key) => strings.get(key) ?? null);
    },
    async listSlice(key, start, count) {
      guard('listSlice');
      const ids = lists.get(key)?.ids ?? [];
      return { length: ids.length, ids: ids.slice(start, start + count) };
    },
    async replaceList(key, ids, seconds) {
      guard('replaceList');
      lists.set(key, { ids: [...ids], seconds });
    },
    async remove(key) {
      guard('remove');
      lists.delete(key);
      return 1;
    },
  };
}

/** A Postgres stand-in that answers each statement by its shape. */
function database({
  ordered = ['d3', 'd1', 'd2'],
  stale = ['d2'],
  known = ordered,
} = {}) {
  const statements = [];
  const rows = async ({ text, values }) => {
    statements.push(text);
    if (text.includes('AS matching')) return [{ matching: ordered.length }];
    if (text.includes('last_entity_sync<'))
      return stale.map((id) => ({ device_id: id }));
    if (text.includes(' OFFSET ')) {
      const [offset, limit] = values.slice(-2);
      return ordered.slice(offset, offset + limit).map((id) => dbRow(id));
    }
    if (text.includes('d.device_id=ANY($2::text[])'))
      return values[1]
        .filter((id) => known.includes(id))
        .map((id) =>
          dbRow(id, stale.includes(id) ? { last_entity_sync: old } : {}),
        );
    if (text.startsWith('SELECT d.device_id'))
      return ordered.map((id) => ({ device_id: id }));
    throw new Error(`Unexpected statement: ${text}`);
  };
  return { statements, rows };
}

const input = (rows, value = {}, extra = {}) => ({
  customerId,
  connectionGeneration: 4,
  actor,
  query: query(value),
  selection: null,
  rows,
  now,
  ...extra,
});

test('a miss stores the whole ordered list for five minutes and pages from it', async () => {
  const cache = memoryCache();
  const read = await new DevicePager(cache).page(
    input(database().rows, { limit: 2 }),
  );
  assert.deepEqual(
    read.rows.map((row) => row.deviceId),
    ['d3', 'd1'],
  );
  assert.equal(read.matching, 3);
  assert.deepEqual(read.stale, ['d2']);
  const [[key, stored]] = cache.lists;
  assert.match(key, /^cc:query:device:C0123456:0:[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(stored, { ids: ['d3', 'd1', 'd2'], seconds: 300 });
});

test('a hit pages the cached list, reads Redis first, and dispatches its stale rows', async () => {
  const cache = memoryCache();
  const pager = new DevicePager(cache);
  await pager.page(input(database().rows, { limit: 2 }));
  cache.strings.set('cc:entity:device:C0123456:d1', record('d1'));
  const db = database();
  const read = await pager.page(input(db.rows, { offset: 1, limit: 2 }));
  assert.deepEqual(
    read.rows.map((row) => [row.deviceId, row.serialNumber, row.stale]),
    [
      ['d1', 'R-d1', false],
      ['d2', 'S-d2', true],
    ],
  );
  assert.equal(read.matching, 3);
  assert.deepEqual(
    read.stale,
    ['d2'],
    'A device that went stale is dispatched.',
  );
  assert.equal(
    db.statements.length,
    1,
    'Only the Redis miss reaches Postgres.',
  );
  assert.match(db.statements[0], /d\.device_id=ANY\(\$2::text\[\]\)$/);
});

test('the cache key covers the person, the connection, and the query shape but not paging', () => {
  const base = { actor, connectionGeneration: 4, query: query({ limit: 100 }) };
  const hash = queryHash(base);
  assert.equal(
    queryHash({ ...base, query: query({ offset: 500, limit: 50 }) }),
    hash,
  );
  for (const changed of [
    { ...base, actor: ['22222222-2222-4222-8222-222222222222', 3] },
    { ...base, actor: [actor[0], 4] },
    { ...base, connectionGeneration: 5 },
    { ...base, query: query({ sort: { field: 'model', direction: 'asc' } }) },
    {
      ...base,
      query: query({ predicates: [{ field: 'notes', operator: 'isEmpty' }] }),
    },
    { ...base, query: query({ group: { by: ['model'], keys: ['X'] } }) },
  ])
    assert.notEqual(queryHash(changed), hash);
});

test('a new query generation makes earlier lists unreachable', async () => {
  const cache = memoryCache();
  const pager = new DevicePager(cache);
  await pager.page(input(database().rows));
  cache.strings.set('cc:query-gen:device:C0123456', '1');
  const db = database();
  await pager.page(input(db.rows));
  assert.ok(db.statements.some((text) => text.includes('AS matching')));
  assert.deepEqual(
    [...cache.lists.keys()].map((key) => key.split(':')[4]),
    ['0', '1'],
  );
});

test('Show All Selected pages through Postgres without the cache', async () => {
  const cache = memoryCache();
  const db = database();
  const selection = {
    terms: [],
    groups: [],
    additions: ['d1'],
    exceptions: [],
  };
  const read = await new DevicePager(cache).page(
    input(db.rows, { limit: 2 }, { selection }),
  );
  assert.deepEqual(
    read.rows.map((row) => row.deviceId),
    ['d3', 'd1'],
  );
  assert.equal(read.matching, 3);
  assert.deepEqual(read.stale, ['d2']);
  assert.deepEqual(cache.calls, []);
});

test('results over 100,000 devices page through Postgres without the cache', async () => {
  const cache = memoryCache();
  const ordered = Array.from({ length: 100_001 }, (_, index) => `d${index}`);
  const read = await new DevicePager(cache).page(
    input(database({ ordered, stale: [] }).rows, { limit: 100 }),
  );
  assert.equal(read.matching, 100_001);
  assert.equal(read.rows.length, 100);
  assert.equal(cache.calls.includes('replaceList'), false);
});

test('a cached list that names an unknown device is dropped and the page reads Postgres', async () => {
  const cache = memoryCache();
  const pager = new DevicePager(cache);
  await pager.page(input(database().rows));
  const [key] = cache.lists.keys();
  const read = await pager.page(
    input(database({ ordered: ['d1', 'd2'], stale: [] }).rows),
  );
  assert.ok(cache.calls.includes('remove'));
  assert.deepEqual(
    read.rows.map((row) => row.deviceId),
    ['d1', 'd2'],
  );
  assert.equal(read.matching, 2);
  assert.deepEqual(cache.lists.get(key).ids, ['d1', 'd2']);
});

test('a Redis fault pages through Postgres', async () => {
  const db = database();
  const read = await new DevicePager(
    memoryCache({ fail: new Set(['get']) }),
  ).page(input(db.rows, { limit: 2 }));
  assert.deepEqual(
    read.rows.map((row) => row.deviceId),
    ['d3', 'd1'],
  );
  assert.equal(read.matching, 3);
  assert.ok(db.statements.some((text) => text.includes(' OFFSET ')));
});

test('hydration keeps the requested order and treats unreadable records as misses', async () => {
  const cache = memoryCache();
  cache.strings.set('cc:entity:device:C0123456:d1', '{not json');
  cache.strings.set('cc:entity:device:C0123456:d2', record('other'));
  cache.strings.set('cc:entity:device:C0123456:d3', record('d3'));
  const read = await new DevicePager(cache).hydrate(
    customerId,
    ['d2', 'd3', 'd1', 'd9'],
    database().rows,
    now,
  );
  assert.deepEqual(
    read.rows.map((row) => row.deviceId),
    ['d2', 'd3', 'd1'],
  );
  assert.equal(read.rows[1].serialNumber, 'R-d3');
  assert.equal(read.rows[0].serialNumber, 'S-d2');
  assert.deepEqual(read.missing, ['d9']);
});

test('a Redis fault during hydration reads every device from Postgres', async () => {
  const read = await new DevicePager(
    memoryCache({ fail: new Set(['getMany']) }),
  ).hydrate(customerId, ['d1'], database().rows, now);
  assert.equal(read.rows[0].serialNumber, 'S-d1');
});

test('after a listSlice fault the request never calls replaceList or getMany', async () => {
  const cache = memoryCache({ fail: new Set(['listSlice']) });
  const read = await new DevicePager(cache).page(
    input(database().rows, { limit: 2 }),
  );
  assert.deepEqual(
    read.rows.map((row) => row.deviceId),
    ['d3', 'd1'],
  );
  assert.equal(cache.calls.includes('replaceList'), false);
  assert.equal(cache.calls.includes('getMany'), false);
});

test('a replaceList fault skips getMany and still returns Postgres rows', async () => {
  const cache = memoryCache({ fail: new Set(['replaceList']) });
  const read = await new DevicePager(cache).page(
    input(database().rows, { limit: 2 }),
  );
  assert.deepEqual(
    read.rows.map((row) => row.deviceId),
    ['d3', 'd1'],
  );
  assert.equal(read.matching, 3);
  assert.equal(cache.calls.includes('getMany'), false);
});

test('the fault guard is per request', async () => {
  const cache = memoryCache({ fail: new Set(['listSlice']) });
  const pager = new DevicePager(cache);
  await pager.page(input(database().rows));
  const before = cache.calls.filter((name) => name === 'get').length;
  await pager.page(input(database().rows));
  assert.equal(cache.calls.filter((name) => name === 'get').length, before + 1);
});
