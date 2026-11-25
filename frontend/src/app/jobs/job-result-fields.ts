import type {
  JobAttributeRow,
  JobAttributeRowView,
  JobCategoryRow,
} from '@campus/application-contracts';
import { attributeWireText } from '../users/user-attribute-value-rules';
import {
  CHANGE_SET_RANGE_LABEL,
  changeChip,
  deletesAttributeValuesText,
  NO_FAILED_CHANGES,
  NO_USER_VALUES_CHANGE,
  propertiesText,
  rangeText,
  typeLabel,
} from '../users/user-category-messages';
import {
  OUTCOME_LABELS,
  outcomeTone,
  type OutcomeTone,
} from './job-detail-fields';

/** The table that a job page shows in place of the device operation table. */
export type JobResultKind = 'device' | 'category' | 'value';

/**
 * The display ID names the job family before the first read (job-identifiers.ts).
 * A CAT job answers the category table, and a UAT job answers the value table.
 */
export function jobResultKind(displayId: string): JobResultKind {
  if (displayId.startsWith('CAT-')) return 'category';
  if (displayId.startsWith('UAT-')) return 'value';
  return 'device';
}

/** Rows per page of the category table. The built page shows six operations a page. */
export const CATEGORY_PAGE_SIZE = 6;
/** The ten rows of the approved value results page (UM state 10). */
export const VALUE_PAGE_SIZE = 10;

/** The All view of the value results (UM state 10). */
export const ALL_ROWS_LABEL = 'All';
/** The Failed view of the value results (UM state 10). */
export const FAILED_ROWS_LABEL = 'Failed';
/** The aria label of the two value result views (CA and UM notes). */
export const RESULTS_VIEW_LABEL = 'Results view';

/** The empty result of a category job. No approved screen draws it. */
export const NO_CATEGORY_CHANGES = 'No changes recorded for this job.';
/** The empty All view of a value job. No approved screen draws it. */
export const NO_VALUE_RESULTS = 'No results recorded for this job.';

/** The reconcile mark of one value row. The job page holds one job at a time. */
export function valueReconcileKey(operation: number): string {
  return `value:${operation}`;
}

/** One rendered row of the state 07 table. */
export interface CategoryResultRow {
  key: string;
  /** The stored row, for a caller that needs the outcome. */
  row: JobCategoryRow;
  label: string;
  tone: OutcomeTone;
  attribute: string;
  effect: string;
  outcome: string;
  outcomeTone: OutcomeTone;
}

/** The attribute cell of a change. A row without an info type names the label alone. */
function attributeText(
  displayName: string,
  fieldType: JobCategoryRow['fieldType'],
): string {
  return fieldType === null
    ? displayName
    : `${displayName} (${typeLabel(fieldType)})`;
}

/**
 * A range change edits the number range alone (composition choice 8). The category
 * dialog classifies the row by its property list, so the job page reads the same
 * list. A mixed edit keeps the change chip and reports every changed property.
 */
function isRangeChange(row: JobCategoryRow): boolean {
  const properties = row.properties ?? [];
  return (
    row.change === 'changed' &&
    properties.length === 1 &&
    properties[0] === 'numericIndexingSpec'
  );
}

/** One row of the category result table (CA state 07). */
export function categoryResultRow(
  row: JobCategoryRow,
  index: number,
): CategoryResultRow {
  const key = `${index}-${row.change}-${row.displayName}`;
  const chip = isRangeChange(row)
    ? { label: CHANGE_SET_RANGE_LABEL, tone: 'info' as const }
    : changeChip(row.change);
  return {
    key,
    row,
    label: chip.label,
    tone: chip.tone,
    attribute:
      row.change === 'rename'
        ? `${row.previousName ?? ''} → ${row.displayName}`
        : isRangeChange(row)
          ? rangeText(row.displayName, row.range)
          : attributeText(row.displayName, row.fieldType),
    effect: categoryEffect(row),
    outcome: OUTCOME_LABELS[row.outcome],
    outcomeTone: outcomeTone(row.outcome),
  };
}

function categoryEffect(row: JobCategoryRow): string {
  if (row.change === 'removed')
    return deletesAttributeValuesText(row.holders ?? 0);
  if (row.change === 'changed') {
    if (isRangeChange(row)) return NO_USER_VALUES_CHANGE;
    const properties = row.properties ?? [];
    return properties.length
      ? propertiesText(properties)
      : NO_USER_VALUES_CHANGE;
  }
  return NO_USER_VALUES_CHANGE;
}

/** One rendered row of the state 10 table. */
export interface ValueResultRow {
  key: string;
  /** The stored row, for the Reconcile action and the user link. */
  row: JobAttributeRow;
  user: string;
  current: string;
  /** The current value is absent, so the cell reads its muted italic form. */
  currentUnset: boolean;
  next: string;
  /** The new value is absent, so the cell reads its muted italic form. */
  nextUnset: boolean;
  label: string;
  tone: OutcomeTone;
  failureText: string | null;
  reconciling: boolean;
}

/** One row of the value result table (UM state 10). */
export function valueResultRow(
  row: JobAttributeRow,
  reconciling: boolean,
): ValueResultRow {
  return {
    key: valueReconcileKey(row.operation),
    row,
    user: row.userName ?? row.primaryEmail,
    current: attributeWireText(row.currentValue),
    currentUnset: row.currentValue === null,
    next: attributeWireText(row.newValue),
    nextUnset: row.newValue === null,
    label: reconciling ? 'Reconciling' : OUTCOME_LABELS[row.outcome],
    tone: reconciling ? 'info' : outcomeTone(row.outcome),
    failureText: row.outcome === 'failed' ? row.failureText : null,
    reconciling,
  };
}

/** The empty line of one value view. */
export function valueEmptyText(view: JobAttributeRowView): string {
  return view === 'failed' ? NO_FAILED_CHANGES : NO_VALUE_RESULTS;
}

const count = (value: number) => value.toLocaleString('en-US');

/** One page of a result table: its position and its shown rows. */
export interface ResultPage {
  pageIndex: number;
  pageSize: number;
  shown: number;
  total: number;
}

const changeNoun = (total: number) => (total === 1 ? 'change' : 'changes');

/**
 * The footer of the category table. The built page names the row range first, so a
 * page beyond a single page keeps its position.
 */
export function categoryRowsFooter(page: ResultPage): string {
  const total = count(page.total);
  if (!page.shown)
    return page.total === 0
      ? `0 ${changeNoun(page.total)}`
      : `0 of ${total} ${changeNoun(page.total)}`;
  const start = page.pageIndex * page.pageSize + 1;
  const end = start + page.shown - 1;
  return `Rows ${count(start)}–${count(end)} of ${total} ${changeNoun(page.total)}`;
}

/** The footer of the value table, in the line of UM state 10: "1–10 of 18 changes". */
export function valueRowsFooter(page: ResultPage): string {
  const total = count(page.total);
  if (!page.shown)
    return page.total === 0
      ? `0 ${changeNoun(page.total)}`
      : `0 of ${total} ${changeNoun(page.total)}`;
  const start = page.pageIndex * page.pageSize + 1;
  const end = start + page.shown - 1;
  return `${count(start)}–${count(end)} of ${total} ${changeNoun(page.total)}`;
}
