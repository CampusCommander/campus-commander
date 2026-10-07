import type {
  AutoGroupColumnDef,
  CellKeyDownEvent,
  ColDef,
  FullWidthCellKeyDownEvent,
  IFilterOptionDef,
  IRowNode,
} from 'ag-grid-community';
import type {
  DeviceGroupField,
  DeviceRow,
} from '@campus/application-contracts';
import {
  BATTERY_LABELS,
  DEVICE_FIELDS,
  batteryText,
  groupLabel,
  relativeTime,
  type BatteryFilterValue,
  type DeviceField,
  type DeviceSortField,
} from './device-fields';
import { GroupCellRenderer } from '@libregrid/row-grouping';
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

const groupable = new Set<string>(['orgUnitPath', 'model', 'battery']);

/** Group rows carry the key and device count from the group request. */
interface DeviceGroupRow {
  key: string;
  devices: number;
}

type GroupCellParams = Parameters<GroupCellRenderer['init']>[0];

/** A group row's label and device count, such as "Replace soon (135)". */
function groupText(params: GroupCellParams): unknown {
  const { node, data } = params;
  if (!node?.group || !data || !node.field) return params.value;
  const group = data as unknown as DeviceGroupRow;
  return `${groupLabel(node.field as DeviceGroupField, group.key)} (${group.devices.toLocaleString('en-US')})`;
}
const labelled = (params: GroupCellParams): GroupCellParams => ({
  ...params,
  value: groupText(params),
});

/**
 * LibreGrid's group cell shows the raw group key, and AG Grid formats group values
 * with the grouped column. This cell shows the group's label and device count.
 */
export class DeviceGroupCell extends GroupCellRenderer {
  override init(params: GroupCellParams): void {
    super.init(labelled(params));
  }

  override refresh(params: GroupCellParams): boolean {
    return super.refresh(labelled(params));
  }
}

/** The group column shows each group's label and device count. */
export const deviceGroupColumn: AutoGroupColumnDef<DeviceRow> = {
  headerName: 'Group',
  minWidth: 260,
  // Pinned with the checkbox, so a group row's label and checkbox share one row element.
  pinned: 'left',
  sortable: false,
  filter: false,
  cellRenderer: DeviceGroupCell,
  // The label carries the server count. Loaded children would undercount.
  cellRendererParams: { suppressCount: true },
};

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

/** A stale row shows its contact time muted until the refresh lands (D11). */
const staleContact: Pick<
  ColDef<DeviceRow>,
  'cellClassRules' | 'tooltipValueGetter'
> = {
  cellClassRules: {
    'device-stale': ({ data, node }) =>
      !!data && !node?.group && data.stale === true,
  },
  tooltipValueGetter: ({ data, node }) =>
    data && !node?.group && data.stale ? 'Refreshing from Google' : undefined,
};

/** Every data column is read-only in this slice (GRID-05). */
export function deviceColumnDefs(
  onDetails: (row: DeviceRow, node: IRowNode<DeviceRow>) => void,
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
      // GRID-03: the details icon stays right after the checkbox, before a group column.
      lockPosition: 'left',
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
        valueGetter: ({ data, node }) =>
          data && !node?.group ? value(data, field.id, now()) : '',
        enableRowGroup: groupable.has(field.id),
        sortable: true,
        ...columnFilter(field, orgUnits),
        hide: field.optional,
        cellClass: field.id === 'serialNumber' ? 'device-code' : undefined,
        ...(field.id === 'lastContact' ? staleContact : {}),
      }),
    ),
  ];
}

/** Enter on a focused details cell opens the device. Space toggles row selection (UI-09). */
export function detailsKeyHandler(
  onDetails: (row: DeviceRow, node: IRowNode<DeviceRow>) => void,
) {
  return (
    event: CellKeyDownEvent<DeviceRow> | FullWidthCellKeyDownEvent<DeviceRow>,
  ): void => {
    const keyboard = event.event as KeyboardEvent | null | undefined;
    if (!('column' in event) || event.column.getColId() !== 'details') return;
    if (keyboard?.key !== 'Enter') return;
    if (!event.data || event.node.group) return;
    keyboard.preventDefault();
    onDetails(event.data, event.node);
  };
}
