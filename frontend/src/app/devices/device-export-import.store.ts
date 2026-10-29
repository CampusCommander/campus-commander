import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  createCsvReader,
  deviceExportReceiptSchema,
  deviceImportPlanCancelAnswerSchema,
  deviceImportReceiptSchema,
  deviceImportReportSchema,
  jobDetailSchema,
  jobEventSchema,
  matchDeviceEditHeaders,
  DEVICE_IMPORT_MODE_DEFAULT,
  type DeviceExportRequest,
  type DeviceImportChangeSummary,
  type DeviceImportCounts,
  type DeviceImportMode,
  type DeviceImportReceipt,
  type DeviceImportRefresh,
  type DeviceImportReport,
  type DeviceImportReportLine,
  type DeviceImportReportView,
  type DeviceReportFieldId,
  type JobDetail,
  type JobExportPurpose,
  type JobImportPlan,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { JobReader, type JobRevisions } from '../jobs/job-reader';
import { LiveFeeds, type LiveFeedSubscription } from '../jobs/live-feeds';
import type { JobEventSource } from '../jobs/job-stream';
import {
  EXPORT_ROW_LIMIT,
  type ExportHelpTopic,
} from './device-export-messages';
import {
  IMPORT_EMPTY_FILE_REFUSAL,
  IMPORT_FILE_LIMIT_BYTES,
  IMPORT_HEADER_SAMPLE_BYTES,
  IMPORT_NOT_UTF8_REFUSAL,
  IMPORT_READ_FAILURE,
  importSizeRefusal,
  importUploadFailureText,
  importUploadPath,
} from './device-import-messages';

/** The surfaces of one dialog, in the order of design section 9 (states 02 to 24). */
export type DeviceExportDialogStep =
  | 'configure'
  | 'monitor'
  | 'file'
  | 'import'
  | 'validation'
  | 'report';

/** The header check of a chosen file (states 09 and 10). */
export interface ImportFileState {
  readonly file: File;
  readonly name: string;
  readonly sizeBytes: number;
  /** A file above the cap never uploads (design section 4). */
  readonly check: 'passed' | 'refused' | 'too-large';
  /** The header refusal, one sentence per paragraph (states 10 and 23). */
  readonly refusal: string;
  /** The columns of the file header, for the file facts. */
  readonly columns: number;
}

/** The job that the browser tab returns to after the dialog closes (design section 9, behavior 6). */
export interface ActiveExportJob {
  displayId: string;
  purpose: JobExportPurpose;
}

/** One read of the report: the answer, or the sentence that replaced it (R4). */
interface ReportRead {
  readonly report: DeviceImportReport | null;
  readonly error: string;
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
  readonly helpTopic = signal<ExportHelpTopic | null>(null);
  readonly displayId = signal<string | null>(null);
  readonly job = signal<JobDetail | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly submitting = signal(false);
  readonly submitError = signal('');
  /** The jobs that the Bulk Actions entries return to until Done releases them (behavior 6). */
  readonly activeJobs = signal<
    Readonly<Record<JobExportPurpose, ActiveExportJob | null>>
  >({ edit: null, report: null });
  /** The tab's own import, so Import returns to a running validation or an open plan. */
  readonly activeImport = signal<string | null>(null);

  /** The setup step of the import (states 09 and 10). */
  readonly mode = signal<DeviceImportMode>(DEVICE_IMPORT_MODE_DEFAULT);
  readonly importFile = signal<ImportFileState | null>(null);
  readonly importError = signal('');
  readonly readingFile = signal(false);
  /** The upload of states 09 and 12. */
  readonly uploading = signal(false);
  readonly uploadError = signal('');
  /** The person asked to stop before the receipt arrived (design section 9, td:760). */
  readonly stopRequested = signal(false);
  /** The mode and file name of the job, for the subtitle of a 480 px step (state 12). */
  readonly importName = signal('');

  /** The report step of states 13 to 15 and 18 to 22. */
  readonly reportCounts = signal<DeviceImportCounts | null>(null);
  readonly reportRefresh = signal<DeviceImportRefresh | null>(null);
  readonly reportChanges = signal<DeviceImportChangeSummary | null>(null);
  readonly plan = signal<JobImportPlan | null>(null);
  readonly reportView = signal<DeviceImportReportView>('proposed');
  readonly reportPage = signal(0);
  readonly reportLines = signal<readonly DeviceImportReportLine[]>([]);
  readonly reportTotals = signal<
    Readonly<Record<DeviceImportReportView, number | null>>
  >({ proposed: null, rejected: null, warnings: null, failed: null });
  readonly reportPages = signal<
    Readonly<Record<DeviceImportReportView, number>>
  >({ proposed: 1, rejected: 1, warnings: 1, failed: 1 });
  readonly reportLoading = signal(false);
  readonly reportError = signal('');
  /** The plan cancel and Validate again requests (states 19 and 20). */
  readonly actionBusy = signal(false);
  readonly actionError = signal('');

  /** The header check refuses a file, so the primary action stays disabled (state 10). */
  readonly importReady = computed(() => {
    const file = this.importFile();
    return file?.check === 'passed' && !this.uploading() && !this.readingFile();
  });
  /** A running validation can be stopped, and closing the dialog keeps it running. */
  readonly validating = computed(() => {
    const job = this.job();
    return (
      this.uploading() ||
      (this.step() === 'validation' && !!job && !finished(job))
    );
  });
  /** The changes of the current report page (states 13 to 15). */
  readonly reportShown = computed(() => this.reportLines().length);
  /**
   * The current accepted plan of this tab's import (design section 9, behavior 7). Once the
   * report holds facts for this import, its plan owns the note, so a cancelled plan or an
   * expired plan never reads as an open plan from the older job detail.
   */
  readonly importPlan = computed<JobImportPlan | null>(() => {
    const displayId = this.activeImport();
    if (!displayId) return null;
    if (this.reportJob === displayId && this.reportCounts() !== null)
      return this.plan();
    const job = this.job();
    return job?.displayId === displayId ? job.plan : null;
  });

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
  /** A finished job releases its entry through Done when it has no file (R4). */
  readonly jobFinished = computed(() => {
    const job = this.job();
    return !!job && finished(job);
  });

  private readonly reader = new JobReader(() => this.read());
  private readonly feeds = inject(LiveFeeds);
  /** The one shared connection of `/api/jobs/events` in this tab (finding 7). */
  private subscription: LiveFeedSubscription | null = null;
  /** The header check of the last chosen file, so a mode change rechecks the same file. */
  private chosenFile: File | null = null;
  /** Each file choice invalidates the header check of the earlier one. */
  private fileCheck = 0;
  /** The pages that this dialog already read, by job, view, and page. */
  private readonly cache = new Map<
    string,
    Map<DeviceImportReportView, Map<number, readonly DeviceImportReportLine[]>>
  >();
  /** Increments on another person. A late answer is dropped. */
  private epoch = 0;
  private identity: string | null = null;
  /** The one live submit. A late answer of an earlier request never touches this one. */
  private nextRequest = 0;
  private activeRequest: number | null = null;
  /** The import entry on screen. A late answer of an earlier entry is dropped. */
  private importEntry = 0;
  /** The one upload before its receipt. A late receipt of an earlier upload is dropped. */
  private uploadToken = 0;
  private uploadPending = false;
  /** The one plan or stop action. Only its own request clears its busy state. */
  private actionRequest = 0;
  /** The job whose report facts the signals hold, and the revision that they reflect. */
  private reportJob: string | null = null;
  private reportRevision: number | null = null;
  /** The page and tab-total reads that may still write (R4). */
  private reportPageRequest = 0;
  private reportTotalsRequest = 0;
  /** The plan revision that the report already accepted, so an older page cannot replace it. */
  private acceptedPlan: { planId: string; revision: number } | null = null;

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
  openExport(
    count: number,
    columns: readonly DeviceReportFieldId[] = [],
  ): void {
    this.purpose.set('edit');
    this.openFor('edit', count, columns);
  }

  /** Reports opens the configure step with the displayed grid columns (state 07). */
  openReport(count: number, columns: readonly DeviceReportFieldId[]): void {
    this.purpose.set('report');
    this.openFor('report', count, columns);
  }

  /**
   * Import opens its setup step, or the tab's own import while its validation runs or its plan
   * stays open (notes choice 14, eng-lead answer 3). A pending upload returns with its Stop
   * intent, so closing the dialog never starts a second upload (R3).
   */
  openImport(): void {
    this.purpose.set('edit');
    this.open.set(true);
    this.helpTopic.set(null);
    this.submitError.set('');
    this.error.set('');
    const active = this.activeImport();
    if (active) {
      // The dialog returns to the tab's own import, so the read lands on its own step.
      this.step.set(this.step() === 'report' ? 'report' : 'validation');
      this.openJob(active);
      return;
    }
    if (this.uploadPending || this.uploadError()) {
      // The upload that this tab started is still the one on screen. Its Stop intent stays.
      this.step.set(this.uploadPending ? 'validation' : 'import');
      this.startFeed();
      return;
    }
    // A fresh setup shows no earlier job, so a held read of that job cannot change this step (R5).
    this.detachImport();
    this.resetImport();
    this.step.set('import');
  }

  /** The Activity row of an export or an import opens the dialog at the job's step (behavior 5). */
  openJob(displayId: string): void {
    this.open.set(true);
    // An import step stays on its own step until the read names the job's step.
    if (!this.isImportStep()) this.step.set('monitor');
    this.helpTopic.set(null);
    this.submitError.set('');
    this.job.set(null);
    this.error.set('');
    this.displayId.set(displayId);
    this.loading.set(true);
    this.startFeed();
    void this.reader.request();
  }

  /** Closing keeps the job for the Bulk Actions entry (behavior 6). */
  close(): void {
    this.open.set(false);
    this.helpTopic.set(null);
    this.stop();
  }

  /** Done releases the current entry's job, so its next entry starts a new export (behavior 6). */
  done(): void {
    if (this.step() === 'report') {
      // Done belongs to this import: release it and clear the import entry.
      this.activeImport.set(null);
      this.resetImport();
    } else {
      // Done belongs to an export or a Reports entry. A pending import of this tab keeps
      // its receipt and its Stop intent, so this Done never resets the import state (R3).
      this.releaseActive(this.purpose());
    }
    this.close();
    this.step.set('configure');
    this.displayId.set(null);
    this.job.set(null);
    this.count.set(0);
    this.columns.set([]);
  }

  /** Import again starts a new import and releases the finished one (states 19 to 24). */
  importAgain(): void {
    this.activeImport.set(null);
    this.reader.stop();
    this.stopFeed();
    this.resetImport();
    this.displayId.set(null);
    this.job.set(null);
    this.loading.set(false);
    this.error.set('');
    this.step.set('import');
  }

  toggleHelp(topic?: ExportHelpTopic): void {
    if (this.helpTopic() !== null) {
      this.helpTopic.set(null);
      return;
    }
    this.helpTopic.set(topic ?? this.defaultHelpTopic());
  }

  setHelpTopic(topic: ExportHelpTopic): void {
    this.helpTopic.set(topic);
  }

  /** The help opens on the topic of the current step (composition choice 5). */
  private defaultHelpTopic(): ExportHelpTopic {
    const step = this.step();
    if (step === 'import' || step === 'validation') return 'import';
    if (step === 'report') return 'review';
    return this.purpose() === 'report' ? 'report' : 'export';
  }

  /**
   * Submit `POST /api/devices/exports` (design sections 1 and 5). The dialog follows the job
   * by its display ID as soon as the receipt arrives.
   */
  async submit(request: DeviceExportRequest): Promise<boolean> {
    if (this.submitting()) return false;
    const requestId = ++this.nextRequest;
    this.activeRequest = requestId;
    this.submitting.set(true);
    this.submitError.set('');
    const epoch = this.epoch;
    const identity = this.identity;
    /** The answer belongs to the current principal and the current request. */
    const owned = () => epoch === this.epoch && identity === this.identity;
    /** The dialog still shows the entry that sent this request. */
    const sameEntry = () =>
      owned() &&
      this.activeRequest === requestId &&
      this.open() &&
      this.step() === 'configure' &&
      this.purpose() === request.purpose;
    try {
      const response = await this.auth.request('/api/devices/exports', request);
      if (!owned()) return false;
      if (!response.ok) {
        const message = await submitFailureText(response);
        if (!owned()) return false;
        if (sameEntry()) this.submitError.set(message);
        return false;
      }
      const receipt = deviceExportReceiptSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!owned()) return false;
      if (!receipt.success) {
        if (sameEntry())
          this.submitError.set(
            'Campus Commander answered an unexpected export receipt. Try again.',
          );
        return false;
      }
      // The accepted job belongs to its entry, even after the dialog moved on.
      this.retain({
        displayId: receipt.data.displayId,
        purpose: request.purpose,
      });
      if (!sameEntry()) return true;
      this.step.set('monitor');
      this.displayId.set(receipt.data.displayId);
      this.job.set(null);
      this.error.set('');
      this.startFeed();
      void this.reader.request();
      return true;
    } catch {
      if (sameEntry())
        this.submitError.set(
          'Cannot reach Campus Commander. The export did not start.',
        );
      return false;
    } finally {
      // Only the owning request clears the fence of its successor.
      if (this.activeRequest === requestId) {
        this.activeRequest = null;
        this.submitting.set(false);
      }
    }
  }

  /**
   * The mode choice of state 09. The header check follows the mode: Sync changes needs the
   * Checksum column, and Sync all rows ignores it.
   */
  setImportMode(mode: DeviceImportMode): void {
    if (this.mode() === mode) return;
    this.mode.set(mode);
    if (this.chosenFile) void this.chooseImportFile(this.chosenFile);
  }

  /**
   * Read the first 64 KiB of the chosen file and check its header (states 09 and 10). A file
   * above 1 GiB refuses here and never reaches the upload (design section 4).
   */
  async chooseImportFile(file: File): Promise<void> {
    const check = ++this.fileCheck;
    const entry = this.importEntry;
    /** The answer belongs to the current entry and the current file choice. */
    const current = () =>
      check === this.fileCheck && entry === this.importEntry;
    this.chosenFile = file;
    this.importError.set('');
    this.uploadError.set('');
    this.stopRequested.set(false);
    this.readingFile.set(true);
    const base: ImportFileState = {
      file,
      name: file.name,
      sizeBytes: file.size,
      check: 'passed',
      refusal: '',
      columns: 0,
    };
    try {
      if (file.size > IMPORT_FILE_LIMIT_BYTES) {
        if (current())
          this.importFile.set({
            ...base,
            check: 'too-large',
            refusal: importSizeRefusal(file.size),
          });
        return;
      }
      const header = await readFileHeader(file);
      if (!current()) return;
      if (header === null) {
        this.importFile.set({
          ...base,
          check: 'refused',
          refusal: IMPORT_NOT_UTF8_REFUSAL,
        });
        return;
      }
      if (header.length === 0) {
        this.importFile.set({
          ...base,
          check: 'refused',
          refusal: IMPORT_EMPTY_FILE_REFUSAL,
        });
        return;
      }
      const match = matchDeviceEditHeaders(header, this.mode());
      this.importFile.set(
        match.ok
          ? { ...base, columns: header.length }
          : {
              ...base,
              check: 'refused',
              refusal: match.reason,
              columns: header.length,
            },
      );
    } catch {
      if (current())
        this.importFile.set({
          ...base,
          check: 'refused',
          refusal: IMPORT_READ_FAILURE,
        });
    } finally {
      if (current()) this.readingFile.set(false);
    }
  }

  /**
   * Upload the raw file as `text/csv` (design sections 1 and 4). The validation step follows the
   * receipt, and a stop that arrived first cancels the job as soon as its ID exists.
   */
  async startValidation(): Promise<boolean> {
    const chosen = this.importFile();
    if (!chosen || !this.importReady() || this.uploadPending) return false;
    const requestId = ++this.nextRequest;
    const token = ++this.uploadToken;
    const entry = this.importEntry;
    const epoch = this.epoch;
    const identity = this.identity;
    /** The answer belongs to the current principal, entry, and upload. */
    const owned = () => epoch === this.epoch && identity === this.identity;
    const sameUpload = () =>
      owned() && token === this.uploadToken && entry === this.importEntry;
    /** The dialog still shows this upload, so an answer may change its step. */
    const showing = () =>
      sameUpload() &&
      this.open() &&
      this.purpose() === 'edit' &&
      (this.step() === 'validation' || this.step() === 'import');
    this.uploadPending = true;
    this.activeRequest = requestId;
    this.uploading.set(true);
    this.uploadError.set('');
    this.stopRequested.set(false);
    this.actionError.set('');
    this.displayId.set(null);
    this.job.set(null);
    this.loading.set(false);
    this.error.set('');
    this.importName.set(chosen.name);
    this.step.set('validation');
    // The report of the entry before this upload is not this upload's report (R4).
    this.resetReportFacts();
    try {
      const response = await this.auth.request(
        importUploadPath(this.mode(), chosen.name),
        undefined,
        {
          raw: chosen.file,
          contentType: 'text/csv',
          timeoutMs: UPLOAD_TIMEOUT_MS,
        },
      );
      if (!sameUpload()) return false;
      if (!response.ok) {
        const reason = await refusalReason(response);
        if (!sameUpload()) return false;
        this.uploadPending = false;
        // The owning upload always releases its busy state, even when another entry shows (R3).
        this.uploading.set(false);
        this.uploadError.set(importUploadFailureText(response.status, reason));
        if (showing()) this.step.set('import');
        return false;
      }
      const receipt = deviceImportReceiptSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!sameUpload()) return false;
      if (!receipt.success) {
        this.uploadPending = false;
        this.uploading.set(false);
        this.uploadError.set(
          'Campus Commander answered an unexpected import receipt. Try again.',
        );
        if (showing()) this.step.set('import');
        return false;
      }
      this.accepted(receipt.data, showing());
      return true;
    } catch {
      if (sameUpload()) {
        this.uploadPending = false;
        this.uploading.set(false);
        this.uploadError.set(
          'Cannot reach Campus Commander. The file did not upload.',
        );
        if (showing()) this.step.set('import');
      }
      return false;
    } finally {
      if (this.activeRequest === requestId) this.activeRequest = null;
    }
  }

  /**
   * Stop validation sends `POST /api/jobs/{displayId}/cancel` (design section 9). A stop before
   * the receipt cancels the job when its ID arrives (design section 9, td:760).
   */
  async stopValidation(): Promise<boolean> {
    this.stopRequested.set(true);
    if (!this.displayId()) return true;
    return this.cancelJob();
  }

  /** One read of each view and page that the report shows (states 13 to 15 and 18 to 22). */
  async openImportReport(): Promise<void> {
    const displayId = this.displayId();
    const job = this.job();
    if (!displayId || !job) return;
    // A report belongs to one job. Another job replaces every fact and every cached page (R4).
    this.step.set('report');
    this.helpTopic.set(null);
    this.resetReportFacts();
    this.reportJob = displayId;
    this.reportRevision = job.revision;
    this.cache.delete(displayId);
    // A file whose every row was rejected opens on its rejected rows (state 22).
    const summary = job.importSummary;
    const first: DeviceImportReportView =
      summary && summary.proposed === 0 && summary.rejected > 0
        ? 'rejected'
        : 'proposed';
    await Promise.all([
      this.showReportPage(first, 0),
      this.readTabTotals(displayId),
    ]);
  }

  async setReportView(view: DeviceImportReportView): Promise<void> {
    if (view === this.reportView()) return;
    await this.showReportPage(view, 0);
  }

  async nextReportPage(): Promise<void> {
    const pages = this.reportPages()[this.reportView()];
    if (this.reportPage() + 1 >= pages) return;
    await this.showReportPage(this.reportView(), this.reportPage() + 1);
  }

  async previousReportPage(): Promise<void> {
    if (this.reportPage() === 0) return;
    await this.showReportPage(this.reportView(), this.reportPage() - 1);
  }

  /** Cancel import cancels the open plan (state 20). Nothing runs, and the report stays. */
  async cancelImport(): Promise<boolean> {
    const plan = this.plan();
    const displayId = this.displayId();
    if (!plan || !displayId || plan.state !== 'open' || this.actionBusy())
      return false;
    const requestId = ++this.actionRequest;
    const entry = this.importEntry;
    const epoch = this.epoch;
    const identity = this.identity;
    /** The answer belongs to the current principal and the report entry on screen. */
    const owned = () =>
      epoch === this.epoch &&
      identity === this.identity &&
      entry === this.importEntry &&
      this.displayId() === displayId;
    this.actionBusy.set(true);
    this.actionError.set('');
    try {
      const response = await this.auth.request(
        `${importBase(displayId)}/cancel`,
        { planId: plan.planId, planRevision: plan.revision },
      );
      if (!owned()) return false;
      if (!response.ok) {
        const message = await importActionFailureText(response);
        if (owned()) this.actionError.set(message);
        return false;
      }
      const answer = deviceImportPlanCancelAnswerSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!owned()) return false;
      if (!answer.success) {
        this.actionError.set(
          'Campus Commander answered an unexpected plan. Try again.',
        );
        return false;
      }
      this.plan.set(answer.data.plan);
      this.acceptedPlan = {
        planId: answer.data.plan.planId,
        revision: answer.data.plan.revision,
      };
      this.activeImport.set(displayId);
      // A page that left before this answer carries the older plan. Drop it, and read the
      // shown page again from the cancelled plan (R4).
      if (this.reportJob === displayId) {
        this.reportPageRequest++;
        this.reportTotalsRequest++;
        void this.refreshReportFacts();
      }
      return true;
    } catch {
      if (owned())
        this.actionError.set(
          'Cannot reach Campus Commander. The plan stays open.',
        );
      return false;
    } finally {
      // Only the owning request clears its own busy state, never a successor's (R1).
      if (this.actionRequest === requestId) this.actionBusy.set(false);
    }
  }

  /** Validate again starts a new validation from the stored file (state 19). */
  async revalidate(): Promise<boolean> {
    const displayId = this.displayId();
    if (!displayId || this.actionBusy()) return false;
    const requestId = ++this.actionRequest;
    const entry = this.importEntry;
    const epoch = this.epoch;
    const identity = this.identity;
    const owned = () =>
      epoch === this.epoch &&
      identity === this.identity &&
      entry === this.importEntry &&
      this.displayId() === displayId;
    this.actionBusy.set(true);
    this.actionError.set('');
    try {
      const response = await this.auth.request(
        `${importBase(displayId)}/revalidate`,
        {},
      );
      if (!owned()) return false;
      if (!response.ok) {
        const message = await importActionFailureText(response);
        if (owned()) this.actionError.set(message);
        return false;
      }
      const receipt = deviceImportReceiptSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!owned()) return false;
      if (!receipt.success) {
        this.actionError.set(
          'Campus Commander answered an unexpected import receipt. Try again.',
        );
        return false;
      }
      this.resetReportFacts();
      this.accepted(receipt.data, true);
      return true;
    } catch {
      if (owned())
        this.actionError.set(
          'Cannot reach Campus Commander. The plan stays expired.',
        );
      return false;
    } finally {
      if (this.actionRequest === requestId) this.actionBusy.set(false);
    }
  }

  /** The rejected rows download (design section 1). */
  readonly rejectedHref = computed(() => {
    const displayId = this.displayId();
    return displayId ? `${importBase(displayId)}/rejected` : '';
  });

  /**
   * A receipt accepted the upload. The job belongs to the tab's Import entry even when the dialog
   * moved to another entry, but only its own entry changes step (R3).
   */
  private accepted(receipt: DeviceImportReceipt, apply: boolean): void {
    this.uploadPending = false;
    // The owning upload ends here, whether or not the dialog still shows its entry (R3).
    this.uploading.set(false);
    this.activeImport.set(receipt.displayId);
    if (apply) {
      this.uploadError.set('');
      this.mode.set(receipt.mode);
      this.importName.set(receipt.name);
      this.displayId.set(receipt.displayId);
      this.job.set(null);
      this.error.set('');
      this.loading.set(false);
      this.step.set('validation');
      this.startFeed();
      void this.reader.request();
    }
    // The person asked to stop before the job existed (design section 9, td:760). The intent
    // survives a close, so the job that this upload created is the one that it cancels.
    if (this.stopRequested()) {
      this.stopRequested.set(false);
      void this.cancelJob(receipt.displayId);
    }
  }

  private async cancelJob(displayId = this.displayId()): Promise<boolean> {
    if (!displayId || this.actionBusy()) return false;
    const requestId = ++this.actionRequest;
    const entry = this.importEntry;
    const epoch = this.epoch;
    const identity = this.identity;
    /** The answer belongs to the current principal and the import entry that asked. */
    const owned = () =>
      epoch === this.epoch &&
      identity === this.identity &&
      entry === this.importEntry;
    /** The dialog still shows the import of this stop request. */
    const showing = () => owned() && this.displayId() === displayId;
    this.actionBusy.set(true);
    this.actionError.set('');
    try {
      const response = await this.auth.request(
        `/api/jobs/${encodeURIComponent(displayId)}/cancel`,
        {},
      );
      if (!owned()) return false;
      if (!response.ok) {
        const message = await importActionFailureText(response);
        if (showing()) this.actionError.set(message);
        return false;
      }
      if (showing()) void this.reader.request();
      return true;
    } catch {
      if (showing())
        this.actionError.set(
          'Cannot reach Campus Commander. The validation keeps running.',
        );
      return false;
    } finally {
      if (this.actionRequest === requestId) this.actionBusy.set(false);
    }
  }

  private async showReportPage(
    view: DeviceImportReportView,
    page: number,
  ): Promise<void> {
    const displayId = this.reportJob;
    if (!displayId || displayId !== this.displayId()) return;
    const requestId = ++this.reportPageRequest;
    /** The answer may still write: same job, same request (R4). */
    const current = () =>
      requestId === this.reportPageRequest &&
      displayId === this.reportJob &&
      displayId === this.displayId();
    this.reportLoading.set(true);
    try {
      const cached = this.cache.get(displayId)?.get(view)?.get(page);
      if (cached) {
        if (!current()) return;
        this.reportView.set(view);
        this.reportPage.set(page);
        this.reportLines.set(cached);
        return;
      }
      const outcome = await this.fetchReport(displayId, view, page);
      if (!current()) return;
      if (outcome.error !== '') {
        this.reportError.set(outcome.error);
        // The failed revision is not one that a successor read may trust, so a reentry or
        // a reconnect reads the shown page again (R4).
        if (this.reportJob === displayId) this.reportRevision = null;
        return;
      }
      if (!outcome.report) return;
      this.reportError.set('');
      // A successful page restores the revision that its facts reflect.
      if (this.reportJob === displayId && this.job()?.displayId === displayId)
        this.reportRevision = this.job()!.revision;
      this.applyReport(outcome.report, true);
    } finally {
      if (requestId === this.reportPageRequest) this.reportLoading.set(false);
    }
  }

  /** The tab counts of the rejected and warnings views need one page each (states 13 to 15). */
  private async readTabTotals(displayId: string): Promise<void> {
    const requestId = ++this.reportTotalsRequest;
    for (const view of ['rejected', 'warnings'] as const) {
      const outcome = await this.fetchReport(displayId, view, 0);
      if (requestId !== this.reportTotalsRequest) return;
      if (displayId !== this.reportJob || displayId !== this.displayId())
        return;
      if (outcome.error !== '') {
        // A tab total never replaces the shown page's error, and its success never clears
        // one (R4). A missing report never reads as a successful result.
        if (this.reportCounts() === null && this.reportError() === '')
          this.reportError.set(outcome.error);
        continue;
      }
      if (outcome.report) this.applyReport(outcome.report, false);
    }
  }

  /** A newer revision of the same job refreshes the facts of the page on screen (R4). */
  private async refreshReportFacts(): Promise<void> {
    const displayId = this.reportJob;
    if (!displayId || displayId !== this.displayId()) return;
    const view = this.reportView();
    const page = this.reportPage();
    this.cache.delete(displayId);
    await Promise.all([
      this.showReportPage(view, page),
      this.readTabTotals(displayId),
    ]);
  }

  private async fetchReport(
    displayId: string,
    view: DeviceImportReportView,
    page: number,
  ): Promise<ReportRead> {
    const epoch = this.epoch;
    const entry = this.importEntry;
    /** A late page of another job, entry, or principal is dropped. */
    const current = () =>
      epoch === this.epoch &&
      entry === this.importEntry &&
      displayId === this.reportJob &&
      displayId === this.displayId();
    const empty: ReportRead = { report: null, error: '' };
    try {
      const response = await this.auth.request(
        `${importBase(displayId)}/report?view=${view}&page=${page}`,
      );
      if (!current()) return empty;
      if (response.status === 404)
        return { report: null, error: 'This import no longer exists.' };
      if (!response.ok)
        return { report: null, error: 'The report is unavailable. Try again.' };
      const answer = deviceImportReportSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!current()) return empty;
      if (!answer.success)
        return {
          report: null,
          error: 'Campus Commander answered an unexpected report. Try again.',
        };
      return { report: answer.data, error: '' };
    } catch {
      return current()
        ? {
            report: null,
            error:
              'Cannot reach Campus Commander. The report may be out of date.',
          }
        : empty;
    }
  }

  private applyReport(
    answer: {
      view: DeviceImportReportView;
      page: number;
      lines: readonly DeviceImportReportLine[];
      total: number;
      pageCount: number;
      counts: DeviceImportCounts;
      refresh: DeviceImportRefresh;
      changes: DeviceImportChangeSummary;
      plan: JobImportPlan | null;
    },
    show: boolean,
  ): void {
    const displayId = this.reportJob;
    if (!displayId || displayId !== this.displayId()) return;
    const pages =
      this.cache.get(displayId) ??
      new Map<
        DeviceImportReportView,
        Map<number, readonly DeviceImportReportLine[]>
      >();
    const views = pages.get(answer.view) ?? new Map();
    views.set(answer.page, answer.lines);
    pages.set(answer.view, views);
    this.cache.set(displayId, pages);
    this.reportTotals.update((totals) => ({
      ...totals,
      [answer.view]: answer.total,
    }));
    this.reportPages.update((counts) => ({
      ...counts,
      [answer.view]: answer.pageCount,
    }));
    if (!show) return;
    // Only the shown page names the report facts, so a tab total read never replaces them.
    // An answer that predates the accepted plan keeps that plan (R4).
    const incoming = answer.plan;
    const accepted = this.acceptedPlan;
    const stalePlan =
      accepted !== null &&
      (incoming === null ||
        (incoming.planId === accepted.planId &&
          incoming.revision < accepted.revision));
    this.reportCounts.set(answer.counts);
    this.reportRefresh.set(answer.refresh);
    this.reportChanges.set(answer.changes);
    if (!stalePlan) {
      this.plan.set(incoming);
      this.acceptedPlan = incoming
        ? { planId: incoming.planId, revision: incoming.revision }
        : null;
    }
    this.reportView.set(answer.view);
    this.reportPage.set(answer.page);
    this.reportLines.set(answer.lines);
  }

  private resetImport(): void {
    // Every import state reset invalidates the reads and actions of the entry before it (R2, R3).
    this.importEntry++;
    this.fileCheck++;
    this.uploadToken++;
    this.actionRequest++;
    this.reportPageRequest++;
    this.reportTotalsRequest++;
    this.uploadPending = false;
    this.mode.set(DEVICE_IMPORT_MODE_DEFAULT);
    this.importFile.set(null);
    this.chosenFile = null;
    this.importError.set('');
    this.readingFile.set(false);
    this.uploading.set(false);
    this.uploadError.set('');
    this.stopRequested.set(false);
    this.importName.set('');
    this.resetReportFacts();
    this.actionBusy.set(false);
    this.actionError.set('');
    this.cache.clear();
  }

  /** The facts and the page of a report, without touching the job that owns them. */
  private resetReportFacts(): void {
    this.reportJob = null;
    this.reportRevision = null;
    this.acceptedPlan = null;
    this.reportCounts.set(null);
    this.reportRefresh.set(null);
    this.reportChanges.set(null);
    this.plan.set(null);
    this.reportView.set('proposed');
    this.reportPage.set(0);
    this.reportLines.set([]);
    this.reportTotals.set({
      proposed: null,
      rejected: null,
      warnings: null,
      failed: null,
    });
    this.reportPages.set({ proposed: 1, rejected: 1, warnings: 1, failed: 1 });
    this.reportLoading.set(false);
    this.reportError.set('');
  }

  /** Drop the job and its reads when fresh Import setup replaces them (R5). */
  private detachImport(): void {
    this.reader.stop();
    this.stopFeed();
    this.displayId.set(null);
    this.job.set(null);
    this.loading.set(false);
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
    const active = this.activeJobs()[purpose];
    if (active) {
      // The entry returns to the running or finished job of this tab and purpose.
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

  /** A job remains the entry's own until Done releases it (behavior 6). */
  private retain(job: ActiveExportJob): void {
    this.activeJobs.update((jobs) => ({ ...jobs, [job.purpose]: job }));
  }

  private releaseActive(purpose: JobExportPurpose): void {
    this.activeJobs.update((jobs) => ({ ...jobs, [purpose]: null }));
  }

  private stop(): void {
    this.loading.set(false);
    this.reader.stop();
    this.stopFeed();
  }

  /** The one shared feed of this tab. The dialog opens no connection of its own (finding 7). */
  private startFeed(): void {
    if (this.subscription) return;
    this.subscription = this.feeds.subscribe('/api/jobs/events', {
      open: () => this.eventSource('/api/jobs/events'),
      reopenDelay: () => this.reopenDelay,
      timeout: () => this.streamTimeout,
      events: ['job-changed'],
      opened: () => this.reader.opened(),
      changed: (data) => this.onEvent(data),
    });
  }

  private stopFeed(): void {
    this.subscription?.close();
    this.subscription = null;
  }

  private isImportStep(): boolean {
    const step = this.step();
    return step === 'import' || step === 'validation' || step === 'report';
  }

  private reset(): void {
    this.epoch++;
    this.activeRequest = null;
    this.activeJobs.set({ edit: null, report: null });
    this.activeImport.set(null);
    this.resetImport();
    this.reader.clear();
    this.stopFeed();
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
    const current = () =>
      epoch === this.epoch && this.displayId() === displayId;
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
      if (detail.data.exportSummary) {
        this.purpose.set(detail.data.exportSummary.purpose);
        // An export opened from Activity stays the entry's own until Done releases it.
        if (detail.data.action === 'export-devices')
          this.retain({
            displayId: detail.data.displayId,
            purpose: detail.data.exportSummary.purpose,
          });
      }
      // The job names its own step: a published file opens the file card (behavior 5). An
      // import row opens the validation or the report of that job (behavior 5).
      if (this.open()) {
        if (detail.data.action === 'validate-device-import') {
          this.activeImport.set(detail.data.displayId);
          this.importName.set(
            detail.data.importSource?.name ?? this.importName(),
          );
          // The job names its own mode, so a report opened from Activity reads its own line.
          if (detail.data.importSummary)
            this.mode.set(detail.data.importSummary.mode);
          const report =
            detail.data.status === 'completed' ||
            detail.data.status === 'completed-with-errors';
          if (report) {
            if (this.reportJob !== detail.data.displayId) {
              // The report belongs to this job, not to the one that the dialog showed before.
              void this.openImportReport();
            } else if (this.reportRevision !== detail.data.revision) {
              // A newer revision may change the plan, so the shown page reads again (R4).
              this.reportRevision = detail.data.revision;
              void this.refreshReportFacts();
            }
          } else {
            // A running, failed, or cancelled successor is not the report that the dialog
            // showed before. Its facts leave with the job that produced them (R4).
            if (this.reportJob !== null || this.step() === 'report')
              this.resetReportFacts();
            this.step.set('validation');
          }
        } else if (detail.data.action === 'export-devices') {
          this.step.set(detail.data.exportFile ? 'file' : 'monitor');
        }
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
      current
        ? event.jobId !== current.jobId
        : event.displayId !== this.displayId()
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

/** The browser gives the upload the deadline of the edge path (design section 4). */
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/** The routes of one import (design section 1). */
function importBase(displayId: string): string {
  return `/api/devices/imports/${encodeURIComponent(displayId)}`;
}

/**
 * The header row of the first 64 KiB of a file (design section 9, states 09 and 10). The sample
 * may end inside a quoted cell, so the record is taken from `push` and the reader is not closed.
 * A byte order mark is dropped by the reader. Null means the bytes are not UTF-8 text.
 */
async function readFileHeader(file: File): Promise<string[] | null> {
  const bytes = new Uint8Array(
    await file.slice(0, IMPORT_HEADER_SAMPLE_BYTES).arrayBuffer(),
  );
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, {
      stream: true,
    });
  } catch {
    return null;
  }
  const records = createCsvReader().push(text);
  return records.length > 0 ? records[0].cells : [];
}

/** The reason of a JSON refusal, for the upload and the plan routes. */
async function refusalReason(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null);
  const reason = (body as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' ? reason : null;
}

/**
 * The refusal of a stop, a plan cancel, or Validate again (design sections 6 and 7). The route
 * answers one of the four cancel refusals, or the plan refusals of Execute.
 */
async function importActionFailureText(response: Response): Promise<string> {
  const reason = await refusalReason(response);
  switch (reason) {
    case 'job-finished':
      return 'The validation already ended. Reload the page.';
    case 'nothing-to-stop':
      return 'The validation has nothing to stop. Reload the page.';
    case 'cancel-not-permitted':
      return 'You do not have permission to stop this validation.';
    case 'job-not-found':
      return 'This import no longer exists.';
    case 'plan-not-open':
      return 'The plan already ended. Reload the page.';
    case 'plan-expired':
      return 'The plan expired. Validate again.';
    case 'plan-revision':
      return 'The plan changed. Reload the page.';
    default:
      if (response.status === 401)
        return 'Your session ended. Sign in again, then import.';
      if (response.status === 403)
        return 'You do not have permission to change this import.';
      if (response.status === 410) return 'The plan expired. Validate again.';
      if (response.status === 409) return 'The plan changed. Reload the page.';
      return 'Campus Commander could not change this import. Try again.';
  }
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
