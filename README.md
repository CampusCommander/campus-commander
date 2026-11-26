# Campus Commander

Campus Commander is a locally hosted Google Workspace administration tool for K–12 districts.
The intended product centers on device, user, OU, and group administration.
The owner signs off each workflow after he reviews a running build.
The [current work record](docs/current-work.md) holds each sign-off.
School creation and the built invitation workflow stay disputed. See [workflow gaps](docs/workflow-gaps.md).

**Status: Greenfield application development. Nothing is live.**
Phases organize development. They are not a user upgrade path. Development test data is disposable.
Start with [the documentation guide](docs/README.md), [current work](docs/current-work.md), and [workflow gaps](docs/workflow-gaps.md).

## What works today

The owner signed off each workflow below. The date in parentheses is the sign-off date.

- Device browsing: the grid, typed filters, battery health, and device details (2026-10-16).
- Update the annotated location of selected devices, with the Jobs page (2026-10-20).
- Reboot, Disable, and Re-enable (2026-10-22).
- Update device fields (2026-10-22).
- Wipe user data, Powerwash, and Deprovision (2026-10-23).
- In-grid editing and the single-device update (2026-10-24).
- Cancel pending work on any job (2026-10-28).
- Device export and import through CSV files (2026-10-30).
- Google users: browse, filter, refresh, and user details, slice S1 (2026-11-18).
- Google users: custom attribute categories, slice S2 (2026-11-24).

The [current work record](docs/current-work.md) lists the work in build.

## Install a review build

The installer installs the newest signed review build.
Each review build is published from `main` on request.
Use the review command below to run current source changes.

A first installation needs:

1. An HTTPS host name and certificate, or the installer's disposable laboratory certificate.
2. A Google sign-in client, with the redirect URI `https://YOUR-HOST/api/auth/callback`. Register the client through [the application access guide](deployment/bootstrap/APPLICATION-ACCESS.md).
3. The installer's enrollment of the first platform administrator.
4. A service account with domain-wide delegation. The **Google connection** page gives a delegation link with the scopes filled in.

Follow [the fresh installation guide](docs/testing/fresh-install-review.md) for the full steps.

Start in a Linux amd64 shell with internet access and root or sudo access.
Run the installer first:

```sh
curl -fsSL https://raw.githubusercontent.com/CampusCommander/campus-commander/main/install.sh | sh
```

The installer detects the environment and offers automatic prerequisite installation, manual instructions, or cancellation.
It verifies the signed release and guides configuration for all-Docker, hybrid, or Kubernetes installation.
Ubuntu and Debian support automatic package installation, including Docker and Compose.
Sudo requests your password through the terminal. The installer never reads or stores your sudo password.
Hybrid requires your external services. Kubernetes requires your existing cluster and storage.
Select candidate mode for disposable testing. Approve prerequisite exceptions only when they describe your test environment.

If neither `curl` nor `wget` exists, download and copy `install.sh` to the machine, then run `sh install.sh`.
The installer can install its missing download tools.

### Container installations

The installer works inside containers. A virtual machine is not required.
All-Docker installation requires a working Docker daemon or an outer container configured to permit Docker nesting.
Root or sudo inside a restricted container cannot grant missing host capabilities.
The installer detects this restriction and prints host-side launch instructions.

For disposable testing, the hosted guide provides a privileged Ubuntu container with a private Docker daemon and persistent volumes.
Privileged containers grant broad host access. Use a dedicated test environment.
Preserve `/var/lib/docker` and the installation directory across container restarts.
Repeat the installer after a restart to start the daemon and resume the application.
The [container validation record](deployment/evidence/CC-20-container-installer-2026-09-11.md) documents fresh Ubuntu installation, readiness, resource limits, and restart recovery.

Read the [hosted installation guide](deployment/installer/HOSTED.md) for download alternatives, environment guidance, and recovery commands.
Use the [Kubernetes test procedure](deployment/installer/HOSTED-KUBERNETES-TEST.md) to prepare a disposable cluster fixture.
Use [published releases](https://github.com/CampusCommander/campus-commander/releases) for signed artifacts.
Read the [hosted validation record](deployment/installer/HOSTED-VALIDATION.md) for tested behavior and laboratory limits.

## Run the application for review

Use Linux or WSL with Node 24.19, npm, and a running Docker daemon.
From the repository root, run:

```sh
npm ci
npm exec -- nx run api-e2e:client-review
```

Open the HTTPS URL printed by the command and select **Sign in to Campus Commander**.
The command runs the current client, API, worker, PostgreSQL, Redis, and Kestra.
Google sign-in and Workspace responses use a simulator. No Google account or real service-account key is required.
The terminal prints a generated sample key file and delegated email for the connection form.
The client displays a development-review notice. Do not upload real credentials to this review environment.

Keep the command running while reviewing. Stop it to remove its disposable environment.
See [the client review guide](docs/testing/client-review.md) for certificate prompts and the review steps.
For a prebuilt review candidate, follow [the fresh installation guide](docs/testing/fresh-install-review.md).

The `client-review-mock` target runs the same review environment against the Admin SDK mock.
See [the client review guide](docs/testing/client-review.md#review-against-admin-sdk-mock) for that target.

## Retained technology

| Responsibility         | Technology                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| Interface              | Angular, NgRx Signals, Angular Material, Tailwind                                               |
| Grid                   | AG Grid Community and LibreGrid                                                                 |
| API and workers        | NestJS and TypeScript, with worker execution outside the API                                    |
| Orchestration          | Kestra jobs, steps, and parallel assignments                                                    |
| Durable data           | PostgreSQL                                                                                      |
| Cache and coordination | Redis, including job-service admission holds                                                    |
| Artifacts              | Job-storage interface with persistent local storage and one qualified shared backend in Phase 1 |
| Workspace              | Nx and npm                                                                                      |

Exact compatible versions require qualification before implementation.
One installation serves one Workspace customer account, including its supported domains.
Every mutation follows preview, confirmation, job execution, and file-backed audit evidence.

## Deployment direction

| Profile    | Placement                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| All-Docker | Compose runs application, workers, Kestra, PostgreSQL, and Redis with persistent local artifacts.    |
| Hybrid     | The same images use district-managed databases, Redis, or worker hosts through configured endpoints. |
| Kubernetes | District-operated API/worker replicas use shared services and qualified artifact storage.            |

Compose is the default. Kubernetes is optional. Distributed workers require a shared backend before activation.
Kestra availability, shared-service recovery, and district capacity remain qualification gates.
The existing Compose scaffold is not a supported installation release.

## Repository layout

The workspace holds the `frontend/`, `api/`, and `worker/` projects, the `libs/application-contracts` and `libs/google-connection` libraries, and the `api-e2e/` and `frontend-e2e/` end-to-end projects.
The `deployment/` directory holds the images, the installer, the profiles, the Kestra flows, and the PostgreSQL migrations.
Do not create a second `apps/` tree from historical diagrams.

Use npm-prefixed Nx tasks when working with existing projects. Inspect available targets before running a task.
Published candidates provide prebuilt images and an installer. Customers do not compile this repository.

## Documentation

- [Documentation guide](docs/README.md): source authority, reading order, and workflow format.
- [Workflow gaps](docs/workflow-gaps.md): defined behavior, disputed features, and missing product decisions.
- [Client UI guide](docs/ui/README.md): the shared rules, patterns, and tokens of the client pages.
- [File inventory](docs/document-index.csv): all indexed project documentation and evidence.
- [Design portfolio](docs/portfolio/README.md): product, architecture, and interaction references.
- [Contractor report](docs/reviews/2026-09-04-contractor-report.md): review conclusions and supporting evidence.
- [Archive](docs/archive/README.md): earlier sources retained for traceability without current authority.

## Work tracking

GitHub records source changes, planning documents, validation evidence, and pull requests.
Jira is no longer required for development. Existing issues and task snapshots remain historical references.
Do not synchronize or expand Jira unless the owner requests it.
Use focused `codex/` branches and describe the actual change. Jira keys are not required.
The [current work record](docs/current-work.md) controls development order.
Describe the validation evidence in each pull request.
Update task status only when its acceptance criteria have supporting evidence.

## License

Campus Commander uses the [Campus Commander Community License 1.0.0](LICENSE.md).
Public K–12 schools, their districts, and public colleges and universities qualify worldwide.
Other nonprofits qualify only when all their services are free of charge.
Eligible organizations receive perpetual rights for their own institutional use, subject to the license terms.
Paid contractors can act solely on an eligible organization's behalf.
Other uses require a separate paid agreement before use begins.
Contact Spencer Easton at spencer@easton-consulting.com for paid licensing.
The license includes warranty and liability limitations. Third-party components retain their own licenses.
