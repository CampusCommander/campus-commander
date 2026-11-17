# Google users and custom attributes: planning baseline

The eng-lead wrote this baseline on 2026-11-01. Both technical designs and both mockups cite it.
The owner decisions now sit in the [user management record](../workflows/user-management.md).
This file fixes the scope, the vocabulary, the proposed defaults, and the open owner questions.
A TDD or a mockup that departs from it names the departure as an open point. It never decides it silently.

## 1. Owner direction (verbatim, 2026-11-01, main chat)

> I want you to start the plan to add user entity managment to the app. This should have the look and feel of the device managment to keep a consistant UI/UX. One big diffrence is that users have custom schema. We will need a unique UI/UX to manage this, both in creating the schema and assigning it. Create both Technical Design Docs as Views in Figma.

Main-chat reading (sent to the owner for correction):

- Two technical design documents: (A) Google user management, (B) custom user attributes (schema create and value assignment).
- Figma views for both, on new pages of the Campus Commander Figma file, in the look of the built device management.
- Each Figma page also opens with a "Start here" frame that summarizes its design document.

## 2. Earlier owner decisions that bind this work

Repository base: `origin/main` at `7e7e81e`.

- Development order step 6 (`docs/current-work.md`): "Reuse the working interaction patterns for Google users, OUs, and groups, in that order."
- Gap G19 (`docs/workflow-gaps.md`, row G19 at `7e7e81e`): users page coverage in Figma page `240:2`. "Creation, password handoff, additional account actions, and CSV need complete workflows before implementation. These are Google accounts, not platform access."
- Permission catalog (`docs/workflows/platform-access.md`, sections "Granular permissions" and "User Schema Manage coverage — 2026-10-05"): User Read, User Write, User Schema Manage, User Bulk Actions.
  - User Schema Manage covers custom schema definitions only. It is domain-wide. OrgUnit collections do not limit it.
  - Changing a user's custom attribute values requires User Write within the scope that contains that user.
  - "The Read dependency of User Schema Manage remains open." "The presentation of this domain-wide permission within scoped assignments remains open."
  - Write and Bulk Actions include the entity's Read permission. A Google user move requires User Write for the current and destination OrgUnits.
- Domain model (`docs/portfolio/02-domain-model.md`, "### Users"): cached fields, writable surface, bulk actions, "Group membership is not a Users field."
- Owner UI preferences from the device workflows. Both mockups follow them:
  - Instructions sit in help docs behind an info or help icon button, never in the flow. State messages stay in the flow: errors, limits, counts, and expiries.
  - A multi-step flow ends where it starts. Progress, the report, and the next action share one dialog. Job IDs show as secondary links. The person never needs the job page to finish.
  - The result screens carry the design. The results reuse the review table with an outcome column. The jobs sit above it as a compact secondary part. A Failed view with its count keeps the failures one click away.
  - Setup and progress steps show only the raw data at the built dialog width. The dialog widens to a wide modal when tables or reports arrive. Never fill spare width with a preview or sample rows.
  - Shell identity text uses example values `example.org` and `C0123456`.
  - Dialogs, not side sheets, for the newer flows (owner, 2026-10-28: "a dialog instead of a sidebar").

## 3. Google facts (verified 2026-11-01)

Sources: the Directory API discovery document (`https://admin.googleapis.com/$discovery/rest?version=directory_v1`) and the guide "Manage Custom User Fields" (`https://developers.google.com/workspace/admin/directory/v1/guides/manage-schemas`).

- Resource `schemas`: list, get, insert, update (PUT), patch, delete on `admin/directory/v1/customer/{customerId}/schemas[/{schemaKey}]`.
  - Read scopes: `admin.directory.userschema.readonly` or `admin.directory.userschema`. Write scope: `admin.directory.userschema`.
- Schema: `schemaId` (read only), `schemaName` (unique per customer, 409 on reuse), `displayName`, `fields[]`, `etag`.
- Field (`SchemaFieldSpec`): `fieldName`, `fieldId` (read only), `fieldType` (STRING, INT64, BOOL, DOUBLE, EMAIL, PHONE, DATE), `multiValued` (default false), `indexed` (default true), `readAccessType` (ALL_DOMAIN_USERS default, or ADMINS_AND_SELF, and a change takes up to 24 hours), `displayName`, `numericIndexingSpec` (`minValue`, `maxValue`, indicative only, enables range queries), `etag`.
- Limits: 100 custom schemas per account. 100 custom fields per account. 500 characters for a single-valued string. Names allow letters, digits, `_`, and `-`.
- Changing a field type is not allowed. Single-valued can become multi-valued. The inverse is not allowed. Schemas and fields cannot be renamed.
- User values: `users.customSchemas` maps `schemaName` to `{ fieldName: value }`. A multi-valued field holds `[{ value, type?, customType? }]`, `type` one of work, home, other, custom.
  - A PATCH leaves unspecified fields unchanged. Setting a field or schema to `null` removes it.
  - `users.get` and `users.list` return custom fields with `projection=custom` (plus `customFieldMask`) or `projection=full`.
  - `users.list` searches custom fields with `schemaName.fieldName` query syntax.
- Google warns against storing sensitive personal data in custom fields (government ID numbers, financial, health).
- Google has no "assign a schema to some users" concept. Every schema exists for the whole account. Any user can hold values.
- Google Admin console labels (for the UI vocabulary): "Custom attributes", "Category" (schema), custom field "Name", "Info type" (Text, Whole number, Decimal number, Yes or no, Date, Email, Phone), "Visibility" (Visible to user and admin, Visible to organization), "Searching", "No. of values" (Single value, Multi-value).

## 4. Current platform facts

- No Google users code exists in `api`, `libs`, or `frontend` on `origin/main`. Users are greenfield.
- Configured DWD scopes (`docs/portfolio/phase-3-google-credentials.md`): customer, domain, orgunit, and ChromeOS device reads, plus the device write and Drive scopes added by later workflows. No user or userschema scope is configured.
  - The owner must add each new scope to the domain-wide delegation in his Google Admin console before a live check. Never ask for a key or secret in chat.
- The standing live test authorization (AGENTS.md) covers read-only checks on the owner's domain. A live schema create, update, or delete, and every user write, need the owner's explicit yes.
- admin-sdk-mock (`CampusCommander/admin-sdk-mock`, `origin/main` at `733ddf8`, v0.3.0) serves users with `projection` basic, full, and custom, and user writes. It has no `schemas` resource and no custom schema values. A mock release (0.4.0) adds them. Publishing a mock release needs the owner's yes (precedent: 0.3.0).
- Reusable built patterns: the entity cache (`docs/superpowers/specs/2026-10-06-entity-cache-decisions.md`), the Google batch service (`2026-10-07-google-batch-service-decisions.md`), device write jobs (`2026-10-16-device-write-jobs-design.md`, `2026-10-19-device-write-worker-contracts.md`), Update device fields (`2026-10-21-update-device-fields-design.md`), in-grid editing (`2026-10-23-in-grid-editing-design.md`), job cancel (`2026-10-26-job-cancel-design.md`), export and import (`2026-10-28-device-export-import-design.md`, `docs/research/batch-update-export-import-technical-design.md`), the LiveFeeds event stream (`GET /api/events`).

## 5. Vocabulary (one name for one thing)

| UI label                     | Design term       | Google API                             |
| ---------------------------- | ----------------- | -------------------------------------- |
| Custom attributes (the page) | custom attributes | schemas                                |
| Category                     | category          | schema (`schemaName`, `displayName`)   |
| Attribute                    | attribute         | field (`fieldName`, `displayName`)     |
| Info type                    | info type         | `fieldType`                            |
| Value                        | value             | `customSchemas.<schema>.<field>` entry |
| Visibility                   | visibility        | `readAccessType`                       |
| Searchable                   | searchable        | `indexed`                              |
| Multiple values              | multi-value       | `multiValued`                          |

Info type labels: Text (STRING), Whole number (INT64), Decimal number (DOUBLE), Yes or no (BOOL), Date (DATE), Email (EMAIL), Phone (PHONE).
Visibility labels: "Admins and the user" (ADMINS_AND_SELF), "Everyone in the organization" (ALL_DOMAIN_USERS).
"Assign" in the owner's words maps to "set attribute values on users" under the owner's answer to question U1 (option 1, 2026-11-16).

## 6. Proposed scope and slices

Users are Google Workspace accounts, not platform users. The look copies the built Devices page, device details, Bulk Actions, the dialogs of the export and import flow, the job results, and in-grid editing.

| Slice                   | Content                                                                                                                                                                                  | Design document                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| S1 Browse users         | Users nav item, Users grid (typed filters, columns panel, paging, server-side selection, Refresh), user details, custom attribute values shown read only, the user entity cache and sync | A                                 |
| S2 Manage categories    | Custom attributes page: category list, create category, edit category (add attributes, safe changes), delete category or attribute with a typed phrase, limits, review, job, result      | B                                 |
| S3 Set attribute values | One user (details page), in-grid editing of attribute columns, bulk "Set attributes" from Bulk Actions with modes, review, job, results                                                  | B (uses A's grid and details)     |
| S4 Account actions      | Suspend, Reactivate, Move to OU, Sign out, Require password change                                                                                                                       | A (contract only, no screens now) |
| S5 Export and import    | Users export and import with attribute columns                                                                                                                                           | A (contract only, no screens now) |

Excluded now: user creation and deletion, password handoff, licenses, aliases editing, group membership (G21), admin roles, Classroom, platform access. Each one shows nowhere in the screens.

## 7. Proposed defaults (the documents and the screens build them, the owner can object)

1. Navigation: a "Users" item directly below "Devices" in the left navigation.
2. Users grid default columns: Name, Primary email, Organization unit, Status, Last sign-in, 2-step verification. Optional columns: Created, Department, Title, and one column for each attribute. Attribute columns are hidden by default and show in the Columns panel under their category name.
3. Status values: Active, Suspended, Archived. A suspended user shows the Google suspension reason in details.
4. Filters: the device filter row behavior. Each attribute filters by its info type (text contains, number range, date range, yes or no, has a value). The filter reads the local cache, so a non-searchable attribute still filters.
5. User details: the device details layout. Title is the full name. Cards: Account, Organization, Custom attributes (one section for each category, "Not set" for an empty value, chips for multiple values).
6. Every Google write runs as a job, as device writes do. A category change is a job of one operation. The dialog shows its progress and result in place, with the job ID as a secondary link.
7. A new attribute defaults to Visibility "Admins and the user" and Searchable on. School data holds student records.
8. The category editor locks what Google cannot change: name, info type, and the change from multiple values back to one value. Each locked control shows the reason as a short state message.
9. Removing an attribute or deleting a category deletes the values on every user. Both need a typed phrase and show the count of users with values from the cache.
10. The editor and the list show the account limits as counts: "11 of 100 attributes used", "3 of 100 categories used".
11. Bulk "Set attributes" modes: single value: Set value, Clear value. Multiple values: Add values, Remove values, Replace all values, Clear values. Review shows current and new values for each user, then Confirm, then a job. One pending in-grid change saves at once, as in device in-grid editing.
12. Job display ID prefixes (drafted): `CAT-` for category jobs, `UAT-` for attribute value jobs.
13. Scenario data: domain `example.org`, customer `C0123456`, a school district. Categories: "Student information" (`StudentInfo`: Student ID text, Grade level whole number 0 to 12, Graduation year whole number, Homeroom text, Programs text multi-value), "Staff information" (`StaffInfo`: Employee ID text, Building text, Hire date date, Certifications text multi-value), "Device program" (`DeviceProgram`: Take-home approved yes or no). That is 3 of 100 categories and 10 of 100 attributes.

## 8. Owner questions (numbered, recommendation first, never renumbered)

The owner wrote "All recommended" on 2026-11-16. Each question takes option 1, marked "(Recommended, chosen)".

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

Technical design A adds U6, and technical design B adds U7. The same answer chose option 1 of both.

The screens follow the recommended answer of each question, which the owner chose. The notes and the documents name each state that a different answer changes.
