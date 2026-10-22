import {
  DEVICE_UPDATE_VALUE_MAX,
  DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
  GOOGLE_CAPABILITIES,
  GOOGLE_HEALTH_RECOVERY,
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

/** The two validation messages of the preview contract (design 2.3). */
export const DEVICE_UPDATE_VALUE_MESSAGES = {
  length: 'A value holds 1 to 200 characters.',
  visible: 'A value needs a visible character.',
} as const;

/** The validation message for one annotated-location value, or null when it passes. */
export function deviceUpdateValueError(value: string): string | null {
  const length = [...value].length;
  if (length < 1 || length > DEVICE_UPDATE_VALUE_MAX)
    return DEVICE_UPDATE_VALUE_MESSAGES.length;
  if (value.trim().length === 0) return DEVICE_UPDATE_VALUE_MESSAGES.visible;
  return null;
}

/** A count with thousands separators and a singular or plural noun (design 1760). */
export function deviceCountText(value: number): string {
  return `${value.toLocaleString('en-US')} ${value === 1 ? 'device' : 'devices'}`;
}

/** The changed-field count of the draft summary. The draft holds one field. */
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
