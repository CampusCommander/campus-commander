import * as z from 'zod';
import {
  userAttributeKey,
  type UserAttributeCategory,
  type UserAttributeEdit,
  type UserAttributeField,
  type UserAttributeRowValue,
  type UserCustomSchemas,
} from '@campus/application-contracts';

/** The text limit of one value (B section 8.1, UM notes ruling 4). */
export const ATTRIBUTE_TEXT_LIMIT = 500;

/** Google's largest list holds 150 entries (B section 3, B section 8.2). */
export const ATTRIBUTE_VALUES_LIMIT = 150;

/** The JSON safe integer range of a whole number (B section 8.1, E10). */
const JSON_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

type Canonical = string | number | boolean;

/** One editor field of the Custom attributes card form. */
export interface AttributeDraft {
  /** The C1 attribute ID (design C1). */
  key: string;
  schemaName: string;
  fieldName: string;
  label: string;
  field: UserAttributeField;
  /** The value that the card showed when the edit began, in wire form. */
  baseline: UserAttributeRowValue | null;
  /** The editor state: text, a Yes or No answer, or the chip values. */
  value: string | boolean | null | string[];
}

/** The result of reading one editor field. */
export interface AttributeDraftResult {
  /** The editor value differs from the baseline. */
  changed: boolean;
  /** The message under the field, or null while the value passes. */
  error: string | null;
  /** The edit to save, or null for an unchanged or refused value. */
  edit: UserAttributeEdit | null;
}

/** The over-limit message of in-grid editing (UM notes ruling 4). */
export function attributeCountText(count: number): string {
  return `${count} of ${ATTRIBUTE_TEXT_LIMIT} characters`;
}

/**
 * The raw value of one attribute. Only own properties hold a value, so a category or field
 * named after an Object prototype member reads as unset.
 */
function readValue(
  schemas: UserCustomSchemas,
  schemaName: string,
  fieldName: string,
): unknown {
  const category = Object.hasOwn(schemas, schemaName)
    ? schemas[schemaName]
    : undefined;
  return category &&
    typeof category === 'object' &&
    Object.hasOwn(category, fieldName)
    ? (category as Record<string, unknown>)[fieldName]
    : undefined;
}

/** A multi-value entry unwraps to its `value` key. */
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

/** The canonical form of one stored value (B section 8.1). */
function canonicalOf(
  value: unknown,
  field: UserAttributeField,
): Canonical | null {
  if (field.fieldType === 'INT64') {
    const number =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;
    return Number.isSafeInteger(number) ? number : null;
  }
  if (field.fieldType === 'DOUBLE') {
    const number =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(number) ? number : null;
  }
  if (field.fieldType === 'BOOL') {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return null;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return null;
}

/** The baseline of one attribute: the value that the card showed in read mode. */
export function attributeBaseline(
  raw: unknown,
  field: UserAttributeField,
): UserAttributeRowValue | null {
  const list =
    raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const canonical: Canonical[] = [];
  for (const entry of list) {
    const value = canonicalOf(scalarOf(entry), field);
    if (value !== null) canonical.push(value);
  }
  if (field.multiValued) return canonical.length ? canonical : null;
  return canonical.length ? canonical[0]! : null;
}

/** The editor value that starts from one baseline. */
export function attributeEditorValue(
  baseline: UserAttributeRowValue | null,
  field: UserAttributeField,
): string | boolean | null | string[] {
  if (field.multiValued) {
    if (baseline === null) return [];
    const list = Array.isArray(baseline) ? baseline : [baseline];
    // A Yes or No entry keeps the words of its editor, so a chip shows and validates Yes or No.
    return list.map((value) =>
      field.fieldType === 'BOOL' && typeof value === 'boolean'
        ? value
          ? 'Yes'
          : 'No'
        : String(value),
    );
  }
  if (field.fieldType === 'BOOL')
    return typeof baseline === 'boolean' ? baseline : null;
  return baseline === null ? '' : String(baseline);
}

/** Every editor field of the card, in the order of the category read. */
export function attributeDrafts(
  categories: readonly UserAttributeCategory[],
  schemas: UserCustomSchemas,
): AttributeDraft[] {
  return categories.flatMap((category) =>
    category.fields.map((field): AttributeDraft => {
      const baseline = attributeBaseline(
        readValue(schemas, category.schemaName, field.fieldName),
        field,
      );
      return {
        key: userAttributeKey(category.schemaName, field.fieldName),
        schemaName: category.schemaName,
        fieldName: field.fieldName,
        label: field.displayName,
        field,
        baseline,
        value: attributeEditorValue(baseline, field),
      };
    }),
  );
}

/** Whether a date is a real calendar date of the form YYYY-MM-DD (B section 8.1). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year!, month! - 1, day!);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
  );
}

/** Whether one text holds 1 to 500 code points and a visible character (B section 8.1). */
function textError(label: string, value: string): string | null {
  const length = [...value].length;
  // The count message of in-grid editing names the over-limit count (UM notes ruling 4).
  if (length > ATTRIBUTE_TEXT_LIMIT) return attributeCountText(length);
  if (length < 1 || value.trim().length === 0)
    return `${label} holds 1 to ${ATTRIBUTE_TEXT_LIMIT} characters.`;
  return null;
}

/** The range rule of E11, with the bounds that the cache holds. */
function rangeError(field: UserAttributeField, value: number): string | null {
  const range = field.numericIndexingSpec;
  if (!range) return null;
  if (range.minValue !== null && value < range.minValue)
    return range.maxValue === null
      ? `${field.displayName} holds a value of at least ${range.minValue}.`
      : `${field.displayName} holds a value from ${range.minValue} to ${range.maxValue}.`;
  if (range.maxValue !== null && value > range.maxValue)
    return range.minValue === null
      ? `${field.displayName} holds a value of at most ${range.maxValue}.`
      : `${field.displayName} holds a value from ${range.minValue} to ${range.maxValue}.`;
  return null;
}

/** The message of one typed value, in the rules and words of B section 8.1. */
function scalarError(
  field: UserAttributeField,
  value: string | number | boolean,
): string | null {
  const label = field.displayName;
  if (field.fieldType === 'BOOL')
    return typeof value === 'boolean' ? null : `${label} holds Yes or No.`;
  if (field.fieldType === 'INT64') {
    if (typeof value === 'boolean') return `${label} holds a whole number.`;
    if (typeof value === 'string' && !/^-?(?:0|[1-9][0-9]*)$/.test(value))
      return `${label} holds a whole number.`;
    const number = Number(value);
    if (
      !Number.isInteger(number) ||
      !Number.isSafeInteger(number) ||
      Math.abs(number) > JSON_SAFE_INTEGER
    )
      return `${label} holds a whole number.`;
    return rangeError(field, number);
  }
  if (field.fieldType === 'DOUBLE') {
    if (typeof value === 'boolean') return `${label} holds a decimal number.`;
    if (
      typeof value === 'string' &&
      !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)
    )
      return `${label} holds a decimal number.`;
    const number = Number(value);
    if (!Number.isFinite(number)) return `${label} holds a decimal number.`;
    return rangeError(field, number);
  }
  if (typeof value !== 'string') return `${label} holds 1 to 500 characters.`;
  if (field.fieldType === 'EMAIL')
    return z.email().max(254).safeParse(value).success
      ? null
      : `${label} holds an email address.`;
  if (field.fieldType === 'DATE')
    return isCalendarDate(value)
      ? null
      : `${label} holds a date as YYYY-MM-DD.`;
  return textError(label, value);
}

/** The editor text of one chip, in the type of its attribute. */
function chipValue(
  field: UserAttributeField,
  text: string,
): string | number | boolean {
  if (field.fieldType === 'INT64' || field.fieldType === 'DOUBLE')
    return Number(text);
  if (field.fieldType === 'BOOL')
    return text === 'Yes' ? true : text === 'No' ? false : text;
  return text;
}

/** The wire value of one editor field, before its value rules run. */
export function attributeWireValue(
  draft: AttributeDraft,
): UserAttributeRowValue | null {
  const field = draft.field;
  if (field.multiValued) {
    const list = Array.isArray(draft.value) ? draft.value : [];
    return list.length ? list.map((text) => chipValue(field, text)) : null;
  }
  if (field.fieldType === 'BOOL')
    return typeof draft.value === 'boolean' ? draft.value : null;
  const text = typeof draft.value === 'string' ? draft.value : '';
  if (field.fieldType === 'INT64' || field.fieldType === 'DOUBLE')
    return text.length ? Number(text) : null;
  return text.length ? text : null;
}

/** The message of one chip, in the rules and words of B section 8.1. */
function chipError(field: UserAttributeField, text: string): string | null {
  const label = field.displayName;
  if (field.fieldType === 'INT64') {
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(text)) return 'Enter a whole number.';
    return scalarError(field, Number(text));
  }
  if (field.fieldType === 'DOUBLE') {
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text))
      return 'Enter a decimal number.';
    return scalarError(field, Number(text));
  }
  if (field.fieldType === 'BOOL')
    return text === 'Yes' || text === 'No' ? null : `${label} holds Yes or No.`;
  return scalarError(field, text);
}

/** The message of one editor field, or null while its value passes. */
export function attributeValueError(draft: AttributeDraft): string | null {
  const field = draft.field;
  if (field.multiValued) {
    const list = Array.isArray(draft.value) ? draft.value : [];
    if (list.length > ATTRIBUTE_VALUES_LIMIT)
      return `${field.displayName} holds at most ${ATTRIBUTE_VALUES_LIMIT} values.`;
    const seen = new Set<string>();
    for (const text of list) {
      const error = chipError(field, text);
      if (error) return error;
      const value = chipValue(field, text);
      const key = `${typeof value}:${String(value)}`;
      if (seen.has(key)) return `${field.displayName} holds each value once.`;
      seen.add(key);
    }
    return null;
  }
  const text = typeof draft.value === 'string' ? draft.value : '';
  if (text.length === 0) return null;
  if (field.fieldType === 'INT64' && !/^-?(?:0|[1-9][0-9]*)$/.test(text))
    return 'Enter a whole number.';
  if (
    field.fieldType === 'DOUBLE' &&
    !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text)
  )
    return 'Enter a decimal number.';
  const wire = attributeWireValue(draft);
  // A single-value editor never builds a list, so a list here passes unchanged.
  if (wire === null || Array.isArray(wire)) return null;
  return scalarError(field, wire);
}

/** The canonical list of one wire value. */
function canonicalList(
  field: UserAttributeField,
  value: UserAttributeRowValue | null,
): Canonical[] {
  if (value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const canonical: Canonical[] = [];
  for (const entry of list) {
    const parsed = canonicalOf(entry, field);
    if (parsed !== null) canonical.push(parsed);
  }
  return canonical;
}

/** Whether two wire values read the same in the canonical form of the attribute. */
export function sameAttributeValue(
  field: UserAttributeField,
  left: UserAttributeRowValue | null,
  right: UserAttributeRowValue | null,
): boolean {
  const a = canonicalList(field, left);
  const b = canonicalList(field, right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Whether the editor still holds exactly the value that it opened with. */
export function sameEditorValue(
  left: AttributeDraft['value'],
  right: AttributeDraft['value'],
): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    const a = Array.isArray(left) ? left : [];
    const b = Array.isArray(right) ? right : [];
    return (
      a.length === b.length && a.every((value, index) => value === b[index])
    );
  }
  return left === right;
}

/** The edit of one editor field, with its baseline (B section 8.3, B section 10). */
export function attributeDraftResult(
  draft: AttributeDraft,
  userId: string,
): AttributeDraftResult {
  // The raw input runs before canonical equality. An invalid number becomes NaN and drops
  // out of the canonical list, which once made it look unchanged (R1-C). An untouched
  // field is the value that the editor opened with, so existing duplicates stay quiet.
  const pristine = sameEditorValue(
    draft.value,
    attributeEditorValue(draft.baseline, draft.field),
  );
  const error = attributeValueError(draft);
  if (error && !pristine) return { changed: true, error, edit: null };
  const wire = attributeWireValue(draft);
  const changed = !sameAttributeValue(draft.field, wire, draft.baseline);
  if (!changed) return { changed: false, error: null, edit: null };
  if (error) return { changed: true, error, edit: null };
  const values = wire === null ? [] : Array.isArray(wire) ? wire : [wire];
  return {
    changed: true,
    error: null,
    edit: {
      userId,
      attribute: draft.key,
      mode:
        wire === null ? 'clear' : draft.field.multiValued ? 'replace' : 'set',
      values,
      baselineValue: draft.baseline,
    },
  };
}

/** The edits of one save. An unchanged field adds no edit. */
export function attributeEdits(
  drafts: readonly AttributeDraft[],
  userId: string,
): UserAttributeEdit[] {
  return drafts.flatMap((draft) => {
    const result = attributeDraftResult(draft, userId);
    return result.edit ? [result.edit] : [];
  });
}

/** One wire value as the read card and the review rows show it. */
export function attributeWireText(value: UserAttributeRowValue | null): string {
  if (value === null) return 'Not set';
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((entry) =>
      typeof entry === 'boolean' ? (entry ? 'Yes' : 'No') : String(entry),
    )
    .join(', ');
}
