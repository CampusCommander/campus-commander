import { Component, computed, input, output, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type {
  DevicePredicate,
  DeviceRow,
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
  readonly loadGroups = input<unknown>();
  readonly revision = input(0);
  readonly focusIndex = input<number | null>(null);
  readonly state = input<unknown>();
  readonly saveState = input<unknown>();
  readonly predicates = input<unknown>();
  readonly orgUnits = input<unknown>();
  readonly selection = input<unknown>();
  readonly rowRefresh = input<unknown>();
  readonly selectedView = input(false);
  readonly details = output<{
    row: DeviceRow;
    index: number;
    route: string[] | null;
    count: number | null;
  }>();
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
  freshness?: { stale: number; refreshing: boolean } | null;
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
    selectedView: signal(false),
    setView: vi.fn(),
    page: signal(options.page ?? null),
    orgUnits: signal([]),
    offline: signal(options.offline ?? false),
    error: signal(''),
    revision: signal(0),
    position: signal<number | null>(null),
    selection: { spec: signal(null) },
    selectionTab: '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
    refreshing: computed(() => sync()?.status === 'running'),
    init: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn(),
    gridRows: {},
    freshness: signal(options.freshness ?? null),
    jobFailure: signal(null),
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

it('keeps the grid visible while Show All Selected finds nothing', () => {
  const { store, element, render } = setup({
    sync: ready(),
    predicates: twoChips,
    page: { matching: 0, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  expect(element.textContent).toContain('No devices match these filters');
  store.view.set({
    predicates: twoChips,
    sort: { field: 'serialNumber', direction: 'asc' },
    selection: { gridId: 'devices', tabId: 't' },
  });
  render();
  expect(element.textContent).not.toContain('No devices match these filters');
  expect(
    element.querySelector('app-device-grid')?.classList.contains('hidden'),
  ).toBe(false);
});

it('keeps the grid state and the selected view when the grid closes', () => {
  const { store, fixture } = setup({
    sync: ready(),
    page: { matching: 28, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  const grid = fixture.debugElement.query(By.directive(GridStub))
    .componentInstance as GridStub;
  const save = grid.saveState() as (
    state: object,
    selectedView: boolean,
  ) => void;
  save({ pagination: { page: 1, pageSize: 100 } }, true);
  expect(store.gridState()).toEqual({ pagination: { page: 1, pageSize: 100 } });
  expect(store.selectedView()).toBe(true);
});

it('follows the group of the opened device for Next device', () => {
  const { store, fixture } = setup({
    sync: ready(),
    page: { matching: 450, total: 450, observedAt: '2026-10-05T12:00:00.000Z' },
  });
  const navigate = vi
    .spyOn(TestBed.inject(Router), 'navigate')
    .mockResolvedValue(true);
  store.view.set({
    predicates: [],
    sort: { field: 'serialNumber', direction: 'asc' },
    selection: null,
    group: { by: ['battery'], keys: [] },
  } as never);
  const grid = fixture.debugElement.query(By.directive(GridStub))
    .componentInstance as GridStub;
  grid.details.emit({
    row: { deviceId: 'd7' } as DeviceRow,
    index: 4,
    route: ['replace-soon'],
    count: 135,
  });
  expect(store.view()).toMatchObject({
    group: { by: ['battery'], keys: ['replace-soon'] },
  });
  expect(store.position()).toEqual({ index: 4, deviceId: 'd7', count: 135 });
  expect(navigate).toHaveBeenCalledWith(['/devices', 'd7']);
});

it('opens the event stream on mount and closes it on leave', () => {
  const { store, fixture } = setup({ sync: ready() });
  expect(store.init).toHaveBeenCalled();
  fixture.destroy();
  expect(store.leave).toHaveBeenCalled();
});

const counted = {
  matching: 12,
  total: 450,
  observedAt: '2026-10-05T12:00:00.000Z',
};

it('shows refresh progress while stale devices refresh', () => {
  const { element, button } = setup({
    sync: ready(),
    page: counted,
    freshness: { stale: 1, refreshing: true },
  });
  expect(
    element.querySelector('#devices-stale-title')?.textContent?.trim(),
  ).toBe('Refreshing 1 of 12 devices');
  expect(button('Refresh inventory')).toBeUndefined();
});

it('offers Refresh inventory when stale devices are not refreshing', () => {
  const { element, button } = setup({
    sync: ready(),
    page: counted,
    freshness: { stale: 3, refreshing: false },
  });
  expect(element.textContent).toContain('Inventory observation is stale');
  expect(element.textContent).toContain(
    '3 of 12 devices were last read from Google more than 24 hours ago.',
  );
  expect(button('Refresh inventory')).toBeDefined();
});

it('hides the banner when no matching device is stale, even after a day without a full sync', () => {
  const { element } = setup({
    sync: ready({ stale: true }),
    page: counted,
    freshness: { stale: 0, refreshing: false },
  });
  expect(element.textContent).not.toContain('Inventory observation is stale');
  expect(element.querySelector('#devices-stale-title')).toBeNull();
});
