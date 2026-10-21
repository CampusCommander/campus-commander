# Device commands and status changes: step 5 mockup notes

Proposal mockup for owner approval. It is not the built app.
Record: `docs/workflows/device-commands.md` (owner-confirmed 2026-10-21).
Composition source: the approved sheet `docs/ui/designs/2026-10-20-bulk-action-sheet.html` and the shipped sheet of the 2026-10-20 review build.
Content source: the Figma frames named in the record (content and copy only).

## Files

- `device-commands-mockup.html` · one self-contained file (screenshots and Roboto as base64). Open it in a browser. The state switcher sits at the bottom left. Deep links: `#01-bulk-actions-menu` to `#10-status-column-filter`.
- `png/` · one PNG per state, light theme, viewport 1440 x 900, deviceScaleFactor 1.
- `render-report.json` · output of `render.cjs`: geometry, overflow checks, visible strings, click test, requests, errors.
- `build.py` · composes the backgrounds from real screenshots and writes the HTML. It asserts every pixel assumption first.
- `render.cjs` · renders the PNGs with the repository Playwright. It aborts every request that is not `file:` or `data:`.
- `check-strings.py` · classifies every visible string and proves the app-sourced ones. It fails when this file misses a string.
- `src/` · the template and the composed backgrounds. `work/cal/` · the calibration harness.

Rebuild in the mockup package: `python3 build.py && node render.cjs && python3 check-strings.py`.

## States

| PNG                           | Background                                                     | What it shows                                                                                     |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `01-bulk-actions-menu.png`    | Devices grid, 8 rows selected                                  | Bulk Actions open: Update device, Send command, Change status                                     |
| `02-send-command-choose.png`  | same                                                           | Choose step with Reboot and its target summary                                                    |
| `03-reboot-review.png`        | same                                                           | Frozen preview PV-002: prepared time, expiry, 6 eligible targets, 2 excluded devices with reasons |
| `04-reboot-confirm.png`       | same                                                           | Consequence text, the checked acknowledgment, enabled Send button                                 |
| `05-change-status-choose.png` | same                                                           | Choose step with Disable and Re-enable (Disable picked)                                           |
| `06-disable-confirm.png`      | same                                                           | Disable confirmation with the filled destructive button                                           |
| `07-reenable-no-eligible.png` | Devices grid, 3 active devices selected by an asset tag filter | No-eligible state. No job starts.                                                                 |
| `08-command-receipt.png`      | Devices grid, 8 rows selected                                  | Receipt for CMD-001: Your job is saved, View job, Done                                            |
| `09-job-detail-cmd.png`       | Jobs shell                                                     | Job detail of CMD-001 while commands wait (Running)                                               |
| `10-status-column-filter.png` | Devices grid                                                   | Status column after Serial and the filter Status · Disabled, Deprovisioned                        |

State 09 is a full-page capture of the 1440 x 900 viewport (PNG 1440 x 1196). The job detail page is taller than the viewport, and the full page shows the job status, all six rows, and the latest activity together.

## Scenario

- The 8 selected devices are the first 8 rows of the review inventory. 04QVJBY is Disabled. 0727D2E is Deprovisioned. The other 6 are Active.
- Reboot and Disable target the 6 active devices. The review lists 04QVJBY and 0727D2E with their reasons.
- State 07 uses another selection: the 3 devices of the real screenshot `q1c-2-edit.png` (asset tag starts with CB6624). All 3 are Active, so Re-enable has no target.
- State 09 shows all six device states in one job for review. A real job reaches Expired only after the expiry that Google returns (admin-sdk-mock default: 5 days).
- State 10 shows the grid after the Disable job of state 06 completed: 7 Disabled devices and 1 Deprovisioned device match the filter.

## Fidelity

Every background is a real screenshot of the 2026-10-20 review build. `build.py` composes them:

- Selected grid: `q1c-start-devices.png` with the empty-selection note removed from the content column. Each row takes the selected look of the real selected row in `q1c-refresh-selected-status.png` (checked within 1 level per channel). The header checkbox comes from `q1c-3-selection-note.png`.
- Status column: the columns from Model on move right by one 200 px column. The new header copies the real Asset tag header with its active filter icon. The filter chip is the real chip, widened by 19 px for the longer label.
- Jobs shell: `q1c-3-jobs.png`, extended to the page height by repeating one empty navigation row.

The overlays copy the app CSS (`device-update-sheet.css`, `device-update-problem.css`, `job-detail.css`, `styles.scss`, the LibreGrid status bar) and the Material 3 metrics of the app theme. Calibration (`work/cal/cal.py`) re-creates six real screen regions with the mockup CSS and diffs them. Mean absolute difference per pixel (0 to 255):

| Real screen                                    | Mean difference | Note                                                   |
| ---------------------------------------------- | --------------- | ------------------------------------------------------ |
| Status bar of `q1c-start-devices.png`          | 0.000           | identical                                              |
| Bulk Actions menu of `q1c-start-bulk-menu.png` | 0.037           | identical text, shadow within 2 levels                 |
| Receipt sheet of `q1c-3-created.png`           | 0.188           | the real View job button shows a hover layer           |
| Confirm sheet of `q1c-3-confirm.png`           | 0.112           | checkbox label within 1 px                             |
| Job detail of `q1a-4-needs-review.png`         | 0.114           | row action labels within 1 px                          |
| Review sheet of `q1c-2-review.png`             | 1.761           | only the arrow column, which the new tables do not use |

The filter chip label uses 13.33 px Arial, as the shipped chip does (its button does not inherit the app font).

## Composition choices left open by the record and the designs

1. Choose step control. Figma shows one button per action. The sheet uses a Material 3 radio group and one footer button that names the action: Review Reboot, Review Disable, Review Re-enable.
2. Target summary. Each option carries two supporting lines: the consequence and the count of eligible devices ("6 of 8 selected devices are active."). The Review step lists each device.
3. Default option. Send command preselects Reboot, the only command. Change status preselects no option in the proposal. The PNG shows the moment after the person picks Disable.
4. Review table. One table holds eligible and excluded devices, as step 4 does: Device, Observed status, Command. An excluded row shows "Not sent" in the error color and an "Excluded · reason" line. The table has no arrow column.
5. Exclusion reasons. "Device is disabled", "Device is deprovisioned", and "Device is active", in the step 4 form "Excluded · reason".
6. Step titles. Choose: the Figma page titles. Review: "Review 6 Reboot commands" (step 4 pattern). Confirm: "Reboot 6 devices" and "Disable 6 devices" (Figma). Receipt: "Command job created" (Figma 104:612).
7. Consequence heading. Figma shows it in red. The sheet keeps the neutral heading of the step 4 Confirm step.
8. Disable Review step. Not drawn. It reuses the Reboot review with the column Final status in place of Command.
9. Re-enable no-eligible state. It uses the step 4 problem card: sheet title "Nothing to re-enable", card heading "No devices can be re-enabled", actions Back to devices and Change action, and no footer. A table of the selected devices with their reasons follows the card. The action order follows the app problem card (text button first).
10. Receipt count line. "6 devices · 6 Reboot commands." followed by the app sentence "Google changes have not completed." It claims no Google acceptance.
11. Job detail counters. Expired gets its own counter after Unknown. Pending counts Pending delivery and Acknowledged.
12. Job detail outcomes. New chips: Pending delivery (neutral), Acknowledged (info), Expired (warning). A Failed row shows the reason from Google under the chip and keeps Inspect failure. An Unknown row offers no Reconcile (record default 4). "Show N needing attention" counts Failed, Unknown, and Expired.
13. Job detail columns. Operation and Requested both read Reboot, and Before reads "—", as in Figma 99:73. The job title is "Reboot devices".
14. Status column position. Directly after Serial, so the status shows without horizontal scrolling. The record fixes only that the column is optional and hidden by default.
15. Status filter chip. The Battery set-filter pattern: "Status · Disabled, Deprovisioned".
16. Choose footer. One button. The close icon dismisses the sheet.
17. Wording of Re-enable. Figma says "already enabled". The status values say Active. The proposal keeps the Figma copy.

## App-sourced strings

Proven by `check-strings.py`. "source" strings are whole literals in `frontend/src/app`. Template strings name their source template.

- "Update device" · devices.html
- "Bulk Actions" · devices.html
- "Review" · device-update-sheet.ts step label
- "Confirm" · device-update-sheet.ts step label
- "Close" · device-update-sheet.html
- "Device" · device-update-sheet.html, job-detail.html
- "Continue to confirmation" · device-update-sheet.html
- "Review the approved scope" · device-update-sheet.ts
- "Back to preview" · device-update-sheet.html
- "Back to devices" · device-update-flow.ts action
- "Your job is saved" · job-receipt-messages.ts
- "You can close this panel and follow progress in Jobs." · job-receipt-messages.ts
- "View job" · device-update-sheet.html
- "Done" · device-update-sheet.html
- "Back to jobs" · job-detail.html
- "Refresh" · job-detail.html
- "Running" · job-fields.ts
- "Operation counts" · job-detail.html
- "Succeeded" · job-detail-fields.ts
- "Failed" · job-detail-fields.ts
- "Unknown" · job-detail-fields.ts
- "Pending" · job-detail-fields.ts
- "Skipped" · job-detail-fields.ts
- "Cancelled" · job-detail-fields.ts
- "Operation results" · job-detail.html
- "Operation" · job-detail.html
- "Before" · job-detail.html
- "Requested" · job-detail.html
- "Outcome" · job-detail.html
- "Updated" · job-detail.html
- "Actions" · job-detail.html
- "—" · job-detail-fields.ts fieldLabel()
- "Inspect failure" · job-detail.html
- "Latest activity" · job-detail.html
- "Operation results table" · job-detail.html
- "Previous operations page" · job-detail.html
- "Next operations page" · job-detail.html
- "7,000 matching devices · 7,000 in district" · template, device-status-panel.ts
- "8 matching devices · 7,000 in district" · template, device-status-panel.ts
- "Inventory observed Oct 20, 6:50 PM" · template, device-status-panel.ts
- "Selected on current page: 8" · template, LibreGrid selection footer
- "Selected on current page: 0" · template, LibreGrid selection footer
- "Total Selected: 8" · template, LibreGrid selection footer
- "Total Selected: 0" · template, LibreGrid selection footer
- "Select All (7000)" · template, LibreGrid selection footer
- "Select All (8)" · template, LibreGrid selection footer
- "Deselect All" · LibreGrid selection footer
- "Show All Selected (8)" · template, LibreGrid selection footer
- "Show All Selected (0)" · template, LibreGrid selection footer
- "Frozen preview · Prepared Oct 20, 7:02 PM" · template, device-update-sheet.ts subtitle
- "Prepared Oct 20, 7:02 PM · Expires Oct 20, 7:17 PM · Preview PV‑002" · template, previewMetaLine()
- "Expires Oct 20, 7:17 PM" · template, expiryLine()
- "Expires Oct 20, 7:27 PM" · template, expiryLine()
- "Job CMD-001 · Running" · template, receiptSubtitle() and the job detail subtitle
- "CMD-001 · 6 devices" · template, scopeHeading()
- "Requested by Review administrator · Oct 20, 7:03 PM · Duration: 6m 40s" · template, identityLine()
- "Show 3 needing attention" · template, job-detail.html
- "Operation results for job CMD-001" · template, job-detail.html caption
- "Rows 1–6 of 6 operations" · template, job-detail-fields.ts
- "Open device 01P0T1V" · template, job-detail.html
- "Open device 02A1MB6" · template, job-detail.html
- "Open device 02QJANY" · template, job-detail.html
- "Open device 04A9BVS" · template, job-detail.html
- "Open device 04XTBHJ" · template, job-detail.html
- "Open device 08V5B5S" · template, job-detail.html

## Mockup data

Serials come from the real screenshots. Times, counts, and IDs belong to the scenario. The failure reason is the command error message of admin-sdk-mock (`FAILURE_MESSAGE` in `dist/src/directory/commands.js`).

- "1"
- "2"
- "3"
- "0"
- "01P0T1V"
- "02A1MB6"
- "02QJANY"
- "04A9BVS"
- "04QVJBY"
- "04XTBHJ"
- "0727D2E"
- "08V5B5S"
- "PF4BR5ST"
- "PFPSZU4L"
- "7:03 PM"
- "7:04 PM"
- "7:05 PM"
- "7:08 PM"
- "The device failed to execute the command."

## Drafted strings

For owner review. Each line names its origin. "record" is the owner-confirmed workflow record. "drafted" is new copy.

- "Send command" · record, Bulk Actions entry
- "Change status" · record, Bulk Actions entry
- "Choose a device command" · Figma 106:156 title
- "8 selected devices · Not submitted" · drafted from Figma 106:156 and the step 4 subtitle
- "Choose" · record default 6, step label
- "Command" · drafted, radio group label
- "Reboot" · record and Figma 106:156
- "Restarts the devices and interrupts active sessions." · patterns.md DEVICE-01
- "6 of 8 selected devices are active." · drafted, target summary
- "Excluded devices stay out of the job. The review lists each excluded device with its reason." · drafted from DEVICE-01
- "Review Reboot" · Figma 106:156 button
- "Send command steps" · drafted, stepper accessible name (step 4: Update device steps)
- "Review 6 Reboot commands" · drafted, step 4 previewTitle() pattern
- "8 devices · 6 commands · 2 excluded" · drafted, previewCountLine() pattern
- "Targets are frozen. New matching devices will not join this job." · drafted from FROZEN_TARGETS_SENTENCE
- "Reboot targets" · drafted, list label
- "Frozen Reboot targets" · drafted, table caption (step 4: Frozen update targets)
- "Observed status" · drafted (step 4: Observed value)
- "Active" · record, status value
- "Disabled" · record, status value (the app uses this literal only for a platform principal)
- "Not sent" · drafted (step 4: Not updated)
- "Excluded · Device is disabled" · drafted, targetNote() pattern
- "Deprovisioned" · record, status value
- "Excluded · Device is deprovisioned" · drafted, targetNote() pattern
- "Back to command" · Figma 111:442 button
- "Reboot 6 devices" · Figma 111:442 title
- "Reboot interrupts active sessions" · Figma 111:442 heading
- "The devices restart when the command executes. Users will lose their active sessions." · Figma 111:442
- "Google accepting the request does not confirm execution. Track each device in the job." · Figma 111:442
- "Preview PV-002 · 8 devices · 6 commands" · drafted, confirmationMetaLine() pattern
- "I understand that restarting these devices interrupts users." · record and Figma 111:442
- "Send Reboot to 6 devices" · Figma 111:442 button
- "Change device status" · Figma 105:234 title
- "Status change" · drafted, radio group label
- "Disable" · record
- "Blocks user access while keeping devices enrolled." · Figma 105:234
- "Re-enable" · record
- "Restores access to disabled devices." · Figma 105:234
- "1 of 8 selected devices is disabled." · drafted, target summary
- "Review Disable" · drafted, Review Reboot pattern
- "Change status steps" · drafted, stepper accessible name
- "Disable 6 devices" · record and Figma 114:503, title and destructive button
- "Block user access on 6 devices" · Figma 114:503 heading
- "Disable blocks user access. These devices remain enrolled. Re-enable restores access." · Figma 114:503
- "6 eligible · 2 excluded · Exact targets are recorded with the job." · Figma 114:503 pattern
- "Preview PV-003 · 8 devices · 6 status changes" · drafted, confirmationMetaLine() pattern
- "Nothing to re-enable" · drafted, step 4 problem title pattern (Nothing to update)
- "3 selected devices · No job created" · drafted (No job created is the app constant NO_JOB)
- "No devices can be re-enabled" · record and Figma 111:397
- "All 3 devices are already enabled." · Figma 111:397
- "Eligible: 0 · Already enabled: 3. No job will be created." · Figma 111:397
- "Select disabled devices to re-enable access." · Figma 111:397
- "Change action" · Figma 111:397 button
- "Selected devices" · drafted, list label
- "Re-enable eligibility" · drafted, table caption
- "Not changed" · drafted
- "Excluded · Device is active" · drafted, targetNote() pattern
- "Command job created" · Figma 104:612 title
- "6 devices · 6 Reboot commands. Google changes have not completed." · drafted count line and the app sentence of receiptCompletionSentence()
- "Reboot devices" · drafted, job action label (Figma 99:73: Powerwash devices)
- "Expired" · record, device state
- "Acknowledged" · record, device state
- "Pending delivery" · record, device state
- "7:08 PM · The Reboot command for 04XTBHJ expired before execution. 02A1MB6 reported an execution failure. The outcome for 08V5B5S is uncertain. 2 commands wait for device execution." · drafted (the third sentence is the app template of an uncertain outcome)
- "Status" · record, column and filter name (the app uses this literal for the job status column)
- "Status · Disabled, Deprovisioned" · drafted, chipLabel() set-filter pattern
- "Remove filter Status · Disabled, Deprovisioned" · drafted, devices.html remove-filter pattern

## Checks

- `render-report.json` summary: 0 page errors, 0 console errors, 0 route aborts (the page requests nothing outside `file:` and `data:`), 0 other failed requests, 0 overflow problems.
- Click test: Bulk Actions opens the menu. Send command, Review Reboot, Continue to confirmation, the checkbox, Send Reboot, and View job walk states 02, 03, 04, 08, and 09. Send stays disabled until the checkbox is checked. Change status, Review Disable, Re-enable, Review Re-enable, Change action, Close, and Escape behave as labeled.
- `check-strings.py`: 151 strings. 37 source, 28 template, 19 data, 67 drafted.
