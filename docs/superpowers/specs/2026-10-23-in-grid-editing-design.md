# Technical design addendum: in-grid editing and the single-device update

Status: design for review. Card `t_4e7487d1`.
Record: `docs/workflows/in-grid-editing.md` (PR #124). On 2026-10-23 the owner chose the answer "Confirmed: build it as written" (`record:3`).
Extends: [the Update device design](2026-10-21-update-device-fields-design.md). A later CSV import reuses this design (section 1).
Owner direction, 2026-10-19: "We are building a doghouse. We dont need to choose the curtains."

## Conventions

- Paths are relative to the repository root at `77500a9`, the base of this card.
- `record:N` cites the record. `fields:N` cites `2026-10-21-update-device-fields-design.md`. `patterns:N` cites `docs/ui/patterns.md`.
- `016` and `017` name files in `deployment/postgres/migrations/`. `worker:N` cites `worker/src/device-update.ts`. `edge:N` cites `deployment/bootstrap/application-edge.mjs`.
- `ac/` is `libs/application-contracts/src/lib/`, `gc/` is `libs/google-connection/src/lib/`, `api/` is `api/src/app/`, and `fe/` is `frontend/src/app/`.
- `mock:` names `node_modules/@campuscommander/admin-sdk-mock/dist/src/`, version 0.2.0.
- `findings` and `csv` name the `findings.md` files in `~/engineering-team/workspace/in-grid-editing/` and `~/engineering-team/workspace/csv-round-trip/`.
- The findings cite `d5dc91d`. `git diff d5dc91d 77500a9` changes docs only. This design re-read every cited line at `77500a9`.
- Node IDs such as `171:1065` name frames on Figma page 09 (`record:183-211`).

## Decision summary

1. A new route `POST api/devices/updates/edit-previews` takes an edit list. Each edit names a device, field, mode, value, and baseline.
2. Each frozen field row stores its request and its baseline. Confirmation copies the request. One row digest serves both variants at action version 3.
3. The edit route reads every edited device from Google before it compares. It stores that read as a refresh read.
4. A row whose current value differs from its baseline and its request is a `conflict`. A preview with a conflict never confirms.
5. With one pending change, the client prepares the preview and confirms it in one step. The confirm body stays.
6. The grid uses AG Grid's text and large-text editors and the built OU picker. The draft store holds pending values outside the row cache.
7. Asset tag joins as `annotatedAssetId`: 256 code points, Replace only, edit lists only. Its reader and its column accept 4,096.
8. The edit route accepts 98,304 bytes. The selection route keeps 4,096.
9. Device details gains "Update device". The sheet opens for that device with five fields.
10. Five backend cards, five frontend cards, and one qa card build the change.

## 1. Contracts

**Edit list.** `POST api/devices/updates/edit-previews` takes `{ edits }`. The schema joins `ac/device-updates.ts`.

| Key                      | Rule                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `edits`                  | 1 to 2,500 edits on at most 500 devices (`ac/devices.ts:97-101`). A device and field occur once. |
| `deviceId`               | The device ID rule of `ac/device-updates.ts:13`.                                                 |
| `field`, `mode`, `value` | The rules of `deviceUpdateChangeSchema` (`ac/devices.ts:435-477`), with Asset tag added.         |
| `baselineValue`          | Null or at most 4,096 UTF-16 units. It holds the value that the person saw when the edit began.  |

- An edit whose request equals its baseline is invalid. Paths compare without case.
- A refusal names the field label and its limit, as today (`api/devices/device-updates.ts:256-268`).
- The selection request keeps its shape (`ac/device-updates.ts:41-44`). A selection change of Asset tag answers 400.
- The grid draft, the single-device sheet, and a later CSV import build edit lists. The import fills each baseline from its baseline file (`csv:86`).

**Asset tag.**

- `DEVICE_UPDATE_FIELD_ORDER` takes the record order: `annotatedLocation`, `annotatedAssetId`, `annotatedUser`, `notes`, `orgUnitPath`.
- The sheet notes fix that order (`docs/ui/designs/2026-10-21-update-device-fields-notes.md:82`). Rows, bodies, the digest, and SQL arrays follow it.
- `annotatedAssetId` has the label "Asset tag", a limit of 256 code points, and Replace only. A value needs a visible character, with no trim.
- The field ID equals the Google property, as each field ID does (`gc/devices.ts:107-113`). The record key stays `assetTag` (`record:62`).
- A new `DEVICE_UPDATE_SELECTION_FIELDS` keeps the four fields of the bulk sheet. The bulk draft and its sentences read it.
- `jobOperationFieldSchema` and the operation ID pattern add the field (`ac/jobs.ts:28-41`).

**Answers.**

| Contract                                       | Change                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview summary (`ac/device-updates.ts:50-75`) | `changes` answers null for an edit list. A new count `conflicts` counts devices. Selected equals eligible, unchanged, excluded, and conflicts. |
| Target row (`ac/device-updates.ts:79-88`)      | `disposition` adds `conflict`. New keys `baselineValue` and `duplicateSerialNumber` hold null or a string. `approvedValue` reads the row.      |
| Confirm body and receipt (`:105-124`)          | Unchanged.                                                                                                                                     |
| Job detail (`ac/jobs.ts:245`)                  | `changes` answers null for an edit-list job. Its action stays `update-device-annotations`.                                                     |

- A device takes the first match. Only `excluded` rows make it `excluded`. One `conflict` row makes it `conflict`, and one `eligible` row makes it `eligible`.
- Every other device is `unchanged`.
- `fieldChanges` keeps counting eligible rows (`ac/device-updates.ts:56-57`).
- The preview, targets, and confirm routes serve both variants by preview ID (`api/devices/device-updates.controller.ts:119-170`).
- Confirm of a preview with a conflict answers 409 `preview-conflict`.

**CSV import.** The edit builder takes the edits and the current rows. The edit route supplies rows from its fresh read (section 4).
An import above 500 devices supplies rows from its own read job. Its upload route and cap stay separate (`csv:110`, findings:111-116).

## 2. Schema

Each change edits 017 in place. Development data is disposable (`AGENTS.md:27`).

| Object                                                     | Change                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cc.device_update_target_fields` (`017:137-146`)           | New `requested_value` and `baseline_value`, each null or at most 4,096 code points. The field check adds `annotatedAssetId`. The disposition check adds `conflict`. Request checks mirror `017:110-115`. An Asset tag request holds 1 to 256 code points and is not null. |
| `cc.device_update_preview_targets` (`017:128`)             | The disposition check adds `conflict`.                                                                                                                                                                                                                                    |
| `cc.device_update_previews` (`017:85-96`)                  | New `conflicts integer NOT NULL DEFAULT 0`. The sum check at `017:96` adds it.                                                                                                                                                                                            |
| `cc.device_update_changes` (`017:104-116`)                 | Unchanged. Only a selection preview writes it.                                                                                                                                                                                                                            |
| `cc.create_device_update_preview` (`017:2196-2376`)        | A null `p_changes` marks an edit list. Each of its targets holds 1 to 5 field rows, each field once. A selection target keeps one row per change, and each request equals its change. Every row stores both values. Version 3.                                            |
| `cc.read_device_update_preview_manifest` (`017:2378-2432`) | Version 3 (`017:2403`). Each target adds its field rows and values. A conflict answers `preview-conflict` before the API stores an artifact.                                                                                                                              |
| `cc.confirm_device_update_preview` (`017:2434-2579`)       | Version 3 (`017:2470`). A conflict answers `preview-conflict`. Field rows copy `f.requested_value`, and the change join goes (`:2563-2570`).                                                                                                                              |

- A selection row stores its observed value as its baseline, so the conflict rule never fires for it.
- Digest: SHA-256 over the canonical JSON `{ actionVersion: 3, targets }` (today `api/devices/device-updates.ts:174-196`).
- `targets` lists `[deviceId, [[field, requestedValue, observedValue, baselineValue], ...]]` for each eligible device, sorted by device ID.
- Each device lists its eligible rows in contract order. The digest drops `changes`, because each row carries its request.
- Both builders call one digest function. A version 2 preview answers `preview-changed` (`017:2400-2405`).
- The function counts conflict devices beside the other counts (`017:2337-2344`). The 100,000-target cap stays (`017:2259`).
- Operation field rows stay (`017:247-257`). Card IB3 widens their field check.

## 3. One pending change

Owner, 2026-10-23 (`record:108`):

<!-- prettier-ignore -->
> 1) If it is only ONE change create the job directly. If it is more that one go to the review and confirm as MORE than one can be over multiple pages.

- The server still creates a job only from a preview and a confirm (`017:2434-2579`). The client sends both requests in sequence.
- Save changes with one pending cell sends an edit list with one edit. Section 4 reads Google first.
- The client confirms only when the answer holds one eligible device, one field change, and `stale` false.
- Digest: unchanged. The client sends the answer's `manifestDigest`, so the confirm binds to the one row that the client prepared.
- Acknowledgment: the press of Save changes. The owner's direction replaces Review and Confirm for one change (`record:116-118`).
- The confirm body keeps `acknowledged: true` (`ac/device-updates.ts:106-109`). The job names the person as confirmer, as today.
- Before the confirm request, the confirmation store records the preview ID and the digest (`fe/devices/device-update-confirmation.store.ts:14-21`). A replay never creates a second job.
- Any other answer creates no job. An unchanged row leaves the draft, because Google already holds the value.
- A conflict or an excluded row marks its cell (section 5). A duplicate Asset tag does not stop the save. The receipt line names the other serial number.

## 4. Baseline and conflict

Fresh read at Save (record default 10, `record:177`):

1. The edit route checks every device ID against the inventory. An unknown ID answers 422 `unknown-device` before any Google call.
2. Postgres stamps the read time before the Google call (pattern `worker/src/entity-sync.ts:181-188`).
3. The route opens the credential and reads each edited device with `deviceBatch` (`gc/devices.ts:722-785`).
4. One 25-second deadline covers steps 2 and 3 (`api/devices/device-write-access.ts:36-39`), as in `api/devices/device-org-unit-tree.ts:95-124`.
5. The route stores the read through `cc.upsert_devices(..., 'read')` and `cc.soft_delete_devices` (pattern `worker/src/entity-sync.ts:222-237`).
6. Redis entries then lose to the newer Postgres rows through the version check (`api/devices/device-pager.ts:154-160`).
7. The route reads the rows from Postgres and compares each edit.

- A failed read creates no preview. The route answers 503 `device-read-failed` with the Google failure code (`ac/google-connection.ts:53-66`).
- The deadline answers `network-failure`. The draft stays.
- The API becomes the second caller of `cc.upsert_devices`. The refresh job of the worker stays the first (`worker/src/entity-sync.ts:223`).
- The read skips telemetry. Battery data keeps its stored values.

Compare per edit, first match wins. C is the current value, B the baseline, and R the request.

| Case                                                 | Row                                                                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Google answers 404, or the device holds `removed_at` | `excluded`, reason `removed`. A non-plain ID gives `invalid-device-id` (`api/devices/device-updates.ts:135-139`). |
| C equals R                                           | `unchanged`. Google already holds the request.                                                                    |
| C differs from B                                     | `conflict`                                                                                                        |
| Otherwise                                            | `eligible`                                                                                                        |

- Text compares exactly. Paths compare without case (`api/devices/device-updates.ts:111-123`).
- The table matches the B, E, and C rules of the CSV research (`csv:89-93`).
- Keep current value removes the pending change. Keep my draft sets the baseline to C (`104:389`, `patterns:129`). Each choice needs a new preview.
- A Google change after the read and before the PATCH still loses. Risk 2 of the record narrows to this window (`record:247`).

## 5. The grid

| Column             | Editor                                                                 | Rule and limit                                            |
| ------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| Asset tag          | `agTextCellEditor`                                                     | Replace only. An empty cell is invalid (`171:1967`). 256. |
| Annotated location | `agTextCellEditor`                                                     | An emptied cell stages Clear value. 200.                  |
| Annotated user     | `agTextCellEditor`                                                     | An emptied cell stages Clear value. 100.                  |
| Notes              | `agLargeTextCellEditor`                                                | An emptied cell stages Clear value. 500.                  |
| Organization unit  | The built picker dialog (`fe/devices/device-org-unit-picker.ts:42-51`) | Move only.                                                |

- `AllCommunityModule` already brings both editors (`fe/devices/device-grid.ts:66-67`). No package joins (record default 11).
- The grid sets `readOnlyEdit`, so an edit never writes row data. The `onCellEditRequest` handler validates and stages the value.
- A cell renders its pending value from the draft store over the row value. Refresh, paging, sorting, and SSE updates keep it (`patterns:124-127`).
- Limits count code points. A value of spaces alone is invalid. A value equal to its baseline removes the entry (`patterns:149`).
- Enter, F2, or a double-click on an Organization unit cell opens the picker for that device. "Stage change" stages the path and unit ID.
- The picker reads the OU tree route (`fields:181-186`). A state other than `granted` keeps the column read-only with the route's note.
- A person without the three Update device actions sees read-only cells (`api/devices/device-updates-actions.ts:9-14`, `108:303`).

Grid draft:

- The draft store keeps one document per tab and person under `cc.device-update-draft.<principal>` (`record:66-68`).
- That document holds three separate parts: the sheet draft, the grid draft, and the single-device draft. No part reads another (`record:179`).
- A grid entry holds the device ID, field, mode, value, baseline, and the unit ID of a Move. Its state is pending, invalid, or conflict.
- A conflict entry adds the current value. An invalid value stays in its cell and its entry (`171:1967`).
- Save changes stays disabled while an entry is invalid or in conflict (`patterns:159`).
- The draft holds at most 500 devices (`record:174`). The draft refuses an edit of a 501st device and names the limit.
- N counts the entries and M counts their devices. The panel reads "N pending changes · M devices" (`record:171`).
- Revert one removes its entry (`patterns:148`). Revert all changes asks once with N, then clears the grid part (`record:172`).
- After acceptance, the client removes each submitted entry whose value still equals the submitted value (`patterns:160-161`).
- A lost permission or an offline state keeps the draft (`patterns:158`).

Pending view:

- "Show pending changes" switches the datasource to the draft's device IDs. One `POST api/devices/by-ids` reads them (`fe/devices/devices.store.ts:795`).
- The view shows flat rows outside the person's filters and grouping. The browser sorts them by the active sort model.
- "Show all devices" restores the person's own query (`record:143`). Neither toggle changes the draft (`patterns:156`).

Save changes (more than one change):

- Save changes stops the active editor, prepares one edit preview, and opens the Update device sheet at Review.
- Review keeps Continue disabled while the preview holds a conflict or an excluded device (`record:133`).
- Conflict and excluded rows also mark their cells. Unchanged rows leave the draft after acceptance.
- The mockup decides the compositions of design gaps 1 to 8 (`record:213-223`).

## 6. Asset tag

Write:

- The PATCH body key is `annotatedAssetId` (`gc/devices.ts:137-154`). The worker reads the answer's `assetTag` for it (`worker:640-684`).
- The worker compares Asset tag exactly. The copy of the limit comes from `docs/ui/designs/2026-10-21-update-device-fields-notes.md:270`.
- A succeeded write publishes `asset_tag` with a new stamp `asset_tag_observed_at` and an overlay (`017:1280-1340`).
- `asset_tag` leaves the row rule (`016:414-415`) for the stamp rule of `annotated_location` (`016:455-465`).
- The list clauses compare the overlay with the observation key `assetTag` (`016:477-527`).

Duplicate:

- The targets page fills `duplicateSerialNumber` for an eligible Asset tag row. The index `devices_asset` serves the lookup (`016:67`).
- It names a device whose inventory tag equals the request and whose tag this preview leaves alone.
- Another row of this preview with the same request counts too. A swap of two tags therefore gives no warning.
- The warning never blocks (`record:157`, `:170`).

Reader:

| Reader                                             | Today            | New                |
| -------------------------------------------------- | ---------------- | ------------------ |
| Google reader (`gc/devices.ts:48`)                 | 256 UTF-16 units | 4,096 UTF-16 units |
| Observation and record (`ac/devices.ts:44`, `:66`) | 256 UTF-16 units | 4,096 UTF-16 units |
| Inventory column (`016:39`)                        | 256 code points  | 4,096 code points  |

- Admin Help says "Size limited to 1KB." (`record:158`). 1 KB of UTF-8 holds at most 1,024 UTF-16 units, so every stored tag reads.
- The bound matches the three annotation readers (`gc/devices.ts:51-53`, `fields:170`).
- A value that the reader accepts fits the column, because its UTF-16 unit count bounds its code point count.
- The settlement check at `017:1093-1106` needs no new clause. Its 4,096 bound equals the widened column.
- A B-tree entry holds at most 2,704 bytes. A tag within Google's 1 KB fits `devices_asset`.

## 7. Request size cap

- Today the Update device routes fall to 4,096 bytes (`edge:87-89`, `:193`). One body holds about 29 short Asset tag edits.
- The edit route joins the 98,304-byte branch of the device write routes (`edge:181-185`, `record:175`).
- One body then carries about 700 short Asset tag edits, or 88 Notes edits of 500 characters. The estimate uses 36-character device IDs.
- A larger body answers 413. The client keeps the draft and names the limit (`record:175`).
- The selection preview and confirm routes keep 4,096 bytes. Their bodies hold a selection key or a digest.
- The Nest JSON parser keeps its 100 KiB default (`node_modules/@nestjs/platform-express/node_modules/body-parser/lib/utils.js:62`).

## 8. Single-device update

- Device details adds "Update device" between "Back to devices" and "Next device" (`94:39`, `fe/devices/device-detail.html:24-34`).
- Without the three Update device actions, the button stays disabled with a note beside it (`docs/ui/rules.md:73`).
- The sheet opens over device details for that device. Five fields follow the record order, each at Leave unchanged (`record:45-46`).
- Asset tag offers Replace only. The other four fields keep their modes (`fields:34-39`).
- Each baseline is the value that device details showed. The sheet sends an edit list for that one device.
- Edit, Review, and Confirm stay (`record:123`). The receipt adds "Back to device" (`116:299`), which reloads device details.
- The single-device draft holds one device. A sheet for another device starts empty and replaces it.
- The sheet takes a source: the selection, the grid set, or one device. The selection source keeps its steps and copy.

## 9. The bulk Update device

On 2026-10-22 the owner signed off the Update device fields workflow. Owner: "Signed off" (`docs/current-work.md:9`).

Internal changes:

- The selection builder writes each row's request and its observed value as the baseline. Confirmation copies the request from the row.
- Previews and confirmation move to action version 3 and the row digest.
- The manifest adds field rows. The targets page reads `approvedValue` from the row and answers `baselineValue`.
- The summary answers `conflicts: 0`. The field order gains Asset tag, and a selection change of Asset tag answers 400.

Unchanged:

- Four fields, their modes, limits, copy, counts, and row order (`docs/current-work.md:64-67`).
- The selection route body, its 4,096-byte cap, and its cached read. It never reads Google.
- The Confirm sentence reads the four selection fields (`fe/devices/device-update-flow.ts:519-536`), so it never names Asset tag.

These suites keep the bulk flow intact. Each card that touches the pipeline runs them unchanged, except for the digest version.

- `deployment:postgres-integration`: `deployment/postgres/device-updates.integration.mjs` and `device-write-jobs.integration.mjs`.
- `api:test`: `api/src/app/devices/device-updates.test.mjs` and `device-updates-route.test.mjs`.
- `api-e2e:admin-sdk-mock-integration`: the selection jobs of `api-e2e/device-write-mock.mjs`.
- `frontend:test`: `fe/devices/device-update-*.spec.ts`. `deployment:bootstrap-test`: `deployment/bootstrap/application-edge.test.mjs`.
- `frontend-e2e:e2e`: `device-update-sheet.spec.ts`, `device-update-sheet-fields.spec.ts`, `device-update-ou-picker.spec.ts`, and `device-update-u6-review.spec.ts`.

## 10. Tests

No test calls Google. Answers come from admin-sdk-mock or from fakes. `api-e2e:admin-sdk-mock-integration` runs the mock (`api-e2e/project.json:42-59`).

| Decision            | Target                                                                     | Proof                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts           | `application-contracts:test`                                               | Each limit at N and N+1 code points. Asset tag refuses Clear and spaces. A selection Asset tag change, a repeated pair, and a 501st device fail.  |
| Rows and confirm    | `deployment:postgres-integration`                                          | Values per device reach the operation field rows. A conflict answers `preview-conflict` with no job. Version 2 answers `preview-changed`.         |
| Digest              | `api:test`                                                                 | The version 3 digest of a fixed selection input and of a fixed edit list.                                                                         |
| Fresh read          | `api:test`                                                                 | Each row of the compare table. The stamp precedes the read. A failed read answers 503 and leaves no preview.                                      |
| Fresh read, mock    | `api-e2e:admin-sdk-mock-integration`                                       | A direct mock PATCH after the grid read makes `conflict`. The lagged list hides it, and the GET returns it (`mock:directory/devices.js:170-179`). |
| Partial failure     | `api-e2e:admin-sdk-mock-integration`                                       | A `status` fault with `count: 1` on `directory.chromeosdevices.patch` refuses one device. That device keeps its old value.                        |
| Asset tag write     | `google-connection:test`, `worker:test`, `deployment:postgres-integration` | The PATCH key, the exact compare, the publication, the stamp, and the overlay. A lagged list keeps the overlay value.                             |
| Asset tag reader    | `google-connection:test`, `deployment:postgres-integration`                | A 1,024-character tag and a tag of 300 supplementary characters read and store.                                                                   |
| Duplicate           | `api:test`, `deployment:postgres-integration`                              | A request equal to another device's tag names that serial number. A swap of two tags names none.                                                  |
| Cap                 | `deployment:bootstrap-test`                                                | The edit route accepts 98,304 bytes and answers 413 at 98,305. The selection route answers 413 at 4,097.                                          |
| One change and grid | `frontend:test`, `frontend-e2e:e2e` (Chromium)                             | Completion steps 1 to 6 (`record:258-263`) with mocked answers. A lost confirm answer replays the same preview ID and digest.                     |
| Single device       | `frontend:test`, `frontend-e2e:e2e` (Chromium)                             | Completion step 7 (`record:264`) with mocked answers.                                                                                             |

The mock offers PATCH with no Asset tag limit (`mock:directory/device-writes.js:11-16`). Tests therefore show no Google refusal of a long tag.
A direct mock PATCH takes a token from the control API, after the pattern of `api-e2e/device-write-mock.mjs:22-37`.

## Card plan

| ID  | Title                                                  | Profile  | Depends on             |
| --- | ------------------------------------------------------ | -------- | ---------------------- |
| IB1 | Inventory: read every Asset tag that Google stores     | backend  | none                   |
| IB2 | Contracts: five fields, the edit list, and conflicts   | backend  | IB1                    |
| IB3 | Write jobs: Asset tag                                  | backend  | IB1, IB2               |
| IB4 | Previews and confirm: values per row                   | backend  | IB2, IB3               |
| IB5 | Edit route: fresh read, compare, and duplicate warning | backend  | IB4                    |
| IF1 | Devices grid: in-cell editors and the grid draft       | frontend | IB2, mockup            |
| IF2 | Devices grid: the pending view                         | frontend | IF1, mockup            |
| IF3 | Devices grid: Save changes                             | frontend | IB5, IF2, mockup       |
| IF4 | Device details: Update device                          | frontend | IB5, IF3, mockup       |
| IF5 | Jobs: update jobs without shared changes               | frontend | IB4, mockup            |
| IQ1 | Rehearse the seven completion steps                    | qa       | IB1 to IB5, IF1 to IF5 |

- IDs are local to this design. IB5 opens the edit route last, so each job that it creates has a worker and a jobs page.
- Each card that changes a contract updates every consumer, including `api-e2e` and the `frontend-e2e` fixtures (`fields:253`).
- Each frontend card waits for its API card and for the owner's answer on the mockup (`record:225`).

**IB1.** Scope: section 6 Reader, in `gc/devices.ts:48`, `ac/devices.ts:44`, `:66`, and `016:39`.
Acceptance: the reader rows of section 10 pass. After Refresh all on the mock, a device with a 1,024-character tag lists.

**IB2.** Scope: section 1 in `ac/devices.ts:385-489`, `ac/device-updates.ts`, and `ac/jobs.ts:28-41`, with the compile fixes below.
The bulk draft takes the selection field type (`fe/devices/device-update-draft.store.ts:66-98`, `:113`).
`fe/devices/device-update-flow.ts:437`, `:510`, `:519-536`, and `fe/devices/device-update-sheet.ts:246` read null `changes` as no change.
`api/devices/device-updates.ts:96-101` maps `annotatedAssetId` to `asset_tag`. Until IB4, the API answers `conflicts: 0` and the observed value as baseline.
Acceptance: the Contracts row of section 10 passes. `frontend:build`, `api:test`, and the bulk suites of section 9 pass.

**IB3.** Scope: section 6 Write. Files: `gc/devices.ts:107-113`, `worker:131-136`, `:154`, `:640-684`, and `api/jobs/jobs.ts:222-228`.
In 017: `:250`, `:263`, `:1280-1340`, and the field arrays at `:437`, `:866`, `:1205`, `:1441`, `:1488`, and `:1508`. In 016: `:54-59` and `:414-527`.
Tests seed Asset tag jobs, because no preview creates them before IB5.
Acceptance: the Asset tag write row of section 10 passes. A seeded job sets two tags on two mock devices and ends `completed`.
A Refresh all inside 300 s keeps both tags. The step 4 and Update device job suites pass.

**IB4.** Scope: section 2, the selection rows of section 9, and `api/devices/device-update-rows.ts:42-58`.
It also covers the targets filter (`api/devices/device-updates.controller.ts:29-37`) and `preview-conflict` (`api/devices/device-updates.ts:270-297`).
Acceptance: the Rows and confirm and the Digest rows of section 10 pass. An edit-list call of the SQL function freezes a value per device.
Confirm copies each value into the operation field rows. The bulk suites of section 9 pass.

**IB5.** Scope: section 4, the duplicate lookup of section 6, and section 7.
Files: `api/devices/device-updates.controller.ts`, `api/devices/device-updates.ts`, a new fresh-read module in `api/devices/`, and `edge:87-89`, `:181-185`.
Acceptance: the Fresh read, Fresh read mock, Partial failure, Duplicate, and Cap rows of section 10 pass.
On the mock, one edit list sets two Asset tags and one Notes value on two devices. One job ends with three rows.

**IF1.** Scope: the editors and the grid draft of section 5, the panel count, and both revert actions.
It amends `patterns:135` and `docs/ui/entity-grid-fields.json:32`, `:37`, and `:149` (record default 11).
Acceptance: completion steps 1 and 3 (`record:258`, `:260`) pass. A reload restores the draft. The draft refuses a 501st device.

**IF2.** Scope: the pending view of section 5. Acceptance: completion step 2 (`record:259`) passes, with a pending row outside the current filter.

**IF3.** Scope: section 3, Save changes of section 5, and the grid source of the Update device sheet.
It covers the 413 and 503 answers and the conflict, excluded, and unchanged cells.
Acceptance: completion steps 4, 5, and 6 (`record:261-263`) pass. A lost confirm answer replays the same preview ID and digest.

**IF4.** Scope: section 8 in `fe/devices/device-detail.*`, the device source of the sheet, and the single-device part of the draft.
Acceptance: completion step 7 (`record:264`) passes. The bulk sheet still shows four fields.

**IF5.** Scope: `fe/jobs/job-detail-fields.ts:434` and `:679` read the job action, not `changes`. Asset tag rows show the label "Asset tag".
Acceptance: a mocked edit-list job shows the update failure sentence and no row total.

**IQ1.** Acceptance: each step of `record:256-266` passes on admin-sdk-mock, with screenshots. Lint, tests, and builds of the affected projects pass.
Step 6 uses the Partial failure fault and a direct mock PATCH. Live device writes stay "not verified" (`record:266`).

**Shared files.** Each shared file sits on one dependency path, so no two parallel cards edit one file.

| File                                                                      | Cards, in merge order        |
| ------------------------------------------------------------------------- | ---------------------------- |
| `libs/application-contracts/src/lib/devices.ts`                           | IB1 (`:44`, `:66`), then IB2 |
| `libs/google-connection/src/lib/devices.ts`                               | IB1 (`:48`), then IB3        |
| `deployment/postgres/migrations/016-device-inventory.sql`                 | IB1 (`:39`), then IB3        |
| `deployment/postgres/migrations/017-jobs.sql`                             | IB3, then IB4                |
| `api/src/app/devices/device-updates.ts`, `device-update-rows.ts`          | IB2, then IB4, then IB5      |
| `api-e2e/device-write-mock.mjs`                                           | IB3, then IB5                |
| `frontend/src/app/devices/device-update-draft.store.ts`                   | IB2, then IF1, then IF4      |
| `frontend/src/app/devices/device-update-flow.ts`, `device-update-sheet.*` | IB2, then IF3, then IF4      |
| `frontend/src/app/devices/device-grid.ts`, `devices.html`, `devices.ts`   | IF1, then IF2, then IF3      |
| `frontend-e2e/src/device-update-mock.ts`, `device-update-u6-simulator.ts` | IB2, then IF3, then IF4      |

## Risks

1. The API reads Google in the edit route. A slow read fails the save with 503 after 25 s, and the draft stays.
2. A Google change between the read and the PATCH still loses (`record:247`). The window lasts until the job runs.
3. A draft above 98,304 bytes answers 413. The person saves in parts.
4. A tag above 2,704 bytes fails the `devices_asset` index. Google's 1 KB limit keeps every stored tag below it.
5. Google can normalize an Asset tag. The job then settles `value-differs` with Google's value as evidence (`fields:338`).
6. Live device writes stay unverified. They need the owner's authorization and an enrolled test device (`record:242`).
