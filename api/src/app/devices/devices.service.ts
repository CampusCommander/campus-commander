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
  devicePageSchema,
  deviceSyncStateSchema,
  type DeviceDetail,
  type DevicePage,
  type DeviceQuery,
  type DeviceSyncState,
  type SessionResponse,
} from '@campus/application-contracts';
import { DatabaseService } from '../database/database.service';
import { OrchestrationService } from '../orchestration/orchestration.service';
import {
  deviceDetail,
  deviceDetailSql,
  devicePageSql,
  deviceRow,
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
        const sql = devicePageSql(customerId, query);
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
}
