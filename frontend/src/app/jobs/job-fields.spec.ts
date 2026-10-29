import { describe, expect, it } from 'vitest';
import type { JobSummary } from '@campus/application-contracts';
import {
  JOB_ACTIONS,
  actionLabel,
  durationLine,
  formatDuration,
  jobFilterLabel,
  jobFilterQuery,
  progressLines,
  progressPercent,
  recentLine,
  runningLine,
  scopeLabel,
  statusTone,
  validJobId,
  waitingLine,
  type JobFilter,
} from './job-fields';

const summary = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  jobId: '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'UPD-014',
  revision: 1,
  action: 'update-device-annotations',
  status: 'running',
  scope: { kind: 'devices', deviceCount: 48 },
  requestedBy: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    displayName: 'Maya Chen',
  },
  createdAt: '2026-09-05T14:40:00Z',
  startedAt: '2026-09-05T14:40:00Z',
  finishedAt: null,
  progress: {
    total: 48,
    succeeded: 36,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: 12,
  },
  cancelRequest: null,
  failure: null,
  phase: null,
  exportSummary: null,
  importSummary: null,
  ...overrides,
});

describe('progressLines', () => {
  it('follows the running frame row', () => {
    expect(progressLines(summary())).toEqual([
      '36 of 48 complete',
      '12 pending',
    ]);
  });

  it('follows the held frame row', () => {
    expect(progressLines(summary({ status: 'held' }))).toEqual([
      'Waiting to start',
      'Google backoff',
    ]);
  });

  it('follows the queued frame row', () => {
    expect(
      progressLines(
        summary({
          status: 'queued',
          progress: {
            total: 18,
            succeeded: 0,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: 18,
          },
        }),
      ),
    ).toEqual(['0 of 18 complete', 'Waiting for dispatch']);
  });

  it('follows the needs-review frame row', () => {
    expect(
      progressLines(
        summary({
          status: 'needs-review',
          progress: {
            total: 6,
            succeeded: 4,
            failed: 1,
            unknown: 1,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: 0,
          },
        }),
      ),
    ).toEqual(['4 succeeded', '1 failed · 1 unknown']);
  });

  it('follows the completed-with-errors frame row', () => {
    expect(
      progressLines(
        summary({
          status: 'completed-with-errors',
          progress: {
            total: 2,
            succeeded: 1,
            failed: 1,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: 0,
          },
        }),
      ),
    ).toEqual(['1 succeeded', '1 failed']);
  });

  it('follows the completed frame row', () => {
    expect(
      progressLines(
        summary({
          status: 'completed',
          progress: {
            total: 4,
            succeeded: 4,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: 0,
          },
        }),
      ),
    ).toEqual(['4 of 4 complete', 'All updates confirmed']);
  });

  it('drafts the refresh job lines in the frame style', () => {
    expect(
      progressLines(
        summary({
          action: 'refresh-inventory',
          displayId: 'REF-004',
          status: 'running',
          progress: {
            total: null,
            succeeded: 128,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: null,
          },
          cancelRequest: null,
        }),
      ),
    ).toEqual(['128 devices read', 'Refresh in progress']);
    expect(
      progressLines(
        summary({
          action: 'refresh-inventory',
          displayId: 'REF-004',
          status: 'completed',
          progress: {
            total: null,
            succeeded: 128,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: null,
          },
          cancelRequest: null,
        }),
      ),
    ).toEqual(['128 devices read', 'Refresh complete']);
  });
});

describe('durationLine', () => {
  it('shows an elapsed time while the job runs', () => {
    expect(durationLine(summary(), new Date('2026-09-05T14:42:08Z'))).toBe(
      'Elapsed 2m 08s',
    );
  });

  it('shows the final duration of a finished job', () => {
    expect(
      durationLine(
        summary({ finishedAt: '2026-09-05T14:45:02Z' }),
        new Date('2026-09-05T15:00:00Z'),
      ),
    ).toBe('5m 02s');
  });

  it('shows Not started before the job starts', () => {
    expect(durationLine(summary({ status: 'held', startedAt: null }))).toBe(
      'Not started',
    );
  });

  it('formats seconds, minutes, and hours', () => {
    expect(formatDuration('2026-09-05T14:40:00Z', '2026-09-05T14:40:18Z')).toBe(
      '18s',
    );
    expect(formatDuration('2026-09-05T14:40:00Z', '2026-09-05T15:44:30Z')).toBe(
      '1h 04m',
    );
  });
});

it('labels the scope with a thousands separator', () => {
  expect(scopeLabel({ kind: 'devices', deviceCount: 128431 })).toBe(
    '128,431 devices',
  );
  expect(scopeLabel({ kind: 'devices', deviceCount: 1 })).toBe('1 device');
  expect(scopeLabel({ kind: 'all-devices', deviceCount: null })).toBe(
    'All devices',
  );
});

it('lists every job action in the Actions filter', () => {
  expect(JOB_ACTIONS).toEqual([
    'update-device-annotations',
    'refresh-inventory',
    'reboot-devices',
    'wipe-user-data',
    'powerwash-devices',
    'disable-devices',
    'reenable-devices',
    'deprovision-devices',
  ]);
  expect(actionLabel('wipe-user-data')).toBe('Wipe user data');
  expect(actionLabel('powerwash-devices')).toBe('Powerwash devices');
  expect(actionLabel('deprovision-devices')).toBe('Deprovision devices');
});

it('shows a Powerwash job like a command job', () => {
  const job = summary({
    action: 'powerwash-devices',
    status: 'awaiting-devices',
    progress: {
      total: 4,
      succeeded: 0,
      failed: 1,
      unknown: 1,
      skipped: 0,
      expired: 0,
      cancelled: 0,
      pending: 2,
    },
  });
  expect(progressLines(job)).toEqual([
    '0 of 4 complete',
    '2 pending · 1 failed · 1 unknown',
  ]);
});

it('tones each status for its chip', () => {
  expect(statusTone('running')).toBe('info');
  expect(statusTone('held')).toBe('warning');
  expect(statusTone('needs-review')).toBe('warning');
  expect(statusTone('completed')).toBe('success');
  expect(statusTone('completed-with-errors')).toBe('error');
  expect(statusTone('failed')).toBe('error');
  expect(statusTone('queued')).toBe('neutral');
});

describe('jobFilterQuery', () => {
  const filters: JobFilter[] = [
    { field: 'jobId', value: 'UPD-014' },
    { field: 'status', values: ['running', 'needs-review'] },
    {
      field: 'action',
      values: ['update-device-annotations', 'refresh-inventory'],
    },
    { field: 'entityType', values: ['device'] },
    {
      field: 'requestedBy',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      displayName: 'Maya Chen',
    },
    {
      field: 'createdAt',
      from: '2026-09-05T00:00:00.000Z',
      to: '2026-09-06T00:00:00.000Z',
      preset: 'last-7-days',
    },
    {
      field: 'finishedAt',
      from: '2026-09-05T12:00:00.000Z',
      to: null,
    },
  ];

  it('maps all seven filters and the cursor to the server query', () => {
    const params = new URLSearchParams(jobFilterQuery(filters, 'next-page'));
    expect(params.get('jobId')).toBe('UPD-014');
    expect(params.get('status')).toBe('running,needs-review');
    expect(params.get('action')).toBe(
      'update-device-annotations,refresh-inventory',
    );
    expect(params.get('entityType')).toBe('device');
    expect(params.get('requestedBy')).toBe(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    expect(params.get('createdFrom')).toBe('2026-09-05T00:00:00.000Z');
    expect(params.get('createdTo')).toBe('2026-09-06T00:00:00.000Z');
    expect(params.get('finishedFrom')).toBe('2026-09-05T12:00:00.000Z');
    expect(params.get('finishedTo')).toBeNull();
    expect(params.get('cursor')).toBe('next-page');
  });

  it('opens without a filter', () => {
    expect(jobFilterQuery([], null)).toBe('');
  });
});

describe('jobFilterLabel', () => {
  it('names the status list as the filtered frame does', () => {
    expect(
      jobFilterLabel({
        field: 'status',
        values: ['needs-review', 'completed-with-errors'],
      }),
    ).toBe('Status: Needs review, Completed with errors');
  });

  it('names the Last 7 days shortcut', () => {
    expect(
      jobFilterLabel({
        field: 'createdAt',
        from: '2026-09-05T00:00:00.000Z',
        to: '2026-09-06T00:00:00.000Z',
        preset: 'last-7-days',
      }),
    ).toBe('Created: Last 7 days');
  });

  it('names a job ID, actor, and action', () => {
    expect(jobFilterLabel({ field: 'jobId', value: 'UPD-006' })).toBe(
      'Job ID: UPD-006',
    );
    expect(
      jobFilterLabel({
        field: 'requestedBy',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Maya Chen',
      }),
    ).toBe('Requested by: Maya Chen');
    expect(
      jobFilterLabel({
        field: 'action',
        values: ['update-device-annotations'],
      }),
    ).toBe('Action: Update device annotations');
  });
});

it('accepts only the job display IDs of this slice', () => {
  expect(validJobId('UPD-014')).toBe(true);
  expect(validJobId('REF-004')).toBe(true);
  expect(validJobId('JOB-999')).toBe(false);
  expect(validJobId('UPD-14')).toBe(false);
});

describe('activity lines', () => {
  it('names the requester and the progress of a running job', () => {
    expect(runningLine(summary())).toBe('36 of 48 complete · Maya Chen');
  });

  it('never promises a start time for a held job', () => {
    const line = waitingLine(summary({ status: 'held' }));
    expect(line).toBe('Held · Google backoff · Starts when Google allows');
    expect(line).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('names the waiting dispatch of a queued job', () => {
    expect(waitingLine(summary({ status: 'queued' }))).toBe(
      'Queued · Waiting for dispatch',
    );
  });

  it('reads an unknown outcome as needs review, never as success', () => {
    const line = recentLine(
      summary({
        status: 'needs-review',
        finishedAt: '2026-09-05T14:42:00Z',
        progress: {
          total: 6,
          succeeded: 4,
          failed: 1,
          unknown: 1,
          skipped: 0,
          expired: 0,
          cancelled: 0,
          pending: 0,
        },
      }),
    );
    expect(line).toBe('Needs review · 4 succeeded · 1 failed · 1 unknown');
    expect(line).not.toContain('Completed');
  });

  it('counts the devices read by a completed refresh', () => {
    expect(
      recentLine(
        summary({
          action: 'refresh-inventory',
          status: 'completed',
          progress: {
            total: null,
            succeeded: 7000,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: null,
          },
        }),
      ),
    ).toBe('Completed · 7,000 devices read');
  });

  it('has a determinate share only when the job has a total', () => {
    expect(progressPercent(summary())).toBe(75);
    expect(
      progressPercent(
        summary({
          progress: {
            total: null,
            succeeded: 3200,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: null,
          },
        }),
      ),
    ).toBeNull();
  });
});

describe('cancelled jobs', () => {
  it('renders the cancelled progress cells of state 07', () => {
    expect(
      progressLines(
        summary({
          displayId: 'UPD-001',
          status: 'cancelled',
          progress: {
            total: 48,
            succeeded: 38,
            failed: 1,
            unknown: 1,
            skipped: 0,
            expired: 0,
            cancelled: 8,
            pending: 0,
          },
        }),
      ),
    ).toEqual(['38 succeeded', '1 failed · 1 unknown · 8 cancelled']);

    expect(
      progressLines(
        summary({
          displayId: 'STS-001',
          action: 'disable-devices',
          status: 'cancelled',
          scope: { kind: 'devices', deviceCount: 18 },
          progress: {
            total: 18,
            succeeded: 0,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 18,
            pending: 0,
          },
        }),
      ),
    ).toEqual(['0 succeeded', '18 cancelled']);
  });

  it('lists a cancelled job with the finished jobs in Activity', () => {
    expect(
      recentLine(
        summary({
          status: 'cancelled',
          progress: {
            total: 48,
            succeeded: 38,
            failed: 1,
            unknown: 1,
            skipped: 0,
            expired: 0,
            cancelled: 8,
            pending: 0,
          },
        }),
      ),
    ).toBe('Cancelled · 38 succeeded · 1 failed · 1 unknown · 8 cancelled');
  });

  it('renders a cancelled refresh row', () => {
    expect(
      progressLines(
        summary({
          displayId: 'REF-001',
          action: 'refresh-inventory',
          status: 'cancelled',
          scope: { kind: 'all-devices', deviceCount: null },
          progress: {
            total: null,
            succeeded: 600,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: null,
          },
        }),
      ),
    ).toEqual(['600 devices read · none saved', 'Refresh cancelled']);
  });

  it('keeps the built refresh row when the refresh saved its devices', () => {
    expect(
      progressLines(
        summary({
          displayId: 'REF-002',
          action: 'refresh-inventory',
          status: 'cancelled',
          scope: { kind: 'devices', deviceCount: 1000 },
          progress: {
            total: 1000,
            succeeded: 250,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 750,
            pending: 0,
          },
        }),
      ),
    ).toEqual(['250 devices read', '750 cancelled']);
  });

  it('keeps one device singular in the saved-none line', () => {
    expect(
      progressLines(
        summary({
          displayId: 'REF-005',
          action: 'refresh-inventory',
          status: 'cancelled',
          scope: { kind: 'all-devices', deviceCount: null },
          progress: {
            total: null,
            succeeded: 1,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: null,
          },
        }),
      ),
    ).toEqual(['1 device read · none saved', 'Refresh cancelled']);
  });
});
