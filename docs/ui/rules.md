# Shared UI rules

These rules apply to client features and shared controls.
Rule IDs provide references for implementation plans, review findings, and acceptance evidence.

## UI-01 — Purpose and availability

- Give each page one primary user task. Give each region one responsibility.
- Support occasional helpers through plain labels and visible next steps.
- Keep advanced filtering, bulk actions, and keyboard access available to frequent administrators.
- Expose navigation and actions only for capabilities available in the installed release.
- Distinguish platform access management from Google Workspace user management.
- Preserve earlier released workflows when adding another phase.
- Follow the [delivery sequence](../portfolio/06-work-breakdown.md#delivery-sequence). Do not treat prototype page order as delivery order.

## UI-02 — Shared shell

- Use the shared navigation, header, content, and footer components.
- Show the wordmark and connected customer identity in navigation. Add useful domain context.
- Put the header above the main column. Span the footer beneath navigation and content.
- Show page title and task context in the header.
- Provide help, theme selection, and the user menu in the header.
- Highlight the current navigation item with a selected surface, icon treatment, and accent indicator.
- Persist navigation collapse and explicit theme choices per user.
- Follow the system color preference until the user selects an override.
- Show the real version, build identifier, and capability health in the footer.
- Link health details to Diagnostics. Describe partial health instead of claiming all systems pass.

## UI-03 — Layout and density

- Use semantic dimensions and spacing from `tokens.json`.
- Expand grids into the available width. Keep their status region visible beneath a bounded scrolling viewport.
- Center ordinary forms and wizards within `layout/content-max-width`.
- Allow wider target tables in review views when required for readable scope and values.
- Keep compact grid rows at `layout/row-height-grid`. Use the caption type style for compact cells.
- Preserve readable controls when zoom or text expansion reduces available space.
- Wrap or adapt page chrome before clipping labels or actions.
- Keep ordinary forms and dialogs free from nested scrolling. Bound large entity tables explicitly.
- Limit card nesting to one level. Use flat surfaces and separators for ordinary content.
- Reserve elevation for floating menus and dialogs. Use the shared scrim for modal overlays.

## UI-04 — Tokens and components

- Use the shared Material controls and qualified LibreGrid integration defined by the portfolio.
- Reuse existing client components before introducing another implementation.
- Treat Figma components as design specifications. Do not assume matching production components already exist.
- Define colors, typography, and elevation in the shared Material theme.
- Use Tailwind for layout only. Reference shared tokens instead of creating another scale.
- Use `text/link` for links and active navigation labels.
- Use `status/*-text` for semantic labels. Use status shape tokens for indicators and fills.
- Use `border/control` for field boundaries. Use `border/default` for layout separators.
- Check colors against the actual composed background, including selected and hover states.
- Use only the Material Symbols icon family. Keep icon style consistent within each context.
- Bundle required fonts and their licenses. Do not make core rendering depend on a font CDN.
- Use tabular numerals for numeric columns. Use the code type role for technical identifiers and evidence.

## UI-05 — Controls and copy

- Provide one primary continuation for the active task. Style other actions as secondary.
- Use outlined destructive actions before confirmation. Use a filled destructive action for final destructive confirmation.
- Give buttons a verb and object. Include the affected count when it clarifies scope.
- Prefer `Update devices` and `View job` over `Proceed` and `Submit`.
- Use persistent field labels. Add helper text and specific validation errors where required.
- Distinguish disabled, read-only, empty, and invalid controls.
- Explain permission or prerequisite restrictions near the affected control.
- Implement default, hover, focus, filled, error, and disabled states wherever applicable.
- Keep checkbox selection and focus independent. Support checked, unchecked, and indeterminate selection.
- Do not ship inert prototype controls or simulated downloads as working features.
- Use domain terms consistently. Explain technical terms through concise help or expandable details.
- Name error cause, affected scope, and recovery action. Preserve user input.

## UI-06 — Scope and system truth

- Obtain counts, permissions, freshness, thresholds, and expiry from their actual contracts.
- Distinguish visible rows, matching records, selected records, eligible targets, excluded targets, and approved targets.
- Keep the same target identities and action throughout preview, confirmation, receipt, and results.
- Distinguish cached observation time, device contact time, telemetry time, and confirmed write time.
- Show relative time with an exact timestamp available on demand.
- Display stale and offline observations explicitly. Preserve useful cached data during refresh.
- Distinguish accepted requests, pending work, provider execution, confirmed success, and unknown effects.
- Never present optimistic success as a confirmed Google effect.
- Keep technical details available when they support recovery. Exclude internal orchestration details from ordinary task flows.
- Treat Figma device counts, identifiers, timestamps, limits, and command subsets as examples.

## UI-07 — Safety

- Route every Google mutation through draft or selection, frozen preview, explicit confirmation, job, and audited result.
- Apply this chain to single-cell edits as well as bulk operations.
- Freeze exact targets and final values before confirmation.
- Invalidate the preview when relevant inputs or scope change. Revalidate affected observations and authorization before dispatch.
- Explain consequence, exact count, exclusions, and relevant permission restrictions before submission.
- Require stronger confirmation for greater consequence. Follow the command-specific rules in `patterns.md`.
- Disable invalid confirmation. Prevent duplicate submissions while acceptance remains pending.
- Require another approver when the governing policy requires one. Show the pending approval state explicitly.
- Preserve access to the durable receipt and job after navigation or refresh.
- Use ordinary Save for local preferences. Do not create Google jobs for theme or navigation choices.
- Offer Reset only for unsubmitted drafts. Do not promise Undo or rollback of Google effects.

## UI-08 — Required states

Each data region defines these states. Mark a state inapplicable only with a reason in the handoff record.

| State   | Presentation                                | Recovery and preserved context                                                  |
| ------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| Loading | Skeleton matching final geometry            | Retain shell, labels, filters, and safe controls.                               |
| Empty   | Explain no data versus no matches.          | Offer the relevant add, import, or filter action.                               |
| Error   | Name cause and affected capability.         | Preserve input and filters. Offer a specific retry or Diagnostics link.         |
| Partial | Report completed and incomplete outcomes.   | Preserve successes. Link to actionable items.                                   |
| Stale   | Show observation age and stale status.      | Retain data while refreshing. Preserve drafts, selection, and focus.            |
| Offline | Show connection state and cached timestamp. | Preserve local work. Prevent Google mutations until the server confirms access. |

Add permission, expiry, conflict, storage, and telemetry states where the feature requires them.
Do not convert a failure into an empty list or a missing sample into a healthy value.

## UI-09 — Accessibility and interaction

- Target WCAG 2.2 AA in both themes.
- Require 4.5:1 contrast for ordinary text and 3:1 for qualifying large text.
- Require 3:1 contrast for necessary control boundaries and state indicators against adjacent colors.
- Verify target sizes or permitted spacing exceptions for compact controls. Start from the 24 CSS pixel minimum.
- Give every action an accessible name. Keep labels and validation messages programmatically associated with inputs.
- Support keyboard navigation, activation, selection, editing, menus, and dialogs without pointer-only steps.
- Show visible focus. Keep focus unobscured by sticky regions and overlays.
- Trap focus within modal dialogs. Restore focus to the initiating control or its logical replacement after closure.
- Preserve focus identity during row refresh, virtualization, filtering, and resynchronization.
- Announce relevant status changes. Coalesce background announcements and avoid stealing focus for passive updates.
- Communicate state through text and semantics as well as color.
- Respect reduced-motion preferences. Keep motion functional and nonessential to understanding.
- Verify text expansion and zoom. Bound wide data tables without hiding their keyboard access.

The numeric criteria support implementation checks. They do not replace full accessibility conformance evaluation.
References: [text contrast](https://www.w3.org/TR/WCAG22/#contrast-minimum), [non-text contrast](https://www.w3.org/TR/WCAG22/#non-text-contrast), and [target size](https://www.w3.org/TR/WCAG22/#target-size-minimum).

## UI-10 — Completion evidence

- Implement the relevant patterns and required states before reporting the page complete.
- Check light and dark rendering, text overflow, zoom, and the selected and hover surfaces.
- Verify counts and scope across the entire write flow.
- Verify state preservation during refresh, navigation, filtering, and recoverable failures.
- Test meaningful risk boundaries, including preview invalidation, denied actions, uncertain results, and duplicate submission.
- Run the applicable repository checks through Nx.
- Record keyboard, focus, screen-reader, and usability evidence separately from static screenshots.
- Report checks as passed, failed, not run, or inapplicable with a reason.
- Do not claim implementation acceptance from Figma prototype validation.
