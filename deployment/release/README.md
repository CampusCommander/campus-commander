# Release verification

The candidate workflow publishes application images under `ghcr.io/campuscommander/campus-commander-{frontend,api,worker}`.
It builds each image through Nx for Linux amd64.
It signs each registry digest with Cosign 3.1.3 and generates an SPDX SBOM with Syft 1.51.1.
The workflow signs an installation bundle and its candidate manifest.
GitHub Actions stores the bundle under the source revision artifact name.
The workflow also publishes a project prerelease tagged `phase-1-candidate-<revision12>`.

The workflow pins [cosign-installer 4.1.2](https://github.com/sigstore/cosign-installer/tree/6f9f17788090df1f26f669e9d70d6ae9567deba6) to its commit.
The installer verifies the Cosign binary through keyless and KMS signature bundles.
[Cosign 3.1.3](https://github.com/sigstore/cosign/releases/tag/v3.1.3) publishes these bundles instead of detached `.sig` files.

The signing identity is the repository workflow identity:

```text
https://github.com/CampusCommander/campus-commander/.github/workflows/candidate-images.yml@refs/heads/implementation/cc-5-through-cc-20
```

The trusted issuer is `https://token.actions.githubusercontent.com`.
GitHub Actions obtains temporary signing credentials through OIDC.
Repository administrators control the workflow and package publication permissions.
No long-lived project signing key enters the bundle.
The workflow follows [Sigstore's CI signing and verification procedure](https://docs.sigstore.dev/quickstart/quickstart-ci/).
SBOM generation uses the [Anchore SBOM action](https://github.com/anchore/sbom-action).

Verify the bundle before extraction:

```sh
cosign verify-blob --bundle phase-1-candidate.sigstore.json \
  --certificate-identity='https://github.com/CampusCommander/campus-commander/.github/workflows/candidate-images.yml@refs/heads/implementation/cc-5-through-cc-20' \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
  phase-1-candidate.tar.gz
```

Verify each application digest with `cosign verify` and the same identity and issuer.
Do not trust an identity solely because the downloaded bundle names it.
Obtain the expected identity through an independent repository ownership channel.

## Candidate and release gates

`candidate.mjs` packages committed installation sources, compiled configuration code, image references, and image provenance.
It requires a clean source revision and excludes untracked installation secrets.
The candidate manifest records every profile gate as `not-run`.
Image integrity does not establish deployment acceptance.

`integrity.mjs` checks file sizes, SHA-256 checksums, paths, duplicate entries, and signature integrity.
Its Ed25519 verifier requires an independently trusted public key.
Production qualification requires passed install, resume, upgrade, restore, and fault records for all three profiles.
Each record names one unique inventoried JSON report and its SHA-256 checksum.
The report must identify its profile, check, source revision, application images, and passed status.
Release verification reads each report and matches those claims against the signed manifest.
Distributed profiles also require distinct worker-host identifiers.
The signer must review the truth of those records.

Run `npm exec nx run deployment:release-test` for tamper and qualification rejection tests.
The tests use disposable signing keys and synthetic evidence.
They do not establish release acceptance.

Upstream PostgreSQL, Redis, Kestra, and Node images retain their upstream authorship.
Their pinned digests and qualification evidence reside in the corresponding deployment directories.
Campus Commander signatures cover application images and project release material.

The candidate bundle includes installer runtime dependencies from `runtime/package-lock.json`.
Assembly uses `npm ci --omit=dev --ignore-scripts` and inventories every installed dependency file.
The signed manifest therefore binds dependency bytes as well as installation sources.
Operators do not install npm packages on district hosts.
CI extracts the archive into a separate temporary directory and imports the installer before signing.
The extracted-bundle check also verifies every manifest file checksum.

Candidate release tags are immutable and include the first twelve source revision characters.
A repeated publication for an existing tag stops at release creation.
Create a new source commit for a new candidate. Do not replace assets or rebind an existing candidate tag.

## Phase 2 candidate

The Phase 2 workflow uses `.github/workflows/phase-2-candidate.yml` on `implementation/phase-2-cc-22`.
Its independently expected signing identity is:

```text
https://github.com/CampusCommander/campus-commander/.github/workflows/phase-2-candidate.yml@refs/heads/implementation/phase-2-cc-22
```

The workflow requires production dependency checks and scans each runtime image before publication.
It tests published application images and all three deployment profiles.
All three deployment profiles have Phase 1 upgrade and isolated application restore targets.
It also tests named diagnostic announcements through Orca in an isolated desktop session.
Bundle assembly requires matching image references in every application report.
The bundle includes image scan reports, application reports, accessibility reports, and theme screenshots in its checksum inventory.
These application reports retain their fixture limits. They do not replace the complete profile acceptance records.

The Phase 2 bundle uses `phase-2-candidate.tar.gz` and `phase-2-candidate.sigstore.json`.
The prerelease tag uses `phase-2-candidate-<revision12>`.
Verify its bundle with the Phase 2 identity and the existing GitHub Actions issuer before extraction.
The Phase 1 identity remains valid only for Phase 1 candidates.

```sh
node deployment/release/candidate.mjs candidate-bundle image-evidence "$GITHUB_SHA" 2 qualification-evidence
```

The qualification directory contains the separate `qualification-<target>` artifact directories from the application workflow matrix.
Missing reports, failed reports, and different image references stop assembly.

The candidate inventory also requires the distributed hybrid CLI install, upgrade, and process fault reports.
These reports must match the source revision and include three distinct daemon identifiers and successful owned-resource cleanup.
The upgrade and process fault reports must include a verified encrypted backup.
The process fault report must include all six named interruption and recovery cases.
It must declare the shared 180-second foundation budget and include measured recovery times within that budget.
Assembly rejects missing reports, mixed source revisions, repeated daemon identifiers, incomplete cleanup, and missing backup verification.
These requirements retain candidate status until the complete profile acceptance records pass.

All three application restore reports must record successful operator CLI `backup`, `verify`, and `restore` commands.
The records identify the native runner and the protected `/run/secrets` mount.
Assembly rejects missing CLI evidence, injected database adapters, and incomplete commands.
The hybrid operator records backup and restore execution separately inside its existing container.
Linux CI uses the pinned PostgreSQL operator image for all-Docker and Kubernetes restore commands.
Docker Desktop qualification supports native host tools when container networking cannot reach host loopback endpoints.

The Phase 2 application matrix includes `all-docker-process-fault-integration`.
Its report must contain all seven interruptions, matching source, bounded recovery, and confirmed installation cleanup.
The all-Docker profile report must verify the same principal on two distinct API containers through four authenticated lifecycle stages.
Both containers must reject the signed-out session.
These gates add evidence requirements. They do not replace complete profile fault, capacity, certificate, or accepted release requirements.

The Phase 2 matrix also includes `kubernetes-process-fault-integration` and its browser timeout regression.
Kubernetes fault reports require seven passed cases, matching source and images, bounded recovery, and confirmed removal of the owned cluster.
An interrupted API can produce a bounded transport timeout when its service has no reachable endpoints.
Recovery still requires a successful authenticated session and all four Diagnostics operations.
The fixture verifies durable application and Kestra state after each interruption.
Kind node separation does not establish physical host separation, production storage acceptance, or NetworkPolicy enforcement.

The application matrix includes `all-docker-capacity-integration` and `kubernetes-certificate-integration`.
Capacity evidence must verify bounded ENOSPC, rejected publication, preserved application state, and removal of failed Diagnostics metadata and files.
Kubernetes certificate evidence must verify expired and wrong-host rejection, bounded authenticated recovery, exact secret restoration, and cluster cleanup.
Candidate assembly rejects incomplete records. The complete profile acceptance requirements remain unchanged.

The distributed hybrid capacity gate verifies capped shared storage across two API replicas and two worker hosts.
It requires three Docker daemon identities, ENOSPC, authenticated failure, exact artifact cleanup, preserved durable state, and bounded recovery.
The capacity fixture downloads pinned infrastructure images before offline Compose startup.
These checks retain candidate status until the complete profile acceptance records pass.

The Kubernetes matrix includes `kubernetes-replica-integration` and `kubernetes-capacity-integration`.
Replica evidence requires sixteen direct requests across eight lifecycle stages and the same principal on both API pods.
Both pods must reject sessions revoked by stop, uninstall, and browser sign-out.
Exactly one original API pod must survive replacement. The fixture must confirm cluster removal.
Capacity evidence requires two API pods and two worker pods with distinct worker nodes.
All four pods must observe the same capped 16 MiB tmpfs, zero available bytes during failure, and exact space restoration.
The gate also requires authenticated failure, artifact cleanup, durable state, bounded recovery, and removal of the cluster and volume.
The capacity target starts a fresh Phase 2 installation. The replica target includes a Phase 1 upgrade.
The matrix now contains twenty-one application targets and twenty-seven total jobs.
These synthetic reports retain their limits and do not establish accepted release status.
