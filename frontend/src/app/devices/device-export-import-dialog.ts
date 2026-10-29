import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatRadioModule } from '@angular/material/radio';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  DEVICE_IMPORT_MODE_LABELS,
  DEVICE_IMPORT_MODES,
  DEVICE_IMPORT_REPORT_PAGE_SIZE,
  DEVICE_REPORT_FIELD_LABELS,
  type DeviceExportRequest,
  type DeviceImportChange,
  type DeviceImportMode,
  type DeviceImportReportView,
  type JobPhase,
} from '@campus/application-contracts';
import {
  JOB_STATUS_LABELS,
  exportRows,
  formatTimestamp,
} from '../jobs/job-fields';
import { expiryClock } from '../expiry-clock';
import { DeviceExportImportStore } from './device-export-import.store';
import { DeviceExportHelp } from './device-export-help';
import {
  CREATE_REPORT_LABEL,
  CSV_FORMAT_LABEL,
  DOWNLOAD_CSV_LABEL,
  EXPORT_CANCELLED_LINE,
  EXPORT_CLOSING_LINE,
  EXPORT_TITLE,
  FORMAT_LABEL,
  HELP_LABEL,
  IMPORT_TITLE,
  REPORT_COLUMNS_LABEL,
  REPORT_TITLE,
  SHEET_FORMAT_LABEL,
  SHEET_FORMAT_NOTE,
  exportActionLabel,
  exportExpiredText,
  exportFailureText,
  exportFileFactList,
  exportLimitText,
} from './device-export-messages';
import {
  CANCEL_IMPORT_LABEL,
  DOWNLOAD_REJECTED_LABEL,
  IMPORT_AGAIN_LABEL,
  IMPORT_BROWSE_LABEL,
  IMPORT_DROP_LABEL,
  IMPORT_HEADER_PASSED_LINE,
  IMPORT_MODE_LABEL,
  IMPORT_SELECTED_FILE_LABEL,
  IMPORT_SOURCE_DRIVE_LABEL,
  IMPORT_SOURCE_LABEL,
  IMPORT_SOURCE_UPLOAD_LABEL,
  IMPORT_SUBMITTED_LINE,
  NOT_IN_INVENTORY_LABEL,
  NO_REPORT_LABEL,
  NO_UPDATE_LINE,
  NO_UPDATE_VIEW_LINE,
  PLAN_CANCELLED_LABEL,
  PLAN_EXPIRED_LABEL,
  PLAN_NO_CHANGE_LABEL,
  PLAN_OPEN_LABEL,
  REPORT_SYNC_ALL_ROWS_LINE,
  REPORT_TABS,
  REPORT_TAB_LABELS,
  STOP_VALIDATION_LABEL,
  VALIDATE_AGAIN_LABEL,
  VALIDATION_CLOSING_LINE,
  VALIDATION_FAILED_LINE,
  VALIDATION_STOPPED_LINE,
  executeActionLabel,
  formatBytes,
  importColumnCountText,
  importCounterRows,
  importFailureText,
  importPhases,
  importRefusalParagraphs,
  importStoppedReadsLine,
  nothingCanRunText,
  planCancelledText,
  planExpiredText,
  planExpiresText,
  reportChangeChip,
  reportChangeLine,
  reportChangeValues,
  reportCountTerms,
  reportOldestLine,
  reportPagerText,
  reportRefreshLine,
  type ReportValue,
} from './device-import-messages';
import { cutDevicePath } from './device-path-cut';

/** One dot of the export phase list (state 04). */
export interface ExportPhaseView {
  name: string;
  label: string;
  detail: string;
  state: 'done' | 'current' | 'later' | 'failed' | 'stopped';
  /** The determinate bar of the current phase, or null when the phase has no total. */
  percent: number | null;
}

/** One tab of the report (states 13 to 15). */
export interface ReportTabView {
  view: DeviceImportReportView;
  label: string;
  count: string;
}

const thousands = (value: number) => value.toLocaleString('en-US');

/**
 * The one dialog of Export, Reports, and Import on the Devices page (design section 9).
 * It reuses the built device dialog shell: the scrim, cdkTrapFocus, and the 28 px surface of
 * `device-dialog.css`. States 02 to 05, 07 to 10, 12, 23, and 24 take 480 px; the docked help of
 * states 06 and 11 makes 1000 px; states 13 to 22 take 1120 px with the help over the body.
 */
@Component({
  selector: 'app-device-export-import-dialog',
  imports: [
    CdkTrapFocus,
    RouterLink,
    MatButtonModule,
    MatProgressBarModule,
    MatRadioModule,
    MatTabsModule,
    MatTooltipModule,
    DeviceExportHelp,
  ],
  templateUrl: './device-export-import-dialog.html',
  styleUrls: [
    './device-dialog.css',
    './device-export-import-dialog.css',
    './device-import-dialog.css',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeviceExportImportDialog {
  protected readonly store = inject(DeviceExportImportStore);
  /** The clock that flips a ready file to Expired at its deadline (UI-08). */
  private readonly now = expiryClock(
    () => this.store.job()?.exportFile?.expiresAt ?? null,
  );
  /** The clock that flips an open plan to Expired at its deadline (state 19). */
  private readonly planNow = expiryClock(() => {
    const plan = this.store.plan();
    return plan?.state === 'open' ? plan.expiresAt : null;
  });
  /** The grid that the selection belongs to, and its tab (design section 1). */
  readonly gridId = input<DeviceExportRequest['gridId']>('devices');
  readonly tabId = input.required<string>();
  /** The grid sort of the export request (design section 1). */
  readonly sort = input<DeviceExportRequest['sort']>({
    field: 'serialNumber',
    direction: 'asc',
  });
  /** The dialog closed. The page returns focus to the Bulk Actions control (UI-09). */
  readonly closed = output<void>();

  protected readonly HELP_LABEL = HELP_LABEL;
  protected readonly FORMAT_LABEL = FORMAT_LABEL;
  protected readonly CSV_FORMAT_LABEL = CSV_FORMAT_LABEL;
  protected readonly SHEET_FORMAT_LABEL = SHEET_FORMAT_LABEL;
  protected readonly SHEET_FORMAT_NOTE = SHEET_FORMAT_NOTE;
  protected readonly REPORT_COLUMNS_LABEL = REPORT_COLUMNS_LABEL;
  protected readonly CREATE_REPORT_LABEL = CREATE_REPORT_LABEL;
  protected readonly DOWNLOAD_CSV_LABEL = DOWNLOAD_CSV_LABEL;
  protected readonly EXPORT_CLOSING_LINE = EXPORT_CLOSING_LINE;
  protected readonly EXPORT_CANCELLED_LINE = EXPORT_CANCELLED_LINE;

  protected readonly step = this.store.step;
  protected readonly title = computed(() => {
    if (this.store.step() === 'import') return IMPORT_TITLE;
    if (this.store.step() === 'validation' || this.store.step() === 'report')
      return IMPORT_TITLE;
    return this.store.purpose() === 'report' ? REPORT_TITLE : EXPORT_TITLE;
  });
  /** The job ID of the subtitle, which links to the job page (states 04, 05, and 12). */
  protected readonly subtitleJob = computed(() => {
    const job = this.store.job();
    return job
      ? (this.store.displayId() ?? job.displayId)
      : this.store.displayId();
  });
  protected readonly subtitleStatus = computed(() => {
    const job = this.store.job();
    if (job) return JOB_STATUS_LABELS[job.status];
    return this.isImport() ? 'Reading the job' : 'Reading the job';
  });
  /** The selection line of a step that has no job yet (states 02, 07, and 09). */
  protected readonly subtitleText = computed(() => {
    if (this.store.step() === 'import') return IMPORT_SUBMITTED_LINE;
    const count = this.store.count();
    return `${thousands(count)} selected ${count === 1 ? 'device' : 'devices'} · Not submitted`;
  });
  /**
   * The import line of the subtitle: the mode and the file (states 12, 19, and 23). A 480 px step
   * shows it on a second line, and the report joins it to one line.
   */
  protected readonly importLine = computed(() => {
    if (!this.isImport()) return '';
    const mode = DEVICE_IMPORT_MODE_LABELS[this.store.mode()];
    const name = this.store.job()?.importSource?.name ?? this.store.importName();
    return name ? `${mode} · ${name}` : mode;
  });
  private readonly isImport = computed(
    () =>
      this.store.step() === 'import' ||
      this.store.step() === 'validation' ||
      this.store.step() === 'report',
  );
  /** The 1120 px steps: the report (states 13 to 15 and 18 to 22). */
  protected readonly wide = computed(() => this.store.step() === 'report');
  protected readonly overLimit = this.store.overLimit;
  protected readonly limitText = computed(() =>
    exportLimitText(this.store.count()),
  );
  protected readonly actionLabel = computed(() =>
    this.store.purpose() === 'report'
      ? CREATE_REPORT_LABEL
      : exportActionLabel(this.store.count()),
  );
  protected readonly primaryDisabled = computed(
    () => this.store.overLimit() || this.store.submitting(),
  );
  protected readonly submitting = this.store.submitting;
  protected readonly submitError = this.store.submitError;
  protected readonly loadError = this.store.error;
  protected readonly helpOpen = computed(() => this.store.helpTopic() !== null);
  protected readonly helpTopic = computed(
    () => this.store.helpTopic() ?? 'export',
  );
  protected readonly reportColumns = computed(() =>
    this.store.columns().map((id) => DEVICE_REPORT_FIELD_LABELS[id]),
  );
  protected readonly jobFailed = computed(() => {
    const job = this.store.job();
    return job?.status === 'failed' || job?.status === 'needs-review';
  });
  protected readonly jobCancelled = computed(
    () => this.store.job()?.status === 'cancelled',
  );
  /** A finished job without a file releases its entry with Done (R4). */
  protected readonly jobFinished = this.store.jobFinished;
  protected readonly showFailure = computed(
    () => this.jobFailed() && !!this.store.job(),
  );
  protected readonly statusLabel = computed(() => {
    const job = this.store.job();
    return job ? JOB_STATUS_LABELS[job.status] : '';
  });
  protected readonly failureText = computed(() =>
    exportFailureText(this.store.job()?.failure ?? null),
  );
  protected readonly file = computed(() => {
    const file = this.store.job()?.exportFile ?? null;
    if (!file) return null;
    const expired = Date.parse(file.expiresAt) <= this.now();
    return {
      ...file,
      expired,
      facts: exportFileFactList(file),
      until: expired
        ? exportExpiredText(file.expiresAt)
        : `Available until ${formatTimestamp(file.expiresAt)}`,
    };
  });
  protected readonly fileHref = computed(() => {
    const displayId = this.store.displayId();
    return displayId
      ? `/api/devices/exports/${encodeURIComponent(displayId)}/file`
      : '';
  });

  /** The two dotted phases of an export, with the bar under the current one (state 04). */
  protected readonly phases = computed<readonly ExportPhaseView[]>(() => {
    const job = this.store.job();
    const phase = job?.phase ?? null;
    const outcome = {
      failed: job?.status === 'failed' || job?.status === 'needs-review',
      cancelled: job?.status === 'cancelled',
      completed: job?.status === 'completed',
    };
    const rows = job ? exportRows(job) : { written: 0, total: null };
    const writeState = phaseState(phase, 'write-rows', outcome);
    return [
      {
        name: 'write-rows',
        label: 'Write rows',
        detail:
          rows.total === null
            ? ''
            : `${thousands(rows.written)} of ${thousands(rows.total)}`,
        state: writeState,
        percent:
          writeState === 'current' && rows.total !== null && rows.total > 0
            ? Math.min(100, Math.round((rows.written / rows.total) * 100))
            : null,
      },
      {
        name: 'prepare-download',
        label: 'Prepare download',
        detail: '',
        state: phaseState(phase, 'prepare-download', outcome),
        percent: null,
      },
    ];
  });

  /** The setup step of states 09 and 10. */
  protected readonly MODE_LABEL = IMPORT_MODE_LABEL;
  protected readonly SOURCE_LABEL = IMPORT_SOURCE_LABEL;
  protected readonly UPLOAD_SOURCE_LABEL = IMPORT_SOURCE_UPLOAD_LABEL;
  protected readonly DRIVE_SOURCE_LABEL = IMPORT_SOURCE_DRIVE_LABEL;
  protected readonly DRIVE_SOURCE_NOTE = SHEET_FORMAT_NOTE;
  protected readonly DROP_LABEL = IMPORT_DROP_LABEL;
  protected readonly BROWSE_LABEL = IMPORT_BROWSE_LABEL;
  protected readonly SELECTED_FILE_LABEL = IMPORT_SELECTED_FILE_LABEL;
  protected readonly HEADER_PASSED_LINE = IMPORT_HEADER_PASSED_LINE;
  protected readonly START_VALIDATION_LABEL = 'Start validation';
  protected readonly modes = DEVICE_IMPORT_MODES.map((mode) => ({
    mode,
    label: DEVICE_IMPORT_MODE_LABELS[mode],
  }));
  protected readonly mode = this.store.mode;
  protected readonly importFile = this.store.importFile;
  protected readonly importReady = this.store.importReady;
  protected readonly importError = this.store.importError;
  protected readonly uploadError = this.store.uploadError;
  protected readonly readingFile = this.store.readingFile;
  protected readonly uploading = this.store.uploading;
  protected readonly actionError = this.store.actionError;
  protected readonly actionBusy = this.store.actionBusy;
  /** The facts of a chosen file: the size and the columns of its header (states 09 and 10). */
  protected readonly importFacts = computed(() => {
    const file = this.store.importFile();
    if (!file) return [];
    return [formatBytes(file.sizeBytes), importColumnCountText(file.columns)];
  });

  /** The validation step of states 12, 23, and 24. */
  protected readonly importPhases = computed(() =>
    importPhases(this.store.job()),
  );
  protected readonly importCounters = computed(() =>
    importCounterRows(this.store.job()),
  );
  protected readonly validationRunning = computed(() => {
    const job = this.store.job();
    return !job || (!this.validationEnded() && !this.store.uploading());
  });
  protected readonly validationEnded = computed(() => {
    const job = this.store.job();
    return (
      job?.status === 'completed' ||
      job?.status === 'completed-with-errors' ||
      job?.status === 'failed' ||
      job?.status === 'needs-review' ||
      job?.status === 'cancelled'
    );
  });
  protected readonly validationFailed = computed(
    () => this.jobFailed() && !this.store.job()?.plan,
  );
  protected readonly validationCancelled = computed(
    () => this.jobCancelled() && !this.store.job()?.plan,
  );
  protected readonly STOP_VALIDATION_LABEL = STOP_VALIDATION_LABEL;
  protected readonly VALIDATION_CLOSING_LINE = VALIDATION_CLOSING_LINE;
  protected readonly VALIDATION_STOPPED_LINE = VALIDATION_STOPPED_LINE;
  protected readonly VALIDATION_FAILED_LINE = VALIDATION_FAILED_LINE;
  protected readonly NO_REPORT_LABEL = NO_REPORT_LABEL;
  protected readonly IMPORT_AGAIN_LABEL = IMPORT_AGAIN_LABEL;
  protected readonly refusalParagraphs = computed(() => {
    if (!this.jobFailed()) return [];
    return importRefusalParagraphs(importFailureText(this.store.job()));
  });
  /** The cancel request of a stopped validation, and the reads that stay stored (state 24). */
  protected readonly cancelledLine = computed(() => {
    const request = this.store.job()?.cancelRequest;
    if (!request) return '';
    return `Cancellation requested by ${request.by.displayName} · ${formatTimestamp(
      request.at,
    )}`;
  });
  protected readonly stoppedReads = computed(() =>
    importStoppedReadsLine(this.store.reportRefresh()?.staleDevicesRead ?? 0),
  );

  /** The report step of states 13 to 15 and 18 to 22. */
  protected readonly counts = this.store.reportCounts;
  protected readonly countTerms = computed(() => {
    const counts = this.store.reportCounts();
    return counts ? reportCountTerms(counts) : [];
  });
  protected readonly changeLine = computed(() => {
    const changes = this.store.reportChanges();
    return changes ? reportChangeLine(changes) : '';
  });
  protected readonly refreshLine = computed(() => {
    const refresh = this.store.reportRefresh();
    return refresh ? reportRefreshLine(refresh) : '';
  });
  protected readonly oldestLine = computed(() =>
    reportOldestLine(this.store.reportRefresh()?.oldestObservedAt ?? null),
  );
  protected readonly syncAllRows = computed(
    () => this.store.mode() === 'sync-all-rows',
  );
  protected readonly SYNC_ALL_ROWS_LINE = REPORT_SYNC_ALL_ROWS_LINE;
  protected readonly DOWNLOAD_REJECTED_LABEL = DOWNLOAD_REJECTED_LABEL;
  protected readonly NOT_IN_INVENTORY_LABEL = NOT_IN_INVENTORY_LABEL;
  protected readonly CANCEL_IMPORT_LABEL = CANCEL_IMPORT_LABEL;
  protected readonly VALIDATE_AGAIN_LABEL = VALIDATE_AGAIN_LABEL;
  protected readonly view = this.store.reportView;
  protected readonly lines = this.store.reportLines;
  protected readonly pagerText = computed(() =>
    reportPagerText(
      this.store.reportView(),
      this.store.reportPage(),
      this.store.reportLines().length,
      this.store.reportTotals()[this.store.reportView()] ?? 0,
    ),
  );
  protected readonly tabs = computed<readonly ReportTabView[]>(() => {
    const totals = this.store.reportTotals();
    const counts = this.store.reportCounts();
    return REPORT_TABS.map((view) => {
      const total = totals[view] ?? (view === 'rejected' ? counts?.rejected : 0);
      return {
        view,
        label: REPORT_TAB_LABELS[view],
        count: thousands(total ?? 0),
      };
    });
  });
  protected readonly canPageBack = computed(() => this.store.reportPage() > 0);
  protected readonly canPageForward = computed(
    () =>
      this.store.reportPage() + 1 <
      this.store.reportPages()[this.store.reportView()],
  );
  protected readonly reportLoading = this.store.reportLoading;
  protected readonly reportError = this.store.reportError;
  protected readonly rejectedHref = this.store.rejectedHref;
  protected readonly hasRejected = computed(
    () => (this.store.reportCounts()?.rejected ?? 0) > 0,
  );
  /** The plan state of the action bar, with the expiry read from the clock (states 13 and 19). */
  protected readonly planView = computed(() => {
    const plan = this.store.plan();
    const counts = this.store.reportCounts();
    const now = this.planNow();
    const expired = !!plan && plan.state === 'open' && Date.parse(plan.expiresAt) <= now;
    const state = !plan
      ? counts?.rejected
        ? 'no-change'
        : 'no-change'
      : expired
        ? 'expired'
        : plan.state;
    return {
      state,
      chip:
        state === 'open'
          ? PLAN_OPEN_LABEL
          : state === 'expired'
            ? PLAN_EXPIRED_LABEL
            : state === 'cancelled'
              ? PLAN_CANCELLED_LABEL
              : PLAN_NO_CHANGE_LABEL,
      tone:
        state === 'open'
          ? 'tone-info'
          : state === 'expired'
            ? 'tone-warning'
            : state === 'cancelled'
              ? 'tone-neutral'
              : counts?.rejected
                ? 'tone-error'
                : 'tone-neutral',
      line:
        state === 'open' && plan
          ? planExpiresText(plan.expiresAt)
          : state === 'expired' && plan
            ? planExpiredText(plan.expiresAt)
            : state === 'cancelled' && plan
              ? planCancelledText(plan)
              : counts?.rejected
                ? nothingCanRunText(counts.rejected)
                : NO_UPDATE_LINE,
    };
  });
  protected readonly executeLabel = computed(() =>
    executeActionLabel(this.executeCount()),
  );
  protected readonly executeCount = computed(
    () =>
      (this.store.reportChanges()?.fieldChanges ?? 0) +
      (this.store.reportChanges()?.disable ?? 0) +
      (this.store.reportChanges()?.reenable ?? 0) +
      (this.store.reportChanges()?.deprovision ?? []).reduce(
        (sum, entry) => sum + entry.devices,
        0,
      ),
  );
  protected readonly NO_UPDATE_VIEW_LINE = NO_UPDATE_VIEW_LINE;
  protected readonly pageSize = DEVICE_IMPORT_REPORT_PAGE_SIZE;

  protected close(): void {
    this.store.close();
    this.closed.emit();
  }

  protected done(): void {
    this.store.done();
    this.closed.emit();
  }

  protected submit(): void {
    if (this.primaryDisabled()) return;
    void this.store.submit({
      gridId: this.gridId(),
      tabId: this.tabId(),
      purpose: this.store.purpose(),
      format: 'csv',
      sort: this.sort(),
      columns:
        this.store.purpose() === 'report' ? [...this.store.columns()] : [],
    });
  }

  /** The mode card of state 09 rechecks the chosen file with the mode's Checksum rule. */
  protected chooseMode(mode: DeviceImportMode): void {
    this.store.setImportMode(mode);
  }

  /** Choose CSV file opens the native picker, and a drop reads the dropped file. */
  protected picked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void this.store.chooseImportFile(file);
  }

  protected dropped(event: DragEvent): void {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) void this.store.chooseImportFile(file);
  }

  protected dragOver(event: DragEvent): void {
    event.preventDefault();
  }

  protected startValidation(): void {
    void this.store.startValidation();
  }

  protected stopValidation(): void {
    void this.store.stopValidation();
  }

  protected importAgain(): void {
    this.store.importAgain();
  }

  protected setView(view: DeviceImportReportView): void {
    void this.store.setReportView(view);
  }

  protected nextPage(): void {
    void this.store.nextReportPage();
  }

  protected previousPage(): void {
    void this.store.previousReportPage();
  }

  protected cancelImport(): void {
    void this.store.cancelImport();
  }

  protected revalidate(): void {
    void this.store.revalidate();
  }

  /** The cells of one report line (states 13 and 18). */
  protected values(line: DeviceImportChange): ReturnType<
    typeof reportChangeValues
  > {
    return reportChangeValues(line);
  }

  protected chip(line: DeviceImportChange) {
    return reportChangeChip(line);
  }

  /**
   * The cell text of a report value. A path cuts at a `/` boundary and keeps whole trailing
   * segments, and the tooltip of the cell holds the whole path (design section 9, ruling 3).
   */
  protected cellText(value: ReportValue): string {
    return value.path ? cutDevicePath(value.text, 32) : value.text;
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  }
}

/** The order of the two export phases (design section 2). */
const EXPORT_PHASES = ['write-rows', 'prepare-download'] as const;

/**
 * The state of one phase dot, from the job's stored phase and status.
 * A terminal job marks the phases before its stopping phase Done, the stopping phase
 * Failed or Stopped, and the phases after it untouched (R7).
 */
function phaseState(
  phase: JobPhase | null,
  name: string,
  outcome: { failed: boolean; cancelled: boolean; completed: boolean },
): ExportPhaseView['state'] {
  const index = EXPORT_PHASES.indexOf(name as (typeof EXPORT_PHASES)[number]);
  const reached = phase
    ? EXPORT_PHASES.indexOf(phase.name as (typeof EXPORT_PHASES)[number])
    : -1;
  if (outcome.failed || outcome.cancelled) {
    // A job without a phase never reached a phase: it stopped before writing a row.
    const stopping = reached >= 0 ? reached : 0;
    if (index < stopping) return 'done';
    if (index === stopping) return outcome.failed ? 'failed' : 'stopped';
    return 'later';
  }
  if (outcome.completed) return 'done';
  if (reached < 0) return index === 0 ? 'current' : 'later';
  if (index < reached) return 'done';
  if (index === reached) return 'current';
  return 'later';
}