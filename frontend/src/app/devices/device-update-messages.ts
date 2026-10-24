import {
  DEVICE_UPDATE_FIELD_LABELS,
  DEVICE_UPDATE_FIELD_LIMITS,
  DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
  GOOGLE_CAPABILITIES,
  GOOGLE_HEALTH_RECOVERY,
  deviceOrgUnitTreeMessage,
  type DeviceOrgUnitTree,
  type DeviceUpdateField,
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

/** The scope that the organization unit field names (design section 6). */
export const DEVICE_ORG_UNIT_SCOPE =
  GOOGLE_CAPABILITIES.find(
    (capability) => capability.id === 'school-ou-references',
  )?.scope ?? '';

export const DEVICE_UPDATE_PERMISSION_MESSAGE =
  'You need the devices:read, devices:write, and devices:bulk-actions permissions to update devices. Ask your administrator for access.';

/**
 * The request that one change writes. A Clear writes null.
 * Shared by the sheet drafts, so one rule compares a request with its baseline.
 */
export function deviceUpdateRequest(
  mode: 'replace' | 'clear' | 'move',
  value: string,
): string | null {
  return mode === 'clear' ? null : value;
}

/**
 * True when a request changes nothing. Text compares exactly, and a path compares without
 * case, as every path reader does (addendum section 4).
 */
export function sameUpdateRequest(
  field: DeviceUpdateField,
  request: string | null,
  baseline: string | null,
): boolean {
  const seen = baseline === '' ? null : baseline;
  if (field === 'orgUnitPath')
    return (request ?? '').toLowerCase() === (seen ?? '').toLowerCase();
  return request === seen;
}

/**
 * The validation message for one field value, or null when it passes. A baseline checks the
 * edit-list rule: a request equal to the value that the person saw changes nothing.
 */
export function deviceUpdateValueError(
  field: DeviceUpdateField,
  value: string,
  baseline?: string | null,
): string | null {
  const limit = DEVICE_UPDATE_FIELD_LIMITS[field];
  const label = DEVICE_UPDATE_FIELD_LABELS[field];
  const length = [...value].length;
  if (length < 1 || length > limit)
    return `${label} holds 1 to ${limit} characters.`;
  if (value.trim().length === 0) return `${label} needs a visible character.`;
  if (baseline !== undefined && sameUpdateRequest(field, value, baseline))
    return `${label} already holds this value.`;
  return null;
}

/** The hint under a value field. It names the limit of its own field. */
export function deviceUpdateValueHint(field: DeviceUpdateField): string {
  return `Use ${DEVICE_UPDATE_FIELD_LIMITS[field]} characters or fewer. Spaces alone do not count.`;
}

/**
 * The note beside a Clear that changes nothing, or null when the Clear removes a value.
 * The single-device draft omits that Clear, so the note explains the omission (B4).
 */
export function deviceUpdateClearNote(
  field: DeviceUpdateField,
  baseline: string | null,
): string | null {
  return sameUpdateRequest(field, null, baseline)
    ? `${DEVICE_UPDATE_FIELD_LABELS[field]} is already empty. Clear changes nothing.`
    : null;
}

/** The end counter under a value field, in code points. */
export function deviceUpdateValueCounter(
  field: DeviceUpdateField,
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

function accessFailureText(
  failure: GoogleFailure | null,
  fallback = 'Google write access is unavailable.',
): string {
  const entry = failure ? GOOGLE_HEALTH_RECOVERY[failure] : undefined;
  return entry ? `${entry.label}. ${entry.recovery}` : fallback;
}

/**
 * The note under the Organization unit field, in the shape of the Devices write-access note
 * (design choice 14). A missing read scope names that scope. A failed read offers Recheck.
 */
export function updateDeviceOrgUnitNote(
  tree: DeviceOrgUnitTree | null,
  message: string,
): UpdateDeviceNote | null {
  if (!tree)
    return message
      ? { text: message, actions: ['recheck'], error: true }
      : null;
  switch (tree.state) {
    case 'granted':
      return null;
    case 'denied': {
      const denied = deviceOrgUnitTreeMessage(tree);
      return denied
        ? { text: denied, actions: ['copy-scope', 'recheck'], error: true }
        : null;
    }
    case 'unavailable':
      return {
        text: accessFailureText(
          tree.failure,
          'Google organization unit reads are unavailable.',
        ),
        actions: ['recheck'],
        error: true,
      };
  }
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

/** What device details needs to know before it enables Update device. */
export interface DetailUpdateAvailability {
  offline: boolean;
  /** False until the customer scope arrives, so a slow read does not claim a denial. */
  permissionsKnown: boolean;
  canRead: boolean;
  canWrite: boolean;
  canBulk: boolean;
}

/**
 * The reason that Update device is disabled on device details, or null when it is enabled
 * (`docs/ui/rules.md:73`, addendum section 8). The page names the three actions of the
 * workflow, so the same permission sentence serves the toolbar note.
 */
export function detailUpdateNote(
  availability: DetailUpdateAvailability,
): UpdateDeviceNote | null {
  if (availability.offline)
    return {
      text: 'Update device is unavailable while you are offline.',
      actions: [],
      error: false,
    };
  if (!availability.permissionsKnown)
    return {
      text: 'Checking your device permissions…',
      actions: [],
      error: false,
    };
  if (!availability.canRead || !availability.canWrite || !availability.canBulk)
    return {
      text: DEVICE_UPDATE_PERMISSION_MESSAGE,
      actions: [],
      error: false,
    };
  return null;
}
