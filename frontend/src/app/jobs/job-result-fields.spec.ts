import type {
  JobAttributeRow,
  JobCategoryRow,
} from '@campus/application-contracts';
import { describe, expect, it } from 'vitest';
import {
  ALL_ROWS_LABEL,
  CATEGORY_PAGE_SIZE,
  FAILED_ROWS_LABEL,
  NO_CATEGORY_CHANGES,
  NO_VALUE_RESULTS,
  VALUE_PAGE_SIZE,
  categoryResultRow,
  categoryRowsFooter,
  jobResultKind,
  valueEmptyText,
  valueReconcileKey,
  valueResultRow,
  valueRowKey,
  valueRowsFooter,
  valueRowsShowAttribute,
} from './job-result-fields';

const categoryRow = (
  overrides: Partial<JobCategoryRow> = {},
): JobCategoryRow => ({
  change: 'rename',
  displayName: 'Grade',
  fieldType: null,
  range: null,
  holders: null,
  previousName: 'Year',
  outcome: 'succeeded',
  ...overrides,
});

const valueRow = (
  overrides: Partial<JobAttributeRow> = {},
): JobAttributeRow => ({
  operation: 7,
  userId: 'synthetic-user-1',
  userName: 'Avery Chen',
  primaryEmail: 'avery@example.org',
  attribute: 'attr:grade.name',
  displayName: 'Grade',
  currentValue: null,
  newValue: 'Seven',
  outcome: 'succeeded',
  failureText: null,
  ...overrides,
});

describe('jobResultKind', () => {
  it('names the table of the display ID before the first read', () => {
    expect(jobResultKind('CAT-014')).toBe('category');
    expect(jobResultKind('UAT-003')).toBe('value');
    expect(jobResultKind('UPD-006')).toBe('device');
    expect(jobResultKind('REF-004')).toBe('device');
    expect(jobResultKind('CMD-002')).toBe('device');
  });
});

describe('categoryResultRow', () => {
  it('renders the rename row of an edit (CA state 07)', () => {
    const row = categoryResultRow(categoryRow(), 0);
    expect(row.label).toBe('Rename category');
    expect(row.tone).toBe('info');
    expect(row.attribute).toBe('Year → Grade');
    expect(row.effect).toBe('No user values change');
    expect(row.outcome).toBe('Succeeded');
    expect(row.outcomeTone).toBe('success');
  });

  it('renders a removal with the holder count and a pending outcome', () => {
    const row = categoryResultRow(
      categoryRow({
        change: 'removed',
        displayName: 'Asset tag',
        fieldType: 'STRING',
        holders: 3,
        previousName: null,
        outcome: 'pending',
      }),
      1,
    );
    expect(row.key).toBe('1-removed-Asset tag');
    expect(row.label).toBe('Remove attribute');
    expect(row.tone).toBe('error');
    expect(row.attribute).toBe('Asset tag (Text)');
    expect(row.effect).toBe('Deletes its values on 3 users');
    expect(row.outcome).toBe('Pending');
    expect(row.outcomeTone).toBe('neutral');
  });

  it('renders an added attribute', () => {
    const row = categoryResultRow(
      categoryRow({
        change: 'added',
        displayName: 'Room',
        fieldType: 'STRING',
        previousName: null,
      }),
      0,
    );
    expect(row.label).toBe('Add attribute');
    expect(row.tone).toBe('success');
    expect(row.attribute).toBe('Room (Text)');
    expect(row.effect).toBe('No user values change');
  });

  it('renders a changed attribute with its edited properties', () => {
    const row = categoryResultRow(
      categoryRow({
        change: 'changed',
        displayName: 'Grade',
        fieldType: 'STRING',
        previousName: null,
        properties: ['displayName', 'indexed'],
        outcome: 'failed',
      }),
      2,
    );
    expect(row.label).toBe('Change attribute');
    expect(row.effect).toBe('Updates display name and searchable');
    expect(row.outcome).toBe('Failed');
    expect(row.outcomeTone).toBe('error');
  });

  it('renders a range change as its own row (composition choice 8)', () => {
    const row = categoryResultRow(
      categoryRow({
        change: 'changed',
        displayName: 'Score',
        fieldType: 'INT64',
        previousName: null,
        properties: ['numericIndexingSpec'],
        range: { minValue: 1, maxValue: 5 },
        outcome: 'unknown',
      }),
      3,
    );
    expect(row.label).toBe('Set range');
    expect(row.attribute).toBe('Score 1 to 5');
    expect(row.effect).toBe('No user values change');
    expect(row.outcome).toBe('Unknown');
    expect(row.outcomeTone).toBe('warning');
  });

  it('keeps every property of a mixed range edit (R1-A)', () => {
    const row = categoryResultRow(
      categoryRow({
        change: 'changed',
        displayName: 'Score',
        fieldType: 'INT64',
        previousName: null,
        properties: ['readAccessType', 'numericIndexingSpec'],
        range: { minValue: 1, maxValue: 5 },
      }),
      4,
    );
    expect(row.label).toBe('Change attribute');
    expect(row.attribute).toBe('Score (Whole number)');
    expect(row.effect).toBe('Updates visibility and number range');
  });

  it('keeps a display name change beside a range change (R1-A)', () => {
    const row = categoryResultRow(
      categoryRow({
        change: 'changed',
        displayName: 'Score',
        fieldType: 'INT64',
        previousName: null,
        properties: ['displayName', 'numericIndexingSpec'],
        range: { minValue: 1, maxValue: 5 },
      }),
      5,
    );
    expect(row.label).toBe('Change attribute');
    expect(row.attribute).toBe('Score (Whole number)');
    expect(row.effect).toBe('Updates display name and number range');
  });

  it('reads a cleared range as a range change with no bound (R1-A)', () => {
    const row = categoryResultRow(
      categoryRow({
        change: 'changed',
        displayName: 'Score',
        fieldType: 'INT64',
        previousName: null,
        properties: ['numericIndexingSpec'],
        range: null,
      }),
      6,
    );
    expect(row.label).toBe('Set range');
    expect(row.attribute).toBe('Score with no range');
    expect(row.effect).toBe('No user values change');
  });
});

describe('valueResultRow', () => {
  it('reads an unset current value as Not set', () => {
    const row = valueResultRow(valueRow(), false);
    expect(row.key).toBe('7:attr:grade.name');
    expect(row.attribute).toBe('Grade');
    expect(row.user).toBe('Avery Chen');
    expect(row.current).toBe('Not set');
    expect(row.currentUnset).toBe(true);
    expect(row.next).toBe('Seven');
    expect(row.nextUnset).toBe(false);
    expect(row.label).toBe('Succeeded');
    expect(row.tone).toBe('success');
    expect(row.failureText).toBeNull();
  });

  it('marks a populated current value and a removal new value', () => {
    const row = valueResultRow(
      valueRow({
        currentValue: 'Six',
        newValue: null,
      }),
      false,
    );
    expect(row.current).toBe('Six');
    expect(row.currentUnset).toBe(false);
    expect(row.next).toBe('Not set');
    expect(row.nextUnset).toBe(true);
  });

  it('reads a Yes or No value and falls back to the email', () => {
    const row = valueResultRow(
      valueRow({
        userName: null,
        currentValue: false,
        newValue: true,
        outcome: 'failed',
        failureText: 'The value must be a whole number.',
      }),
      false,
    );
    expect(row.user).toBe('avery@example.org');
    expect(row.current).toBe('No');
    expect(row.next).toBe('Yes');
    expect(row.failureText).toBe('The value must be a whole number.');
    expect(row.tone).toBe('error');
  });

  it('shows Reconciling over the Unknown chip while the request is held', () => {
    const row = valueResultRow(valueRow({ outcome: 'unknown' }), true);
    expect(row.label).toBe('Reconciling');
    expect(row.tone).toBe('info');
    expect(row.reconciling).toBe(true);
  });
});

describe('value row identity', () => {
  it('keys the two attribute rows of one user by operation and attribute', () => {
    const grade = valueResultRow(valueRow(), false);
    const room = valueResultRow(
      valueRow({ attribute: 'attr:room.name', displayName: 'Room' }),
      false,
    );
    expect(grade.key).toBe('7:attr:grade.name');
    expect(room.key).toBe('7:attr:room.name');
    expect(grade.key).not.toBe(room.key);
    expect(valueRowKey(valueRow())).toBe(valueRowKey(grade.row));
    expect(valueRowKey(room.row)).toBe('7:attr:room.name');
  });

  it('shows the attribute when a result page holds more than one attribute', () => {
    expect(valueRowsShowAttribute([valueRow()])).toBe(false);
    expect(
      valueRowsShowAttribute([
        valueRow(),
        valueRow({ attribute: 'attr:room.name', displayName: 'Room' }),
      ]),
    ).toBe(true);
    expect(() => valueRowsShowAttribute([])).not.toThrow();
    expect(valueRowsShowAttribute([])).toBe(false);
  });
});

describe('result footers', () => {
  it('names the category row range of the shown page', () => {
    expect(
      categoryRowsFooter({
        pageIndex: 0,
        pageSize: CATEGORY_PAGE_SIZE,
        shown: 6,
        total: 9,
      }),
    ).toBe('Rows 1–6 of 9 changes');
    expect(
      categoryRowsFooter({
        pageIndex: 1,
        pageSize: CATEGORY_PAGE_SIZE,
        shown: 3,
        total: 9,
      }),
    ).toBe('Rows 7–9 of 9 changes');
    expect(
      categoryRowsFooter({
        pageIndex: 0,
        pageSize: CATEGORY_PAGE_SIZE,
        shown: 1,
        total: 1,
      }),
    ).toBe('Rows 1–1 of 1 change');
  });

  it('names the value row range of UM state 10', () => {
    expect(
      valueRowsFooter({
        pageIndex: 0,
        pageSize: VALUE_PAGE_SIZE,
        shown: 10,
        total: 18,
      }),
    ).toBe('1–10 of 18 changes');
    expect(
      valueRowsFooter({
        pageIndex: 1,
        pageSize: VALUE_PAGE_SIZE,
        shown: 8,
        total: 18,
      }),
    ).toBe('11–18 of 18 changes');
    expect(
      valueRowsFooter({
        pageIndex: 0,
        pageSize: VALUE_PAGE_SIZE,
        shown: 0,
        total: 18,
      }),
    ).toBe('0 of 18 changes');
  });

  it('names an empty table', () => {
    expect(
      categoryRowsFooter({
        pageIndex: 0,
        pageSize: CATEGORY_PAGE_SIZE,
        shown: 0,
        total: 0,
      }),
    ).toBe('0 changes');
  });
});

describe('result labels', () => {
  it('keeps the approached view labels and empty lines', () => {
    expect(ALL_ROWS_LABEL).toBe('All');
    expect(FAILED_ROWS_LABEL).toBe('Failed');
    expect(NO_CATEGORY_CHANGES).toBe('No changes recorded for this job.');
    expect(NO_VALUE_RESULTS).toBe('No results recorded for this job.');
    expect(valueEmptyText('all')).toBe(NO_VALUE_RESULTS);
    expect(valueEmptyText('failed')).toBe('No failed changes.');
  });

  it('keeps one reconcile key per operation', () => {
    expect(valueReconcileKey(7)).toBe('value:7');
  });
});
