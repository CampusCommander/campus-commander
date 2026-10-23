# Wipe user data, Powerwash, or Deprovision selected devices

Status: owner-confirmed on 2026-10-23. Owner, in the main chat: "1", which chose the option "Confirmed: build it as written".
Source: owner decisions of 2026-10-21 and the first build sign-off of 2026-10-22, quoted under [Owner direction](#owner-direction--2026-10-21).
Design: [Figma page 09](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=94-2), with the frame table under [Design](#design). Design gaps remain.
Replaces: none.

## User and outcome

The existing administrator wipes user data, powerwashes, or deprovisions selected ChromeOS devices.
The administrator selects devices in the Devices grid and opens Send command or Change status from Bulk Actions.
The side sheet shows the targets, collects the confirmation, and shows a receipt.
The action runs as a background job. The job detail shows each device's state and result.
Wipe user data removes local user profiles and keeps device policy and enrollment.
Powerwash returns the device to a factory state and removes enrollment unless forced or automatic enrollment applies.
Deprovision removes the device from active management, and no API call reverses it.

## Interaction

Bulk Actions keeps two entries: Send command and Change status (`216:4309`).
Send command offers Reboot, Wipe user data, and Powerwash (`106:156`). Change status offers Disable, Re-enable, and Deprovision (`105:234`).
The menu shows no new entry.
An option without its permission stays visible and disabled with a permission note (GRID-06, `docs/ui/patterns.md:61-67`).

The Choose step lists the eligible targets and each excluded device with its reason (DEVICE-01, `docs/ui/patterns.md:209`).
Wipe user data and Powerwash need an ACTIVE device. Deprovision needs an ACTIVE or DISABLED device.
Choose collects the Deprovision reason, so the frozen preview and its digest bind it (D12).
Review shows the preview, its ID, and its expiry. It notes that an offline device runs the command when it next connects, until Google's expiry [11].

Confirm collects the typed phrase and the acknowledgment.
Wipe user data requires WIPE and the box "I understand that all local user profile data will be removed." (`111:497`).
Powerwash requires POWERWASH and the box "I understand the data loss and enrollment consequences." (`97:129`).
Deprovision requires DEPROVISION and no box (`97:93`).
The filled destructive button names the action and the count.
The sheet blocks submission until the phrase and the box pass validation (`docs/ui/patterns.md:211`).

When no target qualifies, the sheet shows the no-eligible state and starts no job.
The receipt claims no Google acceptance (`docs/workflows/device-commands.md:38-40`).
The job detail shows each state, each result, and the Deprovision reason (`106:203`, `106:248`).
The Status column shows Deprovisioned without a reload.
A command without a result after the watch window settles Unknown with reason `not-observed`, and the job ends Needs review.

## Data and access

| Data                      | Google source                                            | Scope suffix                      |
| ------------------------- | -------------------------------------------------------- | --------------------------------- |
| Wipe user data, Powerwash | Directory API `devices/chromeos/{deviceId}:issueCommand` | `admin.directory.device.chromeos` |
| Deprovision               | Directory API `devices/chromeos:batchChangeStatus`       | `admin.directory.device.chromeos` |

All scopes use the `https://www.googleapis.com/auth/` prefix.
A command call targets one device [1]. A status change takes 1 to 50 device IDs and answers per device [3].

| Action                    | Bulk Actions entry | Permissions at district scope                                 |
| ------------------------- | ------------------ | ------------------------------------------------------------- |
| Wipe user data, Powerwash | Send command       | `devices:read`, `devices:bulk-actions`, `devices:wipe`        |
| Deprovision               | Change status      | `devices:read`, `devices:bulk-actions`, `devices:deprovision` |

Reboot keeps `devices:read`, `devices:bulk-actions`, and `devices:commands`.
Only the platform administrator preset holds the new actions (`libs/application-contracts/src/lib/authorization.ts:108`).
Device Deprovision includes Device Read (`docs/workflows/platform-access.md:695`).

Google refuses an ineligible device per device, and the row shows Failed with Google's reason.
A lost issue answer shows Unknown, and the job ends Needs review.
A `CANCELLED` command settles Failed (D14). An expired command shows Expired.
Evidence is admin-sdk-mock v0.2.0 only.
Live Google device writes stay unverified, because the test domain has no ChromeOS device (`docs/current-work.md:82`).

## Owner direction — 2026-10-21

From `docs/current-work.md` (2026-10-21):

- Question "What should step 5 build first?" The owner chose the answer "Device commands (Reboot, Disable, Wipe, and others)" (`docs/current-work.md:12`).
- Question "If device commands come first: which commands go in the first build?" The owner chose the answer "Reboot, Disable, Re-enable first; Wipe, Powerwash, Deprovision next" (`docs/current-work.md:13`).

From `docs/workflows/device-commands.md:150`: "Wipe, Powerwash, and Deprovision need their own record."

The owner signed off the first build on 2026-10-22 ("Signed off as built", `docs/current-work.md:8`). This record covers the next build.

The owner chose "That looks good" for the step 5 screens on 2026-10-21 (`docs/current-work.md:62`). That answer covers the first build's screens only. It says nothing about this record or this build.
The owner confirmed this record on 2026-10-23, before any design or implementation.

## Implementation defaults — 2026-10-22

These defaults are engineering choices for owner review, not owner decisions. Change them when the owner asks. Each item names its sources.

**Ruling 1 of 3: the permission for Wipe user data and Powerwash (default, changeable).** The record uses one new permission, "Wipe and Powerwash devices" (`devices:wipe`), plus Device Bulk Actions. Reboot keeps "Send device commands". Deprovision uses its own permission, "Device Deprovision". The access rule is "Define additional permissions as their workflows require them." (`docs/workflows/platform-access.md:659`).

**Ruling 2 of 3: the watch window (default, changeable).** Watch each Wipe user data or Powerwash command until its expiry plus 24 hours, or 30 days after issue, whichever comes first. A command without a result then settles Unknown with reason `not-observed`, and the job ends Needs review. Reboot keeps its signed-off rule. The first build already polls each command until its expiry plus 24 hours (`deployment/postgres/migrations/017-jobs.sql:1998-1999`).

**Ruling 3 of 3: the typed confirmation for Deprovision (default, changeable).** Deprovision requires typing DEPROVISION, as Figma `97:93` shows. A later docs card adds typed confirmation to DEVICE-01 (`docs/ui/patterns.md:207`) after the owner answers this record. This record does not edit that file.

1. D1 Placement: Wipe user data and Powerwash join Send command after Reboot. Deprovision joins Change status after Re-enable. No new menu entry (`216:4309`, `docs/superpowers/specs/2026-10-21-device-command-jobs-design.md:36`).
2. D2 Entry state: Send command enables with any command permission. Change status enables with `devices:status` or `devices:deprovision`. A disallowed option stays visible, disabled, with a note (GRID-06, `docs/ui/patterns.md:61-67`).
3. D3 Names: Wipe user data, Powerwash, and Deprovision (`docs/ui/patterns.md:203-207`). Job titles: "Wipe user data", "Powerwash devices" (`99:73`), and "Deprovision devices".
4. D4 Job IDs: `CMD-` for Wipe user data and Powerwash. `STS-` for Deprovision (`docs/workflows/device-commands.md:88`). Figma's `WIP-` and `STATUS-` stay unused.
5. D5 Eligibility: Wipe user data and Powerwash need ACTIVE, as Reboot does. Deprovision needs ACTIVE or DISABLED [8]. Every action excludes `device-deprovisioned` and `status-unknown`, and keeps `removed` and `invalid-device-id` (`api/src/app/devices/device-actions.ts:69-83, 104-110`).
6. D6 Payload: none for either command [1].
7. D7 Typed phrases: WIPE (`111:497`) and POWERWASH (`97:129`), as DEVICE-01 requires (`docs/ui/patterns.md:210`). DEPROVISION follows ruling 3. The phrase matches after trimming spaces, and the API checks it (`docs/ui/patterns.md:211`).
8. D8 Acknowledgment: Wipe user data carries "I understand that all local user profile data will be removed." (`111:497`). Powerwash carries "I understand the data loss and enrollment consequences." (`97:129`). Deprovision carries none (`97:93`).
9. D9 Final buttons: filled destructive (UI-05, `docs/ui/rules.md:68`): "Send Wipe to N devices", "Send Powerwash to N devices", "Deprovision N devices".
10. D10 Consequence copy: the Figma sentences of `111:497`, `97:129`, and `97:93`. Drafted addition for owner review: "Deprovision does not erase local data. Send Powerwash first to erase a device that leaves the district." The API has no reset option [3].
11. D11 Reasons: offer Google's four admin labels: Retiring from fleet, Different model replacement, Same model replacement, and ChromeOS Flex upgrade transfer [4][8]. Never send the other seven values. No preselected reason. One reason per job [8].
12. D12 Reason placement: Choose collects the reason, so the frozen preview and its digest bind it (`docs/portfolio/02-domain-model.md:85`). The job stores the reason, and the receipt and job detail show it (`106:203`, `106:248`).
13. D13 Retries: issueCommand keeps 0 quota and 0 transient retries (`docs/superpowers/specs/2026-10-21-device-command-jobs-design.md:137`). A lost issue answer settles Unknown, with no automatic repeat and no Reconcile (`docs/workflows/device-commands.md:90`). Deprovision keeps the status retries, read-back, and Reconcile (`docs/superpowers/specs/2026-10-21-device-command-jobs-design.md:215-217`).
14. D14 Google states: `IGNORED` and `FAILURE` settle Failed with `command-failed`. `STATE_UNSPECIFIED` and other values stay Unknown with `unrecognized-state` (`docs/superpowers/specs/2026-10-21-device-command-jobs-design.md:195-199`). Default D14 changes the first build: a Google `CANCELLED` result settles Failed with `command-cancelled` for every command, Reboot included. The first build settles `CANCELLED` as Unknown today (`worker/src/device-update.ts:993-997`).
15. D15 Cache: a succeeded Deprovision writes `status` `DEPROVISIONED` through the step 4 overlay, and the Status column updates in place (`docs/superpowers/specs/2026-10-21-device-command-jobs-design.md:218-224`). The two commands change no cached field.
16. D16 Offline devices: they stay eligible. Review notes that an offline device runs the command when it next connects [11].
17. D17 Target count: no new cap. The 100,000-device selection cap stays (`api/src/app/devices/device-actions.ts:39`). Review, Confirm, and the final button show the count.
18. D18 No factory reset with Deprovision. The API has no such option [3]. Send Powerwash first for both.
19. D19 No second approver. The 2026-09-04 instructions propose one for "mass powerwash" (`docs/reviews/2026-09-04-technical-change-instructions.md:242`), and G24 leaves approval policy unresolved (`docs/workflow-gaps.md:82`). The product has one administrator today.
20. D20 Tests run on admin-sdk-mock only. Live device writes stay excluded (`docs/current-work.md:20`, `docs/workflows/device-commands.md:143`).

## Design

Figma page 09 (`94:2`) holds these frames in the file `lqZx6qpWevsN3AAfWkworl`. Inspection on 2026-10-22 used `figma-notes.md` and the exported PNGs.
The step 5 side sheet supplies the composition (`docs/ui/designs/2026-10-21-device-commands.html`). The frames supply content and copy only. Job pages stay pages.

| Node                                                                                                | Frame name                         | Use                                                                  |
| --------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| [`216:4309`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=216-4309) | Reference / Bulk Actions menu open | Entry point. No new menu entry.                                      |
| [`106:156`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=106-156)   | State / command-choice             | Send command choice with Wipe user data and Powerwash.               |
| [`105:234`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=105-234)   | State / status-choice              | Change status choice with Deprovision.                               |
| [`111:497`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=111-497)   | Screen / Devices / wipe            | Wipe consequence, WIPE phrase, acknowledgment, and final button.     |
| [`97:129`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=97-129)     | Screen / Devices / command         | Powerwash consequence, POWERWASH phrase, acknowledgment, and button. |
| [`114:555`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=114-555)   | Screen / Devices / command-locked  | Locked Send state for Powerwash.                                     |
| [`97:93`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=97-93)       | Screen / Devices / status          | Deprovision reason, DEPROVISION phrase, and final button.            |
| [`116:569`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=116-569)   | State / wipe-receipt               | Wipe receipt.                                                        |
| [`116:614`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=116-614)   | State / wipe-result                | Wipe result copy.                                                    |
| [`104:657`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=104-657)   | State / command-running            | Pending and acknowledged states.                                     |
| [`111:352`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=111-352)   | State / command-expired            | Expired copy.                                                        |
| [`99:73`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=99-73)       | Screen / Jobs / Detail / CMD-0021  | Job title and command rows.                                          |
| [`106:203`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=106-203)   | State / status-receipt             | Job records the reason.                                              |
| [`106:248`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=106-248)   | State / status-result              | Job detail shows the reason.                                         |

Design gaps:

1. No sheet composition for the three actions. The step 5 sheet has no typed field and no reason select. A mockup for the owner to review comes after the owner answers this record and before the build.
2. No reason options. `97:93` shows one value, "Retired / End of life", which is not a Google label. Google offers four admin reasons.
3. No place for the reason in the frozen preview. `97:93` puts it on the confirmation page, and the domain model surfaces it in the preview (`docs/portfolio/02-domain-model.md:85`).
4. No per-device exclusion reasons (`106:156` reports a count), no partial or failed Deprovision result (`106:248` shows full success), and no pending Wipe user data state beyond `116:569` and `116:614`.
5. No state for a command pending for months. The watch window of ruling 2 decides what the job shows.
6. No Powerwash enrollment frame per organization unit or for ChromeOS Flex devices.
7. No frame offers a factory reset with Deprovision, and none says Deprovision keeps local data. This build excludes factory reset (D18). Figma job IDs are WIP-, CMD-, and STATUS-. Default D4 keeps CMD- and STS-.

## Exclusions and open decisions

Excluded from this build:

- Other command types: `TAKE_A_SCREENSHOT`, `SET_VOLUME`, `DEVICE_START_CRD_SESSION`, `CAPTURE_LOGS`, `FETCH_CRD_AVAILABILITY_INFO`, and `FETCH_SUPPORT_PACKET` [2].
- Factory reset with Deprovision or Disable [8].
- Re-enrollment of a deprovisioned or powerwashed device. That work is hands-on [8].
- Cancel of a pending command. The API offers none [7][2].
- Reboot delay payloads, scheduling, result downloads, and CSV.
- Pre-provisioned device actions and the `DELINQUENT` status.
- A second approver (G24).
- Live Google device writes.

Open decisions:

- The owner confirmed the three rulings and defaults D1 to D20 with this record on 2026-10-23.
- Default D10 adds one drafted consequence sentence. The owner reviews it with the record.
- Each design gap needs a composition before its screen is built. A mockup comes before the build.
- The DEVICE-01 row needs a later docs card for typed confirmation.
- Live device writes need an enrolled Chromebook, an upgrade license, physical access, and explicit owner authorization.

## Risks

1. Irreversible data loss. Wipe user data and Powerwash delete local data that Chrome Sync does not hold [9]. Google calls Powerwash irreversible [2]. Neither has an undo.
2. Commands stay armed. Google keeps a pending Wipe user data valid up to 180 days and a pending Powerwash up to 5 years [11]. No API cancels them [7][2]. A device from storage still runs them, and later commands queue behind them [11].
3. Enrollment after Powerwash depends on forced re-enrollment settings that Campus Commander does not read [10][11]. From ChromeOS 131, ChromeOS Flex devices always re-enroll with a username and password [10].
4. Deprovision is one-way and keeps local data. Recovery needs a hands-on wipe, manual enrollment, and an available upgrade [8][5][6]. A wrong reason changes license handling, and Google audits it [5]. A retired device keeps its user data unless Powerwash runs first [3][8].
5. Blast radius. One job targets up to 100,000 devices (`api/src/app/devices/device-actions.ts:39`). The typed phrase and the count in the button are the main guards. No second approver exists (G24).
6. A lost answer invites a repeat. An accepted Powerwash with a lost answer shows Unknown. A second request queues a second Powerwash (`docs/workflows/device-commands.md:90`). The mock also departs from Google: Powerwash keeps enrollment, every command expires in 5 days, deprecated reasons pass, and `CANCELLED` and `IGNORED` never occur. Green tests do not prove Google behavior.
7. Live device writes stay unverified. The test domain has no ChromeOS device (`docs/current-work.md:82`). The standing authorization excludes Google mutations (`AGENTS.md:48`, `docs/portfolio/phase-3-google-credentials.md:26`). A live test needs an enrolled Chromebook that the owner accepts losing. It also needs a license, physical access, and his explicit authorization. Deprovisioning the only bundled device, with no other upgrade, removes settings and managed devices after 90 days [8]. No source states how a powerwashed device reports its result, so the live test answers that too.

## Completion

Demonstrate on admin-sdk-mock:

1. Send command offers Reboot, Wipe user data, and Powerwash. Change status offers Disable, Re-enable, and Deprovision. A person without the new permissions sees those options disabled with a permission note.
2. Wipe user data: select active, disabled, and deprovisioned devices. Review lists each excluded device with its reason. Send stays disabled until the person checks the box and types WIPE. The job shows each command state until a result arrives.
3. Powerwash: the same flow with POWERWASH. Typing WIPE keeps Send disabled.
4. Deprovision: Review stays unavailable until the person chooses a reason. Active and disabled devices qualify, and Review excludes deprovisioned devices. The job shows per-device results and the reason. The Status column shows Deprovisioned without a reload.
5. Failures: a per-device refusal shows Failed with Google's reason. A lost issue answer shows Unknown, and the job ends Needs review. An offline device under a short `commandExpirySeconds` shows Expired.

## Sources

[1] https://developers.google.com/workspace/admin/directory/reference/rest/v1/customer.devices.chromeos/issueCommand
[2] https://developers.google.com/workspace/admin/directory/reference/rest/v1/customer.devices.chromeos.commands
[3] https://developers.google.com/workspace/admin/directory/reference/rest/v1/customer.devices.chromeos/batchChangeStatus
[4] https://developers.google.com/workspace/admin/directory/reference/rest/v1/chromeosdevices
[5] https://developers.google.com/workspace/admin/directory/reference/rest/v1/chromeosdevices/action
[6] https://developers.google.com/workspace/admin/directory/v1/guides/manage-chrome-devices
[7] https://developers.google.com/workspace/admin/directory/reference/rest/v1/customer.devices.chromeos
[8] https://support.google.com/chrome/a/answer/3523633?hl=en
[9] https://support.google.com/chrome/a/answer/1360642?hl=en
[10] https://support.google.com/chrome/a/answer/6352858?hl=en
[11] https://support.google.com/chrome/a/answer/1698333?hl=en
