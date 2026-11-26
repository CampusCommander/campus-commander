import {
  GOOGLE_HEALTH_RECOVERY,
  type JobFailure,
  type JobStatus,
  type UserAttributeFieldType,
  type UserAttributeLimits,
  type UserAttributeRange,
  type UserAttributeVisibility,
} from '@campus/application-contracts';
import {
  ATTRIBUTE_TYPE_LABELS,
  ATTRIBUTE_VISIBILITY_LABELS,
  countText,
  rangeNumberText,
} from './user-attribute-messages';

/**
 * The words of the category editor (CA states 02 to 08, 10, and 12). A string that the
 * approved frames draft stays verbatim here. A string that the frames do not draw is
 * marked as a new use in the hand-off.
 */

/** The four steps of the flow, and the delete question that replaces them. */
export const CREATE_CATEGORY_TITLE = 'Create category';
export const EDIT_CATEGORY_TITLE = 'Edit category';
export const DELETE_CATEGORY_TITLE = 'Delete category';

export const CANCEL_LABEL = 'Cancel';
export const REVIEW_CHANGES_LABEL = 'Review changes';
export const BACK_TO_EDITING_LABEL = 'Back to editing';
export const EDIT_AGAIN_LABEL = 'Edit again';
export const DELETING_LABEL = 'Deleting…';
export const SAVING_LABEL = 'Saving…';
export const DELETE_CATEGORY_LABEL = 'Delete category';

/** The locks of B section 5 and composition choice 2. */
export const CATEGORY_NAME_HINT = 'Locks after the first save';
export const NAME_LOCK_REASON = 'Fixed at creation';
export const MULTI_LOCK_REASON = 'Cannot return to one value';

/** The field errors of CA state 03 and of C2 (design section 3). */
export const CATEGORY_NAME_IN_USE = 'A category with this name exists.';
export const ATTRIBUTE_NAME_RULE = 'Use letters, digits, _ and - only.';
export const ATTRIBUTE_NAME_IN_USE = 'Each attribute needs a unique name.';
export const ATTRIBUTE_DISPLAY_NAME_IN_USE =
  'Each attribute needs a unique display name.';
export const DISPLAY_NAME_REQUIRED = 'Enter a display name.';

/** E18: the last attribute stays, and the category is the thing to delete. */
export const LAST_ATTRIBUTE_TEXT =
  'A category needs one attribute. Delete the category instead.';

/** The one-way notes of states 04, 05, and 08. */
export function removesValuesText(holders: number): string {
  return `Removes values from ${countText(holders)} users`;
}

export function removingValuesText(
  displayName: string,
  holders: number,
): string {
  return `Removing ${displayName} deletes its values on ${countText(
    holders,
  )} users. Nothing restores them.`;
}

export function deletesValuesText(
  displayName: string,
  holders: number,
): string {
  return `Deletes ${displayName} values on ${countText(holders)} users.`;
}

export function deletesAttributeValuesText(holders: number): string {
  return `Deletes its values on ${countText(holders)} users`;
}

/** The limit counts of composition choices 8 and 10. */
export function usedAfterText(used: number, limit: number): string {
  return `${countText(used)} of ${countText(
    limit,
  )} attributes used after this change`;
}

export function limitReachedText(limit: number): string {
  return `${countText(limit)} of ${countText(
    limit,
  )} attributes used. Remove an attribute before you add one.`;
}

/** The action-bar state of CA state 03. */
export function errorCountText(errors: number): string {
  return `${countText(errors)} ${errors === 1 ? 'field has' : 'fields have'} errors`;
}

/** The review step of CA state 05. */
export function changesToText(
  changes: number,
  categoryDisplayName: string,
): string {
  return `${countText(changes)} ${
    changes === 1 ? 'change' : 'changes'
  } to ${categoryDisplayName}`;
}

export const DOMAIN_CHANGES_TEXT =
  'The changes apply to every user in the domain.';
export const DOMAIN_CHANGE_TEXT =
  'The change applies to every user in the domain.';

export const COLUMN_CHANGE = 'Change';
export const COLUMN_ATTRIBUTE = 'Attribute';
export const COLUMN_EFFECT = 'Effect';
export const COLUMN_OUTCOME = 'Outcome';
export const CHANGES_TABLE_LABEL = 'Changes';
export const RESULTS_VIEW_LABEL = 'Results view';
export const ALL_CHANGES_LABEL = 'All changes';
export const FAILED_LABEL = 'Failed';
export const NO_FAILED_CHANGES = 'No failed changes.';
export const NO_USER_VALUES_CHANGE = 'No user values change';
export const RESULT_COUNTS_LABEL = 'Result counts';
export const SUCCEEDED_COUNT_LABEL = 'Succeeded';
export const FAILED_COUNT_LABEL = 'Failed';
export const UNKNOWN_COUNT_LABEL = 'Unknown';
export const NOT_RUN_COUNT_LABEL = 'Not run';

/** The noun under the change count of CA state 07: one change is a Change. */
export function changeCountLabel(count: number): string {
  return count === 1 ? 'Change' : 'Changes';
}

/** The change chips of the review table and the result table. */
export const CHANGE_ADD_LABEL = 'Add attribute';
export const CHANGE_REMOVE_LABEL = 'Remove attribute';
export const CHANGE_CHANGE_LABEL = 'Change attribute';
export const CHANGE_RENAME_LABEL = 'Rename category';

/** The tone of one change chip (CA states 05 and 07). */
export type ChangeChipTone = 'info' | 'success' | 'error';

/**
 * The chip of one change kind. The dialog and the job page share it, so a chip reads
 * the same in both. A range change names its own chip (composition choice 8).
 */
export function changeChip(kind: 'rename' | 'added' | 'removed' | 'changed'): {
  label: string;
  tone: ChangeChipTone;
} {
  switch (kind) {
    case 'added':
      return { label: CHANGE_ADD_LABEL, tone: 'success' };
    case 'removed':
      return { label: CHANGE_REMOVE_LABEL, tone: 'error' };
    case 'rename':
      return { label: CHANGE_RENAME_LABEL, tone: 'info' };
    case 'changed':
      return { label: CHANGE_CHANGE_LABEL, tone: 'info' };
  }
}

/** The phrasing of the effect column for a changed attribute. */
const PROPERTY_LABELS = {
  displayName: 'display name',
  multiValued: 'multiple values',
  indexed: 'searchable',
  readAccessType: 'visibility',
  numericIndexingSpec: 'number range',
} as const;

export function propertiesText(
  properties: readonly (keyof typeof PROPERTY_LABELS)[],
): string {
  const labels = properties.map((property) => PROPERTY_LABELS[property]);
  const list =
    labels.length < 2
      ? labels.join('')
      : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
  return `Updates ${list}`;
}

/**
 * The number range of K19: the line under a Whole number or Decimal number row.
 * A bound that is not a whole number uses the error pattern of CA state 03.
 */
export const RANGE_WHOLE_NUMBER_TEXT = 'Enter a whole number.';
/** A Decimal number bound that is not a finite number. */
export const RANGE_NUMBER_TEXT = 'Enter a number.';
/** A Whole number bound outside the JSON safe range of decision E10. */
export const RANGE_SAFE_INTEGER_TEXT =
  'Enter a whole number between -9,007,199,254,740,991 and 9,007,199,254,740,991.';
/** The review row of a range change (composition choice 8). */
export const CHANGE_SET_RANGE_LABEL = 'Set range';

/** The maximum error of state 14: it names the minimum. */
export function rangeMinText(minimum: number): string {
  return `Enter ${rangeNumberText(minimum)} or more.`;
}

/** The attribute cell of the range review row. A cleared range names no bound. */
export function rangeText(
  displayName: string,
  range: UserAttributeRange | null,
): string {
  if (range === null) return `${displayName} with no range`;
  const { minValue, maxValue } = range;
  if (minValue === null && maxValue === null)
    return `${displayName} with no range`;
  if (minValue === null && maxValue !== null)
    return `${displayName} ${rangeNumberText(maxValue)} or less`;
  if (minValue !== null && maxValue === null)
    return `${displayName} ${rangeNumberText(minValue)} or more`;
  if (minValue !== null && maxValue !== null)
    return `${displayName} ${rangeNumberText(
      minValue,
    )} to ${rangeNumberText(maxValue)}`;
  return `${displayName} with no range`;
}

/** The typed phrase gate of CA states 05 and 08 (default 1). */
export function confirmPhraseLabel(phrase: string): string {
  return `Type ${phrase} to confirm`;
}

export const PHRASE_MISMATCH_TEXT = 'The phrase does not match.';

/** The error of the built phrase gate, with this dialog's phrase. */
export function phraseMismatchText(phrase: string): string {
  return `${PHRASE_MISMATCH_TEXT} Type ${phrase}.`;
}

export function saveChangesLabel(changes: number): string {
  return `Save ${countText(changes)} ${changes === 1 ? 'change' : 'changes'}`;
}

/** The saving step of CA state 06. */
export const SAVE_IN_GOOGLE_LABEL = 'Save changes in Google';
export const UPDATE_CACHED_USERS_LABEL = 'Update cached users';
export const CLOSING_KEEPS_RUNNING_TEXT =
  'Closing this dialog keeps the save running.';
export const PROGRESS_LABEL = 'Progress';

/** The result step of CA state 07. */
export const JOB_LABEL = 'Job';
export const JOB_RUNNING_LABEL = 'Running';
export const FINISHED_LABEL = 'Finished';
export const VISIBILITY_DELAY_TEXT =
  'Google can take up to 24 hours to apply a visibility change.';

const JOB_STATUS_LABELS: Readonly<Record<JobStatus, string>> = {
  accepted: 'Accepted',
  queued: 'Queued',
  held: 'Held',
  running: 'Running',
  'awaiting-devices': 'Awaiting devices',
  completed: 'Completed',
  'completed-with-errors': 'Completed with errors',
  failed: 'Failed',
  'needs-review': 'Needs review',
  cancelled: 'Cancelled',
};

export function jobStatusLabel(status: JobStatus): string {
  return JOB_STATUS_LABELS[status];
}

/** The time of the finished state line, in the form of CA state 07. */
export function finishedText(iso: string): string {
  const value = new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${FINISHED_LABEL} ${value}`;
}

export const JOB_UNREADABLE_TEXT =
  'The save continues. This dialog cannot read the result. Close the dialog and open the job.';
export const SAVE_NOT_STARTED_TEXT = 'The save did not start. Try again.';
/** A lost or unreadable confirm answer does not prove that no save started. */
export const SAVE_UNCERTAIN_TEXT =
  'Campus Commander did not answer the confirmation, or the answer was not readable. The save may have started.';
export const PLAN_NOT_PREPARED_TEXT =
  'The change could not be prepared. Try again.';
export const CONNECTION_REQUIRED_TEXT =
  'Custom attribute categories need a Google Workspace connection.';
export const CATEGORY_CHANGED_TEXT =
  'Another change reached this category. Open it again.';
export const PLAN_EXPIRED_TEXT = 'The plan expired. Review the change again.';
export const PLAN_CHANGED_TEXT =
  'The change plan changed. Review the change again.';
export const UNKNOWN_OUTCOME_TEXT =
  'The outcome is unknown. Check the category before you try again.';
export const NOT_FOUND_TEXT =
  'Google does not hold this category. Open the category list again.';
export const SESSION_ENDED_TEXT = 'Your session ended. Sign in again.';

const CATEGORY_FAILURE_TEXT: Partial<Readonly<Record<JobFailure, string>>> = {
  'name-in-use':
    'Google already holds a category with this name. Edit the name and review the change again.',
  'category-changed': CATEGORY_CHANGED_TEXT,
  'not-found': NOT_FOUND_TEXT,
  interrupted: 'The save stopped before it finished. Check the category.',
  'permission-changed':
    'Your permission to manage categories changed. Ask your administrator for access.',
  'connection-changed':
    'The Google connection changed. Open the category again.',
  'storage-unavailable':
    'The stored result is unavailable. Open the job to inspect it.',
  'orchestration-unavailable':
    'The save could not reach its worker. Open the job to inspect it.',
  'inventory-unavailable':
    'The category list was unavailable. Open the category again.',
};

/** The cause of a failed or unknown category job, in one paragraph. */
export function categoryFailureText(
  failure: JobFailure | null,
  status: JobStatus,
): string {
  if (status === 'needs-review' && !failure) return UNKNOWN_OUTCOME_TEXT;
  if (!failure) return 'The save failed. Open the job to inspect the result.';
  const specific = CATEGORY_FAILURE_TEXT[failure];
  if (specific) return specific;
  const health = (
    GOOGLE_HEALTH_RECOVERY as Partial<
      Readonly<Record<JobFailure, { label: string; recovery: string }>>
    >
  )[failure];
  if (health) return `${health.label}. ${health.recovery}`;
  return 'The save failed. Open the job to inspect the result.';
}

/** The outcome of one change in the result table. */
export function outcomeLabel(
  outcome: 'succeeded' | 'failed' | 'unknown' | 'cancelled',
): string {
  if (outcome === 'succeeded') return SUCCEEDED_COUNT_LABEL;
  if (outcome === 'failed') return FAILED_COUNT_LABEL;
  if (outcome === 'unknown') return UNKNOWN_COUNT_LABEL;
  return NOT_RUN_COUNT_LABEL;
}

export function typeLabel(type: UserAttributeFieldType): string {
  return ATTRIBUTE_TYPE_LABELS[type];
}

export function visibilityLabel(visibility: UserAttributeVisibility): string {
  return ATTRIBUTE_VISIBILITY_LABELS[visibility];
}

export const FIELD_TYPE_OPTIONS: readonly {
  value: UserAttributeFieldType;
  label: string;
}[] = (
  ['STRING', 'INT64', 'DOUBLE', 'BOOL', 'DATE', 'EMAIL', 'PHONE'] as const
).map((value) => ({ value, label: ATTRIBUTE_TYPE_LABELS[value] }));

export const VISIBILITY_OPTIONS: readonly {
  value: UserAttributeVisibility;
  label: string;
}[] = (['ADMINS_AND_SELF', 'ALL_DOMAIN_USERS'] as const).map((value) => ({
  value,
  label: ATTRIBUTE_VISIBILITY_LABELS[value],
}));

/** The limits of one save: the category list count and the fields after the draft. */
export function draftLimitsText(limits: UserAttributeLimits): string {
  return `${countText(limits.categories)} of ${countText(
    limits.categoryLimit,
  )} categories used · ${countText(limits.attributes)} of ${countText(
    limits.attributeLimit,
  )} attributes used`;
}

/**
 * The attribute name of E1: split at each character outside A-Z, a-z, and 0-9,
 * upper-case the first letter of each part, and join. "Take-home approved" gives
 * "TakeHomeApproved". A name longer than the contract maximum is cut.
 */
export function deriveAttributeName(displayName: string): string {
  return displayName
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
    .slice(0, 200);
}

/** A trimmed string, folded for the case-insensitive comparisons of C2 and E1. */
export function folded(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}
