import * as z from 'zod';
import {
  DEVICE_EDIT_TEMPLATE_HEADERS,
  DEVICE_REPORT_FIELD_LABELS,
  createCsvWriter,
  deviceEditEscapeCell,
  deviceEditRowChecksum,
  deviceExportFileName,
  deviceReportCellText,
  deviceReportFieldIdSchema,
  freshnessCutoff,
  googleCustomerIdSchema,
  jobDisplayIdSchema,
  jobExportPurposeSchema,
  type DeviceBattery,
  type DeviceReportFieldId,
  type DeviceRow,
} from '@campus/application-contracts';
import {
  CANCEL_POLL_MILLISECONDS,
  callStore,
  type DeviceSyncDatabase,
  type SyncTimers,
} from './device-sync';
import type {
  DeviceExportDescriptor,
  DeviceExportStore,
} from './device-export-store';

/**
 * The worker side of one export job (`docs/superpowers/specs/2026-10-28-device-export-import-design.md`,
 * section 5).
 *
 * The handler claims the job under a two-minute lease, reads the frozen scope in ordinal batches,
 * and streams the file into the artifact store. A 30-second tick renews the lease and reads the
 * cancel request. The file holds the edit template or the stored report columns. A cancel stops at
 * the next batch and leaves no staged file.
 */

/** The devices of one read of the frozen scope (design section 5, item 2). */
export const DEVICE_EXPORT_BATCH_SIZE = 1_000;

/** The payload version of an export artifact. */
export const DEVICE_EXPORT_ARTIFACT_SCHEMA_VERSION = 1;

/**
 * The cap of an export file (design section 4). A row at every limit takes at most 19,390 bytes,
 * and 50,000 such rows with the header stay under this cap. A stored value above its field limit
 * breaks that bound, and the edit export then stops at the cap with `export-too-large`.
 */
export const DEVICE_EXPORT_MAX_BYTES = 1_073_741_824;

export const deviceExportRequestSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  jobId: z.uuid(),
  /** The lease of this run. The claim takes it, and Kestra repeats it after a failed request. */
  leaseId: z.uuid(),
  correlationId: z.uuid(),
  /** The flow `errors` block fails a lost run (design section 5). A run request carries none. */
  failure: z.literal('interrupted').optional(),
});
export type DeviceExportRequest = z.infer<typeof deviceExportRequestSchema>;

/** The published file facts, as the export finish records them. */
export interface DeviceExportFile {
  artifactId: string;
  name: string;
  sizeBytes: number;
  rows: number;
  columns: number;
  expiresAt: string;
}

export type DeviceExportAnswer =
  | { outcome: 'completed'; displayId: string; file: DeviceExportFile }
  | { outcome: 'cancelled'; displayId: string }
  | { outcome: 'failed'; displayId: string; failure: string }
  /** The job holds a stored cancel request or already ended. This run writes nothing. */
  | { outcome: 'done' }
  /** Another run holds a live lease. This run writes nothing. */
  | { outcome: 'busy' }
  /** The lease lapsed or another run replaced it. This run writes nothing. */
  | { outcome: 'fenced' }
  /** The worker is stopping. The lease lapses, and the recovery fails the job (section 5). */
  | { outcome: 'stopped' };

const claimSchema = z.union([
  z.object({
    outcome: z.literal('claimed'),
    displayId: jobDisplayIdSchema,
    targetCount: z.number().int().min(0).max(50000),
    purpose: jobExportPurposeSchema,
    columns: z.array(deviceReportFieldIdSchema).max(10),
  }),
  z.object({ outcome: z.literal('done') }),
  z.object({ outcome: z.literal('busy') }),
]);

const renewalSchema = z.object({
  outcome: z.enum(['renewed', 'done', 'fenced']),
});

/** One claimed export run: the scope frozen at creation and the request of the job. */
type ClaimedExport = Extract<
  z.infer<typeof claimSchema>,
  { outcome: 'claimed' }
>;

const finishSchema = z.object({
  outcome: z.enum(['finished', 'fenced']),
  status: z.enum(['completed', 'cancelled', 'failed']).optional(),
});

const targetRecordSchema = z.object({
  ordinal: z.number().int().min(0),
  device_id: z.string().min(1).max(128),
  serial_number: z.string().max(256),
  model: z.string().max(256).nullable(),
  status: z.string().max(64).nullable(),
  asset_tag: z.string().max(4096).nullable(),
  annotated_location: z.string().max(4096).nullable(),
  annotated_user: z.string().max(4096).nullable(),
  notes: z.string().max(4096).nullable(),
  org_unit_path: z.string().min(1).max(4096),
  last_contact: z.unknown(),
  battery_status: z.enum(['reported', 'no-report', 'unavailable']),
  battery_health: z.enum(['normal', 'replace-soon', 'replace-now']).nullable(),
  battery_capacity_percent: z.number().int().nullable(),
  battery_reported_at: z.unknown(),
  last_entity_sync: z.unknown(),
});

/** One device of the frozen scope, with the values that a file cell reads. */
interface ExportDeviceRecord {
  ordinal: number;
  deviceId: string;
  serialNumber: string;
  model: string | null;
  status: string | null;
  assetTag: string | null;
  annotatedLocation: string | null;
  annotatedUser: string | null;
  notes: string | null;
  orgUnitPath: string;
  lastContact: unknown;
  batteryStatus: 'reported' | 'no-report' | 'unavailable';
  batteryHealth: 'normal' | 'replace-soon' | 'replace-now' | null;
  batteryCapacityPercent: number | null;
  batteryReportedAt: unknown;
  lastEntitySync: unknown;
}

/** The device read of one batch, in ordinal order (design section 5, item 2). */
const TARGET_BATCH_SQL = `SELECT t.ordinal, d.device_id, d.serial_number, d.model, d.status,
    d.asset_tag, d.annotated_location, d.annotated_user, d.notes, d.org_unit_path, d.last_contact,
    d.battery_status, d.battery_health, d.battery_capacity_percent, d.battery_reported_at,
    d.last_entity_sync
  FROM cc.device_export_targets t
  JOIN cc.devices d ON d.customer_id=$1 AND d.device_id=t.device_id
  WHERE t.job_id=$2 AND t.ordinal>=$3
  ORDER BY t.ordinal
  LIMIT $4`;

/** The phase of the job header and its counts (design section 2). */
interface PhaseState {
  phase: 'write-rows' | 'prepare-download';
  done: number;
  total: number | null;
}

/** Why a run stopped before its finish. */
type StopReason =
  | { kind: 'cancelled' }
  | { kind: 'too-large' }
  | { kind: 'stopped' }
  | { kind: 'read-failed' };

/** The stop of a run inside its record stream. The store removes the partial file. */
class ExportStop extends Error {
  readonly reason: StopReason;
  constructor(reason: StopReason) {
    super(`The export stopped: ${reason.kind}.`);
    this.name = 'ExportStop';
    this.reason = reason;
  }
}

/** A store call that keeps no lease detail. The dispatch answers 503, so Kestra retries. */
export class DeviceExportError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'DeviceExportError';
    this.code = code;
  }
}

/**
 * The 30-second tick of one export run (design section 5, item 1). It renews the lease, writes the
 * phase, and reads the cancel request. A failed tick leaves its flags unset, and the next tick
 * reads again. A tick never overlaps another.
 */
class ExportTicker {
  private handle: unknown = null;
  private running: Promise<void> | null = null;
  private requested = false;
  private lost = false;
  private readonly tick: () => Promise<'renewed' | 'cancelled' | 'lost'>;
  private readonly timers: SyncTimers;

  constructor(
    tick: () => Promise<'renewed' | 'cancelled' | 'lost'>,
    timers: SyncTimers,
  ) {
    this.tick = tick;
    this.timers = timers;
  }

  /** True once the store or the phase write answered that the job holds a cancel request. */
  get cancelled(): boolean {
    return this.requested;
  }

  /** True once the lease lapsed or another run replaced it. */
  get fenced(): boolean {
    return this.lost;
  }

  start(): void {
    this.handle = this.timers.setInterval(
      () => void this.fire(),
      CANCEL_POLL_MILLISECONDS,
    );
  }

  private fire(): Promise<void> {
    this.running ??= this.wait().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async wait(): Promise<void> {
    if (this.requested || this.lost) return;
    try {
      const answer = await this.tick();
      if (answer === 'cancelled') this.requested = true;
      if (answer === 'lost') this.lost = true;
    } catch {
      // A failed tick leaves the flags unset. The next tick reads again.
    }
  }

  /** Stop the tick and wait for a tick that already runs. */
  async close(): Promise<void> {
    this.timers.clearInterval(this.handle);
    await this.running;
  }
}

export interface DeviceExportOptions {
  /** The devices of one read of the scope. Defaults to 1,000 (design section 5). */
  batchSize?: number;
  /** The cap of the file. Defaults to `DEVICE_EXPORT_MAX_BYTES`. */
  maxBytes?: number;
  timers?: SyncTimers;
}

const realTimers: SyncTimers = {
  setInterval: (callback, milliseconds) => {
    const handle = setInterval(callback, milliseconds);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

/** A timestamp of a device row as ISO 8601 UTC text. */
function timestampText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const stamp = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(stamp.getTime()))
    throw new DeviceExportError('inventory-unavailable');
  return stamp.toISOString();
}

/** A timestamp that the device row always holds. */
function requiredTimestampText(value: unknown): string {
  const text = timestampText(value);
  if (text === null) throw new DeviceExportError('inventory-unavailable');
  return text;
}

/** The battery text of one device row. The row check keeps a reported battery complete. */
function batteryOf(record: ExportDeviceRecord): DeviceBattery {
  if (record.batteryStatus !== 'reported')
    return { status: record.batteryStatus };
  if (record.batteryHealth === null || record.batteryReportedAt === null)
    throw new DeviceExportError('inventory-unavailable');
  return {
    status: 'reported',
    health: record.batteryHealth,
    capacityPercent: record.batteryCapacityPercent,
    reportedAt: requiredTimestampText(record.batteryReportedAt),
  };
}

/** The eight values that the row checksum covers (design section 5, item 4). */
function checksumRow(record: ExportDeviceRecord) {
  return {
    deviceId: record.deviceId,
    status: record.status,
    annotatedAssetId: record.assetTag,
    annotatedLocation: record.annotatedLocation,
    annotatedUser: record.annotatedUser,
    notes: record.notes,
    orgUnitPath: record.orgUnitPath,
  };
}

/**
 * The cells of one edit row (design section 5, items 3 and 4): the ten template columns, each
 * escaped, and the row checksum of the unescaped values.
 */
async function editCells(record: ExportDeviceRecord): Promise<string[]> {
  const checksum = await deviceEditRowChecksum(checksumRow(record));
  return [
    record.deviceId,
    record.serialNumber,
    record.model ?? '',
    // Google's status value, not the grid label (design section 5, item 3).
    record.status ?? '',
    record.assetTag ?? '',
    record.annotatedLocation ?? '',
    record.annotatedUser ?? '',
    record.notes ?? '',
    record.orgUnitPath,
    checksum,
  ].map((cell) => deviceEditEscapeCell(cell));
}

/** The report row of one device: the grid columns of the contract. */
function reportRow(record: ExportDeviceRecord, cutoff: Date): DeviceRow {
  const lastEntitySync = requiredTimestampText(record.lastEntitySync);
  return {
    deviceId: record.deviceId,
    serialNumber: record.serialNumber,
    model: record.model,
    assetTag: record.assetTag,
    orgUnitPath: record.orgUnitPath,
    lastContact: timestampText(record.lastContact),
    annotatedLocation: record.annotatedLocation,
    annotatedUser: record.annotatedUser,
    notes: record.notes,
    status: record.status,
    battery: batteryOf(record),
    lastEntitySync,
    stale: new Date(lastEntitySync).getTime() < cutoff.getTime(),
  };
}

/**
 * The cells of one report row (design section 5, item 4): the stored columns in their order, no
 * Checksum, and the same escape.
 */
function reportCells(
  columns: readonly DeviceReportFieldId[],
  record: ExportDeviceRecord,
  cutoff: Date,
): string[] {
  const row = reportRow(record, cutoff);
  return columns.map((field) =>
    deviceEditEscapeCell(deviceReportCellText(field, row)),
  );
}

/** Run one export job (design section 5). */
export class DeviceExportJobs {
  private readonly database: DeviceSyncDatabase;
  private readonly store: DeviceExportStore;
  private readonly batchSize: number;
  private readonly maxBytes: number;
  private readonly timers: SyncTimers;

  constructor(
    database: DeviceSyncDatabase,
    store: DeviceExportStore,
    options: DeviceExportOptions = {},
  ) {
    this.database = database;
    this.store = store;
    this.batchSize = options.batchSize ?? DEVICE_EXPORT_BATCH_SIZE;
    this.maxBytes = options.maxBytes ?? DEVICE_EXPORT_MAX_BYTES;
    this.timers = options.timers ?? realTimers;
  }

  private call(sql: string, values: unknown[]): Promise<unknown> {
    return callStore(this.database, sql, values);
  }

  async run(
    request: DeviceExportRequest,
    signal: AbortSignal,
  ): Promise<DeviceExportAnswer> {
    const input = deviceExportRequestSchema.parse(request);
    const lease: [string, string, string] = [
      input.customerId,
      input.jobId,
      input.leaseId,
    ];
    const claim = claimSchema.parse(
      await this.call('SELECT cc.claim_device_export_job($1,$2,$3) AS result', [
        ...lease,
      ]),
    );
    if (claim.outcome !== 'claimed') return { outcome: claim.outcome };
    if (input.failure !== undefined)
      return this.end(lease, claim.displayId, null, input.failure);
    return this.write(input, lease, claim, signal);
  }

  /** Read one batch of the frozen scope, in ordinal order. A failed read fails the job. */
  private async readBatch(
    customerId: string,
    jobId: string,
    after: number,
  ): Promise<ExportDeviceRecord[]> {
    let rows: Record<string, unknown>[];
    try {
      rows = (
        await this.database.query(TARGET_BATCH_SQL, [
          customerId,
          jobId,
          after,
          this.batchSize,
        ])
      ).rows;
    } catch {
      throw new DeviceExportError('inventory-unavailable');
    }
    return rows.map((row) => {
      const parsed = targetRecordSchema.safeParse(row);
      if (!parsed.success) throw new DeviceExportError('inventory-unavailable');
      const value = parsed.data;
      return {
        ordinal: value.ordinal,
        deviceId: value.device_id,
        serialNumber: value.serial_number,
        model: value.model,
        status: value.status,
        assetTag: value.asset_tag,
        annotatedLocation: value.annotated_location,
        annotatedUser: value.annotated_user,
        notes: value.notes,
        orgUnitPath: value.org_unit_path,
        lastContact: value.last_contact,
        batteryStatus: value.battery_status,
        batteryHealth: value.battery_health,
        batteryCapacityPercent: value.battery_capacity_percent,
        batteryReportedAt: value.battery_reported_at,
        lastEntitySync: value.last_entity_sync,
      };
    });
  }

  /** Write the phase and renew the lease. A stored cancel answers `cancelled`. */
  private async writePhase(
    lease: readonly [string, string, string],
    state: PhaseState,
  ): Promise<'renewed' | 'cancelled' | 'lost'> {
    const answer = renewalSchema.parse(
      await this.call(
        'SELECT cc.renew_device_export_job($1,$2,$3,$4,$5,$6) AS result',
        [...lease, state.phase, state.done, state.total],
      ),
    );
    if (answer.outcome === 'renewed') return 'renewed';
    return answer.outcome === 'done' ? 'cancelled' : 'lost';
  }

  /** The cancel request of the job header (design section 5, item 1). */
  private async cancelRequested(
    customerId: string,
    jobId: string,
  ): Promise<boolean> {
    const answer = await this.call(
      'SELECT cc.job_cancel_requested($1,$2) AS result',
      [customerId, jobId],
    );
    if (typeof answer !== 'boolean')
      throw new DeviceExportError('store-unavailable');
    return answer;
  }

  /** End the job under the lease. A stored cancel ends it Cancelled, and it keeps no file. */
  private async finish(
    lease: readonly [string, string, string],
    file: DeviceExportFile | null,
    failure: string | null,
  ) {
    return finishSchema.parse(
      await this.call(
        'SELECT cc.finish_device_export_job($1,$2,$3,$4,$5) AS result',
        [...lease, file === null ? null : JSON.stringify(file), failure],
      ),
    );
  }

  /** Remove a staged file that the job never publishes. */
  private async remove(descriptor: DeviceExportDescriptor): Promise<void> {
    try {
      await this.store.remove(descriptor);
    } catch {
      // The purge removes an unreferenced staging file after the retention (design section 4).
    }
  }

  /** Finish one run and answer what the job header holds. */
  private async end(
    lease: readonly [string, string, string],
    displayId: string,
    file: DeviceExportFile | null,
    failure: string | null,
  ): Promise<DeviceExportAnswer> {
    const answer = await this.finish(lease, file, failure);
    if (answer.outcome === 'fenced') return { outcome: 'fenced' };
    if (answer.status === 'cancelled')
      return { outcome: 'cancelled', displayId };
    if (answer.status === 'completed' && file !== null)
      return { outcome: 'completed', displayId, file };
    return {
      outcome: 'failed',
      displayId,
      failure: failure ?? 'storage-unavailable',
    };
  }

  private async write(
    input: DeviceExportRequest,
    lease: readonly [string, string, string],
    claim: ClaimedExport,
    signal: AbortSignal,
  ): Promise<DeviceExportAnswer> {
    const purpose = claim.purpose;
    const maxBytes = this.maxBytes;
    const columns: readonly DeviceReportFieldId[] =
      purpose === 'report' ? claim.columns : [];
    const headers: readonly string[] =
      purpose === 'report'
        ? columns.map((field) => DEVICE_REPORT_FIELD_LABELS[field])
        : DEVICE_EDIT_TEMPLATE_HEADERS;
    const writer = createCsvWriter();
    const cutoff = freshnessCutoff('device');
    const state: PhaseState = {
      phase: 'write-rows',
      done: 0,
      total: claim.targetCount,
    };
    const readBatch = (after: number) =>
      this.readBatch(input.customerId, input.jobId, after);
    const cells = (record: ExportDeviceRecord): Promise<string[]> =>
      purpose === 'report'
        ? Promise.resolve(reportCells(columns, record, cutoff))
        : editCells(record);
    const writePhase = (phase: PhaseState) => this.writePhase(lease, phase);

    const ticker = new ExportTicker(async () => {
      const answer = await writePhase(state);
      if (answer !== 'renewed') return answer;
      return (await this.cancelRequested(input.customerId, input.jobId))
        ? 'cancelled'
        : 'renewed';
    }, this.timers);
    ticker.start();

    let stop: StopReason | null = null;
    const source = async function* (): AsyncIterable<Buffer> {
      try {
        yield Buffer.from(writer.start(), 'utf8');
        yield Buffer.from(writer.row(headers), 'utf8');
        let after = 0;
        for (;;) {
          const batch = await readBatch(after);
          if (batch.length === 0) break;
          const lines: string[] = [];
          for (const record of batch)
            lines.push(writer.row(await cells(record)));
          // The cap reads the counted bytes, so the store never receives an oversized chunk
          // (design section 4).
          if (writer.bytes > maxBytes)
            throw new ExportStop({ kind: 'too-large' });
          yield Buffer.from(lines.join(''), 'utf8');
          after = batch[batch.length - 1].ordinal + 1;
          state.done = writer.rows - 1;
          const answer = await writePhase(state);
          if (answer === 'cancelled')
            throw new ExportStop({ kind: 'cancelled' });
          if (answer === 'lost') throw new ExportStop({ kind: 'stopped' });
          if (ticker.cancelled) throw new ExportStop({ kind: 'cancelled' });
          if (signal.aborted) throw new ExportStop({ kind: 'stopped' });
        }
        // The last batch wrote its phase already. This write sets the phase of an empty scope.
        const final = await writePhase({ ...state, done: writer.rows - 1 });
        if (final === 'cancelled') throw new ExportStop({ kind: 'cancelled' });
        if (final === 'lost') throw new ExportStop({ kind: 'stopped' });
        if (ticker.cancelled) throw new ExportStop({ kind: 'cancelled' });
      } catch (error) {
        stop =
          error instanceof ExportStop
            ? error.reason
            : { kind: signal.aborted ? 'stopped' : 'read-failed' };
        throw error;
      }
    };

    let descriptor: DeviceExportDescriptor;
    try {
      descriptor = await this.store.stageStream(
        {
          schemaVersion: DEVICE_EXPORT_ARTIFACT_SCHEMA_VERSION,
          maxBytes,
        },
        source(),
      );
    } catch {
      await ticker.close();
      return this.stopped(lease, claim.displayId, stop);
    }

    await ticker.close();
    try {
      // A request stored while the file staged leaves no file and ends Cancelled (design
      // section 5).
      if (
        ticker.cancelled ||
        (await this.cancelRequested(input.customerId, input.jobId))
      ) {
        await this.remove(descriptor);
        return this.end(lease, claim.displayId, null, null);
      }
      if (ticker.fenced) {
        await this.remove(descriptor);
        return { outcome: 'fenced' };
      }

      state.phase = 'prepare-download';
      state.done = 0;
      state.total = null;
      const prepared = await writePhase(state);
      if (prepared === 'cancelled') {
        await this.remove(descriptor);
        return this.end(lease, claim.displayId, null, null);
      }
      if (prepared === 'lost') {
        await this.remove(descriptor);
        return { outcome: 'fenced' };
      }

      try {
        await this.store.publish(descriptor);
      } catch {
        await this.remove(descriptor);
        return this.end(lease, claim.displayId, null, 'storage-unavailable');
      }
    } catch (error) {
      // A staged file never outlives a refused request (design section 5). Once the file
      // publishes, the finish owns it, so a failed finish keeps it for the purge instead.
      await this.remove(descriptor);
      throw error;
    }
    return this.end(
      lease,
      claim.displayId,
      {
        artifactId: descriptor.artifactId,
        name: deviceExportFileName(purpose, claim.displayId),
        sizeBytes: descriptor.sizeBytes,
        rows: writer.rows - 1,
        columns: headers.length,
        expiresAt: descriptor.expiresAt,
      },
      null,
    );
  }

  /** Answer a run that stopped before its file was staged. */
  private async stopped(
    lease: readonly [string, string, string],
    displayId: string,
    stop: StopReason | null,
  ): Promise<DeviceExportAnswer> {
    if (stop?.kind === 'stopped') return { outcome: 'stopped' };
    if (stop?.kind === 'cancelled')
      return this.end(lease, displayId, null, null);
    if (stop?.kind === 'too-large')
      return this.end(lease, displayId, null, 'export-too-large');
    return this.end(
      lease,
      displayId,
      null,
      stop === null ? 'storage-unavailable' : 'inventory-unavailable',
    );
  }
}
