# Technical design: annotated-location writes, write jobs, the admission hold, and the jobs API

Status: approved technical design, revision 6, 2026-10-17. Author: architect. The reviewer approved it at `057b990`.
Slice: development order step 4 (`docs/current-work.md:64`). The intake brief (eng-lead, 2026-10-16, revision 3) is the contract.
Owner decisions D1 to D6 in that brief are binding. This record invents no product behavior.
The owner merged the workflow record `docs/workflows/update-device-annotated-location.md` through PR #36 as commit `3eab39a`, on 2026-10-16 at 23:39 EDT.
The eng-lead note of 23:39 states that the merge confirms the record. This design follows that record on origin/main.
Section 10.2 records the eng-lead rulings on the open questions of revision 1 and the questions that stay open.
This design changes seven owner-confirmed decisions of the entity cache record. Six need the owner gate. Reviewer approval does not authorize those six. The owner confirmed all six on 2026-10-17.
The section "Owner decision gate" states the gate. D10 stays outside the gate by the OQ10 ruling.

## Conventions

- Code references name a repository path and line at commit `72cd2c3`, the base of branch `codex/device-write-jobs-design`.
- `mock@v0.2.0:` references name files of admin-sdk-mock at tag `v0.2.0`. `package.json:12` pins that release.
- PR #33 (`codex/delegation-401-classification`) merged as `18b0e38`. PR #36 (`codex/annotated-location-workflow`) merged as `3eab39a`.
  origin/main `3eab39a` contains both. Implementation cards branch from origin/main.
- `main@3eab39a:` references name files at origin/main `3eab39a`. They cite the workflow record, the approved activity-area mockup, and the 401 classification of PR #33 (section 4.3).
  The record and the mockup do not exist at `72cd2c3`.
- origin/main moves lines in four cited files. In `libs/google-connection/src/lib/provider.ts`, lines 115-121 move to 121-127.
  Lines 122-126 move to 116-120. Lines after 126 move down by one. The `docs/current-work.md` step 4 line moves from 58 to 66.
  In `docs/workflows/device-browsing.md`, lines after 119 move down by two. Line 141 moves to 143. Line 155 moves to 157.
  `frontend/src/app/shell/shell.html:121-127` moves to lines 122-128.
  No other file cited at `72cd2c3` differs between `72cd2c3` and `3eab39a`.
- origin/main moved to `4311a9b` after `3eab39a`. That merge changes only `api-e2e/all-docker.test.mjs`. This record cites no line of that file.
- "Job service" names the logical owner of admission, hold updates, and terminal cleanup (`docs/portfolio/03-architecture.md:63-67`). Section 6.5 places it.
- Development databases are disposable (`AGENTS.md:27-29`). Nothing below migrates, upgrades, or preserves existing development data.

Terms. Each term names one thing in this record.

| Term                 | Meaning                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution            | One Kestra execution of a flow.                                                                                                                                      |
| Dispatch token       | The identity of the current execution of one write job. Section 5.3.                                                                                                 |
| Attempt              | One worker request that works on one batch or one read-back. Each request draws a new UUID.                                                                          |
| Lease                | The time until which one attempt owns one batch. Section 5.4.                                                                                                        |
| Read-back            | A GET by device ID that settles an `unknown` operation. Section 5.7.                                                                                                 |
| Reconcile            | The job detail action that starts a read-back of one operation. Section 2.6.                                                                                         |
| Overlay              | A row of `cc.device_write_overlays`. It protects a written value from lagged lists. Section 5.8.                                                                     |
| Open request         | A request that left the worker without a definitive answer: a transient answer, a lost answer, a lost part, a fatal batch error, or an abort in flight. Section 7.1. |
| Tick                 | The 5-second timer of the job service. Section 6.5.                                                                                                                  |
| Current observation  | A write response, a read-back, or a refresh read. It shows current Google data, unlike a lagged list. Section 5.8 defines its stamp.                                 |
| Current-value stamp  | `cc.devices.annotated_location_observed_at`. The stamp of the newest current observation that set the annotated location. Section 5.8.                               |
| Record version       | `cc.devices.record_version`. It grows with every change of one device row. Section 1.8.                                                                              |
| Telemetry version    | `cc.device_sync_state.telemetry_version`. It grows with every change of the telemetry failure of the customer. Section 1.8.                                          |
| Entry version        | The record version plus the telemetry version. It grows with every change of the device record that Redis carries. Section 5.11.                                     |
| Entity entry         | The Redis value of one device: its entry version and its record. Section 5.11.                                                                                       |
| Channel event        | An event that a publisher sends on a Redis channel. Section 3.1.                                                                                                     |
| Stream event         | An event that a browser stream sends to the browser. Section 3.1.                                                                                                    |
| Visibility predicate | The rule of section 2.1 that decides whether a caller sees a job.                                                                                                    |
| Failure requester    | The requester of the full sync that recorded a failure of the sync state. The predicate checks each retained failure against it. Section 1.3.                        |
| Owner gate           | The owner confirmation that the D1, D6, D7, D9, D12, and D13 changes need. Section "Owner decision gate".                                                            |
| Publication row      | A row of `cc.job_publications`. It holds one committed job change until Redis carries it. Section 3.6.                                                               |
| Refresh row          | A publication row of a refresh job. It carries no devices and has no publisher. Section 3.6.                                                                         |
| Publisher            | The code path that committed a publication row of a write job. The relay is not a publisher. Section 3.6.                                                            |
| Relay                | The job service timer that publishes progress-only rows, refresh rows, and the rows that their publisher left. Section 3.6.                                          |

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

## Revision 3 changes

The review of revision 2 (comment 108) raised F1 to F4 and N1. Revision 3 changes these sections:

| Finding    | Change                                                                                                                                   | Sections              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| F1         | A current-value stamp on each device survives overlay deletion. An older current observation never sets the field or creates an overlay. | 1.8, 5.4, 5.8         |
| F2         | Every Redis writer stores versioned entity entries through one compare-and-set script. An older snapshot never replaces a newer entry.   | 1.8, 5.11, P3         |
| F3         | A publication row commits with each job change. The job service relays every row that its publisher left.                                | 1.4, 3.2, 3.4, 3.6    |
| F4         | The job detail carries Latest activity for frame `104:209`, derived from durable rows.                                                   | 2.2, 2.5, F4, 10.2    |
| N1         | The hang-then-refusal test waits on the fault list. The quota report never shows a hung call.                                            | 8.1, 8.3              |
| Note 23:39 | References to the workflow record and the mockup name origin/main `3eab39a`. Job visibility follows default 15 of the record.            | Conventions, 2.1, 3.3 |

An architect review pass then closed three more gaps. A refresh read that loses the row rule still orders the field (5.8, rule 4).
The entry version covers the telemetry failure (1.8, 5.11). The relay runs on its own timer (3.6).

## Revision 4 changes

The review of revision 3 (comment 114) raised F1, F2, N1, and N2. The eng-lead note of 2026-10-17 at 00:45 narrowed OQ9.

| Finding    | Change                                                                                                                                                                                                                                                   | Sections                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| F1         | Each browser stream maps channel events to stream events through a `forward` function, which replaces the allowlist of revision 2. Devices stream events carry no job ID and no job record. The `job-finished` failure follows the visibility predicate. | 2.1, 2.2, 3.1, 3.3, B4  |
| F2         | The reader compares each entity entry with the current entry version in Postgres. Only an entry at that version serves its record.                                                                                                                       | 3.5, 3.6, 5.8, 5.11, P3 |
| F2, TTL    | The proof of section 5.11 uses no TTL. A TTL bounds memory only.                                                                                                                                                                                         | 5.11                    |
| N1         | B5 depends on B3. P1 proves the flows against a stub endpoint. P2 runs the flow against the real worker.                                                                                                                                                 | 8.3, 9                  |
| N2         | A successful `seen` request marks the activity reader dirty. The activity summary names its next window expiry, and the reader rereads at that time.                                                                                                     | 2.5, 3.4, F5            |
| Note 00:45 | Latest activity follows frames `228:4524` and `231:4707`. OQ9 keeps only the sentence for a failure other than a permission failure.                                                                                                                     | 2.5, F4, 10.2           |

The F2 change removes three parts of revision 3: the compare-and-set script, the empty entries, and the entry writes of the write path and the relay.
Correctness no longer depends on any of them. Writers delete the key of a removed device again, as entity cache decision D9 requires (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:95`).
The removal also restores entity cache decision D1: the API never writes the entity cache (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:37`).
Revision 3 broke that rule, because its relay stored entries from the API process.
A self-review also changed the card order. A change to an existing strict contract now lands in the card that changes its producer.
B6 now depends on B2 (section 9).
An independent review pass then gated the failure fields of the full-sync state (sections 2.1 and 3.1). It also added P1 and P2 dependencies (section 9).
The stream mapping changes the browser event shapes of entity cache decisions D7 and D12 (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:82`, `docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:112-113`).
The version check also replaces TTL as the staleness rule of decision D9.
These three changes wait for the owner gate. Reviewer approval does not authorize them. The section "Owner decision gate" below states the gate.

## Revision 5 changes

The review of revision 4 (comment 119) raised finding F1. This document calls it Rev-4 F1. The eng-lead report of 2026-10-17 at 01:49 named three changed owner decisions.
The reviewer recorded the gate in comment 118. The main chat accepted the gate and asked this revision to mark the gated cards.

| Finding          | Change                                                                                                                                                                          | Sections                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Rev-4 F1         | Each retained failure of the sync state keeps its failure requester. The predicate checks each failure against its own failure requester, not the newest Refresh all.           | 1.3, 2.1                     |
| Rev-4 F1, routes | `GET /api/devices/sync`, `POST /api/devices/sync`, and the Devices stream return the projection for their caller. Battery `unavailable` stays for every `devices:read` holder.  | 2.1, 3.1, 8.3                |
| Gate             | The owner gate names the D7, D9, and D12 changes, the cards that build them, and the release rule.                                                                              | Owner decision gate, 9, 10.2 |
| Gate, B2         | Migration 018 of card P3 adds the entry versions. The Devices stream reads the requester of a finished refresh job from Postgres. B2 therefore builds no D7, D9, or D12 change. | 1.1, 1.8, 2.2, 3.1, 5.11, 9  |
| Gate, B1         | Card B4 adds `deviceStreamEventSchema`. Card P3 adds `entityEntrySchema`. B1 therefore builds no gated change.                                                                  | 2.2, 8.3, 9                  |
| OQ10             | This revision found five more record lines and one workflow line that the design extends. The main chat decides whether the owner gate covers them.                             | Owner decision gate, 10.2    |

## Revision 6 changes

The review of revision 5 (comment 123) raised finding F1 and notes N1 and N2. This document calls them Rev-5 F1, Rev-5 N1, and Rev-5 N2.
The main chat ruled on OQ10 on 2026-10-17 at 03:10. Section 10.2 records the ruling.

| Finding              | Change                                                                                                                                                      | Sections                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Rev-5 F1             | Refresh batches keep their direct `entity-batch` publication. Refresh rows carry no devices and have no publisher. The relay publishes their `job-changed`. | Terms, 1.3, 3.2, 3.6, 9, 10.1                         |
| Rev-5 F1, tests      | Card P2 adds a guard: a successful refresh still invalidates its updated and removed rows. Card B5 tests the relay of refresh rows.                         | 8.3                                                   |
| Rev-5 N1             | F5 depends on F4, which brings F3. F5 tests both navigation actions.                                                                                        | 8.3, 9                                                |
| Rev-5 N2             | The Q1 telemetry fault records `permission-denied`. Cards B2 and B4 keep the `quota` case.                                                                  | 8.3, 9                                                |
| OQ10, gate           | The owner gate adds D1, D6, and D13. Cards P1, B4, and B5 carry their marks.                                                                                | Owner decision gate, 9, 10.1, 10.2                    |
| OQ10, D3             | A change to a 016 object edits 016. 017 holds only new objects and one dependency-forced foreign key. P3 adds no file.                                      | 1.1, 1.3, 1.5, 1.7, 1.8, 2.1, 5.8, 5.11, 8.3, 9, 10.1 |
| OQ10, D10 and banner | Both stay outside the gate. The release PR updates their records.                                                                                           | Owner decision gate, 10.2                             |
| Citation             | Main moves line 155 of the device browsing record to line 157.                                                                                              | Conventions                                           |

Refresh functions keep their result shapes (section 3.2). Their callers therefore hold no publication element. Refresh rows therefore need the relay.
Revision 6 supersedes the migration placement of revisions 4 and 5. Their change tables above stay as history.

## Owner decision gate

The entity cache decision record is owner-confirmed (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:3`). This design changes seven of its decisions. Six need this gate.
The eng-lead report of 01:49 named D7, D9, and D12. The OQ10 ruling of 03:10 added D1, D6, and D13 (section 10.2).
The release PR is the PR of this design. The main chat opens it after approval and makes every record edit below in it.

| Decision | Record                                                                                                                                                                                                                                        | Change in this design                                                                                                                                                                                                                                                                                                                                                                                             | Built by |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| D1       | The application Redis user gains `mget`, `llen`, `lrange`, `rpush`, `subscribe`, and `unsubscribe`, owner-approved on 2026-10-07. District-operated Redis grants the same (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:38`). | The application user also gains `+publish` and `+incr` for the job service and the relay (section 3.2). District-operated Redis then grants them too.                                                                                                                                                                                                                                                             | P1       |
| D6       | The worker publishes to `cc:entity-events:{customer}`. Each API instance holds one subscriber client and fans out to open SSE responses (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:76`).                                   | The API subscriber also listens on the job channel and feeds the Jobs stream (sections 3.1 and 3.3). The relay in the API publishes `job-changed` and `entity-batch` from publication rows (section 3.6).                                                                                                                                                                                                         | B4, B5   |
| D7       | `entity-batch` carries `{jobId, entityType, batch, batchCount, deviceIds}` (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:82`).                                                                                                | The Devices stream event drops `jobId`, `batch`, and `batchCount`. The channel event keeps them (section 3.1).                                                                                                                                                                                                                                                                                                    | B4       |
| D9       | The worker stores the full row projection with a TTL. "Redis TTL is the Redis staleness tool." (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:93-94`)                                                                          | Each entry holds an entry version and the record. A reader serves an entry only at the current entry version in Postgres. The TTL bounds memory only (section 5.11). The entity row of D1 changes with it (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:34`). `by-ids` of D7 reads Postgres for every ID, not only for misses (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:84`). | P3       |
| D12      | The stream carries `entity-batch`, `full-sync`, and `job-finished`. As built, `job-finished` nests the job as `{ job }` (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:112-113`).                                              | `job-finished` becomes `{ type, failure }` without the job record. `entity-batch` drops the job fields of D7. `full-sync` keeps its shape. Its failure fields follow the caller (sections 2.1 and 3.1).                                                                                                                                                                                                           | B4       |
| D13      | The worker ACL user covers `cc:entity:*`, `cc:query-gen:*`, `cc:entity-inflight:*`, and "the publish channel". "The API stays out of the job path." (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:122-123`)                   | The worker user also publishes on `cc:job-events:*` (section 3.2). The job service in the API admits, starts, and recovers write jobs (sections 5.3 and 6.5). Its relay publishes job events (section 3.6).                                                                                                                                                                                                       | P1, B5   |

- Reviewer approval confirms this document. It does not authorize these six decision changes.
- The main chat asks the owner together with OQ9 (section 10.2). The owner confirms before the release PR merges. The owner confirmed all six changes and answered OQ9 on 2026-10-17.
- Cards P1, B4, B5, and P3 build the changes. None of them dispatches before the owner confirms its changes. Their dependent cards wait through their dependencies (section 9).
- After the owner confirms, the main chat updates the decision record in the release PR. This card changes only this design file.
- If the owner rejects a change, that change needs a new design revision. The main chat decides whether its card dispatches without that change or waits for the revision.
  Card B4 keeps the `full-sync` projection in every case, because that projection changes no decision of this gate.
- The failure projection of section 2.1 applies default 15 of the owner-confirmed workflow record. `GET` and `POST /api/devices/sync` keep their shape.
  The `full-sync` event keeps its D12 shape `{ sync }` under the same projection. Card B4 builds the stream part, because B4 changes the same stream code.
  Until B4 merges, the Devices stream forwards `full-sync` as today (`api/src/app/devices/devices.controller.ts:167-206`).

The OQ10 ruling keeps three more extensions outside the gate:

- D3 (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:50`): "Full sync and get-by-IDs sync use one upsert. Migration 016 is rewritten, not patched." Sections 1.1 and 5.8 follow both rules.
  Rule 4 of section 5.8 adds the observation kind to the one upsert. Card B2 builds that.
  A refresh read newer than the current-value stamp then sets `annotated_location`, also when the row rule rejects the row.
- D10 (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:99`): a completed full sync increments the query generation. Entity syncs use the TTL only.
  Write settlements also increment it (section 5.8). Cards P2 and B5 build that. The release PR updates that record line.
- The device browsing workflow (`docs/workflows/device-browsing.md:155`) says that the stale text "names the stale count and the last failure".
  For a principal without `jobs:read`, section 2.1 omits each failure whose failure requester is another principal. Default 15 of the workflow record requires that.
  The single administrator sees no change. Cards B2 and B4 build the omission. The release PR adds one sentence to the device browsing record.

## Design sources for the screens

| Screen                                  | Source                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Bulk Actions and the selection footer   | Figma `94:3`, `213:4199`, `216:4309`                                                               |
| Expired selection                       | Figma `105:189`                                                                                    |
| Draft page "Update N devices"           | Figma `94:75`                                                                                      |
| Preview "Review N device updates"       | Figma `97:21`, expired preview `104:434`                                                           |
| Confirmation "Confirm N device updates" | Figma `97:57`                                                                                      |
| Receipt page "Update job created"       | Figma `104:74`                                                                                     |
| Jobs page                               | Figma `106:109`, states `231:5009`, `234:4950`, `234:5142`, `234:5325`, `234:5510`                 |
| Job detail                              | Figma `104:209`, `231:4707`, `228:4524`                                                            |
| Jobs activity area                      | Approved mockup (D6), `main@3eab39a:docs/ui/designs/2026-10-16-jobs-activity-area.html` and `.png` |

PR #36 added the activity-area files to origin/main. The workflow record lists these frames and the mockup (`main@3eab39a:docs/workflows/update-device-annotated-location.md:160-179`).
The record omits the expired-selection state `105:189` and the expired-preview state `104:434`. The eng-lead frame list of the brief names both.
Its completion items are the demonstration of card Q1 (`main@3eab39a:docs/workflows/update-device-annotated-location.md:194-205`).

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

Migration placement follows entity cache decision D3: "Migration 016 is rewritten, not patched." (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:50`).
The OQ10 ruling of 2026-10-17 at 03:10 applies it as two rules (section 10.2):

- A change to a table or function that 016 defines edits `deployment/postgres/migrations/016-device-inventory.sql` itself.
- A new migration file holds only new objects. Owner direction also forbids incremental upgrades (`AGENTS.md:28`).

Card B2 edits 016 for the job model:

- `cc.device_sync_state` gains the two failure requesters and their check constraints (section 1.3). `cc.devices` gains the current-value stamp (section 1.8).
- B2 changes `cc.read_device_sync`, `cc.request_device_sync`, `cc.abandon_device_sync`, `cc.finish_device_sync`, `cc.stage_devices`, and `cc.upsert_devices`.
- B2 also changes `cc.upsert_device_batteries`, `cc.soft_delete_devices`, `cc.create_entity_sync_job`, `cc.abandon_entity_sync_job`, and `cc.finish_entity_sync_batch`.
- B2 deletes `cc.purge_entity_sync_jobs`. `cc.purge_jobs` of 017 replaces it (section 1.5).
- B2 changes the 016 grant block for the changed signature and the deleted function (section 1.7).

Card B2 adds `017-jobs.sql`. It holds the new tables, sequences, and functions of sections 1 to 6, and the three actions of section 2.1.

A changed 016 function names 017 objects, for example `cc.jobs` and `cc.record_job_change`. All eleven changed functions are PL/pgSQL today.
For example, `cc.upsert_devices` declares `LANGUAGE plpgsql` (`deployment/postgres/migrations/016-device-inventory.sql:217-218`).
PL/pgSQL resolves the names of a statement when that statement first runs, not at `CREATE FUNCTION`.
The PostgreSQL manual states that only trivial syntax errors surface before execution (https://www.postgresql.org/docs/18/plpgsql-implementation.html, "Plan Caching").
The runner qualifies PostgreSQL 18.6 (`deployment/postgres/index.mjs:80`).
The runner applies each file in list order, each in its own transaction (`deployment/postgres/index.mjs:146-172`). Readiness requires every file (`deployment/postgres/index.mjs:284-291`).
No call of a changed 016 function therefore precedes 017. Each such function names 017 objects only inside its statements.
Its signature, its result type, and its declarations name no 017 type, because Postgres resolves those at `CREATE FUNCTION`.

The dependency-forced split: the foreign key from `cc.entity_sync_jobs.job_id` to `cc.jobs(job_id)` (section 1.3).
Postgres needs the referenced table when it creates the constraint. `cc.jobs` is a new object of 017. 017 therefore adds the constraint with `ALTER TABLE`.
No other statement of 017 alters, replaces, or drops a 016 object.

Card P3 edits 016 for the D9 change of the owner gate. It adds the version columns and their triggers (section 1.8).
It also changes `cc.read_device_records` and `cc.page_device_records` (section 5.11).
Each trigger function maintains one column of a 016 table. A later file that adds such a trigger patches that table. Each trigger therefore stays in 016 with its column.
P3 adds no migration file. The D9 work stays separable, because P3 is its own card and branch.

Editing 016 changes its checksum. The runner then rejects a database that applied an earlier 016 (`deployment/postgres/index.mjs:151-156`).
Developers recreate their databases. Rollback: revert the commit and recreate the database. No down migration exists, by owner direction (`AGENTS.md:27-29`).

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
| `revision`                                               | `bigint` not null default 1. `cc.record_job_change` increments it with every change that a reader can see, in the same transaction. Section 3.6.                                                                                                                                |
| `changed_at`                                             | `timestamptz` not null default `clock_timestamp()`. `cc.record_job_change` sets it with `revision`. Latest activity shows it (section 2.5).                                                                                                                                     |
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
- 017 adds a foreign key from `cc.entity_sync_jobs.job_id` to `cc.jobs(job_id) ON DELETE CASCADE`. Section 1.1 states why 017 holds it.
- `cc.finish_entity_sync_batch` (`deployment/postgres/migrations/016-device-inventory.sql:419-437`) recomputes the header counters from the batch records.
  A redispatched batch replaces its record (`deployment/postgres/migrations/016-device-inventory.sql:429`), so the counters never count a batch twice.
  `succeeded` counts the devices of completed batches. `failed` counts the devices of failed batches. Batch `i` holds `min(batch_size, n - i*batch_size)` devices.
- At the last batch: no failure gives `completed`. A failure with at least one completed batch gives `completed-with-errors`. A failure with no completed batch gives `failed`.
- `cc.abandon_entity_sync_job` (`deployment/postgres/migrations/016-device-inventory.sql:384-398`) sets the header to `failed` with `orchestration-unavailable`.

Full sync (Refresh all):

- `cc.request_device_sync` (`deployment/postgres/migrations/016-device-inventory.sql:130-157`) inserts a header with `scope_kind='all-devices'`, status `running`, and `target_count` null. It uses the header `job_id` as `sync_id`.
- When the request replaces an expired sync (`deployment/postgres/migrations/016-device-inventory.sql:146-151`), it closes the header of that sync as `failed` with `interrupted`.
- `cc.stage_devices` (`deployment/postgres/migrations/016-device-inventory.sql:304-310`) upserts one `cc.job_targets` row per staged device with the listed OrgUnit path and the staging time.
  It sets `succeeded` to the number of distinct staged devices and records the progress through `cc.record_job_change` (section 3.6).
- `cc.finish_device_sync` (`deployment/postgres/migrations/016-device-inventory.sql:321-347`) sets `target_count` to the number of job targets and `target_org_unit_paths` to their distinct paths.
  No failure gives `completed`. A failure gives `failed` with that code.
  A telemetry failure keeps its current record (`deployment/postgres/migrations/016-device-inventory.sql:337`) and leaves the job status unchanged.
- `cc.abandon_device_sync` (`deployment/postgres/migrations/016-device-inventory.sql:159-171`) sets the header to `failed` with `orchestration-unavailable`.
- An empty inventory finishes with `target_count` 0, `target_org_unit_paths` `{}`, and status `completed`.
- An inventory above 100,000 devices finishes normally. The 100,000 cap applies only to `devices` scopes.
- The requester stays on the header after `sync_actor` clears (`deployment/postgres/migrations/016-device-inventory.sql:342`).

Failure requesters of the sync state:

- The state keeps a failure across later syncs. A new request leaves `telemetry_failure` unchanged, and `failure` too unless it replaces an expired sync (`deployment/postgres/migrations/016-device-inventory.sql:149-154`).
  A failed finish changes only `failure` (`deployment/postgres/migrations/016-device-inventory.sql:339-341`). The newest Refresh all therefore does not always own a retained failure.
- B2 adds `failure_requested_by` and `telemetry_failure_requested_by` to `cc.device_sync_state` in 016 (`deployment/postgres/migrations/016-device-inventory.sql:6-26`).
  Both are `uuid` columns that reference `cc.application_principals(id)`, like `sync_actor` (`deployment/postgres/migrations/016-device-inventory.sql:19`).
- Each column holds the failure requester of its failure: the `sync_actor` of the sync that recorded the failure. A check constraint keeps each failure and its failure requester both null or both set.
- `cc.request_device_sync` records `interrupted` for the expired sync that it replaces (`deployment/postgres/migrations/016-device-inventory.sql:150`). It sets `failure_requested_by` to the `sync_actor` of that sync.
- `cc.abandon_device_sync` and a failed `cc.finish_device_sync` set `failure_requested_by` to the `sync_actor` of their sync (`deployment/postgres/migrations/016-device-inventory.sql:166`, `deployment/postgres/migrations/016-device-inventory.sql:340`).
- A successful `cc.finish_device_sync` clears `failure` and `failure_requested_by` (`deployment/postgres/migrations/016-device-inventory.sql:335-338`).
  It sets `telemetry_failure_requested_by` to its `sync_actor` when it records a telemetry failure. Otherwise it clears both telemetry columns.
- Each function takes `sync_actor` from the row before the update that clears it (`deployment/postgres/migrations/016-device-inventory.sql:166-167`, `deployment/postgres/migrations/016-device-inventory.sql:342-343`).
  No other function changes a failure of the sync state.
- A failure requester survives the 7-day purge of its job header (section 1.5). The predicate of section 2.1 therefore still applies to an old retained failure.
- A changed failure requester changes no device record. The telemetry version of section 1.8 follows `telemetry_failure` only.

Progress: an ID-list refresh reports `total` as `target_count`. A running full sync reports `total` null and `pending` null. Its `succeeded` counts the devices observed so far.
Refresh jobs carry no confirmer. They read Google and change nothing in Google.
Every header change above records itself through `cc.record_job_change` in its transaction (section 3.6).
These refresh rows carry no devices. No refresh caller publishes them. The relay publishes their `job-changed` (sections 3.2 and 3.6).

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

An index on `(job_id, status, updated_at DESC, operation_number)` serves the Latest activity samples (section 2.5).

`cc.device_write_overlays`, primary key `(customer_id, device_id, field)`. Columns: `value`, `observed_at`, `source` (`write-response`, `read-back`, `refresh-read`), `job_id`, `operation_number`, and `expires_at`. Section 5.8 defines its rules.

`cc.job_targets`, primary key `(job_id, device_id)`. `job_id` references `cc.jobs(job_id) ON DELETE CASCADE`. Columns: `org_unit_path` and `observed_at`.
It records the OrgUnit path of each refresh target (D5). Write jobs record the path on their operations.

`cc.job_activity_seen`: `principal_id` primary key and `seen_at`. The activity attention dot clears per person (OQ5 ruling).

`cc.job_publications`, one row per committed job change that Redis does not carry yet. Section 3.6 defines its use.

| Column                               | Rule                                                                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publication_id`                     | `bigint` identity primary key.                                                                                                                                                                                          |
| `customer_id`, `job_id`              | The customer and the job. `job_id` references `cc.jobs(job_id) ON DELETE CASCADE`.                                                                                                                                      |
| `revision`                           | The job revision that the change committed.                                                                                                                                                                             |
| `status_changed`                     | True when the change set a new job status.                                                                                                                                                                              |
| `device_ids`, `removed_ids`, `batch` | The devices whose rows the change published, split into present and soft-deleted devices, at most 1,000 together. `batch` is the lowest write batch of their operations. Empty and null when the change published none. |
| `created_at`                         | `timestamptz` default `clock_timestamp()`.                                                                                                                                                                              |

### 1.5 Retention

`cc.purge_jobs(p_customer, p_limit)` of 017 replaces `cc.purge_entity_sync_jobs` (`deployment/postgres/migrations/016-device-inventory.sql:439-456`).
Card B2 deletes the old function from 016. It moves its API caller to `cc.purge_jobs` and removes its grant (`deployment/postgres/index.mjs:270`).
`DeviceRefresh.dispatch` calls it where it calls the old purge (`api/src/app/devices/device-refresh.ts:39-43`). The job service also calls it on its tick.

- It keeps the interruption rule. An ID-list refresh unfinished after 2 hours ends with `interrupted` (`deployment/postgres/migrations/016-device-inventory.sql:447-448`).
- It closes a running full-sync header without a live sync lease (`deployment/postgres/migrations/016-device-inventory.sql:113`) as `failed` with `interrupted`.
- It deletes `inventory-refresh` headers finished more than 7 days ago. The cascade removes their detail, batch, and target rows.
- It deletes unconfirmed previews 24 hours after `expires_at`, with their targets.
- It deletes expired overlays.
- It never deletes `device-update` jobs, their operations and batches, or confirmed previews.
- Publication rows leave when the publisher or the relay completes them (section 3.6). A purged refresh job removes its rows by cascade.

### 1.6 Job ID allocation

- Sequences `cc.job_number_upd`, `cc.job_number_ref`, and `cc.preview_number_pv` allocate numbers.
  One installation serves one customer (`deployment/postgres/migrations/016-device-inventory.sql:90`, `WHERE singleton`), so one sequence per prefix suffices.
- The display format is the prefix, a hyphen, and the number with at least three digits. Use `CASE WHEN n < 1000 THEN lpad(n::text, 3, '0') ELSE n::text END`.
  Plain `lpad(n::text, 3, '0')` truncates `1000` to `100`.
- Sequence gaps after a rolled-back transaction are acceptable. Display IDs stay unique. They do not count jobs.
- The API resolves `display_id` to `job_id` for every job route.

### 1.7 Grants

- A new 017 block grants `SELECT` on the new tables and `EXECUTE` on the new functions to the runtime role. The 016 block shows the pattern (`deployment/postgres/index.mjs:249-271`).
- B2 changes the 016 block for the new signature of `cc.upsert_devices` and the deleted purge (`deployment/postgres/index.mjs:257`, `deployment/postgres/index.mjs:270`).
  B2 changes the `REVOKE` list of 016 the same way (`deployment/postgres/migrations/016-device-inventory.sql:458-470`).
- Every function is `SECURITY DEFINER` with `search_path=pg_catalog,cc`, as `cc.device_reader` is (`deployment/postgres/migrations/016-device-inventory.sql:86-87`).
  Every function is revoked from `PUBLIC`, as `deployment/postgres/migrations/016-device-inventory.sql:458-470` does.
- Functions that the API calls for a person take `(p_actor, p_version)` and check grants, as `cc.device_reader` does (`deployment/postgres/migrations/016-device-inventory.sql:86-100`).

### 1.8 Device row additions

B2 adds `annotated_location_observed_at timestamptz NULL` to `cc.devices` in 016 (`deployment/postgres/migrations/016-device-inventory.sql:28-49`). It is the current-value stamp of section 5.8.

Card P3 adds the two versions of section 5.11 to 016. They build the D9 change of the owner gate (section 1.1):

- `cc.devices` gains `record_version bigint NOT NULL DEFAULT 1`. A `BEFORE UPDATE` row trigger sets it to the old value plus 1 when any other column changes.
  The trigger covers every writer: refresh upserts, list upserts, battery updates, soft deletes, full-sync removals, and settlements.
  The current writers are `deployment/postgres/migrations/016-device-inventory.sql:217-239`, `deployment/postgres/migrations/016-device-inventory.sql:241-258`, `deployment/postgres/migrations/016-device-inventory.sql:261-274`, and `deployment/postgres/migrations/016-device-inventory.sql:333-334`.
  The writers of 017 and every later writer bump the version without a code change.
- `cc.device_sync_state` (`deployment/postgres/migrations/016-device-inventory.sql:6-26`) gains `telemetry_version bigint NOT NULL DEFAULT 1`.
  A `BEFORE UPDATE` row trigger raises it by 1 when `telemetry_failure` changes.
  `cc.device_record` reads that failure (`deployment/postgres/migrations/016-device-inventory.sql:205-213`, `deployment/postgres/migrations/016-device-inventory.sql:278`).
  `cc.finish_device_sync` changes it without a device row change (`deployment/postgres/migrations/016-device-inventory.sql:335-338`). Section 5.11 adds the two versions.
- Concurrent updates of one row wait on its row lock. The trigger then reads the committed version. Versions of one device therefore grow in commit order.
  The telemetry version of one customer grows the same way.

Every multi-row device writer that B2 writes or changes first locks its rows in `device_id` order. A function that also locks a job row locks it before the device rows.
B2 therefore changes `cc.upsert_device_batteries` and `cc.soft_delete_devices` in 016 to lock in that order (`deployment/postgres/migrations/016-device-inventory.sql:241-274`).
The device record schema stays unchanged (`libs/application-contracts/src/lib/devices.ts:60-75`). No new column reaches the browser.

## 2. API contracts

### 2.1 Actions

- Add `devices:write`, `devices:bulk-actions`, and `jobs:read` to `actionSchema` (`libs/application-contracts/src/lib/authorization.ts:3-16`).
  Give each the scope kinds `platform` and `district` in `actionScopeKinds` (`libs/application-contracts/src/lib/authorization.ts:28-43`).
- 017 inserts the three actions into `cc.application_actions`, as `deployment/postgres/migrations/016-device-inventory.sql:4` does for `devices:read`.
- The bootstrap grants every action to the first administrator (`deployment/bootstrap/application-access.mjs:86-91`).
  The `platform-administrator` preset takes every action (`libs/application-contracts/src/lib/authorization.ts:98`). No bootstrap change is needed.
- Preview and confirmation require `devices:read`, `devices:write`, and `devices:bulk-actions` (eng-lead ruling 9). The write-access routes require `devices:write`.
- Jobs routes and the Jobs stream require `jobs:read` or `devices:read`. Every requester holds `devices:read`, because refresh and preview require it.
- Reconcile requires `jobs:read` and `devices:write` (OQ6 ruling).
- Interim visibility follows D5 and default 15 of the workflow record (`main@3eab39a:docs/workflows/update-device-annotated-location.md:68-69`, `main@3eab39a:docs/workflows/update-device-annotated-location.md:120`).
  A holder of `jobs:read` at platform or district scope sees every job of the customer. Any other caller sees only the jobs that the caller requested.
  Default 15 calls the action `jobs-read`. This design spells it `jobs:read`, as `actionSchema` spells `devices:read` (`libs/application-contracts/src/lib/authorization.ts:15`).
- One visibility predicate serves every job read. 017 defines it once as `cc.job_visible(p_actor, p_version, p_customer, p_requested_by)`.
  It passes for a holder of `jobs:read` at platform scope or at district scope of the customer. It also passes for the requester.
  It fails for a disabled principal or another permission version. Its grant test follows `cc.device_reader` (`deployment/postgres/migrations/016-device-inventory.sql:91-95`).
  It takes the runtime grant of section 1.7. The job reads of card B4 and the Devices stream call it.
- Its users are the jobs list, the detail, the operations, the activity summary, and the requesters.
  It also serves the Jobs stream (section 3.3) and every job failure on Devices routes (section 3.1). No other scoping exists in this slice.
- A job failure is job data. On Devices routes it reaches only a caller for whom the predicate passes for its failure requester (section 1.3).
  Two places carry one: the `job-finished` failure of the Devices stream, and `failure` and `telemetryFailure` of the full-sync state (`libs/application-contracts/src/lib/devices.ts:313-324`).
- The sync state keeps a failure across later syncs (section 1.3). The newest Refresh all therefore does not always own a failure of the state.
  The predicate checks each failure against its own failure requester.

The failure projection of the sync state:

- 017 adds `cc.visible_device_sync(p_actor, p_version, p_customer)`. It returns the projection of `cc.device_sync_projection` (`deployment/postgres/migrations/016-device-inventory.sql:102-118`) for one caller.
- `failure` reads null unless the predicate passes for `failure_requested_by`.
  An expired sync reports `interrupted` (`deployment/postgres/migrations/016-device-inventory.sql:106`). The failure requester of that value is the `sync_actor` of the expired sync.
- `telemetryFailure` reads null unless the predicate passes for `telemetry_failure_requested_by`.
- Every other field of the projection stays unchanged. The shape stays `deviceSyncStateSchema` (`libs/application-contracts/src/lib/devices.ts:313-324`).
- B2 changes, in 016, each function that returns the state to the API. Each returns `cc.visible_device_sync` for its own caller:
  - `cc.read_device_sync` (`deployment/postgres/migrations/016-device-inventory.sql:120-128`) serves `GET /api/devices/sync` (`api/src/app/devices/devices.controller.ts:54-57`, `api/src/app/devices/devices.service.ts:119-128`).
  - `cc.request_device_sync` (`deployment/postgres/migrations/016-device-inventory.sql:155`) serves `POST /api/devices/sync` (`api/src/app/devices/devices.service.ts:136-147`, `api/src/app/devices/devices.service.ts:168`).
  - `cc.abandon_device_sync` (`deployment/postgres/migrations/016-device-inventory.sql:169`). The API discards its result today (`api/src/app/devices/devices.service.ts:155-166`).
- `cc.finish_device_sync` keeps the full projection (`deployment/postgres/migrations/016-device-inventory.sql:345`). The worker is its only caller (`worker/src/device-sync.ts:160-165`).
  The worker publishes that projection only on the entity channel. The Devices stream projects it for each caller (section 3.1).
- `cc.visible_device_sync` and `cc.device_sync_projection` stay internal. Neither receives a grant. `deployment/postgres/index.mjs:250-270` grants no sync state projection today.
- The battery state keeps the stored `telemetry_failure`. `cc.device_record` still reports battery `unavailable` after a telemetry failure (`deployment/postgres/migrations/016-device-inventory.sql:204-213`).
  The battery status, order, group, filter, and detail SQL still read the column (`api/src/app/devices/device-query.ts:22-26`, `api/src/app/devices/device-query.ts:33`, `api/src/app/devices/device-query.ts:83`, `api/src/app/devices/device-query.ts:257`).
  Every `devices:read` holder therefore keeps the battery state. That state describes the devices. Only the failure code is job data.

The retained-failure sequence of review comment 119, with three principals. A and B hold `devices:read` without `jobs:read`. C also holds `jobs:read` at district scope:

| Step                                                                                       | Stored state                                                                            | A                                                    | B                                          | C                          |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ | -------------------------- |
| 1. B runs Refresh all. The Directory read succeeds. The telemetry read fails with `quota`. | `telemetry_failure` `quota` with failure requester B                                    | `telemetryFailure` null                              | `telemetryFailure` `quota`                 | `telemetryFailure` `quota` |
| 2. A starts Refresh all. `POST /api/devices/sync` answers A.                               | Running. `telemetry_failure` stays with failure requester B.                            | `telemetryFailure` null                              | `telemetryFailure` `quota`                 | `telemetryFailure` `quota` |
| 3. The Directory read of A fails with `network-failure`.                                   | `failure` `network-failure` with failure requester A. `telemetry_failure` stays with B. | `failure` `network-failure`, `telemetryFailure` null | `failure` null, `telemetryFailure` `quota` | Both failures              |

- `GET /api/devices/sync`, the answer of `POST /api/devices/sync`, and the `full-sync` stream event give each principal the column of that principal.
- Battery reads `unavailable` for A, B, and C after step 1. The status `failed` after step 3 reaches all three, as inventory state.
- Devices routes keep the rest of the inventory state under `devices:read`: the sync status, the stale count, and whether a refresh runs (`libs/application-contracts/src/lib/devices.ts:102-105`).
  None of that state names a job or a requester. A page read returns only the ID of the refresh job that the same read requested (`libs/application-contracts/src/lib/devices.ts:285`).
- The single administrator holds every action in this slice, so the requester clause adds no visible job. Cards B2 and B4 test the clause with principals without `jobs:read` (section 8.3).

### 2.2 Contract files

- Add `libs/application-contracts/src/lib/device-updates.ts` and `libs/application-contracts/src/lib/jobs.ts`. Export both from `libs/application-contracts/src/index.ts`.
- Use `zod` strict objects, as `libs/application-contracts/src/lib/entity-cache.ts:62-98` does. Timestamps use `z.iso.datetime({ offset: true })` (`libs/application-contracts/src/lib/entity-cache.ts:5`).
- Change `deviceSelectionSpecSchema` (`libs/application-contracts/src/lib/devices.ts:246-259`) as section 2.8 states.
- Card B4 adds `deviceStreamEventSchema` (section 3.1), and card P3 adds `entityEntrySchema` (section 5.11), to `libs/application-contracts/src/lib/entity-cache.ts`.
  Each lands with the gated change that uses it (section "Owner decision gate").
- `entitySyncJobSchema` (`libs/application-contracts/src/lib/entity-cache.ts:62-72`) keeps its shape. The Devices stream reads the requester of a finished job from Postgres (section 3.1).

Shared schemas in `jobs.ts`:

| Schema                    | Shape                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobDisplayIdSchema`      | `^(UPD\|REF)-\d{3,}$`                                                                                                                                                                                                                    |
| `jobStatusSchema`         | The eight statuses of section 1.2.                                                                                                                                                                                                       |
| `jobActionSchema`         | `update-device-annotations` (label "Update device annotations") and `refresh-inventory` (label "Refresh inventory").                                                                                                                     |
| `jobProgressSchema`       | `total` (null for a running full sync), `succeeded`, `failed`, `unknown`, `skipped`, and `pending` (null when `total` is null).                                                                                                          |
| `jobSummarySchema`        | `jobId`, `displayId`, `revision`, `action`, `status`, `scope` (`kind`, and `deviceCount` or null), `requestedBy` (`id`, `displayName`), `createdAt`, `startedAt`, `finishedAt`, `progress`, `failure`.                                   |
| `jobDetailSchema`         | The summary plus `confirmedBy`, `previewDisplayId`, `field`, `mode`, `requestedValue`, `targetOrgUnitPaths`, `correlationId`, and `latestActivity`.                                                                                      |
| `jobLatestActivitySchema` | Section 2.5. `at`, plus `failed` and `unknown`, each with a `count` and at most 3 operation samples.                                                                                                                                     |
| `jobOperationSchema`      | `operationId`, `deviceId`, `serialNumber`, `orgUnitPath`, `operation` (`replace` or `clear`), `baselineValue`, `requestedValue`, `outcome`, `outcomeReason`, `googleStatus`, `googleReason`, `observedValue`, `verifiedBy`, `updatedAt`. |
| `jobActivitySchema`       | Section 2.5.                                                                                                                                                                                                                             |
| `jobEventSchema`          | A discriminated union with one member: `{ type: 'job-changed', jobId, displayId, revision, requestedBy }`. `requestedBy` is the requester's principal ID. Section 3.1.                                                                   |
| `jobEventsChannel`        | `cc:job-events:{customerId}`.                                                                                                                                                                                                            |

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
| `GET /api/jobs/:displayId`                                        | `jobDetailSchema`, with `latestActivity` (below). `404` for an unknown or purged job.                                                                                                                                                                                                                                                                                          |
| `GET /api/jobs/:displayId/operations?attention=&cursor=&limit=`   | Operations in operation-number order, at most 1,000 per page. `attention=true` returns only `failed` and `unknown` rows. Job counts stay unchanged (`docs/ui/jobs-grid.json:160-161`). Refresh jobs return `operations: []`.                                                                                                                                                   |
| `POST /api/jobs/:displayId/operations/:operationNumber/reconcile` | Section 2.6.                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/jobs/activity`                                          | `jobActivitySchema`, below.                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/jobs/activity/seen`                                    | Stores `clock_timestamp()` in `cc.job_activity_seen` for the caller and returns it as `seenAt`. Section 3.4 states the client step after it.                                                                                                                                                                                                                                   |
| `GET /api/jobs/requesters?query=&limit=`                          | The distinct requesters of visible jobs whose display name starts with `query`, at most 20, with `id` and `displayName`. The `requestedBy` filter autocomplete reads it (`docs/ui/jobs-grid.json:106-109`).                                                                                                                                                                    |
| `GET /api/jobs/events`                                            | Server-sent events. Section 3.3.                                                                                                                                                                                                                                                                                                                                               |

The Jobs controller declares the `GET` routes `activity`, `requesters`, and `events` before `:displayId`.
The Devices controller orders `events` before `:deviceId` the same way (`api/src/app/devices/devices.controller.ts:168`, `api/src/app/devices/devices.controller.ts:208`).

The filters are the seven filter fields of the Jobs grid (`docs/ui/jobs-grid.json:89-118`). The list exposes no other filter (`docs/ui/jobs-grid.json:119`).
`entityType` has one value, `device`, in this slice.

`jobActivitySchema` follows the OQ1 ruling and note 3 of the approved mockup (`main@3eab39a:docs/ui/designs/2026-10-16-jobs-activity-area.html:131`):

| Field                  | Content                                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running`              | `count` of every running job, and `jobs`: up to 50 running jobs, newest `createdAt` first, then `displayId` descending.                                                                                    |
| `waiting`              | `count` of every accepted, queued, and held job, and `jobs`: up to 50 of them in admission order (section 6.5).                                                                                            |
| `recent`               | `count` of every job finished in the last 24 hours, and `jobs`: the 10 most recently finished. `nextExpiryAt` is the `finished_at` of the oldest counted job plus 24 hours, or null without a counted job. |
| `attention`            | True when a job finished as `needs-review`, `completed-with-errors`, or `failed` after the caller's `seenAt`. A null `seenAt` counts every such job.                                                       |
| `seenAt`, `observedAt` | The caller's last `seen` time and the read time.                                                                                                                                                           |

Every summary carries `revision`. The panel offers "View all jobs" for rows beyond a section cap (card F5).
Note 2 of the approved mockup marks finished jobs that "need review or ended with errors" (`main@3eab39a:docs/ui/designs/2026-10-16-jobs-activity-area.html:130`). A failed job ended with errors, so the rule includes `failed`.

Latest activity of one job:

- Frame `104:209` places a Latest activity section below the operations grid and its footer.
  Its line reads "10:36 AM · Permission failure on C0A1-7F77. C0A1-7F84 requires reconciliation before any retry."
- The Jobs grid metadata lists the section as `recent-activity` (`docs/ui/jobs-grid.json:162-168`). JOB-04 requires recent activity on the detail page (`docs/ui/patterns.md:290`).
- The detail read derives `latestActivity` from durable rows. No activity table, event log, or inbox exists.

| Field                | Source                                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `at`                 | `cc.jobs.changed_at`, the time of the last change that a reader can see.                                                                                                                                               |
| `failed.count`       | The `failed` counter of the job (section 1.2).                                                                                                                                                                         |
| `failed.operations`  | At most 3 `failed` operations, newest `updated_at` first, then lowest operation number. Each sample holds `operationId`, `deviceId`, `serialNumber`, `outcomeReason`, `googleStatus`, `googleReason`, and `updatedAt`. |
| `unknown.count`      | The `unknown` counter of the job.                                                                                                                                                                                      |
| `unknown.operations` | At most 3 `unknown` operations in the same order. Each sample holds `operationId`, `deviceId`, `serialNumber`, and `updatedAt`.                                                                                        |

- The samples cover the whole job, not the visible operations page. The index of section 1.4 limits each sample read to 3 rows.
- Refresh jobs have no operations. Their samples are empty. Their counts come from the job counters.
- Latest activity rereads with the job detail (section 3.4). Each settlement and status change moves `changed_at` and `revision` in one transaction (section 3.6).
- The eng-lead captured frames `228:4524` and `231:4707` on 2026-10-17 at 00:40. This revision inspected both captures.
- A job with a failed or unknown operation shows the sample line of frames `104:209` and `231:4707`.
  It reads "10:36 AM · Permission failure on C0A1-7F77. C0A1-7F84 requires reconciliation before any retry."
  Card F4 renders it from the samples. The newest sample `updatedAt` gives its time.
- The sample line holds one failure sentence per failed sample and one reconciliation sentence per unknown sample. Each sentence names the serial number of its sample.
  The job counters above the grid show the totals.
- "Permission failure on C0A1-7F77." covers a failed sample with Google status 401 or 403 and an outcome reason other than `quota`.
  "C0A1-7F84 requires reconciliation before any retry." covers an unknown sample.
- A job without failed and unknown operations shows the counter line of frame `228:4524`. That frame shows UPD-014, Running, with 36 succeeded and 12 pending.
  It reads "10:42 AM · 36 updates confirmed. Twelve operations remain pending." Card F4 renders it from the `succeeded` and `pending` counters, with `at` as its time.
  The frame designs it for a running write job with pending operations. OQ9 also carries the line of a refresh job and of a job without pending operations.
- OQ9 (section 10.2) keeps one sentence only: the sentence for a failed sample whose reason is not a permission failure.
  Such reasons are `not-found`, `value-differs`, `quota`, and other Google rejections such as `invalid` (sections 5.5 and 7.1). Card F4 does not invent that sentence (`AGENTS.md:70`).

### 2.6 Reconcile one operation

- The route accepts only an operation with outcome `unknown`. Other outcomes return `409 operation-settled`.
- The API claims the read-back of that operation with a new attempt through `cc.claim_device_update_verification` (section 5.7).
  It then starts the Kestra flow `device_update_reconcile` with the job, the operation number, and the attempt. It returns `202` with the operation.
- An operation under a live read-back lease returns `202` and starts no second flow. A failed start leaves the claim to expire after 120 s. The person can then try again.
- The worker reads the device with GET. It never writes. Section 5.7 gives the settlement rule. Section 5.10 derives the job status again.
- The settlement records the change through `cc.record_job_change`. The worker or the relay publishes its row (section 3.6).
  An open job detail then rereads the job, its Latest activity, and its visible operations page (section 3.4).

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

### 3.1 Channels and stream events

- Keep the channel `cc:entity-events:{customerId}` (`libs/application-contracts/src/lib/entity-cache.ts:52-53`). `entityEventSchema` keeps its three members (`libs/application-contracts/src/lib/entity-cache.ts:86-98`).
  Write batches publish its existing `entity-batch` member.
- The job record of `job-finished` keeps its shape (`libs/application-contracts/src/lib/entity-cache.ts:62-72`, `deployment/postgres/migrations/016-device-inventory.sql:349-356`).
  The worker publishes that record today (`worker/src/entity-sync.ts:282-293`). The Devices stream reads the requester of the job from `cc.jobs` when it needs one.
- Add the channel `cc:job-events:{customerId}` with `jobEventSchema` (section 2.2). Job events never travel on the entity channel.
- `EventFanout` hardcodes the entity channel and schema (`api/src/app/devices/device-events.ts:49`, `api/src/app/devices/device-events.ts:91-101`).
  Card B4 lets each listener name its channel and its parser. One subscriber connection still serves every channel (`api/src/app/devices/device-events.service.ts:5-16`).
- `streamEvents` forwards every parsed channel event to the browser unchanged (`api/src/app/devices/device-events.ts:233-237`). Card B4 adds a required `forward` function.
  It maps each channel event to the stream event for the caller, or to none. A channel event without a stream event never reaches the sink.
- Backoff reports never use Redis pub/sub. Postgres stores them (section 6.3). No browser stream can carry them.

Card B4 changes the Devices stream (`api/src/app/devices/devices.controller.ts:167-206`) to send the stream events of `deviceStreamEventSchema`. This mapping builds the D7 and D12 changes of the owner gate:

| Channel event  | Devices stream event                                                                                                                                                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entity-batch` | `{ type, entityType, deviceIds, removedIds }`. `jobId`, `batch`, and `batchCount` stay on the server. Every `devices:read` holder receives it.                                                                                                                                                 |
| `job-finished` | `{ type, failure }`. A caller with `jobs:read` at platform or district scope receives the job failure. For any other caller, one statement reads the customer and requester of the job from `cc.jobs` and evaluates `cc.job_visible`. `failure` is null unless it passes.                      |
| `full-sync`    | `{ type, sync }`. A caller with `jobs:read` at platform or district scope receives `sync` unchanged, because the predicate passes for every failure requester. For any other caller, `forward` reads `sync` again through `cc.read_device_sync` with the identity of the caller (section 2.1). |
| `job-changed`  | None. It travels only on the job channel.                                                                                                                                                                                                                                                      |

- The Devices stream therefore never sends a job ID, a job record, or a requester. It sends no failure of a job that the caller cannot see.
  Every device-row invalidation still reaches every `devices:read` holder.
- The second read of `full-sync` checks each failure against its own failure requester. After step 3 of the sequence of section 2.1, A, B, and C each receive their own column.
  A retained telemetry failure of B therefore never reaches A, also when the Directory read of A fails.
- A failed read in `forward`, or a job without a header row, sends the event with null failure fields. The device-row invalidation and the recount still reach the browser.
  No unchecked failure reaches it. After a failed read, `forward` sends that event and then ends the stream.
  The store reopens the stream after a status read (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:115-116`). That read returns the failures that the predicate shows to that caller.
- `forward` handles the channel events of one stream one at a time, in arrival order. A pending read delays only the later events of that stream.
  Each `forward` read times out after 5 s and then counts as a failed read. One read therefore delays the later events by at most 5 s.
- The worker publishes one `full-sync` event per sync run (`worker/src/device-sync.ts:217-221`). The second read costs one Postgres statement per event and stream. A `job-finished` read costs one statement per refresh job and stream.
  Only callers without `jobs:read` at platform or district scope cause these reads.
- From `entity-batch` and `job-finished`, the Devices store reads only device IDs, removed IDs, and the failure today (`frontend/src/app/devices/devices.store.ts:597-602`).
  A `job-finished` event with a null failure still schedules the recount. The D11 banner therefore leaves its refreshing state when the job ends (`frontend/src/app/devices/device-freshness.ts:26-41`).
- A caller who cannot see the job receives no failure sentence for it (`frontend/src/app/devices/device-freshness.ts:36-40`).
  The single administrator holds every action in this slice (section 2.1). The banner therefore stays unchanged, as default 23 requires (`main@3eab39a:docs/workflows/update-device-annotated-location.md:128`).
- The Devices stream computes the visibility of the caller at open. Each ping rechecks it with the session and `devices:read` (`api/src/app/devices/devices.controller.ts:186-202`).
  A changed visibility closes the stream. The browser reopens it and reads state again (`frontend/src/app/devices/devices.store.ts:512-527`).
  A grant change therefore takes effect within one ping, 25 s (`libs/application-contracts/src/lib/entity-cache.ts:32`).
- The Jobs stream sends `job-changed` only when the visibility predicate passes for its `requestedBy` (section 3.3).
- Card B4 changes the Devices store parse (`frontend/src/app/devices/devices.store.ts:587-610`) together with the stream. The stream events change shape on both sides at once.

### 3.2 Publishers

| A write job is labeled, admitted, abandoned, or finalized by the reaper | The job service (API) | `job-changed` |
| A write job is accepted by confirmation (card B3) | None. The relay publishes the row after its grace (section 3.6). | `job-changed` |
| A write batch or a read-back settles, or a write job finishes | The worker, after its commit | `job-changed`, and `entity-batch` for published devices |
| A refresh job is created, progresses, finishes, or ends by the purge | None. The relay publishes the row (section 3.6). | `job-changed` |

- Every change commits one publication row in its own transaction (section 3.6). Every publisher publishes after the commit, with the committed `revision`.
- A publisher publishes a row with a status change or with published devices at once. It leaves a progress-only row to the relay.
- Confirmation commits its row and publishes nothing. Card B3 therefore needs no Redis publish right from card P1.
  The admission after the commit labels or admits the job. The job service publishes that row at once (section 6.5).
- Refresh rows have no publisher. The refresh functions keep their result shapes. No refresh caller therefore holds a publication element.
  The callers are the refresh dispatch (`api/src/app/devices/device-refresh.ts:55-68`), the full-sync request (`api/src/app/devices/devices.service.ts:136-147`), and the worker.
  The worker reads the batch finish and the full-sync finish (`worker/src/entity-sync.ts:282-287`, `worker/src/device-sync.ts:160-165`).
- The worker keeps the direct refresh events of today: `entity-batch` before the batch finish, `job-finished`, and `full-sync` (`worker/src/entity-sync.ts:272-293`, `worker/src/device-sync.ts:217-224`).
  Section 3.6 states why refresh rows carry no devices.
- The relay of section 3.6 publishes progress-only rows and refresh rows on its next run, once per job. It also publishes every row that its publisher left for 5 s.
- The API Redis rule allows neither `publish` nor `incr` (`deployment/redis/runtime.mjs:10-11`). Card P1 adds `+publish` and `+incr`.
- The worker rule allows `publish` only on `cc:entity-events:*` (`deployment/redis/runtime.mjs:12-14`). Card P1 adds `&cc:job-events:*`.
- Keys and channels stay under `cc:*` (`deployment/redis/README.md:20`).

### 3.3 `GET /api/jobs/events`

- A Jobs controller serves the stream with `streamEvents`. Its `forward` function maps every channel event other than `job-changed` to none.
- The stream requires `jobs:read` or `devices:read` at open. Each ping rechecks the session and those actions, as the Devices stream rechecks its access (`api/src/app/devices/devices.controller.ts:186-202`).
  A failed recheck closes the stream. A recheck that changes the visibility of section 2.1 also closes it. The browser then reopens it under the new grants.
- The stream sends a `job-changed` event only when the visibility predicate passes for its `requestedBy`.
- The edge proxies the stream with the event idle timeout. Today only `/api/devices/events` gets that timeout (`deployment/bootstrap/application-edge.mjs:196-197`). Card P1 adds the jobs path.
- The shell opens the jobs stream on every page, because the activity area lives in the shell. The Devices page keeps its own stream.

### 3.4 Client resynchronization

JOB-02 asks for row refresh on ordinary invalidations and resynchronization after a replay gap (`docs/ui/patterns.md:268-271`). The client applies these rules:

- A `job-changed` event is an invalidation. The client never merges event data into its state.
- Each resource reloads through one single-flight reader: the activity summary, the open Jobs page, and the open job detail.
  The job detail read includes Latest activity (section 2.5) and the visible operations page.
- Each reader keeps, for each job, the highest `revision` that its successful reads returned.
  An event at or below that revision leaves the reader clean. Relay duplicates therefore start no read (section 3.6).
- An event above that revision, or for a job that the reader does not hold, marks the reader dirty.
  A dirty reader starts one REST read after 250 ms. An event during a read marks the reader dirty again. The reader then reads once more.
- A failed read leaves the reader dirty and its revisions unchanged. The reader retries after 5 s. A stream open retries at once.
- Reads of one resource never overlap. Each read returns committed state at least as new as the previous read. A delayed event therefore never regresses a job.
- Every stream open, first or after a reconnect, marks every reader dirty.
  The stream starts after its subscription is active (`api/src/app/devices/device-events.ts:199-202`), so this read closes the gap.
- A change whose publisher exits after its commit reaches the open stream through the relay (section 3.6). The client needs no reconnect for it.
- The job detail reader reloads when an event names its job with a higher `revision` than the one shown. A Reconcile settlement therefore refreshes the counts, Latest activity, and the visible operation rows.
- The activity badge shows `running.count` from the latest activity read. Counts never come from capped row lists.
- After `POST /api/jobs/activity/seen` succeeds, the client marks the activity reader dirty. Its reread computes `attention` from the new `seenAt`.
  No job event and no reconnect take part. Other tabs of the same person clear the attention dot at their next activity read.
- The Recent section also changes when a job leaves the 24-hour window. After each successful activity read, the reader schedules one reread at `recent.nextExpiryAt`.
  It measures the delay from `observedAt`, so the client clock never decides the time. Timed rereads run at most once per 60 s.
  A job therefore leaves the Recent count within 60 s after its window ends, without an event or a reconnect.

### 3.5 Devices grid in place

- Write and read-back settlements publish `entity-batch` with the published device IDs.
- The Devices store reloads those rows by ID (`frontend/src/app/devices/devices.store.ts:597-599`). The rows come from the server projection, which holds the accepted value (section 5.8).
- The reload serves an entity entry only at the current entry version (section 5.11). The write path stores no entry.
  The written rows therefore come from Postgres until a sync job stores their entries.
- When the worker exits before it publishes, the relay publishes `entity-batch` within the bound of section 3.6.
- The device record keeps its current schema (`libs/application-contracts/src/lib/devices.ts:60-81`). The grid shows no verification indicator (OQ2 ruling). The job detail shows each operation's outcome and update time.
- Default 13 of the workflow record asks to show the verification state and age (`main@3eab39a:docs/workflows/update-device-annotated-location.md:118`).
  Under the OQ2 ruling, the job detail shows them per operation: `outcome`, `verifiedBy`, and `updatedAt`.

### 3.6 Publication rows and the relay

The architecture commits results, overlays, and the notification outbox together (`docs/portfolio/03-architecture.md:228`). Publication rows are that outbox.

- `cc.record_job_change(p_job, p_status_changed, p_device_ids, p_removed_ids, p_batch)` increments `revision`, sets `changed_at`, and inserts one publication row.
  It returns the publication element of the row.
- Every function that changes what a reader sees calls it in its own transaction. The callers are confirmation, refresh creation, admission, labels, starts, claims, settlements, finishes, refresh batches, full-sync pages, and purges.
  A rolled-back change leaves no row.
- Only write-path settlements carry device IDs. A refresh row carries none.
- A refresh batch keeps its direct `entity-batch` publication before its batch finish (`worker/src/entity-sync.ts:272-287`).
  Its `batch` comes from the request. Its positive `batchCount` comes from the batch read (`worker/src/entity-sync.ts:163-170`, `worker/src/entity-sync.ts:277-278`, `libs/application-contracts/src/lib/entity-cache.ts:86-95`).
  The Devices store reloads its updated and removed rows (`frontend/src/app/devices/devices.store.ts:597-599`).
- A worker exit before that publication leaves the batch unfinished. The flow retries the batch request (`deployment/kestra/entity-sync.yaml:42-47`).
  A successful retry publishes the event. A batch whose retries all fail leaves its rows without an event, as today (section 10.1).
  Refresh device invalidation therefore needs no publication row.
- Refresh rows have no publisher (section 3.2). The relay publishes their `job-changed`.
- A publication element holds `publicationId`, `jobId`, `displayId`, `requestedBy`, `revision`, `statusChanged`, `deviceIds`, `removedIds`, `batch`, and `batchCount`.
  `revision` is the job revision when the function returns. `batchCount` is the write batch count of the job, or null without devices.
- An `entity-batch` event from a publication row takes `jobId`, `batch`, and `batchCount` from the element (`libs/application-contracts/src/lib/entity-cache.ts:86-95`).
  The Devices stream drops those three fields (section 3.1). The Devices store reloads rows by ID (`frontend/src/app/devices/devices.store.ts:597-599`).
- The publisher of a write-job row is the code path that committed it. A refresh row has no publisher. The relay is not a publisher.

After its commit, the publisher handles each row that changed the status or published devices:

1. With removed devices, the worker deletes their entity keys, as entity cache decision D9 requires (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:95`).
2. With devices, it increments the query generation once. It then publishes `entity-batch` with the `deviceIds` and `removedIds` of the element.
3. It publishes `job-changed` with the element revision.
4. It deletes the row through `cc.complete_job_publications(p_customer, p_ids)`.

The publisher leaves progress-only rows to the relay. The relay runs on its own 5-second timer in the job service, apart from the tick of section 6.5.
A Kestra start deploys its flow and then starts the execution (`api/src/app/orchestration/orchestration.service.ts:54-98`). Each request waits up to 5 s (`api/src/app/configuration/service-http.ts:77-80`).
A slow tick therefore never delays the relay. One relay run executes at a time:

1. `cc.read_job_publications(p_customer, p_limit)` returns up to 500 elements: every progress-only row, every refresh row, and every other row older than 5 s.
2. For each element with devices, the relay increments the query generation. It then publishes `entity-batch` with the `deviceIds` and `removedIds` of the element.
   The relay runs in the API, so it never touches an entity key (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:37`).
3. For each job, it publishes one `job-changed` with the current revision of the job.
4. It deletes the rows. A Redis failure keeps them for the next run.

Bounds:

- A row that its publisher left reaches Redis within 10 s plus one relay run: 5 s of grace and one 5-second period. Tests allow 15 s.
  The bound holds while the API process, Postgres, and Redis run.
- A progress-only row or a refresh row reaches Redis within one period plus one run.
- A lost subscriber connection closes every stream (`api/src/app/devices/device-events.ts:30-33`, `api/src/app/devices/device-events.ts:103-114`). The browsers then reopen and reread every resource (section 3.4).
- After an API restart, streams reopen, and the tick relays every row that waited.

Duplicates:

- A slow publisher and the relay can both publish one row. Readers ignore a `job-changed` at or below their revision (section 3.4).
- `entity-batch` reloads rows by ID (`frontend/src/app/devices/devices.store.ts:597-599`), so a repeat reloads the same rows.
- A repeat increments the query generation once more. Cached query results then miss once more. No repeat writes an entity entry.

The sequence of finding F3: the worker commits a terminal status and exits before it publishes. The stream stays open.

| Reader                        | Path to the committed state                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Activity count                | The relay publishes `job-changed` within the bound above. The activity reader rereads `GET /api/jobs/activity`.                                                          |
| Job detail and operation rows | The detail reader rereads the detail, its Latest activity, and the visible operations page.                                                                              |
| Device rows                   | The relay increments the query generation and publishes `entity-batch`. The Devices store reloads the rows. The version check of section 5.11 serves them from Postgres. |

A full sync keeps its current Redis rebuild after its finish (`worker/src/device-sync.ts:166-216`). Its rows carry no devices. Section 10.1 records the residual.

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
  The workflow record quotes the same message (`main@3eab39a:docs/workflows/update-device-annotated-location.md:72`).
- The message follows the owner rule that Devices access messages name the denied scope (`docs/workflows/device-browsing.md:118`).
- Google and the mock answer an ungranted scope with 401 `unauthorized_client` at token exchange (`main@3eab39a:libs/google-connection/src/lib/provider.ts:115`, `mock@v0.2.0:src/auth/token.ts:103-113`).
  origin/main classifies that answer as `delegation-not-authorized` (`main@3eab39a:libs/google-connection/src/lib/provider.ts:116-120`).
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
  It returns `clock_timestamp()`. The renewal after a multipart round stamps the write responses of that round (section 5.8).
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
- A result that fails its fence changes nothing: no outcome, no counter, no device row, no overlay, and no publication row.
  The function returns the settled operations and the publication element of its row (section 3.6). A call that settles nothing returns no element.
- A recording that fails with a deadlock (`40P01`) runs again, up to 3 times, while its lease lives. The rolled-back attempt changed nothing.
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

| Kind           | Source                                                                 | Stamp                                                                                                                 |
| -------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Write response | A 2xx PATCH part                                                       | The time that the renewal after its multipart round returns (section 5.4). Without that renewal, the settlement time. |
| Read-back      | A GET part of a read-back                                              | The Postgres clock read before the request.                                                                           |
| Refresh read   | A GET part of an ID-list refresh (`worker/src/entity-sync.ts:196-202`) | The Postgres clock read before the request (`worker/src/entity-sync.ts:182-189`).                                     |
| List           | A full-sync page (`worker/src/device-sync.ts:128-136`)                 | The staging time (`deployment/postgres/migrations/016-device-inventory.sql:304-310`).                                 |

A list shows each device as it was some time earlier. A write response or a GET shows current data (`mock@v0.2.0:docs/guide/behavior.md:67-74`).
So the stamp of a list says nothing about the age of its values. The overlay rules keep current-value verification apart from list convergence.

A write stamp falls after Google applied the write. A GET stamp falls before Google read the device.
A GET stamp above a write stamp therefore proves the later observation. A GET sent during the round of a write has the lower stamp, so the write wins.
Section 10.1 records that residual.

Write responses, read-backs, and refresh reads are current observations. A list observation shows values of unknown age.
The current-value stamp (section 1.8) records the newest current observation that set `annotated_location`. It is the ordering boundary of the field.
Overlay deletion never clears the stamp. Lists never set it.

Rules:

1. Publication from the write path happens only inside `cc.settle_device_update_operations`, for operations that the same transaction settles. A fenced result publishes nothing.
2. A current observation sets `annotated_location` only when its stamp is newer than the current-value stamp, or that stamp is null.
   An older current observation changes no field, no stamp, and no overlay. Its operation still records the outcome and the evidence.
3. A write response or a read-back that passes rule 2 sets the field and the current-value stamp. It replaces the overlay.
   The new overlay holds the observed value, the stamp, the source, the job, the operation, and `expires_at` 36 hours after the stamp.
   Other fields of the device body follow the existing row rule (`deployment/postgres/migrations/016-device-inventory.sql:235`).
4. A refresh read that passes rule 2 sets the field and the current-value stamp. With a live overlay, it also moves the overlay to its value and stamp.
   The row rule decides only the other fields (`deployment/postgres/migrations/016-device-inventory.sql:235`). A refresh read never creates or deletes an overlay.
   B2 changes `cc.upsert_devices` in 016 (`deployment/postgres/migrations/016-device-inventory.sql:217-239`). A fourth parameter takes the observation kind.
   Refresh reads pass `read` for this rule. B2 changes that call (`worker/src/entity-sync.ts:223-227`) and the grant (`deployment/postgres/index.mjs:257`) with the signature.
5. A list observation with a live overlay: an equal value deletes the overlay. This is list convergence. A different value leaves the overlay value in place.
   Without a live overlay, the list sets the field, as today. The other fields follow the list. Lists never change the current-value stamp.
   B2 changes `cc.stage_devices` in 016 (`deployment/postgres/migrations/016-device-inventory.sql:304-310`) to pass `list` to the same upsert.
   Both sync kinds therefore still write through one upsert (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:50`).
6. An expired overlay has no effect. `cc.purge_jobs` deletes it. The current-value stamp stays.
7. A read-back that answers 404 publishes a soft delete (section 5.7) and no overlay.

While a live overlay exists, the device row holds the overlay value in `annotated_location`. Rules 2 to 5 keep this true.
Rule 2 alone orders current observations of the field. A refresh read that loses the row rule to a newer list still sets the field and the stamp.
Every function that reads or changes an overlay or the stamp first locks the device row. The row lock therefore orders concurrent observations of one device.

The 36-hour expiry follows the mock guide's quote of Google: some updates take up to 36 hours to show in lists (`mock@v0.2.0:docs/guide/behavior.md:69`).

| Sequence                                                                                                                                                              | Result                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Replace A (job 1), then Clear (job 2)                                                                                                                                 | Job 2's write response is newer. It replaces overlay A with null. The row stores null.                                               |
| Write A, a matching GET, then a lagged list with the old value                                                                                                        | The GET moves the overlay to its newer stamp. The lagged list differs, so the row keeps A.                                           |
| The same, then a list that shows A                                                                                                                                    | The list converges. It deletes the overlay. The row keeps A, and the stamp stays.                                                    |
| A refresh read sent before the write and recorded after it                                                                                                            | Its stamp is older than the current-value stamp and the row. The row and the overlay keep A.                                         |
| An unknown operation settled by read-back                                                                                                                             | The read-back publishes like a write response, in the settling transaction.                                                          |
| Job A's read-back GET (stamp t1) observes A and waits. Job B writes B (stamp t2). A list shows B and deletes the overlay. The GET returns.                            | Job A's operation settles `succeeded` with its evidence. t1 is older than the stamp t2. The row keeps B and gains no overlay.        |
| A read-back GET (stamp t1) observes A and waits. A refresh read (stamp t3) observes C. The GET returns.                                                               | The refresh read set the stamp to t3. The read-back records its evidence and publishes nothing. The row keeps C.                     |
| A read-back GET (stamp t1) observes A and waits. A refresh read (stamp t3) observes C. A list stages the device at t4. The refresh read records, and the GET returns. | The refresh read loses the row rule to the list, but it sets the field and the stamp t3. The GET publishes nothing. The row keeps C. |

A settlement that publishes nothing for a device leaves that device out of the published IDs. Its operation still changes the job, so its publication row carries `job-changed`.

After the commit, the worker handles the publication element of the settlement as section 3.6 states. A progress-only element waits for the relay. For any other element:

- A read-back 404 puts its device into `removedIds`. The worker deletes the entity keys of those devices (entity cache decision D9).
- With published devices, the worker increments the query generation once (`libs/application-contracts/src/lib/entity-cache.ts:48-49`), so cached queries that filter on the field miss.
  It publishes `entity-batch` with the published IDs (pattern: `worker/src/entity-sync.ts:272-281`). It stores no entity entry (section 5.11).
- It then publishes `job-changed` and completes the row.
- When the worker exits first, the relay publishes the same events. The keys of removed devices then stay until their TTL, and the version check rejects them (section 5.11).

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

7. It sets `finished_at`, records the change through `cc.record_job_change` as a status change, and commits.
   The caller publishes the publication row, or the relay does (section 3.6). The job service then cleans the hold and runs admission (sections 6.4 and 6.5).

- After a reaper finalization with `unknown` operations, the job service starts the reconcile flow for all of them.
- Every read-back settlement on a terminal job derives the status again by the same rule. The rule reads only counters, so a settled review moves the job to its final status.
- `skipped` arises only from job failure or interruption. The preview removes unchanged and excluded devices before the job exists (OQ7 ruling).

### 5.11 Entity entries

Today each writer reads records from Postgres and later stores them with an unconditional `SET` (`worker/src/entity-cache.ts:114-123`).
The refresh path reads and stores in separate steps (`worker/src/entity-sync.ts:237-258`). The full-sync rebuild uses the same writer (`worker/src/device-sync.ts:166-209`).
The reader trusts a Redis record without a Postgres check (`api/src/app/devices/device-pager.ts:116-139`). A paused writer can therefore replace a newer record with an older one.
A writer-side check cannot close that gap. A Redis restart, an eviction, or an expiry removes the newer value that such a check compares.
The local Redis keeps no data across a restart (`deployment/redis/runtime.mjs:40-41`).

Decision: the reader compares every entry with Postgres. Postgres holds the accepted value (section 5.8), so the check needs no Redis guarantee.

- Each entry is `{ version, record }` (`entityEntrySchema`). `version` is the entry version of section 1.8.
  `record` is a device record without `removedAt` (`libs/application-contracts/src/lib/devices.ts:73-75`).
- Card P3 changes `cc.read_device_records` and `cc.page_device_records` in 016 (`deployment/postgres/migrations/016-device-inventory.sql:276-292`). Each element gains `version`.
  One statement reads each record and both versions from one device row and one sync-state row. The signatures stay, so the grants of `deployment/postgres/index.mjs:260-261` still apply.
- Card P3 changes both functions, both writers, and the reader together. No merged revision therefore stores an entry that its reader cannot parse.
  Before P3, Redis holds bare records, as today.
- The refresh batch and the full-sync rebuild keep their `SET` and their TTL. They store entries instead of bare records.
  They delete the keys of removed devices, as entity cache decision D9 requires (`worker/src/entity-sync.ts:256-258`, `worker/src/device-sync.ts:169-183`).
- No other code stores an entity entry. Write settlements delete only the keys of devices that a read-back 404 removed (section 5.8). The relay never touches an entity key (section 3.6).
  The API never writes the entity cache (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:37`).

The read check:

- `DevicePager.hydrateWith` (`api/src/app/devices/device-pager.ts:109-150`) parses each entry with `entityEntrySchema`. An unreadable entry, or an entry of another device, counts as absent.
- It then runs one statement for every requested ID. `deviceRowsByIdSql` (`api/src/app/devices/device-query.ts:217-226`) takes the entry version of each ID, or null for an absent entry.
  The statement returns the current entry version of every known ID. It adds the row columns for each ID whose supplied version is null or differs.
- An entry serves its record only when its version equals the current entry version. Every other ID takes its row from the same statement.
  The reader still computes `stale` at read time (`api/src/app/devices/device-pager.ts:134`), as entity cache decision D8 requires (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:86-89`).
- Every API read of an entry passes through `hydrateWith`. The callers are both page paths (`api/src/app/devices/device-pager.ts:198-204`, `api/src/app/devices/device-pager.ts:248-254`) and `rowsById` (`api/src/app/devices/devices.service.ts:329-340`).
  No other API code reads a `cc:entity:*` key.

Why every served record matches Postgres:

- Updates of one device row wait on its row lock. The trigger of section 1.8 reads the committed version, so record versions grow in commit order. The telemetry version grows the same way.
- Of two states of one device, the later state has no lower record version and no lower telemetry version. Equal entry versions therefore mean equal record versions and equal telemetry versions.
  The record depends only on the device row and the telemetry failure (`deployment/postgres/migrations/016-device-inventory.sql:205-213`).
- The reader serves an entry only at the version that its own statement read. Every served record therefore equals the record that Postgres held for that statement.
- The check reads no TTL, no Redis history, and no writer clock. A lost, expired, evicted, or late entry either fails the check or holds the current record.

TTLs:

- A writer computes `recordSeconds` before its store (`worker/src/entity-sync.ts:245-255`, `worker/src/device-sync.ts:197-207`). The store applies that duration later (`worker/src/entity-cache.ts:114-120`).
  A paused writer therefore stores its entry with a TTL from an earlier time. The entry can outlive its freshness or a newer entry.
- A TTL therefore bounds memory only. No correctness rule reads it. An older version fails the check.
  A current entry past its freshness reads `stale` true, as its Postgres row does (`api/src/app/devices/device-query.ts:289-292`).

Cost:

- A page that misses an entry already runs one statement today (`api/src/app/devices/device-pager.ts:140-145`). The check adds the version columns to that statement.
- A page that hits every entry adds one primary-key statement. It reads at most 1,000 page IDs or 500 by-ids IDs (`libs/application-contracts/src/lib/devices.ts:271`, `libs/application-contracts/src/lib/devices.ts:93`).
- Budget: the check adds at most 20 ms to the p95 latency of a 1,000-row page whose entries all hit. Card P3 measures both values on the mock stack.
  A measurement above the budget goes to the eng-lead before the merge.
- Written devices read from Postgres until a sync job stores their entries. Each such read is part of the same statement.

| Sequence                                                                                                                                            | Result                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Revision-2 F2: a refresh reads A at version 5 and pauses. A write settles B at version 6. The refresh resumes and stores A.                         | The reader finds 5 against 6 and serves B from Postgres.                                                     |
| Revision-3 F2: the same sequence with a Redis restart before the refresh resumes.                                                                   | The reader finds 5 against 6 and serves B from Postgres.                                                     |
| Expired publication: a second refresh stores B at version 6 with a short TTL, and B expires. The paused refresh then stores A with its earlier TTL. | The reader finds 5 against 6 and serves B from Postgres.                                                     |
| Telemetry: entry D at version 8 waits in Redis. A full-sync finish records a telemetry failure, so the current version becomes 9.                   | The reader rejects D. It serves battery `unavailable` from Postgres until the rebuild stores D at version 9. |
| Removal: a full sync removes a device after a paused refresh read it. The rebuild deletes the key. The refresh then stores its entry.               | The soft delete raised the record version. The reader serves the removed row from Postgres.                  |

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

| Item           | Design                                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key            | `cc:job-hold:{customerId}:device-update`. It scopes by customer and canonical job type (`docs/reviews/2026-09-04-job-admission-policy.md:45`).                                                                                                             |
| Value          | The owning `job_id`.                                                                                                                                                                                                                                       |
| Write          | `SET key jobId EX 300`. No `NX`, no `XX`. One command writes owner and TTL together (`docs/reviews/2026-09-04-job-admission-policy.md:51`).                                                                                                                |
| Cleanup        | One Lua script with explicit keys deletes the key only when its value equals the finishing job ID (`docs/reviews/2026-09-04-job-admission-policy.md:41-43`). `CacheService.release` runs that script today (`api/src/app/cache/cache.service.ts:108-115`). |
| Registry       | `hold_written_at` and `hold_cleaned_at` on `cc.device_update_jobs`. One job type and one customer give one key per job (`docs/reviews/2026-09-04-job-admission-policy.md:45`).                                                                             |
| Admission read | `GET key`. Presence means held.                                                                                                                                                                                                                            |

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
The relay of section 3.6 runs on its own timer.

1. Read the hold key. A Redis error counts as held. Admission fails closed and retries on the next tick.
2. Call `cc.admit_device_update_job(p_customer, p_held)`. It locks pending write jobs with `FOR UPDATE`.
3. If a write job is running, label pending jobs `held` when `p_held` is true and `queued` otherwise. Admit nothing.
4. If no write job runs and `p_held` is true, label pending jobs `held`. Admit nothing.
5. Otherwise admit one job: smallest `target_count`, then oldest `created_at`, then lowest `display_id` (`docs/reviews/2026-09-04-job-admission-policy.md:71`).
   Apply the Admit step of section 5.3. Label the rest `queued`.
6. Start the execution (section 5.3).

A label change records itself through `cc.record_job_change` as a status change. The job service then publishes its row (section 3.6).
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

| Need                    | Mock facility                                                                                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patch faults            | `POST /domains/{id}/faults` with kind `status`, `error-rate`, `hang`, or `reset` and `method: directory.chromeosdevices.patch` (`mock@v0.2.0:docs/guide/configuration.md:315-327`).                                                                                                                |
| Fault order             | `status` and `reset` answer before the handler runs. `hang` waits and then runs the handler (`mock@v0.2.0:src/faults/faults.ts:205-245`). A `hang` beyond the 10 s client timeout loses the answer of a write that still takes effect.                                                             |
| Throttling for the hold | A `status` fault with 429 and reason `rateLimitExceeded` on the patch method for a counted number of calls.                                                                                                                                                                                        |
| Scope removal           | `remove-scope` for the write scope, and `revoke-delegation` for the client (`mock@v0.2.0:docs/guide/configuration.md:321-322`). Token exchange then answers 401 `unauthorized_client` (`mock@v0.2.0:src/auth/token.ts:103-113`).                                                                   |
| Scope grant             | `PUT /domains/{id}/delegation/{clientId}` with the scope list (`mock@v0.2.0:docs/guide/testing.md:275`).                                                                                                                                                                                           |
| Token outage            | The mock cannot fault `oauth.token` (`mock@v0.2.0:docs/guide/configuration.md:328`). Token outage tests inject the mint failure through a fake `getClient`.                                                                                                                                        |
| Send barrier            | A `hang` rule lowers its `remaining` count before it sleeps (`mock@v0.2.0:src/faults/faults.ts:231-233`). `GET /domains/{id}/faults` lists each rule with `remaining` (`mock@v0.2.0:src/control/control.ts:328-329`). A test polls that list until the hang rule reads 0, then adds the next rule. |
| List lag                | `writes.searchDelaySeconds`, 300 s by default (`mock@v0.2.0:docs/guide/behavior.md:70`). `POST /domains/{id}/index/flush` ends it (`mock@v0.2.0:docs/guide/testing.md:175-183`).                                                                                                                   |
| Validation              | Over 200 code points answers 400 `invalid` (`mock@v0.2.0:src/directory/device-writes.ts:26`, `mock@v0.2.0:src/directory/common.ts:130-134`, `mock@v0.2.0:src/directory/common.ts:46-54`).                                                                                                          |
| Write scope rules       | Writes need the write scope only (`mock@v0.2.0:src/auth/scopes.ts:49-50`).                                                                                                                                                                                                                         |

- The product harness starts the pinned mock (`api-e2e/admin-sdk-mock-fixture.mjs:215`).
  Nx targets: `api-e2e:admin-sdk-mock-integration` (`api-e2e/project.json:42`) and `api-e2e:client-review-mock` (`api-e2e/project.json:22`).
- Every mock write ruling is unverified against live Google (`mock@v0.2.0:docs/guide/behavior.md:145`). Live write behavior stays "not verified".
- The quota report never shows a hung call. Faults run before quota admission (`mock@v0.2.0:src/mock.ts:185-191`).
  The in-flight counters rise only at admission (`mock@v0.2.0:src/quota/limits.ts:167-168`). Tests therefore never wait on `GET /domains/{id}/quota` for a hang.
- A call in its hang keeps the rule list that it started with (`mock@v0.2.0:src/faults/faults.ts:198`, `mock@v0.2.0:src/faults/faults.ts:208`). A rule added during the hang applies only to later calls.

### 8.2 Failing-first rule

Each card commits each new test before its implementation. The handoff pastes the failing run on the parent revision and the passing run on the card revision.
A test that cannot fail without the change does not count.
A guard test passes on the parent revision. Its handoff pastes the failing run of the faulty variant that the test names.

### 8.3 Tests per card

B1, contracts (`npm exec nx test application-contracts`):

- Display ID pattern, status enum, and strict objects that reject extra keys.
- `value` limits at 200 and 201 code points with a 4-byte character. Whitespace only is rejected. Clear rejects a value.
- `jobEventSchema` accepts only `job-changed`. A `job-changed` payload fails `entityEventSchema`. `jobEventSchema` requires `requestedBy`.
- `jobActivitySchema` rejects more than 50 running rows, 50 waiting rows, or 10 recent rows. It accepts a null `recent.nextExpiryAt`.
- `jobLatestActivitySchema` rejects more than 3 samples per outcome and a sample without `updatedAt`.
- `jobProgressSchema` accepts null `total` and null `pending` together only.
- B1 adds no schema of a gated change. Cards B4 and P3 test `deviceStreamEventSchema` and `entityEntrySchema`.

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
- F1 older read-back: job A's read-back stamped t1 settles after job B's write (t2) and a converging list. The operation records `succeeded` with its evidence.
  The row keeps B, the current-value stamp stays t2, and no overlay exists.
- F1 refresh variant: a read-back stamped t1 settles after a refresh read stamped t3. The row keeps the refresh value, and the read-back publishes nothing.
- F1 stamp rules: a list never moves the current-value stamp. A refresh read older than the stamp changes nothing.
- F1 lost row rule: a list stages the device at t4. A refresh read stamped t3 then records C, and a read-back stamped t1 settles.
  The row keeps C with stamp t3, and no overlay exists.
- Lock order: while another session locks device A, a battery update for B and A waits without a lock on B.
- F3 publication rows: each job-changing function inserts one row in its transaction. A rolled-back change leaves none.
  `cc.read_job_publications` returns progress-only rows and refresh rows at once, and other rows after 5 s. Elements carry `displayId`, `requestedBy`, and `batchCount`.
  A refresh row carries no devices and a null `batchCount`.
  A read-back 404 puts its device into `removedIds`.
- Contracts with their producer: the three actions exist in `cc.application_actions`.
- Rev-4 F1 failure requesters, failing first: run the sequence of section 2.1. After step 1, `telemetry_failure_requested_by` is B.
  After step 3, `failure_requested_by` is A, and `telemetry_failure_requested_by` stays B. On the parent revision neither column exists, so the test fails there.
- Rev-4 F1 requester rules: abandon and the replacement of an expired sync record the `sync_actor` of that sync. A successful finish without a telemetry failure clears both requesters.
  The check constraints reject a failure without its failure requester.
- Rev-4 F1 expired sync, failing first: the sync of B fails with `quota`. A then starts Refresh all, and no worker claims it.
  After 2 minutes the projection reports `interrupted` (`deployment/postgres/migrations/016-device-inventory.sql:102-118`). A reads `interrupted`, and B does not.
  On the parent revision B reads `interrupted`, so the test fails there. A variant that checks `failure_requested_by` for an expired sync also fails it.
- Rev-4 F1 projection, failing first: `cc.read_device_sync` and `cc.request_device_sync` give A, B, and C the columns of the table of section 2.1.
  On the parent revision step 2 returns `quota` to A, so the test fails there.
- Rev-4 F1 jobs:read control, a guard: C reads every failure of the table of section 2.1 at every step.
  A grant of `jobs:read` at district scope of another customer gives A nothing more. Its faulty variant drops the `jobs:read` clause from `cc.job_visible`.
- Rev-4 F1 predicate: `cc.job_visible` passes for the requester and for `jobs:read` at platform scope or district scope of the customer.
  It fails for district scope of another customer, a disabled principal, and an old permission version.
- The sync state assertions of the existing device inventory integration tests still pass. Their reader requests every sync (`deployment/postgres/device-inventory.integration.mjs:30-39`).
  The predicate therefore passes for every failure. B2 rewrites the purge assertions (`deployment/postgres/device-inventory.integration.mjs:350-398`) for the purge of section 1.5.
- R9 reports: `cc.report_device_update_backoff` rejects an old token, a fenced attempt, an expired lease, and a sequence that does not increase.
- R9 hold acceptance: `cc.accept_device_update_hold` rejects a report older than 30 s, a report whose attempt lost its lease, and an applied report.

B3, preview and confirm API:

- The preview freezes targets. A device added after the preview never joins.
- Expiry gives 410. A second confirm returns the same job. A digest mismatch gives 409. Zero eligible targets give `422 nothing-to-update`.
- Missing `devices:bulk-actions` gives 403 and an `access-denied` audit row (`api/src/app/auth/auth.service.ts:311-331`).
- R7, failing first: a selection last changed 13 hours ago returns `expiredAt`. Preview create then returns `409 selection-expired`.
  On the parent revision the selection reads as plain empty (`api/src/app/devices/device-selection.ts:42-51`), so the test fails.
- R7: an approved job keeps its operations after the selection expires. An unexpired preview stays confirmable.
- R7 contract: `deviceSelectionSpecSchema` requires `expiredAt` as a timestamp or null. The selection route returns it.
- The manifest artifact exists for each job. An artifact failure fails the confirmation.

B4, jobs API, refresh jobs, and streams:

- List sort and keyset stability. Each filter. The attention filter keeps the job counts.
- R6 badge: `running.count` changes when a job starts and again when it finishes.
- R6 caps: 50 running, 50 waiting, and 10 recent rows. Counts beyond the caps exceed the rows.
- R6 attention: an entirely failed job sets `attention`. `seen` returns `seenAt`, and the next activity read reports `attention` false.
- N2 window: `recent.nextExpiryAt` equals the `finished_at` of the oldest counted job plus 24 hours. An empty window gives null.
- R6 revision: each status, counter, and operation change increments `revision`.
- R5: a stale-page refresh and a Refresh all show as REF- jobs with requesters. An empty inventory shows `completed` with 0 devices. A large inventory shows its full count.
- R1 forwarding: the Devices stream never sends `job-changed`, even when one arrives on the entity channel. The Jobs stream sends only `job-changed`.
- B4 publishes no event (section 3.2). Its stream tests publish channel events through a test Redis client.
- R1 denied access: `GET /api/jobs/events` without `jobs:read` and `devices:read` answers 403. Removing both actions closes an open stream at the next ping.
- Default 15 visibility: a principal with `devices:read` and without `jobs:read` lists, reads, and streams only the jobs that it requested.
  The activity counts and the requesters route of that principal cover only those jobs. Removing `jobs:read` from a holder closes its open stream at the next ping.
- F1 legacy event, two principals, failing first: principal A holds `devices:read` without `jobs:read`. Principal B requests a refresh, and one batch fails.
  Both hold open Devices streams. A receives `entity-batch` events without `jobId`, `batch`, or `batchCount`, and a `job-finished` event with a null failure.
  B receives the failure. On the parent revision A receives the job record of B, so the test fails there.
- F1: a holder of `jobs:read` at district scope receives the failure of the job of B. Removing `jobs:read` from that holder closes its Devices stream at the next ping.
- F1 device rows: A still receives every device ID of the job of B. A reloads those rows through `POST /api/devices/by-ids`.
- F1 full sync, failing first: B starts a Refresh all, and the sync fails with `quota`. The full-sync event of the Devices stream of A carries null failure fields.
  B receives the failure. On the parent revision the stream sends the failure to A, so the test fails there.
- F1 store: a `job-finished` event with a null failure schedules the recount and leaves the failure of the banner unchanged (`frontend/src/app/devices/devices.store.ts:600-602`).
- Stream contract: `deviceStreamEventSchema` rejects an `entity-batch` event with `jobId`, `batch`, or `batchCount`. It rejects a `job-finished` event with a job record.
  It accepts a `job-finished` event with a null failure.
- Rev-4 F1 retained telemetry on the stream, failing first: run the sequence of section 2.1 with open Devices streams for A, B, and C.
  After step 1, A receives a null `telemetryFailure`. After step 3, each principal receives its column of the table. On the parent revision A receives `quota`, so the test fails there.
- Rev-4 F1 over HTTP, a guard: `GET /api/devices/sync` gives A, B, and C their columns of the table of section 2.1.
  The answer of `POST /api/devices/sync` gives the same columns.
  Its faulty variant returns `cc.device_sync_projection` from `cc.read_device_sync` and `cc.request_device_sync`. Card B2 owns the failing-first proof of the SQL change.
- Rev-4 F1 battery, a guard: after step 3, `POST /api/devices/query` and `POST /api/devices/by-ids` give A, B, and C battery `unavailable`.
  Its faulty variant derives the battery state from the projected `telemetryFailure` of the caller.
- Rev-4 F1 read failure, failing first: a failed `forward` read sends A the full-sync event with null failure fields. A read that waits 6 s gives the same event after 5 s. In both cases the stream then ends.
  A `job-finished` event of a job without a header row sends A a null failure. On the parent revision A receives the failures of B, so the test fails there.
- Stream order, a guard: a full-sync event whose read waits, then an `entity-batch` event, reach A in that order. Its faulty variant sends each event when its own read ends.
- F4 Latest activity: a job of 300 operations with failures on the second operations page names them in `latestActivity`.
  Samples follow `updated_at` order and stop at 3. Each sample carries `updatedAt`. The counts match the job counters.
- F4: a Reconcile settlement moves `at` and replaces the unknown sample. A refresh job returns empty samples.

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
- F3 relay, failing first: commit a terminal change and skip its publication. The relay publishes `job-changed` within 15 s. The parent revision has no relay, so the test fails there.
- F3: a row with devices increments the query generation and publishes `entity-batch` with its device IDs and removed IDs. The relay writes no `cc:entity:*` key.
  A Redis error keeps the row for the next run. Progress-only rows publish once per job per run.
- F3 timer: a tick that waits on a 5 s Kestra timeout leaves the relay bound unchanged.
- Rev-5 F1 refresh rows, failing first: the rows of a refresh creation, a refresh batch finish, and a full-sync finish reach the job channel.
  Each reaches it on the next relay run, without the 5 s grace. The relay publishes no `entity-batch` for a refresh row.
  The parent revision has no relay. The test therefore fails there.
- The policy acceptance scenarios that apply (`docs/reviews/2026-09-04-job-admission-policy.md:77-91`).

B6, capability:

- The setup scopes include the write scope. The check sends no write (mock request log).
- `remove-scope` for the write scope gives `denied` and the exact message. `revoke-delegation` gives `denied`. A delegation grant through the mock control gives `granted`.
- R8 token outage with a granted scope: an injected `network-failure` or `provider-unavailable` mint failure gives `unavailable` with that code, never `denied`.
- A 403 on the list gives `unavailable` with `permission-denied`.

P1, flows, ACL, and edge:

- The flow YAML validates. `device_update` has no flow concurrency limit and a `ForEach` limit of 1.
- Kestra runs both flows against a stub dispatch endpoint that records each request. The pattern is the flow upload and start of `deployment/kestra/run-external-worker-check.sh:301-337`.
  The stub proves batch order and one batch at a time. It proves a retry after a 503 answer or a closed connection, and no retry after a 200 answer.
- The `errors` tasks post the finish after a batch request fails its retries. The reconcile flow posts one request with its inputs.
- ACL: the worker user cannot write the hold key. The worker user can publish on `cc:job-events:*`. The API user can publish and increment the query generation.
- Edge: every new route passes with its method, and other methods answer 405. `/api/jobs/events` gets the event idle timeout.

P2, worker, with a fake batch client and on the mock:

- Request shape: the PATCH body holds only `annotatedLocation`. Clear sends `null`. A batch holds at most 250 parts.
- Classification: one case per row of the section 7.1 table.
- R3 response loss then refusal, fake client: round 1 fails with status 0 after the fake applies the write. Round 2 answers a part 403.
  The operation becomes `unknown`, and read-back settles it `succeeded`. Repeat with 400 and 404.
- R3 first-attempt refusals: 403, 400, and 404 on the first request give `failed` without a read-back.
- R3 on the mock: a one-call 12 s `hang` on the patch method. The test polls `GET /domains/{id}/faults` until the hang rule reads `remaining` 0 (section 8.1).
  It then adds a one-call `status` 403 rule. The client times out at 10 s, and the retry receives 403. Read-back settles the operation `succeeded`.
- R3 fatal answer, fake client: a 200 outer answer with a malformed multipart body ends the call. Operations sent in that round become `unknown`.
  Operations with an earlier 2xx event stay `succeeded`. The job fails with `invalid-response`.
- Graceful stop: unsent operations return to `pending`. An operation in flight becomes `unknown`. The next claim proceeds at once.
- R8 token outage with a granted scope: an injected `network-failure` stops the job with that failure. Unsent operations become `skipped`. Write access stays unchanged.
- R8 missing scope: `remove-scope` gives job failure `delegation-not-authorized`, `skipped` operations, and write access `denied`.
- R2 lease: a rejected renewal aborts the call, and no later round leaves the worker. The watchdog aborts after 150 s without a successful renewal.
- R2 duplicate dispatch: two requests for one batch send one Google request. The second answers `done`.
- R2 killed runner: a worker killed after its claim leaves `dispatched` operations. The Kestra retry waits out the lease plus grace, fences them, and reads them back.
- R2 delayed recording after takeover changes nothing.
- R4 on the mock: Replace, then Clear, leaves null in the row that `POST /api/devices/by-ids` returns. A list during the lag keeps the written value. `flush`, then a list, deletes the overlay.
- R4 read-back success publishes `entity-batch`, and `POST /api/devices/by-ids` returns the read-back value.
- F1, fake client: hold the read-back answer of job A. Settle job B and a converging list, then release the answer.
  Job A's operation settles `succeeded`. The device row and the `by-ids` row keep B.
- F1 lost row rule: a read-back of job A observes A and waits. A refresh read of C waits before its record step. A list stages the device.
  The refresh then records, and the read-back settles. The device row and the `by-ids` row keep C.
- Write stamps, fake client: a part answered in round 1 takes the renewal time after round 1. A refresh read stamped after that renewal wins.
- A recording that fails once with `40P01` settles on its second run.
- F3 commit before publish: stop the worker after a settle commit and before its Redis work. The publication row stays with its devices and revision.
  Card B5 tests the relay. Card Q1 runs the whole path.
- Rev-5 F1 refresh publication, a guard: a successful ID-list refresh batch reads one present device and one missing device.
  Before its batch finish, the worker publishes one `entity-batch` on the entity channel. The event holds the present ID in `deviceIds`.
  It holds the missing ID in `removedIds`, its `batch`, and a positive `batchCount`. `entityEventSchema` parses it.
  The batch finish row carries no devices. The worker publishes no `job-changed` for it.
  Its faulty variant lacks the direct publication (`worker/src/entity-sync.ts:272-281`). That variant sends no `entity-batch`. The test therefore fails on it.
  Card P3 adds this guard first, because P3 changes the refresh writer (`worker/src/entity-sync.ts:237-258`). P2 keeps it.
- F2 write path: a Redis command log shows no `SET` on a `cc:entity:*` key from the write path. A read-back 404 deletes the key of its device.
- R9: reports arrive every 60 s during quota waits. A report after the lease ends is rejected.
- N1, moved from P1: Kestra runs `device_update` against the real worker on the mock stack. The job reaches its terminal status.

P3, entity entries and the read check, with a real Redis and Postgres:

- 016 versions: each device writer raises `record_version` by 1 per changed row. An update without a change keeps it.
  A soft delete raises it. `cc.read_device_records` and `cc.page_device_records` add `version` to each element and still return present devices only.
- 016 versions: a finish that changes the telemetry failure raises `telemetry_version` by 1. Each element carries the sum of both versions.
- Requester only, failing first: a finish that keeps the telemetry failure and records another failure requester keeps `telemetry_version` (section 1.3).
  On the parent revision `telemetry_version` does not exist, so the test fails there.
  Its faulty variant raises the version on any change of the sync state row.
- Entry contract: `entityEntrySchema` accepts a version with a record. It rejects a null record, a record with `removedAt`, and a version below 1.
- Hit, failing first: an entry at the current version serves its record. The statement returns no row columns for it.
  On the parent revision the reader parses each value as a bare record. The strict parse rejects the entry (`api/src/app/devices/device-pager.ts:129-138`), so the test fails there.
- F2 cache loss, a guard: a refresh reads A at version 5 and pauses at a test hook. Postgres then commits B at version 6, through a second refresh or a write settlement.
  The test empties Redis, as a restart of the local Redis does (`deployment/redis/runtime.mjs:40-41`). The refresh resumes and stores A. `POST /api/devices/by-ids` returns B.
- F2 expired publication, a guard: a refresh reads A at version 5 and pauses. A second refresh commits B and stores it with a TTL of 1 s through an injected clock. B expires.
  The paused refresh then stores A with its earlier TTL. `POST /api/devices/by-ids` returns B.
- F2 overwrite, a guard: the paused refresh stores A over a stored entry B. `POST /api/devices/by-ids` returns B.
- The faulty variant of the three guards is a reader without the version comparison (section 8.2). Each handoff pastes its failing run.
- F2 telemetry, a guard: entry D waits in Redis. A full-sync finish records a telemetry failure. Before the rebuild, `by-ids` returns battery `unavailable`.
  Its faulty variant is an entry version without the telemetry version.
- F2 removal: a full sync removes a device after a paused refresh read it. The rebuild deletes the key, and the refresh then stores its entry. `by-ids` returns the removed row from Postgres.
- Late current entry: a refresh stores the current entry after its freshness ended. `by-ids` serves it with `stale` true.
- Reader: an unreadable entry, an entry of another device, and an entry of the wrong shape read Postgres.
- Budget: the handoff records the p95 latency of a 1,000-row page of full hits, with and without the check (section 5.11).

F1 to F6, component and browser tests against the named frames:

- F1, R7: an expired selection shows the `105:189` state and asks for reselection. A `selection-expired` answer keeps the draft values.
- F1: the disabled reasons cover an empty selection, missing actions, each write-access state, and offline.
- F2: the preview pages every target. An expired preview shows the `104:434` state. A second click on Create update job creates no second job.
- F4, R6: a `job-changed` event for the open job rereads the detail and the visible operations page.
- F4, R6: after Reconcile, the row moves from Unknown to its outcome without a manual refresh.
- F4, R6: events with revisions 7 and then 6 end in the state of the last read. A reconnect rereads the detail.
- F4, finding F4: Latest activity renders the line of frame `104:209` for one failed and one unknown sample. The line names a failure outside the visible page.
  Reconcile updates the line without a manual refresh. A later success leaves the time of the line at the newest sample.
- F4, note 00:45: a job with 36 succeeded and 12 pending operations and no samples renders the counter line of frame `228:4524`.
- F4, finding F3: a relayed `job-changed` without a reconnect rereads the detail, Latest activity, and the visible operations page. A repeated revision starts no read.
- F5, R6: the badge follows `running.count` after a job starts and after it finishes. An entirely failed job shows the attention dot. Opening the panel clears it.
- F5, N2: after `seen` succeeds, the dot clears without a job event or a reconnect.
- F5, N2: a fake clock moves a Recent job past its 24 hours. The job leaves the panel within 60 s, without a stream event.
- F5, R6: the panel shows at most 50 running, 50 waiting, and 10 recent rows, with View all jobs. A reconnect rereads the summary.
- F5, Rev-5 N1: a panel row opens its job detail. View all jobs opens the Jobs page. Neither action lands on the account page.
- F5, finding F3: a relayed terminal `job-changed` without a reconnect moves the badge.
- F6, R4: Replace, then Clear, updates an open grid in place. A read-back success updates the row. Drafts, selection, and focus stay (JOB-02).
- F6, finding F3: a relayed `entity-batch` updates the grid row.

Q1, end to end on the mock in one fresh installation:

- The six completion items of the workflow record (`main@3eab39a:docs/workflows/update-device-annotated-location.md:198-203`).
- Adversarial runs: duplicate submission, duplicate dispatch, a stale attempt, a worker killed mid-batch, and an API restart between admission and start.
- Adversarial runs: a worker stopped between a settle commit and its publication, and a refresh interleaved with a write.
- Adversarial runs: a Redis restart during a write job keeps the accepted values in the grid. A second principal without `jobs:read` receives no job record on the Devices stream.
- Adversarial runs: the sequence of section 2.1 on the mock. A `status` fault of 403 (`mock@v0.2.0:docs/guide/configuration.md:318`) on the route `chrome.telemetry.devices.list` fails the telemetry read of B.
  The mock answers a Chrome fault with an RPC error that holds no `errors` list (`mock@v0.2.0:src/faults/faults.ts:170-172`, `mock@v0.2.0:src/http/errors.ts:52-68`).
  `failure()` then finds no reason and maps the 403 to `permission-denied` (`main@3eab39a:libs/google-connection/src/lib/provider.ts:99-113`, `main@3eab39a:libs/google-connection/src/lib/provider.ts:147`).
  The pager retries only `quota` (`libs/google-connection/src/lib/devices.ts:248-254`). The worker stores the code as the telemetry failure (`worker/src/device-sync.ts:147-150`).
  The retained failure of B is therefore `permission-denied`, not the `quota` of the table. The visibility rule does not depend on the code.
  A never receives that retained failure through `GET`, `POST`, or the Devices stream. Cards B2 and B4 keep the `quota` case.
- The policy acceptance scenarios.
- The latency of a 250-part write batch against the 10 s client timeout.
- Live write behavior recorded as not verified.

## 9. Implementation cards

Operator direction (2026-10-16 21:35): no frontend card waits on design approval. Each frontend card follows its named frames and the approved activity-area mockup.
Operator note (2026-10-16 23:39): the owner merged PR #36, so the implementation gate is satisfied. The main chat creates these cards after design approval.
Each card inspects its Figma frames before implementation (`AGENTS.md:68`). Each card states what it did not verify.
Card order rule: B1 adds new contracts only. A change to an existing strict contract lands in the card that changes its producer.
B2 adds the three actions with 017. B3 adds `expiredAt` with the selection route. Main therefore never parses a contract that its producer does not yet fill.
A new contract of a gated change lands in its gated card: `deviceStreamEventSchema` in B4, and `entityEntrySchema` in P3.
B6 depends on B2, because the write-access routes require `devices:write` (section 2.1).
B4 depends on P1 for the edge. The edge allows the Jobs routes and gives the Jobs stream its idle timeout (section 3.3). B4 publishes no event (section 3.2).
B5 depends on P2, because its dispatch tests assert answers of the worker handlers. F1 and F3 depend on P1, because the edge serves their pages and routes.
F2 depends on F3 and F4. Its View job link opens the job detail of F4 under the Jobs item of F3.
F5 depends on F4, which brings F3. A panel row opens the job detail of F4. View all jobs opens the Jobs page of F3.
The shell routes hold neither page today (`frontend/src/app/app.routes.ts:57-168`). An unmatched path redirects (`frontend/src/app/app.routes.ts:169`).

Owner gate (section "Owner decision gate"). The main chat accepted it on 2026-10-17 and extended it at 03:10 (OQ10):

- P1 builds the D1 and D13 changes. B4 builds the D6, D7, and D12 changes. B5 builds the D6 and D13 changes. P3 builds the D9 change.
- None of these four cards dispatches before the owner confirms its changes. The table below calls them "all four". The owner confirmed the changes on 2026-10-17. The four cards can dispatch.
- P2, F1, F2, F3, F4, F5, F6, and Q1 depend on a gated card. They wait through their dependencies.
- B1, B2, B3, and B6 build no gated change and depend on no gated card.

Start order:

- After design approval: B1, then B2, then B3 and B6.
- After the owner confirms: P1 and P3. Then B4, P2, and F1. Then F3, B5, and F6. Then F4. Then F2 and F5. Q1 runs last.
- The edge routes of P1 build no gated change. The main chat can move them into an ungated card, so that F1 starts before the owner answers.

| ID  | Profile  | Title                                                                                                                                      | Depends on     | Owner gate         |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------------------ |
| B1  | backend  | New contracts for device updates, jobs, and job events                                                                                     | none           | none               |
| B2  | backend  | Migrations 016 and 017: jobs, refresh job model, write tables, fenced functions, overlays, device rows, failure requesters, purge, actions | B1             | none               |
| B3  | backend  | Preview, confirmation, selection expiry, and the evidence manifest                                                                         | B2             | none               |
| B4  | backend  | Jobs API, Latest activity, activity, visibility, REF- jobs, the job channel, and the Devices stream mapping                                | B2, P1         | builds D6, D7, D12 |
| B5  | backend  | Job service: admission, dispatch recovery, hold, cleanup, reaper, relay, Reconcile, result file                                            | B3, B4, P1, P2 | builds D6, D13     |
| B6  | backend  | Device write capability and write-access state                                                                                             | B2             | none               |
| P1  | platform | Kestra flows, orchestration starts, Redis ACL, and edge routes                                                                             | B1             | builds D1, D13     |
| P2  | platform | Worker writes, leases, classification, read-back, publication, events, and reports                                                         | B2, P1, P3     | waits on P1, P3    |
| P3  | platform | Entry versions in 016, versioned entity entries, and the read check                                                                        | B2             | builds D9          |
| F1  | frontend | Bulk Actions, the Update device entry, the draft page, and the expired selection                                                           | B3, B6, P1     | waits on P1        |
| F2  | frontend | Preview, confirmation, and receipt pages                                                                                                   | F1, F3, F4     | waits on all four  |
| F3  | frontend | Jobs navigation item and Jobs page                                                                                                         | B4, P1         | waits on P1, B4    |
| F4  | frontend | Job detail, Latest activity, operations, Inspect failure, and Reconcile                                                                    | F3, B5         | waits on all four  |
| F5  | frontend | Jobs activity area                                                                                                                         | F4             | waits on all four  |
| F6  | frontend | In-place grid updates for written values                                                                                                   | P2             | waits on P1, P3    |
| Q1  | qa       | Mock demonstration and adversarial verification of the slice                                                                               | all above      | waits on all four  |

B1. Scope: the new files and schemas of section 2.2, and `jobLatestActivitySchema` of section 2.5. It also covers `jobEventSchema` of section 3.1.
Acceptance: `npm exec nx test application-contracts` passes with the B1 tests. No existing schema changes.

B2. Scope: section 1 without the entry versions, and the SQL functions of sections 3.6, 5.3 to 5.10, and 6.3. Card P3 owns the entry versions.
It edits 016 and adds 017, as section 1.1 states. It adds the failure requesters of section 1.3, and `cc.job_visible` and `cc.visible_device_sync` of section 2.1.
It adds the three actions of section 2.1 to `actionSchema`, `actionScopeKinds`, and 017.
It changes the refresh call of `cc.upsert_devices` and the 016 grants with the new signature (sections 1.7 and 5.8).
Acceptance: a fresh installation applies 001 to 017. The B2 integration tests pass. `checkReadiness` reports ready (`deployment/postgres/index.mjs:277-296`).
017 holds only new objects and the foreign key of section 1.1. Every other change to a 016 object edits 016.
Every job-changing function inserts its publication row. Every multi-row device writer locks its rows in `device_id` order.
`cc.read_device_sync` and `cc.request_device_sync` return the projection of section 2.1 for their caller.

B3. Scope: sections 2.3, 2.4, and 2.8, a `DeviceUpdatesController` under `api/src/app/devices/`, the selection change in `api/src/app/devices/device-selection.ts`, and the manifest of section 5.9.
It changes `deviceSelectionSpecSchema` together with the selection route. It adds the `StorageService` method that B5 also uses (section 5.9).
Acceptance: the B3 tests pass. A duplicate confirmation never creates a second job. The manifest artifact exists for each job.

B4. Scope: sections 1.3 (API side), the visibility of section 2.1, sections 2.5, 3.1, and 3.3, and section 3.4 (server side). It adds a `jobs` module under `api/src/app/jobs/`.
It includes the `EventFanout` and `streamEvents` changes in `api/src/app/devices/device-events.ts` and the Devices stream forwarding (`api/src/app/devices/devices.controller.ts:167-206`).
It adds `deviceStreamEventSchema` (section 3.1). It also changes the Devices store parse (`frontend/src/app/devices/devices.store.ts:587-610`), because the stream events change shape. A frontend reviewer checks that file.
It subscribes the API to the job channel for the Jobs stream (sections 3.1 and 3.3). It publishes no event (section 3.2).
Owner gate: B4 builds the D6, D7, and D12 changes. It dispatches only after the owner confirms them.
Acceptance: the B4 tests pass. A stale-page refresh and a Refresh all both show in `GET /api/jobs` with REF- IDs and requesters.
Latest activity names failed and unknown operations from the whole job. No Devices stream event carries a job ID, a job record, or a requester.
No Devices route carries a failure whose requester fails the predicate for the caller. No stream event carries one after the next ping of its stream.

B5. Scope: section 6, section 2.6, and the job service parts of sections 5.3 and 5.10.
It also covers the relay of section 3.6 and the result file of section 5.9. The result file uses the `StorageService` method of card B3.
The job service publishes its write-job rows. The relay publishes progress-only rows, refresh rows, and the rows that a publisher left (section 3.6).
Owner gate: B5 builds the D6 and D13 changes. It dispatches only after the owner confirms them.
Acceptance: the B5 tests pass. A second write job reads `held` while the hold exists and `running` after cleanup or expiry. Refresh jobs run during a hold.
A change whose publisher exits reaches Redis within 15 s. A refresh row reaches Redis within one relay period plus one run. The relay writes no entity key.

B6. Scope: section 4 and the write-access routes of section 2.7.
Acceptance: the B6 tests pass. The connection page lists the write scope. Removing the scope in the mock disables Update device with the exact message.

P1. Scope: section 5.1, the ACL changes of sections 3.2 and 6.2, and the edge.
The API rule gains `+publish` and `+incr`. The worker rule gains `&cc:job-events:*` (`deployment/redis/runtime.mjs:10-14`). P1 owns every change to these two lines.
The edge adds the API routes of sections 2.3 to 2.7 to its allowlists (`deployment/bootstrap/application-edge.mjs:109-129`).
It adds the pages `/jobs`, `/jobs/{displayId}`, `/jobs/{displayId}/receipt`, `/devices/update`, `/devices/update/previews/{previewId}`, and `/devices/update/previews/{previewId}/confirm` (`deployment/bootstrap/application-edge.mjs:33-41`, `deployment/bootstrap/application-edge.mjs:131-133`).
It gives `/api/jobs/events` the event idle timeout (`deployment/bootstrap/application-edge.mjs:196-197`).
Owner gate: P1 builds the D1 and D13 changes, through the two ACL lines. It dispatches only after the owner confirms them.
Acceptance: the P1 tests pass. Kestra runs both flows against the stub endpoint. The run against the real worker belongs to card P2.

P2. Scope: sections 5.2 to 5.8, 6.3 (worker side), 7, and the worker side of section 3.6, in new worker modules beside `worker/src/entity-sync.ts`.
It includes `patchAnnotatedLocations`, `deviceStates`, and the `onSend` hook in `libs/google-connection/src/lib/`. The write batch size is a setting with 250 as its ceiling.
P2 depends on P3, because the write path stores no entity entry and relies on the read check.
P2 keeps the direct refresh publications: `entity-batch` before the batch finish, `job-finished`, and `full-sync` (`worker/src/entity-sync.ts:272-293`, `worker/src/device-sync.ts:217-224`).
Section 3.1 reads all three. Refresh rows carry no devices. The relay of card B5 publishes their `job-changed` (section 3.6).
Acceptance: the P2 tests pass. No code path sends a PATCH part without a committed claim and a live lease. Every write-path settlement publishes through its publication row.
A successful refresh batch still publishes `entity-batch` with its updated and removed devices. Kestra runs `device_update` against the real worker on the mock stack.

P3. Scope: section 5.11, the entry versions of section 1.8 in 016, and `entityEntrySchema`. It changes the refresh writer (`worker/src/entity-sync.ts:237-258`) and the full-sync writer (`worker/src/device-sync.ts:166-209`) to store entries.
It adds the read check to `DevicePager.hydrateWith` (`api/src/app/devices/device-pager.ts:109-150`) and to `deviceRowsByIdSql` (`api/src/app/devices/device-query.ts:217-226`).
The 016 versions, the writers, and the reader change in one card, because the entry format changes every side.
Owner gate: P3 builds the D9 change. It dispatches only after the owner confirms it.
Acceptance: a fresh installation applies 001 to 017 with the versions in 016. P3 adds no migration file. The P3 tests pass. Every device writer raises the record version.
Every API read of an entity entry passes the version check. The handoff records the latency budget of section 5.11.

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
It shows the Latest activity section below the operations grid from `latestActivity` (section 2.5): the sample line and the counter line.
The owner answered OQ9 on 2026-10-17 (section 10.2). F4 drafts each missing sentence in the style of its frames. The owner reviews the strings in the F4 PR.
It shows no Cancel, Retry, Pause, or download (eng-lead ruling 20). Live state follows section 3.4.

F5. Source: the approved mockup `main@3eab39a:docs/ui/designs/2026-10-16-jobs-activity-area.html` and `.png` (D6). Its states are Idle, Running, and Needs attention (`main@3eab39a:docs/ui/designs/2026-10-16-jobs-activity-area.html:141-143`).
The Activity button sits left of Help (`frontend/src/app/shell/shell.html:121-127`) with the running count and ring. The attention dot clears through `POST /api/jobs/activity/seen`.
The panel lists Running, Waiting, and Recent from `GET /api/jobs/activity` with the caps of section 2.5. Each row opens the job detail of card F4. "View all jobs" opens the Jobs page of card F3.
F5 therefore depends on F4, which brings F3. Its tests check both actions (section 8.3).
The activity reader rereads after `seen` succeeds and at `recent.nextExpiryAt` (section 3.4).

F6. The Devices grid applies `entity-batch` events from write jobs in place. It keeps drafts, selection, and focus (JOB-02). It shows the accepted value and no verification indicator (OQ2 ruling). The owner confirmed that ruling on 2026-10-17.

Q1. Runs the tests of section 8.3 for Q1. It attacks the green suites with the policy acceptance scenarios, duplicate submission, duplicate dispatch, and stale attempts.
It also stops a worker between a settle commit and its publication, and interleaves a refresh with a write. It restarts Redis during a write job.
It checks the Devices stream of a second principal without `jobs:read`. It runs the retained-failure sequence of section 2.1 on the mock.
In that run the telemetry failure of B is `permission-denied` (section 8.3).
It records live write behavior as not verified.

## 10. Risks and open questions

### 10.1 Risks

| Risk                                                                                                                                                                                                                                    | Mitigation                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live write behavior is unverified. The Easton fixture has 0 devices and no write authorization.                                                                                                                                         | Tests use the mock only (eng-lead ruling 27). A live check needs another tenant and owner authorization.                                                                                                                                                                |
| Google's ChromeOS batch quota statement conflicts with the generic rule (findings 2.8).                                                                                                                                                 | Admission uses observed throttles only (`docs/reviews/2026-09-04-job-admission-policy.md:93`). Card Q1 records observed retries.                                                                                                                                        |
| A 250-part write batch exceeds the 10 s client timeout on Google (`libs/google-connection/src/lib/provider.ts:240`).                                                                                                                    | The parts become `unknown`, and read-back settles them. Card Q1 measures the latency. The write batch size is a setting.                                                                                                                                                |
| Google applies a request after its read-back. The operation then reads `failed` while the device holds the requested value.                                                                                                             | Read-back waits 30 s after the last unanswered request. No automatic resend follows. A later refresh read shows the real value in the grid.                                                                                                                             |
| A list that shows another administrator's newer value loses to a live overlay.                                                                                                                                                          | The next refresh read moves the overlay. Overlays expire after 36 hours.                                                                                                                                                                                                |
| A list carries no age. A write-path observation newer than the current-value stamp replaces a list value, even a newer one.                                                                                                             | Section 5.8 orders current observations only. The next refresh read corrects the row. A full sync corrects it after the overlay ends.                                                                                                                                   |
| Another administrator changes a device during the multipart round of a write. The write stamp falls after both changes, so the write wins.                                                                                              | The window is one round, and one request lasts at most 10 s (section 5.4). The next refresh read corrects the row.                                                                                                                                                      |
| Google normalizes a stored annotated location. A read-back then reports `value-differs` after a successful write.                                                                                                                       | Card Q1 compares write responses with requested values on the mock. Live parity stays unverified.                                                                                                                                                                       |
| A large full sync writes one target row per device. A daily Refresh all of 300,000 devices keeps about 2.1 million rows.                                                                                                                | Target rows stay narrow. The purge removes them with their job after 7 days.                                                                                                                                                                                            |
| An expired selection stays distinguishable for 24 hours after its expiry.                                                                                                                                                               | Later it reads as a selection never made, as the browsing record states today (`docs/workflows/device-browsing.md:141`).                                                                                                                                                |
| A refresh job that waits in the Kestra queue shows `running` (`deployment/kestra/entity-sync.yaml:3-6`).                                                                                                                                | This matches current refresh behavior. The application does not observe the Kestra queue.                                                                                                                                                                               |
| Smallest-first ordering starves a large job under constant small arrivals (`docs/reviews/2026-09-04-job-admission-policy.md:73`).                                                                                                       | Keep the owner ordering. Log the age of the oldest waiting job.                                                                                                                                                                                                         |
| The job service runs in one API process (`docs/portfolio/03-architecture.md:293`).                                                                                                                                                      | Postgres locks and the unique index still prevent a second running write job. A second instance needs qualification first (`docs/portfolio/03-architecture.md:67`).                                                                                                     |
| Redis is unavailable.                                                                                                                                                                                                                   | Admission fails closed. Running jobs continue. The hold expires by TTL. Publication rows wait for the relay (section 3.6). Device reads use Postgres (`api/src/app/devices/device-pager.ts:119-125`). Clients reread state when their streams reconnect.                |
| A concurrent administrator change is overwritten by a repeated write.                                                                                                                                                                   | Section 7.3. No precondition exists.                                                                                                                                                                                                                                    |
| A worker exit between a full-sync finish and its Redis rebuild leaves entries from before the sync.                                                                                                                                     | The sync changed the rows of those entries, so the entries fail the version check (section 5.11). Readers use Postgres until the next full sync rebuilds them (`worker/src/device-sync.ts:166-216`).                                                                    |
| Every hydrate runs one Postgres statement, also when every entry hits.                                                                                                                                                                  | The statement reads at most 1,000 IDs by primary key. The budget of section 5.11 bounds it. Card P3 measures it.                                                                                                                                                        |
| A Redis restart resets the query generation (`api/src/app/devices/device-pager.ts:218-220`). A page read that spans the restart stores its ID list under the generation that it read earlier. Later increments reach that number again. | Rows still pass the version check. The list expires 300 s after its store (`libs/application-contracts/src/lib/entity-cache.ts:27-28`). Its membership and order follow entity cache decision D2 (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:40-45`). |
| A database recreated under a running Redis restarts the versions. An old entry with an equal version then serves a record of the old database.                                                                                          | Development databases are disposable (`AGENTS.md:27-29`). Recreate Redis with Postgres. The local Redis keeps no data across a restart (`deployment/redis/runtime.mjs:40-41`).                                                                                          |
| A principal without `jobs:read` loses the failure sentences of syncs and refresh jobs that other people requested. This covers a retained telemetry failure of an earlier sync.                                                         | The visibility predicate requires it (sections 2.1 and 3.1). Battery cells keep `unavailable` for every reader. The single administrator of this slice holds `jobs:read`, so the banner stays unchanged.                                                                |
| A failed `forward` read on the Devices stream drops the failure fields of one event for one caller.                                                                                                                                     | The event still invalidates rows and counts. The stream then ends. The status read of the reopen returns the visible failures of that caller (section 3.1). No unchecked failure reaches the browser.                                                                   |
| The owner rejects a gated change (section "Owner decision gate").                                                                                                                                                                       | Only P1, B4, B5, and P3 build gated changes. B1, B2, B3, and B6 stay valid. The rejected change needs a new design revision. B4 keeps the `full-sync` projection in every case.                                                                                         |
| The relay runs in the API process. While the API is down, committed changes wait in publication rows.                                                                                                                                   | No stream exists while the API is down. Streams reopen with the API, and readers reread every resource (section 3.4). The tick then relays the waiting rows.                                                                                                            |
| A refresh job reaches the Jobs UI through the relay. Its `job-changed` arrives up to one relay period plus one run late.                                                                                                                | The Devices page keeps the direct refresh events (section 3.2). The bound of section 3.6 holds while the API, Postgres, and Redis run.                                                                                                                                  |
| A changed 016 function names a 017 object. A database without 017 fails at the first call of that function.                                                                                                                             | The runner applies every file in order, and readiness requires every file (`deployment/postgres/index.mjs:146-172`, `deployment/postgres/index.mjs:284-291`).                                                                                                           |
| Each edit of 016 invalidates every development database that applied an earlier 016 (`deployment/postgres/index.mjs:151-156`).                                                                                                          | Development databases are disposable (`AGENTS.md:27-29`). Developers recreate them.                                                                                                                                                                                     |

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

The eng-lead note of 2026-10-17 at 00:45 narrowed OQ9 after an inspection of frames `228:4524` and `231:4707`. Frame `228:4524` designs the line for a job without samples (section 2.5).
This revision inspected both captures. Cancel stays out of this slice, although frame `228:4524` shows "Cancel pending work".

Owner gate (section "Owner decision gate"):

- The main chat asks the owner about the D1, D6, D7, D9, D12, and D13 changes together with OQ9.
- Reviewer approval does not authorize those changes. The owner confirms them before the release PR merges and before cards P1, B4, B5, and P3 dispatch. The owner confirmed them on 2026-10-17.
- After the owner confirms, the main chat updates `docs/superpowers/specs/2026-10-06-entity-cache-decisions.md` in the release PR. This card changes only this design file.

The main chat ruled on OQ10 on 2026-10-17 at 03:10:

| ID   | Question                                                                                                                                 | Ruling                                                                                                                                                                                                                                                                                                                                          | Applied in                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| OQ10 | Does the owner gate also cover the record lines D1, D3, D6, D10, and D13? Does it cover the banner line of the device browsing workflow? | D1, D6, and D13 join the gate. P1, B4, and B5 carry the marks. D3 stays outside the gate: change 016 objects in 016, and put only new objects in new files. D10 stays outside the gate, and the release PR updates its record line. The banner omission follows default 15, and the release PR adds one sentence to the device browsing record. | Owner decision gate, 1.1, 9 |

- The ruling names B4 and B5 for D6 and D13 together. After Rev-5 F1, B4 publishes no event (section 3.2).
  B4 therefore builds the D6 part of the change: the API subscriber listens on the job channel for the Jobs stream. B4 stays gated by D6, D7, and D12.
- B5 builds the D6 publications and the D13 job path: the job service and the relay. P1 builds D1 and the D13 worker channel.
- The record lines: D1 at `docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:38`, D3 at `docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:50`, and D6 at `docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:76`.
  D10 is at `docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:99`, and D13 at `docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:122-123`.
  The banner line is `docs/workflows/device-browsing.md:155`. It moves to line 157 on origin/main (Conventions).

Open:

| ID  | Question                                                                                                                            | Owner of the answer |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| OQ8 | Do Prepend and Append in the next slice need an operation precondition before a repeat? Section 7.3 holds only for absolute values. | next slice design   |

The owner answered on 2026-10-17:

- OQ9: card F4 drafts each missing Latest activity sentence in the style of frames `104:209`, `228:4524`, and `231:4707`. The owner reviews the strings in the F4 PR.
- OQ2: the job detail is enough. The Devices grid shows no verification indicator in this slice.
- Permission labels: `devices:write` reads "Update devices", `devices:bulk-actions` reads "Run device bulk actions", and `jobs:read` reads "View jobs".
- Owner gate: the owner confirmed the D1, D6, D7, D9, D12, and D13 changes. The release PR records them in the entity cache decision record.
