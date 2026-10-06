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
  deviceGroupPageSchema,
  freshnessCutoff,
  deviceOrgUnitsSchema,
  devicePageSchema,
  deviceSyncStateSchema,
  type DeviceDetail,
  type DeviceGroupField,
  type DeviceGroupPage,
  type DeviceGrouping,
  type DeviceOrgUnit,
  type DevicePage,
  type DevicePredicate,
  type DeviceQuery,
  type DeviceSelectionKey,
  type DeviceSelectionOp,
  type DeviceSelectionSpec,
  type DeviceSyncState,
  type SessionResponse,
} from '@campus/application-contracts';
import { CacheService } from '../cache/cache.service';
import {
  SelectionBusyError,
  SelectionTooLargeError,
  applySelectionOps,
  changeSelection,
  emptySelection,
  parseSelection,
  selectionSpec,
  selectionStorageKey,
  type SelectionState,
} from './device-selection';
import { DatabaseService } from '../database/database.service';
import { OrchestrationService } from '../orchestration/orchestration.service';
import {
  deviceDetail,
  deviceDetailSql,
  deviceGroupsSql,
  devicePageSql,
  groupSelectionSql,
  deviceRow,
  deviceOrgUnitsSql,
  matchingAmongSql,
  selectedAmongSql,
  selectedInSql,
  selectionCountSql,
  staleIdsSql,
} from './device-query';
import { DeviceRefresh } from './device-refresh';

const conflicts = ['device-sync-running', 'connection-changed'];

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
  throw new ServiceUnavailableException({ reason: 'device-store-unavailable' });
}

@Injectable()
export class DevicesService {
  private readonly refresh: DeviceRefresh;

  constructor(
    private readonly database: DatabaseService,
    private readonly orchestration: OrchestrationService,
    private readonly cache: CacheService,
  ) {
    this.refresh = new DeviceRefresh(cache, orchestration, (sql, values) =>
      this.result(sql, values),
    );
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

  async sync(session: SessionResponse): Promise<DeviceSyncState | null> {
    return deviceSyncStateSchema
      .nullable()
      .parse(
        await this.result(
          'SELECT cc.read_device_sync($1,$2) AS result',
          this.actor(session),
        ),
      );
  }

  async requestSync(
    session: SessionResponse,
    current: DeviceSyncState,
    correlationId: string,
  ): Promise<DeviceSyncState> {
    const syncId = randomUUID();
    const started = deviceSyncStateSchema.parse(
      await this.result(
        'SELECT cc.request_device_sync($1,$2,$3,$4,$5,$6) AS result',
        [
          ...this.actor(session),
          current.customerId,
          current.generation,
          syncId,
          correlationId,
        ],
      ),
    );
    try {
      await this.orchestration.startDeviceSync({
        customerId: current.customerId,
        syncId,
        correlationId,
      });
    } catch {
      await this.result(
        'SELECT cc.abandon_device_sync($1,$2,$3,$4,$5) AS result',
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
    return started;
  }

  /** Check authority and read in one transaction. The check takes no locks. */
  private async read<T>(
    session: SessionResponse,
    run: (client: PoolClient, customerId: string) => Promise<T>,
    empty: T,
  ): Promise<T> {
    try {
      return await this.database.transaction(async (client) => {
        const customerId = (
          await client.query(
            'SELECT (cc.device_reader($1,$2)).customer_id AS customer_id',
            this.actor(session),
          )
        ).rows[0]?.['customer_id'];
        return typeof customerId === 'string' ? run(client, customerId) : empty;
      });
    } catch (error) {
      translate(error);
    }
  }

  /** The district total and observation time of the published inventory. */
  private async inventory(client: PoolClient, customerId: string) {
    const state = (
      await client.query(
        'SELECT device_count,observed_at FROM cc.device_sync_state WHERE customer_id=$1',
        [customerId],
      )
    ).rows[0];
    return {
      total: state?.['device_count'] ?? 0,
      observedAt:
        state?.['observed_at'] instanceof Date
          ? state['observed_at'].toISOString()
          : null,
    };
  }

  async page(
    session: SessionResponse,
    query: DeviceQuery,
    correlationId: string,
  ): Promise<DevicePage> {
    const cutoff = freshnessCutoff('device');
    const read = await this.read(
      session,
      async (client, customerId) => {
        const inventory = await this.inventory(client, customerId);
        const selection = query.selection
          ? await this.storedSelection(session, query.selection)
          : null;
        const sql = devicePageSql(customerId, query, selection);
        const matching = (await client.query(sql.count.text, sql.count.values))
          .rows[0]?.['matching'];
        const rows = (await client.query(sql.rows.text, sql.rows.values)).rows;
        const stale = await this.deviceIds(
          client,
          staleIdsSql(customerId, query, selection, cutoff),
        );
        return {
          customerId,
          stale,
          page: {
            rows: rows.map((row) => deviceRow(row, cutoff.getTime())),
            matching: matching ?? 0,
            ...inventory,
          },
        };
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
      read.stale,
      correlationId,
    );
    return devicePageSchema.parse({ ...read.page, refreshJobId });
  }

  async groups(
    session: SessionResponse,
    query: DeviceQuery,
  ): Promise<DeviceGroupPage> {
    return this.read(
      session,
      async (client, customerId) => {
        const inventory = await this.inventory(client, customerId);
        const selection = query.selection
          ? await this.storedSelection(session, query.selection)
          : null;
        const sql = deviceGroupsSql(customerId, query, selection);
        const counts = (await client.query(sql.count.text, sql.count.values))
          .rows[0];
        const rows = (await client.query(sql.groups.text, sql.groups.values))
          .rows;
        return deviceGroupPageSchema.parse({
          groups: rows.map((row) => ({
            key: row['key'],
            devices: row['devices'],
          })),
          groupCount: counts?.['groups'] ?? 0,
          matching: counts?.['matching'] ?? 0,
          ...inventory,
        });
      },
      { groups: [], groupCount: 0, matching: 0, total: 0, observedAt: null },
    );
  }

  async orgUnits(session: SessionResponse): Promise<DeviceOrgUnit[]> {
    return this.read(
      session,
      async (client, customerId) => {
        const sql = deviceOrgUnitsSql(customerId);
        const rows = (await client.query(sql.text, sql.values)).rows;
        return deviceOrgUnitsSchema.parse(
          rows.map((row) => ({
            path: row['org_unit_path'],
            devices: row['devices'],
          })),
        );
      },
      [],
    );
  }

  async device(
    session: SessionResponse,
    deviceId: string,
  ): Promise<DeviceDetail> {
    const found = await this.read(
      session,
      async (client, customerId) => {
        const sql = deviceDetailSql(customerId, deviceId);
        const row = (await client.query(sql.text, sql.values)).rows[0];
        return row
          ? deviceDetail(row, freshnessCutoff('device').getTime())
          : null;
      },
      null,
    );
    if (!found) throw new NotFoundException({ reason: 'device-not-found' });
    return found;
  }

  private async storedSelection(
    session: SessionResponse,
    key: DeviceSelectionKey,
  ): Promise<SelectionState> {
    return parseSelection(
      await this.cache.get(selectionStorageKey(session.identity.id, key)),
    );
  }

  private async selectedCount(
    client: PoolClient,
    customerId: string,
    state: SelectionState,
  ): Promise<number> {
    const sql = selectionCountSql(customerId, state);
    return (
      (await client.query(sql.text, sql.values)).rows[0]?.['selected'] ?? 0
    );
  }

  private async deviceIds(
    client: PoolClient,
    sql: { text: string; values: unknown[] },
  ) {
    return (await client.query(sql.text, sql.values)).rows.map((row) =>
      String(row['device_id']),
    );
  }

  async selection(
    session: SessionResponse,
    key: DeviceSelectionKey,
  ): Promise<DeviceSelectionSpec> {
    return this.read(
      session,
      async (client, customerId) => {
        const state = await this.storedSelection(session, key);
        return selectionSpec(
          state,
          await this.selectedCount(client, customerId, state),
        );
      },
      selectionSpec(emptySelection(), 0),
    );
  }

  async changeSelection(
    session: SessionResponse,
    key: DeviceSelectionKey,
    ops: DeviceSelectionOp[],
  ): Promise<DeviceSelectionSpec> {
    return this.read(
      session,
      async (client, customerId) => {
        const matching = (
          predicates: DevicePredicate[],
          ids: string[],
          group?: DeviceGrouping,
        ) =>
          this.deviceIds(
            client,
            matchingAmongSql(customerId, predicates, ids, group ?? null),
          );
        const selectedIn = (
          state: SelectionState,
          predicates: DevicePredicate[],
          group: DeviceGrouping,
        ) =>
          this.deviceIds(
            client,
            selectedInSql(customerId, state, predicates, group),
          );
        let state: SelectionState;
        try {
          state = await changeSelection(
            this.cache,
            selectionStorageKey(session.identity.id, key),
            (current) => applySelectionOps(current, ops, matching, selectedIn),
          );
        } catch (error) {
          if (error instanceof SelectionTooLargeError)
            throw new ConflictException({ reason: 'selection-too-large' });
          if (error instanceof SelectionBusyError)
            throw new ConflictException({ reason: 'selection-busy' });
          throw error;
        }
        return selectionSpec(
          state,
          await this.selectedCount(client, customerId, state),
        );
      },
      selectionSpec(emptySelection(), 0),
    );
  }

  /** Rows resolve by device ID. Group rows resolve by their joined route under the grid's filters. */
  async resolveSelection(
    session: SessionResponse,
    key: DeviceSelectionKey,
    rowIds: string[],
    groupRoutes: string[],
    predicates: DevicePredicate[],
    by: DeviceGroupField[],
  ): Promise<Record<string, boolean>> {
    return this.read(
      session,
      async (client, customerId) => {
        const state = await this.storedSelection(session, key);
        const chosen = new Set(
          await this.deviceIds(
            client,
            selectedAmongSql(customerId, state, rowIds),
          ),
        );
        const selected: Record<string, boolean> = Object.fromEntries(
          rowIds.map((id) => [id, chosen.has(id)]),
        );
        for (const route of groupRoutes) selected[route] = false;
        if (groupRoutes.length)
          for (let depth = 1; depth <= by.length; depth++) {
            const sql = groupSelectionSql(
              customerId,
              state,
              predicates,
              by.slice(0, depth),
              groupRoutes,
            );
            for (const row of (await client.query(sql.text, sql.values)).rows)
              if (row['selected'] === true)
                selected[String(row['route'])] = true;
          }
        return selected;
      },
      {},
    );
  }
}
