import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  DeviceImportReport,
  JobDetail,
  JobImportPlan,
  JobOperation,
  JobSummary,
} from '@campus/application-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore } from '../auth.store';
import { DeviceExportImportDialog } from './device-export-import-dialog';
import { DeviceExportImportStore } from './device-export-import.store';

/**
 * C1 of card XF3: state 16 (the Execute confirmation), states 17 and 17b (the execution
 * results), and the Failed tab, against a mocked API (design sections 7 and 8).
 */

const importJobId = '1a1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a11';
const updateJobId = '2b1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a12';
const statusJobId = '3c1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a13';
const planId = '4d1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a14';
const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'Review administrator',
};
/** A future expiry, so the open plan stays open whenever the suite runs. */
const futureExpiry = () =>
  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const at = (secondsAgo: number) =>
  new Date(Date.now() - secondsAgo * 1000).toISOString();

const openPlan = {
  planId,
  revision: 2,
  state: 'open' as const,
  expiresAt: futureExpiry(),
  changedBy: null,
  changedAt: null,
};
const executedPlan = {
  planId,
  revision: 3,
  state: 'executed' as const,
  expiresAt: futureExpiry(),
  changedBy: person,
  changedAt: at(120),
};

const summary = (
  overrides: Partial<JobSummary> & Pick<JobSummary, 'jobId' | 'displayId'>,
): JobSummary => ({
  revision: 4,
  action: 'update-device-annotations',
  status: 'running',
  scope: { kind: 'devices', deviceCount: 3 },
  requestedBy: person,
  createdAt: at(600),
  startedAt: at(300),
  finishedAt: null,
  progress: {
    total: 3,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: 3,
  },
  phase: null,
  exportSummary: null,
  importSummary: null,
  failure: null,
  cancelRequest: null,
  ...overrides,
});

/** State 17: the update job runs, and the status job waits for it. */
const runningJobs: JobSummary[] = [
  summary({
    jobId: updateJobId,
    displayId: 'UPD-001',
    status: 'running',
    progress: {
      total: 3,
      succeeded: 1,
      failed: 0,
      unknown: 0,
      skipped: 0,
      expired: 0,
      cancelled: 0,
      pending: 2,
    },
  }),
  summary({
    jobId: statusJobId,
    displayId: 'STS-002',
    action: 'reenable-devices',
    status: 'queued',
    scope: { kind: 'devices', deviceCount: 1 },
    progress: {
      total: 1,
      succeeded: 0,
      failed: 0,
      unknown: 0,
      skipped: 0,
      expired: 0,
      cancelled: 0,
      pending: 1,
    },
  }),
];

/** State 17b: every job ended, and the Re-enable of 04XTBHJ failed. */
const finishedJobs: JobSummary[] = [
  summary({
    jobId: updateJobId,
    displayId: 'UPD-001',
    status: 'completed',
    finishedAt: at(180),
    progress: {
      total: 3,
      succeeded: 3,
      failed: 0,
      unknown: 0,
      skipped: 0,
      expired: 0,
      cancelled: 0,
      pending: 0,
    },
  }),
  summary({
    jobId: statusJobId,
    displayId: 'STS-002',
    action: 'reenable-devices',
    status: 'failed',
    scope: { kind: 'devices', deviceCount: 1 },
    finishedAt: at(150),
    progress: {
      total: 1,
      succeeded: 0,
      failed: 1,
      unknown: 0,
      skipped: 0,
      expired: 0,
      cancelled: 0,
      pending: 0,
    },
  }),
];

const importDetail = (overrides: Partial<JobDetail> = {}): JobDetail => ({
  jobId: importJobId,
  displayId: 'IMP-001',
  revision: 6,
  action: 'validate-device-import',
  status: 'completed',
  scope: { kind: 'rows', deviceCount: 7 },
  requestedBy: person,
  createdAt: at(900),
  startedAt: at(880),
  finishedAt: at(840),
  progress: {
    total: 7,
    succeeded: 7,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: 0,
  },
  phase: null,
  exportSummary: null,
  failure: null,
  importSummary: {
    mode: 'sync-changes',
    planState: 'open',
    proposed: 4,
    rejected: 2,
    refusal: null,
  },
  importSource: {
    name: 'devices-for-editing-EXP-001.csv',
    sizeBytes: 1024,
    rowsRead: 11,
    candidateRows: 9,
    refusalText: null,
  },
  plan: openPlan,
  importDisplayId: null,
  waitsForDisplayId: null,
  waitingDisplayIds: null,
  planJobs: null,
  executionCounts: null,
  exportFile: null,
  cancelRequest: null,
  confirmedBy: null,
  previewDisplayId: null,
  changes: null,
  commandType: null,
  statusAction: null,
  deprovisionReason: null,
  targetOrgUnitPaths: null,
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: at(60),
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
  ...overrides,
});

const fieldChange = (
  field: 'annotatedLocation' | 'notes' | 'orgUnitPath',
  currentValue: string | null,
  newValue: string | null,
) => ({
  type: 'field' as const,
  field,
  operation: 'replace' as const,
  currentValue,
  newValue,
});

const report = (
  overrides: Partial<DeviceImportReport> = {},
): DeviceImportReport => ({
  jobId: importJobId,
  displayId: 'IMP-001',
  view: 'proposed',
  page: 0,
  pageCount: 1,
  counts: {
    rows: 6,
    unchanged: 0,
    noChangeNeeded: 0,
    proposed: 4,
    rejected: 2,
  },
  refresh: { staleDevicesRead: 9, oldestObservedAt: at(3600) },
  changes: {
    fieldChanges: 3,
    fieldChangeDevices: 3,
    disable: 0,
    reenable: 1,
    deprovision: [],
  },
  lines: [
    {
      row: 2,
      deviceId: 'C0A1-0001',
      serialNumber: '01P0T1V',
      change: fieldChange('annotatedLocation', 'Room 12', 'Room 14'),
      column: null,
      submittedValue: null,
      reason: null,
      notRun: null,
      jobDisplayId: 'UPD-001',
      operationNumber: 1,
      outcome: 'succeeded',
    },
    {
      row: 3,
      deviceId: 'C0A1-0002',
      serialNumber: '02A1MB6',
      change: fieldChange('notes', 'Loaner', 'Clear value'),
      column: null,
      submittedValue: null,
      reason: null,
      notRun: null,
      jobDisplayId: 'UPD-001',
      operationNumber: 2,
      outcome: 'succeeded',
    },
    {
      row: 4,
      deviceId: 'C0A1-0003',
      serialNumber: '02QJANY',
      change: fieldChange('orgUnitPath', '/Chrome Devices/Lowell', '/Library'),
      column: null,
      submittedValue: null,
      reason: null,
      notRun: null,
      jobDisplayId: 'UPD-001',
      operationNumber: 3,
      outcome: 'pending',
    },
    {
      row: 5,
      deviceId: 'C0A1-0004',
      serialNumber: '04XTBHJ',
      change: {
        type: 'status',
        action: 'reenable',
        reason: null,
        currentValue: 'DISABLED',
        newValue: 'ACTIVE',
      },
      column: null,
      submittedValue: null,
      reason: null,
      notRun: null,
      jobDisplayId: 'STS-002',
      operationNumber: 1,
      outcome: 'failed',
    },
  ],
  total: 4,
  plan: openPlan,
  ...overrides,
});

const operation = (
  operationId: string,
  outcome: JobOperation['outcome'],
  overrides: Partial<JobOperation> = {},
): JobOperation => ({
  operationId,
  deviceId: 'C0A1-0001',
  serialNumber: '01P0T1V',
  orgUnitPath: '/Chrome Devices/Lowell',
  field: 'annotatedLocation',
  operation: 'replace',
  baselineValue: 'Room 12',
  requestedValue: 'Room 14',
  outcome,
  outcomeReason: null,
  googleStatus: null,
  googleReason: null,
  observedValue: null,
  verifiedBy: null,
  commandId: null,
  commandState: null,
  commandExpiresAt: null,
  commandExecutedAt: null,
  updatedAt: at(120),
  ...overrides,
});

const operationsPage = (operations: readonly JobOperation[]) => ({
  operations,
  nextCursor: null,
});

const response = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

/** The answer of Execute: the executed plan and one receipt for each job it created. */
const executeAnswer = () => ({
  plan: executedPlan,
  receipts: [
    {
      jobId: updateJobId,
      displayId: 'UPD-001',
      action: 'update-device-annotations',
      status: 'accepted' as const,
      deviceCount: 3,
    },
    {
      jobId: statusJobId,
      displayId: 'STS-002',
      action: 'reenable-devices',
      status: 'accepted' as const,
      deviceCount: 1,
    },
  ],
  conflicts: 0,
  excluded: 0,
});

/** One `job-changed` message of the tab's shared feed. */
const jobEvent = (jobId: string, displayId: string, revision: number) => ({
  type: 'job-changed' as const,
  jobId,
  displayId,
  revision,
  requestedBy: person.id,
});

/** The API of one executed import: its detail, its report views, and its operations. */
function api(
  state: {
    detail: () => JobDetail;
    proposed: () => DeviceImportReport;
    failed: () => DeviceImportReport;
    operations: () => readonly JobOperation[];
  },
  answer: () => Response = () => response(executeAnswer()),
) {
  return vi.fn(async (path: string, _body?: unknown) => {
    if (path.endsWith('/execute')) return answer();
    if (path.includes('/operations?')) {
      return response(operationsPage(state.operations()));
    }
    if (path.includes('/report?')) {
      const view = new URL(path, 'http://localhost').searchParams.get('view');
      return response(view === 'failed' ? state.failed() : state.proposed());
    }
    if (path.includes('/rejected')) return response({});
    return response(state.detail());
  });
}

function setup(
  request: ReturnType<typeof api>,
  detail: JobDetail = importDetail(),
) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: AuthStore,
        useValue: {
          session: () => null,
          can: () => true,
          request,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(DeviceExportImportDialog);
  fixture.componentRef.setInput(
    'tabId',
    '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
  );
  const store = TestBed.inject(DeviceExportImportStore);
  const sources: { url: string }[] = [];
  const listeners = new Map<string, (message: MessageEvent<string>) => void>();
  store.eventSource = (url: string) => {
    sources.push({ url });
    return {
      addEventListener: (name: string, handler: EventListener) => {
        listeners.set(name, handler as (message: MessageEvent<string>) => void);
      },
      close: () => undefined,
    } as never;
  };
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  /** One message of the tab's shared `/api/events` feed. */
  const emit = (name: string, data: unknown) => {
    const listener = listeners.get(name);
    if (!listener) throw new Error(`The feed holds no ${name} listener.`);
    listener({ data: JSON.stringify(data) } as MessageEvent<string>);
  };
  const render = async () => {
    // The job read, the report page, and the operations settle on microtasks and timers.
    for (let turn = 0; turn < 4; turn += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const panel = () =>
    element.querySelector<HTMLElement>('section[role="dialog"]');
  const text = () => panel()?.textContent?.replace(/\s+/g, ' ') ?? '';
  const button = (label: string) =>
    [...(panel()?.querySelectorAll('button') ?? [])].find(
      (candidate) =>
        candidate.textContent?.replace(/\s+/g, ' ').trim() === label,
    );
  return {
    fixture,
    element,
    store,
    render,
    panel,
    text,
    button,
    request,
    sources,
    detail,
    emit,
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.useRealTimers();
});

beforeEach(() => {
  TestBed.resetTestingModule();
});

describe('Execute and its results', () => {
  it('opens the Execute confirmation with the sequence, the rows that stay out, and the phrase', async () => {
    const request = api({
      detail: () => importDetail(),
      proposed: () => report(),
      failed: () => report({ view: 'failed', lines: [], total: 0 }),
      operations: () => [],
    });
    const { store, render, text, panel } = setup(request);
    store.openJob('IMP-001');
    await render();
    expect(store.step()).toBe('report');

    store.openConfirm();
    await render();

    expect(store.step()).toBe('confirm');
    // The question names the changes of the plan.
    expect(text()).toContain('Execute 4 changes on 4 devices?');
    expect(text()).toContain(
      'Execute creates two jobs. The update job runs first. The status job starts after it ends.',
    );
    // The sequence: the update job of the field changes, then the Re-enable job.
    const steps = [...(panel()?.querySelectorAll('.seq-job') ?? [])].map(
      (job) => ({
        number: job
          .closest('.seq-step')
          ?.querySelector('.phase-dot')
          ?.textContent?.trim(),
        action: job.querySelector('.seq-action > span')?.textContent?.trim(),
        line: job.querySelector('.seq-line')?.textContent?.trim() ?? null,
        scope: job.querySelector('.seq-scope')?.textContent?.trim(),
      }),
    );
    expect(steps).toEqual([
      {
        number: '1',
        action: 'Update device annotations',
        line: '3 field changes',
        scope: '3 devices',
      },
      {
        number: '2',
        action: 'Re-enable devices',
        line: null,
        scope: '1 device',
      },
    ]);
    expect(text()).toContain(
      'The 2 rejected rows stay out. Nothing in them runs.',
    );
    expect(
      panel()?.querySelector('ol[aria-label="Jobs that Execute creates"]'),
    ).not.toBeNull();
    expect(panel()?.querySelector('mat-form-field')).toBeNull();
  });

  it('keeps Execute disabled until the typed phrase matches a Deprovision plan', async () => {
    const request = api({
      detail: () => importDetail(),
      proposed: () =>
        report({
          changes: {
            fieldChanges: 3,
            fieldChangeDevices: 3,
            disable: 0,
            reenable: 1,
            deprovision: [
              { reason: 'DEPROVISION_REASON_RETIRING_DEVICE', devices: 1 },
            ],
          },
        }),
      failed: () => report({ view: 'failed', lines: [], total: 0 }),
      operations: () => [],
    });
    const { store, render, text, panel, button } = setup(request);
    store.openJob('IMP-001');
    await render();
    store.openConfirm();
    await render();

    expect(text()).toContain(
      'Deprovision removes these devices from active management.',
    );
    expect(text()).toContain('Type DEPROVISION to confirm');
    const execute = () =>
      [...(panel()?.querySelectorAll('button') ?? [])].find((candidate) =>
        /^Execute \d+ changes$/.test(
          candidate.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        ),
      );
    expect(execute()?.disabled).toBe(true);

    // A wrong phrase keeps Execute disabled and shows the error of the built sheet.
    const input = panel()?.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('the typed phrase field is missing');
    input.value = 'deprovisions';
    input.dispatchEvent(new Event('input'));
    await render();
    expect(execute()?.disabled).toBe(true);
    expect(text()).toContain('The phrase does not match. Type DEPROVISION.');

    input.value = 'DEPROVISION';
    input.dispatchEvent(new Event('input'));
    await render();
    expect(execute()?.disabled).toBe(false);
    expect(text()).not.toContain('The phrase does not match.');
    expect(button('Back to review')).not.toBeUndefined();
  });

  it('sends the plan and the typed phrase, then shows the results', async () => {
    let executed = false;
    const request = api(
      {
        detail: () =>
          executed
            ? importDetail({
                plan: executedPlan,
                planJobs: runningJobs,
                executionCounts: {
                  succeeded: 2,
                  failed: 0,
                  unknown: 0,
                  skipped: 0,
                  expired: 0,
                  cancelled: 0,
                  pending: 2,
                  notRun: 0,
                },
              })
            : importDetail(),
        proposed: () => report({ plan: executed ? executedPlan : openPlan }),
        failed: () => report({ view: 'failed', lines: [], total: 0 }),
        operations: () => [
          operation('UPD-001-1', 'succeeded'),
          operation('UPD-001-2', 'succeeded'),
          operation('UPD-001-3', 'pending'),
          operation('STS-002-1', 'pending', {
            operation: 'reenable',
            field: null,
            baselineValue: 'DISABLED',
            requestedValue: 'ACTIVE',
          }),
        ],
      },
      () => {
        executed = true;
        return response(executeAnswer());
      },
    );
    const { store, render, request: calls } = setup(request);
    store.openJob('IMP-001');
    await render();
    store.openConfirm();
    await render();

    const accepted = await store.execute();
    await render();

    expect(accepted).toBe(true);
    const post = calls.mock.calls.find(([path]) =>
      String(path).endsWith('/execute'),
    );
    expect(post?.[1]).toEqual({
      planId,
      planRevision: 2,
      typedPhrase: null,
    });
    expect(store.step()).toBe('results');
  });

  it('names a permission refusal and stays on the confirmation', async () => {
    const request = api(
      {
        detail: () => importDetail(),
        proposed: () => report(),
        failed: () => report({ view: 'failed', lines: [], total: 0 }),
        operations: () => [],
      },
      () => response({ error: 'forbidden' }, 403),
    );
    const { store, render, text } = setup(request);
    store.openJob('IMP-001');
    await render();
    store.openConfirm();
    await render();

    await expect(store.execute()).resolves.toBe(false);
    await render();

    expect(store.step()).toBe('confirm');
    expect(text()).toContain(
      'You do not have permission to execute this plan.',
    );
  });

  it('shows the count sum, the jobs band, and the result of each change', async () => {
    const request = api({
      detail: () =>
        importDetail({
          plan: executedPlan,
          planJobs: runningJobs,
          executionCounts: {
            succeeded: 2,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: 2,
            notRun: 0,
          },
        }),
      proposed: () =>
        report({
          plan: executedPlan,
          lines: [
            report().lines[0],
            report().lines[1],
            report().lines[2],
            // The status change waits for the update job until that job ends.
            { ...report().lines[3], outcome: 'pending' },
          ],
        }),
      failed: () => report({ view: 'failed', lines: [], total: 0 }),
      operations: () => [
        operation('UPD-001-1', 'succeeded'),
        operation('UPD-001-2', 'succeeded'),
        operation('UPD-001-3', 'pending'),
        operation('STS-002-1', 'pending', {
          operation: 'reenable',
          field: null,
          baselineValue: 'DISABLED',
          requestedValue: 'ACTIVE',
        }),
      ],
    });
    const { store, render, text, panel } = setup(request);
    store.openJob('IMP-001');
    await render();

    expect(store.step()).toBe('results');
    // The count sum: 4 changes = 2 Succeeded + 2 Pending.
    const sum = [
      ...(panel()?.querySelectorAll('.rs-sum .count-term') ?? []),
    ].map(
      (term) =>
        `${term.querySelector('dd')?.textContent?.trim()} ${term
          .querySelector('dt')
          ?.textContent?.trim()}`,
    );
    expect(sum).toEqual(['4 changes', '2 Succeeded', '2 Pending']);
    // The live indicator belongs to state 17, and no end time shows while a job runs.
    expect(text()).toContain('Updated live');
    expect(text()).not.toContain('Finished ');

    // The jobs band: the running job with its bar, the waiting job with its own progress.
    const jobs = [...(panel()?.querySelectorAll('.job-item') ?? [])].map(
      (job) => job.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(jobs[0]).toContain('UPD-001');
    expect(jobs[0]).toContain('Running');
    expect(jobs[0]).toContain('1 of 3 complete · 2 pending');
    expect(jobs[1]).toContain('STS-002');
    expect(jobs[1]).toContain('Queued');
    expect(jobs[1]).toContain('0 of 1 complete');
    expect(
      panel()?.querySelectorAll('.job-progress mat-progress-bar'),
    ).toHaveLength(1);

    // The table keeps the report columns and adds the Result column.
    const head = [...(panel()?.querySelectorAll('th') ?? [])].map((cell) =>
      cell.textContent?.trim(),
    );
    expect(head).toEqual([
      'Row',
      'Device',
      'Change',
      'Current value',
      'New value',
      'Result',
    ]);
    const results = [...(panel()?.querySelectorAll('td.col-result') ?? [])].map(
      (cell) => cell.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(results).toEqual([
      'Succeeded',
      'Succeeded',
      'Pending',
      'Pending Starts after UPD-001 ends',
    ]);
    expect(text()).toContain('Rows 1–4 of 4 changes');
  });

  it('replaces the live line with the end time when every job is final', async () => {
    const request = api({
      detail: () =>
        importDetail({
          plan: executedPlan,
          planJobs: finishedJobs,
          executionCounts: {
            succeeded: 3,
            failed: 1,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: 0,
            notRun: 0,
          },
        }),
      proposed: () => report({ plan: executedPlan }),
      failed: () =>
        report({
          view: 'failed',
          plan: executedPlan,
          lines: [report().lines[3]],
          total: 1,
        }),
      operations: () => [
        operation('UPD-001-1', 'succeeded'),
        operation('UPD-001-2', 'succeeded'),
        operation('UPD-001-3', 'succeeded'),
        operation('STS-002-1', 'failed', {
          operation: 'reenable',
          field: null,
          baselineValue: 'DISABLED',
          requestedValue: 'ACTIVE',
          outcomeReason: 'status-conflict',
          googleReason:
            'A device with status ACTIVE does not allow this action.',
        }),
      ],
    });
    const { store, render, text, panel } = setup(request);
    store.openJob('IMP-001');
    await render();

    expect(text()).not.toContain('Updated live');
    expect(text()).toContain('Finished ');
    const sum = [
      ...(panel()?.querySelectorAll('.rs-sum .count-term') ?? []),
    ].map(
      (term) =>
        `${term.querySelector('dd')?.textContent?.trim()} ${term
          .querySelector('dt')
          ?.textContent?.trim()}`,
    );
    expect(sum).toEqual(['4 changes', '3 Succeeded', '1 Failed']);

    // The Failed tab lists the failed Re-enable with the Google reason under its chip.
    const cells = () => panel()?.querySelectorAll('td.col-result') ?? [];
    expect(cells()).toHaveLength(4);
    store.setReportView('failed');
    await render();
    expect(store.reportView()).toBe('failed');
    const failed = [...(panel()?.querySelectorAll('td.col-result') ?? [])].map(
      (cell) => cell.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(failed).toEqual([
      'Failed A device with status ACTIVE does not allow this action.',
    ]);
    expect(text()).toContain('04XTBHJ');
    expect(text()).toContain('Re-enable');
  });

  it('shows the count pill of each tab and the empty Failed view', async () => {
    const request = api({
      detail: () =>
        importDetail({
          plan: executedPlan,
          planJobs: finishedJobs,
          executionCounts: {
            succeeded: 4,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: 0,
            notRun: 0,
          },
        }),
      proposed: () =>
        report({
          plan: executedPlan,
          // The proposed row count names devices. The All changes pill counts change lines,
          // which the report total carries (R2).
          counts: {
            rows: 6,
            unchanged: 0,
            noChangeNeeded: 0,
            proposed: 2,
            rejected: 4,
          },
          total: 4,
        }),
      failed: () =>
        report({ view: 'failed', plan: executedPlan, lines: [], total: 0 }),
      operations: () => [operation('UPD-001-1', 'succeeded')],
    });
    const { store, render, text, panel } = setup(request);
    store.openJob('IMP-001');
    await render();

    const tabs = [
      ...(panel()?.querySelectorAll('.report-tabs button') ?? []),
    ].map((tab) => tab.textContent?.replace(/\s+/g, ' ').trim());
    expect(tabs).toEqual(['All changes 4', 'Failed 0']);

    store.setReportView('failed');
    await render();
    expect(text()).toContain('No change failed.');
  });

  it('reads the next page of the results with the operations of that page', async () => {
    const first = report({
      plan: executedPlan,
      pageCount: 2,
      counts: {
        rows: 16,
        unchanged: 0,
        noChangeNeeded: 0,
        proposed: 14,
        rejected: 2,
      },
      total: 14,
    });
    const second = report({
      plan: executedPlan,
      page: 1,
      pageCount: 2,
      counts: first.counts,
      total: 14,
      lines: [
        {
          ...report().lines[0],
          row: 12,
          deviceId: '05ZZZZZ',
          jobDisplayId: 'UPD-001',
          operationNumber: 9,
          outcome: 'succeeded',
        },
      ],
    });
    const request = vi.fn(async (path: string) => {
      if (path.includes('/operations?')) {
        const numbers = new URL(path, 'http://localhost').searchParams.get(
          'number',
        );
        return response(
          operationsPage(
            numbers === '9'
              ? [operation('UPD-001-9', 'succeeded', { deviceId: '05ZZZZZ' })]
              : [
                  operation('UPD-001-1', 'succeeded'),
                  operation('UPD-001-2', 'succeeded'),
                  operation('UPD-001-3', 'succeeded'),
                  operation('STS-002-1', 'succeeded', {
                    operation: 'reenable',
                    field: null,
                  }),
                ],
          ),
        );
      }
      if (path.includes('/report?')) {
        const page = new URL(path, 'http://localhost').searchParams.get('page');
        return response(page === '1' ? second : first);
      }
      return response(
        importDetail({
          plan: executedPlan,
          planJobs: finishedJobs,
          executionCounts: {
            succeeded: 14,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: 0,
            notRun: 0,
          },
        }),
      );
    });
    const { store, render, text, request: calls } = setup(request);
    store.openJob('IMP-001');
    await render();
    expect(text()).toContain('Rows 1–4 of 14 changes');

    store.nextReportPage();
    await render();

    expect(store.reportPage()).toBe(1);
    expect(text()).toContain('Rows 11–11 of 14 changes');
    const numbers = calls.mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.includes('/operations?'))
      .map((path) =>
        new URL(path, 'http://localhost').searchParams.get('number'),
      );
    // Each page reads its own operations: the second page asks for its one operation.
    expect(numbers).toContain('9');
  });

  it('opens the results from the Activity row of an executed import', async () => {
    const request = api({
      detail: () =>
        importDetail({
          plan: executedPlan,
          planJobs: finishedJobs,
          executionCounts: {
            succeeded: 4,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: 0,
            notRun: 0,
          },
        }),
      proposed: () => report({ plan: executedPlan }),
      failed: () => report({ view: 'failed', lines: [], total: 0 }),
      operations: () => [operation('UPD-001-1', 'succeeded')],
    });
    const { store, render, text, panel } = setup(request);
    // The Devices page opens the dialog at `/devices?job=IMP-001` (behavior 5).
    store.openJob('IMP-001');
    await render();

    expect(store.step()).toBe('results');
    expect(text()).toContain('Executed by Review administrator');
    // The results section carries its own accessible name (section 8).
    expect(
      panel()?.querySelector('section[aria-label="Execution results"]'),
    ).not.toBeNull();
  });

  it('keeps one shared feed and opens no EventSource of its own', async () => {
    const request = api({
      detail: () =>
        importDetail({
          plan: executedPlan,
          planJobs: finishedJobs,
          executionCounts: {
            succeeded: 4,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: 0,
            notRun: 0,
          },
        }),
      proposed: () => report({ plan: executedPlan }),
      failed: () => report({ view: 'failed', lines: [], total: 0 }),
      operations: () => [operation('UPD-001-1', 'succeeded')],
    });
    const { store, render, sources } = setup(request);
    store.openJob('IMP-001');
    await render();
    store.openConfirm();
    await render();
    await store.execute();
    await render();
    store.nextReportPage();
    await render();

    expect(sources).toEqual([{ url: '/api/events' }]);
  });

  it('keeps the Execute confirmation and its phrase across unchanged-plan rereads', async () => {
    let plan: JobImportPlan = { ...openPlan };
    const request = api({
      detail: () => importDetail({ plan }),
      proposed: () => report({ plan }),
      failed: () => report({ view: 'failed', plan, lines: [], total: 0 }),
      operations: () => [],
    });
    const { store, render, text } = setup(request);
    store.openJob('IMP-001');
    await render();
    store.openConfirm();
    await render();
    store.typedPhrase.set('DEPROVISION');
    await render();

    // A late initial-open read and a later reread of the same frozen plan keep the step.
    store.openJob('IMP-001');
    await render();
    expect(store.step()).toBe('confirm');
    expect(store.typedPhrase()).toBe('DEPROVISION');
    expect(text()).toContain('Execute 4 changes on 4 devices?');

    // A relevant plan change invalidates the confirmation and reads the new plan.
    plan = { ...openPlan, revision: 3 };
    store.openJob('IMP-001');
    await render();
    expect(store.step()).toBe('report');
    expect(store.plan()?.revision).toBe(3);
  });

  it('leaves the confirmation when the plan is cancelled', async () => {
    let plan: JobImportPlan = { ...openPlan };
    const request = api({
      detail: () => importDetail({ plan }),
      proposed: () => report({ plan }),
      failed: () => report({ view: 'failed', plan, lines: [], total: 0 }),
      operations: () => [],
    });
    const { store, render, text } = setup(request);
    store.openJob('IMP-001');
    await render();
    store.openConfirm();
    await render();
    expect(store.step()).toBe('confirm');

    plan = {
      ...openPlan,
      revision: 3,
      state: 'cancelled',
      changedBy: person,
      changedAt: at(30),
    };
    store.openJob('IMP-001');
    await render();

    expect(store.step()).toBe('report');
    expect(store.plan()?.state).toBe('cancelled');
    expect(text()).toContain('Cancelled by Review administrator');
  });

  it('counts devices, changes, and status jobs in their own units', async () => {
    const overlapping = report({
      counts: {
        rows: 8,
        unchanged: 0,
        noChangeNeeded: 0,
        proposed: 4,
        rejected: 4,
      },
      changes: {
        fieldChanges: 5,
        fieldChangeDevices: 3,
        disable: 2,
        reenable: 0,
        deprovision: [],
      },
      total: 7,
    });
    const request = api({
      detail: () => importDetail(),
      proposed: () => overlapping,
      failed: () => report({ view: 'failed', lines: [], total: 0 }),
      operations: () => [],
    });
    const { store, render, text, panel } = setup(request);
    store.openJob('IMP-001');
    await render();
    store.openConfirm();
    await render();

    // Seven change lines on four proposed rows. A field change and a Disable of one device
    // count once in the device total (R2).
    expect(text()).toContain('Execute 7 changes on 4 devices?');
    // One status job for the Disable action, not one for each disabled device (R2).
    expect(text()).toContain(
      'Execute creates two jobs. The update job runs first. The status job starts after it ends.',
    );
    const actions = [...(panel()?.querySelectorAll('.seq-job') ?? [])]
      .map((job) =>
        job.querySelector('.seq-action > span')?.textContent?.trim(),
      )
      .filter((action) => action);
    expect(actions).toEqual(['Update device annotations', 'Disable devices']);
  });

  it('matches the API phrase comparison exactly', async () => {
    let executed = false;
    const request = api(
      {
        detail: () =>
          executed
            ? importDetail({
                plan: executedPlan,
                planJobs: runningJobs,
                executionCounts: {
                  succeeded: 0,
                  failed: 0,
                  unknown: 0,
                  skipped: 0,
                  expired: 0,
                  cancelled: 0,
                  pending: 1,
                  notRun: 0,
                },
              })
            : importDetail(),
        proposed: () =>
          report({
            plan: executed ? executedPlan : openPlan,
            changes: {
              fieldChanges: 3,
              fieldChangeDevices: 3,
              disable: 0,
              reenable: 1,
              deprovision: [
                { reason: 'DEPROVISION_REASON_RETIRING_DEVICE', devices: 1 },
              ],
            },
          }),
        failed: () => report({ view: 'failed', lines: [], total: 0 }),
        operations: () => [],
      },
      () => {
        executed = true;
        return response(executeAnswer());
      },
    );
    const { store, render, text, panel, request: calls } = setup(request);
    store.openJob('IMP-001');
    await render();
    store.openConfirm();
    await render();

    const input = panel()?.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('the typed phrase field is missing');
    const execute = () =>
      [...(panel()?.querySelectorAll('button') ?? [])].find((candidate) =>
        /^Execute \d+ changes$/.test(
          candidate.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        ),
      );

    // The API compares the trimmed phrase exactly, so lowercase never enables Execute (R3).
    input.value = 'deprovision';
    input.dispatchEvent(new Event('input'));
    await render();
    expect(execute()?.disabled).toBe(true);
    expect(text()).toContain('The phrase does not match. Type DEPROVISION.');

    // Whitespace around the exact phrase matches, and the request sends the trimmed phrase.
    input.value = ' DEPROVISION ';
    input.dispatchEvent(new Event('input'));
    await render();
    expect(execute()?.disabled).toBe(false);
    await execute()?.click();
    await render();

    const post = calls.mock.calls.find(([path]) =>
      String(path).endsWith('/execute'),
    );
    expect(post?.[1]).toEqual({
      planId,
      planRevision: 2,
      typedPhrase: 'DEPROVISION',
    });
    expect(store.step()).toBe('results');
  });

  it('runs one complete results read at a time and coalesces an event during it', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detailReads = 0;
    let reportReads = 0;
    let operationsReads = 0;
    let impRevision = 8;
    const request = vi.fn(async (path: string) => {
      if (path.includes('/operations?')) {
        operationsReads += 1;
        await gate;
        return response(
          operationsPage([
            operation('UPD-001-1', 'succeeded'),
            operation('STS-002-1', 'pending', {
              operation: 'reenable',
              field: null,
            }),
          ]),
        );
      }
      if (path.includes('/report?')) {
        reportReads += 1;
        const view = new URL(path, 'http://localhost').searchParams.get('view');
        return response(
          view === 'failed'
            ? report({
                view: 'failed',
                plan: executedPlan,
                lines: [],
                total: 0,
              })
            : report({ plan: executedPlan }),
        );
      }
      detailReads += 1;
      return response(
        importDetail({
          revision: impRevision,
          plan: executedPlan,
          planJobs: runningJobs,
          executionCounts: {
            succeeded: 1,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: 1,
            notRun: 0,
          },
        }),
      );
    });
    const { store, render, emit } = setup(request);
    store.openJob('IMP-001');
    await render();
    expect(detailReads).toBe(1);
    expect(reportReads).toBe(2);
    expect(operationsReads).toBe(2);

    // Two newer plan-job events arrive while the first operations read is held.
    emit('job-changed', jobEvent(statusJobId, 'STS-002', 5));
    await new Promise((resolve) => setTimeout(resolve, 300));
    impRevision = 9;
    emit('job-changed', jobEvent(statusJobId, 'STS-002', 6));
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The detail read waits for the whole cycle, so no second page or operations read starts
    // while the first one is held (R4).
    expect(detailReads).toBe(1);
    expect(reportReads).toBe(2);
    expect(operationsReads).toBe(2);
    release();
    await render();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await render();

    // The events coalesce into one later complete cycle of the page and its operations (R4).
    expect(detailReads).toBe(2);
    expect(reportReads).toBe(4);
    expect(operationsReads).toBe(4);
  });

  it('reconciles the results page after reentry when only a child job changed', async () => {
    let childRevision = 4;
    let status: 'running' | 'failed' = 'running';
    let outcome: 'pending' | 'failed' = 'pending';
    const jobs = (): JobSummary[] => [
      runningJobs[0],
      {
        ...runningJobs[1],
        revision: childRevision,
        status,
        progress: {
          total: 1,
          succeeded: status === 'failed' ? 0 : 0,
          failed: status === 'failed' ? 1 : 0,
          unknown: 0,
          skipped: 0,
          expired: 0,
          cancelled: 0,
          pending: status === 'failed' ? 0 : 1,
        },
      },
    ];
    const proposedLines = () => [
      report().lines[0],
      report().lines[1],
      report().lines[2],
      { ...report().lines[3], outcome },
    ];
    const request = vi.fn(async (path: string) => {
      if (path.includes('/operations?')) {
        return response(
          operationsPage([
            operation('UPD-001-1', 'succeeded'),
            operation('UPD-001-2', 'succeeded'),
            operation('UPD-001-3', 'succeeded'),
            operation('STS-002-1', outcome, {
              operation: 'reenable',
              field: null,
              baselineValue: 'DISABLED',
              requestedValue: 'ACTIVE',
              outcomeReason: outcome === 'failed' ? 'status-conflict' : null,
              googleReason:
                outcome === 'failed'
                  ? 'A device with status ACTIVE does not allow this action.'
                  : null,
            }),
          ]),
        );
      }
      if (path.includes('/report?')) {
        const view = new URL(path, 'http://localhost').searchParams.get('view');
        if (view === 'failed') {
          const lines = outcome === 'failed' ? [proposedLines()[3]] : [];
          return response(
            report({
              view: 'failed',
              plan: executedPlan,
              lines,
              total: lines.length,
            }),
          );
        }
        return response(report({ plan: executedPlan, lines: proposedLines() }));
      }
      return response(
        importDetail({
          // The IMP header revision stays the same; only the child job changes (R5).
          revision: 8,
          plan: executedPlan,
          planJobs: jobs(),
          executionCounts: {
            succeeded: outcome === 'failed' ? 3 : 2,
            failed: outcome === 'failed' ? 1 : 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: outcome === 'failed' ? 0 : 1,
            notRun: 0,
          },
        }),
      );
    });
    const { store, render, panel } = setup(request);
    store.openJob('IMP-001');
    await render();
    const resultCells = () =>
      [...(panel()?.querySelectorAll('td.col-result') ?? [])].map((cell) =>
        cell.textContent?.replace(/\s+/g, ' ').trim(),
      );
    expect(resultCells()[3]).toBe('Pending Starts after UPD-001 ends');

    // The dialog closes, the child job fails, and the IMP revision never changes.
    store.close();
    status = 'failed';
    outcome = 'failed';
    childRevision = 5;
    store.openJob('IMP-001');
    await render();
    expect(store.step()).toBe('results');
    expect(resultCells()[3]).toContain('Failed');
    expect(resultCells()[3]).toContain(
      'A device with status ACTIVE does not allow this action.',
    );

    // The Failed tab keeps its page. A change that moves from failed to unknown leaves it.
    await store.setReportView('failed');
    await render();
    expect(resultCells()).toHaveLength(1);

    store.close();
    outcome = 'pending';
    childRevision = 6;
    store.openJob('IMP-001');
    await render();
    expect(store.reportView()).toBe('failed');
    expect(store.reportPage()).toBe(0);
    expect(resultCells()).toHaveLength(0);
  });

  it('describes a lost Execute answer as unconfirmed and keeps the plan identity', async () => {
    let failNext = true;
    let executed = false;
    const request = vi.fn(async (path: string, _body?: unknown) => {
      if (path.endsWith('/execute')) {
        if (failNext) {
          failNext = false;
          throw new TypeError('The answer was lost.');
        }
        executed = true;
        return response(executeAnswer());
      }
      if (path.includes('/operations?')) {
        return response(operationsPage([operation('UPD-001-1', 'pending')]));
      }
      if (path.includes('/report?')) {
        const view = new URL(path, 'http://localhost').searchParams.get('view');
        return response(
          view === 'failed'
            ? report({
                view: 'failed',
                plan: executedPlan,
                lines: [],
                total: 0,
              })
            : report({ plan: executed ? executedPlan : openPlan }),
        );
      }
      return response(
        importDetail(
          executed
            ? {
                plan: executedPlan,
                planJobs: runningJobs,
                executionCounts: {
                  succeeded: 0,
                  failed: 0,
                  unknown: 0,
                  skipped: 0,
                  expired: 0,
                  cancelled: 0,
                  pending: 1,
                  notRun: 0,
                },
              }
            : {},
        ),
      );
    });
    const { store, render, text, request: calls } = setup(request);
    store.openJob('IMP-001');
    await render();
    store.openConfirm();
    await render();

    await expect(store.execute()).resolves.toBe(false);
    await render();

    // The lost answer never claims that the plan did not run (R6).
    expect(text()).toContain(
      'Cannot reach Campus Commander. The plan may have run. Check this import before you execute again.',
    );
    expect(text()).not.toContain('The plan did not run.');
    // The reread keeps the confirmation and the original plan identity.
    expect(store.step()).toBe('confirm');
    expect(store.plan()?.planId).toBe(planId);
    expect(store.plan()?.revision).toBe(2);

    // A retry reuses the same plan identity.
    await expect(store.execute()).resolves.toBe(true);
    await render();
    const posts = calls.mock.calls.filter(([path]) =>
      String(path).endsWith('/execute'),
    );
    expect(posts).toHaveLength(2);
    expect(posts[0][1]).toEqual(posts[1][1]);
    expect(store.step()).toBe('results');
  });

  it('drops the wait note once the update job has finished', async () => {
    const jobs = (): JobSummary[] => [
      {
        ...runningJobs[0],
        status: 'completed',
        finishedAt: at(60),
        progress: {
          total: 3,
          succeeded: 3,
          failed: 0,
          unknown: 0,
          skipped: 0,
          expired: 0,
          cancelled: 0,
          pending: 0,
        },
      },
      {
        ...runningJobs[1],
        revision: 5,
        status: 'running',
        progress: {
          total: 1,
          succeeded: 0,
          failed: 0,
          unknown: 0,
          skipped: 0,
          expired: 0,
          cancelled: 0,
          pending: 1,
        },
      },
    ];
    const request = api({
      detail: () =>
        importDetail({
          plan: executedPlan,
          planJobs: jobs(),
          executionCounts: {
            succeeded: 0,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: 1,
            notRun: 0,
          },
        }),
      proposed: () =>
        report({
          plan: executedPlan,
          lines: [
            report().lines[0],
            report().lines[1],
            report().lines[2],
            { ...report().lines[3], outcome: 'pending' },
          ],
        }),
      failed: () =>
        report({ view: 'failed', plan: executedPlan, lines: [], total: 0 }),
      operations: () => [
        operation('UPD-001-1', 'succeeded'),
        operation('UPD-001-2', 'succeeded'),
        operation('UPD-001-3', 'succeeded'),
        operation('STS-002-1', 'pending', {
          operation: 'reenable',
          field: null,
          baselineValue: 'DISABLED',
          requestedValue: 'ACTIVE',
        }),
      ],
    });
    const { store, render, panel } = setup(request);
    store.openJob('IMP-001');
    await render();
    const cells = [...(panel()?.querySelectorAll('td.col-result') ?? [])].map(
      (cell) => cell.textContent?.replace(/\s+/g, ' ').trim(),
    );
    // The update job ended, so its wait note is gone (R7).
    expect(cells[3]).toBe('Pending');
  });

  it('shows no wait note for a status-only plan', async () => {
    const request = api({
      detail: () =>
        importDetail({
          plan: executedPlan,
          planJobs: [
            {
              ...runningJobs[1],
              revision: 5,
              status: 'running',
              progress: {
                total: 1,
                succeeded: 0,
                failed: 0,
                unknown: 0,
                skipped: 0,
                expired: 0,
                cancelled: 0,
                pending: 1,
              },
            },
          ],
          executionCounts: {
            succeeded: 0,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: 1,
            notRun: 0,
          },
        }),
      proposed: () =>
        report({
          plan: executedPlan,
          lines: [
            report().lines[0],
            report().lines[1],
            report().lines[2],
            { ...report().lines[3], outcome: 'pending' },
          ],
        }),
      failed: () =>
        report({ view: 'failed', plan: executedPlan, lines: [], total: 0 }),
      operations: () => [
        operation('UPD-001-1', 'succeeded'),
        operation('UPD-001-2', 'succeeded'),
        operation('UPD-001-3', 'succeeded'),
        operation('STS-002-1', 'pending', {
          operation: 'reenable',
          field: null,
          baselineValue: 'DISABLED',
          requestedValue: 'ACTIVE',
        }),
      ],
    });
    const { store, render, panel } = setup(request);
    store.openJob('IMP-001');
    await render();
    const cells = [...(panel()?.querySelectorAll('td.col-result') ?? [])].map(
      (cell) => cell.textContent?.replace(/\s+/g, ' ').trim(),
    );
    // A status-only plan has no update job to wait for (R7).
    expect(cells[3]).toBe('Pending');
  });
});
