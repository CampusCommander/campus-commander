# Phase 1 installer

The CLI uses the validated deployment configuration as its authoritative input.
It renders pinned images without source builds, AI services, or Google credentials.
Phase 1 remains incomplete until all three profiles pass their operator acceptance gates.

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
Pending hashes preserve interrupted rendering without accepting unverified changes.
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

Upgrade accepts configuration changes only in the three application image digests.
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
`reset-bootstrap` requires operator database connectivity, `migrationCredentials`, and the current `expectedBootstrapGeneration`.
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
