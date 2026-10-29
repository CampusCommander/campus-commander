import type { JobDisplayId, JobFailure } from '@campus/application-contracts';
import { formatTimestamp } from '../jobs/job-fields';
import type { UpdateDeviceNote } from './device-update-messages';

/**
 * The copy of the Export, Reports, and Import dialog (`docs/superpowers/specs/
 * 2026-10-28-device-export-import-design.md`, section 9, states 01 to 08).
 *
 * The owner approved the mockup of 2026-10-28. Every string here is drafted for this card or
 * taken from that mockup and its notes; the hand-off lists each drafted one.
 */

/** The export row limit of design section 5 and notes question 19. */
export const EXPORT_ROW_LIMIT = 50_000;

/** One entry of the Bulk Actions menu below its divider (state 01). */
export type DeviceExportEntry = 'export' | 'report' | 'import';

export const EXPORT_PERMISSION_MESSAGE =
  'You need the devices:read, devices:export, and devices:bulk-actions permissions to export devices. Ask your administrator for access.';

export const REPORT_PERMISSION_MESSAGE =
  'You need the devices:read, devices:export, and devices:bulk-actions permissions to create a report. Ask your administrator for access.';

export const IMPORT_PERMISSION_MESSAGE =
  'You need the devices:read, devices:write, and devices:bulk-actions permissions to import devices. Ask your administrator for access.';

/** The dialog titles and the step context of the two export purposes (notes question 22). */
export const EXPORT_TITLE = 'Export devices';
export const REPORT_TITLE = 'Create a report';
export const IMPORT_TITLE = 'Import devices';

export const EXPORT_ENTRY_LABEL = 'Export';
export const REPORT_ENTRY_LABEL = 'Reports';
export const IMPORT_ENTRY_LABEL = 'Import';

/** The Format group of states 02, 03, and 07. */
export const FORMAT_LABEL = 'Format';
export const CSV_FORMAT_LABEL = 'CSV file';
export const SHEET_FORMAT_LABEL = 'Google Sheet';
export const SHEET_FORMAT_NOTE = 'Google Drive is not available for your account.';
/** The report columns heading of state 07. */
export const REPORT_COLUMNS_LABEL = 'Visible grid columns';

/** The over-limit note of state 03. */
export function exportLimitText(count: number): string {
  return `An edit export holds at most ${EXPORT_ROW_LIMIT.toLocaleString('en-US')} devices. This selection holds ${count.toLocaleString('en-US')}. Filter the grid to ${EXPORT_ROW_LIMIT.toLocaleString('en-US')} devices or fewer, then select them again.`;
}

/** The primary action names its count, as states 02 and 03 do. */
export function exportActionLabel(count: number): string {
  return `Export ${count.toLocaleString('en-US')} ${count === 1 ? 'device' : 'devices'}`;
}

export const CREATE_REPORT_LABEL = 'Create report';
export const DOWNLOAD_CSV_LABEL = 'Download CSV';
export const START_VALIDATION_LABEL = 'Start validation';

/** The two phases of an export (design section 2, state 04). */
export const EXPORT_PHASE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'write-rows': 'Write rows',
  'prepare-download': 'Prepare download',
});

/** The quiet closing line of state 04. */
export const EXPORT_CLOSING_LINE = 'Closing this dialog keeps the export running.';

/** The quiet state line of a stopped export. */
export const EXPORT_CANCELLED_LINE =
  'The export stopped before it finished. No file was written.';

/** The help pane. */
export const HELP_LABEL = 'Export and import help';
export const HELP_TITLE = 'Export and import help';

/**
 * The failure of an export job (design section 5). `export-too-large` is the drafted code of
 * section 1: an edit file past the 1 GiB cap.
 */
export function exportFailureText(failure: JobFailure | null): string {
  switch (failure) {
    case 'export-too-large':
      return 'The file passed the 1 GiB limit. Filter the grid to fewer devices, then export again.';
    case 'storage-unavailable':
      return 'Campus Commander could not store the file. Export again.';
    case 'inventory-unavailable':
      return 'Campus Commander could not read the devices. Export again.';
    case 'interrupted':
      return 'The export stopped before it finished. Export again.';
    case 'permission-changed':
      return 'Your permissions changed while the export ran. Reload the page, then export again.';
    case 'connection-changed':
      return 'The Google connection changed while the export ran. Export again.';
    default:
      return 'The export failed before it wrote a file. Export again.';
  }
}

/** The short failure of the Jobs grid line (state 26). */
export function exportFailureLabel(failure: JobFailure | null): string {
  switch (failure) {
    case 'export-too-large':
      return 'Export too large';
    case 'storage-unavailable':
      return 'Storage unavailable';
    case 'inventory-unavailable':
      return 'Inventory unavailable';
    case 'interrupted':
      return 'The export stopped';
    case 'permission-changed':
      return 'Permission changed';
    case 'connection-changed':
      return 'Connection changed';
    default:
      return 'Export failed';
  }
}

/** The file line of a ready export (states 05 and 08). */
export function exportFileFactList(file: {
  sizeBytes: number;
  rows: number;
  columns: number;
}): readonly string[] {
  return [
    'CSV file',
    fileSizeText(file.sizeBytes),
    `${file.rows.toLocaleString('en-US')} ${file.rows === 1 ? 'row' : 'rows'}`,
    `${file.columns.toLocaleString('en-US')} ${
      file.columns === 1 ? 'column' : 'columns'
    }`,
  ];
}

export function exportFileFacts(file: {
  sizeBytes: number;
  rows: number;
  columns: number;
}): string {
  return exportFileFactList(file).join(' · ');
}

/** A file size in the mockup style: "7.8 KB". */
export function fileSizeText(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} bytes`;
  const kilobytes = sizeBytes / 1024;
  if (kilobytes < 1024)
    return `${kilobytes.toLocaleString('en-US', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })} KB`;
  return `${(kilobytes / 1024).toLocaleString('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} MB`;
}

/** "Available until Nov 27, 10:31 AM" (state 05). */
export function exportAvailableText(expiresAt: string, now = new Date()): string {
  return `Available until ${formatTimestamp(expiresAt, now)}`;
}

/** The expired file of state 05: the route answers 410 after the expiry. */
export function exportExpiredText(expiresAt: string, now = new Date()): string {
  return `The file expired ${formatTimestamp(expiresAt, now)}. Export again for a new file.`;
}

/** The file route of an export (design sections 1 and 4). */
export function exportFileHref(displayId: JobDisplayId): string {
  return `/api/devices/exports/${encodeURIComponent(displayId)}/file`;
}

/** The label of a row in the help pane's column table (state 06). */
export interface ExportHelpColumn {
  column: string;
  use: string;
}

export const EXPORT_HELP_COLUMNS: readonly ExportHelpColumn[] = Object.freeze([
  { column: 'Device ID', use: 'Identifies the device. Keep it.' },
  { column: 'Serial number', use: 'Read-only' },
  { column: 'Model', use: 'Read-only' },
  { column: 'Status', use: 'Editable with a status code' },
  { column: 'Asset tag', use: 'Editable' },
  { column: 'Annotated location', use: 'Editable' },
  { column: 'Annotated user', use: 'Editable' },
  { column: 'Notes', use: 'Editable' },
  { column: 'Organization unit', use: 'Editable' },
  { column: 'Checksum', use: 'Marks the rows that you edit. Keep it.' },
]);

export const EXPORT_HELP_INTRO =
  'Export writes one row per selected device. Edit the file, then import it.';

export const EXPORT_HELP_COLUMNS_HEAD = 'Columns';
export const EXPORT_HELP_RULES_HEAD = 'Editing rules';
export const EXPORT_HELP_LIMITS_HEAD = 'Limits';

export const EXPORT_HELP_RULES: readonly string[] = Object.freeze([
  'A blank cell keeps the current value.',
  '[clear] empties Annotated location, Annotated user, or Notes.',
  'Asset tag and Organization unit cannot be cleared.',
  'A status code in the Status cell changes the status. The Import topic lists the codes.',
]);

export const EXPORT_HELP_LIMITS: readonly string[] = Object.freeze([
  'An edit export holds at most 50,000 devices.',
  'The download expires 30 days after the export.',
]);

export const REPORT_HELP_INTRO =
  'Reports writes the visible grid columns of the selected devices, in grid order.';

export const REPORT_HELP_LIMITS: readonly string[] = Object.freeze([
  'A report holds at most 50,000 devices.',
  'The download expires 30 days after the export.',
]);

/** The two help topics that this card builds (states 06 and 07). */
export const EXPORT_HELP_TOPICS = ['export', 'report'] as const;
export type ExportHelpTopic = (typeof EXPORT_HELP_TOPICS)[number];
export const EXPORT_HELP_TOPIC_LABELS: Readonly<Record<ExportHelpTopic, string>> =
  Object.freeze({ export: 'Export', report: 'Reports' });

/** The copy of one Bulk Actions entry, in the order of the built notes. */
interface EntryCopy {
  offline: string;
  permission: string;
  /** The note when the person has no selection. Import needs no selection. */
  selection: string | null;
}

const ENTRY_COPY: Readonly<Record<DeviceExportEntry, EntryCopy>> = Object.freeze({
  export: {
    offline: 'Export is unavailable while you are offline.',
    permission: EXPORT_PERMISSION_MESSAGE,
    selection: 'Select one or more devices to export.',
  },
  report: {
    offline: 'Reports are unavailable while you are offline.',
    permission: REPORT_PERMISSION_MESSAGE,
    selection: 'Select one or more devices to create a report.',
  },
  import: {
    offline: 'Import is unavailable while you are offline.',
    permission: IMPORT_PERMISSION_MESSAGE,
    selection: null,
  },
});

export interface ExportEntryAvailability {
  entry: DeviceExportEntry;
  offline: boolean;
  canRead: boolean;
  canBulk: boolean;
  /** `devices:export` for Export and Reports, and `devices:write` for Import. */
  canEntry: boolean;
  selectionCount: number;
}

/**
 * The reason that a Bulk Actions entry of the divider group is disabled, in the order of the
 * built notes: connectivity, permissions, then the selection. Null means the entry is enabled.
 */
export function exportEntryNote(
  availability: ExportEntryAvailability,
): UpdateDeviceNote | null {
  const copy = ENTRY_COPY[availability.entry];
  if (availability.offline)
    return { text: copy.offline, actions: [], error: false };
  if (!availability.canRead || !availability.canBulk || !availability.canEntry)
    return { text: copy.permission, actions: [], error: false };
  if (copy.selection && availability.selectionCount === 0)
    return { text: copy.selection, actions: [], error: false };
  return null;
}