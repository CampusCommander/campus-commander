# Campus Commander

Campus Commander is a locally hosted Google Workspace administration tool for K–12 districts.
It supports entity discovery, inventory insight, and small or district-wide updates with durable audit evidence.

**Status: preimplementation planning.** Existing scaffolding and prototype assets do not establish a working production application.
The [design portfolio](docs/portfolio/README.md) incorporates the contractor review and owner decisions as of 2026-09-05.
Follow its [ten development phases](docs/portfolio/06-work-breakdown.md#delivery-sequence) and resolve the V0 findings required by each phase.
Phase 1 supplies all Docker, hybrid Docker with district services, and enterprise Kubernetes installations.
Each later phase delivers a working version that preserves those deployment modes and earlier capabilities.

## Retained technology

| Responsibility | Technology |
|---|---|
| Interface | Angular, NgRx Signals, Angular Material, Tailwind |
| Grid | AG Grid Community and LibreGrid |
| API and workers | NestJS and TypeScript, with worker execution outside the API |
| Orchestration | Kestra jobs, steps, and parallel assignments |
| Durable data | PostgreSQL |
| Cache and coordination | Redis, including job-service admission holds |
| Artifacts | Job-storage interface with persistent local storage and one qualified shared backend in Phase 1 |
| Workspace | Nx and npm |

Exact compatible versions require qualification before implementation.
One installation serves one Workspace customer account, including its supported domains.
Every mutation follows preview, confirmation, job execution, and file-backed audit evidence.

## Deployment direction

| Profile | Placement |
|---|---|
| Single server | Compose runs application, workers, Kestra, PostgreSQL, and Redis with persistent local artifacts. |
| Separate services | The same images use district-managed databases, Redis, or worker hosts through configured endpoints. |
| Kubernetes | District-operated API/worker replicas use shared services and qualified artifact storage. |

Compose is the default. Kubernetes is optional. Distributed workers require a shared backend before activation.
Kestra availability, shared-service recovery, and district capacity remain qualification gates.
The existing Compose scaffold is not a supported installation release.

## Repository layout

The current workspace uses root-level `frontend/` and `api/` projects, with supporting libraries and end-to-end projects.
The planning documents define future worker, contract, domain, database, Google, job, and storage boundaries.
Do not create a second `apps/` tree from historical diagrams.

Use npm-prefixed Nx tasks when working with existing projects. Inspect available targets before running a task.
Future production releases will provide prebuilt images and an installer. Customers will not compile this repository.

## Documentation

- [Design portfolio](docs/portfolio/README.md): current product, architecture, interactions, decisions, and work plan.
- [Contractor report](docs/reviews/2026-09-04-contractor-report.md): review conclusions and supporting evidence.
- [Archive](docs/archive/README.md): earlier sources retained for traceability without current authority.

## Work tracking

GitHub records source changes, planning documents, validation evidence, and pull requests.
Jira records implementation tasks and dependencies in the Campus-Commander project, key `KAN`.
The [Phase 1 backlog](docs/portfolio/phase-1-jira-tasks.md) maps local planning references to KAN-4 through KAN-20.

Include the Jira issue key in implementation branch names, commit messages, and pull request titles.
For example, use `KAN-4-deployment-contract` for the configuration contract task.
Link the Jira task and describe validation evidence in each implementation pull request.
Update task status only when its acceptance criteria have supporting evidence.

## License

MIT
