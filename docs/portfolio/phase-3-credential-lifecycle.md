# Phase 3 credential lifecycle

[CC-49](https://easton-consulting.atlassian.net/browse/CC-49) owns replacement, encryption-key rotation, and local disconnect.
[Draft PR 13](https://github.com/CampusCommander/campus-commander/pull/13) contains the implementation.
Backend operations are implemented. Browser management controls and complete qualification remain pending.

## Customer and generation contract

A replacement retains the confirmed customer ID.
The operator stages a service-account key and delegated administrator before activation.
The provider verifies the exact required scopes and customer/domain reads.
A failed or wrong-customer check erases the candidate ciphertext and preserves the active credential.

Each candidate binds its actor, permission version, browser, customer, and expected generation.
The candidate expires after ten minutes.
Activation requires a ready candidate, explicit confirmation, and an explicitly selected deployed encryption key.
Current authority and generation checks run inside the database transaction.

Replacement, rotation, and disconnect advance the generation.
Each transition removes the cached token, pending diagnostic, and retired encrypted credential.
The transaction also expires other staged credentials and retains security events.
An audit failure rolls back the transition.
Retired generations cannot publish tokens or observations or obtain another credential from the application database.

A request already sent to Google can finish externally after a local transition.
The application rejects its stale completion.
Local transitions do not claim provider-side token revocation or cancellation of external requests.

## API contract

All operations require an authenticated application session.
Management operations require the platform `connection:manage` grant.
Writes require the current CSRF token and expected origin.
No response includes key material or an encrypted credential envelope.

| Method | Path                                               | Required input or result                                                                             |
| ------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| GET    | `/api/google-connection/credentials`               | Current customer, generation, credential ID, active state, key ID, and configured key IDs            |
| POST   | `/api/google-connection/replacements`              | Candidate UUID, expected customer and generation, client ID, delegated subject, service-account JSON |
| GET    | `/api/google-connection/candidates/:id`            | Actor-bound review metadata and expiry                                                               |
| POST   | `/api/google-connection/replacements/:id/activate` | Expected customer and generation, selected key ID, and `confirmed: true`                             |
| POST   | `/api/google-connection/credentials/rotate-key`    | Expected customer and generation, target key ID, and `confirmed: true`                               |
| POST   | `/api/google-connection/credentials/disconnect`    | Expected customer and generation and `confirmed: true`                                               |

Configured key IDs identify configuration entries. They do not prove every replica can read each key.
An unavailable selected key fails without selecting another key automatically.
A failed response does not establish whether the transaction committed.
Refresh management metadata and candidate status before another attempt.

## Encryption-key procedure

The configuration retains the existing primary key fields and permits three additional keys.
Each identifier and secret reference must be distinct.
Each key contains exactly 32 bytes.
The primary key encrypts new candidates.
Renewal uses the active credential's committed key, independent of the configured primary key.

```json
{
  "googleConnection": {
    "keyId": "google-key-1",
    "encryptionKeySecretRef": {
      "provider": "file",
      "path": "/run/secrets/google-key-1"
    },
    "additionalKeys": [
      {
        "keyId": "google-key-2",
        "encryptionKeySecretRef": {
          "provider": "file",
          "path": "/run/secrets/google-key-2"
        }
      }
    ]
  }
}
```

Kubernetes uses the corresponding `provider`, `name`, and `key` secret reference.
All-Docker, hybrid, and Kubernetes renderers mount each configured key only for API and worker consumers.
Hybrid worker preparation lists the required key files for every declared worker host.

1. Create a separate 32-byte key with the installation's secret manager.
2. Retain the working key and add the new identifier and secret reference to `additionalKeys`.
3. Render the deployment and distribute its configuration and secret mounts to every API and worker consumer.
4. Restart those consumers so they read the updated configuration.
5. Verify each consumer can read its configured key files before activation.
6. Read current management metadata and confirm rotation to the new key ID.
7. Refresh management metadata and verify the new key ID and generation.
8. Verify customer reads from API and worker consumers after restart.
9. Make the new key the primary configuration entry on every consumer.
10. Retain previous keys until no current candidate needs them and the backup retention decision permits removal.
11. Remove retired key mounts and restart consumers with the final configuration.

Rotation reencrypts the active service-account credential and invalidates cached access tokens.
It preserves historical capability observations and any background failure requiring recovery.
It does not revalidate Google access.

## Interrupted rotation and missing keys

If the request ends without a response, read management metadata before retrying.
An unchanged generation and key indicate no committed rotation.
The new generation and target key identify a committed rotation.
A different generation requires a new review.
The security event records the committed transition.

If a replica lacks the committed key, restore the correct secret mount or remove that replica from service.
Do not overwrite a key file with different bytes while retaining its identifier.
If the primary configuration entry names a lost key, configure an available key as primary before starting replacement.
Restart consumers after configuration changes.

A fresh verified replacement can recover access without the lost encryption key.
Stage fresh service-account credentials for the same customer and explicitly select an available key for activation.
The application does not decrypt the retired credential during this recovery.
Without fresh Google credentials or the original encryption key, the encrypted credential remains unreadable.
Customer settings and application sign-in remain available.

## Local disconnect and provider revocation

Local disconnect erases current application credential material and cached tokens.
It preserves the stable customer binding, settings, grants, and security events.
Diagnostics displays a local disconnected state and retains historical Google observations.
Checks remain disabled until a verified replacement restores access.
Application sign-in retains its separate web OAuth client.

Google documents DWD client deletion as removing authorization for applications that depend on that client.
The administrator must review every application using that service-account client before deletion.
Google also documents that multi-party approval applies when the organization enables it.
See [Control API access with domain-wide delegation](https://knowledge.workspace.google.com/admin/apps/control-api-access-with-domain-wide-delegation).

Deleting a service-account key does not revoke short-lived credentials already issued from that key.
See [Create and delete service-account keys](https://docs.cloud.google.com/iam/docs/keys-create-delete).
These provider actions differ from deleting Campus Commander ciphertext or rotating its encryption key.
The application performs neither provider action automatically.
The controlled DWD and service-account revocation tests remain unqualified.

Database erasure removes live rows and references.
It does not erase database backups, transaction logs, downloaded source key files, or external copies.
Apply the installation's retention and erasure procedures to those materials separately.
Retain required backup keys through an approved recovery process outside the database.

## Qualification status

Local builds, lint, unit tests, type checks, bootstrap tests, and nine health browser cases pass.
The browser cases include local disconnection, historical observations, disabled checks, both themes, accessibility, zoom, and reflow.
Applicable UI rules: UI-01 through UI-10 and FORM-01.
Full browser management, keyboard flow, and human screen-reader qualification remain pending.

[Initial full qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35167506732) passed all seven jobs at `c8ed1aa`.
The downloaded report confirms packaged Phase 3 execution at that revision.
The PostgreSQL lifecycle tests passed in that run.
Those tests cover replacement failure, customer mismatch, competing activation, audit rollback, renewal races, rotation, disconnect, and reconnection.
Subsequent review corrections require final hosted qualification.

The [source run at 2ba997c](https://github.com/CampusCommander/campus-commander/actions/runs/35167887959) passed all ten new API/worker lifecycle checks.
Its downloaded lifecycle report confirms recovery while the active key file was absent.
The complete suite failed afterward because an earlier worker fixture still expected generation one.
Revision `8372b3c` places lifecycle qualification after that worker fixture.

[Corrected source qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35168181689) and [full qualification](https://github.com/CampusCommander/campus-commander/actions/runs/35168183456) are running.
The final packaged revision and all Phase 3 deployment profiles remain separate evidence.
Live replacement requires a second approved administrator or a separately approved replacement credential.
No Education test customer is available.
