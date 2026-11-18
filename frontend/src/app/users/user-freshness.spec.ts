import { describe, expect, it } from 'vitest';
import { userFreshnessBanner } from './user-freshness';

const base = {
  stale: 0,
  matching: 0,
  refreshing: false,
  jobFailure: '',
  syncFailure: '',
  syncFailed: false,
};

describe('the stale directory banner', () => {
  it('stays absent while the directory is fresh', () => {
    expect(userFreshnessBanner({ ...base, matching: 450 })).toBeNull();
  });

  it('counts the stale users of the result set', () => {
    expect(userFreshnessBanner({ ...base, stale: 3, matching: 450 })).toEqual({
      refreshing: false,
      title: 'Directory observation is stale',
      body: '3 of 450 users were last read from Google more than 24 hours ago. Current data stays visible during refresh.',
    });
  });

  it('names one stale user in the singular', () => {
    const banner = userFreshnessBanner({ ...base, stale: 1, matching: 1 });
    expect(banner?.body).toContain('1 of 1 user was last read');
  });

  it('reports the refresh progress instead of asking for one', () => {
    expect(
      userFreshnessBanner({
        ...base,
        stale: 12,
        matching: 450,
        refreshing: true,
      }),
    ).toEqual({
      refreshing: true,
      title: 'Refreshing 12 of 450 users',
      body: 'Current data stays visible. Rows update as Google answers.',
    });
  });

  it('names the cause of a failed sync when no row is stale yet', () => {
    const banner = userFreshnessBanner({
      ...base,
      matching: 450,
      syncFailed: true,
      syncFailure: 'Google denied user access.',
    });
    expect(banner?.title).toBe('Directory observation is stale');
    expect(banner?.body).toContain('Google denied user access.');
  });
});
