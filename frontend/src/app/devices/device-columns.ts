import type { ColDef } from 'ag-grid-community';
import type { DeviceRow } from '@campus/application-contracts';
import {
  DEVICE_FIELDS,
  batteryText,
  relativeTime,
  type DeviceSortField,
} from './device-fields';
import { DeviceDetailsCell } from './device-details-cell';

function value(row: DeviceRow, field: DeviceSortField, now: number): string {
  switch (field) {
    case 'serialNumber':
      return row.serialNumber;
    case 'model':
      return row.model ?? '';
    case 'assetTag':
      return row.assetTag ?? '';
    case 'orgUnitPath':
      return row.orgUnitPath;
    case 'battery':
      return batteryText(row.battery);
    case 'lastContact':
      return relativeTime(row.lastContact, now);
    case 'annotatedLocation':
      return row.annotatedLocation ?? '';
    case 'notes':
      return row.notes ?? '';
  }
}

/** Every data column is read-only in this slice (GRID-05). */
export function deviceColumnDefs(
  onDetails: (row: DeviceRow, index: number) => void,
  now: () => number = Date.now,
): ColDef<DeviceRow>[] {
  return [
    {
      colId: 'details',
      headerName: 'Details',
      headerClass: 'device-details-header',
      width: 56,
      minWidth: 56,
      maxWidth: 56,
      pinned: 'left',
      lockVisible: true,
      suppressMovable: true,
      sortable: false,
      resizable: false,
      cellRenderer: DeviceDetailsCell,
      cellRendererParams: { onDetails },
    },
    ...DEVICE_FIELDS.map(
      (field): ColDef<DeviceRow> => ({
        colId: field.id,
        headerName: field.label,
        valueGetter: ({ data }) => (data ? value(data, field.id, now()) : ''),
        sortable: true,
        hide: field.optional,
        cellClass: field.id === 'serialNumber' ? 'device-code' : undefined,
      }),
    ),
  ];
}
