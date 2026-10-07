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
