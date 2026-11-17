# Custom user attributes: categories and values

Technical design B · proposed for Campus Commander · 2026-11-01

Status: proposed. It authorizes no build and no live Google write.
Owner answers, 2026-11-16: "All recommended". Questions U1 to U7 take option 1 (section 15).
On 2026-11-16 the owner approved the screens: "1) Approved". This document stays proposed. The design addendum decides the build.
Record: [Google users and custom attributes](../workflows/user-management.md). Approved screens: [users](../ui/designs/2026-11-16-user-management.html) and [custom attributes](../ui/designs/2026-11-16-custom-attributes.html).

Another writer prepares the Google user management design (document A) in parallel. Section 16 states the interface with it.

Scope: the Custom attributes tab, the category editor and its job, and attribute values on users.

Source: the owner direction of 2026-11-01, the [planning baseline](user-management-planning-baseline.md) of 2026-11-01, and the Google documentation in [Appendix A](#appendix-a-sources).
This document cites the planning baseline as "baseline section N" and "baseline default N".
Baseline: repository `origin/main` at `7e7e81e`.
Workflow gaps: G19 for users (`docs/workflow-gaps.md:77`) and G02 for the permission catalog (`docs/workflow-gaps.md:55`).

Reading guide:

- [Purpose and authority](#1-purpose-and-authority), [scope](#2-outcome-and-scope), [vocabulary](#3-vocabulary-and-google-rules), and [user workflows](#4-user-workflows)
- [Category editor rules](#5-category-editor-rules), [change plan](#6-change-plan), [jobs](#7-jobs), and [value rules](#8-value-rules)
- [Cache](#9-cache), [API](#10-api-contracts), [authorization](#11-authorization), [grid and details](#12-grid-and-details-integration), and [failures](#13-failures)
- [Tests and live checks](#14-testing-and-live-checks), [owner questions](#15-owner-questions-and-engineering-defaults), [delivery](#16-delivery-plan), and the [Figma start frame](#17-summary-for-the-figma-start-frame)

## 1. Purpose and authority

This document designs slices S2 and S3 of the planning baseline. It reuses a built device pattern wherever one exists, and cites it.
It names each departure from the baseline as an open point in section 15. "E1" to "E18" mark engineering defaults (section 15). "Not verified" marks a Google behavior that no source confirms. Section 14 names its live check.

### Owner direction

<!-- prettier-ignore -->
> I want you to start the plan to add user entity managment to the app. This should have the look and feel of the device managment to keep a consistant UI/UX. One big diffrence is that users have custom schema. We will need a unique UI/UX to manage this, both in creating the schema and assigning it. Create both Technical Design Docs as Views in Figma.

Owner, main chat, 2026-11-01, as baseline section 1 quotes it.

| Date       | Direction                                                                                                                                               | Source                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 2026-09-03 | A one-cell edit runs the same chain as a bulk change: draft, preview, confirm, job, and audited result.                                                 | `docs/portfolio/02-domain-model.md:162-165`                     |
| 2026-09-17 | "Granular. Device Read, Device Write, Device Deprecate, Device Bulk Actions, User Read, User Write , User schema manage, User Bulk Actions, etc"        | `docs/workflows/platform-access.md:636`                         |
| 2026-09-17 | "Yes. Bulk actions gives access to the Bulk Actions menu dropdown button. Further permissions show which features are enabled in that dropdown."        | `docs/workflows/platform-access.md:668`                         |
| 2026-10-05 | "Include Read automatically". User Write and User Bulk Actions include User Read.                                                                       | `docs/workflows/platform-access.md:687`, `:696`                 |
| 2026-10-05 | "Definitions only". User Schema Manage covers definitions, domain-wide. Values need User Write in the scope of the user.                                | `docs/workflows/platform-access.md:705`, `:712-717`             |
| 2026-10-19 | "We are building a doghouse. We dont need to choose the curtains."                                                                                      | `docs/superpowers/specs/2026-10-23-in-grid-editing-design.md:6` |
| 2026-10-23 | "1) If it is only ONE change create the job directly. If it is more that one go to the review and confirm as MORE than one can be over multiple pages." | `docs/workflows/in-grid-editing.md:108`                         |
| 2026-10-28 | "a dialog instead of a sidebar"                                                                                                                         | Baseline section 2                                              |

Earlier decisions that bind this design:

- Development order step 6: "Reuse the working interaction patterns for Google users, OUs, and groups, in that order." (`docs/current-work.md:350`)
- Gap G19: "These are Google accounts, not platform access." (`docs/workflow-gaps.md:77`)
- The domain model caches `customSchemas` with each user (`docs/portfolio/02-domain-model.md:74`).
- UI-07 Safety: freeze exact targets and final values before confirmation (`docs/ui/rules.md:95-100`).

## 2. Outcome and scope

A person with User Schema Manage creates, edits, and deletes categories on the Custom attributes tab (U2). Each save runs as a job of one Google call.
A person with User Write sets attribute values on one user, in the users grid, or on selected users. Each change runs as a value job.

### Included

| Capability                                                                                            | Slice | Source                              |
| ----------------------------------------------------------------------------------------------------- | ----- | ----------------------------------- |
| Custom attributes tab: category list, holder counts, limit counts, and Refresh                        | S2    | Baseline slice S2, U2               |
| Category editor: create, edit, and delete, with the locks of Google, typed phrases, and holder counts | S2    | Baseline slice S2, defaults 8 and 9 |
| Change plan, confirm, the category job `CAT-`, and the schema cache                                   | S2    | Baseline defaults 6 and 12          |
| Values on one user, attribute columns, filters, and in-grid editors                                   | S3    | Baseline slice S3, defaults 2 and 4 |
| Bulk "Set attributes" with six modes, value preview, confirm, and the value job `UAT-`                | S3    | Baseline defaults 11 and 12         |
| admin-sdk-mock 0.4.0 with the `schemas` resource and custom values                                    | S2    | Baseline section 4                  |

### Excluded

- The Users page, the users grid, user details, the user cache, and the user sync. Document A owns them.
- An app-side link of a category to OrgUnits (U1 option 2). A "One value for each user" mark (U5 option 2).
- Edits of the `type` and `customType` keys of a multi-value entry. Existing entries keep both keys.
- Rename, a change of info type, and multiple values back to one value, because Google refuses all three.
- Attribute values in export and import. Document A owns slice S5 and its contract.
- Retry, Pause, Resume, and rollback. Cancel and Reconcile stay as built.

## 3. Vocabulary and Google rules

| Term                    | Meaning                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Category                | A Google schema. `schemaName` is its name, and `displayName` is its label.                                                               |
| Attribute               | A field of a category: `fieldName` and `displayName`.                                                                                    |
| Info type               | `fieldType`. Section 8 lists the seven labels.                                                                                           |
| Value                   | One `customSchemas.<category>.<attribute>` entry on one user. A multi-value attribute holds a list of entries.                           |
| Visibility, searchable  | `readAccessType`: "Admins and the user" (ADMINS_AND_SELF) or "Everyone in the organization" (ALL_DOMAIN_USERS). Searchable is `indexed`. |
| Holder, holder count    | A cached user with a value for the attribute or category. The count reads the user cache of document A.                                  |
| Change plan             | The frozen Google call of one editor save, with the base `etag` and a digest.                                                            |
| Value preview           | The frozen final values of one value change, one row for each user and attribute.                                                        |
| Category job, value job | The job that runs one change plan (prefix `CAT-`), or one value preview (prefix `UAT-`).                                                 |

### Google limits and rules

"Guide" is [Manage Custom User Fields](https://developers.google.com/workspace/admin/directory/v1/guides/manage-schemas). "Discovery" is the Directory API discovery document. "Admin help" is in Appendix A.

| Rule                | Google value                                                                                                                                                                           | Source                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Account limits      | 100 categories. 100 attributes over all categories.                                                                                                                                    | Guide, Admin help (errors page)            |
| Text size           | 500 characters for a single value. A list depends on its total: 150 values of 100 characters, or 50 of 500.                                                                            | Guide                                      |
| Name characters     | Letters, digits, `_`, and `-`                                                                                                                                                          | Guide                                      |
| Category name       | Unique in the customer. Reuse answers 412 `conditionNotMet` (check L2). The Guide states `409: Entity already exists`.                                                                 | L2, Guide, Discovery `Schema.schemaName`   |
| Locks               | No rename. No change of info type. One value can become multiple values. The reverse is refused.                                                                                       | Guide, Admin help                          |
| Visibility change   | Takes up to 24 hours                                                                                                                                                                   | Discovery `SchemaFieldSpec.readAccessType` |
| Required keys       | Insert: `schemaName`, `displayName`, `fields[]`. Insert and update: each field with `fieldName`, `fieldType`, `displayName`.                                                           | Discovery annotations                      |
| Field defaults      | `multiValued` false, `indexed` true, `readAccessType` ALL_DOMAIN_USERS                                                                                                                 | Discovery `SchemaFieldSpec`                |
| Numeric range       | `numericIndexingSpec` `minValue` and `maxValue`. Indicative, not enforced. Enables range queries.                                                                                      | Discovery `SchemaFieldSpec`                |
| Admin console rules | The last attribute goes only with its category. A SAML-mapped attribute cannot be deleted.                                                                                             | Admin help (custom attributes page)        |
| Value write         | An unnamed attribute stays unchanged. The Guide states that `null` deletes an attribute or a category on that user. A `users.patch` with a `null` attribute kept its value (check L3). | Guide, check L3                            |
| Multi-value entry   | `{ value, type?, customType? }`, with `type` one of work, home, other, custom                                                                                                          | Guide                                      |
| Value read          | `projection=full`, or `projection=custom` with `customFieldMask`                                                                                                                       | Discovery `users.get`, `users.list`        |
| Scopes              | Read: `admin.directory.userschema.readonly`. Write: `admin.directory.userschema`. Values: `admin.directory.user`.                                                                      | Discovery `schemas`, `users.patch`         |
| Sensitive data      | Google warns against government ID numbers, financial data, and health data                                                                                                            | Guide, Admin help                          |

## 4. User workflows

Every workflow uses dialogs, ends where it starts, and keeps progress and results in one dialog (baseline section 2).

### 4.1 Manage categories

1. The Custom attributes tab lists each category with its attributes, holder counts, and the two limit counts.
2. Create category or Edit opens the editor dialog. The person enters display names, and the editor derives the names.
3. Save requests a change plan. The dialog shows the Google change and each removed attribute with its holder count.
4. A removal asks the person to type the attribute name, and a delete asks for the category display name. Confirm creates the category job.
5. The same dialog shows progress, then the result, with the job ID as a secondary link.

### 4.2 Set values on one user or in the grid

1. On user details, Edit on a category section of the Custom attributes card opens a dialog for that category.
2. In the grid, the person shows attribute columns from the Columns panel. Each column sits under its category label.
3. The person edits cells with the editor of each info type (section 12). A conflict cell blocks Save changes.
4. Save with one change creates the job directly (owner, 2026-10-23). More changes go to review and Confirm.

### 4.3 Set values on selected users

1. The person selects users and chooses Bulk Actions, then Set attributes. The person adds attribute changes, each with a mode (section 8.3).
2. Review widens the dialog. It lists each user with the current and the new value of each attribute.
3. Confirm creates the value job. The results reuse the review table with an outcome column and a Failed view with its count.

## 5. Category editor rules

| Rule                   | Behavior                                                                                                                                                                                                                                                                     | Source                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Name derivation        | Split the display name at each character outside `A-Z`, `a-z`, and `0-9`. Upper-case the first letter of each part, and join. "Take-home approved" gives `TakeHomeApproved`. No letter or digit: the person types a name. The person can edit the name until the first save. | E1. Baseline default 13 names use this form (`StudentInfo`). Guide: no rename. |
| Characters and length  | `A-Z`, `a-z`, `0-9`, `_`, and `-`. Other characters show "Use letters, digits, \_ and - only." No length limit of its own, because Google documents none.                                                                                                                    | Guide. Check L2 accepted a 200-character attribute name.                       |
| Uniqueness             | A category name differs from every cached category name. An attribute name differs from the others in its category. Both compare without letter case.                                                                                                                        | Guide, check L2 (412), E2                                                      |
| Display names          | Required for the category and each attribute, with a visible character. Google refused a category display name of 200 characters (check L2). The editor sets no limit, because the limit is not known.                                                                       | Discovery annotations, check L2                                                |
| Visibility, searchable | A new attribute starts with "Admins and the user" and Searchable on. A visibility change shows "Google applies a visibility change within 24 hours."                                                                                                                         | Baseline default 7, Discovery `readAccessType`                                 |
| Range                  | Optional minimum and maximum for Whole number and Decimal number, sent as `numericIndexingSpec`. The value checks refuse a value outside it.                                                                                                                                 | E11, `docs/ui/entity-grid-fields.json:76`                                      |
| Account limits         | "3 of 100 categories used" and "10 of 100 attributes used", with unsaved attributes counted. At 100, Create category or Add attribute is disabled with "The account holds 100 categories, the Google maximum."                                                               | Baseline default 10, Guide                                                     |

### Locked properties

| Control after the first save             | State     | State message (drafted)                                             | Source                    |
| ---------------------------------------- | --------- | ------------------------------------------------------------------- | ------------------------- |
| Category name, attribute name            | Read only | "Google does not allow renaming a category." (or "an attribute")    | Guide, baseline default 8 |
| Info type                                | Read only | "Google does not allow changing the info type."                     | Guide, baseline default 8 |
| Single value, on a multi-value attribute | Disabled  | "Google does not allow changing multiple values back to one value." | Guide, baseline default 8 |
| Multi-value, on a single-value attribute | Enabled   | "This change cannot be undone."                                     | Guide                     |
| Remove, on the last attribute            | Disabled  | "A category needs one attribute. Delete the category instead."      | Admin help, E18           |

### Typed phrases and holder counts

| Change                                     | Phrase                                                  | State message (drafted)                             |
| ------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------- |
| A plan that removes one or more attributes | The attribute name, for example `Homeroom`              | "Removes values from 1,988 users"                   |
| Delete category                            | The category display name, for example `Device program` | "Deletes Take-home approved values on 1,312 users." |

- The API trims the phrase and compares it exactly, as the device actions do (`docs/superpowers/specs/2026-10-23-wipe-powerwash-deprovision-design.md:71-74`). A mismatch answers 422 `phrase-mismatch`.
- Both phrases apply at any holder count, because the count reads the cache (baseline default 9).
- The words "deletes its values" stay in the build only after check L3 confirms them (section 6.3, U7).
- A plan that removes two attributes asks for each name. The mockup draws one removal (custom attributes mockup, state 05).

## 6. Change plan

### 6.1 Editor change to Google call

| Editor change                                                                                           | Google call                                                         | Body                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create category                                                                                         | `schemas.insert`, `POST .../customer/C0123456/schemas`              | `schemaName`, `displayName`, and each field: `fieldName`, `displayName`, `fieldType`, `multiValued`, `indexed`, `readAccessType`, and `numericIndexingSpec` when set |
| Edit: labels, visibility, searchable, range, one value to multiple values, added and removed attributes | `schemas.update`, `PUT .../customer/C0123456/schemas/{schemaId}`    | The complete schema: `schemaName`, `displayName`, every kept field with its `fieldId`, then each new field. A removed field is absent.                               |
| Delete category                                                                                         | `schemas.delete`, `DELETE .../customer/C0123456/schemas/{schemaId}` | None                                                                                                                                                                 |

- One save gives one plan and one Google call. A delete never shares a plan with other changes. Every edit uses `schemas.update`, as the guide example does. That example removes a field by leaving it out of the list.
- The design never calls `schemas.patch`, because the merge rule of its `fields` array is not verified (E4).
- Calls name the category by its immutable `schemaId` (Discovery `schemaKey`), so a recreated name never matches an old plan (E5). Each call percent-encodes the `schemaId` as one path segment, because an ID holds characters outside `[A-Za-z0-9_-]` (check L2). Check L2 did not show whether a recreated category gets a new `schemaId`. Its new `etag` fails the compare of section 6.2 step 3.

### 6.2 Order of operations and the etag

1. The worker revalidates the confirmer, User Schema Manage, and the connection generation (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:1024`).
2. For an edit or a delete, it reads the category with `schemas.get` by `schemaId`.
3. It compares the fresh `etag` with the plan `etag`. A difference fails the operation with `category-changed` and sends nothing.
4. It sends the write with the header `If-Match` and the plan `etag` (E7).
5. On a 2xx answer, one transaction writes the schema cache and purges removed values (section 9). The worker then publishes the change.

- A plan stores the cached `etag`. A `baseEtag` that differs from the cache answers 412 `category-changed`, at the plan and again at confirm.
- Check L2 showed that Google applies `schemas.update` with a stale `If-Match`. Step 3 narrows the race, and the last write wins inside it. `If-Match` on `schemas.delete` stays unverified.
- A value preview stores the `etag` of each category that it writes. Its confirm answers 409 `category-changed` after a change.

### 6.3 Effect on stored values

| Event                                                          | Google behavior                                                                                                                                                                                                                                            | Status                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| A value PATCH names an attribute with `null`, or leaves it out | The Guide states that `null` deletes the value and that a left-out attribute stays. In check L3, a `null` single value and a `null` list stayed for 8 seconds. Check L4 sent `null` through `users.update`, and Google cleared both values in 1.4 seconds. | Guide, check L3. E16 applies (design C9).             |
| A value PATCH names a category with `null`                     | Deletes every value of that category on that user                                                                                                                                                                                                          | Guide. This design never sends it (E15).              |
| `schemas.update` leaves out a field                            | Removes the field from the schema                                                                                                                                                                                                                          | Guide example                                         |
| Values of a removed field                                      | No value of the field reads right after the update                                                                                                                                                                                                         | Check L3, one user                                    |
| A new field with the name of a removed field                   | Starts empty, with a new `fieldId`                                                                                                                                                                                                                         | Check L3, reads at once and 1 second later            |
| `schemas.delete` while users hold values                       | Accepted with 204. A user read that names the deleted category answers 400 `invalid`, so no read shows the values.                                                                                                                                         | Check L3. The deletion of the values is not verified. |
| A new category with the name of a deleted category             | Accepted at once                                                                                                                                                                                                                                           | Check L2                                              |
| One value to multiple values                                   | The value reads as a list of one entry                                                                                                                                                                                                                     | Check L3                                              |
| Delete of an attribute that a SAML app maps                    | The Admin console refuses it. No source gives the API answer.                                                                                                                                                                                              | Not verified. No live check without a mapped app.     |

## 7. Jobs

Both job kinds reuse the device write job service: admission, claims, leases, fencing, and settlement (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:916`).
Every call travels inside the Directory batch endpoint, as device writes do (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:912`) (E6). The display ID rule adds `CAT` and `UAT` (`libs/application-contracts/src/lib/jobs.ts:26`).
Both kinds share the one write slot of device jobs (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:279`), because one Directory quota serves the project (`docs/portfolio/02-domain-model.md:171`) (E8).

### 7.1 Category job

- Kind `user-schema-change`, actions `create-category`, `edit-category`, and `delete-category`. One operation in one batch part.
- The write token carries `admin.directory.userschema` only (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:907`). Reads use the read-only scope. Read-back: `schemas.get` by `schemaId`, or by `schemaName` for a create. A plan match gives Succeeded. A delete matches a 404.

### 7.2 Value job

- Kind `user-attribute-update`, action `set-attributes`. One operation for each user, as one PATCH for each device (`docs/superpowers/specs/2026-10-21-update-device-fields-design.md:23`).
- Each part is `PATCH /admin/directory/v1/users/{userId}` with the immutable Google user ID (Discovery `userKey`). A body that holds a `null` goes as `PUT` on the same path, the `users.update` call (E16, design C9). A batch holds 250 parts (`libs/google-connection/src/lib/batch.ts:87`).
- The write token carries `admin.directory.user`. A 2xx answer settles Succeeded when its `customSchemas` hold the requested values. Check L3 found `customSchemas` in the answer and recorded none of its values.
- Otherwise a read-back settles it: `users.get` with `projection=custom`, `customFieldMask`, and the read scope of document A. The read-back starts 30 seconds after the answer or later (design C11). In check L3, a read right after a write showed none of its values.

### 7.3 Outcomes and Unknown

| Answer                                                   | Outcome                                       | Source                                                                    |
| -------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| 2xx with the requested result                            | Succeeded                                     | `docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:1326`      |
| First-attempt refusal: 400, 404, 409, or 412             | Failed, with the Google reason or `not-found` | `docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:1327-1328` |
| `quota` after 25 retries                                 | Failed `quota`                                | `docs/superpowers/specs/2026-10-07-google-batch-service-decisions.md:88`  |
| Any failure after a transient retry, or no answer        | Unknown, then read-back                       | `docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:1318`      |
| `auth`, `delegation-not-authorized`, or `scope-mismatch` | Failed, and the job stops                     | `docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:1354-1355` |

- The batch service retries PUT, PATCH, and DELETE on a transient answer, never a POST (`libs/google-connection/src/lib/batch.ts:898-901`). A transient insert ends Unknown.
- A repeated PUT or PATCH sets the same absolute value, so a repeat is safe (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:1365`). Add values and Remove values meet that rule, because the preview computes the final list once (`docs/portfolio/03-architecture.md:249`).
- The UI shows "Unknown" and the job as "Needs review" (`docs/ui/patterns.md:266`). Reconcile settles the rest on request.

### 7.4 Retry, cancel, and the dialog

- No Retry action exists, as built (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:1375`). A person starts a new change for failed users.
- Cancel pending work applies to both kinds (`docs/superpowers/specs/2026-10-26-job-cancel-design.md:24-25`). A value job stops sending within 30 seconds.
- A category job ends at once while its one call stays in the worker. After the call leaves, the cancel answers `nothing-to-stop`.
- The starting dialog shows progress and results, with the job ID as a secondary link. The value dialog shows counts, then the review table with an outcome column. The jobs sit above it as a compact part. Success wording covers only Succeeded operations.

## 8. Value rules

### 8.1 Info types

| Info type (Google)      | Entry                       | Canonical form and JSON               | Limit                                                                                                              |
| ----------------------- | --------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Text (STRING)           | Text box. No trim.          | The string                            | 1 to 500 code points and a visible character (Guide, `libs/application-contracts/src/lib/device-updates.ts:26-37`) |
| Whole number (INT64)    | Digits, an optional `-`     | JSON number, no leading zeros         | ±9,007,199,254,740,991, the JSON safe range (E10), and the range of the attribute                                  |
| Decimal number (DOUBLE) | Digits with an optional `.` | JSON number, shortest round-trip form | Finite, and the range of the attribute                                                                             |
| Yes or no (BOOL)        | Dropdown: Yes, No           | JSON `true` or `false`                | Check L3 read `true` as a JSON boolean.                                                                            |
| Date (DATE)             | Date picker                 | JSON string `YYYY-MM-DD`              | A calendar date. Check L3 read `2026-11-17` as a JSON string.                                                      |
| Email (EMAIL)           | Text box                    | The string                            | The `z.email()` rule with 254 characters (`libs/application-contracts/src/lib/google-connection.ts:75`)            |
| Phone (PHONE)           | Text box                    | The string                            | 1 to 500 code points. Check L3 stored `+1 555 0100` unchanged and tested no other format.                          |

- Every limit counts code points, as device writes do (`docs/superpowers/specs/2026-10-21-update-device-fields-design.md:29`).
- The reader accepts a JSON number or a numeric string for INT64 and DOUBLE. Check L3 read `7` and `1.5` as JSON numbers through `projection=custom`. Check L1 records the form of `projection=full`.
- The reader accepts `true`, `false`, and their strings for BOOL. Values compare by canonical form.

### 8.2 Multi-value entries

- A list holds ordered entries `{ "value": v }`. Each text entry holds 1 to 500 code points (E10). Google limits the total size (Guide).
- One change never enters a value twice. Existing duplicates stay. Lists compare by their values in order. An existing entry keeps its `type` and `customType` keys. A new entry carries `value` only.

### 8.3 Modes and payloads

Examples use `StudentInfo.Homeroom` (single value) and `StudentInfo.Programs` (multi-value) from baseline default 13.
Each body is `{ "customSchemas": { ... } }` with only the changed attributes. `null` marks a value to remove (Guide). A body with a `null` goes through `users.update` (E16).

| Mode               | For          | Person enters      | Final value for each user                                             | `customSchemas` body                                                           |
| ------------------ | ------------ | ------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Set value          | Single value | One value          | The value                                                             | `{ "StudentInfo": { "Homeroom": "B12" } }`                                     |
| Clear value        | Single value | Nothing            | No value                                                              | `{ "StudentInfo": { "Homeroom": null } }`                                      |
| Add values         | Multi-value  | One or more values | Current entries, then each new value that is not present              | `{ "StudentInfo": { "Programs": [{ "value": "ELL" }, { "value": "Band" }] } }` |
| Remove values      | Multi-value  | One or more values | Current entries without the matching values. An empty list is `null`. | `{ "StudentInfo": { "Programs": [{ "value": "ELL" }] } }`                      |
| Replace all values | Multi-value  | One or more values | Exactly the new values                                                | `{ "StudentInfo": { "Programs": [{ "value": "Robotics" }] } }`                 |
| Clear values       | Multi-value  | Nothing            | No value                                                              | `{ "StudentInfo": { "Programs": null } }`                                      |

- One change set holds one or more attributes, each once, with one mode each (`docs/superpowers/specs/2026-10-21-update-device-fields-design.md:22`). A user whose final value equals the current value is Unchanged and gets no operation.
- Discovery states that `users.patch` cannot clear repeated objects such as addresses. In check L3, a `users.patch` with `null` kept a single value and a list for 8 seconds.
- E16 applies, so the job sends each body that holds a `null` with `users.update` (design C9). Discovery states that `users.update` clears `null` fields. Check L4 confirmed that clear: a `users.update` body that named a single value and a list with `null` cleared both in 1.4 seconds (design K30).

### 8.4 Final values and conflicts

- The preview computes each final value once, from the current value of that user (`docs/ui/patterns.md:132`).
- An edit list from the grid or the details card reads each user from Google first (`docs/superpowers/specs/2026-10-23-in-grid-editing-design.md:23`).
- It then applies the device rule to current C, baseline B, and request R (`docs/superpowers/specs/2026-10-23-in-grid-editing-design.md:133-138`). C equals R gives Unchanged. C differs from B gives Conflict. Every other row is Eligible.
- A bulk selection uses cached values. The preview reads stale when a target is older than 24 hours (`libs/application-contracts/src/lib/entity-cache.ts:16-19`).
- A Google change after the read and before the PATCH loses, as in the device design (`docs/superpowers/specs/2026-10-23-in-grid-editing-design.md:143`).

## 9. Cache

- The schema cache holds one row for each category with `schemaId`, `schemaName`, `displayName`, `etag`, `fields`, and the read time. Every `schemas.list` read replaces the whole set. A category that Google no longer lists leaves the cache.
- The API reads the list when the tab opens and the cache is older than 24 hours (`libs/application-contracts/src/lib/entity-cache.ts:16-19`). Refresh reads it at once.
- That read has a 25-second deadline, as the device OU tree read has (`docs/superpowers/specs/2026-10-23-in-grid-editing-design.md:121`). After each category job, the worker writes the answered schema. After each Succeeded value operation, it writes the observed values into the user row of document A.
- The purge removes each removed attribute, or the whole deleted category, from `customSchemas` of every cached user. Drafts that name them leave the draft store.
- The worker publishes a schema change on `GET /api/events` (`docs/current-work.md:39`). Value changes travel on the users feed of document A.

## 10. API contracts

| Route                                                           | Purpose                                                                                                    | Actions                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `GET /api/users/attribute-categories`, and `POST` on `/refresh` | Categories, attributes, holder counts, limit counts, and the cache time. Refresh reads `schemas.list` now. | `users:read` (U4 option 1)                               |
| `POST /api/users/attribute-categories/plans`                    | Change plan from `{ kind, schemaId?, baseEtag?, draft }`                                                   | `users:schema-manage`                                    |
| `GET /api/users/attribute-categories/plans/{planId}`            | The plan, to its creator only                                                                              | `users:schema-manage`                                    |
| `POST /api/users/attribute-categories/plans/{planId}/confirm`   | `{ digest, acknowledged, typedPhrase? }`. Answers the `CAT-` receipt.                                      | `users:schema-manage`                                    |
| `POST /api/users/attribute-previews`                            | Value preview from a selection key with changes, or from an edit list                                      | `users:write`, plus `users:bulk-actions` for a selection |
| `GET /api/users/attribute-previews/{previewId}` and `/targets`  | Summary, then rows: user, attribute, current value, new value, and disposition                             | `users:write`                                            |
| `POST /api/users/attribute-previews/{previewId}/confirm`        | `{ manifestDigest, acknowledged: true }`. Answers the `UAT-` receipt.                                      | As for the preview                                       |
| `/api/jobs` routes                                              | List, detail, operations, cancel, and reconcile, as built                                                  | As built                                                 |

- A plan answer holds the Google method, the changes, and the removed attributes with holder counts. It also holds the phrase or null, the limit counts after the save, `expiresAt`, and the digest.
- A selection body copies the device form: `gridId`, `tabId`, and `changes` (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:545-547`). Each change is `{ schemaName, fieldName, mode, values }`. A selection holds at most 100,000 users (E17).
- An edit list holds 1 to 2,500 edits on at most 500 users, each with a baseline (`docs/superpowers/specs/2026-10-23-in-grid-editing-design.md:38`).
- Plans and previews expire after 15 minutes (`api/src/app/devices/device-updates.ts:47-48`). A repeated confirm answers the receipt (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:578`).

## 11. Authorization

| Operation                             | Actions                                                               | Source                                      |
| ------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| See the Custom attributes tab         | `users:read` under U4 option 1. `users:schema-manage` under option 2. | U4, `docs/workflows/platform-access.md:701` |
| Create, edit, or delete a category    | `users:schema-manage`, domain-wide                                    | `docs/workflows/platform-access.md:712-716` |
| Set values on one user or in the grid | `users:write` in the scope of each user                               | `docs/workflows/platform-access.md:714`     |
| Bulk Set attributes                   | `users:bulk-actions` and `users:write`                                | `docs/workflows/platform-access.md:672`     |

- The action list gains the three actions (`libs/application-contracts/src/lib/authorization.ts:3`). Document A adds `users:read`. Each takes the scope kinds `platform` and `district`, as device actions do (`libs/application-contracts/src/lib/authorization.ts:37`) (E14).
- Today such a grant covers every user. An OU-scoped grant later adds a per-user check, as planned for devices (`docs/superpowers/specs/2026-10-21-update-device-fields-design.md:199`).
- Each batch claim revalidates the grants (`docs/portfolio/03-architecture.md:177`).
- The Admin console requires schema read to add values (Admin help). Under U4 option 2, value editors still receive attribute metadata through the columns. The display of the domain-wide permission in scoped assignments stays with G02 (`docs/workflows/platform-access.md:717`).

## 12. Grid and details integration

| Info type                    | Column type | Filter (baseline default 4)     | In-grid editor                                                                 |
| ---------------------------- | ----------- | ------------------------------- | ------------------------------------------------------------------------------ |
| Text, Email, Phone           | text        | Contains, has a value           | In-cell text box                                                               |
| Whole number, Decimal number | number      | Range, has a value              | In-cell number box with the range check (`docs/ui/entity-grid-fields.json:76`) |
| Yes or no                    | boolean     | Yes or no, has a value          | In-cell dropdown with Yes and No (`docs/ui/patterns.md:141`)                   |
| Date                         | date        | Date range, has a value         | Date picker dialog (`docs/ui/entity-grid-fields.json:58`)                      |
| Any multi-value              | list        | Contains any entry, has a value | List editor dialog (`docs/ui/patterns.md:142`)                                 |

- Each attribute gives one column `attr:<schemaName>.<fieldName>`, after the Google query form (Guide) (E13). The Columns panel groups columns by category label. Columns start hidden (baseline default 2).
- A multi-value cell shows its values in order with commas (E12). Details show chips (baseline default 5).
- Filters read the local cache, so a non-searchable attribute still filters (baseline default 4, `docs/ui/entity-grid-fields.json:123`).
- A Yes or no cell never treats No as empty (`docs/ui/entity-grid-fields.json:97`). Clear value is its own operation. A cell is editable only with `users:write` for its user, online. The draft key is the user ID and the column ID.

## 13. Failures

| Failure                     | Where              | Behavior                                                                                                                                                                                    |
| --------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name used                   | Plan, category job | Plan: 422 `name-in-use`. Google 409 or 412 `conditionNotMet` on an insert (check L2): Failed `name-in-use`, the schema cache refreshes, and the dialog offers Edit again.                   |
| Stale `etag`                | Plan, confirm, job | 412 `category-changed`, or Failed `category-changed` in the worker. "Another change reached this category. Open it again." A changed category after a value preview answers 409 at confirm. |
| Category or attribute limit | Plan, category job | Plan: 422 `category-limit` or `attribute-limit`. A Google refusal: Failed with its reason, and the cache refreshes.                                                                         |
| Refused value               | Preview, value job | Preview: 422 with the label and rule, for example "Homeroom holds 1 to 500 characters." Google: Failed with its reason.                                                                     |
| Missing user                | Preview, value job | Preview: Excluded `removed`. Google 404: Failed `not-found`, and the user leaves the cache of document A (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:1047`).            |
| Missing scope               | Plan, preview, job | Write access reads `denied` with the scope name (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:895`). A job stops, and unsent operations settle Skipped.                   |
| Edit-list read failure      | Preview            | 503 `user-read-failed` with the Google failure code. The draft stays.                                                                                                                       |

A refusal fails only its own part. Other users continue (`docs/superpowers/specs/2026-10-07-google-batch-service-decisions.md:91-93`).

## 14. Testing and live checks

### admin-sdk-mock 0.4.0

The release needs the owner's yes, as 0.3.0 did (baseline section 4). It adds:

- The `schemas` resource: list, get, insert, update, patch, and delete, by name or by ID, also as batch parts.
- Schema rules: 412 `conditionNotMet` on a reused name (check L2), both limits, name characters, required keys, the three locks, and a new `etag` on each write.
- Custom values on users with `projection=custom` and `customFieldMask`, and with `projection=full`. PATCH and update merge by category and attribute. `users.patch` keeps a `null` value, as in check L3, and `users.update` deletes it. Values follow their info type and the 500 limit.
- Marked hypotheses:
  - `If-Match` gives 412 on a delete. Check L2 showed that an update ignores `If-Match`.
  - A delete removes the values of the category. Check L3 showed that a removed attribute reads no value.
  - An unknown attribute answers 400.
  - `users.update` deletes a `null` value. Check L4 confirmed the clear.

Tests follow the failing-first rule (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:1402`):

- Contracts: name derivation, the plan builder, the six payload builders, and the reader, with the examples of section 8.3. API and worker: plans, phrases, previews, conflicts, expiry, receipts, section 13, the table of section 7.3, read-back, and the purge.
- End to end on the mock: one category lifecycle, and one value change from each entry point.

### Live checks

The part allowlist adds the `schemas` and `users` paths (`libs/google-connection/src/lib/provider.ts:278-293`). New capabilities add the scopes, as `device-changes` does (`libs/application-contracts/src/lib/google-capabilities.ts:70-75`). The owner adds each scope in his Google Admin console. Nobody asks for a key or secret in chat.

| Check | Authorization                                                                                | Steps                                                                                                                                                                                             | Settles                                                               |
| ----- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| L1    | Standing read-only authorization, after the owner adds `admin.directory.userschema.readonly` | `schemas.list`, then `schemas.get` inside the batch endpoint. With the read scope of document A, `users.get` with `projection=full` for one holder of each info type.                             | Batch support for `schemas`. The JSON forms of INT64, BOOL, and DATE. |
| L2    | The owner's explicit yes                                                                     | On a category `CcLiveCheck`: insert, insert again, update with a stale `If-Match`, a 200-character name, delete, and insert with the same name.                                                   | Ran 2026-11-17. The design addendum, section 6, records the answers.  |
| L3    | The owner's explicit yes, with one test user that he names                                   | Set each info type. Clear a single and a multi-value attribute. Change one value to multiple values. Remove an attribute, add it again, then delete the category. `users.get` after each step.    | Ran 2026-11-17. The design addendum, section 6, records the answers.  |
| L4    | The owner's explicit yes                                                                     | On `CcLiveClear`: set three single values and a list, then send one `users.update` body that clears a single value and the list with `null` and leaves the third out. `users.get` after the step. | Ran 2026-11-17. The design addendum, section 6, records the answers.  |

Each check stores sanitized evidence with `example.org` and `C0123456`. No live category or value write runs without the owner's yes.

## 15. Owner questions and engineering defaults

### Owner questions

Copied unchanged from baseline section 8. The owner wrote "All recommended" on 2026-11-16. Each question takes option 1, marked "(Recommended, chosen)".

- U1. What does "assigning" a schema mean?
  1. (Recommended, chosen) Set attribute values on users: on one user, in the grid, on selected users, and later in the import file. Every category exists for the whole domain, as in Google.
  2. Values plus an app-side link of each category to OrgUnits. Only users in linked OrgUnits show that category's columns and editors. Google still holds every category for the whole domain. This adds a Campus Commander entity.
- U2. Where do categories get managed?
  1. (Recommended, chosen) A "Custom attributes" tab on the Users page, beside a "Users" tab.
  2. A page under Customer settings.
- U3. Which slice builds first?
  1. (Recommended, chosen) S1 Browse users, then S2 Manage categories, then S3 Set attribute values.
  2. S2 first, then S1, then S3.
- U4. Who can see category definitions (the recorded open item)?
  1. (Recommended, chosen) Every person with User Read sees the Custom attributes tab read only. User Schema Manage adds create, edit, and delete.
  2. Only people with User Schema Manage see the tab.
- U5. Can Bulk "Set attributes" write one value to an identifier attribute such as Student ID on many users?
  1. (Recommended, chosen) Yes. Bulk offers every attribute, and the review lists every user. Identifier values go in one user at a time or through the later import.
  2. No. The category editor gains a "One value for each user" mark, and bulk hides marked attributes. This adds a Campus Commander setting.

Added by this design. Document A adds U6 (User Read at district scope).

- U7. When an attribute or a category goes away, does Campus Commander clear the values on users first?
  1. (Recommended, chosen) No. Campus Commander sends only the category change. Check L3 proves what Google does with the values before the build.
  2. Yes. A value job first clears the values on every holder, then the category job runs. It needs User Write on every holder, beyond "Definitions only".

Departures from the baseline, each open until the owner approves the screens:

1. Baseline default 9 states that a removal deletes the values. No Google source confirms it. The design holds that text until check L3 (U7). Check L3 read no value of a removed attribute, also after the attribute returned. No L3 read showed the values of a deleted category (design OQ3).
2. The editor refuses removal of the last attribute of a category. The Admin help states this rule. Baseline default 8 does not list it.
3. The editor adds an optional range for numeric attributes. Baseline default 13 names "Grade level whole number 0 to 12".

### Engineering defaults

The owner can change each default.

| ID       | Topic            | Default                                                                                                                                             |
| -------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1       | Name derivation  | Split at characters outside letters and digits, upper-case each first letter, and join. Editable until the first save.                              |
| E2       | Name comparison  | Without letter case. The Google case rule is not verified, and the stricter rule fits both answers.                                                 |
| E3       | Typed phrases    | The attribute name for a removal and the category display name for a delete, trimmed, compared exactly                                              |
| E4, E5   | Edit call        | `schemas.update` with the complete schema, never `schemas.patch`. Every call names the category by `schemaId`.                                      |
| E6       | Transport        | Every Google call inside the Directory batch endpoint. The category job sends one part.                                                             |
| E7       | Concurrency      | A fresh `schemas.get` and an `etag` compare before the write, then `If-Match`, which an update ignores (check L2)                                   |
| E8       | Write slot       | Category and value jobs share the one write slot of device write jobs                                                                               |
| E10      | Value limits     | 500 code points for each text entry. Whole numbers within the JSON safe range. Email by `z.email()`.                                                |
| E11      | Range            | The value checks refuse a value outside the range of the attribute                                                                                  |
| E12, E13 | Columns          | A multi-value cell lists its values in order with commas. Column ID `attr:<schemaName>.<fieldName>`.                                                |
| E14      | Actions          | `users:schema-manage`, `users:write`, and `users:bulk-actions`, with scope kinds `platform` and `district`                                          |
| E15      | Category `null`  | No body sets a whole category to `null`                                                                                                             |
| E16      | Fallback call    | `users.update` with the same body if check L3 shows that `users.patch` cannot clear a list. L3 showed it (design C9). Check L4 confirmed the clear. |
| E9, E17  | Expiry and sizes | Plans and previews expire after 15 minutes. Edit lists: 2,500 edits on 500 users. Selections: 100,000 users. Batches: 250 parts.                    |
| E18      | Last attribute   | Remove is disabled. The person deletes the category.                                                                                                |

## 16. Delivery plan

This order follows the owner's answer to U3 (option 1). Document A delivers S1 first.

1. Done on 2026-11-16: the owner answered U1 to U7 ("All recommended"). After his approval of the screens, the design addendum writes the card plan.
2. The owner approves the admin-sdk-mock 0.4.0 release and adds `admin.directory.userschema.readonly`. Check L1 runs.
3. S2 part 1: contracts, actions, capabilities, the schema cache, and the read-only tab. It needs the Users page tabs and holder counts.
4. S2 part 2: the editor, plans, the category job, and the purge. Check L2 runs after the owner's yes.
5. S3 part 1: value contracts, previews, the value job, and the details card editor. It needs the card slot and the user read.
6. S3 part 2: attribute columns, filters, and in-grid editors. It needs the dynamic column hook of document A.
7. S3 part 3: Bulk Set attributes. It needs the users selection and the Bulk Actions menu. Check L3 runs after the owner's yes.

### Interface with document A

| Need from document A                                                                                             | Used in           |
| ---------------------------------------------------------------------------------------------------------------- | ----------------- |
| Each cached user holds raw `customSchemas` from `projection=full`, with its read time                            | Sections 8.4, 9   |
| A write of one user's observed `customSchemas`, and a purge of one key from every cached user                    | Section 9         |
| Holder counts for each category and attribute from the user cache                                                | Section 5         |
| A user read by ID with `projection=custom` and `customFieldMask`, for edit lists                                 | Section 8.4       |
| The dynamic column hook in the grid field registry, with column groups                                           | Section 12        |
| The Custom attributes card slot on user details                                                                  | Sections 4.2, 12  |
| The users feed on `GET /api/events`, the stored users selection, the Users page tabs, and the Bulk Actions entry | Sections 4, 9, 10 |
| The `users:read` action and the `admin.directory.user.readonly` capability                                       | Sections 7.2, 11  |

Slice S2 completes when a person creates, edits, and deletes a category on the mock and sees each result. Slice S3 completes when a person sets values from each entry point and sees actual outcomes.
Passing tests do not approve the screens or settle an owner question.

## 17. Summary for the Figma start frame

- Custom attributes add school data to Google user accounts.
- A category groups attributes, for example Student information.
- Each attribute has an info type, a visibility, and one or multiple values.
- A Custom attributes tab on the Users page lists the categories.
- The tab shows "3 of 100 categories used" and "10 of 100 attributes used".
- Google never renames an attribute or changes its type, so the editor locks those controls.
- Removing an attribute or deleting a category asks for a typed word.
- The dialog shows how many users hold values before you confirm.
- You set values on one user, in the grid, or on selected users.
- Bulk Set attributes offers Set, Clear, Add, Remove, and Replace.
- Every change shows a review, runs as a job, and reports in the same dialog.
- You answered U1 to U7 on 2026-11-16: all recommended. The screens show those answers.

## Appendix A. Sources

- [Manage Custom User Fields](https://developers.google.com/workspace/admin/directory/v1/guides/manage-schemas), the guide, read on 2026-11-01.
- [Directory API discovery document](https://admin.googleapis.com/$discovery/rest?version=directory_v1): `schemas`, `Schema`, `SchemaFieldSpec`, `users.patch`, `users.update`, `users.get`, and `UserCustomProperties`, read on 2026-11-01.
- Admin help, read on 2026-11-01: [Create custom attributes for user profiles](https://knowledge.workspace.google.com/admin/users/create-custom-attributes-for-user-profiles) and [Troubleshoot custom user attribute errors](https://knowledge.workspace.google.com/admin/users/troubleshoot-custom-user-attribute-errors).
- Repository, `origin/main` at `7e7e81e`: every `path:line` above, read with `git show`. The [planning baseline](user-management-planning-baseline.md) of 2026-11-01, sections 1 to 8.
