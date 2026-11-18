# Google user management

Technical design A · proposed for Campus Commander · 2026-11-01

Status: proposed. The owner reviews this document before any build card starts. It authorizes no build.
Owner answers, 2026-11-16: "All recommended". Questions U1 to U7 take option 1 (section 15).
On 2026-11-16 the owner approved the screens: "1) Approved". This document stays proposed. The design addendum decides the build.
Record: [Google users and custom attributes](../workflows/user-management.md). Approved screens: [users](../ui/designs/2026-11-16-user-management.html) and [custom attributes](../ui/designs/2026-11-16-custom-attributes.html).

Scope: slice S1 Browse users, and the contracts of the later slices S4 and S5.
Companion: the custom attributes design (document B), written in parallel. It owns categories, attributes, and value writes.
Source: the owner's direction of 2026-11-01 and the [planning baseline](user-management-planning-baseline.md) of the same day.
Baseline: repository `origin/main` at `7e7e81e`. Workflow gap: G19 (`docs/workflow-gaps.md:77`).

Reading guide:

- [Authority](#1-purpose-and-authority), [scope](#2-outcome-and-scope), [vocabulary](#3-vocabulary), [workflows](#4-user-workflows), [architecture](#5-architecture-and-reuse), [Google API usage](#6-google-api-usage), [data model](#7-data-model), [API contracts](#8-api-contracts), [grid and details](#9-grid-and-details)
- [Authorization](#10-authorization), [states](#11-states), [later slices](#12-later-slices), [testing](#13-testing-and-live-checks), [risks](#14-risks), [owner questions](#15-owner-questions-and-engineering-defaults), [delivery](#16-delivery-plan), and the [start frame summary](#17-summary-for-the-figma-start-frame)

## 1. Purpose and authority

This document designs Google Workspace user management for Campus Commander. It copies the built device management.
Each technical choice cites a source: `path:line` at `7e7e81e`, a Google document, or a baseline default.
A choice without a source becomes an owner question in section 15. Section 15.4 lists the engineering defaults.

The owner, in the main chat, 2026-11-01:

> I want you to start the plan to add user entity managment to the app. This should have the look and feel of the device managment to keep a consistant UI/UX. One big diffrence is that users have custom schema. We will need a unique UI/UX to manage this, both in creating the schema and assigning it. Create both Technical Design Docs as Views in Figma.

Earlier decisions that bind this design:

| Date                   | Direction                                                                                                                                                                                         | Source                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-17             | "Granular. Device Read, Device Write, Device Deprecate, Device Bulk Actions, User Read, User Write , User schema manage, User Bulk Actions, etc"                                                  | `docs/workflows/platform-access.md:636`                                                                                                  |
| 2026-09-17             | "Yes. Bulk actions gives access to the Bulk Actions menu dropdown button. Further permissions show which features are enabled in that dropdown."                                                  | `docs/workflows/platform-access.md:668`                                                                                                  |
| 2026-09-17             | "Access is scoped by OrgUnits or a collection of OrgUnuits"                                                                                                                                       | `docs/workflows/platform-access.md:767`                                                                                                  |
| 2026-10-05             | User Write and User Bulk Actions include User Read. User Schema Manage covers definitions only. Values need User Write.                                                                           | `docs/workflows/platform-access.md:696`, `:712-717`                                                                                      |
| 2026-10-05             | A user move needs User Write in both OrgUnits. A bulk move also needs User Bulk Actions.                                                                                                          | `docs/workflows/platform-access.md:759-761`                                                                                              |
| 2026-10-06, 2026-10-07 | Entity cache decisions D1 to D15 and Google batch service decisions B1 to B13, owner-confirmed                                                                                                    | `docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:3`, `docs/superpowers/specs/2026-10-07-google-batch-service-decisions.md:3` |
| 2026-10-19             | "We are building a doghouse. We dont need to choose the curtains."                                                                                                                                | `docs/superpowers/specs/2026-10-23-in-grid-editing-design.md:6`                                                                          |
| Order step 6           | "Reuse the working interaction patterns for Google users, OUs, and groups, in that order."                                                                                                        | `docs/current-work.md:404`                                                                                                               |
| Gap G19                | "These are Google accounts, not platform access."                                                                                                                                                 | `docs/workflow-gaps.md:77`                                                                                                               |
| Domain model           | Cached fields, writable surface, and bulk actions of Users. "Group membership is not a Users field." Every mutation follows one chain: selection or draft, preview, confirm, job, audited result. | `docs/portfolio/02-domain-model.md:71-78`, `:162`                                                                                        |

## 2. Outcome and scope

An administrator opens Users, finds Google Workspace accounts with typed filters, and opens the details of one account.
The grid and the details look and behave like the built Devices page.
S1 reads data only. It changes nothing in Google Workspace.

| Included capability                                                                        | Slice | Source                                 |
| ------------------------------------------------------------------------------------------ | ----- | -------------------------------------- |
| Users item directly below Devices in the left navigation                                   | S1    | Baseline default 1                     |
| Users grid: typed filters, Columns panel, paging, server-side selection, and Refresh       | S1    | Baseline section 6                     |
| Default and optional columns, and the status values                                        | S1    | Baseline defaults 2 and 3              |
| User details: Account and Organization cards, and the card slot for document B             | S1    | Baseline default 5                     |
| Raw custom attribute values in the cache, shown read only                                  | S1    | Baseline section 6                     |
| User entity cache, full user sync, refresh of stale and selected users, and the users feed | S1    | Entity cache D1 to D15                 |
| User Read, the two read scopes, and the missing-scope states                               | S1    | Permission catalog, baseline section 4 |
| Contract of Suspend, Reactivate, Move to OU, Sign out, and Require password change         | S4    | Baseline section 6                     |
| Contract of the users export and import with attribute columns                             | S5    | Baseline section 6                     |

Excluded:

- User creation and deletion, password handoff, licenses, aliases editing, group membership (G21), admin roles, Classroom, and platform access.
- The baseline excludes each of these (section 6). Screens for S4 and S5 wait: section 12 holds contracts only.
- Archive and Unarchive. The domain model lists them (`docs/portfolio/02-domain-model.md:76`). The baseline S4 list omits them.
- Grouping, and Bulk Actions in S1. The baseline S1 list names neither. Bulk Actions arrives with the first user action (`docs/workflows/device-browsing.md:220`).
- Categories, the category editor, value writes, attribute editors, and User Schema Manage. Document B owns them.
- Search through the `users.list` `query` parameter. Filters read the cache (baseline default 4).

## 3. Vocabulary

| Term                                  | Meaning                                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| User, User ID                         | A Google Workspace account, Directory API resource `users`, never a platform user. Its immutable `id` keys the cache. |
| Full user sync                        | One complete `users.list` enumeration under a lease. Refresh Users starts it.                                         |
| Refresh job                           | One job of `users.get` calls in batches. Stale rows and Refresh Selected start it.                                    |
| Last Google read                      | The time Campus Commander last read the user from Google (`last_entity_sync`).                                        |
| Last sign-in                          | The Google `lastLoginTime`. It differs from the last Google read (G25, `docs/workflow-gaps.md:83`).                   |
| Stale, removed                        | A last Google read older than 24 hours. A removed user is one that Google no longer returns. Its row stays.           |
| Raw values                            | The `customSchemas` object of one user, stored unchanged.                                                             |
| Category, attribute, value, info type | The custom attribute terms of the baseline vocabulary. Document B defines them.                                       |

## 4. User workflows

| Workflow | Steps                                                                                                                                                                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browse   | Open Users from the left navigation. The grid shows the default columns, 100 users per page, in Name order. The footer shows the matching count, the domain total, the last full sync time, and the selection. The page size selector offers 50, 100, and 250.                                                                              |
| Filter   | Select Add a filter, choose a field or a shortcut, and apply a typed value (GRID-04, `docs/ui/patterns.md:39`). Each filter shows as a chip. Clear filters removes every chip and keeps the selection. An attribute filter follows its info type and reads the cache, so a non-searchable attribute still filters (baseline default 4).     |
| Inspect  | Select the eye icon of a row (GRID-03, `docs/ui/patterns.md:28-30`). The details show the full name as the title and the OrgUnit path in the subtitle. The cards show the cached values read only. Next user follows the filtered order. Back to users restores the filters, the page, and the scroll position.                             |
| Select   | Check rows, or use Select All in the footer for every matching user. The selection survives paging, sorting, filters, and refresh until 12 hours after its last change. In S1 it serves Refresh Selected only.                                                                                                                              |
| Refresh  | Open Refresh and choose Refresh Selected, Refresh Users, or Refresh Domain (GRID-01, `docs/ui/patterns.md:21-22`). Refresh Domain runs Refresh Users and then reads the domain details again, as for devices. Rows update in place when each batch lands. A query that matches stale users starts a refresh job for them (entity cache D4). |

## 5. Architecture and reuse

The users code mirrors the device code file by file.
It adds no generic base class, repository, or plugin registry (entity cache D14, `docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:125-130`).
Names that D14 already keys by entity type gain the value `user`.

| Responsibility                    | Device component that it mirrors                                                                                                               | Users part                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Navigation and routes             | `frontend/src/app/shell/shell.html:30-39`, `frontend/src/app/app.routes.ts:64-74`, `:96-106`                                                   | New Users item below Devices. New routes `users` and `users/:userId`. |
| Page store and route gate         | `frontend/src/app/devices/devices.store.ts:56-63`, feed at `:457-458` through `LiveFeeds` (`frontend/src/app/jobs/live-feeds.ts:71`)           | New users store                                                       |
| Field registry                    | `DEVICE_FIELDS`, `frontend/src/app/devices/device-fields.ts:61-74`                                                                             | New static list plus the attribute column hook                        |
| Details page                      | `frontend/src/app/devices/device-detail.html:19-46`                                                                                            | New page with a card slot for document B                              |
| API controller, query, and paging | `api/src/app/devices/devices.controller.ts:51-101`, `api/src/app/devices/device-query.ts:189-206`, `api/src/app/devices/device-pager.ts:41-42` | New users controller, query, and pager                                |
| Selection and refresh             | `api/src/app/devices/device-selection.ts:13-20`, `api/src/app/devices/device-refresh.ts:12-16`                                                 | New user selection and refresh, same expiry and claim rule            |
| Redis caches                      | `api/src/app/cache/cache.service.ts:16`, keys at `libs/application-contracts/src/lib/entity-cache.ts:50-64`                                    | Reused with entity type `user`                                        |
| Event stream                      | `api/src/app/events/events.controller.ts:67-92`, `:143-164`                                                                                    | Adds the users feed                                                   |
| Google reads                      | `GoogleDeviceReader`, `libs/google-connection/src/lib/devices.ts:580-613`, `:723-745`, over `libs/google-connection/src/lib/batch.ts`          | New user reader, same pager and batch service                         |
| Workers                           | `DeviceSync`, `worker/src/device-sync.ts:202-203`, and `EntitySyncBatch`, `worker/src/entity-sync.ts:88-94`                                    | New user sync and flow. The batch worker dispatches by entity type.   |
| Kestra flows                      | `deployment/kestra/device-sync.yaml`, `deployment/kestra/entity-sync.yaml`                                                                     | New user sync flow. The refresh flow is reused.                       |
| Tables                            | `deployment/postgres/migrations/016-device-inventory.sql:6-71`                                                                                 | New migration (section 7)                                             |
| Capabilities and permissions      | `libs/application-contracts/src/lib/google-capabilities.ts:2-106`, `libs/application-contracts/src/lib/authorization.ts:3-61`                  | Two read capabilities and `users:read`                                |

Each new file of S1 sits in a new `users` folder or beside its device counterpart.

### 5.1 Interface with the custom attributes design (document B)

| Interface point     | Document A provides                                                                         | Document B provides                                                  |
| ------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Raw values          | `cc.users.custom_schemas`, the raw `customSchemas` object of each user, in rows and details | The meaning of each key: category, attribute, info type, multi-value |
| Category read       | The capability `user-schemas` and its scope in the setup list                               | The `schemas.list` read, its storage, and its contract               |
| Dynamic column hook | A registry function that turns category metadata into optional columns and filters          | The category metadata, and in S3 the editor of each attribute column |
| Details card slot   | A slot after the Organization card, with the user record and its record version             | The Custom attributes card                                           |
| Selection           | The users selection key and its resolve route                                               | Bulk "Set attributes", which takes that key                          |
| Settled writes      | The worker upserts each read-back user, raises the query generation, and publishes the feed | Value write jobs that return read-back users                         |

S1 builds the category read of document B, with no page and no editor. This is open point 1 (section 15.3).

## 6. Google API usage

Paths start with `https://admin.googleapis.com/admin/directory/v1`. Each call uses a delegated token for its own scope.
Batch parts go to `https://www.googleapis.com/batch/admin/directory_v1`, as device reads do (`libs/google-connection/src/lib/devices.ts:93`).

| Call                                                 | Use                              | Parameters                                                              | Paging                                | Scope suffix                          |
| ---------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------- | ------------------------------------- | ------------------------------------- |
| `users.list`, `GET /users`                           | Full user sync                   | `customer=<customer ID>`, `projection=full`, `maxResults=500`, `fields` | `nextPageToken`, at most 10,000 pages | `admin.directory.user.readonly`       |
| `users.get`, `GET /users/{userKey}`, in batch parts  | Refresh job, 100 users per batch | `userKey=<user ID>`, `projection=full`, `fields`                        | None                                  | `admin.directory.user.readonly`       |
| `schemas.list`, `GET /customer/{customerId}/schemas` | Category read of document B      | `customerId=<customer ID>`                                              | None                                  | `admin.directory.userschema.readonly` |

The `users.get` fields mask is `id,primaryEmail,name(givenName,familyName,fullName),orgUnitPath,suspended,suspensionReason,archived,lastLoginTime,creationTime,isEnrolledIn2Sv,organizations(primary,department,title),aliases,customSchemas`.
The `users.list` mask wraps the same fields as `nextPageToken,users(...)`.

- `projection=full` returns every category without schema names (baseline section 3). `projection=custom` needs them (discovery document).
- `customer` returns every domain of the account. `viewType` keeps its default, the administrator view (discovery document).
- `maxResults=500` is the Google maximum (discovery document, `docs/portfolio/03-architecture.md:527`).
- The pager stops after 10,000 pages, and a page answer keeps the 4 MiB cap, as for devices (`libs/google-connection/src/lib/devices.ts:28-30`).
- A 404 for one user in a refresh job marks that user removed (entity cache D15, `docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:136-144`).
- Quota: the Directory API default is 2,400 requests per minute per user per project (`docs/portfolio/03-architecture.md:521`). Device and user reads share it.
- One list page costs one request, so 50,000 users cost 100 requests. A batch of n parts costs n (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:69`).
- Quota answers back off per part with full jitter, up to 25 retries (B10, `docs/superpowers/specs/2026-10-07-google-batch-service-decisions.md:121-133`).
- Kestra runs two refresh jobs and four batches at a time (`deployment/kestra/entity-sync.yaml:4-5`, `:20`).
- In the product, `users.list`, `users.get`, and `schemas.list` run against Google. The live read-only check of section 13 proves this path.
- Integration tests run the same calls against admin-sdk-mock 0.4.0, target `api-e2e:admin-sdk-mock-integration` (`api-e2e/project.json:42`).
- Unit tests run the reader parsers against the batch fake (`libs/google-connection/src/lib/batch-fake.mjs`), without network.

## 7. Data model

A new migration `019-user-inventory.sql` joins `deployment/postgres/migrations/`. It leaves migration 016 unchanged.
`cc.user_sync_state` copies `cc.device_sync_state` without telemetry: lease, last enumeration, count, and failure (`deployment/postgres/migrations/016-device-inventory.sql:6-32`).
`cc.users` holds one mutable row per user, upserted by both sync paths (entity cache D3, `docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:47-51`).

| Column                                                  | Type                                                                            | Google source                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `customer_id`, `user_id`                                | text, primary key                                                               | the customer, `id`                                                    |
| `primary_email`, `org_unit_path`                        | text, not null. The path starts with `/`.                                       | `primaryEmail`, `orgUnitPath`                                         |
| `given_name`, `family_name`, `full_name`                | text                                                                            | `name`                                                                |
| `suspended`, `suspension_reason`, `archived`            | boolean not null, text, boolean not null                                        | `suspended`, `suspensionReason`, `archived`                           |
| `last_login_time`, `creation_time`, `two_step_enrolled` | timestamptz, timestamptz, boolean not null. The last sign-in is null for never. | `lastLoginTime`, `creationTime`, `isEnrolledIn2Sv`                    |
| `department`, `title`, `aliases`                        | text, text, jsonb array                                                         | the `primary` entry of `organizations`, else the first, and `aliases` |
| `custom_schemas`                                        | jsonb object, not null, default `{}`                                            | `customSchemas`, unchanged                                            |
| `last_entity_sync`, `removed_at`, `record_version`      | timestamptz, timestamptz, bigint                                                | Campus Commander                                                      |

- `record_version` follows the device trigger (`deployment/postgres/migrations/016-device-inventory.sql:73-86`). Document B reads it for conflict checks.
- S4 adds the observed-at stamps of its writable fields, as the device table holds them (`deployment/postgres/migrations/016-device-inventory.sql:54-60`).
- B-tree indexes copy the device indexes (`deployment/postgres/migrations/016-device-inventory.sql:66-71`): name, email, OrgUnit path, last sign-in, and freshness.
- A GIN index on `custom_schemas` with `jsonb_path_ops` serves the attribute equality and has-a-value filters.
- `cc.entity_sync_jobs.entity_type` accepts `'user'` (`deployment/postgres/migrations/016-device-inventory.sql:107`). `entityTypeSchema` gains `user` (`libs/application-contracts/src/lib/entity-cache.ts:13-19`).
- Redis keys reuse the typed builders: `cc:entity:user:*`, `cc:query-gen:user:*`, `cc:entity-inflight:user:*` (`libs/application-contracts/src/lib/entity-cache.ts:50-57`).
- The Redis entry holds the user record and its entry version (D9 amendment, `docs/superpowers/specs/2026-10-06-entity-cache-decisions.md:162`).

## 8. API contracts

Every route sits under `/api/users/` behind the session guard. Each route mirrors the device route of the same name.
Each route requires `users:read` for the connected customer, as the device routes require `devices:read` (`api/src/app/devices/devices.controller.ts:86-101`).

| Route                                                                                  | Purpose                                                                                      |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /api/users/sync`, `POST /api/users/sync`                                          | Read the user sync state. Refresh Users: start a full user sync.                             |
| `POST /api/users/query`, `by-ids`, `freshness`                                         | One page of rows. The rows that a feed event names. The stale count and the running refresh. |
| `POST /api/users/selection`, `selection/ops`, `selection/resolve`, `selection/refresh` | Read, change, and resolve the selection. Refresh Selected.                                   |
| `POST /api/users/domain/refresh`, `GET /api/users/org-units`, `GET /api/users/:userId` | Refresh Domain. The OrgUnits that hold users, with counts. User details.                     |

The users API has no `groups` route, because S1 has no grouping.

**Query.** The body copies `deviceQuerySchema` (`libs/application-contracts/src/lib/devices.ts:298-313`).
It holds `predicates` (at most 20, joined by AND), `sort`, `offset`, `limit` (default 100, at most 1,000), and `selection`.
The answer copies `devicePageSchema`: `rows`, `matching`, `total`, `observedAt`, and `refreshJobId` (`libs/application-contracts/src/lib/devices.ts:315-322`).
A row holds the grid fields, `customSchemas`, `lastEntitySync`, `stale`, and `recordVersion`.

| Filter field                                  | Operators                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Name, Primary email, Department, Title, Alias | Contains, Starts with, Is, Is empty. Alias: Contains and Is (`docs/portfolio/02-domain-model.md:74`). |
| Organization unit                             | In, with the descendant operator of the tree picker                                                   |
| Status, 2-step verification                   | Is: Active, Suspended, Archived. Is: Enrolled, Not enrolled.                                          |
| Last sign-in, Created                         | Before, After                                                                                         |
| Attribute                                     | By info type: text contains, number range, date range, yes or no, has a value (baseline default 4)    |

An attribute predicate names `schemaName`, `fieldName`, the operator, and the value.
Names and values travel only as query parameters, as device predicates do (`api/src/app/devices/device-query.ts:66`).

**Selection.** It copies the device contract: filter terms, additions, and exceptions (`api/src/app/devices/device-selection.ts:24-30`).
It expires 12 hours after its last change and holds at most 200,000 explicit IDs (`api/src/app/devices/device-selection.ts:13-20`).
Refresh Selected starts one job of at most 100,000 users. A new job answers 201, and a fully claimed selection 200 (`api/src/app/devices/device-selection-refresh.ts:20`, `:50-51`).

**Details and refresh.** `GET /api/users/:userId` returns the record with `aliases`, `customSchemas`, `stale`, `removedAt`, and `recordVersion`. An unknown ID answers 404.
Without a Google connection, each refresh route answers 409 `connection-required` (`api/src/app/devices/devices.controller.ts:108-112`).

**Events.** The users feed is a third feed of `GET /api/events`, beside the job and device feeds (`api/src/app/events/events.controller.ts:67-92`).
It opens when the caller holds `users:read` and a user sync exists, by the rule of `deviceFeed` (`api/src/app/events/events.controller.ts:143-164`).
It carries `entity-batch` with user IDs and removed IDs, `job-finished` with the visible failure, and the sync state.

Every event names its entity type. Each feed forwards the events of its own entity type only.
Each ping rechecks the feed without an audit row, as `deviceReadable` does (`api/src/app/events/events-stream.ts:86-98`).
The client intersects the event IDs with its rows and calls `POST /api/users/by-ids` once (entity cache D7).

## 9. Grid and details

| Column                   | Google field                                          | Default  | Filter type  | `inGridEditor`                          |
| ------------------------ | ----------------------------------------------------- | -------- | ------------ | --------------------------------------- |
| Name                     | `name.fullName`                                       | Shown    | text         | `null`                                  |
| Primary email            | `primaryEmail`                                        | Shown    | text         | `null`                                  |
| Organization unit        | `orgUnitPath`                                         | Shown    | orgUnit      | `null`                                  |
| Status                   | `suspended`, `archived`                               | Shown    | enum         | `null`                                  |
| Last sign-in             | `lastLoginTime`                                       | Shown    | dateTime     | `null`                                  |
| 2-step verification      | `isEnrolledIn2Sv`                                     | Shown    | boolean      | `null`                                  |
| Created                  | `creationTime`                                        | Optional | dateTime     | `null`                                  |
| Department, Title        | `organizations[].department`, `organizations[].title` | Optional | text         | `null`                                  |
| One column per attribute | `customSchemas.<category>.<attribute>`                | Optional | by info type | `null` in S1. Document B sets it in S3. |

- The selection and details columns come first, as in every entity grid (GRID-03, `docs/ui/patterns.md:28-30`).
- The columns and defaults follow baseline default 2. Every S1 column is read only (`docs/ui/patterns.md:33-34`).
- The field contract gains a `userColumns` list beside `deviceColumns` (`docs/ui/entity-grid-fields.json:128`).
- Status reads Archived when `archived` is true, else Suspended when `suspended` is true, else Active (baseline default 3).

**Attribute column hook.** The users field registry holds the static fields and one function for attribute fields.
The function takes the category metadata of document B and returns one optional field per attribute.
The field ID is `attribute:<schemaName>.<fieldName>`, and the label is the display name of the attribute.
The Columns panel lists attribute columns under their category display name, hidden by default (baseline default 2).
The info type selects the filter control and its operators (baseline default 4). The cell reads the raw value of the row.

**Details.** The page copies the device details layout (`frontend/src/app/devices/device-detail.html:19-46`). The title is the full name (baseline default 5).
The subtitle reads "User details" and the OrgUnit path. The actions are Back to users and Next user. S4 adds its actions there.

| Card              | Content                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Account           | Primary email, aliases, status, the suspension reason of a suspended user, last sign-in, created, 2-step verification, last Google read |
| Organization      | Organization unit, department, and title                                                                                                |
| Custom attributes | The slot of document B: one section for each category, "Not set" for an empty value, chips for multiple values                          |

## 10. Authorization

| Action                              | Permission label                         | Scope kinds        | Slice                    |
| ----------------------------------- | ---------------------------------------- | ------------------ | ------------------------ |
| `users:read`                        | User Read                                | platform, district | S1                       |
| `users:write`, `users:bulk-actions` | User Write, User Bulk Actions            | platform, district | S4, and S3 of document B |
| `users:export`                      | None in the catalog, as `devices:export` | platform, district | S5                       |
| `users:schema-manage`               | User Schema Manage                       | platform, district | Document B               |

- Names and scope kinds follow the device actions (`libs/application-contracts/src/lib/authorization.ts:51-58`), registered as `devices:read` is (`deployment/postgres/migrations/016-device-inventory.sql:4`).
- The platform administrator preset holds every action, so it gains `users:read` (`libs/application-contracts/src/lib/authorization.ts:116`).
- Bulk Actions opens the menu. Each action permission enables its item (`docs/workflows/platform-access.md:668-672`, GRID-06).
- `users:export` follows the device export (`docs/research/batch-update-export-import-technical-design.md:1016`).
- Every search, count, details read, selection, and feed event checks the permission (`docs/portfolio/03-architecture.md:176`).

**OrgUnit collections (question U6, option 1 chosen on 2026-11-16).** The owner scoped access by OrgUnits or collections of OrgUnits (`docs/workflows/platform-access.md:767`).
The built grant model knows platform, district, and school scopes only (`libs/application-contracts/src/lib/authorization.ts:29-33`).
No OrgUnit collection exists in the code. Scoped Device Read waits in the same way (`docs/workflows/device-browsing.md:61`).
Under the owner's answer to U6 (option 1), S1 checks `users:read` at district scope. The query takes an OrgUnit scope filter from the start.

**Denied and missing scope.** Without `users:read`, the Users item stays hidden and `/users` redirects to Your account (`frontend/src/app/app.routes.ts:64-74`).
An API call without the permission answers 403. The event stream then omits the users feed (`api/src/app/events/events.controller.ts:158-162`).
A Google denial keeps its shared failure code (`deployment/postgres/migrations/016-device-inventory.sql:14-16`). The page names the denied scope (`docs/workflows/device-browsing.md:118`).

`GOOGLE_CAPABILITIES` and the setup list gain `user-inventory` (`users.list`) and `user-schemas` (`schemas.list`).
Both keep `requiredForConnection: false` and `qualified: false` until the live check, as `device-changes` did (`libs/application-contracts/src/lib/google-capabilities.ts:69-81`).

## 11. States

Each state follows the state table of the UI rules (UI-08, `docs/ui/rules.md:107-118`).

| State                           | Users grid                                                                                       | User details                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Loading                         | A skeleton of the grid. The shell, the filters, and safe controls stay.                          | A skeleton of the cards                                                             |
| Empty                           | No sync yet: the message offers Refresh Users. A synced domain without users: the empty message. | Not applicable                                                                      |
| No matches                      | The no-matches message with Clear filters                                                        | Not applicable                                                                      |
| Offline                         | The connection state and the cached time. Filters and selection stay.                            | "Cannot reach Campus Commander" (`frontend/src/app/devices/device-detail.html:5-6`) |
| Stale                           | The banner reads "Refreshing N of M users" while a job runs (entity cache D11).                  | The last Google read and its age                                                    |
| Denied                          | The item is hidden and the route redirects. A 403 during use shows the permission message.       | The same                                                                            |
| Missing Google scope            | A message that names the scope and links the Google connection page                              | Without the category read: raw category and attribute keys, and the scope message   |
| No Google connection            | The page directs to the Google connection page, as Devices does                                  | The same                                                                            |
| Removed user, expired selection | Removed users stay out of rows and counts. An expired selection shows as empty.                  | A removed user opens and names the removal time                                     |

## 12. Later slices

**S4 Account actions (contract).**

| Action                  | Google call                                      | Body                                              | Scope suffix                    |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------- | ------------------------------- |
| Suspend, Reactivate     | `users.patch`                                    | `{ "suspended": true }`, `{ "suspended": false }` | `admin.directory.user`          |
| Move to OU              | `users.patch`                                    | `{ "orgUnitPath": "<path>" }`                     | `admin.directory.user`          |
| Require password change | `users.patch`                                    | `{ "changePasswordAtNextLogin": true }`           | `admin.directory.user`          |
| Sign out                | `users.signOut`, `POST /users/{userKey}/signOut` | None                                              | `admin.directory.user.security` |

- Each action runs selection, preview, confirm, job, and audited result (`docs/portfolio/02-domain-model.md:162`).
- Writes reuse the device write job model (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:916`). A `users.get` read-back updates the cache.
- Each user needs User Write in its scope, and Bulk Actions adds User Bulk Actions. A move checks both OrgUnits.
- The S4 addendum names the job prefix and the write capabilities, and answers G17 for user jobs (`docs/workflow-gaps.md:75`).

**S5 Export and import (contract).**

- S5 reuses the device flow: export job `EXP`, validation job `IMP`, review, and Execute or Cancel (`docs/superpowers/specs/2026-10-28-device-export-import-design.md:33-42`).
- The edit template holds the User ID, context columns, the S4 writable fields, and one column per attribute. Document B defines the attribute cells.
- Execution reuses the S4 jobs and the value jobs of document B. Import adds no second write engine (`docs/research/batch-update-export-import-technical-design.md:242`).
- A CSV file needs no Google scope. A Drive slice reuses `drive.file` (`libs/application-contracts/src/lib/google-capabilities.ts:82-94`).

## 13. Testing and live checks

**admin-sdk-mock 0.4.0 additions for S1.** The product pins admin-sdk-mock 0.3.0 (`package.json:12`).
At mock commit `733ddf8`, `admin-sdk-mock/src/directory/users.ts:178` ignores `projection`. Lines `:100` and `:113` fix `archived` and `isEnrolledIn2Sv` at false.

| Addition                                                                                                       | Needed for                                    |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `customSchemas` per user: returned with `full`, and with `custom` plus `customFieldMask`, omitted with `basic` | Raw values in the cache                       |
| `schemas.list` and `schemas.get`, and the scope rules of both userschema scopes                                | The category read and missing-scope tests     |
| Seeded `archived`, `isEnrolledIn2Sv`, and `organizations` department and title                                 | Status, 2-step verification, and Organization |
| The scenario of baseline default 13: 3 categories, 10 attributes, values on students and staff                 | Demonstration data                            |

The existing fault rules accept user methods (`admin-sdk-mock/docs/guide/configuration.md:342`). Quota, 403, and 404 tests use them.
Document B adds its schema and value writes to the same release. Publishing it needs the owner's yes, as for 0.3.0 (baseline section 4).

- Unit tests: every reader field, the epoch sign-in value, the primary organization, raw `customSchemas` kept equal, and each predicate.
- Mock integration: full sync, refresh of stale and selected users, 404 removal, quota retry, and missing scope.
- Browser: the grid, filters, Columns panel, details, and every state, on the client-review mock target (`api-e2e/project.json:22`).

Live read-only check, after these preconditions:

1. The owner adds `admin.directory.user.readonly` and `admin.directory.userschema.readonly` to the domain-wide delegation in his Google Admin console.
2. Nobody asks for a key or a secret in chat (baseline section 4).
3. A read-only script, as `deployment/google-proof/device-live.mjs` is for devices, runs `users.list`, one `users.get`, and `schemas.list`.
4. It uses the S1 fields mask. A sanitized evidence file records methods, scopes, HTTP status, counts, and the JSON type of each info type. It holds no user values.

The standing authorization covers this check (`AGENTS.md:38-48`). The fixture holds one user account (`docs/portfolio/phase-3-google-credentials.md:21`). Live user writes of S4 and of document B need the owner's explicit yes (`AGENTS.md:48`).

## 14. Risks

| Risk                      | Effect                                                                                              | Response                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Student records           | The cache holds personal data, attribute values included                                            | Values stay in rows and reports, never in logs. Google warns against sensitive custom fields (baseline section 3).      |
| District-scope User Read  | Every holder of User Read sees every user until OrgUnit collections exist                           | U6 option 1, chosen by the owner. Today only the platform administrator holds grants.                                   |
| Page size and value types | 500 users with large values exceed the 4 MiB cap. The discovery document types values as free JSON. | A mock scenario with 100 attributes and the live check measure both before release.                                     |
| Mass removal              | A complete sync that lists fewer users marks the rest removed                                       | D15 removes only after a complete sync. The architecture asks for quarantine (`docs/portfolio/03-architecture.md:386`). |
| Shared quota              | Device and user syncs share 2,400 requests per minute                                               | Backoff per part (B10). One full sync per entity type at a time.                                                        |
| Attribute scans           | Contains and range filters on attributes scan the rows of the customer                              | Measure on the largest mock tier before release.                                                                        |
| Two times                 | Readers confuse Last sign-in with the last Google read                                              | Separate labels in the grid and the details (G25).                                                                      |

## 15. Owner questions and engineering defaults

The owner wrote "All recommended" on 2026-11-16. Each question takes option 1, marked "(Recommended, chosen)".

### 15.1 Baseline questions, copied unchanged

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

### 15.2 Added question

Document B adds U7 (clearing values before a removal).

- U6. Does S1 ship User Read at district scope before OrgUnit collections exist?
  1. (Recommended, chosen) Yes. S1 checks User Read for the whole domain, as Device Read does today (`docs/workflows/device-browsing.md:61`). The query takes an OrgUnit scope from the start.
  2. No. S1 waits for OrgUnit collections in the platform-access build (G03). Users stays hidden until then. The code holds no collection model yet.

### 15.3 Open points: departures from the baseline

1. S1 builds the category read of document B, so the details show category and attribute names. The baseline puts category work in S2.
2. S1 checks User Read at district scope, not by OrgUnit collection (section 10). The owner chose this with U6 option 1.
3. Sign out needs the scope `admin.directory.user.security` (discovery document). The baseline names no S4 scope.

### 15.4 Engineering defaults (the owner can change each one)

| Topic                        | Default                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Freshness                    | 24 hours, as devices (`libs/application-contracts/src/lib/entity-cache.ts:17-19`)                                               |
| Paging and sort              | 100 rows, with 50, 100, and 250 offered. Name ascending, then the user ID.                                                      |
| Status precedence            | Archived over Suspended over Active                                                                                             |
| Department and Title         | The `organizations` entry marked `primary`, else the first entry                                                                |
| Never signed in              | The epoch value 1970-01-01 shows "Never" and sorts last (`admin-sdk-mock/src/directory/users.ts:46`)                            |
| Text and date filters        | As devices: letter case ignored, `%` and `_` ordinary. Users without the date never match.                                      |
| Multiple values              | A predicate matches when any value matches. A grid cell lists the values in order with commas.                                  |
| Stale row                    | The Name cell renders muted with the tooltip "Refreshing from Google" (entity cache D11)                                        |
| Batches, claims, query cache | 100 users per batch, 120-second claims, and 5-minute query results (`libs/application-contracts/src/lib/entity-cache.ts:25-34`) |
| First visit                  | No users until Refresh Users                                                                                                    |
| Feed events and alias        | Every users feed event names the entity type `user`. Alias is a filter field without a column.                                  |

## 16. Delivery plan

The order follows the owner's answer to U3 (option 1).

1. Done for U1 to U7 on 2026-11-16 ("All recommended"). The owner reviews the open points of section 15.3 with the screens.
2. admin-sdk-mock 0.4.0 ships the S1 additions and the additions of document B, after the owner's yes.
3. The mockup draws the Users page, the details, and the states in the look of the built Devices page.
4. S1 build: migration, contracts, reader, sync, refresh jobs, routes, users feed, capabilities, and the page.
5. S1 demonstration on admin-sdk-mock, then the live read-only check.
6. S2 and S3 of document B on the S1 grid, details, and selection. S3 adds Bulk Actions.
7. S4 account actions, then S5 export and import, each with its own design addendum.

S2 needs the category read of S1. S5 needs the S4 jobs and the value jobs of document B.
S1 completes when a person browses, filters, selects, refreshes, and inspects users on the mock, and the live check passes.
Passing tests approve no screen. The design addendum after the owner's answers writes the card plan.

## 17. Summary for the Figma start frame

1. Users is a new page directly below Devices.
2. It looks and works like Devices: the same grid, filters, columns, and paging.
3. The grid shows name, email, organization unit, status, last sign-in, and 2-step verification.
4. Status is Active, Suspended, or Archived.
5. Each custom attribute can become a column. Attribute columns start hidden, under their category.
6. Every attribute filters, searchable in Google or not.
7. The eye icon opens the user: Account, Organization, and Custom attributes cards.
8. Refresh reads users again from Google: the selected users, all users, or the whole domain.
9. This first slice only reads. It changes nothing in Google.
10. Account actions, and export and import, come later with their own screens.
11. Creating and deleting users, licenses, and groups stay out of this work.
12. Before the live check, you add two read-only scopes in Google Admin.
13. You answered U1 to U7 on 2026-11-16: all recommended. The screens show those answers.

## Appendix. Sources

- The [planning baseline](user-management-planning-baseline.md) of 2026-11-01, repository `origin/main` at `7e7e81e`, and admin-sdk-mock `origin/main` at `733ddf8`.
- [Directory API discovery document](https://admin.googleapis.com/$discovery/rest?version=directory_v1), read 2026-11-01: `users.list`, `users.get`, `users.patch`, `users.signOut`, `schemas.list`, and `User`.
- [Manage Custom User Fields](https://developers.google.com/workspace/admin/directory/v1/guides/manage-schemas), read 2026-11-01 through baseline section 3.
