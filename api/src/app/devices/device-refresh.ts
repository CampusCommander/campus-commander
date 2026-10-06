import { randomUUID } from 'node:crypto';
import {
  ENTITY_INFLIGHT_SECONDS,
  ENTITY_SYNC_BATCH_SIZE,
  entitySyncJobSchema,
  inflightKey,
} from '@campus/application-contracts';
import type { CacheService } from '../cache/cache.service';
import type { OrchestrationService } from '../orchestration/orchestration.service';

/**
 * Start one refresh job for stale devices. The in-flight set keeps overlapping
 * queries from dispatching the same device twice within two minutes.
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

  /** Returns the job ID, or null when nothing new needed a refresh or the flow could not start. */
  async dispatch(
    actor: readonly [string, number],
    customerId: string,
    ids: readonly string[],
    correlationId: string,
  ): Promise<string | null> {
    if (ids.length === 0) return null;
    const key = inflightKey('device', customerId);
    let fresh: string[];
    try {
      fresh = await this.cache.addMembers(key, ids, ENTITY_INFLIGHT_SECONDS);
    } catch {
      return null;
    }
    if (fresh.length === 0) return null;
    const jobId = randomUUID();
    let created = false;
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
      created = true;
      await this.orchestration.startEntitySync({
        customerId,
        jobId,
        batchCount: job.batchCount,
        correlationId,
      });
      return job.jobId;
    } catch {
      if (created)
        await this.store(
          'SELECT cc.abandon_entity_sync_job($1,$2,$3,$4) AS result',
          [...actor, customerId, jobId],
        ).catch(() => undefined);
      await this.cache.removeMembers(key, fresh).catch(() => undefined);
      return null;
    }
  }
}
