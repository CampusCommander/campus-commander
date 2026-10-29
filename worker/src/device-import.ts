import * as z from 'zod';
import {
  DEVICE_EDIT_TEMPLATE_COLUMNS,
  DEVICE_IMPORT_NOT_RUN_TEXTS,
  DEVICE_IMPORT_REJECTION_TEXTS,
  DEVICE_IMPORT_ROW_LIMIT,
  CsvError,
  createCsvReader,
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
import type {
  DelegatedCredential,
  DeviceState,
} from '@campus/google-connection';
import type { DeviceArtifactReader } from './device-export-store';
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
 * The framing that one call adds around its lines: the brackets, the separator of each of 1,000
 * lines, and the header of each value. `cc.store_device_import_lines` refuses a document above
 * 32 MiB, so the buffer closes below that cap and never builds a call that the store refuses.
 */
const LINE_ARRAY_FRAMING = 64 * 1024;

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
    /** The uploaded file. The upload links it to the job through `cc.artifacts.job_id`. */
    sourceArtifactId: z.string().min(1).max(256).nullable(),
    /** The connection credential that the worker reads Google with. */
    generation: z.number().int().positive().nullable(),
    credentialId: z.uuid().nullable(),
    envelope: z.unknown().nullable(),
    statusPermissions: z.array(statusActionSchema).max(3),
  }),
  z.object({ outcome: z.literal('done') }),
  z.object({ outcome: z.literal('busy') }),
]);
type ClaimedImport = Extract<
  z.infer<typeof claimSchema>,
  { outcome: 'claimed' }
>;

const renewalSchema = z.object({
  outcome: z.enum(['renewed', 'done', 'fenced']),
});

const storedLinesSchema = z.object({
  outcome: z.enum(['stored', 'fenced', 'done']),
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

export interface DeviceImportOptions {
  /** The rows and the devices of one read. Defaults to 1,000 (design section 6). */
  batchSize?: number;
  timers?: SyncTimers;
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
  phase: 'header-check' | 'refresh' | 'compare' | 'report';
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

/**
 * The report line buffer. A call carries at most 1,000 lines and well under 32 MiB of JSON, so it
 * closes a batch at the first limit and opens the next (design section 6, step 19).
 */
class ImportLines {
  private readonly send: (
    lines: ImportLine[],
  ) => Promise<'stored' | 'fenced' | 'cancelled'>;
  private closed: ImportLine[][] = [];
  private open: ImportLine[] = [];
  private bytes = 0;
  /** The lines that the store holds. */
  stored = 0;

  constructor(
    send: (lines: ImportLine[]) => Promise<'stored' | 'fenced' | 'cancelled'>,
  ) {
    this.send = send;
  }

  add(line: ImportLine): void {
    this.open.push(line);
    this.bytes += Buffer.byteLength(JSON.stringify(line), 'utf8');
    if (
      this.open.length >= DEVICE_IMPORT_LINE_BATCH ||
      this.bytes >= DEVICE_IMPORT_LINE_BYTES - LINE_ARRAY_FRAMING
    )
      this.close();
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
 * The 30-second tick and the phase writes of one validation run (design section 6). Every write
 * renews the lease, writes the phase, and reads the cancel request. The writes run in one queue, so
 * a tick never lands after a later phase (design section 2).
 */
class ImportProgress {
  private readonly database: DeviceImportDatabase;
  private readonly lease: readonly [string, string, string];
  private readonly timers: SyncTimers;
  private readonly state: PhaseState;
  private renewals: Promise<unknown> = Promise.resolve();
  private handle: unknown = null;
  private running: Promise<void> | null = null;
  private requested = false;
  private lost = false;

  constructor(
    database: DeviceImportDatabase,
    lease: readonly [string, string, string],
    state: PhaseState,
    timers: SyncTimers,
  ) {
    this.database = database;
    this.lease = lease;
    this.state = state;
    this.timers = timers;
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
    if (answer === 'cancelled') this.requested = true;
    if (answer === 'lost') this.lost = true;
    return answer;
  }

  /** Write the phase, and stop when the answer or the worker ends the run. */
  async step(signal: AbortSignal, patch: Partial<PhaseState>): Promise<void> {
    const answer = await this.write(patch);
    if (answer === 'cancelled') throw new ImportStop({ kind: 'cancelled' });
    if (answer === 'lost') throw new ImportStop({ kind: 'fenced' });
    this.check(signal);
  }

  /** Stop between batches after a cancel, a fence, or a worker stop. */
  check(signal: AbortSignal): void {
    if (this.lost) throw new ImportStop({ kind: 'fenced' });
    if (this.requested) throw new ImportStop({ kind: 'cancelled' });
    if (signal.aborted) throw new ImportStop({ kind: 'stopped' });
  }

  private async renew(
    state: PhaseState,
  ): Promise<'renewed' | 'cancelled' | 'lost'> {
    const answer = renewalSchema.parse(
      await callStore(
        this.database,
        'SELECT cc.renew_device_import_job($1,$2,$3,$4,$5,$6) AS result',
        [...this.lease, state.phase, state.done, state.total],
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
    if (this.requested || this.lost) return;
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

/** Run one validation job (design section 6). */
export class DeviceImportJobs {
  private readonly database: DeviceImportDatabase;
  private readonly store: DeviceArtifactReader;
  private readonly reader: DeviceImportReader;
  private readonly cipher: DeviceImportCipher;
  private readonly batchSize: number;
  private readonly timers: SyncTimers;

  constructor(
    database: DeviceImportDatabase,
    store: DeviceArtifactReader,
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
        return this.endDone(lease, input.failure ?? null);
      return { outcome: claim.outcome };
    }
    if (input.failure !== undefined)
      return this.end(lease, claim.displayId, { failure: input.failure });
    return this.validate(input, lease, claim, signal);
  }

  /**
   * End a job that the claim answered `done` for. An ended job repeats its stored answer and writes
   * nothing. A job that still runs holds a stored cancel request, and this finish ends it Cancelled
   * under this run's lease. A lapsed or replaced lease answers `fenced` and writes nothing.
   */
  private async endDone(
    lease: readonly [string, string, string],
    failure: string | null,
  ): Promise<DeviceImportAnswer> {
    const answer = await this.finish(lease, null, failure, null);
    return answer.outcome === 'fenced'
      ? { outcome: 'fenced' }
      : { outcome: 'done' };
  }

  /** The finish call of `cc.finish_device_import_job` (design section 6). */
  private async finish(
    lease: readonly [string, string, string],
    counts: DeviceImportCounts | null,
    failure: string | null,
    refusal: { code: string; text: string } | null,
  ): Promise<FinishAnswer> {
    return finishSchema.parse(
      await callStore(
        this.database,
        'SELECT cc.finish_device_import_job($1,$2,$3,$4,$5,$6,$7) AS result',
        [
          ...lease,
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
    lease: readonly [string, string, string],
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
    const answer = await this.finish(lease, counts, failure, refusal);
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
    lease: readonly [string, string, string],
    claim: ClaimedImport,
    signal: AbortSignal,
  ): Promise<DeviceImportAnswer> {
    const displayId = claim.displayId;
    const artifactId = claim.sourceArtifactId;
    if (artifactId === null) {
      // The upload stores the file and links it to the job. A missing file is a storage fault
      // (design section 6, the failures table).
      return this.end(lease, displayId, { failure: 'storage-unavailable' });
    }
    let credential: DelegatedCredential;
    try {
      credential = this.open(claim, input.customerId);
    } catch {
      return this.end(lease, displayId, { failure: 'key-unavailable' });
    }

    const progress = new ImportProgress(
      this.database,
      lease,
      { phase: 'header-check', done: 0, total: null },
      this.timers,
    );
    const lines = new ImportLines((batch) => this.storeLines(lease, batch));
    progress.start();
    try {
      const inspection = await this.inspect(
        input,
        claim,
        credential,
        artifactId,
        progress,
        lines,
        signal,
      );
      const counts = await this.compare(
        input,
        claim,
        inspection,
        artifactId,
        progress,
        lines,
        signal,
      );
      const flushed = await lines.flush();
      if (flushed === 'fenced') return { outcome: 'fenced' };
      if (flushed === 'cancelled') return this.end(lease, displayId, {});
      await progress.step(signal, {
        phase: 'report',
        done: lines.stored,
        total: lines.stored,
      });
      return await this.end(lease, displayId, { counts });
    } catch (error) {
      if (error instanceof ImportRefusal)
        return this.end(lease, displayId, {
          failure: 'invalid-response',
          refusal: { code: error.code, text: error.text },
        });
      if (error instanceof ImportStop) {
        if (error.reason.kind === 'stopped') return { outcome: 'stopped' };
        if (error.reason.kind === 'fenced') return { outcome: 'fenced' };
        return this.end(lease, displayId, {});
      }
      // A storage fault fails the job. A lost worker writes nothing.
      if (signal.aborted) return { outcome: 'stopped' };
      // A storage fault fails the job with `storage-unavailable`. A code that the job header
      // accepts is stored as it is (design section 6, the failures table).
      if (
        error instanceof DeviceSyncError &&
        jobFailureSchema.safeParse(error.code).success
      )
        return this.end(lease, displayId, { failure: error.code });
      return this.end(lease, displayId, { failure: 'storage-unavailable' });
    } finally {
      await progress.close();
    }
  }

  /** Store one batch of lines under the lease (design section 6, step 19). */
  private async storeLines(
    lease: readonly [string, string, string],
    lines: readonly ImportLine[],
  ): Promise<'stored' | 'fenced' | 'cancelled'> {
    const answer = storedLinesSchema.parse(
      await callStore(
        this.database,
        'SELECT cc.store_device_import_lines($1,$2,$3,$4) AS result',
        [...lease, JSON.stringify(lines)],
      ),
    );
    if (answer.outcome === 'stored') return 'stored';
    return answer.outcome === 'fenced' ? 'fenced' : 'cancelled';
  }

  /**
   * Stream the stored file (design section 6, step 2). The decoder is fatal, so a file that is not
   * UTF-8 refuses before any row check. Each record answers its cells in template order. The first
   * pass stores the header warnings, and the second pass repeats none of them.
   */
  private async *records(
    artifactId: string,
    mode: DeviceImportMode,
    lines: ImportLines,
    warnings: boolean,
    signal: AbortSignal,
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
    let sourceRow = 0;
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
        sourceRow += 1;
        out.push({ sourceRow, cells: cellsOf(record, mapping) });
      }
    };

    for await (const chunk of source) {
      if (signal.aborted) throw new ImportStop({ kind: 'stopped' });
      let records: CsvRecord[];
      try {
        records = reader.push(decode(chunk));
      } catch (error) {
        throw refusalOf(error);
      }
      feed(records);
      while (out.length > 0) yield out.shift() as FileRow;
    }
    // The end of the file answers its last record, and a trailing partial sequence is a fault.
    try {
      const tail = decode(undefined);
      feed([...reader.push(tail), ...reader.end()]);
    } catch (error) {
      throw refusalOf(error);
    }
    while (out.length > 0) yield out.shift() as FileRow;
    if (mapping === null)
      throw new ImportRefusal(
        'header-refused',
        deviceImportRefusalText(
          'header-refused',
          DEVICE_IMPORT_MISSING_HEADER_TEXT,
        ),
      );
  }

  /** Pass 1 of design section 6: the checks, the lookup, the refresh, the units, and the access. */
  private async inspect(
    input: DeviceImportRequest,
    claim: ClaimedImport,
    credential: DelegatedCredential,
    artifactId: string,
    progress: ImportProgress,
    lines: ImportLines,
    signal: AbortSignal,
  ): Promise<Inspection> {
    const inspection: Inspection = {
      rowsRead: 0,
      unchanged: 0,
      candidates: [],
      rejected: new Map<number, RejectionReason[]>(),
      deferred: new Set<number>(),
      staleDevicesRead: 0,
    };
    const seen = new Set<string>();
    let tree: Set<string> | null = null;
    let treeFailed = false;

    for await (const row of this.records(
      artifactId,
      claim.mode,
      lines,
      true,
      signal,
    )) {
      const { sourceRow, cells } = row;
      inspection.rowsRead += 1;
      if (inspection.rowsRead > DEVICE_IMPORT_ROW_LIMIT)
        throw new ImportRefusal(
          'too-many-rows',
          deviceImportRefusalText('too-many-rows'),
        );
      if (inspection.rowsRead % this.batchSize === 0)
        await progress.step(signal, {
          phase: 'header-check',
          done: inspection.rowsRead,
          total: null,
        });
      // Store a closed batch now, so a file of rejected rows never holds every line in memory
      // (design section 6, step 19).
      if (lines.full) {
        const answer = await lines.flush();
        if (answer === 'fenced') throw new ImportStop({ kind: 'fenced' });
        if (answer === 'cancelled') throw new ImportStop({ kind: 'cancelled' });
      }

      const deviceIdCell = deviceEditUnescapeCell(cells[DEVICE_ID_COLUMN]);
      // The identity checks of design section 6, step 5. Duplicate detection covers every row,
      // unchanged rows included (`td:8.3`), and every later occurrence is rejected.
      if (deviceIdCell === '') {
        this.reject(inspection, lines, sourceRow, cells, deviceIdCell, true, [
          {
            column: DEVICE_ID_HEADER,
            submittedValue: null,
            reason: DEVICE_IMPORT_REJECTION_TEXTS['device-id-missing'],
          },
        ]);
        continue;
      }
      if (!PLAIN_DEVICE_ID.test(deviceIdCell)) {
        this.reject(inspection, lines, sourceRow, cells, deviceIdCell, true, [
          {
            column: DEVICE_ID_HEADER,
            submittedValue: deviceIdCell,
            reason: DEVICE_IMPORT_REJECTION_TEXTS['device-id-malformed'],
          },
        ]);
        continue;
      }
      if (seen.has(deviceIdCell)) {
        this.reject(inspection, lines, sourceRow, cells, deviceIdCell, true, [
          {
            column: DEVICE_ID_HEADER,
            submittedValue: deviceIdCell,
            reason: DEVICE_IMPORT_REJECTION_TEXTS['device-id-duplicate'],
          },
        ]);
        continue;
      }
      seen.add(deviceIdCell);

      // The partition of `td:8.3`. Only Sync changes reads the row checksum.
      if (claim.mode === 'sync-changes') {
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
          continue;
        }
      }

      // The unit paths of design section 6, step 13: one tree read serves the job.
      const unitCell = deviceEditUnescapeCell(cells[ORG_UNIT_COLUMN]);
      if (deviceEditFieldCellIntent(unitCell).intent === 'assign') {
        if (tree === null && !treeFailed) {
          try {
            const units = await this.reader.readOrgUnitTree(
              credential,
              input.customerId,
              signal,
            );
            tree = new Set(units.map((unit) => unit.orgUnitPath.toLowerCase()));
          } catch {
            treeFailed = true;
          }
        }
        if (treeFailed || tree === null) {
          this.reject(inspection, lines, sourceRow, cells, deviceIdCell, true, [
            {
              column: UNIT_HEADER,
              submittedValue: unitCell,
              reason: DEVICE_IMPORT_REJECTION_TEXTS['org-unit-unavailable'],
            },
          ]);
          continue;
        }
        if (!tree.has(unitCell.toLowerCase())) {
          this.reject(inspection, lines, sourceRow, cells, deviceIdCell, true, [
            {
              column: UNIT_HEADER,
              submittedValue: unitCell,
              reason: deviceImportUnitRejectionText(unitCell),
            },
          ]);
          continue;
        }
      }

      // The access check of design section 6, step 14. A code without its stored permission rejects
      // its row. An invalid cell stays for the compare pass, which keeps every reason.
      const statusCell = deviceEditUnescapeCell(cells[STATUS_COLUMN]);
      const intent = deviceEditStatusCellIntent(statusCell);
      if (intent.ok && intent.intent.intent !== 'none') {
        const action = intent.intent.intent;
        if (!claim.statusPermissions.includes(action)) {
          this.reject(inspection, lines, sourceRow, cells, deviceIdCell, true, [
            {
              column: STATUS_HEADER,
              submittedValue: statusCell,
              reason: deviceImportPermissionRejectionText(action),
            },
          ]);
          continue;
        }
      }

      inspection.candidates.push({
        sourceRow,
        deviceId: deviceIdCell,
        deviceIdCell,
      });
    }
    await progress.step(signal, {
      phase: 'header-check',
      done: inspection.rowsRead,
      total: null,
    });

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
      progress.check(signal);
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
    await progress.step(signal, {
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
          signal,
        );
      } catch (error) {
        // A token failure answers the whole call. The rows of this batch reject, and later batches
        // continue (design section 6, step 12).
        if (signal.aborted) throw error;
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
      await progress.step(signal, {
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
    signal: AbortSignal,
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
        if (lines.full) {
          const answer = await lines.flush();
          if (answer === 'fenced') throw new ImportStop({ kind: 'fenced' });
          if (answer === 'cancelled')
            throw new ImportStop({ kind: 'cancelled' });
        }
      }
      done += current.length;
      await progress.step(signal, {
        phase: 'compare',
        done,
        total: compared.length,
      });
    };

    await progress.step(signal, {
      phase: 'compare',
      done: 0,
      total: compared.length,
    });
    for await (const row of this.records(
      artifactId,
      claim.mode,
      lines,
      false,
      signal,
    )) {
      const candidate = byRow.get(row.sourceRow);
      if (candidate !== undefined) {
        batch.push({ ...candidate, cells: row.cells });
        if (batch.length >= this.batchSize) await flushBatch();
        continue;
      }
      // A row that pass 1 deferred a rejection for gets its line here, where its cells are.
      if (inspection.deferred.has(row.sourceRow))
        this.writeDeferred(inspection, lines, row);
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
