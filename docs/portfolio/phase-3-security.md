# Phase 3 security qualification

Owner: CC-55. Status: implementation and qualification in progress.
Baseline: `3e64ce5`, the CC-52 integration branch. This record does not establish release acceptance.

## Boundary and demonstration

The qualification covers the public edge, browser session, API, restricted database role, and retained evidence.
The demonstration sends unauthorized requests and injects audit failures before checking state and durable evidence.
Existing feature fixtures supply resource-specific checks. The route inventory adds uniform browser-boundary checks across all 32 protected Phase 3 routes.
No schema migration or product UI change belongs to this increment.

Run `npm exec -- nx run api-e2e:phase3-auth-integration` for source qualification.
The full CI workflow builds images and repeats that target with `CC_AUTH_PACKAGED_IMAGES=true`.
Run `npm exec -- nx run deployment:postgres-integration` for real database role, concurrency, and audit-failure checks.
Local static checks use `npm exec -- nx run api-e2e:lint` and `npm exec -- nx format:check --base=9052ba1`.
Source qualification passed at `e036c9e`. Packaged qualification remains pending.

## Shared enforcement

Every protected route below uses `AuthGuard`.
The guard authenticates the cookie against Redis and current PostgreSQL principal state before entering the handler.
The enabled principal and permission version must match the current session.
Every protected POST also requires the configured Origin, matching CSRF token, and JSON content type.
The public edge admits exact routes, methods, and bounded bodies. It does not replace API authorization.

Database functions repeat actor, version, and scope checks under their authority locks.
Platform grants cover narrower resources according to the shared action matrix. A district grant covers only its confirmed customer.
School grants retain stable customer and school IDs. Fresh references cannot expand the approved school scope automatically.
Read projections exclude credential envelopes. Receipt and audit projections use their own scope checks.

The following tables state required policy. Existing fixture names identify evidence owners, not a new passing result.
Paths start at the public origin. `:id` identifies one resource, principal, candidate, review, or receipt.

## Customer routes

| Method and path                  | Action and scope                     | Additional checks                                                            | Evidence owner                                          |
| -------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| GET `/api/customer`              | `customer:read`, confirmed district  | Current version, confirmed customer projection                               | `api-e2e/customer-settings.mjs`                         |
| GET `/api/customer/receipts/:id` | `customer:read`, confirmed district  | Durable receipt lookup, missing receipt returns 404                          | `api-e2e/customer-settings.mjs`                         |
| POST `/api/customer/settings`    | `customer:write`, confirmed district | Exact customer and revision, idempotent request ID, atomic receipt and audit | `deployment/postgres/customer-settings.integration.mjs` |

## Platform access routes

| Method and path                        | Action and scope                  | Additional checks                                                                                   | Evidence owner                                        |
| -------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| GET `/api/platform-users`              | `platform-users:read`, platform   | Bounded page and total                                                                              | `api-e2e/platform-access-browser.mjs`                 |
| GET `/api/platform-users/:id`          | `platform-users:read`, platform   | Stable identity, no other user's preferences                                                        | `api-e2e/platform-access-browser.mjs`                 |
| GET `/api/platform-users/:id/receipts` | `platform-users:read`, platform   | Bounded immutable receipt history                                                                   | `api-e2e/platform-access-browser.mjs`                 |
| POST `/api/platform-users/:id/review`  | `platform-users:manage`, platform | Existing and proposed delegation ceiling, target version, verified resources                        | `deployment/postgres/platform-access.integration.mjs` |
| POST `/api/platform-users/:id/access`  | `platform-users:manage`, platform | Actor and target versions, last administrator, exact invitations and school revisions, atomic audit | `deployment/postgres/school-grants.integration.mjs`   |

## Invitation routes

| Method and path                          | Action and scope                  | Additional checks                                                                            | Evidence owner                                    |
| ---------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| GET `/api/auth/invitations`              | `platform-users:read`, platform   | Safe projection without invitation secret                                                    | `api-e2e/invitations-browser.mjs`                 |
| POST `/api/auth/invitations`             | `platform-users:invite`, platform | Verified scope and delegation ceiling, bounded invitation creation                           | `deployment/postgres/invitations.integration.mjs` |
| POST `/api/auth/invitations/:id/confirm` | `platform-users:invite`, platform | Exact pending identity and version, current inviter authority, transactional grant and audit | `deployment/postgres/invitations.integration.mjs` |
| POST `/api/auth/invitations/:id/revoke`  | `platform-users:invite`, platform | Current authority and invitation version, atomic revocation and audit                        | `deployment/postgres/invitations.integration.mjs` |

Two recipient routes operate before a platform session exists.
POST `/api/auth/invitations/redeem` requires the configured Origin, JSON, an opaque token, and bounded claim attempts.
GET `/api/auth/invitations/status` requires the browser-bound invitation cookie. It returns only that recipient's safe state.
OIDC verification binds the claimed invitation to the login transaction and browser. It does not grant access before administrator confirmation.
`api-e2e/invitations-browser.mjs` owns cross-browser, identity, replay, expired, and revoked invitation checks.

## Google connection routes

| Method and path                                         | Action and scope                                                 | Additional checks                                                                       | Evidence owner                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| GET `/api/google-connection`                            | `connection:read`, confirmed district or platform before binding | Safe observation, no private envelope                                                   | `api-e2e/google-connection-api.mjs`                     |
| GET `/api/google-connection/health`                     | `connection:read`, confirmed district                            | Capability projection, freshness and generation                                         | `api-e2e/google-health.mjs`                             |
| POST `/api/google-connection/check`                     | `connection:diagnose`, confirmed district                        | Exact customer and generation, bounded admission, current authority after provider work | `api-e2e/google-connection-worker.mjs`                  |
| POST `/api/google-connection/health/check`              | `connection:diagnose`, confirmed district                        | Exact capability, customer and generation, bounded lease, publication authority         | `api-e2e/google-health.mjs`                             |
| GET `/api/google-connection/candidates/:id`             | `connection:manage`, platform                                    | Candidate actor, version, browser binding, expiry, safe projection                      | `api-e2e/google-lifecycle.mjs`                          |
| POST `/api/google-connection/candidates`                | `connection:manage`, platform                                    | Strict service-account input, protected storage, candidate limit, provider verification | `api-e2e/google-connection-api.mjs`                     |
| POST `/api/google-connection/candidates/:id/confirm`    | `connection:manage`, platform                                    | Exact reviewed customer and candidate, current actor, one customer binding              | `deployment/postgres/google-connection.integration.mjs` |
| GET `/api/google-connection/credentials`                | `connection:manage`, platform                                    | Management projection omits private material                                            | `api-e2e/google-lifecycle.mjs`                          |
| POST `/api/google-connection/replacements`              | `connection:manage`, platform                                    | Expected generation, candidate binding, same customer, bounded verification             | `api-e2e/google-lifecycle.mjs`                          |
| POST `/api/google-connection/replacements/:id/activate` | `connection:manage`, platform                                    | Exact candidate, actor and generation, atomic replacement and audit                     | `deployment/postgres/google-lifecycle.integration.mjs`  |
| POST `/api/google-connection/credentials/rotate-key`    | `connection:manage`, platform                                    | Reviewed key and generation, authenticated envelope, atomic rotation and audit          | `deployment/postgres/google-lifecycle.integration.mjs`  |
| POST `/api/google-connection/credentials/disconnect`    | `connection:manage`, platform                                    | Exact credential and generation, local erasure and atomic audit                         | `deployment/postgres/google-lifecycle.integration.mjs`  |

Public API projections do not expose the database functions' private credential results.
Worker token leases have no public HTTP route. Restricted database functions control generation, lease ownership, publication, and token use.
`deployment/postgres/google-token.integration.mjs` and `api-e2e/google-connection-worker.mjs` own those checks.

## School routes

| Method and path                         | Action and scope                                           | Additional checks                                                                                     | Evidence owner                                           |
| --------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| GET `/api/schools`                      | `schools:read`, each permitted school                      | Same policy filters page and total. No grant returns an empty authorized result.                      | `api-e2e/school-definitions.mjs`                         |
| GET `/api/schools/:id`                  | `schools:read`, selected school                            | Unavailable or unauthorized identity returns 404                                                      | `api-e2e/school-definitions.mjs`                         |
| GET `/api/schools/:id/audit`            | `schools:read` and `security-events:read`, selected school | Same identity boundary, bounded audit page                                                            | `api-e2e/school-definitions.mjs`                         |
| GET `/api/schools/reviews/:id`          | `schools:manage`, confirmed district                       | Review belongs to current actor. Missing or other actor's review returns 404.                         | `deployment/postgres/school-definitions.integration.mjs` |
| POST `/api/schools/reviews`             | `schools:manage`, confirmed district                       | Fresh exact references, explicit rules, stable IDs, current definition, bounded pending reviews       | `deployment/postgres/school-definitions.integration.mjs` |
| POST `/api/schools/reviews/:id/confirm` | `schools:manage`, confirmed district                       | Review ownership and versions, exact affected principals and invitations, atomic definition and audit | `deployment/postgres/school-definitions.integration.mjs` |
| GET `/api/schools/references`           | `schools:manage`, confirmed district                       | Safe reference projection and server freshness                                                        | `api-e2e/school-references.mjs`                          |
| POST `/api/schools/references/refresh`  | `schools:manage`, confirmed district                       | Exact customer and generation, bounded lease, current actor after provider work                       | `api-e2e/school-references.mjs`                          |

## Earlier-phase and operational surfaces

| Surface                                                                 | Policy and evidence owner                                                                                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| GET `/api/auth/session`                                                 | Current enabled principal, permission version, and own safe session. `api-e2e/auth.test.mjs`.                                      |
| POST `/api/auth/preferences`                                            | Same session and browser checks. Own preferences only. Transactional version check and audit. `api-e2e/access-revocation-api.mjs`. |
| POST `/api/auth/logout`                                                 | Same session and browser checks. Server session revocation. `api-e2e/auth.test.mjs`.                                               |
| GET `/api/diagnostics`                                                  | Current `diagnostics:read` installation permission. No district or school grant implies this permission. `api-e2e/auth.test.mjs`.  |
| POST `/api/diagnostics/:operation`                                      | Current `diagnostics:run` installation permission, browser checks, allowed operation, bounded admission. `api-e2e/auth.test.mjs`.  |
| GET `/api/auth/login` and `/api/auth/callback`                          | OIDC transaction, state, nonce, PKCE, issuer, audience, browser binding, expiry, and one-use completion. `api-e2e/auth.test.mjs`.  |
| POST `/api/auth/enrollment/start` and GET `/api/auth/enrollment/status` | Browser Origin and JSON for start. Pairing secret and browser-bound status. `api-e2e/auth.test.mjs`.                               |
| POST `/api/auth/enrollment/operator`                                    | Operator credential, no browser Origin, JSON, explicit enrollment action. `api-e2e/auth.test.mjs`.                                 |
| GET `/api/bootstrap/verify` and `/api/startup`                          | Verified installation operator credential. Separate from application grants. `api-e2e/auth.test.mjs`.                              |
| GET `/api/application`                                                  | Public phase, version, build, and authentication-configured boolean. No customer or credential data.                               |
| GET `/health`, `/health/live`, `/health/ready`, and `/api`              | Internal probes or base API response. The Phase 3 public edge does not expose these as application features.                       |
| Client pages and shared shell                                           | Navigation reflects actions, but every read and write uses the API policy above. No browser grant establishes authorization.       |

## Qualification inventory and remaining work

`api-e2e/phase3-route-security.mjs` sends every protected Phase 3 route without a session.
It also sends each POST with missing CSRF, wrong Origin, and wrong content type.
Every response must deny access, disable caching, omit permissive CORS, and exclude the supplied session and CSRF values.
Each browser-boundary denial must retain its correlated `browser-security` audit event for the expected actor.
A control request uses valid browser checks, empty input, and the grantless principal.
That control must fail input or action checks without recording a browser-security denial.
These audit assertions distinguish browser enforcement from an unrelated permission failure.
The report retains route templates, boundary names, status codes, revision, timing, and environment. It excludes response bodies and secret values.
This guard check does not prove the handler's action or resource policy. Valid-session resource checks remain separate.

The database fixtures already contain audit-failure injection for settings, invitations, grants, school definitions, replacement, rotation, and disconnect.
Their existence does not establish complete CC-55 qualification. Review all mutation branches before closing the criterion.
The final evidence inventory must bind every result to the selected revision and record applicability for retained earlier results.

Remaining checks:

- Reconcile all public routes against this inventory after each controller change.
- Complete packaged route checks and inspect the resulting report.
- Verify audit rollback for each mutation branch, including candidate staging and reference publication.
- Reconcile cross-customer, cross-school, guessed-identity, count, list, detail, and audit denial evidence.
- Scan final browser, application, provider, database, and release evidence for seeded secret values and sensitive provider fields.
- Record unresolved findings with severity and release impact.

CC-54 retains unexplained browser sign-in, credential staging, and invitation navigation failures.
Those failures remain unresolved even when another run passes. Human accessibility evidence remains a separate acceptance gate.
The approved Super Admin fixture does not establish minimum Google privilege, identity replacement, or Education-specific qualification.

## Retained qualification

[Source qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35177978798) passed at `e036c9e`.
The downloaded report records 100 requests across 32 routes.
It includes 32 missing-session denials and 17 probes for each browser check and its valid-browser control.
The [retained report](../../deployment/evidence/CC-55-source-route-security.json) records the exact checks, environment, revision, and timing.
School definition recovery and district and school grant assignment also passed through the real API and PostgreSQL.

Revision `0a89f67` adds candidate audit-failure injection for staging, verification success, verification failure, and expiry.
Each probe requires the exact injected constraint error and unchanged candidate state hashes.
Both review axes report no remaining findings. Five local PostgreSQL contract tests pass.
The PostgreSQL job passed in [full run 35178237363](https://github.com/CampusCommander/campus-commander/actions/runs/35178237363).
The packaged application job remains active in that run. The other six jobs passed.

The earlier CC-52 packaged run `35177847162` failed before school checks during credential lifecycle navigation.
Its credential replacement button did not appear. The cause remains unresolved in CC-54.
The diagnostic fixture now captures that navigation without retrying it.
It records bounded route and error categories, HTTP status, and document state counts without page text or response bodies.
