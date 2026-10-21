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

const person = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: 'District Admin',
};

const operation = (overrides: Partial<JobOperation> = {}): JobOperation => ({
  operationId: 'UPD-006-1',
  deviceId: 'synthetic-device-1',
  serialNumber: 'C0A1-7F2D',
  orgUnitPath: '/School A',
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
    pending: 0,
  },
  failure: null,
  confirmedBy: person,
  previewDisplayId: 'PV-006',
  field: 'annotatedLocation',
  mode: 'replace',
  commandType: null,
  statusAction: null,
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
    init: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    setAttention: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    reconcile: vi.fn().mockResolvedValue(undefined),
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
          metadata: signal({ phase: 3 }),
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
    'Pending',
    'Skipped',
    'Expired',
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
    field: null,
    mode: null,
    requestedValue: null,
    progress: {
      total: null,
      succeeded: 128,
      failed: 0,
      unknown: 0,
      skipped: 0,
      expired: 0,
      pending: null,
    },
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
