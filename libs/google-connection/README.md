# Google connection server library

CC-46 owns this server library. The API and worker will use its credential boundary.
The credential proof already uses the shared service-account validator.

`validateServiceAccount` accepts a Google service account with an exact client ID, fixed token endpoint, and RSA key of at least 2048 bits.
It removes unrelated input fields and reports bounded errors without credential values.

`CredentialCipher` encrypts a delegated credential with AES-256-GCM and a fresh 96-bit IV.
Callers provide a 256-bit key and its version identifier from storage outside PostgreSQL.
Authenticated data binds ciphertext to the record ID, customer ID, generation, key version, and envelope format.
Callers must obtain that context from their authorized database transaction.
Changing customer identity or generation requires a new envelope.
Changing a key requires decryption with the old key and encryption with the new key.

This library does not authorize requests, store credentials, coordinate renewal, or change database generations.
CC-46 must implement those boundaries before exposing connection workflows.
The proof file store remains separate from production storage.

Run `npm exec nx run google-connection:test` for synthetic-key tamper and recovery checks.
No test reads the controlled Workspace credential.
