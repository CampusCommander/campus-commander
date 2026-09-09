# Phase 1 release verification

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
