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
Source qualification passed at `ca9023b`. Packaged qualification last passed at `0a89f67`.

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
- Reconcile future release revisions against the retained source and packaged route reports.
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
All seven jobs passed, including the packaged application and the final all-Docker check.
The downloaded [packaged report](../../deployment/evidence/CC-55-packaged-route-security.json) confirms all 100 route-boundary requests.
The packaged school report also confirms definition recovery and district and school browser grant assignment.

The earlier CC-52 packaged run `35177847162` failed before school checks during credential lifecycle navigation.
Its credential replacement button did not appear. The cause remains unresolved in CC-54.
The diagnostic fixture now captures that navigation without retrying it.
It records bounded route and error categories, HTTP status, and document state counts without page text or response bodies.

The full run qualifies `0a89f67`. Later revision `60481a2` changes failure diagnostics only and passes fixture lint and PR checks.
Final evidence redaction review, complete mutation coverage, isolated recovery, deployment-profile qualification, and owner acceptance remain pending.

## Evidence redaction increment

The qualification registers fixture credentials, provider tokens, private keys, browser secrets, pairing codes, and invitation tokens in memory.
The scanner rejects complete raw values and their JSON, URI, base64, and hexadecimal forms. It also rejects private key headers.
Accessibility reports pass this check before the fixture writes them.
Screenshot checks inspect document content before and after capture. The final scan verifies each screenshot hash.
These checks do not recognize text inside image pixels or detect partial secret values.

After the final browser workflows, the fixture scans JSON reports, checked PNG files, application logs, worker logs, and Kestra logs.
It also scans current audit records and a new support bundle. The report lists file hashes and secret category counts.
The scanner removes rejected artifacts. It does not publish matched values or surrounding text.
Unknown evidence formats fail the scan. Release archives and live district evidence require separate checks.

Eleven local scanner tests pass through `api-e2e:e2e`. Fixture lint also passes.
Hosted source and packaged qualification of this increment remain pending. Failed runs do not establish a completed final scan.

The first review found three gaps: omitted service stderr, unregistered transient browser cookies, and unchecked artifact paths.
The corrected fixture captures both service log streams and registers browser response secrets from context creation.
It also rejects secret-bearing paths without reporting their contents. Regression tests cover each gap.
Synthetic provider failures now include a private diagnostic marker. The final scan rejects that marker from public evidence.
Hosted qualification must verify these corrections before this increment qualifies.

The credential inventory includes the separate Redis qualification operator password and encoded installation operator authorization.
These credentials do not pass through the deployment secret writer. The fixture registers them at creation.
The inventory also covers rotated OIDC and worker credentials, encryption keys, service-account keys, and synthetic provider tokens.
Browser response observation covers transient login, enrollment, invitation, session cookies, and JSON tokens.
The source and packaged reports must contain the Redis operator category before this correction qualifies.

## Audit rollback evidence inventory

The following fixtures inject audit failures into effective mutations. Their assertions cover the listed state boundaries.
Full run `35180100392` passed its PostgreSQL job at `63fca05`. Its application job remained unfinished. The operator canceled the outdated run after the bounded scanner exposed an observation timeout.
Revision `63fca05` requires exact injected errors for settings, health publication, replacement, rotation, and disconnect.

| Mutation                                                                    | Fixture under `deployment/postgres`  | Retained state assertion                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Candidate staging, verification success, verification failure, expiry       | `google-connection.integration.mjs`  | Complete candidate row hashes remain equal.                                                     |
| Customer confirmation                                                       | `google-connection.integration.mjs`  | Customer, active credential, and candidate consumption roll back.                               |
| Settings update                                                             | `customer-settings.integration.mjs`  | Customer settings projection remains equal.                                                     |
| Invitation creation, claim, identity verification, confirmation, revocation | `invitations.integration.mjs`        | Invitation count or status remains unchanged. Failed confirmation creates no principal.         |
| Platform grant change                                                       | `platform-access.integration.mjs`    | Principal projection remains equal. No change receipt exists.                                   |
| School definition confirmation                                              | `school-definitions.integration.mjs` | Definition revision, invitation state, and review application state remain unchanged.           |
| School reference publication                                                | `school-references.integration.mjs`  | Existing observation and failure remain. The lease remains active.                              |
| Capability health publication                                               | `google-health.integration.mjs`      | Capability state remains equal. The lease remains unfinished.                                   |
| Access token renewal                                                        | `google-token.integration.mjs`       | The renewal lease remains pending. A later successful renewal supplies the encrypted token.     |
| Credential replacement, encryption-key rotation, disconnect                 | `google-lifecycle.integration.mjs`   | Credential management projection remains equal. Failed replacement retains the ready candidate. |

This inventory does not establish every branch of each mutation.
Remaining reconciliation includes admission leases, failed publication branches, invitation expiry, and secondary grant or revocation audit events.
Review complete state boundaries and error causes before treating any single projection assertion as complete rollback proof.
The source school fixture separately verifies permitted totals, another school, guessed identities, details, and school audit boundaries.
Its successful report does not replace the remaining cross-resource authorization inventory.

## Open qualification findings

| Finding                                                                                            | Severity          | Release impact                                                                                  |
| -------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| Complete mutation and resource-denial reconciliation remains unfinished.                           | Qualification gap | Blocks CC-55 acceptance.                                                                        |
| The final scanner does not qualify failed runs or release archives.                                | Qualification gap | Requires separate retained-evidence review before release acceptance.                           |
| Earlier intermittent browser failures retain unresolved causes in CC-54.                           | P2                | Blocks declaring the affected workflows qualified solely from a later passing run.              |
| Live proof uses a Super Admin without an approved replacement administrator or Education customer. | Qualification gap | Does not establish minimum privileges, identity replacement, revocation, or Education behavior. |

The scanner review findings concern qualification coverage. They do not demonstrate a production secret disclosure.
Their fixes require passing source and packaged evidence before closure.

Browser response registration has a five-second limit. An unfinished response fails qualification with a fixed diagnostic.
The regression uses a stalled response and a controlled clock. It does not establish the cause of an active hosted run.

## Scanner integration finding

Source run [35180757221](https://github.com/CampusCommander/campus-commander/actions/runs/35180757221) failed at `5951102`.
Browser secret registration exceeded its five-second limit before the first enrollment screenshot.
The retained artifact contains four early accessibility reports. It contains no completed redaction report.
This P2 fixture defect blocks scanner qualification. It does not demonstrate a product credential disclosure.

Earlier source run `35180101953` was superseded while unfinished. Full run `35180100392` was canceled after its six other jobs passed.
Neither unfinished application result qualifies the scanner. The PostgreSQL result still qualifies the stricter audit assertions at `63fca05`.
Revision `ac3e101` adds bounded failure diagnostics with fixed route categories, stages, status codes, and counts.
The report excludes raw URLs, response content, headers, and error messages. It removes a failed screenshot before writing diagnostics.
Source run `35181054132` identified one unfinished body: POST `/api/auth/enrollment/start`, status 201.
The fixture returned that response's status without consuming its body before switching browser profiles.
The fixture now drains the response before switching profiles. Hosted qualification must confirm this correction.
The scanner also registers the local setup listener's `csrf` field.

Source run `35181360064` passed enrollment and later failed with two unreadable response bodies at the diagnostics screenshot.
The scanner now observes JSON tokens after `requestfinished`. It still observes response cookies when response headers arrive.
Interrupted requests retain their observed cookies and increment a separate count. Their incomplete JSON bodies do not establish token coverage.
A regression verifies this distinction. A completed response with an unreadable body still fails qualification.
The scanner does not claim unknown or partial secrets in interrupted response bodies.

Run `35181740936` retained one failed body observation after the completed-request change.
Context closure now drains pending observations before disposing of browser resources. Cleanup still closes resources if observation fails.
Failure diagnostics also retain bounded route and error categories. They exclude the underlying error message.
The scanner removes rejected symlinks before artifact publication. Its regression verifies that the link target remains available.
Hosted qualification must verify these changes. The earlier failed runs remain failed evidence.

Run `35182252598` identified the remaining failure as an unavailable enrollment response body after navigation.
The response sets cookies and returns the sign-in URL. It does not return a JSON token field.
Browser JSON observation now covers successful session reads, invitation creation, and local installer pairing.
Cookie observation still covers every browser response. The synthetic provider registers authorization state, nonce, and PKCE challenge values independently.
This policy avoids reading discarded navigation response bodies. It does not suppress a failed read from a token-producing route.
The fixture regressions verify that navigation cookies remain protected when their response body is unavailable.

## Current scanner qualification

[Source run 35182521120](https://github.com/CampusCommander/campus-commander/actions/runs/35182521120) passed at `ca9023b`.
The [retained scanner report](../../deployment/evidence/CC-55-source-evidence-redaction.json) covers 78 files and 24 screenshot checks.
It checks API, worker, Kestra, audit, and support evidence against 18 registered secret categories.
It includes authorization state, nonce, PKCE challenge, transient cookies, and the separate Redis operator password.
The report counts 34 interrupted browser requests. Their incomplete bodies remain outside JSON token coverage.
The same run passed 100 browser-boundary requests across 32 routes.
Both review axes report no actionable findings in `f31949e...ca9023b`. All 11 scanner regressions pass locally.

Revision `ca9023b` also strengthens four existing database audit probes with exact error codes and injected failure identifiers.
These cover customer confirmation, token renewal, school confirmation, and school reference publication.
Local deployment lint and PostgreSQL contract tests pass. Real database qualification remains pending for these four corrections.
[Full run 35182784565](https://github.com/CampusCommander/campus-commander/actions/runs/35182784565) targets the same revision.
Its packaged scanner and database results remain pending. The earlier failed and canceled runs retain their recorded outcomes.
