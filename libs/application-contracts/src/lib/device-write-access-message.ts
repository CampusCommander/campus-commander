import type { DeviceWriteAccess } from './device-updates';

/** The exact message of section 4.3 while the state is denied. */
export const DEVICE_WRITE_ACCESS_DENIED_MESSAGE =
  'Google denied device changes. Add https://www.googleapis.com/auth/admin.directory.device.chromeos to the delegation client in the Google Admin Console.';

/** The message that the client shows for one write-access state. */
export function deviceWriteAccessMessage(
  access: DeviceWriteAccess,
): string | null {
  return access.state === 'denied' ? DEVICE_WRITE_ACCESS_DENIED_MESSAGE : null;
}
