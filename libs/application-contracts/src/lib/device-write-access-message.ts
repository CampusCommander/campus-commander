import type { DeviceWriteAccess } from './device-updates';
import type { DeviceOrgUnitTree } from './device-org-unit-tree';

/** The exact message of section 4.3 while the state is denied. */
export const DEVICE_WRITE_ACCESS_DENIED_MESSAGE =
  'Google denied device changes. Add https://www.googleapis.com/auth/admin.directory.device.chromeos to the delegation client in the Google Admin Console.';

/** The message that the client shows for one write-access state. */
export function deviceWriteAccessMessage(
  access: DeviceWriteAccess,
): string | null {
  return access.state === 'denied' ? DEVICE_WRITE_ACCESS_DENIED_MESSAGE : null;
}

/** The exact message of design section 6 while the tree state is denied. */
export const DEVICE_ORG_UNIT_TREE_DENIED_MESSAGE =
  'Google denied the organization unit tree. Add https://www.googleapis.com/auth/admin.directory.orgunit.readonly to the delegation client in the Google Admin Console.';

/** The message that the client shows for one organization unit tree state. */
export function deviceOrgUnitTreeMessage(
  tree: DeviceOrgUnitTree,
): string | null {
  return tree.state === 'denied' ? DEVICE_ORG_UNIT_TREE_DENIED_MESSAGE : null;
}
