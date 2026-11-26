import { describe, expect, it, vi } from 'vitest';
import type { ColDef, ColGroupDef } from 'ag-grid-community';
import type { UserAttributeCategory } from '@campus/application-contracts';
import { UserDetailsCell } from './user-details-cell';
import { UserNameCell } from './user-name-cell';
import { userColumnDefs, attributeColumnsSignature } from './user-columns';
import { attributeColumns } from './user-fields';

const field = (
  fieldName: string,
  displayName: string,
  fieldType:
    | 'STRING'
    | 'INT64'
    | 'BOOL'
    | 'DATE'
    | 'DOUBLE'
    | 'EMAIL'
    | 'PHONE',
  multiValued = false,
) => ({
  fieldId: `Student.${fieldName}`,
  fieldName,
  displayName,
  fieldType,
  multiValued,
  indexed: true,
  readAccessType: 'ALL_DOMAIN_USERS' as const,
  numericIndexingSpec: null,
  holders: 120,
});

const category: UserAttributeCategory = {
  schemaId: 'schema-student',
  schemaName: 'Student',
  displayName: 'Student information',
  etag: '"schema-etag"',
  fields: [
    field('grade_level', 'Grade level', 'INT64'),
    field('programs', 'Programs', 'STRING', true),
  ],
  holders: 300,
  readAt: '2026-11-16T12:00:00.000Z',
};

const columns = () =>
  userColumnDefs({
    attributes: attributeColumns([category]),
    orgUnits: () => ['/Students/High School'],
  }) as (ColDef<never> | ColGroupDef<never>)[];

const flat = () =>
  columns().filter(
    (column): column is ColDef<never> => !('children' in column),
  );

describe('the users grid columns', () => {
  it('starts with the details column and keeps the Name column pinned', () => {
    const defs = flat();
    expect(defs[0].colId).toBe('details');
    expect(defs[0].cellRenderer).toBe(UserDetailsCell);
    const name = defs.find((column) => column.colId === 'fullName');
    expect(name?.pinned).toBe('left');
    expect(name?.lockPinned).toBe(true);
    expect(name?.headerName).toBe('Name');
  });

  it('starts the optional columns hidden', () => {
    const defs = flat();
    expect(defs.find((column) => column.colId === 'creationTime')?.hide).toBe(
      true,
    );
    expect(defs.find((column) => column.colId === 'department')?.hide).toBe(
      true,
    );
    expect(defs.find((column) => column.colId === 'title')?.hide).toBe(true);
    expect(defs.find((column) => column.colId === 'status')?.hide).toBeFalsy();
  });

  it('does not sort 2-step verification, which has no server sort field', () => {
    const defs = flat();
    expect(defs.find((column) => column.colId === 'twoStep')?.sortable).toBe(
      false,
    );
    expect(defs.find((column) => column.colId === 'fullName')?.sortable).toBe(
      true,
    );
  });

  it('groups the attribute columns under their category, hidden by default', () => {
    const group = columns().find(
      (column): column is ColGroupDef<never> => 'children' in column,
    );
    expect(group?.headerName).toBe('Student information');
    expect(group?.groupId).toBe('cat:Student');
    expect(group?.openByDefault).toBe(true);
    const children = (group?.children ?? []) as ColDef<never>[];
    expect(children.map((child) => child.colId)).toEqual([
      'attr:Student.grade_level',
      'attr:Student.programs',
    ]);
    expect(children.every((child) => child.hide === true)).toBe(true);
    expect(children.every((child) => child.sortable === false)).toBe(true);
  });

  it('shows a stale name muted', () => {
    const name = flat().find((column) => column.colId === 'fullName');
    const rule = name?.cellClassRules?.['user-stale'] as unknown as (params: {
      data: { stale: boolean };
    }) => boolean;
    expect(rule({ data: { stale: true } })).toBe(true);
    expect(rule({ data: { stale: false } })).toBe(false);
  });

  it('gives the details column the control that opens a user', () => {
    const onDetails = vi.fn();
    const defs = userColumnDefs({ onDetails }) as (
      | ColDef<never>
      | ColGroupDef<never>
    )[];
    const details = defs.find(
      (column): column is ColDef<never> => !('children' in column),
    );
    expect(details?.cellRendererParams).toEqual({ onDetails });
  });

  it('renders the Name cell as the link to the details page', () => {
    const onOpen = vi.fn();
    const defs = userColumnDefs({ onOpen }) as (
      | ColDef<never>
      | ColGroupDef<never>
    )[];
    const name = defs.find(
      (column): column is ColDef<never> =>
        !('children' in column) && column.colId === 'fullName',
    );
    expect(name?.cellRenderer).toBe(UserNameCell);
    expect(name?.cellRendererParams).toEqual({ onOpen });
  });

  it('keys the editor rebuild on the editor facts, not only the ID (R1-E)', () => {
    const base = attributeColumns([category]);
    const same = attributeColumns([category]);
    const renamed = attributeColumns([
      {
        ...category,
        fields: [
          { ...category.fields[0]!, displayName: 'Grade' },
          category.fields[1]!,
        ],
      },
    ]);
    expect(attributeColumnsSignature(same)).toBe(
      attributeColumnsSignature(base),
    );
    // A category job keeps the ID and can rename the field. The closures must rebuild.
    expect(attributeColumnsSignature(renamed)).not.toBe(
      attributeColumnsSignature(base),
    );
  });

  it('offers Clear value beside Yes and No (R1-G)', () => {
    const boolColumns = attributeColumns([
      {
        ...category,
        fields: [field('take_home', 'Take-home approved', 'BOOL')],
      },
    ]);
    const defs = userColumnDefs({
      attributes: boolColumns,
      draft: {
        editable: () => true,
        value: () => '',
        entry: () => null,
        reason: () => '',
        onRevert: vi.fn(),
      },
    }) as (ColDef<never> | ColGroupDef<never>)[];
    const group = defs.find(
      (column): column is ColGroupDef<never> =>
        'children' in column && column.groupId === 'cat:Student',
    );
    const editor = group?.children?.find(
      (column) => (column as ColDef<never>).colId === 'attr:Student.take_home',
    ) as ColDef<never> | undefined;
    expect(editor?.cellEditorParams).toEqual({
      values: ['Yes', 'No', 'Clear value'],
    });
  });
});
