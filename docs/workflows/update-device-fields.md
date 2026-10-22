# Update annotated user, notes, and organization unit on selected devices

Status: owner-confirmed on 2026-10-21. Owner, in the main chat: "compete 81", which completes PR #81 with this record.
Source: owner direction of 2026-10-21, quoted under [Owner direction](#owner-direction--2026-10-21). Earlier decisions govern the rest of this record.
Design: [Figma page 09](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=94-2), with the node links under [Design](#design). Design gaps remain.
Replaces: none. This record extends [Update the annotated location of selected devices](update-device-annotated-location.md).

## User and outcome

The existing administrator edits four fields on selected ChromeOS devices.
Annotated location is built. This record adds Annotated user, Notes, and Organization unit.
The administrator changes any of the four fields in one draft and confirms one job.

Step 4 supplies the bulk action sheet, the preview, the confirmation, the job, and the in-place grid update.
This record extends the draft to four fields and gives each changed field its own mode.
The result is one preview, one job, and one Google PATCH per device for every changed field.

## Interaction

The administrator selects devices and opens Update device from Bulk Actions, as [step 4](update-device-annotated-location.md) builds it.
The bulk action sheet holds one draft with the four fields.
Each field starts at "Leave unchanged" (`94:75`).

- Annotated location, Annotated user, and Notes offer Replace or Clear.
- Organization unit offers Move, to an OU chosen in the OU picker dialog (`171:1283`, TREE-01, `docs/ui/patterns.md:327-331`).

Values are limited per field: Annotated location 200 characters (built), Annotated user 100, and Notes 500.
Google documents 100 characters for Annotated user and 500 for Notes.
A value over its limit cannot be submitted, and the message names the field and the limit.

One preview, one confirmation, one job, and one Google PATCH per device carry every changed field.
The preview and the job detail show one row per device and changed field (`97:21`, Field column).
The receipt, the admission hold, the reconcile step, and the in-place grid update stay as step 4 built them.

## Data and access

| Data                   | Google source                         | Scope suffix                               |
| ---------------------- | ------------------------------------- | ------------------------------------------ |
| Device inventory       | Directory API `chromeosdevices.list`  | `admin.directory.device.chromeos.readonly` |
| Device field write     | Directory API `chromeosdevices.patch` | `admin.directory.device.chromeos`          |
| Organization unit tree | Directory API `orgunits.list`         | `admin.directory.orgunit.readonly`         |

All scopes use the `https://www.googleapis.com/auth/` prefix.
One PATCH carries all four fields, so the three new fields need no new write scope.
The patch body holds only the changed fields.
Clear sends `null`, as step 4 does for Annotated location.
Google OU paths are case-insensitive. The read-back compares paths without case, or the write sends Google's casing.

The OU picker reads the OU tree with `orgunits.list` under `admin.directory.orgunit.readonly`.
The app already defines that read as an optional capability (`libs/application-contracts/src/lib/google-capabilities.ts:28-40`).
Without the grant, the OU field stays disabled with a note that names the scope, as D2 does for the write scope (`docs/workflows/update-device-annotated-location.md:83-84`).

The sync reads and stores `annotatedUser`.
The grid gains an optional "Annotated user" column, hidden by default, with the text filter.
The device details gain an Annotated user row.

A move needs Device Write in the source OU and in the destination OU (`docs/workflows/platform-access.md:743-747`).
The single administrator holds every action today, so the picker offers every OU.
Scoped pickers follow platform access.

Live device writes stay unverified, because the standing authorization is read-only (`docs/workflows/update-device-annotated-location.md:74`).

## Owner direction — 2026-10-21

2026-10-21, main chat:

> I also want to give the hint now that update device needs to be expanded to include the other editable fields.

Earlier decisions govern this record. This record cites them and does not restate them as new decisions.

- The step 4 record keeps Replace and Clear now, with Prepend and Append deferred (D1, `docs/workflows/update-device-annotated-location.md:80-81`).
- Setup lists the device write scope, and Update device stays disabled with a message that names the scope until Google grants it (D2, `docs/workflows/update-device-annotated-location.md:83-84`).
- The step 4 draft omitted Organization unit, because UI-05 forbids an inert control (`docs/workflows/update-device-annotated-location.md:27`). This record adds the field with a mode.
- The bulk action sheet keeps the user in the grid. Owner: "I dont want to take the user from the context of the grid."
- A move needs Device Write in the source OU and in the destination OU (owner rule of 2026-10-05, `docs/workflows/platform-access.md:743-747`).
- The owner asked for every editable field and an operation mode per field (`docs/archive/ux/feature-review-notes-2026-09-03.md:26-32`).
- The step 4 exclusions stay (`docs/workflows/update-device-annotated-location.md:193-204`).

## Owner decisions — 2026-10-21 evening

2026-10-21, evening, main chat:

<!-- prettier-ignore -->
> Yea These screens are fine. I agree we can leave asset tag off of the bulk update.  We will be doing in-grid editing as well as individual device update like you show in the screens. That is the correct place to set asset tag. As well as import and export for bulk edit. If you dont know about that there should be sone notes.

The owner approved the Update device fields screens.
Asset tag leaves the bulk Update device draft.
The owner places Asset tag in in-grid editing and the individual device update.
The owner names three later workflows: in-grid editing, the individual device update, and import and export for bulk edit.
These workflows are direction, not authorization to build.

## Implementation defaults — 2026-10-21

These defaults are engineering choices. The owner confirmed them with this record on 2026-10-21. Change them when the owner asks.
Each item names its sources.

1. One draft holds several fields, with a mode per field. The preview and the job detail carry one row per device and field. Sources: intake findings f.1, `docs/archive/ux/feature-review-notes-2026-09-03.md:26-32`.
2. The OU change belongs to Update device and travels in the same PATCH. No separate Move action. Source: intake findings f.2.
3. The OU picker reads the OU tree with `orgunits.list` under `admin.directory.orgunit.readonly`, and setup lists that scope. The app already defines the read as an optional capability (`libs/application-contracts/src/lib/google-capabilities.ts:28-40`). The owner's test domain answered HTTP 200 for it (`docs/portfolio/phase-3-google-credentials.md:65`). Without the grant, the OU field stays disabled with a note that names the scope, as D2 does for the write scope. Rejected alternative: offer only OUs that hold devices, which leaves no empty destination OU. Sources: intake findings f.3, `libs/application-contracts/src/lib/google-capabilities.ts:93-96`.
4. Annotated user is free text, at most 100 characters. A user picker waits for the Google users workflow. Source: intake findings f.4.
5. The sync reads and stores `annotatedUser`. The grid gains an optional "Annotated user" column, hidden by default, with the text filter. The device details gain a row. Source: intake findings f.5.
6. Label: "Annotated user". "User" names the Google user entity. Sources: intake findings f.6, `docs/archive/ux/design-review-2026-09-02.md:128`.
7. Access: a move needs Device Write in the source OU and in the destination OU. The single administrator holds every action today, so the picker offers every OU. Scoped pickers follow platform access. Sources: intake findings e, `docs/workflows/platform-access.md:743-747`.

## Design

Inspected on 2026-10-21 through the eng-lead Figma notes and the exported frames.
The frames sit on [Figma page 09](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=94-2) in the file `lqZx6qpWevsN3AAfWkworl`.
The approved side sheet mockup supplies the sheet composition (`docs/ui/designs/2026-10-20-bulk-action-sheet.html`, approved per `docs/workflows/update-device-annotated-location.md:152`).
The owner approved the Update device fields mockup on 2026-10-21.
The approved files:

- `docs/ui/designs/2026-10-21-update-device-fields.html`
- `docs/ui/designs/2026-10-21-update-device-fields-notes.md`
- `docs/ui/designs/2026-10-21-update-device-fields-01-edit-leave-unchanged.png`
- `docs/ui/designs/2026-10-21-update-device-fields-02-edit-three-changes.png`
- `docs/ui/designs/2026-10-21-update-device-fields-03-ou-picker-dialog.png`
- `docs/ui/designs/2026-10-21-update-device-fields-04-notes-over-limit.png`
- `docs/ui/designs/2026-10-21-update-device-fields-05-ou-read-scope-missing.png`
- `docs/ui/designs/2026-10-21-update-device-fields-06-review-preview.png`
- `docs/ui/designs/2026-10-21-update-device-fields-07-confirm.png`
- `docs/ui/designs/2026-10-21-update-device-fields-08-receipt.png`
- `docs/ui/designs/2026-10-21-update-device-fields-09-job-detail.png`
- `docs/ui/designs/2026-10-21-update-device-fields-10-grid-annotated-user.png`
- `docs/ui/designs/2026-10-21-update-device-fields-11-device-details.png`

The build omits the Asset tag block that the screens show.

| Node                                                                                                | Frame name                             | Use                                                                                |
| --------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| [`94:75`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=94-75)       | Screen / Devices / draft               | Draft fields and the "Leave unchanged" default for each field                      |
| [`97:21`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=97-21)       | Screen / Devices / preview             | Preview rows, one per device and changed field                                     |
| [`171:1283`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=171-1283) | Screen / Entity grids / edit-orgunit   | OU picker: title, current OU, search, tree, selected path, Cancel and Stage change |
| [`176:2636`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=176-2636) | Screen / Entity grids / filter-orgUnit | The same OU tree inside a filter                                                   |

Design gaps:

1. No Figma frame shows a draft with Annotated user or Notes fields. The approved mockup supplies that composition.
2. Figma shows the OU picker only as an in-grid popover (`171:1283`) and a filter popover (`176:2636`). OU pickers open dialogs (`docs/ui/patterns.md:142-144`). A mockup for owner approval precedes the screens, as in step 5.

## Exclusions and open decisions

Excluded from this build:

- Prepend and Append (D1).
- Asset tag in bulk Update device. The owner places it in in-grid editing and the individual device update.
- In-grid editing, the single-device edit, and Cancel. The step 4 exclusions stay.
- A Google user picker. It waits for the Google users workflow.
- OU management screens (G20, `docs/workflow-gaps.md:78`).
- `moveDevicesToOu`, which returns no per-device result.

Open decisions:

- The owner confirmed this record on 2026-10-21.
- Each design gap needs a composition before its screen is built.
- Live Google device writes need their own test authorization.

## Completion

Demonstrate on admin-sdk-mock:

1. Select devices, open Update device, change Annotated location and Notes, and leave the other fields unchanged. The preview shows one row per device and changed field, with before and after values. After Confirm, the job settles each device, and the grid shows the new values in place.
2. Move devices to another OU with the picker. The preview shows the source and destination OUs. After the job, the grid shows the new OU, and the OU filter finds the devices there.
3. Set Annotated user on devices. The optional column shows the values.
4. Clear Notes on devices. The grid shows the empty value.
5. A value over its limit cannot be submitted. The message names the field and the limit.
6. Without the OU read scope, the OU field is disabled, with the note that names the scope.

Run lint, tests, and builds for the affected Nx projects. Keep live write behavior marked "not verified".
