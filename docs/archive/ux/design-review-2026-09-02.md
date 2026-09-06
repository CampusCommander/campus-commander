# Campus Commander — Full Design Review and Improvement Plan

**Status:** WORKLIST — findings plus a formal, agent-executable work list. Section 3 carries the contract for the executing UI/UX agent.
**Date:** 2026-09-02
**Scope:** All 68 boards on the page `Users — Grid Page` in the retired `Campus Commander` prototype. Each board was exported and inspected visually.
**Sources of truth used as the critique baseline:**

- `docs/superpowers/specs/2026-07-07-core-entity-management-design.md` (spec 1)
- `docs/ux/ui-design-guide.md` (design guide)
- `docs/ux/prototype-map.md` (prototype map)

**Verdict up front.** The draft is strong on structure and on the safety chain. The shell, grid anatomy, safety dialogs, jobs model, and setup wizard all match the product intent. The draft fails in three areas. First, several screens show data or copy that contradicts the spec or the Google API surface. Second, the layout system is inconsistent: grid cards do not fill the viewport, scrims differ per dialog, and the same control (density) lives in three places. Third, the safety chain is uneven: some bulk actions get a preview, others skip it. The plan below fixes these in four phases.

---

## 1. Systemic findings

These findings apply to more than one screen. They come first because they shape every screen fix.

### P0 — Spec and API truth violations

| # | Finding | Screens | Why it matters |
|---|---|---|---|
| S1 | The UI promises Undo. The Confirm dialog says "You can undo this from the Jobs page". The post-run snackbar offers an Undo action. Spec 1 marks undo/rollback as a stretch goal, not v1. | Confirm suspend, Undo snackbar | The core safety promise must not advertise a capability the backend does not ship. Either cut the promise or promote undo to v1 as a spec change. |
| S2 | Groups show a "Type: Dynamic / Static" column and the Create group dialog offers a "Dynamic" membership option. Spec 1 explicitly excludes Cloud Identity dynamic groups. The Admin SDK Directory API `Groups` resource has no such field. | Groups grid, Create group | The prototype models a concept that does not exist in the data source. Replace with real Group Settings fields (join, post, moderation). |
| S3 | Groups grid shows an "Owning OU" column and the Org Units page shows a "12 Groups" stat card. Google Groups do not live in org units. The `Groups` resource has no `orgUnitPath`. | Groups grid, Org Units tree | Same class of error as S2. Remove or re-source these numbers. |
| S4 | The Jobs list shows `cache_sync — Incremental sync`. Spec 1 states v1 runs full sweeps only, with no delta path. | Jobs list | Copy contradicts the sync architecture. Change to "Full sweep". |
| S5 | Three screens describe a job as "Push firmware policy to 614 devices". Firmware policy push is not in the device writable surface or the v1 command set. | Jobs list, Job detail (running), Command palette | Sample copy invents an out-of-scope operation. Use a real operation such as "Move to OU" or "Annotate asset tags". |
| S6 | The device command menu lists Lock device, Unlock device, and Sign out. These are not v1 remote commands. The menu omits Disable, Re-enable, and Deprovision, which the spec includes through `BatchChangeChromeOsDeviceStatus`, and omits the bulk actions Annotate and Move to OU. | Devices command menu | The command surface is both over-scoped and under-scoped. Restructure per spec. |
| S7 | The reset password dialog and its toast say "Send reset email" and "Reset email sent". `changePasswordAtNextLogin` sends no email. The spec also pairs the reset with an optional `signOut`. | Reset password dialog, Reset sent toast | The label describes a mechanism that does not exist. Rename to "Force password reset at next sign-in" and add the optional "Sign out now" checkbox. |
| S8 | Settings shows "Cache sync · Last full sync 2h ago · every 15 min". The spec model is view-triggered refresh plus a nightly backstop, with per-entity-type thresholds (Users 1h, Devices 4h, Groups 1h, OrgUnits 12h) that admins tune. | Settings overview, Connection | Wrong cadence copy, and the configuration surface for thresholds and the nightly time is missing. |
| S9 | The setup wizard scope list shows three scopes. The five capability areas need OrgUnit and Telemetry scopes too. The stepper marks Domain-Wide Delegation complete at step 2 while step 3 asks the admin to paste the client ID into the DWD form. The Setup Waiting screen never mentions multi-party approval, which the spec requires. | Setup wizard, Setup waiting | An admin following this wizard grants too few scopes and then fails diagnosis. The step model also teaches the wrong order. |
| S10 | The create user form shows a domain suffix dropdown (`@district.org`). Spec 1 is single-domain per deployment. | Create user | A domain selector implies multi-domain support. Remove it or clarify alias-domain handling. |

### P1 — Cross-screen consistency

| # | Finding | Screens |
|---|---|---|
| C1 | Health state has no single source of truth. The Capability Failing screen shows a red banner while the footer dot stays green with "All systems connected". The Stale Data screen keeps a green footer and green status dot. The guide defines amber = partial and red = failing. | Capability failing, Stale data, all shells |
| C2 | Scrim opacity differs per dialog. Help and Replace Account sit on an opaque scrim that hides the app. Preview and Confirm use a light scrim. | Help dialog, Replace account, all other dialogs |
| C3 | Dialog title grammar is inconsistent. "Delete 12 archived users?" and "Powerwash 2 devices?" are questions. "Confirm suspend" and "Wipe 2 devices" are statements. | Multiple dialogs |
| C4 | Danger button style contradicts the guide. The Users side sheet uses a filled red "Suspend user". The guide says destructive actions use outlined red at rest and reserve the filled red button for the confirm step. The design system board even names the filled red master "Danger". | Users side sheet, Design system |
| C5 | Density control lives in three places: the Appearance dialog, the View options panel, and the Account menu row "Density: Compact". The guide lists the density toggle as an open item and says compact ships first. | Appearance, View options, Account menu |
| C6 | Internal architecture leaks into UI copy: "Saves through the same path as a single-row bulk action" and "Single-cell edits write through the same single-row API path". Users need outcomes, not pipeline vocabulary. | Users inline edit, Devices cell edit |
| C7 | The header subtitle and the grid status bar both show the count and freshness ("128,431 users · Synced 2h ago" twice on one screen). | All grid pages |
| C8 | The selection criteria text in the Select All Filtered banner omits the second active chip ("Suspended = Yes"). The banner must restate the full filter set. | Select all filtered |
| C9 | The demo dataset contradicts the visible filters. Rows from Lincoln Middle and Roosevelt High appear under "School = Westside Elementary". Active and Archived users appear under "Suspended = Yes". Devices with OK and Replace Now batteries appear under "Battery = Replace Soon". The OU tree totals 15,842 entities while the Users header claims 128,431. | Many screens |
| C10 | The footer health dot and the per-page status bar freshness do not react to capability failures or stale data on the affected pages. | Capability failing, Stale data |

### P2 — Layout and visual system

| # | Finding | Screens |
|---|---|---|
| L1 | The grid card does not fill the viewport. Eight rows render, then a large empty band sits between the card and the footer. Empty and loading states use the same short card. The guide says dense data, airy chrome. It does not say leave half the page blank. | All grid pages and states |
| L2 | Toolbar actions are icon-only (import, columns, view options, export) with no visible tooltip affordance in the mock. Occasional tech helpers cannot learn these. | All grid pages |
| L3 | The loading state shows bare skeleton rows with no card chrome and no column headers, and repeats "Loading users…" in the header and under the rows. | Loading state |
| L4 | The empty state card is short and floats high. It should fill the same footprint as the loaded grid. The sign-in screen already shows a logomark (blue `account_balance` tile), but the guide still calls the logomark an open item. Reuse the logomark here and update the guide. | Empty state |
| L5 | The cover screen index renders body text in the disabled gray (`#9AA0A6`). It fails the contrast floor for meaningful text. The cover also omits `status-info` and shows no elevation or dark-accent contrast samples. | Cover |
| L6 | Small overflow bugs: the "copy" label clips on the setup wizard client ID field, a tooltip covers its own row label on the Connection page, a stray empty card sits below "Finish setup" on Settings overview, and a clipped item peeks from under the Users bulk menu. | Setup wizard, Connection, Settings overview, Bulk actions menu |
| L7 | Row height reads close to 36–38px, not the 32px compact the guide specifies. Page padding and card padding follow the guide. | All grid pages |

---

## 2. Screen-by-screen notes

Notes below cover what section 1 does not already capture. Boards with no extra notes met the baseline.

**00 — Cover.** Good token and layout summary. See L5. Add the demo-script pointer and the safety-chain diagram promise from the prototype map.

**App Shell — Users (light and dark).** Strong baseline. See L1, C7, P2-L7. Dark mode: the suspended chip pairs a red fill with dark red text at low contrast. Verify AA in the theming pass. The dark nav surface reads darker than `surface-app #121212`. The dark "Add filter" chip outline is faint.

**Users — Bulk Actions Menu.** The menu omits Archive/Unarchive and Force sign-out (spec bulk actions). A clipped row peeks below "Delete archived users". Menu items carry no one-line impact hints. The destructive item alone is red. Good plain-language labels.

**Users — Preview Dialog.** The best screen in the file. Exact count, plain-language impact line, paginated affected list. Add: a per-change field diff when the action changes values (not for suspend), a Classroom ownership flag row when targets own active courses (spec cross-reference), and a stale-data warning line when the dataset is stale.

**Users — Confirm Dialog.** S1 undo copy. C4: "Suspend 142 users" should be the filled red button per the guide, or the guide should carve out suspend as non-destructive. The "across 3 schools" restatement is good.

**Users — Reset Password Dialog and Reset Sent Toast.** S7. Also: the card says "142 users match your current filters" while the toolbar says "142 selected". Pick the selection vocabulary. Add the optional "Sign out now" pairing. The toast lacks a "View job" action, which the undo snackbar has.

**Users — Move to OU Dialog.** Good tree, filter, destination footer, preview-first CTA. Add a no-op line ("N of these users are already in this OU"). The demo picks Westside as the destination for a Westside-filtered selection, which shows a zero-op move with no warning. One row shows "28 members" while others show none. Make counts uniform.

**Users — Live Update.** The changed row fades to near-invisible during the flash. A fade reads as deletion. Use a background tint pulse and keep text at full contrast. The status line "1 row updated just now · Synced 2h ago" pairs two unrelated truths. Give the row event its own line and drop the collection freshness from that line. Name the changed field in the event.

**Users — Account Menu.** The theme row is "Theme: System" with a toggle switch. A switch models two states. The theme has three. Use a segmented control or open the Appearance dialog. The "Role: Super Admin" label collides with Google Super Admin. Use the Campus Commander role name. The "Density: Compact" row has no affordance. See C5.

**Users — Import Conflicts Dialog.** Matches the spec conflict model exactly (flat list, per-cell columns, per-row checkbox, header check-all). Fix field names ("school" and "grade" are not Users fields). Use orgUnitPath and the custom schema names. Rename "Discard" to "Keep live values" or split into "Discard file" and "Keep live values".

**Org Units — Delete Wizard.** Good counts and the preview promise. When parent and root are the same path, collapse "Move to parent" and "Move to root" into one option. The nav highlights Org Units while the backdrop shows the Users page. Re-shoot the backdrop on the Org Units page. Name the three child OUs or link to them.

**Users — Capability Failing.** The banner names the capability, the cause, and links to diagnostics. See C1 for the footer contradiction. The status bar should switch to warning with the last failed sweep time.

**Users — Stale Data.** Header and status bar both flag staleness with a "Refresh now" action. Add the stale warning inside bulk preview dialogs when the user acts on stale data.

**Users — Empty State and Loading State.** See L3 and L4. The empty state should also offer "Add user" as a secondary action when no filters are active, and show the filter chips it wants you to clear when filters are active.

**Users — Select All Filtered.** The banner and criteria restatement match decision 17.8. See C8 and C9. The toolbar right side reads "All rows matching: School = Westside Elementary" while two chips are active.

**Users — Add Filter Picker.** Only seven fields. The spec caches more: 2SV enrollment, aliases, creation time, department/title, custom schemas (grade level, student ID). The NL example mentions Grade 3 but the picker offers no grade field. The "Try describing…" hint at the bottom is text, not an affordance. The prototype map says this picker should open the NL filter. Make it a button.

**Users — Export Menu.** Only two of three items carry a scope sublabel ("current filters", "visible rows"). CSV has none. Add "Export selection (142)" as an item and give every item a scope line. Exports run as jobs, so each item should say so or the toast should.

**Users — View Options.** Good columns list with drag handles, group-by, density. "2SV enrolled" lacks the info icon the guide requires for jargon. Add "Reset to default". See C5 on density.

**Users — Sync In Progress.** Good progress copy with queued-jobs note. The progress bar is small and crowded against the text. Give it room and a percentage.

**Users — Undo Snackbar.** S1. If undo ships, the 5-second window is too short for a 142-user action. Consider 10 seconds plus a Jobs-page undo entry point. If undo does not ship, replace the Undo action with "View job" only and retitle the board.

**Users — Reset Sent Toast.** See S7.

**Users — Natural Language Filter.** The privacy line ("The local model runs on your server. No data leaves the deployment.") is exactly right for the spec. The NL entry point here is the global search box, while the Add filter picker has a text hint. Consolidate: the chip-bar input is the filter entry, the global palette is navigation. Add a translating state, editable chips before apply, and a replace-or-add semantic for chips that already exist.

**Users — Grouped by School.** Group headers carry collapse chevrons and per-school counts. Add a group-header checkbox to select a whole school. See C9 for the filter violation in the rows.

**Users — Inline Edit.** The popover anchors on James Chen's row but edits Maria Lopez's email. Fix the anchor. Rewrite the helper line per C6. Save correctly disables while the validation error shows.

**Users — Find in Grid.** Good widget with match count and prev/next. Define the count scope for a server-side grid: matches in the cached window or across all rows. The widget partially covers the Status column. Test at narrow widths.

**Jobs — List Page and Results Ready Toast.** Strong GCP-style model: status chips, duration, brief error, expandable rows, lock note. Issues: S4 and S5 copy. The `bulk_update_devices — Full directory sync` row pairs a mismatched operation and detail. The results toast has no Download action. The list has no pagination or filter chips despite permanent audit retention (spec: all executions kept forever). Job names render in snake_case. Define a display-name mapping (plain label + monospace operation name).

**Job — Detail Page (running).** Good progress, outcome counts, cancel semantics. Add chunk-level progress ("3 of 7 chunks") from the pipeline model and a link to the audit record.

**Job — Cancel Confirm.** The best microcopy in the file. In-flight calls finish, 342 keep their changes, 272 stay untouched. Keep as is.

**Job — Failed Detail.** The status chip says "Failed" while 600 of 614 succeeded. Add a "Completed with errors" state that reserves "Failed" for jobs with zero successes. The failure line names the cause precisely. Consider an in-app expandable failure list next to the CSV download. The progress bar stays blue at full width. Give failed states a red bar.

**Job — Done Detail.** The headline says "614 of 614 devices updated" while outcomes say 610 succeeded and 4 skipped. Make the headline "610 updated · 4 skipped · 0 failed". The subtitle says "Chrome firmware update" (S5). Retention copy ("Results file stays available for 30 days") is good. Add the audit-forever distinction.

**Devices — Grid Page.** See C9 for the filter violation. Missing columns for spec fields: annotated user, annotated location, asset ID, org unit path. The primary menu is "Send command" while Users uses "Bulk actions". Keep entity-specific labels but add the missing non-command bulk actions (Annotate, Move to OU, Disable/Re-enable/Deprovision) either here or in a second menu.

**Devices — Reboot Confirm.** Good copy: impact, auto-reconnect note, acknowledgment checkbox. Add the affected serials list.

**Devices — Wipe Dialog.** Good data-loss statement and type-to-confirm. Add the affected serials list and a preceding preview step so the flow matches the guide (preview plus acknowledgment).

**Devices — Powerwash Dialog.** Same gaps as wipe. The title uses a question mark (C3). The button omits the count ("Powerwash devices" vs "Wipe 2 devices").

**Devices — Command Menu.** See S6. The floating "Applies to 2 selected devices" label sits mid-menu with no visual logic. Group the menu: status changes, remote commands, destructive commands.

**Devices — Cell Edit.** The in-cell editor is right. The helper banner below the card repeats the pipeline vocabulary (C6) and floats outside the card. Move it into the cell editor tooltip. The "Device" column header is vague. If it holds the asset ID, name the column "Asset ID".

**Devices — Detail Side Sheet.** Rich and close to right. Battery sparkline has no axis labels or min/max values. "Network: Wi-Fi · 87 dBm" has the wrong sign (RSSI is negative). Missing: org unit path, support end date with auto-renew, notes field, and the deprovision action.

**Users — Detail Side Sheet.** Good overview, 2SV info icon, group chips, device list with Managed/Offline chips, activity timeline. Layout bug: the bottom action row shows a clipped button behind "Reset password". "Suspend user" is filled red (C4). Missing: aliases, department/title, custom schemas, and a Force sign-out action. The backdrop rows violate the active filter (C9).

**Groups — Grid Page.** See S2 and S3. Add description and aliases columns, and group settings columns from the Group Settings API.

**Groups — Create Group.** See S2. Add description, aliases, and the join/post/moderation settings section. The delivery-settings hint is good. Give it a control.

**Groups — Members Dialog.** Good pending-add chips, remove affordances, and the "runs as a job" line. Missing member roles (OWNER/MANAGER/MEMBER) and member types (USER/GROUP/EXTERNAL). Rename "Discard" (same as conflicts dialog). Add an estimated duration line for large adds (rate-limited one call per member).

**Org Units — Tree Page.** Good tree with counts and detail cards. See S3 for the Groups count. Define "Move entities" behavior: navigate to Users or Devices pre-filtered by this OU with selection guidance. Recent-changes rows use snake_case names.

**Org Units — Create OU.** Good live path preview. Add the description field and a duplicate-name check. The demo creates "Grade 7" under Lincoln Middle while "MS / Grade 7" already exists there.

**Org Units — Rename Dialog.** Missing the impact line. Renaming changes `orgUnitPath` for 312 users and 312 devices. State it before the Rename button.

**Org Units — Reparent Dialog.** Good counts and the policy-impact banner. The picker shows only top-level OUs. The spec's OU picker pattern expects the full tree. Add a preview step that matches the delete wizard. The demo counts contradict the tree (C9).

**Settings — Overview.** Good card rhythm. See S8. The stray empty card (L6) must go. Add cards or a section for per-type sync thresholds, the nightly sync time, and the service admin account entry point (it currently lives only on Connection).

**Settings — Diagnostics.** Matches the permanent per-capability diagnostic in the spec. Add a re-run control per area, a license hint for the Telemetry area (it requires Chrome Enterprise Upgrade), and an expandable error payload on failure.

**Settings — Setup Wizard.** See S9. Also fix the clipped "copy" label, add the multi-party approval note, and add the billing-account edge-case step.

**Settings — Connection.** See S8 and L6. The tooltip occludes its own row label. Show the per-area scope list rather than the bare count "4 scopes granted" (it also disagrees with the wizard's three scopes). "OAuth client: Desktop client" is an odd client type for a server application. Use the customer's actual client type wording.

**Settings — Setup Waiting.** Matches scan-and-wait: per-area states, backoff line, close-the-tab note, email notice. Add the multi-party approval sentence (S9) and a per-area "why is this waiting?" hint that names the probable missing scope.

**Auth — Sign-in, Sign-in Error, Sign-in Dark.** Clean and correct. The scope-transparency copy is a real trust builder. The error screen names the fix. The logomark resolves the guide's open item (update the guide). Dark sign-in contrast passes on first read.

**Users — Command Palette.** Good cross-entity results with live job status. See S5 for the firmware row. Define the empty-query state (recent jobs, recent entities). The device row pairs two identifiers ("CM-4821 · Serial 4821H"). Pick the canonical annotated asset ID.

**Users — Help & Shortcuts Dialog.** Good plain-language summary of the safety model. The scrim is opaque (C2). The keyboard list is thin for a power tool. Add select-all-filtered, open bulk menu, clear selection, and refresh.

**Settings — Appearance Dialog.** Good three-state theme and the row-height numbers. See C5 for the density home decision. "Applies to this browser only" is good.

**Settings — Replace Account Dialog.** The safe-swap semantics are excellent: delegation checked before save, current account active until verified. Fix the opaque scrim (C2).

**Users — Session Expired.** "No job was interrupted. Running operations continue." is the right reassurance and matches the server-side job model. Keep. State what happens to the selection after re-auth (it persists per decision 17.8).

**Settings — Disconnect Confirm.** Good Google-side step ("Remove the DWD trust in your Admin console to finish"). Contradicts the Connection card copy: the card says "Clears the local cache", the dialog says "Cache and jobs remain". Align both to the real behavior.

**Users — Group Picker Dialog.** Good filter, counts, create-new-group link, selected footer. Add the preview step (guide requires preview before every bulk action) with the no-op count ("N already in this group") and the rate-limit duration estimate.

**Users — Delete Archived Dialog.** Accurate Google semantics: files move to trash, 20-day recovery, not undoable here. Add the scope line ("12 archived users in the current filter"). Align the title style (C3).

**Users — Create User.** Matches the spec's auto-generated temporary password pattern. See S10 for the domain dropdown. Add custom schema fields (grade level, student ID) since schools store them, and an alias field. Consider a "Create another" affordance for enrollment-season bulk entry.

**Users — Import File Picker.** Good constraints and template link. The Continue button is enabled with no file chosen. Disable it. Add the hash-column guidance: "To update existing users, import a file you exported from Campus Commander." Reconcile the 50,000-row cap with the spec scale story.

**Users — Review Import.** Counts match the spec three-way model (18 create, 1,174 update, 12 conflicts). Missing: the validation-failure count and list, and an in-app diff of the non-conflicting changes ("View changes" expandable). The spec requires showing the exact changes before execution.

**Design System — Components.** Too sparse to govern a build. Add: disabled, hover, pressed, and focus states. Add: text fields, banners, snackbars, side sheet, radio and checkbox, table header and pagination, empty state. Rename or restyle the "Danger" master to match C4.

---

## 3. Formal work list

Execution status (2026-09-03): gates G1 to G3 resolved. Work Package A complete (A1 to A16). Journey slice B complete (B1 to B6). Journey slice C complete (C1 to C4). Work Package D stays parked until the first unmoderated walkthrough. The two walkthrough criteria in the definition of done remain open until a human runs them.

This section records the historical UI/UX work derived from the findings and PM assessment. The product manager owned the three gate decisions. Sections 1 and 2 preserve the rationale. Current implementation follows the repository UI contract.

**Roles.** The UI/UX agent executes tickets and verifies each one against its "Done when" line. The PM resolves gate decisions G1 to G3. Spec owners confirm API facts when a ticket touches them. The executing agent updates `docs/ux/prototype-map.md` and `docs/ux/ui-design-guide.md` in the same change as any screen they describe.

**Sequencing.** Gate decisions first where marked. Then Work Package A (blocking). Then the two journey slices B and C. Work Package D waits until after the first unmoderated walkthrough, because walkthroughs re-prioritize it.

### Gate decisions (PM-owned, blocking where noted)

Resolved 2026-09-02 by PM review: the defaults below are adopted. G1 = cut the undo promise. G2 = compact only. G3 = keep the 50,000-row cap and state it as a v1 limit.

| ID | Decision | Blocks | Default if not resolved in 5 business days |
|---|---|---|---|
| G1 | Undo for bulk actions in v1: cut the promise, or build it. The review flagged that Confirm and the snackbar promise Undo while spec 1 marks it a stretch goal. Undo changes the jobs data model, so the decision must precede snackbar and Confirm rework. | B4, B5 | Cut the promise. Remove Undo from the snackbar. Keep "View job" only. |
| G2 | Grid density in v1: compact only, or compact plus comfortable. Three screens currently expose a control the guide defers. | A16, D9 | Compact only. Remove density from Appearance, View options, and the Account menu. |
| G3 | Import row cap: 50,000 rows against a spec that sells 100k+ scale. | C1 | Keep 50,000. State it as a v1 limit in the import UI. |

### Work Package A — Blocking truth and layout fixes

These land before the next demo round. Each ticket is verifiable by screen export.

**A1 — Repair the demo dataset.**
Screens: every grid and state board.
Change: make every visible row satisfy the visible filter chips on its board. School = Westside shows only Westside rows. Suspended = Yes shows only suspended. Battery = Replace Soon shows only Replace Soon. Make totals agree: 128,431 users district-wide, OU tree sums, group counts, select-all banner count.
Done when: an export of every grid board shows no row that violates its chips, and no two totals on one screen disagree.

**A2 — Job copy truth sweep.**
Screens: Jobs — List Page, Job — Detail Page, Job — Done Detail, Users — Command Palette.
Change: "Incremental sync" becomes "Full sweep". Replace "Push firmware policy" and "Chrome firmware update" with an in-scope operation ("Move 614 devices to /Staff"). Pair each operation name with a detail that matches it.
Done when: no screen names an operation outside the spec's writable and command surfaces.

**A3 — Fix the Groups data model.**
Screens: Groups — Grid Page, Groups — Create Group, Org Units — Tree Page.
Change: remove the "Type: Dynamic/Static" column and the "Owning OU" column. Remove the Groups stat card from the Org Units detail. Add Description and Aliases columns. In Create group, replace the Membership type radios with a Settings section (who can join, who can post, moderation) per the Group Settings API.
Done when: no screen shows a group attribute that the Directory API or Group Settings API does not provide.

**A4 — Sync cadence copy and config.**
Screens: Settings — Overview, Settings — Connection.
Change: replace "every 15 min" with the per-type threshold model (Users 1h, Devices 4h, Groups 1h, OrgUnits 12h) and the nightly backstop. Add a card listing the four thresholds and the nightly time, marked admin-tunable. Remove the stray empty card below "Finish setup".
Done when: the cadence copy matches the Sync & Freshness Strategy section of spec 1 and a thresholds card exists.

**A5 — Setup wizard correctness.**
Screens: Settings — Setup Wizard, Settings — Setup Waiting.
Change: the delegation scope list covers all five capability areas (Users, Devices, OrgUnits, Groups, Telemetry). Step order matches reality: the manual DWD paste is its own step and the following step waits for propagation. The wizard and the waiting screen both state the multi-party approval cause for long waits. Fix the clipped "copy" label.
Done when: a scope-for-scope diff of the wizard list against spec 1's capability areas is empty, and both screens mention multi-party approval.

**A6 — Restructure the device command surface.**
Screens: Devices — Command Menu, Devices — Grid Page.
Change: commands are Reboot, Wipe user data, Powerwash. Bulk actions Annotate, Move to OU, Disable, Re-enable, Deprovision appear in the menu or a second menu. Group the menu with labels and drop the floating "Applies to 2 selected devices" row.
Done when: every menu item maps to a spec 1 device action and none maps to a non-v1 command.

**A7 — Reset password semantics.**
Screens: Users — Reset Password Dialog, Users — Reset Sent Toast.
Change: the action becomes "Force password reset at next sign-in". Add an optional "Also sign them out now" checkbox. Copy explains that credentials stop working at next sign-in. The toast carries a "View job" action. Use the selection vocabulary ("142 selected users"), not filter vocabulary.
Done when: no screen says an email was sent, and the sign-out pairing is present.

**A8 — Single-domain create user.**
Screens: Users — Create User.
Change: remove the domain suffix dropdown. Show the fixed domain as static suffix text.
Done when: no control on the board implies multi-domain support.

**A9 — Grid card fills the viewport.**
Screens: all grid pages and all grid state boards.
Change: the grid card stretches to the available height between toolbar and footer. Rows fill the card. Empty, loading, and capability-failing states render inside the same card footprint.
Done when: exports of the shell, empty, loading, and stale boards show no dead band between the card and the footer.

**A10 — One scrim token.**
Screens: every dialog and menu board.
Change: define a single scrim (black at 32 percent) in the token sets. Apply it everywhere. Remove the opaque variants on Help and Replace account.
Done when: every dialog export shows the app dimmed but visible behind the same scrim value.

**A11 — Dialog title grammar.**
Screens: all dialog boards.
Change: titles are statements with counts. "Delete 12 archived users", "Wipe 2 devices", "Powerwash 2 devices". No question-mark titles.
Done when: no dialog title ends with a question mark.

**A12 — Danger button rule.**
Screens: Users — Detail Side Sheet, Design System — Components, Devices command entry points.
Change: destructive actions render outlined red at rest. Filled red appears only on the confirm step. Restyle the side sheet's "Suspend user". Rename the design system master from "Danger" to "Destructive (outlined)" and add a filled confirm variant beside it.
Done when: no rest-state screen shows a filled red button.

**A13 — Remove pipeline vocabulary from UI copy.**
Screens: Users — Inline Edit, Devices — Cell Edit.
Change: helper lines become outcome copy: "This edit runs as a tracked job." Drop "same path as a single-row bulk action" and "write through the same single-row API path". Move the cell-edit hint into the editor, not a page-level banner.
Done when: exports contain neither phrase.

**A14 — Overflow and occlusion fixes.**
Screens: Setup wizard (clipped copy label), Connection (tooltip covers its row label), Settings overview (stray empty card, also in A4), Users bulk menu (clipped row).
Change: fix the four defects.
Done when: the overflow lint passes on all four boards.

**A15 — One health model.**
Screens: both shells, Users — Capability Failing, Users — Stale Data, Devices and Groups pages.
Change: the footer dot derives from the same state as page banners: green all pass, amber partial or stale, red failing. On Capability Failing the dot is amber or red and the tooltip names the failing area. On Stale Data the status bar and dot turn amber. Align the Disconnect card and dialog copy on what happens to cache and jobs.
Done when: an export of Capability Failing shows no green "All systems connected" footer.

**A16 — Density consolidation.**
Screens: Appearance dialog, View options, Account menu.
Depends on: G2.
Change per default: density controls removed from all three screens. If G2 keeps density, one home only (View options).
Done when: density appears on zero or one screen.

### Work Package B — Journey slice: suspend a user

Vertical slice through the safety chain. Done criterion is a walkthrough, not a lint: a first-time tech helper completes a 20-user suspend unaided, and a pro admin completes it without touching a single advanced control.

**B1 — Bulk menu completeness.**
Screens: Users — Bulk Actions Menu.
Change: add Archive/Unarchive and Force sign-out per spec. Fix the clipped row (A14 overlap allowed). Group destructive items at the bottom with the red label.
Done when: the menu lists exactly the spec 1 Users bulk actions plus group membership actions.

**B2 — Preview dialog upgrade.**
Screens: Users — Preview Dialog.
Change: add a stale-data warning line when the dataset is stale. Add a Classroom ownership flag row when targets own active courses. Keep the exact counts and paginated list.
Done when: the preview shows impact in plain language with exact counts, and the two new lines appear in the exports.

**B3 — Confirm dialog.**
Screens: Users — Confirm Dialog.
Depends on: G1.
Change if cut: remove the "You can undo this from the Jobs page" line. Restate scope and count. Filled red primary per A12.
Done when: the dialog makes no promise the backend does not keep.

**B4 — Post-run feedback.**
Screens: Users — Undo Snackbar.
Depends on: G1.
Change if cut: retitle the board "Run Result Snackbar". Show "Suspended 34 users" with "View job". If G1 builds undo, extend the window to 10 seconds and add a Jobs-page undo entry.
Done when: the snackbar offers no dead-end action and matches the G1 outcome.

**B5 — Jobs reading path.**
Screens: Jobs — List Page, Job — Detail Page, Job — Failed Detail, Job — Done Detail.
Change: add "Completed with errors" as a status distinct from "Failed". Fix the Done headline to "610 updated · 4 skipped · 0 failed". Add chunk progress ("3 of 7 chunks") to the running detail. Add a plain display name beside the monospace operation name. Give failed runs a red progress bar. Add pagination and filter chips to the list (audit retention is forever).
Done when: the failed screen never shows "Failed" beside 600 successes, and the list paginates.

**B6 — Selection and toolbar clarity.**
Screens: App Shell — Users, Users — Select All Filtered, all grid pages.
Change: the select-all banner restates the full filter set including every active chip. Show count and freshness once (status bar only). Add tooltips or labels to the four toolbar icon actions. Verify 32px compact rows.
Done when: an export shows the banner naming both chips and no duplicated count in the header.

### Work Package C — Journey slice: import users

Vertical slice through the file-driven import flow.

**C1 — File picker gating.**
Screens: Users — Import File Picker.
Change: disable Continue until a file is chosen. Add the hash-column guidance: "To update existing users, import a file you exported from Campus Commander." Apply the G3 cap decision to the constraint line.
Done when: Continue is disabled with no file and the cap copy matches G3.

**C2 — Review import transparency.**
Screens: Users — Review Import.
Change: add a validation-failure count and list. Add a "View changes" expandable that shows the exact cell diffs for non-conflicting updates. The spec requires the exact changes before execution.
Done when: the review shows all four counts (create, update, conflict, invalid) and a diff view exists.

**C3 — Conflict resolution wording.**
Screens: Users — Import Conflicts Dialog.
Change: rename "Discard" to "Keep live values". Use real field names (orgUnitPath, custom schema names). Keep the per-row checkbox and header check-all exactly as they are.
Done when: no button on the board is ambiguous about what it discards.

**C4 — Results delivery.**
Screens: Jobs — Results Ready Toast, Job — Done Detail.
Change: the toast carries a Download action. Both keep the 30-day retention line and the audit-forever distinction.
Done when: the toast can hand the user the file in one click.

### Work Package D — Backlog after the first walkthrough

Sequenced by walkthrough evidence, not by this list's order.

- **D1 — Filter field expansion.** Full cached field set in the Add filter picker: 2SV, aliases, creation time, department/title, grade level, student ID, org unit path. Info icons on jargon fields. Make "Try describing…" a real button into the NL flow.
- **D2 — NL filter consolidation.** One entry point (chip-bar input), one translating state, editable chips, defined replace-or-add semantics.
- **D3 — Export scope clarity.** Scope line per item, plus "Export selection (142)".
- **D4 — Grouped view selection.** Group-header checkboxes in Users — Grouped by School.
- **D5 — Detail sheet completeness.** Users: aliases, department, title, custom schemas, Force sign-out. Devices: OU path, support end date with auto-renew, notes, deprovision. Fix battery sparkline labels and the RSSI sign ("−87 dBm").
- **D6 — OU change safety.** Impact lines on Rename ("312 users and 312 devices get a new path") and Reparent. Preview step matching the delete wizard. Collapse parent/root options when identical. Define "Move entities" navigation.
- **D7 — Bulk action previews.** Add preview steps to reset password, group add/remove, and the Group Picker with no-op counts.
- **D8 — Device dialogs.** Serial lists in wipe and powerwash. Statement titles (A11 covers). Consistent button counts.
- **D9 — Appearance and theme controls.** Three-state theme control in the Account menu (segmented control or open the Appearance dialog). Campus Commander role name instead of "Super Admin". Depends on G2.
- **D10 — State polish.** Live update uses a tint pulse at full text contrast with the changed field named. Loading skeleton gets card chrome and column headers, one "Loading users…" line. Empty state fills the card, offers "Add user" when no filters, and reuses the logomark.
- **D11 — Command palette.** Empty-query state, canonical device identifier, no firmware copy (A2 covers).
- **D12 — Design system expansion.** Control states (disabled, hover, pressed, focus), text fields, banners, snackbars, side sheet, table chrome, empty states. This becomes the build reference for the frontend slice.
- **D13 — Docs alignment.** Update the guide's open-items list (logomark resolved by sign-in screen), and the prototype map for every moved or renamed board.

### Definition of done for the file

The UI/UX agent declares the file done for this round only when all of the following hold:

1. Every Work Package A ticket passes its "Done when" line on a fresh export.
2. Both journey slices pass their walkthrough criterion: a first-time tech helper completes a 20-user suspend unaided, and a user with a district export completes the import flow including one conflict, unaided.
3. The truth audit is clean: no copy contradicts spec 1, the design guide, or the Google API surfaces named in it.
4. Every dialog uses one scrim token, one title grammar, and the danger rule.
5. Every bulk action follows select, preview, confirm, job.
6. The overflow lint and the contrast floor pass file-wide.
7. `prototype-map.md` and `ui-design-guide.md` describe the file as it now is, with no drift.

---

## 4. What is already right

Worth protecting while fixing the rest:

- The safety chain demo (preview, confirm, type-to-confirm, job, results) matches the product promise end to end.
- Job cancel semantics and session-expired copy state server truths in plain language.
- The NL filter privacy line and the setup wizard's one-click-copy pattern follow the spec exactly.
- Diagnostics, setup waiting, and the replace-account safe swap are the strongest operational screens.
- The two-audience rule shows up in practice: plain labels everywhere, technical detail on demand.
