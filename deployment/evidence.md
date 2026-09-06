# CC-4 validation evidence

Date: 2026-09-06. Issue: [CC-4](https://easton-consulting.atlassian.net/browse/CC-4).
Scope: Phase 1 configuration consistency, typed interfaces, secret references, and service placement.
Node 24.19.0, Nx 23.1.0, TypeScript 6.0.3, Zod 4.4.2, and Vitest 4.1.10 supplied the validation runtime.

## Acceptance mapping

| CC-4 criterion                                                              | Evidence                                                                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Host, cluster, architecture, ownership, and network assumptions             | [Contract assumptions and network paths](README.md#host-cluster-and-network-assumptions)                           |
| Endpoint, TLS, secret-reference, persistence, resource, and health settings | [Typed runtime schema](src/lib/deployment.ts) and [field contract](README.md#fields-and-rules)                     |
| Three valid profiles and rejected contradictions                            | [Examples](examples), Nx validation output below, and 59 passing tests                                             |
| Separate application and Kestra database ownership                          | Distinct names, roles, secret references, and migration owners in every profile. Rejection tests cover collisions. |
| Identical application images and explicit qualification work                | `validateProfileSet`, common synthetic digests, and `components.qualification: pending` in all profiles            |
| Phase 1 startup boundary                                                    | [Contract scope](README.md), bootstrap-only access, and Phase 2 authentication boundary                            |
| Service placement matrix                                                    | [Service placement evidence](README.md#service-placement-evidence), produced from the validated examples           |
| Recorded configuration decision                                             | [D-CC-4](README.md#configuration-decision-d-cc-4-2026-09-06), linked from the portfolio decision register          |

## Nx checks

```sh
npm exec nx run-many -- -t build,typecheck,lint,test,validate-examples -p deployment --outputStyle=stream
```

Result: all five deployment targets passed. The test suite passed 59 tests.
Build emitted the CLI and type declarations. Typecheck included the implementation, tests, and Vitest configuration.
Tests covered malformed and missing input, unknown fields, credential redaction, TLS, resources, health probes, placement, storage, and database isolation.
CLI tests verified success output, status 1 on rejection, and omission of invalid input values from diagnostics.

The example validation produced:

```text
VALID all-docker
  frontend: local
  api: local
  workers: local
  applicationDatabase: local
  kestraDatabase: local
  redis: local
  kestra: local
  edge: local
  artifacts: local-volume
  kestraInternalStorage: local-volume
VALID hybrid
  frontend: local
  api: local
  workers: local
  applicationDatabase: external
  kestraDatabase: external
  redis: external
  kestra: local
  edge: local
  artifacts: shared-filesystem
  kestraInternalStorage: shared-filesystem
VALID kubernetes
  frontend: local
  api: local
  workers: local
  applicationDatabase: local
  kestraDatabase: local
  redis: local
  kestra: local
  edge: local
  artifacts: shared-filesystem
  kestraInternalStorage: shared-filesystem
PASS identical application images across all three profiles
```

## Rejected configuration demonstration

Create a temporary copy of the hybrid example with local artifacts and two worker hosts:

```sh
node -e 'const fs = require("node:fs"); const config = JSON.parse(fs.readFileSync("deployment/examples/hybrid.json", "utf8")); config.artifacts.kind = "local-volume"; fs.writeFileSync("/tmp/cc-4-invalid.json", JSON.stringify(config));'
npm exec nx run deployment:validate -- --args="/tmp/cc-4-invalid.json" --outputStyle=stream
```

Observed process exit status: **1**. Observed diagnostic:

```text
artifacts.kind: Distributed artifact consumers require a shared filesystem.
```

The CLI produced no success output. It did not resolve credentials or start services.
The test suite repeats this rejection using an isolated temporary directory.

## Credential checks

```sh
git check-ignore deployment/local/district.json secrets/bootstrap .env
```

Git confirmed that all three paths are ignored.
The examples contain synthetic image references, reserved example domains, and secret references. They contain no credential values.
Unknown password fields, URL credentials, raw secret strings, and invalid secret-reference paths cause rejection.
Tests confirm that error messages and serialized errors omit synthetic credential values.
The district validation target disables Nx caching. Only synthetic example validation uses caching.

## Application build checks

```sh
npm exec nx run-many -- -t build -p api,frontend --outputStyle=stream
npm exec nx run frontend:build -- --outputStyle=stream --verbose
```

The API build passed. The frontend build failed with the existing compiler configuration errors:

- NG4006: Angular rejects `emitDeclarationOnly`.
- TS5069: Declaration-only emission lacks the required declaration or composite setting.
- TS2584: The frontend compilation lacks the DOM library for `console`.

The [V0 technical findings](../docs/validation/v0-2026-09-05/technical-findings.md#1-compiler-and-dependency-qualification) already record these failures.
CC-4 changes no frontend compiler settings or UI behavior. P1-T03 owns application image and compiler qualification.

## Docker host and container check

Docker access succeeded after the host repair on 2026-09-06. Docker commands required execution outside the task sandbox.
These results replace the earlier unavailable-socket result.

```sh
docker info --format 'OS={{.OSType}} Architecture={{.Architecture}} Server={{.ServerVersion}} CPUs={{.NCPU}} MemoryBytes={{.MemTotal}}'
docker compose version
docker image inspect e5957c17f780 --format '{{.Id}} {{.Os}}/{{.Architecture}}'
```

| Check                       | Observed result                                                                |
| --------------------------- | ------------------------------------------------------------------------------ |
| Docker Engine               | 29.7.2                                                                         |
| Docker Compose              | 5.5.0                                                                          |
| Docker host                 | Linux x86_64, 16 CPUs, 33,654,710,272 memory bytes                             |
| Probe image platform        | Linux amd64                                                                    |
| Probe Node runtime          | 22.23.2                                                                        |
| Probe image ID              | `sha256:e5957c17f780a07dd58a0c1350dbb6b06494ce672bd010dcc74122613e72d7e3`      |
| Valid profiles              | All Docker, hybrid, and Kubernetes passed                                      |
| Image consistency           | Identical application image references passed                                  |
| Invalid storage combination | Two worker hosts with local artifacts returned status 1                        |
| Credential redaction        | Embedded URL credentials caused rejection without exposing the synthetic value |
| Complete probe              | Exit status 0                                                                  |

The check used the existing local API image as a Node runtime. It did not start the API application.
The temporary bundle contained compiled deployment files, synthetic profiles, Zod, and tslib from the workspace.
The first bundle omitted tslib. Including that existing runtime dependency resolved the probe failure.
The check imported the public deployment module and executed the compiled CLI inside the container.

The container used these isolation settings:

```text
--rm --network none --read-only --cap-drop ALL
--security-opt no-new-privileges --user 65534:65534
--tmpfs /work:rw,noexec,nosuid,size=32m,mode=1777
--workdir /work --entrypoint /bin/sh
```

A tar stream supplied the temporary bundle. The container had no host mounts, published ports, or credential values.
The container ran the example validation and then tested rejection and credential redaction.
The final output included:

```text
Node v22.23.2 linux/x64
VALID all-docker
VALID hybrid
VALID kubernetes
PASS identical application images across all three profiles
artifacts.kind: Distributed artifact consumers require a shared filesystem.
PASS rejected distributed local artifacts with exit status 1
PASS rejected embedded credentials without exposing values
```

## Runtime limits

The container check establishes validator execution on the observed Docker host and Node runtime.
It does not qualify the probe image as a release artifact or establish complete Compose installation support.
No application service startup, Kubernetes deployment, secret resolution, TLS handshake, or cross-host storage test ran under CC-4.

Example digests do not identify published images. Resource values do not establish supported district capacity.
P1-T02, P1-T03, P1-T04, P1-T07, P1-T08, P1-T09, P1-T13, P1-T15, and P1-T16 retain their runtime qualification work.
