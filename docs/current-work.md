# Current work

Updated: 2026-09-17.

## Authorized now

The documentation reset was committed and pushed as `a19acd0` on `codex/documentation-scope-reset`.
Do not repeat the documentation audit.

Resolve one active workflow: [add a platform user and assign access](workflows/platform-access.md).
Source: the owner's platform-access discussion on 2026-09-17.
Ask one focused question at a time. Record answers in the workflow and update the relevant gap entries.

The owner confirmed directory selection, invitations outside the Workspace, and no access requests.
The owner also established [settings organization and layout rules](ui/rules.md#ui-11--settings-organization-and-visible-work).
Invitation delivery, activation, permissions, resource access, and exact screen compositions remain open.
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
