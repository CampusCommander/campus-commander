import { describe, expect, it } from 'vitest';
import type { UserAttributeCategory } from '@campus/application-contracts';
import {
  canonicalPredicates,
  filterModelFromPredicates,
  filterModelUpdate,
  mergeGridPredicates,
  predicatesFromFilterModel,
  samePredicates,
} from './user-filter-model';
import { attributeColumns } from './user-fields';

const attributes = attributeColumns([
  {
    schemaId: 'schema-student',
    schemaName: 'Student',
    displayName: 'Student information',
    etag: '"schema-etag"',
    holders: 300,
    readAt: '2026-11-16T12:00:00.000Z',
    fields: [
      {
        fieldId: 'Student.grade_level',
        fieldName: 'grade_level',
        displayName: 'Grade level',
        fieldType: 'INT64',
        multiValued: false,
        indexed: true,
        readAccessType: 'ALL_DOMAIN_USERS',
        numericIndexingSpec: null,
        holders: 120,
      },
      {
        fieldId: 'Student.graduation_year',
        fieldName: 'graduation_year',
        displayName: 'Graduation year',
        fieldType: 'INT64',
        multiValued: false,
        indexed: true,
        readAccessType: 'ALL_DOMAIN_USERS',
        numericIndexingSpec: null,
        holders: 120,
      },
    ],
  } satisfies UserAttributeCategory,
  {
    schemaId: 'schema-device',
    schemaName: 'Device',
    displayName: 'Device program',
    etag: '"schema-device-etag"',
    holders: 300,
    readAt: '2026-11-16T12:00:00.000Z',
    fields: [
      {
        fieldId: 'Device.take_home',
        fieldName: 'take_home',
        displayName: 'Take-home approved',
        fieldType: 'BOOL',
        multiValued: false,
        indexed: true,
        readAccessType: 'ALL_DOMAIN_USERS',
        numericIndexingSpec: null,
        holders: 200,
      },
    ],
  } satisfies UserAttributeCategory,
]);

describe('the column filters that the users query reads', () => {
  it('reads a status set filter as one status predicate', () => {
    expect(
      predicatesFromFilterModel({
        status: { filterType: 'set', values: ['active', 'suspended'] },
      }),
    ).toEqual([
      { field: 'status', operator: 'is', values: ['active', 'suspended'] },
    ]);
  });

  it('reads an organization unit set filter as a subtree filter', () => {
    expect(
      predicatesFromFilterModel({
        orgUnitPath: { filterType: 'set', values: ['/Students/High School'] },
      }),
    ).toEqual([
      {
        field: 'orgUnitPath',
        operator: 'in',
        values: ['/Students/High School'],
      },
    ]);
  });

  it('reads a blank text filter as an empty field', () => {
    expect(
      predicatesFromFilterModel({
        department: { filterType: 'text', type: 'blank' },
      }),
    ).toEqual([{ field: 'department', operator: 'isEmpty' }]);
  });

  it('reads a date before filter as an instant', () => {
    expect(
      predicatesFromFilterModel({
        lastLoginTime: {
          filterType: 'date',
          type: 'before',
          dateFrom: '2026-10-31 00:00:00',
        },
      }),
    ).toEqual([
      {
        field: 'lastLoginTime',
        operator: 'before',
        value: new Date(2026, 9, 31).toISOString(),
      },
    ]);
  });

  it('reads an attribute number range under its C1 key', () => {
    expect(
      predicatesFromFilterModel(
        {
          'attr:Student.grade_level': {
            filterType: 'number',
            type: 'inRange',
            filter: 9,
            filterTo: 12,
          },
        },
        attributes,
      ),
    ).toEqual([
      {
        field: 'attribute',
        schemaName: 'Student',
        fieldName: 'grade_level',
        operator: 'numberRange',
        from: 9,
        to: 12,
      },
    ]);
  });

  it('reads a boolean attribute filter as yes or no', () => {
    expect(
      predicatesFromFilterModel(
        {
          'attr:Device.take_home': { filterType: 'set', values: ['true'] },
        },
        attributes,
      ),
    ).toEqual([
      {
        field: 'attribute',
        schemaName: 'Device',
        fieldName: 'take_home',
        operator: 'is',
        value: true,
      },
    ]);
  });

  it('reads both boolean values as a set attribute (R6)', () => {
    expect(
      predicatesFromFilterModel(
        {
          'attr:Device.take_home': {
            filterType: 'set',
            values: ['true', 'false'],
          },
        },
        attributes,
      ),
    ).toEqual([
      {
        field: 'attribute',
        schemaName: 'Device',
        fieldName: 'take_home',
        operator: 'hasValue',
      },
    ]);
  });

  it('refuses an empty boolean set instead of reading it as No (R6)', () => {
    expect(() =>
      predicatesFromFilterModel(
        {
          'attr:Device.take_home': { filterType: 'set', values: [] },
        },
        attributes,
      ),
    ).toThrow('The user query cannot match an empty boolean filter.');
  });

  it('fails a filter for a column that the query cannot express', () => {
    expect(() =>
      predicatesFromFilterModel({
        serialNumber: { filterType: 'text', type: 'contains', filter: 'x' },
      }),
    ).toThrow('The user query has no filter for serialNumber.');
    expect(() =>
      predicatesFromFilterModel({
        'attr:Student.unknown': { filterType: 'set', values: ['x'] },
      }),
    ).toThrow('The user query has no filter for attr:Student.unknown.');
  });
});

describe('the filter model that shows the chips', () => {
  it('shows a status predicate as a set filter', () => {
    expect(
      filterModelFromPredicates([
        { field: 'status', operator: 'is', values: ['archived'] },
      ]),
    ).toEqual({ status: { filterType: 'set', values: ['archived'] } });
  });

  it('shows an attribute range under the attribute key', () => {
    expect(
      filterModelFromPredicates(
        [
          {
            field: 'attribute',
            schemaName: 'Student',
            fieldName: 'grade_level',
            operator: 'numberRange',
            from: 9,
            to: 12,
          },
        ],
        attributes,
      ),
    ).toEqual({
      'attr:Student.grade_level': {
        filterType: 'number',
        type: 'inRange',
        filter: 9,
        filterTo: 12,
      },
    });
  });

  it('keeps the predicates of an alias filter out of the grid, which has no alias column', () => {
    expect(
      filterModelFromPredicates([
        { field: 'aliases', operator: 'contains', value: 'a.brooks' },
      ]),
    ).toEqual({});
  });

  it('round trips chips and column filters through one canonical form', () => {
    const predicates = [
      {
        field: 'fullName' as const,
        operator: 'contains' as const,
        value: 'Aaliyah',
      },
      {
        field: 'twoStep' as const,
        operator: 'is' as const,
        values: ['not-enrolled' as const],
      },
      {
        field: 'attribute' as const,
        schemaName: 'Student',
        fieldName: 'grade_level',
        operator: 'numberRange' as const,
        from: 9,
        to: 12,
      },
    ];
    const model = filterModelFromPredicates(predicates, attributes);
    expect(predicatesFromFilterModel(model, attributes)).toEqual(
      canonicalPredicates(predicates, attributes),
    );
  });

  it('keeps an alias filter through canonicalization (R4)', () => {
    const alias = {
      field: 'aliases' as const,
      operator: 'contains' as const,
      value: 'a.brooks',
    };
    expect(canonicalPredicates([alias])).toEqual([alias]);
    expect(samePredicates([alias], [])).toBe(false);
  });

  it('keeps a has-a-value filter through canonicalization (R4)', () => {
    const hasValue = {
      field: 'attribute' as const,
      schemaName: 'Student',
      fieldName: 'homeroom',
      operator: 'hasValue' as const,
    };
    expect(canonicalPredicates([hasValue], attributes)).toEqual([hasValue]);
    expect(samePredicates([hasValue], [], attributes)).toBe(false);
  });

  it('merges a kept filter after the grid filters and lets a grid filter win its field (R4)', () => {
    const alias = {
      field: 'aliases' as const,
      operator: 'contains' as const,
      value: 'a.brooks',
    };
    const homeroom = {
      field: 'attribute' as const,
      schemaName: 'Student',
      fieldName: 'homeroom',
      operator: 'hasValue' as const,
    };
    const homeroomText = {
      field: 'attribute' as const,
      schemaName: 'Student',
      fieldName: 'homeroom',
      operator: 'contains' as const,
      value: '118',
    };
    const status = {
      field: 'status' as const,
      operator: 'is' as const,
      values: ['active' as const],
    };
    expect(mergeGridPredicates([status], [alias, homeroom])).toEqual([
      status,
      alias,
      homeroom,
    ]);
    expect(mergeGridPredicates([homeroomText], [homeroom])).toEqual([
      homeroomText,
    ]);
  });
});

describe('the model that the grid is given', () => {
  it('keeps the current model when only a filter-only chip changed (R4)', () => {
    const alias = {
      field: 'aliases' as const,
      operator: 'contains' as const,
      value: 'a.brooks',
    };
    const hasValue = {
      field: 'attribute' as const,
      schemaName: 'Student',
      fieldName: 'homeroom',
      operator: 'hasValue' as const,
    };
    // Neither predicate has a column filter, so the grid model already fits them.
    expect(filterModelUpdate({}, [alias], attributes)).toBeNull();
    expect(filterModelUpdate({}, [hasValue], attributes)).toBeNull();
    expect(filterModelUpdate({}, [alias, hasValue], attributes)).toBeNull();
  });

  it('gives the grid the model of a changed column filter (R4)', () => {
    const status = {
      field: 'status' as const,
      operator: 'is' as const,
      values: ['active' as const],
    };
    expect(filterModelUpdate({}, [status], attributes)).toEqual({
      status: { filterType: 'set', values: ['active'] },
    });
  });

  it('replaces a set filter that matches no row (R6)', () => {
    const current = {
      'attr:Device.take_home': { filterType: 'set', values: [] },
    };
    expect(filterModelUpdate(current, [], attributes)).toEqual({});
    expect(
      filterModelUpdate(
        current,
        [{ field: 'status', operator: 'is', values: ['active'] }],
        attributes,
      ),
    ).toEqual({ status: { filterType: 'set', values: ['active'] } });
  });

  it('gives the grid a set filter that matches no row (R6)', () => {
    expect(
      filterModelUpdate(
        {},
        [{ field: 'status', operator: 'is', values: [] }],
        attributes,
      ),
    ).toEqual({ status: { filterType: 'set', values: [] } });
  });
});
