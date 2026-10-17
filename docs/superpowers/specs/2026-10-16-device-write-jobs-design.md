# Technical design: annotated-location writes, write jobs, the admission hold, and the jobs API

Status: proposed technical design, revision 2, 2026-10-16. Author: architect. Not owner-approved product behavior.
Slice: development order step 4 (`docs/current-work.md:58`). The intake brief (eng-lead, 2026-10-16, revision 3) is the contract.
Owner decisions D1 to D6 in that brief are binding. This record invents no product behavior.
Section 10.2 records the eng-lead rulings on the open questions of revision 1 and the one question that stays open.

## Conventions

- Code references name a repository path and line at commit `72cd2c3`, the base of branch `codex/device-write-jobs-design`.
- `mock@v0.2.0:` references name files of admin-sdk-mock at tag `v0.2.0`. `package.json:12` pins that release.
- PR #33 (`codex/delegation-401-classification`) merged as `18b0e38`. origin/main `a81b432` contains it. Implementation cards branch from origin/main.
- `main@a81b432:` references name files at origin/main `a81b432`. Section 4.3 uses them for the 401 classification of PR #33.
- origin/main moves lines in four cited files. In `libs/google-connection/src/lib/provider.ts`, lines 115-121 move to 121-127.
  Lines 122-126 move to 116-120. Lines after 126 move down by one. `docs/current-work.md:58` moves to line 66.
  `docs/workflows/device-browsing.md:141` moves to line 143. `frontend/src/app/shell/shell.html:121-127` moves to lines 122-128.
  No other cited file differs between `72cd2c3` and `a81b432`.
- "Job service" names the logical owner of admission, hold updates, and terminal cleanup (`docs/portfolio/03-architecture.md:63-67`). Section 6.5 places it.
- Development databases are disposable (`AGENTS.md:27-29`). Nothing below migrates, upgrades, or preserves existing development data.

Terms. Each term names one thing in this record.

| Term           | Meaning                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution      | One Kestra execution of a flow.                                                                                                                                      |
| Dispatch token | The identity of the current execution of one write job. Section 5.3.                                                                                                 |
| Attempt        | One worker request that works on one batch or one read-back. Each request draws a new UUID.                                                                          |
| Lease          | The time until which one attempt owns one batch. Section 5.4.                                                                                                        |
| Read-back      | A GET by device ID that settles an `unknown` operation. Section 5.7.                                                                                                 |
| Reconcile      | The job detail action that starts a read-back of one operation. Section 2.6.                                                                                         |
| Overlay        | A row of `cc.device_write_overlays`. It protects a written value from lagged lists. Section 5.8.                                                                     |
| Open request   | A request that left the worker without a definitive answer: a transient answer, a lost answer, a lost part, a fatal batch error, or an abort in flight. Section 7.1. |
| Tick           | The 5-second timer of the job service. Section 6.5.                                                                                                                  |

## Revision 2 changes

| Finding | Change                                                                                                                      | Sections            |
| ------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| R1      | Job events use their own channel. Each browser stream forwards an explicit allowlist. Backoff reports never use Redis.      | 3.1, 3.3, 6.3       |
| R2      | A dispatch state machine with start deadlines, token rotation, batch leases, fenced recording, and a fencing finish.        | 5.3, 5.4, 5.5, 5.10 |
| R3      | An operation with an open request stays `unknown` until read-back. First-attempt refusals stay `failed`.                    | 7.1                 |
| R4      | One fenced publication path for write responses and read-backs. Overlays end only by list convergence or expiry.            | 5.8                 |
| R5      | A full sync carries an unknown total while it runs, accepts zero and large inventories, and records each target path.       | 1.2, 1.3            |
| R6      | Job events invalidate. Clients reread authoritative REST state. The attention rule includes failed jobs.                    | 2.5, 3.4            |
| R7      | The stored selection records its change time. An expired selection reports `expiredAt`.                                     | 2.8                 |
| R8      | Token failures keep their code. Only scope failures deny write access.                                                      | 4.2, 7.2            |
| R9      | The job service validates attempt, lease, sequence, and report age before each hold write.                                  | 6.3                 |
| R10     | Every reference uses a full path. A script printed each claim beside its cited lines. A separate audit checked every claim. | all                 |

The eng-lead note of 22:56 confirms that PR #33 merged. The conventions and section 4.3 record it.

## Design sources for the screens

| Screen                                  | Source                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| Bulk Actions and the selection footer   | Figma `94:3`, `213:4199`, `216:4309`                                                  |
| Expired selection                       | Figma `105:189`                                                                       |
| Draft page "Update N devices"           | Figma `94:75`                                                                         |
| Preview "Review N device updates"       | Figma `97:21`, expired preview `104:434`                                              |
| Confirmation "Confirm N device updates" | Figma `97:57`                                                                         |
| Receipt page "Update job created"       | Figma `104:74`                                                                        |
| Jobs page                               | Figma `106:109`, states `231:5009`, `234:4950`, `234:5142`, `234:5325`, `234:5510`    |
| Job detail                              | Figma `104:209`, `231:4707`, `228:4524`                                               |
| Jobs activity area                      | Approved mockup (D6), `docs/ui/designs/2026-10-16-jobs-activity-area.html` and `.png` |

The eng-lead adds the activity-area files to the repository. This design names their path only.

## 1. Data model

### 1.1 Decision: one job header table and detail tables per kind

Add migration `deployment/postgres/migrations/017-jobs.sql`. Add its ID to the explicit list in `deployment/postgres/index.mjs:97-128`.
The migration adds a header table `cc.jobs` for every background job. Refresh jobs keep `cc.entity_sync_jobs` as their detail table. Write jobs get new detail tables.

Do not widen `cc.entity_sync_jobs` into the write-job table. The reasons:

- `cc.entity_sync_jobs` stores targets as one JSON ID array with batch slicing (`deployment/postgres/migrations/016-device-inventory.sql:58-73`, `deployment/postgres/migrations/016-device-inventory.sql:401-417`).
  Write jobs need one durable row per operation with a stable ID, a baseline, a requested value, and an outcome (`docs/ui/jobs-grid.json:150-159`).
  Failed rows keep evidence for inspection (`docs/ui/jobs-grid.json:170`). Attempt history stays durable (`docs/portfolio/03-architecture.md:214-219`).
- Retention differs by kind. Refresh jobs stay 7 days. Write jobs stay permanently. The purge today deletes finished refresh jobs after one day (`deployment/postgres/migrations/016-device-inventory.sql:439-456`).
- The Jobs grid sorts and filters every kind together (`docs/ui/jobs-grid.json:24-33`, `docs/ui/jobs-grid.json:84-121`). One header table gives one index and one keyset. A union of unlike tables does not.
- A full sync keeps no history. Its actor clears at abandon and at finish (`deployment/postgres/migrations/016-device-inventory.sql:166`, `deployment/postgres/migrations/016-device-inventory.sql:342`). A header row records each Refresh all with its requester.

Migration placement: `017-jobs.sql` creates the new objects. It also changes 016 objects with `ALTER TABLE` and `CREATE OR REPLACE FUNCTION`.
The runner rejects an edited applied migration (`deployment/postgres/index.mjs:151-156`). A new file keeps 016 intact. The current definition of a changed function is the one in 017.
017 assumes a fresh installation. Developers recreate their databases. Rollback: revert the commit and recreate the database. No down migration exists, by owner direction (`AGENTS.md:27-29`).

### 1.2 `cc.jobs`

| Column                                                   | Type and rule                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job_id`                                                 | `uuid` primary key. Kestra execution IDs never replace it (`docs/portfolio/03-architecture.md:213-214`).                                                                                                                                                                        |
| `display_id`                                             | `text` unique, for example `UPD-006` or `REF-031`. Section 1.6.                                                                                                                                                                                                                 |
| `customer_id`                                            | `text` references `cc.google_connection(customer_id)`, as `deployment/postgres/migrations/016-device-inventory.sql:60` does.                                                                                                                                                    |
| `kind`                                                   | `inventory-refresh` or `device-update`.                                                                                                                                                                                                                                         |
| `scope_kind`                                             | `devices` (an ID list) or `all-devices` (a full sync).                                                                                                                                                                                                                          |
| `status`                                                 | `accepted`, `queued`, `held`, `running`, `completed`, `completed-with-errors`, `failed`, `needs-review`. No `cancelled` in this slice.                                                                                                                                          |
| `requested_by`                                           | `uuid` not null. It references `cc.application_principals(id)`, like the nullable column at `deployment/postgres/migrations/016-device-inventory.sql:66`. No Kestra flow has a trigger, so a person requests every job.                                                         |
| `generation`                                             | `integer` not null. The connection generation at creation.                                                                                                                                                                                                                      |
| `target_count`                                           | `integer` null. A check constraint ties it to `scope_kind`. `devices` requires 1 to 100,000, the cap of `deployment/postgres/migrations/016-device-inventory.sql:63`. `all-devices` holds null while the sync runs. Its finish stores the observed count, 0 or more, unbounded. |
| `target_org_unit_paths`                                  | `text[]` null. The distinct OrgUnit paths of the targets, sorted. ID-list jobs set it at creation. A full sync sets it at finish from `cc.job_targets`.                                                                                                                         |
| `succeeded`, `failed`, `unknown`, `skipped`              | `integer` not null default 0. Section 1.3 defines them for refresh jobs. Section 5.5 defines them for write jobs.                                                                                                                                                               |
| `failure`                                                | `text` null. The job-level failure code. The vocabulary of `deployment/postgres/migrations/016-device-inventory.sql:69-71` plus `permission-changed` and `connection-changed`.                                                                                                  |
| `revision`                                               | `bigint` not null default 1. Every change that a reader can see increments it in the same transaction. Section 3.4.                                                                                                                                                             |
| `correlation_id`                                         | `uuid` not null.                                                                                                                                                                                                                                                                |
| `created_at`, `admitted_at`, `started_at`, `finished_at` | `timestamptz`. `created_at` defaults to `clock_timestamp()`.                                                                                                                                                                                                                    |

Indexes:

- `(customer_id, created_at DESC, display_id DESC)` serves the Jobs grid sort and keyset pages.
- A unique partial index on `(customer_id) WHERE kind='device-update' AND status='running'` enforces one active write job.
- A partial index on `(customer_id, target_count, created_at, display_id) WHERE kind='device-update' AND status IN ('accepted','queued','held')` serves admission order.
- A partial index on `(customer_id, finished_at DESC) WHERE finished_at IS NOT NULL` serves the Recent section and the attention rule.

### 1.3 Refresh jobs as jobs

ID-list refresh (the stale-page refresh):

- `cc.create_entity_sync_job` (`deployment/postgres/migrations/016-device-inventory.sql:358-382`) inserts the header first. It sets `kind='inventory-refresh'`, `scope_kind='devices'`, status `running`, `target_count` to the ID count, and `started_at` to `created_at`.
- The same transaction inserts one `cc.job_targets` row per ID. The row takes the OrgUnit path from `cc.devices.org_unit_path` (`deployment/postgres/migrations/016-device-inventory.sql:34`).
  Device rows are never deleted (`deployment/postgres/migrations/016-device-inventory.sql:3`), so every requested ID has a path.
- 017 adds a foreign key from `cc.entity_sync_jobs.job_id` to `cc.jobs(job_id) ON DELETE CASCADE`.
- `cc.finish_entity_sync_batch` (`deployment/postgres/migrations/016-device-inventory.sql:419-437`) recomputes the header counters from the batch records.
  A redispatched batch replaces its record (`deployment/postgres/migrations/016-device-inventory.sql:429`), so the counters never count a batch twice.
  `succeeded` counts the devices of completed batches. `failed` counts the devices of failed batches. Batch `i` holds `min(batch_size, n - i*batch_size)` devices.
- At the last batch: no failure gives `completed`. A failure with at least one completed batch gives `completed-with-errors`. A failure with no completed batch gives `failed`.
- `cc.abandon_entity_sync_job` (`deployment/postgres/migrations/016-device-inventory.sql:384-398`) sets the header to `failed` with `orchestration-unavailable`.

Full sync (Refresh all):

- `cc.request_device_sync` (`deployment/postgres/migrations/016-device-inventory.sql:130-157`) inserts a header with `scope_kind='all-devices'`, status `running`, and `target_count` null. It uses the header `job_id` as `sync_id`.
- When the request replaces an expired sync (`deployment/postgres/migrations/016-device-inventory.sql:146-151`), it closes the header of that sync as `failed` with `interrupted`.
- `cc.stage_devices` (`deployment/postgres/migrations/016-device-inventory.sql:304-310`) upserts one `cc.job_targets` row per staged device with the listed OrgUnit path and the staging time.
  It sets `succeeded` to the number of distinct staged devices and increments `revision`.
- `cc.finish_device_sync` (`deployment/postgres/migrations/016-device-inventory.sql:321-347`) sets `target_count` to the number of job targets and `target_org_unit_paths` to their distinct paths.
  No failure gives `completed`. A failure gives `failed` with that code.
  A telemetry failure keeps its current record (`deployment/postgres/migrations/016-device-inventory.sql:337`) and leaves the job status unchanged.
- `cc.abandon_device_sync` (`deployment/postgres/migrations/016-device-inventory.sql:159-171`) sets the header to `failed` with `orchestration-unavailable`.
- An empty inventory finishes with `target_count` 0, `target_org_unit_paths` `{}`, and status `completed`.
- An inventory above 100,000 devices finishes normally. The 100,000 cap applies only to `devices` scopes.
- The requester stays on the header after `sync_actor` clears (`deployment/postgres/migrations/016-device-inventory.sql:342`).

Progress: an ID-list refresh reports `total` as `target_count`. A running full sync reports `total` null and `pending` null. Its `succeeded` counts the devices observed so far.
Refresh jobs carry no confirmer. They read Google and change nothing in Google.

### 1.4 Write-job tables

`cc.device_update_previews`, one row per prepared preview:

| Column                                          | Rule                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `preview_id`, `display_id`                      | `uuid` primary key and a `PV-006` style ID. Figma `97:21` shows "Preview PV-006".                                     |
| `customer_id`, `created_by`                     | The customer and the person who prepared the preview.                                                                 |
| `permission_version`, `generation`              | The creator's permission version and the connection generation at preparation.                                        |
| `field`, `mode`, `value`                        | `annotatedLocation`, `replace` or `clear`, and the value. The value is null for Clear.                                |
| `action_version`                                | `integer`, 1 in this slice. A change of the action semantics increments it (`docs/portfolio/03-architecture.md:199`). |
| `selected`, `eligible`, `unchanged`, `excluded` | Counts. Selected equals the sum of the other three.                                                                   |
| `oldest_observed_at`                            | The oldest `last_entity_sync` among eligible targets.                                                                 |
| `manifest_digest`                               | SHA-256 over the action version, field, mode, value, and the ordered eligible device IDs with baselines.              |
| `prepared_at`, `expires_at`                     | `expires_at = prepared_at + 15 minutes` (`docs/portfolio/03-architecture.md:196`).                                    |
| `job_id`                                        | `uuid` null, unique. Confirmation sets it once. This blocks a second job.                                             |

`cc.device_update_preview_targets`, the frozen target list: `preview_id`, `ordinal`, `device_id`, `serial_number`, `org_unit_path`, `observed_value`, `observed_at`, `disposition` (`eligible`, `unchanged`, `excluded`), and `exclusion_reason`.
Primary key `(preview_id, ordinal)`. Unique `(preview_id, device_id)`.

`cc.device_update_jobs`, one row per write job. Primary key `job_id` references `cc.jobs(job_id)`:

| Column                                                                         | Rule                                                                                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `preview_id`                                                                   | Unique. The confirmed preview.                                                                     |
| `field`, `mode`, `value`                                                       | Copied from the preview.                                                                           |
| `confirmed_by`, `confirmer_permission_version`                                 | The confirming person and that person's permission version at confirmation. Section 2.4.           |
| `delegated_subject`                                                            | The Google subject that the credential delegates to.                                               |
| `batch_size`, `batch_count`                                                    | The write batch size at confirmation, 1 to 250 (section 5.2), and the resulting number of batches. |
| `dispatch_token`, `dispatch_count`, `start_deadline_at`, `kestra_execution_id` | The current execution, the number of executions started, and the claim deadline. Section 5.3.      |
| `first_claimed_at`, `heartbeat_at`                                             | The first batch claim and the last worker call for the job. Section 5.3.                           |
| `backoff_attempt`, `backoff_sequence`, `backoff_reported_at`                   | The newest accepted backoff report. Section 6.3.                                                   |
| `hold_attempt`, `hold_sequence`, `hold_written_at`, `hold_cleaned_at`          | The report behind the last hold write, and the hold registry. Sections 6.3 and 6.4.                |
| `manifest_artifact_id`, `result_artifact_id`                                   | The evidence files in `cc.artifacts`. Section 5.9.                                                 |

`cc.device_update_batches`, one row per batch. Primary key `(job_id, batch)`. Columns: `attempt_id`, `execution_id`, `lease_expires_at`, `claimed_at`, and `settled_at`. The row holds the lease of section 5.4.

`cc.device_update_operations`, one row per eligible target. Confirmation creates the rows from the preview targets in its transaction:

| Column                                                                 | Rule                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `job_id`, `operation_number`                                           | Primary key. The stable operation ID is `<display_id>-<operation_number>`, for example `UPD-006-3`.                 |
| `device_id`, `serial_number`, `org_unit_path`                          | From the frozen target. Each target's OrgUnit path stays with its operation (D5).                                   |
| `baseline_value`, `requested_value`                                    | The observed value at preview and the approved final value. `requested_value` is null for Clear.                    |
| `batch`                                                                | `(operation_number - 1) / batch_size`, with the job's `batch_size`.                                                 |
| `status`                                                               | `pending`, `dispatched`, `succeeded`, `failed`, `unknown`, `skipped`. Section 5.5.                                  |
| `attempt_id`                                                           | The attempt that last claimed the operation.                                                                        |
| `google_status`, `google_reason`, `quota_retries`, `transient_retries` | The final part answer and its retry history, from `BatchFailure` (`libs/google-connection/src/lib/batch.ts:35-49`). |
| `observed_value`, `observed_at`, `verified_by`                         | The value Google returned, its stamp, and its source: `write-response` or `read-back`.                              |
| `outcome_reason`                                                       | A product code, for example `not-found`, `value-differs`, `interrupted`, or `verification-failed`.                  |
| `verify_attempt`, `verify_lease_expires_at`, `verify_after`            | The read-back claim, its lease, and the earliest read-back time. Section 5.7.                                       |
| `updated_at`                                                           | The time of the last outcome change.                                                                                |

`cc.device_write_overlays`, primary key `(customer_id, device_id, field)`. Columns: `value`, `observed_at`, `source` (`write-response`, `read-back`, `refresh-read`), `job_id`, `operation_number`, and `expires_at`. Section 5.8 defines its rules.

`cc.job_targets`, primary key `(job_id, device_id)`. `job_id` references `cc.jobs(job_id) ON DELETE CASCADE`. Columns: `org_unit_path` and `observed_at`.
It records the OrgUnit path of each refresh target (D5). Write jobs record the path on their operations.

`cc.job_activity_seen`: `principal_id` primary key and `seen_at`. The activity attention dot clears per person (OQ5 ruling).

### 1.5 Retention

`cc.purge_jobs(p_customer, p_limit)` replaces `cc.purge_entity_sync_jobs` (`deployment/postgres/migrations/016-device-inventory.sql:439-456`).
`DeviceRefresh.dispatch` calls it where it calls the old purge (`api/src/app/devices/device-refresh.ts:39-43`). The job service also calls it on its tick.

- It keeps the interruption rule. An ID-list refresh unfinished after 2 hours ends with `interrupted` (`deployment/postgres/migrations/016-device-inventory.sql:447-448`).
- It closes a running full-sync header without a live sync lease (`deployment/postgres/migrations/016-device-inventory.sql:113`) as `failed` with `interrupted`.
- It deletes `inventory-refresh` headers finished more than 7 days ago. The cascade removes their detail, batch, and target rows.
- It deletes unconfirmed previews 24 hours after `expires_at`, with their targets.
- It deletes expired overlays.
- It never deletes `device-update` jobs, their operations and batches, or confirmed previews.

### 1.6 Job ID allocation

- Sequences `cc.job_number_upd`, `cc.job_number_ref`, and `cc.preview_number_pv` allocate numbers.
  One installation serves one customer (`deployment/postgres/migrations/016-device-inventory.sql:90`, `WHERE singleton`), so one sequence per prefix suffices.
- The display format is the prefix, a hyphen, and the number with at least three digits. Use `CASE WHEN n < 1000 THEN lpad(n::text, 3, '0') ELSE n::text END`.
  Plain `lpad(n::text, 3, '0')` truncates `1000` to `100`.
- Sequence gaps after a rolled-back transaction are acceptable. Display IDs stay unique. They do not count jobs.
- The API resolves `display_id` to `job_id` for every job route.

### 1.7 Grants

- Grant `SELECT` on the new tables and `EXECUTE` on the new functions to the runtime role, as the 016 block does (`deployment/postgres/index.mjs:249-271`).
- Every function is `SECURITY DEFINER` with `search_path=pg_catalog,cc`, as `cc.device_reader` is (`deployment/postgres/migrations/016-device-inventory.sql:86-87`).
  Every function is revoked from `PUBLIC`, as `deployment/postgres/migrations/016-device-inventory.sql:458-470` does.
- Functions that the API calls for a person take `(p_actor, p_version)` and check grants, as `cc.device_reader` does (`deployment/postgres/migrations/016-device-inventory.sql:86-100`).

## 2. API contracts

### 2.1 Actions

- Add `devices:write`, `devices:bulk-actions`, and `jobs:read` to `actionSchema` (`libs/application-contracts/src/lib/authorization.ts:3-16`).
  Give each the scope kinds `platform` and `district` in `actionScopeKinds` (`libs/application-contracts/src/lib/authorization.ts:28-43`).
- 017 inserts the three actions into `cc.application_actions`, as `deployment/postgres/migrations/016-device-inventory.sql:4` does for `devices:read`.
- The bootstrap grants every action to the first administrator (`deployment/bootstrap/application-access.mjs:86-91`).
  The `platform-administrator` preset takes every action (`libs/application-contracts/src/lib/authorization.ts:98`). No bootstrap change is needed.
- Preview and confirmation require `devices:read`, `devices:write`, and `devices:bulk-actions` (eng-lead ruling 9). The write-access routes require `devices:write`.
- Jobs routes require `jobs:read`. Reconcile requires `jobs:read` and `devices:write` (OQ6 ruling).
- Interim visibility (D5): a holder of `jobs:read` at platform or district scope sees every job of the customer. No other scoping exists in this slice.

### 2.2 Contract files

- Add `libs/application-contracts/src/lib/device-updates.ts` and `libs/application-contracts/src/lib/jobs.ts`. Export both from `libs/application-contracts/src/index.ts`.
- Use `zod` strict objects, as `libs/application-contracts/src/lib/entity-cache.ts:62-98` does. Timestamps use `z.iso.datetime({ offset: true })` (`libs/application-contracts/src/lib/entity-cache.ts:5`).
- Change `deviceSelectionSpecSchema` (`libs/application-contracts/src/lib/devices.ts:246-259`) as section 2.8 states.

Shared schemas in `jobs.ts`:

| Schema               | Shape                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobDisplayIdSchema` | `^(UPD\|REF)-\d{3,}$`                                                                                                                                                                                                                    |
| `jobStatusSchema`    | The eight statuses of section 1.2.                                                                                                                                                                                                       |
| `jobActionSchema`    | `update-device-annotations` (label "Update device annotations") and `refresh-inventory` (label "Refresh inventory").                                                                                                                     |
| `jobProgressSchema`  | `total` (null for a running full sync), `succeeded`, `failed`, `unknown`, `skipped`, and `pending` (null when `total` is null).                                                                                                          |
| `jobSummarySchema`   | `jobId`, `displayId`, `revision`, `action`, `status`, `scope` (`kind`, and `deviceCount` or null), `requestedBy` (`id`, `displayName`), `createdAt`, `startedAt`, `finishedAt`, `progress`, `failure`.                                   |
| `jobDetailSchema`    | The summary plus `confirmedBy`, `previewDisplayId`, `field`, `mode`, `requestedValue`, `targetOrgUnitPaths`, `correlationId`.                                                                                                            |
| `jobOperationSchema` | `operationId`, `deviceId`, `serialNumber`, `orgUnitPath`, `operation` (`replace` or `clear`), `baselineValue`, `requestedValue`, `outcome`, `outcomeReason`, `googleStatus`, `googleReason`, `observedValue`, `verifiedBy`, `updatedAt`. |
| `jobActivitySchema`  | Section 2.5.                                                                                                                                                                                                                             |
| `jobEventSchema`     | A discriminated union with one member: `{ type: 'job-changed', jobId, displayId, revision }`. Section 3.1.                                                                                                                               |
| `jobEventsChannel`   | `cc:job-events:{customerId}`.                                                                                                                                                                                                            |

The `outcome` of a `dispatched` operation reads `pending`. The API never shows `dispatched` as success.

### 2.3 Preview create and get

`POST /api/devices/updates/previews`

- Body: `gridId` and `tabId`, the selection key (`libs/application-contracts/src/lib/devices.ts:210-212`), plus `mode` and `value`.
- `value` rules for `replace`: a string of 1 to 200 code points, counted as `[...value].length`, and not whitespace only. The API does not trim it. `clear` takes no `value` and writes `null`.
- The server reads the caller's stored selection for that tab (`api/src/app/devices/devices.service.ts:371-378`). It resolves the selection against current data and current grants.
  The client never sends device IDs as the authority.
- An expired selection returns `409 selection-expired` with `expiredAt` (section 2.8). An empty selection returns `422 nothing-selected`.
- B3 adds `selectionIdsSql` beside `selectionCountSql` (`api/src/app/devices/device-query.ts:314-324`). Filter and group terms skip removed devices (`api/src/app/devices/device-query.ts:151`).
  An explicit addition whose device carries `removed_at` (`deployment/postgres/migrations/016-device-inventory.sql:46`) stays in the preview as `excluded` with reason `removed`.
- The server freezes every selected device into `cc.device_update_preview_targets` with its observed value and OrgUnit path.
- Dispositions: `eligible` when the observed value differs from the final value. `unchanged` when it equals the final value.
  `excluded` with a reason for a removed device and for a device ID that fails the plain-identifier check (`deployment/postgres/migrations/016-device-inventory.sql:371-375`).
- A selection above 100,000 devices returns `422 selection-too-large` (candidate default 7).
- Response `201`: `previewId`, `displayId`, `mode`, `value`, counts, `oldestObservedAt`, `stale`, `preparedAt`, `expiresAt`, and `manifestDigest`.
  `stale` is true when an eligible target is older than `ENTITY_FRESHNESS_HOURS` (`libs/application-contracts/src/lib/entity-cache.ts:13-15`).

`GET /api/devices/updates/previews/:previewId` returns the same summary to its creator. Another person receives `404`. A preview past `expiresAt` returns `410 preview-expired` (Figma `104:434`).

`GET /api/devices/updates/previews/:previewId/targets?disposition=&cursor=&limit=` pages the frozen targets in ordinal order, at most 1,000 per page.
Each row holds the device ID, serial number, field, observed value, approved value, disposition, and exclusion reason. Figma `97:21` shows Device, Field, Observed value, and Approved value.

The preview and the job keep durable frozen targets (`docs/portfolio/03-architecture.md:185`). New matching devices never join them (`docs/ui/patterns.md:90`).

### 2.4 Confirm

`POST /api/devices/updates/previews/:previewId/confirm`

- Body: `manifestDigest` and `acknowledged: true`. The acknowledgment backs the checkbox "I reviewed all N devices and their final values." (Figma `97:57`).
- Only the preview creator confirms. No second approver exists (candidate default 22). The confirmer is therefore the requester in this slice.
- One transaction revalidates identity, grants, the permission version, the digest, the action version, and the expiry (`docs/portfolio/03-architecture.md:192`).
  It also checks the connection generation (section 5.6).
- The transaction creates the `cc.jobs` and `cc.device_update_jobs` rows with status `accepted`. It copies eligible targets into operations and sets `preview.job_id`.
  The accepted job row is the dispatch outbox (`docs/portfolio/03-architecture.md:193`).
- A preview with `job_id` set returns `200` with the existing receipt. A second click or a replayed request never creates a second job.
- Errors: `410 preview-expired`, `409 preview-changed` (digest mismatch), `409 permission-changed`, `409 connection-changed`, `422 nothing-to-update`, and `403` for missing actions.
  A preview with zero eligible targets never becomes a job (OQ7 ruling).
- Response `201`: `jobId`, `displayId`, `status: accepted`, `deviceCount`, and `updateCount`. The receipt page "Update job created" (Figma `104:74`) renders it.
- After the commit, the job service runs admission (section 6.5). A missed run repeats on the next tick.

### 2.5 Jobs list, detail, operations, activity

| Route                                                             | Behavior                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/jobs`                                                   | Filters: `jobId` (exact display ID), `status` (list), `action` (list), `entityType` (list), `requestedBy` (principal IDs), `createdFrom`, `createdTo`, `finishedFrom`, `finishedTo`. Sort `createdAt` descending, then `displayId` descending (`docs/ui/jobs-grid.json:24-33`). Keyset `cursor` and `limit` up to 100. Returns `jobs`, the `matching` count, and `observedAt`. |
| `GET /api/jobs/:displayId`                                        | `jobDetailSchema`. `404` for an unknown or purged job.                                                                                                                                                                                                                                                                                                                         |
| `GET /api/jobs/:displayId/operations?attention=&cursor=&limit=`   | Operations in operation-number order, at most 1,000 per page. `attention=true` returns only `failed` and `unknown` rows. Job counts stay unchanged (`docs/ui/jobs-grid.json:160-161`). Refresh jobs return `operations: []`.                                                                                                                                                   |
| `POST /api/jobs/:displayId/operations/:operationNumber/reconcile` | Section 2.6.                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/jobs/activity`                                          | `jobActivitySchema`, below.                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/jobs/activity/seen`                                    | Stores `clock_timestamp()` in `cc.job_activity_seen` for the caller.                                                                                                                                                                                                                                                                                                           |
| `GET /api/jobs/events`                                            | Server-sent events. Section 3.3.                                                                                                                                                                                                                                                                                                                                               |

The filters are the seven filter fields of the Jobs grid (`docs/ui/jobs-grid.json:89-118`). The list exposes no other filter (`docs/ui/jobs-grid.json:119`).
`entityType` has one value, `device`, in this slice.

`jobActivitySchema` follows the OQ1 ruling and note 3 of the approved mockup:

| Field                  | Content                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running`              | `count` of every running job, and `jobs`: up to 50 running jobs, newest `createdAt` first, then `displayId` descending.                              |
| `waiting`              | `count` of every accepted, queued, and held job, and `jobs`: up to 50 of them in admission order (section 6.5).                                      |
| `recent`               | `count` of every job finished in the last 24 hours, and `jobs`: the 10 most recently finished.                                                       |
| `attention`            | True when a job finished as `needs-review`, `completed-with-errors`, or `failed` after the caller's `seenAt`. A null `seenAt` counts every such job. |
| `seenAt`, `observedAt` | The caller's last `seen` time and the read time.                                                                                                     |

Every summary carries `revision`. The panel offers "View all jobs" for rows beyond a section cap (card F5).
Note 2 of the approved mockup marks finished jobs that "need review or ended with errors". A failed job ended with errors, so the rule includes `failed`.

### 2.6 Reconcile one operation

- The route accepts only an operation with outcome `unknown`. Other outcomes return `409 operation-settled`.
- The API claims the read-back of that operation with a new attempt through `cc.claim_device_update_verification` (section 5.7).
  It then starts the Kestra flow `device_update_reconcile` with the job, the operation number, and the attempt. It returns `202` with the operation.
- An operation under a live read-back lease returns `202` and starts no second flow. A failed start leaves the claim to expire after 120 s. The person can then try again.
- The worker reads the device with GET. It never writes. Section 5.7 gives the settlement rule. Section 5.10 derives the job status again.
- The settlement increments the job `revision` and publishes `job-changed`. An open job detail then rereads the job and its visible operations page (section 3.4).

### 2.7 Write access state

`GET /api/devices/updates/access` returns `state` (`granted`, `denied`, `unavailable`, `unchecked`), `scope`, `failure`, and `checkedAt`.
`POST /api/devices/updates/access/check` runs the check again and returns the same shape. Section 4.2 defines the states.
The Devices page reads the state to enable or disable Update device.
The paths sit two levels under `/api/devices/`, so they never match `GET /api/devices/:deviceId` (`api/src/app/devices/devices.controller.ts:208-216`).

### 2.8 Selection expiry

- Eng-lead ruling 24 keeps the expired-selection state in this slice. SELECT-01 requires the state and a reselection request, and keeps approved jobs (`docs/ui/patterns.md:89`).
  The browsing record defers the state to the first device action (`docs/workflows/device-browsing.md:141`).
- Today a missing or expired selection parses as an ordinary empty selection (`api/src/app/devices/device-selection.ts:42-51`).
  Redis drops it 12 hours after its last change (`api/src/app/devices/device-selection.ts:13-14`, `api/src/app/devices/device-selection.ts:171`).
- The stored state (`api/src/app/devices/device-selection.ts:19-24`) gains `changedAt`. Every change writes it.
- The Redis TTL becomes 12 hours plus a 24-hour marker window. The expiry rule stays 12 hours after the last change.
- `parseSelection` returns the state and `expiredAt`. A state older than 12 hours reads as empty, with `expiredAt` set to `changedAt` plus 12 hours.
- `deviceSelectionSpecSchema` (`libs/application-contracts/src/lib/devices.ts:246-259`) gains `expiredAt`, a timestamp or null. `DevicesService.selection` (`api/src/app/devices/devices.service.ts:400-415`) returns it.
- Queries that use the selection still treat an expired selection as empty. The first change after expiry starts from empty and clears `expiredAt`.
- Preview create on an expired selection returns `409 selection-expired` (section 2.3).
- Previews and jobs never read the browsing selection. Their frozen targets stay valid after the selection expires.
- After the marker window, Redis drops the key, and the selection reads as never made.
- The client shows the expired-selection state of Figma `105:189` and asks for reselection.
  The draft page keeps its field values. Figma `94:75` states "Your draft stays available when you filter, scroll, or refresh."

## 3. Live updates

### 3.1 Channels and event allowlists

- Keep the channel `cc:entity-events:{customerId}` (`libs/application-contracts/src/lib/entity-cache.ts:52-53`) and `entityEventSchema` (`libs/application-contracts/src/lib/entity-cache.ts:86-98`) unchanged.
  Write batches publish its existing `entity-batch` member.
- Add the channel `cc:job-events:{customerId}` with `jobEventSchema` (section 2.2). Job events never travel on the entity channel.
- `EventFanout` hardcodes the entity channel and schema (`api/src/app/devices/device-events.ts:49`, `api/src/app/devices/device-events.ts:91-101`).
  Card B4 lets each listener name its channel and its parser. One subscriber connection still serves every channel (`api/src/app/devices/device-events.service.ts:5-16`).
- `streamEvents` forwards every parsed event to the browser (`api/src/app/devices/device-events.ts:233-237`). Card B4 adds a required `allow` set of event types.
  An event outside the set never reaches the sink.
- The Devices stream (`api/src/app/devices/devices.controller.ts:167-206`) allows `entity-batch`, `job-finished`, and `full-sync`. The Jobs stream allows `job-changed`.
- Backoff reports never use Redis pub/sub. Postgres stores them (section 6.3). No browser stream can carry them.
- The existing Devices consumer sees no new event type. It listens for four names (`frontend/src/app/devices/devices.store.ts:528-534`).
  It already handles `entity-batch` (`frontend/src/app/devices/devices.store.ts:597-599`).

### 3.2 Publishers

| Change                                                                             | Publisher                                                                         | Events                                                  |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| A write job is accepted, labeled, admitted, abandoned, or finalized by the reaper  | The job service (API)                                                             | `job-changed`                                           |
| A refresh job is created                                                           | The API (`api/src/app/devices/device-refresh.ts:52-76`) and the full-sync request | `job-changed`                                           |
| A batch or a read-back settles, a refresh batch or page records, or a job finishes | The worker, after its commit                                                      | `job-changed`, and `entity-batch` for published devices |

- Every publisher publishes after its Postgres commit, with the committed `revision`.
- Progress events of one job publish at most once every 5 seconds. Status changes publish at once.
- The API Redis rule allows `subscribe` but not `publish` (`deployment/redis/runtime.mjs:10-11`). Card P1 adds `+publish`.
- The worker rule allows `publish` only on `cc:entity-events:*` (`deployment/redis/runtime.mjs:12-14`). Card P1 adds `&cc:job-events:*`.
- Keys and channels stay under `cc:*` (`deployment/redis/README.md:20`).

### 3.3 `GET /api/jobs/events`

- A Jobs controller serves the stream with `streamEvents` and the allowlist `job-changed`.
- The stream requires `jobs:read` at open. Each ping rechecks the session and `jobs:read`, as the Devices stream rechecks its access (`api/src/app/devices/devices.controller.ts:186-202`).
  A failed recheck closes the stream.
- The edge proxies the stream with the event idle timeout. Today only `/api/devices/events` gets that timeout (`deployment/bootstrap/application-edge.mjs:196-197`). Card P1 adds the jobs path.
- The shell opens the jobs stream on every page, because the activity area lives in the shell. The Devices page keeps its own stream.

### 3.4 Client resynchronization

JOB-02 asks for row refresh on ordinary invalidations and resynchronization after a replay gap (`docs/ui/patterns.md:268-271`). The client applies these rules:

- A `job-changed` event is an invalidation. The client never merges event data into its state.
- Each resource reloads through one single-flight reader: the activity summary, the open Jobs page, and the open job detail with its visible operations page.
- An event marks the affected readers dirty. A dirty reader starts one REST read after 250 ms. An event during a read marks the reader dirty again. The reader then reads once more.
- Reads of one resource never overlap. Each read returns committed state at least as new as the previous read. A delayed event therefore never regresses a job.
- Every stream open, first or after a reconnect, marks every reader dirty.
  The stream starts after its subscription is active (`api/src/app/devices/device-events.ts:199-202`), so this read closes the gap.
- The job detail reader reloads when an event names its job with a higher `revision` than the one shown. A Reconcile settlement therefore refreshes the counts and the visible operation rows.
- The activity badge shows `running.count` from the latest activity read. Counts never come from capped row lists.

### 3.5 Devices grid in place

- Write and read-back settlements publish `entity-batch` with the published device IDs.
- The Devices store reloads those rows by ID (`frontend/src/app/devices/devices.store.ts:597-599`). The rows come from the server projection, which holds the accepted value (section 5.8).
- The device record keeps its current schema (`libs/application-contracts/src/lib/devices.ts:60-81`). The grid shows no verification indicator (OQ2 ruling). The job detail shows each operation's outcome and update time.

## 4. Write-scope capability

### 4.1 Setup scope list (D2)

- Add capability `device-changes` to `GOOGLE_CAPABILITIES` (`libs/application-contracts/src/lib/google-capabilities.ts:2-69`):
  - `label`: "ChromeOS device changes".
  - `scope`: `https://www.googleapis.com/auth/admin.directory.device.chromeos`.
  - `method`: `chromeosdevices.patch`. `requiredForConnection`: false. `enabled`: true. `qualified`: false.
  - `evidence`: "admin-sdk-mock v0.2.0 only. No live write check."
- Add `device-changes` to `GOOGLE_SETUP_CAPABILITY_IDS` after `device-telemetry` (`libs/application-contracts/src/lib/google-capabilities.ts:72-77`).
  `GOOGLE_SETUP_SCOPES` then lists the scope (`libs/application-contracts/src/lib/google-capabilities.ts:83-91`). Copy scopes on the connection page includes it.
- `GOOGLE_CUSTOMER_SCOPES` stays unchanged, because the capability is not required for connection (`libs/application-contracts/src/lib/google-capabilities.ts:93-102`). Read-only districts still connect.
- The mock harness grants every `GOOGLE_CAPABILITIES` scope (`api-e2e/admin-sdk-mock-fixture.mjs:24-27`). The new scope reaches the mock delegation without a harness change.

### 4.2 Capability evaluation

- The check mints a token for the write scope alone through `scopedClient` (`libs/google-connection/src/lib/provider.ts:251-288`).
  It then lists one device with that token (`chromeosdevices.list`, `maxResults=1`). The mock accepts the write scope for reads (`mock@v0.2.0:src/auth/scopes.ts:18-21`).
- The check never writes. An empty device collection still proves the grant.
- The check keeps the failure code that `failure()` assigns (`libs/google-connection/src/lib/provider.ts:84-150`).

| Check result                                    | State         | Shown                                                                                                                      |
| ----------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Success                                         | `granted`     | Update device is enabled.                                                                                                  |
| `delegation-not-authorized` or `scope-mismatch` | `denied`      | The scope-named message of section 4.3.                                                                                    |
| Any other failure code                          | `unavailable` | The label and recovery of that code (`libs/application-contracts/src/lib/google-health.ts:81-154`), with a Recheck action. |
| No check yet                                    | `unchecked`   | A pending check.                                                                                                           |

- `network-failure`, `quota`, and `provider-unavailable` stay `unavailable` (`libs/google-connection/src/lib/provider.ts:135-148`). They do not establish a missing scope.
- `permission-denied` stays `unavailable`. Its recovery states that Google did not identify a specific cause (`libs/application-contracts/src/lib/google-health.ts:114-118`).
  A 403 therefore does not prove a missing write scope.
- The API runs the check in process, as the connection check reads Google in process (`api/src/app/auth/google-connection.service.ts:392-402`).
  It caches the result for `GOOGLE_HEALTH_FRESH_SECONDS` (300 s, `libs/application-contracts/src/lib/google-health.ts:8`).
- A write job that observes `delegation-not-authorized` or `scope-mismatch` sets the state to `denied` at once (section 7.2). Other job failures leave the state unchanged.
- `googleHealthCapabilitySchema` stays limited to the connection capabilities (`libs/application-contracts/src/lib/google-health.ts:10-13`).
  The write-access state is a separate projection. The connection health page stays unchanged.

### 4.3 The scope-named message

- While the state is `denied`, Update device stays disabled with this message: "Google denied device changes. Add https://www.googleapis.com/auth/admin.directory.device.chromeos to the delegation client in the Google Admin Console."
- The message follows the owner rule that Devices access messages name the denied scope (`docs/workflows/device-browsing.md:118`).
- Google and the mock answer an ungranted scope with 401 `unauthorized_client` at token exchange (`main@a81b432:libs/google-connection/src/lib/provider.ts:115`, `mock@v0.2.0:src/auth/token.ts:103-113`).
  origin/main classifies that answer as `delegation-not-authorized` (`main@a81b432:libs/google-connection/src/lib/provider.ts:116-120`).
  At the branch base, the generic 401 rule wins (`libs/google-connection/src/lib/provider.ts:115-121`). PR #33 changed that order.
- While the state is `unchecked` or `unavailable`, Update device stays disabled with a Recheck action. The draft page never opens without `granted`.

### 4.4 One scope per token

- Every token carries exactly one scope. A token with another scope set fails with `scope-mismatch` (`libs/google-connection/src/lib/provider.ts:269-270`).
- Card P2 adds `patchAnnotatedLocations` beside `deviceBatch` in `libs/google-connection/src/lib/devices.ts`.
  Its `getClient` mints a write-scope token and keeps the mint failure, as `deviceBatch` does for the read scope (`libs/google-connection/src/lib/devices.ts:366-378`).
- Read-back uses the `device-inventory` scope, `admin.directory.device.chromeos.readonly` (`libs/application-contracts/src/lib/google-capabilities.ts:42-48`).
  `deviceBatch` mints its token for that scope (`libs/google-connection/src/lib/devices.ts:366-370`).
- Writes travel only inside the Directory batch endpoint, which the URL allowlist already names (`libs/google-connection/src/lib/provider.ts:217-218`).
  The per-device path is a part path that `validateRequests` checks (`libs/google-connection/src/lib/batch.ts:191-198`). The allowlist stays unchanged.
- Device IDs enter part paths only after the plain-identifier check (`deployment/postgres/migrations/016-device-inventory.sql:371-375`).

## 5. Execution

### 5.1 Kestra flows

- Add `deployment/kestra/device-update.yaml`, modeled on `deployment/kestra/entity-sync.yaml`. Inputs: `customerId`, `jobId`, `dispatchToken`, `batches`, and `correlationId`.
- A `ForEach` over batch indexes with `concurrencyLimit: 1` posts each batch to the worker `/dispatch/device-update-batch` (pattern: `deployment/kestra/entity-sync.yaml:17-36`).
- Each request uses the retry of `deployment/kestra/entity-sync.yaml:42-47`: `maxAttempts: 3`, 5 s apart.
  The worker answers 200 for every Google outcome and every fenced result. A retry therefore follows only a failed worker request.
- A final task posts `/dispatch/device-update-finish`. The flow `errors` tasks post the same request, so a failed flow also finishes. The finish is idempotent (section 5.10).
- The flow sets no flow-level concurrency limit. The job service admits one write job, and a unique index enforces it (section 1.2).
  A flow-level queue holds a superseded execution ahead of the current one (section 5.3).
- Add `deployment/kestra/device-update-reconcile.yaml` with one task that posts `/dispatch/device-update-reconcile`.
  Inputs: `customerId`, `jobId`, `operationNumber` (a number or `all`), `verifyAttempt` (only with a number), and `correlationId`.
- `OrchestrationService` gains `startDeviceUpdate` and `startDeviceUpdateReconcile`, modeled on `startEntitySync` (`api/src/app/orchestration/orchestration.service.ts:116-139`).
  Each deploys its flow before the execution (`api/src/app/orchestration/orchestration.service.ts:54-74`) and starts it through `execute` (`api/src/app/orchestration/orchestration.service.ts:77-98`).
- Worker handlers reuse the dispatch secret and JSON checks (`worker/src/dispatch.ts:141-160`, `worker/src/dispatch.ts:255-266`).
- Kestra 1.3.37 runs the flows (`deployment/kestra/runtime.json:5`). Card P1 proves the `errors` tasks on that version.

### 5.2 Batches

- One batch holds at most `batch_size` operations. The setting defaults to 250, the batch service limit (`libs/google-connection/src/lib/batch.ts:87`). One Kestra iteration sends one batch.
- The batch service keeps one multipart call in flight (`libs/google-connection/src/lib/batch.ts:97`). Batches of one job run in order.
- Each part is `PATCH /admin/directory/v1/customer/{customerId}/devices/chromeos/{deviceId}` with `projection=FULL` and the read field list (`libs/google-connection/src/lib/devices.ts:90-91`).
  The body is `{ "annotatedLocation": value }`. Clear sends `{ "annotatedLocation": null }`. The body names no other field.
- The batch service accepts a body for PATCH (`libs/google-connection/src/lib/batch.ts:160-167`, `libs/google-connection/src/lib/batch.ts:199-202`).
- The mock routes PATCH to `directory.chromeosdevices.patch` (`mock@v0.2.0:src/routes.ts:187-192`). It changes only the fields in the body (`mock@v0.2.0:src/directory/device-writes.ts:47`).
  `null` stores no value (`mock@v0.2.0:src/directory/device-writes.ts:61`).
- Card P2 adds an `onSend` hook to `BatchCall` (`libs/google-connection/src/lib/batch.ts:128-141`). `send` calls it with the request IDs right before the multipart request (`libs/google-connection/src/lib/batch.ts:674-681`).
  The worker uses it to learn which requests left the worker (section 7.1).

### 5.3 Dispatch state machine of a write job

| Step            | Trigger                                                                                     | Transition, in one Postgres transaction                                                                                                                                                     | Fence                                            |
| --------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Admit           | Admission (section 6.5)                                                                     | Status `running`, `admitted_at`, a new `dispatch_token`, `dispatch_count` 1, and `start_deadline_at` 120 s ahead.                                                                           | The unique running index and the admission lock. |
| Start           | After the admit commit                                                                      | No transaction. The job service starts the execution with the token. It then records `kestra_execution_id`.                                                                                 | None. Start and admission share no transaction.  |
| Refused start   | Kestra answers 4xx                                                                          | `cc.abandon_device_update_start`: status `failed`, failure `orchestration-unavailable`, and every operation `skipped`.                                                                      | Current token and null `first_claimed_at`.       |
| Unclaimed start | A tick finds `start_deadline_at` passed and `first_claimed_at` null                         | Below 3 executions: a new token, `dispatch_count` plus 1, a new deadline, and a new start. At 3: the Refused start transition.                                                              | Row lock and null `first_claimed_at`.            |
| First claim     | The first batch claim (section 5.4)                                                         | `first_claimed_at` and `started_at`.                                                                                                                                                        | Current token.                                   |
| Runner loss     | A tick finds `first_claimed_at` set, no live batch lease, and `heartbeat_at` 10 minutes old | Below 3 executions: a new token, `dispatch_count` plus 1, `heartbeat_at` set to now, and a new start. At 3: finalization (section 5.10) and a reconcile flow for every `unknown` operation. | Row lock and no live lease.                      |
| Finish          | The finish request (section 5.10)                                                           | A terminal status.                                                                                                                                                                          | Current token.                                   |

- Admission and the Kestra start share no transaction (`docs/portfolio/03-architecture.md:215`). The admitted job with its token and deadline is the durable dispatch intent.
  The admit transaction writes that intent with the `running` status (`docs/portfolio/03-architecture.md:193`). The intent survives an API exit between the commit and the start.
- An ambiguous start, such as a timeout, a network failure, or a 5xx answer, changes nothing at once. The start deadline resolves it.
- Token rotation reconciles an ambiguous start before another execution (`docs/portfolio/03-architecture.md:215`). Rotation requires that no batch lease lives.
  Every later call of the old execution names the old token and fails. The old execution therefore sends no request after the rotation.
- Every worker call for the job sets `heartbeat_at`: claims, renewals, recordings, and finish polls.

### 5.4 Batch claim, lease, and fencing

`cc.claim_device_update_batch(p_customer, p_job, p_token, p_batch, p_attempt, p_execution)` locks the job row and the batch row. It returns one result:

1. `superseded`: the job is not running, or the token is not current. The worker answers 200 with outcome `superseded` and sends nothing.
2. `stopped`: revalidation failed (section 5.6). The job failure is set, and pending operations become `skipped`.
3. `busy`: another attempt holds the batch, and its lease plus 30 s of grace has not passed. The worker polls the claim every 10 s in the same request, for at most 45 minutes.
   It sends nothing while busy.
4. `claimed`: the attempt owns the batch. A previous attempt whose lease plus grace passed is fenced first. Its `dispatched` operations become `unknown` with reason `interrupted`.
   The claim takes their read-back for `p_attempt`, with `verify_after` set to the fence time.
   The claim then sets every `pending` operation of the batch to `dispatched` under `p_attempt`.
   It returns those operations, the fenced operations for read-back, and the credential envelope, as `cc.read_entity_sync_batch` does (`deployment/postgres/migrations/016-device-inventory.sql:401-417`).
5. `done`: the batch holds no `pending` and no fenced operation. The worker sends nothing.

The 45-minute bound stays below the one-hour request timeout that the flow copies from `deployment/kestra/entity-sync.yaml:37-41`.
One batch call with 25 quota retries of up to 60 s each fits inside it (`libs/google-connection/src/lib/batch.ts:92-93`).
The claim commits before the worker contacts Google. This records intent first (`docs/portfolio/03-architecture.md:225-226`).

Lease rules:

- The claim sets `lease_expires_at` 180 s ahead. The worker renews it every 30 s and after each multipart round through `onBatch` (`libs/google-connection/src/lib/batch.ts:942-955`).
- `cc.renew_device_update_batch` requires a running job, the current token, the same attempt on the batch row, and a live lease.
- A rejected renewal aborts the batch call through its signal (`libs/google-connection/src/lib/batch.ts:136`).
  The run loop settles the requests in flight, fails the rest as `aborted`, and sends nothing more (`libs/google-connection/src/lib/batch.ts:578-584`).
- A local watchdog aborts the call 150 s after the start of the last successful claim or renewal request.
  The lease runs 180 s from a later database time. A round therefore starts with at least 30 s of lease left.
- One request lasts at most 10 s, the client timeout (`libs/google-connection/src/lib/provider.ts:240`). So no request of an attempt is in flight after its lease ends.
- Takeover, the finish, and the reaper act on an attempt only after its lease plus 30 s of grace.
- A graceful stop is a worker shutdown during a batch. The worker aborts the call, records the batch, and clears its lease.
  The next attempt then claims the batch at once.

Recording through `cc.settle_device_update_operations(p_customer, p_job, p_token, p_attempt, p_kind, p_results, p_observed_at)`:

- `p_kind` `write` requires a running job, the current token, the batch row held by `p_attempt` with a live lease, and each operation `dispatched` under `p_attempt`.
- `p_kind` `read-back` requires each operation `unknown`, with `verify_attempt` equal to `p_attempt` and a live read-back lease. The job is running or terminal.
- A result that fails its fence changes nothing: no outcome, no counter, no device row, and no overlay. The function returns the settled operations and the published device IDs.
- After a rejected write recording, the worker stops the batch and answers 200 with outcome `attempt-fenced`. Its operations stay `dispatched` until a takeover, the finish, or the reaper fences them.

### 5.5 Operation states

| From         | To           | Function                                | Condition                                                                         |
| ------------ | ------------ | --------------------------------------- | --------------------------------------------------------------------------------- |
| `pending`    | `dispatched` | Batch claim                             | The attempt claims the batch.                                                     |
| `dispatched` | `succeeded`  | Settle, `write`                         | A 2xx part answer.                                                                |
| `dispatched` | `failed`     | Settle, `write`                         | A definitive refusal, and no open request (section 7.1).                          |
| `dispatched` | `unknown`    | Settle, `write`                         | An open request, and no 2xx answer (section 7.1).                                 |
| `dispatched` | `pending`    | Settle, `write`                         | No request left the worker, and the job continues after a graceful stop.          |
| `dispatched` | `skipped`    | Settle, `write`                         | No open request and no 2xx answer, and the job stops (section 7.2).               |
| `dispatched` | `unknown`    | Batch claim, finish, reaper             | The lease plus grace of the attempt passed. Reason `interrupted`.                 |
| `pending`    | `skipped`    | Batch claim (`stopped`), finish, reaper | The job ends before dispatch.                                                     |
| `unknown`    | `succeeded`  | Settle, `read-back`                     | The read-back shows the requested value.                                          |
| `unknown`    | `failed`     | Settle, `read-back`                     | The read-back shows another value (`value-differs`) or answers 404 (`not-found`). |
| `unknown`    | `unknown`    | Settle, `read-back`                     | The read-back failed (`verification-failed`).                                     |

A terminal job holds no `pending` and no `dispatched` operation (section 5.10).

### 5.6 Revalidation before dispatch

`cc.claim_device_update_batch` checks these conditions before it claims:

1. The confirmer is enabled and keeps the permission version from confirmation (pattern: `deployment/postgres/migrations/016-device-inventory.sql:91-92`).
2. The confirmer's grants still include `devices:write` and `devices:bulk-actions` (pattern: `deployment/postgres/migrations/016-device-inventory.sql:93-95`).
3. The connection generation equals the job generation, and background access is allowed (`cc.google_current_generation`, `deployment/postgres/migrations/015-restore-revalidation.sql:13-26`).

A failed check sets the job failure `permission-changed` or `connection-changed`. Every `pending` operation becomes `skipped` with the same reason. The batch sends nothing.
This applies the rule "Revalidate queued work before dispatch" (`docs/portfolio/03-architecture.md:177`).

### 5.7 Read-back

- Read-back sends GET parts by ID through the batch service with the read-only inventory token (`libs/google-connection/src/lib/devices.ts:359-364`, `libs/google-connection/src/lib/devices.ts:366-378`).
- Card P2 adds `deviceStates` beside `deviceBatch`. It returns one result per ID. `deviceBatch` fails the whole read on the first failure (`libs/google-connection/src/lib/devices.ts:394-403`).
- The mock serves a `get` from current data. Only lists lag (`mock@v0.2.0:docs/guide/behavior.md:72-74`).
- `cc.claim_device_update_verification(p_customer, p_job, p_operations, p_attempt)` claims `unknown` operations without a live read-back lease. The lease lasts 120 s.
- A read-back starts no earlier than `verify_after`. For an operation with an open request, `verify_after` is 30 s after that request ended.
  For an operation that a takeover, the finish, or the reaper fenced, `verify_after` is the fence time. The lease plus grace already bounds its requests.
  The wait bounds the race with a delayed Google effect (section 10.1).
- The stamp is the Postgres clock before the GET, as refresh batches stamp their reads (`worker/src/entity-sync.ts:182-189`).
- The comparison uses the observation after `blank()` (`libs/google-connection/src/lib/devices.ts:102-104`). Clear matches a null observation. Replace matches the exact string.
- Settlement: the requested value gives `succeeded` with `verified_by=read-back`. Another value gives `failed` with `value-differs`.
  A 404 gives `failed` with `not-found` and soft-deletes the device, as `cc.soft_delete_devices` does (`deployment/postgres/migrations/016-device-inventory.sql:261-274`).
  Any other failure leaves the operation `unknown` with `verification-failed`.

Read-back runs in four places:

1. The batch attempt, after its PATCH call, for the new `unknown` operations of the batch. The write recording claims their read-back for the same attempt.
2. A takeover attempt, for the operations that its claim fenced.
3. The finish request, for `unknown` operations without a live read-back lease.
4. The reconcile flow: one operation for Reconcile, or every `unknown` operation after the reaper finalizes a job. For `all`, the worker claims and reads 250 operations at a time.

### 5.8 Publication and overlays

Observation kinds:

| Kind           | Source                                                                 | Stamp                                                                                 |
| -------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Write response | A 2xx PATCH part                                                       | The Postgres clock read right after the batch call returns.                           |
| Read-back      | A GET part of a read-back                                              | The Postgres clock read before the request.                                           |
| Refresh read   | A GET part of an ID-list refresh (`worker/src/entity-sync.ts:196-202`) | The Postgres clock read before the request (`worker/src/entity-sync.ts:182-189`).     |
| List           | A full-sync page (`worker/src/device-sync.ts:128-136`)                 | The staging time (`deployment/postgres/migrations/016-device-inventory.sql:304-310`). |

A list shows each device as it was some time earlier. A write response or a GET shows current data (`mock@v0.2.0:docs/guide/behavior.md:67-74`).
So the stamp of a list says nothing about the age of its values. The overlay rules keep current-value verification apart from list convergence.

Rules:

1. Publication happens only inside `cc.settle_device_update_operations`, for operations that the same transaction settles. A fenced result publishes nothing.
2. While a live overlay exists, the device row holds the overlay value in `annotated_location`. Every rule below keeps this true.
3. A write response or a read-back with a device body updates the other fields by the existing row rule (`deployment/postgres/migrations/016-device-inventory.sql:235`).
   It replaces the overlay when no overlay exists or the overlay is not newer.
   The new overlay holds the observed value, the stamp, the source, the job, the operation, and `expires_at` 36 hours after the stamp.
4. A refresh read moves an existing overlay to its value and stamp when the overlay is not newer. It never creates or deletes an overlay.
   017 replaces `cc.upsert_devices` (`deployment/postgres/migrations/016-device-inventory.sql:217-239`) for this rule.
5. A list observation with a live overlay: an equal value deletes the overlay. This is list convergence. A different value leaves the overlay value in place. The other fields follow the list.
   017 replaces `cc.stage_devices` (`deployment/postgres/migrations/016-device-inventory.sql:304-310`) to apply this rule through a new `cc.upsert_listed_devices`.
6. An expired overlay has no effect. `cc.purge_jobs` deletes it.
7. A read-back that answers 404 publishes a soft delete (section 5.7) and no overlay.

The 36-hour expiry follows the mock guide's quote of Google: some updates take up to 36 hours to show in lists (`mock@v0.2.0:docs/guide/behavior.md:69`).

| Sequence                                                       | Result                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Replace A (job 1), then Clear (job 2)                          | Job 2's write response is newer. It replaces overlay A with null. The row stores null.     |
| Write A, a matching GET, then a lagged list with the old value | The GET moves the overlay to its newer stamp. The lagged list differs, so the row keeps A. |
| The same, then a list that shows A                             | The list converges. It deletes the overlay. The row keeps A.                               |
| A refresh read sent before the write and recorded after it     | Its stamp is older than the overlay and the row. The row and the overlay keep A.           |
| An unknown operation settled by read-back                      | The read-back publishes like a write response, in the settling transaction.                |

After the commit, the worker:

- reads the published devices with `cc.read_device_records` (`deployment/postgres/migrations/016-device-inventory.sql:276-282`) and rewrites their Redis records (pattern: `worker/src/entity-sync.ts:237-255`),
- increments the query generation once per settle call with a publication (`libs/application-contracts/src/lib/entity-cache.ts:48-49`), so cached queries that filter on the field miss,
- publishes `entity-batch` with the published IDs (pattern: `worker/src/entity-sync.ts:272-281`) and then `job-changed`.

The device record schema stays unchanged (OQ2 ruling). The SQL projection (`deployment/postgres/migrations/016-device-inventory.sql:205-214`) and the row mapper (`api/src/app/devices/device-query.ts:265-294`) read the accepted value from `cc.devices`.

### 5.9 Evidence files

- Card B3 adds a `StorageService` method that stores one JSON document through the artifact store `stage` and `publish` (`api/src/app/storage/storage.service.ts:23-33`).
  The synthetic check uses the same calls (`api/src/app/storage/storage.service.ts:79-106`).
- Confirmation stores the frozen manifest first: the preview, the targets, the values, the requester, and the confirmer. An artifact failure fails the confirmation.
  The architecture requires this: "Stop new external dispatch when durable intent or audit persistence fails." (`docs/portfolio/03-architecture.md:259`).
- The job service stores the result file after the first terminal status: one row per operation with outcome and evidence. It retries on its tick until `result_artifact_id` is set.
  The terminal status does not wait for the file.
- Operation rows stay the durable evidence of later read-back settlements.
- `cc.artifacts` holds both files (`deployment/postgres/migrations/001-foundation.sql:1-17`). They satisfy evidence default 14 of the brief. Downloads stay out of this slice.

### 5.10 Finish and terminal status

The finish request runs steps 1 to 7. Steps 1 to 4 run in one transaction, `cc.prepare_device_update_finish`.
The reaper runs `cc.finalize_device_update_job`, which applies steps 1 to 4, 6, and 7 in one transaction.

1. A token that is not current changes nothing. A terminal job changes nothing, so a repeated request is harmless.
2. A batch lease within its grace answers `busy`. The finish request polls every 10 s, for at most 45 minutes. The reaper never acts while a lease lives.
3. Every `dispatched` operation becomes `unknown` with reason `interrupted` and `verify_after` at that time.
4. Every `pending` operation becomes `skipped`. The reason is the job failure, or `interrupted` without one.
5. The finish request reads back the `unknown` operations without a live read-back lease (section 5.7) and settles them.
6. `cc.finish_device_update_job` derives the status from the counters. The OQ7 ruling confirms the rule:

| Status                  | Rule                                                       |
| ----------------------- | ---------------------------------------------------------- |
| `needs-review`          | `unknown > 0`                                              |
| `completed`             | `succeeded = target_count`                                 |
| `completed-with-errors` | `unknown = 0`, `succeeded > 0`, and `failed + skipped > 0` |
| `failed`                | `unknown = 0` and `succeeded = 0`                          |

7. It sets `finished_at`, increments `revision`, and commits. The worker publishes `job-changed`. The job service then cleans the hold and runs admission (sections 6.4 and 6.5).

- After a reaper finalization with `unknown` operations, the job service starts the reconcile flow for all of them.
- Every read-back settlement on a terminal job derives the status again by the same rule. The rule reads only counters, so a settled review moves the job to its final status.
- `skipped` arises only from job failure or interruption. The preview removes unchanged and excluded devices before the job exists (OQ7 ruling).

## 6. The admission hold (D4)

### 6.1 Policy summary

The owner-accepted policy is `docs/reviews/2026-09-04-job-admission-policy.md`:

- Workers report backoff. The job service writes the hold with a five-minute TTL. Workers never write hold keys (`docs/reviews/2026-09-04-job-admission-policy.md:12`).
- The hold blocks admission of new Update Device jobs. Admitted jobs continue. Other job types stay eligible (`docs/reviews/2026-09-04-job-admission-policy.md:14`).
- Pending jobs of the held type sort smallest first. A small arrival does not bypass the hold (`docs/reviews/2026-09-04-job-admission-policy.md:16`).
- Reports overwrite the owner. No create-if-absent (`docs/reviews/2026-09-04-job-admission-policy.md:18`). Cleanup requires current ownership (`docs/reviews/2026-09-04-job-admission-policy.md:20-22`).
- The TTL is exactly 300 seconds. Reports during long waits arrive more often than every five minutes (`docs/reviews/2026-09-04-job-admission-policy.md:51`).
- Delayed reports from terminal jobs or stale attempts never renew a hold (`docs/reviews/2026-09-04-job-admission-policy.md:53-55`).

### 6.2 Key and commands

| Item           | Design                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Key            | `cc:job-hold:{customerId}:device-update`. It scopes by customer and canonical job type (`docs/reviews/2026-09-04-job-admission-policy.md:45`).                                 |
| Value          | The owning `job_id`.                                                                                                                                                           |
| Write          | `SET key jobId EX 300`. No `NX`, no `XX`. One command writes owner and TTL together (`docs/reviews/2026-09-04-job-admission-policy.md:51`).                                    |
| Cleanup        | One Lua script with explicit keys deletes the key only when its value equals the finishing job ID (`docs/reviews/2026-09-04-job-admission-policy.md:41-43`).                   |
| Registry       | `hold_written_at` and `hold_cleaned_at` on `cc.device_update_jobs`. One job type and one customer give one key per job (`docs/reviews/2026-09-04-job-admission-policy.md:45`). |
| Admission read | `GET key`. Presence means held.                                                                                                                                                |

The API rule already allows `get`, `set`, `del`, and `eval` on `~cc:*` (`deployment/redis/runtime.mjs:10-11`).
The worker rule names only entity, query-generation, and in-flight keys (`deployment/redis/runtime.mjs:12-14`). Workers therefore cannot write the hold. Card P1 adds a test that pins both rules.

### 6.3 Backoff reports

- The worker observes batch-service retries through `onResponse` events with outcome `retry` and failure kind `quota` (`libs/google-connection/src/lib/batch.ts:107-116`, `libs/google-connection/src/lib/batch.ts:908-918`).
- It reports on the first such event of a batch, and then every 60 s while any part waits for a quota retry.
- `cc.report_device_update_backoff(p_customer, p_job, p_token, p_batch, p_attempt, p_sequence)` accepts a report when all of these hold:
  the job is running, the token is current, the attempt holds the batch with a live lease, and the sequence exceeds the stored sequence of that attempt.
  It stores `backoff_attempt`, `backoff_sequence`, and `backoff_reported_at` from `clock_timestamp()`.
- Reports use Postgres only. No Redis channel carries them (section 3.1).
- The job service applies reports on its tick, inside the admission lock (section 6.5). `cc.accept_device_update_hold(p_customer)` returns a job only when all of these hold:
  1. The job is running.
  2. The report attempt still holds its batch with a live lease.
  3. The report differs from the last applied report. For the same attempt, its sequence is higher.
  4. `backoff_reported_at` is at most 30 s old.
- The same transaction stores `hold_attempt`, `hold_sequence`, and `hold_written_at`. The registry entry therefore exists before the Redis write.
- The job service then runs `SET key jobId EX 300`. It skips the write when more than 5 s passed since that transaction began, measured on a monotonic clock.
  A stalled process therefore never renews a hold from a stale report.
  A skipped write keeps the registry entry. Cleanup then deletes the key only when it holds this job.
- The 60-second interval stays below the 300-second TTL (`docs/portfolio/03-architecture.md:275`).
  The batch service caps one wait at 60 s (`libs/google-connection/src/lib/batch.ts:92`, `libs/google-connection/src/lib/batch.ts:902-905`). Reports therefore continue through long retry sequences.
- Only Update Device job reports set the hold (OQ3 ruling). Refresh throttling keeps its current retry handling (`worker/src/entity-sync.ts:123-150`).
- No early release exists in this slice (OQ4 ruling). The hold ends by its TTL or by cleanup.

### 6.4 Cleanup

- The job service runs cleanup when a write job reaches a terminal status. It learns of the status from `job-changed` and from its tick.
- Cleanup runs the compare-and-delete script only when `hold_written_at` is set and `hold_cleaned_at` is null. It then sets `hold_cleaned_at`.
  A previous owner never deletes a newer owner's hold (`docs/reviews/2026-09-04-job-admission-policy.md:22`).
- A crash without cleanup leaves the hold for at most 300 s after its last write (`docs/reviews/2026-09-04-job-admission-policy.md:35`).

### 6.5 Admission

The job service runs in the API process as one instance (`docs/portfolio/03-architecture.md:290-293`).
One in-process lock serializes every admission decision, hold write, and cleanup. The admission functions also take a transaction advisory lock per customer.
Triggers: a confirmation, a terminal `job-changed`, a hold write, a cleanup, and the tick. The tick also runs the start-deadline and runner-loss checks of section 5.3.

1. Read the hold key. A Redis error counts as held. Admission fails closed and retries on the next tick.
2. Call `cc.admit_device_update_job(p_customer, p_held)`. It locks pending write jobs with `FOR UPDATE`.
3. If a write job is running, label pending jobs `held` when `p_held` is true and `queued` otherwise. Admit nothing.
4. If no write job runs and `p_held` is true, label pending jobs `held`. Admit nothing.
5. Otherwise admit one job: smallest `target_count`, then oldest `created_at`, then lowest `display_id` (`docs/reviews/2026-09-04-job-admission-policy.md:71`).
   Apply the Admit step of section 5.3. Label the rest `queued`.
6. Start the execution (section 5.3).

A label change increments `revision` and publishes `job-changed`.
Ordering with hold writes: the lock serializes them. A hold written before step 1 blocks the decision.
A hold written after step 5 commits treats the admitted job as existing work (`docs/reviews/2026-09-04-job-admission-policy.md:69`). This is the one defined ordering (`docs/reviews/2026-09-04-job-admission-policy.md:89`).
Pending jobs stay durable in Postgres. Redis holds only the hold flag (`docs/portfolio/03-architecture.md:291`).

### 6.6 Held and the one-active-job queue

- One write job runs at a time (eng-lead ruling 10). Pending write jobs wait behind it in both cases. The hold decides only their label and their eligibility after the active job ends.
- `queued`: no hold exists, and the active write slot is busy.
- `held`: a hold exists. The UI says "Waiting to start · Google backoff" and promises no start time (`docs/ui/patterns.md:254`).
- The active job owns the hold in normal operation. Its finish deletes the hold, and the smallest pending job starts (`docs/reviews/2026-09-04-job-admission-policy.md:33`).
- The hold delays a start only after a crash without cleanup. It also prepares a later slice with more than one active write job, where owner replacement occurs (`docs/reviews/2026-09-04-job-admission-policy.md:18`).
- Refresh jobs and full syncs never wait for the hold or for the write slot.

## 7. Failure classification

### 7.1 Per operation

The batch service classifies each part (`libs/google-connection/src/lib/batch.ts:415-434`) and retries quota and transient answers (`libs/google-connection/src/lib/batch.ts:878-919`).
Each final failure keeps its retry history (`libs/google-connection/src/lib/batch.ts:898`, `libs/google-connection/src/lib/batch.ts:921-928`).

The rule: an operation with an open request stays `unknown` until a 2xx answer or a read-back settles it. A later refusal proves only that the later request failed.

The worker classifies each operation from the final result, the retry history, and two facts from `onSend` and `onResponse`: whether a request left the worker, and whether one was in flight at the end.
Each `onResponse` event carries one answer, and a success carries its parsed page (`libs/google-connection/src/lib/batch.ts:102-116`).
A fatal batch error discards the call result (`libs/google-connection/src/lib/batch.ts:596`, `libs/google-connection/src/lib/batch.ts:650`). The worker then settles from the events it kept.

| Final result                                                         | History                                         | Outcome                                                   | Reason                                        |
| -------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------- | --------------------------------------------- |
| 2xx                                                                  | Any                                             | `succeeded`                                               | `verified_by=write-response`                  |
| `not-found` (404)                                                    | No transient retry                              | `failed`                                                  | `not-found`                                   |
| `rejected` (any other status, for example 400 `invalid` or 501)      | No transient retry                              | `failed`                                                  | The Google reason                             |
| `auth` with HTTP 401 or 403                                          | No transient retry                              | `failed`                                                  | The Google reason. Section 7.2 stops the job. |
| `quota` after 25 retries                                             | No transient retry                              | `failed`                                                  | `quota`                                       |
| Any failure                                                          | At least one transient retry                    | `unknown`                                                 | `ambiguous`                                   |
| `invalid-response`                                                   | Any                                             | `unknown`                                                 | `invalid-response`                            |
| Fatal batch error                                                    | A request left the worker without a final event | `unknown`                                                 | `ambiguous`. Section 7.2 stops the job.       |
| `aborted`                                                            | A request in flight at the end                  | `unknown`                                                 | `ambiguous`                                   |
| `aborted`, a mint failure (`auth`, status 0), or a fatal batch error | No request in flight and no transient retry     | `pending` when the job continues, `skipped` when it stops | None, or the job failure                      |

- A transient retry follows a 500, 502, 503, or 504 answer, a 403 with reason `backendError`, a lost answer, or a lost part.
  `classifyStatus` defines the transient answers (`libs/google-connection/src/lib/batch.ts:386`, `libs/google-connection/src/lib/batch.ts:427-431`).
  The outer paths are `libs/google-connection/src/lib/batch.ts:726-752`. The part paths are `libs/google-connection/src/lib/batch.ts:779-788` and `libs/google-connection/src/lib/batch.ts:795-809`.
  Each of those leaves an open request.
  A `transient` failure after 10 retries carries that history, so it is `unknown`.
- A quota answer refuses before execution. Quota retries alone keep a later refusal definitive.
- A first-attempt refusal stays `failed`. Read-back runs only for `unknown` operations.
- The batch service retries PATCH on transient answers, because only POST counts as unsafe (`libs/google-connection/src/lib/batch.ts:890-893`). Section 7.3 accepts that retry.
- Quota retries honor `Retry-After` (`libs/google-connection/src/lib/batch.ts:437-446`). Without it they use full-jitter backoff up to 60 s (`libs/google-connection/src/lib/batch.ts:449-459`).

### 7.2 Job-level failures

- A token mint failure fails the waiting requests with kind `auth`, status 0, and the mint code as reason (`libs/google-connection/src/lib/batch.ts:614-644`).
  `patchAnnotatedLocations` keeps that code, as `deviceBatch` does (`libs/google-connection/src/lib/devices.ts:366-378`, `libs/google-connection/src/lib/devices.ts:391`).
- A mint failure stops the job. The job failure is the mint code itself. Later batches send nothing, and the finish skips their operations.
- The operations of the failing batch follow section 7.1. An operation without an open request becomes `skipped` with the mint code.
  An operation with an open request becomes `unknown` and goes through read-back.
- Write access becomes `denied` only for `delegation-not-authorized` and `scope-mismatch`. `network-failure`, `provider-unavailable`, and every other code leave write access unchanged (section 4.2).
- A part answer of kind `auth` stops the job after its batch settles. That kind is HTTP 401, or a 403 outside quota and `backendError` (`libs/google-connection/src/lib/batch.ts:432`).
  The job failure is the code that `batchFailure` assigns (`libs/google-connection/src/lib/devices.ts:191-198`). It applies `failure()` to the part answer (`libs/google-connection/src/lib/provider.ts:115-148`).
  For example, a 403 with reason `accessNotConfigured` gives `api-not-enabled`. A 403 with a reason that no earlier rule names gives `permission-denied`.
- A fatal batch error stops the job. The job failure is `invalid-response` for `malformed-response` and `request-failed` otherwise.
  `deviceBatch` maps the two errors the same way (`libs/google-connection/src/lib/devices.ts:382-389`).
- A credential that cannot open gives `key-unavailable` before any request, as refresh batches map it (`worker/src/entity-sync.ts:263-268`).
- A store failure after Google answered leaves the batch operations `dispatched`. The lease ends. A takeover, the finish, or the reaper then fences them to `unknown` (section 5.4).

### 7.3 Why Replace and Clear are safe to repeat

- Each request sets an absolute final value: the approved string, or `null`. A repeat produces the same device state.
- The body names one field. Patch semantics leave other fields untouched (`mock@v0.2.0:src/directory/device-writes.ts:47`).
- Prepend and Append compute the value from a baseline. They stay out of this slice (D1). The architecture forbids appending again during a retry (`docs/portfolio/03-architecture.md:249`).
- A repeat overwrites a change that another administrator made between attempts. A single request has the same race. Neither Google nor the mock offers a precondition here (findings 2.8 and 6.1).
- Local idempotency prevents duplicate jobs. It creates no Google idempotency (`docs/portfolio/03-architecture.md:237`).

### 7.4 Unknown effects

- The UI shows `unknown` as "Unknown", and the job as "Needs review". It never relabels uncertainty (`docs/ui/patterns.md:257`).
- The read-back settles most unknown operations automatically. Reconcile settles the rest on request.
- No automatic resend of an operation exists in this slice. Retry stays out of scope.
- Fencing rejects stale local transitions. It cannot cancel a request already sent to Google (`docs/portfolio/03-architecture.md:241-242`). Section 10.1 records the residual race.

## 8. Test strategy on admin-sdk-mock

### 8.1 Mock facilities

| Need                    | Mock facility                                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patch faults            | `POST /domains/{id}/faults` with kind `status`, `error-rate`, `hang`, or `reset` and `method: directory.chromeosdevices.patch` (`mock@v0.2.0:docs/guide/configuration.md:315-327`).                                                    |
| Fault order             | `status` and `reset` answer before the handler runs. `hang` waits and then runs the handler (`mock@v0.2.0:src/faults/faults.ts:205-245`). A `hang` beyond the 10 s client timeout loses the answer of a write that still takes effect. |
| Throttling for the hold | A `status` fault with 429 and reason `rateLimitExceeded` on the patch method for a counted number of calls.                                                                                                                            |
| Scope removal           | `remove-scope` for the write scope, and `revoke-delegation` for the client (`mock@v0.2.0:docs/guide/configuration.md:321-322`). Token exchange then answers 401 `unauthorized_client` (`mock@v0.2.0:src/auth/token.ts:103-113`).       |
| Scope grant             | `PUT /domains/{id}/delegation/{clientId}` with the scope list (`mock@v0.2.0:docs/guide/testing.md:275`).                                                                                                                               |
| Token outage            | The mock cannot fault `oauth.token` (`mock@v0.2.0:docs/guide/configuration.md:328`). Token outage tests inject the mint failure through a fake `getClient`.                                                                            |
| In-flight calls         | `GET /domains/{id}/quota` lists in-flight requests (`mock@v0.2.0:docs/guide/testing.md:278`). A test adds a fault after a call starts.                                                                                                 |
| List lag                | `writes.searchDelaySeconds`, 300 s by default (`mock@v0.2.0:docs/guide/behavior.md:70`). `POST /domains/{id}/index/flush` ends it (`mock@v0.2.0:docs/guide/testing.md:175-183`).                                                       |
| Validation              | Over 200 code points answers 400 `invalid` (`mock@v0.2.0:src/directory/device-writes.ts:26`, `mock@v0.2.0:src/directory/common.ts:130-134`, `mock@v0.2.0:src/directory/common.ts:46-54`).                                              |
| Write scope rules       | Writes need the write scope only (`mock@v0.2.0:src/auth/scopes.ts:49-50`).                                                                                                                                                             |

- The product harness starts the pinned mock (`api-e2e/admin-sdk-mock-fixture.mjs:215`).
  Nx targets: `api-e2e:admin-sdk-mock-integration` (`api-e2e/project.json:42`) and `api-e2e:client-review-mock` (`api-e2e/project.json:22`).
- Every mock write ruling is unverified against live Google (`mock@v0.2.0:docs/guide/behavior.md:145`). Live write behavior stays "not verified".

### 8.2 Failing-first rule

Each card commits each new test before its implementation. The handoff pastes the failing run on the parent revision and the passing run on the card revision.
A test that cannot fail without the change does not count.

### 8.3 Tests per card

B1, contracts (`npm exec nx test application-contracts`):

- Display ID pattern, status enum, and strict objects that reject extra keys.
- `value` limits at 200 and 201 code points with a 4-byte character. Whitespace only is rejected. Clear rejects a value.
- `jobEventSchema` accepts only `job-changed`. A `job-changed` payload fails `entityEventSchema`.
- `jobActivitySchema` rejects more than 50 running rows, 50 waiting rows, or 10 recent rows.
- `jobProgressSchema` accepts null `total` and null `pending` together only.
- `deviceSelectionSpecSchema` requires `expiredAt` as a timestamp or null.

B2, Postgres integration (pattern: `deployment/postgres/device-inventory.integration.mjs`):

- Model: ID format at 999 and 1000. The unique running write index. Admission order with ties.
- Retention: the purge keeps write jobs, drops 8-day refresh jobs with their targets, and closes a lapsed full-sync header.
- R5 empty inventory: a full sync without pages finishes `completed` with `target_count` 0.
- R5 large inventory: a full sync of 100,001 devices finishes with that count. An ID-list refresh above 100,000 fails the check.
- R5 target paths: an ID-list refresh records each target path at creation. A full sync records the path of each staged device.
- R2 unclaimed start: after the deadline, the token rotates up to 3 executions. The job then fails `orchestration-unavailable`, and every operation is `skipped`.
- R2 superseded execution: a claim, a renewal, a recording, and a finish with an old token change nothing.
- R2 live duplicate claim: a second attempt receives `busy` while the first lease lives.
- R2 expired attempt: after the lease plus grace, a new claim fences `dispatched` operations to `unknown` and takes the batch.
- R2 delayed result: a write recording from the fenced attempt changes no outcome, counter, device row, or overlay.
- R2 finish: a live lease gives `busy`. After the grace, the finish fences `dispatched` operations and skips `pending` ones. No terminal job holds either.
- R2 runner loss: no live lease and an old heartbeat rotate the token. The rotation resets `heartbeat_at`. At 3 executions the job finalizes.
- Status rule: all failed gives `failed`. Any unknown gives `needs-review`. A read-back settlement on a terminal job derives the status again.
- Revalidation: a grant change or a permission version change skips pending operations with `permission-changed`.
- R4 successive writes: Replace A, then Clear, leaves null in the row and in the overlay.
- R4 lagged list: write A, a matching refresh read, then a list with the old value keeps A. A later list with A deletes the overlay.
- R4 in-flight read: a refresh read stamped before the write leaves A.
- R4 read-back publication: a read-back settlement updates the row and the overlay in the settling transaction. An expired overlay lets the list value through.
- R9 reports: `cc.report_device_update_backoff` rejects an old token, a fenced attempt, an expired lease, and a sequence that does not increase.
- R9 hold acceptance: `cc.accept_device_update_hold` rejects a report older than 30 s, a report whose attempt lost its lease, and an applied report.

B3, preview and confirm API:

- The preview freezes targets. A device added after the preview never joins.
- Expiry gives 410. A second confirm returns the same job. A digest mismatch gives 409. Zero eligible targets give `422 nothing-to-update`.
- Missing `devices:bulk-actions` gives 403 and an `access-denied` audit row (`api/src/app/auth/auth.service.ts:311-331`).
- R7, failing first: a selection last changed 13 hours ago returns `expiredAt`. Preview create then returns `409 selection-expired`.
  On the parent revision the selection reads as plain empty (`api/src/app/devices/device-selection.ts:42-51`), so the test fails.
- R7: an approved job keeps its operations after the selection expires. An unexpired preview stays confirmable.
- The manifest artifact exists for each job. An artifact failure fails the confirmation.

B4, jobs API, refresh jobs, and streams:

- List sort and keyset stability. Each filter. The attention filter keeps the job counts.
- R6 badge: `running.count` changes when a job starts and again when it finishes.
- R6 caps: 50 running, 50 waiting, and 10 recent rows. Counts beyond the caps exceed the rows.
- R6 attention: an entirely failed job sets `attention`. `seen` clears it.
- R6 revision: each status, counter, and operation change increments `revision`.
- R5: a stale-page refresh and a Refresh all show as REF- jobs with requesters. An empty inventory shows `completed` with 0 devices. A large inventory shows its full count.
- R1 allowlists: the Devices stream never forwards `job-changed`, even when one arrives on the entity channel. The Jobs stream forwards only `job-changed`.
- R1 denied access: `GET /api/jobs/events` without `jobs:read` answers 403. Removing `jobs:read` closes an open stream at the next ping.
  A person with `devices:read` alone receives no job event on the Devices stream.

B5, job service with a real Redis:

- The hold `SET` overwrites another owner and resets the TTL to 300. Cleanup by a previous owner keeps the newer hold.
- A Redis error blocks admission. Admission racing a hold write follows section 6.5.
- R9 delayed report: a report accepted while its lease lived, applied after the lease ended, writes no hold. A report older than 30 s writes no hold.
  An apply that stalls beyond 5 s skips the `SET`.
- R2: an API exit between admission and start leaves a running job without a claim. The tick restarts it after the deadline.
- R2 ambiguous start: a start request times out, and the created execution reaches the worker after the deadline. The tick has rotated the token.
  The late execution answers `superseded` on every call and sends nothing. An execution that claims before the deadline runs normally.
- R2: a Kestra refusal fails the job with `orchestration-unavailable`. Runner loss restarts the job and, at 3 executions, finalizes it and starts the reconcile flow.
- Reconcile route: a second request under a live read-back lease starts no second flow. A settled operation answers 409.
- The result file exists after the first terminal status.
- The policy acceptance scenarios that apply (`docs/reviews/2026-09-04-job-admission-policy.md:77-91`).

B6, capability:

- The setup scopes include the write scope. The check sends no write (mock request log).
- `remove-scope` for the write scope gives `denied` and the exact message. `revoke-delegation` gives `denied`. A delegation grant through the mock control gives `granted`.
- R8 token outage with a granted scope: an injected `network-failure` or `provider-unavailable` mint failure gives `unavailable` with that code, never `denied`.
- A 403 on the list gives `unavailable` with `permission-denied`.

P1, flows, ACL, and edge:

- The flow YAML validates. `device_update` has no flow concurrency limit and a `ForEach` limit of 1. Retry applies only to a dead runner.
- The `errors` tasks post the finish after a failed batch.
- ACL: the worker user cannot write the hold key. The worker user can publish on `cc:job-events:*`. The API user can publish.
- Edge: every new route passes with its method, and other methods answer 405. `/api/jobs/events` gets the event idle timeout.
- Kestra runs `device_update` against the worker in the mock stack.

P2, worker, with a fake batch client and on the mock:

- Request shape: the PATCH body holds only `annotatedLocation`. Clear sends `null`. A batch holds at most 250 parts.
- Classification: one case per row of the section 7.1 table.
- R3 response loss then refusal, fake client: round 1 fails with status 0 after the fake applies the write. Round 2 answers a part 403.
  The operation becomes `unknown`, and read-back settles it `succeeded`. Repeat with 400 and 404.
- R3 first-attempt refusals: 403, 400, and 404 on the first request give `failed` without a read-back.
- R3 on the mock: a one-call 12 s `hang` on the patch method, then a `status` 403 rule added while the call is in flight. Read-back settles the operation `succeeded`.
- R3 fatal answer, fake client: a 200 outer answer with a malformed multipart body ends the call. Operations sent in that round become `unknown`.
  Operations with an earlier 2xx event stay `succeeded`. The job fails with `invalid-response`.
- Graceful stop: unsent operations return to `pending`. An operation in flight becomes `unknown`. The next claim proceeds at once.
- R8 token outage with a granted scope: an injected `network-failure` stops the job with that failure. Unsent operations become `skipped`. Write access stays unchanged.
- R8 missing scope: `remove-scope` gives job failure `delegation-not-authorized`, `skipped` operations, and write access `denied`.
- R2 lease: a rejected renewal aborts the call, and no later round leaves the worker. The watchdog aborts after 150 s without a successful renewal.
- R2 duplicate dispatch: two requests for one batch send one Google request. The second answers `done`.
- R2 killed runner: a worker killed after its claim leaves `dispatched` operations. The Kestra retry waits out the lease plus grace, fences them, and reads them back.
- R2 delayed recording after takeover changes nothing.
- R4 on the mock: Replace, then Clear, leaves null in the Redis record. A list during the lag keeps the written value. `flush`, then a list, deletes the overlay.
- R4 read-back success rewrites the Redis record and publishes `entity-batch`.
- R9: reports arrive every 60 s during quota waits. A report after the lease ends is rejected.

F1 to F6, component and browser tests against the named frames:

- F1, R7: an expired selection shows the `105:189` state and asks for reselection. A `selection-expired` answer keeps the draft values.
- F1: the disabled reasons cover an empty selection, missing actions, each write-access state, and offline.
- F2: the preview pages every target. An expired preview shows the `104:434` state. A second click on Create update job creates no second job.
- F4, R6: a `job-changed` event for the open job rereads the detail and the visible operations page.
- F4, R6: after Reconcile, the row moves from Unknown to its outcome without a manual refresh.
- F4, R6: events with revisions 7 and then 6 end in the state of the last read. A reconnect rereads the detail.
- F5, R6: the badge follows `running.count` after a job starts and after it finishes. An entirely failed job shows the attention dot. Opening the panel clears it.
- F5, R6: the panel shows at most 50 running, 50 waiting, and 10 recent rows, with View all jobs. A reconnect rereads the summary.
- F6, R4: Replace, then Clear, updates an open grid in place. A read-back success updates the row. Drafts, selection, and focus stay (JOB-02).

Q1, end to end on the mock in one fresh installation:

- The six completion items of the brief.
- Adversarial runs: duplicate submission, duplicate dispatch, a stale attempt, a worker killed mid-batch, and an API restart between admission and start.
- The policy acceptance scenarios.
- The latency of a 250-part write batch against the 10 s client timeout.
- Live write behavior recorded as not verified.

## 9. Implementation cards

Operator direction (2026-10-16 21:35): no frontend card waits on design approval. Each frontend card follows its named frames and the approved activity-area mockup.
Each card inspects its Figma frames before implementation (`AGENTS.md:68`). Each card states what it did not verify.

| ID  | Profile  | Title                                                                                    | Depends on |
| --- | -------- | ---------------------------------------------------------------------------------------- | ---------- |
| B1  | backend  | Contracts and actions for device updates, jobs, job events, and selection expiry         | none       |
| B2  | backend  | Migration 017: jobs, refresh job model, write tables, fenced functions, overlays, purge  | B1         |
| B3  | backend  | Preview, confirmation, selection expiry, and the evidence manifest                       | B2         |
| B4  | backend  | Jobs API, activity, refresh jobs as REF- jobs, the job channel, and stream allowlists    | B2         |
| B5  | backend  | Job service: admission, dispatch recovery, hold, cleanup, reaper, Reconcile, result file | B4, P1     |
| B6  | backend  | Device write capability and write-access state                                           | B1         |
| P1  | platform | Kestra flows, orchestration starts, Redis ACL, and edge routes                           | B1         |
| P2  | platform | Worker writes, leases, classification, read-back, publication, events, and reports       | B2, P1     |
| F1  | frontend | Bulk Actions, the Update device entry, the draft page, and the expired selection         | B3, B6     |
| F2  | frontend | Preview, confirmation, and receipt pages                                                 | F1         |
| F3  | frontend | Jobs navigation item and Jobs page                                                       | B4         |
| F4  | frontend | Job detail, operations, Inspect failure, and Reconcile                                   | F3, B5     |
| F5  | frontend | Jobs activity area                                                                       | B4         |
| F6  | frontend | In-place grid updates for written values                                                 | P2         |
| Q1  | qa       | Mock demonstration and adversarial verification of the slice                             | all above  |

B1. Scope: sections 2.1, 2.2, the selection contract of section 2.8, and the job event schema of section 3.1.
Acceptance: `npm exec nx test application-contracts` passes with the B1 tests. The three actions exist in `actionSchema` and `actionScopeKinds`. `entityEventSchema` stays unchanged.

B2. Scope: section 1, and the SQL functions of sections 5.3 to 5.10 and 6.3.
Acceptance: a fresh installation applies 001 to 017. The B2 integration tests pass. `checkReadiness` reports ready (`deployment/postgres/index.mjs:277-296`).

B3. Scope: sections 2.3, 2.4, and 2.8, a `DeviceUpdatesController` under `api/src/app/devices/`, the selection change in `api/src/app/devices/device-selection.ts`, and the manifest of section 5.9.
Acceptance: the B3 tests pass. A duplicate confirmation never creates a second job. The manifest artifact exists for each job.

B4. Scope: sections 1.3 (API side), 2.5, 3.1, 3.3, and 3.4 (server side), and a `jobs` module under `api/src/app/jobs/`. It includes the `EventFanout` and `streamEvents` changes in `api/src/app/devices/device-events.ts`.
Acceptance: the B4 tests pass. A stale-page refresh and a Refresh all both show in `GET /api/jobs` with REF- IDs and requesters.

B5. Scope: section 6, the job service parts of sections 5.3 and 5.10, section 2.6, and the result file of section 5.9.
Acceptance: the B5 tests pass. A second write job reads `held` while the hold exists and `running` after cleanup or expiry. Refresh jobs run during a hold.

B6. Scope: section 4 and the write-access routes of section 2.7.
Acceptance: the B6 tests pass. The connection page lists the write scope. Removing the scope in the mock disables Update device with the exact message.

P1. Scope: section 5.1, the ACL changes of sections 3.2 and 6.2, and the edge.
The edge adds the API routes of sections 2.3 to 2.7 to its allowlists (`deployment/bootstrap/application-edge.mjs:109-129`).
It adds the pages `/jobs`, `/jobs/{displayId}`, `/jobs/{displayId}/receipt`, `/devices/update`, `/devices/update/previews/{previewId}`, and `/devices/update/previews/{previewId}/confirm` (`deployment/bootstrap/application-edge.mjs:33-41`, `deployment/bootstrap/application-edge.mjs:131-133`).
It gives `/api/jobs/events` the event idle timeout (`deployment/bootstrap/application-edge.mjs:196-197`).
Acceptance: the P1 tests pass. Kestra runs `device_update` against the worker in the mock stack.

P2. Scope: sections 5.2 to 5.8, 6.3 (worker side), and 7, in new worker modules beside `worker/src/entity-sync.ts`.
It includes `patchAnnotatedLocations`, `deviceStates`, and the `onSend` hook in `libs/google-connection/src/lib/`. The write batch size is a setting with 250 as its ceiling.
Acceptance: the P2 tests pass. No code path sends a PATCH part without a committed claim and a live lease.

F1. Frames `94:3`, `213:4199`, `216:4309`, `94:75`, and `105:189`. Bulk Actions shows one item, "Update device".
The draft page shows the selected count, Annotated location, and Change mode with "Update · Replace the existing value" and Clear value. It omits Organization unit (eng-lead ruling 2).
Disabled reasons: an empty selection, missing actions, write access other than `granted`, and offline. "Review pending devices" shows the selected devices in the Devices grid and keeps the draft.
The expired selection follows section 2.8. Counts use thousands separators.
The draft route precedes `devices/:deviceId` in `frontend/src/app/app.routes.ts:75-84`.

F2. Frames `97:21`, `97:57`, `104:74`, and `104:434`. The preview pages every target with Observed value and Approved value, counts, exclusions with reasons, the stale warning, preparation time, expiry, and preview ID.
The confirmation requires the checkbox and disables Create update job while the request runs. The receipt page shows "Update job created" with Back to devices and View job. Jobs is the active navigation item.

F3. Frames `106:109`, `231:5009`, `234:4950`, `234:5142`, `234:5325`, and `234:5510`.
Jobs becomes a main navigation item (D3) beside the Devices route (`frontend/src/app/app.routes.ts:63-74`) and the Devices link (`frontend/src/app/shell/shell.html:30-38`).
The grid follows `docs/ui/jobs-grid.json` and JOB-03 (`docs/ui/patterns.md:273-288`). It exposes only the server filters of section 2.5. Refresh reads job state only. Live state follows section 3.4.

F4. Frames `104:209`, `231:4707`, and `228:4524`. The detail shows identity, counts, the attention filter, operations, Inspect failure for failed rows, and Reconcile for unknown rows.
It shows no Cancel, Retry, Pause, or download (eng-lead ruling 20). Live state follows section 3.4.

F5. Source: the approved mockup `docs/ui/designs/2026-10-16-jobs-activity-area.html` and `.png` (D6).
The Activity button sits left of Help (`frontend/src/app/shell/shell.html:121-127`) with the running count and ring. The attention dot clears through `POST /api/jobs/activity/seen`.
The panel lists Running, Waiting, and Recent from `GET /api/jobs/activity` with the caps of section 2.5. Each row opens its job detail. "View all jobs" opens the Jobs page.

F6. The Devices grid applies `entity-batch` events from write jobs in place. It keeps drafts, selection, and focus (JOB-02). It shows the accepted value and no verification indicator (OQ2 ruling).

Q1. Runs the tests of section 8.3 for Q1. It attacks the green suites with the policy acceptance scenarios, duplicate submission, duplicate dispatch, and stale attempts. It records live write behavior as not verified.

## 10. Risks and open questions

### 10.1 Risks

| Risk                                                                                                                              | Mitigation                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live write behavior is unverified. The Easton fixture has 0 devices and no write authorization.                                   | Tests use the mock only (eng-lead ruling 27). A live check needs another tenant and owner authorization.                                                            |
| Google's ChromeOS batch quota statement conflicts with the generic rule (findings 2.8).                                           | Admission uses observed throttles only (`docs/reviews/2026-09-04-job-admission-policy.md:93`). Card Q1 records observed retries.                                    |
| A 250-part write batch exceeds the 10 s client timeout on Google (`libs/google-connection/src/lib/provider.ts:240`).              | The parts become `unknown`, and read-back settles them. Card Q1 measures the latency. The write batch size is a setting.                                            |
| Google applies a request after its read-back. The operation then reads `failed` while the device holds the requested value.       | Read-back waits 30 s after the last unanswered request. No automatic resend follows. A later refresh read shows the real value in the grid.                         |
| A list that shows another administrator's newer value loses to a live overlay.                                                    | The next refresh read moves the overlay. Overlays expire after 36 hours.                                                                                            |
| Google normalizes a stored annotated location. A read-back then reports `value-differs` after a successful write.                 | Card Q1 compares write responses with requested values on the mock. Live parity stays unverified.                                                                   |
| A large full sync writes one target row per device. A daily Refresh all of 300,000 devices keeps about 2.1 million rows.          | Target rows stay narrow. The purge removes them with their job after 7 days.                                                                                        |
| An expired selection stays distinguishable for 24 hours after its expiry.                                                         | Later it reads as a selection never made, as the browsing record states today (`docs/workflows/device-browsing.md:141`).                                            |
| A refresh job that waits in the Kestra queue shows `running` (`deployment/kestra/entity-sync.yaml:3-6`).                          | This matches current refresh behavior. The application does not observe the Kestra queue.                                                                           |
| Smallest-first ordering starves a large job under constant small arrivals (`docs/reviews/2026-09-04-job-admission-policy.md:73`). | Keep the owner ordering. Log the age of the oldest waiting job.                                                                                                     |
| The job service runs in one API process (`docs/portfolio/03-architecture.md:293`).                                                | Postgres locks and the unique index still prevent a second running write job. A second instance needs qualification first (`docs/portfolio/03-architecture.md:67`). |
| Redis is unavailable.                                                                                                             | Admission fails closed. Running jobs continue. The hold expires by TTL. Clients reread state when their streams reconnect.                                          |
| A concurrent administrator change is overwritten by a repeated write.                                                             | Section 7.3. No precondition exists.                                                                                                                                |

### 10.2 Open questions

The eng-lead ruled on OQ1 to OQ7 on 2026-10-16 at 22:00. The design applies each ruling.

| ID  | Question                                                          | Ruling                                                                                                                                                                     | Applied in   |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| OQ1 | Does "at most 10" cap the Recent section or the panel?            | It caps Recent only. Running and Waiting list every job up to 50 rows each, then "View all jobs".                                                                          | 2.5, F5      |
| OQ2 | Which grid frame shows the verification state of a written value? | No frame shows one. The grid shows the accepted value. The job detail shows each operation's outcome and update time.                                                      | 3.5, 5.8, F6 |
| OQ3 | Do refresh throttles also hold Update Device admission?           | No. Only Update Device job reports set the hold in this slice. Refresh throttling keeps its retry handling. Revisit with observed data.                                    | 6.3          |
| OQ4 | Which unit and threshold trigger an early release?                | No early release in this slice. The hold ends by its 300 s TTL or by cleanup. The policy permits early release but does not require it.                                    | 6.3          |
| OQ5 | Does the attention dot clear per person or per browser?           | Per person, stored on the server.                                                                                                                                          | 1.4, 2.5     |
| OQ6 | Which actions does Reconcile require?                             | `devices:write` (with `jobs:read`), because Reconcile changes recorded job evidence.                                                                                       | 2.1, 2.6     |
| OQ7 | Is the section 5.8 status rule of revision 1 correct?             | Yes. All failed gives `failed`. Skipped arises only from job failure or interruption, so skipped counts as an error. A job with zero eligible targets cannot be confirmed. | 2.4, 5.10    |

Open:

| ID  | Question                                                                                                                            | Owner of the answer |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| OQ8 | Do Prepend and Append in the next slice need an operation precondition before a repeat? Section 7.3 holds only for absolute values. | next slice design   |
