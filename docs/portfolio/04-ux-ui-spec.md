# 04 — UX/UI Spec

**Status:** current interaction design, revised 2026-09-05. Visual tokens remain provisional where marked.
The contractor review and owner decisions replace conflicting behavior from earlier prototype boards.
[03](03-architecture.md) defines runtime behavior. [05](05-decisions-and-open-questions.md) records current decisions.
The [prototype map](prototype-map.md) preserves observed boards and lists pending alignment work.
No live prototype edits occurred during this integration.

## Development milestones

The [ten-phase sequence](06-work-breakdown.md#delivery-sequence) governs feature availability.
Phase 2 delivers login, the shell, and a protected utility page. Phase 3 adds onboarding, settings, and delegated platform access.
Phase 4 provides a working read-only device page. Phase 5 adds Jobs and frontend notifications.
Phase 6 establishes the device experience through repeated working releases and explicit owner acceptance.
Record accepted grid, detail, edit, preview, confirmation, and job-navigation patterns before implementing the Users phase.
Phase 7 adds Users, Phase 8 adds OUs, Phase 9 adds Groups, and Phase 10 adds Fleet Status and reports.
Show navigation only for capabilities available in the installed release. Preserve previous workflows throughout development.
Platform access management and Google Workspace user management require distinct labels and routes.

## 1. Audience

Campus Commander serves two user groups at once:

- **Professional IT admins.** Full-time district IT staff. They work in the app daily, browse 100k+ row datasets, and expect density, speed, and power features (select-all-filtered, column customization, bulk actions).
- **Occasional tech helpers.** A librarian who supports her school's technology. A teacher's aide supporting a class. They open the app a few times a term. They need plain-language labels, guided flows, and a clear explanation of each action's impact before they run it.

Rules that serve both groups: plain-language action labels first, with technical detail on demand through tooltips and expandable details. Every destructive or irreversible action explains its impact in plain language with exact counts before it runs. Power features exist but never gate basic flows. An occasional user completes a task without touching an advanced control.

## 2. Design principles

1. **Dense data, airy chrome.** Entity grids use compact rows so hundreds of rows stay visible. Everything around the grid uses generous white space: roomy padding, clear section breaks, one job per screen region.
2. **Speed made visible.** Search, filtering, and selection use the local read model under measured latency targets. The UI surfaces that promise: a freshness indicator on every entity view, live row updates when data changes, sync progress where it matters. A stale dataset says so.
3. **Safety proportional to blast radius.** Every bulk action shows a preview with exact counts. Destructive device commands add extra confirmation friction on top of the standard preview.
4. **Familiar enterprise patterns.** Patterns come from products admins already know: Google Admin Console, GCP Console job pages, GAM7 onboarding, the Google OU picker. Nothing exotic.
5. **One visual system.** Angular Material tokens are the single source of truth for color, type, and elevation. Tailwind handles layout only. The grid inherits the same tokens through `@libregrid/material`.
6. **Server truth, plainly stated.** Copy states what the backend actually does. No promises the backend does not keep.

## 3. Brand

- **Wordmark:** "Campus Commander" in Roboto Medium at the top of the left navigation panel. A graphical logomark is an open item (Section 16).
- **Accent color:** one blue accent (`#1A73E8`, provisional pending brand confirmation) drives primary actions, active states, links, and focus rings. One accent only. Semantic colors never double as decorative accents.
- **Iconography:** Material Symbols is the only icon system. No emoji, no second icon set, no hand-drawn SVGs outside the grid theme. Sizes: 24px navigation and toolbars, 20px inline actions, 16px dense list contexts. Navigation icons use the outlined weight at rest and the filled weight on the active item. One weight per context.
- **Brand presence:** wordmark in the nav header. Accent on all primary actions and active states. Branded empty states (wordmark + one sentence of guidance + one next action). App version in the footer.

## 4. Layout and app shell

Standard enterprise layout: a full-height left navigation panel, a header above the main column only, and a full-width footer.

```
+-----------+----------------------------------+
|           | Header (main column only)        |
| Left nav  +----------------------------------+
| (full    |                                    |
| height)  | Main content area                  |
|           |                                    |
+-----------+----------------------------------+
| Footer (full width, spans under the nav too) |
+------------------------------------------------+
```

**Left navigation panel.** Width 240px expanded, 56px icon rail when collapsed. The collapse state persists per user. Top: the wordmark and connected customer account name. Show domain context where it helps distinguish entities within that account. Items in order, each with a Material Symbol: Users (`people`), Devices (`laptop_chromebook`), Groups (`group`), Org Units (`account_tree`), Jobs (`history`), Settings (`settings`). Active item: accent-tinted background, filled icon, 3px accent indicator bar on the left edge. The Org Units tree lives inside the Org Units page (tree pane + detail panel), matching the Google OU picker pattern. It is not a permanent app-level pane.

**Header (main column only).** Left: the page title (for example "Users" or "Job: bulk_update_devices"). A subtitle carries task context. Keep entity counts and freshness in the grid status bar. Right: help link, theme toggle (light/dark), user menu (initials avatar, display name, role label, sign out). Height 64px. Card surface in light mode, elevated dark surface in dark mode. Entity search starts with devices in Phase 4. Users join in Phase 7, OUs in Phase 8, and groups in Phase 9.

**Footer (full width).** Left: app version and build identifier. Right: connection health indicator. A status dot (green = all capability areas pass, amber = partial, red = failing) with a tooltip that links to the Diagnostics page. Height 40px. Subtle top border, no shadow.

**Main content area.** Background: the app surface color. Content sits on cards. Page padding 24px. Grid pages use the full available width. Form and wizard pages center their content at a 720px max width. Vertical rhythm between sections 32px. Card interior padding 16px.

## 5. Color system

Light and dark from day one. Material `light-dark()` tokens define every color. The grid follows the app automatically through the `@libregrid/material` bridge.

### Surfaces (neutral scale)

| Token | Light | Dark | Use |
|---|---|---|---|
| `surface-app` | `#F8FAFC` | `#121212` | App background behind cards |
| `surface-card` | `#FFFFFF` | `#1E1E1E` | Cards, grids, panels |
| `surface-hover` | `#F1F5F9` | `#2A2A2A` | Row hover, menu item hover |
| `surface-selected` | accent at 8% opacity | accent at 14% opacity | Selected grid rows |
| `border` | `#E2E8F0` | `#3A3A3A` | Card borders, dividers |

### Accent and text

| Token | Light value | Use |
|---|---|---|
| `accent` | `#1A73E8` (provisional) | Primary actions, active nav, links, focus rings |
| `text-primary` | `#202124` | Headings, body text |
| `text-secondary` | `#5F6368` | Subtitles, metadata, footer |
| `text-disabled` | `#9AA0A6` | Disabled controls |

Dark mode inverts the surfaces and lifts text to `#E8EAED` (primary) and `#9AA0A6` (secondary). The accent stays blue in both modes. The dark-mode contrast check happens during the theming pass.

### Semantic colors

| Token | Light value | Meaning |
|---|---|---|
| `status-success` | `#188038` | Healthy, completed, passing |
| `status-warning` | `#F9AB00` | Stale data, partial success, battery "Replace Soon" |
| `status-error` | `#D93025` | Failed, suspended user, battery "Replace Now", failing capability |
| `status-info` | `#1A73E8` | In progress, scheduled |

Entity state chips: suspended → error, archived → neutral gray, battery "Replace Soon" → warning, battery "Replace Now" → error, healthy → success. A state chip is a small rounded pill with label text. Color never carries meaning alone: every colored indicator carries a text label (accessibility). Contrast floor: WCAG AA for all text and interactive elements in both modes.

## 6. Typography

- **Face:** Roboto, self-hosted as woff2 files inside the app bundle. No CDN fetch. Installs must work offline, so the fonts ship with the artifact.
- Weights: 400 (body), 500 (titles, buttons, wordmark), 700 (page titles only).

| Level | Size / line-height | Use |
|---|---|---|
| Display | 24px / 32px | Page titles |
| Title | 16px / 24px | Card titles, dialog titles |
| Body | 14px / 20px | Default text, grid cells |
| Caption | 12px / 16px | Metadata, status bar, footer, chips |

Data columns in grids use tabular numerals (`font-variant-numeric: tabular-nums`) so digits align vertically. Identifiers, hashes, and file paths render in the system monospace stack at caption size. Use WCAG 2.2 AA as the engineering target. Verify target size or permitted spacing exceptions for compact controls. Require complete keyboard operation and representative screen-reader testing.

## 7. Density and spacing

- **Grid rows:** compact by default. 32px row height, 12px/16px cell text. Compact is the default. Add comfortable density when accessibility or usability evidence requires it. Decision R23 revises G2.
- **Spacing scale:** 4px base. Standard steps: 4, 8, 12, 16, 24, 32, 48.
- **Radii:** 4px for controls and cards. Full radius (999px) for chips and status dots.
- **Elevation:** low. Cards sit on the app background with a 1px border and no shadow in light mode. Dark mode uses surface lift instead of shadows. Shadows appear only on floating layers: one level for menus, two for dialogs. Dialogs and menus share one scrim token: black at 32 percent opacity.
- **White space is the default.** A page region holds one job. Cards do not nest more than one level. Entity grids use a bounded scrolling viewport inside the card. Avoid nested scrolling in ordinary forms and dialogs.

## 8. Theming architecture

- Angular Material tokens are the single source of truth for color, typography, and elevation.
- `provideLibreGridMaterialTheme()` (from `@libregrid/material`) maps those tokens onto the grid's Quartz theme. It follows `light-dark()` changes live. No manual grid theme configuration exists.
- Tailwind CSS handles layout only: flex/grid placement, spacing, sizing. Tailwind never defines a second color or type scale. Layout classes reference Material token values through CSS custom properties.
- Dark mode: the app follows `prefers-color-scheme` by default. The header toggle overrides per user and persists the choice. The grid follows automatically.
- Custom tokens (accent, entity state colors) extend the Material theme in one place under `frontend/src/theme/`. No component-level color overrides.

## 9. Grid page anatomy

Every entity page (Users, Devices, Groups) shares one canonical layout, top to bottom:

1. **Chip filter bar.** Full width, 16px below the header. Active filters render as chips (field + value + remove `x`). A trailing "Add filter" control opens a field picker. Chips and saved filters use the same typed query contract. Optional later language assistance produces that contract.
2. **Toolbar row.** Left: the bulk action menu (primary button, accent), enabled only when a selection exists. Right: the selection summary ("142 selected", or "All rows matching: suspended = yes"), view options (columns), export menu.
3. **Grid card.** Card surface, 1px border. Server-side row model (`@libregrid/server-side-row-model`), compact rows. A checkbox column for selection. Writable fields show an edit affordance on hover. A single-cell edit creates a draft. Save prepares a preview, and confirmation creates an audited job. The card stretches to the footer. The status bar docks to the card bottom.
4. **Status bar.** Bottom of the grid card, caption size: total row count ("128,431 users"), freshness indicator with status color ("Synced 2h ago"), sync progress while one runs. Count and freshness appear once, in the status bar. Page headers do not duplicate them.

**Selection visualization** follows decision 17.8 (server-side selection, Redis-backed):

- A selected row gets the `surface-selected` background. The grid renders per-row flags for the rows it currently caches (`@libregrid/server-side-selection`).
- "Select all filtered" shows the criteria, not an ID list. The toolbar reads "All rows matching: [criteria]" with a count when the API returns one. A banner under the toolbar states the full criteria and offers "Clear selection".
- Browsing selections survive page changes, displayed filter changes, and grid re-renders under the documented expiry policy. Show original selection criteria. Expiry prompts reselection. Approved manifests remain durable.

**Org Units page:** a tree pane on the left (`@libregrid/tree-data`, Google OU picker pattern) with entity counts per node computed from the cache. A detail and actions panel sits on the right. The delete-with-contents flow offers move to parent, move to root, pick an OU, or cancel. Every path except cancel requires explicit confirmation.

## 10. Component conventions

| Need | Component |
|---|---|
| Buttons, text fields, dialogs, menus, lists, tabs, tooltips | Angular Material |
| Grid chrome (column menu, side bar, columns tool panel, status bar) | `@libregrid/menu`, `@libregrid/side-bar`, `@libregrid/columns-tool-panel`, `@libregrid/status-bar` with `@libregrid/material` renderers |
| Entity grids | `ag-grid-angular` + `@libregrid/server-side-row-model` + `@libregrid/server-side-selection` |
| Filters | `@libregrid/set-filter`, `@libregrid/multi-filter`, `@libregrid/advanced-filter`, `@libregrid/filters-tool-panel`, `@libregrid/find` |
| Cell selection and clipboard | `@libregrid/cell-selection`, `@libregrid/clipboard` |
| Org Units tree | `@libregrid/tree-data` |
| .xlsx export | `@libregrid/excel-export`. CSV exports run in workers. Sheets requires a later authorization design |
| Telemetry charts | `@libregrid/integrated-charts`, `@libregrid/sparklines` |

**Grid registration:** LibreGrid is an MIT-licensed monorepo of modules that plug into the AG Grid Community module registry. The app registers only the modules it uses through `@libregrid/angular`. Qualify and pin compatible packages from their published peer dependencies. Historical version numbers do not establish the release baseline. No AG Grid Enterprise dependency. `@libregrid/server-side-row-model` pulls in `@libregrid/row-grouping` and `@libregrid/pivot` automatically. Both stay available for grouping (by school or OU) and for the reporting spec. Entity grids use server-side row models. Keep application drafts outside loaded grid rows. Qualify the chosen LibreGrid modules against this draft contract.

Conventions:

- Primary buttons: accent fill, white text, 4px radius, medium weight. One primary button per view. Secondary buttons render outlined.
- Destructive actions: outlined red (`status-error`) at rest. The confirmation dialog carries the filled red primary button.
- Plain-language labels first: "Suspend users", not "Set suspended = true". Field-level technical names appear in tooltips and in the preview diff, not on the button.
- Jargon fields (2SV, DWD, deprovision) carry an info icon with a one-sentence plain-language tooltip.
- Dialogs: one scrim token (black at 32 percent). Titles are statements with counts ("Delete 12 archived users"), never questions.
- Snackbar: run result ("Suspended 34 users") with a "View job" action. No Undo (gate decision G1).
- Forms and wizards center at 720px max width. One question group per card. Multi-step flows show a progress indicator. The setup wizard follows the GAM7 pattern: one-click-copy values beside direct links, no menu hunting.
- Jobs UI models Google Cloud Console: status chip, duration, brief error, expandable detail. "Completed with errors" is distinct from "Failed".

## 11. Safety patterns

- **Preview before every mutation.** The preview dialog shows exact counts per change ("Suspend 34 users"), the affected entity list (paginated), a stale-data warning when the dataset is stale, and a plain-language impact line ("These users lose access at their next sign-in attempt"). Respect district SIS field ownership. Do not display Classroom ownership without an authorized Classroom integration. Execution requires a second explicit click.
- **Confirm restates scope and count.** Destructive confirms add type-to-confirm friction (wipe, powerwash, delete archived).
- **Destructive device commands add friction.** Reboot, Wipe user data, and Powerwash require the standard preview plus an acknowledgment that names the command. Wipe user data states the data-loss consequence explicitly.
- **Partial success is normal and visible.** Job results show "N succeeded, M failed" with a breakdown by error type. Failed job results never read as total failure beside large success counts ("Completed with errors", 610 moved · 4 skipped · 0 failed). The failure list downloads as a file.
- **Conflict resolution (import):** a flat list, one row per conflicting cell (entity / field / baseline / your edit / current live value), a checkbox per row, check-all in the header. Checked = apply the file's value.
- **No silent writes.** The Jobs page lists every mutation that reaches Google, with its audit record.
- **Retention copy is explicit:** show configured expiry for results and baselines. Permanent logical mutation evidence remains the default. Temporary files follow separate retention.

## 12. States

| State | Treatment |
|---|---|
| Empty entity list | Branded empty state: wordmark, one sentence ("No users match these filters"), one action ("Clear filters") |
| Loading grid data | Skeleton rows inside the grid card. The chip bar and toolbar stay interactive where safe |
| Stale data | The freshness indicator turns `status-warning` with the age ("Synced 26h ago"). A "Refresh now" text action sits beside it. The stale flag comes from the API |
| Sync in progress | Progress and coverage show in the status bar. Existing work continues under collection coordination. No global Cache Sync write freeze |
| Capability failing | An inline banner on the affected page names the specific capability and links to Diagnostics. No generic error text |
| Job running / done / failed | The Jobs page models GCP Console: status chip, duration, brief error, expandable detail. Failure states name the required admin action |
| Live update (SSE) | Ordinary invalidations refresh affected rows. Replay gaps request resynchronization. Preserve drafts, selection, and focus in both paths |

## 13. Optional language assistance

Typed filters, saved searches, and defined reports work without a model.
Language assistance is deferred and optional. Basic installation has no model download, GPU, or inference service prerequisite.
If enabled later, use one entry point that produces validated editable filters.
Show the translation before applying it. Unsupported output and timeouts return to ordinary filtering.
The model cannot execute SQL, issue mutations, or bypass authorization.

Keep inference local under the initial optional profile. Describe actual prompt handling and disable retention by default.
Do not promise that tokenization removes every identifying value from free text.
Generated dashboards and hosted model adapters require separate future design decisions.

## 14. Reference map

| Pattern | Modeled on |
|---|---|
| Jobs list and job detail page | Google Cloud Console operation pages (status, duration, brief errors) |
| Setup wizard copy and layout | GAM7 onboarding (one-click-copy values, direct links, no menu hunting) |
| Org Units tree with counts | Google Admin Console OU picker |
| Bulk action preview + confirm | Google Admin Console bulk-edit flows |
| Overall shell | Standard left-nav / header / content / footer admin console layout |

## 15. Implementation notes

- P0.1 qualifies compatible framework and grid versions. Historical Angular version differences do not establish a release baseline.
- The first grid slice installs the qualified Angular Material, AG Grid Community, and LibreGrid package set.
- Roboto woff2 files land under `frontend/src/assets/fonts/` with a license notice file.
- `frontend/src/theme/tokens.css` exports the Penpot token sets as CSS custom properties (`--cc-*`). The Penpot file is the source of truth. Dark mode activates with `data-theme="dark"` on a root element. Regenerate the file from the Penpot library when a token changes.
- `docs/portfolio/prototype-map.md` maps every board, flow, and demo chain in the Penpot file. Update it when a board moves or a flow changes.

## 16. Open items

- Brand logomark art and the final accent hex. The provisional `#1A73E8` stands until confirmed.
- Qualify device lookup in Phase 4. Expand cross-entity ranking and coverage in Phases 7–9. Never ship a dead search control.
- Dashboard and widget visual language. Belongs to spec 2, not this file.

## 17. Prototype

The Penpot file (`Campus Commander`, page "Users — Grid Page", 68 boards) is the visual reference for all of the above. `docs/portfolio/prototype-map.md` maps every board, flow, and the demo script for the safety chain. The recorded prototype reflects the earlier design-review work list: force password reset semantics, the former single-domain create-user flow, Groups without Dynamic/Static or Owning OU columns, the setup wizard scope list, restructured device command menu, Run Result Snackbar, one health model, compact-only density.

**Prototype caveat:** boards also predate this review integration. Drafts, cross-entity search, account/domain context, credential setup, generated scopes, held jobs, and verification states require alignment. Track 12 owns that work. The current written specification takes precedence over conflicting boards.

## 18. Design-system masters

`Design System — Components` board holds the button masters (Primary, Secondary, Destructive (outlined), Confirm (filled)), state chips, filter chip, icon button, and dialog card. Work item D12 (design review) expands this into the build reference: control states, text fields, banners, snackbars, side sheet, table chrome, empty states.


## 19. Drafts, previews, and result truth

Keep draft values and baseline versions by entity ID and field outside the grid row cache.
Scrolling, filtering, sorting, paging, and SSE must preserve drafts.
Flag changes to affected baseline fields as conflicts. Do not silently replace draft values.

The draft toolbar shows changed counts, Save, Reset, and a pending-rows filter.
Save prepares a frozen preview. Confirmation creates the job.
Reset discards unsubmitted changes. It does not undo Google effects.
Large paste stages edits server-side and returns a draft reference.

Update device uses verified editable fields: annotated fields and OU movement where authorized.
Prepend, Update, and Append apply only to compatible fields.
Compute final approved values during preview so retries do not repeat append or prepend operations.
A one-field preview remains concise while retaining the same authorization and evidence contract.

| Product state | Required presentation |
|---|---|
| Queued behind a type hold | Explain that other jobs are recovering from Google backoff. Show queue state without promising a fixed start time. |
| Accepted job | Show a durable receipt and View job. Do not claim that Google changes already completed. |
| Accepted field update | Show proposed value and verification status alongside observation age. |
| Unknown effect | Show Needs review or reconciliation progress. Preserve successful counts and safe next actions. |
| Device command accepted | Show pending command status. Execution requires provider evidence. |
| Partial result | Show succeeded, failed, skipped, cancelled, and unknown counts without masking completed work. |
| Storage failure | Explain unavailable inputs or results and the recovery action. Preserve existing job evidence. |
| Expired export baseline | Explain that round-trip comparison expired. Offer a new export or explicit new-import path. |

Pending jobs of a held type sort smallest first. Existing jobs continue.
Keep Redis key names, lease revisions, and worker topology out of ordinary task flows.
Diagnostics expose technical details when they help an administrator resolve a failure.

## 20. Search, reports, and setup acceptance

Search results show entity type, identifying fields, authorized context, and observation age.
Support exact and imperfect identifiers through the qualified query contract.
Distinguish cross-entity lookup from find-within-loaded-grid behavior.
Reports show definition, filters, district thresholds, missing-data count, and authorized drill-through.
Missing battery samples never appear as healthy readings.

Setup starts with sample data or read-only access after local preflight.
Generate Google scope text from enabled capabilities and the chosen verified credential profile.
Show customer identity, manual approval, propagation, inventory progress, and restart recovery separately.
Derive progress from observed state. Do not promise a universal one-session connection deadline.

Test complete workflows with occasional IT helpers and district operators.
Include keyboard and screen-reader selection, menus, dialogs, editing, conflict review, jobs, and notifications.
Preserve focus after refresh and coalesce background announcements.
Record errors, assistance, completion, and understanding of destructive effects before confirmation.
