# Phase 3 platform access implementation

Owner: CC-51. Status: platform database, API, and browser implementation exist. Hosted platform qualification passed after review fixes. District integration remains pending.
This branch builds on CC-50. It does not establish Phase 3 completion.

## Change contract

Platform user reads require `platform-users:read` at platform scope.
Grant review and confirmation require `platform-users:manage` at platform scope.
Each database operation rechecks the enabled actor and current permission version.
Lists return bounded pages and an authorized total. Detail records retain the stable principal ID, issuer, and subject.
They exclude another user's preferences.

Review shows current grants, proposed grants, enabled state, and exact permission versions.
Confirmation repeats every check under the shared authority transaction lock.
The actor must hold authority over both existing and proposed grants.
This prevents a limited grant manager from changing a more privileged principal or increasing their own authority.
Unknown actions, duplicate grants, invalid scopes, stale versions, and unchanged requests deny mutation.

The final enabled platform administrator retains every platform action.
Concurrent runtime changes cannot disable that administrator or remove an action from their platform grants.
The installation operator retains the separately documented recovery boundary.

Changes preserve principal identity, legacy permissions, preferences, and historical security events.
Each accepted change increments the permission version.
Grants, enabled state, permission version, a before-and-after receipt, and security events commit in one transaction.
Any audit failure rolls back the entire change.
Existing session validation rejects the previous permission version on the next protected request.
Authorized readers can inspect each principal's immutable receipt history through bounded pages.
Receipts retain the actor, target, versions, timestamp, enabled states, and exact grants.
Navigation and browser refresh preserve access through the principal detail view.
Unchanged requests, version conflicts, delegation failures, and last-administrator restrictions return distinct rejection reasons.
A lost confirmation response reports an unknown outcome. Reloading the principal retrieves current access and receipt history.
A later session-check failure preserves a confirmed change and its receipt.

## Resource dependency

The initial runtime accepts platform grants only.
`application_scope_verified` rejects every unverified district and school scope.
CC-46 must connect this check to the confirmed customer record before district grants become available.
CC-52 must extend it with current school resource validation before school grants become available.
The confirmed-customer integration prevents CC-51 completion. School grants remain the downstream CC-52 extension.
Preset expansion continues to use the shared action and resource contract.
No browser value establishes that a Google customer or school exists.

## Validation

Local contract tests, migration contract tests, deployment tests, and lint passed.
The real PostgreSQL suite adds exact-grant, revision, audit rollback, delegation, and concurrent last-administrator checks.
[Hosted PostgreSQL qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35132226844) passed at commit `0b39466`.
The suite verified concurrent last-administrator protection, audit rollback, delegation ceilings, identity preservation, and bounded authorized reads.
The API adds authenticated list, detail, review, and confirmation endpoints with origin, CSRF, and actor-version checks.
Local API builds, lint, and edge route tests passed.
The browser lists authorized principals and shows identity, existing permissions, editable grants, and an explicit confirmation preview.
Input changes invalidate that preview. Failed refreshes preserve edits and prevent confirmation until current access returns.
Local light and dark checks reported zero automated accessibility violations. The editor fits a 320-pixel viewport without horizontal overflow.
[Full hosted qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35134910313) passed all seven jobs at `3cd35737dfd0c5d9534116816bf5436c1a879277`.
This includes real PostgreSQL, direct API authorization, browser grant management, and earlier-phase compatibility.
[Focused hosted qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35136921322) passed after review fixes at `e6bfd8d3c8800efe62e53068112ba1983b15ed1c`.
The same revision passed real PostgreSQL checks. Its full compatibility run remains active.
[Retained evidence](../../deployment/evidence/CC-51-platform-access.json) records the exact revisions, checks, review findings, and limits.
Local regression checks cover failed detail reloads, unchanged reviews, durable receipts, and lost confirmation responses.
A component test verifies that a failed session check preserves an already confirmed access change.
UI rules UI-01 through UI-10 and FORM-01 apply to the grant workflow.
Human screen-reader validation remains not run. District and school presets remain unavailable until verified resource integration.
