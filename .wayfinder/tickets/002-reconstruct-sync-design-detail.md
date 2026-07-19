---
title: Reconstruct sync design detail
type: grilling
status: closed
assignee: seaston
blocking: []
---

## Question

The 2026-07-15 sync design session survives only as a gist (see ticket 001). Reconstruct
the full design with Spencer: what exactly does the sync flow look like end-to-end —
what triggers a sync, what Redis Pub/Sub is coordinating, how per-entity thresholds are
evaluated, how the unified bootstrap/daily flow works, and what "24h ceiling" means
operationally (per-entity? per-tenant? staggered?).

## Resolution

Reconstructed with Spencer 2026-07-19:

- **Trigger model: view-driven + scheduler backstop.** Opening a grid/view checks that
  entity type's freshness against its threshold and enqueues a refresh if stale. A fixed
  nightly scheduled pass (admin-configurable time, default off-hours ~2am local) runs the
  full sweep for every entity type unconditionally — the 24h ceiling holds by construction.
- **Redis roles: both dedup and events.** An in-flight marker (Redis lock/key) ensures a
  sync already running for an entity type is joined, not duplicated (two admins opening
  Users simultaneously = one sync). Pub/Sub carries progress/completion events; subscribed
  views live-update from Postgres on completion.
- **Freshness is per entity type, not per record.** One freshness timestamp per collection.
  Single-record views may do a targeted get on open.
- **Default staleness thresholds** (admin-tunable): Users 1h, Devices 4h,
  Groups (+members) 1h, OrgUnits 12h.
- **Full sweep only in v1 — no delta path.** Every refresh is a full paginated list-sweep
  upserted into Postgres. Bootstrap is the degenerate first sweep into an empty table
  (progress events surfaced on the setup screen). Same mechanism for view-triggered,
  nightly, and bootstrap passes.
- **Deletion detection: mark-and-sweep.** Each record's lastSyncAt is stamped as the sweep
  touches it. After a completed sweep, records whose lastSyncAt predates the sweep start
  were not returned by Google → soft delete. New entities appear naturally as inserts.
