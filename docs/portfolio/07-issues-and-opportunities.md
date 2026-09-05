# 07 — Issues and Opportunities

**Status:** review integrated 2026-09-05. This file distinguishes adopted design from remaining experiments and opportunities.

Current decisions live in [05](05-decisions-and-open-questions.md). Execution gates live in [06](06-work-breakdown.md).
Entries retain stable IDs for traceability. A resolved design gap does not establish implementation or test completion.
Keep feature opportunities separate from the first-release capability registry.

## A. Documentation integrity issues (found during portfolio assembly)

| # | Issue | Impact | Action |
|---|---|---|---|
| A1 | Framework versions conflicted. | Exact compatible set remains unverified. | Resolved documentation conflict: no release version is claimed. P0.1 qualifies Angular/Node/TypeScript/AG Grid/LibreGrid together. |
| A2 | Root-level projects conflicted with an `apps/` layout. | Duplicate scaffolding risk. | Resolved in 03 and root README: retain root-level paths. P0.1 scopes later cleanup. |
| A3 | Archived authentication guidance and Architecture A competed. | Incomplete credential exchange. | R09 replaces Architecture A. P3.1 must prove the default before P3.2. Archive remains historical. |
| A4 | Fixed scope counts conflicted across boards. | Incorrect onboarding instructions. | R10 uses the capability registry. Track 12 D-F updates actual boards. No fixed eight-scope requirement. |
| A5 | Decision status and authority were inconsistent. | Superseded instructions remained executable. | Resolved by 05 current decisions and supersession map. Portfolio 03 is authoritative. |
| A6 | Prototype cadence copy implied universal freshness. | Unverified synchronization promise. | R14 uses separate schedules and coverage. D-H updates stale and sync states. |
| A7 | Sign-out requires the security scope. | Capability authorization failure. | Preserve `admin.directory.user.security` when sign-out is enabled. P3.1 verifies registry-generated scopes. |
| A8 | Telemetry and reports require different scopes. | Missing telemetry despite report access. | Preserve `chrome.management.telemetry.readonly` for telemetry. Qualify Chrome reports separately. |

## B. Missing requirements (gaps in the specs)

| # | Gap | Why it matters | Candidate home |
|---|---|---|---|
| B1 | Batch editing lacked a durable draft contract. | Grid row eviction and live refresh lose work. | Direction resolved in 02/04. D-A designs interactions. P7.3 validates draft persistence and conflicts. |
| B2 | Update device field modes lacked rules. | Repeated append or unsupported field edits. | 02/04 restrict fields and compute final approved values. D-B completes design before P7.3. |
| B3 | Round-trip baseline and conflict semantics were missing. | Incorrect updates or implicit creation. | 02 defines stored baselines and B/E/C rules. D-C still requires its dedicated design session. P8.x validates. |
| B4 | **Group Settings field list is TBD.** Spec 1 says "exact field list TBD when this entity is implemented." The UI already shows join/post/moderation settings. | Agents cannot build the Groups settings UI against an unknown field list. | API verification spike before P11.1. |
| B5 | Two-role access did not define school and action boundaries. | Cross-school disclosure and writes. | R12 adopts permission grants and presets. P9.1 validates all data and mutation surfaces. |
| B6 | **Session and auth UX is unspecified.** The prototype has a Session Expired board and sign-in screens, but session lifetime, logout behavior, and account recovery have no requirements. | Security package P9.1 needs them. | Fold into P9.1 requirements (open questions 46, 49). |
| B7 | Global search was deferred. | Entity discovery missed the primary product goal. | R16 starts device lookup in Phase 4 and expands coverage in Phases 7–9. P5.1/P6.2 own implementation. |
| B8 | Capacity numbers lacked evidence. | Unsupported installation and scale claims. | 06 supplies provisional workloads, hardware experiments, and latency targets. Measurement remains open. |
| B9 | Test strategy and release gates were absent. | Recovery and permission proof arrived late. | 06 defines Phase 1–10 with applicable V0 prerequisites. The V0 report records partial local results. Full acceptance remains open. |
| B10 | Email infrastructure was undefined. | Setup depended on an unconfigured service. | In-app progress works without email. Optional district SMTP belongs to P3.2/P9.2. |
| B11 | **Localization is never mentioned.** Districts include non-English locales. The specs assume English-only implicitly. | Cheap to decide now, expensive to retrofit. | Owner decision: explicit English-only for v1 or reserve i18n. |
| B12 | Accessibility requirements were incomplete. | Controls and virtualized workflows lacked acceptance criteria. | R23 adopts WCAG 2.2 AA as an engineering target. D-G/P6.2 test keyboard, screen-reader, focus, and spacing. |

## C. Vague features (named but not specified)

| # | Feature | Vagueness | Next step |
|---|---|---|---|
| C1 | "Natural language reporting dashboard" (Spec 2) | Entirely undesigned. Only the privacy contrast with NL filtering is noted. | Out of v1 scope. Keep out of packages. No action. |
| C2 | "Widget gallery" (Spec 3) | Stretch goal, undesigned. | Same. |
| C3 | Optional language entry | Model failure, privacy, and query validation require evaluation. | P6.3 remains deferred. Deterministic filters work without it. |
| C4 | "Connection checks" in the command palette | The palette lists "Run connection checks" but no spec defines what it runs or where results land. | Tie to P3.3 diagnostics. Define or remove. |
| C5 | Device command lifecycle UI | Accepted requests do not establish executed commands. | P10.1 and D-H implement provider-backed lifecycle and unknown issuance handling. |
| C6 | Targeted refresh after mutations | Propagation and concurrent sweeps create conflicting observations. | R14 uses write overlays and effective reads. P4.1 validates reconciliation. |

## D. Earlier resolutions and their current disposition

| # | Contradiction | Resolution |
|---|---|---|
| D1 | Angular vs React | Angular. Decision 17.1. |
| D2 | Kestra vs BullMQ | Kestra only. Decision 17.16. |
| D3 | Credential alternatives | Earlier Architecture A is superseded by R09/R10. Default credential experiment remains open. |
| D4 | Undo promise vs stretch goal | Undo cut. Gate G1. Snackbar shows "View job" only. |
| D5 | Density | Compact default remains. R23 permits comfortable density when accessibility or usability evidence requires it. |
| D6 | Import cap versus district scale | 50,000 rows remains the initial qualification cap. Larger support requires P8 combined-load evidence in the relevant entity phase. |
| D7 | Incremental versus full synchronization | R14 retains full reconciliation and targeted reads. No universal delta stream is claimed. |
| D8 | Device command menu (Lock/Unlock/Sign out) vs spec | Menu restructured to Reboot, Wipe user data, Powerwash plus bulk actions. |
| D9 | Size-based file pipeline exception | R02/R07 require file artifacts for every mutation through local, shared filesystem, or object storage. |

## E. Opportunities

| # | Opportunity | Rationale |
|---|---|---|
| E1 | **GAM7 compatibility lens.** Many districts arrive from GAM. An "import your GAM command habits" mapping (common GAM commands → Campus Commander bulk actions) can anchor docs and onboarding copy. | Spec 1 already models GAM7 onboarding for the wizard. |
| E2 | **Backoff and freshness diagnostics.** Show observed errors, hold duration, queue age, and collection lag. | Supports reactive admission without estimating hidden Google quota balances. |
| E3 | **Dry-run mode for the entire sync.** The sweep design is simple enough to offer a "simulate sweep, list deltas" operator tool, which doubles as a test harness for mark-and-sweep deletion. | Reuses the sweep codepath. Strengthens P4.1 acceptance. |
| E4 | **Audit explorer.** Filter by actor, action, target, time, and job with authorized evidence access. | P2.3 includes the core audit surface. R21 retains permanent logical mutation evidence. |
| E5 | **Trial promotion guide.** Verify customer, remove samples, install production secrets, configure backup, and invalidate trial approvals. | Adopted in R20 and P9.2. Fresh production installation remains supported. |
| E6 | **Prototype acceptance reference.** Align boards with current written behavior and export component/state specifications. | Boards supplement permission, protocol, and recovery tests. They do not replace those tests. |
| E7 | **Battery health as a fleet report.** The time series exists for device detail. A district-level "battery replacement forecast" view is a natural Spec 2 dashboard widget candidate. | Data model already retains rollups. |
| E8 | **Bulk action templates.** Admins repeat the same bulk edits (start-of-year grade moves). Saving a previewed bulk action as a reusable template fits the existing select → preview → confirm chain with a persisted definition. | Extends the jobs manifest naturally. Watch blast radius. |
| E9 | **Deleted-user restore.** Cache soft-deleted users for the 20-day Google restore window with a visible countdown, and offer `users.undelete` as a guarded single action. | Groomed 2026-09-03 from T1-2 of `docs/archive/research/admin-sdk-gap-analysis.md`. A provider-specific restoration path. Fits the safety-chained product identity. |
| E10 | **Custom schema manager.** Read Directory `schemas.list/get` so district-defined custom fields (grade level, student ID) render as first-class grid columns. | Groomed 2026-09-03 from T1-5. Districts live in custom fields. Today the schema shape is invisible to the app. |
| E11 | **Chrome fleet reports.** Version distribution, hardware inventory, and attention reports through verified Chrome report methods. | Groomed opportunity. P6.4 distinguishes this connector from local inventory and telemetry. Scope follows enabled capability. |
| E12 | **User security panel.** Per-user view of OAuth tokens, ASPs, backup codes, and 2SV state (`tokens`, `asps`, `verificationCodes`, `twoStepVerification`). | Groomed 2026-09-03 from T1-7. Offboarding and incident response. Uses the `admin.directory.user.security` scope added by S1. |

## F. API opportunity catalog (folded from the Admin SDK gap analysis)

Folded 2026-09-03 from `docs/archive/research/admin-sdk-gap-analysis.md` (archived. The full API inventory with primary-source citations lives there). Constraint facts moved to `03-architecture.md` Appendix A. Opportunities E9-E12 graduated from Tier 1 in the same pass. Everything below is catalog, not commitment. Feature expansion requires a recorded scope decision before implementation.

### Tier 1 — not yet graduated

| # | Opportunity | API surface | Note |
|---|---|---|---|
| F1 | Device command catalog expansion | Candidate commands beyond Reboot, Wipe user data, and Powerwash | Verify endpoint, license, privacy, and safety requirements before adopting. Core execution infrastructure is still TODO. |
| F2 | Command status backing | `customer.devices.chromeos.commands.get` | Correct backing for P10.1 per-device lifecycle tracking |
| F3 | Alias and photo management | `users.aliases` (write), `users.photos` | Round out the user record. Alias writes slot into the bulk catalog trivially |
| F4 | Fast fleet counts | `customer.devices.chromeos.countChromeOsDevices` | Google-side truth for the Devices status bar and OrgUnit counts where the cache is stale |

### Tier 2 — major capability areas (Spec 2 candidates)

| # | Opportunity | API surface | Note |
|---|---|---|---|
| F5 | Chrome policy management | `chrome.management.policy`: `policies.resolve`, `batchModify`, `batchInherit`, group priority ordering, networks/certificates, `policySchemas.list` | A whole new entity type with inheritance semantics. Natural Spec 2 flagship |
| F6 | Mobile device management (Android/iOS) | Directory `mobiledevices`: list (page max 100), wipe actions, delete | A fourth device fleet. Verify the mobile scope and Google's retirement posture first |
| F7 | Chrome browser fleet management | `admin.directory.device.chromebrowsers` (v1.1beta1): list, annotate, move OU (max 600/call), delete | Same grid, selection, and pipeline. Beta surface and 1-hour page tokens argue for waiting for GA |
| F8 | License management | Enterprise License Manager (`apps.licensing`): assign/revoke Education licenses in bulk | A license/device reconciliation view requires verified licensing data and joins |
| F9 | Printer management | Chrome Printer Management API (`admin.chrome.printers`): printers, print servers, native batch endpoints | Lower urgency than licenses |
| F10 | Google external audit ingestion | Reports API and `admin.reports.audit.readonly` | Separate connector with verified source windows, delay, gaps, identity, and retention. Local audit does not cover external actions. |
| F11 | Data transfer on offboarding | Data Transfer API: Drive/Gmail ownership transfer inside the suspend/delete flow | Turns the delete preview into an offboarding wizard. Sensitive. Needs its own safety design |

### Tier 3 — noted, not recommended now

| # | Opportunity | API surface | Why not now |
|---|---|---|---|
| F12 | Cloud Identity dynamic groups, transitive membership search | `cloud-identity.groups` | A second group API mid-v1 adds confusion. Revisit for Spec 2 |
| F13 | Cloud Identity all-device surface | `cloud-identity.devices` | Scopes marked "Private Service" in discovery. Governance risk. Prefer `mobiledevices` until clarity improves |
| F14 | Telemetry alert subscriptions | `customers.telemetry.notificationConfigs` and Google Cloud Pub/Sub | Pull delivery avoids an inbound webhook. Keep optional and qualify its service cost, authorization, and recovery. |
| F15 | Browser profile management | `customers.profiles` + `commands` | Niche. Revisit with F7 |
| F16 | Security Insights queries | `chrome.management.securityinsights` | Privacy-sensitive (URL visits, content transfers). Needs its own policy conversation first |
| F17 | Directory push channels | Verify supported watch methods and scopes | Requires reachable HTTPS delivery. Polling remains default. This does not establish the delivery model of other Google APIs. |

For reference, the archived gap analysis also documents the full Admin SDK surface we do not touch today: Directory resources (`undelete`, `schemas`, `domains`, `roleAssignments`, `resources.calendars`, `asps`, `tokens`, `mobiledevices`), the Reports API resources, the complete Chrome Management v1 surface, the Chrome Policy API, the Enterprise License Manager, the Chrome Printer Management API, the v1.1beta1 browser and enrollment-token APIs, the Data Transfer API, and the Cloud Identity API.

## Grooming rules

- The owner grooms this file. Agent discoveries land here with date and source.
- Groomed decisions move to [05](05-decisions-and-open-questions.md#current-decisions) with a date.
- Groomed features move to `06-work-breakdown.md` as packages (usually via a Track 12 design item first).
- Preserve entry IDs. Replace resolved descriptions with current status and a link or identifier for the adopted decision.


## Review integration map

The owner authorized C01–C20 integration on 2026-09-05.
This map identifies current planning homes. Runtime implementation and validation remain open in the linked packages.

| Change | Current design home | Delivery or evidence gate |
|---|---|---|
| C01 — customer identity | 01 tenancy, 02 identity, 03 customer model, R08 | P1.1/P3.1 multi-domain account tests |
| C02 — credentials | 03 connection/capability registry, R09/R10 | P3.1 proof before P3.2 wizard |
| C03 — retained orchestration and durability | 02 job vocabulary, 03 jobs, R03/R11 | P2.1/P2.2 all-settled recovery |
| C04 — immediate evidence and file storage | 03 dispatch/job storage, R02/R07/R11 | P2.4 local publication and shared-backend qualification |
| C05 — Redis recovery | 03 selections/notifications/operations, R13/R15 | P5.2 manifest independence and P9.3 recovery |
| C06 — job admission | 03 Redis admission, R04–R06 | P2.1/P2.2 owner overwrite, cleanup, TTL, aggregation |
| C07 — sync publication | 03 generation publication, R14 | P4.1 partial enumeration and concurrent-write tests |
| C08 — freshness coverage | 01 insight, 02 observations, 03 schedules, 04 states | P4.1/P6.4 membership/settings and coverage evidence |
| C09 — LibreGrid | 03 retained stack, 04 grid contract, R01 | P6.2/P7.3 row model, selection, drafts, accessibility |
| C10 — early search and optional AI | 01 scope, 03 queries, 04 search, R16 | P5.1 starts in Phase 4. P6.4 delivers the Phase 10 dashboard. P6.3 remains deferred. |
| C11 — export baseline and streaming | 02 import rules, 04 result/expiry states, R18 | D-C/P8.x, merge and large-file qualification |
| C12 — scoped permissions | 01 presets, 03 grants, R12 | P9.1 starts in Phase 2 and adds delegated access in Phase 3 before entity workflows. |
| C13 — deployment profiles | 01 profiles, 03 installation, R19 | P9.2/P9.4 external services and district qualification |
| C14 — retention classes | 03 audit/operations, 04 expiry, R21 | P9.3 district policy and archive restore |
| C15 — trial and production | 01 deployment, 03 setup/promotion, 04 setup, R20 | P3.1/P9.2 and novice study |
| C16 — early security, recovery, and tests | 05 R22/R24, 06 Phase 1–10 and relevant V0 failure gates | P9.1/P9.3 expand with each phase before its protected state or mutations ship. |
| C17 — migration policy | 03 recovery/upgrade, R22, 06 P1.2 | Expand/contract compatibility and restore tests |
| C18 — authority and delivery process | Portfolio index, 05 process, 06 Phase 1–10 | Definition of ready/done and supersession evidence |
| C19 — accessibility | 04 controls/grid viewport, R23 | D-G/P6.2 complete workflow testing |
| C20 — Classroom boundary | 01 exclusions, 02 catalog, 04 safety, R25 | P7.2 has no unsupported Classroom warnings |

The review also defines draft editing in section 10.2 and capacity qualification in section 14.
Those requirements live in 02/04/P7.3 and the workload appendix of 06, respectively.

## Remaining review blockers

| ID | Unverified requirement | Owner and next evidence |
|---|---|---|
| R-B1 | Default credential exchange and enabled-method coverage | Connection lead, P3.1 |
| R-B2 | Durable duplicate dispatch and ambiguous outcome recovery | Jobs lead, P2.1. Local Kestra all-settled mapping passed. Restart and durable correlation remain open. |
| R-B3 | Job-service aggregation and admission reservation recovery | Jobs lead, P2.1. Redis ownership and atomic local gate passed. Multi-instance transitions remain open. |
| R-B4 | Shared backend and Kestra internal-storage compatibility | Phase 1 gate. Storage lead, P2.4/P9.4. Local experiments do not qualify distributed storage. |
| R-B5 | Enterprise Kestra availability without an unapproved commercial dependency | Deployment lead, P9.4. Establish supported placement and recovery in Phase 1. Extend fault evidence in Phase 5. |
| R-B6 | Scoped search, numeric grid ranges, overlays, and combined-load latency | Data/frontend leads, P4.1/P5.1/P6.2. Narrow million-row SQL spike passed. Full workload remains open. |
| R-B7 | District retention, recovery-point gap, and independent evidence requirements | Operations/security leads, P9.3 |
| R-B8 | Novice setup and accessibility results | UX lead, P9.2 and Track 12 |

The integration resolves document contradictions. It does not close these empirical requirements.

The [V0 report](../validation/v0-2026-09-05/README.md) records experiment scope and evidence.
The [technical findings](../validation/v0-2026-09-05/technical-findings.md) add compiler correction, Compose replacement, and durable assignment deduplication requirements.

## Ten-phase development update

The owner replaced the earlier delivery sequence with ten cumulative working releases in [06](06-work-breakdown.md#delivery-sequence).
All three deployment modes now belong to Phase 1. Shared storage and Kestra deployment qualification move with that requirement.
Phase 3 platform user management is distinct from Phase 7 Google user management.
Phase 4 needs background read synchronization before Phase 5 supplies the complete mutation JobService.
Device experience acceptance in Phase 6 gates later entity feature implementation.
Full OU management follows Users. Groups and memberships follow OUs. Fleet Status and reports arrive in Phase 10.
Device CSV in Phase 6 remains a proposed allocation of retained scope.
