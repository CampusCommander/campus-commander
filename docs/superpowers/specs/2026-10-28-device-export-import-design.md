# Technical design addendum: device export and import, CSV slice

Status: proposed. Card `t_b3d42173`. Record: `docs/workflows/batch-update-export-import.md`. The record stays proposed (`record:3`).
Technical design: `docs/research/batch-update-export-import-technical-design.md`. Its sections 5 to 20 set the behavior. This addendum maps that behavior to code.
Mockup: `docs/ui/designs/2026-10-28-device-export-import.html`, its notes, and its state PNGs.
Extends: [job cancel](2026-10-26-job-cancel-design.md), [device-write jobs](2026-10-16-device-write-jobs-design.md), [worker contracts](2026-10-19-device-write-worker-contracts.md), [command jobs](2026-10-21-device-command-jobs-design.md), [Update device fields](2026-10-21-update-device-fields-design.md), [status jobs](2026-10-23-wipe-powerwash-deprovision-design.md), and [in-grid editing](2026-10-23-in-grid-editing-design.md).
Owner direction, 2026-10-19: "We are building a doghouse. We dont need to choose the curtains."

## Owner direction and rulings

On 2026-10-28 the owner approved version 4 of the CSV slice mockup. Owner, in the main chat: "This is perfect. Please go ahead and execute on this." Earlier that day he directed the build: "Go ahead and execute on the import and export work."
On version 3 he removed the file previews: "I dont like having the export and import preview. Just the raw data in the dialog. We can do without that. The important UI is the results of the validation and the results of the execution."
His UI changes of 2026-10-28 sit at `record:234-249`. On 2026-10-28 he signed off the job cancel: "Agreed I sign off on that." (`record:229`).

The approved screens outrank text on composition. The record places Export in a sheet (`record:31`). The technical design places the review on the job page (`td:684`). This design follows the screens.

These items bind the design: D1 to D6, the owner-settled defaults 1 to 13 (`record:255-267`), and the cancel sign-off. The mockup approval and the rulings below bind it too.
The engineering defaults 1 to 17 (`record:272-288`) are the build defaults. This design reopens none of them.

The approval rulings of this card, in its numbering:

1. The build follows the proposed answers 1 to 12 under "Questions for the owner" in the notes.
2. A report page and a result page hold 10 changes. The changes of one device continue on the next page, which repeats the Row and Device cells. The dialog widths and the help pane follow the notes section "Dialog widths and the help pane". The results after Execute follow the notes section "Execution results". The Activity row of the import opens the dialog at the execution results.
3. A long Organization unit path truncates at a `/` boundary and keeps its last segments. No page leaves an empty slot.
4. On 2026-10-28 the owner approved a Failed tab on the execution results. The eng-lead asked: "Failed tab on the execution results: yes or no." Owner: "yes". Section 8 places the tab and proposes the place of an Unknown outcome.

## Conventions

- Paths are relative to the repository root at `5f50d7c`, the base of this card. `ac/` is `libs/application-contracts/src/lib/`, `api/` is `api/src/app/`, and `fe/` is `frontend/src/app/`.
- `record:N` cites the record and `td:N` the technical design. `cancel:N` cites the job cancel design. `ig:N`, `uf:N`, and `wpd:N` cite the in-grid editing, Update device fields, and status job designs.
- `001`, `016`, and `017` name files in `deployment/postgres/migrations/`. `tpl:N` cites `ac/device-edit-template.ts`. `store:N` cites `deployment/storage/index.mjs`. `edge:N` cites `deployment/bootstrap/application-edge.mjs`, and `tls:N` cites `deployment/bootstrap/edge.mjs`.
- `notes` is `docs/ui/designs/2026-10-28-device-export-import-notes.md`. State NN is `docs/ui/designs/2026-10-28-device-export-import-NN-<name>.png`. A parallel docs card stores the mockup, the notes, and the PNGs. These paths hold no file at this base, so this design cites note sections by name.

## Decision summary

1. Two job kinds join `cc.jobs`: `device-export` (`EXP`, action `export-devices`) and `device-import` (`IMP`, action `validate-device-import`).
2. Neither kind takes the write slot or holds an operation. Progress counts rows. A phase block carries the phase name and its counts.
3. Postgres tables hold the export scope, the report, and the plan. The artifact store holds the uploaded file and the export file for 30 days.
4. The upload streams through its own edge branch and a `text/csv` guard exception into a streamed artifact stage.
5. One worker handler per kind runs the whole job under a lease. It reads the cancel request at each batch and every 30 seconds.
6. Execute runs one API transaction. It holds one edit-list preview, the status previews, every confirm, the waits, and the plan links.
7. The status jobs of an import wait in admission for its update job. A cancel of the update job ends them in the same transaction.
8. The execution results read the job detail API (ruling 1). Its operations route gains a number filter. The IMP detail sums every outcome. A Failed tab lists the failed changes (ruling 4).
9. One dialog component on the Devices page serves Export, Reports, and Import. It reuses the device dialog shell, not MatDialog.
10. Eleven backend cards, three frontend cards, and one qa card build the slice. The Google Drive slice gets seams and no card.

## 1. Contracts

| Place                                                        | Change                                                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `jobDisplayIdSchema`, `ac/jobs.ts:19-21`                     | Adds `EXP` and `IMP`. `jobOperationIdSchema` (`ac/jobs.ts:28-32`) stays, because neither kind holds an operation.           |
| `jobActionSchema`, `ac/jobs.ts:60-69`                        | Adds `export-devices` and `validate-device-import` (`td:749-750`), labeled as state 26 shows them.                          |
| `jobFailureSchema`, `ac/jobs.ts:105-108`                     | Adds `storage-unavailable` and `inventory-unavailable` (`td:1038`, `td:1049`).                                              |
| `jobSummarySchema`, `ac/jobs.ts:133-148`                     | Adds `phase` `{ name, done, total }`, `exportSummary` `{ purpose }`, and `importSummary`. Each stays null for another kind. |
| Same schema                                                  | `importSummary` is `{ mode, planState, proposed, rejected, refusal }`. The three blocks feed state 26.                      |
| `jobScopeSchema`, `ac/jobs.ts:125-129`                       | Adds the scope kind `rows` for both kinds. Its count holds the row count (state 26).                                        |
| `jobDetailSchema`, `ac/jobs.ts:264-291`                      | Adds `exportFile` `{ name, sizeBytes, rows, columns, expiresAt }` for states 05 and 08.                                     |
| Same schema                                                  | Adds `importSource` `{ name, sizeBytes, rowsRead, candidateRows, refusalText }` for states 12, 23, and 24.                  |
| Same schema                                                  | Adds `plan` `{ planId, revision, state, expiresAt, changedBy, changedAt }` (`td:667`).                                      |
| Same schema                                                  | Adds `importDisplayId`, `waitsForDisplayId`, and `waitingDisplayIds`, so job pages link both ways (`td:738`).               |
| Same schema                                                  | Adds `planJobs` and `executionCounts` to an IMP job with an executed plan (section 8).                                      |
| `operationsQuerySchema`, `api/jobs/jobs.controller.ts:62-70` | Adds `number`, a repeatable filter of at most 10 operation numbers (section 8).                                             |
| `actionSchema`, `ac/authorization.ts:3-24`                   | Adds `devices:export` at platform and district scope. Its row joins `017:4-8` in the same card.                             |
| New `ac/csv.ts`                                              | An incremental RFC 4180 reader and a record writer. The edit template module holds no I/O (`tpl:16`).                       |
| New `ac/device-export.ts`                                    | The export request and receipt, the ten report field IDs, their labels, and the report cell text.                           |
| New `ac/device-import.ts`                                    | The import receipt, report page, plan, Execute, plan cancel, refusal codes, reason texts, and the Failed tab outcomes.      |

`planState` is `open`, `executed`, `cancelled`, `expired`, or null. The API derives `expired` from the expiry. Route names follow `td:906-918`. Errors follow `td:920-921`.

| Route                                              | Request                                                          | Answer                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `POST /api/devices/exports`                        | `{ gridId, tabId, purpose, format: 'csv', sort, columns }`       | Receipt `{ jobId, displayId, status, rows }`                                  |
| `GET /api/devices/exports/{displayId}/file`        | Nothing                                                          | The CSV file as an attachment                                                 |
| `POST /api/devices/imports?mode=…&name=…`          | The file bytes as `text/csv`                                     | Receipt `{ jobId, displayId, status, mode, name, sizeBytes }`                 |
| `POST /api/devices/imports/{displayId}/revalidate` | An empty object                                                  | The receipt of a new IMP job from the stored file (state 19)                  |
| `GET /api/devices/imports/{displayId}/report`      | `view` (`proposed`, `rejected`, `warnings`, `failed`) and `page` | Counts, refresh facts, the change line, 10 lines at most, the total, the plan |
| `GET /api/devices/imports/{displayId}/rejected`    | Nothing                                                          | The rejected rows as a CSV attachment                                         |
| `POST /api/devices/imports/{displayId}/execute`    | `{ planId, planRevision, typedPhrase }`                          | `{ plan, receipts, conflicts, excluded }`                                     |
| `POST /api/devices/imports/{displayId}/cancel`     | `{ planId, planRevision }`                                       | `{ plan }`                                                                    |

- `columns` lists the report field IDs in grid order. An edit export sends none. `sort` holds the grid sort (`td:341`). Each receipt keeps the shape of `ac/device-updates.ts:159-169`.
- A report line holds the source row, the device, the change or reason, and both values (`td:664-666`). After Execute a proposed line adds `jobDisplayId`, `operationNumber`, and `notRun`.
- The refresh facts are the stale devices read and the oldest observation (`td:635`, state 13).
- The rejected file holds the ten template columns, then Row and Reason (notes question 10). One row carries every reason of its source row.

Export of either purpose needs `devices:read`, `devices:bulk-actions`, and `devices:export` at district scope (`record:102`, `td:1013`). Reports therefore needs `devices:export`.
Import, review, Execute, and the plan cancel need `devices:read`, `devices:write`, and `devices:bulk-actions` (`record:103`). Status codes add a status permission (`record:104-105`).
Execute and the plan cancel accept the requester only (`api/devices/device-updates.ts:586-587`). A download needs job visibility (`017:327-340`), as `td:1023` requires. It also needs `devices:read`.

## 2. Progress phases

The job status carries the phase, as notes question 1 proposes. `cc.jobs` gains `phase`, `phase_done`, and `phase_total`, limited to EXP and IMP by a check.

| Kind  | Phase              | Done and total                              | Screen                                    |
| ----- | ------------------ | ------------------------------------------- | ----------------------------------------- |
| `EXP` | `write-rows`       | Rows written, rows in the scope             | "Write rows", "32 of 48" (state 04)       |
| `EXP` | `prepare-download` | None                                        | "Prepare download" (state 04)             |
| `IMP` | `header-check`     | Rows read, no total                         | "Header check", "Passed" (state 12)       |
| `IMP` | `refresh`          | Stale devices read, stale candidate devices | "6 of 9" (state 12), "4 of 12" (state 24) |
| `IMP` | `compare`          | Candidate rows compared, candidate rows     | "Compare" (state 12)                      |
| `IMP` | `report`           | Lines stored, lines                         | "Report" (state 12)                       |

- Upload ends before the job exists. The dialog shows it done with `sizeBytes` from the receipt (state 12).
- The worker writes the phase once per batch of at most 1,000 rows or devices. Each write records one change (`017:372-391`), so `job-changed` reaches the dialog (`ac/jobs.ts:317-326`).
- A failed job keeps the phase of its refusal (state 23). A cancelled job keeps the phase of its stop (state 24).
- EXP progress counts rows written. IMP progress counts rows with a result. The counters of states 12 and 24 read `importSource.rowsRead` and `importSource.candidateRows`.

## 3. Schema

Each change edits `017` in place. Development data is disposable.

**`cc.jobs`** (`017:18-54`):

- The display ID check (`017:20`) adds `EXP` and `IMP`. The sequences `cc.job_number_exp` and `cc.job_number_imp` join `017:10-14`.
- The kind check (`017:22`) adds `device-export` and `device-import`. The failure check (`017:40-43`) adds the two codes of section 1.
- The scope check (`017:23`) adds `rows` for both kinds, so the devices check (`017:51`) leaves them free.
- `target_count` holds the row count, from 0 to 50,000, or null before the header check.
- `jobs_one_running` and `jobs_admission` (`017:57-60`) name the write kinds only. Both new kinds skip admission and take no write slot.

**New tables.** Each references `cc.jobs(job_id)` with `ON DELETE CASCADE`.

| Table                         | Holds                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `cc.device_export_jobs`       | Purpose, format, report columns, sort, lease, `first_claimed_at`, and the published file facts                         |
| `cc.device_export_targets`    | `(job_id, ordinal, device_id)`: the frozen scope in grid order (`td:338`, `td:341`)                                    |
| `cc.device_import_jobs`       | Mode, source, status permissions at submission, lease, `first_claimed_at`, counts, refusal, plan, and Execute receipts |
| `cc.device_import_changes`    | The plan and the proposed view: row, device, change, values, reason, job, operation, and `not_run_reason`              |
| `cc.device_import_rejections` | Row, Device ID cell, column, submitted value, reason, and the ten template cells on a row's first line                 |
| `cc.device_import_warnings`   | Row (null for the header row), device, and warning                                                                     |

The import counts follow `td:663`, with the stale devices read and the oldest observation (`td:635`). Within a source row, field changes follow template order (`tpl:83`), and the status change comes last (state 13).

**Where the report and the plan live.** The three line tables hold them, not artifacts. This departs from `td:610` and `td:931`. The report pages 10 lines by key (ruling 2). The execution counts join each change with its operation (`017:222-281`).
Execute reads the plan with current values in one query. `cc.purge_jobs` (`017:2856-2857`) keeps write jobs today. It gains a step that deletes these lines 30 days after the job ends. The header, the mode, and the plan state stay with the job (`td:932-933`).

**Change to job and operation.** `cc.link_device_import_jobs` fills `job_id` and `operation_number` of each change row by device ID. A field change maps to the update job, the operation of its device, and the field row (`017:271-281`). The operation keeps the outcome (`017:270`, `uf:23`).
A status change maps to its status job and its device operation (`017:222-261`). A change without an operation or a field row does not run. Its `not_run_reason` reads `changed-after-validation`, `no-change-needed`, `removed`, or a status exclusion (`api/devices/device-actions.ts:99-119`).

**The wait.** `cc.device_update_jobs` (`017:172-205`) gains `import_job_id` and `wait_for_job_id`. Execute sets the wait on each status job of a plan with field changes.
`cc.admit_device_update_job` (`017:699-757`) skips a candidate whose awaited job is not final, and that candidate takes `queued` (`017:750-752`). Final means a finished status, cancelled included.
The terminal `job-changed` of the update job runs admission at once, and the tick repeats it (`api/jobs/job-service.ts:225-238`, `:169-184`).

**The cancel.** `cc.request_job_cancel` (`017:537-654`) gains two branches:

- EXP and IMP end at once before the first claim (`cancel:297`). After it, the function stores the request, and the worker stops (`cancel:298`).
- On an import's update job, it stores the same request on each waiting status job by display ID (`cancel:302-303`). Each ends at once with every operation Cancelled and one audit row.

**New functions.** Each runs as SECURITY DEFINER. Each joins the grant block (`deployment/postgres/index.mjs:273-311`) and the PUBLIC revoke list (`017:2982-3011`).

| Function                                                     | Use                                                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `cc.create_device_export_job`                                | Inserts the running header, the detail row, and the targets as one JSON document (`td:763`)           |
| `cc.claim_device_export_job`, `cc.claim_device_import_job`   | Takes the lease and stamps `first_claimed_at`. A request answers `done`. A live lease answers `busy`. |
| `cc.renew_device_export_job`, `cc.renew_device_import_job`   | Renews the lease and writes the phase and the counts                                                  |
| `cc.finish_device_export_job`, `cc.finish_device_import_job` | Ends the job under the header lock. A stored request deletes the lines and ends Cancelled.            |
| `cc.create_device_import_job`                                | Inserts the running header and the detail row after the upload                                        |
| `cc.store_device_import_lines`                               | Inserts at most 1,000 lines of one table per call                                                     |
| `cc.cancel_device_import_plan`                               | Cancels an open plan. A repeat answers the same plan.                                                 |
| `cc.lock_device_import_plan`, `cc.link_device_import_jobs`   | The two Execute steps of section 7                                                                    |

A cancelled EXP or IMP finish sets `cancelled` to the rows left, at least 1. The shared terminal rule then answers Cancelled (`017:437-445`, `cancel:301`).

**Lock order.** Built writers lock the header first (`cancel:145`). No writer takes the admission lock after a header (`cancel:156`).

| Writer                                 | Lock order                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| EXP and IMP claim, renew, and finish   | Header, then its detail row. The finish then writes line rows.                                                                         |
| `cc.request_job_cancel`, EXP or IMP    | Admission lock (`017:548`), header, detail row, requester, connection                                                                  |
| `cc.request_job_cancel`, import update | Admission lock, update header, its operations, each waiting status header, their operations                                            |
| Admission with the wait                | As built (`017:710`, `:713`). It reads the awaited header without a lock.                                                              |
| Plan cancel                            | Import detail row                                                                                                                      |
| Execute                                | Global access lock (`017:2582`), import detail row, then per preview its row (`017:2726`), its artifact (`017:2788-2789`), and its job |

The requester and connection rows take KEY SHARE last, as built. Execute and the plan cancel lock no job header, and both need a finished IMP job.
`cc.lock_device_import_plan` takes the global access lock before the detail row, as preview creation does (`017:2579-2582`).

## 4. Upload and storage

- **Route.** `POST /api/devices/imports?mode=…&name=…` carries the raw file as `text/csv`. No JSON body wraps it (`td:579`, `record:158`).
- **Edge.** The edge buffers every POST body (`edge:215-246`). A new branch streams this path and counts its bytes. The query passes, because the edge forwards `request.url` (`edge:161`, `edge:172`).
- **Cap.** The branch answers 413 above 335,544,320 bytes (320 MiB). Every other route keeps its cap (`edge:222-237`). The cap follows `td:576`. 50,000 rows at every field limit in ASCII take about 295 MB (`ac/devices.ts:58-59`, `ac/devices.ts:89`, `ac/devices.ts:433-445`).
- **Deadline.** The upload path gets a 10-minute body deadline. Others keep 10 seconds (`tls:26-58`, `tls:205`). HTTP/2 and HTTP/1.1 behave alike (`tls:191-194`).
- Node applies `requestTimeout` to every HTTP/1.1 request of the server (`tls:205`). The edge raises it to 10 minutes. The per-request timer of `tls:26-58` then runs on both protocols, with the deadline of the path.
- **Guard.** `AuthGuard` refuses a body that is not JSON (`api/auth/auth.guard.ts:44-48`). Route metadata lets the upload handler accept `text/csv`. Origin and CSRF checks stay.
- **Store.** `stage` demands the size and the SHA-256 first (`store:191-211`). A streamed variant computes both while it writes. A ready record holds both (`001:5-6`, `001:16`).
- **Retention.** Stage records `retentionUntil` (`store:198`) 30 days ahead for both files (`td:928`, `td:930`). No purge reads `retention_until` today (`001:10`). The storage service adds an hourly purge of each expired artifact that `remove` accepts (`store:374`).
- **Worker access.** The worker imports the store module as the API does (`api/storage/storage.service.ts:54-77`). Its container already mounts the artifacts volume (`docker-compose.yml:531`).
- **Download.** The file route streams the artifact with `content-disposition: attachment`. The edge drops that header (`edge:132-144`) and passes it for the two file routes. The link is the route itself. It works inside the session until the file expires, then answers 410. This maps `td:359` without a token store.

## 5. The export job

**API.** `POST /api/devices/exports` checks the export permissions. An expired selection answers 409, as previews do (`api/devices/device-updates.ts:507-508`). One query resolves the selection terms (`api/devices/device-query.ts:370-406`) in grid order, with the device ID as the tie (`api/devices/device-query.ts:163-169`).
Above 50,000 devices it answers 422 for both purposes (`td:1037`, notes eng-lead answer 2). Otherwise it creates the job and starts the flow.

**Flow.** `deployment/kestra/device-export.yaml` sends one `/dispatch/device-export` request. It retries as `deployment/kestra/device-update.yaml:48-52` does. It queues at 2 runs (`deployment/kestra/entity-sync.yaml:4-6`). Its `errors` block fails the job with `interrupted`, as `deployment/kestra/device-update.yaml:79-84` finishes.

**Worker** (`worker/src/device-export.ts`):

1. Claim, then tick every 30 seconds. The tick renews the lease and calls `cc.job_cancel_requested` (`017:528-532`), as `worker/src/device-update.ts:1221-1230` does.
2. Read the targets in ordinal batches of 1,000 joined with `cc.devices` (`td:345`). Write the batches in ordinal order (`td:346`).
3. Edit purpose: the header is `DEVICE_EDIT_TEMPLATE_HEADERS` (`tpl:148`). Status holds Google's value (`td:350`). Each cell passes `deviceEditEscapeCell` (`tpl:337`).
4. The Checksum cell is `deviceEditRowChecksum` of the unescaped cells (`tpl:461`, `td:358`). Report purpose: stored columns, no Checksum (`td:328`), the same escape (`td:357`).
5. `ac/csv.ts` writes UTF-8 with a byte order mark, commas, CRLF, and RFC 4180 quoting (`td:354-355`) into a streamed stage.
6. Phase `prepare-download` publishes. The finish records name, size, rows, columns, and the expiry. Names follow the notes section "Scenario and data".

- An empty scope writes the header row only (`td:340`). A failed read or write removes the staged file and fails the job (`td:348`, `td:1038`). A true cancel read stops at the next batch, removes the staged file, and ends Cancelled (`cancel:300`).
- **Report columns.** The dialog sends the displayed grid columns in grid order. Columns out of view count too (notes eng-lead answer 2). A new public read on `DeviceGrid` supplies them (`fe/devices/device-grid.ts:304`). It drops the details, checkbox, and Group columns (`fe/devices/device-columns.ts:355-375`, `:99-103`).
- **Report cells.** Each cell holds the grid text of `fe/devices/device-columns.ts:37-60`, with `statusText` and `batteryText` (`fe/devices/device-fields.ts:251`, `:241`). Device contact writes an ISO 8601 UTC time, not the relative time of `fe/devices/device-columns.ts:51-52`. A relative time in a file goes stale.

## 6. The validation job

`deployment/kestra/device-import.yaml` and `/dispatch/device-import` follow section 5. The handler `worker/src/device-import.ts` maps `td:597-611` to two passes:

1. **Person.** The job row holds the requester and the status permissions that the API read at submission (`td:597`).
2. **Pass 1, `header-check`.** `openRead` streams the file (`store:358-365`). A fatal UTF-8 decoder and `ac/csv.ts` apply `td:564-574`, and blank rows count nowhere.
3. `matchDeviceEditHeaders` maps the headers (`tpl:546`). A Sync changes refusal that Sync all rows accepts is the missing Checksum column (`tpl:580`).
4. The file fails above 50,000 data rows (`record:281`) or 16,384 characters in a cell. That cell limit leaves field faults as row rejections.
5. A missing, malformed, or duplicated device ID rejects each affected row (`td:616`). The pattern is that of `api/devices/device-updates.ts:51-52`.
6. In Sync changes, a well-formed Checksum cell (`tpl:481`) equal to the row checksum marks the row unchanged (`td:493-497`). Sync all rows takes every row (`td:499`).
7. **Lookup.** Candidate IDs resolve in `cc.devices` in batches of 1,000. An unknown or removed ID rejects its row (`td:618`). A failed lookup fails the job (`td:633`).
8. **`refresh`.** Stale means read more than 24 hours ago (`ac/entity-cache.ts:16-19`). Only stale candidate devices get a read (`record:257`).
9. Postgres stamps the read time before the Google call (`api/devices/device-fresh-read.ts:128-139`). `deviceBatch` reads up to 1,000 devices (`libs/google-connection/src/lib/devices.ts:718-786`). The store calls follow `api/devices/device-fresh-read.ts:154-175`, run as `worker/src/entity-sync.ts:200-259` runs them (`td:630`). A failed read rejects its rows (`td:631`).
10. **Units.** One `readOrgUnitTree` call serves the job when a candidate row assigns a unit (`libs/google-connection/src/lib/devices.ts:651-716`, `record:283`). Paths compare without case (`tpl:381`). A failed tree read rejects each unit change as "Organization unit check unavailable" (`td:634`).
11. **Access.** A status code without its stored permission rejects its row (`record:108`). No per-device scope exists yet (`td:636`).
12. **Pass 2, `compare`.** The worker parses the file again in batches of 1,000 candidate rows. `deviceEditStatusCellIntent` reads Status (`tpl:246`).
13. Eligibility follows `api/devices/device-actions.ts:99-119` on the fresh status. `deviceEditFieldChange` reads each field cell (`tpl:301`).
14. One invalid cell rejects the row, which keeps every reason (`td:608`). A value equal to the fresh value needs no change (`api/devices/device-updates.ts:126-135`, `td:647`).
15. Warnings follow `td:649-653` and the unknown column text (`tpl:574`). A malformed Checksum cell adds a warning (`td:496`).
16. **`report`.** `cc.store_device_import_lines` writes the lines, and the counts satisfy `td:674`. Proposed changes create a plan that expires 1 hour after the finish (`record:258`).

**Status.** Completed, or Completed with errors when proposed is 0 and rejected is above 0 (notes version 2 answer 5).
A refusal or a lookup or storage fault fails the job. A refusal stores its code and the module text for states 23 and 26.
**State 23 is the server guard** (notes question 7). The browser check stops most refusals (`record:285`). The worker repeats every check, and tests reach state 23 through a direct upload.
**Cancel** follows `cancel:292-304`. A stopped validation keeps no report and no plan, and its stored refresh reads stay (`cancel:299`).

**Failures** follow `td:1032-1070`:

| Failure                                  | Job outcome                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Malformed file, missing column, or limit | Failed with the refusal. No report and no plan (`td:1040-1043`).                    |
| Checksum column missing in Sync changes  | Failed. The dialog names Sync all rows (`td:1041`, state 23).                       |
| Inventory lookup fails                   | Failed with `inventory-unavailable` (`td:1049`)                                     |
| Refresh read or tree read fails          | Validation rejects the affected rows, and the job completes (`td:1048`, `td:1050`). |
| Storage fault                            | Failed with `storage-unavailable`                                                   |
| Lost worker run                          | The flow `errors` block fails the job with `interrupted`.                           |

## 7. Execute

`POST /api/devices/imports/{displayId}/execute` runs these steps:

1. **Recheck.** District `devices:read`, `devices:write`, `devices:bulk-actions`, and each status permission of the plan (`td:1017`). A missing one answers 403 (`td:1064`).
2. **Phrase.** A Deprovision needs `DEPROVISION` (`record:67`), trimmed and compared exactly (`api/devices/device-actions.ts:431-435`, `wpd:72`). A mismatch answers 422 (`td:1065`).
3. **Plan state.** An executed plan answers 200 with its stored receipts (`td:719`, `td:1066`). Cancelled answers 409, and expired answers 410.
4. **Conflicts.** One query reads the field changes with the current inventory values. A value that differs from both its baseline and its request is a conflict (`td:715`, `ig:24`). Its change records `changed-after-validation`.
5. The split comes first. The builder makes a device with one conflict a conflict device, and that preview never confirms (`api/devices/device-updates.ts:265-272`).
6. **Edit list.** `editPreviewTargets` builds one preview from the remaining edits and their baselines (`api/devices/device-updates.ts:216-284`, `td:713`). A field equal to its request stays out as unchanged.
7. The 500-device cap lives in the route parser (`api/devices/device-updates.ts:429-439`, `ac/device-updates.ts:51-61`). The SQL cap is 100,000 (`017:2463-2464`, `td:722-723`).
8. **Status.** `actionTargets` builds one preview per action and reason from a device list (`api/devices/device-actions.ts:121-155`, `td:717`). A read by device ID supplies its row columns (`api/devices/device-actions.ts:127-140`). The built routes take a selection key only (`ac/device-actions.ts:77-101`).
9. **Manifests.** Each manifest goes to `storeJson` first, as the built confirms do (`api/devices/device-updates.ts:782`, `api/devices/device-actions.ts:436`).
10. **One transaction** (`api/database/database.service.ts:63-66`). `cc.lock_device_import_plan` locks the plan and checks state, revision, and expiry (notes question 11).
11. Each preview runs `cc.create_device_update_preview` (`017:2398-2402`) and `cc.confirm_device_update_preview` (`017:2707-2712`), with the phrase for Deprovision (`017:2762-2768`).
12. `cc.link_device_import_jobs` writes the waits, links, and change rows. It marks the plan executed with one change and one audit row.
13. A refusal rolls back every job (`td:718`). After the commit the handler admits (`api/devices/device-updates.controller.ts:196`).

- Another revision answers 409. A plan with no change left answers 409 `nothing-to-run`, and the plan stays open.
- Each SQL call takes its rows as one JSON document (`td:763-764`). A plan of 50,000 rows executes (`td:1174`).
- **Budget.** The SQL of a 50,000-row plan finishes within 20 seconds, under the 45-second edge timeout (`edge:150`). S4 logs the time.
- **Plan cancel.** `POST …/cancel` checks the plan ID and revision and cancels the plan. Nothing runs, and the report stays (`td:710`, state 20).

## 8. The execution results

**Source.** Ruling 1 binds notes question 3. The plan keeps the job and the operation of each change (section 3). The dialog reads the operations with the job detail API of the job page (`api/jobs/jobs.controller.ts:205-220`). No results route exists.

- The page of changes is the proposed view of the report route. After Execute each line names its job and operation, or its not-run reason.
- `editPreviewTargets` orders the devices by device ID (`api/devices/device-updates.ts:235-236`). Confirm numbers the operations in that order (`017:2826`).
- The changes of one page therefore hold scattered operation numbers. The operations route pages by cursor only (`api/jobs/jobs.ts:656-708`, `:688`).
- `operationsQuerySchema` (`api/jobs/jobs.controller.ts:62-70`) gains `number`, a repeatable filter of at most 10 values. It uses `many` (`api/jobs/jobs.controller.ts:34-47`).
- For each job of the page, the dialog reads the operations of its changes in one call. A page needs at most seven calls (`td:755`).
- The rows keep the shapes of `ac/jobs.ts:185-221`. Dispatched and issued read pending (`api/jobs/jobs.ts:367-370`), with both reason fields (`:371-374`).

**IMP detail.** After Execute the IMP job detail adds `planJobs` for the job band. It holds the summary of each plan job (`api/jobs/jobs.ts:215-278`). The detail also adds `executionCounts`, the changes by outcome. One aggregate query over the change rows and their operations fills it (`017:222-281`).
The terms are Succeeded, Failed, Unknown, Skipped, Expired, Cancelled, Pending, and Not run. The dialog shows each term above 0 (notes "Execution results").

**Each change.** A field change shows the outcome of its device operation (`017:270`). A status change shows its own operation.

- A waiting status change reads Pending with "Starts after UPD-001 ends" (state 17). A change with `notRun` shows a drafted Not run chip and reason.
- A cancelled update job shows Cancelled with "Not sent to Google" (`fe/jobs/job-detail-fields.ts:87`, notes question 6).
- Google's refusal of a status change fails with Google's message (`libs/google-connection/src/lib/devices.ts:344-350`, notes question 5). `rowFailureText` shows it (`fe/jobs/job-detail-fields.ts:674-686`).

**Failed tab** (ruling 4). The results table takes the view tabs of the report. They read All changes and Failed, each with its count pill (notes "Polish system").

- All changes counts every change, the total of the count sum. Failed counts the changes whose outcome the tab lists.
- The report route takes `view=failed`. It joins each change with its operation and lists only the outcomes of the tab. It pages as the other views do (ruling 2).
- One constant of `ac/device-import.ts` holds the outcomes of the tab. The failed view and the tab count both read it.
- The tab opens on All changes. A Not run change never joins Failed, because no operation ran it.
- On the Failed tab, each read after an event also repeats the failed view page. A page past the last page moves to the last page.

**Proposal on Unknown.** This design proposes that an Unknown outcome joins the Failed tab. Engineering default 17 raises the Jobs attention dot for a cancelled job with a failed or Unknown operation (`record:288`, `api/jobs/jobs.ts:924`).
The record lets no result show success while an operation reads unknown (`record:73`). An Unknown write needs the same check in Google as a failed one. Its row keeps the Unknown chip, so the tab hides no difference.

The constant holds `failed` until the owner answers. His yes adds `unknown`. Expired stays out, because the ruling and default 17 omit it. The job page filter reads all three (`api/jobs/jobs.ts:684`).

**Live updates.** The dialog opens the job events stream (`api/jobs/jobs.controller.ts:147-193`). A newer revision of a plan job marks the reader dirty (`fe/jobs/job-reader.ts:40-44`).
One read of the IMP detail and the page's operations runs at a time, 250 ms after an event (`fe/jobs/job-reader.ts:11-22`). With every job final, "Finished" and the end time replace the live line (state 17b).
The EXP and IMP workers publish as the write worker does (`worker/src/device-update.ts:1304-1351`). The relay covers a missed publish (`api/jobs/job-service.ts:512-567`).

## 9. The client

**Component.** `fe/devices/device-export-import-dialog.ts`, `.html`, and `.css` serve the three entries. The app uses no MatDialog. It follows the built pattern: an `[open]` input, the scrim, `cdkTrapFocus`, and the shell of `fe/devices/device-dialog.css:29-40` (`fe/devices/device-grid-revert-dialog.html:1-13`).
It mounts beside the sheets (`fe/devices/devices.html:394-416`). Handlers open it as `startUpdate` opens its sheet (`fe/devices/devices.ts:405-409`).

**Widths** follow the notes section "Dialog widths and the help pane". States 02 to 05, 07 to 10, 12, 23, and 24 take 480 px. The docked help makes 1000 px (states 06 and 11).
States 13 to 22 and 17b take 1120 px, the confirmation and the results included. There the 520 px help pane lies over the body (notes question 2).

**Paging.** A page holds 10 lines, and a continued device repeats its Row and Device cells (ruling 2). Only the last page holds fewer (ruling 3). This replaces the rule of the notes section "Execution results" that never splits the changes of one device.
A pure helper beside `fe/devices/device-path-text.ts:1-16` cuts a long path at a `/` boundary and keeps whole trailing segments (ruling 3).

| States             | Reads                                                                                        | Sends                                                  |
| ------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 01                 | The selection spec and the grants (`fe/devices/devices.ts:259-262`)                          | Nothing                                                |
| 02, 03, 07         | The selected count. State 07 adds the displayed grid columns                                 | `POST /api/devices/exports`                            |
| 04, 05, 08         | The job detail (`phase`, `exportFile`) and the job events                                    | A link navigation to the file route                    |
| 06, 11             | The module tables (`tpl:176`, `tpl:192`) and the field limits (`ac/devices.ts:433-445`)      | Nothing                                                |
| 09, 10             | The first 64 KiB of the file through `ac/csv.ts` and `matchDeviceEditHeaders`                | Nothing                                                |
| 12, 23, 24         | The job detail (`phase`, `importSource`) and the job events                                  | The upload. Stop validation cancels the job.           |
| 13 to 15, 18 to 22 | `GET …/report` for each view and page                                                        | `GET …/rejected`, `POST …/cancel`, `POST …/revalidate` |
| 16                 | The report counts and the plan                                                               | `POST …/execute`                                       |
| 17, 17b            | The IMP detail, the proposed or failed view, the operations of each plan job, the job events | Nothing                                                |
| 25                 | The update job detail (`importDisplayId`, `waitingDisplayIds`)                               | `POST /api/jobs/{displayId}/cancel`                    |
| 26                 | `GET /api/jobs` with the summary blocks                                                      | Nothing                                                |

Stop validation sends `POST /api/jobs/{displayId}/cancel`. The app holds Material 22 (`package.json:60`, `:65`). Tabs, progress bars, tooltips, and button toggles enter with this slice. The other treatments of the notes section use plain CSS with the app tokens.

| Treatment (notes "Polish system") | Component                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| Option cards                      | `mat-radio-group` and `mat-radio-button` in CSS cards (`fe/devices/device-action-sheet.ts:24`) |
| Drop zone                         | Plain CSS, a native drop handler, and `mat-stroked-button`                                     |
| Phases                            | The dots of `fe/devices/bulk-action-sheet.css:122-179` and a determinate `mat-progress-bar`    |
| View tabs                         | `mat-tab-nav-bar` with `mat-tab-link`: the report views, then All changes and Failed           |
| Header buttons and cut values     | `mat-icon-button` and `matTooltip`, disabled while a value fits                                |
| Help topics                       | `mat-button-toggle-group`                                                                      |
| Typed phrase                      | `mat-form-field` outline with `matInput` (`fe/devices/device-action-sheet.html:278-300`)       |
| Result cell                       | The outcome cell of `fe/jobs/job-detail.html:266-281` and `fe/jobs/job-detail.css:71-137`      |
| Jobs of the results               | A plain CSS list and a `mat-progress-bar` for the running job                                  |
| Live line                         | The style of `fe/jobs/job-activity.css:207-213`                                                |
| Action bar                        | `mat-button`, `mat-stroked-button`, and `mat-flat-button`, with the primary action last        |

**Built behavior that changes.**

1. The Bulk Actions menu (`fe/devices/devices.html:191-223`) adds a divider, then Export, Reports, and Import (state 01). `BulkActionKey` widens (`fe/devices/devices.ts:62-68`).
2. `actionNotes` (`fe/devices/devices.ts:278-297`) gains three notes. Export and Reports need a selection and `devices:export`. Import needs no selection.
3. The button disables only without `devices:bulk-actions` (`fe/devices/devices.html:177`, `fe/devices/devices.ts:240-242`). Version 2 question 1 reads it as selection-gated. The button rule therefore stays as built.
4. Without a selection the built entries disable through their notes (`fe/devices/device-update-messages.ts:200`). Only Import stays available (notes eng-lead answer 1).
5. An Activity row of the person's own EXP or IMP job opens `/devices?job={displayId}` (`fe/jobs/job-activity.html:55-58`, `:101-104`, `:132-135`). The Devices page then opens the dialog at the job's step, the execution results included (ruling 2). Other rows keep the job page.
6. After the dialog closes, its Bulk Actions entry returns to the running or finished job (notes eng-lead answer 3). A root service holds that job for the browser tab. Done releases it. The entry then starts a new export or import.
7. `progressLines` and `scopeLabel` (`fe/jobs/job-fields.ts:236-240`, `:114-119`) add the lines of state 26. A `rows` scope reads "30 rows", or a dash before the count.
8. `cancelState` offers Cancel pending work on a running EXP or IMP job, as on a refresh (`fe/jobs/job-detail-fields.ts:402-414`).
9. EXP and IMP job pages hide the counters and operations (`fe/jobs/job-detail.html:91-103`, `:106-342`). An EXP page adds the file card (notes version 2 answer 24).
10. An import's update job page names its import and waiting jobs. Its cancel question adds the state 25 sentence (`fe/jobs/job-cancel-dialog.ts:24-28`).
11. `statusText` and `batteryText` (`fe/devices/device-fields.ts:241`, `:251`) move to `ac/device-export.ts`, so the grid and the report share one copy.

## 10. Tests

| ID  | Target and file                                                                                   | Check                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| K1  | `application-contracts:test`: `ac/jobs.test.mjs`, `ac/authorization.test.mjs`                     | EXP and IMP parse. Each block parses. `devices:export` parses at both scopes.                                     |
| K2  | Same target: new `ac/csv.test.mjs`                                                                | RFC 4180 vectors: BOM, CRLF, LF, quotes, multiline cells, a ragged record, an open quote, any chunk split.        |
| K3  | Same target: new `ac/device-import.test.mjs`, `ac/device-export.test.mjs`                         | Each route schema. Report cells match the grid text. Device contact writes ISO 8601.                              |
| S1  | `deployment:postgres-integration`: new `deployment/postgres/device-export-import.integration.mjs` | Kind, display ID, and phase checks. Claim, renew, and finish. A cancel before and after the first claim.          |
| S2  | Same file                                                                                         | Lines page by key. The plan cancels, expires under the lock, and executes once. A repeat returns the jobs.        |
| S3  | Same file, two sessions                                                                           | Status jobs wait for the update job. Its cancel ends them. Admission and the cancel raise no deadlock.            |
| S4  | Same file                                                                                         | A 50,000-row plan executes in one transaction. Its execution counts read in one query. The test logs both times.  |
| S5  | Same file                                                                                         | The purge keeps write jobs and removes the import lines and the export targets after 30 days.                     |
| B1  | `deployment:storage-test`, `deployment:storage-integration`                                       | A streamed stage records size and digest. Over the cap it removes the file. The purge removes expired files.      |
| E1  | `deployment:bootstrap-test`: `application-edge.test.mjs`, `edge-http2.test.mjs`                   | The upload streams on both protocols and answers 413 above the cap. A slow body passes only there.                |
| E2  | Same files                                                                                        | `content-disposition` passes on the file routes only. Each new path passes or answers 404 by phase.               |
| W1  | `worker:test`: new `worker/src/device-export.test.mjs`                                            | Batches write in order. Escape and checksum hold. A failure publishes nothing. A cancel deletes the file.         |
| W2  | `worker:test`: new `worker/src/device-import.test.mjs` with a fake reader and store               | Every check of `td:1124-1151`. Only stale devices get a read. The tree reads once. Counts add up.                 |
| W3  | `worker:test`: new `worker/src/device-import-mock.test.mjs`                                       | The refresh and the tree read against admin-sdk-mock 0.2.0, as `worker/src/device-status-mock.test.mjs:199` does. |
| A1  | `api:test`: new `api/src/app/devices/device-exports.test.mjs`, `device-imports.test.mjs`          | Each route, refusal, and permission. The guard accepts `text/csv` on the upload only. The failed view.            |
| A2  | `api:test`: new `api/src/app/devices/device-import-execute.test.mjs`                              | Conflict split, device-list previews, phrase, expiry, recheck, repeat, and the change links.                      |
| A3  | `api:test`: `api/src/app/jobs/jobs.test.mjs`                                                      | Each summary and detail block. The operations filter by number. `executionCounts` sums each outcome.              |
| C1  | `frontend:test`: dialog specs, `devices.spec.ts`, `job-activity.spec.ts`, `job-fields.spec.ts`    | Each row of the state table. The menu without a selection. Activity routing. State 26 lines. The path cut.        |
| C2  | `frontend-e2e:e2e` (`nx.json:40-42`): new `frontend-e2e/src/device-export-import.spec.ts`         | States 01 to 26 and 17b hold against a mocked API. The Failed tab lists the failed change of state 17b.           |
| Q1  | `api-e2e:client-review-mock` (`api-e2e/project.json:22-41`)                                       | Card XQ1.                                                                                                         |

S1 registers its file in `deployment/postgres/integration.mjs`. No test writes to live Google (`record:110`). Device writes go to admin-sdk-mock only.

## Google Drive seams

- `cc.device_import_jobs.source_type` holds `csv` now. The Drive slice adds a Sheet tab and a Drive CSV with their IDs (`td:554`).
- The handler reads stored text. The Drive slice stores what it read first (`td:590`), as CSV text through `ac/csv.ts` (`td:586`, `td:589`). Both passes stay unchanged.
- `POST /api/devices/imports/drive` (`td:911`) creates the same job and receipt.
- `cc.device_export_jobs.format` adds `sheet`. The row stream feeds a `RAW` Sheet writer (`td:364`), and `exportFile` gains a link (`td:909`).
- A Sheet export records the start of its Sheet write. A cancel then answers `nothing-to-stop` (`record:286`, `cancel:300`).
- States 02 and 09 draw Google Sheet and Google Drive disabled with a note (`td:368`). The capability, Picker, and edge rules stay there (`td:944-953`, `td:986-988`).

## Risks

1. Execute of 50,000 rows holds about 250,000 edits in API memory and one transaction. S4 measures it. A slower database needs a background Execute.
2. A file of non-ASCII cells at every field limit exceeds 320 MiB. The refusal names the limit.
3. One import of 50,000 rows stores up to about 300,000 line rows until the purge. Each results refresh sums them, and S4 times that query.
4. A second Execute that races the first leaves its manifests unreferenced. They carry no expiry, so the purge keeps them.
5. The worker reads the unit tree with the `school-ou-references` scope (`libs/google-connection/src/lib/devices.ts:664-666`). Without it, validation rejects every unit change.
6. Live Google writes stay unverified. The test domain holds no ChromeOS device (`record:110`).

## Card plan

| ID  | Title                                                                 | Profile  | Depends on |
| --- | --------------------------------------------------------------------- | -------- | ---------- |
| XB1 | Contracts: EXP and IMP, the blocks, `devices:export`, and CSV         | backend  | none       |
| XB2 | Schema: EXP and IMP kinds, the export tables, the claim functions     | backend  | XB1        |
| XB3 | Schema: report, plan, Execute steps, the wait, the cascade            | backend  | XB2        |
| XB4 | Artifact store: streamed stage, retention, and purge                  | backend  | none       |
| XB5 | Edge: streamed upload, file downloads, and the new paths              | backend  | XB1        |
| XB6 | Worker: the export job and its flow                                   | backend  | XB2, XB4   |
| XB7 | Worker: the validation job and its flow                               | backend  | XB3, XB6   |
| XB8 | API: export routes                                                    | backend  | XB5, XB6   |
| XB9 | API: upload, report, rejected rows, plan cancel, and revalidate       | backend  | XB7, XB8   |
| XBA | API: Execute and the change links                                     | backend  | XB9        |
| XBB | Jobs API: phases, blocks, execution counts, and the operations filter | backend  | XB3        |
| XF1 | Devices dialog: Bulk Actions, Export, Reports, and help               | frontend | XB8, XBB   |
| XF2 | Devices dialog: Import, validation, and the report                    | frontend | XF1, XB9   |
| XF3 | Devices dialog: Execute, the results, the Failed tab, and the cancel  | frontend | XF2, XBA   |
| XQ1 | Rehearse the CSV slice on admin-sdk-mock                              | qa       | XF3        |

IDs are local to this design. A card that changes a contract updates every consumer, the `frontend-e2e` and `api-e2e` fixtures included.

**XB1.** Scope: section 1 in `ac/jobs.ts`, `ac/authorization.ts`, the three new modules, their tests, and the row at `017:4-8`. It fixes each consumer of the wider enums, for example `actionKinds` (`api/jobs/jobs.ts:167-176`).
Until XBB, each block answers null. Acceptance: K1 to K3 pass. `api:test`, `worker:test`, `frontend:build`, and `frontend:test` pass. A session with a `devices:export` grant parses.

**XB2.** Scope: the `cc.jobs` changes, the export tables, the EXP and IMP cancel branches, and the lease functions. It also owns their grants and S1. Acceptance: S1 passes on a fresh database. A cancel before the first claim ends an EXP job at once.

**XB3.** Scope: the import tables, the line and plan functions, the Execute steps, the wait, and the cascade cancel. It also owns the purge and S2 to S5. Acceptance: S2 to S5 pass on a fresh database. S4 logs the time of a 50,000-row plan.

**XB4.** Scope: section 4 in `store`, `api/storage/storage.service.ts:24-34`, the hourly purge, and B1. Acceptance: B1 passes. `storeJson` keeps its integrity check.

**XB5.** Scope: section 4 in `edge` and `tls`, with E1 and E2. The new paths and `jobDisplayIdPath` (`edge:74`) accept `EXP` and `IMP`.
Acceptance: E1 and E2 pass. Every other route keeps its cap and its 10-second deadline.

**XB6.** Scope: the worker part of section 5, `deployment/kestra/device-export.yaml`, the dispatch route, the store client, and W1.
Acceptance: W1 and `deployment:kestra-test` pass. A cancelled export leaves no staged file.

**XB7.** Scope: section 6, a shared read from `worker/src/entity-sync.ts:200-259`, `deployment/kestra/device-import.yaml`, W2, and W3.
Acceptance: W2 and W3 pass. Every refresh read keeps its stamp before the Google call.

**XB8.** Scope: the API part of section 5 in new `api/devices/device-exports.ts`, its controller, and the file route.
It also owns the flow start and the export rows of A1. Acceptance: those rows pass. A download of another customer's file answers 404.

**XB9.** Scope: the upload, the report and its four views, the rejected rows, the plan cancel, and revalidate.
It also owns the guard exception, the flow start, and the import rows of A1. Acceptance: those rows pass. The upload never buffers the whole file. The failed view lists only the outcomes of its constant.

**XBA.** Scope: section 7 in new `api/devices/device-import-execute.ts`, the change links, the not-run reasons, and A2.
Acceptance: A2 passes. A conflict or an ineligible device never reaches a job. A repeated Execute creates no job.

**XBB.** Scope: `phase`, the summary and detail blocks, `planJobs`, and `executionCounts` in `api/jobs/jobs.ts:215-278`. It also owns the operations filter of section 8 and A3.
Acceptance: A3 passes. It proves the data of each state 26 row and the counts of state 17b. The jobs list filters both new actions.

**XF1.** Scope: section 9 behaviors 1 to 9 and 11, states 01 to 08, the help pane, C1, and C2. It routes the Activity row to the dialog. XF2 and XF3 add their steps.
Drafted strings: failed, cancelled, and expired export states, running and failed EXP grid lines, and the EXP cancel question.
Acceptance: on a mocked API the dialog matches states 01 to 08. Without a selection, the menu enables only Import.

**XF2.** Scope: states 09 to 15 and 18 to 24, the upload, Stop validation, IMP grid lines, C1, and C2.
Drafted strings: the reason texts of `ac/device-import.ts`, the grid refusal lines, and the upload errors. Also drafted: the IMP cancel question and the grid line of an open plan.
Acceptance: the dialog matches each state. A cancel before the receipt cancels the job when its ID arrives (`td:760`). Expired shows at the expiry.

**XF3.** Scope: states 16, 17, 17b, and 25, built behavior 10, the live results, the Failed tab, C1, and C2.
Drafted strings: the Not run chip, each not-run reason, and the empty Failed view. Also drafted: the Execute refusals for a permission, a plan revision, and nothing to run.
Acceptance: the dialog matches states 16, 17, and 17b. The Activity row of the import opens the results. Each page holds 10 lines. In state 17b, Failed reads 1 and lists the Re-enable of `04XTBHJ`.

**XQ1.** Scope: the completion steps of `record:370-378` on `api-e2e:client-review-mock` through the import dialog, with screenshots.

- Export for editing. Import the unedited file with Sync changes: every row reads unchanged, and Execute stays disabled.
- Import an edited file with a field, a clear, a status code, and a mistyped unit. Add an invalid cell and a wrong reason code.
- A stale device refreshes first. Cancel the plan. Stop a running validation of a large file.
- Import again and Execute with the typed phrase. Rejected rows never run. Import a saved sheet with Sync all rows twice.
- Create a report. Read the result of each change in the dialog and through the Activity row. A partial job shows each outcome.
- Make one device write fail through an admin-sdk-mock fault. Open the Failed tab: it lists that change, and its count matches.
- Acceptance: each step shows the actual outcome. Lint, tests, and builds of the affected projects pass. Live Google writes stay not verified (`record:110`).

**Shared files.** Each shared file sits on one dependency path.

| File                                                 | Cards, in merge order     |
| ---------------------------------------------------- | ------------------------- |
| `deployment/postgres/migrations/017-jobs.sql`        | XB1 (`017:4-8`), XB2, XB3 |
| `deployment/postgres/index.mjs`                      | XB2, XB3                  |
| `api/src/app/jobs/jobs.ts`, `jobs.test.mjs`          | XB1, XBB                  |
| `api/src/app/orchestration/orchestration.service.ts` | XB8, XB9                  |
| `api/src/app/devices/devices.module.ts`              | XB8, XB9, XBA             |
| `api/src/app/devices/device-imports.controller.ts`   | XB9, XBA                  |
| `worker/src/main.ts`, `worker/src/dispatch.ts`       | XB6, XB7                  |
| `fe/devices/device-export-import-dialog.*`           | XF1, XF2, XF3             |
| `fe/jobs/job-fields.ts`, `fe/jobs/job-detail.html`   | XF1, XF2, XF3             |
| `frontend-e2e/src/device-export-import.spec.ts`      | XF1, XF2, XF3             |

Every other file belongs to one card. XB4 owns `store`, XB5 owns `edge` and `tls`, and XB7 owns `worker/src/entity-sync.ts`.
XF1 owns `fe/devices/devices.html` and `devices.ts`. XB4 and XB5 run beside the schema cards, and XBB runs beside XB9.
