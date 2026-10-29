import type {
  JobDetail,
  JobFailedActivityOperation,
  JobOperation,
  JobProgress,
} from '@campus/application-contracts';
import { describe, expect, it } from 'vitest';
import { formatTimestamp } from './job-fields';
import {
  attentionCount,
  beforeText,
  canCancel,
  canReconcile,
  cancelActivitySentence,
  cancelBanner,
  cancelLine,
  cancelQuestion,
  cancelState,
  fieldLabel,
  formatTime,
  identityLine,
  isCommandOperation,
  isCommandJob,
  jobCounters,
  latestActivityLine,
  operationChip,
  operationLabel,
  operationNumber,
  operationTotal,
  operationsFooter,
  observedText,
  outcomeNotes,
  outcomeTone,
  pathParts,
  reasonLine,
  requestedText,
  rowFailureText,
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
  expired: 0,
  cancelled: 0,
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
  cancelRequest: null,
  confirmedBy: person,
  previewDisplayId: 'PV-006',
  changes: [
    { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
  ],
  commandType: null,
  statusAction: null,
  deprovisionReason: null,
  targetOrgUnitPaths: ['/School A'],
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: '2026-10-19T10:36:00.000Z',
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
  phase: null,
  exportSummary: null,
  importSummary: null,
  exportFile: null,
  importSource: null,
  plan: null,
  importDisplayId: null,
  waitsForDisplayId: null,
  waitingDisplayIds: null,
  planJobs: null,
  executionCounts: null,
  ...overrides,
});

const operation = (overrides: Partial<JobOperation> = {}): JobOperation => ({
  operationId: 'UPD-006-6',
  deviceId: 'synthetic-device-6',
  serialNumber: 'C0A1-7F84',
  orgUnitPath: '/School A',
  field: 'annotatedLocation',
  operation: 'replace',
  baselineValue: 'Science wing',
  requestedValue: 'North lab',
  outcome: 'unknown',
  outcomeReason: null,
  googleStatus: null,
  googleReason: null,
  observedValue: null,
  verifiedBy: null,
  commandId: null,
  commandState: null,
  commandExpiresAt: null,
  commandExecutedAt: null,
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
    phase: null,
    exportSummary: null,
    importSummary: null,
    exportFile: null,
    importSource: null,
    plan: null,
    importDisplayId: null,
    waitsForDisplayId: null,
    waitingDisplayIds: null,
    planJobs: null,
    executionCounts: null,
  });

/**
 * A command job whose Latest activity carries one failed sample. No pending
 * operation remains, so the line holds the sample sentence alone.
 */
const commandJobWithFailure = (
  failure: JobFailedActivityOperation,
): JobDetail =>
  job({
    displayId: 'CMD-001',
    action: 'reboot-devices',
    status: 'awaiting-devices',
    changes: null,
    commandType: 'REBOOT',
    progress: progress({
      total: 1,
      succeeded: 0,
      failed: 1,
      unknown: 0,
      expired: 0,
      pending: 0,
    }),
    latestActivity: {
      at: '2026-10-20T19:08:00.000Z',
      failed: { count: 1, operations: [failure] },
      unknown: { count: 0, operations: [] },
    },
    phase: null,
    exportSummary: null,
    importSummary: null,
    exportFile: null,
    importSource: null,
    plan: null,
    importDisplayId: null,
    waitsForDisplayId: null,
    waitingDisplayIds: null,
    planJobs: null,
    executionCounts: null,
  });

const commandFailure = (
  overrides: Partial<JobFailedActivityOperation> = {},
): JobFailedActivityOperation => ({
  operationId: 'CMD-001-2',
  deviceId: 'synthetic-device-2',
  serialNumber: 'SYN-02',
  outcomeReason: 'command-failed',
  googleStatus: null,
  googleReason: 'The device failed to execute the command.',
  updatedAt: '2026-10-20T19:08:00.000Z',
  ...overrides,
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
      phase: null,
      exportSummary: null,
      importSummary: null,
      exportFile: null,
      importSource: null,
      plan: null,
      importDisplayId: null,
      waitsForDisplayId: null,
      waitingDisplayIds: null,
      planJobs: null,
      executionCounts: null,
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
      changes: null,
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
      phase: null,
      exportSummary: null,
      importSummary: null,
      exportFile: null,
      importSource: null,
      plan: null,
      importDisplayId: null,
      waitsForDisplayId: null,
      waitingDisplayIds: null,
      planJobs: null,
      executionCounts: null,
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
      changes: null,
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
      phase: null,
      exportSummary: null,
      importSummary: null,
      exportFile: null,
      importSource: null,
      plan: null,
      importDisplayId: null,
      waitsForDisplayId: null,
      waitingDisplayIds: null,
      planJobs: null,
      executionCounts: null,
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
      changes: null,
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
      phase: null,
      exportSummary: null,
      importSummary: null,
      exportFile: null,
      importSource: null,
      plan: null,
      importDisplayId: null,
      waitsForDisplayId: null,
      waitingDisplayIds: null,
      planJobs: null,
      executionCounts: null,
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
      phase: null,
      exportSummary: null,
      importSummary: null,
      exportFile: null,
      importSource: null,
      plan: null,
      importDisplayId: null,
      waitsForDisplayId: null,
      waitingDisplayIds: null,
      planJobs: null,
      executionCounts: null,
    });
    expect(latestActivityLine(current)).toContain(
      '2 operations failed. 1 operation requires reconciliation before any retry.',
    );
  });

  it('names each device once when several field rows carry a sample', () => {
    // One PATCH covers every field of a device, so a sample repeats per field row. The line names
    // the device once (mockup note 23).
    const at = '2026-10-21T19:06:00.000Z';
    const failedRow = (field: string) => ({
      operationId: `UPD-006-5-${field}`,
      deviceId: 'synthetic-device-5',
      serialNumber: '01P0T1V',
      outcomeReason: 'value-differs',
      googleStatus: 200,
      googleReason: null,
      updatedAt: '2026-10-21T19:05:00.000Z',
    });
    const unknownRow = (field: string) => ({
      operationId: `UPD-006-6-${field}`,
      deviceId: 'synthetic-device-6',
      serialNumber: '02QJANY',
      updatedAt: at,
    });
    const current = job({
      latestActivity: {
        at,
        failed: {
          count: 1,
          operations: [
            failedRow('annotatedLocation'),
            failedRow('notes'),
            failedRow('orgUnitPath'),
          ],
        },
        unknown: {
          count: 1,
          operations: [
            unknownRow('annotatedLocation'),
            unknownRow('notes'),
            unknownRow('orgUnitPath'),
          ],
        },
      },
      phase: null,
      exportSummary: null,
      importSummary: null,
      exportFile: null,
      importSource: null,
      plan: null,
      importDisplayId: null,
      waitsForDisplayId: null,
      waitingDisplayIds: null,
      planJobs: null,
      executionCounts: null,
    });
    const line = latestActivityLine(current);
    expect(line.match(/01P0T1V/g)).toHaveLength(1);
    expect(line.match(/02QJANY/g)).toHaveLength(1);
    expect(line).toBe(
      `${formatTime(at)} · 01P0T1V does not hold the requested value. 02QJANY requires reconciliation before any retry.`,
    );
  });

  it('drafts the command line of the step 5 mockup', () => {
    const current = job({
      displayId: 'CMD-001',
      action: 'reboot-devices',
      status: 'awaiting-devices',
      changes: null,
      commandType: 'REBOOT',
      progress: progress({
        total: 6,
        succeeded: 1,
        failed: 1,
        unknown: 1,
        expired: 1,
        pending: 2,
      }),
      latestActivity: {
        at: '2026-10-20T19:08:00.000Z',
        failed: {
          count: 1,
          operations: [
            {
              operationId: 'CMD-001-2',
              deviceId: 'synthetic-device-2',
              serialNumber: '02A1MB6',
              outcomeReason: 'command-failed',
              googleStatus: null,
              googleReason: 'The device failed to execute the command.',
              updatedAt: '2026-10-20T19:08:00.000Z',
            },
          ],
        },
        unknown: {
          count: 1,
          operations: [
            {
              operationId: 'CMD-001-6',
              deviceId: 'synthetic-device-6',
              serialNumber: '08V5B5S',
              updatedAt: '2026-10-20T19:08:00.000Z',
            },
          ],
        },
      },
      phase: null,
      exportSummary: null,
      importSummary: null,
      exportFile: null,
      importSource: null,
      plan: null,
      importDisplayId: null,
      waitsForDisplayId: null,
      waitingDisplayIds: null,
      planJobs: null,
      executionCounts: null,
    });
    const line = latestActivityLine(current);
    expect(line).toBe(
      `${formatTime('2026-10-20T19:08:00.000Z')} · 1 Reboot command expired before execution. 02A1MB6 reported an execution failure. The outcome for 08V5B5S is uncertain. 2 commands wait for device execution.`,
    );
    expect(line).not.toContain('reconciliation');
  });

  it('keeps execution-failure wording for a command-failed result', () => {
    const line = latestActivityLine(commandJobWithFailure(commandFailure()));
    expect(line).toBe(
      `${formatTime('2026-10-20T19:08:00.000Z')} · SYN-02 reported an execution failure.`,
    );
  });

  it('names a Powerwash command and its cancellation in the activity line', () => {
    const current = job({
      displayId: 'CMD-008',
      action: 'powerwash-devices',
      status: 'needs-review',
      changes: null,
      commandType: 'REMOTE_POWERWASH',
      progress: progress({
        total: 4,
        succeeded: 0,
        failed: 2,
        unknown: 1,
        expired: 1,
        pending: 0,
      }),
      latestActivity: {
        at: '2026-10-22T14:40:00.000Z',
        failed: {
          count: 2,
          operations: [
            {
              operationId: 'CMD-008-2',
              deviceId: 'synthetic-device-2',
              serialNumber: '02A1MB6',
              outcomeReason: 'command-failed',
              googleStatus: null,
              googleReason: 'The device failed to execute the command.',
              updatedAt: '2026-10-22T14:40:00.000Z',
            },
            {
              operationId: 'CMD-008-3',
              deviceId: 'synthetic-device-3',
              serialNumber: '02QJANY',
              outcomeReason: 'command-cancelled',
              googleStatus: 200,
              googleReason: null,
              updatedAt: '2026-10-22T14:39:00.000Z',
            },
          ],
        },
        unknown: {
          count: 1,
          operations: [
            {
              operationId: 'CMD-008-4',
              deviceId: 'synthetic-device-4',
              serialNumber: '04XTBHJ',
              updatedAt: '2026-10-22T14:38:00.000Z',
            },
          ],
        },
      },
      phase: null,
      exportSummary: null,
      importSummary: null,
      exportFile: null,
      importSource: null,
      plan: null,
      importDisplayId: null,
      waitsForDisplayId: null,
      waitingDisplayIds: null,
      planJobs: null,
      executionCounts: null,
    });
    const line = latestActivityLine(current);
    expect(line).toBe(
      `${formatTime('2026-10-22T14:40:00.000Z')} · 1 Powerwash command expired before execution. 02A1MB6 reported an execution failure. Google cancelled the command for 02QJANY. The outcome for 04XTBHJ is uncertain.`,
    );
    expect(line).not.toContain('reconciliation');
  });

  it('names a Deprovision status change in the activity line', () => {
    const current = job({
      displayId: 'STS-003',
      action: 'deprovision-devices',
      statusAction: 'deprovision',
      status: 'completed-with-errors',
      changes: null,
      deprovisionReason: 'DEPROVISION_REASON_RETIRING_DEVICE',
      progress: progress({
        total: 5,
        succeeded: 4,
        failed: 1,
        unknown: 0,
        expired: 0,
        pending: 0,
      }),
      latestActivity: {
        at: '2026-10-22T14:16:00.000Z',
        failed: {
          count: 1,
          operations: [
            {
              operationId: 'STS-003-5',
              deviceId: 'synthetic-device-5',
              serialNumber: '04XTBHJ',
              outcomeReason: 'status-conflict',
              googleStatus: null,
              googleReason:
                'A device with status DEPROVISIONED does not allow this action.',
              updatedAt: '2026-10-22T14:16:00.000Z',
            },
          ],
        },
        unknown: { count: 0, operations: [] },
      },
      phase: null,
      exportSummary: null,
      importSummary: null,
      exportFile: null,
      importSource: null,
      plan: null,
      importDisplayId: null,
      waitsForDisplayId: null,
      waitingDisplayIds: null,
      planJobs: null,
      executionCounts: null,
    });
    expect(latestActivityLine(current)).toBe(
      `${formatTime('2026-10-22T14:16:00.000Z')} · Google rejected the status change for 04XTBHJ (status-conflict).`,
    );
  });

  it('names a refused command issue without claiming device execution', () => {
    const line = (outcomeReason: string | null, googleStatus: number | null) =>
      latestActivityLine(
        commandJobWithFailure(commandFailure({ outcomeReason, googleStatus })),
      );

    // An issue refusal never reached a device, so it is not an execution failure.
    const quota = line('quota', 429);
    expect(quota).toContain('Google quota stopped the command for SYN-02.');
    expect(quota).not.toContain('execution failure');
    expect(line('permission-denied', 403)).toContain(
      'Permission failure on SYN-02.',
    );
    expect(line('not-found', 404)).toContain(
      'SYN-02 was not found in Google Workspace.',
    );
    expect(line('rejected', 400)).toContain(
      'Google rejected the command for SYN-02 (rejected).',
    );
    expect(line(null, null)).toContain('The command failed for SYN-02.');
  });

  it('names a status change in the write counter line', () => {
    const current = job({
      displayId: 'STS-002',
      action: 'disable-devices',
      statusAction: 'disable',
      changes: null,
      status: 'completed',
      progress: progress({
        total: 6,
        succeeded: 6,
        failed: 0,
        unknown: 0,
        pending: 0,
      }),
      latestActivity: {
        at: '2026-10-20T19:08:00.000Z',
        failed: { count: 0, operations: [] },
        unknown: { count: 0, operations: [] },
      },
      phase: null,
      exportSummary: null,
      importSummary: null,
      exportFile: null,
      importSource: null,
      plan: null,
      importDisplayId: null,
      waitsForDisplayId: null,
      waitingDisplayIds: null,
      planJobs: null,
      executionCounts: null,
    });
    expect(latestActivityLine(current)).toBe(
      `${formatTime('2026-10-20T19:08:00.000Z')} · 6 status changes confirmed. No operations remain pending.`,
    );
  });
});

describe('job detail fields', () => {
  it('shows the counters in the command job order', () => {
    expect(jobCounters(job())).toEqual([
      { key: 'succeeded', label: 'Succeeded', value: 4, tone: 'success' },
      { key: 'failed', label: 'Failed', value: 1, tone: 'error' },
      { key: 'unknown', label: 'Unknown', value: 1, tone: 'warning' },
      { key: 'expired', label: 'Expired', value: 0, tone: 'warning' },
      { key: 'pending', label: 'Pending', value: 0, tone: 'neutral' },
      { key: 'skipped', label: 'Skipped', value: 0, tone: 'neutral' },
      { key: 'cancelled', label: 'Cancelled', value: 0, tone: 'neutral' },
    ]);
  });
  it('counts expired operations beside failed and unknown', () => {
    const counters = jobCounters(job({ progress: progress({ expired: 2 }) }));
    expect(counters.find((counter) => counter.key === 'expired')?.value).toBe(
      2,
    );
  });

  it('keeps a null pending count distinct from zero', () => {
    const counters = jobCounters(
      job({
        progress: progress({
          total: null,
          pending: null,
          succeeded: 128,
          failed: 0,
          unknown: 0,
        }),
      }),
    );
    expect(counters.find((counter) => counter.key === 'pending')?.value).toBe(
      null,
    );
    expect(operationTotal(job())).toBe(6);
    expect(attentionCount(job())).toBe(2);
    expect(attentionCount(job({ progress: progress({ expired: 1 }) }))).toBe(3);
  });

  it('names the saved-none count of a cancelled Refresh all', () => {
    const cancelledRefresh = job({
      displayId: 'REF-001',
      action: 'refresh-inventory',
      status: 'cancelled',
      scope: { kind: 'all-devices', deviceCount: null },
      progress: progress({
        total: null,
        succeeded: 600,
        failed: 0,
        unknown: 0,
        pending: null,
      }),
    });
    expect(
      jobCounters(cancelledRefresh).find(
        (counter) => counter.key === 'succeeded',
      ),
    ).toEqual({
      key: 'succeeded',
      label: 'Read · none saved',
      value: 600,
      tone: 'success',
    });
  });

  it('keeps the built Succeeded label when the refresh saved its devices', () => {
    const selected = job({
      displayId: 'REF-002',
      action: 'refresh-inventory',
      status: 'cancelled',
      scope: { kind: 'devices', deviceCount: 1000 },
      progress: progress({
        total: 1000,
        succeeded: 250,
        failed: 0,
        unknown: 0,
        pending: 0,
        cancelled: 750,
      }),
    });
    const completedAll = job({
      displayId: 'REF-004',
      action: 'refresh-inventory',
      status: 'completed',
      scope: { kind: 'all-devices', deviceCount: null },
      progress: progress({
        total: null,
        succeeded: 128,
        failed: 0,
        unknown: 0,
        pending: null,
      }),
    });
    const succeededLabel = (candidate: JobDetail) =>
      jobCounters(candidate).find((counter) => counter.key === 'succeeded')
        ?.label;
    expect(succeededLabel(selected)).toBe('Succeeded');
    expect(succeededLabel(completedAll)).toBe('Succeeded');
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
    expect(outcomeTone('expired')).toBe('warning');
    expect(outcomeTone('pending')).toBe('neutral');
  });

  it('labels every writable field and a row without one', () => {
    expect(fieldLabel('annotatedLocation')).toBe('Annotated location');
    expect(fieldLabel('annotatedAssetId')).toBe('Asset tag');
    expect(fieldLabel('annotatedUser')).toBe('Annotated user');
    expect(fieldLabel('notes')).toBe('Notes');
    expect(fieldLabel('orgUnitPath')).toBe('Organization unit');
    expect(fieldLabel(null)).toBe('—');
  });

  it('names the observed value only when it differs from the requested value', () => {
    // A read-back can settle `value-differs` with a third value (IF5, B1).
    const divergent = operation({
      operationId: 'UPD-008-2-annotatedAssetId',
      field: 'annotatedAssetId',
      operation: 'replace',
      baselineValue: 'tag-before',
      requestedValue: 'tag-requested',
      observedValue: 'tag-observed',
      outcome: 'failed',
      outcomeReason: 'value-differs',
      googleStatus: 200,
      googleReason: null,
      verifiedBy: 'read-back',
    });
    expect(observedText(divergent)).toBe('tag-observed');

    // The requested cell already states an equal observed value, so the row adds no line.
    expect(observedText(operation({ observedValue: 'North lab' }))).toBeNull();
    expect(observedText(operation({ observedValue: null }))).toBeNull();

    // A command row holds no field value.
    expect(
      observedText(
        operation({
          field: null,
          operation: 'reboot',
          baselineValue: null,
          requestedValue: null,
          observedValue: 'REBOOT',
        }),
      ),
    ).toBeNull();

    // A status row names its stored status, and repeats nothing when the status did change.
    const disable = {
      field: null,
      operation: 'disable' as const,
      baselineValue: 'ACTIVE',
      requestedValue: 'DISABLED',
    };
    expect(
      observedText(operation({ ...disable, observedValue: 'ACTIVE' })),
    ).toBe('Active');
    expect(
      observedText(operation({ ...disable, observedValue: 'DISABLED' })),
    ).toBeNull();

    // A failed Clear keeps a value, and the row names it.
    expect(
      observedText(
        operation({
          operation: 'clear',
          baselineValue: 'Science wing',
          requestedValue: null,
          observedValue: 'Science wing',
        }),
      ),
    ).toBe('Science wing');

    // A Clear request displays the label "Clear value", and that label is also valid
    // field content. Equality uses the stored request, so a real observation still shows.
    expect(
      observedText(
        operation({
          operation: 'clear',
          baselineValue: 'notes-before',
          requestedValue: null,
          observedValue: 'Clear value',
        }),
      ),
    ).toBe('Clear value');

    // A request that literally reads "Clear value" adds no line when the read-back repeats it.
    expect(
      observedText(
        operation({
          operation: 'replace',
          baselineValue: null,
          requestedValue: 'Clear value',
          observedValue: 'Clear value',
        }),
      ),
    ).toBeNull();
  });

  it('names an Asset tag row under the Operation cell', () => {
    // The addendum adds annotatedAssetId, and a row names the field label (IF5).
    const assetTag = operation({
      operationId: 'UPD-008-1-annotatedAssetId',
      field: 'annotatedAssetId',
      operation: 'replace',
      baselineValue: null,
      requestedValue: 'CB415508',
    });
    expect(operationLabel(assetTag)).toBe('Asset tag');
    expect(beforeText(assetTag)).toBe('Not set');
    expect(requestedText(assetTag)).toBe('CB415508');
  });

  it('names Organization unit and shows both paths of a Move row', () => {
    const move = operation({
      operationId: 'UPD-006-3-orgUnitPath',
      field: 'orgUnitPath',
      operation: 'move',
      baselineValue: '/Chrome Devices/Lowell Academy/One to One',
      requestedValue:
        '/Chrome Devices/Pine Valley Elementary School/Cart Devices',
      outcome: 'succeeded',
      observedValue:
        '/Chrome Devices/Pine Valley Elementary School/Cart Devices',
    });
    expect(operationLabel(move)).toBe('Organization unit');
    expect(beforeText(move)).toBe('/Chrome Devices/Lowell Academy/One to One');
    expect(requestedText(move)).toBe(
      '/Chrome Devices/Pine Valley Elementary School/Cart Devices',
    );
  });

  it('breaks an OU path after each slash', () => {
    expect(pathParts('/Chrome Devices/Lowell Academy/One to One')).toEqual([
      '/Chrome Devices/',
      'Lowell Academy/',
      'One to One',
    ]);
    expect(pathParts('/Chrome Devices/')).toEqual(['/Chrome Devices/']);
    expect(pathParts('Pine Valley cart 6')).toEqual(['Pine Valley cart 6']);
  });

  it('shows the app failure sentence under a failed update row', () => {
    const update = job({
      changes: [
        { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
      ],
    });
    // A read-back failure carries no Google reason, so the update row names the app outcome.
    expect(
      rowFailureText(
        update,
        operation({
          outcome: 'failed',
          outcomeReason: 'value-differs',
          googleStatus: 200,
          googleReason: 'Google text',
        }),
      ),
    ).toBe('C0A1-7F84 does not hold the requested value.');
    expect(rowFailureText(update, operation())).toBeNull();
    // A command and a status job keep the step 5 line.
    const command = job({
      action: 'reboot-devices',
      changes: null,
      commandType: 'REBOOT',
    });
    expect(
      rowFailureText(
        command,
        operation({
          field: null,
          operation: 'reboot',
          outcome: 'failed',
          outcomeReason: 'command-failed',
          googleReason: 'The device failed to execute the command.',
        }),
      ),
    ).toBe('The device failed to execute the command.');
    const status = job({
      action: 'disable-devices',
      statusAction: 'disable',
      changes: null,
    });
    expect(
      rowFailureText(
        status,
        operation({
          field: null,
          operation: 'disable',
          outcome: 'failed',
          outcomeReason: 'status-conflict',
          googleReason: 'The device status does not match.',
        }),
      ),
    ).toBe('The device status does not match.');
  });

  it('labels a command row and hides its baseline', () => {
    const reboot = operation({
      field: null,
      operation: 'reboot',
      requestedValue: null,
    });
    expect(operationLabel(reboot)).toBe('Reboot');
    expect(beforeText(reboot)).toBe('—');
    expect(requestedText(reboot)).toBe('Reboot');
    expect(isCommandOperation(reboot)).toBe(true);
    expect(
      isCommandOperation(operation({ field: null, operation: 'disable' })),
    ).toBe(false);
  });

  it('labels the Wipe user data and Powerwash command rows', () => {
    const wipe = operation({
      field: null,
      operation: 'wipe-users',
      requestedValue: null,
    });
    expect(operationLabel(wipe)).toBe('Wipe user data');
    expect(beforeText(wipe)).toBe('—');
    expect(requestedText(wipe)).toBe('Wipe user data');
    expect(isCommandOperation(wipe)).toBe(true);

    const powerwash = operation({
      field: null,
      operation: 'powerwash',
      requestedValue: null,
    });
    expect(operationLabel(powerwash)).toBe('Powerwash');
    expect(beforeText(powerwash)).toBe('—');
    expect(requestedText(powerwash)).toBe('Powerwash');
    expect(isCommandOperation(powerwash)).toBe(true);

    // A command job never offers Reconcile (record D13).
    expect(isCommandJob({ action: 'reboot-devices' })).toBe(true);
    expect(isCommandJob({ action: 'wipe-user-data' })).toBe(true);
    expect(isCommandJob({ action: 'powerwash-devices' })).toBe(true);
    expect(isCommandJob({ action: 'deprovision-devices' })).toBe(false);
  });

  it('labels a Deprovision row with its observed and requested status', () => {
    const active = operation({
      operationId: 'STS-003-1',
      field: null,
      operation: 'deprovision',
      baselineValue: 'ACTIVE',
      requestedValue: 'DEPROVISIONED',
    });
    expect(operationLabel(active)).toBe('Deprovision');
    expect(beforeText(active)).toBe('Active');
    expect(requestedText(active)).toBe('Deprovisioned');
    expect(isCommandOperation(active)).toBe(false);

    const disabled = operation({
      operationId: 'STS-003-2',
      field: null,
      operation: 'deprovision',
      baselineValue: 'DISABLED',
      requestedValue: 'DEPROVISIONED',
    });
    expect(beforeText(disabled)).toBe('Disabled');
  });

  it('keeps Google expiry under a waiting or unknown command', () => {
    const now = new Date('2026-10-22T14:11:00.000Z');
    const powerwash = { action: 'powerwash-devices' as const };
    const expires = `Expires ${formatTimestamp(
      '2031-10-22T14:11:00.000Z',
      now,
    )}`;
    const acknowledged = operation({
      field: null,
      operation: 'powerwash',
      outcome: 'pending',
      commandState: 'acknowledged',
      commandExpiresAt: '2031-10-22T14:11:00.000Z',
    });
    expect(outcomeNotes(powerwash, acknowledged, now)).toEqual([expires]);

    const missed = operation({
      field: null,
      operation: 'powerwash',
      outcome: 'unknown',
      outcomeReason: 'not-observed',
      commandExpiresAt: '2031-10-22T14:11:00.000Z',
    });
    expect(outcomeNotes(powerwash, missed, now)).toEqual([
      'No result in 30 days',
      expires,
    ]);

    // Reboot keeps the first build's window, so it names no 30-day window.
    const rebootMissed = operation({
      field: null,
      operation: 'reboot',
      outcome: 'unknown',
      outcomeReason: 'not-observed',
      commandExpiresAt: '2031-10-22T14:11:00.000Z',
    });
    expect(
      outcomeNotes({ action: 'reboot-devices' }, rebootMissed, now),
    ).toEqual([expires]);

    const cancelled = operation({
      field: null,
      operation: 'powerwash',
      outcome: 'failed',
      outcomeReason: 'command-cancelled',
      commandExpiresAt: '2031-10-22T14:11:00.000Z',
    });
    expect(outcomeNotes(powerwash, cancelled, now)).toEqual([]);

    // A status row carries no command note.
    expect(
      outcomeNotes(
        { action: 'deprovision-devices' },
        operation({
          field: null,
          operation: 'deprovision',
          outcome: 'unknown',
        }),
        now,
      ),
    ).toEqual([]);
  });

  it('names the update failure for an edit-list job without shared changes', () => {
    // An edit-list job answers `changes: null`, and its rows still hold the requested and
    // observed values per device and field. The row names the app outcome (IF5).
    const editList = job({ changes: null });
    expect(
      rowFailureText(
        editList,
        operation({
          outcome: 'failed',
          outcomeReason: 'value-differs',
          googleStatus: 200,
          googleReason: 'Google text',
        }),
      ),
    ).toBe('C0A1-7F84 does not hold the requested value.');
  });

  it('names a cancelled command under its failed row', () => {
    const cancelled = operation({
      field: null,
      operation: 'powerwash',
      outcome: 'failed',
      outcomeReason: 'command-cancelled',
      googleReason: null,
    });
    expect(rowFailureText({ action: 'powerwash-devices' }, cancelled)).toBe(
      'Google cancelled the command.',
    );
  });

  it('names the Deprovision reason on the identity card', () => {
    expect(
      reasonLine({ deprovisionReason: 'DEPROVISION_REASON_RETIRING_DEVICE' }),
    ).toBe('Deprovision reason: Retiring from fleet');
    expect(reasonLine({ deprovisionReason: null })).toBeNull();
  });

  it('labels a status row with its baseline and requested status', () => {
    const disable = operation({
      operationId: 'STS-002-1',
      field: null,
      operation: 'disable',
      baselineValue: 'ACTIVE',
      requestedValue: 'DISABLED',
    });
    expect(operationLabel(disable)).toBe('Disable');
    expect(beforeText(disable)).toBe('Active');
    expect(requestedText(disable)).toBe('Disabled');

    const reenable = operation({
      field: null,
      operation: 'reenable',
      baselineValue: 'DISABLED',
      requestedValue: 'ACTIVE',
    });
    expect(operationLabel(reenable)).toBe('Re-enable');
    expect(beforeText(reenable)).toBe('Disabled');
    expect(requestedText(reenable)).toBe('Active');
  });

  it('gives every command state its chip', () => {
    const pending = (commandState: JobOperation['commandState']) =>
      operation({ outcome: 'pending', commandState });
    expect(operationChip(pending('pending-delivery'))).toEqual({
      label: 'Pending delivery',
      tone: 'neutral',
    });
    expect(operationChip(pending('sent'))).toEqual({
      label: 'Sent',
      tone: 'neutral',
    });
    expect(operationChip(pending('acknowledged'))).toEqual({
      label: 'Acknowledged',
      tone: 'info',
    });
    expect(operationChip(pending(null))).toEqual({
      label: 'Pending',
      tone: 'neutral',
    });
    expect(operationChip(operation({ outcome: 'succeeded' }))).toEqual({
      label: 'Succeeded',
      tone: 'success',
    });
    expect(operationChip(operation({ outcome: 'expired' }))).toEqual({
      label: 'Expired',
      tone: 'warning',
    });
    expect(operationChip(operation({ outcome: 'unknown' }))).toEqual({
      label: 'Unknown',
      tone: 'warning',
    });
  });

  it('extracts the operation number from an update or status ID', () => {
    expect(operationNumber('UPD-006-12')).toBe('12');
    expect(operationNumber('UPD-1000-1')).toBe('1');
    expect(operationNumber('STS-002-3')).toBe('3');
    expect(operationNumber('STS-1000-12')).toBe('12');
    // An update row names its field, and the field never changes the number (addendum section 1).
    expect(operationNumber('UPD-006-12-annotatedLocation')).toBe('12');
    expect(operationNumber('UPD-006-1-annotatedUser')).toBe('1');
    expect(operationNumber('UPD-006-2-notes')).toBe('2');
    expect(operationNumber('UPD-006-3-orgUnitPath')).toBe('3');
    // Commands offer no reconciliation (record default 4), so their IDs stay invalid.
    expect(operationNumber('CMD-001-2')).toBeNull();
    expect(operationNumber('UPD-006')).toBeNull();
    expect(operationNumber('UPD-006-1status')).toBeNull();
    expect(operationNumber('XPD-006-1')).toBeNull();
  });

  it('requires jobs:read and the permission of the job kind for Reconcile', () => {
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
    const update = {
      action: 'update-device-annotations' as const,
      statusAction: null,
    };
    const status = {
      action: 'disable-devices' as const,
      statusAction: 'disable' as const,
    };

    // An update operation keeps the step 4 rule (2026-10-16 design, OQ6).
    expect(canReconcile(auth(['jobs:read', 'devices:write']), update)).toBe(
      true,
    );
    expect(canReconcile(auth(['jobs:read', 'devices:status']), update)).toBe(
      false,
    );
    // A status operation follows section 6 of the 2026-10-21 design.
    expect(canReconcile(auth(['jobs:read', 'devices:status']), status)).toBe(
      true,
    );
    expect(canReconcile(auth(['jobs:read', 'devices:write']), status)).toBe(
      false,
    );
    // Both kinds need jobs:read.
    expect(canReconcile(auth(['jobs:read']), update)).toBe(false);
    expect(canReconcile(auth(['devices:write']), update)).toBe(false);
    expect(canReconcile(auth(['devices:status']), status)).toBe(false);

    // A Deprovision operation names its own permission (record ruling 1).
    const deprovision = {
      action: 'deprovision-devices' as const,
      statusAction: 'deprovision' as const,
    };
    expect(
      canReconcile(auth(['jobs:read', 'devices:deprovision']), deprovision),
    ).toBe(true);
    expect(
      canReconcile(auth(['jobs:read', 'devices:status']), deprovision),
    ).toBe(false);
    expect(
      canReconcile(auth(['jobs:read', 'devices:deprovision']), status),
    ).toBe(false);

    // No command job offers Reconcile, even with every write grant (D13).
    for (const action of [
      'reboot-devices',
      'wipe-user-data',
      'powerwash-devices',
    ] as const)
      expect(
        canReconcile(
          auth([
            'jobs:read',
            'devices:write',
            'devices:status',
            'devices:wipe',
          ]),
          { action, statusAction: null },
        ),
      ).toBe(false);
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

  it('omits a total that counts devices when a device has several field rows', () => {
    // An update job carries one row per device and field. The header counts devices, so it
    // cannot say how many field rows the job holds. The footer states the shown rows alone.
    const multi = job({
      changes: [
        { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
        { field: 'notes', mode: 'replace', value: 'Front desk' },
      ],
    });
    expect(
      operationsFooter(multi, {
        attention: false,
        pageIndex: 0,
        pageSize: 6,
        shown: 6,
        hasNext: true,
      }),
    ).toBe('Rows 1–6');
    expect(
      operationsFooter(multi, {
        attention: true,
        pageIndex: 0,
        pageSize: 6,
        shown: 6,
        hasNext: false,
      }),
    ).toBe('Rows 1–6 matching operations');
    expect(
      operationsFooter(multi, {
        attention: false,
        pageIndex: 0,
        pageSize: 6,
        shown: 0,
        hasNext: false,
      }),
    ).toBe('0 operations');
    expect(
      operationsFooter(multi, {
        attention: true,
        pageIndex: 0,
        pageSize: 6,
        shown: 0,
        hasNext: false,
      }),
    ).toBe('0 matching operations');
    // One change keeps one row per device, so the device total stays exact.
    const single = job({
      changes: [
        { field: 'annotatedLocation', mode: 'replace', value: 'North lab' },
      ],
    });
    expect(
      operationsFooter(single, {
        attention: false,
        pageIndex: 0,
        pageSize: 6,
        shown: 6,
        hasNext: false,
      }),
    ).toBe('Rows 1–6 of 6 operations');
  });

  it('omits the row total of an edit-list update job', () => {
    // An edit list holds its own fields per device, so the header cannot count the rows.
    const editList = job({ changes: null });
    expect(
      operationsFooter(editList, {
        attention: false,
        pageIndex: 0,
        pageSize: 6,
        shown: 3,
        hasNext: false,
      }),
    ).toBe('Rows 1–3');
    expect(
      operationsFooter(editList, {
        attention: true,
        pageIndex: 0,
        pageSize: 6,
        shown: 2,
        hasNext: false,
      }),
    ).toBe('Rows 1–2 matching operations');
    expect(
      operationsFooter(editList, {
        attention: false,
        pageIndex: 0,
        pageSize: 6,
        shown: 0,
        hasNext: false,
      }),
    ).toBe('0 operations');
    expect(
      operationsFooter(editList, {
        attention: true,
        pageIndex: 0,
        pageSize: 6,
        shown: 0,
        hasNext: false,
      }),
    ).toBe('0 matching operations');
  });
});

describe('cancel', () => {
  const auth = (
    actions: string[],
    requesterId = person.id,
    phase = 3,
  ): Parameters<typeof canCancel>[0] =>
    ({
      metadata: () => ({ phase }),
      session: () => ({
        identity: {
          id: requesterId,
          grants: actions.map((action) => ({
            action,
            scope: { kind: 'district', customerId: 'C0123456' },
          })),
        },
      }),
    }) as unknown as Parameters<typeof canCancel>[0];

  const running = (overrides: Partial<JobDetail> = {}) =>
    job({
      status: 'running',
      progress: progress({
        total: 48,
        succeeded: 36,
        failed: 0,
        unknown: 0,
        pending: 12,
      }),
      finishedAt: null,
      ...overrides,
    });

  it('lets the requester or a jobs:manage holder cancel', () => {
    expect(canCancel(auth(['jobs:read']), running())).toBe(true);
    expect(
      canCancel(
        auth(['jobs:manage'], 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
        running(),
      ),
    ).toBe(true);
    expect(
      canCancel(
        auth(['jobs:read'], 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
        running(),
      ),
    ).toBe(false);
    expect(canCancel(auth(['jobs:read'], person.id, 2), running())).toBe(false);
  });

  it('shows the control only while work remains that can stop', () => {
    expect(cancelState(auth(['jobs:read']), running())).toBe('request');
    expect(
      cancelState(auth(['jobs:read']), running({ status: 'queued' })),
    ).toBe('request');
    expect(
      cancelState(auth(['jobs:read']), running({ status: 'awaiting-devices' })),
    ).toBe('none');
    expect(
      cancelState(
        auth(['jobs:read']),
        running({
          status: 'completed',
          progress: progress({ pending: 0 }),
        }),
      ),
    ).toBe('none');
    expect(
      cancelState(
        auth(['jobs:read']),
        running({ progress: progress({ pending: 0 }) }),
      ),
    ).toBe('none');
    // A refresh has no operations and no waiting status (O1 ruling).
    expect(
      cancelState(
        auth(['jobs:read']),
        job({
          action: 'refresh-inventory',
          status: 'running',
          scope: { kind: 'all-devices', deviceCount: null },
          progress: progress({
            total: null,
            succeeded: 600,
            failed: 0,
            unknown: 0,
            pending: null,
          }),
        }),
      ),
    ).toBe('request');
  });

  it('shows the stored request disabled until the job ends', () => {
    const request = {
      at: '2026-10-26T14:42:00.000Z',
      by: person,
    };
    expect(
      cancelState(auth(['jobs:read']), running({ cancelRequest: request })),
    ).toBe('requested');
    expect(
      cancelState(
        auth(['jobs:read']),
        running({ status: 'cancelled', cancelRequest: request }),
      ),
    ).toBe('none');
    // A person without the right sees no control at all.
    expect(
      cancelState(
        auth(['jobs:read'], 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
        running({ cancelRequest: request }),
      ),
    ).toBe('none');
  });

  it('drafts the running question of state 02', () => {
    const question = cancelQuestion(running({ displayId: 'UPD-001' }));
    expect(question.title).toBe('Cancel pending work on UPD-001?');
    expect(question.paragraphs).toEqual([
      '12 of 48 operations are pending. Those that have not reached Google end Cancelled and never run.',
      'Requests already sent to Google finish and keep their results. The 36 confirmed updates stay. Nothing rolls back.',
    ]);
    expect(question.dismissLabel).toBe('Keep job running');
    expect(question.confirmLabel).toBe('Cancel pending work');
  });

  it('drafts the waiting question of state 05', () => {
    const question = cancelQuestion(
      job({
        displayId: 'STS-001',
        action: 'disable-devices',
        status: 'queued',
        scope: { kind: 'devices', deviceCount: 18 },
        progress: progress({
          total: 18,
          succeeded: 0,
          failed: 0,
          unknown: 0,
          pending: 18,
        }),
        finishedAt: null,
      }),
    );
    expect(question.title).toBe('Cancel pending work on STS-001?');
    expect(question.paragraphs).toEqual([
      'No operation has started. All 18 operations end Cancelled.',
      'No request reaches Google. The 18 devices keep their current status.',
    ]);
    expect(question.dismissLabel).toBe('Keep job waiting');
  });

  it('names confirmed commands and status changes in a running question', () => {
    const command = cancelQuestion(
      job({
        displayId: 'CMD-001',
        action: 'reboot-devices',
        status: 'running',
        changes: null,
        commandType: 'REBOOT',
        progress: progress({
          total: 4,
          succeeded: 3,
          failed: 0,
          unknown: 0,
          pending: 1,
        }),
        finishedAt: null,
      }),
    );
    expect(command.paragraphs[1]).toBe(
      'Requests already sent to Google finish and keep their results. The 3 confirmed commands stay. Nothing rolls back.',
    );
    const status = cancelQuestion(
      job({
        displayId: 'STS-001',
        action: 'disable-devices',
        status: 'running',
        progress: progress({
          total: 4,
          succeeded: 1,
          failed: 0,
          unknown: 0,
          pending: 3,
        }),
        finishedAt: null,
      }),
    );
    expect(status.paragraphs[1]).toBe(
      'Requests already sent to Google finish and keep their results. The 1 confirmed status change stays. Nothing rolls back.',
    );
  });

  it('drafts the refresh questions of the O1 ruling', () => {
    const all = cancelQuestion(
      job({
        displayId: 'REF-001',
        action: 'refresh-inventory',
        status: 'running',
        scope: { kind: 'all-devices', deviceCount: null },
        progress: progress({
          total: null,
          succeeded: 600,
          failed: 0,
          unknown: 0,
          pending: null,
        }),
        finishedAt: null,
      }),
    );
    expect(all.title).toBe('Cancel pending work on REF-001?');
    expect(all.paragraphs).toEqual([
      'The refresh has read 600 devices. It stops at its next page.',
      'It saves none of this refresh and marks no device removed. The inventory keeps its earlier data.',
    ]);
    expect(all.dismissLabel).toBe('Keep job running');

    const selected = cancelQuestion(
      job({
        displayId: 'REF-002',
        action: 'refresh-inventory',
        status: 'running',
        scope: { kind: 'devices', deviceCount: 1000 },
        progress: progress({
          total: 1000,
          succeeded: 250,
          failed: 0,
          unknown: 0,
          pending: 750,
        }),
        finishedAt: null,
      }),
    );
    expect(selected.paragraphs).toEqual([
      '250 of 1,000 devices are read. The refresh stops at its next batch.',
      'Devices already read keep their new data. The other devices keep their earlier data.',
    ]);
  });

  it('names the inventory that a cancelled Refresh all did not save', () => {
    const refreshAll = job({
      displayId: 'REF-001',
      action: 'refresh-inventory',
      status: 'cancelled',
      scope: { kind: 'all-devices', deviceCount: null },
    });
    const selected = job({
      displayId: 'REF-002',
      action: 'refresh-inventory',
      status: 'cancelled',
      scope: { kind: 'devices', deviceCount: 1000 },
    });
    expect(cancelActivitySentence(refreshAll)).toBe(
      'Cancellation ended the refresh. It saved none of the devices that it read, and it marked no device removed.',
    );
    expect(cancelActivitySentence(selected)).toBe(
      'Cancellation ended the refresh. Devices already read keep their data.',
    );
  });

  it('warns that sent commands still run on a command job', () => {
    const commandBanner = {
      title: 'Sent commands still run on their devices',
      body: 'Campus Commander sends no new command. Each sent command runs when its device connects, or it expires. Nothing rolls back.',
    };
    for (const action of [
      'reboot-devices',
      'wipe-user-data',
      'powerwash-devices',
    ] as const)
      expect(cancelBanner(job({ action }))).toEqual(commandBanner);
  });

  it('keeps the built banner for an update job and a status job', () => {
    const builtBanner = {
      title: 'The job stops within 30 seconds',
      body: 'Requests already sent to Google finish and keep their results. Pending operations that have not reached Google end Cancelled. Nothing rolls back.',
    };
    expect(cancelBanner(job({ action: 'update-device-annotations' }))).toEqual(
      builtBanner,
    );
    expect(cancelBanner(job({ action: 'disable-devices' }))).toEqual(
      builtBanner,
    );
  });

  it('names one stopped operation in Latest activity', () => {
    expect(
      cancelActivitySentence(
        job({
          status: 'cancelled',
          progress: progress({ cancelled: 1 }),
        }),
      ),
    ).toBe('Cancellation stopped 1 operation before it reached Google.');
    expect(
      cancelActivitySentence(
        job({
          status: 'cancelled',
          progress: progress({ cancelled: 8 }),
        }),
      ),
    ).toBe('Cancellation stopped 8 operations before they reached Google.');
  });

  it('drafts the waiting question for one operation', () => {
    const one = cancelQuestion(
      job({
        displayId: 'STS-002',
        action: 'disable-devices',
        status: 'queued',
        scope: { kind: 'devices', deviceCount: 1 },
        progress: progress({
          total: 1,
          succeeded: 0,
          failed: 0,
          unknown: 0,
          pending: 1,
        }),
        finishedAt: null,
      }),
    );
    expect(one.paragraphs[0]).toBe(
      'No operation has started. The 1 operation ends Cancelled.',
    );
    const many = cancelQuestion(
      job({
        displayId: 'STS-001',
        action: 'disable-devices',
        status: 'queued',
        scope: { kind: 'devices', deviceCount: 18 },
        progress: progress({
          total: 18,
          succeeded: 0,
          failed: 0,
          unknown: 0,
          pending: 18,
        }),
        finishedAt: null,
      }),
    );
    expect(many.paragraphs[0]).toBe(
      'No operation has started. All 18 operations end Cancelled.',
    );
  });

  it('drafts the running question for one operation', () => {
    const one = cancelQuestion(
      job({
        displayId: 'UPD-007',
        status: 'running',
        scope: { kind: 'devices', deviceCount: 1 },
        progress: progress({
          total: 1,
          succeeded: 0,
          failed: 0,
          unknown: 0,
          pending: 1,
        }),
        finishedAt: null,
      }),
    );
    expect(one.paragraphs[0]).toBe(
      '1 of 1 operation is pending. Those that have not reached Google end Cancelled and never run.',
    );
    expect(cancelQuestion(running()).paragraphs[0]).toBe(
      '12 of 48 operations are pending. Those that have not reached Google end Cancelled and never run.',
    );
  });

  it('drafts the selected-device refresh question for one device', () => {
    const one = cancelQuestion(
      job({
        displayId: 'REF-003',
        action: 'refresh-inventory',
        status: 'running',
        scope: { kind: 'devices', deviceCount: 1 },
        progress: progress({
          total: 1,
          succeeded: 0,
          failed: 0,
          unknown: 0,
          pending: 1,
        }),
        finishedAt: null,
      }),
    );
    expect(one.paragraphs).toEqual([
      '0 of 1 device is read. The refresh stops at its next batch.',
      'Devices already read keep their new data. The other devices keep their earlier data.',
    ]);
    const many = cancelQuestion(
      job({
        displayId: 'REF-004',
        action: 'refresh-inventory',
        status: 'running',
        scope: { kind: 'devices', deviceCount: 1000 },
        progress: progress({
          total: 1000,
          succeeded: 250,
          failed: 0,
          unknown: 0,
          pending: 750,
        }),
        finishedAt: null,
      }),
    );
    expect(many.paragraphs[0]).toBe(
      '250 of 1,000 devices are read. The refresh stops at its next batch.',
    );
  });

  it('renders the identity line of the request', () => {
    const now = new Date('2026-10-26T15:00:00.000Z');
    expect(
      cancelLine(
        {
          cancelRequest: { at: '2026-10-26T14:42:00.000Z', by: person },
        },
        now,
      ),
    ).toBe(
      `Cancellation requested by District Admin · ${formatTimestamp(
        '2026-10-26T14:42:00.000Z',
        now,
      )}`,
    );
    expect(cancelLine({ cancelRequest: null }, now)).toBeNull();
  });

  it('reads the Cancelled counter from the stored count', () => {
    const counters = jobCounters(job({ progress: progress({ cancelled: 8 }) }));
    expect(counters.find((counter) => counter.key === 'cancelled')?.value).toBe(
      8,
    );
  });

  it('notes that a cancelled operation never reached Google', () => {
    expect(outcomeNotes(job(), operation({ outcome: 'cancelled' }))).toEqual([
      'Not sent to Google',
    ]);
    expect(operationChip(operation({ outcome: 'cancelled' })).label).toBe(
      'Cancelled',
    );
    expect(outcomeTone('cancelled')).toBe('neutral');
  });

  it('leads Latest activity with the cancel sentence of state 04', () => {
    const cancelled = job({
      status: 'cancelled',
      displayId: 'UPD-001',
      progress: progress({
        total: 48,
        succeeded: 38,
        failed: 1,
        unknown: 1,
        pending: 0,
        cancelled: 8,
      }),
      latestActivity: {
        at: '2026-10-26T14:43:00.000Z',
        failed: {
          count: 1,
          operations: [
            {
              operationId: 'UPD-001-39',
              deviceId: 'synthetic-device-39',
              serialNumber: '04XTBHJ',
              outcomeReason: 'quota',
              googleStatus: 429,
              googleReason: 'Quota exceeded',
              updatedAt: '2026-10-26T14:42:00.000Z',
            },
          ],
        },
        unknown: {
          count: 1,
          operations: [
            {
              operationId: 'UPD-001-40',
              deviceId: 'synthetic-device-40',
              serialNumber: '0727D2E',
              updatedAt: '2026-10-26T14:43:00.000Z',
            },
          ],
        },
      },
      phase: null,
      exportSummary: null,
      importSummary: null,
      exportFile: null,
      importSource: null,
      plan: null,
      importDisplayId: null,
      waitsForDisplayId: null,
      waitingDisplayIds: null,
      planJobs: null,
      executionCounts: null,
    });
    expect(latestActivityLine(cancelled)).toBe(
      `${formatTime('2026-10-26T14:43:00.000Z')} · Cancellation stopped 8 operations before they reached Google. Google quota stopped the update for 04XTBHJ. 0727D2E requires reconciliation before any retry.`,
    );
  });

  it('ends a job that never started with the before-it-started sentence', () => {
    const queued = job({
      displayId: 'STS-001',
      action: 'disable-devices',
      status: 'cancelled',
      scope: { kind: 'devices', deviceCount: 18 },
      startedAt: null,
      progress: progress({
        total: 18,
        succeeded: 0,
        failed: 0,
        unknown: 0,
        pending: 0,
        cancelled: 18,
      }),
      latestActivity: {
        at: '2026-10-26T14:41:00.000Z',
        failed: { count: 0, operations: [] },
        unknown: { count: 0, operations: [] },
      },
      phase: null,
      exportSummary: null,
      importSummary: null,
      exportFile: null,
      importSource: null,
      plan: null,
      importDisplayId: null,
      waitsForDisplayId: null,
      waitingDisplayIds: null,
      planJobs: null,
      executionCounts: null,
    });
    expect(latestActivityLine(queued)).toBe(
      `${formatTime('2026-10-26T14:41:00.000Z')} · Cancellation ended the job before it started. No request reached Google.`,
    );
  });

  it('names the stopped refresh in Latest activity', () => {
    const refresh = job({
      displayId: 'REF-001',
      action: 'refresh-inventory',
      status: 'cancelled',
      scope: { kind: 'all-devices', deviceCount: null },
      progress: progress({
        total: null,
        succeeded: 600,
        failed: 0,
        unknown: 0,
        pending: null,
      }),
      latestActivity: {
        at: '2026-10-26T14:42:00.000Z',
        failed: { count: 0, operations: [] },
        unknown: { count: 0, operations: [] },
      },
      phase: null,
      exportSummary: null,
      importSummary: null,
      exportFile: null,
      importSource: null,
      plan: null,
      importDisplayId: null,
      waitsForDisplayId: null,
      waitingDisplayIds: null,
      planJobs: null,
      executionCounts: null,
    });
    expect(latestActivityLine(refresh)).toBe(
      `${formatTime('2026-10-26T14:42:00.000Z')} · Cancellation ended the refresh. It saved none of the devices that it read, and it marked no device removed. 600 devices read.`,
    );
  });

  it('accepts jobs:manage as the read check of Reconcile', () => {
    const manage = auth(['jobs:manage', 'devices:write']);
    expect(
      canReconcile(manage, {
        action: 'update-device-annotations',
        statusAction: null,
      }),
    ).toBe(true);
  });
});
