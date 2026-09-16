# Phase 1 installer

The CLI uses the validated deployment configuration as its authoritative input.
It renders pinned images without source builds, AI services, or Google credentials.
Phase 1 remains incomplete until all three profiles pass their operator acceptance gates.

## Qualified installation platforms

Preflight enforces minimum versions before installation.
Docker hosts require Docker Engine 29.7.2 or newer within major version 29.
They require Docker Compose 5.5.0 or newer within major version 5.
Kubernetes clusters require server version 1.35.8 or newer within major version 1.
The evidence covers Docker Engine 29.7.2 and 29.8.0.
It covers Docker Compose 5.5.0 and 5.5.1.
It covers Kubernetes 1.35.8 and 1.37.0.
Other minor and patch versions within these bounds are compatible, but remain untested.
This contract does not qualify every vendor distribution.
Preflight records the observed and minimum versions in `installer-state.json`.
Existing capability checks still verify the Docker filesystem, cluster nodes, storage classes, and required runtime access.
Qualification cannot exempt a malformed or unsupported platform version.

```sh
node deployment/installer/cli.mjs validate /protected/operator.json
node deployment/installer/cli.mjs preflight /protected/operator.json
node deployment/installer/cli.mjs prepare /protected/operator.json
node deployment/installer/cli.mjs install /protected/operator.json
node deployment/installer/cli.mjs resume /protected/operator.json
node deployment/installer/cli.mjs status /protected/operator.json
node deployment/installer/cli.mjs stop /protected/operator.json
node deployment/installer/cli.mjs uninstall /protected/operator.json
```

Omit command arguments in a terminal to select a command, profile, and operator file interactively.
Noninteractive use requires both command and operator file. The installer never requests secret values through terminal prompts.
Use `operator.example.json` as the operator file template.
Copy the installer from the verified release bundle and use its packaged dependencies.
Do not compile application sources during installation.

## Release trust

Normal installation requires all matching profile evidence and complete release-file integrity checks.
Select `trust.kind: cosign` for the published Sigstore bundle.
Provide an independently trusted workflow identity, issuer, and manifest verification bundle.
The installer verifies the manifest and each image digest without insecure verification flags.
See [Sigstore verification](https://docs.sigstore.dev/cosign/verifying/verify/) and the repository release guide.
Select `trust.kind: ed25519` only when the distribution explicitly uses that signing method.
Provide its detached signature and an independently trusted public PEM key.
Do not obtain trust identities or trusted public keys solely from the downloaded release.
A signed candidate with incomplete profile evidence does not pass normal installation.

Qualification uses the explicit `--qualification` flag and a dedicated disposable `cc-` project or namespace.
It records `acceptedRelease: false` and never promotes a candidate to an accepted release.
Qualification retains configuration validation, image digests, available file checksums, runtime checks, and secret protections.
Explicit fixture exceptions are limited to district DNS, time synchronization, storage capacity, and host memory.
Each exception needs a specific recorded reason. A normal installation cannot use exceptions.
`localRegistryHttp: true` permits only localhost fixture registry inspection over HTTP.
It does not disable signature checks for normal installation or TLS checks for service traffic.

## State and recovery

The private installation directory contains atomic `installer-state.json` and a mutual-exclusion lock directory.
State records configuration, release, ownership, and generated manifest hashes. It contains no secret values.
Generated primary and worker manifests include an owned volume or PVC inventory.
Lifecycle commands reject changed manifests before invoking Docker or Kubernetes.
Kubernetes upgrades retain verified manifest history for resources with release-specific names.
Uninstall removes both current and retired installer resources. It preserves the namespace, claims, and external Secrets.
Erase removes the recorded installer-owned claims after workloads stop.
Preserve `kubernetes-history-*.json` with installer state until the installation is retired.
History cannot recover manifests overwritten by older installers. Previously orphaned resources require a separate ownership review before removal.
Pending hashes preserve interrupted rendering without accepting unverified changes.
Resume interrupted Kubernetes rendering before stopping, uninstalling, or erasing an installation with an uncommitted manifest.
Resume requires identical inputs and preserves existing credential files.
A failed command retains state for diagnosis and resume. It does not delete service data.
Remove a stale lock only after confirming that its installer process stopped.
The installer rejects startup when `RESTORE_DISABLED` exists in the installation directory or declared restore directories.
Status, support, stop, and uninstall remain available during recovery.
These lifecycle commands use the previously verified local state without requiring registry or signing-service connectivity.
Include every associated restore directory in `restoreDirectories`.
Complete the restore runbook before removing that marker.

Preparation generates only installer-owned credentials. Supply certificates, external credentials, and protected Kubernetes Secrets through operator procedures.
The all-Docker profile prepares database owner credentials and uses idempotent provisioning and migrations.
Hybrid requires its external roles, shared mounts, and migration operator file.
The installer invokes the hybrid preparation helper for local Kestra runtime configuration.
Kubernetes uses the explicit context and renderer operator settings. It does not create external Secrets.
Kubernetes operators can use this CLI from an operator host without a graphical installer on cluster nodes.

Startup succeeds only after the protected HTTPS endpoint reports eight ready checks.
Inspect prerequisite instructions in the state file when checks fail.
An occupied HTTPS port is accepted only when the existing Compose edge container belongs to this installation.

## Upgrade and lifecycle

The [hosted installer](HOSTED.md#update-an-installation) exposes update and uninstall through its menu and command options.
Guided update retains the installed phase and requires a verified recovery backup.

Upgrade accepts new application image digests and the documented Phase 1 to Phase 2 authentication transition.
The transition preserves service placement, public origin, storage, and existing infrastructure settings.
Follow the [Phase 2 upgrade procedure](PHASE-2.md#upgrade-from-phase-1) before invoking the upgrade.
Provide `upgradeFromReleaseHash` from state and `backupManifestSha256` for a verified foundation backup.
Provide `upgradeBackup.backupDirectory` and `upgradeBackup.keyRecovery` for encrypted component verification.
The backup must match the current profile and image inventory.
The target release must pass normal trust and evidence checks, or explicit candidate qualification checks.
Use `upgrade` with the target configuration and release. Resume interruption with those same target inputs.
The installer preserves credentials and invokes the profile's idempotent migration path.

`stop` stops owned workloads. `uninstall` removes owned workloads and preserves durable volumes.
Neither command deletes external databases, external storage, or district-managed Secrets.
`erase` requires `confirmErase` equal to the exact owned project or namespace.
Compose erasure removes only volumes declared by that owned project.
Kubernetes erasure deletes declared PVCs after workloads stop. It does not delete the namespace or external storage.
Review the storage provider's reclaim policy before explicit PVC erasure.

`support` writes a redacted support bundle to a new `supportDirectory`.
`reset-bootstrap` requires the current `expectedBootstrapGeneration`.
All-Docker runs recovery through the verified Compose `bootstrap-initialize` service on its internal network.
Recovery requires a running application database and the installed service configuration and secret volumes.
The installer sends the pending credential through standard input. Command arguments and output contain no credential values.
Hybrid and Kubernetes require operator database connectivity and the configured database credentials or `migrationCredentials`.
It stages and synchronizes a private pending credential before the database generation change.
It atomically replaces the active file after that change.
Retry with the same expected generation to complete an interrupted pending replacement.
It returns the generation without returning the credential.
Distribute that file through the district's protected operator procedure.

## Hybrid worker hosts

For multiple hybrid worker hosts, provide distinct district IPv4 addresses in `workerBindAddresses`.
Preparation writes `docker-compose.worker-1.json` and one fragment for each remaining host.
Transfer each fragment, the validated runtime configuration, and only its declared private credential files to that host.
Provide the qualified shared artifact mount at the configured absolute path on every host.
Start each worker fragment before starting the primary installation:

```sh
docker compose -f docker-compose.worker-1.json up -d
```

Use the matching fragment number on each host.
Configure the declared verified HTTPS worker endpoint to route to those hosts.
The primary installer does not open remote shells or copy credentials between hosts.
Hybrid stop and uninstall report `remoteWorkerActionRequired` when separate worker hosts exist.
Stop or uninstall each worker fragment on its host before claiming that the whole deployment stopped.
These commands preserve the shared artifact mount:

```sh
docker compose -f docker-compose.worker-1.json stop
docker compose -f docker-compose.worker-1.json down
```

Actual district host transfer, endpoint routing, shared storage, and distributed restart qualification remain required acceptance checks.

## Reproduce the isolated lifecycle fixture

The integration target reads the tracked all-Docker example and generates fresh, private synthetic certificate files.
It requires two readable release inventory files with different image digests.
Each inventory must declare its source revision and `architectures: ["linux/amd64"]`.
The fixture preserves supplied provenance fields and records its own source revision separately.
Local candidate inventories must state their uncommitted or unattested source limitations.
Provide immutable images that this host can retrieve. The fixture does not build application images.

```sh
CC_INSTALLER_RELEASE_A=/absolute/candidate-a.json \
CC_INSTALLER_RELEASE_B=/absolute/candidate-b.json \
CC_INSTALLER_EVIDENCE=/absolute/new-result.json \
npm exec -- nx run deployment:installer-integration
```

For an explicit localhost HTTP registry fixture, also set `CC_INSTALLER_LOCAL_REGISTRY_HTTP=1`.
Leave that exception unset for ordinary registry connections.
The host requires Docker, Compose, Node.js, and OpenSSL.
Each run uses a new project and private directory. It erases only its isolated target resources.

Set `CC_INSTALLER_BROWSER=1` to load the real protected page with Chromium.
Install the Playwright Chromium binary first and provide `PLAYWRIGHT_BROWSERS_PATH` when using a separate browser cache.
This browser fixture disables certificate verification only for its synthetic UI check.
It does not establish district browser trust or human acceptance.
Set `CC_INSTALLER_FAULTS=1` to test expired and wrong-host certificates through separately verified HTTPS probes.
The `installer-browser-integration` target enables both checks.

Set `CC_INSTALLER_SECRET_LINE_ENDINGS=1` to qualify the PostgreSQL application secret-file policy after upgrade.
The fixture adds LF/CRLF delimiters to application, Kestra database, and migration credentials.
It reruns provisioning and migration, recreates dependent processes, and requires all eight checks to recover.
Local database administrator files remain exact bytes without line endings.
Use images that contain the shared PostgreSQL secret parser for this check.

## Prepared hybrid and Kubernetes lifecycle fixtures

These targets operate only on disposable qualification fixtures. They do not create customer acceptance records.
Prepare two verified releases with different application image inventories before execution.
Keep the fixture credentials, descriptors, snapshots, and raw results in a private directory outside Git.

The hybrid runner requires a prepared controller and two worker hosts.
Its fixture descriptor identifies the hosts, installation directory, verified releases, and private backup and probe procedures.
The runner invokes the installer CLI and performs the required worker actions on each host.

```sh
CC_HYBRID_LIFECYCLE_FIXTURE=/absolute/private/descriptor.json \
npm exec nx run deployment:hybrid-lifecycle-integration
```

The Kubernetes runner requires a ready `cc-closeout-kube` fixture and a matching isolated context.
Its installation directory must reside under `/tmp/cc-closeout-kube*/install`.
Keep the fixture edge port-forward available throughout stop, resume, and upgrade.

The private JSON descriptor contains these fields:

| Field               | Required value                                          |
| ------------------- | ------------------------------------------------------- |
| `qualificationOnly` | `true`                                                  |
| `operatorPath`      | Prepared installer operator file                        |
| `kubeconfig`        | Isolated cluster configuration file                     |
| `releaseBRoot`      | Verified replacement release directory                  |
| `artifactSnapshot`  | Private artifact snapshot destination                   |
| `kestraSnapshot`    | Private Kestra snapshot destination                     |
| `snapshotCommand`   | Trusted local fixture command and arguments as an array |
| `reportPath`        | New private result file                                 |

The snapshot command runs after API, workers, and Kestra stop.
It copies the fixture storage bytes into the two snapshot directories.
Database certificates must include `localhost` for verified backup connections through private port-forwards.

```sh
npm exec nx run deployment:kubernetes-lifecycle-integration --args="/absolute/private/descriptor.json"
```

The runners verify fixture preservation after stop, resume, uninstall, and a backup-gated image change.
The final erase removes installer-owned resources and checks external resource preservation.
The fixture owner removes the disposable hosts or cluster after recording the results.
An interrupted runner preserves its failed fixture for diagnosis.
