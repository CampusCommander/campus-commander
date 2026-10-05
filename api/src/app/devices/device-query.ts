import {
  deviceDetailSchema,
  deviceRowSchema,
  type DeviceDetail,
  type DevicePredicate,
  type DeviceQuery,
  type DeviceRow,
} from '@campus/application-contracts';

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
const from =
  'FROM cc.device_sync_state s JOIN cc.devices d ON d.sync_id=s.current_sync_id';

export const deviceColumns = `d.device_id,d.serial_number,d.model,d.asset_tag,d.org_unit_path,d.last_contact,d.annotated_location,d.notes,${batteryStatus} AS battery_status,d.battery_health,d.battery_capacity_percent,d.battery_reported_at`;

export interface SqlStatement {
  text: string;
  values: unknown[];
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Field names map to fixed columns. Values travel only as parameters. */
function deviceWhere(
  predicates: readonly DevicePredicate[],
  values: unknown[],
): string {
  const add = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const clauses = ['s.customer_id=$1'];
  for (const predicate of predicates) {
    if (predicate.field === 'orgUnitPath') {
      if (predicate.operator === 'equals')
        clauses.push(`d.org_unit_path=${add(predicate.value)}`);
      else if (predicate.value !== '/')
        clauses.push(
          `(d.org_unit_path=${add(predicate.value)} OR d.org_unit_path LIKE ${add(`${escapeLike(predicate.value)}/%`)})`,
        );
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
      clauses.push(`(${parts.join(' OR ')})`);
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
  return clauses.join(' AND ');
}

export function devicePageSql(
  customerId: string,
  query: DeviceQuery,
): { rows: SqlStatement; count: SqlStatement } {
  const values: unknown[] = [customerId];
  const where = deviceWhere(query.predicates, values);
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

export function deviceDetailSql(
  customerId: string,
  deviceId: string,
): SqlStatement {
  return {
    text: `SELECT ${deviceColumns},CASE WHEN s.telemetry_failure IS NOT NULL THEN '[]'::jsonb ELSE d.battery_reports END AS battery_reports,s.observed_at ${from} WHERE s.customer_id=$1 AND d.device_id=$2`,
    values: [customerId, deviceId],
  };
}

const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : (value ?? null);

export function deviceRow(row: Record<string, unknown>): DeviceRow {
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
  });
}

export function deviceDetail(row: Record<string, unknown>): DeviceDetail {
  return deviceDetailSchema.parse({
    ...deviceRow(row),
    observedAt: iso(row['observed_at']),
    batteryReports: row['battery_reports'],
  });
}
