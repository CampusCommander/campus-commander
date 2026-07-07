# Campus Commander — Spec 1: Core Entity Management

**Status:** DRAFT — brainstorming in progress. Sections marked `OPEN` are still being decided; everything else reflects a settled decision from design discussion.

## Product Overview

Campus Commander is a self-hosted, single-tenant web app that gives Google Workspace admins (K-12 school districts) a fast, responsive way to manage Workspace assets in bulk — replacing the slow/limited bulk workflows in Google's own Admin Console. It leans on extensive local caching so search/filter/bulk-select feel instant even at large scale.

This is the first of three specs:
1. **Core entity management** (this doc) — caching, chip-filter/grid UI, NL filtering, inline editing, bulk actions, import/export, over Users/Devices/Groups/OrgUnits.
2. **NL-driven reporting/status dashboard** — status/stats/health widgets; users can natural-language "vibecode" small custom widgets onto the dashboard. (Not yet designed.)
3. **Widget gallery** (stretch goal) — sharing/discovering dashboard widgets across deployments. (Not yet designed.)

## Deployment & Tenancy Model

- Self-hosted; runs entirely in the environment of the school's/district's choosing.
- **Single tenant = one Google Workspace domain.** Districts that run one Workspace domain for the whole district (e.g. LAUSD, CPS) get one deployment. Districts where each school runs its own domain (e.g. NYC DOE) need one deployment per school domain. No cross-domain aggregation in v1.
- Scale target: up to hundreds of thousands of users/devices across dozens of schools within a single domain.

## Authentication & Authorization

- **Google-side auth:** a single service account with domain-wide delegation (DWD), configured once by the district's Google super admin. This service account is the sole actor against Google APIs.
- **App-side auth/RBAC:** Campus Commander has its own internal roles/permissions system. Admins using the app do **not** need Google admin roles — their access is scoped by Campus Commander's own RBAC, decoupled from their actual Google Workspace privileges.
- Rationale: avoids requiring every app user to hold Google admin rights, and DWD avoids per-user OAuth consent review burden vs. a refresh-token-per-admin model.

## Tech Stack

- **Backend:** NestJS (TypeScript)
- **Frontend:** React (TypeScript) — chosen over Angular specifically because the dashboard/widget-gallery specs (2 & 3) need a rich ecosystem for dynamically rendering generated UI/charts, where React dominates.
- **Database:** Postgres — primary cache/store for synced entity data.
- **Queue/cache:** Redis + BullMQ — background sync jobs, bulk-action job queue.
- **Monorepo:** Nx — shares types (entity schemas, filter DSL, future widget data contracts) between backend and frontend.
- **Deployment shape:** Docker Compose is the baseline self-host story (Postgres + Redis + API + Web + workers).

## Chip Filter / Grid UI

- Traditional chip-filter + data grid as the primary interface for browsing/selecting entities.
- Grid supports **inline editing** of any writable field, in addition to bulk actions — single-cell edits write through the same path as a single-row bulk action.

## Natural Language Filtering

- NL query is translated into the **same structured filter schema** the chip filter bar produces (not a separate query language) — NL is just an alternate way to construct the same filter object.
- **Privacy design:** literal values in the user's NL query are anonymized into tokens before being sent to the LLM; the LLM only ever sees the query text (tokenized), the filter DSL, and the entity schema/field names — never real data values. The returned filter is de-anonymized (tokens swapped back to real values) locally.
- **v1 ships with a local small model only** (e.g. a quantized 1–3B model such as Llama/Phi/Qwen via llama.cpp/Ollama) for NL → filter DSL translation. This is a narrow, constrained structured-output task, which small models handle well, and it keeps the flow fully self-hosted (nothing leaves the deployment, not even anonymized tokens).
- The LLM backend is architected behind a pluggable adapter interface; a hosted-API adapter (e.g. Claude) is a deferred v2 addition, not built in v1.
- Note: the dashboard's NL-widget-generation feature (spec 2) is a much less constrained generation task and will likely need a frontier hosted model regardless — that's a separate decision for that spec.

## Bulk Action Safety

For every bulk action (and the import flow, see below):
- **Preview/dry-run is a must-have for v1** — show the exact diff of what will change before committing.
- **Audit log is a must-have for v1** — durable record of who ran what, on which entities, when.
- **Undo/rollback is a stretch goal**, not required for v1 (not all Google API changes are cleanly reversible, e.g. password resets).

Explicitly excluded from bulk tooling in v1: granting super-admin (`makeAdmin`) — too high blast-radius for a bulk flow; kept out of scope entirely (or at most a single-target, extra-confirmation action outside the bulk system, TBD if ever added).

## Import / Export / Create (applies to all entity types)

A single general mechanism, first designed against Users but intended to generalize to Devices/Groups/OrgUnits:

- **Export** to CSV or a Google Sheet (via Drive picker so users can select/target files in their Drive; also supports plain CSV upload/download for local editing). Each exported row includes a hidden hash column computed from that row's full field set at export time.
- **Reimport, pass 1 (cheap filter):** recompute each row's hash from the reimported file. Unchanged hash → row untouched → skip entirely, no diff work, no live refetch. Keeps large reimports tractable at scale (most rows in a typical export go untouched).
- **Reimport, pass 2 (hash-mismatched rows only):** per-**cell** three-way compare — baseline value (at export), the user's value in the reimported file, and the entity's current live value (refetched, since live data may have drifted independently of the user's edit). Only cells that are genuine edits get queued; a live-drift-without-user-edit is not touched; a cell edited by the user AND drifted live is a **conflict** requiring resolution.
- **Two-step execution:** a **validation step** shows data issues, the exact changes to be applied (never whole-row overwrites — only changed fields), and any conflicts to resolve; then an **execution step** that only runs once data is valid and the admin has explicitly accepted the diff.
- **Conflict resolution UI:** the validation view is a flat list, one row per conflicting cell (entity / field / baseline / your edit / current live value), with a **checkbox per row and a header check-all/deselect-all**. Checked = apply the sheet's value; unchecked = leave the live value untouched. This gives per-cell precision while still letting an admin resolve many conflicts at once via select-all.
- **Entity creation via import:** a row with no matching existing entity is treated as a create. Validation surfaces "N new entities to create" separately from "M updates," checked against that entity type's required fields.
- **Entity creation via in-app UI:** a dedicated create form also exists, independent of import.
- For Users specifically: bulk-created users via import get an **auto-generated temporary password** with `changePasswordAtNextLogin: true` — the sheet never needs to carry a plaintext password.

## Per-Entity Design

### Users
- **Google resource:** Admin SDK Directory API `Users`.
- **Cached/filterable fields:** `primaryEmail`, `name.givenName/familyName/fullName`, `orgUnitPath`, `suspended` + `suspensionReason`, `archived`, `lastLoginTime`, `creationTime`, `isEnrolledIn2Sv`, `organizations[]` (dept/title), `customSchemas` (schools often store grade level, student ID, etc. here), `aliases[]`.
- **Bulk actions:**
  - Suspend / reactivate (`suspended`)
  - Force password reset (`changePasswordAtNextLogin: true`, optionally paired with `signOut` to revoke active sessions immediately rather than at next voluntary login)
  - Move OrgUnit (`orgUnitPath`)
  - Archive / unarchive (`archived`)
  - Force sign-out (`signOut` method) as its own standalone bulk action
- **Explicitly excluded from v1 bulk tooling:** `makeAdmin` (granting super-admin) — too high blast-radius.
- **Group membership is NOT a Users field** — it lives on the Groups API's `Members` sub-resource. "Add/remove group membership" as a Users-initiated bulk action is really "select users → select target group → Members insert/delete," a cross-entity action, not a `users.patch` call.
- **Cross-reference to Classroom (shelved, see below):** when suspending/deleting a user, the preview step should flag if that user owns active Classroom courses, so admins don't silently orphan courses.

### Devices (ChromeOS)
- **Google resource:** Admin SDK Directory API `ChromeOsDevice`.
- **Cached/filterable fields:** `serialNumber`, `status`, `model`, `orgUnitPath`, `annotatedUser`/`annotatedLocation`/`annotatedAssetId`, `notes`, `lastSync`, `osVersion` + `osVersionCompliance`, `diskVolumeReports[]`/`diskSpaceUsage`, `systemRamTotal`, `supportEndDate` + `willAutoRenew`, `recentUsers[]` (most recent), `firstEnrollmentTime`/`lastEnrollmentTime`, `deprovisionReason`.
- **Writable surface is narrow:** only `annotatedUser`, `annotatedLocation`, `annotatedAssetId`, `notes`, `orgUnitPath` are patchable. Everything else is read-only device-reported telemetry — visible/filterable, never inline-editable.
- **Bulk actions:**
  - Move OrgUnit — via `moveDevicesToOu` (natively bulk, one call for many devices)
  - Disable / re-enable / deprovision — via `BatchChangeChromeOsDeviceStatus` (natively bulk; deprecated `action` method not used). Deprovision likely requires a `deprovisionReason` — surfaced as a required field in the bulk preview when selected.
  - Annotate (asset tag / location / assigned user / notes)
- **Remote commands (async, separate API surface — `customer.devices.chromeos.commands`):**
  - In scope for v1: **REBOOT**, **WIPE_USERS**, **REMOTE_POWERWASH**. The latter two are destructive (data loss) and get extra confirmation friction on top of the standard preview+confirm pattern.
  - Deferred/out of scope for v1: `TAKE_A_SCREENSHOT`/`SET_VOLUME` (Kiosk-only), `DEVICE_START_CRD_SESSION` (single-device/interactive, doesn't fit bulk), `CAPTURE_LOGS`/`FETCH_SUPPORT_PACKET`/`FETCH_CRD_AVAILABILITY_INFO` (diagnostic, not core).
  - Commands are asynchronous: issuing returns an acknowledgment that the command was accepted, not that it executed. Lifecycle: `PENDING` → `SENT_TO_CLIENT` → `ACKED_BY_CLIENT` → `EXECUTED_BY_CLIENT`, or `EXPIRED`/`CANCELLED`, each with a `commandExpireTime`. This requires ongoing status polling/tracking per issued command — the motivating case for the standardized jobs/execution pipeline (see Open Questions).
- **Telemetry (separate API — Chrome Management Telemetry API, `chromemanagement.googleapis.com`, requires Chrome Enterprise/Education Upgrade licensing on devices):**
  - In scope: battery health specifically (Google pre-buckets it: Normal >80% capacity, Replace Soon 75–80%, Replace Now <75%), plus openness to other telemetry values (CPU, memory, storage, network) as they prove valuable.
  - **Battery gets a bounded time-series**: raw readings kept for a rolling window, plus longer-retained periodic rollups (e.g. daily min/max/avg), since battery health is a slowly-degrading trend metric worth charting over time.
  - **All other telemetry (CPU, memory, storage, network, etc.) is latest-snapshot only** — no historical retention, to bound storage growth at target scale (100k+ devices reporting every 10–60 minutes would be unsustainable to store in full).

### Groups
- **Google resources:** Admin SDK Directory API `Groups` + `Members` sub-resource, plus the **Group Settings API** (join/post/moderation policy). Explicitly **not** Cloud Identity's dynamic/security groups (a different API surface) and **nothing related to group conversation/messaging content** (archives, discussion content) — purely directory-level identity, settings, and membership management.
- **Cached/filterable fields:** `email`, `name`, `description`, `directMembersCount`, `aliases[]`, plus Group Settings fields (join/post/moderation policy — exact field list TBD when this entity is implemented).
- **Membership:** a distinct sub-resource per group — `email`, `role` (OWNER/MANAGER/MEMBER), `type` (USER/GROUP/CUSTOMER/EXTERNAL), `delivery_settings`.
- **Actions:** create/delete/update group (identity + settings), add/remove members.
- **No native bulk method for membership** — insert/delete are one-call-per-member. Bulk "add 200 students to a group" means 200 rate-limited individual calls — routed through the jobs/execution pipeline (see Open Questions).

### OrgUnits
- **Google resource:** Admin SDK Directory API `OrgUnits`.
- **Fields:** `name`, `description`, `orgUnitId` (stable), `orgUnitPath` (derived from name + `parentOrgUnitPath`, up to 35 levels deep), `parentOrgUnitId`/`parentOrgUnitPath`.
- **Structurally different from other entities:** a small (dozens–low hundreds) hierarchical tree, not a flat bulk-manageable list of thousands. Likely UI: a **tree view** (like Google's own OU picker) used for navigation and as a filter source for the Users/Devices grids, showing computed entity counts per OU (computed by Campus Commander from the cache, not returned by Google).
- **Actions:** create, rename, move/reparent, delete.
- **Delete-with-contents flow:** warn if the OU has nested entities/sub-OUs; offer **move to parent**, **move to root**, **move to a picked OU** (OU picker), or **cancel**. Every path except cancel requires an explicit confirmation step.
- No dedicated bulk method — "move entities into an OU" is a Users/Devices bulk action (already covered), not an OrgUnit-resource action.

### Classroom — SHELVED
- Explicitly out of scope for v1 and likely for this project's near-term roadmap entirely.
- Rationale: Classroom rostering at real scale is normally driven by SIS (Student Information System) sync (PowerSchool, Infinite Campus, OneRoster, etc.), not manual admin bulk-editing — a genuinely different problem (integration with an external system of record) from everything else in this spec (IT admin directly manipulating Workspace directory objects). If revisited, treat it as its own separate project, likely centered on SIS sync rather than manual roster CRUD.
- The one retained cross-reference: the Users suspend/delete bulk-action preview should flag if the target user owns active Classroom courses (see Users section above).

## Open Questions (not yet decided)

### Sync / Freshness Strategy — `OPEN`
- Google's Directory API supports push notifications (`watch`) as an alternative to polling, but this requires a publicly reachable HTTPS webhook endpoint — not guaranteed for all self-hosted deployments (some will be fully on-prem/firewalled). **Working assumption: polling is the baseline; push notifications are an optional accelerator for deployments that can support them, not a core dependency.**
- Still undecided: acceptable staleness for changes made *outside* Campus Commander (via Google's own console or other tools) before the cache catches up. Options under discussion: aggressive (~1–5 min polling), moderate (~15–30 min), or coarse (hourly+). Also undecided: whether freshness should differ between what an admin is actively viewing (fast/on-demand refresh) vs. a background full-cache sweep.
- Also unaddressed: initial full-sync/bootstrap strategy for a brand-new deployment at scale, and rate-limit/quota-aware pagination for very large districts.

### Standardized Execution / Jobs Pipeline — `NOT YET STARTED`
- Needed for: async device command tracking (poll/track command lifecycle per device), rate-limited multi-call operations (group/course membership changes, anything without a native bulk API method), and the bulk-action/import execution steps generally.
- To be designed after the sync/freshness strategy is settled.

## Deferred / Explicitly Out of Scope for v1
- Hosted LLM adapter for NL filtering (pluggable interface exists, but only the local-model implementation ships in v1).
- Undo/rollback for bulk actions (stretch goal).
- `makeAdmin` (super-admin grant) in bulk tooling.
- Cloud Identity dynamic/security groups.
- Group conversation/messaging content (archives, discussions).
- All Classroom course content/LMS features (`courseWork`, `courseWorkMaterials`, `announcements`, `topics`, `gradebookSettings`) and roster management generally (see Classroom — Shelved above).
- Multi-domain support within a single deployment.
- Dashboard/widget-builder features (spec 2) and widget gallery (spec 3) — separate specs, not yet designed.
