import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import {
  devicePageSchema,
  type JobSummary,
} from '@campus/application-contracts';
import { installLiveStreams, liveStreams } from './live-streams';

/**
 * States 01 to 08 of the Export, Reports, and Import dialog
 * (`docs/ui/designs/2026-10-28-device-export-import-0*.png`) against a mocked API.
 */
const customerId = 'C0123456';
const observedAt = '2026-10-19T12:00:00.000Z';
const expJobId = '0f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const reportJobId = '1f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a11';
const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'District operator',
};
const grants = [
  { action: 'devices:read', scope: { kind: 'district', customerId } },
  { action: 'devices:write', scope: { kind: 'district', customerId } },
  { action: 'devices:bulk-actions', scope: { kind: 'district', customerId } },
  { action: 'devices:export', scope: { kind: 'district', customerId } },
  { action: 'connection:diagnose', scope: { kind: 'district', customerId } },
];
const rows = Array.from({ length: 6 }, (_, index) => ({
  deviceId: `synthetic-device-${index + 1}`,
  serialNumber: `C0A1-000${index + 1}`,
  model: 'Lenovo 100e Gen 4',
  assetTag: `HS-040${index + 1}`,
  orgUnitPath: '/School A',
  lastContact: '2026-10-19T11:58:00Z',
  annotatedLocation: null,
  annotatedUser: null,
  notes: null,
  status: 'ACTIVE',
  battery: {
    status: 'reported',
    health: 'normal',
    capacityPercent: 91,
    reportedAt: '2026-10-19T11:00:00Z',
  },
  lastEntitySync: observedAt,
  stale: false,
}));

const expiry = () =>
  new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

/** The own running export row of the Activity panel (behavior 5). */
const activityJob: JobSummary = {
  jobId: expJobId,
  displayId: 'EXP-001',
  revision: 2,
  action: 'export-devices',
  status: 'running',
  scope: { kind: 'devices', deviceCount: rows.length },
  requestedBy: person,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  startedAt: new Date(Date.now() - 50_000).toISOString(),
  finishedAt: null,
  progress: {
    total: rows.length,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: rows.length,
  },
  phase: { name: 'write-rows', done: 3, total: rows.length },
  exportSummary: { purpose: 'edit' },
  importSummary: null,
  failure: null,
  cancelRequest: null,
};

/** The own import row of the Activity panel (behavior 5, results). */
const impActivityJob = (): JobSummary => ({
  jobId: impJobId,
  displayId: 'IMP-001',
  revision: 8,
  action: 'validate-device-import',
  status: 'running',
  scope: { kind: 'rows', deviceCount: 16 },
  requestedBy: person,
  createdAt: at(600),
  startedAt: at(580),
  finishedAt: null,
  progress: {
    total: 16,
    succeeded: 16,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: 0,
  },
  phase: null,
  exportSummary: null,
  importSummary: {
    mode: 'sync-changes',
    planState: 'executed',
    proposed: 12,
    rejected: 4,
    refusal: null,
  },
  failure: null,
  cancelRequest: null,
});

const exportJob = (
  displayId: string,
  purpose: 'edit' | 'report',
  state: 'running' | 'completed',
) => ({
  jobId: displayId === 'EXP-001' ? expJobId : reportJobId,
  displayId,
  revision: state === 'running' ? 2 : 4,
  action: 'export-devices',
  status: state === 'running' ? 'running' : 'completed',
  scope: { kind: 'devices', deviceCount: rows.length },
  requestedBy: person,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  startedAt: new Date(Date.now() - 50_000).toISOString(),
  finishedAt: state === 'running' ? null : new Date().toISOString(),
  progress: {
    total: rows.length,
    // Production writes the phase counters; the outcome counters stay zero while it runs.
    succeeded: state === 'running' ? 0 : rows.length,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    pending: state === 'running' ? rows.length : 0,
  },
  phase:
    state === 'running'
      ? { name: 'write-rows', done: 3, total: rows.length }
      : null,
  exportSummary: { purpose },
  exportFile:
    state === 'running'
      ? null
      : {
          name:
            purpose === 'edit'
              ? `devices-for-editing-${displayId}.csv`
              : `device-report-${displayId}.csv`,
          sizeBytes: 7987,
          rows: rows.length,
          columns: purpose === 'edit' ? 10 : 6,
          expiresAt: expiry(),
        },
  importSummary: null,
  cancelRequest: null,
  failure: null,
  confirmedBy: null,
  previewDisplayId: null,
  changes: null,
  commandType: null,
  statusAction: null,
  deprovisionReason: null,
  targetOrgUnitPaths: null,
  importSource: null,
  plan: null,
  importDisplayId: null,
  waitsForDisplayId: null,
  waitingDisplayIds: null,
  planJobs: null,
  executionCounts: null,
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: new Date().toISOString(),
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
});

interface MockOptions {
  /** The server-side selection count. State 03 holds 62,480. */
  selectedCount?: number;
  /** The job state that a read of EXP-001 answers. */
  state?: 'running' | 'completed';
  /** The theme of the stored preferences (state 13 of the dark theme). */
  theme?: 'light' | 'dark';
  /** The import that `/devices?job=IMP-001` opens: its plan state (states 13, 16, 17, and 17b). */
  importRun?: 'open' | 'running' | 'finished';
  /** Holds the next IMP-001 detail read, so a test can hold the detail it starts (R4). */
  holdDetail?: DetailHold;
}

/** A hold on one IMP-001 detail read, and the results reads that the page requests (R4). */
interface DetailHold {
  armed: boolean;
  wait: Promise<void>;
  counts: { detail: number; report: number; operations: number };
  arm: () => void;
  release: () => void;
}

function detailHold(): DetailHold {
  let release: () => void = () => undefined;
  const hold: DetailHold = {
    armed: false,
    wait: Promise.resolve(),
    counts: { detail: 0, report: 0, operations: 0 },
    arm: () => {
      hold.armed = true;
      hold.wait = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release(),
  };
  return hold;
}

const impJobId = '1c1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a11';
const updJobId = '2c1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a12';
const stsDisableId = '3c1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a13';
const stsReenableId = '4c1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a14';
const stsDeprovisionId = '5c1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a15';
const planId = '6c1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a16';
const at = (secondsAgo: number) =>
  new Date(Date.now() - secondsAgo * 1000).toISOString();

const openPlan = {
  planId,
  revision: 2,
  state: 'open' as const,
  expiresAt: expiry(),
  changedBy: null,
  changedAt: null,
};
const executedPlan = {
  planId,
  revision: 3,
  state: 'executed' as const,
  expiresAt: expiry(),
  changedBy: person,
  changedAt: at(120),
};

/** The nine field changes of the plan, across five devices. */
const fieldRows = [
  ['C0A1-0001', '01P0T1V', 'annotatedLocation', 'Room 12', 'Room 14'],
  ['C0A1-0001', '01P0T1V', 'notes', null, 'Returned to library'],
  ['C0A1-0002', '02A1MB6', 'annotatedLocation', 'North lab', 'Room 14'],
  ['C0A1-0002', '02A1MB6', 'notes', 'Loaner', null],
  ['C0A1-0003', '02QJANY', 'orgUnitPath', '/Chrome Devices/Lowell', '/Library'],
  ['C0A1-0003', '02QJANY', 'annotatedUser', null, 'reviewer@example.org'],
  ['C0A1-0004', '04A9BVS', 'notes', 'Not set', 'Retired'],
  ['C0A1-0005', '04QVJBY', 'annotatedLocation', 'Front Office', 'Room 14'],
  ['C0A1-0005', '04QVJBY', 'notes', null, 'No battery report'],
] as const;

const fieldChange = (
  field: string,
  currentValue: string | null,
  newValue: string | null,
) => ({
  type: 'field' as const,
  field,
  operation: newValue === null ? ('clear' as const) : ('replace' as const),
  currentValue,
  newValue,
});

/** The 12 changes of the plan, in report order. The status rows sit inside the first page. */
const planLines = (
  run: 'open' | 'running' | 'finished',
): Array<Record<string, unknown>> => {
  const executed = run !== 'open';
  const fieldLines = fieldRows.map(
    ([deviceId, serialNumber, field, from, to]) => ({
      kind: 'field' as const,
      deviceId,
      serialNumber,
      change: fieldChange(field, from, to),
    }),
  );
  const statusLines = [
    {
      kind: 'status' as const,
      deviceId: 'C0A1-0006',
      serialNumber: '0727D2E',
      change: {
        type: 'status' as const,
        action: 'disable' as const,
        reason: null,
        currentValue: 'ACTIVE',
        newValue: 'DISABLED',
      },
    },
    {
      kind: 'status' as const,
      deviceId: 'C0A1-0007',
      serialNumber: '04XTBHJ',
      change: {
        type: 'status' as const,
        action: 'reenable' as const,
        reason: null,
        currentValue: 'DISABLED',
        newValue: 'ACTIVE',
      },
    },
    {
      kind: 'status' as const,
      deviceId: 'C0A1-0008',
      serialNumber: '08V5B5S',
      change: {
        type: 'status' as const,
        action: 'deprovision' as const,
        reason: 'DEPROVISION_REASON_RETIRING_DEVICE' as const,
        currentValue: 'ACTIVE',
        newValue: 'DEPROVISIONED',
      },
    },
  ];
  // A file may hold the status rows anywhere: these sit on the first page, so state 16 can
  // name the Deprovision device from the page it already read (design section 7).
  const ordered = [
    ...fieldLines.slice(0, 7),
    ...statusLines,
    ...fieldLines.slice(7),
  ];
  // A source row holds one device. The changes of one device share its Row and Device cells
  // (ruling 2), so the row number follows the first appearance of the device.
  const rows = new Map<string, number>();
  let nextRow = 2;
  for (const line of ordered) {
    if (!rows.has(line.deviceId)) rows.set(line.deviceId, nextRow++);
  }
  return ordered.map((line, index) => {
    const status = line.kind === 'status' ? line.change : null;
    return {
      row: rows.get(line.deviceId),
      deviceId: line.deviceId,
      serialNumber: line.serialNumber,
      change: line.change,
      column: null,
      submittedValue: null,
      reason: null,
      notRun: null,
      jobDisplayId: !executed
        ? null
        : line.kind === 'field'
          ? 'UPD-001'
          : status?.action === 'disable'
            ? 'STS-001'
            : status?.action === 'reenable'
              ? 'STS-002'
              : 'STS-003',
      operationNumber: !executed ? null : line.kind === 'field' ? index + 1 : 1,
      outcome: !executed
        ? null
        : line.kind === 'field'
          ? index < 3 || run === 'finished'
            ? 'succeeded'
            : 'pending'
          : status?.action === 'reenable' && run === 'finished'
            ? 'failed'
            : run === 'finished'
              ? 'succeeded'
              : 'pending',
    };
  });
};

const changeCounts = {
  fieldChanges: 9,
  fieldChangeDevices: 5,
  disable: 1,
  reenable: 1,
  deprovision: [{ reason: 'DEPROVISION_REASON_RETIRING_DEVICE', devices: 1 }],
};

/** One page of the report route. The results hold two views: all changes and failed. */
const importReport = (
  run: 'open' | 'running' | 'finished',
  view: 'proposed' | 'failed',
  page: number,
) => {
  const all = planLines(run);
  const failed =
    run === 'finished'
      ? all.filter((line) => line['outcome'] === 'failed')
      : [];
  const lines =
    view === 'failed' ? failed : all.slice(page * 10, page * 10 + 10);
  return {
    jobId: impJobId,
    displayId: 'IMP-001',
    view,
    page,
    pageCount: view === 'failed' ? 1 : 2,
    counts: {
      // Twelve source rows: eight proposed devices and four rejected rows.
      rows: 12,
      unchanged: 0,
      noChangeNeeded: 0,
      proposed: 8,
      rejected: 4,
    },
    refresh: { staleDevicesRead: 8, oldestObservedAt: at(3600) },
    changes: changeCounts,
    lines,
    total: view === 'failed' ? failed.length : 12,
    plan: run === 'open' ? openPlan : executedPlan,
  };
};

const summaryOf = (
  jobId: string,
  displayId: string,
  action: string,
  status: string,
  deviceCount: number,
  progress: Record<string, number>,
  finishedAt: string | null,
  /** The operations of the job. The update job holds one for each device and field. */
  operations: number = deviceCount,
) => ({
  jobId,
  displayId,
  revision: status === 'running' ? 3 : 5,
  action,
  status,
  scope: { kind: 'devices', deviceCount },
  requestedBy: person,
  createdAt: at(300),
  startedAt: at(280),
  finishedAt,
  progress: {
    total: operations,
    failed: 0,
    unknown: 0,
    skipped: 0,
    expired: 0,
    cancelled: 0,
    ...progress,
  },
  phase: null,
  exportSummary: null,
  importSummary: null,
  failure: null,
  cancelRequest: null,
});

/** The four jobs of the plan: the update job first, then the three status jobs. */
const planJobs = (run: 'running' | 'finished') =>
  run === 'finished'
    ? [
        summaryOf(
          updJobId,
          'UPD-001',
          'update-device-annotations',
          'completed',
          5,
          { succeeded: 9, pending: 0 },
          at(150),
          9,
        ),
        summaryOf(
          stsDisableId,
          'STS-001',
          'disable-devices',
          'completed',
          1,
          { succeeded: 1, pending: 0 },
          at(120),
        ),
        summaryOf(
          stsReenableId,
          'STS-002',
          'reenable-devices',
          'failed',
          1,
          { succeeded: 0, failed: 1, pending: 0 },
          at(90),
        ),
        summaryOf(
          stsDeprovisionId,
          'STS-003',
          'deprovision-devices',
          'completed',
          1,
          { succeeded: 1, pending: 0 },
          at(60),
        ),
      ]
    : [
        summaryOf(
          updJobId,
          'UPD-001',
          'update-device-annotations',
          'running',
          5,
          { succeeded: 3, pending: 6 },
          null,
          9,
        ),
        summaryOf(
          stsDisableId,
          'STS-001',
          'disable-devices',
          'queued',
          1,
          { succeeded: 0, pending: 1 },
          null,
        ),
        summaryOf(
          stsReenableId,
          'STS-002',
          'reenable-devices',
          'queued',
          1,
          { succeeded: 0, pending: 1 },
          null,
        ),
        summaryOf(
          stsDeprovisionId,
          'STS-003',
          'deprovision-devices',
          'queued',
          1,
          { succeeded: 0, pending: 1 },
          null,
        ),
      ];

/** The IMP detail: the plan, its jobs, and the counts of the execution (section 8). */
const importDetail = (run: 'open' | 'running' | 'finished') => ({
  jobId: impJobId,
  displayId: 'IMP-001',
  revision: run === 'open' ? 6 : 8,
  action: 'validate-device-import',
  status: 'completed',
  scope: { kind: 'rows', deviceCount: 12 },
  requestedBy: person,
  createdAt: at(600),
  startedAt: at(580),
  finishedAt: at(540),
  progress: {
    total: 12,
    succeeded: 12,
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
  confirmedBy: null,
  previewDisplayId: null,
  changes: null,
  commandType: null,
  statusAction: null,
  deprovisionReason: null,
  targetOrgUnitPaths: null,
  exportFile: null,
  cancelRequest: null,
  importSummary: {
    mode: 'sync-changes',
    planState: run === 'open' ? 'open' : 'executed',
    proposed: 8,
    rejected: 4,
    refusal: null,
  },
  importSource: {
    name: 'devices-for-editing-EXP-001.csv',
    sizeBytes: 8064,
    rowsRead: 12,
    candidateRows: 12,
    refusalText: null,
  },
  plan: run === 'open' ? openPlan : executedPlan,
  importDisplayId: null,
  waitsForDisplayId: null,
  waitingDisplayIds: null,
  planJobs: run === 'open' ? null : planJobs(run),
  executionCounts:
    run === 'open'
      ? null
      : run === 'running'
        ? {
            succeeded: 3,
            failed: 0,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: 9,
            notRun: 0,
          }
        : {
            succeeded: 11,
            failed: 1,
            unknown: 0,
            skipped: 0,
            expired: 0,
            cancelled: 0,
            pending: 0,
            notRun: 0,
          },
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: at(60),
    failed:
      run === 'finished'
        ? {
            count: 1,
            operations: [
              {
                operationId: 'STS-002-1',
                deviceId: 'C0A1-0007',
                serialNumber: '04XTBHJ',
                outcomeReason: 'status-conflict',
                googleStatus: 400,
                googleReason:
                  'A device with status ACTIVE does not allow this action.',
                updatedAt: at(90),
              },
            ],
          }
        : { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
});

const operationsOf = (run: 'running' | 'finished', job: string) => {
  if (job === 'UPD-001')
    return fieldRows.map(
      ([deviceId, serialNumber, field, from, to], index) => ({
        operationId: `UPD-001-${index + 1}`,
        deviceId,
        serialNumber,
        orgUnitPath: '/Chrome Devices/Lowell',
        field,
        operation: to === null ? 'clear' : 'replace',
        baselineValue: from,
        requestedValue: to,
        outcome: index < 3 || run === 'finished' ? 'succeeded' : 'pending',
        outcomeReason: null,
        googleStatus: index < 3 || run === 'finished' ? 200 : null,
        googleReason: null,
        observedValue: index < 3 || run === 'finished' ? to : null,
        verifiedBy: index < 3 || run === 'finished' ? 'write-response' : null,
        commandId: null,
        commandState: null,
        commandExpiresAt: null,
        commandExecutedAt: null,
        updatedAt: at(60),
      }),
    );
  const row = (
    {
      'STS-001': {
        deviceId: 'C0A1-0006',
        serialNumber: '0727D2E',
        baselineValue: 'ACTIVE',
        requestedValue: 'DISABLED',
      },
      'STS-002': {
        deviceId: 'C0A1-0007',
        serialNumber: '04XTBHJ',
        baselineValue: 'DISABLED',
        requestedValue: 'ACTIVE',
      },
      'STS-003': {
        deviceId: 'C0A1-0008',
        serialNumber: '08V5B5S',
        baselineValue: 'ACTIVE',
        requestedValue: 'DEPROVISIONED',
      },
    } as Record<
      string,
      {
        deviceId: string;
        serialNumber: string;
        baselineValue: string;
        requestedValue: string;
      }
    >
  )[job];
  if (!row) return [];
  const failed = job === 'STS-002' && run === 'finished';
  return [
    {
      operationId: `${job}-1`,
      deviceId: row.deviceId,
      serialNumber: row.serialNumber,
      orgUnitPath: '/Chrome Devices/Lowell',
      field: null,
      operation:
        job === 'STS-001'
          ? 'disable'
          : job === 'STS-002'
            ? 'reenable'
            : 'deprovision',
      baselineValue: row.baselineValue,
      requestedValue: row.requestedValue,
      outcome:
        run === 'finished' ? (failed ? 'failed' : 'succeeded') : 'pending',
      outcomeReason: failed ? 'status-conflict' : null,
      googleStatus: failed ? 400 : null,
      googleReason: failed
        ? 'A device with status ACTIVE does not allow this action.'
        : null,
      observedValue: null,
      verifiedBy: null,
      commandId: null,
      commandState: null,
      commandExpiresAt: null,
      commandExecutedAt: null,
      updatedAt: at(60),
    },
  ];
};

/** The answer of Execute: the executed plan and one receipt for each job it created. */
const executeAnswer = {
  plan: executedPlan,
  receipts: [
    {
      jobId: updJobId,
      displayId: 'UPD-001',
      action: 'update-device-annotations',
      status: 'accepted',
      deviceCount: 9,
    },
    {
      jobId: stsDisableId,
      displayId: 'STS-001',
      action: 'disable-devices',
      status: 'accepted',
      deviceCount: 1,
    },
    {
      jobId: stsReenableId,
      displayId: 'STS-002',
      action: 'reenable-devices',
      status: 'accepted',
      deviceCount: 1,
    },
    {
      jobId: stsDeprovisionId,
      displayId: 'STS-003',
      action: 'deprovision-devices',
      status: 'accepted',
      deviceCount: 1,
    },
  ],
  conflicts: 0,
  excluded: 0,
};

/** The Devices page needs the session, a published inventory, and the export routes. */
async function signIn(page: Page, options: MockOptions = {}) {
  await installLiveStreams(page);
  const selectedCount = options.selectedCount ?? rows.length;
  const state = {
    job: options.state ?? ('running' as 'running' | 'completed'),
  };
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/application')
      return route.fulfill({
        json: {
          phase: 3,
          authenticationConfigured: true,
          version: 'development',
          build: 'client-review',
        },
      });
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          identity: {
            ...person,
            permissionVersion: 1,
            permissions: [],
            grants,
            preferences: {
              theme: options.theme ?? 'light',
              navigationCollapsed: false,
            },
          },
          csrfToken: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    if (path === '/api/devices/selection')
      return route.fulfill({
        json: {
          selection: {
            terms: [],
            groups: [],
            added: selectedCount,
            excluded: 0,
            selectedCount,
            expiredAt: null,
          },
        },
      });
    if (path === '/api/devices/selection/resolve')
      return route.fulfill({ json: { selected: {} } });
    if (path === '/api/devices/sync')
      return route.fulfill({
        json: {
          sync: {
            customerId,
            generation: 1,
            status: 'ready',
            observedAt,
            deviceCount: rows.length,
            failure: null,
            telemetryFailure: null,
            startedAt: null,
            checkedAt: null,
            stale: false,
          },
        },
      });
    if (path === '/api/devices/query')
      return route.fulfill({
        json: {
          page: devicePageSchema.parse({
            rows,
            matching: rows.length,
            total: rows.length,
            observedAt,
            refreshJobId: null,
          }),
        },
      });
    if (path === '/api/devices/freshness')
      return route.fulfill({
        json: { freshness: { stale: 0, refreshing: false } },
      });
    if (path === '/api/devices/org-units')
      return route.fulfill({ json: { orgUnits: [] } });
    if (path === '/api/devices/updates/access')
      return route.fulfill({
        json: {
          state: 'granted',
          scope:
            'https://www.googleapis.com/auth/admin.directory.device.chromeos',
          failure: null,
          checkedAt: observedAt,
        },
      });
    if (
      path === '/api/devices/exports' &&
      route.request().method() === 'POST'
    ) {
      const body = route.request().postDataJSON() as { purpose: string };
      const displayId = body.purpose === 'report' ? 'EXP-002' : 'EXP-001';
      return route.fulfill({
        status: 202,
        json: {
          jobId: displayId === 'EXP-001' ? expJobId : reportJobId,
          displayId,
          status: 'accepted',
          rows: selectedCount,
        },
      });
    }
    if (path === '/api/jobs/EXP-001')
      return route.fulfill({ json: exportJob('EXP-001', 'edit', state.job) });
    if (path === '/api/jobs/EXP-002')
      return route.fulfill({
        json: exportJob('EXP-002', 'report', 'completed'),
      });
    if (path === '/api/jobs/activity/seen')
      return route.fulfill({ json: { seenAt: new Date().toISOString() } });
    if (options.importRun) {
      const run = options.importRun;
      const hold = options.holdDetail;
      if (path === '/api/jobs/IMP-001') {
        if (hold) {
          hold.counts.detail += 1;
          if (hold.armed) {
            hold.armed = false;
            await hold.wait;
          }
        }
        return route.fulfill({ json: importDetail(run) });
      }
      if (path.startsWith('/api/devices/imports/IMP-001/execute'))
        return route.fulfill({ json: executeAnswer });
      if (path === '/api/devices/imports/IMP-001/report') {
        if (hold) hold.counts.report += 1;
        const view =
          url.searchParams.get('view') === 'failed' ? 'failed' : 'proposed';
        const page = Number(url.searchParams.get('page') ?? '0');
        return route.fulfill({ json: importReport(run, view, page) });
      }
      if (path === '/api/devices/imports/IMP-001/rejected')
        return route.fulfill({
          json: {
            ...importReport(run, 'proposed', 0),
            view: 'rejected',
            lines: [],
          },
        });
      const operations = /^\/api\/jobs\/([^/]+)\/operations$/.exec(path);
      if (operations && run !== 'open') {
        if (hold) hold.counts.operations += 1;
        return route.fulfill({
          json: {
            operations: operationsOf(run, operations[1]),
            nextCursor: null,
          },
        });
      }
    }
    if (path === '/api/jobs/activity') {
      // The import row is an executed plan, so its Activity link opens results.
      const jobs = options.importRun
        ? [activityJob, { ...impActivityJob(), status: 'completed' }]
        : [activityJob];
      return route.fulfill({
        json: {
          running: { count: jobs.length, jobs },
          waiting: { count: 0, jobs: [] },
          recent: { count: 0, jobs: [], nextExpiryAt: null },
          attention: false,
          seenAt: null,
          observedAt: new Date().toISOString(),
        },
      });
    }
    if (path === '/api/customer')
      return route.fulfill({ json: { customer: null } });
    if (path === '/api/google-connection')
      return route.fulfill({ json: { connection: null } });
    if (path === '/api/google-connection/health')
      return route.fulfill({ json: { health: null } });
    if (path === '/api/auth/preferences')
      return route.fulfill({ json: route.request().postDataJSON() });
    return route.fulfill({ status: 404, json: {} });
  });
  return state;
}

async function openDevices(page: Page, options: MockOptions = {}) {
  const state = await signIn(page, options);
  await page.goto('/devices');
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('gridcell', { name: 'C0A1-0001', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return state;
}

const dialog = (page: Page) => page.getByRole('dialog');
/** The export dialog alone, while the Activity panel is also open. */
const exportDialog = (page: Page) =>
  page.locator('section[role="dialog"][aria-labelledby="export-dialog-title"]');
const bulk = (page: Page) =>
  page.getByRole('button', { name: 'Bulk Actions', exact: true });

async function openEntry(page: Page, name: string) {
  await bulk(page).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name, exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(dialog(page)).toBeVisible();
}

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const dir = 'dist/e2e-evidence/export-import';
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}

test.use({
  viewport: { width: 1440, height: 900 },
  timezoneId: 'America/New_York',
});

test.describe('Export, Reports, and Import', () => {
  test('state 01: the menu lists the three entries below a divider', async ({
    page,
  }) => {
    await openDevices(page);
    await bulk(page).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS('opacity', '1');
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveText([
      'Update device',
      'Send command',
      'Change status',
      'Export',
      'Reports',
      'Import',
    ]);
    await expect(menu.locator('mat-divider')).toHaveCount(1);
    await shot(page, '01-bulk-actions-menu');
  });

  test('state 02: configure at 480 px', async ({ page }) => {
    await openDevices(page);
    await openEntry(page, 'Export');
    await expect(dialog(page)).toHaveCSS('width', '480px');
    await expect(dialog(page)).toContainText(
      '6 selected devices · Not submitted',
    );
    await expect(dialog(page)).toContainText('CSV file');
    await expect(dialog(page)).toContainText(
      'Google Drive is not available for your account.',
    );
    await expect(
      dialog(page).getByRole('button', { name: 'Export 6 devices' }),
    ).toBeEnabled();
    // The checked CSV card carries the approved accent border and selected surface (state 02).
    await expect(
      dialog(page).locator('mat-radio-button.option-card').first(),
    ).toHaveCSS('border-color', 'rgb(26, 115, 232)');
    await shot(page, '02-export-dialog');
  });

  test('state 03: the over-limit note disables the primary action', async ({
    page,
  }) => {
    await openDevices(page, { selectedCount: 62_480 });
    await openEntry(page, 'Export');
    await expect(dialog(page)).toContainText(
      'An edit export holds at most 50,000 devices.',
    );
    await expect(dialog(page)).toContainText('This selection holds 62,480.');
    await expect(
      dialog(page).getByRole('button', { name: 'Export 62,480 devices' }),
    ).toBeDisabled();
    await shot(page, '03-export-over-limit');
  });

  test('state 04 and 05: running and ready', async ({ page }) => {
    const state = await openDevices(page);
    await openEntry(page, 'Export');
    await dialog(page)
      .getByRole('button', { name: 'Export 6 devices' })
      .click();
    await expect(dialog(page)).toContainText('Job EXP-001 · Running');
    await expect(dialog(page)).toContainText('3 of 6');
    await expect(dialog(page)).toContainText(
      'Closing this dialog keeps the export running.',
    );
    // The phase heading stays in the accessibility tree and takes no visible space (state 04).
    await expect(dialog(page).locator('#phases-label')).toHaveCSS(
      'position',
      'absolute',
    );
    await expect(dialog(page).locator('#phases-label')).toHaveCSS(
      'width',
      '1px',
    );
    await shot(page, '04-export-running');

    // The job finishes; the entry returns to this tab's own export (behavior 6).
    state.job = 'completed';
    await dialog(page)
      .locator('.export-actions')
      .getByRole('button', { name: 'Close' })
      .click();
    await expect(dialog(page)).toBeHidden();
    await openEntry(page, 'Export');
    await expect(dialog(page)).toContainText('devices-for-editing-EXP-001.csv');
    await expect(dialog(page)).toContainText('Ready');
    const download = dialog(page).getByRole('link', { name: 'Download CSV' });
    await expect(download).toHaveAttribute(
      'href',
      '/api/devices/exports/EXP-001/file',
    );
    await shot(page, '05-export-ready');
  });

  test('state 06: the help pane docks beside Configure', async ({ page }) => {
    await openDevices(page);
    await openEntry(page, 'Export');
    await dialog(page)
      .getByRole('button', { name: 'Export and import help' })
      .click();
    await expect(dialog(page)).toHaveCSS('width', '1000px');
    await expect(
      page.getByRole('heading', { name: 'Export and import help' }),
    ).toBeVisible();
    await expect(dialog(page)).toContainText('Editing rules');
    // The left surface stays the approved Configure step with its action bar.
    await expect(
      dialog(page).getByRole('button', { name: 'Export 6 devices' }),
    ).toBeVisible();
    await expect(
      dialog(page).getByRole('button', { name: 'Cancel' }),
    ).toBeVisible();
    await expect(dialog(page).getByText('Write rows')).toHaveCount(0);
    await shot(page, '06-export-help');
  });

  test('state 07 and 08: the report columns and the ready report', async ({
    page,
  }) => {
    await openDevices(page);
    await openEntry(page, 'Reports');
    await expect(dialog(page)).toHaveCSS('width', '480px');
    await expect(dialog(page)).toContainText('Visible grid columns');
    await expect(dialog(page)).toContainText('Create report');
    await shot(page, '07-reports-dialog');
    await dialog(page).getByRole('button', { name: 'Create report' }).click();
    await expect(dialog(page)).toContainText('device-report-EXP-002.csv');
    await expect(dialog(page)).toContainText('Ready');
    await shot(page, '08-reports-ready');
  });

  test('opens the export at the step of the job in the address', async ({
    page,
  }) => {
    await openDevices(page);
    // An Activity row of an own export job links to this address (behavior 5).
    await page.goto('/devices?job=EXP-002');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('Create a report');
    await expect(dialog(page)).toContainText('device-report-EXP-002.csv');
    await expect(dialog(page)).toContainText('Ready');
  });

  test('the same Activity row reopens its export after Close', async ({
    page,
  }) => {
    await openDevices(page);
    const bell = page.getByRole('button', { name: /^Activity:/ });
    const activity = page.getByRole('dialog', { name: 'Activity' });
    await bell.click();
    await activity.getByRole('link', { name: /EXP-001/ }).click();
    await expect(exportDialog(page)).toContainText('Job EXP-001 · Running');
    await expect(page).toHaveURL(/\/devices\?job=EXP-001$/);
    await exportDialog(page)
      .locator('.export-actions')
      .getByRole('button', { name: 'Close' })
      .click();
    await expect(exportDialog(page)).toBeHidden();
    await expect(page).toHaveURL(/\/devices$/);

    // Closing dropped ?job=. The same row must open the dialog again (R3).
    await bell.click();
    await activity.getByRole('link', { name: /EXP-001/ }).click();
    await expect(exportDialog(page)).toContainText('Job EXP-001 · Running');
  });

  test('the Activity row of the import opens the results', async ({ page }) => {
    await openDevices(page, { importRun: 'finished' });
    const bell = page.getByRole('button', { name: /^Activity:/ });
    await bell.click();
    const activity = page.getByRole('dialog', { name: 'Activity' });
    await activity.getByRole('link', { name: /IMP-001/ }).click();
    // Behavior 5 of section 9: the row opens the dialog at the results.
    await expect(page).toHaveURL(/\/devices\?job=IMP-001$/);
    const results = page.locator(
      'section[role="dialog"][aria-labelledby="export-dialog-title"]',
    );
    await expect(
      results.getByRole('region', { name: 'Execution results table' }),
    ).toBeVisible();
    await expect(results.locator('[data-plan="executed"]')).toBeVisible();
    await expect(results.locator('.export-state')).toContainText(
      'Executed by District operator',
    );
    await expect(results).toContainText('Finished');
  });

  test('the dialog holds focus and returns it to Bulk Actions on close', async ({
    page,
  }) => {
    await openDevices(page);
    await openEntry(page, 'Export');
    // cdkTrapFocus moves focus inside the dialog (UI-09).
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.closest('[role="dialog"]') !== null,
        ),
      )
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(bulk(page)).toBeFocused();
  });
});

/** The Results step of the import dialog, opened at `/devices?job=IMP-001` (behavior 5). */
async function openImport(page: Page, options: MockOptions) {
  await signIn(page, options);
  await page.goto('/devices?job=IMP-001');
  await expect(
    page.getByRole('heading', { name: 'Devices', exact: true }),
  ).toBeVisible();
  await expect(exportDialog(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return exportDialog(page);
}

/** The cells of the Result column on the results table. */
const resultCells = (page: Page) => page.locator('td.col-result');

test.describe('Execute and the results', () => {
  test('state 16: the confirmation shows the plan sequence and the phrase', async ({
    page,
  }, testInfo) => {
    const panel = await openImport(page, { importRun: 'open' });
    await expect(panel).toContainText('Import devices');
    await panel.getByRole('button', { name: 'Execute 12 changes' }).click();

    await expect(
      panel.getByRole('heading', { name: 'Execute 12 changes on 8 devices?' }),
    ).toBeVisible();
    await expect(panel).toContainText(
      'Execute creates four jobs. The update job runs first. The three status jobs start after it ends.',
    );
    const jobs = panel.locator('.seq-job');
    await expect(jobs).toHaveCount(4);
    await expect(jobs.nth(0)).toContainText('Update device annotations');
    await expect(jobs.nth(0)).toContainText('9 field changes');
    await expect(jobs.nth(0)).toContainText('5 devices');
    await expect(jobs.nth(1)).toContainText('Disable devices');
    await expect(jobs.nth(3)).toContainText('Deprovision devices');
    await expect(panel).toContainText(
      'The 4 rejected rows stay out. Nothing in them runs.',
    );
    await expect(panel).toContainText(
      'Deprovision removes these devices from active management.',
    );
    // The warning head names the deprovisioned device (state 16 shows its serial).
    await expect(panel.locator('.one-way-head')).toContainText('08V5B5S');
    await expect(panel.locator('.one-way-head')).toContainText(
      '(Retiring from fleet)',
    );
    const phrase = panel.getByLabel('Type DEPROVISION to confirm');
    await expect(phrase).toBeVisible();
    const execute = panel.getByRole('button', { name: 'Execute 12 changes' });
    await expect(execute).toBeDisabled();
    // The API compares the trimmed phrase exactly, so lowercase stays disabled (R3).
    await phrase.fill('deprovision');
    await expect(execute).toBeDisabled();
    await expect(panel).toContainText(
      'The phrase does not match. Type DEPROVISION.',
    );
    await phrase.fill(' DEPROVISION ');
    await expect(execute).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath('16-execute-confirm.png'),
    });
  });

  test('state 17: the running execution shows the live sum and a pending Result', async ({
    page,
  }, testInfo) => {
    const panel = await openImport(page, { importRun: 'running' });
    await expect(panel).toContainText('Updated live');
    await expect(panel).not.toContainText('Finished ');
    // 12 changes = 3 Succeeded + 9 Pending.
    const sum = panel.locator('.rs-sum .count-term');
    await expect(sum.nth(0)).toContainText('12');
    await expect(sum.nth(1)).toContainText('3');
    await expect(sum.nth(2)).toContainText('9');
    // The four jobs of the plan, with the running bar on the update job.
    await expect(panel.locator('.job-item')).toHaveCount(4);
    await expect(panel.locator('.job-item').nth(0)).toContainText(
      '3 of 9 complete · 6 pending',
    );
    await expect(panel.locator('.job-item').nth(1)).toContainText('Queued');
    await expect(panel.locator('.job-progress mat-progress-bar')).toHaveCount(
      1,
    );
    // Ten lines on this page, and a continued status change waits for the update job.
    await expect(resultCells(page)).toHaveCount(10);
    await expect(panel).toContainText('Rows 1–10 of 12 changes');
    await expect(resultCells(page).nth(0)).toContainText('Succeeded');
    await expect(resultCells(page).nth(9)).toContainText(
      'Pending Starts after UPD-001 ends',
    );
    // Ten lines fit whole above the pager at 1440 x 900 (design section 9, notes choice 3).
    const runningFit = await panel
      .locator('.report-table-wrap')
      .evaluate((node) => ({
        client: node.clientHeight,
        scroll: node.scrollHeight,
      }));
    expect(runningFit.scroll).toBeLessThanOrEqual(runningFit.client + 1);
    await page.screenshot({ path: testInfo.outputPath('17-executed.png') });
  });

  test('state 17b: the end time replaces the live line and Failed lists the Re-enable', async ({
    page,
  }, testInfo) => {
    const panel = await openImport(page, { importRun: 'finished' });
    await expect(panel).not.toContainText('Updated live');
    await expect(panel).toContainText('Finished ');
    await expect(panel).toContainText('Executed by District operator');
    // 12 changes = 11 Succeeded + 1 Failed.
    const sum = panel.locator('.rs-sum .count-term');
    await expect(sum.nth(0)).toContainText('12');
    await expect(sum.nth(1)).toContainText('11');
    await expect(sum.nth(2)).toContainText('1');

    const tabs = panel.locator('.report-tabs button');
    await expect(tabs.nth(0)).toContainText('All changes');
    // Both pills count change lines: 12 changes in all, one of them failed (R2).
    await expect(tabs.nth(0)).toContainText('12');
    await expect(tabs.nth(1)).toContainText('Failed');
    await expect(tabs.nth(1)).toContainText('1');
    // The Re-enable failure shows its Google reason under the chip (state 17b).
    await expect(resultCells(page).nth(8)).toContainText('Failed');
    await expect(resultCells(page).nth(8)).toContainText(
      'A device with status ACTIVE does not allow this action.',
    );
    // The ten-line page, including the Failed reason, fits whole above the pager.
    const finishedFit = await panel
      .locator('.report-table-wrap')
      .evaluate((node) => ({
        client: node.clientHeight,
        scroll: node.scrollHeight,
      }));
    expect(finishedFit.scroll).toBeLessThanOrEqual(finishedFit.client + 1);
    await page.screenshot({
      path: testInfo.outputPath('17b-execution-finished.png'),
    });

    await tabs.nth(1).click();
    await expect(panel).toContainText('04XTBHJ');
    await expect(panel).toContainText('Re-enable');
    await expect(resultCells(page)).toHaveCount(1);
    await expect(resultCells(page).nth(0)).toContainText('Failed');
    await expect(resultCells(page).nth(0)).toContainText(
      'A device with status ACTIVE does not allow this action.',
    );
    await page.screenshot({
      path: testInfo.outputPath('17b-failed-tab.png'),
    });
  });

  test('state 17b in the dark theme keeps the finished results', async ({
    page,
  }, testInfo) => {
    const panel = await openImport(page, {
      importRun: 'finished',
      theme: 'dark',
    });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(panel).toContainText('Finished ');
    await expect(panel.locator('.rs-sum .count-term')).toHaveCount(3);
    await page.screenshot({
      path: testInfo.outputPath('dark-17b-execution-finished.png'),
    });
  });

  test('the second page of the results holds the remaining two changes', async ({
    page,
  }, testInfo) => {
    const panel = await openImport(page, { importRun: 'running' });
    await expect(resultCells(page)).toHaveCount(10);
    await panel.getByRole('button', { name: 'Next' }).click();
    await expect(panel).toContainText('Rows 11–12 of 12 changes');
    await expect(resultCells(page)).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath('17-page-2.png') });
    // The close-up of the two remaining rows, where a continued device repeats Row and Device.
    await page.screenshot({
      path: testInfo.outputPath('17-row-11-closeup.png'),
      clip: { x: 160, y: 330, width: 1120, height: 190 },
    });
  });

  test('the finished second page keeps its tail rows whole', async ({
    page,
  }, testInfo) => {
    const panel = await openImport(page, { importRun: 'finished' });
    await expect(resultCells(page)).toHaveCount(10);
    await panel.getByRole('button', { name: 'Next' }).click();
    await expect(panel).toContainText('Rows 11–12 of 12 changes');
    await expect(resultCells(page)).toHaveCount(2);
    await expect(resultCells(page).nth(0)).toContainText('Succeeded');
    await expect(resultCells(page).nth(1)).toContainText('Succeeded');
    await page.screenshot({ path: testInfo.outputPath('17b-page-2.png') });
    await page.screenshot({
      path: testInfo.outputPath('17b-tail-closeup.png'),
      clip: { x: 160, y: 330, width: 1120, height: 190 },
    });
  });

  test('the dialog follows its jobs through the shared feed and opens no feed', async ({
    page,
  }, testInfo) => {
    const panel = await openImport(page, { importRun: 'running' });
    const streams = await installLiveStreams(page);
    await expect(panel).toContainText('Updated live');
    // One feed in the tab. The dialog shares it and opens none of its own (design section 8).
    await expect.poll(() => streams.constructedCount('/api/events')).toBe(1);
    // A tab switch reads the failed view and still adds no stream. The tab is a real control, so
    // Enter selects it from the keyboard (UI-09).
    const failedTab = panel.locator('.report-tabs button').nth(1);
    await failedTab.focus();
    await page.keyboard.press('Enter');
    await expect(failedTab).toBeFocused();
    await expect(panel).toContainText('No change failed.');
    // The empty view keeps its centered message, not a collapsed results row.
    await expect
      .poll(async () => {
        const box = await panel
          .locator('.report-table.rs .message-row td')
          .first()
          .boundingBox();
        return box?.height ?? 0;
      })
      .toBeGreaterThan(60);
    await page.screenshot({ path: testInfo.outputPath('17-failed-empty.png') });
    expect(await streams.constructions()).toEqual(['/api/events']);
  });

  test('the results controls wait for a held IMP detail read', async ({ page }) => {
    const hold = detailHold();
    const panel = await openImport(page, { importRun: 'running', holdDetail: hold });
    await expect(panel).toContainText('Rows 1–10 of 12 changes');
    const streams = liveStreams(page);
    await streams.waitForOpen('/api/events');
    // The feed open reconciles the results once. Let that read settle before the hold.
    await page.waitForTimeout(700);
    const base = { ...hold.counts };
    const send = (revision: number) =>
      streams.send('/api/events', 'job-changed', {
        type: 'job-changed',
        jobId: stsReenableId,
        displayId: 'STS-002',
        revision,
        requestedBy: person.id,
      });

    // A job event starts the IMP detail read, and its answer stays held (R4).
    hold.arm();
    await send(9);
    await expect.poll(() => hold.counts.detail).toBe(base.detail + 1);
    const beforeNext = { ...hold.counts };

    // Next waits for the whole detail/report/operations cycle and starts no read of its own.
    await panel.getByRole('button', { name: 'Next' }).click();
    await page.waitForTimeout(500);
    expect(hold.counts).toEqual(beforeNext);
    hold.release();
    await expect(panel).toContainText('Rows 11–12 of 12 changes');
    await expect(resultCells(page)).toHaveCount(2);

    // The Failed tab waits for the held detail in the same way (R4).
    const base2 = { ...hold.counts };
    hold.arm();
    await send(10);
    await expect.poll(() => hold.counts.detail).toBe(base2.detail + 1);
    const beforeFailed = { ...hold.counts };
    await panel.locator('.report-tabs button').nth(1).click();
    await page.waitForTimeout(500);
    expect(hold.counts).toEqual(beforeFailed);
    hold.release();
    await expect(panel).toContainText('No change failed.');
  });
});
