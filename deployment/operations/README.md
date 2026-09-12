# Foundation backup and restore

`cli.mjs` creates encrypted backups and restores into new, empty targets.
It never starts services. Successful restore returns `verified-services-disabled` and retains `RESTORE_DISABLED`.
The operator must prevent service startup while that marker exists.
Profile startup commands do not enforce this marker automatically.

## Inventory and consistency

| Component                        | Backup and recovery                                                      |
| -------------------------------- | ------------------------------------------------------------------------ |
| Application PostgreSQL           | Custom-format dump, migration ledger, artifact metadata, bootstrap state |
| Kestra PostgreSQL                | Separate custom-format dump of all user tables                           |
| Application artifacts            | Complete file tree, opaque identities, sizes, SHA-256 checksums          |
| Kestra internal storage          | Separate complete file tree and checksums                                |
| Configuration and release        | Encrypted validated configuration and immutable image inventory          |
| Runtime secrets and private keys | References only, recovered from a separate protected store               |
| Redis                            | Discard cache and create a fresh instance before service release         |

Stop API, workers, and Kestra before backup. Disable their automatic restart and external dispatch access.
Stop every other database client and filesystem writer, including monitoring clients that connect to these databases.
Record the operator identity and stop time in `quiesce` immediately before backup.
The command rejects records older than five minutes and existing database connections.
It holds SHARE locks on both databases' user tables throughout dumps and file reads.
It rejects active artifact attempts, changed file inventories, changed table counts, and connections observed after copying.
These checks support a cold backup. They do not replace the operator's control over stopped writers and storage mounts.

PostgreSQL documents consistent single-database dumps in [pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html).
The cross-component boundary requires stopped writers because a database dump does not capture filesystem state.
See [table locks](https://www.postgresql.org/docs/18/sql-lock.html) and [transactional restore](https://www.postgresql.org/docs/18/app-pgrestore.html).
The recovery point is the recorded stop time. Changes after that point are outside this backup.
Fixture timings do not establish district recovery guarantees.

## Prerequisites and commands

Use Node.js with installed workspace dependencies and built deployment configuration code.
Install PostgreSQL 18.6 `pg_dump` and `pg_restore` on the operator host.
The production runner checks their exact version and uses verified TLS for configured TLS endpoints.
The operator host needs direct access to both databases and both source storage trees.
Use the dedicated application migration role and Kestra database owner. Runtime services do not need superuser access.

Run `npm exec nx run deployment:operations-native-integration` to qualify the native tools against an isolated PostgreSQL fixture.
Place the exact tools on `PATH` before execution. The fixture creates and removes its own Docker database and volume.
It uses the production runner without a Docker command adapter.
It checks encrypted backup, isolated restore, configuration, artifact integrity, Kestra fixtures, and the fresh-Redis release requirement.
The fixture uses loopback PostgreSQL without TLS. It does not qualify district endpoints or shared storage.

Run `npm exec nx run deployment:operations-cli-integration` to test the same fixture through the operator CLI.
This target requires Linux user namespaces, mount namespaces, and the exact native tools on `PATH`.
It creates private operator files and mounts secret references at `/run/secrets` inside an isolated namespace.
It tests key generation, backup, verification, restore, and rejection of invalid operations.
The CLI uses the production database runner. The fixture does not change host secret mounts or weaken configuration validation.

The application restore targets invoke the CLI with native tools inside the pinned PostgreSQL image.
All Docker and Kubernetes fixtures mount private operator inputs and source storage into a temporary operator container.
On Docker Desktop, set `CC_OPERATIONS_CLI_HOST=1` when container host networking cannot reach the operator host loopback listeners.
This option uses native tools on `PATH` and isolated Linux secret mounts for those two fixtures.
The fixture records the selected runner. It does not change the backup or restore command.
The hybrid fixture invokes the CLI inside its existing operator container with verified district-service TLS.
These fixtures use the qualification Node binary and retain the PostgreSQL image digest in their evidence.
They verify restored application access and reject old sessions after fresh Redis starts.
Their synthetic infrastructure does not qualify district storage or recovery-key custody.
The Kubernetes fixture gives each database connection an independent `kubectl port-forward` process.
This transport preserves the backup lock session when a database tool closes its connection.
It bounds concurrent tunnels and terminates every owned tunnel during cleanup. Database TLS verification remains enabled.

Copy `operator.example.json` into a protected operator directory and replace every example value.
Keep the backup directory outside all primary volumes and source trees.
Use an encrypted backup destination on a separate storage system under district retention controls.
The command rejects overlapping paths. The operator must also exclude alternate mount aliases for the same backing volume.

```sh
npm exec nx run deployment:build
node deployment/operations/cli.mjs generate-key /protected-recovery/backup-key
node deployment/operations/cli.mjs backup /protected-operator/backup.json
node deployment/operations/cli.mjs verify /protected-operator/backup.json
node deployment/operations/cli.mjs restore /protected-operator/restore.json
```

`generate-key` creates a new 32-byte file with mode 0600 and refuses overwrite.
Preserve that key in an independently protected recovery store. Test retrieval before accepting a backup.
Preserve runtime passwords, TLS keys, Kestra encryption keys, and authentication material through that separate recovery procedure.
Do not place recovery keys or secret files inside ordinary backup material.
The backup contains only secret references. Database contents and configuration receive AES-256-GCM encryption.
The manifest authenticates the component inventory with HMAC-SHA-256. Each encrypted component also records its ciphertext checksum.
An `INCOMPLETE` marker prevents acceptance after interruption. Dump bytes stream directly into encryption.

## Isolated restore and release

Provision two new empty databases with new application, migration, and Kestra roles through the PostgreSQL provisioning command.
Do not run application migrations on the target before restore.
Keep all target services stopped and prevent automatic restart throughout restore.
Set `configurationPath` to a validated target configuration with the same profile and image inventory as the backup.
Set the artifact location to `<targetDirectory>/artifacts` and Kestra internal storage to `<targetDirectory>/kestra-internal`.
The target directory must not exist. It must be separate from backup material.
Set `applicationCredentials.role` to the new target migration role.
Provide every referenced runtime secret and the original backup key through protected mounts.

Restore verifies all encrypted components before target creation.
It rejects source database identities, existing user tables, existing target directories, missing keys, and corrupt components.
Each database restore uses one transaction with immediate failure on SQL errors.
A later component failure retains the isolated target and disabled marker. It does not authorize retry over partial databases.
Create another empty target for retry. Preserve failed targets until the operator reviews the failure.

Successful restore verifies table inventories and every ready artifact checksum.
It restores application grants and revokes restored bootstrap credentials.
It writes `restore-report.json` and `target-configuration.json`. It removes temporary plaintext database dumps after success.
A failed restore can retain plaintext dumps inside the private, disabled target directory.
Protect and explicitly erase that failed target through district procedures after investigation.

Before release, inspect the report and verify expected application and Kestra fixture values.
Read restored artifacts through the storage adapter and verify Kestra internal execution files.
Create a fresh Redis instance with the configured authentication and TLS settings.
Do not restore Redis cache files or replay future mutation jobs.
Create a replacement bootstrap credential through the bootstrap replacement procedure.
Start dependencies and verify authenticated startup checks before enabling dispatch.
Record Redis checks, fixture identities, checksum results, elapsed time, and operator acceptance.
Remove `RESTORE_DISABLED` only after that acceptance. Release services through the applicable installation profile.

For all-Docker, expose the stopped source volumes to the operator host through controlled mounts.
For hybrid, use the qualified district shared mount and externally provisioned database roles.
For Kubernetes, stop controllers and use a dedicated operator Pod with both qualified RWX claims and database access.
Keep application artifacts and Kestra internal storage in separate trees.
The CLI does not create mounts, Secrets, namespaces, or provider snapshots.
Actual hybrid and Kubernetes restores require their qualified district infrastructure.

## Library seam and validation

`backupFoundation`, `verifyBackup`, and `restoreFoundation` accept a secret resolver.
`applicationCredentials` overrides the application connection with the dedicated migration role.
An injected `runTool` supports a controlled operator execution environment.
`restore-report.json` provides application and Kestra table inventories and restored artifact identities, sizes, and checksums.
The parent fault harness can compare these inventories with its fixture reads.

```sh
npm exec nx run deployment:operations-test
npm exec nx run deployment:operations-integration
```

The integration fixture uses the qualified PostgreSQL image and disposable synthetic databases and files.
It checks encrypted backup, both database restores, artifact reads, Kestra fixture state, and missing or corrupt components.
It also checks missing source storage, busy databases, nonempty targets, and failure before a restore success report.
It does not establish actual Kestra engine recovery, district shared-storage recovery, or a complete profile restart.
