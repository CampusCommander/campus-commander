# Technical design addendum: device command and status jobs (step 5, first build)

Status: proposed on 2026-10-21 for review. Card `t_149a0af1`.
Record: `docs/workflows/device-commands.md`, owner-confirmed on 2026-10-21 (PR #72).
Extends: [the step 4 design](2026-10-16-device-write-jobs-design.md) and [its worker contracts](2026-10-19-device-write-worker-contracts.md).
Owner direction, 2026-10-19: "We are building a doghouse. We dont need to choose the curtains."

## Conventions

- Paths are relative to the repository root at `b1baa52`.
- `record:N` cites `docs/workflows/device-commands.md` at PR #72. `step4:N` cites `2026-10-16-device-write-jobs-design.md`.
- `mock:` names `node_modules/@campuscommander/admin-sdk-mock/dist/src/`, version 0.2.0 (`package.json:3` of the package).
- `findings:N` cites `~/engineering-team/workspace/device-commands-record/findings.md`. Its lines hold at `b1baa52`, because `git diff 9f79e09 b1baa52` is empty.
- Card `t_d703391b` (approved, branch `codex/device-status-field`) adds `status` to device records, filters, and sort. This design reads that field. It does not repeat that work.

## Decision summary

1. Two new job kinds reuse the step 4 tables, functions, hold, admission, Kestra flow, and publication path.
2. One `action` column separates annotated-location updates, Reboot, Disable, and Re-enable in the shared write tables.
3. A Reboot job issues its commands under the write slot. It then moves to `awaiting-devices`, and the slot frees.
4. The job service tick starts a poll flow for due commands. The job ends when every command settles.
5. A status job writes per device. The step 4 overlay and publication rules update the status cache.
6. Two new actions, `devices:commands` and `devices:status`, each require `devices:bulk-actions`.

## 1. Job model

| Job kind         | Actions               | Display ID | Sequence            | Job action                            | Label                              |
| ---------------- | --------------------- | ---------- | ------------------- | ------------------------------------- | ---------------------------------- |
| `device-update`  | `annotated-location`  | `UPD-nnn`  | `cc.job_number_upd` | `update-device-annotations`           | Update device annotations          |
| `device-command` | `reboot`              | `CMD-nnn`  | `cc.job_number_cmd` | `reboot-devices`                      | Reboot devices                     |
| `device-status`  | `disable`, `reenable` | `STS-nnn`  | `cc.job_number_sts` | `disable-devices`, `reenable-devices` | Disable devices, Re-enable devices |

- Prefixes come from record default 2 (`record:88`). The labels are engineering copy. The mockup can replace them.
- Sources: display ID check `017-jobs.sql:14`, sequences `:7-9`, `jobDisplayIdSchema` (`libs/application-contracts/src/lib/jobs.ts:15`), job actions (`jobs.ts:33-41`).
- Operation IDs follow their job ID, for example `CMD-021-4`. The three operation ID patterns widen to `^(UPD|CMD|STS)-\d{3,}-\d+$` (`jobs.ts:114, 133, 147`).
- Room for the next build: Wipe and Powerwash join `device-command`. Deprovision joins `device-status`. Each adds one `action` value and its permission.

**Job statuses.** The eight statuses stay (`017-jobs.sql:18-19`, `jobs.ts:20-31`). One status joins them: `awaiting-devices`.

- A command job enters `awaiting-devices` when issuing ends and an `issued` operation remains.
- `jobs_one_running` covers only `running` (`017-jobs.sql:42-43`). The transition therefore frees the write slot (`record:89`).
- The activity area lists `awaiting-devices` jobs in its `running` section (`jobs.ts:184-188`). The `waiting` section keeps its meaning: jobs before admission.
- The Figma job status "Expired" (`111:352`) does not become a job status. Expired is an operation outcome.

**Terminal status.** The step 4 rule (`step4:1146-1151`) counts `expired` beside `failed`.

| Status                  | Rule                                                                 |
| ----------------------- | -------------------------------------------------------------------- |
| `needs-review`          | `unknown > 0`                                                        |
| `completed`             | `succeeded = target_count`                                           |
| `completed-with-errors` | `unknown = 0`, `succeeded > 0`, and `failed + expired + skipped > 0` |
| `failed`                | `unknown = 0` and `succeeded = 0`                                    |

**Command operation states.** Status operations keep the step 4 states unchanged (`step4:1003-1019`). Command operations map as follows.

| Card state       | Stored `status`           | Stored `command_state` | API `outcome` | API `commandState` | Google evidence                                                                       |
| ---------------- | ------------------------- | ---------------------- | ------------- | ------------------ | ------------------------------------------------------------------------------------- |
| (before issue)   | `pending` or `dispatched` | null                   | `pending`     | null               | None. The step 4 rule shows `dispatched` as `pending` (`jobs.ts:99-106`).             |
| pending delivery | `issued`                  | `pending-delivery`     | `pending`     | `pending-delivery` | A 200 issue answer with `commandId` (`mock:directory/commands.js:117`), or `PENDING`. |
| sent             | `issued`                  | `sent`                 | `pending`     | `sent`             | `SENT_TO_CLIENT` (`mock:directory/command-effects.js:14-15`).                         |
| acknowledged     | `issued`                  | `acknowledged`         | `pending`     | `acknowledged`     | `ACKED_BY_CLIENT` (`command-effects.js:12-13`).                                       |
| succeeded        | `succeeded`               | last observed          | `succeeded`   | null               | `EXECUTED_BY_CLIENT` with result `SUCCESS` (`commands.js:144-154`).                   |
| failed           | `failed`                  | last observed          | `failed`      | null               | An issue refusal, or an execution result other than `SUCCESS`.                        |
| expired          | `expired`                 | last observed          | `expired`     | null               | `EXPIRED` (`command-effects.js:10-11`).                                               |
| unknown          | `unknown`                 | last observed          | `unknown`     | null               | A lost issue answer, or no terminal observation before the deadline (section 4).      |

The record lists six display states (`record:43`). Google reports `SENT_TO_CLIENT` between them, so the API carries `sent`. The mockup decides its label.

**Schema changes.** Each change edits a migration in place. Development data is disposable.

- `017-jobs.sql:4-5` inserts `devices:commands` and `devices:status`.
- `:7-9` adds `cc.job_number_cmd` and `cc.job_number_sts`. `:14` widens the display ID check. `:16` adds both kinds to the kind check.
- `:18-19` adds `awaiting-devices`. `:24-27` adds the counter `expired integer NOT NULL DEFAULT 0`.
- `:42-45`: `jobs_one_running` and `jobs_admission` cover `kind IN ('device-update','device-command','device-status')`.
- `:62-84` previews and `:103-132` job details gain `action text NOT NULL` with the four values. `field` and `mode` become null for the new actions.
  A check ties them: `(action='annotated-location')=(field IS NOT NULL AND mode IS NOT NULL)`. The value check of `:83` applies to annotated-location only.
- `:87-100` preview targets: `observed_value` holds the cached status for the new actions. Section 2 names the new exclusion reasons.
- `:103-132` job details gain `poll_execution_id text` and `poll_lease_expires_at timestamptz`, the lease of one poll flow per job.
- `:149-175` operations: the status check of `:158` adds `issued` and `expired`. New null columns:
  `command_id text CHECK(command_id ~ '^[0-9]{1,20}$')`, `command_state` with the three values above, `command_expires_at`, `command_executed_at`,
  `poll_after`, `poll_deadline_at`, `poll_attempt`, and `poll_lease_expires_at`. A check requires `command_id` and `poll_after` for `issued`.
  A partial index on `(job_id, poll_after) WHERE status='issued'` serves the poll claim.
- `:178-189` overlays: the field check adds `status`.
- `016-device-inventory.sql`: `cc.devices` gains `status_observed_at`, the current-value stamp of `status` (pattern `step4:437-456`).
  `cc.upsert_devices` applies the overlay rule to `status` (`016-device-inventory.sql:389-392, 408-409`). Card `t_d703391b` also edits 016, so card B1 waits for its merge.
- `018-device-write-access.sql:1-11`: the write-access read and check accept any of `devices:write`, `devices:commands`, and `devices:status`.
- Functions that take the action: the ID format (`017-jobs.sql:215-218`), `cc.write_capable` (`:394-400`), the stop reason (`:405-414`),
  admission (`:426-484`), preview (`:1530-1613`), confirm (`:1665-1771`), the batch claim (`:756-761`), finish, and counters.

The table names keep the `device_update_` prefix. They hold every device write job. A rename touches every 017 function for no behavior.

## 2. Preview and eligibility

- Selection resolution, its answers, the 15-minute expiry, `PV-` IDs, and paged targets stay unchanged (`api/src/app/devices/device-updates.ts:36-37, 192-208`, `jobs.ts:17`).
- The preview reads `cc.devices.status` (`016-device-inventory.sql:44`) at preparation. It records the action in `action`.

| Action     | Eligible status | Exclusion reasons                                           |
| ---------- | --------------- | ----------------------------------------------------------- |
| `reboot`   | `ACTIVE`        | `device-disabled`, `device-deprovisioned`, `status-unknown` |
| `disable`  | `ACTIVE`        | `device-disabled`, `device-deprovisioned`, `status-unknown` |
| `reenable` | `DISABLED`      | `device-active`, `device-deprovisioned`, `status-unknown`   |

- Eligibility follows `record:26`. The step 4 reasons `removed` and `invalid-device-id` stay (`device-updates.ts:78-111`).
- `status-unknown` covers null and any other Google value. Card `t_d703391b` passes such values through.
- These actions use no `unchanged` disposition, and `unchanged` stays 0. A disabled device in a Disable selection is excluded as `device-disabled`.
  DEVICE-01 requires the reasons: "Explain excluded targets and their reasons." (`docs/ui/patterns.md:209`).
- A target stores the cached status in `observed_value` and its stamp in `observed_at` (`017-jobs.sql:93-94`).
- Digest: SHA-256 over `action`, `actionVersion`, the Google action (`REBOOT`, `DISABLE`, or `REENABLE`), and each eligible device ID with its baseline status.
  The step 4 digest is the pattern (`device-updates.ts:117-133`). Reboot carries no payload, per record default 5 (`record:91`).
- Zero eligible targets: the sheet shows the no-eligible state (`record:35-36, 154`). Confirm answers 422 `nothing-to-update` (`017-jobs.sql:1721-1725`). No job starts.
- A stale cache stays safe, because Google checks the status again.
  issueCommand refuses a device that is not active with HTTP 400 `failedPrecondition` (`mock:directory/commands.js:104-105`).
  batchChangeStatus refuses per device with code 9 (`mock:directory/device-writes.js:152-159`). Both operations settle `failed` with Google's message.

## 3. Google calls

**Transport.** Every call travels as a part of `POST https://www.googleapis.com/batch/admin/directory_v1`.
The outer allowlist admits that endpoint today (`libs/google-connection/src/lib/provider.ts:239-240`), so it needs no new URL.

**Allowlist change.** Parts pass a syntax check only (`libs/google-connection/src/lib/batch.ts:172, 179`).
`provider.ts` gains `googlePartAllowed(method, path)` beside `googleRequestAllowed` (`provider.ts:229-246`). `validateRequests` (`batch.ts:179`) refuses any part that it rejects.
It admits each part shape that the repository builds today, plus three new shapes. The customer pattern repeats `provider.ts:236`.

- `POST /admin/directory/v1/customer/{customer}/devices/chromeos/{deviceId}:issueCommand`
- `GET /admin/directory/v1/customer/{customer}/devices/chromeos/{deviceId}/commands/{commandId}`, with a digits-only command ID
- `POST /admin/directory/v1/customer/{customer}/devices/chromeos:batchChangeStatus`

Mock routes: `mock:routes.js:66-68`. The builders `issueDeviceCommands`, `deviceCommands`, and `changeDeviceStatus` join `patchAnnotatedLocations` (`libs/google-connection/src/lib/devices.ts:445-489`).

**Tokens.** issueCommand and batchChangeStatus use the `device-changes` scope (`libs/application-contracts/src/lib/google-capabilities.ts:75`).
getCommand uses the read-only inventory token, as read-back does (`step4:1034`). A later write-scope removal therefore stops no poll.

**Retry rules.**

| Call              | Quota retries              | Transient retries          | Lost answer                      |
| ----------------- | -------------------------- | -------------------------- | -------------------------------- |
| issueCommand      | 0                          | 0                          | `unknown`, reason `ambiguous`    |
| batchChangeStatus | default 25 (`batch.ts:94`) | 0 (`batch.ts:894-898`)     | `unknown`, then step 4 read-back |
| getCommand        | default                    | default 10 (`batch.ts:95`) | the operation keeps its state    |

- An issueCommand repeat sends a second Reboot. The batch service retries quota answers of a POST today (`batch.ts:751-755, 890-898`).
  The issue run therefore sets `maxQuotaRetries` to 0. A final quota answer fails the operation with reason `quota` (`step4:1310-1343`).
- A repeated status change has no second effect (`device-writes.js:152-159`). Status parts therefore keep quota retries.
- Issue answers: a 2xx with a digit `commandId` gives `issued`. A 2xx without one gives `unknown` with `invalid-response`.
  A 404 or another refusal gives `failed` with `google_status` and `google_reason` (`batch.ts:417-436`, `worker/src/device-update.ts:417-576`).
- Two other cases give `unknown` with `ambiguous`. Neither repeats the POST (`batch.ts:730-744, 799-805, 894-899`).
  A transient refusal, such as a 503 part, does not tell whether Google stored the command.
  A lost answer leaves a sent POST without a reply, and Google can hold an accepted command.
  Its causes are the 10 s request timeout (`provider.ts:262`), another transport failure, and a request still in flight when the run ends.

**Per-device results.** A batchChangeStatus part answers 200 even when every device fails (`device-writes.js:171-175`).
`classifyStatus` therefore reports success (`batch.ts:422`). A new parser `statusResults(body, deviceIds)` reads `changeChromeOsDeviceStatusResults`.

| Element for a requested ID        | Outcome     | `outcome_reason`   | `google_reason` |
| --------------------------------- | ----------- | ------------------ | --------------- |
| `response`                        | `succeeded` | null               | null            |
| `error.code` 5                    | `failed`    | `not-found`        | Google message  |
| `error.code` 9                    | `failed`    | `status-conflict`  | Google message  |
| another `error.code`              | `failed`    | `rejected`         | Google message  |
| missing, repeated, or unparseable | `unknown`   | `invalid-response` | null            |

`google_status` stays null. The element code is a `google.rpc.Code`, not an HTTP status (`device-writes.js:120-122`).

**Capability evidence.** `device-changes` keeps its scope and its health check (`google-capabilities.ts:70-80`).
Its `evidence` names the four methods and keeps "admin-sdk-mock v0.2.0 only". `qualified` stays false (`:74`).
DEVICE-01 requires live evidence before release (`docs/ui/patterns.md:198`). Live device writes need owner authorization (`record:63`).

## 4. Command lifecycle

1. **Admission.** A confirmed command job uses the existing hold and admission (`api/src/app/jobs/job-service.ts:21-23`, `017-jobs.sql:426-484`).
   The hold key keeps its name. It is the write slot of the customer for every write kind.
2. **Issue.** Kestra flow `device_update` runs unchanged (`deployment/kestra/device-update.yaml:18-78`).
   The batch route (`worker/src/dispatch.ts:271`) reads the action from the claim. It sends one POST part per operation. The batch size stays 250 (`017-jobs.sql:112`).
3. **Issue settlement.** An accepted operation becomes `issued` with `command_id` and `command_state` `pending-delivery`.
   `poll_after` is the settlement time plus 15 s. `poll_deadline_at` is the issue time plus 7 days.
4. **Finish.** The finish route (`dispatch.ts:306`) runs steps 1 to 4 of `step4:1135-1144`. A command job skips read-back step 5.
   With an `issued` operation left, the job moves to `awaiting-devices`, and `finished_at` stays null.
   The job service then cleans the hold and runs admission, as after a terminal job (`step4:1152-1153`).
5. **Poll start.** Each job service tick runs every 5 s (`job-service.ts:13-14, 156`). It calls `cc.due_device_command_polls(p_customer)`.
   That function returns at most 10 `awaiting-devices` jobs with a due operation and no live poll lease. It sets a 10-minute lease on each.
   The tick starts flow `device_command_poll` through a new `startDeviceCommandPoll` (pattern `api/src/app/orchestration/orchestration.service.ts:171`).
6. **Poll run.** The worker route `/dispatch/device-command-poll` claims at most 250 due `issued` operations under a 120 s lease.
   It sends GET parts and settles the answers. It repeats while due operations remain, then releases the job lease.
7. **Schedule.** After each non-terminal observation, the next poll waits 15 s, 30 s, 60 s, 2 min, 5 min, 15 min, then 60 min each time.
   One poll lands at `command_expires_at` plus 60 s. The mock executes an online device within 60 s (`commands.js:110-116`).
   An offline device stays `PENDING` until expiry (`findings:97`). Over 5 days, that device costs 126 GET parts.
8. **Expiry.** The first successful poll stores `commandExpireTime` (`commands.js:142`). `poll_deadline_at` becomes that time plus 24 hours.
   The job detail shows the stored expiry: "Use the expiry returned by the provider." (`docs/ui/patterns.md:218`). The 7-day cap applies only before that observation.
9. **Poll settlement.**

| getCommand answer                              | Settlement                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `PENDING`, `SENT_TO_CLIENT`, `ACKED_BY_CLIENT` | Stays `issued`. `command_state` follows the answer.                              |
| `EXECUTED_BY_CLIENT`, result `SUCCESS`         | `succeeded`, with `command_executed_at`.                                         |
| `EXECUTED_BY_CLIENT`, another result           | `failed`, reason `command-failed`, `google_reason` from `errorMessage`.          |
| `EXECUTED_BY_CLIENT` without `commandResult`   | Stays `issued` as `acknowledged`. DEVICE-02 forbids success (`patterns.md:216`). |
| `EXPIRED`                                      | `expired`.                                                                       |
| 404                                            | `unknown`, reason `command-not-found` (`commands.js:126-132`).                   |
| Another state value                            | `unknown`, reason `unrecognized-state`.                                          |
| Quota, transient, auth, or transport failure   | No change. The next scheduled poll repeats the GET.                              |
| No terminal answer by `poll_deadline_at`       | `unknown`, reason `not-observed`.                                                |

10. **Completion.** The settlement that leaves no `issued` operation derives the terminal status of section 1 in the same transaction.
    It sets `finished_at` and records the change through `cc.record_job_change` (`step4:1152`).
11. **Unknown.** Record default 4 applies: no Reconcile and no repeat (`record:90`). The job ends as Needs review (`record:155`).
    The reconcile route (`api/src/app/jobs/jobs.controller.ts:220-244`) answers 409 `reconcile-unsupported` for a command operation.
12. **Stops.** A permission or connection change skips pending issues (`017-jobs.sql:405-414, 730-747`). Issued commands keep their polls, because Google holds them.
    Polls without a usable connection fail. Their operations settle `unknown` with `not-observed` at the deadline.

## 5. Status changes

- **Execution.** Status jobs use the same flow and batch route. A claim of up to 250 operations becomes parts of up to 50 device IDs, in operation order.
  Google accepts 1 to 50 IDs (`device-writes.js:8, 18-26`). The actions are `CHANGE_CHROME_OS_DEVICE_STATUS_ACTION_DISABLE` and `_REENABLE` (`device-writes.js:94-102`).
- **Part outcome.** A 2xx part settles each operation through `statusResults`. A failed part settles all its operations by the step 4 rules (`step4:1310-1343`).
- **Read-back.** An `unknown` status operation takes the step 4 read-back (`step4:1032-1053`). The compare reads `status` instead of `annotatedLocation` (`worker/src/device-update.ts:1666-1670`).
  The requested status gives `succeeded`. Another status gives `failed` with `value-differs`. A 404 gives `failed` with `not-found`.
- **Reconcile.** An `unknown` status operation keeps the step 4 Reconcile route (`jobs.controller.ts:220-244`).
- **Cache.** A succeeded operation sets `cc.devices.status` under rules 1 to 7 of `step4:1054-1123`, with `status` as the field.
  The overlay lives 36 hours (`017-jobs.sql:178-189`). `status_observed_at` is the current-value stamp.
  Mock lists lag writes by `searchDelaySeconds`, 300 s (`mock:settings.js:31`, `device-writes.js:142, 160`). Without the overlay, a list sync inside that window restores the old status.
- **Publication.** The settlement publishes `entity-batch` with the device IDs and increments the query generation (`step4:1104-1113`).
  The Devices store reloads those rows by ID (`frontend/src/app/devices/devices.store.ts:739-740`, `device-row-refresh.ts:28-34`).
  With card `t_d703391b`, those rows carry `status`. The Status column therefore updates without a reload (`record:48, 153`).
- Reboot changes no cached field. Command settlements publish `job-changed` only.

## 6. Permissions

| Action ID          | Label                | Gates                                                        |
| ------------------ | -------------------- | ------------------------------------------------------------ |
| `devices:commands` | Send device commands | Send command, command previews and confirm                   |
| `devices:status`   | Change device status | Change status, status previews and confirm, status Reconcile |

- Labels come from record default 1 (`record:87`). Both actions take scope kinds `platform` and `district` (`libs/application-contracts/src/lib/authorization.ts:46-48`).
  `017-jobs.sql:4-5` inserts them. `frontend/src/app/action-labels.ts:16-18` gains the labels.
- The platform administrator holds every action (`authorization.ts:104`). The district administrator gains neither (`authorization.ts:105-113`).
- Route checks at district scope: command routes require `devices:read`, `devices:bulk-actions`, and `devices:commands`.
  Status routes require `devices:read`, `devices:bulk-actions`, and `devices:status`. Pattern: `api/src/app/devices/device-updates-actions.ts:8-37`.
- SQL: `cc.write_capable` (`017-jobs.sql:394-400`) gains the job action as an argument. It requires `devices:bulk-actions` plus the action permission.
  The action permission is `devices:write`, `devices:commands`, or `devices:status`. Preview (`:1584-1588`), confirm (`:1689-1693`), and the stop reason (`:405-414`) pass it.
- The device write scope check applies unchanged (`record:58`). `018-device-write-access.sql:1-11` opens it to the new actions (section 1).
- Reconcile of a status operation requires `jobs:read` and `devices:status` (pattern `device-updates-actions.ts:39-55`). Command operations have no Reconcile.

## 7. API routes

Two new route families copy the `api/devices/updates` shape (`api/src/app/devices/device-updates.controller.ts:35-142`).

| Route                                       | Body                                                       | Answer                |
| ------------------------------------------- | ---------------------------------------------------------- | --------------------- |
| `POST api/devices/commands/previews`        | `{ gridId, tabId, commandType: 'REBOOT' }`                 | Preview               |
| `POST api/devices/status-changes/previews`  | `{ gridId, tabId, statusAction: 'disable' \| 'reenable' }` | Preview               |
| `GET {family}/previews/:previewId`          | none                                                       | Preview               |
| `GET {family}/previews/:previewId/targets`  | none                                                       | Page of at most 1,000 |
| `POST {family}/previews/:previewId/confirm` | `{ manifestDigest, acknowledged: true }`                   | Receipt               |

- Each preview body is a strict object. Its `gridId` and `tabId` reuse `deviceSelectionKeySchema` (`libs/application-contracts/src/lib/devices.ts:212`).
  The step 4 request spreads the same two fields (`libs/application-contracts/src/lib/device-updates.ts:10-13, 40-51`).
  The API reads the caller's stored selection with that key (`api/src/app/devices/device-updates.ts:181-195`). No request carries device IDs.
- Each family maps to one menu entry and one permission, so its guards stay static. One family with an action body would gate on parsed input.
- The write-access routes stay under `api/devices/updates` (`device-updates.controller.ts:71, 76`).
- A new contract file `libs/application-contracts/src/lib/device-actions.ts` holds the preview, target, and body schemas.
  A target carries `deviceId`, `serialNumber`, `orgUnitPath`, `observedStatus`, `observedAt`, `disposition`, and `exclusionReason`.
- The receipt reuses the step 4 schema (`libs/application-contracts/src/lib/device-updates.ts:126-132`). `updateCount` counts operations.
- Job detail (`jobs.ts:170-180`) gains `commandType` and `statusAction`, both nullable.
- Operation (`jobs.ts:112-128`): `operation` adds `reboot`, `disable`, and `reenable`. `outcome` adds `expired` (`jobs.ts:100-106`).
  New nullable fields: `commandId`, `commandState`, `commandExpiresAt`, and `commandExecutedAt`.
  `baselineValue` holds the baseline status. `requestedValue` holds the requested status, and null for Reboot.
- Progress (`jobs.ts:44-58`) and the counters gain `expired`.
- The API edge route list in `deployment/bootstrap/application-edge.mjs` gains both families.

## 8. Tests

Every test runs on admin-sdk-mock. No test calls Google.

| Decision           | Target                                                     | Proof                                                                                    |
| ------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Job model          | Postgres integration in `deployment/postgres`              | Kinds, IDs, `awaiting-devices` frees `jobs_one_running`, terminal rule with `expired`.   |
| Eligibility        | `api` unit tests beside `device-updates.ts`                | Each exclusion reason, the digest fields, zero eligible gives `nothing-to-update`.       |
| Part allowlist     | `libs/google-connection/src/lib/allowlist.test.mjs`        | Every existing part shape passes. The new shapes pass. Other paths fail.                 |
| Retry rules        | `batch-run.test.mjs` with `batch-fake.mjs`                 | An issue part sees no quota or transient repeat. A status part sees no transient repeat. |
| Per-device results | `devices.test.mjs`                                         | Codes 5 and 9, other codes, missing and repeated IDs.                                    |
| Mock round trips   | `admin-sdk-mock.test.mjs`                                  | Issue and poll states, code 9 on a second Disable, the 50-ID limit.                      |
| Command lifecycle  | `worker` tests and Postgres integration                    | Issue settlement, finish to `awaiting-devices`, the schedule, every poll row, deadline.  |
| Lost issue answer  | `api-e2e:admin-sdk-mock-integration`                       | Hang: one POST, one stored command, `needs-review`. 503: one POST, `unknown`.            |
| Status changes     | `worker` tests and Postgres integration                    | Overlay on `status`, the lagged list keeps it, read-back compare, `entity-batch`.        |
| Permissions        | Postgres integration and `api` route tests                 | Each route and SQL check refuses a person without the action or Bulk Actions.            |
| Poll flow          | `deployment/kestra/device-update-flow.test.mjs` pattern    | The poll flow shape and its single worker request.                                       |
| Six steps          | `api-e2e:client-review-mock` and `frontend-e2e` (Chromium) | Card Q1 rehearses `record:149-156`.                                                      |

Mock facilities:

- `PUT /clock` with `scale` compresses the command timeline (`mock:control/control.js:176-196`, `commands.js:112`).
  The fixture starts at scale 1 (`api-e2e/admin-sdk-mock-fixture.mjs:244`). A test that raises `scale` restores scale 1 before it ends.
- `PUT domains/{id}/settings` with `writes.commandExpirySeconds` shortens expiry (`control.js:243-244`, `mock:settings.js:30-32`).
- `POST domains/{id}/faults` adds a rule for `directory.chromeos.issueCommand` (`control.js:249-252`, `mock:routes.js:67`).
  Kinds `status` and `reset` end the call before the handler, so the mock stores no command (`mock:faults/faults.js:124-135`, `mock:mock.js:123-129`).
  Inside a batch, `reset` becomes a transient part answer (`mock.js:124-127`). Both kinds prove the transient refusal only.
- Kind `hang` sleeps `ms / scale` milliseconds. Admission and the handler then run, and the handler stores the command.
  Sources: `faults.js:136-141`, `mock.js:130-137`, and `commands.js:114-117`. The batch answer waits for that part (`mock:batch/batch.js:23-46`).
  A hang past the 10 s request timeout (`provider.ts:262`) therefore loses the answer of an accepted issue.
  Step 4 uses 12,000 ms at scale 1 (`api-e2e/device-write-mock.mjs:315-341`). Under a raised scale, `ms` is at least `12,000 × scale`.
  `ms` is at most 600,000 (`faults.js:67`), so a hang test runs at a scale of at most 50.
- `GET domains/{id}/faults` reports `remaining` per rule (`faults.js:104, 108`). A rule with `count` 2 that ends at 1 proves one POST.
- Command IDs rise by 1 in a domain from 4100000001 (`commands.js:21, 106-108`). getCommand reads a stored command by ID (`commands.js:120-157`).
- The seed holds 2 % DISABLED and 5 % DEPROVISIONED devices (`findings:105`). An offline device never executes (`commands.js:113-116`).

## Card plan

| ID  | Title                                               | Profile  | Depends on                  |
| --- | --------------------------------------------------- | -------- | --------------------------- |
| B1  | Device actions: schema and contracts                | backend  | PR #72, `t_d703391b` merged |
| B2  | Google calls: commands, polls, and status changes   | backend  | none                        |
| B3  | Device actions: previews and confirm routes         | backend  | B1                          |
| B4  | Status change jobs                                  | backend  | B1, B2, B3                  |
| B5  | Command jobs: issue and release the write slot      | backend  | B1, B2, B3                  |
| B6  | Command polling                                     | backend  | B5                          |
| F1  | Devices grid: Status column and status filter       | frontend | `t_d703391b`, mockup        |
| F2  | Bulk Actions: Send command and Change status sheets | frontend | B3, mockup                  |
| F3  | Jobs: command and status job detail                 | frontend | B4, B6, mockup              |
| Q1  | Rehearse the six completion steps                   | qa       | B4, B6, F1, F2, F3          |

**B1.** Scope: section 1 schema in 016, 017, and 018, the two actions, and the contracts of sections 1, 6, and 7. It adds the two labels in `action-labels.ts`, because that record is exhaustive.
Acceptance: fresh migrations pass. Contract tests accept `CMD-001`, `STS-001`, `awaiting-devices`, and `expired`. The integration suite proves the slot rule of section 1.

**B2.** Scope: section 3. Acceptance: the allowlist, retry, and parser tests of section 8 pass. `device-changes` evidence names the four methods.

**B3.** Scope: sections 2, 6, and 7 for previews and confirm. Acceptance: a Reboot preview of ACTIVE, DISABLED, and DEPROVISIONED devices lists each exclusion reason.
A Re-enable preview of ACTIVE devices shows 0 eligible, and confirm answers 422. A person without the action gets 403 from route and SQL.

**B4.** Scope: section 5. Acceptance: a Disable job on the mock settles per device. A DISABLED target fails with `status-conflict` and Google's message.
The device record reads DISABLED after one `entity-batch`. A list sync inside 300 s keeps DISABLED.

**B5.** Scope: section 4 steps 1 to 4, 11, and 12. Acceptance: a Reboot job reaches `awaiting-devices`, and an Update device job then runs.
Lost answer: a one-device Reboot job meets a `hang` fault with `count` 2. Its real duration exceeds the 10 s timeout (section 8).
The rule ends at `remaining` 1, and getCommand reads the stored command. The mock therefore accepted exactly one issue POST.
The operation settles `unknown` with `ambiguous`, and the job ends `needs-review`. Reconcile answers 409 `reconcile-unsupported`.
Transient refusal, a separate check: a `status` 503 fault with `count` 2 ends at `remaining` 1. The operation settles `unknown` with `ambiguous`.

**B6.** Scope: section 4 steps 5 to 10. Acceptance: with `scale`, online devices reach `succeeded` and the job completes.
With a short `commandExpirySeconds`, offline devices reach `expired`, and the job ends `completed-with-errors` or `failed`.

**F1, F2, F3.** Each waits for the owner-approved mockup and its API card. Each closes its design gaps (`record:117-129`).
F1 replaces the `t_d703391b` status shims. F2 builds the Choose, Review, and Confirm steps (`record:92`). F3 shows the seven states and hides Reconcile for commands.

**Q1.** Acceptance: each of the six steps of `record:149-156` passes on admin-sdk-mock, with screenshots.
Step 5 loses an issuance answer with the section 8 `hang` fault. A 503 shows a transient refusal, not a lost answer.

## Risks and follow-ups

- The command lifecycle comes from the mock only. Its online window, timeline, and expiry stay unverified against Google (`findings:106`). A live spike precedes release (DEVICE-01).
- Real Google states beyond the five mock states settle `unknown` with `unrecognized-state`. The spike confirms the full list.
- Migration 016 is a hotspot: card `t_d703391b` and card B1 both edit it.
