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
  deviceImportExecuteAnswerSchema,
  deviceImportPlanCancelAnswerSchema,
  deviceImportReceiptSchema,
  deviceImportReportSchema,
  jobDetailSchema,
  jobEventSchema,
  jobOperationsPageSchema,
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
  type JobExecutionCounts,
  type JobExportPurpose,
  type JobImportPlan,
  type JobOperation,
  type JobSummary,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { JobReader, type JobRevisions } from '../jobs/job-reader';
import { LiveFeeds, type LiveFeedSubscription } from '../jobs/live-feeds';
import type { JobEventSource } from '../jobs/job-stream';
import { operationNumber } from '../jobs/job-detail-fields';
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
  executeFailureText,
  importSizeRefusal,
  importUploadFailureText,
  importUploadPath,
} from './device-import-messages';
import { type ResultsView } from './device-import-results';

/** The surfaces of one dialog, in the order of design section 9 (states 02 to 24). */
export type DeviceExportDialogStep =
  | 'configure'
  | 'monitor'
  | 'file'
  | 'import'
  | 'validation'
  | 'report'
  | 'confirm'
  | 'results';

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
  /** Opens the one live stream of the tab. Tests replace it. */
  eventSource: (url: string) => JobEventSource = (url) => new EventSource(url);

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

  /** The Execute confirmation of state 16: the typed phrase and its request. */
  readonly typedPhrase = signal('');
  readonly executeBusy = signal(false);
  readonly executeError = signal('');
  /** The jobs of an executed plan and the changes by outcome (design section 8). */
  readonly planJobs = signal<readonly JobSummary[]>([]);
  readonly executionCounts = signal<JobExecutionCounts | null>(null);
  /** The operations of the changes on the shown results page, by `<displayId>-<number>`. */
  readonly resultOps = signal<ReadonlyMap<string, JobOperation>>(new Map());
  readonly resultsLoading = signal(false);
  readonly resultsError = signal('');

  /** The plan holds a Deprovision, so Execute needs the typed phrase (section 7, step 2). */
  readonly planHasDeprovision = computed(
    () => (this.reportChanges()?.deprovision.length ?? 0) > 0,
  );
  /**
   * The complete change total of the plan: one line for each field change and each status
   * change (state 16 and the All changes pill of section 8). A status action counts its
   * changes, never the devices of an overlapping field change (R2).
   */
  readonly planChanges = computed(() => {
    const changes = this.reportChanges();
    if (!changes) return 0;
    return (
      changes.fieldChanges +
      changes.disable +
      changes.reenable +
      changes.deprovision.reduce((sum, entry) => sum + entry.devices, 0)
    );
  });
  /**
   * The devices that the plan changes: the proposed source rows of the report, one row per
   * device (state 16). A field change and a status change of the same device count once (R2).
   */
  readonly planDevices = computed(() => this.reportCounts()?.proposed ?? 0);
  /**
   * The number of status jobs that Execute creates: one job for each nonempty action or
   * reason group (section 7, step 8). The counts of a change summary are change counts, so
   * each nonempty action adds one job (R2).
   */
  readonly planStatusJobs = computed(() => {
    const changes = this.reportChanges();
    if (!changes) return 0;
    return (
      Number(changes.disable > 0) +
      Number(changes.reenable > 0) +
      changes.deprovision.length
    );
  });
  /** The views of the results table: All changes and Failed (design section 8, ruling 4). */
  readonly resultsView = computed<ResultsView>(() =>
    this.reportView() === 'failed' ? 'failed' : 'proposed',
  );
  /** The display IDs of the plan jobs, so an event of any of them refreshes the results. */
  readonly planJobIds = computed(() =>
    this.planJobs().map((job) => job.displayId),
  );

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
  /** The one shared connection of `/api/events` in this tab (finding 7). */
  private subscription: LiveFeedSubscription | null = null;
  /** The header check of the last chosen file, so a mode change rechecks the same file. */
  private chosenFile: File | null = null;
  /** Each file choice invalidates the header check of the earlier one. */
  private fileCheck = 0;
  /**
   * The pages that this dialog already read, by job, view, and page. A page keeps the answer
   * that produced it, so showing it again restores the report facts that answer carried (R4).
   */
  private readonly cache = new Map<
    string,
    Map<DeviceImportReportView, Map<number, DeviceImportReport>>
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
  /** The one results read of the page and its operations. Only its own answer writes. */
  private resultsRequest = 0;
  /** One complete results cycle runs at a time, and a request during it coalesces (R4). */
  private resultsBusy = false;
  private resultsQueued = false;
  private resultsFresh = false;
  private resultsWait: Promise<void> = Promise.resolve();
  /**
   * The page and tab that the results must show. A person's choice owns it until a read shows
   * that page, and a background reconcile re-reads it without replacing it (R4).
   */
  private resultsDesired: { page: number; view: ResultsView } | null = null;
  /** The request count of the running cycle, so a stopped cycle cannot clear a newer one. */
  private resultsCycle = 0;
  /** A feed open, a job reentry, or a child revision requires a results reconcile (R5). */
  private resultsReconcile = false;
  /** An event of a plan job reached the dialog, so the results read again (section 8). */
  private planEventPending = false;
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
      // The retained report or results of this import own its screen. Another flow's Done
      // resets the shared step, so reentry restores the step from its own facts (R3).
      const results = this.reportJob === active && this.step() === 'results';
      const report = this.reportJob === active && this.reportCounts() !== null;
      this.step.set(
        results
          ? 'results'
          : report || this.step() === 'report'
            ? 'report'
            : 'validation',
      );
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
    // A reentry reconciles the retained results page, even without an IMP revision change (R5).
    this.resultsReconcile = true;
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
    if (this.step() === 'report' || this.step() === 'results') {
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
    if (step === 'report' || step === 'confirm' || step === 'results')
      return 'review';
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

  /**
   * Behavior 5: the Activity row of an executed import opens its results (design section 8).
   * The IMP detail supplies the jobs and the counts, and one page of the report route supplies
   * the changes.
   */
  private async openResults(
    displayId: string,
    detail: JobDetail,
  ): Promise<void> {
    this.step.set('results');
    this.helpTopic.set(null);
    this.resetReportFacts();
    this.reportJob = displayId;
    this.reportRevision = detail.revision;
    this.cache.delete(displayId);
    // The first results read owns the whole cycle, so the read that opened it waits (R4).
    await this.requestResults('proposed', 0, true, true);
  }

  /** A tab of the report step or of the results table (states 14, 15, and 17b). */
  async setReportView(view: DeviceImportReportView): Promise<void> {
    if (view === this.reportView()) return;
    if (this.step() === 'results') {
      // The results table holds the two views of design section 8, and each tab starts on
      // the first page. A read in flight coalesces this tab into the next cycle (R4).
      if (view !== 'proposed' && view !== 'failed') return;
      await this.requestResults(view, 0, false, true);
      return;
    }
    await this.showReportPage(view, 0);
  }

  async nextReportPage(): Promise<void> {
    const pages = this.reportPages()[this.reportView()];
    if (this.reportPage() + 1 >= pages) return;
    if (this.step() === 'results') {
      await this.requestResults(
        this.resultsView(),
        this.reportPage() + 1,
        false,
        true,
      );
      return;
    }
    await this.showReportPage(this.reportView(), this.reportPage() + 1);
  }

  async previousReportPage(): Promise<void> {
    if (this.reportPage() === 0) return;
    if (this.step() === 'results') {
      await this.requestResults(
        this.resultsView(),
        this.reportPage() - 1,
        false,
        true,
      );
      return;
    }
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

  /* ---------- State 16: the Execute confirmation (design section 7) ---------- */

  /** Execute opens the confirmation of state 16. Only an open plan can run. */
  openConfirm(): void {
    if (
      this.plan()?.state !== 'open' ||
      this.actionBusy() ||
      this.executeBusy()
    )
      return;
    this.executeError.set('');
    this.typedPhrase.set('');
    this.step.set('confirm');
  }

  /** Back to review returns to the report that the confirmation came from (state 16). */
  backToReview(): void {
    this.executeError.set('');
    this.step.set('report');
  }

  /**
   * Execute runs the plan (design section 7). The route rechecks the permissions and the plan
   * lock, so its refusal names the check that stopped the plan. The answer is the executed plan;
   * the dialog then reads the IMP detail for the jobs and the counts of section 8.
   */
  async execute(): Promise<boolean> {
    const plan = this.plan();
    const displayId = this.displayId();
    if (!plan || !displayId || plan.state !== 'open' || this.executeBusy())
      return false;
    const requestId = ++this.actionRequest;
    const entry = this.importEntry;
    const epoch = this.epoch;
    const identity = this.identity;
    /** The answer belongs to the current principal and the import entry on screen. */
    const owned = () =>
      epoch === this.epoch &&
      identity === this.identity &&
      entry === this.importEntry &&
      this.displayId() === displayId;
    this.executeBusy.set(true);
    this.executeError.set('');
    try {
      const response = await this.auth.request(
        `${importBase(displayId)}/execute`,
        {
          planId: plan.planId,
          planRevision: plan.revision,
          typedPhrase: this.planHasDeprovision()
            ? this.typedPhrase().trim()
            : null,
        },
      );
      if (!owned()) return false;
      if (!response.ok) {
        const reason = await refusalReason(response);
        if (owned())
          this.executeError.set(executeFailureText(response.status, reason));
        return false;
      }
      const answer = deviceImportExecuteAnswerSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!owned()) return false;
      if (!answer.success) {
        this.executeError.set(
          'Campus Commander answered an unexpected execution. Try again.',
        );
        return false;
      }
      this.plan.set(answer.data.plan);
      this.step.set('results');
      this.helpTopic.set(null);
      this.resetReportFacts();
      this.reportJob = displayId;
      this.reportRevision = this.job()?.revision ?? null;
      this.acceptedPlan = {
        planId: answer.data.plan.planId,
        revision: answer.data.plan.revision,
      };
      this.cache.delete(displayId);
      this.reportView.set('proposed');
      this.reportPage.set(0);
      this.typedPhrase.set('');
      this.activeImport.set(displayId);
      // The jobs and the counts of the executed plan come with the next detail read.
      void this.reader.request();
      return true;
    } catch {
      if (owned()) {
        // A lost answer does not establish that the plan did not run. Keep the plan identity,
        // say that the outcome is unconfirmed, and read the durable job (R6).
        this.executeError.set(
          'Cannot reach Campus Commander. The plan may have run. Check this import before you execute again.',
        );
        void this.reader.request();
      }
      return false;
    } finally {
      if (this.actionRequest === requestId) this.executeBusy.set(false);
    }
  }

  /* ---------- States 17 and 17b: the execution results (design section 8) ---------- */

  /**
   * A results request. One complete cycle runs at a time, and a request that arrives during
   * a cycle coalesces into one later read of the desired page and tab (R4). A navigation
   * request sets that page and tab. A background reconcile re-reads it, and never replaces
   * it with the last page that a read showed.
   */
  private requestResults(
    view: ResultsView,
    page: number,
    fresh: boolean,
    navigation: boolean,
  ): Promise<void> {
    if (navigation) this.resultsDesired = { page, view };
    else if (this.resultsDesired === null) this.resultsDesired = { page, view };
    this.resultsFresh = this.resultsFresh || fresh;
    if (this.resultsBusy) {
      this.resultsQueued = true;
      return this.resultsWait;
    }
    this.resultsBusy = true;
    const cycle = ++this.resultsCycle;
    const run = this.runResults(cycle);
    // A cycle that finished on its first turn holds no wait for a successor.
    if (this.resultsBusy && cycle === this.resultsCycle) this.resultsWait = run;
    return run;
  }

  /** The one loop of a results cycle: its page, its tab total, and its operations. */
  private async runResults(cycle: number): Promise<void> {
    try {
      do {
        const target = this.resultsDesired;
        const fresh = this.resultsFresh;
        this.resultsQueued = false;
        this.resultsFresh = false;
        if (!target) break;
        if (fresh) {
          const displayId = this.reportJob;
          if (displayId) this.cache.delete(displayId);
        }
        await this.readResults(target.view, target.page);
      } while (
        this.resultsQueued &&
        this.step() === 'results' &&
        cycle === this.resultsCycle
      );
    } finally {
      if (cycle === this.resultsCycle) {
        this.resultsBusy = false;
        this.resultsQueued = false;
        this.resultsFresh = false;
        this.resultsWait = Promise.resolve();
      }
    }
  }

  /** One read of the shown results page: its lines, its tab counts, and its operations. */
  private async readResults(view: ResultsView, page: number): Promise<void> {
    if (this.step() !== 'results') return;
    const displayId = this.reportJob;
    if (!displayId || displayId !== this.displayId()) return;
    const token = ++this.resultsRequest;
    this.resultsError.set('');
    await this.showReportPage(view, page);
    if (token !== this.resultsRequest) return;
    await this.readTabTotals(displayId, ['failed']);
    if (token !== this.resultsRequest) return;
    await this.readPageOperations(displayId, token);
  }

  /** A newer revision of the plan refreshes the page and the operations on screen. */
  private refreshResults(): Promise<void> {
    // A background reconcile re-reads the chosen page and tab. It never replaces them with
    // the last page that a read showed (R4).
    return this.requestResults(
      this.resultsView(),
      this.reportPage(),
      true,
      false,
    );
  }

  /** A new import entry drops the cycle in flight and keeps its late answer out (R4). */
  private stopResults(): void {
    this.resultsCycle++;
    this.resultsRequest++;
    this.resultsBusy = false;
    this.resultsQueued = false;
    this.resultsFresh = false;
    this.resultsDesired = null;
    this.resultsWait = Promise.resolve();
  }

  /**
   * The operations of the changes on one page: one call per plan job of the page (design
   * section 8). A page needs at most seven calls. A late answer of an earlier page is dropped.
   */
  private async readPageOperations(
    displayId: string,
    token: number,
  ): Promise<void> {
    const groups = new Map<string, Set<number>>();
    for (const line of this.reportLines()) {
      if (!line.jobDisplayId || line.operationNumber === null) continue;
      const numbers = groups.get(line.jobDisplayId) ?? new Set<number>();
      numbers.add(line.operationNumber);
      groups.set(line.jobDisplayId, numbers);
    }
    if (groups.size === 0) {
      this.resultOps.set(new Map());
      return;
    }
    this.resultsLoading.set(true);
    const found = new Map<string, JobOperation>();
    let failed = false;
    const current = () =>
      token === this.resultsRequest &&
      displayId === this.reportJob &&
      displayId === this.displayId();
    await Promise.all(
      [...groups].map(async ([job, numbers]) => {
        const params = new URLSearchParams();
        params.set('number', [...numbers].sort((a, b) => a - b).join(','));
        params.set('limit', '1000');
        try {
          const response = await this.auth.request(
            `/api/jobs/${encodeURIComponent(job)}/operations?${params.toString()}`,
          );
          if (!current()) return;
          if (!response.ok) {
            failed = true;
            return;
          }
          const page = jobOperationsPageSchema.safeParse(
            await response.json().catch(() => null),
          );
          if (!current()) return;
          if (!page.success) {
            failed = true;
            return;
          }
          for (const operation of page.data.operations) {
            const number = operationNumber(operation.operationId);
            if (number !== null) found.set(`${job}-${number}`, operation);
          }
        } catch {
          if (current()) failed = true;
        }
      }),
    );
    if (!current()) return;
    this.resultOps.set(found);
    this.resultsLoading.set(false);
    if (failed)
      this.resultsError.set(
        'The result of each change is unavailable. Try again.',
      );
  }

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
        // A cached page owns the facts of its own answer. Showing it again restores the counts,
        // the change line, the plan, and the pager, and clears the error of the page that it
        // replaces (R4). The accepted-plan fence still rejects an older plan (R4).
        this.reportError.set('');
        if (this.reportJob === displayId && this.job()?.displayId === displayId)
          this.reportRevision = this.job()!.revision;
        this.applyReport(cached, true);
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
      // A page past the last page moves to the last page (design section 8). The report step
      // keeps its own answer instead, so a stale pager never reads a different page.
      const last = outcome.report.pageCount - 1;
      if (this.step() === 'results' && page > last) {
        await this.showReportPage(view, last);
        return;
      }
      this.reportError.set('');
      // A successful page restores the revision that its facts reflect.
      if (this.reportJob === displayId && this.job()?.displayId === displayId)
        this.reportRevision = this.job()!.revision;
      this.applyReport(outcome.report, true);
    } finally {
      if (requestId === this.reportPageRequest) this.reportLoading.set(false);
    }
  }

  /**
   * The count pills of the report step or of the results tabs (states 13 to 15, 17b, and 18 to
   * 22). A results read asks for the Failed pill only, because All changes is the page on screen.
   */
  private async readTabTotals(
    displayId: string,
    views: readonly DeviceImportReportView[] = ['rejected', 'warnings'],
  ): Promise<void> {
    const requestId = ++this.reportTotalsRequest;
    for (const view of views) {
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

  private applyReport(answer: DeviceImportReport, show: boolean): void {
    const displayId = this.reportJob;
    if (!displayId || displayId !== this.displayId()) return;
    const pages =
      this.cache.get(displayId) ??
      new Map<DeviceImportReportView, Map<number, DeviceImportReport>>();
    const views =
      pages.get(answer.view) ?? new Map<number, DeviceImportReport>();
    views.set(answer.page, answer);
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
    // The shown answer becomes the desired page, unless a newer choice is already queued (R4).
    if (this.step() === 'results' && !this.resultsQueued) {
      this.resultsDesired = {
        page: answer.page,
        view: answer.view === 'failed' ? 'failed' : 'proposed',
      };
    }
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
    this.typedPhrase.set('');
    this.executeBusy.set(false);
    this.executeError.set('');
    this.planJobs.set([]);
    this.executionCounts.set(null);
    this.resultsRequest++;
    this.planEventPending = false;
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
    this.stopResults();
    this.resultsReconcile = false;
    this.resultOps.set(new Map());
    this.resultsLoading.set(false);
    this.resultsError.set('');
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
    this.subscription = this.feeds.subscribe('/api/events', {
      open: () => this.eventSource('/api/events'),
      events: ['job-changed'],
      opened: () => {
        // Every open, first or after a reconnect, reconciles the retained results page (R5).
        this.resultsReconcile = true;
        this.reader.opened();
      },
      changed: (data) => this.onEvent(data),
    });
  }

  private stopFeed(): void {
    this.subscription?.close();
    this.subscription = null;
  }

  private isImportStep(): boolean {
    const step = this.step();
    return (
      step === 'import' ||
      step === 'validation' ||
      step === 'report' ||
      step === 'confirm' ||
      step === 'results'
    );
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
    // A results cycle owns the IMP screen while it runs. A detail read waits for the whole
    // cycle, so no detail read starts during a held page or operations read (R4).
    if (this.resultsBusy) await this.resultsWait;
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
          // The executed plan of an import owns the results of states 17 and 17b, and the jobs
          // and counts of section 8 come from this detail answer.
          this.planJobs.set(detail.data.planJobs ?? []);
          this.executionCounts.set(detail.data.executionCounts ?? null);
          const executed =
            detail.data.plan?.state === 'executed' ||
            (detail.data.planJobs?.length ?? 0) > 0;
          const priorStep = this.step();
          if (executed) {
            if (this.reportJob !== detail.data.displayId) {
              // The results belong to this job, not to the one that the dialog showed before.
              await this.openResults(detail.data.displayId, detail.data);
            } else {
              // The retained results own this job's screen, even when their facts need no read.
              this.step.set('results');
              if (
                this.reportView() !== 'proposed' &&
                this.reportView() !== 'failed'
              )
                this.reportView.set('proposed');
              // A child job can change without a change of the IMP revision, and a reopen of
              // the feed or a reentry leaves the shown page stale until it reads again (R5).
              const childChanged = (detail.data.planJobs ?? []).some(
                (job) => job.revision > this.reader.revision(job.displayId),
              );
              const changed =
                this.reportRevision !== detail.data.revision ||
                this.planEventPending ||
                this.resultsReconcile ||
                childChanged ||
                priorStep !== 'results';
              this.reportRevision = detail.data.revision;
              this.planEventPending = false;
              this.resultsReconcile = false;
              if (changed || this.reportCounts() === null) {
                // A newer revision may change a line, so the shown page reads again (section 8).
                await this.refreshResults();
              }
            }
          } else if (report) {
            if (this.reportJob !== detail.data.displayId) {
              // The report belongs to this job, not to the one that the dialog showed before.
              await this.openImportReport();
            } else if (
              priorStep === 'confirm' &&
              sameOpenPlan(this.plan(), detail.data.plan)
            ) {
              // The same frozen plan remains valid, so the confirmation and its typed phrase
              // stay. A late initial-open read or a reconnect never dismisses them (R1).
              this.reportRevision = detail.data.revision;
              if (this.reportCounts() === null && !this.reportLoading()) {
                await this.openImportReport();
              }
            } else {
              // The retained report owns this job's screen, even when its facts need no
              // read. Another flow's Done resets the shared step, so restore it here (R3).
              this.step.set('report');
              const planChanged = !samePlan(this.plan(), detail.data.plan);
              if (this.reportRevision !== detail.data.revision || planChanged) {
                // A newer revision or another plan may change the screen, so the shown page
                // reads again (R4).
                this.reportRevision = detail.data.revision;
                await this.refreshReportFacts();
              } else if (
                this.reportCounts() === null &&
                !this.reportLoading()
              ) {
                // A report that never loaded is read again on reentry (R4).
                await this.openImportReport();
              }
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
      return [
        { jobId: detail.data.jobId, revision: detail.data.revision },
        ...this.planJobs().map((job) => ({
          jobId: job.jobId,
          revision: job.revision,
        })),
      ];
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
    const own = current
      ? event.jobId === current.jobId
      : event.displayId === this.displayId();
    // The results of an executed plan follow every job of the plan, not only the IMP job.
    const plan =
      event.displayId === this.displayId() ||
      this.planJobIds().includes(event.displayId);
    if (!own && !plan) return;
    if (plan && event.revision > this.reader.revision(event.jobId))
      this.planEventPending = true;
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

/** The same plan identity: its ID, its revision, and its state (R1). */
function samePlan(
  current: JobImportPlan | null,
  reread: JobImportPlan | null,
): boolean {
  if (current === null || reread === null) return current === reread;
  return (
    current.planId === reread.planId &&
    current.revision === reread.revision &&
    current.state === reread.state
  );
}

/** The same frozen plan, still open: the confirmation that it produced stays valid (R1). */
function sameOpenPlan(
  current: JobImportPlan | null,
  reread: JobImportPlan | null,
): boolean {
  return (
    current !== null &&
    reread !== null &&
    current.state === 'open' &&
    reread.state === 'open' &&
    samePlan(current, reread)
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
