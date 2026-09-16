# Phase 3 platform access implementation

Owner: CC-51. Status: database and API implementation in progress. Browser implementation and API integration qualification remain pending.
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

## Resource dependency

The initial runtime accepts platform grants only.
`application_scope_verified` rejects every unverified district and school scope.
CC-46 must connect this check to the confirmed customer record before district grants become available.
CC-52 must extend it with current school resource validation before school grants become available.
These remaining integrations prevent CC-51 completion.
Preset expansion continues to use the shared action and resource contract.
No browser value establishes that a Google customer or school exists.

## Validation

Local contract tests, migration contract tests, deployment tests, and lint passed.
The real PostgreSQL suite adds exact-grant, revision, audit rollback, delegation, and concurrent last-administrator checks.
[Hosted PostgreSQL qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35132226844) passed at commit `0b39466`.
The suite verified concurrent last-administrator protection, audit rollback, delegation ceilings, identity preservation, and bounded authorized reads.
The API adds authenticated list, detail, review, and confirmation endpoints with origin, CSRF, and actor-version checks.
Local API builds, lint, and edge route tests passed.
Direct API integration and browser validation remain pending.
UI rules UI-01 through UI-10 and FORM-01 apply to the forthcoming grant workflow.
