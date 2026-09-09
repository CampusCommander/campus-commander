# Hosted installer validation

This record covers source revision `5346e739e175760180b669d00dae6cdc4d9a1448`.
The public entry script was published on `main` in commit `f396baa`.
Its SHA-256 matches the implementation script: `d4552b67bae63e2f68db814f455f398d4b77cde2019458d1b9b512c4755dec45`.
The release remains a qualification candidate. This record does not establish release acceptance.

## Published build

[Candidate workflow 34304764309](https://github.com/CampusCommander/campus-commander/actions/runs/34304764309) passed every job.
Those jobs cover validation, three image publications, capacity checks, and signed bundle publication.
The [candidate release](https://github.com/CampusCommander/campus-commander/releases/tag/phase-1-candidate-5346e739e175) contains four assets:

- `phase-1-candidate.tar.gz`
- `phase-1-candidate.sigstore.json`
- `release-manifest.json`
- `release-manifest.sigstore.json`

## Anonymous entry test

The test used an Ubuntu 24.04 container without GitHub credentials or a source checkout.
It executed this command:

```sh
curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh |
  sh -s -- --release phase-1-candidate-5346e739e175 --verify-only
```

The script obtained its private Node and Cosign tools.
The archive signature and manifest signature both reported `Verified OK`.
Archive and manifest inventory checks completed before image verification.
Frontend image signature verification returned `UNAUTHORIZED: authentication required` from GHCR.
The script exited with status 1 before configuration or installation.

Anonymous GHCR token requests also returned HTTP 401.
Public repository visibility has not established anonymous container image access.
The package owner must enable public visibility for all three application packages before this test can pass.

## Test host prerequisites

The isolated Docker daemon reports version 29.8.0 and cgroup v2.
Nested overlay storage failed. The isolated daemon was configured with VFS storage.
A container with memory and CPU limits still failed because its parent cgroup was in an invalid state.
This host does not yet qualify for application installation testing.
The existing customer installation was not changed.

## Remaining evidence

- Repeat anonymous verification after package visibility changes.
- Verify container memory and CPU limits on the corrected test host.
- Complete interactive all-Docker installation through the public command.
- Exercise status, interruption recovery, and credential preservation through the same entry command.
- Complete hybrid installation using external services and worker hosts.
- Complete Kubernetes installation using existing cluster Secrets and storage.

Earlier source harness results do not prove these hosted installation paths.
