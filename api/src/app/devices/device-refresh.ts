import { randomUUID } from 'node:crypto';
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import {
  ENTITY_INFLIGHT_SECONDS,
  ENTITY_SYNC_BATCH_SIZE,
  entitySyncJobSchema,
  inflightKey,
} from '@campus/application-contracts';
import type { CacheService } from '../cache/cache.service';
import type { OrchestrationService } from '../orchestration/orchestration.service';

/**
 * Start one refresh job for device IDs. Each device ID stays claimed for two minutes
 * after its last claim, so overlapping requests do not dispatch it twice.
 */
export class DeviceRefresh {
  // Explicit fields: Node's type-stripping test runner rejects parameter properties.
  private readonly cache: Pick<CacheService, 'addMembers' | 'removeMembers'>;
  private readonly orchestration: Pick<OrchestrationService, 'startEntitySync'>;
  private readonly store: (sql: string, values: unknown[]) => Promise<unknown>;

  constructor(
    cache: Pick<CacheService, 'addMembers' | 'removeMembers'>,
    orchestration: Pick<OrchestrationService, 'startEntitySync'>,
    store: (sql: string, values: unknown[]) => Promise<unknown>,
  ) {
    this.cache = cache;
    this.orchestration = orchestration;
    this.store = store;
  }

  /**
   * Start one job for the given IDs. Returns the job ID, or null when every ID is already
   * claimed. A store or flow failure throws, because an explicit request reports its failure.
   */
  async request(
    actor: readonly [string, number],
    customerId: string,
    ids: readonly string[],
    correlationId: string,
  ): Promise<string | null> {
    if (ids.length === 0) return null;
    // Reaping old jobs is housekeeping. A store fault here must not block the refresh.
    await this.store('SELECT cc.purge_jobs($1,$2) AS result', [
      customerId,
      100,
    ]).catch(() => undefined);
    const key = inflightKey('device', customerId);
    let fresh: string[];
    try {
      fresh = await this.cache.addMembers(key, ids, ENTITY_INFLIGHT_SECONDS);
    } catch {
      throw new ServiceUnavailableException({
        reason: 'device-store-unavailable',
      });
    }
    if (fresh.length === 0) return null;
    const jobId = randomUUID();
    let createdId: string;
    let batchCount: number;
    try {
      const job = entitySyncJobSchema.parse(
        await this.store(
          'SELECT cc.create_entity_sync_job($1,$2,$3,$4,$5,$6,$7,$8) AS result',
          [
            ...actor,
            customerId,
            'device',
            JSON.stringify(fresh),
            ENTITY_SYNC_BATCH_SIZE,
            jobId,
            correlationId,
          ],
        ),
      );
      createdId = job.jobId;
      batchCount = job.batchCount;
    } catch (error) {
      await this.cache.removeMembers(key, fresh).catch(() => undefined);
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({
        reason: 'device-store-unavailable',
      });
    }
    try {
      await this.orchestration.startEntitySync({
        customerId,
        jobId: createdId,
        batchCount,
        correlationId,
      });
    } catch {
      await this.store(
        'SELECT cc.abandon_entity_sync_job($1,$2,$3,$4) AS result',
        [...actor, customerId, createdId],
      ).catch(() => undefined);
      await this.cache.removeMembers(key, fresh).catch(() => undefined);
      throw new ServiceUnavailableException({
        reason: 'orchestration-unavailable',
      });
    }
    return createdId;
  }

  /** Returns the job ID, or null when nothing new needed a refresh or the refresh failed. */
  async dispatch(
    actor: readonly [string, number],
    customerId: string,
    ids: readonly string[],
    correlationId: string,
  ): Promise<string | null> {
    try {
      return await this.request(actor, customerId, ids, correlationId);
    } catch {
      // A page read leaves its grid unchanged when the refresh cannot start.
      return null;
    }
  }
}
