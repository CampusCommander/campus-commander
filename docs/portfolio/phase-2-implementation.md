# Phase 2 implementation record

Epic: [CC-22](https://easton-consulting.atlassian.net/browse/CC-22).
Status: IN PROGRESS. No Phase 2 release has passed acceptance.

## Current published candidate

The [fourth candidate workflow](https://github.com/CampusCommander/campus-commander/actions/runs/34683360766) passed all seventeen jobs.
These jobs include eleven application checks, capacity, runtime image publication, validation, and bundle publication.
The [pull request workflow](https://github.com/CampusCommander/campus-commander/actions/runs/34683362066) also passed.
The source revision is `dae5f7a10a0347043931f5b97ef317882c1d70f6`.

The [published prerelease](https://github.com/CampusCommander/campus-commander/releases/tag/phase-2-candidate-dae5f7a10a03) contains the signed installation archive and manifest.
CI verified the archive signature and every extracted file checksum before publication.
Each application image passed its vulnerability scan and signature verification.
The manifest includes exact image references, source files, runtime dependencies, SBOMs, and application evidence.

[The run record](../../deployment/evidence/CC-37-phase-2-fourth-published-run.json) records job results and downloaded artifact checksums.
[The retained evidence](../../deployment/evidence/phase-2-published-dae5f7a/) preserves the complete downloaded qualification reports and screenshots.
All three profiles passed published-image application checks, Phase 1 upgrade checks, and isolated application restores.
The hybrid fixture now observes PostgreSQL outage responses without racing the database connection timeout.

The manifest remains `candidate-only`. All fifteen complete profile acceptance records remain `not-run` in that manifest.
Rendered hybrid and Kubernetes checks do not establish complete installer CLI acceptance.
Kind and Docker fixtures do not establish district storage, CNI enforcement, or district capacity.
Earlier sections below preserve the implementation history and its original limitations.

## Recovery and browser acceptance audit

The real operator CLI now performs the recovery test's revocation and successful identity replacement.
An untrusted replacement issuer and empty subject both fail without changing the revoked principal or its permission version.
The recovered identity retains its principal ID and completes a fresh sign-in.
Stale permission versions fail. Retired OIDC credentials fail until the API loads their replacement.
The existing test also verifies worker credential rotation, previous-session denial, and retained security events.

`npx nx run api-e2e:auth-integration` passed in 69 seconds after these additional CLI assertions.
`npx nx run api-e2e:lint` passed.
The [operator procedure](../../deployment/bootstrap/APPLICATION-ACCESS.md) defines credential replacement, restart, revocation, and isolated restore.
The published restore reports verify preserved identity, preferences, and security events with fresh Redis.

Orca 46.1 passed against the published candidate with the default browser cache.
Its retained utterances include sign-in progress, all four named diagnostics, service failure, retry, and sign-out.
Four axe reports contain zero violations and zero incomplete checks, including contrast and target-size rules.
Screenshot review confirmed readable controls, results, and version information in both themes.
Browser checks cover keyboard focus, menus, offline recovery, 200 percent CSS zoom, and 320-pixel reflow.
Applicable rules are UI-01 through UI-06, UI-08 through UI-10, and FORM-01 for sign-in feedback.

The reader fixture processes the real Chromium accessibility tree through Orca and Speech Dispatcher.
Its ALSA null device discards audio. This evidence does not claim human listening or a district usability study.
The prior reader failure remains recorded in the third published run.

The owner authorized Phase 2 development on September 11, 2026, while Phase 1 acceptance remains open.
This instruction replaces the requirement to finish Phase 1 acceptance before Phase 2 development.
Phase 1 acceptance remains a separate record.

## Scope and tickets

[The ticket manifest](phase-2-jira-tasks.json) records all 16 tasks and their acceptance criteria.
Jira confirms that CC-23 through CC-38 belong to CC-22.
The tasks cover all 24 items in the Phase 2 planning table.
Jira confirms all 25 native blocking links against the ticket manifest.

## Release source preparation

The release branch is `implementation/phase-2-cc-22`.
A separate worktree preserves the original workspace and its unrelated Phase 1 edits.
The release includes the isolated Kubernetes fixture adapter required by Phase 2 qualification.
It excludes the separate Phase 1 capacity target, closeout records, and hosted installer experience changes.

The isolated worktree passes these checks:

- Build, lint, unit tests, and available type checks for deployment, frontend, API, worker, and application contracts.
- Installer, bootstrap, PostgreSQL, Redis, storage, release, Kubernetes, profile, qualification, and operations tests.
- The API startup regression and deployment configuration examples.
- Formatting and Git whitespace checks.

These checks validate the isolated source. Published image qualification and release acceptance remain open.

### First published candidate run

[PR 3](https://github.com/CampusCommander/campus-commander/pull/3) contains the release source.
[Run 34680669090](https://github.com/CampusCommander/campus-commander/actions/runs/34680669090) built, scanned, signed, and published all three application images.
Validation and capacity checks passed. Application qualification failed, so the workflow did not publish an installation bundle.
The [run record](../../deployment/evidence/CC-37-phase-2-first-published-run.json) preserves exact image references and job outcomes.

Fresh runners exposed missing prerequisites and fixture portability defects:

- Application integration targets omitted their deployment build prerequisite. A clean-output reproduction confirmed the missing-module failure.
- Hybrid qualification assumed upstream service images already existed in the local daemon.
- Installer qualification encountered Docker Engine and Compose versions outside the supported contract.
- Private operator request mounts assumed matching host and container user IDs.
- The Kestra fixture assumed its image user could read host-owned private configuration.
- Kubernetes image imports lacked the requested digests in the runner's exported image archive.

Application targets now declare the deployment build prerequisite. Hybrid qualification pulls missing images before inspection.
Compose enrollment sends the protected request through standard input. The Kestra fixture uses the fixture owner's user ID.
The candidate application jobs select Docker Engine 29.7.2, Compose 5.5.0, and the containerd image store.
Docker documents [daemon selection](https://github.com/docker/setup-docker-action) and [Compose version selection](https://github.com/docker/setup-compose-action).

The clean-output packaged application test passes after Nx builds its prerequisite.
New real-service checks prove PostgreSQL transaction rejection, rollback, audited failure, and retry.
They also prove Redis diagnostic permission failure, preserved application access, and retry.
All four diagnostic operations reject an identity without execution permission.
The complete all-Docker test passes with standard-input enrollment.
A separate check confirms private file denial and successful standard input under a different container user ID.

These local results do not establish successful qualification on the corrected GitHub runner.

### Second published candidate run

[Run 34681268033](https://github.com/CampusCommander/campus-commander/actions/runs/34681268033) tested source `700e813a193360cf42bddd183e09b959103f46dd`.
Validation, image publication, capacity, authentication, all-Docker installation, upgrade, restore, and screen-reader checks passed.
The [authentication report](../../deployment/evidence/CC-24-phase-2-published-authentication.json) records the exact published image digests and checks.
All four accessibility reports contain zero violations and zero incomplete checks.
The [published screen-reader report](../../deployment/evidence/CC-35-phase-2-published-screen-reader.json) records Orca 46.1, named controls, diagnostic announcements, and sign-out.
The speech device discards audio. This automated check does not establish human listening or usability acceptance.
The [run record](../../deployment/evidence/CC-37-phase-2-second-published-run.json) preserves job results and authentication artifact hashes.

Hybrid checks failed during PostgreSQL provisioning. Their private fixture files assumed host UID 1000, but GitHub uses UID 1001.
Kubernetes checks imported the image digests, then timed out during Kestra deployment.
The Kubernetes fixture also creates private shared directories for services that use UID 1000.
The next workflow runs these shared-storage fixtures under UID 1000 and preserves production container users and private file modes.
Kubernetes failure evidence now includes pod states and events. The next run must establish the Kubernetes failure cause.

The PR application job now uses the candidate job's pinned Docker versions and containerd image store.
New browser checks reject null origins, incorrect CSRF tokens, non-JSON writes, invalid preferences, and privilege fields.
They also verify uncached, redacted errors and unchanged preferences. The packaged application test passes locally in 61 seconds.

The login page now announces its connection progress before redirecting to the identity provider.
The browser test delays the sign-in response and checks the status before completing authentication.
This change follows UI-05, UI-08, and UI-09. It retains the existing centered form and theme tokens.
The complete source authentication test passes in 61 seconds. Frontend, API, worker, and deployment build prerequisites pass.
Frontend, application-test, and deployment lint checks pass. Both workflow files pass YAML parsing and Bash syntax checks.

Six profile jobs failed. The workflow did not publish an installation bundle. Phase 2 release acceptance remains open.

### Third published candidate run

[Run 34682542712](https://github.com/CampusCommander/campus-commander/actions/runs/34682542712) tested source `c8ace78e1a3942aac6f32c079963776da705f24a`.
Validation, publication, capacity, authentication, all-Docker installation, upgrade, restore, and all three Kubernetes checks passed.
[PR CI](https://github.com/CampusCommander/campus-commander/actions/runs/34682545244) passed every job.
The [run record](../../deployment/evidence/CC-37-phase-2-third-published-run.json) preserves terminal results and artifact hashes.

Published Kubernetes evidence covers [installation](../../deployment/evidence/CC-36-phase-2-published-kubernetes.json), [Phase 1 upgrade](../../deployment/evidence/CC-37-phase-2-published-kubernetes-upgrade.json), and [isolated restore](../../deployment/evidence/CC-36-phase-2-published-kubernetes-restore.json).
These checks use three Kind nodes, two API replicas, synthetic storage, and published image digests.
The reports retain their CNI, physical-host, district-trust, and shared-storage limits.

All three hybrid checks failed during PostgreSQL outage observation after successful startup.
A focused reproduction confirms a timeout race between the five-second test client and PostgreSQL connection deadline.
The client disconnected after 5,006 milliseconds. A ten-second client received the expected 503 response after 5,007 milliseconds.
The outage probe now allows ten seconds for each response. The twenty-second outage observation limit remains.
The complete hybrid test passes locally in 127 seconds.

The screen-reader process started, but its report contained no browser announcements.
The shared browser cache now applies only to hybrid and Kubernetes fixtures. Screen-reader qualification uses its previous default cache.
Its next published check must pass. The workflow did not publish an installation bundle.

Further boundary checks reject unsupported worker commands, excessive worker delay, and an unavailable public diagnostic operation.
Credential markers remain absent from security-event details, API logs, worker logs, Kestra logs, execution data, flow definitions, and support output.
The complete source authentication test passes with these assertions in 62 seconds.

## Authentication contract

Application sign-in uses OIDC authorization code flow through `openid-client` 6.8.8.
The application requests `openid profile`. It does not request background Google administration scopes.
The application validates the issuer, audience, callback, state, nonce, and S256 PKCE verifier.
The provider must use HTTPS. The installation operator configures its exact public origin and callback.
The application stores no provider access token, refresh token, or ID token after sign-in.

Application access uses an explicit issuer and subject pair in PostgreSQL.
The installation operator provisions the initial administrator through the [application access procedure](../../deployment/bootstrap/APPLICATION-ACCESS.md).
Email domain membership does not grant access. Phase 3 adds the delegated access interface.
Display names identify people in the UI. Issuer and subject identify the authenticated principal.

Redis stores opaque application sessions. Cookies use Secure, HttpOnly, SameSite=Lax, Path=/, and the `__Host-` prefix.
Redis keys contain token hashes. The browser receives no session content beyond an opaque cookie.
The default absolute lifetime is eight hours. The default idle lifetime is thirty minutes.
Configuration limits the absolute lifetime to one day and idle lifetime to one hour.
Logout deletes the session. Every protected request checks current database access and its permission version.
Redis loss requires another sign-in. The API never substitutes local sessions.

Browser writes require the configured Origin, JSON content type, and a session-bound CSRF token.
The API sends no permissive CORS headers. Sensitive responses use `Cache-Control: no-store`.
The edge serves local frontend assets and explicit application routes. It does not proxy the Kestra control plane.

## Recovery and service credentials

Identity replacement updates the issuer/subject binding and increments the permission version in one audited transaction.
Disabling access also increments the permission version. Existing sessions then fail their next permission check.
Recovery requires installation-operator access. Public sign-in cannot grant or recover application permission.
Redis sessions remain disposable after restore. PostgreSQL preserves principals, preferences, and security events.
Restore procedures must invalidate sessions and review credentials before reopening application access.

The API authenticates to Kestra with the existing configured credential.
Kestra authenticates synthetic worker dispatch with the existing worker credential and restricted internal network.
Secret files supply credentials. Configuration, diagnostics, and support evidence contain no credential values.
Credential replacement requires the affected services to reload or restart before verification.
Full mutual TLS remains a separate deployment choice. Verified server TLS protects external service connections.

## Data and module ownership

The application contract library owns framework-independent runtime schemas and TypeScript types.
The API owns configuration, authentication, database, cache, orchestration, storage, and diagnostics modules.
PostgreSQL owns application principals, permission versions, preferences, and security events.
The installer owns migrations. Runtime roles cannot grant access or rewrite security evidence.
Redis owns login transactions and application sessions. Login transactions expire after five minutes and permit one callback.
The existing artifact interface owns synthetic publication and integrity checks.

Security events retain logical evidence permanently under the portfolio archive policy.
The application records event names, principal IDs, timestamps, correlation identifiers, and bounded technical categories.
It does not record callback parameters, tokens, cookies, secrets, or arbitrary request bodies.

## Validation

Implementation and release qualification remain in progress.

The real integration passes OIDC, two API replicas, PostgreSQL, Redis, Kestra, worker dispatch, artifact storage, and Chromium.
It verifies repeated checks, session restart, cross-replica logout, expiry, permission denial, revocation, callback rejection, and redaction.
The fixture uses one Docker host and synthetic HTTPS provider credentials.
Renderer tests verify API-only OIDC secrets in all three profiles and explicit Kubernetes provider egress.

Screenshot review identified blocked stylesheet activation under the edge security policy.
Disabling critical-CSS inlining fixed theme and icon rendering without relaxing script policy.
Computed theme colors, local fonts, and zero CSP violations now pass.
The frontend initial bundle decreased from 633 kB to 372 kB after correcting the Zod namespace import.
The build now meets its existing 500 kB warning budget.

References: [Angular stylesheet optimization](https://angular.dev/reference/configs/workspace-config#optimization-configuration) and [Zod locale imports](https://zod.dev/error-customization).
Tests must cover real OIDC exchanges, PostgreSQL, Redis, the browser, and all three deployment profiles.
Synthetic provider evidence does not prove a district identity-provider configuration.
UI handoffs must record UI-01 through UI-06, UI-08 through UI-10, and FORM-01 where applicable.
Release acceptance requires the complete Phase 2 and shared release criteria.

Sources: [architecture](03-architecture.md), [work breakdown](06-work-breakdown.md), and [UI contract](../ui/README.md).
Protocol reference: [openid-client authorization checks](https://github.com/panva/openid-client/blob/v6.8.8/docs/interfaces/AuthorizationCodeGrantChecks.md).

## September 12 profile qualification

The rendered hybrid application passed sign-in and all four Diagnostics checks against external TLS PostgreSQL and Redis.
Two worker Compose projects used the shared artifact directory.
The session and theme survived API and worker restarts.
The test then repeated all four Diagnostics checks and signed out.

The external Redis fixture initially rejected GETDEL and EVAL.
The fixture now shares the application Redis ACL with the runtime renderer.
The district operator procedure requires those commands before Phase 2 sign-in.

The database outage caused Kestra to shut down its executor while its HTTP endpoint still answered.
Diagnostics recorded a timeout and subsequent failures before a retry passed within the 120-second recovery bound.
The successful retry occurred about 89 seconds after the preceding Redis check.
The complete hybrid test passed in 165.5 seconds.
[The hybrid evidence](../../deployment/evidence/CC-36-phase-2-hybrid.json) retains every diagnostic result and its correlation identifier.
This fixture uses one Docker host. It does not qualify district infrastructure or Kubernetes.

All three rebuilt runtime images report zero vulnerabilities under Trivy 0.74.0.
[The image evidence](../../deployment/evidence/CC-37-phase-2-image-scan.json) records their exact digests and development build identifiers.
Release publication still requires clean committed sources, signed images, upgrades, isolated restores, and profile acceptance.

The fresh Kubernetes fixture passed in 157 seconds, including cleanup.
Three Kind nodes ran two API replicas and two worker replicas.
The session survived API pod replacement. A worker moved to another node and completed the same Diagnostics checks.
The fixture temporarily used one worker to permit rescheduling under required pod anti-affinity.
It restored two workers and repeated the checks before sign-out.
All 16 diagnostic executions passed without retry.
[The Kubernetes evidence](../../deployment/evidence/CC-36-phase-2-kubernetes.json) records images, checks, and fixture limits.
The fixture resolves Docker's configured host gateway for its synthetic provider.
It does not prove CNI policy enforcement or district infrastructure.

The all-Docker fixture passed in 72.8 seconds.
Concurrent service restart reassigned the worker IP address.
Kestra connection attempts failed temporarily. A retry passed about 21 seconds after the first failed check.
The test preserves these failures and verifies recovery within 60 seconds.
[The all-Docker evidence](../../deployment/evidence/CC-36-phase-2-all-docker.json) records address changes and every diagnostic result.
The session and theme survived restart. The operator then signed out.

The latest source integration and packaged-image integration both passed.
Build, lint, unit, and type checks passed for the application projects.
Installer, Redis, and Kubernetes configuration checks also passed.
The candidate workflow requires runtime image scans and application integration targets before bundle publication.
The workflow has not run on GitHub.

## Installer upgrade qualification

The all-Docker Phase 1 to Phase 2 installer upgrade passed in 136 seconds.
[The upgrade evidence](../../deployment/evidence/CC-37-phase-2-all-docker-upgrade.json) records the baseline, mirrored image digests, preserved artifact, and migrations.
The real CLI completed prepare, resume, stop, uninstall, backup, upgrade, and explicit erasure.
Administrator enrollment, browser login, all four Diagnostics checks, and logout passed after the upgrade.
The fixture preserves the installer manifest and applies its synthetic provider configuration through a separate runtime Compose file.
The target images remain unsigned development artifacts. Published-image acceptance remains open.

All 89 installer tests passed, including the loopback-only HTTP registry boundary.
Release tests passed with required Phase 2 image scans and application reports.
Candidate assembly rejects application evidence for different image references.
The candidate workflow includes the published-image upgrade test. The workflow has not run on GitHub.

The complete isolated all-Docker application restore passed in 211 seconds, including upgrade and cleanup.
[The restore evidence](../../deployment/evidence/CC-36-phase-2-all-docker-restore.json) records exact state preservation and application checks.
The restore preserved one principal, twelve security events, the dark preference, and the original artifact bytes.
Fresh Redis rejected the source session. A new sign-in completed all four Diagnostics checks and logout.
The source and target use separate databases, networks, and volumes on one Docker host.
They use the same loopback origin sequentially. Synthetic credentials remain unchanged within this recovery fixture.
Published-image restore acceptance remains open. Later hybrid and Kubernetes qualifications appear below.

The candidate workflow now requires this restore test and includes its report in the signed file inventory.
Packaged authentication regression passed after the fixture changes.

## Screen-reader qualification

The real Orca regression passed in 90 seconds against the rebuilt frontend image.
[The reader evidence](../../deployment/evidence/CC-35-phase-2-screen-reader.json) records utterances, images, and each checked interaction.
Diagnostics now announces the service name and result through a polite atomic region.
The region excludes timestamps and support references. The check button owns the busy attribute.
Account and Diagnostics routes now supply descriptive page titles. The initial document title no longer claims installation startup.
These changes address UI-02, UI-09, and UI-10.

The fixture uses Orca 50.2, Speech Dispatcher, eSpeak, Chromium, a private D-Bus session, and Xvfb.
Its ALSA null device discards audio. Human listening and usability evaluation remain separate from captured reader utterances.
The [qualification procedure](../../api-e2e/SCREEN-READER.md) describes the environment and limits.
The original failing reader report remains in the evidence directory.

Frontend lint, unit, and build checks passed. The packaged browser regression passed in 63 seconds.
The current frontend image reports zero vulnerabilities. Its digest ends in `be6e812e5`.
Candidate assembly requires matching image references in application reports, including upgrade, restore, and reader evidence.
Release tests passed. The candidate workflow has not run on GitHub.

## Hybrid upgrade and recovery qualification

The initial rendered hybrid Phase 1 upgrade passed in 113 seconds, including cleanup.
[The latest upgrade evidence](../../deployment/evidence/CC-37-phase-2-hybrid-upgrade.json) records the published baseline and Phase 2 image references.
The fixture verifies the original runtime images and absence of the authentication table before migration.
The upgrade preserves the original migration checksum, artifact metadata and bytes, both worker readers, Kestra execution, and Kestra files.
Administrator enrollment, login, all four Diagnostics checks, restart, theme persistence, and logout pass.

The fixture uses external TLS PostgreSQL and Redis containers with two worker Compose projects on one Docker host.
It exercises preparation, rendering, and migration commands. It does not establish installer CLI or district infrastructure acceptance.
The candidate workflow requires eleven application reports, including upgrade and restore reports for all three profiles.
Release tests reject hybrid upgrade evidence without verified runtime image content.

The complete hybrid upgrade and application restore passed in 216 seconds, including source recovery and cleanup.
[The restore evidence](../../deployment/evidence/CC-36-phase-2-hybrid-restore.json) records identities, preferences, security events, artifacts, and Kestra state.
The restore uses native PostgreSQL tools, new database roles and passwords, fresh Redis, and separate storage and networks.
The target rejects the source session. A fresh login preserves the dark preference and completes all four Diagnostics checks.
The source stays offline during target verification. It then restarts before fixture cleanup.
The repeated upgrade also verifies the exact image content of the upgraded frontend, API, and both workers.

The first restore attempt exposed a fixture comparison against unnormalized configuration.
The fixture now compares validated configuration, including session defaults.
It also waits for the login route before restoring source browser access.
Relevant lint, formatting, release tests, and the complete hybrid integration pass.
Synthetic OIDC and internal service credentials remain unchanged during restore. District infrastructure and published-image acceptance remain open.

## Kubernetes upgrade and recovery qualification

The initial rendered Kubernetes Phase 1 upgrade passed in 190 seconds, including cluster cleanup.
[The latest upgrade evidence](../../deployment/evidence/CC-37-phase-2-kubernetes-upgrade.json) records the published baseline and upgraded image content.
The fixture verifies the original migration checksum, artifact metadata and bytes, a successful worker execution, and Kestra files.
The installer-owned migration job applies Phase 2 before administrator enrollment and browser checks.
Login, all four Diagnostics checks, API pod replacement, worker rescheduling, and logout pass.

Three Kind nodes share one Docker host and synthetic storage. District storage, CNI enforcement, and signed release acceptance remain open.
The complete Kubernetes upgrade and application restore passed in 255 seconds, including cluster cleanup.
[The restore evidence](../../deployment/evidence/CC-36-phase-2-kubernetes-restore.json) records separate namespaces and distinct persistent volume claim identities.
The restore preserves one application principal, its preferences, 36 security events, artifacts, and Kestra state.
The source API, workers, and Kestra remain stopped during target verification.
Fresh Redis rejects the source session. Another login preserves the dark preference and completes all four Diagnostics checks and logout.

The first restore attempt exposed a fixed port assumption in the fixture startup probe.
The probe now reads the rendered edge Service port.
The restore compares validated configuration, including session defaults, and preserves the earlier Phase 1 evidence files.
The fixture reuses synthetic credentials. District recovery-key custody and infrastructure require separate qualification.
The candidate workflow requires eleven application reports. Release tests, relevant lint, formatting, and the complete Kubernetes integration pass.

## Remaining release gates

- Complete installer acceptance for install, resume, upgrade, restore, and faults in each deployment mode.
- Bind fifteen distinct acceptance reports to the exact release revision, images, and signed file inventory.
- Record distinct worker hosts for distributed profiles and retain measured fixture limitations.
- Review every remaining ticket criterion and link its final implementation and validation evidence.
- Publish the accepted release and record supported workflows, defects, and measured limits.
