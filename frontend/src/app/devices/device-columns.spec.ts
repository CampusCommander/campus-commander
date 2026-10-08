import type { ColDef } from 'ag-grid-community';
import type { DeviceRow } from '@campus/application-contracts';
import { deviceColumnDefs } from './device-columns';

const row = (stale: boolean): DeviceRow => ({
  deviceId: 'd1',
  serialNumber: 'C0A1-0000',
  model: null,
  assetTag: null,
  orgUnitPath: '/',
  lastContact: '2026-10-05T12:00:00.000Z',
  annotatedLocation: null,
  notes: null,
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
