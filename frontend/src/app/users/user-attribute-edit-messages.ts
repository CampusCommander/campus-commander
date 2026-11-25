/** The card form of K25 (UM notes compositions 4 and 13). */
export const ATTRIBUTE_EDIT_LABEL = 'Edit';
export const ATTRIBUTE_SAVE_LABEL = 'Save changes';
export const ATTRIBUTE_CANCEL_LABEL = 'Cancel';
export const ATTRIBUTE_CONFIRM_LABEL = 'Confirm';
export const ATTRIBUTE_BACK_TO_FORM_LABEL = 'Back';
export const ATTRIBUTE_RETRY_ROWS_LABEL = 'Retry';
export const ATTRIBUTE_BOOL_LABELS = {
  yes: 'Yes',
  no: 'No',
  unset: 'Not set',
} as const;

/** The review of the preview rows (B section 4.2). */
export const ATTRIBUTE_REVIEW_TITLE = 'Review';
export const ATTRIBUTE_COLUMN_ATTRIBUTE = 'Attribute';
export const ATTRIBUTE_COLUMN_CURRENT = 'Current value';
export const ATTRIBUTE_COLUMN_NEW = 'New value';
export const ATTRIBUTE_COLUMN_STATUS = 'Status';
export const ATTRIBUTE_STATUS_READY = 'Proposed';
export const ATTRIBUTE_STATUS_NO_CHANGE = 'No change needed';
export const ATTRIBUTE_STATUS_CONFLICT = 'Conflict';
export const ATTRIBUTE_NO_CHANGE_TEXT =
  'No change needed. The card already holds these values.';
export const ATTRIBUTE_CONFLICT_TITLE = 'A value changed in Google';

/** The state lines of the flow. */
export const ATTRIBUTE_PREPARING_TEXT = 'Preparing the preview…';
export const ATTRIBUTE_CREATING_JOB_TEXT = 'Creating the job…';
export const ATTRIBUTE_SAVING_TEXT = 'Saving to Google…';

/** The refusal of a preview (B section 13). The 413 words are the card's exact words. */
export const ATTRIBUTE_SIZE_LIMIT_TEXT = 'The request exceeds the size limit.';
export const ATTRIBUTE_CATEGORY_CHANGED_TEXT =
  'Another change reached this category. Review the values and save again.';
export const ATTRIBUTE_PREVIEW_CONFLICT_TEXT =
  'A value changed in Google after you opened the form. Review the values and save again.';
export const ATTRIBUTE_PREVIEW_EXPIRED_TEXT =
  'The preview expired. Save the changes again.';
export const ATTRIBUTE_PREVIEW_CHANGED_TEXT =
  'The preview changed. Save the changes again.';
export const ATTRIBUTE_CONNECTION_TEXT =
  'Google Workspace is not connected. Open the Google connection and save again.';
export const ATTRIBUTE_FORBIDDEN_TEXT =
  'You do not have permission to set user attribute values.';
export const ATTRIBUTE_REFUSED_TEXT =
  'Campus Commander refused the save. Your changes are still here.';
export const ATTRIBUTE_READ_FAILED_TEXT =
  'Campus Commander could not read this user from Google. Your changes are still here.';
export const ATTRIBUTE_PREVIEW_UNAVAILABLE_TEXT =
  'Campus Commander could not read the preview. Retry the save.';
export const ATTRIBUTE_OFFLINE_TEXT =
  'Cannot reach Campus Commander. Your changes are still here.';
export const ATTRIBUTE_PERMISSION_CHANGED_TEXT =
  'Your access changed. Your changes are still here.';

/** The line after a value job settles (composition 13). */
export const ATTRIBUTE_SAVED_SUFFIX = ' saved to Google';
export const ATTRIBUTE_JOB_SEPARATOR = ' · Job ';
export function attributeSavedText(attributes: readonly string[]): string {
  if (attributes.length === 1)
    return `${attributes[0]}${ATTRIBUTE_SAVED_SUFFIX}`;
  return `${attributes.length} attributes${ATTRIBUTE_SAVED_SUFFIX}`;
}
export const ATTRIBUTE_PARTIAL_TEXT = 'Some values did not save.';
export const ATTRIBUTE_FAILED_TEXT = 'The values did not save.';
export const ATTRIBUTE_UNSETTLED_TEXT = 'The job is still running.';
/** A job that holds Unknown operations needs review (B section 7.3). */
export const ATTRIBUTE_REVIEW_TEXT = 'The job needs review.';
/** The retry of a confirmation whose answer never arrived (R1-D). */
export const ATTRIBUTE_CONFIRM_UNCERTAIN_HINT =
  'Retry the confirmation to keep the same preview.';

/** "Grade level and Homeroom", "Grade level, Homeroom, and Building". */
export function attributeListText(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

/** The conflict note above the review table, with each attribute named. */
export function attributeConflictText(labels: readonly string[]): string {
  return `${attributeListText(labels)} changed in Google after you opened the form. Edit the values and save again.`;
}
