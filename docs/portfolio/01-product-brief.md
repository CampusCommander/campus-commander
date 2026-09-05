# 01 — Product Brief

**Status:** current planning baseline, revised 2026-09-05. Validation gates remain open in [06](06-work-breakdown.md).

## What Campus Commander is

Campus Commander is a locally hosted administration tool for Google Workspace in K–12 school districts.
It helps staff find entities, understand their condition, and apply small or district-wide changes with auditable results.
Search and browsing use a local read model. Google controls external request acceptance and propagation.
The product must show observation age and unresolved results accurately.

## Audience and permissions

Occasional IT helpers need guided setup, plain-language actions, and reliable entity lookup.
District administrators need large selections, repeatable updates, scoped delegation, recovery, and operational visibility.

Use permission grants with simple presets: platform administrator, district operator, school operator, and viewer.
Presets do not replace action, resource, destination, field, and export permissions.
Schools are district-defined scopes. One school does not necessarily equal one OU subtree.

Application users need local permission grants. They do not receive the background Google credential.
Use a dedicated district-managed Google identity with the minimum verified privileges for enabled capabilities.
Google Super Admin authority remains necessary for specific setup and administrative actions, according to the capability registry.
See [03](03-architecture.md#google-connection-and-capabilities) for credential profiles and validation requirements.

## Scale and tenancy

One installation serves one Google Workspace **customer account**, identified by its stable customer ID.
Primary, secondary, and alias domains belong to that account. Supported domains share the installation.
Aggregation across separate Workspace customer accounts remains outside the initial scope.

The target spans one small district through metropolitan district workloads.
Validate users, devices, memberships, audit history, concurrent operators, and background work together.
Synthetic workloads do not establish support for Los Angeles Unified or Chicago Public Schools.
Publish supported capacity only after measured qualification and a representative district pilot.

## Deployment choices

Use the same application images and contracts across deployment profiles.
Production runs on Linux. Development environments do not establish production support.

| Profile | Placement | Intended use |
|---|---|---|
| All Docker | Compose runs frontend, API, workers, Kestra, PostgreSQL, and Redis. Artifacts use persistent local storage. | Default single-server installation |
| Hybrid Docker and district servers | Compose runs retained components. Configured endpoints connect services hosted on district infrastructure. | Dedicated resources or separate administration |
| Enterprise Kubernetes | Frontend, API, workers, and shared services use district-operated Kubernetes and configured external endpoints. | Districts that operate Kubernetes and need several hosts |

A separate database does not require Kubernetes. Moving workers to separate hosts requires a qualified shared storage backend.
All three modes are Phase 1 deliverables. Later phases must remain installable in every mode.
Phase 1 includes persistent local storage and one qualified shared backend for distributed workers.
Shared filesystem and S3-compatible object storage remain the two shared-backend design paths.
Kestra availability requires separate qualification. Kubernetes does not establish end-to-end high availability.
Do not require a district to adopt Kubernetes for this product.

The installer uses prebuilt release images. Customers do not compile source code.
Offer sample data or a read-only Google connection before enabling mutations.
Separate local setup, Google authorization, propagation, and initial inventory progress.
Retain setup progress across browser and service restarts.

Trial promotion requires explicit customer verification, sample-data removal, production secrets, backup configuration, and renewed permissions.
A fresh production installation remains supported. Marketplace packaging and VM appliances remain later distribution options.

## Initial product scope

The [ten-phase development sequence](06-work-breakdown.md#delivery-sequence) defines when each capability becomes usable.
Phases 1–3 deliver deployment, the authenticated shell, onboarding, customer settings, and delegated platform access.
Phase 4 adds read-only device EntityCache. Phase 5 adds JobService, Jobs, and frontend notifications.
Phase 6 establishes the device experience through owner-reviewed iterations before other entity management proceeds.
Users follow in Phase 7, OUs in Phase 8, and groups/membership in Phase 9.
Phase 10 delivers Fleet Status and the Report Dashboard.

- Users, ChromeOS devices, groups, and OUs: inventory, scoped lookup, filters, selection, details, and approved actions.
- Cross-entity search, saved filters, and defined inventory reports with freshness and missing-data coverage.
- Draft editing and bulk updates through preview, confirmation, jobs, and durable audit evidence.
- CSV export and reimport with stored baselines, cell-level comparison, conflict review, and explicit creation mode.
- Jobs with steps, parallel worker assignments, individual operation results, cancellation, and reconciliation.
- Device commands: Reboot, Wipe user data, and Powerwash, with verified method and lifecycle support.
- Battery history and summaries after telemetry licensing, coverage, and storage qualification.
- Backup, restore, credential replacement, scoped access, diagnostics, and upgrade procedures.

Inventory reports initially cover support dates, stale device contact, suspended-user memberships, and inventory by OU.
Reports show definitions, filters, observation age, missing data, and authorized drill-through entities.
Identify fields controlled by an SIS or another district system. Apply district write policy to those fields.

## Deferred scope and exclusions

| Capability | Status |
|---|---|
| Local language assistance | Optional later filter translation. No model download or GPU prerequisite for basic administration. |
| Google Sheets round-trip | Optional after CSV qualification. Requires separate file authorization, ownership, and sharing design. |
| Google external audit connector | Separate later capability. Local mutation audit does not include actions from other tools. |
| Chrome fleet reports | Separate capability from local inventory reports and telemetry. Verify scope and coverage before activation. |
| Dashboard generation and widget gallery | Later specifications. No dependency for first-release inventory insight. |
| Classroom content and roster management | Excluded. No Classroom-ownership warning without an authorized integration. |
| Bulk Super Admin grants, dynamic/security groups, conversation content | Excluded from initial action tooling. |
| Automatic rollback of completed Google changes | Excluded. Cancellation preserves completed effects and unresolved outcomes. |
| Google push delivery | Optional capability where supported. Polling remains the default. |

## Success criteria

1. Staff find entities through imperfect identifiers without navigating the full district inventory.
2. Every mutation follows selection or draft, preview, confirmation, job execution, and durable audit evidence.
3. Small jobs receive priority among pending jobs of a held type when admission resumes.
4. Large work remains resumable and exposes succeeded, failed, skipped, cancelled, and unresolved operation counts.
5. Installers complete local setup with documented external prerequisites and recoverable progress.
6. Search remains responsive during synchronization, imports, audit queries, and worker activity.
7. Crash and restore tests preserve evidence and prevent automatic replay of uncertain unsafe operations.
8. Complete workflows pass keyboard and screen-reader testing against the WCAG 2.2 AA engineering target.

Numerical latency, capacity, installation, and recovery targets remain qualification hypotheses in [06](06-work-breakdown.md#qualification-workloads-and-targets).
The [V0 experiments](../validation/v0-2026-09-05/README.md) establish limited component behavior and synthetic query results.
Full product capacity, Google credentials, and novice installation acceptance remain unverified.
