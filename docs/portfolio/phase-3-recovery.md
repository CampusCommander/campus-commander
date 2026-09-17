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
Full application qualification at that revision remains active.

## Remaining recovery work

- Inventory and verify complete customer, settings, school, grant, progress, receipt, credential, and security-event state.
- Test live revoked-grant and changed-privilege fixtures when available.
- Execute the complete Phase 3 operator-CLI restore with distinct databases, networks, storage, and fresh Redis.
- Record measured recovery time, backup age, fixture limits, operator recovery, and erasure procedures.

Local deployment lint, PostgreSQL contract tests, and operations contract tests pass.
[Full run 35184380912](https://github.com/CampusCommander/campus-commander/actions/runs/35184380912) passed all seven jobs at `24741c8`.
That run covers invitation invalidation, actual backup/restore, and packaged application compatibility. It predates the Google revalidation gate.
This result does not qualify the complete Phase 3 operator-CLI restore workflow.
