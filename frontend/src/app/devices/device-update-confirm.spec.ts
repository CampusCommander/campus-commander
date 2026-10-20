import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type {
  DeviceUpdateJobReceipt,
  DeviceUpdatePreview,
  DeviceUpdateTarget,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { DeviceUpdateConfirmPage } from './device-update-confirm';
import { DeviceUpdateDraftStore } from './device-update-draft.store';
import { DevicesStore } from './devices.store';

const principal = '4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const previewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const nextPreviewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

const receipt: DeviceUpdateJobReceipt = {
  jobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  displayId: 'UPD-006',
  status: 'accepted',
  deviceCount: 6,
  updateCount: 6,
};

const target = (
  index: number,
  overrides: Partial<DeviceUpdateTarget> = {},
): DeviceUpdateTarget => ({
  deviceId: `synthetic-device-${index}`,
  serialNumber: `C0A1-7F2${index}`,
  field: 'annotatedLocation',
  observedValue: 'Science wing',
  approvedValue: 'North lab',
  disposition: 'eligible',
  exclusionReason: null,
  ...overrides,
});

const targets: DeviceUpdateTarget[] = Array.from({ length: 6 }, (_, index) =>
  target(index),
);

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
    ],
    preferences: { theme: 'light', navigationCollapsed: false },
  },
  csrfToken: 'a'.repeat(64),
  expiresAt: '2026-10-20T12:00:00.000Z',
};

interface ConfirmSetup {
  previewReply?: () => Promise<Response>;
  targetsReply?: () => Promise<Response>;
  confirmReply?: () => Promise<Response>;
  prepareReply?: () => Promise<Response>;
}

function setup(options: ConfirmSetup = {}) {
  const request = vi.fn(async (path: string, body?: unknown) => {
    if (path.includes('/targets'))
      return options.targetsReply
        ? options.targetsReply()
        : Response.json({ targets, nextCursor: null });
    if (path.endsWith('/confirm'))
      return options.confirmReply
        ? options.confirmReply()
        : Response.json(receipt, { status: 201 });
    if (path === '/api/devices/updates/previews' && body !== undefined)
      return options.prepareReply
        ? options.prepareReply()
        : Response.json(
            { ...preview, previewId: nextPreviewId, displayId: 'PV-007' },
            { status: 201 },
          );
    if (path.startsWith('/api/devices/updates/previews/'))
      return options.previewReply
        ? options.previewReply()
        : Response.json(preview);
    return Response.json({}, { status: 404 });
  });
  TestBed.configureTestingModule({
    imports: [DeviceUpdateConfirmPage],
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
  const fixture = TestBed.createComponent(DeviceUpdateConfirmPage);
  fixture.componentRef.setInput('previewId', previewId);
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const settle = async () => {
    for (let pass = 0; pass < 6; pass++) {
      await new Promise((resolve) => setTimeout(resolve));
      fixture.detectChanges();
      await fixture.whenStable();
    }
    fixture.detectChanges();
  };
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name,
    ) as HTMLButtonElement | undefined;
  const checkbox = () =>
    element.querySelector<HTMLInputElement>('mat-checkbox input');
  const toggle = async () => {
    checkbox()?.click();
    fixture.detectChanges();
    await settle();
  };
  return {
    fixture,
    element,
    request,
    navigate,
    button,
    checkbox,
    toggle,
    settle,
    draft: TestBed.inject(DeviceUpdateDraftStore),
  };
}

beforeEach(() => sessionStorage.clear());

it('shows the confirmation summary and the acknowledgement', async () => {
  const { element, button, checkbox, settle } = setup();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Confirm 6 device updates',
  );
  expect(element.textContent).toContain('Review the approved scope');
  expect(element.querySelector('h2')?.textContent?.trim()).toBe(
    'Update the location on 6 devices',
  );
  expect(element.textContent).toContain(
    'Annotated location changes from Science wing to North lab. Other fields remain unchanged.',
  );
  expect(element.textContent).toContain(
    'Preview PV-006 · 6 devices · 6 field changes',
  );
  expect(element.textContent).toContain('Expires');
  expect(element.textContent).toContain(
    'I reviewed all 6 devices and their final values.',
  );
  expect(checkbox()?.checked).toBe(false);
  expect(button('Create update job')?.disabled).toBe(true);
});

it('keeps Create update job disabled until the checkbox is checked', async () => {
  const { button, checkbox, toggle, settle } = setup();
  await settle();
  expect(button('Create update job')?.disabled).toBe(true);
  await toggle();
  expect(checkbox()?.checked).toBe(true);
  expect(button('Create update job')?.disabled).toBe(false);
  await toggle();
  expect(button('Create update job')?.disabled).toBe(true);
});

it('sends the preview digest and the acknowledgement', async () => {
  const { button, request, navigate, toggle, settle } = setup();
  await settle();
  await toggle();
  button('Create update job')?.click();
  await settle();
  expect(request).toHaveBeenCalledWith(
    `/api/devices/updates/previews/${previewId}/confirm`,
    { manifestDigest: 'a'.repeat(64), acknowledged: true },
  );
  expect(navigate).toHaveBeenCalledWith(['/jobs', 'UPD-006', 'receipt']);
});

it('opens the receipt for a replayed 200 answer', async () => {
  const { button, navigate, toggle, settle } = setup({
    confirmReply: async () => Response.json(receipt, { status: 200 }),
  });
  await settle();
  await toggle();
  button('Create update job')?.click();
  await settle();
  expect(navigate).toHaveBeenCalledWith(['/jobs', 'UPD-006', 'receipt']);
});

it('disables both controls and names the work while the request runs', async () => {
  let release: () => void = () => {
    throw new Error('Confirmation not started');
  };
  const { button, checkbox, toggle, settle } = setup({
    confirmReply: () =>
      new Promise((resolve) => {
        release = () => resolve(Response.json(receipt, { status: 201 }));
      }),
  });
  await settle();
  await toggle();
  button('Create update job')?.click();
  await new Promise((resolve) => setTimeout(resolve));
  // The request is in flight.
  expect(button('Creating update job…')?.disabled).toBe(true);
  expect(checkbox()?.disabled).toBe(true);
  release();
  await settle();
  expect(button('Creating update job…')).toBeUndefined();
});

it('shows the observed values when they differ between devices', async () => {
  const rows = [
    target(1, { observedValue: 'Science wing' }),
    target(2, { observedValue: 'Science wing' }),
    target(3, { observedValue: 'East hall' }),
  ];
  const { element, settle } = setup({
    previewReply: async () =>
      Response.json({ ...preview, selected: 3, eligible: 3 }),
    targetsReply: async () =>
      Response.json({ targets: rows, nextCursor: null }),
  });
  await settle();
  expect(element.textContent).toContain(
    'Annotated location changes from different current values to North lab. Other fields remain unchanged.',
  );
});

it('summarises a clear preview', async () => {
  const { element, settle } = setup({
    previewReply: async () =>
      Response.json({ ...preview, mode: 'clear', value: null }),
    targetsReply: async () =>
      Response.json({
        targets: targets.map((row) => ({ ...row, approvedValue: null })),
        nextCursor: null,
      }),
  });
  await settle();
  expect(element.querySelector('h2')?.textContent?.trim()).toBe(
    'Clear the location on 6 devices',
  );
  expect(element.textContent).toContain(
    'Annotated location is cleared on 6 devices. Other fields remain unchanged.',
  );
});

it('summarises a first value when some devices have none', async () => {
  const rows = [target(1, { observedValue: null }), target(2)];
  const { element, settle } = setup({
    previewReply: async () =>
      Response.json({ ...preview, selected: 2, eligible: 2 }),
    targetsReply: async () =>
      Response.json({ targets: rows, nextCursor: null }),
  });
  await settle();
  expect(element.textContent).toContain(
    'Annotated location changes from Science wing or no value to North lab. Other fields remain unchanged.',
  );
});

it('summarises a first value when no device has one', async () => {
  const rows = [
    target(1, { observedValue: null }),
    target(2, { observedValue: null }),
  ];
  const { element, settle } = setup({
    previewReply: async () =>
      Response.json({ ...preview, selected: 2, eligible: 2 }),
    targetsReply: async () =>
      Response.json({ targets: rows, nextCursor: null }),
  });
  await settle();
  expect(element.textContent).toContain(
    'Annotated location is set to North lab. Other fields remain unchanged.',
  );
});

it('opens the preview with Back to preview', async () => {
  const { button, navigate, settle } = setup();
  await settle();
  button('Back to preview')?.click();
  expect(navigate).toHaveBeenCalledWith([
    '/devices/update/previews',
    previewId,
  ]);
});

it.each([
  [409, { reason: 'preview-changed' }, 'Preview changed'],
  [409, { reason: 'permission-changed' }, 'Your access changed'],
  [409, { reason: 'connection-changed' }, 'The Google connection changed'],
  [422, { reason: 'nothing-to-update' }, 'Nothing to update'],
  [403, {}, 'Update device is unavailable'],
  [404, { reason: 'preview-not-found' }, 'Preview not found'],
])(
  'shows the %s answer with a recovery action on the confirmation page',
  async (status, body, title) => {
    const { element, button, toggle, settle } = setup({
      confirmReply: async () => Response.json(body, { status }),
    });
    await settle();
    await toggle();
    button('Create update job')?.click();
    await settle();
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(title);
    expect(element.querySelector('.card .actions button')).toBeDefined();
  },
);

it('shows the expired state and prepares a new preview from the draft', async () => {
  const { element, request, button, navigate, draft, toggle, settle } = setup({
    confirmReply: async () =>
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
  await toggle();
  button('Create update job')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Preview expired',
  );
  expect(element.textContent).toContain('Draft preserved · No job created');
  expect(draft.value()).toBe('North lab');
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
});

it('keeps an uncertain confirmation across a reload and replays it', async () => {
  let previewReads = 0;
  let confirmations = 0;
  const { element, button, request, navigate, toggle, settle, fixture } = setup(
    {
      previewReply: async () => {
        previewReads += 1;
        return previewReads === 1
          ? Response.json(preview)
          : Response.json(
              {
                reason: 'preview-expired',
                expiresAt: '2026-10-19T12:15:00.000Z',
              },
              { status: 410 },
            );
      },
      confirmReply: async () => {
        confirmations += 1;
        if (confirmations === 1) throw new TypeError('Failed to fetch');
        return Response.json(receipt, { status: 200 });
      },
    },
  );
  await settle();
  await toggle();
  button('Create update job')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'The confirmation did not finish',
  );
  expect(element.textContent).toContain('The result is unknown');
  expect(element.textContent).toContain(
    'Retry sends the same confirmation. If the job exists, Campus Commander returns its receipt.',
  );
  expect(element.textContent).not.toContain('No job created');
  expect(element.textContent).not.toContain('Prepare new preview');

  // A reload keeps the submitted request. It never reads the expired preview.
  fixture.destroy();
  const reload = TestBed.createComponent(DeviceUpdateConfirmPage);
  reload.componentRef.setInput('previewId', previewId);
  reload.detectChanges();
  const settleReload = async () => {
    for (let pass = 0; pass < 6; pass++) {
      await new Promise((resolve) => setTimeout(resolve));
      reload.detectChanges();
      await reload.whenStable();
    }
    reload.detectChanges();
  };
  await settleReload();
  const reloaded: HTMLElement = reload.nativeElement;
  expect(reloaded.querySelector('h1')?.textContent?.trim()).toBe(
    'The confirmation did not finish',
  );
  expect(reloaded.textContent).not.toContain('No job created');
  expect(previewReads).toBe(1);

  const retry = [...reloaded.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === 'Retry',
  ) as HTMLButtonElement;
  retry.click();
  await settleReload();
  expect(confirmations).toBe(2);
  expect(request).toHaveBeenCalledWith(
    `/api/devices/updates/previews/${previewId}/confirm`,
    { manifestDigest: 'a'.repeat(64), acknowledged: true },
  );
  expect(navigate).toHaveBeenCalledWith(['/jobs', 'UPD-006', 'receipt']);
  expect(
    sessionStorage.getItem(
      `cc.device-update-confirmation.${principal}.${previewId}`,
    ),
  ).toBeNull();
});

it.each([
  [
    'an unreadable 201 answer',
    async () => Response.json({ unexpected: true }, { status: 201 }),
  ],
  ['a 500 answer', async () => Response.json({}, { status: 500 })],
])(
  'treats %s as an uncertain confirmation and replays it',
  async (_name, firstReply) => {
    let confirmations = 0;
    const { element, button, navigate, toggle, settle } = setup({
      confirmReply: async () => {
        confirmations += 1;
        return confirmations === 1
          ? firstReply()
          : Response.json(receipt, { status: 200 });
      },
    });
    await settle();
    await toggle();
    button('Create update job')?.click();
    await settle();
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(
      'The confirmation did not finish',
    );
    expect(element.textContent).not.toContain('No job created');
    button('Retry')?.click();
    await settle();
    expect(navigate).toHaveBeenCalledWith(['/jobs', 'UPD-006', 'receipt']);
  },
);

it('keeps acceptance unknown when a replay cannot return the receipt', async () => {
  let confirmations = 0;
  const { element, button, navigate, toggle, settle } = setup({
    confirmReply: async () => {
      confirmations += 1;
      if (confirmations === 1) throw new TypeError('Failed to fetch');
      return Response.json({ reason: 'permission-changed' }, { status: 409 });
    },
  });
  await settle();
  await toggle();
  button('Create update job')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'The confirmation did not finish',
  );
  button('Retry')?.click();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'The update job may exist',
  );
  expect(element.textContent).not.toContain('No job created');
  expect(element.textContent).not.toContain('Prepare new preview');
  button('View jobs')?.click();
  expect(navigate).toHaveBeenCalledWith(['/jobs']);
});

it('shows the loading state before the approved scope arrives', () => {
  const { element } = setup({
    previewReply: () =>
      new Promise(() => {
        // The answer never arrives in this test.
      }),
  });
  expect(element.textContent).toContain('Loading the approved scope…');
});
