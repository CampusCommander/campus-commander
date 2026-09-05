# Admin SDK Deep Dive — API Surface, Coverage, and Opportunities

Research date: 2026-09-03. Method: the full REST reference pages on developers.google.com plus Google's own discovery documents (`$discovery/rest` endpoints), which are the machine-readable source of truth for methods, pagination, and scopes. Companion to `google-api-quotas.md` (quota facts). Every claim below carries a source. Numbers not published by Google are marked **unconfirmed**.

This file answers three questions: what does the API family offer, what does Campus Commander already address, and where do the opportunities sit. It is analysis. New work items graduate into `07-issues-and-opportunities.md` and `06-work-breakdown.md` only after the owner grooms them.

## 1. What Campus Commander addresses today

From `../portfolio/02-domain-model.md` and `../portfolio/06-work-breakdown.md`:

| Capability area | APIs used | Features addressed |
|---|---|---|
| Users | Directory `users` | List/get/update, bulk suspend, reactivate, force password reset, move org unit, archive/unarchive, force sign-out, create (form + import), aliases cached read-only |
| Devices (ChromeOS) | Directory `chromeosdevices`, `customer.devices.chromeos`, Chrome Management Telemetry | List, annotate, move org unit, batch status change (disable, re-enable, deprovision), remote commands (REBOOT, WIPE_USERS, REMOTE_POWERWASH), battery health telemetry |
| Groups | Directory `groups` + `members`, Groups Settings API | CRUD, membership add/remove, role and delivery settings, join/post/moderation policy |
| OrgUnits | Directory `orgunits` | Tree CRUD, reparent, delete-with-contents flow, computed counts from cache |
| Connection | OAuth + DWD, eight scopes (see Section 2) | Architecture A: customer OAuth client, designated Super Admin, per-area health diagnostic |

The wizard scope list (`../portfolio/03-architecture.md`): `admin.directory.user`, `admin.directory.device.chromeos`, `admin.directory.orgunit`, `admin.directory.group`, `groups.settings`, `chrome.management.reports`.

## 2. Two scope corrections (action required)

The deep dive surfaced two verified scope errors in the current list. Both break v1 features as documented.

**S1. Force sign-out needs a scope we do not request.** `users.signOut` requires `admin.directory.user.security`, confirmed at https://developers.google.com/admin-sdk/directory/reference/rest/v1/users/signOut. The v1 bulk catalog includes force sign-out (Spec 1, Users). The wizard list has only `admin.directory.user`. Fix: add `admin.directory.user.security` to the DWD scope list in the wizard, the Penpot Connection board, and `03-architecture.md`.

**S2. The Telemetry area needs `chrome.management.telemetry.readonly`, not `chrome.management.reports`.** `customers.telemetry.devices.list` requires `https://www.googleapis.com/auth/chrome.management.telemetry.readonly`, confirmed at https://developers.google.com/chrome/management/reference/rest/v1/customers.telemetry.devices/list. The scope we request, `chrome.management.reports.readonly`, unlocks the `customers.reports.*` fleet-report endpoints (a different feature set). Fix: either swap the scope or request both. The correct pairing per capability area: Devices Telemetry → `chrome.management.telemetry.readonly`. The fleet reports below (Section 4.3) are the feature `chrome.management.reports.readonly` actually unlocks.

Both belong in `07-issues-and-opportunities.md` as documentation-integrity issues at the next grooming pass.

## 3. The full Admin SDK surface (beyond our five areas)

### 3.1 Directory API resources we do not touch

Source: https://developers.google.com/admin-sdk/directory/reference/rest and the `directory_v1` discovery document.

| Resource | What it does | Relevance to districts |
|---|---|---|
| `users.undelete` | Restore a deleted user within a 20-day window (guide) | High. Undo for the riskiest admin action |
| `users.makeAdmin` | Grant Super Admin rights | Excluded from bulk tooling by design decision. Candidate as a guarded single action only |
| `users.photos` | Read/update/delete profile photos | Medium. Bulk photo upload from SIS exports is a common district ask |
| `users.aliases` (write) | Insert/delete user aliases | Medium. We cache aliases but never write them |
| `users.watch`, `aliases.watch` | Push channels for user changes | Requires a public webhook. Rejected for v1 (polling only) |
| `users.createGuest` | Create guest accounts | Low |
| `asps` | Application-specific passwords: list/delete | Security audit surface |
| `tokens` | Third-party OAuth grants per user: list/delete | Security audit surface. Token hygiene for offboarding |
| `verificationCodes` | Generate/invalidate/list 2SV backup codes | High during enrollment season |
| `twoStepVerification.turnOff` | Turn off 2SV for a user | Security remediation surface |
| `schemas` | CRUD custom user schema definitions | High. Districts define grade level, student ID fields. We write `customSchemas` values but cannot read the schema definitions that drive them |
| `domains`, `domainAliases` | Domain inventory and aliases | Low-medium. Read-only context for the user picker |
| `mobiledevices` | Android/Google Sync/iOS device fleet: list (page max 100), action (wipe, cancel wipe), delete | High. iPad and Android carts live here. Not deprecated in the REST reference (unconfirmed retirement) |
| `customers` | Account metadata | Low |
| `privileges`, `roles`, `roleAssignments` | Delegated admin role inventory and assignment | Medium. Read-only mapping view strengthens the RBAC story |
| `resources.calendars`, `.buildings`, `.features` | Shared room and resource calendars | Low for v1 |

### 3.2 Directory API corrections and constraints on covered surfaces

- `chromeosdevices.action` is **deprecated** in the REST reference. Its replacement, `customer.devices.chromeos.batchChangeStatus`, is already our chosen path. No change needed.
- `moveDevicesToOu` accepts **up to 50 devices per call** (method page + discovery). Our chunk size is 1000. Workers must sub-chunk moves at 50. This is a design implication for P7.2, not a gap.
- `customer.devices.chromeos` also offers `countChromeOsDevices` (fast fleet counts) and `commands.get` (async command result retrieval). `commands.get` is the correct backing for the per-device command lifecycle in P10.1.
- `issueCommand` supports more command types than our three: `TAKE_A_SCREENSHOT`, `SET_VOLUME`, `CAPTURE_LOGS`, `FETCH_SUPPORT_PACKET`, `DEVICE_START_CRD_SESSION`, `FETCH_CRD_AVAILABILITY_INFO` (discovery enum `DirectoryChromeosdevicesIssueCommandRequest.commandType`). All are candidates for the device command menu.
- `members.hasMember` reports direct-or-nested membership but returns only a boolean, not the member record. Trivial, worth knowing.
- `users.list` full-field reads need `viewType=admin_view`.

### 3.3 Reports API (Admin SDK `reports_v1`)

Source: https://developers.google.com/admin-sdk/reports/reference/rest, discovery `reports_v1`, limits at https://developers.google.com/admin-sdk/reports/v1/limits (2,400 QPM/user/project default).

| Resource | What it does | Scope needed |
|---|---|---|
| `activities.list/watch` | Admin activity audit across 35+ application namespaces (admin, drive, login, token, saml, chrome, classroom, and more) | `admin.reports.audit.readonly` |
| `customerUsageReports` | Domain-wide daily usage per service (accounts, classroom, cros, drive, gmail, meet) | `admin.reports.usage.readonly` |
| `userUsageReport` | Per-user daily usage, filterable by org unit and group | `admin.reports.usage.readonly` |
| `entityUsageReports` | Entity-level usage. The published appendix covers G+ communities only. Other entity types are **unconfirmed** | `admin.reports.usage.readonly` |

Audit retention: 180 days maximum lookback for `activities.list` (parameter description, same reference). Our own audit trail is permanent but covers only actions taken through Campus Commander. Google's audit log covers actions taken in the Admin Console by anyone. These are complementary, not duplicates.

### 3.4 Chrome Management API (full v1 surface)

Source: https://developers.google.com/chrome/management/reference/rest, discovery `chromemanagement v1`.

| Resource group | What it does | Scope |
|---|---|---|
| `customers.reports.*` | 16 fleet reports: active devices, devices needing attention, devices reaching auto-expiration date, hardware fleet, Chrome versions, release channels, boot types, crash events, installed apps, print jobs by printer/user, app requesters | `chrome.management.reports.readonly` |
| `customers.apps.*` | App details per platform (Android, Chrome, Web), extension-install requests by device and user | `chrome.management.appdetails.readonly` |
| `customers.telemetry.*` | Devices, users, events, notification configs (alert subscriptions) | `chrome.management.telemetry.readonly` |
| `customers.profiles` + `commands` | Managed Chrome browser profiles and remote commands on them | `chrome.management.profiles` |
| `customers.enterprise.securityInsights` | Content transfer and URL visit queries | `chrome.management.securityinsights` |
| `customers.connectorConfigs`, `certificateProvisioningProcesses` | Insights connectors, certificate lifecycle | Scopes **unconfirmed** in discovery |

Corrections from the sweep: `customers.chromiumapps` and `customers.reports.assignApp` do not exist in the current v1 or v1alpha1 discovery. Platform app-detail resources are `android`, `chrome`, `web` only. There is no `apps.windows`.

Telemetry prerequisite: reporting policies must be enabled for the org (https://support.google.com/chrome/a/answer/11230542). Chrome Education/Enterprise Upgrade gating is enforced per Admin Help, not per API reference.

### 3.5 Chrome Policy API (`chromepolicy.googleapis.com`)

Source: https://developers.google.com/chrome/policy/reference/rest, discovery `chromepolicy v1`, schema guide https://developers.google.com/chrome/policy/guides/policy-schemas. Scope: `chrome.management.policy`.

| Method | What it does |
|---|---|
| `policies.resolve` | Effective policy set for an org-unit or group target, with per-value inheritance state. Page default 100, max 1000 |
| `policies.orgunits.batchModify` / `batchInherit` | Set or revert policy values per org unit. Inheritance follows the OU tree |
| `policies.groups.batchModify` / `batchDelete`, `listGroupPriorityOrdering`, `updateGroupPriorityOrdering` | Group-targeted policy with priority ordering |
| `policies.networks.defineNetwork/removeNetwork/defineCertificate/removeCertificate` | Network and certificate deployment |
| `policySchemas.list/get` | Discover the full policy namespace tree (`chrome.users.*`, `chrome.devices.*`, `chrome.printers.*`) |

This is the programmatic equivalent of the Admin Console's Chrome policy pages. It manages Chrome and ChromeOS policy only, not Workspace settings. Nothing in Campus Commander touches it today.

### 3.6 Adjacent Admin SDK APIs

| API | What it does | Scope | Source |
|---|---|---|---|
| Chrome Printer Management API | Printers, print servers, printer models: full CRUD incl. `batchCreatePrinters`/`batchDeletePrinters` | `admin.chrome.printers` | https://developers.google.com/admin-sdk/chrome-printer/reference/rest |
| Enterprise License Manager API | License assignments per product/SKU: insert, update, patch, delete, list | `apps.licensing` | https://developers.google.com/admin-sdk/licensing/reference/rest |
| Chrome Enterprise Core API (v1.1beta1) | Cloud-managed Chrome browser fleet: list/get/annotate/delete, `moveChromeBrowsersToOu` (max 600 per call). Page max 100, `nextPageToken` lives 1 hour | `admin.directory.device.chromebrowsers` | https://support.google.com/chrome/a/answer/9681204 |
| Chrome Enrollment Token API (v1.1beta1) | Browser enrollment tokens: list, revoke. `CHROME_BROWSER` token type only | **unconfirmed** | https://support.google.com/chrome/a/answer/9949706 |
| Data Transfer API | Transfer user data (Drive, Gmail ownership) between users on offboarding | Data Transfer scope family | https://developers.google.com/admin-sdk/data-transfer/reference/rest |
| Alert Center API | Google-generated security and ops alerts: list, batch delete/undelete | Alert Center scopes | https://developers.google.com/admin-sdk/alertcenter/reference/rest |

The `chromelicensing.googleapis.com` endpoint named in some older material has no published discovery document or REST reference (absent from https://www.googleapis.com/discovery/v1/apis). Treat it as unavailable. The Enterprise License Manager API above is the documented licensing surface.

### 3.7 Cloud Identity API (not Admin SDK, adjacent)

Source: https://cloud.google.com/identity/docs/reference/rest, discovery `cloudidentity v1`.

- `groups` superset: dynamic group metadata, transitive membership search, membership graph. Scope `cloud-identity.groups`.
- `devices`: all enrolled devices including Android/iOS under modern management, with wipe and device-user approval flows. Scopes marked "Private Service" in discovery, a governance risk. Scope `cloud-identity.devices`.
- `inboundSsoAssignments`, SAML/OIDC profile management. Scope `cloud-platform`.

## 4. Opportunity analysis

Graded against the product thesis: K-12 district admins, bulk-first, safety-chained, cached reads. Tier 1 fits the current architecture with small surface additions. Tier 2 is a major new capability area. Tier 3 is speculative or out of thesis.

### Tier 1 — high fit, natural extension of v1

| # | Opportunity | API surface | Why it fits |
|---|---|---|---|
| T1-1 | **Scope-list corrections S1 + S2** (Section 2) | `admin.directory.user.security`, `chrome.management.telemetry.readonly` | Fixes two broken v1 features before any code is written |
| T1-2 | **Deleted-user restore** as a first-class flow. Cache soft-deleted users for 20 days with the Google restore deadline as a countdown | `users.undelete` | The only undo Google gives us. Pairs with our mark-and-sweep deletion. Fits the safety-chained product identity exactly |
| T1-3 | **Device command catalog expansion** in the device command menu | `issueCommand` enum: screenshot, set volume, capture logs, fetch support packet, CRD session | Each is a classroom-helpdesk staple. The jobs pipeline and command lifecycle tracking already exist |
| T1-4 | **Command status via `commands.get`** wired into job detail and device detail | `customer.devices.chromeos.commands.get` | P10.1 already specifies lifecycle tracking. This is the backing call |
| T1-5 | **Custom schema manager**: read schema definitions so the grid can render district-defined fields as first-class columns | `schemas.list/get` | Districts live in custom fields (grade level, student ID). Today the schema shape is invisible to the app |
| T1-6 | **Fleet reports dashboard**: devices needing attention, auto-expiration countdown, version distribution, hardware fleet | `customers.reports.*` (scope we already request) | The scope is already in the wizard list and currently unlocks nothing. Auto-expiration ties directly to `supportEndDate` in the device cache |
| T1-7 | **User security panel** in user detail: active OAuth tokens, ASPs, backup codes, 2SV state | `tokens`, `asps`, `verificationCodes`, `twoStepVerification` | Offboarding and incident response. One extra scope (`user.security`) after S1 |
| T1-8 | **Alias and photo management** | `users.aliases` (write), `users.photos` | Round out the user record. Alias writes slot into the existing bulk catalog trivially |
| T1-9 | **Fast fleet counts** for the Devices status bar and OrgUnit counts | `countChromeOsDevices` | Replaces derived counts with Google-side truth where the cache is stale |

### Tier 2 — major capability areas (spec-2 candidates)

| # | Opportunity | API surface | Why it is bigger than a package |
|---|---|---|---|
| T2-1 | **Chrome policy management**: browse policy schemas, resolve effective policy per OU, batch modify/inherit, group priority ordering | `chrome.management.policy` | A whole new entity type (policies) with inheritance semantics. Natural Spec 2 flagship alongside the reporting dashboard |
| T2-2 | **Mobile device management (Android/iOS)**: grid, wipe, account wipe, delete | `mobiledevices` | A fourth device fleet. Page size caps at 100, so sweep cost is high. Districts ask constantly. Verify the mobile scope and Google's retirement posture first |
| T2-3 | **Chrome browser fleet management**: the CEC browser device as a fifth entity type | `admin.directory.device.chromebrowsers` (v1.1beta1) | Same grid, same selection, same jobs pipeline. Beta surface and a 1-hour page token argue for waiting for GA |
| T2-4 | **License management**: assign/revoke Education and Chrome licenses in bulk, license-vs-device reconciliation | Enterprise License Manager (`apps.licensing`) | Every district juggles license counts. A reconcile view (devices without licenses, licenses without devices) is a killer feature and pure cache work |
| T2-5 | **Printer management**: bulk printer and print-server deployment across schools | Chrome Printer Management API | Batch endpoints exist natively. Lower urgency than licenses |
| T2-6 | **Google audit ingestion**: pull `activities.list` (admin, login, token, saml, chrome) into our audit view with 180-day lookback | `admin.reports.audit.readonly` | Completes the audit story: our permanent trail for app actions, Google's trail for everything else. One merged timeline |
| T2-7 | **Data transfer on offboarding**: as part of the suspend/delete flow, offer Drive/Gmail ownership transfer | Data Transfer API | Turns the delete preview into an offboarding wizard. High value, sensitive, needs its own safety design |

### Tier 3 — noted, not recommended now

| # | Opportunity | API surface | Why not now |
|---|---|---|---|
| T3-1 | Cloud Identity dynamic groups and transitive membership search | `cloud-identity.groups` | Overlaps Directory groups. Real value, but a second group API mid-v1 adds confusion. Revisit for Spec 2 |
| T3-2 | Cloud Identity all-device surface (modern Android/iOS) | `cloud-identity.devices` | Scopes are "Private Service" in discovery. Governance risk. Prefer `mobiledevices` until clarity improves |
| T3-3 | Telemetry alert subscriptions | `customers.telemetry.notificationConfigs` | Depends on Google-side notification delivery, which our firewalled install cannot host. Our own alerting covers this |
| T3-4 | Browser profile management and profile remote commands | `customers.profiles` | Niche. Revisit with T2-3 |
| T3-5 | Security Insights queries | `chrome.management.securityinsights` | Privacy-sensitive (URL visits, content transfers). Needs its own policy conversation before any design |
| T3-6 | Push channels (`users.watch`) | `cloud-platform` + public webhook | Already rejected for v1 for firewalled deployments. No new information changes that |
| T3-7 | `users.watch`-adjacent live updates for groups | same | Same rejection |

## 5. Feasibility constraints that shape these choices

From `google-api-quotas.md` plus this sweep:

- `moveDevicesToOu` caps at 50 devices per call. Move jobs sub-chunk at 50 inside the 1000-record chunk.
- `mobiledevices.list` caps at 100 per page. A 10k-device mobile sweep is 100 calls. Budget against the shared 2,400 QPM Directory allowance.
- CEC browser list caps at 100 per page with a 1-hour `nextPageToken` lifetime. Sweeps must run without long idle gaps.
- Groups Settings has no list endpoint and a 100k/day quota. Settings sweeps pace across days at large group counts.
- Chrome Management quotas are unpublished. Read the project's real numbers from the Cloud console at install time.
- The 429 concurrency limit is per Workspace customer account and cannot be raised. Every feature above inherits our per-customer concurrency ceiling.
- Audit lookback is 180 days for Google-side events. Copy that limit in the UI wherever Google audit data is shown. Our own job audit stays permanent.

## 6. Disposition

Updated 2026-09-03 after the grooming pass. The grooming rules in `../portfolio/07-issues-and-opportunities.md` govern what happens next:

1. **S1 and S2 are integrity issues, not opportunities.** Groomed 2026-09-03. The corrected eight-scope list lives in `../portfolio/03-architecture.md` and the decision in `../portfolio/05-decisions-and-open-questions.md`. Both are recorded as resolved issues A7 and A8 in `07`.
2. **Four Tier 1 items graduated.** T1-2 (user restore), T1-5 (schema manager), T1-6 (fleet reports), and T1-7 (security panel) are now opportunities E9-E12 in `07`. They are not packages. No code starts without a further owner go-ahead.
3. **Tier 2 items stay in this file.** They are Spec 2 material until the owner opens that roadmap.
4. **Tier 1 items that did not graduate (T1-1, T1-3, T1-4, T1-8, T1-9) stay in this file.** T1-1 (the scope corrections) is done. T1-3, T1-4, T1-8, and T1-9 remain candidates for a future grooming pass.
