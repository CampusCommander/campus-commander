# V0 threat model

**Status: design draft. Controls and denial tests remain implementation requirements.**

## Scope and trust boundaries

The installation owns one Google customer account with multiple supported domains and school-scoped application grants.
Assets include credentials, entity data, approved changes, operation evidence, audit records, artifacts, and backup recovery keys.
Actors include district administrators, school administrators, viewers, connection identities, workers, platform operators, and unauthenticated network clients.

| Boundary | Trusted decision maker | Untrusted input |
|---|---|---|
| Browser to API | API identity and authorization layer | Entity IDs, filters, selection tokens, edits, callback data, filenames |
| API to job service | Durable preview and acceptance contract | Replayed submissions, stale permissions, altered manifests |
| Kestra to workers | Authenticated dispatch and durable assignment ledger | Duplicate delivery, stale attempt, altered manifest reference |
| Workers to Google | Credential provider and capability handler | Provider failures, ambiguous responses, partial batches |
| Worker observations to job service | Authenticated event ingestion and attempt validation | Duplicate, late, reordered, or forged recovery reports |
| Services to artifact storage | Publication metadata and storage adapter | Paths, locators, partial bytes, stale attempts |
| Live system to backup | Operations procedure and protected recovery material | Older state, absent encryption keys, restored pending work |

District host administrators control the running software and local files.
Local database audit records cannot independently prove integrity against a host administrator who rewrites both data and evidence.
Independent evidence requirements need district-controlled external retention or another separately administered destination.

## Threats, controls, and required evidence

| ID | Threat and effect | Required control | Denial or recovery evidence |
|---|---|---|---|
| T01 | Cross-school entity ID exposes a record | Apply current grants to detail, search, counts, suggestions, and exports | Deny direct IDs and indirect counts outside the granted school |
| T02 | Stored selection expands into unauthorized writes | Freeze targets and changes. Recheck permission at confirmation and dispatch. | Revoke a grant after preview and deny unauthorized dispatch |
| T03 | OAuth callback substitution connects another identity | Validate single-use state and exact callback. Verify customer identity. | Reject replayed state, changed callback, and wrong-customer replacement |
| T04 | Logs or artifacts disclose Google credentials | Encrypt refresh credentials. Redact headers and token bodies. Separate keys from backups. | Search logs, diagnostics, flows, and artifacts for seeded secret markers |
| T05 | Unauthenticated worker endpoint starts changes | Authenticate service calls and restrict internal networks | Reject missing credentials, wrong audience, and unauthorized assignment identity |
| T06 | Duplicate or stale dispatch repeats a Google mutation | Durable identity, manifest digest, attempt fencing, and per-operation outcomes | Duplicate requests start one assignment. Old attempts cannot publish results. |
| T07 | Late recovery clears another job's backoff | Job-service validation and atomic owner/revision transitions | Reorder and duplicate events across two service instances |
| T08 | Artifact locator accesses another file or job | Opaque IDs, generated locators, backend path constraints, and current grants | Reject traversal, unauthorized IDs, stale links, and unpublished artifacts |
| T09 | Crafted CSV or query exhausts resources | Bound parser memory, input size, query cost, and concurrent work | Reject over-budget inputs while interactive reads continue |
| T10 | CSV output executes spreadsheet formulas | Define literal-cell export handling and preserve raw evidence separately | Open formula-like fixture values using supported spreadsheet workflows |
| T11 | Incomplete synchronization hides valid entities | Publish only complete authorized coverage with explicit freshness | Interrupted enumeration cannot silently remove unseen entities |
| T12 | Restore replays uncertain remote effects | Quarantine unresolved operations and reconcile before dispatch | Restore between remote acceptance and local result commit |
| T13 | Compromised images or dependencies alter administration | Pin releases, verify integrity, maintain dependency and image review | Verify published artifacts and reject altered release material |
| T14 | Session theft retains access after revocation | Secure cookies, server-side revocation, CSRF protection, and scoped event replay | Logout and grant revocation invalidate protected requests and streams |
| T15 | Exposed Kestra control plane permits arbitrary workflow execution | Restrict control-plane access and available execution capabilities | Public edge cannot reach Kestra or administrative worker operations |

## Evidence from this run

The Redis probe supports part of T07 through atomic ownership and revision checks.
It does not test event authenticity, ordering across service instances, or terminal-job rejection.
The operation probe supports part of T06/T12 through uncertainty preservation and stale-epoch rejection.
The storage probe supports part of T08 through publication state and checksum checks.
The query probe tested one school predicate. It does not establish the full T01 permission boundary.

## Decisions required before dependent implementation

1. Define session lifetime, revocation, and account recovery in P9.1.
2. Define service credential issuance and rotation before worker endpoints accept requests.
3. Define approval requirements and permission rechecks before P2.2 dispatch.
4. Define archive retention and independent evidence requirements with district operators.
5. Define restoration behavior for credentials, Redis state, Kestra state, and unresolved Google effects.

The implementation lead owns these tests. District security staff review policy choices for their deployment.
This document supplies an initial threat model. It does not claim an independent security assessment or compliance certification.
