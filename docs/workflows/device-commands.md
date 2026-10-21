# Reboot, disable, or re-enable selected devices

Status: owner-confirmed on 2026-10-21. The owner chose the answer "Confirmed: build it as written".
Source: owner decisions of 2026-10-21, quoted under [Owner decisions](#owner-decisions--2026-10-21).
Design: [Figma page 09](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=94-2), with the node links under [Design](#design), plus the owner-approved composition. Design gaps remain.
Replaces: none.

## User and outcome

The existing administrator reboots, disables, or re-enables selected ChromeOS devices.
The administrator selects devices in the Devices grid and opens one action from Bulk Actions.
A side sheet shows the exact targets, records the confirmation, and shows a receipt.
The action runs as a background job. The Jobs page and the job detail show each device's state and result.
Reboot interrupts active sessions. Disable blocks user access and keeps enrollment. Re-enable restores access.

## Interaction

Bulk Actions holds two entries: Send command and Change status (`216:4309`, GRID-01, `docs/ui/patterns.md:19-20`).
The menu shows only built items. Wipe, Powerwash, and Deprovision stay out.
Each entry opens the side sheet over the grid.
Send command offers Reboot only (`106:156`). Change status offers Disable and Re-enable (`105:234`).
Without the device write scope or the permissions, both entries stay disabled and name the reason.

The Review step shows a frozen preview with its preview ID and expiry.
It lists the eligible targets and each excluded device with its reason (DEVICE-01, `docs/ui/patterns.md:209`).
Reboot and Disable need an ACTIVE device. Re-enable needs a DISABLED device.
The consequence text comes from `111:442` for Reboot and `114:503` for Disable.

The Confirm step collects the explicit confirmation.
Reboot requires the checkbox "I understand that restarting these devices interrupts users." (`111:442`).
Disable uses the filled destructive button "Disable N devices" as its confirmation (`114:503`, UI-05, `docs/ui/rules.md:68`).
Re-enable uses an explicit confirmation button.
The sheet blocks submission until the required confirmation passes validation.

When no target qualifies, the sheet shows the no-eligible state (`111:397`).
That state differs from a submission error. No job starts.

The receipt reads "Your job is saved" and offers View job and Done, as step 4 does.
The receipt claims no Google acceptance. The job detail shows per-device acceptance.
`116:479` claims acceptance at the receipt, and the receipt rule governs that claim.

The Jobs page and the job detail show a state for each device.
The states are pending delivery, acknowledged, succeeded, failed with Google's reason, expired, and unknown.
DEVICE-02 (`docs/ui/patterns.md:214-219`) defines these states. Nodes `104:657`, `116:524`, `111:352`, and `99:73` show them.
The activity area lists the job.

An optional Status column and a status filter show Active, Disabled, and Deprovisioned.
Disable and Re-enable results update the column in place.

## Data and access

| Data           | Google source                                            | Scope suffix                      |
| -------------- | -------------------------------------------------------- | --------------------------------- |
| Device command | Directory API `devices/chromeos/{deviceId}:issueCommand` | `admin.directory.device.chromeos` |
| Device status  | Directory API `devices/chromeos:batchChangeStatus`       | `admin.directory.device.chromeos` |

All scopes use the `https://www.googleapis.com/auth/` prefix.
Setup already lists the device write scope (step 4 decision D2). The write-access check and its note apply unchanged.
Google accepts 1 to 50 devices per status change and answers per device. A command takes one device per call.
Each action requires the device write scope, Device Bulk Actions, and its action-specific permission.
Evidence is admin-sdk-mock v0.2.0 only. `mock:` names the installed admin-sdk-mock package.
Sources: `mock:package.json:3`, `mock:dist/src/routes.js:66-67`, `mock:dist/src/auth/scopes.js:45-46`, `mock:dist/src/directory/device-writes.js:8, 18-26, 171-175`.
Live Google device writes need their own owner test authorization ([current work](../current-work.md#authorized-now)).

## Owner decisions — 2026-10-21

Clarify form of 2026-10-21. The owner chose both answers.

**D1, first step 5 build.** Question: "What should step 5 build first?"
The owner chose the answer "Device commands (Reboot, Disable, Wipe, and others)".

**D2, first commands.** Question: "If device commands come first: which commands go in the first build?"
The owner chose the answer "Reboot, Disable, Re-enable first; Wipe, Powerwash, Deprovision next".

Earlier owner decisions govern this record. The record cites them and does not restate them as new decisions.

- The bulk action side sheet keeps the user in the grid. Owner, PR #66: "I dont want to take the user from the context of the grid."
- Refresh and Bulk Actions follow the Material 3 dropdown button spec. Owner, PR #63: "Follow the material spec for these buttons."
- The access model allows action-specific permissions. `docs/workflows/platform-access.md:659`: "Define additional permissions as their workflows require them."
- Bulk Actions controls the menu, and further permissions enable its entries. `docs/workflows/platform-access.md:668`: "Yes. Bulk actions gives access to the Bulk Actions menu dropdown button. Further permissions show which features are enabled in that dropdown."

## Implementation defaults — 2026-10-21

These defaults are engineering choices, not owner decisions. Change them when the owner asks.
Each item names its sources. The owner confirmed these choices with this record on 2026-10-21.

1. Permissions: two new permissions, "Send device commands" and "Change device status". Each also requires Device Bulk Actions. Only the Platform Admin role holds them, so no other role gains authority. Deprovision gets its own permission, "Device Deprovision", when it is built. Sources: `docs/workflows/platform-access.md:643, 659, 668`, `docs/workflow-gaps.md` row G15.
2. Job IDs: `CMD-` for command jobs and `STS-` for status change jobs. Figma uses CMD-, REB-, DIS-, and STATUS- (design gap 11).
3. A command job issues its commands under the customer's single write slot, then releases the slot. Each operation stays pending until Google reports a result or the command expires. The expiry is the one Google returns. The admin-sdk-mock default is 5 days.
4. A Reboot whose issuance answer is lost stays Unknown. The job ends as Needs review. No Reconcile and no automatic repeat. Sources: `docs/portfolio/03-architecture.md:254`, `docs/reviews/2026-09-04-technical-change-instructions.md:324`.
5. Reboot sends no user-session delay.
6. Sheet step labels: Choose, Review, Confirm.
7. The Status column is optional and hidden by default, like the Annotated location column. The [device browsing record](device-browsing.md) keeps its default columns.
8. Re-enable copy: an active device reads "already active", not "already enabled". `2026-10-21-device-commands-07-reenable-no-eligible.png` keeps the Figma copy "already enabled". This default governs. Source: eng-lead wording default, 2026-10-21.

## Design

Figma page 09 (`94:2`) holds these frames in the file `lqZx6qpWevsN3AAfWkworl`.
Inspected on 2026-10-21 through the eng-lead notes and the exported PNGs.
The 2026-10-20 side-sheet decision governs every composition. The frames supply content and copy only.
The approved mockup `docs/ui/designs/2026-10-20-bulk-action-sheet.html` supplies the sheet composition.
On 2026-10-21 the owner approved the step 5 screens: "That looks good".
The owner-approved composition is the [mockup HTML](../ui/designs/2026-10-21-device-commands.html) and its ten state PNGs.
The PNGs run from [01-bulk-actions-menu](../ui/designs/2026-10-21-device-commands-01-bulk-actions-menu.png) to [10-status-column-filter](../ui/designs/2026-10-21-device-commands-10-status-column-filter.png).
The [mockup notes](../ui/designs/2026-10-21-device-commands-notes.md) list every state, its background, and each copy source.
Job pages stay pages.

| Node                                                                                                | Frame name                         | Use                                                         |
| --------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| [`216:4309`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=216-4309) | Reference / Bulk Actions menu open | Entry point: Send command and Change status in Bulk Actions |
| [`106:156`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=106-156)   | State / command-choice             | Choose step for Send command: targets and Reboot            |
| [`105:234`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=105-234)   | State / status-choice              | Choose step for Change status: Disable and Re-enable        |
| [`111:442`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=111-442)   | Screen / Devices / reboot          | Reboot consequence text and acknowledgment                  |
| [`114:503`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=114-503)   | Screen / Devices / disable         | Disable consequence text and filled confirmation            |
| [`111:397`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=111-397)   | State / reenable-none              | No-eligible state for Re-enable                             |
| [`116:479`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=116-479)   | State / reboot-receipt             | Acceptance claim that the receipt rule overrides            |
| [`104:657`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=104-657)   | State / command-running            | Pending and acknowledged states in the job detail           |
| [`116:524`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=116-524)   | State / reboot-result              | Command result in the job detail                            |
| [`111:352`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=111-352)   | State / command-expired            | Expired state in the job detail                             |
| [`99:73`](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=99-73)       | Screen / Jobs / Detail / CMD-0021  | Job detail operations grid for command rows                 |

Design gaps:

1. No command or status sheet. Every frame is a full page. The side-sheet mockup supplies the composition, and command step labels have no design.
2. No frozen command preview. No frame shows a preview ID, preparation time, expiry, or stale warning.
3. No per-device exclusion reasons. `106:156` reports a count only.
4. No Re-enable review with eligible disabled targets. Only the no-eligible state `111:397` exists.
5. No partial status-change results. `116:434` and `106:248` show full success only.
6. No Reboot or Disable job detail. Command state has no designed place in the operations grid.
7. No pending command rows or waiting job status inside the job detail. `104:657` is a standalone page.
8. No uncertain command issuance frame. Only the update variant `104:254` exists.
9. No Status column or status filter in the device grid (`216:4309`). The approved mockup of 2026-10-21, state 10, supplies the column position and the filter chip.
10. No activity-area entries for command jobs. The approved mockup is the design source.
11. No single job ID scheme. Figma uses CMD-, REB-, DIS-, and STATUS-.

## Exclusions and open decisions

Excluded from this build:

- Wipe user data, Powerwash, and Deprovision. The next build covers them.
- Other command types.
- Scheduling, result downloads, and CSV.
- Live Google device writes.

Open decisions:

- The owner confirmed the defaults of 2026-10-21 on the same day.
- Eligibility, reasons, expiry, and provider lifecycle need Google capability evidence before release (DEVICE-01).
- Each design gap needs a composition before its screen is built.
- Wipe, Powerwash, and Deprovision need their own record.

## Completion

Demonstrate on admin-sdk-mock:

1. Without the device write scope, Send command and Change status are disabled and name the scope. A grant enables them.
2. Reboot: select devices that include a disabled and a deprovisioned device. The Review step lists the eligible targets and each excluded device with its reason. After Confirm, the job shows each device's command state until Google reports a result.
3. Disable: select active devices plus one disabled device. After Confirm, the job shows per-device results, and the Status column shows Disabled without a reload.
4. Re-enable: a selection of active devices only shows "No devices can be re-enabled" and starts no job. A selection of disabled devices re-enables them, and the Status column shows Active.
5. Failure: a per-device Google refusal shows Failed with its reason. A lost issuance answer shows Unknown, and the job ends as Needs review.
6. A person without the new permissions sees both menu items disabled with a permission note.
