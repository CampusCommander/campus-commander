# Phase 3 customer settings

> Historical planning or implementation record. Read [current work](../current-work.md) and [workflow gaps](../workflow-gaps.md) before using it.
> This record does not authorize disputed features or require completion of its old checklists.


[CC-47](https://easton-consulting.atlassian.net/browse/CC-47) owns customer settings and durable onboarding progress.
Implementation starts from the qualified CC-46 customer binding.
The issue is In Review. Source and packaged browser qualification passed. Human acceptance remains pending.

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

## Browser workflow

The settings page shows the confirmed customer, saved name, revision, and observed setup progress.
The shared navigation uses the saved local name with the primary domain and customer ID.
A conflicting save preserves the edited name and requires an explicit revision review.
The page preserves ordinary input during offline refresh and same-principal access recovery.
A revoked read grant replaces the form with an access explanation.

Pending saves retain their exact request and allowlisted settings in tab session storage.
A reload can check the durable receipt or retry the same request.
Confirmed receipts remain accessible through the current saved request identifier.
Receipt reads preserve edited input and reject delayed responses from an earlier session.
The page moves keyboard focus to pending, conflict, or receipt results after an explicit action.

## Validation

Local API build, contract tests, lint, and deployment unit checks pass.
The [backend full CI](https://github.com/CampusCommander/campus-commander/actions/runs/35159796531) passed all seven jobs at `0bac981`.
PostgreSQL checks passed scope denial, competing writes, audit rollback, idempotency, and stale actor rejection.

Eight local Chromium cases pass. They cover conflicts, exact retries, receipt recovery, offline input, access recovery, read-only access, validation, and accessibility.
The browser checks include keyboard focus, both themes, 200 percent CSS zoom, and 320-pixel reflow.

Source qualification passed at `dcdc80d` in [run 35160778901](https://github.com/CampusCommander/campus-commander/actions/runs/35160778901).
The downloaded report confirms real API, PostgreSQL, and Redis recovery checks without repeated credential staging.
Both hosted accessibility reports contain zero automated violations.
Visual inspection of the light and dark conflict screenshots passed.

[Full qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35160781529) passed all seven jobs at `dcdc80d`.
The downloaded artifacts confirm packaged Phase 3 execution and both accessibility reports with zero automated violations.
The run also passed packaged Phase 2 compatibility and all-Docker installation checks.

The [sanitized evidence](../../deployment/evidence/CC-47-customer-settings.json) records checks and limits.
Human screen-reader and owner acceptance checks remain separate gates.
