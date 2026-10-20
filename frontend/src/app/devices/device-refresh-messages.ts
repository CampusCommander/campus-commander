import {
  GOOGLE_HEALTH_RECOVERY,
  type GoogleHealthFailure,
} from '@campus/application-contracts';

/** The supporting text of Refresh Selected while the selection is empty. */
export const REFRESH_SELECTED_SUPPORT = 'Select devices to refresh.';

/** The supporting text of Refresh Domain without `connection:diagnose`. */
export const REFRESH_DOMAIN_SUPPORT =
  'Requires the Check Google connection permission.';

/** The answer of a selection that lapsed before the request. */
export const SELECTION_EXPIRED_TEXT =
  'Your selection expired. Select the devices again.';

/** The answer of a selection that holds no device. */
export const NOTHING_SELECTED_TEXT = 'The selection holds no devices.';

/** The answer of a selection above the 100,000 device refresh limit. */
export const SELECTION_TOO_LARGE_TEXT =
  'The selection holds more than 100,000 devices. Use Refresh Devices to read every device.';

/** The answer after the domain check passed. */
export const DOMAIN_REFRESHED_TEXT = 'Domain details refreshed.';

/** A count with thousands separators and a singular or plural noun. */
function deviceCount(value: number): string {
  return `${value.toLocaleString('en-US')} ${value === 1 ? 'device' : 'devices'}`;
}

/** A refresh job that the request started. */
export function refreshStartedText(selected: number): string {
  return `Refresh started for ${deviceCount(selected)}. Rows update as Google answers.`;
}

/** A selection whose devices are all claimed by another refresh. */
export function refreshAlreadyReadingText(selected: number): string {
  return selected === 1
    ? 'Another refresh already reads this device.'
    : `Another refresh already reads these ${deviceCount(selected)}.`;
}

/** The failed domain check, with the cause that the answer names. */
export function domainFailureText(
  reason: GoogleHealthFailure | 'busy' | 'unavailable' | null,
): string {
  if (reason === 'busy')
    return 'Domain details did not refresh: another Google check ran in the last 30 seconds.';
  if (reason === 'unavailable')
    return 'Domain details did not refresh: Campus Commander cannot run the Google check now.';
  const cause = reason
    ? GOOGLE_HEALTH_RECOVERY[reason].label
    : 'Campus Commander cannot run the Google check now';
  return `Domain details did not refresh: ${cause}.`;
}

/** The error paragraph of a refresh request that could not start. */
export function refreshStartFailureText(reason: unknown): string {
  return reason === 'orchestration-unavailable'
    ? 'Campus Commander could not start the refresh. Check Diagnostics.'
    : 'The refresh could not start.';
}
