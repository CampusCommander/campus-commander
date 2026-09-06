# UI implementation patterns

Use these patterns with [rules.md](rules.md).
The portfolio remains the authority for domain behavior and capability qualification.
Examples describe display requirements. They do not define new API payloads or backend status enums.

## Entity grid

**GRID-01 — Anatomy.** Compose lookup, filter chips, selection toolbar, entity viewport, and status region in that order.

- Support exact and imperfect identifiers through the qualified search contract.
- Distinguish entity lookup from find within loaded grid rows.
- Show each active filter as field, value, and remove action.
- Provide Add filter through the shared typed query contract.
- Separate search criteria from selection criteria when they differ.
- Keep counts and freshness in one grid status region. Do not duplicate them in the page header.
- Include stable row identity, readable identifying attributes, selection, and relevant school or OU context.
- Offer update, command, status, import, and export entry points only when supported and authorized.
- Disable selection-dependent actions when the selection is empty.
- Use server-side row models. Do not load the district dataset solely to render the grid.

**GRID-02 — Qualification.** Reuse the approved Material and LibreGrid integration.
Verify package compatibility and virtualization behavior during implementation.
Do not copy historical package versions from a design document.

## Selection

**SELECT-01 — Persistent scope.** Keep browsing selection separate from displayed query state and approved job targets.

- Support explicit rows, all-filtered criteria, and exclusions through the selection contract.
- Show original criteria and the API-provided count for all-filtered selections.
- Preserve selection across scrolling, paging, sorting, filters, and refresh until its documented expiry.
- Show a retained-selection banner when displayed results no longer represent the selected scope.
- Provide Review selection and Clear selection actions.
- Render row checkboxes and header indeterminate state from actual selection membership.
- Show an expired-selection state and request reselection. Preserve existing approved jobs.
- Do not let new query matches join an already approved job.

## Entity detail

**DETAIL-01 — Context.** Keep identity, school or OU, observed condition, editable annotations, and recent activity visible together.

- Preserve grid filters, selection, scroll position, and focus when returning to the grid.
- Keep next-record navigation within the current ordered result context.
- Distinguish writable annotations from read-only observations and telemetry.
- Open the mutation flow with exactly the device named in the detail view.

**DETAIL-02 — Telemetry.** Display definition, unit, sample timestamp, coverage, and threshold source beside a classification.

- Explain battery capacity as the qualified measurement. Do not confuse capacity health with remaining charge.
- Identify district policy thresholds and the observations used to apply them.
- Show missing sample counts and gaps. Do not interpolate them into healthy readings.
- Distinguish missing, stale, unsupported, and permission-restricted telemetry.
- Provide recovery or explanation appropriate to the actual cause.

## Draft and mutation

**DRAFT-01 — Durable editing context.** Store proposed values and baseline versions by stable entity ID and field.
Keep drafts outside the loaded grid row cache.

- Preserve drafts across eviction, paging, sorting, filtering, refresh, and SSE resynchronization.
- Show changed counts, pending records, Save, and Reset.
- Flag changed baseline fields as conflicts. Preserve the proposed values until the operator resolves the conflict.
- Offer Leave unchanged and explicit Clear value as distinct operations where the field supports them.
- Offer Prepend, Update, and Append only for compatible writable fields.
- Compute final approved values during preview. Retries must not apply Append or Prepend again.
- Stage large paste operations through the qualified draft contract.

**WRITE-01 — State sequence.** Use this progression for Google mutations:

`draft-or-selection → preparing-preview → review-preview → confirm → accepted-receipt → job → audited-result`

| Stage             | Required content and behavior                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Preparing preview | Preserve draft and scope. Show preparation progress or failure.                                                                  |
| Review preview    | Exact targets, before-and-after values, eligible and excluded counts, observation warnings, preparation time, and actual expiry. |
| Confirm           | Restate action, consequence, exact targets, and count. Bind confirmation to the reviewed preview.                                |
| Accepted receipt  | Durable job identity, requested scope, and View job. Do not claim completed changes.                                             |
| Job               | Show provider-backed progress and per-operation evidence.                                                                        |
| Audited result    | Show outcomes, actor, scope, timestamps, and relevant result artifacts.                                                          |

- Let the operator inspect every approved target through pagination or an equivalent bounded view.
- Require a new preview after inputs, targets, or conflict decisions change.
- Preserve current values for excluded conflicts. Revalidate retained draft choices before dispatch.
- Offer recovery from expired preview without losing the draft.
- Keep the one-field version concise while retaining the same safety contract.

## Device actions

**DEVICE-01 — Command consequences.** Verify supported methods and result semantics against capability evidence before release.

| Action         | Required consequence                                                                                         | Confirmation                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Reboot         | Restarts the device and interrupts active sessions.                                                          | Reviewed targets and an acknowledgment naming Reboot.                              |
| Wipe user data | Removes local user profiles. Device policy and enrollment remain.                                            | Reviewed targets, data-loss acknowledgment, and typed confirmation.                |
| Powerwash      | Removes local data, user and device policies, and enrollment. Enrollment rules govern subsequent enrollment. | Reviewed targets, data-loss and enrollment acknowledgment, and typed confirmation. |
| Disable        | Blocks user access while enrollment remains. Re-enable restores access where eligible.                       | Reviewed eligibility, exact targets, consequence, and explicit confirmation.       |
| Re-enable      | Restores access only for eligible disabled devices.                                                          | Reviewed eligibility and explicit confirmation.                                    |
| Deprovision    | Removes devices from active management. Do not promise restoration of the previous management state.         | Reviewed targets, required reason, and destructive confirmation.                   |

- Explain excluded targets and their reasons. Do not silently narrow six selected devices to two command targets.
- Keep the typed phrase and action name consistent. A Wipe confirmation must not require the Powerwash phrase.
- Prevent submission until required acknowledgment and typed confirmation pass actual validation.
- Show no-eligible-targets separately from a submission error.

**DEVICE-02 — Command evidence.** Separate provider acceptance from device execution and command result.

- `EXECUTED_BY_CLIENT` alone does not establish success. Inspect the separate provider command result.
- Show pending, successful, unsuccessful, expired, and uncertain outcomes according to qualified provider semantics.
- Use the expiry returned by the provider. Do not promise a fixed command lifetime from prototype copy.
- Inspect failed or uncertain operations before offering an eligible new request.

## CSV round trip

**CSV-01 — Export.** CSV is the first supported round-trip format.

- Submit exports as jobs. Show progress, readiness, download, and artifact failure.
- Retain export identity, owner, schema version, stable row identity, selected fields, expiry, and baseline reference.
- Keep identity and integrity metadata visible in the file. A hash does not replace stored baseline values.
- Show actual file and baseline expiry. Keep their retention distinct from mutation audit evidence.
- Obtain supported limits from the qualified contract. Do not ship a prototype count as a configured limit.
- Keep Sheets unavailable until its separate authorization and ownership design is adopted and implemented.

**CSV-02 — Comparison.** Compare stored baseline B, edited file value E, and current value C per field.

| Condition                   | Required decision                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| E = B                       | No user edit. Preserve C.                                                                   |
| E differs from B and C = B  | Propose E.                                                                                  |
| E differs from B and C = E  | Already applied. Do not write.                                                              |
| B, E, and C all differ      | Require explicit conflict review.                                                           |
| Baseline missing or expired | Reject round-trip comparison. Offer a new export or a separately supported new-import path. |
| Unknown stable identity     | Mark invalid. Do not create an entity automatically.                                        |

- Show entity, field, B, E, C, and chosen resolution for every conflict.
- Default unchecked conflicts to Keep current. Check-all must preserve that same explicit meaning.
- Count create, update, unchanged, already-applied, conflict, invalid, and unauthorized outcomes where present.
- Separate row totals from field-conflict totals. Do not sum overlapping categories as independent rows.
- Require the resolved preview and explicit confirmation before creating the job.
- Revalidate decisions against current observations. Never overwrite an entire row for one changed field.
- Preserve the source file. Produce a separate result file.

**CSV-03 — Invalid input.** Apply domain validation before preview.
Handle duplicate identities, malformed rows, encodings, formula injection, Unicode, quotes, and leading zeros.
Apply field-specific null, empty, omitted, whitespace, date, and array semantics.
Do not offer CSV device enrollment or implicit creation for unknown device IDs.

## Jobs and recovery

**JOB-01 — Status truth.** Show job identity, action, actor, scope, progress, duration, and outcome evidence.

| Condition             | Required presentation                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| Accepted              | A durable receipt. Work has not necessarily started.                                            |
| Held by type          | Explain Google backoff recovery. Do not promise a start time. Existing work continues.          |
| Running               | Observed progress and remaining work.                                                           |
| Completed with errors | Preserve successes and show failures, skips, cancellations, and unknown outcomes separately.    |
| Unknown effect        | Needs review or reconciliation. Do not relabel uncertainty as success or failure.               |
| Cancellation          | Explain pending work versus effects already completed or in progress. No rollback promise.      |
| Storage unavailable   | Explain inaccessible inputs or results. Preserve job evidence and offer the supported recovery. |

- Link result rows to the correct entity and operation.
- Offer retry only for eligible operations. Do not repeat recorded successes or unresolved effects blindly.
- Keep mutation audit evidence distinct from expiring operational files.
- Show actual result expiry and authorized downloads.
- Link notifications to durable job state. Do not make a transient snackbar the only result record.
- Use accepted wording in the submission notification. Reserve success wording for confirmed effects.

**JOB-02 — Live updates.** Refresh affected rows for ordinary invalidations.
Request resynchronization after a replay gap.
Preserve drafts, selection, and focus in both paths.
Coalesce background announcements and keep safe work available during synchronization.

## Forms and hierarchy

**FORM-01 — Focused work.** Center ordinary settings and onboarding content within the shared form width.
Group related questions and show progress for multiple steps.

- Keep local preferences distinct from Google mutations.
- Show generated setup values beside copy controls and direct destination links.
- Separate customer identity, approval, propagation, inventory progress, and restart recovery.
- Derive setup progress from observed state. Do not promise a universal connection deadline.
- Generate scope text from enabled capabilities and the verified credential profile.

**TREE-01 — Hierarchy.** Use a tree pane and adjacent detail and actions for organizational units.
Use stable OU identity and derived paths. Keep the tree inside the OU page.
For delete-with-contents, offer move to parent, root, a chosen OU, or cancel.
Require explicit preview and confirmation for every mutation path.
