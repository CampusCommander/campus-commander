# Campus Commander

Campus Commander is a locally hosted Google Workspace administration tool for K–12 districts.
It supports entity discovery, inventory insight, and small or district-wide updates with durable audit evidence.

**Status: Phase 1 candidate testing.** Published candidates are not accepted production releases.
The [design portfolio](docs/portfolio/README.md) incorporates the contractor review and owner decisions as of 2026-09-05.
Follow its [ten development phases](docs/portfolio/06-work-breakdown.md#delivery-sequence) and resolve the V0 findings required by each phase.
Phase 1 supplies all Docker, hybrid Docker with district services, and enterprise Kubernetes installations.
Each later phase delivers a working version that preserves those deployment modes and earlier capabilities.

## Try the published installer

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

The current workspace uses root-level `frontend/` and `api/` projects, with supporting libraries and end-to-end projects.
The planning documents define future worker, contract, domain, database, Google, job, and storage boundaries.
Do not create a second `apps/` tree from historical diagrams.

Use npm-prefixed Nx tasks when working with existing projects. Inspect available targets before running a task.
Published candidates provide prebuilt images and an installer. Customers do not compile this repository.

## Documentation

- [Design portfolio](docs/portfolio/README.md): current product, architecture, interactions, decisions, and work plan.
- [Contractor report](docs/reviews/2026-09-04-contractor-report.md): review conclusions and supporting evidence.
- [Archive](docs/archive/README.md): earlier sources retained for traceability without current authority.

## Work tracking

GitHub records source changes, planning documents, validation evidence, and pull requests.
Jira records implementation tasks and dependencies in the Campus-Commander project, key `CC`.
The [Phase 1 backlog](docs/portfolio/phase-1-jira-tasks.md) maps local planning references to CC-4 through CC-20.

Include the Jira issue key in implementation branch names, commit messages, and pull request titles.
For example, use `CC-4-deployment-contract` for the configuration contract task.
Link the Jira task and describe validation evidence in each implementation pull request.
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
