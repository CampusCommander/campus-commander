# Phase 3 Kubernetes qualification

[CC-59](https://easton-consulting.atlassian.net/browse/CC-59) requires extracted installation, resume, Phase 2 upgrade, isolated restore, and fault evidence.
The task remains incomplete. No Phase 3 Kubernetes hosted result exists yet.

## Installation boundary

The fixture will install a separately verified Phase 3 laboratory bundle through its delivered installer.
Application image labels, manifest identity, and inventory hashes must match before cluster changes.
Installer commands must record their source root, result, and duration.
The fixture must reject Phase 2 mode flags during Phase 3 qualification.

A dedicated three-node Kind cluster provides one controller node and two worker nodes.
The current Kind fixture uses default networking. It does not enforce NetworkPolicy.
Initial installation results must retain this limitation. Network-policy acceptance requires an enforcing CNI and measured allowed and denied traffic.
Synthetic shared host storage does not establish independent physical failure domains or district storage acceptance.
Synthetic TLS does not establish district browser trust.

## Application and credential checks

Public workflows must cover customer confirmation, settings, invitations, grants, school boundaries, revocation, and credential replacement.
Both API replicas must enforce current session and permission versions.
A replaced API pod must preserve shared sessions and saved state.
Worker rescheduling must preserve shared artifact access and background credential behavior.

Only authorized API and worker consumers can receive the versioned Google credential key.
Checks must inspect actual pod volumes, read-only mounts, key versions, and byte equality without exporting private material.
Retired credential generations and unauthorized worker dispatch must fail.
Distributed renewal must demonstrate the pending lease, one renewal, and successful background reads after browser closure.

## Upgrade and recovery

The Phase 2 upgrade must use the pinned accepted implementation bundle and its own delivered installer.
The Phase 3 installer must preserve principals, preferences, artifacts, audit records, private files, and original migration checksums.
Native backup and verification commands must precede upgrade.

Isolated restore must use separate namespaces and persistent volumes.
Source services must remain unavailable during restored application verification.
Restored records and nonempty storage must match the source backup.
Old sessions, pending admissions, and revoked bootstrap credentials must fail against the target.
Controlled bootstrap replacement and fresh authenticated reads must pass before recovery acceptance.

## Evidence and remaining work

Five distinct report categories must cover installation, resume, upgrade, restore, and faults.
Each report must identify the application, harness, image digests, manifest, storage, node placement, measured durations, and limits.
Failure evidence must retain safe stages without tokens, credentials, or raw provider errors.
Fixture cleanup must remove only owned resources.

Hosted installation, replica and renewal checks, enforcing CNI checks, upgrade, restore, faults, operator lifecycle, and report assembly remain open.
CC-54, CC-55, and CC-56 prerequisite acceptance remains open.
Live Google privileges, Education capabilities, district infrastructure, and human accessibility require separate evidence.
Applicable UI rules are UI-01, UI-08, UI-09, UI-10, and FORM-01.
This qualification work changes no product controls.

## Initial implementation increment

The `api-e2e:phase3-kubernetes-install-integration` target requires an extracted Phase 3 release and rejects Phase 2 mode flags.
The harness verifies bundle inventory and exact image labels before it creates the cluster.
The delivered installer prepares the installation and executes repeated resume, stop/resume, and uninstall/resume.
A separate synthetic transport overlay supports public Phase 3 workflows on the delivered API and worker images.

Actual pod checks verify credential-key byte equality, version, file mode, read-only mounts, and exact application image digests.
Unrelated pods and containers must exclude the credential key.
Both workers must occupy distinct Kind nodes.
Browser workflows verify saved state after API replacement and each lifecycle resume.
Replica checks verify shared sessions and session rejection after lifecycle commands and sign-out.
These checks do not establish distributed renewal or the complete policy acceptance matrix.

CI installs a digest-verified Kind binary and runs the fixture as UID 1000.
CI rejects unsupported Kubernetes modes before resource changes.
Installation and resume reports retain separate duration scopes, source identity, manifest hash, command durations, pod placement, and fixture limits.
Safe failure reports retain the current stage. Successful reports require owned-cluster removal.
Hosted qualification remains pending.

## Renderer correction required for qualification

The key-exclusion regression reproduced unnecessary Google-key mounts in database-wait containers.
Delivery commit `0abf75e` replaces inherited service mounts with configuration and separate database password and CA projections.
Regression checks cover API, worker, and Kestra wait containers and both configured Google-key versions.
Bootstrap tests, Kubernetes renderer tests, lint, and both review axes pass.
Kubernetes hosted qualification requires a new signed laboratory bundle containing this correction.
The older `a3601ef` and `eb78e16` bundles do not contain this correction.

## Replica permission increment

Installed admission workflows now replay the saved recipient session against both current API pods.
Grant changes and revocation must invalidate that session on both pods.
A fresh scoped session must read its granted school and reject both ungranted and unknown schools with the same response.
The shared permission probe applies these assertions to hybrid containers and Kubernetes pods.
Kubernetes sends saved cookies through standard input. Process arguments and returned evidence contain no cookie values.
The existing session probe uses the same bounded TLS reader.
Hosted qualification remains pending.

## Distributed worker renewal increment

After browser closure, both workers must reject unauthorized dispatch, supplied credential fields, and retired credential generations.
Both workers must complete current-generation Google reads.
The fixture advances its owned token expiry and holds synthetic renewal while another worker observes the real pending lease.
Concurrent reads must produce one renewal event and one encrypted stored token.

Worker replacement must create new pod identities on two distinct nodes.
Replacement workers must reuse the stored token without another renewal and recover within 180 seconds.
Reports retain pod identities, node placement, dispatch results, renewal counts, pending-lease observations, and measured recovery time.
Private credentials and token values remain absent from reports.
Worker-only instrumentation uses an ephemeral observation volume. It does not change database lease results.
Hosted qualification remains pending.
