import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import type { UserAttributeCategory } from '@campus/application-contracts';
import { UserCategoryDialog } from './user-category-dialog';

const category: UserAttributeCategory = {
  schemaId: 'schema-staff',
  schemaName: 'staff',
  displayName: 'Staff information',
  etag: '"etag"',
  fields: [
    {
      fieldId: 'field-role',
      fieldName: 'role',
      displayName: 'Role',
      fieldType: 'STRING',
      multiValued: false,
      indexed: true,
      readAccessType: 'ADMINS_AND_SELF',
      numericIndexingSpec: null,
      holders: 400,
    },
    {
      fieldId: 'field-level',
      fieldName: 'level',
      displayName: 'Level',
      fieldType: 'INT64',
      multiValued: true,
      indexed: false,
      readAccessType: 'ALL_DOMAIN_USERS',
      numericIndexingSpec: { minValue: 1, maxValue: 9 },
      holders: 12,
    },
  ],
  holders: 412,
  readAt: '2026-11-16T12:00:00.000Z',
};

function render() {
  const fixture = TestBed.createComponent(UserCategoryDialog);
  fixture.componentRef.setInput('category', category);
  fixture.detectChanges();
  return fixture;
}

const element = (fixture: ReturnType<typeof render>) =>
  fixture.nativeElement as HTMLElement;

describe('the read-only category dialog (CA state 09)', () => {
  it('draws the display name and the category name as plain values', () => {
    const fixture = render();
    expect(
      element(fixture)
        .querySelector('#category-dialog-title')
        ?.textContent?.trim(),
    ).toBe('Staff information');
    const labels = [
      ...element(fixture).querySelectorAll('.category-fields .static-label'),
    ].map((label) => label.textContent?.trim());
    expect(labels).toEqual(['Display name', 'Category name']);
    expect(
      element(fixture).querySelector('.identifier')?.textContent?.trim(),
    ).toBe('staff');
    expect(element(fixture).querySelectorAll('input').length).toBeGreaterThan(
      0,
    );
  });

  it('draws every attribute with its info type and visibility', () => {
    const fixture = render();
    const rows = [
      ...element(fixture).querySelectorAll('tbody tr:not(.range-line)'),
    ] as HTMLElement[];
    expect(rows.map((row) => row.textContent?.replace(/\s+/g, ''))).toEqual([
      'RoleroleTextAdminsandtheuser',
      'LevellevelWholenumberEveryoneintheorganization',
    ]);
    expect(element(fixture).querySelectorAll('tbody mat-checkbox').length).toBe(
      4,
    );
    const checked = [
      ...element(fixture).querySelectorAll('tbody input[type="checkbox"]'),
    ].map((input) => (input as HTMLInputElement).checked);
    expect(checked).toEqual([false, true, true, false]);
    const disabled = [
      ...element(fixture).querySelectorAll('tbody input[type="checkbox"]'),
    ].map((input) => (input as HTMLInputElement).disabled);
    expect(disabled).toEqual([true, true, true, true]);
  });

  it('shows a saved range as plain text under its number row (K19)', () => {
    const fixture = render();
    const line = element(fixture).querySelector('tbody tr.range-line');
    expect(line).not.toBeNull();
    const cells = [...(line as HTMLElement).querySelectorAll('td')];
    expect(
      cells.map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual(['', 'Minimum1', 'Maximum9', '', '', '', '']);
    // The line sits directly under the Whole number row.
    const rows = [...element(fixture).querySelectorAll('tbody tr')];
    const index = rows.indexOf(line as HTMLTableRowElement);
    expect(rows[index - 1].textContent).toContain('Level');
  });

  it('draws no category action and keeps Add attribute disabled (composition choice 12)', () => {
    const fixture = render();
    const labels = [...element(fixture).querySelectorAll('button')].map(
      (button) => button.textContent?.trim(),
    );
    expect(labels).not.toContain('Delete category');
    expect(labels).not.toContain('Create category');
    const add = [...element(fixture).querySelectorAll('button')].find(
      (button) => button.textContent?.includes('Add attribute'),
    ) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(element(fixture).textContent).toContain(
      'Requires the User Schema Manage permission.',
    );
  });

  it('opens the sourced help in the title row (composition choice 15)', () => {
    const fixture = render();
    const help = element(fixture).querySelector(
      'button[aria-label="Custom attributes help"]',
    ) as HTMLButtonElement;
    expect(help).not.toBeNull();
    expect(help.getAttribute('aria-controls')).toBe('attribute-help-dialog');
    expect(help.getAttribute('aria-expanded')).toBe('false');
    help.click();
    fixture.detectChanges();
    expect(help.getAttribute('aria-expanded')).toBe('true');
    const pane = element(fixture).querySelector('#attribute-help-dialog');
    expect(pane?.textContent).toContain('Custom attributes');
    expect(pane?.textContent).toContain('100 categories and 100 attributes');
  });

  it('keeps the approved trailing gutter of the attribute table (R5)', () => {
    const fixture = render();
    const headers = [
      ...element(fixture).querySelectorAll('thead th'),
    ] as HTMLElement[];
    expect(headers.length).toBe(7);
    expect(headers[6].textContent?.trim()).toBe('');
    expect(headers[6].classList.contains('gutter')).toBe(true);
    const cells = [
      ...element(fixture).querySelectorAll('tbody tr:first-child td'),
    ] as HTMLElement[];
    expect(cells.length).toBe(7);
    expect(cells[6].classList.contains('gutter')).toBe(true);
  });

  it('closes on Escape and on Close', () => {
    const fixture = render();
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    element(fixture)
      .querySelector('[role="dialog"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closed).toHaveBeenCalledTimes(1);
    const close = [...element(fixture).querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Close',
    ) as HTMLButtonElement;
    close.click();
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it('closes on a click beside the dialog', () => {
    const fixture = render();
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    (element(fixture).querySelector('.picker-scrim') as HTMLElement).click();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('marks the title as the initial focus and traps the tab key', () => {
    const fixture = render();
    const dialog = element(fixture).querySelector('[role="dialog"]');
    expect(dialog?.hasAttribute('cdktrapfocus')).toBe(true);
    expect(dialog?.querySelector('[cdkfocusinitial]')?.id).toBe(
      'category-dialog-title',
    );
  });
});
