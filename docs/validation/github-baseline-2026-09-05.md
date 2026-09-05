# GitHub baseline — 2026-09-05

The initial GitHub publication preserves the existing Git history and current workspace work.
It includes the design portfolio, archived sources, contractor reviews, V0 experiments, and published Phase 1 Jira backlog.
Application scaffolding and design tokens remain an implementation baseline.

## Tracking

Jira contains 17 Phase 1 tasks, KAN-4 through KAN-20, with 36 verified blocking links.
The [backlog](../portfolio/phase-1-jira-tasks.md) records the issue URLs and acceptance criteria.
GitHub records commits and pull requests for that work.

## Publication checks

| Check | Result |
|---|---|
| Nx project discovery | Pass. Five workspace projects resolve after `.nxignore` excludes disposable validation experiments. |
| API build | Pass through `npm exec nx run api:build`. |
| Frontend build | Fail through `npm exec nx run frontend:build`. The frontend remains an unqualified scaffold. |
| Prepared Jira content | All 17 tasks and 36 links have verified publication records. |
| Local artifacts | Git ignores agent session state, compiler caches, environment files, and installation secrets. |

The frontend compiler correction belongs to [KAN-6](https://easton-consulting.atlassian.net/browse/KAN-6).
The existing CI workflow requires Nx Cloud distribution and runs scaffold checks that have not passed qualification.
Release CI qualification belongs to [KAN-19](https://easton-consulting.atlassian.net/browse/KAN-19).
This publication does not establish a working installation or completed Phase 1 acceptance.
