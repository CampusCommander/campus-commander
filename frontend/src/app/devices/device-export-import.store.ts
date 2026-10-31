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
  googleDriveAccessSchema,
  googleDriveCauseSchema,
  googleDriveImportReceiptSchema,
  googleDriveSessionSchema,
  googleDriveTabListSchema,
  jobDetailSchema,
  jobEventSchema,
  jobOperationsPageSchema,
  matchDeviceEditHeaders,
  DEVICE_IMPORT_MODE_DEFAULT,
  type DeviceExportFormat,
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
  type GoogleDriveAccess,
  type GoogleDriveCause,
  type GoogleDriveImportAccess,
  type GoogleDriveSession,
  type GoogleDriveTab,
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
  SHEET_ACCOUNT_ALERT,
  SHEET_UNREACHABLE_ALERT,
  type ExportHelpTopic,
} from './device-export-messages';
import {
  DRIVE_SESSION_RENEW_MS,
  IMPORT_DRIVE_ACCOUNT_ALERT,
  IMPORT_DRIVE_TABS_ALERT,
  IMPORT_DRIVE_UNREACHABLE_ALERT,
  IMPORT_DRIVE_WRONG_TYPE_ALERT,
  IMPORT_EMPTY_FILE_REFUSAL,
  IMPORT_FILE_LIMIT_BYTES,
  IMPORT_HEADER_SAMPLE_BYTES,
  IMPORT_NOT_UTF8_REFUSAL,
  IMPORT_PICKER_FAILED_ALERT,
  IMPORT_READ_FAILURE,
  executeFailureText,
  importDriveFailureText,
  importSizeRefusal,
  importUploadFailureText,
  importUploadPath,
} from './device-import-messages';
import {
  GoogleDrivePicker,
  type GooglePickerDocument,
} from './google-drive-picker';
import { GoogleDriveRead } from './google-drive-read';
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

/** The two Source cards of the import (states 05 to 13). */
export type ImportSource = 'upload' | 'drive';

/** The Drive file that the Picker returned, and the state of its header check (states 07 and 08). */
export interface DriveFileChoice {
  readonly fileId: string;
  readonly name: string;
  readonly kind: 'sheet' | 'csv';
  readonly sizeBytes: number | null;
  readonly lastEditedUtc: number | null;
  /** The tabs of a Sheet, in the order of the tab answer. Empty for a CSV file. */
  readonly tabs: readonly GoogleDriveTab[];
  /** The chosen tab of a Sheet. A CSV file carries null. */
  readonly tabId: number | null;
  /** `reading` keeps Start validation disabled until the header answer arrives. */
  readonly check: 'reading' | 'passed' | 'refused';
  /** The header refusal or the file note, one sentence per paragraph. */
  readonly refusal: string;
  /** The columns of the checked header, for the file facts. */
  readonly columns: number;
}

/** The job that the browser tab returns to after the dialog closes (design section 9, behavior 6). */
export interface ActiveExportJob {
  displayId: string;
  purpose: JobExportPurpose;
  /** The format of the job, so its phase list names the right last phase (states 02 and 03). */
  format: DeviceExportFormat;
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
  /** The Google Picker and the browser header reads of the Drive import (states 05 to 08). */
  private readonly picker = inject(GoogleDrivePicker);
  private readonly driveReader = inject(GoogleDriveRead);
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
  /** The chosen Format of the configure step (state 01). Reports keeps CSV (ruling 1). */
  readonly format = signal<DeviceExportFormat>('csv');
  /** The Sheet export access that `GET /api/google/drive` answers (states 01 and 04). */
  readonly driveAccess = signal<GoogleDriveAccess['sheetExport'] | null>(null);
  /** The access read of the open configure step. The card stays disabled until it answers. */
  readonly driveReading = signal(false);
  /** The alert of a refused or an unreachable Sheet access (states 04 and 12). */
  readonly driveAlert = signal('');
  /** The access read count, so a late answer cannot replace the answer of a newer open. */
  private driveRead = 0;
  /** The jobs that the Bulk Actions entries return to until Done releases them (behavior 6). */
  readonly activeJobs = signal<
    Readonly<Record<JobExportPurpose, ActiveExportJob | null>>
  >({ edit: null, report: null });
  /** The tab's own import, so Import returns to a running validation or an open plan. */
  readonly activeImport = signal<string | null>(null);

  /** The Source group of the import (states 05 to 13). Upload is the first card. */
  readonly importSource = signal<ImportSource>('upload');
  /** The file that the Picker returned, with its checked tab (states 07 and 08). */
  readonly driveFile = signal<DriveFileChoice | null>(null);
  /** The Drive access that `GET /api/google/drive` answers (states 05, 11, and 12). */
  readonly driveImportAccess = signal<GoogleDriveImportAccess | null>(null);
  /** The alert of a refused or an unreachable Drive (states 12 and 13). */
  readonly importDriveAlert = signal('');
  /** The tab read or the header check of a chosen Drive file runs. */
  readonly driveBusy = signal(false);
  /** The last Drive session. The browser sends its token to the Picker and to Google. */
  private driveSession: {
    readonly session: GoogleDriveSession;
    readonly expiresAt: number;
  } | null = null;
  /** The chosen Drive file's read count, so a late read cannot replace a newer choice. */
  private driveChoice = 0;

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
    if (this.importSource() === 'drive') {
      const file = this.driveFile();
      return (
        file?.check === 'passed' &&
        !this.uploading() &&
        !this.driveBusy() &&
        !this.submitting()
      );
    }
    const file = this.importFile();
    return file?.check === 'passed' && !this.uploading() && !this.readingFile();
  });
  /** The Drive card is enabled only when the access answer allows it (states 05 and 11). */
  readonly driveImportAvailable = computed(
    () => this.driveImportAccess()?.available === true,
  );
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
  /** Resolves the wait of the running cycle when that cycle releases the slot (R4). */
  private resultsDone: (() => void) | null = null;
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
   * The Format choice of the configure step (state 01). A Sheet stays unavailable while the
   * access read refuses it, so the step never offers a format that cannot run.
   */
  setFormat(format: DeviceExportFormat): void {
    if (format === 'sheet' && !this.sheetAvailable()) return;
    this.format.set(format);
    this.submitError.set('');
  }

  /** The Sheet export is available when the access read answers at all (state 01). */
  readonly sheetAvailable = computed(
    () => this.driveAccess()?.available === true,
  );

  /**
   * Read the Sheet export access of `GET /api/google/drive` (states 01 and 04). The read calls no
   * Google API, and a failed read names the reachability alert instead of a cause.
   */
  async readDriveAccess(): Promise<void> {
    const read = ++this.driveRead;
    this.driveReading.set(true);
    this.driveAlert.set('');
    this.importDriveAlert.set('');
    this.driveAccess.set(null);
    this.driveImportAccess.set(null);
    try {
      const response = await this.auth.request('/api/google/drive');
      if (read !== this.driveRead) return;
      if (!response.ok) {
        this.driveAlert.set(SHEET_UNREACHABLE_ALERT);
        this.importDriveAlert.set(IMPORT_DRIVE_UNREACHABLE_ALERT);
        return;
      }
      const answer = googleDriveAccessSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (read !== this.driveRead) return;
      if (!answer.success) {
        this.driveAlert.set(SHEET_UNREACHABLE_ALERT);
        this.importDriveAlert.set(IMPORT_DRIVE_UNREACHABLE_ALERT);
        return;
      }
      this.driveAccess.set(answer.data.sheetExport);
      this.driveImportAccess.set(answer.data.driveImport);
    } catch {
      if (read === this.driveRead) {
        this.driveAlert.set(SHEET_UNREACHABLE_ALERT);
        this.importDriveAlert.set(IMPORT_DRIVE_UNREACHABLE_ALERT);
      }
    } finally {
      if (read === this.driveRead) this.driveReading.set(false);
    }
  }

  /** A new configure step starts on CSV and reads the access again. */
  private resetDriveAccess(): void {
    this.driveRead++;
    this.format.set('csv');
    this.driveAccess.set(null);
    this.driveImportAccess.set(null);
    this.driveAlert.set('');
    this.importDriveAlert.set('');
    this.driveReading.set(false);
  }

  /** The Source card of the import. A disabled Drive card never takes the source (state 11). */
  setImportSource(source: ImportSource): void {
    if (source === 'drive' && !this.driveImportAvailable()) return;
    if (this.importSource() === source) return;
    this.importSource.set(source);
    this.importError.set('');
    this.uploadError.set('');
    this.importDriveAlert.set('');
  }

  /**
   * Open the Google Picker with a session token, the saved API key, and the project number
   * (design section 5). Cancel answers null and keeps state 05 unchanged.
   */
  async openDrivePicker(): Promise<void> {
    const entry = this.importEntry;
    const session = await this.driveToken();
    if (session === null || entry !== this.importEntry) return;
    this.importDriveAlert.set('');
    let document: GooglePickerDocument | null;
    try {
      document = await this.picker.open(
        session.accessToken,
        session.apiKey,
        session.appId,
      );
    } catch {
      if (entry === this.importEntry)
        this.importDriveAlert.set(IMPORT_PICKER_FAILED_ALERT);
      return;
    }
    if (entry !== this.importEntry || document === null) return;
    await this.chooseDriveFile(document, session);
  }

  /** Read the tabs of a Sheet and check the first tab (state 07). A CSV file needs no tab. */
  private async chooseDriveFile(
    document: GooglePickerDocument,
    session: GoogleDriveSession,
  ): Promise<void> {
    const choice = ++this.driveChoice;
    const entry = this.importEntry;
    const current = () =>
      choice === this.driveChoice && entry === this.importEntry;
    const spreadsheet = 'application/vnd.google-apps.spreadsheet';
    if (document.mimeType !== spreadsheet && document.mimeType !== 'text/csv') {
      this.driveFile.set({
        fileId: document.fileId,
        name: document.name,
        kind: 'csv',
        sizeBytes: null,
        lastEditedUtc: document.lastEditedUtc,
        tabs: [],
        tabId: null,
        check: 'refused',
        refusal: IMPORT_DRIVE_WRONG_TYPE_ALERT,
        columns: 0,
      });
      return;
    }
    if (document.mimeType === 'text/csv') {
      const base: DriveFileChoice = {
        fileId: document.fileId,
        name: document.name,
        kind: 'csv',
        sizeBytes: document.sizeBytes,
        lastEditedUtc: document.lastEditedUtc,
        tabs: [],
        tabId: null,
        check: 'reading',
        refusal: '',
        columns: 0,
      };
      if (
        document.sizeBytes !== null &&
        document.sizeBytes > IMPORT_FILE_LIMIT_BYTES
      ) {
        this.driveFile.set({
          ...base,
          check: 'refused',
          refusal: importSizeRefusal(document.sizeBytes),
        });
        return;
      }
      this.driveFile.set(base);
      this.driveBusy.set(true);
      try {
        const bytes = await this.driveReader.fileHead(
          session.accessToken,
          document.fileId,
        );
        if (!current()) return;
        this.checkDriveCsv(base, bytes);
      } catch {
        if (!current()) return;
        this.driveFile.set({
          ...base,
          check: 'refused',
          refusal: IMPORT_READ_FAILURE,
        });
      } finally {
        if (current()) this.driveBusy.set(false);
      }
      return;
    }
    this.driveFile.set({
      fileId: document.fileId,
      name: document.name,
      kind: 'sheet',
      sizeBytes: null,
      lastEditedUtc: document.lastEditedUtc,
      tabs: [],
      tabId: null,
      check: 'reading',
      refusal: '',
      columns: 0,
    });
    this.driveBusy.set(true);
    try {
      const response = await this.auth.request(
        `/api/google/drive/files/${encodeURIComponent(document.fileId)}/tabs`,
      );
      if (!current()) return;
      const answer = response.ok
        ? googleDriveTabListSchema.safeParse(
            await response.json().catch(() => null),
          )
        : null;
      if (answer === null || !answer.success) {
        this.driveFile.set({
          fileId: document.fileId,
          name: document.name,
          kind: 'sheet',
          sizeBytes: null,
          lastEditedUtc: document.lastEditedUtc,
          tabs: [],
          tabId: null,
          check: 'refused',
          refusal: IMPORT_DRIVE_TABS_ALERT,
          columns: 0,
        });
        return;
      }
      if (!current()) return;
      const first = answer.data.tabs[0];
      const base: DriveFileChoice = {
        fileId: document.fileId,
        name: document.name,
        kind: 'sheet',
        sizeBytes: null,
        lastEditedUtc: document.lastEditedUtc,
        tabs: answer.data.tabs,
        tabId: first.tabId,
        check: 'reading',
        refusal: '',
        columns: 0,
      };
      this.driveFile.set(base);
      await this.checkDriveSheet(base, first.title, session);
    } finally {
      if (current()) this.driveBusy.set(false);
    }
  }

  /** Another tab of the chosen Sheet (state 07). The header check follows the tab. */
  async chooseDriveTab(tabId: number): Promise<void> {
    const file = this.driveFile();
    if (file?.kind !== 'sheet' || file.tabId === tabId) return;
    const tab = file.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab) return;
    const session = await this.driveToken();
    if (session === null) return;
    const choice = ++this.driveChoice;
    const entry = this.importEntry;
    const current = () =>
      choice === this.driveChoice && entry === this.importEntry;
    const base: DriveFileChoice = {
      ...file,
      tabId,
      check: 'reading',
      refusal: '',
    };
    this.driveFile.set(base);
    this.driveBusy.set(true);
    try {
      await this.checkDriveSheet(base, tab.title, session);
    } finally {
      if (current()) this.driveBusy.set(false);
    }
  }

  /** A mode change rechecks the header of the chosen Drive file (states 07 and 08). */
  private async recheckDriveFile(): Promise<void> {
    const file = this.driveFile();
    if (!file || file.check === 'reading' || this.driveBusy()) return;
    const session = await this.driveToken();
    if (session === null) return;
    const choice = ++this.driveChoice;
    const entry = this.importEntry;
    const current = () =>
      choice === this.driveChoice && entry === this.importEntry;
    const base: DriveFileChoice = { ...file, check: 'reading', refusal: '' };
    this.driveFile.set(base);
    this.driveBusy.set(true);
    try {
      if (file.kind === 'sheet') {
        const tab = file.tabs.find(
          (candidate) => candidate.tabId === file.tabId,
        );
        if (tab === undefined) return;
        await this.checkDriveSheet(base, tab.title, session);
      } else {
        const bytes = await this.driveReader.fileHead(
          session.accessToken,
          file.fileId,
        );
        if (!current()) return;
        this.checkDriveCsv(base, bytes);
      }
    } catch {
      if (current())
        this.driveFile.set({
          ...base,
          check: 'refused',
          refusal:
            file.kind === 'sheet'
              ? IMPORT_DRIVE_TABS_ALERT
              : IMPORT_READ_FAILURE,
        });
    } finally {
      if (current()) this.driveBusy.set(false);
    }
  }

  /** Check the header of one Sheet tab with the browser read (ruling 2). */
  private async checkDriveSheet(
    file: DriveFileChoice,
    tabTitle: string,
    session: GoogleDriveSession,
  ): Promise<void> {
    const choice = this.driveChoice;
    const entry = this.importEntry;
    const current = () =>
      choice === this.driveChoice && entry === this.importEntry;
    let header: readonly string[];
    try {
      const rows = await this.driveReader.sheetRows(
        session.accessToken,
        file.fileId,
        tabTitle,
      );
      header = rows[0] ?? [];
    } catch {
      if (current())
        this.driveFile.set({
          ...file,
          check: 'refused',
          refusal: IMPORT_DRIVE_TABS_ALERT,
        });
      return;
    }
    if (!current()) return;
    this.applyDriveHeader(file, header);
  }

  /** The header facts of a Drive CSV, from its first 64 KiB (ruling 2). */
  private checkDriveCsv(file: DriveFileChoice, bytes: Uint8Array): void {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, {
        stream: true,
      });
    } catch {
      this.driveFile.set({
        ...file,
        check: 'refused',
        refusal: IMPORT_NOT_UTF8_REFUSAL,
      });
      return;
    }
    const records = createCsvReader().push(text);
    this.applyDriveHeader(file, records.length > 0 ? records[0].cells : []);
  }

  /** The shared header verdict of a Sheet tab and a Drive CSV file. */
  private applyDriveHeader(
    file: DriveFileChoice,
    header: readonly string[],
  ): void {
    this.driveFile.set(
      header.length === 0
        ? {
            ...file,
            check: 'refused',
            refusal: IMPORT_EMPTY_FILE_REFUSAL,
            columns: 0,
          }
        : (() => {
            const match = matchDeviceEditHeaders(header, this.mode());
            return match.ok
              ? { ...file, check: 'passed' as const, columns: header.length }
              : {
                  ...file,
                  check: 'refused' as const,
                  refusal: match.reason,
                  columns: header.length,
                };
          })(),
    );
  }

  /** The session token of the Picker and the browser reads. It renews before it expires. */
  private async driveToken(): Promise<GoogleDriveSession | null> {
    const held = this.driveSession;
    if (held && held.expiresAt - Date.now() > DRIVE_SESSION_RENEW_MS)
      return held.session;
    try {
      const response = await this.auth.request('/api/google/drive/session', {});
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const reason = (body as { reason?: unknown } | null)?.reason;
        const cause = googleDriveCauseSchema.safeParse(
          (body as { cause?: unknown } | null)?.cause,
        );
        this.refuseDriveSession(
          typeof reason === 'string' ? reason : null,
          cause.success ? cause.data : null,
        );
        return null;
      }
      const answer = googleDriveSessionSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!answer.success) {
        this.importDriveAlert.set(IMPORT_DRIVE_UNREACHABLE_ALERT);
        return null;
      }
      this.driveSession = {
        session: answer.data,
        expiresAt: Date.parse(answer.data.expiresAt),
      };
      return answer.data;
    } catch {
      this.importDriveAlert.set(IMPORT_DRIVE_UNREACHABLE_ALERT);
      return null;
    }
  }

  /** A refused session leaves Upload as the source (state 12). */
  private refuseDriveSession(
    reason: string | null,
    cause: GoogleDriveCause | null,
  ): void {
    this.driveSession = null;
    if (reason === 'drive-unavailable' && cause !== null) {
      this.driveImportAccess.set({ available: false, cause });
      if (cause === 'account')
        this.importDriveAlert.set(IMPORT_DRIVE_ACCOUNT_ALERT);
      // The card is now disabled, so Upload takes over and Start stays disabled until a file.
      this.importSource.set('upload');
      this.driveBusy.set(false);
      return;
    }
    this.importDriveAlert.set(IMPORT_DRIVE_UNREACHABLE_ALERT);
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
    this.resetDriveAccess();
    void this.readDriveAccess();
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
        const body: unknown = await response.json().catch(() => null);
        if (!owned()) return false;
        // A Sheet export that Google refused names its cause, and CSV stays available
        // (states 04 and 12, Drive slice design sections 1 and 6). The answer of an entry
        // that the dialog left changes no visible state: another flow may own the screen.
        const cause = driveRefusal(body);
        if (request.format === 'sheet' && cause !== null) {
          if (sameEntry()) {
            this.driveAccess.set({ available: false, cause });
            this.format.set('csv');
            if (cause === 'account') this.driveAlert.set(SHEET_ACCOUNT_ALERT);
          }
          return false;
        }
        // A Sheet export that Google could not reach keeps CSV available (section 6). Its
        // alert and format stay with the entry that submitted, like the refusal above.
        if (
          request.format === 'sheet' &&
          response.status === 503 &&
          reasonOf(body) === 'google-unavailable'
        ) {
          if (sameEntry()) {
            this.driveAlert.set(SHEET_UNREACHABLE_ALERT);
            this.format.set('csv');
          }
          return false;
        }
        const message = submitFailureText(response.status, body);
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
        format: request.format,
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
    if (this.importSource() === 'drive') {
      void this.recheckDriveFile();
      return;
    }
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
    if (this.importSource() === 'drive') return this.startDriveValidation();
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
   * Submit the Drive file by its ID and tab (design section 1). The API reads its own facts, so
   * the browser sends no name and no size.
   */
  private async startDriveValidation(): Promise<boolean> {
    const file = this.driveFile();
    if (!file || !this.importReady() || this.uploadPending) return false;
    const session = await this.driveToken();
    if (session === null) return false;
    const requestId = ++this.nextRequest;
    const token = ++this.uploadToken;
    const entry = this.importEntry;
    const epoch = this.epoch;
    const identity = this.identity;
    /** The answer belongs to the current principal, entry, and submit. */
    const owned = () => epoch === this.epoch && identity === this.identity;
    const sameSubmit = () =>
      owned() && token === this.uploadToken && entry === this.importEntry;
    /** The dialog still shows this submit, so an answer may change its step. */
    const showing = () =>
      sameSubmit() &&
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
    this.importName.set(file.name);
    this.step.set('validation');
    // The report of the entry before this submit is not this submit's report (R4).
    this.resetReportFacts();
    try {
      const response = await this.auth.request('/api/devices/imports/drive', {
        mode: this.mode(),
        fileId: file.fileId,
        tabId: file.kind === 'sheet' ? file.tabId : null,
      });
      if (!sameSubmit()) return false;
      if (!response.ok) {
        const reason = await refusalReason(response);
        if (!sameSubmit()) return false;
        this.uploadPending = false;
        this.uploading.set(false);
        this.uploadError.set(
          importDriveFailureText(response.status, reason, file.name),
        );
        if (showing()) this.step.set('import');
        return false;
      }
      const receipt = googleDriveImportReceiptSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!sameSubmit()) return false;
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
      if (sameSubmit()) {
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
    if (this.resultsBusy) {
      // A request during any cycle, a held detail read included, joins one later read (R4).
      this.resultsQueued = true;
      this.resultsFresh = this.resultsFresh || fresh;
      return this.resultsWait;
    }
    return this.startResultsCycle(fresh);
  }

  /** Claims the one results slot and runs one complete cycle of the page and its operations. */
  private startResultsCycle(fresh: boolean): Promise<void> {
    this.resultsBusy = true;
    this.resultsQueued = false;
    this.resultsFresh = fresh;
    const cycle = ++this.resultsCycle;
    this.holdResultsCycle();
    return this.runResults(cycle);
  }

  /**
   * A detail read of the results screen claims the one results slot before its IMP request.
   * A tab or pager choice during the held detail then queues behind the whole cycle (R4).
   * Returns the cycle that the read owns, or null when another cycle or screen owns it.
   */
  private claimDetailResults(): number | null {
    if (this.step() !== 'results') return null;
    if (this.reportJob === null) return null;
    if (this.resultsBusy) return null;
    this.resultsBusy = true;
    this.resultsQueued = false;
    this.resultsFresh = false;
    const cycle = ++this.resultsCycle;
    this.holdResultsCycle();
    return cycle;
  }

  /**
   * The page and operations phase of a cycle that a detail read owns. The read advances into
   * the same cycle, so it never waits on the slot that it holds (R4).
   */
  private async runOwnedResults(cycle: number): Promise<void> {
    if (cycle !== this.resultsCycle || !this.resultsBusy) {
      // A newer cycle replaced this read's claim, so the ordinary path owns the read (R4).
      await this.refreshResults();
      return;
    }
    this.resultsFresh = true;
    if (this.resultsDesired === null)
      this.resultsDesired = {
        page: this.reportPage(),
        view: this.resultsView(),
      };
    await this.runResults(cycle);
  }

  /**
   * Ends the slot that a detail read held. A navigation that arrived during the held detail
   * still runs, also when the detail itself asked for no read (R4).
   */
  private finishDetailResults(cycle: number): void {
    if (cycle !== this.resultsCycle || !this.resultsBusy) return;
    const queued = this.resultsQueued;
    const fresh = this.resultsFresh;
    this.endResultsCycle(cycle);
    if (queued && this.step() === 'results')
      void this.requestResults(
        this.resultsView(),
        this.reportPage(),
        fresh,
        false,
      );
  }

  /**
   * Ends the slot that a detail read held for a screen that another job replaces. The queued
   * choice of the old screen leaves with it, and the new job's first cycle owns its read (R4).
   */
  private releaseDetailResults(cycle: number): void {
    if (cycle !== this.resultsCycle || !this.resultsBusy) return;
    this.endResultsCycle(cycle);
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
      this.endResultsCycle(cycle);
    }
  }

  /** Releases the one results slot and resolves every request that waits on it (R4). */
  private endResultsCycle(cycle: number): void {
    if (cycle !== this.resultsCycle) return;
    this.resultsBusy = false;
    this.resultsQueued = false;
    this.resultsFresh = false;
    const done = this.resultsDone;
    this.resultsDone = null;
    this.resultsWait = Promise.resolve();
    done?.();
  }

  /** The wait of a cycle that a successor request can join. */
  private holdResultsCycle(): void {
    this.resultsWait = new Promise<void>((resolve) => {
      this.resultsDone = resolve;
    });
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
    const done = this.resultsDone;
    this.resultsDone = null;
    this.resultsWait = Promise.resolve();
    done?.();
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
  private accepted(
    receipt: Pick<DeviceImportReceipt, 'displayId' | 'mode' | 'name'>,
    apply: boolean,
  ): void {
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
    this.importSource.set('upload');
    this.importFile.set(null);
    this.driveFile.set(null);
    this.driveChoice++;
    this.driveBusy.set(false);
    this.importDriveAlert.set('');
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
    // A fresh configure step starts on CSV. An export reads the Sheet access (state 01); Reports
    // offers no Sheet at all (ruling 1).
    this.resetDriveAccess();
    if (purpose === 'edit') void this.readDriveAccess();
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
    this.resetDriveAccess();
  }

  /** One read of the open job (design section 9, states 04, 05, and 08). */
  private async read(): Promise<JobRevisions | null> {
    // A results cycle owns the IMP screen while it runs. A detail read waits for the whole
    // cycle, so no detail read starts during a held page or operations read (R4).
    while (this.resultsBusy) await this.resultsWait;
    // A detail read of the retained results claims the same slot before its IMP request, so a
    // tab or pager choice during the held detail queues behind the whole cycle (R4).
    const owned = this.claimDetailResults();
    try {
      return await this.readDetail(owned);
    } finally {
      // The read ends its own slot. A navigation that arrived during it still runs (R4).
      if (owned !== null) this.finishDetailResults(owned);
    }
  }

  /** The `GET /api/jobs/{displayId}` read that names the step and the facts of the job. */
  private async readDetail(owned: number | null): Promise<JobRevisions | null> {
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
        if (detail.data.action === 'export-devices') {
          const purpose = detail.data.exportSummary.purpose;
          const known = this.activeJobs()[purpose];
          this.retain({
            displayId: detail.data.displayId,
            purpose,
            // A running job names no format until its Sheet phase or its file exists (section 6),
            // so the format of this tab's own export stands.
            format:
              known?.displayId === detail.data.displayId
                ? known.format
                : exportFormatOf(detail.data),
          });
        }
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
              // This read drops its slot, and the new job's first cycle owns its own read (R4).
              if (owned !== null) this.releaseDetailResults(owned);
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
                // The read advances into the cycle that it owns, so it never waits on it (R4).
                if (owned !== null) await this.runOwnedResults(owned);
                else await this.refreshResults();
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
function submitFailureText(status: number, body: unknown): string {
  const reason = (body as { reason?: unknown } | null)?.reason;
  switch (status) {
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

/** The stored reason of a refusal body. */
function reasonOf(body: unknown): unknown {
  return (body as { reason?: unknown } | null)?.reason;
}

/** The cause of a `drive-unavailable` refusal (Drive slice design section 1). An export opens
 * no Picker, so `setup` never names its refusal. */
function driveRefusal(body: unknown): 'delegation' | 'account' | null {
  if (reasonOf(body) !== 'drive-unavailable') return null;
  const parsed = googleDriveCauseSchema.safeParse(
    (body as { cause?: unknown } | null)?.cause,
  );
  return parsed.success && parsed.data !== 'setup' ? parsed.data : null;
}

/**
 * The format of an export job that this tab did not submit. A Sheet ends in the `create-sheet`
 * phase and carries its file link, and a CSV file carries neither (Drive slice design section 6).
 */
function exportFormatOf(job: JobDetail): DeviceExportFormat {
  return job.exportFile?.format === 'sheet' ||
    job.phase?.name === 'create-sheet'
    ? 'sheet'
    : 'csv';
}
