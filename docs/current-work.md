# Current work

Updated: 2026-10-21.

## Authorized now

On 2026-10-20 the owner signed off development order step 4 after a walkthrough of the review build.
On 2026-10-21 the owner authorized development order step 5 with device commands first.
The owner chose the answer "Device commands (Reboot, Disable, Wipe, and others)" to "What should step 5 build first?".
The owner chose the answer "Reboot, Disable, Re-enable first; Wipe, Powerwash, Deprovision next" to "If device commands come first: which commands go in the first build?".
The [device commands record](workflows/device-commands.md) defines this build.
On 2026-10-19 the owner queued two items after the bulk-actions stage. PRs #70 and #71 built them:

1. Verify every Google scope that Campus Commander uses in the Google health check. Show the result in Diagnostics.
2. Then add pre-filled delegation links to Diagnostics and to the denied prompt on the Devices page.

Device write tests use admin-sdk-mock. The existing test authorization does not include device writes.

### Step 5 device commands (signed off 2026-10-21)

On 2026-10-21 the owner approved the step 5 screens: "That looks good".
The [device commands record](workflows/device-commands.md) holds the approved composition and the wording defaults.
The owner also gave this direction. Owner: "I also want to give the hint now that update device needs to be expanded to include the other editable fields."
The step 4 record excludes four fields: org unit, asset ID, user, and notes (`docs/workflows/update-device-annotated-location.md:196`).
The Update device expansion is the next workflow after the step 5 first build.
A separate record defines it before any build.

### Device update record (signed off 2026-10-20)

The owner authorized development order step 4 after the device browsing sign-off. The owner chose the first device edit: "Update the annotated location".
Step 4 builds that edit on selected devices through preview, confirmation, a job, and visible results.
The owner chose to build the jobs UI as part of this first edit. The [owner decisions of 2026-10-16](workflow-gaps.md#owner-decisions--2026-10-16) record the jobs scope.
The [workflow record](workflows/update-device-annotated-location.md) defines this edit and the jobs UI.
Before the sign-off, the owner named three changes on 2026-10-20: 8-hour sessions, a bulk action side sheet, and Material 3 dropdown buttons with Refresh Selected and Refresh Domain.
PRs #62, #63, #65, #66, and #67 built them.

### Device browsing record (signed off 2026-10-16)

Source: development order steps 2 and 3 below, and owner decisions on 2026-10-05.
The owner authorized implementation on 2026-10-05, after the workflow record.

The slice reads data only. It covers the device grid, typed filters, device details, battery health, and the designed states.
Battery health uses Google's classification. The owner added grid tools, paging, server-side selection, and grouping on 2026-10-05.
On 2026-10-06 the owner authorized per-device freshness as infrastructure under this workflow, on branch `codex/entity-cache`.
The [entity cache record](superpowers/specs/2026-10-06-entity-cache-decisions.md) holds the confirmed decisions. It is not a new workflow.
On 2026-10-07 the owner requested a Google batch service for the entity sync job, on branch `codex/batch-service`.
The [batch service record](superpowers/specs/2026-10-07-google-batch-service-decisions.md) holds the confirmed decisions. It is not a new workflow.
On 2026-10-15 the owner requested admin-sdk-mock setup for this project, on branch `codex/admin-sdk-mock`. The mock is development infrastructure under this workflow. It is not a new workflow.
On 2026-10-16 the mock presents `Easton Consulting` on `easton-consulting.com` with the `medium` tier by default, on branch `codex/easton-review-tenant`.
The School column, Bulk Actions, and every device change are excluded.
Inspect the [linked Figma frames](workflows/device-browsing.md#design) before implementing each screen.
Use focused `codex/` branches. Do not merge without owner authorization.

## Recorded, not active

[Add a platform user and assign access](workflows/platform-access.md) holds the owner's access decisions through 2026-10-05.
The workflow file is the only description of those decisions. Do not restate them here.
The remaining items are screen compositions and control details. Settle them against Figma when that workflow is built.
Implementation of platform access is not authorized.

On 2026-10-05, the owner warned against designing "curtains for a dog house."
Ask the owner only about decisions that are expensive to change or that block the next buildable step.
Choose sensible defaults for other details during implementation and record them in the workflow.

The documentation reset was committed and pushed as `a19acd0`. Do not repeat the documentation audit.
Do not require resolution of all 27 gaps before progress.
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
- Do not merge branches or remove existing application features without owner authorization.

## Development order after the reset

This order replaces execution by historical phase checklist. It does not silently resolve the product questions below.

1. Resolve the access and navigation decisions in G01–G07 before changing those workflows.
2. Use the existing administrator access and connection to build the first usable device browsing workflow.
3. Demonstrate device filtering, battery health, and details against the linked Figma designs.
4. Add selection and one agreed device edit through preview, confirmation, a job, and visible results.
5. Expand device actions and CSV workflows after resolving their specific open decisions.
6. Reuse the working interaction patterns for Google users, OUs, and groups, in that order.
7. Define Fleet Status and reports before implementing them.
8. Schedule deferred operational work when an actual deployment or release requires it.

Product decisions about adding other administrators do not require rebuilding the existing single-administrator foundation.
Read-only device work does not depend on school creation, invitations, or completion of every historical Phase 3 gate.
Device-specific Google scopes and method support still require verification before real provider access.
The existing test authorization does not include device writes.

Steps 2, 3, and 4 are complete. The owner signed off device browsing on 2026-10-16 and device update on 2026-10-20. Later steps require their own authorization.
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
