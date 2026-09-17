# Phase 3 delivery qualification

[CC-57](https://easton-consulting.atlassian.net/browse/CC-57) requires actual extracted-installer installation, resume, Phase 2 upgrade, restore, and fault qualification.
[CC-58](https://easton-consulting.atlassian.net/browse/CC-58) and [CC-59](https://easton-consulting.atlassian.net/browse/CC-59) require equivalent hybrid and Kubernetes evidence.
[CC-60](https://easton-consulting.atlassian.net/browse/CC-60) binds the completed evidence to the signed release.
None of these tasks is complete.

## Candidate assembly

The first delivery increment permits Phase 3 laboratory candidate assembly with packaged authorization evidence.
It requires the exact source revision, image references, completed scanner inventory, feature reports, and shared route-boundary inventory.
The scanner hashes bind reports without their own revision fields to the same completed authorization run.
Assembly copies all inventoried reports and screenshots. It verifies their hashes again during copying.
The candidate includes committed installer sources, runtime dependencies, compiled deployment output, and image provenance.

The manifest declares Phase 3, laboratory validation, and candidate-only status.
All fifteen profile checks remain unexecuted. The assembler rejects full Phase 3 mode until profile qualification supports the complete release.
Laboratory candidates cannot enter the qualified-release assembler.
This intermediate artifact supports the next extracted-installer qualification work. It does not replace the approved release requirements.

## Current validation

Local release tests and deployment and API fixture lint pass.
Negative tests reject wrong phases, source revisions, images, missing reports, changed bytes, incomplete boundaries, and failed scanner results.
They reject missing secret categories, missing browser artifacts, and accessibility violations.
Packaging writes the verified bytes directly and preserves executable permissions.
The validator also accepts the actual packaged artifacts from [run 35207924636](https://github.com/CampusCommander/campus-commander/actions/runs/35207924636).
That local inspection verifies 79 files, including the scanner report, at source revision `49ebf07`.
It does not reexecute the application or publish a candidate.

## Required qualification

1. Publish and independently verify immutable image and candidate signatures for the exact committed source.
2. Extract the verified candidate and run the delivered installer for clean installation and repeated resume.
3. Upgrade the pinned accepted Phase 2 artifact and compare identity, preferences, artifacts, installer state, and migration checksums.
4. Execute every Phase 3 customer, credential, settings, invitation, access, school, and revocation workflow after installation and upgrade.
5. Restore the complete state into isolated resources and reject copied sessions and pending admissions.
6. Qualify restart, capacity, provider, credential, certificate, update, stop, uninstall, and erasure behavior for each profile.
7. Bind fifteen distinct profile reports and application evidence to exact source, image, manifest, and file hashes.
8. Obtain operator acceptance and record human accessibility and live Google limits without marking unexecuted checks as passed.

Applicable UI rules remain UI-01, UI-08, UI-09, UI-10, and FORM-01.
This packaging increment changes no product controls. Its automated fixture tests do not provide new product UI evidence.

## Signed laboratory workflow

The registered Phase 2 dispatcher calls the Phase 3 workflow when `phase=3` and `mode=lab`.
Full mode stops before image publication. The default dispatcher behavior remains Phase 2.

```sh
gh workflow run phase-2-candidate.yml \
  --ref codex/cc-57-phase3-delivery -f phase=3 -f mode=lab
```

The workflow scans and signs immutable images before packaged authorization tests.
It assembles and signs the candidate only after those tests pass.
A separate job verifies image, archive, and manifest signatures before extraction.
It then runs the extracted installer for installation, repeated resume, lifecycle checks, and isolated restore.
The restore uses the extracted operator CLI and verifies preserved Phase 3 state and rejected copied admissions.
The qualification report binds both reports to the source revision, image digests, and extracted manifest hash.
It records command, environment, duration scopes, and report hashes. Upgrade and fault qualification remain `not-run`.

Only successful extracted qualification permits the immutable `phase-3-lab-<revision12>` prerelease.
The hosted installer trusts the fixed Phase 3 workflow identity and verifies both blobs and all three images.
Workflow implementation and local rejection tests do not establish a successful hosted run.

## Pinned Phase 2 upgrade source

The upgrade fixture uses `phase-2-lab-1b04fa38c1a4`, the implementation revision referenced by the Phase 2 acceptance record.
The owner did not identify the exact installed revision. This selection does not add that missing observation.
The baseline inventory pins three image digests, the source revision, archive hash, and manifest hash.
Independent hosted-installer verification passed both blob signatures, all three image signatures, and 1,363 inventoried files.
The verification used an isolated empty Docker configuration because the host configuration references an unavailable Windows credential helper.
This read-only verification does not establish Phase 2-to-Phase 3 upgrade behavior.

Baseline manifest: `deployment/qualification/phase-2-upgrade-baseline.json`.

## Initial encryption key during upgrade

The upgrade policy rejected valid Phase 2-to-3 configuration when the operator supplied the initial Google encryption key.
Regression tests reproduced that rejection in all three profiles.
The corrected comparison permits the new Phase 3 key configuration after schema validation.
It still rejects changed sign-in settings, storage, topology, downgrades, and same-phase key changes.
Installer tests and deployment lint pass. Both review axes found no remaining issues.
These policy tests do not establish complete upgrade execution.

## Signed image checkpoint

[Run 35210688406](https://github.com/CampusCommander/campus-commander/actions/runs/35210688406) passed validation and published all three signed images at `7ddf141`.
Independent Cosign verification passed for each digest against the fixed Phase 3 workflow identity and GitHub issuer.
[The verification record](../../deployment/evidence/CC-57-signed-image-verification.json) records digests, command, environment, durations, and limitations.
This checkpoint does not claim a signed archive, completed extracted qualification, or release acceptance.
The later initial-key correction requires its own applicable qualification. PR CI passed at `1a673dd`.

## Candidate path correction

Run 35210688406 passed packaged Phase 3 authorization. Independent inspection accepted its 79 evidence files.
Bundle smoke verification then rejected `node_modules/node-fetch/@types/index.d.ts` because the path allowlist excluded `@`.
No archive signature or laboratory release followed that failure. Extracted qualification did not run.
The same locked dependency reproduced the exact error locally.

Release verification and hosted archive and inventory checks now permit literal `@` characters.
Absolute paths, traversal, empty components, symlinks, oversized files, and changed checksums remain prohibited.
Regression tests cover the dependency path, unsafe paths, and changed bytes through both verification routes.
Release and installer tests and deployment lint pass. Both review axes found no remaining issues.
The corrected verifier also accepted all 1,284 files from the actual locked runtime installation.
[Run 35211855292](https://github.com/CampusCommander/campus-commander/actions/runs/35211855292) passed all Phase 3 candidate jobs at `a3601ef`.
It published `phase-3-lab-a3601eff2a55` after extracted installation, repeated resume, and isolated restore passed.
Independent hosted-installer verification passed both blob signatures, all three image signatures, and the extracted inventory.
The retained [qualification record](../../deployment/evidence/CC-57-extracted-lab-qualification.json) binds source, images, manifest, and report hashes.
Upgrade and fault qualification remain `not-run`.

## Published installation workflow qualification

`api-e2e:phase3-install-integration` installs the selected Phase 3 bundle through its delivered CLI.
It uses separate administrator and ordinary-user sessions to exercise public application workflows.
The checks cover customer confirmation, settings, school scopes, invitation redemption, explicit identity confirmation, grants, denial, revocation, and credential replacement.
After restart, the checks read saved settings, school scopes, credential generation, disabled access, and access receipts again.
The existing lifecycle checks still exercise repeated resume, stop, uninstall, fresh sign-in, and two API replicas.

The synthetic provider binds the selected subject to each authorization code.
Its local tests verify the token signature, nonce, PKCE, identity binding, and replay rejection.
A fixed-message error boundary prevents invitation fragments and authorization codes from entering recipient-flow failure logs.
The application uses synthetic Google and OIDC providers. These checks do not establish district privileges or human accessibility acceptance.

A separate read-only workflow can qualify an existing signed laboratory release:

```sh
gh workflow run ci.yml --ref codex/cc-57-phase3-delivery \
  -f phase3Release=phase-3-lab-<revision12>
```

The workflow verifies archive, manifest, and image signatures against the fixed Phase 3 publisher.
It validates the immutable tag, source revision, image digests, and extracted inventory before executing the installer.
The reports separate the delivered application revision from the qualification harness revision.
This permits new checks against unchanged published bytes without asserting that later product changes inherited earlier evidence.
The workflow produces `phase-3-installed-workflows` artifacts. Successful hosted execution remains required.

The first hosted workflow run, `35213575951`, verified the release and completed installation before failing during invitation admission.
The fixed error boundary prevented token disclosure but omitted the failing step.
Admission errors now identify a fixed, allowlisted step without retaining the original error or cause.
Regression tests reject unapproved labels and verify secret omission from failure stacks.
This diagnostic change does not claim a correction to the admission failure.

Diagnostic run `35214112562` isolated the failure to the school-access boundary assertion.
The fixture expected HTTP 403 for a school outside the granted scope.
The established API contract returns HTTP 404 with `school-not-found` for both inaccessible and unknown schools.
The corrected fixture requires that exact status and identical response bodies for both cases.
The correction changes qualification expectations. It does not change application authorization.

[Run 35214463198](https://github.com/CampusCommander/campus-commander/actions/runs/35214463198) passed all ten installed-workflow checks after that correction.
It used application revision `a3601ef` and harness revision `e1fb81e` with a clean harness checkout.
The complete profile took 176,766 milliseconds. The workflow and restart-persistence checks took 12,004 milliseconds within that profile.
The [retained report](../../deployment/evidence/CC-57-installed-workflows.json) records both revisions, images, manifest hash, report hashes, and limits.
It also records two-replica session checks, stop, uninstall, repeated resume, and preserved preferences after fresh sign-in.
PR CI passed at the same harness revision. Upgrade and complete fault qualification remain open.

## Phase 2-to-3 upgrade qualification

`api-e2e:phase3-upgrade-integration` installs the pinned Phase 2 bundle through its own delivered CLI.
The fixture uses the delivered Phase 3 CLI for the upgrade and subsequent lifecycle commands.
Before upgrade, it signs in, saves a theme preference, adds a second principal, and stores an artifact.
It stops application writers, creates a native encrypted backup, and verifies that backup through the delivered operator CLI.
The upgrade binds the previous installer release hash and the verified backup manifest hash.

After upgrade, the fixture compares both principals, preferences, artifact bytes, existing secrets, and every previous migration checksum.
It requires new migrations and an advanced installer configuration and release identity.
The fixture then runs all installed Phase 3 workflows and restart, stop, uninstall, and resume checks.
The upgrade report distinguishes baseline, application, and harness identities.

```sh
gh workflow run ci.yml --ref codex/cc-57-phase3-delivery \
  -f phase3Release=phase-3-lab-<revision12> -f phase3Upgrade=true
```

The workflow verifies both baseline blob signatures, pinned archive and manifest hashes, extracted files, and all baseline image signatures.
The fixture requires the exact pinned baseline manifest hash before it runs the installer.
Local rejection tests cover changed archives, manifest hashes, source revisions, image identities, and extracted files.
Hosted upgrade execution remains required. The pinned acceptance record does not identify the owner's exact previously installed revision.

Run `35216552096` verified both releases and all six image signatures before Nx rejected a duplicate `deployment` project.
The extracted Phase 2 baseline contained its own project metadata. The installer did not run.
A local duplicate-project fixture reproduced the same failure.
Nx now excludes `extracted-baseline/`, alongside the existing extracted-candidate exclusion.
The unchanged local fixture then passed project discovery. This check does not establish upgrade execution.

[Run 35216878990](https://github.com/CampusCommander/campus-commander/actions/runs/35216878990) passed the actual upgrade and all ten post-upgrade workflow checks.
The fixture installed baseline `1b04fa3` and upgraded to application `a3601ef` with harness `4386077`.
Both principals, their preferences, the artifact, existing secrets, and both previous migration checksums survived the upgrade.
The migration ledger advanced from two entries to fifteen. Native backup and verification completed before the upgrade.
The upgrade segment took 51,313 milliseconds. The complete profile took 220,114 milliseconds.

The [retained upgrade report](../../deployment/evidence/CC-57-phase2-upgrade.json) binds baseline, application, harness, image, manifest, and report identities.
It also records two-replica session checks, restart persistence, stop, uninstall, repeated resume, and preserved preferences after fresh sign-in.
PR CI passed at the same harness revision. Complete fault qualification and five distinct profile reports remain open.

## Installed service recovery

The `api-e2e:phase3-fault-integration` target installs the verified Phase 3 bundle and completes the installed workflows.
It then interrupts API, workers, Redis, application PostgreSQL, Kestra PostgreSQL, Kestra, and artifact access separately.
Each service fault recovery must complete within 180 seconds. Redis recovery requires a fresh session.

Each case preserves principals, preferences, migration checksums, security events, an artifact, completed Kestra executions, and internal storage.
The Phase 3 probe also compares hashes for customer connection, credentials, settings revisions, schools, grants, and access changes.
The database computes protected policy hashes. Reports contain counts and hashes without credential envelopes.

The standalone report records source, images, harness, bundle manifest, environment, duration, observations, and limits.
Failed progress remains in `dist/phase-3-faults/all-docker-faults.json` after fixture cleanup.
An ownership rejection test verifies failure retention without invoking Docker.

Dispatch the signed release through CI:

```sh
gh workflow run ci.yml --ref codex/cc-57-phase3-delivery \
  -f phase3Release=phase-3-lab-a3601eff2a55 -f phase3Faults=true
```

The workflow rejects combined upgrade and fault modes before it starts containers.
Capacity, certificate, provider, stale-credential, and complete profile acceptance require separate evidence.

[Run 35218528299](https://github.com/CampusCommander/campus-commander/actions/runs/35218528299) passed all seven service faults at harness `6cb04af` against application `a3601ef`.
Recovery took 1,031 to 73,823 milliseconds. The service fault segment took 186,002 milliseconds.
Every case preserved two principals, one credential, one settings revision, two schools, thirteen grants, and two access receipts.
The probes also preserved 51 security events, an artifact, two completed Kestra executions, and an internal storage marker.
Redis recovery rejected the previous session. All ten installed workflow checks passed.

The [retained service fault report](../../deployment/evidence/CC-57-service-faults.json) includes exact release identity and three original report hashes.
PR CI passed at the implementation and documentation revisions. Complete fault and profile acceptance remain open.

## Installed provider failures

The `api-e2e:phase3-provider-fault-integration` target uses the same verified installer and installed workflows.
It simulates network failure, quota, denied privileges, and a different Google customer.
Each failed check must preserve the last successful observation and the complete customer and connection response.
Local Diagnostics must pass during each failure. Fresh application sign-in must pass during the network failure.
A retired credential generation must return `409` with `credential-changed`.

Each provider recovery must complete within 45 seconds.
Durable policy hashes exclude connection observations because successful health checks update them.
Each failed check separately compares complete observations against its preceding snapshot.
The fixture advances only the owned database's health-check retry timestamp to avoid production retry delays.
It retains failure reports and resets the simulator after execution.

Select provider faults with these CI inputs:

```sh
gh workflow run ci.yml --ref codex/cc-57-phase3-delivery \
  -f phase3Release=phase-3-lab-a3601eff2a55 \
  -f phase3Faults=true -f phase3FaultKind=provider
```

This fixture does not establish live privileges, revocation, or Education behavior.
[Run 35219808031](https://github.com/CampusCommander/campus-commander/actions/runs/35219808031) passed at harness `476acd9` against application `a3601ef`.
All four provider failures preserved customer state, policy hashes, and last-success timestamps.
Local Diagnostics passed during each failure. Fresh sign-in passed during the network failure.
The retired generation returned `credential-changed`. Recovery took 248 to 287 milliseconds.
The provider segment took 34,776 milliseconds.
The [retained provider report](../../deployment/evidence/CC-57-provider-faults.json) includes three original report hashes and complete fixture limits.
PR CI passed at the same harness revision. Complete fault and profile acceptance remain open.

## Installed certificate failures

The `api-e2e:phase3-certificate-fault-integration` target installs the signed release and completes the installed workflows.
It tests expired, wrong-host, and untrusted certificates through a strict HTTPS client.
Each recovery checks authenticated Diagnostics and preserved Phase 3 state within the shared 180-second bound.
The fixture restores every original secret file and compares its bytes without including secret values in assertion errors.
The report records failed progress, exact release identity, environment, duration, and fixture limits.

Select certificate faults with these CI inputs:

```sh
gh workflow run ci.yml --ref codex/cc-57-phase3-delivery \
  -f phase3Release=phase-3-lab-a3601eff2a55 \
  -f phase3Faults=true -f phase3FaultKind=certificates
```

The synthetic fixture does not establish district browser trust or certificate renewal operations.
[Run 35220374649](https://github.com/CampusCommander/campus-commander/actions/runs/35220374649) passed at harness `876ed07` against application `a3601ef`.
All three certificate failures preserved Phase 3 state. Recovery took 9,080 to 9,944 milliseconds.
The fixture restored every original secret file. The certificate segment took 73,735 milliseconds.
The [retained certificate report](../../deployment/evidence/CC-57-certificate-faults.json) includes three original report hashes and complete fixture limits.
All ten installed workflows passed. PR CI passed at the same harness revision.

## Installed capacity failure

The `api-e2e:phase3-capacity-fault-integration` target installs the signed release with a disposable 16 MiB artifact filesystem.
The runtime fixture preserves product mount paths and replaces only the artifact volume driver options.
Before filling the volume, the test verifies Compose ownership, mount identity, exact tmpfs options, filesystem type, and capacity.
The bounded writer must observe `ENOSPC` and zero available filesystem bytes.

The authenticated Artifact storage diagnostic must fail while the filesystem is full.
The test removes its filler and requires recovery within 60 seconds.
It verifies artifact bytes, artifact metadata, staging cleanup, Phase 3 policy state, security events, and Kestra state.
The report retains failure progress and exact release identity.

Select capacity failure with these CI inputs:

```sh
gh workflow run ci.yml --ref codex/cc-57-phase3-delivery \
  -f phase3Release=phase-3-lab-a3601eff2a55 \
  -f phase3Faults=true -f phase3FaultKind=capacity
```

The tmpfs test models `ENOSPC`. It does not establish physical-disk or power-loss durability.
Its artifact preservation checks cover the capacity fault and recovery before subsequent installer lifecycle checks.
[Run 35221699210](https://github.com/CampusCommander/campus-commander/actions/runs/35221699210) passed at harness `a239e01` against application `a3601ef`.
The volume reached zero available bytes. The Artifact storage diagnostic failed and recovered within 1,228 milliseconds.
All ten installed workflows passed. The capacity segment took 10,805 milliseconds.
The [retained capacity report](../../deployment/evidence/CC-57-capacity-faults.json) includes three original report hashes and fixture limits.

Capacity run `35221037020` failed during administrator enrollment, before fault injection or evidence creation.
Enrollment used the original Compose configuration. Installer commands used the bounded runtime configuration.
Revision `a239e01` routes delivered enrollment commands through the same runtime wrapper and preserves their input.
The passing hosted recheck confirms that enrollment and the capacity fault complete with this correction.

## Installed lifecycle and explicit erasure

The `api-e2e:phase3-lifecycle-integration` target installs the signed release and completes the installed workflows.
It captures Phase 3 policy, artifact, security-event, and Kestra state before service restart.
It compares that state after restart, stop/resume, and uninstall/resume.
Both API replicas must accept the new sessions and reject the final signed-out session.

Erasure without the exact project confirmation must fail and preserve the owned volumes.
Confirmed erasure must remove the owned volumes and record the erased installer state.
A separate fixture-owned control volume must retain its marker through erasure.
The fixture then removes that control volume after it verifies ownership.
Operator files remain under the existing erasure contract.

The fixture records distinct installation, resume, and lifecycle reports.
Installation and resume durations come from actual delivered CLI calls.
Their duration scopes distinguish command execution from later browser and state checks.

Select lifecycle qualification with these CI inputs:

```sh
gh workflow run ci.yml --ref codex/cc-57-phase3-delivery \
  -f phase3Release=phase-3-lab-a3601eff2a55 -f phase3Lifecycle=true
```

The workflow rejects combined lifecycle, upgrade, and fault modes.
[Lifecycle run 35222326908](https://github.com/CampusCommander/campus-commander/actions/runs/35222326908) passed at harness `43f1de1` against application `a3601ef`.
State survived restart, stop/resume, and uninstall/resume. Unconfirmed erasure failed and preserved the installation.
Confirmed erasure removed 22 owned volumes and preserved the control marker. All ten installed workflows passed.
The lifecycle segment took 113,193 milliseconds. The complete profile took 180,148 milliseconds.

Retained reports record five original report hashes:

- [Installation](../../deployment/evidence/CC-57-installation.json): prepare and first resume took 45,784 milliseconds.
- [Resume](../../deployment/evidence/CC-57-resume.json): four resume commands took 109,965 milliseconds in total.
- [Lifecycle](../../deployment/evidence/CC-57-lifecycle.json): state comparisons, rejected erasure, confirmed erasure, and replica session observations.

PR CI found one formatting defect in the capacity fixture. Revision `270fe88` corrects it.
[PR CI 35222525116](https://github.com/CampusCommander/campus-commander/actions/runs/35222525116) passed after that correction.
A different-release guided update remains pending. The report inventory below records the completed evidence categories.

## Next laboratory candidate

[Candidate run 35222534304](https://github.com/CampusCommander/campus-commander/actions/runs/35222534304) builds source `270fe88` for the guided-update proof.
Validation and all three image publication jobs passed. The first packaged application attempt failed during browser evidence collection.
The application retry passed. Assembly then selected the earlier failed artifact and rejected its incomplete evidence.
No candidate bundle was published.
Existing reports remain bound to application `a3601ef`. They do not qualify the new candidate.

## Different-release guided update

The `api-e2e:phase3-update-integration` target starts with the selected signed Phase 3 release.
The workflow verifies a separate target archive, manifest, inventory, and all three image signatures.
It rejects targets with the same source revision, a different phase, mutable image tags, or changed inventory bytes.

The fixture creates and verifies a native cold backup through the delivered operator CLI.
It checks cancellation before the confirmed update and compares the existing configuration, operator record, and installer state.
The confirmed update runs the target bundle's guided setup command through the same runtime wrapper.
It checks target images, preserved credentials, settings, grants, schools, security events, artifacts, and Kestra state.
Existing migration checksums must remain unchanged. The update permits appended migrations.
The fixture checks the public saved workflows, repeated update, and repeated resume after the update.

Reports distinguish installed and target identities. Failure reports survive fixture cleanup.
The fixture records laboratory setup mode for the installation created through the delivered operator CLI.
Hosted update execution requires the second published candidate and remains pending.
Set `target_release` to its published laboratory tag before running the command.

```sh
gh workflow run ci.yml --ref codex/cc-57-phase3-delivery \
  -f phase3Release=phase-3-lab-a3601eff2a55 \
  -f phase3UpdateRelease="$target_release"
```

Candidate run `35222534304` passed validation and all three image publication jobs.
Its first application attempt failed because browser evidence collection retained one unfinished request after page closure.
The application retry passed without a collector change. A local test completed 120 popup closures without reproducing the failure.
The bundle job then selected failed artifact `10498890080` with 62 files instead of successful artifact `10498771741` with 79 files.
Both artifacts had the same name. The selected artifact omitted the primary report and scanner inventory.
Local inspection validates every file in the successful artifact against the application identity and scanner hashes.
The [retained retry record](../../deployment/evidence/CC-57-candidate-retry.json) records both artifact hashes and the validated inventory.

The corrected workflow assigns each attempt a unique artifact name and passes the upload artifact ID to assembly.
A numeric guard rejects missing artifact IDs. Assembly retains its existing report and hash requirements.
The pinned [download action](https://github.com/actions/download-artifact/blob/d3f86a106a0bac45b974a628896c90dbdf5c8093/src/download-artifact.ts) selects metadata with `latest: true`, including downloads by ID.
Unique attempt names prevent its duplicate-name filter from discarding the requested artifact.
This correction preserves the failed artifact for diagnosis. The browser-closure correction and hosted recheck follow below.

## All-Docker report inventory

The [profile inventory](../../deployment/evidence/CC-57-profile-evidence.json) binds five distinct report categories to application `a3601ef` and its signed manifest.
Each entry records the retained file size and SHA-256 hash.
The inventory also includes installed workflow and lifecycle reports.

| Report       | Evidence                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| Installation | [Delivered prepare and initial resume](../../deployment/evidence/CC-57-installation.json)                         |
| Resume       | [Four delivered resume commands](../../deployment/evidence/CC-57-resume.json)                                     |
| Upgrade      | [Pinned Phase 2 upgrade and preserved state](../../deployment/evidence/CC-57-phase2-upgrade.json)                 |
| Restore      | [Isolated restore, preserved state, and rejected source admissions](../../deployment/evidence/CC-57-restore.json) |
| Faults       | [Service, provider, certificate, and capacity groups](../../deployment/evidence/CC-57-faults.json)                |

The restore report retains the original report contents and adds provenance and duration scope.
Its original bytes match the hash recorded by extracted qualification run `35211855292`.
The fault aggregate references four independent runs against the same signed application.
Every fault recovered within its recorded bound. Each source report retains its preservation checks and fixture limits.

The inventory remains incomplete until guided update execution and prerequisite review finish.
It does not qualify another application revision or permit full release assembly.
The corrected browser collector passed the hosted recheck described below.

[Candidate run 35224752965](https://github.com/CampusCommander/campus-commander/actions/runs/35224752965) passed validation and image publication at `5e276ef`.
Packaged authorization failed before assembly. The collector retained one font request without observed headers when its context closed.
The failed application artifact remains available as `qualification-phase3-auth-integration-1`, ID `10497898683`.
No second candidate or guided-update result followed this run. PR CI passed at the same source revision.

## Browser closure correction

A local Chromium fixture reproduced the unfinished-request failure with three pages and delayed font responses.
The trace shows a request arriving after the drain check and before its page closes.
Chromium supplied no completion event for that request. The later context drain then timed out.
Enabling request routing before navigation did not prevent the failure.

The collector now retires requests when their page closes and counts them as incomplete.
It also handles request events that arrive after page closure. A delayed failure event cannot count the same request twice.
Response observers remain active. Header-observation failures and timeouts for open pages still reject qualification.

The deterministic event-order regression failed before the correction and passed afterward.
API fixture tests and lint pass. Both review axes found no remaining issues after request-count deduplication.
The real-browser fixture completed 500 three-page iterations after the closure correction.
[Candidate recheck 35226593765](https://github.com/CampusCommander/campus-commander/actions/runs/35226593765) passed packaged authorization, assembly, extracted installation, repeated resume, and isolated restore.
It published `phase-3-lab-eb78e16588b9`. Independent verification passed both blob signatures, three image signatures, and the extracted inventory.
The [target qualification record](../../deployment/evidence/CC-57-update-target-qualification.json) retains exact source, images, manifest, report hashes, and 79 validated application files.
The complete installer fixture took 240,523 milliseconds. Its isolated restore segment took 57,456 milliseconds.

[Guided-update run 35228925590](https://github.com/CampusCommander/campus-commander/actions/runs/35228925590) tests the delivered update from `a3601ef` to `eb78e16`.
Its result remains pending. Existing profile reports retain their original application identity.
