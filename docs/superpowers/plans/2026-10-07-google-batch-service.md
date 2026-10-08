# Google Batch Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an API-agnostic Google multipart batch service that resolves every request on its own, with per-part retry, paging, hooks, and aggregated results, then move the entity sync device batch onto it.

**Architecture:** One plain TypeScript file, `libs/google-connection/src/lib/batch.ts`, holds the wire format, classification, backoff, and a `GoogleBatchService` class. A private `BatchRun` class owns one call's queue. Each round sends the due requests as one multipart POST, classifies every part, and requeues retries and next pages. `GoogleDeviceReader.deviceBatch` becomes a thin caller. The worker drops its own Directory quota loop and extends its Redis claim from the round hook.

**Tech Stack:** TypeScript under Node 24 type stripping, `node:test`, `google-auth-library` `OAuth2Client` as the HTTP client, Nx targets run through `npx nx`.

**Spec:** [docs/superpowers/specs/2026-10-07-google-batch-service-decisions.md](../specs/2026-10-07-google-batch-service-decisions.md). Read it before Task 1. Decision IDs B1 to B13 refer to it.

## Global Constraints

- `batch.ts` and `devices.ts` load directly under Node type stripping. Use no decorators, parameter properties, enums, or namespaces.
- Assign constructor fields explicitly. Do not write `constructor(private readonly x)`.
- Defaults, copied from B5 and B10: `batchSize` 250, hard cap 250, `maxInFlight` 1, `maxQuotaRetries` 25, `maxTransientRetries` 10.
- More defaults: `initialDelayMs` 1,000, `multiplier` 2, `maxDelayMs` 60,000, full jitter, `honorRetryAfter` true, `maxPages` 10,000.
- Token renewal: mint again before any round 45 minutes or more after the last mint.
- The service has no quota manager and no global pause. Google is the only source of quota state.
- An `auth` part fails only its own request. Sibling parts resolve on their own.
- The service assigns Content-IDs `cc-<n>`. Caller IDs never enter a multipart header.
- A POST does not retry a transient failure unless the call sets `retryUnsafeWrites: true`. Quota retries apply to every method.
- Hooks observe only. A hook that throws rejects `execute`.
- Run Nx through npm: `npx nx run <project>:<target>`.
- Run one test file with `node --import ./libs/application-contracts/test-register.mjs --test <file>`.
- Documentation follows the AGENTS.md writing rules: no semicolons, no contractions, no hedging, at most 20 words per instruction sentence.
- The live check is read-only. Never print, log, or commit the service-account file contents.
- Commit on `codex/batch-service` only. Do not merge or push. End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Duplicate device IDs in one worker slice.** The service rejects duplicate IDs. `deviceBatch` must send one part per device and still return each device once. Task 5 pins this.
2. **Caller IDs with `>`, spaces, or line breaks.** The call must resolve under the original ID because the ID never enters a header. Task 3 pins this.
3. **CR or LF inside a path or header value.** The service must reject the request before it sends anything, so no caller can inject a part. Task 1 pins this.
4. **A reply part with an unknown Content-ID, or no reply for a sent part.** The unknown part is ignored. The unanswered request retries as `transient` with reason `missing-part`. Task 3 pins this.
5. **A part whose body is HTML instead of JSON.** The status still classifies the part, and siblings resolve normally. Tasks 1 and 3 pin this.

## File Structure

| File                                                              | Responsibility                                                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `libs/google-connection/src/lib/batch.ts` (create)                | Types, validation, wire format, classification, backoff, `GoogleBatchService`, `BatchRun` |
| `libs/google-connection/src/lib/batch-fake.mjs` (create)          | Test double for the batch endpoint, test clock, request helper. Not a test file.          |
| `libs/google-connection/src/lib/batch-wire.test.mjs` (create)     | Task 1 tests                                                                              |
| `libs/google-connection/src/lib/batch-classify.test.mjs` (create) | Task 2 tests                                                                              |
| `libs/google-connection/src/lib/batch.test.mjs` (create)          | Task 3 tests                                                                              |
| `libs/google-connection/src/lib/batch-run.test.mjs` (create)      | Task 4 tests                                                                              |
| `libs/google-connection/src/index.ts` (modify)                    | Export the service and its types                                                          |
| `libs/google-connection/src/lib/devices.ts` (modify)              | `deviceBatch` on the service, pager quota cap                                             |
| `libs/google-connection/src/lib/devices.test.mjs` (modify)        | Device batch and pager tests                                                              |
| `worker/src/entity-sync.ts` (modify)                              | Drop the Directory quota loop, extend the claim per round, cap telemetry retries          |
| `worker/src/entity-sync.test.mjs` (modify)                        | Worker tests                                                                              |
| `deployment/google-proof/batch-live.mjs` (create)                 | Manual read-only live check                                                               |
| `deployment/evidence/batch-service-live-<date>.json` (create)     | Sanitized live evidence                                                                   |

The test target glob is `libs/google-connection/src/lib/*.test.mjs`. `batch-fake.mjs` does not match it.

---

### Task 1: Wire format, request validation, and options

**Files:**

- Create: `libs/google-connection/src/lib/batch.ts`
- Test: `libs/google-connection/src/lib/batch-wire.test.mjs`
- Commit also: `docs/superpowers/specs/2026-10-07-google-batch-service-decisions.md`, `docs/superpowers/specs/2026-10-06-entity-cache-decisions.md`, `docs/current-work.md`, this plan

**Interfaces:**

- Consumes: nothing.
- Produces, all exported from `batch.ts`:
  - Types `BatchMethod`, `BatchRequest`, `BatchFailureKind`, `BatchAttempts`, `BatchFailure`, `BatchResult<T>`, `BatchHttpResponse`, `BatchHttpClient`, `BatchOptions`, `BatchOutcome<T>`, `BatchResponseEvent<T>`, `BatchRoundEvent`, `BatchCall<T>`, `BatchPartResponse`, `BatchServiceErrorCode`.
  - Constants `BATCH_SIZE_LIMIT = 250`, `TOKEN_RENEWAL_MS = 2_700_000`, `BATCH_DEFAULTS`.
  - `class BatchServiceError extends Error { readonly code: BatchServiceErrorCode }`.
  - `validateRequests(requests: readonly BatchRequest[]): void`.
  - `resolveOptions(overrides?: Partial<BatchOptions>): BatchOptions`.
  - `buildMultipartBody(parts: readonly { contentId: string; request: BatchRequest }[], boundary: string): string`.
  - `parseMultipartResponse(contentType: string, text: string): BatchPartResponse[]`.
  - `decodeBody(text: string): unknown`.
  - `headerValue(headers: unknown, name: string): string | undefined`.

- [ ] **Step 1: Commit the decision records**

The decision record, the entity-cache correction, the current-work line, and this plan are uncommitted on the branch.

```bash
git add docs/superpowers/specs/2026-10-07-google-batch-service-decisions.md docs/superpowers/specs/2026-10-06-entity-cache-decisions.md docs/current-work.md docs/superpowers/plans/2026-10-07-google-batch-service.md
git commit -m "docs: record the Google batch service decisions and plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Write the failing tests**

Create `libs/google-connection/src/lib/batch-wire.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BATCH_DEFAULTS,
  buildMultipartBody,
  headerValue,
  parseMultipartResponse,
  resolveOptions,
  validateRequests,
} from './batch.ts';

const get = (id, extra = {}) => ({
  id,
  method: 'GET',
  path: `/admin/directory/v1/things/${encodeURIComponent(id)}`,
  ...extra,
});

test('buildMultipartBody writes each request as one application/http part', () => {
  const body = buildMultipartBody(
    [
      {
        contentId: 'cc-1',
        request: get('a', { query: { projection: 'full', maxResults: 5 } }),
      },
      {
        contentId: 'cc-2',
        request: {
          id: 'b',
          method: 'PATCH',
          path: '/admin/directory/v1/users/b',
          headers: { 'If-Match': 'etag-1' },
          body: { suspended: true },
        },
      },
    ],
    'batch_x',
  );
  assert.equal(
    body,
    '--batch_x\r\nContent-Type: application/http\r\nContent-ID: <cc-1>\r\n\r\n' +
      'GET /admin/directory/v1/things/a?projection=full&maxResults=5\r\n\r\n' +
      '--batch_x\r\nContent-Type: application/http\r\nContent-ID: <cc-2>\r\n\r\n' +
      'PATCH /admin/directory/v1/users/b\r\nIf-Match: etag-1\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n{"suspended":true}\r\n' +
      '--batch_x--\r\n',
  );
});

test('parseMultipartResponse reads the content id, status, headers, and body of each part', () => {
  const text = [
    '--batch_reply',
    'Content-Type: application/http',
    'Content-ID: <response-cc-2>',
    '',
    'HTTP/1.1 429 Too Many Requests',
    'Content-Type: application/json; charset=UTF-8',
    'Retry-After: 7',
    '',
    '{"error":{"code":429,"errors":[{"reason":"rateLimitExceeded"}]}}',
    '',
    '--batch_reply',
    'Content-Type: application/http',
    'Content-ID: <response-cc-1>',
    '',
    'HTTP/1.1 204 No Content',
    '',
    '',
    '--batch_reply--',
    '',
  ].join('\r\n');
  assert.deepEqual(
    parseMultipartResponse('multipart/mixed; boundary=batch_reply', text),
    [
      {
        contentId: 'cc-2',
        status: 429,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'retry-after': '7',
        },
        body: {
          error: { code: 429, errors: [{ reason: 'rateLimitExceeded' }] },
        },
      },
      { contentId: 'cc-1', status: 204, headers: {}, body: null },
    ],
  );
});

test('parseMultipartResponse accepts a quoted boundary and keeps a non-JSON body as text', () => {
  const text = [
    '--reply',
    'Content-Type: application/http',
    'Content-ID: <response-cc-7>',
    '',
    'HTTP/1.1 503 Service Unavailable',
    'Content-Type: text/html',
    '',
    '<html>busy</html>',
    '',
    '--reply--',
    '',
  ].join('\r\n');
  assert.deepEqual(
    parseMultipartResponse('multipart/mixed; boundary="reply"', text),
    [
      {
        contentId: 'cc-7',
        status: 503,
        headers: { 'content-type': 'text/html' },
        body: '<html>busy</html>',
      },
    ],
  );
});

test('parseMultipartResponse rejects a reply that is not multipart or lacks a Content-ID or status', () => {
  assert.throws(() => parseMultipartResponse('application/json', '{}'), {
    name: 'BatchServiceError',
    code: 'malformed-response',
  });
  const noId = [
    '--b',
    'Content-Type: application/http',
    '',
    'HTTP/1.1 200 OK',
    '',
    '{}',
    '--b--',
    '',
  ].join('\r\n');
  assert.throws(
    () => parseMultipartResponse('multipart/mixed; boundary=b', noId),
    {
      name: 'BatchServiceError',
      code: 'malformed-response',
    },
  );
  const noStatus = [
    '--b',
    'Content-Type: application/http',
    'Content-ID: <response-cc-1>',
    '',
    'garbage',
    '',
    '{}',
    '--b--',
    '',
  ].join('\r\n');
  assert.throws(
    () => parseMultipartResponse('multipart/mixed; boundary=b', noStatus),
    {
      name: 'BatchServiceError',
      code: 'malformed-response',
    },
  );
});

test('headerValue reads gaxios Headers and plain objects without regard to case', () => {
  assert.equal(
    headerValue(
      new Headers({ 'Content-Type': 'multipart/mixed' }),
      'content-type',
    ),
    'multipart/mixed',
  );
  assert.equal(headerValue({ 'Retry-After': '7' }, 'retry-after'), '7');
  assert.equal(headerValue(undefined, 'retry-after'), undefined);
});

test('validateRequests rejects duplicate ids and fields that would break the multipart body', () => {
  const bad = [
    [get('a'), get('a')],
    [get('')],
    [get('a', { method: 'HEAD' })],
    [get('a', { path: '/things/a\r\nGET /other' })],
    [get('a', { path: '/things/a?x=1' })],
    [get('a', { path: 'things/a' })],
    [get('a', { path: '//evil.example/a' })],
    [get('a', { body: { x: 1 } })],
    [get('a', { query: { n: Number.NaN } })],
    [get('a', { headers: { 'Content-ID': 'x' } })],
    [get('a', { headers: { 'X-Note': 'a\r\nb' } })],
    [get('a', { headers: { 'Bad Name': 'x' } })],
  ];
  for (const requests of bad)
    assert.throws(
      () => validateRequests(requests),
      { name: 'BatchServiceError', code: 'invalid-request' },
      JSON.stringify(requests),
    );
  validateRequests([
    get('odd>id\r\n'),
    get('b', {
      method: 'POST',
      body: { ok: true },
      headers: { 'If-Match': 'etag' },
      query: { n: 1, flag: true },
    }),
  ]);
});

test('resolveOptions applies the agreed defaults and rejects values out of range', () => {
  assert.deepEqual(BATCH_DEFAULTS, {
    initialDelayMs: 1_000,
    multiplier: 2,
    maxDelayMs: 60_000,
    maxQuotaRetries: 25,
    maxTransientRetries: 10,
    honorRetryAfter: true,
    batchSize: 250,
    maxInFlight: 1,
    maxPages: 10_000,
    retryUnsafeWrites: false,
  });
  assert.deepEqual(resolveOptions(), BATCH_DEFAULTS);
  assert.equal(resolveOptions({ batchSize: 100 }).batchSize, 100);
  for (const bad of [
    { batchSize: 251 },
    { batchSize: 0 },
    { batchSize: 1.5 },
    { maxInFlight: 0 },
    { maxPages: 0 },
    { maxQuotaRetries: -1 },
    { maxDelayMs: -1 },
    { multiplier: 0.5 },
  ])
    assert.throws(
      () => resolveOptions(bad),
      { name: 'BatchServiceError', code: 'invalid-option' },
      JSON.stringify(bad),
    );
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --import ./libs/application-contracts/test-register.mjs --test libs/google-connection/src/lib/batch-wire.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `batch.ts`.

- [ ] **Step 4: Write the implementation**

Create `libs/google-connection/src/lib/batch.ts`:

```ts
/**
 * Google multipart batch service. One call sends many API calls of one resource type.
 * Each call resolves on its own. Retries and next pages go into later batches.
 * Decisions: docs/superpowers/specs/2026-10-07-google-batch-service-decisions.md
 */

export type BatchMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** One Google API call inside a multipart batch. */
export interface BatchRequest {
  /** Caller key, unique within one call. It never enters a multipart header. */
  readonly id: string;
  readonly method: BatchMethod;
  /** API-relative path, for example `/admin/directory/v1/customer/C01/devices/chromeos/abc`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  /** JSON body. Only POST, PUT, and PATCH carry one. */
  readonly body?: unknown;
  /** Part headers. The service reserves every `Content-*` name. */
  readonly headers?: Readonly<Record<string, string>>;
}

export type BatchFailureKind =
  | 'not-found'
  | 'quota'
  | 'transient'
  | 'auth'
  | 'rejected'
  | 'invalid-response'
  | 'aborted';

/** Retries already performed for one request, by kind. */
export interface BatchAttempts {
  quota: number;
  transient: number;
}

export interface BatchFailure {
  kind: BatchFailureKind;
  /** HTTP status of the part or the outer response. 0 when no HTTP status exists. */
  status: number;
  /** Google `error.errors[0].reason`, a token mint code, or a service reason. */
  reason: string | null;
  attempts: BatchAttempts;
  body: unknown;
}

export interface BatchResult<T> {
  /** Caller ID to parsed pages, in page order. */
  succeeded: Map<string, T[]>;
  failed: Map<string, BatchFailure>;
}

export interface BatchHttpResponse {
  status?: number;
  headers?: unknown;
  data: unknown;
}

/** The only client surface the service uses. `OAuth2Client` satisfies it. */
export interface BatchHttpClient {
  request(options: {
    url: string;
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    responseType: 'text';
  }): Promise<BatchHttpResponse>;
}

export interface BatchOptions {
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  maxQuotaRetries: number;
  maxTransientRetries: number;
  honorRetryAfter: boolean;
  batchSize: number;
  maxInFlight: number;
  maxPages: number;
  retryUnsafeWrites: boolean;
}

export const BATCH_SIZE_LIMIT = 250;
export const TOKEN_RENEWAL_MS = 45 * 60_000;
export const BATCH_DEFAULTS: Readonly<BatchOptions> = Object.freeze({
  initialDelayMs: 1_000,
  multiplier: 2,
  maxDelayMs: 60_000,
  maxQuotaRetries: 25,
  maxTransientRetries: 10,
  honorRetryAfter: true,
  batchSize: BATCH_SIZE_LIMIT,
  maxInFlight: 1,
  maxPages: 10_000,
  retryUnsafeWrites: false,
});

export type BatchOutcome<T> =
  | { kind: 'success'; page: T; pageIndex: number; hasNextPage: boolean }
  | { kind: 'retry'; failure: BatchFailure; retryInMs: number }
  | { kind: 'failed'; failure: BatchFailure };

export interface BatchResponseEvent<T> {
  id: string;
  /** The request as sent, with `pageToken` for a later page. */
  request: BatchRequest;
  /** Retries so far on the current page, including a retry this event schedules. */
  attempts: BatchAttempts;
  /** Part status, outer status for a batch-level answer, or 0 without HTTP. */
  status: number;
  outcome: BatchOutcome<T>;
}

export interface BatchRoundEvent {
  round: number;
  sentCount: number;
  /** Outer HTTP status, or 0 without HTTP. */
  outerStatus: number;
  durationMs: number;
  /** Requests still unresolved after this round. */
  pending: number;
}

export interface BatchCall<T> {
  /** For example `https://www.googleapis.com/batch/admin/directory_v1`. */
  batchUrl: string;
  requests: readonly BatchRequest[];
  /** Parse one page. A throw fails that request with `invalid-response`. */
  parse(body: unknown, request: BatchRequest): T;
  /** Mint a client with a fresh token on every call. */
  getClient(signal: AbortSignal): Promise<BatchHttpClient>;
  signal: AbortSignal;
  options?: Partial<BatchOptions>;
  onResponse?(event: BatchResponseEvent<T>): void | Promise<void>;
  onBatch?(event: BatchRoundEvent): void | Promise<void>;
}

export type BatchServiceErrorCode =
  | 'invalid-request'
  | 'invalid-option'
  | 'malformed-response'
  | 'outer-rejected';

/** A defect in the caller input or the service. Google conditions never throw this. */
export class BatchServiceError extends Error {
  readonly code: BatchServiceErrorCode;

  constructor(code: BatchServiceErrorCode, message: string) {
    super(message);
    this.name = 'BatchServiceError';
    this.code = code;
  }
}

const METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);
const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Printable ASCII without spaces. The query travels in `query`. */
const PART_PATH = /^\/[!-~]*$/;

function invalidRequest(message: string): BatchServiceError {
  return new BatchServiceError('invalid-request', message);
}

/** Reject requests that collide on ID or would break the multipart body. */
export function validateRequests(requests: readonly BatchRequest[]): void {
  const seen = new Set<string>();
  for (const request of requests) {
    if (typeof request.id !== 'string' || request.id === '')
      throw invalidRequest('Every request needs a non-empty id.');
    if (seen.has(request.id))
      throw invalidRequest(
        `Request id ${JSON.stringify(request.id)} appears twice.`,
      );
    seen.add(request.id);
    if (!METHODS.has(request.method))
      throw invalidRequest(
        `Request ${JSON.stringify(request.id)} has an unsupported method.`,
      );
    if (
      !PART_PATH.test(request.path) ||
      request.path.startsWith('//') ||
      /[?#]/.test(request.path)
    )
      throw invalidRequest(
        `Request ${JSON.stringify(request.id)} needs an API-relative path without a query.`,
      );
    if (request.body !== undefined && !BODY_METHODS.has(request.method))
      throw invalidRequest(
        `Request ${JSON.stringify(request.id)} sends a body with ${request.method}.`,
      );
    for (const value of Object.values(request.query ?? {}))
      if (typeof value === 'number' && !Number.isFinite(value))
        throw invalidRequest(
          `Request ${JSON.stringify(request.id)} has a non-finite query value.`,
        );
    for (const [name, value] of Object.entries(request.headers ?? {}))
      if (
        !HEADER_NAME.test(name) ||
        /^content-/i.test(name) ||
        /[\r\n]/.test(value)
      )
        throw invalidRequest(
          `Request ${JSON.stringify(request.id)} has an invalid header ${JSON.stringify(name)}.`,
        );
  }
}

/** Merge overrides onto the defaults and reject values out of range. */
export function resolveOptions(
  overrides: Partial<BatchOptions> = {},
): BatchOptions {
  const options: BatchOptions = { ...BATCH_DEFAULTS, ...overrides };
  const whole = (
    name: keyof BatchOptions,
    min: number,
    max = Number.MAX_SAFE_INTEGER,
  ) => {
    const value = options[name];
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < min ||
      value > max
    )
      throw new BatchServiceError(
        'invalid-option',
        `${name} must be an integer from ${min} to ${max}.`,
      );
  };
  whole('batchSize', 1, BATCH_SIZE_LIMIT);
  whole('maxInFlight', 1);
  whole('maxPages', 1);
  whole('maxQuotaRetries', 0);
  whole('maxTransientRetries', 0);
  whole('initialDelayMs', 0);
  whole('maxDelayMs', 0);
  if (!Number.isFinite(options.multiplier) || options.multiplier < 1)
    throw new BatchServiceError(
      'invalid-option',
      'multiplier must be a finite number of at least 1.',
    );
  return options;
}

/** Serialize parts in the format of the Google batch guide. */
export function buildMultipartBody(
  parts: readonly { contentId: string; request: BatchRequest }[],
  boundary: string,
): string {
  return (
    parts
      .map(({ contentId, request }) => {
        const query = new URLSearchParams(
          Object.entries(request.query ?? {}).map(
            ([name, value]): [string, string] => [name, String(value)],
          ),
        ).toString();
        const lines = [
          `--${boundary}`,
          'Content-Type: application/http',
          `Content-ID: <${contentId}>`,
          '',
          `${request.method} ${request.path}${query ? `?${query}` : ''}`,
        ];
        for (const [name, value] of Object.entries(request.headers ?? {}))
          lines.push(`${name}: ${value}`);
        if (request.body === undefined) lines.push('');
        else
          lines.push(
            'Content-Type: application/json; charset=UTF-8',
            '',
            JSON.stringify(request.body),
          );
        return `${lines.join('\r\n')}\r\n`;
      })
      .join('') + `--${boundary}--\r\n`
  );
}

export interface BatchPartResponse {
  contentId: string;
  status: number;
  /** Part headers with lower-case names. */
  headers: Readonly<Record<string, string>>;
  /** Parsed JSON, the text when the body is not JSON, or null when empty. */
  body: unknown;
}

function malformed(message: string): BatchServiceError {
  return new BatchServiceError('malformed-response', message);
}

function splitOnce(text: string, separator: string): [string, string] | null {
  const index = text.indexOf(separator);
  return index < 0
    ? null
    : [text.slice(0, index), text.slice(index + separator.length)];
}

/** Parse JSON. Keep other text as a string. Return null for an empty body. */
export function decodeBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

/** Split a multipart/mixed batch reply into its HTTP parts. */
export function parseMultipartResponse(
  contentType: string,
  text: string,
): BatchPartResponse[] {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || !/^multipart\//i.test(contentType.trim()))
    throw malformed('The batch response is not multipart.');
  const parts: BatchPartResponse[] = [];
  for (const section of text
    .replace(/\r\n/g, '\n')
    .split(`--${boundary}`)
    .slice(1)) {
    if (section.startsWith('--')) break;
    if (section.trim() === '') continue;
    const envelope = splitOnce(section.replace(/^\n/, ''), '\n\n');
    const contentId = envelope
      ? /^content-id:\s*<response-([^>]+)>\s*$/im.exec(envelope[0])?.[1]
      : undefined;
    if (!envelope || !contentId)
      throw malformed('A batch response part has no Content-ID.');
    const message = splitOnce(envelope[1], '\n\n') ?? [envelope[1], ''];
    const [statusLine = '', ...headerLines] = message[0].split('\n');
    const status = Number(/^HTTP\/\d(?:\.\d)? (\d{3})\b/.exec(statusLine)?.[1]);
    if (!Number.isInteger(status))
      throw malformed(`Batch response part ${contentId} has no HTTP status.`);
    const headers: Record<string, string> = {};
    for (const line of headerLines) {
      const colon = line.indexOf(':');
      if (colon > 0)
        headers[line.slice(0, colon).trim().toLowerCase()] = line
          .slice(colon + 1)
          .trim();
    }
    parts.push({ contentId, status, headers, body: decodeBody(message[1]) });
  }
  return parts;
}

/** gaxios 7 returns a Headers instance. Test doubles return a plain object. */
export function headerValue(
  headers: unknown,
  name: string,
): string | undefined {
  if (headers === null || typeof headers !== 'object') return undefined;
  const lookup = (headers as { get?: unknown }).get;
  if (typeof lookup === 'function') {
    const value: unknown = lookup.call(headers, name);
    return typeof value === 'string' ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === name.toLowerCase() && typeof value === 'string')
      return value;
  return undefined;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import ./libs/application-contracts/test-register.mjs --test libs/google-connection/src/lib/batch-wire.test.mjs`
Expected: PASS, 7 tests.

Run: `npx nx run google-connection:typecheck`
Expected: success.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write libs/google-connection/src/lib/batch.ts libs/google-connection/src/lib/batch-wire.test.mjs
git add libs/google-connection/src/lib/batch.ts libs/google-connection/src/lib/batch-wire.test.mjs
git commit -m "feat: add the batch wire format, request validation, and options

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Part classification and backoff

**Files:**

- Modify: `libs/google-connection/src/lib/batch.ts` (append)
- Test: `libs/google-connection/src/lib/batch-classify.test.mjs`

**Interfaces:**

- Consumes: `BatchOptions`, `BatchFailureKind` from Task 1.
- Produces, exported from `batch.ts`:
  - `type PartKind = 'success' | 'not-found' | 'quota' | 'transient' | 'auth' | 'rejected'`.
  - `googleReason(body: unknown): string | null`.
  - `classifyStatus(status: number, body: unknown): { kind: PartKind; reason: string | null }`.
  - `retryAfterMs(value: string | undefined, now: number): number | null`.
  - `backoffDelay(retry: number, options: Pick<BatchOptions, 'initialDelayMs' | 'multiplier' | 'maxDelayMs'>, random: () => number): number`. `retry` is 1 for the first retry.
  - `nextPageToken(body: unknown): string | null`.

- [ ] **Step 1: Write the failing tests**

Create `libs/google-connection/src/lib/batch-classify.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  backoffDelay,
  classifyStatus,
  nextPageToken,
  retryAfterMs,
} from './batch.ts';

const reason = (why) => ({ error: { errors: [{ reason: why }] } });

test('classifyStatus separates success, missing, quota, transient, auth, and rejected parts', () => {
  const cases = [
    [200, {}, 'success'],
    [204, null, 'success'],
    [404, reason('notFound'), 'not-found'],
    [429, reason('rateLimitExceeded'), 'quota'],
    [429, null, 'quota'],
    [403, reason('rateLimitExceeded'), 'quota'],
    [403, reason('userRateLimitExceeded'), 'quota'],
    [403, reason('quotaExceeded'), 'quota'],
    [500, null, 'transient'],
    [502, '<html>bad gateway</html>', 'transient'],
    [503, reason('backendError'), 'transient'],
    [504, null, 'transient'],
    [403, reason('backendError'), 'transient'],
    [401, reason('authError'), 'auth'],
    [403, reason('forbidden'), 'auth'],
    [403, reason('insufficientPermissions'), 'auth'],
    [403, null, 'auth'],
    [400, reason('invalid'), 'rejected'],
    [409, reason('duplicate'), 'rejected'],
    [412, null, 'rejected'],
  ];
  for (const [status, body, kind] of cases)
    assert.equal(
      classifyStatus(status, body).kind,
      kind,
      `${status} ${JSON.stringify(body)}`,
    );
  assert.deepEqual(classifyStatus(403, reason('forbidden')), {
    kind: 'auth',
    reason: 'forbidden',
  });
  assert.deepEqual(classifyStatus(200, reason('ignored')), {
    kind: 'success',
    reason: null,
  });
  assert.equal(
    classifyStatus(429, { error: { status: 'RESOURCE_EXHAUSTED' } }).reason,
    'RESOURCE_EXHAUSTED',
  );
});

test('backoffDelay grows by the multiplier, caps at the maximum, and applies full jitter', () => {
  const options = { initialDelayMs: 1_000, multiplier: 2, maxDelayMs: 60_000 };
  assert.deepEqual(
    [1, 2, 3, 6, 7, 25].map((retry) => backoffDelay(retry, options, () => 0.5)),
    [500, 1_000, 2_000, 16_000, 30_000, 30_000],
  );
  assert.equal(
    backoffDelay(3, options, () => 0),
    0,
  );
  assert.equal(
    backoffDelay(30, options, () => 0.999999),
    59_999,
  );
});

test('retryAfterMs reads seconds and HTTP dates', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  assert.equal(retryAfterMs('7', now), 7_000);
  assert.equal(retryAfterMs('Wed, 07 Oct 2026 12:00:30 GMT', now), 30_000);
  assert.equal(retryAfterMs('Wed, 07 Oct 2026 11:59:00 GMT', now), 0);
  assert.equal(retryAfterMs(undefined, now), null);
  assert.equal(retryAfterMs('soon', now), null);
});

test('nextPageToken reads a non-empty string token only', () => {
  assert.equal(nextPageToken({ nextPageToken: 'p2' }), 'p2');
  assert.equal(nextPageToken({ nextPageToken: '' }), null);
  assert.equal(nextPageToken({ nextPageToken: 7 }), null);
  assert.equal(nextPageToken('text'), null);
  assert.equal(nextPageToken(null), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import ./libs/application-contracts/test-register.mjs --test libs/google-connection/src/lib/batch-classify.test.mjs`
Expected: FAIL with `does not provide an export named 'backoffDelay'`.

- [ ] **Step 3: Write the implementation**

Append to `libs/google-connection/src/lib/batch.ts`:

```ts
const QUOTA_REASONS: ReadonlySet<string> = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
]);

export type PartKind =
  | 'success'
  | 'not-found'
  | 'quota'
  | 'transient'
  | 'auth'
  | 'rejected';

/** Read `error.errors[0].reason`, or `error.status` from newer Google APIs. */
export function googleReason(body: unknown): string | null {
  const error =
    body !== null && typeof body === 'object'
      ? (body as { error?: unknown }).error
      : undefined;
  if (error === null || typeof error !== 'object') return null;
  const errors = (error as { errors?: unknown }).errors;
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  const reason =
    first !== null && typeof first === 'object'
      ? (first as { reason?: unknown }).reason
      : undefined;
  if (typeof reason === 'string') return reason;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}

/** Classify one HTTP answer. B6 in the decision record holds the table. */
export function classifyStatus(
  status: number,
  body: unknown,
): { kind: PartKind; reason: string | null } {
  if (status >= 200 && status < 300) return { kind: 'success', reason: null };
  const reason = googleReason(body);
  if (status === 404) return { kind: 'not-found', reason };
  if (
    status === 429 ||
    (status === 403 && reason !== null && QUOTA_REASONS.has(reason))
  )
    return { kind: 'quota', reason };
  if (status >= 500 || (status === 403 && reason === 'backendError'))
    return { kind: 'transient', reason };
  if (status === 401 || status === 403) return { kind: 'auth', reason };
  return { kind: 'rejected', reason };
}

/** Read a Retry-After value in seconds or as an HTTP date. */
export function retryAfterMs(
  value: string | undefined,
  now: number,
): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Exponential backoff with full jitter. `retry` is 1 for the first retry. */
export function backoffDelay(
  retry: number,
  options: Pick<BatchOptions, 'initialDelayMs' | 'multiplier' | 'maxDelayMs'>,
  random: () => number,
): number {
  const ceiling = Math.min(
    options.maxDelayMs,
    options.initialDelayMs * options.multiplier ** (retry - 1),
  );
  return Math.floor(random() * ceiling);
}

/** Read a non-empty `nextPageToken` before the caller parser runs. */
export function nextPageToken(body: unknown): string | null {
  const token =
    body !== null && typeof body === 'object'
      ? (body as { nextPageToken?: unknown }).nextPageToken
      : undefined;
  return typeof token === 'string' && token !== '' ? token : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import ./libs/application-contracts/test-register.mjs --test libs/google-connection/src/lib/batch-classify.test.mjs`
Expected: PASS, 4 tests.

Run: `npx nx run google-connection:typecheck`
Expected: success.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write libs/google-connection/src/lib/batch.ts libs/google-connection/src/lib/batch-classify.test.mjs
git add libs/google-connection/src/lib/batch.ts libs/google-connection/src/lib/batch-classify.test.mjs
git commit -m "feat: classify batch parts and compute backoff delays

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The re-batch loop, paging, and hooks

**Files:**

- Create: `libs/google-connection/src/lib/batch-fake.mjs`
- Modify: `libs/google-connection/src/lib/batch.ts` (add one import, append the service)
- Test: `libs/google-connection/src/lib/batch.test.mjs`

**Interfaces:**

- Consumes: everything from Tasks 1 and 2.
- Produces:
  - `interface GoogleBatchServiceOptions { sleep?(milliseconds: number, signal: AbortSignal): Promise<void>; now?(): number; random?(): number }`. `sleep` resolves early, without throwing, when the signal aborts.
  - `class GoogleBatchService { constructor(options?: GoogleBatchServiceOptions); execute<T>(call: BatchCall<T>): Promise<BatchResult<T>> }`.
  - Private `class BatchRun<T>` with methods `run`, `dueEntries`, `ensureClient`, `launch`, `send`, `resolveParts`, `resolvePart`, `acceptPage`, `retryOrFail`, `resolveFailure`, `reportRound`, `waitForProgress`, `abortPending`, `settle`. Task 4 edits `ensureClient` and `send`, and adds `outerFailure` and the `mintedAt` field.
  - Test helpers in `batch-fake.mjs`: `fakeGoogle(answer, { outer, delay })`, `perKey(table)`, `testClock()`, `thing(id, extra)`, `parseBatchRequest(options)`, `multipartReply(answers, boundary)`.

- [ ] **Step 1: Write the batch endpoint double**

Create `libs/google-connection/src/lib/batch-fake.mjs`:

```js
/**
 * Test double for a Google batch endpoint. It parses each multipart request and answers each part.
 * Replies come back in reverse order, so tests prove Content-ID matching.
 */
const crlf = '\r\n';

function splitOnce(text, separator) {
  const index = text.indexOf(separator);
  return index < 0
    ? [text, '']
    : [text.slice(0, index), text.slice(index + separator.length)];
}

/** Read the parts the service sent. `key` is the last path segment, decoded. */
export function parseBatchRequest(options) {
  const boundary = /boundary=([^;\s]+)/.exec(
    options.headers['content-type'],
  )[1];
  return options.body
    .split(`--${boundary}`)
    .slice(1)
    .filter((section) => !section.startsWith('--'))
    .map((section) => {
      const [outer, http] = splitOnce(
        section.replace(/^\r\n/, ''),
        crlf + crlf,
      );
      const contentId = /Content-ID: <([^>]+)>/.exec(outer)[1];
      const [head, rawBody] = splitOnce(http, crlf + crlf);
      const [line, ...headerLines] = head.split(crlf);
      const [method, target] = line.split(' ');
      const url = new URL(target, 'https://batch.invalid');
      const headers = Object.fromEntries(
        headerLines.map((header) => {
          const colon = header.indexOf(':');
          return [
            header.slice(0, colon).toLowerCase(),
            header.slice(colon + 1).trim(),
          ];
        }),
      );
      const text = rawBody.trim();
      return {
        contentId,
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        key: decodeURIComponent(url.pathname.split('/').at(-1)),
        headers,
        body: text ? JSON.parse(text) : undefined,
      };
    });
}

/** Build a multipart reply. Each answer is `{ contentId, status, body?, raw?, headers? }`. */
export function multipartReply(answers, boundary = 'batch_reply') {
  return (
    answers
      .map(({ contentId, status, body, raw, headers = {} }) =>
        [
          `--${boundary}`,
          'Content-Type: application/http',
          `Content-ID: <response-${contentId}>`,
          '',
          `HTTP/1.1 ${status} ${status < 300 ? 'OK' : 'Error'}`,
          'Content-Type: application/json; charset=UTF-8',
          ...Object.entries(headers).map(
            ([name, value]) => `${name}: ${value}`,
          ),
          '',
          raw ?? (body === undefined ? '' : JSON.stringify(body)),
          '',
        ].join(crlf),
      )
      .join('') + `--${boundary}--${crlf}`
  );
}

/**
 * `answer(part, round)` returns `{ status, body?, raw?, headers?, contentId? }`, or null to omit the part.
 * `outer(round, options)` returns undefined, an Error to throw, or `{ status, headers?, data? }`.
 * A non-2xx outer answer throws the way gaxios does, with `error.response`.
 */
export function fakeGoogle(answer, { outer, delay = false } = {}) {
  const sent = [];
  const requests = [];
  const state = { mints: 0, active: 0, maxActive: 0 };
  const client = {
    async request(options) {
      const round = requests.length;
      requests.push(options);
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        if (delay) await new Promise((resolve) => setImmediate(resolve));
        const parts = parseBatchRequest(options);
        sent.push(parts);
        const forced = outer?.(round, options);
        if (forced instanceof Error) throw forced;
        if (forced) {
          const response = {
            status: forced.status,
            headers: new Headers(forced.headers ?? {}),
            data: forced.data ?? '',
          };
          if (forced.status >= 200 && forced.status < 300) return response;
          throw Object.assign(new Error(`HTTP ${forced.status}`), { response });
        }
        const answers = parts
          .flatMap((part) => {
            const reply = answer(part, round);
            return reply ? [{ contentId: part.contentId, ...reply }] : [];
          })
          .reverse();
        return {
          status: 200,
          headers: new Headers({
            'content-type': 'multipart/mixed; boundary=batch_reply',
          }),
          data: multipartReply(answers),
        };
      } finally {
        state.active -= 1;
      }
    },
  };
  return {
    client,
    sent,
    requests,
    state,
    getClient: async () => {
      state.mints += 1;
      return client;
    },
    keys: () => sent.map((round) => round.map((part) => part.key)),
  };
}

/** Answer each key from its own list, one reply per send. The last reply repeats. */
export function perKey(table) {
  const used = new Map();
  return (part) => {
    const replies = table[part.key];
    const index = used.get(part.key) ?? 0;
    used.set(part.key, index + 1);
    return replies[Math.min(index, replies.length - 1)];
  };
}

/**
 * A clock that advances only when the service sleeps. Jitter is fixed at 0.5.
 * Each sleep yields one event-loop turn, so a loop defect cannot starve test timeouts.
 */
export function testClock() {
  const clock = { time: 0, waits: [] };
  clock.now = () => clock.time;
  clock.random = () => 0.5;
  clock.sleep = async (milliseconds, signal) => {
    clock.waits.push(milliseconds);
    await new Promise((resolve) => setImmediate(resolve));
    if (!signal.aborted) clock.time += milliseconds;
  };
  return clock;
}

export const thing = (id, extra = {}) => ({
  id,
  method: 'GET',
  path: `/admin/directory/v1/things/${encodeURIComponent(id)}`,
  ...extra,
});
```

- [ ] **Step 2: Write the failing tests**

Create `libs/google-connection/src/lib/batch.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleBatchService } from './batch.ts';
import { fakeGoogle, perKey, testClock, thing } from './batch-fake.mjs';

const batchUrl = 'https://www.googleapis.com/batch/admin/directory_v1';
const ok = (key) => ({ status: 200, body: { name: key } });
const reason = (status, why, headers) => ({
  status,
  body: { error: { code: status, errors: [{ reason: why }] } },
  ...(headers ? { headers } : {}),
});

function setup() {
  const clock = testClock();
  return {
    clock,
    batch: new GoogleBatchService({
      now: clock.now,
      sleep: clock.sleep,
      random: clock.random,
    }),
  };
}

function call(google, requests, extra = {}) {
  return {
    batchUrl,
    requests,
    parse: (body) => body,
    getClient: google.getClient,
    signal: AbortSignal.timeout(5_000),
    ...extra,
  };
}

const things = (...ids) => ids.map((id) => thing(id));
const sends = (google, key) =>
  google
    .keys()
    .flat()
    .filter((sent) => sent === key).length;

test('every part resolves on its own and results aggregate by caller id', async () => {
  const google = fakeGoogle(
    perKey({
      a: [ok('a')],
      b: [reason(404, 'notFound')],
      c: [reason(403, 'forbidden')],
      d: [reason(400, 'invalid')],
    }),
  );
  const result = await setup().batch.execute(
    call(google, things('a', 'b', 'c', 'd')),
  );
  assert.deepEqual([...result.succeeded], [['a', [{ name: 'a' }]]]);
  assert.deepEqual(
    Object.fromEntries(
      [...result.failed].map(([id, f]) => [id, [f.kind, f.status, f.reason]]),
    ),
    {
      b: ['not-found', 404, 'notFound'],
      c: ['auth', 403, 'forbidden'],
      d: ['rejected', 400, 'invalid'],
    },
  );
  assert.deepEqual(result.failed.get('c').attempts, { quota: 0, transient: 0 });
  assert.equal(google.sent.length, 1);
  assert.equal(google.requests[0].url, batchUrl);
  assert.equal(google.requests[0].method, 'POST');
  assert.ok(
    google.sent[0].every((part) => /^cc-\d+$/.test(part.contentId)),
    'Caller ids never enter a Content-ID header.',
  );
});

test('replies match by Content-ID, and odd caller ids resolve under the original id', async () => {
  const odd = 'odd>id with space\r\n';
  const google = fakeGoogle((part) => ok(part.key));
  const result = await setup().batch.execute(
    call(google, things('a', 'b', odd)),
  );
  assert.deepEqual(Object.fromEntries(result.succeeded), {
    a: [{ name: 'a' }],
    b: [{ name: 'b' }],
    [odd]: [{ name: odd }],
  });
});

test('a quota wave re-batches only the throttled parts', async () => {
  const google = fakeGoogle(
    perKey({
      a: [ok('a')],
      b: [reason(429, 'rateLimitExceeded'), ok('b')],
      c: [
        reason(403, 'userRateLimitExceeded'),
        reason(429, 'rateLimitExceeded'),
        ok('c'),
      ],
    }),
  );
  const { batch, clock } = setup();
  const result = await batch.execute(call(google, things('a', 'b', 'c')));
  assert.deepEqual(google.keys(), [['a', 'b', 'c'], ['b', 'c'], ['c']]);
  assert.deepEqual(clock.waits, [500, 1_000]);
  assert.deepEqual([...result.succeeded.keys()].sort(), ['a', 'b', 'c']);
});

test('default limits allow 25 quota retries and 10 transient retries per part', async () => {
  const google = fakeGoogle(
    perKey({
      q: [reason(429, 'rateLimitExceeded')],
      t: [{ status: 503, body: null }],
    }),
  );
  const result = await setup().batch.execute(call(google, things('q', 't')));
  assert.equal(sends(google, 'q'), 26);
  assert.equal(sends(google, 't'), 11);
  assert.deepEqual(result.failed.get('q'), {
    kind: 'quota',
    status: 429,
    reason: 'rateLimitExceeded',
    attempts: { quota: 25, transient: 0 },
    body: { error: { code: 429, errors: [{ reason: 'rateLimitExceeded' }] } },
  });
  assert.equal(result.failed.get('t').kind, 'transient');
  assert.deepEqual(result.failed.get('t').attempts, {
    quota: 0,
    transient: 10,
  });
});

test('a configured quota limit overrides the default', async () => {
  const google = fakeGoogle(() => reason(429, 'rateLimitExceeded'));
  const result = await setup().batch.execute(
    call(google, things('q'), { options: { maxQuotaRetries: 2 } }),
  );
  assert.equal(google.sent.length, 3);
  assert.deepEqual(result.failed.get('q').attempts, { quota: 2, transient: 0 });
});

test('Retry-After replaces the computed delay and stays under the maximum', async () => {
  const replies = () =>
    perKey({
      a: [
        reason(429, 'rateLimitExceeded', { 'Retry-After': '7' }),
        reason(429, 'rateLimitExceeded', { 'Retry-After': '120' }),
        ok('a'),
      ],
    });
  const honored = setup();
  await honored.batch.execute(call(fakeGoogle(replies()), things('a')));
  assert.deepEqual(honored.clock.waits, [7_000, 60_000]);
  const ignored = setup();
  await ignored.batch.execute(
    call(fakeGoogle(replies()), things('a'), {
      options: { honorRetryAfter: false },
    }),
  );
  assert.deepEqual(ignored.clock.waits, [500, 1_000]);
});

test('a POST does not retry a server error unless the caller allows it', async () => {
  const replies = () =>
    perKey({
      p: [
        { status: 503, body: null },
        { status: 200, body: { created: true } },
      ],
      q: [
        reason(429, 'rateLimitExceeded'),
        { status: 200, body: { created: true } },
      ],
    });
  const post = (id) => thing(id, { method: 'POST', body: { name: id } });
  let google = fakeGoogle(replies());
  let result = await setup().batch.execute(
    call(google, [post('p'), post('q')]),
  );
  assert.equal(result.failed.get('p').kind, 'transient');
  assert.deepEqual(result.failed.get('p').attempts, { quota: 0, transient: 0 });
  assert.deepEqual(result.succeeded.get('q'), [{ created: true }]);
  assert.deepEqual(google.sent[0][0].body, { name: 'p' });
  google = fakeGoogle(replies());
  result = await setup().batch.execute(
    call(google, [post('p')], { options: { retryUnsafeWrites: true } }),
  );
  assert.deepEqual(result.succeeded.get('p'), [{ created: true }]);
});

test('requests split into batches of at most 250, or the configured size', async () => {
  const ids = Array.from({ length: 600 }, (_, index) => `d${index}`);
  const google = fakeGoogle((part) => ok(part.key));
  const result = await setup().batch.execute(call(google, things(...ids)));
  assert.deepEqual(
    google.sent.map((round) => round.length),
    [250, 250, 100],
  );
  assert.equal(result.succeeded.size, 600);
  const smaller = fakeGoogle((part) => ok(part.key));
  await setup().batch.execute(
    call(smaller, things(...ids.slice(0, 10)), { options: { batchSize: 4 } }),
  );
  assert.deepEqual(
    smaller.sent.map((round) => round.length),
    [4, 4, 2],
  );
});

test('maxInFlight sends that many batches at once', async () => {
  const google = fakeGoogle((part) => ok(part.key), { delay: true });
  const result = await setup().batch.execute(
    call(google, things('a', 'b', 'c', 'd', 'e'), {
      options: { batchSize: 1, maxInFlight: 3 },
    }),
  );
  assert.equal(google.state.maxActive, 3);
  assert.equal(result.succeeded.size, 5);
});

test('an unanswered part retries as transient and an unknown Content-ID is ignored', async () => {
  const google = fakeGoogle(
    perKey({
      a: [ok('a')],
      b: [null, ok('b')],
      c: [{ ...ok('c'), contentId: 'cc-999' }, ok('c')],
    }),
  );
  const events = [];
  const result = await setup().batch.execute(
    call(google, things('a', 'b', 'c'), {
      onResponse: (event) => void events.push(event),
    }),
  );
  assert.deepEqual(google.keys(), [
    ['a', 'b', 'c'],
    ['b', 'c'],
  ]);
  assert.deepEqual(result.succeeded.get('b'), [{ name: 'b' }]);
  assert.deepEqual(result.succeeded.get('c'), [{ name: 'c' }]);
  const missing = events.find(
    (event) => event.id === 'b' && event.outcome.kind === 'retry',
  );
  assert.equal(missing.outcome.failure.reason, 'missing-part');
});

test('an HTML part body still classifies by status and siblings resolve', async () => {
  const google = fakeGoogle(
    perKey({
      a: [ok('a')],
      b: [{ status: 503, raw: '<html>Service Unavailable</html>' }, ok('b')],
    }),
  );
  const result = await setup().batch.execute(call(google, things('a', 'b')));
  assert.deepEqual(google.keys(), [['a', 'b'], ['b']]);
  assert.equal(result.succeeded.size, 2);
});

test('a 200 page the parser rejects fails as invalid-response', async () => {
  const google = fakeGoogle((part) => ok(part.key));
  const result = await setup().batch.execute(
    call(google, things('a', 'b'), {
      parse: (body) => {
        if (body.name === 'b') throw new Error('bad shape');
        return body;
      },
    }),
  );
  assert.deepEqual(result.failed.get('b'), {
    kind: 'invalid-response',
    status: 200,
    reason: 'parse-failed',
    attempts: { quota: 0, transient: 0 },
    body: { name: 'b' },
  });
  assert.equal(result.succeeded.size, 1);
});

test('a list request follows nextPageToken and keeps every page in order', async () => {
  const pages = {
    '': { items: [1], nextPageToken: 'p2' },
    p2: { items: [2], nextPageToken: 'p3' },
    p3: { items: [3] },
  };
  const google = fakeGoogle((part) => ({
    status: 200,
    body: pages[part.query.pageToken ?? ''],
  }));
  const result = await setup().batch.execute(
    call(google, [thing('list', { query: { maxResults: 1 } })], {
      parse: (body) => body.items,
    }),
  );
  assert.deepEqual(result.succeeded.get('list'), [[1], [2], [3]]);
  assert.deepEqual(
    google.sent.map(([part]) => part.query),
    [
      { maxResults: '1' },
      { maxResults: '1', pageToken: 'p2' },
      { maxResults: '1', pageToken: 'p3' },
    ],
  );
});

test('list requests page independently and share batches', async () => {
  const series = {
    long: {
      '': { items: ['l1'], nextPageToken: 't2' },
      t2: { items: ['l2'], nextPageToken: 't3' },
      t3: { items: ['l3'] },
    },
    short: { '': { items: ['s1'] } },
  };
  const google = fakeGoogle((part) => ({
    status: 200,
    body: series[part.key][part.query.pageToken ?? ''],
  }));
  const result = await setup().batch.execute(
    call(google, things('long', 'short'), { parse: (body) => body.items }),
  );
  assert.deepEqual(google.keys(), [['long', 'short'], ['long'], ['long']]);
  assert.deepEqual(result.succeeded.get('long'), [['l1'], ['l2'], ['l3']]);
  assert.deepEqual(result.succeeded.get('short'), [['s1']]);
});

test('a failure on a later page fails the whole request', async () => {
  const google = fakeGoogle((part) =>
    part.query.pageToken === 'p2'
      ? reason(403, 'forbidden')
      : { status: 200, body: { items: [1], nextPageToken: 'p2' } },
  );
  const result = await setup().batch.execute(call(google, things('list')));
  assert.equal(result.succeeded.has('list'), false);
  assert.equal(result.failed.get('list').kind, 'auth');
});

test('each page starts with fresh retry counters', async () => {
  const seen = new Map();
  const google = fakeGoogle((part) => {
    const token = part.query.pageToken ?? '';
    const count = (seen.get(token) ?? 0) + 1;
    seen.set(token, count);
    if (count === 1) return reason(429, 'rateLimitExceeded');
    return { status: 200, body: token === '' ? { nextPageToken: 'p2' } : {} };
  });
  const result = await setup().batch.execute(
    call(google, things('list'), { options: { maxQuotaRetries: 1 } }),
  );
  assert.equal(result.succeeded.get('list').length, 2);
  assert.equal(google.sent.length, 4);
});

test('the page cap stops a token that never ends', async () => {
  const google = fakeGoogle(() => ({
    status: 200,
    body: { nextPageToken: 'again' },
  }));
  const result = await setup().batch.execute(
    call(google, things('list'), { options: { maxPages: 3 } }),
  );
  assert.equal(google.sent.length, 3);
  assert.deepEqual(
    [result.failed.get('list').kind, result.failed.get('list').reason],
    ['invalid-response', 'page-limit'],
  );
});

test('onResponse reports every part outcome, including retries', async () => {
  const events = [];
  const google = fakeGoogle(
    perKey({
      a: [ok('a')],
      b: [reason(429, 'rateLimitExceeded'), reason(404, 'notFound')],
    }),
  );
  await setup().batch.execute(
    call(google, things('a', 'b'), {
      onResponse: (event) => void events.push(event),
    }),
  );
  assert.deepEqual(
    events.map((event) => [
      event.id,
      event.outcome.kind,
      event.status,
      event.attempts,
    ]),
    [
      ['b', 'retry', 429, { quota: 1, transient: 0 }],
      ['a', 'success', 200, { quota: 0, transient: 0 }],
      ['b', 'failed', 404, { quota: 1, transient: 0 }],
    ],
  );
  assert.equal(events[0].outcome.retryInMs, 500);
  assert.deepEqual(events[1].outcome, {
    kind: 'success',
    page: { name: 'a' },
    pageIndex: 0,
    hasNextPage: false,
  });
  assert.equal(events[1].request.path, '/admin/directory/v1/things/a');
  assert.equal(events[2].outcome.failure.kind, 'not-found');
});

test('a list request fires one success event per page with the page token it sent', async () => {
  const events = [];
  const google = fakeGoogle((part) => ({
    status: 200,
    body: part.query.pageToken
      ? { items: [2] }
      : { items: [1], nextPageToken: 'p2' },
  }));
  await setup().batch.execute(
    call(google, things('list'), {
      onResponse: (event) => void events.push(event),
    }),
  );
  assert.deepEqual(
    events.map((event) => [
      event.outcome.pageIndex,
      event.outcome.hasNextPage,
      event.request.query?.pageToken,
    ]),
    [
      [0, true, undefined],
      [1, false, 'p2'],
    ],
  );
});

test('onBatch fires once per round and is awaited before the next round', async () => {
  const order = [];
  const rounds = [];
  const google = fakeGoogle(
    (part, round) =>
      round === 0 && part.key === 'b'
        ? reason(429, 'rateLimitExceeded')
        : ok(part.key),
    { outer: (round) => void order.push(`send-${round}`) },
  );
  await setup().batch.execute(
    call(google, things('a', 'b'), {
      onBatch: async (event) => {
        order.push('hook-start');
        rounds.push(event);
        await new Promise((resolve) => setImmediate(resolve));
        order.push('hook-end');
      },
    }),
  );
  assert.deepEqual(rounds, [
    { round: 1, sentCount: 2, outerStatus: 200, durationMs: 0, pending: 1 },
    { round: 2, sentCount: 1, outerStatus: 200, durationMs: 0, pending: 0 },
  ]);
  assert.deepEqual(order, [
    'send-0',
    'hook-start',
    'hook-end',
    'send-1',
    'hook-start',
    'hook-end',
  ]);
});

test('a hook that throws rejects execute', async () => {
  const google = fakeGoogle((part) => ok(part.key));
  await assert.rejects(
    setup().batch.execute(
      call(google, things('a'), {
        onResponse: () => {
          throw new Error('sink down');
        },
      }),
    ),
    /sink down/,
  );
});

test(
  'an abort lets the batch in flight finish and fails what is still pending',
  { timeout: 5_000 },
  async () => {
    const stopping = new AbortController();
    const google = fakeGoogle((part) => {
      stopping.abort();
      return part.key === 'a' ? ok('a') : reason(429, 'rateLimitExceeded');
    });
    const result = await setup().batch.execute(
      call(google, [thing('a'), thing('b')], { signal: stopping.signal }),
    );
    assert.deepEqual(result.succeeded.get('a'), [{ name: 'a' }]);
    assert.deepEqual(result.failed.get('b'), {
      kind: 'aborted',
      status: 0,
      reason: null,
      attempts: { quota: 1, transient: 0 },
      body: null,
    });
    assert.equal(google.sent.length, 1);
  },
);

test(
  'an abort during a wait stops without another send',
  { timeout: 5_000 },
  async () => {
    const stopping = new AbortController();
    const google = fakeGoogle(() => reason(429, 'rateLimitExceeded'));
    const clock = testClock();
    const batch = new GoogleBatchService({
      now: clock.now,
      random: clock.random,
      sleep: async () => {
        stopping.abort();
        await new Promise((resolve) => setImmediate(resolve));
      },
    });
    const result = await batch.execute(
      call(google, [thing('a')], { signal: stopping.signal }),
    );
    assert.equal(google.sent.length, 1);
    assert.equal(result.failed.get('a').kind, 'aborted');
  },
);

test(
  'the default wait ends when the signal aborts',
  { timeout: 5_000 },
  async () => {
    const stopping = new AbortController();
    const google = fakeGoogle(() =>
      reason(429, 'rateLimitExceeded', { 'Retry-After': '60' }),
    );
    const started = Date.now();
    setTimeout(() => stopping.abort(), 20);
    const result = await new GoogleBatchService().execute(
      call(google, [thing('a')], { signal: stopping.signal }),
    );
    assert.equal(result.failed.get('a').kind, 'aborted');
    assert.ok(Date.now() - started < 5_000);
  },
);
test('bad input rejects before a token is minted, and no requests means no mint', async () => {
  const google = fakeGoogle((part) => ok(part.key));
  const { batch } = setup();
  await assert.rejects(batch.execute(call(google, things('a', 'a'))), {
    name: 'BatchServiceError',
    code: 'invalid-request',
  });
  await assert.rejects(
    batch.execute(call(google, things('a'), { options: { batchSize: 251 } })),
    {
      name: 'BatchServiceError',
      code: 'invalid-option',
    },
  );
  const empty = await batch.execute(call(google, []));
  assert.deepEqual([empty.succeeded.size, empty.failed.size], [0, 0]);
  assert.equal(google.state.mints, 0);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --import ./libs/application-contracts/test-register.mjs --test libs/google-connection/src/lib/batch.test.mjs`
Expected: FAIL with `does not provide an export named 'GoogleBatchService'`.

- [ ] **Step 4: Write the implementation**

Add this import as the first line of `libs/google-connection/src/lib/batch.ts`, above the file comment:

```ts
import { randomUUID } from 'node:crypto';
```

Append to `libs/google-connection/src/lib/batch.ts`:

```ts
export interface GoogleBatchServiceOptions {
  /** Wait for a delay. Resolve early, without throwing, when the signal aborts. */
  sleep?(milliseconds: number, signal: AbortSignal): Promise<void>;
  now?(): number;
  /** A number from 0 up to 1, for full jitter. */
  random?(): number;
}

interface Clock {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  now(): number;
  random(): number;
}

/** One caller request while it is unresolved. */
interface Entry<T> {
  readonly request: BatchRequest;
  pageToken: string | null;
  pages: T[];
  attempts: BatchAttempts;
  dueAt: number;
  inFlight: boolean;
}

function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function sentRequest<T>(entry: Entry<T>): BatchRequest {
  if (entry.pageToken === null) return entry.request;
  return {
    ...entry.request,
    query: { ...entry.request.query, pageToken: entry.pageToken },
  };
}

/** gaxios attaches the HTTP answer to a thrown error as `error.response`. */
function responseOf(error: unknown): BatchHttpResponse | undefined {
  const response =
    error !== null && typeof error === 'object'
      ? (error as { response?: unknown }).response
      : undefined;
  return response !== null && typeof response === 'object'
    ? (response as BatchHttpResponse)
    : undefined;
}

/** The queue and state of one `execute` call. */
class BatchRun<T> {
  private readonly call: BatchCall<T>;
  private readonly options: BatchOptions;
  private readonly clock: Clock;
  private readonly pending = new Map<string, Entry<T>>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly result: BatchResult<T> = {
    succeeded: new Map(),
    failed: new Map(),
  };
  private client: BatchHttpClient | null = null;
  private round = 0;
  private sequence = 0;
  private fatal: { error: unknown } | null = null;

  constructor(call: BatchCall<T>, options: BatchOptions, clock: Clock) {
    this.call = call;
    this.options = options;
    this.clock = clock;
    const start = clock.now();
    for (const request of call.requests)
      this.pending.set(request.id, {
        request,
        pageToken: null,
        pages: [],
        attempts: { quota: 0, transient: 0 },
        dueAt: start,
        inFlight: false,
      });
  }

  async run(): Promise<BatchResult<T>> {
    try {
      while (this.pending.size > 0 && this.fatal === null) {
        if (this.call.signal.aborted) {
          // Requests in flight settle first. Whatever is still pending fails as aborted.
          await this.settle();
          this.abortPending();
          break;
        }
        const due = this.dueEntries();
        if (due.length === 0) {
          await this.waitForProgress();
          continue;
        }
        const client = await this.ensureClient();
        if (client !== null) this.launch(due, client);
      }
    } finally {
      await this.settle();
    }
    if (this.fatal !== null) throw this.fatal.error;
    return this.result;
  }

  /** Requests due now, in caller order, up to one batch. Empty when no send slot is free. */
  private dueEntries(): Entry<T>[] {
    if (this.inFlight.size >= this.options.maxInFlight) return [];
    const now = this.clock.now();
    const due: Entry<T>[] = [];
    for (const entry of this.pending.values()) {
      if (entry.inFlight || entry.dueAt > now) continue;
      due.push(entry);
      if (due.length === this.options.batchSize) break;
    }
    return due;
  }

  private async ensureClient(): Promise<BatchHttpClient | null> {
    this.client ??= await this.call.getClient(this.call.signal);
    return this.client;
  }

  private launch(entries: Entry<T>[], client: BatchHttpClient): void {
    for (const entry of entries) entry.inFlight = true;
    const task: Promise<void> = this.send(entries, client)
      .catch((error: unknown) => {
        this.fatal ??= { error };
      })
      .finally(() => {
        for (const entry of entries) entry.inFlight = false;
        this.inFlight.delete(task);
      });
    this.inFlight.add(task);
  }

  private async send(
    entries: Entry<T>[],
    client: BatchHttpClient,
  ): Promise<void> {
    const round = ++this.round;
    const byContentId = new Map<string, Entry<T>>();
    const parts = entries.map((entry) => {
      const contentId = `cc-${++this.sequence}`;
      byContentId.set(contentId, entry);
      return { contentId, request: sentRequest(entry) };
    });
    const boundary = `batch_${randomUUID()}`;
    const started = this.clock.now();
    let response: BatchHttpResponse | undefined;
    let failure: unknown;
    try {
      response = await client.request({
        url: this.call.batchUrl,
        method: 'POST',
        headers: { 'content-type': `multipart/mixed; boundary=${boundary}` },
        body: buildMultipartBody(parts, boundary),
        responseType: 'text',
      });
    } catch (error) {
      failure = error;
      response = responseOf(error);
    }
    const status =
      typeof response?.status === 'number'
        ? response.status
        : failure === undefined
          ? 200
          : 0;
    if (
      failure === undefined &&
      response !== undefined &&
      status >= 200 &&
      status < 300
    )
      await this.resolveParts(byContentId, response);
    else {
      // An aborted send leaves its requests pending. The run loop fails them as aborted.
      if (failure !== undefined && this.call.signal.aborted) return;
      throw (
        failure ??
        new BatchServiceError(
          'outer-rejected',
          `The batch endpoint answered HTTP ${status}.`,
        )
      );
    }
    await this.reportRound(round, entries.length, status, started);
  }

  private async resolveParts(
    byContentId: Map<string, Entry<T>>,
    response: BatchHttpResponse,
  ): Promise<void> {
    const parts = parseMultipartResponse(
      headerValue(response.headers, 'content-type') ?? '',
      String(response.data ?? ''),
    );
    const answered = new Set<string>();
    for (const part of parts) {
      const entry = byContentId.get(part.contentId);
      if (entry === undefined || answered.has(part.contentId)) continue;
      answered.add(part.contentId);
      await this.resolvePart(entry, part);
    }
    for (const [contentId, entry] of byContentId)
      if (!answered.has(contentId))
        await this.retryOrFail(
          entry,
          'transient',
          0,
          'missing-part',
          null,
          undefined,
        );
  }

  private async resolvePart(
    entry: Entry<T>,
    part: BatchPartResponse,
  ): Promise<void> {
    const { kind, reason } = classifyStatus(part.status, part.body);
    if (kind === 'success') {
      await this.acceptPage(entry, part);
      return;
    }
    if (kind === 'quota' || kind === 'transient') {
      await this.retryOrFail(
        entry,
        kind,
        part.status,
        reason,
        part.body,
        part.headers['retry-after'],
      );
      return;
    }
    await this.resolveFailure(
      entry,
      { kind, status: part.status, reason, body: part.body },
      true,
    );
  }

  private async acceptPage(
    entry: Entry<T>,
    part: BatchPartResponse,
  ): Promise<void> {
    const request = sentRequest(entry);
    const attempts = { ...entry.attempts };
    let page: T;
    try {
      page = this.call.parse(part.body, request);
    } catch {
      await this.resolveFailure(
        entry,
        {
          kind: 'invalid-response',
          status: part.status,
          reason: 'parse-failed',
          body: part.body,
        },
        true,
      );
      return;
    }
    const token = nextPageToken(part.body);
    if (token !== null && entry.pages.length + 1 >= this.options.maxPages) {
      await this.resolveFailure(
        entry,
        {
          kind: 'invalid-response',
          status: part.status,
          reason: 'page-limit',
          body: null,
        },
        true,
      );
      return;
    }
    entry.pages.push(page);
    const pageIndex = entry.pages.length - 1;
    if (token === null) {
      this.pending.delete(entry.request.id);
      this.result.succeeded.set(entry.request.id, entry.pages);
    } else {
      entry.pageToken = token;
      entry.attempts = { quota: 0, transient: 0 };
      entry.dueAt = this.clock.now();
    }
    await this.call.onResponse?.({
      id: entry.request.id,
      request,
      attempts,
      status: part.status,
      outcome: {
        kind: 'success',
        page,
        pageIndex,
        hasNextPage: token !== null,
      },
    });
  }

  private async retryOrFail(
    entry: Entry<T>,
    kind: 'quota' | 'transient',
    status: number,
    reason: string | null,
    body: unknown,
    retryAfter: string | undefined,
  ): Promise<void> {
    const limit =
      kind === 'quota'
        ? this.options.maxQuotaRetries
        : this.options.maxTransientRetries;
    const unsafe =
      kind === 'transient' &&
      entry.request.method === 'POST' &&
      !this.options.retryUnsafeWrites;
    if (unsafe || entry.attempts[kind] >= limit) {
      await this.resolveFailure(entry, { kind, status, reason, body }, true);
      return;
    }
    entry.attempts[kind] += 1;
    const hinted = this.options.honorRetryAfter
      ? retryAfterMs(retryAfter, this.clock.now())
      : null;
    const retryInMs =
      hinted === null
        ? backoffDelay(entry.attempts[kind], this.options, this.clock.random)
        : Math.min(hinted, this.options.maxDelayMs);
    entry.dueAt = this.clock.now() + retryInMs;
    const attempts = { ...entry.attempts };
    await this.call.onResponse?.({
      id: entry.request.id,
      request: sentRequest(entry),
      attempts,
      status,
      outcome: {
        kind: 'retry',
        failure: { kind, status, reason, attempts, body },
        retryInMs,
      },
    });
  }

  private async resolveFailure(
    entry: Entry<T>,
    failure: Omit<BatchFailure, 'attempts'>,
    notify: boolean,
  ): Promise<void> {
    const final: BatchFailure = { ...failure, attempts: { ...entry.attempts } };
    this.pending.delete(entry.request.id);
    this.result.failed.set(entry.request.id, final);
    if (notify)
      await this.call.onResponse?.({
        id: entry.request.id,
        request: sentRequest(entry),
        attempts: final.attempts,
        status: final.status,
        outcome: { kind: 'failed', failure: final },
      });
  }

  private async reportRound(
    round: number,
    sentCount: number,
    outerStatus: number,
    started: number,
  ): Promise<void> {
    await this.call.onBatch?.({
      round,
      sentCount,
      outerStatus,
      durationMs: this.clock.now() - started,
      pending: this.pending.size,
    });
  }

  /** Wait for a send to finish or for the earliest retry to come due. */
  private async waitForProgress(): Promise<void> {
    const waits: Promise<unknown>[] = [...this.inFlight];
    const wake = new AbortController();
    if (this.inFlight.size < this.options.maxInFlight) {
      let earliest = Number.POSITIVE_INFINITY;
      for (const entry of this.pending.values())
        if (!entry.inFlight && entry.dueAt < earliest) earliest = entry.dueAt;
      if (earliest !== Number.POSITIVE_INFINITY)
        waits.push(
          this.clock.sleep(
            Math.max(0, earliest - this.clock.now()),
            AbortSignal.any([this.call.signal, wake.signal]),
          ),
        );
    }
    if (waits.length === 0) return;
    try {
      await Promise.race(waits);
    } finally {
      wake.abort();
    }
  }

  private abortPending(): void {
    for (const entry of [...this.pending.values()]) {
      this.pending.delete(entry.request.id);
      this.result.failed.set(entry.request.id, {
        kind: 'aborted',
        status: 0,
        reason: null,
        attempts: { ...entry.attempts },
        body: null,
      });
    }
  }

  private async settle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }
}

/**
 * Send Google API calls of one resource type through a multipart batch endpoint.
 * Every request resolves on its own. Retries and next pages go into later batches.
 */
export class GoogleBatchService {
  private readonly clock: Clock;

  constructor(options: GoogleBatchServiceOptions = {}) {
    this.clock = {
      sleep: options.sleep ?? abortableSleep,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
    };
  }

  /** Run until every request resolves. Rejects only on a caller or service defect. */
  async execute<T>(call: BatchCall<T>): Promise<BatchResult<T>> {
    validateRequests(call.requests);
    const options = resolveOptions(call.options);
    return new BatchRun(call, options, this.clock).run();
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import ./libs/application-contracts/test-register.mjs --test libs/google-connection/src/lib/batch.test.mjs`
Expected: PASS, 25 tests.

Run: `npx nx run google-connection:test` and `npx nx run google-connection:typecheck` and `npx nx run google-connection:lint`
Expected: all succeed.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write libs/google-connection/src/lib/batch.ts libs/google-connection/src/lib/batch.test.mjs libs/google-connection/src/lib/batch-fake.mjs
git add libs/google-connection/src/lib/batch.ts libs/google-connection/src/lib/batch.test.mjs libs/google-connection/src/lib/batch-fake.mjs
git commit -m "feat: resolve every batch part on its own and re-batch retries and next pages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Outer outcomes and token renewal

**Files:**

- Modify: `libs/google-connection/src/lib/batch.ts`
- Test: `libs/google-connection/src/lib/batch-run.test.mjs`

**Interfaces:**

- Consumes: `BatchRun` from Task 3, `GoogleConnectionError` from `./provider`.
- Produces: a new private method `BatchRun.outerFailure(entries, status, response, failure)` and a `mintedAt` field. No new exports.

- [ ] **Step 1: Write the failing tests**

Create `libs/google-connection/src/lib/batch-run.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleBatchService } from './batch.ts';
import { GoogleConnectionError } from './provider.ts';
import { fakeGoogle, testClock, thing } from './batch-fake.mjs';

const batchUrl = 'https://www.googleapis.com/batch/admin/directory_v1';
const ok = (key) => ({ status: 200, body: { name: key } });
const rateLimited = (headers) => ({
  status: 429,
  body: { error: { code: 429, errors: [{ reason: 'rateLimitExceeded' }] } },
  ...(headers ? { headers } : {}),
});

function setup() {
  const clock = testClock();
  return {
    clock,
    batch: new GoogleBatchService({
      now: clock.now,
      sleep: clock.sleep,
      random: clock.random,
    }),
  };
}

function call(google, requests, extra = {}) {
  return {
    batchUrl,
    requests,
    parse: (body) => body,
    getClient: google.getClient,
    signal: AbortSignal.timeout(5_000),
    ...extra,
  };
}

test('an outer server error retries the whole batch, except a POST', async () => {
  const google = fakeGoogle((part) => ok(part.key), {
    outer: (round) =>
      round === 0 ? { status: 503, data: '{"error":{"code":503}}' } : undefined,
  });
  const { batch, clock } = setup();
  const result = await batch.execute(
    call(google, [thing('a'), thing('p', { method: 'POST', body: {} })]),
  );
  assert.deepEqual(google.keys(), [['a', 'p'], ['a']]);
  assert.deepEqual(result.succeeded.get('a'), [{ name: 'a' }]);
  assert.deepEqual(
    [result.failed.get('p').kind, result.failed.get('p').status],
    ['transient', 503],
  );
  assert.deepEqual(clock.waits, [500]);
});

test('an outer 429 retries every part, a POST included, and honors Retry-After', async () => {
  const google = fakeGoogle((part) => ok(part.key), {
    outer: (round) =>
      round === 0
        ? { status: 429, headers: { 'retry-after': '3' } }
        : undefined,
  });
  const { batch, clock } = setup();
  const result = await batch.execute(
    call(google, [thing('a'), thing('p', { method: 'POST', body: {} })]),
  );
  assert.deepEqual(google.keys(), [
    ['a', 'p'],
    ['a', 'p'],
  ]);
  assert.deepEqual(clock.waits, [3_000]);
  assert.equal(result.succeeded.size, 2);
});

test('an outer network error retries as transient with the error code as reason', async () => {
  const events = [];
  const google = fakeGoogle((part) => ok(part.key), {
    outer: (round) =>
      round === 0
        ? Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
        : undefined,
  });
  const result = await setup().batch.execute(
    call(google, [thing('a')], {
      onResponse: (event) => void events.push(event),
    }),
  );
  assert.deepEqual(google.keys(), [['a'], ['a']]);
  assert.deepEqual(result.succeeded.get('a'), [{ name: 'a' }]);
  assert.deepEqual(
    [
      events[0].outcome.kind,
      events[0].status,
      events[0].outcome.failure.reason,
    ],
    ['retry', 0, 'ECONNRESET'],
  );
});

test('an outer 401 fails only the parts in that batch', async () => {
  const google = fakeGoogle((part) => ok(part.key), {
    outer: (round) =>
      round === 0
        ? {
            status: 401,
            data: '{"error":{"code":401,"errors":[{"reason":"authError"}]}}',
          }
        : undefined,
  });
  const result = await setup().batch.execute(
    call(google, [thing('a'), thing('b'), thing('c')], {
      options: { batchSize: 2 },
    }),
  );
  assert.deepEqual(google.keys(), [['a', 'b'], ['c']]);
  assert.deepEqual(
    [
      result.failed.get('a').kind,
      result.failed.get('a').status,
      result.failed.get('a').reason,
    ],
    ['auth', 401, 'authError'],
  );
  assert.equal(result.failed.get('b').kind, 'auth');
  assert.deepEqual(result.succeeded.get('c'), [{ name: 'c' }]);
});

test('an outer 400 or a malformed reply rejects the run', async () => {
  const rejected = fakeGoogle((part) => ok(part.key), {
    outer: () => ({ status: 400, data: '{}' }),
  });
  await assert.rejects(setup().batch.execute(call(rejected, [thing('a')])), {
    name: 'BatchServiceError',
    code: 'outer-rejected',
  });
  const garbled = fakeGoogle((part) => ok(part.key), {
    outer: () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      data: '<html>',
    }),
  });
  await assert.rejects(setup().batch.execute(call(garbled, [thing('a')])), {
    name: 'BatchServiceError',
    code: 'malformed-response',
  });
});

test('a GoogleConnectionError from the transport rejects the run', async () => {
  const google = fakeGoogle((part) => ok(part.key), {
    outer: () => new GoogleConnectionError('request-failed'),
  });
  await assert.rejects(setup().batch.execute(call(google, [thing('a')])), {
    name: 'GoogleConnectionError',
    code: 'request-failed',
  });
});

test('the token is minted again 45 minutes after the last mint', async () => {
  const mintedAt = [];
  const google = fakeGoogle((part, round) =>
    round < 3 ? rateLimited({ 'Retry-After': '900' }) : ok(part.key),
  );
  const { batch, clock } = setup();
  const result = await batch.execute(
    call(google, [thing('a')], {
      options: { maxDelayMs: 900_000 },
      getClient: async () => {
        mintedAt.push(clock.time);
        return google.client;
      },
    }),
  );
  assert.deepEqual(mintedAt, [0, 2_700_000]);
  assert.deepEqual(result.succeeded.get('a'), [{ name: 'a' }]);
});

test('a mint failure fails every pending request as auth with the mint code', async () => {
  const google = fakeGoogle((part) => ok(part.key));
  const result = await setup().batch.execute(
    call(google, [thing('a'), thing('b')], {
      getClient: async () => {
        throw new GoogleConnectionError('credential-rejected');
      },
    }),
  );
  assert.deepEqual(result.failed.get('a'), {
    kind: 'auth',
    status: 0,
    reason: 'credential-rejected',
    attempts: { quota: 0, transient: 0 },
    body: null,
  });
  assert.equal(result.failed.size, 2);
  assert.equal(google.sent.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import ./libs/application-contracts/test-register.mjs --test libs/google-connection/src/lib/batch-run.test.mjs`
Expected: FAIL. The outer 503, 429, network, 400, and 401 tests reject with the thrown fake error. The mint test rejects with `credential-rejected`. The renewal test sees one mint. The transport `GoogleConnectionError` test and the malformed half of the 400 test already pass.

- [ ] **Step 3: Write the implementation**

In `libs/google-connection/src/lib/batch.ts`, add below the `randomUUID` import:

```ts
import { GoogleConnectionError } from './provider';
```

Add a field to `BatchRun`, below `private client: BatchHttpClient | null = null;`:

```ts
  private mintedAt = 0;
```

Replace `BatchRun.ensureClient` with:

```ts
  /** Mint at the start and again 45 minutes after the last mint. A mint failure fails waiting requests. */
  private async ensureClient(): Promise<BatchHttpClient | null> {
    if (this.client !== null && this.clock.now() - this.mintedAt < TOKEN_RENEWAL_MS)
      return this.client;
    try {
      this.client = await this.call.getClient(this.call.signal);
      this.mintedAt = this.clock.now();
      return this.client;
    } catch (error) {
      if (this.call.signal.aborted) return null;
      const code =
        error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      for (const entry of [...this.pending.values()])
        if (!entry.inFlight)
          await this.resolveFailure(
            entry,
            { kind: 'auth', status: 0, reason: typeof code === 'string' ? code : null, body: null },
            false,
          );
      return null;
    }
  }
```

In `BatchRun.send`, replace this line:

```ts
throw (
  failure ??
  new BatchServiceError(
    'outer-rejected',
    `The batch endpoint answered HTTP ${status}.`,
  )
);
```

with:

```ts
await this.outerFailure(entries, status, response, failure);
```

Add this method to `BatchRun`, after `send`:

```ts
  /** B7: classify an outer answer that carries no parts. */
  private async outerFailure(
    entries: Entry<T>[],
    status: number,
    response: BatchHttpResponse | undefined,
    failure: unknown,
  ): Promise<void> {
    // The request allowlist and service defects are not Google conditions.
    if (failure instanceof GoogleConnectionError || failure instanceof BatchServiceError)
      throw failure;
    if (status === 0) {
      const code =
        failure !== null && typeof failure === 'object'
          ? (failure as { code?: unknown }).code
          : undefined;
      for (const entry of entries)
        await this.retryOrFail(
          entry,
          'transient',
          0,
          typeof code === 'string' ? code : 'network',
          null,
          undefined,
        );
      return;
    }
    const body =
      typeof response?.data === 'string' ? decodeBody(response.data) : (response?.data ?? null);
    const { kind, reason } = classifyStatus(status, body);
    if (kind === 'quota' || kind === 'transient') {
      const retryAfter = headerValue(response?.headers, 'retry-after');
      for (const entry of entries)
        await this.retryOrFail(entry, kind, status, reason, body, retryAfter);
      return;
    }
    if (kind === 'auth') {
      for (const entry of entries)
        await this.resolveFailure(entry, { kind, status, reason, body }, true);
      return;
    }
    throw new BatchServiceError('outer-rejected', `The batch endpoint answered HTTP ${status}.`);
  }

```

The `reportRound` call after the `if`/`else` now also runs for outer failures. It reports the outer status, or 0 for a network error.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import ./libs/application-contracts/test-register.mjs --test libs/google-connection/src/lib/batch-run.test.mjs`
Expected: PASS, 8 tests.

Run: `npx nx run google-connection:test` and `npx nx run google-connection:typecheck` and `npx nx run google-connection:lint`
Expected: all succeed. Task 3 tests still pass.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write libs/google-connection/src/lib/batch.ts libs/google-connection/src/lib/batch-run.test.mjs
git add libs/google-connection/src/lib/batch.ts libs/google-connection/src/lib/batch-run.test.mjs
git commit -m "feat: handle outer batch answers and renew the token after 45 minutes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Move the device batch onto the service

**Files:**

- Modify: `libs/google-connection/src/lib/devices.ts`
- Modify: `libs/google-connection/src/index.ts`
- Modify: `libs/google-connection/src/lib/devices.test.mjs`
- Modify: `worker/src/entity-sync.ts`
- Modify: `worker/src/entity-sync.test.mjs`

**Interfaces:**

- Consumes: `GoogleBatchService`, `BatchFailure` from Tasks 3 and 4. `scopedClient` and `failure` from `./provider`.
- Produces:
  - `GoogleDeviceReaderOptions.batch?: GoogleBatchService`.
  - `GoogleDeviceReader.deviceBatch(credential, customerId, deviceIds, signal, onRound?: () => Promise<void>): Promise<{ devices: DeviceObservation[]; missing: string[] }>`.
  - `EntityReader.deviceBatch` in the worker gains the same optional `onRound` parameter.
  - Package exports from `@campus/google-connection`: `GoogleBatchService`, `BatchServiceError`, `BATCH_DEFAULTS`, `BATCH_SIZE_LIMIT`, and the batch types.

- [ ] **Step 1: Write the failing library tests**

In `libs/google-connection/src/lib/devices.test.mjs`:

1. Replace the import line `import { GoogleDeviceReader, parseBatchResponse } from './devices.ts';` with:

```js
import { GoogleDeviceReader } from './devices.ts';
import { GoogleBatchService } from './batch.ts';
import { fakeGoogle } from './batch-fake.mjs';
```

2. Delete the `part` and `batchBody` helpers and these four tests:
   `parseBatchResponse splits parts by content id and status`,
   `deviceBatch reads each device once and reports missing devices`,
   `deviceBatch maps a quota part to a quota failure`,
   `deviceBatch fails the batch on any other part error`.
   Then run `grep -n "__multipart\|multipart\[" libs/google-connection/src/lib/devices.test.mjs`.
   If no test uses `__multipart` any more, delete the `multipart` constant and the `__multipart` branch in `stub`.

3. Add these helpers and tests where the deleted tests were:

```js
const fastBatch = () =>
  new GoogleBatchService({ sleep: async () => undefined, random: () => 0 });
const signal = () => AbortSignal.timeout(5000);

function stubBatch(t, answer) {
  const google = fakeGoogle(answer);
  const scopes = [];
  t.mock.method(JWT.prototype, 'getAccessToken', async function () {
    scopes.push(...this.scopes);
    return { token: 'private-fixture-token' };
  });
  t.mock.method(JWT.prototype, 'getTokenInfo', async function () {
    return { scopes: [...this.scopes], expiry_date: Date.now() + 3_500_000 };
  });
  t.mock.method(OAuth2Client.prototype, 'request', (options) =>
    google.client.request(options),
  );
  return { google, scopes };
}

const directoryDevice = (id) => ({
  status: 200,
  body: { deviceId: id, serialNumber: `S-${id}`, orgUnitPath: '/School A' },
});
const quotaPart = {
  status: 403,
  body: { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } },
};

test('deviceBatch reads each device once and reports missing devices', async (t) => {
  const { google, scopes } = stubBatch(t, (part) =>
    part.key === 'd2'
      ? {
          status: 404,
          body: { error: { code: 404, message: 'Resource Not Found' } },
        }
      : directoryDevice(part.key),
  );
  const result = await new GoogleDeviceReader({
    batch: fastBatch(),
  }).deviceBatch(credential, 'C0123456', ['d1', 'd2', 'd1'], signal());
  assert.deepEqual(scopes, [deviceScope]);
  assert.equal(
    google.requests[0].url,
    'https://www.googleapis.com/batch/admin/directory_v1',
  );
  assert.deepEqual(
    google.sent[0].map((part) => [
      part.method,
      part.path,
      part.query.projection,
    ]),
    [
      [
        'GET',
        '/admin/directory/v1/customer/C0123456/devices/chromeos/d1',
        'FULL',
      ],
      [
        'GET',
        '/admin/directory/v1/customer/C0123456/devices/chromeos/d2',
        'FULL',
      ],
    ],
  );
  assert.match(google.sent[0][0].query.fields, /^deviceId,serialNumber,/);
  assert.deepEqual(
    result.devices.map((device) => device.serialNumber),
    ['S-d1'],
  );
  assert.deepEqual(result.missing, ['d2']);
});

test('deviceBatch retries a quota part and keeps the parts that succeeded', async (t) => {
  let throttled = false;
  const { google } = stubBatch(t, (part) => {
    if (part.key === 'd1' && !throttled) {
      throttled = true;
      return quotaPart;
    }
    return directoryDevice(part.key);
  });
  const result = await new GoogleDeviceReader({
    batch: fastBatch(),
  }).deviceBatch(credential, 'C0123456', ['d1', 'd2'], signal());
  assert.deepEqual(google.keys(), [['d1', 'd2'], ['d1']]);
  assert.deepEqual(
    result.devices.map((device) => device.deviceId),
    ['d1', 'd2'],
  );
});

test('deviceBatch fails with quota after 25 quota retries', async (t) => {
  const { google } = stubBatch(t, () => quotaPart);
  await assert.rejects(
    new GoogleDeviceReader({ batch: fastBatch() }).deviceBatch(
      credential,
      'C0123456',
      ['d1'],
      signal(),
    ),
    { name: 'GoogleConnectionError', code: 'quota' },
  );
  assert.equal(google.sent.length, 26);
});

test('deviceBatch fails the batch on any other part error', async (t) => {
  stubBatch(t, (part) =>
    part.key === 'd2'
      ? {
          status: 403,
          body: { error: { code: 403, errors: [{ reason: 'forbidden' }] } },
        }
      : directoryDevice(part.key),
  );
  await assert.rejects(
    new GoogleDeviceReader({ batch: fastBatch() }).deviceBatch(
      credential,
      'C0123456',
      ['d1', 'd2'],
      signal(),
    ),
    { name: 'GoogleConnectionError', code: 'permission-denied' },
  );
});

test('deviceBatch reports each round to the caller', async (t) => {
  let throttled = false;
  stubBatch(t, (part) => {
    if (!throttled) {
      throttled = true;
      return quotaPart;
    }
    return directoryDevice(part.key);
  });
  let rounds = 0;
  await new GoogleDeviceReader({ batch: fastBatch() }).deviceBatch(
    credential,
    'C0123456',
    ['d1'],
    signal(),
    async () => {
      rounds += 1;
    },
  );
  assert.equal(rounds, 2);
});

test('deviceBatch surfaces a token failure with its own code', async (t) => {
  t.mock.method(JWT.prototype, 'getAccessToken', async () => {
    throw Object.assign(new Error('invalid_grant'), {
      response: { status: 400, data: { error: 'invalid_grant' } },
    });
  });
  await assert.rejects(
    new GoogleDeviceReader({ batch: fastBatch() }).deviceBatch(
      credential,
      'C0123456',
      ['d1'],
      signal(),
    ),
    { name: 'GoogleConnectionError', code: 'credential-rejected' },
  );
});
```

- [ ] **Step 2: Run the library tests to verify they fail**

Run: `node --import ./libs/application-contracts/test-register.mjs --test libs/google-connection/src/lib/devices.test.mjs`
Expected: FAIL. The new device batch tests fail because `deviceBatch` still sends `item-<id>` Content-IDs that the fake cannot map, and it throws on the quota part.

- [ ] **Step 3: Rewire `deviceBatch`**

In `libs/google-connection/src/lib/devices.ts`:

1. Add the import:

```ts
import { GoogleBatchService, type BatchFailure } from './batch';
```

2. Keep the existing `./provider` import. It already brings in `GoogleConnectionError`, `failure`, and `scopedClient`.

3. Delete `parseBatchResponse`, `partFailure`, `quotaReasons`, and `batchError`. Keep `telemetryDevice`.

4. Replace the `batchResponseLimit` constant and its comment with:

```ts
/** 250 devices with full notes and locations stay under this. */
const batchResponseLimit = 4 * 1024 * 1024;
const directoryDevice = devicePage.shape.chromeosdevices.unwrap().element;
```

5. Add this function above `GoogleDeviceReaderOptions`:

```ts
/** Map a final batch failure to the existing failure vocabulary. */
function batchFailure(failed: BatchFailure): GoogleConnectionError {
  if (failed.kind === 'quota') return new GoogleConnectionError('quota');
  if (failed.kind === 'invalid-response')
    return new GoogleConnectionError('invalid-response');
  if (failed.kind === 'aborted' || failed.status === 0)
    return new GoogleConnectionError('network-failure');
  return failure({ response: { status: failed.status, data: failed.body } });
}
```

6. Add `batch?: GoogleBatchService;` to `GoogleDeviceReaderOptions`. Add a `private readonly batch: GoogleBatchService;` field to `GoogleDeviceReader`. In the constructor, add `this.batch = options.batch ?? new GoogleBatchService();`.

7. Replace the whole `deviceBatch` method with:

```ts
  /**
   * Directory reads through the batch service. A 404 names a removed device.
   * Quota and server errors retry per part. Any other final failure fails the batch.
   * `onRound` runs after each multipart round, so the caller can extend its claim.
   */
  async deviceBatch(
    credential: DelegatedCredential,
    customerId: string,
    deviceIds: readonly string[],
    signal: AbortSignal,
    onRound?: () => Promise<void>,
  ): Promise<{ devices: DeviceObservation[]; missing: string[] }> {
    googleCustomerIdSchema.parse(customerId);
    const ids = [...new Set(deviceIds)];
    if (ids.length === 0) return { devices: [], missing: [] };
    if (ids.length > batchLimit) throw new GoogleConnectionError('invalid-response');
    const mint: { failure?: GoogleConnectionError } = {};
    const result = await this.batch.execute({
      batchUrl: batchEndpoint,
      requests: ids.map((id) => ({
        id,
        method: 'GET' as const,
        path: `${directoryPath}/customer/${customerId}/devices/chromeos/${encodeURIComponent(id)}`,
        query: { projection: 'FULL', fields: deviceFields },
      })),
      parse: (body) => deviceObservation(directoryDevice.parse(body)),
      getClient: async (runSignal) => {
        try {
          return await scopedClient(
            credential,
            scopeFor('device-inventory'),
            runSignal,
            batchResponseLimit,
          );
        } catch (error) {
          mint.failure = failure(error, 'token');
          throw mint.failure;
        }
      },
      signal,
      ...(onRound ? { onBatch: onRound } : {}),
    });
    if (mint.failure) throw mint.failure;
    const devices: DeviceObservation[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const pages = result.succeeded.get(id);
      if (pages) {
        devices.push(...pages);
        continue;
      }
      const failed = result.failed.get(id);
      if (failed?.kind === 'not-found') missing.push(id);
      else if (failed) throw batchFailure(failed);
    }
    return { devices, missing };
  }
```

8. In `libs/google-connection/src/index.ts`, add:

```ts
export {
  BATCH_DEFAULTS,
  BATCH_SIZE_LIMIT,
  BatchServiceError,
  GoogleBatchService,
} from './lib/batch';
export type {
  BatchAttempts,
  BatchCall,
  BatchFailure,
  BatchFailureKind,
  BatchHttpClient,
  BatchOptions,
  BatchRequest,
  BatchResponseEvent,
  BatchResult,
  BatchRoundEvent,
} from './lib/batch';
```

- [ ] **Step 4: Run the library checks**

Run: `npx nx run google-connection:test` and `npx nx run google-connection:typecheck` and `npx nx run google-connection:lint`
Expected: all succeed.

- [ ] **Step 5: Write the failing worker tests**

In `worker/src/entity-sync.test.mjs`:

1. Replace the `reader` fixture with a version that runs `onRound`:

```js
function reader({ devices = [], batteries = [], rounds = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async deviceBatch(_credential, _customer, ids, _signal, onRound) {
      calls.push({ name: 'deviceBatch', ids });
      for (let round = 0; round < rounds; round++) await onRound?.();
      const next = devices.shift();
      if (next instanceof Error) throw next;
      return next ?? { devices: ids.map(device), missing: [] };
    },
    async batteryBatch(_credential, _customer, ids) {
      calls.push({ name: 'batteryBatch', ids });
      const next = batteries.shift();
      if (next instanceof Error) throw next;
      return next ?? [];
    },
  };
}
```

2. Replace the test `quota errors retry until Google answers` with:

```js
test('a Directory quota failure fails the batch without a worker retry', async () => {
  const waits = [];
  const source = reader({ devices: [new GoogleConnectionError('quota')] });
  const result = await new EntitySyncBatch(
    database({
      finish: job({ completedBatches: 0, failedBatches: 1, failure: 'quota' }),
    }),
    cipher,
    source,
    cache(),
    { backoff: () => 0, sleep: async (ms) => void waits.push(ms) },
  ).run(request, AbortSignal.timeout(5000));
  assert.equal(result.failure, 'quota');
  assert.deepEqual(names(source.calls), ['deviceBatch']);
  assert.deepEqual(waits, []);
});

test('telemetry quota errors retry in the worker until Google answers', async () => {
  const waits = [];
  const result = await new EntitySyncBatch(
    database(),
    cipher,
    reader({
      batteries: [
        new GoogleConnectionError('quota'),
        new GoogleConnectionError('quota'),
      ],
    }),
    cache(),
    {
      backoff: (attempt) => attempt * 10,
      sleep: async (ms) => void waits.push(ms),
    },
  ).run(request, AbortSignal.timeout(5000));
  assert.equal(result.failure, null);
  assert.deepEqual(waits, [0, 10]);
});

test('each batch service round extends the claim on the batch IDs', async () => {
  const redis = cache();
  await new EntitySyncBatch(
    database(),
    cipher,
    reader({ rounds: 2 }),
    redis,
    noSleep,
  ).run(request, AbortSignal.timeout(5000));
  const extensions = redis.calls.filter(
    (call) => call.name === 'extendMembers',
  );
  assert.equal(extensions.length, 2);
  assert.deepEqual(extensions[0].args.slice(1), [['d1', 'd2', 'd3'], 120]);
});
```

3. In the test `a quota retry stops when the worker shuts down`, change `reader({ devices: [new GoogleConnectionError('quota')] })` to `reader({ batteries: [new GoogleConnectionError('quota')] })`.

4. Replace the test `a quota sleep extends the batch claim on its in-flight IDs` with the telemetry form. Directory quota no longer sleeps in the worker:

```js
test('a telemetry quota sleep extends the batch claim on its in-flight IDs', async () => {
  const redis = cache();
  const waits = [];
  await new EntitySyncBatch(
    database(),
    cipher,
    reader({ batteries: [new GoogleConnectionError('quota')] }),
    redis,
    {
      backoff: () => 0,
      sleep: async () => void waits.push(redis.calls.length),
    },
  ).run(request, AbortSignal.timeout(5000));
  const extended = redis.calls.filter((call) => call.name === 'extendMembers');
  assert.equal(extended.length, 1);
  assert.deepEqual(extended[0].args, [
    'cc:entity-inflight:device:C0123456',
    ['d1', 'd2', 'd3'],
    120,
  ]);
  assert.deepEqual(
    waits.map((count) => redis.calls[count - 1].name),
    ['extendMembers'],
    'The extension precedes its sleep.',
  );
});
```

5. Replace the test `a failed claim extension does not stop the quota retry` with a version that covers both extension paths:

```js
test('a failed claim extension does not stop a quota retry or a batch round', async () => {
  const redis = cache();
  redis.extendMembers = async () => {
    throw new EntityCacheError();
  };
  const result = await new EntitySyncBatch(
    database(),
    cipher,
    reader({ batteries: [new GoogleConnectionError('quota')], rounds: 1 }),
    redis,
    noSleep,
  ).run(request, AbortSignal.timeout(5000));
  assert.equal(result.failure, null);
  assert.deepEqual(result.updated, ['d1', 'd2', 'd3']);
});
```

- [ ] **Step 6: Run the worker tests to verify they fail**

Run: `node --import ./libs/application-contracts/test-register.mjs --test worker/src/entity-sync.test.mjs`
Expected: FAIL. The Directory quota test sees a worker retry, and the claim test sees no `extendMembers` calls.

- [ ] **Step 7: Change the worker**

In `worker/src/entity-sync.ts`:

1. Add `onRound?: () => Promise<void>,` as the last parameter of `EntityReader.deviceBatch`.

2. Replace the class comment above `EntitySyncBatch` with:

```ts
/**
 * One Kestra batch: read the slice, fetch from Google, upsert, cache, signal, record.
 * The batch service retries Directory quota answers per part. Telemetry quota answers retry here.
 * Every other Directory error fails the batch once.
 * Every other telemetry error keeps the stored battery fields and the batch succeeds.
 */
```

3. Replace the Directory read:

```ts
const read = await this.untilQuotaClears(signal, claim, () =>
  this.reader.deviceBatch(credential, input.customerId, batch.ids, signal),
);
```

with:

```ts
// Each multipart round extends the claim, so a long quota wave keeps the batch IDs.
const extendClaim = async () => {
  await this.cache
    .extendMembers(claim.key, claim.ids, ENTITY_INFLIGHT_SECONDS)
    .catch(() => undefined);
};
const read = await this.reader.deviceBatch(
  credential,
  input.customerId,
  batch.ids,
  signal,
  extendClaim,
);
```

- [ ] **Step 8: Run the worker checks**

Run: `npx nx run worker:test` and `npx nx run worker:lint` and `npx nx run worker:build`
Expected: all succeed.

- [ ] **Step 9: Commit**

```bash
git add libs/google-connection/src/lib/devices.ts libs/google-connection/src/lib/devices.test.mjs libs/google-connection/src/index.ts worker/src/entity-sync.ts worker/src/entity-sync.test.mjs
git commit -m "feat: read device batches through the batch service and extend the claim per round

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Cap the remaining quota loops at 25 retries

**Files:**

- Modify: `libs/google-connection/src/lib/devices.ts` (the `pages` pager)
- Modify: `libs/google-connection/src/lib/devices.test.mjs`
- Modify: `worker/src/entity-sync.ts` (`untilQuotaClears`)
- Modify: `worker/src/entity-sync.test.mjs`

**Interfaces:**

- Consumes: `BATCH_DEFAULTS.maxQuotaRetries` from `./batch` and from `@campus/google-connection`.
- Produces: no new names. The pagers and `untilQuotaClears` throw `quota` after 25 retries.

- [ ] **Step 1: Write the failing tests**

Add to `libs/google-connection/src/lib/devices.test.mjs`, after `a quota answer retries the same page until Google answers`:

```js
test('a quota page stops after 25 retries', async (t) => {
  const { calls } = stub(
    t,
    Array.from({ length: 27 }, () => quotaAnswer()),
  );
  const waits = [];
  await assert.rejects(
    collect(
      new GoogleDeviceReader({
        backoff: () => 0,
        sleep: async (milliseconds) => void waits.push(milliseconds),
      }).devicePages(credential, 'C0123456', AbortSignal.timeout(5000)),
    ),
    { name: 'GoogleConnectionError', code: 'quota' },
  );
  assert.equal(calls.length, 26);
  assert.equal(waits.length, 25);
});
```

Add to `worker/src/entity-sync.test.mjs`:

```js
test('telemetry quota stops after 25 retries and fails the batch', async () => {
  const waits = [];
  const source = reader({
    batteries: Array.from(
      { length: 26 },
      () => new GoogleConnectionError('quota'),
    ),
  });
  const result = await new EntitySyncBatch(
    database({
      finish: job({ completedBatches: 0, failedBatches: 1, failure: 'quota' }),
    }),
    cipher,
    source,
    cache(),
    { backoff: () => 0, sleep: async (ms) => void waits.push(ms) },
  ).run(request, AbortSignal.timeout(5000));
  assert.equal(result.failure, 'quota');
  assert.equal(
    names(source.calls).filter((name) => name === 'batteryBatch').length,
    26,
  );
  assert.equal(waits.length, 25);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import ./libs/application-contracts/test-register.mjs --test libs/google-connection/src/lib/devices.test.mjs worker/src/entity-sync.test.mjs`
Expected: FAIL. The pager makes a 27th call. The worker loop retries a 26th time and then succeeds with `failure` null.

- [ ] **Step 3: Write the implementation**

In `libs/google-connection/src/lib/devices.ts`, change the batch import to `import { BATCH_DEFAULTS, GoogleBatchService, type BatchFailure } from './batch';`. In `pages`, change the doc comment and the quota check:

```ts
/** Follow page tokens. A quota answer retries the same page up to 25 times, then fails with quota. */
```

```ts
const classified = failure(error);
if (classified.code !== 'quota' || attempt >= BATCH_DEFAULTS.maxQuotaRetries)
  throw classified;
```

In `worker/src/entity-sync.ts`, add `BATCH_DEFAULTS` to the `@campus/google-connection` import. Change the `untilQuotaClears` doc comment and the quota check:

```ts
/**
 * Retry only quota answers, up to 25 times. A shutdown signal ends the wait with worker-stopping.
 * Each wait first extends the claim on the batch IDs, so a retrying batch keeps them.
 */
```

```ts
if (
  !(error instanceof GoogleConnectionError) ||
  error.code !== 'quota' ||
  attempt >= BATCH_DEFAULTS.maxQuotaRetries
)
  throw error;
```

- [ ] **Step 4: Run all checks**

Run: `npx nx run-many -t test lint -p google-connection worker` and `npx nx run google-connection:typecheck` and `npx nx run worker:build`
Expected: all succeed.

- [ ] **Step 5: Commit**

```bash
git add libs/google-connection/src/lib/devices.ts libs/google-connection/src/lib/devices.test.mjs worker/src/entity-sync.ts worker/src/entity-sync.test.mjs
git commit -m "fix: stop the pagers and the telemetry loop after 25 quota retries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Live wire check and records

**Files:**

- Create: `deployment/google-proof/batch-live.mjs`
- Create: `deployment/evidence/batch-service-live-<date>.json` (written by the script)
- Modify: `docs/superpowers/specs/2026-10-07-google-batch-service-decisions.md`

**Interfaces:**

- Consumes: `GoogleBatchService` and `validateServiceAccount` from `@campus/google-connection`, `scopedClient` from `libs/google-connection/src/lib/provider.ts`.
- Produces: a sanitized evidence file. No code exports.

The standing authorization in AGENTS.md covers this check. It is read-only. It uses the org unit read scope, which is inside the recorded boundary. The script reads the credential file and never prints, logs, or copies its contents.

- [ ] **Step 1: Write the script**

Create `deployment/google-proof/batch-live.mjs`:

```js
/**
 * Read-only live check of the Google batch service against the approved Easton fixture.
 * Run: node --import ./libs/application-contracts/test-register.mjs deployment/google-proof/batch-live.mjs [key-file]
 * It batches orgunits.get for up to two real OUs and one missing path, then writes sanitized evidence.
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  GoogleBatchService,
  validateServiceAccount,
} from '@campus/google-connection';
import { scopedClient } from '../../libs/google-connection/src/lib/provider.ts';

const customerId = 'C01zcarnq';
const subject = 'spencer@easton-consulting.com';
const clientId = '113794681976879482895';
const scope =
  'https://www.googleapis.com/auth/admin.directory.orgunit.readonly';
const directory = `/admin/directory/v1/customer/${customerId}/orgunits`;
const keyPath =
  process.argv[2] ?? '/mnt/c/Users/spenc/Downloads/DWD_SA_CC.json';

const credential = {
  subject,
  serviceAccount: validateServiceAccount(
    JSON.parse(await readFile(keyPath, 'utf8')),
    clientId,
  ),
};
const signal = AbortSignal.timeout(120_000);
const client = await scopedClient(credential, scope, signal);
const listed = await client.request({
  url: `https://admin.googleapis.com${directory}`,
  method: 'GET',
  params: { type: 'all', fields: 'organizationUnits(orgUnitId)' },
});
const ouIds = (listed.data.organizationUnits ?? [])
  .map((unit) => unit.orgUnitId)
  .filter((id) => typeof id === 'string' && /^id:[A-Za-z0-9]+$/.test(id))
  .slice(0, 2);

const requests = [
  ...ouIds.map((id, index) => ({
    id: `ou-${index + 1}`,
    method: 'GET',
    path: `${directory}/${id}`,
    query: { fields: 'orgUnitId' },
  })),
  {
    id: 'missing',
    method: 'GET',
    path: `${directory}/cc-batch-missing-probe`,
    query: { fields: 'orgUnitId' },
  },
];
const rounds = [];
const started = Date.now();
const result = await new GoogleBatchService().execute({
  batchUrl: 'https://www.googleapis.com/batch/admin/directory_v1',
  requests,
  // A page matches when Google answered the OU this part asked for. This proves Content-ID mapping.
  parse: (body, request) => ({
    matched: request.path.endsWith(`/${body?.orgUnitId}`),
  }),
  getClient: (runSignal) => scopedClient(credential, scope, runSignal),
  signal,
  onBatch: (event) =>
    void rounds.push({
      sentCount: event.sentCount,
      outerStatus: event.outerStatus,
      pending: event.pending,
    }),
});

const outcome = (id) => {
  const pages = result.succeeded.get(id);
  if (pages) return { kind: 'success', contentIdMatched: pages[0].matched };
  const failed = result.failed.get(id);
  return { kind: failed.kind, status: failed.status, reason: failed.reason };
};
const recordedAt = new Date().toISOString();
const evidence = {
  recordedAt,
  fixture: 'approved Easton read-only fixture',
  scope,
  method:
    'directory.orgunits.get through https://www.googleapis.com/batch/admin/directory_v1',
  ouCount: ouIds.length,
  rounds,
  outcomes: Object.fromEntries(
    requests.map((request) => [request.id, outcome(request.id)]),
  ),
  durationMs: Date.now() - started,
  limitations: [
    'Paging is not exercised. No authorized live scope returns page tokens.',
  ],
};
const path = `deployment/evidence/batch-service-live-${recordedAt.slice(0, 10)}.json`;
await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
console.log(`Evidence written to ${path}`);
```

- [ ] **Step 2: Run the check**

Run: `node --import ./libs/application-contracts/test-register.mjs deployment/google-proof/batch-live.mjs`
The command needs network access to Google. If the sandbox blocks the network, rerun outside the sandbox.
Expected: `ou-1` and `ou-2` report `{ "kind": "success", "contentIdMatched": true }`. `missing` reports kind `not-found` with status 404. One round with outer status 200.

Record actual results without changes. If Google answers the missing path with a status other than 404, keep that result in the evidence and report it to the owner. Do not change the service to match it.

- [ ] **Step 3: Check the evidence for private data**

Run: `grep -nE "private_key|BEGIN|id:[A-Za-z0-9]|@easton" deployment/evidence/batch-service-live-*.json`
Expected: no output. The evidence holds no OU IDs, OU names, tokens, or key material.

- [ ] **Step 4: Update the decision record**

In `docs/superpowers/specs/2026-10-07-google-batch-service-decisions.md`, change the status line to:

```markdown
Status: owner-confirmed 2026-10-07. Implemented on `codex/batch-service`. Not merged.
```

Replace the `## Open items` list with:

```markdown
- Plan: [2026-10-07 Google batch service](../plans/2026-10-07-google-batch-service.md).
- Live wire evidence: `deployment/evidence/batch-service-live-<date>.json`, using the actual file name.
- No merge without owner authorization.
- Follow-up: `deviceBatch` fails the whole batch on any non-404 failure, per B12.
  Per-user OAuth with org unit scoping needs partial success. That change needs an owner decision.
```

- [ ] **Step 5: Commit**

```bash
npx prettier --write docs/superpowers/specs/2026-10-07-google-batch-service-decisions.md
git add deployment/google-proof/batch-live.mjs deployment/evidence/batch-service-live-*.json docs/superpowers/specs/2026-10-07-google-batch-service-decisions.md
git commit -m "test: record a live read-only check of the batch service wire format

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Final verification**

Run: `npx nx run-many -t test lint -p google-connection worker application-contracts` and `npx nx run google-connection:typecheck` and `npx nx run worker:build`
Expected: all succeed. Report the evidence outcomes and any check that failed.
