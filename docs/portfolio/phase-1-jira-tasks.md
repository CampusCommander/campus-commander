# Phase 1 — Jira task backlog

**Publication status: 17 tasks and 36 dependency links created and verified in Jira.**

Target: the **Campus-Commander** Jira space. Requested issue type: **Task**.
Atlassian Rovo resolved Campus-Commander to project **KAN** and confirmed the **Task** issue type.
The project contained no duplicate Phase 1 tasks or existing Phase 1 parent. Jira supplied its default fields.
The local identifiers below are planning references. They are not Jira issue keys.

This backlog implements [Phase 1](06-work-breakdown.md#phase-1--deployment-foundation) of the accepted development sequence.
It preserves all three installation modes and the retained stack.
The [V0 findings](../validation/v0-2026-09-05/technical-findings.md) supply known defects and qualification requirements.
The [structured draft](phase-1-jira-tasks.json) records the same tasks and their Jira publication results.

## Completion boundary

Phase 1 ends with frontend, API, independent workers, PostgreSQL, Redis, Kestra, and artifact storage operational in all three modes.
Minimal frontend and API startup behavior belongs here. Full application auth, login, shell, and utility routes belong to Phase 2.
Google onboarding follows in Phase 3. EntityCache and mutation JobService follow in Phases 4 and 5.
Bootstrap protection, durable storage, basic operations, and foundational recovery are required now.
All checks use synthetic data. All tasks remain unimplemented until evidence establishes their acceptance criteria.

## Task index

| Local ID | Task | Blocked by |
|---|---|---|
| P1-T01 | Define and validate the Phase 1 deployment configuration contract | None |
| P1-T02 | Qualify the Kestra edition, runtime version, and deployment topology | P1-T01 |
| P1-T03 | Build minimal frontend, API, and worker release images | P1-T01 |
| P1-T04 | Bootstrap isolated application and Kestra databases | P1-T01 |
| P1-T05 | Bootstrap Redis with explicit security and restart behavior | P1-T01 |
| P1-T06 | Implement the local artifact storage foundation | P1-T01, P1-T04 |
| P1-T07 | Qualify one shared artifact backend across separate worker hosts | P1-T06 |
| P1-T08 | Run authenticated Kestra with independent workers and qualified internal storage | P1-T02, P1-T03, P1-T04 |
| P1-T09 | Protect the startup page with HTTPS and installation bootstrap access | P1-T01, P1-T03 |
| P1-T10 | Deliver the complete all-Docker installation profile | P1-T03, P1-T04, P1-T05, P1-T06, P1-T08, P1-T09 |
| P1-T11 | Deliver the hybrid Docker and district-server installation profile | P1-T07, P1-T10 |
| P1-T12 | Deliver the enterprise Kubernetes installation profile | P1-T07, P1-T08, P1-T09 |
| P1-T13 | Deliver repeatable preflight, install, resume, and upgrade commands | P1-T10, P1-T11, P1-T12 |
| P1-T14 | Restore the foundational state into an isolated installation | P1-T10, P1-T11, P1-T12 |
| P1-T15 | Qualify restart, outage, and resource failure behavior across all profiles | P1-T10, P1-T11, P1-T12 |
| P1-T16 | Publish verified Phase 1 release artifacts and gate profile regressions in CI | P1-T13, P1-T14, P1-T15 |
| P1-T17 | Accept the Phase 1 release through operator walkthroughs | P1-T16 |

## Execution guidance

Start the configuration contract first. Then progress image, database, Redis, and Kestra qualification work through their listed dependencies.
Complete local storage before its shared adapter. Shared storage must pass before hybrid and cluster acceptance.
The all-Docker and Kubernetes profiles can progress independently once their component prerequisites pass.
Installer integration, restore, and fault qualification follow the profile implementations. Release publication and operator acceptance close the phase.

Responsibility labels identify technical ownership. They do not assign tasks to named Jira users.
Do not set story points, due dates, or sprint commitments without team planning.
Recheck the shared configuration contract when a component qualification changes supported settings or versions.

## Publication procedure

1. Confirm Jira access and resolve the exact Campus-Commander space, project key, and supported Task issue type.
2. Search existing Phase 1 work for duplicates before creating tasks.
3. Reuse an existing phase parent when the project already defines one.
4. Create tasks in the dependency order below, preserving their local references in descriptions.
5. Resolve local dependencies into native Jira blocking links and include the issue keys in task descriptions.
6. Record each returned Jira issue key and URL in the structured draft immediately after creation.
7. Verify task descriptions and dependency links through Jira reads before reporting completion.

This structured draft is a planning format. It is not a claim about the Jira plugin's request schema.

## P1-T01 — Define and validate the Phase 1 deployment configuration contract

**Issue type:** Task  
**Responsible role:** Platform lead  
**Planning packages:** P0.1, P1.1, P9.2  
**Blocked by:** None  
**Jira issue:** [KAN-4](https://easton-consulting.atlassian.net/browse/KAN-4)

### What to build

Define one configuration contract for all Docker, hybrid Docker with district servers, and enterprise Kubernetes. Cover frontend, API, workers, PostgreSQL, Redis, Kestra, artifact storage, and the HTTPS edge. Make each dependency's local or external placement explicit.

### Acceptance criteria

- [ ] Document the supported host and cluster assumptions, image architectures, service ownership, and required network paths.
- [ ] Define endpoint, TLS, secret-reference, persistence, resource, and health settings without storing secret values in release files.
- [ ] Validate sample configurations for all three profiles and reject missing or contradictory required settings before startup.
- [ ] Define application and Kestra database ownership separately.
- [ ] Use identical application images across profiles. Record unresolved component version qualification as explicit follow-on work.
- [ ] Document that frontend and API supply startup behavior only in Phase 1. Full application auth and utilities belong to Phase 2.

### Required evidence

Three validated example configurations, a rejected-config demonstration, service placement matrix, and a recorded configuration decision.

### Scope boundary

Exclude: Google credentials, entity contracts, full application auth, and district capacity guarantees.

## P1-T02 — Qualify the Kestra edition, runtime version, and deployment topology

**Issue type:** Task  
**Responsible role:** Orchestration and platform lead  
**Planning packages:** P0.1, P9.4  
**Blocked by:** P1-T01  
**Jira issue:** [KAN-5](https://easton-consulting.atlassian.net/browse/KAN-5)

### What to build

Establish an executable Kestra deployment choice for each Phase 1 profile. Verify the retained edition's capabilities and recovery behavior before manifests depend on them. Use V0's 1.3.37 result as evidence to assess, not as automatic release qualification.

### Acceptance criteria

- [ ] Record the chosen Kestra version, plugin versions, image digest, edition, license obligations, and supported topology.
- [ ] Prove first-run credential initialization and authenticated control-plane access for the selected image.
- [ ] Identify repository, queue, internal-storage, and worker connectivity requirements for each profile.
- [ ] Demonstrate stop and restart of a synthetic execution and document observed recovery behavior.
- [ ] Record anonymous usage collection and disable or configure it according to an explicit installation policy.
- [ ] Do not introduce a commercial dependency or claim high availability without an accepted decision and supporting evidence.

### Required evidence

Topology decision, pinned runtime inventory, redacted startup evidence, synthetic restart result, and unresolved limitations.

### Scope boundary

Exclude: Google mutation flows, JobService admission policy, and a replacement orchestration engine.

## P1-T03 — Build minimal frontend, API, and worker release images

**Issue type:** Task  
**Responsible role:** Application foundation and build lead  
**Planning packages:** P0.1  
**Blocked by:** P1-T01  
**Jira issue:** [KAN-6](https://easton-consulting.atlassian.net/browse/KAN-6)

### What to build

Produce runnable Phase 1 images from the retained Nx workspace. Preserve existing root-level frontend and API projects. Add the minimal independent worker entry point needed for startup and synthetic infrastructure probes.

### Acceptance criteria

- [ ] Correct the V0 frontend compiler inheritance defect through scoped application configuration.
- [ ] Build frontend, API, and independent worker images through reproducible Nx targets and the application lockfile.
- [ ] Pin base images and verify the declared image architectures.
- [ ] Serve minimal startup content and process health responses without implementing Phase 2 login or entity pages.
- [ ] Run runtime processes without unnecessary privilege and support graceful termination.
- [ ] Start the same image digests under profile-specific configuration without rebuilding source.
- [ ] Publish candidate images to the project-owned registry so profile installation tasks can use digests without target-host builds.

### Required evidence

Ordinary Nx build results, image digests, container startup checks, and a list of scoped scaffold changes.

### Scope boundary

Exclude: Full API module implementation, application login, EntityCache, and mutation workers.

## P1-T04 — Bootstrap isolated application and Kestra databases

**Issue type:** Task  
**Responsible role:** Database and platform lead  
**Planning packages:** P1.2, P9.2  
**Blocked by:** P1-T01  
**Jira issue:** [KAN-7](https://easton-consulting.atlassian.net/browse/KAN-7)

### What to build

Supply repeatable PostgreSQL provisioning and application migration startup for local and external database configurations. Keep Kestra migrations under Kestra's ownership.

### Acceptance criteria

- [ ] Qualify and pin the PostgreSQL release used by the supported deployment profiles.
- [ ] Create distinct application and Kestra databases with explicit roles and least required privileges.
- [ ] Use UTF8 and verify encoding during startup checks.
- [ ] Run application migrations once under concurrent startup and report migration failure before dependent readiness succeeds.
- [ ] Persist a synthetic fixture across database restart.
- [ ] Demonstrate access denial between database roles and document external provisioning when the installer lacks database-creation privileges.
- [ ] Validate configured TLS for external endpoints without requiring superuser access for ordinary runtime connections.

### Required evidence

Fresh provisioning, concurrent migration, denied cross-database access, restart, and external-connection results.

### Scope boundary

Exclude: Entity inventory schema, operation ledgers, and future application feature migrations.

## P1-T05 — Bootstrap Redis with explicit security and restart behavior

**Issue type:** Task  
**Responsible role:** Platform lead  
**Planning packages:** P9.2, P9.3  
**Blocked by:** P1-T01  
**Jira issue:** [KAN-8](https://easton-consulting.atlassian.net/browse/KAN-8)

### What to build

Provide a pinned Redis deployment and connection configuration for local containers and district endpoints. Specify which future data classes are persistent or rebuildable without implementing the Phase 5 hold protocol.

### Acceptance criteria

- [ ] Qualify and pin Redis and configure authentication and internal network access.
- [ ] Mount the declared persistence volume when persistence is enabled. Remove unused or misleading volume declarations.
- [ ] Document persistence, eviction, memory limits, and restart behavior by intended data class.
- [ ] Write and read a synthetic namespaced key, then verify its documented restart behavior.
- [ ] Validate external endpoint and TLS settings with actionable redacted failures.
- [ ] Keep Redis ports unavailable through the public application edge.

### Required evidence

Redis configuration, authenticated probe, restart result, and public-port denial check.

### Scope boundary

Exclude: Job hold ownership, recovery aggregation, production sessions, and admission reservation implementation.

## P1-T06 — Implement the local artifact storage foundation

**Issue type:** Task  
**Responsible role:** Storage lead  
**Planning packages:** P1.1, P2.4  
**Blocked by:** P1-T01, P1-T04  
**Jira issue:** [KAN-9](https://easton-consulting.atlassian.net/browse/KAN-9)

### What to build

Implement the initial job-storage interface and persistent local adapter using opaque artifact IDs and publication metadata. Prove a complete synthetic write, verification, publication, and read path before business jobs exist.

### Acceptance criteria

- [ ] Define stage, inspect, publish, openRead, and remove contracts with artifact identity, size, checksum, and attempt locator.
- [ ] Keep filesystem paths inside the adapter and bind artifact metadata to the application database.
- [ ] Publish only verified complete bytes and reject partial or checksum-mismatched content.
- [ ] Keep completed bytes unpublished after a metadata rollback and recover them through verification.
- [ ] Apply documented file and directory durability steps and test interrupted publication.
- [ ] Preserve ready artifacts across container restart and reject path traversal and stale publication attempts.

### Required evidence

Adapter contract and integration results for normal publication, corruption, interruption, restart, and invalid locators.

### Scope boundary

Exclude: Google operation payloads, final mutation result consolidation, and full retention automation.

## P1-T07 — Qualify one shared artifact backend across separate worker hosts

**Issue type:** Task  
**Responsible role:** Storage and platform lead  
**Planning packages:** P2.4, P9.4  
**Blocked by:** P1-T06  
**Jira issue:** [KAN-10](https://easton-consulting.atlassian.net/browse/KAN-10)

### What to build

Choose and implement one shared filesystem or S3-compatible adapter under the existing storage contract. Demonstrate actual cross-host access needed by hybrid and Kubernetes workers.

### Acceptance criteria

- [ ] Record the selected backend, prerequisites, supported operations, and reason for the choice.
- [ ] Write and publish a synthetic artifact on one worker host and read matching bytes from another.
- [ ] Preserve artifact IDs and integrity checks across local and shared configurations.
- [ ] Test partial writes, unavailable storage, denied access, and interrupted publication without exposing incomplete artifacts.
- [ ] Verify concurrent publication and cleanup cannot replace or remove an active authoritative artifact.
- [ ] For object storage, use completion and conditional publication semantics without assuming atomic rename.
- [ ] Document the Kubernetes storage prerequisite and a repeatable cross-host qualification procedure.

### Required evidence

Backend decision, two-host test results, fault evidence, and deployment configuration.

### Scope boundary

Exclude: Implementing both shared backend options, provisioning an entire district storage platform, and automatic artifact migration.

## P1-T08 — Run authenticated Kestra with independent workers and qualified internal storage

**Issue type:** Task  
**Responsible role:** Orchestration lead  
**Planning packages:** P0.1, P9.2, P9.4  
**Blocked by:** P1-T02, P1-T03, P1-T04  
**Jira issue:** [KAN-11](https://easton-consulting.atlassian.net/browse/KAN-11)

### What to build

Package the chosen Kestra topology with its real repository, queue, authentication, and internal-storage configuration. Execute a harmless synthetic worker task outside the interactive API.

### Acceptance criteria

- [ ] Replace the invalid KESTEA configuration approach with settings verified against the selected release.
- [ ] Connect Kestra only to its designated database and validate startup failures clearly.
- [ ] Execute a correlated synthetic task in an independent worker process or service.
- [ ] Protect worker dispatch and control-plane access through the Phase 1 internal trust configuration.
- [ ] Verify Kestra internal files survive restart and remain accessible in the selected distributed topology.
- [ ] Demonstrate worker or orchestrator interruption with documented settlement and recovery limits.
- [ ] Keep application artifact configuration distinct from Kestra internal-storage configuration.

### Required evidence

Pinned deployment configuration, synthetic external-worker execution, storage checks, and restart evidence.

### Scope boundary

Exclude: Business JobService, Google requests, production admission holds, and claims of exactly-once external effects.

## P1-T09 — Protect the startup page with HTTPS and installation bootstrap access

**Issue type:** Task  
**Responsible role:** Platform security and frontend lead  
**Planning packages:** P0.1, P9.1, P9.2  
**Blocked by:** P1-T01, P1-T03  
**Jira issue:** [KAN-12](https://easton-consulting.atlassian.net/browse/KAN-12)

### What to build

Provide a restricted installation surface and HTTPS edge for Phase 1. Generate installation secrets and protect the startup page before Phase 2 supplies application sign-in.

### Acceptance criteria

- [ ] Serve the minimal installation page through the configured district hostname and certificate.
- [ ] Generate unique bootstrap credentials and service secrets through the selected secret delivery mechanisms.
- [ ] Persist bootstrap lifecycle state and enforce expiry, replacement, and controlled operator recovery.
- [ ] Expose only the intended edge routes. Keep database, Redis, Kestra, and worker management endpoints internal.
- [ ] Separate process liveness from startup readiness and report unavailable components without returning secret values.
- [ ] Render only available Phase 1 controls and keep runtime assets local to the installation bundle.
- [ ] Verify missing or invalid bootstrap access is rejected and secret markers do not appear in logs or page responses.

### Required evidence

HTTPS browser demonstration, access-denial checks, redacted startup status, and secret lifecycle tests.

### Scope boundary

Exclude: Application OIDC, delegated platform users, OAuth onboarding, and Phase 2 utility routes.

## P1-T10 — Deliver the complete all-Docker installation profile

**Issue type:** Task  
**Responsible role:** Platform lead  
**Planning packages:** P9.2  
**Blocked by:** P1-T03, P1-T04, P1-T05, P1-T06, P1-T08, P1-T09  
**Jira issue:** [KAN-13](https://easton-consulting.atlassian.net/browse/KAN-13)

### What to build

Replace the scaffold Compose configuration with a complete installation of the Phase 1 topology using published image references, internal networks, and persistent volumes.

### Acceptance criteria

- [ ] Start edge, frontend, API, independent workers, PostgreSQL, Redis, Kestra, and configured local artifact storage.
- [ ] Use image references without source builds or absent apps-directory Dockerfiles.
- [ ] Apply verified dependency startup ordering, health checks, and restart behavior.
- [ ] Reach the protected installation page and exercise the synthetic database, Redis, worker, and artifact fixtures.
- [ ] Restart the full deployment while preserving its documented durable state.
- [ ] Stop the deployment without deleting data and document the distinct explicit-erasure path.

### Required evidence

Clean-host installation transcript, reachable startup page, component checks, restart results, and retained-volume inventory.

### Scope boundary

Exclude: Google onboarding, sample entity management, and metropolitan capacity certification.

## P1-T11 — Deliver the hybrid Docker and district-server installation profile

**Issue type:** Task  
**Responsible role:** Platform integration lead  
**Planning packages:** P9.2, P9.4  
**Blocked by:** P1-T07, P1-T10  
**Jira issue:** [KAN-14](https://easton-consulting.atlassian.net/browse/KAN-14)

### What to build

Run the same release images with district-hosted dependencies and retained local containers. External service ownership must be explicit for PostgreSQL, Redis, Kestra, worker placement, and artifact storage.

### Acceptance criteria

- [ ] Document supported local/external combinations and validate each advertised external endpoint contract.
- [ ] Demonstrate a dedicated external PostgreSQL configuration and a distributed worker/storage configuration on separate hosts.
- [ ] Do not start local replacement services when the operator selects external ownership.
- [ ] Verify credentials, certificate trust, network reachability, and storage permissions before reporting readiness.
- [ ] Demonstrate an external dependency outage and recovery with preserved synthetic state.
- [ ] Keep service-specific provisioning instructions separate from credentials and runtime configuration.

### Required evidence

Supported placement matrix, representative cross-host installations, endpoint tests, and outage/recovery results.

### Scope boundary

Exclude: Requiring Kubernetes for hybrid installation and automatic administration of arbitrary district infrastructure.

## P1-T12 — Deliver the enterprise Kubernetes installation profile

**Issue type:** Task  
**Responsible role:** Kubernetes platform lead  
**Planning packages:** P9.2, P9.4  
**Blocked by:** P1-T07, P1-T08, P1-T09  
**Jira issue:** [KAN-15](https://easton-consulting.atlassian.net/browse/KAN-15)

### What to build

Package and run the complete Phase 1 topology on a district-operated Kubernetes cluster using the shared image and configuration contracts.

### Acceptance criteria

- [ ] Deploy frontend, API, workers, and the declared local or external shared services from pinned image references.
- [ ] Configure ingress, service discovery, secrets, persistent storage, probes, resource requests/limits, and migration startup.
- [ ] Apply internal access restrictions supported by the qualified cluster networking configuration.
- [ ] Run multiple API and worker instances for Phase 1 infrastructure probes.
- [ ] Reschedule a worker onto a different node and read the previously published synthetic artifact successfully.
- [ ] Keep both application and Kestra storage available according to their qualified topology.
- [ ] Document cluster prerequisites, storage class/backend requirements, supported edition limitations, and observed recovery behavior.

### Required evidence

Repeatable cluster installation, rendered configuration, multi-node artifact proof, rescheduling results, and declared platform limitations.

### Scope boundary

Exclude: Building a district Kubernetes cluster, full JobService failover tests, and unmeasured metropolitan throughput guarantees.

## P1-T13 — Deliver repeatable preflight, install, resume, and upgrade commands

**Issue type:** Task  
**Responsible role:** Installer lead  
**Planning packages:** P9.2  
**Blocked by:** P1-T10, P1-T11, P1-T12  
**Jira issue:** [KAN-16](https://easton-consulting.atlassian.net/browse/KAN-16)

### What to build

Provide an operator workflow that selects a deployment mode, checks prerequisites, installs the release, and resumes after interruption. Keep shared configuration authoritative across deployment tools.

### Acceptance criteria

- [ ] Check runtime, architecture, ports, hostname, certificates, storage, permissions, resources, time synchronization, and required egress.
- [ ] Explain failed prerequisites in actionable language without exposing credentials.
- [ ] Install from pinned prebuilt images without requiring source compilation, AI services, or Google credentials.
- [ ] Resume interrupted setup without regenerating active secrets or duplicating migrations.
- [ ] Verify release compatibility and demonstrate upgrade between two Phase 1 fixture releases with data preservation.
- [ ] Document stop, uninstall, and explicit erasure behavior across local and external resources.
- [ ] Provide a supported route for Kubernetes operators without requiring a GUI installer on cluster nodes.

### Required evidence

Successful installation in each mode, injected interruption/resume, failed-preflight examples, and a fixture upgrade result.

### Scope boundary

Exclude: The Phase 3 Google onboarding wizard and production Google credential replacement.

## P1-T14 — Restore the foundational state into an isolated installation

**Issue type:** Task  
**Responsible role:** Operations and storage lead  
**Planning packages:** P9.3  
**Blocked by:** P1-T10, P1-T11, P1-T12  
**Jira issue:** [KAN-17](https://easton-consulting.atlassian.net/browse/KAN-17)

### What to build

Back up and restore the application and Kestra databases, application artifacts, Kestra internal storage, and necessary configuration. Document Redis recovery and separately protected secret recovery.

### Acceptance criteria

- [ ] Inventory every durable component and define a consistent backup procedure for the Phase 1 topology.
- [ ] Store backup material separately from the primary service volumes.
- [ ] Preserve encryption or recovery keys through a protected procedure separate from ordinary database backups.
- [ ] Restore synthetic state into an isolated target for each supported deployment profile.
- [ ] Verify restored artifact checksums, database fixtures, Kestra state, configuration, and the chosen Redis rebuild/restore behavior.
- [ ] Report measured restore duration and recovery-point limitations without presenting them as district support guarantees.
- [ ] Demonstrate failure when a required key, volume, or backup component is absent.

### Required evidence

Restore runbooks, fixture manifests, checksum comparisons, timings, and missing-component failure results.

### Scope boundary

Exclude: Live Google reconciliation and automatic replay of future mutation jobs.

## P1-T15 — Qualify restart, outage, and resource failure behavior across all profiles

**Issue type:** Task  
**Responsible role:** Reliability lead  
**Planning packages:** P9.3, P9.4  
**Blocked by:** P1-T10, P1-T11, P1-T12  
**Jira issue:** [KAN-18](https://easton-consulting.atlassian.net/browse/KAN-18)

### What to build

Run a repeatable synthetic fault matrix against the complete Phase 1 release. Verify truthful readiness, bounded recovery, and durable fixture preservation.

### Acceptance criteria

- [ ] Test API, worker, Redis, PostgreSQL, and Kestra process interruption against each applicable deployment mode.
- [ ] Test external database loss, artifact backend loss, near-full storage, and invalid or expired certificate fixtures.
- [ ] Test Kubernetes worker rescheduling onto another node and loss of a required shared dependency.
- [ ] Verify startup diagnostics identify the failing component without reporting full readiness.
- [ ] Verify recovery preserves database and artifact fixtures without publishing partial content.
- [ ] Collect redacted logs and resource measurements with versions, topology, and fault timing.
- [ ] Record known single points of failure and outstanding limitations instead of claiming universal high availability.

### Required evidence

Fault matrix, reproducible injection procedure, component readiness observations, integrity checks, and resource baseline.

### Scope boundary

Exclude: Phase 5 admission and Google-effect recovery, stress tests against real districts, and destructive tests on production services.

## P1-T16 — Publish verified Phase 1 release artifacts and gate profile regressions in CI

**Issue type:** Task  
**Responsible role:** Build and release lead  
**Planning packages:** P0.1, P9.2  
**Blocked by:** P1-T13, P1-T14, P1-T15  
**Jira issue:** [KAN-19](https://easton-consulting.atlassian.net/browse/KAN-19)

### What to build

Publish the release package and its verification material. Connect existing build and deployment checks to reproducible CI gates for the supported installation profiles.

### Acceptance criteria

- [ ] Build through Nx and record image digests, supported architectures, dependency versions, and source revision.
- [ ] Publish signed application image artifacts, release manifests, checksums, an SBOM, and installation bundles to the project-owned release destination.
- [ ] Verify upstream service images and document their provenance without claiming project authorship of them.
- [ ] Run profile configuration checks and available integration jobs with synthetic fixtures.
- [ ] Require recorded cross-host and Kubernetes acceptance evidence when CI infrastructure cannot run those checks.
- [ ] Reject altered release material and keep secrets out of build output and downloadable support evidence.
- [ ] Keep Nx Cloud optional and document the release destination and signing-key ownership.

### Required evidence

Published release candidate, integrity verification, CI results, and linked profile/fault/restore evidence.

### Scope boundary

Exclude: Signing-key disclosure, adopting a new mandatory cloud platform, and treating skipped integration checks as passed.

## P1-T17 — Accept the Phase 1 release through operator walkthroughs

**Issue type:** Task  
**Responsible role:** Staff Tech Lead with UX and district operators  
**Planning packages:** P9.2, P9.4  
**Blocked by:** P1-T16  
**Jira issue:** [KAN-20](https://easton-consulting.atlassian.net/browse/KAN-20)

### What to build

Demonstrate the released Phase 1 product from clean installation through restart and foundational restore in all three modes. Establish the handoff boundary for Phase 2.

### Acceptance criteria

- [ ] Have an occasional IT helper follow the all-Docker instructions and record assistance, failed steps, and hands-on time.
- [ ] Have infrastructure operators follow the hybrid and Kubernetes instructions against the qualified test environments.
- [ ] Reach the protected startup page, inspect truthful component status, restart services, and verify the synthetic fixtures.
- [ ] Verify foundational restore and release integrity using the published procedures.
- [ ] Record unmet criteria as open defects and prevent Phase 1 completion until its required gates pass.
- [ ] Confirm frontend, API, workers, PostgreSQL, Redis, Kestra, and storage are operational in each mode.
- [ ] Record Phase 2 handoff items for application structure, auth, login, shell, service utilities, and later Google onboarding.

### Required evidence

Three walkthrough records, participant roles, observed setup times, defect list, and Phase 1 completion decision.

### Scope boundary

Exclude: Claiming Google administration is available or substituting developer familiarity for novice installation evidence.
