# Design addendum: worker contracts for the device write jobs

Status: proposed, revision 2, 2026-10-19. Author: architect. Card: `t_ebb18941`.
This addendum extends the approved design `docs/superpowers/specs/2026-10-16-device-write-jobs-design.md`, revision 6.
It resolves the seven open questions and the four design notes of the P2 spec draft.
Card B2c builds its SQL changes. Card P2 builds the worker against its contracts.
The write-access card of ruling 5 builds the API part. Card B5 calls the changed read-back claim from its Reconcile route.
This addendum adds no product behavior, workflow, entity, or navigation destination.
It keeps every decision of `docs/superpowers/specs/2026-10-06-entity-cache-decisions.md` as the owner confirmed it.

Conventions:

- Every citation names a path and a line at origin/main `e48c8b8`. Branch `codex/device-write-worker-contracts` starts there.
- `design:N` names line N of the design file at `e48c8b8`.
- `draft:N` names line N of the P2 spec draft, the attachment `p2-spec-draft.md` of Kanban task `t_ebb18941`.
- `B3@603a10b:` names a file at commit `603a10b` of the unmerged branch `codex/device-update-preview`.
  That commit is an ancestor of the branch head `763f300` at revision 2. The head keeps `index.mjs`.
  In `017-jobs.sql` the head changes only the expiry check of the confirmation. The cited confirmation lines move down by seven.
- A bare migration file name, for example `017-jobs.sql`, names that file in `deployment/postgres/migrations/`.
- `index.mjs` names `deployment/postgres/index.mjs`.
- `device-write-jobs.integration.mjs` names `deployment/postgres/device-write-jobs.integration.mjs`.
- "Runtime role" names the application runtime role that `index.mjs:131-296` grants.
- Nothing is live. B2c changes `017-jobs.sql` in place, by owner direction (`AGENTS.md:23-28`) and design section 1.1 (`design:221-222`).
- "Scope failure" names the job failures `delegation-not-authorized` and `scope-mismatch` (`design:888`).

This record uses one name for each function:

| Name                  | Function                                                     |
| --------------------- | ------------------------------------------------------------ |
| The batch claim       | `cc.claim_device_update_batch`                               |
| The renewal           | `cc.renew_device_update_batch`                               |
| The release           | `cc.release_device_update_batch`                             |
| The settlement        | `cc.settle_device_update_operations`                         |
| The read-back claim   | `cc.claim_device_update_verification`                        |
| The verification read | `cc.read_device_update_verification`, new in ruling 1        |
| The preparation       | `cc.prepare_device_update_finish`                            |
| The final finish      | `cc.finish_device_update_job`                                |
| The reaper            | `cc.finalize_device_update_job`                              |
| The credential read   | `cc.google_current_generation`                               |
| The global lock       | Advisory lock `7240173008`, the global access lock of rule G |

Revision 2 answers review comment 313 on card `t_ebb18941`. The review of revision 1 raised three findings.
This record calls them Rev-1 F1 to Rev-1 F3.

| Finding    | Change                                                                                                                                          | Sections                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Rev-1 F1   | Every write settlement after the first stopping observation carries the job failure. The settlement that holds that observation is one of them. | Ruling 4, contract C3, B2c test 18, P2 edits 4, 15, 17, and 18                            |
| Rev-1 F2   | A `stopped` or `done` claim writes `heartbeat_at` and `first_claimed_at`. Revision 1 added no write.                                            | Ruling 7, contract C4, needs the eng-lead, B2c tests 19 to 23, P2 edits 9, 15, 17, and 18 |
| Rev-1 F3   | S3 exempts the read-back claim beside the read-back settlement. Both keep their attempt and lease fences.                                       | S3, B2c test 5                                                                            |
| Correction | No existing B2 check claims a running job with a recorded failure. The B2c section therefore names no changed expectation.                      | Changes for card B2c                                                                      |
| Citation   | The B3 branch head moved to `763f300`. The pin `603a10b` stays.                                                                                 | Conventions                                                                               |

## Lock rules

B2 states its serialization rules in code comments and tests only.
The B2 round 6 tests name S1, S2, and S3 (`device-write-jobs.integration.mjs:4341-4343`).
The B2b round 3 tests name rule G (`device-write-jobs.integration.mjs:6066-6069`).
This section states each rule as the code applies it. Every ruling below follows these rules.

### S1. Lock order, and fresh reads after each wait

1. Among job rows, the customer-scoped job header locks first (`017-jobs.sql:495`, `017-jobs.sql:767`, `017-jobs.sql:1055-1057`).
   A full-sync path locks the sync state row before the header (`016-device-inventory.sql:190-192`, `016-device-inventory.sql:248`, `017-jobs.sql:1373-1375`).
2. Descendant rows lock after the header. Only the rows that the call changes lock (`017-jobs.sql:674-678`, `017-jobs.sql:1071-1073`).
   The batch row locks before the operation rows. Operation rows lock in `operation_number` order (`017-jobs.sql:658-665`, `017-jobs.sql:917-921`).
3. The batch claim and the settlement lock the detail row after their operation rows (`017-jobs.sql:680-682`, `017-jobs.sql:922`).
   A refused start locks the detail row before its pending operation rows (`017-jobs.sql:542-553`). Each call holds the header first, so the two orders form no cycle.
4. A function that inserts a publication or overlay row locks the connection row `FOR KEY SHARE`.
   That lock precedes the insert and every device row (`017-jobs.sql:445-449`, `017-jobs.sql:939-943`).
   The credential read locks the connection row `FOR UPDATE`. In the batch claim it is the last row lock (`017-jobs.sql:689-691`).
5. Device rows lock in `device_id` order after the operation rows. Overlay rows lock in `device_id` order after the device rows (`017-jobs.sql:944-962`).
6. The clock reads after the header lock and again after every later wait. The token, the lease, and the revalidation repeat on fresh reads before any write.
   Sources: `017-jobs.sql:438-440`, `017-jobs.sql:644-645`, `017-jobs.sql:680-681`, `017-jobs.sql:923-925`, `017-jobs.sql:963-964`, and `016-device-inventory.sql:308-311`.

### S2. Null and invalid inputs

- A null customer, job, token, attempt, or batch never matches a fence (`017-jobs.sql:486-489`, `017-jobs.sql:646-650`, `017-jobs.sql:763-766`).
- A call rejects every other input outside its domain before its first lock. Examples are a null kind and a null execution.
  No cast or CHECK then fails after a lock.
  Sources: `017-jobs.sql:427-431`, `017-jobs.sql:631-635`, `017-jobs.sql:850-888`, `017-jobs.sql:1045-1054`, and `017-jobs.sql:1098-1102`.

### S3. A terminal or superseded call changes nothing

- A call on a terminal job changes no outcome, counter, metadata, lease, or publication row.
  The same holds for a call with a token or attempt that is not current.
  Sources: `017-jobs.sql:504-508`, `017-jobs.sql:537-541`, `017-jobs.sql:821-825`, `017-jobs.sql:1110-1116`, `017-jobs.sql:1167-1173`, and `016-device-inventory.sql:830-834`.
- A call that a wait superseded also changes nothing. It reads the token again after the wait (`017-jobs.sql:699-711`, `017-jobs.sql:1185-1193`).
- Read-back is the one exception, by design (`design:997`, `design:1052`, `design:1431`). Its two functions check no token and no job status.
  Each of them acts on a terminal job:
  - The read-back claim takes only `unknown` operations without a live read-back lease. It sets their read-back attempt and lease (`017-jobs.sql:1064-1067`, `017-jobs.sql:1078-1083`).
    The check at `device-write-jobs.integration.mjs:1119-1131` claims a read-back after the final finish answers `needs-review`.
  - The read-back settlement takes only `unknown` operations of its attempt under a live read-back lease (`017-jobs.sql:896-901`, `017-jobs.sql:912-913`, `017-jobs.sql:976-977`).
    On a terminal job it derives the status again (`017-jobs.sql:1027-1028`).
  - A call outside those attempt and lease fences changes nothing. No ruling below adds a terminal-job rejection to either function.

### Rule G. The global lock comes first

- Advisory lock `7240173008` is the global access lock. Every function that can reach it takes it first, before any row lock and any other advisory lock (`device-write-jobs.integration.mjs:6066-6069`).
- A function reaches it through the credential read (`015-restore-revalidation.sql:13-26`).
  The credential read calls `cc.google_bound_generation`, which takes the global lock and then the connection row `FOR UPDATE` (`011-google-credential-lifecycle.sql:16-21`).
- The batch claim, the full-sync claim, and the full-sync finish take the global lock first (`017-jobs.sql:636-638`, `016-device-inventory.sql:284-287`, `016-device-inventory.sql:605-608`).
- `cc.read_entity_sync_batch` takes no row lock before its credential read (`016-device-inventory.sql:794-798`).

### Rule W. The worker holds no lock between calls

- Rule W follows from rule G. The draft states it for P2 (`draft:111`).
- The worker calls each function as its own autocommit statement. It opens no transaction around calls.
- A transaction that spans two calls keeps the row locks of the first call.
  The second call then waits for the global lock with those row locks held. Rule G forbids that order.

## Rulings

Each ruling answers one item of `draft:7-20`. Rulings 1 to 7 answer open questions 1 to 7. Rulings 8 to 11 answer design notes 1 to 4.

### Ruling 1. The credential envelope of a read-back outside a batch claim

Open question 1 (`draft:7`).

Decision:

- B2c adds the verification read. It returns the envelope of the job generation.
  It also returns the listed operations that one attempt holds under a live read-back lease.
- The worker calls it before the GET parts of read-back places 3 and 4 (`design:1051-1052`).
  These places are the finish and the reconcile flow.
- Places 1 and 2 keep the envelope of their batch claim (`017-jobs.sql:750-754`).

Design support:

- Read-back sends GET parts with the read-only inventory token (`design:1034`, `design:907-908`).
  The worker opens the envelope and mints that token, as refresh batches do (`worker/src/entity-sync.ts:164-180`).
- Every new function is `SECURITY DEFINER`. The runtime role receives `EXECUTE` on it and `SELECT` on new tables only (`design:430-434`).
- The runtime role holds no grant on `cc.google_credentials` (`index.mjs:131-296`).
- The batch claim releases the envelope only to the attempt that holds the batch (`017-jobs.sql:750-754`). The verification read applies the same rule to read-back attempts.

Contract C2, the verification read:

| Item             | Contract                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Function         | `cc.read_device_update_verification(p_customer text, p_job uuid, p_attempt uuid, p_operations jsonb) RETURNS jsonb`. New in `017-jobs.sql`. `SECURITY DEFINER` with `search_path=pg_catalog,cc`.                                                                         |
| Caller and check | The worker only. Each handler first passes the dispatch secret, the JSON content type, and the `executionId` rule (`worker/src/dispatch.ts:141-164`). The attempt is the attempt of the worker request, or the `verifyAttempt` of the reconcile flow (ruling 2).         |
| Fence            | The envelope leaves only when the attempt holds a listed `unknown` operation of the job under a live read-back lease.                                                                                                                                                    |
| Grants           | Revoke it from `PUBLIC` in the revoke list of `017-jobs.sql:1453-1470`. Grant `EXECUTE` to the runtime role in the 017 block of `index.mjs:277-295`.                                                                                                                     |
| Lock order       | 1. The S2 checks. 2. The global lock. 3. The header read without a lock. 4. The clock and the held operations, read without a lock. 5. The credential read, which locks the connection row `FOR UPDATE`. 6. The clock and the held operations again. No other row locks. |
| Return           | `{outcome:'held', checkedAt, generation, credentialId, envelope, operations}`. Each operation holds `operationNumber`, `deviceId`, `serialNumber`, `baselineValue`, `requestedValue`, `verifyAfter`, and `verifyLeaseExpiresAt`, in `operation_number` order.            |
| Return, no hold  | `{outcome:'not-held'}` when the attempt holds no listed operation under a live lease. This answer reads no credential.                                                                                                                                                   |
| Errors           | 22023 "The verification read is invalid." for a null input and for an invalid list. A valid list holds 1 to 250 elements, and each element is a whole number from 1. 22023 "The device update job does not exist." for a missing header or a refresh job.                |
| Credential error | The credential read raises P0001 with detail `credential-changed`, `connection-disconnected`, or `restore-revalidation-required` (`011-google-credential-lifecycle.sql:22-24`, `015-restore-revalidation.sql:18-23`).                                                    |

Lock rules check:

- S1: the verification read locks no job, batch, operation, or detail row. The connection row is its only row lock. The clock reads after the global-lock wait and after the connection wait.
- S2: every input check precedes the global lock.
- S3: it changes no row. A lease that lapses after the read leaves the later settlement fenced (`017-jobs.sql:934-935`, `017-jobs.sql:976-977`).
- Rule G: the global lock is its first lock.

Worker use: a credential error settles each operation of the chunk as `unknown` with `verification-failed` (`design:1045`).

Rejected alternatives:

- Return the envelope from the read-back claim. The API Reconcile route also calls that claim and needs no credential (`design:651`).
  Every Reconcile then waits for the global lock. A credential change then raises an error in the route, and section 2.6 defines no such answer.
- Use `cc.acquire_google_access` (`008-google-token-coordination.sql:47-73`). It leases the shared token of the connection scopes for the token coordinator (`libs/google-connection/src/lib/coordinator.ts:118`).
  Read-back needs a token for the inventory scope alone (`design:904-908`).
- Use `cc.read_entity_sync_batch`. It reads refresh jobs only (`016-device-inventory.sql:794-797`).
- Use the batch claim. The reconcile flow carries no dispatch token (`deployment/kestra/device-update-reconcile.yaml:29-36`). A terminal job answers `superseded` (`017-jobs.sql:647-650`).
- Grant `SELECT` on `cc.google_credentials`. Owner direction keeps credential protection in place (`AGENTS.md:32`).
  The runtime role holds no grant on that table today (`index.mjs:131-296`).

### Ruling 2. The device ID and requested value of one Reconcile operation

Open question 2 (`draft:8`).

Decision:

- The reconcile handler calls the verification read with the `verifyAttempt` of the flow and a list of one operation number.
- The answer `held` gives the device ID, the requested value, `verifyAfter`, and the envelope in one snapshot. The worker starts no GET before `verifyAfter` (`design:1038`).
- The answer `not-held` means that the claim of the API lapsed or settled. The handler sends nothing and answers 200 with outcome `not-held`.
- The handler checks that `operationNumber` is a whole number from 1 and that `verifyAttempt` is a UUID. The value `all` follows ruling 3.
- Ruling 2 needs no SQL change beyond ruling 1.

Design support: the API claims the operation (`design:651`).
It starts the flow with the job, the operation number, and the attempt (`design:652`).
The flow carries those inputs (`design:925`). The worker reads the device with GET (`design:654`). A failed start leaves the claim to expire (`design:653`).

Rejected alternatives:

- A direct `SELECT` on `cc.device_update_operations` (`index.mjs:275`). The worker still needs ruling 1 for the envelope.
  Two reads see two snapshots, and the lease can lapse between them. The lease check then lives in worker code.
- A second claim with the same attempt. The read-back claim treats a live reservation as not eligible (`017-jobs.sql:1061-1067`). A change to that rule weakens the fence for every caller.
- The device ID and the value as flow inputs. The flow contract of card P1 changes (`deployment/kestra/device-update-reconcile.yaml:5-19`).
  The worker then trusts Kestra inputs as the target of a Google read.

### Ruling 3. Read-back claims of 250 operations

Open question 3 (`draft:9`).

Decision:

- B2c changes the read-back claim to take a cursor and a limit.
- A finish request and a reconcile request for `all` claim the next 250 eligible operations after the cursor.
  The cursor is the highest operation number of the previous chunk. A pass ends at an empty claim.
- One request uses one attempt for every chunk, as the term "Attempt" defines it (`design:35`).
- Each pass reads each operation at most once. An operation that fails read-back stays `unknown` for a later Reconcile.
- Each chunk settles at most 250 results, inside the settlement limit of 1,000 (`draft:56`, `017-jobs.sql:266-269`).

Contract C1, the read-back claim:

| Item            | Contract                                                                                                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Function        | `cc.claim_device_update_verification(p_customer text, p_job uuid, p_operations jsonb, p_attempt uuid, p_after integer DEFAULT NULL, p_limit integer DEFAULT NULL) RETURNS jsonb`. Changed in place in `017-jobs.sql`.                                                                    |
| Change          | The candidate set under the header lock (`017-jobs.sql:1064-1067`) also requires `operation_number > p_after` when `p_after` is set. It keeps the first `p_limit` candidates in `operation_number` order. A null limit keeps every candidate, as today.                                  |
| Caller, worker  | The finish handler and the reconcile handler for `all`, after the dispatch checks (`worker/src/dispatch.ts:141-164`). The worker passes a null list, its attempt, the cursor, and 250.                                                                                                   |
| Caller, API     | The Reconcile route of card B5, after its check of `jobs:read` and `devices:write` (`design:469`). The route passes one operation number and a new attempt, with no cursor and no limit.                                                                                                 |
| Grants          | Replace the signature in `index.mjs:289` and in the revoke list at `017-jobs.sql:1466`.                                                                                                                                                                                                  |
| Lock order      | Unchanged. 1. The S2 checks. 2. The header `FOR UPDATE` (`017-jobs.sql:1057`). 3. The clock (`017-jobs.sql:1063`). 4. The candidates under the header. 5. The candidate operation rows only, in `operation_number` order (`017-jobs.sql:1072-1073`). 6. The clock (`017-jobs.sql:1076`). |
| Lock order, end | 7. The update of the locked candidates that stay eligible (`017-jobs.sql:1078-1083`). The claim reaches no credential read, so rule G does not apply.                                                                                                                                    |
| Return          | Unchanged: an array of `{operationNumber, deviceId, serialNumber, baselineValue, requestedValue, verifyAfter}`.                                                                                                                                                                          |
| Errors          | 22023 "The read-back claim is invalid." also covers a negative `p_after` and a `p_limit` outside 1 to 250. Both checks precede any lock. Other answers stay unchanged.                                                                                                                   |

Rejected alternatives:

- A direct `SELECT` of the `unknown` operation numbers. It copies the eligibility rule out of the claim, and the worker then depends on the table layout.
  The claim checks eligibility again under its locks, so the read adds a statement and no fence.
- One claim of every operation (`017-jobs.sql:1064-1082`). One lease of 120 s cannot cover a large set (`design:1037`).
- Claims by ranges of operation numbers. A job of 100,000 operations needs 400 header locks per pass.
  The finish request also carries no target count (`deployment/kestra/device-update.yaml:60-67`).
- A limit without a cursor. A failed read-back clears the lease of its operation (`017-jobs.sql:987-991`). The next claim then takes the same operation, and the pass never ends.
- A new claim function for chunks. It copies the claim and its fence. Two functions then hold one eligibility rule.

### Ruling 4. The job failure of section 7.2 during a batch

Open question 4 (`draft:10`).

Decision:

- B2c adds an optional failure to the settlement (contract C3). A write settlement with a failure records it as the job failure, in the transaction of its outcomes.
- From its first stopping observation on, the worker passes the failure on every write settlement of the batch.
  The settlement that holds the observed operations is one of them. The job failure therefore commits with its first evidence.
- The settlement that holds the observed operations depends on the kind of the observation:
  - An answer of kind `auth`: the settlement of its round. The service reports the answer before the round ends (`libs/google-connection/src/lib/batch.ts:929-939`, `batch.ts:704`).
  - A mint failure: the settlement after the call returns. The service fails the waiting requests without an event (`batch.ts:630-641`).
  - A fatal batch error: the settlement from the kept events after the call throws (`batch.ts:596`, `draft:58`).
  - A credential that cannot open: the one settlement before any request (`design:1357`).
- The batch call still runs to its end. An answer of kind `auth` stops the job only after its batch settles (`design:1352`).
  Each later round settlement carries the same failure. `COALESCE` keeps the first failure, so a repeat changes nothing.
- B2c changes the batch claim (contract C4). A recorded job failure is a stop reason.
  A later claim answers `stopped` with that failure. It skips every pending operation of the job with that reason and sends nothing.
- B2c changes the preparation and the reaper (contract C5). Each skips pending operations with the recorded job failure as the reason, or `interrupted` without one (`design:1143`).
- The finish request still carries no failure (`deployment/kestra/device-update.yaml:60-67`). The final finish keeps the recorded failure (`017-jobs.sql:1198-1200`).
- After the stop, the batch handler answers 200 with outcome `stopped` and the failure.

A worker exit between two settlements keeps the stop (Rev-1 F1):

- The failure commits with the first settlement that holds a stopping observation. A later exit leaves it in place.
- Kestra sends the request again after a failed worker request (`design:920`, `deployment/kestra/device-update.yaml:48-52`).
  The new claim answers `stopped`, because C4 decides the stop before the busy check (`017-jobs.sql:655-664`).
- The exited attempt leaves its unsettled operations `dispatched`. The preparation answers `busy` until their lease and its grace end (`017-jobs.sql:1117-1120`).
  It then fences them to `unknown` (`017-jobs.sql:1140`), and finish step 5 reads them back.

Design support:

- A mint failure, a part answer of kind `auth`, and a fatal batch error stop the job. Later batches send nothing (`design:1346-1356`).
- `dispatched` becomes `skipped` through the write settlement when the job stops (`design:1012`).
- `pending` becomes `skipped` through a `stopped` claim, the finish, or the reaper (`design:1014`).
- A credential that cannot open gives `key-unavailable` before any request (`design:1357`). The batch then settles every claimed operation as `skipped` with that failure.

Contract C3, the settlement:

| Item             | Contract                                                                                                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Function         | `cc.settle_device_update_operations(p_customer text, p_job uuid, p_token uuid, p_attempt uuid, p_kind text, p_results jsonb, p_observed_at timestamptz, p_failure text DEFAULT NULL) RETURNS jsonb`. Changed in place in `017-jobs.sql`.                                           |
| Change           | After the settled set proves non-empty (`017-jobs.sql:1022-1024`), a failure sets `failure=COALESCE(failure,p_failure)` on the header. That write precedes the counters and the job change (`017-jobs.sql:1026-1033`). A fenced call and an empty call record no failure.          |
| Caller and check | The batch handler of the worker. It passes the dispatch token of the flow body (`deployment/kestra/device-update.yaml:32-40`) and its own attempt. It passes the failure on every write settlement after the first stopping observation.                                           |
| Grants           | Replace the signature in `index.mjs:288` and in the revoke list at `017-jobs.sql:1465`.                                                                                                                                                                                            |
| Lock order       | Unchanged. 1. The S2 checks (`017-jobs.sql:850-888`). 2. The header (`017-jobs.sql:889`). 3. The eligible operation rows in `operation_number` order (`017-jobs.sql:920-921`). 4. The detail row (`017-jobs.sql:922`). 5. The connection row `FOR KEY SHARE` (`017-jobs.sql:943`). |
| Lock order, end  | 6. Device rows (`017-jobs.sql:948-954`). 7. Overlay rows (`017-jobs.sql:958-962`). 8. The clock (`017-jobs.sql:964`). The failure write changes only the header row, which the call holds from step 2. Rule G does not apply.                                                      |
| Return           | Unchanged. The failure write precedes the job change, so the revision of the publication element includes the failure.                                                                                                                                                             |
| Errors           | 22023 "The settlement is invalid." also covers a failure outside `cc.job_failure_known` (`017-jobs.sql:411-419`). It also covers a failure with kind `read-back`. Both checks precede any lock. Other answers stay unchanged.                                                      |

Contract C4, the batch claim:

| Item                  | Contract                                                                                                                                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Function              | `cc.claim_device_update_batch(text,uuid,uuid,integer,uuid,text)`. The signature stays.                                                                                                                                                                                                                                     |
| Change 1, ruling 4    | The first stop decision under the header lock (`017-jobs.sql:655-656`) takes the recorded job failure before the revalidation reason. A job with a failure then enters the stop path at once (`017-jobs.sql:698-717`).                                                                                                     |
| Change 2, ruling 7    | A `stopped` or `done` answer writes `heartbeat_at` and `first_claimed_at=COALESCE(first_claimed_at,now_at)`, as a `claimed` answer does (`017-jobs.sql:738-739`). `now_at` is the clock after the last wait of the path. A `superseded` or `busy` answer writes nothing.                                                   |
| Caller and check      | The batch handler of the worker, as today.                                                                                                                                                                                                                                                                                 |
| Grants                | Unchanged (`index.mjs:285`).                                                                                                                                                                                                                                                                                               |
| Lock order, start     | Unchanged. 1. The S2 check (`017-jobs.sql:631-635`). 2. The global lock (`017-jobs.sql:638`). 3. The header (`017-jobs.sql:639`). 4. The clock and the fence. A terminal job or a token that is not current answers `superseded` (`017-jobs.sql:645-650`).                                                                 |
| Lock order, `stopped` | 5. The pending operation rows of the job in `operation_number` order (`017-jobs.sql:704-705`). 6. New: the detail row `FOR UPDATE`, in place of the read at `017-jobs.sql:708`. 7. The connection row `FOR KEY SHARE` (`017-jobs.sql:706`). 8. The clock, and the token on the locked detail row (`017-jobs.sql:707-711`). |
| Writes, `stopped`     | The failure, the skip, the counters, and the progress row stay (`017-jobs.sql:712-715`). The heartbeat write of change 2 joins them.                                                                                                                                                                                       |
| Lock order, `done`    | 5. The batch row (`017-jobs.sql:665`). 6. No operation row matches (`017-jobs.sql:676-679`). 7. New: the detail row `FOR UPDATE`. 8. New: the clock, and the token on the locked detail row. A token that is not current answers `superseded` and writes nothing.                                                          |
| Lock order, `claimed` | Unchanged (`017-jobs.sql:658-749`). The second `done` site (`017-jobs.sql:731-732`) holds the detail row from `017-jobs.sql:682` and the clock from `017-jobs.sql:696`. It writes the two columns before it answers.                                                                                                       |
| Return                | Unchanged: `{outcome:'stopped', failure}`, `{outcome:'done'}`, and the other answers.                                                                                                                                                                                                                                      |
| Errors and S3         | Unchanged. A token that is not current still answers `superseded` before the stop decision (`017-jobs.sql:647-650`). A token that changes in a later wait answers `superseded` after that wait and writes nothing.                                                                                                         |

Lock rules check of C4:

- S1: every 017 function that locks or updates a detail row holds its header first. The new detail lock therefore waits on no other 017 function.
  Sources: `017-jobs.sql:434-435` with `017-jobs.sql:464`, `017-jobs.sql:496` with `017-jobs.sql:511`, and `017-jobs.sql:530` with `017-jobs.sql:543`.
  More sources: `017-jobs.sql:573-574` with `017-jobs.sql:584` and `017-jobs.sql:600`, `017-jobs.sql:639` with `017-jobs.sql:682`, and `017-jobs.sql:768` with `017-jobs.sql:792`.
  More sources: `017-jobs.sql:889` with `017-jobs.sql:922`, `017-jobs.sql:1280` with `017-jobs.sql:1298`, and `017-jobs.sql:1329-1330` with `017-jobs.sql:1343`. B3 at `603a10b` adds no detail lock.
- S1: the clock reads after the last lock of each path. A test session that holds the detail row delays the call, and the stamp still follows that wait.
- S1: the stop path keeps the connection row as its last lock (`017-jobs.sql:699-703`). Its detail row locks between the operation rows and the connection row.
  The claim path (`017-jobs.sql:676-691`) and the settlement (`017-jobs.sql:920-943`) use the same order.
- S1: a stop that the second revalidation finds already holds the detail row (`017-jobs.sql:682`, `017-jobs.sql:686-694`). The new lock then adds no wait.
- S2: unchanged.
- S3: each new write follows the token check on the locked detail row. A terminal call and a superseded call write nothing.
- Rule G: the global lock stays the first lock. The new lock is a row lock after it.

Contract C5, the preparation and the reaper:

| Item                   | Contract                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Functions              | `cc.prepare_device_update_finish(text,uuid,uuid,text)` and `cc.finalize_device_update_job(text,uuid,text)`. The signatures stay.                             |
| Change                 | The skip reason becomes the job failure after the failure update, or `interrupted` without one (`017-jobs.sql:1137-1141`, `017-jobs.sql:1252-1256`).         |
| Callers                | The finish handler of the worker calls the preparation. The tick of card B5 reaches the reaper through `cc.recover_device_update_jobs` (`017-jobs.sql:613`). |
| Lock order             | Unchanged. The reason reads the header row that each call holds from its first lock (`017-jobs.sql:1103`, `017-jobs.sql:1224`).                              |
| Return, errors, grants | Unchanged.                                                                                                                                                   |

Each later `stopped` claim records one progress-only row, as a revalidation stop does today. The relay publishes such rows once per job and run (`design:743`).
Each `stopped` claim also writes `heartbeat_at` (ruling 7).

Rejected alternatives:

- The failure on the last write settlement of the batch only (revision 1). A batch of several rounds settles each round in its own call (`draft:54`, ruling 11).
  An exit after a stopping round and before the last settlement then loses the stop.
  A later claim returns only `pending` operations and the `dispatched` operations of a lapsed attempt (`017-jobs.sql:676-679`, `017-jobs.sql:718-754`).
  No call then reads the settled failure again, and the next batch claims and sends.
- The release, then the preparation with the failure (`draft:10`). The stop then commits after the outcomes, in a third transaction.
  A worker exit between the commits loses the stop, and the next batch claims and sends. The preparation also answers `busy` while any batch lease or its grace lives (`017-jobs.sql:1117-1120`).
- A new stop function. It adds a third writer of the job failure with its own fence and lock order. The settlement already holds the header lock and the attempt fence that a stop needs.
- A failure field in the finish request. The flow body carries none (`deployment/kestra/device-update.yaml:60-67`). Later batches still claim and send before the finish.
- The skip inside the settlement. The settlement then locks every pending operation of the job beside its candidates.
  Its lock set under S1 item 2 grows.
  The `stopped` claim already skips those operations.

### Ruling 5. Write access `denied` from a worker observation

Open question 5 (`draft:11`).

Decision by card:

- B6 runs as written. It builds the check of section 4.2 and its cache of 300 s (`design:871-888`).
  It also builds the routes of section 2.7 (`design:660-663`, `design:1731-1732`).
- P2 records the observation as the job failure through ruling 4. P2 writes no write-access state and no API cache.
- The write-access card, a later backend card on top of B6, derives `denied` in the API from that job failure.
  It reads `cc.jobs` through the existing `SELECT` grant (`index.mjs:273`). It adds no table, column, or function.

The rule that the write-access card adds on top of B6:

1. Before each check, the API counts the write jobs with a scope failure. The count covers the customer and the generation of the check.
   The API stores that count with the cached result.
2. Each read of the state counts again. A higher count proves a scope failure that committed after the check began.
3. The API then replaces the cached result with state `denied`. `failure` is the scope failure of the counted job with the latest `changed_at` (`017-jobs.sql:270`).
   `checkedAt` is the time of that read.
   The new count replaces the stored count, and the window of 300 s starts again.
4. Without a cached result, the state stays `unchecked` until the check of B6 runs (`design:881`).
5. A recheck stores a new count. The result of Google then wins over every earlier scope failure.
6. The state names only the scope failure code, as a check names it. It names no job, display ID, or requester (`design:479-480`).

Why a higher count proves a newer failure:

- Write jobs never leave Postgres. The purge deletes refresh headers only (`017-jobs.sql:1417-1431`, `design:416`).
- A write job keeps its first failure. Every failure write on a write job uses `COALESCE`, and so does ruling 4.
  Sources: `017-jobs.sql:712`, `017-jobs.sql:1138`, `017-jobs.sql:1199`, and `017-jobs.sql:1253`.
- The direct write at `017-jobs.sql:556` runs only for a job without a first claim (`017-jobs.sql:538-541`). A scope failure needs a claimed batch, so that write never replaces one.
- The set of write jobs with a scope failure therefore only grows. A higher count means a new member.

Timing: the first read after the commit of the stopping settlement returns `denied`. That meets "at once" in section 4.2 (`design:888`).
Card F1 reads the state for its disabled reasons (`design:1759`).

Tests of the write-access card:

- A scope failure that commits after a `granted` check gives `denied` on the next read, without a recheck.
- A `network-failure` job failure leaves the state unchanged (`design:1351`).
- A recheck after the failure returns `granted` when the mock grants the scope again (`design:1385`).
- A scope failure of an earlier connection generation leaves the state unchanged.
- The tests set the job failure through the preparation, which accepts a failure on origin/main (`017-jobs.sql:1137-1139`). The write-access card therefore waits for no P2 code.

Rejected alternatives:

- The worker writes the API cache. The worker has no path to the API process. The flows dispatch to the worker only (`design:917-925`).
- A Redis key or a new channel event. The worker Redis rule names no write-access key (`deployment/redis/runtime.mjs:12-14`).
  `jobEventSchema` has one member (`design:538`). Either path adds a contract.
- A table or a column for the state or for a failure time. The count rule needs neither. A new column needs the eng-lead.
- A comparison of `finished_at` with `checkedAt`. `finished_at` comes after the read-back of finish step 5.
  A recheck between the stop and the finish then loses to an older observation.
- The job service applies the failure on `job-changed`. Its memory of applied failures ends with the process. A relayed event of an old failure then denies after a newer recheck.

### Ruling 6. The publication element of the finish

Open question 6 (`draft:12`).

Decision: B2c changes the final finish to return the publication element of its row. The worker publishes that row at once and completes it, as section 3.6 states (`design:814-819`).

Contract C6, the final finish:

| Item             | Contract                                                                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Function         | `cc.finish_device_update_job(text,uuid,uuid,text)`. The signature stays.                                                                                                                                                                                       |
| Change           | The call keeps the element that `cc.record_job_change` returns (`017-jobs.sql:277`, `017-jobs.sql:1204`). Its terminal answer adds that element as `publication` (`017-jobs.sql:1205-1210`).                                                                   |
| Caller and check | The finish handler of the worker, with the dispatch token of the finish body (`deployment/kestra/device-update.yaml:60-67`).                                                                                                                                   |
| Grants           | Unchanged (`index.mjs:291`).                                                                                                                                                                                                                                   |
| Lock order       | Unchanged. 1. The S2 failure check (`017-jobs.sql:1157-1159`). 2. The header (`017-jobs.sql:1160`). 3. The clock (`017-jobs.sql:1166`). 4. The token and grace fences (`017-jobs.sql:1168-1183`). 5. The connection row `FOR KEY SHARE` (`017-jobs.sql:1188`). |
| Lock order, end  | 6. The clock and the fences again (`017-jobs.sql:1189-1197`). Rule G does not apply.                                                                                                                                                                           |
| Return           | The terminal answer adds `publication`, with the shape of `cc.job_publication_element` (`017-jobs.sql:250-257`). Its `statusChanged` is true, because `cc.device_update_terminal_status` returns only a terminal status.                                       |
| Other answers    | `superseded`, `finished`, `busy`, and `not-prepared` record no row and carry no element.                                                                                                                                                                       |
| Errors           | Unchanged.                                                                                                                                                                                                                                                     |

Design support: the worker publishes the row of a finish (`design:731`). A publisher publishes a status change at once (`design:735`).
The caller of the final finish publishes its row (`design:1154-1155`). The settlement already returns its element (`017-jobs.sql:1033-1035`, `design:999`).

Rejected alternatives:

- The relay path. It adds 5 s of grace and one relay period (`design:833`). Section 3.2 names the worker as the publisher of this row.
- A direct `SELECT` on `cc.job_publications` (`index.mjs:276`). The worker then rebuilds `cc.job_publication_element` outside SQL.
  It also picks the row of its own call among the other rows of the job.

### Ruling 7. `heartbeat_at` on every worker call

Open question 7 (`draft:13`).

Decision:

- B2c changes the batch claim (contract C4, change 2). A `stopped` or `done` answer writes `heartbeat_at`, as a `claimed` answer does (`017-jobs.sql:738-739`).
- The same answers set `first_claimed_at` when it is null. `started_at` keeps its rule: the first `claimed` answer sets it (`017-jobs.sql:742-744`).
- A `busy` answer and a `superseded` answer write nothing.
- P2 makes no separate heartbeat call. Every batch request starts with a claim.
  Each Kestra iteration therefore writes `heartbeat_at`, unless its claim answers `busy` or `superseded`.
- P2 bounds each read-back chunk by its lease. The worker aborts the GET parts of a chunk 15 s before the lease ends.
  Every part without an answer then settles as `unknown` with `verification-failed`.
- The margin covers one request of 10 s (`libs/google-connection/src/lib/provider.ts:241`) and one statement of 5 s (`worker/src/google-connection.ts:105`).
- This addendum replaces the list of `design:960`. `heartbeat_at` records every current-token claim except `busy`.
  It also records every renewal and every settlement with a result (`017-jobs.sql:799`, `017-jobs.sql:1032`).

Why `stopped` and `done` claims need the write (Rev-1 F2):

- Kestra runs every iteration of the `ForEach` and reads only the HTTP status of each answer (`deployment/kestra/device-update.yaml:18-52`, `design:920`).
- After a stop, every later iteration answers `stopped` and holds no lease (`017-jobs.sql:698-716`). Ruling 10 released the lease of the stopping batch.
- A job of 100,000 targets is valid (`design:267`). Confirmation writes batches of 250 (`B3@603a10b:deployment/postgres/migrations/017-jobs.sql:1587-1588`).
  That job holds 400 batches. At more than 1.51 s per iteration, its 399 `stopped` iterations take more than 600 s.
- On origin/main a `stopped` claim writes no `heartbeat_at`. The tick then rotates the token of the live execution (`017-jobs.sql:596-610`).
  Every later call of that execution answers `superseded`, its finish included (`017-jobs.sql:1111-1113`). A revalidation stop meets the same gap today.
- A `done` sequence meets the same gap. After a rotation, the new execution claims every settled batch again, and each claim answers `done` (`017-jobs.sql:676-679`).
- A `stopped` first claim leaves `first_claimed_at` null on origin/main. After the start deadline, the tick treats the live execution as an unclaimed start (`017-jobs.sql:580-592`).
  At three executions the refused-start path replaces the recorded failure with `orchestration-unavailable` (`017-jobs.sql:594`, `017-jobs.sql:556`).

Why the tick never declares a live execution lost:

- Before the first claim, the tick acts on the start deadline of 120 s (`017-jobs.sql:580`).
  After the first claim, it acts only without a live batch lease and with `heartbeat_at` 10 minutes old (`017-jobs.sql:596-597`, `design:952`).
- A `claimed`, `stopped`, or `done` answer writes `heartbeat_at` and `first_claimed_at`.
  Every iteration of the current execution therefore refreshes the heartbeat at its start, unless its claim answers `busy`.
- A `busy` answer means that a lease or its grace of 30 s lives (`017-jobs.sql:661-663`, `017-jobs.sql:668-671`).
  The holder writes `heartbeat_at` with each claim and each renewal. The lease runs 180 s from that write (`017-jobs.sql:735-738`, `017-jobs.sql:797-799`).
  When the grace ends, the last write is at most 210 s old. The next poll follows within 10 s (`design:968`) and writes.
- Inside a claimed batch, the worker renews every 30 s (`design:982`). A read-back of place 1 or 2 settles within its lease of 120 s (`017-jobs.sql:719-722`, `017-jobs.sql:987-991`).
- In finish step 5 no batch lease lives. Each chunk settles within its lease of 120 s, and each settlement with a result writes `heartbeat_at` (`017-jobs.sql:1032`).
  A preparation that polled `busy` answers `ready` at most 220 s after the last write. The first chunk then settles within 340 s of that write.
- 340 s stays under the limit of 600 s. A store failure ends the request with a non-2xx answer, and Kestra retries the request (`design:920`).

Rejected alternatives:

- No write on `stopped` and `done` claims (revision 1). The sequences above then rotate a live execution.
- End the `ForEach` after a stop. The worker then answers a stop with a non-2xx status, against section 5.1 (`design:920`).
  Kestra repeats such a request up to its attempt limit, and the flow then fails (`deployment/kestra/device-update.yaml:48-52`). A skip condition instead changes the merged flow of card P1.
- A longer threshold in the tick. A fixed threshold fails for a longer job or a slower iteration. `batch_size` accepts 1 (`017-jobs.sql:112`), so a job can hold 100,000 batches.
- A separate heartbeat function. It adds a function, a grant, and a lock order. The claim already holds the header, the token fence, and the clock.
- Writes on `busy` claims and finish polls. A `busy` claim answers before the batch lock to avoid a wait (`017-jobs.sql:658-664`).
  A `busy` answer already proves a live lease or grace. A poller then writes every 10 s for up to 45 minutes (`design:968`).
- A write on an empty settlement. It settles no result, so it proves no progress of the current attempt.
- A write in the read-back claim. The Reconcile route of the API also calls that claim (`design:651`). An API call then hides a lost runner for 10 minutes.

### Ruling 8. P2 waits for B6

Design note 1 (`draft:17`).

Decision:

- P2 dispatches after B6 merges. `patchAnnotatedLocations` mints the scope of the `device-changes` capability that B6 adds (`design:859-865`).
  P2 holds no copy of the scope string.
- The mock harness then grants the write scope with no harness change (`api-e2e/admin-sdk-mock-fixture.mjs:24-27`, `design:867`).
- P2 also waits for the write-access card of ruling 5. Items 8 and 9 assert the write-access state (`design:1565-1566`).

Design support: B6 starts after B2, beside B3 (`design:1676`). B6 depends only on B2 (`design:1660`).

Rejected alternative: a scope grant through the mock control (`design:1385`). P2 then holds a second copy of the scope string. Its tests also prove no setup scope list.

### Ruling 9. P2 tests before B3 and B5 merge

Design note 2 (`draft:18`).

Decision:

- P2 waits for neither B3 nor B5. B5 depends on P2 (`design:1662`).
- P2 tests create write jobs with the migrator seed of B2 (`device-write-jobs.integration.mjs:214-293`).
  They admit each job through `cc.admit_device_update_job` (`device-write-jobs.integration.mjs:294-298`).
- The seed matches the confirmation of B3. It writes `batch_size` 250 and numbers batches as `(operation_number - 1) / batch_size`.
  Sources: `B3@603a10b:deployment/postgres/migrations/017-jobs.sql:1585-1594` and `design:376`.
- A test with smaller batches passes a smaller `batch_size` inside the CHECK of `017-jobs.sql:112`.
- Item 24 uploads and starts `device_update` through the Kestra API with the token of the admission (`draft:181`).
  The P1 tests show the pattern (`deployment/kestra/device-update-flow.integration.mjs:273-292`).

Rejected alternatives: waiting for B3, because no P2 test needs a preview. Waiting for B5, because B5 depends on P2.

### Ruling 10. The lease after a normal batch

Design note 3 (`draft:19`).

Decision:

- Each batch request ends with the release as its last database call.
- The release runs only when no operation of the attempt stays `dispatched`.
- After a fenced write settlement or a store failure, the worker never releases.
  The lease then lapses, and a takeover, the finish, or the reaper fences the operations (`design:1001`, `design:1358`).
- The next claim and the finish then proceed without the wait of 210 s.

Design support: a release clears the lease, and the next attempt claims the batch at once (`017-jobs.sql:804-805`, `design:991-992`).
The finish polls `busy` while a lease or its grace lives (`design:1141`).

Why the rule keeps every fence:

- A released batch row names no attempt (`017-jobs.sql:836-838`). A duplicate claim then finds no pending operation and answers `done` (`017-jobs.sql:676-679`).
- The batch claim fences only the `dispatched` operations of the attempt that the batch row names (`017-jobs.sql:668-677`).
  After a release the row names no attempt. An unsettled operation then waits for the finish, so the worker never releases with one.
- Lock order: unchanged (`017-jobs.sql:805-840`). Ruling 10 changes no SQL.

Rejected alternatives: keep the lease until it lapses, or release only on a graceful stop. In both cases each finish waits up to 210 s (`draft:19`).

### Ruling 11. The write batch size

Design note 4 (`draft:20`).

Decision: the reading of the draft holds.

- The P2 setting is the `batchSize` option of each batch call. It limits the parts of one multipart request.
  Sources: `libs/google-connection/src/lib/batch.ts:87` and `libs/google-connection/src/lib/batch.ts:242`.
- Its default is 250, and its ceiling is 250. The worker rejects a value outside 1 to 250 at start.
- `cc.device_update_jobs.batch_size` stays the operation count of one claimed batch, fixed at confirmation (`017-jobs.sql:112`, `design:360`).
  B3 writes 250 (`B3@603a10b:deployment/postgres/migrations/017-jobs.sql:1587-1588`).
- A claimed batch leaves in multipart requests of at most the setting. Each request is one round, and each round renews the lease through `onBatch` (`design:982`).

Design support: the setting defaults to the batch service limit (`design:933`). P2 owns the setting (`design:1743`).
A lower setting shortens each request against the client timeout (`design:1797`).

Rejected alternative: the setting decides `batch_size` at confirmation. Confirmation runs in the API (card B3), which reads no worker setting.
A lower setting then shortens no request of a confirmed job, against the mitigation of `design:1797`.

## Needs the eng-lead

New tables, columns, product behaviors, workflows, entities, or navigation destinations: none.
The rulings add one function and three parameters. They also change three results:

- The answer of the batch claim for a job with a failure.
- The skip reason of the preparation and the reaper.
- The answer of the final finish.

The batch claim also gains two writes on its `stopped` and `done` answers: `heartbeat_at` and `first_claimed_at` (ruling 7).
Both columns exist (`017-jobs.sql:118-119`). The job schemas of the API carry neither column (`design:533-534`).

Rulings 7 and 10 change worker mechanics that the design states. None of these changes product behavior:

- Ruling 7 replaces the heartbeat list of `design:960`. `busy` claims, finish polls, and empty settlements write no heartbeat. Every other current-token claim writes one.
- Ruling 7 sets `first_claimed_at` on a `stopped` or `done` claim too. `design:951` sets it with `started_at` on the first claim. `started_at` keeps its rule.
- Ruling 10 releases the lease after every batch. `design:991-992` releases it only on a graceful stop.

Revision 2 changes the ruling 7 items of this list. The eng-lead note of 2026-10-19 at 09:32 accepted their revision 1 form.
The changed items need the eng-lead again.

Routing decisions for the eng-lead. Each one is a card or an order, not a product decision:

1. Create card B2c from the section "Changes for card B2c".
2. B2c and the unmerged B3 edit the same file `017-jobs.sql` and the same 017 grant block of `index.mjs`. Start B2c after B3 merges.
3. Create the write-access card of ruling 5. It depends on B6.
4. Add B2c, B6, and the write-access card to the dependencies of P2. The design lists B2, P1, and P3 (`design:1689`).
5. The job service of card B5 meets the question of ruling 6. This addendum does not rule on B5.
   - Admission, labels, a refused start, and the reaper record status changes.
     Sources: `017-jobs.sql:459`, `017-jobs.sql:469`, `017-jobs.sql:474`, `017-jobs.sql:559`, and `017-jobs.sql:1260`.
   - None of them returns the element (`017-jobs.sql:470-477`, `017-jobs.sql:522`, `017-jobs.sql:1261-1266`). Section 3.2 names the job service as their publisher (`design:729`).

## Changes for card B2c

Card B2c changes `017-jobs.sql` and `index.mjs` in place. It adds no migration file (`design:221-222`). It changes no worker or API code.

| ID  | Function                       | Change                                                                                                              | Ruling  |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------- |
| C1  | The read-back claim            | Adds `p_after` and `p_limit`.                                                                                       | 3       |
| C2  | The verification read          | New function.                                                                                                       | 1, 2    |
| C3  | The settlement                 | Adds `p_failure`.                                                                                                   | 4       |
| C4  | The batch claim                | A recorded job failure is a stop reason. A `stopped` or `done` answer writes `heartbeat_at` and `first_claimed_at`. | 4, 7    |
| C5  | The preparation and the reaper | The skip reason comes from the recorded job failure.                                                                | 4       |
| C6  | The final finish               | Returns `publication`.                                                                                              | 6       |
| C7  | Grants                         | `index.mjs:277-295` and `017-jobs.sql:1453-1470` name the new signatures of C1 and C3, and add C2.                  | 1, 3, 4 |

Tests go in `device-write-jobs.integration.mjs`, target `deployment:postgres-integration`.
Each new test commits before its change and fails at an assertion on the parent revision (`design:1399-1403`).
A signature probe turns a missing signature into an assertion, as `device-write-jobs.integration.mjs:349-354` does.

1. C1: a job with 1,001 `unknown` operations. Claims with a cursor and limit 250 return 250, 250, 250, 250, and 1 operations, then none. The claims return each operation once.
2. C1: a chunk claim locks only its chunk. An operation outside the chunk stays free for a `NOWAIT` lock.
3. C1: `p_after` -1, `p_limit` 0, and `p_limit` 251 reject with 22023 before any lock. The check at `device-write-jobs.integration.mjs:8526-8539` shows the pattern.
4. C1: a null cursor and a null limit claim every eligible operation, as today.
5. C1 and S3 (Rev-1 F3): the final finish answers `needs-review`. A chunk claim with cursor 0 and limit 250 then claims the `unknown` operations of that terminal job.
   The check at `device-write-jobs.integration.mjs:1114-1131` shows the sequence.
6. C2: an attempt that holds two listed operations receives `held`.
   The answer carries the envelope, the generation, the credential ID, and both operations.
7. C2: another attempt, a lapsed lease, a settled operation, and an unlisted operation each give `not-held` without an envelope.
8. C2, rule G: while another session holds the global lock, the read waits. Its header, detail, and operation rows stay free.
   The check at `device-write-jobs.integration.mjs:6195-6237` shows the pattern.
9. C2: a changed generation raises `credential-changed`. An inactive connection raises `connection-disconnected`.
10. C2: null inputs and an invalid list reject with 22023 before any lock.
11. C2: the read changes no operation row, header revision, or publication row.
12. C2: the runtime role executes the read, and `PUBLIC` does not. The check at `device-write-jobs.integration.mjs:8241-8262` shows the technique.
13. C3: a write settlement with failure `delegation-not-authorized` records its outcomes, the job failure, one revision, and one publication row.
14. C3: an earlier job failure stays. A fenced settlement with a failure records no failure and no row.
15. C3: an unknown failure code, and a failure with kind `read-back`, reject with 22023 before any lock.
16. C4: after test 13, the claim of the next batch answers `stopped` with that failure. It dispatches nothing and skips every pending operation of the job with that reason.
17. C4: a token that is not current still answers `superseded`. The rule G check of the batch claim still passes (`device-write-jobs.integration.mjs:6195-6237`).
18. C3 and C4, Rev-1 F1: a job holds two batches of two operations. One attempt claims batch 0.
    A write settlement with failure `permission-denied` settles operation 1 as `failed`. The attempt then makes no other call.
    A claim of batch 0 by a new attempt with the current token answers `stopped` with that failure, not `busy`.
    That claim skips the operations of batch 1. The claim of batch 1 then answers `stopped` and dispatches nothing.
    Operation 2 stays `dispatched`. After its lease and grace, the preparation fences it to `unknown` with reason `interrupted`.
19. C4, Rev-1 F2: a job of three batches. Batch 0 claims, settles, and releases. The confirmer then loses access.
    The test sets `heartbeat_at` 11 minutes back. The claim of batch 1 answers `stopped`, and the tick returns no start for the job.
    The token and `dispatch_count` stay. Batch 2 repeats the sequence. On the parent revision the tick rotates the token.
20. C4: a job of one batch claims, settles, and releases. The test sets `heartbeat_at` 11 minutes back.
    A claim of batch 0 by a new attempt with the current token answers `done`. The tick then returns no start for the job.
21. C4: the confirmer loses access before the first claim. That claim answers `stopped` and sets `first_claimed_at`. `started_at` stays null.
    The test sets `start_deadline_at` in the past, and the tick returns no start.
    The test then sets `heartbeat_at` 11 minutes back before each of three ticks. The ticks rotate twice and then finalize the job.
    The job ends `failed` with `permission-changed`, not `orchestration-unavailable`.
22. C4, S1: a migrator session holds the detail row (`device-write-jobs.integration.mjs:6797-6800`). A `stopped` claim and a `done` claim each wait on it.
    After the release, `heartbeat_at` is not earlier than the release time. The check at `device-write-jobs.integration.mjs:7988-8025` shows the pattern.
23. C4, S3: the check at `device-write-jobs.integration.mjs:8951-8980` also asserts unchanged `heartbeat_at` and `first_claimed_at`.
    A `done` claim whose token rotates while it waits on the batch row answers `superseded` and writes nothing.
    The parent revision answers `done` there without a fresh token check. A `busy` answer writes nothing, as a guard.
24. C5: a job holds a recorded failure and pending operations. The preparation with a null failure skips them with the recorded failure.
    Without a recorded failure the reason stays `interrupted`. The reaper follows the same rule.
25. C6: the terminal answer of the final finish carries `publication`. Its `publicationId` names the newest row of the job, and its `revision` equals the job revision.
    The other answers carry no element.
26. C7: `to_regprocedure` resolves each new signature and no replaced signature.

Existing B2 checks. A scan of the claim calls in `device-write-jobs.integration.mjs` found no check that claims a running job with a recorded failure.
No check asserts a `done` answer or compares a whole answer of the final finish. C4 and C6 therefore change no existing assertion.
The checks that age `heartbeat_at` call the tick with no claim in between (`device-write-jobs.integration.mjs:1021`, `:3870`, `:6570`, `:7994`).
The new writes leave those checks unchanged. The check at `device-write-jobs.integration.mjs:8951-8980` leaves the detail row out of its comparison. Test 23 adds the two columns.

Consumers of C1 to C7. The search covered the whole repository at `e48c8b8` and the B3 branch at `603a10b`:

| Change | Callers at `e48c8b8`                                                                                                                                                                                                        | Later callers                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| C1     | `device-write-jobs.integration.mjs:385`, `:6720`, `:6916`, `:8171`, `:8224`, and `:8536`. Each passes four arguments, and the defaults keep them valid.                                                                     | P2, and the Reconcile route of B5 |
| C2     | None                                                                                                                                                                                                                        | P2                                |
| C3     | `device-write-jobs.integration.mjs:324`, `:2469`, `:2541`, `:2735`, `:2839`, `:2956`, `:3978`, `:4085`, `:6728`, `:6864`, `:7042`, and `:7186`. Each passes seven arguments, and the default keeps them valid.              | P2                                |
| C4     | `device-write-jobs.integration.mjs:307`, `:3299`, `:6207`, `:6813`, and `:7184`                                                                                                                                             | P2                                |
| C5     | The preparation: `device-write-jobs.integration.mjs:343` and `:8055`. The reaper: `device-write-jobs.integration.mjs:55`, `:378`, `:4479`, `:6655`, `:8117`, `:8558`, and `:9188`, and the tick path at `017-jobs.sql:613`. | P2, and the tick of B5            |
| C6     | `device-write-jobs.integration.mjs:351-375`, `:6585`, `:6643`, `:8553`, `:9136`, and `:9162`                                                                                                                                | P2                                |
| C7     | `index.mjs:285-292`                                                                                                                                                                                                         | None                              |

No worker or API code calls C1 to C6 at `e48c8b8`. Inside SQL, only the tick path at `017-jobs.sql:613` calls one of them.
B3 at `763f300` adds no caller. Its `index.mjs` names the same grants (`B3@603a10b:deployment/postgres/index.mjs:285-292`).

## Changes for card P2

Edits to the draft, by draft line:

1. `draft:3-20`: delete the section "Open questions for the eng-lead", as `draft:5` instructs. Name this addendum in its place.
2. `draft:25-26`: P2 also builds on cards B2c, B6, and the write-access card (rulings 1 to 6, and 8).
3. `draft:51`: keep. Ruling 11 confirms the reading. The setting is the `batchSize` option of each batch call.
4. `draft:52-55`: add rulings 4 and 10. From the first stopping observation on, every write settlement of the batch carries the job failure.
   The batch call still runs to its end. Each batch request ends with the release when no operation of the attempt stays `dispatched`.
5. `draft:59`: replace its last sentence with ruling 4. The batch answers 200 with outcome `stopped` and the failure.
6. `draft:60-61`: add the read-back loop of rulings 1, 2, 3, and 7. The worker reads the envelope and the operations through the verification read.
   It starts no GET before `verifyAfter` and aborts the chunk 15 s before the lease ends.
7. `draft:63-69`: the finish handler handles the `publication` of the final finish like a settlement element (ruling 6).
8. `draft:85-87`: name the new signatures of the settlement and the read-back claim.
9. `draft:93-99`: replace the six "Open question" rows of open questions 1 to 6 with the first six rows below.
   Replace the `heartbeat_at` row of open question 7 with the last row below. Ruling 7 places that write in the batch claim.

| Operation                                                   | Function                                                                                                                                                                                              | Grant in `index.mjs`              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Credential envelope for the finish and reconcile read-backs | `cc.read_device_update_verification(text,uuid,uuid,jsonb)`, ruling 1                                                                                                                                  | New grant of B2c in the 017 block |
| Device ID and requested value of one Reconcile operation    | The same function with the `verifyAttempt` of the flow, ruling 2                                                                                                                                      | The same grant                    |
| `unknown` operations in chunks of 250                       | `cc.claim_device_update_verification(text,uuid,jsonb,uuid,integer,integer)`, ruling 3                                                                                                                 | `index.mjs:289`, signature of B2c |
| Job failure of section 7.2 during a batch                   | `cc.settle_device_update_operations(text,uuid,uuid,uuid,text,jsonb,timestamptz,text)` with `p_failure` on every write settlement after the first stopping observation. Later claims answer `stopped`. | `index.mjs:288`, signature of B2c |
| Write access `denied`                                       | No worker call. The job failure of ruling 4 is the record, ruling 5.                                                                                                                                  | None                              |
| Publication element of the finish                           | `cc.finish_device_update_job(text,uuid,uuid,text)` returns `publication`, ruling 6                                                                                                                    | `index.mjs:291`                   |
| `heartbeat_at` on `stopped` and `done` claims               | `cc.claim_device_update_batch(text,uuid,uuid,integer,uuid,text)` writes it, ruling 7. P2 makes no separate call.                                                                                      | `index.mjs:285`                   |

10. `draft:101-102`: replace with this text. "P2 changes no 016 or 017 object and no grant. Card B2c makes the changes of the addendum, and P2 depends on B2c."
11. `draft:104-111`: point to the section "Lock rules" of this addendum. Keep the worker rule, which is rule W.
12. `draft:165`: item 8 reads `GET /api/devices/updates/access` after the stop. The state stays unchanged, because `network-failure` is no scope failure (ruling 5).
13. `draft:166`: item 9 asserts that `GET /api/devices/updates/access` answers `denied` with failure `delegation-not-authorized` after the stop, without a recheck.
    It runs on the mock stack after B6 and the write-access card merge.
14. `draft:188`: item 26 reads the 1,001 operations through five chunk claims (ruling 3).
15. `draft:194-204`: change the audit rows of item 28 as follows. Cite the B2c functions at the base of P2.
    - "Batch claim and `busy` poll": add the stop decision and the heartbeat writes of C4. Name the lock orders of its `stopped` and `done` paths.
    - "Write recording with the `40P01` retry": add `p_failure` of C3 on every write settlement after the first stopping observation. The lock order stays.
    - "Read-back in the batch, the takeover, the finish, and the reconcile flow": name the C1 signature.
      Add the verification read before the GET parts of places 3 and 4.
    - "Graceful stop": the release ends every batch request, not only a stop (ruling 10).
    - "Job stop of section 7.2": the B2 calls are C3 after the first stopping observation and C4 in later claims.
      The lock orders are those of contract C3 and of the stop path in contract C4. Later batches answer `stopped` and send nothing.
    - "Finish handler": add the chunk claims, the verification read, and the `publication` of C6.
    - "Reconcile handler": the verification read and the chunk claim replace "Open questions 1 to 3".
    - Add a row for the verification read. (a) The global lock, then the connection row. (b) The clock and the held operations again after the credential wait.
      (c) `held` or `not-held`. A credential error settles the chunk `unknown` with `verification-failed`.
16. `draft:206`: item 29 becomes "P2 adds no migration and no grant. Card B2c adds them."
17. `draft:214-228`: add reviewer checks. The release ends each batch request. Each chunk ends 15 s before its lease.
    Each pass reads each operation once. P2 makes no separate heartbeat call.
    Every write settlement after a stopping observation carries the failure, and so does the settlement that holds the observation.
18. After `draft:181`, add items A1 and A2. They test Rev-1 F1 and Rev-1 F2 at the worker.
    - A1, ruling 4. The job holds two batches of two operations, and the worker `batchSize` is 1. Round 1 answers one part of kind `auth`.
      The worker settles round 1 with the job failure. The test then kills the worker before the round 2 settlement, as item 12 kills it.
      A second request for the same batch answers `stopped` with that failure and sends no part.
      The request for the next batch answers `stopped` and sends no part. The finish fences operation 2 after its lease and grace, then reads it back.
    - A2, ruling 7. A part answer of kind `auth` stops a job of three batches at batch 0. That request releases its lease.
      Before each later batch request, the test sets `heartbeat_at` 11 minutes back. Each request answers `stopped`.
      After each request, `cc.recover_device_update_jobs` returns no start for the job.
19. `draft:183` and `draft:207`: A1 and A2 live in `deployment:postgres-integration`. Item 30 maps them with items 1 to 26.

Handler call order. Each call runs as its own statement (rule W):

- Batch request:
  1. The batch claim with its envelope. Every answer except `busy` and `superseded` writes `heartbeat_at` inside the claim (ruling 7).
  2. The write call with its renewals and round settlements. After a stopping observation, every write settlement carries the failure.
  3. One write settlement for any operation that no round settled. A mint failure, a fatal batch error, and an abort leave such operations.
  4. The read-back of places 1 and 2.
  5. The release.
- Finish request:
  1. The preparation until `ready`.
  2. Per chunk: a claim with a cursor and limit 250, then one verification read.
  3. Per chunk: GET parts inside the chunk window, then one read-back settlement.
  4. The final finish and its `publication`.
- Reconcile request with a number: the verification read with `verifyAttempt` and one operation, the GET part, then the read-back settlement.
- Reconcile request with `all`: the chunk loop of the finish request under a new attempt.

New answers: the batch handler answers `stopped` with the failure after a stop of section 7.2. The reconcile handler answers `not-held`.
P2 records both shapes in its hand-off (`draft:40`).
