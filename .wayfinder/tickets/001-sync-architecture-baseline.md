---
title: Sync architecture baseline
type: grilling
status: closed
assignee: seaston
blocking: []
---

## Question

What is the overall sync/cache architecture — push vs. poll, cache layer, freshness
model, and how initial bootstrap sync relates to steady-state sync?

## Resolution

Decided in the 2026-07-15 session (detail lost; gist recovered from memory):

- Local cache in Postgres, coordinated via Redis Pub/Sub.
- 24h sync ceiling — no entity goes longer than 24h without refresh.
- Per-entity-type configurable staleness thresholds.
- Unified bootstrap/daily flow — the initial full sync and the recurring sync are the
  same mechanism, not two codepaths.
- Quota pacing was explicitly left open (→ ticket 003).

Full detail to be reconstructed with Spencer in ticket 002 before the spec section
can be written.
