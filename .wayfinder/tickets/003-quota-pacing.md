---
title: Quota pacing
type: grilling
status: closed
assignee: seaston
blocked-by: []
resolved: 2026-07-22
---

## Question

How does sync pace itself against Google API quotas? Per-API rate limits (Directory,
Groups Settings, Chrome Management/Telemetry), pagination strategy for large districts,
burst vs. sustained behavior, backoff on 429/quota-exceeded, and how quota is shared
between background sync and interactive/bulk-action traffic. Explicitly left open on
2026-07-15. Ground actual quota numbers in live Google docs via /research before locking.

## Resolution

**Decided 2026-07-22:**
1. **Greedy first-come-first-serve** — workers do not coordinate on a shared rate budget. Whoever hits the API first gets the quota.
2. **Two-level retry** — NestJS workers handle per-request backoff/retry internally (fine-grained, per-call). Kestra handles flow-level retry (coarse-grained, per-chunk). This gives two levels of retry.
3. **Per-worker backoff tracking** — each NestJS worker instance maintains its own backoff state, no shared coordination.
4. **Google-driven retry logic** — rely on Google's 429 responses and error codes to guide retry timing, not a pre-computed rate schedule.

Quota numbers from research (ticket 004): Directory 2,400 QPM/user/project; Groups Settings 100k/day; Chrome Management QPM unpublished; 429 is per-customer and unraisable.

**Implication:** No distributed rate limiter needed. The 429 per-customer limit is handled reactively (back off when Google says so) rather than proactively (pre-computing a shared rate budget). This keeps the architecture simple and avoids cross-worker coordination.
