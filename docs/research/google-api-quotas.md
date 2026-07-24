# Google API Quotas for Workspace Sync (Directory, Groups Settings, Chrome Management)

Researched 2026-07-19 against primary sources only (developers.google.com, cloud.google.com/docs.cloud.google.com, and Google's own API discovery documents at `*.googleapis.com/$discovery/rest`). Feeds the quota-pacing design for background sync sweeps.

## 1. Admin SDK Directory API (`admin.googleapis.com`)

**Rate limit:** "The default value set in the Google Cloud console is 2,400 queries per minute per user per Google Cloud project."
Source: https://developers.google.com/workspace/admin/directory/v1/limits

- The 2,400 QPM figure is the **per-user, per-project** default, adjustable from the Admin SDK API Quotas page (see §5). A separate whole-project QPM cap shown in the Cloud console is **unconfirmed** in public docs (no number published).
- No queries-per-day limit is documented on the current limits page.
- Additional documented operation limits (same source): 10 user creations per domain per second; 1 org-unit create/update per customer per second; mobile-device ops 10–20 requests/sec depending on method.

| Endpoint | Rate limit | Page size (`maxResults`) | Source |
|---|---|---|---|
| `users.list` | Shared 2,400 QPM/user/project default | Default 100, min 1, **max 500** (discovery doc) | https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/list ; `admin.googleapis.com/$discovery/rest?version=directory_v1` |
| `chromeosdevices.list` | Shared 2,400 QPM/user/project default | Default 100 (discovery doc); "Value should not exceed **300**" | https://developers.google.com/workspace/admin/directory/reference/rest/v1/chromeosdevices/list |
| `groups.list` | Shared 2,400 QPM/user/project default | Default 200; "Max allowed value is **200**" | https://developers.google.com/workspace/admin/directory/reference/rest/v1/groups/list |
| `members.list` | Shared 2,400 QPM/user/project default | Default 200; "Max allowed value is **200**" | https://developers.google.com/workspace/admin/directory/reference/rest/v1/members/list |
| `orgunits.list` | Shared 2,400 QPM/user/project default | **No pagination** — only `customerId`, `orgUnitPath`, `type` params; returns the whole subtree in one response | https://developers.google.com/workspace/admin/directory/reference/rest/v1/orgunits/list |

Note: the HTML reference pages for `users.list` describe `maxResults` only as "Maximum number of results to return"; the default/min/max values (100/1/500) come from Google's own discovery document, which is the machine-readable source of truth for the API surface.

## 2. Groups Settings API (`groupssettings.googleapis.com`)

| Item | Value | Source |
|---|---|---|
| Queries per day | "You can make up to **100,000 queries per day**. If you need capacity beyond this limit, you can send a request from the Quotas page in the Google Cloud console." | https://developers.google.com/workspace/admin/groups-settings/limits |
| Per-minute / per-user limits | **Unconfirmed** — not published; only the daily quota is documented | — |
| Pagination | N/A — the API has only `groups.get`, `groups.update`, `groups.patch` (one group email per call); there is no list endpoint | `groupssettings.googleapis.com/$discovery/rest?version=v1` |
| Batch | Discovery doc declares a homogeneous batch path (`batch/groupssettings/v1`), but batch quota accounting for this API is **unconfirmed** in public docs | `groupssettings.googleapis.com/$discovery/rest?version=v1` |

The limits page recommends exponential backoff for time-based errors (it calls out 503 specifically).

**Sync design implication:** settings must be fetched one group at a time; at 100k/day this caps full settings sweeps at ~100k groups/day per project before an increase.

## 3. Chrome Management API (`chromemanagement.googleapis.com`, Telemetry)

| Endpoint | Rate limit | Page size (`pageSize`) | Source |
|---|---|---|---|
| `customers.telemetry.devices.list` | **Unconfirmed** (no public number; see below) | "Default value is 100. Maximum value is **1000**." | https://developers.google.com/chrome/management/reference/rest/v1/customers.telemetry.devices/list |
| `customers.telemetry.users.list` | **Unconfirmed** | Default 100, max **1000** | `chromemanagement.googleapis.com/$discovery/rest?version=v1` |
| `customers.telemetry.events.list` | **Unconfirmed** | Default 100, max **1000** | `chromemanagement.googleapis.com/$discovery/rest?version=v1` |
| `customers.telemetry.notificationConfigs.list` | **Unconfirmed** | Max **100** ("values above 100 will be coerced to 100") | `chromemanagement.googleapis.com/$discovery/rest?version=v1` |

- Neither the Telemetry API guide (https://developers.google.com/chrome/management/guides/telemetry_api) nor the REST reference publishes QPM/QPD numbers. The effective per-project quota is visible only in the Cloud console (IAM & Admin > Quotas & System Limits, filtered to `chromemanagement.googleapis.com`) — **treat any specific number as unconfirmed until read from the console for the actual project**.
- The adjacent Chrome Policy API (a different service, `chromepolicy.googleapis.com`) does publish a quota page (https://developers.google.com/chrome/policy/guides/api-quotas), confirming Google enforces console-visible per-minute quotas on the Chrome enterprise APIs generally.

## 4. 429 / quota-exceeded semantics and backoff

Source: https://developers.google.com/workspace/admin/directory/v1/limits

| HTTP | reason | Meaning | Documented remedy |
|---|---|---|---|
| 403 | `userRateLimitExceeded` | Per-user rate limit (2,400 QPM default) exceeded | Raise the per-user limit on the Admin SDK API Quotas page, or slow down / exponential backoff |
| 403 | `quotaExceeded` | "the limit of concurrent requests for a certain operation has been reached" | Exponential backoff |
| 429 | `rateLimitExceeded` | Concurrent-request limit reached; "This limit is per Google Workspace account, not per API client or per user. **This limit can't be increased.**" | Exponential backoff |

- **Recommended strategy:** truncated exponential backoff — wait `(2^n) + random_ms`, starting at 1 s and doubling to 16 s, max 5 retries (~32 s total), per the worked example on the limits page.
- **Retry-After header:** not mentioned anywhere in the Directory, Groups Settings, or Chrome Management docs reviewed — **unconfirmed** that Google sends it for these APIs. Honor it opportunistically if present, but pace on backoff, not on the header.
- Because the 429 concurrency limit is **per Workspace customer account** (not per project), a self-hosted install cannot escape it by sharding across GCP projects; the sync engine needs a per-customer concurrency ceiling.

## 5. Quota-increase mechanics

- **Where:** Google Cloud console → "IAM & Admin > Quotas & System Limits" → select quota → Edit → enter value ("Apply for higher quota" for values beyond the shown limit). "Cloud Quotas adjustment requests are subject to review"; outcome arrives by email; "In most cases, quota increase adjustments must be made at the project-level."
  Source: https://docs.cloud.google.com/docs/quotas/view-manage (canonical redirect of cloud.google.com/docs/quotas/view-manage)
- **Directory API:** the per-user 2,400 QPM default can be raised — "Increase the per user limits from the Admin SDK API Quotas page of your Google Cloud project" — but the 429 per-account concurrency limit "can't be increased." (https://developers.google.com/workspace/admin/directory/v1/limits)
- **Groups Settings API:** the 100,000/day quota is explicitly increasable "from the Quotas page in the Google Cloud console." (https://developers.google.com/workspace/admin/groups-settings/limits)
- **Chrome Management API:** increase path is the generic Cloud Quotas flow above; defaults and caps are **unconfirmed** in public docs.
- **Defaults vs. caps:** Google does not publish hard upper caps for these adjustable quotas; approval is discretionary. Fixed *system limits* (as opposed to quotas) cannot be raised at all, per the Cloud Quotas doc above.

## Practical takeaways for sync pacing

1. Page sizes differ sharply: 500 (users), 300 (ChromeOS devices), 200 (groups/members), 1000 (telemetry). A 200k-user district is ~400 `users.list` calls but a 200k-group membership sweep is >=1,000 `members.list` calls *plus* one call per group.
2. Budget against 2,400 QPM per user per project for Directory; use a single service-account subject consistently so the budget is predictable.
3. Groups Settings' 100k/day daily quota (not QPM) is the binding constraint for large group estates; schedule settings sweeps across days or request an increase early.
4. Read the project's actual Chrome Management quotas from the Cloud console at install time rather than hardcoding — no public numbers exist.
