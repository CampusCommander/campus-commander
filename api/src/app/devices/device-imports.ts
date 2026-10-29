import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import {
  DEVICE_ACTION_PERMISSIONS,
  DEVICE_EDIT_TEMPLATE_HEADERS,
  DEVICE_IMPORT_FAILED_OUTCOMES,
  DEVICE_IMPORT_NOT_RUN_TEXTS,
  DEVICE_IMPORT_REPORT_PAGE_SIZE,
  createCsvWriter,
  deprovisionReasonSchema,
  deviceEditUnescapeCell,
  deviceImportChangeSummarySchema,
  deviceImportCountsSchema,
  deviceImportModeSchema,
  deviceImportNotRunReasonSchema,
  deviceImportPlanCancelAnswerSchema,
  deviceImportReceiptSchema,
  deviceImportReportLineSchema,
  deviceImportReportSchema,
  isAuthorized,
  jobImportPlanSchema,
  type Action,
  type DeviceImportChange,
  type DeviceImportChangeSummary,
  type DeviceImportCounts,
  type DeviceImportPlanCancelAnswer,
  type DeviceImportPlanCancelRequest,
  type DeviceImportReceipt,
  type DeviceImportReport,
  type DeviceImportReportLine,
  type DeviceImportReportQuery,
  type DeviceImportReportView,
  type DeviceStatusAction,
  type DeviceSyncState,
  type DeviceUpdateField,
  type JobImportPlan,
  type JobOutcome,
  type JobPerson,
  type SessionResponse,
} from '@campus/application-contracts';
import type { StagedUpload } from '../storage/storage.service';
import { measuredAt } from './device-updates';

/**
 * The API side of one validation job
 * (`docs/superpowers/specs/2026-10-28-device-export-import-design.md`, sections 1, 4, 6, and 8).
 * `POST /api/devices/imports` streams the uploaded file into the store and creates the job. The
 * report, the rejected file, the plan cancel, and the revalidation read the job, its report tables,
 * and its plan.
 */

/** The import display ID of the job routes. Another prefix names no validation job. */
const importDisplayId = /^IMP-\d{3,}$/;

/** A job holds a report in these two states. A running, failed, or cancelled job holds none. */
const REPORT_STATUSES: readonly string[] = [
  'completed',
  'completed-with-errors',
];

/** Every import request checks these actions at the connected customer's district scope. */
export const DEVICE_IMPORT_ACTIONS: readonly Action[] = [
  'devices:read',
  'devices:write',
  'devices:bulk-actions',
];

/** A rejected-rows download checks the job visibility and this read action (design section 1). */
export const DEVICE_IMPORT_DOWNLOAD_ACTIONS: readonly Action[] = [
  'devices:read',
];

/** The status actions whose permission the job row records (design section 6, step 1). */
export const DEVICE_IMPORT_STATUS_ACTIONS: readonly DeviceStatusAction[] = [
  'disable',
  'reenable',
  'deprovision',
];

/** The query of `POST /api/devices/imports`. The file itself is the body (design section 4). */
export const deviceImportUploadQuerySchema = z.strictObject({
  mode: deviceImportModeSchema,
  name: z.string().min(1).max(255),
});
export type DeviceImportUploadQuery = z.output<
  typeof deviceImportUploadQuerySchema
>;

/** The body of the revalidation route: an empty strict object (design section 1). */
export const deviceImportEmptyBodySchema = z.strictObject({});

interface QueryResult {
  rows: Record<string, unknown>[];
}
interface QueryClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}
export interface ImportsDatabase {
  connection: QueryClient;
}
export interface ImportsStorage {
  stageUpload(source: AsyncIterable<Buffer>): Promise<StagedUpload>;
  discardUpload(descriptor: {
    artifactId: string;
    attemptId: string;
  }): Promise<unknown>;
}
export interface ImportsOrchestration {
  startDeviceImport(input: {
    customerId: string;
    jobId: string;
    leaseId: string;
    correlationId: string;
  }): Promise<string>;
}

/** One rejected-rows CSV file, ready to stream. */
export interface DeviceImportRejectedFile {
  name: string;
  chunks: AsyncIterable<Buffer>;
}

/**
 * The job, its detail row, its plan, and the caller's visibility, in one statement. The customer
 * predicate keeps another customer's display ID out of the answer, so the caller reads a missing
 * job.
 */
const jobSql = `SELECT j.job_id,j.display_id,j.status,i.mode,i.source_name,i.source_size_bytes,
  i.rows_read,i.unchanged,i.no_change_needed,i.proposed,i.rejected,i.stale_devices_read,
  i.oldest_observed_at,i.plan_id,i.plan_revision,i.plan_state,i.plan_expires_at,i.plan_changed_at,
  p.id AS plan_changed_by_id,p.display_name AS plan_changed_by_name,
  cc.job_visible($1,$2,$3,j.requested_by) AS visible
  FROM cc.jobs j JOIN cc.device_import_jobs i ON i.job_id=j.job_id
  LEFT JOIN cc.application_principals p ON p.id=i.plan_changed_by
  WHERE j.customer_id=$3 AND j.display_id=$4 AND j.kind='device-import'`;

/** The newest ready artifact of one job. The upload links it there; a revalidation moves it. */
const sourceArtifactSql = `SELECT a.id,a.size_bytes,a.retention_until FROM cc.artifacts a
  WHERE a.job_id=$1::text AND a.publication_state='ready' ORDER BY a.created_at DESC LIMIT 1`;

/** One job and the uploaded file that the same transaction links to it (design section 6). */
const createImportSql =
  'SELECT cc.create_device_import_job($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result';

const cancelPlanSql =
  'SELECT cc.cancel_device_import_plan($1,$2,$3,$4,$5,$6) AS result';

/** The person behind one plan change. The plan columns keep the principal ID alone. */
const planPersonSql =
  'SELECT p.id,p.display_name FROM cc.application_principals p WHERE p.id=$1';

/** The field changes and the status actions of one report (state 13). */
const changeSummarySql = `SELECT count(*) FILTER (WHERE change_type='field')::integer AS field_changes,
  count(DISTINCT device_id) FILTER (WHERE change_type='field')::integer AS field_change_devices,
  count(*) FILTER (WHERE change_type='status' AND status_action='disable')::integer AS disable,
  count(*) FILTER (WHERE change_type='status' AND status_action='reenable')::integer AS reenable,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('reason',d.reason,'devices',d.devices) ORDER BY d.reason)
    FROM (SELECT deprovision_reason AS reason,count(*)::integer AS devices
      FROM cc.device_import_changes WHERE job_id=$1 AND change_type='status'
        AND status_action='deprovision' GROUP BY deprovision_reason) d),'[]'::jsonb) AS deprovision
  FROM cc.device_import_changes WHERE job_id=$1`;

/** One change line, joined with its device and the operation that runs it (design section 8). The
 * statement pages in source-row and ordinal order, so every page of a view is stable. */
const changeLineSql = `SELECT c.source_row,c.device_id,left(d.serial_number,256) AS serial_number,
  c.change_type,c.field,c.mode,c.status_action,c.deprovision_reason,c.current_value,c.new_value,
  c.not_run_reason,j.display_id AS linked_display_id,c.operation_number,o.status AS operation_status
  FROM cc.device_import_changes c
  LEFT JOIN cc.devices d ON d.customer_id=$1 AND d.device_id=c.device_id
  LEFT JOIN cc.jobs j ON j.job_id=c.linked_job_id
  LEFT JOIN cc.device_update_operations o
    ON o.job_id=c.linked_job_id AND o.operation_number=c.operation_number
  WHERE c.job_id=$2
  ORDER BY c.source_row,c.ordinal LIMIT $3 OFFSET $4`;

/** The Failed tab joins each change with its operation and lists only the failed outcomes. */
const failedLineSql = `SELECT c.source_row,c.device_id,left(d.serial_number,256) AS serial_number,
  c.change_type,c.field,c.mode,c.status_action,c.deprovision_reason,c.current_value,c.new_value,
  c.not_run_reason,j.display_id AS linked_display_id,c.operation_number,o.status AS operation_status
  FROM cc.device_import_changes c
  LEFT JOIN cc.devices d ON d.customer_id=$1 AND d.device_id=c.device_id
  LEFT JOIN cc.jobs j ON j.job_id=c.linked_job_id
  JOIN cc.device_update_operations o
    ON o.job_id=c.linked_job_id AND o.operation_number=c.operation_number
  WHERE c.job_id=$2 AND o.status=ANY($5::text[])
  ORDER BY c.source_row,c.ordinal LIMIT $3 OFFSET $4`;

const rejectedLineSql = `SELECT r.source_row,left(r.device_id_cell,128) AS device_id,r.column_name,
  r.submitted_value,r.reason,left(r.template_cells[2],256) AS serial_number
  FROM cc.device_import_rejections r WHERE r.job_id=$1
  ORDER BY r.source_row,r.ordinal LIMIT $2 OFFSET $3`;

const warningLineSql = `SELECT w.source_row,w.device_id,w.warning FROM cc.device_import_warnings w
  WHERE w.job_id=$1 ORDER BY w.ordinal LIMIT $2 OFFSET $3`;

/** One source row of the rejected file: its ten template cells and every reason of the row. */
const rejectedFileSql = `SELECT r.source_row,
  (SELECT rr.template_cells FROM cc.device_import_rejections rr WHERE rr.job_id=r.job_id
    AND rr.source_row=r.source_row AND rr.template_cells IS NOT NULL ORDER BY rr.ordinal LIMIT 1)
    AS template_cells,
  string_agg(r.reason,'; ' ORDER BY r.ordinal) AS reasons
  FROM cc.device_import_rejections r WHERE r.job_id=$1
  GROUP BY r.job_id,r.source_row ORDER BY r.source_row LIMIT $2 OFFSET $3`;

/** The rows of one rejected-file page. */
const REJECTED_FILE_PAGE = 1_000;

/** The stored operation status of each outcome that the API shows (design section 8). */
const OPERATION_OUTCOMES: Readonly<Record<string, JobOutcome>> = Object.freeze({
  pending: 'pending',
  dispatched: 'pending',
  issued: 'pending',
  succeeded: 'succeeded',
  failed: 'failed',
  unknown: 'unknown',
  skipped: 'skipped',
  expired: 'expired',
  cancelled: 'cancelled',
});

/** The outcome of one operation status. A null status names a change that no operation ran. */
function operationOutcome(status: unknown): JobOutcome | null {
  if (status === null || status === undefined) return null;
  const outcome = OPERATION_OUTCOMES[String(status)];
  if (!outcome)
    throw new Error(`The operation status ${String(status)} is unknown.`);
  return outcome;
}

/** A stored text value, or null for a column that holds no value. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Parse an upload query. A refused query names its first issue, as the export route does. */
export function deviceImportUploadInput(
  query: unknown,
): DeviceImportUploadQuery {
  const parsed = deviceImportUploadQuerySchema.safeParse(query);
  if (!parsed.success)
    throw new BadRequestException({
      reason: 'invalid-import',
      message: parsed.error.issues[0]?.message ?? 'The request is invalid.',
    });
  return parsed.data;
}

/** Map one create-function outcome to the status and code of the route. */
export function deviceImportFunctionError(
  result: Record<string, unknown>,
): never {
  const outcome = String(result['outcome']);
  if (outcome === 'forbidden')
    throw new ForbiddenException('This action requires additional permission.');
  if (outcome === 'connection-changed')
    throw new ConflictException({ reason: 'connection-changed' });
  if (outcome === 'artifact-unavailable')
    throw new GoneException({ reason: 'source-expired' });
  throw new Error(`The device import function returned ${outcome}.`);
}

/** One proposed change of a report line (design section 1). */
function changeOf(row: Record<string, unknown>): DeviceImportChange {
  const currentValue = textOrNull(row['current_value']);
  const newValue = textOrNull(row['new_value']);
  if (row['change_type'] === 'field')
    return {
      type: 'field',
      field: row['field'] as DeviceUpdateField,
      operation: row['mode'] as 'replace' | 'clear' | 'move',
      currentValue,
      newValue,
    };
  const reason = row['deprovision_reason'];
  return {
    type: 'status',
    action: row['status_action'] as DeviceStatusAction,
    reason:
      reason === null || reason === undefined
        ? null
        : deprovisionReasonSchema.parse(reason),
    currentValue,
    newValue,
  };
}

export class DeviceImports {
  private readonly database: ImportsDatabase;
  private readonly storage: ImportsStorage;
  private readonly orchestration: ImportsOrchestration;
  private readonly clock: () => number;

  constructor(
    database: ImportsDatabase,
    storage: ImportsStorage,
    orchestration: ImportsOrchestration,
    clock: () => number = () => Date.now(),
  ) {
    this.database = database;
    this.storage = storage;
    this.orchestration = orchestration;
    this.clock = clock;
  }

  /** The status permissions of the requester, for the job row of design section 6. */
  statusPermissions(
    session: SessionResponse,
    current: DeviceSyncState,
  ): DeviceStatusAction[] {
    const resource = {
      kind: 'district' as const,
      customerId: current.customerId,
    };
    return DEVICE_IMPORT_STATUS_ACTIONS.filter((action) =>
      isAuthorized(
        session.identity.grants,
        DEVICE_ACTION_PERMISSIONS[action],
        resource,
      ),
    );
  }

  /**
   * Resolve the named job of the connected customer that the caller may see. Another customer's
   * display ID, an invisible job, and a display ID of another kind all read as a missing job.
   */
  private async namedJob(
    session: SessionResponse,
    current: DeviceSyncState,
    displayId: string,
  ): Promise<Record<string, unknown>> {
    if (!importDisplayId.test(displayId))
      throw new NotFoundException({ reason: 'job-not-found' });
    const row = (
      await this.database.connection.query(jobSql, [
        session.identity.id,
        session.identity.permissionVersion,
        current.customerId,
        displayId,
      ])
    ).rows[0];
    if (!row || row['visible'] !== true)
      throw new NotFoundException({ reason: 'job-not-found' });
    return row;
  }

  /** A job holds a report only in a final state with one (design section 6). */
  private requireReport(row: Record<string, unknown>): void {
    const status = String(row['status']);
    if (!REPORT_STATUSES.includes(status))
      throw new ConflictException({ reason: 'report-not-ready', status });
  }

  /**
   * Stream the uploaded file into the store and create the job (design sections 4 and 6). The store
   * computes the size and the SHA-256 while it writes, so the body is never held. The create
   * function links the staged artifact to the new job in its own transaction, and the flow starts
   * after the commit.
   */
  async upload(
    session: SessionResponse,
    current: DeviceSyncState,
    input: DeviceImportUploadQuery,
    body: AsyncIterable<Buffer>,
    correlationId: string,
  ): Promise<DeviceImportReceipt> {
    let staged: StagedUpload;
    try {
      staged = await this.storage.stageUpload(body);
    } catch {
      throw new ServiceUnavailableException({ reason: 'storage-unavailable' });
    }
    return this.createImport(
      session,
      current,
      {
        mode: input.mode,
        name: input.name,
        sizeBytes: staged.sizeBytes,
        artifactId: staged.artifactId,
      },
      correlationId,
      staged,
    );
  }

  /**
   * Revalidate the stored file of a named job (state 19). The new job carries the requester of the
   * request, the mode and the file of the named job, and the status permissions that the requester
   * holds now. A file past its retention answers 410.
   */
  async revalidate(
    session: SessionResponse,
    current: DeviceSyncState,
    displayId: string,
    correlationId: string,
  ): Promise<DeviceImportReceipt> {
    const job = await this.namedJob(session, current, displayId);
    const artifact = (
      await this.database.connection.query(sourceArtifactSql, [
        String(job['job_id']),
      ])
    ).rows[0];
    const expiresAt = artifact ? measuredAt(artifact['retention_until']) : null;
    if (
      !artifact ||
      (expiresAt !== null && Date.parse(expiresAt) <= this.clock())
    )
      throw new GoneException({
        reason: 'source-expired',
        ...(expiresAt === null ? {} : { expiresAt }),
      });
    return this.createImport(
      session,
      current,
      {
        mode: deviceImportModeSchema.parse(job['mode']),
        name: String(job['source_name']),
        sizeBytes: Number(job['source_size_bytes']),
        artifactId: String(artifact['id']),
      },
      correlationId,
    );
  }

  /** Create one job from one stored file and start its flow. */
  private async createImport(
    session: SessionResponse,
    current: DeviceSyncState,
    source: {
      mode: string;
      name: string;
      sizeBytes: number;
      artifactId: string;
    },
    correlationId: string,
    discard?: StagedUpload,
  ): Promise<DeviceImportReceipt> {
    let result: Record<string, unknown> | undefined;
    try {
      result = (
        await this.database.connection.query(createImportSql, [
          session.identity.id,
          session.identity.permissionVersion,
          current.customerId,
          source.mode,
          'csv',
          source.name,
          source.sizeBytes,
          this.statusPermissions(session, current),
          correlationId,
          source.artifactId,
        ])
      ).rows[0]?.['result'] as Record<string, unknown> | undefined;
    } catch (error) {
      // A refused call leaves no uploaded file behind. A created job keeps its file.
      await this.discard(discard);
      throw error;
    }
    if (!result) {
      await this.discard(discard);
      throw new Error('The device import function returned no result.');
    }
    if (result['outcome'] !== 'created') {
      await this.discard(discard);
      deviceImportFunctionError(result);
    }
    const receipt = deviceImportReceiptSchema.parse(result['receipt']);
    // A lost start is a lost run, which `cc.recover_device_file_jobs` fails with `interrupted`
    // (design section 5). The job stands either way, so the person still reaches its page.
    await this.orchestration
      .startDeviceImport({
        customerId: current.customerId,
        jobId: receipt.jobId,
        leaseId: randomUUID(),
        correlationId,
      })
      .catch(() => undefined);
    return receipt;
  }

  /** Remove one staged upload that a refused request leaves behind. */
  private async discard(staged: StagedUpload | undefined): Promise<void> {
    if (staged) await this.storage.discardUpload(staged).catch(() => undefined);
  }

  /** The report of one view and page (design sections 1 and 8). */
  async report(
    session: SessionResponse,
    current: DeviceSyncState,
    displayId: string,
    query: DeviceImportReportQuery,
  ): Promise<DeviceImportReport> {
    const job = await this.namedJob(session, current, displayId);
    this.requireReport(job);
    const jobId = String(job['job_id']);
    const total = await this.viewTotal(jobId, query.view);
    const pageCount = Math.max(
      1,
      Math.ceil(total / DEVICE_IMPORT_REPORT_PAGE_SIZE),
    );
    // A page past the last page answers the last page (ruling 2).
    const page = Math.min(query.page, pageCount - 1);
    const counts: DeviceImportCounts = deviceImportCountsSchema.parse({
      rows: Number(job['rows_read']),
      unchanged: Number(job['unchanged']),
      noChangeNeeded: Number(job['no_change_needed']),
      proposed: Number(job['proposed']),
      rejected: Number(job['rejected']),
    });
    return deviceImportReportSchema.parse({
      jobId,
      displayId,
      view: query.view,
      page,
      pageCount,
      counts,
      refresh: {
        staleDevicesRead: Number(job['stale_devices_read']),
        oldestObservedAt: measuredAt(job['oldest_observed_at']),
      },
      changes: await this.changeSummary(jobId),
      lines: await this.viewLines(current.customerId, jobId, query.view, page),
      total,
      plan: this.plan(job),
    });
  }

  /** The field changes and each status action of the plan, as state 13 shows them. */
  private async changeSummary(
    jobId: string,
  ): Promise<DeviceImportChangeSummary> {
    const row = (
      await this.database.connection.query(changeSummarySql, [jobId])
    ).rows[0];
    return deviceImportChangeSummarySchema.parse({
      fieldChanges: Number(row?.['field_changes'] ?? 0),
      fieldChangeDevices: Number(row?.['field_change_devices'] ?? 0),
      disable: Number(row?.['disable'] ?? 0),
      reenable: Number(row?.['reenable'] ?? 0),
      deprovision: row?.['deprovision'] ?? [],
    });
  }

  /**
   * The wire plan of one stored plan (design section 1). An open plan past its expiry reads
   * `expired`, so the report and the cancel route name one state one way.
   */
  private wirePlan(
    planId: unknown,
    revision: unknown,
    state: unknown,
    expiresAt: string | null,
    changedBy: JobPerson | null,
    changedAt: string | null,
  ): JobImportPlan {
    const stored = String(state);
    return jobImportPlanSchema.parse({
      planId,
      revision: Number(revision),
      state:
        stored === 'open' &&
        expiresAt !== null &&
        Date.parse(expiresAt) <= this.clock()
          ? 'expired'
          : stored,
      expiresAt,
      changedBy,
      changedAt,
    });
  }

  /** The plan facts of the job, with `expired` derived from the expiry (design section 1). */
  private plan(row: Record<string, unknown>): JobImportPlan | null {
    if (typeof row['plan_id'] !== 'string') return null;
    const expiresAt = measuredAt(row['plan_expires_at']);
    if (expiresAt === null) return null;
    const changedBy =
      typeof row['plan_changed_by_id'] === 'string'
        ? {
            id: row['plan_changed_by_id'],
            displayName: String(row['plan_changed_by_name']),
          }
        : null;
    return this.wirePlan(
      row['plan_id'],
      row['plan_revision'],
      row['plan_state'],
      expiresAt,
      changedBy,
      measuredAt(row['plan_changed_at']),
    );
  }

  /**
   * The plan of `cc.cancel_device_import_plan`, in the wire shape. The function stores the actor of
   * the change as a principal ID, so the route resolves the person once. A conflict that names no
   * plan answers null.
   */
  private async cancelPlan(value: unknown): Promise<JobImportPlan | null> {
    if (value === null || value === undefined) return null;
    const stored = value as Record<string, unknown>;
    const changedById = stored['changedBy'];
    const changedBy =
      typeof changedById === 'string'
        ? await this.planPerson(changedById)
        : null;
    return this.wirePlan(
      stored['planId'],
      stored['revision'],
      stored['state'],
      measuredAt(stored['expiresAt']),
      changedBy,
      measuredAt(stored['changedAt']),
    );
  }

  /** The person behind one plan change. The plan columns keep the principal ID alone. */
  private async planPerson(id: string): Promise<JobPerson> {
    const row = (
      await this.database.connection.query(planPersonSql, [id])
    ).rows[0];
    if (!row)
      throw new Error(`The plan names no application principal ${id}.`);
    return { id: String(row['id']), displayName: String(row['display_name']) };
  }

  /** The lines of one view. The failed view lists only the outcomes of its constant. */
  private async viewTotal(
    jobId: string,
    view: DeviceImportReportView,
  ): Promise<number> {
    const count = async (
      text: string,
      values: unknown[] = [jobId],
    ): Promise<number> =>
      Number(
        (await this.database.connection.query(text, values)).rows[0]?.[
          'total'
        ] ?? 0,
      );
    switch (view) {
      case 'proposed':
        return count(
          'SELECT count(*)::integer AS total FROM cc.device_import_changes WHERE job_id=$1',
        );
      case 'failed':
        return count(
          `SELECT count(*)::integer AS total FROM cc.device_import_changes c
            JOIN cc.device_update_operations o
              ON o.job_id=c.linked_job_id AND o.operation_number=c.operation_number
            WHERE c.job_id=$1 AND o.status=ANY($2::text[])`,
          [jobId, [...DEVICE_IMPORT_FAILED_OUTCOMES]],
        );
      case 'rejected':
        return count(
          'SELECT count(*)::integer AS total FROM cc.device_import_rejections WHERE job_id=$1',
        );
      case 'warnings':
        return count(
          'SELECT count(*)::integer AS total FROM cc.device_import_warnings WHERE job_id=$1',
        );
      default:
        throw new Error(`The report view ${String(view)} is unknown.`);
    }
  }

  /** The lines of one view and page, ten at most (ruling 2). */
  private async viewLines(
    customerId: string,
    jobId: string,
    view: DeviceImportReportView,
    page: number,
  ): Promise<DeviceImportReportLine[]> {
    const offset = page * DEVICE_IMPORT_REPORT_PAGE_SIZE;
    const rows = async (text: string, values: unknown[]) =>
      (await this.database.connection.query(text, values)).rows;
    switch (view) {
      case 'proposed':
        return (
          await rows(changeLineSql, [
            customerId,
            jobId,
            DEVICE_IMPORT_REPORT_PAGE_SIZE,
            offset,
          ])
        ).map((row) => this.changeLine(row));
      case 'failed':
        return (
          await rows(failedLineSql, [
            customerId,
            jobId,
            DEVICE_IMPORT_REPORT_PAGE_SIZE,
            offset,
            [...DEVICE_IMPORT_FAILED_OUTCOMES],
          ])
        ).map((row) => this.changeLine(row));
      case 'rejected':
        return (
          await rows(rejectedLineSql, [
            jobId,
            DEVICE_IMPORT_REPORT_PAGE_SIZE,
            offset,
          ])
        ).map((row) =>
          deviceImportReportLineSchema.parse({
            row: Number(row['source_row']),
            deviceId: row['device_id'] ?? null,
            serialNumber:
              typeof row['serial_number'] === 'string'
                ? deviceEditUnescapeCell(row['serial_number'])
                : null,
            change: null,
            column: row['column_name'] ?? null,
            submittedValue: row['submitted_value'] ?? null,
            reason: row['reason'],
            notRun: null,
            jobDisplayId: null,
            operationNumber: null,
            outcome: null,
          }),
        );
      case 'warnings':
        return (
          await rows(warningLineSql, [
            jobId,
            DEVICE_IMPORT_REPORT_PAGE_SIZE,
            offset,
          ])
        ).map((row) =>
          deviceImportReportLineSchema.parse({
            row:
              row['source_row'] === null || row['source_row'] === undefined
                ? null
                : Number(row['source_row']),
            deviceId: row['device_id'] ?? null,
            serialNumber: null,
            change: null,
            column: null,
            submittedValue: null,
            reason: row['warning'],
            notRun: null,
            jobDisplayId: null,
            operationNumber: null,
            outcome: null,
          }),
        );
      default:
        throw new Error(`The report view ${String(view)} is unknown.`);
    }
  }

  /** One proposed change line, with its job, operation, and outcome after Execute. */
  private changeLine(row: Record<string, unknown>): DeviceImportReportLine {
    const notRunReason = textOrNull(row['not_run_reason']);
    const reason =
      notRunReason === null
        ? null
        : deviceImportNotRunReasonSchema.parse(notRunReason);
    return deviceImportReportLineSchema.parse({
      row: Number(row['source_row']),
      deviceId: row['device_id'],
      serialNumber: row['serial_number'] ?? null,
      change: changeOf(row),
      column: null,
      submittedValue: null,
      reason: null,
      notRun:
        reason === null
          ? null
          : { reason, text: DEVICE_IMPORT_NOT_RUN_TEXTS[reason] },
      jobDisplayId:
        typeof row['linked_display_id'] === 'string'
          ? row['linked_display_id']
          : null,
      operationNumber:
        row['operation_number'] === null ||
        row['operation_number'] === undefined
          ? null
          : Number(row['operation_number']),
      outcome: operationOutcome(row['operation_status']),
    });
  }

  /**
   * The rejected rows as a CSV file (design section 1). The header takes the ten template columns,
   * then Row and Reason. One source row carries every reason of its row, and the file streams a
   * page of source rows at a time.
   */
  async rejected(
    session: SessionResponse,
    current: DeviceSyncState,
    displayId: string,
  ): Promise<DeviceImportRejectedFile> {
    const job = await this.namedJob(session, current, displayId);
    this.requireReport(job);
    return {
      name: `device-import-${displayId}-rejected.csv`,
      chunks: this.rejectedCsv(String(job['job_id'])),
    };
  }

  private async *rejectedCsv(jobId: string): AsyncIterable<Buffer> {
    const writer = createCsvWriter();
    yield Buffer.from(writer.start());
    yield Buffer.from(
      writer.row([...DEVICE_EDIT_TEMPLATE_HEADERS, 'Row', 'Reason']),
    );
    for (let offset = 0; ; offset += REJECTED_FILE_PAGE) {
      const rows = (
        await this.database.connection.query(rejectedFileSql, [
          jobId,
          REJECTED_FILE_PAGE,
          offset,
        ])
      ).rows;
      for (const row of rows) {
        const stored = Array.isArray(row['template_cells'])
          ? row['template_cells']
          : [];
        const cells = stored
          .slice(0, DEVICE_EDIT_TEMPLATE_HEADERS.length)
          .map((cell) => deviceEditUnescapeCell(String(cell)));
        while (cells.length < DEVICE_EDIT_TEMPLATE_HEADERS.length)
          cells.push('');
        yield Buffer.from(
          writer.row([
            ...cells,
            String(row['source_row']),
            String(row['reasons']),
          ]),
        );
      }
      if (rows.length < REJECTED_FILE_PAGE) return;
    }
  }

  /** Cancel the open plan of one job. The requester alone cancels, and a repeat answers it. */
  async cancel(
    session: SessionResponse,
    current: DeviceSyncState,
    displayId: string,
    input: DeviceImportPlanCancelRequest,
  ): Promise<DeviceImportPlanCancelAnswer> {
    const job = await this.namedJob(session, current, displayId);
    const result = (
      await this.database.connection.query(cancelPlanSql, [
        session.identity.id,
        session.identity.permissionVersion,
        current.customerId,
        job['job_id'],
        input.planId,
        input.planRevision,
      ])
    ).rows[0]?.['result'] as Record<string, unknown> | undefined;
    if (!result)
      throw new Error('The plan cancel function returned no result.');
    switch (String(result['outcome'])) {
      case 'cancelled':
        return deviceImportPlanCancelAnswerSchema.parse({
          plan: await this.cancelPlan(result['plan']),
        });
      case 'not-found':
        throw new NotFoundException({ reason: 'job-not-found' });
      case 'forbidden':
        throw new ForbiddenException(
          'This action requires additional permission.',
        );
      case 'conflict':
        throw new ConflictException({
          reason: 'plan-conflict',
          plan: await this.cancelPlan(result['plan']),
        });
      case 'expired':
        throw new GoneException({
          reason: 'plan-expired',
          plan: await this.cancelPlan(result['plan']),
        });
      default:
        throw new Error(
          `The plan cancel function returned ${String(result['outcome'])}.`,
        );
    }
  }
}
