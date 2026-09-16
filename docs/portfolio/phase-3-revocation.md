# Phase 3 access revocation

Owner: CC-53. Status: initial server changes implemented. Hosted initial regression checks passed.
CC-52 remains the completion prerequisite for school scope integration.

## Current implementation

Every protected request compares its stored permission version with the current enabled principal.
A mismatch removes that session from Redis and returns `access-changed` with HTTP 401.
The API records the denied attempt without session tokens or provider credentials.

Preference writes now check the enabled principal and permission version inside the update statement.
A concurrent access change prevents both the preference update and its success event.
The API records the rejected write after transaction rollback.
The PostgreSQL row lock orders the preference write against the access change.
A preference write that completes before revocation remains valid.

## Regression test

The integration test starts two independent sessions for one principal across two API replicas.
It locks the principal row and starts a preference request with the previous permission version.
It waits until PostgreSQL reports the blocked preference update, then commits a permission-version change.
The test requires HTTP 401, unchanged preferences, and no preference success event.
Both replicas must reject their stale sessions, including copies restored into Redis.
This test uses an isolated synthetic installation. It changes no live Workspace access.

## Remaining work

- Qualify the new invitation revocation policy against real PostgreSQL and browser flows.
- Preserve recoverable browser input and show explicit access-change guidance.
- Integrate school scope changes after CC-52.
- Qualify concurrent grant writes, restart, Redis loss, unrelated users, and installation-operator recovery together.
- Confirm that background Google credentials remain independent after the connection implementation exists.

The initial change does not establish CC-53 or Phase 3 completion.

## Validation

[Hosted initial qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35137274584) passed at `117a8e7`.
The real PostgreSQL race and both API replica checks passed.
Local API build and lint passed. Standards and Spec review found no defects in this bounded change.
[Retained evidence](../../deployment/evidence/CC-53-access-revocation.json) records the tested revision and remaining scope.

## Invitation revocation policy

Every runtime access change ends the principal's issued, redeeming, and pending invitations.
This applies to grant additions, grant removals, enablement changes, and operator identity replacement.
An invitation represents intent under the previous access version. Reenabling access does not restore that invitation.
Accepted invitations and invitations from unrelated principals retain their state.

The access preview lists exact invitation IDs and recipient labels.
Confirmation checks the same sorted IDs under the shared authority lock.
A new or removed invitation requires another review before confirmation.
Grant changes, invitation revocations, versions, receipts, and security events share one transaction.
An audit failure rejects the entire transaction.
The receipt retains the revoked invitation IDs.

Installation-operator replacement, revocation, and administrator confirmation apply the same invalidation within their existing transaction.
The private revocation function rejects direct runtime calls.
