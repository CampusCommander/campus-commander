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
  jobDetailSchema,
  jobListSchema,
  jobOperationsPageSchema,
  jobRequestersSchema,
  jobSeenSchema,
  jobSummarySchema,
  type JobAction,
  type JobActivity,
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
  'disable-devices': 'device-status',
  'reenable-devices': 'device-status',
};

/** The job action of one write row. A missing action reads as the annotated-location update. */
const writeActions: Readonly<Record<string, JobAction>> = {
  'annotated-location': 'update-device-annotations',
  reboot: 'reboot-devices',
  disable: 'disable-devices',
  reenable: 'reenable-devices',
};

/** The stored action of each public status action. The action filter needs this direction. */
const storedStatusActions: Readonly<Record<string, string>> = {
  'disable-devices': 'disable',
  'reenable-devices': 'reenable',
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
      pending:
        total === null
          ? null
          : Math.max(
              0,
              total - succeeded - failed - unknown - skipped - expired,
            ),
    },
    failure: row['failure'],
  });
}

/** The operation word of one row: the write action, or the annotated-location mode. */
function operationOf(row: Record<string, unknown>): JobOperation['operation'] {
  const action = writeActions[String(row['action'])];
  if (action === 'reboot-devices') return 'reboot';
  if (action === 'disable-devices') return 'disable';
  if (action === 'reenable-devices') return 'reenable';
  return row['mode'] === 'clear' ? 'clear' : 'replace';
}

/** One operation row. A dispatched or issued operation reads pending (section 2.2). */
export function jobOperation(
  row: Record<string, unknown>,
  displayId: string,
): JobOperation {
  const status = String(row['status']);
  return {
    operationId: `${displayId}-${row['operation_number']}`,
    deviceId: String(row['device_id']),
    serialNumber: String(row['serial_number'] ?? ''),
    orgUnitPath: String(row['org_unit_path'] ?? ''),
    operation: operationOf(row),
    baselineValue: (row['baseline_value'] as string | null) ?? null,
    requestedValue: (row['requested_value'] as string | null) ?? null,
    outcome:
      status === 'dispatched' || status === 'issued'
        ? 'pending'
        : (status as JobOperation['outcome']),
    outcomeReason: (row['outcome_reason'] as string | null) ?? null,
    googleStatus:
      row['google_status'] == null ? null : Number(row['google_status']),
    googleReason: (row['google_reason'] as string | null) ?? null,
    observedValue: (row['observed_value'] as string | null) ?? null,
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
        // The two status actions share one kind, so the detail action decides when only one is chosen.
        const statusActions = filters.action
          .filter((action) => storedStatusActions[action] !== undefined)
          .map((action) => storedStatusActions[action]);
        if (statusActions.length === 1)
          where.push(
            `(j.kind<>'device-status' OR u.action=${add(statusActions[0])})`,
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
        to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
        FROM cc.jobs j JOIN cc.application_principals p ON p.id=j.requested_by
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
          u.confirmed_by, u.action, u.field, u.mode, u.value AS requested_value,
          cp.display_name AS confirmed_by_name, pr.display_id AS preview_display_id
        FROM cc.jobs j
        JOIN cc.application_principals p ON p.id=j.requested_by
        LEFT JOIN cc.device_update_jobs u ON u.job_id=j.job_id
        LEFT JOIN cc.application_principals cp ON cp.id=u.confirmed_by
        LEFT JOIN cc.device_update_previews pr ON pr.preview_id=u.preview_id
        WHERE j.customer_id=$3 AND j.display_id=$4
          AND cc.job_visible($1,$2,$3,j.requested_by)`,
        [...this.actor(session), customerId, displayId],
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
      field: job['field'] ?? null,
      mode: job['mode'] ?? null,
      commandType: job['action'] === 'reboot' ? 'REBOOT' : null,
      statusAction:
        job['action'] === 'disable' || job['action'] === 'reenable'
          ? job['action']
          : null,
      requestedValue: job['requested_value'] ?? null,
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
    const after = cursor ? Number(cursor) : Number.NaN;
    if (cursor && !Number.isInteger(after))
      throw new NotFoundException({ reason: 'job-not-found' });
    const rows = await this.rows(
      `SELECT o.*, u.action, u.mode FROM cc.device_update_operations o
        JOIN cc.jobs j ON j.job_id=o.job_id
        LEFT JOIN cc.device_update_jobs u ON u.job_id=o.job_id
        WHERE j.customer_id=$3 AND j.display_id=$4
          AND cc.job_visible($1,$2,$3,j.requested_by)
          AND ($5::boolean IS NOT TRUE OR o.status IN ('failed','unknown','expired'))
          AND ($6::integer IS NULL OR o.operation_number>$6)
        ORDER BY o.operation_number LIMIT $7`,
      [
        ...this.actor(session),
        customerId,
        displayId,
        attention,
        cursor ? after : null,
        pageSize + 1,
      ],
    );
    const page = rows.slice(0, pageSize);
    return jobOperationsPageSchema.parse({
      operations: page.map((row) => jobOperation(row, displayId)),
      nextCursor:
        rows.length > pageSize && page.length > 0
          ? String(page[page.length - 1]?.['operation_number'])
          : null,
    });
  }

  /**
   * Reconcile one `unknown` operation (design section 2.6). The route claims the read-back with a new
   * attempt and starts one reconcile flow. An operation under a live read-back lease claims nothing,
   * so it answers 202 without a second flow.
   */
  async reconcile(
    session: SessionResponse,
    customerId: string,
    displayId: string,
    operationNumber: number,
    correlationId: string,
    orchestration: JobServiceOrchestration,
  ): Promise<JobOperation> {
    const job = await this.header(session, customerId, displayId);
    if (!job) throw new NotFoundException({ reason: 'job-not-found' });
    const jobId = String(job['job_id']);
    const row = (
      await this.rows(
        `SELECT o.*, u.action, u.mode FROM cc.device_update_operations o
          JOIN cc.jobs j ON j.job_id=o.job_id
          JOIN cc.device_update_jobs u ON u.job_id=o.job_id
          WHERE j.customer_id=$3 AND j.display_id=$4
            AND cc.job_visible($1,$2,$3,j.requested_by) AND o.operation_number=$5`,
        [...this.actor(session), customerId, displayId, operationNumber],
      )
    )[0];
    // A refresh job holds no operation rows, so it also answers operation-not-found.
    if (!row) throw new NotFoundException({ reason: 'operation-not-found' });
    // A command operation has no Reconcile: record default 4 keeps a lost answer unknown, and the
    // job ends as Needs review (section 4 step 11).
    if (String(row['action']) === 'reboot')
      throw new ConflictException({ reason: 'reconcile-unsupported' });
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
      `SELECT j.*, u.action, p.display_name AS requested_by_name FROM cc.jobs j
        JOIN cc.application_principals p ON p.id=j.requested_by
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
      `SELECT j.*, u.action, p.display_name AS requested_by_name FROM cc.jobs j
        JOIN cc.application_principals p ON p.id=j.requested_by
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
      `SELECT j.*, u.action, p.display_name AS requested_by_name FROM cc.jobs j
        JOIN cc.application_principals p ON p.id=j.requested_by
        LEFT JOIN cc.device_update_jobs u ON u.job_id=j.job_id
        WHERE ${visible} AND j.finished_at IS NOT NULL
          AND j.finished_at >= clock_timestamp() - interval '${ACTIVITY_WINDOW}'
        ORDER BY j.finished_at DESC LIMIT ${ACTIVITY_RECENT_ROWS}`,
      [...actor, customerId],
    );
    // The stored seen time is compared in SQL, so database microseconds decide the answer.
    const attention = (
      await this.rows(
        `SELECT EXISTS(SELECT 1 FROM cc.jobs j WHERE ${visible}
          AND j.finished_at IS NOT NULL
          AND j.status IN ('needs-review','completed-with-errors','failed')
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

/** True when the caller holds jobs:read at platform scope or district scope of this customer. */
export const seesEveryJob = (
  session: SessionResponse,
  customerId: string,
): boolean =>
  isAuthorized(session.identity.grants, 'jobs:read', {
    kind: 'district',
    customerId,
  });
