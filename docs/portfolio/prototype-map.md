# Campus Commander — Prototype Map

The current visual reference is [Figma page 09 — Device Workflows · Revised](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=122-364).
Agents inspect the relevant frames before screen implementation and apply the [repository UI contract](../ui/README.md).
Use [the documentation guide](../README.md) for source authority and [workflow gaps](../workflow-gaps.md) for missing behavior.

## File inventory checked on 2026-09-17

The read-only audit inspected page structure, frame names, and text relevant to access and setup across all eleven pages.
This establishes design coverage. It does not certify every interaction or visual state.

| Page | Node | Coverage |
| --- | --- | --- |
| 00 — Start Here | `17:2` | Historical guide and source instructions. Current repository authority supersedes conflicting instructions. |
| 01 — Design Language | `17:3` | Audience, principles, character, and voice. |
| 02 — Foundations | `17:4` | Colors, typography, dimensions, icons, and accessibility specimens. |
| 03 — Layout Templates | `17:5` | Shell and generic page patterns. No complete platform-access or onboarding flow. |
| 04 — Components & States | `17:6` | Shared controls, grid components, field states, and typed filters. |
| 05 — UX Rules | `17:7` | Action language, system state, and Google-change interactions. |
| 06 — Agent Build Checklist | `17:8` | Historical construction checklist. It cannot authorize missing workflows. |
| 07 — Reference Screen | `0:1` | Earlier light/dark Users examples. |
| 08 — Device Management | `57:2` | Earlier device studies. Prefer revised page 09 for current composition. |
| 09 — Device Workflows · Revised | `94:2` | Device, grid editing/filtering, CSV, Jobs, and recovery examples. |
| 10 — Users | `240:2` | Eighteen numbered frames plus an index for Google Workspace user workflows. |

No complete design for adding platform users, assigning their permissions, creating schools, or onboarding was found in this file.
The owner subsequently confirmed [settings organization and layout rules](../ui/rules.md#ui-11--settings-organization-and-visible-work) on 2026-09-17.
The [platform-access workflow](../workflows/platform-access.md) records confirmed behavior. These decisions do not supply the missing Figma compositions.
The Settings frame `106:383` only presents a read-only connection warning and a return to Devices.
It does not define the implemented connection, invitation, access, customer-settings, or Schools pages.

## Google Workspace Users references

These designs concern managed Google accounts. They do not define how people receive Campus Commander access.
Their presence does not change the current development order.

| Starting point | Reference |
| --- | --- |
| Users index | [Start here](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=254-823) |
| Inventory, light | [Users](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=240-3) |
| Inventory, dark | [Users dark](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=243-132) |
| User details | [Details](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=244-395) |
| Suspension | [Preview](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=245-399) |
| OU edit | [Staged edit](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=247-413) |
| Results | [Job results](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=246-409) |
| States | [States and recovery](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=249-807) |
| Other actions and CSV | [Action catalog](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=252-823) |

The last frame summarizes actions and CSV. A catalog is not a complete design for every action it names.

## Current Figma reference

Revision 1.5 replaces the Jobs placeholder with a read-only grid, filter chips, and dedicated operation details.
The device grid retains revision 1.4 cell editors, action menus, and the AG Grid selection footer.
The [revision record](../reviews/2026-09-05-figma-experience-review.md) records design changes and validation limits.

| Starting point           | Reference                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Review index             | [Start here](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=122-364)               |
| Inventory and update     | [Devices](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=94-3)                     |
| Grid editing and filters | [Revision 1.4 index](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=183-4432)      |
| Changed cells            | [Two staged changes](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=171-1525)      |
| Filter match order       | [Fields before shortcuts](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=175-1562) |
| CSV reconciliation       | [Import](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=106-426)                   |
| Commands                 | [Choose command](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=106-156)           |
| Recovery states          | [Recovery index](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=122-370)           |
| Jobs redesign            | [Jobs review index](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=232-5274)       |
| Jobs list                | [All jobs](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=106-109)                 |
| Job details              | [Operation results](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=104-209)        |

Prepared values and navigation do not prove client behavior, permissions, provider support, or accessibility.
The original device studies remain available for comparison.

## Design authority

- Source authority and current scope: [documentation guide](../README.md) and [workflow gaps](../workflow-gaps.md).
- Agent implementation rules and page patterns: [UI contract](../ui/README.md).
- Exact design values: [tokens.json](../ui/tokens.json).
- Required visual reference for screen implementation: the relevant Figma flows listed above.

## Maintenance

Update this map when Figma flow entry points change.
Keep reusable rules and exact values in the repository UI contract.
Record design validation separately from working-client acceptance.

Follow [current work](../current-work.md) for development order.
Adapt the working device patterns for Google users, OUs, and groups. Define reports before implementing them.
