import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type { DeviceDetail } from '@campus/application-contracts';
import { DeviceDetailPage } from './device-detail';
import { DevicesStore } from './devices.store';

const device = (extra: Partial<DeviceDetail> = {}): DeviceDetail => ({
  deviceId: 'synthetic-device-1',
  serialNumber: 'C0A1-0001',
  model: 'Lenovo 100e Gen 4',
  assetTag: 'HS-0401',
  orgUnitPath: '/School A',
  lastContact: '2026-10-05T11:58:00.000Z',
  annotatedLocation: 'Science wing',
  notes: null,
  battery: {
    status: 'reported',
    health: 'replace-soon',
    capacityPercent: 78,
    reportedAt: '2026-10-05T13:50:00.000Z',
  },
  observedAt: '2026-10-05T14:00:00.000Z',
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
  offline?: boolean;
}) {
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
    position: signal<{ index: number; deviceId: string } | null>(
      options.position === undefined || options.position === null
        ? null
        : {
            index: options.position,
            deviceId: options.positionDevice ?? 'synthetic-device-1',
          },
    ),
    page: signal(
      options.matching === undefined
        ? null
        : { matching: options.matching, total: 450, observedAt: null },
    ),
    offline: signal(options.offline ?? false),
  };
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: DevicesStore, useValue: store }],
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
