import {
  JSON_SAFE_INTEGER_LIMIT,
  boundChanged,
  draftRange,
  hasRange,
  isRangeType,
  parseRangeBound,
  rangeFieldErrors,
  sameRange,
} from './user-category-range';
import { rangeText } from './user-category-messages';

/**
 * The number range rules of K19 (B section 5): a whole number or a finite number,
 * the minimum at or below the maximum, the JSON safe range of E10, an empty field
 * as no bound, and one bound allowed (owner answer R2).
 */
describe('the number range rules (K19)', () => {
  it('carries a range only on the two number info types', () => {
    expect(isRangeType('INT64')).toBe(true);
    expect(isRangeType('DOUBLE')).toBe(true);
    for (const type of ['STRING', 'BOOL', 'DATE', 'EMAIL', 'PHONE'] as const)
      expect(isRangeType(type)).toBe(false);
  });

  it('parses a whole number and treats an empty field as no bound', () => {
    expect(parseRangeBound('INT64', '')).toEqual({ ok: true, value: null });
    expect(parseRangeBound('INT64', '  ')).toEqual({ ok: true, value: null });
    expect(parseRangeBound('INT64', '0')).toEqual({ ok: true, value: 0 });
    expect(parseRangeBound('INT64', '-12')).toEqual({ ok: true, value: -12 });
    expect(parseRangeBound('INT64', '12.5')).toEqual({
      ok: false,
      error: 'Enter a whole number.',
    });
    expect(parseRangeBound('INT64', 'one')).toEqual({
      ok: false,
      error: 'Enter a whole number.',
    });
  });

  it('keeps a whole number bound in the JSON safe range of E10', () => {
    expect(parseRangeBound('INT64', String(JSON_SAFE_INTEGER_LIMIT))).toEqual({
      ok: true,
      value: JSON_SAFE_INTEGER_LIMIT,
    });
    const outside = parseRangeBound(
      'INT64',
      String(JSON_SAFE_INTEGER_LIMIT + 1),
    );
    expect(outside.ok).toBe(false);
    expect(outside).toMatchObject({
      error:
        'Enter a whole number between -9,007,199,254,740,991 and 9,007,199,254,740,991.',
    });
  });

  it('parses a finite decimal bound', () => {
    expect(parseRangeBound('DOUBLE', '2026.5')).toEqual({
      ok: true,
      value: 2026.5,
    });
    expect(parseRangeBound('DOUBLE', '-0.25')).toEqual({
      ok: true,
      value: -0.25,
    });
    expect(parseRangeBound('DOUBLE', '1,5')).toEqual({
      ok: false,
      error: 'Enter a number.',
    });
    expect(parseRangeBound('DOUBLE', '1e999')).toEqual({
      ok: false,
      error: 'Enter a number.',
    });
  });

  it('names the minimum when the maximum sits below it (state 14)', () => {
    expect(rangeFieldErrors('INT64', { min: '12', max: '0' }).max).toBe(
      'Enter 12 or more.',
    );
    // An equal pair passes, as the contract filter rule does.
    expect(rangeFieldErrors('INT64', { min: '12', max: '12' })).toEqual({
      min: '',
      max: '',
    });
  });

  it('marks only the field that breaks its own rule (state 14)', () => {
    expect(rangeFieldErrors('INT64', { min: '2026.5', max: '' })).toEqual({
      min: 'Enter a whole number.',
      max: '',
    });
    expect(rangeFieldErrors('DOUBLE', { min: '', max: 'half' })).toEqual({
      min: '',
      max: 'Enter a number.',
    });
  });

  it('allows one bound and no bound (R2)', () => {
    expect(rangeFieldErrors('INT64', { min: '0', max: '' })).toEqual({
      min: '',
      max: '',
    });
    expect(rangeFieldErrors('INT64', { min: '', max: '12' })).toEqual({
      min: '',
      max: '',
    });
    expect(rangeFieldErrors('INT64', { min: '', max: '' })).toEqual({
      min: '',
      max: '',
    });
  });

  it('sends two bounds, one bound, or no bound in the plan request', () => {
    expect(draftRange('INT64', { min: '0', max: '12' }, null)).toEqual({
      minValue: 0,
      maxValue: 12,
    });
    expect(draftRange('INT64', { min: '12', max: '' }, null)).toEqual({
      minValue: 12,
      maxValue: null,
    });
    expect(draftRange('INT64', { min: '', max: '' }, null)).toBeNull();
    expect(draftRange('DOUBLE', { min: '', max: '2.5' }, null)).toEqual({
      minValue: null,
      maxValue: 2.5,
    });
    // A non-number attribute carries no range in the request.
    expect(draftRange('STRING', { min: '0', max: '12' }, null)).toBeNull();
  });

  it('clears a cached range with an empty range, not a null field (C3)', () => {
    expect(
      draftRange('INT64', { min: '', max: '' }, { minValue: 0, maxValue: 12 }),
    ).toEqual({ minValue: null, maxValue: null });
    expect(
      draftRange(
        'INT64',
        { min: '0', max: '12' },
        { minValue: 0, maxValue: 12 },
      ),
    ).toEqual({ minValue: 0, maxValue: 12 });
  });

  it('shows a changed bound and hides an unchanged one', () => {
    expect(boundChanged('INT64', '0', null)).toBe(true);
    expect(boundChanged('INT64', '', null)).toBe(false);
    expect(boundChanged('INT64', '0', 0)).toBe(false);
    expect(boundChanged('INT64', '', 0)).toBe(true);
    expect(boundChanged('INT64', 'half', null)).toBe(true);
  });

  it('compares ranges by their two bounds', () => {
    expect(
      sameRange({ minValue: 0, maxValue: 12 }, { minValue: 0, maxValue: 12 }),
    ).toBe(true);
    expect(
      sameRange({ minValue: 0, maxValue: null }, { minValue: 0, maxValue: 12 }),
    ).toBe(false);
    expect(sameRange(null, null)).toBe(true);
    expect(sameRange(null, { minValue: null, maxValue: null })).toBe(false);
  });

  it('draws the read-only line only for a range with one bound', () => {
    expect(hasRange({ minValue: 0, maxValue: 12 })).toBe(true);
    expect(hasRange({ minValue: 12, maxValue: null })).toBe(true);
    expect(hasRange({ minValue: null, maxValue: 12 })).toBe(true);
    expect(hasRange({ minValue: null, maxValue: null })).toBe(false);
    expect(hasRange(null)).toBe(false);
  });

  it('names the range in the review row (composition choice 8)', () => {
    expect(rangeText('Grade level', { minValue: 0, maxValue: 12 })).toBe(
      'Grade level 0 to 12',
    );
    expect(rangeText('Grade level', { minValue: 12, maxValue: null })).toBe(
      'Grade level 12 or more',
    );
    expect(rangeText('Grade level', { minValue: null, maxValue: 12 })).toBe(
      'Grade level 12 or less',
    );
    expect(rangeText('Grade level', { minValue: null, maxValue: null })).toBe(
      'Grade level with no range',
    );
    expect(rangeText('Grade level', null)).toBe('Grade level with no range');
  });
});
