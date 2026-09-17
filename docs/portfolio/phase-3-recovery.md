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

## Remaining recovery work

- Inventory and verify complete customer, settings, school, grant, progress, receipt, credential, and security-event state.
- Invalidate other pending reviews, credential candidates, and provider leases that belong to the source installation.
- Verify recovered credential encryption keys independently from the encrypted backup key.
- Require connection revalidation before background Google reads resume.
- Prove missing-key, revoked-grant, changed-privilege, and wrong-customer failures without fallback.
- Execute the complete Phase 3 operator-CLI restore with distinct databases, networks, storage, and fresh Redis.
- Record measured recovery time, backup age, fixture limits, operator recovery, and erasure procedures.

Local deployment lint, PostgreSQL contract tests, and operations contract tests pass.
[Full run 35184380912](https://github.com/CampusCommander/campus-commander/actions/runs/35184380912) passed its PostgreSQL and operations jobs at `24741c8`.
Those jobs execute the audit-failure probes and actual backup/restore fixture. Packaged application compatibility remains pending.
This result does not qualify the complete Phase 3 operator-CLI restore workflow.
