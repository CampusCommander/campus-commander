# Current work

Updated: 2026-10-26.

## Authorized now

On 2026-10-20 the owner signed off development order step 4 after a walkthrough of the review build.
On 2026-10-22 the owner signed off the step 5 first build: Reboot, Disable, and Re-enable. The owner chose the answer "Signed off as built" to "Step 5 (Reboot, Disable, Re-enable from Bulk Actions): do you sign it off?".
On 2026-10-22 the owner signed off the Update device fields workflow after he tried the review build at `c92e0ba`. Owner: "Signed off".
On 2026-10-23 the owner confirmed the [Wipe user data, Powerwash, and Deprovision record](workflows/wipe-powerwash-deprovision.md). Owner, in the main chat: "1", which chose the option "Confirmed: build it as written".
On 2026-10-23 the owner approved the Wipe user data, Powerwash, and Deprovision screens. Owner, in the main chat: "All the screens look good. Go ahead and execute."
The approved mockup is [2026-10-23-wipe-powerwash-deprovision.html](ui/designs/2026-10-23-wipe-powerwash-deprovision.html). The [record](workflows/wipe-powerwash-deprovision.md#design) marks each design gap that the screens close.
On 2026-10-23 the owner signed off the step 5 second build: Wipe user data, Powerwash, and Deprovision. The owner chose the answer "Signed off as built" to "Wipe user data, Powerwash, and Deprovision (the three destructive device actions): do you sign them off?".
On 2026-10-23 the owner chose the next workflow. Question: "Pick the next workflow".
Owner, in the main chat: "2", which chose the option "In-grid editing and the single-device update". On 2026-10-23 the owner confirmed the [in-grid editing record](workflows/in-grid-editing.md). He chose the answer "Confirmed: build it as written".
The [in-grid editing record](workflows/in-grid-editing.md) is owner-confirmed. Its [design addendum](superpowers/specs/2026-10-23-in-grid-editing-design.md) comes before the build.
On 2026-10-23 the owner approved the in-grid editing mockup. Owner: "Yea go ahead with this visual design." The approved mockup is [2026-10-23-in-grid-editing.html](ui/designs/2026-10-23-in-grid-editing.html).
On 2026-10-24 the owner signed off the in-grid editing build. Owner, in the main chat: "I sign off." The build merged at `1e5f9d3`.
On 2026-10-24 the owner started the CSV and Google Drive export and import workflow (gap G16). Owner: "We need to start the work on the CSV/Google Drive import export. For google drive we will use the google drive picker."
On 2026-10-26 the owner supplied his reference design, answered decisions D1 to D4, and added the import modes (D5).
The [batch update through export and import record](workflows/batch-update-export-import.md) is proposed. A mockup comes before the build.
On 2026-10-21 the owner authorized development order step 5 with device commands first.
The owner chose the answer "Device commands (Reboot, Disable, Wipe, and others)" to "What should step 5 build first?".
The owner chose the answer "Reboot, Disable, Re-enable first; Wipe, Powerwash, Deprovision next" to "If device commands come first: which commands go in the first build?".
The [device commands record](workflows/device-commands.md) defines this build.
On 2026-10-19 the owner queued two items after the bulk-actions stage. PRs #70 and #71 built them:

1. Verify every Google scope that Campus Commander uses in the Google health check. Show the result in Diagnostics.
2. Then add pre-filled delegation links to Diagnostics and to the denied prompt on the Devices page.

Device write tests use admin-sdk-mock. The existing test authorization does not include device writes.

### Batch update through export and import (record proposed 2026-10-26)

This is the active workflow. The [record](workflows/batch-update-export-import.md) and its [technical design](research/batch-update-export-import-technical-design.md) define it.
The record quotes the owner's answers D1 to D4 and his import modes direction (D5).

Next: the owner confirms the record and its implementation defaults. The mockup follows. The build waits for both.

The CSV slice comes first. The Google Drive slice and the report export follow.
A live Google Sheet export creates a Google file. It needs the owner's authorization, as live device writes do.

### Update device fields (signed off 2026-10-22)

The Update device expansion is the next workflow after the step 5 first build.
The [Update device fields record](workflows/update-device-fields.md) defines it. The owner confirmed that record on 2026-10-21.

On the evening of 2026-10-21 the owner approved the Update device fields screens:

<!-- prettier-ignore -->
> Yea These screens are fine. I agree we can leave asset tag off of the bulk update.  We will be doing in-grid editing as well as individual device update like you show in the screens. That is the correct place to set asset tag. As well as import and export for bulk edit. If you dont know about that there should be sone notes.

Asset tag leaves the bulk Update device. The approved mockup is [2026-10-21-update-device-fields.html](ui/designs/2026-10-21-update-device-fields.html).
The owner places Asset tag in in-grid editing and the individual device update.
The owner names three later workflows: in-grid editing, the individual device update, and import and export for bulk edit (gap G16).
These workflows are direction, not authorization to build.

On 2026-10-22 the owner tried the review build at `c92e0ba`.
The owner then signed off the Update device fields workflow. Owner: "Signed off".

The sign-off accepts the drafted wording and these defaults as built:

- The organization unit picker shows the device count without "Current: N organization units".
- Review and the job page order rows by the internal device ID.
- The picker and the job page keep their small layout differences from approved screens 03 and 09.
- Asset tag stays off the bulk sheet.

PR #106 aligned three items with approved screens before the sign-off: the step 5 review tables, the organization unit scope sentence, and the Schools tree behavior.

The update leaves these follow-ups. None is scheduled:

- The "Current: N organization units" count needs a new read of the selected devices' units.
- An unparseable confirmation entry stays in tab storage.
- A Confirm sentence can read "on 0 devices".
- Long email addresses break inside a word in the Review table.
- The capability label "School OU references" also serves the device picker.
- An organization unit tree above 10,000 units answers unavailable.

Live device writes stay unverified. The test domain has no ChromeOS device (read-only check on 2026-10-22).

### In-grid editing and the single-device update (signed off 2026-10-24)

The [in-grid editing record](workflows/in-grid-editing.md) defines this build.
The owner confirmed the record on 2026-10-23 with "Confirmed: build it as written".
The owner approved the mockup the same day with "Yea go ahead with this visual design".

The build merged at `1e5f9d3` in PRs #126 to #141.
On 2026-10-24 the owner signed off the build. Owner: "I sign off."

The sign-off accepts these defaults as built:

- Asset tag is set in the grid and on device details. It stays out of the bulk Update device sheet.
- "Save changes" with one pending change creates the job directly, with no Review and Confirm step. This is the owner's exception to UI-07.
- A conflict blocks Save changes until the person keeps the current value or keeps the draft.
- A duplicate Asset tag warns and does not block.
- The edit route accepts 98,304 bytes. The selection preview and confirm routes keep 4,096 bytes.

IQ1 rehearsed the seven completion steps on admin-sdk-mock 0.2.0 in 45.0 seconds with 44 screenshots.
Live device writes stay unverified. They need explicit authorization and an enrolled test device.

Three design gaps stay recorded in the workflow record:

- No drawn in-cell editor for Annotated location, Annotated user, or Notes, and no drawn Clear value cell. The editors are built.
- No drawn duplicate Asset tag warning. The warning appears on Review.
- No drawn "Update device" button without permission. The build uses the disabled-with-a-note pattern from `docs/ui/rules.md:73`.

Four follow-ups from review sit in the `swe` board triage. None blocks this build:

- Classify a missed S13.refresh interleaving as Not verified.
- Preserve focused regression coverage for the review session configuration.
- Check bulk sheet focus when reduced motion is enabled.
- Isolate the U6 test runner and align its unchanged-row fixture.

### Step 5 device commands (first build signed off 2026-10-22)

On 2026-10-21 the owner approved the step 5 screens: "That looks good".
The [device commands record](workflows/device-commands.md) holds the approved composition and the wording defaults.
The owner also gave this direction. Owner: "I also want to give the hint now that update device needs to be expanded to include the other editable fields."
The step 4 record excludes four fields: org unit, asset ID, user, and notes (`docs/workflows/update-device-annotated-location.md:196`).

On 2026-10-22 the owner signed off the step 5 first build.
Question: "Step 5 (Reboot, Disable, Re-enable from Bulk Actions): do you sign it off?"
Answer: "Signed off as built".
The sign-off accepts the drafted wording and the defaults of the review package as built: "already active" for Re-enable, Google's raw reason code on a refused command row, the `0s` duration, the two-line Disable review title, the "Status change" column, the error color of the failure reason, "Awaiting devices" for a waiting Reboot job, and "All updates confirmed" on the Jobs page.

The step 5 first build leaves these follow-ups. None is scheduled:

- The expired Latest activity line names no device.
- The offline note names Update device.
- The note band style differs from PNG 10.
- Status sorts by the raw Google value.
- The selection checkboxes stay enabled without a bulk action.
- No database check limits `google_status`.
- A B5 test fixture still stores status 0.

Live device writes stay unverified. The test domain has no ChromeOS device (read-only check on 2026-10-22). A live check needs an enrolled test device and the owner's authorization (risk DEVICE-01 of the design).

### Wipe user data, Powerwash, and Deprovision (second build signed off 2026-10-23)

The [record](workflows/wipe-powerwash-deprovision.md) defines this build.
On 2026-10-23 the owner signed off the step 5 second build.
Question: "Wipe user data, Powerwash, and Deprovision (the three destructive device actions): do you sign them off?"
Answer: "Signed off as built".
The sign-off accepts the drafted wording and these defaults as built:

- Change status shows the Deprovision line "5 of 6 selected devices are active or disabled." after the reason choice. PNG 05 shows the line before the choice. The reason choice prepares the preview at once.
- A job whose commands all expired shows the job chip Failed.
- The Wipe user data button reads "Send Wipe to N devices". The option, the titles, and the job name the action "Wipe user data".
- The typed phrase is case-sensitive. The phrase "powerwash" keeps Send disabled.
- A Google `CANCELLED` command settles Failed with "Google cancelled the command." This covers Reboot too.
- Waiting and Unknown command rows show the Google expiry. Reboot rows show it too, and the first build's Reboot job page showed none. Wipe user data and Powerwash rows add "No result in 30 days" after the watch window.
- A new reason discards the old Deprovision preview. A switch to another action and back keeps the reason. Review and Confirm clear the typed phrase on entry. A phrase of spaces alone shows the mismatch error.
- The drafted wording in the review package's `owner-review-wording.md`.

The second build leaves these follow-ups. None is scheduled:

- Security: four read call sites in `api/src/app/devices/device-actions.controller.ts` skip the action callbacks on the nullable-sync fallback. Future connection-removal work must keep these reads fail-closed.
- After a 403 or a permission change, the sheet shows the step 5 permission note. It names `devices:commands` for Wipe user data and Powerwash. It names `devices:status` for Deprovision. The permission checks stay correct.
- A Reboot row that settles Unknown after its watch window shows no sentence.
- Every reported command result other than SUCCESS settles Failed, an unspecified result included.
- The inventory does not keep the deprovision reason that Google stores.
- The F2 activity mock omits `recent.nextExpiryAt`. The reason-change fixtures reuse one preview ID across reasons. api-e2e holds no Disable or Re-enable case. admin-sdk-mock returns no `IGNORED` result.
- The [record](workflows/wipe-powerwash-deprovision.md) still calls the mockup and the DEVICE-01 update pending. `docs/portfolio/02-domain-model.md:83` lists a cached deprovision reason that the inventory does not hold.

Live device writes stay unverified. The test domain has no ChromeOS device (read-only check on 2026-10-22).

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

Steps 2, 3, and 4 are complete. The owner signed off device browsing on 2026-10-16 and device update on 2026-10-20. The owner signed off the step 5 first build on 2026-10-22. The owner signed off the Update device fields workflow on 2026-10-22. The owner signed off the step 5 second build on 2026-10-23. Later steps require their own authorization.
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
