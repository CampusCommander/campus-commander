import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  isAuthorized,
  jobActivitySchema,
  jobCancelRefusalSchema,
  jobDetailSchema,
  jobListSchema,
  jobOperationsPageSchema,
  jobRequestersSchema,
  jobSeenSchema,
  jobSummarySchema,
  type JobAction,
  type JobActivity,
  type JobCancelRefusal,
  type JobDetail,
  type JobFailedActivityOperation,
  type JobLatestActivity,
  type JobList,
  type JobOperation,
  type JobOperationsPage,
  type JobRequesters,
  type JobSeen,
  type JobStatus,
  type JobSummary,
  type JobUnknownActivityOperation,
  type SessionResponse,
} from '@campus/application-contracts';
import type { JobServiceOrchestration } from './job-service';
import type { ReconcileCheck } from '../devices/device-updates-actions';

/** One query result, as the API uses it. */
interface QueryResult {
  rows: Record<string, unknown>[];
}
interface QueryClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}
export interface JobsDatabase {
  connection: QueryClient;
}

/**
 * One permission check of a Reconcile request. The route supplies it, so the service runs the
 * checks in the order of the route: `read` before the job lookup, then the write check of the
 * operation kind (design section 6).
 */
export type ReconcileAuthorizer = (check: ReconcileCheck) => Promise<void>;

/** The seven filters of the Jobs grid (section 2.5). */
export interface JobFilters {
  jobId?: string;
  status?: JobStatus[];
  action?: JobAction[];
  entityType?: string[];
  requestedBy?: string[];
  createdFrom?: string;
  createdTo?: string;
  finishedFrom?: string;
  finishedTo?: string;
}

const ACTIVITY_RUNNING_ROWS = 50;
const ACTIVITY_WAITING_ROWS = 50;
const ACTIVITY_RECENT_ROWS = 10;
const ACTIVITY_WINDOW = '24 hours';

const measuredAt = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);
const measuredAtOrNull = (value: unknown): string | null =>
  value == null ? null : measuredAt(value);
const counted = (value: unknown): number => Number(value ?? 0);

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const parsed = z.object({ code: z.string() }).safeParse(error);
  if (parsed.success && parsed.data.code === '42501')
    throw new ForbiddenException({ reason: 'forbidden' });
  throw new ServiceUnavailableException(
    { reason: 'job-store-unavailable' },
    { cause: error },
  );
}

/** The status of each cancel refusal (design section 1). */
const cancelRefusalStatuses: Readonly<Record<JobCancelRefusal, number>> = {
  'job-not-found': 404,
  'cancel-not-permitted': 403,
  'job-finished': 409,
  'nothing-to-stop': 409,
};

/**
 * The cancel call raises one reason per refusal as DETAIL, as `cc.request_device_sync` raises its
 * conflicts (016). The route maps that reason to its status of design section 1.
 */
function translateCancel(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const parsed = z
    .object({ code: z.string(), detail: z.string().optional() })
    .safeParse(error);
  if (parsed.success && parsed.data.code === '42501')
    throw new ForbiddenException({ reason: 'forbidden' });
  if (parsed.success && parsed.data.code === 'P0001') {
    const refusal = jobCancelRefusalSchema.safeParse(parsed.data.detail);
    if (refusal.success) {
      const response = { reason: refusal.data };
      if (cancelRefusalStatuses[refusal.data] === 404)
        throw new NotFoundException(response);
      if (cancelRefusalStatuses[refusal.data] === 403)
        throw new ForbiddenException(response);
      throw new ConflictException(response);
    }
  }
  throw new ServiceUnavailableException(
    { reason: 'job-store-unavailable' },
    { cause: error },
  );
}

/**
 * A cursor names the last row of the previous page: its created time and its display ID.
 * The query returns the database time as text with microseconds, so the keyset keeps the
 * exact precision that PostgreSQL sorts and compares with.
 */
export function encodeCursor(row: Record<string, unknown>): string {
  const exact = row['created_at_cursor'];
  return Buffer.from(
    JSON.stringify([
      typeof exact === 'string' ? exact : measuredAt(row['created_at']),
      String(row['display_id']),
    ]),
  ).toString('base64url');
}

export function decodeCursor(
  cursor: string | undefined,
): { createdAt: string; displayId: string } | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (Array.isArray(parsed) && parsed.length === 2) {
      const [createdAt, displayId] = parsed;
      if (
        typeof createdAt === 'string' &&
        typeof displayId === 'string' &&
        !Number.isNaN(Date.parse(createdAt))
      )
        return { createdAt, displayId };
    }
  } catch {
    // A cursor that does not parse answers 400 below.
  }
  throw new BadRequestException({ reason: 'invalid-cursor' });
}

const actionKinds: Readonly<Record<JobAction, string>> = {
  'update-device-annotations': 'device-update',
  'refresh-inventory': 'inventory-refresh',
  'reboot-devices': 'device-command',
  'wipe-user-data': 'device-command',
  'powerwash-devices': 'device-command',
  'disable-devices': 'device-status',
  'reenable-devices': 'device-status',
  'deprovision-devices': 'device-status',
};

/** The job action of one write row. A missing action reads as the annotated-location update. */
const writeActions: Readonly<Record<string, JobAction>> = {
  'annotated-location': 'update-device-annotations',
  reboot: 'reboot-devices',
  'wipe-users': 'wipe-user-data',
  powerwash: 'powerwash-devices',
  disable: 'disable-devices',
  reenable: 'reenable-devices',
  deprovision: 'deprovision-devices',
};

/**
 * The stored action of each public command or status job action. The action filter needs this
 * direction: both commands share the `device-command` kind, and all three status changes share
 * `device-status`, so the stored row decides which job of the kind matches.
 */
const storedActions: Readonly<Partial<Record<JobAction, string>>> = {
  'reboot-devices': 'reboot',
  'wipe-user-data': 'wipe-users',
  'powerwash-devices': 'powerwash',
  'disable-devices': 'disable',
  'reenable-devices': 'reenable',
  'deprovision-devices': 'deprovision',
};

/** The operation word of each command or status job action. */
const operationWords: Readonly<
  Partial<Record<JobAction, JobOperation['operation']>>
> = {
  'reboot-devices': 'reboot',
  'wipe-user-data': 'wipe-users',
  'powerwash-devices': 'powerwash',
  'disable-devices': 'disable',
  'reenable-devices': 'reenable',
  'deprovision-devices': 'deprovision',
};

/** One job header row as a summary of section 2.5. */
export function jobSummary(row: Record<string, unknown>): JobSummary {
  const total =
    row['target_count'] == null ? null : Number(row['target_count']);
  const succeeded = counted(row['succeeded']);
  const failed = counted(row['failed']);
  const unknown = counted(row['unknown']);
  const skipped = counted(row['skipped']);
  const expired = counted(row['expired']);
  const cancelled = counted(row['cancelled']);
  return jobSummarySchema.parse({
    jobId: row['job_id'],
    displayId: row['display_id'],
    revision: Number(row['revision']),
    action:
      row['kind'] === 'inventory-refresh'
        ? 'refresh-inventory'
        : (writeActions[String(row['action'])] ?? 'update-device-annotations'),
    status: row['status'],
    scope: { kind: row['scope_kind'], deviceCount: total },
    requestedBy: {
      id: row['requested_by'],
      displayName: row['requested_by_name'],
    },
    createdAt: measuredAt(row['created_at']),
    startedAt: measuredAtOrNull(row['started_at']),
    finishedAt: measuredAtOrNull(row['finished_at']),
    progress: {
      total,
      succeeded,
      failed,
      unknown,
      skipped,
      expired,
      // An operation that never left the worker has settled, so it is not pending (design section 1).
      cancelled,
      pending:
        total === null
          ? null
          : Math.max(
              0,
              total -
                succeeded -
                failed -
                unknown -
                skipped -
                expired -
                cancelled,
            ),
    },
    failure: row['failure'],
    // The stored request, with the person in the shape of requestedBy (design section 5).
    cancelRequest:
      row['cancel_requested_at'] == null
        ? null
        : {
            at: measuredAt(row['cancel_requested_at']),
            by: {
              id: row['cancel_requested_by'],
              displayName: row['cancel_requested_by_name'],
            },
          },
  });
}

/** The field IDs of an update operation, in contract order (design addendum section 1). */
const operationFieldOrder = [
  'annotatedLocation',
  'annotatedAssetId',
  'annotatedUser',
  'notes',
  'orgUnitPath',
] as const;

/**
 * The operation page cursor of section 2.5: the operation number and the field position of the
 * last row. A command or status row holds position 0 (design addendum section 1).
 */
export function operationCursor(row: Record<string, unknown>): string {
  return `${String(row['operation_number'])}:${Number(row['field_position'] ?? 0)}`;
}

/**
 * The cursor shape of the operations route. The route answers `<number>:<position>`, so the query
 * schema accepts the cursor that the route itself returned. `decodeOperationCursor` bounds each
 * position and answers `job-not-found` for a cursor outside the domain.
 */
export const operationCursorSchema = z.string().regex(/^\d+:\d+$/);

export function decodeOperationCursor(
  cursor: string | undefined,
): { number: number; position: number } | null {
  if (!cursor) return null;
  const [number, position, ...rest] = cursor.split(':');
  const parsedNumber = Number(number);
  const parsedPosition = Number(position);
  if (
    rest.length === 0 &&
    Number.isInteger(parsedNumber) &&
    parsedNumber >= 1 &&
    Number.isInteger(parsedPosition) &&
    parsedPosition >= 0
  )
    return { number: parsedNumber, position: parsedPosition };
  throw new NotFoundException({ reason: 'job-not-found' });
}

/** The operation word of one row: the write action, the Move of a path, or the field mode. */
function operationOf(
  row: Record<string, unknown>,
  field: JobOperation['field'],
): JobOperation['operation'] {
  const action = writeActions[String(row['action'])];
  const word = action === undefined ? undefined : operationWords[action];
  if (word !== undefined) return word;
  // Organization unit offers Move alone (design addendum section 1).
  if (field === 'orgUnitPath') return 'move';
  // Each annotation field row carries its own request, and a null request is the Clear mode
  // (addendum section 2). The job-wide header names no field, so the row decides its mode.
  if (field !== null)
    return row['field_requested_value'] == null ? 'clear' : 'replace';
  return 'replace';
}

/**
 * One operation row. A dispatched or issued operation reads pending (section 2.2). An update row
 * reads its baseline, request, and observation from its field row, so every row of one device
 * carries the result of that device's one PATCH (design addendum section 1).
 */
export function jobOperation(
  row: Record<string, unknown>,
  displayId: string,
): JobOperation {
  const status = String(row['status']);
  const field = (row['field'] as JobOperation['field']) ?? null;
  const number = String(row['operation_number']);
  const fieldValue = (name: string): string | null =>
    field === null
      ? ((row[name] as string | null) ?? null)
      : ((row[`field_${name}`] as string | null) ?? null);
  return {
    operationId:
      field === null
        ? `${displayId}-${number}`
        : `${displayId}-${number}-${field}`,
    deviceId: String(row['device_id']),
    serialNumber: String(row['serial_number'] ?? ''),
    orgUnitPath: String(row['org_unit_path'] ?? ''),
    field,
    operation: operationOf(row, field),
    baselineValue: fieldValue('baseline_value'),
    requestedValue: fieldValue('requested_value'),
    outcome:
      status === 'dispatched' || status === 'issued'
        ? 'pending'
        : (status as JobOperation['outcome']),
    outcomeReason: (row['outcome_reason'] as string | null) ?? null,
    googleStatus:
      row['google_status'] == null ? null : Number(row['google_status']),
    googleReason: (row['google_reason'] as string | null) ?? null,
    observedValue: fieldValue('observed_value'),
    verifiedBy: (row['verified_by'] as JobOperation['verifiedBy']) ?? null,
    commandId: (row['command_id'] as string | null) ?? null,
    // The stored last observation stays as evidence. The API exposes it only while the command is issued.
    commandState:
      status === 'issued'
        ? ((row['command_state'] as JobOperation['commandState']) ?? null)
        : null,
    commandExpiresAt: measuredAtOrNull(row['command_expires_at']),
    commandExecutedAt: measuredAtOrNull(row['command_executed_at']),
    updatedAt: measuredAt(row['updated_at']),
  };
}

/** Latest activity of one job (section 2.5). Counts come from the job counters, never from the page. */
export function latestActivity(
  job: Record<string, unknown>,
  failed: readonly Record<string, unknown>[],
  unknown: readonly Record<string, unknown>[],
  displayId: string,
): JobLatestActivity {
  return {
    at: measuredAt(job['changed_at']),
    failed: {
      count: counted(job['failed']),
      operations: failed.map(
        (row): JobFailedActivityOperation => ({
          operationId: `${displayId}-${row['operation_number']}`,
          deviceId: String(row['device_id']),
          serialNumber: String(row['serial_number'] ?? ''),
          outcomeReason: (row['outcome_reason'] as string | null) ?? null,
          googleStatus:
            row['google_status'] == null ? null : Number(row['google_status']),
          googleReason: (row['google_reason'] as string | null) ?? null,
          updatedAt: measuredAt(row['updated_at']),
        }),
      ),
    },
    unknown: {
      count: counted(job['unknown']),
      operations: unknown.map(
        (row): JobUnknownActivityOperation => ({
          operationId: `${displayId}-${row['operation_number']}`,
          deviceId: String(row['device_id']),
          serialNumber: String(row['serial_number'] ?? ''),
          updatedAt: measuredAt(row['updated_at']),
        }),
      ),
    },
  };
}

/**
 * The jobs reads of section 2.5. Every read applies `cc.job_visible` and resolves the display ID
 * to the job ID (section 1.6).
 */
export class Jobs {
  private readonly database: JobsDatabase;

  constructor(database: JobsDatabase) {
    this.database = database;
  }

  private actor(session: SessionResponse): [string, number] {
    return [session.identity.id, session.identity.permissionVersion];
  }

  private async rows(text: string, values: unknown[] = []) {
    try {
      return (await this.database.connection.query(text, values)).rows;
    } catch (error) {
      translate(error);
    }
  }

  /** The connected customer of a caller with jobs:read or devices:read (eng-lead ruling 1). */
  async customer(session: SessionResponse): Promise<string> {
    const rows = await this.rows(
      'SELECT r.customer_id FROM cc.job_reader($1,$2) r',
      this.actor(session),
    );
    const customerId = rows[0]?.['customer_id'];
    if (typeof customerId !== 'string')
      throw new ServiceUnavailableException({ reason: 'connection-required' });
    return customerId;
  }

  /** True when `cc.job_visible` passes for one requested-by principal (the Jobs stream). */
  async visible(
    session: SessionResponse,
    customerId: string,
    requestedBy: string,
  ): Promise<boolean> {
    const rows = await this.rows(
      'SELECT cc.job_visible($1,$2,$3,$4) AS visible',
      [...this.actor(session), customerId, requestedBy],
    );
    return rows[0]?.['visible'] === true;
  }

  async list(
    session: SessionResponse,
    customerId: string,
    filters: JobFilters,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<JobList> {
    const actor = this.actor(session);
    const pageSize = Math.min(Math.max(limit ?? 50, 1), 100);
    const after = decodeCursor(cursor);
    const build = (paged: boolean) => {
      const values: unknown[] = [...actor, customerId];
      const where = [
        'j.customer_id=$3',
        'cc.job_visible($1,$2,$3,j.requested_by)',
      ];
      const add = (value: unknown) => {
        values.push(value);
        return `$${values.length}`;
      };
      if (filters.jobId) where.push(`j.display_id=${add(filters.jobId)}`);
      if (filters.status?.length)
        where.push(`j.status=ANY(${add(filters.status)}::text[])`);
      if (filters.action?.length) {
        const kinds = [
          ...new Set(filters.action.map((action) => actionKinds[action])),
        ];
        where.push(`j.kind=ANY(${add(kinds)}::text[])`);
        // Both commands share one kind, and so do the three status changes. The stored action
        // narrows each single action, and a mix keeps one predicate that admits every chosen one.
        const stored = filters.action
          .map((action) => storedActions[action])
          .filter((action): action is string => action !== undefined);
        if (stored.length > 0)
          where.push(
            `(j.kind NOT IN ('device-command','device-status') OR u.action=ANY(${add(stored)}::text[]))`,
          );
      }
      if (filters.entityType?.length && !filters.entityType.includes('device'))
        where.push('false');
      if (filters.requestedBy?.length)
        where.push(`j.requested_by=ANY(${add(filters.requestedBy)}::uuid[])`);
      if (filters.createdFrom)
        where.push(`j.created_at>=${add(filters.createdFrom)}::timestamptz`);
      if (filters.createdTo)
        where.push(`j.created_at<=${add(filters.createdTo)}::timestamptz`);
      if (filters.finishedFrom)
        where.push(`j.finished_at>=${add(filters.finishedFrom)}::timestamptz`);
      if (filters.finishedTo)
        where.push(`j.finished_at<=${add(filters.finishedTo)}::timestamptz`);
      if (paged && after)
        where.push(
          `(j.created_at,j.display_id)<(${add(after.createdAt)}::timestamptz,${add(after.displayId)})`,
        );
      return { values, where: where.join(' AND ') };
    };
    const countedQuery = build(false);
    const countedRow = (
      await this.rows(
        `SELECT count(*)::int AS matching, clock_timestamp() AS observed_at
          FROM cc.jobs j LEFT JOIN cc.device_update_jobs u ON u.job_id=j.job_id
          WHERE ${countedQuery.where}`,
        countedQuery.values,
      )
    )[0];
    const pageQuery = build(true);
    const rows = await this.rows(
      `SELECT j.*, u.action, p.display_name AS requested_by_name,
        cb.display_name AS cancel_requested_by_name,
        to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
        FROM cc.jobs j JOIN cc.application_principals p ON p.id=j.requested_by
        LEFT JOIN cc.application_principals cb ON cb.id=j.cancel_requested_by
        LEFT JOIN cc.device_update_jobs u ON u.job_id=j.job_id
        WHERE ${pageQuery.where}
        ORDER BY j.created_at DESC, j.display_id DESC
        LIMIT $${pageQuery.values.length + 1}`,
      [...pageQuery.values, pageSize + 1],
    );
    const page = rows.slice(0, pageSize);
    return jobListSchema.parse({
      jobs: page.map(jobSummary),
      matching: counted(countedRow?.['matching']),
      nextCursor:
        rows.length > pageSize && page.length > 0
          ? encodeCursor(page[page.length - 1])
          : null,
      observedAt: measuredAt(countedRow?.['observed_at']),
    });
  }

  /** The header of one visible job, with the write rows and the confirmer of a write job. */
  private async header(
    session: SessionResponse,
    customerId: string,
    displayId: string,
  ): Promise<Record<string, unknown> | undefined> {
    return (
      await this.rows(
        `SELECT j.*, p.display_name AS requested_by_name,
          cb.display_name AS cancel_requested_by_name,
          u.confirmed_by, u.action, c.changes, pr.deprovision_reason,
          cp.display_name AS confirmed_by_name, pr.display_id AS preview_display_id
        FROM cc.jobs j
        JOIN cc.application_principals p ON p.id=j.requested_by
        LEFT JOIN cc.application_principals cb ON cb.id=j.cancel_requested_by
        LEFT JOIN cc.device_update_jobs u ON u.job_id=j.job_id
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            jsonb_strip_nulls(jsonb_build_object('field',ch.field,'mode',ch.mode,'value',ch.value))
            ORDER BY array_position($5::text[],ch.field)) AS changes
          FROM cc.device_update_changes ch WHERE ch.preview_id=u.preview_id) c ON true
        LEFT JOIN cc.application_principals cp ON cp.id=u.confirmed_by
        LEFT JOIN cc.device_update_previews pr ON pr.preview_id=u.preview_id
        WHERE j.customer_id=$3 AND j.display_id=$4
          AND cc.job_visible($1,$2,$3,j.requested_by)`,
        [...this.actor(session), customerId, displayId, operationFieldOrder],
      )
    )[0];
  }

  private async samples(
    jobId: unknown,
    status: 'failed' | 'unknown',
  ): Promise<Record<string, unknown>[]> {
    return this.rows(
      `SELECT operation_number,device_id,serial_number,outcome_reason,google_status,
        google_reason,updated_at FROM cc.device_update_operations
      WHERE job_id=$1 AND status=$2
      ORDER BY updated_at DESC, operation_number ASC LIMIT 3`,
      [jobId, status],
    );
  }

  async detail(
    session: SessionResponse,
    customerId: string,
    displayId: string,
  ): Promise<JobDetail> {
    const job = await this.header(session, customerId, displayId);
    if (!job) throw new NotFoundException({ reason: 'job-not-found' });
    const [failed, unknown] = await Promise.all([
      this.samples(job['job_id'], 'failed'),
      this.samples(job['job_id'], 'unknown'),
    ]);
    return jobDetailSchema.parse({
      ...jobSummary(job),
      confirmedBy:
        job['confirmed_by'] == null
          ? null
          : {
              id: job['confirmed_by'],
              displayName: job['confirmed_by_name'],
            },
      previewDisplayId: job['preview_display_id'] ?? null,
      changes: job['changes'] ?? null,
      commandType:
        job['action'] === 'reboot'
          ? 'REBOOT'
          : job['action'] === 'wipe-users'
            ? 'WIPE_USERS'
            : job['action'] === 'powerwash'
              ? 'REMOTE_POWERWASH'
              : null,
      statusAction:
        job['action'] === 'disable' ||
        job['action'] === 'reenable' ||
        job['action'] === 'deprovision'
          ? job['action']
          : null,
      deprovisionReason: job['deprovision_reason'] ?? null,
      targetOrgUnitPaths: job['target_org_unit_paths'] ?? null,
      correlationId: job['correlation_id'],
      latestActivity: latestActivity(
        job,
        failed,
        unknown,
        String(job['display_id']),
      ),
    });
  }

  async operations(
    session: SessionResponse,
    customerId: string,
    displayId: string,
    attention: boolean,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<JobOperationsPage> {
    const job = await this.header(session, customerId, displayId);
    if (!job) throw new NotFoundException({ reason: 'job-not-found' });
    const pageSize = Math.min(Math.max(limit ?? 100, 1), 1000);
    // An update job answers one row per operation and field, so the cursor is "<number>:<position>"
    // (design addendum section 1).
    const after = decodeOperationCursor(cursor);
    const rows = await this.rows(
      `SELECT o.*, u.action, f.field,
        f.baseline_value AS field_baseline_value,
        f.requested_value AS field_requested_value,
        f.observed_value AS field_observed_value,
        CASE WHEN f.field IS NULL THEN 0
          ELSE array_position($7::text[],f.field) END AS field_position
        FROM cc.device_update_operations o
        JOIN cc.jobs j ON j.job_id=o.job_id
        LEFT JOIN cc.device_update_jobs u ON u.job_id=o.job_id
        LEFT JOIN cc.device_update_operation_fields f
          ON f.job_id=o.job_id AND f.operation_number=o.operation_number
        WHERE j.customer_id=$3 AND j.display_id=$4
          AND cc.job_visible($1,$2,$3,j.requested_by)
          AND ($5::boolean IS NOT TRUE OR o.status IN ('failed','unknown','expired'))
          AND ($6::integer IS NULL OR (o.operation_number,
            CASE WHEN f.field IS NULL THEN 0 ELSE array_position($7::text[],f.field) END)
            > ($6::integer,$8::integer))
        ORDER BY o.operation_number, field_position LIMIT $9`,
      [
        ...this.actor(session),
        customerId,
        displayId,
        attention,
        after?.number ?? null,
        operationFieldOrder,
        after?.position ?? null,
        pageSize + 1,
      ],
    );
    const page = rows.slice(0, pageSize);
    return jobOperationsPageSchema.parse({
      operations: page.map((row) => jobOperation(row, displayId)),
      nextCursor:
        rows.length > pageSize && page.length > 0
          ? operationCursor(page[page.length - 1]!)
          : null,
    });
  }

  /**
   * Reconcile one `unknown` operation (design section 2.6). The route claims the read-back with a new
   * attempt and starts one reconcile flow. An operation under a live read-back lease claims nothing,
   * so it answers 202 without a second flow.
   *
   * The permission checks run in the order of the route: `jobs:read` before the job lookup, then the
   * write permission of the operation kind (design section 6). A refused request claims nothing.
   */
  async reconcile(
    session: SessionResponse,
    customerId: string,
    displayId: string,
    operationNumber: number,
    correlationId: string,
    orchestration: JobServiceOrchestration,
    authorize: ReconcileAuthorizer,
  ): Promise<JobOperation> {
    // The job read comes first, so a caller without it learns nothing about the job.
    await authorize('read');
    const job = await this.header(session, customerId, displayId);
    if (!job) throw new NotFoundException({ reason: 'job-not-found' });
    const jobId = String(job['job_id']);
    const row = (
      await this.rows(
        `SELECT o.*, u.action, f.field,
          f.baseline_value AS field_baseline_value,
          f.requested_value AS field_requested_value,
          f.observed_value AS field_observed_value,
          CASE WHEN f.field IS NULL THEN 0
            ELSE array_position($6::text[],f.field) END AS field_position
          FROM cc.device_update_operations o
          JOIN cc.jobs j ON j.job_id=o.job_id
          JOIN cc.device_update_jobs u ON u.job_id=o.job_id
          LEFT JOIN cc.device_update_operation_fields f
            ON f.job_id=o.job_id AND f.operation_number=o.operation_number
          WHERE j.customer_id=$3 AND j.display_id=$4
            AND cc.job_visible($1,$2,$3,j.requested_by) AND o.operation_number=$5
          ORDER BY field_position LIMIT 1`,
        [
          ...this.actor(session),
          customerId,
          displayId,
          operationNumber,
          operationFieldOrder,
        ],
      )
    )[0];
    // A refresh job holds no operation rows, so it also answers operation-not-found.
    if (!row) throw new NotFoundException({ reason: 'operation-not-found' });
    const operation = operationOf(
      row,
      (row['field'] as JobOperation['field']) ?? null,
    );
    // A command operation has no Reconcile: record default 4 keeps a lost answer unknown, and the
    // job ends as Needs review (section 4 step 11). The rule covers Wipe user data and Powerwash
    // beside Reboot. No permission allows it.
    if (
      operation === 'reboot' ||
      operation === 'wipe-users' ||
      operation === 'powerwash'
    )
      throw new ConflictException({ reason: 'reconcile-unsupported' });
    // A status operation reads the status back, so it takes the permission of its action instead
    // of `devices:write`. A Deprovision takes `devices:deprovision` (record default 4).
    await authorize(
      operation === 'disable' || operation === 'reenable'
        ? 'status'
        : operation === 'deprovision'
          ? 'deprovision'
          : 'update',
    );
    if (String(row['status']) !== 'unknown')
      throw new ConflictException({ reason: 'operation-settled' });
    const attempt = randomUUID();
    const claimed = (
      await this.rows(
        `SELECT cc.claim_device_update_verification($1,$2,$3::jsonb,$4,$5,$6) AS result`,
        [
          customerId,
          jobId,
          JSON.stringify([operationNumber]),
          attempt,
          null,
          null,
        ],
      )
    )[0];
    const held = Array.isArray(claimed?.['result']) ? claimed['result'] : [];
    if (held.length > 0) {
      try {
        await orchestration.startDeviceUpdateReconcile({
          customerId,
          jobId,
          operationNumber,
          verifyAttempt: attempt,
          correlationId,
        });
      } catch {
        // The claim expires after 120 seconds, so the person can try again (design 653).
        throw new ServiceUnavailableException({
          reason: 'reconcile-unavailable',
        });
      }
    }
    return jobOperation(row, displayId);
  }

  /**
   * Request the cancel of one job (design section 5). The SQL function decides every refusal, so
   * the API reads nothing before it answers. A stored request answers its current summary, also
   * after the job ends, and writes no second audit row.
   */
  async cancel(
    session: SessionResponse,
    customerId: string,
    displayId: string,
    correlationId: string,
  ): Promise<JobSummary> {
    let rows: Record<string, unknown>[];
    try {
      rows = (
        await this.database.connection.query(
          'SELECT cc.request_job_cancel($1,$2,$3,$4,$5) AS result',
          [...this.actor(session), customerId, displayId, correlationId],
        )
      ).rows;
    } catch (error) {
      translateCancel(error);
    }
    const result = rows[0]?.['result'];
    const outcome =
      result && typeof result === 'object' && 'outcome' in result
        ? result.outcome
        : null;
    if (outcome !== 'requested' && outcome !== 'repeated')
      throw new ServiceUnavailableException({
        reason: 'job-store-unavailable',
      });
    const job = await this.header(session, customerId, displayId);
    if (!job) throw new NotFoundException({ reason: 'job-not-found' });
    return jobSummary(job);
  }

  async activity(
    session: SessionResponse,
    customerId: string,
  ): Promise<JobActivity> {
    const actor = this.actor(session);
    const visible = `j.customer_id=$3 AND cc.job_visible($1,$2,$3,j.requested_by)`;
    const nowRow = (await this.rows('SELECT clock_timestamp() AS now'))[0];
    const observedAt = measuredAt(nowRow?.['now']);
    const seenRow = (
      await this.rows(
        'SELECT seen_at FROM cc.job_activity_seen WHERE principal_id=$1',
        [actor[0]],
      )
    )[0];
    const seenAt = measuredAtOrNull(seenRow?.['seen_at']);
    const runningCount = (
      await this.rows(
        `SELECT count(*)::int AS count FROM cc.jobs j WHERE ${visible} AND j.status IN ('running','awaiting-devices')`,
        [...actor, customerId],
      )
    )[0];
    const running = await this.rows(
      `SELECT j.*, u.action, p.display_name AS requested_by_name,
        cb.display_name AS cancel_requested_by_name FROM cc.jobs j
        JOIN cc.application_principals p ON p.id=j.requested_by
        LEFT JOIN cc.application_principals cb ON cb.id=j.cancel_requested_by
        LEFT JOIN cc.device_update_jobs u ON u.job_id=j.job_id
        WHERE ${visible} AND j.status IN ('running','awaiting-devices')
        ORDER BY j.created_at DESC, j.display_id DESC LIMIT ${ACTIVITY_RUNNING_ROWS}`,
      [...actor, customerId],
    );
    const waitingCount = (
      await this.rows(
        `SELECT count(*)::int AS count FROM cc.jobs j
          WHERE ${visible} AND j.status IN ('accepted','queued','held')`,
        [...actor, customerId],
      )
    )[0];
    const waiting = await this.rows(
      `SELECT j.*, u.action, p.display_name AS requested_by_name,
        cb.display_name AS cancel_requested_by_name FROM cc.jobs j
        JOIN cc.application_principals p ON p.id=j.requested_by
        LEFT JOIN cc.application_principals cb ON cb.id=j.cancel_requested_by
        LEFT JOIN cc.device_update_jobs u ON u.job_id=j.job_id
        WHERE ${visible} AND j.status IN ('accepted','queued','held')
        ORDER BY j.target_count ASC NULLS LAST, j.created_at ASC, j.display_id ASC
        LIMIT ${ACTIVITY_WAITING_ROWS}`,
      [...actor, customerId],
    );
    const recentCount = (
      await this.rows(
        `SELECT count(*)::int AS count,
          min(j.finished_at) + interval '${ACTIVITY_WINDOW}' AS next_expiry_at
        FROM cc.jobs j
        WHERE ${visible} AND j.finished_at IS NOT NULL
          AND j.finished_at >= clock_timestamp() - interval '${ACTIVITY_WINDOW}'`,
        [...actor, customerId],
      )
    )[0];
    const recent = await this.rows(
      `SELECT j.*, u.action, p.display_name AS requested_by_name,
        cb.display_name AS cancel_requested_by_name FROM cc.jobs j
        JOIN cc.application_principals p ON p.id=j.requested_by
        LEFT JOIN cc.application_principals cb ON cb.id=j.cancel_requested_by
        LEFT JOIN cc.device_update_jobs u ON u.job_id=j.job_id
        WHERE ${visible} AND j.finished_at IS NOT NULL
          AND j.finished_at >= clock_timestamp() - interval '${ACTIVITY_WINDOW}'
        ORDER BY j.finished_at DESC LIMIT ${ACTIVITY_RECENT_ROWS}`,
      [...actor, customerId],
    );
    // The stored seen time is compared in SQL, so database microseconds decide the answer. A
    // cancelled job raises attention only with a failed or Unknown operation (record default 17).
    const attention = (
      await this.rows(
        `SELECT EXISTS(SELECT 1 FROM cc.jobs j WHERE ${visible}
          AND j.finished_at IS NOT NULL
          AND (j.status IN ('needs-review','completed-with-errors','failed')
            OR (j.status='cancelled' AND (j.failed>0 OR j.unknown>0)))
          AND j.finished_at > COALESCE((SELECT s.seen_at FROM cc.job_activity_seen s
            WHERE s.principal_id=$4),'-infinity'::timestamptz)) AS attention`,
        [...actor, customerId, actor[0]],
      )
    )[0];
    return jobActivitySchema.parse({
      running: {
        count: counted(runningCount?.['count']),
        jobs: running.map(jobSummary),
      },
      waiting: {
        count: counted(waitingCount?.['count']),
        jobs: waiting.map(jobSummary),
      },
      recent: {
        count: counted(recentCount?.['count']),
        jobs: recent.map(jobSummary),
        nextExpiryAt: measuredAtOrNull(recentCount?.['next_expiry_at']),
      },
      attention: attention?.['attention'] === true,
      seenAt,
      observedAt,
    });
  }

  async seen(session: SessionResponse): Promise<JobSeen> {
    const rows = await this.rows(
      'SELECT cc.record_job_activity_seen($1,$2) AS seen_at',
      this.actor(session),
    );
    return jobSeenSchema.parse({
      seenAt: measuredAt(rows[0]?.['seen_at']),
    });
  }

  async requesters(
    session: SessionResponse,
    customerId: string,
    query: string,
    limit: number | undefined,
  ): Promise<JobRequesters> {
    const pageSize = Math.min(Math.max(limit ?? 20, 1), 20);
    const rows = await this.rows(
      `SELECT p.id, p.display_name FROM cc.application_principals p
        WHERE p.id IN (SELECT j.requested_by FROM cc.jobs j
          WHERE j.customer_id=$3 AND cc.job_visible($1,$2,$3,j.requested_by)
            AND ($4::text='' OR p.display_name ILIKE $4||'%'))
        ORDER BY p.display_name, p.id LIMIT $5`,
      [...this.actor(session), customerId, query, pageSize],
    );
    return jobRequestersSchema.parse({
      requesters: rows.map((row) => ({
        id: row['id'],
        displayName: row['display_name'],
      })),
    });
  }
}

/**
 * True when the caller holds jobs:read or jobs:manage at platform scope, or at district scope of
 * this customer. jobs:manage holds the job visibility of jobs:read (engineering default 16).
 */
export const jobReadable = (
  session: SessionResponse,
  customerId: string,
): boolean => {
  const scope = { kind: 'district' as const, customerId };
  return (
    isAuthorized(session.identity.grants, 'jobs:read', scope) ||
    isAuthorized(session.identity.grants, 'jobs:manage', scope)
  );
};

/** The Jobs stream and the Jobs list ask the rule of `jobReadable` for every job of a customer. */
export const seesEveryJob = jobReadable;
