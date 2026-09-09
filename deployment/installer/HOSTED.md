# Install from a published release

Use a Linux amd64 host. Ubuntu 24.04 and Debian 12 or later support the downloaded Node runtime.
Start with `curl`, CA certificates, `sh`, `tar`, and standard system utilities.
You do not need Git, GitHub CLI, npm, or a source checkout.

Run this command in a terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh | sh
```

The script selects the newest published Phase 1 candidate and verifies its signatures and every inventoried file.
It downloads pinned Node and Cosign binaries when the required versions are absent.
It installs missing Docker packages on Ubuntu or Debian only after you approve the package changes.
Root or sudo access is required for system package installation.
Docker must run on the installation host. A container using another host's Docker socket is not an installation host.

The script requests license acceptance and an installation method.
Guided setup writes private configuration files. You do not edit JSON during interactive installation.
Secret questions request protected file paths. They do not request secret values.

## Current candidate testing

The current releases are candidates, not accepted production releases.
Select `candidate` when asked for the release mode.
Type `candidate-lab` when asked to acknowledge the disposable test installation.
This choice records `acceptedRelease: false`. It does not waive signature verification.

For an all-Docker laboratory installation:

1. Select method `1`.
2. Choose a new private installation directory.
3. Select candidate mode and enter the acknowledgment.
4. Choose `yes` for a self-signed laboratory certificate.
5. Accept `https://localhost:8443` to test from the installation host.
6. Keep the loopback bind and readiness addresses for local testing.
7. Enter only the prerequisite exceptions required by your test environment.
8. Enter a specific reason for each exception.
9. Review the remaining database names, storage capacities, and operator labels.

A disposable container usually lacks a host time service.
Use `time-synchronization` only when that applies to your environment.
The supported exception names are `district-dns`, `time-synchronization`, `storage-capacity`, and `host-memory`.
The `none` choice applies no exceptions. Docker, filesystem, certificate, registry, and architecture checks remain mandatory.

Success reports `ready`, the HTTPS URL, and the private bootstrap credential file path.
The bootstrap credential protects Phase 1 access. It is not a Phase 2 user account.
Keep the credential private. A self-signed laboratory certificate does not establish browser trust.
A loopback-bound URL is accessible from the installation host only.

## Installation methods

| Method     | Prepare before installation                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| All-Docker | Docker access and enough memory and disk for the local services. Supply a certificate for nonlaboratory use.                |
| Hybrid     | External PostgreSQL and Redis, verified TLS files, application and migration credentials, shared storage, and worker hosts. |
| Kubernetes | A reachable cluster, selected context, storage classes, existing Secrets, certificate files, and an HTTPS ingress endpoint. |

Hybrid setup prepares controller and worker Compose files, then pauses for worker deployment.
Follow the printed paths and commands on each worker host.
Transfer only its referenced configuration and credential files through your protected operator procedure.
Enter `yes` only after the worker hosts are ready. Otherwise, resume after completing that work.
The installer does not open remote shells or create district-managed services.

Kubernetes setup uses the named existing context and namespace.
It requests existing Secret names and matching private local files for readiness verification.
It does not create a cluster or replace district-managed Secrets.
Review [Kubernetes preparation](../kubernetes/README.md) and [hybrid preparation](../profiles/hybrid/README.md) before selecting those methods.

## Repeat, resume, and inspect

Use the same installation directory when repeating the command.
Existing configuration and credentials remain authoritative. Repeating installation resumes that installation.
A newly downloaded release does not silently upgrade it.

```sh
curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh |
  sh -s -- --root /opt/campus-commander --command resume
```

Use `--command status` for a readiness report.
Use the original profile when selecting a method during resume or status.
Lifecycle commands and upgrade requirements remain documented in the [installer reference](README.md).

## Automated testing

Automated setup uses an answers file containing the same question keys as interactive setup.
An answers file contains paths to credentials, not credential values.
Protect it with mode `600`.

This example creates a disposable local all-Docker test:

```json
{
  "profile": "all-docker",
  "project": "cc-customer-test",
  "candidateAcknowledgement": "candidate-lab",
  "labCertificate": "yes",
  "publicUrl": "https://localhost:8443",
  "exceptions": "time-synchronization",
  "exceptions.time-synchronization.reason": "This disposable test container has no host time service."
}
```

```sh
curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh |
  sh -s -- --qualification --accept-license --profile all-docker \
    --root /opt/cc-customer-test --answers /protected/answers.json
```

`--accept-license` records your explicit acceptance through the command invocation.
`--install-dependencies` authorizes required Ubuntu or Debian package installation without a terminal prompt.
`--no-install-dependencies` refuses system package changes.
Use `--help` for all supported arguments.
Use a new answers file with only applicable keys when resuming. For all-Docker status, an empty object is sufficient.

## Verify without installing

```sh
curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh |
  sh -s -- --verify-only
```

Use `--release phase-1-candidate-REVISION12` to select a specific immutable candidate.
Replace `REVISION12` with the actual release suffix.
The downloaded archive and manifest must share the same source revision and file inventory.
The script rejects older releases that lack the hosted installer or license.

## Trust and dependency sources

The entry script fixes the trusted GitHub workflow identity and issuer.
Release metadata cannot replace those trust values.
Node, Cosign, kubectl, and Docker repository keys have pinned SHA-256 checksums in the entry script.
Downloaded release code executes only after signature and file verification succeeds.

The initial entry script relies on HTTPS and repository control.
Download and inspect it before execution if your installation policy requires script review.
The [release guide](../release/README.md) documents the signing identity and candidate acceptance limits.
