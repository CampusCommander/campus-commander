import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  DEVICE_UPDATE_FIELD_ORDER,
  deviceUpdateChangesInOrder,
  deviceUpdateEditPreviewRequestSchema,
  deviceUpdateJobReceiptSchema,
  deviceUpdatePreviewRequestSchema,
  deviceUpdatePreviewSchema,
  deviceUpdateTargetSchema,
  type DeviceSelectionKey,
  type SessionResponse,
  type DeviceSyncState,
  type DeviceUpdateChange,
  type DeviceUpdateConfirmRequest,
  type DeviceUpdateEdit,
  type DeviceUpdateEditPreviewRequest,
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
  /** The value that confirmation writes. A Clear row holds null. */
  requestedValue: string | null;
  /** The value that the preview observed on the device. */
  observedValue: string | null;
  /** The value that the row held when the edit began. */
  baselineValue: string | null;
  disposition: 'eligible' | 'unchanged' | 'excluded' | 'conflict';
}

export interface PreviewTarget {
  ordinal: number;
  deviceId: string;
  serialNumber: string;
  orgUnitPath: string;
  observedAt: string | null;
  disposition: 'eligible' | 'unchanged' | 'excluded' | 'conflict';
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
    annotatedAssetId: 'asset_tag',
    annotatedUser: 'annotated_user',
    notes: 'notes',
    orgUnitPath: 'org_unit_path',
  }[field];
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

/** The field, mode, and value of one change or edit. */
type FieldChange = Pick<DeviceUpdateChange, 'field' | 'mode'> & {
  value?: string;
};

/** The value that a change would write. Clear writes null. */
function changeValue(change: FieldChange): string | null {
  return change.mode === 'clear' ? null : (change.value ?? null);
}

/**
 * A path compares without case, because Google OU paths are case-insensitive (section 2). A text
 * field compares exactly.
 */
function sameValue(change: FieldChange, observed: string | null): boolean {
  const approved = changeValue(change);
  if (change.field === 'orgUnitPath')
    return (observed ?? '').toLowerCase() === (approved ?? '').toLowerCase();
  return observed === approved;
}

/** The baseline compare of the edit list: a path ignores case, and every text field is exact. */
function sameBaseline(
  field: DeviceUpdateField,
  current: string | null,
  baseline: string | null,
): boolean {
  return field === 'orgUnitPath'
    ? (current ?? '').toLowerCase() === (baseline ?? '').toLowerCase()
    : current === baseline;
}

/**
 * Freeze one selected device for every change. Removed devices and non-plain IDs stay as
 * exclusions, and every field row of an excluded device is excluded. A selection row stores its
 * request, its observation, and its observation as its baseline, so the conflict rule of the edit
 * list never fires for it (addendum section 2).
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
        requestedValue: changeValue(change),
        observedValue: observed,
        baselineValue: observed,
        disposition: exclusionReason
          ? ('excluded' as const)
          : sameValue(change, observed)
            ? ('unchanged' as const)
            : ('eligible' as const),
      };
    });
    // A selection row never answers conflict: its baseline equals its observation, so the conflict
    // rule of the edit list cannot fire (addendum section 2).
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

/** Sort targets by device ID. The digest sorts its device list the same way. */
function byDeviceId(left: PreviewTarget, right: PreviewTarget): number {
  return left.deviceId < right.deviceId
    ? -1
    : left.deviceId > right.deviceId
      ? 1
      : 0;
}

/** Sort one device's edits into contract order. The rows and the digest use that order. */
function byField(
  left: { field: DeviceUpdateField },
  right: { field: DeviceUpdateField },
): number {
  return (
    DEVICE_UPDATE_FIELD_ORDER.indexOf(left.field) -
    DEVICE_UPDATE_FIELD_ORDER.indexOf(right.field)
  );
}

/**
 * Freeze one device of an edit list (addendum section 4). C is the current value of the fresh read,
 * B the baseline that the edit carried, and R the request. The first match wins: a removed device
 * or a non-plain ID is excluded, a current value that equals the request is unchanged, a current
 * value that differs from the baseline is a conflict, and every other row is eligible.
 */
export function editPreviewTargets(
  rows: readonly Record<string, unknown>[],
  edits: readonly DeviceUpdateEdit[],
): PreviewTarget[] {
  const byDevice = new Map<string, DeviceUpdateEdit[]>();
  for (const edit of edits) {
    const device = byDevice.get(edit.deviceId);
    if (device) device.push(edit);
    else byDevice.set(edit.deviceId, [edit]);
  }
  const rowById = new Map(
    rows.map((row) => [String(row['device_id']), row] as const),
  );
  return [...byDevice.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([deviceId, deviceEdits], index) => {
      const row = rowById.get(deviceId);
      // The inventory check of the fresh read refuses an unknown device before this point.
      if (!row)
        throw new ServiceUnavailableException({
          reason: 'device-store-unavailable',
        });
      const exclusionReason = row['removed_at']
        ? 'removed'
        : plainDeviceId.test(deviceId)
          ? null
          : 'invalid-device-id';
      const fields = [...deviceEdits].sort(byField).map((edit) => {
        const current = observedValue(row, edit.field);
        return {
          field: edit.field,
          requestedValue: changeValue(edit),
          observedValue: current,
          baselineValue: edit.baselineValue,
          disposition: exclusionReason
            ? ('excluded' as const)
            : sameValue(edit, current)
              ? ('unchanged' as const)
              : sameBaseline(edit.field, current, edit.baselineValue)
                ? ('eligible' as const)
                : ('conflict' as const),
        };
      });
      // One conflict row makes the device a conflict, and one eligible row makes it eligible.
      const disposition = exclusionReason
        ? ('excluded' as const)
        : fields.some((field) => field.disposition === 'conflict')
          ? ('conflict' as const)
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
 * The version 3 digest, fed one target at a time (design section 7, "Bounded serialization"). Each
 * eligible target writes its own canonical text into the hash, so a plan of 50,000 devices never
 * becomes one string. `add` takes its targets in device ID order, which is the `COLLATE "C"` order
 * of the plan read and the order of `byDeviceId`. The text equals the built form byte for byte.
 */
export class ManifestDigest {
  private readonly hash = createHash('sha256');
  private count = 0;
  private lastDeviceId: string | null = null;
  private value: string | null = null;

  constructor() {
    this.hash.update('{"actionVersion":3,"targets":[');
  }

  /** Add one page of targets. A target that is not eligible contributes nothing. */
  add(targets: readonly PreviewTarget[]): this {
    for (const target of targets) {
      if (target.disposition !== 'eligible') continue;
      if (this.lastDeviceId !== null && target.deviceId < this.lastDeviceId)
        throw new Error('The digest pages arrive out of device ID order.');
      this.lastDeviceId = target.deviceId;
      this.hash.update(
        `${this.count === 0 ? '' : ','}${canonicalTarget(target)}`,
      );
      this.count += 1;
    }
    return this;
  }

  /** The digest of every target that the pages held. A second call answers the same value. */
  digest(): string {
    this.value ??= this.hash.copy().update(']}').digest('hex');
    return this.value;
  }
}

/** The canonical text of one eligible target: its device and its eligible rows. */
function canonicalTarget(target: PreviewTarget): string {
  return JSON.stringify([
    target.deviceId,
    target.fields
      .filter((field) => field.disposition === 'eligible')
      .sort(byField)
      .map((field) => [
        field.field,
        field.requestedValue,
        field.observedValue,
        field.baselineValue,
      ]),
  ]);
}

/**
 * SHA-256 over the action version and, for each eligible device, its eligible rows as
 * `[field, requestedValue, observedValue, baselineValue]` in contract order (addendum section 2).
 * The selection builder and the edit builder both call this one function, and the digest drops the
 * change list because each row carries its own request. The pages of a paged caller feed the same
 * text through `ManifestDigest`, one page at a time.
 */
export function manifestDigest(targets: readonly PreviewTarget[]): string {
  return new ManifestDigest().add([...targets].sort(byDeviceId)).digest();
}

/** The frozen targets, as the preview function freezes them. */
export function targetDocument(targets: readonly PreviewTarget[]) {
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
      requested_value: field.requestedValue,
      observed_value: field.observedValue,
      baseline_value: field.baselineValue,
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

/** One frozen Asset tag row of a preview: its device, its serial number, and its request. */
export function previewAssetTagsSql(previewId: string): SqlStatement {
  return {
    text: `SELECT t.device_id,t.serial_number,f.requested_value
      FROM cc.device_update_preview_targets t
      JOIN cc.device_update_target_fields f
        ON f.preview_id=t.preview_id AND f.ordinal=t.ordinal
      WHERE t.preview_id=$1 AND f.field='annotatedAssetId' AND f.disposition='eligible'
      ORDER BY t.device_id`,
    values: [previewId],
  };
}

/**
 * The inventory devices that hold one of the requested tags (addendum section 6). A removed device
 * keeps no tag that a save could duplicate, so it stays out. The index devices_asset serves it.
 */
export function assetTagHoldersSql(
  customerId: string,
  tags: readonly string[],
): SqlStatement {
  return {
    text: `SELECT d.asset_tag,d.device_id,d.serial_number FROM cc.devices d
      WHERE d.customer_id=$1 AND d.asset_tag=ANY($2::text[]) AND d.removed_at IS NULL
      ORDER BY d.asset_tag,d.device_id`,
    values: [customerId, tags],
  };
}

/** The answer of one target row in the duplicate map. */
function assetRowKey(deviceId: unknown, field: unknown): string {
  return `${String(deviceId)}\u0000${String(field)}`;
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
    // An edit-list preview stores one request per target row, so it answers no changes.
    changes: changes.length === 0 ? null : deviceUpdateChangesInOrder(changes),
    fieldChanges: row['field_changes'],
    selected: row['selected'],
    eligible: row['eligible'],
    unchanged: row['unchanged'],
    excluded: row['excluded'],
    // The devices whose current value differs from their baseline and their request.
    conflicts: row['conflicts'],
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

/** Parse an edit-list body, with the same named refusal as a selection preview. */
export function editPreviewInput(
  body: unknown,
): DeviceUpdateEditPreviewRequest {
  const parsed = deviceUpdateEditPreviewRequestSchema.safeParse(body);
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
  if (outcome === 'nothing-to-update' || outcome === 'phrase-mismatch')
    throw new UnprocessableEntityException({ reason: outcome });
  // A preview that froze a conflict device never confirms (addendum section 2).
  if (outcome === 'preview-conflict')
    throw new ConflictException({ reason: 'preview-conflict' });
  // A paged preview holds no digest until the seal writes one, so confirmation refuses it.
  if (outcome === 'preview-unsealed')
    throw new ConflictException({ reason: 'preview-unsealed' });
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
    const digest = manifestDigest(targets);
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

  /**
   * Freeze one edit list (addendum sections 1 and 4). The fresh read already stored the rows, so
   * every target carries its own request, its observation, and its baseline. A null change list
   * marks the preview as an edit list.
   */
  async editPreview(
    session: SessionResponse,
    current: DeviceSyncState,
    input: DeviceUpdateEditPreviewRequest,
    rows: readonly Record<string, unknown>[],
  ): Promise<DeviceUpdatePreview> {
    const targets = editPreviewTargets(rows, input.edits);
    const digest = manifestDigest(targets);
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
        null,
        digest,
        JSON.stringify(targetDocument(targets)),
        PREVIEW_MINUTES,
      ],
    );
    if (result['outcome'] !== 'created') this.functionError(result);
    return summary(result['preview'] as PreviewRow, []);
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

  /**
   * The duplicate Asset tag warning of addendum section 6. It names a device that holds the request
   * after the save: an inventory device whose tag this preview leaves alone, or another row of this
   * preview with the same request. A swap of two tags therefore names no device. The warning never
   * blocks.
   */
  private async duplicates(
    previewId: string,
    customerId: string,
    page: readonly Record<string, unknown>[],
  ): Promise<Map<string, string | null>> {
    const answer = new Map<string, string | null>();
    const wanted = page.filter(
      (row) =>
        row['field'] === 'annotatedAssetId' &&
        row['disposition'] === 'eligible' &&
        typeof row['requested_value'] === 'string',
    );
    if (wanted.length === 0) return answer;
    const frozen = previewAssetTagsSql(previewId);
    const written = new Map<string, string>();
    const byRequest = new Map<
      string,
      { deviceId: string; serialNumber: string }[]
    >();
    for (const row of (
      await this.database.connection.query(frozen.text, frozen.values)
    ).rows) {
      const deviceId = String(row['device_id']);
      const request = String(row['requested_value']);
      written.set(deviceId, request);
      const list = byRequest.get(request) ?? [];
      list.push({ deviceId, serialNumber: String(row['serial_number'] ?? '') });
      byRequest.set(request, list);
    }
    const tags = [
      ...new Set(wanted.map((row) => String(row['requested_value']))),
    ];
    const inventory = assetTagHoldersSql(customerId, tags);
    const holders = (
      await this.database.connection.query(inventory.text, inventory.values)
    ).rows;
    for (const row of wanted) {
      const deviceId = String(row['device_id']);
      const request = String(row['requested_value']);
      // A device that this preview moves to another tag no longer holds the request.
      let duplicate = holders.find(
        (holder) =>
          holder['asset_tag'] === request &&
          String(holder['device_id']) !== deviceId &&
          (written.get(String(holder['device_id'])) ?? request) === request,
      )?.['serial_number'];
      if (typeof duplicate !== 'string')
        duplicate = byRequest
          .get(request)
          ?.find((one) => one.deviceId !== deviceId)?.serialNumber;
      answer.set(
        assetRowKey(deviceId, 'annotatedAssetId'),
        typeof duplicate === 'string' ? duplicate : null,
      );
    }
    return answer;
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
      text: `SELECT t.ordinal,t.device_id,t.serial_number,t.org_unit_path,f.field,
        f.requested_value,f.observed_value,f.baseline_value,f.disposition,t.exclusion_reason
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
    const duplicates = await this.duplicates(
      previewId,
      String(row['customer_id']),
      page,
    );
    return {
      targets: page.map((target) =>
        deviceUpdateTargetSchema.parse(
          previewTargetRow(
            target,
            duplicates.get(assetRowKey(target['device_id'], target['field'])) ??
              null,
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
