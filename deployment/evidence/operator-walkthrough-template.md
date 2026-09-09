# Operator walkthrough record template for CC-20

## Record rules

Copy one record for the all-Docker, hybrid, and Kubernetes walkthroughs.
Set every field to `not-run` before execution.
Use `pass`, `fail`, or `blocked` only after the operator performs the step.
Use `blocked` with the owning ticket when the published procedure is absent.
Use the [hosted installer procedure](../installer/HOSTED.md) for installation.
Use the [installer CLI procedure](../installer/README.md) for lifecycle commands.
Use the [release procedure](../release/README.md) for integrity verification.
Use the [operations procedure](../operations/README.md) for backup and restore.
Published candidate artifacts are available through [project releases](https://github.com/CampusCommander/campus-commander/releases).
CC-19 supplies the release digest and source revision.
Record no credential values, network account names, endpoint credentials, or secret values.
Do not infer human acceptance from this template.

## Record: all-Docker

### Walkthrough metadata

| Field                              | Value   |
| ---------------------------------- | ------- |
| Participant role                   | not-run |
| Release digest and source revision | not-run |
| Environment                        | not-run |
| Start time                         | not-run |
| End time                           | not-run |
| Assistance                         | not-run |
| Failed steps                       | not-run |

### Operation evidence

| Field                          | Value   |
| ------------------------------ | ------- |
| Protected startup status       | not-run |
| Restart fixture integrity      | not-run |
| Restore verification           | not-run |
| Interrupted install recovery   | not-run |
| Backup-gated upgrade           | not-run |
| Redacted support diagnostics   | not-run |
| Preserved data after uninstall | not-run |
| Release integrity              | not-run |

| Service                | Operational status |
| ---------------------- | ------------------ |
| Frontend               | not-run            |
| API                    | not-run            |
| Workers                | not-run            |
| Application PostgreSQL | not-run            |
| Kestra PostgreSQL      | not-run            |
| HTTPS edge             | not-run            |
| Redis                  | not-run            |
| Kestra                 | not-run            |
| Storage                | not-run            |

### Findings and handoff

| Field                         | Value   |
| ----------------------------- | ------- |
| Defects                       | not-run |
| Explicit decision             | not-run |
| Operator sign-off and date    | not-run |
| Reviewer sign-off and date    | not-run |
| Application structure handoff | not-run |
| Authentication handoff        | not-run |
| Login handoff                 | not-run |
| Shell handoff                 | not-run |
| Service utilities handoff     | not-run |
| Google onboarding handoff     | not-run |

## Record: hybrid

### Walkthrough metadata

| Field                              | Value   |
| ---------------------------------- | ------- |
| Participant role                   | not-run |
| Release digest and source revision | not-run |
| Environment                        | not-run |
| Start time                         | not-run |
| End time                           | not-run |
| Assistance                         | not-run |
| Failed steps                       | not-run |

### Operation evidence

| Field                          | Value   |
| ------------------------------ | ------- |
| Protected startup status       | not-run |
| Restart fixture integrity      | not-run |
| Restore verification           | not-run |
| Interrupted install recovery   | not-run |
| Backup-gated upgrade           | not-run |
| Redacted support diagnostics   | not-run |
| Preserved data after uninstall | not-run |
| Release integrity              | not-run |

| Service                | Operational status |
| ---------------------- | ------------------ |
| Frontend               | not-run            |
| API                    | not-run            |
| Workers                | not-run            |
| Application PostgreSQL | not-run            |
| Kestra PostgreSQL      | not-run            |
| HTTPS edge             | not-run            |
| Redis                  | not-run            |
| Kestra                 | not-run            |
| Storage                | not-run            |

### Findings and handoff

| Field                         | Value   |
| ----------------------------- | ------- |
| Defects                       | not-run |
| Explicit decision             | not-run |
| Operator sign-off and date    | not-run |
| Reviewer sign-off and date    | not-run |
| Application structure handoff | not-run |
| Authentication handoff        | not-run |
| Login handoff                 | not-run |
| Shell handoff                 | not-run |
| Service utilities handoff     | not-run |
| Google onboarding handoff     | not-run |

## Record: Kubernetes

### Walkthrough metadata

| Field                              | Value   |
| ---------------------------------- | ------- |
| Participant role                   | not-run |
| Release digest and source revision | not-run |
| Environment                        | not-run |
| Start time                         | not-run |
| End time                           | not-run |
| Assistance                         | not-run |
| Failed steps                       | not-run |

### Operation evidence

| Field                          | Value   |
| ------------------------------ | ------- |
| Protected startup status       | not-run |
| Restart fixture integrity      | not-run |
| Restore verification           | not-run |
| Interrupted install recovery   | not-run |
| Backup-gated upgrade           | not-run |
| Redacted support diagnostics   | not-run |
| Preserved data after uninstall | not-run |
| Release integrity              | not-run |

| Service                | Operational status |
| ---------------------- | ------------------ |
| Frontend               | not-run            |
| API                    | not-run            |
| Workers                | not-run            |
| Application PostgreSQL | not-run            |
| Kestra PostgreSQL      | not-run            |
| HTTPS edge             | not-run            |
| Redis                  | not-run            |
| Kestra                 | not-run            |
| Storage                | not-run            |

### Findings and handoff

| Field                         | Value   |
| ----------------------------- | ------- |
| Defects                       | not-run |
| Explicit decision             | not-run |
| Operator sign-off and date    | not-run |
| Reviewer sign-off and date    | not-run |
| Application structure handoff | not-run |
| Authentication handoff        | not-run |
| Login handoff                 | not-run |
| Shell handoff                 | not-run |
| Service utilities handoff     | not-run |
| Google onboarding handoff     | not-run |
