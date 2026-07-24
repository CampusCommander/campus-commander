# Campus Commander — Spec 1: Core Entity Management

**Status:** DRAFT — design discussion. Sections marked `OPEN` are still being decided; everything else reflects a settled decision from design discussion.

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
- **Deployment shape:** Docker Compose is the baseline self-host story (Postgres + Redis + API + Web + workers). See Deployment & Install Experience below.

## Deployment & Install Experience

Goal: the same artifact should work identically whether an admin is kicking the tires on a laptop, or standing up a production instance on bare metal, an on-prem VM, or a cloud VM — and trying it out should be trivially reversible.

- **Packaging:** Docker Compose is the single artifact for every target — local trial (Windows via Docker Desktop/WSL2, or Linux via Docker Engine), on-prem VM, bare metal, and cloud VM. One compose file behaves identically everywhere; no per-platform builds.
- **Install script:** detects whether Docker is present. Auto-installs on Linux via a `get.docker.com`-style one-liner (safe to run non-interactively). On Windows/Mac, can't silently install — points the admin to the Docker Desktop download instead.
- **First-run setup wizard:** a web UI replaces manual `.env`/YAML editing. Walks the admin through connecting their Workspace domain (service-account JSON upload) and creating the first Campus Commander admin login. See Google Workspace Bootstrapping below for what that setup actually requires on the Google side.
- **State isolation & reversibility:** all persistent state (Postgres data, Redis data, uploaded service-account JSON, wizard-entered config) lives in named Docker volumes scoped to a single Compose project — never written elsewhere on the host. `docker compose down` pauses; `docker compose down -v` fully and cleanly removes everything, host untouched. The one real "oops" risk is a host port conflict (5432/6379/3000/etc.) — the installer/wizard should detect this and let the admin remap ports rather than fail cryptically.
- **Trial = real data, no in-app demo mode.** If an admin is already running Docker Compose, the local trial connects a real (possibly scope-limited) service account from day one rather than a synthetic dataset — more useful for evaluating against their actual directory shape. A **hosted public demo with fake seeded data** (no install, no credentials) may exist as a separate pre-install "look before you leap" step on the marketing site — that's a marketing-site asset, explicitly **out of scope for this spec**.
- **Cloud path:** a GCP Marketplace listing wraps the same Compose stack on a GCE VM (one-click deploy for the common case, since target customers are already GCP Workspace shops) — not a separately built/maintained image.
- **Production is not a "promotion" of trial** — it's a fresh instance of the same artifact on the real server, pointed at the real service account. No migration/data-carryover step needed between trial and production.
- Considered and rejected for v1: pre-built VM appliance images (OVA/qcow2/VHDX per hypervisor) — would give the smoothest on-prem-VM-only experience, but multiplies build/maintenance cost across image formats and doesn't by itself solve the bare-metal case, so Compose + installer script covers more ground for the effort.
- Considered and rejected for v1: single all-in-one container (API+worker+web+embedded Postgres/Redis in one image) — fights Docker/Postgres best practice around data durability, backups, and independent restart/scaling of workers vs. API; doesn't meaningfully reduce friction once a setup wizard exists.

## Google Workspace Bootstrapping

Goal: connecting Campus Commander to a district's Workspace domain should require as close to zero manual Google Cloud Console / Admin Console work as possible, be resumable across a wait that ranges from ~30 minutes (typical) to 10-12 hours (mega districts), and clearly distinguish the handful of steps Google's own security model makes irreducibly manual from everything else, which should be automated.

- **One-time bootstrap OAuth identity.** Before any service account exists, the wizard has the admin do a standard "Sign in with Google" consent (their own identity, not Campus Commander's eventual service account) granting `cloud-platform` scope plus Directory user/role-management scope. This token is used only to perform the one-time provisioning below and is discarded once the service account + domain-wide delegation (DWD) are live — it is a distinct, temporary auth surface from the steady-state service-account model described in Authentication & Authorization above.
- **Fully automated using that bootstrap identity (no Console visit required):**
  - Pick an existing GCP project or create a new one (Cloud Resource Manager API).
  - Detect which required APIs are enabled and enable any that are missing (Service Usage API): Admin SDK, Groups Settings API, Chrome Management API.
  - Link an *existing* billing account if the admin already has one (Cloud Billing API: `billingAccounts.list` + `projects.updateBillingInfo`). Creating a **brand-new** billing account is not possible via API — attaching a first payment method is PCI-gated and Console-only — so this is the one billing-related manual step, and only applies to a district with no existing GCP billing account at all. Called out now since Workspace/Cloud APIs moving toward paid tiers is a plausible near-future forcing function.
  - Create the service account and its key. The generated JSON key is held server-side directly — it never has to be downloaded to or handled from the admin's local filesystem.
  - Create the dedicated non-human service-admin Workspace user (e.g. `campus-commander-admin@district.org`) and a custom admin role bundling exactly the User management / Group management / Device management / Org unit management privileges — not full Super Admin, and not impersonation of any real staffer's personal account. Rationale: bounds blast radius if the service account key ever leaks, survives staff turnover, and keeps every Campus Commander-driven change cleanly attributable in Google's own admin audit log, distinct from a human admin's direct console changes. This is the account the service account impersonates (the `sub` claim) on every subsequent API call.
- **Irreducibly manual — Google security gates with no API path:**
  1. A Super Admin clicking **Authorize** on the domain-wide delegation page (`admin.google.com/ac/owl/domainwidedelegation`), pasting the Client ID and scope list the wizard generated. The wizard presents these as one-click-copy values next to a direct link to that page — this "clean copy/paste, direct link, no menu hunting" pattern is deliberately modeled on GAM7's onboarding flow, which does the same thing (confirmed no URL-parameter prefill trick exists even there — don't design around one).
  2. If the district has **multi-party approval** enabled (a Workspace security feature, off by default, available with 2+ super admins: authorizing a DWD client ID requires a *second* super admin's sign-off under Security → Multi-party approval before it takes effect) — a second human's action, not just backend propagation. The waiting-screen copy should mention this explicitly as a possible cause of a long wait, distinct from Google's own propagation delay.
  3. Attaching a payment method to a brand-new billing account, per above, only if no existing billing account was found.
- **Scan-and-wait.** Once the admin confirms they've authorized it, a durable background job — the first concrete use case for the deferred jobs/execution pipeline — polls by attempting real impersonated API calls, **broken out per capability area** (Users, Devices, Groups, OrgUnits, Telemetry) rather than one opaque check, so a partial misconfiguration (e.g. Groups Settings scope missing) is immediately diagnosable rather than presenting as a generic "still waiting." Polling backs off over time to suit the observed real-world range (tight polling in the first ~15 minutes, backing off over hours), capped around Google's own stated 24h worst case before flagging for support. The job must be resumable across app/browser restarts — the admin can close the tab and come back later to a persistent setup-status view, not a modal they have to babysit — and should notify on success via email and in-app, since an hours-long wait means they've likely moved on.
- **Permanent connection health diagnostic.** The same per-capability-area PASS/FAIL check used during onboarding remains reachable from within the app afterward — useful if a scope is later revoked, edited, or DWD needs re-authorization, giving a precise "here's exactly what's broken" view instead of generic API error messages surfacing during normal use.

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
  - Commands are asynchronous: issuing returns an acknowledgment that the command was accepted, not that it executed. Lifecycle: `PENDING` → `SENT_TO_CLIENT` → `ACKED_BY_CLIENT` → `EXECUTED_BY_CLIENT`, or `EXPIRED`/`CANCELLED`, each with a `commandExpireTime`. This requires ongoing status polling/tracking per issued command — the motivating case for the standardized jobs/execution pipeline (see Standardized Execution / Jobs Pipeline).
- **Telemetry (separate API — Chrome Management Telemetry API, `chromemanagement.googleapis.com`, requires Chrome Enterprise/Education Upgrade licensing on devices):**
  - In scope: battery health specifically (Google pre-buckets it: Normal >80% capacity, Replace Soon 75–80%, Replace Now <75%), plus openness to other telemetry values (CPU, memory, storage, network) as they prove valuable.
  - **Battery gets a bounded time-series**: raw readings kept for a rolling window, plus longer-retained periodic rollups (e.g. daily min/max/avg), since battery health is a slowly-degrading trend metric worth charting over time.
  - **All other telemetry (CPU, memory, storage, network, etc.) is latest-snapshot only** — no historical retention, to bound storage growth at target scale (100k+ devices reporting every 10–60 minutes would be unsustainable to store in full).

### Groups
- **Google resources:** Admin SDK Directory API `Groups` + `Members` sub-resource, plus the **Group Settings API** (join/post/moderation policy). Explicitly **not** Cloud Identity's dynamic/security groups (a different API surface) and **nothing related to group conversation/messaging content** (archives, discussion content) — purely directory-level identity, settings, and membership management.
- **Cached/filterable fields:** `email`, `name`, `description`, `directMembersCount`, `aliases[]`, plus Group Settings fields (join/post/moderation policy — exact field list TBD when this entity is implemented).
- **Membership:** a distinct sub-resource per group — `email`, `role` (OWNER/MANAGER/MEMBER), `type` (USER/GROUP/CUSTOMER/EXTERNAL), `delivery_settings`.
- **Actions:** create/delete/update group (identity + settings), add/remove members.
- **No native bulk method for membership** — insert/delete are one-call-per-member. Bulk "add 200 students to a group" means 200 rate-limited individual calls — routed through the jobs/execution pipeline (see Standardized Execution / Jobs Pipeline).

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

## Sync & Freshness Strategy

Polling-based; Google's push notifications (`watch`) require a publicly reachable HTTPS webhook, which fully on-prem/firewalled deployments can't guarantee, so push is not a core dependency (out of scope for v1; could be revisited as an optional accelerator later).

- **Trigger model: view-driven + nightly backstop.** Opening a grid/view checks that entity type's cache freshness against its staleness threshold and enqueues a refresh if stale — quota spend concentrates on data admins actually look at. A **fixed nightly pass** (admin-configurable time, default off-hours ~2am local) runs a full sweep of every entity type unconditionally, so no entity type ever goes more than ~24h without refresh, by construction — no "scan for stale" bookkeeping needed.
- **Freshness is per entity type, not per record.** One freshness timestamp per collection; a full sweep refreshes the whole collection anyway, so per-record freshness bookkeeping buys nothing. Single-record detail views may do a targeted `get` on open.
- **Default staleness thresholds** (admin-tunable per install): Users **1h**, Devices **4h**, Groups + members **1h**, OrgUnits **12h** — reflecting how fast each actually changes (users/group-membership churn during enrollment windows; device inventory moves slowly; OU structure is near-static).
- **Full sweep only in v1 — no delta/incremental path.** Every refresh is a full paginated list-sweep of the collection, upserted into Postgres. Bootstrap (first-ever sync into an empty database) is just the degenerate case of the same sweep — same codepath as view-triggered and nightly passes, with progress events surfaced on the setup screen. No etag/delta games; the complexity isn't worth it until mega-district scale, and quota pacing handles that pressure.
- **Deletion detection: mark-and-sweep.** Every record touched by a sweep gets its `lastSyncAt` stamped. After a completed sweep, any record whose `lastSyncAt` predates the sweep start wasn't returned by Google → **soft delete**. New entities appear naturally as inserts. No tombstone tracking required.
- **Concurrency: Redis in-flight marker + Pub/Sub events.** A per-entity-type in-flight key ensures a sync already running is *joined*, not duplicated (two admins opening the Users grid at once = one sync). Redis Pub/Sub carries progress/completion events; subscribed views live-update from Postgres on completion instead of polling or "refresh and pray."
- **Quota pacing — resolved.** Per-API rate limits (Directory 2,400 QPM/user/project; Groups Settings 100k/day; Chrome Management QPM unpublished) are handled with a greedy first-come-first-serve model: workers do not coordinate on a shared rate budget, and backoff is driven reactively by Google's 429 responses. Two levels of retry apply: NestJS workers handle per-request backoff internally (fine-grained), and Kestra handles flow-level retry (coarse-grained, per-chunk). See `docs/research/google-api-quotas.md` for documented limits.

## Standardized Execution / Jobs Pipeline

Needed for: entity sync sweeps (see Sync & Freshness Strategy above), the bootstrap scan-and-wait job (see Google Workspace Bootstrapping), async device command tracking (poll/track command lifecycle per device), rate-limited multi-call operations (group membership changes, anything without a native bulk API method), and the bulk-action/import execution steps generally.

- **Orchestration layer: Kestra.** All jobs are defined as declarative YAML flows in a "Job Bank" — Kestra only defines the sequence of operations, guardrails (`concurrency`, `retries`, `timeout`), and input/output file pathways. It contains **zero business logic** and performs **no side effects** (no direct database writes, no Google API calls).
- **Execution layer: NestJS.** NestJS exposes internal endpoints that Kestra calls to perform the actual work. NestJS workers read data from files, execute Google API calls, and write results back to files.
- **File-driven pipeline for large-scale operations.** For operations involving >10k records, data passes through the filesystem rather than HTTP bodies. The pipeline has four phases:
  1. **Ingestion:** Client passes a selection hash; NestJS writes an `init-job.json` to `/jobs/inbox/` and triggers the Kestra flow.
  2. **Orchestration:** Kestra calls NestJS `/internal/chunk` endpoint, which reads entities from Postgres/cache and writes fixed-size chunk files (1000 records each) to `/jobs/work/`.
  3. **Execution:** Kestra runs a parallel loop (concurrency: 10) of NestJS worker tasks, each processing one chunk file and writing a result file to `/jobs/out/`.
  4. **Consolidation:** Kestra triggers NestJS `/internal/audit` endpoint, which aggregates all result files and writes a permanent audit log record to Postgres.
- **Chunk size:** 1000 records per chunk — fits comfortably in NestJS memory and aligns with Google API batch limits.
- **Concurrent workers:** 10 (configurable per flow in YAML) — prevents 429/quota-exceeded from Google.
- **Retry strategy:** 2-3 retries per chunk at the NestJS level (with exponential backoff), plus Kestra flow-level retry for failed chunks.
- **Audit retention:** All job executions are kept forever in both file form and Postgres audit logs for compliance/forensic purposes.
- **Read-after-write freshness:** After a job completes, NestJS backfills Postgres and Redis with all successes, then updates a Redis pub/sub channel that the client is watching. The client immediately fetches the new values from Redis, ensuring instant consistency without hitting Postgres or Google APIs.
- **Failure/observability surface:** Basic job status only, modeled on the Google Cloud Console pattern — shows job status (running/completed/failed), duration, and brief error messages. No advanced observability (quota exhaustion warnings, sync lag metrics) in v1.

## Deferred / Explicitly Out of Scope for v1
- Hosted LLM adapter for NL filtering (pluggable interface exists, but only the local-model implementation ships in v1).
- Undo/rollback for bulk actions (stretch goal).
- `makeAdmin` (super-admin grant) in bulk tooling.
- Cloud Identity dynamic/security groups.
- Group conversation/messaging content (archives, discussions).
- All Classroom course content/LMS features (`courseWork`, `courseWorkMaterials`, `announcements`, `topics`, `gradebookSettings`) and roster management generally (see Classroom — Shelved above).
- Multi-domain support within a single deployment.
- Dashboard/widget-builder features (spec 2) and widget gallery (spec 3) — separate specs, not yet designed.
