# Phase 3 customer settings

[CC-47](https://easton-consulting.atlassian.net/browse/CC-47) owns customer settings and durable onboarding progress.
Implementation starts from the qualified CC-46 customer binding.
The issue remains In Progress. Browser implementation and hosted qualification remain pending.

## Settings contract

The initial allowlist contains `displayName`, a local customer label of 1–256 characters without control characters.
The API removes surrounding whitespace and rejects unknown fields.
The observed primary domain supplies the initial value before the first settings save.
The owner can identify additional required settings while implementation proceeds.

The Google customer ID and domains remain provider observations.
The deployment contract controls the installation hostname, TLS, and service placement.
Per-user theme and navigation preferences retain their existing storage and workflow.
Credentials, capability authorization, and school scopes retain their separate contracts.

## Durable progress and revision history

Migration 009 records immutable settings revisions in PostgreSQL.
Each revision identifies its customer, actor, actor permission version, request UUID, save time, and correlation UUID.
The settings revision and security event commit in one transaction.
Runtime roles cannot read or modify the history table directly.

Settings writes require current platform or matching district `customer:write` authority.
Reads require `customer:read` authority for the same scope.
Each function checks authority under the existing authorization lock.
The write checks the expected revision before inserting the next revision.
A stale revision returns a conflict without changing confirmed state.
An exact request retry returns its original receipt without another write or security event.
A changed request body or actor cannot reuse that request UUID.

The customer state derives confirmed progress from the durable customer binding and the first settings revision.
Credential staging expiry and Redis session loss do not delete those records.
The state exposes the last successful Google observation time without claiming current Google authorization or capability health.
It does not expose credentials or simulate inventory progress.

## Validation

Local API build, contract tests, lint, and deployment unit checks pass.
Hosted PostgreSQL checks will test scope denial, competing writes, audit rollback, idempotency, and stale actor rejection.
Browser and packaged application qualification remain pending.
Human screen-reader and owner acceptance checks remain separate gates.
