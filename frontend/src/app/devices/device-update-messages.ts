import {
  DEVICE_UPDATE_FIELD_LABELS,
  DEVICE_UPDATE_FIELD_LIMITS,
  DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
  GOOGLE_CAPABILITIES,
  GOOGLE_HEALTH_RECOVERY,
  type DeviceUpdateTextField,
  type DeviceWriteAccess,
  type GoogleFailure,
} from '@campus/application-contracts';

/** The exact busy answer of the write-access check route (design 2.7). */
export const DEVICE_WRITE_ACCESS_BUSY_MESSAGE =
  'Another check started less than 30 seconds ago. Try again in 30 seconds.';

/** The scope that the denied message names (design 4.3). */
export const DEVICE_WRITE_SCOPE =
  GOOGLE_CAPABILITIES.find((capability) => capability.id === 'device-changes')
    ?.scope ?? '';

export const DEVICE_UPDATE_PERMISSION_MESSAGE =
  'You need the devices:read, devices:write, and devices:bulk-actions permissions to update devices. Ask your administrator for access.';

/** The validation message for one field value, or null when it passes. */
export function deviceUpdateValueError(
  field: DeviceUpdateTextField,
  value: string,
): string | null {
  const limit = DEVICE_UPDATE_FIELD_LIMITS[field];
  const label = DEVICE_UPDATE_FIELD_LABELS[field];
  const length = [...value].length;
  if (length < 1 || length > limit)
    return `${label} holds 1 to ${limit} characters.`;
  if (value.trim().length === 0) return `${label} needs a visible character.`;
  return null;
}

/** The hint under a value field. It names the limit of its own field. */
export function deviceUpdateValueHint(field: DeviceUpdateTextField): string {
  return `Use ${DEVICE_UPDATE_FIELD_LIMITS[field]} characters or fewer. Spaces alone do not count.`;
}

/** The end counter under a value field, in code points. */
export function deviceUpdateValueCounter(
  field: DeviceUpdateTextField,
  value: string,
): string {
  return `${[...value].length} of ${
    DEVICE_UPDATE_FIELD_LIMITS[field]
  } characters`;
}

/** A count with thousands separators and a singular or plural noun (design 1760). */
export function deviceCountText(value: number): string {
  return `${value.toLocaleString('en-US')} ${value === 1 ? 'device' : 'devices'}`;
}

/** The changed-field count of the draft summary. One count per changed field. */
export function changedFieldsText(value: number): string {
  return `${value} changed ${value === 1 ? 'field' : 'fields'}`;
}

export type UpdateDeviceNoteAction = 'copy-scope' | 'recheck';

/** What the Devices page shows beside Bulk Actions while Update device is disabled. */
export interface UpdateDeviceNote {
  text: string;
  /** The recovery controls, in display order. */
  actions: UpdateDeviceNoteAction[];
  /** The state needs recovery, not only a different selection. */
  error: boolean;
}

export interface UpdateDeviceAvailability {
  offline: boolean;
  canRead: boolean;
  canWrite: boolean;
  canBulk: boolean;
  selectionCount: number;
  /** Null before the first answer of GET /api/devices/updates/access. */
  access: DeviceWriteAccess | null;
  accessLoading: boolean;
  /** The permission note of the family. Send command and Change status set their own. */
  permissionMessage?: string;
}

function accessFailureText(failure: GoogleFailure | null): string {
  const entry = failure ? GOOGLE_HEALTH_RECOVERY[failure] : undefined;
  return entry
    ? `${entry.label}. ${entry.recovery}`
    : 'Google write access is unavailable.';
}

/**
 * The reason that Update device is disabled, in the order of the card: connectivity,
 * permissions, selection, then the write-access state. Null means the action is enabled.
 */
export function updateDeviceNote(
  availability: UpdateDeviceAvailability,
): UpdateDeviceNote | null {
  if (availability.offline)
    return {
      text: 'Update device is unavailable while you are offline.',
      actions: [],
      error: false,
    };
  if (!availability.canRead || !availability.canWrite || !availability.canBulk)
    return {
      text: availability.permissionMessage ?? DEVICE_UPDATE_PERMISSION_MESSAGE,
      actions: [],
      error: false,
    };
  if (availability.selectionCount === 0)
    return {
      text: 'Select one or more devices to update.',
      actions: [],
      error: false,
    };
  // A read in flight is the current answer; a retained state is not reused.
  if (availability.accessLoading)
    return {
      text: 'Checking Google write access…',
      actions: [],
      error: false,
    };
  const access = availability.access;
  if (!access)
    return {
      text: 'Campus Commander could not read Google write access.',
      actions: ['recheck'],
      error: true,
    };
  switch (access.state) {
    case 'granted':
      return null;
    case 'denied':
      return {
        text: DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
        actions: ['copy-scope', 'recheck'],
        error: true,
      };
    case 'unchecked':
      return {
        text: 'Campus Commander has not checked Google write access.',
        actions: ['recheck'],
        error: false,
      };
    case 'unavailable':
      return {
        text: accessFailureText(access.failure),
        actions: ['recheck'],
        error: true,
      };
  }
}
