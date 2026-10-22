import {
  DEVICE_UPDATE_FIELD_ORDER,
  type DeviceUpdateChange,
  type DeviceUpdateTarget,
} from '@campus/application-contracts';

/** One row of cc.device_update_previews. */
export type PreviewRow = Record<string, unknown>;

/** A targets cursor is the ordinal of the previous device and the position of its field. */
export function parseIntCursor(cursor: string | undefined): {
  ordinal: number;
  position: number;
} {
  if (!cursor) return { ordinal: -1, position: -1 };
  const [ordinal, position, ...rest] = cursor.split(':');
  const parsedOrdinal = Number(ordinal);
  const parsedPosition = Number(position);
  if (
    rest.length > 0 ||
    !Number.isInteger(parsedOrdinal) ||
    parsedOrdinal < 0 ||
    !Number.isInteger(parsedPosition) ||
    parsedPosition < 0
  )
    return { ordinal: -1, position: -1 };
  return { ordinal: parsedOrdinal, position: parsedPosition };
}

/** The cursor of one frozen target row: its device ordinal and its field position. */
export function targetCursor(ordinal: unknown, field: unknown): string | null {
  const index = DEVICE_UPDATE_FIELD_ORDER.indexOf(
    field as (typeof DEVICE_UPDATE_FIELD_ORDER)[number],
  );
  // The query compares against array_position, which counts from 1.
  return typeof ordinal === 'number' && index >= 0
    ? `${ordinal}:${index + 1}`
    : null;
}

/** One frozen target page row of one field, with the value that confirmation would write. */
export function previewTargetRow(
  row: Record<string, unknown>,
  change: DeviceUpdateChange,
): DeviceUpdateTarget {
  return {
    deviceId: String(row['device_id']),
    serialNumber: String(row['serial_number'] ?? ''),
    field: change.field,
    observedValue:
      typeof row['observed_value'] === 'string' ? row['observed_value'] : null,
    approvedValue: change.mode === 'clear' ? null : (change.value ?? null),
    disposition: row['disposition'] as DeviceUpdateTarget['disposition'],
    exclusionReason:
      typeof row['exclusion_reason'] === 'string'
        ? row['exclusion_reason']
        : null,
  };
}
