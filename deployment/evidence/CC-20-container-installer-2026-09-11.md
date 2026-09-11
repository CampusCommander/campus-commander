# Container installer validation

The revised installer completed all-Docker installation inside a fresh Ubuntu container on 2026-09-11.
The installer also recovered an existing installation after an outer-container restart and preserved its synthetic fixtures.
These are agent-operated tests. They do not supply the independent human walkthroughs required by CC-20.

## Tested entry and environment

The tests used the local revised `install.sh` with signed candidate `phase-1-candidate-e940f20ab7d5`.
The [machine record](CC-20-container-installer-2026-09-11.json) identifies the final entry script, validation probe, candidate, and observed results.
It records separate entry-script hashes for fresh installation and the subsequent restart corrections.
The published candidate supplied setup and application code. Local setup and preflight changes have separate regression coverage.
The entry script and local improvements remain unpublished at this writing.

Two dedicated `ubuntu:24.04` containers used separate Docker daemons and separate named volumes.
Each outer container had four CPUs, eight GiB memory, privileged nesting, and a private cgroup namespace.
Docker Desktop 29.7.2 hosted them. The installer installed Docker Engine 29.8.0 and Compose 5.5.1 inside them.
The fresh container initially had no Docker, curl, or CA certificate bundle.
The test copied the script and a protected, non-secret answers file into that shell environment.
The first installation command was the installer itself. It installed the missing download tools and Docker packages.

The supported nesting configuration follows [Docker's container requirements](https://hub.docker.com/_/docker).
The installer prepares cgroup delegation using the approach described by [Moby's nesting wrapper](https://github.com/moby/moby/blob/master/hack/dind).
Root access inside an ordinary restricted container cannot grant the outer host's missing nesting capabilities.
A separate restricted-container test printed the required launch command before downloads or package changes.
The installer did not require a VM.

## Observed results

- The fresh installation reached `Readiness: ready` without manual package installation or generated-manifest changes.
- All eight protected startup checks reported `ready`.
- Authenticated HTTPS returned 200. Unauthenticated HTTPS returned 401.
- `/kestra`, `/workers`, and `/api/jobs` returned 404.
- A nested probe enforced 128 MiB memory, one-quarter CPU, and a 32-process limit.
- Artifact publication and readback preserved the Unicode fixture and its SHA-256 checksum.
- Outer-container restart recovery preserved the artifact, migration record, bootstrap record, and configuration.
- The installer used its original verified release during resume.

The container uses its outer host's clock. The test recorded the explicit `time-synchronization` laboratory exception.
The tests did not waive filesystem access, Docker compatibility, resource limits, release integrity, or readiness checks.
The self-signed certificate established probe trust only. It does not establish district browser trust.

## Defects found during development

The first development attempt started Docker but failed to start containers with memory limits.
Docker's default nested cgroup entered threaded mode. The installer now delegates CPU, memory, and process controllers before daemon startup.
It places application containers under a separate workload cgroup.
The preflight now probes enforced resource limits, so a reachable daemon cannot conceal this failure.

A Docker PID file omitted its trailing newline. The recovery script now accepts that valid PID representation.
Stale managed-containerd runtime files also collided with reused process IDs after outer-container restart.
The daemon now uses a runtime directory tied to the outer PID namespace. Durable data remains in `/var/lib/docker`.

Docker restart policies restored Kestra before its PostgreSQL dependency became ready.
After starting the nested daemon, explicit all-Docker resume now invokes the verified stop procedure before ordered startup.
Status requests do not stop application services.
The final recovery passed without a manual service restart.

## Reproduce and inspect

Use the container launch instructions in the [hosted installer guide](../installer/HOSTED.md).
Use a new installation directory and named volumes for a fresh test.
Copy the current entry script into the container when testing unpublished changes.

The installation invocation used these options:

```sh
sh /root/install.sh --release phase-1-candidate-e940f20ab7d5 --profile all-docker --root /root/cc-install --answers /root/answers.json --accept-license --qualification --install-dependencies
```

The answers selected a laboratory certificate, `https://localhost:8443`, and an HTTPS bind address of `0.0.0.0`.
The outer host published that application port on loopback only.
No Docker TCP listener or outer-host Docker socket was exposed inside the installation.

The [validation probe](../installer/container-validation.mjs) uses the existing artifact durability probe.
Run it with the verified Node runtime inside the installation container:

```sh
node container-validation.mjs /root/cc-install seed
```

Restart the outer container, then resume with an empty protected answers file:

```sh
sh /root/install.sh --root /root/cc-install --answers /root/resume.json --accept-license --install-dependencies --command resume
node container-validation.mjs /root/cc-install verify
```

`node` above denotes the verified Node runtime recorded under the installer download directory.
Keep `hybrid-lifecycle-probes.mjs` beside the validation probe.
The probe rejects accepted production installations and creates only a synthetic fixture in the disposable candidate.

## Scope and handoff

This work follows portfolio decisions R19 and R20: retain three deployment profiles, verified images, and resumable installation.
The live validation covers all-Docker inside containers. Hybrid and Kubernetes have profile regression coverage, not new live deployments here.
Password-backed sudo was not exercised in these root-container sessions. The regression suite covers unattended authorization and refusal paths.
The test does not establish independent novice acceptance, production infrastructure qualification, or Phase 1 completion.

The final installer regression suite passed 71 tests through `npm exec nx run deployment:installer-test`.
Deployment lint, shell syntax, and diff whitespace checks passed.

The test containers are `cc-installer-validation-20260911` and `cc-installer-clean-20260911`.
Both applications stopped through the verified lifecycle command. Both outer containers then stopped.
Their named Docker and home volumes retain configuration, private credentials, and synthetic fixtures for inspection.
Do not include those private files in a human walkthrough record.
