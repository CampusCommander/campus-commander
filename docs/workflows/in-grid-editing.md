# Edit device fields in the grid, or update one device

Status: owner-confirmed on 2026-10-23. The owner chose the answer "Confirmed: build it as written". The owner approved the mockup on 2026-10-23: "Yea go ahead with this visual design."
Source: owner direction of 2026-10-21 and 2026-10-23, quoted under [Owner direction](#owner-direction).
Design: [Figma page 09](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=94-2), with the frame table and the approved mockup under [Design](#design). Some design gaps remain.
Replaces: none. This record extends [Update device fields](update-device-fields.md).

## User and outcome

The existing administrator edits device fields in the Devices grid and saves the pending changes as one Update device job.
The administrator also updates one device from its details page.
Both paths set Asset tag, which the bulk Update device sheet excludes.
Both paths update Asset tag, Annotated location, Annotated user, Notes, and Organization unit.
Serial, Model, School, Battery, Device contact, and Status stay read-only.

The grid draft holds the pending changes. The person sees the count, the state of each changed cell, and one job per save.
A save with one pending change creates the job directly. A save with more than one pending change passes Review and Confirm first.

## Interaction

### In-grid editing

The administrator starts an edit with Enter, F2, or a double-click on an editable cell (`docs/ui/patterns.md:137`).
Enter or Tab stages a valid value. Escape cancels the active input (`docs/ui/patterns.md:143`).
A pending cell shows a tint, a border, and a revert icon (`docs/ui/patterns.md:146`).
The panel between the filter row and the grid shows "N pending changes · M devices" (`docs/ui/patterns.md:150`).
N counts cells, so one device with two changes counts twice.

One toggle switches between the pending set and the grid.
"Show pending changes" lists the changed devices, inside or outside the current filter (`docs/ui/patterns.md:153`).
"Show all devices" returns to the grid with the person's own filters (`docs/ui/patterns.md:156`).
"Revert all changes" discards every pending change, including offscreen changes (`docs/ui/patterns.md:152`). It asks once and names the count (recorded default 6).
The revert icon on one cell restores that cell's baseline and removes only that pending change (`docs/ui/patterns.md:148`).

"Save changes" validates the set and opens one preview (`docs/ui/patterns.md:151`).
Recorded default 10 reads the devices of the set from Google first.
One pending change creates the job directly. More than one pending change opens Review, then Confirm.
Confirm creates one Update device job with one operation per device and one field row per pending change (`deployment/postgres/migrations/017-jobs.sql:247-257`).
The job page reports each device and field. The grid then shows the confirmed value (`182:4158`).

### Single-device update

The administrator opens device details and presses "Update device" (`94:39`).
The Update device sheet opens for that device.
The sheet holds five fields in record order: Annotated location, Asset tag, Annotated user, Notes, and Organization unit (`docs/ui/designs/2026-10-21-update-device-fields-notes.md:82`).
Each field starts at Leave unchanged. Asset tag offers Replace only (`docs/ui/designs/2026-10-21-update-device-fields-notes.md:84`).
The person edits, reviews, and confirms one Update device job.
The receipt offers "Back to device" (`116:299`).

## Data and access

| Data               | Google source                         | Scope suffix                               |
| ------------------ | ------------------------------------- | ------------------------------------------ |
| Device inventory   | Directory API `chromeosdevices.list`  | `admin.directory.device.chromeos.readonly` |
| Device field write | Directory API `chromeosdevices.patch` | `admin.directory.device.chromeos`          |

All scopes use the `https://www.googleapis.com/auth/` prefix.

Every device update route requires `devices:read`, `devices:write`, and `devices:bulk-actions` at district scope (`api/src/app/devices/device-updates-actions.ts:9-14`).
Without them the cells stay read-only (`108:303`).

Asset tag has three names. The app field is `assetTag`, the Google field is `annotatedAssetId`, and the inventory column is `asset_tag`.
A new value holds at most 256 characters.
The Google reader rejects a longer value and fails the whole device list page (`libs/google-connection/src/lib/devices.ts:48`). This workflow fixes that reader.

The grid draft holds one pending value and one baseline per device and field.
It lives outside the grid row cache, per browser tab and person, in sessionStorage under `cc.device-update-draft.<principal>` (`frontend/src/app/devices/device-update-draft.store.ts:100-106`).
A closed tab discards it. The grid draft and the sheet draft stay separate.

The preview request carries a grid selection key and one value per field today (`libs/application-contracts/src/lib/device-updates.ts:41-44`).
The job operation rows already carry a baseline, a requested value, and an observed value per device and field (`deployment/postgres/migrations/017-jobs.sql:247-257`).
The design addendum adds the edit list, the per-device baseline, the conflict disposition, and `annotatedAssetId`.

Google writes each device on its own (`libs/google-connection/src/lib/devices.ts:805-811`).
A failed device keeps its old value. Nothing undoes a device that succeeded.

## Owner direction

### 2026-10-21, main chat

> We will be doing in-grid editing as well as individual device update like you show in the screens. That is the correct place to set asset tag.

The owner places Asset tag in the in-grid editor and in the single-device update. The bulk Update device sheet keeps Asset tag out.
The full message is in [Update device fields](update-device-fields.md) (`docs/workflows/update-device-fields.md:84`).

### 2026-10-23, main chat: the workflow choice

The owner wrote "2" to the numbered ask "Pick the next workflow". That chose the option "In-grid editing and the single-device update".

### 2026-10-23, main chat: the in-grid design

<!-- prettier-ignore -->
> I want to be clear about the design of the in grid edit. It should be transactional. It should show the state of cells that have changed. Above the grid it should show the count of cells that have a pending change. It should have a button to to toggle between the changed cells and unfiltered view. Each changed cell needs a roll back button icon. in the above the grid area where the info, filter toggle, you have have the save changes button and revert all changes. Save changesd creates a single update devices job.

The owner names seven elements:

1. The edit is transactional.
2. Changed cells show their state.
3. The count above the grid counts cells with a pending change.
4. One toggle switches between the changed cells and the unfiltered view.
5. Each changed cell has a roll back button icon.
6. The area above the grid holds "Save changes" and "Revert all changes".
7. "Save changes" creates one update devices job.

### 2026-10-23, main chat: the answer on the defaults

<!-- prettier-ignore -->
> 1) If it is only ONE change create the job directly. If it is more that one go to the review and confirm as MORE than one can be over multiple pages.
>
> 2 and 3 are aligned with my intent.

His numbers answer the eng-lead's message, not the brief.
His 1) answers ruling 2, Save changes. His 2 answers ruling 4, the single-device update. His 3 answers ruling 1, transactional.

Ruling 2 becomes owner direction.
With exactly one pending change (one cell), "Save changes" creates the job directly, with no Review or Confirm screens.
With more than one pending change, "Save changes" opens Review, then Confirm.
This is an owner exception to UI-07, which requires explicit confirmation for a single-cell edit (`docs/ui/rules.md:95-96`).
The server still creates the job from a preview. The client prepares and confirms that preview in one step for a single change.
The design addendum decides how.

The owner confirmed rulings 1 and 4 on 2026-10-23. Owner: "2 and 3 are aligned with my intent."
The single-device update sheet keeps its Edit, Review, and Confirm steps. That is a default, because the owner's rule speaks about the in-grid Save.

The remaining rulings stay defaults for his confirmation of this record.

## Implementation defaults

These defaults are engineering choices for owner review, not owner decisions, except where marked. Change them when the owner asks. Each item names its sources.

**Ruling 1 of 7: transactional (owner-confirmed 2026-10-23).** Every pending change saves together as one set.
The confirmation creates the job and every operation in one database transaction (`deployment/postgres/migrations/017-jobs.sql:2437-2579`).
Review blocks Confirm while any part of the set cannot write.
Google writes each device on its own (`libs/google-connection/src/lib/devices.ts:805-811`).
The job shows a result for each device. A failed device keeps its old value. Nothing undoes a device that succeeded.

**Ruling 2 of 7: Save changes (owner direction, 2026-10-23).** With exactly one pending change (one cell), "Save changes" creates the job directly.
With more than one pending change, "Save changes" opens Review, then Confirm.
This is the owner's exception to UI-07 (`docs/ui/rules.md:95-96`).
The server creates a job only from a preview (`deployment/postgres/migrations/017-jobs.sql:2437-2579`).
The client prepares and confirms that preview in one step for a single change. The design addendum decides how.

**Ruling 3 of 7: unfiltered view (default, changeable).** "Show all devices" returns the person to the grid with their own filters (`docs/ui/patterns.md:156`).
The alternative is a grid with no filters.

**Ruling 4 of 7: single-device update start (owner-confirmed 2026-10-23).** An "Update device" button on device details starts the single-device update (`94:39`).
It opens the same sheet for that one device, with Asset tag as a fifth field, Replace only.
This is the eng-lead reading of "like you show in the screens". The alternative is Figma's full-page single-device flow.
The sheet keeps its Edit, Review, and Confirm steps. That is a default, because the owner's rule speaks about the in-grid Save.

**Ruling 5 of 7: labels (default, changeable).** The owner's words win over Figma's words.
Use "Save changes" and "Revert all changes", not "Save" and "Clear".
The count says pending changes, not unsaved changes.

**Ruling 6 of 7: Asset tag limit and duplicates (default, changeable).** A new value holds at most 256 characters.
The approved copy is "Use 256 characters or fewer. Spaces alone do not count." (`docs/ui/designs/2026-10-21-update-device-fields-notes.md:270`).
A duplicate tag across devices warns and does not block, because Google documents no uniqueness rule [1][2][3].
The Google reader accepts every value that Google stores. Admin Help says "Size limited to 1KB." [3]
This workflow raises the reader bound, so a 256-character value always reads (`libs/google-connection/src/lib/devices.ts:48`).

**Ruling 7 of 7: request size cap (default, changeable).** The device-update request cap is 4,096 bytes today (`deployment/bootstrap/application-edge.mjs:87-89`, `:193`).
The cap rises so that one save of many pending changes fits. The design addendum sets the new cap.

Recorded defaults, from the findings:

1. Editors: Asset tag text, Annotated location text, Annotated user text, and Notes large text (`docs/ui/entity-grid-fields.json:142`, `:188`, `:149`, `:196`).
   Organization unit uses the built picker dialog (`:165`, `docs/ui/patterns.md:142`).
2. Asset tag is Replace only. An empty Asset tag cell is invalid (`171:1967`).
3. An emptied Annotated location, Annotated user, or Notes cell stages Clear value. Google allows empty values for these fields [1].
4. A duplicate Asset tag gets a Review warning that names the other device's serial number. The write proceeds.
5. Copy: "N pending changes · M devices", "Show pending changes", "Show all devices", "Revert all changes", "Save changes".
6. "Revert all changes" asks once and names the count, because no other path restores the discarded changes.
7. The grid draft persists per tab and person in sessionStorage, as the sheet draft does. Closing the tab discards it.
8. A grid draft holds at most 500 changed devices (`libs/application-contracts/src/lib/devices.ts:97-101`).
   The preview route accepts 98,304 bytes. A larger body answers 413, and the draft stays.
9. Both flows need the Update device permissions. Without them the cells stay read-only (`108:303`).
10. "Save changes" reads the devices of the set from Google, as Refresh Selected does (`api/src/app/devices/devices.controller.ts:216`), before it compares baselines.
11. The build uses AG Grid's built-in editors (`frontend/src/app/devices/device-grid.ts:17-18`), with pending values in the draft store. The build amends the package line of DRAFT-02 (`docs/ui/patterns.md:135`).
12. The grid draft and the sheet draft stay separate.

## Design

Inspected through `figma-notes.md` and the exported frames in `figma/`, on 2026-10-23. The writer had no Figma access.
The frames sit on Figma page 09 (`94:2`) in the file `lqZx6qpWevsN3AAfWkworl`.
Figma values are examples (`docs/ui/rules.md:91`).

| Node       | Frame name                                   | Use                                          |
| ---------- | -------------------------------------------- | -------------------------------------------- |
| `183:4432` | Grid editing and filters · Review index      | Index of the drawn grid states               |
| `213:4411` | Reference / In-cell editor types             | Editor per data type                         |
| `171:842`  | Screen / Entity grids / edit-text            | Asset tag cell edit and the footer keys      |
| `171:1065` | Screen / Entity grids / changed-one          | Pending cell, count, and revert icon         |
| `171:1525` | Screen / Entity grids / changed-two          | Two devices and two fields in one draft      |
| `171:1746` | Screen / Entity grids / changed-filtered     | Pending view with the changed rows only      |
| `182:2807` | Screen / Entity grids / changed-one-filtered | Pending change outside the current filter    |
| `171:1967` | Screen / Entity grids / edit-error           | An empty Asset tag is invalid                |
| `171:1283` | Screen / Entity grids / edit-orgunit         | Organization unit picker                     |
| `108:303`  | Screen / Devices / read-only                 | Cells without the write permission           |
| `182:4158` | Screen / Entity grids / saved-grid-1         | Grid after the job                           |
| `172:2195` | Screen / Entity grids / batch-preview-2      | Review of the grid set                       |
| `172:2420` | Screen / Entity grids / batch-confirm-2      | Confirm of the grid set                      |
| `172:2650` | Screen / Entity grids / batch-receipt-2      | One job accepted for the set                 |
| `172:2866` | Screen / Entity grids / batch-result-2       | Result, success only                         |
| `94:39`    | Screen / Devices / detail                    | "Update device" on device details            |
| `114:278`  | Screen / Devices / single-draft              | Single-device draft, with no Asset tag field |
| `114:335`  | Screen / Devices / single-preview            | Single-device Review                         |
| `114:454`  | Screen / Devices / single-confirm            | Single-device Confirm                        |
| `116:299`  | State / single-receipt                       | Receipt with "Back to device"                |
| `116:344`  | State / single-result                        | Single-device result                         |
| `119:396`  | Screen / Devices / detail-updated            | Device details after the job                 |
| `104:389`  | State / draft-conflict                       | Keep the current value or keep the draft     |

The owner approved the mockup on 2026-10-23. Owner, in the main chat: "Yea go ahead with this visual design."
The approved mockup is [2026-10-23-in-grid-editing.html](../ui/designs/2026-10-23-in-grid-editing.html), stored with its [notes](../ui/designs/2026-10-23-in-grid-editing-notes.md) and 14 PNG states.
The owner approved it as drawn, including the two product questions in the notes' Issues section. The "Select one or more devices to update." note keeps its place above the draft panel. A conflict blocks Save changes until the person resolves it.

| State | PNG                              | What it shows                                                                                                                   | Gap it closes                                                            |
| ----- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 01    | `01-no-pending-changes.png`      | The grid with no pending change. Serial and the five editable columns.                                                          | None. Baseline for the other states.                                     |
| 02    | `02-asset-tag-in-edit.png`       | The Asset tag editor in one cell. The count includes the changed input.                                                         | None. Shows composition choices 5 and 6.                                 |
| 03    | `03-pending-changes.png`         | Five pending cells on four devices, each with its revert icon.                                                                  | None. Shows composition choice 7.                                        |
| 04    | `04-pending-view.png`            | The pending view. The toggle reads "Show all devices".                                                                          | None. Shows composition choice 4.                                        |
| 05    | `05-invalid-cell.png`            | An invalid Notes cell of 512 characters. The reason is in the panel, and Save changes is disabled.                              | None. Gap 6 stays open: the editor and a Clear value cell are not drawn. |
| 06    | `06-conflict-cell.png`           | A conflict cell with the Figma 104:389 card. Save changes is disabled.                                                          | Gap 1.                                                                   |
| 07    | `07-org-unit-picker.png`         | The built picker dialog for one cell.                                                                                           | None. Shows composition choice 12.                                       |
| 08    | `08-revert-all-question.png`     | The revert question, asked once. It names five changes on four devices.                                                         | Gap 4.                                                                   |
| 09    | `09-one-change-saved.png`        | One-change save. The job exists at once, the sheet shows the receipt, and the cell shows the accepted value while the job runs. | Gaps 2 and 8.                                                            |
| 10    | `10-several-changes-review.png`  | The sheet at Review, with one row per device and field.                                                                         | Gap 8.                                                                   |
| 11    | `11-several-changes-confirm.png` | Confirm, with one sentence per device and field.                                                                                | Gap 8.                                                                   |
| 12    | `12-update-job.png`              | The job page, with one row per device and field. 04QVJBY failed on Google quota.                                                | Gaps 3 and 5.                                                            |
| 13    | `13-device-details.png`          | "Update device" on device details.                                                                                              | None. Gap 10 stays open for the button without permission.               |
| 14    | `14-single-device-sheet.png`     | The single-device sheet with five fields. Asset tag is set to Update.                                                           | Gaps 7 and 8.                                                            |

Design gaps:

1. No frame shows a conflict cell. **Closed by state 06.** The cell shows the Figma 104:389 card and disables Save changes.
2. No frame shows a cell while its job runs. **Closed by state 09.** The cell shows the accepted value, a clock icon, and the job in its tooltip.
3. No frame shows a failed write. **Closed by state 12.** The 04QVJBY row shows the Google quota failure and keeps its old value.
4. No frame shows the "Revert all changes" question. **Closed by state 08.** The question names five changes on four devices.
5. No frame shows a partial failure of a grid job. **Closed by state 12.** One job shows four succeeded rows and one failed row.
6. No frame shows an in-cell editor for Annotated location, Annotated user, or Notes. No frame shows Clear value in a cell. **Open.** State 02 draws the Asset tag editor only. State 05 shows a Notes value pasted over its limit, not the Notes editor. Composition choice 9 records that an emptied Notes cell stages Clear value, and no state draws such a cell.
7. No frame shows Asset tag in the single-device draft. `114:278` says "Asset tag and notes remain unchanged." **Closed by state 14.** The sheet holds five fields in record order, with Asset tag set to Update.
8. No frame shows either flow inside the Update device sheet. **Closed by states 09, 10, 11, and 14.** States 09 to 11 show the grid flow at Receipt, Review, and Confirm. State 14 shows the single-device flow.
9. No frame shows a duplicate Asset tag warning. **Open.** No state draws it. It will show on Review.
10. No frame shows the "Update device" button without permission. **Open.** State 13 shows the button with permission only.

## Exclusions and open decisions

Excluded from this build:

- CSV import and export. Parked, a later workflow.
- Asset tag on the bulk Update device sheet.
- New navigation destinations.
- Live Google writes.
- Every device field outside the five editable fields.

Open decisions:

- The owner confirmed this record on 2026-10-23, before any design or implementation. He chose the answer "Confirmed: build it as written".
- The design addendum decides the one-change path, the request size cap, and the per-device contract.
- These design gaps need a composition before their screens are built: the in-cell editors for Annotated location, Annotated user, and Notes, Clear value in a cell, the duplicate Asset tag warning on Review, and the "Update device" button without permission.
- Live device writes need explicit owner authorization and an enrolled test device.

## Risks

1. "Transactional" read as all or nothing at Google. Google applies each device on its own, and one device can take some fields and not others. A partial failure leaves some devices or fields updated. Ruling 1, the Review gate, and per-device results bound the surprise (`libs/google-connection/src/lib/devices.ts:805-811`).
2. Stale inventory. The cache counts as fresh for 24 hours. A value set in the Admin console after the last sync gets overwritten without a conflict (`libs/application-contracts/src/lib/entity-cache.ts:16-18`).
3. Preview body cap. At 4,096 bytes an edit list fails after about 30 Asset tag edits. Ruling 7 and recorded default 8 close the gap.
4. Grid editing package. DRAFT-02 names `@libregrid/batch-edit`, which supports the client-side row model only. The device grid uses the server-side row model, and GRID-05 forbids switching (`docs/ui/patterns.md:135`, `:164-170`).
5. Asset tag reader bound. A value of 256 characters outside the Basic Multilingual Plane exceeds 256 UTF-16 units and fails the list page (`libs/google-connection/src/lib/devices.ts:48`). Ruling 6 closes it.
6. Two drafts on one device field. A pending change and a sheet draft can change one field in two jobs, and the later job wins. Recorded default 12 keeps the drafts apart.
7. Draft loss. A closed tab loses a long grid draft. Recorded default 7 keeps the draft for the tab only.

## Completion

Demonstrate on admin-sdk-mock:

1. Edit two cells on two devices. Each cell shows its pending state, and the panel shows the count of pending changes.
2. Toggle between "Show pending changes" and "Show all devices". The pending view lists changed rows inside and outside the current filter.
3. Revert one cell with its icon, then revert all changes. The question names the count, and the pending set clears.
4. Save one pending change. The job starts with no Review or Confirm screen.
5. Save more than one pending change. Review and Confirm open, and Confirm creates one job with a row per device and field.
6. A failed device keeps its old value, and a stale baseline shows a conflict cell.
7. Update one device from device details with Asset tag. Edit, Review, and Confirm create one job.

Run lint, tests, and builds for the affected Nx projects. Keep live write behavior marked "not verified".

## Sources

[1] https://developers.google.com/workspace/admin/directory/reference/rest/v1/chromeosdevices
[2] https://developers.google.com/workspace/admin/directory/reference/rest/v1/chromeosdevices/patch
[3] https://support.google.com/chrome/a/answer/1698333?hl=en
