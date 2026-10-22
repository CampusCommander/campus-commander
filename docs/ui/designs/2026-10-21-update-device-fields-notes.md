# Update device with five fields: mockup notes

Proposal mockup for owner approval. It is not the built app.
Record: `docs/workflows/update-device-fields.md` (owner-confirmed 2026-10-21).
Composition source: the approved sheet `docs/ui/designs/2026-10-20-bulk-action-sheet.html`, the approved step 5 mockup `docs/ui/designs/2026-10-21-device-commands.html`, and the shipped sheet of the 2026-10-20 review build.
Content source: the Figma frames named in the record (content and copy only). Owner design rules: the sheet keeps the user in the grid, and Material 3 governs buttons and menus.

## Files

- `update-device-fields-mockup.html` · one self-contained file (screenshots, the app theme, Roboto, and Material Symbols as base64). Open it in a browser. The state switcher sits at the bottom left. Deep links: `#01-edit-leave-unchanged` to `#11-device-details`. The selects open, the values accept typing, and the counters, the validation, and the footer buttons follow the typed values.
- `png/` · one PNG per state, light theme, viewport 1440 x 900, deviceScaleFactor 1.
- `render-report.json` · output of `render.cjs`: geometry, overflow checks, scroll containers, visible strings, click test, requests, errors.
- `build.py` · composes the backgrounds from real screenshots and writes the HTML. It asserts every pixel assumption first.
- `render.cjs` · renders the PNGs with the repository Playwright. It aborts every request that is not `file:` or `data:`.
- `check-strings.py` · classifies every visible string and proves the app-sourced ones. It fails when this file misses a string or lists a stale one.
- `src/` · the template and the composed backgrounds.
- `work/theme/` · the app theme of `styles.scss`, compiled with the repository sass (`theme.scss` to `theme.css`).
- `work/material/extract.py` · copies the Angular Material 22 form-field, select, and option CSS out of the repository bundles.
- `work/cal/` · the calibration harness (`cal.py`, `calibrate.cjs`, `cal-results.json`, diff images).

Rebuild in the mockup package: `python3 work/material/extract.py && python3 build.py && node render.cjs && python3 check-strings.py`.

## States

| PNG                            | Background                    | What it shows                                                                                                                                         |
| ------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-edit-leave-unchanged.png`  | Devices grid, 6 rows selected | Edit step: the five fields, each at Leave unchanged. Save and preview and Reset are disabled.                                                         |
| `02-edit-three-changes.png`    | same, page grown to 1141 px   | Asset tag Replace, Notes Replace, and Organization unit Move with the chosen destination. The summary counts 3 changed fields.                        |
| `03-ou-picker-dialog.png`      | same                          | The picker dialog over the scrim: current OUs, search, tree, selected path, Cancel and Choose. The sheet behind shows the Organization unit field.    |
| `04-notes-over-limit.png`      | same                          | Notes holds 553 characters. The field shows the error state, the message names the field and the limit, and Save and preview is disabled.             |
| `05-ou-read-scope-missing.png` | same                          | The Organization unit field is disabled. The note under it names the read scope, with Copy scope and Recheck.                                         |
| `06-review-preview.png`        | same                          | Frozen preview PV-009: one row group per device, one row per changed field, before and after values, and the excluded device 02A1MB6 with its reason. |
| `07-confirm.png`               | same                          | Confirm step: one change per field with its device count, the counts line, the checked acknowledgment, and the enabled Create update job.             |
| `08-receipt.png`               | same                          | Receipt for UPD-007: Your job is saved, View job, Done.                                                                                               |
| `09-job-detail.png`            | Jobs shell                    | Job detail of UPD-007: rows per device and field, a Succeeded row, a Failed row with its reason, and Unknown rows with Reconcile.                     |
| `10-grid-annotated-user.png`   | Devices grid, no selection    | The optional Annotated user column, shown after Asset tag.                                                                                            |
| `11-device-details.png`        | Devices shell                 | Device details of 04A9BVS with the Annotated user row.                                                                                                |

Two states are full-page captures:

- State 02 (PNG 1440 x 1141). At 1440 x 900 the sheet body scrolls. The capture grows the page until the whole draft shows, and the page footer moves to the bottom edge.
- State 09 (PNG 1440 x 1268). The job detail page is taller than the viewport. The full page shows the job status, the first operations page, and the latest activity together.

States 03, 04, and 05 scroll the sheet body to the field that the state is about. State 06 shows the top of the preview. The rest of the table scrolls inside the sheet body.

## Scenario

- The 6 selected devices are rows 1, 2, 3, 5, 6, and 7 of the review inventory: 01P0T1V, 02A1MB6, 02QJANY, 04QVJBY, 04XTBHJ, 0727D2E. 04A9BVS and 08V5B5S stay unselected.
- The draft sets Asset tag to PV-CART-07, sets Notes to "Cart 7 loaner pool", and moves the devices to /Chrome Devices/Pine Valley Elementary School/Cart Devices.
- The grid truncates the Lowell paths. The scenario uses /Chrome Devices/Lowell Academy/One to One, the path that the details of 04QVJBY show (`step-9-orgunit-next-device.png`). 0727D2E sits in /Chrome Devices/Hughes Academy/One to One (`step-9-model-next-device.png`).
- Preview PV-009 excludes 02A1MB6 as Removed from inventory. A removed device has no observed values, so its rows show "No value".
- Job UPD-007 carries 5 devices and 15 operations. The first page shows two devices. For 01P0T1V, Google confirmed Asset tag and Notes, and the read-back still shows the source OU, so the move failed with "does not hold the requested value". For 02QJANY, the write response was lost, so all three fields are Unknown until Reconcile. The other three devices succeeded. The job needs review.
- State 03 searches with a path fragment. No screenshot shows the other category OUs of a school, so the tree holds only nodes that the screenshots show.
- State 10 shows the inventory before the update scenario. The Annotated user values are example.org addresses.
- State 11 shows 04A9BVS, which the update scenario does not touch. Its other values come from the real details page of 04A9BVS (`step-4-no-report-details.png`).

## Fidelity

Every background is a real screenshot of the 2026-10-20 review build (`screenshots/q1c/`). `build.py` composes them:

- Selected grid: `q1c-start-devices.png` with the empty-selection note removed from the content column. Each selected row takes the look of the real selected row in `q1c-refresh-selected-status.png` (checked within 1 level per channel). The header checkbox comes from `q1c-3-selection-note.png`. The navigation column takes its part of the page footer from the uncut screenshot, so the footer rows equal `q1c-2-edit.png`.
- Annotated user column: the Organization unit column moves right by one 200 px column. The new header copies the real Asset tag header with its filter and menu icons.
- Jobs shell: `q1c-3-jobs.png`, extended to the page height by repeating one empty navigation row.
- Devices shell for the details page: `q1c-start-devices.png` above the content, an empty content column, and the page footer at the viewport bottom.

The overlays copy the app CSS (`device-update-sheet.css`, `devices.css`, `device-detail.css`, `job-detail.css`, `styles.scss`, `tokens.css`, the LibreGrid status bar). The Material form fields, selects, and options use the CSS of Angular Material 22.2.2 from the repository bundles and the app theme compiled from `styles.scss` with the repository sass. Only the DOM and the notch width come from the mockup script, as `MatFormFieldNotchedOutline` computes it.

Calibration (`work/cal/cal.py`) re-creates five real screen regions with the mockup CSS and diffs them. Mean absolute difference per pixel (0 to 255):

| Real screen                                                                        | Mean difference | Note                                                  |
| ---------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------- |
| Edit step of `q1c-2-edit.png`                                                      | 0.000           | identical, with the hover outline of the real pointer |
| Device details of `step-4-no-report-details.png` (2026-10-16 build, same template) | 0.000           | identical                                             |
| Job detail of `q1a-4-needs-review.png`                                             | 0.072           | row action labels within 1 px                         |
| Receipt sheet of `q1c-3-created.png`                                               | 0.107           | no pixel over 24 levels                               |
| Confirm sheet of `q1c-3-confirm.png`                                               | 0.110           | checkbox label within 1 px                            |

The device details start 14 px higher than the job detail. The calibration fixed that offset.

## Composition choices left open by the record and the designs

1. Field order. The record order: Annotated location, Asset tag, Annotated user, Notes, Organization unit.
2. Field block. One Material outlined select per field, labeled with the field name. Its value is the mode, and the default is Leave unchanged (94:75). A Replace adds a "New value" field 8 px under the select. Step 4 put the value field first and one Change mode select under it. The five-field draft needs the mode first, because each field starts at Leave unchanged.
3. Mode names. Leave unchanged (Figma 94:75, `patterns.md:130`), "Update · Replace the existing value" and "Clear value" (step 4), and "Move to an organization unit" (new). The Asset tag select lists no Clear value.
4. Notes value. A text area that grows with the text. No inner scrolling (`rules.md:40`).
5. Hint and counter. The step 4 hint and counter, with the limit of each field.
6. Over-limit value. The field takes the Material error outline and label color, and the step 4 error line under the field names the field and the limit. The counter keeps counting past the limit.
7. Save and preview. Disabled while no field changes, while a value fails validation, and while a Move has no destination. Reset is disabled while no field changes.
8. Changed-field count. One per field. A Move counts once it has a destination.
9. Draft sentences. The step 4 sentence "Asset tag and notes remain unchanged. Telemetry is read-only." goes, because it is false with five fields. "To remove an annotation, choose Clear value explicitly." stays at the end.
10. Organization unit. "Move to an organization unit" opens the picker at once. After Choose, a read-only Destination field shows the path, and its icon button reopens the picker, as the Material datepicker toggle does. Cancel on the first pick returns the field to Leave unchanged.
11. Picker dialog. A Material 3 dialog, 480 px wide, over the shared scrim. Title "Choose organization unit" (171:1283). Search label "Find an organization unit" (the app OU filter). The tree shows the matches and their ancestors, and it starts at the top-level OU. The selected row takes the selected surface. "Selected: path" sits under the tree (171:1283). Cancel (text button) and Choose (filled button) sit at the end, as the Material dialog spec places them. Figma says "Stage change". The sheet has no staging step, so the action reads Choose.
12. Picker search. The query matches OU paths, so one query names a school and a category.
13. Current OU line. The device count and the number of current OUs. A list of paths grows with the selection.
14. Read scope missing. The select stays at Leave unchanged and disabled. The Devices write-access note sits under it in its error form: the text follows `DEVICE_WRITE_ACCESS_DENIED_MESSAGE` for the read scope, with Copy scope and Recheck.
15. Review table. One row group per device and one row per changed field: Field, Observed value, arrow, Approved value. The device row carries the serial. A Device column, as 97:21 has it, leaves about 50 px for each value in the 400 px sheet. Rows follow the selection order, then the field order of the draft.
16. Excluded device. The reason shows once, in the device row. Each field row shows "Not updated".
17. OU paths. They break after each slash in the review table, the confirm list, and the job detail.
18. Counts. "device updates" in the titles counts devices with a change (5). "field changes" counts device and field rows (15). "excluded" counts devices (1). The table label reads "Field changes".
19. Confirm step. Heading "Update 3 fields on 5 devices". One list item per changed field with its device count (172:2420 has one sentence per change). The move keeps "Destination policies apply." (172:2420). One sentence names the unchanged fields. The render shows the moment before Create: the box is checked.
20. Receipt line. "5 devices · 15 field changes." followed by the app completion sentence. The step 4 noun "annotated-location updates" names one field.
21. Job detail. The Operation column keeps its header and names the field (228:4760). The title stays "Update device annotations" (`JOB_ACTION_LABELS`). Rows follow the device, then the field. The first page holds 6 operations (`OPERATIONS_PAGE_SIZE`).
22. Job outcomes. One PATCH per device, so a lost write leaves every field of that device Unknown. Each Unknown row offers Reconcile, as step 4 does per operation. A Failed row shows the app failure sentence under the chip, as the step 5 mockup does, and keeps Inspect failure.
23. Latest activity. The line names each device once. The step 4 line repeats the sentence per sample operation, so three Unknown fields of one device repeat it three times.
24. Annotated user column. After Asset tag, so it shows without horizontal scrolling. It stays hidden by default (record). Its header has the text filter, as the other text columns do.
25. Device details. The Annotated user row sits between Annotated location and Notes, in the same box, with "Not set" when empty.

Findings for the record:

- Replace on Asset tag writes one value to every target device. The confirm step says so ("Set the asset tag to PV-CART-07 on 5 devices.").
- The step 4 hint and counter hard-code 200 characters. Each field needs its own limit in both strings.
- `previewTitle`, `confirmTitle`, and `previewCountLine` count eligible targets. With five fields, a target is one device and field, so the titles need the device count and the count line needs the row count.

## App-sourced strings

Proven by `check-strings.py`. "source" strings are whole literals in `frontend/src/app` or `libs/application-contracts/src`. Template strings name their source template.

- "Draft changes · Not submitted" · device-update-sheet.ts
- "Edit" · device-update-sheet.ts step label
- "Review" · device-update-sheet.ts step label
- "Confirm" · device-update-sheet.ts step label
- "Your draft stays available when you filter, scroll, or refresh." · device-update-sheet.html
- "Annotated location" · device-fields.ts, device-update-sheet.html
- "Asset tag" · device-fields.ts
- "Notes" · device-fields.ts
- "Organization unit" · device-fields.ts
- "To remove an annotation, choose Clear value explicitly." · device-update-sheet.html
- "Save and preview" · device-update-sheet.html
- "Review pending devices" · device-update-sheet.html
- "Reset" · device-update-sheet.html
- "Close" · device-update-sheet.html
- "Update device steps" · device-update-sheet.html
- "Update · Replace the existing value" · device-update-sheet.html
- "Find an organization unit" · device-filter.html (the OU filter search)
- "Cancel" · device-filter.html, job-filter.html
- "Copy scope" · devices.html
- "Recheck" · devices.html
- "Targets and final values are frozen. New matching devices will not join this job." · device-update-flow.ts
- "Frozen update targets" · device-update-sheet.html
- "Observed value" · device-update-sheet.html
- "Change" · device-update-sheet.html
- "Approved value" · device-update-sheet.html
- "No value" · device-update-flow.ts
- "Not updated" · device-update-flow.ts
- "Continue to confirmation" · device-update-sheet.html
- "Edit draft" · device-update-sheet.html
- "Review the approved scope" · device-update-sheet.ts
- "Create update job" · device-update-sheet.html
- "Back to preview" · device-update-sheet.html
- "Update job created" · device-update-sheet.ts
- "Your job is saved" · job-receipt-messages.ts
- "You can close this panel and follow progress in Jobs." · job-receipt-messages.ts
- "View job" · device-update-sheet.html
- "Done" · device-update-sheet.html
- "Update device annotations" · application-contracts jobs.ts
- "Back to jobs" · job-detail.html
- "Refresh" · job-detail.html
- "Needs review" · job-fields.ts
- "Operation counts" · job-detail.html
- "Succeeded" · job-detail-fields.ts
- "Failed" · job-detail-fields.ts
- "Unknown" · job-detail-fields.ts
- "Pending" · job-detail-fields.ts
- "Skipped" · job-detail-fields.ts
- "Expired" · job-detail-fields.ts
- "Cancelled" · job-detail-fields.ts
- "Operation results" · job-detail.html
- "Device" · job-detail.html
- "Operation" · job-detail.html
- "Before" · job-detail.html
- "Requested" · job-detail.html
- "Outcome" · job-detail.html
- "Updated" · job-detail.html
- "Actions" · job-detail.html
- "Not set" · job-detail-fields.ts, device-detail.html
- "Inspect failure" · job-detail.html
- "Reconcile" · job-detail.html
- "Latest activity" · job-detail.html
- "Operation results table" · job-detail.html
- "Previous operations page" · job-detail.html
- "Next operations page" · job-detail.html
- "Back to devices" · device-detail.html
- "Next device" · device-detail.html
- "No battery report" · device-detail.html
- "Google has not reported battery data for this device." · device-detail.html
- "Common causes: the ReportDevicePowerStatus device policy is off, or the device has no battery." · device-detail.html
- "7,000 matching devices · 7,000 in district" · template, device-status-panel.ts
- "Inventory observed Oct 20, 6:50 PM" · template, device-status-panel.ts
- "Selected on current page: 6" · template, LibreGrid selection footer
- "Total Selected: 6" · template, LibreGrid selection footer
- "Select All (7000)" · template, LibreGrid selection footer
- "Deselect All" · LibreGrid selection footer
- "Show All Selected (6)" · template, LibreGrid selection footer
- "Update 6 devices" · template, device-update-sheet.ts title()
- "6 devices · 0 changed fields · Not submitted" · template, summary() with changedFieldsText()
- "6 devices · 2 changed fields · Not submitted" · template, summary() with changedFieldsText()
- "6 devices · 3 changed fields · Not submitted" · template, summary() with changedFieldsText()
- "Review 5 device updates" · template, previewTitle()
- "Frozen preview · Prepared Oct 20, 7:02 PM" · template, device-update-sheet.ts subtitle()
- "6 devices · 15 field changes · 1 excluded" · template, previewCountLine()
- "Prepared Oct 20, 7:02 PM · Expires Oct 20, 7:17 PM · Preview PV‑009" · template, previewMetaLine()
- "Excluded · Removed from inventory" · template, targetNote() with exclusionReasonText()
- "Confirm 5 device updates" · template, confirmTitle()
- "Preview PV-009 · 6 devices · 15 field changes" · template, confirmationMetaLine()
- "Expires Oct 20, 7:17 PM" · template, expiryLine()
- "I reviewed all 6 devices and their final values." · template, acknowledgementLabel()
- "Job UPD-007 · Accepted" · template, receiptSubtitle()
- "Job UPD-007 · Needs review" · template, job-detail.ts subtitle()
- "UPD-007 · 5 devices" · template, scopeHeading()
- "Requested by Review administrator · Oct 20, 7:03 PM · Duration: 3m 12s" · template, identityLine()
- "Show 4 needing attention" · template, job-detail.html
- "Operation results for job UPD-007" · template, job-detail.html caption
- "01P0T1V does not hold the requested value." · template, failureSentence()
- "Rows 1–6 of 15 operations" · template, operationsFooter()
- "7:06 PM · 01P0T1V does not hold the requested value. 02QJANY requires reconciliation before any retry." · template, latestActivityLine() with each device once (choice 23)
- "Open device 01P0T1V" · template, job-detail.html eye link name
- "Open device 02QJANY" · template, job-detail.html eye link name
- "Device details · /Chrome Devices/Pine Valley Elementary School/Cart Devices" · template, device-detail.html
- "Dell Chromebook 3100 · CB488013" · template, identity() in device-detail.ts
- "Read from Google Oct 20, 6:50 PM" · template, device-detail.html
- "Last device contact: 3 h ago" · template, device-detail.html with relativeTime()

## Mockup data

Serials and models come from the real screenshots. Asset tags of the selected devices come from the grid. OU paths come from the details screenshots. Values, times, counts, and IDs belong to the scenario. The Annotated user values use example.org addresses.

- "01P0T1V"
- "02A1MB6"
- "02QJANY"
- "04QVJBY"
- "04XTBHJ"
- "0727D2E"
- "04A9BVS"
- "CB662467"
- "CB246165"
- "CB412049"
- "CB970992"
- "PV-CART-07"
- "Cart 7 loaner pool"
- "Cart 7 loaner pool. Check the charger and the power strip before each lesson. Students sign the loan sheet at the library desk and return the device before the last bell. Report a cracked screen, a missing key, or a loose hinge to the help desk on the same day. Wipe the keyboard and the screen with the approved cloth at the end of each day. Keep the cart locked when no teacher is in the room. Charge every device overnight and leave the cart plugged in during holidays. The library staff counts the devices every Friday afternoon and logs the result."
- "/Chrome Devices/Lowell Academy/One to One"
- "/Chrome Devices/Hughes Academy/One to One"
- "/Chrome Devices/Pine Valley Elementary School/Cart Devices"
- "Pine Valley Elementary School/Cart"
- "Chrome Devices"
- "Pine Valley Elementary School"
- "Cart Devices"
- "maya.chen@example.org"
- "luis.ortiz@example.org"
- "liam.foster@example.org"
- "ava.patel@example.org"
- "noah.kim@example.org"
- "ella.brooks@example.org"
- "0"
- "1"
- "2"
- "3"
- "11"
- "7:05 PM"
- "7:06 PM"

## Drafted strings

Not in the app source. The owner reviews each one. The source of the wording follows each string.

- "Leave unchanged" · Figma 94:75, patterns.md:130
- "Annotated user" · record label, Figma grid column name
- "Move to an organization unit" · record ("Organization unit offers Move")
- "New value" · new label of the value field
- "Use 256 characters or fewer. Spaces alone do not count." · step 4 hint with the Asset tag limit
- "10 of 256 characters" · step 4 counter with the Asset tag limit
- "Use 500 characters or fewer. Spaces alone do not count." · step 4 hint with the Notes limit
- "18 of 500 characters" · step 4 counter with the Notes limit
- "553 of 500 characters" · step 4 counter with the Notes limit
- "Notes holds 1 to 500 characters." · step 4 message "A value holds 1 to 200 characters." with the field and its limit
- "Destination" · label of the chosen OU
- "Choose organization unit" · Figma 171:1283 title, also the name of the Destination icon button
- "6 devices · Current: 3 organization units" · Figma 171:1283 current line for many devices
- "Selected: /Chrome Devices/Pine Valley Elementary School/Cart Devices" · Figma 171:1283
- "Choose" · Figma 171:1283 "Stage change", renamed (choice 11)
- "Google denied organization unit reads. Add https://www.googleapis.com/auth/admin.directory.orgunit.readonly to the delegation client in the Google Admin Console." · DEVICE_WRITE_ACCESS_DENIED_MESSAGE pattern for the read scope
- "Field changes" · table label, from the count line noun
- "Field" · Figma 97:21 column
- "Update 3 fields on 5 devices" · step 4 heading "Update the location on 6 devices" for several fields
- "Set the asset tag to PV-CART-07 on 5 devices." · Figma 172:2420 sentence per change
- "Set the notes to Cart 7 loaner pool on 5 devices." · Figma 172:2420 sentence per change
- "Move 5 devices into /Chrome Devices/Pine Valley Elementary School/Cart Devices. Destination policies apply." · Figma 172:2420
- "Annotated location and annotated user remain unchanged." · step 4 "Other fields remain unchanged." with the field names
- "5 devices · 15 field changes. Google changes have not completed." · receiptCountLine() with the noun "field changes"

## Checks

- `render.cjs`: 0 page errors, 0 console errors, 0 failed requests, 0 route aborts (the HTML makes no request outside the file), 0 overflow problems. The click test walks Bulk Actions, the selects, the picker, typing, validation, Save and preview, Continue, the acknowledgment, Create, and View job.
- The overflow check flags any element whose content overflows its box, any clipped text line, and any clipped input value. Inside a mat-form-field, two Angular Material parts draw outside their boxes by design: the 24 px select arrow on its 10 x 5 box and the floating label at 75 % scale. There the text checks decide. A scroll container (the sheet body) moves content out of view vertically. `render-report.json` lists each scroll container per state.
- `check-strings.py`: 162 visible strings and accessible names: 69 source, 35 template, 34 data, 24 drafted.
- Every OU path in the HTML shows in a 2026-10-16 details screenshot. The tree nodes and the search value are parts of those paths.
