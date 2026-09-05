# Google credential proof

**Status: NOT RUN. No Workspace account or OAuth credential was supplied for this experiment.**

This procedure tests the proposed default credential profile before onboarding implementation.
Source review does not prove that a district identity has the required privileges or that unattended access survives district policy.

## Initial capability matrix

Every scope below has the prefix `https://www.googleapis.com/auth/`.
These are minimum scope candidates for the listed methods. Google privileges require controlled-account testing.
The proposed application permission names describe contract responsibilities. P1.1 must finalize their identifiers.

| Capability | Google method and source | Scope suffix | Proposed application permission | Runtime status |
|---|---|---|---|---|
| Read customer identity | [customers.get](https://developers.google.com/workspace/admin/directory/reference/rest/v1/customers/get) | `admin.directory.customer.readonly` | Manage connection | NOT RUN |
| Read customer domains | [domains.list](https://developers.google.com/workspace/admin/directory/reference/rest/v1/domains/list) | `admin.directory.domain.readonly` | Manage connection | NOT RUN |
| Read users | [users.list](https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/list) | `admin.directory.user.readonly` | Read users within granted scope | NOT RUN |
| Read ChromeOS devices | [chromeosdevices.list](https://developers.google.com/workspace/admin/directory/reference/rest/v1/chromeosdevices/list) | `admin.directory.device.chromeos.readonly` | Read devices within granted scope | NOT RUN |
| Change a device annotation | [chromeosdevices.patch](https://developers.google.com/workspace/admin/directory/reference/rest/v1/chromeosdevices/patch) | `admin.directory.device.chromeos` | Update approved device fields within granted scope | Deferred until a designated test device and write authorization exist |
| Sign out a user | [users.signOut](https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/signOut) | `admin.directory.user.security` | Sign out users within granted scope | Outside the initial read-only experiment |

The read-only experiment enables the first four rows. It requests no mutation scopes.
Record supported Google roles, license prerequisites, returned fields, and omitted fields for each row after testing.
Do not infer write privileges from successful inventory reads.

The users method supports customer-wide enumeration through `customer`, including multi-domain accounts.
Use the stable customer ID as the installation boundary. Do not substitute the sign-in email domain.
Treat empty authorized inventory separately from failed or incomplete enumeration.

Directory HTTP batches support up to 1,000 calls to the same API. Each inner call still counts toward usage.
Correlate inner responses with operation IDs. Never interpret outer HTTP success as universal inner success.
The worker assignment size remains independent of this transport limit. [Directory batch guide](https://developers.google.com/workspace/admin/directory/v1/guides/batch)

## Required test inputs

1. Provide a controlled Workspace customer with known primary and secondary domain fixtures.
2. Designate one district-managed connection identity and record its assigned Google privileges.
3. Create a district-owned OAuth web client with the Admin SDK API enabled.
4. Register the exact callback URL used by the test harness.
5. Use a district hostname with trusted HTTPS for testing access from another computer.
6. Store the client credential outside the repository with restricted file permissions.
7. Supply the local credential-file path without pasting its contents into chat.

Record the OAuth audience and publishing state. External Testing is not the selected unattended production profile.
Keep application login credentials separate from background Google authorization credentials.
The authorizing browser must reach the callback host. Loopback callbacks belong to the browser's own machine.

## Harness contract

Use the official Google client library for the authorization-code exchange and token renewal.
Request offline access and validate a single-use state value at callback.
Request only the capability scopes above. Record granted scopes without storing tokens in experiment evidence.
Store refresh credentials encrypted and keep the encryption key outside the credential database.
Use a separate process for unattended reads after browser closure.
Google documents offline access and renewal in its [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).

The harness needs explicit actions: authorize, read, restart-read, renew-read, revoke, and replace-identity.
Revocation and identity replacement operate only on the dedicated test authorization.
Do not implement automatic tenant switching when a replacement identity resolves to a different customer.

Record HTTP status, Google error reason, capability, elapsed time, and sanitized outcome for each call.
Record token request counts and expiry timestamps without recording access tokens, refresh tokens, codes, or authorization headers.
Restrict entity evidence to fixture aliases or counts. Keep actual account data outside this repository.

## Execution and acceptance

| Test | Procedure | Required result |
|---|---|---|
| Consent and scope accuracy | Authorize the four read capabilities | Granted scopes match enabled capabilities. Refresh credential exists. |
| Customer identity | Resolve customer and compare known fixture identity | Exact customer match. Reject mismatch. |
| Domain coverage | Read domains and enumerate users through the customer parameter | Primary and secondary fixture users appear without duplicate identity records. |
| Device inventory | Read device inventory with the declared projection | Report available fields and empty inventory separately from access failure. |
| Access-token reuse | Issue several reads within the access-token lifetime | Reuse the valid token instead of renewing for each request. |
| Browser closure | Close the authorizing browser and issue another read | Worker access continues without a browser session. |
| Process restart | Restart the harness with only encrypted persisted credentials and its key | Unattended read succeeds without consent. |
| Renewal | Observe expiry or trigger renewal explicitly through the test harness | A new access token permits another read. Preserve the refresh credential when renewal omits it. |
| Missing Google privilege | Remove one test identity privilege, then read its capability | Report the permission failure without misclassifying it as quota backoff. |
| Revocation | Revoke the dedicated test grant and attempt renewal | Mark the connection as requiring authorization. Do not retry indefinitely. |
| Identity replacement | Authorize another approved identity in the same customer | Resume reads and record the connection identity change. |
| Wrong customer | Authorize an isolated identity from another test customer, when available | Reject replacement before changing installation ownership. |
| Key recovery | Restart with a restored encrypted credential and independently restored key | Read succeeds. Missing key produces a clear recovery failure. |

Record unavailable fixture cases as NOT RUN. Do not mark the credential profile qualified when required cases remain untested.
Separate external Google approval time from hands-on setup time.
The final result must identify exact library versions, Google roles, enabled capabilities, and each test outcome.

## Follow-on mutation proof

Use one designated test device and one approved annotation field after read-only proof.
Capture the current value and approved replacement in a frozen preview.
Execute the patch through a job and verify the resulting field through a read.
Inject interruption after request dispatch and classify the outcome through the capability's reconciliation rule.
Treat restoring the fixture value as another explicit mutation job with its own evidence.
Do not perform sign-out, device commands, or district-wide updates as credential checks.
