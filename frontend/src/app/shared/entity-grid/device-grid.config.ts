import type { EntityGridConfig, EntityGridColumn } from './entity-grid-config';

/**
 * Device row for the entity grid bridge. Field set and column order follow
 * docs/ui/entity-grid-fields.json. Resolve logical field IDs through the
 * qualified API schema before wiring a page.
 */
export interface DeviceGridRow {
  stableEntityId: string;
  serial: string;
  model: string;
  assetTag: string | null;
  school: string;
  orgUnitPath: string;
  batteryClassification: string | null;
  deviceContact: string | null;
  annotatedLocation: string | null;
  notes: string | null;
}

/**
 * Data columns in the contract order: serial, model, asset tag, school,
 * organization unit, battery, device contact. Annotated location and notes
 * stay available but hidden by default.
 */
export const DEVICE_GRID_COLUMNS: EntityGridColumn<DeviceGridRow>[] = [
  {
    fieldId: 'serial',
    label: 'Serial',
    dataType: 'text',
    inGridEditor: null,
    filterable: true,
    code: true,
    value: (row) => row.serial,
  },
  {
    fieldId: 'model',
    label: 'Model',
    dataType: 'text',
    inGridEditor: null,
    filterable: true,
    value: (row) => row.model,
  },
  {
    fieldId: 'assetTag',
    label: 'Asset tag',
    dataType: 'text',
    inGridEditor: 'text',
    filterable: true,
    value: (row) => row.assetTag,
  },
  {
    fieldId: 'school',
    label: 'School',
    dataType: 'text',
    inGridEditor: null,
    filterable: true,
    value: (row) => row.school,
  },
  {
    fieldId: 'orgUnit',
    label: 'Organization unit',
    dataType: 'orgUnit',
    inGridEditor: 'orgUnitTree',
    filterable: true,
    value: (row) => row.orgUnitPath,
  },
  {
    fieldId: 'batteryClassification',
    label: 'Battery',
    dataType: 'enum',
    inGridEditor: null,
    filterable: true,
    value: (row) => row.batteryClassification,
  },
  {
    fieldId: 'deviceContact',
    label: 'Device contact',
    dataType: 'dateTime',
    inGridEditor: null,
    filterable: true,
    value: (row) => row.deviceContact,
  },
  {
    fieldId: 'annotatedLocation',
    label: 'Annotated location',
    dataType: 'text',
    inGridEditor: 'text',
    filterable: true,
    defaultVisible: false,
    value: (row) => row.annotatedLocation,
  },
  {
    fieldId: 'notes',
    label: 'Notes',
    dataType: 'text',
    inGridEditor: 'multilineText',
    filterable: true,
    defaultVisible: false,
    value: (row) => row.notes,
  },
];

export function createDeviceGridConfig(): EntityGridConfig<DeviceGridRow> {
  return {
    gridId: 'devices',
    columns: DEVICE_GRID_COLUMNS,
    getRowId: (row) => row.stableEntityId,
    entityLabel: (row) => row.serial,
    bulkActions: [
      { id: 'import', label: 'Import' },
      { id: 'export', label: 'Export' },
      { id: 'update', label: 'Update' },
      { id: 'send-command', label: 'Send command' },
      { id: 'change-status', label: 'Change status' },
    ],
  };
}
