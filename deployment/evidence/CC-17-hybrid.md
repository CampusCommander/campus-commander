# CC-17 isolated hybrid restore evidence

The hybrid data restore passed on one Docker host.
Native PostgreSQL 18.6 tools created ten encrypted components in 254 milliseconds and restored them in 255 milliseconds.
The operator container used the pinned PostgreSQL image and Node 24.19.0 without a Docker socket or injected dump adapter.
PostgreSQL connections verified the private CA and service hostname.

The source controller and both worker projects stopped before backup.
Source PostgreSQL and Redis stopped after backup and remained stopped throughout target verification.
The target used a new isolated network, PostgreSQL volume, database names, roles, artifact tree, and Kestra internal-storage tree.
The restore operator had no source data mounts and joined only the target network.
The target application services remained disabled. This result proves isolated data restore, not complete target service startup.

## Verified boundaries

- Both PostgreSQL databases restored with matching table inventories.
- The application migration ledger, artifact identity, Unicode bytes, and SHA-256 remained unchanged.
- The original shared-filesystem marker retained its checksum.
- The Kestra execution retained its exact stored key and JSON value.
- Execution identity, state, task outputs, and internal-storage URI remained covered by the exact JSON checksum.
- Every Kestra internal file retained its path and checksum.
- Target configuration matched the validated target profile.
- A fresh Redis instance lacked the source cache sentinel and passed authenticated write/read plus verified-TLS readiness.
- Restored bootstrap access was revoked. `RESTORE_DISABLED` remained present after verification.

[The machine result](CC-17-hybrid-result.json) records exact image references, execution hashes, timings, and source state.
Docker inspection confirmed frontend `9ae5b788`, API `73cd46ec`, and worker `6e692bc1` digest prefixes.
The complete references in the machine result include the Kestra, PostgreSQL, and Redis pins.
These local image candidates do not represent a signed accepted release.

## Generated Kestra fulltext column

Schema inspection identified `public.executions.fulltext` as `GENERATED ALWAYS`.
Only `key` and `value` are stored columns. The remaining twelve columns are generated.
The inspected `public.fulltext_replace(text,text)` function builds an array through `SELECT DISTINCT` without `ORDER BY`.
The generated fulltext expression combines `fulltext_index(namespace)`, `fulltext_index(flow_id)`, and `fulltext_index(id)`.
Recomputation on the source itself changed token positions while preserving all lexemes.
The restored row reproduced that distinction. Its other thirteen column hashes matched the source exactly.

The harness therefore requires exact stored key/value and eleven other generated-column comparisons.
It also requires identical `strip(fulltext)` lexemes and matching generated-expression and function-definition hashes.
The machine result retains raw source, recomputed, and restored fulltext hashes.
This exception covers generated token positions only. It does not exclude execution state, outputs, URI, or file integrity.
It does not establish identical search ranking after restore.

## Repeatable procedure

First run `deployment:hybrid-full-integration` with `CC_HYBRID_KEEP_FIXTURE=true` and retain its successful execution identity.
Obtain the fixture owner's release before stopping source writers.
Set the released fixture directory and execution identity before running:

```sh
CC_HYBRID_RESTORE_SOURCE_RELEASED=yes \
CC_HYBRID_RESTORE_SOURCE_ROOT='/tmp/cc-hybrid-full-RELEASED_FIXTURE' \
CC_HYBRID_RESTORE_EXECUTION_ID='SUCCESSFUL_EXECUTION_ID' \
CC_HYBRID_RESTORE_EVIDENCE=/tmp/cc-hybrid-restore-result.json \
npm exec nx run deployment:hybrid-restore-integration
```

Use the exact retained directory and execution identity from that run.
The fixture requires local Docker access, cached pinned images, and the host Node binary.
It creates fresh target resources and removes only those owned targets after verification.
It preserves the source containers, source volume, shared registry, and protected temporary backup material.
Source services remain stopped for operator review. Existing Campus Commander volumes remain untouched.

## Limits

Both worker projects, source dependencies, target dependencies, and file trees used one Docker host.
Separate paths do not establish independent backup media or district filesystem durability.
District shared-storage restore, recovery-key custody, and human recovery walkthroughs remain unqualified.
A complete target service startup remains a separate acceptance check.
