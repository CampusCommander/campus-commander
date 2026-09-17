# Phase 3 invitation implementation

Owner: CC-50. Status: implementation complete for platform grants. Hosted database and browser qualification passed. Review remains pending.
This branch builds on the tested CC-45 contracts in PR #5. Review and merge remain separate gates.

## Demonstration and boundaries

A platform administrator creates a copyable invitation without SMTP.
The recipient redeems it through the configured OIDC provider in a separate browser.
The inviter reviews the verified issuer, subject, and intended grants before confirming access.
The recipient then signs in with only those grants and the existing `identity:read` permission.
Google Workspace account creation and administration remain outside this workflow.

Initial invitations support sign-in-only access and explicit platform grants within the inviter's current authority.
CC-51 and CC-52 add verified district and school resources to the same invitation contract.
Until those resources exist, the server rejects district and school invitations.
The interface states this boundary instead of accepting unverified resource identifiers.
Invitations do not silently reactivate or change an existing application principal.
Existing-principal grant changes belong to CC-51.

## Durable lifecycle

Migration `004-application-invitations` preserves all previous migration bytes.
The table stores a token hash, issuer restriction, optional exact subject restriction, immutable intended grants, expiry, and revision.
Invitation expiry ranges from one hour to seven days.
Each inviter has at most fifty active invitations. The review list contains at most two hundred recent invitations.

States are `issued`, `redeeming`, `pending`, `accepted`, `revoked`, and `expired`.
The first claim removes the invitation token hash and binds a separate opaque browser credential.
OIDC state, nonce, PKCE, and the single-use Redis transaction verify the sign-in response.
The verified identity remains pending. It receives no principal or grant until the inviter confirms it.
Wrong-subject, wrong-issuer, expired, revoked, and replayed attempts cannot complete redemption.
An interrupted sign-in consumes its link. The inviter revokes it and creates a replacement.

The link stores its token in the URL fragment. The browser removes that fragment when the invitation page opens.
The API never receives the token in a request URL. The browser sends it in a JSON POST body.
The create response shows the link once. Lists, logs, and security events exclude it.
The application does not store it in local storage or session storage.
Page departure clears the creator's displayed link.

## Authorization and transactions

Runtime roles cannot read or write the invitation table directly.
Narrow database functions recheck enabled actors, current permission versions, invitation revisions, and grant ceilings.
Authority changes share the existing transaction advisory lock with operator recovery.
Each state transition commits its security event in the same transaction.
Confirmation requires the original inviter and the reviewed candidate subject.
Revocation or reduced authority prevents the inviter from activating a pending invitation.
Security-definer functions fix their search path. Internal helper functions deny runtime and PUBLIC execution.

Authenticated mutations retain origin, JSON content-type, and CSRF checks.
Anonymous redemption requires the invitation secret, same-origin JSON, and a bounded start rate.
The rate uses the transport peer address. Forwarded headers do not change it.
Redis failure prevents a new sign-in transaction. Durable pending invitations remain in PostgreSQL.
An invitation does not replace application sign-in or Google background credentials.

## Validation record

Local API and frontend builds, lint, unit tests, and PostgreSQL contract tests passed.
The real PostgreSQL suite covers concurrent claims, audit rollback, revision checks, revoked inviters, expiry, and grant ceilings.
The browser suite passed create, separate-browser redemption, explicit confirmation, limited sign-in, denial, and recovery.
[Full CI](https://github.com/CampusCommander/campus-commander/actions/runs/35131956143) passed all seven jobs at `55b53fe3d4164eac5c127a9026c25000cc60bcb8`.
[Retained evidence](../../deployment/evidence/CC-50-platform-invitations.json) records the exact revision, checks, and accessibility artifact hashes.
The edge restricts invitation pages and API routes to Phase 3. Local tests reject unsupported methods and paths.
A test-only follow-up waits for page initialization and layout before checking fragment removal and responsive width.

UI rules: UI-01 through UI-10 and FORM-01.
The invitation form uses the shared form width, Material controls, theme tokens, and application shell.
Loading, empty, error, stale, expiry, conflict, and offline recovery states preserve form values.
Partial completion is inapplicable because every invitation mutation is atomic.
Axe reported zero automated violations. Empty Material fields retained incomplete contrast checks.
Human screen-reader evidence remains NOT RUN. Full release acceptance belongs to CC-61.
