# Batch update devices through export and import

Status: proposed. On 2026-10-26 the owner answered decisions D1 to D4 and added the import modes (D5). He also supplied notes on his earlier implementation.
Later that day he answered the open defaults, directed a universal job cancel (D6), and set its rules.
The mockup comes next. The record waits for the owner's confirmation with the mockup.

Source: owner direction of 2026-09-03, 2026-10-21, 2026-10-24, and 2026-10-26, quoted under [Owner direction](#owner-direction).

Design: [Figma page 09](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=94-2), with the frame table under [Design](#design). Design gaps remain. A mockup comes before the build.
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
15. The worker reads a cancel request at each batch claim and each lease renewal. A running job stops within 30 seconds.
16. A Sheet export offers no Cancel pending work after its Sheet write starts.
17. `jobs:manage` includes the job visibility of `jobs:read`.
18. A cancelled job with a failed or Unknown operation raises the Jobs attention dot.

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

1. No frame shows the import mode selector. **Open.**
2. No frame shows the Google Sheet export, the Picker, or the tab choice. **Open.**
3. No frame shows status codes, the code list, or status actions in the review. **Open.**
4. No frame shows rejected rows or warnings beside proposed changes. The frames show "0 invalid" only. **Open.**
5. No frame shows Execute and Cancel on the validation job page. **Open.**
6. No frame shows the typed phrase in the import flow. The Deprovision frame `97:93` supplies the pattern. **Open.**
7. No frame shows the Google connection inputs: the Picker API key and the project number. **Open.**
8. The frames use full pages. The built bulk actions use the side sheet. The mockup places Export and Import in the sheet and the review on the validation job page. **Open.**
9. The conflict cards and the baseline expiry (`99:145`, `106:514`, `104:479`) contradict D1. **Superseded.** The mockup removes them.
10. No frame shows the cancel confirmation, Cancellation requested, or a Cancelled job. `228:4524` and `228:4996` show only the control. **Open.**

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

- The owner confirms this record and the remaining implementation defaults with the mockup.
- The mockup closes the open design gaps before the build.
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

Demonstrate the cancel slice on admin-sdk-mock first. Cancel a queued job and a running job of each kind.
Each job page shows the actual outcomes, and nothing rolls back.

Then demonstrate the CSV slice on admin-sdk-mock:

1. Export selected devices for editing to a CSV file. The file holds the template, Google's status values, and the checksums.
2. Import the unedited file with Sync changes. Every row is unchanged, and Execute stays disabled.
3. Edit a field, a clear, a status code, a mistyped Organization unit, an invalid cell, and a wrong reason code. Validation refreshes a stale device first. The review shows the proposed changes, the rejected rows, the warnings, and counts that add up.
4. Cancel the plan. Nothing runs. Cancel pending work on a running validation of a large file, and the job shows Cancelled.
5. Import again and Execute. The typed phrase gates the Deprovision. The update job runs, then the status jobs. Rejected rows never run.
6. Import a saved sheet with Sync all rows. Validation refreshes the stale devices and proposes only the differences. A second import proposes nothing.
7. A partial job shows each outcome.

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
