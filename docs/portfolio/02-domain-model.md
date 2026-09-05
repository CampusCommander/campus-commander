# 02 — Domain Model

**Status:** current domain model, revised 2026-09-05. This glossary defines canonical terms for the portfolio.

## Glossary

| Term | Meaning |
|---|---|
| **Customer account** | One Google Workspace account containing its primary, secondary, and alias domains. One installation serves one account. |
| **Entity** | A Google Workspace user, device, group, or OU represented in the local inventory. |
| **Entity type** | A category of entities. It does not imply one shared freshness timestamp for all related data. |
| **Platform user** | An identity authorized to use Campus Commander through application permission grants. Managed Google user records remain separate. |
| **EntityCache** | The local inventory subsystem that synchronizes provider observations and serves authorized reads with explicit freshness and coverage. |
| **JobService** | The application responsibility for mutation acceptance, admission, orchestration integration, worker observations, durable results, and cleanup. |
| **Observation** | Provider data recorded at a known time with scope and coverage information. |
| **Write overlay** | Accepted field changes shown alongside their verification status until provider observations resolve them. |
| **Capability** | An enabled read, mutation, report, or diagnostic operation with defined authorization and availability. |
| **Google identity** | The district-managed identity used for background Google requests, separate from the application requester. |
| **DWD** | Domain-wide delegation authorizing a service account to impersonate a Workspace user within granted scopes. |
| **Permission grant** | Authority for a principal to perform an action within resource, destination, field, and policy constraints. |
| **Selection** | A browsing target specification with original filters and explicit inclusions or exclusions. |
| **Selection ID** | An opaque reference to a selection. It does not grant permission or replace a frozen preview. |
| **Draft** | Proposed field changes and their baselines awaiting review. Drafts survive grid row eviction. |
| **Batch edit** | Editing several fields or entities as drafts before Save starts preview and confirmation. |
| **Preview** | An immutable description of exact targets, proposed values, counts, preconditions, and approval requirements. |
| **Job** | One accepted unit of work with stable identity, steps, operation evidence, and auditable results. |
| **Step** | A phase of a job with dependencies and an aggregation policy for its assignments. |
| **Assignment** | A bounded set of operations assigned to one worker execution. It replaces the ambiguous term chunk. |
| **Operation** | One logical action on a target within a job. It retains its own attempts and outcome. |
| **Attempt** | One recorded effort to dispatch or verify an operation. |
| **Batch request** | A provider transport request containing several operations. Its size follows the specific Google method. |
| **Settled assignment** | An assignment with a durable execution outcome available for step aggregation, including failures. |
| **Unknown outcome** | A dispatched operation whose external effect lacks sufficient confirmation. It requires reconciliation. |
| **Reconciliation** | Resolving uncertain or conflicting effects using observations, evidence, and operator decisions where required. |
| **Admission hold** | A temporary pause on new jobs of one type while existing jobs continue. |
| **Job service** | The application responsibility for admission, worker reports, hold updates, recovery aggregation, and cleanup. |
| **Artifact** | A job file such as an approved manifest, assignment input, result, or audit bundle. |
| **Artifact ID** | A stable reference independent from a host path, storage backend, or temporary download address. |
| **Published artifact** | A completed, verified artifact made available to authorized job consumers. |
| **Audit evidence** | The retained record of authority, intent, attempts, outcomes, and subsequent reconciliation. |
| **Cache Sync** | The user-facing refresh operation. Full Entity Sync performs complete enumeration of a collection scope. |
| **Generation** | A staged or published collection version with its own coverage and completion evidence. |
| **Absence** | An entity missing from a complete authorized enumeration. It does not alone establish deletion or its cause. |
| **Export baseline** | Stored values and identities from an export, used to compare subsequent edits with current values. |
| **Three-way compare** | Comparing baseline, edited value, and current value for one field. |
| **Annotated fields** | District-maintained device fields such as user, location, asset ID, and notes. |

Architecture [03](03-architecture.md) defines storage and execution mechanisms for these terms.
An application job is distinct from its Kestra execution. Preserve both identities for correlation and recovery.

## Entity catalog

Management arrives in this order: devices in Phase 6, users in Phase 7, OUs in Phase 8, and groups/membership in Phase 9.
Phase 4 supplies the initial read-only device cache and page. Phase 5 proves the first controlled device mutation.
Earlier phases load customer, domain, and OU references only as needed for connection, permissions, and placement.
Platform users in Phase 3 represent delegated access to Campus Commander. They are distinct from the managed Google users below.
The [work breakdown](06-work-breakdown.md#delivery-sequence) defines the cumulative working releases.

### Users

- **Google resource:** Admin SDK Directory API `Users`.
- **Cached/filterable fields:** `primaryEmail`, `name.givenName/familyName/fullName`, `orgUnitPath`, `suspended` + `suspensionReason`, `archived`, `lastLoginTime`, `creationTime`, `isEnrolledIn2Sv`, `organizations[]` (dept, title), `customSchemas` (grade level, student ID), `aliases[]`.
- **Writable surface:** suspended, orgUnitPath, archived, changePasswordAtNextLogin, signOut (as a standalone action).
- **Bulk actions:** Suspend, Reactivate, Force password reset (optionally paired with immediate sign-out), Move org unit, Archive, Unarchive, Force sign-out.
- **Group membership is not a Users field.** "Add/remove group membership" is a cross-entity action: select users, select target group, Members insert/delete.
- **External ownership:** respect fields controlled by district SIS policy. Classroom-ownership warnings are excluded without an authorized Classroom integration.

### Devices (ChromeOS)

- **Google resource:** Admin SDK Directory API `ChromeOsDevice`.
- **Cached/filterable fields:** `serialNumber`, `status`, `model`, `orgUnitPath`, annotated fields, `notes`, `lastSync`, `osVersion` + compliance, disk reports, `systemRamTotal`, `supportEndDate` + `willAutoRenew`, recent users, enrollment times, `deprovisionReason`.
- **Writable surface is narrow:** `annotatedUser`, `annotatedLocation`, `annotatedAssetId`, `notes`, `orgUnitPath`. Everything else is read-only telemetry, never inline-editable.
- **Bulk actions:** Move org unit (`moveDevicesToOu`, natively bulk), Disable, Re-enable, Deprovision (via `BatchChangeChromeOsDeviceStatus`. Deprovision requires a reason, surfaced in preview), Annotate.
- **Remote commands (async, separate API surface):** Phase 6 includes qualified REBOOT, WIPE_USERS, and REMOTE_POWERWASH. The last two are destructive and get extra confirmation friction. Record the Google command ID and supported provider states in the capability registry. Distinguish request acceptance, pending delivery, acknowledgment, execution result, and expiration. Local job cancellation does not imply Google command cancellation.
- **Telemetry (Chrome Management Telemetry API. Requires Chrome Enterprise/Education Upgrade):** battery health is in scope with a bounded time series (raw readings in a rolling window plus periodic rollups). Treat battery classifications as district policy until the capability registry verifies their source and meaning. Missing telemetry is unknown, not healthy. All other telemetry is latest-snapshot only, no history.
- **Owner brain dump (2026-09-03):** a planned "Update device" bulk action opens a dialog with selected count and editable fields (org unit plus annotated fields), each field with Prepend/Update/Append operation modes, then the preview → confirm → job chain. Design pending. See `07-issues-and-opportunities.md`.

### Groups

- **Google resources:** Directory API `Groups` + `Members` sub-resource, plus the Group Settings API (join/post/moderation policy). Not Cloud Identity dynamic groups. No conversation content.
- **Cached/filterable fields:** `email`, `name`, `description`, `directMembersCount`, `aliases[]`, plus Group Settings policy fields (exact list TBD — flagged in `07-issues-and-opportunities.md`).
- **Membership:** per-group sub-resource: `email`, `role` (OWNER/MANAGER/MEMBER), `type` (USER/GROUP/CUSTOMER/EXTERNAL), `delivery_settings`.
- **Actions:** create, delete, update (identity + settings), add/remove members.
- **No native bulk membership method.** Bulk membership changes mean many rate-limited single calls, routed through the jobs pipeline.

### OrgUnits

- **Google resource:** Directory API `OrgUnits`.
- **Fields:** `name`, `description`, `orgUnitId` (stable), `orgUnitPath` (derived, up to 35 levels), `parentOrgUnitId`/`parentOrgUnitPath`.
- **Structurally different:** a small hierarchical tree, not a flat bulk list. UI is a tree view with per-OU entity counts computed from the cache (Google does not return counts).
- **Actions:** create, rename, move/reparent, delete.
- **Delete-with-contents flow:** warn on nested entities. Offer move to parent, move to root, move to a picked OU, or cancel. Every path except cancel requires explicit confirmation.

### Classroom — shelved

Out of scope for v1 and the near-term roadmap. Rationale: Classroom rostering at real scale is driven by SIS sync (PowerSchool, Infinite Campus, OneRoster), not manual admin bulk-editing. That is a different problem, an integration with an external system of record, from everything in this design. If revisited, it is its own separate project centered on SIS sync. Do not display Classroom ownership coverage without a separately authorized integration.

## Identity and field rules

Use stable customer and Google entity IDs in references. Email, serial number, and OU path are searchable attributes.
Preserve OU parent IDs and distinguish direct membership from transitive membership.
Authorize groups explicitly. An email domain does not define a school permission boundary.

The capability registry defines writable fields, scopes, privileges, prerequisites, preconditions, batch limits, retry classes, and result semantics.
Candidate action catalogs require controlled-account tests before release.
Never expose unverified fields or provider lifecycle values as supported product behavior.

## Import and export semantics

CSV round-trip is the first implementation. Google Sheets requires a later file-authorization and ownership design.
Retain an export ID, owner, schema version, stable row identities, selected fields, expiry, and baseline artifact.
CSV identity and integrity columns are visible machine metadata. A hash cannot reconstruct baseline values.

| Baseline B, edited E, current C | Result |
|---|---|
| E = B | No user edit. Preserve current value. |
| E differs from B, C = B | Propose the edited value. |
| E differs from B, C = E | Already at the requested value. No write. |
| E, B, and C all differ | Conflict requiring explicit review. |
| Missing or expired baseline | Reject round-trip comparison. Offer a separate new-import workflow. |
| Unknown stable entity ID | Invalid identity. Create only in explicit create mode. |

Recompute hashes from canonical imported values after matching export identity and schema.
A user-supplied hash cannot skip validation.
Define null, empty, omitted, array, date, whitespace, and normalization semantics per field.
Reject duplicate identities with conflicting edits. Never overwrite a complete row for one changed field.

Persist conflict decisions against observed values and revalidate before dispatch.
Show create, update, unchanged, conflict, invalid, and unauthorized counts separately.
Conflict review shows baseline, edited, and current values. Unchecked conflicts preserve current values.

Stream parsing and export with bounded memory, byte limits, row limits, column limits, and cell limits.
Test malformed rows, encodings, formula injection, quotes, newlines, Unicode, and leading zeros.
The initial qualification cap remains 50,000 rows. Larger support requires combined-load and restart evidence.
The large-profile validation target is 1,000,000 CSV rows. It is not a released guarantee.

Creation forms and explicit import creation share validation and the job safety chain.
Generate temporary user passwords server-side with change-at-next-login where supported.
Keep passwords outside sheets and audit artifacts. Define protected delivery or district-approved account recovery.

## Bulk action safety rules

For every bulk action and the import flow (Spec 1, Bulk Action Safety):

1. Preview/dry-run with the exact diff: required for the first Google mutation in Phase 5.
2. Audit log: security events start in Phase 2. Mutation evidence starts with the first write in Phase 5.
3. Undo/rollback: stretch goal. Gate decision G1 (design review) cut the undo promise from all UI. The snackbar shows "View job" only.
4. `makeAdmin` is excluded from bulk tooling entirely.

Every mutation follows one chain: **selection or draft → preview → confirm → job → audited result.**
Cell edits create drafts. Save starts preview and confirmation. Reset discards unsubmitted drafts only.

The safety chain applies to single-cell inline edits too. The owner's rationale (2026-09-03): massive bulk operations get scrutiny because they look dangerous. The unintended, disastrous, or illegal changes usually come from tiny one-off edits, which nobody scrutinizes. A one-cell change therefore runs through the same pipeline and carries the same file-based audit trail as a 300k-device run.

## Google API quota facts

Documented limits live in `03-architecture.md` Appendix A. Summary:

- Directory API: 2,400 QPM per user per project.
- Groups Settings API: 100k/day.
- Chrome Management QPM: unpublished.
- Workers classify Google backoff reasons and retry eligible operations. Kestra recovery skips recorded successes.
- Workers report backoff to the job service. Redis holds pause new jobs by type with a 300-second TTL.
- Existing jobs continue. Pending jobs of the held type sort smallest first. Cleanup requires matching ownership.

## Owner brain dumps (2026-09-03) — new features pending design

Recorded verbatim in `docs/archive/ux/feature-review-notes-2026-09-03.md`. Summaries:

1. **In-grid batch edit mode** for main grid views. Field changes stage locally. Toolbar shows changed count, Save, Reset. A filter toggles pending-rows vs all. Save prepares a preview. Confirmation creates the job. Per-cell rollback icon. Pending-change visual styling.
2. **"Update device" bulk action** (see Devices above).
3. **Round-trip export/import** for spreadsheet editing: CSV or Google Sheet export, edit, reimport with validation → preview → confirm → job. Nested under the bulk actions menu. Needs its own design session.
4. **Google Admin Console-style chip/filter component** as a reusable UI component.

These features retain owner-confirmed intent. This revision defines their contracts. Track 12 still owns detailed interaction design.
Dependent packages in [06](06-work-breakdown.md) remain gated by that design and required validation.
