# Technical design: annotated-location writes, write jobs, the admission hold, and the jobs API

Status: proposed technical design, 2026-10-16. Author: architect. Not owner-approved product behavior.
Slice: development order step 4 (`docs/current-work.md`). The intake brief (eng-lead, 2026-10-16, revision 3) is the contract.
Owner decisions D1 to D6 in that brief are binding. This record invents no product behavior. Undecided items are open questions in section 10.

## Conventions

- Code references name a path and line at commit `72cd2c3`, the base of branch `codex/device-write-jobs-design`.
- `mock@v0.2.0:` references name files of admin-sdk-mock at tag `v0.2.0`. `package.json:12` pins that release.
- The design assumes that PR #33 (`codex/delegation-401-classification`) merges. That PR fixes the 401 order in `libs/google-connection/src/lib/provider.ts:115-126`.
- "Job service" names the logical owner of admission, hold updates, and terminal cleanup (`docs/portfolio/03-architecture.md:63-64`). Section 6 places it.
- Development databases are disposable (`AGENTS.md:23-29`). Nothing below migrates, upgrades, or preserves existing development data.

## Design sources for the screens

| Screen                                  | Source                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| Bulk Actions and the selection footer   | Figma `94:3`, `213:4199`, `216:4309`                                                  |
| Draft page "Update N devices"           | Figma `94:75`                                                                         |
| Preview "Review N device updates"       | Figma `97:21`                                                                         |
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

- `cc.entity_sync_jobs` stores targets as one JSON ID array with batch slicing (`016-device-inventory.sql:58-73`, `401-417`). Write jobs need one durable row per operation. Each row carries a baseline, a requested value, an outcome, an attempt, and Google evidence (`docs/ui/jobs-grid.json:150-161`).
- Retention differs by kind. Refresh jobs stay 7 days. Write jobs stay permanently. The purge today deletes by `finished_at` after one day (`016-device-inventory.sql:439-456`).
- The Jobs grid sorts and filters every kind together (`docs/ui/jobs-grid.json:24-33`, `84-121`). One header table gives one index and one keyset for that query. A union of unlike tables does not.
- A full sync keeps no history. Its actor clears at finish and at abandon (`016-device-inventory.sql:166`, `342`). A header row records each "Refresh all" with its requester.

Migration placement: `017-jobs.sql` creates the new objects. It also changes 016 objects with `ALTER TABLE` and `CREATE OR REPLACE FUNCTION`.
The runner rejects an edited applied migration (`deployment/postgres/index.mjs:152-155`). A new file keeps 016 intact. The current definition of a changed function is the one in 017.
017 assumes a fresh installation. Developers recreate their databases (`AGENTS.md:27-28`). Rollback: revert the commit and recreate the database. No down migration exists, by owner direction.

### 1.2 `cc.jobs`

| Column                                                   | Type and rule                                                                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `job_id`                                                 | `uuid` primary key. Kestra execution IDs never replace it (`03-architecture.md:213-214`).                                                       |
| `display_id`                                             | `text` unique, `UPD-006` or `REF-031`. Section 1.6.                                                                                             |
| `customer_id`                                            | `text` references `cc.google_connection(customer_id)`, as in `016-device-inventory.sql:60`.                                                     |
| `kind`                                                   | `inventory-refresh` or `device-update`.                                                                                                         |
| `scope_kind`                                             | `devices` (an ID list) or `all-devices` (a full sync).                                                                                          |
| `status`                                                 | `accepted`, `queued`, `held`, `running`, `completed`, `completed-with-errors`, `failed`, `needs-review`. No `cancelled` in this slice.          |
| `requested_by`                                           | `uuid` not null, references `cc.application_principals(id)`, as in `016-device-inventory.sql:66`.                                               |
| `confirmed_by`                                           | `uuid` null. Write jobs set it at confirmation.                                                                                                 |
| `delegated_subject`                                      | `text` null. Write jobs record the Google subject that the credential delegates to.                                                             |
| `generation`                                             | `integer` not null. The connection generation at creation.                                                                                      |
| `target_count`                                           | `integer` not null, 1 to 100,000. The cap matches `016-device-inventory.sql:63`.                                                                |
| `target_org_unit_paths`                                  | `text[]` not null. The distinct OrgUnit paths of all targets, sorted. A full sync stores `{/}`.                                                 |
| `succeeded`, `failed`, `unknown`, `skipped`              | `integer` not null default 0. Pending is `target_count` minus their sum.                                                                        |
| `failure`                                                | `text` null. The job-level failure code. The vocabulary of `016-device-inventory.sql:69-71` plus `permission-changed` and `connection-changed`. |
| `hold_written_at`                                        | `timestamptz` null. Set when the job service writes the hold for this job. Section 6.4.                                                         |
| `correlation_id`                                         | `uuid` not null.                                                                                                                                |
| `created_at`, `admitted_at`, `started_at`, `finished_at` | `timestamptz`. `created_at` defaults to `clock_timestamp()`.                                                                                    |

Indexes:

- `(customer_id, created_at DESC, display_id DESC)` serves the Jobs grid sort and keyset pages.
- A unique partial index on `(customer_id) WHERE kind='device-update' AND status='running'` enforces one active write job.
- A partial index on `(customer_id, target_count, created_at, display_id) WHERE kind='device-update' AND status IN ('accepted','queued','held')` serves admission order.

### 1.3 Refresh jobs as jobs

- Stale-page refresh. `cc.create_entity_sync_job` (`016-device-inventory.sql:358-382`) inserts the header first, with `kind='inventory-refresh'`, `scope_kind='devices'`, and status `running`. `cc.entity_sync_jobs.job_id` becomes a foreign key to `cc.jobs(job_id) ON DELETE CASCADE`.
- Each refresh job stores each target's OrgUnit path. Add `cc.entity_sync_jobs.org_unit_paths jsonb`, an array parallel to `ids`, read from `cc.devices.org_unit_path` (`016-device-inventory.sql:34`). The header stores the distinct set.
- `cc.finish_entity_sync_batch` (`016-device-inventory.sql:419-437`) also finishes the header. Status rule: no failure gives `completed`. A failure with at least one completed batch gives `completed-with-errors`. A failure with no completed batch gives `failed`.
- `cc.abandon_entity_sync_job` (`016-device-inventory.sql:384-398`) sets the header to `failed` with `orchestration-unavailable`.
- Full sync. `cc.request_device_sync` (`016-device-inventory.sql:130-157`) inserts a header with `scope_kind='all-devices'` and uses its `job_id` as `sync_id`. `cc.finish_device_sync` and `cc.abandon_device_sync` set the header status and `finished_at`. The requester stays on the header after `sync_actor` clears (`016-device-inventory.sql:342`).
- Progress for an ID-list refresh comes from batch records. Batch `i` holds `min(batch_size, n - i*batch_size)` devices. A full sync reports no total while it runs. Its finished header records the device count from `cc.device_sync_state.device_count` (`016-device-inventory.sql:10`).
- The refresh job header carries no `confirmed_by`. Refresh jobs read Google and change nothing in Google.

### 1.4 Write-job tables

`cc.device_update_previews`, one row per prepared preview:

| Column                                          | Rule                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `preview_id`, `display_id`                      | `uuid` primary key and `PV-006` style ID (Figma `97:21` shows "Preview PV-006").     |
| `customer_id`, `created_by`                     | As on `cc.jobs`.                                                                     |
| `permission_version`, `generation`              | The creator's permission version and the connection generation at preparation.       |
| `field`, `mode`, `value`                        | `annotatedLocation`, `replace` or `clear`, the value (null for `clear`).             |
| `selected`, `eligible`, `unchanged`, `excluded` | Counts. Selected equals the sum of the other three.                                  |
| `oldest_observed_at`                            | The oldest `last_entity_sync` among eligible targets.                                |
| `manifest_digest`                               | SHA-256 over field, mode, value, and the ordered eligible device IDs with baselines. |
| `prepared_at`, `expires_at`                     | `expires_at = prepared_at + 15 minutes` (`03-architecture.md:196`).                  |
| `job_id`                                        | `uuid` null, unique. Confirmation sets it once. This blocks duplicate jobs.          |
| `manifest_artifact_id`                          | The frozen manifest file in `cc.artifacts` (`001-foundation.sql:1-18`). Section 5.7. |

`cc.device_update_preview_targets`, the frozen target list: `preview_id`, `ordinal`, `device_id`, `serial_number`, `org_unit_path`, `observed_value`, `observed_at`, `disposition` (`eligible`, `unchanged`, `excluded`), `exclusion_reason`. Primary key `(preview_id, ordinal)`. Unique `(preview_id, device_id)`.

`cc.device_update_operations`, one row per eligible target, created at confirmation from the preview targets in the same transaction:

| Column                                        | Rule                                                                                                |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `job_id`, `operation_number`                  | Primary key. The stable operation ID is `<display_id>-<operation_number>`, for example `UPD-006-3`. |
| `device_id`, `serial_number`, `org_unit_path` | Copied from the frozen target. Each target's OrgUnit path stays with its operation (D5).            |
| `baseline_value`, `requested_value`           | The observed value at preview and the approved final value. `requested_value` is null for Clear.    |
| `batch`                                       | `(operation_number - 1) / 250`. Section 5.2.                                                        |
| `status`                                      | `pending`, `dispatched`, `succeeded`, `failed`, `unknown`, `skipped`.                               |
| `attempt_id`, `lease_expires_at`              | The worker attempt that holds the operation. Section 5.4.                                           |
| `google_status`, `google_reason`              | The last HTTP status and Google reason, from `BatchFailure` (`batch.ts:41-49`).                     |
| `observed_value`, `verified_by`               | The value Google returned and its source: `write-response` or `read-back`.                          |
| `outcome_reason`                              | A product code, for example `not-found`, `value-differs`, `permission-changed`.                     |
| `updated_at`                                  | The time of the last outcome change.                                                                |

`cc.device_write_overlays` protects an accepted value from an older list observation (section 5.6): `customer_id`, `device_id`, `field`, `value`, `job_id`, `written_at`, `expires_at`. Primary key `(customer_id, device_id, field)`.

`cc.job_activity_seen`: `principal_id` primary key, `seen_at`. The activity area attention dot clears when the person opens the panel (approved mockup). Open question OQ5 confirms the per-person scope.

### 1.5 Retention

- Replace `cc.purge_entity_sync_jobs` (`016-device-inventory.sql:439-456`) with `cc.purge_jobs(p_customer, p_limit)`. `DeviceRefresh` calls it where it calls the old purge (`api/src/app/devices/device-refresh.ts:40-43`).
- It deletes `inventory-refresh` headers finished more than 7 days ago. The cascade removes their detail and batch rows. It never deletes `device-update` jobs, operations, previews of confirmed jobs, or overlays of unexpired writes.
- It keeps the interruption rule: an ID-list refresh unfinished after 2 hours ends with `interrupted` (`016-device-inventory.sql:447-448`).
- It deletes unconfirmed previews 24 hours after `expires_at`, with their targets.
- It deletes expired overlays.

### 1.6 Job ID allocation

- Sequences `cc.job_number_upd`, `cc.job_number_ref`, and `cc.preview_number_pv` allocate numbers. One installation serves one customer (`016-device-inventory.sql:90`, `WHERE singleton`), so one sequence per prefix suffices.
- The display format is the prefix, a hyphen, and the number with at least three digits. Use `CASE WHEN n < 1000 THEN lpad(n::text, 3, '0') ELSE n::text END`. Plain `lpad(n::text, 3, '0')` truncates `1000` to `100`.
- Sequence gaps after a rolled-back transaction are acceptable. Display IDs stay unique. They do not count jobs.
- The API resolves `display_id` to `job_id` for every job route.

### 1.7 Grants

- Grant `SELECT` on the new tables and `EXECUTE` on the new functions to the runtime role in `deployment/postgres/index.mjs`, as the 016 block does (`index.mjs:249-271`).
- Every function is `SECURITY DEFINER` with `search_path=pg_catalog,cc` and revoked from `PUBLIC`, as in `016-device-inventory.sql:458-470`.
- Functions that the API calls on behalf of a person take `(p_actor, p_version)` and check grants, as `cc.device_reader` does (`016-device-inventory.sql:86-100`).

## 2. API contracts

### 2.1 Actions

- Add `devices:write`, `devices:bulk-actions`, and `jobs:read` to `actionSchema` (`libs/application-contracts/src/lib/authorization.ts:3-17`). Give each the scope kinds `platform` and `district` in `actionScopeKinds` (`authorization.ts:28-42`).
- 017 inserts the three actions into `cc.application_actions`, as `016-device-inventory.sql:4` does for `devices:read`.
- The bootstrap grants every action to the first administrator (`deployment/bootstrap/application-access.mjs:86-91`). The `platform-administrator` preset takes every action (`authorization.ts:98`). No bootstrap change is needed.
- Preview and confirmation require `devices:read`, `devices:write`, and `devices:bulk-actions` (eng-lead ruling 9). Jobs routes require `jobs:read`. Reconcile requires `jobs:read` and `devices:write` (OQ6).
- Interim visibility (D5): a holder of `jobs:read` at platform or district scope sees every job of the customer. No other scoping exists in this slice.

### 2.2 Contract files

- Add `libs/application-contracts/src/lib/device-updates.ts` and `libs/application-contracts/src/lib/jobs.ts`. Export both from `libs/application-contracts/src/index.ts`.
- Use `zod` strict objects, as `libs/application-contracts/src/lib/entity-cache.ts:62-98` does. Timestamps use `z.iso.datetime({ offset: true })` (`entity-cache.ts:5`).

Shared schemas in `jobs.ts`:

| Schema               | Shape                                                                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobDisplayIdSchema` | `^(UPD\|REF)-\d{3,}$`                                                                                                                                                                                                                                    |
| `jobStatusSchema`    | The eight statuses of section 1.2.                                                                                                                                                                                                                       |
| `jobActionSchema`    | `update-device-annotations` (label "Update device annotations") and `refresh-inventory` (label "Refresh inventory").                                                                                                                                     |
| `jobSummarySchema`   | `jobId`, `displayId`, `action`, `status`, `scope` (`kind`, `deviceCount`), `requestedBy` (`id`, `displayName`), `createdAt`, `startedAt`, `finishedAt`, `progress` (`total`, `done`, `succeeded`, `failed`, `unknown`, `skipped`, `pending`), `failure`. |
| `jobDetailSchema`    | The summary plus `confirmedBy`, `previewDisplayId`, `field`, `mode`, `requestedValue`, `targetOrgUnitPaths`, `correlationId`.                                                                                                                            |
| `jobOperationSchema` | `operationId`, `deviceId`, `serialNumber`, `orgUnitPath`, `operation` (`replace` or `clear`), `baselineValue`, `requestedValue`, `outcome`, `outcomeReason`, `googleStatus`, `googleReason`, `observedValue`, `verifiedBy`, `updatedAt`.                 |
| `jobActivitySchema`  | `running`, `waiting`, `recent`. Each holds `count` and at most 10 `jobs`. Plus `attention` (boolean) and `seenAt`.                                                                                                                                       |

`outcome` for a pending operation is `pending`. A `dispatched` operation reads as `pending` in the API. The API never shows `dispatched` as success.

### 2.3 Preview create and get

`POST /api/devices/updates/previews`

- Body: `selection` (the shape that `resolveSelection` takes: `gridId`, `tabId`, `rowIds`, `groupRoutes`, `predicates`, `by`, see `api/src/app/devices/devices.controller.ts:150-157`), `mode`, and `value`.
- `value` rules for `replace`: a string of 1 to 200 code points, counted as `[...value].length`, and not whitespace only. The API does not trim it. `clear` takes no `value` and writes `null`.
- The server resolves the selection against current data and current grants. The client never sends device IDs as the authority.
- It freezes every selected device into `cc.device_update_preview_targets` with its observed value and OrgUnit path.
- Dispositions: `eligible` when the observed value differs from the final value. `unchanged` when it equals the final value. `excluded` with reason `removed` when `removed_at` is set (`016-device-inventory.sql:46`).
- A selection above 100,000 devices returns `422` with reason `selection-too-large` (candidate default 7).
- Response `201`: `previewId`, `displayId`, `mode`, `value`, counts, `oldestObservedAt`, `stale` (an eligible target older than `ENTITY_FRESHNESS_HOURS`, `entity-cache.ts:13-15`), `preparedAt`, `expiresAt`, `manifestDigest`.

`GET /api/devices/updates/previews/:previewId` returns the same summary. A preview past `expiresAt` returns `410` with reason `preview-expired`.

`GET /api/devices/updates/previews/:previewId/targets?disposition=&cursor=&limit=` pages the frozen targets in ordinal order. Each row holds device ID, serial number, field, observed value, approved value, disposition, and exclusion reason. Figma `97:21` shows Device, Field, Observed value, Approved value.

New matching devices never join a preview or a job (`03-architecture.md:197`).

### 2.4 Confirm

`POST /api/devices/updates/previews/:previewId/confirm`

- Body: `manifestDigest` and `acknowledged: true`. The acknowledgment backs the checkbox "I reviewed all N devices and their final values." (Figma `97:57`).
- One transaction revalidates the caller grants, the permission version, the connection generation, the digest, and the expiry (`03-architecture.md:192-193`).
- It creates the `cc.jobs` row with status `accepted`, copies eligible targets into operations, and sets `preview.job_id`.
- A preview with `job_id` set returns `200` with the existing job receipt. A second click or a replayed request never creates a second job.
- Errors: `410 preview-expired`, `409 preview-changed` (digest mismatch), `409 permission-changed`, `409 connection-changed`, `422 nothing-to-update` (zero eligible targets), `403` for missing actions.
- Response `201`: `jobId`, `displayId`, `status: accepted`, `deviceCount`, `updateCount`. The receipt page "Update job created" (Figma `104:74`) renders it.
- After commit, the job service runs admission (section 6.5).

### 2.5 Jobs list, detail, operations, activity

| Route                                                             | Behavior                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/jobs`                                                   | Filters: `jobId` (exact display ID), `status` (list), `action` (list), `requestedBy` (principal IDs), `createdFrom`, `createdTo`, `finishedFrom`, `finishedTo`. Sort `createdAt` descending, then `displayId` descending (`jobs-grid.json:24-33`). Keyset `cursor` and `limit` up to 100. Returns `jobs`, `matching` count, and `observedAt`. |
| `GET /api/jobs/:displayId`                                        | `jobDetailSchema`. `404` for an unknown or purged job.                                                                                                                                                                                                                                                                                        |
| `GET /api/jobs/:displayId/operations?attention=&cursor=&limit=`   | Operations in operation-number order. `attention=true` returns only `failed` and `unknown` rows. Job counts stay unchanged (`jobs-grid.json:160-161`). Refresh jobs return `operations: []` and batch progress only.                                                                                                                          |
| `POST /api/jobs/:displayId/operations/:operationNumber/reconcile` | Section 2.6.                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/jobs/activity`                                          | `jobActivitySchema`. `running`: running jobs. `waiting`: accepted, queued, and held jobs. `recent`: jobs finished in the last 24 hours, newest first. `attention` is true when a job finished as `needs-review` or `completed-with-errors` after `seenAt`.                                                                                    |
| `POST /api/jobs/activity/seen`                                    | Stores `clock_timestamp()` in `cc.job_activity_seen` for the caller.                                                                                                                                                                                                                                                                          |
| `GET /api/jobs/events`                                            | Server-sent events. Section 3.                                                                                                                                                                                                                                                                                                                |

The list exposes only the filters above. The Jobs grid shows no other filter fields (`jobs-grid.json:119`). The entity-type filter has one value, `device`, in this slice.

### 2.6 Reconcile one operation

- The route accepts only an operation with outcome `unknown`. Other outcomes return `409 operation-settled`.
- The job service starts the Kestra flow `device_update_reconcile` with the job ID and the operation number. The API returns `202` with the operation in its current state.
- The worker reads the device with `GET` through the existing read path. It never writes. Section 5.5 gives the settlement rule.
- The settled operation arrives as a `job` event and in the next operations read.
- One reconcile at a time per operation. A second request while one runs returns `202` with no second flow.

### 2.7 Write access state

`GET /api/devices/write-access` returns `state` (`granted`, `denied`, `unchecked`, `unavailable`), `scope`, `checkedAt`, and `failure`. Section 4 defines it. The Devices page reads it to enable or disable Update device.

## 3. Live updates

### 3.1 Channel and fan-out

- Reuse the channel `cc:entity-events:{customerId}` (`libs/application-contracts/src/lib/entity-cache.ts:52-53`) and `EventFanout` (`api/src/app/devices/device-events.ts:31-34`).
- Add two members to `entityEventSchema` (`entity-cache.ts:86-98`):
  - `{ type: 'job', job: jobSummarySchema }` for every job status or progress change.
  - `{ type: 'job-backoff', jobId, attemptId, sequence }`, internal to the job service (section 6.3). No browser stream forwards it.
- `EventFanout.deliver` drops events that fail the schema (`device-events.ts:91-101`). The schema change must merge before any publisher change.
- Keep `entity-batch`, `job-finished`, and `full-sync` unchanged. The Devices store reads them (`frontend/src/app/devices/devices.store.ts:600-602`).
- Write batches publish `entity-batch` with the succeeded device IDs, as refresh batches do (`worker/src/entity-sync.ts:272-281`). Open grids refresh those rows in place.

### 3.2 Publishers

| Change                                       | Publisher                                                     |
| -------------------------------------------- | ------------------------------------------------------------- |
| A job is accepted, queued, held, or admitted | The job service (API)                                         |
| A refresh job is created                     | The API (`device-refresh.ts:55-75`) and `requestSync`         |
| A batch settles, with new counts             | The worker, after its database commit                         |
| A job reaches a terminal status              | The worker (finish task) or the job service (abandon, reaper) |
| An operation settles through reconcile       | The worker                                                    |

The API rule grants `subscribe` but no `publish` (`deployment/redis/runtime.mjs:11`). The worker rule grants `publish` on `cc:entity-events:*` (`runtime.mjs:14`).
Card P1 adds `+publish` to the API rule. Keys and channels stay under `cc:*` (`deployment/redis/README.md:20`).

### 3.3 `GET /api/jobs/events`

- Use `streamEvents` (`device-events.ts:199-258`) with a listener that forwards only `job` events.
- Each ping rechecks the session and `jobs:read`, as the devices stream rechecks its access (`devices.controller.ts:186-202`).
- The stream starts after the subscription is active (`device-events.ts:199-201`). After each open or reconnect, the client reads `GET /api/jobs/activity`, or the current Jobs page, and then applies events. This closes the gap between read and subscribe.
- The edge serves `/api/jobs/events` with the buffering rules of `/api/devices/events`. Card P1 adds the route to `deployment/bootstrap/application-edge.mjs`.
- The activity summary is not a pushed document. The client merges `job` events into its activity store by `jobId`. It moves a job between running, waiting, and recent by status. It keeps at most 10 rows per section and the section counts from the last read.
- The shell opens the jobs stream on every page, because the activity area lives in the shell. The Devices page keeps its own stream.

## 4. Write-scope capability

### 4.1 Setup scope list (D2)

- Add capability `device-changes` to `GOOGLE_CAPABILITIES` (`libs/application-contracts/src/lib/google-capabilities.ts:2-69`).
  - `label`: "ChromeOS device changes".
  - `scope`: `https://www.googleapis.com/auth/admin.directory.device.chromeos`.
  - `method`: `chromeosdevices.patch`. `requiredForConnection`: false. `enabled`: true. `qualified`: false.
  - `evidence`: "admin-sdk-mock v0.2.0 only. No live write check."
- Add `device-changes` to `GOOGLE_SETUP_CAPABILITY_IDS` after `device-telemetry` (`google-capabilities.ts:72-77`). `GOOGLE_SETUP_SCOPES` then lists the scope (`google-capabilities.ts:83-91`). Copy scopes on the connection page includes it.
- `GOOGLE_CUSTOMER_SCOPES` stays unchanged, because the capability is not required for connection (`google-capabilities.ts:93-102`). Read-only districts still connect.
- The mock harness grants every `GOOGLE_CAPABILITIES` scope (`api-e2e/admin-sdk-mock-fixture.mjs:24-27`). The new scope reaches the mock delegation without a harness change.

### 4.2 Capability evaluation

- The check mints a token for the write scope alone. It then lists one device with that token (`chromeosdevices.list`, `maxResults=1`). The mock accepts the write scope for reads (`mock@v0.2.0:src/auth/scopes.ts:18-21`).
- The check never writes. An empty device collection still proves the grant.
- Result mapping: success gives `granted`. `delegation-not-authorized`, `scope-mismatch`, and `permission-denied` give `denied`. Other failures give `unavailable`.
- The API runs the check in process, as the health check reads Google in process (`api/src/app/auth/google-connection.service.ts:392-402`). It caches the result for `GOOGLE_HEALTH_FRESH_SECONDS` (300 s, `libs/application-contracts/src/lib/google-health.ts:8`).
- A write job that receives a scope denial sets the state to `denied` at once (section 7.2).
- `googleHealthCapabilitySchema` stays limited to the connection capabilities (`google-health.ts:10-13`, `60-74`). The write-access state is a separate projection. This keeps the connection health page unchanged.

### 4.3 The scope-named message

- While the state is `denied`, Update device stays disabled with this message: "Google denied device changes. Add https://www.googleapis.com/auth/admin.directory.device.chromeos to the delegation client in the Google Admin Console."
- The message follows the owner rule that Devices access messages name the denied scope (`docs/workflows/device-browsing.md:118`).
- Without PR #33, a missing scope reads as `credential-rejected` (`provider.ts:115-126`). Card B6 depends on PR #33.
- While the state is `unchecked` or `unavailable`, Update device stays disabled with a recheck action. The draft page never opens without `granted`.

### 4.4 One scope per token

- Every token carries exactly one scope. A token with another scope set fails with `scope-mismatch` (`libs/google-connection/src/lib/provider.ts:250-270`).
- Write batches use a token for the write scope only. Read-back uses the existing inventory token for the read-only scope.
- Writes travel only inside the Directory batch endpoint, which the URL allowlist already names (`provider.ts:207-224`). The per-device path is a batch part path, checked by `validateRequests` (`batch.ts:191-198`). The allowlist stays unchanged.
- Device IDs enter part paths only after the plain-identifier check of `016-device-inventory.sql:372-375`.

## 5. Execution

### 5.1 Kestra flow `device_update`

- Add `deployment/kestra/device-update.yaml`, modeled on `deployment/kestra/entity-sync.yaml`.
- Concurrency limit 1 with QUEUE behavior, as a backstop. The job service admits one write job at a time (section 6). Kestra therefore never queues a second write execution in normal operation.
- A `ForEach` over batch indexes with concurrency 1. Each iteration posts to the worker `/dispatch/device-update-batch` (pattern: `entity-sync.yaml:17-36`).
- Retry 3 times every 5 s only for a dead batch runner, as `entity-sync.yaml:42-47` does. Kestra schedules retries. Workers own request backoff (`03-architecture.md:232`).
- A final task posts to `/dispatch/device-update-finish`. It also runs on flow failure, so the job always settles.
- The API deploys the flow before each execution, as `OrchestrationService` does (`api/src/app/orchestration/orchestration.service.ts:53-74`). A new `startDeviceUpdate` method follows `startEntitySync` (`orchestration.service.ts:100-114`).
- Add `deployment/kestra/device-update-reconcile.yaml` with one task that posts to `/dispatch/device-update-reconcile`.
- Worker handlers reuse the dispatch secret check and the JSON content-type check (`worker/src/dispatch.ts:141-160`, `255-266`).

### 5.2 Batches

- One batch holds at most 250 operations, the batch service limit (`libs/google-connection/src/lib/batch.ts:87`). One Kestra iteration sends one batch.
- The batch service keeps one multipart call in flight (`batch.ts:97`). Batches of one job run in order.
- Each part is `PATCH /admin/directory/v1/customer/{customerId}/devices/chromeos/{deviceId}` with body `{ "annotatedLocation": value }`. Clear sends `{ "annotatedLocation": null }`. The body names no other field.
- The batch service accepts a body for PATCH (`batch.ts:160-167`, `199-202`).
- The mock routes PATCH to `directory.chromeosdevices.patch` (`mock@v0.2.0:src/routes.ts:36-37`). It changes only the fields in the body (`mock@v0.2.0:src/directory/device-writes.ts:47`). `null` stores no value (`device-writes.ts:61`).

### 5.3 Revalidation before dispatch

`cc.claim_device_update_batch(p_customer, p_job, p_batch, p_attempt, p_execution)` runs first in every batch. It checks:

1. The job is `running` and the batch index exists.
2. The requester and the confirmer are enabled and keep their permission versions from confirmation (pattern: `016-device-inventory.sql:91-92`).
3. Their grants still include `devices:write` and `devices:bulk-actions` (pattern: `016-device-inventory.sql:93-95`).
4. The connection generation equals the job generation (pattern: `cc.google_current_generation` at `016-device-inventory.sql:409`).

A failed check marks the job failure `permission-changed` or `connection-changed`. It marks every `pending` operation `skipped` with the same reason. The batch sends nothing.
This applies the rule "Revalidate queued work before dispatch" (`03-architecture.md:177`).

### 5.4 Claim, intent, and fencing

- The claim sets `attempt_id`, `lease_expires_at` (10 minutes), and status `dispatched` on the batch's `pending` operations. It returns them with the credential envelope, as `cc.read_entity_sync_batch` does (`016-device-inventory.sql:401-417`).
- The claim commits before the worker contacts Google. This records intent first (`03-architecture.md:225-226`).
- An operation already `dispatched` under an expired lease or another attempt becomes `unknown`. The worker never resends it blindly (`03-architecture.md:243`).
- A live lease held by another attempt rejects the claim. A duplicate Kestra request then exits without a Google call (`03-architecture.md:238-239`).
- `cc.record_device_update_results(p_customer, p_job, p_batch, p_attempt, p_results)` updates only operations whose `attempt_id` equals `p_attempt`. It updates the job counters in the same transaction.
- The worker renews the lease on each batch-service round through `onBatch` (`batch.ts:118-126`, `139-140`).

### 5.5 Outcomes and read-back

| Outcome     | When                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `succeeded` | Google returned 2xx for the part. Or a read-back shows the requested value.                                   |
| `failed`    | Google returned a definitive refusal (section 7.1). Or a read-back shows a different value (`value-differs`). |
| `unknown`   | The part ended without a definitive answer. The read-back failed or has not run.                              |
| `skipped`   | The job stopped before the operation was sent: revalidation failure, scope denial, or interruption.           |

- After each batch, the worker reads back every `unknown` operation of that batch. It uses the existing device read (`libs/google-connection/src/lib/devices.ts:342-405`) with the read-only token. That read sends `GET` parts by ID (`devices.ts:357-365`).
- A read-back `404` settles the operation as `failed` with `not-found`. A read-back error leaves it `unknown`.
- The mock serves a `get` from current data. Only lists lag (`mock@v0.2.0:docs/guide/behavior.md:70-74`).
- Reconcile (section 2.6) applies the same rule to one operation.
- `unknown` never becomes success without a matching read (`docs/ui/jobs-grid.json:176`).

### 5.6 Write overlays and in-place grid updates

- On `succeeded` from a write response, the worker upserts the returned device through `cc.upsert_devices` (`016-device-inventory.sql:217-239`). The write response carries the updated device (Google guide, findings 2.8).
- The freshness stamp comes from Postgres before the request, as refresh batches stamp it (`worker/src/entity-sync.ts:182-189`).
- The same transaction writes `cc.device_write_overlays` with `expires_at = written_at + 36 hours`. The mock guide quotes Google: some updates take up to 36 hours to appear (`mock@v0.2.0:docs/guide/behavior.md:69`).
- 017 replaces `cc.upsert_devices`. An unexpired overlay keeps its value when a newer observation differs. An observation that matches deletes the overlay. Today a newer observation always wins (`016-device-inventory.sql:235`).
- The device record (`cc.device_record`, `016-device-inventory.sql:205-215`) gains `annotatedLocationWrite`: `jobDisplayId`, `writtenAt`, and `verified` (false while the overlay waits for a matching read). OQ2 covers its display.
- The worker then rewrites the Redis records of the batch (pattern: `entity-sync.ts:245-255`). It increments the query generation (`entity-cache.ts:48-49`) once per batch with a success. Cached query results that filter on the field then miss.
- It publishes `entity-batch` and a `job` event after the commit.

### 5.7 Evidence files

- Confirmation stages the frozen manifest as a JSON artifact through `StorageService` (`api/src/app/storage/storage.service.ts:23-33`). The manifest holds the preview, the targets, the values, the requester, and the confirmer.
- The finish task stages the result file: one row per operation with outcome and evidence.
- These files satisfy the file-artifact rule for every mutation (findings 2.7, R02). Downloads stay out of this slice.
- An artifact failure at confirmation fails the confirmation. "Stop new external dispatch when durable intent or audit persistence fails." (`03-architecture.md:259`).

### 5.8 Finish and terminal status

`cc.finish_device_update_job` derives the status from the counters:

| Status                  | Rule                                                       |
| ----------------------- | ---------------------------------------------------------- |
| `needs-review`          | `unknown > 0`                                              |
| `completed`             | `succeeded = target_count`                                 |
| `completed-with-errors` | `unknown = 0`, `succeeded > 0`, and `failed + skipped > 0` |
| `failed`                | `unknown = 0` and `succeeded = 0`                          |

- Remaining `pending` operations become `skipped` with the job failure as reason.
- After the finish commits, the worker publishes the `job` event. The job service then cleans the hold and runs admission (section 6).
- The job service reaper finishes a `running` write job whose leases all expired more than 30 minutes ago. Its `dispatched` operations become `unknown`. Its `pending` operations become `skipped` with `interrupted`.

## 6. The admission hold (D4)

### 6.1 Policy summary

The owner-accepted policy is `docs/reviews/2026-09-04-job-admission-policy.md`:

- Workers report backoff. The job service writes the hold with a five-minute TTL. Workers never write hold keys (line 12).
- The hold blocks admission of new Update Device jobs. Admitted jobs continue. Other job types stay eligible (line 14).
- Pending jobs of the held type sort smallest first. A small arrival does not bypass the hold (line 16).
- Reports overwrite the owner. No create-if-absent (line 18). Cleanup requires current ownership (lines 20-22).
- The TTL is exactly 300 seconds (line 51). Reports during long waits arrive more often than every five minutes (line 51).

### 6.2 Key and commands

| Item           | Design                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Key            | `cc:job-hold:{customerId}:device-update`. It scopes by customer and canonical job type (policy line 45).                          |
| Value          | The owning `job_id`.                                                                                                              |
| Write          | `SET key jobId EX 300`. No `NX`, no `XX`. One command writes owner and TTL together (policy line 51).                             |
| Cleanup        | One Lua script with explicit keys: delete only when the value equals the finishing job ID (policy lines 41-43).                   |
| Registry       | `cc.jobs.hold_written_at`. One job type and one customer give one key per job. Cleanup runs only when it is set (policy line 45). |
| Admission read | `GET key`. Presence means held.                                                                                                   |

The API rule already allows `get`, `set`, `del`, and `eval` on `~cc:*` (`deployment/redis/runtime.mjs:11`). The worker rule names only entity, query-generation, and in-flight keys (`runtime.mjs:14`).
Workers therefore cannot write the hold. Card P1 adds a test that pins both rules.

### 6.3 Backoff reports

- The worker observes batch-service retries through `onResponse` events with outcome `retry` and failure kind `quota` (`batch.ts:107-116`, `908-915`).
- On the first such event of a round, and every 60 s while any part waits, the worker calls `cc.report_device_update_backoff(p_customer, p_job, p_attempt, p_sequence)`.
- The function accepts the report only while the job is `running` and `p_attempt` holds a live lease. It rejects stale attempts and terminal jobs (policy line 53).
- After an accepted report, the worker publishes `job-backoff`. The job service checks the job status in Postgres. It then writes the hold and sets `hold_written_at`.
- The 60-second interval stays below the 300-second TTL (`03-architecture.md:275`). The batch service caps one wait at 60 s (`batch.ts:92`), so reports continue through long retry sequences.
- Only `device-update` jobs report in this slice. OQ3 asks whether refresh throttles also hold Update Device admission.
- Early release after successful calls (policy line 24) stays out of this slice. The policy requires a recorded unit and threshold first (line 65). OQ4.

### 6.4 Cleanup

- The job service runs cleanup when a write job reaches a terminal status, through the `job` event, the reaper, or the Kestra finish task.
- Cleanup runs the compare-and-delete script only when `hold_written_at` is set. A previous owner never deletes a newer owner's hold (policy line 22).
- A crash without cleanup leaves the hold for at most 300 s after its last write (policy line 35).

### 6.5 Admission

The job service runs one admission decision at a time, in one process (`03-architecture.md:290`, `293`). Triggers: a confirmation, a terminal `job` event, a hold write, a cleanup, and a 15-second timer.

1. Read the hold key. A Redis error counts as held. Admission fails closed and retries on the next tick.
2. Call `cc.admit_device_update_job(p_customer, p_held)`. It locks pending write jobs with `FOR UPDATE`.
3. If a write job is `running`, label pending jobs `held` when `p_held` is true and `queued` otherwise. Admit nothing.
4. If no write job runs and `p_held` is true, label pending jobs `held`. Admit nothing.
5. Otherwise admit one job: smallest `target_count`, then oldest `created_at`, then lowest `display_id` (policy line 71). Set `running` and `admitted_at`. Label the rest `queued`.
6. Start the Kestra execution. If Kestra refuses the start, set the job `failed` with `orchestration-unavailable`, as refresh jobs do (`016-device-inventory.sql:384-398`). No operation was sent.
7. An ambiguous start response needs no special case. A duplicate execution fails the batch claim (section 5.4).

Ordering with hold writes: the in-process lock serializes hold writes and admission decisions. A hold written before step 1 blocks the decision. A hold written after step 5 commits treats the admitted job as existing work (policy line 69). This is the one defined ordering (policy line 89).
Pending jobs stay durable in Postgres. Redis holds only the hold flag (`03-architecture.md:291`).

### 6.6 Held and the one-active-job queue

- One write job runs at a time (eng-lead ruling 10). Pending write jobs wait behind it in both cases. The hold decides only their label and their eligibility after the active job ends.
- `queued`: no hold exists, and the active write slot is busy.
- `held`: a hold exists. The UI says "Waiting to start · Google backoff" and promises no start time (`docs/ui/patterns.md:254`).
- The active job owns the hold in normal operation. Its finish deletes the hold, and the smallest pending job starts (policy line 33).
- The hold delays a start only after a crash without cleanup. It also prepares a future slice with more than one active write job, where owner replacement occurs (policy line 18).
- Refresh jobs and full syncs never wait for the hold or for the write slot.

## 7. Failure classification

### 7.1 Per operation

The batch service classifies each part (`batch.ts:415-434`) and retries quota and transient answers (`batch.ts:878-915`).

| Final batch-service result                        | Operation outcome | Reason                                        |
| ------------------------------------------------- | ----------------- | --------------------------------------------- |
| 2xx                                               | `succeeded`       | `verified_by=write-response`                  |
| `not-found` (404)                                 | `failed`          | `not-found`                                   |
| `rejected` (other 4xx, for example 400 `invalid`) | `failed`          | The Google reason                             |
| `auth` (401 or a non-quota 403)                   | `failed`          | The Google reason. Section 7.2 stops the job. |
| `quota` after 25 retries, no transient attempt    | `failed`          | `quota`                                       |
| `quota` after a transient attempt                 | `unknown`         | `ambiguous`                                   |
| `transient` after 10 retries                      | `unknown`         | `ambiguous`                                   |
| `invalid-response`, `aborted`, status 0           | `unknown`         | `ambiguous`                                   |

- An earlier attempt without a definitive answer taints the operation. `BatchFailure.attempts.transient` counts those attempts (`batch.ts:36-49`). Only a final 2xx or a final definitive refusal clears the taint.
- The batch service retries PATCH on 5xx, because only POST counts as unsafe (`batch.ts:890-893`). Section 7.3 accepts that retry.
- Quota retries honor `Retry-After` (`batch.ts:95`, `437-446`). Without it they use full-jitter backoff up to 60 s (`batch.ts:449-459`).

### 7.2 Job-level failures

- A token mint failure for the write scope sends nothing. The batch's operations become `skipped` with `delegation-not-authorized`. The job failure takes the same code. Write access becomes `denied` (section 4.2).
- A batch where every part fails with `auth` stops the job the same way. Later batches skip.
- A credential that cannot open gives `key-unavailable`, as refresh batches map it (`entity-sync.ts:263-268`).
- A store failure after Google answered leaves the batch operations `dispatched`. A Kestra retry turns them `unknown` and reads them back (section 5.4).

### 7.3 Why Replace and Clear are safe to repeat

- Each request sets an absolute final value: the approved string, or `null`. A repeat produces the same device state.
- The body names one field. Patch semantics leave other fields untouched (`mock@v0.2.0:src/directory/device-writes.ts:47`).
- Prepend and Append compute the value from a baseline. They stay out of this slice (D1). The architecture forbids appending again during a retry (`03-architecture.md:249`).
- A repeat overwrites a change that another administrator made between attempts. A single request has the same race. Neither Google nor the mock offers a precondition here (findings 2.8, 6.1).
- Local idempotency prevents duplicate jobs. It creates no Google idempotency (`03-architecture.md:237`).

### 7.4 Unknown effects

- The UI shows `unknown` as "Unknown", and the job as "Needs review". It never relabels uncertainty (`docs/ui/patterns.md:257`).
- The read-back settles most unknown operations automatically. Reconcile settles the rest on request.
- No automatic resend of an `unknown` operation exists in this slice. Retry stays out of scope.

## 8. Test strategy on admin-sdk-mock

### 8.1 Mock facilities

| Need                    | Mock facility                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patch faults            | `POST /domains/{id}/faults` with kind `status`, `error-rate`, `hang`, or `reset` and `method: directory.chromeosdevices.patch` (`mock@v0.2.0:docs/guide/configuration.md:309-322`). |
| Throttling for the hold | A `status` fault with 429 on the patch method for a counted number of calls.                                                                                                        |
| Scope removal           | `remove-scope` for the write scope (`configuration.md:309-322`). Token exchange then answers 401 `unauthorized_client` (`mock@v0.2.0:src/auth/token.ts:103-113`).                   |
| Scope grant             | `PUT /domains/{id}/delegation/{clientId}` with the scope list (`mock@v0.2.0:docs/guide/testing.md:275`).                                                                            |
| List lag                | `writes.searchDelaySeconds`, 300 s by default (`mock@v0.2.0:docs/guide/behavior.md:70`). `POST /domains/{id}/index/flush` ends it (`testing.md:175-183`).                           |
| Validation              | Over 200 code points answers 400 `invalid` (`mock@v0.2.0:src/directory/common.ts:118-136`).                                                                                         |
| Write scope rules       | Writes need the write scope only (`mock@v0.2.0:src/auth/scopes.ts:49-50`).                                                                                                          |

- The product harness starts the pinned mock (`api-e2e/admin-sdk-mock-fixture.mjs:215-388`). Nx targets: `api-e2e:admin-sdk-mock-integration` and `api-e2e:client-review-mock` (`api-e2e/project.json:22-60`).
- Every mock write ruling is unverified against live Google (`mock@v0.2.0:docs/guide/behavior.md:145`). Live write behavior stays "not verified".

### 8.2 Failing-first rule

Each card commits each new test before its implementation. The handoff pastes the failing run on the parent revision and the passing run on the card revision.
A test that cannot fail without the change does not count.

### 8.3 Tests per card

| Card  | Tests                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1    | Contract tests: display ID pattern, status enum, strict objects reject extra keys, `value` limits at 200 and 201 code points with a 4-byte character, whitespace-only rejected, Clear rejects a value.                                                                                                                                                                                                          |
| B2    | Postgres integration (pattern: `deployment/postgres/device-inventory.integration.mjs`): ID format at 999 and 1000, unique one-running write index, admission order with ties, purge keeps write jobs and drops 8-day refresh jobs, fenced result recording rejects a stale attempt, revalidation skips after a grant change, overlay keeps a value against a newer differing observation and clears on a match. |
| B3    | API tests: preview freezes targets, a device added after preview never joins, expiry gives 410, second confirm returns the same job, digest mismatch gives 409, missing `devices:bulk-actions` gives 403 and an `access-denied` audit row (`api/src/app/auth/auth.service.ts:311-331`).                                                                                                                         |
| B4    | API tests: list sort and keyset stability, each filter, attention filter keeps counts, activity sections and the 10-row cap, `seen` clears `attention`, jobs stream forwards only `job` events and closes when `jobs:read` goes away, refresh jobs and full syncs appear as REF- jobs with requesters.                                                                                                          |
| B5    | Job service tests with a real Redis: hold `SET` overwrites another owner and resets TTL to 300, cleanup by a previous owner keeps the newer hold, Redis error blocks admission, admission racing a hold write follows section 6.5, and the policy acceptance scenarios that apply (`2026-09-04-job-admission-policy.md:77-91`).                                                                                 |
| B6    | Capability tests: setup scopes include the write scope, `remove-scope` gives `denied` and the exact message, delegation grant through the mock control gives `granted`, the check sends no write (mock request log).                                                                                                                                                                                            |
| P1    | Flow tests: the flow YAML validates, concurrency 1, retry only for a dead runner, the finish task runs after a failed batch. ACL tests: the worker user cannot write the hold key, the API user can publish on the channel.                                                                                                                                                                                     |
| P2    | Worker tests with a fake batch client and on the mock: PATCH body holds only `annotatedLocation`, Clear sends `null`, batch of 250, fault classes of section 7.1, read-back settles `unknown`, `hang` then retry gives `unknown` then read-back, duplicate dispatch sends one Google request, overlay survives a lagged list until `flush`, backoff reports every 60 s during waits.                            |
| F1-F6 | Component and browser tests per card in section 9, against the named frames.                                                                                                                                                                                                                                                                                                                                    |
| Q1    | End-to-end on the mock: the six completion items of the brief, run in one fresh installation.                                                                                                                                                                                                                                                                                                                   |

## 9. Implementation cards

Operator direction (2026-10-16 21:35): no frontend card waits on design approval. Each frontend card follows its named frames and the approved activity-area mockup.
Each card inspects its Figma frames before implementation (`AGENTS.md`, client UI rules). Each card states what it did not verify.

| ID  | Profile  | Title                                                        | Depends on |
| --- | -------- | ------------------------------------------------------------ | ---------- |
| B1  | backend  | Contracts and actions for device updates and jobs            | none       |
| B2  | backend  | Migration 017: jobs, previews, operations, overlays, purge   | B1         |
| B3  | backend  | Device update preview and confirm API                        | B2         |
| B4  | backend  | Jobs API, refresh jobs as REF- jobs, activity, jobs stream   | B2         |
| B5  | backend  | Job service: admission, hold, reaper, reconcile route        | B4, P1     |
| B6  | backend  | Device write capability and write-access state               | B1, PR #33 |
| P1  | platform | Kestra flows, orchestration starts, Redis ACL, edge route    | B1         |
| P2  | platform | Worker write batches, read-back, overlays, events, reports   | B2, P1     |
| F1  | frontend | Bulk Actions, Update device entry, draft page                | B3, B6     |
| F2  | frontend | Preview, confirmation, receipt page                          | F1, B3     |
| F3  | frontend | Jobs navigation item and Jobs page                           | B4         |
| F4  | frontend | Job detail, operations, Inspect failure, Reconcile           | F3, B5     |
| F5  | frontend | Jobs activity area                                           | B4         |
| F6  | frontend | In-place grid updates and write verification state           | P2, OQ2    |
| Q1  | qa       | Mock demonstration and adversarial verification of the slice | all above  |

B1. Scope: sections 2.1, 2.2, and 3.1 schema members. Acceptance: `npm exec nx test application-contracts` passes with the B1 tests. The three actions exist in `actionSchema` and `actionScopeKinds`.

B2. Scope: section 1 and the SQL functions of sections 5 and 6. Acceptance: a fresh installation applies 001 to 017. The B2 integration tests pass. `checkReadiness` reports ready (`deployment/postgres/index.mjs:277-296`).

B3. Scope: section 2.3 and 2.4, a `DeviceUpdatesController` under `api/src/app/devices/`. Acceptance: the B3 tests pass. Duplicate confirmation never creates a second job. The manifest artifact exists for each job.

B4. Scope: section 2.5, section 3.3, section 1.3, and a `jobs` module under `api/src/app/jobs/`. Acceptance: the B4 tests pass. A stale-page refresh and a Refresh all both appear in `GET /api/jobs` with REF- IDs and requesters.

B5. Scope: section 6 and section 2.6. Acceptance: the B5 tests pass. A second write job reads `held` while the hold exists and `running` after cleanup or expiry. Refresh jobs run during a hold.

B6. Scope: section 4. Acceptance: the B6 tests pass. The connection page lists the write scope. Removing the scope in the mock disables Update device with the exact message.

P1. Scope: sections 5.1, 3.2 ACL, 3.3 edge route, 6.2 ACL. Acceptance: the P1 tests pass. Kestra runs `device_update` against the worker in the mock stack.

P2. Scope: sections 5.2 to 5.8, 6.3, and 7. New worker modules beside `worker/src/entity-sync.ts`. Acceptance: the P2 tests pass. No code path sends a PATCH part without a committed claim.

F1. Frames `94:3`, `213:4199`, `216:4309`, `94:75`. Bulk Actions shows one item, "Update device". The draft page shows the selected count, Annotated location, and Change mode with "Update · Replace the existing value" and Clear value. It omits Organization unit (eng-lead ruling 2). Disabled reasons: empty selection, write access not `granted`, offline. "Review pending devices" shows the selected devices in the Devices grid and keeps the draft. Counts use thousands separators.

F2. Frames `97:21`, `97:57`, `104:74`, and `104:434` for an expired preview. The preview pages every target with Observed value and Approved value, counts, exclusions with reasons, stale warning, preparation time, expiry, and preview ID. The confirmation requires the checkbox and disables Create update job while the request runs. The receipt page shows "Update job created" with Back to devices and View job, and Jobs is the active navigation item.

F3. Frames `106:109`, `231:5009`, `234:4950`, `234:5142`, `234:5325`, `234:5510`. Jobs becomes a main navigation item (D3) in `frontend/src/app/app.routes.ts` and `frontend/src/app/shell/shell.html`. The grid follows `docs/ui/jobs-grid.json` and JOB-03. It exposes only the server filters of section 2.5. Refresh reads job state only.

F4. Frames `104:209`, `231:4707`, `228:4524`. Detail shows identity, counts, the attention filter, operations, Inspect failure for failed rows, and Reconcile for unknown rows. It shows no Cancel, Retry, Pause, or download (eng-lead ruling 20).

F5. Source: the approved mockup `docs/ui/designs/2026-10-16-jobs-activity-area.html` and `.png` (D6). The Activity button sits left of Help with the running count and ring. The attention dot clears through `POST /api/jobs/activity/seen`. The panel lists Running, Waiting, and Recent from `GET /api/jobs/activity` and the jobs stream. Each row opens its job detail. "View all jobs" opens the Jobs page.

F6. The Devices grid applies `entity-batch` events from write jobs in place. It keeps drafts, selection, and focus (JOB-02). It shows the verification state of a written value after OQ2 resolves.

Q1. Runs the six completion items of the brief on the mock in a fresh installation. It attacks the green suites with the policy acceptance scenarios and with duplicate submission, duplicate dispatch, and stale attempts. It records live write behavior as not verified.

## 10. Risks and open questions

### 10.1 Risks

| Risk                                                                                            | Mitigation                                                                                               |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Live write behavior is unverified. The Easton fixture has 0 devices and no write authorization. | Tests use the mock only (eng-lead ruling 27). A live check needs another tenant and owner authorization. |
| Google's ChromeOS batch quota statement conflicts with the generic rule (findings 2.8).         | Admission uses observed throttles only (policy line 93). Card Q1 records observed retries.               |
| List observations lag writes by up to 36 hours.                                                 | Overlays protect accepted values (section 5.6). A matching read clears them.                             |
| A worker fails after Google accepts a write and before Postgres records it.                     | Intent first, fencing, and read-back (sections 5.4 and 5.5).                                             |
| Smallest-first ordering starves a large job under constant small arrivals (policy line 73).     | Keep the owner ordering. Log the age of the oldest waiting job.                                          |
| The job service runs in one API process (`03-architecture.md:293`).                             | Postgres locks still prevent a second running write job. A second instance needs qualification first.    |
| Redis is unavailable.                                                                           | Admission fails closed. Running jobs continue. The hold expires by TTL.                                  |
| A concurrent administrator change is overwritten by a repeated write.                           | Section 7.3. No precondition exists.                                                                     |
| Code depends on PR #33.                                                                         | Card B6 waits for PR #33.                                                                                |

### 10.2 Open questions

| ID  | Question                                                                                                                            | Owner of the answer             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| OQ1 | Does "at most 10" cap the Recent section or the whole activity panel? The API returns 10 rows per section, which serves both.       | owner via eng-lead              |
| OQ2 | Which frame shows a written value that waits for a matching Google read in the Devices grid (candidate default 13)?                 | owner via eng-lead              |
| OQ3 | Do refresh-job throttles also hold Update Device admission? Policy line 12 names workers in general.                                | owner via eng-lead              |
| OQ4 | Early release after successful calls: the counted unit and threshold (policy lines 24 and 65). Not built in this slice.             | owner via eng-lead              |
| OQ5 | Does the activity attention dot clear per person (this design) or per browser?                                                      | owner via eng-lead              |
| OQ6 | Does Reconcile require `devices:write` (this design) or only `jobs:read`?                                                           | owner via eng-lead              |
| OQ7 | Is the status rule of section 5.8 correct when every operation failed (`failed`) and when some were skipped?                        | eng-lead in the workflow record |
| OQ8 | Do Prepend and Append in the next slice need an operation precondition before a repeat? Section 7.3 holds only for absolute values. | next slice design               |
