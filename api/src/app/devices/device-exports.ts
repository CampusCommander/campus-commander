import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  deviceExportFileName,
  deviceExportReceiptSchema,
  deviceExportRequestSchema,
  jobDisplayIdSchema,
  type Action,
  type DeviceExportReceipt,
  type DeviceExportRequest,
  type DeviceSelectionKey,
  type DeviceSyncState,
  type JobExportPurpose,
  type SessionResponse,
} from '@campus/application-contracts';
import { selectionOrderedIdsSql } from './device-query';
import {
  hasSelection,
  parseSelection,
  selectionStorageKey,
} from './device-selection';
import { measuredAt } from './device-updates';

/**
 * The API side of one export job (`docs/superpowers/specs/2026-10-28-device-export-import-design.md`,
 * sections 1, 4, and 5). `POST /api/devices/exports` freezes the selection in grid order and creates
 * the job. `GET /api/devices/exports/{displayId}/file` streams the published artifact.
 */

/** An export of either purpose holds at most this many devices (design section 5). */
export const MAX_EXPORT_TARGETS = 50_000;

/** Every export request checks these actions at the connected customer's district scope. */
export const DEVICE_EXPORT_ACTIONS: readonly Action[] = [
  'devices:read',
  'devices:bulk-actions',
  'devices:export',
];

/** A download checks the job visibility and this read action (design section 1). */
export const DEVICE_EXPORT_FILE_ACTIONS: readonly Action[] = ['devices:read'];

/** The export display ID of the file route. Another prefix names no export job. */
const exportDisplayId = /^EXP-\d{3,}$/;

/** A stored file name that a content-disposition header can carry without an escape. */
const safeFileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

interface QueryResult {
  rows: Record<string, unknown>[];
}
interface QueryClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}
export interface ExportsDatabase {
  connection: QueryClient;
}
export interface ExportsCache {
  get(key: string): Promise<string | null>;
}
export interface ExportsStorage {
  openRead(artifactId: string): Promise<AsyncIterable<Buffer>>;
}
export interface ExportsOrchestration {
  startDeviceExport(input: {
    customerId: string;
    jobId: string;
    leaseId: string;
    correlationId: string;
  }): Promise<string>;
}

/** The Drive exchange of one Sheet export (design section 6). */
export interface ExportsDrive {
  /**
   * Run the exchange of section 4 and answer the subject that the job stores. The route keeps no
   * token. A refusal answers 409 `drive-unavailable` with its cause.
   */
  sheetExportSubject(
    session: SessionResponse,
    cookie: string | undefined,
    current: DeviceSyncState,
  ): Promise<string>;
}

/** The published file of one export, ready to stream. */
export interface DeviceExportFile {
  /** The download name of the file. */
  name: string;
  sizeBytes: number;
  stream: AsyncIterable<Buffer>;
}

/**
 * The job, its published file, and the caller's visibility, in one statement. The customer predicate
 * keeps another customer's display ID out of the answer, so the caller reads a missing job.
 */
const fileSql = `SELECT e.purpose,e.file_artifact_id,e.file_name,e.file_size_bytes,e.file_expires_at,
  cc.job_visible($1,$2,$3,j.requested_by) AS visible
  FROM cc.jobs j JOIN cc.device_export_jobs e ON e.job_id=j.job_id
  WHERE j.customer_id=$3 AND j.display_id=$4 AND j.kind='device-export'`;

/**
 * Parse an export body. A refused body names its first issue, because the generic 400 body of the
 * error filter would hide the field that failed.
 */
export function deviceExportInput(body: unknown): DeviceExportRequest {
  const parsed = deviceExportRequestSchema.safeParse(body);
  if (!parsed.success)
    throw new BadRequestException({
      reason: 'invalid-export',
      message: parsed.error.issues[0]?.message ?? 'The request is invalid.',
    });
  // A report names each visible column once. The store refuses a repeat, so the route names it.
  const { columns } = parsed.data;
  if (new Set(columns).size !== columns.length)
    throw new BadRequestException({
      reason: 'invalid-export',
      message: 'A report column appears twice.',
    });
  return parsed.data;
}

/** Map one create-function outcome to the status and code of the route. */
export function deviceExportFunctionError(
  result: Record<string, unknown>,
): never {
  const outcome = String(result['outcome']);
  if (outcome === 'forbidden')
    throw new ForbiddenException('This action requires additional permission.');
  if (outcome === 'connection-changed')
    throw new ConflictException({ reason: 'connection-changed' });
  throw new Error(`The device export function returned ${outcome}.`);
}

export class DeviceExports {
  private readonly database: ExportsDatabase;
  private readonly cache: ExportsCache;
  private readonly storage: ExportsStorage;
  private readonly orchestration: ExportsOrchestration;
  private readonly drive: ExportsDrive;
  private readonly clock: () => number;

  constructor(
    database: ExportsDatabase,
    cache: ExportsCache,
    storage: ExportsStorage,
    orchestration: ExportsOrchestration,
    drive: ExportsDrive,
    clock: () => number = () => Date.now(),
  ) {
    this.database = database;
    this.cache = cache;
    this.storage = storage;
    this.orchestration = orchestration;
    this.drive = drive;
    this.clock = clock;
  }

  private async selection(session: SessionResponse, key: DeviceSelectionKey) {
    return parseSelection(
      await this.cache.get(selectionStorageKey(session.identity.id, key)),
    );
  }

  /**
   * Freeze the selection into one export job and start its flow (design section 5). An expired
   * selection refuses the export, and the export never widens to every device. A selection that
   * resolves to no device still creates the job, because an empty scope writes the header row.
   */
  async request(
    session: SessionResponse,
    current: DeviceSyncState,
    input: DeviceExportRequest,
    correlationId: string,
    cookie?: string,
  ): Promise<DeviceExportReceipt> {
    const { state, expiredAt } = await this.selection(session, {
      gridId: input.gridId,
      tabId: input.tabId,
    });
    if (expiredAt)
      throw new ConflictException({ reason: 'selection-expired', expiredAt });
    if (!hasSelection(state))
      throw new UnprocessableEntityException({ reason: 'nothing-selected' });
    // A Sheet export runs the exchange of section 4 before it writes. The job stores the subject,
    // and the route keeps no token (design section 6).
    const driveSubject =
      input.format === 'sheet'
        ? await this.drive.sheetExportSubject(session, cookie, current)
        : null;
    // One query asks for one row above the limit, so a scope above it is refused without a count.
    const sql = selectionOrderedIdsSql(
      current.customerId,
      state,
      input.sort,
      MAX_EXPORT_TARGETS + 1,
    );
    const rows = (await this.database.connection.query(sql.text, sql.values))
      .rows;
    if (rows.length > MAX_EXPORT_TARGETS)
      throw new UnprocessableEntityException({
        reason: 'selection-too-large',
      });
    const devices = rows.map((row) => String(row['device_id']));
    const result = (
      await this.database.connection.query(
        `SELECT cc.create_device_export_job($1::uuid,$2::integer,$3::text,$4::text,$5::text,
          $6::text,$7::text,$8::text[],$9::jsonb,$10::uuid,$11::text) AS result`,
        [
          session.identity.id,
          session.identity.permissionVersion,
          current.customerId,
          input.purpose,
          input.format,
          input.sort.field,
          input.sort.direction,
          input.columns,
          JSON.stringify(devices),
          correlationId,
          driveSubject,
        ],
      )
    ).rows[0]?.['result'] as Record<string, unknown> | undefined;
    if (!result)
      throw new Error('The device export function returned no result.');
    if (result['outcome'] !== 'created') deviceExportFunctionError(result);
    const receipt = deviceExportReceiptSchema.parse(result['receipt']);
    // A lost start is a lost run, which `cc.recover_device_file_jobs` fails with `interrupted`
    // (design section 5). The job stands either way, so the person still reaches its page.
    await this.orchestration
      .startDeviceExport({
        customerId: current.customerId,
        jobId: receipt.jobId,
        leaseId: randomUUID(),
        correlationId,
      })
      .catch(() => undefined);
    return receipt;
  }

  /**
   * The published file of one export (design section 4). Another customer's display ID, an
   * invisible job, and a job of another kind all read as a missing job. The artifact opens before
   * the answer starts, so a storage fault still answers 503.
   */
  async file(
    session: SessionResponse,
    current: DeviceSyncState,
    displayId: string,
  ): Promise<DeviceExportFile> {
    if (!exportDisplayId.test(displayId))
      throw new NotFoundException({ reason: 'job-not-found' });
    const row = (
      await this.database.connection.query(fileSql, [
        session.identity.id,
        session.identity.permissionVersion,
        current.customerId,
        displayId,
      ])
    ).rows[0];
    if (!row || row['visible'] !== true)
      throw new NotFoundException({ reason: 'job-not-found' });
    const artifactId = row['file_artifact_id'];
    if (typeof artifactId !== 'string')
      throw new ConflictException({ reason: 'export-not-ready' });
    const expiresAt = measuredAt(row['file_expires_at']);
    if (expiresAt === null)
      throw new ConflictException({ reason: 'export-not-ready' });
    if (Date.parse(expiresAt) <= this.clock())
      throw new GoneException({ reason: 'export-expired', expiresAt });
    let stream: AsyncIterable<Buffer>;
    try {
      stream = await this.storage.openRead(artifactId);
    } catch {
      throw new ServiceUnavailableException({ reason: 'storage-unavailable' });
    }
    const stored = row['file_name'];
    return {
      // A stored name that a header cannot carry falls back to the name of its display ID.
      name:
        typeof stored === 'string' && safeFileName.test(stored)
          ? stored
          : deviceExportFileName(
              row['purpose'] as JobExportPurpose,
              jobDisplayIdSchema.parse(displayId),
            ),
      sizeBytes: Number(row['file_size_bytes']),
      stream,
    };
  }
}
