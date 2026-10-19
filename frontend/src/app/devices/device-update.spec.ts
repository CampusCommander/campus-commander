import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type {
  DeviceSelectionSpec,
  DeviceUpdatePreview,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { DeviceUpdateDraftStore } from './device-update-draft.store';
import { DeviceUpdatePage } from './device-update';
import { DevicesStore } from './devices.store';

const principal = '4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const tabId = '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';

const selection = (selectedCount: number, expiredAt: string | null = null) => ({
  terms: [],
  groups: [],
  added: selectedCount,
  excluded: 0,
  selectedCount,
  expiredAt,
});

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

function setup(options: {
  count?: number;
  expiredAt?: string | null;
  spec?: DeviceSelectionSpec | null;
  getSpec?: () => Promise<unknown>;
  request?: (path: string, body?: unknown) => Promise<Response>;
}) {
  const spec = signal<DeviceSelectionSpec | null>(
    options.spec === undefined
      ? selection(options.count ?? 6, options.expiredAt ?? null)
      : options.spec,
  );
  const getSpec = vi.fn(
    options.getSpec ??
      (async () => {
        spec.set(selection(options.count ?? 6, options.expiredAt ?? null));
        return { terms: [], selectedCount: options.count ?? 6 };
      }),
  );
  const devices = {
    selection: { getSpec, spec },
    selectionTab: tabId,
    selectedView: signal(false),
    offline: signal(false),
  };
  const request = vi.fn(
    options.request ?? (async () => Response.json(preview, { status: 201 })),
  );
  TestBed.configureTestingModule({
    imports: [DeviceUpdatePage],
    providers: [
      provideRouter([]),
      { provide: DevicesStore, useValue: devices },
      {
        provide: AuthStore,
        useValue: {
          session: signal({
            identity: { id: principal },
            expiresAt: '2026-10-20T12:00:00.000Z',
            csrfToken: 'a'.repeat(64),
          }),
          request,
        },
      },
    ],
  });
  const navigate = vi
    .spyOn(TestBed.inject(Router), 'navigate')
    .mockResolvedValue(true);
  const fixture = TestBed.createComponent(DeviceUpdatePage);
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
  const input = () =>
    element.querySelector<HTMLInputElement>('input[name="annotatedLocation"]');
  const type = async (value: string) => {
    const field = input();
    if (!field) throw new Error('The annotated-location field is missing.');
    field.value = value;
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const submit = async () => {
    element.querySelector('form')?.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    // Zoneless Angular does not track the handler's promise, so settle it here.
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const ready = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    // Material writes the select trigger text in a later pass.
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return {
    fixture,
    element,
    devices,
    getSpec,
    request,
    navigate,
    button,
    input,
    type,
    submit,
    ready,
    draft: TestBed.inject(DeviceUpdateDraftStore),
  };
}

beforeEach(() => sessionStorage.clear());

it('shows the draft fields, the count, and no Organization unit', async () => {
  const { element, ready, button } = setup({ count: 6000 });
  await ready();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 6,000 devices',
  );
  expect(element.textContent).toContain('Draft changes · Not submitted');
  expect(element.textContent).toContain(
    '6,000 devices · 0 changed fields · Not submitted',
  );
  expect(element.textContent).toContain('Annotated location');
  expect(element.textContent).toContain('Change mode');
  expect(element.textContent).toContain('Update · Replace the existing value');
  expect(element.textContent).toContain(
    'Your draft stays available when you filter, scroll, or refresh.',
  );
  expect(element.textContent).toContain(
    'Asset tag and notes remain unchanged. Telemetry is read-only.',
  );
  expect(element.textContent).toContain(
    'To remove an annotation, choose Clear value explicitly.',
  );
  expect(element.textContent).not.toContain('Organization unit');
  expect(button('Reset')).toBeDefined();
  expect(button('Review pending devices')).toBeDefined();
  expect(button('Save and preview')).toBeDefined();
});

it('shows one device and one changed field in the singular', async () => {
  const { element, ready, type } = setup({ count: 1 });
  await ready();
  await type('North lab');
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Update 1 device',
  );
  expect(element.textContent).toContain(
    '1 device · 1 changed field · Not submitted',
  );
});

it('restores the saved draft after a refresh', async () => {
  sessionStorage.setItem(
    `cc.device-update-draft.${principal}`,
    JSON.stringify({ value: 'North lab', mode: 'replace' }),
  );
  const { input, element, ready } = setup({ count: 6 });
  await ready();
  expect(input()?.value).toBe('North lab');
  expect(element.textContent).toContain(
    '6 devices · 1 changed field · Not submitted',
  );
});

it('sends the replace value and opens the preview route', async () => {
  const { element, ready, type, submit, request, navigate, draft } = setup({
    count: 6,
  });
  await ready();
  await type('North lab');
  expect(element.querySelector('form')).not.toBeNull();
  await submit();
  expect(request).toHaveBeenCalledWith('/api/devices/updates/previews', {
    gridId: 'devices',
    tabId,
    mode: 'replace',
    value: 'North lab',
  });
  expect(navigate).toHaveBeenCalledWith([
    '/devices/update/previews',
    preview.previewId,
  ]);
  expect(draft.value()).toBe('North lab');
});

it('sends a clear choice without a value', async () => {
  const { element, ready, request, submit, fixture } = setup({ count: 6 });
  await ready();
  const trigger = element.querySelector<HTMLElement>('.mat-mdc-select-trigger');
  expect(trigger).not.toBeNull();
  trigger?.click();
  fixture.detectChanges();
  await fixture.whenStable();
  const options = [...document.querySelectorAll<HTMLElement>('mat-option')];
  const clear = options.find((option) =>
    option.textContent?.includes('Clear value'),
  );
  expect(clear).toBeDefined();
  clear?.click();
  fixture.detectChanges();
  await fixture.whenStable();
  await submit();
  expect(request).toHaveBeenCalledWith('/api/devices/updates/previews', {
    gridId: 'devices',
    tabId,
    mode: 'clear',
  });
  expect(
    element.querySelector<HTMLInputElement>('input[name="annotatedLocation"]')
      ?.readOnly,
  ).toBe(true);
});

it('rejects a whitespace-only value and keeps Save and preview disabled', async () => {
  const { element, ready, type } = setup({ count: 6 });
  await ready();
  await type('   ');
  expect(element.textContent).toContain('A value needs a visible character.');
  const save = [...element.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes('Save and preview'),
  ) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
});

it('rejects a value above 200 code points', async () => {
  const { element, ready, type } = setup({ count: 6 });
  await ready();
  await type('😀'.repeat(201));
  expect(element.textContent).toContain('A value holds 1 to 200 characters.');
});

it('keeps the draft and shows the expired selection on a 409 answer', async () => {
  const { element, ready, type, submit, request, button, draft, navigate } =
    setup({
      count: 6,
      request: async () =>
        Response.json(
          {
            reason: 'selection-expired',
            expiredAt: '2026-10-19T00:00:00.000Z',
          },
          { status: 409 },
        ),
    });
  await ready();
  await type('North lab');
  await submit();
  expect(request).toHaveBeenCalled();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Selection expired',
  );
  expect(element.textContent).toContain('No job created');
  expect(element.textContent).toContain('Select the devices again');
  expect(element.textContent).toContain(
    'The browsing selection expired. Approved jobs and their frozen targets remain available.',
  );
  expect(element.textContent).toContain(
    'Review the current filters before selecting devices again. New matches do not join previously approved jobs.',
  );
  expect(button('View existing jobs')).toBeUndefined();
  expect(draft.value()).toBe('North lab');
  button('Return to devices')?.click();
  expect(navigate).toHaveBeenCalledWith(['/devices']);
});

it('shows the expired selection as soon as the stored selection lapsed', async () => {
  const { element, ready } = setup({
    count: 0,
    expiredAt: '2026-10-19T00:00:00.000Z',
  });
  await ready();
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Selection expired',
  );
  expect(element.textContent).not.toContain('No devices are selected');
});

it('returns to the selected devices in the grid and keeps the draft', async () => {
  const { ready, type, button, devices, navigate, draft } = setup({ count: 6 });
  await ready();
  await type('North lab');
  button('Review pending devices')?.click();
  expect(devices.selectedView()).toBe(true);
  expect(navigate).toHaveBeenCalledWith(['/devices']);
  expect(draft.value()).toBe('North lab');
});

it('shows the empty selection state', async () => {
  const { element, ready, button, navigate } = setup({ count: 0 });
  await ready();
  expect(element.textContent).toContain('No devices are selected');
  expect(element.querySelector('form')).toBeNull();
  button('Return to devices')?.click();
  expect(navigate).toHaveBeenCalledWith(['/devices']);
});

it('shows a loading state before the selection arrives', async () => {
  let release: (value: unknown) => void = () => {
    throw new Error('Selection read not started');
  };
  const { element, ready } = setup({
    count: 6,
    getSpec: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  expect(element.textContent).toContain('Loading the selection…');
  release({ terms: [], selectedCount: 6 });
  await ready();
  expect(element.textContent).not.toContain('Loading the selection…');
});
