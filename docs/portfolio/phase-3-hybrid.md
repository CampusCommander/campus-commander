# Phase 3 hybrid qualification

[CC-58](https://easton-consulting.atlassian.net/browse/CC-58) requires extracted installation, resume, Phase 2 upgrade, restore, faults, and operator lifecycle evidence.
The task remains incomplete.

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

This increment rejects hybrid upgrade, fault, lifecycle, and guided-update mode combinations.
Those modes require their own Phase 3 fixtures before dispatch can accept them.
The existing Phase 2 targets retain their previous modes.

## Remaining evidence

- Hosted installation, resume, workflow, and key-projection results.
- Pinned Phase 2 upgrade with preserved state and migration checksums.
- Isolated restore with backup identity, recovered credentials, and rejected source admissions.
- Permission revocation and credential renewal checks across both worker hosts.
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

The workflow regression failed before the correction. Hosted qualification must verify the correction against the original failure.
The original failure reports remain intact. This correction does not establish successful installation.

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

The regression and API fixture lint pass. The correction requires hosted validation before installation qualification can pass.

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

This increment requires hosted execution. It does not complete permission revocation, upgrade, restore, fault recovery, or hybrid acceptance.

## Passed installation checkpoint

[Run 35230914506](https://github.com/CampusCommander/campus-commander/actions/runs/35230914506) passed with harness `253221a` against signed application `a3601ef`.
All ten installed workflows, shared sessions, logout rejection, restart, stop/resume, and uninstall/resume checks passed.
Both API replicas and both worker daemons received the correct credential key through read-only staged volumes.
The complete fixture took 212,787 milliseconds. Installation commands took 26,710 milliseconds. Four resume commands took 61,169 milliseconds.

The retained [installation](../../deployment/evidence/CC-58-installation.json), [resume](../../deployment/evidence/CC-58-resume.json), and [workflow](../../deployment/evidence/CC-58-installed-workflows.json) reports preserve original fields and three source-report hashes.
Their source, images, and manifest identify the delivered application. Their harness revision identifies the executed checks.
Three Docker daemons share one physical host. This checkpoint does not establish the new distributed-renewal checks or complete hybrid acceptance.
