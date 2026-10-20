import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type {
  DeviceUpdatePreview,
  DeviceUpdateTarget,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { DeviceUpdateDraftStore } from './device-update-draft.store';
import { DeviceUpdatePreviewPage } from './device-update-preview';
import { DevicesStore } from './devices.store';

const principal = '4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const previewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const nextPreviewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const preview: DeviceUpdatePreview = {
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

export interface PreviewSetup {
  previewReply?: () => Promise<Response>;
  targetsReply?: (cursor: string | null) => Promise<Response>;
  prepareReply?: () => Promise<Response>;
}

export function setup(options: PreviewSetup = {}) {
  const sessionSignal = signal(session);
  const request = vi.fn(async (path: string, body?: unknown) => {
    if (path.includes('/targets')) {
      const url = new URL(path, 'http://localhost');
      if (options.targetsReply)
        return options.targetsReply(url.searchParams.get('cursor'));
      return Response.json({ targets, nextCursor: null });
    }
    if (path === '/api/devices/updates/previews' && body !== undefined) {
      if (options.prepareReply) return options.prepareReply();
      return Response.json(
        { ...preview, previewId: nextPreviewId, displayId: 'PV-007' },
        { status: 201 },
      );
    }
    if (path.startsWith('/api/devices/updates/previews/')) {
      if (options.previewReply) return options.previewReply();
      return Response.json(preview);
    }
    return Response.json({}, { status: 404 });
  });
  const devices = { selectionTab: tabId, offline: signal(false) };
  TestBed.configureTestingModule({
    imports: [DeviceUpdatePreviewPage],
    providers: [
      provideRouter([]),
      { provide: DevicesStore, useValue: devices },
      {
        provide: AuthStore,
        useValue: {
          session: sessionSignal,
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
  const fixture = TestBed.createComponent(DeviceUpdatePreviewPage);
  fixture.componentRef.setInput('previewId', previewId);
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name,
    ) as HTMLButtonElement | undefined;
  const settle = async () => {
    for (let pass = 0; pass < 6; pass++) {
      await new Promise((resolve) => setTimeout(resolve));
      fixture.detectChanges();
      await fixture.whenStable();
    }
    fixture.detectChanges();
  };
  return {
    fixture,
    element,
    request,
    navigate,
    button,
    settle,
    draft: TestBed.inject(DeviceUpdateDraftStore),
  };
}

beforeEach(() => sessionStorage.clear());

it('shows the frozen summary, counts, times, and preview ID', async () => {
  const { element, settle } = setup();
  await settle();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Review 6 device updates',
  );
  expect(element.textContent).toContain('Frozen preview · Prepared');
  expect(element.textContent).toContain(
    '6 devices · 6 field changes · 0 excluded',
  );
  expect(element.textContent).toContain(
    'Targets and final values are frozen. New matching devices will not join this job.',
  );
  expect(element.textContent).toContain('Preview PV-006');
  expect(element.textContent).toContain('Expires');
  expect(element.textContent).toContain('Device');
  expect(element.textContent).toContain('Field');
  expect(element.textContent).toContain('Observed value');
  expect(element.textContent).toContain('Approved value');
  expect(element.textContent).toContain('Annotated location');
  expect(element.textContent).toContain('Science wing');
  expect(element.textContent).toContain('North lab');
});

it('pages every target through the route cursor', async () => {
  const { element, request, settle } = setup({
    targetsReply: async (cursor) =>
      cursor === null
        ? Response.json({ targets: targets.slice(0, 4), nextCursor: '4' })
        : Response.json({ targets: targets.slice(4), nextCursor: null }),
  });
  await settle();
  const targetCalls = request.mock.calls
    .map(([path]) => String(path))
    .filter((path) => path.includes('/targets'));
  expect(targetCalls).toHaveLength(2);
  expect(targetCalls[0]).toContain('limit=1000');
  expect(targetCalls[0]).not.toContain('cursor=');
  expect(targetCalls[1]).toContain('cursor=4');
  expect(element.querySelectorAll('tbody tr')).toHaveLength(6);
});

it('shows excluded targets with their reasons and unchanged targets', async () => {
  const rows = [
    target(1),
    target(2, { disposition: 'unchanged' }),
    target(3, { disposition: 'excluded', exclusionReason: 'removed' }),
    target(4, {
      disposition: 'excluded',
      exclusionReason: 'invalid-device-id',
    }),
  ];
  const { element, settle } = setup({
    targetsReply: async () =>
      Response.json({ targets: rows, nextCursor: null }),
  });
  await settle();
  expect(element.textContent).toContain('Excluded · Removed from inventory');
  expect(element.textContent).toContain(
    'Excluded · Device ID cannot be written',
  );
  expect(element.textContent).toContain('Not updated');
  expect(element.textContent).toContain('No change');
});

it('shows the stale warning of design 2.3', async () => {
  const { element, settle } = setup({
    previewReply: async () => Response.json({ ...preview, stale: true }),
  });
  await settle();
  expect(element.textContent).toContain(
    'Some observed values are more than 24 hours old. Review them before you continue.',
  );
});

it('omits the stale warning for a fresh preview', async () => {
  const { element, settle } = setup();
  await settle();
  expect(element.textContent).not.toContain('hours old');
});

it('keeps the draft when Edit draft opens the draft page', async () => {
  const { button, navigate, settle, draft } = setup();
  await settle();
  draft.setValue('North lab');
  button('Edit draft')?.click();
  expect(navigate).toHaveBeenCalledWith(['/devices/update']);
  expect(draft.value()).toBe('North lab');
});

it('opens the confirmation page with the preview ID', async () => {
  const { button, navigate, settle } = setup();
  await settle();
  button('Continue to confirmation')?.click();
  expect(navigate).toHaveBeenCalledWith([
    '/devices/update/previews',
    previewId,
    'confirm',
  ]);
});

it('disables Continue to confirmation without an eligible target', async () => {
  const { button, settle } = setup({
    previewReply: async () =>
      Response.json({
        ...preview,
        eligible: 0,
        unchanged: 6,
      }),
  });
  await settle();
  expect(button('Continue to confirmation')?.disabled).toBe(true);
  expect(button('Continue to confirmation')?.textContent).toContain(
    'Continue to confirmation',
  );
});

it('shows the expired state and prepares a new preview from the draft', async () => {
  const { element, request, button, navigate, settle, draft } = setup({
    previewReply: async () =>
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
  expect(element.textContent).toContain(
    'Prepare a new preview before confirming',
  );
  expect(element.textContent).toContain(
    'Its approval controls are no longer valid.',
  );
  expect(element.textContent).toContain(
    'Your draft remains available. A new preview rechecks targets, permissions, current values, and expiry.',
  );
  expect(draft.value()).toBe('North lab');
  button('Return to draft')?.click();
  expect(navigate).toHaveBeenCalledWith(['/devices/update']);
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

it.each([
  [409, { reason: 'preview-changed' }, 'Preview changed'],
  [409, { reason: 'permission-changed' }, 'Your access changed'],
  [409, { reason: 'connection-changed' }, 'The Google connection changed'],
  [422, { reason: 'nothing-to-update' }, 'Nothing to update'],
  [403, {}, 'Update device is unavailable'],
  [404, { reason: 'preview-not-found' }, 'Preview not found'],
])(
  'shows the %s answer with a recovery action on the preview page',
  async (status, body, title) => {
    const { element, button, settle } = setup({
      previewReply: async () => Response.json(body, { status }),
    });
    await settle();
    expect(element.querySelector('h1')?.textContent?.trim()).toBe(title);
    expect(element.querySelector('.card .actions button')).toBeDefined();
    expect(button('Return to draft')).toBeDefined();
  },
);

it('shows a loading state before the preview arrives', async () => {
  let release: () => void = () => {
    throw new Error('Preview read not started');
  };
  const { element, settle } = setup({
    previewReply: () =>
      new Promise((resolve) => {
        release = () => resolve(Response.json(preview));
      }),
  });
  expect(element.textContent).toContain('Loading the preview…');
  release();
  await settle();
  expect(element.textContent).not.toContain('Loading the preview…');
});
