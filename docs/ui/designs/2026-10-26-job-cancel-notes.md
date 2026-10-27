# Cancel pending work on any job: mockup notes

Approved as drawn on 2026-10-26. Owner, in the main chat: "Thats fine." Built on 2026-10-26. It is not the built app.

- HTML: `job-cancel-mockup.html`, one self-contained file (base64 screenshots and fonts) with a state switcher at the bottom left. Deep links: `#01-running-job` to `#07-jobs-grid-cancelled`.
- PNGs: `png/`, one per state, light theme, viewport 1440 x 900, deviceScaleFactor 1.
- Render checks: `render-report.json`. Calibration: `work/cal/`. Lessons for the skill: `work/skill-lessons.md`.
- Governing records (branch `codex/batch-update-export-import`, f2d67a0): `docs/research/batch-update-export-import-technical-design.md`, sections 14.2 and 21, and `docs/workflows/batch-update-export-import.md`, section "Cancel pending work on any job (D6)".
- App source: `origin/main` 89d5478, read from the worktree `ige-rehearsal`, whose `frontend/`, `libs/`, and `api/` trees equal `origin/main`.
- Rebuild in this folder: `python3 build.py && node render.cjs && python3 work/cal/cal.py && python3 work/make-notes.py && python3 check-strings.py` (Node 24.19.0). `make-notes.py` fills the calibration table from `work/cal/cal-results.json`.

## Owner direction

Main chat, 2026-10-26, quoted from the records. Decision D6:

> We need to add a universal cancel job feature to the job service.

His answers to the five cancel questions:

> 1 Anyone with Job:Manage a platform admin, or the owner can cancel the job.
>
> 2) agreed
>
> 3) Nope cancelled is fine.  We will still have a status document even if it was cancelled. Any successes or failures that happened before the cancel will be recorded int he job results.
>
> 4) That is correct there is no ability to claw that back
>
> 5) That is fine

Answer 2 agrees that a cancel of the update job of an import also cancels its waiting status jobs. Answer 4 confirms that a command job offers no cancel once every command is issued. Answer 5 ships the cancel first, as its own slice.

His rules win over the Figma labels and compositions. The control keeps the Figma label "Cancel pending work" (228:4524, 228:4996). The built job page differs from those frames, so every state builds on the built page.

| Owner rule | States |
| --- | --- |
| Every job kind offers Cancel pending work while work remains | 01 (an update job, Running) and 05 (a status job, Queued). The other kinds reuse the same control. |
| The requester, `jobs:manage`, or a platform administrator can cancel | Every state shows Review administrator, the requester and a platform administrator. A person without the right sees no control (below). |
| A job that has not started ends at once, and nothing reaches Google | 05 and 06 |
| A running job shows "Cancellation requested" until every operation settles | 03 |
| The job ends Cancelled, also with an Unknown operation, and keeps every earlier outcome | 04 |
| An Unknown operation keeps Reconcile, and a failed or Unknown operation raises the attention dot | 04 (Reconcile and the bell dot) and 07 |
| The confirmation states the pending count, the work already sent, and no rollback | 02 and 05 |
| The job page shows who requested the cancel and when | 03, 04, and 06 |
| Cancel never undoes a completed change. No Pause, Resume, or Retry | 02 to 04: no state offers any of them |

## States

| PNG | Size | What it shows |
| --- | --- | --- |
| `01-running-job.png` | 1440 x 1127, full page | UPD-001, Update device annotations, Running: 48 devices with one field each, 36 succeeded and 12 pending. Cancel pending work sits right of Refresh. The bell shows the running badge. |
| `02-cancel-confirm-running.png` | 1440 x 900, viewport | The question over state 01: 12 of 48 operations pending, what happens to sent and unsent work, the 36 confirmed updates, and no rollback. "Keep job running" and "Cancel pending work". |
| `03-cancellation-requested.png` | 1440 x 1267, full page | The same job right after the request. The status stays Running. The banner reads "Cancellation requested", the identity card names the person and the time, and the control reads "Cancellation requested", disabled. The counts moved on to 38 succeeded and 10 pending. |
| `04-cancelled-result.png` | 1440 x 1247, full page | The final page. Status Cancelled. 38 succeeded, 1 failed, 1 unknown, 0 expired, 0 pending, 0 skipped, 8 cancelled. Rows 37 to 42 show Succeeded, Failed with Inspect failure, Unknown with Reconcile, and Cancelled. The bell shows the attention dot. |
| `05-queued-confirm.png` | 1440 x 900, viewport | STS-001, Disable devices, Queued, 18 devices, nothing started, with the question: no operation started, all 18 end Cancelled, no request reaches Google. |
| `06-queued-cancelled.png` | 1440 x 1223, full page | STS-001 after the cancel: Cancelled, 18 cancelled, and the latest activity "Cancellation ended the job before it started." |
| `07-jobs-grid-cancelled.png` | 1440 x 994, full page | The built Jobs grid with STS-001 and UPD-001 as Cancelled rows above the six real rows of the review build. |

The job pages and the Jobs grid are taller than the viewport, so states 01, 03, 04, 06, and 07 are full-page captures. States 02 and 05 are viewport captures: the dialog is fixed to the viewport, and the page continues below the fold, as in the app.

### No Cancel pending work shown

No state draws these two cases. Both keep the built toolbar, Back to jobs and Refresh.

- A person without the right, someone who did not request the job and holds neither `jobs:manage` nor the platform administrator role: no Cancel pending work shown. The API refuses the request.
- A command job in Awaiting devices, with every command issued: no Cancel pending work shown. No API cancels an issued command.

A finished job offers no control either, because nothing is left to stop (states 04 and 06).

## Scenario and data

- One person in every state: Review administrator of the review builds. He requested both jobs, and he is a platform administrator.
- One inventory on the job pages: the 7,000-device inventory of the update device fields review (2026-10-22), with its serials 01P0T1V, 02A1MB6, 02QJANY, 04A9BVS, 04XTBHJ, 0727D2E, and 08V5B5S. The Before values North lab mvjusgh0, Front Office, and Not set come from its grid of Oct 22, 2:05 PM. North lab is the requested value, the example value of Figma 228:4524.
- UPD-001, Update device annotations: Annotated location North lab on 48 devices, one field each. Requested Monday, Oct 26, 10:40 AM.
- STS-001, Disable devices: 18 active devices, requested 10:41 AM. It is Queued because UPD-001 holds the write slot of the customer.
- Clock order: 05 and 06 at 10:41 AM, 01 to 03 at 10:42 AM, 04 at 10:43 AM, and 07 at 10:44 AM. The PNG order follows the brief.
- The cancel request of UPD-001 comes at 10:42 AM. Operations 37 and 38 were already sent and succeed. Operations 39 and 40 leave before the worker reads the request at its next lease renewal: 39 fails on Google quota, and the answer to 40 is lost, so 40 stays Unknown after its read-back. Operations 41 to 48 never leave the worker and settle Cancelled at 10:43 AM. The sum is 48.
- States 01, 03, and 04 show page 7 of the operations (rows 37 to 42), where the work stops, so the owner sees the same six rows change. Page 1 holds succeeded rows.
- Job IDs: UPD-001 and STS-001 continue the numbering of the Jobs grid screenshot (device commands review, Oct 22). Its six jobs are REF-001 and CMD-001 to CMD-005, so it holds no update and no status job.
- The bell: the running badge in 01, 02, 03, 05, and 06 (UPD-001 runs), and the attention dot in 04 and 07 (UPD-001 ended with a failed and an Unknown operation). STS-001 raises no dot.
- State 07 keeps the six real rows of the device commands review, so REF-001 reads "600 devices read" while the job pages use the 7,000-device inventory. No serial shows in the grid.
- The PNGs show the header of the review build: the connected domain and a simulated customer ID. The page footer comes from the same build.

## Fidelity and calibration

Every background is a real screenshot. `build.py` composes it and asserts every pixel assumption first.

- Job pages: the Jobs shell of `step1-07-job-detail.png` (update device fields review): header, navigation with Jobs active, and the review banner. The content column is empty, the navigation repeats one empty row, and the footer strip of `lost-02-job-detail-rows.png` (same build) closes each full page.
- Bells: real crops. The ring and badge 1 come from `step2-06-wipe-job.png` (2026-10-23 review), the attention dot from `jobs-attention-expired.png` (device commands review). Both headers equal the `step1-07` header outside the bell, and the script asserts it, so each crop replaces the bell alone.
- Jobs grid: `jobs-attention-expired.png`. Its six real rows move down 142 px, the height of the two new rows. The table viewport ends at the footer rule, so REF-001 shows its top 25 px, as a grid of eight rows does at a 900 px viewport. The full page continues with the grid footer and the page footer.
- Overlays: the app CSS of `origin/main` 89d5478 (`job-detail.css`, `jobs.css`, `device-dialog.css`, `device-grid-revert-dialog.css`, `styles.scss`, `tokens.css`), the app theme compiled with the repository sass, and the Angular Material 22.2.2 button, focus indicator, and ripple CSS with the button DOM. Icons use the bundled Material Symbols font.

`python3 work/cal/cal.py` re-creates four real regions with the mockup CSS. Each case draws its region over a background without the real content: the job cases use the empty content column of `bg-jobs`, the grid case empties the grid body and footer, and the dialog case paints the inside of the real dialog magenta. The control column compares the background alone with the real screen, so it proves that the drawn overlay carries the region. Mean absolute difference per pixel and channel, 0 to 255, pass under 0.2:

| Real screen | Region | Mean difference | Background alone | Note |
| --- | --- | --- | --- | --- |
| Job page of UPD-002, `step1-07-job-detail.png` | x 240-1440, y 166-900 | 0.000 | 7.188 | six field rows with wrapped values, the hover layer of the fifth row |
| Deprovision job page of the 2026-10-23 review (its own STS-001), `step4-08-deprovision-job.png` | x 240-1440, y 166-900 | 0.000 | 6.516 | the second identity line, the shape of the new cancel line |
| Jobs grid rows and footer, `jobs-attention-expired.png` | x 240-1440, y 330-900 | 0.000 | 4.627 | six rows with four status labels in three tones |
| Dialog shell with the organization unit picker, `step2-02-ou-selected.png` | x 500-940, y 258-706 | 0.000 | 86.716 | the shell that the cancel question reuses |

No real screenshot shows the job banner. It copies the built `.banner` rules of `job-detail.css`, the shape of the offline and stale banners.

Render report: zero page errors, zero console errors, zero blocked requests, zero failed requests, and zero overflow problems. The page made three requests, each a `file:` load of the HTML. The click test (`flow` in `render-report.json`) opens the question, keeps the job with the dismiss button and with Escape, confirms the cancel into state 03, refuses a second request, reaches state 04 through Refresh, follows Back to jobs and both eye links of the grid, runs the queued path from 05 to 06, loads two deep links, and follows a hash change.

## Composition choices

The record and the Figma frames leave these open. Each item names the pick and the reason.

1. **Control place.** Cancel pending work is the rightmost toolbar button, right of Refresh, as in Figma 228:4524. Back to jobs stays left. The built toolbar spreads its children apart, so a right-hand group keeps Refresh and Cancel pending work together, 8 px apart.
2. **Control look.** The plain outlined button of Refresh, as Figma shows it, not the destructive red. The cancel stops writes and changes nothing in Google, and UI-05 keeps the destructive style for destructive actions.
3. **Question shell.** The built question dialog of Revert all changes: an alert dialog of 480 px with a title, its paragraph style, a text button, and a filled button. The filled button repeats the control label. The built dialog holds one paragraph. The cancel question holds two, 12 px apart (`--cc-space-md`), and `aria-describedby` names both.
4. **Question title.** It names the job: "Cancel pending work on UPD-001?". The scrim covers the page title, and the import variant cancels more than one job.
5. **Question body for a running job.** The pending count out of the total, the rule for operations that have not reached Google, the requests already sent, the confirmed updates, and no rollback. It names no exact cancelled count, because requests that leave before the worker reads the request still finish (state 04 shows four).
6. **Question body for a job that has not started.** No operation started, all of them end Cancelled, no request reaches Google, and the devices keep their status.
7. **Dismiss label.** "Keep job running" for a running job. "Keep job waiting" for an Accepted, Queued, or Held job, after the Waiting group of the built Activity panel. A plain "Cancel" next to "Cancel pending work" reads as the same action.
8. **After the request.** The control stays in place, disabled, and reads "Cancellation requested". It uses the Material disabledInteractive state, so focus returns to it when the question closes (UI-09). A second request is not possible.
9. **Cancellation requested banner.** The built banner shape of the offline and stale states, under the toolbar: "Cancellation requested · The job stops within 30 seconds" and one paragraph on sent work, pending work, and no rollback. It shows until every operation settles.
10. **Who and when.** A second identity line, "Cancellation requested by Review administrator · Oct 26, 10:42 AM", in the shape of the built Deprovision reason line. It stays after the job ends (04 and 06).
11. **Status label and tone.** "Cancelled" with the neutral tone of the built Queued chip, on the job page and in the Jobs grid. The failed and Unknown operations show in the counters, the progress cell, the attention button, and the bell dot.
12. **Cancelled operation row.** The neutral chip "Cancelled" with the note "Not sent to Google" in the built outcome note style, the settle time, and no action. A command that Google cancelled keeps the built red Failed chip with "Google cancelled the command.", so the two never look alike.
13. **Counts.** The built Cancelled counter shows the cancelled count. No counter is added.
14. **Latest activity.** During Cancellation requested the built counter line stays, and the banner carries the request. A cancelled job leads with a cancel sentence and keeps the built sample sentences after it: "Cancellation stopped 8 operations before they reached Google." A job that never started reads "Cancellation ended the job before it started. No request reached Google."
15. **Jobs grid progress cell.** The first line follows the finished jobs ("38 succeeded"). The second line adds the cancelled count after the built exception counts ("1 failed · 1 unknown · 8 cancelled").
16. **Page shown.** States 01, 03, and 04 show page 7 of the operations, the page where the work stops, instead of page 1.
17. **Mockup navigation.** The mockup has no live job stream, so Refresh in state 03 shows state 04. The built page updates live (JOB-02).

## Questions that the screens expose

Product questions for the owner:

1. **Requests after the click.** The worker reads a cancel request at its next batch claim or lease renewal. The renewal runs every 30 seconds (`worker/src/device-update.ts:1344`, cited by section 14.2). In state 04, four requests left after the click: two succeeded, one failed, and one stayed Unknown. Options: keep the 30-second check (recommended, as the record sets it), or read the request before every Google request, which stops within one request at the cost of one database read per request.
2. **Reason for the cancel.** The question asks for no reason, and the audit record holds the person and the time only. Options: no reason (recommended, as the record sets it), an optional reason, or a required reason.

Build notes for the engineers:

- `jobCounters` keeps the Cancelled value at 0 (`job-detail-fields.ts:143`). It reads the new cancelled count.
- `progressLines` falls back to "Not started" and "In progress" for a status that it does not know, so the cancelled status needs its own case (choice 15).
- `JOB_STATUS_LABELS` and `OUTCOME_LABELS` need the cancelled value. The Jobs status filter reads its labels from `JOB_STATUS_LABELS`. `statusTone` already returns neutral for a status that it does not name, the tone of choice 11, and the Activity panel picks its Recent icon from that tone.
- No state draws the question for the update job of an import. It names each waiting status job that the cancel ends.
- No state draws the question for a refresh, validation, or export job. These jobs count pages or rows, so their question needs its own count sentence.

Defects:

- Inherited from the reference build: the in-grid editing template lacks the `.tone-warning` chip rule of `job-detail.css` (it keeps `.value.tone-warning` alone), so an Unknown chip renders in the primary text color with a dark dot. No reference state showed one. This build restores the rule, and the Unknown row of state 04 uses it.
- Inherited from both reference builds: the `.uline` span draws a 1 px line over the underline that the browser already draws under the eye link. This build drops the span, and the job and grid calibrations still match the real screens.
- Inherited from the reference build: its `work/main-src/` snapshot copies app source that holds a field identifier with one of the forbidden letter sequences (the camelCase identifier of the Annotated user field). This build reads the string corpus from `git archive` in memory and writes no snapshot.
- Inherited from the reference build: `in-grid-editing-mockup.html` holds the same identifier as text outside its base64 data, and so does its approved copy `docs/ui/designs/2026-10-23-in-grid-editing.html` (12 times). `docs/ui/designs/2026-10-21-update-device-fields.html` holds it once.
- The base64 data of the fonts and screenshots holds forbidden letter sequences by chance (70 in this HTML), as the base64 data of five approved mockups in `docs/ui/designs/` does. `build.py` breaks each one with a space, which the data URL decoder skips, and asserts that the HTML holds none. `build.py` and `check-strings.py` keep the list of sequences in rot13.

## App-sourced strings

78 strings. Each line names the file of `origin/main` 89d5478 that holds the literal, or the files that hold the template pieces (`check-strings.py`, TEMPLATES).

- "Update device annotations" · libs/application-contracts/src/lib/jobs.ts
- "Job UPD-001 · Running" · template in job-detail.ts, job-fields.ts
- "Back to jobs" · frontend/src/app/jobs/job-detail.html
- "Refresh" · frontend/src/app/devices/devices.html
- "UPD-001 · 48 devices" · template in device-update-messages.ts, job-detail-fields.ts
- "Running" · frontend/src/app/jobs/job-fields.ts
- "Requested by Review administrator · Oct 26, 10:40 AM · Duration: 2m 08s" · template in job-detail-fields.ts, job-fields.ts
- "Operation counts" · frontend/src/app/jobs/job-detail.html
- "Succeeded" · frontend/src/app/jobs/job-detail-fields.ts
- "36" · template in job-detail.html, job-detail.ts
- "Failed" · frontend/src/app/jobs/job-detail-fields.ts
- "0" · template in job-detail.html, job-detail.ts
- "Unknown" · frontend/src/app/jobs/job-detail-fields.ts
- "Expired" · frontend/src/app/jobs/job-detail-fields.ts
- "Pending" · frontend/src/app/jobs/job-detail-fields.ts
- "12" · template in job-detail.html, job-detail.ts
- "Skipped" · frontend/src/app/jobs/job-detail-fields.ts
- "Cancelled" · frontend/src/app/jobs/job-detail-fields.ts
- "Operation results" · frontend/src/app/jobs/job-detail.html
- "Operation results for job UPD-001" · template in job-detail.html
- "Device" · frontend/src/app/devices/device-action-sheet.html
- "Operation" · frontend/src/app/jobs/job-detail.html
- "Before" · frontend/src/app/devices/device-columns.ts
- "Requested" · frontend/src/app/jobs/job-detail.html
- "Outcome" · frontend/src/app/jobs/job-detail.html
- "Updated" · frontend/src/app/invitations/invitations.html
- "Actions" · frontend/src/app/jobs/job-detail.html
- "Annotated location" · frontend/src/app/devices/device-detail.html
- "Not set" · frontend/src/app/devices/device-detail.html
- "Rows 37–42 of 48 operations" · template in job-detail-fields.ts
- "Latest activity" · frontend/src/app/jobs/job-detail.html
- "10:42 AM · 36 updates confirmed. Twelve operations remain pending." · template in job-detail-fields.ts
- "Operation results table" · frontend/src/app/jobs/job-detail.html
- "Open device 02QJANY" · template in job-detail.html
- "Open device 02A1MB6" · template in job-detail.html
- "Open device 04XTBHJ" · template in job-detail.html
- "Open device 0727D2E" · template in job-detail.html
- "Open device 04A9BVS" · template in job-detail.html
- "Open device 08V5B5S" · template in job-detail.html
- "Previous operations page" · frontend/src/app/jobs/job-detail.html
- "Next operations page" · frontend/src/app/jobs/job-detail.html
- "Requested by Review administrator · Oct 26, 10:40 AM · Duration: 2m 27s" · template in job-detail-fields.ts, job-fields.ts
- "38" · template in job-detail.html, job-detail.ts
- "10" · template in job-detail.html, job-detail.ts
- "10:42 AM · 38 updates confirmed. Ten operations remain pending." · template in job-detail-fields.ts
- "Requested by Review administrator · Oct 26, 10:40 AM · Duration: 2m 58s" · template in job-detail-fields.ts, job-fields.ts
- "1" · template in job-detail.html, job-detail.ts
- "8" · template in job-detail.html, job-detail.ts
- "Show 2 needing attention" · template in job-detail-fields.ts, job-detail.html
- "Google quota stopped the update for 04XTBHJ." · template in job-detail-fields.ts
- "Inspect failure" · frontend/src/app/jobs/job-detail.html
- "Reconcile" · frontend/src/app/jobs/job-detail.html
- "Disable devices" · libs/application-contracts/src/lib/jobs.ts
- "Job STS-001 · Queued" · template in job-detail.ts, job-fields.ts
- "STS-001 · 18 devices" · template in device-update-messages.ts, job-detail-fields.ts
- "Queued" · frontend/src/app/jobs/job-fields.ts
- "Requested by Review administrator · Oct 26, 10:41 AM · Duration: not started" · template in job-detail-fields.ts
- "18" · template in job-detail.html, job-detail.ts
- "Operation results for job STS-001" · template in job-detail.html
- "Disable" · frontend/src/app/devices/device-action-messages.ts
- "Active" · frontend/src/app/devices/device-action-messages.ts
- "Disabled" · frontend/src/app/devices/device-action-messages.ts
- "Open device 01P0T1V" · template in job-detail.html
- "Rows 1–6 of 18 operations" · template in job-detail-fields.ts
- "0 succeeded" · template in job-fields.ts
- "18 devices" · template in job-fields.ts
- "Oct 26, 10:41 AM" · template in job-fields.ts, jobs.html
- "Not started" · frontend/src/app/jobs/job-fields.ts
- "38 succeeded" · template in job-fields.ts
- "48 devices" · template in job-fields.ts
- "Oct 26, 10:40 AM" · template in job-fields.ts, jobs.html
- "2m 58s" · template in job-fields.ts
- "8 jobs · Updated Oct 26, 10:44 AM" · template in jobs.ts
- "Rows 1–8 of 8" · template in jobs.ts
- "Open details for job STS-001" · template in jobs.html
- "Open details for job UPD-001" · template in jobs.html
- "Previous page" · frontend/src/app/jobs/jobs.html
- "Next page" · frontend/src/app/jobs/jobs.html

## Mockup data

17 strings: serials, job IDs, inventory values, the requested value, times, and the person.

- "02QJANY" · state 01
- "North lab mvjusgh0" · state 01
- "North lab" · state 01
- "10:40 AM" · state 01
- "02A1MB6" · state 01
- "04XTBHJ" · state 01
- "Front Office" · state 01
- "0727D2E" · state 01
- "04A9BVS" · state 01
- "08V5B5S" · state 01
- "10:42 AM" · state 03
- "10:43 AM" · state 04
- "01P0T1V" · state 05
- "10:41 AM" · state 05
- "STS-001" · state 07
- "Review administrator" · state 07
- "UPD-001" · state 07

## Drafted strings

22 drafted strings for owner review, grouped by pattern. Each line names the first state that shows it. "Cancelled" also counts as app-sourced, because the counter label of the built page holds it.

### Control and question buttons (Figma label, drafted dismiss labels)

- "Cancel pending work" · state 01
- "Keep job running" · state 02
- "Keep job waiting" · state 05

### Question title

- "Cancel pending work on UPD-001?" · state 02
- "Cancel pending work on STS-001?" · state 05

### Question body

- "12 of 48 operations are pending. Those that have not reached Google end Cancelled and never run." · state 02
- "Requests already sent to Google finish and keep their results. The 36 confirmed updates stay. Nothing rolls back." · state 02
- "No operation has started. All 18 operations end Cancelled." · state 05
- "No request reaches Google. The 18 devices keep their current status." · state 05

### Cancellation requested state (record wording)

- "Cancellation requested" · state 03
- "Requests already sent to Google finish and keep their results. Pending operations that have not reached Google end Cancelled. Nothing rolls back." · state 03
- "Cancellation requested by Review administrator · Oct 26, 10:42 AM" · state 03
- "Cancellation requested · The job stops within 30 seconds" · state 03
- "Cancellation requested by Review administrator · Oct 26, 10:41 AM" · state 06

### Cancelled job page (built templates with the new status)

- "Job UPD-001 · Cancelled" · state 04
- "Not sent to Google" · state 04
- "10:43 AM · Cancellation stopped 8 operations before they reached Google. Google quota stopped the update for 04XTBHJ. 0727D2E requires reconciliation before any retry." · state 04
- "Job STS-001 · Cancelled" · state 06
- "10:41 AM · Cancellation ended the job before it started. No request reached Google." · state 06

### New use of an app literal

- "Cancelled" · state 04, job status label and operation outcome label (the app holds it as a counter label)

### Jobs grid progress cells (the built counter line with a cancelled part)

- "18 cancelled" · state 07
- "1 failed · 1 unknown · 8 cancelled" · state 07
