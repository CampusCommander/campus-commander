# Phase 3 Jira tasks

Status: APPROVED by the owner on 2026-09-16. Jira publication and verification are complete. CC-44 implements the owner-selected DWD credential profile.

This backlog implements the [Phase 3 plan](phase-3-plan.md).
The [structured manifest](phase-3-jira-tasks.json) supplies the same tasks, criteria, dependencies, and publication fields.
Epic [CC-42](https://easton-consulting.atlassian.net/browse/CC-42) contains eighteen tasks and 29 verified Blocks links.
Stable planning IDs map to verified Jira keys in the manifest. The epic and CC-44 are In Progress. Status fields in the manifest retain their last verified observation.

A timed-out request created [CC-43](https://easton-consulting.atlassian.net/browse/CC-43) as a delayed duplicate.
CC-43 is closed, has no epic parent, and links to canonical task CC-44.
This administrative closure does not complete implementation.

The owner selected service-account DWD on 2026-09-16. The [credential decision](phase-3-google-credentials.md) records the revised gates.

## Approved breakdown

1. **P3-T01: Prove unattended Google access with a controlled customer.** Blocked by: none internally. Stories: S01, S02, S04.
2. **P3-T02: Extend authorization contracts while preserving existing sign-in.** Blocked by: none internally. Stories: S06, S07.
3. **P3-T03: Connect and confirm one Google customer account.** Blocked by: P3-T01, P3-T02. Stories: S01, S02.
4. **P3-T04: Save customer settings and resume interrupted onboarding.** Blocked by: P3-T03. Stories: S03, S04.
5. **P3-T05: Explain capability authorization and Google connection health.** Blocked by: P3-T04. Stories: S02, S04.
6. **P3-T06: Replace Google credentials and rotate encryption keys.** Blocked by: P3-T05. Stories: S01, S08.
7. **P3-T07: Invite and confirm a platform user without mandatory email.** Blocked by: P3-T02. Stories: S05.
8. **P3-T08: Manage explicit platform and district permission grants.** Blocked by: P3-T07. Stories: S06.
9. **P3-T09: Define school scopes and assign scoped platform access.** Blocked by: P3-T05, P3-T08. Stories: S06.
10. **P3-T10: Revoke platform access across active browsers and replicas.** Blocked by: P3-T09. Stories: S07.
11. **P3-T11: Qualify complete Phase 3 browser and accessibility workflows.** Blocked by: P3-T06, P3-T10. Stories: S03, S04, S05, S06, S07, S08, S09.
12. **P3-T12: Qualify Phase 3 authorization, audit, and redaction boundaries.** Blocked by: P3-T06, P3-T10. Stories: S01, S05, S06, S07, S08.
13. **P3-T13: Restore customer configuration and delegated access in isolation.** Blocked by: P3-T06, P3-T10. Stories: S08.
14. **P3-T14: Qualify the Phase 3 all-Docker installation and upgrade.** Blocked by: P3-T11, P3-T12, P3-T13. Stories: S10.
15. **P3-T15: Qualify Phase 3 with district services and distributed workers.** Blocked by: P3-T11, P3-T12, P3-T13. Stories: S10.
16. **P3-T16: Qualify Phase 3 on Kubernetes with shared authorization state.** Blocked by: P3-T11, P3-T12, P3-T13. Stories: S10.
17. **P3-T17: Publish the qualified Phase 3 release and operator procedures.** Blocked by: P3-T14, P3-T15, P3-T16. Stories: S10.
18. **P3-T18: Accept Phase 3 and reconcile Git, Jira, and portfolio evidence.** Blocked by: P3-T17. Stories: S01, S02, S03, S04, S05, S06, S07, S08, S09, S10.

The owner approved the task sizes, dependency relationships, and proposed breakdown before publication.
T01 also requires controlled Google inputs. T15 and T16 require declared deployment fixtures. T18 requires operator participation.

## Epic

**Phase 3 — Onboarding, customer settings, and platform users**

Jira epic: [CC-42](https://easton-consulting.atlassian.net/browse/CC-42).

Connect one Google customer account, preserve customer settings, and delegate audited Campus Commander access across all three deployment modes.

- [ ] Qualify unattended background authorization separately from application sign-in.
- [ ] Bind one stable customer ID and supported domains without automatic customer switching.
- [ ] Preserve settings and onboarding progress across browser and service restarts.
- [ ] Request only enabled capability scopes and distinguish approval, privilege, credential, quota, and network states.
- [ ] Deliver invitation-only platform access with explicit platform, district, school, and viewer grants.
- [ ] Prove revocation, credential replacement, audit integrity, and isolated recovery.
- [ ] Qualify complete browser workflows and all three deployment profiles against the delivered release.
- [ ] Record the owner acceptance decision and reconcile Git, Jira, and portfolio evidence.

## Task details

### P3-T01 — Prove unattended Google access with a controlled customer

Owner role: Connection lead. Relative size: L. Stories: S01, S02, S04.
Packages: P3.1. Jira key: [CC-44](https://easton-consulting.atlassian.net/browse/CC-44).

An operator authorizes a dedicated test identity and demonstrates unattended customer reads after browser closure, process restart, renewal, and credential replacement.

Acceptance criteria:

- [ ] Record fixture authorization, exact library versions, customer identity, delegated Google roles, service-account identity, DWD scopes, and test environment.
- [ ] Prove customer and domain reads with minimum verified scopes, including primary, secondary, and alias-domain coverage.
- [ ] Classify historical user and device proof rows as separate authorized experiments. Do not enable them in ordinary Phase 3 onboarding.
- [ ] Use the Google authentication library. Verify delegated subject, signed token exchange, exact granted scopes, missing delegation, and partial authorization.
- [ ] Prove browser-independent access, process restart, access-token reuse, signed token renewal, DWD or key revocation, and same-customer identity replacement.
- [ ] Reject a wrong customer before changing stored ownership. Record unavailable live fixture cases and equivalent simulator coverage separately.
- [ ] Prove encrypted credential recovery with an independently restored key. Missing or incorrect keys must fail without exposing secrets.
- [ ] Record the credential profile decision and every passed, failed, or not-run case before dependent onboarding implementation.

Blocked by: none within this backlog.
External prerequisite: Owner-authorized controlled Workspace customer, delegated identity, service account, DWD scopes, and protected credential-file path.

Evidence:

- Sanitized controlled-account capability report and exact commands.
- Simulator denial and concurrency results.
- Credential profile decision with explicit missing-fixture limits.

Demonstration: Authorize DWD once, restart the consumer without a browser session, renew access, and read the same customer's identity.

UI rules: not applicable to a new product surface. Retain applicable operational and security checks.

### P3-T02 — Extend authorization contracts while preserving existing sign-in

Owner role: Application security lead. Relative size: L. Stories: S06, S07.
Packages: P1.1, P1.2, P9.1. Jira key: [CC-45](https://easton-consulting.atlassian.net/browse/CC-45).

An existing administrator retains sign-in and Diagnostics while the application gains explicit Phase 3 permission, configuration, and migration contracts.

Acceptance criteria:

- [ ] Record the action/resource grant matrix, preset boundaries, invitation identity policy, school-scope semantics, and privileged-change policy.
- [ ] Extend phase metadata, runtime schemas, installer configuration, and release validation to recognize phase 3 consistently.
- [ ] Add forward migrations for grants and required security-event categories without rewriting existing migration checksums.
- [ ] Preserve existing identity and Diagnostics permissions. Require explicit operator confirmation before assigning a new platform-administrator preset.
- [ ] Provide a shared authorization evaluator with deny-by-default behavior and consistent server and client capability responses.
- [ ] Restrict runtime grant changes to controlled database operations. Preserve installer-only migrations and append-only security evidence.
- [ ] Prove Phase 2 sign-in, session restoration, logout, Diagnostics, migration retry, and unauthorized-request behavior after the upgrade.
- [ ] Document module ownership and the existing-runtime compatibility boundary before dependent slices merge.

Blocked by: none within this backlog.

Evidence:

- Reviewed grant and invitation policy matrices.
- Real PostgreSQL migration and role-denial results.
- Existing authentication and Diagnostics integration results.

Demonstration: Upgrade an existing installation, sign in, run Diagnostics, and deny a Phase 3 action without its explicit grant.

UI rules: UI-01, UI-02, UI-06, UI-08, UI-09, UI-10. Record actual verification and justified exclusions.

### P3-T03 — Connect and confirm one Google customer account

Owner role: Connection lead. Relative size: L. Stories: S01, S02.
Packages: P3.1, P3.2, P9.1. Jira key: [CC-46](https://easton-consulting.atlassian.net/browse/CC-46).

An authorized platform administrator connects the background Google identity, reviews the resolved customer, and confirms the installation binding.

Acceptance criteria:

- [ ] Reuse administrator enrollment and keep the sign-in web client separate. Import and validate the background service account and delegated subject.
- [ ] Validate the credential staging transaction and current administrator authority. Reject replay, stale permission versions, CSRF, and cross-browser substitution.
- [ ] Encrypt candidate service-account credentials with an external versioned key. Never return tokens or private keys to the browser.
- [ ] Display the resolved stable customer ID and domain observations before explicit confirmation.
- [ ] Atomically bind one customer and activate its credential generation. Reject mismatches and concurrent competing first connections.
- [ ] Run a bounded authenticated worker read through the existing service boundary after browser closure and API restart.
- [ ] Coordinate token renewal across replicas and reject late writes from retired credential generations.
- [ ] Record connection changes atomically with security evidence and clean abandoned candidate credentials within a documented bound.

Blocked by: P3-T01, P3-T02.

Evidence:

- Browser-to-provider-to-worker connection report.
- Customer mismatch, staging replay, and two-replica renewal tests.
- Sanitized security-event and credential-storage inspection.

Demonstration: Connect the customer, confirm its identity, close the browser, and complete the same read from an independent worker.

UI rules: UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, UI-08, UI-09, UI-10, FORM-01. Record actual verification and justified exclusions.

### P3-T04 — Save customer settings and resume interrupted onboarding

Owner role: Application experience lead. Relative size: M. Stories: S03, S04.
Packages: P3.2, P6.1. Jira key: [CC-47](https://easton-consulting.atlassian.net/browse/CC-47).

An administrator saves customer settings and resumes observed onboarding progress after browser closure, dependency failure, or service restart.

Acceptance criteria:

- [ ] Define and validate the Phase 3 customer settings allowlist. Keep per-user theme preferences separate from customer settings.
- [ ] Persist confirmed steps and settings revisions in PostgreSQL. Keep short-lived credential staging transactions separate.
- [ ] Restore progress after reload and API restart without repeating completed credential verification or discarding unsaved form input on errors.
- [ ] Handle Redis loss by restarting only the expired authorization transaction while retaining durable business progress.
- [ ] Reject stale concurrent writes with a recoverable conflict response and unchanged confirmed state.
- [ ] Display Google approval and capability verification separately from local setup. Do not simulate inventory progress.
- [ ] Require scoped read/write authority and atomic security evidence for settings changes.
- [ ] Preserve keyboard navigation, focus, field labels, both themes, and clear error recovery throughout the workflow.

Blocked by: P3-T03.

Evidence:

- Interrupted onboarding and concurrent settings browser tests.
- PostgreSQL persistence and audit transaction results.
- Applicable UI rule evidence.

Demonstration: Save settings, interrupt onboarding, restart the API, and resume at the last confirmed step.

UI rules: UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, UI-08, UI-09, UI-10, FORM-01. Record actual verification and justified exclusions.

### P3-T05 — Explain capability authorization and Google connection health

Owner role: Connection lead. Relative size: M. Stories: S02, S04.
Packages: P3.1, P3.3. Jira key: [CC-48](https://easton-consulting.atlassian.net/browse/CC-48).

An authorized operator sees which Phase 3 capabilities are enabled, granted, qualified, and available, then runs a bounded diagnostic or reconnects.

Acceptance criteria:

- [ ] Generate DWD authorization instructions and scope counts from enabled, qualified capability records with checked sources and test evidence.
- [ ] Keep customer and domain reads separate from optional read-only OU references. Exclude later inventory and mutation capabilities.
- [ ] Handle partial DWD authorization without marking unavailable capabilities healthy or repeatedly requesting unrelated scopes.
- [ ] Classify credential, scope, privilege, policy, license, quota, and network failures with explicit recovery actions.
- [ ] Show observation age and preserve last-known results during transient failures without presenting them as current success.
- [ ] Use the same health contract in the shell and Diagnostics. Google failure must not block local sign-in or installer readiness.
- [ ] Bound diagnostic requests, retries, and concurrency. Require current permission and retain sanitized correlation evidence.
- [ ] Verify reconnect and capability recheck after revocation or changed privileges without requiring a full installation reset.

Blocked by: P3-T04.

Evidence:

- Capability registry and generated-scope tests.
- Simulator fault classifications and controlled-account privilege results.
- Browser health, retry, and stale-state evidence.

Demonstration: Remove a required grant, observe a named capability failure, restore authority, and recheck successfully.

UI rules: UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, UI-08, UI-09, UI-10, FORM-01. Record actual verification and justified exclusions.

### P3-T06 — Replace Google credentials and rotate encryption keys

Owner role: Connection security lead. Relative size: L. Stories: S01, S08.
Packages: P3.1, P9.1, P9.3. Jira key: [CC-49](https://easton-consulting.atlassian.net/browse/CC-49).

An authorized administrator replaces the background Google identity or encryption key while preserving customer ownership and recoverable access.

Acceptance criteria:

- [ ] Stage and verify replacements against the existing stable customer ID before atomic activation.
- [ ] Preserve a working credential when replacement verification fails. Reject a different customer without changing ownership.
- [ ] Coordinate replacement and renewal across replicas with credential generations and bounded transition behavior.
- [ ] Prove old generations cannot resume reads or overwrite new material after activation.
- [ ] Rotate encryption keys with versioned ciphertext and an explicit interrupted-rotation recovery procedure.
- [ ] Expose revoked, expired, missing-key, and invalid-client states with actionable recovery while preserving local application access.
- [ ] Document provider revocation scope and prevent background disconnect from silently invalidating application-login configuration.
- [ ] Require current authority and retained security events for replacement, disconnect, key changes, and recovery.

Blocked by: P3-T05.

Evidence:

- Replacement, renewal-race, and retired-generation integration results.
- Interrupted key-rotation and missing-key reports.
- Operator credential replacement and erasure procedure.

Demonstration: Replace the connection identity within the same customer, rotate its key, restart consumers, and deny the retired credential.

UI rules: UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, UI-08, UI-09, UI-10, FORM-01. Record actual verification and justified exclusions.

### P3-T07 — Invite and confirm a platform user without mandatory email

Owner role: Platform access lead. Relative size: L. Stories: S05.
Packages: P9.1, P6.1. Jira key: [CC-50](https://easton-consulting.atlassian.net/browse/CC-50).

A platform administrator creates an invitation, shares its link independently, confirms the intended OIDC identity, and grants bounded application access.

Acceptance criteria:

- [ ] Create invitations through authenticated, authorized browser requests and display a copyable link without requiring SMTP.
- [ ] Store only a token hash with bounded expiry, intended authority, issuer restrictions, and lifecycle state.
- [ ] Bind redemption to verified OIDC issuer and subject. Never grant access from an email suffix or bearer link alone.
- [ ] Require inviter confirmation before an unknown redeemed identity receives grants, according to the reviewed invitation policy.
- [ ] Consume redemption atomically. Deny wrong identity, expired invitations, replay, revoked invitations, and concurrent redemption.
- [ ] Support invitation review, revocation, and replacement without exposing tokens in lists, logs, browser caches, or audit evidence.
- [ ] Recheck inviter authority before activating grants. A revoked inviter cannot complete pending authorization.
- [ ] Record each transition and demonstrate usable sign-in, denial, and recovery in both themes.

Blocked by: P3-T02.

Evidence:

- Real OIDC invitation and administrator-confirmation browser workflow.
- Database redemption race and revocation results.
- Hash storage, redaction, and UI evidence.

Demonstration: Copy an invitation link, redeem it in a separate browser, confirm the identity, and sign in with only its intended access.

UI rules: UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, UI-08, UI-09, UI-10, FORM-01. Record actual verification and justified exclusions.

### P3-T08 — Manage explicit platform and district permission grants

Owner role: Platform access lead. Relative size: M. Stories: S06.
Packages: P9.1, P6.1. Jira key: [CC-51](https://easton-consulting.atlassian.net/browse/CC-51).

A platform administrator reviews platform users and applies explicit platform, district, and viewer presets with visible effective permissions.

Acceptance criteria:

- [ ] Expand presets into reviewed action/resource grants instead of treating preset names as unrestricted roles.
- [ ] Provide authorized list, count, detail, grant, and enable/disable workflows with stable principal identity.
- [ ] Show effective permissions and affected scope before confirming a grant change.
- [ ] Prevent self-escalation and delegation beyond the actor's grant-management authority.
- [ ] Protect the last enabled platform administrator through transactional checks under concurrent changes.
- [ ] Increment permission versions atomically with grant changes and security events.
- [ ] Preserve historical principal IDs, preferences, and events when migrating existing administrators.
- [ ] Verify viewer and district-operator restrictions through direct API requests as well as navigation.

Blocked by: P3-T07.

Evidence:

- Preset-by-action authorization matrix and integration results.
- Concurrent last-administrator and self-escalation denial tests.
- Grant preview, confirmation, and audit evidence.

Demonstration: Grant district access to an invited user and demonstrate denial of platform administration and credential management.

UI rules: UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, UI-08, UI-09, UI-10, FORM-01. Record actual verification and justified exclusions.

### P3-T09 — Define school scopes and assign scoped platform access

Owner role: Scoped access lead. Relative size: L. Stories: S06.
Packages: P9.1, P3.1, P6.1. Jira key: [CC-52](https://easton-consulting.atlassian.net/browse/CC-52).

A platform administrator defines a school scope using stable references and assigns a school operator or scoped viewer.

Acceptance criteria:

- [ ] Represent a school as a district-defined scope with multiple explicit resource references when required.
- [ ] Qualify optional read-only OU reference methods and scopes before exposing the selector. Do not build an OU management page.
- [ ] Use stable OU identities and derived paths. Define overlap, inclusion, exclusion, and hierarchy-change semantics.
- [ ] Deny expansion from missing, stale, unverified, or cross-customer references and preserve the last valid scope definition.
- [ ] Preview effective scope and confirmation consequences before persisting definitions or grants.
- [ ] Apply the same policy to permitted school-definition lists, counts, details, audit views, and direct requests.
- [ ] Demonstrate cross-school denial using controlled references and synthetic resources without claiming Phase 4 inventory enforcement.
- [ ] Invalidate affected permission versions and record scope changes and grant effects transactionally.

Blocked by: P3-T05, P3-T08.

Evidence:

- Approved scope semantics and stable-reference capability report.
- Synthetic cross-school, overlap, stale-reference, and path-change tests.
- School-definition and grant browser evidence.

Demonstration: Assign one school scope, deny access to another school, and preserve identity when an OU path changes.

UI rules: UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, UI-08, UI-09, UI-10, FORM-01, TREE-01. Record actual verification and justified exclusions.

### P3-T10 — Revoke platform access across active browsers and replicas

Owner role: Application security lead. Relative size: M. Stories: S07.
Packages: P9.1, P9.3. Jira key: [CC-53](https://easton-consulting.atlassian.net/browse/CC-53).

An administrator reduces or revokes a platform user's access and sees subsequent protected actions fail across API replicas.

Acceptance criteria:

- [ ] Recheck the current permission version on every protected request and before committing an authorized state change.
- [ ] Revoke affected sessions and pending invitations according to the reviewed policy without relying only on browser state.
- [ ] Handle stale tabs and in-flight forms with explicit access-change responses while preserving recoverable input.
- [ ] Prevent concurrent revocation from allowing later state changes under stale grant versions.
- [ ] Test two API replicas, restored sessions, Redis loss, service restart, and direct requests with guessed resource identifiers.
- [ ] Preserve the last-administrator safeguard and a controlled installation-operator recovery procedure.
- [ ] Record revocation and denied attempts with bounded, secret-free security evidence.
- [ ] Do not affect unrelated platform users or the independently authorized background Google connection.

Blocked by: P3-T09.

Evidence:

- Two-replica revocation and concurrent-write results.
- Browser stale-session and direct-API denial evidence.
- Administrator recovery procedure and test.

Demonstration: Keep the user signed in through two replicas, revoke access, and deny the next protected request through both.

UI rules: UI-01, UI-02, UI-05, UI-06, UI-07, UI-08, UI-09, UI-10, FORM-01. Record actual verification and justified exclusions.

### P3-T11 — Qualify complete Phase 3 browser and accessibility workflows

Owner role: Application quality lead. Relative size: M. Stories: S03, S04, S05, S06, S07, S08, S09.
Packages: P6.1, P9.1, Track 12. Jira key: [CC-54](https://easton-consulting.atlassian.net/browse/CC-54).

An operator completes the combined connection, settings, invitation, scope, revocation, and recovery workflows through the shipped browser application.

Acceptance criteria:

- [ ] Exercise successful workflows and permission, provider, database, Redis, and network failures through real browser requests.
- [ ] Verify resumed onboarding, cross-browser invitations, grant changes, customer context, and consistent Diagnostics results.
- [ ] Record keyboard navigation, focus restoration, screen-reader announcements, contrast, target size, zoom, overflow, and both themes.
- [ ] Verify unavailable inventory, Google entity mutation, and later-phase controls do not appear as working features.
- [ ] Record actual UI rule IDs, component reuse, relevant states, and screenshot or reader evidence.
- [ ] Preserve Phase 2 installer enrollment, login, account, Diagnostics, theme, and logout behavior.
- [ ] Keep automatic accessibility results separate from human usability observations and unresolved defects.

Blocked by: P3-T06, P3-T10.

Evidence:

- Packaged browser integration and accessibility reports.
- Reader utterances, theme screenshots, and manual observations.
- Defect list with exact reproduction steps and affected release.

Demonstration: Complete onboarding and delegate scoped access using keyboard controls, then demonstrate announced failure and recovery.

UI rules: UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, UI-08, UI-09, UI-10, FORM-01, TREE-01. Record actual verification and justified exclusions.

### P3-T12 — Qualify Phase 3 authorization, audit, and redaction boundaries

Owner role: Application security lead. Relative size: L. Stories: S01, S05, S06, S07, S08.
Packages: P9.1, P9.3. Jira key: [CC-55](https://easton-consulting.atlassian.net/browse/CC-55).

A security reviewer verifies every Phase 3 data and write surface against the grant matrix, failure behavior, and retained audit evidence.

Acceptance criteria:

- [ ] Map every implemented endpoint and data surface to its required action, resource scope, and permission-version check.
- [ ] Test cross-customer, cross-school, guessed-identifier, count, list, detail, Diagnostics, and audit-view denial.
- [ ] Prove settings, invitation, grant, scope, and credential mutations commit with their security events or fail together.
- [ ] Inject audit and database failure and prove no successful state change lacks durable evidence.
- [ ] Test restricted database roles, CSRF, origin checks, content types, callback replay, token redaction, and bounded abuse controls.
- [ ] Verify keys, tokens, authorization codes, client secrets, invitation secrets, and sensitive provider responses stay outside public evidence.
- [ ] Record unresolved findings with severity and explicit release impact instead of hiding them behind a passing aggregate.

Blocked by: P3-T06, P3-T10.

Evidence:

- Complete route-to-policy coverage matrix.
- Real database fault and database-role tests.
- Redaction report and resolved or accepted security findings.

Demonstration: Attempt unauthorized direct requests and an audit-write failure, then show unchanged state and the expected denial evidence.

UI rules: not applicable to a new product surface. Retain applicable operational and security checks.

### P3-T13 — Restore customer configuration and delegated access in isolation

Owner role: Operations lead. Relative size: L. Stories: S08.
Packages: P9.3. Jira key: [CC-56](https://easton-consulting.atlassian.net/browse/CC-56).

An installation operator restores Phase 3 customer state and access into an isolated target, recovers keys, and resumes authorized reads.

Acceptance criteria:

- [ ] Inventory customer binding, settings, progress, grants, schools, encrypted credentials, security events, and independent key recovery material.
- [ ] Use the actual backup and restore commands with a stopped or otherwise safely isolated source.
- [ ] Restore into distinct databases, networks, and storage. Verify exact identity, permission, preference, and evidence preservation.
- [ ] Invalidate source sessions, pending authorization transactions, and pending invitations before reopening target access.
- [ ] Require restored-key verification and connection revalidation before background Google reads resume.
- [ ] Demonstrate missing keys, revoked grants, changed Google privileges, and wrong-customer credentials without silent fallback.
- [ ] Measure recovery time and record backup age and environment limits. Do not claim an untested district RPO or RTO.
- [ ] Document interrupted restore, operator access recovery, credential review, and erasure procedures.

Blocked by: P3-T06, P3-T10.

Evidence:

- Isolated operator-CLI restore report with preserved state counts and hashes.
- Old-session, old-invitation, missing-key, and wrong-customer denial results.
- Updated backup, key custody, restore, and erasure procedures.

Demonstration: Restore the installation into an isolated target, reject the source session, recover keys, and sign in with preserved grants.

UI rules: not applicable to a new product surface. Retain applicable operational and security checks.

### P3-T14 — Qualify the Phase 3 all-Docker installation and upgrade

Owner role: Deployment lead. Relative size: L. Stories: S10.
Packages: P9.2, P9.3. Jira key: [CC-57](https://easton-consulting.atlassian.net/browse/CC-57).

An operator installs, resumes, upgrades, restores, and recovers the complete Phase 3 all-Docker release through the delivered installer.

Acceptance criteria:

- [ ] Extend typed configuration, secret mounts, migration execution, version metadata, and image preparation for Phase 3.
- [ ] Run clean installation and repeated resume from an extracted verified candidate bundle.
- [ ] Upgrade from the pinned accepted Phase 2 artifact and preserve principals, preferences, artifacts, installer state, and migration checksums.
- [ ] Execute connection, settings, invitation, grant, school-scope, and revocation workflows after installation and upgrade.
- [ ] Run isolated restore with Phase 3 credentials, keys, grants, and security events and reject old sessions.
- [ ] Verify service restart, low disk, provider outage, stale credentials, stop, update, uninstall, and explicit erasure behavior.
- [ ] Retain five distinct installation, resume, upgrade, restore, and fault reports bound to exact source and image identity.

Blocked by: P3-T11, P3-T12, P3-T13.

Evidence:

- Five all-Docker profile acceptance reports.
- Actual extracted installer commands and image verification results.
- Measured fixture limits and defect disposition.

Demonstration: Install the bundle, upgrade an accepted Phase 2 fixture, restore it separately, and complete the Phase 3 workflow.

UI rules: UI-01, UI-08, UI-09, UI-10, FORM-01. Record actual verification and justified exclusions.

### P3-T15 — Qualify Phase 3 with district services and distributed workers

Owner role: Deployment lead. Relative size: L. Stories: S10.
Packages: P9.2, P9.3, P9.4. Jira key: [CC-58](https://easton-consulting.atlassian.net/browse/CC-58).

A hybrid operator installs and upgrades Phase 3 with external PostgreSQL and Redis, distributed workers, and shared credential and artifact contracts.

Acceptance criteria:

- [ ] Run the actual extracted installer for clean installation, repeated resume, Phase 2 upgrade, and isolated restore.
- [ ] Verify external TLS trust, least-privilege database and Redis access, key projection, and restricted service reachability.
- [ ] Record distinct worker-host placement and shared storage behavior. Distinguish logical nodes from independent physical failure domains.
- [ ] Prove shared sessions, permission revocation, credential generation checks, and renewal behavior across replicas and workers.
- [ ] Inject service, network, certificate, and credential failures and demonstrate bounded recovery without lost settings or audit evidence.
- [ ] Verify operator update, stop, uninstall, retained external resources, and explicit erasure contracts.
- [ ] Retain five profile reports with exact source, images, backup identity, host placement, and measured limits.

Blocked by: P3-T11, P3-T12, P3-T13.
External prerequisite: Declared hybrid worker hosts, TLS service fixtures, and qualified shared storage.

Evidence:

- Five hybrid profile acceptance reports.
- External TLS, distributed renewal, revocation, and shared-storage results.
- District-service responsibilities and recovery limits.

Demonstration: Upgrade the distributed fixture, revoke access across replicas, restore it separately, and repeat customer reads.

UI rules: UI-01, UI-08, UI-09, UI-10, FORM-01. Record actual verification and justified exclusions.

### P3-T16 — Qualify Phase 3 on Kubernetes with shared authorization state

Owner role: Deployment lead. Relative size: L. Stories: S10.
Packages: P9.2, P9.3, P9.4. Jira key: [CC-59](https://easton-consulting.atlassian.net/browse/CC-59).

A Kubernetes operator installs and upgrades Phase 3, replaces pods, and restores customer and authorization state into an isolated target.

Acceptance criteria:

- [ ] Run the actual extracted installer for installation, repeated resume, Phase 2 upgrade, and isolated restore.
- [ ] Apply installer-owned migrations before new application behavior and preserve verified previous state.
- [ ] Project versioned credential keys and provider configuration only into authorized consumers.
- [ ] Verify restricted Google discovery and API egress, browser-trusted TLS, and actual network-policy enforcement where claimed.
- [ ] Prove shared sessions, permission revocation, renewal coordination, pod replacement, worker rescheduling, and retired credential rejection.
- [ ] Use distinct restore namespaces and persistent volumes with source isolation and old-session rejection.
- [ ] Retain five profile reports and explicit storage, CNI, node, physical-host, capacity, and recovery limits.

Blocked by: P3-T11, P3-T12, P3-T13.
External prerequisite: Declared Kubernetes storage, network-policy enforcement, TLS endpoints, and replica placement.

Evidence:

- Five Kubernetes profile acceptance reports.
- Replica, rescheduling, provider-egress, and key-projection checks.
- Verified storage isolation and environment limitations.

Demonstration: Upgrade the cluster, replace an API pod and worker, revoke a user, and verify an isolated restored installation.

UI rules: UI-01, UI-08, UI-09, UI-10, FORM-01. Record actual verification and justified exclusions.

### P3-T17 — Publish the qualified Phase 3 release and operator procedures

Owner role: Release lead. Relative size: L. Stories: S10.
Packages: P9.2, P9.3. Jira key: [CC-60](https://easton-consulting.atlassian.net/browse/CC-60).

An operator downloads one signed Phase 3 release whose manifest binds the delivered installer, images, and completed qualification evidence.

Acceptance criteria:

- [ ] Select a clean committed source revision and rerun applicable checks for any change since candidate qualification.
- [ ] Publish immutable images, signatures, checksums, SBOMs, dependency scans, and a versioned release manifest.
- [ ] Bind all fifteen profile reports and application reports to exact source, image digests, file inventory, and report hashes.
- [ ] Reject missing, failed, stale, or mismatched evidence and distinguish laboratory, profile-qualified, and accepted release states.
- [ ] Independently download and verify signatures, inventory, and installer selection from published artifacts.
- [ ] Publish supported workflows, credential setup, migration, backup, key recovery, rotation, erasure, and known limits.
- [ ] Record exact commands, environments, defects, and applicable UI evidence without converting missing district tests into passed results.

Blocked by: P3-T14, P3-T15, P3-T16.

Evidence:

- Release URL, signed manifest, SBOMs, scans, and qualification inventory.
- Independent download and installer verification.
- Versioned operator procedures and known-limit record.

Demonstration: Download the published bundle independently, verify its identity, and locate the evidence for every supported profile.

UI rules: UI-10. Record actual verification and justified exclusions.

### P3-T18 — Accept Phase 3 and reconcile Git, Jira, and portfolio evidence

Owner role: Product owner and release lead. Relative size: M. Stories: S01, S02, S03, S04, S05, S06, S07, S08, S09, S10.
Packages: P3.1, P3.2, P3.3, P9.1, P9.2, P9.3. Jira key: [CC-61](https://easton-consulting.atlassian.net/browse/CC-61).

The owner reviews the delivered Phase 3 workflows and records an acceptance decision against one exact release.

Acceptance criteria:

- [ ] Audit every Phase 3 source item, shared release criterion, task criterion, and native dependency against retained evidence.
- [ ] Run the prescribed operator workflows and record release identity, environment, results, support interventions, and defects.
- [ ] Record any explicit owner exception with its affected criterion, retained limitation, and support boundary.
- [ ] Link every task to its implementation PR, merged commit, tests, operational procedure, and relevant UI evidence.
- [ ] Reconcile native epic parents and Blocks links with the committed manifest and remove duplicate or stale planning references.
- [ ] Close tasks only after evidence or an explicit acceptance exception resolves their criteria.
- [ ] Complete the epic only after the owner accepts the phase and all child dispositions match that decision.
- [ ] Update portfolio status and provide the Phase 4 handoff without starting entity implementation inside this task.

Blocked by: P3-T17.
External prerequisite: Owner or designated operator participation for final workflow acceptance.

Evidence:

- Criterion-by-criterion acceptance matrix and operator record.
- Verified Jira parent, dependency, and status export.
- Owner decision, release identity, and Phase 4 handoff.

Demonstration: Review the release acceptance matrix and trace each user workflow to its implementation, test evidence, and owner disposition.

UI rules: UI-10. Record actual verification and justified exclusions.
