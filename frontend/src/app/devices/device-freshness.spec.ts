import { freshnessBanner } from './device-freshness';

const base = {
  stale: 0,
  matching: 12,
  refreshing: false,
  jobFailure: '',
  syncFailure: '',
  syncFailed: false,
};

it('reports progress while stale devices refresh', () => {
  expect(freshnessBanner({ ...base, stale: 1, refreshing: true })).toEqual({
    refreshing: true,
    title: 'Refreshing 1 of 12 devices',
    body: 'Current data stays visible. Rows update as Google answers.',
  });
});

it('formats large counts and names a single device', () => {
  expect(
    freshnessBanner({ ...base, stale: 1200, matching: 45000, refreshing: true })
      ?.title,
  ).toBe('Refreshing 1,200 of 45,000 devices');
  expect(
    freshnessBanner({ ...base, stale: 1, matching: 1, refreshing: true })
      ?.title,
  ).toBe('Refreshing 1 of 1 device');
});

it('names the last failure when stale devices are not refreshing', () => {
  expect(
    freshnessBanner({
      ...base,
      stale: 3,
      jobFailure: 'Google limited the requests. Refresh again later.',
    }),
  ).toEqual({
    refreshing: false,
    title: 'Inventory observation is stale',
    body: '3 of 12 devices were last read from Google more than 24 hours ago. Google limited the requests. Refresh again later. Current data stays visible during refresh.',
  });
  expect(freshnessBanner({ ...base, stale: 1 })?.body).toContain(
    '1 of 12 devices was last read',
  );
});

it('keeps the failed full sync state when no device is stale', () => {
  expect(
    freshnessBanner({
      ...base,
      syncFailed: true,
      syncFailure: 'The last refresh failed.',
    }),
  ).toEqual({
    refreshing: false,
    title: 'Inventory observation is stale',
    body: 'The last refresh failed. Current data stays visible during refresh.',
  });
});

it('hides the banner when no matching device is stale', () => {
  expect(freshnessBanner(base)).toBeNull();
  expect(freshnessBanner({ ...base, refreshing: true })).toBeNull();
});
