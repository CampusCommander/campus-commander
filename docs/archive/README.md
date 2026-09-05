# Archive

Files moved out of the active documentation set on 2026-09-03. Every file here was scanned before the move: its content either lives in the finalized portfolio (`docs/portfolio/`), is tracked as backlog (`06-work-breakdown.md`, `07-issues-and-opportunities.md`), or was deemed obsolete. Nothing unique was lost. Do not cite these files as current design truth. Do not edit them. The portfolio wins on any conflict.

## specs/

| File | Disposition |
|---|---|
| `2026-07-07-core-entity-management-design.md` (Spec 1) | Verified section by section against the portfolio during the 2026-09-03 consolidation. Product overview, tenancy, stack, install (including rejected alternatives), bootstrapping (superseded by Architecture A), grid stack, NL filtering, bulk safety, import/export, per-entity design, sync, jobs pipeline: all folded into `01`, `02`, `03`, `04`. The service-account bootstrap prose was superseded and intentionally not carried. |

## architecture/

| File | Disposition |
|---|---|
| `2026-07-22-campus-commander-architecture.md` | Condensed into `03-architecture.md`. TLS, connection model, pipeline, sync, install: all present. |
| `planning-review-topics.md` | The decision record (17.x) mirrors into `05` Part 1. All 125 unchecked items have homes: 64 consolidated open questions in `05` Part 2 (several questions merge related items), package scopes in `06`, issues in `07`. Five operational items (clock sync, support bundle, uninstall completeness, data sensitivity, health/readiness/liveness checks) folded into P9.2 and P9.3 goals. |

## ux/

| File | Disposition |
|---|---|
| `ui-design-guide.md` | Folded into `04-ux-ui-spec.md` in full: token tables, measurements, component packages, states, open items, implementation notes. |
| `design-review-2026-09-02.md` | Findings executed in Penpot during the 2026-09-02/03 review round. Gate decisions G1-G3 in `05` Part 1. Work items A-D mined into `06` (Track 12 D-E) and `04`. Historical record of the review round. |
| `feature-review-notes-2026-09-03.md` | Owner brain dumps, verbatim. Summarized in `02` (Owner brain dumps) and tracked as Track 12 items D-A to D-D in `06`. Kept verbatim for the record. |

## research/

| File | Disposition |
|---|---|
| `google-api-quotas.md` | Folded into `03-architecture.md` Appendix A (rate limits, page sizes, backoff semantics, quota-increase mechanics). |
| `admin-sdk-gap-analysis.md` | Scope corrections S1/S2 became issues A7/A8 and the eight-scope decision in `05`. Graduated opportunities are E9-E12. The remaining catalog is `07` Section F. Constraint facts are `03` Appendix A. The full API inventory with primary-source citations lives here, kept for reference. |
| `design-platforms-mcp-options.md` | Obsolete. Penpot was selected and implemented. Its operational notes (token export, logomark item) live in `04` Sections 15-16. |

## audits/

| File | Disposition |
|---|---|
| `2026-09-03-portfolio-consistency-audit.md` | Point-in-time report. Findings integrated: open questions 3 and 64 struck through in `05`, gap-analysis scope count fixed. Kept as the record of the audit. |

## wayfinder/

The completed July sync-design effort. Its destination (Sync and Jobs Pipeline sections in Spec 1) was written long ago, and every decision is in the portfolio: baseline and sync detail (decisions 17.26-17.30), quota pacing (17.24-17.25), bulk-write interaction (read-after-write, now in `03` Sync and OQ 21), failure surface (P2.3), quota research (`03` Appendix A).
