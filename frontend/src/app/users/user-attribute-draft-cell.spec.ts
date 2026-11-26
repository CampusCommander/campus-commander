import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import type { IRowNode } from 'ag-grid-community';
import type { UserRow } from '@campus/application-contracts';
import { UserAttributeDraftCell } from './user-attribute-draft-cell';
import type { UserAttributeDraftCellParams } from './user-attribute-draft-cell';
import type { UserAttributeDraftEntry } from './user-attribute-grid-draft';

const row = (extra: Partial<UserRow> = {}): UserRow => ({
  userId: '110000000000000000001',
  primaryEmail: 'amara.okafor@example.org',
  orgUnitPath: '/Students/High School',
  givenName: 'Amara',
  familyName: 'Okafor',
  fullName: 'Amara Okafor',
  suspended: false,
  suspensionReason: null,
  archived: false,
  lastLoginTime: null,
  creationTime: null,
  twoStepEnrolled: false,
  department: null,
  title: null,
  aliases: [],
  customSchemas: {},
  lastEntitySync: '2026-11-16T12:00:00.000Z',
  stale: false,
  recordVersion: 1,
  ...extra,
});

const node = { rowIndex: 4, group: false } as unknown as IRowNode<UserRow>;

function entry(
  overrides: Partial<UserAttributeDraftEntry> = {},
): UserAttributeDraftEntry {
  return {
    userId: '110000000000000000001',
    userName: 'Amara Okafor',
    attribute: 'attr:Student.grade_level',
    label: 'Grade level',
    fieldType: 'INT64',
    multiValued: false,
    minValue: 0,
    maxValue: 12,
    value: '11',
    baseline: 9,
    state: 'pending',
    ...overrides,
  };
}

function params(
  draft: UserAttributeDraftEntry | null,
  options: { editable?: boolean; reason?: string; onRevert?: () => void } = {},
) {
  return {
    data: row(),
    node,
    value: draft ? String(draft.value) : '',
    api: {} as never,
    context: {},
    colDef: { colId: 'attr:Student.grade_level' },
    column: {} as never,
    eGridCell: document.createElement('div'),
    eParentOfValue: document.createElement('span'),
    refreshCell: () => undefined,
    setValue: () => undefined,
    formatValue: () => '',
    attribute: 'attr:Student.grade_level',
    label: 'Grade level',
    entryFor: () => draft,
    reasonFor: () => options.reason ?? '',
    editable: () => options.editable ?? true,
    onRevert: options.onRevert ?? (() => undefined),
  };
}

function render(
  draft: UserAttributeDraftEntry | null,
  options: { editable?: boolean; reason?: string; onRevert?: () => void } = {},
) {
  const fixture = TestBed.createComponent(UserAttributeDraftCell);
  fixture.componentInstance.agInit(
    params(draft, options) as unknown as UserAttributeDraftCellParams,
  );
  fixture.detectChanges();
  return fixture;
}

const spoken = (element: HTMLElement) =>
  element.querySelector('.visually-hidden')?.textContent?.trim() ?? '';

describe('the attribute draft cell', () => {
  it('shows the pending value over the row value', () => {
    const fixture = render(entry());
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.attribute-cell-value')?.textContent).toBe(
      '11',
    );
  });

  it('offers a rollback action with a spoken label for each cell', () => {
    const onRevert = vi.fn();
    const fixture = render(entry(), { onRevert });
    const element = fixture.nativeElement as HTMLElement;
    const action = element.querySelector<HTMLButtonElement>('.cell-action');
    expect(action).not.toBeNull();
    expect(action!.getAttribute('aria-label')).toContain(
      'Revert grade level of Amara Okafor',
    );
    expect(action!.getAttribute('title')).toContain('(Shift+Enter)');
    action!.click();
    expect(onRevert).toHaveBeenCalledTimes(1);
  });

  it('announces the field, the proposed value, and the baseline', () => {
    const fixture = render(entry());
    const element = fixture.nativeElement as HTMLElement;
    const text = spoken(element);
    // DRAFT-02: the cell announces the field, the proposed value, and the baseline.
    expect(text).toBe('Pending change to grade level. Baseline: 9.');
  });

  it('names the invalid state in text, not in color alone', () => {
    const fixture = render(
      entry({
        value: 'x'.repeat(501),
        state: 'invalid',
        fieldType: 'STRING',
        minValue: null,
        maxValue: null,
      }),
      { reason: 'A Text value holds at most 500 characters.' },
    );
    const element = fixture.nativeElement as HTMLElement;
    const mark = element.querySelector('.cell-state');
    expect(mark?.classList).toContain('error');
    expect(mark?.getAttribute('title')).toBe('501 of 500 characters');
    expect(spoken(element)).toContain('Invalid change to grade level');
    expect(spoken(element)).toContain('500');
  });

  it('names the conflict state with the Google value', () => {
    const fixture = render(entry({ state: 'conflict', currentValue: 10 }), {
      reason: 'The value changed in Google.',
    });
    const element = fixture.nativeElement as HTMLElement;
    const mark = element.querySelector('.cell-state');
    expect(mark?.classList).toContain('conflict');
    expect(spoken(element)).toBe('Conflict on grade level. Current value: 10.');
    expect(mark?.getAttribute('title')).toContain('changed in Google');
  });

  it('draws a resting cell without a rollback action', () => {
    const fixture = render(null);
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.cell-action')).toBeNull();
    expect(element.querySelector('.cell-state')).toBeNull();
    expect(element.querySelector('.edit-hint')).not.toBeNull();
  });

  it('hides the edit hint without users:write', () => {
    const fixture = render(null, { editable: false });
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.edit-hint')).toBeNull();
  });
});
