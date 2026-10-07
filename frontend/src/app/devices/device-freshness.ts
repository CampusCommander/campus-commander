/** The stale banner (D11): progress while a refresh runs, the stale state when none runs. */
export interface FreshnessBanner {
  refreshing: boolean;
  title: string;
  body: string;
}

const count = (value: number) => value.toLocaleString('en-US');
const sentences = (parts: string[]) => parts.filter(Boolean).join(' ');

export function freshnessBanner(input: {
  /** Stale devices in the result set. */
  stale: number;
  /** Devices in the result set. */
  matching: number;
  /** A refresh job or a full sync runs. */
  refreshing: boolean;
  /** Why the last refresh job failed. Empty when none failed. */
  jobFailure: string;
  /** Why the last full sync failed. Empty when it did not fail. */
  syncFailure: string;
  syncFailed: boolean;
}): FreshnessBanner | null {
  const total = Math.max(input.stale, input.matching);
  const devices = `${count(total)} ${total === 1 ? 'device' : 'devices'}`;
  if (input.stale > 0 && input.refreshing)
    return {
      refreshing: true,
      title: `Refreshing ${count(input.stale)} of ${devices}`,
      body: 'Current data stays visible. Rows update as Google answers.',
    };
  if (input.stale > 0)
    return {
      refreshing: false,
      title: 'Inventory observation is stale',
      body: sentences([
        `${count(input.stale)} of ${devices} ${input.stale === 1 ? 'was' : 'were'} last read from Google more than 24 hours ago.`,
        input.jobFailure || input.syncFailure,
        'Current data stays visible during refresh.',
      ]),
    };
  if (input.syncFailed)
    return {
      refreshing: false,
      title: 'Inventory observation is stale',
      body: sentences([
        input.syncFailure,
        'Current data stays visible during refresh.',
      ]),
    };
  return null;
}
