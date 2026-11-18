import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import type { UserOrgUnit, UserPredicate } from '@campus/application-contracts';
import { UserFilter } from './user-filter';
import { dateInputToIso, type UserAttributeColumn } from './user-fields';

const grade: UserAttributeColumn = {
  id: 'Student.grade_level',
  schemaName: 'Student',
  fieldName: 'grade_level',
  schemaDisplayName: 'Student information',
  label: 'Grade level',
  field: {
    fieldId: 'Student.grade_level',
    fieldName: 'grade_level',
    displayName: 'Grade level',
    fieldType: 'INT64',
    multiValued: false,
    indexed: true,
    readAccessType: 'ALL_DOMAIN_USERS',
    numericIndexingSpec: { minValue: 0, maxValue: 13 },
    holders: 3,
  },
};

const units: UserOrgUnit[] = [
  { path: '/Students', users: 3 },
  { path: '/Students/High School', users: 2 },
  { path: '/Staff', users: 1 },
];

function setup(): ComponentFixture<UserFilter> {
  const fixture = TestBed.createComponent(UserFilter);
  fixture.componentRef.setInput('attributes', [grade]);
  fixture.componentRef.setInput('orgUnits', units);
  fixture.detectChanges();
  document.body.append(root(fixture));
  return fixture;
}

function root(fixture: ComponentFixture<UserFilter>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function entry(fixture: ComponentFixture<UserFilter>): HTMLInputElement {
  return root(fixture).querySelector(
    'input[role="combobox"]',
  ) as HTMLInputElement;
}

function type(fixture: ComponentFixture<UserFilter>, value: string): void {
  const input = entry(fixture);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

function press(
  fixture: ComponentFixture<UserFilter>,
  key: string,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, cancelable: true });
  entry(fixture).dispatchEvent(event);
  fixture.detectChanges();
  return event;
}

function button(
  fixture: ComponentFixture<UserFilter>,
  label: string,
): HTMLButtonElement {
  const found = Array.from(root(fixture).querySelectorAll('button')).find(
    (item) => item.textContent?.includes(label),
  );
  if (!found) throw new Error(`No button ${label}`);
  return found as HTMLButtonElement;
}

async function settle(fixture: ComponentFixture<UserFilter>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('UserFilter', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens the number range editor from a keyboard-chosen field', async () => {
    const fixture = setup();
    const applied = vi.fn();
    fixture.componentInstance.applied.subscribe(applied);
    button(fixture, 'Add a filter').click();
    await settle(fixture);
    type(fixture, 'grade');
    expect(root(fixture).textContent).toContain('Grade level');
    press(fixture, 'Enter');
    await settle(fixture);
    const dialog = root(fixture).querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error('No dialog');
    const inputs = dialog.querySelectorAll<HTMLInputElement>(
      'input[inputmode="numeric"]',
    );
    inputs[0].value = '9';
    inputs[0].dispatchEvent(new Event('input'));
    inputs[1].value = '12';
    inputs[1].dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button(fixture, 'Apply').click();
    expect(applied).toHaveBeenCalledWith({
      field: 'attribute',
      schemaName: 'Student',
      fieldName: 'grade_level',
      operator: 'numberRange',
      from: 9,
      to: 12,
    } satisfies UserPredicate);
  });

  it('closes the suggestion list on Escape and returns focus to the trigger', async () => {
    const fixture = setup();
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    button(fixture, 'Add a filter').click();
    await settle(fixture);
    expect(document.activeElement).toBe(entry(fixture));
    const event = press(fixture, 'Escape');
    await settle(fixture);
    expect(event.defaultPrevented).toBe(true);
    expect(closed).toHaveBeenCalled();
    expect(root(fixture).querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(button(fixture, 'Add a filter'));
  });

  it('applies a status choice from the shortcut list', async () => {
    const fixture = setup();
    const applied = vi.fn();
    fixture.componentInstance.applied.subscribe(applied);
    button(fixture, 'Add a filter').click();
    await settle(fixture);
    type(fixture, 'status');
    press(fixture, 'Enter');
    await settle(fixture);
    expect(button(fixture, 'Apply').disabled).toBe(true);
    const suspended = Array.from(
      root(fixture).querySelectorAll<HTMLLabelElement>('label'),
    ).find((label) => label.textContent?.includes('Suspended'));
    const check = suspended?.querySelector<HTMLInputElement>('input');
    if (!check) throw new Error('No Suspended option');
    check.checked = true;
    check.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    button(fixture, 'Apply').click();
    expect(applied).toHaveBeenCalledWith({
      field: 'status',
      operator: 'is',
      values: ['suspended'],
    } satisfies UserPredicate);
  });

  it('includes the units inside a chosen organization unit', async () => {
    const fixture = setup();
    const applied = vi.fn();
    fixture.componentInstance.applied.subscribe(applied);
    button(fixture, 'Add a filter').click();
    await settle(fixture);
    type(fixture, 'organization');
    press(fixture, 'Enter');
    await settle(fixture);
    const students = Array.from(
      root(fixture).querySelectorAll<HTMLLabelElement>('label'),
    ).find((label) => label.textContent?.trim() === 'Students');
    const check = students?.querySelector<HTMLInputElement>('input');
    if (!check) throw new Error('No Students option');
    check.checked = true;
    check.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    button(fixture, 'Apply').click();
    const predicate = applied.mock.calls[0][0] as UserPredicate;
    expect(predicate).toMatchObject({
      field: 'orgUnitPath',
      operator: 'in',
    });
    expect('values' in predicate && predicate.values).toEqual([
      '/Students',
      '/Students/High School',
    ]);
  });

  it('chooses a shortcut with the arrow keys and applies it', async () => {
    const fixture = setup();
    const applied = vi.fn();
    fixture.componentInstance.applied.subscribe(applied);
    button(fixture, 'Add a filter').click();
    await settle(fixture);
    type(fixture, 'aaliyah');
    press(fixture, 'ArrowDown');
    press(fixture, 'Enter');
    await settle(fixture);
    const dialog = root(fixture).querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error('No dialog');
    expect(dialog.textContent).toContain('Primary email');
    const value = dialog.querySelector<HTMLInputElement>('input[type="text"]');
    expect(value?.value).toBe('aaliyah');
    button(fixture, 'Apply').click();
    expect(applied).toHaveBeenCalledWith({
      field: 'primaryEmail',
      operator: 'contains',
      value: 'aaliyah',
    } satisfies UserPredicate);
  });

  it('prefills a chip edit and closes without applying on Cancel', async () => {
    const fixture = TestBed.createComponent(UserFilter);
    const applied = vi.fn();
    const closed = vi.fn();
    fixture.componentInstance.applied.subscribe(applied);
    fixture.componentInstance.closed.subscribe(closed);
    fixture.componentRef.setInput('attributes', [grade]);
    fixture.componentRef.setInput('editing', {
      field: 'attribute',
      schemaName: 'Student',
      fieldName: 'grade_level',
      operator: 'numberRange',
      from: 9,
      to: 12,
    } satisfies UserPredicate);
    fixture.detectChanges();
    document.body.append(root(fixture));
    await settle(fixture);
    const inputs = root(fixture).querySelectorAll<HTMLInputElement>(
      'input[inputmode="numeric"]',
    );
    expect(inputs[0].value).toBe('9');
    expect(inputs[1].value).toBe('12');
    button(fixture, 'Cancel').click();
    expect(applied).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalled();
  });

  it('reopens a text chip with its own operator (R5)', async () => {
    const fixture = TestBed.createComponent(UserFilter);
    const applied = vi.fn();
    fixture.componentInstance.applied.subscribe(applied);
    fixture.componentRef.setInput('attributes', [grade]);
    fixture.componentRef.setInput('editing', {
      field: 'fullName',
      operator: 'equals',
      value: 'Aaliyah Brooks',
    } satisfies UserPredicate);
    fixture.detectChanges();
    document.body.append(root(fixture));
    await settle(fixture);
    const operator = root(fixture).querySelector<HTMLSelectElement>('select');
    expect(operator?.value).toBe('equals');
    button(fixture, 'Apply').click();
    expect(applied).toHaveBeenCalledWith({
      field: 'fullName',
      operator: 'equals',
      value: 'Aaliyah Brooks',
    } satisfies UserPredicate);
  });

  it('reopens a date chip with On or after (R5)', async () => {
    const fixture = TestBed.createComponent(UserFilter);
    const applied = vi.fn();
    fixture.componentInstance.applied.subscribe(applied);
    fixture.componentRef.setInput('attributes', [grade]);
    fixture.componentRef.setInput('editing', {
      field: 'lastLoginTime',
      operator: 'after',
      value: dateInputToIso('2026-10-31') as string,
    } satisfies UserPredicate);
    fixture.detectChanges();
    document.body.append(root(fixture));
    await settle(fixture);
    expect(
      root(fixture).querySelector<HTMLSelectElement>('select')?.value,
    ).toBe('after');
    expect(
      root(fixture).querySelector<HTMLInputElement>('input[type="date"]')
        ?.value,
    ).toBe('2026-10-31');
    button(fixture, 'Apply').click();
    expect(applied).toHaveBeenCalledWith({
      field: 'lastLoginTime',
      operator: 'after',
      value: dateInputToIso('2026-10-31') ?? '',
    } satisfies UserPredicate);
  });

  it('reopens an empty-value chip as Is empty (R5)', async () => {
    const fixture = TestBed.createComponent(UserFilter);
    const applied = vi.fn();
    fixture.componentInstance.applied.subscribe(applied);
    fixture.componentRef.setInput('attributes', [grade]);
    fixture.componentRef.setInput('editing', {
      field: 'department',
      operator: 'isEmpty',
    } satisfies UserPredicate);
    fixture.detectChanges();
    document.body.append(root(fixture));
    await settle(fixture);
    expect(
      root(fixture).querySelector<HTMLSelectElement>('select')?.value,
    ).toBe('isEmpty');
    expect(
      root(fixture).querySelector<HTMLInputElement>('input[type="text"]'),
    ).toBeNull();
    button(fixture, 'Apply').click();
    expect(applied).toHaveBeenCalledWith({
      field: 'department',
      operator: 'isEmpty',
    } satisfies UserPredicate);
  });
});
