import * as z from 'zod';
import {
  DEVICE_EDIT_TEMPLATE_COLUMNS,
  DEVICE_IMPORT_NOT_RUN_TEXTS,
  DEVICE_IMPORT_REJECTION_TEXTS,
  DEVICE_IMPORT_ROW_LIMIT,
  CsvError,
  createCsvReader,
  createCsvWriter,
  deviceEditCanonicalFieldValue,
  deviceEditCanonicalStatusCell,
  deviceEditChecksumIsWellFormed,
  deviceEditFieldCellIntent,
  deviceEditFieldChange,
  deviceEditRowChecksum,
  deviceEditStatusCellIntent,
  deviceEditUnescapeCell,
  deviceImportDuplicateTagWarning,
  deviceImportExportOnlyStatusWarning,
  deviceImportPermissionRejectionText,
  deviceImportRefusalText,
  deviceImportUnitRejectionText,
  freshnessCutoff,
  googleCustomerIdSchema,
  jobDisplayIdSchema,
  jobFailureSchema,
  matchDeviceEditHeaders,
  type CsvRecord,
  type DeviceEditColumnKey,
  type DeviceImportMode,
  type DeviceImportNotRunReason,
  type DeviceImportRefusal,
  type DeviceOrgUnitTreeEntry,
  type DeviceStatusAction,
  type DeviceUpdateField,
} from '@campus/application-contracts';
import {
  GOOGLE_DRIVE_SOURCE_BYTES,
  GoogleConnectionError,
  GoogleDriveError,
  failure,
  type DelegatedCredential,
  type DeviceState,
} from '@campus/google-connection';
import type {
  DeviceArtifactStore,
  DeviceExportDescriptor,
} from './device-export-store';
import {
  CANCEL_POLL_MILLISECONDS,
  DeviceSyncError,
  callStore,
  type DeviceSyncDatabase,
  type SyncTimers,
} from './device-sync';

/**
 * The worker side of one validation job (`docs/superpowers/specs/2026-10-28-device-export-import-design.md`,
 * section 6).
 *
 * The handler claims the job under a two-minute lease and runs two passes. Pass 1 checks the
 * header, the row limits, the device IDs, and the row checksums. It then resolves the candidates,
 * reads the stale devices, checks the unit paths, and checks the status permissions. Pass 2 parses
 * the file again and compares each candidate row with its fresh values. A 30-second tick renews the
 * lease and reads the cancel request. A stopped validation keeps no report and no plan.
 */

/** The rows and the devices of one read (design section 6). */
export const DEVICE_IMPORT_BATCH_SIZE = 1_000;

/** The lines of one `cc.store_device_import_lines` call (design section 6, step 19). */
export const DEVICE_IMPORT_LINE_BATCH = 1_000;

/**
 * The JSON text that one line call carries. `cc.store_device_import_lines` refuses more than 32
 * MiB of jsonb, and the compact array that the handler writes is no larger once stored
 * (design section 6, step 19).
 */
export const DEVICE_IMPORT_LINE_BYTES = 32 * 1024 * 1024;

/**
 * The stored size that one line adds beyond its JSON text. `cc.store_device_import_lines` measures
 * `pg_column_size` of the jsonb array, and jsonb adds a container header and one entry per key and
 * value. A line holds eleven members at most, so this allowance covers the largest one twice over
 * (design section 6, step 19).
 */
const LINE_JSONB_OVERHEAD = 256;

/**
 * The framing that one call adds around its lines: the array header and its entries. A call closes
 * below the 32 MiB cap with this space to spare, so the stored document never reaches it.
 */
const LINE_ARRAY_FRAMING = 4 * 1024;

/** The payload version of a stored Drive source. The stage is a CSV file of the edit template. */
export const DEVICE_IMPORT_SOURCE_SCHEMA_VERSION = 1;

/** The warning of a Checksum cell that is not the exported form (`td:496`). */
export const DEVICE_IMPORT_MALFORMED_CHECKSUM_WARNING =
  'The Checksum cell is malformed. The row is checked in full.';

/** The refusal of a file that holds no header row. */
export const DEVICE_IMPORT_MISSING_HEADER_TEXT =
  'The file holds no header row. Export the template and import it again.';

export const deviceImportRequestSchema = z.strictObject({
  customerId: googleCustomerIdSchema,
  jobId: z.uuid(),
  /** The lease of this run. The claim takes it, and Kestra repeats it after a failed request. */
  leaseId: z.uuid(),
  correlationId: z.uuid(),
  /** The flow `errors` block fails a lost run (design section 5). A run request carries none. */
  failure: z.literal('interrupted').optional(),
});
export type DeviceImportRequest = z.infer<typeof deviceImportRequestSchema>;

/** The status actions of the status permissions that the API read at submission. */
const statusActionSchema = z.enum(['disable', 'reenable', 'deprovision']);

const claimSchema = z.union([
  z.object({
    outcome: z.literal('claimed'),
    displayId: jobDisplayIdSchema,
    mode: z.enum(['sync-changes', 'sync-all-rows']),
    /** The claim counter of this attempt. Only the newest attempt may store a line or finish. */
    attempt: z.number().int().nonnegative(),
    /** The uploaded file, or the stored Drive source. The upload links it to the job through
     * `cc.artifacts.job_id`. A Drive import reads its source when this stays null (design
     * section 7). */
    sourceArtifactId: z.string().min(1).max(256).nullable(),
    /** The source type of the job (design section 1). A built upload answers `csv`. */
    sourceType: z.enum(['csv', 'drive-sheet', 'drive-csv']).default('csv'),
    /** The file name that Drive answered. A source refusal names it (design section 7). */
    sourceName: z.string().min(1).max(255).default('devices.csv'),
    /** The Drive file of a Drive source, and the tab of a Sheet (design section 1). */
    sourceFileId: z.string().min(1).max(128).nullable().default(null),
    sourceTabId: z.number().int().min(0).nullable().default(null),
    /** The verified sign-in subject that the worker mints its Drive token for (section 4). */
    driveSubject: z.string().min(3).max(254).nullable().default(null),
    /** The connection credential that the worker reads Google with. */
    generation: z.number().int().positive().nullable(),
    credentialId: z.uuid().nullable(),
    envelope: z.unknown().nullable(),
    statusPermissions: z.array(statusActionSchema).max(3),
  }),
  z.object({
    outcome: z.literal('done'),
    /** The attempt of the last claim. A repeated finish answers the stored status. */
    attempt: z.number().int().nonnegative(),
  }),
  z.object({ outcome: z.literal('busy') }),
]);
type ClaimedImport = Extract<
  z.infer<typeof claimSchema>,
  { outcome: 'claimed' }
>;

/**
 * The identity of one claimed run: the customer, the job, the lease, and the claim attempt. A
 * repeated request opens a new attempt, so the attempt fences a run that a newer claim replaced.
 */
type ImportOwner = readonly [
  customer: string,
  job: string,
  lease: string,
  attempt: number,
];

const renewalSchema = z.object({
  outcome: z.enum(['renewed', 'done', 'fenced']),
});

const storedLinesSchema = z.object({
  outcome: z.enum(['stored', 'fenced', 'done']),
});

/** The answer of the source link of one Drive read (design section 7, step 7). */
const sourceStoreSchema = z.object({
  outcome: z.enum(['stored', 'fenced', 'done']),
  artifactId: z.string().min(1).max(256).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

const finishSchema = z.object({
  outcome: z.enum(['finished', 'fenced']),
  status: z
    .enum(['completed', 'completed-with-errors', 'failed', 'cancelled'])
    .optional(),
  plan: z
    .object({
      planId: z.uuid(),
      revision: z.number().int().min(1),
      state: z.enum(['open', 'executed', 'cancelled']),
      expiresAt: z.string().min(1),
    })
    .nullable()
    .optional(),
});
type FinishAnswer = z.infer<typeof finishSchema>;

/** The row counts of a completed validation (design section 1, `td:674`). */
export interface DeviceImportCounts {
  rows: number;
  unchanged: number;
  noChangeNeeded: number;
  proposed: number;
  rejected: number;
  candidateRows: number;
  staleDevicesRead: number;
  oldestObservedAt: string | null;
}

/** The plan that the finish created (design section 6, step 20). */
export interface DeviceImportPlan {
  planId: string;
  revision: number;
  state: 'open' | 'executed' | 'cancelled';
  expiresAt: string;
}

export type DeviceImportAnswer =
  | {
      outcome: 'completed';
      displayId: string;
      status: 'completed' | 'completed-with-errors';
      counts: DeviceImportCounts;
      plan: DeviceImportPlan | null;
    }
  | { outcome: 'cancelled'; displayId: string }
  | {
      outcome: 'failed';
      displayId: string;
      failure: string;
      refusal: string | null;
    }
  /** The job already ended, or this request ended its stored cancel request. */
  | { outcome: 'done' }
  /** Another run holds a live lease. This run writes nothing. */
  | { outcome: 'busy' }
  /** The lease lapsed or another run replaced it. This run writes nothing. */
  | { outcome: 'fenced' }
  /** The worker is stopping. The lease lapses, and the recovery fails the job (section 5). */
  | { outcome: 'stopped' };

/** The Google reads of the validation job. The mock and the fake tests supply this port. */
export interface DeviceImportReader {
  deviceStates(
    credential: DelegatedCredential,
    customerId: string,
    deviceIds: readonly string[],
    signal: AbortSignal,
  ): Promise<DeviceState[]>;
  readOrgUnitTree(
    credential: DelegatedCredential,
    customerId: string,
    signal: AbortSignal,
  ): Promise<DeviceOrgUnitTreeEntry[]>;
}

/**
 * The database of the validation job. The refresh stores the found devices and the missing devices
 * in one transaction (design section 6, step 10).
 */
export interface DeviceImportDatabase extends DeviceSyncDatabase {
  transaction<T>(run: (query: DeviceSyncDatabase) => Promise<T>): Promise<T>;
}

/** The credential decoder of the claim. */
export interface DeviceImportCipher {
  open(
    envelope: unknown,
    context: { recordId: string; customerId: string; generation: number },
  ): DelegatedCredential;
}

/**
 * One Sheet tab and its rows, as the Drive read consumes them (design section 7, step 2).
 * `GoogleDriveClient` satisfies it, and a test passes the real client over a fake transport.
 */
export interface DeviceImportDriveTab {
  /** The current title of the tab, as `spreadsheets.get` answers it. */
  readonly title: string;
  /** The rows of the tab, the header first, each padded to the header width. */
  rows(): AsyncIterable<string[]>;
}

/**
 * The Drive calls of one Drive import (design section 7, steps 2 and 5). A Sheet reads one tab by
 * its ID, and a CSV file streams its bytes.
 */
export interface DeviceImportDriveClient {
  readTab(fileId: string, tabId: number): Promise<DeviceImportDriveTab>;
  stream(fileId: string): AsyncIterable<Uint8Array>;
}

/** Mint the Drive client of one Drive import for the person of the job (design section 4). */
export type DeviceImportDriveFactory = (
  credential: DelegatedCredential,
  subject: string,
  signal: AbortSignal,
) => Promise<DeviceImportDriveClient>;

export interface DeviceImportOptions {
  /** The rows and the devices of one read. Defaults to 1,000 (design section 6). */
  batchSize?: number;
  timers?: SyncTimers;
  /** The Drive client of a Drive source. A test supplies the real client over a fake transport. */
  drive?: DeviceImportDriveFactory;
}

/** A store call that keeps no lease detail. The dispatch answers 503, so Kestra retries. */
export class DeviceImportError extends DeviceSyncError {
  constructor(code: string) {
    super(code);
    this.name = 'DeviceImportError';
  }
}

/** A file fault that stops validation before any row check (design section 6). */
class ImportRefusal extends Error {
  readonly code: DeviceImportRefusal;
  readonly text: string;
  constructor(code: DeviceImportRefusal, text: string) {
    super(text);
    this.name = 'ImportRefusal';
    this.code = code;
    this.text = text;
  }
}

/** Why a run stopped before its finish. */
type StopReason =
  | { kind: 'cancelled' }
  | { kind: 'fenced' }
  | { kind: 'stopped' };

/** The stop of a run between batches. */
class ImportStop extends Error {
  readonly reason: StopReason;
  constructor(reason: StopReason) {
    super(`The validation stopped: ${reason.kind}.`);
    this.name = 'ImportStop';
    this.reason = reason;
  }
}

/** The index of each template column, in template order (`device-edit-template.ts`). */
const columnIndex = (key: DeviceEditColumnKey) =>
  DEVICE_EDIT_TEMPLATE_COLUMNS.findIndex((column) => column.key === key);
const DEVICE_ID_COLUMN = columnIndex('deviceId');
const STATUS_COLUMN = columnIndex('status');
const ORG_UNIT_COLUMN = columnIndex('orgUnitPath');
const CHECKSUM_COLUMN = columnIndex('checksum');
const ASSET_TAG_COLUMN = columnIndex('annotatedAssetId');

/** The five editable field columns, in template order (design section 6, step 16). */
const FIELD_COLUMNS: readonly {
  field: DeviceUpdateField;
  column: number;
  header: string;
}[] = DEVICE_EDIT_TEMPLATE_COLUMNS.flatMap((column, index) =>
  column.field === undefined
    ? []
    : [{ field: column.field, column: index, header: column.header }],
);

/** Device IDs travel into Google request paths. Only plain identifiers enter a job. */
const PLAIN_DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The status that each status action asks Google for (design section 6, step 16). */
const STATUS_RESULT: Readonly<Record<DeviceStatusAction, string>> =
  Object.freeze({
    disable: 'DISABLED',
    reenable: 'ACTIVE',
    deprovision: 'DEPROVISIONED',
  });

/** The template header of one column. */
function columnHeader(key: DeviceEditColumnKey): string {
  return (
    DEVICE_EDIT_TEMPLATE_COLUMNS.find((column) => column.key === key)?.header ??
    key
  );
}

const STATUS_HEADER = columnHeader('status');
const DEVICE_ID_HEADER = columnHeader('deviceId');
const UNIT_HEADER = columnHeader('orgUnitPath');

/** One report line, in the shape of `cc.store_device_import_lines` (design section 6, step 19). */
type ImportLine =
  | {
      kind: 'change';
      sourceRow: number;
      deviceId: string;
      changeType: 'field';
      field: DeviceUpdateField;
      mode: 'replace' | 'clear' | 'move';
      currentValue: string | null;
      newValue: string | null;
    }
  | {
      kind: 'change';
      sourceRow: number;
      deviceId: string;
      changeType: 'status';
      action: DeviceStatusAction;
      reason: string | null;
      currentValue: string | null;
      newValue: string | null;
    }
  | {
      kind: 'rejection';
      sourceRow: number;
      deviceId: string | null;
      column: string | null;
      submittedValue: string | null;
      reason: string;
      templateCells: string[] | null;
    }
  | {
      kind: 'warning';
      sourceRow: number | null;
      deviceId: string | null;
      warning: string;
    };

/** One reason of a rejected row (design section 6, step 17). */
interface RejectionReason {
  column: string | null;
  submittedValue: string | null;
  reason: string;
}

/** One candidate row of the file, after the identity, unit, and access checks of pass 1. */
interface CandidateRow {
  sourceRow: number;
  deviceId: string;
  deviceIdCell: string;
}

/** One candidate row with its file cells, for the compare pass. */
interface CompareRow extends CandidateRow {
  cells: readonly string[];
}

/** The result of pass 1. */
interface Inspection {
  rowsRead: number;
  unchanged: number;
  /** The source rows that the checksum marked unchanged, for the duplicate scan. */
  unchangedRows: Set<number>;
  candidates: CandidateRow[];
  /** Every rejected row and its reasons, keyed by source row. */
  rejected: Map<number, RejectionReason[]>;
  /** The rejected rows whose line a later pass stores, because pass 1 held no cells for them. */
  deferred: Set<number>;
  staleDevicesRead: number;
}

/** One stored device row of the inventory read or the compare read. */
type DeviceRow = Record<string, unknown>;

/** The phase of the job header and its counts (design section 2). */
interface PhaseState {
  phase: 'drive-read' | 'header-check' | 'refresh' | 'compare' | 'report';
  done: number;
  total: number | null;
}

/** One data row of the file, in template order. */
interface FileRow {
  sourceRow: number;
  cells: string[];
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

/** One batch of at most the batch size. */
function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let start = 0; start < items.length; start += size)
    yield items.slice(start, start + size);
}

/** A timestamp cell of a device row as ISO 8601 UTC text, or null. */
function timestampText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const stamp = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(stamp.getTime())) return null;
  return stamp.toISOString();
}

/** The fresh value of one field, as the device row stores it. */
function observedValue(
  row: DeviceRow,
  field: DeviceUpdateField,
): string | null {
  const column = {
    annotatedLocation: 'annotated_location',
    annotatedAssetId: 'asset_tag',
    annotatedUser: 'annotated_user',
    notes: 'notes',
    orgUnitPath: 'org_unit_path',
  }[field];
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

/**
 * The exclusion reason of one fresh Google status (design section 3). It repeats
 * `statusExclusion` of `api/src/app/devices/device-actions.ts`, so the import and the built bulk
 * actions name one reason one way. A null or unrecognized value is `status-unknown`.
 */
function statusExclusionReason(
  action: DeviceStatusAction,
  status: string | null,
): DeviceImportNotRunReason | null {
  if (
    status !== 'ACTIVE' &&
    status !== 'DISABLED' &&
    status !== 'DEPROVISIONED'
  )
    return 'status-unknown';
  if (status === 'DEPROVISIONED') return 'device-deprovisioned';
  // Deprovision accepts an ACTIVE or a DISABLED device (design section 3).
  if (action === 'deprovision') return null;
  if (action === 'reenable')
    return status === 'DISABLED' ? null : 'device-active';
  return status === 'ACTIVE' ? null : 'device-disabled';
}

/** The cells of one record in template order. A missing optional column is empty text. */
function cellsOf(
  record: CsvRecord,
  mapping: ReadonlyMap<DeviceEditColumnKey, number>,
): string[] {
  return DEVICE_EDIT_TEMPLATE_COLUMNS.map((column) => {
    const index = mapping.get(column.key);
    return index === undefined ? '' : (record.cells[index] ?? '');
  });
}

/** The refusal of a CSV fault or of a decode fault. */
function refusalOf(error: unknown): unknown {
  if (error instanceof ImportRefusal) return error;
  if (error instanceof CsvError)
    return new ImportRefusal(error.code, deviceImportRefusalText(error.code));
  return error;
}

/** The refusal of a Drive source that Google refuses to serve (design section 7). */
function driveSourceRefusal(sourceName: string): ImportRefusal {
  return new ImportRefusal(
    'drive-source-unavailable',
    deviceImportRefusalText('drive-source-unavailable', undefined, sourceName),
  );
}

/**
 * The fault of one Drive read, as the refusal or the job failure that ends the run, or null when
 * the fault keeps its built handling. A missing file, a missing tab, and a refused token name the
 * file (design section 7). The client's row and size caps keep their codes and texts. Every other
 * Google failure keeps its code after its retries, because the job header accepts each one
 * (`jobFailureSchema`).
 */
function driveFaultOf(
  error: unknown,
  sourceName: string,
): ImportRefusal | DeviceImportError | null {
  if (error instanceof GoogleDriveError) {
    if (
      error.code === 'drive-file-unavailable' ||
      error.code === 'tab-missing' ||
      error.code === 'not-a-sheet'
    )
      return driveSourceRefusal(sourceName);
    if (
      error.code === 'source-too-large' ||
      error.code === 'rows-too-large' ||
      error.code === 'too-many-rows' ||
      error.code === 'ragged-record'
    )
      return new ImportRefusal(error.code, deviceImportRefusalText(error.code));
    return new DeviceImportError(error.code);
  }
  if (error instanceof GoogleConnectionError) {
    if (
      error.code === 'credential-rejected' ||
      error.code === 'delegation-not-authorized' ||
      error.code === 'scope-mismatch'
    )
      return driveSourceRefusal(sourceName);
    return new DeviceImportError(error.code);
  }
  return null;
}

/**
 * The bytes of one Drive media file, with a transport fault of the body classified as the Google
 * failure it is (design section 7). The client maps a request fault but reads the body outside
 * that mapping, so a reset after a delivered prefix arrives as a raw error. The stage boundary
 * replaces every fault with its own error, so the read must name this one first.
 */
async function* mediaBytes(
  client: DeviceImportDriveClient,
  fileId: string,
): AsyncIterable<Uint8Array> {
  try {
    yield* client.stream(fileId);
  } catch (error) {
    if (
      error instanceof ImportRefusal ||
      error instanceof ImportStop ||
      error instanceof GoogleDriveError ||
      error instanceof GoogleConnectionError
    )
      throw error;
    throw failure(error);
  }
}

/**
 * The report line buffer. A call carries at most 1,000 lines and under 32 MiB of stored JSON, so it
 * closes a batch before the next line would cross either limit (design section 6, step 19).
 */
class ImportLines {
  private readonly send: (
    lines: ImportLine[],
  ) => Promise<'stored' | 'fenced' | 'cancelled'>;
  private closed: ImportLine[][] = [];
  private open: ImportLine[] = [];
  /** The stored size of the open batch: its line text and its jsonb overhead. */
  private bytes = 0;
  /** The lines that the store holds. */
  stored = 0;

  constructor(
    send: (lines: ImportLine[]) => Promise<'stored' | 'fenced' | 'cancelled'>,
  ) {
    this.send = send;
  }

  add(line: ImportLine): void {
    const size =
      Buffer.byteLength(JSON.stringify(line), 'utf8') + LINE_JSONB_OVERHEAD;
    // Close the previous batch before this line joins it, so a legal row of full cells never pushes
    // a call past the cap. One line of ten full cells is 655,360 bytes at most, so one line always
    // fits one call.
    if (
      this.open.length > 0 &&
      (this.open.length >= DEVICE_IMPORT_LINE_BATCH ||
        this.bytes + size + LINE_ARRAY_FRAMING > DEVICE_IMPORT_LINE_BYTES)
    )
      this.close();
    this.open.push(line);
    this.bytes += size;
    if (this.open.length >= DEVICE_IMPORT_LINE_BATCH) this.close();
  }

  /** True when a closed batch waits for its call. */
  get full(): boolean {
    return this.closed.length > 0;
  }

  private close(): void {
    if (this.open.length === 0) return;
    this.closed.push(this.open);
    this.open = [];
    this.bytes = 0;
  }

  /** Store the closed batches in order, then the open one. */
  async flush(): Promise<'stored' | 'fenced' | 'cancelled' | 'empty'> {
    this.close();
    let stored = 0;
    while (this.closed.length > 0) {
      const batch = this.closed[0];
      const answer = await this.send(batch);
      if (answer !== 'stored') {
        // A stopped job keeps no line. Drop the rest, and answer what the job holds.
        this.closed = [];
        this.open = [];
        this.bytes = 0;
        return answer;
      }
      this.closed.shift();
      this.stored += batch.length;
      stored += batch.length;
    }
    return stored === 0 ? 'empty' : 'stored';
  }
}

/**
 * The stop of one run: the worker signal, and the cancel or fence that a tick observed. The reader
 * and the file scan take the combined signal, so an observed cancel stops an unsent provider retry
 * and a pending scan (design section 6, step 1).
 */
class RunControl {
  private readonly controller = new AbortController();
  private readonly worker: AbortSignal;
  /** The worker stop and the job's own stop, composed. */
  readonly signal: AbortSignal;
  private requested = false;
  private lost = false;

  constructor(worker: AbortSignal) {
    this.worker = worker;
    this.signal = AbortSignal.any([worker, this.controller.signal]);
  }

  /** The job's own stop, from a tick that read a stored cancel or a replaced lease. */
  stop(kind: 'cancelled' | 'lost'): void {
    if (kind === 'cancelled') this.requested = true;
    else this.lost = true;
    this.controller.abort();
  }

  /**
   * Why the run must stop now, or null. A stopping worker answers first, because it cannot trust a
   * finish: the recovery ends the job (design section 5). A cancelled job otherwise keeps the
   * Cancelled outcome of the cancel design.
   */
  reason(): StopReason | null {
    if (this.worker.aborted) return { kind: 'stopped' };
    if (this.lost) return { kind: 'fenced' };
    if (this.requested) return { kind: 'cancelled' };
    return null;
  }
}

/**
 * The 30-second tick and the phase writes of one validation run (design section 6). Every write
 * renews the lease, writes the phase, and reads the cancel request. The writes run in one queue, so
 * a tick never lands after a later phase (design section 2).
 */
class ImportProgress {
  private readonly database: DeviceImportDatabase;
  private readonly owner: ImportOwner;
  private readonly timers: SyncTimers;
  private readonly state: PhaseState;
  private readonly run: RunControl;
  private renewals: Promise<unknown> = Promise.resolve();
  private handle: unknown = null;
  private running: Promise<void> | null = null;

  constructor(
    database: DeviceImportDatabase,
    owner: ImportOwner,
    state: PhaseState,
    timers: SyncTimers,
    run: RunControl,
  ) {
    this.database = database;
    this.owner = owner;
    this.state = state;
    this.timers = timers;
    this.run = run;
  }

  /** Write the phase and renew the lease. A stored cancel answers `cancelled`. */
  async write(
    patch: Partial<PhaseState>,
  ): Promise<'renewed' | 'cancelled' | 'lost'> {
    Object.assign(this.state, patch);
    const snapshot: PhaseState = { ...this.state };
    const renewal = this.renewals.then(() => this.renew(snapshot));
    this.renewals = renewal.catch(() => undefined);
    const answer = await renewal;
    if (answer === 'cancelled') this.run.stop('cancelled');
    if (answer === 'lost') this.run.stop('lost');
    return answer;
  }

  /** Write the phase, and stop when the answer or the worker ends the run. */
  async step(patch: Partial<PhaseState>): Promise<void> {
    const answer = await this.write(patch);
    if (answer === 'cancelled') throw new ImportStop({ kind: 'cancelled' });
    if (answer === 'lost') throw new ImportStop({ kind: 'fenced' });
    this.check();
  }

  /** Stop between batches after a cancel, a fence, or a worker stop. */
  check(): void {
    const reason = this.run.reason();
    if (reason !== null) throw new ImportStop(reason);
  }

  private async renew(
    state: PhaseState,
  ): Promise<'renewed' | 'cancelled' | 'lost'> {
    const answer = renewalSchema.parse(
      await callStore(
        this.database,
        'SELECT cc.renew_device_import_job($1,$2,$3,$4,$5,$6,$7) AS result',
        [...this.owner, state.phase, state.done, state.total],
      ),
    );
    if (answer.outcome === 'renewed') return 'renewed';
    return answer.outcome === 'done' ? 'cancelled' : 'lost';
  }

  start(): void {
    // The callback returns the tick, so a fake timer can await it. `setInterval` ignores the value.
    this.handle = this.timers.setInterval(
      () => this.fire(),
      CANCEL_POLL_MILLISECONDS,
    );
  }

  private fire(): Promise<void> {
    this.running ??= this.tick().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async tick(): Promise<void> {
    if (this.run.reason() !== null) return;
    try {
      await this.write({});
    } catch {
      // A failed tick leaves the flags unset. The next tick reads again.
    }
  }

  /** Stop the tick and wait for a tick that already runs. */
  async close(): Promise<void> {
    this.timers.clearInterval(this.handle);
    await this.running;
    await this.renewals;
  }
}

/**
 * The organization unit tree of one run (design section 6, step 13). One read serves the job, and a
 * failed read rejects each unit change. A path compares without case and in NFC, the canonical form
 * of the shared field helper (technical design section 8.2).
 */
class UnitTree {
  private readonly load: () => Promise<readonly DeviceOrgUnitTreeEntry[]>;
  private paths: ReadonlySet<string> | null = null;
  private failed = false;

  constructor(load: () => Promise<readonly DeviceOrgUnitTreeEntry[]>) {
    this.load = load;
  }

  /** The reason of one unit cell, or null when the row may assign it. */
  async reason(cell: string, run: RunControl): Promise<RejectionReason | null> {
    if (deviceEditFieldCellIntent(cell).intent !== 'assign') return null;
    if (this.paths === null && !this.failed) {
      try {
        const units = await this.load();
        this.paths = new Set(
          units.map((unit) =>
            deviceEditCanonicalFieldValue('orgUnitPath', unit.orgUnitPath),
          ),
        );
      } catch {
        // A stop of the run ends it here, not as an unavailable unit check.
        const stop = run.reason();
        if (stop !== null) throw new ImportStop(stop);
        this.failed = true;
      }
    }
    if (this.failed)
      return {
        column: UNIT_HEADER,
        submittedValue: cell,
        reason: DEVICE_IMPORT_REJECTION_TEXTS['org-unit-unavailable'],
      };
    if (
      !(this.paths as ReadonlySet<string>).has(
        deviceEditCanonicalFieldValue('orgUnitPath', cell),
      )
    )
      return {
        column: UNIT_HEADER,
        submittedValue: cell,
        reason: deviceImportUnitRejectionText(cell),
      };
    return null;
  }
}

/** Run one validation job (design section 6). */
export class DeviceImportJobs {
  private readonly database: DeviceImportDatabase;
  private readonly store: DeviceArtifactStore;
  private readonly reader: DeviceImportReader;
  private readonly cipher: DeviceImportCipher;
  private readonly batchSize: number;
  private readonly timers: SyncTimers;
  private readonly drive?: DeviceImportDriveFactory;

  constructor(
    database: DeviceImportDatabase,
    store: DeviceArtifactStore,
    reader: DeviceImportReader,
    cipher: DeviceImportCipher,
    options: DeviceImportOptions = {},
  ) {
    this.database = database;
    this.store = store;
    this.reader = reader;
    this.cipher = cipher;
    this.batchSize = options.batchSize ?? DEVICE_IMPORT_BATCH_SIZE;
    this.timers = options.timers ?? realTimers;
    this.drive = options.drive;
  }

  async run(
    request: DeviceImportRequest,
    signal: AbortSignal,
  ): Promise<DeviceImportAnswer> {
    const input = deviceImportRequestSchema.parse(request);
    const lease: [string, string, string] = [
      input.customerId,
      input.jobId,
      input.leaseId,
    ];
    const claim = claimSchema.parse(
      await callStore(
        this.database,
        'SELECT cc.claim_device_import_job($1,$2,$3) AS result',
        [...lease],
      ),
    );
    if (claim.outcome !== 'claimed') {
      // The claim answers `done` for an ended job and for a running job that holds a stored cancel
      // request. The finish repeats an ended job's stored answer and writes nothing. It ends the
      // stored cancellation, so a retry leaves no running header (design section 5).
      if (claim.outcome === 'done')
        return this.endDone([...lease, claim.attempt], input.failure ?? null);
      return { outcome: claim.outcome };
    }
    const owner: ImportOwner = [...lease, claim.attempt];
    if (input.failure !== undefined)
      return this.end(owner, claim.displayId, { failure: input.failure });
    return this.validate(input, owner, claim, signal);
  }

  /**
   * End a job that the claim answered `done` for. An ended job repeats its stored answer and writes
   * nothing. A job that still runs holds a stored cancel request, and this finish ends it Cancelled
   * under this run's lease. A lapsed or replaced lease answers `fenced` and writes nothing.
   */
  private async endDone(
    owner: ImportOwner,
    failure: string | null,
  ): Promise<DeviceImportAnswer> {
    const answer = await this.finish(owner, null, failure, null);
    return answer.outcome === 'fenced'
      ? { outcome: 'fenced' }
      : { outcome: 'done' };
  }

  /** The finish call of `cc.finish_device_import_job` (design section 6). */
  private async finish(
    owner: ImportOwner,
    counts: DeviceImportCounts | null,
    failure: string | null,
    refusal: { code: string; text: string } | null,
  ): Promise<FinishAnswer> {
    return finishSchema.parse(
      await callStore(
        this.database,
        'SELECT cc.finish_device_import_job($1,$2,$3,$4,$5,$6,$7,$8) AS result',
        [
          ...owner,
          counts === null ? null : JSON.stringify(counts),
          failure,
          refusal?.code ?? null,
          refusal?.text ?? null,
        ],
      ),
    );
  }

  /** End one run and answer what the job header holds. */
  private async end(
    owner: ImportOwner,
    displayId: string,
    options: {
      counts?: DeviceImportCounts;
      failure?: string;
      refusal?: { code: string; text: string };
    },
  ): Promise<DeviceImportAnswer> {
    const counts = options.counts ?? null;
    const failure = options.failure ?? null;
    const refusal = options.refusal ?? null;
    const answer = await this.finish(owner, counts, failure, refusal);
    if (answer.outcome === 'fenced') return { outcome: 'fenced' };
    if (answer.status === 'cancelled')
      return { outcome: 'cancelled', displayId };
    if (answer.status === 'failed')
      return {
        outcome: 'failed',
        displayId,
        failure: failure ?? 'invalid-response',
        refusal: refusal?.code ?? null,
      };
    // A stored completed status holds this run's counts, because the finish wrote them under the
    // header lock (migration 017).
    if (counts === null || answer.status === undefined)
      return { outcome: 'done' };
    return {
      outcome: 'completed',
      displayId,
      status: answer.status,
      counts,
      plan: answer.plan ?? null,
    };
  }

  /** Open the connection credential of the claim (design section 6, step 9). */
  private open(claim: ClaimedImport, customerId: string): DelegatedCredential {
    if (
      claim.envelope === null ||
      claim.envelope === undefined ||
      claim.credentialId === null ||
      claim.generation === null
    )
      throw new DeviceImportError('key-unavailable');
    return this.cipher.open(claim.envelope, {
      recordId: claim.credentialId,
      customerId,
      generation: claim.generation,
    });
  }

  /** Run the two passes of one claimed job (design section 6). */
  private async validate(
    input: DeviceImportRequest,
    owner: ImportOwner,
    claim: ClaimedImport,
    signal: AbortSignal,
  ): Promise<DeviceImportAnswer> {
    const displayId = claim.displayId;
    let artifactId = claim.sourceArtifactId;
    if (artifactId === null && claim.sourceType === 'csv') {
      // The upload stores the file and links it to the job. A missing file is a storage fault
      // (design section 6, the failures table). A Drive source stages its own file in the
      // drive-read phase (design section 7, step 1).
      return this.end(owner, displayId, { failure: 'storage-unavailable' });
    }
    let credential: DelegatedCredential;
    try {
      credential = this.open(claim, input.customerId);
    } catch {
      return this.end(owner, displayId, { failure: 'key-unavailable' });
    }

    const run = new RunControl(signal);
    const progress = new ImportProgress(
      this.database,
      owner,
      {
        phase: artifactId === null ? 'drive-read' : 'header-check',
        done: 0,
        total: null,
      },
      this.timers,
      run,
    );
    const lines = new ImportLines((batch) => this.storeLines(owner, batch));
    progress.start();
    try {
      // A Drive source with no stored artifact reads Drive first. The stored source then runs the
      // built passes unchanged, and a revalidation reads no Drive file (design section 7).
      if (artifactId === null) {
        artifactId = await this.driveSource(
          owner,
          claim,
          credential,
          progress,
          run,
        );
        await progress.step({ phase: 'header-check', done: 0, total: null });
      }
      const inspection = await this.inspect(
        input,
        claim,
        credential,
        artifactId,
        progress,
        lines,
        run,
      );
      const counts = await this.compare(
        input,
        claim,
        inspection,
        artifactId,
        progress,
        lines,
        run,
      );
      const flushed = await lines.flush();
      if (flushed === 'fenced') return { outcome: 'fenced' };
      if (flushed === 'cancelled') return this.end(owner, displayId, {});
      await progress.step({
        phase: 'report',
        done: lines.stored,
        total: lines.stored,
      });
      return await this.end(owner, displayId, { counts });
    } catch (error) {
      if (error instanceof ImportRefusal)
        return this.end(owner, displayId, {
          failure: 'invalid-response',
          refusal: { code: error.code, text: error.text },
        });
      if (error instanceof ImportStop) {
        if (error.reason.kind === 'stopped') return { outcome: 'stopped' };
        if (error.reason.kind === 'fenced') return { outcome: 'fenced' };
        return this.end(owner, displayId, {});
      }
      // A storage fault fails the job. A lost worker writes nothing.
      if (signal.aborted) return { outcome: 'stopped' };
      // A storage fault fails the job with `storage-unavailable`. A code that the job header
      // accepts is stored as it is (design section 6, the failures table).
      if (
        error instanceof DeviceSyncError &&
        jobFailureSchema.safeParse(error.code).success
      )
        return this.end(owner, displayId, { failure: error.code });
      return this.end(owner, displayId, { failure: 'storage-unavailable' });
    } finally {
      await progress.close();
    }
  }

  /** Store one batch of lines under the lease and attempt (design section 6, step 19). */
  private async storeLines(
    owner: ImportOwner,
    lines: readonly ImportLine[],
  ): Promise<'stored' | 'fenced' | 'cancelled'> {
    const answer = storedLinesSchema.parse(
      await callStore(
        this.database,
        'SELECT cc.store_device_import_lines($1,$2,$3,$4,$5) AS result',
        [...owner, JSON.stringify(lines)],
      ),
    );
    if (answer.outcome === 'stored') return 'stored';
    return answer.outcome === 'fenced' ? 'fenced' : 'cancelled';
  }

  /** Store a closed batch now, and stop when the job ended (design section 6, step 19). */
  private async flushLines(lines: ImportLines): Promise<void> {
    if (!lines.full) return;
    const answer = await lines.flush();
    if (answer === 'fenced') throw new ImportStop({ kind: 'fenced' });
    if (answer === 'cancelled') throw new ImportStop({ kind: 'cancelled' });
  }

  /**
   * Link the staged Drive source to the job under the lease and record its size (design section
   * 7, step 7). The store answers no `stored` when the lease lapsed or the job ended.
   */
  private async storeSource(
    owner: ImportOwner,
    artifactId: string,
    sizeBytes: number,
  ): Promise<'stored' | 'fenced' | 'done'> {
    const answer = sourceStoreSchema.parse(
      await callStore(
        this.database,
        'SELECT cc.store_device_import_source($1,$2,$3,$4,$5,$6) AS result',
        [...owner, artifactId, sizeBytes],
      ),
    );
    return answer.outcome;
  }

  /** Remove a stage that the job does not reference. The store keeps a referenced file. */
  private async discard(descriptor: DeviceExportDescriptor): Promise<void> {
    await this.store.remove(descriptor).catch(() => undefined);
  }

  /**
   * Stream the stored file (design section 6, step 2). The decoder is fatal, so a file that is not
   * UTF-8 refuses before any row check. Each record answers its cells in template order, with the
   * spreadsheet row of the record. The first pass stores the header warnings, and the second pass
   * repeats none of them.
   */
  private async *records(
    artifactId: string,
    mode: DeviceImportMode,
    lines: ImportLines,
    warnings: boolean,
    run: RunControl,
  ): AsyncGenerator<FileRow, void, void> {
    let source: AsyncIterable<Uint8Array>;
    try {
      source = await this.store.openRead(artifactId);
    } catch {
      throw new DeviceImportError('storage-unavailable');
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const reader = createCsvReader();
    let mapping: Map<DeviceEditColumnKey, number> | null = null;
    const out: FileRow[] = [];

    const decode = (chunk: Uint8Array | undefined): string => {
      try {
        return chunk === undefined
          ? decoder.decode()
          : decoder.decode(chunk, { stream: true });
      } catch {
        throw new ImportRefusal(
          'unreadable-file',
          deviceImportRefusalText('unreadable-file'),
        );
      }
    };
    const feed = (records: readonly CsvRecord[]): void => {
      for (const record of records) {
        if (mapping === null) {
          const match = matchDeviceEditHeaders(record.cells, mode);
          if (!match.ok)
            throw new ImportRefusal(
              'header-refused',
              deviceImportRefusalText('header-refused', match.reason),
            );
          mapping = new Map(
            match.match.columns.map((column) => [column.key, column.index]),
          );
          if (warnings)
            for (const warning of match.match.warnings)
              lines.add({
                kind: 'warning',
                sourceRow: null,
                deviceId: null,
                warning,
              });
          continue;
        }
        // The spreadsheet row of the record (technical design, "Source row number"). The reader
        // numbers every logical record, so the header is row 1 and a dropped blank record still
        // holds its row. The physical line would drift on a record that spans lines.
        out.push({ sourceRow: record.row, cells: cellsOf(record, mapping) });
      }
    };

    for await (const chunk of source) {
      const reason = run.reason();
      if (reason !== null) throw new ImportStop(reason);
      let records: CsvRecord[];
      try {
        records = reader.push(decode(chunk));
      } catch (error) {
        throw refusalOf(error);
      }
      feed(records);
      while (out.length > 0) {
        // A cancel stops the scan between rows, not only between chunks (design section 6, the
        // cancel rule of section 5).
        const stopped = run.reason();
        if (stopped !== null) throw new ImportStop(stopped);
        yield out.shift() as FileRow;
      }
    }
    // The end of the file answers its last record, and a trailing partial sequence is a fault.
    try {
      const tail = decode(undefined);
      feed([...reader.push(tail), ...reader.end()]);
    } catch (error) {
      throw refusalOf(error);
    }
    while (out.length > 0) {
      const reason = run.reason();
      if (reason !== null) throw new ImportStop(reason);
      yield out.shift() as FileRow;
    }
    if (mapping === null)
      throw new ImportRefusal(
        'header-refused',
        deviceImportRefusalText(
          'header-refused',
          DEVICE_IMPORT_MISSING_HEADER_TEXT,
        ),
      );
  }

  /**
   * Read a Drive source into a CSV stage (design section 7, steps 2 to 7). A Sheet writes its
   * padded rows through the CSV writer, and a CSV file streams its own bytes. The stage is
   * published and linked to the job under the lease, and the built passes then read it like an
   * uploaded file.
   */
  private async driveSource(
    owner: ImportOwner,
    claim: ClaimedImport,
    credential: DelegatedCredential,
    progress: ImportProgress,
    run: RunControl,
  ): Promise<string> {
    // The read is the phase from its first moment, so a failure before the first batch names
    // the Drive read in the stored job row (design section 2).
    await progress.step({ phase: 'drive-read', done: 0, total: null });
    const fileId = claim.sourceFileId;
    const tabId = claim.sourceTabId;
    const subject = claim.driveSubject;
    const sourceName = claim.sourceName;
    const sheet = claim.sourceType === 'drive-sheet';
    if (
      this.drive === undefined ||
      fileId === null ||
      subject === null ||
      (sheet && tabId === null)
    )
      // The submission stored the file, the tab, and the subject of every Drive job (design
      // section 1), so a claim that misses one cannot read its source.
      throw new DeviceImportError('drive-unavailable');
    let client: DeviceImportDriveClient;
    try {
      client = await this.drive(credential, subject, run.signal);
    } catch (error) {
      // A stop of the run ends it here. A refused token refuses the source (design section 7).
      const stop = run.reason();
      if (stop !== null) throw new ImportStop(stop);
      const fault = driveFaultOf(error, sourceName);
      if (fault !== null) throw fault;
      throw error;
    }

    const batchSize = this.batchSize;
    const writer = createCsvWriter();
    /** The data rows that the phase counts (design section 7, step 6). */
    let dataRows = 0;
    let reported = 0;
    /** Whether the first nonblank row, the header, has arrived. A blank row counts no data row. */
    let headerSeen = false;
    const count = async (): Promise<void> => {
      if (dataRows - reported < batchSize) return;
      reported = dataRows;
      await progress.step({ phase: 'drive-read', done: dataRows, total: null });
    };

    /** The bytes of the source, before the stage boundary can replace their fault. */
    const produce = async function* (): AsyncIterable<Buffer> {
      if (sheet) {
        // The stage of a Sheet is a generated CSV file, so it carries the byte order mark of an
        // export. A Drive CSV file streams its own bytes, which keep their own mark (step 5).
        yield Buffer.from(writer.start(), 'utf8');
        const tab = await client.readTab(fileId, tabId as number);
        for await (const row of tab.rows()) {
          const stop = run.reason();
          if (stop !== null) throw new ImportStop(stop);
          const text = writer.row(row);
          // A stage of more than 1 GiB of text refuses (design section 7, the limits).
          if (writer.bytes > GOOGLE_DRIVE_SOURCE_BYTES)
            throw new ImportRefusal(
              'source-too-large',
              deviceImportRefusalText('source-too-large'),
            );
          yield Buffer.from(text, 'utf8');
          // The first nonblank row is the header. A blank gap row keeps its source position and
          // counts none, as the client counts it (design section 7, steps 3 and 6).
          if (row.every((cell) => cell.trim() === '')) continue;
          if (!headerSeen) {
            headerSeen = true;
            continue;
          }
          dataRows += 1;
          // The tab refuses data row 50,001 (design section 7, the limits). The client refuses
          // it first; this count keeps the same answer for a tab that another reader serves.
          if (dataRows > DEVICE_IMPORT_ROW_LIMIT)
            throw new ImportRefusal(
              'too-many-rows',
              deviceImportRefusalText('too-many-rows'),
            );
          await count();
        }
        return;
      }
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const reader = createCsvReader();
      let bytes = 0;
      /** The records of the file, the header included. The reader drops a blank record. */
      let recordsRead = 0;
      const decode = (chunk: Uint8Array | undefined): string => {
        try {
          return chunk === undefined
            ? decoder.decode()
            : decoder.decode(chunk, { stream: true });
        } catch {
          throw new ImportRefusal(
            'unreadable-file',
            deviceImportRefusalText('unreadable-file'),
          );
        }
      };
      const tally = (records: readonly CsvRecord[]): void => {
        for (let index = 0; index < records.length; index += 1) {
          recordsRead += 1;
          if (recordsRead > 1) {
            dataRows += 1;
            // The read refuses data row 50,001, as the tab read does (design section 7, the
            // limits). The built passes hold the same cap for an uploaded file.
            if (dataRows > DEVICE_IMPORT_ROW_LIMIT)
              throw new ImportRefusal(
                'too-many-rows',
                deviceImportRefusalText('too-many-rows'),
              );
          }
        }
      };
      for await (const chunk of mediaBytes(client, fileId)) {
        const stop = run.reason();
        if (stop !== null) throw new ImportStop(stop);
        // The media stream passes 1 GiB of stored text (design section 7, step 5).
        bytes += chunk.byteLength;
        if (bytes > GOOGLE_DRIVE_SOURCE_BYTES)
          throw new ImportRefusal(
            'source-too-large',
            deviceImportRefusalText('source-too-large'),
          );
        let records: CsvRecord[];
        try {
          // The reader counts the records of the stream on the way (design section 7, step 5).
          records = reader.push(decode(chunk));
        } catch (error) {
          throw refusalOf(error);
        }
        tally(records);
        yield Buffer.from(chunk);
        await count();
      }
      // The end of the file answers its last record, and a trailing partial sequence is a fault.
      try {
        tally([...reader.push(decode(undefined)), ...reader.end()]);
      } catch (error) {
        throw refusalOf(error);
      }
    };

    /**
     * The fault that the source raised, kept before the stage boundary. `createArtifactStore`
     * replaces every stage fault with one error, including a fault of the supplied iterator
     * (`deployment/storage/index.mjs`), so the read keeps the source outcome here.
     */
    let sourceFault: unknown = null;
    const source = async function* (): AsyncIterable<Buffer> {
      try {
        yield* produce();
      } catch (error) {
        sourceFault = error;
        throw error;
      }
    };

    let descriptor: DeviceExportDescriptor;
    try {
      descriptor = await this.store.stageStream(
        {
          schemaVersion: DEVICE_IMPORT_SOURCE_SCHEMA_VERSION,
          maxBytes: GOOGLE_DRIVE_SOURCE_BYTES,
        },
        source(),
      );
    } catch (error) {
      // The production store hides every stage fault, so the outcome that the iterator kept
      // decides the refusal or the job failure. A stage with no source fault is a storage fault.
      if (sourceFault !== null) {
        const fault = driveFaultOf(sourceFault, sourceName);
        throw fault ?? sourceFault;
      }
      const fault = driveFaultOf(error, sourceName);
      if (fault !== null) throw fault;
      throw error;
    }

    let published = false;
    try {
      // The phase counts the data rows that the stage holds (design section 7, step 6). The write
      // renews the lease after the long read.
      reported = dataRows;
      await progress.step({ phase: 'drive-read', done: dataRows, total: null });
      await this.store.publish(descriptor);
      published = true;
      const stored = await this.storeSource(
        owner,
        descriptor.artifactId,
        descriptor.sizeBytes,
      );
      if (stored === 'stored') return descriptor.artifactId;
      // The job ended or a newer attempt owns it, so this stage stays unlinked.
      await this.discard(descriptor);
      throw new ImportStop(
        stored === 'fenced' ? { kind: 'fenced' } : { kind: 'cancelled' },
      );
    } catch (error) {
      // A stage that no job references leaves no file (design section 7, step 7).
      if (!published) await this.discard(descriptor);
      throw error;
    }
  }

  /** Pass 1 of design section 6: the checks, the lookup, the refresh, the units, and the access. */
  private async inspect(
    input: DeviceImportRequest,
    claim: ClaimedImport,
    credential: DelegatedCredential,
    artifactId: string,
    progress: ImportProgress,
    lines: ImportLines,
    run: RunControl,
  ): Promise<Inspection> {
    const inspection: Inspection = {
      rowsRead: 0,
      unchanged: 0,
      unchangedRows: new Set<number>(),
      candidates: [],
      rejected: new Map<number, RejectionReason[]>(),
      deferred: new Set<number>(),
      staleDevicesRead: 0,
    };
    /** The source rows of each well-formed Device ID, in file order (design section 6, step 5). */
    const occurrences = new Map<string, number[]>();
    const units = new UnitTree(() =>
      this.reader.readOrgUnitTree(credential, input.customerId, run.signal),
    );

    for await (const row of this.records(
      artifactId,
      claim.mode,
      lines,
      true,
      run,
    )) {
      const { sourceRow, cells } = row;
      inspection.rowsRead += 1;
      if (inspection.rowsRead > DEVICE_IMPORT_ROW_LIMIT)
        throw new ImportRefusal(
          'too-many-rows',
          deviceImportRefusalText('too-many-rows'),
        );
      if (inspection.rowsRead % this.batchSize === 0)
        await progress.step({
          phase: 'header-check',
          done: inspection.rowsRead,
          total: null,
        });
      // Store a closed batch now, so a file of rejected rows never holds every line in memory
      // (design section 6, step 19).
      await this.flushLines(lines);

      const deviceIdCell = deviceEditUnescapeCell(cells[DEVICE_ID_COLUMN]);
      const identity =
        deviceIdCell !== '' && PLAIN_DEVICE_ID.test(deviceIdCell);
      if (identity) {
        const rows = occurrences.get(deviceIdCell);
        if (rows === undefined) occurrences.set(deviceIdCell, [sourceRow]);
        else rows.push(sourceRow);
      }

      // The unchanged partition of `td:8.3`. Only Sync changes reads the row checksum, and only a
      // row with a device identity holds one. An unchanged row requests nothing, so the duplicate
      // scan below is the one check that can still reject it.
      if (identity && claim.mode === 'sync-changes') {
        const checksumCell = deviceEditUnescapeCell(
          cells[CHECKSUM_COLUMN],
        ).trim();
        if (
          checksumCell !== '' &&
          !deviceEditChecksumIsWellFormed(checksumCell)
        ) {
          lines.add({
            kind: 'warning',
            sourceRow,
            deviceId: deviceIdCell,
            warning: DEVICE_IMPORT_MALFORMED_CHECKSUM_WARNING,
          });
        } else if (
          checksumCell !== '' &&
          (await this.rowChecksum(cells)) === checksumCell
        ) {
          inspection.unchanged += 1;
          inspection.unchangedRows.add(sourceRow);
          continue;
        }
      }

      // Every check that the row's own cells decide keeps its reason, and one rejected row counts
      // once (design section 6, step 17).
      const reasons = await this.cellReasons(row, claim, units, run);
      if (reasons.length > 0) {
        this.reject(
          inspection,
          lines,
          sourceRow,
          cells,
          deviceIdCell,
          true,
          reasons,
        );
        continue;
      }
      inspection.candidates.push({
        sourceRow,
        deviceId: deviceIdCell,
        deviceIdCell,
      });
    }
    await progress.step({
      phase: 'header-check',
      done: inspection.rowsRead,
      total: null,
    });

    // Every occurrence of a duplicated Device ID rejects (design section 6, step 5). The first
    // occurrence cannot be judged before the last one is read, so the scan runs here.
    this.rejectDuplicates(inspection, lines, occurrences);
    await this.flushLines(lines);

    // The inventory lookup of design section 6, step 7. An unknown or removed ID rejects its row,
    // and the compare pass writes that line because pass 1 holds no cells for it.
    const stored = new Map<
      string,
      { removed: boolean; syncedAt: string | null }
    >();
    for (const batch of chunks(
      [...new Set(inspection.candidates.map((row) => row.deviceId))],
      this.batchSize,
    )) {
      const rows = await this.lookup(
        `SELECT device_id,removed_at,last_entity_sync FROM cc.devices
          WHERE customer_id=$1 AND device_id=ANY($2::text[])`,
        [input.customerId, batch],
      );
      for (const row of rows)
        stored.set(String(row['device_id']), {
          removed:
            row['removed_at'] !== null && row['removed_at'] !== undefined,
          syncedAt: timestampText(row['last_entity_sync']),
        });
      progress.check();
    }
    for (const candidate of inspection.candidates) {
      const device = stored.get(candidate.deviceId);
      if (device === undefined || device.removed)
        this.defer(inspection, candidate.sourceRow, [
          {
            column: DEVICE_ID_HEADER,
            submittedValue: candidate.deviceIdCell,
            reason:
              DEVICE_IMPORT_REJECTION_TEXTS[
                device === undefined ? 'device-unknown' : 'device-removed'
              ],
          },
        ]);
    }

    // The refresh of design section 6, steps 8 to 12. Only stale candidate devices get a read.
    const cutoff = freshnessCutoff('device').getTime();
    const stale = inspection.candidates
      .filter((row) => !inspection.rejected.has(row.sourceRow))
      .filter((row) => {
        const syncedAt = stored.get(row.deviceId)?.syncedAt ?? null;
        return syncedAt === null || Date.parse(syncedAt) < cutoff;
      });
    const staleIds = [...new Set(stale.map((row) => row.deviceId))];
    await progress.step({
      phase: 'refresh',
      done: 0,
      total: staleIds.length,
    });
    for (const batch of chunks(staleIds, this.batchSize)) {
      // Postgres stamps the read time before the Google call (design section 6, step 9).
      const syncedAt = await this.stamp();
      let states: DeviceState[] | null;
      try {
        states = await this.reader.deviceStates(
          credential,
          input.customerId,
          batch,
          run.signal,
        );
      } catch (error) {
        // A stop of the run ends it here. A token failure answers the whole call: the rows of this
        // batch reject, and later batches continue (design section 6, step 12).
        const reason = run.reason();
        if (reason !== null) throw new ImportStop(reason);
        states = null;
      }
      if (states === null) {
        this.rejectDevices(inspection, batch, 'current-values-unavailable');
      } else {
        const found = states.flatMap((state) =>
          state.status === 'found' ? [state.device] : [],
        );
        const missing = states.flatMap((state) =>
          state.status === 'missing' ? [state.deviceId] : [],
        );
        const failed = states.flatMap((state) =>
          state.status === 'failed' ? [state.deviceId] : [],
        );
        await this.storeRefresh(input.customerId, syncedAt, found, missing);
        // A failed device rejects only its own rows, and its stored values stay
        // (design section 6, step 11).
        this.rejectDevices(inspection, failed, 'current-values-unavailable');
        this.rejectDevices(inspection, missing, 'device-removed');
      }
      inspection.staleDevicesRead += batch.length;
      await progress.step({
        phase: 'refresh',
        done: inspection.staleDevicesRead,
        total: staleIds.length,
      });
    }
    return inspection;
  }

  /** The fresh device values and the compare pass (design section 6, steps 15 to 18). */
  private async compare(
    input: DeviceImportRequest,
    claim: ClaimedImport,
    inspection: Inspection,
    artifactId: string,
    progress: ImportProgress,
    lines: ImportLines,
    run: RunControl,
  ): Promise<DeviceImportCounts> {
    const compared = inspection.candidates.filter(
      (row) => !inspection.deferred.has(row.sourceRow),
    );
    const byRow = new Map(compared.map((row) => [row.sourceRow, row]));
    let done = 0;
    let proposed = 0;
    let noChangeNeeded = 0;
    let oldest: string | null = null;
    let batch: CompareRow[] = [];

    const flushBatch = async (): Promise<void> => {
      if (batch.length === 0) return;
      const current = batch;
      batch = [];
      const rows = await this.rows(
        `SELECT device_id,status,asset_tag,annotated_location,annotated_user,notes,
          org_unit_path,last_entity_sync,removed_at FROM cc.devices
          WHERE customer_id=$1 AND device_id=ANY($2::text[])`,
        [input.customerId, [...new Set(current.map((row) => row.deviceId))]],
      );
      const byId = new Map(rows.map((row) => [String(row['device_id']), row]));
      const outcomes = current.map((row) => {
        const stored = byId.get(row.deviceId);
        const removed =
          stored === undefined ||
          (stored['removed_at'] !== null && stored['removed_at'] !== undefined);
        return {
          row,
          stored,
          outcome: removed ? null : this.compareRow(row, stored),
        };
      });
      // The duplicate Asset tag warning reads the fresh tags of the same batch (step 18).
      const tags = outcomes.flatMap(({ outcome }) =>
        (outcome?.lines ?? []).flatMap((line) =>
          line.kind === 'change' &&
          line.changeType === 'field' &&
          line.field === 'annotatedAssetId' &&
          line.newValue !== null
            ? [line.newValue]
            : [],
        ),
      );
      const holders =
        tags.length === 0
          ? new Map<string, string[]>()
          : await this.tagHolders(input.customerId, tags);
      for (const { row, stored, outcome } of outcomes) {
        if (outcome === null || stored === undefined) {
          // The device left the inventory after the refresh read.
          this.reject(
            inspection,
            lines,
            row.sourceRow,
            row.cells,
            row.deviceIdCell,
            true,
            [
              {
                column: DEVICE_ID_HEADER,
                submittedValue: row.deviceIdCell,
                reason: DEVICE_IMPORT_REJECTION_TEXTS['device-removed'],
              },
            ],
          );
          await this.flushLines(lines);
          continue;
        }
        const syncedAt = timestampText(stored['last_entity_sync']);
        if (syncedAt !== null && (oldest === null || syncedAt < oldest))
          oldest = syncedAt;
        if (outcome.reasons.length > 0) {
          this.reject(
            inspection,
            lines,
            row.sourceRow,
            row.cells,
            row.deviceIdCell,
            true,
            outcome.reasons,
          );
          await this.flushLines(lines);
          continue;
        }
        for (const line of outcome.lines) lines.add(line);
        // A tag that another device holds warns, and the change still runs (design section 6).
        const changedTags = outcome.lines.flatMap((line) =>
          line.kind === 'change' &&
          line.changeType === 'field' &&
          line.field === 'annotatedAssetId' &&
          line.newValue !== null
            ? [line.newValue]
            : [],
        );
        for (const tag of changedTags)
          if (
            (holders.get(tag) ?? []).some(
              (deviceId) => deviceId !== row.deviceId,
            )
          )
            lines.add({
              kind: 'warning',
              sourceRow: row.sourceRow,
              deviceId: row.deviceId,
              warning: deviceImportDuplicateTagWarning(tag),
            });
        // A row that proposes a change counts as proposed. A row that only warns needs no change.
        if (outcome.lines.some((line) => line.kind === 'change')) proposed += 1;
        else noChangeNeeded += 1;
        await this.flushLines(lines);
      }
      done += current.length;
      await progress.step({
        phase: 'compare',
        done,
        total: compared.length,
      });
    };

    await progress.step({
      phase: 'compare',
      done: 0,
      total: compared.length,
    });
    for await (const row of this.records(
      artifactId,
      claim.mode,
      lines,
      false,
      run,
    )) {
      const candidate = byRow.get(row.sourceRow);
      if (candidate !== undefined) {
        batch.push({ ...candidate, cells: row.cells });
        if (batch.length >= this.batchSize) await flushBatch();
        continue;
      }
      // A row that pass 1 deferred a rejection for gets its line here, where its cells are. The
      // buffer closes on this path too, so a file of rejected rows never holds the whole report.
      if (inspection.deferred.has(row.sourceRow)) {
        this.writeDeferred(inspection, lines, row);
        await this.flushLines(lines);
      }
    }
    await flushBatch();
    return {
      rows: inspection.rowsRead,
      unchanged: inspection.unchanged,
      noChangeNeeded,
      proposed,
      rejected: inspection.rejected.size,
      candidateRows: inspection.rowsRead - inspection.unchanged,
      staleDevicesRead: inspection.staleDevicesRead,
      oldestObservedAt: oldest,
    };
  }

  /**
   * The reasons of one row, from every check that its own cells decide: the identity, the unit
   * membership, the status permission, and each field and status cell (design section 6, steps 5,
   * 13, 14, 16 and 17). One invalid cell never hides another, so the row keeps every reason.
   */
  private async cellReasons(
    row: FileRow,
    claim: ClaimedImport,
    units: UnitTree,
    run: RunControl,
  ): Promise<RejectionReason[]> {
    const { cells } = row;
    const reasons: RejectionReason[] = [];
    const deviceIdCell = deviceEditUnescapeCell(cells[DEVICE_ID_COLUMN]);
    if (deviceIdCell === '')
      reasons.push({
        column: DEVICE_ID_HEADER,
        submittedValue: null,
        reason: DEVICE_IMPORT_REJECTION_TEXTS['device-id-missing'],
      });
    else if (!PLAIN_DEVICE_ID.test(deviceIdCell))
      reasons.push({
        column: DEVICE_ID_HEADER,
        submittedValue: deviceIdCell,
        reason: DEVICE_IMPORT_REJECTION_TEXTS['device-id-malformed'],
      });

    const unitReason = await units.reason(
      deviceEditUnescapeCell(cells[ORG_UNIT_COLUMN]),
      run,
    );
    if (unitReason !== null) reasons.push(unitReason);

    const statusCell = deviceEditUnescapeCell(cells[STATUS_COLUMN]);
    const intent = deviceEditStatusCellIntent(statusCell);
    if (!intent.ok)
      reasons.push({
        column: STATUS_HEADER,
        submittedValue: statusCell,
        reason: intent.reason,
      });
    else if (
      intent.intent.intent !== 'none' &&
      !claim.statusPermissions.includes(intent.intent.intent)
    )
      reasons.push({
        column: STATUS_HEADER,
        submittedValue: statusCell,
        reason: deviceImportPermissionRejectionText(intent.intent.intent),
      });

    for (const column of FIELD_COLUMNS) {
      const cell = deviceEditUnescapeCell(cells[column.column]);
      const answer = deviceEditFieldChange(column.field, cell);
      if (!answer.ok)
        reasons.push({
          column: column.header,
          submittedValue: cell,
          reason: answer.reason,
        });
    }
    return reasons;
  }

  /**
   * Reject every occurrence of a duplicated Device ID (design section 6, step 5). A row that pass 1
   * already rejected keeps its reasons and gains this one. Every other occurrence defers its line to
   * the compare pass, which holds its cells. No occurrence reaches the plan.
   */
  private rejectDuplicates(
    inspection: Inspection,
    lines: ImportLines,
    occurrences: ReadonlyMap<string, number[]>,
  ): void {
    for (const [deviceId, sourceRows] of occurrences) {
      if (sourceRows.length < 2) continue;
      const reason: RejectionReason = {
        column: DEVICE_ID_HEADER,
        submittedValue: deviceId,
        reason: DEVICE_IMPORT_REJECTION_TEXTS['device-id-duplicate'],
      };
      for (const sourceRow of sourceRows) {
        const reasons = inspection.rejected.get(sourceRow);
        if (reasons !== undefined) {
          reasons.push(reason);
          // The first line of the row already carries its cells, so this reason needs none.
          lines.add({
            kind: 'rejection',
            sourceRow,
            deviceId,
            column: reason.column,
            submittedValue: reason.submittedValue,
            reason: reason.reason,
            templateCells: null,
          });
          continue;
        }
        if (inspection.unchangedRows.delete(sourceRow))
          inspection.unchanged -= 1;
        this.defer(inspection, sourceRow, [reason]);
      }
    }
    // A candidate that this scan rejected never reaches the compare pass.
    inspection.candidates = inspection.candidates.filter(
      (row) => !inspection.deferred.has(row.sourceRow),
    );
  }

  /** The changes and the reasons of one candidate row (design section 6, steps 15 to 18). */
  private compareRow(
    row: CompareRow,
    stored: DeviceRow,
  ): { lines: ImportLine[]; reasons: RejectionReason[] } {
    const lines: ImportLine[] = [];
    const reasons: RejectionReason[] = [];
    const cellOf = (column: number) =>
      deviceEditUnescapeCell(row.cells[column]);

    for (const column of FIELD_COLUMNS) {
      const cell = cellOf(column.column);
      const answer = deviceEditFieldChange(column.field, cell);
      if (!answer.ok) {
        reasons.push({
          column: column.header,
          submittedValue: cell,
          reason: answer.reason,
        });
        continue;
      }
      if (answer.change === null) continue;
      const fresh = observedValue(stored, column.field);
      if (answer.change.mode === 'clear') {
        if (deviceEditCanonicalFieldValue(column.field, fresh) === '') continue;
        lines.push({
          kind: 'change',
          sourceRow: row.sourceRow,
          deviceId: row.deviceId,
          changeType: 'field',
          field: column.field,
          mode: 'clear',
          currentValue: fresh,
          newValue: null,
        });
        continue;
      }
      const value = answer.change.value ?? '';
      // A path compares without case, and every value is NFC (design section 6, step 17).
      if (
        deviceEditCanonicalFieldValue(column.field, value) ===
        deviceEditCanonicalFieldValue(column.field, fresh)
      )
        continue;
      lines.push({
        kind: 'change',
        sourceRow: row.sourceRow,
        deviceId: row.deviceId,
        changeType: 'field',
        field: column.field,
        mode: answer.change.mode,
        currentValue: fresh,
        newValue: value,
      });
    }

    const statusCell = cellOf(STATUS_COLUMN);
    const freshStatus =
      typeof stored['status'] === 'string' ? stored['status'] : null;
    const intent = deviceEditStatusCellIntent(statusCell);
    if (!intent.ok) {
      reasons.push({
        column: STATUS_HEADER,
        submittedValue: statusCell,
        reason: intent.reason,
      });
      return { lines, reasons };
    }
    if (intent.intent.intent === 'none') {
      // An export-only value requests nothing. It warns when it differs from the fresh status
      // (design section 6, step 18).
      const value = intent.intent.status;
      if (
        value !== null &&
        freshStatus !== null &&
        value !== deviceEditCanonicalStatusCell(freshStatus)
      )
        lines.push({
          kind: 'warning',
          sourceRow: row.sourceRow,
          deviceId: row.deviceId,
          warning: deviceImportExportOnlyStatusWarning(statusCell, freshStatus),
        });
      return { lines, reasons };
    }
    const action = intent.intent.intent;
    // A status code whose result already holds needs no change (design section 6, step 17).
    if (freshStatus === STATUS_RESULT[action]) return { lines, reasons };
    const exclusion = statusExclusionReason(action, freshStatus);
    if (exclusion !== null) {
      // An ineligible status code rejects the row, and the reason names the excluded state.
      reasons.push({
        column: STATUS_HEADER,
        submittedValue: statusCell,
        reason: DEVICE_IMPORT_NOT_RUN_TEXTS[exclusion],
      });
      return { lines, reasons };
    }
    lines.push({
      kind: 'change',
      sourceRow: row.sourceRow,
      deviceId: row.deviceId,
      changeType: 'status',
      action,
      reason:
        intent.intent.intent === 'deprovision' ? intent.intent.reason : null,
      currentValue: freshStatus,
      newValue: STATUS_RESULT[action],
    });
    return { lines, reasons };
  }

  /** The devices that hold each of these asset tags (design section 6, step 18). */
  private async tagHolders(
    customerId: string,
    tags: readonly string[],
  ): Promise<Map<string, string[]>> {
    const rows = await this.rows(
      `SELECT device_id,asset_tag FROM cc.devices
        WHERE customer_id=$1 AND asset_tag=ANY($2::text[])`,
      [customerId, [...new Set(tags)]],
    );
    const holders = new Map<string, string[]>();
    for (const row of rows) {
      const tag = row['asset_tag'];
      if (typeof tag !== 'string') continue;
      const ids = holders.get(tag) ?? [];
      ids.push(String(row['device_id']));
      holders.set(tag, ids);
    }
    return holders;
  }

  /** The checksum of one row of the file (design section 8.1). */
  private rowChecksum(cells: readonly string[]): Promise<string> {
    const cell = (column: number) => deviceEditUnescapeCell(cells[column]);
    return deviceEditRowChecksum({
      deviceId: cell(DEVICE_ID_COLUMN),
      status: cell(STATUS_COLUMN),
      annotatedAssetId: cell(ASSET_TAG_COLUMN),
      annotatedLocation: cell(columnIndex('annotatedLocation')),
      annotatedUser: cell(columnIndex('annotatedUser')),
      notes: cell(columnIndex('notes')),
      orgUnitPath: cell(ORG_UNIT_COLUMN),
    });
  }

  /** Postgres stamps the read time before the Google call (design section 6, step 9). */
  private async stamp(): Promise<string> {
    const clock = await callStore(
      this.database,
      'SELECT clock_timestamp() AS result',
      [],
    );
    const stamp = new Date(
      clock instanceof Date || typeof clock === 'string' ? clock : Number.NaN,
    );
    if (Number.isNaN(stamp.getTime()))
      throw new DeviceImportError('store-unavailable');
    return stamp.toISOString();
  }

  /** The rows of one query. A failed call keeps its lease code, or reports a store failure. */
  private async rows(sql: string, values: unknown[]): Promise<DeviceRow[]> {
    try {
      return (await this.database.query(sql, values)).rows;
    } catch (error) {
      if (error instanceof DeviceSyncError) throw error;
      throw new DeviceImportError('store-unavailable');
    }
  }

  /** The inventory lookup of design section 6, step 7. A failed lookup fails the job. */
  private async lookup(sql: string, values: unknown[]): Promise<DeviceRow[]> {
    try {
      return (await this.database.query(sql, values)).rows;
    } catch (error) {
      if (
        error instanceof DeviceSyncError &&
        error.code !== 'store-unavailable'
      )
        throw error;
      throw new DeviceImportError('inventory-unavailable');
    }
  }

  /**
   * Store one refresh read: each found device as a read, and each missing device soft-deleted, in
   * one transaction (design section 6, step 10).
   */
  private async storeRefresh(
    customerId: string,
    syncedAt: string,
    found: readonly { deviceId: string }[],
    missing: readonly string[],
  ): Promise<void> {
    try {
      await this.database.transaction(async (query) => {
        for (const batch of chunks(found, this.batchSize))
          await query.query('SELECT cc.upsert_devices($1,$2,$3,$4) AS result', [
            customerId,
            JSON.stringify(batch),
            syncedAt,
            'read',
          ]);
        for (const batch of chunks(missing, this.batchSize))
          await query.query('SELECT cc.soft_delete_devices($1,$2) AS result', [
            customerId,
            JSON.stringify(batch),
          ]);
      });
    } catch (error) {
      if (error instanceof DeviceSyncError) throw error;
      throw new DeviceImportError('store-unavailable');
    }
  }

  /** Reject the rows of these devices with one reason (design section 6, steps 11 and 12). */
  private rejectDevices(
    inspection: Inspection,
    deviceIds: readonly string[],
    code: 'current-values-unavailable' | 'device-removed',
  ): void {
    if (deviceIds.length === 0) return;
    const rejected = new Set(deviceIds);
    for (const candidate of inspection.candidates) {
      if (inspection.rejected.has(candidate.sourceRow)) continue;
      if (!rejected.has(candidate.deviceId)) continue;
      this.defer(inspection, candidate.sourceRow, [
        {
          column: code === 'device-removed' ? DEVICE_ID_HEADER : null,
          submittedValue:
            code === 'device-removed' ? candidate.deviceIdCell : null,
          reason: DEVICE_IMPORT_REJECTION_TEXTS[code],
        },
      ]);
    }
  }

  /**
   * Mark one row rejected. The first line of a row carries the ten template cells, so the rejected
   * file can repeat the row (`td:3`).
   */
  private reject(
    inspection: Inspection,
    lines: ImportLines,
    sourceRow: number,
    cells: readonly string[],
    deviceIdCell: string,
    write: boolean,
    reasons: readonly RejectionReason[],
  ): void {
    inspection.rejected.set(sourceRow, [...reasons]);
    if (!write) {
      inspection.deferred.add(sourceRow);
      return;
    }
    reasons.forEach((reason, index) => {
      lines.add({
        kind: 'rejection',
        sourceRow,
        deviceId: deviceIdCell === '' ? null : deviceIdCell,
        column: reason.column,
        submittedValue: reason.submittedValue,
        reason: reason.reason,
        templateCells: index === 0 ? [...cells] : null,
      });
    });
  }

  /** Mark one row rejected after pass 1 read it, for the compare pass to store. */
  private defer(
    inspection: Inspection,
    sourceRow: number,
    reasons: readonly RejectionReason[],
  ): void {
    inspection.rejected.set(sourceRow, [...reasons]);
    inspection.deferred.add(sourceRow);
  }

  /** Store the deferred rejection of one row, which the compare pass holds its cells for. */
  private writeDeferred(
    inspection: Inspection,
    lines: ImportLines,
    row: FileRow,
  ): void {
    const reasons = inspection.rejected.get(row.sourceRow);
    if (reasons === undefined || reasons.length === 0) return;
    inspection.deferred.delete(row.sourceRow);
    const deviceIdCell = deviceEditUnescapeCell(row.cells[DEVICE_ID_COLUMN]);
    reasons.forEach((reason, index) => {
      lines.add({
        kind: 'rejection',
        sourceRow: row.sourceRow,
        deviceId: deviceIdCell === '' ? null : deviceIdCell,
        column: reason.column,
        submittedValue: reason.submittedValue,
        reason: reason.reason,
        templateCells: index === 0 ? [...row.cells] : null,
      });
    });
  }
}
