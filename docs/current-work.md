# Current work

Updated: 2026-10-05.

## Authorized now

The documentation reset was committed and pushed as `a19acd0` on `codex/documentation-scope-reset`.
Do not repeat the documentation audit.

Resolve one active workflow: [add a platform user and assign access](workflows/platform-access.md).
Source: the owner's platform-access discussion on 2026-09-17 through 2026-09-18.
Ask one focused question at a time. Record answers in the workflow and update the relevant gap entries.

The owner confirmed directory selection, invitations outside the Workspace, and no access requests.
Platform Admin selects one or more people in a searchable Google directory grid and sends their invitations together.
For external invitees, Platform Admin enters or pastes one or more email addresses and reviews the recipients before sending.
Invalid addresses block sending for that selection until Platform Admin corrects or removes them.
External invitees do not need Google accounts.
Support configured identity providers and emailed one-time sign-in codes for external invitees.
Platform Admin selects allowed sign-in methods separately for every recipient before sending invitations.
Removing an allowed sign-in method immediately ends that platform user's sessions created through it.
Every platform user keeps at least one allowed sign-in method. Removal of the last method is blocked.
Invitation acceptance requires verification of the invited email address through an allowed method.
The invitation link opens a sign-in page with the invitee's allowed methods. Signing in accepts the invitation.
Expired or revoked links show one generic message without sign-in options.
Platform Admin updates a changed email address. The platform user verifies the new address before the change takes effect.
Saving the change ends sessions under the former address. The former address cannot sign in.
Platform Admin restores lost sign-in access. A server operator restores a Platform Admin when no Platform Admin can sign in.

Campus Commander sends invitation emails.
It sends invitations and email sign-in codes through the connected Google Workspace with the Gmail send scope.
Platform Admin selects one sender mailbox in the connected domain for that email on Settings > Platform Settings.
Missing email setup blocks invitation sending. Platform Users names each missing item.
Without email setup, the sign-in page tells email-code users that codes are unavailable. Administrators receive no separate warning.
Platform Admin can resend or revoke pending invitations from Settings > Platform Users.
Invitations remain valid for seven days. Resend starts a fresh seven-day period for pending or expired invitations.
Expired or revoked invitations cannot activate access.
A revoked invitation stays revoked. Platform Admin sends a new invitation to invite that address again.
Revocation removes the assignments configured for that invitee. A new invitation starts with no assignments.
An undelivered invitation stays pending with a delivery-failed status. Platform Admin can resend or revoke it.
Access activates after invitation acceptance and identity verification, without a second administrator confirmation.
Administrators can configure pending invitees' assignments on Access Assignments. They take effect after acceptance and identity verification.

Administrators assign granular permissions through reusable roles, without individual permission exceptions.
Named OrgUnit collections define resource scope and represent schools for access administration.
Administrators control "Include descendants" separately for each selected OrgUnit.
It defaults to off for each OrgUnit added to a collection.
Initial collections have no exclusion rules. Platform Admin selects the required OrgUnits and optional descendants.

Enabled descendant scopes follow the current Google hierarchy, including new or moved-in descendants and excluding moved-out descendants.

An ordinary asset access assignment associates a platform user with a role and an OrgUnit collection.
A platform user can have multiple access assignments, each with its own role-and-collection pairing.
Within overlapping scopes, permissions combine and most permissive wins.
Saved role and collection changes automatically apply to every assignment using them.
Deletion is blocked while assignments reference a role or collection. Platform Admin must change or remove those assignments first.

Asset Super Admin is a special built-in role representing full managed Google resource access.
Platform Admin has full asset access through that distinct role and can assign any role to any platform user.
Platform administration and asset administration remain explicit, separate responsibilities.
Platform Admin and Asset Super Admin have fixed, undeletable definitions. Platform Admin manages who holds them.
Only Platform Admin manages platform users, roles, OrgUnit collections, and access assignments in the initial workflow.
Delegated access administration is outside the initial workflow.

The owner also established [settings organization and layout rules](ui/rules.md#ui-11--settings-organization-and-visible-work).
Platform Users, Platform Roles and Permissions, OrgUnit Collections, and Access Assignments each have their own Settings page.
Access Assignments uses a grid of platform user, role, and OrgUnit collection.
The owner named distinct read, write, bulk-action, device-deprovisioning, and user-schema permissions in the [workflow](workflows/platform-access.md#granular-permissions--2026-09-17).
The permission list is explicitly non-exhaustive.

Bulk Actions grants access to the dropdown button. Action-specific permissions determine which features are enabled within it.
Bulk operations require both permissions within the applicable scope.
Write, Deprovision, and Bulk Actions include the entity's Read permission. Other action coverage and dependencies remain open.
User Schema Manage covers domain-wide schema definitions only. Custom attribute values require User Write.
Group access is outside this workflow. The groups workflow (G21) defines it.
A device move requires Device Write for the current and destination OrgUnits.
A Google user move requires User Write for the current and destination OrgUnits.

Sign-in method controls, role details, OrgUnit scope behavior, the sender name, and exact screen compositions remain open.
Design: missing, as recorded in the [Figma map](portfolio/prototype-map.md).

Completion: record the agreed interaction, permissions, resource access, interface placement, and remaining design requirements.
Do not require resolution of all 27 gaps before progress.
Application implementation remains paused until the owner authorizes it.
Exclude feature removal, broad qualification suites, branch merges, Jira synchronization, and deferred infrastructure work.
Existing code remains available for inspection. Its existence does not settle product choices.

## Standing constraints

- This is greenfield development. Nothing is live. Development data is disposable.
- Phases organize development. They are not a customer upgrade journey.
- Do not add cross-phase migration, legacy compatibility, or development-data preservation work.
- Defer new backup, restore, deployment-matrix, and capacity projects until a usable product requires them.
- Preserve authorization and credential protection.
- Reuse the approved Easton read-only fixture within the [recorded boundary](portfolio/phase-3-google-credentials.md#standing-test-authorization--2026-09-17).
- Do not require an Education domain or populated collections for ordinary API plumbing.
- Keep real credentials out of the simulated client-review environment.
- Do not merge branches or remove existing application features during this documentation task.

## Development order after the reset

This order replaces execution by historical phase checklist. It does not silently resolve the product questions below.

1. Resolve the access and navigation decisions in G01–G07 before changing those workflows.
2. Use the existing administrator access and connection to build the first usable device browsing workflow.
3. Demonstrate device filtering, selection, and details against the linked Figma designs.
4. Add one agreed device edit through preview, confirmation, a job, and visible results.
5. Expand device actions and CSV workflows after resolving their specific open decisions.
6. Reuse the working interaction patterns for Google users, OUs, and groups, in that order.
7. Define Fleet Status and reports before implementing them.
8. Schedule deferred operational work when an actual deployment or release requires it.

Product decisions about adding other administrators do not require rebuilding the existing single-administrator foundation.
Read-only device work does not depend on school creation, invitations, or completion of every historical Phase 3 gate.
Device-specific Google scopes and method support still require verification before real provider access.
The existing test authorization does not include device writes.

This is an ordering decision for future work, not an instruction to start application implementation now.
Keep one workflow active. Finish its usable result before expanding the feature surface.

## How to choose and finish a task

Name the user task, its source, the relevant design, and its exclusions before implementation.
Use a short workflow record in the format from [the documentation entry point](README.md#small-workflow-format).
Routine implementation details do not require another permission request.
Ask about missing product behavior only when it affects the current task.

Demonstrate the actual interaction and run checks appropriate to the change.
Do not treat passing tests as visual approval or create a release qualification project for a small UI change.
Do not keep repeating completed checks without a new change, failure, or unresolved concern.
Report what changed, the demonstration, the checks, and material limitations.

## Implementation and historical status

Phase 1 is closed. The owner accepted Phase 2 as it was.
Phase 3 has substantial implementation, but the owner rejected its UI and disputes parts of its product scope.
No phase acceptance or feature approval follows from this audit.
Historical builds, PRs, reports, and Jira statuses remain point-in-time records.
Use the working Git revision when describing current source. Do not describe an older published candidate as current UI.
