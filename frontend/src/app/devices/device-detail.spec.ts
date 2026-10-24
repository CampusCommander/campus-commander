import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type { DeviceDetail } from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { DeviceDetailPage } from './device-detail';
import { DEVICE_UPDATE_PERMISSION_MESSAGE } from './device-update-messages';
import { DevicesStore } from './devices.store';

const device = (extra: Partial<DeviceDetail> = {}): DeviceDetail => ({
  deviceId: 'synthetic-device-1',
  serialNumber: 'C0A1-0001',
  model: 'Lenovo 100e Gen 4',
  assetTag: 'HS-0401',
  orgUnitPath: '/School A',
  lastContact: '2026-10-05T11:58:00.000Z',
  annotatedLocation: 'Science wing',
  annotatedUser: null,
  notes: null,
  status: 'ACTIVE',
  battery: {
    status: 'reported',
    health: 'replace-soon',
    capacityPercent: 78,
    reportedAt: '2026-10-05T13:50:00.000Z',
  },
  lastEntitySync: '2026-10-05T14:00:00.000Z',
  stale: false,
  removedAt: null,
  batteryReports: [
    {
      reportedAt: '2026-10-05T13:50:00.000Z',
      health: 'replace-soon',
      capacityPercent: 78,
    },
    {
      reportedAt: '2026-10-04T13:50:00.000Z',
      health: 'replace-soon',
      capacityPercent: null,
    },
  ],
  ...extra,
});

async function setup(options: {
  detail: DeviceDetail | null;
  position?: number | null;
  positionDevice?: string;
  nextPending?: boolean;
  matching?: number;
  count?: number;
  offline?: boolean;
  /** The three Update device permissions (docs/ui/rules.md:73). */
  allowed?: boolean;
  /** False leaves the customer scope unread, as a slow sync answer does. */
  sync?: boolean;
}) {
  const can = vi.fn(() => options.allowed ?? false);
  const store = {
    device: options.nextPending
      ? vi
          .fn()
          .mockResolvedValueOnce(options.detail)
          .mockReturnValueOnce(new Promise(() => undefined))
      : vi.fn().mockResolvedValue(options.detail),
    neighbor: vi.fn().mockResolvedValue({
      ...device(),
      deviceId: 'synthetic-device-2',
      serialNumber: 'C0A1-0002',
    }),
    position: signal<{
      index: number;
      deviceId: string;
      count?: number;
    } | null>(
      options.position === undefined || options.position === null
        ? null
        : {
            index: options.position,
            deviceId: options.positionDevice ?? 'synthetic-device-1',
            ...(options.count === undefined ? {} : { count: options.count }),
          },
    ),
    page: signal(
      options.matching === undefined
        ? null
        : { matching: options.matching, total: 450, observedAt: null },
    ),
    offline: signal(options.offline ?? false),
    // The Update device permission reads the connected customer.
    sync: signal(
      options.sync === false ? null : { customerId: 'synthetic-customer' },
    ),
    loadSync: vi.fn(async () => true),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: DevicesStore, useValue: store },
      {
        provide: AuthStore,
        useValue: {
          can,
          session: signal({
            identity: { id: 'synthetic-device-detail', grants: [] },
            expiresAt: '2026-10-20T12:00:00.000Z',
            csrfToken: 'a'.repeat(64),
          }),
          metadata: signal({
            phase: 3,
            authenticationConfigured: true,
            version: 'test',
            build: 'client-review',
          }),
          request: vi.fn(async () => Response.json({}, { status: 404 })),
        },
      },
    ],
  });
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(DeviceDetailPage);
  fixture.componentRef.setInput('deviceId', 'synthetic-device-1');
  const element: HTMLElement = fixture.nativeElement;
  // The app is zoneless, so wait for the untracked device read to render.
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(element.textContent).not.toContain('Loading device details');
  });
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
  return { store, element, navigate, button, fixture };
}

it('shows the Google battery class, capacity, and recent reports', async () => {
  const { element } = await setup({ detail: device() });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe('C0A1-0001');
  expect(element.textContent).toContain('Battery health · Replace soon');
  expect(element.textContent).toContain('78% of design capacity');
  expect(element.textContent).toContain('Classified by Google');
  expect(element.textContent).toContain('Science wing');
  expect(
    [...element.querySelectorAll('.reports li')].map((item) =>
      item.textContent?.replace(/\s+/g, ' ').trim(),
    ),
  ).toHaveLength(2);
  expect(element.textContent).toContain('No capacity');
  expect(element.textContent).toContain('Read from Google');
});

it('shows Annotated user between Annotated location and Notes', async () => {
  const { element } = await setup({
    detail: device({ annotatedUser: 'liam.foster@example.org' }),
  });
  expect(
    [...element.querySelectorAll('.annotation')].map((item) => [
      item.querySelector('dt')?.textContent?.trim(),
      item.querySelector('dd')?.textContent?.trim(),
    ]),
  ).toEqual([
    ['Annotated location', 'Science wing'],
    ['Annotated user', 'liam.foster@example.org'],
    ['Notes', 'Not set'],
  ]);
});

it('shows Not set for a device without an Annotated user', async () => {
  const { element } = await setup({ detail: device() });
  const row = [...element.querySelectorAll('.annotation')].find(
    (item) =>
      item.querySelector('dt')?.textContent?.trim() === 'Annotated user',
  );
  expect(row?.querySelector('dd')?.textContent?.trim()).toBe('Not set');
});

it('names a removed device', async () => {
  const { element } = await setup({
    detail: device({ removedAt: '2026-10-06T01:00:00.000Z' }),
  });
  expect(element.textContent).toContain('Google no longer returns this device');
});

it('names the power-status policy when Google sent no battery report', async () => {
  const { element } = await setup({
    detail: device({ battery: { status: 'no-report' }, batteryReports: [] }),
  });
  expect(element.textContent).toContain('No battery report');
  expect(element.textContent).toContain('ReportDevicePowerStatus');
});

it('explains unavailable battery data', async () => {
  const { element } = await setup({
    detail: device({ battery: { status: 'unavailable' }, batteryReports: [] }),
  });
  expect(element.textContent).toContain('Battery data unavailable');
});

it('opens the next device in the filtered order', async () => {
  const { store, navigate, button } = await setup({
    detail: device(),
    position: 0,
    matching: 2,
  });
  button('Next device')!.click();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
  expect(store.neighbor).toHaveBeenCalledWith(1);
  expect(store.position()).toEqual({
    index: 1,
    deviceId: 'synthetic-device-2',
  });
  expect(navigate).toHaveBeenCalledWith(['/devices', 'synthetic-device-2']);
});

it('disables Next device on the last matching row', async () => {
  const { button } = await setup({
    detail: device(),
    position: 1,
    matching: 2,
  });
  expect(button('Next device')!.disabled).toBe(true);
});

it('disables Next device after a deep link', async () => {
  const { button, element } = await setup({ detail: device(), position: null });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe('C0A1-0001');
  expect(button('Next device')!.disabled).toBe(true);
});

it('shows not found for a missing device', async () => {
  const { element } = await setup({ detail: null });
  expect(element.querySelector('h1')?.textContent?.trim()).toBe(
    'Device not found',
  );
});

it('disables Next device when the remembered row belongs to another device', async () => {
  const { button } = await setup({
    detail: device(),
    position: 0,
    positionDevice: 'synthetic-device-9',
    matching: 2,
  });
  expect(button('Next device')!.disabled).toBe(true);
});

it('keeps the details and Next device in place while the next device loads', async () => {
  const { element, button, fixture } = await setup({
    detail: device(),
    position: 0,
    matching: 3,
    nextPending: true,
  });
  fixture.componentRef.setInput('deviceId', 'synthetic-device-2');
  fixture.detectChanges();
  await Promise.resolve();
  fixture.detectChanges();
  expect(element.textContent).not.toContain('Loading device details');
  expect(button('Next device')).toBeDefined();
  expect(
    element.querySelector('.device-detail')?.getAttribute('aria-busy'),
  ).toBe('true');
});

it('stops Next device at the last device of its group', async () => {
  const { button } = await setup({
    detail: device(),
    position: 134,
    count: 135,
    matching: 450,
  });
  expect(button('Next device')!.disabled).toBe(true);
});

it('keeps the group size when moving to the next device', async () => {
  const { store, navigate, button } = await setup({
    detail: device(),
    position: 0,
    count: 135,
    matching: 450,
  });
  button('Next device')!.click();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
  expect(store.position()).toEqual({
    index: 1,
    deviceId: 'synthetic-device-2',
    count: 135,
  });
});

it('places Update device between Back to devices and Next device', async () => {
  const { element, button } = await setup({ detail: device(), allowed: true });
  expect(
    [...element.querySelectorAll('.actions > *')].map((item) =>
      item.textContent?.trim(),
    ),
  ).toEqual(['Back to devices', 'Update device', 'Next device']);
  expect(button('Update device')!.disabled).toBe(false);
  expect(element.querySelector('#update-device-note')).toBeNull();
});

it('disables Update device with the permission note beside it', async () => {
  const { element, button } = await setup({ detail: device() });
  const update = button('Update device')!;
  expect(update.disabled).toBe(true);
  expect(update.getAttribute('aria-describedby')).toBe('update-device-note');
  expect(element.querySelector('#update-device-note')?.textContent).toContain(
    DEVICE_UPDATE_PERMISSION_MESSAGE,
  );
});

it('disables Update device while offline and names the connection', async () => {
  const { element, button } = await setup({
    detail: device(),
    allowed: true,
    offline: true,
  });
  expect(button('Update device')!.disabled).toBe(true);
  expect(element.querySelector('#update-device-note')?.textContent).toContain(
    'Update device is unavailable while you are offline.',
  );
});

it('opens the one-device sheet over the device that the page shows', async () => {
  const { element, button, fixture } = await setup({
    detail: device(),
    allowed: true,
  });
  button('Update device')!.click();
  await fixture.whenStable();
  fixture.detectChanges();
  const sheet = element.querySelector('.bulk-sheet');
  expect(sheet?.classList.contains('is-open')).toBe(true);
  expect(sheet?.textContent).toContain('Update 1 device');
  expect(sheet?.textContent).toContain('Asset tag');
});

test('returns focus to Update device after the sheet closes', async () => {
  const { element, button, fixture } = await setup({
    detail: device(),
    allowed: true,
  });
  button('Update device')!.click();
  await fixture.whenStable();
  fixture.detectChanges();
  element
    .querySelector<HTMLButtonElement>('.sheet-head button[aria-label="Close"]')
    ?.click();
  await fixture.whenStable();
  fixture.detectChanges();
  await new Promise((resolve) => setTimeout(resolve, 20));
  fixture.detectChanges();
  await vi.waitFor(() =>
    expect(document.activeElement?.textContent?.trim()).toBe('Update device'),
  );
});

it('waits for the customer scope before it explains the restriction', async () => {
  const { element, button } = await setup({
    detail: device(),
    allowed: true,
    sync: false,
  });
  expect(button('Update device')!.disabled).toBe(true);
  expect(element.querySelector('#update-device-note')?.textContent).toContain(
    'Checking your device permissions…',
  );
});
