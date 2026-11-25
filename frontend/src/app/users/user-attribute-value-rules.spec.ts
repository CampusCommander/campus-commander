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

  it('blocks an invalid number beside a valid change, even from an unset value (R1-C)', () => {
    const drafts = attributeDrafts([student], { Student: { homeroom: '214' } });
    const gradeDraft = draftOf(drafts, 'attr:Student.grade_level');
    expect(gradeDraft.baseline).toBeNull();
    // An invalid number once vanished from the save, because NaN dropped out of the
    // canonical list and an unset baseline compared equal.
    const invalid = attributeDraftResult(
      { ...gradeDraft, value: 'ten' },
      userId,
    );
    expect(invalid.changed).toBe(true);
    expect(invalid.error).toBe('Enter a whole number.');
    expect(invalid.edit).toBeNull();
    const sibling = attributeDraftResult(
      { ...draftOf(drafts, 'attr:Student.homeroom'), value: '216' },
      userId,
    );
    expect(sibling.error).toBeNull();
    // The refused field takes no edit. The editor blocks the whole save instead.
    const edited = drafts.map((draft) =>
      draft.key === gradeDraft.key
        ? { ...draft, value: 'ten' }
        : draft.key === 'attr:Student.homeroom'
          ? { ...draft, value: '216' }
          : draft,
    );
    expect(attributeEdits(edited, userId)).toEqual([
      {
        userId,
        attribute: 'attr:Student.homeroom',
        mode: 'set',
        values: ['216'],
        baselineValue: '214',
      },
    ]);
  });

  it('refuses numeric spellings with a leading zero beside the unchanged number (R1-C)', () => {
    const drafts = attributeDrafts([student], schemas);
    const result = attributeDraftResult(
      { ...draftOf(drafts, 'attr:Student.grade_level'), value: '010' },
      userId,
    );
    // The canonical form is 10, which equals the baseline. The raw rule still applies.
    expect(result.changed).toBe(true);
    expect(result.error).toBe('Enter a whole number.');
    expect(result.edit).toBeNull();
  });

  it('keeps an untouched list with existing duplicates quiet (B section 8.2)', () => {
    const drafts = attributeDrafts([student], {
      Student: { programs: [{ value: 'Band' }, { value: 'Band' }] },
    });
    const result = attributeDraftResult(
      draftOf(drafts, 'attr:Student.programs'),
      userId,
    );
    expect(result).toEqual({ changed: false, error: null, edit: null });
  });

  it('edits the list of every multi-value type as its own values (R1-B)', () => {
    const types = field({
      fieldId: 'Multi.kinds',
      fieldName: 'kinds',
      displayName: 'Kinds',
      fieldType: 'STRING',
      multiValued: true,
    });
    const multi = {
      schemaId: 'schema-multi',
      schemaName: 'Multi',
      displayName: 'Multi information',
      etag: '"multi-etag"',
      fields: [types],
      holders: 1,
      readAt: '2026-11-01T13:12:00.000Z',
    } satisfies UserAttributeCategory;
    const drafts = attributeDrafts([multi], {
      Multi: { kinds: [{ value: 'One' }, { value: 'Two' }] },
    });
    expect(draftOf(drafts, 'attr:Multi.kinds').value).toEqual(['One', 'Two']);
    const result = attributeDraftResult(
      {
        ...draftOf(drafts, 'attr:Multi.kinds'),
        value: ['One', 'Two', 'Three'],
      },
      userId,
    );
    expect(result.edit?.mode).toBe('replace');
    expect(result.edit?.values).toEqual(['One', 'Two', 'Three']);
  });

  it('shows a multi-value Yes or No list in the words of its editor (R1-B)', () => {
    const yesNo = field({
      fieldId: 'Multi.answers',
      fieldName: 'answers',
      displayName: 'Answers',
      fieldType: 'BOOL',
      multiValued: true,
    });
    const multi = {
      schemaId: 'schema-multi',
      schemaName: 'Multi',
      displayName: 'Multi information',
      etag: '"multi-etag"',
      fields: [yesNo],
      holders: 1,
      readAt: '2026-11-01T13:12:00.000Z',
    } satisfies UserAttributeCategory;
    const drafts = attributeDrafts([multi], {
      Multi: { answers: [{ value: true }, { value: false }] },
    });
    expect(draftOf(drafts, 'attr:Multi.answers').value).toEqual(['Yes', 'No']);
    const result = attributeDraftResult(
      { ...draftOf(drafts, 'attr:Multi.answers'), value: ['Yes'] },
      userId,
    );
    expect(result.edit?.values).toEqual([true]);
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
