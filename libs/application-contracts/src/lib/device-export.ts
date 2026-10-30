import * as z from 'zod';
import {
  batteryFilterValueSchema,
  deviceSelectionKeySchema,
  deviceSortFieldSchema,
  deviceStatusFilterValueSchema,
  type DeviceBattery,
  type DeviceRow,
} from './devices';
import {
  JOB_EXPORT_FILE_FORMATS,
  jobDisplayIdSchema,
  jobExportFileFormatSchema,
  jobExportPurposeSchema,
} from './jobs';
import type {
  JobDisplayId,
  JobExportFileFormat,
  JobExportPurpose,
} from './jobs';

const count = z.number().int().min(0);

/**
 * The export contracts of the device export and import workflow
 * (`docs/superpowers/specs/2026-10-28-device-export-import-design.md`, sections 1 and 5).
 *
 * An export writes the edit template or the visible grid columns. This module holds the request,
 * the receipt, the report field IDs and their labels, and the file cell text. The template rules
 * stay in `device-edit-template.ts`, and no other module copies them.
 */

/** The two export formats of the Drive slice (design section 1). The job answer names the same two
 * (`JOB_EXPORT_FILE_FORMATS`), so a request and a job never differ. */
export const DEVICE_EXPORT_FORMATS = JOB_EXPORT_FILE_FORMATS;
export const deviceExportFormatSchema = jobExportFileFormatSchema;
export type DeviceExportFormat = JobExportFileFormat;

/**
 * The ten report field IDs, in the order of the device contract. A report request lists the IDs of
 * the visible grid columns in grid order (design section 5).
 */
export const deviceReportFieldIdSchema = deviceSortFieldSchema;
export type DeviceReportFieldId = z.infer<typeof deviceReportFieldIdSchema>;
export const DEVICE_REPORT_FIELD_IDS: readonly DeviceReportFieldId[] =
  deviceSortFieldSchema.options;

/** The header text of each report column. The grid shows the same words, so one copy serves both. */
export const DEVICE_REPORT_FIELD_LABELS: Readonly<
  Record<DeviceReportFieldId, string>
> = Object.freeze({
  serialNumber: 'Serial',
  status: 'Status',
  model: 'Model',
  assetTag: 'Asset tag',
  annotatedUser: 'Annotated user',
  orgUnitPath: 'Organization unit',
  battery: 'Battery',
  lastContact: 'Device contact',
  annotatedLocation: 'Annotated location',
  notes: 'Notes',
});

export type BatteryFilterValue = z.infer<typeof batteryFilterValueSchema>;

/** The battery text of the grid and of a report cell (design section 5). */
export const BATTERY_LABELS: Readonly<Record<BatteryFilterValue, string>> =
  Object.freeze({
    normal: 'Normal',
    'replace-soon': 'Replace soon',
    'replace-now': 'Replace now',
    'no-report': 'No battery report',
    unavailable: 'Unavailable',
  });

export type DeviceStatusFilterValue = z.infer<
  typeof deviceStatusFilterValueSchema
>;

/** The three known Google device states read as labels. */
export const DEVICE_STATUS_LABELS: Readonly<
  Record<DeviceStatusFilterValue, string>
> = Object.freeze({
  ACTIVE: 'Active',
  DISABLED: 'Disabled',
  DEPROVISIONED: 'Deprovisioned',
});

/** The battery text of a device row. */
export function batteryText(battery: DeviceBattery): string {
  return battery.status === 'reported'
    ? BATTERY_LABELS[battery.health]
    : BATTERY_LABELS[battery.status];
}

/**
 * The three known Google states read as labels. Another Google value shows as Google sends it.
 * A null status shows the grid's empty value.
 */
export function statusText(status: string | null): string {
  if (status === null) return '';
  const labels: Readonly<Record<string, string>> = DEVICE_STATUS_LABELS;
  return labels[status] ?? status;
}

/**
 * One report cell (design section 5). Every field holds the grid text except Device contact, which
 * writes an ISO 8601 UTC time, because a relative time in a file goes stale.
 */
export function deviceReportCellText(
  field: DeviceReportFieldId,
  row: DeviceRow,
): string {
  switch (field) {
    case 'serialNumber':
      return row.serialNumber;
    case 'status':
      return statusText(row.status);
    case 'model':
      return row.model ?? '';
    case 'assetTag':
      return row.assetTag ?? '';
    case 'annotatedUser':
      return row.annotatedUser ?? '';
    case 'orgUnitPath':
      return row.orgUnitPath;
    case 'battery':
      return batteryText(row.battery);
    case 'lastContact':
      return row.lastContact === null
        ? ''
        : new Date(row.lastContact).toISOString();
    case 'annotatedLocation':
      return row.annotatedLocation ?? '';
    case 'notes':
      return row.notes ?? '';
  }
}

/** The request of `POST /api/devices/exports` (design section 1). The selection key is the one of
 * the update preview request, so a tab names its grid the same way in both. */
export const deviceExportRequestSchema = z
  .strictObject({
    gridId: deviceSelectionKeySchema.shape.gridId,
    tabId: deviceSelectionKeySchema.shape.tabId,
    purpose: jobExportPurposeSchema,
    format: deviceExportFormatSchema,
    /** The grid sort. Rows follow it, and the device ID breaks ties (section 6.2). */
    sort: z.strictObject({
      field: deviceSortFieldSchema,
      direction: z.enum(['asc', 'desc']),
    }),
    /** The report field IDs in grid order. An edit export sends none. */
    columns: z
      .array(deviceReportFieldIdSchema)
      .max(DEVICE_REPORT_FIELD_IDS.length),
  })
  .refine(
    (request) =>
      request.purpose === 'report'
        ? request.columns.length > 0
        : request.columns.length === 0,
    {
      message:
        'A report export names its columns, and an edit export names none.',
    },
  )
  .refine(
    (request) => request.format !== 'sheet' || request.purpose === 'edit',
    {
      message: 'A Sheet export has the edit purpose.',
    },
  );
export type DeviceExportRequest = z.infer<typeof deviceExportRequestSchema>;

/** The receipt of an export route. It keeps the shape of the update receipt (section 1). */
export const deviceExportReceiptSchema = z.strictObject({
  jobId: z.uuid(),
  displayId: jobDisplayIdSchema,
  status: z.literal('accepted'),
  /** The devices in the frozen scope. */
  rows: count,
});
export type DeviceExportReceipt = z.infer<typeof deviceExportReceiptSchema>;

/**
 * The file name of an export (notes section "Scenario and data"): `devices-for-editing-EXP-001.csv`
 * and `device-report-EXP-002.csv`. A Sheet takes the CSV name without `.csv` (Drive slice design
 * section 1, `notes:227`).
 */
export function deviceExportFileName(
  purpose: JobExportPurpose,
  displayId: JobDisplayId,
  format: DeviceExportFormat = 'csv',
): string {
  const stem = purpose === 'edit' ? 'devices-for-editing' : 'device-report';
  return `${stem}-${displayId}${format === 'sheet' ? '' : '.csv'}`;
}
