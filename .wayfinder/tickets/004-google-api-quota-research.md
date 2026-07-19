---
title: Google API quota numbers research
type: research
status: open
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
