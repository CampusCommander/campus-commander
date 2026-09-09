# Operator walkthrough record template for CC-20

## Record rules

Copy one record for the all-Docker, hybrid, and Kubernetes walkthroughs.
Set every field to `not-run` before execution.
Use `pass`, `fail`, or `blocked` only after the operator performs the step.
Use `blocked` with the owning ticket when the published procedure is absent.
Use the [hosted installer procedure](../installer/HOSTED.md) for installation.
Use the [installer CLI procedure](../installer/README.md) for lifecycle commands.
Use the [release procedure](../release/README.md) for integrity verification.
Use the [operations procedure](../operations/README.md) for backup and restore.
Published candidate artifacts are available through [project releases](https://github.com/CampusCommander/campus-commander/releases).
CC-19 supplies the release digest and source revision.
Record no credential values, network account names, endpoint credentials, or secret values.
Do not infer human acceptance from this template.

## Candidate handoff

Select an immutable candidate tag from [project releases](https://github.com/CampusCommander/campus-commander/releases).
Copy its complete `phase-1-candidate-` tag into the terminal prompt below.
Record the tag and verified source revision. A signed candidate remains unaccepted until the required gates pass.

The session coordinator must prepare these items before each walkthrough:

- A clean Linux amd64 test environment that meets the selected profile prerequisites.
- A new private installation directory and a unique project or namespace.
- Required certificates, Secret files, external services, shared storage, and network access.
- Synthetic fixture identifiers, expected values, and a published procedure to create and inspect them.
- Protected backup and restore files that follow the operations procedure.
- A separate upgrade candidate and verified backup when testing backup-gated upgrade.
- A browser that trusts the selected test certificate.

Record `blocked` and the owning ticket when any required item or published procedure is absent.
Do not replace a missing human procedure with a source integration fixture.

## Shared walkthrough sequence

Run the commands from a terminal on the installation host.
Replace the installation path with a new private directory.

```sh
set -eu
printf 'Candidate tag from project releases: '
read -r CC_RELEASE_TAG
export CC_RELEASE_TAG
export CC_INSTALL_ROOT=/absolute/private/campus-commander-walkthrough
umask 077
curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh |
  sh -s -- --release "$CC_RELEASE_TAG" --verify-only
curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh |
  sh -s -- --release "$CC_RELEASE_TAG" --root "$CC_INSTALL_ROOT"
```

Stop when release verification fails.
Select `candidate`, then enter `candidate-lab` for the disposable walkthrough.
Record the selected profile, start time, and assistance.
Record `sourceRevision` from the verified `release-manifest.json`.
After preparation, record `releaseHash` from `installer-state.json`.

Follow the profile route before recording installation success:

- All-Docker: follow the numbered steps in the [hosted installer procedure](../installer/HOSTED.md).
- Hybrid: prepare external services and worker hosts through the [hybrid procedure](../profiles/hybrid/README.md).
- Kubernetes: follow the [hosted Kubernetes test procedure](../installer/HOSTED-KUBERNETES-TEST.md).

Open the printed HTTPS URL after installation reports `ready`.
Enter `operator` as the browser authentication username.
Use the private bootstrap credential file contents as the password.
Do not copy that password into this record.
Confirm that the protected page reports all eight components ready.
Inspect the coordinator-provided synthetic fixtures and record their identifiers without secret values.

Locate Node and the verified release recorded in the installation directory.
The following commands also support Node and Cosign downloaded privately by the hosted installer.
These commands use the default download cache.
Set the cache path to your selected directory if installation used `--cache-dir`.

```sh
CC_DOWNLOAD_CACHE="$HOME/.cache/campus-commander"
CC_NODE=$(command -v node || true)
for CC_CACHED_NODE in "$CC_DOWNLOAD_CACHE"/release.*/tools/node-v24.19.0-linux-x64/bin/node
do
  [ -x "$CC_CACHED_NODE" ] || continue
  CC_NODE="$CC_CACHED_NODE"
  break
done
[ -n "$CC_NODE" ] || { echo 'Node is absent. Repeat hosted release verification.' >&2; exit 1; }
CC_RELEASE_ROOT=$("$CC_NODE" -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).releaseRoot)' "$CC_INSTALL_ROOT/operator.json")
CC_TOOLS="$(dirname "$CC_RELEASE_ROOT")/tools"
export PATH="$CC_TOOLS/node-v24.19.0-linux-x64/bin:$CC_TOOLS:$PATH"
if [ -x "$CC_TOOLS/node-v24.19.0-linux-x64/bin/node" ]; then
  CC_NODE="$CC_TOOLS/node-v24.19.0-linux-x64/bin/node"
fi
[ "$("$CC_NODE" --version)" = v24.19.0 ] || { echo 'Use the verified Node.js 24.19.0 runtime.' >&2; exit 1; }
CC_CLI="$CC_RELEASE_ROOT/deployment/installer/cli.mjs"
"$CC_NODE" "$CC_CLI" status "$CC_INSTALL_ROOT/operator.json" --qualification
```

For hybrid, stop every remote worker before stopping the controller.
On each worker host, set the installation path and that host's worker index from setup.
Run the following command on each worker host:

```sh
CC_INSTALL_ROOT=/absolute/private/campus-commander-walkthrough
CC_WORKER_INDEX=1
docker compose --file "$CC_INSTALL_ROOT/docker-compose.worker-$CC_WORKER_INDEX.json" stop
```

Return to the installation host and stop the deployment:

```sh
"$CC_NODE" "$CC_CLI" stop "$CC_INSTALL_ROOT/operator.json" --qualification
```

For hybrid, start each remote worker using the same variables on that worker host:

```sh
docker compose --file "$CC_INSTALL_ROOT/docker-compose.worker-$CC_WORKER_INDEX.json" up -d
```

Return to the installation host and resume the deployment:

```sh
"$CC_NODE" "$CC_CLI" resume "$CC_INSTALL_ROOT/operator.json" --qualification
```

Reopen the protected page after resume.
Confirm all eight components and the same synthetic fixture values.
Hybrid operators must verify shared artifact access from each restarted worker.

Use the operations procedure for backup, verification, and isolated restore.
Do not improvise database or storage copies during the walkthrough.
Compare restored fixture values with the coordinator-provided expected values.

Run support, interrupted-install recovery, upgrade, and uninstall only through their published installer procedures.
Verify preserved data after uninstall before deleting any retained volume, claim, external database, or shared directory.
Record every failed step and all assistance before the participant and reviewer decisions.

## Record: all-Docker

### Walkthrough metadata

| Field                              | Value   |
| ---------------------------------- | ------- |
| Participant role                   | not-run |
| Release digest and source revision | not-run |
| Environment                        | not-run |
| Start time                         | not-run |
| End time                           | not-run |
| Assistance                         | not-run |
| Failed steps                       | not-run |

### Operation evidence

| Field                          | Value   |
| ------------------------------ | ------- |
| Protected startup status       | not-run |
| Restart fixture integrity      | not-run |
| Restore verification           | not-run |
| Interrupted install recovery   | not-run |
| Backup-gated upgrade           | not-run |
| Redacted support diagnostics   | not-run |
| Preserved data after uninstall | not-run |
| Release integrity              | not-run |

| Service                | Operational status |
| ---------------------- | ------------------ |
| Frontend               | not-run            |
| API                    | not-run            |
| Workers                | not-run            |
| Application PostgreSQL | not-run            |
| Kestra PostgreSQL      | not-run            |
| HTTPS edge             | not-run            |
| Redis                  | not-run            |
| Kestra                 | not-run            |
| Storage                | not-run            |

### Findings and handoff

| Field                         | Value   |
| ----------------------------- | ------- |
| Defects                       | not-run |
| Explicit decision             | not-run |
| Operator sign-off and date    | not-run |
| Reviewer sign-off and date    | not-run |
| Application structure handoff | not-run |
| Authentication handoff        | not-run |
| Login handoff                 | not-run |
| Shell handoff                 | not-run |
| Service utilities handoff     | not-run |
| Google onboarding handoff     | not-run |

## Record: hybrid

### Walkthrough metadata

| Field                              | Value   |
| ---------------------------------- | ------- |
| Participant role                   | not-run |
| Release digest and source revision | not-run |
| Environment                        | not-run |
| Start time                         | not-run |
| End time                           | not-run |
| Assistance                         | not-run |
| Failed steps                       | not-run |

### Operation evidence

| Field                          | Value   |
| ------------------------------ | ------- |
| Protected startup status       | not-run |
| Restart fixture integrity      | not-run |
| Restore verification           | not-run |
| Interrupted install recovery   | not-run |
| Backup-gated upgrade           | not-run |
| Redacted support diagnostics   | not-run |
| Preserved data after uninstall | not-run |
| Release integrity              | not-run |

| Service                | Operational status |
| ---------------------- | ------------------ |
| Frontend               | not-run            |
| API                    | not-run            |
| Workers                | not-run            |
| Application PostgreSQL | not-run            |
| Kestra PostgreSQL      | not-run            |
| HTTPS edge             | not-run            |
| Redis                  | not-run            |
| Kestra                 | not-run            |
| Storage                | not-run            |

### Findings and handoff

| Field                         | Value   |
| ----------------------------- | ------- |
| Defects                       | not-run |
| Explicit decision             | not-run |
| Operator sign-off and date    | not-run |
| Reviewer sign-off and date    | not-run |
| Application structure handoff | not-run |
| Authentication handoff        | not-run |
| Login handoff                 | not-run |
| Shell handoff                 | not-run |
| Service utilities handoff     | not-run |
| Google onboarding handoff     | not-run |

## Record: Kubernetes

### Walkthrough metadata

| Field                              | Value   |
| ---------------------------------- | ------- |
| Participant role                   | not-run |
| Release digest and source revision | not-run |
| Environment                        | not-run |
| Start time                         | not-run |
| End time                           | not-run |
| Assistance                         | not-run |
| Failed steps                       | not-run |

### Operation evidence

| Field                          | Value   |
| ------------------------------ | ------- |
| Protected startup status       | not-run |
| Restart fixture integrity      | not-run |
| Restore verification           | not-run |
| Interrupted install recovery   | not-run |
| Backup-gated upgrade           | not-run |
| Redacted support diagnostics   | not-run |
| Preserved data after uninstall | not-run |
| Release integrity              | not-run |

| Service                | Operational status |
| ---------------------- | ------------------ |
| Frontend               | not-run            |
| API                    | not-run            |
| Workers                | not-run            |
| Application PostgreSQL | not-run            |
| Kestra PostgreSQL      | not-run            |
| HTTPS edge             | not-run            |
| Redis                  | not-run            |
| Kestra                 | not-run            |
| Storage                | not-run            |

### Findings and handoff

| Field                         | Value   |
| ----------------------------- | ------- |
| Defects                       | not-run |
| Explicit decision             | not-run |
| Operator sign-off and date    | not-run |
| Reviewer sign-off and date    | not-run |
| Application structure handoff | not-run |
| Authentication handoff        | not-run |
| Login handoff                 | not-run |
| Shell handoff                 | not-run |
| Service utilities handoff     | not-run |
| Google onboarding handoff     | not-run |
