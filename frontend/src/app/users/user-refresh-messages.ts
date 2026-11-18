import {
  GOOGLE_HEALTH_RECOVERY,
  type GoogleHealthFailure,
} from '@campus/application-contracts';

/** The supporting text of Refresh Selected while the selection is empty. */
export const REFRESH_SELECTED_SUPPORT = 'Select users to refresh.';

/** The supporting text of Refresh Domain without `connection:diagnose`. */
export const REFRESH_DOMAIN_SUPPORT =
  'Requires the Check Google connection permission.';

/** The answer of a selection that lapsed before the request. */
export const SELECTION_EXPIRED_TEXT =
  'Your selection expired. Select the users again.';

/** The answer of a selection that holds no user. */
export const NOTHING_SELECTED_TEXT = 'The selection holds no users.';

/** The answer of a selection above the 100,000 user refresh limit. */
export const SELECTION_TOO_LARGE_TEXT =
  'The selection holds more than 100,000 users. Use Refresh Users to read every user.';

/** The answer after the domain check passed. */
export const DOMAIN_REFRESHED_TEXT = 'Domain details refreshed.';

/** A count with thousands separators and a singular or plural noun. */
function userCount(value: number): string {
  return `${value.toLocaleString('en-US')} ${value === 1 ? 'user' : 'users'}`;
}

/** A refresh job that the request started. */
export function refreshStartedText(selected: number): string {
  return `Refresh started for ${userCount(selected)}. Rows update as Google answers.`;
}

/** A selection whose users are all claimed by another refresh. */
export function refreshAlreadyReadingText(selected: number): string {
  return selected === 1
    ? 'Another refresh already reads this user.'
    : `Another refresh already reads these ${userCount(selected)}.`;
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
