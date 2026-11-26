import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type {
  UserAttributeField,
  UserAttributeFieldType,
  UserRow,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import {
  UserAttributeGridDraft,
  attributeKeyParts,
  draftKey,
  rowCellText,
} from './user-attribute-grid-draft';
import { USER_ATTRIBUTE_DRAFT_STORAGE_PREFIX } from './user-attribute-draft-storage';
import type { UserAttributeColumn } from './user-fields';

const principal = '4f1c2f0e-4c1e-4b8e-9a51-2b7f0f6d8a10';
const storageKey = `${USER_ATTRIBUTE_DRAFT_STORAGE_PREFIX}${principal}`;

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

function row(overrides: Partial<UserRow> = {}): UserRow {
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
    customSchemas: {},
    lastEntitySync: '2026-11-01T12:00:00.000Z',
    stale: false,
    recordVersion: 1,
    ...overrides,
  };
}

/** One row of the Student category, with the values that a test needs. */
function student(values: UserRow['customSchemas'][string]): UserRow {
  return row({ customSchemas: { Student: values } });
}

function configure(id: string | null = principal) {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AuthStore,
        useValue: {
          session: signal(
            id === null
              ? null
              : {
                  identity: { id },
                  expiresAt: '2026-11-20T12:00:00.000Z',
                  csrfToken: 'a'.repeat(64),
                },
          ),
        },
      },
    ],
  });
  return TestBed.inject(UserAttributeGridDraft);
}

beforeEach(() => sessionStorage.clear());

describe('the user attribute grid draft', () => {
  it('keys an entry by the user and the C1 attribute ID', () => {
    const draft = configure();
    const column: UserAttributeColumn = attributeColumn();
    draft.stageText(student({ grade_level: 9 }), column, '11');
    const entry = draft.entryFor('1100000000000000001', column.id);
    expect(column.id).toBe('attr:Student.grade_level');
    expect(entry?.attribute).toBe('attr:Student.grade_level');
    expect(draftKey(entry!)).toBe(
      '1100000000000000001\u0000attr:Student.grade_level',
    );
    expect(attributeKeyParts(column.id)).toEqual({
      schemaName: 'Student',
      fieldName: 'grade_level',
    });
  });

  it('draws the pending value over the row value', () => {
    const draft = configure();
    const column: UserAttributeColumn = attributeColumn();
    const user = student({ grade_level: 9 });
    draft.stageText(user, column, '11');
    expect(draft.valueFor(user, column)).toBe('11');
    expect(draft.baselineFor(user, column)).toBe(9);
  });

  it('never reads a No answer as an empty cell (B section 12)', () => {
    const draft = configure();
    const column: UserAttributeColumn = attributeColumn({
      id: 'attr:Device.take_home',
      field: attributeField({
        fieldId: 'Device.take_home',
        fieldName: 'take_home',
        displayName: 'Take-home approved',
        fieldType: 'BOOL',
        numericIndexingSpec: null,
      }),
    });
    const approved = student({ take_home: true });
    draft.stageBool(approved, column, false);
    expect(draft.valueFor(approved, column)).toBe('No');
    expect(draft.counts()).toEqual({ changes: 1, users: 1 });
    // A row without the value keeps No as a change, not as Not set.
    const unset = student({});
    draft.stageBool(unset, column, false);
    expect(draft.valueFor(unset, column)).toBe('No');
    expect(draft.reasonFor(draft.entryFor(unset.userId, column.id)!)).toBe('');
  });

  it('marks a Yes answer that returns to the row value as no change', () => {
    const draft = configure();
    const column: UserAttributeColumn = attributeColumn({
      id: 'attr:Device.take_home',
      field: attributeField({
        fieldName: 'take_home',
        displayName: 'Take-home approved',
        fieldType: 'BOOL',
        numericIndexingSpec: null,
      }),
    });
    const approved = student({ take_home: true });
    draft.stageBool(approved, column, false);
    draft.stageBool(approved, column, true);
    expect(draft.entries()).toEqual([]);
    expect(draft.counts().changes).toBe(0);
  });

  it('refuses a text over 500 characters in the cell (ruling 4)', () => {
    const draft = configure();
    const column: UserAttributeColumn = attributeColumn({
      id: 'attr:Student.homeroom',
      field: attributeField({
        fieldName: 'homeroom',
        displayName: 'Homeroom',
        fieldType: 'STRING',
        numericIndexingSpec: null,
      }),
    });
    const user = student({ homeroom: '216' });
    draft.stageText(user, column, 'x'.repeat(501));
    const entry = draft.entryFor(user.userId, column.id)!;
    expect(entry.state).toBe('invalid');
    expect(draft.reasonFor(entry)).toContain('501');
    expect(draft.reasonFor(entry)).toContain('500');
    expect(draft.blocked()).toBe(true);
    expect(draft.line().tone).toBe('error');
  });

  it('refuses a whole number outside the range of the attribute (B section 8.1)', () => {
    const draft = configure();
    const column: UserAttributeColumn = attributeColumn();
    const user = student({ grade_level: 9 });
    draft.stageText(user, column, '13');
    expect(draft.entryFor(user.userId, column.id)?.state).toBe('invalid');
    expect(draft.reasonFor(draft.entryFor(user.userId, column.id)!)).toContain(
      '12',
    );
  });

  it('counts the pending changes and their users for the bar (ruling 14)', () => {
    const draft = configure();
    const column: UserAttributeColumn = attributeColumn();
    const homeroom: UserAttributeColumn = attributeColumn({
      id: 'attr:Student.homeroom',
      field: attributeField({
        fieldName: 'homeroom',
        displayName: 'Homeroom',
        fieldType: 'STRING',
        numericIndexingSpec: null,
      }),
    });
    const second = row({
      userId: '1100000000000000002',
      fullName: 'Aaron Whitfield',
    });
    draft.stageText(student({ grade_level: 9 }), column, '11');
    draft.stageText(second, column, '7');
    draft.stageText(second, homeroom, '216');
    expect(draft.counts()).toEqual({ changes: 3, users: 2 });
    expect(draft.countLine()).toBe('3 pending changes · 2 users');
  });

  it('reverts one cell and keeps the other entries', () => {
    const draft = configure();
    const first: UserAttributeColumn = attributeColumn();
    const second: UserAttributeColumn = attributeColumn({
      id: 'attr:Student.homeroom',
      field: attributeField({
        fieldName: 'homeroom',
        displayName: 'Homeroom',
        fieldType: 'STRING',
        numericIndexingSpec: null,
      }),
    });
    const user = student({ grade_level: 9, homeroom: '216' });
    draft.stageText(user, first, '11');
    draft.stageText(user, second, '230');
    draft.revert(user.userId, first.id);
    expect(draft.entryFor(user.userId, first.id)).toBeNull();
    expect(draft.valueFor(user, first)).toBe('9');
    expect(draft.valueFor(user, second)).toBe('230');
  });

  it('reverts all changes at once', () => {
    const draft = configure();
    const column: UserAttributeColumn = attributeColumn();
    draft.stageText(student({ grade_level: 9 }), column, '11');
    draft.revertAll();
    expect(draft.entries()).toEqual([]);
    expect(draft.panelVisible()).toBe(false);
  });

  it('restores the draft after a reload (DRAFT-01)', () => {
    const first = configure();
    const column: UserAttributeColumn = attributeColumn();
    const user = student({ grade_level: 9 });
    first.stageText(user, column, '11');
    TestBed.resetTestingModule();
    const second = configure();
    expect(second.entryFor(user.userId, column.id)?.value).toBe('11');
    expect(second.valueFor(user, column)).toBe('11');
    expect(second.countLine()).toBe('1 pending change · 1 user');
  });

  it('keeps the rest of the draft when one stored entry is unreadable', () => {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        grid: {
          entries: [
            { userId: 'broken' },
            {
              userId: '1100000000000000001',
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
            },
          ],
        },
      }),
    );
    const draft = configure();
    expect(draft.entries()).toHaveLength(1);
    expect(draft.storageError()).not.toBe('');
  });

  it('blocks Save changes while a preview marks a conflict (B section 8.4)', () => {
    const draft = configure();
    const column: UserAttributeColumn = attributeColumn();
    const user = student({ grade_level: 9 });
    draft.stageText(user, column, '11');
    const edits = draft.edits();
    draft.applyPreview(
      [
        {
          userId: user.userId,
          attribute: column.id,
          disposition: 'conflict',
          currentValue: 10,
        },
      ] as never,
      edits,
    );
    expect(draft.entryFor(user.userId, column.id)?.state).toBe('conflict');
    expect(draft.blocked()).toBe(true);
    expect(draft.line().tone).toBe('warning');
    expect(draft.line().text).toContain('Grade level');
    // The person's answer clears the conflict, so Save changes returns.
    draft.stageText(user, column, '12');
    expect(draft.entryFor(user.userId, column.id)?.state).toBe('pending');
    expect(draft.blocked()).toBe(false);
  });

  it('drops an unchanged row that the preview read (B section 8.4)', () => {
    const draft = configure();
    const column: UserAttributeColumn = attributeColumn();
    const user = student({ grade_level: 9 });
    draft.stageText(user, column, '11');
    const edits = draft.edits();
    draft.applyPreview(
      [
        {
          userId: user.userId,
          attribute: column.id,
          disposition: 'unchanged',
          currentValue: 11,
        },
      ] as never,
      edits,
    );
    expect(draft.entries()).toEqual([]);
  });

  it('leaves the draft at acceptance and keeps the saved value on screen', () => {
    const draft = configure();
    const column: UserAttributeColumn = attributeColumn();
    const user = student({ grade_level: 9 });
    draft.stageText(user, column, '11');
    draft.accept(draft.edits());
    expect(draft.entries()).toEqual([]);
    expect(draft.counts().changes).toBe(0);
    // The row still holds the old value, so the cell draws the submitted value.
    expect(draft.valueFor(user, column)).toBe('11');
    expect(draft.settledUserIds()).toEqual([user.userId]);
  });

  it('keeps a later edit of the same cell in the draft', () => {
    const draft = configure();
    const column: UserAttributeColumn = attributeColumn();
    const user = student({ grade_level: 9 });
    draft.stageText(user, column, '11');
    const edits = draft.edits();
    draft.stageText(user, column, '12');
    draft.accept(edits);
    expect(draft.entryFor(user.userId, column.id)?.value).toBe('12');
    expect(draft.valueFor(user, column)).toBe('12');
  });

  it('clears the saved mark when the row holds the written value', () => {
    const draft = configure();
    const column: UserAttributeColumn = attributeColumn();
    const user = student({ grade_level: 9 });
    draft.stageText(user, column, '11');
    draft.accept(draft.edits());
    draft.settleWithRows([student({ grade_level: 11 })]);
    expect(draft.settledUserIds()).toEqual([]);
    expect(draft.valueFor(student({ grade_level: 11 }), column)).toBe('11');
  });

  it('keeps the saved mark while the row holds the old value', () => {
    const draft = configure();
    const column: UserAttributeColumn = attributeColumn();
    const user = student({ grade_level: 9 });
    draft.stageText(user, column, '11');
    draft.accept(draft.edits());
    draft.settleWithRows([student({ grade_level: 9 })]);
    expect(draft.settledUserIds()).toEqual([user.userId]);
  });

  it('clears the saved mark when the job fails', () => {
    const draft = configure();
    const column: UserAttributeColumn = attributeColumn();
    const user = student({ grade_level: 9 });
    draft.stageText(user, column, '11');
    draft.accept(draft.edits());
    draft.dropSettled();
    expect(draft.settledUserIds()).toEqual([]);
    expect(draft.valueFor(user, column)).toBe('9');
  });

  it('reads the row text of a saved cell without the column', () => {
    const column: UserAttributeColumn = attributeColumn();
    const cell = {
      userId: '1100000000000000001',
      userName: 'Amara Okafor',
      attribute: column.id,
      label: column.label,
      fieldType: 'INT64' as UserAttributeFieldType,
      multiValued: false,
      minValue: 0,
      maxValue: 12,
      value: '11',
      baseline: 9,
    };
    expect(rowCellText(student({ grade_level: 11 }), cell)).toBe('11');
    // The built attribute column draws no text for a value that Google does not hold.
    expect(rowCellText(student({}), cell)).toBe('');
  });
});
