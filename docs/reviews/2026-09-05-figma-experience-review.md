# Campus Commander Figma experience review

Review date: 2026-09-05. Status: design review with recommended changes. No Figma content changed during this review.

The visual direction supports an administration product. The current screens need workflow corrections before implementation acceptance.
Keep the restrained surfaces, compact Users grid, persistent context, visible selection summary, and explicit destructive action names.
Prioritize accurate scope, safe decisions, understandable outcomes, and recovery in the next design iteration.

The review inspected all nine Figma pages, all eight device screens, and both Users reference screens.
Visual inspection covered the ten product screens and representative foundation, layout, and component sections.
Programmatic inspection covered labels, geometry, variable bindings, component usage, and device prototype connections.
The device page contains no prototype reactions or flow starting points. The review does not establish working keyboard or screen-reader behavior.

The current portfolio, revised September 5, governs behavior and delivery order.
Its Phase 6 acceptance gate requires accepted device interactions before Users development.
See the [product brief](../portfolio/01-product-brief.md), [domain model](../portfolio/02-domain-model.md), [UX specification](../portfolio/04-ux-ui-spec.md), and [delivery sequence](../portfolio/06-work-breakdown.md).

Priority P1 means resolve before accepting the affected workflow. Priority P2 means resolve before expanding the shared pattern.

| Priority | Finding | User consequence |
|---|---|---|
| P1 | Device frames clip their right edge. | Controls, account context, and detail content disappear. |
| P1 | Displayed filters, rows, and selection disagree. | Operators cannot reliably identify the affected devices. |
| P1 | Draft and frozen-preview states are incomplete. | Operators cannot verify which values and targets they approved. |
| P1 | Command confirmation omits consequences and result distinctions. | Operators receive incomplete warnings and ambiguous success evidence. |
| P1 | Import review omits baseline values and coherent counts. | Operators cannot distinguish conflicts from unchanged data. |
| P1 | Recovery remains guidance rather than designed workflows. | Operators lack demonstrated paths through holds, failures, and uncertain effects. |
| P1 | Dark reference text fails contrast checks. | Status and links become difficult to read. |
| P2 | Guide rules conflict with the current portfolio. | Designers and agents reproduce superseded behavior. |
| P2 | Search, scope, and release availability need one shell. | Helpers lack a direct lookup path and clear permission context. |
| P2 | Device density, detail hierarchy, and components diverge. | The experience becomes inconsistent across entity pages. |

**1. Repair the device canvas before further review.**

All eight device screens measure 1440 × 900 pixels.
Their parent, `59:2`, measures 1312 pixels wide and enables clipping.
This removes 128 pixels from each screen's right edge.
The outer 1440-pixel frame also clips content and positions the screen container 64 pixels from its left edge.
Screenshots confirm missing account context, toolbar controls, and device detail content.
See [Device Management](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=57-3).

Place product screens in a container that accommodates their full width and padding.
Keep presentation-board padding separate from application dimensions.
Use auto-layout for related form fields, summaries, and action areas.
Seven device screens contain button instances but no descendant layout frames. Their content relies on absolute placement.
Require complete screenshots and a long-content inspection before accepting the repair.

**2. Make filters and selection demonstrably accurate.**

The inventory shows Noncompliant and Replace soon filters, but includes Compliant, Healthy, and Replace now rows.
Its selection summary states 142 devices matching only the compliance criterion.
One checked device is Compliant. The screen provides no selection banner explaining retained scope or exclusions.
The header checkbox is absent. Users reference screens also display active and staff accounts under Suspended and Students filters.
See [Devices inventory](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=59-3) and [Users reference](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=3-27).

Use consistent fixtures across lookup, selection, preview, and results.
Show matching count separately from district inventory count.
Provide explicit, all-filtered, excluded-row, retained-selection, and expired-selection states.
When displayed filters change, retain the original selection criteria in a banner with Clear selection and Review selection actions.
Show a mixed header checkbox where appropriate. Explain selected devices outside the current results.
Use plain labels such as “Selected: 142 noncompliant devices” instead of exposing query syntax as the main explanation.

**3. Complete the draft and approval workflow.**

The Update screen places editable inputs and a prepared preview beside each other with two prominent continuation actions.
The preview provides four sample changes without a control for inspecting every affected device.
The footer says preview uses current selection criteria, but does not communicate a frozen target set.
The status screen similarly combines action selection and typed confirmation.
See [Update devices](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=59-5) and [Change status](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=59-6).

Design separate states for editing, preparing preview, reviewing preview, and confirming.
Show one primary continuation action for the current state.
Add changed-device and changed-field counts, Save, Reset, and a pending-changes filter.
Demonstrate drafts surviving filtering, scrolling, refresh, and navigation.
Show a baseline conflict beside the affected field.
Provide explicit clear-value behavior alongside leave-unchanged behavior for supported fields.

The preview must show exact targets, before-and-after values, exclusions, stale observations, and relevant permission restrictions.
Show its preparation time and actual expiry.
Changing inputs invalidates the prior preview and requires a new review.
Confirmation submits the reviewed targets and computed values.
The receipt says “Job created” with View job. Completion messaging requires confirmed results.

**4. Correct command consequences and result language.**

The Powerwash confirmation only explains local user-data removal.
It omits policy removal and the enrollment consequence.
Google distinguishes Wipe user data, which retains policy and enrollment, from Powerwash, which removes them unless enrollment rules restore enrollment.
Google also defines EXECUTED_BY_CLIENT for successful and unsuccessful execution. Success requires the separate command result.
These distinctions come from the [Google command resource](https://developers.google.com/workspace/admin/directory/reference/rest/v1/customer.devices.chromeos.commands).

The current job screen presents EXECUTED_BY_CLIENT in green with “Completed” and no separate execution result.
It presents ACKED_BY_CLIENT as a technical code and Expired as “No client response.”
Acknowledgment means receipt. Expiry means the device did not execute within the allowed time.
Use the provider expiry timestamp instead of an unconditional 24-hour promise.
Keep local job cancellation distinct from provider command cancellation.
See [Command confirmation](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=59-7) and [Job detail](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=59-8).

Lead with plain states: Waiting for device, Device acknowledged, Succeeded, Failed, Expired, and Needs review.
Place provider codes, command IDs, and raw errors in expandable technical details.
Show succeeded, failed, skipped, cancelled, and unknown counts alongside pending work.
Add a visible safe next action for each actionable result.
Use the filled destructive confirmation component for the final Powerwash and Deprovision actions.
The existing screens use outlined red actions at final confirmation, contrary to the component guide.

Keep target fixtures consistent across the flow. The current confirmation names two devices, while the adjacent job example names three.
If these represent separate scenarios, label them as separate scenarios.

**5. Rebuild CSV review around the stored baseline.**

The conflict table shows current and file values but omits the export baseline.
It presents “Use file” actions without showing unresolved, keep-current, and chosen states.
The summary lists 3,012 rows, 2,945 safe updates, 17 conflicts, and three invalid rows.
These counts mix unclear units. If all counts represent rows, 47 rows remain unexplained.
The primary action starts the import while the stepper still marks Resolve.
See [Reimport](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=59-10).

Show one conflict per field with device identity, field, baseline, file value, current value, and chosen resolution.
Keep current values for unchecked conflicts.
Separate device counts, row counts, and field-change counts.
Include unchanged, already-applied, invalid, unauthorized, and unknown-device outcomes where present.
Require a reviewed preview and explicit confirmation after conflict resolution.
Offer recovery for missing or expired baselines without implying device enrollment through CSV.

Export currently offers Google Sheet beside CSV, despite the portfolio deferring Sheets authorization and ownership design.
Its seven-column preview omits visible identity and integrity metadata required for round-trip matching.
It exports 128,431 rows while Reimport states a 50,000-row limit.
Explain that limit before a user begins an editing round trip. Offer a supported export scope or a qualified partition workflow.
Show export identity, creation time, baseline availability, and actual file expiry.
See [Export](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=59-9).

**6. Design failure and recovery as complete screens.**

The device overview lists six state descriptions. These are guidance cards, not six working screen variants.
The file contains eight device screens and no device prototype reactions or flow starting points.
There is no demonstrated path through a held job, uncertain result, expired preview, expired baseline, or restored draft.
The current job screen also omits cancellation and safe retry decisions.

Add states for read-only access, denied actions, initial inventory progress, stale observations, and connection failure.
Add held admission, accepted receipt, verification pending, partial completion, unknown effect, and unavailable results.
Explain a held job as waiting while other jobs recover from Google backoff. Do not promise a start time.
Preserve successful operations during cancellation and retry.
Show permission-specific recovery. A school helper needs an administrator contact when Diagnostics access is unavailable.

Wire a complete lookup-to-result prototype, including error recovery and return navigation.
Keep design instructions outside product frames. Product copy should explain decisions and next actions.
For example, replace “Partial completion stays visible” with the actual outcome counts and a review action.

**7. Correct measured contrast failures and validate interaction access.**

The following calculations use Figma solid fills and composite the selected-row overlay over the dark grid background.
All sampled text is 12 pixels. Normal text requires at least 4.5:1 under the [WCAG contrast criterion](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
These measurements identify design defects. They do not certify application accessibility.

| Text | Figma node | Contrast |
|---|---|---|
| Active, selected row | `9:84` | 2.90:1 |
| Enrolled, selected row | `9:86` | 2.90:1 |
| Email link, selected row | `9:82` | 3.23:1 |
| Suspended, ordinary row | `9:102` | 3.49:1 |
| Active, ordinary row | `9:111` | 3.32:1 |

See the [Dark reference](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=9-2).
Status text binds to shape colors instead of the existing success-text and error-text variables.
Use those text variables and introduce an appropriate dark link treatment.
Check default, selected, hover, focus, and error combinations.
The Foundations page also reverses warning shape and text values in its written labels. Actual variables match the checklist.

Replace checkbox glyphs with defined checkbox components and explicit target areas.
The current glyphs measure 12–14 pixels wide inside larger cells. Figma does not establish their eventual clickable area.
Increase 11-pixel preview values and conflict actions to the documented readable type scale.
Test keyboard selection, focus restoration, dialogs, conflict choices, background announcements, and zoom in the working implementation.

**8. Reconcile guide authority and release scope.**

| Figma page | Required alignment |
|---|---|
| 00 — Start Here | Mark the guide against the September 5 baseline. Replace Users-only approval language with device acceptance status. |
| 01 — Design Language | Retain the audience split, restrained surfaces, and explicit scope. Add recovery and verification to worked examples. |
| 02 — Foundations | Correct warning labels. Apply text-specific semantic colors. Reconcile grid type and density guidance. |
| 03 — Layout Templates | Replace Overview, Directory, and Policies navigation with the adopted release shell. Permit bounded grid scrolling. |
| 04 — Components & States | Add expired selection, draft conflict, accepted receipt, held job, and unknown-result specimens. |
| 05 — UX Rules | Replace mixed job terminology, fixed retention assumptions, and “Preview before upload.” Describe validation before mutation. |
| 06 — Agent Build Checklist | Require the current portfolio, phase availability, frozen previews, actual screen states, and measured validation. |
| 07 — Reference Screen | Correct filters, selection, dark contrast, and deferred language-assistance controls. |
| 08 — Device Management | Resolve the workflow findings above and make Devices the acceptance reference. |

Start Here and Agent Build Checklist provide different source orders.
The source-order finding is resolved through the repository UI contract.
Agents use `docs/ui/` for implementation rules and exact tokens. Figma supplies the human visual reference.
Use the current written portfolio to resolve behavior conflicts.
Do not treat existing code or historical mockups as authority over the adopted requirements.

**9. Make lookup and operating scope obvious.**

The device inventory provides filters and deferred language assistance but no explicit serial or asset-tag search.
Add direct device lookup as the first Phase 4 search capability.
Expand entity coverage with later phases.
Separate lookup from find within loaded grid rows.

Use one navigation component across templates and product screens.
Show only installed capabilities. Label future-state examples explicitly.
Use the customer account name and relevant domain context rather than a bare domain alone.
Replace Entity Super Admin with the adopted application permission terminology.
Show school scope and distinguish platform access management from Google Workspace Users.
The job detail screen should identify Jobs as its active navigation destination.

**10. Improve density and device detail hierarchy.**

Device rows measure 48 pixels high. The Users reference and current compact default use 32 pixels.
Keep a documented compact default. Introduce comfortable density with an explicit user setting and usability evidence.
Do not allow row density to vary accidentally between entity pages.

The detail screen reserves a large left region for five record cards while squeezing the record into the right side.
Prioritize identity, condition, recent activity, and editable annotations within the visible detail area.
A narrower result list or a detail sheet over the preserved grid deserves testing.
Keep direct next-record navigation for administrators reviewing several devices.

The battery chart shows 78 percent and a classification without a measurement definition, sample coverage, or district threshold source.
Define the percentage, show latest sample time, identify gaps, and explain the classification.
Add missing, stale, unsupported, and permission-restricted telemetry states.
Separate device contact time, inventory observation time, and telemetry sample time.

The next design delivery should follow this order:

1. Correct the guide conflicts, clipping, contrast, and shared shell.
2. Design device lookup, coherent filters, selection, and detail for Phase 6.1.
3. Complete drafts, conflicts, frozen preview, confirmation, and durable receipt for Phase 6.2.
4. Complete bulk actions, held jobs, cancellation, partial results, and recovery for Phase 6.3.
5. Complete CSV round trips and verified command workflows for Phase 6.4.
6. Obtain owner acceptance before adapting these patterns for Users.

Use these tasks for the next usability review:

| Participant | Task | Acceptance evidence |
|---|---|---|
| Occasional helper | Find a Chromebook from an imperfect identifier and explain its condition. | Correct device, school context, observation age, and no required assistance. |
| District operator | Select filtered devices, change displayed filters, and review the retained selection. | Correct explanation of original criteria, exclusions, and affected count. |
| District operator | Edit annotations, receive a concurrent update, and prepare a preview. | Drafts survive. The operator resolves the conflict and verifies final values. |
| Occasional helper | Review Powerwash without submitting it. | Correct explanation of data loss, enrollment consequence, targets, and asynchronous outcome. |
| District operator | Inspect a held job and a partial result with an unknown operation. | Correct distinction between waiting, success, failure, and required review. |
| District operator | Reimport an edited CSV with conflicts and an expired-baseline variant. | Correct comparison, coherent counts, preserved current values, and safe recovery. |
| Keyboard and screen-reader participants | Complete lookup, selection, editing, confirmation, and result review. | Reachable controls, visible focus, restored context, and understandable announcements. |

Record completion, errors, assistance, and understanding before approval.
Treat these as proposed acceptance tasks until participants complete them in a prototype or working release.

---

Figma revision record, 5 September 2026.

The authorized revision is available on [09 — Device Workflows · Revised](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=122-364).
The page contains 80 prepared screens and two review indexes.
Five prototype starting points cover the review index, device inventory, CSV reconciliation, commands, and recovery.

The revision includes:

- A shared Devices, Jobs, and Settings shell with district context and active navigation.
- Device lookup, coherent filters, six matching records, retained selection, and explicit status and CSV entry points.
- Device details with battery definitions, sample coverage, observation times, and missing telemetry context.
- Single-device and bulk drafts, frozen previews, conflict decisions, confirmation, and job receipts.
- Separate Reboot, Wipe user data, Powerwash, Disable, and Deprovision consequences and outcomes.
- Powerwash locked and ready examples. Command receipts remain distinct from confirmed execution.
- Held jobs, cancellation, partial results, unknown results, reconciliation, and recovery.
- CSV baseline, file, and current-value comparisons. Separate previews preserve four-update and five-update decisions.
- Loading, empty, stale, offline, read-only, expired-selection, expired-preview, expired-baseline, and unavailable-storage examples.
- Reusable field states and checkbox variants. Text and control tokens include light and dark values.
- Guide source-order corrections, Phase 6 scope, deferred capability guidance, and revised workflow links.

The original device studies remain available.
Automatic approval review rejected wholesale replacement of their contents because that action removes substantial existing work.
The revision therefore uses an additional page.
Targeted guide, contrast, and clipping corrections remain in the existing pages.

Validation completed in Figma:

- Inspected screenshots of inventory, detail, drafts, command confirmation, CSV reconciliation, previews, job results, and the dark reference.
- Checked 82 frames and 534 navigation connections.
- Found no invalid or self-referencing navigation destinations.
- Found no navigation reactions on disabled controls.
- Found no clipped text, text overflow, or unfinished placeholders in the revised page.
- Verified preview row counts of one, four, five, or six against their prepared scenario.
- Corrected unresolved navigation paint values while retaining variable bindings.
- Checked link, status-text, and secondary-text contrast on card and selected surfaces.
- Strengthened light error text to #B3261E. Added border/control for field boundaries.

The prototype uses fixed example values and prepared state transitions.
It does not implement live search, file transfer, provider calls, or typed-confirmation validation.
Secondary controls outside the named example paths remain design specimens.
Keyboard operation, focus return, screen-reader announcements, live authorization, provider behavior, and participant usability checks remain implementation acceptance work.
No application code changed.
