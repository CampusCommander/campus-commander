# Phase 2 application access

Status: implementation qualification remains in progress under CC-22.

The installation operator configures OIDC and enrolls the initial administrator.
Google background authorization and delegated user administration belong to Phase 3.
An email address or domain match never grants application access.

## Guided installation

Guided Phase 2 installation imports Google credentials and enrolls the initial administrator within the installer.
Choose `google`, then upload the downloaded Web application client JSON through the paired setup page.
The installer validates the exact callback URI and stores the client ID and secret together.
Choose `oidc` for another provider or existing protected answers files.

After service readiness, open the displayed `/setup` address and enter the private administrator pairing code.
Sign in with the administrator account. Confirm the verified account in the installer terminal.
The browser reports completion after the protected database operation commits. Then select **Sign in to Campus Commander**.
No subject lookup, OAuth Playground, or separate enrollment script is required for guided installation.

Pairing expires after ten minutes. Resume creates a new attempt if no principal exists.
Resume preserves completed enrollment. It never replaces an existing principal.
The installer performs the grant through its migration operation. Running application services never receive migration credentials.
The existing transaction lock permits exactly one initial principal.
An unattended installation reports pending enrollment. Resume interactively to complete sign-in, or use the advanced operator interface below.

See [guided onboarding](../installer/HOSTED.md#guided-google-setup-and-administrator-enrollment) for remote browser access and credential storage.

## Advanced provider configuration

Register a confidential web client with the district identity provider.
Enable authorization code flow, S256 PKCE, and the `openid profile` scopes.
Register exactly `https://<application-host>/api/auth/callback` as its redirect URI.
Obtain the initial administrator's stable issuer and subject from the provider's administrative records.
Do not substitute an email address for the subject.

Set `phase` to `2` and `services.edge.access` to `application` in the deployment profile.
Add this configuration with the actual provider and application addresses:

```json
{
  "applicationAuth": {
    "issuer": "https://identity.example.invalid",
    "clientId": "campus-commander",
    "clientSecretRef": {
      "provider": "file",
      "path": "/run/secrets/oidc-client-secret"
    },
    "publicOrigin": "https://campus.example.invalid",
    "sessionLifetimeSeconds": 28800,
    "sessionIdleSeconds": 1800
  }
}
```

For Kubernetes, use a Kubernetes secret reference with `name` and `key` instead of `path`.
Provide the client secret through the protected installation secret store.
The installer does not generate identity-provider credentials.
Keep the secret distinct from bootstrap, database, Redis, Kestra, and worker credentials.

Allow API HTTPS traffic to provider discovery, token, and signing-key endpoints.
Kubernetes requires their explicit CIDRs in `externalEgress.identityProvider` within the operator configuration.
The generated policy permits this traffic from API pods only.
Keep the CIDRs current when the provider changes addresses.
The API uses system certificate trust for OIDC.

## Advanced enrollment and access inspection

Apply the application migrations before enrollment.
Use the application migration role through a protected operator connection.
Keep that credential outside running API, frontend, edge, and worker containers.
The CLI requires the profile, a PostgreSQL operator file, and a request file.
The operator file supplies `migrationRole` and `migrationPasswordSecretRef`.
Mount referenced secrets at their configured `/run/secrets` paths.

Create the enrollment request in a protected operator directory:

```json
{
  "action": "initialize",
  "issuer": "https://identity.example.invalid",
  "subject": "provider-stable-subject",
  "displayName": "Installation administrator"
}
```

```sh
node deployment/bootstrap/application-access-cli.mjs /protected/profile.json /protected/postgres-operator.json /protected/access-request.json
```

For Compose installations, send the protected request through standard input:

```sh
docker compose -f /protected/installation/docker-compose.json -p INSTALLATION_PROJECT \
  run --rm --no-deps --interactive --no-tty database-migrate \
  node /app/deployment/bootstrap/application-access-cli.mjs \
  /run/config/profile.json /run/config/operator.json /dev/stdin \
  < /protected/access-request.json
```

Use the installation project name from the operator configuration.
This command retains protected file permissions when the host and container use different user IDs.

The command permits initialization only when no principal exists.
It returns the principal ID and audit correlation identifier.
Sign in through the configured HTTPS address and verify all four Diagnostics checks.
Confirm that an unapproved provider identity receives no application session.

Use `{"action":"inspect"}` as the request to inspect principal IDs, bindings, status, and permission versions.
Protect this output as operator identity information.

## Revoke and recover access

Inspect the current principal before changing access.
Revoke it with this request using the current ID and permission version:

```json
{
  "action": "revoke",
  "principalId": "00000000-0000-4000-8000-000000000001",
  "expectedVersion": 1
}
```

Existing sessions fail their next protected request.
Recovery requires the operator credential and a verified replacement identity.
Use this request with the permission version returned by inspection:

```json
{
  "action": "replace",
  "principalId": "00000000-0000-4000-8000-000000000001",
  "expectedVersion": 2,
  "issuer": "https://identity.example.invalid",
  "subject": "replacement-provider-subject",
  "displayName": "Recovered administrator"
}
```

Replacement retains the principal ID, preferences, permissions, and security history.
It increments the permission version and re-enables access in one audited transaction.
Concurrent changes reject a stale expected version.
Verify replacement sign-in and rejection of the previous session before restoring operator access restrictions.

## Rotate credentials and restore

Create replacement provider credentials through the provider's administrative interface.
Replace the protected client-secret file and restart every API replica.
Verify a fresh sign-in before retiring the previous provider credential.
For an emergency revocation, revoke application access before credential replacement.
Changing the client secret alone does not invalidate existing application sessions.

Rotate Kestra and worker credentials through their existing protected runtime configuration.
Restart both sides of each credential change before running the Kestra Diagnostics check.
Verify rejection of the previous worker credential through the isolated qualification procedure.
Never place credential values in Jira, command arguments, diagnostics, or logs.

Use the [cold backup and isolated restore procedure](../operations/README.md) for application recovery.
The application dump preserves principals, permission versions, preferences, and security events.
Restore into isolated targets and keep application services disabled during verification.
Start fresh Redis before exposing restored application access.
Recover provider credentials from the separate protected secret store.
Review administrator bindings and revoke obsolete access through the operator CLI.
Verify fresh sign-in, previous-session denial, and all four Diagnostics checks before releasing the restored installation.
