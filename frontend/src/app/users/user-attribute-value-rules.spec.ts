import { describe, expect, it } from 'vitest';
import type {
  UserAttributeCategory,
  UserAttributeField,
} from '@campus/application-contracts';
import {
  ATTRIBUTE_TEXT_LIMIT,
  attributeDraftResult,
  attributeDrafts,
  attributeEdits,
  attributeEditorValue,
  attributeWireText,
  sameAttributeValue,
  type AttributeDraft,
} from './user-attribute-value-rules';

function field(extra: Partial<UserAttributeField>): UserAttributeField {
  return {
    fieldId: 'Student.grade_level',
    fieldName: 'grade_level',
    displayName: 'Grade level',
    fieldType: 'INT64',
    multiValued: false,
    indexed: true,
    readAccessType: 'ALL_DOMAIN_USERS',
    numericIndexingSpec: null,
    holders: 1,
    ...extra,
  };
}

const grade = field({});
const homeroom = field({
  fieldId: 'Student.homeroom',
  fieldName: 'homeroom',
  displayName: 'Homeroom',
  fieldType: 'STRING',
});
const programs = field({
  fieldId: 'Student.programs',
  fieldName: 'programs',
  displayName: 'Programs',
  fieldType: 'STRING',
  multiValued: true,
});
const takeHome = field({
  fieldId: 'Device.take_home',
  fieldName: 'take_home',
  displayName: 'Take-home approved',
  fieldType: 'BOOL',
});

const student: UserAttributeCategory = {
  schemaId: 'schema-student',
  schemaName: 'Student',
  displayName: 'Student information',
  etag: '"student-etag"',
  fields: [grade, homeroom, programs],
  holders: 2,
  readAt: '2026-11-01T13:12:00.000Z',
};
const device: UserAttributeCategory = {
  schemaId: 'schema-device',
  schemaName: 'Device',
  displayName: 'Device program',
  etag: '"device-etag"',
  fields: [takeHome],
  holders: 1,
  readAt: '2026-11-01T13:12:00.000Z',
};

const schemas = {
  Student: {
    grade_level: '10',
    homeroom: '214',
    programs: [{ value: 'Gifted' }, { value: 'Band' }],
  },
  Device: { take_home: true },
};

const userId = '110000000000000000001';

function draftOf(
  drafts: readonly AttributeDraft[],
  key: string,
): AttributeDraft {
  const draft = drafts.find((candidate) => candidate.key === key);
  if (!draft) throw new Error(`No draft ${key}`);
  return draft;
}

describe('the attribute value rules', () => {
  it('starts every field from the value that the card showed', () => {
    const drafts = attributeDrafts([student, device], schemas);
    expect(draftOf(drafts, 'attr:Student.grade_level').baseline).toBe(10);
    expect(draftOf(drafts, 'attr:Student.programs').baseline).toEqual([
      'Gifted',
      'Band',
    ]);
    expect(draftOf(drafts, 'attr:Device.take_home').value).toBe(true);
  });

  it('reads the count message of in-grid editing for a text over 500 characters', () => {
    const drafts = attributeDrafts([student], { Student: { homeroom: 'A' } });
    const draft = draftOf(drafts, 'attr:Student.homeroom');
    const result = attributeDraftResult(
      { ...draft, value: 'x'.repeat(ATTRIBUTE_TEXT_LIMIT + 12) },
      userId,
    );
    expect(result.changed).toBe(true);
    expect(result.error).toBe('512 of 500 characters');
    expect(result.edit).toBeNull();
  });

  it('refuses a whole number that is not a number', () => {
    const drafts = attributeDrafts([student], schemas);
    const result = attributeDraftResult(
      { ...draftOf(drafts, 'attr:Student.grade_level'), value: 'ten' },
      userId,
    );
    expect(result.error).toBe('Enter a whole number.');
  });

  it('builds one Set edit with the baseline of the card', () => {
    const drafts = attributeDrafts([student], schemas);
    const result = attributeDraftResult(
      { ...draftOf(drafts, 'attr:Student.grade_level'), value: '11' },
      userId,
    );
    expect(result.edit).toEqual({
      userId,
      attribute: 'attr:Student.grade_level',
      mode: 'set',
      values: [11],
      baselineValue: 10,
    });
  });

  it('adds no edit for an unchanged value', () => {
    const drafts = attributeDrafts([student], schemas);
    expect(attributeEdits(drafts, userId)).toEqual([]);
  });

  it('clears a single value with no values and the baseline', () => {
    const drafts = attributeDrafts([student], schemas);
    const result = attributeDraftResult(
      { ...draftOf(drafts, 'attr:Student.grade_level'), value: '' },
      userId,
    );
    expect(result.edit).toEqual({
      userId,
      attribute: 'attr:Student.grade_level',
      mode: 'clear',
      values: [],
      baselineValue: 10,
    });
  });

  it('replaces the list of a multi-value attribute', () => {
    const drafts = attributeDrafts([student], schemas);
    const result = attributeDraftResult(
      {
        ...draftOf(drafts, 'attr:Student.programs'),
        value: ['Gifted', 'Band', 'ESL'],
      },
      userId,
    );
    expect(result.edit?.mode).toBe('replace');
    expect(result.edit?.values).toEqual(['Gifted', 'Band', 'ESL']);
    expect(result.edit?.baselineValue).toEqual(['Gifted', 'Band']);
  });

  it('clears a multi-value attribute that keeps no value', () => {
    const drafts = attributeDrafts([student], schemas);
    const result = attributeDraftResult(
      { ...draftOf(drafts, 'attr:Student.programs'), value: [] },
      userId,
    );
    expect(result.edit?.mode).toBe('clear');
    expect(result.edit?.values).toEqual([]);
  });

  it('treats the stored text and number forms as equal', () => {
    const stringForm = attributeEditorValue('10', field({}));
    expect(stringForm).toBe('10');
    expect(sameAttributeValue(grade, 10, '10')).toBe(true);
    expect(
      sameAttributeValue(programs, ['Band', 'Gifted'], ['Gifted', 'Band']),
    ).toBe(false);
  });

  it('shows Not set and a comma list in the review rows', () => {
    expect(attributeWireText(null)).toBe('Not set');
    expect(attributeWireText(true)).toBe('Yes');
    expect(attributeWireText(['Gifted', 'Band'])).toBe('Gifted, Band');
  });
});
