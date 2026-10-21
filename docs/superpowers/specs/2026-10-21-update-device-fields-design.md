# Technical design addendum: Update device with five fields

Status: proposed on 2026-10-21 for review. Card `t_37e142f9`.
Record: `docs/workflows/update-device-fields.md`, owner-confirmed on 2026-10-21. PR #81 merged it as `1f91da3`.
Extends: [the step 4 design](2026-10-16-device-write-jobs-design.md) and [its worker contracts](2026-10-19-device-write-worker-contracts.md). It reads [the step 5 design](2026-10-21-device-command-jobs-design.md).
Owner direction, 2026-10-19: "We are building a doghouse. We dont need to choose the curtains."

## Conventions

- Code paths are relative to the repository root at `265a52a`. `1f91da3` changes only the record and two lines of `docs/current-work.md`, so every cited code line holds on `main`.
- `record:N` cites the record at `1f91da3`. Its tree equals the record branch head `8406331`.
- `step4:N` cites `2026-10-16-device-write-jobs-design.md`. `step5:N` cites `2026-10-21-device-command-jobs-design.md`.
- `016`, `017`, and `018` name the files in `deployment/postgres/migrations/`. `ac/` is `libs/application-contracts/src/lib/`, `gc/` is `libs/google-connection/src/lib/`, `api/` is `api/src/app/`, and `fe/` is `frontend/src/app/`.
- `worker:N` cites `worker/src/device-update.ts`. `mock:` names `node_modules/@campuscommander/admin-sdk-mock/dist/src/`, version 0.2.0.
- `findings` names `~/engineering-team/workspace/update-device-fields/findings.md`. Its lines cite `2599a33`. `git diff 2599a33 265a52a` is not empty, so this design re-read every cited line at `265a52a`.
- The reviewer approved B5 at `a3f3ef9` on `codex/device-actions-command-jobs`. Merge card `t_d99cb3c4` merges `main` into it. No B6 branch exists on 2026-10-21. Its scope is step5:179-204.

## Decision summary

1. One draft carries one to five field changes. Each field has one mode: Replace, Clear, or Move.
2. One operation per device keeps one PATCH. Child rows hold the values of each field.
3. Each written field gets its own overlay and its own current-value stamp.
4. The update action moves to action version 2. The digest hashes the ordered changes and each eligible baseline.
5. A 2xx answer and a read-back reach one verdict through one compare. Paths compare without case.
6. A new route reads `orgunits.list` for the OU picker. Setup lists the OU read scope.
7. Today's platform and district grants cover every OU, so the move check needs no new argument.

## 1. Contracts

| Field ID            | Label              | Google property     | Modes              | Value                                                 |
| ------------------- | ------------------ | ------------------- | ------------------ | ----------------------------------------------------- |
| `annotatedLocation` | Annotated location | `annotatedLocation` | `replace`, `clear` | 1 to 200 code points                                  |
| `assetTag`          | Asset tag          | `annotatedAssetId`  | `replace`          | 1 to 256 code points                                  |
| `annotatedUser`     | Annotated user     | `annotatedUser`     | `replace`, `clear` | 1 to 100 code points                                  |
| `notes`             | Notes              | `notes`             | `replace`, `clear` | 1 to 500 code points                                  |
| `orgUnitPath`       | Organization unit  | `orgUnitPath`       | `move`             | A path that starts with `/`, at most 4,096 characters |

- The IDs are the device record keys (`ac/devices.ts:61-75`). The labels follow record default 6 (`record:92`). This table order is the contract order. Rows, bodies, and the digest use it.
- A text value keeps the step 4 rule: code points, a visible character, and no trim (`ac/device-updates.ts:22-35`). The mock counts code points too (`mock:directory/common.js:90-91`).
- 200 is built. 256 is the sync cap (`gc/devices.ts:47`, `016:39`). Google documents 100 and 500 (`record:30`). The mock enforces 100 and 500 and sets no Asset tag limit (`mock:directory/device-writes.js:11-16`).
- The contract therefore enforces all four limits. A refusal names the field label and the limit (`record:31`). Engineering copy, for example: `Asset tag holds 1 to 256 characters.`
- New exports `DEVICE_UPDATE_FIELD_LIMITS` and `DEVICE_UPDATE_FIELD_LABELS` serve the client and the API.
- Asset tag offers no Clear until the DEVICE-01 live check (`record:25`, `record:126`). Organization unit offers only Move. `org_unit_path` is NOT NULL (`016:40`), and the mock ignores a null path (`mock:directory/device-writes.js:44-47`).
- Move sends the path that the OU tree returned, in Google's casing (section 6). The request carries the path (`record:49`). Prepend and Append stay out (`record:117`).

| Contract                                       | Change                                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Preview request (`ac/device-updates.ts:40-51`) | `{ gridId, tabId, changes }`. `changes` holds 1 to 5 strict objects `{ field, mode, value }`. Clear omits `value`. A field occurs once. |
| Preview summary (`ac/device-updates.ts:56-86`) | `changes`, in contract order, replaces `mode` and `value`. New count `fieldChanges` counts eligible device-field rows (Figma `97:21`).  |
| Target row (`ac/device-updates.ts:89-99`)      | The keys stay. One row per target device and change. `field` takes the five IDs. `approvedValue` widens to 4,096 characters.            |
| Job detail (`ac/jobs.ts:205-219`)              | `changes` replaces `field`, `mode`, and `requestedValue`. It is null for a command or status job.                                       |
| Job operation (`ac/jobs.ts:138-163`)           | New key `field`, null for command and status rows. `operation` adds `move`. An update job answers one row per operation and field.      |

- `selected`, `eligible`, `unchanged`, and `excluded` keep counting devices. `record:34` asks for one preview row and one job row per device and changed field.
- An update row reads `baselineValue`, `requestedValue`, and `observedValue` from its field row. Outcome, reason, Google status, and evidence come from the operation. Every row of one device therefore carries the result of its one PATCH.
- Rows sort by operation number or ordinal, then contract order. Pages keep 1,000 rows (`ac/jobs.ts:271`, `api/devices/device-updates.ts:304-335`).
- Both cursors become `"<number>:<position>"` (`api/devices/device-update-rows.ts:10-14`, `api/jobs/jobs.ts:503`).
- The confirm body and the receipt stay (`ac/device-updates.ts:116-135`). `updateCount` keeps counting operations, one per device (`017:1604-1610`). `record:35` keeps the receipt as step 4 built it.

## 2. Schema

Each change edits a migration in place, as step5:69 does. Development data is disposable (`AGENTS.md:27`).

| Object                                                                         | Change                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cc.device_update_changes`, new in 017                                         | `preview_id` (ON DELETE CASCADE), `field`, `mode`, `value`. Primary key `(preview_id, field)`. Checks: the field-mode pairs of section 1, `(mode='clear')=(value IS NULL)`, each length, and a leading `/` for a path.                  |
| `cc.device_update_previews`, `cc.device_update_jobs` (`017:69-93`, `:113-147`) | Drop `field`, `mode`, `value`, and the checks that name them (`017:91-92`, `:146`). A job reads its changes through its unique `preview_id` (`017:115`). Previews gain `field_changes integer NOT NULL DEFAULT 0`.                      |
| `cc.device_update_target_fields`, new in 017                                   | `(preview_id, ordinal)` references the target ON DELETE CASCADE. Columns `field`, `observed_value`, and `disposition`. Primary key `(preview_id, ordinal, field)`.                                                                      |
| `cc.device_update_operation_fields`, new in 017                                | `(job_id, operation_number)` references the operation ON DELETE CASCADE. Columns `field`, `baseline_value`, `requested_value`, and `observed_value`. Primary key `(job_id, operation_number, field)`.                                   |
| `cc.device_write_overlays` (`017:206-217`)                                     | The field check adds `assetTag`, `annotatedUser`, `notes`, and `orgUnitPath`.                                                                                                                                                           |
| `cc.devices` (`016:34-58`)                                                     | `annotated_user` (section 5). Four current-value stamps beside `016:53-54`: `asset_tag_observed_at`, `annotated_user_observed_at`, `notes_observed_at`, and `org_unit_path_observed_at`.                                                |
| `cc.upsert_devices` (`016:365-467`)                                            | `asset_tag`, `org_unit_path`, `notes`, and `annotated_user` leave the row rule (`016:403-410`) for the rule of `annotated_location` (`016:426-436`). The WHERE, RETURNING, `converged`, and `moved` clauses (`016:437-463`) cover them. |
| Grants (`deployment/postgres/index.mjs:274-276`)                               | SELECT on the three new tables.                                                                                                                                                                                                         |

Per-field values:

- An update target holds one field row per change. Every row of an excluded device is `excluded`. Another row is `eligible` when its observed value differs from the change value, and `unchanged` otherwise.
- A path compares without case, so a device in `/high school` is `unchanged` for a Move to `/High School`.
- A device is `eligible` when one of its rows is eligible. The step 4 exclusions stay (`api/devices/device-updates.ts:78-111`).
- Confirm creates one operation per eligible device, as today (`017:1853-1863`). It adds one operation field row per eligible field row.
- The value columns of an update operation (`017:170-171`, `:179`) and of an update target (`017:103`) stay null. Command and status rows keep using them.

Overlays and stamps:

- Step 4 rules 1 to 7 (step4:1076-1093) apply to each field with the stamp of that field. A Notes write never orders an Asset tag observation.
- A path converges on `lower()` equality in `converged`. Annotations converge on `IS NOT DISTINCT FROM`, as today (`016:448-453`).
- The mock lags lists by `searchDelaySeconds`, 300 s (`mock:settings.js:31`), after each write (`mock:directory/device-writes.js:54`). Without the overlays, a list sync inside that window restores old values.
- The OU filter reads `org_unit_path` (`api/devices/device-query.ts:17`). The overlay keeps a moved device in its destination for completion step 2 (`record:135`).

## 3. Digest and action version

- The `annotated-location` action moves to action version 2. A change of action semantics increments the version (step4:342, `docs/portfolio/03-architecture.md:199`). Several fields and Move change those semantics.
- Reboot, Disable, and Re-enable stay at version 1. `cc.create_device_update_preview` stores the version of its action (`017:80`, `:1688-1694`).
- The manifest read (`017:1731`) and confirm (`017:1789`) compare with the version of the action, not the literal 1. A mismatch keeps the answer `preview-changed`.
- Digest: SHA-256 over the canonical JSON `{ actionVersion: 2, changes, targets }`. `changes` lists `[field, mode, value]` in contract order, with `null` for Clear.
- `targets` lists `[deviceId, [[field, baseline], ...]]` for each eligible device, sorted by device ID as today (`api/devices/device-updates.ts:117-133`). Each device lists its eligible fields in contract order.
- The stored action name stays `annotated-location`. A rename edits 13 lines of 017 and the B5 worker schema without a behavior change. Step 5 kept the table names for the same reason (step5:90).

## 4. Worker

Google call:

- `patchDevices` replaces `patchAnnotatedLocations` (`gc/devices.ts:669-713`). A write is `{ deviceId, fields }`. The body holds only the eligible fields of that device (`record:47`).
- Clear sends `null` (`record:48`). The body names Asset tag `annotatedAssetId`. The other IDs equal Google's property names.
- The part keeps `projection=FULL` and `fields=deviceFields` (`gc/devices.ts:686`). The answer parses as a directory device and maps through `deviceObservation` (`gc/devices.ts:369-381`).
- `writtenDevice` (`gc/devices.ts:103-107`) goes. A body that fails the parse is `invalid-response`, which settles `unknown` (step4:1329).
- The part allowlist admits the PATCH path today (`gc/provider.ts:266`). The `device-changes` scope covers every field (`ac/google-capabilities.ts:69-81`).
- `moveDevicesToOu` stays out, because it returns no per-device result (`record:121`).

Claims: every SQL builder of an operation object adds `fields`. Each entry is `{ field, baselineValue, requestedValue }`, in contract order. The builders sit at `017:377-379`, `:793-795`, `:1196-1198`, `:1239`, and `:1253`. The list stays empty for command and status operations. `claimedOperationSchema` (`worker:113-119`) and `heldOperationSchema` (`worker:171-182`) follow.

Write-response checks in `classifyWrite` (`worker:443-603`):

1. A field absent from a 2xx body reads as null. Google and the mock omit empty annotations (`mock:directory/devices.js:39-46`).
2. Each field compares its observed value with its requested value. Annotations compare exactly after `blank()` (`gc/devices.ts:359-361`). Paths compare after `toLowerCase()` on both sides.
3. When every field matches, the operation settles `succeeded` with `verified_by=write-response`. When a field differs, it settles `failed` with `value-differs`.
4. Today every 2xx succeeds (`worker:447-460`). Step 3 applies the read-back verdict (step4:1043) to the same kind of observation.
5. The result carries `values`, the observed value of each field. Refusals, retries, and unknown answers keep step4:1321-1332.

Read-back (`worker:1833-1879`) runs the same compare on each observation of `deviceStates`. That call already removes repeated device IDs (`gc/devices.ts:951`). Reconcile keeps its route and settles every field of one operation (`api/jobs/jobs.controller.ts:220-244`).

Settlement (`017:914-1140`):

- A status result keeps `value`. An update result can carry `values`. It maps each field of the operation to null or a string of at most 4,096 characters.
- A `succeeded` update result carries `values`. A key set that differs from the fields of the operation raises 22023 before any lock (rule S2, `2026-10-19-device-write-worker-contracts.md:84-89`).
- The field set of an operation never changes after confirm, so that check reads it without a lock.
- The `applied` step (`017:1065-1081`) writes each observed value into its field row.
- Publication pivots per device first. One UPDATE of `cc.devices` then sets each column and stamp that passes rule 2 (step4:1079). An UPDATE with two source rows for one target row applies only one of them.
- Each published device and field gets an overlay with the step 4 values (`017:1094-1102`). The overlay lock (`017:1045-1049`) covers every field of the operation.
- Only a `succeeded` operation publishes, as today (`017:1089`). A `value-differs` device keeps its cached values until the next refresh. `write_field` (`017:1023-1025`) keeps serving status jobs.

The mock validates every field and the OU before one transaction (`mock:directory/device-writes.js:37-58`). A refusal therefore changes no field, and one outcome per device is exact on the mock.
Replace, Clear, and Move each send an absolute final value, so step4:1360-1366 holds for several fields and for Move.

## 5. Annotated user

| Layer     | Change                                                                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sync      | `devicePage` adds `annotatedUser`, at most 4,096 characters (`gc/devices.ts:39-57`). The list fields (`:544`) and `deviceFields` (`:93-94`) add it. `deviceObservation` maps it through `blank()` (`:369-381`). |
| Storage   | `cc.devices` gains `annotated_user text CHECK(length(annotated_user)<=4096)` beside `016:42`. `cc.upsert_devices` inserts it (`016:390-397`). `cc.device_record` adds `annotatedUser` (`016:353-354`).          |
| Contracts | `deviceObservationSchema` and the record shape add `annotatedUser` (`ac/devices.ts:39-50`, `:61-75`). The text field and sort field enums add it (`ac/devices.ts:111-128`).                                     |
| API       | The column map (`api/devices/device-query.ts:13-22`) and `deviceRow` (`:305`) add `d.annotated_user`. U6 adds it to `selectionIdsSql` (`:400`), with `d.asset_tag` and `d.notes`.                               |
| Grid      | `docs/ui/entity-grid-fields.json` adds an "Annotated user" text entry after Notes (`:184-191`), filterable and hidden by default. `fe/devices/device-fields.ts` adds the column (`:56`).                        |
| Details   | An "Annotated user" row joins `fe/devices/device-detail.html:48-57`.                                                                                                                                            |

- The bound is 4,096 characters, as for location and notes. A longer Google value then never fails a list page. One long asset ID fails a page today (`gc/devices.ts:47`, `:535`).
- A Redis entry without the key fails its strict parse and reads as absent (`api/devices/device-pager.ts:134-139`). The cache needs no rebuild step.
- The mock seeds a person's address on one-to-one and staff devices (`mock:seed/devices.js:134-142`, `:179`).

## 6. Organization unit tree

- Setup: `GOOGLE_SETUP_CAPABILITY_IDS` adds `school-ou-references` last (`ac/google-capabilities.ts:85-91`). The comment at `:93-96` then names the OU picker as the reason.
- Copy scopes, delegation links, and the health store follow that list (`fe/google-connection/health.store.ts:23-28`). The capability keeps its ID, label, and scope (`ac/google-capabilities.ts:28-40`, `record:52`).
- Reader: a new `readOrgUnitTree(credential, customerId, signal)` in `gc/devices.ts`. It repeats the call of `readSchoolReferences` (`gc/provider.ts:555-578`): `orgunits.list` with `type=all_including_parent`.
- It accepts at most 10,000 units (`gc/provider.ts:576`). It passes a 4 MiB limit to `scopedClient` (`gc/provider.ts:310-314`), because the default 256 KiB (`:28`) holds about 1,500 units.
- The Schools reader stays unchanged, because Schools remains disputed (`AGENTS.md:8`).
- Route: `GET api/devices/updates/org-units` requires `DEVICE_UPDATE_ACTIONS` (`api/devices/device-updates-actions.ts:8-12`). It opens the credential as the write-access check does (`api/devices/device-write-access.ts:71-74`).
- The route keeps the 25 s deadline of that check (`api/devices/device-write-access.ts:36-39`) and keeps no cache. The edge GET pattern adds `org-units` (`deployment/bootstrap/application-edge.mjs:85`).
- Answer: `{ state, scope, failure, orgUnits, observedAt }`. States follow step4:876-883: success is `granted`, `delegation-not-authorized` and `scope-mismatch` are `denied`, and other codes are `unavailable`.
- `orgUnits` lists `{ orgUnitId, name, orgUnitPath, parentOrgUnitId }` while `granted`. It is null in the other states.
- Picker: the sheet reads the route when the OU field opens. The dialog shows the tree, searches it in the browser, and returns one unit (TREE-01, `docs/ui/patterns.md:142-145`, `:327-331`).
- The draft keeps the unit ID and the path. The preview request sends the path.
- Disabled field: a state other than `granted` disables the OU field (`record:53`). `denied` shows a note in the D2 pattern (`ac/device-write-access-message.ts:4-5`). Engineering copy:
  "Google denied the organization unit tree. Add https://www.googleapis.com/auth/admin.directory.orgunit.readonly to the delegation client in the Google Admin Console."
- `unavailable` shows the failure label and a Retry action. The mockup decides the final copy of both states.
- The grid's OU filter keeps its source, the OUs that hold devices (`api/devices/devices.controller.ts:256-260`).

## 7. Access

- A move needs Device Write in the source OU and in the destination OU (`docs/workflows/platform-access.md:743-747`, `record:59`).
- `devices:write` and `devices:bulk-actions` accept only platform and district scopes (`ac/authorization.ts:47-51`). `cc.write_capable` checks both actions at those scopes (`017:425-435`).
- Such a grant covers every source OU and every destination OU. Preview (`017:1677`), confirm (`017:1784`), and each batch claim (`017:440-449`) run that check.
- These checks therefore enforce the move rule for today's grants. This design adds no OU argument.
- The single administrator holds every action (`ac/authorization.ts:108`). The picker therefore offers every OU (`record:60`).
- When platform access adds OU-scoped grants, `cc.write_capable` takes the source OUs of the eligible targets and the destination path. The tree route then offers only destinations with Device Write (`docs/workflows/platform-access.md:746`, `record:61`).
- Each operation keeps its source OU (`017:169`). The change row keeps the destination. Job-visibility scoping waits for platform access (`docs/workflows/update-device-annotated-location.md:203`).

## 8. Tests

No test calls Google. Google answers come from admin-sdk-mock or from fakes.

| Decision             | Target                                                              | Proof                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts            | `application-contracts:test`                                        | Each limit at N and N+1 code points, with the label in the message. Clear on Asset tag, a repeated field, and 0 or 6 changes fail.                                                       |
| Preview rows, digest | `api:test` (`api/devices/*.test.mjs`)                               | Row dispositions, a path in other case as `unchanged`, `fieldChanges`, and the version 2 digest of a fixed input.                                                                        |
| Schema and confirm   | `deployment:postgres-integration`                                   | The change checks, field rows at confirm, a version 1 preview answering `preview-changed`, and the purge cascade.                                                                        |
| PATCH                | `google-connection:test` (`gc/admin-sdk-mock.test.mjs`)             | One PATCH sets four annotations and moves the device. `null` clears. Notes over 500 or an unknown OU (`mock:directory/orgunits.js:35-47`) answer 400 and change no field.                |
| Checks and read-back | `worker:test`                                                       | A match gives `succeeded`. A differing field gives `value-differs`. A fake reader proves a path in other case, because the mock matches exact case (`mock:directory/orgunits.js:27-29`). |
| Settlement           | `deployment:postgres-integration`                                   | Two fields of one device publish in one settlement. Each field gets its stamp and overlay. An older stamp publishes nothing.                                                             |
| List lag             | `deployment:postgres-integration`                                   | Per field: a lagged list keeps the overlay value. An equal list deletes the overlay. A path converges without case.                                                                      |
| Lost answer          | `api-e2e:admin-sdk-mock-integration` (`api-e2e/project.json:42-59`) | A `hang` of 12,000 ms on `directory.chromeosdevices.patch` (`api-e2e/device-write-mock.mjs:336-341`) outlasts the 10 s timeout (`gc/provider.ts:299`).                                   |
| End-to-end lag       | `api-e2e:admin-sdk-mock-integration`                                | A Refresh all inside 300 s keeps the written values and the moved OU. `POST domains/{id}/index/flush` ends the lag (`mock:control/control.js:259-272`).                                  |
| Annotated user       | `google-connection:test`, `api-e2e:admin-sdk-mock-integration`      | The seeded value reaches the record, the text filter, and the sort.                                                                                                                      |
| OU tree              | `api:test`, `api-e2e:admin-sdk-mock-integration`, `frontend:test`   | `granted` lists the seeded tree. A `remove-scope` fault (pattern `api-e2e/device-write-mock.mjs:408-412`) gives `denied`. The setup lists name the scope.                                |
| Access               | `deployment:postgres-integration`                                   | A person without `devices:write` or `devices:bulk-actions` receives `forbidden` for a Move preview.                                                                                      |
| Six steps            | `api-e2e:client-review-mock`, `frontend-e2e:e2e` (Chromium)         | Card Q1 rehearses `record:134-139`.                                                                                                                                                      |

The `hang` sleeps `ms / scale` and then runs the handler (`mock:faults/faults.js:136-141`). The PATCH therefore applies, and its answer is lost. Read-back then settles each field `succeeded`. Tests keep scale 1 (`api-e2e/admin-sdk-mock-fixture.mjs:244`).

## Conflicts with B5 and B6

| File                                                      | B5 at `a3f3ef9`                                        | B6, step5:179-204                      | Cards here |
| --------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------- | ---------- |
| `017-jobs.sql`, `cc.settle_device_update_operations`      | Adds the `issue` kind, its fences, and command columns | Settles polls and derives the status   | U5         |
| `017-jobs.sql`, the claim, recovery, and finish functions | Changes the recovery and the finish preparation        | Adds the poll claim and due-poll reads | U5         |
| `worker/src/device-update.ts` and its test                | Restructures the PATCH call and the finish             | The poll handler                       | U5         |
| `deployment/postgres/device-write-jobs.integration.mjs`   | Adds 459 lines of command checks                       | Poll checks                            | U5, U6     |
| `api-e2e/device-write-mock.mjs`                           | Adds 231 lines of command checks                       | Poll checks                            | U5, Q1     |
| `api/src/app/jobs/jobs.ts`                                | Refuses Reconcile for commands                         | None                                   | U5, U6     |
| `deployment/postgres/index.mjs`                           | None                                                   | Grants of the poll functions           | U5, U6     |
| `deployment/bootstrap/application-edge.mjs`               | Widens the job ID pattern (`:78`)                      | None                                   | U2 (`:85`) |

U5 starts after B5 merges to `main`. When B6 is open at that time, the second of U5 and B6 to finish merges `main` before review.

## Card plan

Each card that changes a contract updates every consumer, including `api-e2e` and the `frontend-e2e` fixtures.

| ID  | Title                                                  | Profile  | Depends on         |
| --- | ------------------------------------------------------ | -------- | ------------------ |
| U1  | Inventory: Annotated user                              | backend  | none               |
| U2  | Organization unit tree: setup scope and route          | backend  | none               |
| U3  | Google calls: one PATCH with several fields            | backend  | U1                 |
| U4  | List-lag protection for four more fields               | backend  | U1                 |
| U5  | Write jobs: field rows, checks, read-back, publication | backend  | U3, U4, B5 merged  |
| U6  | Previews and confirm for five fields                   | backend  | U5                 |
| F1  | Devices grid and details: Annotated user               | frontend | U1, mockup         |
| F2  | Update device sheet: text fields, review, and confirm  | frontend | U6, mockup         |
| F3  | Update device sheet: Organization unit and picker      | frontend | U2, F2, mockup     |
| F4  | Jobs: one row per device and field                     | frontend | U5, U6, mockup     |
| Q1  | Rehearse the six completion steps                      | qa       | U1 to U6, F1 to F4 |

**U1.** Scope: the Sync, Storage, Contracts, and API rows of section 5. `annotated_user` keeps the row rule until U4.
Acceptance: after Refresh all on the mock, a seeded one-to-one device answers its `annotatedUser` in `GET api/devices`.
The text filter and the sort on `annotatedUser` return that device. A device without the value answers null.

**U2.** Scope: section 6 Setup, Reader, Route, and Answer, with the denied message constant. It updates the scope tests (`fe/diagnostics/diagnostics.spec.ts:197-206`).
Acceptance: the setup scope list names `admin.directory.orgunit.readonly`. The route answers `granted` with the seeded tree.
After a `remove-scope` fault for that scope, the route answers `denied` with the scope. A person without `devices:write` receives 403.

**U3.** Scope: section 4 Google call. `patchAnnotatedLocations` and `writtenDevice` stay until U5 moves the worker.
Acceptance: the PATCH row of section 8 passes in `google-connection:test`.

**U4.** Scope: the stamps, the `cc.upsert_devices` rule, and the overlay field check of section 2.
Acceptance: the List lag row of section 8 passes for each of the four fields.

**U5.** Scope: `cc.device_update_operation_fields`, the claim builders, and the worker and settlement of section 4.
It also covers the job operation rows of section 1 (`api/jobs/jobs.ts:188-231`, `:482-522`).
Until U6, confirm writes one `annotatedLocation` field row per operation from the preview columns.
Acceptance: a job seeded with Asset tag and Notes on 3 mock devices ends `completed`. One `entity-batch` carries the 3 devices, and their records hold both values.
A Move job ends `completed`, and the OU filter finds its devices in the destination. The Lost answer row of section 8 settles every field by read-back.
The step 4 Annotated location suites pass. Job operations answer one row per device and field.

**U6.** Scope: section 1 contracts, the preview objects of section 2, section 3, and the job detail query (`api/jobs/jobs.ts:415`, `:463-470`).
It changes both preview callers (`api/devices/device-updates.ts:243`, `api/devices/device-actions.ts:234`) and the grant (`deployment/postgres/index.mjs:299`).
Consumers keep one-field behavior: the sheet sends one change (`fe/devices/device-update-flow.ts:619-624`). The receipt and the job detail read `changes` (`fe/jobs/job-receipt-messages.ts:18-21`, `fe/jobs/job-detail-fields.ts:116-118`).
Acceptance: a preview sets Asset tag and Notes on 6 devices. One device already holds the Notes value.
The preview answers 6 eligible devices, `fieldChanges` 11, and 12 target rows.
Each over-limit value answers 400 with the field label. Clear on Asset tag answers 400. Confirm creates 6 operations and 11 field rows. A version 1 preview answers 409 `preview-changed`.

**F1.** Scope: the Grid and Details rows of section 5. Acceptance: completion step 3 passes (`record:136`).

**F2.** Scope: the Edit step with the four text fields and their modes, limits, and counters. Each field starts at "Leave unchanged" (`record:22`).
It replaces the one-field draft store (`fe/devices/device-update-draft.store.ts:13-31`) and the sentence of `fe/devices/device-update-sheet.html:174-176`.
It builds the Review rows per device and field, and the confirmation and receipt for several fields. Acceptance: completion steps 1, 4, and 5 pass (`record:134`, `:137`, `:138`).

**F3.** Scope: section 6 Picker and Disabled field, and the Move rows of Review and Confirm. Acceptance: completion steps 2 and 6 pass (`record:135`, `:139`).

**F4.** Scope: the job detail rows per device and field (`fe/jobs/job-detail-fields.ts`), the changes in the header, and Move rows.
Acceptance: the job of completion step 1 shows one row per device and field with Before and Requested values (`record:34`).

**F1 to F4.** Each waits for the owner-approved mockup and its API card. Each closes its design gaps (`record:110-111`).

**Q1.** Acceptance: each step of `record:134-139` passes on admin-sdk-mock, with screenshots. Lint, tests, and builds of the affected projects pass. Live write behavior stays "not verified" (`record:141`).

## Risks and follow-ups

- Live Google writes stay unverified (`record:63`). The DEVICE-01 live check also decides Clear on Asset tag (`record:64`).
- Google's PATCH atomicity and value normalization stay unverified. A normalized value settles `value-differs`, with Google's value as evidence.
- An OU tree above 10,000 units answers `unavailable` with `invalid-response`. Google allows 40,000 OUs per customer (findings c).
- A preview of 100,000 devices with five changes freezes 500,000 field rows. The device cap stays (step4:557).
- Fresh installations now grant the scope that the disputed Schools page reads (`fe/schools/schools.ts:30`). This design changes no Schools code.
- Follow-up: the label "School OU references" (`ac/google-capabilities.ts:31`) now also serves the device picker. A rename waits for the Schools decision.
- Hotspots: the 017 settlement and `worker/src/device-update.ts` with B5 and B6. `016-device-inventory.sql` with U1 and U4, which run in order.
