---
title: Google API quota numbers research
type: research
status: closed
assignee: agent
blocking: [003]
---

## Question

What are the current, documented quota/rate limits for the APIs Campus Commander syncs
against, per GCP project (and per-user where applicable)?

- Admin SDK Directory API (users.list, chromeosdevices.list, groups.list, members.list,
  orgunits.list) — queries/minute, per-project and per-user; max page sizes per resource.
- Groups Settings API — rate limits and page/batch behavior.
- Chrome Management (Telemetry) API — rate limits, max page size.
- Documented 429/quota-exceeded semantics and recommended backoff (exponential? Retry-After?).
- Whether quotas are raisable via Cloud Console quota-increase requests, and default vs. cap.

Findings feed ticket 003 (quota pacing). Cite doc URLs; mark anything not found in
primary docs as unconfirmed.

## Resolution

Findings in [docs/research/google-api-quotas.md](../../docs/research/google-api-quotas.md),
every number source-linked, unconfirmed items labeled. Highlights:

- Directory API: 2,400 queries/min **per user per project** (adjustable); page sizes:
  users.list 500, chromeosdevices.list 300, groups.list/members.list 200,
  orgunits.list unpaginated (returns whole subtree).
- Groups Settings API: 100,000 queries/**day** (increasable); no list endpoint — one
  groups.get per group, so the daily quota is the binding constraint at scale.
- Chrome Management API: telemetry lists page at 1000 max; no public QPM/QPD —
  read the project's live quota from Cloud console instead.
- 429 rateLimitExceeded is **per Workspace customer, not per project, and cannot be
  raised** (project sharding won't escape it). 403 userRateLimitExceeded is raisable.
- Recommended backoff: truncated exponential (2^n)+jitter, 1s→16s, ~5 retries;
  no Retry-After header documented.
