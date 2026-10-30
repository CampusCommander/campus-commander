import * as z from 'zod';
import { GOOGLE_SHEET_TAB_TITLE } from '@campus/google-connection';
import {
  DEVICE_EDIT_TEMPLATE_HEADERS,
  DEVICE_REPORT_FIELD_LABELS,
  createCsvReader,
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
  DeviceArtifactStore,
  DeviceExportDescriptor,
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

/** The facts of a published CSV file, as the export finish records them. */
export interface DeviceExportCsvFile {
  format: 'csv';
  artifactId: string;
  name: string;
  sizeBytes: number;
  rows: number;
  columns: number;
  expiresAt: string;
}

/** The facts of a Sheet export (design section 6, step 7). A Sheet never expires. */
export interface DeviceExportSheetFile {
  format: 'sheet';
  /** The name of the spreadsheet, without the `.csv` suffix of the CSV file. */
  name: string;
  rows: number;
  columns: number;
  /** The stored spreadsheet ID, which the API turns into the link. */
  spreadsheetId: string;
}

export type DeviceExportFile = DeviceExportCsvFile | DeviceExportSheetFile;

export type DeviceExportAnswer =
  | { outcome: 'completed'; displayId: string; file: DeviceExportFile }
  | { outcome: 'cancelled'; displayId: string }
  | { outcome: 'failed'; displayId: string; failure: string }
  /**
   * The job already ended, or this request ended its stored cancel request. This run writes no
   * file.
   */
  | { outcome: 'done' }
  /** Another run holds a live lease. This run writes nothing. */
  | { outcome: 'busy' }
  /** The lease lapsed or another run replaced it. This run writes nothing. */
  | { outcome: 'fenced' }
  /** The worker is stopping. The lease lapses, and the recovery fails the job (section 5). */
  | { outcome: 'stopped' };

/**
 * The Sheets calls of one Sheet export (design section 6, steps 4 to 6). `GoogleDriveClient`
 * satisfies it, and a test passes the real client over the fake transport.
 */
export interface DeviceExportSheetClient {
  createSheet(
    title: string,
  ): Promise<{ spreadsheetId: string; sheetId: number }>;
  setTextFormat(
    spreadsheetId: string,
    sheetId: number,
    columns: number,
  ): Promise<void>;
  writeRows(
    spreadsheetId: string,
    title: string,
    columns: number,
    rows: AsyncIterable<readonly string[]>,
  ): Promise<number>;
}

/**
 * The connection credential of one Sheet export (design section 4). The worker mints the person's
 * `drive.file` token with it, and the claim carries it for the subject of the job.
 */
export interface DeviceExportSheetAccess {
  customerId: string;
  subject: string;
  credentialId: string;
  generation: number;
  envelope: unknown;
}

/** Mint the Drive client of one Sheet export as the person. */
export type DeviceExportSheetFactory = (
  access: DeviceExportSheetAccess,
  signal: AbortSignal,
) => Promise<DeviceExportSheetClient>;

const claimSchema = z.union([
  z.object({
    outcome: z.literal('claimed'),
    displayId: jobDisplayIdSchema,
    targetCount: z.number().int().min(0).max(50000),
    purpose: jobExportPurposeSchema,
    /** The file format of the job (design section 1). A built CSV job answers `csv`. */
    format: z.enum(['csv', 'sheet']).default('csv'),
    /** The person's Drive subject. A Sheet export carries one, and a CSV export none. */
    driveSubject: z.string().min(3).max(254).nullable().default(null),
    columns: z.array(deviceReportFieldIdSchema).max(10),
    /** The connection credential, which a Sheet export mints its token with (design section 4). */
    generation: z.number().int().min(1).nullable().default(null),
    credentialId: z.uuid().nullable().default(null),
    envelope: z.unknown().nullable().default(null),
  }),
  z.object({ outcome: z.literal('done') }),
  z.object({ outcome: z.literal('busy') }),
]);

/** The answer of the one Sheet-create permission (design section 6, step 3). */
const sheetStartSchema = z.union([
  z.object({ outcome: z.literal('started'), startedAt: z.unknown() }),
  z.object({
    outcome: z.literal('repeated'),
    startedAt: z.unknown().optional(),
  }),
  z.object({ outcome: z.literal('cancelled') }),
  z.object({ outcome: z.literal('fenced') }),
  z.object({
    outcome: z.literal('finished'),
    status: z.enum(['completed', 'cancelled', 'failed']),
  }),
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

/** The phase of the job header and its counts (design sections 2 and 6). */
interface PhaseState {
  phase: 'write-rows' | 'create-sheet' | 'prepare-download';
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
    // The callback returns the tick, so a fake timer can await it. `setInterval` ignores the
    // value.
    this.handle = this.timers.setInterval(
      () => this.fire(),
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
  /** Mint the Drive client of a Sheet export as the person (design section 4). */
  drive?: DeviceExportSheetFactory;
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
 * The ten values of one edit row (design section 5, items 3 and 4): the template columns and the
 * row checksum of the unescaped values. A Sheet writes these values with `RAW`, so it takes them
 * without the formula tab (design section 6, step 1).
 */
async function editValues(record: ExportDeviceRecord): Promise<string[]> {
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
  ];
}

/** The cells of one edit row, each escaped for a CSV file. */
async function editCells(record: ExportDeviceRecord): Promise<string[]> {
  return (await editValues(record)).map((cell) => deviceEditEscapeCell(cell));
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
  private readonly store: DeviceArtifactStore;
  private readonly batchSize: number;
  private readonly maxBytes: number;
  private readonly timers: SyncTimers;
  private readonly drive?: DeviceExportSheetFactory;

  constructor(
    database: DeviceSyncDatabase,
    store: DeviceArtifactStore,
    options: DeviceExportOptions = {},
  ) {
    this.database = database;
    this.store = store;
    this.batchSize = options.batchSize ?? DEVICE_EXPORT_BATCH_SIZE;
    this.maxBytes = options.maxBytes ?? DEVICE_EXPORT_MAX_BYTES;
    this.timers = options.timers ?? realTimers;
    this.drive = options.drive;
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
    if (claim.outcome !== 'claimed') {
      // The claim answers `done` for an ended job and for a running job that holds a stored
      // cancel request. The finish repeats an ended job's stored answer and writes nothing. It
      // ends the stored cancellation, so a retry leaves no running header (design section 5).
      if (claim.outcome === 'done')
        return this.endDone(lease, input.failure ?? null);
      return { outcome: claim.outcome };
    }
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

  /**
   * End a job that the claim answered `done` for. An ended job repeats its stored answer and
   * writes nothing. A job that still runs holds a stored cancel request, and this finish ends it
   * Cancelled under this run's lease. A lapsed or replaced lease answers `fenced` and writes
   * nothing (design section 5).
   */
  private async endDone(
    lease: readonly [string, string, string],
    failure: string | null,
  ): Promise<DeviceExportAnswer> {
    const answer = await this.finish(lease, null, failure);
    return answer.outcome === 'fenced'
      ? { outcome: 'fenced' }
      : { outcome: 'done' };
  }

  /**
   * Finish one run and answer what the job header holds. A definitive refusal keeps no published
   * file, so this run removes the file it published. A failed call is ambiguous: the commit may
   * have landed, so the file stays, and the purge removes an unreferenced artifact (design
   * section 4).
   */
  private async end(
    lease: readonly [string, string, string],
    displayId: string,
    file: DeviceExportFile | null,
    failure: string | null,
    published: DeviceExportDescriptor | null = null,
  ): Promise<DeviceExportAnswer> {
    const answer = await this.finish(lease, file, failure);
    if (answer.outcome === 'fenced') {
      if (published !== null) await this.remove(published);
      return { outcome: 'fenced' };
    }
    if (answer.status === 'cancelled') {
      if (published !== null) await this.remove(published);
      return { outcome: 'cancelled', displayId };
    }
    if (answer.status === 'completed' && file !== null)
      return { outcome: 'completed', displayId, file };
    // A stored failed status declined this run's file.
    if (published !== null) await this.remove(published);
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
    const sheet = claim.format === 'sheet';
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
        : // A Sheet writes RAW values, so its rows skip the formula tab (design section 6,
          // step 1). The checksum covers the same unescaped values either way.
          sheet
          ? editValues(record)
          : editCells(record);
    // The tick and the write loop share one renewal queue. A renewal that read an earlier phase
    // lands before the later phase, so the header keeps the later phase and its counts (design
    // section 2). The one Sheet-create permission queues here too, so no write-rows renewal can
    // land after the stamp (design section 6, step 3).
    let renewals: Promise<unknown> = Promise.resolve();
    const queued = <T>(run: () => Promise<T>): Promise<T> => {
      const answer = renewals.then(run);
      renewals = answer.catch(() => undefined);
      return answer;
    };
    const writePhase = (phase: PhaseState) => {
      const snapshot = { ...phase };
      return queued(() => this.writePhase(lease, snapshot));
    };

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
      // The ticker stays alive through the finish of a refused run (design section 5).
      try {
        return await this.stopped(lease, claim.displayId, stop);
      } finally {
        await ticker.close();
      }
    }

    let published = false;
    try {
      // A request stored while the file staged leaves no file and ends Cancelled (design
      // section 5).
      if (
        ticker.cancelled ||
        (await this.cancelRequested(input.customerId, input.jobId))
      )
        return await this.end(lease, claim.displayId, null, null, descriptor);
      if (ticker.fenced) {
        await this.remove(descriptor);
        return { outcome: 'fenced' };
      }

      // A Sheet export stages the template rows first, then creates one Sheet as the person
      // (design section 6, steps 1 to 7). It prepares no download.
      if (sheet)
        return await this.writeSheet(
          input,
          lease,
          claim,
          state,
          headers.length,
          descriptor,
          signal,
          queued,
          ticker,
        );

      state.phase = 'prepare-download';
      state.done = 0;
      state.total = null;
      const prepared = await writePhase(state);
      if (prepared === 'cancelled')
        return await this.end(lease, claim.displayId, null, null, descriptor);
      if (prepared === 'lost') {
        await this.remove(descriptor);
        return { outcome: 'fenced' };
      }

      try {
        await this.store.publish(descriptor);
        published = true;
      } catch {
        await this.remove(descriptor);
        return await this.end(
          lease,
          claim.displayId,
          null,
          'storage-unavailable',
        );
      }

      // The ticker keeps the lease alive through publication, and the finish ends the job under
      // that lease. A cancel stored in between leaves no published file (design section 5).
      return await this.end(
        lease,
        claim.displayId,
        {
          format: 'csv',
          artifactId: descriptor.artifactId,
          name: deviceExportFileName(purpose, claim.displayId),
          sizeBytes: descriptor.sizeBytes,
          rows: writer.rows - 1,
          columns: headers.length,
          expiresAt: descriptor.expiresAt,
        },
        null,
        descriptor,
      );
    } catch (error) {
      // A staged file never outlives a refused request (design section 5). A published file
      // stays when the finish call itself failed, because the commit may have landed, and the
      // purge removes an unreferenced artifact (design section 4).
      if (!published) await this.remove(descriptor);
      throw error;
    } finally {
      await ticker.close();
    }
  }

  /** The one Sheet-create permission of the job (design section 6, step 3). */
  private async startSheet(
    lease: readonly [string, string, string],
  ): Promise<z.infer<typeof sheetStartSchema>> {
    return sheetStartSchema.parse(
      await this.call(
        'SELECT cc.start_device_export_sheet($1,$2,$3) AS result',
        [...lease],
      ),
    );
  }

  /** Mint the Drive client of the person from the credential of the claim (design section 4). */
  private async sheetClient(
    input: DeviceExportRequest,
    claim: ClaimedExport,
    signal: AbortSignal,
  ): Promise<DeviceExportSheetClient> {
    const { driveSubject: subject, credentialId, generation, envelope } = claim;
    if (
      this.drive === undefined ||
      subject === null ||
      credentialId === null ||
      generation === null ||
      envelope === null ||
      envelope === undefined
    )
      throw new DeviceExportError('drive-unavailable');
    try {
      return await this.drive(
        {
          customerId: input.customerId,
          subject,
          credentialId,
          generation,
          envelope,
        },
        signal,
      );
    } catch {
      // A refused token fails the job drive-unavailable (design section 6).
      throw new DeviceExportError('drive-unavailable');
    }
  }

  /**
   * The rows of the staged template file, the header first and in staged order (design section 6,
   * step 6). The stage is the frozen copy of the export, so an inventory edit or a removed device
   * after the stage changes no row. A lost lease or a stopping worker stops the read at a batch
   * boundary.
   */
  private async *stagedRows(
    descriptor: DeviceExportDescriptor,
    signal: AbortSignal,
    ticker: ExportTicker,
  ): AsyncIterable<string[]> {
    const reader = createCsvReader();
    const decoder = new TextDecoder();
    const stopped = (): void => {
      if (ticker.fenced || signal.aborted)
        throw new ExportStop({ kind: 'stopped' });
    };
    let count = 0;
    for await (const chunk of await this.store.openRead(
      descriptor.artifactId,
    )) {
      stopped();
      for (const record of reader.push(
        decoder.decode(chunk, { stream: true }),
      )) {
        yield record.cells;
        count += 1;
        if (count % this.batchSize === 0) stopped();
      }
    }
    for (const record of reader.push(decoder.decode())) yield record.cells;
    for (const record of reader.end()) yield record.cells;
  }

  /**
   * Create the one Sheet of a claimed Sheet export and write the staged rows into it (design
   * section 6, steps 3 to 7). The Sheet is the artifact. The run publishes the stage only to read
   * it back, and it removes the stage after the finish.
   */
  private async writeSheet(
    input: DeviceExportRequest,
    lease: readonly [string, string, string],
    claim: ClaimedExport,
    state: PhaseState,
    columns: number,
    descriptor: DeviceExportDescriptor,
    signal: AbortSignal,
    queue: <T>(run: () => Promise<T>) => Promise<T>,
    ticker: ExportTicker,
  ): Promise<DeviceExportAnswer> {
    const displayId = claim.displayId;
    try {
      // The stamp phase counts nothing and draws no bar, so a queued write-rows renewal cannot
      // mislead the header (design section 6).
      state.phase = 'create-sheet';
      state.done = 0;
      state.total = null;
      const started = await queue(() => this.startSheet(lease));
      if (started.outcome === 'cancelled')
        return await this.end(lease, displayId, null, null);
      if (started.outcome === 'fenced') return { outcome: 'fenced' };
      // Another run holds the one create permission, or the job already ended. This run creates
      // no second Sheet (design section 6, step 3).
      if (started.outcome !== 'started') return { outcome: 'done' };

      const title = deviceExportFileName(claim.purpose, displayId, 'sheet');
      let sheet: { spreadsheetId: string; sheetId: number };
      let written: number;
      try {
        const client = await this.sheetClient(input, claim, signal);
        sheet = await client.createSheet(title);
        await client.setTextFormat(sheet.spreadsheetId, sheet.sheetId, columns);
        // The store reads a file only after publication, so this run publishes the completed
        // stage and writes those bytes. The stage stays frozen: a later inventory change alters
        // no row of the Sheet (design section 6, steps 1 and 6).
        try {
          await this.store.publish(descriptor);
        } catch {
          throw new DeviceExportError('storage-unavailable');
        }
        written = await client.writeRows(
          sheet.spreadsheetId,
          GOOGLE_SHEET_TAB_TITLE,
          columns,
          this.stagedRows(descriptor, signal, ticker),
        );
      } catch (error) {
        if (error instanceof ExportStop) {
          if (error.reason.kind === 'stopped') return { outcome: 'stopped' };
          return await this.end(lease, displayId, null, null);
        }
        return await this.end(
          lease,
          displayId,
          null,
          error instanceof DeviceExportError
            ? error.code
            : 'sheet-write-failed',
        );
      }
      // A stopping worker leaves the partial Sheet to the recovery (design section 6).
      if (signal.aborted) return { outcome: 'stopped' };
      return await this.end(
        lease,
        displayId,
        {
          format: 'sheet',
          name: title,
          rows: written - 1,
          columns,
          spreadsheetId: sheet.spreadsheetId,
        },
        null,
      );
    } finally {
      // The worker removes the staged rows after the finish (design section 6, step 7). The Sheet
      // is the artifact, so the stage never stays.
      await this.remove(descriptor);
    }
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
