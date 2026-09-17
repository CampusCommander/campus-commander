# Phase 3 Kubernetes qualification

[CC-59](https://easton-consulting.atlassian.net/browse/CC-59) requires extracted installation, resume, Phase 2 upgrade, isolated restore, and fault evidence.
The task remains incomplete. Initial installation, resume, replica, worker, and internal network-policy checks passed in the hosted laboratory.

## Installation boundary

The fixture installs a separately verified Phase 3 laboratory bundle through its delivered installer.
Application image labels, manifest identity, and inventory hashes must match before cluster changes.
Installer commands must record their source root, result, and duration.
The fixture must reject Phase 2 mode flags during Phase 3 qualification.

A dedicated three-node Kind cluster provides one controller node and two worker nodes.
The Kind fixture uses default networking. Measured checks prove worker-to-Redis and worker-to-Kestra TCP pod isolation.
Service-address behavior and Google-provider egress require separate evidence.
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

Upgrade, restore, faults, complete operator lifecycle, service-address and Google-egress checks, and final report assembly remain open.
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
The worker increment below establishes distributed renewal. The complete policy acceptance matrix remains open.

CI installs a digest-verified Kind binary and runs the fixture as UID 1000.
CI rejects unsupported Kubernetes modes before resource changes.
Installation and resume reports retain separate duration scopes, source identity, manifest hash, command durations, pod placement, and fixture limits.
Safe failure reports retain the current stage. Successful reports require owned-cluster removal.
The hosted result below records this increment.

## Renderer correction required for qualification

The key-exclusion regression reproduced unnecessary Google-key mounts in database-wait containers.
Delivery commit `0abf75e` replaces inherited service mounts with configuration and separate database password and CA projections.
Regression checks cover API, worker, and Kestra wait containers and both configured Google-key versions.
Bootstrap tests, Kubernetes renderer tests, lint, and both review axes pass.
The signed `phase-3-lab-0abf75ed6f03` bundle contains this correction.
The older `a3601ef` and `eb78e16` bundles do not contain this correction.

## Replica permission increment

Installed admission workflows now replay the saved recipient session against both current API pods.
Grant changes and revocation must invalidate that session on both pods.
A fresh scoped session must read its granted school and reject both ungranted and unknown schools with the same response.
The shared permission probe applies these assertions to hybrid containers and Kubernetes pods.
Kubernetes sends saved cookies through standard input. Process arguments and returned evidence contain no cookie values.
The existing session probe uses the same bounded TLS reader.
The hosted result below records this increment.

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
The hosted result below records this increment.

## Network-policy evidence correction

[Kind v0.33.0 source](https://github.com/kubernetes-sigs/kind/blob/v0.33.0/images/kindnetd/cmd/kindnetd/main.go) includes a NetworkPolicy controller.
The previous statement that default Kind networking cannot enforce policies was incorrect for this pinned version.
Controller initialization can skip policy processing after an error. The controller configuration also enables fail-open behavior.
Source inspection does not prove runtime enforcement. The fixture must record actual networking images and measure allowed and denied traffic.

## First hosted attempt

[Run 35255775913](https://github.com/CampusCommander/campus-commander/actions/runs/35255775913) failed against signed application `0abf75e` and harness `297edf0`.
The original report identifies only the installed workflows and lifecycle stage.
It does not identify the failing assertion.
`CC-59-installation-failure-1.json` retains every original field and verified archive provenance.
The failed fixture took 266,651 milliseconds before cleanup.
No hosted Kubernetes pass is claimed.

The next attempt records narrower fixture stages and bounded source locations from known fixture files.
Reports still omit raw error messages, assertion values, URLs, and command output.
The diagnostic regression checks private-marker exclusion and rejects unrelated source paths.
This increment changes evidence collection only.

## Runtime image preparation attempt

[Run 35257141763](https://github.com/CampusCommander/campus-commander/actions/runs/35257141763) failed before the earlier workflow failure.
The job reached runtime image preparation, but the report retained the preceding cluster stage.
The command rejection contained no fixture source locations.
`CC-59-installation-failure-2.json` preserves the original report and verified archive provenance.
Its duration was 60,630 milliseconds before cleanup.

The next attempt separates image retrieval, archive creation, and node import stages.
A fixed command error preserves asynchronous fixture call sites without printing the original command failure.
The first workflow failure remains unresolved.

## Internal network-policy increment

The fixture now measures worker-to-Redis and worker-to-Kestra TCP pod paths after worker credential checks.
Both workers must occupy distinct nodes and retain exact image identities.
An API pod must reach each target before and after every worker probe.
Both worker paths must time out, connect under temporary narrow policies, then time out after those policies disappear.
Socket errors and unavailable targets cannot prove policy denial.

Every probe command uses the remaining 30-second convergence deadline.
Temporary policies carry unique ownership markers.
Cleanup reconciles uncertain creation results and checks namespace, ownership, and policy content before deletion.
Original policies must retain their identities and content hashes.
Reports record node versions, CNI image identities, control policies, and measured connection outcomes.
Failed reports preserve observations without raw command errors.

Regression checks reproduced late acceptance and incomplete cleanup after a lost creation response.
The corrected checks pass, including rejected creation and foreign-resource preservation.
Both reviews passed the helper corrections. The hosted result below verifies the stated internal pod paths.
These checks do not establish service-address behavior, Google egress, district TLS, or independent physical hosts.

## Credential-key material correction

[Run 35257810791](https://github.com/CampusCommander/campus-commander/actions/runs/35257810791) reached credential-candidate creation and failed its response-status assertion.
Safe source locations identified that request without exposing its credential payload.
`CC-59-installation-failure-3.json` retains the original report and verified archive provenance.
The fixture took 313,300 milliseconds before cleanup.
This attempt completed image preparation. The preceding image-preparation failure still has no confirmed cause.

The fixture supplied 44 bytes of base64 text as an encryption key.
The application requires 32 raw key bytes.
A local regression reproduced `key-unavailable` through the actual credential cipher after Kubernetes Secret encoding and projection.
The correction supplies raw key bytes and encodes only the Kubernetes Secret data representation.
Actual pod verification now checks the projected key length before public workflows.
The regression passes with this correction. The hosted result below verifies credential-candidate creation.
This change corrects the qualification fixture and does not require another application image.

## Initial hosted qualification passed

[Run 35259178631](https://github.com/CampusCommander/campus-commander/actions/runs/35259178631) passed with application `0abf75e` and clean harness `310b29e`.
The complete fixture took 531,429 milliseconds, including owned-cluster removal.
The four delivered resume commands took 88,042 milliseconds in total.
Prepare, stop/resume, uninstall/resume, and all ten installed workflow checks passed.
The fixture preserved state after API replacement and worker rescheduling.

Sixteen recipient observations verified grant changes, scoped access, hidden-school denials, and revocation across both API pods.
Sixteen separate session observations covered API replacement, worker rescheduling, lifecycle session invalidation, and sign-out.
Initial and final key checks passed for both API pods and both workers.
Those checks require exact key bytes, version, read-only mounts, file mode `0440`, and exclusion from unrelated consumers.

Worker credential checks took 33,978 milliseconds after browser closure.
The fixture observed one renewal owner and a different pending worker within 1,259 milliseconds.
Renewal-event counts progressed from one to two and remained two after worker replacement.
Replacement recovery took 25,262 milliseconds against the 180-second bound.
Unauthorized dispatch, supplied credential fields, and retired generations failed as required.

Internal network-policy checks took 16,318 milliseconds.
Twenty-four observations recorded eight worker denials, four temporary worker allowances, and twelve successful API controls.
All four temporary policies were removed. Fifteen original policies retained their identities and content hashes.
The report records Kubernetes `v1.35.8`, containerd `2.3.4`, kernel `6.17.0-1022-azure`, and actual Kindnet image digests.
Three nodes still share one physical host and synthetic storage.

`CC-59-installation.json`, `CC-59-resume.json`, and `CC-59-network-policy.json` retain every original report field and verified archive provenance.
`CC-59-profile-evidence.json` binds their retained bytes by size and SHA-256.
It records two report categories and one supplement. It remains incomplete.
The earlier failed reports remain available. The image-preparation failure still has no confirmed cause.
This pass does not close CC-59, prerequisite acceptance, or Phase 3.

## Next upgrade boundary

The upgrade fixture must verify the pinned Phase 2 bundle and Phase 3 target before cluster changes.
Initial commands must use the delivered Phase 2 installer. Upgrade commands must use the delivered Phase 3 installer.
The older Kubernetes backup helper calls workspace code and injects database tools.
The Phase 3 fixture must instead execute native tools through the delivered operator CLI.
It must generate a recovery key, stop writers, create a cold backup, and verify that backup before upgrade.

Preservation checks must compare two principals, preferences, nonempty artifact bytes and metadata, audit records, existing secrets, and original migration checksums.
Target checks must verify exact images, appended migrations, updated installer state, repeated resume, and installed Phase 3 workflows.
Separate baseline and target identities must remain in the report.
