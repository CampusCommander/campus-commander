# Phase 3 Google capability health

[CC-48](https://easton-consulting.atlassian.net/browse/CC-48) owns capability authorization and Google connection health.
The backend and browser workflow are implemented. Source and packaged qualification passed.

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

## Browser contract

The shared health store supplies Diagnostics and the shell footer.
Connection read grants permit inspection. Matching diagnostic grants permit checks.
Service diagnostics retain their separate permissions.
The connection page links to capability health after customer confirmation.

Each capability shows its required scope, token scope evidence, latest operation result, last success, and exact check timestamp.
Relative observation age advances from the server timestamp and elapsed browser time.
Passed observations become stale after the contract's five-minute freshness interval.
The UI describes a passed check without claiming continuous authorization.
Failed refreshes retain explicitly stale observations. Read denial clears them.

The UI disables repeated checks while a request, saved lease, or cooldown remains active.
Unknown results require a status refresh before another request.
Expired checks retain previous observations and permit an explicit recheck.
Session and permission-version changes invalidate pending responses.
The result region receives keyboard focus after an explicit check.

Generated authorization instructions include exact scope counts, copy controls, and a Google Admin console link.
Per-capability evidence links explain the qualification boundary.
Optional OU, inventory, and mutation scopes remain excluded.
Applicable rules: UI-01 through UI-10 and FORM-01.

## Qualification status

Local contract and provider tests, API build, lint, and deployment checks pass.
[Full qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35164443584) passed all seven jobs at `320e24b`.
The downloaded metadata confirms packaged Phase 3 execution against that runtime revision.
PostgreSQL authority, lease, audit rollback, and partial-result checks passed.
The run also passed API/worker token reuse, packaged Phase 2 compatibility, and all-Docker checks.
Both packaged capability accessibility reports contain zero automated violations.
Visual inspection of both packaged capability screenshots passed.

[Source qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35165931671) passed at `64b23ac`.
The downloaded source report confirms all 13 Google health checks.
Changes between `320e24b` and `64b23ac` affect qualification fixtures only.

Both hosted themes reported one manual-review item for the scope label, with zero automated violations.
Revision `14117c2` gives the scope text a named group role.
All eight local Chromium checks passed after this markup correction.
Both themes now assert no incomplete `aria-prohibited-attr` result.
Hosted qualification reports precede this final markup correction.

Eight local Chromium checks pass.
They cover partial access, targeted rechecks, stale and offline observations, denied reads, saved check expiry, uncertain requests, and read-only inspection.
Both themes pass automated accessibility checks, 320-pixel reflow, and 200 percent CSS zoom.
Three store regressions verify response ordering, permission-version fencing, and duplicate-check prevention.
A component regression verifies that obsolete checks preserve keyboard focus.
Health links focus the details across routes and during repeated navigation.
Human screen-reader and owner acceptance checks remain pending.

The [live capability proof](../../deployment/evidence/CC-48-live-capability-check.json) passed at `320e24b`.
It used the owner's approved customer and declared Super Admin role on easton-consulting.com.
Both separate capability tokens had the exact requested scope, and both Directory reads passed.
The result matched customer `C01zcarnq` and its approved primary domain.
No Education fixture is available. Education capability validation remains pending.
Minimum custom-role privileges, controlled revocation, and second-administrator replacement remain unqualified.
The existing live Directory proof does not establish those results.
