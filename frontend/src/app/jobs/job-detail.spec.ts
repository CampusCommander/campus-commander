import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, type Routes } from '@angular/router';
import type { JobDetail, JobOperation } from '@campus/application-contracts';
import { vi } from 'vitest';
import { routes } from '../app.routes';
import { AuthStore } from '../auth.store';
import { JobDetailPage } from './job-detail';
import { latestActivityLine, formatTime } from './job-detail-fields';
import { JobDetailStore } from './job-detail.store';
import { formatTimestamp } from './job-fields';

const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'District Admin',
};

const operation = (overrides: Partial<JobOperation> = {}): JobOperation => ({
  operationId: 'UPD-006-1',
  deviceId: 'synthetic-device-1',
  serialNumber: 'C0A1-7F2D',
  orgUnitPath: '/School A',
  field: 'annotatedLocation',
  operation: 'replace',
  baselineValue: 'Science wing',
  requestedValue: 'North lab',
  outcome: 'succeeded',
  outcomeReason: null,
  googleStatus: 200,
  googleReason: null,
  observedValue: 'North lab',
  verifiedBy: 'write-response',
  commandId: null,
  commandState: null,
  commandExpiresAt: null,
  commandExecutedAt: null,
  updatedAt: '2026-10-19T10:36:00.000Z',
  ...overrides,
});

const sixOperations = (): JobOperation[] => [
  operation(),
  operation({ operationId: 'UPD-006-2', serialNumber: 'C0A1-7F31' }),
  operation({ operationId: 'UPD-006-3', serialNumber: 'C0A1-7F44' }),
  operation({ operationId: 'UPD-006-4', serialNumber: 'C0A1-7F62' }),
  operation({
    operationId: 'UPD-006-5',
    serialNumber: 'C0A1-7F77',
    outcome: 'failed',
    outcomeReason: 'permission-denied',
    googleStatus: 403,
    googleReason: 'Forbidden',
  }),
  operation({
    operationId: 'UPD-006-6',
    serialNumber: 'C0A1-7F84',
    outcome: 'unknown',
    googleStatus: null,
    outcomeReason: null,
  }),
];

/** Two devices with two changed fields each: one succeeded device and one lost answer. */
const multiFieldOperations = (): JobOperation[] => [
  operation({
    operationId: 'UPD-007-1-annotatedLocation',
    deviceId: 'synthetic-device-1',
    serialNumber: '01P0T1V',
    field: 'annotatedLocation',
    operation: 'replace',
    baselineValue: 'Pine Valley cart 6',
    requestedValue: 'Pine Valley cart 7',
    outcome: 'succeeded',
    observedValue: 'Pine Valley cart 7',
  }),
  operation({
    operationId: 'UPD-007-1-notes',
    deviceId: 'synthetic-device-1',
    serialNumber: '01P0T1V',
    field: 'notes',
    operation: 'replace',
    baselineValue: null,
    requestedValue: 'Cart 7 loaner pool',
    outcome: 'succeeded',
    observedValue: 'Cart 7 loaner pool',
  }),
  operation({
    operationId: 'UPD-007-2-annotatedLocation',
    deviceId: 'synthetic-device-2',
    serialNumber: '02QJANY',
    field: 'annotatedLocation',
    operation: 'replace',
    baselineValue: 'Pine Valley cart 6',
    requestedValue: 'Pine Valley cart 7',
    outcome: 'unknown',
    googleStatus: null,
    observedValue: null,
    verifiedBy: null,
  }),
  operation({
    operationId: 'UPD-007-2-notes',
    deviceId: 'synthetic-device-2',
    serialNumber: '02QJANY',
    field: 'notes',
    operation: 'replace',
    baselineValue: null,
    requestedValue: 'Cart 7 loaner pool',
    outcome: 'unknown',
    googleStatus: null,
    observedValue: null,
    verifiedBy: null,
  }),
];

const multiFieldJob = (overrides: Partial<JobDetail> = {}): JobDetail =>
  job({
    displayId: 'UPD-007',
    scope: { kind: 'devices', deviceCount: 2 },
    changes: [
      {
        field: 'annotatedLocation',
        mode: 'replace',
        value: 'Pine Valley cart 7',
      },
      { field: 'notes', mode: 'replace', value: 'Cart 7 loaner pool' },
    ],
    progress: {
      total: 2,
      succeeded: 1,
      failed: 0,
      unknown: 1,
      skipped: 0,
      expired: 0,
      cancelled: 0,
      pending: 0,
    },
    cancelRequest: null,
    latestActivity: {
      at: '2026-10-21T19:06:00.000Z',
      failed: { count: 0, operations: [] },
      unknown: {
        count: 1,
        operations: [
          {
            operationId: 'UPD-007-2-annotatedLocation',
            deviceId: 'synthetic-device-2',
            serialNumber: '02QJANY',
            updatedAt: '2026-10-21T19:06:00.000Z',
          },
          {
            operationId: 'UPD-007-2-notes',
            deviceId: 'synthetic-device-2',
            serialNumber: '02QJANY',
            updatedAt: '2026-10-21T19:06:00.000Z',
          },
        ],
      },
    },
    ...overrides,
  });

/** Three devices with their own fields: the edit-list shape of state 12, with no shared changes. */
const editListOperations = (): JobOperation[] => [
  operation({
    operationId: 'UPD-008-1-annotatedAssetId',
    deviceId: 'synthetic-device-1',
    serialNumber: '01P0T1V',
    field: 'annotatedAssetId',
    operation: 'replace',
    baselineValue: null,
    requestedValue: 'CB415508',
    observedValue: 'CB415508',
    verifiedBy: 'write-response',
  }),
  operation({
    operationId: 'UPD-008-1-orgUnitPath',
    deviceId: 'synthetic-device-1',
    serialNumber: '01P0T1V',
    field: 'orgUnitPath',
    operation: 'move',
    baselineValue: '/Chrome Devices/Lowell Academy/One to One',
    requestedValue:
      '/Chrome Devices/Pine Valley Elementary School/Cart Devices',
    observedValue: '/Chrome Devices/Pine Valley Elementary School/Cart Devices',
    verifiedBy: 'write-response',
  }),
  operation({
    operationId: 'UPD-008-2-annotatedAssetId',
    deviceId: 'synthetic-device-2',
    serialNumber: '04QVJBY',
    field: 'annotatedAssetId',
    operation: 'replace',
    baselineValue: null,
    requestedValue: 'CB415509',
    outcome: 'failed',
    outcomeReason: 'quota',
    googleStatus: 429,
    googleReason: 'Google quota stopped the update for 04QVJBY.',
    observedValue: null,
    verifiedBy: null,
  }),
  operation({
    operationId: 'UPD-008-3-notes',
    deviceId: 'synthetic-device-3',
    serialNumber: '0727D2E',
    field: 'notes',
    operation: 'replace',
    baselineValue: null,
    requestedValue: 'Hinge repaired',
    observedValue: 'Hinge repaired',
    verifiedBy: 'write-response',
  }),
];

/** The edit-list job with one read-back that holds a third value (review B1). */
const divergentEditListOperations = (): JobOperation[] =>
  editListOperations().map((row) =>
    row.operationId === 'UPD-008-2-annotatedAssetId'
      ? operation({
          operationId: row.operationId,
          deviceId: row.deviceId,
          serialNumber: row.serialNumber,
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
          updatedAt: row.updatedAt,
        })
      : row,
  );

/** The edit-list job of state 12: four rows, one failed, and no frozen change list. */
const editListJob = (overrides: Partial<JobDetail> = {}): JobDetail =>
  job({
    displayId: 'UPD-008',
    status: 'completed-with-errors',
    scope: { kind: 'devices', deviceCount: 3 },
    previewDisplayId: 'PV-008',
    changes: null,
    progress: {
      total: 3,
      succeeded: 2,
      failed: 1,
      unknown: 0,
      skipped: 0,
      expired: 0,
      cancelled: 0,
      pending: 0,
    },
    cancelRequest: null,
    latestActivity: {
      at: '2026-10-23T19:23:00.000Z',
      failed: {
        count: 1,
        operations: [
          {
            operationId: 'UPD-008-2-annotatedAssetId',
            deviceId: 'synthetic-device-2',
            serialNumber: '04QVJBY',
            outcomeReason: 'quota',
            googleStatus: 429,
            googleReason: 'Google quota stopped the update for 04QVJBY.',
            updatedAt: '2026-10-23T19:23:00.000Z',
          },
        ],
      },
      unknown: { count: 0, operations: [] },
    },
    ...overrides,
  });

const commandOperation = (
  overrides: Partial<JobOperation> = {},
): JobOperation =>
  operation({
    field: null,
    operation: 'reboot',
    baselineValue: null,
    requestedValue: null,
    ...overrides,
  });

/** The six command rows of the step 5 mockup, state 09. */
const commandOperations = (): JobOperation[] => [
  commandOperation({ operationId: 'CMD-001-1', serialNumber: '01P0T1V' }),
  commandOperation({
    operationId: 'CMD-001-2',
    serialNumber: '02A1MB6',
    outcome: 'failed',
    outcomeReason: 'command-failed',
    googleStatus: null,
    googleReason: 'The device failed to execute the command.',
  }),
  commandOperation({
    operationId: 'CMD-001-3',
    serialNumber: '02QJANY',
    outcome: 'pending',
    commandId: '4100000003',
    commandState: 'acknowledged',
  }),
  commandOperation({
    operationId: 'CMD-001-4',
    serialNumber: '04A9BVS',
    outcome: 'pending',
    commandId: '4100000004',
    commandState: 'pending-delivery',
  }),
  commandOperation({
    operationId: 'CMD-001-5',
    serialNumber: '04XTBHJ',
    outcome: 'expired',
  }),
  commandOperation({
    operationId: 'CMD-001-6',
    serialNumber: '08V5B5S',
    outcome: 'unknown',
    outcomeReason: 'not-observed',
  }),
];

const commandJob = (overrides: Partial<JobDetail> = {}): JobDetail =>
  job({
    displayId: 'CMD-001',
    action: 'reboot-devices',
    status: 'awaiting-devices',
    changes: null,
    commandType: 'REBOOT',
    progress: {
      total: 6,
      succeeded: 1,
      failed: 1,
      unknown: 1,
      skipped: 0,
      expired: 1,
      cancelled: 0,
      pending: 2,
    },
    cancelRequest: null,
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
    ...overrides,
  });

const statusJob = (overrides: Partial<JobDetail> = {}): JobDetail =>
  job({
    displayId: 'STS-002',
    action: 'disable-devices',
    statusAction: 'disable',
    status: 'completed',
    changes: null,
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
    cancelRequest: null,
    latestActivity: {
      at: '2026-10-20T19:08:00.000Z',
      failed: { count: 1, operations: [] },
      unknown: { count: 0, operations: [] },
    },
    ...overrides,
  });

const statusOperations = (): JobOperation[] => [
  operation({
    operationId: 'STS-002-1',
    serialNumber: '01P0T1V',
    field: null,
    operation: 'disable',
    baselineValue: 'ACTIVE',
    requestedValue: 'DISABLED',
    outcome: 'succeeded',
    googleStatus: 200,
  }),
  operation({
    operationId: 'STS-002-2',
    serialNumber: '02A1MB6',
    field: null,
    operation: 'disable',
    baselineValue: 'ACTIVE',
    requestedValue: 'DISABLED',
    outcome: 'failed',
    outcomeReason: 'status-conflict',
    googleStatus: null,
    googleReason: 'The device status does not match.',
  }),
];

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
  cancelRequest: null,
  failure: null,
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
  ...overrides,
});

interface SetupOptions {
  job?: JobDetail | null;
  operations?: JobOperation[];
  attention?: boolean;
  nextCursor?: string | null;
  missing?: boolean;
  offline?: boolean;
  stale?: boolean;
  error?: string;
  operationsError?: string;
  loading?: boolean;
  reconciling?: string[];
  reconcileError?: string;
  notice?: string;
  grants?: string[];
  phase?: number;
}

function setup(options: SetupOptions = {}) {
  const currentJob = signal<JobDetail | null>(
    options.job === undefined ? job() : options.job,
  );
  const operations = signal<readonly JobOperation[]>(
    options.operations ?? sixOperations(),
  );
  const attention = signal(options.attention ?? false);
  const store = {
    job: currentJob,
    operations,
    nextCursor: signal(options.nextCursor ?? null),
    loading: signal(options.loading ?? false),
    loaded: signal(!options.loading),
    reading: signal(false),
    refreshing: signal(false),
    offline: signal(options.offline ?? false),
    stale: signal(options.stale ?? false),
    error: signal(options.error ?? ''),
    missing: signal(options.missing ?? false),
    operationsError: signal(options.operationsError ?? ''),
    attention,
    shownIndex: signal(0),
    hasPrevious: signal(false),
    hasNext: signal(!!options.nextCursor),
    reconciling: signal<ReadonlySet<string>>(
      new Set(options.reconciling ?? []),
    ),
    reconcileError: signal(options.reconcileError ?? ''),
    notice: signal(options.notice ?? ''),
    cancelling: signal(false),
    cancelError: signal(''),
    init: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    setAttention: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    reconcile: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(true),
  };
  const grants = (
    options.grants ?? ['jobs:read', 'devices:read', 'devices:write']
  ).map((action) => ({
    action,
    scope: { kind: 'district', customerId: 'C0123456' },
  }));
  const session = signal({ identity: { id: person.id, grants } });
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [JobDetailPage],
    providers: [
      provideRouter([]),
      { provide: JobDetailStore, useValue: store },
      {
        provide: AuthStore,
        useValue: {
          metadata: signal({ phase: options.phase ?? 3 }),
          session,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(JobDetailPage);
  fixture.componentRef.setInput('displayId', 'UPD-006');
  fixture.detectChanges();
  return {
    store,
    fixture,
    element: fixture.nativeElement as HTMLElement,
    session,
  };
}

const text = (element: HTMLElement) => element.textContent ?? '';
const button = (element: HTMLElement, name: string) =>
  [...element.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  ) as HTMLButtonElement | undefined;
const link = (element: HTMLElement, name: string) =>
  [...element.querySelectorAll('a')].find(
    (candidate) => candidate.getAttribute('aria-label') === name,
  ) as HTMLAnchorElement | undefined;

it('registers the job detail route under the jobs path', () => {
  const shell = routes.find((route) => route.path === '') as
    | (Routes[number] & { children?: Routes })
    | undefined;
  const detail = shell?.children?.find(
    (route) => route.path === 'jobs/:displayId',
  );
  expect(detail?.title).toBe('Job details · Campus Commander');
  expect(detail?.canActivate).toHaveLength(1);
  expect(detail?.loadComponent).toBeTypeOf('function');
});

it('reads again when the route moves to another job', () => {
  const { store, fixture } = setup();
  expect(store.init).toHaveBeenCalledWith('UPD-006');
  fixture.componentRef.setInput('displayId', 'UPD-014');
  fixture.detectChanges();
  expect(store.init).toHaveBeenCalledWith('UPD-014');
});

it('shows the identity, counters, and operations of frame 104:209', () => {
  const { element } = setup();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update device annotations',
  );
  expect(text(element)).toContain('Job UPD-006 · Needs review');
  expect(
    element.querySelector('#job-identity-title')?.textContent?.trim(),
  ).toBe('UPD-006 · 6 devices');
  expect(text(element)).toContain('Requested by District Admin');
  expect(text(element)).toContain('Duration: 5m 02s');
  expect(text(element)).toContain('Needs review');

  expect(
    [...element.querySelectorAll('.counter dt')].map((label) =>
      label.textContent?.trim(),
    ),
  ).toEqual([
    'Succeeded',
    'Failed',
    'Unknown',
    'Expired',
    'Pending',
    'Skipped',
    'Cancelled',
  ]);
  expect(
    [...element.querySelectorAll('.counter .value')].map((value) =>
      value.textContent?.trim(),
    ),
  ).toEqual(['4', '1', '1', '0', '0', '0', '0']);

  expect(
    [...element.querySelectorAll('th')].map((header) =>
      header.textContent?.trim(),
    ),
  ).toEqual([
    'Device',
    'Operation',
    'Before',
    'Requested',
    'Outcome',
    'Updated',
    'Actions',
  ]);
  expect(element.querySelectorAll('tbody tr')).toHaveLength(6);
  expect(text(element)).toContain('C0A1-7F2D');
  expect(text(element)).toContain('Annotated location');
  expect(text(element)).toContain('Science wing');
  expect(text(element)).toContain('North lab');
  expect(text(element)).toContain(formatTime('2026-10-19T10:36:00.000Z'));
  expect(text(element)).toContain('Rows 1–6 of 6 operations');
  expect(link(element, 'Open device C0A1-7F77')?.getAttribute('href')).toBe(
    '/devices/synthetic-device-1',
  );
  expect(
    [...element.querySelectorAll('a')]
      .find((candidate) => candidate.textContent?.trim() === 'Back to jobs')
      ?.getAttribute('href'),
  ).toBe('/jobs');
});

it('renders one row per device and field with the before and requested values', () => {
  const { element } = setup({
    job: multiFieldJob(),
    operations: multiFieldOperations(),
  });
  const rows = [...element.querySelectorAll('tbody tr')];
  expect(rows).toHaveLength(4);
  const cells = (index: number) =>
    [...rows[index].querySelectorAll('td')].map(
      (cell) => cell.textContent?.trim() ?? '',
    );
  expect(cells(0)[1]).toBe('Annotated location');
  expect(cells(0)[2]).toBe('Pine Valley cart 6');
  expect(cells(0)[3]).toBe('Pine Valley cart 7');
  expect(cells(1)[1]).toBe('Notes');
  expect(cells(1)[2]).toBe('Not set');
  expect(cells(1)[3]).toBe('Cart 7 loaner pool');
  // Each field row names its device, so the two rows of one device hold the same serial.
  expect(rows[0].textContent).toContain('01P0T1V');
  expect(rows[1].textContent).toContain('01P0T1V');
  // A lost answer marks every field row of the device Unknown and offers Reconcile on each.
  expect(cells(2)[4]).toContain('Unknown');
  expect(cells(3)[4]).toContain('Unknown');
  expect(
    [...element.querySelectorAll('button')].filter(
      (candidate) => candidate.textContent?.trim() === 'Reconcile',
    ),
  ).toHaveLength(2);
  // Latest activity names the device once, though both field rows carry its sample.
  const activity = element.querySelector('.activity p')?.textContent ?? '';
  expect(activity.match(/02QJANY/g)).toHaveLength(1);
});

it('renders an edit-list job without shared changes and without a row total', () => {
  const { element } = setup({
    job: editListJob(),
    operations: editListOperations(),
  });
  const rows = [...element.querySelectorAll('tbody tr')];
  expect(rows).toHaveLength(4);
  const cells = (index: number) =>
    [...rows[index].querySelectorAll('td')].map(
      (cell) => cell.textContent?.trim() ?? '',
    );
  // One row per device and field, each with its own field, baseline, and requested value.
  expect(cells(0)[1]).toBe('Asset tag');
  expect(cells(0)[2]).toBe('Not set');
  expect(cells(0)[3]).toBe('CB415508');
  expect(cells(1)[1]).toBe('Organization unit');
  expect(cells(1)[2]).toBe('/Chrome Devices/Lowell Academy/One to One');
  expect(cells(1)[3]).toBe(
    '/Chrome Devices/Pine Valley Elementary School/Cart Devices',
  );
  expect(cells(2)[1]).toBe('Asset tag');
  expect(cells(2)[3]).toBe('CB415509');
  expect(cells(3)[1]).toBe('Notes');
  expect(cells(3)[3]).toBe('Hinge repaired');
  // One device holds two rows, so the header counts devices and the footer states no total.
  const heading = element.querySelector('#job-identity-title')?.textContent;
  expect(heading?.trim()).toBe('UPD-008 · 3 devices');
  expect(element.querySelector('.footer-count')?.textContent?.trim()).toBe(
    'Rows 1–4',
  );
  // A failed asset tag row names the built update sentence, not the stored Google reason.
  expect(cells(2)[4]).toContain('Failed');
  expect(cells(2)[4]).toContain('Google quota stopped the update for 04QVJBY.');
});

it('renders the observed value of a divergent edit-list row', () => {
  // Review B1: baseline, requested, and observed values all differ, and each stays distinct.
  const { element } = setup({
    job: editListJob(),
    operations: divergentEditListOperations(),
  });
  const rows = [...element.querySelectorAll('tbody tr')];
  const cells = (index: number) =>
    [...rows[index].querySelectorAll('td')].map(
      (cell) => cell.textContent?.trim() ?? '',
    );
  expect(cells(2)[2]).toBe('tag-before');
  expect(cells(2)[3]).toContain('tag-requested');
  expect(cells(2)[3]).toContain('Observed: tag-observed');
  // The row keeps the app failure sentence of the action, not the stored Google reason.
  expect(cells(2)[4]).toContain('04QVJBY does not hold the requested value.');
  // The edit-list footer still states the shown range alone.
  expect(element.querySelector('.footer-count')?.textContent?.trim()).toBe(
    'Rows 1–4',
  );
  // A row whose read-back matches its request adds no observed line.
  expect(cells(0)[3]).toBe('CB415508');
});

it('shows the observed value when the observation repeats the Clear label', () => {
  // Review B2: a Clear request renders "Clear value", which is also valid field content.
  const clearJob = job({
    displayId: 'UPD-009',
    status: 'completed-with-errors',
    scope: { kind: 'devices', deviceCount: 1 },
    previewDisplayId: 'PV-009',
    changes: null,
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
    cancelRequest: null,
  });
  const { element } = setup({
    job: clearJob,
    operations: [
      operation({
        operationId: 'UPD-009-1-notes',
        serialNumber: '0727D2E',
        field: 'notes',
        operation: 'clear',
        baselineValue: 'notes-before',
        requestedValue: null,
        observedValue: 'Clear value',
        outcome: 'failed',
        outcomeReason: 'value-differs',
        googleStatus: 200,
        googleReason: null,
        verifiedBy: 'read-back',
      }),
    ],
  });
  const row = element.querySelector('tbody tr') as HTMLTableRowElement;
  const cells = [...row.querySelectorAll('td')].map(
    (cell) => cell.textContent?.trim() ?? '',
  );
  expect(cells[1]).toBe('Notes');
  expect(cells[2]).toBe('notes-before');
  expect(cells[3]).toContain('Clear value');
  expect(cells[3]).toContain('Observed: Clear value');
  expect(row.querySelectorAll('.observed-value')).toHaveLength(1);
  // The row keeps the built update sentence of the action.
  expect(cells[4]).toContain('0727D2E does not hold the requested value.');
});

it('shows the observed value in the failure evidence', async () => {
  const { element, fixture } = setup({
    job: editListJob(),
    operations: divergentEditListOperations(),
  });
  button(element, 'Inspect failure')?.click();
  fixture.detectChanges();
  await fixture.whenStable();
  expect(text(element)).toContain('Failure details · 04QVJBY');
  expect(text(element)).toContain('Observed value');
  expect(text(element)).toContain('tag-observed');
});

it('offers no Reconcile for any field row without devices:write', () => {
  const { element } = setup({
    job: multiFieldJob(),
    operations: multiFieldOperations(),
    grants: ['jobs:read', 'devices:read'],
  });
  expect(text(element)).toContain('02QJANY');
  expect(button(element, 'Reconcile')).toBeUndefined();
});

it('marks every field row of a reconciling operation as pending', () => {
  const { element } = setup({
    job: multiFieldJob(),
    operations: multiFieldOperations(),
    // A click names one field row. One PATCH settles the whole operation.
    reconciling: ['UPD-007-2-notes'],
  });
  expect(text(element).match(/Reconciling/g)).toHaveLength(2);
  expect(button(element, 'Reconcile')).toBeUndefined();
});

it('shows Inspect failure and the evidence panel', async () => {
  const { element, fixture } = setup();
  const inspect = button(element, 'Inspect failure');
  expect(inspect).toBeDefined();
  inspect?.click();
  fixture.detectChanges();
  await fixture.whenStable();

  expect(text(element)).toContain('Failure details · C0A1-7F77');
  expect(text(element)).toContain('Outcome reason');
  expect(text(element)).toContain('permission-denied');
  expect(text(element)).toContain('Google status');
  expect(text(element)).toContain('403');
  expect(text(element)).toContain('Google reason');
  expect(text(element)).toContain('Forbidden');
  expect(text(element)).toContain('Updated');

  button(element, 'Close')?.click();
  fixture.detectChanges();
  await fixture.whenStable();
  expect(text(element)).not.toContain('Failure details');
});

it('closes the failure panel when a job or a person replaces the data', async () => {
  const { element, fixture, store, session } = setup();
  button(element, 'Inspect failure')?.click();
  fixture.detectChanges();
  await fixture.whenStable();
  expect(text(element)).toContain('Failure details · C0A1-7F77');

  // The store clears the job on a change of person. The panel must not stay open.
  store.job.set(null);
  fixture.detectChanges();
  await fixture.whenStable();
  expect(text(element)).not.toContain('Failure details');

  store.job.set(job());
  fixture.detectChanges();
  await fixture.whenStable();
  button(element, 'Inspect failure')?.click();
  fixture.detectChanges();
  await fixture.whenStable();
  expect(text(element)).toContain('Failure details · C0A1-7F77');

  session.set({
    identity: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', grants: [] },
  });
  fixture.detectChanges();
  await fixture.whenStable();
  expect(text(element)).not.toContain('Failure details');
});

it('shows Reconcile only for an unknown row and the required actions', () => {
  const allowed = setup();
  expect(button(allowed.element, 'Reconcile')).toBeDefined();
  expect(button(allowed.element, 'Inspect failure')).toBeDefined();

  const readOnly = setup({ grants: ['jobs:read', 'devices:read'] });
  expect(button(readOnly.element, 'Reconcile')).toBeUndefined();
  expect(button(readOnly.element, 'Inspect failure')).toBeDefined();

  const noJobsRead = setup({ grants: ['devices:read', 'devices:write'] });
  expect(button(noJobsRead.element, 'Reconcile')).toBeUndefined();

  // An update job keeps the step 4 rule: Change device status grants no Reconcile.
  const statusOnly = setup({
    grants: ['jobs:read', 'devices:read', 'devices:status'],
  });
  expect(button(statusOnly.element, 'Reconcile')).toBeUndefined();
});

it('renders the command job of state 09 with counters, chips, and no Reconcile', () => {
  const { element } = setup({
    job: commandJob(),
    operations: commandOperations(),
  });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Reboot devices',
  );
  expect(text(element)).toContain('Job CMD-001 · Awaiting devices');
  expect(
    element.querySelector('#job-identity-title')?.textContent?.trim(),
  ).toBe('CMD-001 · 6 devices');

  expect(
    [...element.querySelectorAll('.counter dt')].map((label) =>
      label.textContent?.trim(),
    ),
  ).toEqual([
    'Succeeded',
    'Failed',
    'Unknown',
    'Expired',
    'Pending',
    'Skipped',
    'Cancelled',
  ]);
  expect(
    [...element.querySelectorAll('.counter .value')].map((value) =>
      value.textContent?.trim(),
    ),
  ).toEqual(['1', '1', '1', '1', '2', '0', '0']);

  const rows = [...element.querySelectorAll<HTMLElement>('tbody tr')];
  expect(rows).toHaveLength(6);
  for (const row of rows) expect(row.textContent).toContain('Reboot');
  expect(rows[0]?.textContent).toContain('Succeeded');
  expect(rows[1]?.textContent).toContain('Failed');
  expect(rows[1]?.textContent).toContain(
    'The device failed to execute the command.',
  );
  expect(rows[2]?.textContent).toContain('Acknowledged');
  expect(rows[3]?.textContent).toContain('Pending delivery');
  expect(rows[4]?.textContent).toContain('Expired');
  expect(rows[5]?.textContent).toContain('Unknown');
  expect(rows[0]?.textContent).toContain('—');
  expect(rows[0]?.textContent).toContain('Reboot');
  expect(button(element, 'Inspect failure')).toBeDefined();
  expect(button(element, 'Reconcile')).toBeUndefined();
  expect(button(element, 'Show 3 needing attention')).toBeDefined();
});

it('renders a Powerwash job with every command state and Google expiry', () => {
  const expiry = '2031-10-22T14:11:00.000Z';
  const operations = [
    commandOperation({
      operationId: 'CMD-008-1',
      serialNumber: '01P0T1V',
      operation: 'powerwash',
      outcome: 'pending',
      commandId: '4100000001',
      commandState: 'acknowledged',
      commandExpiresAt: expiry,
    }),
    commandOperation({
      operationId: 'CMD-008-2',
      serialNumber: '02A1MB6',
      operation: 'powerwash',
      outcome: 'failed',
      outcomeReason: 'command-failed',
      googleReason: 'The device failed to execute the command.',
      commandId: '4100000002',
    }),
    commandOperation({
      operationId: 'CMD-008-3',
      serialNumber: '02QJANY',
      operation: 'powerwash',
      outcome: 'pending',
      commandId: '4100000003',
      commandState: 'pending-delivery',
      commandExpiresAt: expiry,
    }),
    commandOperation({
      operationId: 'CMD-008-4',
      serialNumber: '04XTBHJ',
      operation: 'powerwash',
      outcome: 'unknown',
      outcomeReason: 'not-observed',
      commandId: '4100000004',
      commandExpiresAt: expiry,
    }),
    commandOperation({
      operationId: 'CMD-008-5',
      serialNumber: '04A9BVS',
      operation: 'powerwash',
      outcome: 'failed',
      outcomeReason: 'command-cancelled',
      googleReason: null,
      commandId: '4100000005',
    }),
    commandOperation({
      operationId: 'CMD-008-6',
      serialNumber: '08V5B5S',
      operation: 'powerwash',
      outcome: 'succeeded',
      commandId: '4100000006',
      commandExpiresAt: expiry,
    }),
    commandOperation({
      operationId: 'CMD-008-7',
      serialNumber: '05C2Z8P',
      operation: 'powerwash',
      outcome: 'expired',
      commandId: '4100000007',
      commandExpiresAt: expiry,
    }),
  ];
  const { element } = setup({
    job: commandJob({
      displayId: 'CMD-008',
      action: 'powerwash-devices',
      commandType: 'REMOTE_POWERWASH',
      progress: {
        total: 7,
        succeeded: 1,
        failed: 2,
        unknown: 1,
        skipped: 0,
        expired: 1,
        cancelled: 0,
        pending: 2,
      },
      cancelRequest: null,
    }),
    operations,
  });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Powerwash devices',
  );
  expect(text(element)).toContain('Job CMD-008 · Awaiting devices');

  const rows = [...element.querySelectorAll<HTMLElement>('tbody tr')];
  expect(rows).toHaveLength(7);
  for (const row of rows) {
    expect(row.textContent).toContain('Powerwash');
    expect(row.textContent).toContain('—');
  }
  const expires = `Expires ${formatTimestamp(expiry)}`;
  expect(rows[0]?.textContent).toContain('Acknowledged');
  expect(rows[0]?.textContent).toContain(expires);
  expect(rows[1]?.textContent).toContain('Failed');
  expect(rows[1]?.textContent).toContain(
    'The device failed to execute the command.',
  );
  expect(rows[2]?.textContent).toContain('Pending delivery');
  expect(rows[2]?.textContent).toContain(expires);
  expect(rows[3]?.textContent).toContain('Unknown');
  expect(rows[3]?.textContent).toContain('No result in 30 days');
  expect(rows[3]?.textContent).toContain(expires);
  expect(rows[4]?.textContent).toContain('Failed');
  expect(rows[4]?.textContent).toContain('Google cancelled the command.');
  expect(rows[5]?.textContent).toContain('Succeeded');
  expect(rows[5]?.textContent).not.toContain('Expires');
  expect(rows[6]?.textContent).toContain('Expired');
  expect(rows[6]?.textContent).not.toContain('Expires');
  expect(button(element, 'Reconcile')).toBeUndefined();
});

it('renders a Deprovision job with its reason and status rows', () => {
  const deprovision = (overrides: Partial<JobOperation> = {}) =>
    operation({
      operationId: 'STS-003-1',
      serialNumber: '01P0T1V',
      field: null,
      operation: 'deprovision',
      baselineValue: 'ACTIVE',
      requestedValue: 'DEPROVISIONED',
      outcome: 'succeeded',
      googleStatus: 200,
      verifiedBy: 'write-response',
      observedValue: 'DEPROVISIONED',
      ...overrides,
    });
  const { element } = setup({
    job: job({
      displayId: 'STS-003',
      action: 'deprovision-devices',
      statusAction: 'deprovision',
      status: 'completed-with-errors',
      changes: null,
      deprovisionReason: 'DEPROVISION_REASON_RETIRING_DEVICE',
      progress: {
        total: 5,
        succeeded: 4,
        failed: 1,
        unknown: 0,
        skipped: 0,
        expired: 0,
        cancelled: 0,
        pending: 0,
      },
      cancelRequest: null,
      latestActivity: {
        at: '2026-10-22T14:16:00.000Z',
        failed: { count: 0, operations: [] },
        unknown: { count: 0, operations: [] },
      },
    }),
    operations: [
      deprovision(),
      deprovision({ operationId: 'STS-003-2', serialNumber: '02A1MB6' }),
      deprovision({ operationId: 'STS-003-3', serialNumber: '02QJANY' }),
      deprovision({
        operationId: 'STS-003-4',
        serialNumber: '04QVJBY',
        baselineValue: 'DISABLED',
      }),
      deprovision({
        operationId: 'STS-003-5',
        serialNumber: '04XTBHJ',
        outcome: 'failed',
        outcomeReason: 'status-conflict',
        googleStatus: null,
        verifiedBy: null,
        observedValue: null,
        googleReason:
          'A device with status DEPROVISIONED does not allow this action.',
      }),
    ],
  });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Deprovision devices',
  );
  expect(text(element)).toContain('Deprovision reason: Retiring from fleet');
  const rows = [...element.querySelectorAll<HTMLElement>('tbody tr')];
  expect(rows).toHaveLength(5);
  expect(rows[0]?.textContent).toContain('Deprovision');
  expect(rows[0]?.textContent).toContain('Active');
  expect(rows[0]?.textContent).toContain('Deprovisioned');
  expect(rows[3]?.textContent).toContain('Disabled');
  expect(rows[4]?.textContent).toContain('Failed');
  expect(rows[4]?.textContent).toContain(
    'A device with status DEPROVISIONED does not allow this action.',
  );
  // A status grant alone does not authorize Deprovision.
  expect(button(element, 'Reconcile')).toBeUndefined();
});

it('offers Deprovision Reconcile only with the deprovision permission', () => {
  const unknown = operation({
    operationId: 'STS-003-1',
    field: null,
    operation: 'deprovision',
    baselineValue: 'ACTIVE',
    requestedValue: 'DEPROVISIONED',
    outcome: 'unknown',
    outcomeReason: 'invalid-response',
    googleStatus: null,
    verifiedBy: null,
    observedValue: null,
  });
  const deprovisionJob = job({
    displayId: 'STS-003',
    action: 'deprovision-devices',
    statusAction: 'deprovision',
    status: 'needs-review',
    changes: null,
    deprovisionReason: 'DEPROVISION_REASON_RETIRING_DEVICE',
  });

  const statusOnly = setup({
    job: deprovisionJob,
    operations: [unknown],
    grants: ['jobs:read', 'devices:read', 'devices:status'],
  });
  expect(button(statusOnly.element, 'Reconcile')).toBeUndefined();

  const allowed = setup({
    job: deprovisionJob,
    operations: [unknown],
    grants: ['jobs:read', 'devices:read', 'devices:deprovision'],
  });
  expect(button(allowed.element, 'Reconcile')).toBeDefined();
});

it('gives a sent command its own chip', () => {
  const { element } = setup({
    job: commandJob(),
    operations: [
      commandOperation({
        operationId: 'CMD-001-3',
        outcome: 'pending',
        commandId: '4100000003',
        commandState: 'sent',
      }),
    ],
  });
  expect(text(element)).toContain('Sent');
  expect(text(element)).not.toContain('Pending delivery');
});

it('renders the operations of a status job with the requested status', () => {
  const { element } = setup({
    job: statusJob(),
    operations: statusOperations(),
  });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Disable devices',
  );
  expect(text(element)).toContain('Job STS-002 · Completed');
  const rows = [...element.querySelectorAll<HTMLElement>('tbody tr')];
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain('Disable');
  expect(rows[0]?.textContent).toContain('Active');
  expect(rows[0]?.textContent).toContain('Disabled');
  expect(rows[0]?.textContent).toContain('Succeeded');
  expect(rows[1]?.textContent).toContain('Failed');
  expect(rows[1]?.textContent).toContain('The device status does not match.');

  const reenable = setup({
    job: statusJob({
      displayId: 'STS-003',
      action: 'reenable-devices',
      statusAction: 'reenable',
    }),
    operations: [
      operation({
        operationId: 'STS-003-1',
        operation: 'reenable',
        baselineValue: 'DISABLED',
        requestedValue: 'ACTIVE',
      }),
    ],
  });
  expect(reenable.element.querySelector('h1')?.textContent?.trim()).toBe(
    'Re-enable devices',
  );
  expect(text(reenable.element)).toContain('Re-enable');
  expect(text(reenable.element)).toContain('Disabled');
  expect(text(reenable.element)).toContain('Active');
});

it('keeps Reconcile for an unknown status row but not for a command row', () => {
  const unknownStatus = operation({
    operationId: 'STS-002-1',
    operation: 'disable',
    baselineValue: 'ACTIVE',
    requestedValue: 'DISABLED',
    outcome: 'unknown',
    outcomeReason: 'invalid-response',
  });
  const status = setup({
    job: statusJob({ status: 'needs-review' }),
    operations: [unknownStatus],
    grants: ['jobs:read', 'devices:read', 'devices:status'],
  });
  expect(button(status.element, 'Reconcile')).toBeDefined();

  // An update grant does not authorize the Reconcile of a status operation.
  const writeOnly = setup({
    job: statusJob({ status: 'needs-review' }),
    operations: [unknownStatus],
    grants: ['jobs:read', 'devices:read', 'devices:write'],
  });
  expect(button(writeOnly.element, 'Reconcile')).toBeUndefined();

  const command = setup({
    job: commandJob({ status: 'needs-review' }),
    operations: [commandOperations()[5]!],
  });
  expect(button(command.element, 'Reconcile')).toBeUndefined();
  expect(button(command.element, 'Inspect failure')).toBeUndefined();
});

it('sends a status Reconcile click to the store with its operation', () => {
  const target = operation({
    operationId: 'STS-002-3',
    operation: 'disable',
    baselineValue: 'ACTIVE',
    requestedValue: 'DISABLED',
    outcome: 'unknown',
    outcomeReason: 'invalid-response',
  });
  const { element, store } = setup({
    job: statusJob({ status: 'needs-review' }),
    operations: [target],
    grants: ['jobs:read', 'devices:read', 'devices:status'],
  });
  button(element, 'Reconcile')?.click();
  expect(store.reconcile).toHaveBeenCalledWith(target);
});

it('hides the device eye without devices:read', () => {
  const { element } = setup({ grants: ['jobs:read'] });
  expect(link(element, 'Open device C0A1-7F77')).toBeUndefined();
  expect(text(element)).toContain('C0A1-7F77');
});

it('marks a reconciled row while the Reconcile request is pending', () => {
  const { element } = setup({
    reconciling: ['UPD-006-6'],
  });
  expect(text(element)).toContain('Reconciling');
  expect(button(element, 'Reconcile')).toBeUndefined();
});

it('switches the attention filter with the frame button copy', () => {
  const { element, store } = setup();
  const showAttention = button(element, 'Show 2 needing attention');
  expect(showAttention).toBeDefined();
  showAttention?.click();
  expect(store.setAttention).toHaveBeenCalledWith(true);

  const filtered = setup({ attention: true });
  expect(button(filtered.element, 'Show all operations')).toBeDefined();
  expect(text(filtered.element)).not.toContain('Show 2 needing attention');
});

it('shows the counter line for a job with no samples', () => {
  const running = job({
    status: 'running',
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
    latestActivity: {
      at: '2026-10-19T10:42:00.000Z',
      failed: { count: 0, operations: [] },
      unknown: { count: 0, operations: [] },
    },
  });
  const { element } = setup({ job: running, operations: [] });
  expect(text(element)).toContain(latestActivityLine(running));
  expect(text(element)).toContain('Latest activity');
});

it('shows a refresh job with counters and Latest activity only', () => {
  const refresh = job({
    displayId: 'REF-004',
    action: 'refresh-inventory',
    status: 'completed',
    changes: null,
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
    latestActivity: {
      at: '2026-10-19T10:42:00.000Z',
      failed: { count: 0, operations: [] },
      unknown: { count: 0, operations: [] },
    },
  });
  const { element } = setup({ job: refresh, operations: [] });
  expect(element.querySelector('#operations-title')).toBeNull();
  expect(text(element)).not.toContain('Operation results');
  expect(text(element)).toContain('128');
  expect(text(element)).toContain('Latest activity');
  expect(text(element)).toContain('128 devices read. The refresh completed.');
});

it('shows the missing, offline, unavailable, and loading states', () => {
  const missing = setup({ job: null, missing: true });
  expect(text(missing.element)).toContain('Job not found');
  expect(text(missing.element)).toContain(
    'This job does not exist or was removed.',
  );
  expect(
    [...missing.element.querySelectorAll('a')]
      .find((candidate) => candidate.textContent?.trim() === 'Back to jobs')
      ?.getAttribute('href'),
  ).toBe('/jobs');

  const offline = setup({ job: null, offline: true });
  expect(text(offline.element)).toContain('Cannot reach Campus Commander');
  expect(button(offline.element, 'Retry')).toBeDefined();

  const unavailable = setup({
    job: null,
    error: 'Job details are unavailable.',
  });
  expect(text(unavailable.element)).toContain('Job details are unavailable');
  expect(button(unavailable.element, 'Retry')).toBeDefined();

  const loading = setup({ job: null, loading: true });
  expect(text(loading.element)).toContain('Loading job details…');
  expect(
    loading.element.querySelector('[aria-label="Loading the job"]'),
  ).not.toBeNull();
});

it('keeps the job visible with a stale banner and an operations error', () => {
  const { element } = setup({
    stale: true,
    operationsError: 'Operation results are unavailable.',
  });
  expect(text(element)).toContain('Job state is stale');
  expect(text(element)).toContain('Operation results are unavailable.');
  expect(text(element)).toContain('C0A1-7F2D');
});

it('shows the empty attention result', () => {
  const { element } = setup({ attention: true, operations: [] });
  expect(text(element)).toContain('No operations need attention.');
});

it('shows the empty operations result for a job without rows', () => {
  const { element } = setup({ operations: [] });
  expect(text(element)).toContain('No operations recorded for this job.');
});

it('renders Reconcile messages and the pending notice', () => {
  const failed = setup({
    reconcileError: 'Reconcile could not start. Try again.',
    notice: 'Reconcile started for C0A1-7F84.',
  });
  expect(text(failed.element)).toContain(
    'Reconcile could not start. Try again.',
  );
  expect(text(failed.element)).toContain('Reconcile started for C0A1-7F84.');
});

it('pages with the operations controls', () => {
  const { element, store } = setup({ nextCursor: '6' });
  const next = element.querySelector<HTMLButtonElement>(
    'button[aria-label="Next operations page"]',
  );
  expect(next?.disabled).toBe(false);
  next?.click();
  expect(store.next).toHaveBeenCalled();
  expect(
    element.querySelector<HTMLButtonElement>(
      'button[aria-label="Previous operations page"]',
    )?.disabled,
  ).toBe(true);
});

const runningJob = (overrides: Partial<JobDetail> = {}): JobDetail =>
  job({
    displayId: 'UPD-001',
    status: 'running',
    scope: { kind: 'devices', deviceCount: 48 },
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
    finishedAt: null,
    ...overrides,
  });

const request = { at: '2026-10-26T14:42:00.000Z', by: person };

const cancelButton = (element: HTMLElement) =>
  element.querySelector<HTMLButtonElement>('#cancel-job');

it('offers Cancel pending work to the requester while work remains', () => {
  const { element } = setup({ job: runningJob() });
  const cancel = cancelButton(element);
  expect(cancel).not.toBeNull();
  expect(cancel?.textContent?.trim()).toBe('Cancel pending work');
  expect(cancel?.disabled).toBe(false);
});

it('hides Cancel pending work without the right or without work to stop', () => {
  const { element, fixture, session, store } = setup({ job: runningJob() });
  expect(cancelButton(element)).not.toBeNull();

  // Another person holds jobs:read but did not request the job.
  session.set({
    identity: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      grants: [
        {
          action: 'jobs:read',
          scope: { kind: 'district', customerId: 'C0123456' },
        },
      ],
    },
  });
  fixture.detectChanges();
  expect(cancelButton(element)).toBeNull();

  // The requester sees no control once the job awaits devices or has no pending work.
  session.set({
    identity: {
      id: person.id,
      grants: [
        {
          action: 'jobs:read',
          scope: { kind: 'district', customerId: 'C0123456' },
        },
      ],
    },
  });
  store.job.set(runningJob({ status: 'awaiting-devices' }));
  fixture.detectChanges();
  expect(cancelButton(element)).toBeNull();

  store.job.set(
    runningJob({
      status: 'completed',
      progress: {
        total: 48,
        succeeded: 48,
        failed: 0,
        unknown: 0,
        skipped: 0,
        expired: 0,
        cancelled: 0,
        pending: 0,
      },
    }),
  );
  fixture.detectChanges();
  expect(cancelButton(element)).toBeNull();
});

it('shows the cancel to a jobs:manage holder who did not request the job', () => {
  const { element, fixture, session } = setup({ job: runningJob() });
  session.set({
    identity: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      grants: [
        {
          action: 'jobs:manage',
          scope: { kind: 'district', customerId: 'C0123456' },
        },
      ],
    },
  });
  fixture.detectChanges();
  expect(cancelButton(element)?.textContent?.trim()).toBe(
    'Cancel pending work',
  );
});

it('asks once with the running question and both paragraphs described', async () => {
  const { element, fixture } = setup({ job: runningJob() });
  cancelButton(element)?.click();
  fixture.detectChanges();
  await fixture.whenStable();

  const dialog = element.querySelector('[role="alertdialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.getAttribute('aria-describedby')).toBe(
    'cancel-question-one cancel-question-two',
  );
  expect(dialog?.querySelector('#cancel-job-title')?.textContent?.trim()).toBe(
    'Cancel pending work on UPD-001?',
  );
  expect(
    dialog?.querySelector('#cancel-question-one')?.textContent?.trim(),
  ).toBe(
    '12 of 48 operations are pending. Those that have not reached Google end Cancelled and never run.',
  );
  expect(
    dialog?.querySelector('#cancel-question-two')?.textContent?.trim(),
  ).toBe(
    'Requests already sent to Google finish and keep their results. The 36 confirmed updates stay. Nothing rolls back.',
  );
  expect(
    [...(dialog?.querySelectorAll('button') ?? [])].map((candidate) =>
      candidate.textContent?.trim(),
    ),
  ).toEqual(['Keep job running', 'Cancel pending work']);
});

it('closes the question with Escape and returns focus to the control', async () => {
  const { element, fixture } = setup({ job: runningJob() });
  cancelButton(element)?.click();
  fixture.detectChanges();
  await fixture.whenStable();

  const dialog = element.querySelector('[role="alertdialog"]') as HTMLElement;
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  fixture.detectChanges();
  await fixture.whenStable();

  expect(element.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.activeElement).toBe(cancelButton(element));
});

it('sends the cancel through the store and returns focus after the answer', async () => {
  const { element, fixture, store } = setup({ job: runningJob() });
  cancelButton(element)?.click();
  fixture.detectChanges();
  await fixture.whenStable();

  const dialog = element.querySelector('[role="alertdialog"]') as HTMLElement;
  const confirm = [...dialog.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === 'Cancel pending work',
  );
  confirm?.click();
  fixture.detectChanges();
  await Promise.resolve();
  fixture.detectChanges();
  await fixture.whenStable();

  expect(store.cancel).toHaveBeenCalledTimes(1);
  expect(element.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.activeElement).toBe(cancelButton(element));
});

it('keeps the request visible while the job runs and after it ends', async () => {
  const { element, fixture, store } = setup({
    job: runningJob({ cancelRequest: request }),
  });

  const cancel = cancelButton(element);
  expect(cancel?.textContent?.trim()).toBe('Cancellation requested');
  expect(cancel?.getAttribute('aria-disabled')).toBe('true');
  expect(cancel?.disabled).toBe(false);
  expect(cancel?.tabIndex).toBe(0);
  expect(text(element)).toContain(
    'Cancellation requested · The job stops within 30 seconds',
  );
  expect(text(element)).toContain('Cancellation requested by District Admin');

  // The job ends cancelled: the banner goes, the identity line stays, and the control leaves.
  store.job.set(
    runningJob({
      status: 'cancelled',
      cancelRequest: request,
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
  );
  fixture.detectChanges();
  await fixture.whenStable();
  expect(cancelButton(element)).toBeNull();
  expect(text(element)).not.toContain('The job stops within 30 seconds');
  expect(text(element)).toContain('Cancellation requested by District Admin');
  expect(text(element)).toContain('Cancelled');
});

it('shows the cancel refusal beside the toolbar', () => {
  const { element, fixture, store } = setup({ job: runningJob() });
  store.cancelError.set('You do not have permission to cancel this job.');
  fixture.detectChanges();
  const alert = element.querySelector('[role="alert"]');
  expect(alert?.textContent?.trim()).toBe(
    'You do not have permission to cancel this job.',
  );
});
