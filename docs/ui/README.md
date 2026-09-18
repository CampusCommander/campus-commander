# Agent UI contract

Version: 1.6.0. Updated: 2026-09-17.
Scope: client pages, shared controls, feature flows, and UI reviews.
Status: implementation requirements. Product implementation and owner acceptance remain separate evidence.

Agents inspect the relevant Figma design before implementing a screen or changing its composition.
The shared rules support that inspection. They do not replace the design or authorize new workflows.
This contract translates the portfolio and the September 5–6 Figma revisions into implementation requirements.
The owner's September 17 [settings and layout direction](rules.md#ui-11--settings-organization-and-visible-work) supersedes conflicting earlier compositions.

## Read order

1. Read [current work](../current-work.md) and the relevant [workflow gap or decision](../workflow-gaps.md).
2. Inspect the relevant frames from the [Figma map](../portfolio/prototype-map.md).
3. Read [rules.md](rules.md) for every UI task.
4. Read the relevant sections of [patterns.md](patterns.md).
5. Read [tokens.json](tokens.json) when changing presentation or shared controls.
6. Read the linked domain and capability requirements relevant to the workflow.
7. Inspect existing client components before adding another implementation.

For entity grids, also read [entity-grid-fields.json](entity-grid-fields.json).
It defines detail navigation, explicit editor metadata, draft actions, and typed filter controls.
Markdown defines behavior. JSON supplies structured metadata. Figma supplies the visual composition to inspect.
The batch-edit module requires server-side compatibility qualification before release. See GRID-05 in [patterns.md](patterns.md#draft-and-mutation).

For Jobs, also read [jobs-grid.json](jobs-grid.json) and JOB-03 through JOB-04 in [patterns.md](patterns.md#jobs-and-recovery).
Jobs use a read-only operational grid and dedicated detail pages.

| Task                                       | Required pattern                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| Browse or act on records                   | [Entity grid](patterns.md#entity-grid) and [Selection](patterns.md#selection) |
| Inspect an entity or telemetry             | [Entity detail](patterns.md#entity-detail)                                    |
| Edit fields or move entities               | [Draft and mutation](patterns.md#draft-and-mutation)                          |
| Run a device command or status change      | [Device actions](patterns.md#device-actions)                                  |
| Export or import records                   | [CSV round trip](patterns.md#csv-round-trip)                                  |
| Display work, notifications, or outcomes   | [Jobs and recovery](patterns.md#jobs-and-recovery)                            |
| Build settings, onboarding, or a hierarchy | [Forms and hierarchy](patterns.md#forms-and-hierarchy)                        |

## Authority

- Current task instructions define the authorized task scope.
- The [documentation guide](../README.md) defines source authority. Disputed workflow choices remain unresolved.
- Verified capability evidence limits the actions and claims the client exposes.
- This contract defines reusable UI implementation rules. `tokens.json` defines exact design values.
- Figma defines the referenced visual composition. A conflict with written behavior requires explicit resolution.

Resolve a behavior conflict in the relevant workflow record before implementing the affected behavior.
Continue independent work while a required product decision remains unresolved.
Do not infer provider support from a design or a package name.

Reuse a previously inspected design for routine fixes that preserve its composition and behavior.
Missing workflow or composition is a design gap. Generic form rules do not fill it.
Use the [current work order](../current-work.md#development-order-after-the-reset), not historical phase acceptance matrices.

## Token format

`tokens.json` uses a small repository format with `schemaVersion`, provenance, colors, dimensions, and typography.
It is not a Figma node dump or a claim of compatibility with an external token standard.
Color entries contain an sRGB hex value and separate alpha for each mode.
Dimensions use numeric pixel values. Typography records family, weight, size, line height, and letter spacing.
Each color and dimension maps to a CSS custom property.
`sourceId` values support design maintenance. Client code must not depend on Figma IDs.

Preserve alpha when producing CSS. For example, `surface/selected` uses 8 percent alpha in light mode.
Do not apply element opacity to a container and fade its text or controls.
Feed the values into the shared Material theme and grid bridge. Avoid separate component palettes.

The current [runtime stylesheet](../../frontend/src/theme/tokens.css) predates this contract.
It lacks several tokens and contains older light warning and error text values.
It is implementation evidence, not the design authority.
Reconcile that stylesheet with `tokens.json` during theme implementation. No generator or runtime import is installed by this documentation change.

## Handoff record

Include this record in the task or PR description. Do not create a permanent manifest for every component.
Replace example values with actual paths, rule IDs, and evidence.
Use `not-run` for missing evidence. Use `not-applicable` only with a reason.

```json
{
  "contractVersion": "1.6.0",
  "page": "<route or component>",
  "primaryJob": "<one user task>",
  "pattern": "entity-grid | entity-detail | centered-form | split-pane | list-detail",
  "phase": "<current delivery phase>",
  "rules": ["UI-01", "GRID-01"],
  "components": ["<existing or added component paths>"],
  "states": {
    "loading": "implemented | not-applicable: reason",
    "empty": "implemented | not-applicable: reason",
    "error": "implemented | not-applicable: reason",
    "partial": "implemented | not-applicable: reason",
    "stale": "implemented | not-applicable: reason",
    "offline": "implemented | not-applicable: reason"
  },
  "writeFlow": "draft-or-selection > preview > confirm > job > audited-result | none | local-preference",
  "verification": {
    "lightAndDark": "not-run",
    "keyboardAndFocus": "not-run",
    "screenReader": "not-run",
    "contrastAndTargets": "not-run",
    "countsAndScope": "not-run",
    "recoveryAndPreservation": "not-run",
    "overflowAndZoom": "not-run"
  },
  "evidence": [],
  "limitations": []
}
```

## Maintenance

Update the relevant rule or pattern in the same change that intentionally changes UI behavior.
Keep rule IDs stable. Record a replacement instead of silently reusing an ID for another requirement.
Update exact values in `tokens.json`. Reconcile runtime tokens and Figma during the associated implementation or design work.
Advance the contract version when requirements change. Update provenance when importing another design revision.
Record acceptance evidence separately from design updates.
Do not export every Figma frame into agent instructions. Keep examples in Figma and reusable requirements here.

Sources: [UX specification](../portfolio/04-ux-ui-spec.md), [domain model](../portfolio/02-domain-model.md), and [Figma revision record](../reviews/2026-09-05-figma-experience-review.md).
Visual reference: [Figma review index](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=122-364), revision 1.5.
The exact token export remains revision 1.2. Revisions 1.3 through 1.5 reuse those values.
