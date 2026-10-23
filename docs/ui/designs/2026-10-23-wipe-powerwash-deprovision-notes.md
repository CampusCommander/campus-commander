# Wipe user data, Powerwash, and Deprovision: step 5 second-build mockup notes

Proposal mockup for owner approval. It is not the built app.
Record: `docs/workflows/wipe-powerwash-deprovision.md` (owner-confirmed 2026-10-23: rulings 1 to 3 and defaults D1 to D20).
Composition source: the approved first-build screens `docs/ui/designs/2026-10-21-device-commands-*` and the built screens that the owner signed off on 2026-10-22, as the real screenshots of the review build show them.
Content source: the Figma frames that the record names (content and copy only).
App source: `origin/main` 1e08ff6, copied to `work/main-src/` so every string and style comes from one fixed version.

## Files

- `destructive-commands-mockup.html` · one self-contained file (screenshots and fonts as base64). Open it in a browser. The state switcher sits at the bottom left. Deep links: `#01-send-command-choose` to `#11-choose-without-wipe-permission`.
- `png/` · one PNG per state, light theme, viewport 1440 x 900, deviceScaleFactor 1.
- `render-report.json` · output of `render.cjs`: geometry, overflow checks, visible strings, click test, requests, and errors.
- `build.py` · composes the backgrounds from real screenshots and writes the HTML. It asserts every pixel assumption first.
- `render.cjs` · renders the PNGs with the repository Playwright. It aborts every request that is not `file:` or `data:`.
- `check-strings.py` · classifies every visible string and proves the app-sourced ones. It fails when this file misses a string or lists a stale one.
- `src/` · the template and the composed backgrounds. `work/cal/` · the calibration harness. `work/material/` · the Material CSS extraction. `work/theme/` · the app theme compile.

Rebuild in the mockup folder with Node 24.19.0: `python3 build.py && node render.cjs && python3 check-strings.py`.

## States

| PNG                                     | Background                                             | What it shows                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-send-command-choose.png`            | Devices grid, 6 rows selected                          | Send command Choose step with Reboot, Wipe user data, and Powerwash. The person picked Wipe user data (D1, D3).                                                                                            |
| `02-wipe-review.png`                    | same                                                   | Frozen preview PV-015: 4 targets, 04QVJBY and 0727D2E excluded with their reasons (D5), and the offline note (D16).                                                                                        |
| `03-wipe-confirm.png`                   | same                                                   | Consequence, the unchecked acknowledgment box (D8), the empty typed phrase field for WIPE (D7), and the disabled filled destructive button "Send Wipe to 4 devices" (D9).                                  |
| `04-powerwash-confirm-wrong-phrase.png` | same                                                   | Powerwash Confirm step with the acknowledgment box checked and WIPE typed. The typed phrase field shows its error and the button stays disabled (completion step 3).                                       |
| `05-change-status-reason.png`           | same                                                   | Change status Choose step with Deprovision picked and the reason select open: the four Google labels, none selected (D11, D12). Review stays disabled.                                                     |
| `06-deprovision-review.png`             | same                                                   | Frozen preview PV-017: 4 active devices and 1 disabled device eligible, 0727D2E excluded, the chosen reason, and the D10 sentence.                                                                         |
| `07-deprovision-confirm.png`            | same                                                   | DEPROVISION typed (ruling 3) and the enabled filled destructive button "Deprovision 5 devices".                                                                                                            |
| `08-powerwash-receipt.png`              | same                                                   | Receipt of CMD-008: Your job is saved, View job, and Done.                                                                                                                                                 |
| `09-powerwash-job.png`                  | Jobs shell                                             | Job page of CMD-008 (Awaiting devices): 2 waiting rows with the Google expiry, 1 Failed row with the Google reason, and 1 Unknown row after the 30-day window (ruling 2). No command row offers Reconcile. |
| `10-deprovision-job.png`                | Jobs shell                                             | Job page of STS-003 (Completed with errors): 4 succeeded rows, 1 failed row with the Google reason, and the Deprovision reason.                                                                            |
| `11-choose-without-wipe-permission.png` | Devices grid, 6 rows selected, review recipient header | Send command Choose step for a person without Wipe and Powerwash devices: both options stay visible and disabled, with the permission note (D2, GRID-06).                                                  |

States 09 and 10 are full-page captures of the 1440 x 900 viewport (PNG 1440 x 1197 and 1440 x 1162), because the job pages are taller than the viewport. Every other PNG is 1440 x 900.
The Review bodies of states 02 and 06 are 17 and 19 px taller than the sheet body. Only the bottom padding sits below the edge, so every row stays fully visible. No state scrolls a sheet body.

## Scenario

- The 6 selected devices are rows of the real review inventory: 01P0T1V, 02A1MB6, 02QJANY, 04QVJBY, 04XTBHJ, and 0727D2E. 04QVJBY is Disabled and 0727D2E is Deprovisioned, as in the approved first-build mockup. The other 4 are Active.
- Wipe user data and Powerwash target the 4 active devices. Deprovision targets the 4 active devices and 04QVJBY.
- Preview IDs PV-015 to PV-017 and the job IDs CMD-008 and STS-003 follow the IDs of the device commands review: PV-014 and CMD-007 in its screenshots, and the two STS- jobs of its walkthrough steps 3 and 4. The times follow the inventory time of the grid screenshot, Oct 22, 2:05 PM.
- The Deprovision reason is Retiring from fleet. Figma shows "Retired / End of life", which is not a Google label (record design gap 2). Retiring from fleet is the Google label for that case.
- State 09 is a composite for review. One job shows waiting rows, a failed row, and an Unknown row that settled after the 30-day window. A real job settles such a row only when the window closes, and then no row still waits. The rows show a Powerwash expiry five years after issue, the longest window that the Admin console help names (record source 11). admin-sdk-mock returns five days.
- The failed Powerwash row carries the command error message of admin-sdk-mock. The failed Deprovision row carries the admin-sdk-mock refusal for a device that Google already holds as Deprovisioned while the cache still shows it Active (record: "Google refuses an ineligible device per device").
- State 11 shows a second person. The header and the navigation come from the real screenshot of the review recipient. In the scenario that person holds Send device commands and Device Bulk Actions but not Wipe and Powerwash devices.

## Fidelity

Every background is a real screenshot of the 2026-10-22 review builds. `build.py` composes them:

- Devices grid: `step1-06-grid-after.png` of the update device fields review as the base, with the default columns and rows of `setup-devices.png` moved up 58 rows. The move is exact: the grid border, the Serial header, and the unselected row 04A9BVS match pixel for pixel. The 6 selected rows copy the real selected row 01P0T1V (within 1 level per channel). The header checkbox keeps its real indeterminate state.
- Review recipient: the header and the navigation of `q1b/step6-no-permissions.png` over the Devices grid.
- Jobs shell: `q1b/step5-hang-unknown.png`, extended by one repeated empty navigation row, with the real footer strip as a second layer at the bottom edge.
- The header of every state shows the review build: the connected domain and the simulated customer ID.

The overlays copy the app CSS of `origin/main` (`bulk-action-sheet.css`, `device-action-sheet.css`, `job-detail.css`, `styles.scss`, `tokens.css`), the app theme compiled with the repository sass, and the Angular Material 22.2.2 CSS of the button, checkbox, radio, form field, select, option, ripple, and focus indicator, with the component DOM of the Material templates. Icons use the bundled Material Symbols font, as the app does. The LibreGrid status bar uses its own CSS.

Calibration (`work/cal/cal.py`) re-creates seven real screen regions with the mockup CSS and diffs them. Mean absolute difference per pixel (0 to 255):

| Real screen                                        | Mean difference | Note                                                 |
| -------------------------------------------------- | --------------- | ---------------------------------------------------- |
| Change status Choose step of `q1/step3-choose.png` | 0.000           | the focus layer of the clicked radio included        |
| Reboot Review step of `q1/step2-review.png`        | 0.000           | the hover layer of Continue to confirmation included |
| Reboot Confirm step of `q1/step2-confirm.png`      | 0.000           | Material checkbox and disabled filled button         |
| Reboot receipt of `q1/step2-receipt.png`           | 0.000           | the hover layer of View job included                 |
| Disable Confirm step of `q1/step3-confirm.png`     | 0.000           | filled destructive button with its hover layer       |
| Job page of `q1b/step5-issue-refusal.png`          | 0.000           | page, counters, table, failed row                    |
| Status bar of `step1-06-grid-after.png`            | 0.000           | the base of the Devices grid                         |

The typed phrase field and the reason select use the extracted form-field, select, and option CSS that the update device fields mockup calibrated at 0.000 on the real Edit step.

## Composition choices left open by the record and the designs

1. Default option. Send command now holds three commands, so it preselects none, as Change status does. PNG 01 shows the moment after the person picks Wipe user data, with the focus layer that the real Choose step shows. State 11 preselects Reboot, because Reboot is the only command that person can send (the first-build rule for a single command).
2. Option lines. Each new option carries the DEVICE-01 consequence and the target summary, as Reboot does. The Deprovision summary names both eligible statuses: "5 of 6 selected devices are active or disabled."
3. Reason select. A required Material outlined select sits directly under the Deprovision option, aligned with the option text, and shows only when Deprovision is picked. The label carries the Material required marker. Review Deprovision stays disabled until the person chooses a reason. The panel lists the four Google labels in the record order, with none selected.
4. Reason after Choose. Review shows "Deprovision reason: Retiring from fleet" under the preview line. Confirm repeats it as a paragraph. The job page shows it as a second line of the identity card. The Deprovision receipt, not drawn, adds the same line under its count line (D12).
5. D10 sentence. Review shows it as an information notice under the reason. Confirm repeats it as the second consequence paragraph, because Confirm is the last step before an action that no API call reverses.
6. Offline note (D16). An information notice in the Wipe user data Review, under the preview line. It names the action. The Powerwash Review uses the same sentence with Powerwash.
7. Confirm order. Heading, consequence paragraphs, preview line and expiry, acknowledgment box, typed phrase field, then the footer button. The typed phrase field sits last, next to the button, so typing the phrase is the final act. Figma places the field above the box, and the frames supply content only.
8. Typed phrase field. A Material outlined input with the label "Type WIPE to confirm" and no hint. The match is exact and case-sensitive after trimming spaces (D7), so "deprovision" keeps the button disabled. An empty field shows no error. A typed value that does not match turns the field red and shows the error line of the shipped sheet below it.
9. Disabled destructive button. The shipped Material disabled look (gray). The button turns red only when the acknowledgment box and the phrase pass, as the real Reboot Confirm step shows its disabled button.
10. Consequence heading. Neutral, as the shipped Confirm step keeps it (first-build choice 7). Figma draws it red.
11. Step titles. Confirm uses the Figma titles: "Wipe user data on 4 devices", "Powerwash 4 devices", and "Deprovision 5 devices". Review follows the shipped pattern: "Review 4 Wipe user data commands" and "Review 5 Deprovision status changes".
12. Waiting and unknown command rows. The shipped chip (Acknowledged, Pending delivery) carries a second line with the expiry that Google returned, in the shipped expiry format. An Unknown row that settled after the watch window reads "No result in 30 days" and keeps the expiry line, because the command stays armed at Google. Command rows offer no Reconcile, and the Unknown row offers no action.
13. Job labels. Titles "Powerwash devices" and "Deprovision devices" (D3). Operation cells read Powerwash and Deprovision. Before reads "—" for a command and the observed status for Deprovision. Requested reads Powerwash and Deprovisioned.
14. Partial Deprovision result. The failed row shows the Google message under its chip, as the shipped status rows do, and keeps Inspect failure. The latest activity uses the shipped status sentence.
15. Permission state. The disabled options stay visible in the disabled text color, without a target summary. One note in the shipped write-access note shape sits under the group and names the missing permission in the pattern of the shipped permission messages. One note serves both options, because one permission covers both (ruling 1). State 11 shows the sheet, not the Bulk Actions menu, because D2 keeps Send command enabled for a person with any command permission. The disabled options therefore show only in the sheet.

## Questions that the screens expose

1. Case of the typed phrase. D7 says the phrase matches after trimming spaces and does not say whether case counts. The mockup requires the uppercase phrase (choice 8).
2. Armed commands after the job ends. State 09 shows a Powerwash command that stays valid at Google until 2031 while the job ends Needs review at 30 days. The job page offers no action for it, because no API cancels a command (record risk 2). The Unknown row names the expiry so the person sees it.
3. Button wording. D9 names the button "Send Wipe to N devices", while the option, the titles, and the job name the action "Wipe user data". The record confirms D9 as written, so the mockup keeps it.

## App-sourced strings

Proven by `check-strings.py`. A source string is a whole literal or element text in `frontend/src/app` or `libs/application-contracts/src`. A template string names the source template that builds it from mockup data.

- "7,000 matching devices · 7,000 in district" · template, device-status-panel.ts
- "Inventory observed Oct 22, 2:05 PM" · template, device-status-panel.ts
- "Selected on current page: 6" · template, LibreGrid selection footer
- "Total Selected: 6" · template, LibreGrid selection footer
- "Select All (7000)" · template, LibreGrid selection footer
- "Deselect All" · template, LibreGrid selection footer
- "Show All Selected (6)" · template, LibreGrid selection footer
- "Choose a device command" · device-action-messages.ts
- "6 selected devices · Not submitted" · template, device-action-sheet.ts
- "1" · template, device-action-sheet.html, job-detail.html
- "Choose" · device-action-sheet.ts
- "2" · template, device-action-sheet.html, job-detail.html
- "Review" · device-action-sheet.ts
- "3" · template, device-action-sheet.html, job-detail.html
- "Confirm" · device-action-sheet.ts
- "Command" · device-action-messages.ts
- "Reboot" · device-action-messages.ts
- "Restarts the devices and interrupts active sessions." · device-action-messages.ts
- "4 of 6 selected devices are active." · template, device-action-messages.ts
- "Excluded devices stay out of the job. The review lists each excluded device with its reason." · device-action-messages.ts
- "Close" · device-action-sheet.html
- "Send command steps" · device-action-messages.ts
- "Frozen preview · Prepared Oct 22, 2:08 PM" · template, device-action-sheet.ts
- "6 devices · 4 commands · 2 excluded" · template, device-action-messages.ts
- "Targets are frozen. New matching devices will not join this job." · device-action-messages.ts
- "Prepared Oct 22, 2:08 PM · Expires Oct 22, 2:23 PM · Preview PV‑015" · template, device-action-messages.ts
- "Device" · device-action-sheet.html
- "Observed status" · device-action-sheet.html
- "Active" · device-action-messages.ts
- "Disabled" · device-action-messages.ts
- "Not sent" · device-action-messages.ts
- "Excluded · Device is disabled" · template, device-action-messages.ts
- "Deprovisioned" · device-action-messages.ts
- "Excluded · Device is deprovisioned" · template, device-action-messages.ts
- "Continue to confirmation" · device-action-sheet.html
- "Back to command" · device-action-messages.ts
- "Review the approved scope" · device-action-sheet.ts
- "Google accepting the request does not confirm execution. Track each device in the job." · device-action-messages.ts
- "Preview PV-015 · 6 devices · 4 commands" · template, device-action-messages.ts
- "Expires Oct 22, 2:23 PM" · template, device-action-messages.ts
- "Back to preview" · device-action-sheet.html
- "Preview PV-016 · 6 devices · 4 commands" · template, device-action-messages.ts
- "Expires Oct 22, 2:25 PM" · template, device-action-messages.ts
- "Change device status" · device-action-messages.ts
- "Status change" · device-action-messages.ts
- "Disable" · device-action-messages.ts
- "Blocks user access while keeping devices enrolled." · device-action-messages.ts
- "Re-enable" · device-action-messages.ts
- "Restores access to disabled devices." · device-action-messages.ts
- "1 of 6 selected devices is disabled." · template, device-action-messages.ts
- "Change status steps" · device-action-messages.ts
- "Frozen preview · Prepared Oct 22, 2:14 PM" · template, device-action-sheet.ts
- "6 devices · 5 status changes · 1 excluded" · template, device-action-messages.ts
- "Prepared Oct 22, 2:14 PM · Expires Oct 22, 2:29 PM · Preview PV‑017" · template, device-action-messages.ts
- "Not changed" · device-action-messages.ts
- "Back to status" · device-action-messages.ts
- "Preview PV-017 · 6 devices · 5 status changes" · template, device-action-messages.ts
- "Expires Oct 22, 2:29 PM" · template, device-action-messages.ts
- "Command job created" · device-action-messages.ts
- "Job CMD-008 · Running" · template, job-receipt-messages.ts
- "Your job is saved" · job-receipt-messages.ts
- "You can close this panel and follow progress in Jobs." · job-receipt-messages.ts
- "View job" · device-action-sheet.html
- "Done" · device-action-sheet.html
- "Job CMD-008 · Awaiting devices" · template, job-detail.ts
- "Back to jobs" · job-detail.html
- "Refresh" · job-detail.html
- "CMD-008 · 4 devices" · template, job-detail-fields.ts
- "Awaiting devices" · job-fields.ts
- "Requested by Review administrator · Oct 22, 2:11 PM · Duration: 23h 04m" · template, job-detail-fields.ts, job-fields.ts
- "Operation counts" · job-detail.html
- "Succeeded" · job-detail-fields.ts
- "0" · template, device-action-sheet.html, job-detail.html
- "Failed" · job-detail-fields.ts
- "Unknown" · job-detail-fields.ts
- "Expired" · job-detail-fields.ts
- "Pending" · job-detail-fields.ts
- "Skipped" · job-detail-fields.ts
- "Cancelled" · job-detail-fields.ts
- "Operation results" · job-detail.html
- "Show 2 needing attention" · template, job-detail.html
- "Operation results for job CMD-008" · template, job-detail.html
- "Operation" · job-detail.html
- "Before" · job-detail.html
- "Requested" · job-detail.html
- "Outcome" · job-detail.html
- "Updated" · job-detail.html
- "Actions" · job-detail.html
- "—" · job-detail-fields.ts
- "Acknowledged" · job-detail-fields.ts
- "Expires Oct 22, 2031, 2:11 PM" · template, device-action-messages.ts
- "Inspect failure" · job-detail.html
- "Pending delivery" · job-detail-fields.ts
- "Rows 1–4 of 4 operations" · template, job-detail-fields.ts
- "Latest activity" · job-detail.html
- "2:40 PM · 02A1MB6 reported an execution failure. The outcome for 04XTBHJ is uncertain. 2 commands wait for device execution." · template, job-detail-fields.ts
- "Operation results table" · job-detail.html
- "Open device 01P0T1V" · template, job-detail.html
- "Open device 02A1MB6" · template, job-detail.html
- "Open device 02QJANY" · template, job-detail.html
- "Open device 04XTBHJ" · template, job-detail.html
- "Previous operations page" · job-detail.html
- "Next operations page" · job-detail.html
- "Job STS-003 · Completed with errors" · template, job-detail.ts
- "STS-003 · 5 devices" · template, job-detail-fields.ts
- "Completed with errors" · job-fields.ts
- "Requested by Review administrator · Oct 22, 2:16 PM · Duration: 3s" · template, job-detail-fields.ts, job-fields.ts
- "4" · template, device-action-sheet.html, job-detail.html
- "Show 1 needing attention" · template, job-detail.html
- "Operation results for job STS-003" · template, job-detail.html
- "Rows 1–5 of 5 operations" · template, job-detail-fields.ts
- "2:16 PM · Google rejected the status change for 04XTBHJ (status-conflict)." · template, job-detail-fields.ts
- "Open device 04QVJBY" · template, job-detail.html
- "Review Reboot" · template, device-action-sheet.ts, device-action-messages.ts

## Mockup data

Serials come from the real screenshots. Typed values, times, and IDs belong to the scenario. The two failure reasons are admin-sdk-mock messages: `FAILURE_MESSAGE` in `src/directory/commands.ts` and the status refusal in `src/directory/device-writes.ts`.

- "01P0T1V"
- "02A1MB6"
- "02QJANY"
- "04QVJBY"
- "04XTBHJ"
- "0727D2E"
- "WIPE"
- "DEPROVISION"
- "1:12 PM"
- "2:11 PM"
- "2:16 PM"
- "2:40 PM"
- "The device failed to execute the command."
- "A device with status DEPROVISIONED does not allow this action."

## Drafted strings

For owner review. Each line names its origin. "record" is the owner-confirmed workflow record. "Figma" names the frame. "DEVICE-01" is the row of `docs/ui/patterns.md`. "drafted" is new copy.

- "Wipe user data" · record D3, option label and Command cell
- "Removes local user profiles. Device policy and enrollment remain." · DEVICE-01
- "Powerwash" · record D3, option label, Operation and Requested cells
- "Removes local data, user and device policies, and enrollment. Enrollment rules govern subsequent enrollment." · DEVICE-01
- "Review Wipe user data" · drafted, shipped reviewLabel() pattern
- "Review 4 Wipe user data commands" · drafted, shipped reviewTitle() pattern
- "An offline device runs Wipe user data when it next connects, unless the command expires first. The job shows the expiry that Google returns." · drafted, record D16
- "Wipe user data targets" · drafted, shipped targetsLabel() pattern
- "Frozen Wipe user data targets" · drafted, table caption, shipped targetsCaption() pattern
- "Wipe user data on 4 devices" · Figma 111:497 title
- "Remove local user profiles" · Figma 111:497 heading
- "Wipe user data removes all local user profiles. Device policies and enrollment remain in place." · Figma 111:497
- "I understand that all local user profile data will be removed." · record D8, Figma 111:497, kept word for word because the record quotes it
- "Type WIPE to confirm" · record D7, Figma 111:497
- "Send Wipe to 4 devices" · record D9
- "Powerwash 4 devices" · Figma 97:129 title
- "Powerwash permanently removes device data" · Figma 97:129 heading
- "Powerwash removes local data, user policies, device policies, and enrollment. Forced or automatic enrollment rules control re-enrollment." · Figma 97:129
- "I understand the data loss and enrollment consequences." · record D8, Figma 97:129
- "Type POWERWASH to confirm" · record D7, Figma 97:129
- "The phrase does not match. Type POWERWASH." · drafted, error line of the typed phrase
- "Send Powerwash to 4 devices" · record D9
- "Deprovision" · record D3, option label, Status change and Operation cells
- "Removes devices from active management." · DEVICE-01
- "5 of 6 selected devices are active or disabled." · drafted, shipped targetSummaryText() pattern
- "Deprovision reason" · Figma 97:93 field label, also the name of the option panel
- "Review Deprovision" · drafted, shipped reviewLabel() pattern
- "Retiring from fleet" · record D11, Google admin label
- "Different model replacement" · record D11, Google admin label
- "Same model replacement" · record D11, Google admin label
- "ChromeOS Flex upgrade transfer" · record D11, Google admin label
- "Review 5 Deprovision status changes" · drafted, shipped reviewTitle() pattern
- "Deprovision reason: Retiring from fleet" · drafted, record D12
- "Deprovision does not erase local data. Send Powerwash first to erase a device that leaves the district." · record D10, the drafted addition
- "Deprovision targets" · drafted, shipped targetsLabel() pattern
- "Frozen Deprovision targets" · drafted, table caption, shipped targetsCaption() pattern
- "Deprovision 5 devices" · record D9, Figma 97:93, title and button
- "Remove 5 devices from active management" · Figma 97:93 heading
- "Deprovision removes these devices from active management. This workflow cannot restore their previous management state." · Figma 97:93
- "5 eligible · 1 excluded · The job records the reason and the targets." · Figma 97:93, rewritten in active voice
- "Type DEPROVISION to confirm" · ruling 3, Figma 97:93
- "4 devices · 4 Powerwash commands. Google changes have not completed." · drafted count line in the shipped receiptActionLine() pattern, with the app sentence of receiptCompletionSentence()
- "Powerwash devices" · record D3, Figma 99:73
- "No result in 30 days" · drafted, ruling 2 (outcome reason not-observed)
- "Deprovision devices" · record D3
- "You need the devices:read, devices:wipe, and devices:bulk-actions permissions to wipe user data or powerwash devices. Ask your administrator for access." · drafted, ruling 1, shipped permission message pattern

## Checks

- `render-report.json` summary: 0 page errors, 0 console errors, 0 route aborts (the page requests nothing outside `file:` and `data:`), 0 other failed requests, 0 overflow problems.
- Click test (`flow` in `render-report.json`): the Bulk Actions hotspot opens Send command. Review Wipe user data and Continue to confirmation walk states 01 to 03. Send Wipe stays disabled with the box alone, with POWERWASH typed, and after the box is unchecked. It enables with the box and " WIPE " (trimmed). Powerwash with WIPE typed stays disabled and enables with POWERWASH. Send Powerwash and View job reach states 08 and 09. Deprovision 5 devices reaches state 10. The reason panel lists the four labels with none selected, and Review Deprovision enables after a reason. Deprovision stays disabled with an empty phrase and with "deprovision", and enables with DEPROVISION. In state 11 a click on a disabled option keeps Reboot. Escape closes the sheet.
- `check-strings.py`: 174 strings. 63 source, 51 template, 14 data, 46 drafted.
