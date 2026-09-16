# CC-5 Kestra qualification

CC-5 selects Kestra Open Source 1.3.37 for every Phase 1 profile.
The deployment uses one standalone Kestra process.
PostgreSQL supplies the repository and queue.
The image contains built-in core tasks and no external plugins.

## Runtime inventory

| Item                   | Selection                                                                 |
| ---------------------- | ------------------------------------------------------------------------- |
| Edition                | Kestra Open Source                                                        |
| License                | Apache License 2.0                                                        |
| Version                | 1.3.37                                                                    |
| Image tag              | `kestra/kestra:v1.3.37-no-plugins`                                        |
| OCI index digest       | `sha256:a36e82403b6a6908bc96bfc6cdac10139ff0ba144235999bbe0264a8c45d05f9` |
| Linux amd64 digest     | `sha256:c9e6551c671d8e13274b85f3ccafb945065b8e35e33cf2ea3eeff817d52e7114` |
| Core artifact checksum | `2a715bab22f2f6986debef9971f2529eff7394765662d8bf1b4d81d89e175c26`        |
| Core plugins           | 107 at version 1.3.37                                                     |
| External plugins       | None                                                                      |

Use the Linux amd64 digest in every manifest.
Do not use the tag as the runtime image reference.
Do not install plugins during startup.
Qualify every future external plugin before installation.

The Apache License 2.0 permits redistribution and modification.
Redistribution must include the license and preserve required notices.
Modified files must carry change notices.
The license grants no trademark rights or warranty.

Kestra 1.3.37 includes fixes for CVE-2026-49869 and CVE-2026-34612.
Both advisories list earlier 1.3 releases as affected.
Repeat the security review before changing the runtime version.

## Topology

[`profile-requirements.json`](profile-requirements.json) defines each profile.
All profiles run one `server standalone` process.
This selection makes no high availability claim.

All Docker mounts a persistent local volume at `/app/storage`.
Hybrid mounts the selected district shared filesystem at the same path.
Kubernetes mounts a ReadWriteMany persistent volume at the same path.
Kestra internal storage remains separate from application artifacts.

Every profile uses a dedicated Kestra database and role.
Kestra owns its database migrations.
Application services must not query or migrate the Kestra database.
Distributed profiles require PostgreSQL `sslmode=verify-full` and district CA trust.

Keep ports 8080 and 8081 on internal networks.
Route browser traffic through the Campus Commander HTTPS edge.
Use `GET /api/v1/main/flows/search?size=1` for authenticated readiness.
The selected image returned 200 with valid Basic Auth.
It returned 401 without credentials and with invalid credentials.

## Secret formats

`services.kestra.authSecretRef` resolves to strict JSON.
[`auth-secret.schema.json`](auth-secret.schema.json) defines this format.

```json
{
  "username": "admin@example.invalid",
  "password": "generated secret"
}
```

The username must be an email address.
The password needs eight characters, one uppercase letter, and one digit.
Generate a unique password for every installation.

The Kestra database password reference contains one raw line.
The worker dispatch secret reference also contains one raw line.
Do not place either value in a flow, manifest, or command argument.

Kestra Open Source reads flow secrets from base64-encoded `SECRET_` environment variables.
The renderer writes the worker URL, dispatch secret, and JVM trust settings to `flow-secrets.env`.
Source that protected file before the Kestra launcher starts.
Flows read the value with `{{ secret('CC_WORKER_DISPATCH_TOKEN') }}`.
The renderer writes the worker URL as `ENV_CC_WORKER_BASE_URL`.
Flows read the URL with `{{ envs.cc_worker_base_url }}`.

## Configuration renderer

Run [`render-config.mjs`](render-config.mjs) before Kestra starts.
The renderer reads secret files and writes mode 0600 runtime files.
Set `CC_KESTRA_RUNTIME_DIR` to a mode 0700 secret-backed directory.

| Variable                                | Requirement                                      |
| --------------------------------------- | ------------------------------------------------ |
| `CC_KESTRA_PROFILE`                     | `all-docker`, `hybrid`, or `kubernetes`          |
| `CC_KESTRA_RUNTIME_DIR`                 | Absolute output directory                        |
| `CC_KESTRA_RUNTIME_MOUNT_PATH`          | Output directory path inside the container       |
| `CC_KESTRA_AUTH_FILE`                   | Resolved `authSecretRef` JSON file               |
| `CC_KESTRA_DATABASE_PASSWORD_FILE`      | Resolved database password file                  |
| `CC_KESTRA_DATABASE_URL`                | JDBC PostgreSQL URL without embedded credentials |
| `CC_KESTRA_DATABASE_USERNAME`           | Dedicated Kestra database role                   |
| `CC_KESTRA_URL`                         | Configured Kestra service URL                    |
| `CC_KESTRA_TLS_ENABLED`                 | `true` for hybrid and Kubernetes                 |
| `CC_KESTRA_TLS_CERTIFICATE_FILE`        | Resolved PEM certificate when TLS is enabled     |
| `CC_KESTRA_TLS_PRIVATE_KEY_FILE`        | Resolved PEM key when TLS is enabled             |
| `CC_KESTRA_WORKER_BASE_URL`             | Independent worker base URL for CC-11            |
| `CC_KESTRA_WORKER_DISPATCH_SECRET_FILE` | Worker dispatch secret for CC-11                 |
| `CC_KESTRA_WORKER_CA_FILE`              | Private CA for worker HTTPS trust                |

The renderer converts the certificate and key into a temporary PKCS12 keystore.
It writes the keystore beside `application.yaml` with mode 0600.
Distributed profiles require an HTTPS Kestra URL and HTTPS worker URL.
The renderer creates `probe-header` for authenticated readiness checks.
It creates a PKCS12 truststore for worker private-CA trust.
It writes runtime environment values into `runtime-environment.json`.
Treat every generated file as secret material.

The committed [`application.yaml`](application.yaml) supports the isolated Docker test.
Production profiles must use the renderer.
The renderer disables server telemetry, UI telemetry, and tutorial flow loading.

For Kubernetes, mount runtime files at `/run/kestra-runtime`.
Use `server standalone --config /run/kestra-runtime/application.yaml` as image arguments.
Preserve the image entrypoint and UID/GID 1000.
Map each runtime environment key through an explicit Secret reference.
Do not use broad `envFrom` mappings.

The storage mount at `/app/storage` must allow writes from UID/GID 1000.
Use a compatible storage class or an explicit ownership initialization step.
Do not store application artifacts under `/app/storage`.

## CC-11 worker seam

[`cc11-external-worker.yaml`](cc11-external-worker.yaml) calls an independent worker over HTTPS.
It uses the built-in `io.kestra.plugin.core.http.Request` task with POST.
It writes the redacted response through `io.kestra.plugin.core.storage.Write`.
Both task classes belong to Kestra Core 1.3.37.
They require no external plugin.

Send the dispatch secret in the internal authorization header.
Build that header with `{{ secret('CC_WORKER_DISPATCH_TOKEN') }}`.
Never store the resolved header in flow source or execution output.
Distributed profiles require verified HTTPS to each worker endpoint.

The worker requires these runtime values:

| Variable                      | Requirement                                    |
| ----------------------------- | ---------------------------------------------- |
| `WORKER_DISPATCH_SECRET_FILE` | Absolute path to the raw dispatch secret file  |
| `REQUIRE_TLS`                 | `true` for distributed profiles                |
| `TLS_CERT_FILE`               | PEM server certificate path                    |
| `TLS_KEY_FILE`                | PEM private key path                           |
| `TLS_CA_FILE`                 | Private CA path used by the image health check |

The worker exposes `POST /dispatch/synthetic` for qualification only.
The request must use `application/json` and Bearer authentication.
The body accepts an execution ID, correlation ID, marker, and bounded delay.
The worker rejects unknown fields and payloads above 4096 bytes.
The endpoint computes a deterministic marker checksum.
It performs no shell, domain, or Google operation.

Run the CC-11 checks from the repository root:

```sh
./deployment/kestra/run-database-failure-check.sh
./deployment/kestra/run-external-worker-check.sh
```

The external worker check generated private certificates for an isolated Docker network.
It proved both TLS validation and dispatch authentication.
The check killed the worker during an eight-second synthetic delay.
Kestra retried the dispatch and completed after two attempts.
The execution recovered in 13 seconds within three attempts or 30 seconds.

The check uploaded a namespace marker before restarting Kestra.
The marker checksum remained identical after restart.
The test reused the same PostgreSQL and internal-storage volumes.
It ran every component on one Docker host.
District shared-storage and Kubernetes storage evidence remain open.

Retry provides at-least-once dispatch.
The qualification endpoint keeps no durable deduplication record.
Add durable assignment deduplication before a worker performs external effects.

## Synthetic restart

Run the local qualification from the repository root:

```sh
./deployment/kestra/run-synthetic-restart.sh
```

The harness creates isolated containers, volumes, and a network.
It removes those resources after the check.
It generates temporary credentials and records no secret value.

The test uses a three-second termination grace period.
This keeps the qualification bounded.
Production retains Kestra's five-minute default until shutdown timing qualification.

The measured execution started a 20-second Sleep task.
The harness stopped and restarted Kestra while that task ran.
Kestra resubmitted the task after restart.
The execution finished successfully with two Sleep attempts.

This recovery uses at-least-once task execution.
It does not provide exactly-once external effects.
Workers that perform external effects need durable assignment identity and duplicate rejection.

## Installation policy

Disable both anonymous usage settings before the first process starts.
Keep `kestra.anonymous-usage-report.enabled` false.
Keep `kestra.ui-anonymous-usage-report.enabled` false.
Do not add a commercial license dependency.
Do not raise the Kestra replica count above one under this decision.

See [`RESEARCH.md`](RESEARCH.md) for primary sources.
See [`../evidence/CC-5.md`](../evidence/CC-5.md) for measured results and limitations.
See [`../evidence/CC-11.md`](../evidence/CC-11.md) for external-worker evidence.

## Database recovery probe

Run the focused probe with the pinned PostgreSQL and Kestra images:

```sh
npx nx run deployment:kestra-database-recovery-probe
```

The probe creates a private network and two disposable containers.
It completes a synthetic task, interrupts PostgreSQL, and checks task completion after database recovery.
The recovery bound remains 120 seconds. HTTP 200 responses alone do not establish recovery.
The probe follows the current ephemeral port after Docker restarts Kestra.
It removes its containers, anonymous volumes, and network before reporting success.

The public report is `dist/phase-2-evidence/kestra-database-recovery-probe.json`.
The printed private directory contains JVM thread dumps and command failures.
Do not publish those raw files. The public report contains the private log checksum.

[The shutdown observations](../evidence/CC-36-phase-2-kestra-shutdown-probe.json) record three focused runs.
The five-minute grace runs recovered in 66.5 and 94.0 seconds.
A three-second grace run recovered in 94.3 seconds.
Queue shutdown waits remained visible with both settings.
Production retains the five-minute setting. These observations do not resolve the distributed recovery failure.
