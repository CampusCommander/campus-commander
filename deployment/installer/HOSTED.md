# Install from a published release

Start with a shell, internet access, and root or sudo access. Run the installer first.
The installer detects missing prerequisites and offers automatic installation or manual instructions.
Ubuntu 24.04 and Debian 12 or later support the downloaded Linux amd64 runtime.
You do not need to install Docker, Compose, Node, Java, or Git before starting.

Run this command in a terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh | sh
```

If `curl` is absent but `wget` is available, use:

```sh
wget -qO- https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh | sh
```

If neither download command exists, download `install.sh` through a browser and copy it to the target machine.
Run `sh /absolute/path/to/install.sh`. The script can install its missing download tools through apt.
A shell alone cannot retrieve an HTTPS script without a download tool or file transfer.

## Guided installation

The terminal shows five stages:

1. Check the operating system, architecture, environment, and Docker daemon access.
2. Download the signed release and verify its signatures, checksums, and application images.
3. Prepare the prerequisites for your selected installation method.
4. Create private configuration through guided questions.
5. Check configuration, start services, and report readiness.

Missing prerequisites offer three choices: `Install automatically`, `Show instructions`, or `Cancel`.
The installer explains each proposed system change before requesting consent.
The instructions choice lets you complete the commands in another terminal, then recheck without restarting the installer.
Automatic package installation supports Ubuntu and Debian. Other systems receive an explanation and manual guidance.

Sudo requests your password directly through the terminal, including when the installer runs through a pipe.
The installer never reads or stores your sudo password.
Only system package, service, and necessary Docker commands use elevated access.
Downloads and configuration remain under the account that started the installer.
Docker socket access uses sudo when needed. You do not need a Docker group change or a new login.
Interactive Docker commands can request sudo authentication again after its authorization expires.

The script selects the newest published Phase 1 candidate and verifies every inventoried file.
It downloads pinned Node and Cosign binaries privately when their required versions are absent.
It selects Docker and Compose packages that satisfy the verified release's version requirements.
Package upgrades require the displayed consent. They can restart existing Docker containers.
The installer refuses package removals and forced downgrades.
Package and signature commands write detailed output to private log files in the download cache.
Initial download-tool installation uses a private temporary log until the download cache is ready.
Failure messages identify the applicable log. Keep these logs private because system package output includes local repository details.

Linux hosts, virtual machines, and containers are installation environments.
In a container without systemd, the installer can install Docker Engine and start a private Docker daemon.
The outer container must permit Docker nesting. Root or sudo inside a restricted container cannot grant missing host capabilities.
The installer detects missing nesting permissions before release downloads and prints the required host-side launch commands.
An existing container with a working daemon continues to filesystem and resource qualification.
A container using another host's Docker socket does not establish installation-host filesystem access.

For a fresh Ubuntu test container, run these commands on its Docker host:

```sh
docker run -d --name cc-install --privileged --init --cgroupns=private --mount source=cc-install-docker,target=/var/lib/docker --mount source=cc-install-home,target=/root -p 127.0.0.1:8443:8443 ubuntu:24.04 sleep infinity
docker exec -it cc-install bash
```

Run the installer from that container shell. Docker and Node need no manual installation inside it.
Privileged mode grants broad access to the outer host. Use a dedicated container and dedicated volumes.
The installer exposes the nested Docker daemon only through its Unix socket.
Select `0.0.0.0` for the application HTTPS bind address to use the published host port.
The host port above accepts connections only from the outer host through `https://localhost:8443`.
Keep `/var/lib/docker` and the installation directory on persistent volumes.
After restarting the outer container, repeat the installer to start its daemon and resume the application.
All-Docker resume restores service dependency order after daemon startup. It preserves application data.
An explicit status request reports readiness without stopping application services.
The daemon log is `/var/log/campus-commander/dockerd.log` inside the container.
Host time synchronization remains an explicit laboratory exception when the container uses its host clock.
The [container validation record](../evidence/CC-20-container-installer-2026-09-11.md) documents fresh installation and restart recovery.

The script requests an installation method and license acceptance before application installation.
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

All-Docker storage uses managed Docker volumes. The installer retains their container paths automatically.

A disposable container usually lacks a host time service.
Use `time-synchronization` only when that applies to your environment.
The supported exception names are `district-dns`, `time-synchronization`, `storage-capacity`, and `host-memory`.
The `none` choice applies no exceptions. Docker, filesystem, certificate, registry, and architecture checks remain mandatory.

Success reports `ready`, the HTTPS URL, and the private bootstrap credential file path.
The bootstrap credential protects Phase 1 access. It is not a Phase 2 user account.
Keep the credential private. A self-signed laboratory certificate does not establish browser trust.
A loopback-bound URL is accessible from the installation host only.

## Installation methods

| Method     | What the installer prepares or requests                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| All-Docker | Installs missing Docker and Compose, starts a stopped daemon, and prepares HTTPS tools. Checks available memory and disk.          |
| Hybrid     | Prepares Docker, Compose, and Java certificate tools. Requests external PostgreSQL, Redis, credentials, storage, and worker hosts. |
| Kubernetes | Downloads kubectl when absent. Requests cluster access, storage classes, existing Secrets, certificates, and an HTTPS endpoint.    |

Hybrid setup prepares controller and worker Compose files, then pauses for worker deployment.
Follow the printed paths and commands on each worker host.
Transfer only its referenced configuration and credential files through your protected operator procedure.
Enter `yes` only after the worker hosts are ready. Otherwise, resume after completing that work.
The installer does not open remote shells or create district-managed services.

Kubernetes setup uses the named existing context and namespace.
It requests existing Secret names and matching private local files for readiness verification.
It does not create a cluster or replace district-managed Secrets.
The installer points to [Kubernetes preparation](../kubernetes/README.md) and [hybrid preparation](../profiles/hybrid/README.md) when you select those methods.
You can start with the installer before reading those procedures.
Missing cluster access includes kubeconfig and context-selection instructions.
External services, certificates, cluster creation, and storage provisioning remain district infrastructure responsibilities.
Failed configuration checks print each missing requirement and its corrective instruction directly in the terminal.

## Repeat, resume, and inspect

Use the same installation directory when repeating the command.
Existing configuration and credentials remain authoritative. Choose resume or status when prompted.
The script selects the installation’s original cached release. It does not silently upgrade that installation.

```sh
curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh |
  sh -s -- --root /opt/campus-commander --command resume
```

Use `--command status` for a readiness report.
The script detects the existing profile during resume or status. An explicitly different profile stops the command.
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
`--install-dependencies` authorizes the displayed package, service, and Docker-access repairs without a consent prompt.
Unattended sudo requires a valid authorization or a suitable passwordless policy. It never requests a password through the answers file.
`--no-install-dependencies` refuses automatic repairs and prints manual instructions when prerequisites are missing.
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
