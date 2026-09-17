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
