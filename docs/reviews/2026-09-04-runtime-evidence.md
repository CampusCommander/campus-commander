# Runtime evidence and retained architecture

> Integration update, 2026-09-05: the [design portfolio](../portfolio/README.md) incorporates this review and subsequent owner decisions.
> Use the portfolio for current planning and package status. This document preserves review evidence and rationale.

> Review update: the owner retains LibreGrid and Redis. Kestra remains the orchestration baseline.
> The [accepted job admission policy](2026-09-04-job-admission-policy.md) governs worker backoff and job-service admission holds.
> Other product changes remain contractor proposals. Queue alternatives below are comparisons, not selected replacements.

Review date: 2026-09-04. Scope: orchestration, job transport, PostgreSQL, Redis, and recovery.

This note supports the contractor review. It changes no architecture decision or implementation.
[03 — Architecture](../portfolio/03-architecture.md) documents the current design.

## Recommendation

Retain LibreGrid, PostgreSQL, Redis, Kestra, and separate API and worker processes.
Kestra orchestrates jobs, steps, parallel assignments, and collection of all-settled results.
PostgreSQL stores durable operation intent, individual results, audit evidence, and dispatch outbox records.
Preserve job files and define their storage ownership and retention.

Workers execute greedily and report backoff to the job service.
The job service writes a job-type hold in Redis with a 300-second TTL.
Each accepted continuing-backoff report can overwrite ownership and renew that TTL.
Completion cleanup deletes a hold only when the finishing job still owns it.
Existing jobs continue. Pending jobs of the held type wait and sort smallest first.
The job service aggregates worker recovery reports for early release.
Five successful calls remains an illustrative threshold, not a fixed requirement.
A crashed job's hold expires five minutes after its last accepted refresh.

The pg-boss replacement recommendation is withdrawn because it understated the application orchestration required to replace Kestra.
The comparisons below preserve evidence about alternatives without selecting them.
Require representative benchmarks and failure experiments for the retained deployment.

## Verified evidence

| Subject | Official evidence | Consequence for this project |
|---|---|---|
| Kestra deployment | Kestra documents a standalone process and a relational-database deployment without high availability. Distributed components require shared internal storage. Its full high-availability architecture requires Enterprise Edition, Kafka, and Elasticsearch. | The proposed default stack does not preserve the same operational dependencies when moving to full Kestra high availability. [Kestra deployment architectures](https://kestra.io/docs/architecture/deployment-architecture) |
| pg-boss transaction boundary | pg-boss accepts an existing database transaction through its database adapter. Application writes and job creation commit or roll back together. | This alternative supports atomic queue insertion. Retained Kestra instead requires a durable application dispatch outbox and execution correlation. [pg-boss transaction adapters](https://pgboss.io/api/adapters) |
| pg-boss worker scaling | Multiple Node.js processes can share one PostgreSQL database. Database connections constrain this arrangement. | This alternative supports separate workers. Its database queue does not supply the complete application orchestration contract. [pg-boss introduction](https://pgboss.io/introduction) |
| pg-boss recovery and dispatch | pg-boss documents heartbeats, polling, and optional notification wakeups. It retains polling when notifications fail. Its global group concurrency option permits brief overshoot during concurrent fetches. | Library concurrency settings do not establish Google capacity. The selected design uses observed backoff and job-service admission holds. [pg-boss workers](https://pgboss.io/api/workers) |
| pg-boss maintenance | The project README identifies one maintainer and sponsorship-funded maintenance, security response, and support. | Budget dependency maintenance and an exit path. Do not describe the library as an enterprise support contract. [pg-boss README](https://raw.githubusercontent.com/timgit/pg-boss/master/README.md) |
| Graphile Worker | Graphile Worker documents at-least-once execution and retries. SQL job creation integrates with PostgreSQL transactions. | It provides a credible queue alternative. Retain application-owned operation records regardless of the queue choice. [Graphile Worker introduction](https://worker.graphile.org/docs), [SQL transaction example](https://worker.graphile.org/docs/job-key) |
| Graphile Worker abrupt death | Its error-handling documentation states that abrupt worker termination leaves active jobs locked for at least four hours. | Do not select its default recovery behavior for a short recovery objective. Qualify recovery changes or its commercial extension separately. [Graphile Worker error handling](https://worker.graphile.org/docs/error-handling) |
| Queue retention | Graphile Worker deletes completed jobs and recommends a small queue table. pg-boss removes finished jobs according to retention settings. | A queue is not the product audit ledger. Keep durable history in application tables. [Graphile Worker scaling](https://worker.graphile.org/docs/scaling), [pg-boss introduction](https://pgboss.io/introduction) |
| Redis Pub/Sub | Redis Pub/Sub delivers messages at most once. A disconnected subscriber loses the message permanently. | Treat broadcasts as refresh hints. Recover browser state from durable records after disconnection. [Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/) |
| PostgreSQL notifications | PostgreSQL sends notifications after commit to listening sessions. Payload size is limited. | Notifications offer an alternative wakeup mechanism. Retain Redis broadcasts and durable rows for replay under the selected design. [PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html) |
| PostgreSQL search | `pg_trgm` supports indexed similarity and `LIKE`/`ILIKE` searches with GIN or GiST. Patterns without extractable trigrams degenerate to full-index scans. | PostgreSQL already supports an initial typo-tolerant entity search. Short inputs require a separate exact or prefix path. [PostgreSQL pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html) |
| PostgreSQL recovery | PostgreSQL supports point-in-time recovery through base backups and archived write-ahead logs. Its documentation distinguishes asynchronous and synchronous replication. | State the accepted data-loss window. Replication does not replace backup or restore testing. [PostgreSQL PITR](https://www.postgresql.org/docs/current/continuous-archiving.html), [PostgreSQL standby servers](https://www.postgresql.org/docs/current/warm-standby.html) |

Documentation changes over time. Pin the selected package release and retain its matching documentation before implementation.
This review cites current official documentation. It does not certify the behavior of an untested release.

## Changes within the retained architecture

The retained technologies and admission behavior follow the owner decision.
Durability and retention refinements remain contractor proposals.

| Current architecture location | Retained component | Proposed refinement or accepted behavior |
|---|---|---|
| Approved stack: Orchestration | Kestra | Preserve jobs, steps, independent workers, parallel assignments, and all-settled aggregation. |
| Core principle 4 and worker transport | Shared job files | Preserve manifests and artifacts. Define storage ownership and durable operation references. |
| Jobs pipeline: Consolidation and audit | Final consolidation | Record intent before dispatch and results during execution. Consolidation collects existing evidence. |
| Jobs pipeline: retries | Kestra scheduling and worker request backoff | Retry eligible unresolved operations without replaying successful operations. |
| Approved stack: Cache/session | Redis | Retain sessions, selections, caching, broadcasts, and admission holds. Freeze approved manifests durably. |
| Job admission | Job service and Redis | Apply 300-second job-type holds. Allow backoff reports to overwrite ownership. Require ownership for cleanup. |
| Worker recovery reports | Job service | Aggregate observations for early release. Keep the illustrative success threshold configurable. |
| Server-to-client signaling | Redis broadcasts and SSE | Recover missed events from durable application records. |
| Archive retention | Job files and audit artifacts | Define district-approved retention for audit records, sensitive inputs, temporary files, and diagnostic logs. |

## Required operation contract

Keep business records independent from Kestra execution retention.
Define `operations`, `operation_items`, `operation_attempts`, `audit_events`, `artifacts`, and `outbox_events` as application-owned concepts.
Orchestrator migrations must not rewrite the public operation history.

1. Validate authorization and operation parameters.
2. Freeze entity identifiers, intended changes, actor, policy version, and approval evidence.
3. Store the accepted operation and dispatch outbox record in one PostgreSQL transaction.
4. Reject duplicate submission keys that contain different request content.
5. Let the job service admit eligible jobs and correlate Kestra executions with stable application job identifiers.
6. Recheck execution authorization and applicable preconditions before each dispatch.
7. Record an attempt identifier and its dispatch intent before contacting Google.
8. Call Google outside the database transaction. Apply worker request backoff and report backoff to the job service.
9. Record confirmed success, confirmed failure, or an unknown outcome for each operation.
10. Commit each result, audit event, cache invalidation intent, and outbox event together when the result warrants them.
11. Retry only outcomes that the method policy classifies as safe.
12. Settle each assignment durably. Complete step aggregation after all assignments settle.

PostgreSQL acceptance and Kestra dispatch do not share one atomic transaction.
Reconcile ambiguous dispatch responses through stable job identifiers before creating another execution.

A process can fail after Google accepts a request and before PostgreSQL records the result.
Neither queue deduplication nor a database transaction closes this external gap.
An expired local lease also cannot cancel a request that Google already accepted.
Treat ambiguous non-idempotent outcomes as reconciliation work or required administrator review.
Do not promise exactly-once Google effects.

Use fencing tokens to reject stale local state transitions.
Keep leases short enough for recovery and renew them during active work.
Check cancellation between requests and before new dispatch.
Document that cancellation does not undo completed Google changes.

Kestra provides orchestration. The application owns operation state, authorization, reconciliation, and job admission.
The present architecture already requires these responsibilities while describing them as unfinished durability requirements.

## Files and audit evidence

Keep import files, exports, execution manifests, and evidence bundles where they serve a specific product requirement.
Define the job-storage interface now. Implement persistent local storage first.
Before distributing workers, qualify district shared filesystem storage or S3-compatible object storage.
Shared filesystem storage preserves filesystem access inside the adapter.
Object storage replaces filesystem operations with explicit transfer and publication while preserving file artifacts and audit evidence.
Pass artifact IDs between services. Keep paths and object keys inside storage adapters.
Publish verified artifacts through PostgreSQL metadata. Do not require atomic rename from the common interface.
Configure and qualify Kestra internal storage separately from application artifact storage.
Follow the [technical storage contract](2026-09-04-technical-change-instructions.md#76-job-storage-interface-and-artifact-publication).
Store artifact identifiers, checksums, ownership, size, schema version, encryption metadata, and retention policy in PostgreSQL.
Require completed upload and checksum verification before publishing an artifact reference.
Reconcile abandoned uploads and missing referenced objects.

Preserved job files and immediate durable results provide complementary audit evidence.
Append-only application permissions protect audit rows from ordinary application changes.
They do not protect against a database administrator who controls the database and backups.
If privileged tampering enters the threat model, export signed evidence to storage under separate administrative control.
Define the trust boundary before selecting immutability controls.

## PostgreSQL capacity and recovery

Start with normalized searchable columns for email, display name, serial number, asset identifier, status, and organizational unit.
Use B-tree indexes for exact matches, filters, and ordered pagination.
Apply trigram indexes to selected text columns after representative query tests.
Keep access-control filters in every search path.
Return bounded pages and stable cursors instead of loading an entire district into browser memory.

Retain PostgreSQL as the first search implementation.
Add a separate search engine only when measured ranking, language, aggregation, or response requirements exceed this design.
A separate engine introduces another copy of district data and another consistency and backup boundary.

Keep orchestration metadata, imports, interactive reads, and reports within explicit database connection and concurrency budgets.
Keep failed queue records bounded and store historical failure details in the application ledger.
Monitor database latency, oldest runnable item, retry rate, lock waits, storage growth, and vacuum progress.
Do not extrapolate trivial-job benchmarks into district throughput guarantees.

Select pgBackRest or the district's existing PostgreSQL backup system for a proof of recovery.
pgBackRest documents full, differential, and incremental backups, retention, and restore procedures. [pgBackRest user guide](https://pgbackrest.org/user-guide.html)
Define recovery point and recovery time objectives for each deployment profile.
Test database recovery together with Kestra state, artifact recovery, Redis recovery, and encryption-key recovery.
Treat admission holds as expiring coordination state. Preserve the 300-second expiration behavior after recovery.
After restoring an older database, quarantine uncertain operations before enabling Google mutations.
Google changes after the restore point still exist even when the restored operation ledger no longer contains them.

## Qualification gates

Run these experiments before accepting the runtime decision:

- Roll back operation acceptance. Verify that neither an operation nor its dispatch outbox record survives.
- Lose a Kestra dispatch response. Verify execution correlation before another dispatch.
- Overwrite a hold from another active job. Verify that previous-owner cleanup leaves it intact.
- Stop backoff reports. Verify expiration 300 seconds after the last accepted refresh.
- Aggregate recovery reports across workers. Verify that a newer backoff invalidates an earlier recovery streak.
- Release a hold. Verify smallest-first admission while existing jobs continue.
- Kill workers before dispatch, during a Google timeout, and after remote success but before local commit.
- Run competing workers against the same item. Verify local fencing and explicit handling of uncertain remote outcomes.
- Interrupt database connections and notification delivery. Verify durable progress and browser resynchronization.
- Fail over PostgreSQL under queued work. Measure recovery time and reconcile uncertain operations before resumed mutations.
- Restore an older backup. Verify that restored queue deliveries cannot silently repeat uncertain Google changes.
- Run representative search, imports, audit queries, and worker traffic simultaneously at each proposed district size.
- Fill the artifact volume. Verify that accepted operations remain explainable and that partial uploads never become valid evidence.
- Upgrade pinned Kestra and Redis releases against retained operations and failed jobs. Verify migration recovery before production approval.

Assign internal owners for Kestra, Redis, PostgreSQL, and emergency dependency patches.
Document Kestra edition and availability constraints for each deployment profile.
Retain explicit orchestration interfaces and application-owned operation state as the exit path.
