import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  deviceSyncStateSchema,
  entityEntrySchema,
  entityEventsChannel,
  entityKey,
  queryGenerationKey,
  googleCustomerIdSchema,
  type BatteryObservation,
  type DeviceObservation,
  type DeviceSyncState,
} from '@campus/application-contracts';
import {
  CredentialError,
  GoogleConnectionError,
  type CredentialCipher,
  type DelegatedCredential,
} from '@campus/google-connection';
import { recordSeconds, type EntityCache } from './entity-cache';

export interface DeviceSyncDatabase {
  query(
    sql: string,
    values: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface DeviceReader {
  devicePages(
    credential: DelegatedCredential,
    customerId: string,
    signal: AbortSignal,
  ): AsyncIterable<DeviceObservation[]>;
  batteryPages(
    credential: DelegatedCredential,
    customerId: string,
    signal: AbortSignal,
  ): AsyncIterable<BatteryObservation[]>;
}

export const deviceSyncRequestSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  syncId: z.uuid(),
  correlationId: z.uuid(),
});
export type DeviceSyncRequest = z.infer<typeof deviceSyncRequestSchema>;

const claimSchema = z.strictObject({
  generation: z.number().int().positive(),
  credentialId: z.uuid(),
  envelope: z.unknown(),
});
const leaseErrors = [
  'device-sync-changed',
  'device-sync-claimed',
  'entity-sync-changed',
  'credential-changed',
  'connection-disconnected',
  'restore-revalidation-required',
];

export class DeviceSyncError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'DeviceSyncError';
    this.code = code;
  }
}

/** Run one cc.* function. Known lease details keep their code. Everything else is a store failure. */
export async function callStore(
  database: DeviceSyncDatabase,
  sql: string,
  values: unknown[],
): Promise<unknown> {
  try {
    return (await database.query(sql, values)).rows[0]?.['result'];
  } catch (error) {
    const detail = z.object({ detail: z.string().optional() }).safeParse(error);
    const code = detail.success ? detail.data.detail : undefined;
    throw new DeviceSyncError(
      code && leaseErrors.includes(code) ? code : 'store-unavailable',
    );
  }
}

/** The cancel tick of section 3. Each refresh runner reads its job every 30 seconds. */
export const CANCEL_POLL_MILLISECONDS = 30_000;

export interface SyncTimers {
  setInterval(callback: () => unknown, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: SyncTimers = {
  setInterval: (callback, milliseconds) => {
    const handle = setInterval(callback, milliseconds);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Read the cancel request of one job. A malformed answer stays a store failure. */
export async function readCancelRequested(
  database: DeviceSyncDatabase,
  customerId: string,
  jobId: string,
): Promise<boolean> {
  const answer = z
    .boolean()
    .safeParse(
      await callStore(
        database,
        'SELECT cc.job_cancel_requested($1,$2) AS result',
        [customerId, jobId],
      ),
    );
  if (!answer.success) throw new DeviceSyncError('store-unavailable');
  return answer.data;
}

/**
 * The 30-second cancel tick of a refresh runner (section 3). A true answer aborts the
 * signal of the run, so the provider calls and any quota wait end. A failed read leaves
 * the flag unset, and the next tick reads again. A shutdown keeps its own path.
 */
export class CancelWatch {
  /** The signal of the run. The provider calls take this signal. */
  readonly signal: AbortSignal;
  private readonly stop = new AbortController();
  private readonly database: DeviceSyncDatabase;
  private readonly customerId: string;
  private readonly jobId: string;
  private readonly outer: AbortSignal;
  private readonly timers: SyncTimers;
  private readonly handle: unknown;
  private readonly forward: () => void;
  private requested = false;
  private polling = false;

  constructor(
    database: DeviceSyncDatabase,
    customerId: string,
    jobId: string,
    signal: AbortSignal,
    options: { timers?: SyncTimers; milliseconds?: number } = {},
  ) {
    this.database = database;
    this.customerId = customerId;
    this.jobId = jobId;
    this.outer = signal;
    this.signal = this.stop.signal;
    this.timers = options.timers ?? realTimers;
    this.forward = () => this.stop.abort();
    if (signal.aborted) this.stop.abort();
    else signal.addEventListener('abort', this.forward, { once: true });
    this.handle = this.timers.setInterval(
      () => this.tick(),
      options.milliseconds ?? CANCEL_POLL_MILLISECONDS,
    );
  }

  /** True once the store answered that the job holds a cancel request. */
  get cancelRequested(): boolean {
    return this.requested;
  }

  private async tick(): Promise<void> {
    if (this.requested || this.signal.aborted || this.polling) return;
    this.polling = true;
    try {
      if (
        await readCancelRequested(this.database, this.customerId, this.jobId)
      ) {
        this.requested = true;
        this.stop.abort();
      }
    } catch {
      // A failed read leaves the flag unset. The next tick reads again.
    } finally {
      this.polling = false;
    }
  }

  /** Stop the tick and stop forwarding the outer signal. */
  close(): void {
    this.timers.clearInterval(this.handle);
    this.outer.removeEventListener('abort', this.forward);
  }
}

export interface DeviceSyncOptions {
  timers?: SyncTimers;
  /** The cancel tick of section 3. Defaults to 30 seconds. */
  cancelPollMilliseconds?: number;
}

/** Run one claimed full sync. Publication soft-deletes untouched devices, fills Redis, and signals. */
export class DeviceSync {
  private readonly database: DeviceSyncDatabase;
  private readonly cipher: Pick<CredentialCipher, 'open'>;
  private readonly reader: DeviceReader;
  private readonly cache: EntityCache;
  private readonly options: DeviceSyncOptions;

  constructor(
    database: DeviceSyncDatabase,
    cipher: Pick<CredentialCipher, 'open'>,
    reader: DeviceReader,
    cache: EntityCache,
    options: DeviceSyncOptions = {},
  ) {
    this.database = database;
    this.cipher = cipher;
    this.reader = reader;
    this.cache = cache;
    this.options = options;
  }

  private call(sql: string, values: unknown[]): Promise<unknown> {
    return callStore(this.database, sql, values);
  }

  async run(
    request: DeviceSyncRequest,
    signal: AbortSignal,
  ): Promise<DeviceSyncState> {
    const input = deviceSyncRequestSchema.parse(request);
    const lease = [input.customerId, input.syncId, randomUUID()];
    const claim = claimSchema.parse(
      await this.call('SELECT cc.claim_device_sync($1,$2,$3) AS result', lease),
    );
    const watch = new CancelWatch(
      this.database,
      input.customerId,
      input.syncId,
      signal,
      {
        timers: this.options.timers,
        milliseconds: this.options.cancelPollMilliseconds,
      },
    );
    let failure: string | null = null;
    let telemetryFailure: string | null = null;
    try {
      try {
        const credential = this.cipher.open(claim.envelope, {
          recordId: claim.credentialId,
          customerId: input.customerId,
          generation: claim.generation,
        });
        for await (const page of this.reader.devicePages(
          credential,
          input.customerId,
          watch.signal,
        ))
          await this.call('SELECT cc.stage_devices($1,$2,$3,$4) AS result', [
            ...lease,
            JSON.stringify(page),
          ]);
        try {
          for await (const page of this.reader.batteryPages(
            credential,
            input.customerId,
            watch.signal,
          ))
            await this.call(
              'SELECT cc.stage_device_batteries($1,$2,$3,$4) AS result',
              [...lease, JSON.stringify(page)],
            );
        } catch (error) {
          if (!(error instanceof GoogleConnectionError)) throw error;
          telemetryFailure = error.code;
        }
      } catch (error) {
        if (error instanceof DeviceSyncError) throw error;
        failure =
          error instanceof GoogleConnectionError
            ? error.code
            : error instanceof CredentialError
              ? 'key-unavailable'
              : 'request-failed';
      }
      // A cancelled job closes its header, so the finish raises device-sync-changed.
      const state = deviceSyncStateSchema.parse(
        await this.call(
          'SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result',
          [...lease, failure, telemetryFailure],
        ),
      );
      if (failure === null && !watch.cancelRequested) {
        try {
          // Postgres has published. Redis work must not fail the sync.
          // Records of the devices this sync removed leave Redis first.
          const removedPage = z.array(z.string());
          for (let after = ''; !watch.signal.aborted; ) {
            const ids = removedPage.parse(
              await this.call(
                'SELECT cc.page_last_removed_device_ids($1,$2,$3) AS result',
                [input.customerId, after, 1000],
              ),
            );
            if (ids.length === 0) break;
            await this.cache.remove(
              ids.map((id) => entityKey('device', input.customerId, id)),
            );
            after = ids[ids.length - 1];
          }
          const recordPage = z.array(entityEntrySchema);
          for (let after = ''; !watch.signal.aborted; ) {
            const records = recordPage.parse(
              await this.call(
                'SELECT cc.page_device_records($1,$2,$3) AS result',
                [input.customerId, after, 1000],
              ),
            );
            if (records.length === 0) break;
            await this.cache.setRecords(
              records.map((entry) => ({
                key: entityKey(
                  'device',
                  input.customerId,
                  entry.record.deviceId,
                ),
                value: JSON.stringify(entry),
                seconds: recordSeconds(entry.record.lastEntitySync),
              })),
            );
            after = records[records.length - 1].record.deviceId;
          }
          await this.cache.increment(
            queryGenerationKey('device', input.customerId),
          );
        } catch {
          // The next read fills the cache. Plan B reconciles the generation on its next full sync.
        }
      }
      if (!watch.cancelRequested) {
        try {
          await this.cache.publish(
            entityEventsChannel(input.customerId),
            JSON.stringify({ type: 'full-sync', sync: state }),
          );
        } catch {
          // The client still polls the sync state.
        }
      }
      return state;
    } finally {
      watch.close();
    }
  }
}
