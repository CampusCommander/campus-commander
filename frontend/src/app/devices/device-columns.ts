import type {
  AutoGroupColumnDef,
  CellKeyDownEvent,
  ColDef,
  FullWidthCellKeyDownEvent,
  IFilterOptionDef,
  IRowNode,
} from 'ag-grid-community';
import {
  DEVICE_UPDATE_FIELD_LABELS,
  type DeviceGroupField,
  type DeviceRow,
  type DeviceUpdateField,
} from '@campus/application-contracts';
import {
  BATTERY_LABELS,
  DEVICE_FIELDS,
  DEVICE_STATUS_LABELS,
  batteryText,
  groupLabel,
  relativeTime,
  statusText,
  type BatteryFilterValue,
  type DeviceField,
  type DeviceSortField,
  type DeviceStatusFilterValue,
} from './device-fields';
import { GroupCellRenderer } from '@libregrid/row-grouping';
import { DeviceDetailsCell } from './device-details-cell';
import { DeviceDraftCell } from './device-draft-cell';
import type { DeviceGridDraftEntry } from './device-grid-draft.store';
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
    case 'status':
      return statusText(row.status);
    case 'battery':
      return batteryText(row.battery);
    case 'lastContact':
      return relativeTime(row.lastContact, now);
    case 'annotatedLocation':
      return row.annotatedLocation ?? '';
    case 'annotatedUser':
      return row.annotatedUser ?? '';
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
    case 'status':
      return {
        filter: 'agSetColumnFilter',
        filterParams: {
          // Only the three contract values. The filter cannot select a null status.
          values: Object.keys(DEVICE_STATUS_LABELS),
          // Keep the record's order: Active, Disabled, Deprovisioned.
          suppressSorting: true,
          valueFormatter: ({ value }: { value: DeviceStatusFilterValue }) =>
            DEVICE_STATUS_LABELS[value],
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

/** The five editable grid columns and their update field (addendum section 5). */
export const GRID_UPDATE_FIELDS: Partial<
  Record<DeviceSortField, DeviceUpdateField>
> = {
  assetTag: 'annotatedAssetId',
  annotatedLocation: 'annotatedLocation',
  annotatedUser: 'annotatedUser',
  notes: 'notes',
  orgUnitPath: 'orgUnitPath',
};

/** The grid column that shows an update field. */
export function gridColumnFor(field: DeviceUpdateField): DeviceSortField {
  switch (field) {
    case 'annotatedAssetId':
      return 'assetTag';
    case 'annotatedLocation':
      return 'annotatedLocation';
    case 'annotatedUser':
      return 'annotatedUser';
    case 'notes':
      return 'notes';
    case 'orgUnitPath':
      return 'orgUnitPath';
  }
}

/** The draft state that the grid reads for one cell. The store owns the data. */
export interface DeviceDraftColumnOptions {
  editable: () => boolean;
  /** The Organization unit read is granted, so the unit column hint matches its state. */
  orgUnitEditable: () => boolean;
  value: (
    deviceId: string,
    field: DeviceUpdateField,
    rowValue: string,
  ) => string;
  entry: (
    deviceId: string,
    field: DeviceUpdateField,
  ) => DeviceGridDraftEntry | null;
  reason: (entry: DeviceGridDraftEntry) => string;
  onRevert: (deviceId: string, field: DeviceUpdateField) => void;
  onConflict: (
    deviceId: string,
    field: DeviceUpdateField,
    anchor: HTMLElement,
  ) => void;
}

/** The cell renderer, state rules, and editors of one editable column. */
function editableColumn(
  field: DeviceUpdateField,
  draft: DeviceDraftColumnOptions,
): Pick<
  ColDef<DeviceRow>,
  | 'cellRenderer'
  | 'cellRendererParams'
  | 'cellClassRules'
  | 'editable'
  | 'cellEditor'
  | 'cellEditorParams'
  | 'suppressKeyboardEvent'
> {
  const entryOf = (params: {
    data?: DeviceRow | null;
    node?: IRowNode<DeviceRow>;
  }): DeviceGridDraftEntry | null =>
    !params.data || params.node?.group
      ? null
      : draft.entry(params.data.deviceId, field);
  return {
    cellRenderer: DeviceDraftCell,
    cellRendererParams: {
      updateField: field,
      label: DEVICE_UPDATE_FIELD_LABELS[field],
      entryFor: (deviceId: string) => draft.entry(deviceId, field),
      reasonFor: (entry: DeviceGridDraftEntry) => draft.reason(entry),
      // The unit hint follows the read state, not only the page permissions (B4 note).
      editable: () =>
        draft.editable() &&
        (field !== 'orgUnitPath' || draft.orgUnitEditable()),
      onRevert: (deviceId: string) => draft.onRevert(deviceId, field),
      onConflict: (deviceId: string, anchor: HTMLElement) =>
        draft.onConflict(deviceId, field, anchor),
    },
    cellClassRules: {
      'device-draft-pending': (params) => entryOf(params)?.state === 'pending',
      'device-draft-invalid': (params) => entryOf(params)?.state === 'invalid',
      'device-draft-conflict': (params) =>
        entryOf(params)?.state === 'conflict',
    },
    // The picker opens on Enter, F2, or a double-click, so the unit column has no editor.
    editable: (params) =>
      field !== 'orgUnitPath' &&
      !params.node?.group &&
      !!params.data &&
      draft.editable(),
    // Shift+Enter reverts a pending cell while the cell rests. Suppress AG Grid's
    // default Enter edit, so the shortcut never opens an editor (review note).
    suppressKeyboardEvent: (params) =>
      field !== 'orgUnitPath' &&
      !params.editing &&
      params.event.key === 'Enter' &&
      params.event.shiftKey &&
      !!params.data &&
      !params.node?.group &&
      draft.entry(params.data.deviceId, field) !== null,
    ...(field === 'notes'
      ? {
          cellEditor: 'agLargeTextCellEditor',
          cellEditorParams: { maxLength: 1000, rows: 8, cols: 60 },
        }
      : field === 'orgUnitPath'
        ? {}
        : { cellEditor: 'agTextCellEditor' }),
  };
}

/** Every data column is read-only until the draft options make a column editable (GRID-05). */
export function deviceColumnDefs(
  onDetails: (row: DeviceRow, node: IRowNode<DeviceRow>) => void,
  options: {
    orgUnits?: () => readonly string[];
    now?: () => number;
    draft?: DeviceDraftColumnOptions;
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
    ...DEVICE_FIELDS.map((field): ColDef<DeviceRow> => {
      const updateField = GRID_UPDATE_FIELDS[field.id];
      return {
        colId: field.id,
        headerName: field.label,
        valueGetter: ({ data, node }) => {
          if (!data || node?.group) return '';
          const text = value(data, field.id, now());
          return updateField && options.draft
            ? options.draft.value(data.deviceId, updateField, text)
            : text;
        },
        enableRowGroup: groupable.has(field.id),
        sortable: true,
        ...columnFilter(field, orgUnits),
        hide: field.optional,
        cellClass: field.id === 'serialNumber' ? 'device-code' : undefined,
        ...(updateField && options.draft
          ? editableColumn(updateField, options.draft)
          : {}),
        ...(field.id === 'lastContact' ? staleContact : {}),
      };
    }),
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
