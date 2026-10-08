# Google DWD credential proof

This operator tool implements the [CC-44 credential decision](../../docs/portfolio/phase-3-google-credentials.md).
It performs bounded customer, domain, and optional OU reads.
It stores credentials outside the repository and prints sanitized reports.
Do not use this file store as the production credential provider.

## Configuration

Create a private JSON configuration file with mode `0600`.
Use absolute paths for all files.
Store the encryption key separately from the encrypted credential and its backup.

```json
{
  "clientId": "123456789012345678901",
  "subject": "approved-admin@example.org",
  "orgunits": true,
  "googleRole": "Recorded Workspace role",
  "serviceAccountFile": "/private/import/service-account.json",
  "credentialStore": "/private/state/google-credential.enc",
  "encryptionKey": "/private/keys/google-credential.key",
  "privateObservation": "/private/state/customer.json",
  "report": "/private/state/proof-report.json"
}
```

The source credential path supports an operator-owned Windows download mounted in WSL.
Generated credential, observation, key, and report files use mode `0600`.
The source credential remains outside the repository.
Restrict its Windows ACL or Unix permissions to its operator.

## Procedure

1. Authorize the service account's numeric client ID through Workspace DWD.
2. Grant only the capability scopes documented in the credential decision.
3. Enable the Admin SDK API in the service account's Google Cloud project.
4. Select an approved Workspace subject with the required Directory privileges.
5. Stage and test the credential.

```bash
npm exec nx run deployment:google-proof -- --config=/private/proof.json --action=stage
```

6. Inspect the private customer observation and confirm its stable customer ID.

```bash
npm exec nx run deployment:google-proof -- --config=/private/proof.json --action=confirm --customer-id=Cfixture
```

7. Start a fresh process for unattended reads from the encrypted credential.

```bash
npm exec nx run deployment:google-proof -- --config=/private/proof.json --action=read
```

The read action does not read the original service-account file.
Each run verifies token scopes, reads enabled capabilities, proves token reuse, and forces one signed token renewal.
The report contains the source revision, dirty-state flag, exact library version, counts, timings, and qualification limits.
Retain separate report files for stage, restart, and recovery runs.

8. Restore the encrypted credential and its key to separate private paths.
9. Point a copied private configuration at those restored paths.
10. Repeat the read action in another process.
11. Verify missing and incorrect restored keys fail without exposing secrets.

A generation check rejects stale replacement writes.
A file lock rejects concurrent writers without waiting indefinitely.
After an interrupted write, verify that no proof process remains before removing the private `.lock` file.
Never remove a lock held by a running process.

## Repeatable checks

```bash
npm exec nx run deployment:google-proof-test
npm exec nx run deployment:lint
```

The tests use synthetic credentials and a simulated Google transport.
They cover signed delegated assertions, token reuse and renewal, scope boundaries, customer boundaries, redaction, concurrency, and encrypted recovery.
Live revocation and replacement require separate controlled fixtures.
The tool does not implement provider revocation or Google mutations.
