# Phase 3 school scopes

Owner: [CC-52](https://easton-consulting.atlassian.net/browse/CC-52).
Status: reference contracts, resolver, provider, persistence, and reference APIs are implemented.
School definition persistence and APIs are implemented. Grant assignment, browser controls, and complete qualification remain pending.
This slice follows CC-48 and CC-51 through the CC-49 stack.

## Outcome and language

A platform administrator defines a school scope and assigns an existing platform user as a school administrator or scoped viewer.
A school scope belongs to the confirmed customer and has its own stable application ID.
Several explicit OU references can represent one school.
The school remains distinct from an OU, a domain, and a Google organizational hierarchy.
The [glossary](../../CONTEXT.md) defines the new terms.

The demonstration creates two school scopes from controlled OU references.
A school operator can read their school definition and its authorized audit history.
Direct requests, lists, counts, and audit queries deny the other school.
A path rename preserves stable OU identity. A hierarchy change cannot expand approved access automatically.
Synthetic resource checks prove these boundaries without claiming Phase 4 inventory enforcement.

## Reference capability

Use the confirmed customer ID with `orgunits.list` and `type=all_including_parent`.
The provider returns OU identities, names, paths, and parent references.
Request only `admin.directory.orgunit.readonly` for this optional capability.
The [list method](https://developers.google.com/workspace/admin/directory/reference/rest/v1/orgunits/list) documents the response and read-only scope.
The [OU resource](https://developers.google.com/workspace/admin/directory/reference/rest/v1/orgunits) distinguishes identities, paths, and parent references.
These method facts were checked on 2026-09-17.

The earlier CC-44 controlled read passed for the approved customer.
A CC-52 read with `all_including_parent` returned HTTP 200 with the exact read-only OU scope.
The response contained three OUs, including one root with a stable ID and name.
The root omitted parent fields. Both non-root OUs included stable parent IDs.
The [sanitized response-shape evidence](../../deployment/evidence/CC-52-ou-root-proof.json) records counts and field presence only.
That proof does not qualify the production selector, scope resolver, or least-privilege Google role.
Keep the selector unavailable until the production transport, reference validation, and capability health tests pass.
Do not add an OU management page or Google mutations.
Retain the existing credential-generation checks and separate application sign-in configuration.

A complete reference observation records its customer, credential generation, observation time, and revision.
Reject duplicate identities, cycles, unresolved parents, malformed paths, and inconsistent parent references.
Treat the provider root explicitly. Do not infer a root identity from a path or email suffix.
Bound observation size and network time. Reject oversized or incomplete observations without replacing the last valid observation.
Retain failed refresh evidence separately from the last successful reference observation.

## Inclusion and hierarchy rules

Each inclusion or exclusion names a stable OU identity and an explicit descendants flag.
Union all inclusions. Subtract all exclusions. Exclusions take precedence within that school.
Require at least one inclusion and a nonempty reviewed result.
Reject duplicate or contradictory references and cross-customer references before preview.
Overlapping school scopes remain distinct. A grant to one school never grants access to another school's definition or audit history.
A resource can belong to both schools only when both definitions explicitly include its stable OU identity.

Preview computes a sorted effective OU set from one complete, fresh reference observation.
Confirmation freezes that set as the approved OU set.
New descendants and reparented OUs do not join that approved set automatically.
A later current evaluation intersects the approved set with the current inclusion-minus-exclusion result.
An operator must preview and confirm any expansion.
Path-only renames update display context without changing approved identity membership.
Moved-out or excluded OUs leave the effective set.

A reference observation expires after ten minutes for confirmation and effective resource evaluation.
Any missing selected reference, invalid hierarchy, failed verification, or stale observation denies effective resource evaluation for the school.
Preserve its last valid definition and approved set for recovery.
Do not widen to a parent OU, a district, or the last observed path.
Fresh reference recovery restores only the intersection with the approved set.
The UI shows definition state, observation time, stale state, and any required reconfirmation.

## Authority, persistence, and audit

School-definition management requires current `schools:manage` authority for the confirmed customer.
Existing platform and district grant semantics remain authoritative.
Scoped school administrators and viewers receive only the existing explicit actions supported by their presets.
They do not receive grant-management authority or future inventory actions.
Grant assignment retains platform `platform-users:manage`, delegation ceilings, current permission versions, and last-administrator protection.

A new school grant requires a current verified school definition.
An existing school grant permits authorized reads of the saved school definition during reference failure.
This recovery access never authorizes an effective resource evaluation from stale references.
Lists, authorized totals, details, and audit history use the same school ID and customer authorization predicate.
Do not expose another school's name or audit count through an unauthorized direct request.

A migration adds reference observations, versioned school definitions, and durable school-change receipts.
Preview binds actor, permission version, customer, school revision, reference revision, exact rules, and approved OU identities.
Confirmation checks those values inside the shared authority transaction lock.
School changes, affected permission-version increments, receipts, and security events commit together.
Audit failure rolls back all effects. Concurrent or stale confirmation cannot overwrite a newer definition.
Runtime roles receive narrow operations and no unrestricted school or grant table writes.

## Implementation sequence and evidence

1. Add shared reference and school-definition contracts, a pure resolver, and synthetic boundary tests.
2. Add optional OU provider reads and qualification without changing mandatory customer and domain checks.
3. Add the migration, authorized persistence operations, receipts, and transactional permission invalidation.
4. Add list, detail, reference refresh, preview, and confirmation APIs with current authority and CSRF checks.
5. Extend verified school grant assignment through the existing platform access review.
6. Add school forms and a focused OU reference picker using FORM-01, TREE-01, and UI-01 through UI-10.
7. Qualify browser recovery, scope changes, cross-school denials, audit rollback, and grant effects through the real API and PostgreSQL.
8. Record hosted source, packaged, deployment-profile, and human acceptance limits separately.

Use Nx contract tests, API and frontend builds and lint, PostgreSQL integration, and Chromium browser qualification.
The selector needs both themes, keyboard focus, accessible hierarchy navigation, zoom, and narrow-layout evidence.
Human screen-reader qualification remains a separate gate.
The shared contract test and lint targets pass through `2ef7717`.
Six resolver cases cover exclusions, stale and invalid references, hierarchy changes, stable IDs, and approved-set intersection.
API, frontend, and worker builds passed after the new exports.
Standards and specification review have no remaining findings in this bounded contract scope.
The specification correction reuses the existing stable Google customer-ID schema and rejects customer aliases.
These checks do not qualify school APIs, persistence, grant changes, or browser behavior.

## Optional provider reader

Revision `c227d90` adds `GoogleCustomerVerifier.readSchoolReferences`.
It requests only the OU read-only scope and verifies the exact issued scope and token lifetime.
The read uses the fixed customer endpoint and returns a bounded, validated complete hierarchy.
A shared exact-scope token helper also supports existing targeted health checks.
The reader does not alter the mandatory customer token profile or enable the school selector.

Seven provider, API, and worker test, lint, and build targets pass.
Four new provider cases cover isolated scopes, extra-scope rejection, classified authorization failures, and invalid hierarchies.
Standards and specification reviews report no remaining findings in this increment.
The [direct provider proof](../../deployment/evidence/CC-52-provider-live-proof.json) passed against the approved customer at `c227d90`.
It returned three validated OU references, including the root, with the exact read-only scope.
The reference persistence increment now checks current authority and credential generation before publication.

## Reference persistence and API

Migration 012 stores one complete reference observation and separate refresh failure evidence for the confirmed customer.
Refresh uses a bounded lease and a shared rate limit across replicas.
The database validates the complete hierarchy and assigns the publication revision and observation time.
Failed refresh retains the prior observation but denies freshness.
Audit failure rolls back publication and preserves the pending lease.
Retired credential generations and changed actor permission versions cannot publish results.

The PostgreSQL integration job passed at `3d90adc` in [run 35171919312](https://github.com/CampusCommander/campus-commander/actions/runs/35171919312).
The fixture uses a real credential disconnect for retired-generation checks.
An earlier fixture incremented the connection generation without a matching credential and failed its foreign-key constraint.
Revision `8902fc2` corrected that fixture. Both review axes have no remaining persistence findings.

`GET /api/schools/references` requires current school-management authority and returns no credential material.
`POST /api/schools/references/refresh` also requires the current customer, credential generation, browser origin, and CSRF token.
Refresh rechecks the session after the Google read.
The public edge exposes these exact methods only in Phase 3 and limits refresh requests to 4 KiB.
Reference API review found missing public-edge routes. Revision `304738c` added those routes and regression checks.
Contract tests, API lint and build, and bootstrap tests pass. Both review axes report no remaining findings.
Hosted source and packaged API qualification remain pending for the corrected edge revision.

The earlier full run at `84d8d39` also failed during packaged login with `ERR_NETWORK_CHANGED`.
That browser failure preceded the school checks. Its cause remains unresolved.
The next runs retain the existing bounded credential-staging diagnostics from CC-49.

## Reviewed school definitions

Migration 013 stores school definitions and durable previews with confirmation receipts.
Preview freezes the rules, approved IDs, school revision, reference revision, actor version, affected principal versions, and pending invitation IDs.
Confirmation checks that snapshot inside the shared authority transaction lock.
The same transaction saves the definition, increments affected permission versions, revokes reviewed invitations, and retains the school audit event.
Audit failure rolls back all effects. Repeated confirmation returns the existing receipt.
Existing school operators can read their saved definition during reference failures, but effective resource access remains unavailable.

Seven PostgreSQL cases cover receipts, scoped list/detail/audit denial, approved-set intersection, stale references, transactional rollback, review conflicts, and invitation revocation.
The PostgreSQL integration job passed at `5fc2b47` in [run 35172788270](https://github.com/CampusCommander/campus-commander/actions/runs/35172788270).
The first review found missing invitation revocation. Revision `5fc2b47` corrected it and added regression coverage.
Both review axes now report no remaining definition persistence findings.

Revision `581b194` adds definition list, detail, audit, preview, confirmation, and receipt APIs.
The public edge restricts exact Phase 3 routes and methods.
Preview accepts up to 64 KiB for explicit inclusion and exclusion rules. Confirmation retains the 4 KiB limit.
Local contract tests, API lint and build, and bootstrap checks pass. Both API review axes report no remaining findings.
Hosted definition API qualification remains pending.

The packaged reference API run at `304738c` reached its authority-change assertion and returned the correct 401 `access-changed` response.
Revision `1b7a916` corrected the fixture, which expected 403.
Other source runs failed during browser login before school checks.
Revision `9e3f7e0` captures sanitized request and application error categories without retrying failed login.
CC-54 retains those unresolved sign-in failures.

## Remaining grant integration

School previews must retain the exact rules, approved IDs, school revision, reference revision, actor version, and affected principal versions.
Confirmation must compare that retained state inside the shared authority transaction lock.
The receipt must permit recovery after an interrupted response without applying the change twice.
School changes must preserve the approved set until a new preview and confirmation explicitly replace it.

Separate school existence checks from freshness checks for grant changes.
Require fresh verified scope only for new school grants.
Permit removal of existing school grants when reference refresh fails or expires.
Otherwise, a failed Google read would prevent local access revocation.

Platform access review must also retain the revisions of all proposed school grants.
Confirmation must reject a changed school definition even when the target principal does not yet hold that school grant.
Existing target permission-version checks alone do not detect that case.
