import { describe, expect, it, vi } from 'vitest';
import type { IServerSideGetRowsParams } from 'ag-grid-community';
import type {
  UserAttributeCategory,
  UserRow,
} from '@campus/application-contracts';
import { pendingUserDatasource, userDatasource } from './user-datasource';
import { attributeColumns } from './user-fields';

const category: UserAttributeCategory = {
  schemaId: 'schema-device',
  schemaName: 'Device',
  displayName: 'Device information',
  etag: '"device-etag"',
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
      holders: 4,
    },
  ],
  holders: 4,
  readAt: '2026-11-16T10:00:00.000Z',
};
const attributes = attributeColumns([category]);
const takeHome = attributes[0];

const page = {
  rows: [
    {
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
      lastEntitySync: '2026-11-16T10:00:00.000Z',
      stale: false,
      recordVersion: 1,
    },
  ],
  matching: 1,
  total: 6,
  observedAt: '2026-11-16T10:00:00.000Z',
  refreshJobId: null,
};

function request(filterModel: unknown) {
  const success = vi.fn();
  const fail = vi.fn();
  return {
    params: {
      request: { startRow: 0, endRow: 100, filterModel, sortModel: [] },
      api: { getGridOption: () => false },
      success,
      fail,
    } as unknown as IServerSideGetRowsParams<UserRow>,
    success,
    fail,
  };
}

describe('the users datasource', () => {
  it('sends the filter-only chips beside the grid filters (R4)', async () => {
    const load = vi.fn().mockResolvedValue(page);
    const { params, success } = request({
      fullName: { filterType: 'text', type: 'contains', filter: 'A' },
    });
    userDatasource(
      load,
      undefined,
      undefined,
      () => attributes,
      () => [{ field: 'aliases', operator: 'contains', value: 'a.brooks' }],
    ).getRows(params);
    await vi.waitFor(() => expect(success).toHaveBeenCalled());
    expect(load).toHaveBeenCalledWith(0, 100, {
      predicates: [
        { field: 'fullName', operator: 'contains', value: 'A' },
        { field: 'aliases', operator: 'contains', value: 'a.brooks' },
      ],
      sort: { field: 'fullName', direction: 'asc' },
      selection: null,
    });
    expect(success).toHaveBeenCalledWith({
      rowData: page.rows,
      rowCount: 1,
    });
  });

  it('sends a has-a-value chip with the grid filters (R4)', async () => {
    const load = vi.fn().mockResolvedValue(page);
    const { params } = request({
      status: { filterType: 'set', values: ['active'] },
    });
    userDatasource(
      load,
      undefined,
      undefined,
      () => attributes,
      () => [
        {
          field: 'attribute',
          schemaName: 'Device',
          fieldName: 'take_home',
          operator: 'hasValue',
        },
      ],
    ).getRows(params);
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    expect(load.mock.calls[0][2].predicates).toEqual([
      { field: 'status', operator: 'is', values: ['active'] },
      {
        field: 'attribute',
        schemaName: 'Device',
        fieldName: 'take_home',
        operator: 'hasValue',
      },
    ]);
  });

  it('shows an empty page for a set filter with no values (R6)', () => {
    const load = vi.fn();
    const unmatchable = vi.fn();
    const { params, success, fail } = request({
      [takeHome.id]: { filterType: 'set', values: [] },
    });
    userDatasource(
      load,
      undefined,
      undefined,
      () => attributes,
      () => [],
      unmatchable,
    ).getRows(params);
    expect(load).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(unmatchable).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith({ rowData: [], rowCount: 0 });
  });

  it('keeps the false value of a boolean set filter (R6)', async () => {
    const load = vi.fn().mockResolvedValue(page);
    const unmatchable = vi.fn();
    const { params } = request({
      [takeHome.id]: { filterType: 'set', values: ['false'] },
    });
    userDatasource(
      load,
      undefined,
      undefined,
      () => attributes,
      () => [],
      unmatchable,
    ).getRows(params);
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    expect(unmatchable).not.toHaveBeenCalled();
    expect(load.mock.calls[0][2].predicates).toEqual([
      {
        field: 'attribute',
        schemaName: 'Device',
        fieldName: 'take_home',
        operator: 'is',
        value: false,
      },
    ]);
  });

  it('fails the load for a model that no query can express', () => {
    const load = vi.fn();
    const { params, success, fail } = request({
      status: 'not a filter model',
    });
    userDatasource(load).getRows(params);
    expect(load).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalled();
  });
});

describe('the pending users datasource (design K26)', () => {
  function pendingRequest(
    startRow: number,
    endRow: number,
    sortModel: { colId: string; sort: 'asc' | 'desc' }[] = [],
  ) {
    const success = vi.fn();
    const fail = vi.fn();
    return {
      params: {
        request: { startRow, endRow, filterModel: undefined, sortModel },
        api: { getGridOption: () => false },
        success,
        fail,
      } as unknown as IServerSideGetRowsParams<UserRow>,
      success,
      fail,
    };
  }

  function pendingRow(userId: string, fullName: string | null): UserRow {
    return {
      ...page.rows[0]!,
      userId,
      fullName,
      primaryEmail: `${userId}@example.org`,
    };
  }

  it('reads the whole view once and pages the answer in the browser', async () => {
    const rows = [
      pendingRow('1100000000000000003', 'Cara Diaz'),
      pendingRow('1100000000000000001', 'Amara Okafor'),
      pendingRow('1100000000000000002', 'Bo Ellis'),
    ];
    const load = vi.fn().mockResolvedValue(rows);
    const source = pendingUserDatasource(load);
    const first = pendingRequest(0, 2);
    source.getRows(first.params);
    await vi.waitFor(() => expect(first.success).toHaveBeenCalled());
    expect(load).toHaveBeenCalledTimes(1);
    expect(first.success.mock.calls[0][0]).toEqual({
      rowData: [rows[1], rows[2]],
      rowCount: 3,
    });
    const second = pendingRequest(2, 100);
    source.getRows(second.params);
    await vi.waitFor(() => expect(second.success).toHaveBeenCalled());
    // One read answers every page.
    expect(load).toHaveBeenCalledTimes(1);
    expect(second.success.mock.calls[0][0]).toEqual({
      rowData: [rows[0]],
      rowCount: 3,
    });
  });

  it('sorts by the active column and keeps a missing name last', async () => {
    const rows = [
      pendingRow('1100000000000000001', null),
      pendingRow('1100000000000000002', 'Bo Ellis'),
      pendingRow('1100000000000000003', 'Amara Okafor'),
    ];
    const source = pendingUserDatasource(vi.fn().mockResolvedValue(rows));
    const { params, success } = pendingRequest(0, 100, [
      { colId: 'fullName', sort: 'asc' },
    ]);
    source.getRows(params);
    await vi.waitFor(() => expect(success).toHaveBeenCalled());
    expect(
      (success.mock.calls[0][0] as { rowData: UserRow[] }).rowData.map(
        (row) => row.userId,
      ),
    ).toEqual([
      '1100000000000000003',
      '1100000000000000002',
      '1100000000000000001',
    ]);
  });

  it('sorts a descending answer and then by user ID', async () => {
    const rows = [
      pendingRow('1100000000000000001', 'Amara Okafor'),
      pendingRow('1100000000000000002', 'Amara Okafor'),
      pendingRow('1100000000000000003', 'Bo Ellis'),
    ];
    const source = pendingUserDatasource(vi.fn().mockResolvedValue(rows));
    const { params, success } = pendingRequest(0, 100, [
      { colId: 'fullName', sort: 'desc' },
    ]);
    source.getRows(params);
    await vi.waitFor(() => expect(success).toHaveBeenCalled());
    expect(
      (success.mock.calls[0][0] as { rowData: UserRow[] }).rowData.map(
        (row) => row.userId,
      ),
    ).toEqual([
      '1100000000000000003',
      '1100000000000000002',
      '1100000000000000001',
    ]);
  });

  it('fails the view when the read fails', async () => {
    const source = pendingUserDatasource(vi.fn().mockResolvedValue(null));
    const { params, success, fail } = pendingRequest(0, 100);
    source.getRows(params);
    await vi.waitFor(() => expect(fail).toHaveBeenCalled());
    expect(success).not.toHaveBeenCalled();
  });

  it('applies a newer observation to the next page', async () => {
    const rows = [
      pendingRow('1100000000000000001', 'Amara Okafor'),
      pendingRow('1100000000000000002', 'Bo Ellis'),
    ];
    const source = pendingUserDatasource(vi.fn().mockResolvedValue(rows));
    const first = pendingRequest(0, 100);
    source.getRows(first.params);
    await vi.waitFor(() => expect(first.success).toHaveBeenCalled());
    source.update([{ ...rows[0]!, fullName: 'Zara Okafor' }]);
    const second = pendingRequest(0, 100, [{ colId: 'fullName', sort: 'asc' }]);
    source.getRows(second.params);
    await vi.waitFor(() => expect(second.success).toHaveBeenCalled());
    expect(
      (second.success.mock.calls[0][0] as { rowData: UserRow[] }).rowData.map(
        (row) => row.fullName,
      ),
    ).toEqual(['Bo Ellis', 'Zara Okafor']);
  });
});
