import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  DEVICE_UPDATE_FIELD_ORDER,
  deviceUpdateChangesInOrder,
  deviceUpdateJobReceiptSchema,
  deviceUpdatePreviewRequestSchema,
  deviceUpdatePreviewSchema,
  deviceUpdateTargetSchema,
  type DeviceSelectionKey,
  type SessionResponse,
  type DeviceSyncState,
  type DeviceUpdateChange,
  type DeviceUpdateConfirmRequest,
  type DeviceUpdateField,
  type DeviceUpdateJobReceipt,
  type DeviceUpdateMode,
  type DeviceUpdatePreview,
  type DeviceUpdatePreviewRequest,
  type DeviceUpdateTarget,
} from '@campus/application-contracts';
import {
  parseIntCursor,
  previewTargetRow,
  targetCursor,
  type PreviewRow,
} from './device-update-rows';
import {
  parseSelection,
  selectionStorageKey,
  hasSelection,
} from './device-selection';
import { selectionIdsSql, type SqlStatement } from './device-query';

/** A preview expires 15 minutes after its preparation. */
const PREVIEW_MINUTES = 15;
/** A selection above this many devices is refused before a preview exists. */
export const MAX_PREVIEW_TARGETS = 100_000;
/** Device IDs travel into Google request paths. Only plain identifiers enter a job. */
const plainDeviceId = /^[A-Za-z0-9_-]{1,128}$/;
export const measuredAt = (value: unknown) =>
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

export interface PreviewField {
  field: DeviceUpdateField;
  observedValue: string | null;
  disposition: 'eligible' | 'unchanged' | 'excluded';
}

export interface PreviewTarget {
  ordinal: number;
  deviceId: string;
  serialNumber: string;
  orgUnitPath: string;
  observedAt: string | null;
  disposition: 'eligible' | 'unchanged' | 'excluded';
  exclusionReason: string | null;
  /** One row per change, in contract order. */
  fields: PreviewField[];
}

/** The cached value of one field on one device row. */
function observedValue(
  row: Record<string, unknown>,
  field: DeviceUpdateField,
): string | null {
  const column = {
    annotatedLocation: 'annotated_location',
    annotatedUser: 'annotated_user',
    notes: 'notes',
    orgUnitPath: 'org_unit_path',
  }[field];
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

/** The value that a change would write. Clear writes null. */
function changeValue(change: DeviceUpdateChange): string | null {
  return change.mode === 'clear' ? null : (change.value ?? null);
}

/**
 * A path compares without case, because Google OU paths are case-insensitive (section 2). A text
 * field compares exactly.
 */
function sameValue(
  change: DeviceUpdateChange,
  observed: string | null,
): boolean {
  const approved = changeValue(change);
  if (change.field === 'orgUnitPath')
    return (observed ?? '').toLowerCase() === (approved ?? '').toLowerCase();
  return observed === approved;
}

/**
 * Freeze one selected device for every change. Removed devices and non-plain IDs stay as
 * exclusions, and every field row of an excluded device is excluded.
 */
export function previewTargets(
  rows: readonly Record<string, unknown>[],
  changes: readonly DeviceUpdateChange[],
): PreviewTarget[] {
  return rows.map((row, index) => {
    const deviceId = String(row['device_id']);
    const exclusionReason = row['removed_at']
      ? 'removed'
      : plainDeviceId.test(deviceId)
        ? null
        : 'invalid-device-id';
    const fields = changes.map((change) => {
      const observed = observedValue(row, change.field);
      return {
        field: change.field,
        observedValue: observed,
        disposition: exclusionReason
          ? ('excluded' as const)
          : sameValue(change, observed)
            ? ('unchanged' as const)
            : ('eligible' as const),
      };
    });
    const disposition = exclusionReason
      ? ('excluded' as const)
      : fields.some((field) => field.disposition === 'eligible')
        ? ('eligible' as const)
        : ('unchanged' as const);
    return {
      ordinal: index,
      deviceId,
      serialNumber: String(row['serial_number'] ?? ''),
      orgUnitPath: String(row['org_unit_path'] ?? ''),
      observedAt: measuredAt(row['last_entity_sync']),
      disposition,
      exclusionReason,
      fields,
    };
  });
}

/**
 * SHA-256 over the action version, the ordered changes, and the ordered eligible device IDs with
 * the baselines of their eligible fields (section 3).
 */
export function manifestDigest(
  changes: readonly DeviceUpdateChange[],
  targets: readonly PreviewTarget[],
): string {
  const eligible = targets
    .filter((target) => target.disposition === 'eligible')
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  const canonical = JSON.stringify({
    actionVersion: 2,
    changes: deviceUpdateChangesInOrder(changes).map((change) => [
      change.field,
      change.mode,
      changeValue(change),
    ]),
    targets: eligible.map((target) => [
      target.deviceId,
      target.fields
        .filter((field) => field.disposition === 'eligible')
        .map((field) => [field.field, field.observedValue]),
    ]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** The frozen targets, as the preview function freezes them. */
function targetDocument(targets: readonly PreviewTarget[]) {
  return targets.map((target) => ({
    ordinal: target.ordinal,
    device_id: target.deviceId,
    serial_number: target.serialNumber,
    org_unit_path: target.orgUnitPath,
    observed_at: target.observedAt,
    disposition: target.disposition,
    exclusion_reason: target.exclusionReason,
    fields: target.fields.map((field) => ({
      field: field.field,
      observed_value: field.observedValue,
      disposition: field.disposition,
    })),
  }));
}

/** One stored change row, with no `value` key for Clear. */
export function storedChange(row: Record<string, unknown>): DeviceUpdateChange {
  const field = row['field'] as DeviceUpdateField;
  const mode = row['mode'] as DeviceUpdateMode;
  return mode === 'clear'
    ? { field, mode }
    : { field, mode, value: String(row['value'] ?? '') };
}

/** A display number with at least three digits. `lpad` would truncate 1000 to 100. */
export function displayNumber(prefix: 'PV' | 'UPD', number: number): string {
  return `${prefix}-${number < 1000 ? String(number).padStart(3, '0') : number}`;
}

function summary(
  row: PreviewRow,
  changes: readonly DeviceUpdateChange[],
  now = Date.now(),
): DeviceUpdatePreview {
  const oldestObservedAt = measuredAt(row['oldest_observed_at']);
  return deviceUpdatePreviewSchema.parse({
    previewId: row['preview_id'],
    displayId: row['display_id'],
    changes: deviceUpdateChangesInOrder(changes),
    fieldChanges: row['field_changes'],
    selected: row['selected'],
    eligible: row['eligible'],
    unchanged: row['unchanged'],
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

/**
 * Parse a preview body. A refused change names its field label and its limit (design section 1).
 * The generic 400 body of the error filter would hide that message, so the route answers the
 * first issue.
 */
export function previewInput(body: unknown): DeviceUpdatePreviewRequest {
  const parsed = deviceUpdatePreviewRequestSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new BadRequestException({
    reason: 'invalid-change',
    message: parsed.error.issues[0]?.message ?? 'The request is invalid.',
  });
}

/** Map one write-function outcome to the status and code of section 2.4. */
export function deviceWriteFunctionError(
  result: Record<string, unknown>,
): never {
  const outcome = String(result['outcome']);
  if (outcome === 'forbidden')
    throw new ForbiddenException('This action requires additional permission.');
  if (outcome === 'not-found')
    throw new NotFoundException({ reason: 'preview-not-found' });
  if (outcome === 'preview-expired')
    throw new GoneException({
      reason: 'preview-expired',
      expiresAt: measuredAt(result['expiresAt']),
    });
  if (outcome === 'nothing-to-update')
    throw new UnprocessableEntityException({ reason: outcome });
  if (outcome === 'artifact-missing')
    throw new InternalServerErrorException(
      'The manifest artifact is unavailable.',
    );
  if (
    outcome === 'preview-changed' ||
    outcome === 'permission-changed' ||
    outcome === 'connection-changed'
  )
    throw new ConflictException({ reason: outcome });
  throw new Error(`The device update function returned ${outcome}.`);
}

function receiptOf(value: unknown): DeviceUpdateJobReceipt {
  return deviceUpdateJobReceiptSchema.parse(value);
}

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
    if (!hasSelection(state))
      throw new UnprocessableEntityException({ reason: 'nothing-selected' });
    const sql = selectionIdsSql(current.customerId, state);
    const rows = (await this.database.connection.query(sql.text, sql.values))
      .rows;
    if (rows.length === 0)
      throw new UnprocessableEntityException({ reason: 'nothing-selected' });
    if (rows.length > MAX_PREVIEW_TARGETS)
      throw new UnprocessableEntityException({
        reason: 'selection-too-large',
      });
    const changes = deviceUpdateChangesInOrder(input.changes);
    const targets = previewTargets(rows, changes);
    const digest = manifestDigest(changes, targets);
    const result = await this.call<Record<string, unknown>>(
      this.database.connection,
      `SELECT cc.create_device_update_preview($1::uuid,$2::integer,$3::text,$4::integer,
        $5::text,$6::jsonb,$7::text,$8::jsonb,$9::integer) AS result`,
      [
        session.identity.id,
        session.identity.permissionVersion,
        current.customerId,
        current.generation,
        'annotated-location',
        JSON.stringify(changes),
        digest,
        JSON.stringify(targetDocument(targets)),
        PREVIEW_MINUTES,
      ],
    );
    if (result['outcome'] !== 'created') this.functionError(result);
    return summary(result['preview'] as PreviewRow, changes);
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

  /** The frozen changes of one preview, in contract order. */
  private async changes(previewId: string): Promise<DeviceUpdateChange[]> {
    const rows = (
      await this.database.connection.query(
        `SELECT field,mode,value FROM cc.device_update_changes WHERE preview_id=$1
        ORDER BY array_position($2::text[],field)`,
        [previewId, DEVICE_UPDATE_FIELD_ORDER],
      )
    ).rows;
    return rows.map(storedChange);
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
    return summary(row, await this.changes(previewId));
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
    const changes = await this.changes(previewId);
    const byField = new Map(changes.map((change) => [change.field, change]));
    const pageSize = Math.min(Math.max(limit ?? 100, 1), 1000);
    const after = parseIntCursor(cursor);
    const sql: SqlStatement = {
      text: `SELECT t.ordinal,t.device_id,t.serial_number,t.org_unit_path,f.field,
        f.observed_value,f.disposition,t.exclusion_reason
        FROM cc.device_update_preview_targets t
        JOIN cc.device_update_target_fields f
          ON f.preview_id=t.preview_id AND f.ordinal=t.ordinal
        WHERE t.preview_id=$1 AND ($2::text IS NULL OR f.disposition=$2)
          AND (t.ordinal,array_position($5::text[],f.field))>($3::integer,$4::integer)
        ORDER BY t.ordinal,array_position($5::text[],f.field) LIMIT $6`,
      values: [
        previewId,
        disposition ?? null,
        after.ordinal,
        after.position,
        DEVICE_UPDATE_FIELD_ORDER,
        pageSize + 1,
      ],
    };
    const rows = (await this.database.connection.query(sql.text, sql.values))
      .rows;
    const page = rows.slice(0, pageSize);
    return {
      targets: page.map((target) =>
        deviceUpdateTargetSchema.parse(
          previewTargetRow(
            target,
            byField.get(target['field'] as DeviceUpdateField) ?? {
              field: target['field'] as DeviceUpdateField,
              mode: 'clear',
            },
          ),
        ),
      ),
      nextCursor:
        rows.length > pageSize
          ? targetCursor(
              page[page.length - 1]?.['ordinal'],
              page[page.length - 1]?.['field'],
            )
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
    return deviceWriteFunctionError(result);
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
