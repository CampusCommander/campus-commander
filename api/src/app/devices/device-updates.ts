import {
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  deviceUpdateJobReceiptSchema,
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

function receiptOf(value: unknown): DeviceUpdateJobReceipt {
  return deviceUpdateJobReceiptSchema.parse(value);
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
    const digest = manifestDigest(input.mode, value, targets);
    const result = await this.call<Record<string, unknown>>(
      this.database.connection,
      `SELECT cc.create_device_update_preview($1::uuid,$2::integer,$3::text,$4::integer,
        $5::text,$6::text,$7::text,$8::jsonb,$9::integer) AS result`,
      [
        session.identity.id,
        session.identity.permissionVersion,
        current.customerId,
        current.generation,
        input.mode,
        value,
        digest,
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
        PREVIEW_MINUTES,
      ],
    );
    if (result['outcome'] !== 'created') this.functionError(result);
    return summary(result['preview'] as PreviewRow);
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

  /** Run one SECURITY DEFINER function and return its JSON result. */
  private async call<T>(
    client: QueryClient,
    text: string,
    values: unknown[],
  ): Promise<T> {
    const row = (await client.query(text, values)).rows[0];
    if (!row || row['result'] == null)
      throw new Error('The device update function returned no result.');
    return row['result'] as T;
  }

  /** Map one function outcome to the status and code of section 2.4. */
  private functionError(result: Record<string, unknown>): never {
    const outcome = String(result['outcome']);
    if (outcome === 'forbidden')
      throw new ForbiddenException(
        'This action requires additional permission.',
      );
    if (outcome === 'not-found')
      throw new NotFoundException({ reason: 'preview-not-found' });
    if (outcome === 'preview-expired')
      throw new GoneException({
        reason: 'preview-expired',
        expiresAt: measuredAt(result['expiresAt']),
      });
    if (outcome === 'nothing-to-update')
      throw new UnprocessableEntityException({ reason: outcome });
    if (
      outcome === 'preview-changed' ||
      outcome === 'permission-changed' ||
      outcome === 'connection-changed'
    )
      throw new ConflictException({ reason: outcome });
    throw new Error(`The device update function returned ${outcome}.`);
  }

  async confirm(
    session: SessionResponse,
    current: DeviceSyncState,
    previewId: string,
    input: DeviceUpdateConfirmRequest,
  ): Promise<{ receipt: DeviceUpdateJobReceipt; existing: boolean }> {
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
    if (manifest['outcome'] !== 'manifest') this.functionError(manifest);
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
    return this.functionError(result);
  }
}
