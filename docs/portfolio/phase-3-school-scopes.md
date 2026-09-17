# Phase 3 school scopes

Owner: [CC-52](https://easton-consulting.atlassian.net/browse/CC-52).
Status: contract design and implementation preparation. Runtime implementation and qualification remain pending.
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
No implementation test has run for this design-only commit.
