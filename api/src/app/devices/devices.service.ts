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
  deviceOrgUnitsSchema,
  devicePageSchema,
  deviceSyncStateSchema,
  type DeviceDetail,
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
  devicePageSql,
  deviceRow,
  deviceOrgUnitsSql,
  matchingAmongSql,
  selectedAmongSql,
  selectionCountSql,
} from './device-query';

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
  constructor(
    private readonly database: DatabaseService,
    private readonly orchestration: OrchestrationService,
    private readonly cache: CacheService,
  ) {}

  private actor(session: SessionResponse) {
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

  async page(
    session: SessionResponse,
    query: DeviceQuery,
  ): Promise<DevicePage> {
    return this.read(
      session,
      async (client, customerId) => {
        const state = (
          await client.query(
            'SELECT device_count,observed_at FROM cc.device_sync_state WHERE customer_id=$1',
            [customerId],
          )
        ).rows[0];
        const selection = query.selection
          ? await this.storedSelection(session, query.selection)
          : null;
        const sql = devicePageSql(customerId, query, selection);
        const matching = (await client.query(sql.count.text, sql.count.values))
          .rows[0]?.['matching'];
        const rows = (await client.query(sql.rows.text, sql.rows.values)).rows;
        return devicePageSchema.parse({
          rows: rows.map(deviceRow),
          matching: matching ?? 0,
          total: state?.['device_count'] ?? 0,
          observedAt:
            state?.['observed_at'] instanceof Date
              ? state['observed_at'].toISOString()
              : null,
        });
      },
      { rows: [], matching: 0, total: 0, observedAt: null },
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
        return row ? deviceDetail(row) : null;
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
        const matching = (predicates: DevicePredicate[], ids: string[]) =>
          this.deviceIds(client, matchingAmongSql(customerId, predicates, ids));
        let state: SelectionState;
        try {
          state = await changeSelection(
            this.cache,
            selectionStorageKey(session.identity.id, key),
            (current) => applySelectionOps(current, ops, matching),
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

  /** Grouped rows wait for server-side grouping. Their routes resolve as unselected. */
  async resolveSelection(
    session: SessionResponse,
    key: DeviceSelectionKey,
    rowIds: string[],
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
        return Object.fromEntries(rowIds.map((id) => [id, chosen.has(id)]));
      },
      {},
    );
  }
}
