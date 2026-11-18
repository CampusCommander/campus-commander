import {
  ConflictException,
  HttpException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  SessionResponse,
  UserSelectionKey,
} from '@campus/application-contracts';
import { selectionIdsSql } from './user-query';
import {
  hasUserSelection,
  parseUserSelection,
  userSelectionStorageKey,
  type UserSelectionState,
} from './user-selection';

/** The preview and cc.create_entity_sync_job both bound one selection at 100,000 users. */
export const MAX_REFRESH_USERS = 100_000;
/** User IDs travel into Google request paths. Only plain identifiers enter a job. */
const plainUserId = /^[A-Za-z0-9_-]{1,128}$/;

interface QueryResult {
  rows: Record<string, unknown>[];
}
interface QueryClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}
export interface UserSelectionRefreshDatabase {
  transaction<T>(run: (client: QueryClient) => Promise<T>): Promise<T>;
}
export interface UserSelectionRefreshCache {
  get(key: string): Promise<string | null>;
}
export interface UserSelectionRefreshDispatch {
  request(
    actor: readonly [string, number],
    customerId: string,
    ids: readonly string[],
    correlationId: string,
  ): Promise<string | null>;
}

export interface UserSelectionRefreshAnswer {
  jobId: string | null;
  selected: number;
}

/** A new job answers 201. A selection whose users are all claimed answers 200. */
export function userSelectionRefreshStatus(
  answer: UserSelectionRefreshAnswer,
): 200 | 201 {
  return answer.jobId === null ? 200 : 201;
}

/**
 * Refresh Selected: resolve the stored selection to user IDs, then start one refresh job.
 * Removed users and non-plain IDs stay out of the job, the same rule the preview applies.
 */
export class UserSelectionRefresh {
  private readonly database: UserSelectionRefreshDatabase;
  private readonly cache: UserSelectionRefreshCache;
  private readonly refresh: UserSelectionRefreshDispatch;

  constructor(
    database: UserSelectionRefreshDatabase,
    cache: UserSelectionRefreshCache,
    refresh: UserSelectionRefreshDispatch,
  ) {
    this.database = database;
    this.cache = cache;
    this.refresh = refresh;
  }

  private async stored(session: SessionResponse, key: UserSelectionKey) {
    try {
      return await this.cache.get(
        userSelectionStorageKey(session.identity.id, key),
      );
    } catch {
      throw new ServiceUnavailableException({
        reason: 'user-store-unavailable',
      });
    }
  }

  private async selectedRows(customerId: string, state: UserSelectionState) {
    const sql = selectionIdsSql(customerId, state);
    try {
      return await this.database.transaction(
        async (client) => (await client.query(sql.text, sql.values)).rows,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({
        reason: 'user-store-unavailable',
      });
    }
  }

  async request(
    session: SessionResponse,
    customerId: string,
    key: UserSelectionKey,
    correlationId: string,
  ): Promise<UserSelectionRefreshAnswer> {
    const { state, expiredAt } = parseUserSelection(
      await this.stored(session, key),
    );
    if (expiredAt)
      throw new ConflictException({ reason: 'selection-expired', expiredAt });
    if (!hasUserSelection(state))
      throw new UnprocessableEntityException({ reason: 'nothing-selected' });
    const rows = await this.selectedRows(customerId, state);
    if (rows.length > MAX_REFRESH_USERS)
      throw new UnprocessableEntityException({
        reason: 'selection-too-large',
      });
    const ids = rows
      .filter(
        (row) => !row['removed_at'] && plainUserId.test(String(row['user_id'])),
      )
      .map((row) => String(row['user_id']));
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
