import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { DeviceSelectionSpec } from '@campus/application-contracts';
import { DeviceStatusPanel } from './device-status-panel';
import { DevicesStore } from './devices.store';

function setup(
  page: { matching: number; total: number; observedAt: string } | null,
) {
  const store = {
    page: signal(page),
    pendingMatching: signal<number | null>(null),
    offline: signal(false),
    groupLimit: signal(false),
    sync: signal({ stale: false }),
    refreshStatus: signal(''),
    selection: { spec: signal<DeviceSelectionSpec | null>(null) },
  };
  TestBed.configureTestingModule({
    providers: [{ provide: DevicesStore, useValue: store }],
  });
  const fixture = TestBed.createComponent(DeviceStatusPanel);
  fixture.detectChanges();
  return {
    store,
    element: fixture.nativeElement as HTMLElement,
    render: () => fixture.detectChanges(),
  };
}

it('shows counts and the observation time', () => {
  const { element } = setup({
    matching: 1234,
    total: 128431,
    observedAt: '2026-10-05T12:00:00.000Z',
  });
  expect(element.textContent).toContain(
    '1,234 matching devices · 128,431 in district',
  );
  expect(element.textContent).toContain('Inventory observed');
});

it('names cached and stale inventory', () => {
  const { store, element, render } = setup({
    matching: 10,
    total: 450,
    observedAt: '2026-10-05T12:00:00.000Z',
  });
  store.sync.set({ stale: true });
  render();
  expect(element.textContent).toContain('Refresh required');
  store.offline.set(true);
  render();
  expect(element.textContent).toContain('Connection unavailable');
});

it('shows what Select All captured', () => {
  const { store, element, render } = setup(null);
  expect(element.textContent).toContain('Loading devices…');
  store.selection.spec.set({
    terms: [
      {
        type: 'all',
        predicates: [
          { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
        ],
      },
    ],
    groups: [],
    added: 0,
    excluded: 1,
    selectedCount: 95,
    expiredAt: null,
  });
  render();
  expect(element.textContent).toContain(
    'Selected by filter: Asset tag starts with: HS-04 · 1 excluded',
  );
});

it('says when an open group lists only its first devices', () => {
  const { store, element, render } = setup(null);
  store.groupLimit.set(true);
  render();
  expect(element.textContent).toContain(
    'Open groups list their first 1,000 devices. Add a filter to see the rest.',
  );
});

const refreshMessages = [
  'Refresh started for 6 devices. Rows update as Google answers.',
  'Another refresh already reads these 6 devices.',
  'Domain details refreshed.',
  'Domain details did not refresh: another Google check ran in the last 30 seconds.',
  'Domain details did not refresh: Campus Commander cannot run the Google check now.',
  'Domain details did not refresh: Google access denied.',
  'Your selection expired. Select the devices again.',
  'The selection holds no devices.',
  'The selection holds more than 100,000 devices. Use Refresh Devices to read every device.',
];

it.each(refreshMessages)('shows the refresh status line: %s', (message) => {
  const { store, element, render } = setup(null);
  expect(element.querySelector('.refresh-status')).toBeNull();
  store.refreshStatus.set(message);
  render();
  expect(element.querySelector('.refresh-status')?.textContent?.trim()).toBe(
    message,
  );
});

it('counts the pending view while the grid shows it', () => {
  const { store, element, render } = setup({
    matching: 1234,
    total: 128431,
    observedAt: '2026-10-05T12:00:00.000Z',
  });
  expect(element.textContent).toContain(
    '1,234 matching devices · 128,431 in district',
  );
  store.pendingMatching.set(4);
  render();
  expect(element.textContent).toContain(
    '4 matching devices · 128,431 in district',
  );
  store.pendingMatching.set(null);
  render();
  expect(element.textContent).toContain(
    '1,234 matching devices · 128,431 in district',
  );
});
