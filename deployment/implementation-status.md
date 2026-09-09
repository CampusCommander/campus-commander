# Phase 1 closeout status

Audit date: 2026-09-09.
Phase 1 source is implemented. Required acceptance gates remain open.
The public installer passed hosted installation and resume checks for all three profiles.
The candidate remains unaccepted. Phase 2 application work has not started.

The current Jira project key is `CC`. [CC-21](https://easton-consulting.atlassian.net/browse/CC-21) tracks Phase 1.
The matrix below follows each ticket's actual criteria. It does not add district production guarantees to synthetic test requirements.

## Acceptance matrix

| Ticket | Assessment | Evidence or remaining action                                                                       |
| ------ | ---------- | -------------------------------------------------------------------------------------------------- |
| CC-4   | Complete   | Configuration contract, three examples, rejection checks, and placement decision                   |
| CC-5   | Complete   | Kestra runtime, authentication, telemetry policy, and synthetic restart                            |
| CC-6   | Complete   | Nx image builds, signed publication, anonymous verification, and hosted startup                    |
| CC-7   | Complete   | Database isolation, migrations, TLS, restart, and hosted profiles                                  |
| CC-8   | Complete   | Redis authentication, ACLs, TLS, restart, and readiness                                            |
| CC-9   | Complete   | Artifact publication, integrity, interruption, and failure checks                                  |
| CC-10  | Complete   | Worker host A published an artifact. Worker host B verified identical bytes and database metadata  |
| CC-11  | Complete   | Controller-owned Kestra internal-file restart and authenticated external workers                   |
| CC-12  | Complete   | HTTPS, bootstrap lifecycle, protected startup, route denial, and Chromium checks                   |
| CC-13  | Complete   | All-Docker installation, restart, lifecycle, upgrade, restore, and fault fixtures                  |
| CC-14  | Complete   | Hosted hybrid controller, external TLS services, two worker daemons, and resume                    |
| CC-15  | Complete   | Calico enforced 29 DNS, allowed-service, and denied-service connection checks                      |
| CC-16  | Complete   | All three profiles passed lifecycle, backup-gated image upgrade, fixture preservation, and erasure |
| CC-17  | Complete   | Isolated synthetic restores for all-Docker, hybrid, and Kubernetes                                 |
| CC-18  | Open       | Hybrid faults and Kubernetes certificates passed. Complete bounded Kubernetes capacity testing     |
| CC-19  | Complete   | Signed candidate publication, rejection gates, and report-content binding regression tests         |
| CC-20  | Open       | Independent human walkthroughs, required records, and completion decision                          |

Ticket evidence resides under [evidence](evidence/).
The [hosted validation record](installer/HOSTED-VALIDATION.md) links retained machine results.
The [operator record](evidence/CC-20.md) distinguishes the assisted customer session from agent execution.
The [walkthrough template](evidence/operator-walkthrough-template.md) defines the remaining human records.

## Code and documentation cleanup

The closeout combines the implementation branch with public installer documentation.
It corrects obsolete publication statements and updates Jira references from `KAN` to `CC`.
Generated local test credentials are excluded from Git.
The unused Angular library placeholder was removed.
The generated Jest API test was replaced with a built-server test for startup, access denial, and shutdown.
Main CI now includes API end-to-end, operations, and qualification checks.

The code review identified runtime-version validation and release-evidence binding gaps.
Both corrections passed regression tests, including the complete 43-test installer suite.
Kubernetes manifest history now preserves retired upgrade resources for verified uninstall.
The expanded installer suite passed 45 tests, including interrupted rendering and ownership rejection.
The network documentation now distinguishes internal all-Docker services from private hybrid worker listeners.
External firewall verification remains an infrastructure-operator responsibility.

A duplicated secret-path mapping remains a nonblocking maintenance observation.
A broad path-module refactor is not required to establish the current storage and credential contracts.

## Phase 2 boundary

Phase 2 begins after required Phase 1 gates pass and the owner records the completion decision.
Its scope includes application structure, authentication, login, shell, and service utilities.
Preserve installer behavior and all three deployment profiles.
Keep Google onboarding in Phase 3. Keep EntityCache and mutation JobService in their later phases.
