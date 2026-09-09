# Hybrid profile

The hybrid renderer starts only services with local placement. It never starts a replacement for an external service.

The checked example uses district PostgreSQL and Redis. It keeps local frontend, API, Kestra, edge, and worker processes.

## Supported placement matrix

| Component                         | Local placement                                 | External placement                                           |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| Frontend, API, edge               | Required                                        | Rejected by the deployment contract                          |
| Application and Kestra PostgreSQL | Supported together on one application host      | Supported together                                           |
| Redis                             | Supported with verified TLS                     | Supported with verified TLS                                  |
| Kestra                            | Supported with host-prepared TLS files          | Supported with verified TLS                                  |
| Workers                           | Supported through one Compose fragment per host | Rejected by the deployment contract                          |
| Artifacts                         | Shared filesystem required                      | External managed storage rejected by the deployment contract |

Mixed local and external PostgreSQL ownership is unsupported. The installer cannot provision one database without administering the other.

Distributed workers require district PostgreSQL. The profile does not expose a local PostgreSQL listener across hosts.

External Kestra requires district PostgreSQL. This prevents a district service from depending on an unexposed local database.

## Prepare and render

Create the shared artifact and Kestra directories first. UID 1000 requires read, write, and search access.

Run the host preparation command before starting local Kestra:

```sh
node deployment/profiles/hybrid/prepare.mjs deployment/examples/hybrid.json /absolute/installation-directory
```

The host requires Node, OpenSSL, and Java `keytool`. Preparation writes protected Kestra runtime files under `runtime/kestra`.

Render the controller and worker host files through Nx:

```sh
CC_WORKER_BIND_ADDRESSES=10.20.30.41,10.20.30.42 npm exec nx -- run deployment:hybrid-render --args="deployment/examples/hybrid.json release.json /absolute/installation-directory/docker-compose.yml"
```

The renderer writes one `docker-compose.worker-N.yml` file for each worker host. Each address must name a non-loopback district interface.

Install the controller file on the application host. Install each worker file and the same protected runtime profile on its declared host.

Configure district DNS for the worker endpoint across all worker addresses. Permit its port only from Kestra and authorized diagnostics.

The `egress` network serves district endpoints. Enforce the configured PostgreSQL, Redis, Kestra, and worker allowlist in the host firewall.

The `ingress` network accepts the published edge HTTPS listener.
Restrict the edge host port to approved district clients through the host firewall.
Keep every other controller port unpublished.

## Readiness contract

The storage preflight checks UID 1000 access without changing ownership. Database migration completes before bootstrap initialization.

Application image health checks validate TLS names and configured certificate authorities. API readiness then validates every external endpoint.

Keep service provisioning separate from credentials and runtime configuration. The district operator owns external service provisioning.

Static rendering does not qualify separate-host storage behavior. Complete the two-host artifact procedure before advertising distributed support.

## Bounded runtime qualification

Run the isolated TLS integration through Nx:

```sh
npm exec nx -- run deployment:hybrid-integration --skip-nx-cache
```

The check prepares local Kestra runtime files and starts three temporary containers.
It runs Kestra, one worker, and simulated district PostgreSQL.
It verifies private-CA TLS, authentication, a synthetic execution, and PostgreSQL outage recovery.
It removes every temporary container, network, volume, and file.

The recorded run recovered three seconds after PostgreSQL restarted.
The completed execution and Kestra internal-storage files remained available.
The run used one Docker host and synthetic certificates.
It does not qualify the complete profile or distinct-host shared storage.

Run the complete same-host fixture through Nx:

```sh
npm exec nx -- run deployment:hybrid-full-integration --skip-nx-cache
```

Set `CC_HYBRID_KEEP_FIXTURE=true` to retain the unique fixture for restore testing.
The default run removes only its unique containers, network, volume, and files.

The recorded complete run passed in 61.8 seconds.
It started all eight component containers from the pinned local image set.
The API reported all eight protected dependency checks ready.
The process liveness check also reported ready.
Edge access returned 401 without the bootstrap credential and 200 with it.
Kestra returned 401 without its Basic Auth credential.
The synthetic worker execution reached `SUCCESS` and created internal storage.
Both worker Compose projects read the same shared artifact checksum.
Redis recovered in two seconds, and PostgreSQL recovered in three seconds.
The execution, internal storage, and shared artifact survived both outages.

[`full-integration-result.json`](full-integration-result.json) records the redacted machine result.
This same-host fixture does not qualify separate hosts, district DNS, firewall rules, or shared storage infrastructure.
