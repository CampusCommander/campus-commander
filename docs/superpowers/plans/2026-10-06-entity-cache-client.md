# Entity Cache Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve device grid pages from a Redis query cache, push refresh signals to the browser over Server-Sent Events, update refreshed rows in place, and replace the 2 second poll with a per-row stale display and a "Refreshing N of M devices" banner.

**Architecture:** The API caches the whole ordered device ID list of each grid query in Redis for 5 minutes. Each page reads its device records from the worker's Redis entity cache first and from Postgres for the rest. A plain `DevicePager` class holds that logic so `node:test` can drive it, and `POST /api/devices/by-ids` reuses its hydration. `GET /api/devices/events` subscribes one Redis connection per API instance to `cc:entity-events:{customer}` and streams named events, with a 25 second ping that re-checks the session. The browser store opens one `EventSource` while Devices is mounted. It refetches only the rows the grid holds when a batch lands, counts stale devices through `POST /api/devices/freshness`, and reconciles after a reconnect.

**Tech Stack:** NestJS 11 on Express, `redis` 5.11.0 (lists, `MGET`, pub/sub on a duplicated client), `node:test`, Zod 4, Angular 22 signals, LibreGrid server-side row model on AG Grid 36.2.0, Vitest, Playwright (existing e2e harness), the Node edge proxy in `deployment/bootstrap`.

**Spec:** [docs/superpowers/specs/2026-10-06-entity-cache-decisions.md](../specs/2026-10-06-entity-cache-decisions.md), decisions D1, D2, D6, D7, D10 (query side), D11, D12. Plan A ([2026-10-06-entity-cache-backend.md](2026-10-06-entity-cache-backend.md)) built D3, D4, D5, D8, D9, D13, D14, D15 and is merged into `codex/devices-ui` at `7cfc201`. The workflow is [docs/workflows/device-browsing.md](../../workflows/device-browsing.md).

## Global Constraints

- Branch `codex/entity-cache`, created from `codex/devices-ui` at `7cfc201`. Do not merge it. The owner merges.
- The worker, the Kestra flows, and migration 016 do not change. The worker already publishes `entity-batch`, `job-finished`, and `full-sync`, and bumps `cc:query-gen:device:{customer}` after a full sync.
- Query cache key: `cc:query:device:{customer}:{query generation}:{hash}`. The query generation is the value of `cc:query-gen:device:{customer}`, or `0` when the key is absent.
- The hash is SHA-256, base64url, over `[principal ID, permission version, connection generation, predicates, sort, group]`. It covers the principal ID so a cached list never crosses people. Paging (`offset`, `limit`) is not part of the hash.
- Query cache value: a Redis list of every matching device ID in grid order, stale and fresh alike, with a 300 second expiry. A page is a slice of the list. The matching count is the list length.
- These queries skip the query cache and page through Postgres: Show All Selected (`query.selection` set), results over 100,000 devices, and empty results. Group requests (`POST /api/devices/groups`) stay uncached (D2).
- The API never writes `cc:entity:*`, never bumps `cc:query-gen:*`, and never runs `SCAN`, `KEYS`, or wildcard deletes (D1, D10).
- Hydration reads `cc:entity:device:{customer}:{id}` first and Postgres for misses. Postgres misses include removed devices so a cached page always fills. Rows keep the requested order. A Redis fault reads Postgres.
- A removed device never reads as stale. `stale` is false when `removed_at` is set.
- A cache miss dispatches every stale device in the result set (D4). A cached page dispatches the stale rows on that page.
- `POST /api/devices/by-ids` takes `{ deviceIds }` with 1 to 500 IDs and returns `{ rows }`. Unknown IDs are left out. The client sends at most two requests for the 1,000 rows a grid holds.
- `POST /api/devices/freshness` takes the device query body and returns `{ freshness: { stale, refreshing } }`. `stale` counts stale devices in the result set. `refreshing` is true while the customer has an entity sync job that is unfinished and less than two hours old.
- `GET /api/devices/events` answers `text/event-stream`. Each event uses its payload `type` as the SSE event name: `entity-batch`, `job-finished`, `full-sync`. A `ping` event follows every 25 seconds. The first line is `retry: 3000`.
- The stream starts only after the Redis subscription is active. Each ping first re-authenticates the session and re-checks `devices:read`. A failed check ends the stream. A stream with more than 1 MiB buffered ends.
- One subscriber connection per API instance serves every stream. A lost subscriber ends every stream. API shutdown ends every stream before the HTTP server closes.
- The edge gives `/api/devices/events` a 75 second upstream idle timeout. Every other application request keeps 45 seconds. `by-ids` and `freshness` join the device POST routes and their 98,304 byte body limit.
- The browser opens one `EventSource` while Devices is mounted and closes it on leave. Nothing polls `GET /api/devices/sync`.
- After a reconnect the store reads `GET /api/devices/sync` once, calls `by-ids` for held rows that are still stale, and recounts. A full sync that ended meanwhile reloads the grid instead.
- A stream with no event for 60 seconds counts as dead and reopens. A closed stream reopens after 5 seconds when the status read succeeds. It stays closed after an HTTP error such as 401.
- Copy, exactly: banner title `Refreshing {N} of {M} devices` (`device` when M is 1) while a refresh runs. Otherwise the banner keeps the title `Inventory observation is stale` and the button `Refresh inventory`. Stale cell tooltip: `Refreshing from Google`.
- N is the stale count from `freshness`. M is the matching count in the status bar. Numbers use `toLocaleString('en-US')`.
- Files that `node:test` imports stay plain: no decorators and no constructor parameter properties. Declare fields and assign them in the constructor.
- Run tasks through Nx: `npm exec -- nx run <project>:<target> --skip-nx-cache`. Single `node:test` files run with `node --import ./libs/application-contracts/test-register.mjs --test <file>`. Single frontend specs run with `npm exec -- nx run frontend:test --include=<path from frontend/>`.
- Repository prose follows the writing rules in `AGENTS.md`: active voice, no hedging, no semicolons, no contractions, at most 20 words per instruction sentence.

## Review Focus

1. **A cached list that names a device that neither Redis nor Postgres returns.** LibreGrid shows a loading stub forever for a short block. The pager drops the list and reads Postgres. Test: Task 3 (`a cached list that names an unknown device is dropped`).
2. **Devices that go stale while a cached list lives.** Their Redis records expire, so the cached page reads them from Postgres as stale and must dispatch them. Test: Task 3 (`a hit pages the cached list, reads Redis first, and dispatches its stale rows`).
3. **A device that Google removes while it sits in a cached result.** The row keeps its last data until the list expires. It must not read as stale, or it shows "Refreshing from Google" forever. Test: Task 2 (`removed devices never read as stale`).
4. **A session that ends or loses `devices:read` while a stream is open.** The next ping's check ends the stream within 25 seconds. Test: Task 5 (`a failed session check ends the stream`).
5. **API shutdown or a lost Redis subscriber while streams are open.** Every stream ends, so the HTTP server can close and browsers reconnect and reconcile. Test: Task 5 (`a lost subscriber closes every stream and the next stream reconnects`, `closing the fanout ends every stream`).

## File map

| File                                                                     | Responsibility                                               | Task |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ | ---- |
| `libs/application-contracts/src/lib/entity-cache.ts`                     | Query cache constants and key, ping interval                 | 1    |
| `libs/application-contracts/src/lib/devices.ts`                          | `by-ids` and `freshness` schemas                             | 1    |
| `api/src/app/devices/device-query.ts`                                    | SQL for ID lists, rows by ID, stale counts, refresh state    | 2    |
| `libs/application-contracts/test-register.mjs`                           | Resolve extensionless imports under `api/src` in `node:test` | 3    |
| `api/src/app/cache/cache.service.ts`                                     | `getMany`, `listSlice`, `replaceList`, `subscriber`          | 3    |
| `api/src/app/devices/device-pager.ts`                                    | Query cache key, hydration, page algorithm (plain)           | 3    |
| `api/src/app/devices/devices.service.ts`                                 | Wire the pager, `rowsById`, `freshness`                      | 3, 4 |
| `api/src/app/devices/devices.controller.ts`                              | `by-ids`, `freshness`, `events` routes                       | 4, 5 |
| `deployment/bootstrap/application-edge.mjs`                              | Route allowances and the event stream timeout                | 4, 5 |
| `api/src/app/devices/device-events.ts`                                   | Redis fanout and the SSE writer (plain)                      | 5    |
| `api/src/app/devices/device-events.service.ts`                           | Nest owner of the subscriber connection                      | 5    |
| `frontend/src/app/devices/device-row-refresh.ts`                         | Held grid rows and in-place updates                          | 6    |
| `frontend/src/app/devices/devices.store.ts`                              | Event stream, row refresh, recount, no poll                  | 6    |
| `frontend/src/app/devices/device-freshness.ts`                           | Banner text and state (pure)                                 | 7    |
| `frontend/src/app/devices/device-columns.ts`                             | Muted Device contact cell and tooltip                        | 7    |
| `frontend/src/app/devices/devices.ts`, `devices.html`                    | Banner, mount and leave                                      | 6, 7 |
| `api-e2e/devices-api.mjs`, `api-e2e/devices-browser.mjs`                 | End-to-end checks                                            | 8    |
| `docs/workflows/device-browsing.md`, the spec, `docs/document-index.csv` | Records                                                      | 8    |

---

### Task 1: Query cache, by-ids, and freshness contracts

**Files:**

- Modify: `libs/application-contracts/src/lib/entity-cache.ts`
- Modify: `libs/application-contracts/src/lib/entity-cache.test.mjs`
- Modify: `libs/application-contracts/src/lib/devices.ts`
- Modify: `libs/application-contracts/src/lib/devices.test.mjs`

**Interfaces:**

- Consumes: `EntityType`, `deviceRowSchema` (existing).
- Produces, from `@campus/application-contracts`:
  - `QUERY_CACHE_SECONDS = 300`, `QUERY_CACHE_MAX_IDS = 100_000`, `ENTITY_EVENTS_PING_SECONDS = 25`.
  - `queryCacheKey(type: EntityType, customerId: string, generation: string, hash: string): string`, which returns `cc:query:{type}:{customerId}:{generation}:{hash}`.
  - `DEVICE_BY_IDS_LIMIT = 500`.
  - `deviceByIdsSchema`: `{ deviceIds: string[] }`, 1 to 500 IDs.
  - `deviceRowsSchema`: an array of `DeviceRow`, at most 500.
  - `deviceFreshnessSchema`, type `DeviceFreshness = { stale: number; refreshing: boolean }`.

- [ ] **Step 1: Write the failing contract tests**

In `libs/application-contracts/src/lib/entity-cache.test.mjs`, add these names to the existing import from `./entity-cache.ts`: `ENTITY_EVENTS_PING_SECONDS`, `QUERY_CACHE_MAX_IDS`, `QUERY_CACHE_SECONDS`, `queryCacheKey`. Append:

```js
test('query cache names carry the query generation and expire after five minutes', () => {
  assert.equal(QUERY_CACHE_SECONDS, 300);
  assert.equal(QUERY_CACHE_MAX_IDS, 100_000);
  assert.equal(ENTITY_EVENTS_PING_SECONDS, 25);
  assert.equal(
    queryCacheKey('device', 'C0123456', '7', 'abc'),
    'cc:query:device:C0123456:7:abc',
  );
});
```

In `libs/application-contracts/src/lib/devices.test.mjs`, add these names to the existing import from `./devices.ts`: `DEVICE_BY_IDS_LIMIT`, `deviceByIdsSchema`, `deviceFreshnessSchema`, `deviceRowsSchema`. Append:

```js
test('by-ids takes 1 to 500 device IDs and nothing else', () => {
  assert.equal(DEVICE_BY_IDS_LIMIT, 500);
  assert.equal(deviceByIdsSchema.safeParse({ deviceIds: [] }).success, false);
  assert.equal(
    deviceByIdsSchema.safeParse({ deviceIds: ['d1'] }).success,
    true,
  );
  assert.equal(
    deviceByIdsSchema.safeParse({
      deviceIds: Array.from({ length: 501 }, (_, index) => `d${index}`),
    }).success,
    false,
  );
  assert.equal(
    deviceByIdsSchema.safeParse({ deviceIds: ['d1'], extra: 1 }).success,
    false,
  );
  assert.equal(deviceRowsSchema.safeParse([]).success, true);
});

test('freshness reports the stale count and whether a refresh runs', () => {
  assert.deepEqual(
    deviceFreshnessSchema.parse({ stale: 12, refreshing: true }),
    { stale: 12, refreshing: true },
  );
  assert.equal(
    deviceFreshnessSchema.safeParse({ stale: -1, refreshing: false }).success,
    false,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm exec -- nx run application-contracts:test --skip-nx-cache`
Expected: FAIL. The imports `queryCacheKey` and `deviceByIdsSchema` do not exist yet.

- [ ] **Step 3: Add the contracts**

In `libs/application-contracts/src/lib/entity-cache.ts`, after `ENTITY_INFLIGHT_SECONDS`, add:

```ts
/** Seconds that a cached query result stays readable (D1). */
export const QUERY_CACHE_SECONDS = 300;
/** Results with more devices than this skip the query cache and page through Postgres. */
export const QUERY_CACHE_MAX_IDS = 100_000;
/** Seconds between event stream pings. The edge and the browser watch for them. */
export const ENTITY_EVENTS_PING_SECONDS = 25;
```

After `entityEventsChannel`, add:

```ts
/** One cached query result. The query generation makes old results unreachable after a full sync (D10). */
export const queryCacheKey = (
  type: EntityType,
  customerId: string,
  generation: string,
  hash: string,
) => `cc:query:${type}:${customerId}:${generation}:${hash}`;
```

In `libs/application-contracts/src/lib/devices.ts`, after `deviceDetailSchema` and its type, add:

```ts
/** IDs per by-ids request. A grid holds at most 1,000 rows, so the client sends two requests at most. */
export const DEVICE_BY_IDS_LIMIT = 500;
export const deviceByIdsSchema = z.strictObject({
  deviceIds: z.array(deviceId).min(1).max(DEVICE_BY_IDS_LIMIT),
});
export const deviceRowsSchema = z
  .array(deviceRowSchema)
  .max(DEVICE_BY_IDS_LIMIT);

/** Stale devices in one result set, and whether a refresh job runs for the customer (D11). */
export const deviceFreshnessSchema = z.strictObject({
  stale: z.number().int().min(0),
  refreshing: z.boolean(),
});
export type DeviceFreshness = z.infer<typeof deviceFreshnessSchema>;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm exec -- nx run application-contracts:test --skip-nx-cache`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/application-contracts/src/lib/entity-cache.ts libs/application-contracts/src/lib/entity-cache.test.mjs libs/application-contracts/src/lib/devices.ts libs/application-contracts/src/lib/devices.test.mjs
git commit -m "feat: add query cache, by-ids, and freshness contracts"
```

---

### Task 2: SQL for ID lists, rows by ID, stale counts, and refresh state

**Files:**

- Modify: `api/src/app/devices/device-query.ts`
- Modify: `api/src/app/devices/device-query.test.mjs`

**Interfaces:**

- Consumes: `deviceWhere`, `columns`, `batteryOrder`, `from`, `deviceColumns` (existing, module-private or exported in `device-query.ts`).
- Produces, from `api/src/app/devices/device-query.ts`:
  - `deviceIdsSql(customerId: string, query: DeviceQuery, limit: number): SqlStatement`. Rows are `{ device_id }` in grid order. Paging is ignored.
  - `deviceRowsByIdSql(customerId: string, ids: readonly string[]): SqlStatement`. Rows carry `deviceColumns` plus `removed_at`. Removed devices are included. Order is not defined.
  - `staleCountSql(customerId: string, query: DeviceQuery, selection: SelectionState | null, cutoff: Date): SqlStatement`. One row `{ stale: number }`.
  - `refreshingSql(customerId: string): SqlStatement`. One row `{ refreshing: boolean }`.
  - `deviceRow(row, cutoff)` returns `stale: false` when `row.removed_at` is set.

- [ ] **Step 1: Write the failing tests**

In `api/src/app/devices/device-query.test.mjs`, add `deviceIdsSql`, `deviceRowsByIdSql`, `refreshingSql`, and `staleCountSql` to the import from `./device-query.ts`. Append:

```js
test('the cached ID list follows the grid order and binds the limit last', () => {
  const sql = deviceIdsSql(
    'C0123456',
    deviceQuerySchema.parse({
      predicates: hs04Selection,
      sort: { field: 'battery', direction: 'desc' },
      offset: 300,
      limit: 100,
    }),
    100000,
  );
  assert.match(
    sql.text,
    /^SELECT d\.device_id FROM cc\.device_sync_state s JOIN cc\.devices d ON d\.customer_id=s\.customer_id WHERE s\.customer_id=\$1 AND d\.removed_at IS NULL AND d\.asset_tag ILIKE \$2 ORDER BY CASE .* END DESC NULLS LAST,d\.device_id DESC LIMIT \$3$/,
  );
  assert.deepEqual(sql.values, ['C0123456', 'HS-04%', 100000]);
  assert.doesNotMatch(sql.text, /OFFSET/);
});

test('an open group narrows the cached ID list', () => {
  const sql = deviceIdsSql(
    'C0123456',
    deviceQuerySchema.parse({
      group: { by: ['model'], keys: ['Lenovo 100e'] },
    }),
    10,
  );
  assert.match(
    sql.text,
    /AND coalesce\(d\.model,''\)=\$2 ORDER BY d\.serial_number ASC NULLS LAST,d\.device_id ASC LIMIT \$3$/,
  );
  assert.deepEqual(sql.values, ['C0123456', 'Lenovo 100e', 10]);
});

test('rows by ID include removed devices and bind the IDs as one array', () => {
  const sql = deviceRowsByIdSql('C0123456', ['d2', 'd1']);
  assert.match(
    sql.text,
    /,d\.removed_at FROM cc\.device_sync_state s JOIN cc\.devices d ON d\.customer_id=s\.customer_id WHERE s\.customer_id=\$1 AND d\.device_id=ANY\(\$2::text\[\]\)$/,
  );
  assert.doesNotMatch(sql.text, /removed_at IS NULL/);
  assert.deepEqual(sql.values, ['C0123456', ['d2', 'd1']]);
});

test('the stale count covers the whole result set below the cutoff', () => {
  const cutoff = new Date('2026-10-05T12:00:00.000Z');
  const sql = staleCountSql(
    'C0123456',
    deviceQuerySchema.parse({ predicates: hs04Selection, offset: 300 }),
    null,
    cutoff,
  );
  assert.match(
    sql.text,
    /^SELECT count\(\*\)::integer AS stale FROM cc\.device_sync_state s JOIN cc\.devices d ON d\.customer_id=s\.customer_id WHERE s\.customer_id=\$1 AND d\.removed_at IS NULL AND d\.asset_tag ILIKE \$2 AND d\.last_entity_sync<\$3::timestamptz$/,
  );
  assert.deepEqual(sql.values, ['C0123456', 'HS-04%', cutoff.toISOString()]);
});

test('a refresh counts as running until it finishes or turns two hours old', () => {
  const sql = refreshingSql('C0123456');
  assert.match(
    sql.text,
    /^SELECT EXISTS\(SELECT 1 FROM cc\.entity_sync_jobs WHERE customer_id=\$1 AND finished_at IS NULL AND created_at>clock_timestamp\(\)-interval '2 hours'\) AS refreshing$/,
  );
  assert.deepEqual(sql.values, ['C0123456']);
});

test('removed devices never read as stale', () => {
  const cutoff = Date.parse('2026-10-05T12:00:00.000Z');
  const old = {
    device_id: 'd1',
    serial_number: 'S',
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
    last_entity_sync: new Date('2026-10-01T00:00:00.000Z'),
  };
  const removed = deviceRow(
    { ...old, removed_at: new Date('2026-10-04T00:00:00.000Z') },
    cutoff,
  );
  assert.equal(removed.stale, false);
  assert.equal('removedAt' in removed, false);
  assert.equal(deviceRow({ ...old, removed_at: null }, cutoff).stale, true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import ./libs/application-contracts/test-register.mjs --test api/src/app/devices/device-query.test.mjs`
Expected: FAIL with `deviceIdsSql is not a function` or a missing export error.

- [ ] **Step 3: Add the statements**

In `api/src/app/devices/device-query.ts`, add this helper after `deviceWhere`:

```ts
/** The grid order: the sort column with nulls last, then the device ID in the same direction. */
function orderBy(query: DeviceQuery): string {
  const order =
    query.sort.field === 'battery' ? batteryOrder : columns[query.sort.field];
  const direction = query.sort.direction === 'desc' ? 'DESC' : 'ASC';
  return `ORDER BY ${order} ${direction} NULLS LAST,d.device_id ${direction}`;
}
```

Replace the body of `devicePageSql` so that it uses the helper. The SQL text stays the same:

```ts
export function devicePageSql(
  customerId: string,
  query: DeviceQuery,
  selection: SelectionState | null = null,
): { rows: SqlStatement; count: SqlStatement } {
  const values: unknown[] = [customerId];
  const where = deviceWhere(query.predicates, values, selection, query.group);
  return {
    rows: {
      text: `SELECT ${deviceColumns} ${from} WHERE ${where} ${orderBy(query)} OFFSET $${values.length + 1} LIMIT $${values.length + 2}`,
      values: [...values, query.offset, query.limit],
    },
    count: {
      text: `SELECT count(*)::integer AS matching ${from} WHERE ${where}`,
      values: [...values],
    },
  };
}
```

After `staleIdsSql`, add:

```ts
/** Every device ID of a result set in grid order. The query cache stores this list (D2). */
export function deviceIdsSql(
  customerId: string,
  query: DeviceQuery,
  limit: number,
): SqlStatement {
  const values: unknown[] = [customerId];
  const where = deviceWhere(query.predicates, values, null, query.group);
  values.push(limit);
  return {
    text: `SELECT d.device_id ${from} WHERE ${where} ${orderBy(query)} LIMIT $${values.length}`,
    values,
  };
}

/** Rows for known device IDs, removed devices included. A cached list keeps its devices until it expires. */
export function deviceRowsByIdSql(
  customerId: string,
  ids: readonly string[],
): SqlStatement {
  return {
    text: `SELECT ${deviceColumns},d.removed_at ${from} WHERE s.customer_id=$1 AND d.device_id=ANY($2::text[])`,
    values: [customerId, ids],
  };
}

/** The number of stale devices in a result set. The banner reports it (D11). */
export function staleCountSql(
  customerId: string,
  query: DeviceQuery,
  selection: SelectionState | null,
  cutoff: Date,
): SqlStatement {
  const values: unknown[] = [customerId];
  const where = deviceWhere(query.predicates, values, selection, query.group);
  values.push(cutoff.toISOString());
  return {
    text: `SELECT count(*)::integer AS stale ${from} WHERE ${where} AND d.last_entity_sync<$${values.length}::timestamptz`,
    values,
  };
}

/** Whether a refresh job runs for the customer. The job reaper interrupts jobs after two hours. */
export function refreshingSql(customerId: string): SqlStatement {
  return {
    text: "SELECT EXISTS(SELECT 1 FROM cc.entity_sync_jobs WHERE customer_id=$1 AND finished_at IS NULL AND created_at>clock_timestamp()-interval '2 hours') AS refreshing",
    values: [customerId],
  };
}
```

In `deviceRow`, replace the `stale` property with:

```ts
    // A removed device gets no refresh, so it never shows the refresh marker.
    stale:
      !row['removed_at'] &&
      typeof lastEntitySync === 'string' &&
      Date.parse(lastEntitySync) < cutoff,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import ./libs/application-contracts/test-register.mjs --test api/src/app/devices/device-query.test.mjs`
Expected: PASS, including the existing page, stale ID, and detail tests.

- [ ] **Step 5: Commit**

```bash
git add api/src/app/devices/device-query.ts api/src/app/devices/device-query.test.mjs
git commit -m "feat: add SQL for cached ID lists, rows by ID, and stale counts"
```

---

### Task 3: Query cache and hydration

**Files:**

- Modify: `libs/application-contracts/test-register.mjs`
- Modify: `api/src/app/cache/cache.service.ts`
- Create: `api/src/app/devices/device-pager.ts`
- Create: `api/src/app/devices/device-pager.test.mjs`
- Modify: `api/src/app/devices/devices.service.ts`

**Interfaces:**

- Consumes: Task 1 `QUERY_CACHE_SECONDS`, `QUERY_CACHE_MAX_IDS`, `queryCacheKey`. Task 2 `deviceIdsSql`, `deviceRowsByIdSql`. Existing `devicePageSql`, `staleIdsSql`, `deviceRow`, `entityKey`, `queryGenerationKey`, `deviceRecordSchema`, `isStale`, `freshnessCutoff`, `memberChunks`.
- Produces:
  - `CacheService.getMany(keys: readonly string[]): Promise<(string | null)[]>`.
  - `CacheService.listSlice(key: string, start: number, count: number): Promise<{ length: number; ids: string[] }>`. Length 0 means a miss.
  - `CacheService.replaceList(key: string, ids: readonly string[], seconds: number): Promise<void>`.
  - `CacheService.subscriber()`: an unconnected duplicate of the API Redis client, or `null` without Redis. Task 5 uses it.
  - From `api/src/app/devices/device-pager.ts`:
    - `type Rows = (statement: SqlStatement) => Promise<Record<string, unknown>[]>`.
    - `type PagerCache = Pick<CacheService, 'get' | 'getMany' | 'listSlice' | 'replaceList' | 'remove'>`.
    - `interface PageRead { rows: DeviceRow[]; matching: number; stale: string[] }`. `stale` lists the IDs to dispatch.
    - `queryHash(input: { actor: readonly [string, number]; connectionGeneration: number; query: DeviceQuery }): string`.
    - `class DevicePager` with `constructor(cache: PagerCache)`.
    - `DevicePager.hydrate(customerId: string, ids: readonly string[], rows: Rows, now?: number): Promise<{ rows: DeviceRow[]; missing: string[] }>`.
    - `DevicePager.page(input: { customerId: string; connectionGeneration: number; actor: readonly [string, number]; query: DeviceQuery; selection: SelectionState | null; rows: Rows; now?: number }): Promise<PageRead>`.
  - `DevicesService` gains the field `pager: DevicePager` and the module helper `rowsOf(client: PoolClient): Rows`. Its private `read()` passes `connectionGeneration` as a third callback argument. Task 4 uses all three.

- [ ] **Step 1: Let `node:test` resolve extensionless imports under `api/src`**

`device-pager.ts` imports `./device-query` without an extension, as webpack expects. In `libs/application-contracts/test-register.mjs`, replace the parent check with:

```js
context.parentURL?.includes('/libs/') ||
  context.parentURL?.includes('/worker/src/') ||
  context.parentURL?.includes('/api/src/');
```

- [ ] **Step 2: Write the failing pager tests**

Create `api/src/app/devices/device-pager.test.mjs`:

```js
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --import ./libs/application-contracts/test-register.mjs --test api/src/app/devices/device-pager.test.mjs`
Expected: FAIL with `Cannot find module` for `./device-pager.ts`.

- [ ] **Step 4: Write the pager**

Create `api/src/app/devices/device-pager.ts`:

```ts
import { createHash } from 'node:crypto';
import {
  QUERY_CACHE_MAX_IDS,
  QUERY_CACHE_SECONDS,
  deviceRecordSchema,
  entityKey,
  freshnessCutoff,
  isStale,
  queryCacheKey,
  queryGenerationKey,
  type DeviceQuery,
  type DeviceRow,
} from '@campus/application-contracts';
import type { CacheService } from '../cache/cache.service';
import type { SelectionState } from './device-selection';
import {
  deviceIdsSql,
  devicePageSql,
  deviceRow,
  deviceRowsByIdSql,
  staleIdsSql,
  type SqlStatement,
} from './device-query';

export type Rows = (
  statement: SqlStatement,
) => Promise<Record<string, unknown>[]>;
export type PagerCache = Pick<
  CacheService,
  'get' | 'getMany' | 'listSlice' | 'replaceList' | 'remove'
>;

export interface PageRead {
  rows: DeviceRow[];
  matching: number;
  /** Stale devices to refresh: the whole result set on a miss, the page on a hit. */
  stale: string[];
}

/** The query cache key covers who asks, the connection, and the query shape (D2). Paging is not part of it. */
export function queryHash(input: {
  actor: readonly [string, number];
  connectionGeneration: number;
  query: DeviceQuery;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.actor[0],
        input.actor[1],
        input.connectionGeneration,
        input.query.predicates,
        input.query.sort,
        input.query.group,
      ]),
    )
    .digest('base64url');
}

/**
 * Grid pages through the Redis query cache (D1, D2). A miss reads Postgres and stores the ordered ID list.
 * Rows come from the worker's entity records first and from Postgres for the rest.
 */
export class DevicePager {
  // Explicit field: Node's type-stripping test runner rejects parameter properties.
  private readonly cache: PagerCache;

  constructor(cache: PagerCache) {
    this.cache = cache;
  }

  /** Redis first per ID, Postgres for misses (D7, D9). Rows keep the order of `ids`. */
  async hydrate(
    customerId: string,
    ids: readonly string[],
    rows: Rows,
    now = Date.now(),
  ): Promise<{ rows: DeviceRow[]; missing: string[] }> {
    const unique = [...new Set(ids)];
    const found = new Map<string, DeviceRow>();
    let cached: (string | null)[] = [];
    try {
      cached = await this.cache.getMany(
        unique.map((id) => entityKey('device', customerId, id)),
      );
    } catch {
      // A Redis fault reads every device from Postgres.
    }
    unique.forEach((id, index) => {
      const raw = cached[index];
      if (!raw) return;
      try {
        const record = deviceRecordSchema.parse(JSON.parse(raw));
        if (record.deviceId === id)
          found.set(id, {
            ...record,
            stale: isStale('device', record.lastEntitySync, now),
          });
      } catch {
        // An unreadable record counts as a miss.
      }
    });
    const misses = unique.filter((id) => !found.has(id));
    if (misses.length) {
      const cutoff = freshnessCutoff('device', now).getTime();
      for (const row of await rows(deviceRowsByIdSql(customerId, misses)))
        found.set(String(row['device_id']), deviceRow(row, cutoff));
    }
    return {
      rows: unique.flatMap((id) => found.get(id) ?? []),
      missing: unique.filter((id) => !found.has(id)),
    };
  }

  async page(input: {
    customerId: string;
    connectionGeneration: number;
    actor: readonly [string, number];
    query: DeviceQuery;
    selection: SelectionState | null;
    rows: Rows;
    now?: number;
  }): Promise<PageRead> {
    const { customerId, query, selection, rows } = input;
    const now = input.now ?? Date.now();
    // Show All Selected follows a selection that changes between requests.
    const key = selection ? null : await this.key(input);
    if (key) {
      const hit = await this.cached(customerId, key, query, rows, now);
      if (hit) return hit;
    }
    const sql = devicePageSql(customerId, query, selection);
    const matching = Number((await rows(sql.count))[0]?.['matching'] ?? 0);
    const stale = (
      await rows(
        staleIdsSql(
          customerId,
          query,
          selection,
          freshnessCutoff('device', now),
        ),
      )
    ).map((row) => String(row['device_id']));
    if (!key || matching > QUERY_CACHE_MAX_IDS) {
      const cutoff = freshnessCutoff('device', now).getTime();
      return {
        rows: (await rows(sql.rows)).map((row) => deviceRow(row, cutoff)),
        matching,
        stale,
      };
    }
    const ids = (
      await rows(deviceIdsSql(customerId, query, QUERY_CACHE_MAX_IDS))
    ).map((row) => String(row['device_id']));
    if (ids.length)
      await this.cache
        .replaceList(key, ids, QUERY_CACHE_SECONDS)
        .catch(() => undefined);
    const read = await this.hydrate(
      customerId,
      ids.slice(query.offset, query.offset + query.limit),
      rows,
      now,
    );
    return { rows: read.rows, matching: ids.length, stale };
  }

  private async key(input: {
    customerId: string;
    connectionGeneration: number;
    actor: readonly [string, number];
    query: DeviceQuery;
  }): Promise<string | null> {
    try {
      const generation =
        (await this.cache.get(
          queryGenerationKey('device', input.customerId),
        )) ?? '0';
      return queryCacheKey(
        'device',
        input.customerId,
        generation,
        queryHash(input),
      );
    } catch {
      return null;
    }
  }

  /** A cached page, or null on a miss. A list that names an unknown device is dropped. */
  private async cached(
    customerId: string,
    key: string,
    query: DeviceQuery,
    rows: Rows,
    now: number,
  ): Promise<PageRead | null> {
    let slice: { length: number; ids: string[] };
    try {
      slice = await this.cache.listSlice(key, query.offset, query.limit);
    } catch {
      return null;
    }
    if (slice.length === 0) return null;
    const read = await this.hydrate(customerId, slice.ids, rows, now);
    if (read.missing.length) {
      // LibreGrid shows a loading stub for each row that a block leaves out.
      await this.cache.remove(key).catch(() => undefined);
      return null;
    }
    return {
      rows: read.rows,
      matching: slice.length,
      stale: read.rows.filter((row) => row.stale).map((row) => row.deviceId),
    };
  }
}
```

- [ ] **Step 5: Run the pager tests to verify they pass**

Run: `node --import ./libs/application-contracts/test-register.mjs --test api/src/app/devices/device-pager.test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 6: Add the Redis primitives**

In `api/src/app/cache/cache.service.ts`, add these methods before `onApplicationShutdown`:

```ts
  /** Values of many keys, 500 per round trip. A missing key reads as null. */
  async getMany(keys: readonly string[]): Promise<(string | null)[]> {
    const values: (string | null)[] = [];
    for (const chunk of memberChunks(keys, 500)) {
      const result = await this.execute((client) => client.mGet(chunk));
      values.push(...result.map((value) => (value === null ? null : String(value))));
    }
    return values;
  }
  /** The list length and `count` items from `start`, read in one transaction. */
  async listSlice(
    key: string,
    start: number,
    count: number,
  ): Promise<{ length: number; ids: string[] }> {
    const [length, ids] = await this.execute((client) =>
      client.multi().lLen(key).lRange(key, start, start + count - 1).exec(),
    );
    return {
      length: Number(length),
      ids: Array.isArray(ids) ? ids.map(String) : [],
    };
  }
  /** Replace a list in one transaction. Large chunks keep the command queue short. */
  async replaceList(
    key: string,
    ids: readonly string[],
    seconds: number,
  ): Promise<void> {
    await this.execute(async (client) => {
      const multi = client.multi().del(key);
      for (const chunk of memberChunks(ids, 5000)) multi.rPush(key, chunk);
      await multi.expire(key, seconds).exec();
    });
  }
  /** A new connection with the same options for pub/sub. Null when Redis is not configured. */
  subscriber() {
    return this.client?.duplicate() ?? null;
  }
```

The client allows 100 queued commands. A 100,000 ID list needs 20 `RPUSH` commands of 5,000, plus `MULTI`, `DEL`, `EXPIRE`, and `EXEC`.

- [ ] **Step 7: Serve pages through the pager**

In `api/src/app/devices/devices.service.ts`:

1. Add the import `import { DevicePager, type Rows } from './device-pager';`.
2. Remove `devicePageSql`, `deviceRow`, and `staleIdsSql` from the `./device-query` import. Keep `freshnessCutoff` in the contracts import, because `device()` still uses it.
3. Below `translate`, add the helper:

```ts
/** Run statements on one transaction's client. */
const rowsOf =
  (client: PoolClient): Rows =>
  async (statement) =>
    (await client.query(statement.text, statement.values)).rows;
```

4. Add the field `private readonly pager: DevicePager;` next to `refresh`. In the constructor, after `this.refresh = ...`, add `this.pager = new DevicePager(cache);`.
5. Replace `read()` so the callback also receives the connection generation:

```ts
  /** Check authority and read in one transaction. The check takes no locks. */
  private async read<T>(
    session: SessionResponse,
    run: (
      client: PoolClient,
      customerId: string,
      connectionGeneration: number,
    ) => Promise<T>,
    empty: T,
  ): Promise<T> {
    try {
      return await this.database.transaction(async (client) => {
        const reader = (
          await client.query(
            'SELECT r.customer_id,r.generation FROM cc.device_reader($1,$2) r',
            this.actor(session),
          )
        ).rows[0];
        const customerId = reader?.['customer_id'];
        return typeof customerId === 'string'
          ? run(client, customerId, Number(reader['generation']))
          : empty;
      });
    } catch (error) {
      translate(error);
    }
  }
```

6. Replace `page()`:

```ts
  async page(
    session: SessionResponse,
    query: DeviceQuery,
    correlationId: string,
  ): Promise<DevicePage> {
    const read = await this.read(
      session,
      async (client, customerId, connectionGeneration) => {
        const inventory = await this.inventory(client, customerId);
        const selection = query.selection
          ? await this.storedSelection(session, query.selection)
          : null;
        const page = await this.pager.page({
          customerId,
          connectionGeneration,
          actor: this.actor(session),
          query,
          selection,
          rows: rowsOf(client),
        });
        return { customerId, inventory, page };
      },
      null,
    );
    if (!read)
      return {
        rows: [],
        matching: 0,
        total: 0,
        observedAt: null,
        refreshJobId: null,
      };
    // The flow starts after the read transaction closes, so the page never waits on Kestra inside Postgres.
    const refreshJobId = await this.refresh.dispatch(
      this.actor(session),
      read.customerId,
      read.page.stale,
      correlationId,
    );
    return devicePageSchema.parse({
      rows: read.page.rows,
      matching: read.page.matching,
      ...read.inventory,
      refreshJobId,
    });
  }
```

- [ ] **Step 8: Run the API checks**

Run: `npm exec -- nx run-many -t lint test build -p api --skip-nx-cache`
Expected: PASS. The `test` target runs every `api/src/app/devices/*.test.mjs` file, including the new pager tests.

- [ ] **Step 9: Commit**

```bash
git add libs/application-contracts/test-register.mjs api/src/app/cache/cache.service.ts api/src/app/devices/device-pager.ts api/src/app/devices/device-pager.test.mjs api/src/app/devices/devices.service.ts
git commit -m "feat: serve device pages from the Redis query cache"
```

---

### Task 4: by-ids and freshness endpoints

**Files:**

- Modify: `api/src/app/devices/devices.service.ts`
- Modify: `api/src/app/devices/devices.controller.ts`
- Modify: `deployment/bootstrap/application-edge.mjs`
- Modify: `deployment/bootstrap/application-edge.test.mjs`

**Interfaces:**

- Consumes: Task 1 `deviceByIdsSchema`, `deviceFreshnessSchema`, `DeviceFreshness`. Task 2 `staleCountSql`, `refreshingSql`. Task 3 `DevicesService.pager`, `rowsOf`, and the `read()` callback.
- Produces:
  - `DevicesService.rowsById(session: SessionResponse, deviceIds: readonly string[]): Promise<DeviceRow[]>`.
  - `DevicesService.freshness(session: SessionResponse, query: DeviceQuery): Promise<DeviceFreshness>`.
  - `POST /api/devices/by-ids` returns `200 { rows: DeviceRow[] }`.
  - `POST /api/devices/freshness` returns `200 { freshness: { stale, refreshing } }`.
  - The edge accepts both POST routes with the device body limit.

- [ ] **Step 1: Write the failing edge route test**

In `deployment/bootstrap/application-edge.test.mjs`, add these entries to the `routes` array after `['POST', '/api/devices/selection/resolve', 'api'],`:

```js
      ['POST', '/api/devices/by-ids', 'api'],
      ['POST', '/api/devices/freshness', 'api'],
      ['GET', '/api/devices/events', 'api'],
```

Add these entries to the rejected-route list after `['POST', '/api/devices/selection/other', 404],`:

```js
      ['POST', '/api/devices/events', 405],
      ['POST', '/api/devices/by-ids/extra', 404],
```

After the selection body size loop, add:

```js
// A by-ids body carries up to 500 device IDs.
for (const [size, status] of [
  [65536, 200],
  [98305, 413],
])
  assert.equal(
    (
      await fetch(`${origin(edge)}/api/devices/by-ids`, {
        method: 'POST',
        body: 'x'.repeat(size),
      })
    ).status,
    status,
    `by-ids ${size} bytes`,
  );
```

- [ ] **Step 2: Run the edge test to verify it fails**

Run: `node --test deployment/bootstrap/application-edge.test.mjs`
Expected: FAIL with `POST /api/devices/by-ids` returning 404.

- [ ] **Step 3: Allow the routes at the edge**

In `deployment/bootstrap/application-edge.mjs`, replace `deviceWrite` with:

```js
const deviceWrite =
  /^\/api\/devices\/(?:sync|query|groups|by-ids|freshness|selection(?:\/(?:ops|resolve))?)$/;
```

`GET /api/devices/events` already matches `deviceRead`. Task 5 gives it its own timeout.

- [ ] **Step 4: Run the edge test to verify it passes**

Run: `node --test deployment/bootstrap/application-edge.test.mjs`
Expected: PASS.

- [ ] **Step 5: Add the service methods**

In `api/src/app/devices/devices.service.ts`, add `deviceFreshnessSchema`, `type DeviceFreshness`, and `type DeviceRow` to the contracts import. Add `refreshingSql` and `staleCountSql` to the `./device-query` import. Add after `device()`:

```ts
  /** Rows for device IDs, Redis first and Postgres for misses (D7). Unknown IDs are left out. */
  async rowsById(
    session: SessionResponse,
    deviceIds: readonly string[],
  ): Promise<DeviceRow[]> {
    return this.read(
      session,
      async (client, customerId) =>
        (await this.pager.hydrate(customerId, deviceIds, rowsOf(client))).rows,
      [],
    );
  }

  /** Stale devices in a result set, and whether a refresh job runs (D11). */
  async freshness(
    session: SessionResponse,
    query: DeviceQuery,
  ): Promise<DeviceFreshness> {
    return this.read(
      session,
      async (client, customerId) => {
        const selection = query.selection
          ? await this.storedSelection(session, query.selection)
          : null;
        const [counted] = await rowsOf(client)(
          staleCountSql(customerId, query, selection, freshnessCutoff('device')),
        );
        const [running] = await rowsOf(client)(refreshingSql(customerId));
        return deviceFreshnessSchema.parse({
          stale: counted?.['stale'] ?? 0,
          refreshing: running?.['refreshing'] === true,
        });
      },
      { stale: 0, refreshing: false },
    );
  }
```

- [ ] **Step 6: Add the routes**

In `api/src/app/devices/devices.controller.ts`, add `deviceByIdsSchema` to the contracts import. Add these methods after `groups()`:

```ts
  /** Rows that a refresh signal names. The client sends only the rows its grid holds (D7). */
  @Post('by-ids')
  @HttpCode(200)
  async byIds(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = deviceByIdsSchema.parse(body);
    await this.current(request);
    return {
      rows: await this.devices.rowsById(request.session, input.deviceIds),
    };
  }

  @Post('freshness')
  @HttpCode(200)
  async freshness(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const input = deviceQuerySchema.parse(body);
    await this.current(request);
    return {
      freshness: await this.devices.freshness(request.session, input),
    };
  }
```

- [ ] **Step 7: Run the API checks**

Run: `npm exec -- nx run-many -t lint test build -p api --skip-nx-cache`
Expected: PASS. Task 8 drives both routes end to end.

- [ ] **Step 8: Commit**

```bash
git add api/src/app/devices/devices.service.ts api/src/app/devices/devices.controller.ts deployment/bootstrap/application-edge.mjs deployment/bootstrap/application-edge.test.mjs
git commit -m "feat: add by-ids and freshness device endpoints"
```

---

### Task 5: Event stream

**Files:**

- Create: `api/src/app/devices/device-events.ts`
- Create: `api/src/app/devices/device-events.test.mjs`
- Create: `api/src/app/devices/device-events.service.ts`
- Modify: `api/src/app/devices/devices.controller.ts`
- Modify: `api/src/app/devices/devices.module.ts`
- Modify: `deployment/bootstrap/application-edge.mjs`
- Modify: `deployment/bootstrap/application-edge.test.mjs`

**Interfaces:**

- Consumes: Task 1 `ENTITY_EVENTS_PING_SECONDS`. Task 3 `CacheService.subscriber()`. Existing `entityEventSchema`, `entityEventsChannel`, `EntityEvent`, `AuthService.authenticate(cookie, permission, correlationId)`, `DevicesController.current()`.
- Produces:
  - From `api/src/app/devices/device-events.ts`:
    - `interface EventListener { event(event: EntityEvent): void; close(): void }`.
    - `interface Subscriber { subscribe(channel: string, onMessage: (message: string) => void): Promise<void>; unsubscribe(channel: string): Promise<void>; close(): Promise<void> }`.
    - `class EventFanout` with `constructor(open: (lost: () => void) => Promise<Subscriber>)`, `listen(customerId: string, listener: EventListener): Promise<() => Promise<void>>`, `close(): Promise<void>`.
    - `frame(name: string, data: unknown): string` and `MAX_BUFFERED_BYTES = 1_048_576`.
    - `interface EventSink { write(chunk: string): boolean; end(): void; once(event: 'close', listener: () => void): unknown; readonly writableLength: number }`.
    - `streamEvents(sink: EventSink, options: { customerId: string; fanout: Pick<EventFanout, 'listen'>; begin: () => void; recheck: () => Promise<boolean>; pingMs?: number }): Promise<boolean>`. It returns false when the subscription failed and nothing was written.
  - `DeviceEventsService` (Nest) with `readonly fanout: EventFanout`.
  - `GET /api/devices/events`: `200 text/event-stream`, `409 { reason: 'connection-required' }`, or `503 { reason: 'events-unavailable' }`.
  - `upstreamTimeouts = { request: 45000, events: 75000 }` exported from `application-edge.mjs`. `proxyApplication` takes `timeouts` as an optional sixth argument.

- [ ] **Step 1: Write the failing fanout and stream tests**

Create `api/src/app/devices/device-events.test.mjs`:

```js
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import {
  EventFanout,
  MAX_BUFFERED_BYTES,
  frame,
  streamEvents,
} from './device-events.ts';

const batch = (deviceIds = ['d1']) => ({
  type: 'entity-batch',
  jobId: '33333333-3333-4333-8333-333333333333',
  entityType: 'device',
  batch: 0,
  batchCount: 1,
  deviceIds,
  removedIds: [],
});
const ping = 'event: ping\ndata: {}\n\n';

/** Redis subscriber stand-ins. `lost()` reports a dropped connection. */
function subscribers() {
  const opened = [];
  const open = async (lost) => {
    const handlers = new Map();
    const subscriber = {
      calls: [],
      closed: false,
      lost,
      async subscribe(channel, onMessage) {
        subscriber.calls.push(['subscribe', channel]);
        handlers.set(channel, onMessage);
      },
      async unsubscribe(channel) {
        subscriber.calls.push(['unsubscribe', channel]);
        handlers.delete(channel);
      },
      async close() {
        subscriber.closed = true;
      },
      publish(channel, message) {
        handlers.get(channel)?.(message);
      },
    };
    opened.push(subscriber);
    return subscriber;
  };
  return { opened, open };
}

const collector = () => {
  const listener = {
    events: [],
    closed: 0,
    event: (event) => listener.events.push(event),
    close: () => {
      listener.closed += 1;
    },
  };
  return listener;
};

test('one subscriber serves every stream and a channel unsubscribes after its last stream', async () => {
  const { opened, open } = subscribers();
  const fanout = new EventFanout(open);
  const leaveFirst = await fanout.listen('C0123456', collector());
  const leaveSecond = await fanout.listen('C0123456', collector());
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].calls, [
    ['subscribe', 'cc:entity-events:C0123456'],
  ]);
  await leaveFirst();
  assert.equal(opened[0].calls.length, 1);
  await leaveSecond();
  assert.deepEqual(opened[0].calls.at(-1), [
    'unsubscribe',
    'cc:entity-events:C0123456',
  ]);
});

test('events reach only their customer and invalid messages are dropped', async () => {
  const { opened, open } = subscribers();
  const fanout = new EventFanout(open);
  const mine = collector();
  const other = collector();
  await fanout.listen('C0123456', mine);
  await fanout.listen('C0999999', other);
  opened[0].publish('cc:entity-events:C0123456', JSON.stringify(batch()));
  opened[0].publish('cc:entity-events:C0123456', '{"type":"entity-batch"}');
  opened[0].publish('cc:entity-events:C0123456', 'not json');
  assert.deepEqual(mine.events, [batch()]);
  assert.deepEqual(other.events, []);
});

test('a lost subscriber closes every stream and the next stream reconnects', async () => {
  const { opened, open } = subscribers();
  const fanout = new EventFanout(open);
  const first = collector();
  await fanout.listen('C0123456', first);
  opened[0].lost();
  assert.equal(first.closed, 1);
  const second = collector();
  await fanout.listen('C0123456', second);
  assert.equal(opened[0].closed, true);
  assert.equal(opened.length, 2);
  opened[0].lost();
  assert.equal(
    second.closed,
    0,
    'A late end event from the old connection changes nothing.',
  );
});

test('a failed subscription rejects the stream and the next stream retries', async () => {
  let attempts = 0;
  const fanout = new EventFanout(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('redis down');
    return {
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
      close: async () => undefined,
    };
  });
  await assert.rejects(fanout.listen('C0123456', collector()));
  await fanout.listen('C0123456', collector());
  assert.equal(attempts, 2);
});

test('closing the fanout ends every stream', async () => {
  const { open } = subscribers();
  const fanout = new EventFanout(open);
  const listener = collector();
  await fanout.listen('C0123456', listener);
  await fanout.close();
  assert.equal(listener.closed, 1);
});

/** An SSE response stand-in. */
function sink() {
  const emitter = new EventEmitter();
  const response = {
    chunks: [],
    ended: false,
    began: 0,
    writableLength: 0,
    write(chunk) {
      response.chunks.push(chunk);
      return true;
    },
    end() {
      response.ended = true;
    },
    once: (name, listener) => emitter.once(name, listener),
    disconnect: () => emitter.emit('close'),
  };
  return response;
}

const fanoutWith = (listeners) => ({
  async listen(customerId, listener) {
    listeners.push({ customerId, listener });
    return async () => {
      listeners.splice(
        listeners.findIndex((entry) => entry.listener === listener),
        1,
      );
    };
  },
});

test('a stream starts after the subscription and sends named events and pings', async () => {
  const listeners = [];
  const response = sink();
  let checks = 0;
  const started = await streamEvents(response, {
    customerId: 'C0123456',
    fanout: fanoutWith(listeners),
    begin: () => {
      response.began += 1;
    },
    recheck: async () => {
      checks += 1;
      return true;
    },
    pingMs: 10,
  });
  assert.equal(started, true);
  assert.equal(response.began, 1);
  assert.equal(listeners[0].customerId, 'C0123456');
  assert.equal(response.chunks[0], 'retry: 3000\n\n');
  listeners[0].listener.event(batch());
  assert.equal(response.chunks[1], frame('entity-batch', batch()));
  assert.equal(frame('ping', {}), ping);
  await wait(35);
  assert.ok(checks >= 2);
  assert.ok(response.chunks.filter((chunk) => chunk === ping).length >= 2);
  response.disconnect();
  assert.equal(listeners.length, 0, 'Leaving unsubscribes.');
});

test('a failed session check ends the stream', async () => {
  const listeners = [];
  const response = sink();
  await streamEvents(response, {
    customerId: 'C0123456',
    fanout: fanoutWith(listeners),
    begin: () => undefined,
    recheck: async () => false,
    pingMs: 10,
  });
  await wait(25);
  assert.equal(response.ended, true);
  assert.equal(listeners.length, 0);
  assert.equal(response.chunks.includes(ping), false);
});

test('a slow browser loses its stream instead of buffering without bound', async () => {
  const listeners = [];
  const response = sink();
  await streamEvents(response, {
    customerId: 'C0123456',
    fanout: fanoutWith(listeners),
    begin: () => undefined,
    recheck: async () => true,
    pingMs: 60_000,
  });
  response.writableLength = MAX_BUFFERED_BYTES + 1;
  listeners[0].listener.event(batch());
  assert.equal(response.ended, true);
  assert.equal(listeners.length, 0);
});

test('a stream whose subscription fails writes nothing', async () => {
  const response = sink();
  const started = await streamEvents(response, {
    customerId: 'C0123456',
    fanout: {
      listen: async () => {
        throw new Error('redis down');
      },
    },
    begin: () => {
      response.began += 1;
    },
    recheck: async () => true,
  });
  assert.equal(started, false);
  assert.equal(response.began, 0);
  assert.deepEqual(response.chunks, []);
});

test('a browser that leaves during the subscription unsubscribes', async () => {
  const response = sink();
  let left = false;
  let release;
  const started = streamEvents(response, {
    customerId: 'C0123456',
    fanout: {
      listen: () =>
        new Promise((resolve) => {
          release = () =>
            resolve(async () => {
              left = true;
            });
        }),
    },
    begin: () => {
      response.began += 1;
    },
    recheck: async () => true,
  });
  response.disconnect();
  release();
  assert.equal(await started, true);
  assert.equal(left, true);
  assert.equal(response.began, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import ./libs/application-contracts/test-register.mjs --test api/src/app/devices/device-events.test.mjs`
Expected: FAIL with `Cannot find module` for `./device-events.ts`.

- [ ] **Step 3: Write the fanout and the stream writer**

Create `api/src/app/devices/device-events.ts`:

```ts
import {
  ENTITY_EVENTS_PING_SECONDS,
  entityEventSchema,
  entityEventsChannel,
  type EntityEvent,
} from '@campus/application-contracts';

/** One open event stream. */
export interface EventListener {
  event(event: EntityEvent): void;
  /** The subscriber connection ended. The stream closes so the browser reconnects and reconciles. */
  close(): void;
}

/** A dedicated Redis connection in subscriber mode. */
export interface Subscriber {
  subscribe(
    channel: string,
    onMessage: (message: string) => void,
  ): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  close(): Promise<void>;
}

interface Channel {
  listeners: Set<EventListener>;
  ready: Promise<void>;
}

/**
 * Fans worker events out to open streams (D6). One subscriber connection serves every customer.
 * A channel stays subscribed while it has listeners. Pub/Sub keeps no history, so a lost connection closes every stream.
 */
export class EventFanout {
  // Explicit fields: Node's type-stripping test runner rejects parameter properties.
  private readonly open: (lost: () => void) => Promise<Subscriber>;
  private subscriber: Promise<Subscriber> | null = null;
  private readonly channels = new Map<string, Channel>();

  constructor(open: (lost: () => void) => Promise<Subscriber>) {
    this.open = open;
  }

  /** Returns the function that removes the listener. */
  async listen(
    customerId: string,
    listener: EventListener,
  ): Promise<() => Promise<void>> {
    const channel = entityEventsChannel(customerId);
    let entry = this.channels.get(channel);
    if (!entry) {
      const created: Channel = {
        listeners: new Set(),
        ready: this.connection().then((subscriber) =>
          subscriber.subscribe(channel, (message) =>
            this.deliver(channel, message),
          ),
        ),
      };
      created.ready.catch(() => {
        if (this.channels.get(channel) === created)
          this.channels.delete(channel);
      });
      this.channels.set(channel, created);
      entry = created;
    }
    entry.listeners.add(listener);
    try {
      await entry.ready;
    } catch (error) {
      entry.listeners.delete(listener);
      throw error;
    }
    return async () => {
      const current = this.channels.get(channel);
      if (!current?.listeners.delete(listener) || current.listeners.size)
        return;
      this.channels.delete(channel);
      const subscriber = this.subscriber;
      await subscriber
        ?.then((connection) => connection.unsubscribe(channel))
        .catch(() => undefined);
    };
  }

  /** Shutdown ends every stream, so the HTTP server can close. */
  async close(): Promise<void> {
    this.lose();
  }

  private deliver(channel: string, message: string): void {
    let event: EntityEvent;
    try {
      event = entityEventSchema.parse(JSON.parse(message));
    } catch {
      // The worker publishes only valid events. Anything else is dropped.
      return;
    }
    for (const listener of this.channels.get(channel)?.listeners ?? [])
      listener.event(event);
  }

  private lose(): void {
    const listeners = [...this.channels.values()].flatMap((entry) => [
      ...entry.listeners,
    ]);
    this.channels.clear();
    const previous = this.subscriber;
    this.subscriber = null;
    void previous
      ?.then((subscriber) => subscriber.close())
      .catch(() => undefined);
    for (const listener of listeners) listener.close();
  }

  private connection(): Promise<Subscriber> {
    if (this.subscriber) return this.subscriber;
    // Only the current connection may report a loss. A late end event from an old one changes nothing.
    const current: Promise<Subscriber> = this.open(() => {
      if (this.subscriber === current) this.lose();
    });
    this.subscriber = current;
    current.catch(() => {
      if (this.subscriber === current) this.subscriber = null;
    });
    return current;
  }
}

/** Bytes buffered for one browser before its stream ends. The browser reconnects and reconciles. */
export const MAX_BUFFERED_BYTES = 1_048_576;

/** One SSE frame. The payload type names the event, so EventSource listens by name. */
export function frame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The writable side of one SSE response. */
export interface EventSink {
  write(chunk: string): boolean;
  end(): void;
  once(event: 'close', listener: () => void): unknown;
  readonly writableLength: number;
}

/**
 * Stream one customer's events to one browser (D6, D12). The stream starts after the subscription is active,
 * so a reconnect that reads state afterwards misses nothing. Each ping re-checks the session first.
 */
export async function streamEvents(
  sink: EventSink,
  options: {
    customerId: string;
    fanout: Pick<EventFanout, 'listen'>;
    begin: () => void;
    recheck: () => Promise<boolean>;
    pingMs?: number;
  },
): Promise<boolean> {
  let closed = false;
  let started = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unlisten: (() => Promise<void>) | undefined;
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    void unlisten?.().catch(() => undefined);
    sink.end();
  };
  const send = (chunk: string) => {
    if (closed || !started) return;
    sink.write(chunk);
    if (sink.writableLength > MAX_BUFFERED_BYTES) finish();
  };
  sink.once('close', finish);
  try {
    unlisten = await options.fanout.listen(options.customerId, {
      event: (event) => send(frame(event.type, event)),
      close: finish,
    });
  } catch {
    return false;
  }
  if (closed) {
    await unlisten().catch(() => undefined);
    return true;
  }
  options.begin();
  started = true;
  sink.write('retry: 3000\n\n');
  timer = setInterval(
    () => {
      void options.recheck().then(
        (allowed) => (allowed ? send(frame('ping', {})) : finish()),
        () => finish(),
      );
    },
    options.pingMs ?? ENTITY_EVENTS_PING_SECONDS * 1000,
  );
  return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import ./libs/application-contracts/test-register.mjs --test api/src/app/devices/device-events.test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 5: Own the subscriber connection in a Nest service**

Create `api/src/app/devices/device-events.service.ts`:

```ts
import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';
import { EventFanout } from './device-events';

/** One Redis subscriber connection per API instance (D6). */
@Injectable()
export class DeviceEventsService implements BeforeApplicationShutdown {
  readonly fanout: EventFanout;

  constructor(cache: CacheService) {
    this.fanout = new EventFanout(async (lost) => {
      const client = cache.subscriber();
      if (!client) throw new Error('The event service is unavailable.');
      // The client does not reconnect. A lost connection closes every stream, and the next stream reconnects.
      client.on('error', lost);
      client.on('end', lost);
      await client.connect();
      return {
        subscribe: async (channel, onMessage) => {
          await client.subscribe(channel, (message) =>
            onMessage(String(message)),
          );
        },
        unsubscribe: async (channel) => {
          await client.unsubscribe(channel);
        },
        close: async () => {
          if (client.isOpen) client.destroy();
        },
      };
    });
  }

  /** Nest closes the HTTP server after this hook. Open streams would hold it open. */
  async beforeApplicationShutdown() {
    await this.fanout.close();
  }
}
```

In `api/src/app/devices/devices.module.ts`, import `DeviceEventsService` and set `providers: [DevicesService, DeviceEventsService]`.

- [ ] **Step 6: Add the route**

In `api/src/app/devices/devices.controller.ts`:

1. Add `Res` and `ServiceUnavailableException` to the `@nestjs/common` import.
2. Add `import type { Response } from 'express';`, `import { DeviceEventsService } from './device-events.service';`, and `import { streamEvents } from './device-events';`.
3. Add `private readonly events: DeviceEventsService,` to the constructor parameters.
4. Add this method directly above `@Get(':deviceId')`. Nest matches routes in declaration order, so `events` must come first:

```ts
  /** Server-Sent Events for this customer's device refreshes (D6, D12). */
  @Get('events')
  async events(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    const current = await this.current(request);
    if (!current)
      throw new ConflictException({ reason: 'connection-required' });
    const started = await streamEvents(response, {
      customerId: current.customerId,
      fanout: this.events.fanout,
      begin: () => {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        });
      },
      // A ping goes out only while the session and devices:read still hold for this customer.
      recheck: async () => {
        try {
          request.session = await this.auth.authenticate(
            request.headers.cookie,
            'identity:read',
            request.correlationId,
          );
          return (await this.current(request))?.customerId === current.customerId;
        } catch {
          return false;
        }
      },
    });
    if (!started)
      throw new ServiceUnavailableException({ reason: 'events-unavailable' });
  }
```

- [ ] **Step 7: Write the failing edge stream test**

In `deployment/bootstrap/application-edge.test.mjs`, append:

```js
test('the device event stream outlives the request timeout while pings flow', async () => {
  const listen = (server) =>
    new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = (server) => `http://127.0.0.1:${server.address().port}`;
  const api = http.createServer((request, response) => {
    if (!request.url.startsWith('/api/devices/events')) return;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('retry: 3000\n\n');
    // A silent stream must end at the edge.
    if (request.url.endsWith('silent=1')) return;
    let sent = 0;
    const timer = setInterval(() => {
      response.write('event: ping\ndata: {}\n\n');
      sent += 1;
      if (sent === 6) {
        clearInterval(timer);
        response.end();
      }
    }, 50);
  });
  const frontend = http.createServer((request, response) =>
    response.end('frontend'),
  );
  let edge;
  try {
    await listen(api);
    await listen(frontend);
    edge = http.createServer((request, response) =>
      proxyApplication(
        request,
        response,
        {
          frontend: { url: new URL(origin(frontend)) },
          api: { url: new URL(origin(api)) },
        },
        origin(edge),
        3,
        { request: 120, events: 200 },
      ),
    );
    await listen(edge);
    const guard = () => ({ signal: AbortSignal.timeout(2000) });
    const events = await fetch(`${origin(edge)}/api/devices/events`, guard());
    assert.equal(events.headers.get('content-type'), 'text/event-stream');
    assert.equal(events.headers.get('cache-control'), 'no-store');
    const text = await events.text();
    assert.equal(
      text.split('event: ping').length - 1,
      6,
      'The stream ran past the 120 ms request timeout.',
    );
    const silent = await fetch(
      `${origin(edge)}/api/devices/events?silent=1`,
      guard(),
    );
    const quiet = Date.now();
    await assert.rejects(silent.text());
    assert.ok(Date.now() - quiet < 1000, 'The edge ended the silent stream.');
    // Every other request keeps the request timeout.
    assert.equal(
      (await fetch(`${origin(edge)}/api/devices/sync`, guard())).status,
      502,
    );
  } finally {
    for (const server of [edge, frontend, api])
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
  }
});
```

- [ ] **Step 8: Run the edge test to verify it fails**

Run: `node --test deployment/bootstrap/application-edge.test.mjs`
Expected: FAIL with `The edge ended the silent stream.` The edge ignores the sixth argument and keeps 45 seconds, so the 2 second guard aborts the silent stream instead.

- [ ] **Step 9: Give the event stream its own idle timeout**

In `deployment/bootstrap/application-edge.mjs`, add above `proxyApplication`:

```js
/**
 * Upstream idle timeouts in milliseconds. Node applies `timeout` to socket inactivity.
 * The event stream pings every 25 seconds, so 75 seconds allows two missed pings.
 */
export const upstreamTimeouts = { request: 45000, events: 75000 };
```

Change the signature to:

```js
export async function proxyApplication(
  request,
  response,
  upstreams,
  publicOrigin,
  phase = 2,
  timeouts = upstreamTimeouts,
) {
```

In the `transport.request` options, replace `timeout: 45000,` with:

```js
      timeout:
        pathname === '/api/devices/events' ? timeouts.events : timeouts.request,
```

The edge server's `requestTimeout` of 10 seconds covers only the receipt of the request. A GET stream is received at once, so that limit does not apply.

- [ ] **Step 10: Run the checks**

Run: `node --test deployment/bootstrap/application-edge.test.mjs`
Expected: PASS.

Run: `npm exec -- nx run-many -t lint test build -p api --skip-nx-cache`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add api/src/app/devices/device-events.ts api/src/app/devices/device-events.test.mjs api/src/app/devices/device-events.service.ts api/src/app/devices/devices.controller.ts api/src/app/devices/devices.module.ts deployment/bootstrap/application-edge.mjs deployment/bootstrap/application-edge.test.mjs
git commit -m "feat: stream device refresh events over Server-Sent Events"
```

---

### Task 6: Event stream, row refresh, and stale counts in the store

**Files:**

- Create: `frontend/src/app/devices/device-row-refresh.ts`
- Create: `frontend/src/app/devices/device-row-refresh.spec.ts`
- Modify: `frontend/src/app/devices/devices.store.ts`
- Modify: `frontend/src/app/devices/devices.store.spec.ts`
- Modify: `frontend/src/app/devices/device-grid.ts`
- Modify: `frontend/src/app/devices/devices.ts`
- Modify: `frontend/src/app/devices/devices.html`
- Modify: `frontend/src/app/devices/devices.spec.ts`

**Interfaces:**

- Consumes: Task 1 `DEVICE_BY_IDS_LIMIT`, `ENTITY_EVENTS_PING_SECONDS`, `deviceRowsSchema`, `deviceFreshnessSchema`, `DeviceFreshness`. Task 4 `POST /api/devices/by-ids` and `POST /api/devices/freshness`. Task 5 `GET /api/devices/events`. Existing `entityEventSchema`, `DeviceSyncFailure`.
- Produces:
  - `DeviceRowRefresh` with `attach(api)`, `detach(api)`, `held(test?: (row: DeviceRow) => boolean): string[]`, `apply(rows: readonly DeviceRow[]): void`. `api` is `Pick<GridApi<DeviceRow>, 'forEachNode' | 'getRowNode'>`.
  - `DevicesStore`:
    - `freshness: Signal<DeviceFreshness | null>` and `jobFailure: Signal<DeviceSyncFailure | null>`. Task 7 reads both.
    - `gridRows: DeviceRowRefresh`.
    - `init()` reads the status and opens the stream. `leave()` closes it.
    - `recount(): Promise<void>`.
    - Test hooks: `eventSource`, `recountDelay`, `reopenDelay`, `streamTimeout`.
    - `pollInterval` and the private `poll()` are gone.
  - `DeviceEventSource = Pick<EventSource, 'addEventListener' | 'close' | 'readyState'>`.
  - `DeviceGrid` input `rowRefresh: DeviceRowRefresh | null`.

- [ ] **Step 1: Write the failing row refresh tests**

Create `frontend/src/app/devices/device-row-refresh.spec.ts`:

```ts
import { vi } from 'vitest';
import type { DeviceRow } from '@campus/application-contracts';
import { DeviceRowRefresh } from './device-row-refresh';

const rowFor = (deviceId: string, stale: boolean): DeviceRow => ({
  deviceId,
  serialNumber: deviceId.toUpperCase(),
  model: null,
  assetTag: null,
  orgUnitPath: '/',
  lastContact: null,
  annotatedLocation: null,
  notes: null,
  battery: { status: 'no-report' },
  lastEntitySync: '2026-10-06T11:00:00.000Z',
  stale,
});

function grid(rows: DeviceRow[]) {
  const nodes = rows.map((data) => ({
    id: data.deviceId,
    data,
    group: false,
    updateData: vi.fn(),
  }));
  const group = {
    id: 'group',
    data: { key: '/', devices: 2 },
    group: true,
    updateData: vi.fn(),
  };
  const api = {
    forEachNode: (visit: (node: unknown) => void) =>
      [...nodes, group].forEach(visit),
    getRowNode: (id: string) =>
      [...nodes, group].find((node) => node.id === id),
  };
  return { nodes, group, api: api as never };
}

it('lists the device rows the grid holds and skips group rows', () => {
  const refresh = new DeviceRowRefresh();
  expect(refresh.held()).toEqual([]);
  const { api } = grid([rowFor('d1', true), rowFor('d2', false)]);
  refresh.attach(api);
  expect(refresh.held()).toEqual(['d1', 'd2']);
  expect(refresh.held((row) => row.stale)).toEqual(['d1']);
});

it('updates held rows in place and ignores the rest', () => {
  const refresh = new DeviceRowRefresh();
  const { nodes, group, api } = grid([rowFor('d1', true)]);
  refresh.attach(api);
  refresh.apply([rowFor('d1', false), rowFor('d9', false)]);
  expect(nodes[0].updateData).toHaveBeenCalledWith(rowFor('d1', false));
  expect(group.updateData).not.toHaveBeenCalled();
});

it('forgets a grid that detached', () => {
  const refresh = new DeviceRowRefresh();
  const first = grid([rowFor('d1', true)]);
  const second = grid([rowFor('d2', true)]);
  refresh.attach(first.api);
  refresh.attach(second.api);
  refresh.detach(first.api);
  expect(refresh.held()).toEqual(['d2']);
  refresh.detach(second.api);
  expect(refresh.held()).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm exec -- nx run frontend:test --include=src/app/devices/device-row-refresh.spec.ts`
Expected: FAIL with a missing module error for `./device-row-refresh`.

- [ ] **Step 3: Write the row refresh**

Create `frontend/src/app/devices/device-row-refresh.ts`:

```ts
import type { GridApi } from 'ag-grid-community';
import type { DeviceRow } from '@campus/application-contracts';

type RowApi = Pick<GridApi<DeviceRow>, 'forEachNode' | 'getRowNode'>;

/** The device rows that the grid holds. Refresh signals update them in place (D7). */
export class DeviceRowRefresh {
  private api: RowApi | null = null;

  attach(api: RowApi): void {
    this.api = api;
  }

  detach(api: RowApi): void {
    if (this.api === api) this.api = null;
  }

  /** IDs of loaded device rows that pass `test`. Group rows carry no device. */
  held(test: (row: DeviceRow) => boolean = () => true): string[] {
    const ids: string[] = [];
    this.api?.forEachNode((node) => {
      if (!node.group && node.data && test(node.data))
        ids.push(node.data.deviceId);
    });
    return ids;
  }

  /** Replace the data of loaded rows. LibreGrid refreshes their cells. */
  apply(rows: readonly DeviceRow[]): void {
    for (const row of rows) {
      const node = this.api?.getRowNode(row.deviceId);
      if (node && !node.group) node.updateData(row);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm exec -- nx run frontend:test --include=src/app/devices/device-row-refresh.spec.ts`
Expected: PASS.

- [ ] **Step 5: Replace the poll tests with stream tests**

In `frontend/src/app/devices/devices.store.spec.ts`:

1. In `setup()`, replace the line `store.pollInterval = 0;` with `store.streamTimeout = 0;`. No test leaves a watchdog timer behind.
2. Delete these four tests: `polls a refresh until it settles and reloads with the same filters`, `follows a refresh that is already running`, `resumes following a running refresh after Reconnect`, and `stops following a refresh when the session ends`.
3. Add `import type { DevicePredicate, DeviceRow } from '@campus/application-contracts';` and `import type { DeviceEventSource } from './devices.store';`.
4. Append:

```ts
const JOB = '33333333-3333-4333-8333-333333333333';
const job = (failure: string | null) => ({
  jobId: JOB,
  customerId: 'C0123456',
  entityType: 'device',
  batchCount: 1,
  completedBatches: failure ? 0 : 1,
  failedBatches: failure ? 1 : 0,
  failure,
  createdAt: '2026-10-06T12:00:00.000Z',
  finishedAt: '2026-10-06T12:01:00.000Z',
});
const batchEvent = (deviceIds: string[], removedIds: string[] = []) => ({
  type: 'entity-batch',
  jobId: JOB,
  entityType: 'device',
  batch: 0,
  batchCount: 1,
  deviceIds,
  removedIds,
});

/** Answers each request by path. A path without a route fails like the network. */
function routes(table: Record<string, (body: unknown) => Response>) {
  return vi.fn(async (path: string, body?: unknown) => {
    const route = table[path];
    if (!route) throw new TypeError('Failed to fetch');
    return route(body);
  });
}

/** A controllable EventSource. */
class FakeStream {
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();
  addEventListener(name: string, listener: (event: Event) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.fire('open');
  }
  send(name: string, data: unknown): void {
    this.fire(name, JSON.stringify(data));
  }
  fail(readyState: number): void {
    this.readyState = readyState;
    this.fire('error');
  }
  private fire(name: string, data?: string): void {
    for (const listener of this.listeners.get(name) ?? [])
      listener({ data } as unknown as Event);
  }
}

function streams(store: DevicesStore): FakeStream[] {
  const opened: FakeStream[] = [];
  store.eventSource = () => {
    const stream = new FakeStream();
    opened.push(stream);
    return stream as unknown as DeviceEventSource;
  };
  return opened;
}

const rowFor = (deviceId: string, stale: boolean): DeviceRow => ({
  deviceId,
  serialNumber: deviceId.toUpperCase(),
  model: null,
  assetTag: null,
  orgUnitPath: '/',
  lastContact: null,
  annotatedLocation: null,
  notes: null,
  battery: { status: 'no-report' },
  lastEntitySync: '2026-10-06T11:00:00.000Z',
  stale,
});

function grid(rows: DeviceRow[]) {
  const nodes = rows.map((data) => ({
    id: data.deviceId,
    data,
    group: false,
    updateData: vi.fn(),
  }));
  const api = {
    forEachNode: (visit: (node: unknown) => void) => nodes.forEach(visit),
    getRowNode: (id: string) => nodes.find((node) => node.id === id),
  };
  return { nodes, api: api as never };
}

const statusReads = (request: ReturnType<typeof routes>) =>
  request.mock.calls.filter(
    ([path, body]) => path === '/api/devices/sync' && body === undefined,
  ).length;

it('follows Refresh all through the event stream instead of polling', async () => {
  const request = routes({
    '/api/devices/sync': (body) =>
      body === undefined
        ? Response.json({ sync: state('ready') })
        : Response.json({ sync: state('running') }, { status: 201 }),
  });
  const store = setup(request);
  const opened = streams(store);
  await store.init();
  opened[0].open();
  await store.refreshAll();
  expect(store.sync()?.status).toBe('running');
  const before = store.revision();
  opened[0].send('full-sync', { type: 'full-sync', sync: state('ready') });
  expect(store.sync()?.status).toBe('ready');
  expect(store.revision()).toBe(before + 1);
  expect(statusReads(request)).toBe(1);
});

it('follows a refresh that is already running', async () => {
  const request = routes({
    '/api/devices/sync': (body) =>
      body === undefined
        ? Response.json({ sync: state('running') })
        : Response.json({ reason: 'device-sync-running' }, { status: 409 }),
  });
  const store = setup(request);
  await store.refreshAll();
  expect(store.sync()?.status).toBe('running');
  expect(store.error()).toBe('');
});

it('opens one stream while Devices is mounted and ignores it after leave', async () => {
  const request = routes({
    '/api/devices/sync': () => Response.json({ sync: state('ready') }),
  });
  const store = setup(request);
  const opened = streams(store);
  await store.init();
  await store.init();
  expect(opened).toHaveLength(1);
  store.leave();
  expect(opened[0].closed).toBe(true);
  opened[0].send('full-sync', { type: 'full-sync', sync: state('running') });
  expect(store.sync()?.status).toBe('ready');
});

it('opens no stream without a Google connection', async () => {
  const store = setup(
    routes({ '/api/devices/sync': () => Response.json({ sync: null }) }),
  );
  const opened = streams(store);
  await store.init();
  expect(opened).toHaveLength(0);
});

it('refetches only the held rows that a batch names and updates them in place', async () => {
  const request = routes({
    '/api/devices/sync': () => Response.json({ sync: state('ready') }),
    '/api/devices/by-ids': () =>
      Response.json({ rows: [rowFor('d1', false), rowFor('d2', false)] }),
    '/api/devices/freshness': () =>
      Response.json({ freshness: { stale: 0, refreshing: false } }),
  });
  const store = setup(request);
  store.recountDelay = 0;
  const opened = streams(store);
  const { nodes, api } = grid([
    rowFor('d1', true),
    rowFor('d2', true),
    rowFor('d3', true),
  ]);
  store.gridRows.attach(api);
  await store.init();
  opened[0].send('entity-batch', batchEvent(['d1', 'd9'], ['d2']));
  await vi.waitFor(() =>
    expect(nodes[0].updateData).toHaveBeenCalledWith(rowFor('d1', false)),
  );
  expect(request).toHaveBeenCalledWith('/api/devices/by-ids', {
    deviceIds: ['d1', 'd2'],
  });
  expect(nodes[2].updateData).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(store.freshness()).toEqual({ stale: 0, refreshing: false }),
  );
});

it('counts stale devices for the counted query when its counts change', async () => {
  const request = routes({
    '/api/devices/query': () => Response.json({ page }),
    '/api/devices/freshness': () =>
      Response.json({ freshness: { stale: 12, refreshing: true } }),
  });
  const store = setup(request);
  store.recountDelay = 0;
  const predicates: DevicePredicate[] = [
    { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
  ];
  store.setView({
    predicates,
    sort: { field: 'serialNumber', direction: 'asc' },
    selection: null,
  });
  await store.rows(0, 100);
  await vi.waitFor(() =>
    expect(store.freshness()).toEqual({ stale: 12, refreshing: true }),
  );
  expect(request).toHaveBeenCalledWith('/api/devices/freshness', {
    predicates,
    selection: null,
  });
});

it('keeps the cause of a failed refresh job until a new job starts', async () => {
  const request = routes({
    '/api/devices/sync': () => Response.json({ sync: state('ready') }),
    '/api/devices/query': () =>
      Response.json({ page: { ...page, refreshJobId: JOB } }),
    '/api/devices/freshness': () =>
      Response.json({ freshness: { stale: 3, refreshing: false } }),
  });
  const store = setup(request);
  const opened = streams(store);
  await store.init();
  opened[0].send('job-finished', { type: 'job-finished', job: job('quota') });
  expect(store.jobFailure()).toBe('quota');
  await store.rows(0, 100);
  expect(store.jobFailure()).toBeNull();
});

it('reconciles after a reconnect: one status read, held stale rows, and a recount', async () => {
  const request = routes({
    '/api/devices/sync': () => Response.json({ sync: state('ready') }),
    '/api/devices/by-ids': () =>
      Response.json({ rows: [rowFor('d1', false), rowFor('d3', false)] }),
    '/api/devices/freshness': () =>
      Response.json({ freshness: { stale: 0, refreshing: false } }),
  });
  const store = setup(request);
  const opened = streams(store);
  const { api } = grid([
    rowFor('d1', true),
    rowFor('d2', false),
    rowFor('d3', true),
  ]);
  store.gridRows.attach(api);
  await store.init();
  opened[0].open();
  expect(statusReads(request)).toBe(1);
  // The browser retries by itself while the stream is CONNECTING.
  opened[0].fail(0);
  opened[0].open();
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith('/api/devices/freshness', {
      predicates: [],
      selection: null,
    }),
  );
  expect(statusReads(request)).toBe(2);
  expect(request).toHaveBeenCalledWith('/api/devices/by-ids', {
    deviceIds: ['d1', 'd3'],
  });
  expect(opened).toHaveLength(1);
});

it('reopens a closed stream after a status read and stays closed after the session ends', async () => {
  let signedIn = true;
  const request = routes({
    '/api/devices/sync': () =>
      signedIn
        ? Response.json({ sync: state('ready') })
        : Response.json({ code: 'access-changed' }, { status: 401 }),
  });
  const store = setup(request);
  store.reopenDelay = 0;
  const opened = streams(store);
  await store.init();
  opened[0].open();
  opened[0].fail(2);
  await vi.waitFor(() => expect(opened).toHaveLength(2));
  expect(opened[0].closed).toBe(true);
  opened[0].send('full-sync', { type: 'full-sync', sync: state('running') });
  expect(store.sync()?.status).toBe('ready');
  signedIn = false;
  opened[1].fail(2);
  await vi.waitFor(() => expect(statusReads(request)).toBe(3));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(opened).toHaveLength(2);
});

it('reopens a stream that stays silent past the timeout', async () => {
  vi.useFakeTimers();
  try {
    const request = routes({
      '/api/devices/sync': () => Response.json({ sync: state('ready') }),
    });
    const store = setup(request);
    store.streamTimeout = 1000;
    store.reopenDelay = 0;
    const opened = streams(store);
    await store.init();
    opened[0].open();
    await vi.advanceTimersByTimeAsync(900);
    opened[0].send('ping', {});
    await vi.advanceTimersByTimeAsync(900);
    expect(opened).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(opened).toHaveLength(2));
  } finally {
    vi.useRealTimers();
  }
});
```

The existing test `keeps the last counts and reports offline when the network fails` stays. `reconnect()` still reloads the grid once.

- [ ] **Step 6: Run the store tests to verify they fail**

Run: `npm exec -- nx run frontend:test --include=src/app/devices/devices.store.spec.ts`
Expected: FAIL. `store.leave`, `store.gridRows`, and `store.eventSource` do not exist yet.

- [ ] **Step 7: Rewrite the store**

Replace `frontend/src/app/devices/devices.store.ts` with:

```ts
import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  DEVICE_BY_IDS_LIMIT,
  ENTITY_EVENTS_PING_SECONDS,
  deviceDetailSchema,
  deviceFreshnessSchema,
  deviceOrgUnitsSchema,
  deviceGroupPageSchema,
  devicePageSchema,
  deviceRowsSchema,
  deviceSyncStateSchema,
  entityEventSchema,
  type DeviceDetail,
  type DeviceFreshness,
  type DeviceOrgUnit,
  type DeviceGroupPage,
  type DevicePage,
  type DevicePredicate,
  type DeviceRow,
  type DeviceSelectionKey,
  type DeviceSyncFailure,
  type DeviceSyncState,
} from '@campus/application-contracts';
import type { GridState } from 'ag-grid-community';
import { AuthStore } from '../auth.store';
import { GROUP_LIMIT, type DeviceView } from './device-datasource';
import { samePredicates } from './device-filter-model';
import { DeviceRowRefresh } from './device-row-refresh';
import {
  DeviceSelectionProvider,
  deviceSelectionTab,
} from './device-selection';

export function devicesReadable(auth: InstanceType<typeof AuthStore>): boolean {
  return (
    auth.metadata()?.phase === 3 &&
    !!auth
      .session()
      ?.identity.grants.some((grant) => grant.action === 'devices:read')
  );
}

const defaultView = (): DeviceView => ({
  predicates: [],
  sort: { field: 'serialNumber', direction: 'asc' },
  selection: null,
});

/** Only the outermost query reports counts. Open groups and Next device leave them alone. */
const countsKey = (view: DeviceView): string | null =>
  view.group?.keys.length
    ? null
    : JSON.stringify([view.predicates, view.selection, view.group?.by ?? []]);

/** The part of EventSource that the store uses. Tests supply a fake. */
export type DeviceEventSource = Pick<
  EventSource,
  'addEventListener' | 'close' | 'readyState'
>;
const CLOSED = 2;

/** The query whose stale devices the banner counts: the outermost filters and selection. */
interface CountedQuery {
  predicates: DevicePredicate[];
  selection: DeviceSelectionKey | null;
}

/** Browsing state survives navigation between the grid and device details. */
@Injectable({ providedIn: 'root' })
export class DevicesStore {
  private readonly auth = inject(AuthStore);
  /** Opens the device event stream. Tests replace it. */
  eventSource: (url: string) => DeviceEventSource = (url) =>
    new EventSource(url);
  /** Milliseconds between a refresh signal and the stale count that it triggers. */
  recountDelay = 1000;
  /** Milliseconds before a closed stream reopens. */
  reopenDelay = 5000;
  /** Milliseconds without any event, pings included, before the stream counts as dead. */
  streamTimeout = ENTITY_EVENTS_PING_SECONDS * 2000 + 10_000;
  readonly sync = signal<DeviceSyncState | null>(null);
  readonly syncLoaded = signal(false);
  readonly predicates = signal<DevicePredicate[]>([]);
  /** The query the grid last ran. Next device follows it. */
  readonly view = signal<DeviceView>(defaultView());
  /** Grid columns, filters, sort, and page, kept while device details are open. */
  readonly gridState = signal<GridState | null>(null);
  /** Show All Selected was on when the grid closed. Back to devices reopens it. */
  readonly selectedView = signal(false);
  readonly selection = new DeviceSelectionProvider(
    (path, body) => this.call(path, body),
    () => ({
      predicates: this.view().predicates,
      by: this.view().group?.by ?? [],
    }),
  );
  readonly selectionTab = deviceSelectionTab();
  readonly page = signal<Omit<DevicePage, 'rows' | 'refreshJobId'> | null>(
    null,
  );
  /** Stale devices in the counted result set, and whether a refresh job runs (D11). */
  readonly freshness = signal<DeviceFreshness | null>(null);
  /** The cause of the last refresh job that failed. A new refresh job clears it. */
  readonly jobFailure = signal<DeviceSyncFailure | null>(null);
  /** The device rows that the grid holds. The grid attaches itself when ready. */
  readonly gridRows = new DeviceRowRefresh();
  /** True when an open group or a grouped level holds more than the grid lists. */
  readonly groupLimit = signal(false);
  /** The outermost query whose counts the status bar shows. */
  private counted = countsKey(defaultView());
  private countedQuery: CountedQuery = { predicates: [], selection: null };
  /** The counts and revision that the last stale count belongs to. */
  private recounted: string | null = null;
  readonly orgUnits = signal<DeviceOrgUnit[]>([]);
  readonly offline = signal(false);
  readonly error = signal('');
  /** Increments when the grid must reload from the first block. */
  readonly revision = signal(0);
  /** Row index and ID of the last opened device in the current filtered order. */
  readonly position = signal<{
    index: number;
    deviceId: string;
    /** Rows that Next device can walk. Set for a device opened inside a group. */
    count?: number;
  } | null>(null);
  /** A full sync runs. */
  readonly refreshing = computed(() => this.sync()?.status === 'running');
  readonly readable = computed(() => devicesReadable(this.auth));
  private stream: DeviceEventSource | null = null;
  /** Devices is mounted. */
  private streamWanted = false;
  /** A stream opened once since mount. The next open is a reconnect. */
  private streamOpened = false;
  private watchdog?: ReturnType<typeof setTimeout>;
  private reopenTimer?: ReturnType<typeof setTimeout>;
  private recountTimer?: ReturnType<typeof setTimeout>;
  /** Increments on sign-in by another person. Late answers for the old person are dropped. */
  private epoch = 0;
  private identity: string | null = null;

  constructor() {
    effect(() => {
      const identity = this.auth.session()?.identity.id ?? null;
      untracked(() => {
        if (identity === null) return;
        if (this.identity !== null && identity !== this.identity) this.reset();
        this.identity = identity;
      });
    });
  }

  /** Browsing state belongs to one person. Another sign-in starts clean. */
  private reset(): void {
    this.epoch++;
    this.sync.set(null);
    this.syncLoaded.set(false);
    this.predicates.set([]);
    this.view.set(defaultView());
    this.gridState.set(null);
    this.selectedView.set(false);
    this.groupLimit.set(false);
    this.counted = countsKey(defaultView());
    this.countedQuery = { predicates: [], selection: null };
    this.recounted = null;
    this.selection.spec.set(null);
    this.page.set(null);
    this.freshness.set(null);
    this.jobFailure.set(null);
    this.orgUnits.set([]);
    this.offline.set(false);
    this.error.set('');
    this.position.set(null);
    this.revision.update((value) => value + 1);
    // The stream carries the session cookie. A new person needs a new stream.
    if (this.stream) this.openStream();
  }

  private async call(path: string, body?: unknown): Promise<Response | null> {
    try {
      const response = await this.auth.request(path, body);
      this.offline.set(false);
      return response;
    } catch {
      this.offline.set(true);
      return null;
    }
  }

  /** Devices mounted: read the status and open the event stream (D12). */
  async init(): Promise<void> {
    this.streamWanted = true;
    if (this.stream) return;
    this.streamOpened = false;
    if (
      (await this.loadSync()) &&
      this.sync() &&
      this.streamWanted &&
      !this.stream
    )
      this.openStream();
  }

  /** Devices left: close the stream and drop pending timers. */
  leave(): void {
    this.streamWanted = false;
    this.closeStream();
    clearTimeout(this.reopenTimer);
    clearTimeout(this.recountTimer);
  }

  /** Returns false when the status could not be read. */
  async loadSync(): Promise<boolean> {
    const response = await this.call('/api/devices/sync');
    if (!response) return false;
    if (!response.ok) {
      this.error.set('Device inventory status is unavailable.');
      return false;
    }
    this.error.set('');
    this.sync.set(
      deviceSyncStateSchema.nullable().parse((await response.json()).sync),
    );
    this.syncLoaded.set(true);
    return true;
  }

  /** Start a full sync. The full-sync event reports its end (D12). */
  async refreshAll(): Promise<void> {
    const response = await this.call('/api/devices/sync', {});
    if (!response) return;
    const body = await response.json().catch(() => null);
    if (response.status === 409 && body?.reason === 'device-sync-running') {
      await this.loadSync();
    } else if (!response.ok) {
      this.error.set(
        body?.reason === 'orchestration-unavailable'
          ? 'Campus Commander could not start the refresh. Check Diagnostics.'
          : 'The refresh could not start.',
      );
    } else {
      this.error.set('');
      this.sync.set(deviceSyncStateSchema.parse(body.sync));
    }
  }

  /** Reconnect after an offline period: reload the status and the grid, and reopen the stream. */
  async reconnect(): Promise<void> {
    if (!(await this.loadSync())) return;
    this.revision.update((value) => value + 1);
    if (this.streamWanted && !this.stream && this.sync()) this.openStream();
  }

  async rows(offset: number, limit: number): Promise<DevicePage | null> {
    const view = this.view();
    const revision = this.revision();
    const response = await this.call('/api/devices/query', {
      ...view,
      offset,
      limit,
    });
    if (!response?.ok) return null;
    const page = devicePageSchema.parse((await response.json()).page);
    // A new refresh job replaces the cause of the last failed one.
    if (page.refreshJobId) this.jobFailure.set(null);
    // Only a whole open group loads at the group limit. Next device loads one row.
    if (
      view.group?.by.length &&
      limit === GROUP_LIMIT &&
      page.rows.length < page.matching
    )
      this.groupLimit.set(true);
    this.keepCounts(view, revision, page);
    return page;
  }

  async groups(view: DeviceView): Promise<DeviceGroupPage | null> {
    const revision = this.revision();
    const response = await this.call('/api/devices/groups', {
      ...view,
      offset: 0,
      limit: GROUP_LIMIT,
    });
    if (!response?.ok) return null;
    const page = deviceGroupPageSchema.parse((await response.json()).groups);
    if (page.groups.length < page.groupCount) this.groupLimit.set(true);
    this.keepCounts(view, revision, page);
    return page;
  }

  /** A response for a query that changed meanwhile must not replace the counts. */
  private keepCounts(
    view: DeviceView,
    revision: number,
    counts: Omit<DevicePage, 'rows' | 'refreshJobId'>,
  ): void {
    const key = countsKey(view);
    if (key === null || key !== this.counted || revision !== this.revision())
      return;
    this.page.set({
      matching: counts.matching,
      total: counts.total,
      observedAt: counts.observedAt,
    });
    // New counts mean a new result set. Its stale count follows once per query and revision.
    const token = `${key}#${revision}`;
    if (token === this.recounted) return;
    this.recounted = token;
    this.freshness.set(null);
    this.scheduleRecount();
  }

  /** Count the stale devices of the counted query and learn whether a refresh job runs (D11). */
  async recount(): Promise<void> {
    const counted = this.counted;
    const epoch = this.epoch;
    const response = await this.call(
      '/api/devices/freshness',
      this.countedQuery,
    );
    if (!response?.ok || counted !== this.counted || epoch !== this.epoch)
      return;
    try {
      this.freshness.set(
        deviceFreshnessSchema.parse((await response.json()).freshness),
      );
    } catch {
      // An unreadable count leaves the banner as it was.
    }
  }

  private scheduleRecount(): void {
    clearTimeout(this.recountTimer);
    this.recountTimer = setTimeout(
      () => void this.recount(),
      this.recountDelay,
    );
  }

  private openStream(): void {
    this.closeStream();
    const stream = this.eventSource('/api/devices/events');
    this.stream = stream;
    const epoch = this.epoch;
    const current = () => this.stream === stream && epoch === this.epoch;
    stream.addEventListener('open', () => {
      if (!current()) return;
      this.watch();
      if (this.streamOpened) void this.reconcile();
      this.streamOpened = true;
    });
    stream.addEventListener('error', () => {
      // EventSource retries by itself while CONNECTING. A closed stream reopens after a status read.
      if (current() && stream.readyState === CLOSED) this.scheduleReopen();
    });
    for (const name of ['ping', 'entity-batch', 'job-finished', 'full-sync'])
      stream.addEventListener(name, (message) => {
        if (!current()) return;
        this.watch();
        if (name !== 'ping')
          this.onEvent((message as MessageEvent<string>).data);
      });
  }

  private closeStream(): void {
    clearTimeout(this.watchdog);
    this.stream?.close();
    this.stream = null;
  }

  /** A stream without events past the timeout counts as dead. */
  private watch(): void {
    clearTimeout(this.watchdog);
    if (this.streamTimeout > 0)
      this.watchdog = setTimeout(() => {
        if (this.streamWanted) this.scheduleReopen();
      }, this.streamTimeout);
  }

  private scheduleReopen(): void {
    this.closeStream();
    clearTimeout(this.reopenTimer);
    this.reopenTimer = setTimeout(async () => {
      if (!this.streamWanted) return;
      // AuthStore handles an ended session through this status read.
      if (await this.loadSync()) {
        if (this.streamWanted && this.sync()) this.openStream();
      } else if (this.offline()) this.scheduleReopen();
    }, this.reopenDelay);
  }

  private onEvent(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const result = entityEventSchema.safeParse(parsed);
    if (!result.success) return;
    const event = result.data;
    if (event.type === 'entity-batch') {
      void this.refreshRows([...event.deviceIds, ...event.removedIds]);
      this.scheduleRecount();
    } else if (event.type === 'job-finished') {
      if (event.job.failure) this.jobFailure.set(event.job.failure);
      this.scheduleRecount();
    } else {
      this.sync.set(event.sync);
      if (event.sync.status !== 'running')
        this.revision.update((value) => value + 1);
    }
  }

  /** After a reconnect: one status read, the rows still tagged stale, and the counts (D12). */
  private async reconcile(): Promise<void> {
    const before = this.sync();
    if (!(await this.loadSync())) return;
    const after = this.sync();
    // A full sync that ended meanwhile reloads every row and count.
    if (
      (before?.status === 'running' && after?.status !== 'running') ||
      before?.observedAt !== after?.observedAt
    ) {
      this.revision.update((value) => value + 1);
      return;
    }
    await this.refreshRows('stale');
    await this.recount();
  }

  /** Refetch held rows among `ids`, or every held row still tagged stale (D7, D12). */
  private async refreshRows(ids: readonly string[] | 'stale'): Promise<void> {
    const wanted = new Set(ids === 'stale' ? [] : ids);
    const held = this.gridRows.held((row) =>
      ids === 'stale' ? row.stale : wanted.has(row.deviceId),
    );
    const epoch = this.epoch;
    for (let start = 0; start < held.length; start += DEVICE_BY_IDS_LIMIT) {
      const response = await this.call('/api/devices/by-ids', {
        deviceIds: held.slice(start, start + DEVICE_BY_IDS_LIMIT),
      });
      if (!response?.ok || epoch !== this.epoch) return;
      this.gridRows.apply(deviceRowsSchema.parse((await response.json()).rows));
    }
  }

  async neighbor(index: number): Promise<DeviceRow | null> {
    if (index < 0) return null;
    return (await this.rows(index, 1))?.rows[0] ?? null;
  }

  async device(id: string): Promise<DeviceDetail | null> {
    const response = await this.call(`/api/devices/${encodeURIComponent(id)}`);
    if (!response?.ok) return null;
    return deviceDetailSchema.parse((await response.json()).device);
  }

  async loadOrgUnits(): Promise<void> {
    const response = await this.call('/api/devices/org-units');
    if (!response?.ok) return;
    this.orgUnits.set(
      deviceOrgUnitsSchema.parse((await response.json()).orgUnits),
    );
  }

  /** Chips and column filters both land here. The grid applies them and reloads itself. */
  setPredicates(predicates: DevicePredicate[]): void {
    if (samePredicates(predicates, this.predicates())) return;
    this.predicates.set(predicates);
    this.position.set(null);
  }

  /** The grid reports each query it runs. A different query forgets the opened row. */
  setView(view: DeviceView): void {
    if (JSON.stringify(view) === JSON.stringify(this.view())) return;
    this.view.set(view);
    this.position.set(null);
    const key = countsKey(view);
    if (key === null || key === this.counted) return;
    this.counted = key;
    this.countedQuery = {
      predicates: view.predicates,
      selection: view.selection,
    };
    this.groupLimit.set(false);
  }
}
```

- [ ] **Step 8: Run the store tests to verify they pass**

Run: `npm exec -- nx run frontend:test --include=src/app/devices/devices.store.spec.ts`
Expected: PASS, including the existing counts, offline, sign-in, and group tests.

- [ ] **Step 9: Attach the grid and mount the stream**

In `frontend/src/app/devices/device-grid.ts`:

1. Add `import type { DeviceRowRefresh } from './device-row-refresh';`.
2. Add the input below `selection`:

```ts
  /** Refresh signals update the rows this grid holds. */
  readonly rowRefresh = input<DeviceRowRefresh | null>(null);
```

3. Replace `ready()` with:

```ts
  protected ready(event: GridReadyEvent<DeviceRow>): void {
    this.api = event.api;
    const refresh = this.rowRefresh();
    refresh?.attach(event.api);
    this.destroyRef.onDestroy(() => refresh?.detach(event.api));
    this.applyPredicates(this.predicates());
    this.reload();
  }
```

In `frontend/src/app/devices/devices.ts`, add `OnDestroy` to the `@angular/core` import, declare `export class DevicesPage implements OnInit, OnDestroy`, and add below `ngOnInit()`:

```ts
  ngOnDestroy(): void {
    this.store.leave();
  }
```

In `frontend/src/app/devices/devices.html`, add `[rowRefresh]="store.gridRows"` to `<app-device-grid>` after `[selection]="selection"`.

In `frontend/src/app/devices/devices.spec.ts`:

1. Add `readonly rowRefresh = input<unknown>();` to `GridStub`.
2. Add `leave: vi.fn(),` and `gridRows: {},` to the store stand-in in `setup()`.
3. Append:

```ts
it('opens the event stream on mount and closes it on leave', () => {
  const { store, fixture } = setup({ sync: ready() });
  expect(store.init).toHaveBeenCalled();
  fixture.destroy();
  expect(store.leave).toHaveBeenCalled();
});
```

- [ ] **Step 10: Run the frontend checks**

Run: `npm exec -- nx run-many -t lint test build -p frontend --skip-nx-cache`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/app/devices/device-row-refresh.ts frontend/src/app/devices/device-row-refresh.spec.ts frontend/src/app/devices/devices.store.ts frontend/src/app/devices/devices.store.spec.ts frontend/src/app/devices/device-grid.ts frontend/src/app/devices/devices.ts frontend/src/app/devices/devices.html frontend/src/app/devices/devices.spec.ts
git commit -m "feat: follow device refreshes over the event stream and retire the poll"
```

---

### Task 7: Refresh banner and muted contact cell

**Files:**

- Create: `frontend/src/app/devices/device-freshness.ts`
- Create: `frontend/src/app/devices/device-freshness.spec.ts`
- Create: `frontend/src/app/devices/device-columns.spec.ts`
- Modify: `frontend/src/app/devices/device-columns.ts`
- Modify: `frontend/src/app/devices/device-grid.ts`
- Modify: `frontend/src/app/devices/devices.ts`
- Modify: `frontend/src/app/devices/devices.html`
- Modify: `frontend/src/app/devices/devices.spec.ts`

UI rules: GRID-01 (counts and the last full sync time stay in the footer). The workflow's D11 decision moves refresh progress into the banner.

**Interfaces:**

- Consumes: Task 6 `DevicesStore.freshness`, `DevicesStore.jobFailure`. Existing `syncFailureText`, `DevicesStore.page`, `DevicesStore.refreshing`.
- Produces:
  - `freshnessBanner(input: { stale: number; matching: number; refreshing: boolean; jobFailure: string; syncFailure: string; syncFailed: boolean }): FreshnessBanner | null`.
  - `FreshnessBanner = { refreshing: boolean; title: string; body: string }`.
  - The Device contact column (`colId: 'lastContact'`) gets the cell class `device-stale` and the tooltip `Refreshing from Google` on stale device rows.

- [ ] **Step 1: Re-inspect the Figma stale frame**

Open Figma file `lqZx6qpWevsN3AAfWkworl`, node `108:605`, with the Figma MCP `get_screenshot` tool. On 2026-10-06 the frame showed this composition:

- Above the filter row, the banner "Inventory observation is stale" with the text "Keep current data visible during refresh. Preview rechecks affected values before approval." and the button "Refresh inventory".
- In the footer, "Stale inventory · Last complete observation Sep 4, 8:28 AM · Refresh required".
- No per-row marker.

If the frame changed since then, stop and report the difference to the owner before Step 2. Otherwise continue. D11 changes the composition: the banner reports progress while a refresh runs, and stale rows mute the Device contact cell. Task 8 records this change in the workflow.

- [ ] **Step 2: Write the failing banner tests**

Create `frontend/src/app/devices/device-freshness.spec.ts`:

```ts
import { freshnessBanner } from './device-freshness';

const base = {
  stale: 0,
  matching: 12,
  refreshing: false,
  jobFailure: '',
  syncFailure: '',
  syncFailed: false,
};

it('reports progress while stale devices refresh', () => {
  expect(freshnessBanner({ ...base, stale: 1, refreshing: true })).toEqual({
    refreshing: true,
    title: 'Refreshing 1 of 12 devices',
    body: 'Current data stays visible. Rows update as Google answers.',
  });
});

it('formats large counts and names a single device', () => {
  expect(
    freshnessBanner({ ...base, stale: 1200, matching: 45000, refreshing: true })
      ?.title,
  ).toBe('Refreshing 1,200 of 45,000 devices');
  expect(
    freshnessBanner({ ...base, stale: 1, matching: 1, refreshing: true })
      ?.title,
  ).toBe('Refreshing 1 of 1 device');
});

it('names the last failure when stale devices are not refreshing', () => {
  expect(
    freshnessBanner({
      ...base,
      stale: 3,
      jobFailure: 'Google limited the requests. Refresh again later.',
    }),
  ).toEqual({
    refreshing: false,
    title: 'Inventory observation is stale',
    body: '3 of 12 devices were last read from Google more than 24 hours ago. Google limited the requests. Refresh again later. Current data stays visible during refresh.',
  });
  expect(freshnessBanner({ ...base, stale: 1 })?.body).toContain(
    '1 of 12 devices was last read',
  );
});

it('keeps the failed full sync state when no device is stale', () => {
  expect(
    freshnessBanner({
      ...base,
      syncFailed: true,
      syncFailure: 'The last refresh failed.',
    }),
  ).toEqual({
    refreshing: false,
    title: 'Inventory observation is stale',
    body: 'The last refresh failed. Current data stays visible during refresh.',
  });
});

it('hides the banner when no matching device is stale', () => {
  expect(freshnessBanner(base)).toBeNull();
  expect(freshnessBanner({ ...base, refreshing: true })).toBeNull();
});
```

Create `frontend/src/app/devices/device-columns.spec.ts`:

```ts
import type { ColDef } from 'ag-grid-community';
import type { DeviceRow } from '@campus/application-contracts';
import { deviceColumnDefs } from './device-columns';

const row = (stale: boolean): DeviceRow => ({
  deviceId: 'd1',
  serialNumber: 'C0A1-0000',
  model: null,
  assetTag: null,
  orgUnitPath: '/',
  lastContact: '2026-10-05T12:00:00.000Z',
  annotatedLocation: null,
  notes: null,
  battery: { status: 'no-report' },
  lastEntitySync: '2026-10-04T12:00:00.000Z',
  stale,
});

const columns = () => deviceColumnDefs(() => undefined);
const rule = (column: ColDef<DeviceRow>) =>
  (
    column.cellClassRules as
      | Record<string, (params: unknown) => boolean>
      | undefined
  )?.['device-stale'];

it('mutes the contact time of a stale row and explains it', () => {
  const contact = columns().find((column) => column.colId === 'lastContact')!;
  const stale = rule(contact)!;
  expect(stale({ data: row(true), node: { group: false } })).toBe(true);
  expect(stale({ data: row(false), node: { group: false } })).toBe(false);
  expect(stale({ data: { key: '/', devices: 3 }, node: { group: true } })).toBe(
    false,
  );
  const tooltip = contact.tooltipValueGetter!;
  expect(tooltip({ data: row(true), node: { group: false } } as never)).toBe(
    'Refreshing from Google',
  );
  expect(
    tooltip({ data: row(false), node: { group: false } } as never),
  ).toBeUndefined();
});

it('mutes no other column', () => {
  const others = columns().filter((column) => column.colId !== 'lastContact');
  expect(others.every((column) => rule(column) === undefined)).toBe(true);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm exec -- nx run frontend:test --include=src/app/devices/device-freshness.spec.ts`
Expected: FAIL with a missing module error for `./device-freshness`.

Run: `npm exec -- nx run frontend:test --include=src/app/devices/device-columns.spec.ts`
Expected: FAIL. The Device contact column has no `cellClassRules`.

- [ ] **Step 4: Write the banner text**

Create `frontend/src/app/devices/device-freshness.ts`:

```ts
/** The stale banner (D11): progress while a refresh runs, the stale state when none runs. */
export interface FreshnessBanner {
  refreshing: boolean;
  title: string;
  body: string;
}

const count = (value: number) => value.toLocaleString('en-US');
const sentences = (parts: string[]) => parts.filter(Boolean).join(' ');

export function freshnessBanner(input: {
  /** Stale devices in the result set. */
  stale: number;
  /** Devices in the result set. */
  matching: number;
  /** A refresh job or a full sync runs. */
  refreshing: boolean;
  /** Why the last refresh job failed. Empty when none failed. */
  jobFailure: string;
  /** Why the last full sync failed. Empty when it did not fail. */
  syncFailure: string;
  syncFailed: boolean;
}): FreshnessBanner | null {
  const total = Math.max(input.stale, input.matching);
  const devices = `${count(total)} ${total === 1 ? 'device' : 'devices'}`;
  if (input.stale > 0 && input.refreshing)
    return {
      refreshing: true,
      title: `Refreshing ${count(input.stale)} of ${devices}`,
      body: 'Current data stays visible. Rows update as Google answers.',
    };
  if (input.stale > 0)
    return {
      refreshing: false,
      title: 'Inventory observation is stale',
      body: sentences([
        `${count(input.stale)} of ${devices} ${input.stale === 1 ? 'was' : 'were'} last read from Google more than 24 hours ago.`,
        input.jobFailure || input.syncFailure,
        'Current data stays visible during refresh.',
      ]),
    };
  if (input.syncFailed)
    return {
      refreshing: false,
      title: 'Inventory observation is stale',
      body: sentences([
        input.syncFailure,
        'Current data stays visible during refresh.',
      ]),
    };
  return null;
}
```

- [ ] **Step 5: Mute the stale contact cell**

In `frontend/src/app/devices/device-columns.ts`, add above `deviceColumnDefs`:

```ts
/** A stale row shows its contact time muted until the refresh lands (D11). */
const staleContact: Pick<
  ColDef<DeviceRow>,
  'cellClassRules' | 'tooltipValueGetter'
> = {
  cellClassRules: {
    'device-stale': ({ data, node }) =>
      !!data && !node?.group && data.stale === true,
  },
  tooltipValueGetter: ({ data, node }) =>
    data && !node?.group && data.stale ? 'Refreshing from Google' : undefined,
};
```

In the `DEVICE_FIELDS.map(...)` column object, add after the `cellClass` line:

```ts
        ...(field.id === 'lastContact' ? staleContact : {}),
```

In `frontend/src/app/devices/device-grid.ts`, add to the component `styles` after the `.device-code` rule:

```css
:host ::ng-deep .device-stale {
  color: var(--cc-text-secondary);
}
```

- [ ] **Step 6: Run the unit tests to verify they pass**

Run: `npm exec -- nx run frontend:test --include=src/app/devices/device-freshness.spec.ts`
Expected: PASS.

Run: `npm exec -- nx run frontend:test --include=src/app/devices/device-columns.spec.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing page tests**

In `frontend/src/app/devices/devices.spec.ts`:

1. Add `freshness?: { stale: number; refreshing: boolean } | null;` to the `setup()` options type.
2. Add `freshness: signal(options.freshness ?? null),` and `jobFailure: signal(null),` to the store stand-in.
3. Append:

```ts
const counted = {
  matching: 12,
  total: 450,
  observedAt: '2026-10-05T12:00:00.000Z',
};

it('shows refresh progress while stale devices refresh', () => {
  const { element, button } = setup({
    sync: ready(),
    page: counted,
    freshness: { stale: 1, refreshing: true },
  });
  expect(
    element.querySelector('#devices-stale-title')?.textContent?.trim(),
  ).toBe('Refreshing 1 of 12 devices');
  expect(button('Refresh inventory')).toBeUndefined();
});

it('offers Refresh inventory when stale devices are not refreshing', () => {
  const { element, button } = setup({
    sync: ready(),
    page: counted,
    freshness: { stale: 3, refreshing: false },
  });
  expect(element.textContent).toContain('Inventory observation is stale');
  expect(element.textContent).toContain(
    '3 of 12 devices were last read from Google more than 24 hours ago.',
  );
  expect(button('Refresh inventory')).toBeDefined();
});

it('hides the banner when no matching device is stale, even after a day without a full sync', () => {
  const { element } = setup({
    sync: ready({ stale: true }),
    page: counted,
    freshness: { stale: 0, refreshing: false },
  });
  expect(element.textContent).not.toContain('Inventory observation is stale');
  expect(element.querySelector('#devices-stale-title')).toBeNull();
});
```

- [ ] **Step 8: Run the page tests to verify they fail**

Run: `npm exec -- nx run frontend:test --include=src/app/devices/devices.spec.ts`
Expected: FAIL. The page still shows the banner from `sync.stale` and never shows progress.

- [ ] **Step 9: Show the banner**

In `frontend/src/app/devices/devices.ts`, add `import { freshnessBanner } from './device-freshness';` and this property below `telemetryText`:

```ts
  /** The stale banner follows the stale rows of the result set, not the age of the last full sync (D11). */
  protected readonly banner = computed(() => {
    const freshness = this.store.freshness();
    const sync = this.sync();
    const failed = sync?.status === 'failed';
    return freshnessBanner({
      stale: freshness?.stale ?? 0,
      matching: this.store.page()?.matching ?? 0,
      refreshing: !!freshness?.refreshing || this.store.refreshing(),
      jobFailure: syncFailureText(this.store.jobFailure()),
      syncFailure: failed ? this.failureText() : '',
      syncFailed: failed,
    });
  });
```

In `frontend/src/app/devices/devices.html`, replace the block from `} @else if (published() && sync()?.stale) {` through the closing `</section>` of the stale banner with:

```html
} @else if (published() && banner()) {
<section
  class="banner"
  aria-labelledby="devices-stale-title"
  [attr.aria-live]="banner()!.refreshing ? 'polite' : null"
>
  <h2 id="devices-stale-title">{{ banner()!.title }}</h2>
  <p>{{ banner()!.body }}</p>
  @if (!banner()!.refreshing) {
  <button
    mat-stroked-button
    type="button"
    [disabled]="store.refreshing()"
    (click)="refresh()"
  >
    Refresh inventory
  </button>
  }
</section>
```

The template keeps the telemetry banner, the error, and the rest unchanged.

- [ ] **Step 10: Run the frontend checks**

Run: `npm exec -- nx run-many -t lint test build -p frontend --skip-nx-cache`
Expected: PASS, including the existing test `shows the stale banner with the failure cause`.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/app/devices/device-freshness.ts frontend/src/app/devices/device-freshness.spec.ts frontend/src/app/devices/device-columns.ts frontend/src/app/devices/device-columns.spec.ts frontend/src/app/devices/device-grid.ts frontend/src/app/devices/devices.ts frontend/src/app/devices/devices.html frontend/src/app/devices/devices.spec.ts
git commit -m "feat: show refresh progress and mute stale contact times"
```

---

### Task 8: End-to-end checks, records, and the full run

**Files:**

- Modify: `api-e2e/google-connection-preload.cjs`
- Modify: `api-e2e/devices-api.mjs`
- Modify: `api-e2e/devices-browser.mjs`
- Modify: `api-e2e/auth.test.mjs`
- Modify: `docs/workflows/device-browsing.md`
- Modify: `docs/superpowers/specs/2026-10-06-entity-cache-decisions.md`
- Modify: `docs/document-index.csv`

**Interfaces:**

- Consumes: every route and UI behavior from Tasks 3 through 7. The e2e harness passes `migrator` (a Postgres client with owner rights), `redis` (a `default` user client), and `directory` (the fixture directory that holds `google-health-fault.json`).
- Produces: the simulator fault mode `device-delay`, new evidence lines, and the workflow record.

- [ ] **Step 1: Let the simulator hold a refresh batch**

In `api-e2e/google-connection-preload.cjs`, in the `/batch/admin/directory_v1` branch, add after `if (fault === 'device-privilege-denied') throw forbidden(options);`:

```js
// Holds a refresh batch so the browser check can see the refresh state.
if (fault === 'device-delay')
  await new Promise((resolve) => setTimeout(resolve, 4000));
```

The Google client allows at least 10 seconds per request, so a 4 second hold succeeds.

- [ ] **Step 2: Check the query cache, by-ids, and freshness through the API**

In `api-e2e/devices-api.mjs`, replace the block from `if (migrator) {` through `assert.ok((await removed.json()).device.removedAt);` with:

```js
    if (migrator) {
      const customerKey = (prefix) => `${prefix}:device:C0123456`;
      const entity = (id) => `${customerKey('cc:entity')}:${id}`;
      await migrator.query(
        "UPDATE cc.devices SET last_entity_sync=now()-interval '2 days' WHERE device_id IN ('synthetic-device-0','synthetic-device-1','synthetic-device-3')",
      );
      // Redis drops a record when it turns stale. Match the new Postgres stamps.
      await redis.del(
        ['synthetic-device-0', 'synthetic-device-1', 'synthetic-device-3'].map(
          entity,
        ),
      );
      await fault('device-removed');
      const staleQuery = {
        predicates: [
          {
            field: 'orgUnitPath',
            operator: 'in',
            values: ['/School A', '/School B', '/'],
          },
        ],
        limit: 5,
      };
      const stalePage = await query(staleQuery);
      assert.ok(stalePage.refreshJobId, 'Stale rows start a refresh job.');
      assert.equal(
        stalePage.rows.find((row) => row.deviceId === 'synthetic-device-0')
          .stale,
        true,
      );
      const lists = await redis.keys('cc:query:device:C0123456:*');
      assert.ok(lists.length > 0, 'The query cache holds ordered ID lists.');
      const ttl = await redis.ttl(lists[0]);
      assert.ok(ttl > 0 && ttl <= 300, `A cached list expires in ${ttl} s.`);
      const repeat = await query(staleQuery);
      assert.equal(
        repeat.refreshJobId,
        null,
        'A cached page finds its stale rows already claimed.',
      );
      assert.deepEqual(
        repeat.rows.map((row) => row.deviceId),
        stalePage.rows.map((row) => row.deviceId),
      );
      // No earlier step used this query shape, so it misses the cache.
      const again = await query({
        predicates: [
          { field: 'serialNumber', operator: 'startsWith', value: 'C0A1-000' },
        ],
        sort: { field: 'assetTag', direction: 'desc' },
        limit: 5,
      });
      assert.equal(
        again.refreshJobId,
        null,
        'The in-flight set stops a second dispatch.',
      );
      const byIds = async (deviceIds) => {
        const response = await api.post(`${root}/by-ids`, {
          headers,
          data: { deviceIds },
        });
        assert.equal(response.status(), 200, await response.text());
        return (await response.json()).rows;
      };
      assert.equal(
        (
          await api.post(`${root}/by-ids`, { headers, data: { deviceIds: [] } })
        ).status(),
        400,
      );
      const removedAt = async () =>
        (await (await api.get(`${root}/synthetic-device-3`)).json()).device
          .removedAt;
      let refreshed;
      let removed;
      for (let attempt = 0; attempt < 120; attempt++) {
        [refreshed] = await byIds(['synthetic-device-0']);
        removed = await removedAt();
        if (refreshed?.stale === false && removed) break;
        await setTimeout(500);
      }
      assert.ok(
        refreshed?.stale === false && removed,
        'Batch did not refresh C0A1-0000 and remove C0A1-0003 within 60 s.',
      );
      assert.equal(refreshed.serialNumber, 'C0A1-0000');
      const bySerial = (serialNumber) =>
        query({
          predicates: [
            { field: 'serialNumber', operator: 'equals', value: serialNumber },
          ],
        });
      // A new query shape leaves the removed device out. Cached lists keep it until they expire.
      assert.equal(
        (
          await query({
            predicates: [
              {
                field: 'serialNumber',
                operator: 'startsWith',
                value: 'C0A1-0003',
              },
            ],
          })
        ).matching,
        0,
      );
      assert.equal(
        (await query(staleQuery)).rows.find(
          (row) => row.deviceId === 'synthetic-device-0',
        ).stale,
        false,
        'A cached page reads the refreshed record.',
      );
```

Below the job check (the loop that waits for `job?.finished_at` and its three assertions), add:

```js
const freshness = await api.post(`${root}/freshness`, {
  headers,
  data: staleQuery,
});
assert.equal(freshness.status(), 200, await freshness.text());
assert.deepEqual((await freshness.json()).freshness, {
  stale: 0,
  refreshing: false,
});
```

Delete the two later lines that define `customerKey` and `entity`, because the new block defines them. The Redis assertions after them stay.

In the returned evidence list, replace `'stale devices refresh through one Kestra batch and a removed device leaves the grid: pass',` with:

```js
            'stale devices refresh through one Kestra batch and a removed device leaves new queries: pass',
            'grid queries cache ordered device lists for 5 minutes and cached pages read refreshed records: pass',
            'by-ids and freshness report refreshed rows and the stale count: pass',
```

- [ ] **Step 3: Check the stale to refresh to in-place flow in the browser**

In `api-e2e/devices-browser.mjs`:

1. Add the imports `import { rm, writeFile } from 'node:fs/promises';` and `import { join } from 'node:path';`.
2. Add `migrator`, `redis`, and `directory` to the parameters of `qualifyDevicesBrowser`.
3. After `await auditAccessibility(page, 'devices');`, add:

```js
if (migrator && redis) {
  // Two devices turn stale: Postgres ages their stamps and Redis drops their records.
  await migrator.query(
    "UPDATE cc.devices SET last_entity_sync=now()-interval '2 days' WHERE device_id IN ('synthetic-device-0','synthetic-device-1')",
  );
  await redis.del([
    'cc:entity:device:C0123456:synthetic-device-0',
    'cc:entity:device:C0123456:synthetic-device-1',
  ]);
  const faultPath = join(directory, 'google-health-fault.json');
  await writeFile(faultPath, JSON.stringify({ mode: 'device-delay' }));
  try {
    await page.reload();
    const contact = page.locator(
      '[row-id="synthetic-device-0"] [col-id="lastContact"]',
    );
    await expect(contact).toHaveClass(/device-stale/);
    await expect(
      page.getByRole('heading', { name: 'Refreshing 2 of 450 devices' }),
    ).toBeVisible();
    const cell = await contact.elementHandle();
    await expect(
      page.getByRole('heading', { name: /^Refreshing \d/ }),
    ).toHaveCount(0, { timeout: 60_000 });
    await expect(contact).not.toHaveClass(/device-stale/);
    // The batch updated the row in place. A grid reload would replace the cell.
    expect(await cell.evaluate((element) => element.isConnected)).toBe(true);
  } finally {
    await rm(faultPath, { force: true });
  }
}
```

4. Add this line to the returned evidence list after the first entry:

```js
      'stale rows refresh in place over the event stream and the banner reports progress: pass',
```

In `api-e2e/auth.test.mjs`, add `migrator,`, `redis,`, and `directory,` to the object passed to `qualifyDevicesBrowser`.

- [ ] **Step 4: Run the end-to-end checks**

Run: `npm exec -- nx run api-e2e:phase3-auth-integration --skip-nx-cache`
Expected: PASS. The output lists the new device evidence lines. `auth.test.mjs` discards the `qualifyDevicesApi` result lines, so the inline assertions are the evidence. If Docker is not running, start it first.

- [ ] **Step 5: Record the behavior in the workflow**

In `docs/workflows/device-browsing.md`:

1. Under `## Data and access`, replace these two lines:

```markdown
The grid reads Postgres. The page polls the sync state.
The next plan adds a server push signal and cached query results. The grid then updates refreshed rows in place.
```

with:

```markdown
Redis caches the ordered device list of each grid query for 5 minutes.
Pages read device records from Redis first and from Postgres for the rest.
The server pushes refresh signals over Server-Sent Events. The grid updates refreshed rows in place.
```

2. Under `## Owner decisions — 2026-10-06`, delete the line `  The next plan delivers this decision. Until then the page polls the sync state.`
3. Under `## Implementation defaults — 2026-10-05`, replace `- The next plan caches query results for 5 minutes. A completed full sync then makes the cached results unreachable.` with `- Query results stay cached for 5 minutes. A completed full sync makes the cached results unreachable.`
4. Append to the same list:

```markdown
- The banner's N counts the matching devices that are still stale. M counts the matching devices. N falls as batches land.
- Without a running refresh, stale devices keep the title "Inventory observation is stale". The text names the stale count and the last failure.
- A cached page refreshes the stale devices on that page. The query that filled the cache refreshed every stale device it matched.
- A cached query result belongs to one person and one permission version.
- Show All Selected and results over 100,000 devices skip the query cache.
- A device that a refresh removes stays in a cached result until the result expires. It does not show as stale. Its details name the removal.
- The event stream pings every 25 seconds. The server checks the session before each ping.
- A browser that receives no event for 60 seconds reconnects. A closed stream reopens after 5 seconds when the status read succeeds.
- After a reconnect, the page reads the sync status once, refetches rows still marked stale, and recounts stale devices.
- The edge allows the event stream 75 seconds without data. Other application requests keep 45 seconds.
```

5. Under `## Design`, after the deviations paragraph, add:

```markdown
The stale frame `108:605` was re-inspected on 2026-10-06. It shows the observation banner with Refresh inventory and no row marker.
D11 changes that composition. The banner reports refresh progress, and stale rows mute the Device contact cell.
```

- [ ] **Step 6: Record what was built in the decision record and the index**

In `docs/superpowers/specs/2026-10-06-entity-cache-decisions.md`, append one line to each decision:

- D2: `As built, the hash also covers the principal ID. Show All Selected and results over 100,000 devices skip the cache.`
- D4: `As built, a page from the query cache dispatches the stale devices on that page.`
- D11: `As built, POST /api/devices/freshness returns the stale count and whether a refresh job runs. N is that count. M is the matching count.`

In `docs/document-index.csv`, append:

```csv
docs/superpowers/plans/2026-10-06-entity-cache-client.md,Implementation plan,Entity Cache Client Implementation Plan,Task plan for the query cache and refresh events. Implements docs/superpowers/specs/2026-10-06-entity-cache-decisions.md,"Plan written, 2026-10-06","Global Constraints; Review Focus; Task 1 through Task 8; After this plan"
```

- [ ] **Step 7: Run every affected project once**

Run: `npm exec -- nx run-many -t lint test build -p application-contracts api frontend deployment --skip-nx-cache`
Expected: PASS.

Run: `npm exec -- nx run deployment:bootstrap-test --skip-nx-cache`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add api-e2e/google-connection-preload.cjs api-e2e/devices-api.mjs api-e2e/devices-browser.mjs api-e2e/auth.test.mjs docs/workflows/device-browsing.md docs/superpowers/specs/2026-10-06-entity-cache-decisions.md docs/document-index.csv
git commit -m "test: check cached pages and in-place refresh end to end and record the defaults"
```

---

## After this plan

The four Plan A follow-ups stay open. The owner has not scheduled them:

- N2: size the in-flight claim to the job instead of a fixed 120 seconds.
- N1: reject a hybrid local Redis with distributed workers at render time.
- Add the zset commands and the `worker` ACL user to `deployment/redis/README.md` and `installer/PHASE-2.md`.
- Give the worker its own Redis password.

The owner decides when `codex/entity-cache` merges into `codex/devices-ui`.
