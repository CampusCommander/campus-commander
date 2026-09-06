# Campus Commander — UI Design Guide

**Status:** DRAFT
**Date:** 2026-08-29
**Purpose:** Define the visual language, layout model, and interaction conventions for the Campus Commander frontend. This guide governs how the app looks and behaves visually. Product requirements live in `docs/superpowers/specs/2026-07-07-core-entity-management-design.md`. Engineering decisions live in `docs/architecture/planning-review-topics.md` (decision record 17.18).

---

## 1. Audience

Campus Commander serves two user groups at once:

- **Professional IT admins.** Full-time district IT staff. They work in the app daily, browse 100k+ row datasets, and expect density, speed, and power features (select-all-filtered, column customization, bulk actions).
- **Occasional tech helpers.** A librarian who supports her elementary school's technology. A teacher's aide supporting a middle school class. They open the app a few times a term. They need plain-language labels, guided flows, and a clear explanation of each action's impact before they run it.

Design rules that serve both groups:

- Dense where the data is, airy everywhere else.
- Plain-language action labels first. Technical detail stays available on demand through tooltips and expandable details.
- Every destructive or irreversible action explains its impact in plain language with exact counts before it runs.
- Power features exist but never gate basic flows. An occasional user completes a task without touching an advanced control.

## 2. Design Principles

1. **Dense data, airy chrome.** Entity grids use compact rows so hundreds of rows stay visible. Everything around the grid uses generous white space: roomy padding, clear section breaks, one job per screen region.
2. **Speed made visible.** The app's core promise is instant search, filter, and select against the local cache. The UI surfaces that promise: a freshness indicator on every entity view, live row updates when data changes, sync progress where it matters. A stale dataset says so.
3. **Safety proportional to blast radius.** Every bulk action shows a preview with exact counts. Destructive device commands (REBOOT, WIPE_USERS, REMOTE_POWERWASH) add extra confirmation friction on top of the standard preview.
4. **Familiar enterprise patterns.** The app borrows its patterns from products admins already know: Google Admin Console, GCP Console job pages, GAM7 onboarding, the Google OU picker. Nothing exotic.
5. **One visual system.** Angular Material tokens are the single source of truth for color, type, and elevation. Tailwind handles layout only. The grid inherits the same tokens through `@libregrid/material`.

## 3. Brand

- **Wordmark:** "Campus Commander" in Roboto Medium, placed at the top of the left navigation panel. A graphical logomark is an open item (Section 14).
- **Accent color:** a single blue accent drives primary actions, active states, links, and focus rings. Provisional value `#1A73E8` pending brand confirmation. One accent only. Semantic colors (Section 5) never double as decorative accents.
- **Iconography:** Material Symbols is the only icon system in the app. No emoji, no second icon set, no hand-drawn SVGs outside the grid theme.
  - Sizes: 24px for navigation and toolbars, 20px for inline actions, 16px for dense list contexts.
  - Navigation icons use the outlined weight at rest and the filled weight on the active item.
  - One weight per context. Never mix weights inside a single toolbar.
- **Brand presence rules:** wordmark in the nav header. Accent color on all primary actions and active states. Branded empty states (wordmark + one sentence of guidance + one next action). App version in the footer.

## 4. Layout & App Shell

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

### Left navigation panel

- Width: 240px expanded, 56px icon rail when collapsed. The collapse state persists per user.
- Top: the brand wordmark, with the connected Workspace domain name below it in caption size and secondary color. The domain stays visible at all times because the whole app operates on one domain.
- Items in order, each with a Material Symbol:

| Item | Icon |
|---|---|
| Users | `people` |
| Devices | `laptop_chromebook` |
| Groups | `group` |
| Org Units | `account_tree` |
| Jobs | `history` |
| Settings | `settings` |

- Active item: accent-tinted background, filled icon, 3px accent indicator bar on the left edge.
- The Org Units tree lives inside the Org Units page (tree pane + detail panel), matching the Google OU picker pattern. It is not a permanent app-level pane.

### Header (main column only)

The header starts to the right of the navigation panel. It does not span over it.

- Left: the page title (e.g., "Users", "Job: bulk_update_devices"). A subtitle line under the title carries context such as the entity count and freshness.
- Right: help link, theme toggle (light/dark), user menu (initials avatar, display name, role label, sign out).
- Height 64px. Card surface in light mode, elevated dark surface in dark mode.

### Footer (full width)

The footer spans the full window width, including under the navigation panel.

- Left: app version and build identifier.
- Right: connection health indicator. A status dot (green = all capability areas pass, amber = partial, red = failing) with a tooltip that links to the connection diagnostics page (spec: permanent connection health diagnostic).
- Height 40px. Subtle top border, no shadow.

### Main content area

- Background: the app surface color (Section 5). Content sits on cards.
- Page padding: 24px. Grid pages use the full available width. Form and wizard pages center their content at a 720px max width for readability.
- Vertical rhythm between sections: 32px. Card interior padding: 16px.

## 5. Color System

Light + dark from day one. Material `light-dark()` tokens define every color. The grid follows the app automatically through the `@libregrid/material` bridge.

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

Entity state chips use these colors: suspended → error, archived → neutral gray, battery "Replace Soon" → warning, battery "Replace Now" → error, healthy → success. A state chip is a small rounded pill with label text. Color never carries meaning alone: every colored indicator carries a text label (accessibility).

Contrast floor: WCAG AA for all text and interactive elements in both modes.

## 6. Typography

- **Face:** Roboto, self-hosted as woff2 files inside the app bundle. No CDN fetch. Installs must work offline (spec requirement), so the fonts ship with the artifact.
- Weights: 400 (body), 500 (titles, buttons, wordmark), 700 (page titles only).

| Level | Size / line-height | Use |
|---|---|---|
| Display | 24px / 32px | Page titles |
| Title | 16px / 24px | Card titles, dialog titles |
| Body | 14px / 20px | Default text, grid cells |
| Caption | 12px / 16px | Metadata, status bar, footer, chips |

- Data columns in grids use tabular numerals (`font-variant-numeric: tabular-nums`) so digits align vertically.
- Identifiers, hashes, and file paths render in the system monospace stack at caption size.
- Minimum interactive target height: 24px. Grid row controls drop to 20px in compact mode. This is a mouse-primary tool.

## 7. Density & Spacing

- **Grid rows:** compact by default. 32px row height, 12px/16px cell text. V1 ships compact only (gate decision G2, 2026-09-02). No density control appears in the UI.
- **Spacing scale:** 4px base. Standard steps: 4, 8, 12, 16, 24, 32, 48.
- **Radii:** 4px for controls and cards. Full radius (999px) for chips and status dots.
- **Elevation:** low. Cards sit on the app background with a 1px border and no shadow in light mode. Dark mode uses surface lift instead of shadows. Shadows appear only on floating layers: one level for menus, two for dialogs. Dialogs and menus share one scrim token: black at 32 percent opacity.
- **White space is the default.** A page region holds one job. Cards do not nest more than one level. If a screen needs a scrollbar inside a card, the layout is wrong.

## 8. Theming Architecture

- Angular Material tokens are the single source of truth for color, typography, and elevation.
- `provideLibreGridMaterialTheme()` (from `@libregrid/material`) maps those tokens onto the grid's Quartz theme. It follows `light-dark()` changes live. No manual grid theme configuration exists.
- Tailwind CSS handles layout only: flex/grid placement, spacing, sizing. Tailwind never defines a second color or type scale. Layout classes reference Material token values through CSS custom properties.
- Dark mode: the app follows `prefers-color-scheme` by default. The header toggle overrides per user and persists the choice. The grid follows automatically.
- Custom tokens (accent, entity state colors) extend the Material theme in one place under `frontend/src/theme/`. No component-level color overrides.

## 9. Grid Page Anatomy

Every entity page (Users, Devices, Groups) shares one canonical layout, top to bottom:

1. **Chip filter bar.** Full width, 16px below the header. Active filters render as chips (field + value + remove `x`). A trailing "Add filter" control opens a field picker. The chip bar and the natural-language input produce the same structured filter object (spec).
2. **Toolbar row.** Left: the bulk action menu (primary button, accent), enabled only when a selection exists. Right: the selection summary ("142 selected", or "All rows matching: suspended = yes"), view options (columns), export menu.
3. **Grid card.** Card surface, 1px border. Server-side row model (`@libregrid/server-side-row-model`), compact rows. A checkbox column for selection. Writable fields show an edit affordance on hover. A single-cell edit writes through the same path as a single-row bulk action (per-cell write-through).
4. **Status bar.** Bottom of the grid card, caption size: total row count ("128,431 users"), freshness indicator with status color ("Synced 2h ago"), sync progress while one runs.

Selection visualization follows decision 17.8 (server-side selection, Redis-backed):

- A selected row gets the `surface-selected` background. The grid holds per-row flags for the rows it currently caches (`@libregrid/server-side-selection`).
- "Select all filtered" shows the criteria, not an ID list. The toolbar reads "All rows matching: [criteria]" with a count when the API returns one. A banner under the toolbar states the full criteria and offers "Clear selection".
- The selection persists until explicitly cleared (decision 17.8). It survives page changes, filter changes within the same tab, and grid re-renders.

Org Units page: a tree pane on the left (`@libregrid/tree-data`, Google OU picker pattern) with entity counts per node computed from the cache. A detail and actions panel sits on the right. The delete-with-contents flow follows the spec (move to parent / move to root / pick an OU / cancel, each path confirmed).

## 10. Component Conventions

| Need | Component |
|---|---|
| Buttons, text fields, dialogs, menus, lists, tabs, tooltips | Angular Material |
| Grid chrome (column menu, side bar, columns tool panel, status bar) | `@libregrid/menu`, `@libregrid/side-bar`, `@libregrid/columns-tool-panel`, `@libregrid/status-bar` with `@libregrid/material` renderers |
| Entity grids | `ag-grid-angular` + `@libregrid/server-side-row-model` + `@libregrid/server-side-selection` |
| Filters | `@libregrid/set-filter`, `@libregrid/multi-filter`, `@libregrid/advanced-filter`, `@libregrid/filters-tool-panel`, `@libregrid/find` |
| Cell selection and clipboard | `@libregrid/cell-selection`, `@libregrid/clipboard` |
| Org Units tree | `@libregrid/tree-data` |
| .xlsx export | `@libregrid/excel-export`. CSV and Sheets export run through the API |
| Telemetry charts | `@libregrid/integrated-charts`, `@libregrid/sparklines` |

Conventions:

- Primary buttons: accent fill, white text, 4px radius, medium weight. One primary button per view.
- Destructive actions: outlined red (`status-error`) at rest. The confirmation dialog carries the filled red primary button.
- Plain-language labels first: "Suspend users", not "Set suspended = true". Field-level technical names appear in tooltips and in the preview diff, not on the button.
- Jargon fields (2SV, DWD, deprovision) carry an info icon with a one-sentence plain-language tooltip.
- Forms and wizards center at 720px max width. One question group per card. Multi-step flows show a progress indicator. The setup wizard follows the GAM7 pattern: one-click-copy values beside direct links, no menu hunting (spec).

## 11. Safety Patterns

- **Preview before every bulk action.** The preview dialog shows exact counts per change ("Suspend 34 users"), the affected entity list (paginated), and a plain-language impact line ("These users lose access at their next sign-in attempt"). Execution requires a second explicit click.
- **Destructive device commands add friction.** REBOOT, WIPE_USERS, and REMOTE_POWERWASH require the standard preview plus an acknowledgment that names the command. WIPE_USERS states the data-loss consequence explicitly.
- **Partial success is normal and visible.** Job results show "N succeeded, M failed" with a breakdown by error type (decision record: partial success is expected). The failure list downloads as a file.
- **Conflict resolution (import):** a flat list, one row per conflicting cell (entity / field / baseline / your edit / current live value), a checkbox per row, check-all in the header (spec). Checked = apply the file's value.
- **No silent writes.** The Jobs page lists every mutation that reaches Google, with its audit record.

## 12. States

| State | Treatment |
|---|---|
| Empty entity list | Branded empty state: wordmark, one sentence ("No users match these filters"), one action ("Clear filters") |
| Loading grid data | Skeleton rows inside the grid card. The chip bar and toolbar stay interactive where safe |
| Stale data | The freshness indicator turns `status-warning` with the age ("Synced 26h ago"). A "Refresh now" text action sits beside it. The stale flag comes from the API (spec) |
| Sync in progress | Progress shows in the status bar. Other jobs queue behind the Cache Sync lock (decision 17.15). The UI shows the queued state and never blocks input |
| Capability failing | An inline banner on the affected page names the specific capability and links to diagnostics. No generic error text |
| Job running / done / failed | The Jobs page models GCP Console: status chip, duration, brief error, expandable detail (spec). Failure states name the required admin action |
| Live update (SSE) | Affected rows refresh in place after a `resync` event. No full-grid reload. A subtle row flash marks changed rows |

## 13. Reference Map

| Pattern | Modeled on |
|---|---|
| Jobs list and job detail page | Google Cloud Console operation pages (status, duration, brief errors) |
| Setup wizard copy and layout | GAM7 onboarding (one-click-copy values, direct links, no menu hunting) |
| Org Units tree with counts | Google Admin Console OU picker |
| Bulk action preview + confirm | Google Admin Console bulk-edit flows |
| Overall shell | Standard left-nav / header / content / footer admin console layout |

## 14. Open Items

- Brand logomark art and the final accent hex. The provisional `#1A73E8` stands until confirmed.
- Global search in the header. Deferred to a later slice.
- Dashboard and widget visual language. Belongs to spec 2, not this guide.

## 15. Implementation Notes

- The workspace runs Angular 22. The architecture doc says "Angular 20". Version alignment remains an open item (planning checklist Section 1). This guide targets the workspace version.
- `@angular/material`, `ag-grid-angular`, `ag-grid-community@~36.1`, and the `@libregrid/*` packages are not yet installed in `frontend`. The first grid slice installs them.
- Roboto woff2 files land under `frontend/src/assets/fonts/` with a license notice file.
- Current agent rules and exact design tokens live in [docs/ui](../../ui/README.md).
- The current visual reference lives in the [Figma prototype map](../../portfolio/prototype-map.md).
