# CC-9 local artifact storage

Date: 2026-09-08. Runtime: Node 24.19.0 with PostgreSQL 18.6 and `pg` 8.16.3.
The integration fixture used unique PostgreSQL and consumer containers, a unique database volume, and temporary artifact directories.
It removed those resources after the test.

| Acceptance criterion                           | Implementation and evidence                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Stage, inspect, publish, read, remove contract | `storage/index.mjs` and `storage/README.md` define UUID identities and integrity descriptors.                                        |
| Private paths and database metadata            | Public descriptors omit filesystem paths. `cc.artifacts` holds publication metadata.                                                 |
| Complete verified publication                  | Empty, Unicode, and 8 MiB streams passed. Truncated, oversized, and mismatched streams remained unpublished.                         |
| Metadata rollback and recovery                 | Injected failure after the ready UPDATE rolled back metadata. Inspection and publication recovered complete bytes.                   |
| Durability and interrupted publication         | File sync and directory sync precede ready commit. Writer process exit tested partial invisibility and complete-byte recovery.       |
| Restart, traversal, and stale attempts         | Adapter reopen and consumer-container restart preserved bytes. Corruption, symlinks, invalid locators, and stale descriptors failed. |

Six concurrent publishers preserved one artifact identity.
A publisher process exit after its metadata UPDATE rolled back readiness. Verified publication recovered the artifact.
Concurrent cleanup preserved a referenced artifact and an active writer.
The cleanup rollback test retained a hidden deleting record and completed removal on retry.
The database rejected a new reference to that deleting record.

Commands:

```sh
npm exec nx run deployment:storage-test
npm exec nx run deployment:storage-integration
npm exec nx run deployment:lint
```

Two unit tests passed. The local integration suite passed. Deployment lint passed.
No Google payloads, business jobs, automatic retention policy, or automatic backend migration were implemented.
The container restart test verified mounted artifact bytes through a synthetic consumer container.
It does not establish production API or worker rollout acceptance.
Host power loss and storage-controller cache behavior remain outside the local synthetic fixture.
