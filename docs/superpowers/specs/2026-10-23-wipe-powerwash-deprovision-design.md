# Technical design addendum: Wipe user data, Powerwash, and Deprovision (step 5, second build)

Status: proposed on 2026-10-23 for review. Card `t_75e7d3ed`.
Record: `docs/workflows/wipe-powerwash-deprovision.md` (PR #108), owner-confirmed on 2026-10-23. Owner, in the main chat: "1", which chose the option "Confirmed: build it as written" (`record:3`).
Extends: [the step 5 design](2026-10-21-device-command-jobs-design.md). It reads [the Update device design](2026-10-21-update-device-fields-design.md).
Owner direction, 2026-10-19: "We are building a doghouse. We dont need to choose the curtains."

## Conventions

- Paths are relative to the repository root at `2ce889b`, the base of this card.
- `record:N` cites the record. `record [n]` cites its Google sources (`record:186-198`).
- `step5:N` cites `2026-10-21-device-command-jobs-design.md`. `update:N` cites `2026-10-21-update-device-fields-design.md`.
- `016`, `017`, and `018` name files in `deployment/postgres/migrations/`. `worker:N` cites `worker/src/device-update.ts`.
- `ac/` is `libs/application-contracts/src/lib/`, `gc/` is `libs/google-connection/src/lib/`, `api/` is `api/src/app/`, and `fe/` is `frontend/src/app/`.
- `mock:` names `node_modules/@campuscommander/admin-sdk-mock/dist/src/`, version 0.2.0 (`package.json:3` of the package).
- `findings` names `~/engineering-team/workspace/destructive-commands/findings.md`, which cites `1a91aa7`.
- `git diff 1a91aa7 2ce889b` changes no cited code file. This design re-read every cited line at `2ce889b`.

## Decision summary

1. Wipe user data and Powerwash join `device-command` as `wipe-users` and `powerwash`. Deprovision joins `device-status` as `deprovision`.
2. Both route families stay. Each route checks the permission of the requested action after the family guard.
3. A Deprovision preview stores one of four reasons. The digest covers the reason, and the job reads it through its preview.
4. The confirm request carries `typedPhrase`. The API and the confirm function check it. No column stores it.
5. The two commands keep 0 retries. Each watch ends at the earlier of expiry plus 24 hours and 30 days after issue.
6. `CANCELLED` settles `failed` with `command-cancelled` for every command type.
7. A succeeded Deprovision writes `DEPROVISIONED` through the step 4 overlay.
8. Six backend cards land the change in dependency order. The routes open last.

## 1. Contracts

| Action        | Family         | Google request                   | Job kind, ID             | Job action, label                          | Permission            |
| ------------- | -------------- | -------------------------------- | ------------------------ | ------------------------------------------ | --------------------- |
| `reboot`      | commands       | `REBOOT`                         | `device-command`, `CMD-` | `reboot-devices`, Reboot devices           | `devices:commands`    |
| `wipe-users`  | commands       | `WIPE_USERS`                     | `device-command`, `CMD-` | `wipe-user-data`, Wipe user data           | `devices:wipe`        |
| `powerwash`   | commands       | `REMOTE_POWERWASH`               | `device-command`, `CMD-` | `powerwash-devices`, Powerwash devices     | `devices:wipe`        |
| `disable`     | status-changes | `..._DISABLE`                    | `device-status`, `STS-`  | `disable-devices`, Disable devices         | `devices:status`      |
| `reenable`    | status-changes | `..._REENABLE`                   | `device-status`, `STS-`  | `reenable-devices`, Re-enable devices      | `devices:status`      |
| `deprovision` | status-changes | `..._DEPROVISION`, with a reason | `device-status`, `STS-`  | `deprovision-devices`, Deprovision devices | `devices:deprovision` |

- Rows 2, 3, and 6 are new. The other rows repeat the first build (`ac/device-actions.ts:20-30`, `ac/jobs.ts:53-68`).
- `..._` abbreviates `CHANGE_CHROME_OS_DEVICE_STATUS_ACTION_` (record [3]). The command types come from record [1] and [2].
- Job IDs follow D4 (`record:95`). Labels follow D3 (`record:94`). The families are `api/devices/commands` and `api/devices/status-changes`.
- `ac/device-actions.ts` exports `DEVICE_ACTION_PERMISSIONS` and `DEVICE_ACTION_PHRASES`. The API and the client read these two maps.

**Deprovision reason.** `ac/devices.ts` exports `deprovisionReasonSchema` with Google's four admin values and the D11 labels (`record:102`).

| Value                                            | Label                          |
| ------------------------------------------------ | ------------------------------ |
| `DEPROVISION_REASON_RETIRING_DEVICE`             | Retiring from fleet            |
| `DEPROVISION_REASON_DIFFERENT_MODEL_REPLACEMENT` | Different model replacement    |
| `DEPROVISION_REASON_SAME_MODEL_REPLACEMENT`      | Same model replacement         |
| `DEPROVISION_REASON_UPGRADE_TRANSFER`            | ChromeOS Flex upgrade transfer |

- The seven other Google values fail the schema (findings 1.3). The schema holds no default, so no reason starts selected.
- The status preview body becomes a discriminated union on `statusAction` (`ac/device-actions.ts:41-48`).
- The `deprovision` branch requires `deprovisionReason`. The strict `disable` and `reenable` branches refuse it.
- A missing or foreign reason answers 400 through the Zod handler (`api/security.ts:52-54`).
- `ac/devices.ts` holds the schema, because `ac/jobs.ts` and `ac/device-actions.ts` both import that file.

**Preview.** `deviceActionPreviewSchema` (`ac/device-actions.ts:62-94`) changes as follows.

- `commandType` takes the three command types. `statusAction` adds `deprovision`. A refine maps each action to one of them.
- A new key `deprovisionReason` holds the frozen reason. It stays null outside Deprovision.
- `actionManifestDigest` (`api/devices/device-actions.ts:125-139`) adds `deprovisionReason` to the canonical object of Deprovision only.
- A new reason therefore needs a new preview (D12). The other five actions keep their canonical object and their digests.
- `GOOGLE_ACTION` (`api/devices/device-actions.ts:48-52`) adds `WIPE_USERS`, `REMOTE_POWERWASH`, and `DEPROVISION`.

**Confirm.** `deviceActionConfirmRequestSchema` (`ac/device-actions.ts:119-123`) adds an optional `typedPhrase` of at most 64 characters.

- `DEVICE_ACTION_PHRASES` maps `wipe-users` to `WIPE`, `powerwash` to `POWERWASH`, and `deprovision` to `DEPROVISION` (D7, ruling 3).
- The API trims the phrase with `String.prototype.trim`. It then compares the result exactly with the phrase of the stored action.
- An action without a phrase requires an absent `typedPhrase`. The client uses the same map and the same trim.
- A mismatch answers 422 `phrase-mismatch`. The check sits beside the digest check (`api/devices/device-actions.ts:372-373`).
- The check runs before `storeJson` (`api/devices/device-actions.ts:374`), so a mismatch stores no manifest artifact.
- `acknowledged: true` stays for every action. Deprovision has no box (D8), so its client sends `true`, as Disable does.

**Receipt.** The receipt schema stays (`ac/device-updates.ts:115-121`). The sheet reads the action and the reason from the job detail.
The sheet reads the action that way today (`fe/devices/device-action-sheet.ts:339-344`).

**Job detail and operations** (`ac/jobs.ts:151-185`, `:226-240`).

- `commandType` takes the three command types. `statusAction` adds `deprovision` (`ac/jobs.ts:232-235`).
- A new key `deprovisionReason` holds the reason of a Deprovision job, and null otherwise. The header query reads it from the preview (`api/jobs/jobs.ts:486-498`).
- `operation` adds `wipe-users`, `powerwash`, and `deprovision` (`ac/jobs.ts:158-165`).
- `outcomeReason` stays open text (`ac/jobs.ts:11-12`), so `command-cancelled` needs no schema change.
- `jobActionSchema` and `JOB_ACTION_LABELS` add the three job actions of the table.
- The Jobs action filter matches `u.action` for every command and status job action. Today only the status pair does (`api/jobs/jobs.ts:414-427`).

## 2. Access

**Catalog.**

- `actionSchema` adds `devices:wipe` and `devices:deprovision` with scope kinds `platform` and `district` (`ac/authorization.ts:3-21`, `:33-53`).
- `fe/action-labels.ts:3-21` adds "Wipe and Powerwash devices" (ruling 1, `record:86`) and "Device Deprovision" (`docs/workflows/platform-access.md:643`).
- `017:4-6` inserts both rows. Bootstrap grants the platform administrator every row (`deployment/bootstrap/application-access.mjs:87-89`).
- The district preset gains neither action (`ac/authorization.ts:109-117`). No other person gains authority.
- The enum and the rows land in one card. A stored grant outside `actionSchema` fails the session parse (`ac/application-contracts.ts:65`).
- The write-access read admits both new actions beside the three of today (`018:12`, `:34`).
- The platform access and invitation pages list `actionSchema.options` (`fe/platform-access/platform-access.ts:53`, `fe/invitations/invitations.ts:51`).
- Both pages therefore list the new actions, as they list `devices:commands` today. This design changes neither page.

**Route checks.** The two families stay. Each route checks the permission of its action at district scope.

1. The family guard requires `devices:read` and `devices:bulk-actions` before any read (`api/devices/device-actions.controller.ts:44-62`).
2. `POST previews` takes the action from the parsed body. It replaces the literal `reboot` (`api/devices/device-actions.controller.ts:91`).
3. The three routes with a preview ID take the action from the stored row. `load()` checks the owner and the family first (`api/devices/device-actions.ts:264-282`).
4. The service then calls an `authorize(action)` callback with `DEVICE_ACTION_PERMISSIONS[action]`. Reconcile passes the same kind of callback (`api/jobs/jobs.controller.ts:238-245`).
5. Refusals keep one order: a bad body, the family guard, another person's preview, then the action. They answer 400, 403, 404, and 403.
6. SQL repeats the action check in preview, manifest, confirm, and each batch claim (`017:2294`, `:2357`, `:2421`, `:496`).

Rejected alternative: two new families, `api/devices/wipes` and `api/devices/deprovisions`, with static guards.

- The split adds two controllers, two edge patterns (`deployment/bootstrap/application-edge.mjs:92`, `:95`), and two client paths.
- Static guards rested on one permission per menu entry (step5:258). D1 now places two permissions under each entry (`record:92-93`).
- Reconcile already checks the permission of a stored row after its lookup (`api/devices/device-updates-actions.ts:70-79`).

**Reconcile.**

- A Deprovision operation requires `jobs:read` and `devices:deprovision` (findings 3.4). `ReconcileCheck` adds `deprovision` (`api/devices/device-updates-actions.ts:80-89`).
- Every command operation answers 409 `reconcile-unsupported`. Today only `reboot` does (`api/jobs/jobs.ts:664-667`).

**Client.** Send command enables with `devices:commands` or `devices:wipe`. Change status enables with `devices:status` or `devices:deprovision` (D2, `record:93`).

- Each option reads its own permission from `DEVICE_ACTION_PERMISSIONS`. Today each entry reads one action (`fe/devices/devices.ts:169-174`).
- Device Deprovision includes Device Read in the role editor (`docs/workflows/platform-access.md:695`). The routes keep the explicit `devices:read` check.

## 3. Eligibility

| Action        | Eligible status      | Excluded as                                                 |
| ------------- | -------------------- | ----------------------------------------------------------- |
| `wipe-users`  | `ACTIVE`             | `device-disabled`, `device-deprovisioned`, `status-unknown` |
| `powerwash`   | `ACTIVE`             | `device-disabled`, `device-deprovisioned`, `status-unknown` |
| `deprovision` | `ACTIVE`, `DISABLED` | `device-deprovisioned`, `status-unknown`                    |

- The rows follow D5 (`record:96`). Every action keeps `removed` and `invalid-device-id` (`api/devices/device-actions.ts:104-110`).
- `statusExclusion` (`api/devices/device-actions.ts:69-83`) gains one branch. After the `DEPROVISIONED` test, `deprovision` answers null.
- The two commands reuse the Reboot branch, so a `DISABLED` device answers `device-disabled`.
- Review lists each excluded device and its reason from the targets page (`api/devices/device-actions.controller.ts:111-128`, `docs/ui/patterns.md:209`).
- Offline devices stay eligible (D16). The 100,000-device cap stays (D17, `api/devices/device-actions.ts:39`, `017:44`).
- Zero eligible targets answer 422 `nothing-to-update`, and no job starts (`017:2451-2455`).
- A stale cache stays safe. issueCommand refuses a device that is not active with HTTP 400 (`mock:directory/commands.js:104-105`).
- batchChangeStatus refuses a `DEPROVISIONED` device with code 9 (`mock:directory/device-writes.js:152-159`). Both settle `failed` with Google's message.

## 4. Worker

**Issue.**

- The worker action enum adds the three actions (`worker:159-164`). `isCommandAction` adds `wipe-users` and `powerwash` (`worker:581-583`).
- The issue call sends the command type of the job action instead of the literal `REBOOT` (`worker:1509-1519`).
- The call sends no payload (D6). The mock refuses a payload for both types (`mock:directory/commands.js:86-87`).
- `maxQuotaRetries` stays 0 (`gc/devices.ts:867-868`). The batch service never repeats a transient POST answer (`gc/batch.ts:898-901`).
- A lost answer settles `unknown` with `ambiguous`. No automatic repeat and no Reconcile follow (D13, `record:104`).

**Watch window.** Ruling 2 (`record:88`) changes two deadline writes in 017.

1. Issue settlement (`017:1221`): the two commands take the issue time plus 30 days. Reboot keeps 7 days.
2. First expiry observation (`017:1998-1999`): the two commands take `LEAST(deadline, expiry + 24 hours)`. Reboot keeps the expiry plus 24 hours.

- The deadline sweeps then settle `unknown` with `not-observed` (`017:1858-1860`, `:2007-2009`). The job ends `needs-review` (`017:401`).
- The row keeps `command_expires_at`, so the job detail shows Google's expiry (DEVICE-02, `docs/ui/patterns.md:218`).
- Polls repeat every 60 minutes after six shorter waits (`017:1717-1727`). An offline device costs about 726 GET parts in 30 days.
- Reboot keeps the rule of the first build. The owner chose "Signed off as built" for that build (`docs/current-work.md:8`).

**`CANCELLED`** (D14, `record:105`).

- `classifyCommandPoll` adds a `CANCELLED` case (`worker:958-999`). The case settles `failed` with `command-cancelled` and Google status 200.
- The case covers every command type, Reboot included. Today `CANCELLED` reaches the `unknown` default (`worker:993-999`).
- The settlement takes the result unchanged (`017:1924-1930`). The terminal rule counts it as failed (`017:399-405`).
- `IGNORED` and `FAILURE` keep `command-failed` (`worker:984-990`). Other state values keep `unrecognized-state`.

**Deprovision.**

- The batch claim adds `deprovisionReason` from the job's preview (`017:884`). The worker claim schema reads it (`worker:167-176`).
- `cacheField` answers `status` for `deprovision` (`worker:873-879`). The job then takes the status call (`worker:1521-1528`).
- `changeDeviceStatus` sends `CHANGE_CHROME_OS_DEVICE_STATUS_ACTION_DEPROVISION` and `deprovisionReason` in each part (`gc/devices.ts:161-180`, `:968-971`).
- A part holds at most 50 IDs (`gc/devices.ts:352-378`). A new reason starts a new part. One job holds one reason (D11).
- `statusResults` answers per device (`gc/devices.ts:309-350`). Code 9 settles `failed` with `status-conflict`.
- Retries keep the status rules: 25 quota retries and no transient POST repeat (`gc/batch.ts:93`, `:898-901`).
- A lost answer settles `unknown`. The step 4 read-back compares `status` with `DEPROVISIONED` (`worker:2199-2243`). Reconcile stays (D13).
- A repeat changes nothing. A deprovisioned device answers code 9 (`mock:directory/device-writes.js:152-159`).
- The read-back compares the status only. It ignores Google's stored `deprovisionReason` (record [4], `mock:directory/devices.js:66-70`).

## 5. Schema

Each change edits a migration in place. Development data is disposable (`AGENTS.md:26`). A fresh install recreates every object.

**Previews and jobs.**

- `cc.device_update_previews` (`017:69-90`): the action check (`:76`) adds the three actions. A new column `deprovision_reason text` takes the four values.
- A row CHECK ties the two columns: `(action='deprovision')=(deprovision_reason IS NOT NULL)`.
- `cc.device_update_jobs` (`017:140-172`): the action check (`:143`) adds the three actions. The table gains no reason column.
- A job reads its reason through its unique `preview_id` (`017:142`), as an update reads its changes (`update:77`).
- The purge keeps a preview that holds a job (`017:2595-2597`). The reason therefore lives as long as its job.

**Functions.**

- `cc.create_device_update_preview` (`017:2170-2336`): `p_action` admits the three actions (`:2180`). A new last parameter `p_reason text DEFAULT NULL` follows.
- Its S2 check raises 22023 for a reason outside Deprovision, a Deprovision without a reason, and a fifth value.
- `cc.read_device_update_preview_manifest` adds `deprovisionReason` to the stored manifest (`017:2374-2388`).
- `cc.confirm_device_update_preview` (`017:2394-2521`) gains a last parameter `p_phrase text DEFAULT NULL`.
- `cc.write_capable` (`017:476-486`) takes the mapping of section 2. `write_field` answers `status` for `deprovision` (`017:1142`).
- The batch claim adds `deprovisionReason` (`017:884`). The deadline writes follow section 4 (`017:1221`, `:1998-1999`).
- Both new parameters default to null, so the update callers stay unchanged (`api/devices/device-updates.ts:351`, `:513`).
- The grants name both new signatures (`deployment/postgres/index.mjs:300`, `:302`).

**Stored typed-phrase check.** The confirm function compares the phrase right after the digest check (`017:2437-2439`).

- The function answers `phrase-mismatch` when `p_phrase IS DISTINCT FROM` the phrase of the action. Actions without a phrase expect null.
- The API passes the trimmed phrase, so the function compares exactly. The S2 check bounds the phrase to 64 characters.
- A replay of a preview that holds a job keeps its receipt answer (`017:2429-2431`). The digest check behaves the same way.
- No column stores the phrase. The action fixes the phrase, so a stored copy adds no evidence.
- Rejected alternative: a `confirmation_phrase` column with a CHECK per action. That column repeats the action.

**Job rows.**

| Action                    | Header kind, sequence                 | `baseline_value` | `requested_value` |
| ------------------------- | ------------------------------------- | ---------------- | ----------------- |
| `wipe-users`, `powerwash` | `device-command`, `cc.job_number_cmd` | Cached status    | Null              |
| `deprovision`             | `device-status`, `cc.job_number_sts`  | Cached status    | `DEPROVISIONED`   |

- Confirm writes these values (`017:2472-2476`, `:2496-2499`). Reboot rows take the same values today.
- The recovery, finish, and poll functions branch on the header kind (`017:707`, `:1614`, `:1846`). They need no other change.

## 6. Cache

- Confirm stores `DEPROVISIONED` as the requested value (`017:2497-2499`).
- A write-response success publishes the requested value (`017:1194-1195`). A read-back success publishes the observed status.
- Publication writes `cc.devices.status`, its stamp, and a 36-hour overlay (`017:1279-1312`). The overlay table admits `status` (`017:253`).
- A lagged list keeps the overlay value (`016:441-445`). The mock lags lists by 300 s (`mock:settings.js:31`).
- The settlement publishes `entity-batch`, and the Devices store reloads those rows (step5:221-223).
- The Status column therefore shows Deprovisioned without a reload (`record:40`). This step needs no client change.
- Wipe user data and Powerwash change no cached field (D15). Their settlements publish `job-changed` only (step5:224).

## 7. Tests

No test calls Google (D20, `record:111`). Each target below runs admin-sdk-mock or fakes.

| Decision            | Target                                                          | Proof                                                                                                  |
| ------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Catalog             | `application-contracts:test`, `deployment:postgres-integration` | A fresh install grants both actions to the platform administrator. The district preset holds neither.  |
| Contracts           | `application-contracts:test`                                    | Four reasons pass, and seven fail. Deprovision without a reason fails. `REMOTE_POWERWASH` passes.      |
| Route checks        | `api:test`, `deployment:postgres-integration`                   | A person without the action permission receives 403 from the route and `forbidden` from SQL.           |
| Eligibility, digest | `api:test`                                                      | Each section 3 row. Two reasons give two digests. First-build digests of a fixed input stay unchanged. |
| Typed phrase        | `api:test`, `deployment:postgres-integration`                   | `" WIPE "` matches. `WIPE` on Powerwash answers 422 and stores no manifest. SQL refuses a null phrase. |
| Job rows            | `deployment:postgres-integration`                               | Kinds, prefixes, requested values, and the reason in the manifest and the claim.                       |
| Watch window        | `deployment:postgres-integration`                               | Both deadline writes for both rules. The sweep settles `not-observed`, and the job needs review.       |
| `CANCELLED`         | `worker:test`                                                   | Reboot and Powerwash settle `failed` with `command-cancelled`.                                         |
| Issue               | `worker:test`, `google-connection:test`                         | One POST per device without a payload. Both command types issue and poll on the mock.                  |
| Lost issue answer   | `api-e2e:admin-sdk-mock-integration`                            | A hang loses a Powerwash answer. The mock holds one command, and the job needs review.                 |
| Deprovision call    | `google-connection:test`                                        | The part carries the reason. Active and disabled devices change. A repeat answers code 9.              |
| Deprovision job     | `worker:test` (`worker/src/device-status-mock.test.mjs`)        | Per-device results, the stored mock reason, and `status-conflict` for a deprovisioned target.          |
| Lost status answer  | `api-e2e:admin-sdk-mock-integration`                            | A hang loses a Deprovision answer. The read-back settles `succeeded`.                                  |
| Cache               | `deployment:postgres-integration`                               | Deprovision publishes `DEPROVISIONED` and an overlay. A lagged list keeps it. Commands write no field. |
| Jobs API            | `api:test`, `deployment:postgres-integration`                   | Detail keys, operation words, the action filter, and both Reconcile rules.                             |
| Completion          | `api-e2e:client-review-mock`, `frontend-e2e:e2e` (Chromium)     | Card Q1 rehearses `record:178-184`.                                                                    |

Targets: `api-e2e/project.json:22-59`, `deployment/project.json:100-107`, and `worker/project.json:36-42`. The Playwright plugin infers `frontend-e2e:e2e` (`nx.json:40-42`).

**Lost answers on the mock.** A `hang` fault sleeps `ms / scale`, then the handler runs (`mock:faults/faults.js:136-141`, `mock:mock.js:123-137`).

- The handler stores the command or applies the status. The 10 s timeout then loses the answer (`gc/provider.ts:299`).
- Use an `ms` of at least `12,000 × scale` and a `count` of 2. A `remaining` of 1 then proves one POST (step5:297-302).
- `ms` holds at most 600,000 (`mock:faults/faults.js:66-67`), so a hang test runs at a scale of at most 50.
- Kinds `status` and `reset` return before the handler (`mock:faults/faults.js:124-135`). They prove a transient refusal only.

**What the tests cannot prove** (findings section 2).

1. Enrollment after Powerwash. The mock keeps status and enrollment (`mock:directory/command-effects.js:27-30`). Google removes enrollment unless forced or automatic enrollment applies (record [2]).
2. The report of a powerwashed device. No source states whether it reports `EXECUTED_BY_CLIENT` with `SUCCESS` (`record:174`).
3. Expiry per type. The mock gives every command 432,000 s (`mock:settings.js:32`). Google help gives 180 days and 5 years (record [11]).
4. Reasons. The mock accepts ten values (`mock:directory/device-writes.js:108-119`). The contract refuses seven before any call, so no test reaches Google's refusal.
5. States. The mock answers five states (`mock:directory/command-effects.js:7-17`). Only fakes prove `CANCELLED`, `IGNORED`, and `STATE_UNSPECIFIED`.
6. Disabled targets. The mock refuses a command to a device that is not active. Google documents no rule, and D5 excludes such devices.
7. Command effects. The mock clears recent users only (`mock:directory/command-effects.js:23-30`). Campus Commander caches none, so no test observes an effect.
8. Live writes. Green tests prove the mock contract only. Live device writes stay unverified (`record:174`).

## Risks and follow-ups

- A wrong entry in `DEVICE_ACTION_PERMISSIONS` checks the wrong permission. `cc.write_capable` repeats every check, and B6 tests each action.
- A 100,000-device Powerwash of offline devices sends about 100,000 GET parts per hour for 30 days.
- The gaps of section 7 leave Google behavior unproven. DEVICE-01 asks for capability evidence before release (`docs/ui/patterns.md:198`).
- Hotspots: `017-jobs.sql` and the job detail fixtures. The table of shared files below orders every edit.
- Follow-up, not scheduled: the DEVICE-01 row needs typed confirmation for Deprovision (`record:90`, `:163`).
- Follow-up, not scheduled: `COMMAND_RESULT_TYPE_UNSPECIFIED` settles `failed` today (`worker:984-990`). D14 names only `IGNORED` and `FAILURE`.

## Card plan

| ID  | Title                                                           | Profile  | Depends on       |
| --- | --------------------------------------------------------------- | -------- | ---------------- |
| B1  | Access: Wipe and Powerwash devices, and Device Deprovision      | backend  | none             |
| B2  | Google calls: Deprovision with a reason                         | backend  | none             |
| B3  | Job schema: three actions, the reason, and the typed phrase     | backend  | B1               |
| B4  | Jobs API: three job actions and the reason                      | backend  | B3               |
| B5  | Worker: two commands, Deprovision, and `CANCELLED`              | backend  | B2, B3           |
| B6  | Previews and confirm for three actions                          | backend  | B1, B3, B4, B5   |
| F1  | Bulk Actions: Wipe user data, Powerwash, and Deprovision sheets | frontend | B6, mockup       |
| F2  | Jobs: Wipe user data, Powerwash, and Deprovision jobs           | frontend | B4, mockup       |
| Q1  | Rehearse the five completion steps                              | qa       | B1 to B6, F1, F2 |

- B6 opens the routes last. Every job that a route creates then has a worker and a jobs page.
- Each card that changes a contract updates every consumer, including `api-e2e` and the `frontend-e2e` fixtures (`update:253`).
- Each frontend card waits for its API card and for the owner's answer on the mockup (`record:137`, `:162`). The mockup sits outside this plan.

**B1.** Scope: the catalog of section 2 in `ac/authorization.ts`, `fe/action-labels.ts`, `017:4-6`, and `018:12`, `:34`.
Acceptance: both actions parse at platform and district scope. The platform preset holds both, and the district preset holds neither.
A fresh install grants both actions to the platform administrator. `cc.device_writer` admits a person with one of them alone. `frontend:build` passes.

**B2.** Scope: Deprovision in `gc/devices.ts:161-180`, `:352-378`, and `:950-972`. The reason travels as a string, like the command type (`gc/devices.ts:235`).
Acceptance in `google-connection:test`: a Deprovision part carries its action name and its reason. Disable and Re-enable parts carry no reason.
On the mock, Deprovision moves an ACTIVE and a DISABLED device to `DEPROVISIONED`, and each device answers the reason.
A second Deprovision and a Re-enable of such a device answer `status-conflict`. Wipe user data and Powerwash issue and poll (pattern `gc/admin-sdk-mock.test.mjs:280`).

**B3.** Scope: section 5, the `cc.write_capable` mapping of section 2, and the deadline writes of section 4.
Acceptance in `deployment:postgres-integration`: a Deprovision preview without a reason, or with a fifth value, raises 22023. A Disable preview with a reason raises 22023.
A Powerwash preview becomes a `CMD-` job with no requested value. A Deprovision preview becomes an `STS-` job with `DEPROVISIONED`.
A Wipe user data confirm without `WIPE` answers `phrase-mismatch` and creates no job. The manifest and the batch claim carry the reason.
A person without `devices:wipe` receives `forbidden` for a Powerwash preview. A succeeded Deprovision settlement publishes `DEPROVISIONED` with an overlay.
Both deadline rules of section 4 hold for Powerwash and for Reboot.

**B4.** Scope: the job detail and operation contracts of section 1, the action filter, and Reconcile.
Files: `ac/devices.ts`, `ac/jobs.ts`, `api/jobs/jobs.ts`, and `api/devices/device-updates-actions.ts:70-105`.
Acceptance in `api:test` and `deployment:postgres-integration`: a seeded Powerwash job answers `powerwash-devices` and `REMOTE_POWERWASH`.
A seeded Deprovision job answers `deprovision` and its reason. The filter `reboot-devices` excludes a Powerwash job.
Reconcile of a Wipe user data operation answers 409 `reconcile-unsupported`. Reconcile of a Deprovision operation answers 403 without `devices:deprovision`, and 202 with it.

**B5.** Scope: section 4 in `worker/src/device-update.ts`, with tests in `worker/src` and `api-e2e/device-write-mock.mjs`.
Acceptance in `worker:test`: the issue body carries `WIPE_USERS` or `REMOTE_POWERWASH` without a payload. `CANCELLED` fails Reboot and Powerwash with `command-cancelled`.
A Deprovision job on the in-process mock settles ACTIVE and DISABLED targets `succeeded`. A deprovisioned target fails with `status-conflict`.
Acceptance in `api-e2e:admin-sdk-mock-integration`, after the pattern of `api-e2e/device-write-mock.mjs:432-700`:

- A hang on a Powerwash issue ends at a `remaining` of 1. The mock holds one `REMOTE_POWERWASH` command. The job ends `needs-review`.
- A hang on a Deprovision part ends with a read-back `succeeded`. The mock device holds the reason of the job.
- At scale 60, an online Wipe user data succeeds. With a `commandExpirySeconds` of 120, an offline Powerwash ends `expired`.

**B6.** Scope: the preview and confirm contracts of section 1, the route checks of section 2, and section 3.
Files: `ac/device-actions.ts`, `api/devices/device-actions*.ts`, `api/devices/device-updates-actions.ts:7-52`, and `api/devices/device-updates.ts:271-297`.
B6 keeps the client compiling. It edits `fe/devices/device-action-flow.ts:36-44` and the exhaustive `DeviceAction` switches of `fe/devices/device-action-messages.ts`.
The sheets keep the options of the first build (`fe/devices/device-action-messages.ts:25-30`).
Acceptance in `api:test` and `deployment:postgres-integration`: a person with only `devices:commands` previews Reboot and receives 403 for Powerwash.
A person with only `devices:status` receives 403 for Deprovision. A Deprovision preview without a reason answers 400.
A Powerwash preview of ACTIVE, DISABLED, and DEPROVISIONED devices lists two exclusion reasons. Confirm with `" DEPROVISION "` creates a job.
`WIPE` on a Powerwash preview answers 422 `phrase-mismatch` and stores no manifest. `frontend:build` and `frontend:test` pass.

**F1.** Scope: D1, D2, and D7 to D10 in the Send command and Change status sheets (`record:92-101`). F1 closes record design gaps 1 to 4 and 7 (`record:137-143`).
Choose collects the reason, and a changed reason requires a new preview (D12). The confirmation store replays `typedPhrase` with the digest (`fe/devices/device-action-confirmation.store.ts:19`).
Acceptance: completion steps 1 to 4 (`record:180-183`) pass in `frontend:test` and `frontend-e2e:e2e` (Chromium) with mocked answers.

**F2.** Scope: the job titles of D3, the command rows, the reason (`106:203`, `106:248`), `command-cancelled`, and `not-observed` with Google's expiry.
F2 hides Reconcile for every command (`fe/jobs/job-detail-fields.ts:167-170`). Deprovision Reconcile names `devices:deprovision` (`fe/jobs/job-detail-fields.ts:237-248`).
The Jobs filter lists the three job actions (`fe/jobs/job-fields.ts:68-74`).
Acceptance in `frontend:test` and `frontend-e2e:e2e`: a mocked Powerwash job shows each state of `record:39-41`. A Deprovision job shows its reason.

**Q1.** Acceptance: each step of `record:178-184` passes on admin-sdk-mock, with screenshots. Lint, tests, and builds of the affected projects pass.
Step 5 loses an issue answer with the hang of section 7. A `remove-entity` fault hides one target, so Google refuses that device alone (`mock:directory/device-writes.js:144-151`).
Live device writes stay unverified (`record:174`).

**Shared files.** Each shared file sits on one dependency path, so no two parallel cards edit one file.

| File                                                                      | Cards, in merge order                  |
| ------------------------------------------------------------------------- | -------------------------------------- |
| `deployment/postgres/migrations/017-jobs.sql`                             | B1 (`:4-6`), then B3                   |
| `deployment/postgres/device-actions.integration.mjs`                      | B3, then B6                            |
| `api/src/app/devices/device-updates-actions.ts`                           | B4 (Reconcile), then B6 (route checks) |
| `frontend/src/app/jobs/*.spec.ts`, `frontend-e2e/src/job-detail*.spec.ts` | B4, then F2                            |
| `frontend/src/app/devices/device-action-*.ts` and their specs             | B4, then B6, then F1                   |
| `frontend-e2e/src/device-action-sheets.spec.ts`                           | B4, then B6, then F1                   |
