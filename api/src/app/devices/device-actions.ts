import {
  ConflictException,
  GoneException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  deviceActionJobReceiptSchema,
  deviceActionPreviewSchema,
  deviceActionTargetSchema,
  type DeviceAction,
  type DeviceActionConfirmRequest,
  type DeviceActionJobReceipt,
  type DeviceActionPreview,
  type DeviceActionTarget,
  type DeviceSelectionKey,
  type DeviceSyncState,
  type SessionResponse,
} from '@campus/application-contracts';
import { parseIntCursor, type PreviewRow } from './device-update-rows';
import {
  deviceWriteFunctionError,
  measuredAt,
  type UpdatesCache,
  type UpdatesDatabase,
  type UpdatesStorage,
} from './device-updates';
import {
  hasSelection,
  parseSelection,
  selectionStorageKey,
} from './device-selection';
import { selectionIdsSql, type SqlStatement } from './device-query';

/** A command or status preview expires 15 minutes after its preparation. */
const PREVIEW_MINUTES = 15;
/** A selection above this many devices is refused before a preview exists. */
export const MAX_ACTION_PREVIEW_TARGETS = 100_000;
/** Device IDs travel into Google request paths. Only plain identifiers enter a job. */
const plainDeviceId = /^[A-Za-z0-9_-]{1,128}$/;

/** The action of each route family (section 7). */
export const COMMAND_PREVIEW_FAMILY = ['reboot'] as const;
export const STATUS_PREVIEW_FAMILY = ['disable', 'reenable'] as const;

/** The Google action that each device action sends (section 2). */
export const GOOGLE_ACTION = {
  reboot: 'REBOOT',
  disable: 'DISABLE',
  reenable: 'REENABLE',
} as const;

export interface ActionPreviewTarget {
  ordinal: number;
  deviceId: string;
  serialNumber: string;
  orgUnitPath: string;
  observedStatus: string | null;
  observedAt: string | null;
  disposition: 'eligible' | 'excluded';
  exclusionReason: string | null;
}

/**
 * The exclusion reason of one cached Google status (section 2). A null or unrecognized value is
 * `status-unknown`: Google decides a device's status, so the client never guesses one.
 */
export function statusExclusion(
  action: DeviceAction,
  status: string | null,
): string | null {
  if (
    status !== 'ACTIVE' &&
    status !== 'DISABLED' &&
    status !== 'DEPROVISIONED'
  )
    return 'status-unknown';
  if (status === 'DEPROVISIONED') return 'device-deprovisioned';
  if (action === 'reenable')
    return status === 'DISABLED' ? null : 'device-active';
  return status === 'ACTIVE' ? null : 'device-disabled';
}

/** Freeze one selected device with the cached status it matched (section 2). */
export function actionTargets(
  rows: readonly Record<string, unknown>[],
  action: DeviceAction,
): ActionPreviewTarget[] {
  return rows.map((row, index) => {
    const deviceId = String(row['device_id']);
    const observedStatus =
      typeof row['status'] === 'string' ? row['status'] : null;
    const target: ActionPreviewTarget = {
      ordinal: index,
      deviceId,
      serialNumber: String(row['serial_number'] ?? ''),
      orgUnitPath: String(row['org_unit_path'] ?? ''),
      observedStatus,
      observedAt: measuredAt(row['status_observed_at']),
      disposition: 'eligible',
      exclusionReason: null,
    };
    if (row['removed_at']) {
      target.disposition = 'excluded';
      target.exclusionReason = 'removed';
    } else if (!plainDeviceId.test(deviceId)) {
      target.disposition = 'excluded';
      target.exclusionReason = 'invalid-device-id';
    } else {
      const reason = statusExclusion(action, observedStatus);
      if (reason) {
        target.disposition = 'excluded';
        target.exclusionReason = reason;
      }
    }
    return target;
  });
}

/**
 * SHA-256 over the action, its version, the Google action, and the ordered eligible device IDs
 * with their cached baseline statuses (section 2).
 */
export function actionManifestDigest(
  action: DeviceAction,
  targets: readonly ActionPreviewTarget[],
): string {
  const eligible = targets
    .filter((target) => target.disposition === 'eligible')
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  const canonical = JSON.stringify({
    action,
    actionVersion: 1,
    googleAction: GOOGLE_ACTION[action],
    targets: eligible.map((target) => [target.deviceId, target.observedStatus]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** The preview summary of one route family (section 7). */
function summary(row: PreviewRow, now = Date.now()): DeviceActionPreview {
  const action = row['action'] as DeviceAction;
  const oldestObservedAt = measuredAt(row['oldest_observed_at']);
  return deviceActionPreviewSchema.parse({
    previewId: row['preview_id'],
    displayId: row['display_id'],
    action,
    commandType: action === 'reboot' ? 'REBOOT' : null,
    statusAction: action === 'reboot' ? null : action,
    selected: row['selected'],
    eligible: row['eligible'],
    excluded: row['excluded'],
    oldestObservedAt,
    stale:
      Number(row['eligible']) > 0 &&
      oldestObservedAt !== null &&
      Date.parse(oldestObservedAt) < now - 24 * 60 * 60 * 1000,
    preparedAt: measuredAt(row['prepared_at']),
    expiresAt: measuredAt(row['expires_at']),
    manifestDigest: row['manifest_digest'],
  });
}

/** One frozen action target page row (section 7). */
export function actionTargetRow(
  row: Record<string, unknown>,
): DeviceActionTarget {
  return deviceActionTargetSchema.parse({
    deviceId: String(row['device_id']),
    serialNumber: String(row['serial_number'] ?? ''),
    orgUnitPath: String(row['org_unit_path'] ?? ''),
    observedStatus:
      typeof row['observed_value'] === 'string' ? row['observed_value'] : null,
    observedAt: measuredAt(row['observed_at']),
    disposition: row['disposition'],
    exclusionReason:
      typeof row['exclusion_reason'] === 'string'
        ? row['exclusion_reason']
        : null,
  });
}

function receiptOf(value: unknown): DeviceActionJobReceipt {
  return deviceActionJobReceiptSchema.parse(value);
}

/** The command and status previews and confirmations of section 7. */
export class DeviceActions {
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
    action: DeviceAction,
    input: DeviceSelectionKey,
  ): Promise<DeviceActionPreview> {
    const { state, expiredAt } = await this.selection(session, input);
    if (expiredAt)
      throw new ConflictException({ reason: 'selection-expired', expiredAt });
    if (!hasSelection(state))
      throw new UnprocessableEntityException({ reason: 'nothing-selected' });
    const sql = selectionIdsSql(current.customerId, state);
    const rows = (await this.database.connection.query(sql.text, sql.values))
      .rows;
    if (rows.length === 0)
      throw new UnprocessableEntityException({ reason: 'nothing-selected' });
    if (rows.length > MAX_ACTION_PREVIEW_TARGETS)
      throw new UnprocessableEntityException({
        reason: 'selection-too-large',
      });
    const targets = actionTargets(rows, action);
    const digest = actionManifestDigest(action, targets);
    const result = await this.call<Record<string, unknown>>(
      this.database.connection,
      `SELECT cc.create_device_update_preview($1::uuid,$2::integer,$3::text,$4::integer,
        $5::text,$6::text,$7::text,$8::text,$9::jsonb,$10::integer) AS result`,
      [
        session.identity.id,
        session.identity.permissionVersion,
        current.customerId,
        current.generation,
        action,
        null,
        null,
        digest,
        JSON.stringify(
          targets.map((target) => ({
            ordinal: target.ordinal,
            device_id: target.deviceId,
            serial_number: target.serialNumber,
            org_unit_path: target.orgUnitPath,
            observed_value: target.observedStatus,
            observed_at: target.observedAt,
            disposition: target.disposition,
            exclusion_reason: target.exclusionReason,
          })),
        ),
        PREVIEW_MINUTES,
      ],
    );
    if (result['outcome'] !== 'created') deviceWriteFunctionError(result);
    return summary(result['preview'] as PreviewRow);
  }

  /** Load one preview of this route family. Another family answers as a missing preview. */
  private async load(
    session: SessionResponse,
    previewId: string,
    family: readonly DeviceAction[],
  ): Promise<PreviewRow> {
    const row = (
      await this.database.connection.query(
        'SELECT * FROM cc.device_update_previews WHERE preview_id=$1',
        [previewId],
      )
    ).rows[0] as PreviewRow | undefined;
    if (
      !row ||
      row['created_by'] !== session.identity.id ||
      !family.includes(row['action'] as DeviceAction)
    )
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
    family: readonly DeviceAction[],
  ): Promise<DeviceActionPreview> {
    const row = await this.load(session, previewId, family);
    if (Date.parse(String(row['expires_at'])) <= Date.now()) this.expired(row);
    return summary(row);
  }

  async targets(
    session: SessionResponse,
    previewId: string,
    family: readonly DeviceAction[],
    disposition: string | undefined,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<{ targets: DeviceActionTarget[]; nextCursor: string | null }> {
    const row = await this.load(session, previewId, family);
    if (Date.parse(String(row['expires_at'])) <= Date.now()) this.expired(row);
    const pageSize = Math.min(Math.max(limit ?? 100, 1), 1000);
    const after = parseIntCursor(cursor);
    const sql: SqlStatement = {
      text: `SELECT ordinal,device_id,serial_number,org_unit_path,observed_value,
        observed_at,disposition,exclusion_reason FROM cc.device_update_preview_targets
        WHERE preview_id=$1 AND ($2::text IS NULL OR disposition=$2) AND ordinal>$3
        ORDER BY ordinal LIMIT $4`,
      values: [previewId, disposition ?? null, after, pageSize + 1],
    };
    const rows = (await this.database.connection.query(sql.text, sql.values))
      .rows;
    const page = rows.slice(0, pageSize);
    return {
      targets: page.map((target) => actionTargetRow(target)),
      nextCursor:
        rows.length > pageSize
          ? String(page[page.length - 1]?.['ordinal'])
          : null,
    };
  }

  /** Run one SECURITY DEFINER function and return its JSON result. */
  private async call<T>(
    client: UpdatesDatabase['connection'],
    text: string,
    values: unknown[],
  ): Promise<T> {
    const row = (await client.query(text, values)).rows[0];
    if (!row || row['result'] == null)
      throw new Error('The device action function returned no result.');
    return row['result'] as T;
  }

  async confirm(
    session: SessionResponse,
    current: DeviceSyncState,
    previewId: string,
    input: DeviceActionConfirmRequest,
    family: readonly DeviceAction[],
  ): Promise<{ receipt: DeviceActionJobReceipt; existing: boolean }> {
    // A preview of another route family answers as a missing preview before any job is read.
    await this.load(session, previewId, family);
    const manifest = await this.call<Record<string, unknown>>(
      this.database.connection,
      `SELECT cc.read_device_update_preview_manifest($1::uuid,$2::integer,$3::text,$4::uuid)
        AS result`,
      [
        session.identity.id,
        session.identity.permissionVersion,
        current.customerId,
        previewId,
      ],
    );
    if (manifest['outcome'] === 'existing')
      return { receipt: receiptOf(manifest['receipt']), existing: true };
    if (manifest['outcome'] !== 'manifest') deviceWriteFunctionError(manifest);
    const document = manifest['manifest'] as {
      preview?: { manifestDigest?: unknown };
    };
    if (document.preview?.manifestDigest !== input.manifestDigest)
      throw new ConflictException({ reason: 'preview-changed' });
    const artifactId = await this.storage.storeJson(document);
    const result = await this.call<Record<string, unknown>>(
      this.database.connection,
      `SELECT cc.confirm_device_update_preview($1::uuid,$2::integer,$3::text,$4::uuid,
        $5::text,$6::text,$7::uuid) AS result`,
      [
        session.identity.id,
        session.identity.permissionVersion,
        current.customerId,
        previewId,
        input.manifestDigest,
        artifactId,
        randomUUID(),
      ],
    );
    if (result['outcome'] === 'created')
      return { receipt: receiptOf(result['receipt']), existing: false };
    if (result['outcome'] === 'existing')
      return { receipt: receiptOf(result['receipt']), existing: true };
    return deviceWriteFunctionError(result);
  }
}
