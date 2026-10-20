import { describe, expect, it } from 'vitest';
import type { JobSummary } from '@campus/application-contracts';
import {
  durationLine,
  formatDuration,
  jobFilterLabel,
  jobFilterQuery,
  progressLines,
  scopeLabel,
  statusTone,
  validJobId,
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
    pending: 12,
  },
  failure: null,
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
            pending: null,
          },
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
            pending: null,
          },
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
