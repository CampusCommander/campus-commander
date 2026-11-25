import { constants as bufferConstants } from 'node:buffer';
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  freshnessCutoff,
  userAttributeCategoriesSchema,
  userAttributeJobReceiptSchema,
  userAttributeKey,
  userAttributePreviewSchema,
  userAttributeRowValueSchema,
  userAttributeTargetsPageSchema,
  USER_ATTRIBUTE_EDITS_LIMIT,
  USER_ATTRIBUTE_TEXT_MAX,
  USER_ATTRIBUTE_VALUES_LIMIT,
  type SessionResponse,
  type UserAttributeCategory,
  type UserAttributeChange,
  type UserAttributeDisposition,
  type UserAttributeEditPreviewRequestShape,
  type UserAttributeField,
  type UserAttributeFieldType,
  type UserAttributeJobReceipt,
  type UserAttributePreview,
  type UserAttributePreviewConfirmRequest,
  type UserAttributePreviewRequestShape,
  type UserAttributePreviewSource,
  type UserAttributeRowValue,
  type UserAttributeTargetsPage,
  type UserAttributeValue,
  type UserCustomSchemas,
  type UserSelectionKey,
} from '@campus/application-contracts';
import { failure, type DelegatedCredential } from '@campus/google-connection';
import { hasUserSelection, type UserSelectionState } from './user-selection';

/** A value preview expires 15 minutes after it was prepared (B section 10, E17). */
export const USER_ATTRIBUTE_PREVIEW_MINUTES = 15;
/** A selection preview freezes at most 100,000 users (E17). */
export const USER_ATTRIBUTE_PREVIEW_USERS_LIMIT = 100_000;
/** One page of frozen rows holds at most 1,000 rows (B section 10). */
export const USER_ATTRIBUTE_TARGETS_LIMIT = 1000;
/** The edit-list read carries one deadline over every Google call (B section 8.4). */
export const USER_ATTRIBUTE_READ_DEADLINE_MILLISECONDS = 25_000;
/**
 * B section 3 bounds a list by its total text: 150 values of 100 characters or 50 values of 500.
 * One list therefore holds at most 25,000 code points, in at most 150 entries.
 */
const USER_ATTRIBUTE_LIST_TEXT_LIMIT = 25_000;
/** One code point is at most two UTF-16 units, and JSON escapes one unit into at most six bytes. */
const USER_ATTRIBUTE_CODE_POINT_UNITS = 2;
const USER_ATTRIBUTE_JSON_BYTES_PER_UNIT = 6;
/**
 * The largest supported body in wire bytes. An edit list holds at most 2,500 edits on 500 users
 * (E17), each with a requested list and a baseline list. One list holds 25,000 code points, which
 * are at most 50,000 UTF-16 units and at most six JSON bytes per unit. Each of its at most 150
 * entries carries its keys, quotes, and comma, and each edit carries its own keys. The bound is
 * therefore 2,500 x (two lists of (25,000 x 2 x 6 + 150 x 16) bytes + 1,024 bytes) plus the
 * envelope.
 */
export const USER_ATTRIBUTE_PREVIEW_SHAPE_LIMIT =
  USER_ATTRIBUTE_EDITS_LIMIT *
    (2 *
      (USER_ATTRIBUTE_LIST_TEXT_LIMIT *
        USER_ATTRIBUTE_CODE_POINT_UNITS *
        USER_ATTRIBUTE_JSON_BYTES_PER_UNIT +
        USER_ATTRIBUTE_VALUES_LIMIT * 16) +
      1024) +
  4096;
/**
 * The body cap of the preview POST. One `JSON.parse` holds at most `MAX_STRING_LENGTH` UTF-16
 * units, and a UTF-8 body never needs more units than bytes, so the cap stops at that parse
 * ceiling. The supported shape bound is above it, so every admitted body parses and no supported
 * body that one parse holds is refused.
 */
export const USER_ATTRIBUTE_PREVIEW_BODY_LIMIT = Math.min(
  USER_ATTRIBUTE_PREVIEW_SHAPE_LIMIT,
  bufferConstants.MAX_STRING_LENGTH,
);
/** One stored target batch stays below this many characters of JSON text, except that one target
 * never splits and can carry more. */
export const USER_ATTRIBUTE_STORE_BATCH_BYTES = 256 * 1024;
/** One stored target batch carries at most 1,000 targets. */
export const USER_ATTRIBUTE_STORE_BATCH_TARGETS = 1000;
/** One Directory batch holds at most 100 parts, so the read walks users in bounded groups. */
const USER_ATTRIBUTE_READ_CONCURRENCY = 8;
/** The JSON safe range of a whole number (E10). */
const JSON_SAFE_INTEGER = 9_007_199_254_740_991;
const attributeName = /^[A-Za-z0-9_-]{1,200}$/;

/** The preview base of B section 10: the cached categories under the write gate, with customer. */
export const userAttributePreviewBaseSchema =
  userAttributeCategoriesSchema.extend({
    customerId: z.string().min(1).max(64),
    generation: z.number().int().positive(),
  });
export type UserAttributePreviewBase = z.infer<
  typeof userAttributePreviewBaseSchema
>;

/** One cached user of a selection preview, with the values that the preview reads. */
export interface UserAttributePreviewUser {
  userId: string;
  primaryEmail: string;
  customSchemas: UserCustomSchemas;
  observedAt: string | null;
}

/** One frozen row of one preview, in the Google form that the value worker sends (B section 8.2). */
export interface PreviewRowDraft {
  schemaName: string;
  fieldName: string;
  /** The value that the preview read, in the Google form. Null means no value. */
  currentValue: unknown;
  /** The final value that the confirm writes, in the Google form. Null means no value. */
  newValue: unknown;
  /** The same two values in the wire form of the preview rows and the digest. */
  current: UserAttributeRowValue | null;
  requested: UserAttributeRowValue | null;
  disposition: UserAttributeDisposition;
}

/** One frozen user of one preview. */
export interface PreviewTargetDraft {
  ordinal: number;
  userId: string;
  primaryEmail: string;
  observedAt: string | null;
  disposition: UserAttributeDisposition;
  rows: PreviewRowDraft[];
}

/** The preview plus the customer, generation, and digest that its confirm freezes. */
export interface UserAttributePreviewStore {
  customerId: string;
  generation: number;
  source: UserAttributePreviewSource;
  selection: { gridId: string; tabId: string } | null;
  changes: UserAttributeChange[];
  digest: string;
  targets: PreviewTargetDraft[];
  etags: { schemaName: string; etag: string }[];
  expiresMinutes: number;
}

/** A selection read under the write gate, with the customer that it read. */
export interface UserAttributeSelectionRead {
  customerId: string;
  generation: number;
  users: UserAttributePreviewUser[];
}

/** The cache, the frozen users, the Google read, and the stored previews of the routes. */
export interface UserAttributePreviewPort {
  /** The cached set under the write gate. Null means no connection. */
  base(session: SessionResponse): Promise<UserAttributePreviewBase | null>;
  /** Require `users:write` and, for a selection, `users:bulk-actions` at the district. */
  authorize(
    session: SessionResponse,
    customerId: string,
    bulk: boolean,
    correlationId: string,
  ): Promise<void>;
  /** The stored selection of one grid tab, by the cache rules of document A section 8. */
  selection(
    session: SessionResponse,
    key: UserSelectionKey,
  ): Promise<{ state: UserSelectionState; expiredAt: string | null }>;
  /** The selected users and their cached values, under the write gate. */
  selectionUsers(
    session: SessionResponse,
    state: UserSelectionState,
  ): Promise<UserAttributeSelectionRead>;
  /** The cached email of each named user, under the write gate. Unknown IDs are left out. */
  usersByIds(
    session: SessionResponse,
    userIds: readonly string[],
  ): Promise<{ userId: string; primaryEmail: string }[]>;
  /** The read credential of an edit-list preview, under the write gate. */
  credential(
    session: SessionResponse,
    customerId: string,
    generation: number,
  ): Promise<DelegatedCredential>;
  /** One masked custom read of one user. Null means Google answered 404 (C10). */
  userValues(
    credential: DelegatedCredential,
    customerId: string,
    userId: string,
    customFieldMask: readonly string[],
    signal: AbortSignal,
  ): Promise<UserCustomSchemas | null>;
  /** Store the preview under the write gate. */
  create(
    session: SessionResponse,
    store: UserAttributePreviewStore,
  ): Promise<unknown>;
  /** The summary, to its creator only. */
  read(session: SessionResponse, previewId: string): Promise<unknown>;
  /** One page of the frozen rows, to its creator only. */
  targets(
    session: SessionResponse,
    previewId: string,
    disposition: UserAttributeDisposition | null,
    cursor: { ordinal: number; schemaName: string; fieldName: string } | null,
    limit: number,
  ): Promise<unknown>;
  /** Create the one value job, or answer its receipt again. */
  confirm(
    session: SessionResponse,
    previewId: string,
    digest: string,
    correlationId: string,
  ): Promise<unknown>;
}

/** 422 `unknown-attribute`: the cached categories hold no attribute of that name. */
function unknownAttribute(schemaName: string, fieldName: string): never {
  throw new UnprocessableEntityException({
    reason: 'unknown-attribute',
    message: `${schemaName}.${fieldName} is not in the category cache.`,
  });
}

/** 422 `invalid-value` with the label and the rule of B section 8.1. */
function refusedValue(label: string, rule: string): never {
  throw new UnprocessableEntityException({
    reason: 'invalid-value',
    message: `${label} ${rule}.`,
  });
}

function typeRule(fieldType: UserAttributeFieldType): string {
  if (fieldType === 'INT64') return 'holds a whole number';
  if (fieldType === 'DOUBLE') return 'holds a decimal number';
  if (fieldType === 'BOOL') return 'holds Yes or No';
  if (fieldType === 'DATE') return 'holds a date as YYYY-MM-DD';
  if (fieldType === 'EMAIL') return 'holds an email address';
  return 'holds 1 to 500 characters';
}

/** The range rule of E11, with the label and the bounds that the cache holds. */
function refuseRange(field: UserAttributeField, value: number): number {
  const range = field.numericIndexingSpec;
  if (!range) return value;
  if (range.minValue !== null && value < range.minValue)
    refusedValue(
      field.displayName,
      range.maxValue === null
        ? `holds a value of at least ${range.minValue}`
        : `holds a value from ${range.minValue} to ${range.maxValue}`,
    );
  if (range.maxValue !== null && value > range.maxValue)
    refusedValue(
      field.displayName,
      range.minValue === null
        ? `holds a value of at most ${range.maxValue}`
        : `holds a value from ${range.minValue} to ${range.maxValue}`,
    );
  return value;
}

/** Whether a date is a real calendar date of the form YYYY-MM-DD (B section 8.1). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Whether one text holds 1 to 500 code points and a visible character (B section 8.1, E10). */
export function isTextValue(value: string): boolean {
  // A 500-code-point text takes at most 1,000 UTF-16 units, so a longer text refuses without a
  // walk over every code point.
  if (value.length > 2 * USER_ATTRIBUTE_TEXT_MAX) return false;
  const length = [...value].length;
  return (
    length >= 1 && length <= USER_ATTRIBUTE_TEXT_MAX && value.trim().length > 0
  );
}

/** Refuse one computed final list outside Google's list rule (B section 3, B section 8.2). A list
 * takes 150 values of 100 characters or 50 of 500, so the count rule alone covers both shapes.
 */
function checkFinalList(
  field: UserAttributeField,
  values: readonly Canonical[],
): void {
  if (values.length > USER_ATTRIBUTE_VALUES_LIMIT)
    refusedValue(
      field.displayName,
      `holds at most ${USER_ATTRIBUTE_VALUES_LIMIT} values`,
    );
}

/** One entered value, checked against the info type and the range of its attribute. */
export function checkedValue(
  value: UserAttributeValue,
  field: UserAttributeField,
): string | number | boolean {
  const label = field.displayName;
  if (field.fieldType === 'BOOL') {
    if (typeof value !== 'boolean') refusedValue(label, typeRule('BOOL'));
    return value;
  }
  if (field.fieldType === 'INT64') {
    if (typeof value !== 'number' && typeof value !== 'string')
      refusedValue(label, typeRule('INT64'));
    if (typeof value === 'string' && !/^-?(?:0|[1-9][0-9]*)$/.test(value))
      refusedValue(label, typeRule('INT64'));
    const number = Number(value);
    if (
      !Number.isInteger(number) ||
      !Number.isSafeInteger(number) ||
      Math.abs(number) > JSON_SAFE_INTEGER
    )
      refusedValue(label, typeRule('INT64'));
    return refuseRange(field, number);
  }
  if (field.fieldType === 'DOUBLE') {
    if (typeof value !== 'number' && typeof value !== 'string')
      refusedValue(label, typeRule('DOUBLE'));
    if (
      typeof value === 'string' &&
      !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)
    )
      refusedValue(label, typeRule('DOUBLE'));
    const number = Number(value);
    if (!Number.isFinite(number)) refusedValue(label, typeRule('DOUBLE'));
    return refuseRange(field, number);
  }
  if (typeof value !== 'string') refusedValue(label, typeRule(field.fieldType));
  if (field.fieldType === 'EMAIL') {
    if (!z.email().max(254).safeParse(value).success)
      refusedValue(label, typeRule('EMAIL'));
    return value;
  }
  if (field.fieldType === 'DATE') {
    if (!isCalendarDate(value)) refusedValue(label, typeRule('DATE'));
    return value;
  }
  if (!isTextValue(value)) refusedValue(label, typeRule(field.fieldType));
  return value;
}

/** Refuse a mode on an attribute whose value shape it does not fit (B section 8.3). */
function checkMode(mode: string, field: UserAttributeField): void {
  if (mode === 'clear') return;
  if (mode === 'set' && field.multiValued)
    throw new UnprocessableEntityException({
      reason: 'invalid-mode',
      message: `${field.displayName} holds several values. Use Add, Remove, or Replace.`,
    });
  if (mode !== 'set' && !field.multiValued)
    throw new UnprocessableEntityException({
      reason: 'invalid-mode',
      message: `${field.displayName} holds one value. Use Set or Clear.`,
    });
}

/** One entered list, each value once (B section 8.2). */
export function checkedValues(
  values: readonly UserAttributeValue[],
  field: UserAttributeField,
): (string | number | boolean)[] {
  const checked = values.map((value) => checkedValue(value, field));
  const seen = new Set<string>();
  for (const value of checked) {
    const key = `${typeof value}:${String(value)}`;
    if (seen.has(key))
      throw new UnprocessableEntityException({
        reason: 'duplicate-value',
        message: `${field.displayName} holds each value once.`,
      });
    seen.add(key);
  }
  return checked;
}

type Canonical = string | number | boolean;

interface CurrentEntry {
  canonical: Canonical;
  /** The entry in the Google form, so a kept multi-value entry keeps type and customType. */
  raw: unknown;
}

function scalarOf(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'value')
  )
    return (value as Record<string, unknown>)['value'];
  return value;
}

function canonicalOf(
  value: unknown,
  field: UserAttributeField,
): Canonical | undefined {
  if (field.fieldType === 'INT64') {
    const number =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;
    return Number.isSafeInteger(number) ? number : undefined;
  }
  if (field.fieldType === 'DOUBLE') {
    const number =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(number) ? number : undefined;
  }
  if (field.fieldType === 'BOOL') {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return undefined;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return undefined;
}

/** The cached value of one attribute, in order, with the raw entry of each value (B section 8.2). */
export function currentEntries(
  raw: unknown,
  field: UserAttributeField,
): CurrentEntry[] {
  const list =
    raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  const entries: CurrentEntry[] = [];
  for (const entry of list) {
    const canonical = canonicalOf(scalarOf(entry), field);
    if (canonical === undefined) continue;
    entries.push({ canonical, raw: entry });
  }
  return entries;
}

function sameValues(
  left: readonly Canonical[],
  right: readonly Canonical[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** The Google form of one list of values: a scalar for one value, a list for many. */
function googleForm(value: Canonical[], field: UserAttributeField): unknown {
  if (value.length === 0) return null;
  if (!field.multiValued && value.length === 1) return value[0];
  return value;
}

/** The wire form of one stored Google value (B section 8.2). */
export function wireValue(raw: unknown): UserAttributeRowValue | null {
  if (raw === null || raw === undefined) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  const values = list.map(scalarOf);
  const wire = Array.isArray(raw) ? values : values[0];
  return userAttributeRowValueSchema.parse(wire);
}

interface FinalValue {
  canonical: Canonical[];
  raw: unknown;
}

/** Apply one mode to the current entries (B section 8.3). */
export function finalValue(
  mode: string,
  entered: readonly Canonical[],
  current: readonly CurrentEntry[],
  field: UserAttributeField,
): FinalValue {
  if (mode === 'clear') return { canonical: [], raw: null };
  if (!field.multiValued) return { canonical: [...entered], raw: entered[0] };
  if (mode === 'add') {
    const present = new Set(current.map((entry) => entry.canonical));
    const added = entered.filter((value) => !present.has(value));
    return {
      canonical: [...current.map((entry) => entry.canonical), ...added],
      raw: [
        ...current.map((entry) => entry.raw),
        ...added.map((value) => ({ value })),
      ],
    };
  }
  if (mode === 'remove') {
    const removed = new Set(entered);
    const kept = current.filter((entry) => !removed.has(entry.canonical));
    if (kept.length === 0) return { canonical: [], raw: null };
    return {
      canonical: kept.map((entry) => entry.canonical),
      raw: kept.map((entry) => entry.raw),
    };
  }
  return {
    canonical: [...entered],
    raw: entered.map((value) => ({ value })),
  };
}

function fieldOf(
  base: UserAttributePreviewBase,
  schemaName: string,
  fieldName: string,
): UserAttributeField {
  const category = base.categories.find(
    (candidate) => candidate.schemaName === schemaName,
  );
  const field = category?.fields.find(
    (candidate) => candidate.fieldName === fieldName,
  );
  if (!field) unknownAttribute(schemaName, fieldName);
  return field;
}

function categoryOf(
  base: UserAttributePreviewBase,
  schemaName: string,
): UserAttributeCategory | undefined {
  return base.categories.find(
    (candidate) => candidate.schemaName === schemaName,
  );
}

/** The category etags that a preview freezes, one for each schema that its rows name. */
function previewEtags(
  base: UserAttributePreviewBase,
  schemaNames: readonly string[],
): { schemaName: string; etag: string }[] {
  return [...new Set(schemaNames)].map((schemaName) => {
    const category = categoryOf(base, schemaName);
    if (!category) unknownAttribute(schemaName, '');
    return { schemaName, etag: category.etag };
  });
}

/** The C1 attribute key split into its two names. */
export function editAttribute(attribute: string): {
  schemaName: string;
  fieldName: string;
} {
  const [schemaName, fieldName] = attribute.slice('attr:'.length).split('.');
  return { schemaName, fieldName };
}

/** One frozen target as the store and the digest document hold it. */
function storedTarget(target: PreviewTargetDraft) {
  return {
    ordinal: target.ordinal,
    userId: target.userId,
    primaryEmail: target.primaryEmail,
    observedAt: target.observedAt,
    disposition: target.disposition,
    rows: target.rows.map((row) => ({
      schemaName: row.schemaName,
      fieldName: row.fieldName,
      currentValue: row.currentValue,
      newValue: row.newValue,
      disposition: row.disposition,
    })),
  };
}

/** One frozen target as the digest covers it. */
function digestTarget(target: PreviewTargetDraft) {
  return {
    userId: target.userId,
    rows: target.rows.map((row) => ({
      schemaName: row.schemaName,
      fieldName: row.fieldName,
      currentValue: row.current,
      newValue: row.requested,
      disposition: row.disposition,
    })),
  };
}

/**
 * The digest that the confirm names. It covers the frozen rows and the frozen changes. The hash
 * takes one fragment at a time: a complete selection can hold more text than one JavaScript
 * string allows (B section 10, E17).
 */
export function previewDigest(
  source: UserAttributePreviewSource,
  changes: readonly UserAttributeChange[],
  targets: readonly PreviewTargetDraft[],
): string {
  const hash = createHash('sha256');
  hash.update('{"actionVersion":1,"source":');
  hash.update(JSON.stringify(source));
  hash.update(',"changes":');
  if (source === 'selection') {
    hash.update('[');
    changes.forEach((change, index) => {
      if (index > 0) hash.update(',');
      hash.update(
        JSON.stringify({
          schemaName: change.schemaName,
          fieldName: change.fieldName,
          mode: change.mode,
          values: change.values,
        }),
      );
    });
    hash.update(']');
  } else hash.update('null');
  hash.update(',"targets":[');
  targets.forEach((target, index) => {
    if (index > 0) hash.update(',');
    hash.update(JSON.stringify(digestTarget(target)));
  });
  hash.update(']}');
  return hash.digest('hex');
}

/**
 * The stored targets, in bounded batches. One batch stays below
 * `USER_ATTRIBUTE_STORE_BATCH_BYTES` characters, except that one target never splits and can
 * carry more. The caller sends each batch as its own JSON argument, so no single argument holds
 * the complete selection (B section 10).
 */
export function* previewTargetBatches(
  targets: readonly PreviewTargetDraft[],
): Generator<string> {
  let parts: string[] = [];
  let bytes = 2;
  for (const target of targets) {
    const text = JSON.stringify(storedTarget(target));
    if (
      parts.length > 0 &&
      (bytes + text.length + 1 > USER_ATTRIBUTE_STORE_BATCH_BYTES ||
        parts.length >= USER_ATTRIBUTE_STORE_BATCH_TARGETS)
    ) {
      yield `[${parts.join(',')}]`;
      parts = [];
      bytes = 2;
    }
    parts.push(text);
    bytes += text.length + 1;
  }
  if (parts.length > 0) yield `[${parts.join(',')}]`;
}

/** The stored Google form of one list of cached entries: a scalar for one value, or entries. */
function googleCurrent(
  entries: readonly CurrentEntry[],
  field: UserAttributeField,
): unknown {
  if (entries.length === 0) return null;
  if (!field.multiValued) return entries[0].canonical;
  return entries.map((entry) =>
    entry.raw !== null &&
    typeof entry.raw === 'object' &&
    !Array.isArray(entry.raw)
      ? entry.raw
      : { value: entry.canonical },
  );
}

/** One row of one user, with the value checks of B section 8 already applied. */
function previewRow(
  schemaName: string,
  fieldName: string,
  field: UserAttributeField,
  mode: string,
  entered: readonly Canonical[],
  raw: unknown,
  baseline?: readonly Canonical[],
): PreviewRowDraft {
  const current = currentEntries(raw, field);
  const currentCanonical = current.map((entry) => entry.canonical);
  const final = finalValue(mode, entered, current, field);
  // Add and Replace build a new list, so the final list must fit Google's list rule (B section 8.2).
  if (field.multiValued && (mode === 'add' || mode === 'replace'))
    checkFinalList(field, final.canonical);
  const disposition: UserAttributeDisposition = sameValues(
    currentCanonical,
    final.canonical,
  )
    ? 'unchanged'
    : baseline === undefined || sameValues(currentCanonical, baseline)
      ? 'eligible'
      : 'conflict';
  return {
    schemaName,
    fieldName,
    currentValue: googleCurrent(current, field),
    newValue: final.raw,
    current: wireValue(googleForm(currentCanonical, field)),
    requested: wireValue(final.raw),
    disposition,
  };
}

function targetDisposition(
  rows: readonly PreviewRowDraft[],
): UserAttributeDisposition {
  if (rows.some((row) => row.disposition === 'conflict')) return 'conflict';
  if (rows.some((row) => row.disposition === 'eligible')) return 'eligible';
  return 'unchanged';
}

/** The changes as the store holds them, with each entered value checked (B section 8.1). */
export function checkedChanges(
  changes: readonly UserAttributePreviewRequestShape['changes'][number][],
  base: UserAttributePreviewBase,
): UserAttributeChange[] {
  return changes.map((change) => ({
    ...change,
    values: checkedValues(
      change.values,
      fieldOf(base, change.schemaName, change.fieldName),
    ),
  }));
}

/** One selection preview: every selected user against every change (B section 8.4). */
export function selectionPreviewTargets(
  users: readonly UserAttributePreviewUser[],
  changes: readonly UserAttributePreviewRequestShape['changes'][number][],
  base: UserAttributePreviewBase,
): PreviewTargetDraft[] {
  const checked = changes.map((change) => {
    const field = fieldOf(base, change.schemaName, change.fieldName);
    checkMode(change.mode, field);
    return {
      change,
      field,
      values: checkedValues(change.values, field),
    };
  });
  return users.map((user, ordinal) => {
    const rows = checked.map(({ change, field, values }) => {
      const schema = user.customSchemas[change.schemaName];
      const raw =
        schema && typeof schema === 'object'
          ? (schema as Record<string, unknown>)[change.fieldName]
          : undefined;
      return previewRow(
        change.schemaName,
        change.fieldName,
        field,
        change.mode,
        values,
        raw,
      );
    });
    const disposition = targetDisposition(rows);
    return {
      ordinal,
      userId: user.userId,
      primaryEmail: user.primaryEmail,
      observedAt: user.observedAt,
      disposition,
      rows,
    };
  });
}

/** One edit list: each edit against the fresh current value and its baseline (B section 8.4). */
export function editPreviewTargets(
  users: ReadonlyMap<string, UserAttributePreviewUser>,
  edits: readonly UserAttributeEditPreviewRequestShape['edits'][number][],
  base: UserAttributePreviewBase,
): PreviewTargetDraft[] {
  const checked = new Map<
    string,
    {
      edit: UserAttributeEditPreviewRequestShape['edits'][number];
      schemaName: string;
      fieldName: string;
      field: UserAttributeField;
      values: Canonical[];
      baseline: Canonical[];
    }
  >();
  for (const edit of edits) {
    const { schemaName, fieldName } = editAttribute(edit.attribute);
    const field = fieldOf(base, schemaName, fieldName);
    checkMode(edit.mode, field);
    const baseline =
      edit.baselineValue === null
        ? []
        : (Array.isArray(edit.baselineValue)
            ? edit.baselineValue
            : [edit.baselineValue]
          ).map((value) => {
            const canonical = canonicalOf(value, field);
            if (canonical === undefined)
              refusedValue(field.displayName, typeRule(field.fieldType));
            return canonical;
          });
    checked.set(`${edit.userId}\u0000${edit.attribute}`, {
      edit,
      schemaName,
      fieldName,
      field,
      values: checkedValues(edit.values, field),
      baseline,
    });
  }
  return [...new Set(edits.map((edit) => edit.userId))]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((userId, ordinal) => {
      const user = users.get(userId);
      if (!user) throw storeFailure();
      const rows = [...checked.values()]
        .filter((entry) => entry.edit.userId === userId)
        .sort((left, right) =>
          `${left.schemaName}\u0000${left.fieldName}` <
          `${right.schemaName}\u0000${right.fieldName}`
            ? -1
            : 1,
        )
        .map(({ edit, schemaName, fieldName, field, values, baseline }) => {
          const schema = user.customSchemas[schemaName];
          const raw =
            schema && typeof schema === 'object'
              ? (schema as Record<string, unknown>)[fieldName]
              : undefined;
          return previewRow(
            schemaName,
            fieldName,
            field,
            edit.mode,
            values,
            raw,
            baseline,
          );
        });
      return {
        ordinal,
        userId,
        primaryEmail: user.primaryEmail,
        observedAt: user.observedAt,
        disposition: targetDisposition(rows),
        rows,
      };
    });
}

function measuredAt(value: unknown): string | null {
  return value instanceof Date
    ? value.toISOString()
    : typeof value === 'string'
      ? value
      : null;
}

function storeFailure(): never {
  throw new ServiceUnavailableException({
    reason: 'user-preview-unavailable',
  });
}

/** One function answer, as an object. */
function resultOf(value: unknown): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) storeFailure();
  return parsed.data;
}

/** Map one stored-preview outcome to the status and code of B section 13. */
function previewFunctionError(result: Record<string, unknown>): never {
  const outcome = String(result['outcome']);
  if (outcome === 'forbidden')
    throw new ForbiddenException({ reason: 'forbidden' });
  if (outcome === 'not-found')
    throw new NotFoundException({ reason: 'preview-not-found' });
  if (outcome === 'preview-expired')
    throw new GoneException({
      reason: 'preview-expired',
      expiresAt: measuredAt(result['expiresAt']),
    });
  if (outcome === 'nothing-to-update')
    throw new UnprocessableEntityException({ reason: 'nothing-to-update' });
  if (
    outcome === 'preview-changed' ||
    outcome === 'category-changed' ||
    outcome === 'connection-changed' ||
    outcome === 'preview-conflict' ||
    outcome === 'permission-changed'
  )
    throw new ConflictException({ reason: outcome });
  return storeFailure();
}

/** Whether a preview reads stale because its oldest eligible target left the 24-hour cache. */
function staleAt(oldest: unknown): boolean {
  const at = measuredAt(oldest);
  if (at === null) return false;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) && parsed < freshnessCutoff('user').getTime();
}

function summaryOf(value: unknown): UserAttributePreview {
  const preview = z.record(z.string(), z.unknown()).parse(value);
  return userAttributePreviewSchema.parse({
    ...preview,
    stale: staleAt(preview['oldestObservedAt']),
  });
}

/** One frozen page row, in the wire form of the preview contract. */
function targetOf(row: Record<string, unknown>) {
  return {
    userId: String(row['userId']),
    primaryEmail: String(row['primaryEmail']),
    attribute: userAttributeKey(
      String(row['schemaName']),
      String(row['fieldName']),
    ),
    currentValue: wireValue(row['currentValue']),
    newValue: wireValue(row['newValue']),
    disposition: row['disposition'],
    observedAt: measuredAt(row['observedAt']),
  };
}

function receiptOf(value: unknown): UserAttributeJobReceipt {
  return userAttributeJobReceiptSchema.parse(value);
}

/** Parse one targets cursor of the form `ordinal:schema.field` (B section 10). */
export function parseTargetsCursor(cursor: string): {
  ordinal: number;
  schemaName: string;
  fieldName: string;
} {
  const separator = cursor.indexOf(':');
  const attribute = cursor.slice(separator + 1);
  const dot = attribute.indexOf('.');
  const ordinal = Number(cursor.slice(0, separator));
  const schemaName = attribute.slice(0, dot);
  const fieldName = attribute.slice(dot + 1);
  if (
    separator < 1 ||
    dot < 1 ||
    !Number.isInteger(ordinal) ||
    ordinal < 0 ||
    !attributeName.test(schemaName) ||
    !attributeName.test(fieldName)
  )
    throw new UnprocessableEntityException({ reason: 'invalid-cursor' });
  return { ordinal, schemaName, fieldName };
}

/** The one overall Google read deadline elapsed, before a further call could start (C10). */
class ReadDeadlineError extends Error {}

/** Run one async call for each item, with a bounded number in flight (C10). */
async function inBatches<T>(
  items: readonly string[],
  run: (item: string) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(USER_ATTRIBUTE_READ_CONCURRENCY, items.length) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await run(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** The value preview and confirm routes of document B section 10. */
export class UserAttributePreviews {
  private readonly port: UserAttributePreviewPort;

  constructor(port: UserAttributePreviewPort) {
    this.port = port;
  }

  /**
   * Read each edited user from Google with the read-only user scope (B section 8.4). A Google
   * refusal answers 503 `user-read-failed` with its code, and the draft stays (C10, B section 13).
   */
  private async readUsers(
    credential: DelegatedCredential,
    customerId: string,
    userIds: readonly string[],
    customFieldMask: readonly string[],
  ): Promise<Map<string, UserCustomSchemas | null>> {
    const deadline = Date.now() + USER_ATTRIBUTE_READ_DEADLINE_MILLISECONDS;
    const read = new Map<string, UserCustomSchemas | null>();
    try {
      const answers = await inBatches(userIds, (userId) => {
        const left = deadline - Date.now();
        if (left <= 0) throw new ReadDeadlineError();
        return this.port.userValues(
          credential,
          customerId,
          userId,
          customFieldMask,
          AbortSignal.timeout(left),
        );
      });
      userIds.forEach((userId, index) => read.set(userId, answers[index]));
    } catch (error) {
      // A refused credential or another local answer keeps its own status.
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({
        reason: 'user-read-failed',
        failure:
          error instanceof ReadDeadlineError
            ? 'network-failure'
            : failure(error, 'read').code,
      });
    }
    return read;
  }

  private async selectionStore(
    session: SessionResponse,
    base: UserAttributePreviewBase,
    request: UserAttributePreviewRequestShape,
    correlationId: string,
  ): Promise<UserAttributePreviewStore> {
    await this.port.authorize(session, base.customerId, true, correlationId);
    const { state, expiredAt } = await this.port.selection(session, {
      gridId: request.gridId,
      tabId: request.tabId,
    });
    if (expiredAt !== null)
      throw new ConflictException({ reason: 'selection-expired', expiredAt });
    if (!hasUserSelection(state))
      throw new UnprocessableEntityException({ reason: 'nothing-selected' });
    const read = await this.port.selectionUsers(session, state);
    if (
      read.customerId !== base.customerId ||
      read.generation !== base.generation
    )
      throw new ConflictException({ reason: 'connection-changed' });
    if (read.users.length > USER_ATTRIBUTE_PREVIEW_USERS_LIMIT)
      throw new UnprocessableEntityException({
        reason: 'selection-too-large',
        limit: USER_ATTRIBUTE_PREVIEW_USERS_LIMIT,
      });
    if (read.users.length === 0)
      throw new UnprocessableEntityException({ reason: 'nothing-selected' });
    const changes = checkedChanges(request.changes, base);
    const targets = selectionPreviewTargets(read.users, request.changes, base);
    const digest = previewDigest('selection', changes, targets);
    return {
      customerId: base.customerId,
      generation: base.generation,
      source: 'selection',
      selection: { gridId: request.gridId, tabId: request.tabId },
      changes,
      digest,
      targets,
      etags: previewEtags(
        base,
        request.changes.map((change) => change.schemaName),
      ),
      expiresMinutes: USER_ATTRIBUTE_PREVIEW_MINUTES,
    };
  }

  private async editStore(
    session: SessionResponse,
    base: UserAttributePreviewBase,
    request: UserAttributeEditPreviewRequestShape,
    correlationId: string,
  ): Promise<UserAttributePreviewStore> {
    await this.port.authorize(session, base.customerId, false, correlationId);
    // Every named attribute must exist before the Google read starts.
    for (const edit of request.edits) {
      const { schemaName, fieldName } = editAttribute(edit.attribute);
      fieldOf(base, schemaName, fieldName);
    }
    const userIds = [...new Set(request.edits.map((edit) => edit.userId))];
    const known = await this.port.usersByIds(session, userIds);
    const knownById = new Map(
      known.map((user) => [user.userId, user.primaryEmail] as const),
    );
    const missing = userIds.filter((userId) => !knownById.has(userId));
    if (missing.length)
      throw new UnprocessableEntityException({
        reason: 'user-not-found',
        userIds: missing,
      });
    const credential = await this.port.credential(
      session,
      base.customerId,
      base.generation,
    );
    const observedAt = new Date().toISOString();
    const mask = [
      ...new Set(
        request.edits.map((edit) => editAttribute(edit.attribute).schemaName),
      ),
    ];
    const values = await this.readUsers(
      credential,
      base.customerId,
      userIds,
      mask,
    );
    const absent = userIds.filter((userId) => values.get(userId) === null);
    if (absent.length)
      throw new UnprocessableEntityException({
        reason: 'user-not-found',
        userIds: absent,
      });
    const users = new Map<string, UserAttributePreviewUser>(
      userIds.map((userId) => [
        userId,
        {
          userId,
          primaryEmail: knownById.get(userId) as string,
          customSchemas: values.get(userId) ?? {},
          observedAt,
        },
      ]),
    );
    const targets = editPreviewTargets(users, request.edits, base);
    const digest = previewDigest('edit-list', [], targets);
    return {
      customerId: base.customerId,
      generation: base.generation,
      source: 'edit-list',
      selection: null,
      changes: [],
      digest,
      targets,
      etags: previewEtags(
        base,
        request.edits.map((edit) => editAttribute(edit.attribute).schemaName),
      ),
      expiresMinutes: USER_ATTRIBUTE_PREVIEW_MINUTES,
    };
  }

  /** Freeze one preview from a selection key or an edit list (B section 10). */
  async preview(
    session: SessionResponse,
    request:
      | UserAttributePreviewRequestShape
      | UserAttributeEditPreviewRequestShape,
    correlationId: string,
  ): Promise<UserAttributePreview> {
    const base = await this.port.base(session);
    if (!base) throw new ConflictException({ reason: 'connection-required' });
    const store =
      'edits' in request
        ? await this.editStore(session, base, request, correlationId)
        : await this.selectionStore(session, base, request, correlationId);
    const result = resultOf(await this.port.create(session, store));
    if (result['outcome'] !== 'created') previewFunctionError(result);
    return summaryOf(result['preview']);
  }

  /** The preview summary, to its creator only (B section 10). */
  async byId(
    session: SessionResponse,
    previewId: string,
    correlationId: string,
  ): Promise<UserAttributePreview> {
    const result = resultOf(await this.port.read(session, previewId));
    if (result['outcome'] !== 'preview') previewFunctionError(result);
    await this.port.authorize(
      session,
      String(result['customerId']),
      false,
      correlationId,
    );
    return summaryOf(result['preview']);
  }

  /** One page of the frozen rows, to its creator only (B section 10). */
  async targets(
    session: SessionResponse,
    previewId: string,
    disposition: UserAttributeDisposition | null,
    cursor: { ordinal: number; schemaName: string; fieldName: string } | null,
    limit: number,
    correlationId: string,
  ): Promise<UserAttributeTargetsPage> {
    const result = resultOf(
      await this.port.targets(session, previewId, disposition, cursor, limit),
    );
    if (result['outcome'] !== 'page') previewFunctionError(result);
    await this.port.authorize(
      session,
      String(result['customerId']),
      false,
      correlationId,
    );
    const rows = z
      .array(z.record(z.string(), z.unknown()))
      .parse(result['targets']);
    return userAttributeTargetsPageSchema.parse({
      targets: rows.map(targetOf),
      nextCursor: result['nextCursor'] ?? null,
    });
  }

  /**
   * Confirm one preview. A first confirm answers 201 with the `UAT-` receipt, and a repeated
   * confirm answers the same receipt with 200 (B section 10).
   */
  async confirm(
    session: SessionResponse,
    previewId: string,
    input: UserAttributePreviewConfirmRequest,
    correlationId: string,
  ): Promise<{ receipt: UserAttributeJobReceipt; existing: boolean }> {
    // The preview read answers the connected customer before the person check, so a missing or
    // expired preview never reaches the job function.
    const read = resultOf(await this.port.read(session, previewId));
    if (read['outcome'] !== 'preview') previewFunctionError(read);
    const preview = summaryOf(read['preview']);
    await this.port.authorize(
      session,
      String(read['customerId']),
      preview.source === 'selection',
      correlationId,
    );
    const result = resultOf(
      await this.port.confirm(
        session,
        previewId,
        input.manifestDigest,
        correlationId,
      ),
    );
    const outcome = String(result['outcome']);
    if (outcome === 'created')
      return { receipt: receiptOf(result['receipt']), existing: false };
    if (outcome === 'existing')
      return { receipt: receiptOf(result['receipt']), existing: true };
    return previewFunctionError(result);
  }
}
