# Map: Sync & Freshness Strategy + Jobs Pipeline <!-- wayfinder:map -->

## Destination

A "Sync & Freshness Strategy" section and a "Jobs Pipeline" section written into
`docs/superpowers/specs/2026-07-07-core-entity-management-design.md` — one coherent
design (sync is the first tenant of the jobs pipeline), resolving both remaining
Open Questions in that spec. Done when both sections are written, reviewed, and committed.

## Notes

- Spencer has run this design at scale before and has a specific design to get down —
  capture his design via /grilling, don't invent. Recommend, but defer to his experience.
- Ground every Google API claim (quota numbers, endpoints) in live docs via /research;
  mark unconfirmed items unconfirmed in the doc.
- Checkpoint decisions into the spec doc incrementally as they land, not batched at the end.
- Tracker: local markdown (this directory). Tickets in `tickets/`, one file each,
  frontmatter holds status/claim/blocking.

## Decisions so far

- [Sync architecture baseline](tickets/001-sync-architecture-baseline.md) — Redis Pub/Sub
  local cache; 24h sync ceiling; per-entity-type configurable staleness thresholds;
  unified bootstrap/daily sync flow. (Decided 2026-07-15.)
- [Reconstruct sync design detail](tickets/002-reconstruct-sync-design-detail.md) —
  view-driven refresh + fixed nightly backstop pass; Redis in-flight dedup + Pub/Sub
  progress/completion events; per-entity-type freshness (Users 1h / Devices 4h /
  Groups 1h / OrgUnits 12h defaults); full-sweep-only in v1; mark-and-sweep soft
  deletion via lastSyncAt.

## Not yet specified

- Jobs pipeline architecture: what the worker/queue model looks like (BullMQ vs. custom on
  Redis, job durability across restarts, scheduling/recurrence) — sharpens once the sync
  design detail is down, since sync + bootstrap scan-and-wait + async device commands are
  its known tenants.
- How sync interacts with bulk-action writes (read-after-write freshness, cache
  invalidation on our own mutations).
- Failure/observability surface: what the admin sees when sync lags or quota is exhausted.

## Out of scope

- Real-time push via Admin SDK push notifications / Cloud Pub/Sub subscriptions — v1 is
  polling-based per the 2026-07-15 baseline decision.
