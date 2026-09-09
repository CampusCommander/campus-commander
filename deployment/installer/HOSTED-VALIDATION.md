# Hosted installer validation

The public installer passed actual all-Docker, hybrid, and Kubernetes installation tests on 2026-09-09.
These tests used published, signed candidates without registry credentials or a customer source checkout.
Every installation retains `acceptedRelease: false`. This record does not establish production release acceptance.

## Public entry

```sh
curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh | sh
```

The script verifies release signatures, file checksums, and application image signatures before executing release code.
Anonymous verification passed after the package owner enabled public GHCR access.
Node and Cosign downloads used the script's pinned versions and checksums.

| Profile | Signed candidate | Actual result |
| --- | --- | --- |
| All-Docker | `phase-1-candidate-4e1d7caaddc0` | Interactive installation, stop/resume, and interruption recovery passed |
| Hybrid | `phase-1-candidate-3e6a6a67a2c3` | Controller, two remote workers, and stop/resume passed |
| Kubernetes | `phase-1-candidate-3e6a6a67a2c3` | Installation, status, resume, and cross-node artifact reads passed |

The [all-Docker publication workflow](https://github.com/CampusCommander/campus-commander/actions/runs/34357487042) passed.
The [hybrid and Kubernetes publication workflow](https://github.com/CampusCommander/campus-commander/actions/runs/34359354716) also passed.
Installer tests, profile tests, and deployment lint passed before the publications.

## All-Docker

The operator ran the public command interactively in an isolated Ubuntu 24.04 host.
License acceptance, profile selection, candidate acknowledgment, certificate generation, and configuration prompts completed through the terminal.
The command required no answers file. It reported `Readiness: ready` and exited with status 0.

Authenticated HTTPS startup returned HTTP 200 and eight ready checks. Unauthenticated startup returned HTTP 401.
The `/kestra`, `/workers`, and `/api/jobs` paths returned HTTP 404.
Artifact publication and readback preserved 50 bytes with SHA-256 `4e0f5dd6d54c2baa94a2df77352f50f539bd268fb133829a2189673b7f544851`.
The database contained one migration record and one bootstrap record.

The test stopped the project's containers and resumed through the public command.
Resume selected the original verified release and returned ready.
The artifact, migration record, and bootstrap record remained identical.
The test preserved project `cc-hosted-fixed` at `/opt/cc-hosted-fixed` inside `cc-installer-host`.

The test then sent SIGTERM to the installer process group after it recorded `prepared` during resume.
The interrupted process stopped. Its state remained `prepared`, and its lock remained present.
A public resume attempt correctly failed with `BUSY`.
The test confirmed that no installer process remained before removing the empty stale lock.
Public resume then returned ready and preserved the same artifact, migration record, and bootstrap record.
This recovery requires the documented stale-lock procedure. It is not automatic lock recovery.

## Hybrid

The public command configured the controller and paused for remote worker deployment.
The test copied the generated fragments and their required private files to two separate worker hosts.
Both hosts used separate Docker daemons and unchanged worker fragments.
Public resume then returned ready with eight ready checks.

External PostgreSQL and Redis required TLS and authentication.
District fixture DNS resolved the controller, external services, and both worker addresses.
Application containers read staged configuration and credentials as UID 1000 through read-only mounts.
The hosted dependency installer installed the required Java tools.

Authenticated HTTPS startup returned HTTP 200. Unauthenticated startup returned HTTP 401.
The `/kestra`, `/workers`, and `/api/jobs` paths returned HTTP 404.
The API published an artifact. Both remote workers read the same bytes and database records.
The test stopped the controller and resumed through the public command.
Resume returned ready and preserved the artifact, migration record, and bootstrap record exactly.

The test preserved controller project `cc-hosted-hybrid` at `/opt/cc-hosted-hybrid` inside `cc-installer-host`.
Worker hosts `cc-hosted-worker-1` and `cc-hosted-worker-2` remain separate from the controller host.
External services belong to the dedicated `cc-hosted-hybrid-fixture` project.

## Kubernetes

The test followed the [hosted Kubernetes procedure](HOSTED-KUBERNETES-TEST.md) using a dedicated three-node Kind cluster.
It prepared existing private Secrets, verified certificates, and shared storage before running the public command.
The installation used the published signed candidate and required no prerequisite exceptions.
The command exited with status 0 and reported eight ready checks.

Two API replicas and two worker replicas ran across both worker nodes. All four persistent volume claims bound successfully.
The database preparation Job retried during database startup and completed.
The test made no changes to generated application manifests.

Authenticated HTTPS startup returned HTTP 200. Unauthenticated startup returned HTTP 401.
The `/kestra`, `/workers`, and `/api/health/ready` paths returned HTTP 404.
The API published a Unicode artifact. Workers on both nodes read the same artifact through the storage and database interfaces.
Public status and resume commands returned ready.
The artifact descriptor, migration record, and bootstrap record remained identical after resume.

The test preserved cluster `cc-hosted-kube` and its dedicated kubeconfig under `/tmp/cc-hosted-kube-fixture`.
The generated manifest SHA-256 was `6972ad15702f7000f27afc7ba40ec63a80ebc9566236eeeafa4738dac68c3517`.

## Defects found and corrected

An earlier all-Docker attempt configured an artifact path outside the generated storage mount.
Commit `4e1d7caaddc0` retains managed runtime paths for all-Docker storage.
A configuration-to-renderer regression reproduced the defect before the correction.
The subsequent interactive installation and artifact checks passed.

Hybrid configuration and credential files initially retained root ownership in application bind mounts.
Commit `3e6a6a67a2c3` stages those files into private volumes for UID 1000 application users.
Regression tests and runtime probes verified file readability without changing source ownership, modes, or hashes.
The subsequent hosted hybrid installation passed without generated manifest edits.

## Laboratory boundaries

The controller host uses its own Docker data volume and dedicated cgroup parent.
A resource probe reported `memory.max=134217728` and `cpu.max=25000 100000`.
Each remote worker also passed the memory and CPU probe with its own Docker daemon.
The hosts share one physical Docker Desktop machine. These tests do not establish physical host fault tolerance.

All-Docker and hybrid record a qualification exception for the disposable host's absent time service.
Hybrid shared storage uses a dedicated shared volume directory with UID/GID 1000 and mode 700.
This proves access from separate worker daemons. It does not qualify a production network storage provider.
The tests preserve private fixture files and never include credential values in this record.

Kubernetes used shared hostPath backing on one physical host.
The stock Kind network plugin does not establish NetworkPolicy enforcement.
A localhost port-forward supplied HTTPS access instead of a production LoadBalancer.
These hosted checks did not test independent host failure, rescheduling, backup restore, or upgrade.
