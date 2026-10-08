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

/** A cache view for one request. After any call rejects, every later call rejects without reaching Redis. */
function guarded(cache: PagerCache): PagerCache {
  let fault: unknown;
  const wrap =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (fault) throw fault;
      try {
        return await call(...args);
      } catch (error) {
        fault = error;
        throw error;
      }
    };
  return {
    get: wrap((key: string) => cache.get(key)),
    getMany: wrap((keys: readonly string[]) => cache.getMany(keys)),
    listSlice: wrap((key: string, start: number, count: number) =>
      cache.listSlice(key, start, count),
    ),
    replaceList: wrap((key: string, ids: readonly string[], seconds: number) =>
      cache.replaceList(key, ids, seconds),
    ),
    remove: wrap((key: string) => cache.remove(key)),
  };
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
  hydrate(
    customerId: string,
    ids: readonly string[],
    rows: Rows,
    now = Date.now(),
  ): Promise<{ rows: DeviceRow[]; missing: string[] }> {
    return this.hydrateWith(this.cache, customerId, ids, rows, now);
  }

  private async hydrateWith(
    cache: PagerCache,
    customerId: string,
    ids: readonly string[],
    rows: Rows,
    now: number,
  ): Promise<{ rows: DeviceRow[]; missing: string[] }> {
    const unique = [...new Set(ids)];
    const found = new Map<string, DeviceRow>();
    let cached: (string | null)[] = [];
    try {
      cached = await cache.getMany(
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
    // After one Redis fault the request skips Redis so the open transaction never idles on a dead connection.
    const cache = guarded(this.cache);
    // Show All Selected follows a selection that changes between requests.
    const key = selection ? null : await this.key(cache, input);
    if (key) {
      const hit = await this.cached(cache, customerId, key, query, rows, now);
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
      await cache
        .replaceList(key, ids, QUERY_CACHE_SECONDS)
        .catch(() => undefined);
    const read = await this.hydrateWith(
      cache,
      customerId,
      ids.slice(query.offset, query.offset + query.limit),
      rows,
      now,
    );
    return { rows: read.rows, matching: ids.length, stale };
  }

  private async key(
    cache: PagerCache,
    input: {
      customerId: string;
      connectionGeneration: number;
      actor: readonly [string, number];
      query: DeviceQuery;
    },
  ): Promise<string | null> {
    try {
      const generation =
        (await cache.get(queryGenerationKey('device', input.customerId))) ??
        '0';
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
    cache: PagerCache,
    customerId: string,
    key: string,
    query: DeviceQuery,
    rows: Rows,
    now: number,
  ): Promise<PageRead | null> {
    let slice: { length: number; ids: string[] };
    try {
      slice = await cache.listSlice(key, query.offset, query.limit);
    } catch {
      return null;
    }
    if (slice.length === 0) return null;
    const read = await this.hydrateWith(
      cache,
      customerId,
      slice.ids,
      rows,
      now,
    );
    if (read.missing.length) {
      // LibreGrid shows a loading stub for each row that a block leaves out.
      await cache.remove(key).catch(() => undefined);
      return null;
    }
    return {
      rows: read.rows,
      matching: slice.length,
      stale: read.rows.filter((row) => row.stale).map((row) => row.deviceId),
    };
  }
}
