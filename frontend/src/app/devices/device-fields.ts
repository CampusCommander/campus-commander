import {
  batteryFilterValueSchema,
  type DeviceBattery,
  type DeviceOrgUnit,
  type DevicePredicate,
  type DeviceQuery,
  type DeviceSyncFailure,
  type GoogleFailure,
} from '@campus/application-contracts';

export type DeviceSortField = DeviceQuery['sort']['field'];
export type BatteryFilterValue =
  (typeof batteryFilterValueSchema.options)[number];
export type DeviceFieldKind = 'text' | 'orgUnit' | 'battery' | 'date';

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

/** Grid column and filter order from the field contract, without the School column. */
export const DEVICE_FIELDS: readonly DeviceField[] = [
  { id: 'serialNumber', label: 'Serial', kind: 'text', optional: false },
  { id: 'model', label: 'Model', kind: 'text', optional: false },
  { id: 'assetTag', label: 'Asset tag', kind: 'text', optional: false },
  {
    id: 'orgUnitPath',
    label: 'Organization unit',
    kind: 'orgUnit',
    optional: false,
  },
  { id: 'battery', label: 'Battery', kind: 'battery', optional: false },
  { id: 'lastContact', label: 'Device contact', kind: 'date', optional: false },
  {
    id: 'annotatedLocation',
    label: 'Annotated location',
    kind: 'text',
    optional: true,
  },
  { id: 'notes', label: 'Notes', kind: 'text', optional: true },
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
export const ORG_UNIT_OPERATORS = [
  { id: 'within', label: 'Is within' },
  { id: 'equals', label: 'Is' },
] as const;

export const BATTERY_LABELS: Readonly<Record<BatteryFilterValue, string>> = {
  normal: 'Normal',
  'replace-soon': 'Replace soon',
  'replace-now': 'Replace now',
  'no-report': 'No battery report',
  unavailable: 'Unavailable',
};

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

export function chipLabel(predicate: DevicePredicate): string {
  const label = fieldFor(predicate.field).label;
  if (predicate.field === 'battery')
    return `${label} · ${predicate.values.map((value) => BATTERY_LABELS[value]).join(', ')}`;
  if (predicate.field === 'orgUnitPath')
    return `${label} ${predicate.operator === 'within' ? 'is within' : 'is'}: ${predicate.value}`;
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
        label: parts.at(-1) ?? 'All organization units',
        depth: parts.length,
      };
    });
}

export function batteryText(battery: DeviceBattery): string {
  return battery.status === 'reported'
    ? BATTERY_LABELS[battery.health]
    : BATTERY_LABELS[battery.status];
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

export function syncFailureText(failure: DeviceSyncFailure | null): string {
  if (!failure) return '';
  if (accessFailures.has(failure))
    return 'Google denied device access. Add the device scopes to the delegation client in the Google Admin Console.';
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
    ? 'Google denied battery telemetry access. Add the telemetry scope to the delegation client in the Google Admin Console.'
    : 'Campus Commander could not read battery telemetry during the last refresh.';
}
