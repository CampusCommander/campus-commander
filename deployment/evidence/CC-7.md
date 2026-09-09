# CC-7 PostgreSQL qualification

## Closeout assessment, 2026-09-09

Hosted all-Docker, external TLS PostgreSQL in hybrid, and Kubernetes installations passed on 2026-09-09.
The earlier environment limitations below describe the initial component tests.
See the [hosted validation record](../installer/HOSTED-VALIDATION.md).

## Historical component evidence

Date: 2026-09-08. Fixture: isolated Docker container, unique named volume, generated passwords, and a temporary certificate.
The test removed its container, volume, and certificate directory after execution.
No existing database received test queries or changes.

| Acceptance criterion                            | Implementation                        | Evidence                                                                                                                                |
| ----------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Qualify and pin PostgreSQL                      | `postgres/qualification.json`         | PostgreSQL 18.6, Linux amd64, immutable upstream digest, `pg` 8.16.3                                                                    |
| Separate databases and least privileges         | `postgres/index.mjs` `provision`      | Fresh provisioning and repeated provisioning passed. Runtime DDL and migration-ledger deletion failed.                                  |
| UTF8 startup checks                             | `verifyConnection`                    | UTF8 accepted. LATIN1 startup and existing database validation rejected.                                                                |
| Serialized migrations and failure readiness     | `migrate`, `checkReadiness`           | Eight concurrent migrators produced one ledger entry. Failed SQL rolled back. Missing and altered release migrations blocked readiness. |
| Restart persistence                             | `postgres/integration.mjs`            | Unicode artifact locator and Kestra fixture survived database restart.                                                                  |
| Cross-database denial and external provisioning | `provision`, `external-provision.sql` | Application-to-Kestra, Kestra-to-application, and migrator-to-Kestra connections failed. Operator procedure supplied.                   |
| Verified external TLS without runtime superuser | `connectDatabase`                     | Private CA connection passed. Wrong hostname and untrusted CA failed. Runtime superuser validation failed.                              |

Commands:

```sh
npm exec nx run deployment:postgres-test
npm exec nx run deployment:postgres-integration
npm exec nx run deployment:lint
```

The four Node unit tests passed. The real PostgreSQL integration test passed. Deployment lint passed.
The integration test also verified bootstrap initialization, unchanged expiry during resume, expiry denial, replacement generation checks, and revocation.
The bootstrap test rejected old credentials after replacement and accepted the replacement before revocation.

The first restart run exposed Docker port reassignment in the fixture harness.
The harness now reads the assigned port after restart. The corrected run passed.

District PostgreSQL connectivity: **not-run**. No district endpoint or trust material was supplied.
Kubernetes persistent storage: **not-run**. No Kubernetes environment was supplied.
Cross-host database connectivity: **not-run**. The TLS fixture ran on the local Docker host.
These checks remain release gates. Local tests do not satisfy district acceptance.

Kestra migrations remain under Kestra ownership.
Kestra 1.3.37 migration success against PostgreSQL 18.6 provides experimental compatibility evidence for the tested paths.
Its bundled Flyway version warns that PostgreSQL 18 exceeds its tested range.
This record does not claim vendor support for that combination.
See CC-5 evidence for Kestra execution qualification and remaining constraints.

The [PostgreSQL 18.6 release notes](https://www.postgresql.org/docs/18/release-18-6.html) identify the release and security corrections.
The [implementation documentation](../postgres/README.md) records primary sources, role ownership, command usage, and the migration contract.

## Consistent PostgreSQL secret-file policy

The shared normalizer accepts one non-empty UTF-8 line with one optional final LF or CRLF.
It preserves password spaces and rejects embedded line endings, repeated line endings, NUL bytes, and invalid UTF-8.
The CLI reads raw bytes. Provisioning and connection consumers normalize those bytes once.
Runtime connections and native backup tools use the same policy.

Five PostgreSQL tests and the complete PostgreSQL integration passed after this change.
The integration executed the real provisioning and migration CLI against an isolated PostgreSQL 18.6 database.
Its operator, migrator, application, and Kestra credential files included LF or CRLF terminators.
The runtime then connected from raw file bytes and verified migration readiness.
The application password retained its leading and trailing spaces.
A file with two final newlines failed through both CLI provisioning and runtime connection without exposing its marker.

Native PostgreSQL 18.6 backup and restore passed with CRLF-terminated credential files.
The run restored both databases and six encrypted components in 179 and 109 milliseconds respectively.
[The secret-policy result](CC-7-secret-policy-result.json) records the runtime checks and native tool versions.
Final application images require rebuilding to include this product change.

The pinned PostgreSQL image's actual `file_env` function retained CR from CRLF and removed LF in a disposable container probe.
Local administrator files therefore require exact bytes without CR or LF, unlike application password files.
All-Docker preparation now rejects LF/CRLF in either reused local administrator file before database startup.
The focused preparation test verified that rejected credential bytes remained unchanged and generated files contained no terminator.
Profile tests and deployment lint passed. Kubernetes local administrator Secrets require the same exact-byte constraint.
