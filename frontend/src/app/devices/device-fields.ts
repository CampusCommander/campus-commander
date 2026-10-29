import {
  BATTERY_LABELS,
  DEVICE_REPORT_FIELD_LABELS,
  DEVICE_STATUS_LABELS,
  GOOGLE_CAPABILITIES,
  batteryFilterValueSchema,
  batteryText,
  deviceStatusFilterValueSchema,
  statusText,
  type DeviceGroupField,
  type DeviceOrgUnit,
  type DevicePredicate,
  type DeviceQuery,
  type DeviceSyncFailure,
  type GoogleFailure,
} from '@campus/application-contracts';

// The grid and the export share one copy of the battery text, the status text, and the labels.
export {
  BATTERY_LABELS,
  DEVICE_STATUS_LABELS,
  batteryText,
  statusText,
};

export type DeviceSortField = DeviceQuery['sort']['field'];
export type BatteryFilterValue =
  (typeof batteryFilterValueSchema.options)[number];
export type DeviceStatusFilterValue =
  (typeof deviceStatusFilterValueSchema.options)[number];
export type DeviceFieldKind =
  | 'text'
  | 'orgUnit'
  | 'battery'
  | 'status'
  | 'date';

export interface DeviceField {
  id: DeviceSortField;
  label: string;
  kind: DeviceFieldKind;
  /** Optional columns start hidden in the grid. */
  optional: boolean;
}

export interface OrgUnitOption {
  path: string;
  label: string;
  depth: number;
}

/** Grid column and filter order from the field contract, without the School column. The label of
 * each column is the report header of `DEVICE_REPORT_FIELD_LABELS`, so the grid and the export
 * share one copy. */
const gridField = (
  id: DeviceSortField,
  kind: DeviceFieldKind,
  optional: boolean,
): DeviceField => ({ id, label: DEVICE_REPORT_FIELD_LABELS[id], kind, optional });

export const DEVICE_FIELDS: readonly DeviceField[] = [
  gridField('serialNumber', 'text', false),
  // The mockup puts Status directly after Serial (device-commands record, default 7).
  gridField('status', 'status', true),
  gridField('model', 'text', false),
  gridField('assetTag', 'text', false),
  // The approved mockup shows this optional column after Asset tag (notes line 105).
  gridField('annotatedUser', 'text', true),
  gridField('orgUnitPath', 'orgUnit', false),
  gridField('battery', 'battery', false),
  gridField('lastContact', 'date', false),
  gridField('annotatedLocation', 'text', true),
  gridField('notes', 'text', true),
];

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
export function fieldFor(id: DeviceSortField): DeviceField {
  const field = DEVICE_FIELDS.find((candidate) => candidate.id === id);
  if (!field) throw new Error(`Unknown device field ${id}`);
  return field;
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** One readable value list for a set filter chip, such as "Disabled, Deprovisioned". */
function setValuesText<T extends string>(
  values: readonly T[],
  labels: Readonly<Record<T, string>>,
): string {
  return values.length
    ? values.map((value) => labels[value]).join(', ')
    : 'none';
}

export function chipLabel(predicate: DevicePredicate): string {
  const label = fieldFor(predicate.field).label;
  if (predicate.field === 'battery')
    return `${label} · ${setValuesText(predicate.values, BATTERY_LABELS)}`;
  if (predicate.field === 'status')
    return `${label} · ${setValuesText(predicate.values, DEVICE_STATUS_LABELS)}`;
  if (predicate.field === 'orgUnitPath')
    return `${label} · ${
      predicate.values.length === 0
        ? 'none'
        : predicate.values.length <= 3
          ? predicate.values.join(', ')
          : `${predicate.values.length} units`
    }`;
  if (predicate.field === 'lastContact')
    return `${label} ${predicate.operator === 'before' ? 'before' : 'on or after'}: ${day(predicate.value)}`;
  if (predicate.operator === 'isEmpty') return `${label} is empty`;
  const operator = TEXT_OPERATORS.find(
    (candidate) => candidate.id === predicate.operator,
  )!.label.toLowerCase();
  return `${label} ${operator}: ${predicate.value}`;
}

export function shortcutLabel(predicate: DevicePredicate): string {
  return 'value' in predicate
    ? `${fieldFor(predicate.field).label} contains "${predicate.value}"`
    : chipLabel(predicate);
}

/** GRID-04: field labels match first. Identifier shortcuts follow for any typed text. */
export function suggestions(text: string): {
  fields: DeviceField[];
  shortcuts: DevicePredicate[];
} {
  const query = text.trim();
  const lower = query.toLowerCase();
  return {
    fields: DEVICE_FIELDS.filter((field) =>
      field.label.toLowerCase().includes(lower),
    ),
    shortcuts:
      query && query.length <= 256
        ? [
            { field: 'assetTag', operator: 'contains', value: query },
            { field: 'serialNumber', operator: 'contains', value: query },
          ]
        : [],
  };
}

export function orgUnitOptions(
  units: readonly DeviceOrgUnit[],
  search = '',
): OrgUnitOption[] {
  const paths = new Set<string>(['/']);
  for (const unit of units) {
    const parts = unit.path.split('/').filter(Boolean);
    for (let index = 1; index <= parts.length; index++)
      paths.add(`/${parts.slice(0, index).join('/')}`);
  }
  const lower = search.trim().toLowerCase();
  return [...paths]
    .sort((a, b) => a.localeCompare(b))
    .filter((path) => path.toLowerCase().includes(lower))
    .map((path) => {
      const parts = path.split('/').filter(Boolean);
      return {
        path,
        // Repeated names such as Students need their full path during search.
        label:
          lower && parts.length
            ? path
            : (parts.at(-1) ?? 'All organization units'),
        depth: parts.length,
      };
    });
}

/** Organization units with devices at or below a path. The root contains every unit. */
export function unitsWithin(
  units: readonly DeviceOrgUnit[],
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
  units: readonly DeviceOrgUnit[],
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
  units: readonly DeviceOrgUnit[],
  path: string,
  checked: boolean,
): string[] {
  const inside = new Set(unitsWithin(units, path));
  const rest = selected.filter((candidate) => !inside.has(candidate));
  return (checked ? [...rest, ...inside] : rest).sort((a, b) =>
    a.localeCompare(b),
  );
}

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return 'Never';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
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
function capabilityScope(id: 'device-inventory' | 'device-telemetry'): string {
  const capability = GOOGLE_CAPABILITIES.find(
    (candidate) => candidate.id === id,
  );
  if (!capability) throw new Error(`Unknown Google capability ${id}`);
  return capability.scope;
}

const inventoryScope = capabilityScope('device-inventory');
const telemetryScope = capabilityScope('device-telemetry');

export function syncFailureText(failure: DeviceSyncFailure | null): string {
  if (!failure) return '';
  if (accessFailures.has(failure))
    return `Google denied device access. Add ${inventoryScope} to the delegation client in the Google Admin Console.`;
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

export function telemetryFailureText(
  failure: GoogleFailure | null,
): string | null {
  if (!failure) return null;
  return accessFailures.has(failure)
    ? `Google denied battery telemetry access. Add ${telemetryScope} to the delegation client in the Google Admin Console.`
    : 'Campus Commander could not read battery telemetry during the last refresh.';
}

/** A group key as the filters read it. */
export function groupLabel(field: DeviceGroupField, key: string): string {
  if (field === 'model') return key || 'No model';
  if (field === 'battery')
    return BATTERY_LABELS[key as BatteryFilterValue] ?? key;
  return key;
}
