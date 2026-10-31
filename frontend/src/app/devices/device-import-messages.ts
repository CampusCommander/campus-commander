import {
  DEVICE_DEPROVISION_CODES,
  DEVICE_EDIT_TEMPLATE_HEADERS,
  DEVICE_IMPORT_REPORT_PAGE_SIZE,
  DEVICE_UPDATE_FIELD_LABELS,
  DEVICE_UPDATE_FIELD_LIMITS,
  deviceImportRefusalText,
  statusText,
  type DeviceImportChange,
  type DeviceImportChangeSummary,
  type DeviceImportCounts,
  type DeviceImportMode,
  type DeviceImportRefresh,
  type DeviceImportRefusal,
  type DeviceImportReportLine,
  type DeviceImportReportView,
  type DeviceUpdateField,
  type JobDetail,
  type JobImportPlan,
  type JobPhase,
} from '@campus/application-contracts';
import { formatTimestamp, IMPORT_PHASE_LABELS } from '../jobs/job-fields';

/**
 * The copy of the Import, validation, and report steps
 * (`docs/superpowers/specs/2026-10-28-device-export-import-design.md`, section 9, states 09 to 15
 * and 18 to 24).
 *
 * The owner approved the mockup of 2026-10-28. Every string here comes from that mockup, from its
 * notes, or from an app module. The hand-off lists each drafted one.
 */

/** The upload cap of design section 4. A larger file never uploads. */
export const IMPORT_FILE_LIMIT_BYTES = 1_073_741_824;

/** The bytes that the browser reads for the header check (design section 9, states 09 and 10). */
export const IMPORT_HEADER_SAMPLE_BYTES = 65_536;

/** The setup step of states 09 and 10. */
export const IMPORT_MODE_LABEL = 'Import mode';
export const IMPORT_SOURCE_LABEL = 'Source';
export const IMPORT_SOURCE_UPLOAD_LABEL = 'Upload a CSV file';
export const IMPORT_SOURCE_DRIVE_LABEL = 'Google Drive';
export const IMPORT_DROP_LABEL = 'Drop a CSV file here';
export const IMPORT_BROWSE_LABEL = 'Choose CSV file';
export const IMPORT_SELECTED_FILE_LABEL = 'Selected file';
export const IMPORT_HEADER_PASSED_LINE = 'Header check passed.';
/** The subtitle of the setup step, before a job exists (state 09). */
export const IMPORT_SUBMITTED_LINE = 'CSV file · Not submitted';
/** The columns fact of a chosen file (state 09). */
export function importColumnCountText(columns: number): string {
  return `${columns.toLocaleString('en-US')} ${columns === 1 ? 'column' : 'columns'}`;
}

/* The Drive source of states 05 to 13. The owner approved each string in the notes. */

/** State 05. The Drive zone takes the shape of the drop zone. */
export const IMPORT_DRIVE_ZONE_TEXT = 'A Sheet or a CSV file';
export const IMPORT_DRIVE_CHOOSE_LABEL = 'Choose from Google Drive';
/** The subtitle of the setup step while no Drive file is chosen (state 05). */
export const IMPORT_DRIVE_SUBMITTED_LINE = 'Google Drive · Not submitted';
/** The tab field of a chosen Sheet (state 07). A CSV file carries none. */
export const IMPORT_DRIVE_TAB_LABEL = 'Tab';
/** The note under a disabled Drive card, by cause (states 11 and 12). */
export const IMPORT_DRIVE_SETUP_NOTE =
  'Google Drive needs the Picker API key and the project number. Add them on the Google connection page.';
export const IMPORT_DRIVE_ACCOUNT_NOTE =
  'Google Drive is not available for your account.';
export const IMPORT_DRIVE_DELEGATION_NOTE =
  'Google denied Drive access. Add https://www.googleapis.com/auth/drive.file to the delegation client in the Google Admin Console.';
/** The alert of a refused Drive session (state 12). Upload takes over. */
export const IMPORT_DRIVE_ACCOUNT_ALERT =
  'Google refused Drive access for your account. Upload a CSV file instead.';
/** The alert of a Drive answer that did not arrive. */
export const IMPORT_DRIVE_UNREACHABLE_ALERT =
  'Google Drive is not reachable. Try again, or upload a CSV file.';
/** The alert of a Picker script that did not load. */
export const IMPORT_PICKER_FAILED_ALERT =
  'The Google Picker did not open. Try again, or upload a CSV file.';
/** The alert of a Sheet whose tab list did not arrive (design section 1). */
export const IMPORT_DRIVE_TABS_ALERT =
  'Campus Commander cannot read the tabs of this Sheet. Choose the file again.';
export const IMPORT_DRIVE_WRONG_TYPE_ALERT =
  'Choose a Google Sheet or a CSV file.';
export const IMPORT_DRIVE_SOURCE_TOO_LARGE_ALERT =
  'The file holds more than 1 GiB of data. Remove rows or columns, then import again.';
export const IMPORT_DRIVE_ROWS_TOO_LARGE_ALERT =
  '1,000 rows of this tab hold more than 64 MiB of data. Shorten the long cells, then import again.';
/** A Drive session is renewed inside this window before it expires (design section 5). */
export const DRIVE_SESSION_RENEW_MS = 5 * 60_000;

/** The first phase of a Drive validation reads the file from Google (state 10). */
export const IMPORT_DRIVE_READ_LABEL = 'Read from Google Drive';

/** The header row of a chosen Drive file is under check. */
export const IMPORT_DRIVE_CHECKING_LINE = 'Checking the header row…';

/** The facts line of a chosen Drive file (states 07 and 08). */
export function driveFileFactList(file: {
  readonly kind: 'sheet' | 'csv';
  readonly tabCount: number;
  readonly sizeBytes: number | null;
  readonly columns: number;
  readonly lastEditedUtc: number | null;
}): readonly string[] {
  const facts: string[] =
    file.kind === 'sheet' ? ['Google Sheet'] : ['CSV file'];
  if (file.kind === 'sheet') {
    if (file.tabCount > 0) facts.push(driveTabCountText(file.tabCount));
  } else {
    if (file.sizeBytes !== null) facts.push(formatBytes(file.sizeBytes));
    if (file.columns > 0) facts.push(importColumnCountText(file.columns));
  }
  if (file.lastEditedUtc !== null)
    facts.push(
      `Edited ${formatTimestamp(new Date(file.lastEditedUtc).toISOString())}`,
    );
  return facts;
}

/** "2 tabs" (state 07). */
export function driveTabCountText(tabs: number): string {
  return `${tabs.toLocaleString('en-US')} ${tabs === 1 ? 'tab' : 'tabs'}`;
}

/** The failure of `POST /api/devices/imports/drive` (design section 1). */
export function importDriveFailureText(
  status: number,
  reason: string | null,
  name: string,
): string {
  switch (reason) {
    case 'wrong-file-type':
      return IMPORT_DRIVE_WRONG_TYPE_ALERT;
    case 'tab-missing':
      return IMPORT_DRIVE_TABS_ALERT;
    case 'source-too-large':
      return IMPORT_DRIVE_SOURCE_TOO_LARGE_ALERT;
    case 'rows-too-large':
      return IMPORT_DRIVE_ROWS_TOO_LARGE_ALERT;
    case 'drive-file-unavailable':
      return deviceImportRefusalText(
        'drive-source-unavailable',
        undefined,
        name,
      );
  }
  return importUploadFailureText(status, reason);
}

/** The Google Drive topic of the help pane (state 09). */
export const IMPORT_DRIVE_HELP_EXPORT_HEAD = 'Export';
export const IMPORT_DRIVE_HELP_IMPORT_HEAD = 'Import';
export const IMPORT_DRIVE_HELP_ACCESS_HEAD = 'Access';
export const IMPORT_DRIVE_HELP_INTRO =
  'Google Sheet export and Google Drive import use your own Google Drive.';
export const IMPORT_DRIVE_HELP_EXPORT: readonly string[] = [
  'A Google Sheet export creates a Sheet in your Google Drive. You own the Sheet.',
  'Campus Commander keeps only the link. Share the Sheet in Google Drive.',
];
export const IMPORT_DRIVE_HELP_IMPORT: readonly string[] = [
  'Choose from Google Drive opens the Google Picker. It lists your Google Sheets and CSV files.',
  'For a Google Sheet, choose the tab. The first tab starts selected.',
  'Hidden and filtered rows count as rows.',
  'Validation reads the file when it starts. Import again after later edits.',
];
export const IMPORT_DRIVE_HELP_ACCESS: readonly string[] = [
  'Campus Commander opens only its own files and the files that you choose.',
];

/** The name of the upload, as the route query carries it. */
export function importUploadPath(mode: DeviceImportMode, name: string): string {
  return `/api/devices/imports?mode=${encodeURIComponent(mode)}&name=${encodeURIComponent(name)}`;
}

/**
 * The refusal of a file that the browser never uploads (design section 4). The browser checks the
 * size before it reads the header, and the edge repeats the check.
 */
export function importSizeRefusal(sizeBytes: number): string {
  return `A file holds at most 1 GiB. This file holds ${formatBytes(
    sizeBytes,
  )}, so it never uploads. Split it into smaller files, then import one of them.`;
}

/** A file that holds no header row and no data row. */
export const IMPORT_EMPTY_FILE_REFUSAL =
  'The file holds no rows. Choose a CSV file with a header row and a data row.';

/** The failure of the upload route (design sections 1 and 4). */
export function importUploadFailureText(
  status: number,
  reason: string | null,
): string {
  switch (status) {
    case 413:
      return 'The file is larger than 1 GiB. Split it into smaller files, then import one of them.';
    case 415:
      return 'Campus Commander accepts a CSV file only. Save the file as CSV, then import it again.';
    case 422:
      return 'The file holds more rows than an import accepts. A file holds at most 50,000 rows.';
    case 403:
      return 'You do not have permission to import devices.';
    case 401:
      return 'Your session ended. Sign in again, then import.';
    case 409:
      return 'The Google connection changed. Reconnect Google, then import again.';
    case 429:
      return 'Campus Commander is busy with another import. Try again in a moment.';
    default:
      return reason === 'storage-unavailable'
        ? 'Campus Commander could not store the file. Import it again.'
        : 'Campus Commander could not start the validation. Try again.';
  }
}

/** A file that the browser could not read. */
export const IMPORT_READ_FAILURE =
  'Cannot read this file. Save it as UTF-8 CSV, then choose it again.';

/** A file whose first bytes are not UTF-8 text. */
export const IMPORT_NOT_UTF8_REFUSAL =
  'The file is not UTF-8 text. Save it as UTF-8 CSV and import it again.';

/** The monitor step of states 12, 23, and 24. */
export const STOP_VALIDATION_LABEL = 'Stop validation';
export const VALIDATION_CLOSING_LINE =
  'Closing this dialog keeps the validation running.';
export const VALIDATION_STOPPED_LINE =
  'Validation stopped. No report and no plan exist. Nothing reached Google.';
export const VALIDATION_FAILED_LINE =
  'Validation stopped before any row check. No report and no plan exist. Nothing reached Google.';
export const NO_REPORT_LABEL = 'No report';

/** The three counters of states 12 and 24. */
export const ROWS_READ_LABEL = 'Rows read';
export const EDITED_ROWS_LABEL = 'Edited rows';
export const ROWS_TO_COMPARE_LABEL = 'Rows to compare';

/** The stored reads of a stopped validation (state 24). */
export function importStoppedReadsLine(staleDevicesRead: number): string {
  const count = staleDevicesRead.toLocaleString('en-US');
  return `The ${count} ${staleDevicesRead === 1 ? 'device read' : 'device reads'} that finished before the stop ${
    staleDevicesRead === 1 ? 'stays' : 'stay'
  } stored.`;
}

/** One dot of the validation phase list. */
export interface ImportPhaseView {
  name: string;
  label: string;
  detail: string;
  state: 'done' | 'current' | 'later' | 'failed' | 'stopped';
  /** The determinate bar of the current phase, or null when the phase has no total. */
  percent: number | null;
}

/** The five phases of a validation, in the order of the worker (design section 2). */
const IMPORT_PHASES = [
  'upload',
  'header-check',
  'refresh',
  'compare',
  'report',
] as const;

/**
 * The phases of a validation job (states 12, 23, and 24). The upload ends before the job exists,
 * so its dot reads done as soon as the receipt arrives and its detail is the receipt size. A
 * failed or cancelled job marks the phases before its stopping phase Done, the stopping phase
 * Failed or Stopped, and the phases after it untouched.
 */
export function importPhases(
  job: JobDetail | null,
): readonly ImportPhaseView[] {
  const phase = job?.phase ?? null;
  const failed = job?.status === 'failed' || job?.status === 'needs-review';
  const cancelled = job?.status === 'cancelled';
  const completed =
    job?.status === 'completed' || job?.status === 'completed-with-errors';
  const reached = phase
    ? IMPORT_PHASES.indexOf(
        (phase.name === 'drive-read'
          ? 'upload'
          : phase.name) as (typeof IMPORT_PHASES)[number],
      )
    : -1;
  const drive =
    job?.importSource?.sourceType === 'drive-sheet' ||
    job?.importSource?.sourceType === 'drive-csv';
  return IMPORT_PHASES.map((name, index) => {
    let state: ImportPhaseView['state'];
    if (failed || cancelled) {
      const stopping = reached >= 0 ? reached : 1;
      state =
        index < stopping
          ? 'done'
          : index === stopping
            ? failed
              ? 'failed'
              : 'stopped'
            : 'later';
    } else if (completed) state = 'done';
    else if (reached < 0) state = index === 0 ? 'current' : 'later';
    else if (index < reached) state = 'done';
    else if (index === reached) state = 'current';
    else state = 'later';
    const detail = importPhaseDetail(name, state, job, phase);
    const percent =
      name === 'refresh' && state === 'current' && phase?.name === 'refresh'
        ? percentOf(phase.done, phase.total)
        : null;
    return {
      name,
      label:
        name === 'upload' && drive
          ? IMPORT_DRIVE_READ_LABEL
          : IMPORT_PHASE_LABELS[name],
      detail,
      state,
      percent,
    };
  });
}

function importPhaseDetail(
  name: string,
  state: ImportPhaseView['state'],
  job: JobDetail | null,
  phase: JobPhase | null,
): string {
  if (name === 'upload') {
    const source = job?.importSource;
    if (
      source?.sourceType === 'drive-sheet' ||
      source?.sourceType === 'drive-csv'
    ) {
      if (state === 'failed') return 'Failed';
      if (state === 'stopped') return 'Stopped';
      if (source.rowsRead > 0)
        return `${source.rowsRead.toLocaleString('en-US')} ${
          source.rowsRead === 1 ? 'row' : 'rows'
        }`;
      return state === 'current' ? 'Reading the file' : '';
    }
    return source
      ? formatBytes(source.sizeBytes)
      : state === 'current'
        ? 'Sending the file'
        : '';
  }
  if (name === 'header-check')
    return state === 'failed'
      ? 'Failed'
      : state === 'done'
        ? 'Passed'
        : state === 'stopped'
          ? 'Stopped'
          : '';
  if (name === 'refresh') {
    if (phase?.name !== 'refresh' || phase.total === null) return '';
    return `${phase.done.toLocaleString('en-US')} of ${phase.total.toLocaleString('en-US')}`;
  }
  return '';
}

function percentOf(done: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return Math.min(100, Math.round((done / total) * 100));
}

/** The counters of a validation (states 12 and 24). */
export function importCounterRows(
  job: JobDetail | null,
): readonly { value: string; label: string }[] {
  const source = job?.importSource;
  if (!source) return [];
  return [
    { value: source.rowsRead.toLocaleString('en-US'), label: ROWS_READ_LABEL },
    {
      value: source.candidateRows.toLocaleString('en-US'),
      label:
        job?.importSummary?.mode === 'sync-all-rows'
          ? ROWS_TO_COMPARE_LABEL
          : EDITED_ROWS_LABEL,
    },
  ];
}

/** The refusal box of state 23: the module sentence and its Sync all rows note, one per line. */
export function importRefusalParagraphs(text: string): readonly string[] {
  return text
    .split(/(?<=\.)\s+(?=[A-Z])/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

const DEVICE_IMPORT_REFUSALS_BY_CODE: Readonly<
  Record<string, DeviceImportRefusal>
> = Object.freeze({
  'unreadable-file': 'unreadable-file',
  'ragged-record': 'ragged-record',
  'unterminated-quote': 'unterminated-quote',
  'malformed-quote': 'malformed-quote',
  'cell-too-long': 'cell-too-long',
  'too-many-rows': 'too-many-rows',
  'header-refused': 'header-refused',
  'drive-source-unavailable': 'drive-source-unavailable',
  'source-too-large': 'source-too-large',
  'rows-too-large': 'rows-too-large',
});

/** The report step of states 13 to 15 and 18 to 22. */
export const REPORT_TABS: readonly DeviceImportReportView[] = [
  'proposed',
  'rejected',
  'warnings',
];

export const REPORT_TAB_LABELS: Readonly<
  Record<DeviceImportReportView, string>
> = Object.freeze({
  proposed: 'Proposed changes',
  rejected: 'Rejected rows',
  warnings: 'Warnings',
  failed: 'Failed',
});

/** The unit of a pager line, per view (states 13, 14, and 15). */
const REPORT_UNITS: Readonly<Record<DeviceImportReportView, [string, string]>> =
  Object.freeze({
    proposed: ['proposed change', 'proposed changes'],
    rejected: ['rejected row', 'rejected rows'],
    warnings: ['warning', 'warnings'],
    failed: ['failed change', 'failed changes'],
  });

/**
 * The pager line of a report page (states 13 to 15). A view without a line reads its count:
 * "0 proposed changes".
 */
export function reportPagerText(
  view: DeviceImportReportView,
  page: number,
  shown: number,
  total: number,
): string {
  const [one, many] = REPORT_UNITS[view];
  const unit = total === 1 ? one : many;
  if (total === 0) return `0 ${many}`;
  const start = page * DEVICE_IMPORT_REPORT_PAGE_SIZE + 1;
  const end = start + Math.max(0, shown - 1);
  return `Rows ${start.toLocaleString('en-US')}–${end.toLocaleString('en-US')} of ${total.toLocaleString(
    'en-US',
  )} ${unit}`;
}

/** The count equation of a report: rows = unchanged + no change needed + proposed + rejected. */
export interface ReportCountTerm {
  label: string;
  value: string;
  tone: 'rows' | 'success' | 'neutral' | 'info' | 'error';
}

export function reportCountTerms(
  counts: DeviceImportCounts,
): readonly ReportCountTerm[] {
  return [
    { label: 'Rows', value: counts.rows.toLocaleString('en-US'), tone: 'rows' },
    {
      label: 'Unchanged',
      value: counts.unchanged.toLocaleString('en-US'),
      tone: 'success',
    },
    {
      label: 'No change needed',
      value: counts.noChangeNeeded.toLocaleString('en-US'),
      tone: 'neutral',
    },
    {
      label: 'Proposed',
      value: counts.proposed.toLocaleString('en-US'),
      tone: 'info',
    },
    {
      label: 'Rejected',
      value: counts.rejected.toLocaleString('en-US'),
      tone: counts.rejected > 0 ? 'error' : 'neutral',
    },
  ];
}

/** The line under the count equation (state 13). */
export function reportChangeLine(summary: DeviceImportChangeSummary): string {
  const terms: string[] = [];
  if (summary.fieldChanges > 0)
    terms.push(
      `${summary.fieldChanges.toLocaleString('en-US')} field ${
        summary.fieldChanges === 1 ? 'change' : 'changes'
      } on ${summary.fieldChangeDevices.toLocaleString('en-US')} ${
        summary.fieldChangeDevices === 1 ? 'device' : 'devices'
      }`,
    );
  if (summary.disable > 0) terms.push(actionTerm('Disable', summary.disable));
  if (summary.reenable > 0)
    terms.push(actionTerm('Re-enable', summary.reenable));
  for (const entry of summary.deprovision) {
    const reason = DEVICE_DEPROVISION_CODES.find(
      (code) => code.reason === entry.reason,
    )?.label;
    terms.push(
      `${actionTerm('Deprovision', entry.devices)}${
        reason ? ` (${reason})` : ''
      }`,
    );
  }
  return terms.join(' · ');
}

function actionTerm(label: string, devices: number): string {
  return `${label} ${devices.toLocaleString('en-US')} ${
    devices === 1 ? 'device' : 'devices'
  }`;
}

/** The meta line of the report (states 13, 18, 20, and 22). */
export function reportRefreshLine(refresh: DeviceImportRefresh): string {
  const count = refresh.staleDevicesRead.toLocaleString('en-US');
  return `Validation refreshed ${count} stale ${
    refresh.staleDevicesRead === 1 ? 'device' : 'devices'
  } from Google before the comparison.`;
}

export function reportOldestLine(
  oldestObservedAt: string | null,
  now = new Date(),
): string {
  return oldestObservedAt
    ? `Oldest observation ${formatTimestamp(oldestObservedAt, now)}`
    : 'No device needed a refresh.';
}

export const REPORT_SYNC_ALL_ROWS_LINE =
  'Sync all rows checks every row, so no row counts as unchanged.';

/** The plan state of the action bar (states 13, 19, 20, 21, and 22). */
export const PLAN_OPEN_LABEL = 'Open';
export const PLAN_EXPIRED_LABEL = 'Expired';
export const PLAN_CANCELLED_LABEL = 'Cancelled';
export const PLAN_NO_CHANGE_LABEL = 'No changes';
export const EXECUTED_LABEL = 'Executed';
export const CANCEL_IMPORT_LABEL = 'Cancel import';
export const IMPORT_AGAIN_LABEL = 'Import again';
export const VALIDATE_AGAIN_LABEL = 'Validate again';
export const DOWNLOAD_REJECTED_LABEL = 'Download rejected rows';
export const NO_UPDATE_VIEW_LINE = 'No row needs an update.';
/** The empty line of each report view (states 14, 15, and 17b). */
export const REPORT_EMPTY_LINES: Readonly<
  Record<DeviceImportReportView, string>
> = Object.freeze({
  proposed: NO_UPDATE_VIEW_LINE,
  rejected: 'No row was rejected.',
  warnings: 'No warnings.',
  failed: 'No change failed.',
});
export const NO_UPDATE_LINE =
  'Every row matches its export checksum. No update is needed.';
/** The same line for the Sync all rows mode: every row already matches the file (state 21). */
export const SYNC_ALL_ROWS_NO_UPDATE_LINE =
  'Every row already matches the file. No update is needed.';

/** "Expires Oct 28, 11:42 AM" (state 13). */
export function planExpiresText(expiresAt: string, now = new Date()): string {
  return `Expires ${formatTimestamp(expiresAt, now)}`;
}

/** "The plan expired Oct 28, 10:15 AM. Nothing ran." (state 19). */
export function planExpiredText(expiresAt: string, now = new Date()): string {
  return `The plan expired ${formatTimestamp(expiresAt, now)}. Nothing ran.`;
}

/** "Cancelled by Review administrator · Oct 28, 10:51 AM. Nothing ran." (state 20). */
export function planCancelledText(
  plan: JobImportPlan,
  now = new Date(),
): string {
  const by = plan.changedBy?.displayName;
  const at = plan.changedAt ? formatTimestamp(plan.changedAt, now) : null;
  return by && at
    ? `Cancelled by ${by} · ${at}. Nothing ran.`
    : 'Cancelled. Nothing ran.';
}

/** "Nothing can run. 4 rows are rejected. Correct the rows in the file, then import it again." */
export function nothingCanRunText(rejected: number): string {
  const count = rejected.toLocaleString('en-US');
  return `Nothing can run. ${count} ${
    rejected === 1 ? 'row is' : 'rows are'
  } rejected. Correct the rows in the file, then import it again.`;
}

/** `1 device`, `6 devices` (state 16). */
export function deviceCountText(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'device' : 'devices'}`;
}

/** The primary action of a report: the change count, or the bare word (state 21). */
export function executeActionLabel(changes: number): string {
  if (changes <= 0) return 'Execute';
  return `Execute ${changes.toLocaleString('en-US')} ${
    changes === 1 ? 'change' : 'changes'
  }`;
}

/* ---------- State 16: the Execute confirmation (design section 7) ---------- */

/**
 * The question of the confirmation (state 16). The report answer counts the changes and the
 * field-change devices, so the question names the changes that Execute runs.
 */
export function executeConfirmTitle(changes: number, devices: number): string {
  const changeText = `${changes.toLocaleString('en-US')} ${
    changes === 1 ? 'change' : 'changes'
  }`;
  if (devices <= 0) return `Execute ${changeText}?`;
  return `Execute ${changeText} on ${devices.toLocaleString('en-US')} ${
    devices === 1 ? 'device' : 'devices'
  }?`;
}

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
] as const;

/** The mockup spells the job counts below eight: "four jobs", "three status jobs". */
function spellCount(value: number): string {
  return NUMBER_WORDS[value] ?? value.toLocaleString('en-US');
}

/**
 * The jobs that Execute creates (state 16). The update job runs first, and the status jobs of an
 * import wait for it (design section 3). A plan with field changes only creates the update job, and
 * a plan with status changes only creates one job per action.
 */
export function executeJobsLine(
  fieldChanges: boolean,
  statusJobs: number,
): string {
  if (fieldChanges && statusJobs > 1)
    return `Execute creates ${spellCount(
      statusJobs + 1,
    )} jobs. The update job runs first. The ${spellCount(
      statusJobs,
    )} status jobs start after it ends.`;
  if (fieldChanges && statusJobs === 1)
    return 'Execute creates two jobs. The update job runs first. The status job starts after it ends.';
  if (fieldChanges)
    return 'Execute creates one job. The update job runs first.';
  if (statusJobs === 1)
    return 'Execute creates one job. It runs its own action.';
  return `Execute creates ${spellCount(
    statusJobs,
  )} status jobs. Each one runs its own action.`;
}

/** The line under the job sequence: the rejected rows of the plan stay out (state 16). */
export function executeStaysOutLine(rejected: number): string {
  return `The ${rejected.toLocaleString('en-US')} rejected ${
    rejected === 1 ? 'row stays' : 'rows stay'
  } out. Nothing in them runs.`;
}

/** The typed phrase that a plan with a Deprovision requires (design section 7, step 2). */
export const DEPROVISION_PHRASE_LABEL = 'DEPROVISION';

/**
 * The refusal of `POST …/execute` (design sections 1 and 7). The route rechecks the permissions
 * and the plan lock, so a person reads which check refused the plan.
 */
export function executeFailureText(
  status: number,
  reason: string | null,
): string {
  switch (reason) {
    case 'phrase-mismatch':
      return `The typed word does not match. Type ${DEPROVISION_PHRASE_LABEL}, then execute again.`;
    case 'plan-conflict':
      return 'The plan changed since you opened it. Reload the review, then execute again.';
    case 'plan-expired':
      return 'The plan expired. Validate the file again.';
    case 'nothing-to-run':
      return 'Nothing is left to run. The plan stays open.';
    case 'job-not-found':
      return 'This import no longer exists.';
  }
  switch (status) {
    case 403:
      return 'You do not have permission to execute this plan.';
    case 401:
      return 'Your session ended. Sign in again, then execute.';
    case 409:
      return 'The plan changed since you opened it. Reload the review, then execute again.';
    case 410:
      return 'The plan expired. Validate the file again.';
    case 422:
      return 'Campus Commander refused a change of this plan. Review the plan, then execute again.';
    default:
      return 'Campus Commander could not execute the plan. Try again.';
  }
}

/** The empty value of a cell (the built grid literal). */
export const NOT_SET_LABEL = 'Not set';
/** The new value of a cleared field (the built sheet literal). */
export const CLEAR_VALUE_LABEL = 'Clear value';
/** The second line of a Deprovision change (state 13). */
export const DEPROVISION_REASON_PREFIX = 'Deprovision reason: ';

/** One cell of a report line. */
export interface ReportValue {
  text: string;
  /** The whole value, for the tooltip of a cell that cuts it. */
  full: string;
  /** A cleared field reads in the italic treatment of the mockup. */
  clear: boolean;
  /** A code or a path keeps the code face or the path cut. */
  code: boolean;
  /** A path keeps whole trailing segments (ruling 3). */
  path: boolean;
}

/**
 * The Current value and the New value of a change (states 13 and 18). A status change reads the
 * Google status label, and a Deprovision adds its reason under the new value.
 */
export function reportChangeValues(change: DeviceImportChange): {
  current: ReportValue;
  next: ReportValue;
  note: string;
} {
  if (change.type === 'status') {
    return {
      current: valueOf(
        change.currentValue === null ? '' : statusText(change.currentValue),
      ),
      next: valueOf(
        change.newValue === null ? '' : statusText(change.newValue),
      ),
      note: change.reason
        ? `${DEPROVISION_REASON_PREFIX}${deprovisionLabel(change.reason)}`
        : '',
    };
  }
  return {
    current: valueOf(change.currentValue, change.field === 'orgUnitPath'),
    next:
      change.operation === 'clear'
        ? { ...valueOf(CLEAR_VALUE_LABEL), clear: true }
        : valueOf(change.newValue, change.field === 'orgUnitPath'),
    note: '',
  };
}

function valueOf(value: string | null, path = false): ReportValue {
  const text = value === null || value === '' ? NOT_SET_LABEL : value;
  return {
    text,
    full: text,
    clear: false,
    code: false,
    path,
  };
}

function deprovisionLabel(reason: string): string {
  return (
    DEVICE_DEPROVISION_CODES.find((code) => code.reason === reason)?.label ??
    reason
  );
}

/** The change chip of a proposed line (state 13). */
export interface ReportChangeChip {
  label: string;
  tone: 'neutral' | 'warning' | 'success' | 'error';
}

export function reportChangeChip(change: DeviceImportChange): ReportChangeChip {
  if (change.type === 'field')
    return { label: DEVICE_UPDATE_FIELD_LABELS[change.field], tone: 'neutral' };
  switch (change.action) {
    case 'disable':
      return { label: 'Disable', tone: 'warning' };
    case 'reenable':
      return { label: 'Re-enable', tone: 'success' };
    case 'deprovision':
      return { label: 'Deprovision', tone: 'error' };
  }
}

/** The Cell of a rejected line: the file column, or the template header of the change. */
export function reportRejectedCell(line: DeviceImportReportLine): string {
  return line.column ?? '';
}

/** The template columns of the rejected file (design section 1, notes question 10). */
export const REPORT_REJECTED_COLUMNS = DEVICE_EDIT_TEMPLATE_HEADERS;

/** The "Not in inventory" device cell of a rejected line (state 14). */
export const NOT_IN_INVENTORY_LABEL = 'Not in inventory';

/**
 * The reason of a failed validation (states 23 and 26). A refusal states the module sentence of
 * its code. A stored failure states its own sentence, so a fault never reads as a refusal.
 */
export function importFailureText(job: JobDetail | null): string {
  const refusal = job?.importSummary?.refusal ?? null;
  const headerReason = job?.importSource?.refusalText ?? null;
  const known = refusal ? DEVICE_IMPORT_REFUSALS_BY_CODE[refusal] : undefined;
  // A header refusal carries the sentence of matchDeviceEditHeaders, which names the columns.
  if (known === 'header-refused')
    return (
      headerReason ??
      'The header check failed. Correct the file and import it again.'
    );
  // A Drive source refusal names the file that Google Drive answered (state 13).
  if (known === 'drive-source-unavailable') {
    const name = job?.importSource?.name;
    return name
      ? deviceImportRefusalText(known, undefined, name)
      : (headerReason ??
          'The validation stopped before it finished. Import the file again.');
  }
  if (known) return deviceImportRefusalText(known);
  switch (job?.failure) {
    case 'storage-unavailable':
      return 'Campus Commander could not store the validation report. Import the file again.';
    case 'inventory-unavailable':
      return 'Campus Commander could not read the device inventory. Import the file again.';
    case 'permission-changed':
      return 'Your permission to import devices changed. Import the file again when it is restored.';
    case 'connection-changed':
      return 'The Google connection changed. Reconnect Google, then import the file again.';
    default:
      return 'The validation stopped before it finished. Import the file again.';
  }
}

/** The two parts of a failed validation: the reason and the note that follows it. */
export interface ImportFailureView {
  readonly paragraphs: readonly string[];
  readonly note: string;
}

/**
 * The failure of a validation (states 23 and 26). The note reports where the run stopped. A fault
 * after the header check reports the rows that it read, so it never reads as an initial refusal.
 */
export function importFailureView(job: JobDetail | null): ImportFailureView {
  const rows = job?.importSource?.rowsRead ?? 0;
  const reason = job?.importSource?.refusalText
    ? job.importSource.refusalText
    : importFailureText(job);
  return {
    paragraphs: importRefusalParagraphs(reason),
    note:
      rows === 0
        ? VALIDATION_FAILED_LINE
        : `Validation stopped after it read ${rows.toLocaleString('en-US')} ${
            rows === 1 ? 'row' : 'rows'
          }. No report and no plan exist.`,
  };
}

/**
 * The cancel question of an import's update job (state 25, design section 9, behavior 10). XF3
 * wires it to the built cancel question; this card drafts the two sentences.
 */
export function importWaitingJobLine(
  importDisplayId: string,
  waiting: readonly string[],
): string {
  return `Import ${importDisplayId} · ${listJobIds(waiting)} start after this job ends`;
}

export function importCancelQuestionLine(waiting: readonly string[]): string {
  return `The waiting status ${waiting.length === 1 ? 'job' : 'jobs'} ${listJobIds(
    waiting,
  )} also end Cancelled and never start.`;
}

function listJobIds(ids: readonly string[]): string {
  if (ids.length === 0) return 'no status job';
  if (ids.length === 1) return ids[0];
  if (ids.length === 2) return `${ids[0]} and ${ids[1]}`;
  return `${ids.slice(0, -1).join(', ')}, and ${ids[ids.length - 1]}`;
}

/** A byte count in the mockup style: "7.8 KB". */
export function formatBytes(sizeBytes: number): string {
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

/* The help pane of states 11 and 13 to 15: the Import and Review topics. */

export const IMPORT_HELP_MODES_HEAD = 'Import modes';
export interface HelpMode {
  readonly mode: string;
  readonly text: string;
}
export const IMPORT_HELP_MODES: readonly HelpMode[] = Object.freeze([
  {
    mode: 'Sync changes',
    text: 'Checks the rows that changed since the export. Needs the Checksum column.',
  },
  {
    mode: 'Sync all rows',
    text: 'Checks every row and resets the devices to the file. Ignores the Checksum column.',
  },
]);
export const IMPORT_HELP_RULES_HEAD = 'Rules';
/** The field limits of the import template, from the contract that enforces them (help, R12). */
export const IMPORT_HELP_LIMITS_HEAD = 'Field limits';
export const IMPORT_HELP_LIMITS: readonly {
  readonly field: string;
  readonly limit: string;
}[] = Object.freeze(
  (Object.keys(DEVICE_UPDATE_FIELD_LIMITS) as DeviceUpdateField[]).map(
    (field) => ({
      field: DEVICE_UPDATE_FIELD_LABELS[field],
      limit: `${DEVICE_UPDATE_FIELD_LIMITS[field].toLocaleString('en-US')} characters`,
    }),
  ),
);
export const IMPORT_HELP_RULES: readonly string[] = Object.freeze([
  'A blank cell keeps the current value.',
  '[clear] empties Annotated location, Annotated user, or Notes.',
  'Import never creates devices. A device ID that Campus Commander does not hold rejects its row.',
  'A file holds at most 50,000 rows.',
]);
export const IMPORT_HELP_STATUS_HEAD = 'Status codes';
export const IMPORT_HELP_STATUS_CODES: readonly (readonly [string, string])[] =
  Object.freeze([
    ['ACTIVE', 'Re-enables a disabled device'],
    ['DISABLED', 'Disables an active device'],
    ['DEPROVISION:<reason code>', 'Deprovisions an active or disabled device'],
  ]);
export const IMPORT_HELP_REASON_HEAD = 'Reason codes';
export const IMPORT_HELP_REASON_CODES: readonly (readonly [string, string])[] =
  Object.freeze([
    ['RETIRING_DEVICE', 'Retiring from fleet'],
    ['DIFFERENT_MODEL_REPLACEMENT', 'Different model replacement'],
    ['SAME_MODEL_REPLACEMENT', 'Same model replacement'],
    ['UPGRADE_TRANSFER', 'ChromeOS Flex upgrade transfer'],
  ]);
export const IMPORT_HELP_CODES_LINE =
  'Codes match in upper case, for example DEPROVISION:RETIRING_DEVICE.';

export const REVIEW_HELP_INTRO =
  'Validation checks the file against the current devices and writes a plan. Nothing reaches Google before Execute.';
export const REVIEW_HELP_PLAN_HEAD = 'Plan';
export const REVIEW_HELP_PLAN: readonly string[] = Object.freeze([
  'A validated plan expires 1 hour after validation. Validate the file again after that.',
  'Cancel import cancels the plan. Closing the dialog keeps the plan open until it expires.',
]);
export const REVIEW_HELP_EXECUTE_HEAD = 'Execute';
export const REVIEW_HELP_EXECUTE: readonly string[] = Object.freeze([
  'Execute runs the valid rows only. Rejected rows never run.',
  'Execute creates one update job for the field changes and one job for each status change. The status jobs start after the update job ends.',
  'Deprovision needs the typed word DEPROVISION.',
]);
export const REVIEW_HELP_REJECTED_HEAD = 'Rejected rows and warnings';
export const REVIEW_HELP_REJECTED: readonly string[] = Object.freeze([
  'Download rejected rows gives the rejected rows with their reasons. Correct them in the file, then import it again.',
  'A warning does not block Execute.',
  'Other Google status values, such as DEPROVISIONED, request nothing.',
]);

/**
 * The grid line of an open plan (design section 9, behavior 7). The grid that shows state 26 owns
 * the placement; this card drafts the sentence.
 */
export function gridOpenPlanLine(
  importDisplayId: string,
  expiryLabel: string,
): string {
  return `Import ${importDisplayId} is validated and waits for Execute. It expires ${expiryLabel}.`;
}

/** The grid line after a refused import (design section 9, behavior 7). */
export function gridImportRefusalLine(reason: string): string {
  return `The last import did not start. ${reason}`;
}
