# Current work

Updated: 2026-10-05.

## Authorized now

Build one active workflow: [browse ChromeOS devices](workflows/device-browsing.md).
Source: development order steps 2 and 3 below, and owner decisions on 2026-10-05.
The owner authorized implementation on 2026-10-05, after the workflow record.

The slice reads data only. It covers the device grid, typed filters, device details, battery health, and the designed states.
Battery health uses Google's classification. The School column, selection, Bulk Actions, and every device change are excluded.
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

Steps 2 and 3 are active, as the owner authorized on 2026-10-05. Later steps require their own authorization.
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
