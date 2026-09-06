# 05 — Decisions and Open Questions

**Status:** current decision index, revised 2026-09-05.

The owner authorized integration of the contractor report into the planning documents on 2026-09-05.
Accepted owner constraints remain binding. Adopted planning directions guide design but retain their explicit validation gates.
No experiment or implementation is complete merely because this file records its direction.

## Decision process

Use a stable ID, date, owner, status, evidence, alternatives, consequences, and reconsideration trigger.
Statuses are **accepted**, **adopted planning direction**, **proposed setting**, and **superseded**.
The owner owns product direction. The implementation lead owns evidence collection and package readiness.
Record changes here and update affected planning sections together.
Do not append a new rule while leaving contradictory instructions active elsewhere.

Primary records: [contractor report](../reviews/2026-09-04-contractor-report.md), [technical instructions](../reviews/2026-09-04-technical-change-instructions.md),
[Google evidence](../reviews/2026-09-04-google-platform-evidence.md), [runtime evidence](../reviews/2026-09-04-runtime-evidence.md),
and [owner admission policy](../reviews/2026-09-04-job-admission-policy.md).
These are supporting records. [03](03-architecture.md) remains the current architecture.

The [2026-09-05 V0 report](../validation/v0-2026-09-05/README.md) adds measured local evidence.
It supports retained PostgreSQL search, Redis ownership operations, and Kestra all-settled orchestration within the tested scope.
It also records frontend and Compose defects, duplicate worker dispatch, and unresolved credential and distributed recovery gates.
No retained technology decision changed. Exact release qualification and proposed recovery settings remain open.

## Current decisions

All entries were integrated on 2026-09-05. Owner conversation supplies accepted constraints and authorizes the adopted planning directions.
Technical instructions C01–C20 supply the review mapping in [07](07-issues-and-opportunities.md#review-integration-map).

| ID | Status | Decision and consequence | Evidence or alternative | Reconsideration or validation trigger |
|---|---|---|---|---|
| R01 | Accepted | Retain Angular, LibreGrid, NestJS, PostgreSQL, Redis, Kestra, Nx, and npm. | Owner corrections retain LibreGrid and Redis. Kestra fits independent workers and all-settled steps. | New measured limitation and an explicit replacement decision |
| R02 | Accepted | Every mutation uses preview, confirmation, job execution, file artifacts, and audit evidence. | Owner rejects size-based exceptions. | No small-job bypass. Adjust presentation only after usability evidence. |
| R03 | Accepted | Jobs contain steps and parallel assignments. Workers run outside the API. Aggregate all settled results. | Owner workflow discussion supersedes queue-only replacement. | Validate settlement and fault recovery in P2.1. |
| R04 | Accepted | Greedy workers report backoff to the job service. Redis holds pause new jobs by type for 300 seconds. | Owner admission policy. No estimated balances or fixed Google budget shares. | Validate overwrite, renewal, cleanup, crash expiry, and admission races. |
| R05 | Accepted | Backoff reports can replace ownership. Cleanup requires current ownership. Existing jobs continue. Pending jobs sort smallest first. | Owner explicitly distinguishes update permission from cleanup permission. | Validate concurrent owners and queue ordering. |
| R06 | Accepted | The job service aggregates recovery reports for early release. | Owner permits successful calls without backoff as recovery evidence. | Five calls is illustrative. Threshold and observation rules remain open. |
| R07 | Accepted | Deliver the job-storage interface, persistent local storage, and one qualified shared backend in Phase 1. | Owner storage discussion preserves file artifacts. The ten-phase sequence moves distributed storage qualification into Phase 1. | Validate publication, integrity, cross-host access, migration, and Kestra storage integration. |
| R08 | Adopted planning direction | One customer account per installation, including supported primary, secondary, and alias domains. | C01 and Directory customer-based listing replace domain-only tenancy. | Controlled-account multi-domain inventory and permission tests |
| R09 | Adopted planning direction | Replace Architecture A with a supported credential-provider contract. Candidate default: offline OAuth using actual API scopes. | C02. Service-account signing profiles remain enterprise alternatives. | Default requires restart, renewal, revocation, replacement, and endpoint coverage proof before wizard implementation. |
| R10 | Adopted planning direction | Use minimum verified Google privileges and generated capability scopes. Separate app sign-in from background authorization. | C02. Fixed eight-scope and universal Super Admin requirements are superseded. | Capability registry, consent, license, and browser callback experiments |
| R11 | Adopted planning direction | Record intent before dispatch and results per operation. Retry eligible unresolved operations only. | C03/C04. Final file consolidation remains. | Unknown-outcome, stale-worker, partial-batch, cancellation, and restore tests |
| R12 | Adopted planning direction | Permission grants with platform, district, school, and viewer presets. Check scope across all data and mutation surfaces. | C12 replaces two unrestricted roles. | Cross-school denial tests and district approval policy |
| R13 | Adopted planning direction | Freeze approved targets and changes durably. Preserve browsing selections in Redis with explicit expiry. | C05 and preview contract replace execution-time target expansion. | Large selection, permission revocation, expiry, and changed-target tests |
| R14 | Adopted planning direction | Replace global sync locking with collection generations, protected write overlays, and one effective read projection. | C07/C08. Full enumeration remains for reconciliation. | Concurrent-write, permission-loss, stale-generation, and deletion tests |
| R15 | Adopted planning direction | Keep Redis Pub/Sub, SSE, and durable event replay or explicit resync. | C05. Pub/Sub alone loses disconnected messages. | Commit-order, duplicate-event, replay, and authorization tests |
| R16 | Adopted planning direction | Deliver device lookup in Phase 4 and expand with each entity phase. Deliver Fleet Status and reports in Phase 10. Use PostgreSQL indexes. | C10. Local AI becomes optional later work. | Representative query and usability evidence |
| R17 | Adopted planning direction | Cell edits create drafts. Save starts preview. Drafts survive row eviction and refresh. | Technical review section 10.2 replaces immediate write-through. | LibreGrid selection, draft, conflict, and accessibility tests |
| R18 | Adopted planning direction | CSV first with stored baselines and explicit create mode. Sheets follows separate authorization design. | C11 replaces hidden-hash-only comparison and implicit creation. | Round-trip, streaming, conflict, expiry, and restart tests |
| R19 | Accepted | Ship all Docker, hybrid Docker with district services, and enterprise Kubernetes in Phase 1 using the same images. Maintain each mode thereafter. | Owner ten-phase sequence supersedes late cluster delivery. Districts choose their deployment mode. | Phase 1 installation and shared storage evidence, followed by workload-specific recovery and capacity qualification |
| R20 | Adopted planning direction | Installer uses prebuilt images, sample data or read-only connection, resumable setup, and explicit trial promotion. | C13/C15. Marketplace is a later distribution option. | Novice installation and controlled-account setup studies |
| R21 | Adopted planning direction | Keep permanent logical audit evidence. Separate retention for downloads, inputs, staging, logs, and telemetry. | C14. No permanent duplicate temporary files. | District retention policy and tested archive restore |
| R22 | Adopted planning direction | Backup and restore precede broad mutation work. Restore never automatically replays uncertain Google effects. | C16/C17 and technical review section 13. Replication alone does not provide recovery evidence. | Declared RPO/RTO and rehearsed restore with uncertainty quarantine |
| R23 | Adopted planning direction | Use WCAG 2.2 AA as an engineering target. Support keyboard workflows and bounded grid scrolling. | C19 supersedes mouse-primary and compact-only restrictions where testing requires change. | Keyboard, screen-reader, target-size, and density studies |
| R24 | Accepted | Phase 1–10 define cumulative working releases. Resolve relevant V0 findings before each dependent phase. Keep Nx Cloud optional and fixtures synthetic. | Owner ten-phase sequence supersedes the earlier V1–V6 schedule. | Demonstration, install, upgrade, and applicable failure evidence in all three modes for every phase |
| R25 | Accepted | Classroom, bulk Super Admin grants, and automatic rollback remain excluded. | Existing scope plus C20 remove unsupported Classroom ownership warnings. | Separate authorized feature decision and API coverage |
| R26 | Accepted | Iterate on device management in Phase 6 until the owner accepts the experience. Reuse accepted patterns for Users, OUs, and Groups. | Owner explicitly reserves time for device experience review. | Record owner acceptance before Phase 7 feature implementation. |

The proposed allocation places device CSV in Phase 6 and entity-specific expansion in Phases 7–9.
The owner-defined entity order and Phase 10 dashboard placement remain binding.

Proposed settings include preview expiry, query limits, reporting interval, recovery threshold, retention durations, and capacity allocations.
The accepted hold TTL is exactly 300 seconds. It is not a proposed setting.
Prototype colors and exact dependency versions remain subject to their existing qualification or design approval.

## Supersession map for earlier decision IDs

Earlier source wording remains in the archive. The following table preserves traceability without retaining obsolete implementation instructions.

| Earlier ID | Current disposition |
|---|---|
| 17.1 | Retained through R01. Exact compatible versions remain open. |
| 17.2, 17.3 | Superseded. Current architecture is portfolio 03. This file indexes its decisions. |
| 17.4 | Retained: shared contracts contain types and schemas without framework dependencies. |
| 17.5 | Superseded by R09/R10. The old credential combination is incomplete. |
| 17.7, 17.35 | Superseded by R12. Invite-only access remains. |
| 17.8 | Revised by R13. Browsing selection persistence does not replace frozen approved manifests. |
| 17.12 | Superseded by R09/R10. Google identity replacement follows the tested credential profile. |
| 17.13 | Retained and extended by R15 with replay and current permission checks. |
| 17.14 | Superseded by R14. Keep Cache Sync naming and complete-coverage removal rules. |
| 17.15, 17.16, 17.33 | Retained by R01/R03. Independent worker services remain valid. |
| 17.17 | Retained by R01. LibreGrid stays. Pin compatible packages before implementation. |
| 17.20 | Revised by R11. Scheduling retries must not repeat successful operations. |
| 17.24 | Revised by R04–R06. Greedy execution remains. Pending jobs use smallest-first admission after holds. |
| 17.25 | Retained with reviewed constraints in architecture Appendix A. |
| 17.26 | Superseded by R14. Remove the global write freeze. |
| 17.27 | Revised by R14. Complete authorized coverage precedes absence handling. |
| 17.28 | Superseded by R14. Schedules and coverage separate memberships, settings, telemetry, and inventory. |
| 17.29 | Retained as view-triggered refresh and a measured nightly reconciliation objective. |
| 17.30 | Revised by R14. Full reconciliation plus targeted reads. No invented universal delta stream. |
| 17.31 | Revised by R11. Check cancellation at each external request and preserve unknown outcomes. |
| 17.32 | Revised by R03/R07. Stable job and artifact IDs replace mandatory host-path references. |
| 17.34 | Retained: application users require invitations. |
| 17.36 | Superseded by R09. Reuse access tokens and renew through the credential provider. |
| 17.37 | Retained: Linux production. |
| 17.38 | Revised by R10/R20. District-controlled hostname and trusted HTTPS replace the sslip.io default. |
| G1 | Retained: View job replaces Undo for completed actions. Reset applies to drafts only. |
| G2 | Revised by R23. Compact default remains. Comfortable density follows usability and accessibility evidence. |
| G3 | Retained as an initial 50,000-row qualification cap. Larger support requires evidence under R18. |
| D-2026-09-03 feature intent | Retained through R17/R18 and Track 12 design work. |
| D-2026-09-03 uniform pipeline correction | Retained by R02/R07. File artifacts remain required at every mutation size. |
| D-2026-09-03 scope grooming | Corrected security and telemetry scopes remain. R10 replaces the fixed scope count. |
| D-2026-09-03 opportunity grooming | E9–E12 remain opportunities. Their existence does not authorize every scope or action. |

## Open questions and validation register

Numbers 1–64 remain stable for existing package and archive references.
A resolved direction still requires its stated implementation evidence.

### Blocking the first executable slice

1. **Direction resolved:** use root-level project paths. P0.1 verifies scaffold ownership before cleanup.
2. **Open validation:** qualify and pin Angular, Node, TypeScript, AG Grid, and LibreGrid together. PostgreSQL 18 remains a candidate.
3. **Resolved 2026-09-05:** current decisions and supersession links appear below. Preserve history without parallel authority.
4. Separate dev Compose configuration from production. (PR 2)

### Blocking the jobs pipeline

5. Durable job state machine with all terminal and non-terminal states. (PR 5)
6. Immutable execution manifest: targets, action parameters, principal, preview, authorization decision. (PR 5)
7. Define assignment claiming, settlement, artifact publication, and cross-store crash recovery. Storage and PostgreSQL do not share a transaction.
8. Define local idempotency keys and verified provider replay behavior. Local keys do not establish Google deduplication.
9. Retry behavior for safe, unsafe, and ambiguously completed operations. (PR 5)
10. Leases, lease expiry, fencing tokens, abandoned-work recovery. (PR 5)
11. Timeout behavior when a worker continues after the orchestrator times out. (PR 5)
12. Ordering requirements for actions affecting the same entity. (PR 5)
13. Compensation or operator reconciliation for partially completed destructive jobs. (PR 5)
14. Job resumption after API, worker, Kestra, Redis, PostgreSQL, or host restart. (PR 5)

### Blocking bulk-action safety

15. Map the selection API to `ServerSideSelectionProvider`. (PR 6)
16. **Direction resolved:** browsing selections remain compact. Preview freezes targets durably. Validate Redis expiry and manifest independence.
17. Previews bound to exact entity IDs, versions, action parameters, principal. (PR 6)
18. Preview expiration and revalidation rules. (PR 6)
19. Maximum job size and admission control. (PR 6)

### Blocking sync correctness

20. Sweep fencing for overlapping, abandoned, resumed sweeps. Durable claim mechanism. (PR 8)
21. **Direction resolved:** observations plus accepted write overlays form one effective read projection. Validate propagation and concurrent sync behavior.
22. Full-sweep freshness at maximum scale: validate or revise. (PR 8)
23. Group-membership and Group Settings N+1 sync costs. (PR 8)
24. Targeted refresh and reconciliation after bulk operations. (PR 8)
25. Redis failure behavior. PostgreSQL stays authoritative. (PR 8)

### Blocking the data model

26. Schemas and stable identifiers for users, devices, groups, memberships, org units, telemetry, jobs, audit records. (PR 9)
27. **Direction resolved:** one stable Workspace customer ID, including supported domains. Validate multi-domain inventory and authorization.
28. Indexes for the largest filter, search, sort, pagination workloads. (PR 9)
29. Optimistic-concurrency/version fields. Soft-delete and restoration semantics. (PR 9)
30. Representing Google propagation delay and eventual consistency. (PR 9)
31. Transaction boundaries across jobs, cache updates, audit records. (PR 9)
32. Migration, rollback, forward-compatibility policy. (PR 9)
33. Connection-pool budgets across API, workers, Kestra. (PR 9)
34. Separate databases or schemas for the app and Kestra. (PR 9)

### Blocking import/export

35. **Direction resolved:** store baseline values and export metadata through job storage and PostgreSQL. Qualify retention and round-trip recovery.
36. Export identifiers, expiration, ownership, tamper protection. (PR 10)
37. CSV parsing, encoding, size, formula-injection, malformed-row handling. (PR 10)
38. Stable entity matching and duplicate detection. (PR 10)
39. **Direction resolved:** use the B/E/C rules in [02](02-domain-model.md). Validate canonical values and field-specific semantics.
40. Conflict-resolution persistence and revalidation before execution. (PR 10)
41. Streaming behavior for large imports and exports. (PR 10)
42. Google Sheets authorization and data-access implications. (PR 10)
43. Partial failure, retry, downloadable error reports for imports. (PR 10)

### Blocking security

44. Threat model across all services. (PR 3)
45. Externally reachable vs privileged internal endpoints. (PR 3)
46. User auth, session management, logout, expiration, account recovery. (PR 3)
47. Service-to-service auth between Kestra, API, workers. MTLS decision. (PR 3)
48. CSRF, CORS, CSP, secure cookies. (PR 3)
49. Secret generation, storage, encryption, rotation, revocation. (PR 3)
50. Audit requirements for security-sensitive configuration changes. (PR 3)
51. Google consent-screen verification implications. (PR 4)
52. CSRF state, PKCE, token encryption and expiry for the OAuth flow. (PR 4)

### Blocking operations

53. Offline or restricted-egress installation requirements. (PR 2)
54. Image build, publication, versioning, supply-chain verification. (PR 2)
55. Validate install, trial promotion, stop, uninstall, and explicit data erasure. Volume deletion alone does not erase every secret.
56. CPU, memory, disk requirements per install size. (PR 2)
57. Single-host availability limitations. (PR 2)
58. Internal container networks and published ports. (PR 2)
59. Backup scope and coordination. Redis restore decision. RPO/RTO. Restore test. (PR 12)
60. Low-disk thresholds and safe shutdown. Telemetry retention values. Decommission deletion. (PR 11)
61. Observability: metrics, logs, alerting, Kestra monitoring specifics. (PR 13)
62. Capacity model numbers for maximum-size installs. (PR 14)
63. Test strategy and acceptance gates per subsystem. (PR 15)
64. **Resolved 2026-09-05, revised by owner:** Phase 1–10 in [06](06-work-breakdown.md#delivery-sequence) replace V1–V6. Every phase delivers a working version.

### Additional review gates

65. Choose and prove the default credential profile before onboarding implementation. Owner: connection lead. Packages P3.1/P3.2.
66. Define hold recovery aggregation, revision handling, event identity, reporting interval, and admission serialization. Owner: jobs lead. Package P2.1.
67. Define the job-storage contract and qualify local storage and one shared backend before Phase 1 completes. Owner: storage lead. Packages P2.4/P9.4.
68. Establish Kestra availability requirements, supported edition, licensing constraints, and recovery objectives. Owner: deployment lead. Package P9.4.
69. Qualify LibreGrid drafts, selections, numeric row ranges, grouped rows, and accessible operation. Owner: frontend lead. Packages P5.1/P6.2/P7.3.
70. Define report coverage, district thresholds, SIS field ownership, and optional external audit. Owner: product lead. Package P6.4.
71. Test occasional-helper installation and complete user tasks. Owner: UX lead. Packages P9.2 and Track 12.
72. Qualify provisional query, preview, import, retention, hardware, and recovery settings. Owner: implementation lead. Resolve relevant V0 findings and repeat qualification as each phase adds workloads.
73. Define independent approval rules and school/group scope mappings. Owner: district product and security leads. Package P9.1.
74. Select and qualify trial promotion, sample-data isolation, and production approval invalidation. Owner: deployment lead. Package P9.2.
75. Verify source provenance and retention windows for external Google audit and battery classifications. Owner: capability lead. Packages P6.4/P10.2.

## Phase 1 implementation decisions

[D-CC-4](../../deployment/README.md#configuration-decision-d-cc-4-2026-09-06) defines the typed deployment configuration contract and three validated profiles.
[CC-4 evidence](../../deployment/evidence.md) records configuration checks. Runtime qualification remains open under R07, R19, and R24.

## Use during execution

Read current decisions before legacy IDs. Treat superseded rows as traceability only.
Record evidence in the package before changing a validation item to resolved.
New alternatives require a dated decision with consequences and a replacement link.
No application implementation or external deployment is authorized by a document's completion status alone.
