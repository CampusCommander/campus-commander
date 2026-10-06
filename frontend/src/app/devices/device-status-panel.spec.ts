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
    offline: signal(false),
    sync: signal({ stale: false }),
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
    added: 0,
    excluded: 1,
    selectedCount: 95,
  });
  render();
  expect(element.textContent).toContain(
    'Selected by filter: Asset tag starts with: HS-04 · 1 excluded',
  );
});
