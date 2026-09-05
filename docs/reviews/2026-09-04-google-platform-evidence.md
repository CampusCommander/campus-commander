# Google platform evidence for the architecture review

> Integration update, 2026-09-05: the [design portfolio](../portfolio/README.md) incorporates this review and subsequent owner decisions.
> Use the portfolio for current planning and package status. This document preserves review evidence and rationale.

> Review update: the owner retains LibreGrid and Redis. Kestra remains the orchestration baseline.
> The [accepted job admission policy](2026-09-04-job-admission-policy.md) governs worker backoff and job-service admission holds.
> Other product changes remain contractor proposals. Queue alternatives below are comparisons, not selected replacements.

Research date: 2026-09-04. Primary sources: current Google protocol, API, and administrator documentation.

This review covers Google integration constraints. It does not certify a deployment or report results from a district test account.

The reviewed baseline includes `docs/portfolio/01-product-brief.md`, `docs/portfolio/03-architecture.md`, and the archived quota and API-gap research.

## Findings that block implementation

1. Replace the current connection model. It does not describe a complete credential exchange.
2. Retain greedy worker backoff and add job-service admission holds by job type.
3. Define the tenant as a Workspace customer account, not an email domain.
4. Separate accepted changes from confirmed Google state and completed device commands.
5. Replace universal hourly membership and settings freshness with a measured synchronization budget.
6. Establish durable per-item intent before each mutation. Record outcomes before reporting completion.

Item 2 follows the accepted owner decision. Other items remain contractor recommendations.
The sections below separate verified Google behavior, accepted decisions, and proposed product changes.

## 1. Credentials: the current combination is incomplete

**Verified fact.** Google's service-account delegation flow signs an assertion with a service-account identity and names the impersonated user. The OAuth server exchanges that assertion for an access token. Google permits access-token reuse until expiration. Delegated access depends on both the impersonated user's permissions and authorized scopes. [Google service-account OAuth protocol](https://developers.google.com/identity/protocols/oauth2/service-account).

**Verified fact.** The web-server OAuth flow requests API scopes and offline access. It stores a refresh token for unattended operation. Redirect addresses require HTTPS, except localhost. Google rejects non-localhost raw IP addresses. [Google web-server OAuth protocol](https://developers.google.com/identity/protocols/oauth2/web-server).

**Finding.** Architecture A combines an ordinary OAuth client secret, identity-only consent, impersonation, and no persistent credentials. Neither documented protocol supplies that combination. Registering a client in the delegation console does not supply the missing signing identity or refresh credential.

Google's delegation console accepts service-account IDs and OAuth client IDs. Therefore, the error is not the statement that OAuth clients receive delegation authorization. The error is the absent runtime authentication path. [Google delegation administration](https://knowledge.workspace.google.com/admin/apps/control-api-access-with-domain-wide-delegation).

**Proposed default.** Use web authorization-code OAuth with the actual API scopes and an encrypted offline refresh token. Connect a dedicated delegated admin identity. Keep application sign-in separate from the Workspace connection. Require the installation experiment before finalizing this default.

Use a district-owned project and internal audience for district-only use. Google documents an internal-use exception from further sensitive-scope review. External distribution follows different requirements. [OAuth consent configuration](https://developers.google.com/workspace/guides/configure-oauth-consent).

Reject an external Testing configuration for unattended production. Google issues seven-day refresh tokens for that configuration when scopes extend beyond basic identity. Handle revocation and policy restrictions as explicit connection failures. Avoid unnecessary Cloud Platform scopes, which introduce Cloud session-control concerns. [OAuth token lifecycle](https://developers.google.com/identity/protocols/oauth2).

| Profile | Runtime credential | Installation effect | Required validation |
|---|---|---|---|
| Default district OAuth connection | Encrypted offline refresh token for a dedicated admin identity | Removes service-account signing setup | Test all capability scopes, restart, revocation, rotation, and actor departure |
| Enterprise service-account connection | Service-account credentials with explicitly assigned privileges or delegation | Supports organization-managed workload identity | Test direct roles first and delegated exceptions second |

Use a dedicated admin identity with the minimum demonstrated privileges. Do not require permanent Super Admin impersonation as the untested default. Record exceptional operations that require stronger privileges. Offer read-only connection before write capabilities.

**Verified alternative.** Google documents direct admin role assignment to service accounts. Chrome Telemetry also explicitly supports this model. [Directory role management](https://developers.google.com/workspace/admin/directory/v1/guides/manage-roles), [Telemetry authorization](https://developers.google.com/chrome/management/guides/telemetry_api).

**Unresolved.** Direct service-account role coverage across all planned endpoints has not been demonstrated. Do not claim that direct roles eliminate delegation for the entire application.

**Verified keyless building blocks.** IAM `signJwt` signs with Google's managed key and requires an authenticated caller with signing permission. Workload Identity Federation supports external workloads through a configured identity provider. [IAM signing method](https://docs.cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/signJwt), [Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation).

**Inference.** These components support a keyless delegation design, provided the installation supplies its source identity and signing authorization. They do not create an identity from a client ID and secret. Treat federation as an enterprise profile until a novice installation test proves otherwise.

For enterprise delegation, prefer federation plus IAM signing when the district supplies a workload identity provider. Document every required IAM grant. Offer an encrypted service-account key only as an explicit fallback where district policy permits key creation. Include rotation and revocation instructions. Do not introduce a vendor credential broker as a hidden dependency.

Remove per-call token generation. Use the supported authentication library and an in-memory token cache keyed by credential, subject, and scope set. Refresh before expiry. Keep the persistent credential encrypted and separate from application audit data. Never include tokens, passwords, or private keys in job artifacts.

## 2. Authorization: local permissions remain a security boundary

**Verified fact.** Google permits OU restrictions for several user-management privileges. Groups and Reports privileges do not support that same OU restriction. Some user-security actions require Super Admin privileges when the target is another admin. [Google administrator privilege definitions](https://support.google.com/a/answer/1219251?hl=en-uk).

**Finding.** A school-scoped application role does not inherit a matching restriction from a shared district-wide Google actor. The application must enforce its own object scope for every operation.

**Proposed replacement.** Specify operation permission, entity scope, and destination scope separately. Check permission during search, selection, preview, confirmation, dispatch, export, and event delivery. Recheck current authorization before deferred execution. Bind approval to an immutable list of entity IDs and proposed values. Reject changed permissions or changed targets before issuing the affected mutation.

Test a school operator against another school's users, devices, groups, reports, exports, and cached selection references. Test OU moves against both source and destination permissions. Test group membership edits that reference users outside the operator's scope. Define intentional cross-school exceptions explicitly.

A shared Google actor cannot identify the individual Campus Commander operator by itself. Preserve the local operator, approver, Google identity, credential reference, target, and attempt ID in each audit record. Verify the exact Google event fields for representative operations before promising cross-system actor correlation.

## 3. Tenant identity: use the customer account

**Verified fact.** `users.list` accepts `customer` to return users across all domains within one Workspace account. The `domain` filter returns one domain. User pagination tokens expire after three days. [Users list reference](https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/list).

**Proposed replacement.** Define one deployment as one Workspace customer account. Store the immutable customer ID as the connection boundary. Treat email domains as attributes and filters. Defer aggregation across separate customer accounts.

Replace the product statement that every school domain requires a separate deployment. Retain that requirement only for separate Workspace customer accounts. Preserve Google entity IDs when names, email addresses, and OU paths change.

## 4. Quotas determine large-job completion time

**Verified facts.** Directory defaults to 2,400 requests per minute per user per project. Additional concurrency limits apply per Workspace account and cannot be increased. User creation allows ten users per domain per second. OU creation and updates allow one operation per customer per second. Google documents propagation delays, including user renames. [Directory quota reference](https://developers.google.com/workspace/admin/directory/v1/limits).

**Verified facts.** A Directory HTTP batch permits at most 1,000 calls. Each inner call consumes quota separately. Google executes calls in arbitrary order and returns a status for each part. [Directory batching guide](https://developers.google.com/workspace/admin/directory/v1/guides/batch).

**Calculated examples.** These express nominal budget equivalents under documented defaults. They do not predict hidden burst enforcement or completion time.

| Example | Arithmetic | Consequence |
|---|---|---|
| 100,000 individual updates | 100,000 / 2,400 | 41.7 minutes of the nominal default request budget |
| 100,000 user creations | 100,000 / 10 | 2.78 hours at the documented creation rate |
| 10,000 OU updates | 10,000 / 1 | 2.78 hours at the documented OU rate |

These examples omit retries, reads, propagation checks, other applications, and competing jobs. Faster hardware does not remove Google's limits. Batch requests reduce connection overhead. They do not multiply the available quota.

**Accepted admission policy.** Retain greedy workers and randomized request backoff.
Workers report backoff to the job service. Workers do not modify Redis holds directly.
The job service writes a hold by job type with the reporting job as owner and a 300-second TTL.
Accepted continuing-backoff reports can overwrite another job's ownership and reset the TTL during retry waits.
Completion cleanup deletes only holds still owned by the finishing job.
Without accepted refreshes, a hold expires five minutes after its last update.
Do not renew a crashed worker's hold indefinitely from cached status.

Holds stop new jobs of the affected type. Existing jobs continue their steps, assignments, and retries.
Pending jobs of that type sort smallest first. Other job types remain eligible.
The job service aggregates worker observations for early release after recovery.
Five successful calls is illustrative. The exact threshold and observation rules require validation.
The [accepted policy](2026-09-04-job-admission-policy.md) defines behavior and proposed concurrency safeguards.

Do not introduce estimated quota balances, fixed capacity shares, or a separate quota-management service.
Display completion estimates from observed throughput.
As a separate retry-safety proposal, persist retry eligibility per operation and avoid replaying successful operations after assignment failure.

## 5. Membership and settings dominate synchronization cost

**Verified facts.** Users support pages of 500 through the Directory limits documentation. ChromeOS device method documentation permits 300. Members support 200 per group. Telemetry devices support 1,000. [Directory limits](https://developers.google.com/workspace/admin/directory/v1/limits), [ChromeOS list](https://developers.google.com/workspace/admin/directory/reference/rest/v1/chromeosdevices/list), [Member list](https://developers.google.com/workspace/admin/directory/reference/rest/v1/members/list), [Telemetry list](https://developers.google.com/chrome/management/reference/rest/v1/customers.telemetry.devices/list).

**Documentation conflict.** The general Directory limits page still lists 100 as the Chrome-device maximum. The endpoint reference lists 300. Use the endpoint-specific value provisionally and confirm it against the discovery document and a live contract test.

**Verified fact.** Groups Settings publishes a 100,000-query daily quota and provides a quota-increase process. [Groups Settings limits](https://developers.google.com/workspace/admin/groups-settings/limits).

**Calculated example.** Hourly settings reads for 10,000 groups consume 240,000 calls daily. This exceeds the published default before writes. A membership sweep needs at least one request for every group, including empty groups. Large groups require additional pages.

**Proposed synchronization budget.** Track users, devices, group metadata, memberships, group settings, OUs, and telemetry separately. Record freshness per collection and per expensive object. Refresh opened details and recently changed groups first. Spread full reconciliation across a bounded schedule. Preserve nightly reconciliation as an objective subject to the measured budget.

For planning, estimate membership calls as the sum of `max(1, ceil(group_member_count / 200))` across groups. Include pagination, retries, targeted reads, and write verification. Test realistic membership distributions and nested groups. Entity counts alone do not represent this workload.

**Unresolved.** This review did not establish a public Chrome Management quota value. Read actual project quotas during the integration experiment. Treat the archived claim as an unknown, not permission for unlimited dispatch.

## 6. Polling remains useful, but full-sweep locking is unnecessary

**Verified fact.** Directory's push guide describes notifications for user changes. Google requires an HTTPS receiver with a trusted certificate. [Directory push guide](https://developers.google.com/workspace/admin/directory/v1/guides/push).

**Verified fact.** Chrome Telemetry notifications use Google Cloud Pub/Sub. Pub/Sub supports client-initiated pull subscriptions. [Chrome notification guide](https://support.google.com/chrome/a/answer/13729277?hl=en), [Pub/Sub pull subscriptions](https://docs.cloud.google.com/pubsub/docs/pull).

**Finding.** The absence of an inbound public webhook justifies polling for Directory. It does not establish that every Google notification requires inbound access. Telemetry Pub/Sub introduces a separate Google service and operation cost. Keep it optional.

**Proposed replacement.** Retain polling as the default. Do not promise a universal delta stream across all entities. Treat notifications as refresh hints where supported. Reconcile periodically even when notifications run.

Replace the global sync lock with collection-level generation tracking and protected writes. Stage a sweep under its immutable generation. Publish validated data without overwriting newer confirmed mutations. Mark removals only after a complete authorized sweep. Distinguish loss of visibility from confirmed deletion.

A successful paginated sweep does not establish an atomic snapshot of Google's changing account. A local transaction cannot create that missing upstream guarantee. Document the reconciliation rules for concurrent external edits, renamed users, changed permissions, and interrupted pagination.

## 7. Mutation results require method-specific handling

**Verified facts.** ChromeOS OU moves accept 50 devices. `batchChangeStatus` also accepts 50 and returns individual device results. [Device move reference](https://developers.google.com/workspace/admin/directory/reference/rest/v1/chromeosdevices/moveDevicesToOu), [Device status reference](https://developers.google.com/workspace/admin/directory/reference/rest/v1/customer.devices.chromeos/batchChangeStatus).

**Verified fact.** Device commands have pending, expired, sent, acknowledged, and executed states. Execution includes its own success or failure result. [Device command resource](https://developers.google.com/workspace/admin/directory/reference/rest/v1/customer.devices.chromeos.commands).

**Proposed replacement.** Use separate states for request accepted, Google state verified, command pending, command executed, and outcome unknown. Never show an accepted remote wipe as a completed wipe. Poll command status using the saved Google command ID.

Persist an intent and attempt record before each external call. After a transport timeout, assume the outcome is unknown until method-specific reconciliation resolves it. Local idempotency keys prevent duplicate local dispatch. They do not force Google to deduplicate an unsupported operation.

Retry failed items only. Never repeat all 1,000 items because one chunk failed. For destructive commands without safe replay semantics, require reconciliation or explicit operator review after an ambiguous response. Record partial success independently for every entity.

Present submitted values separately from last observed Google values until verification completes. Preserve fast local feedback without claiming immediate global consistency.

## 8. Installation and insight requirements

**Verified fact.** Delegation setup requires a Super Admin. Organizations with multi-party approval require another Super Admin's approval. Changes have a documented propagation window of up to 24 hours. [Delegation administration](https://knowledge.workspace.google.com/admin/apps/control-api-access-with-domain-wide-delegation).

**Proposed change.** Describe one administrator session as an installation target, not a guaranteed connection deadline. Separate local installation, Google authorization, propagation, and initial inventory progress. Continue a read-only demo while external setup remains incomplete. Save progress across browser and service restarts.

Use a district-owned DNS name for a shared LAN deployment. Resolve that name internally and provide a browser-trusted certificate. Register the exact callback address. Google's web OAuth rules require a recognized public suffix, which excludes invented private suffixes. Localhost exceptions apply to the browser's own host. They do not cover another server's private IP address.

**Inference from the web OAuth flow.** The browser follows Google's redirect to the application. Google does not deliver a server webhook for this callback. A LAN callback therefore needs browser reachability and a valid registered address. It does not inherently require public inbound access. Verify this topology with the actual district browser and network configuration. [Web OAuth callback rules](https://developers.google.com/identity/protocols/oauth2/web-server).

Do not treat a payment method as a universal Workspace connection prerequisite. Document billing only for the actual enabled Cloud products. Prove the chosen OAuth or service-account flow in a fresh project before publishing that prerequisite.

**Verified fact.** Telemetry requires the appropriate device reporting policies and Chrome read privileges. [Telemetry prerequisites](https://developers.google.com/chrome/management/guides/telemetry_api).

**Proposed change.** Connection diagnostics must distinguish authorization, licensing, reporting policy, device freshness, and unavailable data. Do not interpret missing battery telemetry as healthy hardware. Validate license and hardware prerequisites against the pilot district before promising complete fleet coverage.

**Verified fact.** Reports `activities.list` exposes Google application events and documents a 180-day retrieval window. It requires an audit scope outside the current eight-scope list. [Reports activities reference](https://developers.google.com/workspace/admin/reports/reference/rest/v1/activities/list).

**Proposed change.** Decide whether v1 insight includes actions outside Campus Commander. If yes, add an optional Reports audit connector with `admin.reports.audit.readonly`. Keep external Google events separate from local mutation evidence. Store source timestamps, ingestion timestamps, event IDs, and observed gaps. Verify event availability and delay per application.

## Acceptance evidence before implementation approval

| Experiment | Required evidence |
|---|---|
| Local OAuth and service-account connection | Exact credential exchange, smallest scopes, restart, revoke, rotate, and reconnect results |
| Direct service-account roles | Pass/fail matrix for every planned read and write endpoint |
| OU authorization | Allowed and denied cross-school operations, exports, selections, and deferred execution |
| Large inventory | Actual request counts and freshness for representative membership distributions |
| Admission holds | Job-service updates permit owner replacement. Cleanup requires current ownership. Existing jobs continue. |
| Hold expiration | Continuing-backoff reports reset the 300-second TTL. Holds expire after reports cease. |
| Recovery and ordering | The job service aggregates recovery observations. Pending jobs of the held type sort smallest first. |
| Ambiguous writes | Correct recovery after Google accepts a request but the response is lost |
| Device commands | Command ID persistence and distinct acceptance, expiry, and execution results |
| Sweep correctness | No false removals after failure, permission change, cancellation, or concurrent mutation |
| Novice installation | Observed completion without developer assistance, plus every external prerequisite |
| External audit insight | Exact supported event classes, scopes, delay, correlation fields, and retrieval limits |

Keep these results in the decision record. Update the product brief, connection model, sync strategy, job semantics, and work breakdown together.
