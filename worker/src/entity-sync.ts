import { z } from 'zod';
import {
  ENTITY_CACHE_SECONDS,
  ENTITY_INFLIGHT_SECONDS,
  entityEventsChannel,
  entityKey,
  entitySyncBatchRequestSchema,
  entitySyncJobSchema,
  inflightKey,
  type BatteryObservation,
  type DeviceObservation,
  type EntityEvent,
  type EntitySyncBatchRequest,
  type EntitySyncJob,
} from '@campus/application-contracts';
import {
  CredentialError,
  GoogleConnectionError,
  type CredentialCipher,
  type DelegatedCredential,
} from '@campus/google-connection';
import { EntityCacheError, type EntityCache } from './entity-cache';
import {
  DeviceSyncError,
  callStore,
  type DeviceSyncDatabase,
} from './device-sync';

export interface EntityReader {
  deviceBatch(
    credential: DelegatedCredential,
    customerId: string,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<{ devices: DeviceObservation[]; missing: string[] }>;
  batteryBatch(
    credential: DelegatedCredential,
    customerId: string,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<BatteryObservation[]>;
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
  ids: z.array(z.string().min(1).max(128)).max(1000),
});
const recordsSchema = z.array(z.object({ deviceId: z.string() }).passthrough());

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

/**
 * One Kestra batch: read the slice, fetch from Google, upsert, cache, signal, record.
 * Quota errors retry inside the worker. Every other Directory error fails the batch once.
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
  };

  constructor(
    database: DeviceSyncDatabase,
    cipher: Pick<CredentialCipher, 'open'>,
    reader: EntityReader,
    cache: EntityCache,
    options: {
      backoff?: (attempt: number) => number;
      sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
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
   * Retry only quota answers. A shutdown signal ends the wait with worker-stopping.
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
        if (!(error instanceof GoogleConnectionError) || error.code !== 'quota')
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
    const inflight = inflightKey('device', input.customerId);
    const claim = { key: inflight, ids: batch.ids };
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
      const read = await this.untilQuotaClears(signal, claim, () =>
        this.reader.deviceBatch(
          credential,
          input.customerId,
          batch.ids,
          signal,
        ),
      );
      const present = read.devices.map((device) => device.deviceId);
      let batteries: BatteryObservation[] | null = null;
      try {
        batteries = await this.untilQuotaClears(signal, claim, () =>
          this.reader.batteryBatch(credential, input.customerId, present, signal),
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
      await this.call('SELECT cc.upsert_devices($1,$2,$3) AS result', [
        input.customerId,
        JSON.stringify(read.devices),
        syncedAt,
      ]);
      if (batteries)
        await this.call('SELECT cc.upsert_device_batteries($1,$2) AS result', [
          input.customerId,
          JSON.stringify(batteries),
        ]);
      await this.call('SELECT cc.soft_delete_devices($1,$2) AS result', [
        input.customerId,
        JSON.stringify(read.missing),
      ]);
      const records = recordsSchema.parse(
        await this.call('SELECT cc.read_device_records($1,$2) AS result', [
          input.customerId,
          JSON.stringify(present),
        ]),
      );
      updated = records.map((record) => record.deviceId);
      removed = read.missing;
      await this.cache.setRecords(
        records.map((record) => {
          const cached = { ...record };
          delete cached['removedAt'];
          return {
            key: entityKey('device', input.customerId, record.deviceId),
            value: JSON.stringify(cached),
          };
        }),
        ENTITY_CACHE_SECONDS.device,
      );
      await this.cache.remove(
        removed.map((id) => entityKey('device', input.customerId, id)),
      );
    } catch (error) {
      if (error instanceof DeviceSyncError || error instanceof EntityCacheError)
        throw error;
      if (signal.aborted) throw new DeviceSyncError('worker-stopping');
      failure =
        error instanceof GoogleConnectionError
          ? error.code
          : error instanceof CredentialError
            ? 'key-unavailable'
            : 'request-failed';
    }
    // Freed IDs let the next stale read dispatch them again.
    await this.cache.removeMembers(inflight, batch.ids);
    if (failure === null)
      await this.publish(input.customerId, {
        type: 'entity-batch',
        jobId: input.jobId,
        entityType: 'device',
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
