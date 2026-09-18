# Phase 3 access revocation

> Historical planning or implementation record. Read [current work](../current-work.md) and [workflow gaps](../workflow-gaps.md) before using it.
> This record does not authorize disputed features or require completion of its old checklists.


Owner: CC-53. Status: platform revocation and browser recovery implemented. Combined recovery qualification passed.
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

- Integrate school scope changes after CC-52.
- Confirm that background Google credentials remain independent after the connection implementation exists.
- Complete human screen-reader validation for the combined workflows.

These changes do not establish CC-53 or Phase 3 completion.

## Validation

[Full hosted qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35138700261) passed all seven jobs at `21b7d16`.
The real PostgreSQL suite covers invitation state transitions, exact preview targets, audit rollback, and concurrent confirmation and revocation.
It verifies operator replacement and revocation, accepted invitations, unrelated invitations, and rejection of token replay.
[Hosted browser qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35139411091) passed at `490aa8c`.
The interrupted-state accessibility report contains zero violations and zero incomplete checks.

[Combined recovery qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35141232435) passed at `1c83a78`.
This revision includes the delayed-response fixes, replica restart, Redis loss, guessed identifiers, and unrelated-user preservation.
The same revision passed all seven jobs in the [full compatibility run](https://github.com/CampusCommander/campus-commander/actions/runs/35141611500).
The first expanded run identified a Redis fixture reconnect failure after Docker changed its dynamically published port.
The corrected fixture connects a fresh client to the current published port. The repeated recovery checks passed.
Local Nx build, test, lint, and type checks passed across all thirteen affected tasks.
Ten frontend tests include the delayed unauthorized-body and delayed access-review regressions.
Both regressions fail without their session checks and pass with those checks.
Standards and Spec review resolved both response findings and the test-fixture reconnect finding.
UI rules UI-01 through UI-10 and FORM-01 apply to the workflow.
[Retained evidence](../../deployment/evidence/CC-53-access-revocation.json) records exact revisions and remaining scope.

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

## Stale browser recovery

A Phase 3 unauthorized response suspends that tab's requests and preserves its component state.
The shared shell explains the interruption and provides sign-in in another tab.
The original tab retains unsent invitation fields and proposed grants while authentication proceeds.
It clears invitation links, invitation confirmation, and grant confirmation.

Recheck access accepts only the same stable principal ID.
A different principal closes the previous form. Lost page authority redirects to the account page.
Successful recovery still requires fresh observations and another explicit review before confirmation.
Navigating away discards the retained form values. The browser stores no draft credentials or invitation tokens.
A late unauthorized response cannot replace a newer session, including a response whose body finishes after recovery.
A late list, detail, receipt, or review response cannot restore observations from the previous session.
A delayed invitation creation result confirms creation without exposing its link after access changes.
Sign-out checks and revokes the current browser session even when the tab was interrupted.
Phase 2 retains its existing sign-in redirect.

Local store tests cover recovery, identity changes, late responses, sign-out, and Phase 2 compatibility.
The hosted browser test exercises two stale tabs, separate-tab sign-in, restored fields, and invalidated confirmation.

## Combined recovery checks

The API fixture restarts one replica after revocation and restores an old session record.
The restarted replica must reject the old session and remove its record.
The fixture then restarts Redis with persistence disabled and waits for both APIs to reconnect.
Missing sessions and restored stale sessions must fail through both replicas.
Direct requests with another principal ID must return no protected data.

An unrelated principal retains its session and exact identity before Redis loss.
After Redis loss, that principal can sign in again with unchanged grants and preferences.
Redis loss ends all browser sessions because the deployment intentionally keeps them in volatile storage.
The tests distinguish this cache loss from revocation of one principal.
