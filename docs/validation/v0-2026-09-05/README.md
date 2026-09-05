# V0 validation — 2026-09-05

**Status: IN PROGRESS. Local experiments produced evidence. The complete V0 gate remains open.**

**Schedule update:** the owner subsequently adopted [ten development phases](../../portfolio/06-work-breakdown.md#delivery-sequence).
This experiment record preserves its original evidence and historical delivery references. Current phase assignments live in the portfolio.
Resolve each experiment prerequisite before its dependent phase. The earlier V1–V6 order is superseded.

The retained stack supports the behaviors tested here. These results do not justify replacing LibreGrid, Redis, or Kestra.
Two defects need correction before implementation: the frontend compiler configuration and the existing Compose scaffold.
The Kestra experiment also exposed duplicate HTTP dispatch. Assignment deduplication must survive worker restarts.

No application features were implemented. The scripts in this directory are disposable experiments with synthetic data.
The existing application configuration remains unchanged by this validation work.

## Gate results

| Milestone | Result | Evidence and remaining work |
|---|---|---|
| P0.1 dependency and scaffold checks | PARTIAL | API build passed. Frontend baseline failed. Isolated compiler override passed. Pinned LibreGrid compilation and browser smoke test passed. Full product grid remains untested. |
| P2.1 all-settled orchestration | PARTIAL | Real Kestra dispatched ten assignments with concurrency three. Aggregation ran after settlement, including failures. Full restart and dispatch reconciliation remain open. |
| P2.1 Redis admission policy | PARTIAL | Owner replacement, conditional cleanup, TTL renewal, expiry, and smallest-first gate passed. Complete job-service event aggregation remains untested. |
| P2.1 operation recovery | PARTIAL | A killed worker left a simulated remote effect and an unresolved dispatch record. Stale completion failed its epoch check. |
| P2.4 local publication | PARTIAL | Completed bytes remained unpublished after metadata rollback. Recovery verified bytes before publication. Real host-crash and shared-backend tests remain open. |
| P3.1 credential proof | AWAITING ACCESS | No Google credentials were supplied. [Capability matrix and experiment procedure](google-credential-proof.md) are ready. |
| P5.1 query spike | PASS, limited scope | One million synthetic rows, scoped indexed queries, and two background database loops. Full product workload remains open. |
| P9.1 threat model | DRAFT COMPLETE | [Threat model](threat-model.md) defines boundaries, threats, controls, and required denial tests. Controls are not implemented or certified. |
| P9.2 prerequisites and walkthrough | PARTIAL | Static packaging defects recorded. Docker execution and novice installation remain untested. |

Implementation package statuses remain TODO. Experimental evidence closes only the specific behaviors demonstrated.
See [technical findings and change instructions](technical-findings.md) for exact change boundaries.

## Measured query results

| Query | Samples | p95 | p99 |
|---|---:|---:|---:|
| Exact serial with school scope | 150 | 0.55 ms | 0.60 ms |
| School and status, first 100 rows | 150 | 0.59 ms | 0.77 ms |
| Name prefix with school scope | 150 | 2.36 ms | 2.84 ms |
| Name substring with school scope | 150 | 7.79 ms | 8.36 ms |

These measurements include the local PostgreSQL client round trip. They exclude HTTP, browser rendering, and LibreGrid interaction.
The fixture contains 500,000 user rows and 500,000 device rows across 100 synthetic school identifiers.
It uses seven synthetic email domains and repeated names. It does not model real school distributions or district complexity.
Two background loops issued scoped counts and 50-row updates. This does not represent full import or synchronization traffic.
The table and indexes occupied about 325 MB. Data was warm or warming during measurement.

Continue with PostgreSQL indexes for V1. This experiment supplies no evidence that a separate search service is necessary.
Metropolitan qualification still requires memberships, audit history, effective overlays, realistic skew, concurrent users, and the combined workload in portfolio 06.

## Findings that affect implementation

1. Separate application compiler settings from declaration-producing library settings.
2. Replace the Compose scaffold during P0.1/P9.2 packaging work.
3. Deduplicate worker dispatch using durable assignment identity and attempt fencing.
4. Derive application outcomes from operation records after every assignment settles.
5. Recover Redis admission reservations from durable job state before dispatch.
6. Preserve unknown Google outcomes for reconciliation instead of replaying whole assignments.
7. Publish artifacts through verified metadata transitions, with separate host-crash qualification.

The failed Kestra baseline remains in [kestra-probe-before.json](evidence/kestra-probe-before.json).
It counted eleven settlement events for ten assignments because the failed assignment received two HTTP requests.
Corrected GET and POST runs both received a duplicate request. Both aggregated exactly ten unique assignments and finished with `WARNING`.
The experiment identifies duplicate dispatch behavior. It does not attribute that behavior to a specific internal retry implementation.

## Evidence index

| File | Content |
|---|---|
| [build-results.json](evidence/build-results.json) | Baseline builds and isolated frontend correction |
| [installed-peer-check.json](evidence/installed-peer-check.json) | Installed dependency peer checks. Missing peers were outside this check. |
| [grid-metadata.json](evidence/grid-metadata.json) | Published package versions, licenses, and peer declarations |
| [grid-compiler.json](evidence/grid-compiler.json) | Pinned Angular/LibreGrid strict compilation with server-side row and selection modules |
| [grid-browser.json](evidence/grid-browser.json) | Chromium smoke test for synthetic row loading, editing, and selection |
| [runtime-probe.json](evidence/runtime-probe.json) | Nine PostgreSQL, Redis, worker-death, and local-storage checks |
| [ttl-observation.json](evidence/ttl-observation.json) | Unrefreshed 300-second hold absent after 539.64 seconds. Exact expiry instant was not observed. |
| [query-probe.json](evidence/query-probe.json) | Query timings, fixture size, and execution plans |
| [kestra-probe-get.json](evidence/kestra-probe-get.json) | Corrected GET dispatch with duplicate request deduplication |
| [kestra-probe-post.json](evidence/kestra-probe-post.json) | Corrected POST dispatch with duplicate request deduplication |
| [Lab procedure](lab-procedure.md) | Environment, runtime setup, reproduction, and cleanup |

## Remaining V0 work

The next local experiments need durable multi-instance job-service event aggregation and admission recovery across PostgreSQL and Redis.
Kestra restart tests must cover execution acceptance without an acknowledgement and worker completion during orchestrator downtime.
The grid needs the full product workflow beyond the passing compiler and one-row browser smoke test.
The passing fixture required `@libregrid/server-side-selection` in addition to the server-side row model module.
The credential experiment needs a controlled Workspace account, district-owned OAuth client, and interactive consent.
Docker validation needs an available engine and corrected packaging. Novice observation follows a runnable installation path.

The user reported that Windows Docker Desktop was unavailable while away from the keyboard.
This run used isolated Linux processes instead. It does not qualify Docker Desktop, WSL integration, Compose networking, or container volumes.
