import type { ColDef } from 'ag-grid-community';
import type { DeviceRow } from '@campus/application-contracts';
import { deviceColumnDefs } from './device-columns';
import { DeviceDraftCell } from './device-draft-cell';

const row = (stale: boolean): DeviceRow => ({
  deviceId: 'd1',
  serialNumber: 'C0A1-0000',
  model: null,
  assetTag: null,
  orgUnitPath: '/',
  lastContact: '2026-10-05T12:00:00.000Z',
  annotatedLocation: null,
  annotatedUser: null,
  notes: null,
  status: 'ACTIVE',
  battery: { status: 'no-report' },
  lastEntitySync: '2026-10-04T12:00:00.000Z',
  stale,
});

const columns = () => deviceColumnDefs(() => undefined);
const rule = (column: ColDef<DeviceRow>) =>
  (
    column.cellClassRules as
      | Record<string, (params: unknown) => boolean>
      | undefined
  )?.['device-stale'];

it('mutes the contact time of a stale row and explains it', () => {
  const contact = columns().find((column) => column.colId === 'lastContact')!;
  const stale = rule(contact)!;
  expect(stale({ data: row(true), node: { group: false } })).toBe(true);
  expect(stale({ data: row(false), node: { group: false } })).toBe(false);
  expect(stale({ data: { key: '/', devices: 3 }, node: { group: true } })).toBe(
    false,
  );
  const tooltip = contact.tooltipValueGetter!;
  expect(tooltip({ data: row(true), node: { group: false } } as never)).toBe(
    'Refreshing from Google',
  );
  expect(
    tooltip({ data: row(false), node: { group: false } } as never),
  ).toBeUndefined();
});

it('mutes no other column', () => {
  const others = columns().filter((column) => column.colId !== 'lastContact');
  expect(others.every((column) => rule(column) === undefined)).toBe(true);
});

it('offers Status as a hidden column directly after Serial', () => {
  const list = columns();
  const ids = list.map((column) => column.colId);
  expect(ids.indexOf('status')).toBe(ids.indexOf('serialNumber') + 1);
  const status = list.find((column) => column.colId === 'status')!;
  expect(status.headerName).toBe('Status');
  expect(status.hide).toBe(true);
  expect(status.sortable).toBe(true);
  expect(status.suppressColumnsToolPanel).not.toBe(true);
});

const statusValue = (status: string | null): string => {
  const column = columns().find((candidate) => candidate.colId === 'status')!;
  const getter = column.valueGetter as (params: unknown) => string;
  return getter({ data: { ...row(false), status }, node: { group: false } });
};

it('shows the three Google statuses as labels and any other value as Google sends it', () => {
  expect(statusValue('ACTIVE')).toBe('Active');
  expect(statusValue('DISABLED')).toBe('Disabled');
  expect(statusValue('DEPROVISIONED')).toBe('Deprovisioned');
  expect(statusValue('RETIRED')).toBe('RETIRED');
  expect(statusValue(null)).toBe('');
});

it('offers the optional Annotated user text column directly after Asset tag', () => {
  const list = columns();
  const ids = list.map((column) => column.colId);
  expect(ids.indexOf('annotatedUser')).toBe(ids.indexOf('assetTag') + 1);
  const column = list.find((candidate) => candidate.colId === 'annotatedUser')!;
  expect(column.headerName).toBe('Annotated user');
  expect(column.hide).toBe(true);
  expect(column.sortable).toBe(true);
  expect(column.filter).toBe('agTextColumnFilter');
  const params = column.filterParams as {
    filterOptions: string[];
    maxNumConditions: number;
  };
  expect(params.filterOptions).toEqual([
    'contains',
    'startsWith',
    'equals',
    'blank',
  ]);
  expect(params.maxNumConditions).toBe(1);
  const getter = column.valueGetter as (params: unknown) => string;
  expect(
    getter({
      data: { ...row(false), annotatedUser: 'maya.chen@example.org' },
      node: { group: false },
    }),
  ).toBe('maya.chen@example.org');
  expect(getter({ data: row(false), node: { group: false } })).toBe('');
});

it('filters status with the three contract values in the record order', () => {
  const status = columns().find((column) => column.colId === 'status')!;
  expect(status.filter).toBe('agSetColumnFilter');
  const params = status.filterParams as {
    values: string[];
    suppressSorting: boolean;
    valueFormatter: (params: { value: string }) => string;
  };
  expect(params.values).toEqual(['ACTIVE', 'DISABLED', 'DEPROVISIONED']);
  expect(params.suppressSorting).toBe(true);
  expect(params.valueFormatter({ value: 'DEPROVISIONED' })).toBe(
    'Deprovisioned',
  );
});

it('keeps every column read-only without the draft options', () => {
  expect(columns().some((column) => column.cellEditor)).toBe(false);
  expect(
    columns().find((column) => column.colId === 'assetTag')!.cellRenderer,
  ).toBeUndefined();
});

it('gives the five draft columns their editors, renderer, and state rules', () => {
  const draft = {
    editable: () => true,
    value: (deviceId: string, field: string, fallback: string) =>
      field === 'annotatedAssetId' && deviceId === 'd1' ? 'CB-DRAFT' : fallback,
    entry: (_deviceId: string, field: string) =>
      ({ state: field === 'notes' ? 'invalid' : 'pending' }) as never,
    reason: () => 'Notes holds 1 to 500 characters.',
    onRevert: () => undefined,
    onConflict: () => undefined,
  };
  const list = deviceColumnDefs(() => undefined, { draft });
  const column = (id: string) => list.find((item) => item.colId === id)!;
  expect(column('assetTag').cellEditor).toBe('agTextCellEditor');
  expect(column('annotatedLocation').cellEditor).toBe('agTextCellEditor');
  expect(column('annotatedUser').cellEditor).toBe('agTextCellEditor');
  expect(column('notes').cellEditor).toBe('agLargeTextCellEditor');
  for (const id of [
    'assetTag',
    'annotatedLocation',
    'annotatedUser',
    'notes',
    'orgUnitPath',
  ])
    expect(column(id).cellRenderer).toBe(DeviceDraftCell);
  expect(column('orgUnitPath').cellEditor).toBeUndefined();
  expect(column('serialNumber').cellEditor).toBeUndefined();
  expect(column('serialNumber').cellRenderer).toBeUndefined();

  const editable = column('assetTag').editable as (params: unknown) => boolean;
  expect(editable({ data: row(false), node: { group: false } })).toBe(true);
  expect(editable({ data: row(false), node: { group: true } })).toBe(false);
  expect(
    (column('orgUnitPath').editable as (params: unknown) => boolean)({
      data: row(false),
      node: { group: false },
    }),
  ).toBe(false);

  const getter = column('assetTag').valueGetter as (params: unknown) => string;
  expect(getter({ data: row(false), node: { group: false } })).toBe('CB-DRAFT');
  expect(getter({ data: row(false), node: { group: true } })).toBe('');

  const rules = column('notes').cellClassRules as Record<
    string,
    (params: unknown) => boolean
  >;
  expect(rules['device-draft-invalid']({ data: row(false), node: {} })).toBe(
    true,
  );
  expect(rules['device-draft-pending']({ data: row(false), node: {} })).toBe(
    false,
  );
});
