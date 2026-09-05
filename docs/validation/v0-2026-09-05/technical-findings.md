# V0 technical findings and change instructions

**Status: measured findings plus proposed implementation details. No production configuration was changed.**

## 1. Compiler and dependency qualification

The existing API build passed. The frontend build failed with NG4006, TS5069, and TS2584.
The frontend inherited declaration-only emission and lacked the DOM library.
The [isolated override](experiments/frontend-tsconfig.json) produced a successful frontend build.

During P0.1, change `frontend/tsconfig.app.json` to override declaration emission and include `ES2022` and `DOM`.
Keep declaration-producing options in library configurations that require them. Inspect inherited settings before changing the shared base.
Run the ordinary API and frontend Nx builds after that scoped change.
Remove the experimental override from release build instructions after the ordinary build passes.

The tested framework set was Node 24.19.0, Angular 22.0.8, TypeScript 6.0.3, Nx 23.1.0, and NestJS 11.1.28.
Angular 22 supports the tested Node and TypeScript versions. [Angular compatibility](https://angular.dev/reference/versions)
Installed peer checks found no mismatches among checked peers. They did not establish full dependency completeness.

LibreGrid 1.3.0 declares AG Grid Community `>=36.1.0 <37`.
Use matching AG Grid Community and Angular wrapper 36.1.0 as the next experiment candidate.
Do not treat Angular wrapper 36.0.x as a complete qualified set with LibreGrid 1.3.0.
The exact registry responses live in [grid metadata](evidence/grid-metadata.json).

An isolated Angular AOT fixture compiled server-side loading, selection, editing, and the Material provider together.
It used strict template checks with `skipLibCheck: false`.
The passing set uses Angular core 22.0.8, Material/CDK 22.1.5, AG Grid 36.1.0, and LibreGrid 1.3.0.
Material and CDK 22.0.8 were absent from the registry. Their version numbers need independent qualification.

A Chromium 151.0.7922.34 smoke test loaded one synthetic row, edited a value, and selected the row.
No browser errors or warnings occurred in the passing run.
The fixture required `@libregrid/server-side-selection@1.3.0` and registration of `ServerSideSelectionModule`.
The first fixture registered only the server-side row model. Its selection column contained no checkbox.
Add both modules to the P6.2 integration contract. Preserve this requirement in the release dependency set.
The passing bundle used Angular JIT support for dependency linking. It does not qualify the production bundler configuration.

Exercise row eviction, restored selection, drafts, keyboard navigation, and screen-reader announcements in a browser.
Preserve LibreGrid selection. Metadata compatibility alone does not establish these behaviors.

## 2. Kestra orchestration and external workers

Kestra 1.3.37 ran against its own PostgreSQL database and local internal storage.
The experiment used `ForEach`, `concurrencyLimit: 3`, HTTP worker tasks, and `allowFailure: true`.
Ten assignments represented 500 operations each. The HTTP fixture returned counts without executing 5,000 provider requests.
One assignment returned HTTP 503. Another returned HTTP 200 with three domain failures.
All ten assignments settled before the aggregation task ran.

The failing assignment received duplicate requests with both GET and POST dispatch.
The baseline counted callback events and failed with eleven settlements. The corrected fixture counted unique assignments.
Kestra returned `WARNING`. The aggregation task returned `SUCCESS`.
An HTTP 200 task also contained domain failures. Kestra task status therefore cannot supply the application result alone.
See [ForEach documentation](https://kestra.io/plugins/core/flow/io.kestra.plugin.core.flow.foreach) and [HTTP Request documentation](https://kestra.io/plugins/core/http/io.kestra.plugin.core.http.request).

Apply these changes in P1.1/P2.1/P2.2 contracts, flow templates, and worker dispatch handlers:

1. Dispatch work with POST and stable application job, step, assignment, and manifest identifiers.
2. Store the accepted assignment identity in PostgreSQL with a uniqueness constraint.
3. Reject reused identities whose manifest digest differs.
4. Return existing assignment state for duplicate dispatch instead of starting another execution.
5. Issue a new attempt epoch only through the durable lease transition.
6. Reject state updates from expired attempt epochs.
7. Persist each operation outcome before acknowledging durable completion.
8. Aggregate unique terminal assignments and preserve each operation outcome category.
9. Configure one bounded retry policy across transport, orchestration, and Google request handling.
10. Reconcile uncertain Google effects before any operation replay.

The corrected fixture stores deduplication in memory. It demonstrates the protocol correction only.
Production deduplication must survive process death and multiple workers.
A local assignment key does not create Google idempotency support.

### Recovery transitions

| Trigger | Durable transition | Recovery action |
|---|---|---|
| User confirms a preview | Commit job, frozen manifest reference, and dispatch outbox together | Outbox dispatcher retries delivery using the same identity |
| Worker accepts assignment | Claim assignment and attempt epoch conditionally | Duplicate delivery returns the recorded state |
| Worker prepares Google request | Record operation intent and request digest | Reconcile unresolved dispatch after lease expiry |
| Google responds | Commit per-operation outcome and audit evidence | Retry eligible failed operations only |
| Worker dies after remote acceptance | Preserve unresolved dispatch as unknown | Verify current state or require review according to capability |
| Old worker reports completion | Reject mismatched epoch | Retain diagnostic evidence without replacing current state |
| Every assignment settles | Aggregate operation records | Record completed, completed-with-errors, cancelled, failed, or needs-review outcome |

The worker-death experiment killed a real child process after a separately committed simulated provider effect.
It proved preservation of uncertainty and stale-epoch rejection. It did not prove real Google reconciliation.
Kestra acknowledgement loss, restart, and duplicate execution correlation remain required tests.

## 3. Redis holds and admission

The owner policy remains unchanged. Any accepted backoff report can overwrite the hold owner and renew its 300-second TTL.
Cleanup deletes only a hold still owned by that job. Existing jobs continue. Pending jobs sort smallest first.
Workers send observations to the job service. The job service writes Redis.

The probe passed owner overwrite, TTL renewal, conditional cleanup, and 100 concurrent replacement/cleanup iterations.
The probe also demonstrated atomic hold checking with smallest-first removal from a Redis sorted set.
The unrefreshed hold was absent at the later observation. This was not a continuously sampled expiry measurement.

Use atomic compare-and-delete for cleanup. A separate GET followed by DELETE retains an ownership race.
Track the bounded set of hold keys touched by each job. Avoid scanning all Redis keys during cleanup.
Redis executes Lua scripts atomically. [Redis scripting](https://redis.io/docs/latest/develop/programmability/eval-intro/)

The recovery probe checks owner, revision, and success count. It does not implement the full observation pipeline.
Keep the success threshold, counted unit, observation window, and reporting interval as proposed settings.
Five successful calls remains an example, not an accepted deployment constant.

The next job-service experiment must prove these transitions:

| Observation | Required behavior |
|---|---|
| New valid backoff | Overwrite owner, renew TTL, and invalidate earlier recovery evidence |
| Worker remains in backoff | Continue accepted reporting during the wait and renew TTL |
| Duplicate observation | Avoid incrementing recovery evidence twice |
| Old attempt or terminal job | Reject the observation before it creates or clears a hold |
| Success before the latest backoff revision | Exclude it from the current recovery count |
| Recovery threshold reached | Clear only matching owner and recovery revision atomically |
| Job completes after losing ownership | Preserve the replacement owner's hold |

The recovery design needs event identities and attempt epochs. It does not need an estimated Google quota balance.

### Admission recovery boundary

The Redis probe uses `ZPOPMIN`. That removes a queue entry before PostgreSQL records admission.
A crash in that gap would lose a Redis-only queue item.
Keep pending jobs durably in PostgreSQL. Redis queue entries remain a rebuildable admission index.

Specify the admission grant as the serialization boundary with a backoff hold.
A hold created after that grant blocks later grants. It does not cancel the granted job.
Persist a recoverable reservation identity and conditionally transition the durable job before dispatch.
Reconcile expired reservations against durable job state before requeueing or redispatching.
Pause new admission when Redis is unavailable. Existing work retains its documented execution behavior.

Test a process kill between each Redis and PostgreSQL transition with two job-service instances.
Do not claim a distributed transaction from an atomic Redis script alone.

## 4. Artifact publication

The probe wrote temporary bytes, flushed the file, renamed it, and rolled back the publication transaction.
Readers found no ready metadata. Recovery verified the checksum and published the completed artifact.
The probe detected mismatched bytes and rejected a stale-attempt metadata update.

Apply the publication contract in P2.4, not in individual Google handlers:

1. Allocate a stable artifact ID and immutable attempt locator.
2. Stream output into staging storage.
3. Complete backend durability steps and verify length and checksum.
4. Publish metadata only for the current authorized attempt.
5. Serve downloads only through ready metadata and current authorization.
6. Reconcile completed staging objects after interrupted metadata publication.

The local probe did not flush the containing directory or simulate host power loss.
The local adapter needs directory durability and filesystem-specific crash tests before claiming host-crash safety.
The shared adapter needs real cross-host visibility, outage, permission, cleanup, and restore tests.
An S3 adapter needs object completion and conditional publication semantics. It must not imitate atomic rename.
Kestra internal storage needs its own deployment qualification.

## 5. Packaging changes

The existing `docker-compose.yml` references absent `apps/api/Dockerfile` and `apps/frontend/Dockerfile` files.
It uses misspelled `KESTEA_*` variables and does not prove Kestra repository configuration.
It has no worker service. Its declared `redis_data` volume is unused.
It exposes internal services and includes static database credentials.
Its PostgreSQL 16, Redis 7, and Kestra 0.20.0 images differ from the isolated experiment versions.

Replace those scaffold sections during P0.1/P9.2:

| Existing section | Replacement |
|---|---|
| Source builds through absent `apps/` Dockerfiles | Published application and worker images from the retained root-level workspace |
| `KESTEA_*` configuration | Version-qualified Kestra repository, queue, internal storage, authentication, and health configuration |
| One database ownership boundary | Separate application and Kestra databases and migration ownership, even on one server |
| API-only job execution path | Independent workers with internal authenticated endpoints |
| Static passwords and broad published ports | Generated installation secrets and an HTTPS edge with internal service networking |
| Unspecified persistence | Explicit application artifacts, Kestra internal storage, database, and Redis persistence/rebuild policy |
| Hardcoded local dependencies | Configurable PostgreSQL, Redis, Kestra, and artifact endpoints for each deployment profile |

The isolated Kestra configuration did not disable Basic Auth through the attempted setting.
Its first-run API required credential initialization. Packaging must test the selected version's actual startup behavior.
The local configuration also reported enabled anonymous usage collection. The installer needs an explicit, tested telemetry policy.
These are packaging findings. The scratch configuration is not a district deployment example.

## 6. Process changes

Keep failure evidence alongside corrected results. Record the changed assumption and the tested boundary.
Pin experiment versions before interpreting results. Repeat relevant tests against the eventual release images.
Separate source-backed API facts, measured behavior, proposed settings, and untested requirements in every gate report.
Require a controlled-account result before implementing Google onboarding claims.
Require a combined workload before publishing capacity guidance.
Observe novice installation after packaging works. Local developer success does not establish librarian usability.
