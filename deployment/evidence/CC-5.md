# CC-5 Kestra qualification evidence

Checked 2026-09-08 on Linux amd64 with Docker Engine 29.7.2.
The isolated runtime used Kestra Open Source 1.3.37 and PostgreSQL 18.6.

## Acceptance results

| Acceptance criterion                                            | Result                  | Evidence                                                                        |
| --------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| Record version, plugins, digest, edition, license, and topology | Met                     | `runtime.json`, `profile-requirements.json`, and `README.md`                    |
| Prove first-run credentials and authenticated access            | Met                     | `synthetic-restart-result.json` records initialized Basic Auth and HTTP results |
| Identify repository, queue, storage, and worker paths           | Met                     | `profile-requirements.json` and `README.md`                                     |
| Stop and restart a synthetic execution                          | Met for isolated Docker | Execution `jgJtMKnO2LSIgSlqGkHIM` reached `SUCCESS` after task resubmission     |
| Apply an explicit anonymous usage policy                        | Met by configuration    | Both anonymous usage settings are false                                         |
| Avoid commercial and high availability claims                   | Met                     | Open Source edition and one replica selected                                    |

## Runtime inventory

The registry resolved `v1.3.37-no-plugins` to this OCI index:

`sha256:a36e82403b6a6908bc96bfc6cdac10139ff0ba144235999bbe0264a8c45d05f9`

The qualified Linux amd64 manifest is:

`sha256:c9e6551c671d8e13274b85f3ccafb945065b8e35e33cf2ea3eeff817d52e7114`

`/app/kestra --version` returned `1.3.37`.
The core artifact checksum was `2a715bab22f2f6986debef9971f2529eff7394765662d8bf1b4d81d89e175c26`.
Startup registered 107 core plugins and zero external plugin groups.

Temporary core documentation generation found these required task classes:

- `io.kestra.plugin.core.flow.Sleep`
- `io.kestra.plugin.core.http.Request`
- `io.kestra.plugin.core.log.Log`
- `io.kestra.plugin.core.storage.Write`

The selected image carries the `Apache-2.0` OCI license label.
The tagged source contains the Apache License 2.0 text.
No Enterprise image, license, or feature appears in this decision.

## Redacted startup and authentication

The harness generated unique credentials in memory and temporary files.
It recorded no username, password, authorization header, or database password.
The machine result reports `basicAuthInitialized: true`.

The read-only readiness route was `GET /api/v1/main/flows/search?size=1`.
It returned 401 without credentials.
It returned 401 with wrong credentials.
It returned 200 with valid credentials.
It returned 200 again after restart.

Authenticated flow upload returned 200.
The test used no browser setup page.
This proves configuration-driven credentials on the first database startup.

## Synthetic restart result

[`synthetic-restart-result.json`](../kestra/synthetic-restart-result.json) records the complete redacted result.
The harness started execution `jgJtMKnO2LSIgSlqGkHIM` at 2026-09-08T05:08:52Z.
It observed `RUNNING` before stopping Kestra.
It restarted the same container with the same PostgreSQL and internal-storage volumes.

Kestra forced the active worker thread to stop after the three-second grace period.
The restarted process resubmitted the Sleep task.
That task reached `SUCCESS` after two attempts.
The following Log task reached `SUCCESS` after one attempt.
The execution reached `SUCCESS` at 2026-09-08T05:09:31Z.

The database schema remained at version 1.57 after restart.
Kestra found no pending migration.
The volume names remained identical across stop and restart.
The harness removed the temporary volumes after recording evidence.

This result proves one bounded standalone recovery path.
It does not prove exactly-once execution or external-effect safety.
The V0 duplicate-dispatch findings still require durable worker deduplication.

## Telemetry policy

The installation policy disables both anonymous usage streams.
The configuration sets `kestra.anonymous-usage-report.enabled` to false.
It sets `kestra.ui-anonymous-usage-report.enabled` to false.
It also disables tutorial flow loading.

The test confirmed that the selected configuration started twice.
It did not capture outbound packets.
Network-level telemetry verification remains open.

## Renderer checks

The plaintext renderer check passed.
It produced a mode 0600 configuration inside a mode 0700 directory.

The TLS renderer check passed.
It produced a valid PKCS12 keystore from PEM certificate and key files.
It produced a valid worker truststore from a private CA file.
The configuration, keystores, probe header, and secret files used mode 0600.
The renderer rejected distributed plaintext through its explicit profile rule.

The selected image HTTPS listener check passed on port 8080.
Authenticated readiness returned 200 through the synthetic certificate.
Unauthenticated readiness returned 401.
[`tls-listener-result.json`](../kestra/tls-listener-result.json) records this result.
District certificate integration remains untested.

## PostgreSQL observation

Kestra applied 53 migrations through schema version 1.57 on PostgreSQL 18.6.
It validated that schema again after restart.
No database failure occurred during the synthetic execution.

Kestra logged this warning on both starts:

> Flyway upgrade recommended: PostgreSQL 18.6 is newer than this version of Flyway and support has not been tested. The latest supported version of PostgreSQL is 17.

This result establishes measured compatibility for the tested path.
It does not establish vendor-certified PostgreSQL 18 support.
The database qualification must retain this limitation.

## Unmet profile evidence

- No second host or district shared mount was available for hybrid storage verification.
- No district Kubernetes context was available for shared-storage qualification.
  Later CC-15 evidence records synthetic Kind rescheduling without district RWX qualification.
- No district certificate was available for district trust verification.
- No packet capture verified telemetry suppression.
- The forced process-kill variant did not run.
- The test did not measure the five-minute production shutdown period.
- Kestra sources did not state an exact 1.3 LTS support end date.
- Connection pool sizing and resource limits remain unqualified.

These gaps block claims about distributed recovery, Kubernetes recovery, and high availability.
They do not change the one-replica Phase 1 topology decision.

## Sources

- [Kestra 1.3.37 release](https://github.com/kestra-io/kestra/releases/tag/v1.3.37)
- [Kestra v1.3.37 Compose file](https://github.com/kestra-io/kestra/blob/v1.3.37/docker-compose.yml)
- [Kestra v1.3.37 license](https://github.com/kestra-io/kestra/blob/v1.3.37/LICENSE)
- [Kestra Docker image variants](https://kestra.io/docs/installation/docker)
- [Kestra runtime and storage](https://kestra.io/docs/configuration/runtime-and-storage)
- [Kestra Basic Auth troubleshooting](https://kestra.io/docs/administrator-guide/basic-auth-troubleshooting)
- [Kestra anonymous usage reporting](https://kestra.io/docs/administrator-guide/usage)
- [Kestra SSL configuration](https://kestra.io/docs/administrator-guide/ssl-configuration)
- [Kestra Open Source secrets](https://kestra.io/docs/concepts/secret)
- [CVE-2026-49869 advisory](https://github.com/kestra-io/kestra/security/advisories/GHSA-5vc5-wxxq-3fjx)
- [CVE-2026-34612 advisory](https://github.com/kestra-io/kestra/security/advisories/GHSA-365w-2m69-mp9x)
