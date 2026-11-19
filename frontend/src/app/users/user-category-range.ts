import type {
  UserAttributeFieldType,
  UserAttributeRange,
} from '@campus/application-contracts';
import {
  RANGE_NUMBER_TEXT,
  RANGE_SAFE_INTEGER_TEXT,
  RANGE_WHOLE_NUMBER_TEXT,
  rangeMinText,
} from './user-category-messages';

/**
 * The number range of a Whole number or Decimal number attribute (K19, B section 5).
 * A bound is a whole number or a finite number, the minimum sits at or below the
 * maximum, a Whole number bound stays in the JSON safe range of E10, and an empty
 * field means no bound. A range can hold one bound (owner answer R2).
 */

/** The JSON safe integer limit of decision E10. */
export const JSON_SAFE_INTEGER_LIMIT = 9_007_199_254_740_991;

/** The two info types that carry a range (composition choice 1). */
export function isRangeType(type: UserAttributeFieldType): boolean {
  return type === 'INT64' || type === 'DOUBLE';
}

/** The raw text of one range line. An empty string means no bound. */
export interface RangeDraft {
  min: string;
  max: string;
}

/** One error line for each bound. An empty string means the bound passes. */
export interface RangeErrors {
  min: string;
  max: string;
}

const WHOLE_NUMBER = /^[+-]?\d+$/;
const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

type ParsedBound =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/** Parse one bound. An empty field is no bound, not the number zero. */
export function parseRangeBound(
  type: UserAttributeFieldType,
  raw: string,
): ParsedBound {
  const text = raw.trim();
  if (text === '') return { ok: true, value: null };
  if (type === 'INT64') {
    if (!WHOLE_NUMBER.test(text))
      return { ok: false, error: RANGE_WHOLE_NUMBER_TEXT };
    const value = Number(text);
    if (!Number.isSafeInteger(value))
      return { ok: false, error: RANGE_SAFE_INTEGER_TEXT };
    return { ok: true, value };
  }
  if (!DECIMAL_NUMBER.test(text))
    return { ok: false, error: RANGE_NUMBER_TEXT };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, error: RANGE_NUMBER_TEXT };
  return { ok: true, value };
}

/** The two field errors of one range line. The maximum carries the order rule. */
export function rangeFieldErrors(
  type: UserAttributeFieldType,
  draft: RangeDraft,
): RangeErrors {
  const min = parseRangeBound(type, draft.min);
  const max = parseRangeBound(type, draft.max);
  const errors: RangeErrors = {
    min: min.ok ? '' : min.error,
    max: max.ok ? '' : max.error,
  };
  if (
    !errors.max &&
    min.ok &&
    max.ok &&
    min.value !== null &&
    max.value !== null &&
    min.value > max.value
  )
    errors.max = rangeMinText(min.value);
  return errors;
}

/** Whether two ranges name the same bounds. */
export function sameRange(
  left: UserAttributeRange | null,
  right: UserAttributeRange | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.minValue === right.minValue && left.maxValue === right.maxValue;
}

/**
 * The `numericIndexingSpec` of the plan request. A cleared range sends no bound,
 * which is the object of two null bounds: a null field keeps the cached range (C3),
 * so a clear needs the named range.
 */
export function draftRange(
  type: UserAttributeFieldType,
  draft: RangeDraft,
  cached: UserAttributeRange | null,
): UserAttributeRange | null {
  if (!isRangeType(type)) return null;
  const min = parseRangeBound(type, draft.min);
  const max = parseRangeBound(type, draft.max);
  const minValue = min.ok ? min.value : null;
  const maxValue = max.ok ? max.value : null;
  if (minValue === null && maxValue === null)
    return cached === null ? null : { minValue: null, maxValue: null };
  return { minValue, maxValue };
}

/** Whether one bound differs from its cached value, for the pending surface. */
export function boundChanged(
  type: UserAttributeFieldType,
  raw: string,
  cached: number | null,
): boolean {
  const bound = parseRangeBound(type, raw);
  return bound.ok ? bound.value !== cached : true;
}

/**
 * Whether a range draft differs from the cached range, for the changed check. An
 * invalid bound counts as a change: its text is not the cached value, and the draft
 * must reach its diagnostic (R1). A valid correction that matches the cache compares
 * equal again, so the review returns to the unchanged state.
 */
export function rangeDraftChanged(
  type: UserAttributeFieldType,
  draft: RangeDraft,
  cached: UserAttributeRange | null,
): boolean {
  if (!isRangeType(type)) return false;
  return (
    boundChanged(type, draft.min, cached?.minValue ?? null) ||
    boundChanged(type, draft.max, cached?.maxValue ?? null)
  );
}

/** Whether a range shows at least one bound, for the read-only line. */
export function hasRange(range: UserAttributeRange | null): boolean {
  return range !== null && (range.minValue !== null || range.maxValue !== null);
}
