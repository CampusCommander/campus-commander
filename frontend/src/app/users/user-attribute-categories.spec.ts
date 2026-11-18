import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import {
  GOOGLE_CAPABILITIES,
  type UserAttributeCategories,
  type UserAttributeCategory,
} from '@campus/application-contracts';
import { UserAttributeCategories as UserAttributeCategoriesTab } from './user-attribute-categories';
import { UsersStore } from './users.store';

const scope =
  GOOGLE_CAPABILITIES.find((capability) => capability.id === 'user-schemas')
    ?.scope ?? '';

function category(
  displayName: string,
  schemaName: string,
  fields: number,
  holders: number,
): UserAttributeCategory {
  return {
    schemaId: `schema-${schemaName}`,
    schemaName,
    displayName,
    etag: '"etag"',
    fields: Array.from({ length: fields }, (_, index) => ({
      fieldId: `field-${schemaName}-${index}`,
      fieldName: `field_${index}`,
      displayName: `Field ${index}`,
      fieldType: index % 2 === 0 ? 'STRING' : 'INT64',
      multiValued: index % 2 === 0,
      indexed: true,
      readAccessType: 'ADMINS_AND_SELF',
      numericIndexingSpec: null,
      holders: 3,
    })),
    holders,
    readAt: '2026-11-16T12:00:00.000Z',
  };
}

const three: UserAttributeCategories = {
  categories: [
    category('Staff information', 'staff', 2, 400),
    category('Device program', 'device', 1, 12),
    category('Student information', 'student', 5, 1200),
  ],
  limits: {
    categories: 3,
    categoryLimit: 100,
    attributes: 8,
    attributeLimit: 100,
  },
  observedAt: '2026-11-16T12:00:00.000Z',
};

function setup(state: {
  categories?: UserAttributeCategories | null;
  failure?: { status: number | undefined; failure: string | undefined } | null;
  recovery?: boolean;
  refreshing?: boolean;
}) {
  const store = {
    categories: signal(state.categories ?? null),
    categoriesLoading: signal(false),
    categoriesRefreshing: signal(state.refreshing ?? false),
    categoriesFailure: signal(state.failure ?? null),
    categoriesRecovery: signal(state.recovery ?? false),
    loadCategories: vi.fn().mockResolvedValue(undefined),
    refreshCategories: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: UsersStore, useValue: store }],
  });
  return store;
}

function render() {
  const fixture = TestBed.createComponent(UserAttributeCategoriesTab);
  fixture.detectChanges();
  return fixture;
}

const element = (fixture: ReturnType<typeof render>) =>
  fixture.nativeElement as HTMLElement;

describe('the Custom attributes tab', () => {
  it('reads the categories when the tab opens (B section 9)', () => {
    const store = setup({ categories: three });
    render();
    expect(store.loadCategories).toHaveBeenCalledTimes(1);
  });

  it('shows the loading line before the category read answers', () => {
    setup({});
    const fixture = render();
    expect(element(fixture).textContent).toContain(
      'Loading custom attributes…',
    );
    expect(element(fixture).querySelector('table')).toBeNull();
  });

  it('lists the categories by display name with the limit counts (CA state 01)', () => {
    setup({ categories: three });
    const fixture = render();
    const rows = [
      ...element(fixture).querySelectorAll('tbody tr'),
    ] as HTMLElement[];
    expect(
      rows.map((row) =>
        [...row.querySelectorAll('td')].map((cell) =>
          cell.textContent?.replace(/\s+/g, ' ').trim(),
        ),
      ),
    ).toEqual([
      ['Device program', 'device', '1', '12'],
      ['Staff information', 'staff', '2', '400'],
      ['Student information', 'student', '5', '1,200'],
    ]);
    expect(element(fixture).textContent).toContain(
      '3 of 100 categories used · 8 of 100 attributes used',
    );
    const headers = [...element(fixture).querySelectorAll('thead th')].map(
      (header) => header.textContent?.replace('arrow_upward', '').trim(),
    );
    expect(headers).toEqual([
      'Category',
      'Category name',
      'Attributes',
      'Users with values',
    ]);
  });

  it('draws no Last changed column (default 2)', () => {
    setup({ categories: three });
    const fixture = render();
    expect(element(fixture).textContent).not.toContain('Last changed');
  });

  it('draws no Create category control before K18 lands (interim)', () => {
    setup({ categories: three });
    const fixture = render();
    const labels = [...element(fixture).querySelectorAll('button')].map(
      (button) => button.textContent?.trim(),
    );
    expect(labels).not.toContain('Create category');
  });

  it('names the empty state of a domain without a category (CA state 11)', () => {
    setup({
      categories: {
        categories: [],
        limits: {
          categories: 0,
          categoryLimit: 100,
          attributes: 0,
          attributeLimit: 100,
        },
        observedAt: null,
      },
    });
    const fixture = render();
    expect(element(fixture).textContent).toContain('No categories yet');
    expect(element(fixture).textContent).toContain(
      'Google Workspace holds no custom attribute categories for this domain.',
    );
    expect(element(fixture).textContent).toContain(
      '0 of 100 categories used · 0 of 100 attributes used',
    );
    expect(element(fixture).querySelector('button')?.textContent?.trim()).toBe(
      'Refresh',
    );
  });

  it('names the missing scope and offers the refresh (UI-05)', () => {
    setup({
      failure: { status: 503, failure: 'delegation-not-authorized' },
      recovery: true,
    });
    const fixture = render();
    expect(element(fixture).textContent).toContain(
      'Custom attribute categories are unavailable',
    );
    expect(element(fixture).textContent).toContain(scope);
    expect(
      element(fixture).querySelector('a[href="/google-connection"]'),
    ).not.toBeNull();
    expect(element(fixture).textContent).not.toContain(
      'Loading custom attributes…',
    );
  });

  it('names the Google connection when the customer is not connected (409)', () => {
    setup({ failure: { status: 409, failure: undefined }, recovery: true });
    const fixture = render();
    expect(element(fixture).textContent).toContain(
      'Custom attribute categories need a Google Workspace connection.',
    );
    expect(element(fixture).textContent).toContain('Refresh');
  });

  it('reads Google again on Refresh (B section 9)', () => {
    const store = setup({ categories: three });
    const fixture = render();
    const refresh = [...element(fixture).querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Refresh',
    );
    refresh?.click();
    expect(store.refreshCategories).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached list when a refresh fails (UI-08)', () => {
    setup({
      categories: three,
      failure: { status: 503, failure: 'backend-error' },
    });
    const fixture = render();
    expect(element(fixture).querySelectorAll('tbody tr').length).toBe(3);
    expect(
      element(fixture).querySelector('[role="alert"]')?.textContent,
    ).toContain('Custom attribute categories are unavailable');
  });

  it('shows Refreshing… and holds the action while the read runs (UI-08)', () => {
    setup({ categories: three, refreshing: true });
    const fixture = render();
    const refresh = element(fixture).querySelector(
      'button.mat-mdc-outlined-button',
    ) as HTMLButtonElement;
    expect(refresh.textContent?.trim()).toBe('Refreshing…');
    expect(refresh.disabled).toBe(true);
  });

  it('keeps a long category name whole in its title and its label', () => {
    const longName = `Transportation and after school program ${'x'.repeat(40)}`;
    setup({
      categories: {
        ...three,
        categories: [category(longName, 'transport', 1, 2)],
      },
    });
    const fixture = render();
    const link = element(fixture).querySelector('button.category-link');
    expect(link?.getAttribute('title')).toBe(longName);
    expect(link?.getAttribute('aria-label')).toBe(`Open category ${longName}`);
  });

  it('opens the sourced help from the toolbar (composition choice 15)', () => {
    setup({ categories: three });
    const fixture = render();
    const help = element(fixture).querySelector(
      'button[aria-label="Custom attributes help"]',
    ) as HTMLButtonElement;
    expect(help).not.toBeNull();
    expect(help.getAttribute('aria-controls')).toBe('attribute-help-page');
    expect(help.getAttribute('aria-expanded')).toBe('false');
    help.click();
    fixture.detectChanges();
    expect(help.getAttribute('aria-expanded')).toBe('true');
    const pane = element(fixture).querySelector('#attribute-help-page');
    expect(pane?.textContent).toContain('Google Workspace allows 100');
    expect(pane?.textContent).toContain(
      'A visibility change can take up to 24 hours in Google.',
    );
    help.click();
    fixture.detectChanges();
    expect(help.getAttribute('aria-expanded')).toBe('false');
    expect(element(fixture).querySelector('#attribute-help-page')).toBeNull();
  });

  it('opens the read-only dialog and returns focus to the link (UI-09)', async () => {
    setup({ categories: three });
    const fixture = render();
    const link = element(fixture).querySelector(
      'button[aria-label="Open category Device program"]',
    ) as HTMLButtonElement;
    link.click();
    fixture.detectChanges();
    const dialog = element(fixture).querySelector('app-user-category-dialog');
    expect(dialog).not.toBeNull();
    const close = dialog?.querySelector(
      '.dialog-actions button',
    ) as HTMLButtonElement;
    close.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(
      element(fixture).querySelector('app-user-category-dialog'),
    ).toBeNull();
    expect(document.activeElement).toBe(link);
  });
});
