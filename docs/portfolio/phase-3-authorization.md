# Phase 3 authorization contracts

Decision owner: CC-45. Status: implemented contracts, hosted integration passed. Review remains pending.
This document settles D05 through D08 for dependent implementation slices.

## Actions and resources

The shared contract owns action names, resource schemas, preset expansion, and permission evaluation.
The API resolves current resources from trusted database records before it evaluates a grant.
A client-supplied customer or school ID does not prove resource existence, membership, or verification.

| Action                  | Supported grant scopes     | Behavior                                                    |
| ----------------------- | -------------------------- | ----------------------------------------------------------- |
| `customer:read`         | Platform, district         | Read customer settings and confirmed onboarding progress.   |
| `customer:write`        | Platform, district         | Change customer settings with revision checks.              |
| `connection:read`       | Platform, district         | Read sanitized connection and capability health.            |
| `connection:diagnose`   | Platform, district         | Request bounded connection checks.                          |
| `connection:manage`     | Platform                   | Authorize, confirm, replace, revoke, or rotate credentials. |
| `platform-users:read`   | Platform                   | Read platform principals, invitations, and explicit grants. |
| `platform-users:invite` | Platform                   | Create, inspect, revoke, and confirm invitations.           |
| `platform-users:manage` | Platform                   | Change grants and enable or disable principals.             |
| `schools:read`          | Platform, district, school | Read authorized school definitions.                         |
| `schools:manage`        | Platform, district         | Create or change school definitions.                        |
| `security-events:read`  | Platform, district, school | Read events within the authorized resource scope.           |

A platform grant covers supported resources for its exact action.
A district grant covers its exact customer and that customer's authorized school resources.
A school grant covers its exact customer and school UUID.
Unknown actions, malformed grants, unsupported scope combinations, and missing grants deny access.
The evaluator does not infer actions from a role name or accept wildcard actions.

The existing `identity:read`, `diagnostics:read`, and `diagnostics:run` permissions remain separate.
Diagnostics checks installation infrastructure. A district or school grant does not authorize these global checks.
The migration preserves those permissions without adding Phase 3 grants.

## Presets and privileged changes

| Preset                 | Expansion                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| Platform administrator | Every listed action at platform scope.                                                                        |
| District administrator | Customer read/write, connection read/diagnose, school read/manage, and scoped security-event read.            |
| School administrator   | School-definition read and school security-event read for one explicit school.                                |
| Viewer                 | Customer, connection, and school read for one district. A school viewer receives school-definition read only. |

School administrators receive additional entity actions only in their owning delivery phases.
The Phase 3 preset does not claim device or Google user management.
Only platform administrators manage credentials, invitations, and platform access.
Dependent mutation endpoints must enforce delegation limits and prevent self-escalation.
They must preserve the last enabled platform administrator under concurrent changes.

Existing principals keep their IDs, identity bindings, preferences, enabled state, and permission versions during migration.
The installation operator selects a principal and explicitly confirms its new platform grants.
The confirmation increments the permission version and commits its security event with the grants.
Existing sessions then require another sign-in.
The application runtime cannot perform this operator action or write grants directly.

## Invitation identity

Invitation ownership uses verified OIDC issuer and subject. Email addresses and email suffixes do not authorize a principal.
The application keeps the existing `openid profile` login scopes.
An invitation token proves possession of the invitation only.
An unknown redeemed identity remains pending until the inviter confirms its verified issuer and subject.
The confirmation rechecks the inviter's current authority and the invitation's intended grant ceiling.

Store a token hash, bounded expiry, issuer restriction, intended grants, and terminal lifecycle state.
Bind browser redemption to its OIDC transaction and consume the token atomically.
Deny expired, revoked, replayed, wrong-issuer, and competing redemptions.
Revoking the inviter prevents subsequent confirmation of pending invitations.
Copyable invitation links work without SMTP.

## School scope semantics

A school has a district-owned UUID and a verified customer binding.
It contains explicit included and excluded stable resource references.
Multiple OU roots can belong to one school. Multiple schools can overlap.
An exclusion takes precedence within its school definition.
Grants for separate schools combine only after each school definition passes current validation.

Use verified provider hierarchy observations to resolve descendants of an included OU root.
Paths serve as display context. They do not replace stable OU identities.
Missing, stale, unverified, cross-customer, and excluded references never expand access.
A hierarchy change requires revalidation before it changes effective scope.
Preserve the last valid definition and expose its stale state while revalidation remains incomplete.
Group expansion remains unavailable in Phase 3.

Apply the same evaluator to lists, counts, details, and events.
Filter before pagination and counting. Do not return global counts to a school-scoped caller.
Synthetic resource fixtures prove these rules until the owning phase introduces entity inventory.

## Database and concurrency boundary

Migration `003-application-grants` adds the action catalog and explicit grants without changing earlier migration bytes.
The runtime role receives read access to grants and the action catalog.
It retains insert-only security-event writes and preference-column updates.
It receives no direct grant writes, principal authority updates, schema writes, or security-event rewrites.

Dependent runtime mutation slices must introduce narrowly scoped database operations.
Those operations must recheck the actor, permission version, action, and resource within the mutation transaction.
They must serialize authority changes, protect the final administrator, and commit security evidence with the state change.
Every protected request reloads the principal and current grant version.
Phase 2 requests receive no Phase 3 grants, even when the database contains them.
Redis failure retains the existing denial behavior.

## Module ownership and qualification

- `libs/application-contracts` owns public schemas, action names, scope evaluation, and preset expansion.
- `api/src/app/auth` owns session validation, current principal lookup, and server authorization entry points.
- `frontend/src/app/auth.store.ts` uses the same evaluator for available controls. The server remains authoritative.
- `deployment/postgres` owns migrations, catalog constraints, and runtime database privileges.
- `deployment/bootstrap/application-access.mjs` owns operator confirmation and recovery through the migration role.
- `api-e2e` owns the Phase 2 compatibility and Phase 3 authorization integration runs.

Local build, lint, and evaluator checks pass. [Hosted CI run 35124116097](https://github.com/CampusCommander/campus-commander/actions/runs/35124116097) passed all seven jobs.
The run tested commit `52a14cb1abf3626e90d817dfd389acb9ecf21e6d`.
Real PostgreSQL verified migration retries, preserved principals, restricted runtime roles, explicit administrator confirmation, and atomic security events.
Phase 2 packaged authentication and Phase 3 source authentication passed with real PostgreSQL, Redis, and two API replicas.
[Retained Phase 3 evidence](../../deployment/evidence/CC-45-phase-3-authorization.json) records the exact revision and qualification limits.
The local environment has no running Docker engine.
UI rules UI-01, UI-02, UI-06, UI-08, UI-09, and UI-10 apply to the retained sign-in and Diagnostics workflows.
No new page or control belongs to this contract change. The integration suite rechecked those workflows in both phases.
Release acceptance, live Google qualification, and a screen-reader walkthrough remain separate evidence.
