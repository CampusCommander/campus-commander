import type {
  DeviceUpdateMode,
  DeviceUpdateTarget,
} from '@campus/application-contracts';

/** One row of cc.device_update_previews. */
export type PreviewRow = Record<string, unknown>;

/** A targets cursor is the last ordinal of the previous page. */
export function parseIntCursor(cursor: string | undefined): number {
  if (!cursor) return -1;
  const value = Number(cursor);
  return Number.isInteger(value) && value >= 0 ? value : -1;
}

/** One frozen target page row, with the value that confirmation would write. */
export function previewTargetRow(
  row: Record<string, unknown>,
  mode: unknown,
  value: unknown,
): DeviceUpdateTarget {
  return {
    deviceId: String(row['device_id']),
    serialNumber: String(row['serial_number'] ?? ''),
    field: 'annotatedLocation',
    observedValue:
      typeof row['observed_value'] === 'string' ? row['observed_value'] : null,
    approvedValue:
      mode === 'clear' ? null : typeof value === 'string' ? value : null,
    disposition: row['disposition'] as DeviceUpdateTarget['disposition'],
    exclusionReason:
      typeof row['exclusion_reason'] === 'string'
        ? row['exclusion_reason']
        : null,
  };
}

/** The write value of a preview: Clear writes null. */
export function approvedValue(
  mode: DeviceUpdateMode,
  value: string | null,
): string | null {
  return mode === 'clear' ? null : value;
}
