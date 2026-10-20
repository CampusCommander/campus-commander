import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type {
  DeviceSelectionSpec,
  DeviceUpdatePreview,
  JobDetail,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { DevicesStore } from './devices.store';
import { DeviceUpdateDraftStore } from './device-update-draft.store';
import {
  DeviceUpdateSheet,
  SELECTION_CHANGED_NOTE,
} from './device-update-sheet';

const principal = '4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const previewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const selection = (
  selectedCount: number,
  expiredAt: string | null = null,
): DeviceSelectionSpec => ({
  terms: [],
  groups: [],
  added: selectedCount,
  excluded: 0,
  selectedCount,
  expiredAt,
});

const preview: DeviceUpdatePreview = {
  previewId,
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

const previewReadPath = `/api/devices/updates/previews/${previewId}`;

const targets = [
  {
    deviceId: 'synthetic-device-1',
    serialNumber: 'C0A1-0001',
    field: 'annotatedLocation' as const,
    observedValue: 'Science wing',
    approvedValue: 'North lab',
    disposition: 'eligible' as const,
    exclusionReason: null,
  },
  {
    deviceId: 'synthetic-device-2',
    serialNumber: 'C0A1-0002',
    field: 'annotatedLocation' as const,
    observedValue: null,
    approvedValue: 'North lab',
    disposition: 'eligible' as const,
    exclusionReason: null,
  },
  {
    deviceId: 'synthetic-device-3',
    serialNumber: 'C0A1-0003',
    field: 'annotatedLocation' as const,
    observedValue: 'Science wing',
    approvedValue: null,
    disposition: 'excluded' as const,
    exclusionReason: 'removed',
  },
];

const receipt = {
  jobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  displayId: 'UPD-006',
  status: 'accepted' as const,
  deviceCount: 6,
  updateCount: 6,
};

const job: JobDetail = {
  jobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  displayId: 'UPD-006',
  revision: 1,
  action: 'update-device-annotations',
  status: 'running',
  scope: { kind: 'devices', deviceCount: 6 },
  requestedBy: { id: principal, displayName: 'District operator' },
  createdAt: '2026-10-19T12:00:00.000Z',
  startedAt: '2026-10-19T12:01:00.000Z',
  finishedAt: null,
  progress: {
    total: 6,
    succeeded: 2,
    failed: 0,
    unknown: 0,
    skipped: 0,
    pending: 4,
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
    at: '2026-10-19T12:01:00.000Z',
    failed: { count: 0, operations: [] },
    unknown: { count: 0, operations: [] },
  },
};

type RequestHandler = (
  path: string,
  body: unknown,
) => Promise<Response> | Response;

interface SetupOptions {
  count?: number;
  spec?: DeviceSelectionSpec | null;
  request?: RequestHandler;
  open?: boolean;
}

async function setup(options: SetupOptions = {}) {
  sessionStorage.clear();
  const spec = signal<DeviceSelectionSpec | null>(
    options.spec === undefined ? selection(options.count ?? 6) : options.spec,
  );
  const revision = signal(0);
  const getSpec = vi.fn(async () => {
    if (options.spec === undefined) spec.set(selection(options.count ?? 6));
    return { terms: [], selectedCount: spec()?.selectedCount ?? 0 };
  });
  /** One applied selection change: the grid sends ops, so the revision moves. */
  const mutate = (next: DeviceSelectionSpec) => {
    spec.set(next);
    revision.update((value) => value + 1);
  };
  const devices = {
    selection: { getSpec, spec, revision },
    selectionTab: tabId,
    selectedView: signal(false),
    offline: signal(false),
  };
  const request = vi.fn(
    async (path: string, body?: unknown): Promise<Response> => {
      if (options.request) return options.request(path, body);
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path === `/api/devices/updates/previews/${previewId}`)
        return Response.json(preview);
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path.endsWith('/confirm'))
        return Response.json(receipt, { status: 201 });
      if (path === '/api/jobs/UPD-006') return Response.json(job);
      return Response.json({}, { status: 404 });
    },
  );
  TestBed.configureTestingModule({
    imports: [DeviceUpdateSheet],
    providers: [
      provideRouter([]),
      { provide: DevicesStore, useValue: devices },
      {
        provide: AuthStore,
        useValue: {
          session: signal({
            identity: { id: principal, grants: [] },
            expiresAt: '2026-10-20T12:00:00.000Z',
            csrfToken: 'a'.repeat(64),
          }),
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
  const fixture = TestBed.createComponent(DeviceUpdateSheet);
  fixture.componentRef.setInput('open', options.open ?? true);
  fixture.detectChanges();
  const closed = vi.fn();
  fixture.componentInstance.closed.subscribe(closed);
  const element: HTMLElement = fixture.nativeElement;
  const settle = async () => {
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  await settle();
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (candidate) =>
        candidate.textContent?.replace(/\s+/g, ' ').trim() === name,
    );
  const input = () =>
    element.querySelector<HTMLInputElement>('input[name="annotatedLocation"]');
  const type = async (value: string) => {
    const field = input();
    if (!field) throw new Error('The annotated location field is missing.');
    field.value = value;
    field.dispatchEvent(new Event('input'));
    await settle();
  };
  const open = async () => {
    fixture.componentRef.setInput('open', true);
    await settle();
  };
  const close = async () => {
    fixture.componentRef.setInput('open', false);
    await settle();
  };
  const save = async () => {
    button('Save and preview')?.click();
    await settle();
  };
  const acknowledge = async () => {
    const box = element.querySelector<HTMLInputElement>(
      'mat-checkbox input[type="checkbox"]',
    );
    if (!box) throw new Error('The acknowledgement checkbox is missing.');
    box.click();
    await settle();
  };
  return {
    fixture,
    element,
    spec,
    revision,
    mutate,
    request,
    navigate,
    closed,
    button,
    input,
    type,
    settle,
    open,
    close,
    save,
    acknowledge,
    draft: TestBed.inject(DeviceUpdateDraftStore),
  };
}

it('opens at Edit with the selection count and no Organization unit', async () => {
  const { element, button, input } = await setup();
  const heading = element.querySelector('h1');
  expect(heading?.textContent?.trim()).toBe('Update 6 devices');
  expect(element.textContent).toContain(
    '6 devices · 0 changed fields · Not submitted',
  );
  expect(element.textContent).not.toContain('Organization unit');
  expect(input()).not.toBeNull();
  expect(button('Save and preview')).toBeDefined();
});

it('shows the step order and the stepper states', async () => {
  const { element, type, save, settle, acknowledge } = await setup();
  const steps = () => [...element.querySelectorAll('li.step')];
  expect(steps().map((step) => step.textContent?.trim())).toEqual([
    '1Edit',
    '2Review, not started',
    '3Confirm, not started',
  ]);
  expect(steps()[0].getAttribute('aria-current')).toBe('step');
  expect(steps()[1].getAttribute('aria-current')).toBeNull();

  await type('North lab');
  await save();
  expect(steps()[0].classList).toContain('is-done');
  expect(steps()[1].classList).toContain('is-active');
  expect(steps()[1].getAttribute('aria-current')).toBe('step');

  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Continue to confirmation')
      candidate.click();
  });
  await settle();
  expect(steps()[1].classList).toContain('is-done');
  expect(steps()[2].classList).toContain('is-active');

  await acknowledge();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Create update job')
      candidate.click();
  });
  await settle();
  expect(steps().every((step) => step.classList.contains('is-done'))).toBe(
    true,
  );
  expect(
    steps().every((step) => step.getAttribute('aria-current') === null),
  ).toBe(true);
});

it('shows one device and one changed field in the singular', async () => {
  const { element, type } = await setup({ count: 1 });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 1 device',
  );
  type('North lab');
  expect(element.textContent).toContain(
    '1 device · 1 changed field · Not submitted',
  );
});

it('rejects a whitespace-only value and keeps Save and preview disabled', async () => {
  const { element, button, type } = await setup();
  await type('   ');
  expect(element.textContent).toContain('A value needs a visible character.');
  expect(button('Save and preview')?.disabled).toBe(true);
});

it('sends the replace value and shows the frozen review', async () => {
  const { element, request, type, save } = await setup();
  await type('North lab');
  await save();
  const create = request.mock.calls.find(([path]) =>
    path.endsWith('/previews'),
  );
  expect(create?.[1]).toEqual({
    gridId: 'devices',
    tabId,
    mode: 'replace',
    value: 'North lab',
  });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 6 device updates',
  );
  expect(element.textContent).toContain(
    '6 devices · 6 field changes · 0 excluded',
  );
  expect(element.textContent).toContain(
    'Targets and final values are frozen. New matching devices will not join this job.',
  );
  expect(element.textContent).toContain('Preview\u00a0PV\u2011006');
  expect(element.textContent).toContain('Annotated location');
  expect(element.textContent).toContain('C0A1-0001');
  expect(element.textContent).toContain('Science wing');
  expect(element.textContent).toContain('North lab');
  expect(element.textContent).toContain('Excluded · Removed from inventory');
});

it('sends a clear choice without a value', async () => {
  const { draft, request, save, settle } = await setup();
  draft.setMode('clear');
  await settle();
  await save();
  const create = request.mock.calls.find(([path]) =>
    path.endsWith('/previews'),
  );
  expect(create?.[1]).toEqual({ gridId: 'devices', tabId, mode: 'clear' });
});

it('shows the stored expired selection without losing the draft', async () => {
  const { element, input, button } = await setup({
    spec: selection(0, '2026-10-19T11:00:00.000Z'),
  });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Selection expired',
  );
  expect(element.textContent).toContain('Select the devices again');
  expect(element.textContent).toContain(
    'The browsing selection expired. Approved jobs and their frozen targets remain available.',
  );
  expect(button('Save and preview')).toBeUndefined();
  expect(input()).toBeNull();
});

it('shows the empty selection state', async () => {
  const { element } = await setup({ count: 0 });
  expect(element.textContent).toContain('No devices are selected');
});

it('shows the expired selection on a 409 answer and keeps the draft', async () => {
  const { element, input, type, save } = await setup({
    request: (path) =>
      path.endsWith('/previews')
        ? Response.json({ reason: 'selection-expired' }, { status: 409 })
        : Response.json({}, { status: 404 }),
  });
  await type('North lab');
  expect(input()?.value).toBe('North lab');
  await save();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Selection expired',
  );
  expect(input()).toBeNull();
});

it('keeps the draft when the sheet closes and reopens at Edit', async () => {
  const { element, input, type, close, open, settle } = await setup();
  await type('North lab');
  await close();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 6 devices',
  );
  await open();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 6 devices',
  );
  await settle();
  expect(input()?.value).toBe('North lab');
});

it('closes with the Close button and with Escape', async () => {
  const { closed, element } = await setup();
  element
    .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    ?.click();
  expect(closed).toHaveBeenCalledTimes(1);
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  expect(closed).toHaveBeenCalledTimes(2);
});

it('moves focus to the sheet headline when it opens', async () => {
  const { fixture, element, open } = await setup({ open: false });
  fixture.detectChanges();
  await open();
  expect(document.activeElement).toBe(element.querySelector('h1'));
});

it('shows the selection-change note and keeps the frozen preview', async () => {
  const { element, mutate, type, save, settle } = await setup();
  await type('North lab');
  await save();
  expect(element.textContent).not.toContain(SELECTION_CHANGED_NOTE);

  mutate(selection(7));
  await settle();
  expect(element.textContent).toContain(SELECTION_CHANGED_NOTE);
  // The frozen targets stay visible.
  expect(element.textContent).toContain('C0A1-0001');
  expect(element.textContent).toContain(
    '6 devices · 6 field changes · 0 excluded',
  );

  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Continue to confirmation')
      candidate.click();
  });
  await settle();
  expect(element.textContent).toContain(SELECTION_CHANGED_NOTE);
});

it('shows the note when a row is replaced at the same count', async () => {
  const { element, mutate, type, save, settle } = await setup();
  await type('North lab');
  await save();
  expect(element.textContent).not.toContain(SELECTION_CHANGED_NOTE);

  // Devices 1, 2, 3 become 2, 3, 4: every count stays the same.
  mutate(selection(6));
  await settle();
  expect(element.textContent).toContain(SELECTION_CHANGED_NOTE);
  expect(element.textContent).toContain('C0A1-0001');
  expect(element.textContent).toContain(
    '6 devices · 6 field changes · 0 excluded',
  );

  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Continue to confirmation')
      candidate.click();
  });
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Confirm 6 device updates',
  );
  expect(element.textContent).toContain(SELECTION_CHANGED_NOTE);
});

it('sends the preview digest after the acknowledgement', async () => {
  const { element, request, type, save, acknowledge, settle } = await setup();
  await type('North lab');
  await save();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Continue to confirmation')
      candidate.click();
  });
  await settle();
  const create = () =>
    [...element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Create update job',
    );
  expect(create()?.disabled).toBe(true);
  await acknowledge();
  expect(create()?.disabled).toBe(false);
  create()?.click();
  await settle();
  const confirm = request.mock.calls.find(([path]) =>
    path.endsWith('/confirm'),
  );
  expect(confirm?.[1]).toEqual({
    manifestDigest: 'a'.repeat(64),
    acknowledged: true,
  });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update job created',
  );
  expect(element.textContent).toContain('Job UPD-006 · Running');
  expect(element.textContent).toContain('Your job is saved');
  expect(element.textContent).toContain(
    '6 devices · 6 annotated-location updates. Google changes have not completed.',
  );
  expect(element.textContent).toContain(
    'You can close this panel and follow progress in Jobs.',
  );
});

it('opens the job detail page with View job', async () => {
  const { element, navigate, type, save, acknowledge, settle } = await setup();
  await type('North lab');
  await save();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Continue to confirmation')
      candidate.click();
  });
  await settle();
  await acknowledge();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Create update job')
      candidate.click();
  });
  await settle();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'View job') candidate.click();
  });
  expect(navigate).toHaveBeenCalledWith(['/jobs', 'UPD-006']);
});

it('shows the 410 expired preview inside the Review step', async () => {
  const { element, type, save } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path.includes('/targets'))
        return Response.json(
          {
            reason: 'preview-expired',
            expiresAt: '2026-10-19T12:15:00.000Z',
          },
          { status: 410 },
        );
      return Response.json({}, { status: 404 });
    },
  });
  await type('North lab');
  await save();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Preview expired',
  );
  expect(element.textContent).toContain(
    'Prepare a new preview before confirming',
  );
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Review',
  );
});

it('shows a 403 permission change inside the Confirm step', async () => {
  const { element, type, save, acknowledge, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path === previewReadPath) return Response.json(preview);
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path.endsWith('/confirm'))
        return Response.json({ reason: 'forbidden' }, { status: 403 });
      return Response.json({}, { status: 404 });
    },
  });
  await type('North lab');
  await save();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Continue to confirmation')
      candidate.click();
  });
  await settle();
  await acknowledge();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Create update job')
      candidate.click();
  });
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update device is unavailable',
  );
  expect(element.textContent).toContain(
    'Your access does not permit this update',
  );
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Confirm',
  );
});

it('shows the offline state inside the step and keeps the draft', async () => {
  const { element, input, type, save } = await setup({
    request: () => Promise.reject(new TypeError('offline')),
  });
  await type('North lab');
  await save();
  expect(element.textContent).toContain('Cannot reach Campus Commander');
  expect(element.textContent).toContain(
    'Your draft stays in this tab. Reconnect before you prepare a preview.',
  );
  expect(input()?.value).toBe('North lab');
});

it('replays a retained confirmation before creating a preview', async () => {
  const { request, type, save } = await setup();
  sessionStorage.setItem(
    `cc.device-update-confirmation.${principal}.${previewId}`,
    JSON.stringify({
      previewId,
      manifestDigest: 'a'.repeat(64),
    }),
  );
  await type('North lab');
  await save();
  expect(request.mock.calls.some(([path]) => path.endsWith('/confirm'))).toBe(
    true,
  );
  expect(
    request.mock.calls.some(
      ([path]) => path === '/api/devices/updates/previews',
    ),
  ).toBe(false);
});

it('shows the receipt answers of a clear job as removals', async () => {
  const clearJob: JobDetail = {
    ...job,
    mode: 'clear',
    requestedValue: null,
  };
  const { element, type, save, acknowledge, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(
          { ...preview, mode: 'clear', value: null },
          { status: 201 },
        );
      if (path === previewReadPath)
        return Response.json({ ...preview, mode: 'clear', value: null });
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path.endsWith('/confirm'))
        return Response.json(receipt, { status: 201 });
      if (path === '/api/jobs/UPD-006') return Response.json(clearJob);
      return Response.json({}, { status: 404 });
    },
  });
  await type('North lab');
  await save();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Continue to confirmation')
      candidate.click();
  });
  await settle();
  await acknowledge();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Create update job')
      candidate.click();
  });
  await settle();
  expect(element.textContent).toContain('annotated-location removals');
});

it('shows a job read failure as not found', async () => {
  const { element, type, save, acknowledge, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path === previewReadPath) return Response.json(preview);
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path.endsWith('/confirm'))
        return Response.json(receipt, { status: 201 });
      if (path === '/api/jobs/UPD-006')
        return Response.json({ reason: 'not-found' }, { status: 404 });
      return Response.json({}, { status: 404 });
    },
  });
  await type('North lab');
  await save();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Continue to confirmation')
      candidate.click();
  });
  await settle();
  await acknowledge();
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.trim() === 'Create update job')
      candidate.click();
  });
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Job not found',
  );
  expect(element.textContent).toContain('This job is unavailable');
});

const clickButton = (element: HTMLElement, name: string) => {
  element.querySelectorAll('button').forEach((candidate) => {
    if (candidate.textContent?.replace(/\s+/g, ' ').trim() === name)
      candidate.click();
  });
};

/** Save the draft and open the Confirm step. */
async function reachConfirm(
  element: HTMLElement,
  type: (value: string) => Promise<void>,
  save: () => Promise<void>,
  settle: () => Promise<void>,
) {
  await type('North lab');
  await save();
  clickButton(element, 'Continue to confirmation');
  await settle();
}

it('re-reads the frozen preview when it enters Confirm', async () => {
  const { element, request, type, save, settle } = await setup();
  await type('North lab');
  await save();
  const reads = () =>
    request.mock.calls.filter(([path]) => path === previewReadPath).length;
  expect(reads()).toBe(0);

  clickButton(element, 'Continue to confirmation');
  await settle();
  expect(reads()).toBe(1);
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Confirm 6 device updates',
  );
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Confirm',
  );
});

it('shows a loading state when it enters Confirm', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { element, fixture, type, save, settle } = await setup({
    request: async (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path === previewReadPath) {
        entered();
        await gate;
        return Response.json(preview);
      }
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      return Response.json({}, { status: 404 });
    },
  });
  await type('North lab');
  await save();
  clickButton(element, 'Continue to confirmation');
  await reached;
  fixture.detectChanges();
  expect(element.textContent).toContain('Loading the approved scope…');
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Confirm',
  );
  expect(
    [...element.querySelectorAll('button')].some(
      (candidate) => candidate.textContent?.trim() === 'Create update job',
    ),
  ).toBe(false);

  release();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Confirm 6 device updates',
  );
});

it('shows a loading state when Back to preview re-reads the frozen scope', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let previewReads = 0;
  const { element, fixture, type, save, settle } = await setup({
    request: async (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path === previewReadPath) {
        previewReads++;
        if (previewReads === 2) {
          entered();
          await gate;
        }
        return Response.json(preview);
      }
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      return Response.json({}, { status: 404 });
    },
  });
  await reachConfirm(element, type, save, settle);
  clickButton(element, 'Back to preview');
  await reached;
  fixture.detectChanges();
  expect(element.textContent).toContain('Loading the preview…');
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Review',
  );
  expect(element.textContent).not.toContain('Continue to confirmation');

  release();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 6 device updates',
  );
});

it('shows a 410 expired preview when it enters Confirm', async () => {
  const { element, type, save, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path === previewReadPath)
        return Response.json(
          {
            reason: 'preview-expired',
            expiresAt: '2026-10-19T12:15:00.000Z',
          },
          { status: 410 },
        );
      return Response.json({}, { status: 404 });
    },
  });
  await reachConfirm(element, type, save, settle);
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Preview expired',
  );
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Confirm',
  );
  expect(element.textContent).not.toContain('Create update job');
});

it('shows a 403 permission change when it enters Confirm', async () => {
  const { element, type, save, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path === previewReadPath)
        return Response.json({ reason: 'forbidden' }, { status: 403 });
      return Response.json({}, { status: 404 });
    },
  });
  await reachConfirm(element, type, save, settle);
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update device is unavailable',
  );
  expect(element.textContent).toContain(
    'Your access does not permit this update',
  );
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Confirm',
  );
});

it('shows the offline state when it enters Confirm and keeps the draft', async () => {
  const { element, draft, type, save, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path === previewReadPath)
        return Promise.reject(new TypeError('offline'));
      return Response.json({}, { status: 404 });
    },
  });
  await reachConfirm(element, type, save, settle);
  expect(element.textContent).toContain('Cannot reach Campus Commander');
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Confirm',
  );
  expect(draft.value()).toBe('North lab');
});

it('shows a failed frozen read inside Review after Back to preview', async () => {
  let targetReads = 0;
  const { element, type, save, settle } = await setup({
    request: (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path === previewReadPath) return Response.json(preview);
      if (path.includes('/targets')) {
        targetReads++;
        if (targetReads > 2)
          return Response.json({ reason: 'forbidden' }, { status: 403 });
        return Response.json({ targets, nextCursor: null });
      }
      return Response.json({}, { status: 404 });
    },
  });
  await reachConfirm(element, type, save, settle);
  clickButton(element, 'Back to preview');
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update device is unavailable',
  );
  expect(element.querySelector('li.step.is-active')?.textContent).toContain(
    'Review',
  );
});

it('ignores a successful confirmation from an earlier opening', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => undefined;
  const sent = new Promise<void>((resolve) => {
    started = resolve;
  });
  const {
    element,
    input,
    draft,
    type,
    save,
    acknowledge,
    settle,
    close,
    open,
  } = await setup({
    request: async (path) => {
      if (path === '/api/devices/updates/previews')
        return Response.json(preview, { status: 201 });
      if (path === previewReadPath) return Response.json(preview);
      if (path.includes('/targets'))
        return Response.json({ targets, nextCursor: null });
      if (path.endsWith('/confirm')) {
        started();
        await gate;
        return Response.json(receipt, { status: 201 });
      }
      if (path === '/api/jobs/UPD-006') return Response.json(job);
      return Response.json({}, { status: 404 });
    },
  });
  await reachConfirm(element, type, save, settle);
  await acknowledge();
  clickButton(element, 'Create update job');
  await sent;

  element
    .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    ?.click();
  await close();
  await open();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 6 devices',
  );
  expect(input()?.value).toBe('North lab');

  release();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 6 devices',
  );
  expect(element.textContent).not.toContain('Job UPD-006 · Running');
  expect(draft.value()).toBe('North lab');
  expect(
    sessionStorage.getItem(
      `cc.device-update-confirmation.${principal}.${previewId}`,
    ),
  ).toBeNull();
});

it('keeps an uncertain confirmation out of a later opening', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => undefined;
  const sent = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { element, draft, type, save, acknowledge, settle, close, open } =
    await setup({
      request: async (path) => {
        if (path === '/api/devices/updates/previews')
          return Response.json(preview, { status: 201 });
        if (path === previewReadPath) return Response.json(preview);
        if (path.includes('/targets'))
          return Response.json({ targets, nextCursor: null });
        if (path.endsWith('/confirm')) {
          started();
          await gate;
          throw new TypeError('offline');
        }
        return Response.json({}, { status: 404 });
      },
    });
  await reachConfirm(element, type, save, settle);
  await acknowledge();
  clickButton(element, 'Create update job');
  await sent;

  element
    .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    ?.click();
  await close();
  await open();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 6 devices',
  );

  release();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 6 devices',
  );
  expect(element.textContent).not.toContain('The confirmation did not finish');
  expect(draft.value()).toBe('North lab');
  expect(
    sessionStorage.getItem(
      `cc.device-update-confirmation.${principal}.${previewId}`,
    ),
  ).not.toBeNull();
});
