# Campus Commander — Prototype Map

This document records the existing Penpot prototype inventory. Use it to find boards and preserve design assets.

**Alignment status, 2026-09-05:** the written portfolio incorporates the contractor review. The live prototype has not received these changes.
Observed interactions below are historical board behavior. Implement current behavior from [04](04-ux-ui-spec.md).
Track 12 in [06](06-work-breakdown.md) owns prototype alignment.

The owner adopted device-first interaction development in Phase 6 after deployment, auth, onboarding, EntityCache, and JobService foundations.
The existing Users-first board arrangement does not determine implementation order.
Record accepted device interactions before adapting them for Users, OUs, and Groups in Phases 7–9.
The Fleet Status and Report Dashboard belongs to Phase 10. No prototype boards changed during this planning update.

- File: `design.penpot.app` → team `Campus Commander`, file `Campus Commander`.
- All boards live on the page `Users — Grid Page`.
- The prototype runs in Penpot prototype mode. Click any wired element to move between boards.

## Board layout

Boards sit on a grid. Columns are 1600 px apart. Stack rows are 1000 px apart.

| Column x | Contents |
|---|---|
| −1600 | Cover: tokens, type scale, layout metrics, screen index |
| 0 | App Shell — Users (light) · App Shell — Users — Dark |
| 1600 | Devices — Reboot Confirm · Users — Help & Shortcuts Dialog · Settings — Replace Account Dialog |
| 3200 | Users — Bulk Actions Menu |
| 4800 | Dialogs stacked top to bottom: Preview, Confirm, Stale, Capability Failing, Delete OU Wizard, Import Conflicts, Live Update, Account Menu, Move to OU, Review Import, Create User, Reset Password, Session Expired, Disconnect Confirm, Appearance, Powerwash, Group Picker, Delete Archived, Import File Picker (y 18000) |
| 6200 | Devices — Wipe Dialog, then Users states: Select All, Empty, Loading, Add Filter Picker, Export Menu, View Options, Sync In Progress, Run Result Snackbar, Reset Sent Toast, Natural Language Filter, Grouped by School, Inline Edit, Find in Grid, Results Ready Toast |
| 7600 | Devices grid, Cell Edit, Command Menu, Device Detail Side Sheet, Users Detail Side Sheet |
| 9000 | Groups grid, Create Group, Members Dialog |
| 10400 | Org Units tree, Create OU, Rename, Reparent |
| 11800 | Jobs list, Job Detail (running), Cancel Confirm, Failed Detail, Done Detail |
| 13200 | Settings: Overview, Diagnostics, Setup Wizard, Connection, Setup Waiting |
| 14600 | Command Palette, Auth — Sign-in, Auth — Sign-in — Dark, Auth — Sign-in Error |
| 16200 | Design System — Components: visual masters for buttons, chips, filter chip, icon button, dialog card |

## Flows

Nine named flows start from the main pages. Each `entry-*` flow is a direct entry point into one interactive board. Create missing ones with `penpot.currentPage.createFlow(name, startingBoard)` in the plugin console. Do not delete them. Each one is a one-click jump into that screen in prototype mode.

| Flow | Starts at |
|---|---|
| Users — grid | App Shell — Users |
| Users — dark | App Shell — Users — Dark |
| Users — safety | Users — Preview Dialog |
| Users — dialogs | Users — Move to OU Dialog |
| Users — states | Users — Select All Filtered |
| Devices | Devices — Grid Page |
| Groups and Org Units | Groups — Grid Page |
| Jobs | Jobs — List Page |
| Settings and setup | Settings — Overview |

## Demo script: the safety chain

This records the existing demonstration chain. Update its result timing before using it as acceptance evidence.

1. Start at App Shell — Users. Select rows, click **Bulk actions**.
2. Click **Suspend users**. The Preview dialog lists exact impacts.
3. Click **Review & confirm**. The Confirm dialog restates targets and count.
4. Confirm. The execution result shows the **Run Result** snackbar ("Suspended 34 users") with a **View job** action. It closes itself after 5 seconds.
5. Click **View job** to jump to the Jobs list.

Other chains: Devices selection → **Send command** → Command Menu with a **Commands** group (Reboot, Wipe user data, Powerwash) and a **Bulk actions** group (Annotate, Move to org unit, Disable · Re-enable · Deprovision). Reboot devices asks for an acknowledgment check. Wipe devices and Powerwash devices both type-to-confirm. The footer health indicator ("All systems connected") opens Diagnostics on both shells. The header help icon opens the Help & shortcuts dialog on every page. Devices battery cell → Cell Edit. Bulk menu → Add to group / Remove from group → Group Picker. Bulk menu → Delete archived users (type-to-confirm). Add user button → Create User. Header select-all checkbox → Select-all filtered state. Jobs list Failed row → Failed job detail → Retry. Export menu items → Jobs list (exports run as jobs). Filter picker options close the picker with the filter applied. Add filter picker → "Try describing…" → Natural Language Filter (query typed in the search field, translated chips, Apply returns to the grid). Users toolbar upload icon → Import File Picker (drop zone, template link) → Continue → Review Import. Email cell → Inline Edit (validation error, write-through hint). Command palette → Find in grid → highlighted matches with match count. Command palette results now cover Groups and Jobs too. Members dialog shows add-by-search suggestions with pending-add chips. Save closes. Jobs list Done row → Done job detail (green summary, outcome counts) → Download results (CSV) → results-ready toast (auto-dismiss). Header theme toggles open the Appearance dialog on every page. View options → Group by → School → Grouped-by-School grid (group header rows with per-school counts). Org Units tree rows → Create, Reparent, Rename, or Delete. Settings → Run checks → Diagnostics. Settings → Connection → Replace opens the Replace service admin account dialog (delegation is checked before the account is saved). Settings → Change → Appearance. Settings → Resume wizard → Setup Wizard → Setup Waiting. Sign-in → shell, and Sign out → back to Sign-in. The dark sign-in opens the dark shell.

Nine system-state screens (auth errors, session expiry, reset toast, grid states) appear only as `entry-*` flows. Real systems reach them through time and failures, not clicks.

## Design sources of truth

- Tokens: the Penpot library token sets (`CC Color Light`, `CC Color Dark`, `CC Scale`). Export to `frontend/src/theme/tokens.css` after any token change. See [04 — UX/UI Spec](04-ux-ui-spec.md), section 15.
- Colors, type, and density rules: [04 — UX/UI Spec](04-ux-ui-spec.md).
- Screen coverage per entity: [02 — Domain Model](02-domain-model.md) and [04 — UX/UI Spec](04-ux-ui-spec.md).

## Maintenance rules

- One name for one thing. Shape names use a board prefix such as `cp-`, `mv-`, `sx-`.
- New dialogs join the 4800 column stack. New full pages join a new 1600-wide column.
- Keep every dialog board parented to a `Scrim` board and wire the scrim to close.
- Boards that hold interactions need an exit: a close action or a navigation action.
- After edits, run the overflow lint: every child stays inside its parent bounds.
- Periodic lints that currently pass file-wide: all text uses Roboto or Material Symbols, no interaction points at a missing destination, no semicolons in visible copy.


## Required alignment before implementation

| Existing board or behavior | Required change | Work item |
|---|---|---|
| Setup and Connection | Verified credential flow, generated scopes, read-only start, account identity, resumable progress | D-F |
| Shell and command palette | Cross-entity search and customer context including supported domains | D-D |
| Inline Edit and device Cell Edit | Drafts, baseline conflicts, Save → preview → confirm. Read-only telemetry never becomes editable. | D-A/D-B |
| Run Result snackbar | Distinguish accepted job receipt from confirmed operation success | D-H |
| Jobs, Failed detail, Retry | Per-operation outcomes, unknown effects, eligible retries, held admission, and verification | D-H |
| Import/export | Stored baseline, visible metadata, expiry, explicit create mode, and CSV-first scope | D-C |
| Sync and stale states | Collection coverage and write verification without global write freezing | D-H |
| Compact controls and dialogs | Keyboard operation, focus recovery, target spacing, density evidence, and bounded grid scrolling | D-G |
| Battery and device commands | Missing-data coverage, policy thresholds, command acceptance versus execution | D-E/D-H |

Keep board positions and flow names until a scoped prototype edit changes them.
Do not treat this alignment list as evidence that a live board was edited or tested.
