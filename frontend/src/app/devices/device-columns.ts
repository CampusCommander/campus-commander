import type {
  CellKeyDownEvent,
  ColDef,
  FullWidthCellKeyDownEvent,
  IFilterOptionDef,
} from 'ag-grid-community';
import type { DeviceRow } from '@campus/application-contracts';
import {
  BATTERY_LABELS,
  DEVICE_FIELDS,
  batteryText,
  relativeTime,
  type BatteryFilterValue,
  type DeviceField,
  type DeviceSortField,
} from './device-fields';
import { DeviceDetailsCell } from './device-details-cell';
import { orgUnitTreePath } from './device-filter-model';

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

const filterButtons = { buttons: ['apply', 'reset'], closeOnApply: true };
/** The device query applies these filters. Rows the grid holds already match. */
const serverSide = () => true;
const dateOptions: IFilterOptionDef[] = [
  {
    displayKey: 'before',
    displayName: 'Before',
    predicate: serverSide,
    numberOfInputs: 1,
  },
  {
    displayKey: 'after',
    displayName: 'On or after',
    predicate: serverSide,
    numberOfInputs: 1,
  },
];

function columnFilter(
  field: DeviceField,
  orgUnits: () => readonly string[],
): Pick<ColDef<DeviceRow>, 'filter' | 'filterParams'> {
  switch (field.kind) {
    case 'text':
      return {
        filter: 'agTextColumnFilter',
        filterParams: {
          filterOptions: ['contains', 'startsWith', 'equals', 'blank'],
          maxNumConditions: 1,
          trimInput: true,
          ...filterButtons,
        },
      };
    case 'date':
      return {
        filter: 'agDateColumnFilter',
        filterParams: {
          filterOptions: dateOptions,
          maxNumConditions: 1,
          ...filterButtons,
        },
      };
    case 'battery':
      return {
        filter: 'agSetColumnFilter',
        filterParams: {
          values: Object.keys(BATTERY_LABELS),
          // Keep the order of the chip editor: health classes, then missing data.
          suppressSorting: true,
          valueFormatter: ({ value }: { value: BatteryFilterValue }) =>
            BATTERY_LABELS[value],
          ...filterButtons,
        },
      };
    case 'orgUnit':
      return {
        filter: 'agSetColumnFilter',
        filterParams: {
          values: (params: { success: (values: string[]) => void }) =>
            params.success([...orgUnits()]),
          refreshValuesOnOpen: true,
          treeList: true,
          treeListPathGetter: orgUnitTreePath,
          treeListFormatter: (key: string | null, level: number) =>
            level === 0 ? 'All organization units' : (key ?? ''),
          ...filterButtons,
        },
      };
  }
}

/** Every data column is read-only in this slice (GRID-05). */
export function deviceColumnDefs(
  onDetails: (row: DeviceRow, index: number) => void,
  options: {
    orgUnits?: () => readonly string[];
    now?: () => number;
  } = {},
): ColDef<DeviceRow>[] {
  const now = options.now ?? Date.now;
  const orgUnits = options.orgUnits ?? (() => []);
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
      filter: false,
      suppressHeaderMenuButton: true,
      suppressColumnsToolPanel: true,
      suppressFiltersToolPanel: true,
    },
    ...DEVICE_FIELDS.map(
      (field): ColDef<DeviceRow> => ({
        colId: field.id,
        headerName: field.label,
        valueGetter: ({ data }) => (data ? value(data, field.id, now()) : ''),
        sortable: true,
        ...columnFilter(field, orgUnits),
        hide: field.optional,
        cellClass: field.id === 'serialNumber' ? 'device-code' : undefined,
      }),
    ),
  ];
}

/** Enter on a focused details cell opens the device. Space toggles row selection (UI-09). */
export function detailsKeyHandler(
  onDetails: (row: DeviceRow, index: number) => void,
) {
  return (
    event: CellKeyDownEvent<DeviceRow> | FullWidthCellKeyDownEvent<DeviceRow>,
  ): void => {
    const keyboard = event.event as KeyboardEvent | null | undefined;
    if (!('column' in event) || event.column.getColId() !== 'details') return;
    if (keyboard?.key !== 'Enter') return;
    if (!event.data || event.rowIndex === null) return;
    keyboard.preventDefault();
    onDetails(event.data, event.rowIndex);
  };
}
