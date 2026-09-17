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
