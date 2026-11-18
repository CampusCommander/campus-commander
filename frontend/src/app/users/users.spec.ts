import { Component, computed, input, output, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type {
  UserPredicate,
  UserSelectionSpec,
  UserSyncState,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { UsersPage } from './users';
import { UsersStore } from './users.store';
import { UserGrid } from './user-grid';

@Component({
  selector: 'app-user-grid',
  template: '<p class="grid-stub">grid</p>',
})
class GridStub {
  readonly load = input<unknown>();
  readonly revision = input(0);
  readonly selectionRevision = input(0);
  readonly state = input<unknown>();
  readonly saveState = input<unknown>();
  readonly selectedView = input(false);
  readonly predicates = input<unknown>();
  readonly attributes = input<unknown>();
  readonly orgUnits = input<unknown>();
  readonly selection = input<unknown>();
  readonly rowRefresh = input<unknown>();
  readonly focusIndex = input<number | null>(null);
  readonly focusScroll = input<number | null>(null);
  readonly filtersChange = output<unknown>();
  readonly details = output<{ row: unknown; index: number }>();
  readonly opened = output<{ row: unknown; index: number }>();
}

const ready = (extra: Partial<UserSyncState> = {}): UserSyncState => ({
  customerId: 'C0123456',
  generation: 1,
  status: 'ready',
  observedAt: '2026-11-16T12:00:00.000Z',
  userCount: 450,
  failure: null,
  startedAt: null,
  checkedAt: null,
  stale: false,
  ...extra,
});

const selectionSpec: UserSelectionSpec = {
  terms: [{ type: 'all', predicates: [] }],
  added: 0,
  excluded: 0,
  selectedCount: 0,
  expiredAt: null,
};

function setup(options: {
  sync: UserSyncState | null;
  syncLoaded?: boolean;
  statusError?: string;
  statusRetryable?: boolean;
  predicates?: UserPredicate[];
  page?: { matching: number; total: number; observedAt: string | null } | null;
  emptyFilter?: boolean;
  offline?: boolean;
  freshness?: { stale: number; refreshing: boolean } | null;
  actions?: string[];
}) {
  const sync = signal(options.sync);
  const predicates = signal<UserPredicate[]>(options.predicates ?? []);
  const emptyFilter = signal(options.emptyFilter ?? false);
  const actions = new Set(options.actions ?? ['users:read']);
  const store = {
    sync,
    syncLoaded: signal(options.syncLoaded ?? true),
    statusError: signal(options.statusError ?? ''),
    statusRetryable: signal(options.statusRetryable ?? false),
    predicates,
    view: signal({
      predicates: options.predicates ?? [],
      sort: { field: 'fullName', direction: 'asc' },
      selection: null,
    }),
    gridState: signal(null),
    selectedView: signal(false),
    position: signal(null),
    cursor: signal(null),
    emptyFilter,
    setEmptyFilter: vi.fn((empty: boolean) => emptyFilter.set(empty)),
    setView: vi.fn(),
    page: signal(options.page ?? null),
    orgUnits: signal([]),
    attributes: signal([]),
    categoriesError: signal(''),
    categoriesRecovery: signal(false),
    categories: signal(null),
    categoriesLoading: signal(false),
    categoriesRefreshing: signal(false),
    categoriesFailure: signal(null),
    loadCategories: vi.fn().mockResolvedValue(undefined),
    refreshCategories: vi.fn().mockResolvedValue(undefined),
    offline: signal(options.offline ?? false),
    error: signal(''),
    revision: signal(0),
    selection: {
      spec: signal(selectionSpec),
      getSpec: vi.fn(),
      applyOps: vi.fn(),
      resolveSelected: vi.fn(),
    },
    selectionTab: '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
    selectionRevision: signal(0),
    refreshing: computed(() => sync()?.status === 'running'),
    refreshStatus: signal(''),
    refreshPending: signal(false),
    selectedCount: computed(() => 0),
    init: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn(),
    rowRefresh: {},
    freshness: signal(options.freshness ?? null),
    jobFailure: signal(null),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    refreshSelection: vi.fn().mockResolvedValue(undefined),
    refreshDomain: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    setPredicates: vi.fn((next: UserPredicate[]) => predicates.set(next)),
    clearFilters: vi.fn(() => {
      predicates.set([]);
      emptyFilter.set(false);
    }),
    rows: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: UsersStore, useValue: store },
      { provide: UserGrid, useClass: GridStub },
      {
        provide: AuthStore,
        useValue: {
          session: signal(null),
          metadata: signal({ phase: 3 }),
          can: (action: string) => actions.has(action),
          request: vi.fn(),
        },
      },
    ],
  });
  return store;
}

function render() {
  const fixture = TestBed.createComponent(UsersPage);
  fixture.detectChanges();
  return fixture;
}

const text = (fixture: ReturnType<typeof render>) =>
  (fixture.nativeElement as HTMLElement).textContent ?? '';

const button = (fixture: ReturnType<typeof render>, label: string) =>
  [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
    (element) => element.textContent?.includes(label),
  );

/** The two view tabs of the page. */
const viewTabs = (fixture: ReturnType<typeof render>) =>
  [
    ...(fixture.nativeElement as HTMLElement).querySelectorAll(
      'nav[aria-label="Users views"] [mat-tab-link]',
    ),
  ] as HTMLElement[];

describe('the Users page', () => {
  it('shows the loading line before the status read answers', () => {
    setup({ sync: null, syncLoaded: false });
    const fixture = render();
    expect(text(fixture)).toContain('Loading users…');
  });

  it('names the Google connection when the customer has no directory', () => {
    setup({ sync: null });
    const fixture = render();
    const element = fixture.nativeElement as HTMLElement;
    expect(
      element.querySelector('#users-connect-title')?.textContent,
    ).toContain('Connect Google Workspace');
    expect(
      element.querySelector('a[href="/google-connection"]'),
    ).not.toBeNull();
  });

  it('names the first refresh when the directory has no observation', () => {
    setup({ sync: ready({ status: 'never', observedAt: null }) });
    const fixture = render();
    expect(text(fixture)).toContain('No user directory yet');
    expect(button(fixture, 'Refresh users')).toBeTruthy();
  });

  it('keeps the Users tab above the grid', () => {
    setup({
      sync: ready(),
      page: { matching: 12, total: 450, observedAt: null },
    });
    const fixture = render();
    const element = fixture.nativeElement as HTMLElement;
    const tab = element.querySelector(
      'nav[aria-label="Users views"] [mat-tab-link]',
    );
    expect(tab?.textContent?.trim()).toBe('Users');
    expect(tab?.getAttribute('aria-selected')).toBe('true');
    expect(element.querySelector('app-user-grid')).not.toBeNull();
  });

  it('shows the Custom attributes tab beside Users (U2)', () => {
    setup({
      sync: ready(),
      page: { matching: 12, total: 450, observedAt: null },
    });
    const fixture = render();
    const element = fixture.nativeElement as HTMLElement;
    const tabs = [
      ...element.querySelectorAll(
        'nav[aria-label="Users views"] [mat-tab-link]',
      ),
    ].map((tab) => tab.textContent?.trim());
    expect(tabs).toEqual(['Users', 'Custom attributes']);
  });

  it('swaps the grid for the category tab and back', () => {
    setup({
      sync: ready(),
      page: { matching: 12, total: 450, observedAt: null },
    });
    const fixture = render();
    const element = fixture.nativeElement as HTMLElement;
    const tabs = element.querySelectorAll(
      'nav[aria-label="Users views"] [mat-tab-link]',
    );
    (tabs[1] as HTMLElement).click();
    fixture.detectChanges();
    expect(
      element.querySelector('app-user-attribute-categories'),
    ).not.toBeNull();
    expect(element.querySelector('app-user-grid')).toBeNull();
    expect(element.textContent).toContain('Loading custom attributes…');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    (tabs[0] as HTMLElement).click();
    fixture.detectChanges();
    expect(element.querySelector('app-user-grid')).not.toBeNull();
    expect(element.querySelector('app-user-attribute-categories')).toBeNull();
  });

  it('keeps both tabs while the directory has no observation (R1)', () => {
    setup({ sync: ready({ status: 'never', observedAt: null }) });
    const fixture = render();
    const element = fixture.nativeElement as HTMLElement;
    expect(viewTabs(fixture).map((tab) => tab.textContent?.trim())).toEqual([
      'Users',
      'Custom attributes',
    ]);
    expect(text(fixture)).toContain('No user directory yet');
    viewTabs(fixture)[1].click();
    fixture.detectChanges();
    expect(
      element.querySelector('app-user-attribute-categories'),
    ).not.toBeNull();
  });

  it('keeps both tabs when the directory status read failed (R1)', () => {
    setup({ sync: null, statusError: 'User directory status is unavailable.' });
    const fixture = render();
    const element = fixture.nativeElement as HTMLElement;
    expect(viewTabs(fixture).map((tab) => tab.textContent?.trim())).toEqual([
      'Users',
      'Custom attributes',
    ]);
    viewTabs(fixture)[1].click();
    fixture.detectChanges();
    expect(
      element.querySelector('app-user-attribute-categories'),
    ).not.toBeNull();
  });

  it('says no user matches the filters and clears them', () => {
    const store = setup({
      sync: ready(),
      predicates: [{ field: 'fullName', operator: 'contains', value: 'zz' }],
      page: { matching: 0, total: 450, observedAt: null },
    });
    const fixture = render();
    expect(text(fixture)).toContain('No users match these filters');
    button(fixture, 'Clear filters')?.click();
    expect(store.clearFilters).toHaveBeenCalled();
  });

  it('shows the empty result of a filter that matches no row (R6)', () => {
    // An empty BOOLEAN set filter has no chip and no query. The grid shows no row.
    const store = setup({
      sync: ready(),
      page: { matching: 0, total: 450, observedAt: null },
      emptyFilter: true,
    });
    const fixture = render();
    expect(text(fixture)).toContain('No users match these filters');
    const clear = button(fixture, 'Clear filters') as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    clear.click();
    expect(store.clearFilters).toHaveBeenCalled();
  });

  it('keeps the empty filter recovery apart from an empty directory (R6)', () => {
    setup({
      sync: ready(),
      page: { matching: 0, total: 0, observedAt: null },
      emptyFilter: true,
    });
    const fixture = render();
    expect(text(fixture)).not.toContain('No users in this directory');
    expect(text(fixture)).toContain('No users match these filters');
  });

  it('says the directory holds no users', () => {
    setup({ sync: ready(), page: { matching: 0, total: 0, observedAt: null } });
    const fixture = render();
    expect(text(fixture)).toContain('No users in this directory');
  });

  it('shows one chip for each filter and removes it', () => {
    const store = setup({
      sync: ready(),
      predicates: [{ field: 'status', operator: 'is', values: ['active'] }],
      page: { matching: 12, total: 450, observedAt: null },
    });
    const fixture = render();
    expect(text(fixture)).toContain('Status · Active');
    const remove = (fixture.nativeElement as HTMLElement).querySelector(
      '.chip-remove',
    ) as HTMLButtonElement;
    remove.click();
    expect(store.setPredicates).toHaveBeenCalledWith([]);
  });

  it('announces a stale directory with the stale user count', () => {
    setup({
      sync: ready(),
      page: { matching: 12, total: 450, observedAt: null },
      freshness: { stale: 2, refreshing: false },
    });
    const fixture = render();
    const id = (fixture.nativeElement as HTMLElement).querySelector(
      '#users-stale-title',
    );
    expect(id?.textContent).toContain('Directory observation is stale');
    expect(text(fixture)).toContain('2 of 12 users');
  });

  it('reports an offline Campus Commander and keeps the cached directory', () => {
    setup({
      sync: ready(),
      offline: true,
      page: { matching: 12, total: 450, observedAt: null },
    });
    const fixture = render();
    expect(text(fixture)).toContain('Cannot reach Campus Commander');
    expect(text(fixture)).toContain('Cached directory remains visible.');
  });

  it('returns focus to Add a filter when the editor closes with Escape (UI-09)', async () => {
    setup({
      sync: ready(),
      page: { matching: 12, total: 450, observedAt: null },
    });
    const fixture = render();
    const add = button(fixture, 'Add a filter') as HTMLButtonElement;
    add.click();
    fixture.detectChanges();
    const input = (fixture.nativeElement as HTMLElement).querySelector(
      'input[role="combobox"]',
    ) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    const trigger = (fixture.nativeElement as HTMLElement).querySelector(
      'button.add-filter',
    );
    expect(document.activeElement).toBe(trigger);
  });

  it('offers a retry when the status read fails (R11)', () => {
    const store = setup({
      sync: null,
      syncLoaded: false,
      statusError: 'User directory status is unavailable.',
      statusRetryable: true,
    });
    const fixture = render();
    expect(text(fixture)).toContain('User directory status is unavailable.');
    // The failed read is not still shown as a loading page.
    expect(text(fixture)).not.toContain('Loading users…');
    (button(fixture, 'Retry') as HTMLButtonElement).click();
    expect(store.init).toHaveBeenCalled();
  });

  it('names a denied status read without a retry that cannot help', () => {
    setup({
      sync: null,
      syncLoaded: false,
      statusError:
        'You do not have permission to read users for this customer.',
    });
    const fixture = render();
    expect(text(fixture)).toContain(
      'You do not have permission to read users for this customer.',
    );
    expect(button(fixture, 'Retry')).toBeUndefined();
  });

  it('keeps the cached grid when a later status read fails (R11)', () => {
    setup({
      sync: ready(),
      statusError: 'User directory status is unavailable.',
      statusRetryable: true,
      page: { matching: 12, total: 450, observedAt: null },
    });
    const fixture = render();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('app-user-grid')).not.toBeNull();
    expect(text(fixture)).toContain('User directory status is unavailable.');
  });
});
