import {
  GOOGLE_CAPABILITIES,
  userAttributeKey,
  type DeviceSyncFailure,
  type UserAttributeCategory,
  type UserAttributeField,
  type UserPredicate,
  type UserRow,
  type UserSortField,
} from '@campus/application-contracts';

export type UserFieldKind =
  | 'text'
  | 'orgUnit'
  | 'status'
  | 'boolean'
  | 'dateTime';

/** The ID of a static grid column. 2-step verification has no server sort field. */
export type UserColumnId = UserSortField | 'twoStep';

export interface UserField {
  id: string;
  label: string;
  kind: UserFieldKind;
  /** Optional columns start hidden in the grid. */
  optional: boolean;
}

/** The static grid columns of A section 9, in the order of the approved screen. */
export const USER_FIELDS: readonly UserField[] = [
  { id: 'fullName', label: 'Name', kind: 'text', optional: false },
  { id: 'primaryEmail', label: 'Primary email', kind: 'text', optional: false },
  {
    id: 'orgUnitPath',
    label: 'Organization unit',
    kind: 'orgUnit',
    optional: false,
  },
  { id: 'status', label: 'Status', kind: 'status', optional: false },
  {
    id: 'lastLoginTime',
    label: 'Last sign-in',
    kind: 'dateTime',
    optional: false,
  },
  {
    id: 'twoStep',
    label: '2-step verification',
    kind: 'boolean',
    optional: false,
  },
  { id: 'creationTime', label: 'Created', kind: 'dateTime', optional: true },
  { id: 'department', label: 'Department', kind: 'text', optional: true },
  { id: 'title', label: 'Title', kind: 'text', optional: true },
];

export type UserStatusValue = 'active' | 'suspended' | 'archived';

export const STATUS_LABELS: Readonly<Record<UserStatusValue, string>> = {
  active: 'Active',
  suspended: 'Suspended',
  archived: 'Archived',
};

export const TWO_STEP_LABELS: Readonly<
  Record<'enrolled' | 'not-enrolled', string>
> = {
  enrolled: 'Enrolled',
  'not-enrolled': 'Not enrolled',
};
export type UserTwoStepValue = keyof typeof TWO_STEP_LABELS;

export const TEXT_OPERATORS = [
  { id: 'contains', label: 'Contains' },
  { id: 'startsWith', label: 'Starts with' },
  { id: 'equals', label: 'Is' },
  { id: 'isEmpty', label: 'Is empty' },
] as const;
export const DATE_OPERATORS = [
  { id: 'before', label: 'Before' },
  { id: 'after', label: 'On or after' },
] as const;

/** Status precedence: Archived over Suspended over Active (A section 15.4). */
export function statusValue(row: UserRow): UserStatusValue {
  if (row.archived) return 'archived';
  if (row.suspended) return 'suspended';
  return 'active';
}

export function twoStepValue(row: UserRow): UserTwoStepValue {
  return row.twoStepEnrolled ? 'enrolled' : 'not-enrolled';
}

/** Alias filters but shows no column (A section 15.4). */
export const FILTER_ONLY_FIELDS: readonly UserField[] = [
  { id: 'aliases', label: 'Alias', kind: 'text', optional: true },
];

export function fieldFor(id: string): UserField {
  const field = [...USER_FIELDS, ...FILTER_ONLY_FIELDS].find(
    (candidate) => candidate.id === id,
  );
  if (!field) throw new Error(`Unknown user field ${id}`);
  return field;
}

/**
 * One attribute column. The ID is the C1 key of the K5 builder, so the column, the
 * chip, and the filter share one ID (design section 1).
 */
export interface UserAttributeColumn {
  id: string;
  schemaName: string;
  fieldName: string;
  schemaDisplayName: string;
  field: UserAttributeField;
  label: string;
}

/** An attribute value as Google stores it: a scalar, or a list of `{ value }` entries. */
function attributeValues(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value)
    ? value.map((item) =>
        item !== null && typeof item === 'object' && 'value' in item
          ? (item as { value: unknown }).value
          : item,
      )
    : [value];
}

/** The cell text of one attribute value: values in order, separated by commas. */
export function attributeText(
  row: UserRow,
  attribute: UserAttributeColumn,
): string {
  const schemas = row.customSchemas;
  // Only own properties are attribute values. A category or field named after an
  // Object prototype member holds no value (R12).
  const category = Object.hasOwn(schemas, attribute.schemaName)
    ? schemas[attribute.schemaName]
    : undefined;
  const value =
    category &&
    typeof category === 'object' &&
    Object.hasOwn(category, attribute.fieldName)
      ? (category as Record<string, unknown>)[attribute.fieldName]
      : undefined;
  return attributeValues(value)
    .map((item) =>
      typeof item === 'boolean' ? (item ? 'Yes' : 'No') : String(item),
    )
    .join(', ');
}

/**
 * One optional column per attribute of each category (A section 9).
 * Attributes of the same name in two categories name their category in the header
 * (UM notes composition 3).
 */
export function attributeColumns(
  categories: readonly UserAttributeCategory[],
): UserAttributeColumn[] {
  const seen = new Map<string, number>();
  for (const category of categories)
    for (const field of category.fields)
      seen.set(field.displayName, (seen.get(field.displayName) ?? 0) + 1);
  return categories.flatMap((category) =>
    category.fields.map((field) => ({
      id: userAttributeKey(category.schemaName, field.fieldName),
      schemaName: category.schemaName,
      fieldName: field.fieldName,
      schemaDisplayName: category.displayName,
      field,
      label:
        (seen.get(field.displayName) ?? 0) > 1
          ? `${field.displayName} · ${category.displayName}`
          : field.displayName,
    })),
  );
}

export function attributeFor(
  attributes: readonly UserAttributeColumn[],
  id: string,
): UserAttributeColumn | null {
  return attributes.find((attribute) => attribute.id === id) ?? null;
}

/** The `fullName` of a user, or the primary email when Google holds no name. */
export function userName(row: UserRow): string {
  return row.fullName || row.primaryEmail;
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function setValuesText<T extends string>(
  values: readonly T[],
  labels: Readonly<Record<T, string>>,
): string {
  return values.length
    ? values.map((value) => labels[value]).join(', ')
    : 'none';
}

function attributeLabelFor(
  predicate: Extract<UserPredicate, { field: 'attribute' }>,
  attributes: readonly UserAttributeColumn[],
): string {
  const column = attributeFor(
    attributes,
    userAttributeKey(predicate.schemaName, predicate.fieldName),
  );
  return column?.label ?? predicate.fieldName;
}

/** The chip text of one filter (GRID-04, UM notes composition 8). */
export function chipLabel(
  predicate: UserPredicate,
  attributes: readonly UserAttributeColumn[] = [],
): string {
  if (predicate.field === 'attribute') {
    const label = attributeLabelFor(predicate, attributes);
    switch (predicate.operator) {
      case 'numberRange':
        return predicate.from === predicate.to
          ? `${label} ${predicate.from}`
          : `${label} ${predicate.from} to ${predicate.to}`;
      case 'dateRange':
        return `${label} ${predicate.from} to ${predicate.to}`;
      case 'is':
        return `${label} ${predicate.value ? 'Yes' : 'No'}`;
      case 'hasValue':
        return `${label} has a value`;
      default:
        return `${label} contains: ${predicate.value}`;
    }
  }
  const label = fieldFor(predicate.field).label;
  if (predicate.field === 'status')
    return `${label} · ${setValuesText(predicate.values, STATUS_LABELS)}`;
  if (predicate.field === 'twoStep')
    return `${label} · ${setValuesText(predicate.values, TWO_STEP_LABELS)}`;
  if (predicate.field === 'orgUnitPath')
    return `${label} · ${
      predicate.values.length === 0
        ? 'none'
        : predicate.values.length <= 3
          ? predicate.values.join(', ')
          : `${predicate.values.length} units`
    }`;
  if (predicate.field === 'lastLoginTime' || predicate.field === 'creationTime')
    return `${label} ${predicate.operator === 'before' ? 'before' : 'on or after'}: ${day(predicate.value)}`;
  if (predicate.operator === 'isEmpty') return `${label} is empty`;
  const operator =
    TEXT_OPERATORS.find(
      (candidate) => candidate.id === predicate.operator,
    )?.label.toLowerCase() ?? predicate.operator;
  return `${label} ${operator}: ${predicate.value}`;
}

export function shortcutLabel(predicate: UserPredicate): string {
  return 'value' in predicate
    ? `${fieldFor(predicate.field).label} contains "${predicate.value}"`
    : chipLabel(predicate);
}

/** GRID-04: field labels match first. Name and email shortcuts follow for typed text. */
export function suggestions(
  text: string,
  attributes: readonly UserAttributeColumn[] = [],
): {
  fields: (UserField | UserAttributeColumn)[];
  shortcuts: UserPredicate[];
} {
  const query = text.trim();
  const lower = query.toLowerCase();
  const isField = (item: UserField | UserAttributeColumn): item is UserField =>
    'kind' in item;
  const match = (label: string) => label.toLowerCase().includes(lower);
  return {
    fields: [
      ...USER_FIELDS.filter((field) => match(field.label)),
      ...FILTER_ONLY_FIELDS.filter((field) => match(field.label)),
      ...attributes.filter((attribute) => match(attribute.label)),
    ].sort((left, right) =>
      isField(left) === isField(right) ? 0 : isField(left) ? -1 : 1,
    ),
    shortcuts:
      query && query.length <= 256
        ? [
            { field: 'fullName', operator: 'contains', value: query },
            { field: 'primaryEmail', operator: 'contains', value: query },
          ]
        : [],
  };
}

/** Organization unit paths of the users, as the OrgUnit filter offers them. */
export function orgUnitPaths(units: readonly { path: string }[]): string[] {
  const paths = new Set<string>(['/']);
  for (const unit of units) {
    const parts = unit.path.split('/').filter(Boolean);
    for (let index = 1; index <= parts.length; index++)
      paths.add(`/${parts.slice(0, index).join('/')}`);
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

export interface OrgUnitOption {
  path: string;
  label: string;
  depth: number;
}

export function orgUnitOptions(
  units: readonly { path: string }[],
  search = '',
): OrgUnitOption[] {
  const lower = search.trim().toLowerCase();
  return [...new Set([...orgUnitPaths(units)])]
    .filter((path) => path.toLowerCase().includes(lower))
    .map((path) => {
      const parts = path.split('/').filter(Boolean);
      return {
        path,
        label:
          lower && parts.length
            ? path
            : (parts.at(-1) ?? 'All organization units'),
        depth: parts.length,
      };
    });
}

/** Organization units at or below a path. The root contains every unit. */
export function unitsWithin(
  units: readonly { path: string }[],
  path: string,
): string[] {
  return units
    .map((unit) => unit.path)
    .filter(
      (candidate) =>
        path === '/' || candidate === path || candidate.startsWith(`${path}/`),
    );
}

export type UnitCheck = 'checked' | 'mixed' | 'unchecked';

export function unitCheck(
  selected: readonly string[],
  units: readonly { path: string }[],
  path: string,
): UnitCheck {
  const inside = unitsWithin(units, path);
  const chosen = inside.filter((candidate) =>
    selected.includes(candidate),
  ).length;
  if (chosen === 0) return 'unchecked';
  return chosen === inside.length ? 'checked' : 'mixed';
}

/** Choosing a unit chooses the units inside it, so the filter covers the subtree. */
export function withUnit(
  selected: readonly string[],
  units: readonly { path: string }[],
  path: string,
  checked: boolean,
): string[] {
  const inside = new Set(unitsWithin(units, path));
  const rest = selected.filter((candidate) => !inside.has(candidate));
  return (checked ? [...rest, ...inside] : rest).sort((a, b) =>
    a.localeCompare(b),
  );
}

export function dateInputValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Date filters start at local midnight of the chosen day. */
export function dateInputToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, dayOfMonth] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, dayOfMonth);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === dayOfMonth
    ? date.toISOString()
    : null;
}

const accessFailures = new Set<string>([
  'delegation-not-authorized',
  'scope-mismatch',
  'permission-denied',
  'policy-restricted',
]);

/** The capability record holds the only copy of a scope string. */
function capabilityScope(id: 'user-inventory' | 'user-schemas'): string {
  const capability = GOOGLE_CAPABILITIES.find(
    (candidate) => candidate.id === id,
  );
  if (!capability) throw new Error(`Unknown Google capability ${id}`);
  return capability.scope;
}

const inventoryScope = capabilityScope('user-inventory');
const schemaScope = capabilityScope('user-schemas');

/**
 * The category read failure, with the scope that the person must add (A section 11,
 * "Missing Google scope"). The status panel links the Google connection page.
 */
export function categoryFailureText(
  status: number | undefined,
  failure: string | null | undefined,
): string {
  if (status === 409)
    return 'Custom attribute columns need a Google Workspace connection.';
  if (failure && accessFailures.has(failure))
    return `Custom attribute columns are unavailable. Add ${schemaScope} to the delegation client in the Google Admin Console.`;
  return 'Custom attribute columns are unavailable.';
}

/** Whether the Google connection page carries the fix for a category read failure. */
export function categoryNeedsConnection(
  status: number | undefined,
  failure: string | null | undefined,
): boolean {
  return (
    status === 409 ||
    (!!failure &&
      (accessFailures.has(failure) ||
        failure === 'credential-rejected' ||
        failure === 'key-unavailable'))
  );
}

export function needsGoogleConnection(
  failure: DeviceSyncFailure | null,
): boolean {
  return (
    !!failure &&
    (accessFailures.has(failure) ||
      failure === 'credential-rejected' ||
      failure === 'key-unavailable')
  );
}

export function syncFailureText(failure: DeviceSyncFailure | null): string {
  if (!failure) return '';
  if (accessFailures.has(failure))
    return `Google denied user access. Add ${inventoryScope} to the delegation client in the Google Admin Console.`;
  switch (failure) {
    case 'api-not-enabled':
      return 'Enable the Admin SDK API in the Google Cloud project of the service account.';
    case 'quota':
      return 'Google limited the requests. Refresh again later.';
    case 'network-failure':
    case 'provider-unavailable':
      return 'Campus Commander could not reach Google. Refresh again.';
    case 'credential-rejected':
    case 'key-unavailable':
      return 'The Google credential needs attention. Open the Google connection page.';
    case 'interrupted':
      return 'The last refresh stopped before it finished.';
    case 'orchestration-unavailable':
      return 'Campus Commander could not start the refresh. Check Diagnostics.';
    default:
      return 'The last refresh failed.';
  }
}
