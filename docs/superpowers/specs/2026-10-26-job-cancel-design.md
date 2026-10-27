# Technical design addendum: universal job cancel (Cancel pending work)

Status: design for review. Card `t_e31b9cb4`.
Record: `docs/workflows/batch-update-export-import.md`. The record stays proposed. Its cancel rules are owner-settled (`record:71-82`, `:192-207`, `:218-223`).
Mockup: `docs/ui/designs/2026-10-26-job-cancel*`, states 01 to 07 and the notes. On 2026-10-26 the owner approved it: "Thats fine."
The same answer accepted no cancel reason and the 30-second cancel check (mockup questions 1 and 2).
Extends: [device-write jobs](2026-10-16-device-write-jobs-design.md), [worker contracts](2026-10-19-device-write-worker-contracts.md), [device command jobs](2026-10-21-device-command-jobs-design.md), and [status jobs](2026-10-23-wipe-powerwash-deprovision-design.md).
Owner direction, 2026-10-19: "We are building a doghouse. We dont need to choose the curtains."

## Conventions

- Paths are relative to the repository root at `f2d67a0`, the base of this card.
- `git diff 89d5478 f2d67a0` changes docs only. The code lines that the technical design cites hold at this base.
- `record:N` cites the record. `td:N` cites `docs/research/batch-update-export-import-technical-design.md`.
- `016`, `017`, `002`, and `008` name files in `deployment/postgres/migrations/`. `worker:N` cites `worker/src/device-update.ts`.
- `edge:N` cites `deployment/bootstrap/application-edge.mjs`. `ac/` is `libs/application-contracts/src/lib/`.
- `api/` is `api/src/app/`, and `fe/` is `frontend/src/app/`. `mock:` names `node_modules/@campuscommander/admin-sdk-mock/dist/src/`, version 0.2.0.
- `choice N` and `state NN` name the composition choices and the PNG states of the mockup notes.
- The parallel docs card stores the notes under `docs/ui/designs/2026-10-26-job-cancel*`. The base holds no copy, so this design cites choice numbers.

## Decision summary

1. Contracts add the `cancelled` job status, the `cancelled` operation outcome, the `cancelled` count, the cancel request, and `jobs:manage`.
2. `POST /api/jobs/{jobId}/cancel` stores the request. A waiting job ends at once. A running job ends after its worker stops.
3. The request lives on the `cc.jobs` row. Each batch claim and each lease renewal read it under the job row lock.
4. Unsent operations settle Cancelled. Cancelled wins over Needs review in the shared terminal rule.
5. Issued commands keep their polls. A full sync publishes nothing. A refresh of selected devices keeps its stored batches.
6. `jobs:manage` sees every job of its customer. A cancelled job with a failed or Unknown operation raises attention.
7. The Jobs pages build choices 1 to 15. Google's `CANCELLED` command keeps its red Failed row.
8. Six backend cards, one frontend card, and one qa card build the slice. `IMP` and `EXP` reuse the contract of section 8.

## 1. Contracts

- `jobStatusSchema` (`ac/jobs.ts:45-55`) adds `cancelled`, a finished status (`td:885`).
- `jobOutcomeSchema` (`ac/jobs.ts:140-147`) adds `cancelled`. Only an operation that never left the worker reaches it.
- `jobProgressSchema` (`ac/jobs.ts:82-98`) adds a required `cancelled` count. A refresh job answers 0.
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

| Status | Reason                 | When                                                                             |
| ------ | ---------------------- | -------------------------------------------------------------------------------- |
| 404    | `job-not-found`        | No such job, or the person cannot see it (`017:318-330`).                        |
| 403    | `cancel-not-permitted` | The person sees the job but holds no right to cancel it (`record:102`).          |
| 409    | `job-finished`         | The job finished without a cancel request (`td:822`).                            |
| 409    | `nothing-to-stop`      | The job is Awaiting devices, or no operation is pending (`record:81`, `td:830`). |

`ac/jobs.ts` exports the four reasons as `jobCancelRefusalSchema`. The client reads them.

## 2. Schema

Each change edits the migration in place. Development data is disposable.

**`cc.jobs`** (`017:17-45`):

- The status check (`017:23-24`) adds `cancelled`.
- A `cancelled` counter joins the counters (`017:29-33`). `cc.refresh_device_update_counters` (`017:410`) counts it.
- `cancel_requested_at timestamptz` and `cancel_requested_by uuid` join the header. A check sets both columns or neither.
- `cancel_requested_by` references `cc.application_principals(id)`, as `requested_by` does (`017:25`).
- A second check holds `status<>'cancelled' OR cancel_requested_at IS NOT NULL`.
- A cancelled job leaves `jobs_one_running` and `jobs_admission` through its status (`017:48-51`).

**Operations.** The status check of `cc.device_update_operations` adds `cancelled` (`017:223`).
A new `cc.cancel_device_update_pending` mirrors `cc.skip_device_update_pending` (`017:464-476`). It writes `cancelled` with the reason `cancel-requested`.
`cc.settle_device_update_operations` (`017:1008`) accepts `cancelled` for a dispatched operation that never left the worker. It accepts it only when the job holds a request.

**Cancel request function.** `cc.request_job_cancel(p_actor uuid, p_version integer, p_customer text, p_display_id text)` returns the job and its answer.

1. It takes the admission lock of the customer (`017:552`), then the `cc.jobs` row `FOR UPDATE`.
2. It answers `job-not-found` when `cc.job_visible` refuses the person (`017:318-330`).
3. It answers `cancel-not-permitted` unless the person requested the job or holds `jobs:manage` for its customer.
4. A job that already holds a request answers its current state. The first person and time stay.
5. A finished job answers `job-finished`. Awaiting devices, or no pending operation, answers `nothing-to-stop`.
6. An Accepted, Queued, or Held job stores the request and settles every operation Cancelled. It ends `cancelled` at once.
7. A running job stores the request and nothing else. Its worker settles the operations.
8. Each stored request bumps the revision and records one change through `cc.record_job_change` (`017:362`).
9. It inserts the audit row of section 5 in the same transaction.

**Stop reason.** `cc.device_update_stop_reason` takes no job argument (`017:520-529`).
The claim and the renewal therefore read the request from the job row that they lock (`017:761`, `:932`).
The claim puts the request first among its stop reasons (`017:776-778`). Its pending operations settle Cancelled, not Skipped.
The renewal (`017:922`) answers a stop to a batch whose job holds a request. A recorded `failure` stays in its column.

**Terminal rule.** `cc.device_update_terminal_status` (`017:424-431`) adds `WHEN j.cancelled>0 THEN 'cancelled'` before the Needs review rule (`017:426`).
Its four callers inherit the rule (`017:1388`, `:1676`, `:1751`, `:1793`). A job without a Cancelled operation keeps the built rule (`td:861`).

**Refresh jobs.** `cc.device_sync_lease` (`016:329`) raises a cancel error for a job with a request. Each staged page passes through it (`016:634`, `:680`).
`cc.abandon_device_sync` then closes the job through `cc.close_refresh_job` (`016:242`, `:278`).
`cc.close_refresh_job` sets `cancelled`, not `failed`, when the job holds a request (`017:480-484`).
`cc.read_entity_sync_batch` (`016:899`) answers `cancelled` for a job with a request. The batches that `cc.finish_entity_sync_batch` stored stay (`016:917`).

**Visibility and grants.** `cc.job_visible` accepts `jobs:manage` as well as `jobs:read` (`017:326`). `cc.job_reader` does the same (`017:2784`).
Record default 17 sets this rule (`record:244`). Each new function joins the grant list of its caller (`017:2814-2815`).
The event check of `cc.security_events` adds `job-cancel-requested` (`008:2`).

**Lock order.** The built writers share one order. They lock an advisory lock, the job row, the batch row, operations by number, then the detail row.
The claim (`017:760-811`), the renewal (`017:932-956`), and the settle (`017:1122-1156`) follow it. Admission takes the customer admission lock first (`017:552-584`).

| Writer                                    | Lock order                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `cc.request_job_cancel`, waiting job      | Admission lock, job row, operations by number (`017:469`), detail row           |
| `cc.request_job_cancel`, running job      | Admission lock, job row. It locks no operation row.                             |
| Claim, renewal, and settle with a request | As built. The cancel sibling locks operations by number under the job row lock. |
| `cc.close_refresh_job` with a request     | As built in `cc.abandon_device_sync` (`016:242-282`)                            |

No built writer takes a job row and then the admission lock. The cancel never takes the global claim lock (`017:760`).
The cancel and admission therefore serialize on the admission lock, and no cycle forms.

## 3. The worker

**Update and status batches.**

- The claim call (`worker:1854`) answers `done` once the job holds a request. The worker starts no new batch.
- The renewal call (`worker:1477`) runs every 30 seconds (`worker:1344`). Its stop answer ends the send loop.
- A lost lease aborts the batch through the stop signal (`worker:1505`, `:1527`). A cancel stop sets a drain flag instead.
- The send loop reads the drain flag before each Google request. It sends no request after the flag.
- A sent request settles from its answer (`017:1008`). A lost answer stays Unknown and goes to the read-back (`td:839`).
- The same settle call writes `cancelled` for each claimed operation that never left the worker.
- A written field keeps its read-back. The verification functions ignore the request (`017:1406`, `:1476`).
- A read-back sends no write (`td:840`). The finish step runs as built (`worker/src/dispatch.ts:303`).

**Command batches.** The issue runs on the same batch path, so the claim and the renewal stop it.

- An issued command keeps the operation status `issued`. The finish moves the job to Awaiting devices (`017:1665`, `:1740`).
- Polls continue through the built poll functions (`017:1809-1819`, `:1882`).
- `cc.complete_device_command_job` ends the job Cancelled after its last settle (`017:1781`, `:1793`).
- The page shows Cancellation requested until then (`record:79`).

**Refresh jobs.**

- The full sync stages each page through the lease check (`worker/src/device-sync.ts:129-146`). The cancel error ends the page loop.
- The worker then abandons the sync. It never calls `cc.finish_device_sync` (`worker/src/device-sync.ts:163`).
- It therefore publishes nothing and removes no device (`worker/src/device-sync.ts:169-211`, `td:850`).
- A refresh of selected devices reads each batch first (`worker/src/entity-sync.ts:164`). A `cancelled` answer ends the run.
- The batches that it stored keep their writes (`worker/src/entity-sync.ts:223-234`, `:281`).

## 4. The job service

- Admission reads Accepted, Queued, and Held jobs only (`017:555`). A cancelled job leaves that set, so admission skips it.
- `holdReleased` (`api/jobs/job-service.ts:105`) adds `cancelled`. `changed` and `cleanup` then release the hold (`:227-231`, `:395-418`).
- The write slot frees with the status change. `jobs_one_running` covers `running` only (`017:48-49`).
- The next queued job then starts in admission order (`td:863`).
- Recovery (`017:684-694`) treats a running job with a request as stopped. It dispatches no new start and runs the finish.
- The request and the final status each record one change. The relay sends both as built (`api/jobs/job-service.ts:472`, `:490`).

## 5. The API

- A handler for `POST :displayId/cancel` joins the controller (`api/jobs/jobs.controller.ts:92`), beside the reconcile route (`:221-223`).
- The handler calls `cc.request_job_cancel` with the actor and the permission version, as the reads do (`api/jobs/jobs.ts:889`).
- The SQL function decides. The handler maps its answer to the statuses of section 1.
- The requester, a `jobs:manage` holder, or a platform administrator can cancel (`record:75`, `:197`).
- A platform administrator passes through the `jobs:manage` grant of its preset (`ac/authorization.ts:112`).
- The edge allows the new path (`edge:81-83`).
- The audit row in `cc.security_events` (`002:15`) holds the person, the time, the customer, and the job display ID.
- It holds no reason (mockup question 2). A repeated request writes no second row.
- A repeated request answers 200 with the current summary (`td:821`).
- A command job answers `nothing-to-stop` once its worker issues every command (`record:81`, `:222`).
- `jobSummary` (`api/jobs/jobs.ts:178`) maps the `cancelled` counter and the request. The person uses the shape of `requestedBy` (`:196`).
- The attention rule (`api/jobs/jobs.ts:822-826`) adds `cancelled` when the job holds a failed or Unknown operation (`record:245`).
- Reconcile reads the operation status (`api/jobs/jobs.ts:719-720`). An Unknown row of a cancelled job keeps Reconcile (`record:80`).
- The running counts read `running` and `awaiting-devices` (`api/jobs/jobs.ts:772`, `:780`). A cancelled job counts as finished.
- Each `jobs:read` gate also accepts `jobs:manage`: `api/jobs/jobs.ts:889`, `api/devices/devices.service.ts:545`, and `api/devices/device-updates-actions.ts:91`.

## 6. The client

| Part            | Decision                                                                                            | Source                                              |
| --------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Control         | Outlined "Cancel pending work", right of Refresh, in a right-hand group 8 px apart                  | Choices 1 and 2, `fe/jobs/job-detail.html:10-19`    |
| Who sees it     | A `canCancel` rule mirrors `canReconcile`: the requester, `jobs:manage`, or a platform grant        | `record:73`, `fe/jobs/job-detail-fields.ts:323-340` |
| Hidden          | Awaiting devices, no pending operation, a finished job, or a person without the right               | Mockup notes, no control shown                      |
| Question        | The Revert all changes shell: 480 px, two paragraphs, both named by `aria-describedby`              | Choice 3                                            |
| Title and body  | "Cancel pending work on UPD-001?" with the running body of state 02 or the waiting body of state 05 | Choices 4 to 6                                      |
| Dismiss         | "Keep job running" or "Keep job waiting"                                                            | Choice 7                                            |
| After request   | The control reads "Cancellation requested", disabled interactive                                    | Choice 8                                            |
| Banner          | "Cancellation requested · The job stops within 30 seconds" until every operation settles            | Choice 9, `record:79`                               |
| Identity line   | "Cancellation requested by {person} · {time}" in the shape of the Deprovision reason line           | Choice 10, `fe/jobs/job-detail-fields.ts:343`       |
| Status chip     | "Cancelled" in the neutral tone                                                                     | Choice 11, `fe/jobs/job-fields.ts:91`               |
| Cancelled row   | Neutral "Cancelled" chip, the note "Not sent to Google", the settle time, and no action             | Choice 12                                           |
| Counts          | The built Cancelled counter reads the count. No counter joins it.                                   | Choice 13                                           |
| Latest activity | A cancel sentence leads. The built sample sentences follow.                                         | Choice 14, `fe/jobs/job-detail-fields.ts:658`       |
| Grid cell       | "38 succeeded" over "1 failed · 1 unknown · 8 cancelled"                                            | Choice 15, `fe/jobs/job-fields.ts:210`              |

Built behavior that changes:

1. The Cancelled counter stays 0 today (`fe/jobs/job-detail-fields.ts:108`, `:143`). It reads `progress.cancelled`, and the comment at `:108` goes.
2. `JOB_STATUS_LABELS` (`fe/jobs/job-fields.ts:52`) adds "Cancelled". The status filter reads its labels from it (`:64-66`, `:314-321`).
3. `progressLines` falls back for a status that it does not name (`fe/jobs/job-fields.ts:210`). `cancelled` gets its own case.
4. `recentLine` (`fe/jobs/job-fields.ts:233`) lists a cancelled job with the finished jobs (`td:878`).
5. `outcomeTone` and `operationChip` add the neutral Cancelled outcome (`fe/jobs/job-detail-fields.ts:30`, `:58`).
6. A command that Google cancelled keeps its red Failed chip and its sentences (`fe/jobs/job-detail-fields.ts:437`, `:453`).
7. An app cancel never uses those sentences. The two rows never look alike (choice 12).
8. `attentionCount` stays (`fe/jobs/job-detail-fields.ts:148-150`). The API rule of section 5 raises the bell dot.

## 7. Tests

| Decision       | Target                                                                                                    | Proof                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Contracts      | `libs/application-contracts/src/lib/jobs.test.mjs`                                                        | Each schema parses `cancelled` and the request. A progress without `cancelled` fails.         |
| Schema         | The Postgres tests of `deployment/postgres/`, on a fresh database                                         | A waiting cancel ends the job with every row Cancelled. A running cancel changes no row.      |
| Terminal rule  | The same Postgres tests                                                                                   | One Cancelled row and one Unknown row end `cancelled`. No Cancelled row keeps the built rule. |
| Lock order     | The same Postgres tests, two sessions                                                                     | A cancel during an admission waits on the admission lock and raises no deadlock.              |
| Update worker  | `worker/src/device-update.test.mjs`                                                                       | A stop at renewal sends no new request. Sent requests settle. Unsent rows read `cancelled`.   |
| Read-back      | `worker/src/device-update.test.mjs`                                                                       | A written field of a cancelled job still gets its read-back.                                  |
| Refresh worker | The device sync and entity sync tests of `worker/src/`                                                    | A stopped full sync never finishes. A stopped selected refresh keeps its first batch.         |
| Job service    | The job service tests of `api/src/app/jobs/`                                                              | A cancelled job releases its hold and its slot. The next queued job starts.                   |
| API            | `api/src/app/jobs/jobs.test.mjs`, a new route test beside `jobs-reconcile-route.test.mjs`                 | Each refusal, the repeat, the audit row, and a `jobs:manage` reader.                          |
| Client         | `frontend/src/app/jobs/*.spec.ts`, `frontend-e2e/src/job-detail.spec.ts`, `frontend-e2e/src/jobs.spec.ts` | Each row of section 6 against a mocked API.                                                   |
| Mock rehearsal | `api-e2e:client-review-mock` (`docs/testing/client-review.md:33`)                                         | Card CQ1.                                                                                     |

The `medium` mock seed serves 7,000 devices (`docs/testing/client-review.md:45`). A small `CC_DEVICE_UPDATE_BATCH_SIZE` keeps a job running (`worker/src/google-connection.ts:52`).
The mock delays slow each answer (`mock:control/control.js:179-191`). A second write job queues behind the running one (`017:48-49`).

## 8. Contract for the validation and export jobs

The `IMP` and `EXP` slices implement these rules. This plan holds no card for them.

1. The kind joins the kind check, the display ID check (`017:19`), `jobDisplayIdSchema` (`ac/jobs.ts:19`), and the edge path (`edge:74`).
2. The header lives in `cc.jobs` with the cancel columns. `cc.request_job_cancel` ends a waiting job of the kind at once.
3. Its worker reads the request at each batch claim and each lease renewal (`record:242`).
4. A stopped validation produces no report and no plan. Its stored refresh reads stay (`td:851`).
5. A stopped export deletes its partial file. A Sheet export answers `nothing-to-stop` once its Sheet write starts (`record:243`, `td:852`).
6. The kind ends through the shared terminal rule. A Cancelled row ends the job Cancelled.
7. A cancel of the update job of an import ends its waiting status jobs in the same transaction (`record:82`, `:220`).
8. That cancel locks the update job row, then each status job row in display ID order.
9. The import question names each status job it ends (`td:869`). The CSV slice draws that question.

## Open item

O1. No mockup state draws the question for a refresh job. Refresh jobs count pages, so the body needs its own count sentence.
The mockup build notes name this gap. CF1 ships the `REF` control after the owner answers its wording. Until then, CQ1 cancels `REF` jobs through the API.

## Card plan

| ID  | Title                                                              | Profile  | Depends on      |
| --- | ------------------------------------------------------------------ | -------- | --------------- |
| CB1 | Contracts: the cancelled status, count, request, and `jobs:manage` | backend  | none            |
| CB2 | Schema: the cancel request, the stop, and the terminal rule        | backend  | CB1             |
| CB3 | Worker: drain update, status, and command batches                  | backend  | CB2             |
| CB4 | Worker: stop refresh jobs                                          | backend  | CB2, CB3        |
| CB5 | Job service: hold, slot, and recovery                              | backend  | CB2             |
| CB6 | API: the cancel route, authorization, audit, and attention         | backend  | CB2, CB5        |
| CF1 | Jobs pages: Cancel pending work                                    | frontend | CB6             |
| CQ1 | Rehearse the cancel on admin-sdk-mock                              | qa       | CB1 to CB6, CF1 |

- IDs are local to this design. Each card that changes a contract updates every consumer, including the `api-e2e` and `frontend-e2e` fixtures.
- CB6 opens the route last, so each cancel that it stores has a worker that reads it.

**CB1.** Scope: section 1 in `ac/jobs.ts:45-55`, `:82-98`, `:123`, `:140-147`, `ac/authorization.ts:3-56`, and the action row at `017:4-7`.
It fixes each consumer that the wider enums break, such as `JOB_STATUS_LABELS` (`fe/jobs/job-fields.ts:52`).
Until CB2, `jobSummary` answers `cancelled: 0` and `cancelRequest: null` (`api/jobs/jobs.ts:178`).
Acceptance: the Contracts row of section 7 passes. `frontend:build`, `api:test`, and `worker:test` pass. A session with a `jobs:manage` grant parses.

**CB2.** Scope: section 2 in `017`, `016:329`, `:899`, and `008:2`.
Acceptance: the Schema, Terminal rule, and Lock order rows of section 7 pass. A seeded Queued job ends `cancelled` with 18 Cancelled rows.
A seeded running job keeps its rows until its next claim. `cc.job_visible` admits a `jobs:manage` holder.

**CB3.** Scope: the update and command parts of section 3 in `worker:1344-1530`, `:1854`, the send loop, and `worker/src/dispatch.ts:268-332`.
Acceptance: the Update worker and Read-back rows pass. A stopped command batch leaves its issued rows `issued`.

**CB4.** Scope: the refresh part of section 3 in `worker/src/device-sync.ts:119-211`, `worker/src/entity-sync.ts:164-291`, and `worker/src/dispatch.ts:172-267`.
Acceptance: the Refresh worker row passes. A full sync stopped on its second page publishes no event and marks no device removed.

**CB5.** Scope: section 4 in `api/jobs/job-service.ts:105`, `:227-231`, and `:358-418`.
Acceptance: the Job service row passes. A cancelled Held job releases its hold. A cancelled running job frees the slot for the next job.

**CB6.** Scope: section 5 in `api/jobs/jobs.controller.ts`, `api/jobs/jobs.ts:178-233`, `:772-780`, `:820-826`, `:889`, and `edge:81-83`.
It also covers `api/devices/devices.service.ts:545` and `api/devices/device-updates-actions.ts:91`.
Acceptance: the API row passes. Each refusal answers its status and reason. A repeat answers 200 and writes no second audit row.

**CF1.** Scope: section 6 in `fe/jobs/job-detail.*`, `job-detail-fields.ts`, `job-detail.store.ts`, `job-fields.ts`, and `jobs.*`.
Acceptance: the Client row passes. On a mocked API, the pages match states 01 to 07. Focus returns to the control after the question (UI-09).

**CQ1.** Acceptance: on admin-sdk-mock, cancel a waiting job and a running job of `REF`, `UPD`, `CMD`, and `STS`, with screenshots.
Each running cancel stops within 30 seconds. A `CMD` job with issued commands keeps its polls and ends Cancelled.
Lint, tests, and builds of the affected projects pass. Live Google writes stay not verified (`record:106`).

**Shared files.** Each shared file sits on one dependency path, so no two parallel cards edit one file.

| File                                                    | Cards, in merge order  |
| ------------------------------------------------------- | ---------------------- |
| `deployment/postgres/migrations/017-jobs.sql`           | CB1 (`:4-7`), then CB2 |
| `api/src/app/jobs/jobs.ts`, `jobs.test.mjs`             | CB1, then CB6          |
| `worker/src/device-update.ts`, `device-update.test.mjs` | CB1, then CB3          |
| `worker/src/dispatch.ts`                                | CB3, then CB4          |
| `frontend/src/app/jobs/job-fields.ts` and its specs     | CB1, then CF1          |
| `frontend-e2e/src/*` progress fixtures                  | CB1, then CF1          |

## Risks

1. A running batch takes up to 30 seconds to stop. Requests sent in that time settle normally (`record:317`).
2. An Unknown row keeps a cancelled job in attention until a person reconciles it (`record:245`).
3. CB1 touches many fixtures. It merges first, and each later card starts from it.
4. The `REF` question waits for the owner (O1).
5. Live Google device writes stay unverified (`record:106`).
