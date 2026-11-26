import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import type { UserAttributeField } from '@campus/application-contracts';
import { UserAttributeCellDialog } from './user-attribute-cell-dialog';

function field(extra: Partial<UserAttributeField> = {}): UserAttributeField {
  return {
    fieldId: 'Student.hire_date',
    fieldName: 'hire_date',
    displayName: 'Hire date',
    fieldType: 'DATE',
    multiValued: false,
    indexed: true,
    readAccessType: 'ADMINS_AND_SELF',
    numericIndexingSpec: null,
    holders: 2,
    ...extra,
  };
}

function render(options: {
  field: UserAttributeField;
  value: string | string[];
}) {
  const fixture = TestBed.createComponent(UserAttributeCellDialog);
  fixture.componentRef.setInput('field', options.field);
  fixture.componentRef.setInput('attribute', 'attr:Staff.hire_date');
  fixture.componentRef.setInput('label', options.field.displayName);
  fixture.componentRef.setInput('value', options.value);
  fixture.componentRef.setInput('userName', 'Dana Whitfield');
  fixture.detectChanges();
  return fixture;
}

const button = (element: HTMLElement, label: string) =>
  [...element.querySelectorAll('button')].find((target) =>
    target.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;

describe('the date cell dialog', () => {
  it('opens at the value that the cell shows and stages a new date', () => {
    const fixture = render({ field: field(), value: '2026-09-01' });
    const element = fixture.nativeElement as HTMLElement;
    const staged = vi.fn();
    fixture.componentInstance.staged.subscribe(staged);
    const input = element.querySelector<HTMLInputElement>('input[type="date"]');
    expect(input?.value).toBe('2026-09-01');
    input!.value = '2026-10-05';
    input!.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button(element, 'Stage')!.click();
    expect(staged).toHaveBeenCalledWith('2026-10-05');
  });

  it('cancels on Escape without a staged value', () => {
    const fixture = render({ field: field(), value: '' });
    const element = fixture.nativeElement as HTMLElement;
    const cancelled = vi.fn();
    const staged = vi.fn();
    fixture.componentInstance.cancelled.subscribe(cancelled);
    fixture.componentInstance.staged.subscribe(staged);
    element
      .querySelector('[role="dialog"]')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(staged).not.toHaveBeenCalled();
  });

  it('gives the dialog an accessible name and a focused field', () => {
    const fixture = render({ field: field(), value: '' });
    const element = fixture.nativeElement as HTMLElement;
    const dialog = element.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(
      element.querySelector('#attribute-cell-title')?.textContent,
    ).toContain('Hire date');
    expect(document.activeElement).toBe(
      element.querySelector('input[type="date"]'),
    );
  });
});

describe('the list cell dialog', () => {
  const programs = field({
    fieldId: 'Student.programs',
    fieldName: 'programs',
    displayName: 'Programs',
    fieldType: 'STRING',
    multiValued: true,
  });

  it('starts from the chip values of the cell and stages the edited list', () => {
    const fixture = render({ field: programs, value: ['Gifted', 'Band'] });
    const element = fixture.nativeElement as HTMLElement;
    const staged = vi.fn();
    fixture.componentInstance.staged.subscribe(staged);
    expect(element.textContent).toContain('Gifted');
    expect(element.textContent).toContain('Band');
    (
      fixture.componentInstance as unknown as {
        addChip: (event: never) => void;
      }
    ).addChip({ value: 'ESL', chipInput: { clear: () => undefined } } as never);
    fixture.detectChanges();
    button(element, 'Stage')!.click();
    expect(staged).toHaveBeenCalledWith(['Gifted', 'Band', 'ESL']);
  });

  it('keeps the code points of a chip and a repeated value (R1-H)', () => {
    const fixture = render({ field: programs, value: ['Gifted'] });
    const element = fixture.nativeElement as HTMLElement;
    const staged = vi.fn();
    fixture.componentInstance.staged.subscribe(staged);
    const add = (value: string) =>
      (
        fixture.componentInstance as unknown as {
          addChip: (event: never) => void;
        }
      ).addChip({
        value,
        chipInput: { clear: () => undefined },
      } as never);
    add(' Gifted');
    add('Gifted ');
    // A value of spaces alone is not a value.
    add('   ');
    fixture.detectChanges();
    button(element, 'Stage')!.click();
    expect(staged).toHaveBeenCalledWith(['Gifted', ' Gifted', 'Gifted ']);
  });

  it('clears the list as its own operation (R1-G)', () => {
    const fixture = render({ field: programs, value: ['Gifted'] });
    const element = fixture.nativeElement as HTMLElement;
    const staged = vi.fn();
    const cleared = vi.fn();
    fixture.componentInstance.staged.subscribe(staged);
    fixture.componentInstance.cleared.subscribe(cleared);
    button(element, 'Clear values')!.click();
    // Clear is not an empty list. A Yes or No field never treats No as empty (B section 12).
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(staged).not.toHaveBeenCalled();
  });

  it('removes one chip and keeps the rest', () => {
    const fixture = render({ field: programs, value: ['Gifted', 'Band'] });
    const element = fixture.nativeElement as HTMLElement;
    const staged = vi.fn();
    fixture.componentInstance.staged.subscribe(staged);
    (
      fixture.componentInstance as unknown as {
        removeChip: (index: number) => void;
      }
    ).removeChip(0);
    fixture.detectChanges();
    button(element, 'Stage')!.click();
    expect(staged).toHaveBeenCalledWith(['Band']);
  });

  it('refuses a value over 500 characters before staging (ruling 4)', () => {
    const fixture = render({ field: programs, value: ['Gifted'] });
    const element = fixture.nativeElement as HTMLElement;
    const staged = vi.fn();
    fixture.componentInstance.staged.subscribe(staged);
    (
      fixture.componentInstance as unknown as {
        addChip: (event: never) => void;
      }
    ).addChip({
      value: 'x'.repeat(501),
      chipInput: { clear: () => undefined },
    } as never);
    fixture.detectChanges();
    const stage = button(element, 'Stage');
    expect(stage?.disabled).toBe(true);
    expect(
      element.querySelector('#attribute-cell-error')?.textContent,
    ).toContain('500');
  });
});
