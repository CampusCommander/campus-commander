# Phase 3 handoff

> Historical planning or implementation record. Read [current work](../current-work.md) and [workflow gaps](../workflow-gaps.md) before using it.
> This record does not authorize disputed features or require completion of its old checklists.


**Current scope:** The [current work plan](phase-3-current-plan.md) supersedes historical upgrade, recovery, and deployment-matrix requirements below.
The [review-readiness record](../reviews/2026-09-17-phase-3-review.md) identifies the delivered build and remaining review work.

Status: AUTHORIZED on 2026-09-16. Phase 3 implementation is active.
The owner closed Phase 1 and [accepted Phase 2](../reviews/2026-09-16-phase-2-acceptance.md).
The [delivery plan](phase-3-plan.md) expands this handoff into eighteen slices with acceptance criteria and dependencies.
The owner approved the [issue backlog](phase-3-jira-tasks.md) on 2026-09-16. Epic [CC-42](https://easton-consulting.atlassian.net/browse/CC-42) contains the published tasks and verified dependencies.

The owner selected service-account DWD on 2026-09-16. The [credential decision](phase-3-google-credentials.md) records its revised validation gates.

## Deliverable

A district connects its Google customer account, preserves customer settings, and delegates platform access.
The [Phase 3 work breakdown](06-work-breakdown.md#phase-3--onboarding-customer-settings-and-platform-users) defines the scope.

## Delivery order

1. Prove the district-owned service-account DWD credential flow against a controlled account.
2. Bind the stable Google customer ID and supported domains to the installation.
3. Persist customer settings and onboarding progress across browser and service restarts.
4. Request scopes for enabled capabilities and expose Google connection diagnostics.
5. Add platform-user invitations and audited permission grants, changes, and revocation.
6. Apply platform, district, school, and viewer presets through explicit action and resource scopes.
7. Verify denial, revocation, credential replacement, and settings and permission restore across all three deployment modes.

## First delivery slice

[CC-44](https://easton-consulting.atlassian.net/browse/CC-44) owns the credential proof and provider contract.
[CC-45](https://easton-consulting.atlassian.net/browse/CC-45) can establish authorization contracts through the independent dependency path.
Start from the [existing capability matrix and procedure](../validation/v0-2026-09-05/google-credential-proof.md).
Record customer resolution, unattended reads after restart, token renewal, revocation, identity replacement, and least-privilege results.
Record credential storage and recovery requirements before implementing the onboarding flow.
Controlled-account authorization and test configuration are prerequisites for the live proof.
Phase 2 sign-in evidence does not prove background Google API access.

## Retained boundaries

Reuse Phase 2 client JSON import, administrator enrollment, sessions, shell, and Diagnostics.
Keep application sign-in separate from Google background authorization.
Platform users receive Campus Commander access. Managed Google Workspace users belong to Phase 7.
EntityCache and device inventory start in Phase 4. Mutation jobs start in Phase 5.
Onboarding must preserve progress during external Google approval delays.
Invitations and onboarding must work without mandatory SMTP configuration.

Future UI implementation must follow the [UI contract](../ui/README.md) and record applicable rule IDs and validation evidence.
This handoff changes no UI or runtime behavior.

## Customer connection implementation

[CC-46](https://easton-consulting.atlassian.net/browse/CC-46) now includes encrypted PostgreSQL staging and public API customer confirmation.
The [connection contract](phase-3-google-connection.md) records credential boundaries, cleanup, deployment configuration, validation, and remaining scope.
The live verifier passed for the owner-confirmed customer. Coordinated renewal and independent worker reads passed source-container and packaged Phase 3 qualification.
Browser onboarding passed source and packaged API and database qualification. Complete deployment-profile qualification remains incomplete.
