# Campus Commander Planning Review Topics

**Status:** IN PROGRESS  
**Purpose:** Session handoff and checklist for bringing the architecture plan to an implementation-ready state before substantial code generation begins.  
**Last Updated:** 2026-08-29  
**Interview Sessions:** 2 (Sections 1-7 and the Section 8 cache signaling design)

## Desired Outcome

Produce one internally consistent architecture plan that:

- supports the largest stated customer environment;
- can be deployed and operated safely in customer-controlled infrastructure;
- preserves correctness during retries, crashes, concurrent jobs, and upgrades;
- defines enough concrete contracts that implementation does not depend on developers inventing architecture as they code;
- includes testable acceptance criteria for every critical subsystem.

The architecture should remain in `DRAFT` status until the blocking topics below are resolved.

## 1. Reconcile the Existing Documents

- [x] Choose one authoritative architecture document. → `2026-07-22-campus-commander-architecture.md` is authoritative. `planning-review-topics.md` is this checklist.
- [x] Define which documents contain product requirements versus engineering decisions.
  - Architecture doc: engineering decisions + approved stack
  - This doc: open decisions blocking implementation
  - Specs under `docs/superpowers/`: product requirements
- [x] Resolve Angular versus React. → **Angular 20** (NgRx Signals). Decision recorded in architecture doc.
- [x] Select the grid stack for entity grids. → **ag-grid-community 36.x + `@libregrid/*` (LibreGrid) packages.** See decision 17.17 and the spec's "Grid Stack" section.
- [x] Resolve Kestra versus BullMQ and document whether both have distinct responsibilities. → **Kestra only**. No BullMQ. Kestra handles all job orchestration. NestJS handles API + job initialization only.
- [x] Resolve the contradiction between "the API is not a worker" and NestJS executing worker tasks. → Workers are a **separate NestJS service** (single deployable, multiple step modules). NestJS API server is never in the hot path of a running job.
- [ ] Reconcile documented `apps/...` project paths with the actual Nx project layout. → Actual: `frontend`, `api`, `shared` at root level. Architecture doc says `apps/frontend`, `apps/api`. Needs reconcile.
- [ ] Align documented framework versions with the versions the project will use.
- [ ] Establish a decision-record process so superseded decisions are clearly marked.

## 2. Deployment Model and Supported Environments

- [x] Define the supported production environments: Linux, Windows/WSL2, bare metal, VM, and cloud. → **Linux only** for production. Windows/WSL2 for dev.
- [ ] Separate development Compose configuration from production configuration where necessary.
- [ ] Define CPU, memory, disk, and architecture requirements for small, medium, and maximum-size installations.
- [ ] Decide whether a single-host deployment is sufficient and document its availability limitations.
- [x] Define whether workers can scale independently from the API. → **Yes.** Workers are a separate NestJS service, scaled independently from the API server.
- [ ] Document internal container networks and which services may publish host ports.
- [x] Define DNS, TLS certificate, reverse-proxy, and hostname requirements. → **Architecture A (pure self-hosted, no vendor infrastructure)**
  - **Localhost dev:** `http://localhost` (Google allows it for OAuth) + `mkcert` for HTTPS locally (one scripted command)
  - **Cloud server with domain:** `Caddy` + Let's Encrypt via HTTP-01. Set `DOMAIN` env var.
  - **Cloud server without domain:** `sslip.io` names (e.g. `203-0-113-4.sslip.io`) resolve without DNS setup. Caddy gets valid Let's Encrypt cert via HTTP-01.
  - **LAN server (no public CA possible):** Caddy internal CA or `step-ca`. Trust root must be installed on each client machine.
- [ ] Define offline or restricted-egress installation requirements.
- [ ] Define image build, publication, versioning, and supply-chain verification.
- [ ] Define installation validation and a clean-uninstall procedure.

## 3. Security Architecture and Trust Boundaries

- [ ] Create a threat model covering administrators, browsers, the API, workers, Kestra, Redis, Postgres, and Google.
- [ ] Identify every externally reachable endpoint and every privileged internal endpoint.
- [ ] Define user authentication, session management, logout, expiration, and account recovery.
- [x] Define RBAC roles, permissions, resource scope, and enforcement points. → **Two-role platform model:**
  - **Platform Admin:** Manages users, assigns RBAC roles. Cannot necessarily run jobs on all entities.
  - **Entity Super Admin:** Full platform root access — can view/execute jobs on any entity (any OU). Can be scoped per entity type (users vs devices vs groups).
  - **Note:** "Platform Admin" and "Entity Super Admin" are internal RBAC roles. Separate from Google Super Admin (DWD account).
  - Users must be **invited** by a Platform Admin — no auto-provision on first login.
  - Job file/archive access is RBAC-gated: users can always see the jobs they executed.
- [ ] Define service-to-service authentication between Kestra, the API, and workers.
- [ ] Decide whether internal communication requires mTLS.
- [ ] Define CSRF, CORS, content-security-policy, and secure-cookie requirements.
- [ ] Define secret generation, storage, encryption, rotation, and revocation.
- [ ] Define protection and rotation of the Google service-account key. → **N/A — no service account key.** DWD uses OAuth with a designated Google Super Admin user account.
- [ ] Define audit requirements for security-sensitive configuration changes.
- [x] Ensure Postgres, Redis, and Kestra are not exposed without an explicit operational reason. → Internal services communicate via Docker network. No ports exposed to host unless explicitly required.

## 4. Google OAuth and Workspace Bootstrap

- [x] Resolve how OAuth client credentials exist before the bootstrap OAuth flow begins. → **Customer creates their own Google OAuth client** in their Google Cloud project. No bootstrap needed — customer provides `CLIENT_ID` and `CLIENT_SECRET` in `.env`.
- [x] Choose between customer-created OAuth credentials, a vendor callback service, or another supported bootstrap mechanism. → **Architecture A: customer self-service.** No vendor callback service. Pure self-hosted.
- [x] Define authorized redirect URI and HTTPS requirements for arbitrary self-hosted hostnames. → Customer registers redirect URI in their own Google Cloud Console. For `localhost` dev, Google allows `http://localhost`. For LAN-only deployments, private CA is required (see Section 2 TLS).
- [x] Define the exact bootstrap scopes and justify each one. → **Identity only** (`email profile`). Bootstrap OAuth consent requests only `email profile`. All Google API scopes are **granted separately via DWD** in `admin.google.com` — app does not automate this.
- [ ] Define consent-screen and Google verification implications. → Pending. May need Google verification for consent screen if app is publicly accessible.
- [ ] Define CSRF state, PKCE where applicable, token encryption, token expiry, and token deletion.
- [x] Define the manual steps that cannot be automated. → DWD configuration in `admin.google.com` (granting API scopes to the Super Admin account) is manual and cannot be automated by the app.
- [ ] Define resumable handling for DWD propagation and multi-party approval.
- [ ] Define partial-capability diagnosis when only some scopes or admin privileges work.
- [x] Define service-admin creation, role assignment, impersonation, and recovery if that account is suspended or deleted.
  - **Designated Google Super Admin account:** Configured at install. Can be changed at any time via Customer Settings by a Platform Admin.
  - Must be a **Google Super Admin** within the customer's domain.
  - Not the installing admin — can be any Super Admin account designated by the customer.
  - Cannot be removed (Google-level restriction) — only replaced.
  - **Recovery:** If suspended/deleted, Platform Admin swaps to a different Super Admin account in settings.
- [x] Define service-account key rotation and DWD reauthorization procedures. → Tokens are **generated fresh per API call, used once, discarded.** No persistent tokens. If token generation fails, error propagates to client and customer must reauthorize DWD.

## 5. Job Execution Model

- [ ] Define a durable job state machine and all terminal/non-terminal states.
- [x] Assign every job an immutable unique identifier. → Execution ID. Each job gets a UUID. All files for a job are nested under `/jobs/archive/{executionId}/`.
- [ ] Define an immutable execution manifest containing targets, action parameters, principal, preview, and authorization decision.
- [x] Use job-scoped storage paths rather than global chunk filenames. → `/jobs/inbox/{executionId}/`, `/jobs/work/{executionId}/`, `/jobs/out/{executionId}/`, `/jobs/archive/{executionId}/`.
- [ ] Define atomic chunk creation, claiming, completion, and result publication.
- [ ] Define idempotency keys for every Google mutation and internal state transition.
- [ ] Define retry behavior for safe, unsafe, and ambiguously completed operations.
- [ ] Define leases, lease expiry, fencing tokens, and abandoned-work recovery.
- [x] Define cancellation semantics and what cancellation can guarantee.
  - **Best-effort cancellation.** Kestra sets a cancellation flag. Workers check the flag at each **page iteration** (not just per-batch) and stop early, saving partial results.
  - Batches already running may complete. Job ends with partial success + cancellation timestamp in audit record.
- [ ] Define timeout behavior when the worker continues after the orchestrator times out.
- [ ] Define ordering requirements for actions that affect the same entity.
- [ ] Define compensation or operator reconciliation for partially completed destructive jobs.
- [x] Define job scheduling and Full Entity Sync exclusion.
  - Jobs can request immediate execution or an earliest start time.
  - The scheduler keeps blocked jobs queued. It does not reject them.
  - At the scheduled Cache Sync time, the scheduler stops dispatching other jobs.
  - Active jobs finish normally before the Full Entity Sync starts.
  - The Full Entity Sync holds a global lock while it runs.
  - New job requests remain accepted and queued during the global lock.
  - The scheduler releases queued jobs after the Full Entity Sync ends.
- [x] Separate API and worker deployment/runtime responsibilities.
  - **API server:** Job CRUD, RBAC validation at creation, writes job config to `/jobs/inbox/`. Never in hot path of running job.
  - **Workers (NestJS step service):** Separate NestJS service. Single deployable with multiple step modules. Reads `/jobs/work/`, calls Google APIs directly, writes to `/jobs/out/`. Scaled independently from API.
  - **Kestra:** Orchestrates. Triggers internal API endpoints to get work. Spawns parallel tasks per batch.
- [ ] Define how jobs resume after API, worker, Kestra, Redis, Postgres, or host restart.

## 6. Preview, Selection, and Bulk-Action Safety

- [x] Define the server-side selection representation.
  - **Selection stored in Redis.** Keyed by `tabHash + gridHash` — each grid per tab has its own selection set.
  - Two selection modes:
    1. **Individual row toggle:** event sent to API → ID added/removed from Redis set
    2. **"Select all filtered":** filter criteria sent to API → API applies filter and adds all matching IDs to Redis
  - **No full entity list ever transmitted from frontend.** Frontend sends criteria, not IDs.
  - Grid page load queries Redis: "which of these IDs are selected?" → returns per-row selected flag.
- [ ] Map the selection API to `ServerSideSelectionProvider` in `@libregrid/server-side-selection`. The provider implements the Redis-backed selection model from decision 17.8 (individual row toggle and select-all-filtered modes). The grid holds a compact selection spec plus per-row flags.
- [ ] Decide whether selections are immutable snapshots or queries evaluated at execution time.
- [ ] Bind previews to exact entity IDs, entity versions, action parameters, and the initiating principal.
- [ ] Define preview expiration and revalidation rules.
- [x] Re-evaluate authorization immediately before execution. → RBAC check at job creation. Entity-level authorization is enforced at Google level by DWD (Super Admin), but app RBAC gates what the user is permitted to create.
- [x] Define behavior when entity data or permissions change between preview and execution.
  - **Entity changes (deleted, moved):** Google API returns per-entity error (404 not found, 403 access denied). Job continues processing valid entities. Audit record includes per-entity failure reason.
  - **Partial success is normal and expected.** Job reports `N successes, M failures` with breakdown by error type.
- [x] Define additional confirmation requirements for destructive device operations. → Import-export has two-phase validation (preview then execute). Other bulk actions have UI-based confirmation preview before triggering.
- [ ] Define maximum job size and admission-control behavior.
- [x] Define whether and how operators can pause, cancel, retry, or resume jobs. → Cancellation is best-effort (see Section 5). Pause/retry/resume not yet specified.

## 7. Quota and Rate-Limit Coordination

- [ ] Inventory quota dimensions for every Google API and operation.
- [ ] Model per-customer, per-project, per-user, per-API, and per-method limits.
- [x] Implement a shared distributed rate budget rather than independent worker backoff. → **No shared state.** Each worker uses a **greedy quota system**: consumes quota continuously until Google returns 429, then begins per-worker backoff and retry.
- [x] Define global concurrency limits across all simultaneously running jobs. → Kestra `concurrency` setting in YAML per job type is the **primary brake** on total parallelism. Set to match Google quota limits per job type.
- [ ] Define weighted costs for calls with different limits.
- [ ] Define daily-budget handling for Groups Settings.
- [ ] Define behavior for unpublished or customer-specific Chrome Management quotas.
- [x] Define jittered backoff and retry ceilings. → Per-worker backoff + retry. Kestra-level retry for certain error cases. Details pending (ceiling values, jitter strategy).
- [x] Prevent retries from producing a request storm. → Kestra concurrency limits the parallelism. Per-worker greedy backoff means workers independently back off after 429.
- [ ] Define admission control and estimated completion time for large jobs.
- [ ] Surface quota exhaustion and throttling to administrators.
- [ ] Define how quota configuration is discovered, overridden, and validated per installation.

## 8. Sync and Cache Correctness

- [x] Define a durable Full Entity Sync record.
  - The UI name is **Cache Sync**.
  - The internal job type is **Full Entity Sync**.
  - Each run has an immutable **Sync execution ID**.
  - The default trigger is the daily schedule. Initial setup and manual refresh can also trigger it.
- [ ] Define how overlapping, abandoned, and resumed sweeps are fenced. Targeted refreshes must exclude entities with an active refresh. The durable claim mechanism remains open.
- [x] Only perform deletion detection after a provably complete Full Entity Sync.
  - Failed, canceled, and targeted syncs cannot mark entities as removed.
- [x] Define transaction boundaries for Full Entity Sync persistence.
  - The fetch phase downloads all Google data to execution files before database writes start.
  - The persistence step validates and transforms the complete file set.
  - One Postgres transaction writes the complete entity-type result.
  - A failed transaction rolls back all database changes.
  - Redis updates occur only after the Postgres transaction succeeds.
  - The API publishes one entity-type completion event. It does not publish page or record events.
- [x] Define conflict behavior between sync writes and user-initiated mutations.
  - A Full Entity Sync runs under a global job lock.
  - The scheduler drains active jobs before the sync starts.
  - All other jobs remain queued until the sync ends.
- [ ] Define read-after-write behavior while Google changes are still propagating.
- [x] Define cache freshness separately for each entity and sub-resource.
  - Google is the entity source of truth. Postgres is the durable read cache.
  - Postgres stores `lastSyncedAt` for each entity and subresource.
  - Each entity type and subresource has a configurable freshness limit.
  - The read path is browser to API, Redis, and then Postgres.
  - The API returns stale data immediately with a stale flag and starts a targeted refresh.
- [ ] Validate whether full sweeps can meet freshness targets at maximum scale.
- [ ] Revisit group-membership and Group Settings N+1 synchronization costs.
- [ ] Define targeted refresh and reconciliation after bulk operations.
- [ ] Define Redis failure behavior; Redis must not be the sole source of durable truth. Postgres remains authoritative for cached state.
- [x] Define pub/sub reconnect and missed-event recovery.
  - The browser opens one Server-Sent Events connection per tab through the API.
  - A Postgres transactional outbox records entity refresh events with the entity update.
  - The publisher invalidates the Redis cache before it publishes through Redis Pub/Sub.
  - Each API instance forwards authorized invalidation events to its connected browsers.
  - An event contains identifiers and a version. It does not contain entity data.
  - The browser fetches current data through the normal API after an event.
  - Redis Pub/Sub provides at-most-once delivery. The API sends a `resync` event after each SSE reconnect.
  - Each active grid fetches its current rows after a `resync` event.
  - The deployment must use HTTP/2. Multiple grids in one tab share one SSE connection.

## 9. Data Model and Database Design

- [ ] Define schemas and stable identifiers for users, devices, groups, memberships, org units, telemetry, jobs, and audit records.
- [ ] Define tenant/domain identity even though v1 is single-tenant.
- [ ] Define indexes for the largest filter, search, sort, and pagination workloads.
- [ ] Define optimistic-concurrency/version fields.
- [ ] Define soft-delete and restoration semantics.
- [ ] Define how Google propagation delay and eventual consistency are represented.
- [ ] Define transaction boundaries for jobs, cache updates, and audit records.
- [ ] Define migration, rollback, and forward-compatibility policy.
- [ ] Define database connection-pool budgets across the API, workers, and Kestra.
- [ ] Decide whether the application and Kestra use separate databases or schemas.

## 10. Import and Export Correctness

- [ ] Define where the per-cell export baseline is stored; a row hash alone cannot reconstruct baseline values.
- [ ] Define export identifiers, expiration, ownership, and tamper protection.
- [ ] Define CSV parsing, encoding, size, formula-injection, and malformed-row handling.
- [ ] Define stable entity matching and duplicate detection.
- [ ] Define three-way comparison precisely.
- [ ] Define conflict-resolution persistence and revalidation before execution.
- [ ] Define streaming behavior for large imports and exports.
- [ ] Define Google Sheets authorization and data-access implications.
- [ ] Define partial failure, retry, and downloadable error-report behavior.

## 11. Persistence, Retention, and Privacy

- [ ] Classify stored data by sensitivity.
- [x] Decide what job inputs and outputs genuinely require retention. → **Everything retained permanently** under `/jobs/archive/{executionId}/`. All batch files, response files, and configs are preserved indefinitely as the source of truth.
- [x] Replace "retain forever" with explicit retention periods and legal/configuration requirements. → "Forever" = hot storage until data exceeds a configurable age threshold, then **automatically zipped for cold storage** (configurable by customer). Still fully accessible — unzip on demand.
- [x] Define archival, compression, encryption, and deletion. → Scheduled zip for cold storage. Configurable retention period per customer (how long data stays hot). Deletion is not automatic — data is never deleted, only moved to cold storage.
- [x] Prevent job storage from growing until the host disk is exhausted. → Customer configures disk allocation / retention threshold. System monitors and warns before exhaustion.
- [ ] Define low-disk thresholds and safe shutdown behavior.
- [ ] Define retention for raw telemetry and rollups.
- [ ] Define deletion behavior when an installation is decommissioned.
- [ ] Ensure the uninstall procedure removes secrets and bind-mounted state as promised.
- [ ] Define customer-controlled backup destinations and encryption keys.

## 12. Backup, Restore, Upgrade, and Disaster Recovery

- [ ] Define backup scope for Postgres, job state, configuration, and secrets.
- [ ] Define whether Redis contains any state that must be restored.
- [ ] Define consistent backup coordination across services.
- [ ] Establish recovery point and recovery time objectives.
- [ ] Test restoration into a clean installation.
- [ ] Define application and database upgrade ordering.
- [ ] Define rollback limitations after a schema migration.
- [ ] Define recovery from a corrupt or lost Kestra repository.
- [ ] Define recovery from service-account credential loss or compromise.
- [ ] Define supported-version and security-patch policy.

## 13. Observability and Operations

- [ ] Define structured logs and correlation IDs across request, job, chunk, Google call, and audit record.
  - All services write structured JSON operational logs to standard output.
  - Correlation field names and propagation rules remain open.
- [ ] Define health, readiness, and liveness checks.
- [ ] Define metrics for queue depth, worker saturation, sync lag, quota use, retries, errors, and disk growth.
- [ ] Define administrator-visible job progress and failure details.
  - The job page must show the failure, retry status, and required administrator action.
  - Exact status fields and remediation contracts remain open.
- [ ] Define alerts for authentication failure, DWD failure, stalled jobs, quota exhaustion, backup failure, and low disk.
- [x] Define operational log retention architecture.
  - Docker uses the `local` logging driver with compression and bounded rotation.
  - Customers can configure `max-size` and `max-file`.
  - The optional observability profile uses OpenTelemetry Collector, Grafana Loki, and Grafana.
  - Loki retention must be enabled. Loki must not retain logs without a limit.
  - Customers can replace Loki with an OTLP-compatible system.
- [ ] Prevent secrets and sensitive entity data from appearing in logs.
- [ ] Define a support-bundle format with automatic redaction.
- [ ] Define clock synchronization and timezone requirements.

## 14. Capacity and Performance Model

- [ ] Define representative small, medium, and maximum customer datasets.
- [ ] Estimate rows, relationships, indexes, and storage growth for each dataset.
- [ ] Estimate bootstrap and full-sync duration for each Google API.
- [ ] Estimate worst-case bulk-job duration under actual quotas.
- [ ] Define maximum concurrent users, grids, exports, imports, and jobs.
- [ ] Define acceptable API, grid, search, preview, and job-start latency.
- [ ] Load-test Postgres filtering and pagination at maximum scale.
- [ ] Test worker throughput without starving interactive API traffic.
- [ ] Test restart, failover, retry, and reconciliation under load.
- [ ] Define capacity-based warnings and deployment-sizing guidance.

## 15. Testing and Acceptance Gates

- [ ] Define unit, integration, contract, end-to-end, and destructive-operation test boundaries.
- [ ] Provide fake Google API implementations capable of quota, propagation, and partial-failure behavior.
- [ ] Test duplicate delivery and ambiguous external-call completion.
- [ ] Test concurrent jobs targeting the same entities.
- [ ] Test service restart during every job phase.
- [ ] Test loss of Redis, Postgres, Kestra, a worker, and the host.
- [ ] Test OAuth/DWD partial configuration and revocation.
- [ ] Test full backup and clean-machine restoration.
- [ ] Test maximum-scale sync and bulk operations.
- [ ] Require a clean-checkout production deployment smoke test.
- [ ] Define security review and penetration-test gates before customer use.

## 16. Implementation Sequencing

- [x] Resolve architecture decisions and record them. (See Section 17 — 12 decisions recorded 2026-07-27)
- [ ] Build the production deployment skeleton and security boundaries.
- [ ] Implement authentication, RBAC, configuration, secrets, and migrations.
- [ ] Implement the durable job ledger and dedicated worker contract.
- [ ] Implement quota coordination before Google write operations.
- [ ] Implement one narrow vertical slice, such as read-only Users sync.
- [ ] Validate restart recovery and maximum-scale behavior for that slice.
- [ ] Add previewed single-entity mutation.
- [ ] Add bulk mutation only after idempotency and reconciliation are proven.
- [ ] Add other entity types incrementally using the same tested contracts.

## Suggested Order for the Next Planning Session

1. Reconcile the source documents and select the authoritative stack.
2. Draw the deployment topology and trust boundaries.
3. Resolve the OAuth/bootstrap model.
4. Define the durable job, selection, retry, and idempotency contracts.
5. Define centralized quota coordination.
6. Validate sync and storage assumptions against the maximum-size customer.
7. Add operational, disaster-recovery, and acceptance requirements.
8. Rewrite the architecture document and only then mark individual decisions as approved.

## Definition of “Implementation Ready”

The planning phase is complete when:

- no authoritative documents contradict one another;
- every privileged connection and endpoint has a defined trust and authentication model;
- every destructive operation has immutable authorization, idempotency, retry, and reconciliation semantics;
- the quota model proves that stated freshness and completion targets are achievable;
- crash recovery is defined for every durable workflow phase;
- storage growth is bounded and backup/restore has testable requirements;
- the maximum supported customer has a documented, validated capacity model;
- critical design claims have explicit acceptance tests;
- unresolved decisions are recorded as blockers rather than left for implementation-time invention.


---

## 17. Resolved Decisions (Decision Record)

_This section records decisions made during planning sessions. Each entry captures the decision, its rationale, and the date._

### 17.1 Worker Topology

**Decision:** Workers are a separate NestJS service (single deployable, multiple step modules). Workers are never co-located in the API server process.

**Rationale:** Prevents running jobs from degrading interactive API performance. Enables independent scaling. Ensures worker crashes don't affect API availability.

**Date:** 2026-07-27

---

### 17.2 Job Chunker

**Decision:** The API does not pre-chunk data. Each job type's Kestra YAML defines batch size per step type. The first step of a job is a validation + batch-creation step that reads the job config and writes `batch_00.json`...`batch_NN.json` files. Kestra then parallelizes workers per batch.

**Rationale:** Batch size is job-type-specific (e.g., ChromeOSDevices: 1000/batch). API doesn't need to know batch size — Kestra YAML defines it per job type.

**Date:** 2026-07-27

---

### 17.3 Step Authoring Model

**Decision:** A generator scaffolds step boilerplate (`step.service.ts`). The step author writes only a `run(context)` method with pure business logic. The framework handles: file I/O, Google API client injection, authentication context (DWD), logging, audit. Steps access data via `fileUtils.readBatch(context.folder, context.workerIndex)`.

**Rationale:** Uniform step structure across all workers. Zero boilerplate for step authors. Common operations (directory API) provided via injected service libraries (`libs/api-service/google/device`).

**Date:** 2026-07-27

---

### 17.4 Shared Types (`libs/shared`)

**Decision:** `libs/shared` is a TypeScript interface/DTO schema library only. It must not contain Angular components, services, or framework-specific code. All types that the API, workers, and steps import are defined here.

**Date:** 2026-07-27

---

### 17.5 Auth Architecture (Architecture A)

**Decision:** Pure self-hosted. No vendor callback service. No vendor infrastructure dependency. Customer creates their own Google OAuth client in their own Google Cloud project.

**Sub-decisions:**
- Bootstrap OAuth scope is `email profile` only
- All Google API scopes are granted via DWD in `admin.google.com`, not automated by the app
- Designated Google Super Admin account is configured at install and changeable in Customer Settings
- Tokens generated fresh per API call, used once, discarded

**Date:** 2026-07-27

---

### 17.6 TLS / Certificate Strategy

**Decision:** Four deployment modes with corresponding TLS:
- Localhost dev: `http://localhost` + `mkcert` (one scripted command)
- Cloud with domain: `Caddy` + Let's Encrypt via HTTP-01 (`DOMAIN` env var)
- Cloud without domain: `sslip.io` + Caddy + Let's Encrypt
- LAN server: Caddy internal CA or `step-ca` (trust root must be distributed to client machines)

**Date:** 2026-07-27

---

### 17.7 RBAC Model

**Decision:** Two internal platform roles, separate from Google Super Admin (DWD account):
- **Platform Admin:** Manages users, assigns RBAC roles. Cannot necessarily run jobs on all entities.
- **Entity Super Admin:** Can view/execute jobs on any entity across all OUs.
- Users are **invite-only** — no auto-provision on first login.
- Job file/archive access is RBAC-gated (users see only jobs they executed or are authorized to view).

**Date:** 2026-07-27

---

### 17.8 Selection Model

**Decision:** Selection is server-side (Redis). Keyed by `tabHash + gridHash`. No entity ID list is ever transmitted from frontend. Two modes: individual row toggle (event to API) and "select all filtered" (filter criteria to API). Selection is NOT consumed when a job is created — it persists until explicitly cleared.

**Date:** 2026-07-27

---

### 17.9 Quota Strategy

**Decision:** No shared quota state. Greedy per-worker model: each worker consumes quota until Google returns 429, then applies per-worker backoff and retry. Kestra `concurrency` setting in YAML is the primary constraint on total parallelism.

**Date:** 2026-07-27

---

### 17.10 Cancellation Model

**Decision:** Best-effort cancellation. Workers check a cancellation flag at each page iteration (not just per-batch) and stop early with partial results saved. Kestra may continue spawning new tasks until the flag is observed. Audit record reflects where cancellation occurred.

**Date:** 2026-07-27

---

### 17.11 File Archive Model

**Decision:** All job files stored under `/jobs/archive/{executionId}/` indefinitely. Postgres is a thin index (job metadata + entity IDs touched + folder path reference) — not primary storage. Customer-configurable retention: hot until age threshold, then automatic zip for cold storage. Fully accessible on demand. No automatic deletion.

**Date:** 2026-07-27

---

### 17.12 DWD Delegation Model

**Decision:** The designated Google Super Admin account must be a **Google Super Admin** within the customer's domain. Used via DWD for all Google API operations. Configured at install, changeable in Customer Settings. Recovery if suspended/deleted: swap to a different Super Admin account in settings.

**Date:** 2026-07-27

---

### 17.13 Server-to-Client Signaling

**Decision:** Use Server-Sent Events from the NestJS API to the browser. Use Redis Pub/Sub as the internal broadcast layer.

Postgres stores durable entity state and a transactional outbox. An entity update and its outbox event commit in one transaction.

An outbox publisher invalidates the Redis cache before it publishes an invalidation event. Each API instance forwards authorized events to its local SSE connections.

Events contain entity identifiers, event type, and entity version. Events do not contain entity data.

The browser opens one SSE connection per tab. All grids in that tab share the connection. The browser fetches current data through the API after an event.

Redis Pub/Sub uses at-most-once delivery. After an SSE reconnect, the API sends a `resync` event. Each active grid then fetches its current rows.

The production reverse proxy must support HTTP/2 and unbuffered SSE responses. The application uses same-origin secure session cookies for SSE authentication.

Redis Streams and WebSockets are not part of this signaling path. The system does not need event replay or two-way persistent messages.

**References:**

- [NestJS Server-Sent Events](https://docs.nestjs.com/techniques/server-sent-events)
- [MDN Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [Redis Pub/Sub delivery semantics](https://redis.io/docs/latest/develop/pubsub/)
- [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/)

**Date:** 2026-07-28

---

### 17.14 Full Entity Sync Consistency

**Decision:** The user-facing name is **Cache Sync**. The internal job type is **Full Entity Sync**. Each run has an immutable Sync execution ID.

The Full Entity Sync fetches all Google data into execution files before it writes Postgres. The persistence step validates and transforms the complete file set.

One Postgres transaction writes the complete entity-type result. A failure rolls back the transaction. Transient failures retry from the existing files.

Redis remains unchanged until the Postgres transaction succeeds. The API then updates or invalidates Redis and publishes one entity-type completion event.

Only a completed Full Entity Sync can mark unseen entities as removed. Failed, canceled, and targeted syncs cannot mark removals.

**Date:** 2026-07-28

---

### 17.15 Job Scheduling and Cache Sync Lock

**Decision:** Jobs support immediate execution and scheduled execution. A scheduled time is the earliest permitted start time.

At the daily Cache Sync time, the scheduler installs a drain barrier. The barrier stops new job dispatch while active jobs finish.

The Full Entity Sync then acquires a global job lock. The API continues to accept new jobs and places them in the queue.

The scheduler releases queued jobs after the Full Entity Sync succeeds, fails, or is canceled.

**Date:** 2026-07-28

---

### 17.16 Local Logging and Audit Fallback

**Decision:** Operational logs and audit records have separate storage and retention rules.

All services write structured JSON logs to standard output. Docker uses its `local` logging driver with compression and bounded rotation.

An optional Compose profile provides OpenTelemetry Collector, Grafana Loki, and Grafana. Loki retention must be enabled. Customers can use another OTLP-compatible system.

Operational logs are not audit records. Each job writes a compact `status.json` file under `/jobs/archive/{executionId}/`.

If Postgres cannot record job status, the execution file remains the durable fallback. A reconciler imports pending status files after Postgres recovers.

Postgres and job files use separate storage volumes. No local log system can write when all available host storage is exhausted.

**References:**

- [Docker local logging driver](https://docs.docker.com/engine/logging/drivers/local/)
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
- [Grafana Loki retention](https://grafana.com/docs/loki/latest/operations/storage/retention/)

**Date:** 2026-07-28

---

### 17.17 Grid Stack

**Decision:** Entity grids use `ag-grid-community` 36.x plus LibreGrid (`@libregrid/*`) feature packages. The app registers only the modules it uses, through `@libregrid/angular`. No AG Grid Enterprise dependency.

**Package mapping** (full table in the spec, "Grid Stack" section):

- Entity grids at 100k+ rows: `@libregrid/server-side-row-model`
- Server-side selection: `@libregrid/server-side-selection`, backed by the Redis selection store from decision 17.8 through its `ServerSideSelectionProvider` interface
- OrgUnits tree view: `@libregrid/tree-data`
- Filters: `@libregrid/set-filter`, `@libregrid/multi-filter`, `@libregrid/advanced-filter`, `@libregrid/filters-tool-panel`, `@libregrid/find`
- Cell selection and clipboard: `@libregrid/cell-selection`, `@libregrid/clipboard`
- Excel export: `@libregrid/excel-export` (in-browser `.xlsx`; CSV and Sheets export run through the API)
- Grid chrome: `@libregrid/menu`, `@libregrid/side-bar`, `@libregrid/columns-tool-panel`, `@libregrid/status-bar`
- Telemetry charts: `@libregrid/integrated-charts`, `@libregrid/sparklines`
- Angular integration: `@libregrid/angular`, `@libregrid/material`

**Constraints:**

- Packages are published to npm under the `@libregrid` scope at lockstep versions (current 1.3.0). Peer dependency: `ag-grid-community >=36.1.0 <37`.
- `@libregrid/batch-edit` supports client-side row models only. Inline editing on server-side grids is a per-cell write-through on the single-row bulk-action path.

**Rationale:** LibreGrid provides the enterprise feature set (SSRM, server-side selection, filters, Excel export, charts) as MIT-licensed modules on the Community registry. The app stays license-free and bundles only what it uses. SSRM matches the existing design where selection is computed server-side for 300k-row grids.

**Date:** 2026-08-29

---

### 17.18 UI Design Guide

**Decision:** The frontend follows `docs/ux/ui-design-guide.md`. Settled direction:

- **Dual audience:** professional IT admins and occasional tech helpers (librarians, teacher's aides). Plain-language labels first. Power features never gate basic flows.
- **Layout:** full-height left navigation panel, header above the main column only, full-width footer. Standard enterprise shell.
- **Visual language:** Google enterprise neutral. Dense grid data, airy chrome with generous white space. Light + dark from day one.
- **Brand:** "Campus Commander" wordmark in the nav header, a single blue accent (provisional `#1A73E8`), Material Symbols as the only icon system.
- **Typography:** Roboto self-hosted in the app bundle (offline installs). Tabular numerals for data columns.
- **Kit split:** Angular Material components + Tailwind for layout only. Grid theming through `@libregrid/material`. The Quartz grid theme follows Material tokens live.

**Rationale:** The app serves mixed-skill users in K-12 environments. Familiar enterprise patterns reduce training cost. A single token source keeps the app and the grid visually consistent across light and dark modes.

**Date:** 2026-08-29
