import {
  ConflictException,
  HttpException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  DeviceSelectionKey,
  SessionResponse,
} from '@campus/application-contracts';
import { selectionIdsSql } from './device-query';
import {
  hasSelection,
  parseSelection,
  selectionStorageKey,
  type SelectionState,
} from './device-selection';

/** The preview and cc.create_entity_sync_job both bound one selection at 100,000 devices. */
export const MAX_REFRESH_DEVICES = 100_000;
/** Device IDs travel into Google request paths. Only plain identifiers enter a job. */
const plainDeviceId = /^[A-Za-z0-9_-]{1,128}$/;

interface QueryResult {
  rows: Record<string, unknown>[];
}
interface QueryClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}
export interface SelectionRefreshDatabase {
  transaction<T>(run: (client: QueryClient) => Promise<T>): Promise<T>;
}
export interface SelectionRefreshCache {
  get(key: string): Promise<string | null>;
}
export interface SelectionRefreshDispatch {
  request(
    actor: readonly [string, number],
    customerId: string,
    ids: readonly string[],
    correlationId: string,
  ): Promise<string | null>;
}

export interface SelectionRefreshAnswer {
  jobId: string | null;
  selected: number;
}

/** A new job answers 201. A selection whose devices are all claimed answers 200. */
export function selectionRefreshStatus(
  answer: SelectionRefreshAnswer,
): 200 | 201 {
  return answer.jobId === null ? 200 : 201;
}

/**
 * Refresh Selected: resolve the stored selection to device IDs, then start one refresh job.
 * Removed devices and non-plain IDs stay out of the job, the same rule the preview applies.
 */
export class DeviceSelectionRefresh {
  private readonly database: SelectionRefreshDatabase;
  private readonly cache: SelectionRefreshCache;
  private readonly refresh: SelectionRefreshDispatch;

  constructor(
    database: SelectionRefreshDatabase,
    cache: SelectionRefreshCache,
    refresh: SelectionRefreshDispatch,
  ) {
    this.database = database;
    this.cache = cache;
    this.refresh = refresh;
  }

  private async stored(session: SessionResponse, key: DeviceSelectionKey) {
    try {
      return await this.cache.get(
        selectionStorageKey(session.identity.id, key),
      );
    } catch {
      throw new ServiceUnavailableException({
        reason: 'device-store-unavailable',
      });
    }
  }

  private async selectedRows(customerId: string, state: SelectionState) {
    const sql = selectionIdsSql(customerId, state);
    try {
      return await this.database.transaction(
        async (client) => (await client.query(sql.text, sql.values)).rows,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({
        reason: 'device-store-unavailable',
      });
    }
  }

  async request(
    session: SessionResponse,
    customerId: string,
    key: DeviceSelectionKey,
    correlationId: string,
  ): Promise<SelectionRefreshAnswer> {
    const { state, expiredAt } = parseSelection(
      await this.stored(session, key),
    );
    if (expiredAt)
      throw new ConflictException({ reason: 'selection-expired', expiredAt });
    if (!hasSelection(state))
      throw new UnprocessableEntityException({ reason: 'nothing-selected' });
    const rows = await this.selectedRows(customerId, state);
    if (rows.length > MAX_REFRESH_DEVICES)
      throw new UnprocessableEntityException({
        reason: 'selection-too-large',
      });
    const ids = rows
      .filter(
        (row) =>
          !row['removed_at'] && plainDeviceId.test(String(row['device_id'])),
      )
      .map((row) => String(row['device_id']));
    if (ids.length === 0)
      throw new UnprocessableEntityException({ reason: 'nothing-selected' });
    const jobId = await this.refresh.request(
      [session.identity.id, session.identity.permissionVersion],
      customerId,
      ids,
      correlationId,
    );
    return { jobId, selected: ids.length };
  }
}
