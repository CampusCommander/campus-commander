# Phase 3 Google customer connection

[CC-46](https://easton-consulting.atlassian.net/browse/CC-46) owns this implementation.
[PR #10](https://github.com/CampusCommander/campus-commander/pull/10) remains a draft.
The implementation now includes credential storage, provider verification, and public API confirmation.
Coordinated renewal and independent worker reads passed hosted qualification.
The browser workflow passed hosted qualification against the real API and PostgreSQL.

## Credential and customer transaction

The browser supplies a UUID before importing a service account.
The API requires current `connection:manage` authority, the configured origin, and the session CSRF token.
The service-account client ID must match the submitted client ID.
The validator accepts only the fixed Google token endpoint and RSA keys of at least 2048 bits.

Migration 007 stores an encrypted candidate with its actor, permission version, and browser binding.
Authenticated encryption binds the candidate to its UUID, encryption-key version, null customer, and generation zero.
The runtime role cannot read credential tables directly.
Narrow database functions enforce current authority and return only the requested candidate.
The API removes encrypted credentials before returning candidate metadata to the browser.

The verifier requests read-only scopes for [customers.get](https://developers.google.com/workspace/admin/directory/reference/rest/v1/customers/get) and [domains.list](https://developers.google.com/workspace/admin/directory/reference/rest/v1/domains/list).
It checks the issued scopes before reading customer and domain metadata.
It permits fixed Google endpoints, ten seconds per request, and forty seconds for the verification sequence.
Each response permits at most 256 KiB.
The transport disables retries and redirects.
The verifier retains the customer ID, primary domain, secondary domains, aliases, verification flags, and observation time.
It rejects inconsistent primary domains, duplicate names, and aliases with a different parent domain.

Confirmation requires the observed customer ID and an explicit confirmation field.
The API encrypts the credential again with the customer ID and generation one.
One database transaction creates the customer binding, activates the credential, consumes the candidate, and records both security events.
The transaction rejects competing first connections, changed authority, expired candidates, and replay.
District scopes become valid only for the confirmed customer.

## Recovery and cleanup

The connection endpoint returns `{connection: null}` before customer binding.
Candidate UUIDs support recovery after a lost response.
Authorized reads return failed, expired, and consumed metadata without encrypted credentials.
Failures retain bounded categories for credentials, delegation, scopes, API enablement, privileges, policy, quota, network, and provider availability.
Confirmation checks wall-clock expiry after acquiring the authority lock.

Candidates expire after ten minutes.
Every API instance attempts cleanup at startup and once per minute without overlapping its own cleanup calls.
Cleanup clears expired ciphertext and records security events atomically.
Healthy cleanup removes expired ciphertext within eleven minutes and eight seconds after staging.
That bound includes the one-minute cleanup interval, three-second connection timeout, and five-second query timeout.
Database failure delays physical deletion until a successful cleanup transaction.
Reads and confirmation still enforce the ten-minute deadline.

Each cleanup transaction removes at most 500 terminal records older than one day.
Indexes support expiry and terminal-history selection.
Staging permits at most twenty active candidates globally and three per actor.
Ten-minute creation limits permit one hundred candidates globally and ten per actor, including failed checks.

## Browser onboarding

The Phase 3 Google connection page imports a service-account file and requests the approved delegated administrator email.
It displays the numeric client ID and both scopes from the shared provider contract.
The page clears private file input after submission, navigation, or access interruption.
Browser storage retains only the candidate UUID for the current principal.

The review displays customer ID, primary domain, secondary domains, aliases, verification flags, and expiry.
An explicit checkbox enables confirmation of that exact customer.
Pending requests, expired reviews, stale saved state, and uncertain outcomes prevent confirmation.
Lost responses recover through public candidate metadata and the durable customer binding.
Rate-limited requests explain the limit without retaining a nonexistent candidate.
Session checks discard delayed response bodies after access recovery.
New saved-state reads supersede older requests.
The shared navigation displays the confirmed customer identity.

Local Chromium checks cover response loss, expiry, read-only access, Phase 2 exclusion, offline input preservation, and access interruption.
Both themes pass automated accessibility checks after Material color transitions finish.
Keyboard confirmation, 200 percent CSS zoom, and 320-pixel overflow checks pass.
Tests wait for saved theme preferences and responsive layout before measuring the final state.
UI-01 through UI-10 and FORM-01 govern the page.
Human screen-reader and owner acceptance checks remain unperformed.
Hosted qualification uses the real API and PostgreSQL with synthetic Google transport.
Its browser helper tests import, confirmation, duplicate prevention, and recovery after committed responses disappear.

## Coordinated background reads

Migration 008 stores one encrypted access token for the current credential generation.
Authenticated data distinguishes tokens from service-account credentials.
Each token binds its credential record, customer, generation, key version, and scope profile.
A thirty-second database lease permits one renewal across API and worker processes.
Consumers renew tokens with less than sixty seconds remaining.
Directory clients disable the SDK early-refresh threshold after construction.
The SDK ignores zero in constructor options. A regression checks tokens with ninety seconds remaining.
Generation and lease checks reject results from replaced credentials and expired renewal attempts.
A token identifier prevents a late failed request from invalidating a newer token.

Permanent credential, delegation, scope, privilege, and policy failures stop automatic renewal.
A current operator with `connection:diagnose` authority can authorize another attempt.
Transient network, quota, provider, and request failures require a thirty-second cooldown.
Token changes and observations commit with their security events.
Google requests share a sixty-second abort signal. Renewal has a twenty-second deadline.
Database operations retain three-second connection and five-second query timeouts.

The API exposes a CSRF-protected `POST /api/google-connection/check` operation.
It checks operator scope before the read and reauthenticates before returning its result.
The observation transaction rechecks the actor permission version before writing observation and audit records.
The worker exposes the internal `POST /dispatch/google-customer` operation through the existing dispatch authentication boundary.
Dispatch accepts customer, generation, execution, and correlation identifiers.
The worker loads credentials from PostgreSQL and the key from its local secret mount.
Browser sessions and API process memory do not supply its credentials.
Worker responses contain validated observations and bounded failure categories.

## Deployment configuration

Phase 3 accepts an optional `googleConnection` object with `keyId` and `encryptionKeySecretRef`.
The secret contains exactly 32 raw bytes.
The reference must differ from application secrets and operator credentials.
All three renderers mount the key into API and worker processes.
Kubernetes also requires `operator.externalEgress.googleProvider` CIDRs and permits their HTTPS egress from API and worker processes.
Operators must maintain those network ranges for the fixed Google endpoints.

A missing or unreadable encryption key returns a bounded connection error.
It does not prevent local sign-in or readiness checks.
The installer does not yet provision this key automatically.
The deployment configuration is an implementation contract until profile qualification completes.

## Validation boundaries

Synthetic tests cover encryption, provider normalization, request bounds, error categories, edge routes, and secret isolation.
Hosted PostgreSQL checks cover current authority, cleanup bounds, lock-delayed expiry, failure recovery, audit rollback, and competing confirmations.
The API qualification uses a dedicated synthetic Google transport preload in the test process.
Production code contains no provider-mock configuration switch.
The [source-container qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35157399846) passed at revision `ad1d7ee`.
It verifies browser import, explicit confirmation, lost-response recovery, and the existing API and worker boundaries.
Six onboarding accessibility reports record zero automated violations across import, review, and confirmed states in both themes.
The [packaged qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35157401813) passed Phase 2 and Phase 3 application checks at `ad1d7ee`.
The full run passed all seven jobs, including the all-Docker installation check.
Downloaded artifacts confirm packaged Phase 3 execution and six onboarding accessibility reports with zero automated violations.
The [connection evidence](../../deployment/evidence/CC-46-customer-connection.json) records its checks and deployment limits.
Synthetic qualification does not prove live DWD privileges or deployed Google connectivity.

The owner confirmed customer `C01zcarnq` for `easton-consulting.com`.
The [live provider check](../../deployment/evidence/CC-46-live-provider-read.json) passed with that customer and one primary domain.
That read used the approved service account and the new verifier.
No live credential enters test fixtures, evidence files, or Git history.
CC-44 still requires its remaining live qualification gates.
CC-46 still requires complete deployment-profile qualification and remaining live gates.
Two independent worker processes shared one renewal and reused encrypted tokens after API and worker restarts.
Wrong keys and denied database access failed closed.
PostgreSQL qualification covered audit rollback, retired leases and generations, cooldowns, and concurrent operator revocation.
