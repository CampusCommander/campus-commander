# Documentation start here

Updated: 2026-09-17. This is the only documentation entry point for development.

The owner requested a documentation audit and reorganization after rejecting the implemented UI and questioning its scope.
This reset organizes sources. It does not approve the existing Schools or invitation workflows.

## Read for the current task

1. Read [current work](current-work.md) for the authorized task and development order.
2. Read the relevant entry in [workflow gaps](workflow-gaps.md), including its source and decision status.
3. Read the linked product requirements and relevant Figma frames.
4. For UI work, read [UI rules](ui/README.md) and the relevant pattern and tokens.
5. Inspect the existing implementation before changing it.

Do not read the complete historical portfolio for every task.
The [file index](document-index.csv) lists the documentation corpus and each file's purpose.
The [design map](portfolio/prototype-map.md) identifies Figma pages and workflow entry points.

## What controls a decision

| Source | Use |
| --- | --- |
| Current owner instructions | Control scope and supersede conflicting historical text. |
| An owner-confirmed workflow with a source | Defines the product behavior to implement. |
| Linked Figma frames | Define the screen composition and interactions to inspect before UI implementation. |
| UI rules and tokens | Define shared controls, accessibility, and exact presentation values. |
| Architecture and capability research | Constrain implementation. They do not authorize new product features. |
| Phase plans, Jira tasks, implementation reports, and tests | Describe historical planning or existing behavior. They do not establish owner intent. |

A document labeled "approved" does not settle a feature that the owner now disputes.
Git authorship, test success, and repetition across documents do not establish approval.
Record a conflict in the relevant workflow entry. Do not silently choose a product behavior.
Continue unrelated authorized work when one workflow needs a decision.

## Format and location

Use plain Markdown committed with the application. No special document platform or additional documentation service is required.
Keep exact UI tokens and field definitions in the existing JSON files under `docs/ui/`.
Keep the complete file inventory in CSV so it remains searchable and opens in a spreadsheet.
Use Figma links with exact node IDs for visual references. Do not duplicate its entire node tree in Markdown.

| Location | Responsibility |
| --- | --- |
| `docs/current-work.md` | One active task and the working development order. |
| `docs/workflow-gaps.md` | Defined behavior, missing decisions, disputed scope, and source provenance. |
| `docs/workflows/<task>.md` | One agreed user workflow, when that workflow enters implementation. Create only when needed. |
| `docs/portfolio/01` through `04` | Existing product and engineering references, subject to the current scope corrections. |
| `docs/ui/` | Shared UI rules, patterns, tokens, and field metadata. |
| `docs/portfolio/prototype-map.md` | Current Figma references and their coverage limits. |
| `docs/testing/` and `deployment/` | How to run the implementation and operate existing tools. |
| `docs/reviews/`, `docs/validation/`, `deployment/evidence/` | Historical findings and measured results. No automatic work queue. |
| `docs/archive/` and historical phase plans | Earlier sources. Preserve provenance without executing old instructions. |

Do not create a second feature specification inside a Jira description or a test report.
When a workflow becomes agreed, put its behavior in one workflow file and link it from the gap entry.
Replace the gap's open status with the actual decision and source. Do not maintain two competing descriptions.

## Small workflow format

Use these fields. Keep ordinary workflows short. A page of prose is usually sufficient.

```markdown
# <User task>

Status: proposed | owner-confirmed | disputed | deferred | superseded
Source: <exact owner decision or original passage, with date and link>
Design: <Figma node links, or "missing">
Replaces: <older workflow or decision, if any>

## User and outcome
Who performs the task, and what they accomplish.

## Interaction
Where they start, what they see, what they enter or select, and what happens next.
Include the success result and the return path.

## Permissions and failures
Who can perform each action, what resource scope applies, and how relevant failures appear.
Separate Google changes from local settings and access administration.

## Examples
One normal example and the material denied or failed example.

## Exclusions and open decisions
Explicitly excluded behavior and unanswered product questions.

## Completion
The working interaction to demonstrate and the relevant checks.
Implementation status stays separate from owner confirmation of the requirement.
```

The agent prepares this record from existing sources. The owner does not need to rewrite the documentation.
Missing implementation details remain engineering decisions when they do not alter scope or the user workflow.
Missing product decisions require an answer before dependent implementation.
Do not invent defaults for adding people, granting authority, creating business entities, or adding navigation destinations.

## Git and Jira

Git is the working record. Jira is no longer required to plan, implement, commit, or demonstrate a change.
Existing Jira issues and links remain historical references. Do not synchronize or expand them unless the owner requests it.
No Jira key is required in branch names, commits, or PR titles.
Use focused `codex/` branches, small commits, and concise PR descriptions tied to the workflow source.
Commit and push authorized completed work. Do not merge without owner authorization.

## Why this structure exists

The previous documents mixed product decisions, proposals, tests, and release gates.
Several entry points claimed authority. Phase records turned implementation choices into apparent requirements.
The UI instructions also allowed implementation without inspecting the actual designs.
This structure makes sources and missing decisions visible. The agent remains responsible for following them.
