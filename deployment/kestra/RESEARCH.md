# CC-5 Kestra qualification research

Checked 2026-09-08 against Kestra primary sources. This note supports runtime qualification. It does not replace execution evidence.

## Recommended qualification target

Use Kestra Open Source `v1.3.37` as the CC-5 target. GitHub records release commit `035a5b3` and the 1.3.37 changelog. The release belongs to the 1.3 LTS line. Kestra states that 1.3 receives one year of fixes. Pin the exact image digest. Do not use `latest`, `latest-lts`, or `v1.3` in release configuration. [Kestra 1.3.37 release](https://github.com/kestra-io/kestra/releases/tag/v1.3.37) [Kestra 1.3 release](https://kestra.io/blogs/release-1-3) [Release policy](https://kestra.io/docs/releases)

The target image is `kestra/kestra:v1.3.37-no-plugins`. Docker Hub supplies Linux amd64 and arm64 variants. The registry resolved the index to `sha256:a36e82403b6a6908bc96bfc6cdac10139ff0ba144235999bbe0264a8c45d05f9`. The qualified linux/amd64 manifest is `sha256:c9e6551c671d8e13274b85f3ccafb945065b8e35e33cf2ea3eeff817d52e7114`. [Docker Hub tag metadata](https://hub.docker.com/r/kestra/kestra/tags?name=v1.3.37-no-plugins)

The standard image bundles independently released plugins. The target image contains 107 core plugins and zero external plugin groups. The core artifact reports version 1.3.37. Its SHA-256 checksum is `2a715bab22f2f6986debef9971f2529eff7394765662d8bf1b4d81d89e175c26`. Do not install plugins automatically during Phase 1. [Docker image variants](https://kestra.io/docs/installation/docker) [Plugin compatibility policy](https://kestra.io/docs/releases)

CC-5 needs only built-in core tasks.
The target includes Sleep, Log, HTTP Request, and Storage Write under core version 1.3.37.
Future external plugins require separate version and digest qualification.

## Edition and license

Select the Open Source edition. The tagged source contains the Apache License 2.0. The license grants copyright and patent rights. Distribution requires a license copy, retained notices, and change notices for modified files. The license provides no trademark permission or warranty. Preserve the upstream license and NOTICE material in any redistributed image or bundle. [Kestra v1.3.37 license](https://github.com/kestra-io/kestra/blob/v1.3.37/LICENSE)

This choice adds no Kestra commercial license dependency. OSS supplies shared Basic Auth. OIDC, SSO, service accounts, RBAC, worker groups, Kafka, and Elasticsearch deployment features belong to Enterprise features. Do not claim those features for this target. [Open Source and Enterprise comparison](https://kestra.io/docs/oss-vs-paid)

## Supported topology decision

Use the OSS JDBC architecture in all three Campus Commander profiles:

| Profile       | Kestra processes                    | Repository and queue                  | Internal storage                               | Decision                                      |
| ------------- | ----------------------------------- | ------------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| All Docker    | One `server standalone` container   | Dedicated Kestra PostgreSQL database  | Persistent local volume mounted at one path    | Supported candidate                           |
| Hybrid Docker | Retained local standalone container | District PostgreSQL over verified TLS | District shared filesystem mounted at one path | Supported candidate after cross-host evidence |
| Kubernetes    | One standalone pod                  | Dedicated Kestra PostgreSQL database  | ReadWriteMany persistent volume                | Supported candidate after cluster evidence    |

The v1.3.37 Compose source configures PostgreSQL for both repository and queue. It mounts `/app/storage` as local internal storage. It runs `server standalone`. It also assigns six minutes for container shutdown because Kestra defaults to a five-minute termination grace period. [Tagged v1.3.37 Compose file](https://github.com/kestra-io/kestra/blob/v1.3.37/docker-compose.yml)

Kestra requires compatible repository and queue implementations. PostgreSQL can supply both through JDBC. Kestra stores task outputs, namespace files, and execution artifacts in internal storage. Every component that needs those files must reach the same backend. Local storage works for one process with a persistent volume. Distributed processes require a shared filesystem or object storage. [Runtime and storage configuration](https://kestra.io/docs/configuration/runtime-and-storage)

Campus Commander should keep one Kestra process in Phase 1. This avoids an unsupported high-availability claim. A district can place PostgreSQL and storage outside the Docker host without moving Kestra. Kubernetes runs the same standalone topology in one pod. Pod rescheduling requires persistent PostgreSQL and ReadWriteMany storage.

Current Kestra documentation describes separate scaled server components and worker-controller gRPC. That documentation now targets Kestra 2.0. It does not qualify split-component behavior for 1.3.37. Do not adopt the current multi-component example without a tagged 1.3.37 test. [Current deployment architecture](https://kestra.io/docs/architecture/deployment-architecture) [Current Kubernetes installation](https://kestra.io/docs/installation/kubernetes)

## Authentication and first startup

Every OSS instance requires Basic Auth. A fresh instance without configured credentials exposes `/ui/main/setup`. The first visitor can create credentials. Kestra stores setup credentials in the database under `kestra.server.basic-auth`. Configuration-file credentials override stored setup values. The API accepts HTTP Basic Authorization. The UI uses an authentication cookie. [Basic Auth troubleshooting](https://kestra.io/docs/administrator-guide/basic-auth-troubleshooting)

Campus Commander must inject a unique username and strong password before the first process starts. Do not expose the setup page. Store both values through the profile secret mechanism. Protect port 8080 behind the internal network. Keep management port 8081 internal. Kestra documents that management endpoints are unauthenticated by default. [Security hardening](https://kestra.io/docs/administrator-guide/security-hardening)

CC-5 evidence should show these redacted results:

1. Startup succeeds with the injected credential references.
2. An unauthenticated API request returns an authentication failure.
3. A request with wrong credentials returns an authentication failure.
4. An authenticated API request returns server or flow data.
5. Restart preserves authenticated access through the same secret references.
6. Logs and captured commands contain no secret value.

## Runtime settings and connectivity

Use this configuration shape for the selected edition. Verify exact key spelling by starting v1.3.37.

```yaml
datasources:
  postgres:
    url: jdbc:postgresql://KEStra_DB_HOST:5432/KEStra_DB_NAME
    driverClassName: org.postgresql.Driver
    username: KESTRA_DB_USER
    password: KESTRA_DB_PASSWORD
kestra:
  server:
    basic-auth:
      username: KESTRA_ADMIN_EMAIL
      password: KESTRA_ADMIN_PASSWORD
    termination-grace-period: 5m
  repository:
    type: postgres
  queue:
    type: postgres
  storage:
    type: local
    local:
      base-path: /app/storage
  anonymous-usage-report:
    enabled: false
  ui-anonymous-usage-report:
    enabled: false
```

Replace the uppercase placeholders through secret resolution. Do not commit their values. Use the dedicated Kestra database and role. Kestra owns its schema migrations. Application code must not query this database.

The Kestra process needs TCP access to its PostgreSQL endpoint and read-write access to `/app/storage`. The API needs authenticated HTTP access to Kestra. The webserver and management interfaces need no public host ports. Workers invoked through HTTP need an internal HTTPS endpoint and dispatch credential. The flow needs only that worker endpoint. Campus Commander independent workers are application services. They are not Kestra server-worker processes.

Internal storage remains separate from Campus Commander application artifacts. Persist both PostgreSQL and `/app/storage` across container or pod replacement. Mount the same storage directory after every restart. Distributed storage needs cross-host read-write evidence.

## Telemetry policy

Disable both anonymous usage streams for district installations. Server telemetry and browser telemetry default to enabled. They use separate settings. The server report includes host resources, a machine fingerprint, installed plugins, flow counts, execution counts, version, timezone, environment, start time, and URL. [Anonymous usage reporting](https://kestra.io/docs/administrator-guide/usage)

Set both fields before first startup:

```yaml
kestra:
  anonymous-usage-report:
    enabled: false
  ui-anonymous-usage-report:
    enabled: false
```

Record startup configuration and an outbound-network observation. The configuration alone does not prove that the selected image emitted no report before startup completed.

## Restart persistence and synthetic execution

Official documentation says worker jobs use at-least-once resubmission after worker failure. The default strategy waits through another termination grace period. A resubmitted task can show multiple attempts. This behavior permits duplicate external effects. [Server lifecycle and recovery](https://kestra.io/docs/administrator-guide/server-lifecycle)

CC-5 must measure behavior on v1.3.37. Use a synthetic flow with these properties:

- Write a start marker and execution ID to Kestra internal storage.
- Sleep longer than the stop interval.
- Write a completion marker.
- Stop the Kestra process with the documented grace period.
- Start the same image with the same database and storage volumes.
- Poll the same execution until it reaches a terminal state.
- Record task attempts, state history, marker checksums, and duplicate markers.

Run a second test with forced termination after the start marker. Record whether the task resumes, restarts, or stays running. Never describe task resubmission as exactly-once execution. The Process task runner restarts a task from the beginning after worker interruption. It does not resume the child process. [Process task runner interruption](https://kestra.io/docs/task-runners/types/process-task-runner)

The official v1.3.37 Compose file preserves PostgreSQL and internal storage in named volumes. `docker compose stop` should retain both volumes. `docker compose down --volumes` erases them. CC-5 must capture volume inventory before and after stop and restart.

## Unresolved qualification items

- Qualify any future external plugin before adding it to the target image.
- Recheck all configuration keys when changing the Kestra version.
- Run the forced-interruption variant. CC-5 measured graceful shutdown with forced worker termination.
- Prove the hybrid shared mount from the actual Kestra host.
- Prove Kubernetes pod rescheduling against the selected ReadWriteMany storage class.
- Measure PostgreSQL connections and pool settings before setting resource limits.
- Record the 1.3 LTS support end date from a Kestra source that states an exact date. The available sources state a one-year support period.
