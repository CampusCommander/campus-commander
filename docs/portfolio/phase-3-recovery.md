# Phase 3 isolated recovery

Owner: CC-56. Status: implementation and qualification in progress.
This record does not establish release acceptance.

## Existing restore boundary

`deployment/operations/index.mjs` runs the actual backup and restore commands.
Restore requires separate empty databases and separate storage. It verifies the backup before creating the target.
It retains `RESTORE_DISABLED` after verification. The installer rejects startup while that marker exists.
An interrupted restore retains the disabled target. Retry requires another empty target.
Redis recovery discards source cache state. The target requires a fresh Redis instance before service release.

## Admission invalidation

Restore now calls `invalidateRestoredAccess` after migrations and artifact verification, before writing the success report.
The migration connection revokes restored bootstrap credentials and all issued, redeeming, and pending invitations in one transaction.
Each invitation loses its token hash and browser binding. Its version advances once and its status becomes revoked.
Each revocation adds an `invitation-revoked` security event with `restore-invalidated` detail and the restore correlation ID.
An audit failure rolls back bootstrap and invitation changes together. The restore marker remains present.
Accepted, revoked, and expired invitations retain their state. Existing principals, grants, preferences, and security events remain intact.
Repeated invalidation changes no terminal invitation and adds no duplicate revocation event.
The restore report records counts without invitation tokens or browser bindings.

The PostgreSQL fixture checks restricted-role denial, exact audit-failure rollback, terminal-state preservation, and repeated invalidation.
The operations fixture seeds all six invitation states before backup and checks their state after the actual restore command.
It verifies that source invitation tokens and pending invitation browser bindings fail on the restored database.
Terminal invitation bindings retain their existing status projection. They do not create a platform session or grant.
This foundation fixture does not establish the complete Phase 3 browser or deployment-profile restore workflow.

## Google revalidation gate

Restore expires pending credential candidates and unapplied school reviews within the same invalidation transaction.
It erases candidate ciphertext, token caches, renewal leases, health-check leases, and school-reference leases.
It preserves the confirmed customer, committed credential, credential generation, key identity, and historical observations.
An active Google connection receives a PostgreSQL gate tied to the restore correlation ID.
Runtime roles cannot change that gate. Background token access, observation publication, and health or school-reference checks reject the closed gate.
A disconnected connection remains disconnected. A target without an active Google connection does not require Google revalidation.

The `revalidate-google` operator command requires the private target directory, saved configuration, restore report, and `RESTORE_DISABLED` marker.
It rejects configuration changes and database-identity overrides. It requires stopped application and Kestra database connections.
The command decrypts the committed credential with its recorded key ID. It accepts that key from primary or additional key references.
It does not try other keys. The credential key remains separate from the backup encryption key.
The shared Google verifier checks the restored credential and requires the same confirmed customer.
A successful transaction saves the observation, opens the gate, and records a `connection-checked` event with `restore-revalidated` detail.
Missing keys, wrong keys, provider failures, changed credential state, and different customers leave the gate closed.
An audit failure rolls back the observation and gate together.

The command writes `google-revalidation.json` after the database commit. It retains `RESTORE_DISABLED` for the remaining operator acceptance checks.
A repeated command returns `already-revalidated` with the original verification time. This receipt does not establish a new provider check.
Restored school references remain historical until a new reference check succeeds after the restore boundary.
Each restore creates a new boundary. Repeating invitation invalidation still produces no duplicate invitation revocation.

The PostgreSQL fixture exercises key selection, provider failures, gate enforcement, audit rollback, and reference freshness with synthetic credentials.
The provider fixture does not establish live grant revocation or minimum-role behavior.
[Run 35185727466](https://github.com/CampusCommander/campus-commander/actions/runs/35185727466) passed PostgreSQL, operations, browser, storage, Redis, and main checks at `f0837f1`.
Its application job failed before runtime tests because the image context excluded the new Google build script.
The image context correction includes that script and its entry module.
[Run 35186048400](https://github.com/CampusCommander/campus-commander/actions/runs/35186048400) passed all seven jobs at `ea5a16a`, including packaged application and all-Docker compatibility.
Both review axes found no actionable issues in `fa1993f...f0837f1`.

## Phase 3 state fixture

The `deployment:operations-phase3-integration` target adds a separate Phase 3 source to the actual database backup and restore fixture.
It uses the application database commands to confirm a customer, save settings, approve a school, and stage a replacement credential.
It also seeds a school grant, an unapplied school review, a provider renewal lease, and a health-check lease.
Before revalidation, the fixture compares complete-row hashes for the customer binding, encrypted credential, settings revisions, schools, grants, and principals.
It compares historical school-reference fields and reads the original settings receipt through the runtime role.
Pending credentials and reviews expire. Old school references do not establish effective scope.
The restored credential rejects the backup encryption key, missing credential keys, and a different customer observation.
The recovered credential key then opens the restore gate through the revalidation library.

The fixture writes `dist/phase-3-recovery/operations.json`. CI retains that report with counts, hashes, timings, backup age, and source revision.
Source and target databases share one PostgreSQL container. Separate storage trees share one Docker host.
Google verification uses a synthetic verifier. The fixture does not establish isolated networks, fresh Redis, browser sessions, or the revalidation CLI.
Review identified missing initial platform authority and missing command and image fields in the evidence report.
Revision `e60c688` confirms platform authority, passes the recorded permission version, and records the required evidence identity.
Both review axes found no remaining issues.
[Run 35186725120](https://github.com/CampusCommander/campus-commander/actions/runs/35186725120) passed the Phase 3 restore job at `06685a9`.
The [retained report](../../deployment/evidence/CC-56-phase3-state-restore.json) records one customer, credential, settings revision, school, principal, and reference observation, plus 12 grants.
The synthetic backup took 328 ms. Restore took 304 ms. Backup age at the final check was 532 ms.
These measurements describe this small fixture. They do not establish district recovery objectives.
That run passed all eight jobs, including packaged applications and all-Docker compatibility.

## Operator CLI qualification

The Phase 3 target now runs backup, verification, restore, and Google revalidation through the production operator CLI.
The operator container uses the pinned PostgreSQL tools. The report records their actual versions.
A test preload supplies synthetic Google transport responses to the production SDK and verifier.
The production CLI has no test-provider setting.

The fixture checks a missing credential key, the backup key in place of the credential key, denied delegation, denied privileges, and a different customer.
Each failure must retain the exact gate, connection, encrypted credential, audit state, and service-disable marker.
A live database connection must prevent revalidation. An injected audit failure must preserve the closed gate without a success receipt.
Success must create a private receipt, record one audit event, and permit a new renewal lease.
A repeated command must retain the original verification time and add no event, even if the provider fixture now reports another customer.
These checks qualify the repeated receipt semantics. They do not claim a new live Google check.
The fixture also makes the receipt destination a directory after verification succeeds, then rejects the next receipt write.
The database retains its verified state and original audit event. The service-disable marker remains present.
After correcting the destination, another command reconstructs the private receipt from the original verification.

Local lint, operations contracts, and release tests pass.
[Run 35187690542](https://github.com/CampusCommander/campus-commander/actions/runs/35187690542) passed the operator CLI restore job at `5b741c8`.
The [retained CLI report](../../deployment/evidence/CC-56-operator-cli-restore.json) records seven rejected revalidation cases, successful revalidation, and the repeated receipt.
It records PostgreSQL 18.6 tools inside the pinned operator container without an injected database runner.
The backup took 367 ms. Restore took 340 ms. The complete fixture took 31,943 ms.
Both review axes found no actionable issues in `60857a5...5b741c8`.
That run passed all eight jobs, including packaged applications and all-Docker compatibility.
[Run 35188533234](https://github.com/CampusCommander/campus-commander/actions/runs/35188533234) passed the receipt-write failure check at `c7932e2`.
The [receipt recovery report](../../deployment/evidence/CC-56-receipt-write-recovery.json) records the failed write, preserved database verification, and reconstructed receipt.
Its full application job failed during browser evidence registration in the access-revocation check.
The failure records closed browser targets while reading response headers and bodies. The failed run remains available for diagnosis.
The isolated restore step now runs after successful image builds even when an earlier application check fails.
The retained `06685a9` report predates this CLI increment and remains library-level evidence.

## Isolated application fixture

The `api-e2e:phase3-restore-integration` target installs Phase 3 and checks resume, restart, stop, and uninstall with retained data.
It then stops the source and seeds durable customer state through the application database commands.
The operator CLI restores that state into separate Compose databases, networks, and storage volumes.
The fixture compares durable state before Google revalidation. It then revalidates the credential before target application startup.
A fresh Redis instance rejects the source browser session. A new sign-in reads restored settings and the school definition.
The school retains its approved scope. Its historical references do not establish effective scope.

The fixture uses packaged application images, real Kestra, and the production operator CLI from the workspace.
Google transport and the sign-in provider remain synthetic. Both installations share one Docker host and reuse one loopback HTTPS origin.
The initial fixture does not establish accepted Phase 2 upgrade, extracted release-bundle delivery, live Google privileges, or pending login-transaction recovery.
[Run 35189111352](https://github.com/CampusCommander/campus-commander/actions/runs/35189111352) passed this fixture at `c4931fc`.
The [retained report](../../deployment/evidence/CC-56-isolated-application-restore.json) records preserved state, 51 original security events, restored artifact bytes, and rejected source sessions.
The restored browser session read the customer settings and school definition. PostgreSQL, Redis, Kestra, and artifact diagnostics passed.
The target verification report records 45,959 ms before source cleanup. Database restore took 592 ms.
The backup was approximately 41 seconds old at report creation.
The complete Phase 3 installation and recovery fixture took 194,185 ms. These measurements do not establish district recovery objectives.

The full run failed its separate Phase 2 all-Docker check while awaiting the Sign in heading after resume.
The packaged Phase 3 check and seven other jobs passed. The independent Phase 3 restore step also passed.
The Phase 2 browser failure and earlier response-observation failure remain unresolved. This run does not establish full compatibility.

## Pending admission extension

The isolated fixture now creates issued, redeeming, and pending invitations through the source API before backup.
It holds a regular sign-in callback and an invitation callback before either reaches the source application.
The restored database must revoke all three invitations, remove their token and browser hashes, and record three recovery audit events.
Complete row hashes verify that restore changes only the intended invitation fields.

The target must reject the issued link, both recipient browser bindings, and both pending callbacks.
The fixture checks the original five-minute authorization lifetime before callback replay.
After source restart, the original regular callback must still establish the original principal session.
That control distinguishes restored transaction loss from provider rejection or ordinary expiry.
Invitation tokens, callback URLs, and cookies remain in memory. Reports contain counts, hashes, statuses, and elapsed time.
[Run 35190962752](https://github.com/CampusCommander/campus-commander/actions/runs/35190962752) failed this extension at `2978b08` before backup.
Playwright did not invoke the callback route handler for the provider redirect. A local browser reproduction confirmed the failure.
The provider fixture now holds the next authorization before redirecting and retains its unused code in memory.
Local browser checks pass for direct authorization, redirected login, and the unchanged normal redirect.
The fixture returns held pages to the application origin before recipient status checks.
[Run 35192138281](https://github.com/CampusCommander/campus-commander/actions/runs/35192138281) passed isolated admission recovery at `9a5b046`.
The [retained report](../../deployment/evidence/CC-56-pending-admission-restore.json) records three revoked invitations and three recovery audit events.
The target rejected both recipient bindings, both pending callbacks, and the issued invitation link.
Callback replay occurred 45,531 ms after fixture preparation. The original regular callback still authenticated against the restarted source.
The restored state preserved 76 original security events and the original settings receipt.
The target verification report records 49,641 ms before source cleanup and the source callback control.
Backup age at report creation was approximately 41 seconds. The complete installation and recovery profile took 225,317 ms.
These results use synthetic providers. They do not establish live privileges or district recovery objectives.

The full run failed its separate packaged authorization check on a response header after page closure.
The Phase 2 all-Docker step did not run. Seven other jobs passed. This result does not establish full compatibility.

## Resume failure diagnostics

Run 35189111352 failed the Phase 2 Sign in heading check after an installer resume.
Its empty accessibility snapshot does not identify the cause or the preceding stop command.
The fixture now records bounded diagnostics around that reload and heading check.
The artifact name identifies the application phase and the stop or uninstall command.
The report includes route categories, response statuses, request error codes, and document element counts.
It excludes URLs, response contents, cookies, and tokens. The original assertion and timeout remain unchanged.
Hosted execution of these diagnostics remains pending. This instrumentation does not establish a correction for the failure.

## Operator procedures

The [Phase 3 recovery checklist](../../deployment/operations/PHASE-3.md) defines inventory, interrupted restore, identity recovery, credential review, and erasure checks.
Final comparison hashes follow source shutdown. Retry uses empty databases and a nonexistent target directory path.
The checklist distinguishes installer marker enforcement from controlled direct service startup.
It records the missing-key limitation and external material outside installer erasure.
Local links, instruction lengths, and formatting pass. Both review axes passed after correcting the inventory timing and directory instructions.
These procedures still require operator qualification and acceptance.

## Nonempty receipt and health inventory

The restore fixture now creates a second principal with a school-read grant and a distinct saved preference.
The application database review and change commands create the grant and its access-change receipt.
The health commands record one successful capability and one denied capability before a new pending health check.
The fixture expires the synthetic cooldown before creating that pending check.

Complete-row hashes now include access-change receipts and capability health history.
Runtime reads must return the original receipt and capability observations after restore.
The ordinary principal must retain its school read while historical references remain ineffective.
Restore must remove the pending health check without changing its recorded observations.

Both application and operator CLI restore fixtures use this inventory.
Local lint and all nine operations contract tests pass. Both review axes found no actionable issues.
The operator CLI job passed at `49ebf07` in [run 35207924636](https://github.com/CampusCommander/campus-commander/actions/runs/35207924636).
The [retained report](../../deployment/evidence/CC-56-nonempty-state-restore.json) preserves two principals, thirteen grants, one access-change receipt, and two capability observations.
Runtime receipt, health-history, and ordinary school-read checks passed. Seven revalidation denial cases and receipt-write recovery also passed.
The fixture recorded 35,470 ms overall and an 11,608 ms backup age. Synthetic provider and shared-host limits still apply.
The full run passed all eight jobs, including packaged Phase 2 and Phase 3 authorization and Phase 2 all-Docker compatibility.
The [expanded application restore report](../../deployment/evidence/CC-56-expanded-application-restore.json) preserves the same nonempty inventory and 80 original security events.
It rejects the old session, issued link, two recipient bindings, and both pending callbacks. The source callback control passes.
All four restored application diagnostics pass. Target verification records 53,126 ms before final source cleanup and callback control.
The fixture still uses workspace CLI code, synthetic Google transport, and one Docker host.
Extracted release delivery, live privilege and revocation checks, and operator acceptance remain unqualified.

## Remaining recovery work

- Inventory and verify complete customer, settings, school, grant, progress, receipt, credential, and security-event state.
- Test live revoked-grant and changed-privilege fixtures when available.
- Repeat the expanded admission fixture through the extracted verified release bundle.
- Record measured recovery time, backup age, fixture limits, operator recovery, and erasure procedures.

Local deployment lint, PostgreSQL contract tests, and operations contract tests pass.
[Full run 35184380912](https://github.com/CampusCommander/campus-commander/actions/runs/35184380912) passed all seven jobs at `24741c8`.
That run covers invitation invalidation, actual backup/restore, and packaged application compatibility. It predates the Google revalidation gate.
This result does not qualify the complete Phase 3 operator-CLI restore workflow.
