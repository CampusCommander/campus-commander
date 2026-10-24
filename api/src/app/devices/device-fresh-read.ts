import {
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  DeviceObservation,
  GoogleFailure,
  SessionResponse,
} from '@campus/application-contracts';
import { failure, type DelegatedCredential } from '@campus/google-connection';
import {
  DEVICE_WRITE_ACCESS_DEADLINE_MILLISECONDS,
  WriteAccessDeadlineError,
  beforeDeadline,
  type DeviceWriteAccessContext,
} from './device-write-access';

/**
 * One deadline covers the Postgres stamp and the Google read (addendum section 4). It equals the
 * write-check deadline, so a save never waits longer than the access check of the same slice.
 */
export const DEVICE_FRESH_READ_DEADLINE_MILLISECONDS =
  DEVICE_WRITE_ACCESS_DEADLINE_MILLISECONDS;

/**
 * One Google batch carries at most 1,000 device reads. One edit list carries up to 2,500 edits, so
 * the route splits the list and keeps one deadline over every batch.
 */
export const DEVICE_FRESH_READ_BATCH_SIZE = 1000;

/** `cc.upsert_devices` and `cc.soft_delete_devices` both refuse more than 1,000 rows. */
const DEVICE_STORE_BATCH_SIZE = 1000;

interface QueryResult {
  rows: Record<string, unknown>[];
}
interface QueryClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

export interface FreshReadDatabase {
  connection: QueryClient;
  transaction<T>(run: (client: QueryClient) => Promise<T>): Promise<T>;
}

/** The credential and the Google read. The read carries no telemetry, so no battery call runs. */
export interface FreshReadPort {
  credential(
    session: SessionResponse,
    context: DeviceWriteAccessContext,
  ): Promise<DelegatedCredential | null>;
  read(
    credential: DelegatedCredential,
    customerId: string,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<{ devices: DeviceObservation[]; missing: string[] }>;
}

export interface FreshReadResult {
  /** The stored rows of the edited devices, in device ID order. */
  rows: Record<string, unknown>[];
  /** The read time that Postgres stamped before the Google call. */
  syncedAt: string;
}

/** The options of one read. Production uses the deadline of the card. */
export interface DeviceFreshReadOptions {
  /** The overall deadline of one read, from its inventory check. */
  deadlineMilliseconds?: number;
}

/** A failed Google read creates no preview. The answer carries the Google failure code. */
function readFailure(code: GoogleFailure) {
  return new ServiceUnavailableException({
    reason: 'device-read-failed',
    failure: code,
  });
}

function storeFailure() {
  return new ServiceUnavailableException({
    reason: 'device-store-unavailable',
  });
}

/**
 * The fresh Google read of the edit route (addendum section 4). It checks every device ID against
 * the inventory, stamps the read time before the Google call, reads each edited device once, stores
 * that read as a refresh read, and returns the rows that Postgres now holds. Telemetry stays out, so
 * the stored battery values stand.
 */
export class DeviceFreshRead {
  private readonly store: FreshReadDatabase;
  private readonly port: FreshReadPort;
  private readonly deadlineMilliseconds: number;

  constructor(
    store: FreshReadDatabase,
    port: FreshReadPort,
    options: DeviceFreshReadOptions = {},
  ) {
    this.store = store;
    this.port = port;
    this.deadlineMilliseconds =
      options.deadlineMilliseconds ?? DEVICE_FRESH_READ_DEADLINE_MILLISECONDS;
  }

  /** The device IDs that the inventory holds. An unknown ID never reaches Google. */
  private async inventory(
    customerId: string,
    ids: readonly string[],
  ): Promise<Set<string>> {
    try {
      const result = await this.store.connection.query(
        `SELECT device_id FROM cc.devices
          WHERE customer_id=$1 AND device_id=ANY($2::text[])`,
        [customerId, ids],
      );
      return new Set(result.rows.map((row) => String(row['device_id'])));
    } catch {
      throw storeFailure();
    }
  }

  /** Postgres stamps the read time, as the worker's batch does (worker/src/entity-sync.ts:181). */
  private async stamp(): Promise<string> {
    const result = await this.store.connection.query(
      'SELECT clock_timestamp() AS stamp',
    );
    const value = result.rows[0]?.['stamp'];
    const stamp = new Date(
      value instanceof Date || typeof value === 'string' ? value : Number.NaN,
    );
    if (Number.isNaN(stamp.getTime())) throw storeFailure();
    return stamp.toISOString();
  }

  private async storeRead(
    customerId: string,
    syncedAt: string,
    read: { devices: DeviceObservation[]; missing: string[] },
  ): Promise<void> {
    try {
      await this.store.transaction(async (client) => {
        // Both store functions bound one call at 1,000 rows, as the worker's page does.
        for (
          let start = 0;
          start < read.devices.length;
          start += DEVICE_STORE_BATCH_SIZE
        )
          await client.query(
            'SELECT cc.upsert_devices($1,$2,$3,$4) AS result',
            [
              customerId,
              JSON.stringify(
                read.devices.slice(start, start + DEVICE_STORE_BATCH_SIZE),
              ),
              syncedAt,
              'read',
            ],
          );
        for (
          let start = 0;
          start < read.missing.length;
          start += DEVICE_STORE_BATCH_SIZE
        )
          await client.query('SELECT cc.soft_delete_devices($1,$2) AS result', [
            customerId,
            JSON.stringify(
              read.missing.slice(start, start + DEVICE_STORE_BATCH_SIZE),
            ),
          ]);
      });
    } catch {
      throw storeFailure();
    }
  }

  /** The stored rows of the edited devices. Redis entries lose to them through the version check. */
  private async rows(
    customerId: string,
    ids: readonly string[],
  ): Promise<Record<string, unknown>[]> {
    try {
      return (
        await this.store.connection.query(
          `SELECT device_id,serial_number,org_unit_path,asset_tag,annotated_location,
            annotated_user,notes,removed_at,last_entity_sync
            FROM cc.devices WHERE customer_id=$1 AND device_id=ANY($2::text[])
            ORDER BY device_id`,
          [customerId, ids],
        )
      ).rows;
    } catch {
      throw storeFailure();
    }
  }

  async read(
    session: SessionResponse,
    context: DeviceWriteAccessContext,
    deviceIds: readonly string[],
  ): Promise<FreshReadResult> {
    const ids = [...new Set(deviceIds)];
    const known = await this.inventory(context.customerId, ids);
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length)
      throw new UnprocessableEntityException({
        reason: 'unknown-device',
        deviceIds: unknown,
      });
    // One deadline covers the stamp and the Google read (addendum section 4).
    const deadline = Date.now() + this.deadlineMilliseconds;
    let syncedAt: string;
    let read: { devices: DeviceObservation[]; missing: string[] };
    try {
      syncedAt = await beforeDeadline(this.stamp(), deadline);
      const credential = await beforeDeadline(
        this.port.credential(session, context),
        deadline,
      );
      if (!credential)
        throw new ConflictException({ reason: 'connection-required' });
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new WriteAccessDeadlineError();
      read = { devices: [], missing: [] };
      for (
        let start = 0;
        start < ids.length;
        start += DEVICE_FRESH_READ_BATCH_SIZE
      ) {
        // The signal covers the rest of the deadline, not just this batch.
        const left = deadline - Date.now();
        if (left <= 0) throw new WriteAccessDeadlineError();
        const batch = await this.port.read(
          credential,
          context.customerId,
          ids.slice(start, start + DEVICE_FRESH_READ_BATCH_SIZE),
          AbortSignal.timeout(left),
        );
        read.devices.push(...batch.devices);
        read.missing.push(...batch.missing);
      }
    } catch (error) {
      // A refused connection, a refused credential, and a store fault keep their own answer.
      // The credential adapter answers the SQL 42501 permission refusal with 403; a Google
      // failure must not hide that local refusal behind a retryable 503.
      if (
        error instanceof ConflictException ||
        error instanceof ForbiddenException ||
        error instanceof ServiceUnavailableException
      )
        throw error;
      if (error instanceof WriteAccessDeadlineError)
        throw readFailure('network-failure');
      throw readFailure(failure(error, 'read').code);
    }
    await this.storeRead(context.customerId, syncedAt, read);
    const rows = await this.rows(context.customerId, ids);
    const stored = new Set(rows.map((row) => String(row['device_id'])));
    if (ids.some((id) => !stored.has(id))) throw storeFailure();
    return { rows, syncedAt };
  }
}
