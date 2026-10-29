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
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  DEVICE_REPORT_FIELD_LABELS,
  type DeviceExportRequest,
  type JobPhase,
} from '@campus/application-contracts';
import {
  JOB_STATUS_LABELS,
  exportRows,
  formatTimestamp,
} from '../jobs/job-fields';
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

/** One dot of the export phase list (state 04). */
export interface ExportPhaseView {
  name: string;
  label: string;
  detail: string;
  state: 'done' | 'current' | 'later' | 'failed' | 'stopped';
  /** The determinate bar of the current phase, or null when the phase has no total. */
  percent: number | null;
}

const thousands = (value: number) => value.toLocaleString('en-US');

/**
 * The one dialog of Export, Reports, and Import on the Devices page (design section 9).
 * It reuses the built device dialog shell: the scrim, cdkTrapFocus, and the 28 px surface of
 * `device-dialog.css`. States 02 to 05 and 07 take 480 px; the docked help of state 06 makes
 * 1000 px.
 */
@Component({
  selector: 'app-device-export-import-dialog',
  imports: [
    CdkTrapFocus,
    RouterLink,
    MatButtonModule,
    MatProgressBarModule,
    MatRadioModule,
    MatTooltipModule,
    DeviceExportHelp,
  ],
  templateUrl: './device-export-import-dialog.html',
  styleUrls: ['./device-dialog.css', './device-export-import-dialog.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeviceExportImportDialog {
  protected readonly store = inject(DeviceExportImportStore);
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
    return this.store.purpose() === 'report' ? REPORT_TITLE : EXPORT_TITLE;
  });
  /** The job ID of the subtitle, which links to the job page (states 04, 05, and 08). */
  protected readonly subtitleJob = computed(() => {
    const job = this.store.job();
    return job
      ? (this.store.displayId() ?? job.displayId)
      : this.store.displayId();
  });
  protected readonly subtitleStatus = computed(() => {
    const job = this.store.job();
    return job ? JOB_STATUS_LABELS[job.status] : 'Reading the job';
  });
  /** The selection line of a step that has no job yet (states 02 and 07). */
  protected readonly subtitleText = computed(() => {
    if (this.store.step() === 'import') return '';
    const count = this.store.count();
    return `${thousands(count)} selected ${count === 1 ? 'device' : 'devices'} · Not submitted`;
  });
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
    const expired = Date.parse(file.expiresAt) <= Date.now();
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
