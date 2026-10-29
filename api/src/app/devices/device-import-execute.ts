import {
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  DEPROVISION_REASONS,
  DEVICE_ACTION_PHRASES,
  deviceImportExecuteAnswerSchema,
  deviceImportJobReceiptSchema,
  deviceImportNotRunReasonSchema,
  type DeprovisionReason,
  type DeviceAction,
  type DeviceImportExecuteAnswer,
  type DeviceImportExecuteRequest,
  type DeviceImportJobReceipt,
  type DeviceImportNotRunReason,
  type DeviceStatusAction,
  type DeviceSyncState,
  type JobAction,
  type SessionResponse,
} from '@campus/application-contracts';
import {
  actionManifestDigest,
  actionTargets,
  statusExclusion,
  type ActionDigestTarget,
  type ActionPreviewTarget,
} from './device-actions';
import {
  ManifestDigest,
  deviceWriteFunctionError,
  editPreviewTargets,
  measuredAt,
  targetDocument,
  type PreviewTarget,
} from './device-updates';
import { importPlanAnswer } from './device-imports';

/**
 * Execute of one import plan
 * (`docs/superpowers/specs/2026-10-28-device-export-import-design.md`, section 7, card XBA).
 * One transaction runs the recheck of the route, the typed phrase, the plan lock, the paged plan
 * read, the conflict split, one preview per action and reason, and the links. A refusal rolls back
 * every job.
 */

/** One page of Execute holds 250 devices (design section 7, step 4). */
const PAGE_SIZE = 250;

/** A preview of Execute lives 15 minutes, as the built preview routes do. */
const PREVIEW_MINUTES = 15;

/**
 * The largest manifest that Execute streams. The seal keeps 100,000 targets, and a target holds at
 * most 51,648 UTF-16 units, which JSON escapes into at most six characters each. 64 GiB stays above
 * that arithmetic bound of the target domain.
 */
const MANIFEST_MAX_BYTES = 64 * 1024 * 1024 * 1024;

/** The status actions of a plan, in the run order of their jobs (design section 7, step 8). */
const STATUS_ACTIONS: readonly DeviceStatusAction[] = [
  'disable',
  'reenable',
  'deprovision',
];

/**
 * The action of one preview of Execute: the edit list or one of the device actions. The preview
 * table names the edit list `annotated-location`, which no device action carries.
 */
type PreviewAction = 'annotated-location' | DeviceAction;

/** The job action of each preview action (design section 1, `ac/device-import.ts`). */
const JOB_ACTION: Readonly<Record<PreviewAction, JobAction>> = Object.freeze({
  'annotated-location': 'update-device-annotations',
  reboot: 'reboot-devices',
  'wipe-users': 'wipe-user-data',
  powerwash: 'powerwash-devices',
  disable: 'disable-devices',
  reenable: 'reenable-devices',
  deprovision: 'deprovision-devices',
});

/** The job row that Execute names. Another customer, another kind, and an invisible job read 404. */
const planJobSql = `SELECT j.job_id,j.display_id,j.requested_by
  FROM cc.jobs j JOIN cc.device_import_jobs i ON i.job_id=j.job_id
  WHERE j.customer_id=$1 AND j.display_id=$2 AND j.kind='device-import'
    AND cc.job_visible($3,$4,$1,j.requested_by)`;

/** The plan holds a Deprovision, so its Execute needs the typed phrase (design section 7, step 2). */
const phraseSql = `SELECT count(*)::integer AS rows FROM cc.device_import_changes
  WHERE job_id=$1 AND change_type='status' AND status_action='deprovision'`;

const lockSql =
  'SELECT cc.lock_device_import_plan($1::uuid,$2::integer,$3::text,$4::uuid,$5::uuid,$6::integer) AS result';

/**
 * One page of the plan with the current values of each device (design section 7, step 4). The page
 * names 250 devices in `COLLATE "C"` order, which is the JavaScript order of plain device IDs, and
 * a page holds every change row of each of its devices. The client binds the next device ID, so no
 * call reads two pages.
 */
const pageSql = `WITH page AS (
    SELECT c.device_id AS device_id FROM cc.device_import_changes c
    WHERE c.job_id=$1 AND ($2::text IS NULL OR c.device_id COLLATE "C">$2)
    GROUP BY c.device_id ORDER BY c.device_id COLLATE "C" LIMIT $3)
  SELECT p.device_id,c.ordinal,c.change_type,c.field,c.mode,c.status_action,c.deprovision_reason,
    c.current_value,c.new_value,c.not_run_reason,c.linked_job_id,
    d.device_id AS found_device_id,d.serial_number,d.org_unit_path,d.annotated_location,d.asset_tag,
    d.annotated_user,d.notes,d.status,d.status_observed_at,d.last_entity_sync,d.removed_at
  FROM page p
  JOIN cc.device_import_changes c ON c.job_id=$1 AND c.device_id=p.device_id
  LEFT JOIN cc.devices d ON d.customer_id=$4 AND d.device_id=p.device_id
  ORDER BY p.device_id COLLATE "C",c.ordinal`;

const markSql =
  'SELECT cc.mark_device_import_changes($1::uuid,$2::integer,$3::text,$4::uuid,$5::uuid,$6::jsonb,$7::jsonb) AS result';

const openSql =
  'SELECT cc.open_device_update_preview($1::uuid,$2::integer,$3::text,$4::integer,$5::text,$6::jsonb,$7::integer,$8::text) AS result';

const addSql =
  'SELECT cc.add_device_update_preview_targets($1::uuid,$2::integer,$3::text,$4::uuid,$5::jsonb) AS result';

const sealSql =
  'SELECT cc.seal_device_update_preview($1::uuid,$2::integer,$3::text,$4::uuid,$5::text) AS result';

const manifestPageSql =
  'SELECT cc.read_device_update_preview_manifest_page($1::uuid,$2::integer,$3::text,$4::uuid,$5::integer) AS result';

const confirmSql =
  'SELECT cc.confirm_device_update_preview($1::uuid,$2::integer,$3::text,$4::uuid,$5::text,$6::text,$7::uuid,$8::text) AS result';

const linkSql =
  'SELECT cc.link_device_import_jobs($1::uuid,$2::integer,$3::text,$4::uuid,$5::uuid,$6::jsonb,$7::jsonb,$8::uuid) AS result';

/** The changes that Execute left out, as the answer and the report count them. */
const countsSql = `SELECT count(*) FILTER (WHERE not_run_reason='changed-after-validation')::integer
    AS conflicts,
  count(*) FILTER (WHERE not_run_reason IN ('status-unknown','device-deprovisioned','device-active',
    'device-disabled'))::integer AS excluded
  FROM cc.device_import_changes WHERE job_id=$1`;

/** The action of each job that a receipt names. The receipt of `cc.device_update_receipt` holds none. */
const receiptActionSql = `SELECT u.job_id,u.action FROM cc.jobs j
  JOIN cc.device_update_jobs u ON u.job_id=j.job_id
  WHERE j.job_id=ANY($1::uuid[]) AND j.customer_id=$2`;

interface QueryResult {
  rows: Record<string, unknown>[];
}
interface QueryClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}
export interface ExecuteDatabase {
  connection: QueryClient;
  transaction<T>(run: (client: QueryClient) => Promise<T>): Promise<T>;
}
export interface ExecuteStorage {
  storeJsonStream(source: AsyncIterable<Buffer>, maxBytes: number): Promise<string>;
}
export interface ExecuteAdmission {
  admit(customerId: string): Promise<boolean>;
}

/** One change that Execute leaves out of its previews, with its reason. */
interface Disposition {
  ordinal: number;
  reason: DeviceImportNotRunReason;
}

/** One status preview target of one page, with its device and its cached status. */
interface StatusTarget {
  target: ActionPreviewTarget;
  action: DeviceStatusAction;
  reason: DeprovisionReason | null;
}

/** The split of one page: what conflicts, what cannot run, and what each preview receives. */
interface PageSplit {
  devices: number;
  conflicts: string[];
  dispositions: Disposition[];
  edits: PreviewTarget[];
  statuses: StatusTarget[];
}

/** One Execute inside its transaction: the wire answer, and whether it created the plan jobs. */
interface LockedOutcome {
  answer: DeviceImportExecuteAnswer;
  created: boolean;
}

/** One preview of the plan, filled page by page (design section 7, steps 9 to 11). */
interface PreviewRun {
  action: PreviewAction;
  reason: DeprovisionReason | null;
  previewId: string | null;
  ordinal: number;
  /** The edit digest of the eligible rows, fed target by target. */
  digest: ManifestDigest;
  /** The two fields of each status device that its digest covers. */
  statuses: ActionDigestTarget[];
}

/** One text value, or null for a column that holds no value. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The status reason of one change, or null for an eligible target. */
function notRunReason(reason: string): DeviceImportNotRunReason {
  return deviceImportNotRunReasonSchema.parse(reason);
}

/** The device row of one change row, in the shape that the builders read. */
function deviceOf(row: Record<string, unknown>): Record<string, unknown> {
  return {
    device_id: row['device_id'],
    serial_number: row['serial_number'],
    org_unit_path: row['org_unit_path'],
    annotated_location: row['annotated_location'],
    asset_tag: row['asset_tag'],
    annotated_user: row['annotated_user'],
    notes: row['notes'],
    status: row['status'],
    status_observed_at: row['status_observed_at'],
    last_entity_sync: row['last_entity_sync'],
    removed_at: row['removed_at'],
  };
}

/** Split one page into conflicts, exclusions, and the targets of each preview (section 7, 5 to 8). */
export function planPage(rows: readonly Record<string, unknown>[]): PageSplit {
  const byDevice = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const deviceId = String(row['device_id']);
    const device = byDevice.get(deviceId);
    if (device) device.push(row);
    else byDevice.set(deviceId, [row]);
  }
  const split: PageSplit = {
    devices: byDevice.size,
    conflicts: [],
    dispositions: [],
    edits: [],
    statuses: [],
  };
  for (const [deviceId, deviceRows] of byDevice) {
    const first = deviceRows[0] as Record<string, unknown>;
    const open = deviceRows.filter(
      (row) => row['not_run_reason'] == null && row['linked_job_id'] == null,
    );
    if (open.length === 0) continue;
    // A device that left the inventory keeps no preview and no job (design section 3).
    if (first['found_device_id'] == null || first['removed_at'] != null) {
      for (const row of open)
        split.dispositions.push({
          ordinal: Number(row['ordinal']),
          reason: 'removed',
        });
      continue;
    }
    const device = deviceOf(first);
    const fieldRows = open.filter((row) => row['change_type'] === 'field');
    if (fieldRows.length > 0) {
      // One row per field, in ordinal order, with the value that validation compared (section 7, 7).
      const seen = new Set<string>();
      const edits = fieldRows
        .slice()
        .sort((left, right) => Number(left['ordinal']) - Number(right['ordinal']))
        .filter((row) => {
          const field = String(row['field']);
          if (seen.has(field)) return false;
          seen.add(field);
          return true;
        })
        .map((row) => ({
          deviceId,
          field: row['field'] as PreviewTarget['fields'][number]['field'],
          mode: row['mode'] as 'replace' | 'clear' | 'move',
          ...(row['mode'] === 'clear' ? {} : { value: String(row['new_value']) }),
          baselineValue: textOrNull(row['current_value']),
        }));
      const target = editPreviewTargets([device], edits)[0] as PreviewTarget;
      if (target.disposition === 'conflict') {
        // One conflict row makes the device a conflict device, and the preview never confirms it.
        split.conflicts.push(deviceId);
        continue;
      }
      if (target.disposition === 'excluded') {
        for (const row of open)
          split.dispositions.push({
            ordinal: Number(row['ordinal']),
            reason: 'removed',
          });
        continue;
      }
      for (const row of fieldRows) {
        const field = target.fields.find(
          (one) => one.field === row['field'],
        );
        if (!field || field.disposition === 'unchanged')
          split.dispositions.push({
            ordinal: Number(row['ordinal']),
            reason: 'no-change-needed',
          });
      }
      if (target.disposition === 'eligible') split.edits.push(target);
    }
    for (const row of open) {
      if (row['change_type'] !== 'status') continue;
      const action = row['status_action'] as DeviceStatusAction;
      const exclusion = statusExclusion(action, textOrNull(row['status']));
      if (exclusion !== null) {
        split.dispositions.push({
          ordinal: Number(row['ordinal']),
          reason: notRunReason(exclusion),
        });
        continue;
      }
      split.statuses.push({
        action,
        reason: (row['deprovision_reason'] as DeprovisionReason | null) ?? null,
        target: actionTargets([device], action)[0] as ActionPreviewTarget,
      });
    }
  }
  return split;
}

/** The status action and reason of one preview, as its key. */
function previewKey(action: PreviewAction, reason: DeprovisionReason | null): string {
  return `${action}\u0000${reason ?? ''}`;
}

/** The run order of the previews: the update job first, then Disable, Re-enable, Deprovision. */
function previewOrder(left: PreviewRun, right: PreviewRun): number {
  const rank = (run: PreviewRun) =>
    run.action === 'annotated-location'
      ? 0
      : STATUS_ACTIONS.indexOf(run.action as DeviceStatusAction) + 1;
  const byAction = rank(left) - rank(right);
  if (byAction !== 0) return byAction;
  return (
    (left.reason === null ? -1 : DEPROVISION_REASONS.indexOf(left.reason)) -
    (right.reason === null ? -1 : DEPROVISION_REASONS.indexOf(right.reason))
  );
}

/** Chunk a list into pages of at most 250 entries. */
function paginate<T>(values: readonly T[]): T[][] {
  const pages: T[][] = [];
  for (let start = 0; start < values.length; start += PAGE_SIZE)
    pages.push(values.slice(start, start + PAGE_SIZE));
  return pages;
}

/**
 * The preview part of one manifest document, in the shape of
 * `cc.read_device_update_preview_manifest` (017-jobs.sql). An edit list stores its requests on its
 * targets, so its change list is empty.
 */
function manifestPreview(row: Record<string, unknown>) {
  return {
    previewId: row['preview_id'],
    displayId: row['display_id'],
    customerId: row['customer_id'],
    createdBy: row['created_by'],
    permissionVersion: row['permission_version'],
    generation: row['generation'],
    action: row['action'],
    deprovisionReason: row['deprovision_reason'] ?? null,
    changes: [],
    selected: row['selected'],
    eligible: row['eligible'],
    unchanged: row['unchanged'],
    excluded: row['excluded'],
    conflicts: row['conflicts'],
    fieldChanges: row['field_changes'],
    oldestObservedAt: measuredAt(row['oldest_observed_at']),
    preparedAt: measuredAt(row['prepared_at']),
    expiresAt: measuredAt(row['expires_at']),
    manifestDigest: row['manifest_digest'],
  };
}

export class DeviceImportExecute {
  private readonly database: ExecuteDatabase;
  private readonly storage: ExecuteStorage;
  private readonly jobs: ExecuteAdmission;
  private readonly clock: () => number;

  constructor(
    database: ExecuteDatabase,
    storage: ExecuteStorage,
    jobs: ExecuteAdmission,
    clock: () => number = () => Date.now(),
  ) {
    this.database = database;
    this.storage = storage;
    this.jobs = jobs;
    this.clock = clock;
  }

  /** Run one SECURITY DEFINER function and return its JSON result. */
  private async call<T>(
    client: QueryClient,
    text: string,
    values: unknown[],
  ): Promise<T> {
    const row = (await client.query(text, values)).rows[0];
    if (!row || row['result'] == null)
      throw new Error('The device import execute function returned no result.');
    return row['result'] as T;
  }

  /**
   * Run the thirteen steps of design section 7 in one transaction, then admit the jobs that it
   * created. A document, a result set, and a call of this method never hold more than one page.
   */
  async execute(
    session: SessionResponse,
    current: DeviceSyncState,
    displayId: string,
    input: DeviceImportExecuteRequest,
    correlationId: string,
  ): Promise<DeviceImportExecuteAnswer> {
    const outcome = await this.database.transaction((client) =>
      this.locked(client, session, current, displayId, input, correlationId),
    );
    // After the commit, run admission (design section 7, step 13). A missed run repeats on the tick.
    // A plan that ran before created no job here, so it admits nothing (step 3).
    if (outcome.created)
      await this.jobs.admit(current.customerId).catch(() => undefined);
    return outcome.answer;
  }

  private async locked(
    client: QueryClient,
    session: SessionResponse,
    current: DeviceSyncState,
    displayId: string,
    input: DeviceImportExecuteRequest,
    correlationId: string,
  ): Promise<LockedOutcome> {
    const actor = session.identity.id;
    // The route already rechecked the three device actions and each status permission of the plan.
    const job = (
      await client.query(planJobSql, [
        current.customerId,
        displayId,
        actor,
        session.identity.permissionVersion,
      ])
    ).rows[0];
    if (!job) throw new NotFoundException({ reason: 'job-not-found' });
    const jobId = String(job['job_id']);
    // Step 2: a plan with a Deprovision needs the typed phrase, trimmed and compared exactly.
    if (this.needsPhrase(await client.query(phraseSql, [jobId]))) {
      if ((input.typedPhrase ?? '').trim() !== DEVICE_ACTION_PHRASES.deprovision)
        throw new UnprocessableEntityException({ reason: 'phrase-mismatch' });
    }
    // Step 3: the plan lock. It takes the global access lock, the IMP header, and the detail row.
    const locked = await this.call<Record<string, unknown>>(
      client,
      lockSql,
      [
        actor,
        session.identity.permissionVersion,
        current.customerId,
        jobId,
        input.planId,
        input.planRevision,
      ],
    );
    const outcome = String(locked['outcome']);
    if (outcome === 'executed')
      return {
        answer: await this.answer(
          client,
          current,
          jobId,
          locked,
          Array.isArray(locked['receipts'])
            ? (locked['receipts'] as Record<string, unknown>[])
            : [],
        ),
        created: false,
      };
    if (outcome === 'conflict')
      throw new ConflictException({
        reason: 'plan-conflict',
        plan: await importPlanAnswer(this.database, this.clock, locked['plan']),
      });
    if (outcome === 'expired')
      throw new GoneException({
        reason: 'plan-expired',
        plan: await importPlanAnswer(this.database, this.clock, locked['plan']),
      });
    if (outcome === 'not-found')
      throw new NotFoundException({ reason: 'job-not-found' });
    if (outcome === 'forbidden')
      throw new ForbiddenException(
        'This action requires additional permission.',
      );
    if (outcome !== 'locked')
      throw new Error(`The plan lock returned ${outcome}.`);

    // Steps 4 to 12: the pages, the split, the previews, and the links.
    const previews = new Map<string, PreviewRun>();
    await this.fill(client, session, current, jobId, input, previews);
    const runs = [...previews.values()].sort(previewOrder);
    if (runs.length === 0)
      throw new ConflictException({ reason: 'nothing-to-run' });
    const receipts: Record<string, unknown>[] = [];
    for (const run of runs)
      receipts.push(
        await this.confirmPreview(client, session, current, input, run),
      );
    const linked = await this.call<Record<string, unknown>>(client, linkSql, [
      actor,
      session.identity.permissionVersion,
      current.customerId,
      jobId,
      input.planId,
      runs.map((run) => run.previewId),
      [],
      correlationId,
    ]);
    return {
      answer: await this.answer(client, current, jobId, linked, receipts),
      created: true,
    };
  }

  /** Whether the plan holds a Deprovision change, which needs the typed phrase. */
  private needsPhrase(result: QueryResult): boolean {
    return Number(result.rows[0]?.['rows'] ?? 0) > 0;
  }

  /** The wire answer of one Execute, after the plan is executed. */
  private async answer(
    client: QueryClient,
    current: DeviceSyncState,
    jobId: string,
    value: Record<string, unknown>,
    receipts: readonly Record<string, unknown>[],
  ): Promise<DeviceImportExecuteAnswer> {
    const outcome = String(value['outcome']);
    if (outcome === 'not-found')
      throw new NotFoundException({ reason: 'job-not-found' });
    if (outcome === 'forbidden')
      throw new ForbiddenException('This action requires additional permission.');
    if (outcome === 'conflict')
      throw new ConflictException({
        reason: 'plan-conflict',
        plan: await importPlanAnswer(this.database, this.clock, value['plan']),
      });
    if (outcome === 'expired')
      throw new GoneException({
        reason: 'plan-expired',
        plan: await importPlanAnswer(this.database, this.clock, value['plan']),
      });
    if (outcome !== 'executed')
      throw new Error(`The executed plan of an Execute answered ${outcome}.`);
    const counts = (await client.query(countsSql, [jobId])).rows[0];
    return deviceImportExecuteAnswerSchema.parse({
      plan: await importPlanAnswer(this.database, this.clock, value['plan']),
      receipts: await this.receipts(client, current, receipts),
      conflicts: Number(counts?.['conflicts'] ?? 0),
      excluded: Number(counts?.['excluded'] ?? 0),
    });
  }

  /**
   * The receipts of the plan jobs, in run order. `cc.device_update_receipt` holds no action, so the
   * route reads the action of each job in one call of at most seven IDs.
   */
  private async receipts(
    client: QueryClient,
    current: DeviceSyncState,
    stored: readonly Record<string, unknown>[],
  ): Promise<DeviceImportJobReceipt[]> {
    const ids = stored.map((receipt) => String(receipt['jobId']));
    if (ids.length === 0) return [];
    const actions = new Map(
      (
        await client.query(receiptActionSql, [ids, current.customerId])
      ).rows.map((row) => [String(row['job_id']), String(row['action'])]),
    );
    return stored.map((receipt) => {
      const action = actions.get(String(receipt['jobId']));
      const jobAction = action ? JOB_ACTION[action as PreviewAction] : undefined;
      if (!jobAction)
        throw new Error(`The receipt names no job action for ${action}.`);
      return deviceImportJobReceiptSchema.parse({
        jobId: receipt['jobId'],
        displayId: receipt['displayId'],
        action: jobAction,
        status: receipt['status'],
        deviceCount: Number(receipt['deviceCount']),
      });
    });
  }

  /** Steps 4 to 9: read the plan in pages of 250 devices, split each page, and fill the previews. */
  private async fill(
    client: QueryClient,
    session: SessionResponse,
    current: DeviceSyncState,
    jobId: string,
    input: DeviceImportExecuteRequest,
    previews: Map<string, PreviewRun>,
  ): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const rows: Record<string, unknown>[] = (
        await client.query(pageSql, [
          jobId,
          after,
          PAGE_SIZE,
          current.customerId,
        ])
      ).rows;
      if (rows.length === 0) return;
      const split = planPage(rows);
      await this.mark(client, session, current, jobId, input, split);
      await this.add(client, session, current, split, previews);
      if (split.devices < PAGE_SIZE) return;
      after = String(rows[rows.length - 1]?.['device_id']);
    }
  }

  /** Step 5: record the conflicts and the exclusions of one page, 250 entries per call. */
  private async mark(
    client: QueryClient,
    session: SessionResponse,
    current: DeviceSyncState,
    jobId: string,
    input: DeviceImportExecuteRequest,
    split: PageSplit,
  ): Promise<void> {
    const devices = paginate(split.conflicts);
    const dispositions = paginate(split.dispositions);
    const calls = Math.max(devices.length, dispositions.length);
    for (let index = 0; index < calls; index += 1) {
      const result = await this.call<Record<string, unknown>>(client, markSql, [
        session.identity.id,
        session.identity.permissionVersion,
        current.customerId,
        jobId,
        input.planId,
        JSON.stringify(devices[index] ?? []),
        JSON.stringify(dispositions[index] ?? []),
      ]);
      if (String(result['outcome']) !== 'marked')
        throw new Error(`The plan marks returned ${String(result['outcome'])}.`);
    }
  }

  /** Steps 7 to 10: fill each preview of one page with at most one page of targets. */
  private async add(
    client: QueryClient,
    session: SessionResponse,
    current: DeviceSyncState,
    split: PageSplit,
    previews: Map<string, PreviewRun>,
  ): Promise<void> {
    if (split.edits.length > 0) {
      const run = this.preview(previews, 'annotated-location', null);
      await this.open(client, session, current, run);
      const page = split.edits.map((target) => ({
        ...target,
        ordinal: run.ordinal++,
      }));
      run.digest.add(page);
      await this.addPage(client, session, current, run, targetDocument(page));
    }
    const grouped = new Map<string, StatusTarget[]>();
    for (const status of split.statuses) {
      const key = previewKey(status.action, status.reason);
      const targets = grouped.get(key);
      if (targets) targets.push(status);
      else grouped.set(key, [status]);
    }
    for (const targets of grouped.values()) {
      const first = targets[0] as StatusTarget;
      const run = this.preview(previews, first.action, first.reason);
      await this.open(client, session, current, run);
      const page = targets.map((entry) => ({
        target: entry.target,
        ordinal: run.ordinal++,
      }));
      for (const entry of page)
        run.statuses.push({
          deviceId: entry.target.deviceId,
          observedStatus: entry.target.observedStatus,
          disposition: 'eligible',
        });
      await this.addPage(
        client,
        session,
        current,
        run,
        page.map((entry) => ({
          ordinal: entry.ordinal,
          device_id: entry.target.deviceId,
          serial_number: entry.target.serialNumber,
          org_unit_path: entry.target.orgUnitPath,
          observed_value: entry.target.observedStatus,
          observed_at: entry.target.observedAt,
          disposition: entry.target.disposition,
          exclusion_reason: entry.target.exclusionReason,
        })),
      );
    }
  }

  /** The run of one preview, opened on its first page. */
  private preview(
    previews: Map<string, PreviewRun>,
    action: PreviewAction,
    reason: DeprovisionReason | null,
  ): PreviewRun {
    const key = previewKey(action, reason);
    const found = previews.get(key);
    if (found) return found;
    const run: PreviewRun = {
      action,
      reason,
      previewId: null,
      ordinal: 0,
      digest: new ManifestDigest(),
      statuses: [],
    };
    previews.set(key, run);
    return run;
  }

  /** Open the preview of one run, as preview creation does (design section 7, step 9). */
  private async open(
    client: QueryClient,
    session: SessionResponse,
    current: DeviceSyncState,
    run: PreviewRun,
  ): Promise<void> {
    if (run.previewId !== null) return;
    const opened = await this.call<Record<string, unknown>>(client, openSql, [
      session.identity.id,
      session.identity.permissionVersion,
      current.customerId,
      current.generation,
      run.action,
      null,
      PREVIEW_MINUTES,
      run.reason,
    ]);
    if (String(opened['outcome']) !== 'opened') deviceWriteFunctionError(opened);
    const preview = opened['preview'] as Record<string, unknown>;
    run.previewId = String(preview['preview_id']);
  }

  /** One page of frozen targets, at most 250, of one preview. */
  private async addPage(
    client: QueryClient,
    session: SessionResponse,
    current: DeviceSyncState,
    run: PreviewRun,
    targets: readonly unknown[],
  ): Promise<void> {
    if (targets.length === 0) return;
    const added = await this.call<Record<string, unknown>>(client, addSql, [
      session.identity.id,
      session.identity.permissionVersion,
      current.customerId,
      run.previewId,
      JSON.stringify(targets),
    ]);
    if (String(added['outcome']) !== 'added') deviceWriteFunctionError(added);
  }

  /**
   * Steps 9 to 11 for one preview: the seal, the streamed manifest, and the confirmation. A
   * Deprovision passes the phrase. The document is written page by page, so the whole manifest
   * never exists as one string.
   */
  private async confirmPreview(
    client: QueryClient,
    session: SessionResponse,
    current: DeviceSyncState,
    input: DeviceImportExecuteRequest,
    run: PreviewRun,
  ): Promise<Record<string, unknown>> {
    const previewId = run.previewId as string;
    const digest =
      run.action === 'annotated-location'
        ? run.digest.digest()
        : actionManifestDigest(run.action, run.statuses, run.reason);
    const sealed = await this.call<Record<string, unknown>>(client, sealSql, [
      session.identity.id,
      session.identity.permissionVersion,
      current.customerId,
      previewId,
      digest,
    ]);
    if (String(sealed['outcome']) !== 'sealed') deviceWriteFunctionError(sealed);
    // A Deprovision preview receives the phrase of its action, so the confirm checks it again. The
    // step 2 gate already read it, and a plan without a Deprovision sends none (design section 7).
    const phrase =
      run.action === 'deprovision' ? (input.typedPhrase ?? '').trim() : null;
    const artifactId = await this.storage.storeJsonStream(
      this.manifest(
        client,
        session,
        sealed['preview'] as Record<string, unknown>,
        digest,
      ),
      MANIFEST_MAX_BYTES,
    );
    const confirmed = await this.call<Record<string, unknown>>(
      client,
      confirmSql,
      [
        session.identity.id,
        session.identity.permissionVersion,
        current.customerId,
        previewId,
        digest,
        artifactId,
        randomUUID(),
        phrase,
      ],
    );
    if (String(confirmed['outcome']) !== 'created')
      deviceWriteFunctionError(confirmed);
    return confirmed['receipt'] as Record<string, unknown>;
  }

  /**
   * One manifest, page by page, in the shape of `cc.read_device_update_preview_manifest`. Each read
   * of the function answers 250 targets at most, so no string and no result set holds the plan.
   */
  private async *manifest(
    client: QueryClient,
    session: SessionResponse,
    sealed: Record<string, unknown>,
    digest: string,
  ): AsyncIterable<Buffer> {
    const actor = session.identity.id;
    const preview = { ...manifestPreview(sealed), manifestDigest: digest };
    yield Buffer.from(
      `{"preview":${JSON.stringify(preview)},"targets":[`,
    );
    let after: number | null = null;
    let first = true;
    for (;;) {
      const page: Record<string, unknown> = await this.call<
        Record<string, unknown>
      >(
        client,
        manifestPageSql,
        [
          actor,
          session.identity.permissionVersion,
          String(sealed['customer_id']),
          sealed['preview_id'],
          after,
        ],
      );
      if (String(page['outcome']) !== 'page')
        throw new Error(`The preview manifest returned ${String(page['outcome'])}.`);
      for (const target of page['targets'] as unknown[]) {
        yield Buffer.from(`${first ? '' : ','}${JSON.stringify(target)}`);
        first = false;
      }
      const next: unknown = page['nextOrdinal'];
      if (next === null || next === undefined) break;
      after = Number(next);
    }
    yield Buffer.from(
      `],"requester":${JSON.stringify(actor)},"confirmer":${JSON.stringify(actor)}}\n`,
    );
  }
}