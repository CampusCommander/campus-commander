# PostgreSQL foundation

## Secret-file encoding

PostgreSQL password files contain one non-empty UTF-8 line.
One final LF or CRLF terminates that line. The password excludes that terminator.
Every other space remains part of the password, including leading and trailing spaces.
Embedded line endings, repeated final line endings, NUL bytes, and invalid UTF-8 fail with a fixed redacted error.
`secrets.mjs` defines this policy for provisioning, migrations, runtime connections, native backup tools, and Kestra database configuration.
Consumers pass original file bytes to the normalizer exactly once. Certificate files do not use this password policy.

Local PostgreSQL administrator files have a stricter boundary because the upstream image reads `POSTGRES_PASSWORD_FILE` directly.
Those files must contain exact UTF-8 password bytes without any CR or LF.
The pinned image removes terminal LF bytes but preserves CR bytes from CRLF input.
Generated local administrator files contain no line terminator.
All-Docker preparation rejects reused administrator files containing CR or LF. It does not rewrite them or change database credentials.
Kubernetes operators must provide local administrator Secret values without CR or LF before starting the PostgreSQL workload.
Correct an existing database credential only through an approved credential replacement procedure. Editing its file alone does not update PostgreSQL.

The [qualification manifest](qualification.json) pins PostgreSQL 18.6 and its immutable upstream image digest.
The runtime adapter requires server version `180006`, UTF8, and roles without cluster administration privileges.
Release upgrades require a new pin and a repeated qualification run.
This qualification covers one PostgreSQL instance on Linux amd64.
It does not qualify replication, failover, district hosts, or Kubernetes storage.

## Ownership and commands

The district operator owns database creation and password distribution.
The application migrator owns the application database and the `cc` schema.
The application runtime receives `CONNECT`, schema `USAGE`, metadata `SELECT`, and explicit table DML privileges.
It cannot create databases, create public tables, or change migration records.
Kestra owns its separate database and runs its own migrations.
The application migration runner never changes Kestra tables.

Run these commands from the repository root:

```sh
npm exec nx run deployment:build
node deployment/postgres/cli.mjs provision deployment/examples/all-docker.json deployment/postgres/operator.example.json
node deployment/postgres/cli.mjs migrate deployment/examples/all-docker.json deployment/postgres/operator.example.json
node deployment/postgres/cli.mjs ready deployment/examples/all-docker.json
npm exec nx run deployment:postgres-test
npm exec nx run deployment:postgres-integration
```

The example configuration contains synthetic endpoints and secret references.
Replace them with installation configuration before provisioning.
Mount the referenced passwords under `/run/secrets`.
Keep the operator configuration and administration password outside application containers.
Use the runtime database role from the deployment configuration for application connections.
Use the separate migration role only during installation and upgrades.
The CLI validates deployment configuration before it resolves secrets or opens connections.
The CLI exits nonzero and emits a fixed message on failure.

`provision` serializes calls on the same administration database.
Use the same administration database for every provisioning attempt.
It creates missing roles and databases, reapplies privileges, and updates passwords from the supplied secrets.
It rejects existing databases with different owners or encoding.
Different application and Kestra endpoints receive separate provisioning calls.
Each call creates only its service database and roles.
Use optional `kestraAdmin` settings in the operator file when the Kestra server needs different administration credentials.
That object accepts `adminDatabase`, `adminRole`, and `adminPasswordSecretRef`.
Choose installation-specific names. Do not reuse unrelated database roles.
Persist PostgreSQL 18 data at `/var/lib/postgresql` in the pinned image.

## External operators

An installer without `CREATEDB` must not call `provision`.
Give the district operator the database names, migration role, runtime role, Kestra role, and secret references.
The [operator SQL](external-provision.sql) separates application provisioning from Kestra provisioning.
Execute each section on its configured server through an authenticated operator session.
Supply its psql variables through a protected script or interactive session.
Do not pass passwords as shell arguments.
Require distinct role names and database names.
For existing resources, verify UTF8, ownership, role attributes, and absence of role memberships before resuming.
Revoke any prior explicit cross-database grants before accepting an existing installation.
Use `migrate` and `ready` after the operator supplies the databases.
These commands require no superuser, role-creation, or database-creation privileges.

External endpoints require verified TLS.
`private-ca` resolves the declared CA secret and verifies the endpoint hostname.
`system-ca` uses Node certificate trust and verifies the endpoint hostname.
Connection URLs cannot override certificate verification through query parameters.
Install server certificates and require `hostssl` authentication in district-managed PostgreSQL.
The local qualification fixture tests a private CA, an incorrect hostname, and an untrusted CA.
No district endpoint was supplied. District connectivity remains untested.
For Kubernetes, mount Secret values at `/run/secrets/<name>/<key>` or supply a resolver to the JavaScript API.

## Migration and readiness contract

`migrate(client, { runtimeRole })` uses a dedicated connection and a session advisory lock.
The lock covers ledger creation, checksum comparison, SQL execution, and runtime grants.
Each migration and its ledger entry commit in one transaction.
A failed migration rolls back its SQL and leaves the release migration absent.
`checkReadiness(client)` requires the exact migration set and checksums for the running release.
An altered migration, missing migration, or unexpected migration prevents readiness.
Startup must await successful migration completion before starting dependent services.
The readiness check returns false on connection, encoding, privilege, or ledger errors.
Applications must preserve that result in their readiness endpoint.

`connectDatabase(service, resolveSecret)` accepts a validated deployment database service.
The resolver returns a string or Buffer for the configured secret reference.
The function closes failed connections and replaces connection errors with a fixed message.
The installer uses administration credentials only for `provision`.

## Foundational metadata

`cc.artifacts` stores artifact identity, locator, checksum, size, schema version, attempt identity, retention, and publication state.
It also stores active-upload and reference-count guards for storage cleanup.
Storage adapters must lock the artifact row and compare `attempt_id` before publication or deletion.
They must reject deletion while `active` is true or `reference_count` exceeds zero.
The unique locator prevents two artifact identities from sharing a storage object.
Ready rows require a checksum and size.
`cc.bootstrap_access` stores temporary access generation, credential hash, expiry, and revocation.
These tables contain no entity inventory or future operation ledger.

## Primary sources

- [PostgreSQL 18.6 release notes](https://www.postgresql.org/docs/18/release-18-6.html) identify the qualified release and security corrections.
- [Database creation](https://www.postgresql.org/docs/18/sql-createdatabase.html) defines ownership, encoding, and template behavior.
- [Privileges](https://www.postgresql.org/docs/18/ddl-priv.html) defines database connection and schema permissions.
- [Advisory locks](https://www.postgresql.org/docs/18/explicit-locking.html) defines session lock behavior.
- [PostgreSQL TLS](https://www.postgresql.org/docs/18/libpq-ssl.html) explains certificate and hostname verification.
- [node-postgres TLS](https://node-postgres.com/features/ssl) documents client TLS options and connection-string overrides.
