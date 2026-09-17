# Google capability health research

Research date: 2026-09-16.
Scope: CC-48 capability authorization and connection health.
Status: source evidence and implementation recommendations. This research did not use live credentials or change Google configuration.

Keep `customer-domain-v1` limited to customer and domain reads.
Treat organizational unit reads as a separate optional capability.
Distinguish requested scopes, token scopes, administrator privileges, API configuration, and successful API observations.
A scope list alone does not establish operational access.

**Documented read operations**

| Capability           | Read operation                                                                       | Narrowest documented OAuth scope                                    | Source                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Customer identity    | `GET https://admin.googleapis.com/admin/directory/v1/customers/{customerKey}`        | `https://www.googleapis.com/auth/admin.directory.customer.readonly` | [customers.get](https://developers.google.com/workspace/admin/directory/reference/rest/v1/customers/get) |
| Customer domains     | `GET https://admin.googleapis.com/admin/directory/v1/customer/{customer}/domains`    | `https://www.googleapis.com/auth/admin.directory.domain.readonly`   | [domains.list](https://developers.google.com/workspace/admin/directory/reference/rest/v1/domains/list)   |
| Organizational units | `GET https://admin.googleapis.com/admin/directory/v1/customer/{customerId}/orgunits` | `https://www.googleapis.com/auth/admin.directory.orgunit.readonly`  | [orgunits.list](https://developers.google.com/workspace/admin/directory/reference/rest/v1/orgunits/list) |

Google documents broader alternatives for each operation.
The Directory scope guide recommends narrow scopes and defines these three scopes as read-only access.
[Directory scopes](https://developers.google.com/workspace/admin/directory/v1/guides/authorizing)

The organizational unit request defaults to immediate children.
`type=ALL` includes all descendants.
`type=ALL_INCLUDING_PARENT` includes the selected parent, or the root when the request omits a parent.
This operation does not require an Education-specific scope.
[orgunits.list](https://developers.google.com/workspace/admin/directory/reference/rest/v1/orgunits/list)

**Domain-wide delegation and administrator privileges**

A Super Admin grants domain-wide delegation to the service account through Google Admin console.
The grant identifies the service account client ID and allowed OAuth scopes.
Google also documents direct administrator role assignment to service accounts as a separate configuration.
That mechanism does not establish the delegated user's permissions in the existing DWD flow.
[Create credentials](https://developers.google.com/workspace/guides/create-credentials#delegate_domain-wide_authority_to_your_service_account)

Google administrator roles control accessible information and corresponding Admin API actions.
The current privilege guide combines former Admin console and Admin API privileges into one Admin privileges section.
It documents Organizational Units > Read and permits organizational unit restrictions.
It describes Domain Management and Domain Settings, but does not map every Directory method to a minimum role.
[Administrator privilege definitions](https://knowledge.workspace.google.com/admin/users/administrator-privilege-definitions)

**Evidence limit:** The three method references specify OAuth scopes, not complete minimum administrator role recipes.
This research does not establish the minimum custom role for customer and domain reads.
The existing Super Admin fixture proves access for that administrator only.
Test a restricted administrator before claiming a minimum role.
Record the actual operation, customer, subject, scope set, and observation time for each result.

**Documented token errors**

The following meanings come from Google's service account OAuth guide.
The recovery instructions are CC-48 recommendations.

| Token error                         | Documented meaning                                                                                          | Recommended recovery                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `unauthorized_client`               | Missing DWD authorization, incorrect numeric client ID configuration, or unauthorized client configuration. | Verify the numeric client ID, delegated user's domain, and requested scopes. |
| `access_denied`                     | Requested DWD scopes lack authorization, or service access restrictions apply.                              | Review the exact DWD scopes and service access controls.                     |
| `admin_policy_enforced`             | Workspace policy blocks requested scopes.                                                                   | Ask the administrator to review application access policy.                   |
| `invalid_grant`                     | Invalid delegated identity, JWT lifetime or clock error, or invalid signature/key.                          | Check the subject, clock, JWT generation, and key status.                    |
| `invalid_scope`                     | Empty, invalid, or incorrectly formatted scope list.                                                        | Correct the fixed scope profile. Use spaces in the JWT scope claim.          |
| `invalid_client` / `deleted_client` | Invalid client configuration or deleted client.                                                             | Review the credential configuration and client status.                       |

Google documents DWD propagation delays of up to 24 hours.
A failed exchange does not establish that all requested scopes failed independently.
[Service account OAuth errors](https://developers.google.com/identity/protocols/oauth2/service-account#error-codes)

**Documented API errors and classification limits**

| Observed result                       | Evidence                                                  | CC-48 implication                          |
| ------------------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| Directory `403 userRateLimitExceeded` | Google documents a per-user rate limit.                   | Classify as quota failure and delay retry. |
| Directory `403 quotaExceeded`         | Google documents concurrent request limits.               | Classify as quota failure and delay retry. |
| Directory `429 rateLimitExceeded`     | Google documents account-level concurrent request limits. | Classify as quota failure and delay retry. |

Google recommends exponential backoff for these Directory errors.
An HTTP 403 alone therefore does not establish an authorization failure.
[Directory limits and quotas](https://developers.google.com/workspace/admin/directory/v1/limits)

Google's common error reference describes `insufficientPermissions` as insufficient authority for the request.
It describes `forbidden` without a precise root cause.
It lists multiple `accessNotConfigured` causes: disabled API access, project abuse restrictions, and project deletion.
This reference belongs to Digital Asset Links. It does not guarantee every Directory error representation.
[Google common errors](https://developers.google.com/digital-asset-links/v1/errors/core_errors#FORBIDDEN)

The Directory troubleshooting guide for resellers specifically associates `accessNotConfigured` with an API disabled in the Cloud project.
Its `forbidden` examples concern reseller access and customer ownership.
Do not present those reseller-specific causes as a diagnosis for a DWD subject.
[Directory errors for resellers](https://developers.google.com/workspace/admin/reseller/v1/support/directory_api_common_errors)

Google documents `domainPolicy` for Drive and Gmail when domain policy blocks application access.
This research found no equivalent Directory guarantee for that reason.
[Drive domain policy error](https://developers.google.com/workspace/drive/api/guides/handle-errors#domainPolicy), [Gmail domain policy error](https://developers.google.com/workspace/gmail/api/guides/handle-errors#domainPolicy)

**Recommended classification:** Preserve an allowlisted provider reason and the operation that returned it.
Separate quota, token rejection, scope evidence, permission denial, policy restriction, project configuration, and unavailable service.
Use a generic permission-denied result when the evidence cannot distinguish scope, role, policy, or resource restrictions.
Do not identify a missing administrator role from `forbidden` alone.
Do not display raw provider messages or credential material in the browser or audit log.

**License and subscription evidence**

Classroom documents `UserIneligibleToUpdateGradingPeriodSettings` for either inadequate Education licensing or inadequate course authority.
Even this specific reason does not identify licensing as the sole cause.
Classroom separately documents `ClassroomApiDisabled` and `ClassroomDisabled` as access failures.
[Classroom errors](https://developers.google.com/workspace/classroom/troubleshooting/common-errors)

The Classroom `userProfiles.checkUserCapability` method provides a dedicated capability check.
Its existence does not add Classroom authority to the Directory profile.
[Classroom capability check](https://developers.google.com/workspace/classroom/reference/rest/v1/userProfiles/checkUserCapability)

**Evidence limit:** These sources establish no Directory license or subscription error for the three read operations above.
Do not map generic 403, 404, `forbidden`, or `insufficientPermissions` to a missing license.
Reserve license-specific health results for a documented capability response that establishes that condition.
Keep Education capabilities unverified until the approved Education fixture exists.

**Token scope evidence**

Google's OAuth2 API reference defines tokeninfo `scope` as the space-separated scopes granted to that access token.
Google's Node authentication library documents `getTokenInfo(accessToken)` for checking provisioned scopes.
[OAuth2 tokeninfo reference](https://developers.google.com/resources/api-libraries/documentation/oauth2/v2/python/latest/index.html#tokeninfo), [Google authentication library](https://docs.cloud.google.com/nodejs/docs/reference/google-auth-library/latest/google-auth-library/oauth2client#gettokeninfoaccesstoken)

**Inference:** Tokeninfo establishes token scope evidence, not the complete Admin console DWD grant.
It does not establish the delegated user's current role, enabled APIs, product license, or access to a specific customer.
A successful customer read does not establish domain or organizational unit read access.
Use separate operation results for those capabilities.
Do not infer partial scope grants from a rejected token request.
If token scope inspection fails, preserve the last observation as historical evidence and mark the new check incomplete.

**Retry and recovery recommendations**

Google's Cloud Storage guidance distinguishes transient errors from configuration failures and considers request idempotency.
It identifies HTTP 408, 429, server errors, socket timeouts, and disconnected connections as retry candidates.
It warns against unlimited retries and multiplied retries across application layers.
This is general recovery guidance, not a Directory-specific service guarantee.
[Google retry strategy](https://docs.cloud.google.com/storage/docs/retry-strategy)

The following decisions are CC-48 recommendations derived from the sources above.

1. Bound request timeouts and total retries for each health check.
2. Retry documented quota failures and transient read failures with exponential backoff and jitter.
3. Preserve confirmed customer identity and settings after a failed check.
4. Keep the last successful observation time separate from the latest failed attempt.
5. Require a successful new check before showing restored capability access.
6. Preserve the credential generation and requested profile with every observation.
7. Reject stale observations after credential replacement, customer changes, or application authorization changes.
8. Keep optional organizational unit failures separate from the customer and domain profile.
9. Require explicit scope authorization before requesting the optional organizational unit scope.
10. Keep application role authority separate from Google capability health.
11. Present a recovery action that matches the evidence, with a generic path for ambiguous permission failures.
12. Avoid automatic credential replacement or repeated token exchanges after persistent configuration errors.

**Unresolved live evidence**

- Minimum custom administrator privileges for customer and domain reads.
- Organizational unit visibility under a restricted administrator role.
- Actual Directory error payloads after controlled DWD removal, role removal, API disabling, and restoration.
- Provider behavior during DWD propagation and with existing unexpired access tokens.
- Education-specific capability and license behavior on an approved Education customer.

Synthetic tests can verify classification, persistence, and recovery logic.
They do not replace these live provider checks.
