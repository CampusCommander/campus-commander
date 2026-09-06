# UI implementation patterns

Use these patterns with [rules.md](rules.md).
The portfolio remains the authority for domain behavior and capability qualification.
Examples describe display requirements. They do not define new API payloads or backend status enums.

## Entity grid

**GRID-01 — Anatomy.** Compose the filter/action row, conditional draft panel, entity viewport, and grid footer in that order.

- Route identifier and value searches through filter autocomplete and the qualified query contract.
- Do not add a separate search box or selection toolbar above the grid.
- Show each active filter as field, value, and remove action.
- Place filter chips and Add a filter on the left of the filter/action row.
- Right-align Refresh followed by Bulk Actions in that same row.
- Separate search criteria from selection criteria when they differ.
- Keep selection information, counts, pagination, and freshness in the AG Grid footer.
- Include stable row identity, readable identifying attributes, selection, and relevant school or OU context.
- Put Import, Export, Update, Send command, Change status, and other entity actions inside Bulk Actions.
- Keep supported menu items visible. Disable unavailable actions and explain their selection, permission, or connectivity requirement.
- Refresh contains Refresh selected and Refresh all. Disable Refresh selected when selection is empty.
- Refresh all targets the authorized entity dataset in the current district. Preserve filters, selection, drafts, and focus.
- Keep Save, Clear, and Filter Changed or Show All in the conditional draft panel.
- Disable selection-dependent actions when the selection is empty.
- Use server-side row models. Do not load the district dataset solely to render the grid.

**GRID-03 — Cell roles.** Put a details icon immediately after each selection checkbox in every entity grid.

- Use the eye icon to open details for that row's stable entity ID.
- Keep selection, detail navigation, and cell editing as separate actions.
- Give the icon an entity-specific accessible name and a tooltip.
- Declare `inGridEditor` for every data column. Use an editor identifier or explicit JSON `null`.
- Treat `null` as read-only metadata. It does not describe the cell's value.
- Check field capability, row permissions, and connectivity before enabling an editor.
- Use a subtle edit indicator for editable fields. Do not mark ordinary cells as navigation links.
- Use the [field contract](entity-grid-fields.json) for editor identifiers and device examples.

**GRID-04 — Typed filters.** Use the Google Admin Console filter/chip interaction with matched fields above shortcut matches.

- Put the dashed **Add a filter** control beside active chips.
- Clicking Add a filter replaces that control with an autocomplete input in the filter row.
- Open column suggestions beneath that input. Do not put another search box inside the suggestion menu.
- Typing filters column names. Show **Matched fields** first and quick actions under **Shortcut matches** second.
- Match field labels and aliases independently from value shortcuts. Suppress empty sections.
- Selecting a field opens its operator and datatype-specific input.
- Selecting a shortcut opens its prefilled editor. Apply remains explicit.
- Use text inputs, numeric controls, date pickers, enum choices, boolean choices, and organization-unit trees.
- Offer only operators supported by that field's qualified query contract.
- Disable Apply until the operator and value pass validation. Show the error beside the input.
- Apply creates or updates a chip containing field, operator, and readable value.
- Clicking the chip body reopens its editor. The remove button removes only that predicate.
- **Clear filters** removes predicates, including identifier predicates. It preserves selection, drafts, and sorting.
- Cancel or Escape closes the editor without changing predicates. Restore focus to its trigger.
- Resolve queries through the server-side query contract. Do not filter only cached rows.
- Preserve the existing AND/OR query semantics. The visual chip order does not change predicate meaning.
- Treat false, zero, empty text, unset values, and absent predicates as distinct states.
- Store typed values and stable field identifiers. Do not parse displayed chip text into queries.
- Support arrow navigation, Enter, Escape, visible focus, and announcements for matches and applied changes.

**GRID-02 — Qualification.** Reuse the approved Material and LibreGrid integration.
Verify package compatibility and virtualization behavior during implementation.
Do not copy historical package versions from a design document.

## Selection

**SELECT-01 — Persistent scope.** Keep browsing selection separate from displayed query state and approved job targets.

- Support explicit rows, all-filtered criteria, and exclusions through the selection contract.
- Show original criteria and the API-provided count for all-filtered selections.
- Preserve selection across scrolling, paging, sorting, filters, and refresh until its documented expiry.
- Render selection count, original scope, and retained-selection explanations in the AG Grid footer.
- Provide Select All, Deselect All, and Show All Selected through the durable selection footer.
- Select All captures the current filtered scope. Deselect All clears the complete browsing selection specification.
- Show All Selected displays selected records that match active filters. Show All Rows restores the ordinary dataset.
- Preserve filters when changing the selected-record view. Keep this view distinct from Filter Changed.
- The header checkbox selects the current viewport. Use footer Select All for the complete filtered scope.
- Render row checkboxes and header indeterminate state from actual selection membership.
- Show an expired-selection state and request reselection. Preserve existing approved jobs.
- Do not let new query matches join an already approved job.

Reference: [LibreGrid server-side selection example](https://libregrid.dev/server-side-selection).
The example attaches its selection footer through `onReady` and `attachFooter`.
Qualify the integration API against the installed package version.

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
- Show changed counts, pending records, Save, Clear, and Filter Changed or Show All.
- Flag changed baseline fields as conflicts. Preserve the proposed values until the operator resolves the conflict.
- Offer Leave unchanged and explicit Clear value as distinct operations where the field supports them.
- Offer Prepend, Update, and Append only for compatible writable fields.
- Compute final approved values during preview. Retries must not apply Append or Prepend again.
- Stage large paste operations through the qualified draft contract.

**DRAFT-02 — In-grid batch editing.** Use `@libregrid/batch-edit` for staged editing in all entity grids.

- Begin editing with Enter, F2, or the supported pointer gesture on an editable cell.
- Stage valid values without writing to Google. Escape cancels the active editor's uncommitted input.
- Replace text and numeric cell content with an input inside that cell.
- Do not open a dialog, popover form, or separate Stage button for ordinary text or numeric editing.
- Use an in-cell dropdown for boolean and enum values. Anchor its options to the cell.
- Only specialized editors, including organization-unit and date/time pickers, open dialogs.
- Enter or Tab stages valid input. Escape cancels active input without discarding other staged changes.
- Use the dedicated organization-unit tree for OU selection.
- Resolve organization units by stable identity. Show the selected path and distinguish selection from descendant filtering.
- Show a changed cell with a tint, visible border, and rollback icon. Do not rely on color alone.
- Announce the field, proposed value, baseline value, and uncommitted state.
- Each rollback icon restores that field's baseline and removes only that draft entry.
- Remove unchanged entries when the operator restores their original values.
- Show the draft panel during changed input or staged edits, between the filter/action row and the grid.
- **Save** validates active editors, freezes changed targets, and opens preview. It does not submit a provider write.
- **Clear** discards all unsubmitted grid changes, including offscreen changes. It preserves filters and selection.
- **Filter Changed** shows records with drafts, including drafts outside the displayed query.
- Label that scope explicitly. Keep the original query intact for **Show All**.
- Count changed fields and changed records from the durable draft store, independently of selection and cached rows.
- **Show All** returns to the original query. Neither toggle commits or discards changes.
- **Clear value** is a field operation. It differs from toolbar Clear and cell rollback.
- Preserve drafts on validation failure, preview failure, conflict, lost permission, offline state, and row eviction.
- Disable Save when validation or authorization fails. Keep Clear and rollback available for local drafts.
- Bind submitted values to the reviewed preview. Remove accepted draft entries only after durable job acceptance.
- Preserve rejected draft entries and edits made after the submitted snapshot.
- Keep accepted-job progress separate from unsubmitted drafts. Rollback never reverses accepted provider effects.

**GRID-05 — Batch-edit integration qualification.** The package publisher documents client-row-model support only.
The public registry README was checked on September 5, 2026, with latest version 1.3.0.
The portfolio still requires server-side entity grids and drafts outside the row cache.

- Qualify or extend the module integration before shipping server-side batch editing.
- Verify cross-page draft persistence, eviction, resynchronization, validation, cell rollback, and changed-record retrieval.
- Do not switch district inventory to an all-record client row model to satisfy this package constraint.
- Do not treat `commitBatchEdit()` as provider submission or durable job acceptance.
- Register the module through the qualified package integration. Pin versions from verified peer dependencies.
- Keep the field contract independent of package APIs. `inGridEditor` is repository metadata, not a LibreGrid option.

Publisher source: [package metadata and README](https://registry.npmjs.org/@libregrid%2fbatch-edit).

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

**JOB-03 — Jobs grid.** Use a full-width, read-only grid as the Jobs landing page.

- Show one row per durable application job. Open its detail page through an eye icon.
- Include job ID, action, status, progress, approved scope, requested-by actor, created time, and duration.
- Sort by created time descending. Use stable job identity to break ties.
- Show exception counts directly in progress cells. Distinguish failed operations from unknown outcomes.
- Reuse GRID-04 filter chips, in-row autocomplete, matched-field ordering, and datatype-specific editors.
- Support job ID, status, action, entity type, actor, created time, and finished time through qualified query capabilities.
- Place filters on the left and Refresh on the right. Do not add a separate search box.
- Refresh reads current job state. It does not dispatch provider work or refresh device inventory.
- Keep counts, pagination, and freshness in the grid footer. Query the complete authorized job dataset.
- Jobs are operational records. Do not expose entity selection, cell editing, draft actions, or entity Bulk Actions here.
- Declare every Jobs data column with `inGridEditor: null`. See [jobs-grid.json](jobs-grid.json).
- Keep navigation, filtering, paging, and scrolling stable when live events change job state.
- Show distinct initial-loading, no-jobs, no-matches, unavailable, stale, and offline states.
- Preserve visible results during refresh failures. Explain freshness and provide the supported recovery action.

**JOB-04 — Job details.** Open a dedicated page with job identity, approved scope, operation results, and recent activity.

- Preserve the Jobs query, sort, page, scroll position, and focused row when returning.
- Show action, durable job ID, actor, timestamps, duration, and observed status together.
- Separate succeeded, failed, unknown, pending, skipped, and cancelled counts. Derive counts from operation evidence.
- Show entity identity, operation, baseline value, requested value, outcome, and update time in the results grid.
- Link each eye icon to the correct entity. Give each operation a stable identity independent of its row index.
- Filter operation results by qualified fields. Show needs-attention shortcuts and a clear return to all operations.
- Keep overall job counts unchanged when filtering operation results. Label the filtered result count separately.
- Place Inspect failure beside a failed operation and Reconcile beside an unknown outcome.
- Show the next valid recovery action after inspecting evidence. Gate retries through the existing preview and capability rules.
- Show command acceptance and verified command execution separately. An accepted request does not prove the command completed.
- Offer Cancel pending work only when supported and authorized. Confirm the pending count and explain work already dispatched.
- Show cancellation requested until operation evidence establishes the final outcome. Cancellation does not roll back completed changes.
- Offer result downloads with authorization, availability, and expiry evidence. Keep durable audit records accessible separately.
- Keep action-specific controls in job details. Do not expose device mutation controls in the Jobs grid.

## Forms and hierarchy

**FORM-01 — Focused work.** Center ordinary settings and onboarding content within the shared form width.
Group related questions and show progress for multiple steps.

- Keep local preferences distinct from Google mutations.
- Show generated setup values beside copy controls and direct destination links.
- Separate customer identity, approval, propagation, inventory progress, and restart recovery.
- Derive setup progress from observed state. Do not promise a universal connection deadline.
- Generate scope text from enabled capabilities and the verified credential profile.

**TREE-01 — Hierarchy.** Use a tree pane and adjacent detail and actions for organizational units.
Use stable OU identity and derived paths. Keep the management tree inside the OU page.
Reuse a focused tree picker inside field editors and filters.
For delete-with-contents, offer move to parent, root, a chosen OU, or cancel.
Require explicit preview and confirmation for every mutation path.
