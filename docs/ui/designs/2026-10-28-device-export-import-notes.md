# CSV slice mockup, version 4: device Export, Reports, and Import in dialogs, results first

Status: approved. On 2026-10-28 the owner approved version 4 of this mockup and directed the build. Owner, in the main chat: "This is perfect. Please go ahead and execute on this."
The repository stores the HTML as `2026-10-28-device-export-import.html`, this file as `2026-10-28-device-export-import-notes.md`, and each PNG as `2026-10-28-device-export-import-<state>.png`. `compare.html` stays outside the repository.

## Approval and build rulings

The approval covers the 27 states, the two dark captures, and the composition in these notes.
The build follows the proposed answers 1 to 12 under [Questions for the owner](#questions-for-the-owner).
The eng-lead named these defaults to the owner before the approval: the phase lists of the progress steps, the help pane, a device status change after validation that fails at Google, the return through the Activity row, and the Cancelled results after a cancel of UPD-001.

These answers replace proposed answers under [Questions of version 2](#questions-of-version-2):

| Version 2 question | Replaced by |
| --- | --- |
| 9, 10 rows on a report page | A page holds 10 changes. The changes of one device continue on the next page, which repeats its Row and Device cells. No page leaves an empty slot. |
| 14, 1120 px for every step | [Dialog widths and the help pane](#dialog-widths-and-the-help-pane) |
| 16, a help pane of 480 px | [Dialog widths and the help pane](#dialog-widths-and-the-help-pane) |
| 23, the dialog after Done | Question 4: the Activity row of the import opens the dialog at the execution results. |
| 25, the jobs only after Execute | [Execution results](#execution-results) and questions 3 and 4 |

After the approval, the eng-lead asked: "Failed tab on the execution results: yes or no." Owner: "yes".

The build differs from the PNGs in three named points:

1. A long Organization unit path truncates at a `/` boundary and keeps its last segments, for example `…/Lowell Academy/Grade 9`. The tooltip holds the full path. States 17 and 17b cut the path inside a word.
2. Every report and result page fills its 10 changes, as the table above states. States 13, 17, and 17b show 9 changes and an empty slot.
3. The execution results get the view tabs of the report: All changes and Failed, each with its count. Failed lists the changes whose outcome is Failed. No PNG draws these tabs. The label All changes is drafted.

Proposal mockup for the owner. It is not the built app.
Open `csv-slice-mockup-v4.html` in a browser. The switcher at the bottom left opens a list of the states. The deep links `#01-bulk-actions-menu` to `#26-jobs-grid`, with `#17b-execution-finished` after `#17-executed`, show each state, on a fresh load and on a hash change. The deep links `#dark-13-review-proposed` and `#dark-17b-execution-finished` show the two dark captures.
The PNGs in `png/` are the review set. Each one is 1440 px wide at a device scale factor of 1. The 27 states use the light theme, and the two `dark-` PNGs use the dark theme of the app.
`compare.html` shows version 3 and version 4 side by side for states 02, 07, 09, 12, 13, and 17, and the new state 17b alone.

Sources:

- Version 3, in the eng-lead workspace, read only. The owner reviewed it on 2026-10-28 and removed the file previews. Version 4 copies its backgrounds, theme, Material CSS, calibration, and scripts into this folder.
- The app: `frontend/` and `libs/` of main `5f50d7c`, read from the read-only review checkout `review-2026-10-28`. PR #157 changed job strings after version 3 (`job-fields.ts`, `job-detail-fields.ts`, `job-detail.html`, and `job-detail.ts`). The string check runs against `5f50d7c`.
- The job semantics behind the execution results: `job-detail-fields.ts` (`OUTCOME_LABELS`, `outcomeTone`, `rowFailureText`, `outcomeNotes`), `job-fields.ts` (`JOB_STATUS_LABELS` and the progress lines), `job-detail.html` and `job-detail.css` (the outcome cell), the terminal status rule of `deployment/postgres/migrations/017-jobs.sql`, and the status-conflict results of `worker/src/device-status-mock.test.mjs`.
- The Admin SDK mock of the review environment: `src/directory/device-writes.ts` of the admin-sdk-mock project, read only. It answers a status change that the device status does not allow with `FAILED_PRECONDITION` and the message template of state 17b.
- The edit template module: `libs/application-contracts/src/lib/device-edit-template.ts` of main `5f50d7c`. Its texts count as app-sourced, with the module as proof.
- The design doctrine: the claude-design skill (Start From Context, Surface-First, Anti-Slop Rules, and Slop Diagnostic).

Build phases: phase 1 (the results: states 13, 17, and 17b, and `compare.html` for them), phase 2 (the setup and progress states 02 to 05, 07 to 10, 12, 23, and 24), and phase 3 (the help states 06 and 11, the report states 14, 15, and 18 to 22, the confirmation 16, the states 01, 25, and 26, the dark captures, and the full `compare.html`) are complete. The polish system is shared, so every state took it in the first build. The renders and the PNG inspection ran phase by phase.

## Owner direction

The owner, 2026-10-28, on version 3:

> I dont like having the export and import preview. Just the raw data in the dialog. We can do without that. The important UI is the results of the validation and the results of the execution.

The flow stays fixed: the 26 states of version 3 and their order, plus 17b after 17, their data, the job IDs, the counts, and the labels of the owner. His direction on version 1 still binds the flow. Version 3 recorded it, with his direction on version 2, as follows:

The owner, 2026-10-28, on version 2:

> OK the flow looks good. It needs a graphic design UI./UX polish pass. Use the skill of a expert front end designer and make the UI/UX a professional experiance.

The flow of version 2 is fixed: the 26 states, their order, their data, the job IDs, the counts, the labels of the owner, one wide dialog, the help behind the info button, and no instruction in the flow.
The eng-lead recommended three answers with version 2. They stand unless the owner objects:

1. Bulk Actions stays enabled without a selection. Only Import is available then.
2. Reports exports every column that is turned on in the grid, also a column scrolled out of view, in grid order. The 50,000-device limit applies.
3. After a person closes a dialog, the Activity list and the same Bulk Actions entry return to the running or finished job.

Section 4 of the version 2 brief and the earlier direction, as version 2 recorded them:

The owner, 2026-10-28, on version 1. This direction wins over every earlier composition.

> OK so lets talk about the UI for the export / import. Seperate the export for editing and export for reporting as two bulk edit actions. Call one export and the other reports.
>
> The difference is export for bulk action exports the defined list of editable fields plus the meta data fields needed. The export for report exports the selected items with the current grid config(column visibility and order)
>
> the import export should be a dialog instad of a sidebar. We will need the exrtea horrizantal space.
>
> We should not make the user go to the job page to run device steps. On the import the user gets a progress indicator that the validation is running. And when it is done the in the same dialog you get the validation report.
>
> Any instructions should not be in the normal flow of the UI. Add a help/info icon button that shows the help docs for the import / export.
>
> Go ahead and make those changes then we will do the next polish pass on the design.

The earlier owner direction still binds the rules. Section 4 of the version 1 brief, verbatim:

2026-09-03 feature review notes:

> - We need a unique export and import pair (distinct from the existing one-way export and the CSV import).
> - Export creates a CSV or Google Sheet.
> - The user updates the data in the spreadsheet, then re-imports it.
> - Re-import runs: validation → preview → confirm → create job.
> - There will be some complex workflows here. This needs its own design session before implementation.
> - NOTE: this export/import entry point lives nested under the bulk actions dropdown menu.

2026-10-26, decisions D1 to D4:

> D1) The checksum only flags a csv row has changed.  We then validate that the data for those rows in postgress is fresh. If it is not we first update it from google. We then do a  do a field by field update against only fresh data.
>
> D2) After the validation they can choose if they want to execute the changes or cancel. If they execute only valid changes are ran.
>
> D3) We add status. We add a specific coded string they have to use to deprovision so they cant accidently do it. It will be DEPROVISION:REASON.We create a specific list they have to use. This makes them have to look up the code so it reduces accidents.

2026-10-26, import modes (D5):

> I want in the import UI. Have a selector that says "Sync all rows" and "Sync changes" Sync all rows ignores the checksum and force updates devices to what is in a sheet. This would be a way to have a set configuration that you want to reset a set of devices like a library card the same way everytime.

2026-10-26, answers on the defaults:

> 1) I Am OK with that side effect. That is why there is a validation step. The user will be able to deconflict before executing.
>
> 2) We need to add a universal cancel job feature to the job service.
>
> 3)
> -Yes use [clear] for an explicit clear of a field.
>
> - No Sync all rows only gets data from Google if the device record is stale. Then it only gets stale rows.
>
> -A validated plan expires after 1 hour. That is fine.
>
> -Execute still asks for the typed DEPROVISION confirmation. This is OK.

2026-10-26, the cancel rules (answer 2 agrees that a cancel of an import update job also cancels its waiting status jobs):

> 1 Anyone with Job:Manage a platform admin, or the owner can cancel the job.
>
> 2) agreed
>
> 3) Nope cancelled is fine.  We will still have a status document even if it was cancelled. Any successes or failures that happened before the cancel will be recorded int he job results.
>
> 4) That is correct there is no ability to claw that back
>
> 5) That is fine

2026-10-26, on the job cancel mockup: "Thats fine." Reuse its approved compositions: the outlined "Cancel pending work" control right of Refresh, the 480 px question dialog, "Cancellation requested", and the Cancelled job page.

The owner approved the job cancel mockup on 2026-10-26, and main `1fe79c3` builds the cancel feature. State 25 shows the built job page and question.

### Owner rules by state

| Rule | Source | States |
| --- | --- | --- |
| Export and Reports are two Bulk Actions entries, beside Import | 2026-10-28 | 01 |
| Export holds the editable fields and the metadata that the import needs | 2026-10-28 | 02, 05, 06 |
| Reports holds the selected devices with the visible grid columns in grid order | 2026-10-28 | 07, 08 |
| A dialog, not a side sheet, with horizontal space | 2026-10-28 | 02 to 24 |
| No job page to finish a flow: progress, then the result in the same dialog | 2026-10-28 | 04, 05, 08, 12, 13 to 22 |
| Instructions leave the flow, a help or info icon button shows the docs | 2026-10-28 | 06, 11, every dialog header |
| Validation, preview, confirm, create job | 2026-09-03 notes | 12, 13, 16, 17 |
| D1: the checksum flags rows, stale devices refresh first | D1 | 12, 13, 18, 20 |
| D2: Execute or cancel, only valid changes run | D2 | 13, 16, 17, 20, 22 |
| D3: status codes and DEPROVISION with a reason code from a list | D3 | 11, 13, 14, 16, 22 |
| D5: Sync changes and Sync all rows | D5 | 09, 11, 18, 19, 23, 24 |
| The status echo side effect, deconflicted before Execute | Answer 1 | 13 (Re-enable of 04XTBHJ, Asset tag of 0727D2E), 15 |
| `[clear]` clears a field | Answer 3 | 06, 11, 13, 18, 22 |
| Sync all rows refreshes stale devices only | Answer 3 | 18, 24 |
| The plan expires after 1 hour | Answer 3 | 13, 18, 19 |
| Execute asks for the typed DEPROVISION | Answer 3 | 16 |
| A cancel of the update job also cancels its waiting status jobs | Cancel rules, answer 2 | 25 |
| Results keep every outcome from before a cancel, and nothing rolls back | Cancel rules, answers 3 and 4 | 24, 25 |

## Dialog widths and the help pane

The width follows the step:

- The setup, progress, file-ready, failed, and stopped steps (states 02 to 05, 07 to 10, 12, 23, and 24) take the 480 px of the built device dialog (`device-dialog.css`, `.picker`). Every step fits 480 px without a cut label and without nested scrolling, so no step needs 560 px. A cut file name would take the ellipsis and its tooltip, and no file name of the scenario needs it.
- The dialog widens to 1120 px when the validation results arrive (state 13) and keeps 1120 px through the confirmation (state 16) and the execution results (states 17 and 17b). The other report states (14, 15, and 18 to 22) are 1120 px too. The tables keep the horizontal space that the owner asked for on version 1.
- The help pane docks beside a 480 px step: the dialog grows to 1000 px (the 480 px step and the 520 px pane), and the action bar stays under the step. The pane runs from the header to the bottom of the dialog, and the dialog takes the height of the taller column. On a 1120 px step the pane lies over the right 520 px of the body, above the action bar, as in version 3 (question 2). In both cases the primary action stays visible and the pane needs no scrolling. `render.cjs` asserts both for each help topic on a 480 px step and for the help over the report, the confirmation, and the execution results.

A job dialog of 480 px puts the import mode and the file name on a second subtitle line, so no item of the subtitle breaks.

## Execution results

States 17 and 17b show the result of each change, so that no person needs a job page.

Composition (top to bottom, 1120 px):

1. The count line reads as one sum, in the style of the count equation of the report: `11 changes = 2 Succeeded + 9 Pending` (state 17) and `11 changes = 10 Succeeded + 1 Failed` (state 17b). A term shows only when its count is above 0. The live indicator sits at the right in state 17. State 17b shows the end time there instead: `Finished Oct 28, 10:45 AM`, with the Finished label of the Jobs grid.
2. The four jobs follow as a compact secondary part: two jobs per row in body small type, each with its job ID as a secondary link, its action label, its status chip, and its progress lines (`job-fields.ts`). The running job adds a determinate `mat-progress-bar`.
3. The table keeps the structure of the validation results: Row, Device, Change, Current value, and New value, with the same column widths for Row, Device, and Change, so these columns stay in place when the results replace the report. The Result column copies the outcome cell of the job page: the small status chip with `OUTCOME_LABELS` and `outcomeTone`, the failure text under it (`.outcome-reason`, the text of `rowFailureText`), and a note under it (`.outcome-note`). The changes of one device share the row number and the device cell. A page holds at most 10 changes and never splits the changes of one device, so page 1 holds rows 2 to 7 (9 changes) and page 2 holds row 8 (2 changes).
4. The action bar keeps the Executed chip, the line `Executed by Review administrator · Oct 28, 10:44 AM`, and Done.

State 17, running: UPD-001 completed devices 1 and 2 (rows 2 and 3), so those two changes read Succeeded. The other six field changes read Pending inside the running job. The three status changes read Pending with the note `Starts after UPD-001 ends`, because the status jobs start after the update job ends. The jobs show UPD-001 Running with `2 of 6 complete · 4 pending` and a bar at 33 percent, and the three status jobs Queued with `0 of 1 complete`.

State 17b, finished: all four jobs ended. UPD-001, STS-001, and STS-003 Completed. STS-002 Failed with `0 succeeded · 1 failed`. The Re-enable of `04XTBHJ` shows Failed with the Google reason `A device with status ACTIVE does not allow this action.` under the chip.

Why the failure is plausible:

- The validation read `04XTBHJ` as Disabled. Another administrator re-enabled it in the Google Admin console after the validation and before STS-002 started.
- `batchChangeStatus` re-enables only a disabled device. Google answers each other status with `FAILED_PRECONDITION` and the message `A device with status <status> does not allow this action.` The Admin SDK mock of the review environment returns this answer (`device-writes.ts`, the REENABLE action accepts `DISABLED` only).
- The worker stores the answer as a failed operation with the reason `status-conflict` and the Google message (`worker/src/device-status-mock.test.mjs`). For a status job, `rowFailureText` shows the Google message under the failed row of the job page, so the dialog shows the same text.
- A job without a success and with one failure ends Failed (`device_update_terminal_status` in `017-jobs.sql`), and its progress lines read `0 succeeded` and `1 failed` (`job-fields.ts`).
- The app source holds the same message for the status `DEPROVISIONED` only, in its specs. The string of state 17b is therefore drafted.

Map from each change to one job operation (for engineering). The update job has one operation for each device and field: the device number counts the devices of UPD-001 in import row order, and the field is the field ID of `devices.ts`. Each status job has one operation for each device.

| Row | Device | Change | Job | Operation | State 17 | State 17b |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | `01P0T1V` | Annotated location | UPD-001 | device 1, `annotatedLocation` | Succeeded | Succeeded |
| 3 | `02A1MB6` | Notes | UPD-001 | device 2, `notes` | Succeeded | Succeeded |
| 4 | `02QJANY` | Annotated location | UPD-001 | device 3, `annotatedLocation` | Pending | Succeeded |
| 4 | `02QJANY` | Organization unit | UPD-001 | device 3, `orgUnitPath` | Pending | Succeeded |
| 5 | `04A9BVS` | Notes | UPD-001 | device 4, `notes` | Pending | Succeeded |
| 5 | `04A9BVS` | Deprovision | STS-003 | device 1 | Pending, starts after UPD-001 ends | Succeeded |
| 6 | `04QVJBY` | Disable | STS-001 | device 1 | Pending, starts after UPD-001 ends | Succeeded |
| 7 | `04XTBHJ` | Notes | UPD-001 | device 5, `notes` | Pending | Succeeded |
| 7 | `04XTBHJ` | Re-enable | STS-002 | device 1 | Pending, starts after UPD-001 ends | Failed |
| 8 | `0727D2E` | Asset tag | UPD-001 | device 6, `annotatedAssetId` | Pending | Succeeded |
| 8 | `0727D2E` | Notes | UPD-001 | device 6, `notes` | Pending | Succeeded |

UPD-001 holds 8 operations on 6 devices, the 8 field changes of the change line. STS-001, STS-002, and STS-003 hold one operation each. The 11 rows of the table are the 11 operations of the four jobs, and no change maps to two operations. Each table row carries its operation key in `data-operation` (for example `UPD-001-3-orgUnitPath` and `STS-002-1`).

The dialog needs the plan to keep this map: for each change, the job and the operation that run it. Question 3 proposes the source. A person returns to the execution results after Done or after closing the dialog through the Activity row of the import (question 4).

## Validation results audit

The validation results (states 13 to 15 and 18 to 22) keep the composition of version 3. The audit of version 4 found and fixed these points:

- The change line read `Deprovision 1 device · Retiring from fleet`. It now reads `Deprovision 1 device (Retiring from fleet)`.
- The device ID of row 33 (state 14) broke over two lines in version 3, and so did the device IDs and Checksum cells of the previews (states 02 to 12, 23, and 24). The table cells allowed a break at any letter. No value wraps inside itself now. A value keeps one line and ends in an ellipsis when it does not fit, and a `matTooltip` shows the full value while the ellipsis cuts it (the tooltip stays off for a value that fits). A path cuts at its start, so its last units stay in view. `render.cjs` checks every word of every visible text in every state and reports a word that breaks over two lines: 0 of 3,951 words in the PNG states.
- Row 12 showed the first 40 characters of its value with a typed ellipsis, so the cell held no way to read the value. The cell now holds the whole 300-character value, cut by the layout, with the full value in its tooltip and its length under it.
- Cells of one row sat on different lines when one cell held two lines (the deprovision reason, a long rejection reason). Every cell now aligns on the first line of its row, and a second line goes below it.
- The Row and Device columns were wider than their content. They are now 48 px and 124 px, the same in the report and in the execution results. The reasons and the warnings get the width.
- The review gives Current value 408 px, so the longest current path of the scenario (row 11 of IMP-002) shows whole. New value keeps room for the deprovision reason.

## Polish system

The visual rules of this pass. Every treatment maps to an Angular Material 22 component or to plain CSS with the tokens of `docs/ui/tokens.json` (the `--cc-*` properties of `theme/tokens.css`), so the frontend can build it. The app imports the button, checkbox, form field, icon, input, menu, radio, and select modules today. The tab nav bar, the progress bar, the tooltip, and the button toggle group of versions 3 and 4 come from the same `@angular/material` 22 package of the app lockfile.

Surfaces (Surface-First). One dialog hosts several surfaces in sequence:

| Step | States | Width | Surface | Composition |
| --- | --- | --- | --- | --- |
| Setup | 02, 03, 07, 09, 10 | 480 px | Configure | The choices in one column, then the raw data: the device count, the report columns, or the chosen file |
| Progress | 04, 12 | 480 px | Monitor | The phases with the current phase and a bar, then the counters |
| Ready file | 05, 08 | 480 px | Operate | One file card, Download CSV as the primary action |
| Report | 13 to 15, 18 to 22 | 1120 px | Compare | The count equation, the view tabs, one bounded table, the plan state |
| Confirmation | 16 | 1120 px | Operate | One column in reading order, the typed phrase above the destructive action |
| Result | 17, 17b | 1120 px | Monitor | The count sum, the jobs, and the result of each change in the report table |
| Failed or stopped | 23, 24 | 480 px | Monitor | The phases up to the stop, then the outcome |
| Help | 06, 11 | 1000 px | Learn | A documentation pane docked beside the 480 px step |

Layout and spacing:

- The setup, progress, and file steps keep the 480 px of the built dialog. The report, the confirmation, and the results take 1120 px. The 24 px edges are `space/xl`.
- A 480 px step stacks its groups in one column, 24 px apart (`space/xl`).
- The confirmation uses one column of `layout/content-max-width` (720 px), centered, as UI-03 asks for ordinary forms.
- Spacing steps on the 8 px grid: 4 px (`space/xs`) inside a line, 8 px (`space/sm`) between related items, 12 px (`space/md`) inside cards, 16 px (`space/lg`) between blocks and at the dialog wrap, 24 px (`space/xl`) at the dialog edges and between groups, and 48 px (`space/xxxl`) around an empty view.
- Radius: `radius/control` (4 px) for cards, tables, and fields, `radius/chip` for chips, counts, and the report columns, and the 28 px dialog corner of the built dialog.

Type scale (Roboto and Roboto Mono, the roles of the app theme):

| Role | Size and weight | Use |
| --- | --- | --- |
| Headline small | 24/32, 400 | The dialog title (the built dialog title) |
| Title large | 20/28, 500 | The confirmation question, the count values, the counters |
| Title small | 16/24, 500 | The file card name, the help title |
| Body medium | 14/20, 400 and 500 | Content, labels, buttons, and table cells |
| Body small | 12/16, 400 and 500 | Meta lines, table headers, the jobs of the results, the outcome notes, the quiet state line, and the help body |
| Section label | 12/16, 500, uppercase, 0.4 px tracking | Help section heads (the section style of the Activity panel) |
| Code | Roboto Mono 12/16 (11/16 in help tables) | Submitted values and codes |

Counts use tabular numerals (UI-04).

Color tokens:

- `text/primary`, `text/secondary`, and `text/disabled` for text. `text/link` for job IDs and eye links.
- `surface/card` for the dialog, `surface/app` for table heads and the drop zone, `surface/hover` for the file glyph, the tab counts, and the report columns, and `surface/selected` for the selected option card and the pressed help button.
- `border/default` for separators and cards. `border/control` for the dashed drop zone and the fields.
- `accent` for the selected card border, the phase dots, the progress bars, and the tab indicator.
- `status/*-text` for chip labels, count values, and the failure text, and `status/*` for the dots: success for Proposed, Re-enable, Succeeded, and Completed, warning for Disable and Expired, error for Rejected, Deprovision, and Failed, info for Open and Running, and neutral for field changes, Pending, and Queued.
- The M3 error container of the app theme (`--mat-sys-error-container` and `--mat-sys-on-error-container`) for the one-way Deprovision warning.

Treatments and their components:

| Treatment | States | Angular Material component or plain CSS |
| --- | --- | --- |
| Dialog widths | 02 to 25 | The shell of `device-dialog.css`: 480 px (`.picker`) for the setup, progress, file, failed, and stopped steps, 1120 px from the validation results on |
| Option cards | 02, 03, 07, 09, 10 | `mat-radio-group` with each `mat-radio-button` in a CSS card: `border/default`, selected with the `accent` border and `surface/selected`, disabled on `surface/app` with the reason line in `text/secondary`. Import mode puts its two cards side by side |
| Report columns | 07 | An ordered list in plain CSS: one static chip for each visible grid column in grid order, `radius/chip` on `surface/hover`, no border and no state layer, so no chip reads as a button |
| Drop zone | 09, 10 | Plain CSS (dashed `border/control` on `surface/app`) with `mat-stroked-button` Choose CSV file and a native drop handler |
| File item and file card | 05, 08, 09, 10 | A plain list item with the Material Symbols `csv` glyph and the status chip of `job-detail.css` |
| Phases | 04, 12, 23, 24 | The stepper dots of `bulk-action-sheet.css`, vertical, with `mat-progress-bar` mode determinate under the current phase |
| Counters | 12, 24 | The counters of `job-detail.css` without the card |
| Count equation and count sum | 13 to 15, 17 to 22 | A `dl` in plain CSS, values in `status/*-text` |
| View tabs | 13 to 15, 18 to 22 | `mat-tab-nav-bar` with `mat-tab-link` and a tab panel, each label with a count pill |
| Change-type chips | 13, 17 to 20 | The small status chip of `job-detail.css` |
| Cut values | 13 to 22 | Plain CSS ellipsis on one line (`dir="rtl"` with an isolated path, so a path keeps its end) and `matTooltip` with the full value, disabled while the value fits (`matTooltipDisabled`) |
| Report table and pager | 13 to 15, 17 to 22 | The table style of the job page, grouped rows aligned on their first line, and the built grid footer with the page buttons |
| Result column | 17, 17b | The outcome cell of `job-detail.html`: the small status chip with `OUTCOME_LABELS` and `outcomeTone`, `.outcome-reason`, and `.outcome-note` of `job-detail.css` |
| Jobs of the results | 17, 17b | A plain CSS list in two columns: job ID links in `text/link`, the small status chip, the progress lines of `job-fields.ts`, and `mat-progress-bar` for the running job |
| Job sequence | 16 | The stepper dots with bordered job lists and the status chips |
| One-way warning | 16 | The M3 error container |
| Typed phrase | 16 | `mat-form-field` appearance outline with `matInput` |
| Live indicator | 17 | The Updated live line of `job-activity.css` with a `status/success` dot. The pulse stops under reduced motion |
| Header | 02 to 24 | The title, the step context line, and two `mat-icon-button` controls with `matTooltip` |
| Action bar | 02 to 24 | The state at the left (a chip and a line, or the quiet line), the actions at the right with the primary action last: `mat-button`, `mat-stroked-button`, and `mat-flat-button` |
| Help pane | 06, 11 | A plain CSS docs panel of 520 px, `mat-button-toggle-group` for the topics, a `dl`, code chips, and compact tables. A CSS grid docks it beside a 480 px step |

Dark theme: the dark captures set `data-theme="dark"` on the root, as the theme menu of the app does. The tokens take their dark values from `tokens.css`, and the compiled theme switches through its `light-dark()` values. Every text of both captures passes the contrast check.

## Slop diagnostic

Scored with the ten tells of the claude-design skill (one point for each tell, lower is better).

Version 3: 0 of 10.

Version 4: 0 of 10.

- Tell 10, wrong surface, stays off with the narrow dialog: a 480 px step holds a short form, a phase list, or a file card in the built dialog width, with no empty half and no preview to fill it. The dialog takes 1120 px only for the tables that need the width.
- The results answer the question of the owner on one surface: the count sum, the jobs, and the result of each change, with the failure text where the change failed.
- Checked and not fired: no gradient, no glass, no accent rail, no icon topper, no monument stat (the count values stay 20 px, the size of the counters of the job page), no centered stack, no emoji, and no decorative illustration. The report columns are static chips without a state layer, not buttons.

## Changes from version 3

- 01 bulk-actions-menu: No change. The menu is the built Bulk Actions menu, and the PNG matches version 3.
- 02 export-dialog: The file preview is gone. The dialog takes the 480 px of the built device dialog: the device count in the subtitle and the Format cards.
- 03 export-over-limit: The file preview is gone. At 480 px the limit note sits above the Format cards, and the disabled action keeps its count.
- 04 export-running: The file preview is gone. At 480 px the two phases and the bar on Write rows (32 of 48) stay as in version 3.
- 05 export-ready: The file card of version 3 in the 480 px dialog, with Done and Download CSV.
- 06 export-help: The help pane docks beside the 480 px step. The dialog grows to 1000 px, and the action bar stays under the step.
- 07 reports-dialog: The report preview is gone. The six visible grid columns show as plain chips in grid order, under the Format cards, at 480 px.
- 08 reports-ready: The file card of state 05 for EXP-002, at 480 px.
- 09 import-dialog: The file preview is gone. At 480 px: Import mode in two cards, Source, the drop zone, and the chosen file as one item with its facts and header check.
- 10 import-header-check: The file preview is gone. The file item keeps the error border and the module refusal, at 480 px.
- 11 import-help: The help pane docks beside the 480 px Import step and keeps the Import topic.
- 12 validation-running: The file preview is gone. At 480 px: the five phases, the bar on the stale refresh (6 of 9), and the counters Rows read and Edited rows.
- 13 review-proposed: The change line reads Deprovision 1 device (Retiring from fleet). Every cell aligns on the first line of its row, and no value wraps inside itself.
- 14 review-rejected: The 300-character value keeps one line with an ellipsis, a tooltip, and its length. The reasons align on the first line of each row.
- 15 review-warnings: Each warning aligns on the first line of its row. The narrower Row and Device columns give the warning text more room.
- 16 execute-confirm: No content change. The dialog keeps the 1120 px of the results, and the typed phrase stays above the action bar.
- 17 executed: The result of each change in the table of the report with a Result column. The count line reads as one sum. The four jobs move to a compact band.
- 17b execution-finished: New: all four jobs ended. 10 changes succeeded, and the Re-enable of 04XTBHJ failed with the Google reason. The end time replaces the live indicator.
- 18 sync-all-rows-review: Each path keeps one line. A path that does not fit cuts at its start, keeps its last units in view, and shows the whole path in a tooltip.
- 19 plan-expired: The corrections of state 13: first-line alignment, the new column widths, and no value that wraps inside itself.
- 20 plan-cancelled: The corrections of state 13 for the one change of IMP-003.
- 21 no-update-needed: No visible change besides the narrower Row and Device columns of the empty table.
- 22 rejected-only: The submitted values and the reasons align on the first line of each row. No value wraps inside itself.
- 23 validation-failed: The file preview is gone. At 480 px the phases stop at the failed header check, and the refusal and the note follow.
- 24 validation-cancelled: The file preview is gone. At 480 px the phases stop at the stopped refresh (4 of 12), with the counters Rows read and Rows to compare.
- 25 update-cancel-confirm: No change. The job page and its question are built, and the PNG matches version 3.
- 26 jobs-grid: No change. The Jobs grid rows are built, and the PNG matches version 3.
- dark 13 review-proposed: State 13 in the dark theme, with the corrections of state 13.
- dark 17b execution-finished: New: state 17b in the dark theme. It replaces the dark capture of state 16.

## Changes from version 2

- 01 bulk-actions-menu: No change. The menu is the built Bulk Actions menu.
- 02 export-dialog: The empty right two thirds now hold a file preview of the ten template columns with rows 2 to 4. Format moves into stacked option cards.
- 03 export-over-limit: The limit note sits above the option cards, and the preview names 62,480 rows. The disabled action keeps its count.
- 04 export-running: The spinner row becomes two phases with a determinate bar on Write rows (32 of 48). The closing line moves to the action bar in a quiet style.
- 05 export-ready: One file card holds the name, the Ready chip, the size, rows, columns, and the expiry. Download CSV stays the primary action.
- 06 export-help: The help pane takes documentation type: uppercase section heads, a compact column table, and code chips. It grows from 480 px to 520 px.
- 07 reports-dialog: The column chips become a report preview: the six visible grid columns in grid order with rows 2 to 4.
- 08 reports-ready: The file card of state 05 for EXP-002.
- 09 import-dialog: Option cards for Import mode and Source, a drop zone with Choose CSV file, the chosen file as one item with its facts and header check, and the file preview.
- 10 import-header-check: The file item takes the error border and the module refusal. The preview shows the file without its Device ID column.
- 11 import-help: The Import topic shows the modes as a definition list and the status and reason codes as compact code tables.
- 12 validation-running: The spinner row becomes the five validation phases with a determinate bar on the stale refresh (6 of 9), the counters, and the file preview.
- 13 review-proposed: The counts read as one equation in semantic colors. Tabs with counts replace the toggle group. Each change shows a change-type chip and an arrow to the new value.
- 14 review-rejected: Each reason shows an error icon in the error text color. The submitted value keeps the code type.
- 15 review-warnings: Each warning shows a warning icon. The header row reads Header row.
- 16 execute-confirm: One centered 720 px column replaces two half-empty columns: the numbered job sequence, the one-way warning in the error container, and the typed phrase directly above the action bar.
- 17 executed: The jobs table becomes compact numbered job rows with status chips, progress bars, and the live indicator. The dialog takes the height of its content.
- 18 sync-all-rows-review: The report of IMP-002 in the new report layout.
- 19 plan-expired: The new report layout. The action bar keeps the Expired chip, Validate again, and the disabled Execute.
- 20 plan-cancelled: The new report layout. The action bar keeps the Cancelled chip and the cancel line.
- 21 no-update-needed: The empty view shows its message in the middle of the bounded table.
- 22 rejected-only: The new report layout with the rejected rows view and the No changes chip in the error tone.
- 23 validation-failed: The phases stop at the failed header check. The refusal and the note follow, and the file preview stays.
- 24 validation-cancelled: The phases stop at the stopped stale refresh (4 of 12). The note, the counters, and the stored reads follow.
- 25 update-cancel-confirm: No change. The job page and its question are built.
- 26 jobs-grid: No change. The Jobs grid rows are built.
- dark-13 review-proposed: New: state 13 in the dark theme.
- dark-16 execute-confirm: New: state 16 in the dark theme.

## Changes from version 1

1. Export and Reports are two entries. Bulk Actions holds Export, Reports, and Import below a divider (state 01). Export is the edit export with the ten template columns of the module (states 02 to 06). Reports writes the visible grid columns in grid order, as EXP-002 with the report purpose (states 07 and 08). This replaces version 1 choice 2, the Purpose group with a disabled Report option.
2. A wide dialog replaces the 400 px side sheet. Export, Reports, and Import open one 1120 px modal dialog over the Devices grid (states 02 to 24, choices 2 and 3). This replaces version 1 choices 2, 3, 6, and 7, which placed the forms in the sheet, and design gap 8.
3. The person needs no job page to finish a flow.
   - Export and Reports show a progress row, then the file card with Download CSV, in the same dialog (states 04, 05, and 08). This replaces the receipts of version 1 choice 4 and the export job page of choice 5.
   - Import shows a progress row while validation runs, then the validation report in the same dialog (states 12 to 15 and 18 to 22). This replaces the receipt of choice 4, the running validation page of choice 15, and the review on the job page of choice 8.
   - Execute, its confirmation, and the result stay in the dialog (states 16 and 17). This replaces the question over the job page of choice 12 and the executed Plan card of choice 13. Version 1 state 16, the waiting status job page, is gone: state 17 shows the waiting status jobs.
   - The jobs still exist. The secondary line of the dialog names each job ID as a link, the bell counts a running job, and the Jobs grid lists every job (state 26).
4. Instructions leave the flow. Each dialog header holds an info icon button that opens the help pane (states 06 and 11, choice 5). The help holds the template columns, the editing rules, `[clear]`, the Checksum column, import never creates devices, the two modes, the status and reason codes, the 50,000-row limit, the 30-day file expiry, the 1-hour plan expiry, and Execute runs valid rows only. This replaces the Rules paragraph, the mode lines, and the code disclosure of version 1 choice 6, and the column list of choice 2.
5. Status messages stay in the flow: the header check refusal (state 10), the over-limit note (state 03), the expired plan (state 19), the failed and stopped validations (states 23 and 24), and each count.
6. The plan state moves from the Plan card of the job page to the action bar of the dialog, beside the actions that it gates (choice 12). It keeps the chips of version 1 choice 11.

## States

| # | PNG | Size | Capture | Content |
| --- | --- | --- | --- | --- |
| 01 | `png/01-bulk-actions-menu.png` | 1440 x 900 | full page | Devices grid with 48 selected devices. Bulk Actions open: the three built entries, a divider, then Export, Reports, and Import. |
| 02 | `png/02-export-dialog.png` | 1440 x 900 | viewport, dialog fixed to it | Configure, 480 px. The selected device count in the subtitle and the Format option cards. |
| 03 | `png/03-export-over-limit.png` | 1440 x 900 | viewport, dialog fixed to it | Configure, 480 px. Select All of 62,480 devices: the limit note above the cards, and Export 62,480 devices disabled. |
| 04 | `png/04-export-running.png` | 1440 x 900 | viewport, dialog fixed to it | Monitor, 480 px. EXP-001 writes the file: two phases, Write rows 32 of 48 with a determinate bar, and the quiet closing line. |
| 05 | `png/05-export-ready.png` | 1440 x 900 | viewport, dialog fixed to it | Operate, 480 px. The file card of EXP-001: name, Ready chip, facts, and expiry. Download CSV is the primary action. |
| 06 | `png/06-export-help.png` | 1440 x 900 | viewport, dialog fixed to it | Learn. The help pane docks beside the 480 px Export step (1000 px in total) on the Export topic. |
| 07 | `png/07-reports-dialog.png` | 1440 x 900 | viewport, dialog fixed to it | Configure, 480 px. The Format cards and the six visible grid columns of the report in grid order as plain chips. |
| 08 | `png/08-reports-ready.png` | 1440 x 900 | viewport, dialog fixed to it | Operate, 480 px. The file card of EXP-002 with Download CSV. |
| 09 | `png/09-import-dialog.png` | 1440 x 900 | viewport, dialog fixed to it | Configure, 480 px. Import mode and Source as option cards, the drop zone, and the chosen file with its facts and its passed header check. |
| 10 | `png/10-import-header-check.png` | 1440 x 900 | viewport, dialog fixed to it | Configure, 480 px. The chosen file fails the header check: the module refusal in the file item. Start validation is disabled. |
| 11 | `png/11-import-help.png` | 1440 x 900 | viewport, dialog fixed to it | Learn. The help pane docks beside the 480 px Import step on the Import topic: the modes, the rules, and the code tables. |
| 12 | `png/12-validation-running.png` | 1440 x 900 | viewport, dialog fixed to it | Monitor, 480 px. IMP-001: five phases, Refresh stale devices 6 of 9 with a determinate bar, and the counters Rows read and Edited rows. |
| 13 | `png/13-review-proposed.png` | 1440 x 900 | viewport, dialog fixed to it | Compare, 1120 px. The count equation, the change line, the tabs with counts, and 9 of 11 proposed changes with change-type chips. |
| 14 | `png/14-review-rejected.png` | 1440 x 900 | viewport, dialog fixed to it | Compare. The 4 rejected rows with their reasons. The 300-character value keeps one line with an ellipsis and a tooltip. |
| 15 | `png/15-review-warnings.png` | 1440 x 900 | viewport, dialog fixed to it | Compare. The 3 warnings. |
| 16 | `png/16-execute-confirm.png` | 1440 x 900 | viewport, dialog fixed to it | Operate, 1120 px. One 720 px column: the job sequence, the rows that stay out, the one-way warning, and DEPROVISION typed. |
| 17 | `png/17-executed.png` | 1440 x 900 | viewport, dialog fixed to it | Monitor. The result of each change: 11 changes = 2 Succeeded + 9 Pending, the four jobs in a compact band, and the live indicator. |
| 17b | `png/17b-execution-finished.png` | 1440 x 900 | viewport, dialog fixed to it | Monitor. All four jobs ended: 11 changes = 10 Succeeded + 1 Failed, the Google reason under the failed Re-enable, and the end time. |
| 18 | `png/18-sync-all-rows-review.png` | 1440 x 900 | viewport, dialog fixed to it | Compare. IMP-002, Sync all rows, the library reset: 4 moves to /Library and 7 Annotated user clears. |
| 19 | `png/19-plan-expired.png` | 1440 x 900 | viewport, dialog fixed to it | Compare. IMP-002 after its plan expired: Execute disabled and Validate again. |
| 20 | `png/20-plan-cancelled.png` | 1440 x 900 | viewport, dialog fixed to it | Compare. IMP-003 after Cancel import: nothing ran, and the report stays readable. |
| 21 | `png/21-no-update-needed.png` | 1440 x 900 | viewport, dialog fixed to it | Compare. IMP-004, an unedited export: 48 rows unchanged. The empty view and a disabled Execute. |
| 22 | `png/22-rejected-only.png` | 1440 x 900 | viewport, dialog fixed to it | Compare. IMP-005: 6 rows = Unchanged 2 + Rejected 4. Nothing can run. |
| 23 | `png/23-validation-failed.png` | 1440 x 900 | viewport, dialog fixed to it | Monitor, 480 px. IMP-006 Failed at the header check: Sync changes and a file without a Checksum column. |
| 24 | `png/24-validation-cancelled.png` | 1440 x 900 | viewport, dialog fixed to it | Monitor, 480 px. IMP-007 stopped during the stale refresh (4 of 12). No report and no plan. |
| 25 | `png/25-update-cancel-confirm.png` | 1440 x 900 | viewport, dialog fixed to it | Unchanged from version 3: UPD-001 running with the cancel question that names the waiting status jobs. |
| 26 | `png/26-jobs-grid.png` | 1440 x 1749 | full page | Unchanged from version 3: the Jobs grid with the 13 new jobs above the 6 real rows. |
| D13 | `png/dark-13-review-proposed.png` | 1440 x 900 | viewport, dialog fixed to it, dark theme | State 13 in the dark theme of the app (tokens.css dark values and the compiled theme in the dark color scheme). |
| D17b | `png/dark-17b-execution-finished.png` | 1440 x 900 | viewport, dialog fixed to it, dark theme | State 17b in the dark theme of the app. |

The HTML also shows interactions that no PNG captures:

- Close the dialog of state 09 and open Bulk Actions: the menu without a selection.
- The info button on every step, its tooltip on hover and on keyboard focus, the four help topics, the docked help on each 480 px step, and the help over the report, the confirmation, and the results.
- A cut value in a table shows its full text in a tooltip on hover: the path of row 4 in state 17b and the value of row 12 in state 14. A value that fits shows no tooltip, for example the path of row 11 in state 18.
- Create report in state 07: the progress of EXP-002. Click the phase list: the job ends, and the dialog shows the next state.
- The view tabs and Next results page in state 13: the changes of row 8.
- Stop validation and Close in state 12. Validate again in state 19: IMP-008 runs. Cancel import in state 13: the cancelled plan of IMP-001.
- Execute with a wrong and a right phrase in state 16. Next results page in states 17 and 17b: the results of row 8. Click the count sum of state 17: the jobs end, and the dialog shows state 17b. The job ID link UPD-001 in state 17 opens the job page. Cancel pending work on the job page opens the question of state 25.

## Scenario and data

- The person is the review build account, "Review administrator". Times are Wednesday, Oct 28, 2026, US Eastern, in the app time format.
- The header and the navigation keep the connected domain `easton-consulting.com` and the simulated customer ID of the review build.
- The inventory is the 7,000 devices of the update device fields review. The grid shows the devices in serial order, so an edit export of the first 48 devices holds them in rows 2 to 49.
- The 48 selected devices are the first 48 by serial. The eight visible grid rows are selected.
- EXP-001 writes `devices-for-editing-EXP-001.csv` at 10:31 AM: 48 rows and the ten template columns. The download expires 30 days later, Nov 27, 10:31 AM.
- EXP-002 writes `device-report-EXP-002.csv` at 10:35 AM: 48 rows and the six visible grid columns. The grid of the background screenshot shows Serial, Model, Asset tag, Organization unit, and Battery. Device contact sits right of the horizontal scroll edge. `device-fields.ts` shows these six fields by default and hides Status, Annotated user, Annotated location, and Notes.
- IMP-001 validates the file of EXP-001 in Sync changes at 10:40 AM. Its plan expires at 11:42 AM. Its seven proposed devices are the visible grid rows, so names stay consistent with states 01 to 08.
  - Device 1 `01P0T1V`: Annotated location Room 12 to Room 14.
  - Device 2 `02QJANY`: Annotated location Science wing to North lab, and Organization unit `/Chrome Devices/Lowell Academy/Grade 9` to `/Library`.
  - Device 3 `02A1MB6`: Notes Loaner cleared with `[clear]`.
  - Device 4 `0727D2E`: Asset tag CB971140 back to the file value CB970992, and Notes Cart 3 (example F). Another administrator moved the tag to a replacement device and tagged `0727D2E` CB971140 after the export.
  - Device 5 `04A9BVS`: Notes Retired, and Deprovision with the reason Retiring from fleet (example G).
  - Device 6 `04QVJBY`: Disable.
  - Device 7 `04XTBHJ`: Notes Returned to library, and Re-enable from the echo of `ACTIVE` (example I).
- Rows 12, 19, 27, and 41 hold devices outside the visible grid. Their serials follow the serial order. Row 33 holds a device ID that Campus Commander does not hold.
- State 12 shows IMP-001 at 48 rows read, 13 candidate rows, and 6 of 9 stale devices refreshed.
- IMP-002 is the library reset of example K: `library-reset.csv` without a Checksum column, 30 rows, 4 moves to `/Library`, and 7 Annotated user clears, validated at 9:14 AM. Its plan expires at 10:15 AM. Annotated user values follow the review data form `name@example.org`.
- IMP-003 to IMP-007 are the variants of states 20 to 24. IMP-008 exists only as the live result of Validate again.
- The update job UPD-001 answers one row per device and field (8 rows), and its progress counts one operation per device (6), as built. States 17 and 25 show 2 succeeded devices and 4 pending.
- Job numbers continue the real Jobs grid screenshot. It shows REF-001 and CMD-001 to CMD-005.

Version 3 data that version 4 keeps:

- File sizes are mockup data: 7.8 KB for the edit file, 5.3 KB for the report, 6.0 KB for the file without a Device ID column, and 2.9 KB for the library reset.
- The phases of a validation follow section 10.1 of the technical design: upload, header check, refresh of the stale devices, comparison, and report. An export writes the rows, then prepares the download.

Version 4 removes the data of the file previews (rows 2 to 4 of each file, the device IDs, and the Checksum cells) and adds:

- The value of row 12 of IMP-001 holds exactly 300 characters. Version 3 showed its first 40 characters. The template asserts the length on load.
- The second counter of a validation names the rows that the comparison reads: Edited rows for Sync changes (state 12) and Rows to compare for Sync all rows (state 24 and the live IMP-008). Version 3 named both Candidate rows.
- The execution results of IMP-001 (states 17 and 17b): the outcome of each of the 11 operations, the progress of the four jobs, and the end time Oct 28, 10:45 AM. Execution results describes the failure of the Re-enable of `04XTBHJ`.

## Fidelity and calibration

Backgrounds come from real screenshots of the review builds of 2026-10-22 and 2026-10-23. `build.py` composes them again from the same screenshots with the pixel assertions of version 2:

- `bg-devices-sel-1440x900.png`: `step1-06-grid-after.png` with the grid rows of `setup-devices.png` moved up 58 rows. Eight rows take the look of the real selected row `01P0T1V`.
- `header-box-checked.png`: state 03 (Select All). The header box takes the checked box of row `01P0T1V`.
- `bg-devices-none-1440x900.png`: `setup-devices.png` (no selection) with the header and navigation of `step1-06`.
- `bg-jobs-1440x2400.png` and `footer-1440x40.png`: the Jobs shell of `step1-07-job-detail.png` and the page footer of `lost-02-job-detail-rows.png`.
- `bell-running.png`: the bell with the running badge, a real crop of `step2-06-wipe-job.png`. States 04, 12, and 17 show it, because a job runs.
- `bg-grid-1440x1749.png`: `jobs-attention-expired.png`. The six real rows move down by the height of the thirteen drawn rows. `render.cjs` asserts that height.
- The dark captures have no dark screenshot of the review build. The page behind the scrim is drawn with the dark tokens: the shell copies `shell.html` and `shell.css` of the app, and the page keeps the geometry and the strings of the light screenshot, with the connected domain and the simulated customer ID. The string check does not cover this drawn background.

The overlays use the app CSS. `work/material/extract.py` takes the Angular Material 22 component CSS from the `node_modules` of the review checkout: button, icon button, icon, radio, form field, menu, divider, button toggle, tab nav bar and tab link, progress bar, tooltip, focus indicator, and ripple. Roboto, Roboto Mono, and Material Symbols are the `@fontsource` files of the app. The theme is the version 2 compile of `styles.scss`.

States 01, 25, and 26 stay pixel-identical to version 3: the PNGs match in every pixel. PR #157 changes no visible string of these states. It moves the cancel banner text of the job page into `cancelBanner` and adds the command variant, and it names the saved-none count of a cancelled Refresh all. State 25 shows the cancel question, not the banner, and no row of state 26 is a cancelled Refresh all. Every string of the three states keeps its class in the string check against `5f50d7c`.

Calibration (`work/cal/cal.py`) re-creates real screen regions with the mockup CSS over backgrounds that lack the real content, and diffs them. The pass mark is a mean absolute difference under 0.2 per pixel and channel. The control is the background alone. Version 4 keeps the five cases of versions 2 and 3. They guard the built parts that version 4 keeps: the job page, the Jobs grid, the dialog shell, the status bar, and the menu.

| Case | Real screenshot | Mean | Control |
| --- | --- | --- | --- |
| job-update | `step1-07-job-detail.png`, the job page | 0.003 | 7.188 |
| jobs-grid | `jobs-attention-expired.png`, six grid rows and the footer | 0.000 | 4.627 |
| dialog | `step2-02-ou-selected.png`, the dialog shell | 0.000 | 86.716 |
| status-bar | `step1-06-grid-after.png`, the grid status bar | 0.108 | 4.628 |
| menu | `step1-granted.png`, the open Bulk Actions button and menu | 0.108 | 91.569 |

- The status bar case differs only in the inventory time, which is scenario data.
- No screenshot shows a Material tab nav bar, a progress bar, or a tooltip in this app. They use the Material CSS and DOM without a calibration.
- The 480 px steps take the width and the shell of the built dialog that the case dialog compares.

Render checks (`render.cjs`, `render-report.json`): every request except `file:` and `data:` aborts. The render made 4 requests, with 0 page errors, 0 console errors, and 0 overflow, clipping, scrolling, width, word-break, or contrast problems in the PNG states and in 14 live variants. The checks assert that the dialog stays inside the area under the header with the 16 px wrap padding, that each step takes its width (480 px, 1000 px with the docked help, or 1120 px), that no dialog body and no help pane scrolls at 1440 x 900, that the help never covers the primary action, that the action bar keeps one row, that a report table shows one page at most, that no word breaks over two lines, that each value cut by an ellipsis carries its tooltip (4 cut values in the PNG states), and that every visible text meets 4.5 to 1 against its composed background (3 to 1 for large text), in both themes. The lowest text contrast of all captures is 4.51 to 1. The click test covers the menu, each dialog, the help button and topics on narrow and wide steps, the tooltips on hover and on keyboard focus, the tooltips of cut values, the phase lists, the view tabs and paging, Execute with a wrong and a right phrase, the paging of the results, the end of the jobs, the job ID link, Back to review, Cancel import, Stop validation, Close while a job runs, Validate again, the cancel question, Escape, and deep links on a fresh load and on a hash change.
Forbidden letter sequences: the base64 data of the HTML held 105 chance hits before `build.py` broke them with a space. The byte scan of every file in the output folder finds 0 outside this file. `check-strings.py` scans this file too.

## Composition choices

Version 4 keeps the choices of version 3 and changes the ones below. The text of version 3 follows the list.

- Choice 2, the dialog width: 480 px for the setup, progress, file, failed, and stopped steps, 1120 px from the validation results on (Dialog widths and the help pane).
- Choice 3, the dialog height: a 480 px step follows its content. A 1120 px step takes the full area under the header less the 16 px wrap padding, so the action bar stays in place from the report through the results.
- Choice 5, the help pane: docked beside a 480 px step, over the right 520 px of a 1120 px step.
- Choices 6, 9, and 10, the setup steps: no file preview. Export shows the device count and the Format cards. Reports adds the visible grid columns as static chips in grid order. Import shows the mode, the source, the drop zone, and the chosen file with its facts and its header check.
- Choice 11, the report: no value wraps inside itself, every cell aligns on the first line of its row, and the change line names the deprovision reason in parentheses.
- Choice 17, the result: the result of each change in the table of the report with a Result column, the count line as one sum, and the four jobs as a compact secondary part.
- New choice 25: a value that does not fit its cell keeps one line, ends in an ellipsis, and shows its full text in a tooltip. A path cuts at its start.

Version 3 text:

Version 3 keeps the choices of version 2 and changes the ones below. The text of version 2 follows the list.

- Choice 3, the dialog height: the setup, progress, file, failed, and stopped steps follow their content from a 400 px minimum. The report steps and the confirmation take the full area under the header less 24 px margins (788 px at 1440 x 900), so the action bar stays in place from the report to the confirmation. The result (state 17) follows its content, because its jobs fill a third of the full height.
- Choice 5, the help pane: 520 px instead of 480 px, so each topic fits without scrolling. Each icon button of the header shows its name in a `matTooltip` below it on hover and on keyboard focus.
- Choice 6 and choice 9, Export and Reports: the Format choice becomes two option cards, and the file preview shows what the step writes. The preview replaces the column chips of Reports.
- Choice 7, the progress: the phases of the job with a determinate bar under the current phase replace the spinner row of the Activity panel. The closing line moves to the left of the action bar in the quiet style.
- Choice 8, the ready file: one file card with the name, the Ready chip, the facts, and the expiry.
- Choice 10, the Import form: option cards for the mode and the source, a drop zone with Choose CSV file, and the chosen file as one item with its facts and the header check. The preview reads rows 1 to 4 of the chosen file in the browser, as the header check does.
- Choice 11, the report: the counts read as one equation, Rows = Unchanged + No change needed + Proposed + Rejected. Tabs with counts replace the segmented filter. The rows of one device share its row number and device cell. Each change shows a change-type chip, the current value in the secondary color, and an arrow to the new value in medium weight.
- Choice 16, the confirmation: one column of 720 px reads in order: the question, the job sequence, the rows that stay out, the one-way warning, and the typed phrase directly above the action bar.
- Choice 17, the result: compact job rows in the job sequence, with the job ID link, the action, the scope, the status chip, and the progress with a bar for the running job. The live indicator sits right of the lead line.
- New choice 23: an empty view shows its message in the middle of the bounded table, as the grid overlay of the app does.

Version 2 text:

1. Bulk Actions holds Export, Reports, and Import below a divider, after the built Update device, Send command, and Change status (state 01). Import needs no selection, so Bulk Actions stays enabled without one. Without a selection, the menu disables every entry except Import (the HTML shows it).
2. One dialog width for Export, Reports, and Import: 1120 px. At 1440 x 900 it leaves 160 px of the page at each side under the scrim. The five-column report table keeps one line per row at this width for most values. The tokens define no dialog width. The built dialog shell is 480 px.
3. The dialog height follows the content from a 400 px minimum on the setup, progress, and file steps, and on the failed and stopped validations. From the report on, and while the help pane is open, the dialog takes the full area under the header less 24 px margins: 788 px at 1440 x 900. No step scrolls at 1440 x 900, and `render.cjs` asserts it. A report view shows one page of 10 rows with the built grid footer and paging buttons, so each table stays explicitly bounded. In a shorter window, the dialog body is the one scroll region.
4. Each dialog keeps one title for all its steps, without a stepper: "Export devices", "Create a report", and "Import devices". The secondary line carries the step. Before the job, it reads like the built sheet subtitle: "48 selected devices · Not submitted". After the job starts, it reads like the built job subtitle, "Job EXP-001 · Running", with the job ID as a link, and an import adds the mode and the file. The action bar holds the state at the left (a chip and a line) and the actions at the right, with the primary action last.
5. The help docs show in a pane inside the dialog. The info icon button (Material Symbols `info`) sits in the dialog header left of Close. Its accessible name is "Export and import help", and it carries `aria-expanded` and `aria-controls`. While the pane is open, the button takes the open style of the Activity button. The pane covers the right 480 px of the dialog body. The setup forms end left of it, so it hides nothing there. Over a report, it hides the right columns until the person closes it, so the report never narrows. One segmented control switches four topics: Export, Reports, Import, and Review. The pane opens on the topic of the current step, Review from the report on. Each topic fits the pane at 1440 x 900.
6. Export (states 02 to 05): the scope sits in the secondary line. The form holds Format only: CSV file, and Google Sheet disabled with the Drive note. The action names the count, "Export 48 devices". Over the limit (state 03), an error note names the limit and the selection size, and the disabled action names the note for a screen reader.
7. A running job shows the progress row of the Activity panel in the dialog: the spinner, the title, a line, and the bar (states 04 and 12). The bell shows the running badge. A meta line says that closing the dialog keeps the job running. Close is the primary action while a job runs. In this mockup, a click on the progress row ends the job.
8. A finished export shows a file card (states 05 and 08): the file name, a Ready chip, the format, rows, and columns, and the expiry 30 days after the export. Download CSV is the primary action. Done closes the dialog.
9. Reports shows the columns that it exports as chips in grid order under "Visible grid columns" (state 07). The chips follow the grid configuration at the time of the report. The ready file names the column count (state 08).
10. The Import form holds Import mode (Sync changes, Sync all rows) and Source (Upload a CSV file with Choose CSV file, and Google Drive disabled with the Drive note), as labels only (state 09). The header check line sits under the chosen file: a passed check, or the module refusal (state 10). After a refusal, Start validation is disabled and names the refusal for a screen reader.
11. The validation report fills the same dialog (states 13 to 15 and 18 to 22). The counts read as one sum, Rows = Unchanged + No change needed + Proposed + Rejected (version 1 choice 10). A line under the sum counts the field changes and each status action. A meta line names the stale refresh, the oldest observation, and the Sync all rows rule. A segmented filter switches Proposed changes, Rejected rows, and Warnings, each with its count. Download rejected rows sits right of the filter. Each view is one table with source row numbers and eye links to the devices. The table footer stays at the bottom of the region, so paging keeps its place across the views.
12. The plan state sits in the action bar, beside the actions that it gates (version 1 choice 11 adapted). Open names the expiry, with Cancel import and Execute (state 13). Expired disables Execute and offers Validate again (state 19). Cancelled names the person and the time and offers Import again (state 20). No changes disables Execute (state 21). No changes in the error tone says that nothing can run and offers Import again (state 22). Executed names the person and the time (state 17).
13. The stop action of a running validation reads "Stop validation". It is an outlined button left of Close (state 12). It reads apart from Cancel import, which cancels a plan, and from Cancel pending work, which cancels a job on the job page. It applies at once, because nothing reached Google. The job ends Cancelled, and the dialog shows the stopped validation (state 24).
14. Closing the dialog while validation runs keeps the job running. The bell counts it. The person returns without the job page in two ways: the Activity row of the validation opens the Import dialog at its current step, and Import in Bulk Actions reopens the latest import of the person while its validation runs or its plan stays open. No PNG shows the return. Question 17 asks for it.
15. Closing the dialog with an open plan keeps the plan open until it expires. Only Cancel import cancels it. Done, Close, Escape, and a click on the scrim close the dialog only.
16. The Execute confirmation is a step of the same dialog, not a second modal (state 16). The confirmation needs the width of the jobs table, and a 480 px question over the 1120 px dialog would hide the report anyway. The step shows the four jobs and their order, the rejected rows that stay out, the built Deprovision paragraphs, and the typed phrase field with the built label. The destructive Execute names the change count. Back to review returns to the report. The action bar keeps the plan state.
17. The executed view follows the jobs live (state 17). One table lists UPD-001 and the three status jobs with their status chips, the built progress lines, a bar for the running job, and "Starts after UPD-001 ends" for each waiting status job. Each job has an eye link to its job page. Done closes the dialog. The jobs continue in the Jobs grid and Activity.
18. State 25 reuses version 1 state 15 unchanged. Main `1fe79c3` builds the job page toolbar with Refresh and Cancel pending work, and the question dialog, as version 1 drew them. The question adds one drafted sentence that names the waiting status jobs (version 1 choice 14, design gap 10).
19. Where a module text reads poorly, the PNG keeps the module text and this list proposes a better one (version 1 choice 18):
    - "Asset tag cannot be cleared. Asset tag offers Replace only." Proposed: "Asset tag cannot be cleared. Write a new tag, or leave the cell blank to keep the current tag."
    - "Organization unit cannot be cleared. Organization unit offers Move only." Proposed: "Organization unit cannot be cleared. Write a unit path, or leave the cell blank to keep the current unit."
    - One status refusal covers a missing reason code (row 5 of state 22) and a lowercase code (row 7). Proposed: keep the code list sentence, and lead with the mistake: "DEPROVISION needs a reason code." or "Status codes are upper case. Write ACTIVE."
    - "The file is missing the Checksum column." State 23 adds the drafted line "Sync changes needs the Checksum column. Sync all rows ignores it." Proposed for the module: one message with both sentences.
    - The list of two missing columns reads "the Device ID, and Checksum columns". Proposed: "the Device ID and Checksum columns". No state shows it.
20. The failed and stopped validations keep their state in the flow: no report and no plan exist, and nothing reached Google (states 23 and 24). The failed one shows the module refusal and a drafted line that names Sync all rows, as section 18 of the technical design requires. The stopped one shows the cancel request line of the built job page and the stale device reads that stay stored. Both offer Import again.
21. The new jobs use the built Jobs grid row (state 26). EXP and IMP progress lines count rows. The PNG grows the grid region to show all 19 rows. The app region scrolls.
22. Mockup only: the state switcher is a pill at the bottom left that opens the list of states. The pill ends left of the dialog, so it covers no part of a dialog.

## Questions for the owner

Only points that change a behavior or a data outcome. Each one has a proposed answer.

1. Carried from version 3, question 3: the phase lists (states 04, 12, 23, and 24) need each job to report its current phase and the counts of that phase, for example 6 of 9 stale devices. Proposed answer: the job status document carries the phase name and its done and total counts, and the dialog reads them with the job status it reads today.
2. Carried from version 3, question 4: the help pane covers the right 520 px of a 1120 px step while it is open (the report, the confirmation, and the results). Proposed answer: keep the overlay, so the report never narrows. Closing the help shows the full report again. A 480 px step docks the pane beside it.
3. The execution results need the outcome of each change. Proposed answer: the plan keeps, for each change, the job and the operation that run it (Execution results), and the dialog reads the operations of the four jobs with the job detail API that the job page uses.
4. The return to the execution results after Done or after closing the dialog. Proposed answer: the Activity row of the import opens the dialog at the execution results, as eng-lead answer 3 returns a person to a running or finished job.
5. A status change whose device changed status after the validation (state 17b). Proposed answer: the status job sends the change and keeps the Google refusal as a failed operation, as the built status jobs do. The import does not read the status again before the call. The person reads the reason in the results and imports again when a change is still needed.
6. The results after a person cancels UPD-001 (state 25). Proposed answer: the changes that did not reach Google read Cancelled with the note `Not sent to Google` (`outcomeNotes`), and the waiting status changes read Cancelled, because their jobs end Cancelled and never start.
7. Carried from version 2, question 2: the header check runs in the browser, so state 23 needs a source that the browser does not read. Proposed answer: keep state 23 as the server guard.
8. Carried from version 2, question 3: row 8 returns tag CB970992 to `0727D2E` while a replacement device holds it. Proposed answer: warn and run the change, as answer 1 of the defaults lets the person deconflict before Execute.
9. Carried from version 2, question 6: the help does not list the field limits of `devices.ts`. Proposed answer: add a Field limits table to the Import topic.
10. Carried from version 2, question 8: the file of Download rejected rows. Proposed answer: the ten template columns plus the source row number and the reason.
11. Carried from version 2, question 10: the plan expiry while the dialog stays open. Proposed answer: the action bar switches to Expired at the expiry time, and Execute checks the expiry on the server.
12. Carried from version 2, question 13: the module lists two missing columns as "the Device ID, and Checksum columns". Proposed answer: "the Device ID and Checksum columns".

Version 4 drops questions 1 and 2 of version 3, because the previews are gone. The other questions of version 2 stay as version 2 recorded them below. The eng-lead answers close questions 1, 17, 19, and 20. Questions 4, 5, 7, 9, 18, and 23 to 25 keep their proposed answers. Questions 11, 12, 14 to 16, 21, and 22 change no behavior and no data.

Points that change no behavior and no data, for the record: the Result column copies the outcome cell of the job page, which names its column Outcome. The brief names it Result, and the string is drafted.

### Questions of version 2

1. Bulk Actions stays enabled without a selection, so that Import opens (choice 1). The built button is disabled without a selection (`devices.html`, `[disabled]="!canBulk()"`). Proposed answer: enable Bulk Actions, and disable each entry that needs a selection.
2. The header match runs in the browser (states 10 and 23). A CSV file without a Checksum column in Sync changes then stops before the upload, so state 23 needs a source that the browser does not read, such as a Drive file or a direct API call. Proposed answer: keep state 23 as the server guard.
3. Row 8 returns tag CB970992 to `0727D2E` while a replacement device holds it (state 15). The mockup warns and runs the change. Proposed answer: keep the warning, as answer 1 of the defaults lets the person deconflict before Execute.
4. Cancel import applies at once without a question (choice 12). Nothing runs. Proposed answer: no question.
5. A validation with rejected rows and no change reads Completed with errors (states 22 and 26). Proposed answer: keep the label, so the job never reads as a success.
6. The help does not list the field limits: Annotated location 200, Asset tag 256, Annotated user 100, Notes 500, and Organization unit 4,096 characters (`devices.ts`, `DEVICE_UPDATE_FIELD_LIMITS`). A rejected row names its limit (state 14). Proposed answer: add a Field limits table to the Import topic of the help.
7. The update job progress counts devices (2 of 6), and its table lists one row per device and field (states 17 and 25), as built. Proposed answer: keep it.
8. The file of Download rejected rows. Proposed answer: the ten template columns plus the source row number and the reason, so the person corrects the rows and imports the file again.
9. A report view pages 10 rows in the dialog (choice 3). Version 1 paged 25 on the job page. Proposed answer: 10 rows, so the report fits 1440 x 900 without nested scrolling.
10. The plan expiry while the dialog stays open. Proposed answer: the action bar switches to Expired at the expiry time, and Execute checks the expiry on the server.
11. Inherited: the built operations footer reads "Rows 1–1 of 1 operations" for one operation. No version 2 state shows it. Proposed answer: engineering fixes the plural in `job-detail-fields.ts`.
12. Inherited: the page footer of the job backgrounds reads "Google results are out of date" (states 25 and 26), as in the approved job cancel mockup. Proposed answer: keep the real footer.
13. The module lists two missing columns as "the Device ID, and Checksum columns" (choice 19). Proposed answer: "the Device ID and Checksum columns".
14. The dialog width (choice 2). Proposed answer: 1120 px for all three dialogs, as a new token for wide dialogs.
15. The wide dialog keeps the 6 px top inset of the built dialog title (`device-dialog.css`). At 1120 px the title sits close to the top edge. Proposed answer: keep the built inset, so every dialog matches. Raise it for all dialogs in a later pass if the owner wants more room.
16. The help placement (choice 5): a pane over the right 480 px of the body, four topics, and the topic of the current step. Proposed answer: keep it.
17. The return to a running validation without the job page (choice 14). Proposed answer: both ways, the Activity row and Import in Bulk Actions.
18. Stop validation applies at once without a question (choice 13). Proposed answer: no question, because nothing reached Google.
19. The 50,000-device limit for Reports. Proposed answer: the same limit as Export, with the same note in the Reports dialog.
20. Reports writes the visible columns, including Device contact, which sits right of the scroll edge (state 07). Proposed answer: visible means shown in the grid configuration, scrolled or not.
21. The line "Header check passed." under the chosen file (state 09). Proposed answer: keep it, because it is state, not instruction.
22. The dialog titles "Export devices", "Create a report", and "Import devices" against the menu labels Export, Reports, and Import. Proposed answer: keep the task titles.
23. After Done in the executed view, the dialog no longer shows the plan. Proposed answer: the Jobs grid and Activity list the jobs, and Import starts a new import.
24. The download of a ready file after the person closes the dialog. Proposed answer: the Activity row of the export opens the dialog at its file card, and the job page keeps the file card of version 1.
25. The executed view lists the jobs and their links, but not the 11 changes. Proposed answer: keep the jobs only, because the job pages list each operation.

## App-sourced strings

175 strings. Each item names its proof: the app file of main `5f50d7c` that holds the whole literal, the template that builds it, or the module of main that builds it (11 module texts).

- "Selected on current page: 48" · rule: ssrmSelectionService.js
- "Total Selected: 48" · rule: ssrmSelectionService.js
- "Select All (7000)" · rule: ssrmSelectionService.js
- "Deselect All" · rule: ssrmSelectionService.js
- "Show All Selected (48)" · rule: ssrmSelectionService.js
- "7,000 matching devices · 7,000 in district" · rule: device-status-panel.ts
- "Inventory observed Oct 27, 6:05 AM" · rule: device-status-panel.ts
- "Bulk Actions" · frontend/src/app/devices/devices.html
- "Update device" · frontend/src/app/devices/device-detail.html
- "Send command" · frontend/src/app/devices/device-action-messages.ts
- "Change status" · frontend/src/app/devices/device-action-messages.ts
- "Cancel" · frontend/src/app/devices/device-filter.html
- "48 selected devices · Not submitted" · device-action-sheet.ts: ${count.toLocaleString('en-US')} selected ${ count === 1 ? 'device' : 'devices' } · Not su
- "Close" · frontend/src/app/devices/device-action-sheet.html
- "Selected on current page: 100" · rule: ssrmSelectionService.js
- "Total Selected: 62480" · rule: ssrmSelectionService.js
- "Select All (62480)" · rule: ssrmSelectionService.js
- "Show All Selected (62480)" · rule: ssrmSelectionService.js
- "62,480 matching devices · 62,480 in district" · rule: device-status-panel.ts
- "Selected by filter: All devices" · rule: device-selection.ts
- "62,480 selected devices · Not submitted" · device-action-sheet.ts: ${count.toLocaleString('en-US')} selected ${ count === 1 ? 'device' : 'devices' } · Not su
- "Job EXP-001 · Running" · rule: job-detail.ts, job-fields.ts
- "Done" · frontend/src/app/devices/device-action-sheet.html
- "Job EXP-001 · Completed" · rule: job-detail.ts, job-fields.ts
- "Review" · frontend/src/app/devices/device-action-sheet.ts
- "Columns" · frontend/src/app/devices/device-grid-options.ts
- "Device ID" · libs/application-contracts/src/lib/device-edit-template.ts
- "Serial number" · libs/application-contracts/src/lib/device-edit-template.ts
- "Model" · frontend/src/app/devices/device-fields.ts
- "Status" · frontend/src/app/devices/device-fields.ts
- "Asset tag" · frontend/src/app/devices/device-fields.ts
- "Annotated location" · frontend/src/app/devices/device-detail.html
- "Annotated user" · frontend/src/app/devices/device-detail.html
- "Notes" · frontend/src/app/devices/device-detail.html
- "Organization unit" · frontend/src/app/devices/device-fields.ts
- "Checksum" · libs/application-contracts/src/lib/device-edit-template.ts
- "Serial" · frontend/src/app/devices/device-fields.ts
- "Battery" · frontend/src/app/devices/device-fields.ts
- "Device contact" · frontend/src/app/devices/device-fields.ts
- "Job EXP-002 · Completed" · rule: job-detail.ts, job-fields.ts
- "Selected on current page: 0" · rule: ssrmSelectionService.js
- "Total Selected: 0" · rule: ssrmSelectionService.js
- "Show All Selected (0)" · rule: ssrmSelectionService.js
- "Sync changes" · libs/application-contracts/src/lib/device-edit-template.ts
- "Sync all rows" · libs/application-contracts/src/lib/device-edit-template.ts
- "The file is missing the Device ID column." · device-edit-template.ts (5f50d7c)
- "Status cell" · device-edit-template.ts (5f50d7c)
- "ACTIVE" · frontend/src/app/devices/device-action-messages.ts
- "DISABLED" · frontend/src/app/devices/device-action-messages.ts
- "DEPROVISION:<reason code>" · libs/application-contracts/src/lib/device-edit-template.ts
- "RETIRING_DEVICE" · device-edit-template.ts (5f50d7c)
- "Retiring from fleet" · libs/application-contracts/src/lib/devices.ts
- "DIFFERENT_MODEL_REPLACEMENT" · device-edit-template.ts (5f50d7c)
- "Different model replacement" · libs/application-contracts/src/lib/devices.ts
- "SAME_MODEL_REPLACEMENT" · device-edit-template.ts (5f50d7c)
- "Same model replacement" · libs/application-contracts/src/lib/devices.ts
- "UPGRADE_TRANSFER" · device-edit-template.ts (5f50d7c)
- "ChromeOS Flex upgrade transfer" · libs/application-contracts/src/lib/devices.ts
- "Completed" · frontend/src/app/jobs/job-fields.ts
- "Job IMP-001 · Running" · rule: job-detail.ts, job-fields.ts
- "Device" · frontend/src/app/devices/device-action-sheet.html
- "Change" · frontend/src/app/devices/device-update-sheet.html
- "Current value" · frontend/src/app/devices/device-grid-conflict.html
- "New value" · frontend/src/app/devices/device-update-sheet.html
- "Clear value" · frontend/src/app/devices/device-update-sheet.html
- "Not set" · frontend/src/app/devices/device-detail.html
- "Deprovision" · frontend/src/app/devices/device-action-messages.ts
- "Active" · frontend/src/app/devices/device-action-messages.ts
- "Deprovisioned" · frontend/src/app/devices/device-action-messages.ts
- "Deprovision reason: Retiring from fleet" · frontend/src/app/devices/device-action-messages.ts
- "Disable" · frontend/src/app/devices/device-action-messages.ts
- "Disabled" · frontend/src/app/devices/device-action-messages.ts
- "Re-enable" · frontend/src/app/devices/device-action-messages.ts
- "Expires Oct 28, 11:42 AM" · device-action-messages.ts: Expires ${formatTimestamp(expiresAt)}
- "Open device 01P0T1V" · job-detail.html binding
- "Open device 02A1MB6" · job-detail.html binding
- "Open device 02QJANY" · job-detail.html binding
- "Open device 04A9BVS" · job-detail.html binding
- "Open device 04QVJBY" · job-detail.html binding
- "Open device 04XTBHJ" · job-detail.html binding
- "Annotated user holds 1 to 100 characters." · device-update-messages.ts: ${label} holds 1 to ${limit} characters.
- "Status accepts ACTIVE, DISABLED, DEPROVISION:<reason code>. Reason codes: RETIRING_DEVICE, DIFFERENT_MODEL_REPLACEMENT, SAME_MODEL_REPLACEMENT, UPGRADE_TRANSFER." · device-edit-template.ts (5f50d7c)
- "Open device 0B2KQ7R" · job-detail.html binding
- "Open device 0F7TZ3M" · job-detail.html binding
- "Open device 0K4D8WX" · job-detail.html binding
- "The column "Room" is unknown. It stays out of every write." · device-edit-template.ts (5f50d7c)
- "Open device 0727D2E" · job-detail.html binding
- "Open device 0S6HM2C" · job-detail.html binding
- "Update device annotations" · libs/application-contracts/src/lib/jobs.ts
- "6 devices" · rule: job-fields.ts
- "Disable devices" · libs/application-contracts/src/lib/jobs.ts
- "1 device" · rule: job-fields.ts
- "Re-enable devices" · libs/application-contracts/src/lib/jobs.ts
- "Deprovision devices" · libs/application-contracts/src/lib/jobs.ts
- "Type DEPROVISION to confirm" · device-action-messages.ts: Type ${phrase} to confirm
- "Deprovision removes these devices from active management. This workflow cannot restore their previous management state." · frontend/src/app/devices/device-action-messages.ts
- "Deprovision does not erase local data. Send Powerwash first to erase a device that leaves the district." · frontend/src/app/devices/device-action-messages.ts
- "changes" · frontend/src/app/devices/device-grid-draft.store.ts
- "Succeeded" · frontend/src/app/jobs/job-detail-fields.ts
- "Pending" · frontend/src/app/jobs/job-detail-fields.ts
- "Updated live" · frontend/src/app/jobs/job-activity.store.ts
- "Running" · frontend/src/app/jobs/job-fields.ts
- "Queued" · frontend/src/app/jobs/job-fields.ts
- "2 of 6 complete" · rule: job-fields.ts
- "4 pending" · job-fields.ts: ${count(progress.pending)} pending
- "0 of 1 complete" · rule: job-fields.ts
- "Open details for job UPD-001" · jobs.html binding
- "Open details for job STS-001" · jobs.html binding
- "Open details for job STS-002" · jobs.html binding
- "Open details for job STS-003" · jobs.html binding
- "Failed" · frontend/src/app/jobs/job-detail-fields.ts
- "6 of 6 complete" · rule: job-fields.ts
- "1 of 1 complete" · rule: job-fields.ts
- "0 succeeded" · job-fields.ts: ${count(progress.succeeded)} succeeded
- "1 failed" · job-fields.ts: ${count(progress.failed)} failed
- "Expires Oct 28, 10:15 AM" · device-action-messages.ts: Expires ${formatTimestamp(expiresAt)}
- "Open device 0L1B4QD" · job-detail.html binding
- "Open device 0L1C8WN" · job-detail.html binding
- "Open device 0L2D3RT" · job-detail.html binding
- "Open device 0L3F9KA" · job-detail.html binding
- "Open device 0L4G2MX" · job-detail.html binding
- "Open device 0L4H7PB" · job-detail.html binding
- "Open device 0L5J1VC" · job-detail.html binding
- "Open device 0L5K6ZE" · job-detail.html binding
- "Open device 0L6M4TF" · job-detail.html binding
- "Open device 0L7N8QG" · job-detail.html binding
- "Open device 08V5B5S" · job-detail.html binding
- "Asset tag cannot be cleared. Asset tag offers Replace only." · device-edit-template.ts (5f50d7c)
- "Organization unit cannot be cleared. Organization unit offers Move only." · device-edit-template.ts (5f50d7c)
- "Job IMP-006 · Failed" · rule: job-detail.ts, job-fields.ts
- "The file is missing the Checksum column." · device-edit-template.ts (5f50d7c)
- "Cancelled" · frontend/src/app/jobs/job-detail-fields.ts
- "Job IMP-007 · Cancelled" · rule: job-detail.ts, job-fields.ts
- "Cancellation requested by Review administrator · Oct 28, 11:10 AM" · job-detail-fields.ts: Cancellation requested by ${request.by.displayName} · ${formatTimestamp( request.at, now, 
- "Back to jobs" · frontend/src/app/jobs/job-detail.html
- "Refresh" · frontend/src/app/devices/devices.html
- "Cancel pending work" · frontend/src/app/jobs/job-detail-fields.ts
- "Unknown" · frontend/src/app/jobs/job-detail-fields.ts
- "Expired" · frontend/src/app/jobs/job-detail-fields.ts
- "Skipped" · frontend/src/app/jobs/job-detail-fields.ts
- "Operation results for job UPD-001" · rule: job-detail.html
- "Operation" · frontend/src/app/jobs/job-detail.html
- "Before" · frontend/src/app/devices/device-columns.ts
- "Requested" · frontend/src/app/jobs/job-detail.html
- "Outcome" · frontend/src/app/jobs/job-detail.html
- "Updated" · frontend/src/app/invitations/invitations.html
- "Actions" · frontend/src/app/jobs/job-detail.html
- "Job UPD-001 · Running" · rule: job-detail.ts, job-fields.ts
- "UPD-001 · 6 devices" · rule: device-update-messages.ts, job-detail-fields.ts
- "Requested by Review administrator · Oct 28, 10:44 AM · Duration: 38s" · rule: job-detail-fields.ts, job-fields.ts
- "Operation counts" · frontend/src/app/jobs/job-detail.html
- "Operation results" · frontend/src/app/jobs/job-detail.html
- "Keep job running" · frontend/src/app/jobs/job-detail-fields.ts
- "Cancel pending work on UPD-001?" · job-detail-fields.ts: Cancel pending work on ${job.displayId}?
- "4 of 6 operations are pending. Those that have not reached Google end Cancelled and never run." · job-detail-fields.ts: ${countText(pending)} of ${countText(total)} ${ total === 1 ? 'operation is' : 'operations
- "Requests already sent to Google finish and keep their results. The 2 confirmed updates stay. Nothing rolls back." · job-detail-fields.ts: Requests already sent to Google finish and keep their results. The ${countText( succeeded,
- "Operation results table" · frontend/src/app/jobs/job-detail.html
- "Previous operations page" · frontend/src/app/jobs/job-detail.html
- "Next operations page" · frontend/src/app/jobs/job-detail.html
- "Completed with errors" · frontend/src/app/jobs/job-fields.ts
- "All updates confirmed" · frontend/src/app/jobs/job-fields.ts
- "48 devices" · rule: job-fields.ts
- "19 jobs · Updated Oct 28, 11:12 AM" · jobs.ts: ${count} · Updated ${time}
- "Rows 1–19 of 19" · jobs.ts: Rows ${start.toLocaleString('en-US')}–${end.toLocaleString('en-US')} of ${page.matching.to
- "Open details for job IMP-007" · jobs.html binding
- "Open details for job IMP-006" · jobs.html binding
- "Open details for job IMP-005" · jobs.html binding
- "Open details for job IMP-004" · jobs.html binding
- "Open details for job IMP-003" · jobs.html binding
- "Open details for job IMP-001" · jobs.html binding
- "Open details for job EXP-002" · jobs.html binding
- "Open details for job EXP-001" · jobs.html binding
- "Open details for job IMP-002" · jobs.html binding
- "Previous page" · frontend/src/app/jobs/jobs.html
- "Next page" · frontend/src/app/jobs/jobs.html

## Mockup data

115 strings: serials, device IDs, job IDs, file names, file sizes, inventory values, times, the person, and counts.

- "1" · state 04
- "2" · state 04
- "devices-for-editing-EXP-001.csv" · state 05
- "7.8 KB" · state 05
- "device-report-EXP-002.csv" · state 08
- "5.3 KB" · state 08
- "devices-edited.csv" · state 10
- "6.0 KB" · state 10
- "3" · state 12
- "4" · state 12
- "5" · state 12
- "48" · state 12
- "13" · state 12
- "11" · state 13
- "01P0T1V" · state 13
- "Room 12" · state 13
- "Room 14" · state 13
- "02A1MB6" · state 13
- "Loaner" · state 13
- "02QJANY" · state 13
- "Science wing" · state 13
- "North lab" · state 13
- "/Chrome Devices/Lowell Academy/Grade 9" · state 13
- "/Library" · state 13
- "04A9BVS" · state 13
- "Retired" · state 13
- "6" · state 13
- "04QVJBY" · state 13
- "7" · state 13
- "04XTBHJ" · state 13
- "Returned to library" · state 13
- "35" · state 13
- "12" · state 14
- "0B2KQ7R" · state 14
- "19" · state 14
- "0F7TZ3M" · state 14
- "/Libary" · state 14
- "27" · state 14
- "0K4D8WX" · state 14
- "DEPROVISION:RETIRED" · state 14
- "33" · state 14
- "9f3c71e2-4b0a-4c55-8d2e-61a7c0b9e5d4" · state 14
- "8" · state 15
- "0727D2E" · state 15
- "41" · state 15
- "0S6HM2C" · state 15
- "UPD-001" · state 17
- "STS-001" · state 17
- "STS-002" · state 17
- "STS-003" · state 17
- "9" · state 17
- "10" · state 17b
- "0" · state 18
- "0L1B4QD" · state 18
- "/Chrome Devices/Lowell Academy/One to One" · state 18
- "0L1C8WN" · state 18
- "/Chrome Devices/Hughes Academy/One to One" · state 18
- "0L2D3RT" · state 18
- "0L3F9KA" · state 18
- "/Chrome Devices/Pine Valley Elementary School/Cart Devices" · state 18
- "0L4G2MX" · state 18
- "jmorales14@example.org" · state 18
- "16" · state 18
- "0L4H7PB" · state 18
- "kpatel22@example.org" · state 18
- "0L5J1VC" · state 18
- "lchen31@example.org" · state 18
- "22" · state 18
- "0L5K6ZE" · state 18
- "mrivera08@example.org" · state 18
- "24" · state 18
- "0L6M4TF" · state 18
- "nokafor17@example.org" · state 18
- "0L7N8QG" · state 18
- "pschmidt26@example.org" · state 18
- "30" · state 18
- "08V5B5S" · state 20
- "Cart 3" · state 20
- "[clear]" · state 22
- "DEPROVISION" · state 22
- "active" · state 22
- "2.9 KB" · state 23
- "10:45 AM" · state 25
- "10:44 AM" · state 25
- "IMP-007" · state 26
- "Review administrator" · state 26
- "Oct 28, 11:10 AM" · state 26
- "14s" · state 26
- "IMP-006" · state 26
- "—" · state 26
- "Oct 28, 11:05 AM" · state 26
- "1s" · state 26
- "IMP-005" · state 26
- "Oct 28, 11:00 AM" · state 26
- "6s" · state 26
- "IMP-004" · state 26
- "Oct 28, 10:55 AM" · state 26
- "2s" · state 26
- "IMP-003" · state 26
- "Oct 28, 10:50 AM" · state 26
- "9s" · state 26
- "Oct 28, 10:44 AM" · state 26
- "3s" · state 26
- "1m 02s" · state 26
- "IMP-001" · state 26
- "Oct 28, 10:40 AM" · state 26
- "1m 54s" · state 26
- "EXP-002" · state 26
- "Oct 28, 10:35 AM" · state 26
- "EXP-001" · state 26
- "Oct 28, 10:31 AM" · state 26
- "4s" · state 26
- "IMP-002" · state 26
- "Oct 28, 9:14 AM" · state 26
- "1m 08s" · state 26

## Drafted strings

209 strings, including 3 app literals with a new meaning. The owner approves each one. Export, Reports, and Import are the labels of the owner. `Starts after UPD-001 ends` and `Result` are the words of the brief. `A device with status ACTIVE does not allow this action.` is the Google message of state 17b (Execution results).

### State 01, bulk-actions-menu

- "Export"
- "Reports"
- "Import"

### State 02, export-dialog

- "CSV file"
- "Google Sheet"
- "Google Drive is not available for your account."
- "Export 48 devices"
- "Export devices"
- "Format"
- "Export and import help"

### State 03, export-over-limit

- "Export 62,480 devices"
- "An edit export holds at most 50,000 devices. This selection holds 62,480. Filter the grid to 50,000 devices or fewer, then select them again."

### State 04, export-running

- "Write rows"
- "32 of 48"
- "Prepare download"
- "Closing this dialog keeps the export running."
- "Export phases"
- "Export progress"

### State 05, export-ready

- "Available until Nov 27, 10:31 AM"
- "Download CSV"
- "48 rows"
- "10 columns"

### State 06, export-help

- "Columns of the edit file"
- "Column"
- "Use"
- "Identifies the device. Keep it."
- "Read-only"
- "Editable with a status code"
- "Editable"
- "Marks the rows that you edit. Keep it."
- "Editing rules"
- "Limits"
- "Export writes one row per selected device. Edit the file, then import it."
- "A blank cell keeps the current value."
- "[clear] empties Annotated location, Annotated user, or Notes."
- "Asset tag and Organization unit cannot be cleared."
- "A status code in the Status cell changes the status. The Import topic lists the codes."
- "An edit export holds at most 50,000 devices."
- "The download expires 30 days after the export."
- "Help topic"

### State 07, reports-dialog

- "Create report"
- "Create a report"
- "Visible grid columns"

### State 08, reports-ready

- "Available until Nov 27, 10:35 AM"
- "6 columns"

### State 09, import-dialog

- "Upload a CSV file"
- "Google Drive"
- "Drop a CSV file here"
- "Choose CSV file"
- "Header check passed."
- "Start validation"
- "Import devices"
- "CSV file · Not submitted"
- "Import mode"
- "Source"
- "Selected file"

### State 10, import-header-check

- "9 columns"

### State 11, import-help

- "Import modes"
- "Rules"
- "Status codes"
- "Effect"
- "Re-enables a disabled device"
- "Disables an active device"
- "Deprovisions an active or disabled device"
- "Reason codes"
- "Reason code"
- "Label"
- "Checks the rows that changed since the export. Needs the Checksum column."
- "Checks every row and resets the devices to the file. Ignores the Checksum column."
- "Import never creates devices. A device ID that Campus Commander does not hold rejects its row."
- "A file holds at most 50,000 rows."
- "Codes match in upper case, for example DEPROVISION:RETIRING_DEVICE."

### State 12, validation-running

- "Upload"
- "Header check"
- "Passed"
- "Refresh stale devices"
- "6 of 9"
- "Compare"
- "Report"
- "Rows read"
- "Edited rows"
- "Closing this dialog keeps the validation running."
- "Stop validation"
- "Sync changes · devices-for-editing-EXP-001.csv"
- "Validation phases"
- "Validation progress"

### State 13, review-proposed

- "Row counts"
- "Rows"
- "Unchanged"
- "No change needed"
- "Proposed"
- "Rejected"
- "Validation refreshed 9 stale devices from Google before the comparison."
- "Oldest observation Oct 27, 3:12 PM"
- "Validation results"
- "Proposed changes"
- "Rejected rows"
- "Warnings"
- "Download rejected rows"
- "Proposed changes of job IMP-001"
- "Row"
- "Rows 1–9 of 11 proposed changes"
- "Open"
- "Cancel import"
- "Execute 11 changes"
- "Job IMP-001 · Completed · Sync changes · devices-for-editing-EXP-001.csv"
- "Proposed changes: 8 field changes on 6 devices · Disable 1 device · Re-enable 1 device · Deprovision 1 device (Retiring from fleet)"
- "Validation results view"
- "Validation results table"
- "Previous results page"
- "Next results page"

### State 14, review-rejected

- "Rejected rows of job IMP-001"
- "Cell"
- "Submitted value"
- "Reason"
- "Lowell Academy robotics club loaner for the spring term. Contact the library desk before you move this device. The club keeps it in the robotics room cabinet during the week and returns it to the library cart on Friday afternoons. Check the charger and the case at every return. Log any damage there."
- "300 characters"
- "No organization unit has the path /Libary."
- "Not in inventory"
- "Campus Commander holds no device with this ID. Import never creates devices."
- "Rows 1–4 of 4 rejected rows"

### State 15, review-warnings

- "Warnings of job IMP-001"
- "Warning"
- "Header row"
- "Asset tag CB970992 is also on another device. The change still runs when you execute."
- "Status PRE_PROVISIONED is export-only and differs from the current status ACTIVE. It requests nothing."
- "Rows 1–3 of 3 warnings"

### State 16, execute-confirm

- "Execute 11 changes on 7 devices?"
- "8 field changes"
- "The 4 rejected rows stay out. Nothing in them runs."
- "(Retiring from fleet)"
- "Back to review"
- "Execute creates four jobs. The update job runs first. The three status jobs start after it ends."
- "Jobs that Execute creates"

### State 17, executed

- "Result counts"
- "Execution results"
- "Results of the changes of job IMP-001"
- "Result"
- "Starts after UPD-001 ends"
- "Rows 1–9 of 11 changes"
- "Executed"
- "Executed by Review administrator · Oct 28, 10:44 AM"
- "Jobs of the plan of IMP-001"
- "UPD-001 progress"
- "Execution results table"

### State 17b, execution-finished

- "A device with status ACTIVE does not allow this action."
- "Finished Oct 28, 10:45 AM"

### State 18, sync-all-rows-review

- "Sync all rows checks every row, so no row counts as unchanged."
- "Validation refreshed 12 stale devices from Google before the comparison."
- "Oldest observation Oct 27, 4:20 PM"
- "Proposed changes of job IMP-002"
- "Rows 1–10 of 11 proposed changes"
- "Job IMP-002 · Completed · Sync all rows · library-reset.csv"
- "Proposed changes: 11 field changes on 11 devices"

### State 19, plan-expired

- "The plan expired Oct 28, 10:15 AM. Nothing ran."
- "Validate again"

### State 20, plan-cancelled

- "Validation refreshed 1 stale device from Google before the comparison."
- "Oldest observation Oct 28, 10:50 AM"
- "Proposed changes of job IMP-003"
- "Rows 1–1 of 1 proposed change"
- "Cancelled by Review administrator · Oct 28, 10:51 AM. Nothing ran."
- "Import again"
- "Job IMP-003 · Completed · Sync changes · cart-3-notes.csv"
- "Proposed changes: 1 field change on 1 device"

### State 21, no-update-needed

- "Proposed changes of job IMP-004"
- "0 proposed changes"
- "No changes"
- "Every row matches its export checksum. No update is needed."
- "Execute"
- "Job IMP-004 · Completed · Sync changes · devices-for-editing-EXP-001.csv"
- "No row needs an update."

### State 22, rejected-only

- "Validation refreshed 2 stale devices from Google before the comparison."
- "Oldest observation Oct 28, 11:00 AM"
- "Rejected rows of job IMP-005"
- "Nothing can run. 4 rows are rejected. Correct the rows in the file, then import it again."
- "Job IMP-005 · Completed with errors · Sync changes · loaner-returns.csv"

### State 23, validation-failed

- "No report"
- "Sync changes · library-reset.csv"
- "Sync changes needs the Checksum column. Sync all rows ignores it."
- "Validation stopped before any row check. No report and no plan exist. Nothing reached Google."

### State 24, validation-cancelled

- "4 of 12"
- "Rows to compare"
- "Sync all rows · library-reset.csv"
- "Validation stopped. No report and no plan exist. Nothing reached Google."
- "The 4 device reads that finished before the stop stay stored."

### State 25, update-cancel-confirm

- "Import IMP-001 · STS-001, STS-002, and STS-003 start after this job ends"
- "The waiting status jobs STS-001, STS-002, and STS-003 also end Cancelled and never start."

### State 26, jobs-grid

- "Validate device import"
- "4 of 12 stale devices read"
- "30 rows"
- "0 rows checked"
- "Checksum column missing"
- "6 rows checked"
- "4 rejected · no changes"
- "6 rows"
- "48 rows checked"
- "No update needed"
- "5 rows checked"
- "Plan cancelled"
- "5 rows"
- "Plan executed"
- "48 rows written"
- "Report ready"
- "Edit file ready"
- "30 rows checked"
- "Plan expired"

### App literals with a new meaning

- "Ready" · state 05, app literal in diagnostics.html with another meaning
- "Expired" · state 19, app literal in job-detail-fields.ts with another meaning
- "Cancelled" · state 20, app literal in job-detail-fields.ts with another meaning
