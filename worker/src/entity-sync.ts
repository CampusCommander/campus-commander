import { z } from 'zod';
import {
  ENTITY_INFLIGHT_SECONDS,
  entityEntrySchema,
  entityEventsChannel,
  entityKey,
  entitySyncBatchRequestSchema,
  entitySyncJobSchema,
  entityTypeSchema,
  inflightKey,
  userEntrySchema,
  type BatteryObservation,
  type DeviceObservation,
  type EntityEvent,
  type EntitySyncBatchRequest,
  type EntitySyncJob,
  type UserObservation,
} from '@campus/application-contracts';
import {
  BATCH_DEFAULTS,
  CredentialError,
  GoogleConnectionError,
  type CredentialCipher,
  type DelegatedCredential,
} from '@campus/google-connection';
import {
  EntityCacheError,
  recordSeconds,
  type EntityCache,
} from './entity-cache';
import {
  CancelWatch,
  DeviceSyncError,
  callStore,
  readCancelRequested,
  type DeviceSyncDatabase,
  type SyncTimers,
} from './device-sync';

export interface EntityReader {
  deviceBatch(
    credential: DelegatedCredential,
    customerId: string,
    ids: readonly string[],
    signal: AbortSignal,
    onRound?: () => Promise<void>,
  ): Promise<{ devices: DeviceObservation[]; missing: string[] }>;
  batteryBatch(
    credential: DelegatedCredential,
    customerId: string,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<BatteryObservation[]>;
  userBatch(
    credential: DelegatedCredential,
    customerId: string,
    ids: readonly string[],
    signal: AbortSignal,
    onRound?: () => Promise<void>,
  ): Promise<{ users: UserObservation[]; missing: string[] }>;
}

export interface EntitySyncBatchResult {
  job: EntitySyncJob;
  updated: string[];
  removed: string[];
  failure: string | null;
}

const batchSchema = z.strictObject({
  generation: z.number().int().positive(),
  credentialId: z.uuid(),
  envelope: z.unknown(),
  batchCount: z.number().int().min(1),
  entityType: entityTypeSchema,
  ids: z.array(z.string().min(1).max(128)).max(1000),
});
const recordsSchema = z.array(entityEntrySchema);
const userRecordsSchema = z.array(userEntrySchema);

const defaultBackoff = (attempt: number) =>
  Math.min(60_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 500);

async function defaultSleep(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) throw new DeviceSyncError('worker-stopping');
  await new Promise<void>((resolve, reject) => {
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

type Batch = z.infer<typeof batchSchema>;
interface BatchRead {
  updated: string[];
  removed: string[];
}

/**
 * One Kestra batch: read the slice, fetch from Google, upsert, cache, signal, record.
 * The batch row names its entity type, so one runner serves device and user refresh jobs.
 * The batch service retries Directory quota answers per part. Telemetry quota answers retry here.
 * Every other Directory error fails the batch once.
 * Every other telemetry error keeps the stored battery fields and the batch succeeds.
 */
export class EntitySyncBatch {
  private readonly database: DeviceSyncDatabase;
  private readonly cipher: Pick<CredentialCipher, 'open'>;
  private readonly reader: EntityReader;
  private readonly cache: EntityCache;
  private readonly options: {
    backoff?: (attempt: number) => number;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    timers?: SyncTimers;
    /** The cancel tick of section 3. Defaults to 30 seconds. */
    cancelPollMilliseconds?: number;
  };

  constructor(
    database: DeviceSyncDatabase,
    cipher: Pick<CredentialCipher, 'open'>,
    reader: EntityReader,
    cache: EntityCache,
    options: {
      backoff?: (attempt: number) => number;
      sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
      timers?: SyncTimers;
      /** The cancel tick of section 3. Defaults to 30 seconds. */
      cancelPollMilliseconds?: number;
    } = {},
  ) {
    this.database = database;
    this.cipher = cipher;
    this.reader = reader;
    this.cache = cache;
    this.options = options;
  }

  private call(sql: string, values: unknown[]) {
    return callStore(this.database, sql, values);
  }

  /**
   * Retry only quota answers, up to 25 times. A shutdown signal ends the wait with worker-stopping.
   * Each wait first extends the claim on the batch IDs, so a retrying batch keeps them.
   */
  private async untilQuotaClears<T>(
    signal: AbortSignal,
    claim: { key: string; ids: readonly string[] },
    read: () => Promise<T>,
  ): Promise<T> {
    const backoff = this.options.backoff ?? defaultBackoff;
    const sleep = this.options.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt++) {
      try {
        return await read();
      } catch (error) {
        if (
          !(error instanceof GoogleConnectionError) ||
          error.code !== 'quota' ||
          attempt >= BATCH_DEFAULTS.maxQuotaRetries
        )
          throw error;
        await this.cache
          .extendMembers(claim.key, claim.ids, ENTITY_INFLIGHT_SECONDS)
          .catch(() => undefined);
        await sleep(backoff(attempt), signal);
      }
    }
  }

  private async publish(customerId: string, event: EntityEvent) {
    await this.cache.publish(
      entityEventsChannel(customerId),
      JSON.stringify(event),
    );
  }

  /**
   * One device batch. The Directory read retries its quota parts in the batch service, and the
   * telemetry read retries here. A true cancel answer ends the batch before any write.
   */
  private async deviceBatch(
    customerId: string,
    jobId: string,
    batch: Batch,
    credential: DelegatedCredential,
    signal: AbortSignal,
    syncedAt: string,
    extendClaim: () => Promise<void>,
  ): Promise<BatchRead> {
    const claim = {
      key: inflightKey('device', customerId),
      ids: batch.ids,
    };
    // Each multipart round extends the claim, so a long quota wave keeps the batch IDs.
    const read = await this.reader.deviceBatch(
      credential,
      customerId,
      batch.ids,
      signal,
      extendClaim,
    );
    const present = read.devices.map((device) => device.deviceId);
    let batteries: BatteryObservation[] | null = null;
    try {
      batteries = await this.untilQuotaClears(signal, claim, () =>
        this.reader.batteryBatch(credential, customerId, present, signal),
      );
    } catch (error) {
      // A telemetry failure keeps the stored battery fields. The Directory data still lands.
      if (
        signal.aborted ||
        !(error instanceof GoogleConnectionError) ||
        error.code === 'quota'
      )
        throw error;
    }
    // Section 3: a second read before the upsert. A true answer ends the batch with no
    // device write and no batch record, so a cancel during the Google read stores nothing.
    if (await readCancelRequested(this.database, customerId, jobId))
      throw new DeviceSyncError('entity-sync-changed');
    // A refresh read is a current observation. The kind orders it against a live overlay (5.8).
    await this.call('SELECT cc.upsert_devices($1,$2,$3,$4) AS result', [
      customerId,
      JSON.stringify(read.devices),
      syncedAt,
      'read',
    ]);
    if (batteries)
      await this.call('SELECT cc.upsert_device_batteries($1,$2) AS result', [
        customerId,
        JSON.stringify(batteries),
      ]);
    await this.call('SELECT cc.soft_delete_devices($1,$2) AS result', [
      customerId,
      JSON.stringify(read.missing),
    ]);
    const records = recordsSchema.parse(
      await this.call('SELECT cc.read_device_records($1,$2) AS result', [
        customerId,
        JSON.stringify(present),
      ]),
    );
    await this.cache.setRecords(
      records.map((entry) => ({
        key: entityKey('device', customerId, entry.record.deviceId),
        value: JSON.stringify(entry),
        seconds: recordSeconds(entry.record.lastEntitySync),
      })),
    );
    await this.cache.remove(
      read.missing.map((id) => entityKey('device', customerId, id)),
    );
    return {
      updated: records.map((entry) => entry.record.deviceId),
      removed: read.missing,
    };
  }

  /**
   * One user batch (document A section 6). A 404 part names a removed user, whose row stays and
   * whose cache entry leaves. The store decides the removal, and the batch reports only what it
   * accepted, so an older 404 never reports or evicts a user that a newer read returned (R3b).
   * The user reader retries a quota answer on its own part.
   */
  private async userBatch(
    customerId: string,
    jobId: string,
    batch: Batch,
    credential: DelegatedCredential,
    signal: AbortSignal,
    syncedAt: string,
    extendClaim: () => Promise<void>,
  ): Promise<BatchRead> {
    // Each batch service round extends the claim, so a long quota wave keeps the user batch IDs.
    const read = await this.reader.userBatch(
      credential,
      customerId,
      batch.ids,
      signal,
      extendClaim,
    );
    const present = read.users.map((user) => user.userId);
    if (await readCancelRequested(this.database, customerId, jobId))
      throw new DeviceSyncError('entity-sync-changed');
    await this.call('SELECT cc.upsert_users($1,$2,$3) AS result', [
      customerId,
      JSON.stringify(read.users),
      syncedAt,
    ]);
    // The store answers with the users it holds removed after this observation. A 404 that a newer
    // presence read predates changes no row, so it leaves the result, the cache eviction, and the
    // published event alone (R3b).
    const removed = z
      .array(z.string().min(1).max(128))
      .max(1000)
      .parse(
        await this.call('SELECT cc.soft_delete_users($1,$2,$3) AS result', [
          customerId,
          JSON.stringify(read.missing),
          syncedAt,
        ]),
      );
    const records = userRecordsSchema.parse(
      await this.call('SELECT cc.read_user_records($1,$2) AS result', [
        customerId,
        JSON.stringify(present),
      ]),
    );
    await this.cache.setRecords(
      records.map((entry) => ({
        key: entityKey('user', customerId, entry.record.userId),
        value: JSON.stringify(entry),
        seconds: recordSeconds(entry.record.lastEntitySync),
      })),
    );
    if (removed.length > 0)
      await this.cache.remove(
        removed.map((id) => entityKey('user', customerId, id)),
      );
    return {
      updated: records.map((entry) => entry.record.userId),
      removed,
    };
  }

  async run(
    request: EntitySyncBatchRequest,
    signal: AbortSignal,
  ): Promise<EntitySyncBatchResult> {
    const input = entitySyncBatchRequestSchema.parse(request);
    const batch = batchSchema.parse(
      await this.call('SELECT cc.read_entity_sync_batch($1,$2,$3) AS result', [
        input.customerId,
        input.jobId,
        input.batch,
      ]),
    );
    const watch = new CancelWatch(
      this.database,
      input.customerId,
      input.jobId,
      signal,
      {
        timers: this.options.timers,
        milliseconds: this.options.cancelPollMilliseconds,
      },
    );
    const inflight = inflightKey(batch.entityType, input.customerId);
    let updated: string[] = [];
    let removed: string[] = [];
    let failure: string | null = null;
    try {
      const credential = this.cipher.open(batch.envelope, {
        recordId: batch.credentialId,
        customerId: input.customerId,
        generation: batch.generation,
      });
      // Postgres stamps freshness before the Directory read. A slow batch cannot claim newer data.
      const clock = await this.call('SELECT clock_timestamp() AS result', []);
      const stamp = new Date(
        clock instanceof Date || typeof clock === 'string' ? clock : Number.NaN,
      );
      if (Number.isNaN(stamp.getTime()))
        throw new DeviceSyncError('store-unavailable');
      const syncedAt = stamp.toISOString();
      const extendClaim = async () => {
        await this.cache
          .extendMembers(inflight, batch.ids, ENTITY_INFLIGHT_SECONDS)
          .catch(() => undefined);
      };
      const read =
        batch.entityType === 'device'
          ? await this.deviceBatch(
              input.customerId,
              input.jobId,
              batch,
              credential,
              watch.signal,
              syncedAt,
              extendClaim,
            )
          : await this.userBatch(
              input.customerId,
              input.jobId,
              batch,
              credential,
              watch.signal,
              syncedAt,
              extendClaim,
            );
      updated = read.updated;
      removed = read.removed;
    } catch (error) {
      if (error instanceof DeviceSyncError || error instanceof EntityCacheError)
        throw error;
      if (watch.signal.aborted) throw new DeviceSyncError('worker-stopping');
      failure =
        error instanceof GoogleConnectionError
          ? error.code
          : error instanceof CredentialError
            ? 'key-unavailable'
            : 'request-failed';
    } finally {
      watch.close();
    }
    // Freed IDs let the next stale read dispatch them again.
    await this.cache.removeMembers(inflight, batch.ids);
    if (failure === null)
      await this.publish(input.customerId, {
        type: 'entity-batch',
        jobId: input.jobId,
        entityType: batch.entityType,
        batch: input.batch,
        batchCount: batch.batchCount,
        deviceIds: updated,
        removedIds: removed,
      });
    const job = entitySyncJobSchema.parse(
      await this.call(
        'SELECT cc.finish_entity_sync_batch($1,$2,$3,$4) AS result',
        [input.customerId, input.jobId, input.batch, failure],
      ),
    );
    if (job.finishedAt)
      try {
        await this.publish(input.customerId, { type: 'job-finished', job });
      } catch {
        /* The finish is recorded. Plan B reconciles on reconnect. */
      }
    return { job, updated, removed, failure };
  }
}
