# Workflow coverage and missing decisions

Audit date: 2026-09-17. Baseline: `aa723f126ea0cb1e931776c45a349d8497b2cf73`.

This audit distinguishes written requirements, visual references, implementation records, and confirmed owner intent.
"Defined" means a source describes behavior. It does not mean that the owner approved every detail or that implementation passed.
"Missing" means this audit found no sufficient workflow definition in the indexed repository and current Figma file.
It does not mean that no earlier conversation exists outside those sources.

## Coverage and limits

The baseline contains 190 prose files and 352 structured documentation or evidence files: 542 total.
The [file inventory](document-index.csv) records every path, category, title, and section index.
The scan reads each file for classification, headings, source links, and decision or status language.
Product, workflow, original-source, and conflicting authority passages receive targeted content review.
Generated evidence receives structural indexing. This task does not repeat its tests or independently validate every historical result.
Duplicated agent skills are tooling instructions, not separate product requirements.

The audit inspected the page and frame structure of all eleven pages in the current Figma file.
It also inspected text relevant to access, setup, and settings.
This is design coverage indexing, not a complete visual or prototype-interaction review of every frame.
The [design map](portfolio/prototype-map.md) records the inspected pages and workflow links.

External Jira and GitHub links remain references. The task does not crawl every remote issue, PR, or linked vendor manual.
No complete export of the original planning conversations exists in the indexed repository.
Source documents that claim an owner decision remain attributed records unless a direct quotation or current instruction supports them.
Git author names do not distinguish user-authored text from agent-generated text committed under the user's account.

## What is already defined

| Area | Defined behavior | Sources and limits |
| --- | --- | --- |
| Product purpose | Self-hosted Google Workspace administration for district staff, with fast inventory browsing and bulk work. | [Original spec](archive/specs/2026-07-07-core-entity-management-design.md#product-overview), [product brief](portfolio/01-product-brief.md). |
| Core entities | ChromeOS devices, Google users, organizational units, groups, and memberships. | [Entity catalog](portfolio/02-domain-model.md#entity-catalog). Schools are not a Google entity in this catalog. |
| Audience | District administrators and occasional helpers. | [UX audience](portfolio/04-ux-ui-spec.md#1-audience). |
| Architecture | Angular, Material, LibreGrid, NestJS, PostgreSQL, Redis, Kestra, independent workers, and file artifacts. | [Architecture](portfolio/03-architecture.md#retained-stack). Technical choices do not authorize additional screens. |
| Google connection | App sign-in is separate from service-account DWD for background API access. | [Owner-selected credential record](portfolio/phase-3-google-credentials.md). This supersedes the older background OAuth proposal. |
| Grid interactions | In-cell drafts, changed-cell styling, per-cell discard, Save/Clear, chip filters, selection footer, and details icons. | [Recorded owner feedback](archive/ux/feature-review-notes-2026-09-03.md), [grid patterns](ui/patterns.md), [field metadata](ui/entity-grid-fields.json). |
| Device work | Inventory, details, annotated-field edits, OU moves, status changes, and the selected command catalog. | [Device model](portfolio/02-domain-model.md#devices-chromeos), [Figma map](portfolio/prototype-map.md). API qualification remains capability-specific. |
| Google change flow | Review exact changes, confirm, execute through a job, and show operation results. | [Recorded owner rationale](portfolio/02-domain-model.md#bulk-action-safety-rules), [Jobs patterns](ui/patterns.md#jobs-and-recovery). Do not apply every Google-change screen to ordinary local preferences. |
| Jobs | List and detail views, status, operation results, cancellation boundaries, and failure/unknown distinctions. | [Jobs metadata](ui/jobs-grid.json), [Jobs designs](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=232-5274). |
| CSV intent | Export, spreadsheet edits, reimport, comparison, review, and job results. | [Owner feedback](archive/ux/feature-review-notes-2026-09-03.md#dump-3--round-trip-exportimport-edit-in-spreadsheet), [comparison rules](portfolio/02-domain-model.md#import-and-export-semantics). Detailed product choices remain below. |
| Shared presentation | Material controls, Roboto, Material Symbols, light/dark tokens, shell dimensions, and accessibility rules. | [UI contract](ui/README.md). A form-width token does not determine a page's information hierarchy. |
| Exclusions | Classroom management, bulk Super Admin grants, dynamic/security groups, group conversation content, and automatic rollback. | [Product exclusions](portfolio/01-product-brief.md#deferred-scope-and-exclusions). Optional AI and widgets are not prerequisites. |
| Development constraints | Greenfield, disposable data, fresh installation, usable client first, no phase upgrade journey. | Current owner instructions, recorded in [AGENTS.md](../AGENTS.md) and [current work](current-work.md). |

## Decisions needed for access and setup

These are product questions. Existing backend contracts and passing tests do not answer them.
Decide only the entries needed for the next workflow. Do not turn the entire list into a prerequisite project.

| ID | Workflow and status | What the documents contain | Missing decision or design |
| --- | --- | --- | --- |
| G01 | Add a person to Campus Commander — **eligibility and email delivery owner-confirmed, activation unresolved** | Owner decision, 2026-09-17, recorded verbatim in the [platform-access workflow](workflows/platform-access.md#who-administrators-can-invite--2026-09-17). Administrators can select directory accounts and invite people outside the Workspace. The platform is invite-only. Access requests are prohibited. The owner selected [email delivery from Campus Commander](workflows/platform-access.md#invitation-delivery--2026-09-17). | Define external-person entry, recipient authentication, activation, email configuration, and delivery failure handling. Manual copy-link delivery is outside the agreed workflow. Redemption and second confirmation remain unresolved. The current decision replaces conflicting interpretations of historical decision 17.7. |
| G02 | Assign and edit permissions — **partial, scope disputed** | Historical action/resource grants and presets in [R12](portfolio/05-decisions-and-open-questions.md#current-decisions). The owner confirmed separate Platform Users and Platform Roles and Permissions pages under Settings. See the [workflow](workflows/platform-access.md#interface-organization--2026-09-17). | Define visible roles, custom permissions, selectable resources, delegation authority, and effective-access explanations. Define where person-specific assignment occurs across these separate concerns. Figma composition remains missing. |
| G03 | Define a person's resource access — **disputed** | School scopes originate in [technical review section 6](reviews/2026-09-04-technical-change-instructions.md), then enter the [school implementation contract](portfolio/phase-3-school-scopes.md). The July core spec has no school-creation workflow. | Should access use OUs, explicit records, groups, or a separately managed school object? If schools exist, who defines them and why? Multiple roots, exclusions, automatic descendants, and a Schools navigation destination are not settled by the word "school." |
| G04 | First administrator setup — **implementation exists, product flow incomplete** | [Original first-run intent](archive/specs/2026-07-07-core-entity-management-design.md#deployment--install-experience), [enrollment runbook](../deployment/bootstrap/APPLICATION-ACCESS.md), [administrator confirmation](../deployment/bootstrap/PHASE-3-ACCESS.md). | What exact sequence should a new installer see from starting the app to reaching useful work? Which browser handoffs and identity confirmations are necessary? The CLI pairing and later confirmation steps do not constitute an agreed screen design. |
| G05 | Navigation and landing page — **settings organization owner-confirmed, composition incomplete** | Owner direction, 2026-09-17: all platform settings belong under Settings, with one page per concern. [UI-11](ui/rules.md#ui-11--settings-organization-and-visible-work) records named concerns, grid preference, horizontal tabs, and minimizing work below the fold. | Define the landing page, visibility before Google connection, and exact settings navigation and Figma compositions. Do not combine separate settings concerns on one page or retain separate top-level administration destinations by inference. |
| G06 | Connect Google Workspace — **protocol defined, interaction partial** | DWD profile, identity checks, generated scopes, manual Admin Console approval, and capability diagnostics in [credentials](portfolio/phase-3-google-credentials.md), [connection](portfolio/phase-3-google-connection.md), and [GAM research](research/gam-onboarding-2026-09-13.md). | Define the actual steps, fields, instructions, waiting state, and finish destination. Decide which details belong in troubleshooting. The Figma Settings state is an access warning, not an onboarding wizard. |
| G07 | Customer settings — **organization confirmed, page behavior incomplete** | Historical [implementation record](portfolio/phase-3-customer-settings.md#settings-contract) defines a display name. Owner direction, 2026-09-17, separates Platform Settings from Provider settings, Platform Users, and other concerns under Settings. See [UI-11](ui/rules.md#ui-11--settings-organization-and-visible-work). | Define fields and actions within each concern, including sync configuration and preferences. Visible revisions, setup history, and save receipts remain unconfirmed. Separate pages do not establish their detailed behavior. |
| G08 | Remove access and handle staff changes — **technical behavior defined, interaction partial** | [Access](portfolio/phase-3-platform-access.md) and [revocation](portfolio/phase-3-revocation.md) describe disablement, grants, and session invalidation. | Define the user-facing disable/remove distinction, reenable path, last-administrator explanation, and treatment of work already running. No complete replacement workflow is approved by this audit. |
| G09 | Sign-in failure, expiry, and account recovery — **implemented behavior, incomplete product design** | OIDC, Redis sessions, and operator recovery in [Phase 2 implementation](portfolio/phase-2-implementation.md) and [access runbook](../deployment/bootstrap/APPLICATION-ACCESS.md). | Define what an unrecognized person sees, the return destination after sign-in, retained edits, and the help path. Missing product decisions differ from already-tested cookie/session mechanics. |
| G10 | Credential maintenance and diagnostics — **implementation exists, design partial** | [Lifecycle](portfolio/phase-3-credential-lifecycle.md) and [health](portfolio/phase-3-google-health.md) specify replacement, disconnect, scope health, and errors. | Where does routine connection status appear? Which actions belong in advanced settings? What should an administrator see when only one capability fails? Avoid placing credential internals throughout ordinary screens. |

## Remaining product and interaction gaps

| ID | Workflow and status | Defined source | Missing decision or design |
| --- | --- | --- | --- |
| G11 | Device browsing and lookup — **substantial design exists** | [Device inventory](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=94-3), [grid rules](ui/patterns.md#entity-grid), [field metadata](ui/entity-grid-fields.json). | Reconcile the historical separate lookup wording with the later filter-row design. Identify the exact first usable column/filter set. Do not redesign the grid from generic form patterns. |
| G12 | Saved filters and personal grid preferences — **named, incomplete lifecycle** | Saved filters appear in the [product scope](portfolio/01-product-brief.md#initial-product-scope). Field filters have worked examples. | Define save, rename, delete, default selection, ownership, and sharing. Define persistence for column order, width, visibility, sort, and density. |
| G13 | Device details and battery — **partial** | Device detail and telemetry states exist in [Figma](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=94-39). [Device model](portfolio/02-domain-model.md#devices-chromeos) names battery history. | Define which telemetry is actually available, chart range and units, sample gaps, and district thresholds. Prototype example percentages are not a completed measurement definition. |
| G14 | Edit device fields and bulk updates — **substantial design, remaining field rules** | Explicit [owner feedback](archive/ux/feature-review-notes-2026-09-03.md#dump-2--update-device-bulk-action-for-devices), [draft patterns](ui/patterns.md#draft-and-mutation), and Figma staged edits. | Resolve per-field blank/clear behavior, length validation, mixed values, and allowed Prepend/Update/Append modes. OU movement cannot inherit arbitrary text-edit modes. |
| G15 | Device commands and status changes — **design exists, method-specific details remain** | [Device actions](ui/patterns.md#device-actions), command and status Figma examples. | Select the exact supported actions for the first increment. Verify eligibility, reasons, expiry, and provider lifecycle. A command menu is not evidence that every command works on every device. |
| G16 | CSV round trip and explicit creation — **partial, dedicated design requested** | [Original owner request](archive/ux/feature-review-notes-2026-09-03.md#dump-3--round-trip-exportimport-edit-in-spreadsheet), comparison rules, and device import examples. | Set first supported fields, file limits, encoding, blank/clear semantics, mapping, malformed rows, baseline expiry, and conflict choices. Decide where create mode applies. Users CSV references do not provide a complete user-import workflow. |
| G17 | Jobs scheduling, failures, and results — **substantial design, gaps remain** | [Jobs grid](ui/jobs-grid.json), [Jobs patterns](ui/patterns.md#jobs-and-recovery), and Figma operation detail examples. | Define scheduling controls, timezone display, retry/reconcile interactions per action, and download content. Do not add Pause/Resume merely because cancellation exists. |
| G18 | Notifications — **technical channel defined, product surface partial** | [Architecture notifications](portfolio/03-architecture.md#notifications), job-result guidance in [UX](portfolio/04-ux-ui-spec.md#19-drafts-previews-and-result-truth). | Decide toast versus persistent inbox, unread state, which events need attention, retention, and navigation. Email is not a mandatory setup dependency. |
| G19 | Google Workspace user management — **partial visual coverage exists** | [User model](portfolio/02-domain-model.md#users), current Figma [Users page](https://www.figma.com/design/lqZx6qpWevsN3AAfWkworl/Campus-Commander?node-id=254-823). | The page covers inventory, details, suspension, OU edits, results, and states. Creation, password handoff, additional account actions, and CSV need complete workflows before implementation. These are Google accounts, not platform access. |
| G20 | OU management — **actions defined, complete visual flow missing** | [OU model](portfolio/02-domain-model.md#orgunits), TREE-01, and OU picker examples. | Design create, rename, move, delete, destination selection, counts, and effects on contained records. An OU picker is not an OU management screen. |
| G21 | Groups and memberships — **partial specification** | [Groups model](portfolio/02-domain-model.md#groups), [B4](portfolio/07-issues-and-opportunities.md#b-missing-requirements-gaps-in-the-specs). | Choose the exact Group Settings fields. Define membership role editing, direct/nested/external member presentation, search, and adding/removing members. Define group resource permissions rather than inferring them from email domains. |
| G22 | Fleet Status and reports — **scope named, composition incomplete** | Four initial inventory report topics in the [brief](portfolio/01-product-brief.md#initial-product-scope), [report requirements](portfolio/04-ux-ui-spec.md#20-search-reports-and-setup-acceptance). | Define report calculations, filters, date ranges, coverage, drill-through, export, and page layouts. AI dashboard generation and widget gallery remain separate deferred ideas. |
| G23 | Audit history — **separate settings concern confirmed, behavior incomplete** | [Audit architecture](portfolio/03-architecture.md#operations-audit-and-recovery) defines records. Owner direction, 2026-09-17, names Audit records as a separate page under Settings. See [UI-11](ui/rules.md#ui-11--settings-organization-and-visible-work). | Define audience, record coverage, filters, downloads, and Figma composition. Page placement does not authorize implementation or settle its contents. |
| G24 | Approval policy and externally owned fields — **unresolved product policy** | [Open questions 70 and 73](portfolio/05-decisions-and-open-questions.md#additional-review-gates), SIS ownership in the entity model. | Which actions need a second approver? Who can approve? Which SIS-controlled fields are read-only? Do not create approval queues or configurable policy editors without these decisions. |
| G25 | Refresh and synchronization controls — **technical design substantial, interaction partial** | [Synchronization architecture](portfolio/03-architecture.md#synchronization-and-effective-reads), refresh menus in Figma. | Define initial inventory progress, routine refresh messages, settings for schedules, and partial collection visibility. Distinguish record contact time from application synchronization time. |
| G26 | Localization, timezones, and responsive layouts — **partial** | [B11](portfolio/07-issues-and-opportunities.md#b-missing-requirements-gaps-in-the-specs), shared accessibility rules, desktop Figma screens. | State supported language and timezone behavior. Define narrow-screen adaptations for complex grids and detail views. Automated reflow checks do not supply an interaction design. |
| G27 | Help, onboarding completion, and empty states — **generic patterns only** | Shared empty/error rules, shell Help control, setup guidance. | Define the Help destination, first useful action after setup, empty-directory guidance, and capability-specific prerequisites. Avoid fake controls or unrelated diagnostic instructions. |

## Technical questions are a different queue

The [older question register](portfolio/05-decisions-and-open-questions.md#open-questions-and-validation-register) contains 75 numbered entries.
Many entries mix open designs, proposed settings, completed experiments, and obsolete release prerequisites.
Do not treat all 75 as current blockers or repeat old experiments to update their labels.

| Area | Relevant older entries | Treatment |
| --- | --- | --- |
| Grid and query integration | 15–19, 28, 69 | Resolve the exact contract needed for the first device workflow. Reuse existing qualification where applicable. |
| Jobs and worker behavior | 5–14, 31, 66–68 | Resolve while implementing the first real job. Retain the owner's explicit Redis admission policy. |
| Cache and provider reads | 20–25, 27, 30 | Resolve for the enabled entity collection. Empty live collections remain valid plumbing evidence. |
| CSV mechanics | 35–43 | Address after G16 supplies the intended workflow and supported file surface. |
| Authentication and credentials | 44–52, 65 | Reuse implemented security and the owner-selected DWD profile. Separate product gaps G01–G10 from protocol checks. |
| Storage, release, scale, and recovery | 32–34, 53–63, 67–68, 72, 74 | Historical or later operational work. No blanket prerequisite for UI development. Fresh installation still needs working configuration. |
| Reports, permissions, and usability | 70–71, 73, 75 | Resolve the relevant product entry above before engineering its policy. |

This grouping does not claim that every technical question remains open or that every historical test passed.
Current code and the relevant retained result establish implementation status for the task that needs them.

## Source conflicts and their disposition

| Finding | Evidence | Disposition in this reset |
| --- | --- | --- |
| Multiple documents claim to control execution. | Root README, portfolio README, phase handoff, delivery plan, current plan, and Jira criteria. | [Documentation start](README.md) and [current work](current-work.md) now control reading and execution. |
| "Invite-only" became a specific multi-step invitation product. | Older decision 17.7 versus the later invitation implementation record. | G01 is disputed. Historical wording does not settle delivery, redemption, or a second confirmation step. |
| School access became school creation and a standalone page. | Technical review C12/R12 versus CC-52's forms and route. | G03 is disputed. A business noun or permission scope does not require a management screen. |
| Background OAuth remains the default in older architecture text. | Architecture credential section and R09 versus the owner's DWD selection. | DWD is current. Older candidate-default language is superseded. |
| Trial promotion and phase upgrades conflict with greenfield direction. | Product brief deployment prose and R20/R22/R24. | No upgrade or development-data preservation work. Operational procedures remain reference material. |
| UI instructions permit skipping visual references. | UI README, AGENTS.md, prototype map, and UX section 17. | Screen implementation now requires inspection of the relevant Figma design. Missing composition stays explicit. |
| Design map omits existing Users work. | Figma page `240:2`, eighteen numbered Users frames and a start frame. | Add the page and coverage limits to the design map. Do not label Users entirely undesigned. |
| Settings is only an access-warning example in Figma. | Frame `106:383`: "Google connection is read-only" and "Contact your platform administrator." | Do not cite it as a designed settings, onboarding, invitation, or permission workflow. |
| Historical source references are incomplete. | The supersession table cites decisions 17.34/17.35. The indexed planning-review file ends at 17.18. | Do not invent their contents or infer a missing owner conversation. Use the actual 17.7 passage and record the limit. |
| Stale open statuses invite repeated qualification. | V0, phase records, and package TODO labels coexist with later results and owner phase acceptance. | Treat them as dated records. No automatic work begins from an old unchecked item. |
| An implementation record doubles as a specification. | Customer settings, invitations, and school documents mix behavior, commits, and tests. | Classify them as implementation history. Use a separate short agreed workflow only when needed. |
| Writing instructions point to a missing skill file. | AGENTS.md referenced `.opencode/skills/ste-writing-skill/SKILL.md`, which is absent. | Keep the writing rules directly in AGENTS.md. Use the skill when available without depending on the retired path. |

## Current owner corrections

These quotations come from the current task conversation on 2026-09-17. They override contrary historical interpretations.

> Phases are a convenance of development not some kind of path the user will take.

> There is NO migration and data safety we have to adhere to at this point. That will all be done AFTER we have an actual product to use.

> NOWHERE in the original planning did we talk about creating schools. No where did I specify some kind of user invitation system.

> I AM LETTING YOU ORGANIZE THE DOCS SO THIS DOESNT EVER HAPPEN AGAIN.

The third statement disputes the product scope. It does not authorize deleting security checks or replacing access with automatic enrollment.
The agent must obtain the actual intended workflow before implementing those product choices.

## Record a resolution here

For each resolved entry, record the decision, date, exact owner source, workflow link, and replaced behavior.
Do not change "disputed" to "owner-confirmed" because code exists, a test passed, or a Jira issue says Done.
The active discussion follows the [platform-access workflow](workflows/platform-access.md), beginning with G01.
Resolve related permission, resource, and placement decisions as needed. Later questions remain attached to their own tasks.
