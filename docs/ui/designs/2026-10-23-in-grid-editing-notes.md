# In-grid editing and the single-device update: mockup notes

Approved as drawn on 2026-10-23. Owner, in the main chat: "Yea go ahead with this visual design." Built on 2026-10-23. It is not the built app.

- HTML: `in-grid-editing-mockup.html`, one self-contained file (base64 screenshots and fonts) with a state switcher at the bottom left.
- PNGs: `png/`, one per state, light theme, viewport 1440 x 900, deviceScaleFactor 1.
- Render checks: `render-report.json`. Calibration: `work/cal/`. AG Grid probes: `work/aggrid/`.
- Governing record: `docs/workflows/in-grid-editing.md` (owner-confirmed 2026-10-23), with the research in `in-grid-editing/findings.md` and `figma-notes.md`.

## Owner direction

Main chat, 2026-10-23, quoted from the record:

> I want to be clear about the design of the in grid edit. It should be transactional. It should show the state of cells that have changed. Above the grid it should show the count of cells that have a pending change. It should have a button to to toggle between the changed cells and unfiltered view. Each changed cell needs a roll back button icon. in the above the grid area where the info, filter toggle, you have have the save changes button and revert all changes. Save changesd creates a single update devices job.

> 1) If it is only ONE change create the job directly. If it is more that one go to the review and confirm as MORE than one can be over multiple pages.

His labels win over the Figma labels: "Save changes" and "Revert all changes", not "Save" and "Clear". The draft panel says pending changes, not unsaved changes.

| Owner element | States |
| --- | --- |
| The edit is transactional | 10, 11, and 12: one preview, one confirmation, one UPD job for the whole set |
| Changed cells show their state | 03 pending, 05 invalid, 06 conflict, 09 accepted and running |
| The count of cells with a pending change above the grid | 02 to 08, 10, and 11: the draft panel |
| One toggle between the changed cells and the unfiltered view | 03 "Show pending changes", 04 "Show all devices" |
| A roll back button icon in each changed cell | 03 to 08, 10, 11: the revert icon |
| Save changes and Revert all changes in the area above the grid | 02 to 08, 10, and 11: the draft panel, and 08 for the question |
| Save changes creates one update devices job | 09 one change, created directly. 10 to 12 several changes, Review, Confirm, and the job |

## States

| PNG | State | What it shows |
| --- | --- | --- |
| `01-no-pending-changes.png` | Grid, no pending change | Serial and the five editable columns. The pointer rests on 04A9BVS, so its editable cells show the pencil. |
| `02-asset-tag-in-edit.png` | A cell in edit | The AG Grid text editor in the Asset tag cell of 02A1MB6 with CB415508 typed. The draft panel counts the changed input and names the keys. |
| `03-pending-changes.png` | Pending changes | Five pending cells on four devices, each with its revert icon. The pointer rests on the revert icon of 04QVJBY, so the AG Grid tooltip names it. |
| `04-pending-view.png` | The toggle on | Only the four devices with a pending change. The toggle reads "Show all devices". |
| `05-invalid-cell.png` | An invalid pending cell | A pasted note of 512 characters in Notes of 0727D2E (limit 500). The reason sits in the draft panel, the counter in the tooltip, and Save changes is disabled. |
| `06-conflict-cell.png` | A conflict cell | Annotated location of 04XTBHJ changed in Google (Media center) after the edit (Library). The conflict card offers the two answers of Figma 104:389. Save changes is disabled. |
| `07-org-unit-picker.png` | The organization unit picker | The built picker dialog opened from the Organization unit cell of 02A1MB6, with Cart Devices chosen. Its Choose leads to state 03, where that cell is pending. |
| `08-revert-all-question.png` | Revert all changes | The question, asked once, names five changes on four devices. |
| `09-one-change-saved.png` | Save changes with one pending change | The job UPD-006 exists at once and the Update device sheet shows its receipt. The saved cell shows the accepted value while the job runs. |
| `10-several-changes-review.png` | Save changes with five pending changes | The Update device sheet at Review: one row per device and field, each with its own value. |
| `11-several-changes-confirm.png` | Confirm | One sentence per device and field, the acknowledgement checked, and Create update job. |
| `12-update-job.png` | The job page of UPD-007 | One row per device and field. 04QVJBY failed on Google quota and keeps its old value. Full-page capture, 1440 x 1206. |
| `13-device-details.png` | Device details | "Update device" between "Back to devices" and "Next device" (Figma 94:39). |
| `14-single-device-sheet.png` | Update one device | The Update device sheet over device details with five fields in record order, Asset tag set to Update. |

State 12 is the only full-page capture, because the job page is taller than the viewport. The sheet body of state 14 scrolls, so its summary line sits above the visible part and all five fields show in full. The Review table of state 10 continues 41 px below the visible part of the sheet body, and the text of its last row shows in full.

## Scenario and data

One inventory in every state: the 7,000-device inventory of the update device fields review (2026-10-22 build, "Inventory observed Oct 22, 2:05 PM"), with its first eight devices in serial order. No new device, person, job type, or organization unit enters the mockup.

- The pending set of state 03: 02A1MB6 Asset tag CB415508 and Organization unit /Chrome Devices/Pine Valley Elementary School/Cart Devices, 04QVJBY Asset tag CB415509, 04XTBHJ Annotated location Library, 0727D2E Notes Hinge repaired. That is five pending changes on four devices.
- IDs follow the built patterns: preview PV-010, jobs UPD-006 (one change) and UPD-007 (five changes). States 09 and 10 to 12 are two separate saves.
- Real values come from the review screenshots `setup-devices.png`, `step1-06-grid-after.png`, `step1-03-review-preview.png`, and `step2-04-ou-preview.png`.
- 01P0T1V, 02A1MB6, and 02QJANY hold the annotation values that an earlier review run wrote (suffix mvjusgh0). The mockup keeps them, because the inventory of Oct 22, 2:05 PM holds them.
- Four Organization unit paths (04QVJBY, 04XTBHJ, 0727D2E, 08V5B5S) show only in part in the screenshots. The mockup holds the visible prefix with an ellipsis, and `render.cjs` checks that every such cell truncates before the prefix ends.
- The screenshots show the annotated users up to about 20 characters. The mockup completes them with the connected domain example.org.
- "Last device contact: 3 h ago" for 04A9BVS comes from the approved device details design of 2026-10-21. The Oct 22 screenshots do not show the Device contact column.
- Drafted values: CB415508, CB415509, CB488031, Library, Hinge repaired, Media center, and the 512-character note.
- The PNGs show the header of the review build: the connected domain and a simulated customer ID. The page footer comes from the same build.

## Build and checks

- `python3 build.py` composes the backgrounds from the real screenshots and asserts every pixel assumption. The grid header holds real crops of the six column headers, resized to fit 994 px.
- `node render.cjs` renders the PNGs with the repository Playwright, route-aborts every request that is not `file:` or `data:`, collects the visible text, and runs the click test.
- `python3 check-strings.py` proves each app-sourced string against the `origin/main` snapshot in `work/main-src` (d5dc91d) and fails on an unlisted or stale string.
- `python3 work/cal/cal.py` re-creates six real regions with the mockup CSS: grid cells 0.000, the AG Grid text editor 0.007, the AG Grid tooltip 0.001, the status bar 0.000, the picker dialog 0.000, and the Update device sheet at Review 0.000 (mean difference per pixel and channel, 0 to 255).
- Render report: zero page errors, zero console errors, zero blocked requests, zero failed requests, zero overflow problems. Grid cells truncate long values with an ellipsis, as AG Grid does, and the report lists them under `truncatedCells`.

## Composition choices

The record and the designs leave these open. Each item names the pick and the reason.

1. **Draft panel place.** Between the empty-selection note and the grid, at the full content width, 56 px tall. The owner asks for it above the grid, and DRAFT-02 puts it between the filter row and the grid. The built note keeps its place.
2. **Draft panel look.** The `.action-note` shape of `devices.css` with a 4 px accent edge and the accent tint of a pending cell. It reuses the page note shape and ties the panel to the cells it counts.
3. **Draft panel order.** The count on the left, then "Show pending changes", "Revert all changes", and "Save changes" on the right. Save changes is the only filled button and sits last, as in Figma 171:1065 and as Bulk Actions sits last in the filter row.
4. **Toggle.** One outlined button whose label switches between "Show pending changes" and "Show all devices", with `aria-pressed`. It stays disabled until a change is staged.
5. **Count during an edit.** A changed value in an open editor counts as one pending change (state 02), because DRAFT-02 shows the draft panel during changed input and Figma 171:842 counts it.
6. **Key hint.** The second line of the draft panel names the field and the keys during an edit. Figma 171:842 puts the hint in the grid footer, which sits below the fold once the draft panel opens.
7. **Pending cell.** A 2 px accent border inside the cell, the 8 % accent tint, and a 26 px revert icon ("undo") at the right edge in link color. The tint equals the row hover tint, so the border and the icon carry the state, and color never works alone (DRAFT-02).
8. **Pencil.** The pencil of Figma 171:842 shows on the editable cells of the row under the pointer only. Forty pencils crowd the grid and cut 20 px from every value, and without them the revert icons are the only icons in the grid body.
9. **Invalid cell.** A 2 px error border, the error tint, an error icon beside the revert icon, the reason in the draft panel, and the counter in the AG Grid tooltip of the error icon. Save changes is disabled. The toggle, the revert icons, and Revert all changes stay available (DRAFT-02). The reason ends with the built validation message of the Update device sheet ("Notes holds 1 to 500 characters.", `deviceUpdateValueError`). An emptied Notes cell stages Clear value (record, cell rule 3), so a pending Update holds 1 to 500 characters.
10. **Over-limit example.** A pasted note of 512 characters (Notes holds 500), because a paste over the Asset tag limit of 256 or the Annotated user limit of 100 is rare.
11. **Conflict cell.** A 2 px warning border, the warning tint, and a conflict icon that opens a card with the content of Figma 104:389 next to the cell. Save changes stays disabled until the person answers. The grid already knows the conflict, so the person resolves it where it shows instead of meeting a blocked Review.
12. **Picker for one cell.** The built picker dialog, with its count line replaced by the device and its current unit (Figma 171:1283), because "1 device" names no device. The PNG shows the dialog, and state 03 shows the resulting pending cell.
13. **Revert all changes question.** The picker dialog shape, a title that names the count, one sentence that names the cells and the devices, one sentence that says nothing restores them, and "Cancel" and "Revert all changes". No confirmation dialog exists in the app to copy.
14. **One-change save.** The Update device sheet opens at its receipt without the stepper, because the person saw no step. The saved cell shows the accepted value with a clock icon, and its AG Grid tooltip names the job (design gap 2).
15. **Several-change save.** The Update device sheet opens at Review with Edit done. Its second button is the built "Review pending devices", which returns to the pending view, because the grid has no Edit step.
16. **Confirm sentences.** One sentence per device and field: the built sentence templates with the serial in place of the device count.
17. **Job rows.** Devices in grid order, fields in record order. A failed row keeps the built failure sentence and adds "The device keeps its old value." The failure is Google quota, a built outcome that leaves the device value unchanged.
18. **Columns.** The person shows Serial and the five editable columns and hides Model and Battery, so all five editable columns fit the 994 px grid.
19. **Pending view counts.** The built status line counts the pending view ("4 matching devices"), and Select All counts four.
20. **Single-device sheet.** The built title "Update 1 device", five fields in record order, and Asset tag with Leave unchanged and Update only. "Review pending devices" stays out, because a single device has no grid selection. The details card beside the sheet shows the current values, so the sheet adds no current-value lines.
21. **Device details button.** "Update device" is the filled button between "Back to devices" and "Next device" (Figma 94:39).

## Issues found

Product questions for the owner:

1. The empty-selection note "Select one or more devices to update." stays above the draft panel (built behavior). Next to "Save changes" it reads as a contradiction, because it speaks about the Bulk Actions sheet. Options: keep it, hide it while the grid draft holds a change, or reword it.
2. A conflict that the grid already knows blocks Save changes in this mockup. The alternative: Save changes opens Review, and Review blocks Continue to confirmation until the person answers.

Per-field limits that the screens use: Asset tag 256 (record ruling 6, new), Annotated location 200, Annotated user 100, Notes 500, Organization unit path 4,096.

Build notes for the engineers:

- The job label stays the built "Update device annotations". The owner calls it an update devices job.
- The receipt of state 09 keeps "View job" without a target in the HTML, because the mockup draws no page for UPD-006.
- The Confirm heading counts fields across devices ("Update 4 fields on 4 devices"), because the built heading counts changed fields.

Defects inherited from the reference build: none found.

## App-sourced strings

121 strings. Each line names the file of `work/main-src` that holds the literal, or the files that hold the template pieces (`check-strings.py`, TEMPLATES).

- "4 matching devices · 7,000 in district" · template in device-status-panel.ts
- "Inventory observed Oct 22, 2:05 PM" · template in device-status-panel.ts
- "Selected on current page: 0" · template in ssrmSelectionService.js
- "Total Selected: 0" · template in ssrmSelectionService.js
- "Select All (4)" · template in ssrmSelectionService.js
- "Deselect All" · template in ssrmSelectionService.js
- "Show All Selected (0)" · template in ssrmSelectionService.js
- "512 of 500 characters" · template in device-update-messages.ts, devices.ts
- "Choose organization unit" · frontend/src/app/devices/device-org-unit-picker.html
- "Find an organization unit" · frontend/src/app/devices/device-filter.html
- "Use arrow keys to navigate. Press Enter or Space to select an organizational unit." · frontend/src/app/schools/ou-reference-picker.html
- "Root organizational unit" · frontend/src/app/schools/ou-reference-picker.ts
- "Selected: /Chrome Devices/Pine Valley Elementary School/Cart Devices" · template in device-org-unit-picker.html
- "Cancel" · frontend/src/app/devices/device-filter.html
- "Choose" · frontend/src/app/devices/device-action-sheet.ts
- "Organizational units" · frontend/src/app/schools/ou-reference-picker.html
- "Update job created" · frontend/src/app/devices/device-update-sheet.ts
- "Job UPD-006 · Accepted" · template in job-fields.ts, job-receipt-messages.ts
- "Your job is saved" · frontend/src/app/jobs/job-receipt-messages.ts
- "1 device · 1 field change. Google changes have not completed." · template in device-update-messages.ts, job-receipt-messages.ts
- "You can close this panel and follow progress in Jobs." · frontend/src/app/jobs/job-receipt-messages.ts
- "View job" · frontend/src/app/devices/device-action-sheet.html
- "Done" · frontend/src/app/devices/device-action-sheet.html
- "Close" · frontend/src/app/devices/device-action-sheet.html
- "Review 4 device updates" · template in device-update-flow.ts
- "Frozen preview · Prepared Oct 22, 2:21 PM" · template in device-update-sheet.ts
- "Edit" · frontend/src/app/devices/device-update-sheet.ts
- "2" · template in device-update-sheet.html, job-detail.html
- "Review" · frontend/src/app/devices/device-action-sheet.ts
- "3" · template in device-update-sheet.html, job-detail.html
- "Confirm" · frontend/src/app/devices/device-action-sheet.ts
- "4 devices · 5 field changes · 0 excluded" · template in device-update-flow.ts
- "Targets and final values are frozen. New matching devices will not join this job." · frontend/src/app/devices/device-update-flow.ts
- "Prepared Oct 22, 2:21 PM · Expires Oct 22, 2:36 PM · Preview PV‑010" · template in device-update-flow.ts
- "Field changes" · frontend/src/app/devices/device-update-sheet.html
- "Frozen update targets" · frontend/src/app/devices/device-update-sheet.html
- "Field" · frontend/src/app/devices/device-update-sheet.html
- "Observed value" · frontend/src/app/devices/device-update-sheet.html
- "Change" · frontend/src/app/devices/device-update-sheet.html
- "Approved value" · frontend/src/app/devices/device-update-sheet.html
- "Asset tag" · frontend/src/app/devices/device-fields.ts
- "No value" · frontend/src/app/devices/device-update-flow.ts
- "Organization unit" · frontend/src/app/devices/device-fields.ts
- "Annotated location" · frontend/src/app/devices/device-detail.html
- "Notes" · frontend/src/app/devices/device-detail.html
- "Continue to confirmation" · frontend/src/app/devices/device-action-sheet.html
- "Review pending devices" · frontend/src/app/devices/device-grid.ts
- "Update device steps" · frontend/src/app/devices/device-update-sheet.html
- "Confirm 4 device updates" · template in device-update-flow.ts
- "Review the approved scope" · frontend/src/app/devices/device-action-sheet.ts
- "Update 4 fields on 4 devices" · template in device-update-flow.ts
- "Annotated user remains unchanged." · template in device-update-flow.ts
- "Preview PV-010 · 4 devices · 5 field changes" · template in device-update-flow.ts
- "Expires Oct 22, 2:36 PM" · template in device-update-flow.ts
- "I reviewed all 4 devices and their final values." · template in device-update-flow.ts
- "Create update job" · frontend/src/app/devices/device-update-sheet.html
- "Back to preview" · frontend/src/app/devices/device-action-sheet.html
- "Update device annotations" · libs/application-contracts/src/lib/jobs.ts
- "Job UPD-007 · Completed with errors" · template in job-detail.ts
- "Back to jobs" · frontend/src/app/jobs/job-detail.html
- "Refresh" · frontend/src/app/devices/devices.html
- "UPD-007 · 4 devices" · template in job-detail-fields.ts
- "Completed with errors" · frontend/src/app/jobs/job-fields.ts
- "Requested by Review administrator · Oct 22, 2:23 PM · Duration: 4s" · template in job-detail-fields.ts, job-fields.ts
- "Operation counts" · frontend/src/app/jobs/job-detail.html
- "Succeeded" · frontend/src/app/jobs/job-detail-fields.ts
- "4" · template in device-update-sheet.html, job-detail.html
- "Failed" · frontend/src/app/jobs/job-detail-fields.ts
- "1" · template in device-update-sheet.html, job-detail.html
- "Unknown" · frontend/src/app/jobs/job-detail-fields.ts
- "0" · template in device-update-sheet.html, job-detail.html
- "Expired" · frontend/src/app/jobs/job-detail-fields.ts
- "Pending" · frontend/src/app/jobs/job-detail-fields.ts
- "Skipped" · frontend/src/app/jobs/job-detail-fields.ts
- "Cancelled" · frontend/src/app/jobs/job-detail-fields.ts
- "Operation results" · frontend/src/app/jobs/job-detail.html
- "Show 1 needing attention" · template in job-detail.html
- "Operation results for job UPD-007" · template in job-detail.html
- "Device" · frontend/src/app/devices/device-action-sheet.html
- "Operation" · frontend/src/app/jobs/job-detail.html
- "Before" · frontend/src/app/devices/device-columns.ts
- "Requested" · frontend/src/app/jobs/job-detail.html
- "Outcome" · frontend/src/app/jobs/job-detail.html
- "Updated" · frontend/src/app/invitations/invitations.html
- "Actions" · frontend/src/app/jobs/job-detail.html
- "Not set" · frontend/src/app/devices/device-detail.html
- "Google quota stopped the update for 04QVJBY." · template in job-detail-fields.ts
- "Inspect failure" · frontend/src/app/jobs/job-detail.html
- "Rows 1–5" · template in job-detail-fields.ts
- "Latest activity" · frontend/src/app/jobs/job-detail.html
- "2:23 PM · Google quota stopped the update for 04QVJBY." · template in job-detail-fields.ts
- "Operation results table" · frontend/src/app/jobs/job-detail.html
- "Open device 02A1MB6" · template in job-detail.html
- "Open device 04QVJBY" · template in job-detail.html
- "Open device 04XTBHJ" · template in job-detail.html
- "Open device 0727D2E" · template in job-detail.html
- "Previous operations page" · frontend/src/app/jobs/job-detail.html
- "Next operations page" · frontend/src/app/jobs/job-detail.html
- "Device details · /Chrome Devices/Pine Valley Elementary School/Cart Devices" · template in device-detail.html
- "Back to devices" · frontend/src/app/devices/device-action-messages.ts
- "Update device" · frontend/src/app/devices/devices.html
- "Next device" · frontend/src/app/devices/device-detail.html
- "Dell Chromebook 3100 · CB488013" · template in device-detail.ts
- "Read from Google Oct 22, 2:05 PM" · template in device-detail.html
- "Annotated user" · frontend/src/app/devices/device-detail.html
- "Last device contact: 3 h ago" · template in device-detail.html, device-fields.ts
- "No battery report" · frontend/src/app/devices/device-detail.html
- "Google has not reported battery data for this device." · frontend/src/app/devices/device-detail.html
- "Common causes: the ReportDevicePowerStatus device policy is off, or the device has no battery." · frontend/src/app/devices/device-detail.html
- "Update 1 device" · template in device-update-messages.ts, device-update-sheet.ts
- "Draft changes · Not submitted" · frontend/src/app/devices/device-update-sheet.ts
- "1 device · 1 changed field · Not submitted" · template in device-update-messages.ts, device-update-sheet.ts
- "Your draft stays available when you filter, scroll, or refresh." · frontend/src/app/devices/device-update-sheet.html
- "Leave unchanged" · frontend/src/app/devices/device-update-sheet.html
- "Update · Replace the existing value" · frontend/src/app/devices/device-update-sheet.html
- "New value" · frontend/src/app/devices/device-update-sheet.html
- "Use 256 characters or fewer. Spaces alone do not count." · template in device-update-messages.ts
- "8 of 256 characters" · template in device-update-messages.ts
- "To remove an annotation, choose Clear value explicitly." · frontend/src/app/devices/device-update-sheet.html
- "Save and preview" · frontend/src/app/devices/device-update-sheet.html
- "Reset" · frontend/src/app/devices/device-update-sheet.html

## Mockup data

Serials, inventory values, typed values, organization unit names, and times. Grid cell texts are always data.

- "Chrome Devices" · state 07
- "Pine Valley Elementary School" · state 07
- "Cart Devices" · state 07
- "Pine Valley Elementary School/Cart Devices" · state 07
- "02A1MB6" · state 10
- "CB415508" · state 10
- "04QVJBY" · state 10
- "CB415509" · state 10
- "04XTBHJ" · state 10
- "Front Office" · state 10
- "Library" · state 10
- "0727D2E" · state 10
- "Hinge repaired" · state 10
- "/Chrome Devices/Owens Middle/One to One" · state 10
- "/Chrome Devices/Pine Valley Elementary School/Cart Devices" · state 10
- "2:23 PM" · state 12
- "04A9BVS" · state 13
- "CB488031" · state 14
- "01P0T1V" · grid cell, state 01
- "CB662467" · grid cell, state 01
- "/Chrome Devices/Lowell Academy/One to One" · grid cell, state 01
- "North lab mvjusgh0" · grid cell, state 01
- "Cart 7 loaner pool mvjusgh0" · grid cell, state 01
- "awells322@example.org" · grid cell, state 01
- "02QJANY" · grid cell, state 01
- "CB246165" · grid cell, state 01
- "dhenry37@example.org" · grid cell, state 01
- "/Chrome Devices/Lowell School/One to One" · grid cell, state 01
- "CB488013" · grid cell, state 01
- "mbennett27@example.org" · grid cell, state 01
- "/Chrome Devices/Lowell …" · grid cell, state 01
- "Screen replaced" · grid cell, state 01
- "CB412049" · grid cell, state 01
- "deborah.warren@example.org" · grid cell, state 01
- "CB970992" · grid cell, state 01
- "tdaniels29@example.org" · grid cell, state 01
- "/Chrome Devices/Hughes…" · grid cell, state 01
- "08V5B5S" · grid cell, state 01
- "CB438308" · grid cell, state 01
- "/Chrome Devices/Keller H…" · grid cell, state 01
- "Repair log. Sep 3, 2026: hinge repaired at the district depo…" · grid cell, state 05, 512 characters

## Drafted strings

36 drafted strings for owner review, grouped by pattern. Each line names the first state that shows it.

### Draft panel count (record copy, recorded default 5)

- "1 pending change · 1 device" · state 02
- "5 pending changes · 4 devices" · state 03
- "4 pending changes · 4 devices" · state 07

### Draft panel buttons (owner words and record copy)

- "Show pending changes" · state 02
- "Revert all changes" · state 02
- "Save changes" · state 02
- "Show all devices" · state 04

### Draft panel line during an edit (Figma 171:842 footer text)

- "Editing asset tag · Enter or Tab stages this value · Escape cancels" · state 02

### Draft panel line in the pending view

- "Showing only devices with pending changes. Show all devices returns to your filters." · state 04

### Draft panel line for an invalid cell

- "1 change cannot be saved. 0727D2E · Notes holds 1 to 500 characters." · state 05

### Draft panel line for a conflict cell

- "1 conflict. Annotated location of 04XTBHJ changed in Google after your edit. Resolve it to save." · state 06

### Revert icon name and tooltip (findings section 5)

- "Revert Asset tag of 04QVJBY" · state 03
- "Revert Asset tag of 02A1MB6" · state 03
- "Revert Organization unit of 02A1MB6" · state 03
- "Revert Annotated location of 04XTBHJ" · state 03
- "Revert Notes of 0727D2E" · state 03

### Name of the cell editor

- "Asset tag of 02A1MB6" · state 02

### Name of the conflict icon

- "Resolve the conflict on Annotated location of 04XTBHJ" · state 06

### Conflict card (content of Figma 104:389)

- "The location changed after you began editing" · state 06
- "04XTBHJ · Annotated location" · state 06
- "Baseline: Front Office" · state 06
- "Your draft: Library" · state 06
- "Current value: Media center" · state 06
- "Keep current value" · state 06
- "Keep my draft" · state 06

### Picker line for one cell (Figma 171:1283 pattern)

- "02A1MB6 · Current: /Chrome Devices/Owens Middle/One to One" · state 07

### Revert all changes question

- "Revert 5 pending changes?" · state 08
- "The 5 changed cells on 4 devices return to their inventory values. Your filters stay as they are." · state 08
- "You cannot restore reverted changes." · state 08

### Tooltip of a cell while its job runs

- "UPD-006 · Google changes have not completed." · state 09

### Confirm sentences per device and field (built templates with a serial)

- "Set the asset tag to CB415508 on 02A1MB6." · state 11
- "Set the asset tag to CB415509 on 04QVJBY." · state 11
- "Set the annotated location to Library on 04XTBHJ." · state 11
- "Set the notes to Hinge repaired on 0727D2E." · state 11
- "Move 02A1MB6 into /Chrome Devices/Pine Valley Elementary School/Cart Devices. Destination policies apply." · state 11

### Job row note for a failed device

- "The device keeps its old value." · state 12
