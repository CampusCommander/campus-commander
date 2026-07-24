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
- [Quota pacing](tickets/003-quota-pacing.md) — greedy first-come-first-serve (no shared
  rate budget); two-level retry (NestJS per-request backoff + Kestra flow-level retry);
  per-worker backoff tracking; Google-driven retry logic via 429 responses. (Decided
  2026-07-22.)
- [Sync and bulk-action write interaction](tickets/005-sync-bulk-write-interaction.md) —
  post-job backfill to Postgres + Redis; Redis pub/sub notification to client; client
  fetches updated values immediately from Redis cache. (Decided 2026-07-22.)
- [Failure/observability surface](tickets/006-failure-observability-surface.md) — basic
  job status only, modeled on Google Cloud Console pattern (status, duration, brief
  errors). No advanced observability initially. (Decided 2026-07-22.)
- [Google API quota numbers research](tickets/004-google-api-quota-research.md) —
  documented limits captured in docs/research/google-api-quotas.md: Directory 2,400
  QPM/user/project; Groups Settings 100k/day (no list endpoint — binding constraint);
  Chrome Management QPM unpublished; 429 is per-customer and unraisable; exponential
  backoff + jitter, no Retry-After.

## Not yet specified


## Out of scope

- Real-time push via Admin SDK push notifications / Cloud Pub/Sub subscriptions — v1 is
  polling-based per the 2026-07-15 baseline decision.
