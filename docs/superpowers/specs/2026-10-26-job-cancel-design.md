# Technical design addendum: universal job cancel (Cancel pending work)

Status: approved, built, and signed off on 2026-10-28. Card `t_e31b9cb4`.
Record: `docs/workflows/batch-update-export-import.md`. The record stays proposed. Its cancel rules are owner-settled (`record:71-82`, `:192-207`, `:218-223`).
Mockup: `docs/ui/designs/2026-10-26-job-cancel.html` with the state files `docs/ui/designs/2026-10-26-job-cancel-01-running-job.png`, `docs/ui/designs/2026-10-26-job-cancel-02-cancel-confirm-running.png`, `docs/ui/designs/2026-10-26-job-cancel-03-cancellation-requested.png`, `docs/ui/designs/2026-10-26-job-cancel-04-cancelled-result.png`, `docs/ui/designs/2026-10-26-job-cancel-05-queued-confirm.png`, `docs/ui/designs/2026-10-26-job-cancel-06-queued-cancelled.png`, and `docs/ui/designs/2026-10-26-job-cancel-07-jobs-grid-cancelled.png`. The notes are `docs/ui/designs/2026-10-26-job-cancel-notes.md`. On 2026-10-26 the owner approved it: "Thats fine."
The same answer accepted no cancel reason and the 30-second cancel check (mockup questions 1 and 2).
Extends: [device-write jobs](2026-10-16-device-write-jobs-design.md), [worker contracts](2026-10-19-device-write-worker-contracts.md), [device command jobs](2026-10-21-device-command-jobs-design.md), and [status jobs](2026-10-23-wipe-powerwash-deprovision-design.md).
Owner direction, 2026-10-19: "We are building a doghouse. We dont need to choose the curtains."

## Conventions

- Paths are relative to the repository root at `f2d67a0`, the base of this card.
- `git diff 89d5478 f2d67a0` changes docs only. The code lines that the technical design cites hold at this base.
- `record:N` cites the record. `td:N` cites `docs/research/batch-update-export-import-technical-design.md`.
- `016`, `017`, `002`, and `008` name files in `deployment/postgres/migrations/`. `worker:N` cites `worker/src/device-update.ts`.
- `edge:N` cites `deployment/bootstrap/application-edge.mjs`. `index:N` cites `deployment/postgres/index.mjs`. `ac/` is `libs/application-contracts/src/lib/`.
- `api/` is `api/src/app/`, and `fe/` is `frontend/src/app/`. `mock:` names `node_modules/@campuscommander/admin-sdk-mock/dist/src/`, version 0.2.0.
- `choice N` and `state NN` name the composition choices and the PNG states of the mockup notes.
- The parallel docs card holds no file under `docs/ui/designs/2026-10-26-job-cancel*` at this base. This design cites choice numbers.

## Decision summary

1. Contracts add the `cancelled` job status, operation outcome, and count, the cancel request, and `jobs:manage`.
2. `POST /api/jobs/{jobId}/cancel` stores the request. A job that sent nothing to Google ends at once. Every `REF` job ends at once.
3. A running write job stops sending within 30 seconds. Its worker reads the request at each batch claim and each lease renewal.
4. Unsent operations settle Cancelled through the existing skip function. Cancelled wins over Needs review in the shared terminal rule.
5. Recovery finalizes a lost runner with a request and dispatches no new start. Issued commands keep their polls.
6. Both refresh runners read the request every 30 seconds. A full sync publishes nothing. A selected-device refresh keeps its stored batches.
7. `jobs:manage` holds the job visibility of `jobs:read` in SQL, in the API, and in the client.
8. Six backend cards, one frontend card, and one qa card build the slice. `IMP` and `EXP` reuse the contract of section 8.

## 1. Contracts

- `jobStatusSchema` (`ac/jobs.ts:45-55`) adds `cancelled`, a finished status (`td:885`).
- `jobOutcomeSchema` (`ac/jobs.ts:140-147`) adds `cancelled`. Only an operation that never left the worker reaches it.
- `jobProgressSchema` (`ac/jobs.ts:82-98`) adds a required `cancelled` count. A refresh job reports its header counter (section 2).
- `jobSummarySchema` (`ac/jobs.ts:123`) adds `cancelRequest`. It is null, or `{ at, by }` with `by` in the shape of `jobPersonSchema` (`ac/jobs.ts:109`).
- `jobDetailSchema` extends the summary (`ac/jobs.ts:241`). The detail therefore carries the request too.
- `actionSchema` (`ac/authorization.ts:3-23`) adds `jobs:manage`. `actionScopeKinds` gives it the scopes of `jobs:read` (`ac/authorization.ts:35-56`).
- The platform administrator preset holds every action (`ac/authorization.ts:112`). It gains `jobs:manage` with no preset change.
- The `cc.application_actions` row of `jobs:manage` lands with the enum (`017:4-7`).

The cancel route:

| Part   | Shape                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------- |
| Path   | `POST /api/jobs/{jobId}/cancel`. `jobId` is the display ID, such as `UPD-001` (`edge:74`).      |
| Body   | An empty strict object. The request carries no revision (`td:818`).                             |
| Answer | 200 with the `JobSummary` after the request.                                                    |
| Repeat | A job that holds a request answers 200 with its current summary, also after it ends (`td:821`). |

| Status | Reason                 | When                                                                                                  |
| ------ | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| 404    | `job-not-found`        | No such job, or the person cannot see it (`017:318-330`).                                             |
| 403    | `cancel-not-permitted` | The person sees the job but holds no right to cancel it (`record:102`).                               |
| 409    | `job-finished`         | The job finished without a cancel request (`td:822`).                                                 |
| 409    | `nothing-to-stop`      | A write job is Awaiting devices, or holds no pending or dispatched operation (`record:81`, `td:830`). |

`ac/jobs.ts` exports the four reasons as `jobCancelRefusalSchema`. The client reads them. A `REF` job never answers `nothing-to-stop`.

## 2. Schema

Each change edits the migration in place. Development data is disposable.

**`cc.jobs`** (`017:17-46`):

- The status check (`017:23-24`) adds `cancelled`.
- A `cancelled` counter joins the counters (`017:29-33`). `cc.refresh_device_update_counters` counts it (`017:410-421`).
- `cancel_requested_at timestamptz` and `cancel_requested_by uuid` join the header. A check sets both columns or neither.
- `cancel_requested_by` references `cc.application_principals(id)`, as `requested_by` does (`017:25`).
- A second check holds `status<>'cancelled' OR cancel_requested_at IS NOT NULL`.
- A cancel records no `failure`. The failure check stays as built (`017:34-37`).
- A cancelled job leaves `jobs_one_running` and `jobs_admission` through its status (`017:49-52`).

**Operations.** The status check of `cc.device_update_operations` adds `cancelled` (`017:223`).
`cc.skip_device_update_pending` (`017:464-476`) writes `cancelled` with the reason `cancel-requested` when the header holds a request.
Every caller holds the header lock, so that read stays stable. The function locks the same rows in the same order (`017:468-469`).
This branch replaces the sibling function of `td:892`. Its four callers inherit it.
They are the claim stop (`017:861`), the refused start (`:677`), the preparation (`:1598`), and the finalizer (`:1734`).
The settle function needs no change. It already accepts `pending` for an unsent write or issue (`017:1059-1060`).

**Terminal rule.** `cc.device_update_terminal_status` (`017:424-431`) adds `WHEN j.cancelled>0 THEN 'cancelled'` before the Needs review rule (`017:426`).
Its four callers inherit the rule (`017:1388`, `:1676`, `:1751`, `:1793`). A job without a Cancelled operation keeps the built rule (`td:861`).

**Stop reason.** `cc.device_update_stop_reason` takes no job argument (`017:520-529`), so it stays as built.
The claim reads `cancel_requested_at` from the header that it locks (`017:761`). A request takes the stop branch (`017:839-864`).
With a request, that branch records no job failure, settles pending operations Cancelled, and answers `done`. The worker passes `done` through (`worker:1885`).
Each later claim of the job answers `done` too. The flow then reaches its finish step (`deployment/kestra/device-update.yaml:18-53`).

**Renewal and cancel read.** The renewal answer stays `timestamptz` (`017:922-966`). The worker parse stays too (`worker:1474-1493`).
A new `cc.job_cancel_requested(p_customer text,p_job uuid) RETURNS boolean` reads the request of one header without a lock.
Every runner calls it in a 30-second tick. A changed renewal answer would break the worker parse between the schema and worker merges.

**Finish and recovery.**

- The preparation and the finalizer keep their live-lease fences (`017:1573-1576`, `:1712-1715`).
- They still fence dispatched operations Unknown (`017:1596`, `:1732`). A sent request keeps its evidence and its read-back.
- With a request, their skip settles every remaining pending operation Cancelled. A request after the last claim therefore still reaches Cancelled.
- Recovery (`017:716-739`) finalizes a lost runner with a request through `cc.finalize_device_update_job` (`:733`). It dispatches no new start.
- The refused start keeps its rule (`017:642-681`). Its fence needs a job without a first claim (`:659`), and the cancel ends that job at once.

**Hold cleanup.** `cc.clean_device_update_hold` adds `cancelled` to its status gate (`017:2197`). The job service stamps `hold_cleaned_at` through it (`api/jobs/job-service.ts:418`).

**Cancel request function.** `cc.request_job_cancel(p_actor uuid,p_version integer,p_customer text,p_display_id text,p_correlation uuid) RETURNS jsonb`:

1. It takes the admission lock of the customer (`017:552`). It reads the header without a lock, then takes the row locks of its kind.
2. It raises `job-not-found` when no header matches or `cc.job_visible` refuses the person (`017:318-330`).
3. It raises `cancel-not-permitted` unless the person requested the job or holds `jobs:manage` for its customer.
4. A header that holds a request answers `repeated`. The first person and time stay.
5. A finished job raises `job-finished`. A write job that is Awaiting devices, or holds no pending or dispatched operation, raises `nothing-to-stop`.
6. It stores the request, bumps the revision, and records one change through `cc.record_job_change` (`017:362`).
7. It inserts one `job-cancel-requested` row in `cc.security_events` (`002:15-26`). `detail` holds the display ID. The row holds no reason.
8. It answers `requested`. Each refusal raises its reason as `DETAIL`, as `cc.request_device_sync` raises `device-sync-running` (`016:221`).

| Job state                                                     | Effect of the stored request                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Accepted, Queued, Held, or Running without `first_claimed_at` | The skip function settles every operation Cancelled. The job ends through the terminal rule at once. |
| Running after a first claim                                   | Only the header changes. The worker settles the operations (section 3).                              |
| `REF`, either form                                            | The job ends `cancelled` at once. Section 3 stops its runner within 30 seconds.                      |

The claim writes `first_claimed_at` under the header lock (`017:761`, `:897`), so the cancel reads it without a lock.
The next claim of a job that ended at once answers `superseded` (`017:769-771`). No request reaches Google.

**Refresh jobs.** Both refresh constructors create a Running header (`016:224-227`, `:831-834`). No `REF` job waits.

- A full sync clears the five sync columns of its state row. Generation, count, and failure stay (`016:762-767`).
- A selected-device refresh sets `finished_at` on its detail row. Its batch records stay (`016:123-130`).
- `cc.close_refresh_job` (`017:480-496`) then ends the header. With a request, it writes `cancelled` and keeps `failure`.
- A full sync counts its staged devices as succeeded (`017:485-492`). Its `cancelled` count stays 0, because a full sync knows no total.
- A selected-device refresh keeps its batch counters (`016:968-972`). Its `cancelled` count holds the IDs of the unrecorded batches.
- The claim, the lease, and the finish of a sync fence on the closed header (`016:307-309`, `:345-349`, `:726-731`).
- The batch read and the batch finish fence on the closed detail row and header (`016:904-906`, `:941-943`). The purge skips a finished header (`017:2712`).
- A cancel before `cc.finish_device_sync` therefore removes no device. The finish raises `device-sync-changed` before its removal (`016:760-761`).
- The other callers of `cc.close_refresh_job` never meet a request, because the cancel finishes the header first (`016:236`, `:278`, `017:493`).

**Visibility and grants.**

- `cc.job_visible` accepts `jobs:manage` as well as `jobs:read` (`017:326`). `cc.job_reader` accepts it too (`017:2784`).
- Record default 17 sets this rule (`record:244`). The event check of `cc.security_events` adds `job-cancel-requested` (`008:2`).
- The `017` runtime grant block (`index:273-309`) gains `cc.request_job_cancel(uuid,integer,text,text,uuid)` and `cc.job_cancel_requested(text,uuid)`.
- The `017` PUBLIC revoke list (`017:2810`) gains both functions. Both run as SECURITY DEFINER.
- The changed helpers stay private: `cc.skip_device_update_pending`, `cc.close_refresh_job`, `cc.refresh_device_update_counters`, and `cc.device_update_terminal_status`.
- Each one stays on the revoke list (`017:2813-2815`) and outside the grant block. No new function is a private helper.

**Lock order.** The built write-job writers lock the header first. They then lock batch, operation, and detail rows (`017:760-853`, `:932-956`).
Refresh writers lock the state row before the header (`016:295-299`, `:718-721`). Admission and hold cleanup take the admission lock first (`017:552`, `:2189`).

| New writer                                | Lock order                                                                                                 | Serializes with                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `cc.request_job_cancel`, write job        | Admission lock, header, pending operations by number, requester (KEY SHARE), connection (KEY SHARE)        | Admission and hold cleanup on the admission lock. Claim and finish on the header. |
| `cc.request_job_cancel`, full sync        | Admission lock, state row, header, requester, connection, as `cc.abandon_device_sync` does (`016:254-273`) | Sync claim, lease, finish, and purge on the state row (`017:2700`)                |
| `cc.request_job_cancel`, selected devices | Admission lock, header, detail row, requester, connection, as the batch finish does (`016:925-949`)        | Batch finish and purge on the header (`017:2711`)                                 |
| Claim and recovery with a request         | As built. Recovery calls the finalizer under its header lock (`017:693-694`, `:733`).                      | Unchanged                                                                         |
| `cc.job_cancel_requested`                 | No lock                                                                                                    | Nothing                                                                           |

No built writer takes the admission lock after a header. The cancel never takes the global access lock (`017:760`).
No migration outside `016` and `017` references `cc.jobs`. The admission lock also orders the import cancel of section 8.

## 3. The worker

**Update, status, and command batches** (`worker/src/device-update.ts`):

- The claim answers `done` once the job holds a request (section 2). The worker starts no new send.
- The 30-second renewal tick (`worker:1496-1510`) calls `cc.job_cancel_requested` after each successful renewal. A true answer sets a drain flag.
- A failed read leaves the flag unset. The next tick reads again.
- A fenced renewal still raises `attempt-fenced` and aborts the batch (`worker:1500-1505`). That path marks a lost lease, not a cancel.
- Each `onSend` hook throws a drain marker once the tick sets the flag (`worker:1539-1545`, `:1613-1623`). It throws before it marks any entry sent.
- The batch service calls `onSend` right before each multipart request leaves (`libs/google-connection/src/lib/batch.ts:141-142`).
- No request, round, or retry therefore leaves after the flag. A retry wait ends at its next send.
- The round in flight settles from its answers in `onBatch` (`worker:1516-1535`). A lost answer stays Unknown and goes to the read-back (`td:839`).
- The catch (`worker:1672-1696`) treats the drain marker as a stop without a job failure.
- After the flag, the leftover settlement (`worker:1701-1720`) settles each unsent operation `pending`, also after an observed failure.
- The next claim or the preparation then settles those rows Cancelled. The worker never writes `cancelled` itself.
- The renewal timer runs until the release. The lease therefore stays live while sent requests settle.
- A written field keeps its read-back. The verification functions ignore the request (`017:1406`, `:1476`). A read-back sends no write (`td:840`).

**Command batches.** The issue loop takes the same `onSend` hook (`worker:1580-1591`), so the drain stops it.

- An issued command keeps the status `issued`. The finish moves the job to Awaiting devices (`017:1663-1675`).
- Polls continue through the built poll functions (`017:1809-1819`, `:1882`).
- `cc.complete_device_command_job` ends the job Cancelled after its last settle (`017:1781-1803`).
- The page shows Cancellation requested until then (`record:79`).

**Refresh runners.** The request ends a `REF` job at once. Each runner then stops its Google reads within 30 seconds.

- Each runner starts a 30-second tick that calls `cc.job_cancel_requested`. A true answer aborts the provider signal of the run.
- The provider calls take that signal (`worker/src/device-sync.ts:129-133`, `worker/src/entity-sync.ts:195-212`).
- The abort also ends a quota wait (`worker/src/entity-sync.ts:69-83`, `:126-149`).
- After the abort, the full sync calls its finish, which raises `device-sync-changed` (`worker/src/device-sync.ts:161-166`).
- The full sync then runs no Redis step and publishes no event (`worker/src/device-sync.ts:167-218`).
- A stage call after the cancel raises the same code (`016:634`, `:680`). The runner rethrows it before the finish (`worker/src/device-sync.ts:152-153`).
- A selected-device batch calls `cc.job_cancel_requested` again before its upsert (`worker/src/entity-sync.ts:223`). A true answer ends it without a store.
- An aborted or refused batch throws, so it records nothing (`worker/src/entity-sync.ts:256-259`). Earlier batches keep their device writes and records.
- Both dispatch handlers answer 409 for these errors, as for a purged refresh (`worker/src/dispatch.ts:197-198`, `:237-238`).
- Kestra retries a refused batch at most three times (`deployment/kestra/entity-sync.yaml:42-47`). Each retry fails at the batch read (`016:904-906`).

## 4. The job service

- Admission reads Accepted, Queued, and Held jobs only (`017:554-555`). A cancelled job leaves that set, so admission skips it.
- `holdReleased` (`api/jobs/job-service.ts:105`) adds `cancelled`. `changed` and `cleanup` then release the hold (`:227-231`, `:399-420`).
- `cleanup` deletes the Redis hold, then stamps `hold_cleaned_at` through the SQL gate of section 2 (`:413`, `:418`).
- The write slot frees with the status change. `jobs_one_running` covers `running` only (`017:49-50`).
- The next queued job then starts in admission order (`td:863`).
- Recovery runs in SQL (`api/jobs/job-service.ts:358-366`). It returns no start for a cancelled lost runner (section 2).
- The request and the final status each record one change. The relay sends both as built (`api/jobs/job-service.ts:472`, `:490`).

## 5. The API

- A handler for `POST :displayId/cancel` joins the controller (`api/jobs/jobs.controller.ts:92`), beside the reconcile route (`:221-223`).
- It resolves the customer through `cc.job_reader` and passes the actor and permission version (`api/jobs/jobs.ts:380-397`, `:410-412`).
- The SQL function decides. The handler maps each refusal to the status of section 1. After a request, it reads the summary.
- The requester, a `jobs:manage` holder, or a platform administrator can cancel (`record:75`, `:197`).
- A platform administrator passes through the `jobs:manage` grant of its preset (`ac/authorization.ts:112`).
- The edge allows the new path (`edge:81-83`).
- The audit row holds the person, the time, the correlation ID, and the display ID. A repeated request writes no second row.
- A repeated request answers 200 with the current summary (`td:821`).
- A command job answers `nothing-to-stop` once its worker issues every command (`record:81`, `:222`).
- `jobSummary` (`api/jobs/jobs.ts:178`) maps the `cancelled` counter and the request. The person uses the shape of `requestedBy` (`:196`).
- The attention rule (`api/jobs/jobs.ts:820-826`) adds a cancelled job with a failed or Unknown operation (`record:245`).
- Reconcile reads the operation status (`api/jobs/jobs.ts:719-720`). An Unknown row of a cancelled job keeps Reconcile (`record:80`).
- The running counts read `running` and `awaiting-devices` (`api/jobs/jobs.ts:772`, `:780`). A cancelled job counts as finished.
- `seesEveryJob` (`api/jobs/jobs.ts:885-892`) and `jobVisibility` (`api/devices/devices.service.ts:544-548`) accept `jobs:manage` too.
- `seesEveryJob` feeds the Jobs stream, the Jobs list, and the device stream (`api/jobs/jobs-stream.ts:49`, `api/jobs/jobs.controller.ts:150`, `api/devices/device-stream.ts:30`).
- `RECONCILE_READ_ACTIONS` adds `jobs:manage` (`api/devices/device-updates-actions.ts:91`). The device action of each Reconcile stays (`:92-94`).

## 6. The client

| Part            | Decision                                                                                               | Source                                           |
| --------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Control         | Outlined "Cancel pending work", right of Refresh, in a right-hand group 8 px apart                     | Choices 1 and 2, `fe/jobs/job-detail.html:10-19` |
| Who sees it     | A `canCancel` rule: the requester or a `jobs:manage` grant. The administrator preset holds that grant. | `record:75`, `ac/authorization.ts:112`           |
| Hidden          | Awaiting devices, no pending operation, a finished job, or a person without the right                  | `record:73`, mockup notes, no control shown      |
| Question        | The Revert all changes shell: 480 px, two paragraphs, both named by `aria-describedby`                 | Choice 3                                         |
| Title and body  | "Cancel pending work on UPD-001?" with the running body of state 02 or the waiting body of state 05    | Choices 4 to 6                                   |
| Dismiss         | "Keep job running" or "Keep job waiting"                                                               | Choice 7                                         |
| After request   | The control reads "Cancellation requested", disabled interactive                                       | Choice 8                                         |
| Banner          | "Cancellation requested · The job stops within 30 seconds" until every operation settles               | Choice 9, `record:79`                            |
| Identity line   | "Cancellation requested by {person} · {time}" in the shape of the Deprovision reason line              | Choice 10, `fe/jobs/job-detail-fields.ts:343`    |
| Status chip     | "Cancelled" in the neutral tone                                                                        | Choice 11, `fe/jobs/job-fields.ts:91`            |
| Cancelled row   | Neutral "Cancelled" chip, the note "Not sent to Google", the settle time, and no action                | Choice 12                                        |
| Counts          | The built Cancelled counter reads the count. No counter joins it.                                      | Choice 13                                        |
| Latest activity | A cancel sentence leads. The built sample sentences follow.                                            | Choice 14, `fe/jobs/job-detail-fields.ts:658`    |
| Grid cell       | "38 succeeded" over "1 failed · 1 unknown · 8 cancelled"                                               | Choice 15, `fe/jobs/job-fields.ts:210`           |

Built behavior that changes:

1. The Cancelled counter stays 0 today (`fe/jobs/job-detail-fields.ts:108`, `:143`). It reads `progress.cancelled`, and the comment at `:108` goes.
2. `JOB_STATUS_LABELS` (`fe/jobs/job-fields.ts:52`) adds "Cancelled". The status filter reads its labels from it (`:64-66`, `:314-321`).
3. `progressLines` falls back for a status that it does not name (`fe/jobs/job-fields.ts:210`). `cancelled` gets its own case.
4. `recentLine` (`fe/jobs/job-fields.ts:233`) lists a cancelled job with the finished jobs (`td:878`).
5. `outcomeTone` and `operationChip` add the neutral Cancelled outcome (`fe/jobs/job-detail-fields.ts:30`, `:58`).
6. A command that Google cancelled keeps its red Failed chip and its sentences (`fe/jobs/job-detail-fields.ts:437`, `:453`).
7. An app cancel never uses those sentences. The two rows never look alike (choice 12).
8. `attentionCount` stays (`fe/jobs/job-detail-fields.ts:148-150`). The API rule of section 5 raises the bell dot.
9. `jobsReadable` (`fe/jobs/jobs.store.ts:28-34`) accepts `jobs:manage`. The Jobs routes, navigation, and Activity read it (`fe/app.routes.ts:78-91`, `fe/shell/shell.html:40`, `:134`).
10. `canReconcile` accepts `jobs:read` or `jobs:manage` as its read check (`fe/jobs/job-detail-fields.ts:337`). Its device action check stays (`:330-338`).

## 7. Tests

| ID  | Target and file                                                                                                       | Check                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| K1  | `application-contracts:test`: `ac/jobs.test.mjs`, `ac/authorization.test.mjs`                                         | Each schema parses `cancelled` and the request. A progress without `cancelled` fails. `jobs:manage` parses at both scopes.         |
| S1  | `deployment:postgres-integration`: `deployment/postgres/device-write-jobs.integration.mjs`                            | A Queued job and a Held job end `cancelled` at once. Every operation reads Cancelled. One audit row exists.                        |
| S2  | Same file                                                                                                             | A Running job without a first claim ends Cancelled. Its next claim answers `superseded`.                                           |
| S3  | Same file                                                                                                             | A claim with a request answers `done`, records no failure, and leaves no pending operation.                                        |
| S4  | Same file                                                                                                             | A request after the last claim: the preparation settles the returned `pending` rows Cancelled. The finish ends `cancelled`.        |
| S5  | Same file                                                                                                             | A live lease answers `busy`. After it lapses, dispatched rows read Unknown. Recovery returns no start and ends the job Cancelled.  |
| S6  | Same file and `deployment/postgres/device-command-polls.integration.mjs`                                              | One Cancelled and one Unknown row end `cancelled`. An Awaiting devices job with a request ends `cancelled` after its last poll.    |
| S7  | `device-write-jobs.integration.mjs`, two sessions                                                                     | A cancel during an admission waits on the admission lock and raises no deadlock. Each refusal raises its reason.                   |
| S8  | Same file                                                                                                             | A repeat keeps the first person and time and writes no second audit row. A job without a Cancelled row keeps the built rule.       |
| S9  | `deployment/postgres/device-inventory.integration.mjs`                                                                | A cancel after the last stage ends the full sync Cancelled. Its finish raises. No device gains `removed_at`. The generation stays. |
| S10 | Same file                                                                                                             | A selected-device refresh with one of three batches recorded ends Cancelled. That batch row and its counts stay.                   |
| S11 | Same file                                                                                                             | After that cancel, `cc.read_entity_sync_batch` raises `entity-sync-changed`. A late batch finish records nothing.                  |
| S12 | `deployment/postgres/jobs-api.integration.mjs`                                                                        | A `jobs:manage`-only principal passes `cc.job_visible` for a job of another person and passes `cc.job_reader`.                     |
| S13 | `device-write-jobs.integration.mjs`, the check of `deployment/postgres/device-command-polls.integration.mjs:792`      | The runtime role executes both new functions. `has_function_privilege('public', …)` answers false for each.                        |
| S14 | `device-write-jobs.integration.mjs`                                                                                   | `cc.clean_device_update_hold` answers true for a cancelled job with a written hold.                                                |
| W1  | `worker:test`: `worker/src/device-update.test.mjs`                                                                    | A true cancel read sends nothing more. The round in flight settles from its answers. Unsent rows settle `pending`.                 |
| W2  | Same file                                                                                                             | Renewals continue until the release. A fenced renewal still aborts. A written field of a cancelled job keeps its read-back.        |
| W3  | Same file                                                                                                             | A drained command batch leaves its issued rows `issued`. A drained status batch sends no further part.                             |
| R1  | `worker:test`: `worker/src/device-sync.test.mjs`                                                                      | A reader double that stalls on page 2 aborts at the tick. No stage follows. A raising finish leaves Redis untouched.               |
| R2  | `worker:test`: `worker/src/entity-sync.test.mjs`                                                                      | A quota-retrying reader double ends its wait at the tick. A true read before the upsert stores nothing.                            |
| J1  | `api:test`: `api/src/app/jobs/job-service.test.mjs`. `deployment:postgres-integration`: `job-service.integration.mjs` | A cancelled Held job loses its hold in the test Redis and gains `hold_cleaned_at`. Its slot frees for the next job.                |
| A1  | `api:test`: a new `api/src/app/jobs/jobs-cancel-route.test.mjs` and `jobs.test.mjs`                                   | Each refusal maps to its status. A repeat answers 200. A `jobs:manage`-only principal reads and cancels. Attention holds.          |
| C1  | `frontend:test`: `jobs.store.spec.ts`, `app.routes.spec.ts`, `shell.spec.ts`, and the `fe/jobs/` specs                | A `jobs:manage`-only principal reaches the routes, the navigation, Activity, and the control. Each row of section 6 holds.         |
| C2  | `frontend-e2e:e2e` (`nx.json:40-43`): `frontend-e2e/src/job-detail.spec.ts`, `jobs.spec.ts`                           | States 01 to 07 hold against a mocked API.                                                                                         |
| Q1  | `api-e2e:client-review-mock` (`docs/testing/client-review.md:33`)                                                     | Card CQ1.                                                                                                                          |

`deployment:postgres-integration` runs each file through `deployment/postgres/integration.mjs:1-19`. `job-service.integration.mjs` runs a real test Redis.
The `medium` mock seed serves 7,000 devices (`docs/testing/client-review.md:45`). A small `CC_DEVICE_UPDATE_BATCH_SIZE` keeps a job running (`worker/src/google-connection.ts:52`).
The mock delays slow each answer (`mock:control/control.js:179-191`). A second write job queues behind the running one (`017:49-50`).

## 8. Contract for the validation and export jobs

The `IMP` and `EXP` slices implement these rules. This plan holds no card for them.

1. The kind joins the kind check (`017:21`), the display ID check (`017:19`), `jobDisplayIdSchema` (`ac/jobs.ts:19`), and the edge path (`edge:74`).
2. The header lives in `cc.jobs` with the cancel columns. `cc.request_job_cancel` ends a waiting job of the kind at once.
3. Its worker reads the request at each batch claim and in a 30-second tick through `cc.job_cancel_requested` (`record:242`).
4. A stopped validation produces no report and no plan. Its stored refresh reads stay (`td:851`).
5. A stopped export deletes its partial file. A Sheet export answers `nothing-to-stop` once its Sheet write starts (`record:243`, `td:852`).
6. The kind ends through the shared terminal rule. A Cancelled row ends the job Cancelled.
7. A cancel of the update job of an import ends its waiting status jobs in the same transaction (`record:82`, `:220`).
8. That cancel holds the admission lock. It then locks the update job row and each status job row in display ID order.
9. The import question names each status job it ends (`td:869`). The CSV slice draws that question.

## Open item

O1. No mockup state draws the question for a refresh job. Refresh jobs count pages, so the body needs its own count sentence.
The mockup build notes name this gap. The eng-lead ruled O1 on 2026-10-26 on card `t_e31b9cb4`: the refresh questions use drafted copy.
CF1 shipped the question, and the owner accepted it at the sign-off on 2026-10-28.

## Card plan

| ID  | Title                                                              | Profile  | Depends on    |
| --- | ------------------------------------------------------------------ | -------- | ------------- |
| CB1 | Contracts: the cancelled status, count, request, and `jobs:manage` | backend  | none          |
| CB2 | Schema: the cancel request, the stop, recovery, and the grants     | backend  | CB1           |
| CB3 | Worker: drain update, status, and command batches                  | backend  | CB2           |
| CB4 | Worker: stop the refresh runners                                   | backend  | CB2           |
| CB5 | Job service: release the hold and the write slot                   | backend  | CB2           |
| CB6 | API: the cancel route, visibility, and attention                   | backend  | CB3, CB4, CB5 |
| CF1 | Jobs pages: Cancel pending work                                    | frontend | CB6           |
| CQ1 | Rehearse the cancel on admin-sdk-mock                              | qa       | CF1           |

- IDs are local to this design. Each card that changes a contract updates every consumer, including the `api-e2e` and `frontend-e2e` fixtures.
- CB6 opens the route last. Its dependencies give every stored request a worker that reads it. CQ1 depends on every card through CF1.

**CB1.** Scope: section 1 in `ac/jobs.ts`, `ac/authorization.ts`, their tests, and the action row at `017:4-7`.
It fixes each consumer that the wider enums break: `JOB_STATUS_LABELS` (`fe/jobs/job-fields.ts:52`) and `OUTCOME_LABELS` (`fe/jobs/job-detail-fields.ts:21`).
Until CB6, `jobSummary` answers `cancelled: 0` and `cancelRequest: null` (`api/jobs/jobs.ts:178`).
Acceptance: K1 passes. `frontend:build`, `frontend:test`, `api:test`, and `worker:test` pass. A session with a `jobs:manage` grant parses.

**CB2.** Scope: section 2 in `017`, `008:2`, `index:273-309`, and the `deployment/postgres` integration files of rows S1 to S14.
Acceptance: S1 to S14 pass on a fresh database. `016` keeps every function body.

**CB3.** Scope: the batch part of section 3 in `worker/src/device-update.ts` and its test file.
Acceptance: W1 to W3 pass. No batch writes `cancelled` itself, and the renewal parse stays unchanged.

**CB4.** Scope: the refresh part of section 3 in `worker/src/device-sync.ts`, `worker/src/entity-sync.ts`, and their test files.
Acceptance: R1 and R2 pass. Both runners keep their dispatch answers (`worker/src/dispatch.ts:197-198`, `:237-238`).

**CB5.** Scope: section 4 in `api/jobs/job-service.ts:105`, `api/src/app/jobs/job-service.test.mjs`, and `deployment/postgres/job-service.integration.mjs`.
Acceptance: J1 passes. A cancelled running job frees the slot, and the next queued job starts.

**CB6.** Scope: section 5 in `api/jobs/jobs.controller.ts`, `api/jobs/jobs.ts`, `api/devices/devices.service.ts:544-548`, `api/devices/device-updates-actions.ts:91`, and `edge:81-83`.
Acceptance: A1 passes. Each refusal answers its status and reason. A repeat answers 200 and writes no second audit row.

**CF1.** Scope: section 6 in `fe/jobs/job-detail.*`, `job-detail-fields.ts`, `job-detail.store.ts`, `job-fields.ts`, `jobs.*`, `jobs.store.ts`, and their specs.
Acceptance: C1 and C2 pass. On a mocked API, the pages match states 01 to 07. Focus returns to the control after the question (UI-09).

**CQ1.** Scope: rehearse on `api-e2e:client-review-mock` with screenshots, through the UI and the API.

- Cancel a Queued job and a running job of `UPD`, `CMD`, and `STS`. The second write job of a customer queues behind the first.
- `REF` has no waiting status (`016:224-227`, `:831-834`), so no queued `REF` fixture exists. The rehearsal cancels both `REF` forms while they run.
- Acceptance: each waiting cancel ends Cancelled at once, with every operation Cancelled.
- Each running write cancel settles no new result after its round in flight and ends Cancelled.
- A `CMD` job with issued commands keeps its polls and ends Cancelled.
- A Refresh all cancel ends Cancelled at once and marks no device removed. A selected-device cancel keeps its stored batches.
- Lint, tests, and builds of the affected projects pass. Live Google writes stay not verified (`record:106`).

**Shared files.** Each shared file sits on one dependency path, so no two parallel cards edit one file.

| File                                                                      | Cards, in merge order                             |
| ------------------------------------------------------------------------- | ------------------------------------------------- |
| `deployment/postgres/migrations/017-jobs.sql`                             | CB1 (`017:4-7`), then CB2                         |
| `api/src/app/jobs/jobs.ts`, `jobs.test.mjs`                               | CB1, then CB6                                     |
| `frontend/src/app/jobs/job-fields.ts`, `job-fields.spec.ts`               | CB1, then CF1                                     |
| `frontend/src/app/jobs/job-detail-fields.ts`, `job-detail-fields.spec.ts` | CB1 (`fe/jobs/job-detail-fields.ts:21`), then CF1 |
| `frontend-e2e/src/*` progress fixtures                                    | CB1, then CF1                                     |

Every other file belongs to one card. CB2 owns `index.mjs`, `008`, and the integration files of rows S1 to S14.
CB3 owns `device-update.ts`. CB4 owns both refresh runners. CB5 owns `job-service.ts` and `job-service.integration.mjs`.
CB6 owns the device gates. CF1 owns `jobs.store.ts`. CB3, CB4, and CB5 share no file, so they run in parallel after CB2.

## Risks

1. A running batch stops sending within 30 seconds. Requests sent before the flag settle from their answers (`record:78`).
2. A retry wait ends at its next send. A long quota backoff therefore delays the final status, not a new request.
3. A lost runner with a request waits for the 10-minute heartbeat before recovery ends it (`017:716-717`).
4. A selected-device batch whose read before the upsert precedes the cancel stores its devices. Its finish records no batch (`016:941-943`).
5. An Unknown row keeps a cancelled job in attention until a person reconciles it (`record:245`).
6. The `REF` question uses drafted copy, and the owner accepted it at the sign-off (O1). Live Google device writes stay unverified (`record:106`).
