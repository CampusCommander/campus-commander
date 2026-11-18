import type {
  UserAttributeFieldType,
  UserAttributeLimits,
  UserAttributeVisibility,
} from '@campus/application-contracts';

/** The tab label of the Custom attributes view (U2). */
export const CUSTOM_ATTRIBUTES_LABEL = 'Custom attributes';

/** The loading line before the category read answers (UI-08). */
export const CATEGORIES_LOADING_TEXT = 'Loading custom attributes…';

/** The toolbar action that reads the categories from Google now (B section 9). */
export const CATEGORIES_REFRESH_LABEL = 'Refresh';
export const CATEGORIES_REFRESHING_LABEL = 'Refreshing…';

/** The empty state of a domain without a category (CA state 11). */
export const CATEGORIES_EMPTY_TITLE = 'No categories yet';
export const CATEGORIES_EMPTY_BODY =
  'Google Workspace holds no custom attribute categories for this domain.';

/** The failure title of the tab, above the cause that the API names (UI-08). */
export const CATEGORIES_ERROR_TITLE =
  'Custom attribute categories are unavailable';

/** The read-only note beside the disabled Add attribute control (CA composition choice 12). */
export const ADD_ATTRIBUTE_LABEL = 'Add attribute';
export const ADD_ATTRIBUTE_NOTE = 'Requires the User Schema Manage permission.';

/** The category table and the attribute table. */
export const CATEGORIES_TABLE_LABEL = 'Categories';
export const ATTRIBUTES_LABEL = 'Attributes';
export const COLUMN_CATEGORY = 'Category';
export const COLUMN_CATEGORY_NAME = 'Category name';
export const COLUMN_ATTRIBUTES = 'Attributes';
export const COLUMN_USERS_WITH_VALUES = 'Users with values';
export const COLUMN_DISPLAY_NAME = 'Display name';
export const COLUMN_ATTRIBUTE_NAME = 'Attribute name';
export const COLUMN_INFO_TYPE = 'Info type';
export const COLUMN_MULTIPLE_VALUES = 'Multiple values';
export const COLUMN_VISIBILITY = 'Visibility';
export const COLUMN_SEARCHABLE = 'Searchable';
export const FIELD_DISPLAY_NAME = 'Display name';
export const FIELD_CATEGORY_NAME = 'Category name';

/** The Close action of the read-only dialog. */
export const CLOSE_LABEL = 'Close';

/**
 * The contextual help of the page toolbar and of the dialog title row (CA composition
 * choice 15). The claims come from document B section 3 and from CA notes question 6.
 */
export const ATTRIBUTE_HELP_LABEL = 'Custom attributes help';
export const ATTRIBUTE_HELP_TITLE = 'Custom attributes';
export const ATTRIBUTE_HELP_INTRO =
  'Custom attributes are Google Workspace categories that hold values on each user in the domain.';
export const ATTRIBUTE_HELP_RULES: readonly string[] = [
  'Google Workspace allows 100 categories and 100 attributes over all categories.',
  'A category name and an attribute info type cannot change after creation.',
  'A visibility change can take up to 24 hours in Google.',
  'Google warns against government ID numbers, financial data, and health data in a custom attribute.',
];

/** The info type labels of B section 8.1. */
export const ATTRIBUTE_TYPE_LABELS: Readonly<
  Record<UserAttributeFieldType, string>
> = {
  STRING: 'Text',
  INT64: 'Whole number',
  DOUBLE: 'Decimal number',
  BOOL: 'Yes or no',
  DATE: 'Date',
  EMAIL: 'Email',
  PHONE: 'Phone',
};

/** The visibility labels of B section 3. */
export const ATTRIBUTE_VISIBILITY_LABELS: Readonly<
  Record<UserAttributeVisibility, string>
> = {
  ADMINS_AND_SELF: 'Admins and the user',
  ALL_DOMAIN_USERS: 'Everyone in the organization',
};

/** The accessible name of the link that opens one category. */
export function openCategoryLabel(displayName: string): string {
  return `Open category ${displayName}`;
}

/** A count with thousands separators. */
export function countText(value: number): string {
  return value.toLocaleString('en-US');
}

/** The limit line under the page toolbar (composition choice 8). */
export function categoryLimitsText(limits: UserAttributeLimits): string {
  return `${countText(limits.categories)} of ${countText(
    limits.categoryLimit,
  )} categories used · ${countText(limits.attributes)} of ${countText(
    limits.attributeLimit,
  )} attributes used`;
}
