# Campus Commander — Design Portfolio

**Status: current planning baseline, revised 2026-09-05. Phase 2 implementation is in progress. Release acceptance remains open.**

This portfolio integrates the contractor review and the owner's subsequent decisions about orchestration, Redis admission holds, deployment, and job storage.
The owner authorized this integration on 2026-09-05. That authorization adopts a planning direction. It does not certify untested behavior.

## Authority and evidence

[03 — Architecture](03-architecture.md) defines the current engineering design.
[05 — Decisions and Open Questions](05-decisions-and-open-questions.md) records decision status, replacements, and unresolved validation.
The other portfolio documents define product behavior, terminology, interactions, and delivery work.
Resolve contradictions here before implementing the affected behavior.

The [contractor report](../reviews/2026-09-04-contractor-report.md) and [technical instructions](../reviews/2026-09-04-technical-change-instructions.md) preserve review evidence and rationale.
The [admission policy](../reviews/2026-09-04-job-admission-policy.md) records the owner's precise Redis behavior.
Review documents support this portfolio. They do not provide a separate executable backlog.
The [archive](../archive/README.md) preserves earlier sources as history. Archived requirements do not override this portfolio.

## Implementation status

The repository contains deployment code and Phase 2 application code alongside records of Figma prototypes.
The [Phase 2 implementation record](phase-2-implementation.md) links current tests, profile evidence, and remaining release gates.
The [September 12 manual test record](../testing/phase-2-ubuntu-google-results-2026-09-12.md) records the operator's passing Ubuntu and Google Workspace tests.
Resume reached readiness after a full disk during installation. The remaining district acceptance work stays open.
Passing local checks does not establish release acceptance. Preserve unrelated work during implementation.
A prototype board illustrates an interaction. It does not prove permissions, API behavior, performance, or recovery.

**V0 validation is IN PROGRESS.** The [2026-09-05 validation report](../validation/v0-2026-09-05/README.md) records local experiment results and remaining gates.
Real PostgreSQL, Redis, and Kestra probes produced evidence. Google access, full grid workflows, and container installation remain unverified.
Disposable validation scripts do not establish completed application implementation.

The owner subsequently adopted [ten cumulative development phases](06-work-breakdown.md#delivery-sequence), replacing the earlier V1–V6 order.
All Docker, hybrid Docker with district servers, and enterprise Kubernetes begin in Phase 1.
The device experience requires owner acceptance in Phase 6 before Users development proceeds.
The V0 report remains historical experiment evidence. Its former delivery references do not override the current phase sequence.

## File map

| File                                                                    | Responsibility                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [01 — Product Brief](01-product-brief.md)                               | Audience, customer boundary, scope, deployment choices, and success criteria          |
| [02 — Domain Model](02-domain-model.md)                                 | Canonical vocabulary, entities, actions, selection, and import semantics              |
| [03 — Architecture](03-architecture.md)                                 | Runtime, credentials, data, jobs, admission, storage, sync, and operations            |
| [04 — UX/UI Spec](04-ux-ui-spec.md)                                     | Visual system, search, editing, safety, accessibility, and product states             |
| [Agent UI contract](../ui/README.md)                                    | Repository rules, page patterns, exact tokens, and implementation evidence for agents |
| [05 — Decisions and Open Questions](05-decisions-and-open-questions.md) | Decision index, supersession map, and validation questions                            |
| [06 — Work Breakdown](06-work-breakdown.md)                             | Evidence-first slices, package ownership, dependencies, and acceptance gates          |
| [Phase 1 Jira task backlog](phase-1-jira-tasks.md)                      | 17 published Jira tasks, 36 verified blocking links, and acceptance criteria.         |
| [Phase 2 implementation](phase-2-implementation.md)                     | Authentication contracts, nineteen Jira tasks, and current implementation evidence.   |
| [07 — Issues and Opportunities](07-issues-and-opportunities.md)         | Remaining gaps, feature opportunities, and review integration map                     |
| [Prototype map](prototype-map.md)                                       | Existing board inventory and required alignment work                                  |

## Reading and execution rules

1. Read the product brief, domain model, architecture, and relevant interaction requirements.
2. Check decision status and package dependencies before implementing a behavior.
3. Follow Phase 1–10 and resolve the V0 findings required by each phase before dependent implementation.
4. Require evidence for credentials, permissions, recovery, storage, and capacity before releasing dependent packages.
5. Keep the same terms across contracts, jobs, UI, and documentation.
6. Resolve new requirements in the relevant portfolio document before adding application behavior.
7. Record status changes with evidence. Never mark experiments complete from design prose alone.
8. Apply repository writing rules and preserve unrelated workspace changes.

Independent work requires settled interfaces and nonconflicting ownership. The work breakdown defines those boundaries.
Routine implementation follows the adopted design. Unresolved protocol or safety requirements remain explicit package blockers.
Do not reopen retained LibreGrid, Redis, or Kestra selection without new evidence and an explicit replacement decision.

## Review integration status

All seven planning documents and the prototype map received the 2026-09-05 integration.
The [C01–C20 map](07-issues-and-opportunities.md#review-integration-map) connects each review change to its current home.
Version choices, exact thresholds, credential experiments, and district acceptance remain unverified where marked.
