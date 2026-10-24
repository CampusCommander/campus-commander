import { Component, computed, input, output, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type {
  DevicePredicate,
  DeviceRow,
  DeviceSelectionSpec,
  DeviceSyncState,
  DeviceWriteAccess,
} from '@campus/application-contracts';
import {
  DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
  GOOGLE_CAPABILITIES,
  GOOGLE_SETUP_SCOPES,
  buildDelegationLink,
} from '@campus/application-contracts';
import {
  DEVICE_WRITE_ACCESS_BUSY_MESSAGE,
  DEVICE_UPDATE_PERMISSION_MESSAGE,
} from './device-update-messages';
import {
  CHANGE_STATUS_PERMISSION_MESSAGE,
  SEND_COMMAND_PERMISSION_MESSAGE,
} from './device-action-messages';
import { DeviceFilter } from './device-filter';
import { DeviceGrid } from './device-grid';
import { DevicesPage } from './devices';
import { DevicesStore } from './devices.store';
import { DeviceWriteAccessStore } from './device-write-access.store';
import { GoogleHealthStore } from '../google-connection/health.store';
import { AuthStore } from '../auth.store';

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
  readonly resumeRevision = input(0);
  readonly editable = input(false);
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

const allActions = [
  'devices:read',
  'devices:write',
  'devices:commands',
  'devices:status',
  'devices:bulk-actions',
  'connection:diagnose',
];
const grantedAccess: DeviceWriteAccess = {
  state: 'granted',
  scope: 'https://www.googleapis.com/auth/admin.directory.device.chromeos',
  failure: null,
  checkedAt: '2026-10-19T12:00:00.000Z',
};

function setup(options: {
  sync: DeviceSyncState | null;
  predicates?: DevicePredicate[];
  page?: { matching: number; total: number; observedAt: string | null } | null;
  offline?: boolean;
  freshness?: { stale: number; refreshing: boolean } | null;
  actions?: string[];
  selectionCount?: number;
  access?: DeviceWriteAccess | null;
  accessLoading?: boolean;
  accessMessage?: string;
  checking?: boolean;
  /** Use the real store, so a second activation performs a second read. */
  realAccess?: boolean;
  request?: (path: string) => Promise<Response>;
  /** The pre-filled delegation link that the health store supplies. */
  delegationHref?: string | null;
}) {
  const sync = signal(options.sync);
  const selectionSpec: DeviceSelectionSpec = {
    terms: [],
    groups: [],
    added: options.selectionCount ?? 6,
    excluded: 0,
    selectedCount: options.selectionCount ?? 6,
    expiredAt: null,
  };
  const access = signal<DeviceWriteAccess | null>(
    options.access === undefined ? grantedAccess : options.access,
  );
  const message = signal(options.accessMessage ?? '');
  const checking = signal(options.checking ?? false);
  const check = vi.fn(async () => {
    message.set(DEVICE_WRITE_ACCESS_BUSY_MESSAGE);
  });
  const writeAccess = {
    access,
    loading: signal(options.accessLoading ?? false),
    checking,
    message,
    load: vi.fn().mockResolvedValue(access()),
    check,
  };
  const delegationHref = signal<string | null>(options.delegationHref ?? null);
  const actions = new Set(options.actions ?? allActions);
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
    resumeRevision: signal(0),
    setView: vi.fn(),
    page: signal(options.page ?? null),
    orgUnits: signal([]),
    offline: signal(options.offline ?? false),
    error: signal(''),
    revision: signal(0),
    position: signal<number | null>(null),
    selection: {
      spec: signal(selectionSpec),
      revision: signal(0),
      getSpec: vi.fn(),
    },
    selectionTab: '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
    refreshing: computed(() => sync()?.status === 'running'),
    refreshStatus: signal(''),
    refreshPending: signal(false),
    init: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn(),
    gridRows: {},
    freshness: signal(options.freshness ?? null),
    jobFailure: signal(null),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    refreshSelection: vi.fn().mockResolvedValue(undefined),
    refreshDomain: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    setPredicates: vi.fn(),
    rows: vi.fn(),
    loadOrgUnits: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: DevicesStore, useValue: store },
      {
        provide: AuthStore,
        useValue: {
          session: signal(null),
          metadata: signal({ phase: 3 }),
          can: (action: string) => actions.has(action),
          request: options.request ?? vi.fn(),
        },
      },
      {
        provide: GoogleHealthStore,
        useValue: { delegationHref },
      },
      ...(options.realAccess
        ? []
        : [{ provide: DeviceWriteAccessStore, useValue: writeAccess }]),
    ],
  });
  TestBed.overrideComponent(DevicesPage, {
    remove: { imports: [DeviceGrid] },
    add: { imports: [GridStub] },
  });
  const fixture = TestBed.createComponent(DevicesPage);
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  /** The expand icon is part of the button text, so the label excludes it. */
  const buttonLabel = (candidate: Element) =>
    candidate.textContent
      ?.replace('arrow_drop_down', '')
      .replace(/\s+/g, ' ')
      .trim();
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (candidate) => buttonLabel(candidate) === name,
    );
  const dropdownIcon = (name: string) =>
    button(name)?.querySelector('.dropdown-icon') ?? null;
  const menuItem = (name: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>('button[mat-menu-item]'),
    ].find((candidate) => candidate.textContent?.trim() === name);
  /** A Refresh menu item, matched by its label rather than its supporting text. */
  const refreshItem = (name: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>('button[mat-menu-item]'),
    ].find(
      (candidate) =>
        candidate.querySelector('.refresh-menu-label')?.textContent?.trim() ===
        name,
    );
  const refreshLabels = () =>
    [...document.querySelectorAll('.refresh-menu-label')].map((label) =>
      label.textContent?.trim(),
    );
  const openMenu = async (name: string) => {
    button(name)?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const openBulk = () => openMenu('Bulk Actions');
  /** One of the two mounted action sheets, by its family. */
  const actionSheet = (family: 'command' | 'status') =>
    element.querySelector<HTMLElement>(
      `app-device-action-sheet[family="${family}"]`,
    );
  return {
    store,
    element,
    button,
    dropdownIcon,
    menuItem,
    refreshItem,
    refreshLabels,
    openMenu,
    openBulk,
    actionSheet,
    writeAccess,
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
  expect(element.textContent).toContain(
    'Google denied device access. Add https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly to the delegation client in the Google Admin Console.',
  );
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
  expect(element.querySelector('.editor[role="dialog"]')).not.toBeNull();
  button('Clear filters')!.click();
  render();
  expect(element.querySelector('.editor[role="dialog"]')).toBeNull();
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

it('passes the resume of a session to the grid', () => {
  const { store, fixture, render } = setup({ sync: ready(), page: counted });
  const grid = fixture.debugElement.query(By.directive(GridStub))
    .componentInstance as GridStub;
  expect(grid.resumeRevision()).toBe(0);
  store.resumeRevision.set(1);
  render();
  expect(grid.resumeRevision()).toBe(1);
});

describe('toolbar dropdown buttons', () => {
  const triggers = ['Refresh', 'Bulk Actions'] as const;

  it.each(triggers)(
    'renders %s as an outlined dropdown trigger with the expand icon',
    (name) => {
      const { button, dropdownIcon } = setup({ sync: ready(), page: counted });
      const trigger = button(name)!;
      expect(trigger.classList.contains('mat-mdc-outlined-button')).toBe(true);
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      const icon = dropdownIcon(name)!;
      expect(icon.textContent?.trim()).toBe('arrow_drop_down');
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.classList.contains('dropdown-icon-open')).toBe(false);
    },
  );

  it.each(triggers)(
    'opens the %s menu and rotates its icon while the menu is open',
    async (name) => {
      const { button, dropdownIcon, fixture, openMenu } = setup({
        sync: ready(),
        page: counted,
      });
      const trigger = button(name)!;
      await openMenu(name);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(dropdownIcon(name)!.classList.contains('dropdown-icon-open')).toBe(
        true,
      );

      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          keyCode: 27,
          bubbles: true,
        } as KeyboardEventInit),
      );
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(dropdownIcon(name)!.classList.contains('dropdown-icon-open')).toBe(
        false,
      );
    },
  );

  it('runs the full sync from Refresh Devices', async () => {
    const { store, menuItem, openMenu } = setup({
      sync: ready(),
      page: counted,
    });
    await openMenu('Refresh');
    expect(menuItem('Refresh all')).toBeUndefined();
    expect(menuItem('Refresh Devices')).toBeDefined();
    menuItem('Refresh Devices')!.click();
    expect(store.refreshAll).toHaveBeenCalled();
  });

  it('lists the three refresh items in order', async () => {
    const { openMenu, refreshLabels } = setup({
      sync: ready(),
      page: counted,
    });
    await openMenu('Refresh');
    expect(refreshLabels()).toEqual([
      'Refresh Selected',
      'Refresh Devices',
      'Refresh Domain',
    ]);
  });

  it('disables Refresh Selected with its supporting text at an empty selection', async () => {
    const { openMenu, refreshItem } = setup({
      sync: ready(),
      page: counted,
      selectionCount: 0,
    });
    await openMenu('Refresh');
    const item = refreshItem('Refresh Selected')!;
    expect(item.disabled).toBe(true);
    expect(item.textContent).toContain('Select devices to refresh.');
  });

  it('starts Refresh Selected when the selection holds devices', async () => {
    const { openMenu, refreshItem, store } = setup({
      sync: ready(),
      page: counted,
    });
    await openMenu('Refresh');
    const item = refreshItem('Refresh Selected')!;
    expect(item.disabled).toBe(false);
    expect(item.textContent).not.toContain('Select devices to refresh.');
    item.click();
    expect(store.refreshSelection).toHaveBeenCalled();
  });

  it('disables Refresh Domain with its supporting text without connection:diagnose', async () => {
    const { openMenu, refreshItem } = setup({
      sync: ready(),
      page: counted,
      actions: allActions.filter((action) => action !== 'connection:diagnose'),
    });
    await openMenu('Refresh');
    const item = refreshItem('Refresh Domain')!;
    expect(item.disabled).toBe(true);
    expect(item.textContent).toContain(
      'Requires the Check Google connection permission.',
    );
  });

  it('starts Refresh Domain with connection:diagnose', async () => {
    const { openMenu, refreshItem, store } = setup({
      sync: ready(),
      page: counted,
    });
    await openMenu('Refresh');
    const item = refreshItem('Refresh Domain')!;
    expect(item.disabled).toBe(false);
    expect(item.textContent).not.toContain(
      'Requires the Check Google connection permission.',
    );
    item.click();
    expect(store.refreshDomain).toHaveBeenCalled();
  });

  it('disables the Refresh trigger while a refresh request is pending', () => {
    const { store, button, render } = setup({ sync: ready(), page: counted });
    expect(button('Refresh')).toMatchObject({ disabled: false });
    store.refreshPending.set(true);
    render();
    expect(button('Refresh')).toMatchObject({ disabled: true });
  });

  it('disables Refresh Devices while a refresh runs', async () => {
    const { store, menuItem, render, openMenu } = setup({
      sync: ready(),
      page: counted,
    });
    await openMenu('Refresh');
    expect(menuItem('Refresh Devices')?.disabled).toBe(false);

    store.sync.set(ready({ status: 'running' }));
    render();
    expect(menuItem('Refresh Devices')?.disabled).toBe(true);
  });

  it('shows Refreshing… and disables the Refresh trigger while a refresh runs', () => {
    const { button } = setup({
      sync: ready({ status: 'running' }),
      page: counted,
    });
    expect(button('Refreshing…')).toMatchObject({ disabled: true });
  });
});

describe('Bulk Actions', () => {
  it('reads the Google write access state when the person can write', () => {
    const { writeAccess } = setup({ sync: ready(), page: counted });
    expect(writeAccess.load).toHaveBeenCalled();
  });

  it('does not read the write access state without a device write action', () => {
    const { writeAccess } = setup({
      sync: ready(),
      page: counted,
      actions: allActions.filter(
        (action) =>
          !['devices:write', 'devices:commands', 'devices:status'].includes(
            action,
          ),
      ),
    });
    expect(writeAccess.load).not.toHaveBeenCalled();
  });

  it('offers the three built items in order', async () => {
    const { openBulk, menuItem } = setup({ sync: ready(), page: counted });
    await openBulk();
    const items = [
      ...document.querySelectorAll<HTMLButtonElement>('button[mat-menu-item]'),
    ];
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      'Update device',
      'Send command',
      'Change status',
    ]);
    expect(menuItem('Import')).toBeUndefined();
    expect(menuItem('Export')).toBeUndefined();
  });

  it('opens the bulk action sheet from Update device', async () => {
    const { openBulk, menuItem, fixture, element } = setup({
      sync: ready(),
      page: counted,
    });
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigate')
      .mockResolvedValue(true);
    await openBulk();
    expect(menuItem('Update device')?.disabled).toBe(false);
    menuItem('Update device')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const sheet = element.querySelector('app-device-update-sheet');
    const panel = sheet?.querySelector('section[role="dialog"]');
    expect(panel?.classList.contains('is-open')).toBe(true);
    expect(panel?.querySelector('h1')?.textContent?.trim()).toBe(
      'Update 6 devices',
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('returns focus to Bulk Actions after the sheet closes', async () => {
    const { openBulk, menuItem, fixture, element, button } = setup({
      sync: ready(),
      page: counted,
    });
    await openBulk();
    menuItem('Update device')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    element
      .querySelector<HTMLButtonElement>(
        'app-device-update-sheet button[aria-label="Close"]',
      )
      ?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(
      element.querySelector('app-device-update-sheet .bulk-sheet')?.classList,
    ).not.toContain('is-open');
    expect(document.activeElement).toBe(button('Bulk Actions'));
  });

  it('disables Update device when the selection is empty', async () => {
    const { element, openBulk, menuItem } = setup({
      sync: ready(),
      page: counted,
      selectionCount: 0,
    });
    expect(element.textContent).toContain(
      'Select one or more devices to update.',
    );
    await openBulk();
    expect(menuItem('Update device')?.disabled).toBe(true);
  });

  it('shows one selection note above the grid when no device is selected', async () => {
    const { element, openBulk, menuItem } = setup({
      sync: ready(),
      page: counted,
      selectionCount: 0,
    });
    const notes = [...element.querySelectorAll('.action-note-group p')].map(
      (note) => note.textContent?.trim(),
    );
    expect(notes).toEqual(['Select one or more devices to update.']);
    await openBulk();
    for (const label of ['Update device', 'Send command', 'Change status']) {
      expect(menuItem(label)?.disabled).toBe(true);
      expect(menuItem(label)?.getAttribute('aria-describedby')).toBe(
        'bulk-note',
      );
    }
  });

  it('opens the command sheet from Send command', async () => {
    const { openBulk, menuItem, fixture, actionSheet } = setup({
      sync: ready(),
      page: counted,
    });
    await openBulk();
    expect(menuItem('Send command')?.disabled).toBe(false);
    menuItem('Send command')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const panel = actionSheet('command')?.querySelector(
      'section[role="dialog"]',
    );
    expect(panel?.classList.contains('is-open')).toBe(true);
    expect(panel?.querySelector('h1')?.textContent?.trim()).toBe(
      'Choose a device command',
    );
  });

  it('opens the status sheet from Change status', async () => {
    const { openBulk, menuItem, fixture, actionSheet } = setup({
      sync: ready(),
      page: counted,
    });
    await openBulk();
    expect(menuItem('Change status')?.disabled).toBe(false);
    menuItem('Change status')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const panel = actionSheet('status')?.querySelector(
      'section[role="dialog"]',
    );
    expect(panel?.classList.contains('is-open')).toBe(true);
    expect(panel?.querySelector('h1')?.textContent?.trim()).toBe(
      'Change device status',
    );
  });

  it('disables Send command without devices:commands and names the permission', async () => {
    const { element, openBulk, menuItem } = setup({
      sync: ready(),
      page: counted,
      actions: allActions.filter((action) => action !== 'devices:commands'),
    });
    expect(element.textContent).toContain(SEND_COMMAND_PERMISSION_MESSAGE);
    await openBulk();
    expect(menuItem('Send command')?.disabled).toBe(true);
    expect(menuItem('Change status')?.disabled).toBe(false);
  });

  it('disables Change status without devices:status and names the permission', async () => {
    const { element, openBulk, menuItem } = setup({
      sync: ready(),
      page: counted,
      actions: allActions.filter((action) => action !== 'devices:status'),
    });
    expect(element.textContent).toContain(CHANGE_STATUS_PERMISSION_MESSAGE);
    await openBulk();
    expect(menuItem('Change status')?.disabled).toBe(true);
    expect(menuItem('Send command')?.disabled).toBe(false);
  });

  it('names both action permissions while devices:bulk-actions is missing', async () => {
    const { element, button } = setup({
      sync: ready(),
      page: counted,
      actions: allActions.filter((action) => action !== 'devices:bulk-actions'),
    });
    expect(element.textContent).toContain(SEND_COMMAND_PERMISSION_MESSAGE);
    expect(element.textContent).toContain(CHANGE_STATUS_PERMISSION_MESSAGE);
    expect(button('Bulk Actions')).toMatchObject({ disabled: true });
  });

  it('enables Send command with devices:wipe alone (D2)', async () => {
    const { openBulk, menuItem } = setup({
      sync: ready(),
      page: counted,
      actions: ['devices:read', 'devices:wipe', 'devices:bulk-actions'],
    });
    await openBulk();
    expect(menuItem('Send command')?.disabled).toBe(false);
    expect(menuItem('Change status')?.disabled).toBe(true);
  });

  it('enables Change status with devices:deprovision alone (D2)', async () => {
    const { openBulk, menuItem } = setup({
      sync: ready(),
      page: counted,
      actions: ['devices:read', 'devices:deprovision', 'devices:bulk-actions'],
    });
    await openBulk();
    expect(menuItem('Change status')?.disabled).toBe(false);
    expect(menuItem('Send command')?.disabled).toBe(true);
  });

  it('reads the write access state when only devices:commands is held', () => {
    const { writeAccess } = setup({
      sync: ready(),
      page: counted,
      actions: allActions.filter(
        (action) =>
          ['devices:read', 'devices:commands', 'devices:bulk-actions'].includes(
            action,
          ) === true,
      ),
    });
    expect(writeAccess.load).toHaveBeenCalled();
  });

  it.each(['devices:read', 'devices:write'])(
    'disables Update device without %s',
    async (missing) => {
      const { element, openBulk, menuItem } = setup({
        sync: ready(),
        page: counted,
        actions: allActions.filter((action) => action !== missing),
      });
      expect(element.textContent).toContain(DEVICE_UPDATE_PERMISSION_MESSAGE);
      await openBulk();
      expect(menuItem('Update device')?.disabled).toBe(true);
    },
  );

  it('disables Bulk Actions without devices:bulk-actions', () => {
    const { button, element } = setup({
      sync: ready(),
      page: counted,
      actions: allActions.filter((action) => action !== 'devices:bulk-actions'),
    });
    expect(button('Bulk Actions')).toMatchObject({ disabled: true });
    expect(element.textContent).toContain(DEVICE_UPDATE_PERMISSION_MESSAGE);
  });

  it('disables Update device when the app is offline', async () => {
    const { element, openBulk, menuItem } = setup({
      sync: ready(),
      page: counted,
      offline: true,
    });
    expect(element.textContent).toContain(
      'Update device is unavailable while you are offline.',
    );
    await openBulk();
    expect(menuItem('Update device')?.disabled).toBe(true);
  });

  it('disables Update device while the write access is unchecked', async () => {
    const { element, openBulk, menuItem } = setup({
      sync: ready(),
      page: counted,
      access: { ...grantedAccess, state: 'unchecked', failure: null },
    });
    expect(element.textContent).toContain(
      'Campus Commander has not checked Google write access.',
    );
    await openBulk();
    expect(menuItem('Update device')?.disabled).toBe(true);
  });

  it('shows the scope-named message and copies the scope when denied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const { element, button, fixture } = setup({
      sync: ready(),
      page: counted,
      access: { ...grantedAccess, state: 'denied', failure: 'scope-mismatch' },
    });
    expect(element.textContent).toContain(DEVICE_WRITE_ACCESS_DENIED_MESSAGE);
    button('Copy scope')?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(writeText).toHaveBeenCalledWith(grantedAccess.scope);
      expect(element.textContent).toContain(
        'Copied the Google device changes scope.',
      );
    });
  });

  it('offers Recheck beside Copy scope when denied', () => {
    const { element, button, writeAccess } = setup({
      sync: ready(),
      page: counted,
      access: { ...grantedAccess, state: 'denied', failure: 'scope-mismatch' },
    });
    expect(element.textContent).toContain(DEVICE_WRITE_ACCESS_DENIED_MESSAGE);
    expect(button('Copy scope')).toBeDefined();
    expect(button('Recheck')).toBeDefined();
    button('Recheck')?.click();
    expect(writeAccess.check).toHaveBeenCalled();
  });

  const DELEGATION_LINK_TEXT =
    'Open domain-wide delegation in the Google Admin console';

  it('shows the pre-filled delegation link after Copy scope when denied', () => {
    const href = buildDelegationLink({
      clientId: '123456789',
      requested: GOOGLE_SETUP_SCOPES,
      verified: GOOGLE_CAPABILITIES.map((capability) => capability.scope),
      domain: 'example.org',
    })!;
    const { element, button } = setup({
      sync: ready(),
      page: counted,
      access: { ...grantedAccess, state: 'denied', failure: 'scope-mismatch' },
      delegationHref: href,
    });
    const note = element.querySelector('#bulk-note')!.parentElement!;
    const link = note.querySelector<HTMLAnchorElement>('a');
    expect(link).not.toBeNull();
    expect(link!.textContent?.trim()).toBe(DELEGATION_LINK_TEXT);
    expect(link!.getAttribute('href')).toBe(href);
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(
      button('Copy scope')!.compareDocumentPosition(link!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows no delegation link when the page cannot read the client ID', () => {
    const { element, button } = setup({
      sync: ready(),
      page: counted,
      access: { ...grantedAccess, state: 'denied', failure: 'scope-mismatch' },
    });
    expect(element.textContent).toContain(DEVICE_WRITE_ACCESS_DENIED_MESSAGE);
    expect(button('Copy scope')).toBeDefined();
    expect(
      element.querySelector('#bulk-note')!.parentElement!.querySelector('a'),
    ).toBeNull();
  });

  it('shows the busy answer after Recheck', async () => {
    const { element, button, writeAccess, fixture } = setup({
      sync: ready(),
      page: counted,
      access: { ...grantedAccess, state: 'unchecked', failure: null },
    });
    button('Recheck')?.click();
    expect(writeAccess.check).toHaveBeenCalled();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.textContent).toContain(DEVICE_WRITE_ACCESS_BUSY_MESSAGE);
    });
  });

  it('keeps Update device disabled while the first check runs', async () => {
    const { element, openBulk, menuItem } = setup({
      sync: ready(),
      page: counted,
      access: null,
      accessLoading: true,
    });
    expect(element.textContent).toContain('Checking Google write access…');
    await openBulk();
    expect(menuItem('Update device')?.disabled).toBe(true);
  });

  it('reads the access state again when the page activates again', async () => {
    let state: DeviceWriteAccess['state'] = 'granted';
    const request = vi.fn(async () =>
      Response.json({
        ...grantedAccess,
        state,
        failure: state === 'denied' ? 'scope-mismatch' : null,
      }),
    );
    const { fixture } = setup({
      sync: ready(),
      page: counted,
      realAccess: true,
      request,
    });
    const access = TestBed.inject(DeviceWriteAccessStore);
    await vi.waitFor(() => expect(access.state()).toBe('granted'));

    state = 'denied';
    fixture.destroy();
    const second = TestBed.createComponent(DevicesPage);
    second.detectChanges();
    await vi.waitFor(() => expect(access.state()).toBe('denied'));
    second.detectChanges();
    const element: HTMLElement = second.nativeElement;
    expect(element.textContent).toContain(DEVICE_WRITE_ACCESS_DENIED_MESSAGE);
    const names = [...element.querySelectorAll('button')].map((candidate) =>
      candidate.textContent?.trim(),
    );
    expect(names).toContain('Copy scope');
    expect(names).toContain('Recheck');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reads the access state again after a denial becomes a grant', async () => {
    let state: DeviceWriteAccess['state'] = 'denied';
    const request = vi.fn(async () =>
      Response.json({
        ...grantedAccess,
        state,
        failure: state === 'denied' ? 'scope-mismatch' : null,
      }),
    );
    const { fixture } = setup({
      sync: ready(),
      page: counted,
      realAccess: true,
      request,
    });
    const access = TestBed.inject(DeviceWriteAccessStore);
    await vi.waitFor(() => expect(access.state()).toBe('denied'));

    state = 'granted';
    fixture.destroy();
    const second = TestBed.createComponent(DevicesPage);
    second.detectChanges();
    await vi.waitFor(() => expect(access.state()).toBe('granted'));
    second.detectChanges();
    const element: HTMLElement = second.nativeElement;
    expect(element.textContent).not.toContain(
      DEVICE_WRITE_ACCESS_DENIED_MESSAGE,
    );
    expect(element.querySelector('#bulk-note')).toBeNull();
    const bulk = [...element.querySelectorAll('button')].find(
      (candidate) =>
        candidate.textContent
          ?.replace('arrow_drop_down', '')
          .replace(/\s+/g, ' ')
          .trim() === 'Bulk Actions',
    );
    bulk?.click();
    second.detectChanges();
    await second.whenStable();
    second.detectChanges();
    const item = [
      ...document.querySelectorAll<HTMLButtonElement>('button[mat-menu-item]'),
    ].find((candidate) => candidate.textContent?.trim() === 'Update device');
    expect(item?.disabled).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
