# Phase 3 current work plan

Updated: 2026-09-17.

## Owner direction

The owner confirmed that nothing is live and rejected further work on a complicated Phase 2 migration path.
Phases are internal development milestones. They are not product versions or a sequence that users must follow.
Users install the current application from scratch. No incremental live environment exists.
Development test data is disposable. Fixtures and development databases can be recreated when needed.
Existing Phase 2 installation compatibility and development-data preservation are not delivery requirements.
This decision supersedes conflicting upgrade requirements in the September 16 plan and task manifest.
Completed code and evidence remain available. Deferred work is not a passed requirement.

## Delivery order

1. Present the implemented client UI in a runnable build for owner review.
2. Complete and correct the customer connection, settings, invitation, access, and school workflows from that review.
3. Verify fresh installation, sign-in, application workflows, permission boundaries, credential protection, and useful error handling.
4. Deliver the reviewed build with concise installation instructions and known limitations.
5. Record the owner acceptance decision and reconcile the selected build, PRs, and Jira tasks.

Use the existing all-Docker installation for the first review build.
Do not create another deployment framework or rebuild working features.
Normal database schema initialization remains necessary for a fresh installation.
It does not require a Phase 2 installation, preservation fixture, or cross-phase upgrade test.

## Work to stop or defer

- Stop new Phase 2 to Phase 3 migration and upgrade qualification.
- Park the unfinished Kubernetes native backup increment.
- Defer further Kubernetes and hybrid qualification until an actual deployment requires it.
- Defer the exhaustive fault, capacity, lifecycle, and guided-update matrix while preparing the owner review build.
- Retain essential application security and credential protection.
- Do not build backup, recovery, or data-preservation paths for disposable development data.

Do not weaken an existing full-production-release evidence gate to label this review build production-qualified.
The review build must state its actual tested environment and limitations.
Do not expose development-phase selection or a phase-upgrade journey in the user experience.
Existing full-profile evidence and dependency links describe later deployment qualification, not prerequisites for displaying the client.

## Application already implemented

Angular pages cover Google connection and health, credential management, customer settings, invitations, platform access, and school scopes.
The application also includes sign-in, account preferences, Diagnostics, and the shared shell.
These pages exist on Phase 3 draft branches. They are not a live deployment.
The aggregate client review branch is `codex/cc-54-client-review`, tracked by draft PR 20 and CC-54.
Run `npm exec -- nx run api-e2e:client-review` for the current application with disposable services and simulated Google responses.
The review environment supports separate administrator and recipient identities for invitation and permission review.
The [client review guide](../testing/client-review.md) describes startup, supported workflows, and actual validation.
Browser qualification has exercised the installed workflows.
Human accessibility checks and owner usability acceptance remain open.

## Live Google limitations

The approved customer is easton-consulting.com, customer ID C01zcarnq.
The owner reports that spencer@easton-consulting.com has the Super Admin role.
An Education domain and an approved second administrator remain unavailable.
Record those cases as unavailable. Do not block the client review on them or claim minimum-role or Education qualification.

## Git and Jira

Keep completed changes and evidence. Keep deferred work separate from the active application work.
Commit and push each completed increment. Link the implementation and actual tests to the owning Jira task.
Keep PRs as drafts until their review state supports promotion. Do not merge without owner authorization.
CC-54 and the application tasks drive the immediate UI review. CC-55 retains essential authorization and redaction checks.
CC-57 supplies the fresh installation. CC-58 and CC-59 retain their evidence with further work deferred.
CC-60 supplies a clearly identified review build. CC-61 records owner acceptance.
CC-60 uses `codex/cc-60-review-delivery`, stacked on the client review branch.
The candidate workflow now requires packaged authorization, fresh installation, and installed application workflows.
It retains signatures and candidate-only status. Backup, restore, and the cross-phase upgrade matrix do not gate this review build.
The selected [review build](https://github.com/CampusCommander/campus-commander/releases/tag/phase-3-lab-a043ef187dc6) passed fresh installation and all ten installed application workflow checks.
Independent signature and file verification passed. The [installation guide](../testing/fresh-install-review.md) names the exact source and release.
Owner usability and human accessibility acceptance remain open.
