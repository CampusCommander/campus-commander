import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ENTITY_CACHE_SECONDS,
  deviceSyncStateSchema,
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
import type { EntityCache } from './entity-cache';

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

/** Run one claimed full sync. Publication soft-deletes untouched devices, fills Redis, and signals. */
export class DeviceSync {
  private readonly database: DeviceSyncDatabase;
  private readonly cipher: Pick<CredentialCipher, 'open'>;
  private readonly reader: DeviceReader;
  private readonly cache: EntityCache;

  constructor(
    database: DeviceSyncDatabase,
    cipher: Pick<CredentialCipher, 'open'>,
    reader: DeviceReader,
    cache: EntityCache,
  ) {
    this.database = database;
    this.cipher = cipher;
    this.reader = reader;
    this.cache = cache;
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
    let failure: string | null = null;
    let telemetryFailure: string | null = null;
    try {
      const credential = this.cipher.open(claim.envelope, {
        recordId: claim.credentialId,
        customerId: input.customerId,
        generation: claim.generation,
      });
      for await (const page of this.reader.devicePages(
        credential,
        input.customerId,
        signal,
      ))
        await this.call('SELECT cc.stage_devices($1,$2,$3,$4) AS result', [
          ...lease,
          JSON.stringify(page),
        ]);
      try {
        for await (const page of this.reader.batteryPages(
          credential,
          input.customerId,
          signal,
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
    const state = deviceSyncStateSchema.parse(
      await this.call(
        'SELECT cc.finish_device_sync($1,$2,$3,$4,$5) AS result',
        [...lease, failure, telemetryFailure],
      ),
    );
    if (failure === null) {
      try {
        // Postgres has published. Redis work must not fail the sync.
        // Records of the devices this sync removed leave Redis first.
        const removedPage = z.array(z.string());
        for (let after = ''; !signal.aborted; ) {
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
        const recordPage = z.array(z.object({ deviceId: z.string() }).passthrough());
        for (let after = ''; !signal.aborted; ) {
          const records = recordPage.parse(
            await this.call('SELECT cc.page_device_records($1,$2,$3) AS result', [
              input.customerId,
              after,
              1000,
            ]),
          );
          if (records.length === 0) break;
          await this.cache.setRecords(
            records.map((record) => {
              const cached: Record<string, unknown> = { ...record };
              delete cached['removedAt'];
              return {
                key: entityKey('device', input.customerId, record.deviceId),
                value: JSON.stringify(cached),
              };
            }),
            ENTITY_CACHE_SECONDS.device,
          );
          after = records[records.length - 1].deviceId;
        }
        await this.cache.increment(queryGenerationKey('device', input.customerId));
      } catch {
        // The next read fills the cache. Plan B reconciles the generation on its next full sync.
      }
    }
    try {
      await this.cache.publish(
        entityEventsChannel(input.customerId),
        JSON.stringify({ type: 'full-sync', sync: state }),
      );
    } catch {
      // The client still polls the sync state.
    }
    return state;
  }
}
