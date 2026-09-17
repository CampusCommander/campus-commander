# Phase 3 hybrid qualification

[CC-58](https://easton-consulting.atlassian.net/browse/CC-58) requires extracted installation, resume, Phase 2 upgrade, restore, faults, and operator lifecycle evidence.
The task remains incomplete.
Installation, resume, Phase 2 upgrade, isolated restore, service faults, certificate faults, capacity faults, and provider faults have passed hosted qualification.
Installed workflows, key projection, distributed renewal, and replica permission checks also passed.
The checkpoint sections below link their exact application and harness evidence.

## Installed workflow fixture

The `api-e2e:phase3-hybrid-install-integration` target requires an extracted, verified Phase 3 laboratory bundle.
The CI profile workflow verifies both signed blobs, inventory bytes, and all three image signatures before execution.
The fixture runs the delivered installer across one controller daemon and two worker daemons.
External PostgreSQL and Redis use the existing synthetic district TLS fixtures.

The fixture projects one credential key into API and worker containers.
It compares transferred key bytes without including those bytes in assertion errors.
It checks actual container mounts for read-only access and rejects key mounts in other services.
Worker observations must identify two distinct daemons.

Public workflows cover customer confirmation, settings, invitations, identity confirmation, grants, school boundaries, revocation, and credential replacement.
Saved state must survive API and worker restart, stop/resume, and uninstall/resume.
Session checks address both API replicas. Final sign-out must reject the previous session through both replicas.
Distinct installation and resume reports record actual delivered CLI durations.
Reports preserve application and harness identities, image digests, manifest hash, environment, commands, host placement, and fixture limits.

Run installation qualification with these CI inputs:

```sh
gh workflow run ci.yml --ref codex/cc-58-phase3-hybrid \
  -f phase3Release=phase-3-lab-a3601eff2a55 -f phase3Profile=hybrid
```

Hybrid dispatch supports installation, Phase 2 upgrade, isolated restore, service faults, certificate faults, capacity faults, provider faults, lifecycle, and guided update.
The existing Phase 2 targets retain their previous modes.

## Remaining evidence

- Prerequisite acceptance and complete hybrid acceptance.

Three Docker daemons share one physical Docker host and synthetic shared storage.
They do not establish independent physical failure domains or district storage qualification.
Synthetic Google and sign-in providers do not establish district privileges, Education capabilities, or browser trust.
Applicable UI rules are UI-01, UI-08, UI-09, UI-10, and FORM-01.
This increment changes no product controls. Automated workflow results do not establish human accessibility acceptance.

## First hosted attempt

[Run 35227673796](https://github.com/CampusCommander/campus-commander/actions/runs/35227673796) failed during preparation at harness `83ed680`, before installation.
The [retained failure report](../../deployment/evidence/CC-58-installation-attempt1.json) preserves its original fields and report hash.
PR CI passed at the same harness revision.

The diagnostic increment separates image distribution, external services, provider preparation, and installation configuration stages.
It records the process UID and GID and only an allowlisted failure category and numeric exit code.
Tests verify that arbitrary exception data cannot enter the diagnostic report.
Harness state now checks tracked files. Generated bundle files no longer mark committed source as modified.
This increment does not claim a corrected installation or a hosted pass.

## Shared-storage account correction

[Diagnostic run 35228930026](https://github.com/CampusCommander/campus-commander/actions/runs/35228930026) failed during image distribution before delivered installation.
Its [retained report](../../deployment/evidence/CC-58-installation-attempt2.json) records a clean harness at `24b8635` and runner UID/GID 1001.
Hybrid host commands run as UID/GID 1000. Private fixture directories require the same owner.
The new workflow omitted the account preparation used by the Phase 2 hybrid workflow.

The workflow now uses that established account contract.
It grants UID 1000 access to the selected Docker socket and its parent directories.
It transfers workspace ownership and executes hybrid qualification as UID/GID 1000.
Shared browser storage and preserved installer, image, and Docker configuration variables support the account change.
The workflow restores evidence ownership before upload, including failed runs.

The workflow regression failed before the correction. The passed installation checkpoint below verifies the correction.
The original failure reports remain intact.

## Delivered key-projection contract

[Recheck 35229878452](https://github.com/CampusCommander/campus-commander/actions/runs/35229878452) passed image distribution, prepare, install, and repeated resume with UID/GID 1000.
The [retained failure](../../deployment/evidence/CC-58-installation-attempt3.json) identifies credential-key projection as the next failed stage.
The fixture expected a direct key-file mount. The delivered installer stages separate service secrets volumes with read-only consumer mounts.
A local regression exercised the real staging function and reproduced the incorrect mount assertion.

The corrected check requires the exact per-service secrets volume, read-only access, and its expected destination.
It compares key bytes inside each running API and worker container through private standard input.
Reports contain only the comparison result, ownership, permissions, and mount metadata.
Unauthorized running containers must lack the key file and the authorized secrets volume.
The initializer retains its established temporary provisioning access.

The regression and API fixture lint pass. The passed installation checkpoint below verifies the corrected projection checks.

## Distributed credential checks

The hybrid fixture now checks background Google reads after browser logout and closure.
Both worker daemons must reject unauthorized dispatch, credential-bearing payloads, and the retired credential generation.
Current-generation reads must return the bound synthetic customer without plaintext token fields.

The fixture advances only its owned token expiry through the installed migration container.
Worker-only instrumentation holds the first synthetic renewal until the other worker observes the real pending-lease result.
The instrumentation preserves the database result and records only fixed markers.
After release, both reads must succeed with exactly one renewal event and one encrypted token record.
Both workers then restart. Reads must recover within 30 seconds and reuse that token without another renewal.
Reports retain worker daemon identities, fixed response metadata, renewal counts, durations, and limits.
Ownership checks reject foreign fixture roots and shared daemon identities before database access.

The passed distributed-renewal checkpoint below verifies this increment. Upgrade, restore, fault recovery, and hybrid acceptance remain open.

## Passed installation checkpoint

[Run 35230914506](https://github.com/CampusCommander/campus-commander/actions/runs/35230914506) passed with harness `253221a` against signed application `a3601ef`.
All ten installed workflows, shared sessions, logout rejection, restart, stop/resume, and uninstall/resume checks passed.
Both API replicas and both worker daemons received the correct credential key through read-only staged volumes.
The complete fixture took 212,787 milliseconds. Installation commands took 26,710 milliseconds. Four resume commands took 61,169 milliseconds.

The retained [installation](../../deployment/evidence/CC-58-installation.json), [resume](../../deployment/evidence/CC-58-resume.json), and [workflow](../../deployment/evidence/CC-58-installed-workflows.json) reports preserve original fields and three source-report hashes.
Their source, images, and manifest identify the delivered application. Their harness revision identifies the executed checks.
Three Docker daemons share one physical host. This checkpoint does not establish the new distributed-renewal checks or complete hybrid acceptance.

## Permission checks across API replicas

The installed invitation workflow now exposes optional replica checks after grant changes, after fresh sign-in, and after revocation.
The fixture captures recipient cookies before each permission mutation and replays those exact cookies against both API replicas.
Both replicas must reject the previous session after its permission version changes or access is revoked.
With the renewed session, both replicas must allow the granted school and hide ungranted and unknown schools identically.

The direct probes use verified TLS and bounded requests. Cookies travel through private standard input and remain outside process arguments and reports.
Reports retain only replica identity, workflow stage, resource category, and status.
Shared session checks use the same probe. Fixtures without the optional callback retain their existing behavior.
Local API fixtures, hybrid fixtures, lint, and formatting pass. The passed replica-permission checkpoint below verifies hosted behavior.

## Passed distributed-renewal checkpoint

[Run 35232255573](https://github.com/CampusCommander/campus-commander/actions/runs/35232255573) passed with harness `0e0db2f` against signed application `a3601ef`.
Both worker daemons completed background reads after browser closure and rejected unauthorized dispatch, credential fields, and retired generation 1.
The second daemon observed the pending renewal lease within 1,171 milliseconds while the first renewal remained held.
Both reads then completed. Renewal events advanced from one to two and remained at two after worker restart.
Both workers recovered within 2,682 milliseconds against the 30-second bound.

The [distributed-renewal report](../../deployment/evidence/CC-58-distributed-renewal.json) records daemon identities, observations, original report hashes, and fixture limits.
The renewal segment took 12,397 milliseconds. The complete hybrid fixture took 228,815 milliseconds.
This checkpoint does not establish the subsequent replica-permission checks or complete hybrid acceptance.

## Passed replica-permission checkpoint

[Run 35233163753](https://github.com/CampusCommander/campus-commander/actions/runs/35233163753) passed with harness `c2884ab` against signed application `a3601ef`.
The [replica-permission report](../../deployment/evidence/CC-58-replica-permissions.json) retains all original run fields and three source-report hashes.
The downloaded artifact archive matches its published SHA-256 digest.

Both API replicas rejected the previous session after grant changes and after revocation.
Both replicas allowed the granted school after fresh sign-in and returned the same denial for ungranted and unknown schools.
All 16 direct observations passed. All ten installed workflows passed in the same run.

Distributed renewal also passed. Renewal events advanced from one to two and remained at two after worker restart.
The second worker observed the pending lease within 460 milliseconds. Both workers recovered within 2,211 milliseconds against the 30-second bound.
The complete fixture took 319,751 milliseconds. The worker segment took 14,815 milliseconds.
PR CI passed at documentation revision `19a119c`.

This checkpoint completes the synthetic replica-permission checks. Upgrade, isolated restore, fault recovery, operator lifecycle coverage, and prerequisite acceptance remain open.

## Pinned Phase 2 upgrade fixture

The `api-e2e:phase3-hybrid-upgrade-integration` target installs the verified, pinned Phase 2 bundle through its own extracted installer.
The baseline manifest hash, source revision, and images must match the accepted Phase 2 implementation record.
Baseline installation and repeated resume use `/baseline`. The Phase 3 upgrade and subsequent commands use `/release`.
Each installer command records that source root.

The baseline administrator signs in and saves a light theme. A second principal has separate saved preferences.
The fixture publishes an artifact and records its metadata and byte hash.
It records both baseline migration checksums, original audit events, existing secret bytes, and installer state before upgrade.

The fixture stops application writers on all three daemons before backup.
The delivered Phase 3 operator CLI generates a protected key, creates the cold backup, and verifies it.
The operator container uses native PostgreSQL tools from the pinned image. No database tool function is substituted.
A read-only mount supplies the runner's Linux Node binary to that container through the controller.
Backup inputs remain private. Reports retain command results, tool identity, and the backup manifest hash.

The fixture then activates the Phase 3 configuration and Google transport instrumentation.
It executes the delivered upgrade, transfers the worker configuration, starts both upgraded workers, and repeats resume.
Preservation checks run before explicit Phase 3 administrator confirmation.
They require both principals, preferences, artifact metadata and bytes, original audit values, and migration checksums to survive.
Existing audit events must receive null defaults for the two new Phase 3 columns.
Existing secrets must retain their bytes. Installer state must identify the target release and configuration.

The upgraded installation must pass the public workflows, both API replica checks, and distributed credential renewal.
The upgrade report records baseline and target image observations and separates upgrade duration from complete fixture duration.
It does not establish isolated restore, complete fault recovery, or district acceptance.

Run the hosted upgrade with these CI inputs:

```sh
gh workflow run ci.yml --ref codex/cc-58-phase3-hybrid \
  -f phase3Release=phase-3-lab-a3601eff2a55 -f phase3Profile=hybrid \
  -f phase3Upgrade=true
```

Workflow regressions verify routing and unsupported mode rejection.
Preservation regressions reject lost principals, preferences, artifacts, audit values, or migration checksums.
The audit regression reproduced the added-column comparison failure before correction.
The passed upgrade checkpoint below records hosted execution of this fixture.

## Passed Phase 2 upgrade checkpoint

[Run 35235896138](https://github.com/CampusCommander/campus-commander/actions/runs/35235896138) passed with harness `4484640` against signed application `a3601ef`.
The [upgrade report](../../deployment/evidence/CC-58-phase2-upgrade.json) preserves all original fields and both source-report hashes.
The downloaded artifact archive matches its published SHA-256 digest.

The fixture installed pinned Phase 2 bundle `1b04fa3` through `/baseline` and upgraded through `/release`.
Both principals, their preferences, the artifact, all 13 original audit events, and existing secret bytes survived.
The migration ledger advanced from two entries to fifteen. Both original checksums remained unchanged.
All ten preservation checks passed. The native operator CLI generated a key, completed backup, and verified the backup before upgrade.

All ten installed workflows and 16 API replica observations passed after upgrade.
Distributed credential renewal and worker restart also passed.
The upgrade segment took 66,264 milliseconds. The complete fixture took 318,113 milliseconds.
PR CI passed at the same harness revision.

The baseline identifies the accepted Phase 2 implementation. It does not establish the owner's exact previously installed revision.
Isolated restore, complete fault recovery, operator lifecycle coverage, and prerequisite acceptance remain open.

## Isolated restore fixture

The `api-e2e:phase3-hybrid-restore-integration` target uses the extracted Phase 3 installer and native operator commands.
It creates separate target Compose projects, storage trees, PostgreSQL, and Redis.
The source and target reuse three Docker daemons, one physical host, and the synthetic district network.

The fixture stops source application services before seeding durable Phase 3 state and creating the encrypted backup.
It stops source PostgreSQL and pauses source Redis before target restoration.
Pausing Redis preserves the pending authorization control while preventing Redis from serving requests.
Source container checks must confirm these states during target verification.

State checks compare principals, preferences, artifact metadata and bytes, audit events, migration checksums, and Kestra records and files.
The delivered recovery verifier checks customer settings, grants, receipts, credential state, health history, and approved school scope.
Restoration must invalidate pending invitations, browser bindings, authorization callbacks, credential candidates, school reviews, and bootstrap access.
Both target API replicas must reject the source session.

The delivered revalidation command must verify the restored Google credential while preserving `RESTORE_DISABLED`.
The delivered installer must reject preparation until the fixture operator accepts the verified state and removes that marker.
Target preparation, installation, worker fragment transfer, and resume then use the delivered installer.
Fresh browser checks require restored settings, school definitions, preferences, and all four diagnostics.
The source callback control must still succeed after source restart within its original five-minute lifetime.

Run the hosted restore with these CI inputs:

```sh
gh workflow run ci.yml --ref codex/cc-58-phase3-hybrid \
  -f phase3Release=phase-3-lab-a3601eff2a55 -f phase3Profile=hybrid \
  -f phase3Restore=true
```

The workflow rejects mixed restore modes and retains separate restore evidence.
This implementation requires hosted execution before it establishes a restore pass.
Synthetic Google verification does not establish live district privileges or Education capabilities.

[Runner recheck 35237124613](https://github.com/CampusCommander/campus-commander/actions/runs/35237124613) passed at `f88ceba`.
The [retained report](../../deployment/evidence/CC-58-native-operator-upgrade.json) preserves every original field and both source-report hashes.
The archive matches its published SHA-256 digest.
The complete upgrade fixture took 341,020 milliseconds.
PR CI also passed at `f88ceba`.

## First restore attempt

[Run 35239418295](https://github.com/CampusCommander/campus-commander/actions/runs/35239418295) failed during target service preparation at `ede2db3`.
The [retained failure](../../deployment/evidence/CC-58-restore-attempt1.json) preserves all original fields and the source-report hash.
The artifact archive matches its published SHA-256 digest. Source installation and lifecycle checks completed before target preparation.

The target configuration used underscores in database names. The delivered deployment schema permits hyphens but rejects underscores.
A local regression called the actual configuration builder and reproduced both schema errors before correction.
The builder now uses valid names and validates the target configuration before creating external services.
The hybrid fixture target now declares its deployment-build dependency.
The original failure category remains intact. Its broad TLS classification does not establish a certificate failure.
PR CI passed at `ede2db3`. Hosted restoration still requires a successful rerun.

## Restore recovery-material correction

[Run 35240547903](https://github.com/CampusCommander/campus-commander/actions/runs/35240547903) passed target preparation and failed during native restore at `7365415`.
Source state seeding, encrypted backup, and source and target backup verification completed before that failure.
The [retained failure](../../deployment/evidence/CC-58-restore-attempt2.json) preserves all original fields and verified report and archive hashes.

The target copied application recovery secrets but omitted the bootstrap credential required by the recovery-material check.
A regression reproduced the missing bootstrap file through the real recovery-material check before correction.
Target preparation now calls the existing secret preparer before native restore.
Tests require complete private recovery material, preserved Google key bytes, and separate target database credentials.

Failure reports now retain an allowlisted operator reason through bounded aggregate errors.
Tests reject arbitrary provider text, unknown reasons, trailing private data, and cyclic error chains.
PR CI passed at `7365415`. Hosted restoration still requires a successful rerun.

## Restored bootstrap identity correction

[Run 35241830253](https://github.com/CampusCommander/campus-commander/actions/runs/35241830253) passed native restore, state verification, Google revalidation, and startup-lock rejection at `63fa898`.
It failed during delivered target installation. The [retained failure](../../deployment/evidence/CC-58-restore-attempt3.json) preserves original fields and verified hashes.

The generated target bootstrap credential differed from the credential hash in the restored database.
A regression reproduced the initializer rejection through actual target secret preparation and the real initializer with a restored row.
Target preparation now preserves the original bootstrap file with the other application recovery material.
The initializer can then preserve the revoked row without replacing its credential or restoring bootstrap access.
The hosted fixture also checks that bootstrap access remains revoked after target startup.

API tests, hybrid fixtures, lint, and formatting pass.
PR CI passed at `63fa898`. Complete hosted restoration remains open.

## Service fault increment

The `api-e2e:phase3-hybrid-fault-integration` target installs the extracted Phase 3 bundle before fault injection.
It completes public workflows and lifecycle checks before capturing durable state.
Six cases interrupt API services, both worker hosts, external Redis, external PostgreSQL, Kestra, and shared artifact access.
Protected access must fail during required dependency loss. Diagnostic operations must report failure with correlation identifiers.
Recovery must complete within 180 seconds, including diagnostics, workflow reads, durable checks, and both API replicas.
A Redis restart must invalidate the previous session. A fresh sign-in must succeed.

The fixture hashes protected credential and policy records inside the owned external database.
It compares principals, preferences, migration checksums, original audit records, artifact metadata and bytes, and completed Kestra executions.
A UTF-8 marker verifies Kestra internal storage. Diagnostic records can increase without changing original records.
Ownership checks reject foreign resources before filesystem or service access.
The fixture repeats customer, school, credential-generation, disabled-user, and receipt reads after every fault.
Distributed worker credential checks follow the fault cases.

Hybrid dispatch accepts only the service fault kind. It rejects mixed restore, upgrade, lifecycle, and update modes.
Separate reports identify the application, harness, executed cases, recovery durations, and preserved state.
This increment requires hosted qualification. It does not establish network, certificate, capacity, or live Google fault acceptance.

## Controlled bootstrap replacement

[Fourth restore attempt](https://github.com/CampusCommander/campus-commander/actions/runs/35243519217) failed during delivered target installation at harness `4f0b9f6`.
The [retained failure](../../deployment/evidence/CC-58-restore-attempt4.json) preserves its original fields and verified source hashes. PR CI passed.
The fixture preserved the original bootstrap file but omitted the documented replacement step.
Restore revokes that credential. Authenticated installer readiness requires an active replacement credential.
The actual bootstrap verifier regression reproduced the rejected readiness check.

The target now runs delivered `prepare`, `reset-bootstrap`, `install`, and `resume` commands.
Controlled replacement uses the restored generation and operator migration credentials.
The restored source credential remains invalid. The replacement must advance the generation by one and pass the actual verifier.
The native post-startup check requires exactly one row, the replacement generation, and a changed credential hash.
The pre-startup check still requires all restored bootstrap access to remain revoked.
Each delivered command now has a separate failure stage.

Local API tests, hybrid fixtures, lint, formatting, and both reviews pass. Hosted qualification remains pending for this correction.
The earlier failed reports remain unchanged. CC-58 remains incomplete.

## Passed service fault checkpoint

[Run 35244946498](https://github.com/CampusCommander/campus-commander/actions/runs/35244946498) passed all six service faults at harness `bcc0d60` against signed application `a3601ef`.
PR CI passed at the same harness. The complete fixture took 400,601 milliseconds. The fault segment took 143,317 milliseconds.
Each recovery included diagnostics, saved workflow reads, durable checks, and both API replicas.

| Fault                  | Recovery milliseconds |
| ---------------------- | --------------------: |
| API interruption       |                 7,360 |
| Both worker hosts      |                 3,587 |
| External Redis         |                 4,676 |
| External PostgreSQL    |                77,545 |
| Kestra                 |                15,129 |
| Shared artifact access |                 3,707 |

Every recovery stayed within 180 seconds. Redis rejected the previous session, and fresh sign-in succeeded.
Each case preserved two principals, 75 original security events, thirteen grants, two access-change records, and two school definitions.
Credential and settings records, original artifact metadata and bytes, five completed Kestra executions, and the internal storage marker remained intact.
Distributed credential renewal and worker restart also passed. Fixture cleanup removed its owned resources.

The [retained report](../../deployment/evidence/CC-58-service-faults.json) preserves all original fields and three source-report hashes.
The archive matches its published SHA-256 digest. Synthetic providers and shared physical infrastructure remain qualification limits.
Network, certificate, capacity, live Google faults, and complete CC-58 acceptance remain open.

## Certificate fault increment

The `api-e2e:phase3-hybrid-certificate-fault-integration` target runs the extracted Phase 3 installation and public workflows.
It uses the service fault probe to preserve customer policy, credentials, grants, receipts, principals, preferences, audits, artifacts, and Kestra state.
The fixture replaces only certificates in the owned edge runtime volume.
A verified TLS client must reject an expired certificate and a certificate for another hostname with their exact TLS error codes.
A valid replacement must restore authenticated diagnostics, saved workflow reads, both API replicas, and durable state within 180 seconds.
The fixture then restores every original secret byte and repeats application checks.

Separate certificate reports retain application and harness identities, case results, recovery times, and duration scope.
A failed case remains in the uploaded progress report. Raw errors and secret bytes remain excluded.
The three Docker daemons still share one physical host and synthetic district services.
This increment requires hosted qualification. It does not establish district certificate lifecycle or complete fault acceptance.

## Passed initial restore checkpoint

[Run 35245956954](https://github.com/CampusCommander/campus-commander/actions/runs/35245956954) passed isolated restore at harness `6614bcf` against signed application `a3601ef`.
PR CI passed. The complete fixture took 306,760 milliseconds. The restore segment took 98,940 milliseconds.
The delivered operator commands created five encrypted backup files, verified the backup, restored isolated services, and revalidated the synthetic Google customer.
The delivered installer prepared the target, replaced bootstrap generation 1 with generation 2, installed the application, and resumed it.
The target rejected the source bootstrap identity and source sessions through both API replicas.

The restored state preserved two principals, thirteen grants, one access-change receipt, two capability observations, and 60 original security events.
Customer settings, school definitions, artifact metadata and bytes, migration checksums, and four Kestra execution rows survived.
Three invitations remained revoked. Both recipient bindings, both pending callbacks, and the issued link failed against the target.
Callback rejection occurred after 55,289 milliseconds. The original callback succeeded after source restart.
Fresh target browser checks read customer settings and the school definition. All four diagnostics passed.

Source application services and PostgreSQL remained stopped during target checks. Source Redis remained paused.
The target used fresh external PostgreSQL and Redis with separate storage and Compose projects.
The [retained report](../../deployment/evidence/CC-58-restore.json) preserves all original fields and both report hashes.
The archive matches its published SHA-256 digest.

Report inspection found an empty Kestra internal storage tree in this run.
This checkpoint establishes execution-row preservation but does not establish nonempty Kestra file recovery.
The fixture requires a nonempty storage sample before complete restore acceptance. Full CC-58 acceptance remains open.

## Nonempty internal storage correction

The source fixture now writes a UTF-8 marker into the owned Kestra internal storage directory after source shutdown.
The native operator container includes that file in the encrypted backup.
Restored file paths and hashes must match the complete source tree before target startup.
The snapshot verifier rejects empty source and target trees. Its regression reproduced the previous false acceptance.
Local API tests, hybrid fixtures, lint, formatting, and both reviews pass.
This correction requires another hosted restore run. The initial passed report remains unchanged.

## Capacity fault increment

The `api-e2e:phase3-hybrid-capacity-fault-integration` target uses an owned 16 MiB tmpfs artifact volume across three Docker daemons.
The fixture verifies the volume label, options, size, and filesystem type before writing.
One worker fills the capped volume until ENOSPC. Both API replicas and both workers must observe zero available space.
An authenticated artifact diagnostic must fail with a correlation identifier.
Artifact metadata and file names must remain unchanged. The shared durable probe also verifies policy, credentials, grants, receipts, and preserved application state.

Cleanup removes the fixture filler before recovery checks.
Diagnostics, saved workflow reads, both API replicas, durable checks, and restored capacity must pass within 180 seconds.
Separate reports retain the selected mode, identities, fault observations, failure stage, and duration scope.
This increment requires hosted qualification. Temporary storage does not establish district capacity or persistent storage acceptance.

## Passed certificate fault checkpoint

[Run 35246760613](https://github.com/CampusCommander/campus-commander/actions/runs/35246760613) passed at harness `53d1095` against signed application `a3601ef`.
PR CI passed at the same harness. The complete fixture took 271,504 milliseconds. The certificate segment took 29,595 milliseconds.
The expired certificate produced `CERT_HAS_EXPIRED`. Recovery took 5,280 milliseconds.
The wrong-host certificate produced `ERR_TLS_CERT_ALTNAME_INVALID`. Recovery took 5,383 milliseconds.
Both cases passed authenticated diagnostics, saved workflow reads, replica checks, and durable state checks within 180 seconds.

Each case preserved two principals, 75 original security events, thirteen grants, two access-change records, and two school definitions.
Credential and settings records, artifact metadata and bytes, five completed Kestra executions, and the internal storage marker remained intact.
The fixture restored every original secret byte. Distributed credential renewal and worker restart also passed.
The [retained report](../../deployment/evidence/CC-58-certificate-faults.json) preserves all original fields and three source-report hashes.
Its archive matches the published SHA-256 digest.
District certificate lifecycle, remaining fault groups, and complete CC-58 acceptance remain open.

## Passed nonempty storage restore checkpoint

[Run 35247457432](https://github.com/CampusCommander/campus-commander/actions/runs/35247457432) passed at harness `1bd9a89` against signed application `a3601ef`.
The complete fixture took 399,362 milliseconds. The restore segment took 119,285 milliseconds.
The backup contained six encrypted files. The restored Kestra tree included the exact `.phase3-restore-marker` path and byte hash.
The complete source and target file trees matched before target startup.

The target preserved application records, original audit events, artifact bytes, migration checksums, and four Kestra execution rows.
Controlled bootstrap replacement advanced generation 1 to generation 2. The source bootstrap credential remained invalid.
Both API replicas rejected source sessions. The target rejected all held source admissions within 70,492 milliseconds.
The source callback control passed after source restart. Fresh target browser checks and all four diagnostics passed.

The [retained report](../../deployment/evidence/CC-58-nonempty-storage-restore.json) preserves all original fields and both source-report hashes.
Its archive matches the published SHA-256 digest. The initial restore report and all failed attempts remain unchanged.
This checkpoint closes the empty storage sample gap. Synthetic providers and shared physical infrastructure remain qualification limits.
Complete CC-58 acceptance remains open.

## Provider fault increment

The `api-e2e:phase3-hybrid-provider-fault-integration` target uses the shared public provider checks across the owned hybrid fixture.
Synthetic cases cover Google network failure, quota exhaustion, denied domain privileges, and a mismatched customer.
Retired credential generations must fail. Failed health checks must preserve the complete connection, customer identity, and previous successful observation time.
Local diagnostics must continue. A fresh application sign-in must succeed during the synthetic Google outage.

Every recovery must restore capability checks, saved workflow reads, both API replicas, and durable state within 45 seconds.
The durable probe excludes connection observation fields that successful health checks refresh. It still compares all other connection fields.
Policy, credentials, grants, receipts, principals, preferences, audits, artifacts, and Kestra state must remain intact.
Fault controls update only the three owned hosts. Symbolic links and foreign fixture paths cannot redirect those writes.
Failed reports retain public case results and clear the synthetic fault without exporting raw errors.

This increment requires hosted qualification. It does not establish live Google privileges, revocation, or Education capabilities.
Complete CC-58 acceptance remains open.

## Passed capacity fault checkpoint

[Run 35248551259](https://github.com/CampusCommander/campus-commander/actions/runs/35248551259) passed at harness `80ac14d` against signed application `a3601ef`.
The complete fixture took 257,924 milliseconds. The capacity segment took 13,587 milliseconds.
Both API replicas and both worker daemons observed zero available space in the owned 16 MiB tmpfs volume.
The authenticated artifact diagnostic failed with a correlation identifier. Artifact metadata and file names remained unchanged.

Recovery took 4,526 milliseconds against the 180-second bound. All four consumers recovered their original 16,773,120 available bytes.
Saved workflow reads, replica checks, and durable checks passed.
Two principals, 75 original security events, thirteen grants, two access-change records, and two school definitions remained intact.
Credential and settings records, artifact bytes, five completed Kestra executions, and internal storage also remained intact.
Distributed credential renewal and worker restart passed.

The [retained report](../../deployment/evidence/CC-58-capacity-faults.json) preserves all original fields and three source-report hashes.
Its archive matches the published SHA-256 digest.
This checkpoint does not establish district capacity or persistent storage acceptance. Complete CC-58 acceptance remains open.

## Passed provider fault checkpoint

[Run 35249190946](https://github.com/CampusCommander/campus-commander/actions/runs/35249190946) passed at harness `b783baf` against signed application `a3601ef`.
PR CI passed. The complete fixture took 266,147 milliseconds. The provider segment took 24,260 milliseconds.
Network, quota, denied domain privileges, and wrong-customer cases returned the expected capability failure.
Their recovery times were 2,521, 2,535, 2,517, and 2,516 milliseconds. Each stayed within 45 seconds.

All cases preserved the complete connection during failure and retained the previous successful observation time.
Local diagnostics passed. A fresh application sign-in also passed during the synthetic Google outage.
Recovery passed saved workflow reads, both API replicas, and durable checks. Retired credential generation checks passed.
Each case preserved policy, credentials, two principals, 75 original security events, artifact bytes, and five completed Kestra executions.
Distributed credential renewal and worker restart also passed.

The [retained report](../../deployment/evidence/CC-58-provider-faults.json) preserves all original fields and three source-report hashes.
Its archive matches the published SHA-256 digest.
Live Google privileges, revocation, Education capabilities, and complete CC-58 acceptance remain open.

## Lifecycle and external retention increment

The `api-e2e:phase3-hybrid-lifecycle-integration` target verifies durable state after restart, stop/resume, and uninstall/resume.
The delivered CLI must reject erasure without the exact project confirmation. That rejection must preserve volumes and durable state.
The fixture stops writers before measuring external state. It then runs delivered confirmed controller erasure.
Controller erasure must remove owned volumes and require separate action on each worker host.
The fixture verifies that worker containers remain before it explicitly removes their owned resources through Compose.

External PostgreSQL and Redis must retain their original container identities and remain available.
Application records, migration checksums, completed Kestra executions, artifact files, and nonempty internal storage must remain unchanged.
A protected Redis marker, every private file, and an unrelated control volume must survive both erasure stages.
The fixture restores the original operator file and removes its labeled control volume before reporting success.
Separate progress evidence records failed stages without raw errors.

The passed lifecycle checkpoint below records hosted qualification. District acceptance remains open.

## Guided update increment

The `api-e2e:phase3-hybrid-update-integration` target requires two separately verified Phase 3 laboratory releases.
It loads target images on the controller and both worker daemons before update.
The delivered native operator creates and verifies a cold backup after application writers stop.
The fixture restarts the installed release before testing the delivered target setup command.

A cancelled update must preserve configuration, operator files, installer state, and durable records.
Confirmed update must report `prepared-workers-pending` when the operator has not completed the worker handoff.
The original authoritative inputs must remain unchanged while the update journal records the staged target.
The fixture transfers generated worker fragments and starts target workers on both worker daemons.
Delivered setup `resume` must then complete the update and remove the journal.

The target must preserve configuration, all original private files across three hosts, and original migration checksums.
The durable probe permits appended migrations but rejects rewritten or removed original migrations.
Actual container image identities must match the target release on all three daemons.
Saved workflows, authenticated diagnostics, dark theme, and both API replicas must pass after update and repeated resume.
A repeated update must report `already-current`. Distributed background renewal runs after browser closure against the updated workers.

Reports distinguish source and target releases, commands, worker handoff, backup identity, durations, preserved state, and measured limits.
Failed runs retain the current stage without raw errors. The passed guided-update checkpoint below records hosted qualification.

## Passed lifecycle checkpoint

[Run 35250328648](https://github.com/CampusCommander/campus-commander/actions/runs/35250328648) passed at harness `1261d96` against signed application `a3601ef`.
PR CI passed. The complete fixture took 249,014 milliseconds. The lifecycle segment took 102,123 milliseconds.
Restart, stop/resume, and uninstall/resume preserved their original durable records, including 51 security events and two completed Kestra executions.
The delivered CLI rejected unconfirmed erasure without changing volumes or fresh external state.

Confirmed controller erasure removed ten owned volumes and reported the separate worker action.
Both worker hosts retained their containers until explicit fixture Compose erasure removed their two owned volumes each.
External PostgreSQL and Redis retained their container identities and remained available through both erasure stages.
The quiesced external snapshot preserved two principals, thirteen grants, two access changes, 84 security events, and fifteen migration records.
Credential, connection, settings, schools, artifact metadata and bytes, five completed Kestra executions, and nonempty internal storage remained intact.
The Redis marker, private files, and unrelated volume survived. Cleanup restored the original operator file and removed the control volume.

The [retained report](../../deployment/evidence/CC-58-lifecycle.json) preserves all original fields and three source-report hashes.
Its archive matches the published SHA-256 digest.
District acceptance and prerequisite acceptance remain open.

## Hybrid report inventory

The [profile inventory](../../deployment/evidence/CC-58-profile-evidence.json) binds five distinct report categories to signed application `a3601ef` and its manifest.
Each entry records the retained file size and SHA-256 hash.
Supplemental reports cover installed workflows, distributed credential renewal, replica permissions, lifecycle, and guided update.

| Report       | Evidence                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| Installation | [Delivered installation](../../deployment/evidence/CC-58-installation.json)                                          |
| Resume       | [Delivered repeated resume](../../deployment/evidence/CC-58-resume.json)                                             |
| Upgrade      | [Pinned Phase 2 upgrade with native operator commands](../../deployment/evidence/CC-58-native-operator-upgrade.json) |
| Restore      | [Isolated restore with nonempty storage](../../deployment/evidence/CC-58-nonempty-storage-restore.json)              |
| Faults       | [Service, provider, certificate, and capacity groups](../../deployment/evidence/CC-58-faults.json)                   |

The fault aggregate references four independent runs against the same application. All thirteen fault cases passed their recorded recovery bounds.
Every source report retains its preservation checks, provenance, and measured limits.
The inventory remains incomplete until prerequisite acceptance finishes.
It does not transfer source results to the guided-update target or permit full release assembly.

## Passed guided-update checkpoint

[Run 35251131690](https://github.com/CampusCommander/campus-commander/actions/runs/35251131690) passed at harness `bc5fc10`.
The source application was `a3601ef`. The target application was `eb78e16`. Each release retained its distinct manifest and image identities.
The complete fixture took 360,801 milliseconds. The guided-update segment took 77,270 milliseconds.

Delivered native commands created and verified the cold backup.
Cancelled update preserved configuration, operator files, installer state, and durable records.
The target setup command reported `prepared-workers-pending` before both worker hosts received generated fragments.
Delivered setup resume completed the update. Repeated update reported `already-current`.
Actual container images matched the target release on all three daemons.

The update preserved private files, original migration checksums, two principals, 75 original security events, thirteen grants, and two access changes.
Connection, credentials, settings, schools, artifact bytes, and five completed Kestra executions remained intact.
Nonempty internal storage, saved workflows, authenticated diagnostics, dark theme, and both API replicas passed.
The update journal was absent after completion. Repeated delivered resume passed.

Background renewal after browser closure passed in 9,016 milliseconds. Both updated worker hosts participated.
Renewal events increased from one to two during concurrent reads and stayed at two after restart.
Worker restart recovered in 2,132 milliseconds within the 30-second bound.

The [retained report](../../deployment/evidence/CC-58-guided-update.json) preserves all original fields and three source-report hashes.
Its archive matches the published SHA-256 digest.
Source installation and fault results do not qualify the target release. Prerequisite acceptance and complete CC-58 acceptance remain open.
