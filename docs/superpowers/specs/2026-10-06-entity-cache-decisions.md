# Entity cache decision record

Status: owner-confirmed. Implementation authorized 2026-10-06 as infrastructure under [device browsing](../../workflows/device-browsing.md).
Source: owner interview with Claude on 2026-10-06, questions Q1 through Q17
Branch: `codex/entity-cache`
Design: existing stale frames in [device browsing](../../workflows/device-browsing.md#design), to be re-inspected before Q11 implementation
Replaces: the collection-level snapshot model in `deployment/postgres/migrations/016-device-inventory.sql`

This record captures the decisions reached in one interview. The owner authorized implementation on 2026-10-06.
The open items at the end must close before any code changes.

## Purpose

Feed the freshest available entity data to the grids with explicit per-row freshness.
Reads come from Postgres with Redis in front for IDs and query results. Stale rows trigger a background refresh.
The client receives a push signal when rows are refreshed and updates them in place.

## Current state the decisions replace

- `cc.devices` is keyed `(sync_id, device_id)`. Each full sync writes a new generation and `finish_device_sync` switches `current_sync_id`.
- Staleness is one collection-level rule in SQL: `observed_at < now() - 24 hours` or a failed sync.
- Redis holds sessions and `cc:device-selection:*` only. No entity data lives in Redis.
- The worker (`worker/`) talks to Postgres directly through `cc.*` functions. It has no Redis client.
- The Kestra flow `device_sync` makes one HTTP dispatch to the worker, which enumerates with `chromeosdevices.list`.
- The client polls `GET /api/devices/sync` every 2 seconds while a full sync runs. No push channel exists.

## Decisions

### D1. Two Redis caches with different owners (Q1)

| Cache  | Key        | Value                  | Writer                  | TTL                                        |
| ------ | ---------- | ---------------------- | ----------------------- | ------------------------------------------ |
| Query  | query hash | ordered device ID list | API, on a Postgres miss | 5 minutes                                  |
| Entity | device ID  | full row projection    | sync job only           | staleness threshold (24 hours for devices) |

Read path: query key to Redis. Hit: hydrate IDs from the entity cache, Postgres fills misses.
Miss: Postgres runs the query, the API writes the ID list, then returns rows. The API never writes the entity cache.
The application Redis user gains mget, llen, lrange, rpush, subscribe, and unsubscribe, owner-approved 2026-10-07. District-operated Redis must grant the same. The district Redis docs follow-up stays open.

### D2. The query cache holds the whole ordered result set (Q2)

Key = hash(customer, connection generation, permission version, filter, sort, query generation from D10).
Value = every matching ID in order, stale and fresh alike. A page is `LRANGE`. Count is `LLEN`.
The user scrolls one frozen ordering for the TTL. Grouped queries (`POST /api/devices/groups`) are not cached.
As built, the hash also covers the principal ID. Show All Selected and results over 100,000 devices skip the cache.

### D3. One mutable row per device replaces snapshots (Q3)

`cc.devices` becomes `(customer_id, device_id)` with `last_entity_sync timestamptz NOT NULL` and `removed_at timestamptz`.
Full sync and get-by-IDs sync use one upsert. Migration 016 is rewritten, not patched. Development data is disposable.
`device_sync_state` keeps the job lease and the last full enumeration time only.

### D4. A read dispatches every stale ID in the result set (Q4)

Not only the visible page. Dedupe uses a Redis in-flight set `cc:entity-inflight:{type}:{customer}` with a short TTL.
The API dispatches only IDs newly added to the set. Refresh all remains the explicit whole-inventory path.
As built, a page from the query cache dispatches the stale devices on that page.

### D5. Fetch strategy (Q5)

Get-by-IDs jobs use `chromeosdevices.get` per device and the telemetry read per device. Full sync uses `.list`.
A Kestra flow splits the ID list into batches and runs batches in parallel.
Each batch runner uses the Google batch endpoint.
The ID list travels in a `cc.entity_sync_jobs` row. Kestra receives the job ID. Batches pull their slice by job ID and batch index.

Verified 2026-10-06 against Google documentation:

- Directory API batch endpoint: `https://www.googleapis.com/batch/admin/directory_v1`. Limit: 1,000 calls per batch request.
- "A set of n requests batched together counts toward your usage limit as n requests, not as one request." Default quota: 2,400 queries per minute per user per project.
- Chrome Management API: `customers.telemetry.devices.get` exists at `GET /v1/{name=customers/*/telemetry/devices/*}`.
  Its discovery document declares `batchPath: batch`, so `https://chromemanagement.googleapis.com/batch` exists. Google does not document it or its quota on the REST reference. Treat the per-call quota as unknown and keep batch sizes small for telemetry.

### D6. Server-Sent Events over WebSocket (Q6)

`GET /api/devices/events` is an SSE response on the existing controller and session guard.
The worker publishes to Redis channel `cc:entity-events:{customer}`. Each API instance holds one dedicated subscriber client and fans out to open SSE responses.
Pub/Sub is fire-and-forget. The client reconciles on reconnect (D12), so lost messages cost only latency.
As built, each ping first checks the session without extending the idle session lifetime. An open tab never keeps an unattended session alive.

### D7. One event per completed batch (Q7)

Event `entity-batch` carries `{jobId, entityType, batch, batchCount, deviceIds}`.
The client intersects `deviceIds` with the rows it holds and makes one `POST /api/devices/by-ids` call.
`by-ids` is Redis-first per ID, Postgres for misses. Rows carry `lastEntitySync` and `stale`, same shape as grid rows.

### D8. Threshold is a code constant evaluated at read time (Q8)

One map keyed by entity type in the contracts lib. Devices: 24 hours. Passed to SQL as a parameter.
`stale = last_entity_sync < now() - threshold`. No background sweeper. The next read notices and dispatches.

### D9. Entity cache content and TTL (Q9)

The worker stores the full row projection under `cc:entity:{type}:{customer}:{id}` with TTL equal to the threshold.
Redis TTL is the Redis staleness tool. Expired keys drop out. A hit is fresh by construction.
Soft-deleting a device also deletes its key. A `by-ids` miss means "ask Postgres", never "not found".

### D10. Query cache invalidation (Q10)

TTL only for entity syncs. A completed full sync bumps `INCR cc:query-gen:{type}:{customer}`, which is part of every query key.
Old keys become unreachable and expire. No `SCAN` or wildcard `DEL`.

### D11. Stale presentation (Q11)

The existing stale banner is repurposed. It shows when the result set contains stale rows.
While a job runs it reads "Refreshing N of M devices". It disappears when the last batch lands. The single observation time text goes away.
Stale rows render the Last contact cell muted with the tooltip "Refreshing from Google". No new column.
Record the composition change in the device browsing workflow and re-inspect the Figma stale frame first.
As built, POST /api/devices/freshness returns the stale count and whether a refresh job runs. N is that count. M is the matching count.

### D12. One SSE stream, poll retired (Q12)

The stream carries `entity-batch`, `full-sync` (`{syncId, status, failure?}`), and `job-finished` (`{jobId, completed, failed, failure?}`).
As built, `full-sync` nests the sync state as `{ sync }`, `job-finished` nests the job as `{ job }`, and `entity-batch` also carries `removedIds`.
The 2 second poll is removed. The store opens one `EventSource` on Devices mount and closes it on leave.
On reconnect the store refetches `GET /api/devices/sync` once and `by-ids` for rows still tagged stale.
As built, a closed stream reopens after a status read. A 401 or 403 answer leaves it closed until the same person resumes the session.
Other failures retry after 5 seconds, and each failure doubles the wait up to 60 seconds. An open resets the wait.
The store reads the status again after the new stream opens. A full sync that ends between the two reads still reloads the grid.

### D13. The worker writes Redis and publishes directly (Q13)

The worker gains a Redis client, a deployment service binding in all three modes, and an ACL user scoped to
`cc:entity:*`, `cc:query-gen:*`, `cc:entity-inflight:*`, and the publish channel. The API stays out of the job path.

### D14. Generic names, device-only code (Q14)

Generic now: `cc.entity_sync_jobs(job_id, customer_id, entity_type, ids, batch_size, ...)` with `entity_type` constrained to `'device'`,
Redis key and channel names keyed by type, `entityType` in event payloads, the threshold map.
Device-specific now: routes (`/api/devices/...`, permission `devices:read`), fetchers, upsert, projection, grid store.
No abstract base classes, generic repository, or plugin registry.

### D15. Error handling and soft delete (Q15, Q16, Q16b)

Worker logic owns Google outcomes. Kestra retry covers only a dead batch runner.

| Outcome                      | Get-by-IDs job                                                            | Full `.list` sync                                                                    |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 404 for a device             | soft-delete that device in the batch, delete its Redis key                | not applicable                                                                       |
| Quota error (429, quota 403) | back off and retry each part up to 25 times, then fail the batch          | back off and retry each page up to 25 times, then fail the sync                      |
| Any other error              | the batch fails with the existing failure vocabulary                      | same                                                                                 |
| End-of-job scan              | none                                                                      | if every batch succeeded: soft-delete rows with `last_entity_sync < sync started_at` |
| Any batch failed             | job finishes `failed`, untouched rows stay stale, next read re-dispatches | sync finishes `failed`, previous rows stay and show stale, no soft-deletes           |

Nothing is ever hard-deleted. Freshness only advances. A device row never carries a failure state.
The quota cap of 25 was corrected on 2026-10-07. See the [batch service record](2026-10-07-google-batch-service-decisions.md), decision B12.

## Open items

- Q17 closed 2026-10-06: authorized under device browsing, recorded in the workflow and current work, branch `codex/entity-cache`.
- Google batch facts verified 2026-10-06. See D5.
- Write the implementation plan with the writing-plans skill before any code, in this order:
  migration, worker job and Kestra flow, API caches and `by-ids` and SSE, grid store and UI, docs and evidence.
