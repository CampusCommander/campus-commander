# Phase 3 Google capability health

[CC-48](https://easton-consulting.atlassian.net/browse/CC-48) owns capability authorization and Google connection health.
The backend is implemented. Browser integration and hosted qualification remain pending.

## Capability evidence

The capability registry enables qualified customer and domain reads.
Each record names its documented scope, Google method, checked source, and qualification evidence.
The generated background scope profile contains exactly those two read-only scopes.
Optional organizational unit reads remain disabled until CC-52 qualifies their application workflow.
Inventory and mutation scopes remain excluded.

A diagnostic requests one temporary token for each selected capability.
It verifies that token's exact scope before reading that capability.
The diagnostic does not store temporary tokens.
A successful token exchange does not establish administrator privileges or operational access.
Customer and domain results remain independent when one request fails.

The [source research](../research/google-capability-health-2026-09-16.md) records provider meanings and their limits.
Generic permission denial does not identify a missing administrator privilege or license.
The health contract reserves a license restriction category for future verified responses.
Current Directory checks do not emit that category from generic errors.

## Durable observations and limits

Migration 010 stores capability results by customer and credential generation.
Each result retains its check time, scope evidence, failure, last success, and sanitized correlation identifier.
Confirmed connection observations provide the initial historical results.
Failed checks do not remove earlier success or change the confirmed customer.
Successful customer and domain checks update the full observation and clear the background failure latch.

The original combined check retains the shared encrypted API and worker token cache.
Successful combined checks confirm both capabilities.
Failed combined checks preserve independent capability observations because the combined failure cannot identify each result.
They complete the lease with a sanitized `health-inconclusive` audit event.
Background cache failures remain separate from capability observations.

The original check and capability check share one database lease across API replicas.
The lease expires after 45 seconds and prevents overlapping checks.
A 30-second cooldown bounds repeated operator requests.
Each diagnostic has a 30-second total deadline and 10-second transport deadlines.
Transport retries and redirects remain disabled.
The operator retries after recovery. The application does not repeat failed requests automatically.

Database functions check current application authority, customer, credential generation, actor version, lease identity, and lease expiry.
Capability writes, completion, and audit evidence commit together.
Runtime roles cannot read the health tables or private projection directly.
Health checks do not control local sign-in or installer readiness.

## Qualification status

Local contract and provider tests, API build, lint, and deployment checks pass.
Source API and PostgreSQL fault qualification remain pending hosted execution.
Browser health, stale-state, recovery, and accessibility checks remain pending implementation.

The approved live fixture uses the owner's declared Super Admin role on easton-consulting.com.
No Education fixture is available. Education capability validation remains pending.
Minimum custom-role privileges, controlled revocation, and second-administrator replacement remain unqualified.
The existing live Directory proof does not establish those results.
