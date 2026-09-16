# Google connection server library

CC-46 owns the credential and provider boundary.
The API uses this library for encrypted staging and customer verification.
API and worker processes share its database-coordinated token provider.
The credential proof uses its shared service-account validator.

`validateServiceAccount` checks the expected client ID, fixed Google token endpoint, and RSA strength.
It removes unrelated fields and reports bounded errors without credential values.

`CredentialCipher` uses AES-256-GCM with a fresh 96-bit IV and an external 256-bit key.
Authenticated data binds ciphertext to its record, customer, generation, key version, and envelope format.
Changing that context requires a new envelope.

`GoogleCustomerVerifier` checks exact customer and domain read-only scopes and returns validated observations.
Requests use fixed endpoints, deadlines, response limits, and no retries or redirects.
Provider failures expose bounded categories without response payloads.

Database functions enforce current authority, candidate expiry, confirmation, and atomic security events.
`GoogleConnectionProvider` coordinates encrypted token reuse and renewal through a database lease.
It rejects stale credential generations and separates token ciphertext from service-account ciphertext.
Permanent failures require operator retry authorization.
Transient failures enforce a thirty-second cooldown.
The [connection contract](../../docs/portfolio/phase-3-google-connection.md) records the implementation and remaining scope.

Run `npm exec nx run google-connection:test` for synthetic credential and provider checks.
Tests do not read the controlled Workspace credential.
