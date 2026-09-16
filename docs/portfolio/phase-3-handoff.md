# Phase 3 handoff

Status: AUTHORIZED on 2026-09-16. Implementation has not started.
The owner closed Phase 1 and [accepted Phase 2](../reviews/2026-09-16-phase-2-acceptance.md).
The [delivery plan](phase-3-plan.md) expands this handoff into eighteen slices with acceptance criteria and dependencies.
The [issue drafts](phase-3-jira-tasks.md) await owner review before Jira publication.

## Deliverable

A district connects its Google customer account, preserves customer settings, and delegates platform access.
The [Phase 3 work breakdown](06-work-breakdown.md#phase-3--onboarding-customer-settings-and-platform-users) defines the scope.

## Delivery order

1. Prove the district-owned offline OAuth credential flow against a controlled account.
2. Bind the stable Google customer ID and supported domains to the installation.
3. Persist customer settings and onboarding progress across browser and service restarts.
4. Request scopes for enabled capabilities and expose Google connection diagnostics.
5. Add platform-user invitations and audited permission grants, changes, and revocation.
6. Apply platform, district, school, and viewer presets through explicit action and resource scopes.
7. Verify denial, revocation, credential replacement, and settings and permission restore across all three deployment modes.

## First delivery slice

P3.1 owns the credential proof and provider contract.
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
