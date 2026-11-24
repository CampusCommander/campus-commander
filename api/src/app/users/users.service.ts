import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  freshnessCutoff,
  userAttributeCategoriesSchema,
  userCustomSchemasSchema,
  userFreshnessSchema,
  userOrgUnitsSchema,
  userPageSchema,
  userSyncStateSchema,
  type SessionResponse,
  type UserAttributeCategories,
  type UserAttributeCategoryJobReceipt,
  type UserAttributeCategoryPlan,
  type UserAttributeCategoryPlanConfirmRequest,
  type UserAttributeCategoryPlanRequest,
  type UserAttributeDisposition,
  type UserAttributeEditPreviewRequest,
  type UserAttributeJobReceipt,
  type UserAttributePreview,
  type UserAttributePreviewConfirmRequest,
  type UserAttributePreviewRequest,
  type UserAttributeTargetsPage,
  type UserDetail,
  type UserFreshness,
  type UserOrgUnit,
  type UserPage,
  type UserPredicate,
  type UserQuery,
  type UserRow,
  type UserSelectionKey,
  type UserSelectionOp,
  type UserSelectionSpec,
  type UserSyncState,
} from '@campus/application-contracts';
import { GoogleUserReader } from '@campus/google-connection';
import { AuthService } from '../auth/auth.service';
import { GoogleConnectionService } from '../auth/google-connection.service';
import { CacheService } from '../cache/cache.service';
import { DatabaseService } from '../database/database.service';
import { OrchestrationService } from '../orchestration/orchestration.service';
import { UserAttributeCategoriesRoute } from './user-attribute-categories';
import {
  UserAttributePreviews,
  USER_ATTRIBUTE_PREVIEW_USERS_LIMIT,
  userAttributePreviewBaseSchema,
  type UserAttributePreviewBase,
} from './user-attribute-previews';
import {
  UserCategoryPlans,
  userCategoryPlanBaseSchema,
  type UserCategoryPlanBase,
} from './user-category-plans';
import { UserDomainRefresh } from './user-domain-refresh';
import { UserPager, type Rows } from './user-pager';
import {
  matchingAmongSql,
  selectedAmongSql,
  selectionCountSql,
  selectionTargetsSql,
  staleCountSql,
  userDetail,
  userDetailSql,
  userOrgUnitsSql,
  refreshingSql,
} from './user-query';
import { UserRefresh } from './user-refresh';
import {
  UserSelectionBusyError,
  UserSelectionTooLargeError,
  applyUserSelectionOps,
  changeUserSelection,
  emptyUserSelection,
  parseUserSelection,
  userSelectionSpec,
  userSelectionStorageKey,
  type ParsedUserSelection,
  type UserSelectionState,
} from './user-selection';
import { UserSelectionRefresh } from './user-selection-refresh';
import type { UserSelectionRefreshAnswer } from './user-selection-refresh';

const conflicts = [
  'user-sync-running',
  'connection-changed',
  'credential-changed',
  'user-sync-changed',
  'entity-sync-changed',
];

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const parsed = z
    .object({ code: z.string(), detail: z.string().optional() })
    .safeParse(error);
  if (parsed.success && parsed.data.code === '42501')
    throw new ForbiddenException({ reason: 'forbidden' });
  if (
    parsed.success &&
    parsed.data.code === 'P0001' &&
    conflicts.includes(parsed.data.detail ?? '')
  )
    throw new ConflictException({ reason: parsed.data.detail });
  throw new ServiceUnavailableException({ reason: 'user-store-unavailable' });
}

/** Run statements on one transaction's client. */
const rowsOf =
  (client: PoolClient): Rows =>
  async (statement) =>
    (await client.query(statement.text, statement.values)).rows;

/** One stored timestamp, as the preview contract reads it. */
const previewMeasuredAt = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString()
    : typeof value === 'string'
      ? value
      : null;

@Injectable()
export class UsersService {
  private readonly reader = new GoogleUserReader();
  private readonly refresh: UserRefresh;
  private readonly selectionRefresh: UserSelectionRefresh;
  private readonly categoriesRoute: UserAttributeCategoriesRoute;
  private readonly categoryPlans: UserCategoryPlans;
  private readonly previews: UserAttributePreviews;
  readonly pager: UserPager;
  readonly domainRefresh: UserDomainRefresh;

  constructor(
    private readonly database: DatabaseService,
    private readonly orchestration: OrchestrationService,
    private readonly cache: CacheService,
    private readonly auth: AuthService,
    private readonly connection: GoogleConnectionService,
  ) {
    this.refresh = new UserRefresh(cache, orchestration, (sql, values) =>
      this.result(sql, values),
    );
    this.selectionRefresh = new UserSelectionRefresh(
      database,
      cache,
      this.refresh,
    );
    this.pager = new UserPager(cache);
    this.categoriesRoute = new UserAttributeCategoriesRoute({
      connection: (session) =>
        this.read(
          session,
          async (_client, customerId, generation) => ({
            customerId,
            generation,
          }),
          null,
        ),
      cached: (session) => this.categories(session),
      credential: (session, customerId, generation) =>
        this.connection.userReadCredential(session, customerId, generation),
      read: (credential, customerId, signal) =>
        this.reader.categories(credential, customerId, signal),
      store: (session, customerId, categories, readAt) =>
        this.storeCategories(session, customerId, categories, readAt),
    });
    this.domainRefresh = new UserDomainRefresh({
      authorize: (session, customerId, correlationId) =>
        this.auth.authorize(
          session,
          'connection:diagnose',
          { kind: 'district', customerId },
          correlationId,
        ),
      requestSync: (session, current, correlationId) =>
        this.requestSync(session, current, correlationId),
      checkHealth: (
        session,
        customerId,
        generation,
        capabilities,
        correlationId,
      ) =>
        this.connection.checkHealth(
          session,
          { customerId, generation, capabilities },
          correlationId,
        ),
    });
    this.categoryPlans = new UserCategoryPlans({
      base: (session) => this.categoryPlanBase(session),
      authorize: (session, customerId, correlationId) =>
        this.auth.authorize(
          session,
          'users:schema-manage',
          { kind: 'district', customerId },
          correlationId,
        ),
      create: (session, plan) =>
        this.result(
          `SELECT cc.create_user_category_plan($1::uuid,$2::integer,$3::text,$4::integer,
            $5::text,$6::text,$7::text,$8::text,$9::text,$10::jsonb,$11::jsonb,$12::text,
            $13::text,$14::integer) AS result`,
          [
            session.identity.id,
            session.identity.permissionVersion,
            plan.customerId,
            plan.generation,
            plan.kind,
            plan.schemaId,
            plan.baseEtag,
            plan.schemaName,
            plan.displayName,
            plan.body === null ? null : JSON.stringify(plan.body),
            JSON.stringify(plan.changes),
            plan.phrase,
            plan.digest,
            plan.expiresMinutes,
          ],
        ),
      read: (session, planId) =>
        this.result(
          'SELECT cc.read_user_category_plan($1::uuid,$2::integer,$3::uuid) AS result',
          [session.identity.id, session.identity.permissionVersion, planId],
        ),
      confirm: (session, planId, digest, phrase, correlationId) =>
        this.result(
          `SELECT cc.confirm_user_category_plan($1::uuid,$2::integer,$3::uuid,$4::text,
            $5::text,$6::uuid) AS result`,
          [
            session.identity.id,
            session.identity.permissionVersion,
            planId,
            digest,
            phrase,
            correlationId,
          ],
        ),
    });
    this.previews = new UserAttributePreviews({
      base: (session) => this.previewBase(session),
      authorize: (session, customerId, bulk, correlationId) =>
        this.authorizePreview(session, customerId, bulk, correlationId),
      selection: (session, key) => this.parsedSelection(session, key),
      selectionUsers: (session, state) =>
        this.previewSelectionUsers(session, state),
      usersByIds: (session, userIds) =>
        this.previewUsersByIds(session, userIds),
      credential: (session, customerId, generation) =>
        this.connection.userValueCredential(session, customerId, generation),
      userValues: (credential, _customerId, userId, customFieldMask, signal) =>
        this.reader.userValues(credential, userId, customFieldMask, signal),
      create: (session, preview) =>
        this.result(
          `SELECT cc.create_user_attribute_preview($1::uuid,$2::integer,$3::text,
            $4::integer,$5::text,$6::jsonb,$7::jsonb,$8::text,$9::jsonb,$10::jsonb,
            $11::integer) AS result`,
          [
            session.identity.id,
            session.identity.permissionVersion,
            preview.customerId,
            preview.generation,
            preview.source,
            preview.selection === null
              ? null
              : JSON.stringify(preview.selection),
            JSON.stringify(preview.changes),
            preview.digest,
            JSON.stringify(
              preview.targets.map((target) => ({
                ordinal: target.ordinal,
                userId: target.userId,
                primaryEmail: target.primaryEmail,
                observedAt: target.observedAt,
                disposition: target.disposition,
                rows: target.rows.map((row) => ({
                  schemaName: row.schemaName,
                  fieldName: row.fieldName,
                  currentValue: row.currentValue,
                  newValue: row.newValue,
                  disposition: row.disposition,
                })),
              })),
            ),
            JSON.stringify(preview.etags),
            preview.expiresMinutes,
          ],
        ),
      read: (session, previewId) =>
        this.result(
          'SELECT cc.read_user_attribute_preview($1::uuid,$2::integer,$3::uuid) AS result',
          [...this.actor(session), previewId],
        ),
      targets: (session, previewId, disposition, cursor, limit) =>
        this.result(
          `SELECT cc.read_user_attribute_preview_targets($1::uuid,$2::integer,
            $3::uuid,$4::text,$5::integer,$6::text,$7::text,$8::integer) AS result`,
          [
            ...this.actor(session),
            previewId,
            disposition,
            cursor?.ordinal ?? null,
            cursor?.schemaName ?? null,
            cursor?.fieldName ?? null,
            limit,
          ],
        ),
      confirm: (session, previewId, digest, correlationId) =>
        this.result(
          `SELECT cc.confirm_user_attribute_preview($1::uuid,$2::integer,$3::uuid,
            $4::text,$5::uuid) AS result`,
          [...this.actor(session), previewId, digest, correlationId],
        ),
    });
  }

  private actor(session: SessionResponse): [string, number] {
    return [session.identity.id, session.identity.permissionVersion];
  }

  private async result(sql: string, values: unknown[]) {
    try {
      return (await this.database.connection.query(sql, values)).rows[0]?.[
        'result'
      ];
    } catch (error) {
      translate(error);
    }
  }

  /** Require `users:write` and, for a selection preview, `users:bulk-actions` (B section 11). */
  private async authorizePreview(
    session: SessionResponse,
    customerId: string,
    bulk: boolean,
    correlationId: string,
  ): Promise<void> {
    await this.auth.authorize(
      session,
      'users:write',
      { kind: 'district', customerId },
      correlationId,
    );
    if (bulk)
      await this.auth.authorize(
        session,
        'users:bulk-actions',
        { kind: 'district', customerId },
        correlationId,
      );
  }

  /** The cached set under the write gate, with the customer and generation of a preview. */
  private async previewBase(
    session: SessionResponse,
  ): Promise<UserAttributePreviewBase | null> {
    return userAttributePreviewBaseSchema
      .nullable()
      .parse(
        await this.result(
          'SELECT cc.read_user_attribute_preview_base($1,$2) AS result',
          this.actor(session),
        ),
      );
  }

  /** Run one read under the write gate. The gate names the customer of the read. */
  private async writeGate<T>(
    session: SessionResponse,
    run: (
      client: PoolClient,
      customerId: string,
      generation: number,
    ) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.transaction(async (client) => {
        const writer = (
          await client.query(
            'SELECT w.customer_id,w.generation FROM cc.user_attribute_writer($1,$2) w',
            this.actor(session),
          )
        ).rows[0];
        const customerId = writer?.['customer_id'];
        if (typeof customerId !== 'string')
          throw new ConflictException({ reason: 'connection-required' });
        return run(client, customerId, Number(writer['generation']));
      });
    } catch (error) {
      translate(error);
    }
  }

  /** The selected users with the cached values that a selection preview freezes. */
  private async previewSelectionUsers(
    session: SessionResponse,
    state: UserSelectionState,
  ): Promise<{
    customerId: string;
    generation: number;
    users: {
      userId: string;
      primaryEmail: string;
      customSchemas: z.infer<typeof userCustomSchemasSchema>;
      observedAt: string | null;
    }[];
  }> {
    return this.writeGate(session, async (client, customerId, generation) => {
      // One extra row tells the route that the selection exceeds the 100,000-user bound (E17).
      const sql = selectionTargetsSql(
        customerId,
        state,
        USER_ATTRIBUTE_PREVIEW_USERS_LIMIT + 1,
      );
      const rows = (await client.query(sql.text, sql.values)).rows;
      return {
        customerId,
        generation,
        users: rows.map((row) => ({
          userId: String(row['user_id']),
          primaryEmail: String(row['primary_email']),
          customSchemas: userCustomSchemasSchema.parse(
            row['custom_schemas'] ?? {},
          ),
          observedAt: previewMeasuredAt(row['last_entity_sync']),
        })),
      };
    });
  }

  /** The cached email of each named user, under the write gate. Unknown IDs are left out. */
  private async previewUsersByIds(
    session: SessionResponse,
    userIds: readonly string[],
  ): Promise<{ userId: string; primaryEmail: string }[]> {
    return this.writeGate(session, async (client, customerId) => {
      const rows = (
        await client.query(
          `SELECT user_id,primary_email FROM cc.users
            WHERE customer_id=$1 AND user_id=ANY($2::text[]) ORDER BY user_id`,
          [customerId, userIds],
        )
      ).rows;
      return rows.map((row) => ({
        userId: String(row['user_id']),
        primaryEmail: String(row['primary_email']),
      }));
    });
  }

  async sync(session: SessionResponse): Promise<UserSyncState | null> {
    return userSyncStateSchema
      .nullable()
      .parse(
        await this.result('SELECT cc.read_user_sync($1,$2) AS result', [
          ...this.actor(session),
        ]),
      );
  }

  /**
   * Refresh Users: start one full user sync. The answer reads the state again, so a failure of
   * another person stays hidden, as the device route answers it.
   */
  async requestSync(
    session: SessionResponse,
    current: UserSyncState,
    correlationId: string,
  ): Promise<UserSyncState> {
    const syncId = randomUUID();
    await this.result(
      'SELECT cc.request_user_sync($1,$2,$3,$4,$5,$6) AS result',
      [
        ...this.actor(session),
        current.customerId,
        current.generation,
        syncId,
        correlationId,
      ],
    );
    try {
      await this.orchestration.startUserSync({
        customerId: current.customerId,
        syncId,
        correlationId,
      });
    } catch {
      await this.result(
        'SELECT cc.abandon_user_sync($1,$2,$3,$4,$5) AS result',
        [
          ...this.actor(session),
          current.customerId,
          syncId,
          'orchestration-unavailable',
        ],
      );
      throw new ServiceUnavailableException({
        reason: 'orchestration-unavailable',
      });
    }
    const started = await this.sync(session);
    if (!started)
      throw new ServiceUnavailableException({
        reason: 'user-store-unavailable',
      });
    return started;
  }

  /** Re-read the selected users from Google. Removed users stay out of the job. */
  async refreshSelection(
    session: SessionResponse,
    customerId: string,
    key: UserSelectionKey,
    correlationId: string,
  ): Promise<UserSelectionRefreshAnswer> {
    return this.selectionRefresh.request(
      session,
      customerId,
      key,
      correlationId,
    );
  }

  /** Check authority and read in one transaction. The check takes no locks. */
  private async read<T>(
    session: SessionResponse,
    run: (
      client: PoolClient,
      customerId: string,
      connectionGeneration: number,
    ) => Promise<T>,
    empty: T,
  ): Promise<T> {
    try {
      return await this.database.transaction(async (client) => {
        const reader = (
          await client.query(
            'SELECT r.customer_id,r.generation FROM cc.user_reader($1,$2) r',
            this.actor(session),
          )
        ).rows[0];
        const customerId = reader?.['customer_id'];
        return typeof customerId === 'string'
          ? run(client, customerId, Number(reader['generation']))
          : empty;
      });
    } catch (error) {
      translate(error);
    }
  }

  /** The district total and observation time of the published inventory. */
  private async inventory(client: PoolClient, customerId: string) {
    const state = (
      await client.query(
        'SELECT user_count,observed_at FROM cc.user_sync_state WHERE customer_id=$1',
        [customerId],
      )
    ).rows[0];
    return {
      total: state?.['user_count'] ?? 0,
      observedAt:
        state?.['observed_at'] instanceof Date
          ? state['observed_at'].toISOString()
          : null,
    };
  }

  async page(
    session: SessionResponse,
    query: UserQuery,
    correlationId: string,
  ): Promise<UserPage> {
    const read = await this.read(
      session,
      async (client, customerId, connectionGeneration) => {
        const inventory = await this.inventory(client, customerId);
        const selection = query.selection
          ? await this.storedSelection(session, query.selection)
          : null;
        const page = await this.pager.page({
          customerId,
          connectionGeneration,
          actor: this.actor(session),
          query,
          selection,
          rows: rowsOf(client),
        });
        return { customerId, inventory, page };
      },
      null,
    );
    if (!read)
      return {
        rows: [],
        matching: 0,
        total: 0,
        observedAt: null,
        refreshJobId: null,
      };
    // The flow starts after the read transaction closes, so the page never waits on Kestra inside Postgres.
    const refreshJobId = await this.refresh.dispatch(
      this.actor(session),
      read.customerId,
      read.page.stale,
      correlationId,
    );
    return userPageSchema.parse({
      rows: read.page.rows,
      matching: read.page.matching,
      ...read.inventory,
      refreshJobId,
    });
  }

  async orgUnits(session: SessionResponse): Promise<UserOrgUnit[]> {
    return this.read(
      session,
      async (client, customerId) => {
        const sql = userOrgUnitsSql(customerId);
        const rows = (await client.query(sql.text, sql.values)).rows;
        return userOrgUnitsSchema.parse(
          rows.map((row) => ({
            path: row['org_unit_path'],
            users: row['users'],
          })),
        );
      },
      [],
    );
  }

  async user(session: SessionResponse, userId: string): Promise<UserDetail> {
    const found = await this.read(
      session,
      async (client, customerId) => {
        const sql = userDetailSql(customerId, userId);
        const row = (await client.query(sql.text, sql.values)).rows[0];
        return row ? userDetail(row, freshnessCutoff('user').getTime()) : null;
      },
      null,
    );
    if (!found) throw new NotFoundException({ reason: 'user-not-found' });
    return found;
  }

  /** Rows for user IDs, Redis first and Postgres for misses (D7). Unknown IDs are left out. */
  async rowsById(
    session: SessionResponse,
    userIds: readonly string[],
  ): Promise<UserRow[]> {
    return this.read(
      session,
      async (client, customerId) =>
        (await this.pager.hydrate(customerId, userIds, rowsOf(client))).rows,
      [],
    );
  }

  /** Stale users in a result set, and whether a refresh job runs (D11). */
  async freshness(
    session: SessionResponse,
    query: UserQuery,
  ): Promise<UserFreshness> {
    return this.read(
      session,
      async (client, customerId) => {
        const selection = query.selection
          ? await this.storedSelection(session, query.selection)
          : null;
        const [counted] = await rowsOf(client)(
          staleCountSql(customerId, query, selection, freshnessCutoff('user')),
        );
        const [running] = await rowsOf(client)(refreshingSql(customerId));
        return userFreshnessSchema.parse({
          stale: counted?.['stale'] ?? 0,
          refreshing: running?.['refreshing'] === true,
        });
      },
      { stale: 0, refreshing: false },
    );
  }

  private async parsedSelection(
    session: SessionResponse,
    key: UserSelectionKey,
  ): Promise<ParsedUserSelection> {
    return parseUserSelection(
      await this.cache.get(userSelectionStorageKey(session.identity.id, key)),
    );
  }

  private async storedSelection(
    session: SessionResponse,
    key: UserSelectionKey,
  ): Promise<UserSelectionState> {
    return (await this.parsedSelection(session, key)).state;
  }

  private async selectedCount(
    client: PoolClient,
    customerId: string,
    state: UserSelectionState,
  ): Promise<number> {
    const sql = selectionCountSql(customerId, state);
    return (
      (await client.query(sql.text, sql.values)).rows[0]?.['selected'] ?? 0
    );
  }

  private async userIds(
    client: PoolClient,
    sql: { text: string; values: unknown[] },
  ) {
    return (await client.query(sql.text, sql.values)).rows.map((row) =>
      String(row['user_id']),
    );
  }

  async selection(
    session: SessionResponse,
    key: UserSelectionKey,
  ): Promise<UserSelectionSpec> {
    return this.read(
      session,
      async (client, customerId) => {
        const { state, expiredAt } = await this.parsedSelection(session, key);
        return userSelectionSpec(
          state,
          await this.selectedCount(client, customerId, state),
          expiredAt,
        );
      },
      userSelectionSpec(emptyUserSelection(), 0, null),
    );
  }

  async changeSelection(
    session: SessionResponse,
    key: UserSelectionKey,
    ops: UserSelectionOp[],
  ): Promise<UserSelectionSpec> {
    return this.read(
      session,
      async (client, customerId) => {
        const matching = (predicates: UserPredicate[], ids: string[]) =>
          this.userIds(client, matchingAmongSql(customerId, predicates, ids));
        let state: UserSelectionState;
        try {
          state = await changeUserSelection(
            this.cache,
            userSelectionStorageKey(session.identity.id, key),
            (current) => applyUserSelectionOps(current, ops, matching),
          );
        } catch (error) {
          if (error instanceof UserSelectionTooLargeError)
            throw new ConflictException({ reason: 'selection-too-large' });
          if (error instanceof UserSelectionBusyError)
            throw new ConflictException({ reason: 'selection-busy' });
          throw error;
        }
        return userSelectionSpec(
          state,
          await this.selectedCount(client, customerId, state),
        );
      },
      userSelectionSpec(emptyUserSelection(), 0),
    );
  }

  /** Rows resolve by user ID. */
  async resolveSelection(
    session: SessionResponse,
    key: UserSelectionKey,
    rowIds: string[],
  ): Promise<Record<string, boolean>> {
    return this.read(
      session,
      async (client, customerId) => {
        const state = await this.storedSelection(session, key);
        const chosen = new Set(
          await this.userIds(
            client,
            selectedAmongSql(customerId, state, rowIds),
          ),
        );
        return Object.fromEntries(rowIds.map((id) => [id, chosen.has(id)]));
      },
      {},
    );
  }

  /** The cached category read of B section 10 row 1. Null means no connection. */
  async categories(
    session: SessionResponse,
  ): Promise<UserAttributeCategories | null> {
    return userAttributeCategoriesSchema
      .nullable()
      .parse(
        await this.result(
          'SELECT cc.read_user_attribute_categories($1,$2) AS result',
          this.actor(session),
        ),
      );
  }

  private async storeCategories(
    session: SessionResponse,
    customerId: string,
    categories: unknown,
    readAt: string,
  ): Promise<UserAttributeCategories> {
    return userAttributeCategoriesSchema.parse(
      await this.result(
        'SELECT cc.replace_user_attribute_categories($1,$2,$3,$4,$5) AS result',
        [
          ...this.actor(session),
          customerId,
          JSON.stringify(categories),
          readAt,
        ],
      ),
    );
  }

  /** The tab read of the Custom attributes tab, by the cache rules of B section 9. */
  async attributeCategories(
    session: SessionResponse,
  ): Promise<UserAttributeCategories> {
    return this.categoriesRoute.read(session);
  }

  /** The cached set under the schema-manage gate, with the customer and generation of a plan. */
  private async categoryPlanBase(
    session: SessionResponse,
  ): Promise<UserCategoryPlanBase | null> {
    return userCategoryPlanBaseSchema
      .nullable()
      .parse(
        await this.result(
          'SELECT cc.read_user_category_plan_base($1,$2) AS result',
          this.actor(session),
        ),
      );
  }

  /** Read schemas.list now and replace the cached set (B section 9). */
  async refreshAttributeCategories(
    session: SessionResponse,
  ): Promise<UserAttributeCategories> {
    return this.categoriesRoute.refresh(session);
  }

  /** The plan route of B section 10. It accepts `numericIndexingSpec` in every draft field. */
  async createUserCategoryPlan(
    session: SessionResponse,
    request: UserAttributeCategoryPlanRequest,
    correlationId: string,
  ): Promise<UserAttributeCategoryPlan> {
    return this.categoryPlans.plan(session, request, correlationId);
  }

  /** One category plan, to its creator only. */
  async userCategoryPlan(
    session: SessionResponse,
    planId: string,
    correlationId: string,
  ): Promise<UserAttributeCategoryPlan> {
    return this.categoryPlans.byId(session, planId, correlationId);
  }

  /** Confirm one plan: one `user-schema-change` job or the receipt of the first confirm. */
  async confirmUserCategoryPlan(
    session: SessionResponse,
    planId: string,
    input: UserAttributeCategoryPlanConfirmRequest,
    correlationId: string,
  ): Promise<{
    receipt: UserAttributeCategoryJobReceipt;
    existing: boolean;
  }> {
    return this.categoryPlans.confirm(session, planId, input, correlationId);
  }

  /** Freeze one value preview from a selection key with changes or from an edit list. */
  async createUserAttributePreview(
    session: SessionResponse,
    request: UserAttributePreviewRequest | UserAttributeEditPreviewRequest,
    correlationId: string,
  ): Promise<UserAttributePreview> {
    return this.previews.preview(session, request, correlationId);
  }

  /** One value preview, to its creator only. */
  async userAttributePreview(
    session: SessionResponse,
    previewId: string,
    correlationId: string,
  ): Promise<UserAttributePreview> {
    return this.previews.byId(session, previewId, correlationId);
  }

  /** One page of the frozen rows of a value preview, to its creator only. */
  async userAttributePreviewTargets(
    session: SessionResponse,
    previewId: string,
    disposition: UserAttributeDisposition | null,
    cursor: { ordinal: number; schemaName: string; fieldName: string } | null,
    limit: number,
    correlationId: string,
  ): Promise<UserAttributeTargetsPage> {
    return this.previews.targets(
      session,
      previewId,
      disposition,
      cursor,
      limit,
      correlationId,
    );
  }

  /** Confirm one value preview: one `user-attribute-update` job or the first receipt. */
  async confirmUserAttributePreview(
    session: SessionResponse,
    previewId: string,
    input: UserAttributePreviewConfirmRequest,
    correlationId: string,
  ): Promise<{ receipt: UserAttributeJobReceipt; existing: boolean }> {
    return this.previews.confirm(session, previewId, input, correlationId);
  }
}
