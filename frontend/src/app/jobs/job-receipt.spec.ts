import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type {
  DeviceUpdatePreview,
  JobDetail,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { DeviceUpdateDraftStore } from '../devices/device-update-draft.store';
import { DevicesStore } from '../devices/devices.store';
import { JobReceiptPage } from './job-receipt';

const principal = '4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const nextPreviewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const job: JobDetail = {
  jobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  displayId: 'UPD-006',
  revision: 1,
  action: 'update-device-annotations',
  status: 'accepted',
  scope: { kind: 'devices', deviceCount: 6 },
  requestedBy: { id: principal, displayName: 'District operator' },
  createdAt: '2026-10-19T12:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  progress: {
    total: 6,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
    pending: 6,
  },
  failure: null,
  confirmedBy: { id: principal, displayName: 'District operator' },
  previewDisplayId: 'PV-006',
  field: 'annotatedLocation',
  mode: 'replace',
  requestedValue: 'North lab',
  targetOrgUnitPaths: ['/School A'],
  correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  latestActivity: {
    at: '2026-10-19T12:00:00.000Z',
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
};

const preview: DeviceUpdatePreview = {
  previewId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayId: 'PV-006',
  mode: 'replace',
  value: 'North lab',
  selected: 6,
  eligible: 6,
  unchanged: 0,
  excluded: 0,
  oldestObservedAt: '2026-10-19T10:00:00.000Z',
  stale: false,
  preparedAt: '2026-10-19T12:00:00.000Z',
  expiresAt: '2026-10-19T12:15:00.000Z',
  manifestDigest: 'a'.repeat(64),
};

const session = {
  identity: {
    id: principal,
    displayName: 'District operator',
    permissionVersion: 1,
    permissions: [],
    grants: [
      {
        action: 'devices:read',
        scope: { kind: 'district', customerId: 'C0123456' },
      },
      {
        action: 'jobs:read',
        scope: { kind: 'district', customerId: 'C0123456' },
      },
    ],
    preferences: { theme: 'light', navigationCollapsed: false },
  },
  csrfToken: 'a'.repeat(64),
  expiresAt: '2026-10-20T12:00:00.000Z',
};

interface ReceiptSetup {
  jobReply?: () => Promise<Response>;
  prepareReply?: () => Promise<Response>;
}

function setup(options: ReceiptSetup = {}) {
  const request = vi.fn(async (path: string, body?: unknown) => {
    if (path === '/api/devices/updates/previews' && body !== undefined)
      return options.prepareReply
        ? options.prepareReply()
        : Response.json(
            { ...preview, previewId: nextPreviewId, displayId: 'PV-007' },
            { status: 201 },
          );
    if (path.startsWith('/api/jobs/'))
      return options.jobReply ? options.jobReply() : Response.json(job);
    return Response.json({}, { status: 404 });
  });
  TestBed.configureTestingModule({
    imports: [JobReceiptPage],
    providers: [
      provideRouter([]),
      {
        provide: DevicesStore,
        useValue: { selectionTab: tabId, offline: signal(false) },
      },
      {
        provide: AuthStore,
        useValue: {
          session: signal(session),
          metadata: signal({
            phase: 3,
            authenticationConfigured: true,
            version: 'test',
            build: 'client-review',
          }),
          request,
        },
      },
    ],
  });
  const navigate = vi
    .spyOn(TestBed.inject(Router), 'navigate')
    .mockResolvedValue(true);
  const fixture = TestBed.createComponent(JobReceiptPage);
  fixture.componentRef.setInput('displayId', 'UPD-006');
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const settleOn = async (target: typeof fixture) => {
    for (let pass = 0; pass < 6; pass++) {
      await new Promise((resolve) => setTimeout(resolve));
      target.detectChanges();
      await target.whenStable();
    }
    target.detectChanges();
  };
  const settle = () => settleOn(fixture);
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name,
    ) as HTMLButtonElement | undefined;
  return {
    fixture,
    element,
    request,
    navigate,
    button,
    settle,
    settleOn,
    draft: TestBed.inject(DeviceUpdateDraftStore),
  };
}

beforeEach(() => sessionStorage.clear());

it('shows the receipt of the created job', async () => {
  const { element, button, settle } = setup();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update job created',
  );
  expect(element.textContent).toContain('Job UPD-006 · Accepted');
  expect(element.querySelector('h2')?.textContent?.trim()).toBe(
    'Your job is saved',
  );
  expect(element.textContent).toContain(
    '6 devices · 6 annotated-location updates. Google changes have not completed.',
  );
  expect(element.textContent).toContain(
    'You can leave this page. Return to Jobs to review progress and individual outcomes.',
  );
  expect(button('Back to devices')).toBeDefined();
  expect(button('View job')).toBeDefined();
});

it('summarises a clear job as removals', async () => {
  const { element, settle } = setup({
    jobReply: async () =>
      Response.json({ ...job, mode: 'clear', requestedValue: null }),
  });
  await settle();
  expect(element.textContent).toContain(
    '6 devices · 6 annotated-location removals. Google changes have not completed.',
  );
});

it('agrees with a completed job after a reload', async () => {
  const completed: JobDetail = {
    ...job,
    status: 'completed',
    startedAt: '2026-10-19T12:00:30.000Z',
    finishedAt: '2026-10-19T12:01:00.000Z',
    progress: {
      total: 6,
      succeeded: 6,
      failed: 0,
      unknown: 0,
      skipped: 0,
      pending: 0,
    },
  };
  const { element, request, fixture, settle, settleOn } = setup({
    jobReply: async () => Response.json(completed),
  });
  await settle();
  expect(element.textContent).toContain('Job UPD-006 · Completed');
  expect(element.textContent).toContain(
    '6 devices · 6 annotated-location updates. All Google changes completed.',
  );
  expect(element.textContent).not.toContain(
    'Google changes have not completed',
  );

  fixture.destroy();
  const reload = TestBed.createComponent(JobReceiptPage);
  reload.componentRef.setInput('displayId', 'UPD-006');
  reload.detectChanges();
  await settleOn(reload);
  const reloaded: HTMLElement = reload.nativeElement;
  expect(reloaded.textContent).toContain('Job UPD-006 · Completed');
  expect(reloaded.textContent).toContain(
    '6 devices · 6 annotated-location updates. All Google changes completed.',
  );
  expect(reloaded.textContent).not.toContain(
    'Google changes have not completed',
  );
  expect(
    request.mock.calls.filter(([path]) => path === '/api/jobs/UPD-006'),
  ).toHaveLength(2);
});

it('agrees with a job that completed with errors', async () => {
  const { element, settle } = setup({
    jobReply: async () =>
      Response.json({
        ...job,
        status: 'completed-with-errors',
        startedAt: '2026-10-19T12:00:30.000Z',
        finishedAt: '2026-10-19T12:01:00.000Z',
        progress: {
          total: 6,
          succeeded: 5,
          failed: 1,
          unknown: 0,
          skipped: 0,
          pending: 0,
        },
      }),
  });
  await settle();
  expect(element.textContent).toContain('Job UPD-006 · Completed with errors');
  expect(element.textContent).toContain(
    'Some Google changes did not complete.',
  );
});

it('reads GET /api/jobs/:displayId on the first view and on a reload', async () => {
  const { request, fixture, settle, settleOn } = setup();
  await settle();
  expect(request).toHaveBeenCalledWith('/api/jobs/UPD-006');
  fixture.destroy();
  const reload = TestBed.createComponent(JobReceiptPage);
  reload.componentRef.setInput('displayId', 'UPD-006');
  reload.detectChanges();
  await settleOn(reload);
  expect(
    request.mock.calls.filter(([path]) => path === '/api/jobs/UPD-006'),
  ).toHaveLength(2);
});

it('opens Devices with Back to devices', async () => {
  const { button, navigate, settle } = setup();
  await settle();
  button('Back to devices')?.click();
  expect(navigate).toHaveBeenCalledWith(['/devices']);
});

it('opens the job with View job', async () => {
  const { button, navigate, settle } = setup();
  await settle();
  button('View job')?.click();
  expect(navigate).toHaveBeenCalledWith(['/jobs', 'UPD-006']);
});

it('shows an unknown job as not found', async () => {
  const { element, button, settle } = setup({
    jobReply: async () =>
      Response.json({ reason: 'job-not-found' }, { status: 404 }),
  });
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Job not found',
  );
  expect(button('View jobs')).toBeDefined();
});

it('shows missing job access without claiming the job is missing', async () => {
  const { element, settle } = setup({
    jobReply: async () => Response.json({}, { status: 403 }),
  });
  await settle();
  expect(element.textContent).toContain(
    'You need the jobs:read permission or a device read grant for this customer.',
  );
  expect(element.textContent).not.toContain('The job does not exist');
});

it('shows the expired state and prepares a new preview from the draft', async () => {
  const { element, request, button, navigate, draft, settle } = setup({
    jobReply: async () =>
      Response.json(
        {
          reason: 'preview-expired',
          expiresAt: '2026-10-19T12:15:00.000Z',
        },
        { status: 410 },
      ),
  });
  await settle();
  draft.setValue('North lab');
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Preview expired',
  );
  expect(element.textContent).toContain('Draft preserved · No job created');
  button('Prepare new preview')?.click();
  await settle();
  expect(request).toHaveBeenCalledWith('/api/devices/updates/previews', {
    gridId: 'devices',
    tabId,
    mode: 'replace',
    value: 'North lab',
  });
  expect(navigate).toHaveBeenCalledWith([
    '/devices/update/previews',
    nextPreviewId,
  ]);
  expect(draft.value()).toBe('North lab');
});

it('shows the loading state before the job arrives', () => {
  const { element } = setup({
    jobReply: () =>
      new Promise(() => {
        // The answer never arrives in this test.
      }),
  });
  expect(element.textContent).toContain('Loading the job receipt…');
});
