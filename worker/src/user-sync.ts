import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  entityEventsChannel,
  entityKey,
  googleCustomerIdSchema,
  queryGenerationKey,
  userEntrySchema,
  userSyncStateSchema,
  type UserObservation,
  type UserSyncState,
} from '@campus/application-contracts';
import {
  CredentialError,
  GoogleConnectionError,
  type CredentialCipher,
  type DelegatedCredential,
} from '@campus/google-connection';
import { recordSeconds, type EntityCache } from './entity-cache';
import {
  CancelWatch,
  DeviceSyncError,
  callStore,
  type DeviceSyncDatabase,
  type SyncTimers,
} from './device-sync';

export interface UserReader {
  userPages(
    credential: DelegatedCredential,
    customerId: string,
    signal: AbortSignal,
  ): AsyncIterable<UserObservation[]>;
}

export const userSyncRequestSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  syncId: z.uuid(),
  correlationId: z.uuid(),
});
export type UserSyncRequest = z.infer<typeof userSyncRequestSchema>;

const claimSchema = z.strictObject({
  generation: z.number().int().positive(),
  credentialId: z.uuid(),
  envelope: z.unknown(),
});

export interface UserSyncOptions {
  timers?: SyncTimers;
  /** The cancel tick of section 3. Defaults to 30 seconds. */
  cancelPollMilliseconds?: number;
}

/** Run one claimed full user sync. Publication soft-deletes untouched users, fills Redis, and signals. */
export class UserSync {
  private readonly database: DeviceSyncDatabase;
  private readonly cipher: Pick<CredentialCipher, 'open'>;
  private readonly reader: UserReader;
  private readonly cache: EntityCache;
  private readonly options: UserSyncOptions;

  constructor(
    database: DeviceSyncDatabase,
    cipher: Pick<CredentialCipher, 'open'>,
    reader: UserReader,
    cache: EntityCache,
    options: UserSyncOptions = {},
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
    request: UserSyncRequest,
    signal: AbortSignal,
  ): Promise<UserSyncState> {
    const input = userSyncRequestSchema.parse(request);
    const lease = [input.customerId, input.syncId, randomUUID()];
    const claim = claimSchema.parse(
      await this.call('SELECT cc.claim_user_sync($1,$2,$3) AS result', lease),
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
    try {
      try {
        const credential = this.cipher.open(claim.envelope, {
          recordId: claim.credentialId,
          customerId: input.customerId,
          generation: claim.generation,
        });
        for await (const page of this.reader.userPages(
          credential,
          input.customerId,
          watch.signal,
        ))
          await this.call('SELECT cc.stage_users($1,$2,$3,$4) AS result', [
            ...lease,
            JSON.stringify(page),
          ]);
      } catch (error) {
        if (error instanceof DeviceSyncError) throw error;
        failure =
          error instanceof GoogleConnectionError
            ? error.code
            : error instanceof CredentialError
              ? 'key-unavailable'
              : 'request-failed';
      }
      // A cancelled job closes its header, so the finish raises user-sync-changed.
      const state = userSyncStateSchema.parse(
        await this.call('SELECT cc.finish_user_sync($1,$2,$3,$4) AS result', [
          ...lease,
          failure,
        ]),
      );
      if (failure === null && !watch.cancelRequested) {
        try {
          // Postgres has published. Redis work must not fail the sync.
          // Records of the users this sync removed leave Redis first.
          const removedPage = z.array(z.string());
          for (let after = ''; !watch.signal.aborted; ) {
            const ids = removedPage.parse(
              await this.call(
                'SELECT cc.page_last_removed_user_ids($1,$2,$3) AS result',
                [input.customerId, after, 1000],
              ),
            );
            if (ids.length === 0) break;
            await this.cache.remove(
              ids.map((id) => entityKey('user', input.customerId, id)),
            );
            after = ids[ids.length - 1];
          }
          const recordPage = z.array(userEntrySchema);
          for (let after = ''; !watch.signal.aborted; ) {
            const records = recordPage.parse(
              await this.call(
                'SELECT cc.page_user_records($1,$2,$3) AS result',
                [input.customerId, after, 1000],
              ),
            );
            if (records.length === 0) break;
            await this.cache.setRecords(
              records.map((entry) => ({
                key: entityKey('user', input.customerId, entry.record.userId),
                value: JSON.stringify(entry),
                seconds: recordSeconds(entry.record.lastEntitySync),
              })),
            );
            after = records[records.length - 1].record.userId;
          }
          await this.cache.increment(
            queryGenerationKey('user', input.customerId),
          );
        } catch {
          // The next read fills the cache. Plan B reconciles the generation on its next full sync.
        }
      }
      if (!watch.cancelRequested) {
        try {
          await this.cache.publish(
            entityEventsChannel(input.customerId),
            JSON.stringify({ type: 'user-full-sync', sync: state }),
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
