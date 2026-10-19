import {
  ConflictException,
  GoneException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  deviceUpdatePreviewSchema,
  deviceUpdateTargetSchema,
  type DeviceSelectionKey,
  type SessionResponse,
  type DeviceSyncState,
  type DeviceUpdateConfirmRequest,
  type DeviceUpdateJobReceipt,
  type DeviceUpdateMode,
  type DeviceUpdatePreview,
  type DeviceUpdatePreviewRequest,
  type DeviceUpdateTarget,
} from '@campus/application-contracts';
import {
  parseIntCursor,
  previewTargetRow,
  type PreviewRow,
} from './device-update-rows';
import { parseSelection, selectionStorageKey } from './device-selection';
import { selectionIdsSql, type SqlStatement } from './device-query';

/** A preview expires 15 minutes after its preparation. */
const PREVIEW_MINUTES = 15;
/** A selection above this many devices is refused before a preview exists. */
export const MAX_PREVIEW_TARGETS = 100_000;
/** The write batch ceiling of section 5.2. */
const BATCH_SIZE = 250;
/** Device IDs travel into Google request paths. Only plain identifiers enter a job. */
const plainDeviceId = /^[A-Za-z0-9_-]{1,128}$/;
const measuredAt = (value: unknown) =>
  value instanceof Date
    ? value.toISOString()
    : typeof value === 'string'
      ? value
      : null;

interface QueryResult {
  rows: Record<string, unknown>[];
}
interface QueryClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}
export interface UpdatesDatabase {
  connection: QueryClient;
  transaction<T>(run: (client: QueryClient) => Promise<T>): Promise<T>;
}
export interface UpdatesCache {
  get(key: string): Promise<string | null>;
}
export interface UpdatesStorage {
  storeJson(document: unknown): Promise<string>;
}

export interface PreviewTarget {
  ordinal: number;
  deviceId: string;
  serialNumber: string;
  orgUnitPath: string;
  observedValue: string | null;
  observedAt: string | null;
  disposition: 'eligible' | 'unchanged' | 'excluded';
  exclusionReason: string | null;
}

/** Freeze one selected device. Removed devices and non-plain IDs stay as exclusions. */
export function previewTargets(
  rows: readonly Record<string, unknown>[],
  mode: DeviceUpdateMode,
  value: string | null,
): PreviewTarget[] {
  const approved = mode === 'clear' ? null : value;
  return rows.map((row, index) => {
    const deviceId = String(row['device_id']);
    const observedValue =
      typeof row['annotated_location'] === 'string'
        ? row['annotated_location']
        : null;
    const target: PreviewTarget = {
      ordinal: index,
      deviceId,
      serialNumber: String(row['serial_number'] ?? ''),
      orgUnitPath: String(row['org_unit_path'] ?? ''),
      observedValue,
      observedAt: measuredAt(row['last_entity_sync']),
      disposition: 'eligible',
      exclusionReason: null,
    };
    if (row['removed_at']) {
      target.disposition = 'excluded';
      target.exclusionReason = 'removed';
    } else if (!plainDeviceId.test(deviceId)) {
      target.disposition = 'excluded';
      target.exclusionReason = 'invalid-device-id';
    } else if (observedValue === approved) {
      target.disposition = 'unchanged';
    }
    return target;
  });
}

/**
 * SHA-256 over the action version, the field, the mode, the value, and the ordered eligible
 * device IDs with their baselines.
 */
export function manifestDigest(
  mode: DeviceUpdateMode,
  value: string | null,
  targets: readonly PreviewTarget[],
): string {
  const eligible = targets
    .filter((target) => target.disposition === 'eligible')
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  const canonical = JSON.stringify({
    actionVersion: 1,
    field: 'annotatedLocation',
    mode,
    value: mode === 'clear' ? null : value,
    targets: eligible.map((target) => [target.deviceId, target.observedValue]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** A display number with at least three digits. `lpad` would truncate 1000 to 100. */
export function displayNumber(prefix: 'PV' | 'UPD', number: number): string {
  return `${prefix}-${number < 1000 ? String(number).padStart(3, '0') : number}`;
}

function summary(row: PreviewRow, now = Date.now()): DeviceUpdatePreview {
  const oldestObservedAt = measuredAt(row['oldest_observed_at']);
  return deviceUpdatePreviewSchema.parse({
    previewId: row['preview_id'],
    displayId: row['display_id'],
    mode: row['mode'],
    value: row['value'],
    selected: row['selected'],
    eligible: row['eligible'],
    unchanged: row['unchanged'],
    excluded: row['excluded'],
    oldestObservedAt,
    stale:
      row['eligible'] > 0 &&
      oldestObservedAt !== null &&
      Date.parse(oldestObservedAt) < now - 24 * 60 * 60 * 1000,
    preparedAt: measuredAt(row['prepared_at']),
    expiresAt: measuredAt(row['expires_at']),
    manifestDigest: row['manifest_digest'],
  });
}

function receipt(row: Record<string, unknown>): DeviceUpdateJobReceipt {
  return {
    jobId: String(row['job_id']),
    displayId: String(row['display_id']),
    status: 'accepted',
    deviceCount: Number(row['device_count']),
    updateCount: Number(row['update_count']),
  };
}

const selected = (state: ReturnType<typeof parseSelection>['state']) =>
  state.terms.length > 0 ||
  state.groups.length > 0 ||
  state.additions.length > 0;

export class DeviceUpdates {
  private readonly database: UpdatesDatabase;
  private readonly cache: UpdatesCache;
  private readonly storage: UpdatesStorage;

  constructor(
    database: UpdatesDatabase,
    cache: UpdatesCache,
    storage: UpdatesStorage,
  ) {
    this.database = database;
    this.cache = cache;
    this.storage = storage;
  }

  private async selection(session: SessionResponse, key: DeviceSelectionKey) {
    return parseSelection(
      await this.cache.get(selectionStorageKey(session.identity.id, key)),
    );
  }

  async preview(
    session: SessionResponse,
    current: DeviceSyncState,
    input: DeviceUpdatePreviewRequest,
  ): Promise<DeviceUpdatePreview> {
    const { state, expiredAt } = await this.selection(session, {
      gridId: input.gridId,
      tabId: input.tabId,
    });
    if (expiredAt)
      throw new ConflictException({ reason: 'selection-expired', expiredAt });
    if (!selected(state))
      throw new UnprocessableEntityException({ reason: 'nothing-selected' });
    const sql = selectionIdsSql(current.customerId, state);
    const rows = (await this.database.connection.query(sql.text, sql.values))
      .rows;
    if (rows.length > MAX_PREVIEW_TARGETS)
      throw new UnprocessableEntityException({
        reason: 'selection-too-large',
      });
    const value = input.mode === 'clear' ? null : input.value;
    const targets = previewTargets(rows, input.mode, value);
    const counts = {
      selected: targets.length,
      eligible: targets.filter((target) => target.disposition === 'eligible')
        .length,
      unchanged: targets.filter((target) => target.disposition === 'unchanged')
        .length,
      excluded: targets.filter((target) => target.disposition === 'excluded')
        .length,
    };
    const eligible = targets.filter(
      (target) => target.disposition === 'eligible',
    );
    const oldestObservedAt =
      eligible
        .map((target) => target.observedAt)
        .filter((stamp): stamp is string => stamp !== null)
        .sort()[0] ?? null;
    const digest = manifestDigest(input.mode, value, targets);
    const previewId = randomUUID();
    const row = await this.database.transaction(async (client) => {
      const number = Number(
        (await client.query("SELECT nextval('cc.preview_number_pv') AS number"))
          .rows[0]?.['number'],
      );
      const inserted = (
        await client.query(
          `INSERT INTO cc.device_update_previews(preview_id,display_id,customer_id,created_by,
            permission_version,generation,field,mode,value,selected,eligible,unchanged,excluded,
            oldest_observed_at,manifest_digest,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,'annotatedLocation',$7,$8,$9,$10,$11,$12,$13,$14,
             clock_timestamp()+make_interval(mins=>$15))
           RETURNING *`,
          [
            previewId,
            displayNumber('PV', number),
            current.customerId,
            session.identity.id,
            session.identity.permissionVersion,
            current.generation,
            input.mode,
            value,
            counts.selected,
            counts.eligible,
            counts.unchanged,
            counts.excluded,
            oldestObservedAt,
            digest,
            PREVIEW_MINUTES,
          ],
        )
      ).rows[0] as PreviewRow;
      await client.query(
        `INSERT INTO cc.device_update_preview_targets(preview_id,ordinal,device_id,serial_number,
           org_unit_path,observed_value,observed_at,disposition,exclusion_reason)
         SELECT $1,ordinal,device_id,serial_number,org_unit_path,observed_value,observed_at,
           disposition,exclusion_reason
         FROM jsonb_to_recordset($2::jsonb) AS target(ordinal integer,device_id text,
           serial_number text,org_unit_path text,observed_value text,observed_at timestamptz,
           disposition text,exclusion_reason text)`,
        [
          previewId,
          JSON.stringify(
            targets.map((target) => ({
              ordinal: target.ordinal,
              device_id: target.deviceId,
              serial_number: target.serialNumber,
              org_unit_path: target.orgUnitPath,
              observed_value: target.observedValue,
              observed_at: target.observedAt,
              disposition: target.disposition,
              exclusion_reason: target.exclusionReason,
            })),
          ),
        ],
      );
      return inserted;
    });
    return summary(row);
  }

  private async load(
    session: SessionResponse,
    previewId: string,
  ): Promise<PreviewRow> {
    const row = (
      await this.database.connection.query(
        'SELECT * FROM cc.device_update_previews WHERE preview_id=$1',
        [previewId],
      )
    ).rows[0] as PreviewRow | undefined;
    if (!row || row['created_by'] !== session.identity.id)
      throw new NotFoundException({ reason: 'preview-not-found' });
    return row;
  }

  private expired(row: PreviewRow): never {
    throw new GoneException({
      reason: 'preview-expired',
      expiresAt: measuredAt(row['expires_at']),
    });
  }

  async previewById(
    session: SessionResponse,
    previewId: string,
  ): Promise<DeviceUpdatePreview> {
    const row = await this.load(session, previewId);
    if (Date.parse(String(row['expires_at'])) <= Date.now()) this.expired(row);
    return summary(row);
  }

  async targets(
    session: SessionResponse,
    previewId: string,
    disposition: string | undefined,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<{ targets: DeviceUpdateTarget[]; nextCursor: string | null }> {
    const row = await this.load(session, previewId);
    if (Date.parse(String(row['expires_at'])) <= Date.now()) this.expired(row);
    const pageSize = Math.min(Math.max(limit ?? 100, 1), 1000);
    const after = parseIntCursor(cursor);
    const sql: SqlStatement = {
      text: `SELECT ordinal,device_id,serial_number,org_unit_path,observed_value,disposition,
        exclusion_reason FROM cc.device_update_preview_targets WHERE preview_id=$1
        AND ($2::text IS NULL OR disposition=$2) AND ordinal>$3 ORDER BY ordinal LIMIT $4`,
      values: [previewId, disposition ?? null, after, pageSize + 1],
    };
    const rows = (await this.database.connection.query(sql.text, sql.values))
      .rows;
    const page = rows.slice(0, pageSize);
    return {
      targets: page.map((target) =>
        deviceUpdateTargetSchema.parse(
          previewTargetRow(target, row['mode'], row['value']),
        ),
      ),
      nextCursor:
        rows.length > pageSize
          ? String(page[page.length - 1]?.['ordinal'])
          : null,
    };
  }

  private async existingReceipt(
    previewId: string,
  ): Promise<DeviceUpdateJobReceipt | null> {
    const row = (
      await this.database.connection.query(
        `SELECT j.job_id,j.display_id,u.batch_count AS device_count,
           (SELECT count(*)::integer FROM cc.device_update_operations o WHERE o.job_id=j.job_id)
             AS update_count
         FROM cc.device_update_previews p
         JOIN cc.jobs j ON j.job_id=p.job_id
         JOIN cc.device_update_jobs u ON u.job_id=j.job_id
         WHERE p.preview_id=$1`,
        [previewId],
      )
    ).rows[0];
    return row ? receipt(row) : null;
  }

  /** The frozen manifest that confirmation stores before it creates the job. */
  private async manifest(
    session: SessionResponse,
    row: PreviewRow,
    previewId: string,
  ): Promise<unknown> {
    const targets = (
      await this.database.connection.query(
        `SELECT ordinal,device_id,serial_number,org_unit_path,observed_value,observed_at,
           disposition,exclusion_reason FROM cc.device_update_preview_targets
         WHERE preview_id=$1 ORDER BY ordinal`,
        [previewId],
      )
    ).rows;
    return {
      preview: {
        previewId,
        displayId: row['display_id'],
        customerId: row['customer_id'],
        createdBy: row['created_by'],
        permissionVersion: row['permission_version'],
        generation: row['generation'],
        field: row['field'],
        mode: row['mode'],
        value: row['value'],
        selected: row['selected'],
        eligible: row['eligible'],
        unchanged: row['unchanged'],
        excluded: row['excluded'],
        oldestObservedAt: measuredAt(row['oldest_observed_at']),
        preparedAt: measuredAt(row['prepared_at']),
        expiresAt: measuredAt(row['expires_at']),
        manifestDigest: row['manifest_digest'],
      },
      targets,
      requester: row['created_by'],
      confirmer: session.identity.id,
    };
  }

  async confirm(
    session: SessionResponse,
    current: DeviceSyncState,
    previewId: string,
    input: DeviceUpdateConfirmRequest,
  ): Promise<{ receipt: DeviceUpdateJobReceipt; existing: boolean }> {
    const row = await this.load(session, previewId);
    if (row['job_id']) {
      const existing = await this.existingReceipt(previewId);
      if (existing) return { receipt: existing, existing: true };
    }
    if (Date.parse(String(row['expires_at'])) <= Date.now()) this.expired(row);
    if (input.manifestDigest !== row['manifest_digest'])
      throw new ConflictException({ reason: 'preview-changed' });

    const artifactId = await this.storage.storeJson(
      await this.manifest(session, row, previewId),
    );
    try {
      return await this.database.transaction(async (client) => {
        const locked = (
          await client.query(
            'SELECT * FROM cc.device_update_previews WHERE preview_id=$1 FOR UPDATE',
            [previewId],
          )
        ).rows[0] as PreviewRow | undefined;
        if (!locked || locked['created_by'] !== session.identity.id)
          throw new NotFoundException({ reason: 'preview-not-found' });
        if (locked['job_id']) {
          const existing = (
            await client.query(
              `SELECT j.job_id,j.display_id,u.batch_count AS device_count,
                 (SELECT count(*)::integer FROM cc.device_update_operations o
                   WHERE o.job_id=j.job_id) AS update_count
               FROM cc.jobs j JOIN cc.device_update_jobs u ON u.job_id=j.job_id
               WHERE j.job_id=$1`,
              [locked['job_id']],
            )
          ).rows[0];
          if (existing) return { receipt: receipt(existing), existing: true };
        }
        if (Date.parse(String(locked['expires_at'])) <= Date.now())
          this.expired(locked);
        if (input.manifestDigest !== locked['manifest_digest'])
          throw new ConflictException({ reason: 'preview-changed' });
        const stop = (
          await client.query(
            `SELECT CASE
               WHEN NOT EXISTS(SELECT 1 FROM cc.application_principals p
                 WHERE p.id=$2 AND p.enabled AND p.permission_version=$3)
                 OR (SELECT count(DISTINCT g.action) FROM cc.application_grants g
                   WHERE g.principal_id=$2 AND g.action IN ('devices:write','devices:bulk-actions')
                     AND (g.scope='{"kind":"platform"}'::jsonb OR
                       (g.scope->>'kind'='district' AND g.scope->>'customerId'=$1)))<2
                 THEN 'permission-changed'
               WHEN NOT EXISTS(SELECT 1 FROM cc.google_connection c
                 WHERE c.customer_id=$1 AND c.generation=$4 AND c.active)
                 THEN 'connection-changed'
             END AS reason`,
            [
              current.customerId,
              session.identity.id,
              session.identity.permissionVersion,
              locked['generation'],
            ],
          )
        ).rows[0]?.['reason'];
        if (stop) throw new ConflictException({ reason: String(stop) });
        const eligible = (
          await client.query(
            `SELECT count(*)::integer AS count FROM cc.device_update_preview_targets
             WHERE preview_id=$1 AND disposition='eligible'`,
            [previewId],
          )
        ).rows[0]?.['count'];
        if (Number(eligible) === 0)
          throw new UnprocessableEntityException({
            reason: 'nothing-to-update',
          });
        const subject = (
          await client.query(
            `SELECT g.delegated_subject FROM cc.google_connection c
             JOIN cc.google_credentials g ON g.id=c.credential_id
             WHERE c.customer_id=$1 AND c.generation=$2 AND c.active`,
            [current.customerId, locked['generation']],
          )
        ).rows[0]?.['delegated_subject'];
        if (!subject)
          throw new ConflictException({ reason: 'connection-changed' });
        const number = Number(
          (await client.query("SELECT nextval('cc.job_number_upd') AS number"))
            .rows[0]?.['number'],
        );
        const jobId = randomUUID();
        const job = (
          await client.query(
            `INSERT INTO cc.jobs(job_id,display_id,customer_id,kind,scope_kind,status,
               requested_by,generation,target_count,target_org_unit_paths,correlation_id)
             VALUES($1,$2,$3,'device-update','devices','accepted',$4,$5,$6,$7,$8)
             RETURNING job_id,display_id`,
            [
              jobId,
              displayNumber('UPD', number),
              current.customerId,
              session.identity.id,
              locked['generation'],
              Number(eligible),
              (
                await client.query(
                  `SELECT COALESCE(array_agg(DISTINCT org_unit_path ORDER BY org_unit_path),
                     '{}'::text[]) AS paths FROM cc.device_update_preview_targets
                   WHERE preview_id=$1 AND disposition='eligible'`,
                  [previewId],
                )
              ).rows[0]?.['paths'] ?? [],
              randomUUID(),
            ],
          )
        ).rows[0];
        await client.query(
          `INSERT INTO cc.device_update_jobs(job_id,preview_id,field,mode,value,confirmed_by,
             confirmer_permission_version,delegated_subject,batch_size,batch_count,
             manifest_artifact_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            jobId,
            previewId,
            locked['field'],
            locked['mode'],
            locked['value'],
            session.identity.id,
            session.identity.permissionVersion,
            subject,
            BATCH_SIZE,
            Math.ceil(Number(eligible) / BATCH_SIZE),
            artifactId,
          ],
        );
        await client.query(
          `INSERT INTO cc.device_update_operations(job_id,operation_number,device_id,
             serial_number,org_unit_path,baseline_value,requested_value,batch,status)
           SELECT $1,row_number() OVER (ORDER BY ordinal)::integer,device_id,serial_number,
             org_unit_path,observed_value,$2,
             ((row_number() OVER (ORDER BY ordinal)-1)/$3)::integer,'pending'
           FROM cc.device_update_preview_targets
           WHERE preview_id=$4 AND disposition='eligible' ORDER BY ordinal`,
          [
            jobId,
            locked['mode'] === 'clear' ? null : locked['value'],
            BATCH_SIZE,
            previewId,
          ],
        );
        await client.query(
          'UPDATE cc.device_update_previews SET job_id=$2 WHERE preview_id=$1',
          [previewId, jobId],
        );
        await client.query('SELECT cc.record_job_change($1,true)', [jobId]);
        return {
          receipt: {
            jobId,
            displayId: String(job?.['display_id']),
            status: 'accepted' as const,
            deviceCount: Number(eligible),
            updateCount: Number(eligible),
          },
          existing: false,
        };
      });
    } catch (error) {
      // A concurrent confirmation that won the preview row lock. Return its receipt.
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === '23505'
      ) {
        const existing = await this.existingReceipt(previewId);
        if (existing) return { receipt: existing, existing: true };
      }
      throw error;
    }
  }
}
