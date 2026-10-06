import {
  deviceDetailSchema,
  deviceRowSchema,
  type DeviceDetail,
  type DeviceGroupField,
  type DeviceGrouping,
  type DevicePredicate,
  type DeviceQuery,
  type DeviceRow,
} from '@campus/application-contracts';
import type { SelectionState } from './device-selection';

const columns = {
  serialNumber: 'd.serial_number',
  model: 'd.model',
  assetTag: 'd.asset_tag',
  orgUnitPath: 'd.org_unit_path',
  lastContact: 'd.last_contact',
  annotatedLocation: 'd.annotated_location',
  notes: 'd.notes',
} as const;
/** A failed telemetry read in the published sync makes every battery unavailable. */
const batteryStatus =
  "CASE WHEN s.telemetry_failure IS NOT NULL THEN 'unavailable' ELSE d.battery_status END";
const batteryOrder =
  "CASE WHEN s.telemetry_failure IS NOT NULL THEN 4 WHEN d.battery_status='reported' THEN CASE d.battery_health WHEN 'replace-now' THEN 0 WHEN 'replace-soon' THEN 1 ELSE 2 END WHEN d.battery_status='no-report' THEN 3 ELSE 4 END";
const healthValues = new Set(['normal', 'replace-soon', 'replace-now']);
/** Group keys equal the filter values, so a group converts to filters exactly. */
const groupKeys: Record<DeviceGroupField, string> = {
  orgUnitPath: 'd.org_unit_path',
  model: "coalesce(d.model,'')",
  battery:
    "CASE WHEN s.telemetry_failure IS NOT NULL THEN 'unavailable' WHEN d.battery_status='reported' THEN d.battery_health ELSE d.battery_status END",
};
const groupOrder: Record<DeviceGroupField, string> = {
  orgUnitPath: 'key ASC',
  model: 'key ASC',
  // PostgreSQL rejects an output alias inside an ORDER BY expression.
  battery: `array_position(ARRAY['normal','replace-soon','replace-now','no-report','unavailable']::text[],${groupKeys.battery})`,
};
const from =
  'FROM cc.device_sync_state s JOIN cc.devices d ON d.customer_id=s.customer_id';

export const deviceColumns = `d.device_id,d.serial_number,d.model,d.asset_tag,d.org_unit_path,d.last_contact,d.annotated_location,d.notes,${batteryStatus} AS battery_status,d.battery_health,d.battery_capacity_percent,d.battery_reported_at,d.last_entity_sync`;

export interface SqlStatement {
  text: string;
  values: unknown[];
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

type Add = (value: unknown) => string;

function adder(values: unknown[]): Add {
  return (value) => {
    values.push(value);
    return `$${values.length}`;
  };
}

/** Field names map to fixed columns. Values travel only as parameters. */
function predicateClauses(
  predicates: readonly DevicePredicate[],
  add: Add,
): string[] {
  const clauses: string[] = [];
  for (const predicate of predicates) {
    if (predicate.field === 'orgUnitPath') {
      clauses.push(`d.org_unit_path=ANY(${add(predicate.values)}::text[])`);
    } else if (predicate.field === 'battery') {
      const health = predicate.values.filter((value) =>
        healthValues.has(value),
      );
      const missing = predicate.values.filter(
        (value) => !healthValues.has(value),
      );
      const parts: string[] = [];
      if (health.length)
        parts.push(
          `(s.telemetry_failure IS NULL AND d.battery_status='reported' AND d.battery_health=ANY(${add(health)}::text[]))`,
        );
      if (missing.length)
        parts.push(`${batteryStatus}=ANY(${add(missing)}::text[])`);
      clauses.push(parts.length ? `(${parts.join(' OR ')})` : 'FALSE');
    } else if (predicate.field === 'lastContact') {
      clauses.push(
        `d.last_contact ${predicate.operator === 'before' ? '<' : '>='} ${add(predicate.value)}::timestamptz`,
      );
    } else {
      const column = columns[predicate.field];
      if (predicate.operator === 'isEmpty')
        clauses.push(`(${column} IS NULL OR ${column}='')`);
      else if (predicate.operator === 'equals')
        clauses.push(`lower(${column})=lower(${add(predicate.value)})`);
      else
        clauses.push(
          `${column} ILIKE ${add(
            predicate.operator === 'contains'
              ? `%${escapeLike(predicate.value)}%`
              : `${escapeLike(predicate.value)}%`,
          )}`,
        );
    }
  }
  return clauses;
}

/** Devices inside an open group: each grouped level equals its key. */
function groupClauses(
  by: readonly DeviceGroupField[],
  keys: readonly string[],
  add: Add,
): string[] {
  return keys.map((key, level) => `${groupKeys[by[level]]}=${add(key)}`);
}

/** Selected devices: any filter term, group term, or explicit addition, minus exceptions. */
function selectedClause(state: SelectionState, add: Add): string {
  const all = (clauses: string[]) =>
    clauses.length ? `(${clauses.join(' AND ')})` : 'TRUE';
  const parts = [
    ...state.terms.map((term) => all(predicateClauses(term, add))),
    ...state.groups.map((group) =>
      all([
        ...predicateClauses(group.predicates, add),
        ...groupClauses(group.by, group.route, add),
      ]),
    ),
  ];
  if (state.additions.length)
    parts.push(`d.device_id=ANY(${add(state.additions)}::text[])`);
  if (!parts.length) return 'FALSE';
  const chosen = `(${parts.join(' OR ')})`;
  return state.exceptions.length
    ? `(${chosen} AND NOT d.device_id=ANY(${add(state.exceptions)}::text[]))`
    : chosen;
}

function deviceWhere(
  predicates: readonly DevicePredicate[],
  values: unknown[],
  selection: SelectionState | null = null,
  group: DeviceGrouping | null = null,
): string {
  const add = adder(values);
  const clauses = [
    's.customer_id=$1',
    'd.removed_at IS NULL',
    ...predicateClauses(predicates, add),
    ...(group ? groupClauses(group.by, group.keys, add) : []),
  ];
  if (selection) clauses.push(selectedClause(selection, add));
  return clauses.join(' AND ');
}

export function devicePageSql(
  customerId: string,
  query: DeviceQuery,
  selection: SelectionState | null = null,
): { rows: SqlStatement; count: SqlStatement } {
  const values: unknown[] = [customerId];
  const where = deviceWhere(query.predicates, values, selection, query.group);
  const order =
    query.sort.field === 'battery' ? batteryOrder : columns[query.sort.field];
  const direction = query.sort.direction === 'desc' ? 'DESC' : 'ASC';
  return {
    rows: {
      text: `SELECT ${deviceColumns} ${from} WHERE ${where} ORDER BY ${order} ${direction} NULLS LAST,d.device_id ${direction} OFFSET $${values.length + 1} LIMIT $${values.length + 2}`,
      values: [...values, query.offset, query.limit],
    },
    count: {
      text: `SELECT count(*)::integer AS matching ${from} WHERE ${where}`,
      values: [...values],
    },
  };
}

/** Every stale device in the result set, not only the page. The API refreshes them all. */
export function staleIdsSql(
  customerId: string,
  query: DeviceQuery,
  selection: SelectionState | null,
  cutoff: Date,
): SqlStatement {
  const values: unknown[] = [customerId];
  const where = deviceWhere(query.predicates, values, selection, query.group);
  values.push(cutoff.toISOString());
  return {
    text: `SELECT d.device_id ${from} WHERE ${where} AND d.last_entity_sync<$${values.length}::timestamptz ORDER BY d.device_id LIMIT 100000`,
    values,
  };
}

export function deviceDetailSql(
  customerId: string,
  deviceId: string,
): SqlStatement {
  return {
    text: `SELECT ${deviceColumns},CASE WHEN s.telemetry_failure IS NOT NULL THEN '[]'::jsonb ELSE d.battery_reports END AS battery_reports,d.removed_at ${from} WHERE s.customer_id=$1 AND d.device_id=$2`,
    values: [customerId, deviceId],
  };
}

const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : (value ?? null);

export function deviceRow(
  row: Record<string, unknown>,
  cutoff: number,
): DeviceRow {
  const lastEntitySync = iso(row['last_entity_sync']);
  return deviceRowSchema.parse({
    deviceId: row['device_id'],
    serialNumber: row['serial_number'],
    model: row['model'],
    assetTag: row['asset_tag'],
    orgUnitPath: row['org_unit_path'],
    lastContact: iso(row['last_contact']),
    annotatedLocation: row['annotated_location'],
    notes: row['notes'],
    battery:
      row['battery_status'] === 'reported'
        ? {
            status: 'reported',
            health: row['battery_health'],
            capacityPercent: row['battery_capacity_percent'],
            reportedAt: iso(row['battery_reported_at']),
          }
        : { status: row['battery_status'] },
    lastEntitySync,
    stale:
      typeof lastEntitySync === 'string' && Date.parse(lastEntitySync) < cutoff,
  });
}

export function deviceDetail(
  row: Record<string, unknown>,
  cutoff: number,
): DeviceDetail {
  return deviceDetailSchema.parse({
    ...deviceRow(row, cutoff),
    removedAt: iso(row['removed_at']),
    batteryReports: row['battery_reports'],
  });
}

export function deviceOrgUnitsSql(customerId: string): SqlStatement {
  return {
    text: `SELECT d.org_unit_path,count(*)::integer AS devices ${from} WHERE s.customer_id=$1 AND d.removed_at IS NULL GROUP BY d.org_unit_path ORDER BY d.org_unit_path LIMIT 10000`,
    values: [customerId],
  };
}

export function selectionCountSql(
  customerId: string,
  selection: SelectionState,
): SqlStatement {
  const values: unknown[] = [customerId];
  const where = deviceWhere([], values, selection);
  return {
    text: `SELECT count(*)::integer AS selected ${from} WHERE ${where}`,
    values,
  };
}

/** Which of the given devices the selection holds. */
export function selectedAmongSql(
  customerId: string,
  selection: SelectionState,
  ids: readonly string[],
): SqlStatement {
  const values: unknown[] = [customerId, ids];
  const where = deviceWhere([], values, selection);
  return {
    text: `SELECT d.device_id ${from} WHERE ${where} AND d.device_id=ANY($2::text[])`,
    values,
  };
}

/** Which of the given devices match a filter, inside a group when one is given. */
export function matchingAmongSql(
  customerId: string,
  predicates: readonly DevicePredicate[],
  ids: readonly string[],
  group: DeviceGrouping | null = null,
): SqlStatement {
  const values: unknown[] = [customerId, ids];
  const where = deviceWhere(predicates, values, null, group);
  return {
    text: `SELECT d.device_id ${from} WHERE ${where} AND d.device_id=ANY($2::text[])`,
    values,
  };
}

/** One grouped level: each key with its device count, plus the number of keys and devices. */
export function deviceGroupsSql(
  customerId: string,
  query: DeviceQuery,
  selection: SelectionState | null = null,
): { groups: SqlStatement; count: SqlStatement } {
  const values: unknown[] = [customerId];
  const where = deviceWhere(query.predicates, values, selection, query.group);
  const field = query.group.by[query.group.keys.length];
  const key = groupKeys[field];
  return {
    groups: {
      text: `SELECT ${key} AS key,count(*)::integer AS devices ${from} WHERE ${where} GROUP BY 1 ORDER BY ${groupOrder[field]} OFFSET $${values.length + 1} LIMIT $${values.length + 2}`,
      values: [...values, query.offset, query.limit],
    },
    count: {
      text: `SELECT count(DISTINCT ${key})::integer AS groups,count(*)::integer AS matching ${from} WHERE ${where}`,
      values: [...values],
    },
  };
}

/** The selected devices inside a filtered group. Deselecting the group excepts them. */
export function selectedInSql(
  customerId: string,
  selection: SelectionState,
  predicates: readonly DevicePredicate[],
  group: DeviceGrouping,
): SqlStatement {
  const values: unknown[] = [customerId];
  const where = deviceWhere(predicates, values, selection, group);
  return { text: `SELECT d.device_id ${from} WHERE ${where}`, values };
}

/**
 * Whether each listed group is fully selected. LibreGrid joins routes with `|`,
 * so the statement compares the joined keys instead of splitting the text.
 */
export function groupSelectionSql(
  customerId: string,
  selection: SelectionState,
  predicates: readonly DevicePredicate[],
  by: readonly DeviceGroupField[],
  routes: readonly string[],
): SqlStatement {
  const values: unknown[] = [customerId, routes];
  const where = deviceWhere(predicates, values);
  const selected = selectedClause(selection, adder(values));
  const keys = by.map((field) => groupKeys[field]).join(',');
  const route = `concat_ws('|',${keys})`;
  return {
    text: `SELECT ${route} AS route,bool_and(${selected}) AS selected ${from} WHERE ${where} GROUP BY ${keys} HAVING ${route}=ANY($2::text[])`,
    values,
  };
}
