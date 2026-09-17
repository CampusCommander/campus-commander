# Phase 3 recovery and erasure checklist

Use this checklist with the [cold backup and isolated restore procedure](README.md).
It defines operator checks. It does not establish completed district qualification or release acceptance.
The [recovery evidence record](../../docs/portfolio/phase-3-recovery.md) separates completed tests from remaining tests.

## Inventory before backup

Prepare the inventory before stopping the source.
After all writers stop, record final counts, stable identities, revisions, timestamps, and protected comparison hashes.
Keep row contents and identity details in the protected operator record.
Exclude credentials, tokens, cookies, invitation links, and encryption keys from Jira, support bundles, and public evidence.

| State                                     | Source                                               | Expected restore behavior                                                                                 |
| ----------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Customer binding and committed credential | `cc.google_connection`, `cc.google_credentials`      | Preserve customer ID, credential ID, generation, key ID, and ciphertext before revalidation.              |
| Settings and settings receipts            | `cc.customer_settings_revisions`                     | Preserve every revision, request ID, settings value, and saved time.                                      |
| Onboarding progress                       | Customer binding and settings revisions              | Preserve confirmation times. Google revalidation creates a new observation time.                          |
| Principals and grants                     | `cc.application_principals`, `cc.application_grants` | Preserve stable identity bindings, enabled state, permission versions, preferences, and scoped grants.    |
| Access-change receipts                    | `cc.application_access_changes`                      | Preserve receipt IDs, previous and resulting versions, grants, and school revisions.                      |
| Schools                                   | `cc.school_definitions`                              | Preserve stable school IDs, rules, revisions, and approved OU IDs.                                        |
| School reviews                            | `cc.school_reviews`                                  | Preserve applied reviews. Expire pending reviews before target access.                                    |
| School observations                       | `cc.school_reference_state`                          | Preserve historical observations. Clear leases. Require a new observation before effective scope resumes. |
| Google health observations                | `cc.google_capability_health`                        | Preserve recorded observations as history. Do not treat their timestamps as a new check.                  |
| Credential candidates                     | `cc.google_credential_candidates`                    | Expire verifying and ready candidates. Erase their encrypted credential material.                         |
| Provider caches and active checks         | `cc.google_access_tokens`, `cc.google_health_checks` | Delete restored rows. Acquire new leases only after revalidation.                                         |
| Invitations                               | `cc.application_invitations`                         | Revoke issued, redeeming, and pending invitations. Preserve terminal invitations.                         |
| Bootstrap access                          | `cc.bootstrap_access`                                | Revoke restored bootstrap credentials. Recover operator access through the replacement procedure.         |
| Security events                           | `cc.security_events`                                 | Preserve original events. Add recovery events with the restore correlation ID.                            |
| Restore gate                              | `cc.google_restore_gate`                             | Create a new gate for an active connection. Keep it closed until revalidation succeeds.                   |
| Browser admission state                   | Redis                                                | Discard source sessions, pending sign-ins, and pending invitation authorization transactions.             |
| Artifacts and Kestra state                | Both database inventories and both storage trees     | Preserve application artifact identities, bytes, checksums, and Kestra execution state.                   |

Record the secret references separately from the backup inventory.
Include the backup key, committed Google credential key, additional key IDs, and service authentication material.
Also include sign-in client credentials, TLS keys, database credentials, Redis credentials, Kestra encryption material, and worker credentials.
Test retrieval through the independent recovery store. A successful database backup does not establish key recovery.

## Interrupted restore

1. Keep source and target identities in the protected incident record.
2. Keep the failed target isolated and prevent service startup.
3. Preserve `RESTORE_DISABLED`, protected reports, and the fixed CLI failure code.
4. Compare the completed components with the restore inventory.
5. Provision new empty databases before retrying `restore`.
6. Select a new, nonexistent target directory path.
7. Investigate and erase the failed target through the approved retention procedure.

A failed target contains sensitive data, including plaintext dumps when cleanup did not complete.
Do not remove its marker or reuse partially restored databases to bypass validation.
The restore command never rolls back the complete set of databases and storage trees as one transaction.

A receipt-write failure after Google revalidation has a different recovery path.
The database already contains the verified gate and audit event.
Keep services stopped, correct receipt storage, and repeat `revalidate-google` with the same saved target inputs.
The command reconstructs the original receipt. It does not contact Google again.

## Operator access recovery

Use the protected migration connection and [application access inspection](../bootstrap/APPLICATION-ACCESS.md#advanced-enrollment-and-access-inspection).
Inspect the intended principal's stable ID, issuer, subject, enabled state, and current permission version.
Verify the identity through the configured identity provider. An email address does not replace a provider subject.

If the principal needs a replacement identity, use the documented [replace request](../bootstrap/APPLICATION-ACCESS.md#revoke-and-recover-access).
Replacement preserves the principal ID, preferences, and permissions. It advances the permission version and records an audit event.
Do not initialize another principal over an existing installation.
Confirm additional platform authority only through the [Phase 3 administrator procedure](../bootstrap/PHASE-3-ACCESS.md).
An identity replacement does not require granting additional platform authority.

Recover bootstrap access through the [installer replacement procedure](../installer/README.md#upgrade-and-lifecycle).
Bootstrap credentials and application administrator identities serve separate purposes.
Keep migration credentials outside application runtime containers.

## Credential review and target release

1. Confirm the restored customer ID against the approved source record.
2. Confirm the committed credential ID, generation, and recorded encryption key ID.
3. Recover the recorded key at its configured secret reference.
4. Run `revalidate-google` when the restore report requires it.
5. Compare the receipt's recovery ID, customer ID, and generation with the restore report.
6. Verify preserved state against the inventory above.
7. Create fresh Redis and verify its configured authentication and transport.
8. Record a controlled validation plan before starting application services.
9. Verify fresh sign-in, previous-session denial, expired invitations, settings receipts, and scoped access during controlled validation.
10. Refresh Google health and school references before accepting current capability or effective scope results.
11. Record operator acceptance before enabling ordinary access and dispatch.

Keep the saved target configuration unchanged during revalidation.
A missing key, rejected credential, changed privilege, or wrong customer does not authorize opening the database gate manually.
The current restore command requires recovery of the recorded committed key and credential.
It does not provide an offline replacement path when those prerequisites cannot be recovered.

Include the target in the installer's `restoreDirectories` before using installer startup commands.
The installer refuses startup while the marker exists. Direct profile commands do not enforce that check.
Controlled browser validation requires an operator-managed isolated service start after database and key verification.
Retain the marker during that validation and keep ordinary access and dispatch disabled through deployment controls.
Record the controls and results. Remove the marker only after acceptance, then resume through the installation profile.
This checklist does not qualify the deployment controls or authorize production release.

## Erasure inventory

Stop and uninstall preserve durable data. Explicit installer erasure covers only the resources recorded as installer-owned.
Use the [installer erasure contract](../installer/README.md#upgrade-and-lifecycle) with the exact project or namespace confirmation.
Review external resources separately before deletion.

| Material                    | Required ownership and retention review                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Owned volumes and claims    | Confirm installation ownership and the storage provider's retention behavior.                                                |
| External databases          | Include live tables, replicas, transaction logs, snapshots, and database backups.                                            |
| Artifact and Kestra storage | Include external trees, object versions, snapshots, exports, and failed restore copies.                                      |
| Operator files              | Include profiles, installation state, protected identity records, reports, source credential downloads, and temporary dumps. |
| Redis                       | Include instances, persistence files, replicas, and snapshots containing source admission state.                             |
| Encryption and service keys | Review every retained backup and every shared consumer before deleting key material.                                         |
| Google provider access      | Review DWD authorization and service-account keys through the provider's administrative procedure.                           |
| Sign-in provider access     | Review the separate web client and other applications that use it.                                                           |
| Evidence and support copies | Apply the approved retention policy to local, CI, issue-tracker, and operator copies.                                        |

Local Google disconnect erases application credential material and cached tokens.
It preserves customer settings, grants, and security history. It does not revoke provider access or erase historical backups.
See [credential lifecycle limits](../../docs/portfolio/phase-3-credential-lifecycle.md#local-disconnect-and-provider-revocation).
Record completed erasures and retained exceptions without secret values.
Do not report complete erasure while external copies or shared key dependencies remain unresolved.

## Acceptance record

Record the source revision, immutable image inventory, command, restore identity, operator identity, and environment limits.
Record source stop time, backup creation time, verification time, controlled service start, and acceptance time.
Calculate backup age at acceptance and elapsed recovery time from those recorded timestamps.
Include inventory comparisons, denial results, recovered-key IDs, remaining failures, and retained erasure exceptions.
Synthetic fixture timings do not establish district recovery objectives.
