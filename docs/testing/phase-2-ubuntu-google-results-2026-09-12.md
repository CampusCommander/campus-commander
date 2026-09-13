**Manual Ubuntu and Google Workspace test result — September 12, 2026**

**Result: PASS, reported by the operator.**

The operator reported: “All tests passed.”
This report follows the [Ubuntu testing recipe](https://easton-consulting.atlassian.net/browse/CC-38?focusedCommentId=10183) and the subsequent disk-recovery instructions.

| Item                       | Record                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------- |
| Environment                | Separate Ubuntu LTS test server. Hyper-V VM selected during preparation.            |
| Deployment profile         | all-docker, confirmed by the supplied installer output.                             |
| Identity provider          | Google Workspace, selected for this test.                                           |
| Installation configuration | /home/seaston/cc-phase2-lab/operator.json                                           |
| Application URL            | https://localhost:8443                                                              |
| OIDC callback URL          | https://localhost:8443/api/auth/callback                                            |
| Prescribed release         | phase-2-qualified-436d3b0698a5                                                      |
| Prescribed source revision | 436d3b0698a54b3268e608d83524b0d5c7195a25                                            |
| Installer mode             | Candidate laboratory installation, confirmed by the supplied output.                |
| Evidence source            | Operator report and pasted installer output. No direct agent access to the test VM. |

**Disk interruption and recovery**

The operator reported a full HDD during installation.
The operator selected resume for the existing installation.
The supplied output confirmed “Running resume for all-docker” and “Readiness: ready.”
The operator then reported that all tests passed.

| Check                         | Result                  | Evidence                                                                             |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| Resume after full disk        | PASS                    | Supplied installer output reports ready for the existing installation.               |
| PostgreSQL Diagnostics        | PASS, operator-reported | Included in the four checks immediately preceding the operator's report.             |
| Redis Diagnostics             | PASS, operator-reported | Included in the four checks immediately preceding the operator's report.             |
| Kestra Diagnostics            | PASS, operator-reported | Included in the four checks immediately preceding the operator's report.             |
| Artifact storage Diagnostics  | PASS, operator-reported | Included in the four checks immediately preceding the operator's report.             |
| Manual testing recipe overall | PASS, operator-reported | “All tests passed.” Individual browser and lifecycle observations were not supplied. |

The recipe covers Google sign-in, account enrollment, navigation, preferences, access denial, session behavior, API outages, and VM restart.
The overall result records the operator's statement. It does not create missing per-step logs or measurements.
The installed release identifier, exact Ubuntu version, browser version, disk capacity, recovery duration, and disk remediation steps were not supplied.
The prescribed release identifies the recipe target. The supplied output does not independently confirm the installed revision.

**Acceptance effect and follow-up**

This report adds manual all-Docker laboratory evidence with the selected Google Workspace provider.
The installation recovered after a real disk interruption. No unresolved test failure was reported.
The initial disk interruption remains part of the record. Its cause and remediation details await the operator's process notes.
The candidate warning is expected. The signed release still records districtInfrastructureAcceptance: not-qualified.

CC-36, CC-37, CC-38, and epic CC-22 remain In Progress.
District hybrid and Kubernetes acceptance, trusted district TLS, Phase 1 upgrade, and isolated restore require their remaining environment evidence.
Phase 1 acceptance remains separate.
The operator subsequently reported three onboarding improvements: startup activity, Google credential setup, and integrated first-administrator enrollment.
Follow-up tasks: [CC-39](https://easton-consulting.atlassian.net/browse/CC-39), [CC-40](https://easton-consulting.atlassian.net/browse/CC-40), and [CC-41](https://easton-consulting.atlassian.net/browse/CC-41).
The [GAM research](../research/gam-onboarding-2026-09-13.md) records the proposed credential and enrollment workflow.
These process improvements do not change the operator's passing functional test report.

Record: [CC-38 manual test result](https://easton-consulting.atlassian.net/browse/CC-38?focusedCommentId=10184).
Procedure: [Ubuntu testing recipe](phase-2-ubuntu-google.md).
