import type {
  UserAttributeFieldType,
  UserAttributeRowValue,
} from '@campus/application-contracts';
import {
  ATTRIBUTE_TEXT_LIMIT,
  attributeCountText,
} from './user-attribute-value-rules';

/** The bar of UM state 06 and ruling 14. */
export const ATTRIBUTE_DRAFT_PANEL_LABEL = 'Pending attribute changes';
export const ATTRIBUTE_DRAFT_PENDING_VIEW_LABEL = 'Show pending changes';
export const ATTRIBUTE_DRAFT_ALL_VIEW_LABEL = 'Show all users';
export const ATTRIBUTE_DRAFT_REVERT_ALL_LABEL = 'Revert all changes';
export const ATTRIBUTE_DRAFT_SAVE_LABEL = 'Save changes';
export const ATTRIBUTE_DRAFT_SAVE_NOTE =
  'Save changes prepares a preview of the changed cells.';

/** The pending view (DRAFT-02: the draft keeps rows outside the current filter). */
export const ATTRIBUTE_DRAFT_VIEW_NOTE =
  'Showing only users with pending changes. Show all users returns to your filters.';
export const ATTRIBUTE_DRAFT_PENDING_FAILED_TITLE =
  'The pending users did not load';
export const ATTRIBUTE_DRAFT_PENDING_FAILED_TEXT =
  'Campus Commander could not read the changed users. Show all users returns to your filters.';
export const ATTRIBUTE_DRAFT_PENDING_EMPTY_TITLE =
  'No pending users were found';
export const ATTRIBUTE_DRAFT_PENDING_EMPTY_TEXT =
  'The changed users are no longer in the directory. Show all users returns to your filters.';
export const ATTRIBUTE_DRAFT_RETRY_LABEL = 'Try again';

/** The cell dialog of a date attribute and of a list attribute (B section 12). */
export const ATTRIBUTE_CELL_STAGE_LABEL = 'Stage change';
export const ATTRIBUTE_CELL_CANCEL_LABEL = 'Cancel';
export const ATTRIBUTE_CELL_CLEAR_LABEL = 'Clear values';
export const ATTRIBUTE_CELL_DATE_HINT = 'Choose a date for this attribute.';
export const ATTRIBUTE_CELL_LIST_HINT =
  'Enter each value, then press Enter. Stage change keeps them on this user.';

/** The draft limit and the storage of the tab document. */
export const ATTRIBUTE_DRAFT_USER_LIMIT_TEXT =
  'The draft holds at most 500 users. Revert a change before you edit another user.';
export const ATTRIBUTE_DRAFT_STORAGE_ERROR =
  'This tab cannot restore the grid draft. Check each changed cell before you save.';
export const ATTRIBUTE_DRAFT_WRITE_ERROR =
  'Tab storage is unavailable. Keep this page open until you save the grid draft.';

/** The restore line for entries that failed validation. Zero answers an empty string. */
export function attributeDraftRestoreError(skipped: number): string {
  if (skipped < 1) return '';
  return `${skipped} ${skipped === 1 ? 'change' : 'changes'} did not restore from this tab. Check each changed cell before you save.`;
}

/** One count with its noun, in the ruling 14 form. */
export function attributeDraftCountLine(
  changes: number,
  users: number,
): string {
  return `${changes} pending ${changes === 1 ? 'change' : 'changes'} · ${users} ${users === 1 ? 'user' : 'users'}`;
}

/** The line of an invalid entry: the first one names its user and its rule. */
export function attributeDraftInvalidText(
  count: number,
  userName: string,
  reason: string,
): string {
  return `${count} ${count === 1 ? 'change' : 'changes'} cannot be saved. ${userName} · ${reason}`;
}

/** The line of a conflict entry (B section 8.4). */
export function attributeDraftConflictText(
  count: number,
  label: string,
  userName: string,
): string {
  return `${count} ${count === 1 ? 'conflict' : 'conflicts'}. ${label} of ${userName} changed in Google after your edit. Resolve ${count === 1 ? 'it' : 'them'} to save.`;
}

/** The line of an open editor (DRAFT-02: changed input shows the draft panel). */
export function attributeDraftEditingText(label: string): string {
  return `Editing ${label.toLowerCase()} · Enter or Tab stages this value · Escape cancels`;
}

/** The value of one wire value as an attribute cell shows it. Null answers an empty cell. */
export function attributeDraftValueText(
  value: UserAttributeRowValue | null,
  fieldType: UserAttributeFieldType,
): string {
  if (value === null) return '';
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((entry) =>
      fieldType === 'BOOL' ? (entry ? 'Yes' : 'No') : String(entry),
    )
    .join(', ');
}

/** The state line of one cell, for the renderer and the screen reader. */
export function attributeCellStateText(
  state: 'pending' | 'invalid' | 'conflict',
  label: string,
  options: {
    reason: string;
    baseline: string;
    currentValue: string;
  },
): string {
  if (state === 'invalid')
    return `Invalid change to ${label.toLowerCase()}. ${options.reason}`;
  if (state === 'conflict')
    return `Conflict on ${label.toLowerCase()}. Current value: ${options.currentValue}.`;
  return `Pending change to ${label.toLowerCase()}. Baseline: ${options.baseline}.`;
}

/** The tooltip of a cell whose text is above its limit (UM notes ruling 4). */
export function attributeCellCounter(
  fieldType: UserAttributeFieldType,
  value: string | boolean | null | string[],
): string {
  if (typeof value !== 'string') return '';
  if (fieldType !== 'STRING' && fieldType !== 'EMAIL' && fieldType !== 'PHONE')
    return '';
  const length = [...value].length;
  return length > ATTRIBUTE_TEXT_LIMIT ? attributeCountText(length) : '';
}
