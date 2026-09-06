# General Guidelines for communication and writing

Apply the `ste-writing` skill to all prose output (docs, READMEs, PR descriptions, error messages, release notes, comments). See `.opencode/skills/ste-writing-skill/SKILL.md` for the full ruleset. Key rules:

- One name for one thing; no synonym rotation.
- No hedging ("might", "may", "could", "seems", "appears", "potentially", "likely", "possibly").
- Active voice; no nominalizations, phrasal verbs, or stacked auxiliaries.
- No marketing adjectives.
- No run-on sentences; each independent clause gets its own sentence.
- No semicolons, no contractions. Max 20 words per instruction sentence.
- One topic per paragraph (max six sentences).


## Client UI implementation

For client pages, controls, feature flows, and UI reviews, read [docs/ui/README.md](docs/ui/README.md) first.
Follow its shared rules, relevant patterns, and exact design tokens.
Routine UI implementation must not require parsing Figma.
Use Figma for requested visual design work or composition absent from the repository contract.
Keep product behavior and phase availability consistent with [docs/portfolio/README.md](docs/portfolio/README.md).
Include applicable rule IDs and validation evidence in the task handoff.

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->
