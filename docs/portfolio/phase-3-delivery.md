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
