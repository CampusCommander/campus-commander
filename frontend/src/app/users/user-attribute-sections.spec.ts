import { describe, expect, it } from 'vitest';
import type {
  UserAttributeCategory,
  UserCustomSchemas,
} from '@campus/application-contracts';
import {
  attributeValues,
  rawAttributeSections,
  userAttributeSections,
  valueText,
} from './user-attribute-sections';

const field = (
  fieldName: string,
  displayName: string,
  multiValued = false,
) => ({
  fieldId: `Student.${fieldName}`,
  fieldName,
  displayName,
  fieldType: 'STRING' as const,
  multiValued,
  indexed: true,
  readAccessType: 'ALL_DOMAIN_USERS' as const,
  numericIndexingSpec: null,
  holders: 12,
});

const category = (
  schemaName: string,
  displayName: string,
  fields: ReturnType<typeof field>[],
): UserAttributeCategory => ({
  schemaId: `schema-${schemaName}`,
  schemaName,
  displayName,
  etag: `"${schemaName}-etag"`,
  fields,
  holders: 12,
  readAt: '2026-11-16T12:00:00.000Z',
});

describe('the Custom attributes card sections', () => {
  it('builds one section for each category in the order of the category read', () => {
    const sections = userAttributeSections(
      [
        category('Student', 'Student information', [
          field('grade_level', 'Grade level'),
        ]),
        category('Staff', 'Staff information', [field('building', 'Building')]),
      ],
      { Student: { grade_level: '10' } },
    );
    expect(sections.map((section) => section.displayName)).toEqual([
      'Student information',
      'Staff information',
    ]);
  });

  it('shows a number and a boolean as their values, and an absent value as none', () => {
    const sections = userAttributeSections(
      [
        category('Device', 'Device program', [
          field('take_home', 'Take-home approved'),
          field('model', 'Model'),
        ]),
      ],
      { Device: { take_home: true } },
    );
    expect(
      sections[0].values.map((value) => [value.label, value.values]),
    ).toEqual([
      ['Take-home approved', ['Yes']],
      ['Model', []],
    ]);
  });

  it('keeps a multi-valued attribute as a list of its values, in order', () => {
    const sections = userAttributeSections(
      [
        category('Student', 'Student information', [
          field('programs', 'Programs', true),
        ]),
      ],
      {
        Student: {
          programs: [{ value: 'Gifted' }, { value: 'Band' }],
        },
      },
    );
    expect(sections[0].values[0]).toEqual({
      fieldName: 'programs',
      label: 'Programs',
      values: ['Gifted', 'Band'],
      multiValued: true,
    });
  });

  it('reads a single value of a multi-valued attribute as a one-item list', () => {
    const sections = userAttributeSections(
      [
        category('Student', 'Student information', [
          field('programs', 'Programs', true),
        ]),
      ],
      { Student: { programs: [{ value: 'Gifted' }] } },
    );
    expect(sections[0].values[0].values).toEqual(['Gifted']);
  });

  it('shows no values for a category whose attributes all hold none', () => {
    const sections = userAttributeSections(
      [category('Staff', 'Staff information', [field('building', 'Building')])],
      {},
    );
    // Composition choice 2: the heading and the one line, "No values set".
    expect(sections[0].values).toEqual([]);
  });

  it('keeps every attribute of a category that holds one value', () => {
    const sections = userAttributeSections(
      [
        category('Student', 'Student information', [
          field('grade_level', 'Grade level'),
          field('homeroom', 'Homeroom'),
        ]),
      ],
      { Student: { grade_level: '10' } },
    );
    expect(sections[0].values.map((value) => value.label)).toEqual([
      'Grade level',
      'Homeroom',
    ]);
    expect(sections[0].values[1].values).toEqual([]);
  });

  it('reads no value from an Object prototype name (R12)', () => {
    // The record holds no own `constructor` key, so the prototype member is not a value.
    const schemas = JSON.parse(
      '{"Student":{"grade_level":"10"}}',
    ) as UserCustomSchemas;
    const sections = userAttributeSections(
      [
        category('Student', 'Student information', [
          field('constructor', 'Constructor'),
          field('grade_level', 'Grade level'),
        ]),
      ],
      schemas,
    );
    expect(sections[0].values.map((value) => value.values)).toEqual([
      [],
      ['10'],
    ]);
  });

  it('names the raw category and attribute keys without the category read', () => {
    const sections = rawAttributeSections({
      Student: { grade_level: '10', homeroom: '214' },
    });
    expect(sections).toEqual([
      {
        schemaName: 'Student',
        displayName: 'Student',
        values: [
          {
            fieldName: 'grade_level',
            label: 'grade_level',
            values: ['10'],
            multiValued: false,
          },
          {
            fieldName: 'homeroom',
            label: 'homeroom',
            values: ['214'],
            multiValued: false,
          },
        ],
      },
    ]);
  });
});

describe('the attribute value readers', () => {
  it('unwraps a list of value entries and leaves a scalar as one value', () => {
    expect(attributeValues([{ value: 'a' }, { value: 2 }])).toEqual(['a', 2]);
    expect(attributeValues('a')).toEqual(['a']);
    expect(attributeValues(null)).toEqual([]);
  });

  it('writes a boolean as Yes or No', () => {
    expect(valueText(true)).toBe('Yes');
    expect(valueText(false)).toBe('No');
    expect(valueText(2029)).toBe('2029');
  });
});
