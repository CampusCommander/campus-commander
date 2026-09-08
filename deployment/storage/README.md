# Artifact storage

The storage contract supports local persistent storage and an operator-provided shared filesystem.
Both adapters use `cc.artifacts` in the application PostgreSQL database.
They expose opaque identities and integrity metadata. They keep filesystem locators inside the adapter.
The contract does not require rename or object-store behavior.

## Contract

Import `createArtifactStore` from `deployment/storage/index.mjs`.
Pass a `pg.Pool`, an existing absolute `root` directory, and `backend: 'local'` or `'shared-filesystem'`.
Close the store and pool after active operations finish.

| Method        | Input                                      | Result                                                      |
| ------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `stage`       | Manifest and async iterable of byte chunks | Verified descriptor with unpublished metadata               |
| `inspect`     | `{ artifactId, attemptId }`                | Verified descriptor and `publicationState`                  |
| `publish`     | Descriptor                                 | Descriptor after the ready-state transaction commits        |
| `openRead`    | `artifactId`                               | Read stream for verified ready bytes                        |
| `remove`      | `{ artifactId, attemptId }`                | Boolean indicating completed removal                        |
| `checkHealth` | None                                       | Boolean from a private write, read, sync, and cleanup probe |
| `close`       | None                                       | Closed adapter directory handle                             |

A manifest contains `schemaVersion`, `expectedSizeBytes`, and lowercase hexadecimal `expectedSha256`.
It accepts optional UUID `artifactId`, UUID `attemptId`, and `retentionUntil`.
The adapter generates missing identities.
A descriptor contains `artifactId`, `attemptId`, `schemaVersion`, `sizeBytes`, and `sha256`.
`attemptId` is the opaque attempt locator in the public contract.
Artifact IDs remain independent of deployment placement and filesystem roots.
Every operation rejects invalid identities. Error messages omit paths and database details.

## Publication and recovery

The adapter reserves staging metadata before creating an attempt-specific file with exclusive creation.
A PostgreSQL session advisory lock serializes writes for that artifact identity.
The adapter streams chunks and verifies their declared size and SHA256 checksum.
It makes the file read-only, syncs the file, closes it, and syncs the containing directory.
It then clears the active-upload flag.
Staging metadata remains invisible to readers.

Publication obtains the same artifact lock and locks the metadata row.
It compares attempt identity, schema version, size, and checksum against the supplied descriptor.
It verifies all stored bytes again and syncs the file and directory before committing ready state.
A metadata transaction failure leaves complete bytes unpublished.
Call `inspect` and `publish` with the original descriptor to recover verified complete bytes.
A writer process exit releases its PostgreSQL lock.
Publication can recover a complete file after that exit, including a retained active-upload flag.
Partial files fail verification and remain unpublished.

Retries use a new attempt ID for an inactive staging artifact.
Ready artifacts reject replacement. Stale descriptors reject publication and removal.
Superseded attempt files remain unpublished. Full orphan retention automation remains outside this foundation.
An interrupted partial upload retains its active flag until an operator resolves the abandoned attempt.
Do not clear an active flag while its writer remains operational.

Reads require ready metadata and verify complete file size and checksum before returning a stream.
Consumers must handle stream errors and close abandoned streams.
The adapter rejects symbolic links, hard links, nonregular files, invalid locators, and traversal.
It opens files relative to a pinned directory descriptor through Linux `/proc/self/fd`.
The operator must prevent unrelated users from modifying the directory or its ancestors.
This protection does not defend against a privileged host operator rewriting files during an active read.

## Cleanup

Cleanup uses the same artifact lock. It returns false when a writer currently holds that lock.
It preserves active uploads and artifacts with a positive reference count.
It commits a deleting state before unlinking bytes.
It then removes the file, syncs the directory, and deletes metadata in a second transaction.
A database failure after unlink leaves a hidden deleting record.
Retry removal to complete that record. It never returns to ready state automatically.
The database constraint prevents new references or active uploads in deleting state.
Application code must create references through conditional updates of ready rows.

## Filesystem requirements

Run on Linux with `/proc/self/fd`, exclusive file creation, regular files, file sync, and directory sync.
Use a persistent directory without symbolic links.
The adapter rejects directories with group or public write permission.
Use the same runtime UID on every consumer. Protect the directory with mode `0700`.
Mount the parent storage before creating the directory.
Do not place artifact storage inside Kestra internal storage.

The selected shared backend is a district-operated POSIX filesystem, with NFSv4.1 as the qualification candidate.
This choice matches the Phase 1 shared-filesystem deployment contract and uses the existing district storage platform.
The district operator owns the server, export, access controls, backup, patching, and durable-write guarantees.
The operator must qualify exclusive creation, directory sync, cross-client visibility, and restart persistence on the selected server.
The adapter does not claim that every NFS server satisfies those requirements.
The same database coordinates all workers. Filesystem locks do not coordinate publication.
No atomic rename assumption exists.

Kubernetes requires a district storage class and a ReadWriteMany volume accessible from every worker node.
The volume must retain data during pod rescheduling and use consistent runtime UID mapping.
Record the CSI driver, server version, mount options, security mode, storage class, and reclaim policy.
Test actual worker nodes before accepting the shared backend.
Two containers on one host do not satisfy this gate.

The health probe owns one unique temporary file and never changes authoritative metadata.
It attempts cleanup even after failure.
A stalled network filesystem can block a kernel filesystem operation.
Use process supervision and readiness deadlines for that failure. A JavaScript timeout does not cancel a blocked kernel operation.

## Verification

```sh
npm exec nx run deployment:storage-test
npm exec nx run deployment:storage-integration
CC_STORAGE_BACKEND=shared-filesystem npm exec nx run deployment:storage-integration
```

The integration tests use isolated PostgreSQL, temporary artifact directories, and synthetic consumer containers.
They cover streaming, corruption, interruption, metadata rollback, cleanup races, and container restart.
The shared test uses one local host. It does not qualify a district mount or cross-host access.
Follow [the two-host procedure](cross-host.md) for that gate.

The [Node filesystem documentation](https://nodejs.org/api/fs.html#filehandlesync) defines the file sync API.
The [Linux NFS client documentation](https://docs.kernel.org/admin-guide/nfs/nfs-client.html) provides the client configuration reference.
The district storage implementation determines the final durability guarantees.
