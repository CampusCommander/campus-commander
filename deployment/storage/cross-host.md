# Two-host shared-storage qualification

Synthetic worker-host qualification passed on 2026-09-09.
Worker A published through the artifact adapter. Worker B read matching bytes through a separate Docker daemon.
See the [CC-10 evidence](../evidence/CC-10.md) for the result and topology limits.
District filesystem qualification remains separate from this synthetic result.
This procedure produces synthetic evidence without copying artifacts between hosts.

## Prerequisites

1. Assign two distinct district worker hosts and record their infrastructure inventory identifiers.
2. Record the filesystem server, version, export, mount options, and security configuration.
3. Mount the same export on both hosts at the configured artifact location.
4. Create a dedicated empty qualification directory on that export with the runtime UID and mode `0700`.
5. Configure both installations to use that directory and the same synthetic application database.
6. Set `artifacts.kind` to `shared-filesystem` and preserve the configured persistence operator.
7. Apply the application migration with the dedicated migrator role.
8. Mount runtime credentials and the configured database CA on each host.
9. Install the same source revision and dependency lockfile on both hosts.
10. Build deployment validation with `npm exec nx run deployment:build`.

For Kubernetes, schedule the participants on different nodes.
Record pod names, node inventory identifiers, PVC, storage class, and CSI driver.
Different pod names alone do not establish distinct hosts.

## Publication and read

On host A:

```sh
node deployment/storage/cross-host.mjs health /operator/qualification.json
node deployment/storage/cross-host.mjs write /operator/qualification.json /operator/artifact-evidence.json
```

Transfer only `artifact-evidence.json` to host B through the operator channel.
That file contains identities, integrity metadata, and the writer hostname.
Do not transfer the artifact bytes.

On host B:

```sh
node deployment/storage/cross-host.mjs health /operator/qualification.json
node deployment/storage/cross-host.mjs read /operator/qualification.json /operator/artifact-evidence.json
```

Record both command outputs and source revisions.
Confirm identical artifact ID, attempt ID, size, schema version, and checksum.
Attach the operator attestation that host A and host B are distinct worker hosts.
The command reports hostnames but does not infer physical host separation from them.

Restart the writer container and reader container without deleting storage.
Repeat the read from host B.
For Kubernetes, reschedule the reader pod onto another qualified node and repeat the read.
Record exact restart commands, node assignments, elapsed times, and read results.

## Fault evidence

Use only the dedicated qualification directory and synthetic database.
Do not disrupt an existing installation.

1. Run the shared integration fault suite on each host with its local synthetic fixture.
2. Revoke write permission on the dedicated shared directory and run `health` as the runtime UID.
3. Require a nonzero result and verify that no artifact became ready.
4. Restore permission and require a successful health probe.
5. Disconnect the qualification mount from the reader and repeat `read`.
6. Record failure or the supervisor deadline. Do not record a timeout as a successful read.
7. Restore the mount and repeat the verified read.
8. Run concurrent publishers and cleanup through the adapter against synthetic shared artifacts.
9. Preserve active and referenced artifacts and reject stale attempt descriptors.
10. Repeat interrupted-write and metadata-rollback tests against the actual shared mount before release acceptance.

The repository integration suite supplies local fault evidence for the same adapter code.
Steps against a district shared mount require district infrastructure and remain pending.

After recording acceptance evidence:

```sh
node deployment/storage/cross-host.mjs remove /operator/qualification.json /operator/artifact-evidence.json
```

Confirm that the synthetic artifact is no longer readable.
Retain the evidence record outside the artifact directory.
Record unresolved failures as release blockers.
