import { Component, computed, input, output, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type {
  UserAttributeCategory,
  UserAttributeField,
  UserPredicate,
  UserRow,
  UserSelectionSpec,
  UserSyncState,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { UsersPage } from './users';
import { UsersStore } from './users.store';
import { UserGrid } from './user-grid';
import { UserAttributeBulkDialog } from './user-attribute-bulk-dialog';
import { UserAttributeConfirmationStore } from './user-attribute-confirmation';
import { UserAttributeEditFlow } from './user-attribute-edit-flow';
import { UserAttributeGridDraft } from './user-attribute-grid-draft';
import type { UserAttributeColumn } from './user-fields';

@Component({
  selector: 'app-user-attribute-bulk-dialog',
  template: '<p class="dialog-stub">{{ prepared()?.previewId }}</p>',
})
class BulkDialogStub {
  readonly selection = input<unknown>();
  readonly selected = input(0);
  readonly categories = input<unknown>();
  readonly categoriesLoading = input(false);
  readonly categoriesError = input('');
  readonly prepared = input<{ previewId: string } | null>(null);
  readonly confirmationScope = input<string | null>(null);
  readonly closed = output<void>();
  readonly accepted = output<string>();
  readonly categoriesRetry = output<void>();
}

@Component({
  selector: 'app-user-grid',
  template: '<p class="grid-stub">grid</p>',
})
class GridStub {
  readonly endEdit = vi.fn();
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
  readonly editable = input(false);
  readonly pendingIds = input<readonly string[] | null>(null);
  readonly loadPending = input<unknown>();
  readonly pendingRevision = input(0);
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
  selectedCount?: number;
  categories?: UserAttributeCategory[] | null;
  request?: ReturnType<typeof vi.fn>;
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
    categories: signal(options.categories ?? null),
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
      getSpec: vi.fn().mockResolvedValue({
        terms: [],
        added: 0,
        excluded: 0,
        selectedCount: 0,
        expiredAt: null,
      }),
      applyOps: vi.fn().mockResolvedValue(undefined),
      resolveSelected: vi.fn().mockResolvedValue({}),
    },
    selectionTab: '6f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10',
    selectionRevision: signal(0),
    refreshing: computed(() => sync()?.status === 'running'),
    refreshStatus: signal(''),
    refreshPending: signal(false),
    selectedCount: computed(() => options.selectedCount ?? 0),
    init: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn(),
    rowRefresh: {
      attach: vi.fn(),
      detach: vi.fn(),
      onApply: vi.fn(() => () => undefined),
    },
    freshness: signal(options.freshness ?? null),
    jobFailure: signal(null),
    jobSettlements: signal({ revision: 0, failed: false }),
    readRowsByIds: vi.fn().mockResolvedValue([]),
    refreshHeldRows: vi.fn().mockResolvedValue(undefined),
    refreshHeldRowsOnScreen: vi.fn().mockResolvedValue(undefined),
    refreshAll: vi.fn().mockResolvedValue(undefined),
    refreshSelection: vi.fn().mockResolvedValue(undefined),
    refreshDomain: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    setPredicates: vi.fn((next: UserPredicate[]) => predicates.set(next)),
    clearFilters: vi.fn(() => {
      predicates.set([]);
      emptyFilter.set(false);
    }),
    rows: vi.fn().mockResolvedValue({
      rows: [],
      matching: 0,
      total: 0,
      observedAt: '2026-11-16T12:00:00.000Z',
      refreshJobId: null,
    }),
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
          request: options.request ?? vi.fn(),
          interrupted: () => false,
        },
      },
    ],
  });
  TestBed.overrideComponent(UsersPage, {
    remove: { imports: [UserAttributeBulkDialog] },
    add: { imports: [BulkDialogStub] },
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

  it('shows Bulk Actions and its hint for an operator with both grants (K27)', () => {
    setup({
      sync: ready(),
      page: { matching: 25, total: 25, observedAt: null },
      actions: ['users:read', 'users:write', 'users:bulk-actions'],
    });
    const fixture = render();
    const bulk = button(fixture, 'Bulk Actions') as HTMLButtonElement;
    expect(bulk).toBeTruthy();
    expect(bulk.disabled).toBe(true);
    expect(bulk.getAttribute('aria-describedby')).toBe('bulk-note');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('#bulk-note')
        ?.textContent,
    ).toContain('Select one or more users to set attributes.');
  });

  it('enables Bulk Actions with a selection and drops the hint (K27)', () => {
    setup({
      sync: ready(),
      page: { matching: 25, total: 25, observedAt: null },
      actions: ['users:read', 'users:write', 'users:bulk-actions'],
      selectedCount: 25,
    });
    const fixture = render();
    const bulk = button(fixture, 'Bulk Actions') as HTMLButtonElement;
    expect(bulk.disabled).toBe(false);
    expect(bulk.getAttribute('aria-describedby')).toBeNull();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('#bulk-note'),
    ).toBeNull();
  });

  it('hides Bulk Actions without users:bulk-actions (B section 11)', () => {
    setup({
      sync: ready(),
      page: { matching: 25, total: 25, observedAt: null },
      actions: ['users:read', 'users:write'],
      selectedCount: 25,
    });
    const fixture = render();
    expect(button(fixture, 'Bulk Actions')).toBeUndefined();
    expect(text(fixture)).not.toContain('Set attributes');
  });

  it('hides Bulk Actions without users:write (B section 11)', () => {
    setup({
      sync: ready(),
      page: { matching: 25, total: 25, observedAt: null },
      actions: ['users:read', 'users:bulk-actions'],
      selectedCount: 25,
    });
    const fixture = render();
    expect(button(fixture, 'Bulk Actions')).toBeUndefined();
    expect(text(fixture)).not.toContain('Set attributes');
  });
});

const previewId = '11111111-1111-4111-8111-111111111111';
const manifestDigest = 'a'.repeat(64);

function previewAnswer(extra: Record<string, unknown> = {}) {
  return {
    previewId,
    source: 'edit-list',
    changes: null,
    attributeChanges: 1,
    selected: 1,
    eligible: 1,
    unchanged: 0,
    conflicts: 0,
    oldestObservedAt: '2026-11-16T12:00:00.000Z',
    stale: false,
    preparedAt: '2026-11-16T12:00:00.000Z',
    expiresAt: '2026-11-16T12:10:00.000Z',
    manifestDigest,
    ...extra,
  };
}

const receiptAnswer = {
  jobId: '22222222-2222-4222-8222-222222222222',
  displayId: 'UAT-014',
  status: 'accepted',
  userCount: 1,
  changeCount: 1,
};

/** The routes of one save. The first match answers. */
function routes(
  table: Record<string, () => Response>,
): ReturnType<typeof vi.fn> {
  return vi.fn((path: string) => {
    const route = Object.keys(table)
      .sort((left, right) => right.length - left.length)
      .find((candidate) => path.startsWith(candidate));
    return Promise.resolve(
      route
        ? table[route]!()
        : Response.json({ code: 'not-found' }, { status: 404 }),
    );
  });
}

function attributeField(
  overrides: Partial<UserAttributeField> = {},
): UserAttributeField {
  return {
    fieldId: 'Student.grade_level',
    fieldName: 'grade_level',
    displayName: 'Grade level',
    fieldType: 'INT64',
    multiValued: false,
    indexed: true,
    readAccessType: 'ADMINS_AND_SELF',
    numericIndexingSpec: { minValue: 0, maxValue: 12 },
    holders: 0,
    ...overrides,
  };
}

function attributeColumn(
  overrides: Partial<UserAttributeColumn> = {},
): UserAttributeColumn {
  const attribute = attributeField(overrides.field);
  return {
    id: `attr:Student.${attribute.fieldName}`,
    schemaName: 'Student',
    fieldName: attribute.fieldName,
    schemaDisplayName: 'Student information',
    field: attribute,
    label: attribute.displayName,
    ...overrides,
  };
}

function userRow(extra: Partial<UserRow> = {}): UserRow {
  return {
    userId: '1100000000000000001',
    primaryEmail: 'amara.okafor@example.org',
    orgUnitPath: '/Students/High School',
    givenName: 'Amara',
    familyName: 'Okafor',
    fullName: 'Amara Okafor',
    suspended: false,
    suspensionReason: null,
    archived: false,
    lastLoginTime: null,
    creationTime: '2026-09-01T00:00:00.000Z',
    twoStepEnrolled: true,
    department: null,
    title: null,
    aliases: [],
    customSchemas: { Student: { grade_level: 9 } },
    lastEntitySync: '2026-11-16T12:00:00.000Z',
    stale: false,
    recordVersion: 1,
    ...extra,
  };
}

/** Seed two pending cells of the grid draft. */
function stageTwo(draft: UserAttributeGridDraft) {
  const column = attributeColumn();
  draft.stageText(userRow(), column, '11');
  draft.stageText(
    userRow({
      userId: '1100000000000000002',
      fullName: 'Aaron Whitfield',
      primaryEmail: 'aaron.whitfield@example.org',
      customSchemas: { Student: { grade_level: 7 } },
    }),
    column,
    '10',
  );
}

async function settle(fixture: ReturnType<typeof render>): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }
}

/** Let the job of one hidden receipt answer at once, without its one-second poll. */
function jobSettles(status = 'completed') {
  const flow = TestBed.inject(UserAttributeEditFlow);
  return vi
    .spyOn(flow, 'waitForJob')
    .mockResolvedValue({ ok: true, value: { status } as never });
}

describe('the in-grid attribute draft (design K26)', () => {
  beforeEach(() => sessionStorage.clear());

  function page(options: Parameters<typeof setup>[0]) {
    const store = setup({ ...options, actions: ['users:read', 'users:write'] });
    const draft = TestBed.inject(UserAttributeGridDraft);
    return { store, draft };
  }

  it('shows the ruling 14 count line and its three actions', () => {
    const { draft } = page({ sync: ready() });
    stageTwo(draft);
    const fixture = render();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.draft-count')?.textContent?.trim()).toBe(
      '2 pending changes · 2 users',
    );
    expect(button(fixture, 'Show pending changes')).toBeDefined();
    expect(button(fixture, 'Revert all changes')).toBeDefined();
    expect(button(fixture, 'Save changes')).toBeDefined();
  });

  it('keeps Save changes disabled while a conflict cell waits', () => {
    const { draft } = page({ sync: ready() });
    const column = attributeColumn();
    stageTwo(draft);
    draft.markConflict('1100000000000000001', column.id, 10);
    const fixture = render();
    const save = button(fixture, 'Save changes') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(text(fixture)).toContain('changed in Google');
  });

  it('shows no bar and no editors without users:write', () => {
    const store = setup({
      sync: ready(),
      actions: ['users:read'],
    });
    const draft = TestBed.inject(UserAttributeGridDraft);
    stageTwo(draft);
    const fixture = render();
    // A restored draft stays visible, and only Revert all clears it.
    expect(text(fixture)).toContain('2 pending changes · 2 users');
    const save = button(fixture, 'Save changes') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(store).toBeDefined();
  });

  it('saves one pending change in one step', async () => {
    const request = routes({
      '/api/users/attribute-previews': () => Response.json(previewAnswer()),
      [`/api/users/attribute-previews/${previewId}/confirm`]: () =>
        Response.json(receiptAnswer),
    });
    const { draft, store } = page({ sync: ready(), request });
    const job = jobSettles();
    draft.stageText(userRow(), attributeColumn(), '11');
    const fixture = render();
    const save = button(fixture, 'Save changes') as HTMLButtonElement;
    expect({ disabled: save.disabled, text: save.textContent?.trim() }).toEqual(
      {
        disabled: false,
        text: 'Save changes',
      },
    );
    save.click();
    await settle(fixture);
    expect(job).toHaveBeenCalled();
    expect(draft.entries()).toEqual([]);
    expect(store.refreshHeldRows).toHaveBeenCalledWith(['1100000000000000001']);
    // One change confirms without the Set attributes dialog.
    expect(fixture.nativeElement.querySelector('.dialog-stub')).toBeNull();
  });

  it('opens the Set attributes dialog at Review for two changes', async () => {
    const request = routes({
      '/api/users/attribute-previews': () =>
        Response.json(
          previewAnswer({
            attributeChanges: 2,
            selected: 2,
            eligible: 2,
          }),
        ),
      [`/api/users/attribute-previews/${previewId}/targets`]: () =>
        Response.json({
          targets: [],
          nextCursor: null,
        }),
    });
    const { draft } = page({ sync: ready(), request });
    stageTwo(draft);
    const fixture = render();
    button(fixture, 'Save changes')!.click();
    await settle(fixture);
    const dialog = fixture.nativeElement.querySelector('.dialog-stub');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain(previewId);
    // The draft stays until the dialog confirms the job.
    expect(draft.counts().changes).toBe(2);
  });

  it('keeps the draft when the preview answers 413', async () => {
    const request = routes({
      '/api/users/attribute-previews': () =>
        Response.json({ code: 'payload-too-large' }, { status: 413 }),
    });
    const { draft } = page({ sync: ready(), request });
    stageTwo(draft);
    const fixture = render();
    button(fixture, 'Save changes')!.click();
    await settle(fixture);
    expect(draft.counts().changes).toBe(2);
    expect(
      fixture.nativeElement.querySelector('.draft-line')?.textContent,
    ).toContain('The request exceeds the size limit.');
  });

  it('keeps the draft when the confirmation answers 503', async () => {
    const request = routes({
      '/api/users/attribute-previews': () => Response.json(previewAnswer()),
      [`/api/users/attribute-previews/${previewId}/confirm`]: () =>
        Response.json({ reason: 'unavailable' }, { status: 503 }),
    });
    const { draft } = page({ sync: ready(), request });
    draft.stageText(userRow(), attributeColumn(), '11');
    const fixture = render();
    const save = button(fixture, 'Save changes') as HTMLButtonElement;
    expect({ disabled: save.disabled, text: save.textContent?.trim() }).toEqual(
      {
        disabled: false,
        text: 'Save changes',
      },
    );
    save.click();
    await settle(fixture);
    expect(draft.counts().changes).toBe(1);
    expect(fixture.nativeElement.querySelector('.draft-line')).not.toBeNull();
  });

  it('replays the same preview when a confirmation answer is uncertain (R1-B)', async () => {
    const request = routes({
      '/api/users/attribute-previews': () => Response.json(previewAnswer()),
      [`/api/users/attribute-previews/${previewId}/confirm`]: () =>
        Response.json({ reason: 'unavailable' }, { status: 503 }),
    });
    const { draft } = page({ sync: ready(), request });
    draft.stageText(userRow(), attributeColumn(), '11');
    const fixture = render();
    button(fixture, 'Save changes')!.click();
    await settle(fixture);
    // The second Save replays the frozen preview instead of preparing another one.
    button(fixture, 'Save changes')!.click();
    await settle(fixture);
    const paths = request.mock.calls.map(([path]) => path);
    expect(
      paths.filter((path) => path === '/api/users/attribute-previews'),
    ).toHaveLength(1);
    expect(
      paths.filter(
        (path) => path === `/api/users/attribute-previews/${previewId}/confirm`,
      ),
    ).toHaveLength(2);
    expect(draft.counts().changes).toBe(1);
  });

  it('keeps the draft when the target read is refused (R1-J)', async () => {
    const request = routes({
      '/api/users/attribute-previews': () =>
        Response.json(
          previewAnswer({
            attributeChanges: 2,
            selected: 2,
            eligible: 2,
          }),
        ),
      [`/api/users/attribute-previews/${previewId}/targets`]: () =>
        Response.json({ reason: 'unavailable' }, { status: 503 }),
    });
    const { draft } = page({ sync: ready(), request });
    stageTwo(draft);
    const fixture = render();
    button(fixture, 'Save changes')!.click();
    await settle(fixture);
    expect(draft.counts().changes).toBe(2);
    expect(
      fixture.nativeElement.querySelector('.draft-line')?.textContent,
    ).toContain('refused the save');
    expect(fixture.nativeElement.querySelector('.dialog-stub')).toBeNull();
  });

  it('keeps the accepted receipt while its job does not answer (R1-C)', async () => {
    const request = routes({
      '/api/users/attribute-previews': () => Response.json(previewAnswer()),
      [`/api/users/attribute-previews/${previewId}/confirm`]: () =>
        Response.json(receiptAnswer),
    });
    const { draft, store } = page({ sync: ready(), request });
    const flow = TestBed.inject(UserAttributeEditFlow);
    vi.spyOn(flow, 'waitForJob').mockResolvedValue({
      ok: false,
      message: 'The job is still running.',
    });
    draft.stageText(userRow(), attributeColumn(), '11');
    const fixture = render();
    button(fixture, 'Save changes')!.click();
    await settle(fixture);
    expect(store.refreshHeldRows).not.toHaveBeenCalled();
    const receipt = TestBed.inject(UserAttributeConfirmationStore).pending(
      `grid:${store.selectionTab}`,
    );
    expect(receipt?.phase).toBe('accepted');
    expect(receipt?.displayId).toBe('UAT-014');
  });
});
