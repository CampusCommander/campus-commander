# Portfolio Consistency Audit — 2026-09-03

Executed while the owner was away, immediately after the 2026-09-03 grooming pass. Scope: consistency of the design portfolio and the design-truth docs against each other and against the grooming decisions. No feature work started. Sources: the grooming decisions in `docs/portfolio/05-decisions-and-open-questions.md` and the Admin SDK gap analysis (`docs/research/admin-sdk-gap-analysis.md`).

## 1. Scope-list sweep

The grooming corrected the wizard scope list in `docs/portfolio/03-architecture.md` to eight scopes. This sweep checked every other document for stale scope references.

| Location | Finding | Action |
|---|---|---|
| `docs/ux/ui-design-guide.md` | No scope strings. No count copy. | None needed. |
| `docs/ux/prototype-map.md` | No scope strings. No count copy. | None needed. |
| `docs/ux/design-review-2026-09-02.md` | References the historical "4 scopes granted" copy and the three-scope wizard, both as issue statements (S8, S9, L6) with their fixes. Historical record. | None needed. |
| `docs/architecture/*` | Scopes described generically (identity-only bootstrap, manual DWD grant). No stale strings. | None needed. |
| `docs/superpowers/specs/2026-07-07-core-entity-management-design.md` | References the DWD paste flow with a generic "scope list the wizard generated". No count, no strings. | None needed. |
| `docs/research/admin-sdk-gap-analysis.md` | Section 1 table said "six scopes" as current state. | Fixed this audit: now "eight scopes (see Section 2)". |

Conclusion: the only markdown drift was in the gap analysis itself, now fixed.

## 2. Open-question wiring (05 ↔ 06)

Programmatic check of `docs/portfolio/05-decisions-and-open-questions.md` Part 2 against every package reference in `06-work-breakdown.md`:

- 64 open questions defined, numbered 1-64, no gaps, no duplicates.
- 62 of 64 are referenced by at least one package via "Open questions consumed" or inline "open question N".
- Zero references from `06` point at numbers undefined in `05`.
- Zero package references in `05` point at packages absent from `06`.

Two findings, both resolved in this audit with strike-through resolutions in `05` Part 2:

- **OQ 3** (decision-record process): resolved by the portfolio itself. `05` Part 1 is the process: dated, sourced, append-only. Cross-links `07` issue A5.
- **OQ 64** (implementation sequencing order): resolved by `06`, which carries the dependency graph and the suggested execution order.

## 3. Truth-lint sweep (portfolio + design-truth docs)

Patterns banned by the review round's lint, checked across `docs/portfolio/` and `docs/ux/`:

| Pattern | Result |
|---|---|
| Cadence copy ("every 15 minutes" and variants) | Clean. Hits exist only inside `design-review-2026-09-02.md` as historical issue statements (S8) and their fixes. |
| "Incremental sync" copy | Clean in live docs. Decision 17.30 and `02`/`03` state full-sweep-only. Hits in the review doc are the historical S4 statement. |
| Undo copy | Clean in live docs. Gate G1 holds. The review doc's "Undo Snackbar" references are historical and carry the documented rename to "Run Result Snackbar". |
| Firmware copy | Clean in live docs. Hits in the review doc are the historical S5 statement. |

Conclusion: no live copy drift. The design review file is a record of issues found, so its mentions of banned copy are correct and expected.

## 4. Board-name reconciliation (design review ↔ prototype-map)

The review references boards as "Page — Board". The prototype-map uses a compact notation ("Settings: Overview, Diagnostics, Setup Wizard, Connection, Setup Waiting" and "Users states: …"). After normalizing notation, all referenced boards resolve. The single rename — "Users — Undo Snackbar" to "Run Result Snackbar" — is documented in both files. No naming drift.

## Verdict

The portfolio is internally consistent after the grooming pass. Unresolved product issues carried forward: the issues in `07` (A1, A2, B1-B12, C3-C6, E1-E8, E10-E12 minus those groomed). The next grooming-relevant decision remains the Tier 1 items that did not graduate (T1-3, T1-4, T1-8, T1-9) and all Tier 2 items.
