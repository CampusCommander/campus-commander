# Campus Commander — Prototype Map

The current visual reference is [Figma page 09 — Device Workflows · Revised](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=122-364).
Agents implement routine UI work from the [repository UI contract](../ui/README.md).
Figma remains the human visual workspace. Written requirements govern behavior and exact repository tokens govern implementation values.

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

- Product behavior and domain terms: [portfolio](README.md).
- Agent implementation rules and page patterns: [UI contract](../ui/README.md).
- Exact design values: [tokens.json](../ui/tokens.json).
- Human visual review: the Figma flows listed above.

## Maintenance

Update this map when Figma flow entry points change.
Keep reusable rules and exact values in the repository UI contract.
Record design validation separately from working-client acceptance.

The device experience requires owner acceptance in Phase 6 before Users development.
Adapt accepted patterns for Users, OUs, and Groups in Phases 7–9.
Fleet Status and reports belong to Phase 10.
