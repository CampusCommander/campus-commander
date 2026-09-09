# CC-6 image build evidence

Date: 2026-09-08.

## Result

The frontend, API, and worker build as Linux amd64 images through Nx.
Each runtime uses the `node` account and supports bounded graceful termination.
Each service exposes liveness and process readiness endpoints.

The application image set remains a candidate.
Project-owned GHCR publication passed the [signed candidate workflow](https://github.com/CampusCommander/campus-commander/actions/runs/34359354716).
Anonymous signature verification and hosted startup passed for all three profiles.
See the [hosted validation record](../installer/HOSTED-VALIDATION.md).
The candidate includes the CC-11 worker dispatch contract.

## Scoped changes

- `frontend/tsconfig.app.json` overrides inherited declaration emission and adds ES2022 and DOM libraries.
- `frontend/tsconfig.spec.json` applies the matching frontend test override.
- `frontend/src/app/` replaces the Nx page with Phase 1 startup and protected installation status states.
- `api/src/app/health/` adds liveness and an injectable readiness check interface.
- `api/src/app/bootstrap.controller.ts` denies bootstrap routes until the configured runtime verifies access.
- `api/src/main.ts` supports HTTP, verified TLS inputs, startup runtime initialization, and graceful termination.
- `worker/` adds the independent synthetic worker and health server.
- `deployment/images/` adds pinned builds, runtime servers, publication, and release manifest commands.
- `frontend/project.json`, `api/project.json`, and `worker/project.json` add deterministic image targets.

No login, Google entity, EntityCache, or mutation worker behavior was added.

## Build inputs and architectures

All Dockerfiles use Node 24.19.0 on Alpine 3.23.
The pinned base index is `sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995`.
Registry inspection returned Linux amd64 child digest `sha256:5098ee834c9345ddd7fc2828a01dc90aa6de0e9ed6804a09a959b19a1fded97a`.
The same index also contains Linux arm64 and s390x variants.
CC-4 declares Linux amd64 only, so this work qualifies Linux amd64 only.

The Dockerfile frontend uses pinned digest `sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6`.
Every build uses the root `package-lock.json`, disables provenance, and sets `SOURCE_DATE_EPOCH=0`.
The build normalizes generated output timestamps before the runtime copy.
Runtime stages copy only required deployment entry points and migrations.
Docker documents digest pins and multi-platform manifest inspection in its [build guidance](https://docs.docker.com/build/building/best-practices/) and [inspection reference](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/).

## Candidate image evidence

The final local build produced these Linux amd64 image IDs and repository digests:

| Service  | Image ID                                                                  | Local repository digest                                                   | Runtime user |
| -------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------ |
| Frontend | `sha256:9ae5b788f8c21da072d1cf1b6cd506c0ed3abd1b5aab4d7e7110f97e144e5842` | `sha256:9ae5b788f8c21da072d1cf1b6cd506c0ed3abd1b5aab4d7e7110f97e144e5842` | `node`       |
| API      | `sha256:034279d344e03fe1243e1f46b1d352ebece7a2cab60c49d826c9b926abf82e38` | `sha256:034279d344e03fe1243e1f46b1d352ebece7a2cab60c49d826c9b926abf82e38` | `node`       |
| Worker   | `sha256:ff996977c7e017c853baabcadc329614f51ea306d1480eecdf406f042429df39` | `sha256:ff996977c7e017c853baabcadc329614f51ea306d1480eecdf406f042429df39` | `node`       |

Two consecutive Nx image builds produced identical API and worker IDs.
The unchanged frontend ID matched its earlier repeated builds.
A pinned disposable registry returned matching repository digests for all three candidates.
The release manifest command rejected unpushed tags and accepted the three pulled local references.

The local registry does not satisfy project-owned publication.
The candidate workflow now supplies package write permission through `GITHUB_TOKEN`.
Project-owned publication awaits a workflow run.

## Runtime evidence

Plaintext startup checks returned HTTP 200 from each `/health` route.
The responses identified frontend static content, API process startup, and worker process startup.
An encoded malformed frontend path returned HTTP 400 without terminating the process.

Verified HTTPS checks passed for all three services with a generated test CA and certificate.
Each service required `TLS_CERT_FILE` and `TLS_KEY_FILE` together.
The probes trusted `TLS_CA_FILE` and verified the `TLS_SERVER_NAME` DNS name.
No probe disabled certificate verification.

The API image imported bootstrap, PostgreSQL, Redis, storage, and compiled deployment modules.
The worker image imported storage, PostgreSQL, Redis, and cross-host qualification modules.
Unauthenticated `/api/bootstrap/verify` and `/api/startup` requests returned HTTP 401 without runtime configuration.

SIGTERM stopped every HTTP and HTTPS test container with exit code zero.
Each shutdown used an eight-second outer limit and a five-second connection deadline.

All-Docker and Kubernetes checks used one earlier candidate image set.
The final narrowed image set still requires qualification across every profile.
The startup processes receive the profile file path without parsing the full profile themselves.
Profile renderers and installers own runtime argument mapping.

## Nx verification

| Check                                         | Result                          |
| --------------------------------------------- | ------------------------------- |
| `frontend:build`                              | Passed without cache            |
| `frontend:test`                               | Passed without cache, two tests |
| `frontend:lint`                               | Passed without cache            |
| `api:build`                                   | Passed without cache            |
| `api:lint`                                    | Passed without cache            |
| `worker:build`                                | Passed without cache            |
| `worker:lint`                                 | Passed without cache            |
| `frontend:image`, `api:image`, `worker:image` | Passed                          |
| repeated image ID comparison                  | Passed                          |
| `git diff --check`                            | Passed                          |
| `frontend-e2e:e2e`                            | Passed six Chromium checks      |

Browser checks cover dependency changes, empty report rejection, stale connection loss, and narrow layouts.

## UI contract handoff

```json
{
  "contractVersion": "1.3.0",
  "page": "/",
  "primaryJob": "Inspect Phase 1 installation startup status",
  "pattern": "centered-form",
  "phase": "1",
  "rules": [
    "UI-01",
    "UI-03",
    "UI-04",
    "UI-05",
    "UI-06",
    "UI-08",
    "UI-09",
    "UI-10",
    "FORM-01"
  ],
  "components": [
    "frontend/src/app/app.ts",
    "frontend/src/app/app.html",
    "frontend/src/app/app.css"
  ],
  "states": {
    "loading": "implemented",
    "empty": "not-applicable: startup checks always have a status",
    "error": "implemented as installation status unavailable",
    "partial": "implemented as not-ready checks",
    "stale": "implemented: cached checks retain their observation time and receive a stale label after connection loss",
    "offline": "implemented as installation status unavailable"
  },
  "writeFlow": "none",
  "verification": {
    "lightAndDark": "passed in Chromium",
    "keyboardAndFocus": "passed: page contains no action controls",
    "screenReader": "not-run",
    "contrastAndTargets": "not-run",
    "countsAndScope": "passed: runtime response validation accepts nonempty, consistent readiness reports",
    "recoveryAndPreservation": "passed: unavailable state remains truthful without the edge",
    "overflowAndZoom": "passed at 320 CSS pixels; browser zoom was not run"
  },
  "evidence": [
    "frontend:test",
    "frontend:build",
    "frontend:lint",
    "frontend-e2e:e2e"
  ],
  "limitations": ["Assistive technology and browser zoom checks were not run"]
}
```

## Remaining acceptance blockers

- Run the candidate publication workflow with its package-write `GITHUB_TOKEN`.
- Capture project-owned GHCR repository digests from the workflow run.
- Qualify the final published image set across all supported profiles.

## PostgreSQL secret policy rebuild

The API and worker images were rebuilt after the PostgreSQL secret-file parser correction.
Both include `deployment/postgres/secrets.mjs` in their selective runtime file inventory.
[The new local inventory](CC-6-secret-policy-images.json) records their exact manifest digests.
The frontend image did not change.
Earlier image results remain historical evidence for the references that those results name.
The root Compose example now names the corresponding intended GHCR digests.
Those project-owned references still require actual publication and verification.
