# Product and engineering references

Start with [the documentation guide](../README.md), [current work](../current-work.md), and [workflow gaps](../workflow-gaps.md).
This directory preserves design references and implementation history. It is not a separate execution plan.

The owner closed Phase 1 and accepted Phase 2. The owner rejected the current Phase 3 UI and disputed feature scope.
Historical approval labels do not settle those disputed features.

## Reference map

| Reference | Purpose |
| --- | --- |
| [Product brief](01-product-brief.md) | Product purpose, audience, and consolidated scope. Apply the current scope corrections. |
| [Domain model](02-domain-model.md) | Entity terminology and behavior. School-specific definitions remain disputed. |
| [Architecture](03-architecture.md) | Engineering design. The owner-selected DWD profile supersedes the earlier background OAuth proposal. |
| [UX specification](04-ux-ui-spec.md) | Shared interaction requirements. Inspect the relevant visual design before screen implementation. |
| [Decisions and questions](05-decisions-and-open-questions.md) | Dated decision history and technical questions. The current workflow register identifies active product gaps. |
| [Work breakdown](06-work-breakdown.md) | Historical phase and package allocation. Do not execute its unchecked items automatically. |
| [Issues and opportunities](07-issues-and-opportunities.md) | Earlier findings and candidate features. Opportunities are not authorized scope. |
| [Figma map](prototype-map.md) | Current visual references and coverage limits. |
| [UI contract](../ui/README.md) | Shared controls, patterns, tokens, and accessibility. |

## Phase records

Files named `phase-*` preserve planning, implementation, and validation history.
They do not authorize product behavior or define the current development order.
Their old pending checks are not prerequisites for current client work.
Use the [complete index](../document-index.csv) to find a particular record.

The [credential record](phase-3-google-credentials.md) retains the current owner-selected service-account profile and standing read-only test authorization.
The [Phase 2 acceptance](../reviews/2026-09-16-phase-2-acceptance.md) remains an owner decision.
Later owner instructions override conflicting historical scope, including upgrade and development-data preservation requirements.

## Source provenance

The [original sources](../archive/README.md) remain useful for tracing intent and detecting later additions.
The [contractor report](../reviews/2026-09-04-contractor-report.md) and [technical instructions](../reviews/2026-09-04-technical-change-instructions.md) record recommendations and their rationale.
Recommendations, plans, and implementation evidence do not independently prove feature approval.
Do not use Jira as a second requirements authority.
