# Google batch service decision record

Status: owner-confirmed 2026-10-07. The owner requested the service directly.
Source: owner interview with Claude on 2026-10-07, questions Q1 through Q16
Branch: `codex/batch-service`, from `codex/devices-ui`
Related: [entity cache record](2026-10-06-entity-cache-decisions.md), decision D15

This record captures the decisions reached in one interview.
It is infrastructure for the entity sync job. It is not a new workflow.

## Purpose

Send many Google Admin API calls of one resource type through the multipart batch endpoint.
Each call resolves on its own. A call with a retryable failure or a next page goes into a later batch.
The service returns when every call has resolved. It aggregates successes and failures by caller ID.

Google batch facts, verified 2026-10-07 against the [Directory batch guide](https://developers.google.com/workspace/admin/directory/v1/guides/batch):

- One batch holds at most 1,000 calls. A batch of n calls costs n quota units.
- Google runs the calls in any order. Response parts carry `response-` plus the request Content-ID.
- Outer headers apply to every part. A part header overrides the outer header of the same name, Authorization included.
- The guide describes no outer-request auth failure. Auth failures arrive on the parts.

## Current state the decisions replace

- `GoogleDeviceReader.deviceBatch` sends one multipart batch of up to 1,000 device gets.
  One quota part fails the whole batch. Every non-404 failure fails the whole batch.
- The worker wraps `deviceBatch` and `batteryBatch` in a loop that retries quota answers until success.
- The two reader pagers retry a quota page until success or abort.

## Decisions

### B1. A plain class in the Google connection library (Q1)

The service lives in `libs/google-connection/src/lib/batch.ts`. It has no decorators and no parameter properties.
Node type stripping rejects both, and `node:test` files import this file directly.
The constructor takes one options object. A Nest provider wrapper goes into `api/` only when the API needs the service.

### B2. The multipart endpoint is the only transport (Q2)

The re-batch loop is the purpose of the service.
Each round sends the due calls, classifies every part, and collects final outcomes.
Retryable failures and next pages go back into the queue. The loop repeats until every call resolves.

### B3. One call holds one resource type and one parser (Q3)

The caller passes the batch URL, the requests, one parser, and the configuration.

| Request field | Meaning                                                  |
| ------------- | -------------------------------------------------------- |
| `id`          | caller key, unique within the call                       |
| `method`      | `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`               |
| `path`        | API-relative path, for example `/admin/directory/v1/...` |
| `query`       | optional query parameters                                |
| `body`        | optional JSON body for write methods                     |
| `headers`     | optional part headers                                    |

The service rejects duplicate IDs before it sends anything.
The service assigns its own Content-ID on each send and maps responses back to caller IDs.
Caller IDs never enter a multipart header.

The result holds two maps keyed by caller ID.
`succeeded` maps an ID to its parsed pages in page order.
`failed` maps an ID to its kind, HTTP status, Google reason, attempt counts, and response body.

### B4. Paging follows the `nextPageToken` convention (Q4)

The service reads `nextPageToken` from the raw body before it runs the parser.
A non-empty token queues the same request again with `query.pageToken` set.
One ID stops after 10,000 pages and fails with `invalid-response`.
A terminal failure on any page fails the whole ID and discards its earlier pages.
Callers shard list calls outside the service to keep page series short.

### B5. Batch size and concurrency (Q5)

`batchSize` defaults to 250. The service rejects a larger value.
`maxInFlight` defaults to 1. Kestra runs many batch runners in parallel outside the service.
The service has no quota manager. Google is the only source of quota state.
The service reacts to quota answers per part. This keeps access to Google's short-term burst capacity.

### B6. Part classification (Q6, Q16)

| Part outcome                                                              | Kind               | Handling                                    |
| ------------------------------------------------------------------------- | ------------------ | ------------------------------------------- |
| 200                                                                       | success            | parse the page, queue the next page         |
| 200 and the parser throws                                                 | `invalid-response` | fail the ID, no retry                       |
| 404                                                                       | `not-found`        | fail the ID, no retry                       |
| 429, or 403 `rateLimitExceeded`, `userRateLimitExceeded`, `quotaExceeded` | `quota`            | retry up to `maxQuotaRetries`, every method |
| 500, 502, 503, 504, or 403 `backendError`                                 | `transient`        | retry up to `maxTransientRetries`, see B8   |
| 401, or another 403 reason                                                | `auth`             | fail the ID, no retry                       |
| other 4xx                                                                 | `rejected`         | fail the ID, no retry                       |

An `auth` failure fails only its own part. Every other part in the batch resolves on its own.
A scope or org unit restriction on 5 of 30 devices fails those 5 and leaves 25 successes.

### B7. Outer request outcomes (Q6, Q7)

| Outer outcome                     | Handling                                                                    |
| --------------------------------- | --------------------------------------------------------------------------- |
| network error, 5xx, 429           | retry the whole batch, each part counter increases by one, B8 still applies |
| 401 or 403                        | fail every part in that batch with `auth`, queued parts continue            |
| 400 or a malformed multipart body | throw, because this is a defect in the service or the caller                |

Google does not document an outer auth failure. The 401 and 403 rule is defensive.

### B8. Transient retries skip unsafe writes (Q16)

A 5xx does not tell whether Google applied a write.
A POST with a transient failure fails with `transient` and no retry.
The caller sets `retryUnsafeWrites: true` for a POST that is safe to repeat.
Quota retries apply to every method, because Google rejected the call before it ran.

### B9. One token per call, minted on demand (Q8, Q11)

The configuration carries a function that mints a fresh client with a fresh token on each call.
The service calls it at the start and before any round 45 minutes or more after the last mint.
The outer Authorization header covers every part. A caller with two subjects makes two calls.
The client type needs only `request`. `OAuth2Client` satisfies it.
A mint failure fails every pending ID with `auth`.

### B10. Backoff (Q9)

| Setting               | Default |
| --------------------- | ------- |
| `initialDelayMs`      | 1,000   |
| `multiplier`          | 2       |
| `maxDelayMs`          | 60,000  |
| jitter                | full    |
| `maxQuotaRetries`     | 25      |
| `maxTransientRetries` | 10      |
| `honorRetryAfter`     | true    |

Full jitter waits a random time between zero and the computed delay.
A `Retry-After` value replaces the computed delay and stays under `maxDelayMs`.
Each ID keeps separate quota and transient counters. A new page resets both counters.
The run sleeps until the earliest due ID. No global pause exists.

An abort lets requests in flight settle. Pending IDs fail with `aborted`. The call resolves with the result.

### B11. Hooks observe outcomes (Q10)

`onResponse` fires for every part response, including responses that retry.
Its event holds the ID, the sent request, the attempt counts, the status, and the outcome.
The outcome is a success with the page and page index, a retry with the delay, or a final failure.
`onBatch` fires once per round with the round number, sent count, outer status, duration, and pending count.
Both hooks are awaited. A hook cannot change classification. A hook that throws rejects the call.

### B12. Scope of this branch (Q12, Q14, Q15)

- `deviceBatch` moves onto the service. A `not-found` ID becomes a missing device.
  Any other final failure fails the batch with the existing failure vocabulary.
- The worker drops its quota loop around `deviceBatch`. It extends the in-flight claim from `onBatch`.
  The claim lasts 120 seconds and the longest wait is 60 seconds.
- The worker telemetry loop and the two reader pagers stop after 25 quota retries and throw `quota`.
- Telemetry and the pagers stay off the service. Chrome Management does not document its batch endpoint.

The owner stated that quota retries were always meant to stop at 25. The "until success" text in D15 was drift.

### B13. Tests (Q13)

- Tests use a fake client returned by the token function. The fake parses each multipart body it receives.
  A script answers each part by caller ID and round. The fake returns parts in shuffled order.
- Tests inject `sleep`, `now`, and `random`. Tests assert exact attempt counts and due times.
- Cases cover resolution, retry, paging, run control, and hooks.
- The existing `deviceBatch` quota test changes to expect a retry and then success.
- One manual live check runs outside `nx test` against the approved Easton fixture.
  It batches `orgunits.get` for the two real OUs and one missing path under the org unit read scope.
  It records sanitized evidence of the wire format, Content-ID matching, 200 parsing, and 404 classification.
  Paging stays fake-only. No authorized live scope returns page tokens.

## Open items

- Write the implementation plan with the writing-plans skill before any code.
- No merge without owner authorization.
