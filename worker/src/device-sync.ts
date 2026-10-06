import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  deviceSyncStateSchema,
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
const purgeBatch = 5000;

export class DeviceSyncError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'DeviceSyncError';
    this.code = code;
  }
}

/** Run one claimed sync. Publication replaces the inventory only after every device page stages. */
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

export class DeviceSync {
  private readonly database: DeviceSyncDatabase;
  private readonly cipher: Pick<CredentialCipher, 'open'>;
  private readonly reader: DeviceReader;

  constructor(
    database: DeviceSyncDatabase,
    cipher: Pick<CredentialCipher, 'open'>,
    reader: DeviceReader,
  ) {
    this.database = database;
    this.cipher = cipher;
    this.reader = reader;
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
    for (let removed = purgeBatch; removed === purgeBatch && !signal.aborted; )
      removed = Number(
        await this.call('SELECT cc.purge_device_syncs($1,$2) AS result', [
          input.customerId,
          purgeBatch,
        ]),
      );
    return state;
  }
}
