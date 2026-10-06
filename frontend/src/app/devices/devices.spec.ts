import { Component, computed, input, output, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type {
  DevicePredicate,
  DeviceSyncState,
} from '@campus/application-contracts';
import { DeviceFilter } from './device-filter';
import { DeviceGrid } from './device-grid';
import { DevicesPage } from './devices';
import { DevicesStore } from './devices.store';

@Component({
  selector: 'app-device-grid',
  template: '<p class="grid-stub">grid</p>',
})
class GridStub {
  readonly load = input<unknown>();
  readonly revision = input(0);
  readonly optionalColumns = input<unknown>();
  readonly focusIndex = input<number | null>(null);
  readonly state = input<unknown>();
  readonly saveState = input<unknown>();
  readonly predicates = input<unknown>();
  readonly orgUnits = input<unknown>();
  readonly details = output<unknown>();
  readonly rangeChange = output<unknown>();
  readonly filtersChange = output<unknown>();
}

const ready = (extra: Partial<DeviceSyncState> = {}): DeviceSyncState => ({
  customerId: 'C0123456',
  generation: 1,
  status: 'ready',
  observedAt: '2026-10-05T12:00:00.000Z',
  deviceCount: 450,
  failure: null,
  telemetryFailure: null,
  startedAt: null,
  checkedAt: null,
  stale: false,
  ...extra,
});

function setup(options: {
  sync: DeviceSyncState | null;
  predicates?: DevicePredicate[];
  page?: { matching: number; total: number; observedAt: string | null } | null;
  offline?: boolean;
}) {
  const sync = signal(options.sync);
  const store = {
    sync,
    syncLoaded: signal(true),
    predicates: signal(options.predicates ?? []),
    view: signal({
      predicates: options.predicates ?? [],
      sort: { field: 'serialNumber', direction: 'asc' },
      selection: null as unknown,
    }),
    gridState: signal(null),
    setView: vi.fn(),
    page: signal(options.page ?? null),
    orgUnits: signal([]),
    offline: signal(options.offline ?? false),
    error: signal(''),
    revision: signal(0),
    position: signal<number | null>(null),
    optionalColumns: signal({ annotatedLocation: false, notes: false }),
    refreshing: computed(() => sync()?.status === 'running'),
    init: vi.fn().mockResolvedValue(undefined),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    setPredicates: vi.fn(),
    rows: vi.fn(),
    loadOrgUnits: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: DevicesStore, useValue: store }],
  });
  TestBed.overrideComponent(DevicesPage, {
    remove: { imports: [DeviceGrid] },
    add: { imports: [GridStub] },
  });
  const fixture = TestBed.createComponent(DevicesPage);
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
  return {
    store,
    element,
    button,
    fixture,
    render: () => fixture.detectChanges(),
  };
}

it('offers Refresh inventory before the first sync', () => {
  const { store, element, button } = setup({
    sync: ready({ status: 'never', observedAt: null, deviceCount: 0 }),
  });
  expect(element.textContent).toContain('No device inventory yet');
  button('Refresh inventory')!.click();
  expect(store.refreshAll).toHaveBeenCalled();
  expect(element.querySelector('.grid-stub')).toBeNull();
});

it('shows the stale banner with the failure cause', () => {
  const { element, button } = setup({
    sync: ready({
      status: 'failed',
      failure: 'permission-denied',
      stale: true,
    }),
    page: { matching: 450, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  expect(element.textContent).toContain('Inventory observation is stale');
  expect(element.textContent).toContain('Add the device scopes');
  expect(button('Refresh inventory')).toBeDefined();
  expect(element.querySelector('.grid-stub')).not.toBeNull();
});

it('keeps the grid and offers Reconnect while offline', () => {
  const { store, element, button } = setup({
    sync: ready(),
    offline: true,
    page: { matching: 450, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  expect(element.textContent).toContain('Cannot reach Campus Commander');
  expect(element.querySelector('.grid-stub')).not.toBeNull();
  button('Reconnect')!.click();
  expect(store.reconnect).toHaveBeenCalled();
});

it('renders filter chips and clears them', () => {
  const { store, button } = setup({
    sync: ready(),
    predicates: [{ field: 'assetTag', operator: 'startsWith', value: 'HS-04' }],
    page: { matching: 96, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  expect(button('Asset tag starts with: HS-04')).toBeDefined();
  button('Clear filters')!.click();
  expect(store.setPredicates).toHaveBeenCalledWith([]);
});

it('shows counts and the observation time in the footer', () => {
  const { element } = setup({
    sync: ready(),
    page: {
      matching: 1234,
      total: 128431,
      observedAt: '2026-10-05T12:00:00.000Z',
    },
  });
  expect(element.querySelector('.grid-footer')?.textContent).toContain(
    '1,234 matching devices · 128,431 in district',
  );
  expect(element.querySelector('.grid-footer')?.textContent).toContain(
    'Inventory observed',
  );
});

it('shows no matches when filters exclude every device', () => {
  const { element } = setup({
    sync: ready(),
    predicates: [
      { field: 'serialNumber', operator: 'equals', value: 'ZZ-NOT-FOUND' },
    ],
    page: { matching: 0, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  expect(element.textContent).toContain('No devices match these filters');
  expect(element.textContent).toContain(
    'Check the serial or asset tag, or clear the current filters.',
  );
});

const twoChips: DevicePredicate[] = [
  { field: 'assetTag', operator: 'startsWith', value: 'HS-04' },
  { field: 'model', operator: 'contains', value: 'Lenovo' },
];

it('closes the chip editor when filters are cleared', () => {
  const { element, button, render } = setup({
    sync: ready(),
    predicates: twoChips,
    page: { matching: 10, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  button('Model contains: Lenovo')!.click();
  render();
  expect(element.querySelector('[role="dialog"]')).not.toBeNull();
  button('Clear filters')!.click();
  render();
  expect(element.querySelector('[role="dialog"]')).toBeNull();
});

it('returns focus to the chip after cancelling its edit', async () => {
  const { button, render, fixture } = setup({
    sync: ready(),
    predicates: twoChips,
    page: { matching: 10, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  button('Model contains: Lenovo')!.click();
  render();
  button('Cancel')!.click();
  render();
  await fixture.whenStable();
  expect(document.activeElement?.textContent?.trim()).toBe(
    'Model contains: Lenovo',
  );
});

it('replaces the filter of a field that already has one', () => {
  const { store, fixture } = setup({
    sync: ready(),
    predicates: twoChips,
    page: { matching: 10, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  const filter = fixture.debugElement.query(By.directive(DeviceFilter))
    .componentInstance as DeviceFilter;
  filter.applied.emit({ field: 'model', operator: 'contains', value: 'Dell' });
  expect(store.setPredicates).toHaveBeenCalledWith([
    twoChips[0],
    { field: 'model', operator: 'contains', value: 'Dell' },
  ]);
});

it('takes filters from the grid column filters', () => {
  const { store, fixture } = setup({
    sync: ready(),
    page: { matching: 10, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  const grid = fixture.debugElement.query(By.directive(GridStub))
    .componentInstance as GridStub;
  grid.filtersChange.emit([{ field: 'notes', operator: 'isEmpty' }]);
  expect(store.setPredicates).toHaveBeenCalledWith([
    { field: 'notes', operator: 'isEmpty' },
  ]);
});
