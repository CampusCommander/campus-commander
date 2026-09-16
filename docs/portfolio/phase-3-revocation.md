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

- Revoke affected pending invitations under a documented policy.
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
