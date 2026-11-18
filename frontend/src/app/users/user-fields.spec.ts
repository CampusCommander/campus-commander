import { describe, expect, it } from 'vitest';
import type {
  UserAttributeCategory,
  UserRow,
} from '@campus/application-contracts';
import {
  USER_FIELDS,
  attributeColumns,
  attributeText,
  chipLabel,
  orgUnitOptions,
  statusValue,
  suggestions,
  syncFailureText,
  unitCheck,
  withUnit,
} from './user-fields';

const row = (extra: Partial<UserRow> = {}): UserRow => ({
  userId: '110000000000000000001',
  primaryEmail: 'aaliyah.brooks@example.org',
  orgUnitPath: '/Students/High School',
  givenName: 'Aaliyah',
  familyName: 'Brooks',
  fullName: 'Aaliyah Brooks',
  suspended: false,
  suspensionReason: null,
  archived: false,
  lastLoginTime: '2026-11-01T12:00:00.000Z',
  creationTime: '2020-08-01T12:00:00.000Z',
  twoStepEnrolled: true,
  department: null,
  title: null,
  aliases: [],
  customSchemas: {},
  lastEntitySync: '2026-11-01T12:00:00.000Z',
  stale: false,
  recordVersion: 1,
  ...extra,
});

const category = (
  schemaName: string,
  displayName: string,
  fieldName: string,
  displayLabel: string,
): UserAttributeCategory => ({
  schemaId: `schema-${schemaName}`,
  schemaName,
  displayName,
  etag: '"schema-etag"',
  fields: [
    {
      fieldId: `${schemaName}.${fieldName}`,
      fieldName,
      displayName: displayLabel,
      fieldType: 'STRING',
      multiValued: false,
      indexed: true,
      readAccessType: 'ALL_DOMAIN_USERS',
      numericIndexingSpec: null,
      holders: 100,
    },
  ],
  holders: 100,
  readAt: '2026-11-16T12:00:00.000Z',
});

describe('the static user columns', () => {
  it('keeps the approved order and marks Created, Department, and Title optional', () => {
    expect(USER_FIELDS.map((field) => field.id)).toEqual([
      'fullName',
      'primaryEmail',
      'orgUnitPath',
      'status',
      'lastLoginTime',
      'twoStep',
      'creationTime',
      'department',
      'title',
    ]);
    expect(
      USER_FIELDS.filter((field) => field.optional).map((field) => field.id),
    ).toEqual(['creationTime', 'department', 'title']);
  });

  it('derives the status with Archived over Suspended over Active', () => {
    expect(statusValue(row())).toBe('active');
    expect(statusValue(row({ suspended: true }))).toBe('suspended');
    expect(statusValue(row({ suspended: true, archived: true }))).toBe(
      'archived',
    );
  });
});

describe('the attribute columns', () => {
  it('makes one column per attribute with the C1 key', () => {
    const columns = attributeColumns([
      category('Student', 'Student information', 'grade_level', 'Grade level'),
    ]);
    expect(columns).toHaveLength(1);
    expect(columns[0].id).toBe('attr:Student.grade_level');
    expect(columns[0].label).toBe('Grade level');
  });

  it('names the category in the header when two categories share an attribute name', () => {
    const columns = attributeColumns([
      category('Student', 'Student information', 'building', 'Building'),
      category('Staff', 'Staff information', 'building', 'Building'),
    ]);
    expect(columns.map((column) => column.label)).toEqual([
      'Building · Student information',
      'Building · Staff information',
    ]);
    expect(columns[0].id).not.toBe(columns[1].id);
  });

  it('reads a value, a list of values, and a boolean', () => {
    const [single, list, flag] = attributeColumns([
      category('Student', 'Student information', 'grade_level', 'Grade level'),
      category('Student', 'Student information', 'programs', 'Programs'),
      category(
        'Student',
        'Student information',
        'take_home',
        'Take-home approved',
      ),
    ]);
    const user = row({
      customSchemas: {
        Student: {
          grade_level: '11',
          programs: [{ value: 'Band' }, { value: 'Robotics' }],
          take_home: true,
        },
      },
    });
    expect(attributeText(user, single)).toBe('11');
    expect(attributeText(user, list)).toBe('Band, Robotics');
    expect(attributeText(user, flag)).toBe('Yes');
  });

  it('reads no inherited object property as a value (R12)', () => {
    const [constructorField, protoField] = attributeColumns([
      category('Student', 'Student information', 'constructor', 'Constructor'),
      category('Student', 'Student information', '__proto__', 'Prototype'),
    ]);
    const user = row({ customSchemas: { Student: {} } });
    expect(attributeText(user, constructorField)).toBe('');
    expect(attributeText(user, protoField)).toBe('');
  });

  it('reads no attribute of an inherited category name (R12)', () => {
    const [grade] = attributeColumns([
      category('constructor', 'Constructor', 'grade_level', 'Grade level'),
    ]);
    const user = row({ customSchemas: {} });
    expect(attributeText(user, grade)).toBe('');
  });

  it('keeps ordinary values, zero, and false (R12)', () => {
    const [grade, flag] = attributeColumns([
      category('Student', 'Student information', 'grade_level', 'Grade level'),
      category('Student', 'Student information', 'take_home', 'Take-home'),
    ]);
    const user = row({
      customSchemas: { Student: { grade_level: 0, take_home: false } },
    });
    expect(attributeText(user, grade)).toBe('0');
    expect(attributeText(user, flag)).toBe('No');
  });
});

describe('the chip text', () => {
  it('names a status set and an organization unit subtree', () => {
    expect(
      chipLabel({
        field: 'status',
        operator: 'is',
        values: ['active', 'suspended'],
      }),
    ).toBe('Status · Active, Suspended');
    expect(
      chipLabel({
        field: 'orgUnitPath',
        operator: 'in',
        values: ['/Students/High School'],
      }),
    ).toBe('Organization unit · /Students/High School');
  });

  it('names a text operator and an empty date', () => {
    expect(
      chipLabel({ field: 'fullName', operator: 'contains', value: 'Aaliyah' }),
    ).toBe('Name contains: Aaliyah');
    expect(chipLabel({ field: 'department', operator: 'isEmpty' })).toBe(
      'Department is empty',
    );
    expect(
      chipLabel({
        field: 'lastLoginTime',
        operator: 'before',
        value: '2026-10-31T12:00:00.000Z',
      }),
    ).toContain('Last sign-in before:');
  });

  it('uses the attribute display name for an attribute filter', () => {
    const [column] = attributeColumns([
      category('Student', 'Student information', 'grade_level', 'Grade level'),
    ]);
    expect(
      chipLabel(
        {
          field: 'attribute',
          schemaName: 'Student',
          fieldName: 'grade_level',
          operator: 'numberRange',
          from: 9,
          to: 12,
        },
        [column],
      ),
    ).toBe('Grade level 9 to 12');
    expect(
      chipLabel(
        {
          field: 'attribute',
          schemaName: 'Student',
          fieldName: 'grade_level',
          operator: 'hasValue',
        },
        [column],
      ),
    ).toBe('Grade level has a value');
  });
});

describe('the filter entry', () => {
  it('matches fields by label and offers the Alias field', () => {
    const { fields } = suggestions('ali');
    expect(fields.map((field) => field.label)).toEqual(['Alias']);
  });

  it('matches an attribute by its label', () => {
    const [column] = attributeColumns([
      category('Student', 'Student information', 'grade_level', 'Grade level'),
    ]);
    const { fields } = suggestions('grade', [column]);
    expect(fields.map((field) => field.label)).toContain('Grade level');
  });

  it('offers Name and Primary email shortcuts for typed text', () => {
    const { shortcuts } = suggestions('aaliyah');
    expect(shortcuts).toEqual([
      { field: 'fullName', operator: 'contains', value: 'aaliyah' },
      { field: 'primaryEmail', operator: 'contains', value: 'aaliyah' },
    ]);
  });
});

describe('the organization unit filter', () => {
  const units = [
    { path: '/Students/High School' },
    { path: '/Students/Middle School' },
  ];

  it('lists the root and every ancestor path', () => {
    expect(orgUnitOptions(units).map((option) => option.path)).toEqual([
      '/',
      '/Students',
      '/Students/High School',
      '/Students/Middle School',
    ]);
  });

  it('chooses the units inside a chosen unit', () => {
    expect(withUnit([], units, '/Students', true)).toEqual([
      '/Students/High School',
      '/Students/Middle School',
    ]);
    expect(
      unitCheck(withUnit([], units, '/Students', true), units, '/Students'),
    ).toBe('checked');
    expect(unitCheck(['/Students/High School'], units, '/Students')).toBe(
      'mixed',
    );
  });
});

describe('the sync failure text', () => {
  it('names the scope for a denied directory read', () => {
    expect(syncFailureText('delegation-not-authorized')).toContain(
      'admin.directory.user.readonly',
    );
  });

  it('names a network failure without a scope', () => {
    expect(syncFailureText('network-failure')).toBe(
      'Campus Commander could not reach Google. Refresh again.',
    );
  });
});
