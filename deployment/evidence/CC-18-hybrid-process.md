# CC-18 hybrid process interruption evidence

The complete hybrid fixture passed five process interruption cases on one Docker host.
The script took 169.5 seconds. Nx completed the build and fixture in 175 seconds.
The fixture used the final local frontend, API, and worker image digests recorded in the machine result.
It created a new controller project, two worker projects, simulated external PostgreSQL and Redis, and private shared directories.
It did not use the retained restore source.

| Interrupted component |     Stopped instances | Observed failure                                                            | Recovery and fixture verification |
| --------------------- | --------------------: | --------------------------------------------------------------------------- | --------------------------------: |
| API                   |                     1 | Protected edge returned 401 because bootstrap verification was unavailable  |                          1,751 ms |
| Workers               |                     2 | Protected startup and API diagnostics named workers not-ready               |                            649 ms |
| Kestra                |                     1 | Protected startup and API diagnostics named Kestra not-ready                |                          5,348 ms |
| Redis                 |                     1 | Protected startup and API diagnostics named Redis not-ready                 |                          1,907 ms |
| PostgreSQL            | 1 server, 2 databases | API diagnostics named both databases not-ready; protected edge returned 401 |                          1,744 ms |

Every case required eight ready protected startup checks before interruption and after recovery.
No interrupted case reported full readiness.
The API health endpoint supplied named diagnostics whenever the API remained available.
The API-loss case did not claim diagnostics from the stopped API.
Each recovery had a 120-second readiness bound. The measured values also include subsequent fixture verification.
The harness restarted interrupted containers in its recovery block before fixture cleanup.

## Integrity and resources

Each case preserved an authoritative artifact identity, SHA-256, complete bytes, metadata checksum, and application migration ledger checksum.
Both worker instances read the unchanged shared marker after recovery.
The complete canonical Kestra execution JSON retained its checksum, including state, task outputs, and internal-storage URI.
Every Kestra internal file retained its path and checksum.
The report includes container CPU, memory, and process measurements after recovery.

[The separate machine result](CC-18-hybrid-process-result.json) records each observation, recovery measurement, fixture checksum, and exact image reference.
The original full-hybrid result remains unchanged.
The local application digests start with frontend `9ae5b788`, API `73cd46ec`, and worker `6e692bc1`.
The result records its base Git revision separately from its uncommitted source state.
It does not claim a signed accepted release.

## Repetition and boundaries

```sh
CC_HYBRID_KEEP_FIXTURE=false npm exec nx run deployment:hybrid-process-fault-integration
```

The target enables `CC_HYBRID_PROCESS_FAULTS=true` and creates a new unique fixture.
`CC_QUALIFICATION_RELEASE` selects immutable application images through the shared qualification inventory helper.
Without that override, the harness retains the tested local digest defaults.
The helper connection was added after this runtime check without changing those defaults.

Cleanup removed the new fixture's containers, PostgreSQL volume, network, and temporary directories.
Read-only Docker queries confirmed their absence.
The retained restore source, shared registry, and old Campus Commander volumes remained untouched.

The two worker projects simulate separate hosts on one Docker host.
These results do not qualify district transport, shared-filesystem failure, certificate faults, storage exhaustion, or human recovery procedures.
They close the tested same-host hybrid process interruption cases only.
