# Synthetic fault qualification

CC-18 requires the complete fault matrix for each supported profile.
The process harness covers process interruption and artifact access loss in a disposable all-Docker installation.
Its result cannot qualify the complete profile fault gate.

`runProcessFaults` stops and restarts API, workers, Redis, both PostgreSQL services, and Kestra in sequence.
Each fault requires a ready baseline and verified durable fixtures.
Each recovery has a deadline and repeats the fixture verification.
The harness restores the interrupted service or artifact permissions even when an observation fails.

The harness requires a `cc-fault-*` Compose project and `qualificationOnly: true`.
It rejects fixed container names, external volumes, volumes outside that project, and writable host mounts.
These constraints prevent its fixtures from sharing ordinary installation data.

Provide these observations:

- `observe`: verified HTTPS request to the protected startup endpoint.
- `diagnose`: internal API health through operator container access.
- `verifyFixtures`: application, artifact checksum, and Kestra fixture verification.

`httpsStartup` and `dockerDiagnostics` implement the first two observations.
Application database loss prevents bootstrap authentication.
Internal health still identifies the failed component through the operator's existing container access.
Public edge health retains its minimal status response.

Run `npm exec nx run deployment:qualification-test` for injection boundaries and TLS fault fixtures.
TLS fixtures cover a trusted current certificate, an expired certificate, and a wrong-host certificate.
They create temporary keys and remove them afterward.

## Required profile matrix

| Fault                                               | All-Docker     | Hybrid                   | Kubernetes              |
| --------------------------------------------------- | -------------- | ------------------------ | ----------------------- |
| API, worker, Redis, PostgreSQL, Kestra interruption | Required       | Required where local     | Required where local    |
| External database loss                              | Not applicable | Required where external  | Required where external |
| Artifact backend loss                               | Required       | Required                 | Required                |
| Near-full storage                                   | Required       | Required                 | Required                |
| Invalid or expired certificate                      | Required       | Required                 | Required                |
| Worker moves to another node                        | Not applicable | Cross-host worker checks | Required                |
| Required shared dependency loss                     | Not applicable | Required                 | Required                |

Record fault timing, source revision, image digests, topology, resource measurements, readiness observations, and fixture checksums.
Collect redacted diagnostics through the installer support command.
Never copy raw container environments or authentication headers into evidence.
Record each unexecuted case as `not-run`.

Single-host Docker retains host and local-volume failure points.
The selected Kestra topology has one standalone process.
Kubernetes replicas do not remove shared filesystem, database, or cluster infrastructure failure points.
These fixtures establish no district recovery guarantee.

## Execute a prepared fixture

Prepare an isolated all-Docker installation with the CC-13 synthetic artifact descriptor, Kestra flow, and internal marker.
Copy `fixture.example.json` outside the repository and replace its paths and project name.
Run the fixture through Nx:

```sh
npm exec nx run deployment:qualification-integration -- --args="/absolute/fixture.json /absolute/new-report.json"
```

The command records only synthetic fixture identities, checksums, component states, image references, and resource measurements.
An uncommitted worktree produces a base revision field and an explicit uncommitted-candidate label.

## Bounded storage capacity

`capacity-integration.mjs` creates an isolated PostgreSQL fixture and an eight-megabyte temporary artifact filesystem.
It exhausts only that filesystem, verifies failed publication, restores capacity, and checks the original artifact.
Run it with the pinned API image under test and a new report path:

```sh
npm exec nx run deployment:capacity-integration -- --args="<repository@sha256:digest> /absolute/new-capacity-report.json"
```

The fixture uses private credential files and a loopback-only database port.
It removes its generated container and network after execution.
Its result covers the artifact adapter. It does not qualify a complete deployment profile.
