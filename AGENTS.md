# Documentation and scope — owner reset, 2026-09-17

Read [docs/README.md](docs/README.md) and [docs/current-work.md](docs/current-work.md) before choosing work.
Use [docs/workflow-gaps.md](docs/workflow-gaps.md) to distinguish defined behavior, missing decisions, and disputed scope.
These records supersede historical phase plans and Jira execution instructions.

- Do not infer product approval from agent-written requirements, existing code, passing tests, or Jira status.
- School creation and the built invitation workflow are disputed. Do not expand or replace them without a resolved workflow.
- Inspect the relevant Figma design before implementing a screen or changing its composition.
- Record missing product behavior before dependent implementation. Do not invent new entities, workflows, or navigation destinations.
- Keep one user workflow active. Use its source, design, exclusions, and concise completion criteria.
- Jira is optional historical reference. Do not create or synchronize tasks unless the owner requests it.
- Use focused `codex/` branches. Jira keys are not required in branches, commits, or PR titles.

# Current development model — owner direction, 2026-09-17

Campus Commander is greenfield work. Nothing is live, and no incremental customer environment requires support.
Phases organize development. They are not deployed product versions or a path that users must follow.
The immediate objective is a usable client application with a fresh installation.

The owner stated:

> There is NO migration and data safety we have to adhere to at this point. That will all be done AFTER we have an actual product to use.

Apply this direction to every plan, implementation choice, test, and release requirement:

- Treat development databases, fixtures, and test data as disposable. Recreate them when needed.
- Do not implement cross-phase migration, legacy compatibility, incremental upgrades, or preservation of development test data.
- Defer migration, backup, restore, recovery, and data-safety engineering until a usable product exists and that work enters scope.
- Do not make historical migration or deployment qualification requirements prerequisites for client development or a runnable review build.
- Prioritize client features, working application flows, fresh installation, and owner review.
- Keep application authorization and credential protection in place.
- Retain existing code and evidence without expanding deferred infrastructure work merely because it already exists.

This direction supersedes conflicting historical phase plans, task criteria, and qualification checklists.
Do not infer a live deployment or a data-preservation obligation from the existence of an earlier phase or test installation.

## Standing live Google test authorization — owner direction, 2026-09-17

The owner authorizes ongoing read-only API plumbing tests against `easton-consulting.com`, confirmed customer `C01zcarnq`.
Use DWD service-account client ID `113794681976879482895` with delegated subject `spencer@easton-consulting.com`.
The owner confirms that this account has the Super Admin role and that the server credentials are configured.
Reuse this approved fixture when development needs live API checks. Do not request the same authorization again.
The protected local credential is `/mnt/c/Users/spenc/Downloads/DWD_SA_CC.json`. Keep its contents outside Git, reports, and messages.
An Education domain and populated entity collections are not prerequisites for standard API plumbing checks.
Empty collections are valid observations. Record actual results without inventing entity coverage or minimum-role qualification.
Use currently authorized scopes. Additional scopes require their corresponding Google configuration before testing dependent APIs.
This authorization does not permit DWD revocation, key disablement, or Google data mutations.
See [the credential record](docs/portfolio/phase-3-google-credentials.md) for the current scopes and limitations.

# General Guidelines for communication and writing

Apply the `ste-writing` skill to prose when available. The required repository writing rules are listed below.
The former `.opencode/skills/ste-writing-skill/SKILL.md` path does not exist. Do not depend on it or stop work to recover it.

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
Inspect the relevant Figma frames before implementing a screen or changing its composition.
Shared rules and tokens do not replace that visual inspection.
If a workflow or composition is missing, record the gap and resolve it before dependent implementation.
A routine code fix that preserves the inspected design does not require exporting the complete Figma file again.
Use [docs/README.md](docs/README.md) for source authority and [docs/current-work.md](docs/current-work.md) for active scope.
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
