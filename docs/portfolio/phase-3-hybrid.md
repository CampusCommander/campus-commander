# Phase 3 hybrid qualification

[CC-58](https://easton-consulting.atlassian.net/browse/CC-58) requires extracted installation, resume, Phase 2 upgrade, restore, faults, and operator lifecycle evidence.
The task remains incomplete.
Installation, resume, Phase 2 upgrade, installed workflows, key projection, distributed credential renewal, and replica permission checks have passed hosted qualification.
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

Hybrid dispatch supports installation and Phase 2 upgrade modes.
Fault, lifecycle, and guided-update modes require their own Phase 3 fixtures before dispatch can accept them.
The existing Phase 2 targets retain their previous modes.

## Remaining evidence

- Isolated restore with backup identity, recovered credentials, and rejected source admissions.
- Service, network, certificate, and credential faults with bounded recovery and preserved state.
- Guided update, retained external resources, and explicit erasure contracts.
- Five completed profile reports and prerequisite acceptance.

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
