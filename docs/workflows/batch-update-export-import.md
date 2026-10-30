# Batch update devices through export and import

Status: proposed, and the CSV slice mockup is approved. On 2026-10-26 the owner answered decisions D1 to D4 and added the import modes (D5). He also supplied notes on his earlier implementation.
Later that day he answered the open defaults, directed a universal job cancel (D6), and set its rules.

On 2026-10-28 the owner signed off the universal job cancel (D6). Owner: "Agreed I sign off on that."
The same day he sent UI changes for the CSV slice.

On 2026-10-26 the owner approved the job cancel mockup. Owner, in the main chat: "Thats fine."

On 2026-10-28 the owner approved version 4 of the CSV slice mockup and directed its build. Owner, in the main chat: "This is perfect. Please go ahead and execute on this."
The approved [mockup](../ui/designs/2026-10-28-device-export-import.html) and its [notes](../ui/designs/2026-10-28-device-export-import-notes.md) set the CSV slice screens. They outrank this record on composition.

The Google Drive slice stays proposed.
On 2026-10-30 the owner approved version 1 of the Google Drive slice mockup. Owner, in the main chat: "approve, all recommended".
The approved [Drive slice mockup](../ui/designs/2026-10-30-device-drive-slice.html) and its [notes](../ui/designs/2026-10-30-device-drive-slice-notes.md) set the Drive slice screens.

Source: owner direction of 2026-09-03, 2026-10-21, 2026-10-24, 2026-10-26, 2026-10-28, and 2026-10-30, quoted under [Owner direction](#owner-direction).

Design: [Figma page 09](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=94-2), with the frame table under [Design](#design). The approved CSV slice mockup closes the CSV design gaps. Gaps 2 and 7 stay open for the Google Drive slice.
Technical design: [batch update through export and import](../research/batch-update-export-import-technical-design.md).
Replaces: the stored-baseline comparison of `docs/portfolio/02-domain-model.md:120-151` and CSV-01 to CSV-03 (`docs/ui/patterns.md:221-254`).

## User and outcome

The existing administrator changes many ChromeOS devices through a spreadsheet.
The administrator exports selected devices, edits values and status codes, and imports the file.
A saved sheet also resets a set of devices to the same values every time.

Campus Commander validates the rows against fresh device data. It shows every proposed change and every rejected row.
The administrator executes the valid changes or cancels.
The existing update and status jobs run the changes. The job pages show each result.

## Interaction

### Export

- Bulk Actions offers Export. The export sheet shows the scope and the device count.
- The person chooses the purpose, For editing or Report, and the format, CSV file or Google Sheet.
- An edit export holds Device ID, Serial number, Model, Status, the five editable fields, and Checksum.
- An edit export holds at most 50,000 devices.
- The receipt links the export job. The completed job offers the CSV download or the Google Sheet.

### Edit

- A blank cell keeps the current value. `[clear]` empties Annotated location, Annotated user, or Notes.
- `[clear]` in Asset tag or Organization unit rejects the row.
- The Status cell holds Google's status value, for example `ACTIVE`. The person changes it to request a status.
- Status codes: `ACTIVE` re-enables, `DISABLED` disables, and `DEPROVISION:<reason code>` deprovisions.
- Reason codes: `RETIRING_DEVICE`, `DIFFERENT_MODEL_REPLACEMENT`, `SAME_MODEL_REPLACEMENT`, and `UPGRADE_TRANSFER`.
- The import sheet lists the codes. The exported file holds no code list.
- Another Google status value, for example `DEPROVISIONED`, is export-only. It requests nothing.

### Import and validate

- Bulk Actions offers Import. Import needs no selection.
- The import sheet offers two import modes. Sync changes starts selected.
- Sync changes validates the rows that the person edited. The row checksum finds them.
- Sync all rows ignores the checksum and validates every row. It resets the devices to the sheet.
- The source is an uploaded CSV file, or a Google Sheet tab or CSV file from Google Drive.
- The Google Picker selects the Drive file.
- The validation job refreshes stale device data from Google first, in both modes.
- It compares each nonblank cell with the fresh current value, field by field.
- One invalid cell rejects the whole row.
- Each Organization unit path must exist in the organization unit tree. A mistyped unit rejects the row before any write.
- A missing, malformed, or duplicated device ID rejects its row, in both modes.
- Blank rows count nowhere. Header matching ignores outer spaces and letter case.

### Review, execute, or cancel

- The validation job page shows the mode, the counts, the rejected rows, the warnings, and every proposed change.
- The person downloads the rejected rows to correct them.
- Execute runs the proposed changes only. Rejected rows never run.
- When the plan holds a Deprovision, Execute asks for the typed phrase DEPROVISION.
- Cancel discards the plan. Nothing runs.
- With rejected rows and no proposed change, the page shows the rejected rows. A failed import never reads as a success.
- The plan expires 1 hour after validation completes.
- Execute creates one update job and one status job per action and reason. The status jobs start after the update job.
- Each job page shows each result. The grid shows each confirmed value.
- No result shows success while an operation failed or reads unknown. Every count reads the job's operations.

### Cancel pending work on any job (D6)

- Every job page offers Cancel pending work while work remains that has not reached Google.
- It works for every job kind: refresh, update, command, status, validation, and export.
- The requester, a person with the new permission `jobs:manage`, or a platform administrator can cancel.
- The confirmation states the pending count and the work already sent. Nothing rolls back.
- A job that has not started ends at once. Nothing reaches Google.
- A running job stops within 30 seconds. Sent requests settle from their answers. Unsent operations read Cancelled.
- The page shows "Cancellation requested" until every operation has settled. The job then ends Cancelled.
- The results keep every outcome from before the cancel. An Unknown operation keeps Reconcile.
- Once every command of a command job is issued, Cancel pending work is not offered. No API cancels an issued command.
- Cancel pending work on the update job of an import also cancels its waiting status jobs.

## Data and access

| Data                            | Google source                                                  | Scope suffix                               |
| ------------------------------- | -------------------------------------------------------------- | ------------------------------------------ |
| Device refresh                  | Directory API `chromeosdevices.get` through the batch endpoint | `admin.directory.device.chromeos.readonly` |
| Device field write              | Directory API `chromeosdevices.patch`                          | `admin.directory.device.chromeos`          |
| Disable, Re-enable, Deprovision | Directory API `customer.devices.chromeos:batchChangeStatus`    | `admin.directory.device.chromeos`          |
| Sheet export and Drive import   | Sheets API, Drive API, and the Google Picker                   | `drive.file`                               |

All scopes use the `https://www.googleapis.com/auth/` prefix.
The `drive.file` scope joins the DWD install scopes, the delegation link, and the Diagnostics check.

| Action                        | Permissions at district scope                                      |
| ----------------------------- | ------------------------------------------------------------------ |
| Export                        | `devices:read`, `devices:bulk-actions`, and a new `devices:export` |
| Import, review, Execute       | `devices:read`, `devices:write`, and `devices:bulk-actions`        |
| `ACTIVE` and `DISABLED` codes | Add `devices:status`                                               |
| Deprovision codes             | Add `devices:deprovision`                                          |
| Cancel pending work           | The requester, `jobs:manage`, or a platform administrator          |

A status code without its permission rejects its row.
Google writes each device on its own. A failed device keeps its old value. Nothing undoes a device that succeeded.
Live Google device writes stay unverified. The test domain has no ChromeOS device (`docs/workflows/wipe-powerwash-deprovision.md:66`).

## Owner direction

### 2026-09-03, feature review notes

From `docs/archive/ux/feature-review-notes-2026-09-03.md:37-42`:

> - We need a unique export and import pair (distinct from the existing one-way export and the CSV import).
> - Export creates a CSV or Google Sheet.
> - The user updates the data in the spreadsheet, then re-imports it.
> - Re-import runs: validation → preview → confirm → create job.
> - There will be some complex workflows here. This needs its own design session before implementation.
> - NOTE: this export/import entry point lives nested under the bulk actions dropdown menu.

### 2026-10-21, main chat

> As well as import and export for bulk edit.

Source: `docs/workflows/update-device-fields.md:84`.

### 2026-10-24, main chat

> We need to start the work on the CSV/Google Drive import export. For google drive we will use the google drive picker.

The same message adds `https://www.googleapis.com/auth/drive.file` to the scopes of the DWD install.

### 2026-10-26, main chat: the reference design

The owner supplied the technical design of his earlier implementation of this feature. It stays outside the repository.

> My application does NOT need to be backward compatible with this file. I will have my OWN checksum feature.

He directed that Campus Commander adapt the reference design as much as possible. Its design and code contain no name from the reference product. This sentence paraphrases his message, because the message names that product.

### 2026-10-26, main chat: notes on the earlier implementation

The owner supplied notes on how his earlier implementation validates and executes an import, with a list of its defects.
The notes name the earlier product, so this record paraphrases them.
The [technical design](../research/batch-update-export-import-technical-design.md#appendix-a-differences-from-the-reference-design) maps each item.

- Status cells accept `ACTIVE`, `DISABLED`, and Deprovision codes. Echoed export-only statuses are skipped.
- A flag for all file values bypasses the checksum gate.
- Cancel works during validation and before execution.
- Execution reuses the ordinary bulk update path, linked to the validation job.
- The defects: a success message despite refused updates, and Organization unit paths unchecked until execution.
- More defects: wrong counts and an inert error-log button after a failure.
- More defects: a validated file that runs twice after a retry.
- More defects: untrimmed headers, stubbed permission checks, the whole file inside a JSON request body, and a bind-parameter limit.

### 2026-10-26, main chat: decisions D1 to D4

The eng-lead asked four decisions, each with a recommended option. The owner answered:

<!-- prettier-ignore -->
> D1) The checksum only flags a csv row has changed.  We then validate that the data for those rows in postgress is fresh. If it is not we first update it from google. We then do a  do a field by field update against only fresh data.
>
> D2) After the validation they can choose if they want to execute the changes or cancel. If they execute only valid changes are ran.
>
> D3) We add status. We add a specific coded string they have to use to deprovision so they cant accidently do it. It will be DEPROVISION:REASON.We create a specific list they have to use. This makes them have to look up the code so it reduces accidents.
>
> D4) The signed in persons drive. I have confirmed You came make an oauth token from DWD and pass it to the picker in the client. Ive done this before.

### 2026-10-26, main chat: import modes (D5)

<!-- prettier-ignore -->
> I want in the import UI. Have a selector that says "Sync all rows" and "Sync changes" Sync all rows ignores the checksum and force updates devices to what is in a sheet. This would be a way to have a set configuration that you want to reset a set of devices like a library card the same way everytime.

### 2026-10-26, main chat: answers on the defaults and D6

<!-- prettier-ignore -->
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

Answer 2 is decision D6. The [technical design](../research/batch-update-export-import-technical-design.md#142-universal-job-cancel-owner-decision-d6) defines the cancel.

### 2026-10-26, main chat: the cancel rules

The eng-lead asked five questions about the cancel. The owner answered:

<!-- prettier-ignore -->
> 1 Anyone with Job:Manage a platform admin, or the owner can cancel the job.
>
> 2) agreed
>
> 3) Nope cancelled is fine.  We will still have a status document even if it was cancelled. Any successes or failures that happened before the cancel will be recorded int he job results.
>
> 4) That is correct there is no ability to claw that back
>
> 5) That is fine

His answer calls the requester the owner of the job.

### 2026-10-26, main chat: the job cancel mockup

The eng-lead asked the owner to approve the job cancel mockup. He also recommended no cancel reason and the 30-second cancel check.
The owner answered:

> Thats fine.

### 2026-10-28, main chat: job cancel sign-off

The eng-lead asked for "signed off" and the numbers of the findings to change, and recommended findings 2 and 6.
The owner asked:

> What do 2 and 6 reresent?

The eng-lead answered, and the owner replied:

> Agreed I sign off on that.

The sign-off changes findings 2 and 6 (card `t_5355eacd`).
The owner kept HTTP/2 at the edge for finding 7 (card `t_82e670d2`). Owner: "Yea keep with http/2 if it wont turn into a development blocker."

After diagnosis `t_a4e965a3` the owner picked option 2, the edge fix. Owner: "2". PR #163 changed the edge sessions and merged as `3262e6a`.
The gated full run of PR #164 failed twice on the same restart test (`api-e2e/all-docker.test.mjs`). PR #165 reverted PRs #156 and #163 and merged as `567c602` on 2026-10-29. The edge serves HTTP/1.1 again, and finding 7 is open again.

On 2026-10-29 the owner chose option 1 for finding 7. Option 1 pauses the live updates of a background tab, and the tab catches up when the person switches back. Owner: "1 for now, but persue point 2".
Card `t_51ec6f43` builds option 1 and the frontend part of point 2.

On 2026-10-29 the eng-lead asked: "Rest of point 2 (the server change that gets the Devices page to 1 connection): reply yes (build it now) or no (not now, recommended)."
The owner replied: "yes".

PR #177 (card `t_51ec6f43`, merged as `c47a5b1`) built `LiveFeeds`. Each tab opens each feed once, and a hidden tab holds no feed.

PR #178 (card `t_a74f4a7c`, merged as `8108fb6`) built `GET /api/events`. It is one Server-Sent Events stream with the job feed and the device feed.
The device feed joins under the open rule of the Devices stream. Without `devices:read` or a sync, the stream carries the job feed only. A ping closes the stream when that changes.

PR #181 (card `t_31ebc0b2`, merged as `e770ee5`) moved every live feed of the browser to `/api/events`. `GET /api/jobs/events` and `GET /api/devices/events` no longer exist. A visible tab holds one live connection, and a hidden tab holds none.

### 2026-10-28, main chat: UI changes for export and import

The owner sent these changes for the CSV slice:

<!-- prettier-ignore -->
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

### 2026-10-28, main chat: build direction and the CSV slice mockup

Early that day the owner directed the build:

> Go ahead and execute on the import and export work.

After the first CSV slice mockup, he paused the work:

> Lets pause on the export/import work. There are changes to the UI that have to be made. Ill reply with changes when ready.

His UI changes follow in the section above. On version 2 of the mockup, he wrote:

> OK the flow looks good. It needs a graphic design UI./UX polish pass. Use the skill of a expert front end designer and make the UI/UX a professional experiance.

On version 3, he removed the file previews:

> I dont like having the export and import preview. Just the raw data in the dialog. We can do without that. The important UI is the results of the validation and the results of the execution.

On version 4, he approved the screens and directed the build:

> This is perfect. Please go ahead and execute on this.

The eng-lead then asked: "Failed tab on the execution results: yes or no." The owner answered:

> yes

Design section 8 also proposed that an Unknown outcome joins the Failed tab. The eng-lead asked for a yes or no. The owner answered:

> Unknown yes

### 2026-10-30, main chat: the Google Drive slice mockup

The owner directed the eng-lead to finish the export and import work:

> keep at it. Lets get this import export work past the goal line.

The eng-lead built version 1 of the Google Drive slice mockup for design gaps 2 and 7.
It showed the mockup with six questions, each with a recommended option. The owner answered:

> approve, all recommended

The six answers, each the recommended option of the [mockup notes](../ui/designs/2026-10-30-device-drive-slice-notes.md):

1. Reports offers a CSV file only. It hides the Google Sheet card until the report Sheet ships in the third slice.
2. The import step checks the header row of a chosen Drive file before Start validation. The browser reads the row with the one-hour Drive token.
3. The Picker lists My Drive only: the Google Sheets and CSV files of the person.
4. A Sheet export lands at the top level of My Drive.
5. The Google connection page shows the saved Picker API key in full.
6. Every person reads the fix in the Drive notes, as the built device notes do.

## Implementation defaults

The owner settled these points on 2026-10-26:

1. The status echo under D1 stays. An edited row whose Status still reads `ACTIVE` re-enables a device that another person disabled after the export. The review shows that Re-enable before Execute.
2. A blank cell keeps the value in both modes. `[clear]` clears a field.
3. Both modes refresh only stale devices. Sync all rows takes every row as a candidate row.
4. The plan expires 1 hour after validation completes.
5. Execute asks for the typed phrase DEPROVISION when the plan holds a Deprovision, as the Deprovision sheet does (`docs/workflows/wipe-powerwash-deprovision.md:33`).
6. Every job kind supports Cancel pending work (D6).
7. The requester, a person with `jobs:manage`, or a platform administrator can cancel a job.
8. Cancel pending work on the update job of an import also cancels its waiting status jobs.
9. A cancelled job ends Cancelled, also with an Unknown operation. Its results keep every outcome from before the cancel.
10. After every command of a command job is issued, Cancel pending work is not offered.
11. The universal job cancel ships first, as its own slice.
12. A cancel takes no reason. The job records the person and the time.
13. The worker reads a cancel request at each batch claim and each lease renewal. A running job stops within 30 seconds.

The remaining defaults are engineering choices for owner review, not owner decisions. Change them when the owner asks.
The [technical design](../research/batch-update-export-import-technical-design.md#21-owner-decisions-and-engineering-defaults) lists every default. These defaults change visible behavior:

1. The edit export writes Google's status value. `ACTIVE`, `DISABLED`, and Deprovision codes request a status, as in the reference implementation. Other values are export-only.
2. Status codes match exactly, in upper case. The reason codes are Google's four accepted reasons without the `DEPROVISION_REASON_` prefix (`libs/application-contracts/src/lib/devices.ts:588-606`).
3. Fresh means read from Google within 24 hours, the inventory rule (`libs/application-contracts/src/lib/entity-cache.ts:16-19`).
4. A failed refresh read rejects only the affected rows.
5. A field value that changes after validation stays outside the update job.
6. The status jobs of an import wait for its update job. A row with field changes and a Deprovision writes the fields first.
7. Sync changes is the default import mode.
8. The Checksum column is optional in Sync all rows. Every other template column is required in both modes.
9. `[clear]` rejects the row for Asset tag and Organization unit.
10. Export and import each hold at most 50,000 rows.
11. Export needs a new permission, `devices:export`.
12. Validation reads the organization unit tree from Google once and checks every Organization unit path.
13. Header matching ignores outer spaces and letter case. Blank rows count nowhere.
14. The import sheet checks a chosen CSV file for a header row and one data row before the upload.
15. A Sheet export offers no Cancel pending work after its Sheet write starts.
16. `jobs:manage` includes the job visibility of `jobs:read`.
17. A cancelled job with a failed or Unknown operation raises the Jobs attention dot.

## Design

Inspected through `figma-notes.md` and the exported frames, on 2026-10-23. The writer had no Figma access.
Frame `228:4524` was inspected in Figma on 2026-10-26.
The frames sit on Figma page 09 (`94:2`) in the file `lqZx6qpWevsN3AAfWkworl`. They predate the owner decisions of 2026-10-26.
Figma values are examples (`docs/ui/rules.md:91`).

| Node       | Frame name                               | Use                                                                 |
| ---------- | ---------------------------------------- | ------------------------------------------------------------------- |
| `216:4309` | Reference / Bulk Actions menu open       | Import and Export entries in Bulk Actions                           |
| `99:109`   | Screen / Devices / export                | Export content. The format choice and the purpose are missing.      |
| `104:524`  | State / export-ready                     | Export receipt. Its baseline expiry ends.                           |
| `228:5314` | Screen / Jobs / Detail / EXP-006         | Export job page                                                     |
| `106:426`  | State / file-picker                      | Import file choice. The mode selector and Google Drive are missing. |
| `99:145`   | Screen / Devices / import (Keep current) | Review counts. Its conflict card ends (D1).                         |
| `106:514`  | Screen / Devices / import (Use file)     | Ends (D1)                                                           |
| `106:579`  | Screen / Devices / import-preview-4      | Proposed changes: device, field, current value, new value           |
| `107:219`  | Screen / Devices / import-confirm-4      | Execute content                                                     |
| `109:250`  | State / import-receipt-4                 | Receipt after Execute                                               |
| `109:295`  | State / import-result-4                  | Result counts                                                       |
| `228:5550` | Screen / Jobs / Detail / IMP-004         | Job rows. The built job detail uses the same row model.             |
| `228:4996` | Screen / Jobs / Detail / IMP-012         | Cancel pending work on a queued job                                 |
| `228:4524` | Screen / Jobs / Detail / UPD-014         | Cancel pending work on a running job                                |
| `104:479`  | State / baseline-expired                 | Becomes the expired plan state                                      |
| `106:471`  | State / download                         | Rejected rows download                                              |
| `105:101`  | State / storage                          | Storage unavailable                                                 |

Design gaps:

The approved [CSV slice mockup](../ui/designs/2026-10-28-device-export-import.html) closes the CSV gaps. The state numbers below are its PNG numbers.

1. No frame shows the import mode selector. **Closed** by state 09.
2. **Closed** by states 01 to 13 of the approved [Google Drive slice mockup](../ui/designs/2026-10-30-device-drive-slice.html).
   No frame shows the Google Sheet export, the Picker, or the tab choice.
3. No frame shows status codes, the code list, or status actions in the review. **Closed** by states 11 and 13.
4. No frame shows rejected rows or warnings beside proposed changes. The frames show "0 invalid" only. **Closed** by states 13 to 15.
5. No frame shows Execute and Cancel on the validation job page. **Closed** by states 13, 16, and 20. Execute and Cancel import sit in the import dialog.
6. No frame shows the typed phrase in the import flow. The Deprovision frame `97:93` supplies the pattern. **Closed** by state 16.
7. **Closed** by states 14 and 15 of the approved Google Drive slice mockup.
   No frame shows the Google connection inputs: the Picker API key and the project number.
8. The frames use full pages. The built bulk actions use the side sheet. **Closed** by the UI changes of 2026-10-28 and the approved mockup.
   Export, Reports, and Import open one dialog. Its setup steps take the built 480 px dialog width, and the results widen it to 1120 px.
9. The conflict cards and the baseline expiry (`99:145`, `106:514`, `104:479`) contradict D1. **Superseded.** The mockup removes them.
10. No frame shows the cancel confirmation, Cancellation requested, or a Cancelled job. `228:4524` and `228:4996` show only the control.
    **Closed** by the approved [job cancel mockup](../ui/designs/2026-10-26-job-cancel.html) and its [notes](../ui/designs/2026-10-26-job-cancel-notes.md).
    State 16 of the approved CSV slice mockup draws the import confirmation that names the waiting status jobs.

## Exclusions and open decisions

Excluded from this workflow:

- Device creation, enrollment, or deletion. An unknown device ID never creates a device.
- Reboot, Wipe user data, and Powerwash in the file.
- Re-enable of a deprovisioned device, and the seven Google Deprovision reasons outside the verified four.
- Row-by-row selection in the review. Pause, Resume, and Retry of jobs.
- Export sharing with recipients and notification email.
- Google users, groups, and organizational units. Later phases reuse this design.
- A new navigation destination.
- Live Google writes.

Open decisions:

- The CSV slice builds from the approved mockup and its notes. The owner can change any engineering default.
- The approved Google Drive slice mockup closes design gaps 2 and 7. A design addendum comes before the Drive build cards.
- G16 keeps one open question: where explicit creation applies. A user CSV import stays a later workflow.
- Live device writes need explicit owner authorization and an enrolled test device.
- A live Google Sheet export creates a Google file. It needs explicit owner authorization.

## Risks

1. Overwrite of a newer value (D1). A candidate row compares every nonblank cell, Status included. A value that another person changed after the export returns to the file value. An exported `ACTIVE` re-enables a device that someone disabled since. The review shows each change before Execute. The owner accepted this risk on 2026-10-26.
2. Freshness window. In both modes, a device read within 24 hours counts as fresh. A value changed in the Admin console after that read stays invisible. The review then shows an old current value, and a reset keeps that change. A Refresh of the devices before the import closes the gap.
3. Blast radius. One file holds up to 50,000 rows, and Sync all rows applies every row. The guards are the review counts, Execute or Cancel, the per-row Deprovision code, and the typed phrase.
4. Deprovision is one-way and keeps local data (`docs/workflows/wipe-powerwash-deprovision.md:190`).
5. The Picker needs changes to the edge script and frame rules and to the referrer policy. The browser holds a `drive.file` token for one hour.
6. Annotated user and Notes hold personal data. Exported files leave Campus Commander.
7. The universal cancel changes the jobs contract, the job service, the worker, and the Jobs pages for every job kind.
8. A cancel request takes up to 30 seconds to stop a running batch. Requests sent in that time settle normally.

## Completion

The cancel slice demonstration is complete and signed off on 2026-10-28.
CQ1 cancelled a queued job and a running job of each kind on admin-sdk-mock.
Each job page showed the actual outcomes, and nothing rolled back.

Then demonstrate the CSV slice on admin-sdk-mock:

1. Export selected devices for editing to a CSV file. The file holds the template, Google's status values, and the checksums.
2. Import the unedited file with Sync changes. Every row is unchanged, and Execute stays disabled.
3. Edit a field, a clear, a status code, a mistyped Organization unit, an invalid cell, and a wrong reason code. Validation refreshes a stale device first. The review shows the proposed changes, the rejected rows, the warnings, and counts that add up.
4. Cancel the plan. Nothing runs. Cancel pending work on a running validation of a large file, and the job shows Cancelled.
5. Import again and Execute. The typed phrase gates the Deprovision. The update job runs, then the status jobs. Rejected rows never run.
6. Import a saved sheet with Sync all rows. Validation refreshes the stale devices and proposes only the differences. A second import proposes nothing.
7. A partial job shows each outcome.
8. Create a report of selected devices to a CSV file. The file holds the visible grid columns in grid order.
9. The import dialog shows the validation progress, the report, and the result of each change. The Failed tab lists the failed changes. No step needs the job page.

Demonstrate the Drive slice with the owner on his domain.
The Picker opens with the DWD token, and the import reads the chosen tab.
A live Google Sheet export waits for his authorization.
Run lint, tests, and builds for the affected Nx projects. Keep live write behavior marked "not verified".

## Sources

[1] https://developers.google.com/workspace/admin/directory/reference/rest/v1/chromeosdevices
[2] https://developers.google.com/workspace/admin/directory/reference/rest/v1/customer.devices.chromeos/batchChangeStatus
[3] https://developers.google.com/workspace/drive/picker/guides/overview
[4] https://developers.google.com/workspace/drive/api/guides/api-specific-auth
[5] https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueInputOption
