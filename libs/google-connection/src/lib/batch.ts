import { randomUUID } from 'node:crypto';

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

const QUOTA_REASONS: ReadonlySet<string> = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
]);

const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);

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
  if (
    TRANSIENT_STATUSES.has(status) ||
    (status === 403 && reason === 'backendError')
  )
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
