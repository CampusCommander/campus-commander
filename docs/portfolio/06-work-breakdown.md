# 06 — Work Breakdown

**Status:** revised 2026-09-05. Every implementation package is **TODO**. V0 validation is **IN PROGRESS**.

The [V0 report](../validation/v0-2026-09-05/README.md) records measured local behavior, failed assumptions, and remaining acceptance requirements.
The [technical findings](../validation/v0-2026-09-05/technical-findings.md) define changes before dependent implementation.
Partial experimental results do not complete implementation packages or the entire V0 gate.

The owner adopted the ten-phase sequence below after the initial V0 experiments.
This sequence replaces the earlier V1–V6 delivery order. V0 remains an evidence record and prerequisite workstream.
Existing scaffolding is not a completed deliverable. Preserve unrelated files during any later scoped cleanup.
The Penpot prototype remains a visual reference requiring alignment with [04](04-ux-ui-spec.md).

## How packages work

Each package below defines ownership, scope, dependencies, open questions, and acceptance evidence.
Current sources are [02](02-domain-model.md), [03](03-architecture.md), [04](04-ux-ui-spec.md), and [05](05-decisions-and-open-questions.md).
The [technical review](../reviews/2026-09-04-technical-change-instructions.md) provides detailed rationale and C01–C20 traceability.
Archived sources explain history. They do not supply executable requirements that override the portfolio.

Retain package IDs P0.1–P11.2 for technical ownership and traceability. Phase 1–10 define delivery order across those packages.
A package spans phases when only part of its responsibility is ready.
Dependencies refer to the contract required by that phase, not every later feature in the referenced package.
Resolve storage and runtime contracts before Phase 1, credentials before Phase 3, and mutation recovery before Phase 5.
Record each package's phase milestone separately. Do not mark the entire package complete after partial delivery.

Definition of ready:

1. Name the user task, scope, implementation owner, and affected modules.
2. Resolve required capability facts and design decisions, or scope the package explicitly as an experiment.
3. Define permissions, durable changes, failure behavior, and observable results.
4. Set measurable acceptance criteria and required test evidence.
5. Resolve interface dependencies before assigning independent implementation work.

Definition of done:

1. Demonstrate the complete user task and its permission boundaries.
2. Pass relevant failure, recovery, accessibility, and performance checks.
3. Record versions, fixtures, environments, and results.
4. Update affected portfolio documents and superseded decision status.
5. Verify installation, upgrade, and support impact.

Statuses are TODO, IN PROGRESS, and DONE with evidence links.
Use Nx tasks for implementation checks. Tests must establish behavior rather than mirror implementation details.
Documentation changes require consistency, links, and scope checks. They do not require a district simulation.

## Delivery sequence

Every phase produces a tagged, installable version with a complete demonstration and explicit limits.
Every later version retains the working features and supported deployment modes from earlier phases.
Phase 1 supplies an operational installation. Phase 2 supplies an authenticated shell. Google administration grows from Phase 3 onward.
Do not expose unfinished feature controls as working product capabilities.

| Phase | Working version at completion | Main packages |
|---|---|---|
| 1 — Deployment foundation | All Docker, hybrid Docker with district services, and district Kubernetes install and start the complete service topology | P0.1, P1.1/P1.2 foundation, P2.4, P9.2–P9.4 foundation |
| 2 — Authenticated application foundation | API, login, frontend shell, and protected utility page demonstrate authentication and service connections | P0.1, P1.x, P3.3 diagnostics foundation, P6.1, P9.1 |
| 3 — Onboarding and platform administration | Connect a customer, manage settings, and delegate platform access | P3.1–P3.3, P9.1–P9.3 |
| 4 — EntityCache, read mode | Synchronize ChromeOS devices and browse real authorized cached data on a basic device page | P4.1, P5.1, read-only P5.2/P6.2 |
| 5 — JobService, write mode | Submit an audited test mutation, inspect jobs, and receive frontend notifications | P2.1–P2.4, P5.2, P7.1/P7.2 foundation, P9.3 |
| 6 — Device management | Complete device workflows and owner-accepted interaction patterns | P6.2, P7.x, device P8.x, P10.x, Track 12 |
| 7 — User management | Apply the accepted interaction patterns to Google Workspace users | User P4.1/P5.x/P6.2/P7.2/P8.x |
| 8 — OU management | Manage the organizational hierarchy and safe placement workflows | P11.2 and supporting cache, query, action, and import contracts |
| 9 — Groups and membership | Manage groups, settings, members, and member roles | P11.1 and supporting cache, query, action, and import contracts |
| 10 — Fleet Status and Report Dashboard | View defined fleet status and reports with authorized drill-through and coverage | P6.4, aggregate P10.2, Track 12 |

### Phase 1 — Deployment foundation

The [Phase 1 Jira task backlog](phase-1-jira-tasks.md) defines 17 implementation and qualification tasks with dependencies.
The tasks are prepared locally. Jira publication remains pending until this session has Jira access.

**Deliverable:** an installation that starts and survives restart in all three modes.
Frontend, API, independent workers, Kestra, PostgreSQL, Redis, and artifact storage have explicit deployment and configuration ownership.
Frontend and API use minimal startup images here. Their application structure and authenticated behavior follow in Phase 2.
Storage is a configured backend and persistent data location. It does not require a separate storage server in every mode.

| Mode | Phase 1 requirement |
|---|---|
| All Docker | Compose starts all executable services. Persistent volumes supply local artifacts and service state. |
| Hybrid Docker and district servers | The same images connect to configured external services. Retained local services still start through Compose. |
| Enterprise Kubernetes | Deployment manifests start the service topology with shared configuration, secrets, persistent storage, and working service discovery. |

**Acceptance:**

1. Install each mode from published images without compiling source on the target host.
2. Show a reachable installation page and truthful component startup status.
3. Verify internal networking, configured endpoints, secret distribution, and migration ownership.
4. Start PostgreSQL and Kestra with separate databases and migration boundaries.
5. Verify local artifact persistence and one shared backend with readers on separate worker hosts.
6. Qualify Kestra internal storage separately from application artifacts.
7. Restart services and reschedule a Kubernetes worker without losing the synthetic storage fixture.
8. Restore the foundational database and storage fixture into an isolated installation.
9. Record resource requests, service placement, exposed endpoints, and tested failure behavior for each mode.

Kubernetes support is a Phase 1 deliverable. Cluster startup alone does not establish metropolitan capacity or full service availability.
Record the supported Kestra edition and orchestration recovery behavior during this phase.
No commercial dependency becomes accepted merely because the profile uses Kubernetes.
Restrict the startup surface until Phase 2 authentication exists. Protect installation bootstrap with its own temporary credential.

### Phase 2 — Authenticated application foundation

**Deliverable:** an authenticated frontend shell and a structured API with live dependency connections.

1. Establish API modules for auth, configuration, database, cache, orchestration, storage, and diagnostics.
2. Establish frontend routing, auth state, login, shell navigation, shared controls, and a utility page.
3. Demonstrate sign-in, session restoration, sign-out, expiry, and rejection of unauthorized requests.
4. Provide protected identity and dependency diagnostic routes alongside minimal health and readiness routes.
5. Exercise a synthetic database transaction, Redis operation, Kestra task, and artifact round trip through the utility page.
6. Authenticate internal service requests and keep secrets out of diagnostic responses.
7. Record security events and correlation identifiers from this phase onward.
8. Run the same checks in all three deployment modes.

Application sign-in remains separate from Google background authorization.
The utility page is permission-restricted. It does not provide arbitrary SQL, Redis commands, or unbounded workflow execution.
Navigation exposes available pages only. Entity search appears when Phase 4 has searchable inventory.

### Phase 3 — Onboarding, customer settings, and platform users

**Deliverable:** a district connects its customer account and delegates access to the installed application.

1. Complete the controlled-account credential proof before shipping its onboarding flow.
2. Resolve and bind the stable Google customer ID and supported domains.
3. Save customer settings and resume onboarding after browser or service restart.
4. Request only scopes for currently enabled capabilities.
5. Invite, authorize, change, and revoke platform users through audited permission grants.
6. Apply platform, district, school, and viewer presets through explicit action and resource scopes.
7. Demonstrate denial, grant revocation, credential replacement, and restore of settings and permissions.
8. Separate external Google approval time from local setup progress.

Platform users are people allowed into Campus Commander. They are distinct from Google Workspace users managed in Phase 7.
Delegated platform access does not mean Google domain-wide delegation.
Onboarding verifies connection capabilities without requiring the full EntityCache or a completed inventory.
Preserve invitation and onboarding usability without mandatory SMTP setup.

### Phase 4 — EntityCache, read mode

**Deliverable:** a basic device page displays real, authorized inventory from PostgreSQL.
The page is a working read-only client. Its complete management experience follows in Phase 6.

1. Run device enumeration through independent workers using the established Kestra connection.
2. Persist collection progress, leases, coverage, and observation timestamps.
3. Resume interrupted synchronization without publishing incomplete coverage as deletions.
4. Query cached devices with paging, sorting, filters, counts, and stable identity.
5. Show loading, empty, stale, partial, error, and unauthorized states.
6. Demonstrate responsive local reads during a refresh and during Google unavailability.
7. Apply school scope to rows, lookup, counts, details, and selection.
8. Restore the cache and its coverage metadata in every deployment mode.

EntityCache uses infrastructure scheduling and synchronization records before the full JobService exists.
It makes no Google mutations. Phase 5 adds application mutation jobs, Jobs UI, and frontend job notifications.
Fetch customer, domain, and OU reference data as required for scope and placement without exposing full OU management.
Expand entity adapters when their management phases arrive. Do not build all four entity pages during this phase.

### Phase 5 — JobService, write mode

**Deliverable:** an authorized operator submits a controlled device annotation and follows its durable result through Jobs and notifications.
A minimal validation action supplies the mutation entry point before the complete device management page.

1. Freeze approved targets and values before accepting a job.
2. Commit job intent and dispatch outbox together.
3. Dispatch steps and parallel assignments to independent workers with durable deduplication and attempt fencing.
4. Preserve per-operation evidence and aggregate all settled assignments.
5. Demonstrate Redis ownership overwrite, owner-only cleanup, TTL renewal, expiry, recovery aggregation, and smallest-first admission.
6. Recover admission reservations and duplicated dispatch across multiple job-service instances.
7. Show queued, held, running, partial, completed, cancelled, failed, and needs-review outcomes on the Jobs page.
8. Deliver authorized frontend notifications with reconnect recovery and links to durable job state.
9. Publish verified artifacts and preserve uncertain Google outcomes after interrupted execution.
10. Restore with mutations disabled and reconcile unknown effects before replay.

Use a designated device and approved annotation for the live mutation proof.
Use synthetic workloads for broad failure and scheduling tests. No district-wide mutation is required to validate the machinery.
Apply preview, confirmation, authorization, and audit to this first write.
Google backoff remains observation-driven. This phase does not introduce a quota prediction service.

### Phase 6 — Device management and interaction acceptance

**Deliverable:** a complete device management experience accepted by the owner as the basis for later entity work.
Each iteration remains installable and preserves the accepted earlier workflows.

| Iteration | Working addition | Acceptance focus |
|---|---|---|
| 6.1 | Device lookup, grid, filters, selection, details, and freshness | Operators find and understand the intended devices. |
| 6.2 | Draft edits, Save/Reset, conflicts, preview, confirmation, and job navigation | One-field edits remain clear and auditable. |
| 6.3 | Update device dialog, large selections, bulk actions, cancellation, and recovery | Large work preserves approved values and individual outcomes. |
| 6.4 | Device CSV export/reimport and qualified device commands | Round trips preserve baselines. Commands expose their actual lifecycle. |
| 6.5 | Qualified device telemetry and final interaction refinement | Missing data stays explicit. The owner accepts the reusable experience. |

Device CSV belongs here as a proposed allocation of the existing import/export scope.
Do not infer device creation from a CSV row. Device enrollment remains outside the generic create workflow.
Collect qualified device history here when later dashboard reports need that history.
The Fleet Status and Report Dashboard remains Phase 10.

Test keyboard and screen-reader workflows, row eviction, drafts, large selections, request counts, and memory bounds.
Document the accepted interaction patterns and unresolved limitations in 04 and the prototype map.
Record explicit owner acceptance before starting Phase 7 feature implementation.
Do not treat a passing automated test or a fixed number of iterations as owner acceptance.

### Phase 7 — Google Workspace user management

**Deliverable:** user inventory and approved account actions use the accepted device interaction patterns.

1. Add user cache, scoped lookup, grid, details, and authorized cross-entity search.
2. Implement the verified account actions, draft behavior, and applicable CSV workflows from the entity catalog.
3. Respect SIS-controlled fields and protect password generation and delivery.
4. Reuse preview, jobs, notifications, artifacts, and recovery contracts.
5. Test user-specific permissions and uncertain outcomes in all deployment modes.

Group membership editing arrives in Phase 9. Platform access management continues to use the separate Phase 3 model.

### Phase 8 — Organizational unit management

**Deliverable:** operators manage the OU hierarchy and inspect authorized entity placement.

1. Add the OU tree, scoped counts, lookup, details, and verified create, rename, move, and delete actions.
2. Preserve stable IDs across path changes and validate source and destination permissions.
3. Preview dependent entity moves before an OU deletion.
4. Preserve partial outcomes and stop unsafe dependent actions when earlier moves fail.

Earlier device and user pages can select existing authorized OUs using reference data.
Phase 8 introduces full OU management. It does not delay earlier placement actions that already have qualified references.

### Phase 9 — Groups and group membership

**Deliverable:** operators manage groups, verified settings, memberships, and member roles.

1. Add group and membership cache coverage, lookup, grid, details, and settings.
2. Implement verified group creation, changes, deletion, member additions/removals, and role changes.
3. Distinguish direct membership, nested membership, and effective membership where supported.
4. Apply explicit group grants without assuming that an email domain or OU defines group authority.
5. Reuse bulk jobs, CSV contracts where applicable, notifications, and individual operation evidence.
6. Enable group membership actions from user views after the shared membership contract passes.

### Phase 10 — Fleet Status and Report Dashboard

**Deliverable:** a working dashboard answers defined district questions from qualified inventory and history.

1. Define fleet status, report calculations, thresholds, required collections, and supported filters.
2. Show support dates, stale device contact, inventory distribution, and qualified user/membership insights.
3. Display observation age, coverage gaps, and unknown values beside results.
4. Link each result to authorized underlying entities with matching filters and counts.
5. Test aggregate workloads alongside synchronization, imports, jobs, and interactive entity work.
6. Publish measured capacity and recovery limits for each supported deployment profile.

The dashboard uses local inventory by default. New Google reporting sources require separate capability proof.
Generated dashboards, widget galleries, local AI, Sheets, and external Google audit remain optional later scope.

### Release criteria shared by every phase

1. Tag the release and record exactly which workflows it supports.
2. Demonstrate a clean install and the phase's user task in all three deployment modes.
3. Upgrade from the preceding phase without losing its supported data or behavior.
4. Test applicable restart, restore, permission, accessibility, and failure cases before declaring completion.
5. Keep unavailable features out of working navigation and explain partial coverage on available pages.
6. Record versions, fixtures, measured limits, known defects, and evidence links.

Repeat capacity and recovery qualification as workloads grow. Enterprise deployment does not wait for a final platform retrofit.
V0 findings remain valid evidence within their recorded limits. The historical V1–V6 schedule no longer determines development order.

## Track 0 — Foundation

### P0.1 Workspace and release foundation — TODO

**Phase allocation:** Phases 1–2 establish deployment and application structure.

**V0 evidence:** API build passed. Frontend baseline failed. An isolated compiler override passed.
Pinned LibreGrid packages passed strict Angular compilation and a one-row Chromium loading, editing, and selection smoke test.
Full product grid integration and release-image qualification remain open.

- **Owner:** workspace and release tooling. Preserve existing root-level `frontend/` and `api/` paths.
- **Scope:** inventory existing scaffolding, qualify dependency versions, define worker/library boundaries, separate development and production configuration.
- **Dependencies:** V0 scope and current architecture. Questions 1–4, 54, 63.
- **Acceptance:** documented compatible Angular/Node/TypeScript/LibreGrid set, Nx import boundaries, reproducible lockfile, and scoped cleanup plan.
- **Phase 1 evidence:** prebuilt images boot with health checks. Customers do not compile source. No static production credentials or exposed internal ports.
- **CI:** type/schema checks, relevant domain/integration/browser tests, dependency review, image scanning, and release integrity evidence.
- **Constraint:** Nx Cloud remains optional. Use synthetic data in tests, prompts, screenshots, and support examples.

## Track 1 — Contracts and data

### P1.1 Shared contracts — TODO

**Phase allocation:** Phase 1 defines runtime/storage contracts. Later phases add auth, cache, jobs, and entity contracts before use.

- **Owner:** framework-independent contracts and domain vocabulary.
- **Scope:** stable customer/entity identity, capability registry, typed filters, selections, previews, jobs, steps, assignments, operations, artifacts, and events.
- **Dependencies:** P0.1 boundaries, P2.1/P2.4 design, P3.1 capability evidence. Questions 26–30, 65, 67.
- **Acceptance:** runtime validation and shared types cover the current [domain model](02-domain-model.md). No framework dependencies in contracts.
- **Phase scope:** device schemas in Phase 4, users in Phase 7, OUs in Phase 8, and groups/membership in Phase 9. Reports follow in Phase 10.

### P1.2 Database schema and migrations — TODO

**Phase allocation:** Phase 1 establishes databases and migrations. Every phase owns migrations for its new durable state.

- **Owner:** application PostgreSQL schema, queries, and migrations. Kestra retains its own migration ownership.
- **Scope:** typed search columns, indexes, memberships, generations, overlays, grants, manifests, attempts, audit, baselines, and committed event replay.
- **Dependencies:** P1.1 and P2.1. Questions 28–34.
- **Acceptance:** query-plan evidence under combined workloads, bounded transactions, pool budgets, and atomic intent/outbox and result/audit updates.
- **Recovery:** test expand/contract migration compatibility and rollback windows. Use forward repair or verified restore for irreversible changes.

## Track 2 — Jobs and artifacts

### P2.1 Job durability and admission design — TODO

**Phase allocation:** Phase 1 defines shared storage/runtime boundaries. Phase 4 defines sync execution. Phase 5 completes mutation admission and durability.

**V0 evidence:** Kestra aggregated ten settled assignments with failures and bounded concurrency.
Duplicate HTTP dispatch required assignment deduplication. Redis ownership, expiry, and smallest-first gate probes passed.
Multi-instance event aggregation, admission reservation recovery, and Kestra restart tests remain open.

- **Owner:** application job state, Kestra contracts, retry policy, job-service events, and admission transitions.
- **Scope:** define every job, step, assignment, operation, attempt, lease, cancellation, and reconciliation transition before implementation.
- **Dependencies:** current owner policy and capability research. Questions 5–14, 19, 66.
- **Acceptance:** a deterministic fault experiment proves all-settled aggregation, partial-batch recovery, stale-attempt rejection, and uncertain-outcome handling.
- **Admission evidence:** ownership overwrite, owner-only cleanup, 300-second expiration, reporting during backoff, aggregated recovery, and smallest-first pending jobs.
- **Open settings:** recovery threshold, counted unit, observation window, reporting interval, FIFO ties, and admission serialization.
- **Constraint:** retain Kestra. PostgreSQL alone is not a selected replacement for the orchestration engine.

### P2.2 Job execution implementation — TODO

**Phase allocation:** Phase 5 implements mutation execution. Phases 6–9 add entity handlers.

- **Owner:** Kestra integration and worker step execution.
- **Scope:** durable receipt, immutable manifest, correlated Kestra dispatch, parallel assignments, per-operation evidence, and final artifact consolidation.
- **Dependencies:** P1.x, P2.1, P2.4 local adapter, P3.1, and P9.1.
- **Phase 5 acceptance:** one annotation survives failures before dispatch, after remote acceptance, and before local result commit.
- **Phase 5/6 acceptance:** a large job settles every assignment. Only eligible unresolved operations retry. Recorded successes never replay blindly.
- **Cancellation:** check before external requests and after results. Save successful and unknown effects. Cancellation does not claim rollback.
- **Sizing:** assignment size, active workers, and API batch size remain independent. The 500-operation example is not a provider limit.

### P2.3 Jobs and audit surface — TODO

**Phase allocation:** Phase 5 delivers Jobs and frontend job notifications.

- **Owner:** job read API and Jobs UI.
- **Scope:** queued, held, running, completed, completed-with-errors, failed, cancelled, and needs-review presentation from durable state.
- **Dependencies:** P2.1, P6.1, P9.1, and P2.2 execution evidence.
- **Acceptance:** counts preserve succeeded, failed, skipped, cancelled, and unknown outcomes. Unknown effects remain actionable.
- **Evidence access:** authorized pagination, event recovery, artifact expiry, downloadable results, cancellation, and safe retry eligibility.
- **Copy:** never present accepted device commands as executed. Never hide successful work behind an unexplained total-failure label.

### P2.4 Job-storage interface and adapters — TODO

**Phase allocation:** Phase 1 delivers local and one qualified shared backend. Phase 5 extends evidence to real mutation artifacts.

**V0 evidence:** local file completion with publication rollback and verified recovery passed.
Host power loss, complete adapter behavior, shared storage, and Kestra storage recovery remain unverified.

- **Owner:** proposed job-storage module and application publication service.
- **Scope:** artifact IDs, stage/inspect/publish/read/remove contracts, streaming, checksums, immutable attempt outputs, and recovery.
- **Dependencies:** P2.1 and P1.1 metadata contracts. Questions 7, 59, 67.
- **V0/Phase 1 foundation and Phase 5 acceptance:** local adapter publishes only completed verified artifacts. Crash between write completion and metadata commit is recoverable.
- **Distributed gate:** qualify shared filesystem or S3-compatible storage with real cross-host readers before distributing workers.
- **Failure evidence:** partial upload, checksum mismatch, duplicate publication, stale attempts, missing mounts, storage outage, cleanup races, and restore.
- **Kestra boundary:** qualify internal storage separately. The application adapter does not automatically configure Kestra plugins.
- **Migration:** preserve artifact IDs while copying, verifying, and switching locators under paused affected dispatch.

## Track 3 — Google connection

### P3.1 Credential proof and provider — TODO

**Phase allocation:** Required credential proof precedes Phase 3 onboarding. Add method coverage before later entity actions.

**V0 status:** awaiting controlled-account access. The [capability matrix and test procedure](../validation/v0-2026-09-05/google-credential-proof.md) are prepared.
No live Google credential or endpoint test has run.

- **Owner:** Google credentials, token lifecycle, and capability evidence.
- **Scope:** prove the candidate district-owned offline OAuth flow with actual API scopes before building onboarding.
- **Dependencies:** V0 experiment setup. Questions 44, 49, 51–52, 65.
- **Acceptance:** unattended read after restart, access-token reuse, renewal, revocation, identity replacement, correct customer resolution, and least-privilege tests.
- **Enterprise:** qualify authenticated signing or permitted encrypted-key profiles separately. Direct service-account roles require complete enabled-method coverage.
- **Constraint:** identity-only app login does not grant Google API access. Do not restore Architecture A's missing credential exchange.

### P3.2 Setup wizard and resumable checks — TODO

**Phase allocation:** Phase 3 delivers onboarding and customer settings.

- **Owner:** connection workflow and onboarding UI.
- **Scope:** read-only first, generated capability scopes, district hostname, credential setup, external approval, propagation, and inventory progress.
- **Dependencies:** P3.1 accepted experiment, P6.1, P9.1/P9.2, and Track 12 D-F. Questions 51–55, 71, 74.
- **Acceptance:** closing the browser or restarting services preserves progress. Partial failures identify capability and required action.
- **Copy:** derive scope counts from enabled capabilities. No universal eight-scope, credit-card, or one-session Google-completion promise.
- **Notifications:** in-app progress works alone. District SMTP is optional.

### P3.3 Connection health — TODO

**Phase allocation:** Phase 2 supplies service diagnostics. Phase 3 adds Google connection diagnostics.

- **Owner:** capability diagnostics and health API.
- **Scope:** distinguish credential, permission, license, reporting-policy, network, and freshness failures.
- **Dependencies:** P3.1 and P6.1.
- **Acceptance:** revocation updates affected capabilities without restart. Diagnostics explain unavailable data without classifying it as healthy.
- **UI:** footer and detailed diagnostics use the same health state. Connection checks lead to a defined result surface.

## Track 4 — Synchronization

### P4.1 Collection refresh and reconciliation — TODO

**Phase allocation:** Phase 4 delivers device EntityCache. Extend coverage in each later entity phase.

- **Owner:** collection leases, enumeration, targeted reads, generations, overlays, and absence handling.
- **Scope:** device reads in Phase 4. User, OU, and group management adapters follow Phases 7, 8, and 9. Reference data arrives when required.
- **Dependencies:** P1.x, P2.1/P2.4, P3.1, and P9.1. Questions 20–25, 30, 62.
- **Acceptance:** overlapping refreshes join safely. Stale leases, incomplete pages, or permission loss cannot publish false removals.
- **Concurrency:** no global write freeze. A sweep cannot overwrite a newer accepted write. All read surfaces use the effective projection.
- **Scale:** measure membership and settings request counts. Publish achievable freshness, not universal hourly guarantees.

## Track 5 — Query and selection

### P5.1 Entity query and cross-entity lookup — TODO

**Phase allocation:** Phase 4 delivers device queries. Phases 7–9 expand entity lookup.

**V0 evidence:** scoped queries over one million synthetic rows produced SQL p95 values from 0.55 to 7.79 milliseconds.
This narrow spike excludes the effective projection, full permission model, browser, and metropolitan combined workload.

- **Owner:** authorized SQL query API and LibreGrid row-range adapter.
- **Scope:** typed filters, ranked exact/prefix/selected fuzzy lookup, bounded pages, counts, OU aggregates, and cursor anchors.
- **Dependencies:** P1.x, P9.1, and V0 query experiments. Questions 28, 62, 69.
- **Acceptance:** latency objectives pass with sync, imports, audit, and worker traffic. Counts and rows share permission rules.
- **Grid contract:** deep row jumps have bounded behavior. Do not equate keyset pagination with arbitrary numeric offsets.
- **Phase scope:** devices in Phase 4, users in Phase 7, OUs in Phase 8, and groups in Phase 9.

### P5.2 Selection and preview freezing — TODO

**Phase allocation:** Phase 4 supports browsing selection. Phase 5 freezes approved work. Phase 6 qualifies large device selections.

- **Owner:** Redis browsing selections and durable target materialization.
- **Scope:** original filter, inclusions/exclusions, selection revision, scope, expiry, and LibreGrid selection provider.
- **Dependencies:** P1.x, P5.1, P9.1, and P2.1. Questions 15–19, 69.
- **Acceptance:** large select-all-filtered stays compact over the wire. Preview freezes targets, values, versions, and exact counts.
- **Recovery:** Redis expiry leaves approved manifests intact. Later matching entities never silently join approved jobs.
- **Permission:** revocation or scope change blocks affected confirmation and undispatched work.

## Track 6 — Frontend and insight

### P6.1 Shell and theming — TODO

**Phase allocation:** Phase 2 delivers the shell. Phase 3 adds customer context. Phase 4 adds entity lookup.

- **Owner:** Angular shell, navigation, Material tokens, and LibreGrid theme integration.
- **Dependencies:** P0.1, P9.1, and Track 12 shared controls.
- **Acceptance:** Phase 2 supplies login, shell, utility page, and keyboard navigation. Add customer context in Phase 3 and search in Phase 4.
- **Sources:** UX sections 3–10. Preserve existing design assets until qualified replacement.

### P6.2 Entity grids — TODO

**Phase allocation:** Phase 4 supplies the basic device page. Phase 6 establishes accepted interactions. Phases 7–9 reuse them.

- **Owner:** LibreGrid row model, selection rendering, filter chips, states, and detail navigation.
- **Dependencies:** P5.1/P5.2, P6.1, and Track 12 D-D. Questions 69, 71.
- **Acceptance:** paging, grouping, sorting, filtering, row eviction, and SSE preserve selection and draft state.
- **Accessibility:** complete keyboard and screen-reader workflows, bounded grid scrolling, visible focus, and compliant target spacing.
- **Scale:** bounded browser memory and request counts under the qualification workload. Compact default remains subject to density testing.

### P6.3 Optional language assistance — TODO, deferred

**Phase allocation:** Optional after the ten-phase baseline unless separately authorized.

- **Owner:** optional local filter translator and its evaluation set.
- **Scope:** structured filter output with field/operator/cost validation and editable preview.
- **Dependencies:** working deterministic filters and separate feature authorization. No Phase 1–10 release dependency.
- **Acceptance:** timeouts and invalid output fall back to ordinary filters. No SQL execution, mutations, or authorization bypass.
- **Privacy:** document actual local data handling. Do not promise universal free-text anonymization.

### P6.4 Inventory reports and insight — TODO

**Phase allocation:** Phase 10 delivers Fleet Status and the Report Dashboard.

- **Owner:** report definitions, authorized drill-through, coverage, and district policy thresholds.
- **Dependencies:** P4.1/P5.1, P6.1, and P9.1. Questions 70, 75.
- **Phase 10 acceptance:** fleet status and inventory reports expose definitions, age, missing data, and matching entities.
- **Phase 10 coverage:** membership and battery reports use qualified coverage from earlier phases. SIS-controlled fields remain identifiable.
- **Scope:** Chrome fleet reports and external Google audit remain distinct connectors with separate capability evidence.

## Track 7 — Mutations and editing

### P7.1 Safety workflow — TODO

**Phase allocation:** Phase 5 supplies the first complete safety chain. Phase 6 refines its everyday interaction.

- **Owner:** draft/selection, preview, confirmation, independent approval where required, durable receipt, and result navigation.
- **Dependencies:** P2.x, P5.2, P6.1, and P9.1. Questions 17–19, 73.
- **Acceptance:** exact counts and paginated targets match the immutable manifest. Changed scope, actor, values, or action version invalidates approval.
- **UX:** one-field changes use concise review. Destructive actions explain consequences and add acknowledgments.

### P7.2 Action catalog — TODO

**Phase allocation:** Phase 5 proves one device annotation. Phases 6–9 add each entity action catalog.

- **Owner:** capability-specific validation, Google handlers, and replay classification.
- **Scope:** retain Users and Devices actions from [02](02-domain-model.md). Validate each before release.
- **Dependencies:** P3.1 registry, P7.1, and P2.2.
- **Phase 5 acceptance:** one device annotation passes dispatch, verification, audit, and crash tests.
- **Phase 6–9 acceptance:** native and HTTP batches respect endpoint limits and individual results. Group membership uses explicit edge operations.
- **Constraint:** remove Classroom-ownership warnings. SIS ownership follows district policy. Bulk Super Admin grants remain excluded.

### P7.3 Draft editing and Update device — TODO

**Phase allocation:** Phase 6 establishes device drafts and bulk editing. Later entity phases reuse the accepted behavior.

- **Owner:** draft state outside loaded grid rows and editable field validation.
- **Dependencies:** P6.2, P7.1, Track 12 D-A/D-B. Questions 69, 71.
- **Acceptance:** Save prepares preview. Confirmation creates a job. Reset discards drafts without claiming Google rollback.
- **Update device:** annotated fields and OU only as verified. Prepend/append computes final approved values once before retries.
- **Large paste:** stage server-side within import limits. SSE changes create explicit conflicts without destroying drafts.

## Track 8 — Import and export

### P8.1 CSV export and baseline — TODO

**Phase allocation:** Proposed Phase 6 device export, with entity-specific expansion in Phases 7–9.

- **Owner:** streaming export, stable row metadata, baseline artifacts, authorization, and expiry.
- **Dependencies:** P2.4, P5.1/P5.2, P9.1, and Track 12 D-C. Questions 35–37, 41–42.
- **Acceptance:** untouched CSV round-trips with no changes. Visible machine metadata resolves a server-held baseline.
- **Limits:** bounded memory, formula-injection handling, exact schema rules, and authorized artifact delivery.
- **Deferred:** Google Sheets follows separate principal, file ownership, sharing, and authorization qualification.

### P8.2 Reimport and conflict review — TODO

**Phase allocation:** Proposed Phase 6 device reimport, with entity-specific expansion in Phases 7–9.

- **Owner:** streaming validation, canonical merge rules, persistent conflict decisions, and resumable execution.
- **Dependencies:** P8.1 and P7.1/P2.2. Questions 37–43.
- **Acceptance:** B/E/C fixtures classify unchanged, update, already-applied, conflict, invalid, and unauthorized rows exactly.
- **Recovery:** expired baselines reject round-trip comparison. Revalidation detects live drift. Successful operations never repeat blindly.
- **Capacity:** enforce the current 50,000-row qualification cap. Raise it only after larger combined-load evidence.

### P8.3 Explicit create workflows — TODO

**Phase allocation:** Phase 7 introduces supported user creation. Phases 8/9 add verified OU/group create workflows.

- **Owner:** create forms and explicitly selected import creation mode.
- **Dependencies:** P8.2, P7.2 method proof, and credential/permission contracts.
- **Acceptance:** unknown IDs do not become automatic creates. Required fields, duplicate identity, and ambiguous creation have explicit outcomes.
- **Passwords:** generate secrets server-side and prove protected initial delivery or district-approved recovery. Exclude secrets from artifacts.

## Track 9 — Security and operation

### P9.1 Identity, permissions, and security boundary — TODO

**Phase allocation:** Phase 1 protects bootstrap and secrets. Phase 2 adds auth. Phase 3 adds delegation. Later phases extend denial tests.

**V0 evidence:** the [initial threat model](../validation/v0-2026-09-05/threat-model.md) defines boundaries and required denial tests.
Security controls and district policy review remain open.

- **Owner:** app OIDC, invitations, Redis sessions, grants, scopes, service authentication, and threat model.
- **Dependencies:** V0 threat model and P1.1 contracts. Questions 44–50, 73.
- **Phase 2/3 acceptance:** authentication and delegated grants work. Denial tests extend to each data surface as it arrives.
- **Phase 5 onward acceptance:** source/destination checks, approval separation, permission revocation, and protected artifacts pass denial tests.
- **Recovery:** demonstrate logout, expiry, account recovery, secret rotation, and Google identity replacement.

### P9.2 Installer and deployment packaging — TODO

**Phase allocation:** Phase 1 ships all three modes. Every phase verifies install and upgrade of its working version.

**V0 evidence:** static review found missing Dockerfiles, incorrect Kestra configuration, absent workers, and incomplete persistence configuration.
The [lab procedure](../validation/v0-2026-09-05/lab-procedure.md) records profile prerequisites and pending installation studies.
Windows Docker Desktop was unavailable during this run. Isolated process tests do not qualify container installation.

- **Owner:** signed images, Linux installer, profiles, preflight, setup entry, trial promotion, and removal procedures.
- **Dependencies:** P0.1 and P3.1 proof before Google onboarding. Questions 53–58, 71, 74.
- **Acceptance:** a novice walkthrough uses sample data or read-only connection without compilation or mandatory AI setup.
- **Profiles:** all Docker, hybrid Docker with district services, and district Kubernetes ship in Phase 1 using shared images and configurable endpoints.
- **Removal:** stop preserves data. Explicit erasure inventories volumes, host files, secrets, artifacts, backups, and external credentials.
- **Constraint:** no claim that `docker compose down -v` erases bind mounts or revokes Google access.

### P9.3 Observability, backup, and recovery — TODO

**Phase allocation:** Phase 1 begins operations and recovery. Add state-specific backup, audit, and restore evidence in every phase.

- **Owner:** metrics, logs, redacted support bundles, retention, backups, restore, and upgrade procedures.
- **Dependencies:** P1.2/P2.1/P2.4. Questions 44–45, 47–49, 59–63, 72.
- **Phase 1–4 acceptance:** restore the foundation first, then credentials, permissions, settings, and inventory as each phase adds them.
- **Phase 5 acceptance:** restore with mutations disabled. Reconcile the recovery-point gap and quarantine unsafe unknown operations.
- **Operations:** test near-full disk, storage outage, Redis loss, database failure, expired certificates, and credential revocation.
- **Upgrade:** old manifests retain action semantics. Migration failures leave a documented recovery path.

### P9.4 Distributed deployment qualification — TODO

**Phase allocation:** Phase 1 delivers the cluster foundation. Every phase qualifies its features across distributed services.

- **Owner:** external services, worker hosts, shared backend, and district platform acceptance.
- **Dependencies:** P2.4 foundation, P9.2/P9.3, and configuration contracts for Phase 1. Add P2.2 execution tests in Phase 5. Questions 57–59, 67–68.
- **Acceptance:** Phase 1 proves deployment and shared storage. Phase 2 adds authenticated replicas. Phase 5 proves distributed admission and recovery.
- **Kestra:** document supported edition, licensing, orchestration downtime, and tested recovery. Kubernetes alone is not an HA claim.
- **District pilot:** qualify database administration, TLS, secrets, backups, storage migration, and the district's actual platform.

## Track 10 — Device detail

### P10.1 Remote commands — TODO

**Phase allocation:** Phase 6 delivers qualified device commands and their lifecycle.

- **Owner:** verified command issuance, provider command IDs, lifecycle observation, and device detail.
- **Dependencies:** P7.1/P7.2, P2.2, and method-specific capability evidence.
- **Acceptance:** Reboot, Wipe user data, and Powerwash show exact devices and consequences before confirmation.
- **Results:** distinguish accepted, pending, acknowledged, executed, failed, and expired according to provider support.
- **Recovery:** unknown issuance does not automatically repeat a destructive command. Local cancellation does not claim remote cancellation.

### P10.2 Telemetry and battery history — TODO

**Phase allocation:** Phase 6 supplies qualified device telemetry/history. Phase 10 consumes aggregates for dashboard reports.

- **Owner:** reporting prerequisites, ingestion, bounded history, coverage, and battery presentation.
- **Dependencies:** P3.1 capability evidence, P4.1, and defined retention/coverage contracts. P6.4 later consumes this history. Questions 60, 62, 75.
- **Acceptance:** missing samples remain unknown. District thresholds have provenance. Per-device trends and aggregates preserve coverage.
- **Capacity:** measure raw and rollup storage. Validate proposed 30 daily samples and 24 monthly aggregates before expansion.

## Track 11 — Groups and OUs

### P11.1 Groups and membership — TODO

**Phase allocation:** Phase 9 delivers groups and group membership.

- **Owner:** Groups grid, verified settings, membership search, create/update/delete, and role changes.
- **Dependencies:** P4.1/P5.1 expansions, P7.1/P7.2, and Group Settings field verification.
- **Acceptance:** UI fields have registry backing. Direct and nested members remain distinct. Group permissions do not infer OU ownership.
- **Load:** settings and membership schedules respect measured request cost and expose partial coverage.

### P11.2 OUs — TODO

**Phase allocation:** Phase 8 delivers OU management. Earlier phases use limited reference data for scope and placement.

- **Owner:** hierarchy, computed counts, creation, rename, reparent, and delete-with-contents workflow.
- **Dependencies:** P4.1/P5.1 expansions, P7.1/P7.2, and structural permission rules.
- **Acceptance:** stable IDs survive path changes. Source and destination permissions apply to every move.
- **Deletion:** preview move-to-parent, root, chosen OU, or cancel. Settle dependent moves before attempting deletion.
- **Failure:** partial moves remain visible and auditable. Counts share the effective read model with entity grids.

## Track 12 — Interaction design

Preserve board inventory in [prototype-map](prototype-map.md). Update [04](04-ux-ui-spec.md) and the map when prototype changes occur.
No live Penpot boards were edited by this documentation integration.

| ID | Design deliverable | Dependent package |
|---|---|---|
| D-A | Draft styling, baseline conflicts, Save/Reset, changed-count toolbar, pending-row filter, preview, and confirmation | P7.3 |
| D-B | Update device fields, valid operation modes, exact counts, and approved final values | P7.3 |
| D-C | CSV baseline/expiry, visible metadata, merge review, explicit creation, and later Sheets authorization | P8.x |
| D-D | Reusable chip filters and cross-entity lookup with typed query contract | P5.1/P6.2 |
| D-E | Detail coverage, grouping selection, OU safety, command device lists, state polish, theme controls, and component masters | P6.x/P10.x/P11.x |
| D-F | Credential-profile setup, generated scope counts, read-only start, propagation, and diagnostics | P3.2 |
| D-G | Keyboard and screen-reader workflows, focus recovery, target spacing, and density study | P6.2 |
| D-H | Held jobs, unknown results, verification, partial settlement, report coverage, and artifact expiry | P2.3/P6.4 |

Detailed design remains required where interaction rules do not determine layout or workflow comprehension.
Use representative occasional helpers and district operators. Proposed initial study: five helpers and three district administrators.
Record completion, mistakes, support interventions, and users' understanding of destructive effects before confirmation.

## Qualification workloads and targets

These are proposed experiments. They are not verified district inventories, procurement specifications, or support guarantees.

| Dimension | Small | District standard | Metropolitan stress |
|---|---:|---:|---:|
| Users | 2,000 | 50,000 | 1,000,000 |
| ChromeOS devices | 2,000 | 50,000 | 1,000,000 |
| Groups | 200 | 5,000 | 50,000 |
| Direct membership edges | 20,000 | 1,000,000 | 20,000,000 |
| OUs | 50 | 1,000 | 10,000 |
| Retained audit events | 100,000 | 10,000,000 | 100,000,000 |
| Active operators | 3 | 30 | 200 |
| CSV rows for qualification | 10,000 | 50,000 | 1,000,000 |

Include skewed groups, repeated names, deep OUs, long notes, sparse custom fields, domains, and suspended users.
Run search alongside sync generation staging, import validation, audit queries, and worker requests with backoff.
Use a deterministic Google simulator for load and faults. Use controlled real accounts for protocol, permissions, and license behavior.
Record warm/cold results, p95/p99, failures, hardware, software versions, network, browser, and fixture distribution.

| Measurement | Proposed target and boundary |
|---|---|
| Exact entity lookup | API p95 ≤200 ms, p99 ≤500 ms with background work |
| Supported filtered first page | API p95 ≤400 ms, p99 ≤1 second, up to 100 rows |
| Visible search after typing settles | Browser p95 ≤700 ms including debounce and declared 50 ms network round trip |
| Selection toggle | Durable server update p95 ≤200 ms, excluding deliberate client batching |
| Confirmed job receipt | p95 ≤500 ms after preview preparation |
| Twenty-target preview | p95 ≤5 seconds with available Google capacity and declared latency |
| Large preview | Visible progress within one second. Completion follows measured preparation cost. |
| One-row dispatch | p95 ≤5 seconds without type hold, entity conflict, capacity shortage, or Google failure |
| Grid interaction | No repeated main-thread stalls above 200 ms. Tested task stays within 300 MB steady browser memory. |
| Safe work after worker crash | Resumes within 60 seconds. Unknown effects remain quarantined. |
| Local setup | 30 minutes after prerequisites exist. Google approval and inventory completion measured separately. |
| Routine user tasks | Proposed 90% unaided completion in a validation round, with sample size reported |

Initial hardware experiments use 4 vCPU/8 GB/100 GB SSD for small and 8 vCPU/32 GB/500 GB SSD for district standard.
Metropolitan experiments start with separate application workers and PostgreSQL at 16–32 vCPU, 64–128 GB RAM, and 2 TB SSD.
Measure indexes, WAL, staging, artifacts, telemetry, and backups separately before publishing supported requirements.

Proposed recovery objectives follow the review: small RPO 24 hours/RTO four hours, district RPO 15 minutes/RTO two hours.
The review proposes enterprise RPO five minutes/RTO one hour, subject to district-operated availability and recovery staffing.
Enterprise objectives require a district-specific failure and durability agreement before qualification.
RPO permits loss of local evidence within its window. Reconcile external effects before replaying work after restore.
A five-minute admission TTL is independent from safe worker recovery and whole-installation recovery objectives.

### Required failure evidence

- Frozen targets exclude later matching arrivals. Permission revocation blocks affected undispatched operations.
- Previous-owner cleanup cannot delete a replaced hold. Continuing-backoff reports overwrite ownership and reset 300-second expiration.
- Reports continue during retry sleeps. Crashed-worker cached status cannot renew holds indefinitely.
- Recovery aggregation rejects stale success streaks. Pending jobs resume smallest first without stopping existing jobs.
- Unsafe success with a lost response becomes unknown. Local fencing does not claim to fence Google.
- Partial batches retry only eligible failures. Steps collect every settled assignment.
- Incomplete or unauthorized sweeps do not mark removals. Newer writes survive stale observations.
- Storage crashes leave incomplete artifacts unpublished. Cross-host reads verify published content.
- Database/audit outage stops new external dispatch. Restored jobs do not automatically repeat uncertain effects.
- SSE replay handles out-of-order commits, missing broadcasts, duplicate events, and permission changes.
- Imports preserve baseline semantics, bounded memory, exact counts, and successful operation evidence after restart.
- Upgrade, low disk, expired credentials, and backend migration have tested recovery procedures.

Use real PostgreSQL integration tests for transactions, migrations, claims, and replay.
Use supported Vitest/Nx tooling for domain tests and Playwright for complete browser workflows.
Run accessibility automation alongside keyboard and screen-reader checks.
Do not infer end-to-end correctness from unit tests or visual snapshots alone.

## Implementation ownership map

| Module or artifact | Owner and boundary |
|---|---|
| `frontend/` | P6/P7 interaction work. Preserves LibreGrid and the Material theme. |
| `api/` | P5/P9 query, permission, preview, acceptance, and SSE contracts |
| Proposed `workers/` | P2/P4/P7/P10/P11 independent execution modules |
| Shared contracts/domain modules | P1.1 types, runtime schemas, and domain rules without UI/API framework dependencies |
| Proposed database/Google modules | P1.2 and P3.1 adapters under explicit contracts |
| Proposed jobs/job-storage modules | P2.1/P2.4 orchestration integration, admission, artifact transfer, and publication |
| Compose/deployment/operations artifacts | P0.1/P9 signed releases, installer, external endpoints, backup, upgrade, and recovery |

These paths define proposed ownership. They do not claim that the modules already exist.
Resolve interfaces before independent implementation. Do not create duplicate scaffolds solely to match a diagram.
