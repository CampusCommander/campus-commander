import {
  Component,
  ElementRef,
  Injector,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import type { JobOperation } from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { expiryClock } from '../expiry-clock';
import { devicesReadable } from '../devices/devices.store';
import {
  SHEET_OPEN_LABEL,
  SHEET_SAVED_LINE,
  exportExpiredText,
  exportFileFactList,
  exportFileHref,
} from '../devices/device-export-messages';
import {
  JOB_STATUS_LABELS,
  actionLabel,
  formatTimestamp,
  statusTone,
} from './job-fields';
import {
  attentionCount,
  beforeText,
  canReconcile,
  cancelBanner,
  cancelLine,
  cancelQuestion as buildCancelQuestion,
  cancelState,
  formatTime,
  identityLine,
  importPlanLine,
  isCommandOperation,
  isFinishedJob,
  jobCounters,
  latestActivityLine,
  operationChip,
  operationLabel,
  operationNumber,
  operationsFooter,
  observedText,
  outcomeNotes,
  pathParts,
  reasonLine,
  requestedText,
  rowFailureText,
  scopeHeading,
  type CancelQuestion,
  type JobCounter,
} from './job-detail-fields';
import { JobDetailStore, OPERATIONS_PAGE_SIZE } from './job-detail.store';
import { JobCancelDialog } from './job-cancel-dialog';

/**
 * One job of design 2.5 (frames 104:209, 231:4707, and 228:4524).
 * The page reads the job, its Latest activity, and the visible operations page.
 */
@Component({
  selector: 'app-job-detail',
  imports: [RouterLink, MatButtonModule, JobCancelDialog],
  templateUrl: './job-detail.html',
  styleUrl: './job-detail.css',
})
export class JobDetailPage implements OnChanges, OnDestroy {
  readonly displayId = input.required<string>();
  protected readonly store = inject(JobDetailStore);
  private readonly auth = inject(AuthStore);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The job and person whose data the open panel belongs to. */
  private shownJobId: string | null = null;
  private shownIdentity: string | null = null;
  /** The clock that flips a ready file to Expired at its deadline (UI-08). */
  private readonly now = expiryClock(
    () => this.store.job()?.exportFile?.expiresAt ?? null,
  );

  constructor() {
    // Another job or another person must not show the previous failure panel.
    effect(() => {
      const jobId = this.store.job()?.jobId ?? null;
      const identity = this.auth.session()?.identity.id ?? null;
      untracked(() => {
        if (jobId === this.shownJobId && identity === this.shownIdentity)
          return;
        this.shownJobId = jobId;
        this.shownIdentity = identity;
        this.inspecting.set(null);
      });
    });
  }

  /** The failed operation whose evidence panel is open. */
  protected readonly inspecting = signal<JobOperation | null>(null);
  protected readonly canReconcile = computed(() => {
    const job = this.store.job();
    return job ? canReconcile(this.auth, job) : false;
  });
  protected readonly canOpenDevices = computed(() =>
    devicesReadable(this.auth),
  );
  protected readonly statusLabel = (status: keyof typeof JOB_STATUS_LABELS) =>
    JOB_STATUS_LABELS[status];
  protected readonly statusTone = statusTone;
  protected readonly actionLabel = actionLabel;
  protected readonly formatTimestamp = formatTimestamp;
  protected readonly formatTime = formatTime;
  protected readonly operationLabel = operationLabel;
  protected readonly cancelBanner = cancelBanner;
  protected readonly operationChip = operationChip;
  protected readonly isCommandOperation = isCommandOperation;
  protected readonly beforeText = beforeText;
  protected readonly requestedText = requestedText;
  protected readonly observedText = observedText;
  protected readonly pathParts = pathParts;
  protected readonly rowFailureText = rowFailureText;
  protected readonly outcomeNotes = (
    operation: JobOperation,
  ): readonly string[] => {
    const job = this.store.job();
    return job ? outcomeNotes(job, operation) : [];
  };

  protected readonly heading = computed(() => {
    const job = this.store.job();
    return job ? actionLabel(job.action) : 'Job details';
  });
  protected readonly subtitle = computed(() => {
    const job = this.store.job();
    if (!job) return '';
    return `Job ${job.displayId} · ${JOB_STATUS_LABELS[job.status]}`;
  });
  protected readonly scope = computed(() => {
    const job = this.store.job();
    return job ? scopeHeading(job) : '';
  });
  protected readonly identity = computed(() => {
    const job = this.store.job();
    return job ? identityLine(job) : '';
  });
  /** The Deprovision reason line of the identity card (record D12). */
  protected readonly reason = computed(() => {
    const job = this.store.job();
    return job ? reasonLine(job) : null;
  });
  /**
   * The import line of a plan job: its import, and the status jobs that wait for an update job
   * (behavior 10, state 25).
   */
  protected readonly importPlan = computed(() => {
    const job = this.store.job();
    return job ? importPlanLine(job) : null;
  });
  protected readonly counters = computed<readonly JobCounter[]>(() => {
    const job = this.store.job();
    return job ? jobCounters(job) : [];
  });
  protected readonly attention = computed(() => {
    const job = this.store.job();
    return job ? attentionCount(job) : 0;
  });
  /** Whether the toolbar offers the cancel, shows it disabled, or hides it. */
  protected readonly cancelControl = computed(() => {
    const job = this.store.job();
    return job ? cancelState(this.auth, job) : 'none';
  });
  /** The question of the open cancel dialog. */
  protected readonly cancelQuestion = computed<CancelQuestion | null>(() => {
    const job = this.store.job();
    return job ? buildCancelQuestion(job) : null;
  });
  /** The request line of the identity card. It stays after the job ends. */
  protected readonly cancelIdentity = computed(() => {
    const job = this.store.job();
    return job ? cancelLine(job) : null;
  });
  /** The banner shows until every operation settles (choice 9). */
  protected readonly showCancelBanner = computed(() => {
    const job = this.store.job();
    return !!job?.cancelRequest && !isFinishedJob(job.status);
  });
  protected readonly cancelOpen = signal(false);
  protected readonly isRefresh = computed(
    () => this.store.job()?.action === 'refresh-inventory',
  );
  /** An export and a validation hide the counters and operation results (behavior 9). */
  protected readonly isExport = computed(
    () => this.store.job()?.action === 'export-devices',
  );
  protected readonly isImport = computed(
    () => this.store.job()?.action === 'validate-device-import',
  );
  /** The file card of a finished export. Notes answer 24 keeps it on the job page. */
  protected readonly SHEET_SAVED_LINE = SHEET_SAVED_LINE;
  protected readonly SHEET_OPEN_LABEL = SHEET_OPEN_LABEL;
  protected readonly exportFile = computed(() => {
    const job = this.store.job();
    if (!job) return null;
    const file = job.exportFile;
    if (!file) return null;
    // A Sheet never expires, so it holds no expiry (Drive slice design section 1).
    const expiresAt = file.expiresAt;
    const expired = expiresAt !== null && Date.parse(expiresAt) <= this.now();
    return {
      name: file.name,
      sheet: file.format === 'sheet',
      sheetUrl: file.sheetUrl,
      facts: exportFileFactList(file).join(' · '),
      expired,
      line:
        expiresAt === null
          ? file.format === 'sheet'
            ? SHEET_SAVED_LINE
            : ''
          : expired
            ? exportExpiredText(expiresAt)
            : `Available until ${formatTimestamp(expiresAt)}`,
      href: exportFileHref(job.displayId),
    };
  });
  protected readonly activity = computed(() => {
    const job = this.store.job();
    return job ? latestActivityLine(job) : '';
  });
  protected readonly footer = computed(() => {
    const job = this.store.job();
    if (!job) return '';
    return operationsFooter(job, {
      attention: this.store.attention(),
      pageIndex: this.store.shownIndex(),
      pageSize: OPERATIONS_PAGE_SIZE,
      shown: this.store.operations().length,
      hasNext: !!this.store.nextCursor(),
    });
  });

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['displayId']) void this.store.init(this.displayId());
  }

  ngOnDestroy(): void {
    this.store.leave();
  }

  protected refresh(): void {
    void this.store.refresh();
  }

  protected previous(): void {
    this.store.previous();
  }

  protected next(): void {
    this.store.next();
  }

  protected toggleAttention(): void {
    this.store.setAttention(!this.store.attention());
  }

  protected reconcile(operation: JobOperation): void {
    void this.store.reconcile(operation);
  }

  /** Open the question. A stored request, a held request, or a hidden control opens nothing. */
  protected requestCancel(): void {
    if (this.cancelControl() !== 'request' || this.store.cancelling()) return;
    this.cancelOpen.set(true);
  }

  /** "Keep job running" and Escape close the question and return focus (UI-09). */
  protected keepRunning(): void {
    this.cancelOpen.set(false);
    this.focusCancel();
  }

  /**
   * The request is not optimistic. The question stays open with its confirm disabled
   * until the answer, then focus returns to the control (UI-09).
   */
  protected async confirmCancel(): Promise<void> {
    await this.store.cancel();
    this.cancelOpen.set(false);
    this.focusCancel();
  }

  /**
   * Focus the cancel control after the question closes (UI-09). The control stays
   * focusable while disabled, and a job that disappeared focuses Back to jobs.
   */
  private focusCancel(): void {
    afterNextRender(
      () => {
        const host = this.host.nativeElement;
        const target =
          host.querySelector<HTMLElement>('#cancel-job') ??
          host.querySelector<HTMLElement>('#job-refresh') ??
          host.querySelector<HTMLElement>('#job-missing-back');
        target?.focus();
      },
      { injector: this.injector },
    );
  }

  protected counterText(counter: JobCounter): string {
    return counter.value === null ? '—' : counter.value.toLocaleString('en-US');
  }

  /**
   * One PATCH settles every field of an operation, so every row of that operation shares the
   * pending Reconcile state. A click marks one field row, and its siblings read the same mark.
   */
  protected isReconciling(operation: JobOperation): boolean {
    const marks = this.store.reconciling();
    if (marks.has(operation.operationId)) return true;
    const number = operationNumber(operation.operationId);
    if (number === null) return false;
    for (const operationId of marks)
      if (operationNumber(operationId) === number) return true;
    return false;
  }

  /** Inspect failure opens a panel inside the operations region (scope item 5). */
  protected inspect(operation: JobOperation): void {
    this.inspecting.set(operation);
    // The panel renders in the same change detection pass. Focus its Close control
    // after the DOM settles, so Escape and Tab continue from the panel (UI-09).
    afterNextRender(
      () =>
        setTimeout(() =>
          this.host.nativeElement
            .querySelector<HTMLButtonElement>('#failure-close')
            ?.focus(),
        ),
      { injector: this.injector },
    );
  }

  /** Closing returns focus to the Inspect failure control of the same row (UI-09). */
  protected closeInspect(): void {
    const operation = this.inspecting();
    this.inspecting.set(null);
    if (!operation) return;
    afterNextRender(
      () =>
        this.host.nativeElement
          .querySelector<HTMLElement>(
            `[data-operation="${operation.operationId}"]`,
          )
          ?.focus(),
      { injector: this.injector },
    );
  }
}
