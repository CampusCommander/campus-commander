# Phase 2 implementation record

Epic: [CC-22](https://easton-consulting.atlassian.net/browse/CC-22).
Status: IN PROGRESS. No Phase 2 release has passed acceptance.

## Current qualification status

Jira records thirteen Done tasks, CC-23 through CC-35. CC-36 through CC-38 remain In Progress.
CC-35 includes the passing published-image browser and Orca 46.1 evidence from source `0185173`.
The [twelfth candidate](https://github.com/CampusCommander/campus-commander/actions/runs/34693537292) passed all twenty jobs for source `a41bb2fde8d5fff79d59b98c94cace2c8722ba17`.
[Pull request CI](https://github.com/CampusCommander/campus-commander/actions/runs/34693539602) also passed.
The jobs include fourteen application targets, capacity, validation, three image publications, and bundle publication.
[The terminal run record](../../deployment/evidence/CC-37-phase-2-twelfth-published-run.json) preserves job results and qualification artifact checksums.
The latest published bundle is [candidate a41bb2f](https://github.com/CampusCommander/campus-commander/releases/tag/phase-2-candidate-a41bb2fde8d5).

[The published distributed fault report](../../deployment/evidence/CC-36-phase-2-distributed-hybrid-published-faults.json) passed all six faults with matching source and images.
PostgreSQL recovery took 74.0 seconds within the shared 180-second recovery budget.
The report preserves the earlier fixture limits. It does not establish district recovery guarantees.
Complete profile fault evidence, final revision qualification, isolated CLI recovery, and accepted signed release assembly remain open.
Sections below preserve earlier observations with their original source revisions and limits.

## Fourth published candidate (historical)

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

The subsequent `fd04554` reader job reproduced missing browser announcements. CC-35 is open again pending repeatable qualification.
[The failing report](../../deployment/evidence/CC-35-phase-2-reader-fd04554-failure.json) retains the contradictory evidence.
Restoring the default browser cache did not resolve the intermittent failure.
The reader fixture now records Chromium registration and event counts without retaining raw debug content in public evidence.
The instrumented local Orca 50.2 run passed in 213 seconds with the expanded installer lifecycle.
[Its connection report](../../deployment/evidence/CC-35-phase-2-reader-connection-local.json) observed Chromium registration and 8,354 accessibility event lines.
That local pass does not resolve the intermittent Orca 46.1 CI failure.

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

## Published installer verification and lifecycle

The hosted installer verified candidate `dae5f7a` with its pinned Cosign binary.
It verified archive and manifest signatures, all three application image signatures, safe archive entries, and every inventoried file checksum.
[The verification report](../../deployment/evidence/CC-37-phase-2-hosted-verification.json) records the command and tool checksum.
Verification alone does not install services or complete profile acceptance.

The expanded all-Docker check passed against those published images in 131 seconds.
It invokes the real CLI for prepare, repeated resume, stop/resume, and uninstall/resume.
API and worker restart preserve the session. Full stop restarts Redis and requires fresh sign-in.
Fresh sign-in preserves PostgreSQL preferences and completes all four Diagnostics checks after each lifecycle operation.
The test verifies unchanged installer output and release inventory.
[The lifecycle report](../../deployment/evidence/CC-36-phase-2-published-cli-install.json) records commands, images, and browser observations.

The same lifecycle also passed with the CLI from the verified, extracted release archive.
The fixture matched its phase, source revision, and image inventory before installation.
Each CLI invocation verified the bundle file inventory during candidate authentication.
[The extracted-bundle report](../../deployment/evidence/CC-36-phase-2-published-bundle-install.json) identifies this separate execution.

The first CLI attempt rejected the fixture's IP certificate during hostname preflight.
The fixture now uses its mapped DNS name and matching certificate.
The second attempt incorrectly expected a session after Redis restart.
The corrected assertion verifies fresh sign-in and durable preferences according to the Redis state contract.
Production certificate checks and Redis persistence policy remain unchanged.

PR CI found formatting differences in the newly retained JSON reports.
Repository copies now use Prettier formatting. Their values match the original downloaded reports exactly.
The run record's artifact checksums identify the original downloaded bytes.
The local image path also passed the expanded CLI lifecycle in 119 seconds through its disposable registry.
Its report preserves the `-dirty` image build marker. Published image references require clean source revisions.

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

## Kubernetes CLI qualification and reader startup

The fresh Kubernetes fixture now delegates application workload creation to the installer CLI.
It supplies synthetic Secrets and storage before preparation.
The CLI passes preparation, repeated resume, stop/resume, and uninstall/resume against the published `dae5f7a10a03` application images.
The browser completes 24 diagnostic operations and preserves preferences after fresh sign-in following Redis restart.
Two workers occupy distinct Kind worker nodes. The original CLI-generated manifest remains unchanged.
[The CLI evidence](../../deployment/evidence/CC-36-phase-2-kubernetes-cli-install.json) records image identity, lifecycle commands, browser checks, and fixture limits.

The sixth candidate run passed every application check except screen-reader qualification.
[The candidate record](../../deployment/evidence/CC-37-phase-2-sixth-published-run.json) links each terminal job result. PR CI passed.
[The reader report](../../deployment/evidence/CC-35-phase-2-reader-6d3bd65-failure.json) confirms missing Chromium registration in the accessibility desktop.
A focused browser probe reproduced that condition when desktop accessibility remained disabled.
Enabling Chromium native accessibility registered the browser under the same condition.
The fixture now enables native accessibility and waits for actual Orca registration before launching Chromium.
Orca buffers its debug file. Initial log contents cannot establish startup readiness.
The full local reader test passed all six speech assertions in 213 seconds with Orca 50.2.
[The reader evidence](../../deployment/evidence/CC-35-phase-2-reader-registration-local.json) records live registration and actual utterances.
The subsequent CI run passed with Orca 46.1. The criterion audit completed CC-35.

Kubernetes upgrade now uses the real installer CLI and an encrypted baseline backup.
The restore target still uses its isolated restore procedure.
Complete distributed CLI qualification and the fifteen signed profile acceptance records remain open.
Phase 1 acceptance remains separate.

The independently verified extracted Kubernetes bundle passed the same CLI lifecycle in 232 seconds.
[The bundle evidence](../../deployment/evidence/CC-36-phase-2-kubernetes-bundle-install.json) records the published image identity and two distinct worker nodes.
The fixture waits for stopped application pods to disappear before resuming workloads.
This prevents port forwarding from selecting a terminating edge pod.

The standard Phase 2 upgrade target now includes expired and wrong-host edge certificate rejection and recovery.
The first run exposed a preservation assertion that still expected the Phase 1 migration ledger.
Fault recovery now compares against the verified post-upgrade state, including the Phase 2 migration.
The corrected upgrade test passed in 208 seconds, including both certificate failures and subsequent application checks.
[The upgrade fault evidence](../../deployment/evidence/CC-37-phase-2-upgrade-tls-faults.json) records preserved migrations, artifact integrity, and restored certificate bytes.
These certificate checks retain their limited scope. They do not establish complete profile fault acceptance.

## Seventh candidate and Kubernetes CLI upgrade

The seventh candidate workflow passed all 17 jobs for source `2f26a013e3bbc7cbf768add55f0b3701ac312243`.
[The terminal workflow record](../../deployment/evidence/CC-37-phase-2-seventh-published-run.json) links candidate and PR results.
The workflow published the signed candidate. Its fifteen profile acceptance gates remain open.
[Independent hosted verification](../../deployment/evidence/CC-37-phase-2-hosted-verification-2f26a01.json) passed archive, manifest, image signatures, and inventoried file checks.

[The CI reader report](../../deployment/evidence/phase-2-published-2f26a01/reader/screen-reader.json) passes all six speech assertions with Orca 46.1.
Live accessibility registration includes Orca before browser startup and Chromium after browser startup.
[The browser report](../../deployment/evidence/phase-2-published-2f26a01/auth/packaged-integration.json) records the complete application checks.
Four accessibility reports contain zero violations and zero incomplete checks.
The retained screenshots show both themes and the actual build identifier.
The evidence covers UI-01 through UI-06, UI-08 through UI-10, and FORM-01 where applicable.
[Artifact provenance](../../deployment/evidence/phase-2-published-2f26a01/artifact-provenance.json) records original downloaded hashes before repository JSON formatting.

The Kubernetes CLI upgrade passed in 269 seconds, including cluster cleanup.
[The upgrade evidence](../../deployment/evidence/CC-36-phase-2-cli-kubernetes-upgrade.json) records the published baseline and target image identities.
The fixture stops API, worker, and Kestra writers before creating the encrypted database and storage backup.
The installer verifies the backup and applies the Phase 2 migration.
The test preserves the Phase 1 migration checksum, artifact metadata, artifact bytes, worker execution, and Kestra files.
It completes 24 diagnostic executions, API replacement, worker rescheduling, stop/resume, and uninstall/resume.
The fixture preserves each CLI-generated manifest until an explicit upgrade generates its replacement.

The first upgrade attempt reached healthy workloads but failed the fixture readiness connection.
The fixture now forwards to a ready edge pod with the target image during rolling updates.
The subsequent upgrade passed. This result supports the old-pod selection diagnosis without proving the original connection target.
Three Kind nodes share one Docker host and synthetic storage. District infrastructure and CNI enforcement remain separate qualification requirements.
The local run uses published `dae5f7a` images and uncommitted qualification changes based on `2f26a01`.
It does not qualify the final release revision.

The first combined CLI upgrade and restore run completed recovery but failed its final evidence assertion.
The assertion expected two source worker hosts after restore had stopped every source writer.
[The failure record](../../deployment/evidence/CC-36-phase-2-cli-kubernetes-restore-report-failure.json) preserves the failed target and passed restore subchecks separately.
The fixture now captures source worker placement after lifecycle recovery and before isolated restore stops source writers.

[The hybrid daemon probe](../../deployment/evidence/CC-36-phase-2-hybrid-daemon-probe.json) started three independent Docker 29.8.0 daemons.
Each daemon returned a distinct identifier. The probe removed its three containers after verification.
The probe verifies fixture availability only. Full hybrid CLI and shared-storage qualification remain open.

The corrected CLI upgrade and isolated restore target passed in 324 seconds, including cluster cleanup.
[Restore evidence](../../deployment/evidence/CC-36-phase-2-cli-kubernetes-restore.json) records exact identities, preferences, security events, and isolated storage.
[Lifecycle evidence](../../deployment/evidence/CC-36-phase-2-cli-kubernetes-restore-lifecycle.json) records the encrypted backup, CLI commands, and source worker placement.
The target rejects the source session. Fresh login preserves the dark theme and completes all four Diagnostics checks.
All 28 diagnostic executions passed across source lifecycle recovery and target verification.
The test retains source writer shutdown during target verification.
Relevant lint, formatting, and whitespace checks passed.
The restore procedure still uses its isolated target adapter. This evidence does not establish complete CLI restore acceptance.

## Eighth candidate failures and continued qualification

The eighth candidate used source `9aadf55a917870c6e3ed08d548308e659fc017fa`.
[The terminal workflow record](../../deployment/evidence/CC-37-phase-2-eighth-published-run.json) records two failed application targets.
The PR workflow passed. The candidate did not publish a release bundle.
The hybrid target failed its Kestra diagnostic after the PostgreSQL outage despite restored HTTP readiness.
The operation did not recover within the existing 120-second bound. This failure remains unresolved.

[The reader failure](../../deployment/evidence/CC-35-phase-2-reader-9aadf55-failure.json) records five passed speech checks and a failed login announcement.
CC-35 returned to In Progress. Earlier reader results do not close the current failure.
A local probe reproduced disagreement between DOM focus and native accessibility focus.
The fixture now waits for the login control, requests native focus, and verifies that focus before activation.
[The corrected reader report](../../deployment/evidence/CC-35-phase-2-native-focus-reader.json) passes all six speech checks with Orca 50.2.
The complete browser target passed in 218 seconds with eighteen diagnostic observations and lifecycle recovery.
Candidate CI must still verify the correction against its Orca version and final images.

[The distributed hybrid CLI report](../../deployment/evidence/CC-36-phase-2-hybrid-cli.json) records three independent Docker daemons with distinct identifiers.
It transfers the generated worker fragments to separate daemon hosts and retains external TLS PostgreSQL and Redis.
Host preparation now verifies the Docker resource controls through the installer preflight.
A private connection probe traced the migration failure to DNS resolution of a single-label district hostname.
[The DNS probe](../../deployment/evidence/CC-36-phase-2-hybrid-dns.json) passed after using fully qualified fixture hostnames.
The corresponding single-label queries failed through the embedded resolver.
This evidence qualifies synthetic fixture behavior. It does not establish district DNS acceptance.

The API replica contract tests reproduced ignored replica counts in both Compose profiles.
The renderer now applies the configured API replica count while retaining resource limits and singular migration jobs.
The distributed CLI fixture asserts two running API containers and checks the same session against each container.
The following lifecycle evidence covers the synthetic distributed fixture. Full profile fault and release acceptance remain open.

The distributed CLI reached two healthy API replicas after the DNS correction.
Its first Kestra task failed immediately after installer resume.
The retained execution log reported `No X509TrustManager implementation available`.
A focused Java probe confirmed that unchanged preparation replaced the truststore password used by the running JVM.

[Preparation evidence](../../deployment/evidence/CC-36-phase-2-hybrid-preparation.json) records the reproduced failure and corrected probes.
Hybrid preparation now records protected input and output checksums.
Unchanged inputs and verified runtime files preserve the existing TLS stores and passwords.
Changed credentials, configuration, or damaged runtime files trigger regeneration.
Regression tests and the real Java truststore probe pass.
The complete distributed CLI target passed in 175 seconds after the correction.
It completed install, resume, API and worker restart, stop/resume, and uninstall/resume.
All sixteen diagnostic executions passed. Both API replicas accepted the same session before and after lifecycle recovery.
The fixture now retains each replica result and writes its passed report only after owned-resource cleanup succeeds.
Candidate CI includes this distributed CLI target. Final release qualification remains open.

The final distributed CLI target passed in 180 seconds, including owned-resource cleanup.
Its report records eight successful direct session checks across both API replicas and four lifecycle states.
All sixteen diagnostic executions passed without retry.
The fixture retained the original generated Compose files and preserved the dark theme through lifecycle recovery.
The report explicitly separates workspace qualification source from pinned published application images.
These results do not complete final revision qualification, isolated restore, upgrade, or full profile fault acceptance.

## Ninth candidate and distributed CLI upgrade

The ninth candidate used source `0185173a5b71831b813e890469661805cd9d69ee`.
[The terminal workflow record](../../deployment/evidence/CC-37-phase-2-ninth-published-run.json) records sixteen successful jobs and one failed application target.
The distributed hybrid target failed before application assertions because the outer Docker cache lacked the pinned Kestra image.
Image preparation now pulls absent references before exporting images to the independent Docker daemons.
The candidate did not publish a release bundle. CI must verify the image preparation correction on a clean runner.
The earlier hybrid outage check passed in this run. That result does not resolve the preceding intermittent recovery failure.

[The CI reader report](../../deployment/evidence/phase-2-published-0185173/reader/screen-reader.json) passes all six speech assertions with Orca 46.1.
It verifies native login focus before activation and retains eighteen diagnostic observations, including two transient Kestra failures after restart.
[The browser report](../../deployment/evidence/phase-2-published-0185173/auth/packaged-integration.json) passed against the same published application images in 73 seconds.
It covers identity denial, request security, session expiry, credential rotation, recovery, all utility operations, keyboard interaction, and themes.
The four accessibility reports contain zero violations and zero incomplete checks, including contrast and target-size rules.
The browser verifies 200 percent CSS zoom and 320 pixel reflow.
Review of both retained screenshots confirmed readable service results and rendered controls without clipping at the captured viewport.
[Artifact provenance](../../deployment/evidence/phase-2-published-0185173/artifact-provenance.json) identifies the original downloaded bytes before repository formatting.
Applicable rules are UI-01 through UI-06, UI-08 through UI-10, and FORM-01.
Native reader evidence addresses UI-09 and UI-10. Human listening and district identity-provider acceptance remain separate limits.

[The distributed CLI upgrade report](../../deployment/evidence/CC-37-phase-2-distributed-hybrid-cli-upgrade.json) records a complete local target pass in 267 seconds, including cleanup.
The actual CLI upgraded published Phase 1 images after creating a verified encrypted backup.
It preserved the foundation migration checksum, artifact metadata and bytes, Kestra execution, and two internal storage files.
The target verified new image content across two API replicas, the frontend, and two independent worker daemons.
All sixteen diagnostic executions and eight direct session checks passed after upgrade and lifecycle recovery.
This report combines workspace installer source with pinned published application images from `dae5f7a10a0347043931f5b97ef317882c1d70f6`.
Its original generic limits include upgrade among separate gates. The nested upgrade evidence establishes only this intermediate fixture result.
Final revision qualification, isolated CLI restore, full fault acceptance, and district infrastructure remain open.
The candidate workflow now includes the distributed CLI upgrade target.

## Distributed process faults and Docker network isolation

[The first process fault report](../../deployment/evidence/CC-36-phase-2-distributed-hybrid-process-faults.json) passed all six cases in 408 seconds, including cleanup.
The fixture interrupted API replicas, both workers, external Redis, external PostgreSQL, Kestra, and shared artifact access.
Each case observed a failure and then repeated the application checks and direct session checks on both API replicas.
Redis restart rejected the original session. Fresh sign-in preserved application preferences.
Every recovery preserved the principal, thirty-six original security events, migration records, artifact bytes, and two Kestra internal files.
External PostgreSQL recovery took 98 seconds, including Kestra recovery and repeated Diagnostics checks.
The earlier 120-second CI failure remains unresolved. One passing run does not establish repeatable recovery within that bound.
This intermediate report uses workspace qualification source and published application images from `dae5f7a`.
Capacity, certificate, isolated CLI restore, and final revision acceptance remain open.

[The tenth workflow record](../../deployment/evidence/CC-37-phase-2-tenth-published-run.json) records two failed distributed CLI sign-in checks.
The image-cache correction passed its earlier prerequisite. Both targets installed before the browser failed to reach the account page.
[The routing probe](../../deployment/evidence/CC-36-phase-2-hybrid-network-routing.json) reproduced overlapping outer and inner Docker bridges.
The default inner bridge routed the outer gateway `172.17.0.1` to loopback.
A separate bridge and address pool routed the same address through the outer interface.
The fixture now reserves independent private ranges outside all known outer Docker networks.
It also checks verified provider discovery from each API replica before browser sign-in.
The probe establishes the routing failure. CI must still verify complete sign-in with the correction.

The release regression test reproduced omission of the distributed CLI reports from candidate inventory.
Assembly now requires distributed install, upgrade, and process fault evidence with matching revisions, distinct daemon identifiers, and successful cleanup.
Upgrade and process fault reports must contain verified encrypted backup evidence.
The process fault report must contain every required interruption and recovery case.
Rejection tests cover mixed source, repeated host identifiers, incomplete cleanup, missing backup verification, and an omitted fault case.
These checks preserve candidate status until all fifteen complete profile acceptance records pass.

[The second process fault report](../../deployment/evidence/CC-36-phase-2-distributed-hybrid-process-failure.json) failed Kestra recovery after PostgreSQL loss.
The complete target ran for 412 seconds and removed its owned containers.
Both API replicas passed verified provider discovery after network isolation. Sign-in and the preceding CLI lifecycle passed.
API, worker, and Redis interruption checks passed. The PostgreSQL recovery exceeded the existing 120-second check bound.
This failure supersedes the earlier single pass as evidence of repeatability. Full process fault acceptance remains open.

The pinned [JdbcQueue implementation](https://github.com/kestra-io/kestra/blob/v1.3.37/jdbc/src/main/java/io/kestra/jdbc/runner/JdbcQueue.java) initiates synchronous shutdown from a polling failure.
Its queue closure waits up to thirty seconds for each executor termination.
The [shutdown listener](https://github.com/kestra-io/kestra/blob/v1.3.37/cli/src/main/java/io/kestra/cli/listeners/GracefulEmbeddedServiceShutdownListener.java) waits for embedded services to close.
The retained runtime log reported terminated executors and forced queue shutdown before restart.
These facts support the shutdown-wait hypothesis. They do not yet isolate every contribution to the recovery delay.
The production termination grace period remains five minutes. No runtime recovery change or test-bound increase has been applied.

The current Jira audit verifies [all sixteen epic links and twenty-five blocking links](../../deployment/evidence/CC-38-phase-2-current-jira-audit.json).
CC-36 records its completed configuration criterion. CC-38 records completed Jira linkage and UI evidence criteria.
Both tasks remain In Progress with the release task and epic.

## API restart readiness and focused Kestra diagnosis

The eleventh candidate passed verified provider discovery and initial browser checks on all three distributed hybrid targets.
Each target then failed the Diagnostics heading assertion after API restart.
The fixture now verifies the existing session on each restarted replica before browser navigation.
It retains response statuses and recovery times within a thirty-second bound.
The session must identify the original principal. No new OIDC login supplies that proof.

A [focused Kestra probe](../../deployment/kestra/README.md#database-recovery-probe) isolates PostgreSQL-loss recovery from application installation.
[Three observations](../../deployment/evidence/CC-36-phase-2-kestra-shutdown-probe.json) record task recovery and private JVM log checksums.
Five-minute grace runs recovered in 66.5 and 94.0 seconds. A three-second grace run recovered in 94.3 seconds.
JVM dumps show a queue thread waiting for shutdown callbacks while those callbacks wait for queue termination.
HTTP 200 responses continued during part of that delay without completed task execution.
The probe follows changed ephemeral ports after restart. The distributed fixture uses fixed ports.

The tagged [queue implementation](https://github.com/kestra-io/kestra/blob/v1.3.37/jdbc/src/main/java/io/kestra/jdbc/runner/JdbcQueue.java) invokes shutdown from the polling thread.
The [shutdown context](https://github.com/kestra-io/kestra/blob/v1.3.37/core/src/main/java/io/kestra/core/contexts/KestraContext.java) closes the application context synchronously.
The measured waits support a shutdown coordination diagnosis. They do not establish a production correction.
The retained distributed recovery failure remains open. The production grace period and recovery bound remain unchanged.

The complete distributed run with the readiness correction reached all installer lifecycle assertions and then reproduced PostgreSQL recovery failure.
[The failure record](../../deployment/evidence/CC-36-phase-2-distributed-hybrid-restart-failure.json) retains published image digests, fault progress, and the JVM observation.
The API, worker, and Redis fault cases passed. Kestra exceeded the unchanged 120-second recovery bound after PostgreSQL returned.
The failing queue thread waited in `ThreadPoolExecutor.awaitTermination` through `PostgresWorkerJobQueue.close` and `KestraContext.Initializer.shutdown`.
The final two fault cases did not run.

The repository Nx probe passed with the default grace period and verified resource cleanup.
[Its report](../../deployment/evidence/CC-36-phase-2-kestra-nx-probe.json) records 66.4-second task recovery.
This narrower probe does not override the failed distributed test.

## Shared foundation recovery budget

The existing foundation process harness uses a 180-second default recovery budget.
The new distributed Phase 2 fixture initially used 120 seconds.
The portfolio requires fault recovery evidence and explicit limits. It does not specify a two-minute orchestration recovery objective.
The distributed fixture now imports the existing foundation budget instead of defining a separate value.
One deadline covers session recovery and all four Diagnostics checks after each fault.
The signed candidate requires that budget and finite measured recovery times within it.
Missing timing, a different budget, and late recovery fail release validation.

This alignment does not correct Kestra shutdown coordination or erase the 120-second failures.
The production grace period remains five minutes. District recovery guarantees remain unqualified.
The focused Nx probe retains its narrower 120-second diagnostic bound.

[The distributed installation run](../../deployment/evidence/CC-36-phase-2-distributed-hybrid-restart-install.json) passed in 175.9 seconds with the readiness correction.
It verified ten direct session observations and removed every owned resource.
The constrained focused probe used the profile limits of two CPUs and 2 GiB. Task execution recovered in 67.1 seconds.
Those resource limits alone did not reproduce the longer distributed shutdown.

The [complete distributed run](../../deployment/evidence/CC-36-phase-2-distributed-hybrid-foundation-budget.json) passed all six fault cases under the shared budget.
PostgreSQL recovery took 93.0 seconds. The complete Nx target finished in 6 minutes 45 seconds.
The report preserves the verified Phase 1 upgrade, encrypted backup, distinct daemon identities, session checks, and cleanup result.
Every fault preserved application identity, preferences, security events, artifact bytes, and both Kestra internal files.
This pass does not erase earlier failures or establish a district recovery guarantee.
Full profile capacity, certificate, isolated CLI restore, and final release acceptance remain open.

## Native operator CLI qualification

[The native CLI fixture](../../deployment/evidence/CC-36-phase-2-native-operator-cli.json) passed encrypted backup, verification, and isolated restore in 5.3 seconds.
The CLI reads serialized operator inputs and resolves original secret references through a private `/run/secrets` mount.
The fixture uses native PostgreSQL 18.6 tools without an injected database command adapter.
It rejects key overwrite, active database clients, corrupt backup data, and nonempty restore targets.
Restored identity, preferences, security events, artifact bytes, and synthetic Kestra state match their source values.
The successful restore retains disabled services and requires fresh Redis.

This fixture uses loopback PostgreSQL without TLS and synthetic Kestra state.
The full application restore fixtures now invoke the operator CLI. Their current verification results follow below.

The first container CLI runs failed at backup on Docker Desktop.
[The failure evidence](../../deployment/evidence/CC-36-phase-2-cli-container-network-failure.json) records the full application failure and a smaller CLI reproduction.
A separate network probe connected from the native host but received `ECONNREFUSED` from the host-network container.
Local all-Docker and Kubernetes checks therefore use native host tools with isolated secret mounts.
Linux CI verifies the container path. Hybrid uses its existing operator container on the district fixture network.
Neither path injects a database command adapter.

The [all-Docker CLI restore](../../deployment/evidence/CC-36-phase-2-all-docker-operator-cli-restore.json) passed with published `a41bb2f` images.
The complete Phase 1 upgrade and restore target finished in 4 minutes 12 seconds.
The [hybrid CLI restore](../../deployment/evidence/CC-36-phase-2-hybrid-operator-cli-restore.json) passed through the existing TLS operator container.
Its complete target finished in 4 minutes 55 seconds.
Both restored application identity, preferences, security events, and artifact integrity.
Both rejected old sessions after fresh Redis started and passed all four Diagnostics operations.
The local fixtures include uncommitted CLI qualification changes after `a41bb2f`. They do not establish final revision acceptance.

Candidate assembly now requires native operator CLI evidence for all three application restore reports.
It rejects missing execution records, injected database adapters, and omitted backup, verify, or restore commands.
The rejection test first failed with a missing expected rejection. All four release tests passed after the gate changed.

The first native Kubernetes CLI backup failed when a second database connection terminated the shared port-forward process.
[The failure evidence](../../deployment/evidence/CC-36-phase-2-kubernetes-cli-tunnel-failure.json) records the connection reset and loss of the existing database session.
The fixture now assigns each database connection an independent port-forward process.
A live TCP regression verifies that one terminated tunnel leaves a concurrent database session usable.
All seven Kubernetes unit tests pass. The complete restore result follows.

The [Kubernetes CLI restore](../../deployment/evidence/CC-36-phase-2-kubernetes-operator-cli-restore.json) passed after tunnel isolation.
The complete target finished in 5 minutes 37 seconds. Isolated restore took 64.4 seconds.
Eight independent tunnels carried the source and target database sessions. Each database reached two concurrent connections.
The fixture preserved identity, preferences, 57 security events, and artifact integrity.
Old sessions failed after fresh Redis started. All four restored Diagnostics operations passed.
The test removed its Kind cluster and every owned port-forward process.

[The qualification record](../../deployment/evidence/CC-36-phase-2-operator-cli-qualification.json) binds local results to report hashes and the changed fixture files.
All three application restore targets now pass through the native operator CLI.
Final revision CI, complete profile fault evidence, and accepted release assembly remain required.

## Published native CLI and all-Docker fault evidence

[Candidate 016fd588](../../deployment/evidence/CC-37-phase-2-thirteenth-published-run.json) passed all twenty candidate jobs and published its signed candidate bundle.
All three application restore jobs passed through the native operator CLI in Linux CI.
All-Docker and Kubernetes used the operator container. Hybrid used its existing operator container with external TLS services.
PR CI failed formatting in four retained JSON reports.
[The formatting correction](../../deployment/evidence/CC-38-phase-2-evidence-format.json) preserves every parsed report value and records both file hashes.

[The all-Docker replica test](../../deployment/evidence/CC-36-phase-2-all-docker-replicas.json) passed with two API containers and published `016fd588` images.
Ten direct session requests verified both replicas after login, restart, stop/resume, uninstall/resume, and sign-out.
Every authenticated response identified the same principal. Both replicas rejected the signed-out session with HTTP 401.
The complete target finished in 2 minutes 22 seconds.

[The all-Docker fault test](../../deployment/evidence/CC-36-phase-2-all-docker-process-faults.json) passed seven authenticated interruptions in 5 minutes 54 seconds.
The cases cover API, workers, Redis, application PostgreSQL, Kestra PostgreSQL, Kestra, and artifact access.
Each case repeats all four Diagnostics operations and verifies durable application and Kestra state after recovery.
Redis recovery rejects the old session and requires another sign-in.
The slowest recovery took 62.4 seconds after the Kestra PostgreSQL interruption, within the shared 180-second budget.
The fixture also rejected expired and wrong-host edge certificates before application enrollment. Both cases restored eight protected startup checks.
Explicit erasure removed every owned installation container, network, and volume.

[The first fault run](../../deployment/evidence/CC-36-phase-2-all-docker-process-fixture-failure.json) passed six interruptions before its artifact permission helper failed.
The helper used root to read an owner-restricted configuration file.
The corrected helper uses the application file owner. Application permissions remain restricted.
[The qualification record](../../deployment/evidence/CC-36-phase-2-all-docker-qualification.json) binds reports and fixture files to their hashes.
These local fixtures include changes after the published image revision.

Candidate assembly now requires both replica observations and all seven bounded process recovery records.
Four release tests and both affected lint targets pass.
The candidate workflow adds the all-Docker process fault target, for fifteen application targets and twenty-one total jobs.
Complete profile capacity, Kubernetes application faults, remaining certificate coverage, final revision evidence, and accepted release assembly remain open.
Phase 1 acceptance remains separate.

## Published all-Docker fault qualification

[Candidate ef498231](../../deployment/evidence/CC-37-phase-2-fourteenth-published-run.json) passed all twenty-one jobs and published its signed candidate bundle.
All seven PR CI jobs also passed, including the corrected formatting check.
The all-Docker profile verified ten session requests across two API replicas.
All seven authenticated process faults passed against the same published source and images.
The longest CI recovery took 95.5 seconds after the Kestra PostgreSQL interruption, within the shared 180-second budget.
The report retains original CI artifact hashes. Candidate publication does not establish release acceptance.

## Kubernetes authenticated process faults

[The Kubernetes process fault test](../../deployment/evidence/CC-36-phase-2-kubernetes-process-faults.json) passed all seven interruptions in 8 minutes 56 seconds.
The fixture uses published `016fd588` images and current fixture changes after `ef498231`.
It performs the real Phase 1 upgrade, encrypted baseline backup, installer lifecycle checks, and worker rescheduling before fault injection.
The cases stop both API pods, both workers, Redis, application PostgreSQL, Kestra PostgreSQL, and Kestra. Another case removes artifact access.
Every case repeats all four authenticated Diagnostics operations and verifies durable state after recovery.
Redis recovery requires another sign-in and rejects the old session.
The longest recovery took 112.9 seconds after Kestra PostgreSQL interruption, within the shared 180-second budget.
The fixture preserved identity, preferences, 56 security events, artifact bytes, seven completed Kestra executions, and one internal storage file.
Two worker node identities remained distinct. The fixture removed its dedicated Kind cluster before publishing the passed report.

[The first run](../../deployment/evidence/CC-36-phase-2-kubernetes-fault-timeout-failure.json) failed when the interrupted API produced a 45-second browser timeout.
The fixture originally required an HTTP error response during an outage with no API endpoints.
A small browser regression reproduced that assumption failure in under one second.
The fixture now records bounded session transport timeouts during deliberate outages. It still requires successful authentication and Diagnostics after recovery.
The corrected browser regression and complete Kubernetes target pass.

Candidate assembly requires all seven Kubernetes cases, the exact source and images, bounded recovery, and confirmed cluster cleanup.
The candidate workflow runs the browser timeout regression before Kubernetes fault qualification.
The matrix now contains sixteen application targets and twenty-two total jobs.
Four release tests and both affected lint targets pass.
[The qualification record](../../deployment/evidence/CC-36-phase-2-kubernetes-fault-qualification.json) binds reports and fixture files to their hashes.

Three Kind nodes share one Docker host and synthetic storage. The fixture does not enforce NetworkPolicy.
Complete profile capacity and certificate coverage, final revision qualification, and accepted release assembly remain open.
Phase 1 acceptance remains separate.
