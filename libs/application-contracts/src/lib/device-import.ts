import * as z from 'zod';
import {
  DEVICE_UPDATE_FIELD_LABELS,
  DEVICE_UPDATE_FIELD_LIMITS,
  deprovisionReasonSchema,
  deviceUpdateFieldSchema,
  type DeviceUpdateField,
} from './devices';
import { deviceStatusActionSchema } from './device-actions';
import {
  DEVICE_ACTION_PERMISSIONS,
  type DeviceStatusAction,
} from './device-actions';
import {
  DEVICE_EDIT_UNKNOWN_HEADER_WARNING_MAX_LENGTH,
  deviceImportModeSchema,
} from './device-edit-template';
import { CSV_MAX_CELL_LENGTH } from './csv';
import {
  jobDisplayIdSchema,
  jobImportPlanSchema,
  jobOutcomeSchema,
  type JobOutcome,
} from './jobs';

/**
 * The import contracts of the device export and import workflow
 * (`docs/superpowers/specs/2026-10-28-device-export-import-design.md`, sections 1, 6, and 8).
 *
 * An import reads a CSV file of the edit template, stores a report and a plan, and runs the plan.
 * This module holds the receipt, the report page, the plan routes, the refusal codes and their
 * texts, and the outcome constant of the Failed tab. The template rules stay in
 * `device-edit-template.ts`, and the file format stays in `csv.ts`.
 */

const count = z.number().int().min(0);
const timestamp = z.iso.datetime({ offset: true });
const fileName = z.string().min(1).max(255);

/** The row limit of a file (design section 6, `record:281`). */
export const DEVICE_IMPORT_ROW_LIMIT = 50000;

/** The receipt of `POST /api/devices/imports` (design section 1). */
export const deviceImportReceiptSchema = z.strictObject({
  jobId: z.uuid(),
  displayId: jobDisplayIdSchema,
  status: z.literal('accepted'),
  mode: deviceImportModeSchema,
  name: fileName,
  sizeBytes: count,
});
export type DeviceImportReceipt = z.infer<typeof deviceImportReceiptSchema>;

/**
 * The file faults that stop a validation before any row check (design section 6). The header
 * refusal of the template module carries its own text, so it keeps the code `header-refused`. The
 * Drive slice adds its three codes (Drive slice design section 1).
 */
export const DEVICE_IMPORT_REFUSALS = [
  'unreadable-file',
  'ragged-record',
  'unterminated-quote',
  'malformed-quote',
  'cell-too-long',
  'too-many-rows',
  'header-refused',
  'drive-source-unavailable',
  'source-too-large',
  'rows-too-large',
] as const;
export const deviceImportRefusalSchema = z.enum(DEVICE_IMPORT_REFUSALS);
export type DeviceImportRefusal = z.infer<typeof deviceImportRefusalSchema>;

/**
 * The text of a refusal, for states 13, 23, and 26. A `header-refused` refusal carries the sentence
 * of `matchDeviceEditHeaders`, which names each missing column and the Checksum rule, so the caller
 * passes that sentence rather than a copy. A `drive-source-unavailable` refusal names the source
 * file, so the caller passes the name that Drive answered (Drive slice design section 1).
 */
export function deviceImportRefusalText(
  refusal: DeviceImportRefusal,
  headerReason?: string,
  sourceName?: string,
): string {
  switch (refusal) {
    case 'unreadable-file':
      return 'The file is not UTF-8 text. Save it as UTF-8 CSV and import it again.';
    case 'ragged-record':
      return 'A row holds a different number of columns. Correct the row and import the file again.';
    case 'unterminated-quote':
      return 'The file ends inside a quoted cell. Correct the file and import it again.';
    case 'malformed-quote':
      return 'A cell holds a misplaced quote. Correct the file and import it again.';
    case 'cell-too-long':
      return `A cell holds more than ${CSV_MAX_CELL_LENGTH.toLocaleString(
        'en-US',
      )} characters.`;
    case 'too-many-rows':
      return `A file holds at most ${DEVICE_IMPORT_ROW_LIMIT.toLocaleString(
        'en-US',
      )} rows.`;
    case 'header-refused':
      if (!headerReason)
        throw new Error(
          'A header refusal carries the reason of matchDeviceEditHeaders.',
        );
      return headerReason;
    case 'drive-source-unavailable':
      if (!sourceName)
        throw new Error('A Drive source refusal carries the file name.');
      return `Campus Commander cannot read ${sourceName} from Google Drive. Choose the file again in Google Drive, then import again.`;
    case 'source-too-large':
      return 'The file holds more than 1 GiB of data. Remove rows or columns, then import again.';
    case 'rows-too-large':
      return '1,000 rows of this tab hold more than 64 MiB of data. Shorten the long cells, then import again.';
  }
}

/** The reasons of a rejected row that need no value (design sections 6 and 10.4). */
export const DEVICE_IMPORT_REJECTIONS = [
  'device-id-missing',
  'device-id-malformed',
  'device-id-duplicate',
  'device-unknown',
  'device-removed',
  'current-values-unavailable',
  'org-unit-unavailable',
] as const;
export const deviceImportRejectionSchema = z.enum(DEVICE_IMPORT_REJECTIONS);
export type DeviceImportRejection = z.infer<typeof deviceImportRejectionSchema>;

/** The text of each rejected row reason. */
export const DEVICE_IMPORT_REJECTION_TEXTS: Readonly<
  Record<DeviceImportRejection, string>
> = Object.freeze({
  'device-id-missing': 'The row holds no Device ID.',
  'device-id-malformed':
    'The Device ID holds 1 to 128 letters, digits, hyphens, or underscores.',
  'device-id-duplicate': 'Another row uses this Device ID.',
  'device-unknown':
    'Campus Commander holds no device with this ID. Import never creates devices.',
  'device-removed': 'Google no longer returns this device.',
  'current-values-unavailable': 'Current values unavailable.',
  'org-unit-unavailable': 'Organization unit check unavailable.',
});

/** The reason of a row that moves a device to a unit outside the organization unit tree. */
export function deviceImportUnitRejectionText(path: string): string {
  return `No organization unit has the path ${path}.`;
}

/** The reason of a row whose status change needs a permission that the person lacks. */
export function deviceImportPermissionRejectionText(
  action: DeviceStatusAction,
): string {
  return `You need the ${DEVICE_ACTION_PERMISSIONS[action]} permission for this change. Ask your administrator for access.`;
}

/** The reason of a field value past its limit, as state 14 shows it. */
export function deviceImportFieldLimitText(field: DeviceUpdateField): string {
  return `${DEVICE_UPDATE_FIELD_LABELS[field]} holds 1 to ${
    DEVICE_UPDATE_FIELD_LIMITS[field]
  } characters.`;
}

/** The warnings that never block Execute (design section 6, `td:649-653`). The unknown column
 * warning comes from `matchDeviceEditHeaders`, which names the column. */
export const DEVICE_IMPORT_WARNINGS = [
  'unknown-column',
  'duplicate-asset-tag',
  'export-only-status',
] as const;
export const deviceImportWarningSchema = z.enum(DEVICE_IMPORT_WARNINGS);
export type DeviceImportWarning = z.infer<typeof deviceImportWarningSchema>;

/** The warning of an asset tag that another device carries. */
export function deviceImportDuplicateTagWarning(tag: string): string {
  return `Asset tag ${tag} is also on another device. The change still runs when you execute.`;
}

/** The warning of a status cell that only an export writes. It requests nothing. */
export function deviceImportExportOnlyStatusWarning(
  cell: string,
  status: string,
): string {
  return `Status ${cell} is export-only and differs from the current status ${status}. It requests nothing.`;
}

/**
 * The reasons of a change that Execute does not run (design section 3). The four status reasons
 * repeat the exclusion reasons of the built status preview (`api/devices/device-actions.ts`).
 */
export const DEVICE_IMPORT_NOT_RUN_REASONS = [
  'changed-after-validation',
  'no-change-needed',
  'removed',
  'status-unknown',
  'device-deprovisioned',
  'device-active',
  'device-disabled',
] as const;
export const deviceImportNotRunReasonSchema = z.enum(
  DEVICE_IMPORT_NOT_RUN_REASONS,
);
export type DeviceImportNotRunReason = z.infer<
  typeof deviceImportNotRunReasonSchema
>;

/** The text of each not-run reason, for the Not run chip of state 17. */
export const DEVICE_IMPORT_NOT_RUN_TEXTS: Readonly<
  Record<DeviceImportNotRunReason, string>
> = Object.freeze({
  // The two reasons that only an import writes (design section 3).
  'changed-after-validation': 'Value changed after validation',
  'no-change-needed': 'Value already matches',
  // The reasons of the built device actions keep the wording of `exclusionReasonText`, so the
  // import and the bulk actions name one reason one way.
  removed: 'Removed from inventory',
  'status-unknown': 'Device status is unknown',
  'device-deprovisioned': 'Device is deprovisioned',
  'device-active': 'Device is active',
  'device-disabled': 'Device is disabled',
});

/** One change that Execute does not run, with its reason. */
export const deviceImportNotRunSchema = z.strictObject({
  reason: deviceImportNotRunReasonSchema,
  text: z.string().min(1).max(1024),
});
export type DeviceImportNotRun = z.infer<typeof deviceImportNotRunSchema>;

/**
 * The outcomes of the Failed tab (design section 8, ruling 4). The owner answered the proposal on
 * Unknown with "Unknown yes" on 2026-10-28, so the tab holds `failed` and `unknown`. Expired stays
 * out, because a device that answered the command keeps its own term in the counts.
 */
export const DEVICE_IMPORT_FAILED_OUTCOMES: readonly JobOutcome[] = [
  'failed',
  'unknown',
];

/** One proposed change of a report line: a field write or a status action. */
export const deviceImportChangeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('field'),
    field: deviceUpdateFieldSchema,
    operation: z.enum(['replace', 'clear', 'move']),
    currentValue: z.string().max(4096).nullable(),
    newValue: z.string().max(4096).nullable(),
  }),
  z
    .strictObject({
      type: z.literal('status'),
      action: deviceStatusActionSchema,
      /** The reason of a Deprovision change. Another status change carries none. */
      reason: deprovisionReasonSchema.nullable(),
      currentValue: z.string().max(64).nullable(),
      newValue: z.string().max(64).nullable(),
    })
    .refine(
      (change) =>
        (change.action === 'deprovision') === (change.reason !== null),
      {
        message:
          'A Deprovision change carries its reason, and another status change carries none.',
      },
    ),
]);
export type DeviceImportChange = z.infer<typeof deviceImportChangeSchema>;

/** The four report views of design section 1, plus the Failed tab view of section 8. */
export const DEVICE_IMPORT_REPORT_VIEWS = [
  'proposed',
  'rejected',
  'warnings',
  'failed',
] as const;
export const deviceImportReportViewSchema = z.enum(DEVICE_IMPORT_REPORT_VIEWS);
export type DeviceImportReportView = z.infer<
  typeof deviceImportReportViewSchema
>;

/** One report page holds ten lines (ruling 2). */
export const DEVICE_IMPORT_REPORT_PAGE_SIZE = 10;

/** The query of `GET /api/devices/imports/{displayId}/report` (design section 1). */
export const deviceImportReportQuerySchema = z.strictObject({
  view: deviceImportReportViewSchema.default('proposed'),
  /** The 0-based page index. A page past the last page answers the last page (ruling 2). */
  page: z.coerce.number().int().min(0).default(0),
});
export type DeviceImportReportQuery = z.output<
  typeof deviceImportReportQuerySchema
>;

/** The row counts of a completed validation: rows = unchanged + no change needed + proposed +
 * rejected (design section 1, `td:674`). */
export const deviceImportCountsSchema = z
  .strictObject({
    rows: count,
    unchanged: count,
    noChangeNeeded: count,
    proposed: count,
    rejected: count,
  })
  .refine(
    (counts) =>
      counts.rows ===
      counts.unchanged +
        counts.noChangeNeeded +
        counts.proposed +
        counts.rejected,
    {
      message:
        'Rows equal unchanged, no change needed, proposed, and rejected.',
    },
  );
export type DeviceImportCounts = z.infer<typeof deviceImportCountsSchema>;

/** The refresh facts of the report (design section 1, `td:635`). */
export const deviceImportRefreshSchema = z.strictObject({
  /** The candidate devices that this validation read from Google. */
  staleDevicesRead: count,
  /** The oldest observation among the compared devices. */
  oldestObservedAt: timestamp.nullable(),
});
export type DeviceImportRefresh = z.infer<typeof deviceImportRefreshSchema>;

/** The line under the count sum: the field changes and each status action (state 13). */
export const deviceImportChangeSummarySchema = z.strictObject({
  fieldChanges: count,
  fieldChangeDevices: count,
  disable: count,
  reenable: count,
  deprovision: z
    .array(
      z.strictObject({
        reason: deprovisionReasonSchema,
        devices: count,
      }),
    )
    .max(4),
});
export type DeviceImportChangeSummary = z.infer<
  typeof deviceImportChangeSummarySchema
>;

/**
 * The longest reason of a report line. The unknown-column warning of
 * `matchDeviceEditHeaders` repeats a whole header cell, and the unit rejection repeats an
 * organization unit path, which `orgUnitPath` limits to 4,096 characters. The longer producer
 * sets the bound, so no generated reason fails its own report line.
 */
export const DEVICE_IMPORT_REASON_MAX_LENGTH = Math.max(
  DEVICE_EDIT_UNKNOWN_HEADER_WARNING_MAX_LENGTH,
  'No organization unit has the path .'.length +
    DEVICE_UPDATE_FIELD_LIMITS.orgUnitPath,
);

/** One line of a report view (design section 1, `td:664-666`). */
export const deviceImportReportLineSchema = z.strictObject({
  /** The source row number. Null names the header row, as a warning on row 1 does. */
  row: count.nullable(),
  deviceId: z.string().min(1).max(128).nullable(),
  serialNumber: z.string().max(256).nullable(),
  /** The proposed change of a proposed or failed line. */
  change: deviceImportChangeSchema.nullable(),
  /** The file column of a rejected line. */
  column: z.string().min(1).max(64).nullable(),
  submittedValue: z.string().max(CSV_MAX_CELL_LENGTH).nullable(),
  /** The reason of a rejected line, or the warning of a warnings line. */
  reason: z.string().min(1).max(DEVICE_IMPORT_REASON_MAX_LENGTH).nullable(),
  /** A change that Execute does not run, with its reason. */
  notRun: deviceImportNotRunSchema.nullable(),
  /** The job and operation of a proposed line after Execute (design section 8). */
  jobDisplayId: jobDisplayIdSchema.nullable(),
  operationNumber: count.nullable(),
  /** The outcome of the change after Execute (design section 8). */
  outcome: jobOutcomeSchema.nullable(),
});
export type DeviceImportReportLine = z.infer<
  typeof deviceImportReportLineSchema
>;

/** The answer of the report route: the counts, the refresh facts, the change line, one page of
 * lines, the view total, and the plan (design section 1). */
export const deviceImportReportSchema = z.strictObject({
  jobId: z.uuid(),
  displayId: jobDisplayIdSchema,
  view: deviceImportReportViewSchema,
  /** The 0-based page index of this answer. */
  page: count,
  pageCount: z.number().int().min(1),
  counts: deviceImportCountsSchema,
  refresh: deviceImportRefreshSchema,
  changes: deviceImportChangeSummarySchema,
  /** The lines of this view, ten at most (ruling 2). */
  lines: z
    .array(deviceImportReportLineSchema)
    .max(DEVICE_IMPORT_REPORT_PAGE_SIZE),
  /** The lines of the whole view. */
  total: count,
  plan: jobImportPlanSchema.nullable(),
});
export type DeviceImportReport = z.infer<typeof deviceImportReportSchema>;

/** The body of `POST /api/devices/imports/{displayId}/cancel` (design section 1). */
export const deviceImportPlanCancelRequestSchema = z.strictObject({
  planId: z.uuid(),
  planRevision: z.number().int().min(1),
});
export type DeviceImportPlanCancelRequest = z.infer<
  typeof deviceImportPlanCancelRequestSchema
>;

/** The answer of the plan cancel route. A repeat answers the same plan. */
export const deviceImportPlanCancelAnswerSchema = z.strictObject({
  plan: jobImportPlanSchema,
});
export type DeviceImportPlanCancelAnswer = z.infer<
  typeof deviceImportPlanCancelAnswerSchema
>;

/** The body of `POST /api/devices/imports/{displayId}/execute` (design section 1). The typed
 * phrase is required only when the plan holds a Deprovision (design section 7). */
export const deviceImportExecuteRequestSchema = z.strictObject({
  planId: z.uuid(),
  planRevision: z.number().int().min(1),
  typedPhrase: z.string().max(64).nullable(),
});
export type DeviceImportExecuteRequest = z.infer<
  typeof deviceImportExecuteRequestSchema
>;

/** One job that Execute created. It keeps the shape of the update job receipt (design section 1).
 * Execute creates one update job and the status jobs, and no other kind (design section 7). */
export const deviceImportJobReceiptSchema = z.strictObject({
  jobId: z.uuid(),
  displayId: jobDisplayIdSchema,
  action: z.enum([
    'update-device-annotations',
    'disable-devices',
    'reenable-devices',
    'deprovision-devices',
  ]),
  status: z.literal('accepted'),
  deviceCount: count,
});
export type DeviceImportJobReceipt = z.infer<
  typeof deviceImportJobReceiptSchema
>;

/** The answer of Execute: the executed plan, its jobs, and the changes that it left out. */
export const deviceImportExecuteAnswerSchema = z.strictObject({
  plan: jobImportPlanSchema,
  /** The update job and the status jobs, in run order. One Execute creates seven at most. */
  receipts: z.array(deviceImportJobReceiptSchema).min(1).max(7),
  /** The changes whose value changed after validation. */
  conflicts: count,
  /** The devices that are no longer eligible for their status action, with their reason. */
  excluded: count,
});
export type DeviceImportExecuteAnswer = z.infer<
  typeof deviceImportExecuteAnswerSchema
>;
