# Phase 1 deployment configuration

CC-4 defines configuration and validation for all Docker, hybrid Docker with district servers, and enterprise Kubernetes.
This contract covers startup behavior only. Phase 2 supplies application authentication, the shell, and protected utilities.
Google credentials, entity contracts, and district capacity guarantees remain outside CC-4.

## Runtime implementation

CC-5 through CC-20 extend this contract with runtime services, deployment profiles, recovery tools, and release gates.
[Implementation status](implementation-status.md) records completed checks and outstanding acceptance requirements.
Use the ticket evidence in `deployment/evidence/` to distinguish local fixtures from district qualification.

- [Application images](images/README.md) and [Kestra qualification](kestra/README.md).
- [PostgreSQL isolation](postgres/README.md), [Redis behavior](redis/README.md), and [artifact storage](storage/README.md).
- [HTTPS bootstrap](bootstrap/README.md), [all-Docker profile](profiles/all-docker/README.md), and [Kubernetes profile](kubernetes/README.md).
- [Encrypted backup and restore](operations/README.md).
- [Fault qualification](qualification/README.md) and [release verification](release/README.md).

## Contract and commands

[The schema](src/lib/deployment.ts) defines `DeploymentConfig`, `DeploymentProfile`, and `SecretReference` through Zod type inference.
`parseDeploymentConfig(unknown)` returns validated configuration or throws `DeploymentConfigurationError` with field paths and fixed messages.
Every object rejects unknown fields. Validation never resolves a secret reference or opens a service connection.
The CLI exits with status 1 for missing files, malformed JSON, missing settings, or contradictory settings.

Run these commands from the repository root with the workspace Node runtime and installed npm dependencies:

```sh
npm exec nx run-many -- -t build,typecheck,lint,test,validate-examples -p deployment
npm exec nx run deployment:validate -- --args="deployment/examples/hybrid.json"
```

The build produces `dist/deployment/cli.js` and TypeScript declarations.
The test target builds the CLI before testing its exit status and output.
The `validate` target disables caching for district configuration. The `validate-examples` target validates the complete release profile set.
Future installers must run validation before secret resolution, migrations, or service startup. P1-T13 implements that installer integration.
A successful result establishes configuration consistency. It does not establish connectivity, certificate trust, secret availability, or runtime health.

## Examples

| Profile    | File                                        | Worker hosts | Application images                       |
| ---------- | ------------------------------------------- | -----------: | ---------------------------------------- |
| All Docker | [all-docker.json](examples/all-docker.json) |            1 | Common frontend, API, and worker digests |
| Hybrid     | [hybrid.json](examples/hybrid.json)         |            2 | Same digests                             |
| Kubernetes | [kubernetes.json](examples/kubernetes.json) |            2 | Same digests                             |

Example registry names and digests are synthetic fixtures. They do not identify published images.
P1-T03 builds the application images. P1-T16 replaces fixture digests with identical, verified release artifacts across all three profiles.
`validateProfileSet` rejects missing profiles, duplicate profiles, and differing application images.
The `components` field records pending qualification. P1-T02 qualifies Kestra edition, version, licensing, and topology.
P1-T03 and P1-T16 qualify and pin PostgreSQL, Redis, edge, application runtime, and platform versions before release.
The examples do not select a Kestra edition or claim full availability.

## Fields and rules

| Fields                                        | Contract                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`, `phase`                      | Both equal 1. Incompatible extensions require a contract revision.                                                               |
| `profile`                                     | `all-docker`, `hybrid`, or `kubernetes`.                                                                                         |
| `host`                                        | Linux, amd64, and a positive worker-host count. Other architectures require image qualification and a contract revision.         |
| `images`                                      | One digest reference for each application service. Runtime placement does not select a different image.                          |
| `services.*.placement`                        | `local` supplies replicas and resources. `external` supplies the district operator.                                              |
| `services.*.endpoint`                         | Service origin without URL credentials, query strings, fragments, or paths. Database names have separate fields.                 |
| `endpoint.tls`                                | Disabled transport, system CA verification, or private CA verification with a secret reference. No insecure verification bypass. |
| `services.*.serverTls`                        | Certificate and private-key references for each local TLS listener. External and plaintext listeners must omit this field.       |
| `services.*.health`                           | Probe protocol, HTTP path when applicable, interval, timeout, startup grace, and failure threshold.                              |
| `placement.resources`                         | Positive integer CPU millicores and memory MiB requests and limits. Requests never exceed limits.                                |
| `persistence`, `artifacts`, `internalStorage` | Backend kind, absolute persistent location, capacity GiB, and accountable operator.                                              |
| Database fields                               | Separate database name, owning role, password reference, migration owner, and persistence declaration.                           |
| Secret fields                                 | File references under `/run/secrets/` for Docker. Kubernetes Secret name and key for Kubernetes.                                 |
| `services.redis.restartPolicy`                | `discard-cache`. Redis restart invalidates caches and sessions. PostgreSQL remains authoritative.                                |
| `services.edge.access`                        | `bootstrap-only`. Edge and API reference the same temporary bootstrap credential.                                                |

`local` means a service managed by the installation runtime. It means Compose containers or Kubernetes workloads, depending on the profile.
`external` means a district-managed service reached through an explicit endpoint. Its operator owns resources, backups, patching, and monitoring.
All Docker requires local services, one worker host, and local artifacts. Hybrid requires at least one external service.
Frontend, API, and workers always use the selected installation runtime. Workers require an endpoint separate from the API.
Stateful local services use one replica until separate replication qualification exists.
Worker replicas must cover the declared worker-host count. This count describes placement, not capacity.

The HTTPS edge, external endpoints, and all endpoints in distributed profiles require verified TLS.
A single-host container network permits disabled internal transport. The edge still requires browser-trusted HTTPS.
PostgreSQL uses the `postgresql` URL scheme with separate TLS settings. Redis uses `rediss` with verified TLS.
HTTP services use `https` with verified TLS. Local listeners require certificate and private-key references in `serverTls`. Runtime adapters must install those certificates.
P1-T08 and P1-T09 implement listener certificates, internal authentication, bootstrap enforcement, and certificate verification.
The contract supplies references for Kestra authentication, worker dispatch authentication, database passwords, and Redis authentication.

Local PostgreSQL and Redis locations become named volumes in Compose or persistent volume claims in Kubernetes.
Kubernetes local volumes must survive pod rescheduling through the district storage class. Ephemeral volumes do not satisfy this contract.
External-managed locations identify operator-maintained storage in the district inventory. The installer must not create or delete that storage.
Distributed artifact consumers require a shared filesystem. Every consumer must mount the same backend at the declared location.
Distributed local Kestra also requires shared internal storage. Its directory tree must remain separate from application artifacts.
An external Kestra operator owns internal-storage accessibility and persistence. P1-T08 verifies that declaration.

## Service placement evidence

The example validation command reads these placements directly from all three JSON files.
Local services belong to the installation operator. External services belong to the named district operator.

| Service or storage      | All Docker                       | Hybrid example                           | Kubernetes example                 | Logical owner                    |
| ----------------------- | -------------------------------- | ---------------------------------------- | ---------------------------------- | -------------------------------- |
| HTTPS edge              | Local Compose                    | Local Compose                            | Local cluster edge                 | Installation operator            |
| Frontend                | Local Compose                    | Local Compose                            | Local Deployment                   | Frontend startup                 |
| API                     | Local Compose                    | Local Compose                            | Local Deployment                   | API startup                      |
| Independent workers     | Local Compose, one host          | Local Compose, two hosts                 | Local Deployment, two hosts        | Worker runtime                   |
| Application PostgreSQL  | Local Compose                    | District PostgreSQL                      | Local stateful workload and PVC    | Application installer migrations |
| Kestra PostgreSQL       | Separate local Compose service   | Separate database on district PostgreSQL | Separate stateful workload and PVC | Kestra migrations                |
| Redis                   | Local Compose and volume         | District Redis                           | Local stateful workload and PVC    | Cache operator                   |
| Kestra                  | Local Compose                    | Local Compose                            | Local workload, one replica        | Orchestration operator           |
| Application artifacts   | Persistent local volume          | District shared filesystem               | Shared filesystem PVC              | Storage operator                 |
| Kestra internal storage | Separate persistent local volume | Separate shared directory tree           | Separate shared filesystem PVC     | Orchestration operator           |

Application and Kestra databases require different names, roles, and password references, even on separate PostgreSQL servers.
The application installer runs application migrations once before application services start.
Kestra manages only its own migrations. Application code must not query or migrate Kestra metadata.
P1-T04 enforces database grants, one-time migration coordination, and failure behavior against real PostgreSQL.

## Host, cluster, and network assumptions

The contract targets Linux amd64 hosts with time synchronization, persistent storage, district DNS, and certificate trust.
Docker hosts require Docker Engine and Compose with secret mounts, health checks, and resource-limit support.
Hybrid hosts require mutually reachable service DNS names and district-operated TLS endpoints.
Kubernetes requires district-operated scheduling, namespace isolation, Secret access controls, service discovery, and HTTPS edge integration.
It also requires persistent volume provisioning and a shared filesystem backend with cross-node read/write access.
The installer must verify those capabilities and exact versions before startup. CC-4 does not certify a Docker or Kubernetes version.
Other operating systems and image architectures remain unqualified.

| Source                   | Destination                         | Required path and purpose                                                  |
| ------------------------ | ----------------------------------- | -------------------------------------------------------------------------- |
| District browser         | HTTPS edge                          | TCP 443, trusted district hostname, bootstrap-protected startup page       |
| HTTPS edge               | Frontend and API                    | Configured HTTP(S) origins, startup page and API startup requests          |
| API and workers          | Application PostgreSQL              | Configured PostgreSQL port, application state and synthetic startup checks |
| API and workers          | Redis                               | Configured Redis port, authenticated cache access                          |
| API                      | Kestra                              | Configured HTTP(S) origin and authentication, orchestration submission     |
| Kestra                   | Independent workers                 | Configured HTTP(S) origin and dispatch authentication                      |
| Kestra                   | Kestra PostgreSQL                   | Configured PostgreSQL port, Kestra metadata and migrations                 |
| API and workers          | Artifact filesystem                 | Read/write mount access to the same backend                                |
| Kestra storage consumers | Kestra internal filesystem          | Separate read/write mount access                                           |
| Runtime health checker   | Each service                        | Declared probe protocol and HTTP path, using the service TLS policy        |
| Installation hosts       | District DNS, time source, registry | Name resolution, time synchronization, and verified image retrieval        |

Only the HTTPS edge receives browser traffic.
All-Docker keeps databases, Redis, Kestra, and workers on internal container networks.
Hybrid worker hosts publish their TLS listener on the declared private district interface for controller and Kestra access.
District firewalls must restrict that listener to the declared consumers. A private bind address does not establish a firewall allowlist.
Kubernetes NetworkPolicy and district firewalls must restrict internal paths to the named consumers.
The installer does not administer or certify an external district firewall. Record firewall verification during infrastructure qualification.
Shared filesystem ports depend on the district backend. P1-T07 records those ports and validates cross-host access.
Phase 1 requires no Google egress or Google credentials.
The example resource values are synthetic startup allocations. They do not establish minimum hardware or district workload capacity.
P1-T15 records measured requests, limits, disk requirements, and failure behavior.

## Configuration decision D-CC-4, 2026-09-06

Adopt one strict JSON contract with TypeScript types inferred from its runtime schema.
Keep the module independent of Angular and NestJS. This permits reuse by installers, API startup, and worker startup.
Use explicit placement instead of deriving placement from empty endpoints or environment-variable precedence.
Reject contradictory configuration before any startup side effect. Return fixed messages without retaining input values in errors.

Adopt shared filesystem configuration as the distributed example backend under R07. P1-T07 must qualify its actual adapter and cross-host behavior.
Keep application artifacts separate from Kestra internal storage. P1-T08 qualifies Kestra storage independently.
Preserve R19 through one application image set. Preserve R24 through three continuously validated profiles.
Retain secret references only. Runtime adapters resolve references after validation and fail when secrets or trust material are unavailable.

This decision defines the contract. It does not close runtime qualification gates or declare Phase 1 operational.
See [CC-4 validation evidence](evidence.md), [architecture](../docs/portfolio/03-architecture.md), and [decision register](../docs/portfolio/05-decisions-and-open-questions.md).

## Credentials

Store district configuration in ignored `deployment/local/`. Store credential files in ignored `secrets/` or an external secret manager.
Create Kubernetes Secrets outside tracked manifests. A base64-encoded Secret value remains a credential.
Never place passwords, tokens, private keys, or Google credentials in JSON profiles, image references, or endpoint URLs.
Do not pass secret values through CLI arguments. The validator needs references only.
The existing `.env` and `secrets/` ignore rules remain active. Example profiles contain synthetic references and no credential values.
