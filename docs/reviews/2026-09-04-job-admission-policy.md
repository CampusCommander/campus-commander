# Owner decision: job admission after Google backoff

> Integration update, 2026-09-05: the [design portfolio](../portfolio/README.md) incorporates this review and subsequent owner decisions.
> Use the portfolio for current planning and package status. This document preserves review evidence and rationale.

Status: owner-accepted behavior from the review conversation. Implementation safeguards below remain contractor proposals. No application code exists for this policy.

This decision supersedes the review's proposed quota governor and fixed quota allocations. LibreGrid and Redis remain required technologies. Kestra remains the orchestration baseline after the workflow discussion. The owner authors LibreGrid and requires its MIT distribution model.

## Accepted behavior

Workers execute greedily and use randomized backoff after applicable Google throttle responses. Workers report backoff to the job service. The job service writes `HoldDeviceUpdate = job12345` with a five-minute TTL. Workers do not modify hold keys directly.

The hold blocks admission of new Update Device jobs. Jobs already admitted continue their steps, batches, and retries. Other job types remain eligible. The flag does not block the owning job or its remaining worker assignments.

Pending jobs of the held type sort from smallest to largest. The purpose is to reduce waiting for small jobs. A newly submitted small job does not preempt active jobs or bypass the hold.

Another active Update Device job that encounters throttling reports that state to the job service. The job service overwrites the owner: `HoldDeviceUpdate = job54321`. This overwrite is intentional. Do not use create-if-absent behavior.

A worker still in a backoff cycle continues reporting that state during its wait. Each accepted report sets its job as owner and resets the TTL to five minutes. Updating the hold does not require previous ownership. Cleanup does require current ownership.

The job service handles completion cleanup and clears only flags belonging to the finishing job. If job12345 finishes after job54321 replaces it, job12345 leaves that flag intact.

The owner also permits release after a sequence of successful calls without backoff. The job service aggregates worker recovery reports. Five calls is an illustrative threshold. The final threshold remains configurable and requires validation. A later throttle establishes a new hold.

## Ownership example

| Event | Flag owner | Admission |
|---|---|---|
| Job A encounters backoff | A | New Update Device jobs wait. |
| Active job B encounters backoff | B | New Update Device jobs still wait. |
| Job A finishes | B | A cannot clear B's hold. |
| Job B finishes or satisfies the recovery rule | None | Pending jobs become eligible in size order. |

Remaining workers in backoff continue reporting and reestablish their job's ownership. When the final job finishes while owning the hold, its cleanup deletes the hold. If updates stop after a crash, the hold expires five minutes after the last accepted update. Early release remains permitted through the recovery rule.

## Proposed implementation safeguards

### Atomic ownership checks

The job service compares ownership and deletes in one Redis operation. Separate reads and deletes allow cleanup to remove another job's newer hold. Backoff reports deliberately replace ownership and reset expiration. Do not apply the cleanup ownership condition to those updates.

Redis supports atomic scripts for these conditional operations. Use a short script with explicit keys. This application does not require a distributed mutual-exclusion algorithm. Multiple active jobs and owner replacement are intentional. [Redis scripting](https://redis.io/docs/latest/develop/programmability/eval-intro/)

Give each job a bounded registry of hold keys it has written. Check those keys during cleanup. Do not scan the entire Redis keyspace for `Hold*` on every completion. Scope keys by deployment/customer and the canonical job type.

### Recovery after a crash

Normal completion is not guaranteed after a process crash. Add cleanup through Kestra's terminal execution handling and a reconciler. A terminal job includes completed, failed, and cancelled executions after their workers settle.

The accepted TTL is 300 seconds. Write the owner and TTL together on every accepted backoff report. Report continuing backoff more frequently than five minutes, including during long retry sleeps. The exact reporting interval remains an implementation setting. Redis documents key expiration directly. [Redis expiration](https://redis.io/docs/latest/commands/expire/)

Do not renew indefinitely from cached worker status after worker reports stop. Reject delayed reports from terminal jobs or stale worker attempts. With no further accepted updates, the flag cannot hold admission beyond its remaining five-minute lifetime. Queue dispatch then follows its normal scheduling cadence.

Expiration permits admission again. It does not establish recovered Google capacity. Existing request backoff remains active. Reject hold updates from stale worker attempts through the existing job execution checks.

### Concurrent workers and early release

The job service aggregates backoff and recovery observations across the owning job's workers for the affected type. Workers send observations and never clear flags themselves. Do not let one worker's local success counter ignore a peer's newer throttle.

Proposed event content includes job ID, worker attempt ID, job type, event sequence, and backoff or request-result state. Deduplicate repeated events before counting successes. Track which worker attempts still report an active backoff cycle. Keep aggregation inside the job service rather than creating a separate quota service.

Reset the recovery counter when a new throttle establishes or renews a hold. Associate recovery observations with the current hold revision. Clear only when owner, revision, and recovery condition still match atomically. This prevents an old success streak from deleting a newer hold from the same job.

For HTTP batches, inspect individual results. An outer HTTP success does not establish successful device updates. The success-count unit and threshold remain implementation decisions. Record them before implementing early release.

### Admission and ordering

Route job starts through one admission decision. Check the hold before committing a job to admitted status. Serialize that decision with hold changes or use equivalent atomic reservation. Work admitted before a hold becomes active belongs to the existing-job group.

As a proposed ordering detail, use the frozen operation count and then FIFO for equal counts. Keep existing concurrency limits when reopening the queue. A hold release does not require starting every queued job at once.

Pure smallest-first ordering does not guarantee eventual service for large jobs under continuous small-job arrivals. Retain the accepted ordering and measure the oldest waiting job. Do not silently add aging or reserved capacity to the owner's policy.

## Acceptance scenarios

- A worker backoff report causes the job service to create a hold without stopping active workers.
- Another active job's report overwrites the hold owner and resets its TTL to 300 seconds.
- Continuing-backoff reports can replace another job's ownership. Cleanup cannot delete another job's hold.
- A worker reports continuing backoff during a retry sleep longer than five minutes.
- Previous-owner cleanup cannot delete the replacement hold.
- Current-owner cleanup releases eligible jobs in size order.
- A small arriving job waits during the hold and moves ahead of larger pending jobs afterward.
- A newer same-owner throttle invalidates an earlier recovery streak.
- Successes from one worker do not hide a newer throttle from another worker.
- With no accepted refresh, the hold expires 300 seconds after its last update.
- Cached status and stale worker events cannot perpetually renew a crashed job's hold.
- A batch with throttled inner results does not count as a successful batch.
- Admission racing with hold creation has one defined ordering.
- Other job types continue while Update Device admission is held.
- A remaining job in backoff can reestablish its hold through the job service.

The design uses observed Google feedback. It does not estimate hidden quota balances, reserve fixed Google budget shares, or predict burst enforcement.
