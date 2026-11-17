# Google users and custom attributes: design addendum

Status: proposed, 2026-11-16. This addendum decides the build of slices S1 to S3 and plans their cards. Section 6 records the answers of checks L2 and L3, and C6 to C12 apply them.
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
- C1 to C12 name the changes of this design. K1 to K30 name its cards. OQ1 to OQ4 name the owner questions.

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
| Scope, vocabulary, and user workflows             | A §2 to §4, B §2 to §4, baseline §5 and §6 | Kept. C6 corrects the B §3 name reuse.   |
| Code reuse map and the interface of A and B       | A §5, A §5.1, B §16                        | Kept. C1 settles the column ID.          |
| Google reads, paging, and quota                   | A §6                                       | Kept. Section 4 lists every call.        |
| User tables and cache keys                        | A §7                                       | Kept. Section 9 numbers the migrations.  |
| Users routes, query, selection, and feed          | A §8                                       | Kept                                     |
| Grid columns, attribute column hook, and details  | A §9, B §12                                | C1                                       |
| Permissions and scope kinds                       | A §10, B §11                               | Kept. Section 3 rules on the navigation. |
| Page states and failures                          | A §11, B §13                               | Kept. C6 and C7 map Google answers.      |
| Category editor rules, locks, phrases, and counts | B §5                                       | Kept. C2 adds a display name rule.       |
| Change plan, `etag`, and the effect on values     | B §6                                       | Kept. C3, C7, C8, and C12 refine it.     |
| Category and value jobs, outcomes, and cancel     | B §7                                       | Kept. C10 and C11 refine the read-back.  |
| Info types, modes, payloads, and conflicts        | B §8                                       | Kept. C9 applies E16 to each clear.      |
| Schema cache and purge                            | B §9                                       | Kept. S1 builds the read (section 2).    |
| Category and value routes                         | B §10                                      | Kept                                     |
| Mock additions and live checks                    | A §13, B §14                               | C4. Sections 5 and 6 refine them.        |
| Engineering defaults                              | A §15.4, B §15 (E1 to E18)                 | Kept, except the A §9 field ID (C1)      |
| Delivery order                                    | A §16, B §16                               | C5                                       |

Changes of this design:

- C1. Every attribute column, filter, and draft key uses the ID `attr:<schemaName>.<fieldName>` (B §12, E13). This supersedes the `attribute:<schemaName>.<fieldName>` field ID of A §9. Reason: one name for one thing. Document B owns the attribute metadata (A §5.1). One builder serves S1 and S3 (K5, K8, K10, K22, K23, K26).
- C2. A new or changed display name differs from every other display name of its category (section 3).
- C3. An update plan copies every property of each kept field from the schema cache, `numericIndexingSpec` included. Reason: `schemas.update` sends the complete schema (B §6.1). The editor draws no range input before K19, so an edit keeps a range that the Admin console set.
- C4. admin-sdk-mock 0.4.0 serves no `schemas.patch`, which B §14 lists. Reason: no card calls it, and its `fields` merge rule has no source (B §6.1, E4). The mock adds `schemaName.fieldName` queries (section 5).
- C5. The card plan of section 9 replaces the delivery steps of A §16 and B §16. Each slice starts after the rehearsal of the slice before it (U3). S2 also starts after check L3, because U7 requires L3 before the build. B §16 runs L3 in its last step.
- C6. A reused category name answers 412 `conditionNotMet` (check L2, section 6). This supersedes the `409: Entity already exists` of B §3. The category job settles an insert answer of 409 or 412 as Failed `name-in-use`, and the rest of the B §13 row applies. Reason: an insert carries no `If-Match`, and L2 observed this 412 for a reused name.
- C7. Google applied a `schemas.update` with a stale `If-Match` and answered 200 (check L2). The header does not stop a concurrent overwrite. The fresh `etag` compare of B §6.2 step 3 stays, and it is the only guard. A change that reaches Google between that read and the write is lost, because the last write wins. Updates and deletes still send `If-Match` (E7). The reason: L2 sent no batch part, no call by `schemaId`, and no delete with the header. A 412 answer to an update or a delete settles Failed `category-changed`. This supersedes the update half of the `If-Match` hypothesis in B §6.2 and B §14.
- C8. A `schemaId` is an opaque string. Google issued 24-character IDs that fail `[A-Za-z0-9_-]` (check L2). The evidence holds no ID character, so it proves no URI delimiter. Each call that names a category by `schemaId` (E5) percent-encodes it as one path segment. The part allowlist admits that segment through `partSegment` (`libs/google-connection/src/lib/provider.ts:269`). No contract, reader, or allowlist checks an ID against a character class. The pattern of the L2 script is not the Google ID rule. A read-only check on 2026-11-16 found `=` padding on a live ID. `schemas.get` answered 200 by the raw ID, the percent-encoded ID, and the name. That check stored no evidence file.
- C9. A `users.patch` with `null` kept a single value and a list for 8 seconds of reads (check L3, section 6). E16 applies. The value job sends each body that holds a `null` as a `users.update` part. That part carries the same body on the immutable user ID. Every other body stays a `users.patch` part. Clear value, Clear values, and a Remove values that empties the list send a `null` (B §8.3). No live check has cleared a value, because L3 sent no `users.update`. The clear stays open until check L4 (K30). L4 needs the owner's yes before K21 starts (OQ4).
- C10. A `users.get` with `projection=custom` answered 400 `invalid` when its `customFieldMask` named a category that Google did not hold (check L3). Such an answer shows no value. The reader returns it as a failure, never as an empty value set. The edit-list read then answers 503 `user-read-failed` (B §13). A value read-back with this answer leaves the operation Unknown with `verification-failed` (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:1046-1048`).
- C11. The read right after a `users.patch` answer of 200 showed none of the written values (check L3, step 3). The read 1 second later showed all of them. A value read-back starts no earlier than 30 seconds after its write answered. The device rule waits the same 30 seconds after an open request (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:1041`). A 2xx answer still settles Succeeded when its `customSchemas` hold the requested values (B §7.2). L3 found `customSchemas` in that answer, and it recorded no value of the answer.
- C12. In check L3, step 5, an edit turned an attribute to multiple values. The next read returned its single value as a list of one entry. After such an edit succeeds, the category job rewrites each cached value of the attribute as a one-entry list. The rewrite runs in the transaction of the schema cache write (B §6.2 step 5, B §9).

## 2. Open points of A §15.3 and departures of B §15

| Item                                                            | Ruling                                                                                                                                                              | Source                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A §15.3 point 1: S1 builds the category read                    | Accept. S1 builds `schemas.list`, the schema cache, and the read route of B §10 row 1. S2 adds the tab.                                                             | Record completion step 1 filters on an attribute. UM states 03 and 04 name attributes. |
| A §15.3 point 2: User Read at district scope                    | No change. The owner chose U6 option 1. The query takes an OrgUnit scope filter from the start.                                                                     | Record, Owner decisions, U6                                                            |
| A §15.3 point 3: Sign out needs `admin.directory.user.security` | S4 contract only (section 8). The S4 addendum adds its capability.                                                                                                  | A §12, `AGENTS.md:47`                                                                  |
| B §15 departure 1: a removal deletes values                     | Campus Commander sends only the category change. Check L3 read no value of a removed attribute (section 6). The removal words stay. The delete words wait for OQ3.  | Record, Owner decisions, U7. CA notes, Approval and build rulings.                     |
| B §15 departure 2: no removal of the last attribute             | Accept as E18. Remove stays disabled on the last attribute, with the state message of B §5.                                                                         | Admin help (B §3), B §5                                                                |
| B §15 departure 3: optional number range                        | The owner settled it as record default 3. K14 and K15 accept `numericIndexingSpec`. Only the input card K19 waits for a frame. S3 enforces an existing range (E11). | Record, Defaults and Design. UM notes ruling 5.                                        |

## 3. Notes questions 5 and 7

**CA notes question 5: unique display names inside a category.** Yes (C2).

- A new or changed display name differs from every other display name of its category. The check trims and ignores letter case, as E2 compares names.
- Reason: an attribute shows by its display name inside its category (A §9, UM notes composition 3). The Columns panel, the column header, the details card, and the Set attributes select use it (UM state 08).
- Display names that Google already holds stay valid until the person changes one of them.
- The editor shows the new error under the Display name field. It reuses the field error pattern that CA state 03 draws under Attribute name (CA notes composition 7). No frame draws a Display name error.
- The plan route answers 422 `display-name-in-use`, as B §13 answers `name-in-use`.
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

| Call             | Production caller                                        | Scope                                 | Transport                                                                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users.list`     | Full user sync in the worker (A §6)                      | `admin.directory.user.readonly`       | Direct GET with `projection=full` and 500 users a page                                                                                                                                                                               |
| `users.get`      | Refresh job, edit-list read, value read-back, live check | `admin.directory.user.readonly`       | Batch part. A refresh and the live check read `projection=full` (A §6, A §13). The edit-list read and the value read-back read `projection=custom` with `customFieldMask` (B §7.2, B §8.4).                                          |
| `schemas.list`   | Category read route of the API (B §9, B §10)             | `admin.directory.userschema.readonly` | Direct GET with a 25-second deadline (B §9)                                                                                                                                                                                          |
| `schemas.get`    | Category job check and read-back (B §6.2, B §7.1)        | `admin.directory.userschema.readonly` | Batch part. The `schemaKey` segment is percent-encoded (C8).                                                                                                                                                                         |
| `schemas.insert` | Category job: create (B §6.1)                            | `admin.directory.userschema`          | Batch part. A transient answer to a POST gets no retry (`libs/google-connection/src/lib/batch.ts:898-903`), so the insert ends Unknown (B §7.3). A quota answer keeps its 25 retries (`libs/google-connection/src/lib/batch.ts:93`). |
| `schemas.update` | Category job: edit (B §6.1)                              | `admin.directory.userschema`          | Batch part, PUT with `If-Match` (E7). Google applies an update with a stale `If-Match` (C7). The `schemaKey` segment is percent-encoded (C8).                                                                                        |
| `schemas.delete` | Category job: delete (B §6.1)                            | `admin.directory.userschema`          | Batch part with `If-Match` (E7). Google answers 204. L2 did not test `If-Match` on a delete (C7). The `schemaKey` segment is percent-encoded (C8).                                                                                   |
| `users.patch`    | Value job: each body without a `null` (B §7.2, C9)       | `admin.directory.user`                | Batch part on the immutable user ID, 250 parts a batch (`libs/google-connection/src/lib/batch.ts:87`)                                                                                                                                |
| `users.update`   | Value job: each body that holds a `null` (C9, E16)       | `admin.directory.user`                | Batch part, PUT on the immutable user ID, 250 parts a batch. Check L3 sent no `users.update` (K30).                                                                                                                                  |

- The request allowlist (`libs/google-connection/src/lib/provider.ts:239`) and the part allowlist (`libs/google-connection/src/lib/provider.ts:278-293`) gain exactly these shapes. Each `schemaKey` shape admits a percent-encoded opaque ID (C8).
- Check L3 showed that a `users.patch` with `null` kept a single value and a list for 8 seconds (section 6). E16 applies, so K21 builds `users.update` for each body that holds a `null` (C9).
- A `users.get` whose `customFieldMask` names a category that Google does not hold answers 400 `invalid` (C10).
- UM notes question 7 names the 404 of `users.update`. The value job sends `users.patch`, or `users.update` for a body with a `null` (C9). The mock answers 404 to both (section 5).
- Capabilities copy `device-changes` (`libs/application-contracts/src/lib/google-capabilities.ts:69-81`). S1 adds `user-inventory` and `user-schemas` (A §10). S2 adds `user-schema-changes` (`schemas.update`). S3 adds `user-changes` (`users.patch` and `users.update`).
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

| Behavior        | Rule                                                                                                                                                                                                                                                                                                                                                                                                                              | Consumer                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Scope sets      | `SCOPES`, `READ_SCOPES`, `WRITE_SCOPES`, and `READ_WRITE_SCOPES` gain the two userschema scopes (`admin-sdk-mock:src/auth/scopes.ts:8-72`).                                                                                                                                                                                                                                                                                       | K2, through the harness grant                                                        |
| Schema resource | The mock assigns `schemaId` and `fieldId` and applies the field defaults of B §3. Each write gives the schema a new `etag`.                                                                                                                                                                                                                                                                                                       | K6, K13, K16                                                                         |
| Schema rules    | A reused name answers 412 `conditionNotMet` (C6). Each customer holds at most 100 schemas and 100 fields. A bad name, a missing required key, or a broken lock answers 400 (B §14).                                                                                                                                                                                                                                               | K13, K16                                                                             |
| `If-Match`      | An update applies a stale `etag`, as Google did in L2 (C7). A stale `etag` on a delete answers 412. It stays a marked hypothesis, because L2 sent no `If-Match` on a delete.                                                                                                                                                                                                                                                      | K13, K16                                                                             |
| Removal         | An update without a field removes its values from every user, as check L3 observed on one user (section 6). A delete removes every value of the category. That half stays a marked hypothesis, because no L3 read showed the values after the delete (C10).                                                                                                                                                                       | K16, K20                                                                             |
| Values          | Each `customSchemas` value follows its field type, the multi-value entry form, and the 500-character string limit. A value of an unknown attribute answers 400. That stays a marked hypothesis, because neither L2 nor L3 wrote one (B §14).                                                                                                                                                                                      | K21, K24                                                                             |
| Projections     | `basic` omits `customSchemas`. `full` returns every schema. `custom` returns the schemas that `customFieldMask` names (A §13). A mask that names a missing schema answers 400 `invalid` (C10). Today the mock ignores `projection` (`admin-sdk-mock:src/directory/users.ts:178`).                                                                                                                                                 | K6, K7, K21, K24                                                                     |
| Value writes    | `users.patch` and `users.update` merge `customSchemas` by schema and field, and an absent field stays (baseline §3). `users.patch` keeps a value that the body names with `null`, as Google did in check L3 (C9). `users.update` deletes it, a marked hypothesis until check L4 (K30). Each write answer holds `customSchemas` (C11). Today `updateUser` ignores the key (`admin-sdk-mock:src/directory/user-writes.ts:218-252`). | K21, K24                                                                             |
| Missing user    | A value write to an unknown or hidden user answers 404 `notFound`, also as one batch part. `visibleUser` already throws it (`admin-sdk-mock:src/directory/users.ts:267-275`). K1 adds failing-first tests with a `customSchemas` body.                                                                                                                                                                                            | K21, K24                                                                             |
| Custom queries  | `users.list` accepts `schemaName.fieldName` terms on searchable fields (baseline §3). Today `query` takes built-in fields only (`admin-sdk-mock:docs/reference/api-coverage.md:153`).                                                                                                                                                                                                                                             | Mock tests. No S1 to S3 card searches Google, because filters read the cache (A §2). |
| Seed            | An opt-in seed field adds the scenario of baseline default 13, plus `archived`, `isEnrolledIn2Sv`, and organizations (A §13). Without it, every seeded value stays as in 0.3.0 (`admin-sdk-mock:CHANGELOG.md:27-32`).                                                                                                                                                                                                             | K2, K12, K20, K28                                                                    |

- The fields mask of A §6 already passes, because the mock knows `customSchemas` (`admin-sdk-mock:src/store/schema-names.ts:184`).
- Contract tests check each answer against `Schema` and `SchemaFieldSpec` (`admin-sdk-mock:test/contract/discovery/directory_v1.json:2265`, `admin-sdk-mock:test/contract/discovery/directory_v1.json:2562`).
- Release: version 0.4.0, a `## [0.4.0]` changelog section, and the tag `v0.4.0`, which only the owner pushes (`admin-sdk-mock:CONTRIBUTING.md:64-66`). His answer "3) Yes to 0.4.0" covers it.

## 6. Live checks

**K29, the live read-only check.** It runs after the S3 rehearsal under the standing authorization (`AGENTS.md:38-48`).

1. A fresh token check requests one token for each read scope with the fixture of `AGENTS.md:40-41`.
2. On `unauthorized_client`, K29 stops and blocks with `needs_input`. The owner then checks that the client ID entry lists both full scope URLs.
3. The script calls the production readers, as `deployment/google-proof/device-live.mjs:1-25` does. It runs `users.list`, one `users.get` part, `schemas.list`, and one `schemas.get` part when a category exists (A §13, B §14 L1).
4. Sanitized evidence records methods, scopes, HTTP status, counts, and the JSON type of each info type. It holds no user value (A §13).
5. Empty collections are valid observations (`AGENTS.md:45-46`). The credential contents stay outside Git, reports, and messages (`AGENTS.md:44`).

**K3 and K4, checks L2 and L3.** Both write data, and the standing authorization permits no Google data mutation (`AGENTS.md:48`).

- Each check is a separate card. It starts only after its own yes from the owner (record, Preconditions and live checks).
- L2 needs `admin.directory.userschema` in the delegation. L3 also needs `admin.directory.user` and one test user that the owner names (B §14).
- Neither check needs a build card. Each script sends its own requests through a single-scope client, as `deployment/google-proof/batch-live.mjs:30-35` does.
- U7 requires check L3 before the build. K13 and K14 start S2, so both wait for K4. S1 builds no removal, so it starts without K4 (record, Completion).
- U7 names only L3, so K3 gates no card.
- A result that contradicts a marked hypothesis of section 5 opens a follow-up card for the mock and the app. The owner approves any changed text (CA notes, Approval and build rulings).

**Check L2 answers.** Card K3 (`t_a7a2c296`) ran check L2 on 2026-11-17 (UTC). The evidence is `deployment/evidence/user-schema-live-l2-2026-11-17.json`. Each call went directly to `admin.googleapis.com` and named the category `CcLiveCheck` by its name.

| L2 step    | Call                                                            | Answer                                                                   |
| ---------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 3          | `schemas.insert` of a name in use                               | 412 `conditionNotMet` (C6)                                               |
| 4          | `schemas.update` with a stale `If-Match`                        | 200. Google applied the new display name and answered a new `etag` (C7). |
| 5          | `schemas.update` with a category display name of 200 characters | 400 `invalid`                                                            |
| 5          | `schemas.update` that adds an attribute name of 200 characters  | 200. The answer returned the name unchanged.                             |
| 6          | `schemas.delete` without `If-Match`                             | 204                                                                      |
| 6          | `schemas.insert` of the deleted name at once                    | 200, with an `etag` that differs from the first insert                   |
| 2, 4, 5, 6 | Each answered `schemaId`                                        | 24 characters that fail `[A-Za-z0-9_-]` (C8)                             |
| 1, 7       | `schemas.list`                                                  | 1 category before and 1 after. The final list holds no `CcLiveCheck`.    |

- L2 settles the name reuse row of B §6.3: Google accepts a deleted name at once.
- Card `t_59080ffd` brings the L2 answers into admin-sdk-mock 0.4.0 before the tag `v0.4.0`: C6, C7, a 400 `invalid` for a category display name of 200 characters, and schema IDs with `=` padding. C6 to C8 correct the rules of K6, K13, K14, and K16.
- C6 to C8 change no drafted string. A card that adds or changes a string, such as a display name limit message, lists it for the owner. The client shows it only after his approval.
- Campus Commander adds no display name limit. Google accepted a category display name of 21 characters and refused one of 200. The limit between them is not known. A longer name fails the category job with the Google reason (B §7.3).
- L2 did not verify these behaviors:
  - The category display name limit between 21 and 200 characters, and any attribute display name limit.
  - An attribute name over 200 characters, and the category name length.
  - `If-Match` on `schemas.delete`.
  - A call that names a category by `schemaId`, and whether a recreated category gets a new `schemaId`.
  - The batch transport and the part allowlist. L2 sent no batch part.

**Check L3 answers.** Card K4 (`t_4a09ffa8`) ran check L3 on 2026-11-17 (UTC) with the script at `81f95a7`. The evidence is `deployment/evidence/user-values-live-l3-2026-11-17.json`. Each Directory call went directly to `admin.googleapis.com`, and each schema call named the category `CcLiveValues` by its name. The values went to one test user that the owner named. The evidence calls that user `test-user@example.org`.

After each step, the script read the user with `projection=custom` and `customFieldMask=CcLiveValues` at once. It read again once a second, for up to 8 seconds, until the step showed its expected state.

| L3 step | Call                                                                                              | Answer and reads                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1       | `schemas.get` of `CcLiveValues`                                                                   | 404 `notFound`. The user read answered 400 `invalid`.                                                        |
| 2       | `schemas.insert` with nine attributes: one of each info type, a list, and a second text attribute | 200. The user read answered 200 with no value.                                                               |
| 3       | `users.patch` that sets the nine values                                                           | 200. The read at once showed no value. The read 1 second later showed all nine (C11).                        |
| 3       | The answer of that `users.patch`                                                                  | The user resource with 25 top-level keys, `customSchemas` among them. The evidence holds the key names only. |
| 4       | `users.patch` that names a single value and a list with `null`                                    | 200. Both values still read 8 seconds later (C9).                                                            |
| 5       | `schemas.update` that turns a single text attribute to multiple values                            | 200. The read at once showed the value as a list of one entry (C12).                                         |
| 6       | `schemas.update` that leaves out the attribute `ccText`                                           | 200. The read at once showed no `ccText` value.                                                              |
| 7       | `schemas.update` that adds `ccText` again, with the same name and type                            | 200, with a new `fieldId`. The reads at once and 1 second later showed no `ccText` value.                    |
| 8       | `schemas.delete` while the user held values                                                       | 204. The user read answered 400 `invalid` (C10).                                                             |
| End     | `schemas.get` and the user read                                                                   | 404 `notFound` and 400 `invalid`                                                                             |

The read of step 3 returned each value in the JSON type of its write. `7` and `1.5` came back as numbers, `true` as a boolean, and the list as `{ "value": ... }` entries. The text, email, date, and phone values came back as the strings that the write sent. The phone value `+1 555 0100` came back unchanged.

Each result goes to the card that owns its rule:

| Result                                                                          | Rule                                                                                                                                     | Owner                                     |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| A `users.patch` with `null` kept both values (step 4)                           | C9 sends each body that holds a `null` as `users.update`. The mock keeps such a value on `users.patch` and deletes it on `users.update`. | K21, K24, and mock card `t_59080ffd`      |
| No check sent `users.update`                                                    | Check L4 tests the clear before K21 starts (OQ4).                                                                                        | K30                                       |
| A mask of a missing category answered 400 `invalid` (steps 1 and 8)             | C10: a failure, never an empty value set. The mock answers the same 400.                                                                 | K21, K23, K24, and mock card `t_59080ffd` |
| The read right after a write showed no value (step 3)                           | C11: a value read-back waits 30 seconds.                                                                                                 | K24                                       |
| The write answer holds `customSchemas` (step 3)                                 | B §7.2 stays. Each mock write answer holds `customSchemas`.                                                                              | K24 and mock card `t_59080ffd`            |
| One value to multiple values gave a list of one entry (step 5)                  | C12 rewrites the cached values. The mock already converts its stored values (K1).                                                        | K16                                       |
| A removed attribute read no value, also after it returned (steps 6 and 7)       | The purge of B §9 stays. The removal words stay.                                                                                         | K16 and K18                               |
| A delete with values answered 204, and no later read showed the values (step 8) | The purge of B §9 stays. The delete words wait for the owner (OQ3).                                                                      | K16 and K18                               |
| The phone value came back unchanged                                             | The phone rule of B §8.1 stays.                                                                                                          | No change                                 |

- L3 answers these rows of B §6.3 for one user of one domain, within the reads of the step table:
  - A value PATCH that names an attribute with `null`.
  - The values of a removed field, and a new field with the name of a removed field.
  - `schemas.delete` while users hold values. L3 shows only that Google accepts the delete.
  - One value to multiple values.
- The step 4 result contradicts the Guide, which states that `null` deletes a value. E16 already names the fallback for this case, and C9 applies it.
- The evidence shows the deleted category absent (404). The user read after the delete answered 400 `invalid`, so it shows no value and no empty value set. L3 did not verify that Google deleted the values of the category.
- After the run, the main chat read the test user with `projection=full` and the read-only user scope (2026-11-16, EST). The user held no custom category, so no `CcLiveValues` key remained. That observation has no evidence file in the repository. It shows no value of a deleted category either, so it does not verify that Google deleted those values.
- The live run used the script at `81f95a7`. Later commits changed the cleanup paths and the construction of the delegated token. The K4 review checked them offline, with signing and scope checks of the token, and without another live run.
- Owner text: the reads of L3 support the removal words of CA states 04, 05, and 07, so they stay. The reads did not show what happened to the values of a deleted category. The delete words of CA state 08 wait for the owner (OQ3, CA notes, Approval and build rulings). C9 to C12 change no other drafted string.
- L3 did not verify these behaviors:
  - `null` through `users.patch` after more than 8 seconds.
  - `users.update`, and any clear of a value (K30).
  - The values of a deleted category, and a new category with the name of a deleted category that held values.
  - The removal results after the reads of steps 6 and 7, and on other users or domains.
  - The values in a write answer. L3 recorded only its key names.
  - The length of the read lag of step 3 on other writes.
  - A value of an unknown attribute.
  - A `customFieldMask` with several names, and `users.list` with `projection=custom`.
  - Other phone formats, and the row of an attribute that a SAML app maps.
  - The batch transport and the part allowlist. L3 sent no batch part.

**K30, check L4.** C9 depends on a `users.update` clear that no live check has sent. Check L4 tests that clear on the test user of L3 before K21 starts. It writes data, so it needs the owner's yes (OQ4, `AGENTS.md:48`). Check L3 used both write scopes, so the delegation holds them.

## 7. Tests

Every test follows the failing-first rule (`docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:1402`). Every mock test runs on 0.4.0 after K2.

| Decision                        | Target                                                      | Proof                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 column ID                    | `application-contracts:test`, `frontend:test`               | One builder gives the column, filter, and draft key. The S1 grid and the S3 editors import it.                                                                                                                                                                                                                                 |
| C2 display names                | `application-contracts:test`, `api:test`                    | A repeat after trimming and case folding fails. The plan route answers 422 `display-name-in-use`.                                                                                                                                                                                                                              |
| C3 update body                  | `api:test`                                                  | An edit of a field with a range keeps its `numericIndexingSpec` in the plan.                                                                                                                                                                                                                                                   |
| Category read in S1 (section 2) | `api:test`, `api-e2e:admin-sdk-mock-integration`            | The route reads `schemas.list` once in 24 hours. Refresh reads it at once.                                                                                                                                                                                                                                                     |
| Navigation (section 3)          | `frontend:test`                                             | A session with only `users:read` shows Users and Your account.                                                                                                                                                                                                                                                                 |
| Calls and scopes (section 4)    | `google-connection:test`                                    | Each call carries its single scope. The mock answers 403 to any other scope.                                                                                                                                                                                                                                                   |
| Doubles (section 4)             | `google-connection:test`                                    | The guard finds no production import of the mock or of `batch-fake.mjs`.                                                                                                                                                                                                                                                       |
| Capabilities                    | `google-connection:test`, `api-e2e:phase3-auth-integration` | The health check passes each new capability on the mock and on the preload.                                                                                                                                                                                                                                                    |
| `etag` and `If-Match`           | `worker:test`                                               | A fresh `etag` that differs fails `category-changed` and sends nothing. The mock applies an update with a stale header, as Google did (C7).                                                                                                                                                                                    |
| C6 reused name                  | `worker:test`                                               | An insert answer of 409 or 412 settles Failed `name-in-use`, and the schema cache refreshes.                                                                                                                                                                                                                                   |
| C8 schema IDs                   | `google-connection:test`                                    | On `batch-fake.mjs`, a `schemaId` that holds `/`, `+`, and `=` leaves percent-encoded in one path segment, and the part allowlist admits it.                                                                                                                                                                                   |
| C9 clear                        | `google-connection:test`                                    | A body with a `null` leaves as a `users.update` part and clears the value on the mock. Every other body leaves as a `users.patch` part.                                                                                                                                                                                        |
| C10 missing category            | `google-connection:test`, `worker:test`                     | A custom read that answers 400 `invalid` returns a failure, not an empty value set. A read-back with that answer leaves the operation Unknown.                                                                                                                                                                                 |
| C11 read-back                   | `worker:test`                                               | A 2xx answer without the requested values leaves the operation Unknown. Its read-back starts 30 seconds after the answer or later.                                                                                                                                                                                             |
| C12 widened attribute           | `worker:test`                                               | After an edit that turns an attribute to multiple values, each cached value of that attribute is a list of one entry.                                                                                                                                                                                                          |
| Unknown insert                  | `worker:test`                                               | A transient `status` fault answers before the handler runs, so nothing applies. A `hang` past the client timeout delays the handler, so the insert applies after the timeout. Each test checks the stored schema apart from the outcome (`admin-sdk-mock:src/faults/faults.ts:219-236`, `admin-sdk-mock:src/mock.ts:195-207`). |
| Missing user                    | `worker:test`                                               | A 404 part settles Failed `not-found`, and the user leaves the cache. The other parts succeed.                                                                                                                                                                                                                                 |
| Purge                           | `worker:test`                                               | A removal and a delete remove the key from every cached user (B §9).                                                                                                                                                                                                                                                           |
| End to end                      | `api-e2e:admin-sdk-mock-integration`                        | Full sync, refresh, one category lifecycle, and one value change from each entry point (B §14).                                                                                                                                                                                                                                |
| Screens                         | `frontend-e2e:e2e`                                          | Browser checks reproduce the states that each frontend card lists. The suite runs on `frontend:serve` (`frontend-e2e/playwright.config.mts:33-37`). A check against the mock uses `frontend-e2e/playwright.review.config.mts:5-10`.                                                                                            |

The targets sit at `libs/application-contracts/project.json:9`, `libs/google-connection/project.json:9`, `worker/project.json:36`, `frontend/project.json:87`, and `api/project.json:74-78`.
The end-to-end targets sit at `api-e2e/project.json:22-60` and `api-e2e/project.json:141`. The Playwright plugin names `frontend-e2e:e2e` (`nx.json:40-44`).
`api:test` lists its folders, so K8 adds `api/src/app/users/*.test.mjs` to the command (`api/project.json:78`).

## 8. Contracts of S4 and S5

S4 and S5 get no cards. Each gets its own design addendum and screens (record, Exclusions and later slices). These contracts fix their interface with S1 to S3.

**S4 account actions** (A §12):

- Suspend, Reactivate, Move to OU, and Require password change call `users.patch` through the `user-changes` capability of S3.
- Sign out calls `users.signOut` with `admin.directory.user.security` through a new capability (A §15.3 point 3).
- Each action runs selection, preview, confirm, job, and audited result (`docs/portfolio/02-domain-model.md:162`).
- S4 reuses the users selection key (A §8) and the read-back upsert (A §5.1). It adds its actions to the Bulk Actions menu of K27 (UM notes ruling 9).
- A move needs User Write in both OrgUnits (`docs/workflows/platform-access.md:759-761`). The S4 addendum names the job kind, the prefix, and the observed-at stamps (A §7, A §12).
- Each live S4 write needs the owner's yes and its scope in the delegation (`AGENTS.md:47-48`).

**S5 export and import** (A §12):

- S5 reuses the `EXP` and `IMP` jobs of the device flow (`docs/superpowers/specs/2026-10-28-device-export-import-design.md:33`).
- Each attribute column carries the C1 column ID. Each cell carries the canonical form of B §8.1.
- Execution creates value jobs through the edit-list preview of B §10, and S4 jobs for the account fields (A §12).
- A §12 and B §2 each leave the multi-value cell form to the other document. The S5 addendum defines it.

## 9. Card plan

- K1 comes first. Each card that tests against mock 0.4.0 depends on K1 through K2.
- Each slice starts after the rehearsal of the slice before it (U3). S2 also waits for K4 (U7, section 6). K21 also waits for K30 (C9). Each frontend card waits for its API cards.
- Each backend card owns one surface: storage and contracts, Google calls, HTTP routes, or the worker. Each card that widens an enum fixes every exhaustive switch over it (`tsconfig.base.json:14`).
- Migrations take the next free numbers after `deployment/postgres/migrations/018-device-write-access.sql:1`: 019 (K5), 020 (K14), and 021 (K22).
- Capability IDs change in place in migrations 010 and 011, as commit `0f976ca` did for `drive-files`.

**Mock and live write checks**

- **K1. admin-sdk-mock 0.4.0: user schemas and custom values** · `backend` · repository `CampusCommander/admin-sdk-mock` · after: none
  - Scope: the routes and behaviors of section 5.
  - Acceptance: `npm test`, `npm run lint`, `npm run typecheck`, `npm run format:check`, and `npm run test:contract` pass. `admin-sdk-mock:docs/reference/api-coverage.md` lists the five schema routes. `admin-sdk-mock:docs/calibration.md:5` gains an `open` row for each marked hypothesis of B §14. They are the `If-Match` 412, value deletion on removal, and the unknown attribute 400. A domain without the seed field hashes as in 0.3.0. `admin-sdk-mock:CHANGELOG.md` holds `## [0.4.0]`.
  - Collides: no Campus Commander file. After review, the owner pushes the tag `v0.4.0` (`admin-sdk-mock:CONTRIBUTING.md:65`).
  - Calibration: card `t_59080ffd` adds the live check answers to the mock on the K1 branch before the tag.
- **K2. Pin admin-sdk-mock 0.4.0** · `platform` · after: K1 and the `v0.4.0` release
  - Scope: the pin of `package.json:12` and its lock entry, and the pin lines of `docs/testing/client-review.md:29`, `docs/testing/client-review.md:51`, and `docs/testing/admin-sdk-mock.md:16`. The harness turns on the seed field. The guard also names `batch-fake.mjs`.
  - Acceptance: `npm ci` installs 0.4.0. `google-connection:test`, `api-e2e:admin-sdk-mock-integration`, and `api-e2e:client-review-mock` pass. The harness domain answers `schemas.list` with 3 categories.
  - Collides: `package.json`, `package-lock.json`, `api-e2e/admin-sdk-mock-fixture.mjs`, `libs/google-connection/src/lib/admin-sdk-mock-guard.test.mjs`.
- **K3. Live check L2** · `qa` · GATED on the owner's yes · after: none
  - Scope: B §14 L2 on the category `CcLiveCheck`, through a script beside `deployment/google-proof/device-live.mjs:1-25`. Precondition: `admin.directory.userschema` in the delegation.
  - Acceptance: sanitized evidence records the answers to the reused name, the stale `If-Match`, the 200-character name, and the name reuse. The domain holds no `CcLiveCheck` at the end.
  - Collides: `deployment/google-proof/` (K4).
- **K4. Live check L3** · `qa` · GATED on the owner's yes · after: none · K13 and K14 wait for it (U7)
  - Scope: B §14 L3 on one test user that the owner names. Precondition: `admin.directory.user` and `admin.directory.userschema` in the delegation.
  - Acceptance: the evidence records each B §6.3 row that names check L3. It also records the `null` answer on a list, the PATCH answer, and the phone format. The row of an attribute that a SAML app maps stays unverified (B §6.3). Each contradicted hypothesis of section 5 gets a follow-up card.
  - Collides: `deployment/google-proof/` (K3).
- **K30. Live check L4** · `qa` · GATED on the owner's yes (OQ4) · after: none · K21 waits for it
  - Scope: C9 on a test category `CcLiveClear` and the test user of K4. Set three single values and a list with `users.patch`. Then send one `users.update` body. It sets the first single value and names the second single value and the list with `null`. It leaves the third single value out. Read the user with `projection=custom` at once, then once a second for up to 60 seconds. The script compares the account fields of a `projection=basic` read before and after the update. Precondition: the scopes of K4.
  - Acceptance: the evidence records whether `users.update` cleared each `null` value and after how many seconds. It also records the set value, the value that the body left out, and the answer shape. It records the account field comparison as yes or no, and it holds no account field value. The domain holds no `CcLiveClear` at the end.
  - Collides: `deployment/google-proof/` (K3, K4).

**S1 Browse users**

- **K5. Users inventory schema and contracts** · `backend` · after: none
  - Scope: `deployment/postgres/migrations/019-user-inventory.sql` holds the tables and indexes of A §7 and the schema cache of B §9. The `entity_type` check gains `user` (`deployment/postgres/migrations/016-device-inventory.sql:107`). Each SQL gate of the refresh path accepts `users:read` for that type (A §8).
  - Scope: the `users:read` row lands with the enum entry (`deployment/postgres/migrations/016-device-inventory.sql:4`, `libs/application-contracts/src/lib/authorization.ts:3-61`). `entityTypeSchema` and the freshness map gain `user` (`libs/application-contracts/src/lib/entity-cache.ts:13-19`). A new `libs/application-contracts/src/lib/users.ts` holds the schemas of A §8 and B §10 row 1, and the C1 builder.
  - Acceptance: a fresh database runs every migration through 019. `application-contracts:test` covers each schema and the C1 builder. A platform administrator session holds `users:read` (`libs/application-contracts/src/lib/authorization.ts:116`). A principal with only `devices:read` lists no user refresh job (A §10).
  - Collides: `libs/application-contracts/src/lib/authorization.ts` and `libs/application-contracts/src/index.ts` (K14, K22).
- **K6. Google user and category readers, read capabilities** · `backend` · after: K2, K5
  - Scope: the user reader and the schema reader of A §6, with their allowlist entries (section 4). `user-inventory` and `user-schemas` join `GOOGLE_CAPABILITIES`, the setup list (`libs/application-contracts/src/lib/google-capabilities.ts:98-106`), and the preload. They also join every SQL list (`deployment/postgres/migrations/010-google-capability-health.sql:10`, `deployment/postgres/migrations/010-google-capability-health.sql:34`, `deployment/postgres/migrations/010-google-capability-health.sql:57`, `deployment/postgres/migrations/011-google-credential-lifecycle.sql:308`). The health finish check counts one more result for each capability, as commit `3efd855` shows. The schema reader keeps each `schemaId` opaque (C8).
  - Acceptance: `google-connection:test` passes the readers on `batch-fake.mjs` and on the in-process mock. The capability health test passes both capabilities on 0.4.0. `api-e2e:phase3-auth-integration` passes. A call outside the allowlists fails before it leaves the process.
  - Collides: `libs/google-connection/src/lib/provider.ts`, `libs/application-contracts/src/lib/google-capabilities.ts`, migrations 010 and 011, and `api-e2e/google-connection-preload.cjs` (K13, K21).
- **K7. Worker user sync and refresh jobs** · `backend` · after: K6
  - Scope: the full user sync, the refresh job, and the 404 removal of A §3 and A §6. `worker/src/dispatch.ts` and `worker/src/entity-sync.ts` dispatch the type `user`. A user sync flow joins `deployment/kestra/`, and the refresh flow stays shared (A §5).
  - Acceptance: `worker:test` syncs the mock scenario into `cc.users`, and each raw `customSchemas` equals the mock answer. A refresh of a deleted user marks it removed. A quota fault retries only its part (A §6).
  - Collides: `worker/src/dispatch.ts` (K16, K24) and `worker/src/entity-sync.ts`.
- **K8. Users API and the category read** · `backend` · after: K7
  - Scope: the routes of A §8 in a new `api/src/app/users/` module. The category read of B §10 row 1 follows the cache rules of B §9. Attribute predicates use C1 IDs and the operators of baseline default 4.
  - Acceptance: `api:test` runs the new folder. It covers 403 without `users:read`, 409 `connection-required`, paging, selection expiry, and each predicate. `api-e2e:admin-sdk-mock-integration` syncs, filters on Grade level, refreshes selected users, and reads one user.
  - Collides: `api/src/app/app.module.ts`, `api/project.json`, and `api/src/app/users/` (K15, K23).
- **K9. Users feed** · `backend` · after: K7
  - Scope: the users feed of A §8 on `GET /api/events`, by the rule of the device feed (`api/src/app/events/events.controller.ts:143-164`). Every event names its entity type.
  - Acceptance: `api:test` shows that a session without `users:read` receives no user event. A ping closes the users feed after a revoke (A §8). The device feed tests pass unchanged.
  - Collides: `api/src/app/events/events.controller.ts` and `api/src/app/events/events-stream.ts`.
- **K10. Users grid page** · `frontend` · after: K8, K9
  - Scope: the Users item below Devices (baseline default 1) and the `users` route behind `users:read` (`frontend/src/app/app.routes.ts:64-74`). It builds the store on `LiveFeeds`, the static fields, and the attribute column hook with C1 IDs. `docs/ui/entity-grid-fields.json` gains `userColumns` (A §9).
  - Scope: it builds the Columns panel groups, typed filters, and the pinned Name column (record default 4). It also builds selection, paging, Refresh, and the states of A §11. The tab bar holds the Users tab, and K17 adds Custom attributes (U2, U3).
  - Acceptance: `frontend:test` passes. `frontend-e2e:e2e` reproduces UM states 01, 02, 03, and 13. The grid cells compute the font family of the Devices grid (UM notes ruling 3). A session with only `users:read` shows Users and Your account.
  - Collides: `frontend/src/app/shell/shell.html`, `frontend/src/app/app.routes.ts` (K11), `frontend/src/app/jobs/live-feeds.ts`, and `docs/ui/entity-grid-fields.json`.
- **K11. User details page** · `frontend` · after: K8, K10
  - Scope: the `users/:userId` route and the details of A §9: Account, Organization, and a read-only Custom attributes card. Its sections show "Not set", chips, and "No values set" (UM notes composition 2). Next user and Back to users follow A §4.
  - Acceptance: `frontend-e2e:e2e` reproduces UM state 04. A removed user shows its removal time (A §11).
  - Collides: `frontend/src/app/app.routes.ts` and the users store (K10, K25).
- **K12. Rehearsal S1** · `qa` · after: K5 to K11
  - Scope: record completion step 1 on `api-e2e:client-review-mock` with admin-sdk-mock 0.4.0.
  - Acceptance: the run browses users, filters on an attribute, selects users, refreshes, and opens one user. Screenshots stand beside UM states 01 to 04 and 13. Each difference becomes a finding.
  - Collides: none.

**S2 Manage categories**

- **K13. Google category writer and `user-schema-changes`** · `backend` · after: K12, K4
  - Scope: batch parts for `schemas.get`, `schemas.insert`, `schemas.update`, and `schemas.delete` (section 4), with `If-Match` on an update and a delete (E7). The capability `user-schema-changes` joins the lists of K6.
  - Acceptance: `google-connection:test` sends each call to the mock as a part with one scope. Each update and delete part carries the plan `etag` in `If-Match` (E7, C7). Each `schemaKey` leaves percent-encoded (C8). A transient insert answer gets no retry, and a quota answer retries (`libs/google-connection/src/lib/batch.ts:894-903`). The capability health test passes on 0.4.0.
  - Collides: the files of K6.
- **K14. Category plan storage and the category job contract** · `backend` · after: K12, K4
  - Scope: `deployment/postgres/migrations/020-user-attribute-categories.sql` holds the plans, the `user-schema-change` kind, and the `users:schema-manage` row. The action joins `actionSchema` in this card. `CAT` joins the display and operation ID rules (`libs/application-contracts/src/lib/jobs.ts:24-37`).
  - Scope: `libs/application-contracts/src/lib/users.ts` gains the plan and confirm schemas of B §10, with `numericIndexingSpec` for K19. A `schemaId` stays an opaque string (C8).
  - Acceptance: a fresh database runs every migration through 020. `application-contracts:test` covers the plan schemas and the `CAT` ID rule. A platform administrator session holds `users:schema-manage` (`libs/application-contracts/src/lib/authorization.ts:116`).
  - Collides: `libs/application-contracts/src/lib/authorization.ts`, `libs/application-contracts/src/lib/jobs.ts`, and `libs/application-contracts/src/lib/users.ts` (K5, K22).
- **K15. Category plan routes** · `backend` · after: K14
  - Scope: the plan and confirm routes of B §10 in `api/src/app/users/`. They apply B §5, C2, and C3, and they accept `numericIndexingSpec`.
  - Acceptance: `api:test` covers each plan rule and 422 code, the typed name, 412 `category-changed`, expiry, and a repeated confirm. An edit of a field with a range keeps its `numericIndexingSpec`. A confirm answers one `CAT-` receipt (B §10).
  - Collides: `api/src/app/users/` (K8, K23).
- **K16. Category job worker** · `backend` · after: K13, K15
  - Scope: the order of B §6.2 and the outcomes of B §7.3. It adds the cache write and purge of B §9, and cancel (B §7.4). The job shares the device write slot (E8, `docs/superpowers/specs/2026-10-16-device-write-jobs-design.md:279`).
  - Acceptance: on the mock, `worker:test` fails a changed `etag` with `category-changed` before any write. An insert answer of 409 or 412 settles Failed `name-in-use` (C6). A 412 answer to an update or a delete settles Failed `category-changed` (C7). A delete answer of 204 settles Succeeded. A delete purges the key from every cached user. After an edit to multiple values, each cached value of the attribute is a one-entry list (C12). Both Unknown insert cases of section 7 pass. `api-e2e:admin-sdk-mock-integration` runs one create, one edit, and one delete through the K15 routes.
  - Collides: `worker/src/dispatch.ts` (K7, K24).
- **K17. Custom attributes tab and read-only views** · `frontend` · after: K14
  - Scope: the Custom attributes tab (U2) on the category read route of K8. Its category list drops the Last changed column (record default 2). It adds the limit counts, the empty state, Refresh, and the read-only category dialog (U4).
  - Acceptance: `frontend-e2e:e2e` reproduces CA states 01, 09, and 11 without the Last changed column. A session without `users:schema-manage` shows no Create category (CA notes composition 12).
  - Collides: the Users page and its tab bar (K10).
- **K18. Category editor dialog** · `frontend` · after: K15, K16, K17
  - Scope: the dialog of CA states 02 to 08, 10, and 12. It holds the editor, errors with C2, locks, and the removal mark. It also holds review with the typed name, saving, the result, the delete question, the limit, and the visibility note. It draws no range input.
  - Acceptance: `frontend-e2e:e2e` reproduces each listed state. A repeated display name shows the C2 error. Each flow ends in its dialog without the job page (baseline §2). Check L3 supports the removal words of CA states 04, 05, and 07, so they stay (section 6). The delete words of CA state 08 follow the owner's answer to OQ3. Changed words wait for the owner (CA notes, Approval and build rulings).
  - Collides: the category dialog files (K19).
- **K19. Number range inputs** · `frontend` · GATED on a frame that the owner approves · after: K18
  - Scope: minimum and maximum inputs for Whole number and Decimal number attributes (record default 3). K14 and K15 already accept the range.
  - Gate: no frame draws the inputs (record, Design). K19 starts after the owner approves such a frame. No card depends on K19.
  - Acceptance: `frontend-e2e:e2e` reproduces that frame. A saved range reaches the plan body.
  - Collides: the category dialog files (K18).
- **K20. Rehearsal S2** · `qa` · after: K13 to K18
  - Scope: record completion step 2 on admin-sdk-mock 0.4.0.
  - Acceptance: the run creates, edits, and deletes a category and shows each result in the dialog. Screenshots stand beside CA states 01 to 12. Each difference becomes a finding.
  - Collides: none.

**S3 Set attribute values**

- **K21. Google value writer, custom read, and `user-changes`** · `backend` · after: K20, K30
  - Scope: `users.patch` parts with the bodies of B §8.3, and `users.get` with `projection=custom` and `customFieldMask` (B §7.2, B §8.4). Each body that holds a `null` goes as a `users.update` part (C9). Both allowlists gain the `users.update` shape. The capability `user-changes` joins the lists of K6.
  - Acceptance: `google-connection:test` writes each mode on the mock and reads it back. A body with a `null` leaves as `users.update` and clears the value on the mock. Every other body leaves as `users.patch` (C9). A custom read that answers 400 `invalid` returns that failure, not an empty value set (C10). A missing user fails only its part (`docs/superpowers/specs/2026-10-07-google-batch-service-decisions.md:91-93`). The capability health test passes on 0.4.0.
  - Collides: the files of K6.
- **K22. Value preview storage and the value job contract** · `backend` · after: K20
  - Scope: `deployment/postgres/migrations/021-user-attribute-values.sql` holds previews, targets, the `user-attribute-update` kind, and the `users:write` and `users:bulk-actions` rows. Both actions join `actionSchema` here, and `UAT` joins the ID rules.
  - Scope: `libs/application-contracts/src/lib/users.ts` gains the preview and confirm schemas of B §10, with C1 keys.
  - Acceptance: a fresh database runs every migration through 021. `application-contracts:test` covers the preview schemas and the `UAT` ID rule. A platform administrator session holds both actions.
  - Collides: the files of K14.
- **K23. Value preview routes** · `backend` · after: K22
  - Scope: the preview and confirm routes of B §10 in `api/src/app/users/`. They apply B §8, E11, and C1 keys.
  - Acceptance: `api:test` covers each mode, Unchanged and Conflict rows, value refusals, 409 `category-changed`, expiry, and both permission paths. An edit-list read that Google answers with 400 `invalid` answers 503 `user-read-failed`, and the draft stays (C10). A confirm answers one `UAT-` receipt (B §10).
  - Collides: `api/src/app/users/` (K8, K15).
- **K24. Value job worker** · `backend` · after: K21, K23
  - Scope: claims, batches of 250 parts, and the outcomes of B §7.3. It adds read-back, the user row write, and the users feed event (B §9). A 404 settles Failed `not-found` and removes the user from the cache (B §13).
  - Acceptance: `worker:test` covers every row of B §7.3 on the mock. A 2xx answer without the requested values leaves the operation Unknown (C11). Its read-back starts 30 seconds after the answer or later. A read-back that answers 400 `invalid` leaves the operation Unknown (C10). A clear settles Succeeded only when the answer or the read-back shows no value. `api-e2e:admin-sdk-mock-integration` sets one value from each entry point. The 404 row reads "Google could not find this user." (UM notes question 7).
  - Collides: `worker/src/dispatch.ts` (K7, K16).
- **K25. Details card editor** · `frontend` · after: K23, K24
  - Scope: the card form behind Edit and the saved line (UM notes compositions 4 and 13). The form edits the whole Custom attributes card. One change saves at once, and more changes go to review (B §4.2).
  - Acceptance: `frontend-e2e:e2e` reproduces UM states 05 and 12. A text over 500 characters shows the count message of in-grid editing (UM notes ruling 4).
  - Collides: the details page (K11).
- **K26. Attribute in-grid editors** · `frontend` · after: K23, K24
  - Scope: the in-grid editor of each info type (B §12), with the C1 ID in each draft key. It adds the pending changes bar and conflict cells (B §8.4).
  - Acceptance: `frontend-e2e:e2e` reproduces UM state 06. A conflict cell blocks Save changes. A No value never reads as empty (B §12).
  - Collides: the field registry and the users store (K10, K27).
- **K27. Bulk Actions and Set attributes** · `frontend` · after: K23, K24
  - Scope: the Bulk Actions menu with Set attributes only (UM notes ruling 9). It builds the dialog of UM states 07 to 11 with the six modes (baseline default 11). Every attribute stays selectable (U5).
  - Acceptance: `frontend-e2e:e2e` reproduces UM states 07 to 11. A session without `users:bulk-actions` gets no Set attributes action (B §11).
  - Collides: the Users page toolbar (K10, K26).
- **K28. Rehearsal S3** · `qa` · after: K21 to K27
  - Scope: record completion step 3 on admin-sdk-mock 0.4.0.
  - Acceptance: the run sets values on one user, in the grid, and through Set attributes, and shows each outcome. Screenshots stand beside UM states 05 to 12.
  - Collides: none.

**Live read-only check**

- **K29. Live read-only check** · `qa` · after: K28
  - Scope: section 6 and record completion step 4.
  - Acceptance: the evidence holds the token check of both read scopes. It holds the answers of `users.list`, `users.get`, `schemas.list`, and `schemas.get` when a category exists. It holds no user value. A denied scope blocks the card with `needs_input`.
  - Collides: none.

## Owner questions

- OQ1. U7 requires check L3 before the build, so the plan holds S2 and S3 until K4 reports. L2 and L3 write data, so each needs your yes (`AGENTS.md:48`). Recommendation: answer yes to both now. Add `admin.directory.userschema` and `admin.directory.user` to the delegation, and name one test user. K3 and K4 then run while S1 builds.
- OQ2. Should User Read also open Jobs, as Device Read does (`frontend/src/app/jobs/jobs.store.ts:29-37`)? Recommendation: yes, in the platform-access build (gap G03). That change touches the SQL job reader (`deployment/postgres/migrations/017-jobs.sql:4728-4745`) and the client gate together. Today only the platform administrator holds grants (A §14), so S1 to S3 need no change.
- OQ3. Keep the delete words of CA state 08, "Deletes Take-home approved values on 1,312 users."? The reads of check L3 support the removal words of CA states 04, 05, and 07. After a category delete, Google answered 204, and each later user read that named the category answered 400 `invalid`. A later `projection=full` read by the main chat showed no key of the category. So no read showed a value, and no read proved that Google deleted the values. K18 builds the delete question after your answer (CA notes, Approval and build rulings). Recommendation: keep the words. Campus Commander shows values only for the categories that Google lists, so no screen shows these values after the delete. L3 did not test a new category with the name of a deleted category. The other option is new words, for example "Google no longer shows Take-home approved values on 1,312 users."
- OQ4. Do you approve check L4 (K30)? Check L3 showed that `users.patch` kept a `null` value for 8 seconds, so every clear depends on `users.update` (C9). L4 writes one test category and values on the test user of L3. It clears values with `users.update` and deletes the category. It writes data, so it needs your yes (`AGENTS.md:48`). Recommendation: yes, before K21 starts. Without L4, the first live clear runs on a real user. If you answer no, K21 builds C9 against the mock only.
