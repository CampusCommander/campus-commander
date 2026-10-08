# Phase 3 administrator confirmation

The Phase 3 migration preserves existing sign-in and Diagnostics permissions.
It does not assign platform-administrator grants automatically.
Use this procedure after the Phase 3 installer applies its migrations.

1. Use the protected operator connection described in [application access](APPLICATION-ACCESS.md#advanced-enrollment-and-access-inspection).
2. Inspect current principals with an `inspect` request.
3. Confirm the intended principal's stable ID, issuer, subject, enabled state, and permission version.
4. Create this request in the protected operator directory with the verified ID and version.

```json
{
  "action": "confirm-platform-administrator",
  "principalId": "00000000-0000-4000-8000-000000000001",
  "expectedVersion": 1,
  "confirmation": "grant-platform-administrator"
}
```

5. Run the operator command with the Phase 3 profile and migration-role configuration.

```sh
node deployment/bootstrap/application-access-cli.mjs \
  /protected/deployment.json \
  /protected/postgres-operator.json \
  /protected/confirm-platform-administrator.json
```

6. Sign in again after the command succeeds.

The command grants every Phase 3 platform action to the selected principal.
It preserves the principal's identity, preferences, and existing Diagnostics permissions.
It increments the permission version and records `platform-administrator-confirmed` atomically.
A changed principal version, disabled principal, wrong issuer, missing confirmation, or Phase 2 profile rejects the operation.
An audit failure rolls back the grants and version change.
Keep migration credentials outside application runtime containers.

See the [authorization contract](../../docs/portfolio/phase-3-authorization.md) for the action matrix and preset boundaries.
