# Google users and custom attributes: design addendum

Status: proposed, 2026-11-16. This addendum decides the build of slices S1 to S3 and plans their cards.
Record: [Google users and custom attributes](../../workflows/user-management.md), status proposed. Its decisions, defaults, exclusions, design gap, and completion steps bind this design.
Technical designs: [document A](../../research/google-user-management-technical-design.md) and [document B](../../research/custom-user-attributes-technical-design.md). Both stay proposed.
Owner direction, 2026-10-19: "We are building a doghouse. We dont need to choose the curtains." (`docs/superpowers/specs/2026-10-23-in-grid-editing-design.md:6`)

## Conventions

- `path:line` cites the repository at `7e7e81eca3fb7e51faa96ae282857568d405e231`. `admin-sdk-mock:path:line` cites the mock at `origin/main` `733ddf8`, version 0.3.0.
- "A §N" and "B §N" cite document A and document B. "Baseline §N" and "baseline default N" cite the [planning baseline](../../research/user-management-planning-baseline.md).
- "Record" cites `docs/workflows/user-management.md` by section name.
- "UM notes" and "CA notes" cite the [user management notes](../../ui/designs/2026-11-16-user-management-notes.md) and the [custom attributes notes](../../ui/designs/2026-11-16-custom-attributes-notes.md). A ruling, question, or composition choice keeps its number there.
- These six files do not exist at the base. The store card `t_100ec834` commits them unchanged at `d750b59`. This design takes its section numbers from that text.
- "UM state NN" names `docs/ui/designs/2026-11-16-user-management-NN-<state>.png`. "CA state NN" names `docs/ui/designs/2026-11-16-custom-attributes-NN-<state>.png`. The workspace copies supplied the pixels.
- C1 to C5 name the changes of this design. K1 to K27 name its cards. OQ1 and OQ2 name the owner questions.

## Approval rulings

- Owner, 2026-11-01, main chat: "I want you to start the plan to add user entity managment to the app. This should have the look and feel of the device managment to keep a consistant UI/UX. One big diffrence is that users have custom schema. We will need a unique UI/UX to manage this, both in creating the schema and assigning it. Create both Technical Design Docs as Views in Figma."
- Owner, 2026-11-16, main chat, to questions U1 to U7: "All recommended". Each question takes option 1. The record section "Owner decisions" quotes each chosen option.
- Owner, 2026-11-16, main chat: "1) Approved". This approved the screens of Figma pages 11 and 12 with four named defaults (record section "Defaults"): the typed name confirms a removal, no "Last changed" column on the category list, an optional number range, and the pinned Name column. The approved screens outrank any text on composition.
- Owner, 2026-11-16, main chat: "2) Scopes Added". He reported `admin.directory.user.readonly` and `admin.directory.userschema.readonly` added to the delegation. A main-chat token check at 17:55 EST the same day still found both scopes denied. The live card starts with a fresh token check.
- Owner, 2026-11-16, main chat: "3) Yes to 0.4.0". admin-sdk-mock 0.4.0 publishes after its card passes review.
- The notes rulings bind. Two of them shape the plan:
  - The Users grid keeps the font of the built Devices grid.
  - No frame draws the number range inputs. Mark the card that builds them as gated on an owner-approved frame. It must not block the other S2 and S3 cards.
- The rest of documents A and B stays proposed. You can refine an engineering default when you cite a source. A change to an owner-settled item above becomes an owner question, not a decision.

## 1. What documents A and B decide

Documents A and B stay the design of each topic below. This addendum keeps every topic that the table marks "Kept".

| Topic                                             | Source                                     | This design                              |
| ------------------------------------------------- | ------------------------------------------ | ---------------------------------------- |
| Scope, vocabulary, and user workflows             | A §2 to §4, B §2 to §4, baseline §5 and §6 | Kept                                     |
| Code reuse map and the interface of A and B       | A §5, A §5.1, B §16                        | Kept. C1 settles the column ID.          |
| Google reads, paging, and quota                   | A §6                                       | Kept. Section 4 lists every call.        |
| User tables and cache keys                        | A §7                                       | Kept. Section 9 numbers the migrations.  |
| Users routes, query, selection, and feed          | A §8                                       | Kept                                     |
| Grid columns, attribute column hook, and details  | A §9, B §12                                | C1                                       |
| Permissions and scope kinds                       | A §10, B §11                               | Kept. Section 3 rules on the navigation. |
| Page states and failures                          | A §11, B §13                               | Kept                                     |
| Category editor rules, locks, phrases, and counts | B §5                                       | Kept. C2 adds a display name rule.       |
| Change plan, `etag`, and the effect on values     | B §6                                       | Kept. C3 refines the update body.        |
| Category and value jobs, outcomes, and cancel     | B §7                                       | Kept                                     |
| Info types, modes, payloads, and conflicts        | B §8                                       | Kept                                     |
| Schema cache and purge                            | B §9                                       | Kept. S1 builds the read (section 2).    |
| Category and value routes                         | B §10                                      | Kept                                     |
| Mock additions and live checks                    | A §13, B §14                               | C4. Sections 5 and 6 refine them.        |
| Engineering defaults                              | A §15.4, B §15 (E1 to E18)                 | Kept, except the A §9 field ID (C1)      |
| Delivery order                                    | A §16, B §16                               | C5                                       |

Changes of this design:

- C1. Every attribute column, filter, and draft key uses the ID `attr:<schemaName>.<fieldName>` (B §12, E13). This supersedes the `attribute:<schemaName>.<fieldName>` field ID of A §9. Reason: one name for one thing. Document B owns the attribute metadata (A §5.1). One builder serves S1 and S3 (K5, K8, K10, K21, K24).
- C2. A new or changed display name differs from every other display name of its category (section 3).
- C3. An update plan copies every property of each kept field from the schema cache, `numericIndexingSpec` included. Reason: `schemas.update` sends the complete schema (B §6.1). The editor draws no range input before K18, so an edit keeps a range that the Admin console set.
- C4. admin-sdk-mock 0.4.0 serves no `schemas.patch`, which B §14 lists. Reason: no card calls it, and its `fields` merge rule has no source (B §6.1, E4). The mock adds `schemaName.fieldName` queries (section 5).
- C5. The card plan of section 9 replaces the delivery steps of A §16 and B §16. Each slice starts after the rehearsal of the slice before it (U3).

## 2. Open points of A §15.3 and departures of B §15

| Item                                                            | Ruling                                                                                                                                                       | Source                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| A §15.3 point 1: S1 builds the category read                    | Accept. S1 builds `schemas.list`, the schema cache, and the read route of B §10 row 1. S2 adds the tab.                                                      | Record completion step 1 filters on an attribute. UM states 03 and 04 name attributes. |
| A §15.3 point 2: User Read at district scope                    | No change. The owner chose U6 option 1. The query takes an OrgUnit scope filter from the start.                                                              | Record, Owner decisions, U6                                                            |
| A §15.3 point 3: Sign out needs `admin.directory.user.security` | S4 contract only (section 8). The S4 addendum adds its capability.                                                                                           | A §12, `AGENTS.md:47`                                                                  |
| B §15 departure 1: a removal deletes values                     | Campus Commander sends only the category change. The drafted removal words wait for check L3 (section 6). The mock models deletion as a marked hypothesis.   | Record, Owner decisions, U7. CA notes, Approval and build rulings.                     |
| B §15 departure 2: no removal of the last attribute             | Accept as E18. Remove stays disabled on the last attribute, with the state message of B §5.                                                                  | Admin help (B §3), B §5                                                                |
| B §15 departure 3: optional number range                        | The owner settled it as record default 3. K14 accepts `numericIndexingSpec`. Only the input card K18 waits for a frame. S3 enforces an existing range (E11). | Record, Defaults and Design. UM notes ruling 5.                                        |

## 3. Notes questions 5 and 7

**CA notes question 5: unique display names inside a category.** Yes (C2).

- A new or changed display name differs from every other display name of its category. The check trims and ignores letter case, as E2 compares names.
- Reason: an attribute shows by its display name inside its category (A §9, UM notes composition 3). The Columns panel, the column header, the details card, and the Set attributes select use it (UM state 08).
- Display names that Google already holds stay valid until the person changes one of them.
- The editor shows the error under the display name field, where CA state 03 places the name error. The plan route answers 422 `display-name-in-use`, as B §13 answers `name-in-use`.
- The text "Each attribute needs a unique display name." joins the drafted strings. The owner approves each one (CA notes, Drafted strings).

**CA notes question 7: the navigation of a person with User Read only.** Each navigation item keeps its built rule.

- The Users item, the `/users` routes, and both tabs need `users:read` (A §10, U4).
- A person whose only grant is `users:read` sees Users and Your account. Your account has no condition (`frontend/src/app/shell/shell.html:70-78`).
- Jobs needs `jobs:read`, `jobs:manage`, or `devices:read` (`frontend/src/app/jobs/jobs.store.ts:29-37`). The SQL job reader accepts the same three actions (`deployment/postgres/migrations/017-jobs.sql:4728-4745`).
- Platform access and Platform invitations need `platform-users:read` at platform scope (`frontend/src/app/shell/shell.html:100-116`).
- A person with `users:schema-manage` and no `users:read` sees no Users item. The Read dependency of User Schema Manage stays open (`docs/workflows/platform-access.md:701`).
- CA state 09 draws the administrator navigation for the second person. The build follows the rules above. OQ2 asks whether `users:read` also opens Jobs.

## 4. Production Google calls and test doubles

Every production call runs through `libs/google-connection` against `admin.googleapis.com` and the Directory batch endpoint (`libs/google-connection/src/lib/devices.ts:93`). Each token carries exactly one scope (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:907`).

| Call             | Production caller                                        | Scope                                 | Transport                                                                                                                                                                                   |
| ---------------- | -------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users.list`     | Full user sync in the worker (A §6)                      | `admin.directory.user.readonly`       | Direct GET with `projection=full` and 500 users a page                                                                                                                                      |
| `users.get`      | Refresh job, edit-list read, value read-back, live check | `admin.directory.user.readonly`       | Batch part. A refresh and the live check read `projection=full` (A §6, A §13). The edit-list read and the value read-back read `projection=custom` with `customFieldMask` (B §7.2, B §8.4). |
| `schemas.list`   | Category read route of the API (B §9, B §10)             | `admin.directory.userschema.readonly` | Direct GET with a 25-second deadline (B §9)                                                                                                                                                 |
| `schemas.get`    | Category job check and read-back (B §6.2, B §7.1)        | `admin.directory.userschema.readonly` | Batch part                                                                                                                                                                                  |
| `schemas.insert` | Category job: create (B §6.1)                            | `admin.directory.userschema`          | Batch part. The batch never retries a POST, so a transient answer ends Unknown (`libs/google-connection/src/lib/batch.ts:898-901`).                                                         |
| `schemas.update` | Category job: edit (B §6.1)                              | `admin.directory.userschema`          | Batch part, PUT with `If-Match` (E7)                                                                                                                                                        |
| `schemas.delete` | Category job: delete (B §6.1)                            | `admin.directory.userschema`          | Batch part with `If-Match` (E7)                                                                                                                                                             |
| `users.patch`    | Value job: the user value write of document B (B §7.2)   | `admin.directory.user`                | Batch part on the immutable user ID, 250 parts a batch (`libs/google-connection/src/lib/batch.ts:87`)                                                                                       |

- The request allowlist (`libs/google-connection/src/lib/provider.ts:239`) and the part allowlist (`libs/google-connection/src/lib/provider.ts:278-293`) gain exactly these shapes.
- No card builds `users.update`. E16 adds it only if check L3 shows that `users.patch` cannot clear a list.
- UM notes question 7 names the 404 of `users.update`. The value job sends `users.patch` (B §7.2), and the mock answers 404 to both (section 5).
- Capabilities copy `device-changes` (`libs/application-contracts/src/lib/google-capabilities.ts:69-81`). S1 adds `user-inventory` and `user-schemas` (A §10). S2 adds `user-schema-changes` (`schemas.update`). S3 adds `user-changes` (`users.patch`).
- Each new capability keeps `qualified: false` until its live check, as `device-changes` does.

Test doubles:

1. admin-sdk-mock 0.4.0, package `@campuscommander/admin-sdk-mock`. Tests start it in process (`libs/google-connection/src/lib/capability-health-mock.test.mjs:24-27`). The review harness makes it grant exactly the capability scopes (`api-e2e/admin-sdk-mock-fixture.mjs:25-28`).
2. `libs/google-connection/src/lib/batch-fake.mjs`, the transport of the reader and writer unit tests, without network (A §6).
3. `api-e2e/google-connection-preload.cjs`, the synthetic Google answers of `api-e2e:phase3-auth-integration`. It throws on an unknown endpoint (`api-e2e/google-connection-preload.cjs:365`).

No production path imports a double. The guard fails on any production source that names the mock package (`libs/google-connection/src/lib/admin-sdk-mock-guard.test.mjs:15-41`). K2 extends the guard to `batch-fake.mjs`. Tests reach the mock through its proxy and CA, so the production readers hold no test switch (`libs/google-connection/src/lib/capability-health-mock.test.mjs:26-27`).

## 5. admin-sdk-mock 0.4.0

K1 follows the mock rules (`admin-sdk-mock:CONTRIBUTING.md:38-45`). It writes the failing test first and adds no dependency. A route table change runs `npm run docs`, and each undocumented behavior gets a calibration row.

| Route ID                   | Method and path below `/admin/directory/v1`         | Scopes                                                              |
| -------------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| `directory.schemas.list`   | GET `/customer/{customerId}/schemas`                | `admin.directory.userschema`, `admin.directory.userschema.readonly` |
| `directory.schemas.get`    | GET `/customer/{customerId}/schemas/{schemaKey}`    | `admin.directory.userschema`, `admin.directory.userschema.readonly` |
| `directory.schemas.insert` | POST `/customer/{customerId}/schemas`               | `admin.directory.userschema`                                        |
| `directory.schemas.update` | PUT `/customer/{customerId}/schemas/{schemaKey}`    | `admin.directory.userschema`                                        |
| `directory.schemas.delete` | DELETE `/customer/{customerId}/schemas/{schemaKey}` | `admin.directory.userschema`                                        |

`{schemaKey}` takes the schema ID or the schema name (B §14). Each route also runs as a batch part (`admin-sdk-mock:docs/reference/api-coverage.md:203`). Each route ID also names its faults (`admin-sdk-mock:docs/reference/api-coverage.md:12`).

| Behavior        | Rule                                                                                                                                                                                                                                   | Consumer                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Scope sets      | `SCOPES`, `READ_SCOPES`, `WRITE_SCOPES`, and `READ_WRITE_SCOPES` gain the two userschema scopes (`admin-sdk-mock:src/auth/scopes.ts:8-72`).                                                                                            | K2, through the harness grant                                                        |
| Schema resource | The mock assigns `schemaId` and `fieldId` and applies the field defaults of B §3. Each write gives the schema a new `etag`.                                                                                                            | K6, K13, K15                                                                         |
| Schema rules    | A reused name answers 409. Each customer holds at most 100 schemas and 100 fields. A bad name, a missing required key, or a broken lock answers 400 (B §14).                                                                           | K13, K15                                                                             |
| `If-Match`      | A stale `etag` on an update or a delete answers 412. A write without the header skips the check. Marked hypothesis until L2 (B §6.2).                                                                                                  | K13, K15                                                                             |
| Removal         | An update without a field, or a delete, removes those values from every user. Marked hypothesis until L3 (B §6.3).                                                                                                                     | K15, K19                                                                             |
| Values          | Each `customSchemas` value follows its field type, the multi-value entry form, and the 500-character string limit. An unknown name answers 400 (B §14).                                                                                | K20, K22                                                                             |
| Projections     | `basic` omits `customSchemas`. `full` returns every schema. `custom` returns the schemas that `customFieldMask` names (A §13). Today the mock ignores `projection` (`admin-sdk-mock:src/directory/users.ts:178`).                      | K6, K7, K20                                                                          |
| Value writes    | `users.patch` and `users.update` merge `customSchemas` by schema and field. `null` deletes, and an absent field stays (baseline §3). Today `updateUser` ignores the key (`admin-sdk-mock:src/directory/user-writes.ts:218-252`).       | K20, K22                                                                             |
| Missing user    | A value write to an unknown or hidden user answers 404 `notFound`, also as one batch part. `visibleUser` already throws it (`admin-sdk-mock:src/directory/users.ts:267-275`). K1 adds failing-first tests with a `customSchemas` body. | K20, K22                                                                             |
| Custom queries  | `users.list` accepts `schemaName.fieldName` terms on searchable fields (baseline §3). Today `query` takes built-in fields only (`admin-sdk-mock:docs/reference/api-coverage.md:153`).                                                  | Mock tests. No S1 to S3 card searches Google, because filters read the cache (A §2). |
| Seed            | An opt-in seed field adds the scenario of baseline default 13, plus `archived`, `isEnrolledIn2Sv`, and organizations (A §13). Without it, every seeded value stays as in 0.3.0 (`admin-sdk-mock:CHANGELOG.md:27-32`).                  | K2, K12, K19, K26                                                                    |

- The fields mask of A §6 already passes, because the mock knows `customSchemas` (`admin-sdk-mock:src/store/schema-names.ts:184`).
- Contract tests check each answer against `Schema` and `SchemaFieldSpec` (`admin-sdk-mock:test/contract/discovery/directory_v1.json:2265`, `admin-sdk-mock:test/contract/discovery/directory_v1.json:2562`).
- Release: version 0.4.0, a `## [0.4.0]` changelog section, and the tag `v0.4.0`, which only the owner pushes (`admin-sdk-mock:CONTRIBUTING.md:64-66`). His answer "3) Yes to 0.4.0" covers it.

## 6. Live checks

**K27, the live read-only check.** It runs after the S3 rehearsal under the standing authorization (`AGENTS.md:38-48`).

1. A fresh token check requests one token for each read scope with the fixture of `AGENTS.md:40-41`.
2. On `unauthorized_client`, K27 stops and blocks with `needs_input`. The owner then checks that the client ID entry lists both full scope URLs.
3. The script calls the production readers, as `deployment/google-proof/device-live.mjs:1-25` does. It runs `users.list`, one `users.get` part, `schemas.list`, and one `schemas.get` part when a category exists (A §13, B §14 L1).
4. Sanitized evidence records methods, scopes, HTTP status, counts, and the JSON type of each info type. It holds no user value (A §13).
5. Empty collections are valid observations (`AGENTS.md:45-46`). The credential contents stay outside Git, reports, and messages (`AGENTS.md:44`).

**K3 and K4, checks L2 and L3.** Both write data, and the standing authorization permits no Google data mutation (`AGENTS.md:48`).

- Each check is a separate card. It starts only after its own yes from the owner (record, Preconditions and live checks).
- L2 needs `admin.directory.userschema` in the delegation. L3 also needs `admin.directory.user` and one test user that the owner names (B §14).
- Neither check needs a Campus Commander build card, so each runs as soon as the owner answers. OQ1 covers the timing of U7.
- A result that contradicts a marked hypothesis of section 5 opens a follow-up card for the mock and the app. The owner approves any changed text (CA notes, Approval and build rulings).

## 7. Tests

Every test follows the failing-first rule (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:1402`). Every mock test runs on 0.4.0 after K2.

| Decision                        | Target                                                      | Proof                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 column ID                    | `application-contracts:test`, `frontend:test`               | One builder gives the column, filter, and draft key. The S1 grid and the S3 editors import it.                                                     |
| C2 display names                | `application-contracts:test`, `api:test`                    | A repeat after trimming and case folding fails. The plan route answers 422 `display-name-in-use`.                                                  |
| C3 update body                  | `api:test`                                                  | An edit of a field with a range keeps its `numericIndexingSpec` in the plan.                                                                       |
| Category read in S1 (section 2) | `api:test`, `api-e2e:admin-sdk-mock-integration`            | The route reads `schemas.list` once in 24 hours. Refresh reads it at once.                                                                         |
| Navigation (section 3)          | `frontend:test`                                             | A session with only `users:read` shows Users and Your account.                                                                                     |
| Calls and scopes (section 4)    | `google-connection:test`                                    | Each call carries its single scope. The mock answers 403 to any other scope.                                                                       |
| Doubles (section 4)             | `google-connection:test`                                    | The guard finds no production import of the mock or of `batch-fake.mjs`.                                                                           |
| Capabilities                    | `google-connection:test`, `api-e2e:phase3-auth-integration` | The health check passes each new capability on the mock and on the preload.                                                                        |
| `etag` and `If-Match`           | `worker:test`                                               | A fresh `etag` that differs fails `category-changed` and sends nothing. A stale header answers 412.                                                |
| Unknown insert                  | `worker:test`                                               | A `status` fault before the handler and a `hang` past the client timeout both settle by read-back (`admin-sdk-mock:src/faults/faults.ts:231-233`). |
| Missing user                    | `worker:test`                                               | A 404 part settles Failed `not-found`, and the user leaves the cache. The other parts succeed.                                                     |
| Purge                           | `worker:test`                                               | A removal and a delete remove the key from every cached user (B §9).                                                                               |
| End to end                      | `api-e2e:admin-sdk-mock-integration`                        | Full sync, refresh, one category lifecycle, and one value change from each entry point (B §14).                                                    |
| Screens                         | `frontend-e2e:e2e`                                          | Browser checks reproduce the states that each frontend card lists.                                                                                 |

The targets sit at `libs/application-contracts/project.json:9`, `libs/google-connection/project.json:9`, `worker/project.json:36`, `frontend/project.json:87`, and `api/project.json:74-78`.
The end-to-end targets sit at `api-e2e/project.json:22-60` and `api-e2e/project.json:141`. The Playwright plugin names `frontend-e2e:e2e` (`nx.json:40-44`).
`api:test` lists its folders, so K8 adds `api/src/app/users/*.test.mjs` to the command (`api/project.json:78`).

## 8. Contracts of S4 and S5

S4 and S5 get no cards. Each gets its own design addendum and screens (record, Exclusions and later slices). These contracts fix their interface with S1 to S3.

**S4 account actions** (A §12):

- Suspend, Reactivate, Move to OU, and Require password change call `users.patch` through the `user-changes` capability of S3.
- Sign out calls `users.signOut` with `admin.directory.user.security` through a new capability (A §15.3 point 3).
- Each action runs selection, preview, confirm, job, and audited result (`docs/portfolio/02-domain-model.md:162`).
- S4 reuses the users selection key (A §8) and the read-back upsert (A §5.1). It adds its actions to the Bulk Actions menu of K25 (UM notes ruling 9).
- A move needs User Write in both OrgUnits (`docs/workflows/platform-access.md:759-761`). The S4 addendum names the job kind, the prefix, and the observed-at stamps (A §7, A §12).
- Each live S4 write needs the owner's yes and its scope in the delegation (`AGENTS.md:47-48`).

**S5 export and import** (A §12):

- S5 reuses the `EXP` and `IMP` jobs of the device flow (`docs/superpowers/specs/2026-10-28-device-export-import-design.md:33`).
- Each attribute column carries the C1 column ID. Each cell carries the canonical form of B §8.1.
- Execution creates value jobs through the edit-list preview of B §10, and S4 jobs for the account fields (A §12).
- A §12 and B §2 each leave the multi-value cell form to the other document. The S5 addendum defines it.

## 9. Card plan

- K1 comes first. Each card that tests against mock 0.4.0 depends on K1 through K2.
- Each slice starts after the rehearsal of the slice before it (U3). Each frontend card waits for its API cards.
- Each backend card owns one surface. Each card that widens an enum fixes every exhaustive switch over it (`tsconfig.base.json:14`).
- Migrations take the next free numbers after `deployment/postgres/migrations/018-device-write-access.sql:1`: 019 (K5), 020 (K14), and 021 (K21).
- Capability IDs change in place in migrations 010 and 011, as commit `0f976ca` did for `drive-files`.

**Mock and live write checks**

- **K1. admin-sdk-mock 0.4.0: user schemas and custom values** · `backend` · repository `CampusCommander/admin-sdk-mock` · after: none
  - Scope: the routes and behaviors of section 5.
  - Acceptance: `npm test`, `npm run lint`, `npm run typecheck`, `npm run format:check`, and `npm run test:contract` pass. `admin-sdk-mock:docs/reference/api-coverage.md` lists the five schema routes. `admin-sdk-mock:docs/calibration.md` holds an unverified row for each marked hypothesis. A domain without the seed field hashes as in 0.3.0. `admin-sdk-mock:CHANGELOG.md` holds `## [0.4.0]`.
  - Collides: no Campus Commander file. After review, the owner pushes the tag `v0.4.0` (`admin-sdk-mock:CONTRIBUTING.md:65`).
- **K2. Pin admin-sdk-mock 0.4.0** · `platform` · after: K1 and the `v0.4.0` release
  - Scope: the pin of `package.json:12` and its lock entry, and the pin lines of `docs/testing/client-review.md:29`, `docs/testing/client-review.md:51`, and `docs/testing/admin-sdk-mock.md:16`. The harness turns on the seed field. The guard also names `batch-fake.mjs`.
  - Acceptance: `npm ci` installs 0.4.0. `google-connection:test`, `api-e2e:admin-sdk-mock-integration`, and `api-e2e:client-review-mock` pass. The harness domain answers `schemas.list` with 3 categories.
  - Collides: `package.json`, `package-lock.json`, `api-e2e/admin-sdk-mock-fixture.mjs`, `libs/google-connection/src/lib/admin-sdk-mock-guard.test.mjs`.
- **K3. Live check L2** · `qa` · GATED on the owner's yes · after: none
  - Scope: B §14 L2 on the category `CcLiveCheck`, through a script beside `deployment/google-proof/device-live.mjs:1-25`. Precondition: `admin.directory.userschema` in the delegation.
  - Acceptance: sanitized evidence records the answers to the reused name, the stale `If-Match`, the 200-character name, and the name reuse. The domain holds no `CcLiveCheck` at the end.
  - Collides: none.
- **K4. Live check L3** · `qa` · GATED on the owner's yes · after: K3
  - Scope: B §14 L3 on one test user that the owner names. Precondition: `admin.directory.user` and `admin.directory.userschema` in the delegation.
  - Acceptance: the evidence records each unverified row of B §6.3. It also records the `null` answer on a list, the PATCH answer, and the phone format. Each contradicted hypothesis of section 5 gets a follow-up card.
  - Collides: the K3 script.

**S1 Browse users**

- **K5. Users inventory schema and contracts** · `backend` · after: none
  - Scope: `deployment/postgres/migrations/019-user-inventory.sql` holds the tables and indexes of A §7 and the schema cache of B §9. The `entity_type` check gains `user` (`deployment/postgres/migrations/016-device-inventory.sql:107`). Each SQL gate of the refresh path accepts `users:read` for that type (A §8).
  - Scope: the `users:read` row lands with the enum entry (`deployment/postgres/migrations/016-device-inventory.sql:4`, `libs/application-contracts/src/lib/authorization.ts:3-61`). `entityTypeSchema` and the freshness map gain `user` (`libs/application-contracts/src/lib/entity-cache.ts:13-19`). A new `libs/application-contracts/src/lib/users.ts` holds the schemas of A §8 and B §10 row 1, and the C1 builder.
  - Acceptance: a fresh database runs every migration through 019. `application-contracts:test` covers each schema and the C1 builder. A platform administrator session holds `users:read` (`libs/application-contracts/src/lib/authorization.ts:116`). A principal with only `devices:read` lists no user refresh job (A §10).
  - Collides: `libs/application-contracts/src/lib/authorization.ts` and `libs/application-contracts/src/index.ts` (K14, K21).
- **K6. Google user and category readers, read capabilities** · `backend` · after: K2, K5
  - Scope: the user reader and the schema reader of A §6, with their allowlist entries (section 4). `user-inventory` and `user-schemas` join `GOOGLE_CAPABILITIES`, the setup list (`libs/application-contracts/src/lib/google-capabilities.ts:98-106`), and the preload. They also join every SQL list (`deployment/postgres/migrations/010-google-capability-health.sql:10`, `deployment/postgres/migrations/010-google-capability-health.sql:34`, `deployment/postgres/migrations/010-google-capability-health.sql:57`, `deployment/postgres/migrations/011-google-credential-lifecycle.sql:308`). The health finish check counts one more result for each capability, as commit `3efd855` shows.
  - Acceptance: `google-connection:test` passes the readers on `batch-fake.mjs` and on the in-process mock. The capability health test passes both capabilities on 0.4.0. `api-e2e:phase3-auth-integration` passes. A call outside the allowlists fails before it leaves the process.
  - Collides: `libs/google-connection/src/lib/provider.ts`, `libs/application-contracts/src/lib/google-capabilities.ts`, migrations 010 and 011, and `api-e2e/google-connection-preload.cjs` (K13, K20).
- **K7. Worker user sync and refresh jobs** · `backend` · after: K6
  - Scope: the full user sync, the refresh job, and the 404 removal of A §3 and A §6. `worker/src/dispatch.ts` and `worker/src/entity-sync.ts` dispatch the type `user`. A user sync flow joins `deployment/kestra/`, and the refresh flow stays shared (A §5).
  - Acceptance: `worker:test` syncs the mock scenario into `cc.users`, and each raw `customSchemas` equals the mock answer. A refresh of a deleted user marks it removed. A quota fault retries only its part (A §6).
  - Collides: `worker/src/dispatch.ts` (K15, K22) and `worker/src/entity-sync.ts`.
- **K8. Users API and the category read** · `backend` · after: K7
  - Scope: the routes of A §8 in a new `api/src/app/users/` module. The category read of B §10 row 1 follows the cache rules of B §9. Attribute predicates use C1 IDs and the operators of baseline default 4.
  - Acceptance: `api:test` runs the new folder. It covers 403 without `users:read`, 409 `connection-required`, paging, selection expiry, and each predicate. `api-e2e:admin-sdk-mock-integration` syncs, filters on Grade level, refreshes selected users, and reads one user.
  - Collides: `api/src/app/app.module.ts` and `api/project.json`.
- **K9. Users feed** · `backend` · after: K7
  - Scope: the users feed of A §8 on `GET /api/events`, by the rule of the device feed (`api/src/app/events/events.controller.ts:143-164`). Every event names its entity type.
  - Acceptance: `api:test` shows that a session without `users:read` receives no user event. A ping closes the users feed after a revoke (A §8). The device feed tests pass unchanged.
  - Collides: `api/src/app/events/events.controller.ts` and `api/src/app/events/events-stream.ts`.
- **K10. Users grid page** · `frontend` · after: K8, K9
  - Scope: the Users item below Devices (baseline default 1) and the `users` route behind `users:read` (`frontend/src/app/app.routes.ts:64-74`). It builds the store on `LiveFeeds`, the static fields, and the attribute column hook with C1 IDs. `docs/ui/entity-grid-fields.json` gains `userColumns` (A §9).
  - Scope: it builds the Columns panel groups, typed filters, and the pinned Name column (record default 4). It also builds selection, paging, Refresh, and the states of A §11. The tab bar holds the Users tab, and K16 adds Custom attributes (U2, U3).
  - Acceptance: `frontend:test` passes. `frontend-e2e:e2e` reproduces UM states 01, 02, 03, and 13. The grid cells compute the font family of the Devices grid (UM notes ruling 3). A session with only `users:read` shows Users and Your account.
  - Collides: `frontend/src/app/shell/shell.html`, `frontend/src/app/app.routes.ts` (K11), `frontend/src/app/jobs/live-feeds.ts`, and `docs/ui/entity-grid-fields.json`.
- **K11. User details page** · `frontend` · after: K8, K10
  - Scope: the `users/:userId` route and the details of A §9: Account, Organization, and a read-only Custom attributes card. Its sections show "Not set", chips, and "No values set" (UM notes composition 2). Next user and Back to users follow A §4.
  - Acceptance: `frontend-e2e:e2e` reproduces UM state 04. A removed user shows its removal time (A §11).
  - Collides: `frontend/src/app/app.routes.ts` and the users store (K10, K23).
- **K12. Rehearsal S1** · `qa` · after: K5 to K11
  - Scope: record completion step 1 on `api-e2e:client-review-mock` with admin-sdk-mock 0.4.0.
  - Acceptance: the run browses users, filters on an attribute, selects users, refreshes, and opens one user. Screenshots stand beside UM states 01 to 04 and 13. Each difference becomes a finding.
  - Collides: none.

**S2 Manage categories**

- **K13. Google category writer and `user-schema-changes`** · `backend` · after: K12
  - Scope: batch parts for `schemas.get`, `schemas.insert`, `schemas.update`, and `schemas.delete` (section 4), with `If-Match` on an update and a delete (E7). The capability `user-schema-changes` joins the lists of K6.
  - Acceptance: `google-connection:test` sends each call to the mock as a part with one scope. A stale `If-Match` answers 412. A transient insert answer ends Unknown without a retry. The capability health test passes on 0.4.0.
  - Collides: the files of K6.
- **K14. Category plans and the category job contract** · `backend` · after: K13
  - Scope: `deployment/postgres/migrations/020-user-attribute-categories.sql` holds the plans, the `user-schema-change` kind, and the `users:schema-manage` row. The action joins `actionSchema` in this card. `CAT` joins the display and operation ID rules (`libs/application-contracts/src/lib/jobs.ts:24-37`).
  - Scope: the plan routes of B §10 apply B §5, C2, and C3. They accept `numericIndexingSpec` for K18.
  - Acceptance: `api:test` covers each plan rule and 422 code, the typed name, 412 `category-changed`, expiry, and a repeated confirm. A fresh database runs through 020. An edit of a field with a range keeps its `numericIndexingSpec`.
  - Collides: `libs/application-contracts/src/lib/authorization.ts`, `libs/application-contracts/src/lib/jobs.ts`, and `api/src/app/users/` (K21).
- **K15. Category job worker** · `backend` · after: K14
  - Scope: the order of B §6.2 and the outcomes of B §7.3. It adds the cache write and purge of B §9, and cancel (B §7.4). The job shares the device write slot (E8, `docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:279`).
  - Acceptance: on the mock, `worker:test` fails a changed `etag` with `category-changed` before any write. A delete purges the key from every cached user. Both fault cases of section 7 settle by read-back. `api-e2e:admin-sdk-mock-integration` runs one create, one edit, and one delete.
  - Collides: `worker/src/dispatch.ts` (K7, K22).
- **K16. Custom attributes tab and read-only views** · `frontend` · after: K14
  - Scope: the Custom attributes tab (U2) and a category list without the Last changed column (record default 2). It adds the limit counts, the empty state, Refresh, and the read-only category dialog (U4).
  - Acceptance: `frontend-e2e:e2e` reproduces CA states 01, 09, and 11 without the Last changed column. A session without `users:schema-manage` shows no Create category (CA notes composition 12).
  - Collides: the Users page and its tab bar (K10).
- **K17. Category editor dialog** · `frontend` · after: K15, K16
  - Scope: the dialog of CA states 02 to 08, 10, and 12. It holds the editor, errors with C2, locks, and the removal mark. It also holds review with the typed name, saving, the result, the delete question, the limit, and the visibility note. It draws no range input.
  - Acceptance: `frontend-e2e:e2e` reproduces each listed state on the mock. A repeated display name shows the C2 error. Each flow ends in its dialog without the job page (baseline §2).
  - Collides: the category dialog files (K18).
- **K18. Number range inputs** · `frontend` · GATED on a frame that the owner approves · after: K17
  - Scope: minimum and maximum inputs for Whole number and Decimal number attributes (record default 3). K14 already accepts the range.
  - Gate: no frame draws the inputs (record, Design). K18 starts after the owner approves such a frame. No card depends on K18.
  - Acceptance: `frontend-e2e:e2e` reproduces that frame. A saved range reaches the plan body.
  - Collides: the category dialog files (K17).
- **K19. Rehearsal S2** · `qa` · after: K13 to K17
  - Scope: record completion step 2 on admin-sdk-mock 0.4.0.
  - Acceptance: the run creates, edits, and deletes a category and shows each result in the dialog. Screenshots stand beside CA states 01 to 12. The removal words stay marked as drafted until K4 reports (CA notes, Approval and build rulings).
  - Collides: none.

**S3 Set attribute values**

- **K20. Google value writer, custom read, and `user-changes`** · `backend` · after: K19
  - Scope: `users.patch` parts with the bodies of B §8.3, and `users.get` with `projection=custom` and `customFieldMask` (B §7.2, B §8.4). The capability `user-changes` joins the lists of K6.
  - Acceptance: `google-connection:test` writes each mode on the mock and reads it back. A missing user fails only its part (`docs/superpowers/specs/2026-10-07-google-batch-service-decisions.md:91-93`). The capability health test passes on 0.4.0.
  - Collides: the files of K6.
- **K21. Value previews and the value job contract** · `backend` · after: K20
  - Scope: `deployment/postgres/migrations/021-user-attribute-values.sql` holds previews, targets, the `user-attribute-update` kind, and the `users:write` and `users:bulk-actions` rows. Both actions join `actionSchema` here, and `UAT` joins the ID rules.
  - Scope: the preview routes of B §10 apply B §8, E11, and C1 keys.
  - Acceptance: `api:test` covers each mode, Unchanged and Conflict rows, value refusals, 409 `category-changed`, expiry, and both permission paths. A fresh database runs through 021.
  - Collides: the files of K14.
- **K22. Value job worker** · `backend` · after: K21
  - Scope: claims, batches of 250 parts, and the outcomes of B §7.3. It adds read-back, the user row write, and the users feed event (B §9). A 404 settles Failed `not-found` and removes the user from the cache (B §13).
  - Acceptance: `worker:test` covers every row of B §7.3 on the mock. `api-e2e:admin-sdk-mock-integration` sets one value from each entry point. The 404 row reads "Google could not find this user." (UM notes question 7).
  - Collides: `worker/src/dispatch.ts` (K7, K15).
- **K23. Details card editor** · `frontend` · after: K22
  - Scope: the card form behind Edit and the saved line (UM notes compositions 4 and 13). The form edits the whole Custom attributes card. One change saves at once, and more changes go to review (B §4.2).
  - Acceptance: `frontend-e2e:e2e` reproduces UM states 05 and 12. A text over 500 characters shows the count message of in-grid editing (UM notes ruling 4).
  - Collides: the details page (K11).
- **K24. Attribute in-grid editors** · `frontend` · after: K22
  - Scope: the in-grid editor of each info type (B §12), with the C1 ID in each draft key. It adds the pending changes bar and conflict cells (B §8.4).
  - Acceptance: `frontend-e2e:e2e` reproduces UM state 06. A conflict cell blocks Save changes. A No value never reads as empty (B §12).
  - Collides: the field registry and the users store (K10, K25).
- **K25. Bulk Actions and Set attributes** · `frontend` · after: K22
  - Scope: the Bulk Actions menu with Set attributes only (UM notes ruling 9). It builds the dialog of UM states 07 to 11 with the six modes (baseline default 11). Every attribute stays selectable (U5).
  - Acceptance: `frontend-e2e:e2e` reproduces UM states 07 to 11. A session without `users:bulk-actions` gets no Set attributes action (B §11).
  - Collides: the Users page toolbar (K10, K24).
- **K26. Rehearsal S3** · `qa` · after: K20 to K25
  - Scope: record completion step 3 on admin-sdk-mock 0.4.0.
  - Acceptance: the run sets values on one user, in the grid, and through Set attributes, and shows each outcome. Screenshots stand beside UM states 05 to 12.
  - Collides: none.

**Live read-only check**

- **K27. Live read-only check** · `qa` · after: K26
  - Scope: section 6 and record completion step 4.
  - Acceptance: the evidence holds the token check of both read scopes. It holds the answers of `users.list`, `users.get`, `schemas.list`, and `schemas.get` when a category exists. It holds no user value. A denied scope blocks the card with `needs_input`.
  - Collides: none.

## Owner questions

- OQ1. U7 states that check L3 proves the Google value behavior before the build. L2 and L3 write data, so each needs your yes (`AGENTS.md:48`). Recommendation: answer yes now, add `admin.directory.userschema` and `admin.directory.user`, and name one test user. K3 and K4 then run before S2 starts. If the yes comes later, S2 builds on the marked mock hypotheses, and your S2 sign-off waits for K4.
- OQ2. Should User Read also open Jobs, as Device Read does (`frontend/src/app/jobs/jobs.store.ts:29-37`)? Recommendation: yes, in the platform-access build (gap G03). That change touches the SQL job reader (`deployment/postgres/migrations/017-jobs.sql:4728-4745`) and the client gate together. Today only the platform administrator holds grants (A §14), so S1 to S3 need no change.
