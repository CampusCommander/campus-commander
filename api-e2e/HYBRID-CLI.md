# Distributed hybrid CLI qualification

The target runs the real installer against three independent Docker daemons.
One daemon hosts the controller. Two daemons host the generated worker fragments.
The fixture supplies external TLS PostgreSQL, external TLS Redis, synthetic DNS, and shared artifact and Kestra directories.

```sh
npx nx run api-e2e:hybrid-cli-integration
```

Set `CC_AUTH_API_IMAGE`, `CC_AUTH_FRONTEND_IMAGE`, and `CC_AUTH_WORKER_IMAGE` to published digest references.
All three application images must identify the same source revision.
The fixture builds its disposable Docker host image from the pinned Docker image and selected application image.
It requires privileged Docker containers and network access for pinned images and Alpine packages.

The target prepares, installs, resumes, stops, and uninstalls through the CLI.
It verifies API and worker restart, preserved preferences, and the same session against both API replicas.
The target preserves generated Compose files and transfers worker fragments without changing their contents.
A separate overlay supplies trust for the synthetic identity provider through the existing district CA mount.

The report resides at `dist/phase-2-evidence/hybrid-cli.json`.
It records daemon identifiers, replica session results, diagnostic results, commands, and fixture cleanup.
The target writes a passed report only after it removes owned resources.
Failures retain private status and container logs in the temporary fixture directory.

Three daemons share one physical Docker host. Shared directories use synthetic storage on that host.
The install target does not establish district infrastructure acceptance, full fault acceptance, upgrade, or isolated restore.
Final release qualification requires matching installer, test, and application source revisions.

## Phase 1 upgrade

```sh
npx nx run api-e2e:hybrid-cli-upgrade-integration
```

The upgrade target starts the pinned Phase 1 baseline through the same distributed CLI fixture.
It verifies the running baseline image content and creates an immutable artifact, Kestra execution, and internal storage file.
The target stops source writers and creates a verified encrypted recovery backup before the CLI upgrade.
It verifies both migration records, exact artifact metadata and bytes, Kestra execution, and internal file checksums after upgrade.
It transfers the upgraded worker fragments and repeats the authenticated lifecycle and shared-session checks.
The report resides at `dist/phase-2-evidence/hybrid-cli-upgrade.json`.

Image preparation pulls absent application and infrastructure images before export to the independent Docker daemons.
The fixture preserves exact digest references during transfer.
The upgrade target retains the synthetic host and storage limits described above.
Isolated CLI restore and full fault acceptance require separate evidence.
