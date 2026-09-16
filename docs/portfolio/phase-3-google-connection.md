# Phase 3 Google customer connection

[CC-46](https://easton-consulting.atlassian.net/browse/CC-46) owns this implementation.
[PR #10](https://github.com/CampusCommander/campus-commander/pull/10) remains a draft.
The implementation now includes credential storage, provider verification, and public API confirmation.
The worker and coordinated renewal implementation awaits hosted qualification.
The browser workflow remains incomplete.

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
The background read permits sixty seconds, with bounded database operations and a twenty-second renewal deadline.

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
The [API qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35146666164) passed for runtime revision `0a048b9`.
The [full qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35146668372) passed all seven jobs, including packaged application and installation checks.
The [connection evidence](../../deployment/evidence/CC-46-customer-connection.json) records its checks and deployment limits.
Synthetic qualification does not prove live DWD privileges or deployed Google connectivity.

The owner confirmed customer `C01zcarnq` for `easton-consulting.com`.
The [live provider check](../../deployment/evidence/CC-46-live-provider-read.json) passed with that customer and one primary domain.
That read used the approved service account and the new verifier.
No live credential enters test fixtures, evidence files, or Git history.
CC-44 still requires its remaining live qualification gates.
CC-46 still requires browser integration and complete deployment qualification.
The new worker and token coordination checks require hosted execution before their evidence becomes qualified.
