import type {
  JobDetail,
  JobOperation,
  JobProgress,
} from '@campus/application-contracts';
import { describe, expect, it } from 'vitest';
import {
  attentionCount,
  beforeText,
  canReconcile,
  fieldLabel,
  formatTime,
  identityLine,
  jobCounters,
  latestActivityLine,
  operationNumber,
  operationTotal,
  operationsFooter,
  outcomeTone,
  requestedText,
  scopeHeading,
} from './job-detail-fields';

const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'District Admin',
};

const progress = (overrides: Partial<JobProgress> = {}): JobProgress => ({
  total: 6,
  succeeded: 4,
  failed: 1,
  unknown: 1,
  skipped: 0,
  pending: 0,
  ...overrides,
});

const job = (overrides: Partial<JobDetail> = {}): JobDetail => ({
  jobId: '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  displayId: 'UPD-006',
  revision: 4,
  action: 'update-device-annotations',
  status: 'needs-review',
  scope: { kind: 'devices', deviceCount: 6 },
  requestedBy: person,
  createdAt: '2026-10-19T10:31:00.000Z',
  startedAt: '2026-10-19T10:31:00.000Z',
  finishedAt: '2026-10-19T10:36:02.000Z',
  progress: progress(),
  failure: null,
  confirmedBy: person,
  previewDisplayId: 'PV-006',
  field: 'annotatedLocation',
  mode: 'replace',
  requestedValue: 'North lab',
  targetOrgUnitPaths: ['/School A'],
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: '2026-10-19T10:36:00.000Z',
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
  ...overrides,
});

const operation = (overrides: Partial<JobOperation> = {}): JobOperation => ({
  operationId: 'UPD-006-6',
  deviceId: 'synthetic-device-6',
  serialNumber: 'C0A1-7F84',
  orgUnitPath: '/School A',
  operation: 'replace',
  baselineValue: 'Science wing',
  requestedValue: 'North lab',
  outcome: 'unknown',
  outcomeReason: null,
  googleStatus: null,
  googleReason: null,
  observedValue: null,
  verifiedBy: null,
  updatedAt: '2026-10-19T10:36:00.000Z',
  ...overrides,
});

const sampleJob = () =>
  job({
    latestActivity: {
      at: '2026-10-19T10:36:00.000Z',
      failed: {
        count: 1,
        operations: [
          {
            operationId: 'UPD-006-5',
            deviceId: 'synthetic-device-5',
            serialNumber: 'C0A1-7F77',
            outcomeReason: 'permission-denied',
            googleStatus: 403,
            googleReason: 'Forbidden',
            updatedAt: '2026-10-19T10:35:00.000Z',
          },
        ],
      },
      unknown: {
        count: 1,
        operations: [
          {
            operationId: 'UPD-006-6',
            deviceId: 'synthetic-device-6',
            serialNumber: 'C0A1-7F84',
            updatedAt: '2026-10-19T10:36:00.000Z',
          },
        ],
      },
    },
  });

describe('latest activity', () => {
  it('renders the sample line of frames 104:209 and 231:4707', () => {
    const current = sampleJob();
    expect(latestActivityLine(current)).toBe(
      `${formatTime('2026-10-19T10:36:00.000Z')} · Permission failure on C0A1-7F77. C0A1-7F84 requires reconciliation before any retry.`,
    );
  });

  it('uses the newest sample time', () => {
    const current = sampleJob();
    current.latestActivity.failed.operations[0].updatedAt =
      '2026-10-19T10:38:00.000Z';
    expect(latestActivityLine(current)).toContain(
      `${formatTime('2026-10-19T10:38:00.000Z')} · `,
    );
  });

  it('drafts a quota failure without calling it a permission failure', () => {
    const current = sampleJob();
    current.latestActivity.failed.operations[0] = {
      ...current.latestActivity.failed.operations[0],
      outcomeReason: 'quota',
      googleStatus: 403,
    };
    expect(latestActivityLine(current)).toContain(
      'Google quota stopped the update for C0A1-7F77.',
    );
    expect(latestActivityLine(current)).not.toContain('Permission failure');
  });

  it('drafts a not-found failure and an invalid-value rejection', () => {
    const notFound = sampleJob();
    notFound.latestActivity.failed.operations[0] = {
      ...notFound.latestActivity.failed.operations[0],
      outcomeReason: 'not-found',
      googleStatus: 404,
    };
    expect(latestActivityLine(notFound)).toContain(
      'C0A1-7F77 was not found in Google Workspace.',
    );

    const rejected = sampleJob();
    rejected.latestActivity.failed.operations[0] = {
      ...rejected.latestActivity.failed.operations[0],
      outcomeReason: 'invalid',
      googleStatus: 400,
    };
    expect(latestActivityLine(rejected)).toContain(
      'Google rejected the update for C0A1-7F77 (invalid).',
    );
  });

  it('drafts the value-differs, invalid-response, ambiguous, and unknown-reason failures', () => {
    const failure = (outcomeReason: string | null, googleStatus = 500) => {
      const current = sampleJob();
      current.latestActivity.failed.operations[0] = {
        ...current.latestActivity.failed.operations[0],
        outcomeReason,
        googleStatus,
      };
      return latestActivityLine(current);
    };
    expect(failure('value-differs')).toContain(
      'C0A1-7F77 does not hold the requested value.',
    );
    expect(failure('invalid-response')).toContain(
      'Google returned an invalid response for C0A1-7F77.',
    );
    expect(failure('ambiguous')).toContain(
      'The outcome for C0A1-7F77 is uncertain.',
    );
    expect(failure(null)).toContain('The update failed for C0A1-7F77.');
  });

  it('renders the counter line of frame 228:4524', () => {
    const current = job({
      status: 'running',
      progress: progress({
        succeeded: 36,
        failed: 0,
        unknown: 0,
        pending: 12,
        total: 48,
      }),
      scope: { kind: 'devices', deviceCount: 48 },
      latestActivity: {
        at: '2026-10-19T10:42:00.000Z',
        failed: { count: 0, operations: [] },
        unknown: { count: 0, operations: [] },
      },
    });
    expect(latestActivityLine(current)).toBe(
      `${formatTime('2026-10-19T10:42:00.000Z')} · 36 updates confirmed. Twelve operations remain pending.`,
    );
  });

  it('drafts a job without pending operations', () => {
    const current = job({
      status: 'completed',
      progress: progress({
        succeeded: 6,
        failed: 0,
        unknown: 0,
        pending: 0,
      }),
    });
    expect(latestActivityLine(current)).toBe(
      `${formatTime('2026-10-19T10:36:00.000Z')} · 6 updates confirmed. No operations remain pending.`,
    );
  });

  it('drafts the refresh job lines', () => {
    const base = job({
      displayId: 'REF-004',
      action: 'refresh-inventory',
      status: 'running',
      field: null,
      mode: null,
      requestedValue: null,
      progress: progress({
        total: 48,
        succeeded: 36,
        failed: 0,
        unknown: 0,
        pending: 12,
      }),
      latestActivity: {
        at: '2026-10-19T10:42:00.000Z',
        failed: { count: 0, operations: [] },
        unknown: { count: 0, operations: [] },
      },
    });
    const time = formatTime('2026-10-19T10:42:00.000Z');
    expect(latestActivityLine(base)).toBe(
      `${time} · 36 devices read. Twelve devices remain to read.`,
    );
    expect(latestActivityLine({ ...base, status: 'completed' })).toBe(
      `${time} · 36 devices read. The refresh completed.`,
    );
    expect(latestActivityLine({ ...base, status: 'failed' })).toBe(
      `${time} · 36 devices read. The refresh failed.`,
    );
    expect(latestActivityLine({ ...base, status: 'needs-review' })).toBe(
      `${time} · 36 devices read. The refresh needs review.`,
    );
    expect(
      latestActivityLine({
        ...base,
        status: 'completed-with-errors',
        progress: progress({
          total: 36,
          succeeded: 36,
          failed: 0,
          unknown: 0,
          pending: 0,
        }),
      }),
    ).toBe(`${time} · 36 devices read. The refresh completed with errors.`);
  });

  it('keeps the refresh line when failed device counts are nonzero', () => {
    const time = formatTime('2026-10-19T10:42:00.000Z');
    const partial = job({
      displayId: 'REF-004',
      action: 'refresh-inventory',
      status: 'completed-with-errors',
      field: null,
      mode: null,
      requestedValue: null,
      progress: progress({
        total: 12,
        succeeded: 6,
        failed: 6,
        unknown: 0,
        pending: 0,
      }),
      latestActivity: {
        at: '2026-10-19T10:42:00.000Z',
        failed: { count: 6, operations: [] },
        unknown: { count: 0, operations: [] },
      },
    });
    expect(latestActivityLine(partial)).toBe(
      `${time} · 6 devices read. 6 devices could not be read. The refresh completed with errors.`,
    );
    expect(latestActivityLine(partial)).not.toContain('operations failed');
    expect(latestActivityLine({ ...partial, status: 'failed' })).toBe(
      `${time} · 6 devices read. 6 devices could not be read. The refresh failed.`,
    );
    expect(latestActivityLine({ ...partial, status: 'completed' })).toBe(
      `${time} · 6 devices read. 6 devices could not be read. The refresh completed.`,
    );
  });

  it('drafts a running refresh without a known pending count', () => {
    const time = formatTime('2026-10-19T10:42:00.000Z');
    const current = job({
      displayId: 'REF-004',
      action: 'refresh-inventory',
      status: 'running',
      field: null,
      mode: null,
      requestedValue: null,
      progress: progress({
        total: null,
        succeeded: 36,
        failed: 0,
        unknown: 0,
        pending: null,
      }),
      latestActivity: {
        at: '2026-10-19T10:42:00.000Z',
        failed: { count: 0, operations: [] },
        unknown: { count: 0, operations: [] },
      },
    });
    expect(latestActivityLine(current)).toBe(
      `${time} · 36 devices read. The refresh continues.`,
    );
  });

  it('falls back to counters when a count has no sample', () => {
    const current = job({
      progress: progress({ failed: 2, unknown: 1, succeeded: 0, pending: 0 }),
      latestActivity: {
        at: '2026-10-19T10:36:00.000Z',
        failed: { count: 2, operations: [] },
        unknown: { count: 1, operations: [] },
      },
    });
    expect(latestActivityLine(current)).toContain(
      '2 operations failed. 1 operation requires reconciliation before any retry.',
    );
  });
});

describe('job detail fields', () => {
  it('shows the six counters in frame order', () => {
    expect(jobCounters(progress())).toEqual([
      { key: 'succeeded', label: 'Succeeded', value: 4, tone: 'success' },
      { key: 'failed', label: 'Failed', value: 1, tone: 'error' },
      { key: 'unknown', label: 'Unknown', value: 1, tone: 'warning' },
      { key: 'pending', label: 'Pending', value: 0, tone: 'neutral' },
      { key: 'skipped', label: 'Skipped', value: 0, tone: 'neutral' },
      { key: 'cancelled', label: 'Cancelled', value: 0, tone: 'neutral' },
    ]);
  });

  it('keeps a null pending count distinct from zero', () => {
    const counters = jobCounters(
      progress({
        total: null,
        pending: null,
        succeeded: 128,
        failed: 0,
        unknown: 0,
      }),
    );
    expect(counters.find((counter) => counter.key === 'pending')?.value).toBe(
      null,
    );
    expect(operationTotal(job())).toBe(6);
    expect(attentionCount(job())).toBe(2);
  });

  it('renders the identity card of frame 104:209', () => {
    const current = job();
    expect(scopeHeading(current)).toBe('UPD-006 · 6 devices');
    expect(
      identityLine(current, new Date('2026-10-19T12:00:00.000Z')),
    ).toContain('Requested by District Admin');
    expect(
      identityLine(current, new Date('2026-10-19T12:00:00.000Z')),
    ).toContain('Duration: 5m 02s');
  });

  it('renders operation values and tones', () => {
    expect(fieldLabel('annotatedLocation')).toBe('Annotated location');
    expect(fieldLabel(null)).toBe('—');
    expect(beforeText(operation({ baselineValue: null }))).toBe('Not set');
    expect(requestedText(operation({ requestedValue: null }))).toBe(
      'Clear value',
    );
    expect(outcomeTone('succeeded')).toBe('success');
    expect(outcomeTone('failed')).toBe('error');
    expect(outcomeTone('unknown')).toBe('warning');
    expect(outcomeTone('pending')).toBe('neutral');
  });

  it('extracts the operation number from its stable ID', () => {
    expect(operationNumber('UPD-006-12')).toBe('12');
    expect(operationNumber('UPD-1000-1')).toBe('1');
    expect(operationNumber('UPD-006')).toBeNull();
  });

  it('requires jobs:read and devices:write for Reconcile', () => {
    const auth = (actions: string[]) =>
      ({
        metadata: () => ({ phase: 3 }),
        session: () => ({
          identity: {
            grants: actions.map((action) => ({
              action,
              scope: { kind: 'district', customerId: 'C0123456' },
            })),
          },
        }),
      }) as unknown as Parameters<typeof canReconcile>[0];
    expect(canReconcile(auth(['jobs:read', 'devices:write']))).toBe(true);
    expect(canReconcile(auth(['jobs:read']))).toBe(false);
    expect(canReconcile(auth(['devices:write']))).toBe(false);
    expect(canReconcile(auth(['jobs:read', 'devices:read']))).toBe(false);
  });

  it('renders the operations footer of the three frames', () => {
    const current = job();
    expect(
      operationsFooter(current, {
        attention: false,
        pageIndex: 0,
        pageSize: 6,
        shown: 6,
        hasNext: true,
      }),
    ).toBe('Rows 1–6 of 6 operations');
    expect(
      operationsFooter(current, {
        attention: true,
        pageIndex: 0,
        pageSize: 6,
        shown: 2,
        hasNext: false,
      }),
    ).toBe('2 matching operations · 6 total');
    expect(
      operationsFooter(
        job({
          scope: { kind: 'devices', deviceCount: 48 },
          progress: progress({ total: 48 }),
        }),
        {
          attention: true,
          pageIndex: 1,
          pageSize: 6,
          shown: 6,
          hasNext: true,
        },
      ),
    ).toBe('Rows 7–12 matching operations · 48 total');
    expect(
      operationsFooter(
        job({
          scope: { kind: 'devices', deviceCount: 12 },
          progress: progress({ total: 12, failed: 7, unknown: 0 }),
        }),
        {
          attention: true,
          pageIndex: 1,
          pageSize: 6,
          shown: 1,
          hasNext: false,
        },
      ),
    ).toBe('Rows 7–7 matching operations · 12 total');
    expect(
      operationsFooter(current, {
        attention: false,
        pageIndex: 0,
        pageSize: 6,
        shown: 0,
        hasNext: false,
      }),
    ).toBe('0 of 6 operations');
  });
});
