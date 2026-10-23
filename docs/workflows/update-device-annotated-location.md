# Update the annotated location of selected devices

Status: proposed. The owner reviews this record before implementation.
Source: owner decisions of 2026-10-16, quoted under [Owner decisions](#owner-decisions--2026-10-16).
Design: [Figma page 09](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=94-2), with the node links under [Design](#design), plus the approved activity-area mockup. No design gaps remain.
Replaces: none.

## User and outcome

The existing administrator updates the annotated location of selected ChromeOS devices.
The administrator selects the devices, enters one location value, reviews the exact changes, and confirms them.
The edit runs as a background job. The Jobs page shows progress and per-device results.
The jobs activity area reports running jobs at a glance and recent activity. Its design source is the approved mockup under [Design](#design).

## Interaction

The administrator selects devices with filters and the selection footer, following [GRID-04](../ui/patterns.md#entity-grid).
Select All captures every device that matches the filters.
Bulk Actions sits to the right of Refresh. This slice adds one item to it: Update device.
Update device is disabled with a named reason when the selection is empty, the write scope is missing, or the app is offline.

Update device opens the bulk action sheet on the right, over the grid. The sheet holds the draft, the preview, the confirmation, and the receipt.
The draft shows the selected count, Annotated location, and Change mode.
The Change mode label is "Update · Replace the existing value". The D1 answer calls this mode "Replace".
Replace writes one location value to every target. It accepts at most 200 characters, counted as code points, and rejects a whitespace-only value.
Clear value is a separate explicit choice. It removes the location and sends `null`.
The draft omits the Organization unit field. Figma shows "Leave unchanged", and UI-05 forbids inert controls.
The draft stays available when the administrator filters, scrolls, or refreshes.
Review pending devices shows the selected devices in the Devices grid and keeps the draft.

Save and preview prepares a frozen preview on the server.
The preview page "Review N device updates" (`97:21`) shows the exact targets with their observed and approved values.
The summary counts the devices, the field changes, and the exclusions.
The page states that targets and final values are frozen, and that new matching devices will not join.
It shows the preparation time, the expiry, the preview ID, and the observation age with a stale warning.
The targets and values freeze when preparation completes, and confirmation binds to that preview.
Targets paginate. New query matches never join an approved preview.
Edit draft returns to the draft. Continue to confirmation advances.

The confirmation page "Confirm N device updates" (`97:57`) restates the action and the change.
It shows the preview ID, the counts, and the expiry.
The acknowledgment checkbox reads "I reviewed all N devices and their final values."
Back to preview returns to the frozen preview. Create update job creates the job.
The confirmation blocks duplicate submission.
The receipt page "Update job created" (`104:74`) reads "Your job is saved". It claims no completed changes.
It offers Back to devices and View job. Jobs is the active navigation item.
The Jobs page lists the job as Running with progress. The activity area shows the job while it runs.
The job detail shows the outcome counts and the per-device operations with before and requested values.
Reconcile on an unknown operation re-reads that device and settles its outcome. It never writes.

## Data and access

| Data                     | Google source                         | Scope suffix                               |
| ------------------------ | ------------------------------------- | ------------------------------------------ |
| Device inventory         | Directory API `chromeosdevices.list`  | `admin.directory.device.chromeos.readonly` |
| Annotated location write | Directory API `chromeosdevices.patch` | `admin.directory.device.chromeos`          |

All scopes use the `https://www.googleapis.com/auth/` prefix.
The patch body holds only `annotatedLocation`. Clear sends `null`.
Campus Commander sends the changes as PATCH parts through the batch service, at most 250 parts per batch.
Google limits `annotatedLocation` to 200 characters and allows an empty value.
The patch response returns the updated device. The local row updates from that response, and open grids refresh it in place.
One write job runs at a time. Worker backoff reports write a Redis admission hold with a 300 second TTL on a `cc:*` key.
The hold blocks new Update Device jobs and leaves admitted work running. Other job types stay eligible.

The existing administrator performs the edit. Both actions are required: `devices:write` and `devices:bulk-actions`.
The bootstrap grants every action to the existing administrator.
Until the owner designs platform access, the single administrator sees every job.
Every job stores the requester and each target's OrgUnit path.

Without the write scope, Update device stays disabled and the message names `admin.directory.device.chromeos`.
The write-scope message follows the PR #28 pattern: "Google denied device changes. Add https://www.googleapis.com/auth/admin.directory.device.chromeos to the delegation client in the Google Admin Console."
The named-scope message depends on PR #33, which classifies the 401 `unauthorized_client` answer. Without it, a missing write scope reads as a credential problem.
Device write tests use admin-sdk-mock only. The standing test authorization excludes device writes, so live write behavior stays "not verified".

## Owner decisions — 2026-10-16

Earlier decisions of 2026-10-16 (the device-browsing sign-off, the first edit choice, and the jobs UI coverage) are recorded in the [owner decisions of 2026-10-16](../workflow-gaps.md#owner-decisions--2026-10-16).

**D1, edit modes.** Question: "Which edit modes should the first annotated-location edit offer?"
The owner chose the answer "Replace and Clear now, Prepend and Append in the next slice".

**D2, write scope.** Question: "How should setup handle the Google write scope that device changes need (admin.directory.device.chromeos)?"
The owner chose the answer "List it with the setup scopes. Update device stays disabled, with a message naming the scope, until Google grants it".

**D3, Jobs navigation.** Question: "Should Jobs become a main navigation item next to Devices and Settings, as the Figma designs show?"
The owner answered: "A) AND We want a jobs activity notification area. This should be l;ike the googl;e cloud console notification area. At a glance shows when jobs re running and of you select it show you a summary of what is happening and happened recently."
Choice A was "Yes: a Jobs page in the main navigation, as Figma shows".

**D4, admission hold.** Question (abbreviated): "Your accepted job-admission policy (Sep 4) holds new Update Device jobs for 300 seconds while Google throttles. ... Build the hold now?"
The owner chose the answer "Build it now, with the 'Held by type' job state".

**D5, job-visibility scoping.** The owner chose the answer "Decide when we design platform access".
Interim: the single administrator sees every job. Every job stores the requester and each target's OrgUnit path.

**D6, activity area design.** Question (abbreviated): "Does this activity area design match what you want? ..."
The owner chose the answer "Approve as shown".
Question: "Figma has no frame for this area, and I can only read Figma. Which source should implementation follow?"
The owner chose the answer "Use the approved mockup as the design source, saved with the workflow docs".

## Implementation defaults — 2026-10-16

These defaults are engineering choices, not owner decisions. Change them when the owner asks.
Each item names its sources. Repository paths carry line numbers. `mock:` paths refer to the admin-sdk-mock repository.

1. Entry point: Bulk Actions to the right of Refresh, with one item labeled "Update device". No unbuilt items appear. Sources: `docs/ui/patterns.md:15, 19-20`, `docs/archive/ux/feature-review-notes-2026-09-03.md:26`, `docs/ui/rules.md:76`.
2. The edit step is the Edit step of the bulk action sheet. Its content follows `94:75`. It shows the selected count, Annotated location, and Change mode. The mode label is "Update · Replace the existing value". The D1 answer calls this mode "Replace". Clear value is a separate explicit choice. The draft omits the Organization unit field. Org unit edits are excluded, and UI-05 forbids inert controls. "Review pending devices" shows the selected devices in the Devices grid and keeps the draft. Sources: Figma `94:75`, `docs/archive/ux/feature-review-notes-2026-09-03.md:27-29`, `docs/ui/patterns.md:121`, `docs/ui/rules.md:76`.
3. Update device is disabled with a reason when the selection is empty, the write scope is missing, or the app is offline. Sources: `docs/ui/patterns.md:20, 24`, `docs/ui/rules.md:118`, `docs/workflows/device-browsing.md:118`.
4. Validation: at most 200 characters counted as code points, a non-empty value for Replace, whitespace-only rejected, Clear as a separate explicit choice sent as `null`. Sources: Google ChromeOS device resource page (2025-11-07), Google performance guide (2026-09-03), `mock:src/directory/common.ts:118-135`, `docs/ui/patterns.md:121`, `libs/google-connection/src/lib/devices.ts:102-104`.
5. Google call: `chromeosdevices.patch` with only `annotatedLocation` in the body, sent as PATCH parts through the batch service, at most 250 parts per batch. Sources: Google patch method page (2026-03-10), `libs/google-connection/src/lib/batch.ts:87-100, 160-167`, `docs/superpowers/specs/2026-10-07-google-batch-service-decisions.md:47-56, 74-79`.
6. Preview: the server freezes target IDs from the browsing selection. It shows before and after values, the eligible, unchanged, and excluded counts with reasons, observation age with a stale warning, preparation time, and expiry. Targets paginate. New matches never join. The proposed expiry is 15 minutes. Sources: `docs/ui/patterns.md:77, 90, 170-185, 200`, `docs/portfolio/03-architecture.md:183-197`, `docs/portfolio/04-ux-ui-spec.md:215`.
7. Job size cap: 100,000 devices, the existing `cc.entity_sync_jobs` bound, with an explanation above it. Sources: `deployment/postgres/migrations/016-device-inventory.sql:63`, `docs/portfolio/05-decisions-and-open-questions.md:153`.
8. Confirmation follows `97:57`, including the "I reviewed all ... devices and their final values." checkbox. It blocks duplicate submission. The receipt is the page in `104:74` ("Update job created"), not a snackbar. It offers View job and claims no completed changes. Sources: Figma `97:57`, `104:74`, `docs/ui/patterns.md:176-177`, `docs/ui/rules.md:101`, `docs/portfolio/04-ux-ui-spec.md:205`, `docs/reviews/2026-09-05-figma-experience-review.md:82`.
9. Authorization: add the actions `devices:write` and `devices:bulk-actions` and require both. The bootstrap grants every action to the existing administrator. Sources: `docs/workflows/platform-access.md:641-644, 664-683, 695`, `deployment/postgres/migrations/016-device-inventory.sql:4`, `deployment/bootstrap/application-access.mjs:86-91`, `docs/ui/patterns.md:60-67`.
10. Execution: a new Kestra flow modeled on `entity_sync`. One active write job at a time, with queue behavior. Kestra retries only a dead runner. The Redis admission hold (D4) holds a 300 second TTL, the job service owns the key, and pending held jobs sort smallest first. Sources: `deployment/kestra/entity-sync.yaml:3-6, 17-47`, `docs/portfolio/03-architecture.md:256, 262-299`, `docs/reviews/2026-09-04-job-admission-policy.md:12-24`.
11. Operation records: stable operation ID, device ID and serial, baseline value, requested value, outcome (succeeded, failed, unknown, skipped), Google status and reason, and update time. Sources: `docs/ui/jobs-grid.json:142-160`, `docs/ui/patterns.md:294-296`, `docs/portfolio/03-architecture.md:218, 225-230`.
12. Unknown outcomes stay "unknown" until the worker reads the device back and compares values. Reconcile on the job detail re-reads that device and settles its outcome. It never writes. No unknown operation becomes success. Sources: `docs/ui/patterns.md:257, 299`, `docs/portfolio/03-architecture.md:229, 243`, `docs/portfolio/05-decisions-and-open-questions.md:59`.
13. After success: update the local row from the patch response and publish an `entity-batch` event, so open grids refresh rows in place. The accepted value stays protected from an older list observation until a read matches it. Show its verification state and age. Sources: Google guide (2026-09-03), `worker/src/entity-sync.ts:272-281`, `docs/ui/patterns.md:268-271`, `docs/portfolio/03-architecture.md:389-392`, `docs/portfolio/04-ux-ui-spec.md:312`, `docs/workflows/device-browsing.md:58`.
14. Evidence: job and operation rows are permanent mutation evidence (requester, confirmer, delegated Google subject, targets, values, timestamps, correlation IDs). The frozen manifest and the result file go to the existing artifact store. No Audit records page in this slice. Sources: `docs/portfolio/05-decisions-and-open-questions.md:50, 69`, `docs/portfolio/03-architecture.md:456-464`, `deployment/postgres/migrations/001-foundation.sql:1-18`, `docs/workflow-gaps.md:81`.
15. Job visibility now: the API returns every job to holders of a `jobs-read` action at platform or district scope, plus the jobs the caller requested. Every job stores the requester and each target's OrgUnit path. Sources: `docs/workflow-gaps.md:155`, `docs/ui/jobs-grid.json:65-70, 121`, `docs/ui/patterns.md:283`, `deployment/postgres/migrations/016-device-inventory.sql:66`.
16. Record each Refresh all as a job with its requester. Today the actor clears at finish. Sources: `docs/workflow-gaps.md:154`, `deployment/postgres/migrations/016-device-inventory.sql:19, 152, 342`.
17. Retention: Google-change jobs and their operations stay permanently. Refresh jobs stay 7 days, so the "Created: Last 7 days" view has data. Today refresh jobs leave after one day. Sources: `docs/portfolio/03-architecture.md:462-468`, `docs/ui/jobs-grid.json:186`, `deployment/postgres/migrations/016-device-inventory.sql:439-456`.
18. Status labels: Accepted, Queued, Held, Running, Completed, Completed with errors, Failed, and Needs review. No job shows Cancelled in this slice. Refresh jobs map from `finished_at`, batch counts, and `failure`. Sources: `docs/ui/patterns.md:249-259`, `docs/portfolio/04-ux-ui-spec.md:207`, `docs/portfolio/03-architecture.md:217`, `deployment/postgres/migrations/016-device-inventory.sql:80, 384-398, 439-448`.
19. The Jobs grid and detail follow `jobs-grid.json` and JOB-03/JOB-04, with filters limited to what the server supports. Live updates arrive over SSE. Refresh reads job state only. Sources: `docs/ui/jobs-grid.json:84-129`, `docs/ui/patterns.md:273-305`, `libs/application-contracts/src/lib/entity-cache.ts:86-98`.
20. No Cancel, Pause/Resume, Retry, or downloads in this slice. Show Inspect failure for failed rows and Reconcile for unknown rows. Sources: `docs/ui/patterns.md:299-304`, `docs/workflow-gaps.md:75`.
21. Notifications: the receipt page links to the durable job. The jobs activity area is the persistent summary, from the approved mockup. No inbox. Sources: `docs/workflow-gaps.md:76`, `docs/ui/patterns.md:265-266`, `docs/portfolio/04-ux-ui-spec.md:205`.
22. No second approver. Sources: `docs/workflow-gaps.md:82`.
23. Keep the Devices banner unchanged (D11 of the device browsing workflow). Sources: `docs/workflows/device-browsing.md:108, 153-155`.
24. Keep the expired-selection state. Defer Refresh selected to the next slice. Sources: `docs/workflows/device-browsing.md:141, 213`, `docs/ui/patterns.md:21, 89`.
25. Revalidate the requester's permission version and the connection generation before dispatch. Sources: `docs/portfolio/03-architecture.md:177`, `deployment/postgres/migrations/016-device-inventory.sql:91-92, 136-139`.
26. Keep device details read-only. In-grid editing and the single-device edit from details stay excluded. Sources: `docs/workflows/device-browsing.md:33, 215`, `docs/ui/patterns.md:155-163`.
27. Tests use admin-sdk-mock only: faults on `directory.chromeosdevices.patch`, `remove-scope` for the write scope, `remove-entity` for a removed device, and flush or `searchDelaySeconds` for the list lag. Live write behavior stays "not verified". The Easton fixture has 0 devices, so a live write test needs another tenant and owner authorization. Sources: `mock:docs/guide/configuration.md:309-322`, `mock:docs/guide/testing.md:156-183, 259-280`, `mock:docs/guide/behavior.md:145`, `docs/current-work.md:18, 81`.
28. Terminology: call execution units "batches", as the code does. Keep "access assignment" for platform access. Sources: `docs/workflows/platform-access.md:859`, `deployment/postgres/migrations/016-device-inventory.sql:76-84`, `docs/portfolio/03-architecture.md:203-204`.

Additional engineering defaults:

- The selection footer follows `94:3`. All counts use thousands separators.
- Job IDs: `UPD-` for annotation updates (Figma). `REF-` for inventory refresh jobs (engineering default, no Figma example).
- Job type labels: "Update device annotations" (Figma). "Refresh inventory" for refresh jobs.
- The write-scope message follows the PR #28 pattern, quoted under [Data and access](#data-and-access).
- Depends on PR #33 (the 401 `unauthorized_client` classification). Without it, a missing write scope reads as a credential problem.

## Implementation defaults — 2026-10-19

Engineering choices from card F1, not owner decisions. The sheet replaced the draft route `devices/update` and the preview route `devices/update/previews/:previewId` on 2026-10-20. No route remains for the draft, preview, confirmation, or receipt pages. The busy answer of the write-access check reads "Another check started less than 30 seconds ago. Try again in 30 seconds." The expired-selection state leaves out "View existing jobs" until card F3 adds the Jobs page. Recheck appears in the denied state as well as the unchecked and unavailable states, because the API stores each check result for 300 seconds.

Engineering choices from card F3, not owner decisions. The Jobs page opens without a filter, and the "Created: Last 7 days" chip in the frames is an example window. The refresh-job progress lines are drafted in the frame style, and the owner reviews every drafted string in the F3 pull request. The eye control opens `jobs/:displayId`, which card F4 builds.

## Owner decisions — 2026-10-20

- Bulk actions open in a sheet on the right side, over the grid. The sheet holds every control of the action. A horizontal stepper shows the steps.
- The owner approved the 400 px Material mockup: `docs/ui/designs/2026-10-20-bulk-action-sheet.html`.
- The sheet replaces the draft, preview, confirmation, and receipt pages.

## States

Job status labels: Accepted, Queued, Held, Running, Completed, Completed with errors, Failed, and Needs review.
Held shows "Waiting to start · Google backoff" (`106:109`). No job shows Cancelled in this slice.
The job detail distinguishes Failed from Unknown. Inspect failure serves a failed operation. Reconcile serves an unknown operation.
The Jobs grid implements the loading, no jobs, no matches, unavailable, stale, and offline states (`232:5274`).
The expired-selection state arrives with this action. An expired selection shows as empty and asks for reselection.
A stale observation shows its age in the preview and in the grid.
Inventory refresh jobs appear in the Jobs list as `REF-` jobs. Google-change jobs appear as `UPD-` jobs.
The activity area shows the approved mockup states: Idle, Running with a count, and Needs attention.

## Examples

- The administrator selects six devices in one school. Update device opens the draft page. Change mode "Update · Replace the existing value", value "North lab". Save and preview shows six devices with one field change, the observed value "Science wing", and the expiry. Create update job shows the receipt page "Update job created". The job detail lists six operations. Annotated location shows "North lab" in the grid.
- Without the write scope, Update device is disabled and the message names `admin.directory.device.chromeos`. A grant through the mock control enables the action.
- With an injected fault on `directory.chromeosdevices.patch`, the job detail shows one device Failed with Inspect failure and one Unknown with Reconcile. Reconcile reads the device back and settles its outcome.

## Design

Inspected on 2026-10-16 through the eng-lead Figma notes and captures. The frames sit on [Figma page 09](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=94-2) in the file `lqZx6qpWevsN3AAfWkworl`.

| Node                                                                                                | Shows                                                                                                                                                                                                                                                                                                                                                                                                                           | Use                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| [`94:3`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=94-3)         | Device inventory: "Bulk Actions ▾" right of "Refresh ▾"; selection footer "6 selected · All 6 matching devices" with Select All, Deselect All, Show All Selected; "128,431 in district"                                                                                                                                                                                                                                         | Entry point, selection footer, count format |
| [`94:75`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=94-75)       | Draft page "Update 6 devices" ("Draft changes · Not submitted"): "6 devices · 1 changed field · Not submitted"; fields Annotated location, Change mode "Update · Replace the existing value", Organization unit "Leave unchanged"; notes "Asset tag and notes remain unchanged. Telemetry is read-only." and "To remove an annotation, choose Clear value explicitly."; buttons Reset, Review pending devices, Save and preview | Edit step (a page, not a dialog)            |
| [`97:21`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=97-21)       | Preview "Review 6 device updates" ("Frozen preview · Prepared ..."): "6 devices · 6 field changes · 0 excluded"; "Targets and final values are frozen. New matching devices will not join this job."; "Prepared ... · Expires ... · Preview PV-006"; columns Device, Field, Observed value, Approved value; buttons Edit draft, Continue to confirmation                                                                        | Preview                                     |
| [`97:57`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=97-57)       | Confirmation "Confirm 6 device updates" ("Review the approved scope"): "Update the location on 6 devices"; "Annotated location changes from Science wing to North lab. Other fields remain unchanged."; preview ID, counts, expiry; checkbox "I reviewed all 6 devices and their final values."; buttons Back to preview, Create update job                                                                                     | Confirmation                                |
| [`104:74`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=104-74)     | Receipt page "Update job created" ("Job UPD-006 · Accepted"): "Your job is saved"; "6 devices · 6 annotated-location updates. Google changes have not completed."; "You can leave this page. Return to Jobs to review progress and individual outcomes."; buttons Back to devices, View job; Jobs is the active navigation item                                                                                                 | Receipt                                     |
| [`106:109`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=106-109)   | Jobs list: Job (ID + type), Status, Progress, Scope, Requested by, Created; statuses Running, Held ("Waiting to start · Google backoff"), Queued, Needs review, Completed with errors, Completed, Cancelled; filter "Created: Last 7 days"; Refresh                                                                                                                                                                             | Jobs page                                   |
| [`104:209`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=104-209)   | Job detail "Update device annotations", UPD-006: counts Succeeded/Failed/Unknown/Pending/Skipped/Cancelled; operations Device, Operation, Before, Requested, Outcome, Updated; Inspect failure; Reconcile; Latest activity                                                                                                                                                                                                      | Job detail                                  |
| [`232:5274`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=232-5274) | Index of Jobs states: Open Jobs, Status filters, Needs attention, Running job, Export results, No matches, No jobs, Loading, Offline                                                                                                                                                                                                                                                                                            | Jobs states (frame IDs not cited in docs)   |
| [`106:156`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=106-156)   | Device command target choice: eligible targets, excluded devices with a sentence                                                                                                                                                                                                                                                                                                                                                | Pattern for exclusions in the preview       |
| [`183:4432`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=183-4432) | Index "Entity grids · editing and filters" rev 1.4, incl. "Selection footer" and "Bulk Actions menu"                                                                                                                                                                                                                                                                                                                            | Frame IDs not cited in docs                 |

Further frames from the Figma search: selection footer [`213:4199`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=213-4199) ("Screen / Devices / selected view"), Bulk Actions menu open [`216:4309`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=216-4309), Jobs status filter [`231:5009`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=231-5009), needs attention [`231:4707`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=231-4707), running job detail [`228:4524`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=228-4524), no matches [`234:4950`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=234-4950), no jobs [`234:5142`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=234-5142), loading [`234:5325`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=234-5325), offline [`234:5510`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=234-5510). Capture each frame before implementing its screen.

The jobs activity area has no Figma frame. The approved mockup is its design source: [PNG](../ui/designs/2026-10-16-jobs-activity-area.png) and [HTML](../ui/designs/2026-10-16-jobs-activity-area.html). The owner approved it as shown (D6). No design gaps remain.

## Exclusions

- Prepend and Append. They arrive in the next slice.
- Other fields: org unit, asset ID, user, and notes.
- In-grid editing and the single-device edit from details.
- Device commands, CSV, and Refresh selected.
- Cancel, Retry, Pause/Resume, and downloads.
- A notification inbox beyond the activity area.
- An Audit records page.
- Approval queues.
- Job-visibility scoping beyond the interim rule.
- Live Google writes.

## Completion

Demonstrate on admin-sdk-mock:

1. Without the write scope, Update device is disabled and names the scope. A grant through the mock control enables the action.
2. Select devices with filters and the footer. Open Bulk Actions, then Update device. Enter a location. See the preview with before and after values, counts, exclusions, and expiry.
3. Confirm. The receipt page "Update job created" offers View job. The Jobs page lists the job as Running with progress. The activity area shows it running.
4. With an injected fault on `directory.chromeosdevices.patch`, the job detail shows Failed and Unknown operations. Reconcile settles an unknown operation by reading the device back.
5. With injected throttling, a second write job shows Held until the hold expires, and existing work continues.
6. Clear removes the location from selected devices. Grids update in place. Inventory refreshes appear as `REF-` jobs.

Run lint, tests, and builds for the affected Nx projects. Keep live write behavior marked "not verified".
