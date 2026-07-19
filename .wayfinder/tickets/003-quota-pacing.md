---
title: Quota pacing
type: grilling
status: open
assignee: ~
blocked-by: []
---

## Question

How does sync pace itself against Google API quotas? Per-API rate limits (Directory,
Groups Settings, Chrome Management/Telemetry), pagination strategy for large districts,
burst vs. sustained behavior, backoff on 429/quota-exceeded, and how quota is shared
between background sync and interactive/bulk-action traffic. Explicitly left open on
2026-07-15. Ground actual quota numbers in live Google docs via /research before locking.
