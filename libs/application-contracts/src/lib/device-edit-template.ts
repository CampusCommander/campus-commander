import * as z from 'zod';
import {
  DEPROVISION_REASON_LABELS,
  DEPROVISION_REASONS,
  DEVICE_UPDATE_FIELD_LABELS,
  deviceUpdateChangeSchema,
  type DeprovisionReason,
  type DeviceUpdateChange,
  type DeviceUpdateField,
} from './devices';

/**
 * The edit template of the batch update workflow
 * (`docs/research/batch-update-export-import-technical-design.md`, sections 6.4 and 7.1 to 8.5).
 *
 * This module holds no I/O. It defines the columns, the import modes, the status codes, the field
 * cell intents, the formula escape, the canonical values, and the row checksum. The export, the
 * import, and the validation job read these rules from here. No other module copies them.
 */

/** The template schema version (section 8.1). A checksum cell carries it before the dot. */
export const DEVICE_EDIT_TEMPLATE_SCHEMA_VERSION = 1;

/** The two import modes of section 8.5, in sheet order. */
export const DEVICE_IMPORT_MODES = ['sync-changes', 'sync-all-rows'] as const;
export const deviceImportModeSchema = z.enum(DEVICE_IMPORT_MODES);
export type DeviceImportMode = z.infer<typeof deviceImportModeSchema>;

/** The label of each import mode. Sync changes starts selected (section 8.5). */
export const DEVICE_IMPORT_MODE_LABELS: Readonly<
  Record<DeviceImportMode, string>
> = Object.freeze({
  'sync-changes': 'Sync changes',
  'sync-all-rows': 'Sync all rows',
});

/** The default import mode of the import sheet (section 8.5). */
export const DEVICE_IMPORT_MODE_DEFAULT: DeviceImportMode = 'sync-changes';

/** The key of each template column, in template order (section 7.1). */
export const DEVICE_EDIT_TEMPLATE_COLUMN_KEYS = [
  'deviceId',
  'serialNumber',
  'model',
  'status',
  'annotatedAssetId',
  'annotatedLocation',
  'annotatedUser',
  'notes',
  'orgUnitPath',
  'checksum',
] as const;
export const deviceEditColumnKeySchema = z.enum(
  DEVICE_EDIT_TEMPLATE_COLUMN_KEYS,
);
export type DeviceEditColumnKey = z.infer<typeof deviceEditColumnKeySchema>;

/** The role of one template column (section 7.1). */
export const deviceEditColumnRoleSchema = z.enum([
  'identity',
  'context',
  'editable',
  'checksum',
]);
export type DeviceEditColumnRole = z.infer<typeof deviceEditColumnRoleSchema>;

/** One template column. */
export interface DeviceEditColumn {
  key: DeviceEditColumnKey;
  /** The header text of the template. */
  header: string;
  role: DeviceEditColumnRole;
  /** Whether the row checksum covers the column (section 7.1). */
  checksummed: boolean;
  /** The writable field of an editable field column. The Status column carries none. */
  field?: DeviceUpdateField;
}

/**
 * The ten columns of section 7.1, in template order. The five field headers are the labels of
 * `DEVICE_UPDATE_FIELD_LABELS`. The limits stay in `DEVICE_UPDATE_FIELD_LIMITS`.
 */
export const DEVICE_EDIT_TEMPLATE_COLUMNS: readonly DeviceEditColumn[] =
  Object.freeze([
    {
      key: 'deviceId',
      header: 'Device ID',
      role: 'identity',
      checksummed: true,
    },
    {
      key: 'serialNumber',
      header: 'Serial number',
      role: 'context',
      checksummed: false,
    },
    {
      key: 'model',
      header: 'Model',
      role: 'context',
      checksummed: false,
    },
    { key: 'status', header: 'Status', role: 'editable', checksummed: true },
    {
      key: 'annotatedAssetId',
      header: DEVICE_UPDATE_FIELD_LABELS.annotatedAssetId,
      role: 'editable',
      checksummed: true,
      field: 'annotatedAssetId',
    },
    {
      key: 'annotatedLocation',
      header: DEVICE_UPDATE_FIELD_LABELS.annotatedLocation,
      role: 'editable',
      checksummed: true,
      field: 'annotatedLocation',
    },
    {
      key: 'annotatedUser',
      header: DEVICE_UPDATE_FIELD_LABELS.annotatedUser,
      role: 'editable',
      checksummed: true,
      field: 'annotatedUser',
    },
    {
      key: 'notes',
      header: DEVICE_UPDATE_FIELD_LABELS.notes,
      role: 'editable',
      checksummed: true,
      field: 'notes',
    },
    {
      key: 'orgUnitPath',
      header: DEVICE_UPDATE_FIELD_LABELS.orgUnitPath,
      role: 'editable',
      checksummed: true,
      field: 'orgUnitPath',
    },
    {
      key: 'checksum',
      header: 'Checksum',
      role: 'checksum',
      checksummed: false,
    },
  ]);

/** The header row of an edit export, in template order. */
export const DEVICE_EDIT_TEMPLATE_HEADERS: readonly string[] =
  DEVICE_EDIT_TEMPLATE_COLUMNS.map((column) => column.header);

const DEPROVISION_REASON_PREFIX = 'DEPROVISION_REASON_';

type WithoutDeprovisionReasonPrefix<Reason extends string> =
  Reason extends `${typeof DEPROVISION_REASON_PREFIX}${infer Code}`
    ? Code
    : never;

/** A reason code as the Status cell writes it: a Google reason without its prefix. */
export type DeviceDeprovisionReasonCode =
  WithoutDeprovisionReasonPrefix<DeprovisionReason>;

/** One reason code of the Status cell (section 7.5). */
export interface DeviceDeprovisionCode {
  /** The suffix of `DEPROVISION:<code>`. */
  code: DeviceDeprovisionReasonCode;
  /** Google's reason value. */
  reason: DeprovisionReason;
  /** The label of `DEPROVISION_REASON_LABELS`. */
  label: string;
}

/**
 * The four reason codes that a Status cell carries, in Google's order (section 7.5). Each code
 * derives from `DEPROVISION_REASONS`, so the list matches the status preview.
 */
export const DEVICE_DEPROVISION_CODES: readonly DeviceDeprovisionCode[] =
  Object.freeze(
    DEPROVISION_REASONS.map((reason) => ({
      code: reason.slice(
        DEPROVISION_REASON_PREFIX.length,
      ) as DeviceDeprovisionReasonCode,
      reason,
      label: DEPROVISION_REASON_LABELS[reason],
    })),
  );

/** The four reason codes, in Google's order (section 7.5). */
export const DEVICE_DEPROVISION_REASON_CODES: readonly DeviceDeprovisionReasonCode[] =
  Object.freeze(DEVICE_DEPROVISION_CODES.map((entry) => entry.code));

/** The Status cell codes of section 7.5. The import sheet lists them. */
export const DEVICE_STATUS_CELL_CODES = [
  'ACTIVE',
  'DISABLED',
  'DEPROVISION:<reason code>',
] as const;

/** The refusal of a Status cell that holds no code (section 7.5). It names the code list. */
export const DEVICE_STATUS_CELL_REFUSAL = `Status accepts ${DEVICE_STATUS_CELL_CODES.join(
  ', ',
)}. Reason codes: ${DEVICE_DEPROVISION_REASON_CODES.join(', ')}.`;

/** The status values of Google's `ChromeOsDevice.status`. */
export const GOOGLE_DEVICE_STATUSES = [
  'ACTIVE',
  'DELINQUENT',
  'PRE_PROVISIONED',
  'DEPROVISIONED',
  'DISABLED',
  'INACTIVE',
  'RETURN_ARRIVED',
  'RETURN_REQUESTED',
  'SHIPPED',
  'UNKNOWN',
] as const;
export const googleDeviceStatusSchema = z.enum(GOOGLE_DEVICE_STATUSES);
export type GoogleDeviceStatus = z.infer<typeof googleDeviceStatusSchema>;

/**
 * The effect of one Status cell (section 7.5). `none` carries no change: `status` is null for a
 * blank cell, and the export-only Google value otherwise.
 */
export type DeviceEditStatusCellIntent =
  | { intent: 'none'; status: GoogleDeviceStatus | null }
  | { intent: 'reenable' }
  | { intent: 'disable' }
  | { intent: 'deprovision'; reason: DeprovisionReason };

export type DeviceEditStatusCellResult =
  | { ok: true; intent: DeviceEditStatusCellIntent }
  | { ok: false; reason: string };

function isGoogleDeviceStatus(value: string): value is GoogleDeviceStatus {
  return GOOGLE_DEVICE_STATUSES.some((status) => status === value);
}

function deprovisionReasonForCode(code: string): DeprovisionReason | null {
  const entry = DEVICE_DEPROVISION_CODES.find((item) => item.code === code);
  return entry === undefined ? null : entry.reason;
}

/**
 * The intent of a Status cell whose text matches a code exactly, or null when no code matches.
 * A code matches in upper case only.
 */
function statusCellIntentForCode(
  value: string,
): DeviceEditStatusCellIntent | null {
  if (value === 'ACTIVE') return { intent: 'reenable' };
  if (value === 'DISABLED') return { intent: 'disable' };
  if (value.startsWith('DEPROVISION:')) {
    const reason = deprovisionReasonForCode(value.slice('DEPROVISION:'.length));
    return reason === null ? null : { intent: 'deprovision', reason };
  }
  if (isGoogleDeviceStatus(value)) return { intent: 'none', status: value };
  return null;
}

/**
 * The refusal of a Status cell (section 7.5). A cell that the upper case of the cell would match
 * leads with the upper-case code. A cell that holds DEPROVISION alone names the missing reason
 * code. Every other cell keeps the code list alone.
 */
function statusCellRefusal(value: string): string {
  const upper = value.toUpperCase();
  if (statusCellIntentForCode(upper) !== null)
    return `Status codes are upper case. Write ${upper}. ${DEVICE_STATUS_CELL_REFUSAL}`;
  if (upper === 'DEPROVISION' || upper === 'DEPROVISION:')
    return `DEPROVISION needs a reason code. ${DEVICE_STATUS_CELL_REFUSAL}`;
  return DEVICE_STATUS_CELL_REFUSAL;
}

/**
 * The effect of a Status cell (section 7.5). Outer spaces are ignored. A code matches exactly, in
 * upper case. Device eligibility stays with the validation job.
 */
export function deviceEditStatusCellIntent(
  cell: string,
): DeviceEditStatusCellResult {
  const value = cell.trim();
  if (value === '')
    return { ok: true, intent: { intent: 'none', status: null } };
  const intent = statusCellIntentForCode(value);
  if (intent !== null) return { ok: true, intent };
  return { ok: false, reason: statusCellRefusal(value) };
}

/** The clear token of section 7.3, in the canonical form that the checksum hashes. */
export const DEVICE_EDIT_CLEAR_TOKEN = '[clear]';

/** The intent of one field cell (section 7.3). */
export type DeviceEditFieldCellIntent =
  | { intent: 'keep' }
  | { intent: 'clear' }
  | { intent: 'assign'; value: string };

function isClearToken(cell: string | null): boolean {
  return cellText(cell).trim().toLowerCase() === DEVICE_EDIT_CLEAR_TOKEN;
}

/**
 * The intent of one field cell (section 7.3). An empty cell, or one that holds spaces only, keeps
 * the value. `[clear]` in any letter case, with outer spaces ignored, clears the field. Any other
 * cell assigns its value, with its spaces kept.
 */
export function deviceEditFieldCellIntent(
  cell: string,
): DeviceEditFieldCellIntent {
  if (cell.trim() === '') return { intent: 'keep' };
  if (isClearToken(cell)) return { intent: 'clear' };
  return { intent: 'assign', value: cell };
}

export type DeviceEditFieldCellResult =
  | { ok: true; change: DeviceUpdateChange | null }
  | { ok: false; reason: string };

/**
 * The refusal of a clear of Asset tag or Organization unit (section 7.3). The schema refuses both
 * clears, so the module names what the person writes instead. Every other field keeps the schema
 * message.
 */
const DEVICE_EDIT_CLEAR_REFUSALS: Readonly<
  Partial<Record<DeviceUpdateField, string>>
> = Object.freeze({
  annotatedAssetId:
    'Asset tag cannot be cleared. Write a new tag, or leave the cell blank to keep the current tag.',
  orgUnitPath:
    'Organization unit cannot be cleared. Write a unit path, or leave the cell blank to keep the current unit.',
});

/**
 * The change of one field cell (sections 7.3 and 7.4), or the reason that the cell rejects. A
 * blank cell answers no change. The change runs through `deviceUpdateChangeSchema`, so the field
 * rules and the limits stay in `devices.ts`. An Organization unit assign is a move. A clear of
 * Asset tag or Organization unit rejects with the reason of `DEVICE_EDIT_CLEAR_REFUSALS`.
 */
export function deviceEditFieldChange(
  field: DeviceUpdateField,
  cell: string,
): DeviceEditFieldCellResult {
  const cellIntent = deviceEditFieldCellIntent(cell);
  if (cellIntent.intent === 'keep') return { ok: true, change: null };
  const change =
    cellIntent.intent === 'clear'
      ? { field, mode: 'clear' as const }
      : {
          field,
          mode:
            field === 'orgUnitPath' ? ('move' as const) : ('replace' as const),
          value: cellIntent.value,
        };
  const parsed = deviceUpdateChangeSchema.safeParse(change);
  if (parsed.success) return { ok: true, change: parsed.data };
  if (cellIntent.intent === 'clear') {
    const clearRefusal = DEVICE_EDIT_CLEAR_REFUSALS[field];
    if (clearRefusal !== undefined) return { ok: false, reason: clearRefusal };
  }
  const message =
    parsed.error.issues[0]?.message ?? 'The field rule refused this value.';
  const label = DEVICE_UPDATE_FIELD_LABELS[field];
  return {
    ok: false,
    reason:
      cellIntent.intent === 'clear'
        ? `${label} cannot be cleared. ${message}`
        : message,
  };
}

/** The characters that a spreadsheet reads as the start of a formula (section 6.4). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * The cell that the export writes (section 6.4). A value that starts a formula gets one leading
 * tab, so the spreadsheet stores text. The row checksum covers the value without that tab.
 */
export function deviceEditEscapeCell(value: string): string {
  return FORMULA_START.test(value) ? `\t${value}` : value;
}

/**
 * The value of a cell that the import reads (section 6.4). The import removes exactly the tab that
 * the export added, which follows one of the formula starts. A value that a person starts with a
 * tab and another character stays unchanged.
 */
export function deviceEditUnescapeCell(cell: string): string {
  const rest = cell.slice(1);
  return cell.startsWith('\t') && FORMULA_START.test(rest) ? rest : cell;
}

/**
 * The text of one cell. A null cell is empty text (section 8.2), so a stored device field that
 * Google leaves unset needs no conversion at the call site.
 */
function cellText(cell: string | null): string {
  return cell ?? '';
}

/**
 * The canonical text of one cell (section 8.2). A null cell, an empty cell, and a spaces-only
 * cell become empty text. CRLF and CR become LF. The text is NFC. Spaces inside a value stay.
 */
export function deviceEditCanonicalValue(cell: string | null): string {
  const value = cellText(cell).replace(/\r\n?/g, '\n');
  return value.trim() === '' ? '' : value.normalize('NFC');
}

/**
 * The canonical Status cell (section 8.2). Outer spaces are removed and the letter case stays.
 * The clear token has no meaning in this column, so its text stays.
 */
export function deviceEditCanonicalStatusCell(cell: string | null): string {
  return deviceEditCanonicalValue(cell).trim();
}

/**
 * The canonical value of one field cell (section 8.2). A clear token hashes as the token text, so
 * a clear differs from a blank. A null cell is a blank. An Organization unit path compares
 * without case.
 */
export function deviceEditCanonicalFieldValue(
  field: DeviceUpdateField,
  cell: string | null,
): string {
  if (isClearToken(cell)) return DEVICE_EDIT_CLEAR_TOKEN;
  const value = deviceEditCanonicalValue(cell);
  return field === 'orgUnitPath' ? value.toLowerCase() : value;
}

/**
 * The eight values of one row checksum (section 8.1), in template order: the schema version, the
 * device ID, the Status cell, and the five canonical field values.
 */
export type DeviceEditRowChecksumValues = readonly [
  schemaVersion: number,
  deviceId: string,
  status: string,
  annotatedAssetId: string,
  annotatedLocation: string,
  annotatedUser: string,
  notes: string,
  orgUnitPath: string,
];

/** The cells that a row checksum covers, without the formula escape. A null cell is blank. */
export interface DeviceEditRowCells {
  /** Google's `deviceId`. */
  deviceId: string;
  /** The Status cell. */
  status: string | null;
  annotatedAssetId: string | null;
  annotatedLocation: string | null;
  annotatedUser: string | null;
  notes: string | null;
  orgUnitPath: string | null;
}

/** The canonical values that the row checksum digests (sections 8.1 and 8.2). */
export function deviceEditRowChecksumValues(
  row: DeviceEditRowCells,
): DeviceEditRowChecksumValues {
  return [
    DEVICE_EDIT_TEMPLATE_SCHEMA_VERSION,
    deviceEditCanonicalValue(row.deviceId),
    deviceEditCanonicalStatusCell(row.status),
    deviceEditCanonicalFieldValue('annotatedAssetId', row.annotatedAssetId),
    deviceEditCanonicalFieldValue('annotatedLocation', row.annotatedLocation),
    deviceEditCanonicalFieldValue('annotatedUser', row.annotatedUser),
    deviceEditCanonicalFieldValue('notes', row.notes),
    deviceEditCanonicalFieldValue('orgUnitPath', row.orgUnitPath),
  ];
}

const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Encode bytes as base64url without padding (RFC 4648 section 5). The module imports no Node
 * built-in, because the frontend bundles this library.
 */
function base64Url(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    text += BASE64URL_ALPHABET[first >> 2];
    text += BASE64URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second === undefined) break;
    text += BASE64URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    if (third === undefined) break;
    text += BASE64URL_ALPHABET[third & 0x3f];
  }
  return text;
}

/**
 * The row checksum of section 8.1: the schema version, a dot, and the first 16 digest bytes of the
 * canonical values as 22 base64url characters. The digest needs no key. It detects edits.
 */
export async function deviceEditRowChecksum(
  row: DeviceEditRowCells,
): Promise<string> {
  const input = JSON.stringify(deviceEditRowChecksumValues(row));
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
  return `${DEVICE_EDIT_TEMPLATE_SCHEMA_VERSION}.${base64Url(
    new Uint8Array(digest).subarray(0, 16),
  )}`;
}

/** The payload length of a checksum cell: 16 digest bytes as 22 base64url characters. */
const CHECKSUM_PAYLOAD_LENGTH = 22;

/**
 * Section 8.3: a malformed checksum cell makes its row a candidate row. The cell carries the
 * schema version, a dot, and 22 base64url characters.
 */
export function deviceEditChecksumIsWellFormed(cell: string): boolean {
  const prefix = `${DEVICE_EDIT_TEMPLATE_SCHEMA_VERSION}.`;
  if (!cell.startsWith(prefix)) return false;
  const payload = cell.slice(prefix.length);
  return (
    payload.length === CHECKSUM_PAYLOAD_LENGTH &&
    [...payload].every((character) => BASE64URL_ALPHABET.includes(character))
  );
}

/** One template column and its index in the file header row. */
export interface DeviceEditHeaderMapping {
  key: DeviceEditColumnKey;
  /** The header text of the template column. */
  header: string;
  /** The 0-based index of the column in the file header row. */
  index: number;
}

/** One file header that matches no template column. */
export interface DeviceEditUnknownHeader {
  header: string;
  index: number;
}

/** The header mapping of one file (section 7.2). */
export interface DeviceEditHeaderMatch {
  /** Each template column and its file index, in template order. */
  columns: readonly DeviceEditHeaderMapping[];
  /** Each file header that matches no template column. */
  unknown: readonly DeviceEditUnknownHeader[];
  /** One warning for each unknown column. The report lists them. */
  warnings: readonly string[];
}

export type DeviceEditHeaderMatchResult =
  | { ok: true; match: DeviceEditHeaderMatch }
  | { ok: false; reason: string };

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

function listNames(names: readonly string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

function duplicateHeaderReason(
  label: string,
  first: number,
  second: number,
): string {
  return `The file holds two "${label}" columns, at positions ${first + 1} and ${
    second + 1
  }. Remove one.`;
}

/**
 * Match the headers of a file to the template columns (section 7.2). Matching ignores outer
 * spaces and letter case. A missing column refuses the file and names the column. A duplicate
 * header refuses the file, whether it names a template column or an unknown one. An unknown
 * column stays out of the mapping and returns a warning. Checksum is optional in Sync all rows
 * only.
 */
export function matchDeviceEditHeaders(
  headers: readonly string[],
  mode: DeviceImportMode = DEVICE_IMPORT_MODE_DEFAULT,
): DeviceEditHeaderMatchResult {
  const columnsByHeader = new Map<string, DeviceEditColumn>();
  for (const column of DEVICE_EDIT_TEMPLATE_COLUMNS)
    columnsByHeader.set(normalizeHeader(column.header), column);
  const indexes = new Map<DeviceEditColumnKey, number>();
  const unknown: DeviceEditUnknownHeader[] = [];
  const warnings: string[] = [];
  // Duplicate detection covers every header name, known or unknown, before the unknown branch.
  const seenHeaders = new Map<string, { index: number; label: string }>();
  for (const [index, header] of headers.entries()) {
    const name = normalizeHeader(header);
    const seen = seenHeaders.get(name);
    if (seen !== undefined)
      return {
        ok: false,
        reason: duplicateHeaderReason(seen.label, seen.index, index),
      };
    const column = columnsByHeader.get(name);
    seenHeaders.set(name, {
      index,
      label: column === undefined ? header.trim() : column.header,
    });
    if (column === undefined) {
      unknown.push({ header, index });
      warnings.push(
        `The column "${header}" is unknown. It stays out of every write.`,
      );
      continue;
    }
    indexes.set(column.key, index);
  }
  const required = DEVICE_EDIT_TEMPLATE_COLUMNS.filter(
    (column) => mode !== 'sync-all-rows' || column.key !== 'checksum',
  );
  const missing = required.filter((column) => !indexes.has(column.key));
  if (missing.length > 0) {
    const names = listNames(missing.map((column) => column.header));
    const missingColumns =
      missing.length === 1
        ? `The file is missing the ${names} column.`
        : `The file is missing the ${names} columns.`;
    // Sync changes reads every row checksum, so a missing Checksum column names that mode. Sync
    // all rows ignores the column, so its file never reaches this branch.
    const checksumNote = missing.some((column) => column.key === 'checksum')
      ? ' Sync changes needs the Checksum column. Sync all rows ignores it.'
      : '';
    return { ok: false, reason: `${missingColumns}${checksumNote}` };
  }
  const columns: DeviceEditHeaderMapping[] = [];
  for (const column of DEVICE_EDIT_TEMPLATE_COLUMNS) {
    const index = indexes.get(column.key);
    if (index === undefined) continue;
    columns.push({ key: column.key, header: column.header, index });
  }
  return { ok: true, match: { columns, unknown, warnings } };
}
