# Entity cache decision record

Status: owner-confirmed decisions, authorization pending (see Open items)
Source: owner interview with Claude on 2026-10-06, questions Q1 through Q16b
Design: existing stale frames in [device browsing](../../workflows/device-browsing.md#design), to be re-inspected before Q11 implementation
Replaces: the collection-level snapshot model in `deployment/postgres/migrations/016-device-inventory.sql`

This record captures the decisions reached in one interview. It does not authorize implementation by itself.
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

| Cache | Key | Value | Writer | TTL |
| --- | --- | --- | --- | --- |
| Query | query hash | ordered device ID list | API, on a Postgres miss | 5 minutes |
| Entity | device ID | full row projection | sync job only | staleness threshold (24 hours for devices) |

Read path: query key to Redis. Hit: hydrate IDs from the entity cache, Postgres fills misses.
Miss: Postgres runs the query, the API writes the ID list, then returns rows. The API never writes the entity cache.

### D2. The query cache holds the whole ordered result set (Q2)

Key = hash(customer, connection generation, permission version, filter, sort, query generation from D10).
Value = every matching ID in order, stale and fresh alike. A page is `LRANGE`. Count is `LLEN`.
The user scrolls one frozen ordering for the TTL. Grouped queries (`POST /api/devices/groups`) are not cached.

### D3. One mutable row per device replaces snapshots (Q3)

`cc.devices` becomes `(customer_id, device_id)` with `last_entity_sync timestamptz NOT NULL` and `removed_at timestamptz`.
Full sync and get-by-IDs sync use one upsert. Migration 016 is rewritten, not patched. Development data is disposable.
`device_sync_state` keeps the job lease and the last full enumeration time only.

### D4. A read dispatches every stale ID in the result set (Q4)

Not only the visible page. Dedupe uses a Redis in-flight set `cc:entity-inflight:{type}:{customer}` with a short TTL.
The API dispatches only IDs newly added to the set. Refresh all remains the explicit whole-inventory path.

### D5. Fetch strategy (Q5)

Get-by-IDs jobs use `chromeosdevices.get` per device and the telemetry read per device. Full sync uses `.list`.
A Kestra flow splits the ID list into batches and runs batches in parallel.
Each batch runner uses the Google batch endpoint.
The ID list travels in a `cc.entity_sync_jobs` row. Kestra receives the job ID. Batches pull their slice by job ID and batch index.

Facts to verify before implementation: the Directory batch endpoint is `/batch/admin/directory_v1`, inner calls still count against quota, and Chrome Management telemetry support for HTTP batch is unconfirmed.

### D6. Server-Sent Events over WebSocket (Q6)

`GET /api/devices/events` is an SSE response on the existing controller and session guard.
The worker publishes to Redis channel `cc:entity-events:{customer}`. Each API instance holds one dedicated subscriber client and fans out to open SSE responses.
Pub/Sub is fire-and-forget. The client reconciles on reconnect (D12), so lost messages cost only latency.

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

### D12. One SSE stream, poll retired (Q12)

The stream carries `entity-batch`, `full-sync` (`{syncId, status, failure?}`), and `job-finished` (`{jobId, completed, failed, failure?}`).
The 2 second poll is removed. The store opens one `EventSource` on Devices mount and closes it on leave.
On reconnect the store refetches `GET /api/devices/sync` once and `by-ids` for rows still tagged stale.

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

| Outcome | Get-by-IDs job | Full `.list` sync |
| --- | --- | --- |
| 404 for a device | soft-delete that device in the batch, delete its Redis key | not applicable |
| Quota error (429, quota 403) | back off and retry inside the worker until success | same |
| Any other error | the batch fails with the existing failure vocabulary | same |
| End-of-job scan | none | if every batch succeeded: soft-delete rows with `last_entity_sync < sync started_at` |
| Any batch failed | job finishes `failed`, untouched rows stay stale, next read re-dispatches | sync finishes `failed`, previous rows stay and show stale, no soft-deletes |

Nothing is ever hard-deleted. Freshness only advances. A device row never carries a failure state.

## Open items

- Q17 authorization: confirm this work is authorized as infrastructure under the active device browsing workflow, not a new workflow.
- Q17 recording: on authorization, update `docs/workflows/device-browsing.md` (freshness rule, banner and row behavior, soft delete, Refresh all) and `docs/current-work.md` (one paragraph with date).
- Q17 branch: `codex/devices-ui` holds finished grid work. Claude proposed `codex/entity-cache` branched from it. The owner has not chosen.
- Verify the Google batch endpoint facts in D5 against Google documentation.
- Write the implementation plan with the writing-plans skill before any code, in this order:
  migration, worker job and Kestra flow, API caches and `by-ids` and SSE, grid store and UI, docs and evidence.
