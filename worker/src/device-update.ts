import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  entityEventsChannel,
  entityKey,
  googleCustomerIdSchema,
  jobEventsChannel,
  queryGenerationKey,
} from '@campus/application-contracts';
import {
  BatchServiceError,
  GoogleConnectionError,
  failure,
  type BatchFailure,
  type BatchResponseEvent,
  type BatchResult,
  type BatchRoundEvent,
  type CredentialCipher,
  type DelegatedCredential,
  type DeviceState,
  type WrittenDevice,
} from '@campus/google-connection';
import { DeviceSyncError, type DeviceSyncDatabase } from './device-sync';
import { EntityCacheError, type EntityCache } from './entity-cache';

/** The worker setting of section 9: one multipart request holds at most 250 parts. */
export const DEVICE_UPDATE_BATCH_SIZE_LIMIT = 250;

/** Reject a value outside 1 to 250 at start (addendum ruling 11). */
export function resolveDeviceUpdateBatchSize(
  value: string | undefined,
): number {
  if (value === undefined || value === '')
    return DEVICE_UPDATE_BATCH_SIZE_LIMIT;
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > DEVICE_UPDATE_BATCH_SIZE_LIMIT
  )
    throw new Error(
      `CC_DEVICE_UPDATE_BATCH_SIZE must be an integer from 1 to ${DEVICE_UPDATE_BATCH_SIZE_LIMIT}.`,
    );
  return parsed;
}

const googleCustomerId = googleCustomerIdSchema;
const operationNumber = z.number().int().min(1);
const deviceId = z.string().min(1).max(128);

export const deviceUpdateBatchRequestSchema = z.strictObject({
  customerId: googleCustomerId,
  jobId: z.uuid(),
  dispatchToken: z.uuid(),
  /** Kestra passes the ForEach value as text. */
  batch: z.coerce.number().int().min(0),
  correlationId: z.uuid(),
});
export type DeviceUpdateBatchRequest = z.infer<
  typeof deviceUpdateBatchRequestSchema
>;

export const deviceUpdateFinishRequestSchema = z.strictObject({
  customerId: googleCustomerId,
  jobId: z.uuid(),
  dispatchToken: z.uuid(),
  correlationId: z.uuid(),
});
export type DeviceUpdateFinishRequest = z.infer<
  typeof deviceUpdateFinishRequestSchema
>;

export const deviceUpdateReconcileRequestSchema = z.strictObject({
  customerId: googleCustomerId,
  jobId: z.uuid(),
  /** A whole operation number, or `all`. Kestra sends the input as text. */
  operationNumber: z.union([
    z.literal('all'),
    z.number().int().min(1),
    z
      .string()
      .regex(/^[0-9]+$/)
      .transform(Number)
      .pipe(z.number().int().min(1)),
  ]),
  /** Only a whole number names one read-back attempt. */
  verifyAttempt: z.uuid().nullish(),
  correlationId: z.uuid(),
});
export type DeviceUpdateReconcileRequest = z.infer<
  typeof deviceUpdateReconcileRequestSchema
>;

/** One claimed operation. The write value comes from the operation row. */
const claimedOperationSchema = z.object({
  operationNumber,
  deviceId,
  serialNumber: z.string().max(256).nullable(),
  baselineValue: z.string().max(4096).nullable(),
  requestedValue: z.string().max(4096).nullable(),
});
export type ClaimedOperation = z.infer<typeof claimedOperationSchema>;

const claimSchema = z.object({
  outcome: z.literal('claimed'),
  generation: z.number().int().positive(),
  credentialId: z.uuid(),
  envelope: z.unknown(),
  batchCount: z.number().int().min(1),
  operations: z.array(claimedOperationSchema).max(1000),
  readBack: z.array(claimedOperationSchema).max(1000),
});

const settledOperationSchema = z.object({
  operationNumber,
  deviceId,
  status: z.enum(['succeeded', 'failed', 'unknown', 'pending', 'skipped']),
  batch: z.number().int().min(0),
});

const publicationElementSchema = z.object({
  publicationId: z.number().int().positive(),
  jobId: z.uuid(),
  displayId: z.string().min(1),
  requestedBy: z.uuid(),
  revision: z.number().int().min(1),
  statusChanged: z.boolean(),
  deviceIds: z.array(deviceId).max(1000),
  removedIds: z.array(deviceId).max(1000),
  batch: z.number().int().min(0).nullable(),
  batchCount: z.number().int().min(1).nullable(),
});
export type PublicationElement = z.infer<typeof publicationElementSchema>;

const settlementSchema = z.object({
  outcome: z.enum(['settled', 'fenced']),
  settled: z.array(settledOperationSchema).optional(),
  published: z.array(deviceId).optional(),
  removed: z.array(deviceId).optional(),
  publication: publicationElementSchema.nullable().optional(),
});

const heldOperationSchema = z.object({
  operationNumber,
  deviceId,
  serialNumber: z.string().max(256).nullable(),
  baselineValue: z.string().max(4096).nullable(),
  requestedValue: z.string().max(4096).nullable(),
  /** The batch claim omits both read-back stamps. Its fence time is the claim clock. */
  verifyAfter: z.string().nullable().optional(),
  /** The claim omits the lease end; the verification read returns it (C1, C2). */
  verifyLeaseExpiresAt: z.string().nullable().optional(),
});
export type HeldOperation = z.infer<typeof heldOperationSchema>;

const verificationReadSchema = z.object({
  outcome: z.literal('held'),
  checkedAt: z.string(),
  generation: z.number().int().positive(),
  credentialId: z.uuid(),
  envelope: z.unknown(),
  operations: z.array(heldOperationSchema).min(1).max(250),
});

const preparationSchema = z.object({
  outcome: z.enum(['ready', 'busy', 'superseded', 'finished']),
  status: z.string().optional(),
  failure: z.string().nullable().optional(),
});

const finishSchema = z.object({
  outcome: z
    .enum(['superseded', 'finished', 'busy', 'not-prepared'])
    .optional(),
  jobId: z.uuid().optional(),
  status: z.string().optional(),
  succeeded: z.number().int().min(0).optional(),
  failed: z.number().int().min(0).optional(),
  unknown: z.number().int().min(0).optional(),
  skipped: z.number().int().min(0).optional(),
  finishedAt: z.string().nullable().optional(),
  publication: publicationElementSchema.nullable().optional(),
});

/** A batch answer. `stopped` carries the job failure of section 7.2. */
export type DeviceUpdateBatchAnswer =
  | { outcome: 'superseded' }
  | { outcome: 'done' }
  | { outcome: 'busy' }
  | { outcome: 'stopped'; failure: string }
  | { outcome: 'attempt-fenced' }
  | {
      outcome: 'settled';
      failure: string | null;
      published: number;
      removed: number;
    };

export type DeviceUpdateFinishAnswer =
  | { outcome: 'superseded'; status?: string }
  | {
      outcome: 'finished';
      status: string;
      failure: string | null;
      readBack: DeviceUpdateReadBackSummary;
    }
  | { outcome: 'busy' }
  | { outcome: 'not-prepared'; status?: string }
  | {
      outcome: 'ready';
      status?: string;
      failure: string | null;
      readBack: DeviceUpdateReadBackSummary;
    };

export type DeviceUpdateReconcileAnswer =
  | { outcome: 'not-held' }
  | { outcome: 'settled'; readBack: DeviceUpdateReadBackSummary };

export interface DeviceUpdateReadBackSummary {
  claimed: number;
  notHeld: number;
  settled: number;
  verified: number;
  failed: number;
  unknown: number;
}

const emptySummary = (): DeviceUpdateReadBackSummary => ({
  claimed: 0,
  notHeld: 0,
  settled: 0,
  verified: 0,
  failed: 0,
  unknown: 0,
});

/** One reader of the write path. `GoogleDeviceReader` implements both methods. */
export interface DeviceUpdateReader {
  patchAnnotatedLocations(
    credential: DelegatedCredential,
    customerId: string,
    writes: readonly { deviceId: string; value: string | null }[],
    signal: AbortSignal,
    options: {
      batchSize?: number;
      onSend?(requestIds: readonly string[]): void | Promise<void>;
      onResponse?(
        event: BatchResponseEvent<WrittenDevice>,
      ): void | Promise<void>;
      onBatch?(event: BatchRoundEvent): void | Promise<void>;
    },
  ): Promise<BatchResult<WrittenDevice>>;
  deviceStates(
    credential: DelegatedCredential,
    customerId: string,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<DeviceState[]>;
}

export interface DeviceUpdateTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: DeviceUpdateTimers = {
  setTimeout: (callback, milliseconds) => {
    const handle = setTimeout(callback, milliseconds);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, milliseconds) => {
    const handle = setInterval(callback, milliseconds);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface DeviceUpdateOptions {
  /** The worker setting of ruling 11. Defaults to 250. */
  batchSize?: number;
  timers?: DeviceUpdateTimers;
  /** Wait for a delay. Reject with worker-stopping when the request ends. */
  sleep?(milliseconds: number, signal: AbortSignal): Promise<void>;
}

function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DeviceSyncError('worker-stopping'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new DeviceSyncError('worker-stopping'));
    };
    signal.addEventListener('abort', abort, { once: true });
    timer.unref();
  });
}

/** Read the job failure of one part answer (section 7.2). */
export function partFailureCode(failed: BatchFailure): string {
  if (failed.kind === 'auth' && failed.status === 0)
    return failed.reason ?? 'request-failed';
  return failure({ response: { status: failed.status, data: failed.body } })
    .code;
}

const scopeFailures = new Set(['delegation-not-authorized', 'scope-mismatch']);

export function isScopeFailure(
  code: string | null | undefined,
): code is string {
  return code !== null && code !== undefined && scopeFailures.has(code);
}

/** One write result of a settlement (addendum contract C3). */
export interface WriteOutcome {
  operationNumber: number;
  outcome: 'succeeded' | 'failed' | 'unknown' | 'pending' | 'skipped';
  outcomeReason?: string;
  verifiedBy?: 'write-response' | 'read-back';
  value?: string | null;
  googleStatus?: number | null;
  googleReason?: string | null;
  quotaRetries?: number;
  transientRetries?: number;
  verifyAfter?: string;
  /** The scope failure code this result observed, if any (ruling 5). */
  scopeFailure?: string;
}

interface TrackedWrite {
  operation: ClaimedOperation;
  /** True when the batch service sent this request at least once. */
  sent: boolean;
  succeeded: boolean;
  /** A final answer arrived. A scheduled retry is not final. */
  final: BatchFailure | null;
  settled: boolean;
}

/** A wait that the worker has no function for: it retries or settles locally. */
function storeError(error: unknown): DeviceSyncError {
  const detail =
    error !== null && typeof error === 'object'
      ? (error as { detail?: unknown }).detail
      : undefined;
  return new DeviceSyncError(
    detail === 'attempt-fenced' ? 'attempt-fenced' : 'store-unavailable',
  );
}

/**
 * Classify one operation from the final result, the retry history, and the facts of
 * `onSend` and `onResponse` (design section 7.1). A stopping job turns a
 * no-request operation into skipped with the job failure.
 */
export function classifyWrite(
  tracked: TrackedWrite,
  stopFailure: string | null,
): { outcome: WriteOutcome; observedFailure: string | null } {
  const base = { operationNumber: tracked.operation.operationNumber };
  if (tracked.succeeded)
    return {
      outcome: { ...base, outcome: 'succeeded', verifiedBy: 'write-response' },
      observedFailure: null,
    };
  const failed = tracked.final;
  if (failed) {
    const common = {
      ...base,
      googleStatus: failed.status,
      googleReason: failed.reason,
      quotaRetries: failed.attempts.quota,
      transientRetries: failed.attempts.transient,
    };
    // A part answer of kind `auth` stops the job even after a lost request
    // (section 7.2). The settlement of its round stays `unknown`.
    const observedFailure =
      failed.kind === 'auth' ? partFailureCode(failed) : null;
    const scope = isScopeFailure(observedFailure)
      ? { scopeFailure: observedFailure }
      : {};
    if (failed.kind === 'auth' && failed.status === 0) {
      // A mint failure: no request left the worker (section 7.2).
      return {
        outcome: tracked.sent
          ? {
              ...common,
              ...scope,
              outcome: 'unknown',
              outcomeReason: 'ambiguous',
            }
          : stopFailure === null
            ? { ...common, ...scope, outcome: 'pending' }
            : {
                ...common,
                ...scope,
                outcome: 'skipped',
                outcomeReason: stopFailure,
              },
        observedFailure,
      };
    }
    if (failed.kind === 'invalid-response')
      return {
        outcome: {
          ...common,
          outcome: 'unknown',
          outcomeReason: 'invalid-response',
        },
        observedFailure,
      };
    if (failed.attempts.transient > 0)
      return {
        outcome: {
          ...common,
          ...scope,
          outcome: 'unknown',
          outcomeReason: 'ambiguous',
        },
        observedFailure,
      };
    switch (failed.kind) {
      case 'not-found':
        return {
          outcome: {
            ...common,
            outcome: 'failed',
            outcomeReason: 'not-found',
          },
          observedFailure: null,
        };
      case 'quota':
        return {
          outcome: {
            ...common,
            outcome: 'failed',
            outcomeReason: 'quota',
          },
          observedFailure: null,
        };
      case 'rejected':
      case 'auth':
        return {
          outcome: {
            ...common,
            ...scope,
            outcome: 'failed',
            outcomeReason: failed.reason ?? 'request-failed',
          },
          observedFailure,
        };
      case 'transient':
        return {
          outcome: {
            ...common,
            outcome: 'unknown',
            outcomeReason: 'ambiguous',
          },
          observedFailure: null,
        };
      default:
        // `aborted`: a request in flight at the end is ambiguous.
        if (tracked.sent)
          return {
            outcome: {
              ...common,
              outcome: 'unknown',
              outcomeReason: 'ambiguous',
            },
            observedFailure: null,
          };
        return {
          outcome:
            stopFailure === null
              ? { ...common, outcome: 'pending' }
              : {
                  ...common,
                  outcome: 'skipped',
                  outcomeReason: stopFailure,
                },
          observedFailure: null,
        };
    }
  }
  // No final answer: a request left the worker without an event.
  if (tracked.sent)
    return {
      outcome: {
        ...base,
        outcome: 'unknown',
        outcomeReason: 'ambiguous',
        googleStatus: 0,
        googleReason: null,
        quotaRetries: 0,
        transientRetries: 0,
      },
      observedFailure: null,
    };
  return {
    outcome:
      stopFailure === null
        ? { ...base, outcome: 'pending' }
        : { ...base, outcome: 'skipped', outcomeReason: stopFailure },
    observedFailure: null,
  };
}

/** The watchdog of section 5.4: abort 150 s after the last claim or renewal started. */
export class LeaseWatchdog {
  private handle: unknown = null;
  private readonly timers: DeviceUpdateTimers;
  private readonly onExpired: () => void;
  private readonly milliseconds: number;

  constructor(
    timers: DeviceUpdateTimers,
    onExpired: () => void,
    milliseconds = 150_000,
  ) {
    this.timers = timers;
    this.onExpired = onExpired;
    this.milliseconds = milliseconds;
  }

  arm(milliseconds: number = this.milliseconds): void {
    this.clear();
    this.handle = this.timers.setTimeout(
      () => {
        this.handle = null;
        this.onExpired();
      },
      Math.max(0, milliseconds),
    );
  }

  clear(): void {
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = null;
  }
}

/** Report the first quota retry of a batch, then every 60 s while a part waits. */
export class BackoffReporter {
  private sequence = 0;
  private readonly waiting = new Set<string>();
  private handle: unknown = null;
  private readonly report: (sequence: number) => Promise<unknown>;
  private readonly timers: DeviceUpdateTimers;
  private readonly intervalMs: number;

  constructor(
    report: (sequence: number) => Promise<unknown>,
    timers: DeviceUpdateTimers,
    intervalMs = 60_000,
  ) {
    this.report = report;
    this.timers = timers;
    this.intervalMs = intervalMs;
  }

  /** One retry event. A quota wait starts the clock at the first event. */
  noteRetry(id: string, kind: string): void {
    if (kind !== 'quota') return;
    this.waiting.add(id);
    if (this.handle === null) {
      void this.send();
      this.handle = this.timers.setInterval(() => {
        if (this.waiting.size === 0) return;
        void this.send();
      }, this.intervalMs);
    }
  }

  /** One final answer ends the wait of its request. */
  noteAnswer(id: string): void {
    this.waiting.delete(id);
  }

  stop(): void {
    if (this.handle !== null) this.timers.clearInterval(this.handle);
    this.handle = null;
    this.waiting.clear();
  }

  private async send(): Promise<void> {
    this.sequence += 1;
    try {
      await this.report(this.sequence);
    } catch {
      /* A rejected report is one failed attempt. The next interval reports again. */
    }
  }
}

/**
 * The write path of one device update job: the batch claim, the PATCH call, the
 * fenced settlements, the read-back, the release, the finish, and the reconcile reads.
 * Every database call is its own autocommit statement (rule W).
 */
export class DeviceUpdateJobs {
  private readonly database: DeviceSyncDatabase;
  private readonly cipher: Pick<CredentialCipher, 'open'>;
  private readonly reader: DeviceUpdateReader;
  private readonly cache: EntityCache;
  private readonly batchSize: number;
  private readonly timers: DeviceUpdateTimers;
  private readonly sleep: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;

  constructor(
    database: DeviceSyncDatabase,
    cipher: Pick<CredentialCipher, 'open'>,
    reader: DeviceUpdateReader,
    cache: EntityCache,
    options: DeviceUpdateOptions = {},
  ) {
    this.database = database;
    this.cipher = cipher;
    this.reader = reader;
    this.cache = cache;
    this.batchSize = options.batchSize ?? DEVICE_UPDATE_BATCH_SIZE_LIMIT;
    this.timers = options.timers ?? realTimers;
    this.sleep = options.sleep ?? abortableSleep;
  }

  /** Run one `cc.*` function. Known lease details keep their code. */
  private async call(sql: string, values: unknown[]): Promise<unknown> {
    try {
      return (await this.database.query(sql, values)).rows[0]?.['result'];
    } catch (error) {
      throw storeError(error);
    }
  }

  /** A clock read. It reads no table, and the worker holds no lock between calls. */
  private async clock(): Promise<Date> {
    const value = await this.call('SELECT clock_timestamp() AS result', []);
    const stamp = new Date(
      value instanceof Date || typeof value === 'string' ? value : Number.NaN,
    );
    if (Number.isNaN(stamp.getTime()))
      throw new DeviceSyncError('store-unavailable');
    return stamp;
  }

  /**
   * One settlement. A deadlock (`40P01`) rolls back and runs again, up to 3 times,
   * while the lease lives (section 5.4).
   */
  private async settleCall(
    customer: string,
    jobId: string,
    token: string | null,
    attempt: string,
    kind: 'write' | 'read-back',
    results: readonly WriteOutcome[],
    observedAt: Date,
    failureCode: string | null,
    scopeFailure: string | null,
  ): Promise<z.infer<typeof settlementSchema>> {
    for (let attemptNumber = 1; ; attemptNumber += 1) {
      try {
        const answer = await this.database.query(
          'SELECT cc.settle_device_update_operations($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
          [
            customer,
            jobId,
            kind === 'write' ? token : null,
            attempt,
            kind,
            JSON.stringify(results),
            observedAt.toISOString(),
            failureCode,
            scopeFailure,
          ],
        );
        return settlementSchema.parse(answer.rows[0]?.['result']);
      } catch (error) {
        const code =
          error !== null && typeof error === 'object'
            ? (error as { code?: unknown }).code
            : undefined;
        if (code === '40P01' && attemptNumber < 3) continue;
        throw storeError(error);
      }
    }
  }

  /**
   * Handle one publication element after its commit (section 3.6). A progress-only
   * row stays for the relay. A Redis failure keeps the row for the relay too.
   */
  async publish(
    customer: string,
    element: PublicationElement | null,
  ): Promise<void> {
    if (element === null) return;
    const present = element.deviceIds;
    const removed = element.removedIds;
    const withDevices = present.length > 0 || removed.length > 0;
    if (!element.statusChanged && !withDevices) return;
    try {
      if (removed.length > 0)
        await this.cache.remove(
          removed.map((id) => entityKey('device', customer, id)),
        );
      if (withDevices) {
        await this.cache.increment(queryGenerationKey('device', customer));
        await this.cache.publish(
          entityEventsChannel(customer),
          JSON.stringify({
            type: 'entity-batch',
            jobId: element.jobId,
            entityType: 'device',
            batch: element.batch ?? 0,
            batchCount: element.batchCount,
            deviceIds: present,
            removedIds: removed,
          }),
        );
      }
      await this.cache.publish(
        jobEventsChannel(customer),
        JSON.stringify({
          type: 'job-changed',
          jobId: element.jobId,
          displayId: element.displayId,
          revision: element.revision,
          requestedBy: element.requestedBy,
        }),
      );
      await this.call('SELECT cc.complete_job_publications($1,$2) AS result', [
        customer,
        JSON.stringify([element.publicationId]),
      ]);
    } catch (error) {
      if (error instanceof EntityCacheError) return;
      throw error;
    }
  }

  /** One write batch request (addendum, handler call order). */
  async runBatch(
    request: DeviceUpdateBatchRequest,
    signal: AbortSignal,
  ): Promise<DeviceUpdateBatchAnswer> {
    const input = deviceUpdateBatchRequestSchema.parse(request);
    const attempt = randomUUID();
    const stop = new AbortController();
    const callSignal = AbortSignal.any([signal, stop.signal]);
    const watchdog = new LeaseWatchdog(this.timers, () => stop.abort());
    const tracked = new Map<string, TrackedWrite>();
    let claimedOperations: ClaimedOperation[] = [];
    let fenced = false;
    let storeFailure = false;
    let failureCode: string | null = null;
    let mintScopeFailure: string | null = null;
    let published = 0;
    let removed = 0;
    let reporter: BackoffReporter | null = null;
    try {
      // 1. The batch claim with its envelope. Only a busy claim polls.
      const claimed = await this.claimBatch(input, attempt, signal);
      if (claimed.outcome !== 'claimed')
        return claimed.outcome === 'busy' ? { outcome: 'busy' } : claimed;
      // A watchdog covers every request from the start of the claim that
      // established the lease (section 5.4).
      watchdog.arm(150_000 - (Date.now() - claimed.startedAt));
      const body = claimSchema.parse(claimed.answer);
      claimedOperations = body.operations;
      for (const operation of [...body.operations, ...body.readBack])
        tracked.set(operation.deviceId, {
          operation,
          sent: false,
          succeeded: false,
          final: null,
          settled: false,
        });
      reporter = new BackoffReporter(
        (sequence) =>
          this.call(
            'SELECT cc.report_device_update_backoff($1,$2,$3,$4,$5,$6) AS result',
            [
              input.customerId,
              input.jobId,
              input.dispatchToken,
              input.batch,
              attempt,
              sequence,
            ],
          ),
        this.timers,
      );
      let credential: DelegatedCredential | null = null;
      try {
        credential = this.openCredential(body, input.customerId);
      } catch {
        // A credential that cannot open gives key-unavailable before any request.
        failureCode = 'key-unavailable';
      }
      const unknown = new Map<number, Date>();
      const settleRound = async (
        ids: readonly string[],
        stamp: Date,
      ): Promise<void> => {
        const results: WriteOutcome[] = [];
        for (const id of ids) {
          const entry = tracked.get(id);
          if (entry === undefined || entry.settled) continue;
          if (!entry.succeeded && entry.final === null) continue;
          const classified = classifyWrite(entry, failureCode);
          entry.settled = true;
          results.push(classified.outcome);
          if (classified.outcome.outcome === 'unknown')
            unknown.set(entry.operation.operationNumber, stamp);
          if (classified.observedFailure !== null && failureCode === null)
            failureCode = classified.observedFailure;
        }
        if (results.length === 0) return;
        const settled = await this.settleCall(
          input.customerId,
          input.jobId,
          input.dispatchToken,
          attempt,
          'write',
          results,
          stamp,
          failureCode,
          scopeFailureOf(results),
        );
        if (settled.outcome === 'fenced') {
          fenced = true;
          stop.abort();
          return;
        }
        published += settled.published?.length ?? 0;
        removed += settled.removed?.length ?? 0;
        await this.publish(input.customerId, settled.publication ?? null);
      };
      if (credential !== null && claimedOperations.length > 0) {
        let roundIds: string[] = [];
        try {
          await this.reader.patchAnnotatedLocations(
            credential,
            input.customerId,
            claimedOperations.map((operation) => ({
              deviceId: operation.deviceId,
              value: operation.requestedValue,
            })),
            callSignal,
            {
              batchSize: this.batchSize,
              onSend: (ids) => {
                roundIds = [...ids];
                for (const id of ids) {
                  const entry = tracked.get(id);
                  if (entry) entry.sent = true;
                }
              },
              onResponse: (event) => {
                const entry = tracked.get(event.id);
                if (!entry) return;
                reporter?.noteAnswer(event.id);
                if (event.outcome.kind === 'success') {
                  entry.succeeded = true;
                  entry.final = null;
                  return;
                }
                if (event.outcome.kind === 'retry') {
                  reporter?.noteRetry(event.id, event.outcome.failure.kind);
                  return;
                }
                entry.final = event.outcome.failure;
              },
              onBatch: async () => {
                // The renewal after the round stamps its write responses (section 5.8).
                if (callSignal.aborted) return;
                const renewedAt = Date.now();
                let stamp: Date;
                try {
                  const renewed = await this.call(
                    'SELECT cc.renew_device_update_batch($1,$2,$3,$4,$5) AS result',
                    [
                      input.customerId,
                      input.jobId,
                      input.dispatchToken,
                      input.batch,
                      attempt,
                    ],
                  );
                  stamp =
                    renewed instanceof Date
                      ? renewed
                      : new Date(String(renewed));
                  if (Number.isNaN(stamp.getTime()))
                    throw new DeviceSyncError('store-unavailable');
                } catch (error) {
                  if (
                    error instanceof DeviceSyncError &&
                    error.code === 'attempt-fenced'
                  ) {
                    // A rejected renewal aborts the call through its signal.
                    fenced = true;
                    stop.abort();
                    return;
                  }
                  throw error;
                }
                const ids = roundIds;
                roundIds = [];
                watchdog.arm(150_000 - (Date.now() - renewedAt));
                await settleRound(ids, stamp);
              },
            },
          );
        } catch (error) {
          if (error instanceof DeviceSyncError) {
            storeFailure = true;
            throw error;
          }
          const stopCode = this.callFailure(error);
          if (stopCode === null) {
            storeFailure = true;
            throw error;
          }
          // A mint failure or a fatal batch error stops the job. The kept events
          // decide the outcomes of this settlement (sections 7.1 and 7.2).
          failureCode ??= stopCode;
          if (
            error instanceof GoogleConnectionError &&
            isScopeFailure(stopCode)
          )
            mintScopeFailure = stopCode;
        }
      }
      reporter.stop();

      // 2. One write settlement for every operation that no round settled.
      const leftovers: WriteOutcome[] = [];
      for (const operation of claimedOperations) {
        const entry = tracked.get(operation.deviceId);
        if (entry === undefined || entry.settled) continue;
        const classified = classifyWrite(entry, failureCode);
        entry.settled = true;
        leftovers.push(classified.outcome);
        if (classified.observedFailure !== null && failureCode === null)
          failureCode = classified.observedFailure;
      }
      if (leftovers.length > 0 && !fenced) {
        // No round renewal stamps these results: read the clock before the settlement.
        const stamp = await this.clock();
        for (const result of leftovers)
          if (result.outcome === 'unknown')
            unknown.set(result.operationNumber, stamp);
        const settled = await this.settleCall(
          input.customerId,
          input.jobId,
          input.dispatchToken,
          attempt,
          'write',
          leftovers,
          stamp,
          failureCode,
          scopeFailureOf(leftovers) ?? mintScopeFailure,
        );
        if (settled.outcome === 'fenced') fenced = true;
        else {
          published += settled.published?.length ?? 0;
          removed += settled.removed?.length ?? 0;
          await this.publish(input.customerId, settled.publication ?? null);
        }
      }

      // 3. The read-back of places 1 and 2, under the envelope of the batch claim.
      if (!fenced && !signal.aborted && credential !== null) {
        const held: HeldOperation[] = [];
        for (const entry of tracked.values()) {
          const after = unknown.get(entry.operation.operationNumber);
          if (after === undefined) continue;
          held.push({
            operationNumber: entry.operation.operationNumber,
            deviceId: entry.operation.deviceId,
            serialNumber: entry.operation.serialNumber,
            baselineValue: entry.operation.baselineValue,
            requestedValue: entry.operation.requestedValue,
            verifyAfter: new Date(after.getTime() + 30_000).toISOString(),
            verifyLeaseExpiresAt: new Date(
              after.getTime() + 120_000,
            ).toISOString(),
          });
        }
        for (const operation of body.readBack)
          held.push({
            operationNumber: operation.operationNumber,
            deviceId: operation.deviceId,
            serialNumber: operation.serialNumber,
            baselineValue: operation.baselineValue,
            requestedValue: operation.requestedValue,
            verifyAfter: null,
            verifyLeaseExpiresAt: null,
          });
        if (held.length > 0)
          await this.readBackHeld(
            input.customerId,
            input.jobId,
            attempt,
            credential,
            held,
            signal,
          );
      }
    } catch (error) {
      if (error instanceof DeviceSyncError) {
        storeFailure = true;
        throw error;
      }
      throw error;
    } finally {
      watchdog.clear();
      reporter?.stop();
    }
    // 5. The release ends the request when no operation of the attempt stays
    // dispatched. After a fenced settlement or a store failure it never runs.
    if (!fenced && !storeFailure && everySettled(tracked, claimedOperations))
      await this.release(
        input.customerId,
        input.jobId,
        input.dispatchToken,
        input.batch,
        attempt,
      );
    if (fenced) return { outcome: 'attempt-fenced' };
    if (failureCode !== null)
      return { outcome: 'stopped', failure: failureCode };
    return { outcome: 'settled', failure: null, published, removed };
  }

  /** Poll a busy claim every 10 s for at most 45 minutes (section 5.4). */
  private async claimBatch(
    input: DeviceUpdateBatchRequest,
    attempt: string,
    signal: AbortSignal,
  ): Promise<
    | { outcome: 'claimed'; answer: unknown; startedAt: number }
    | { outcome: 'superseded' }
    | { outcome: 'done' }
    | { outcome: 'busy' }
    | { outcome: 'stopped'; failure: string }
  > {
    const deadline = Date.now() + 45 * 60_000;
    for (;;) {
      const startedAt = Date.now();
      const answer = await this.call(
        'SELECT cc.claim_device_update_batch($1,$2,$3,$4,$5,$6) AS result',
        [
          input.customerId,
          input.jobId,
          input.dispatchToken,
          input.batch,
          attempt,
          input.correlationId,
        ],
      );
      const parsed = z
        .object({
          outcome: z.enum(['claimed', 'superseded', 'done', 'busy', 'stopped']),
          failure: z.string().optional(),
        })
        .passthrough()
        .parse(answer);
      if (parsed.outcome === 'claimed')
        return { outcome: 'claimed', answer, startedAt };
      if (parsed.outcome === 'stopped')
        return { outcome: 'stopped', failure: parsed.failure ?? 'interrupted' };
      if (parsed.outcome !== 'busy') return { outcome: parsed.outcome };
      if (Date.now() >= deadline || signal.aborted) return { outcome: 'busy' };
      await this.sleep(10_000, signal);
    }
  }

  private openCredential(
    claim: { envelope: unknown; credentialId: string; generation: number },
    customer: string,
  ): DelegatedCredential {
    return this.cipher.open(claim.envelope, {
      recordId: claim.credentialId,
      customerId: customer,
      generation: claim.generation,
    });
  }

  /** Map a thrown write-call error to the job failure of section 7.2. */
  private callFailure(error: unknown): string | null {
    if (error instanceof GoogleConnectionError) return error.code;
    if (error instanceof BatchServiceError)
      return error.code === 'malformed-response'
        ? 'invalid-response'
        : 'request-failed';
    return null;
  }

  /** Places 1 and 2: operations already held by this attempt under a live lease. */
  private async readBackHeld(
    customer: string,
    jobId: string,
    attempt: string,
    credential: DelegatedCredential,
    operations: readonly HeldOperation[],
    signal: AbortSignal,
  ): Promise<DeviceUpdateReadBackSummary> {
    const summary = emptySummary();
    for (let start = 0; start < operations.length; start += 250) {
      const chunk = operations.slice(start, start + 250);
      await this.settleChunk(
        customer,
        jobId,
        attempt,
        credential,
        chunk,
        signal,
        summary,
      );
    }
    return summary;
  }

  /**
   * Places 3 and 4: claim the next chunk of `unknown` operations under one attempt,
   * read the envelope and the held operations, then GET and settle.
   */
  async readBackClaimed(
    customer: string,
    jobId: string,
    attempt: string,
    signal: AbortSignal,
  ): Promise<DeviceUpdateReadBackSummary> {
    const summary = emptySummary();
    let cursor: number | null = null;
    for (;;) {
      const claimed = z
        .array(heldOperationSchema)
        .parse(
          await this.call(
            'SELECT cc.claim_device_update_verification($1,$2,$3,$4,$5,$6) AS result',
            [customer, jobId, null, attempt, cursor, 250],
          ),
        );
      if (claimed.length === 0) break;
      cursor = claimed[claimed.length - 1].operationNumber;
      summary.claimed += claimed.length;
      const read = await this.verificationRead(
        customer,
        jobId,
        attempt,
        claimed.map((operation) => operation.operationNumber),
        claimed,
        summary,
      );
      if (read === null) continue;
      const credential = this.openCredential(read, customer);
      await this.settleChunk(
        customer,
        jobId,
        attempt,
        credential,
        read.operations,
        signal,
        summary,
      );
    }
    return summary;
  }

  /** One Reconcile request for one operation: the attempt already holds it. */
  async readBackOperation(
    customer: string,
    jobId: string,
    attempt: string,
    number: number,
    signal: AbortSignal,
  ): Promise<DeviceUpdateReadBackSummary> {
    const summary = emptySummary();
    const read = await this.verificationRead(
      customer,
      jobId,
      attempt,
      [number],
      [{ operationNumber: number }],
      summary,
    );
    if (read === null) return summary;
    const credential = this.openCredential(read, customer);
    await this.settleChunk(
      customer,
      jobId,
      attempt,
      credential,
      read.operations,
      signal,
      summary,
    );
    return summary;
  }

  /**
   * The verification read of places 3 and 4. A credential error settles each
   * operation of the chunk `unknown` with `verification-failed`.
   */
  private async verificationRead(
    customer: string,
    jobId: string,
    attempt: string,
    numbers: readonly number[],
    fallback: readonly { operationNumber: number }[],
    summary: DeviceUpdateReadBackSummary,
  ): Promise<z.infer<typeof verificationReadSchema> | null> {
    try {
      const answer = z
        .union([
          verificationReadSchema,
          z.object({ outcome: z.literal('not-held') }),
        ])
        .parse(
          await this.call(
            'SELECT cc.read_device_update_verification($1,$2,$3,$4) AS result',
            [customer, jobId, attempt, JSON.stringify(numbers)],
          ),
        );
      if (answer.outcome === 'not-held') {
        summary.notHeld += 1;
        return null;
      }
      return answer;
    } catch (error) {
      if (error instanceof DeviceSyncError) throw error;
      if (error instanceof z.ZodError) throw error;
      // A credential error settles the chunk unknown with verification-failed.
      const stamp = await this.clock();
      await this.settleCall(
        customer,
        jobId,
        null,
        attempt,
        'read-back',
        fallback.map((operation) => unknownReadBack(operation.operationNumber)),
        stamp,
        null,
        null,
      );
      summary.settled += fallback.length;
      summary.unknown += fallback.length;
      return null;
    }
  }

  /** One GET round and one read-back settlement for a chunk of at most 250. */
  private async settleChunk(
    customer: string,
    jobId: string,
    attempt: string,
    credential: DelegatedCredential,
    operations: readonly HeldOperation[],
    signal: AbortSignal,
    summary: DeviceUpdateReadBackSummary,
  ): Promise<void> {
    const chunk = operations.slice(0, 250);
    if (chunk.length === 0) return;
    const now = Date.now();
    const leaseEnd = Math.min(
      ...chunk.map((operation) =>
        operation.verifyLeaseExpiresAt === null ||
        operation.verifyLeaseExpiresAt === undefined
          ? Number.POSITIVE_INFINITY
          : Date.parse(operation.verifyLeaseExpiresAt),
      ),
    );
    const after = Math.max(
      ...chunk.map((operation) =>
        operation.verifyAfter === null || operation.verifyAfter === undefined
          ? 0
          : Date.parse(operation.verifyAfter),
      ),
    );
    // Abort the GET parts of a chunk 15 s before its lease ends (ruling 7).
    if (after > leaseEnd - 15_000) {
      const stamp = await this.clock();
      const settled = await this.settleCall(
        customer,
        jobId,
        null,
        attempt,
        'read-back',
        chunk.map((operation) => unknownReadBack(operation.operationNumber)),
        stamp,
        null,
        null,
      );
      if (settled.outcome !== 'fenced')
        await this.publish(customer, settled.publication ?? null);
      summary.settled += chunk.length;
      summary.unknown += chunk.length;
      return;
    }
    await this.sleep(Math.max(0, after - now), signal);
    // Read the Postgres clock before each GET (section 5.7).
    const stamp = await this.clock();
    // Abort the GET parts 15 s before the read-back lease ends (ruling 7).
    const window = new AbortController();
    const remaining = leaseEnd - 15_000 - Date.now();
    const timer =
      Number.isFinite(remaining) && remaining > 0
        ? this.timers.setTimeout(() => window.abort(), remaining)
        : null;
    if (timer === null && Number.isFinite(remaining)) window.abort();
    let states: DeviceState[];
    try {
      states = await this.reader.deviceStates(
        credential,
        customer,
        chunk.map((operation) => operation.deviceId),
        AbortSignal.any([signal, window.signal]),
      );
    } catch (error) {
      if (error instanceof DeviceSyncError) throw error;
      const settled = await this.settleCall(
        customer,
        jobId,
        null,
        attempt,
        'read-back',
        chunk.map((operation) => unknownReadBack(operation.operationNumber)),
        stamp,
        null,
        null,
      );
      if (settled.outcome !== 'fenced') {
        await this.publish(customer, settled.publication ?? null);
        summary.settled += chunk.length;
      }
      summary.unknown += chunk.length;
      return;
    } finally {
      if (timer !== null) this.timers.clearTimeout(timer);
    }
    const byId = new Map(states.map((state) => [state.deviceId, state]));
    const results: WriteOutcome[] = [];
    for (const operation of chunk) {
      const state = byId.get(operation.deviceId);
      if (state === undefined || state.status === 'failed') {
        results.push(unknownReadBack(operation.operationNumber));
        summary.unknown += 1;
        continue;
      }
      if (state.status === 'missing') {
        results.push({
          operationNumber: operation.operationNumber,
          outcome: 'failed',
          outcomeReason: 'not-found',
          verifiedBy: 'read-back',
        });
        summary.failed += 1;
        continue;
      }
      const observed = state.device.annotatedLocation;
      const matches =
        operation.requestedValue === null
          ? observed === null
          : observed === operation.requestedValue;
      if (matches) {
        results.push({
          operationNumber: operation.operationNumber,
          outcome: 'succeeded',
          verifiedBy: 'read-back',
          value: observed,
        });
        summary.verified += 1;
      } else {
        results.push({
          operationNumber: operation.operationNumber,
          outcome: 'failed',
          outcomeReason: 'value-differs',
          verifiedBy: 'read-back',
          value: observed,
        });
        summary.failed += 1;
      }
    }
    const settled = await this.settleCall(
      customer,
      jobId,
      null,
      attempt,
      'read-back',
      results,
      stamp,
      null,
      null,
    );
    if (settled.outcome === 'fenced') {
      summary.notHeld += 1;
      return;
    }
    await this.publish(customer, settled.publication ?? null);
    summary.settled += results.length;
  }

  /** Finish steps (section 5.10). */
  async runFinish(
    request: DeviceUpdateFinishRequest,
    signal: AbortSignal,
  ): Promise<DeviceUpdateFinishAnswer> {
    const input = deviceUpdateFinishRequestSchema.parse(request);
    const prepared = await this.prepare(input, signal);
    if (prepared.outcome === 'finished')
      return { ...prepared, readBack: emptySummary() };
    if (prepared.outcome !== 'ready') return prepared;
    const attempt = randomUUID();
    const readBack = await this.readBackClaimed(
      input.customerId,
      input.jobId,
      attempt,
      signal,
    );
    const finished = finishSchema.parse(
      await this.call(
        'SELECT cc.finish_device_update_job($1,$2,$3,$4) AS result',
        [input.customerId, input.jobId, input.dispatchToken, null],
      ),
    );
    await this.publish(input.customerId, finished.publication ?? null);
    if (finished.outcome !== undefined && finished.outcome !== 'finished')
      return {
        outcome: finished.outcome,
        ...(finished.status ? { status: finished.status } : {}),
      };
    return {
      outcome: 'finished',
      status: finished.status ?? prepared.status ?? 'finished',
      failure: prepared.failure,
      readBack,
    };
  }

  /** Preparation steps 1 to 4 with the busy poll of section 5.10. */
  private async prepare(
    input: DeviceUpdateFinishRequest,
    signal: AbortSignal,
  ): Promise<
    | { outcome: 'ready'; status?: string; failure: string | null }
    | { outcome: 'superseded'; status?: string }
    | { outcome: 'finished'; status: string; failure: null }
    | { outcome: 'busy' }
  > {
    const deadline = Date.now() + 45 * 60_000;
    for (;;) {
      const answer = preparationSchema.parse(
        await this.call(
          'SELECT cc.prepare_device_update_finish($1,$2,$3,$4) AS result',
          [input.customerId, input.jobId, input.dispatchToken, null],
        ),
      );
      if (answer.outcome === 'ready')
        return {
          outcome: 'ready',
          ...(answer.status ? { status: answer.status } : {}),
          failure: answer.failure ?? null,
        };
      if (
        answer.outcome === 'busy' &&
        Date.now() < deadline &&
        !signal.aborted
      ) {
        await this.sleep(10_000, signal);
        continue;
      }
      if (answer.outcome === 'busy') return { outcome: 'busy' };
      if (answer.outcome === 'finished')
        return {
          outcome: 'finished',
          status: answer.status ?? 'finished',
          failure: null,
        };
      return {
        outcome: 'superseded',
        ...(answer.status ? { status: answer.status } : {}),
      };
    }
  }

  /** The reconcile request: one operation, or every unknown operation (ruling 2). */
  async runReconcile(
    request: DeviceUpdateReconcileRequest,
    signal: AbortSignal,
  ): Promise<DeviceUpdateReconcileAnswer> {
    const input = deviceUpdateReconcileRequestSchema.parse(request);
    if (input.operationNumber === 'all') {
      const readBack = await this.readBackClaimed(
        input.customerId,
        input.jobId,
        randomUUID(),
        signal,
      );
      return { outcome: 'settled', readBack };
    }
    if (!input.verifyAttempt) return { outcome: 'not-held' };
    const readBack = await this.readBackOperation(
      input.customerId,
      input.jobId,
      input.verifyAttempt,
      input.operationNumber,
      signal,
    );
    if (readBack.settled === 0) return { outcome: 'not-held' };
    return { outcome: 'settled', readBack };
  }

  private async release(
    customer: string,
    jobId: string,
    token: string,
    batch: number,
    attempt: string,
  ): Promise<void> {
    await this.call(
      'SELECT cc.release_device_update_batch($1,$2,$3,$4,$5) AS result',
      [customer, jobId, token, batch, attempt],
    );
  }
}

/** A read-back that has no answer leaves the operation unknown for a later Reconcile. */
function unknownReadBack(number: number): WriteOutcome {
  return {
    operationNumber: number,
    outcome: 'unknown',
    outcomeReason: 'verification-failed',
  };
}

/** The scope failure of one settlement: the code of its lowest operation (ruling 5). */
function scopeFailureOf(results: readonly WriteOutcome[]): string | null {
  const scoped = results
    .filter((result) => isScopeFailure(result.scopeFailure))
    .sort((a, b) => a.operationNumber - b.operationNumber);
  return scoped.length === 0 ? null : (scoped[0].scopeFailure ?? null);
}

function everySettled(
  tracked: Map<string, TrackedWrite>,
  operations: readonly ClaimedOperation[],
): boolean {
  return operations.every(
    (operation) => tracked.get(operation.deviceId)?.settled === true,
  );
}
