# Phase 3 Google credential decision

Decision owner: CC-44. Date: 2026-09-16. Status: owner-selected profile, live qualification incomplete.

The owner supplied a service-account credential and configured domain-wide delegation for background authentication.
This instruction replaces D01's background browser OAuth proposal in the approved Phase 3 plan.
Application sign-in retains its existing web OAuth client, sessions, enrollment, and callback protections.
The eighteen delivery tasks and their dependencies remain unchanged.

## Standing test authorization — 2026-09-17

The owner authorizes ongoing API plumbing tests against `easton-consulting.com`, confirmed customer `C01zcarnq`.
The approved DWD client is `113794681976879482895`. The delegated subject is `spencer@easton-consulting.com`.
The owner confirms the subject has the Super Admin role and that the service-account credentials are configured.
The protected local credential remains available for reuse. Do not copy credential values into repository records.

Use this fixture for read-only checks whenever development needs live Google API validation.
The owner reports one user account. Empty entity collections do not block API plumbing tests.
An Education domain is not required for the enabled customer, domain, and organizational-unit reads.
Keep entity coverage, Education capability evidence, and minimum-role evidence separate from successful API connectivity.
The configured scopes below remain the current test boundary. User or device inventory requires its own enabled scopes and implementation.
This authorization does not include Google mutations, DWD revocation, or service-account key disablement.

The application provider passed a live read-only check on 2026-09-17 using this fixture.
It confirmed `C01zcarnq` and `easton-consulting.com`, then read three organizational-unit references, including the root.
It observed one primary domain, no secondary domains, and no alias domains.
The provider verified the exact requested scopes during token exchange.
The [sanitized result](../../deployment/evidence/CC-44-live-plumbing-2026-09-17.json) records method names, code hashes, counts, timing, and limitations.
This check does not claim user inventory, Education capabilities, minimum-role validation, or a browser session with live Google sign-in.

## Credential contract

The background provider uses service-account DWD with one explicit delegated Workspace subject.
The Google authentication library signs assertions and exchanges them for short-lived access tokens.
The provider reuses valid access tokens and requests a new token after expiry.
DWD does not use browser consent, authorization callbacks, or refresh tokens.
OAuth audience and publishing state do not govern this DWD token exchange.
Application sign-in still requires its existing OAuth configuration.

The implementation uses `google-auth-library` version `11.1.0` with Node `24.19.0`.
Google documents this flow in its [service-account authorization guide](https://developers.google.com/identity/protocols/oauth2/service-account).
The proof fixes the token endpoint to Google and checks the supplied numeric client ID.
It rejects unsupported credential types, invalid RSA keys, alternate token endpoints, and unapproved scopes.
Token requests have a ten-second timeout and no automatic retry or redirect.
Reports contain classified errors, scope names, counts, HTTP status, and timing. They exclude private credentials and provider payloads.

Production stores encrypted service-account private credentials in PostgreSQL.
Versioned encryption keys remain outside database backups.
The proof uses an encrypted private file store solely to test persistence, generation conflicts, and independent key recovery.
This proof store does not satisfy production database, audit, or replica requirements.
CC-46, CC-49, and CC-56 retain those implementation and validation responsibilities.

## Enabled capabilities

All scopes use the `https://www.googleapis.com/auth/` prefix.

| Capability                    | Method                                                                                                   | Scope suffix                        | Live result |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------- |
| Customer identity             | [customers.get](https://developers.google.com/workspace/admin/directory/reference/rest/v1/customers/get) | `admin.directory.customer.readonly` | HTTP 200    |
| Domain observations           | [domains.list](https://developers.google.com/workspace/admin/directory/reference/rest/v1/domains/list)   | `admin.directory.domain.readonly`   | HTTP 200    |
| Optional school OU references | [orgunits.list](https://developers.google.com/workspace/admin/directory/reference/rest/v1/orgunits/list) | `admin.directory.orgunit.readonly`  | HTTP 200    |

The controlled customer returned one primary domain, zero secondary domains, zero alias domains, and two OUs.
Google returned exactly the three requested scopes.
Secondary-domain and alias-domain live coverage remains untested because this customer has no such fixtures.
The simulator covers primary, secondary, and alias domain counts separately.
User inventory, device inventory, and every Google mutation remain outside this proof.
The historical four-capability experiment does not authorize additional Phase 3 scopes.

## Revised acceptance gates

| Original background OAuth gate                 | DWD gate                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Browser consent and callback state             | Authorized local credential staging with CSRF, current administrator authority, and replay protection          |
| Authorization code and PKCE                    | Google-library signed assertion, fixed Google token endpoint, explicit delegated subject, and bounded exchange |
| Partial browser consent                        | Missing DWD scope, exact issued scopes, and per-capability privilege failures                                  |
| Refresh-token persistence and omission         | Encrypted service-account persistence, restart, access-token reuse, and renewed signed token exchange          |
| User refresh-token revocation                  | DWD grant removal, key disablement, or service-account disablement with observed recovery behavior             |
| Same-customer authorizing identity replacement | Service-account or delegated-subject replacement with unchanged stable customer binding                        |
| Login/background separation                    | Web OAuth sign-in remains independent from the background service account                                      |

Browser closure does not affect DWD because the provider uses no browser session.
Fresh-process and independently restored-credential reads passed against Google.
The owner must confirm the resolved stable customer before the proof activates its stored credential.
A replacement must preserve that customer ID. A late writer must not replace a newer credential generation.

## Evidence and limits

The initial live run passed customer, domain, OU, token reuse, and forced token renewal checks.
Each run requested two access tokens across five Directory reads.
Fresh-process and independent recovery runs passed at `c5e9d9cd22359270dda8168ba31df84706a13b11`.
Both runs used the encrypted credential without access to the original service-account download.
Missing and incorrect key tests failed before any Google request.
The [sanitized evidence](../../deployment/evidence/CC-44-dwd-credential-proof.json) retains these results and their limits.
The owner confirmed the resolved customer on 2026-09-16.
The owner reported the delegated Google role as Super Admin on 2026-09-16.
This declaration identifies the live fixture. It does not prove a minimum-privilege custom role.
The owner has no Education test customer at present.
Current customer, domain, and OU reads use the standard Workspace Directory API.
An Education fixture is not a prerequisite for those Phase 3 checks.
Education-specific capability validation remains outside the current fixture evidence.
The owner has not supplied a second approved delegated administrator for identity replacement.
Live DWD revocation, key disablement, and alternate same-customer identity replacement remain NOT RUN.
An isolated second-customer identity remains unavailable. Simulator evidence proves wrong-customer rejection.
Do not label CC-44 qualified while its required live cases remain incomplete.

The proof never removes DWD grants or disables service-account keys automatically.
Those tests require a dedicated fixture and an explicit operator action with a recorded restoration procedure.
Disconnect, revoked-token behavior, and retained token lifetime still require production validation under CC-49.
The proof does not change Google data or application-login configuration.
