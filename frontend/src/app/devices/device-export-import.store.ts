import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  deviceExportReceiptSchema,
  jobDetailSchema,
  jobEventSchema,
  type DeviceExportRequest,
  type DeviceReportFieldId,
  type JobDetail,
  type JobExportPurpose,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { JobReader, type JobRevisions } from '../jobs/job-reader';
import { JobStream, type JobEventSource } from '../jobs/job-stream';
import { EXPORT_ROW_LIMIT } from './device-export-messages';

/** The surfaces of one dialog, in the order of design section 9 (states 02 to 08). */
export type DeviceExportDialogStep =
  | 'configure'
  | 'monitor'
  | 'file'
  | 'import';

/** The job that the browser tab returns to after the dialog closes (design section 9, behavior 6). */
export interface ActiveExportJob {
  displayId: string;
  purpose: JobExportPurpose;
}

/**
 * The state of the Export, Reports, and Import dialog of the Devices page (design section 9).
 *
 * The store lives for the browser tab, so the Bulk Actions entry returns to the person's running
 * or finished export after the dialog closes. Done releases that job.
 */
@Injectable({ providedIn: 'root' })
export class DeviceExportImportStore {
  private readonly auth = inject(AuthStore);
  /** Opens the jobs event stream. Tests replace it. */
  eventSource: (url: string) => JobEventSource = (url) => new EventSource(url);
  reopenDelay = 5000;
  streamTimeout = 60_000;

  readonly open = signal(false);
  readonly purpose = signal<JobExportPurpose>('edit');
  readonly step = signal<DeviceExportDialogStep>('configure');
  /** The selected device count of the configure step (states 02 and 07). */
  readonly count = signal(0);
  /** The displayed grid columns of a report, in grid order (state 07). */
  readonly columns = signal<readonly DeviceReportFieldId[]>([]);
  /** The help pane's topic, or null while the pane is closed (state 06). */
  readonly helpTopic = signal<'export' | 'report' | null>(null);
  readonly displayId = signal<string | null>(null);
  readonly job = signal<JobDetail | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly submitting = signal(false);
  readonly submitError = signal('');
  /** The job that the Bulk Actions entry returns to until Done releases it. */
  readonly activeJob = signal<ActiveExportJob | null>(null);

  /** The export request may start: the selection fits the row limit. */
  readonly overLimit = computed(() => this.count() > EXPORT_ROW_LIMIT);
  readonly canExport = computed(
    () => this.count() > 0 && !this.overLimit() && !this.submitting(),
  );
  /** A running export can be closed, and the job keeps running (state 04). */
  readonly running = computed(() => {
    const job = this.job();
    return !!job && !finished(job);
  });

  private readonly reader = new JobReader(() => this.read());
  private readonly events = new JobStream({
    open: () => this.eventSource('/api/jobs/events'),
    reopenDelay: () => this.reopenDelay,
    timeout: () => this.streamTimeout,
    opened: () => this.reader.opened(),
    changed: (data) => this.onEvent(data),
  });
  /** Increments on another person. A late answer is dropped. */
  private epoch = 0;
  private identity: string | null = null;

  constructor() {
    effect(() => {
      const identity = this.auth.session()?.identity.id ?? null;
      untracked(() => {
        if (this.identity !== null && identity !== this.identity) this.reset();
        this.identity = identity;
      });
    });
  }

  /** Export opens the configure step, or the tab's own job while it exists (behavior 6). */
  openExport(count: number, columns: readonly DeviceReportFieldId[] = []): void {
    this.purpose.set('edit');
    this.openFor('edit', count, columns);
  }

  /** Reports opens the configure step with the displayed grid columns (state 07). */
  openReport(count: number, columns: readonly DeviceReportFieldId[]): void {
    this.purpose.set('report');
    this.openFor('report', count, columns);
  }

  /**
   * Import opens its step. XF2 builds the import steps; until then the step holds no field and
   * the dialog says so in the hand-off.
   */
  openImport(): void {
    this.open.set(true);
    this.step.set('import');
    this.displayId.set(null);
    this.job.set(null);
    this.error.set('');
    this.submitError.set('');
    this.helpTopic.set(null);
  }

  /** The Activity row of an export opens the dialog at the job's step (behavior 5). */
  openJob(displayId: string): void {
    this.open.set(true);
    this.step.set('monitor');
    this.helpTopic.set(null);
    this.submitError.set('');
    this.job.set(null);
    this.error.set('');
    this.displayId.set(displayId);
    this.loading.set(true);
    this.events.start();
    void this.reader.request();
  }

  /** Closing keeps the job for the Bulk Actions entry (behavior 6). */
  close(): void {
    this.open.set(false);
    this.helpTopic.set(null);
    this.stop();
  }

  /** Done releases the job, so the next entry starts a new export (behavior 6). */
  done(): void {
    this.activeJob.set(null);
    this.close();
    this.step.set('configure');
    this.displayId.set(null);
    this.job.set(null);
    this.count.set(0);
    this.columns.set([]);
  }

  toggleHelp(topic?: 'export' | 'report'): void {
    if (this.helpTopic() !== null) {
      this.helpTopic.set(null);
      return;
    }
    this.helpTopic.set(
      topic ?? (this.purpose() === 'report' ? 'report' : 'export'),
    );
  }

  setHelpTopic(topic: 'export' | 'report'): void {
    this.helpTopic.set(topic);
  }

  /**
   * Submit `POST /api/devices/exports` (design sections 1 and 5). The dialog follows the job
   * by its display ID as soon as the receipt arrives.
   */
  async submit(request: DeviceExportRequest): Promise<boolean> {
    if (this.submitting()) return false;
    this.submitting.set(true);
    this.submitError.set('');
    const epoch = this.epoch;
    try {
      const response = await this.auth.request('/api/devices/exports', request);
      if (epoch !== this.epoch) return false;
      if (!response.ok) {
        this.submitError.set(await submitFailureText(response));
        return false;
      }
      const receipt = deviceExportReceiptSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!receipt.success) {
        this.submitError.set(
          'Campus Commander answered an unexpected export receipt. Try again.',
        );
        return false;
      }
      this.activeJob.set({
        displayId: receipt.data.displayId,
        purpose: request.purpose,
      });
      this.step.set('monitor');
      this.displayId.set(receipt.data.displayId);
      this.job.set(null);
      this.error.set('');
      this.events.start();
      void this.reader.request();
      return true;
    } catch {
      if (epoch === this.epoch)
        this.submitError.set(
          'Cannot reach Campus Commander. The export did not start.',
        );
      return false;
    } finally {
      this.submitting.set(false);
    }
  }

  private openFor(
    purpose: JobExportPurpose,
    count: number,
    columns: readonly DeviceReportFieldId[],
  ): void {
    this.count.set(count);
    this.columns.set(columns);
    this.submitError.set('');
    this.helpTopic.set(null);
    this.open.set(true);
    const active = this.activeJob();
    if (active && active.purpose === purpose) {
      // The entry returns to the running or finished job of this tab.
      this.openJob(active.displayId);
      this.purpose.set(purpose);
      return;
    }
    this.step.set('configure');
    this.displayId.set(null);
    this.job.set(null);
    this.error.set('');
    this.loading.set(false);
    this.stop();
  }

  private stop(): void {
    this.loading.set(false);
    this.reader.stop();
    this.events.stop();
  }

  private reset(): void {
    this.epoch++;
    this.activeJob.set(null);
    this.reader.clear();
    this.events.stop();
    this.open.set(false);
    this.purpose.set('edit');
    this.step.set('configure');
    this.count.set(0);
    this.columns.set([]);
    this.helpTopic.set(null);
    this.displayId.set(null);
    this.job.set(null);
    this.loading.set(false);
    this.error.set('');
    this.submitting.set(false);
    this.submitError.set('');
  }

  /** One read of the open job (design section 9, states 04, 05, and 08). */
  private async read(): Promise<JobRevisions | null> {
    const displayId = this.displayId();
    if (!displayId) return [];
    const epoch = this.epoch;
    const path = `/api/jobs/${encodeURIComponent(displayId)}`;
    const current = () => epoch === this.epoch && this.displayId() === displayId;
    try {
      const response = await this.auth.request(path);
      if (!current()) return [];
      if (response.status === 404) {
        this.missing();
        return [];
      }
      if (!response.ok) {
        this.failed(false);
        return null;
      }
      const detail = jobDetailSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!current()) return [];
      if (!detail.success) {
        this.failed(false);
        return null;
      }
      this.job.set(detail.data);
      this.loading.set(false);
      this.error.set('');
      if (detail.data.exportSummary)
        this.purpose.set(detail.data.exportSummary.purpose);
      // The job names its own step: a published file opens the file card (behavior 5). An
      // import row opens the import step, which XF2 fills.
      if (this.open()) {
        if (detail.data.action === 'validate-device-import') this.step.set('import');
        else if (detail.data.action === 'export-devices')
          this.step.set(detail.data.exportFile ? 'file' : 'monitor');
      }
      return [{ jobId: detail.data.jobId, revision: detail.data.revision }];
    } catch {
      if (!current()) return [];
      this.failed(true);
      return null;
    }
  }

  private missing(): void {
    this.loading.set(false);
    this.job.set(null);
    this.error.set('This export no longer exists.');
  }

  private failed(offline: boolean): void {
    this.loading.set(false);
    this.error.set(
      offline
        ? 'Cannot reach Campus Commander. The export state may be out of date.'
        : 'The export state is unavailable.',
    );
  }

  private onEvent(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const result = jobEventSchema.safeParse(parsed);
    if (!result.success) return;
    const event = result.data;
    const current = this.job();
    if (
      current ? event.jobId !== current.jobId : event.displayId !== this.displayId()
    )
      return;
    this.reader.changed(event);
  }
}

function finished(job: JobDetail): boolean {
  return (
    job.status === 'completed' ||
    job.status === 'completed-with-errors' ||
    job.status === 'failed' ||
    job.status === 'cancelled' ||
    job.status === 'needs-review'
  );
}

/** The refusal of the export route (design sections 1 and 5). */
async function submitFailureText(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const reason = (body as { reason?: unknown } | null)?.reason;
  switch (response.status) {
    case 409:
      return 'The selection expired. Select the devices again, then export.';
    case 413:
      return 'The selection holds too many devices for one export.';
    case 422:
      return `An edit export holds at most ${EXPORT_ROW_LIMIT.toLocaleString('en-US')} devices. Filter the grid to fewer devices, then select them again.`;
    case 403:
      return 'You do not have permission to export these devices.';
    case 401:
      return 'Your session ended. Sign in again, then export.';
    default:
      return reason === 'nothing-selected'
        ? 'The selection holds no devices. Select the devices again.'
        : 'Campus Commander could not start the export. Try again.';
  }
}