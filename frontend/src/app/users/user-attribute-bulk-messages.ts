import {
  ENTITY_FRESHNESS_HOURS,
  type UserAttributeChangeMode,
  type UserAttributeField,
} from '@campus/application-contracts';
import { ATTRIBUTE_TYPE_LABELS } from './user-attribute-messages';

/** The Bulk Actions entry of the Users toolbar (UM notes ruling 9, state 07). */
export const BULK_ACTIONS_LABEL = 'Bulk Actions';
export const BULK_SET_ATTRIBUTES_LABEL = 'Set attributes';
export const BULK_SELECT_NOTE = 'Select one or more users to set attributes.';

/** The setup step (states 08 and 11). */
export const BULK_CATEGORY_LABEL = 'Category';
export const BULK_ATTRIBUTE_LABEL = 'Attribute';
export const BULK_MODE_LABEL = 'Mode';
export const BULK_VALUE_LABEL = 'Value';
export const BULK_VALUES_LABEL = 'Values';
export const BULK_MULTI_HINT = 'Multiple values';
export const BULK_SINGLE_HINT = 'Single value';
export const BULK_REVIEW_LABEL = 'Review';
export const BULK_CANCEL_LABEL = 'Cancel';
export const BULK_VALUE_REQUIRED_TEXT = 'Enter a value.';
export const BULK_VALUES_REQUIRED_TEXT = 'Enter at least one value.';
export const BULK_NO_CATEGORIES_TEXT =
  'This account holds no custom attribute categories.';
export const BULK_NO_FIELDS_TEXT = 'This category holds no attributes.';
export const BULK_CATEGORIES_LOADING_TEXT = 'Loading custom attributes…';

/** The review step (state 09). */
export const BULK_BACK_LABEL = 'Back';
export const BULK_USER_COLUMN = 'User';
export const BULK_EMAIL_COLUMN = 'Primary email';
export const BULK_USERS_TERM = 'Users';
export const BULK_CHANGES_TERM = 'changes';
export const BULK_SUCCEEDED_TERM = 'Succeeded';
export const BULK_FAILED_TERM = 'Failed';
export const BULK_NO_REVIEW_ROWS = 'No rows in this view.';
export const BULK_CONFLICT_TEXT =
  'A value changed in Google. Confirm is off. Go back and review the value.';
export const BULK_STALE_TEXT = `Some observed values are more than ${ENTITY_FRESHNESS_HOURS.user} hours old. Review them before you continue.`;

/** The results step (state 10). */
export const BULK_DONE_LABEL = 'Done';
export const BULK_EXECUTED_BY = 'Executed by';
export const BULK_FINISHED = 'Finished';
export const BULK_JOB_PREFIX = 'Job ';
export const BULK_NO_RESULTS = 'No changes in this view.';
export const BULK_OUTCOME_COLUMN = 'Outcome';
export const BULK_LOADING_RESULTS_TEXT = 'Loading results…';
export const BULK_ROWS_UNAVAILABLE_TEXT =
  'Campus Commander could not read the results. Retry.';
export const BULK_JOB_UNREADABLE_TEXT =
  'Campus Commander could not read the job. The job continues. Open the job to follow it.';

/** The mode label of one attribute kind (states 08 and 11). */
export function bulkModeLabel(
  mode: UserAttributeChangeMode,
  multiValued: boolean,
): string {
  if (mode === 'set') return 'Set value';
  if (mode === 'clear') return multiValued ? 'Clear values' : 'Clear value';
  if (mode === 'add') return 'Add values';
  if (mode === 'remove') return 'Remove values';
  return 'Replace all values';
}

/** The hint under Attribute: the info type and the number of values (composition 5). */
export function bulkInfoHint(field: UserAttributeField): string {
  return `${ATTRIBUTE_TYPE_LABELS[field.fieldType]} · ${
    field.multiValued ? BULK_MULTI_HINT : BULK_SINGLE_HINT
  }`;
}

/** "25 selected users", or "1 selected user". */
export function bulkSelectedUsersText(count: number): string {
  return `${count} selected ${count === 1 ? 'user' : 'users'}`;
}

/** The confirm button of the review: "Set attributes on 18 users". */
export function bulkConfirmLabel(count: number): string {
  return `${BULK_SET_ATTRIBUTES_LABEL} on ${count} ${
    count === 1 ? 'user' : 'users'
  }`;
}

/** One page line: "1–10 of 18 proposed changes" (an en dash, as the mockup draws it). */
export function bulkPagerText(
  start: number,
  count: number,
  total: number,
  noun: string,
): string {
  if (count === 0) return `0 of ${total} ${noun}`;
  return `${start}–${start + count - 1} of ${total} ${noun}`;
}
