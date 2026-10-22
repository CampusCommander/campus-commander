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
import { devicesReadable } from '../devices/devices.store';
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
  formatTime,
  identityLine,
  isCommandOperation,
  jobCounters,
  latestActivityLine,
  operationChip,
  operationLabel,
  operationNumber,
  operationsFooter,
  pathParts,
  requestedText,
  rowFailureText,
  scopeHeading,
  type JobCounter,
} from './job-detail-fields';
import { JobDetailStore, OPERATIONS_PAGE_SIZE } from './job-detail.store';

/**
 * One job of design 2.5 (frames 104:209, 231:4707, and 228:4524).
 * The page reads the job, its Latest activity, and the visible operations page.
 */
@Component({
  selector: 'app-job-detail',
  imports: [RouterLink, MatButtonModule],
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
  protected readonly operationChip = operationChip;
  protected readonly isCommandOperation = isCommandOperation;
  protected readonly beforeText = beforeText;
  protected readonly requestedText = requestedText;
  protected readonly pathParts = pathParts;
  protected readonly rowFailureText = rowFailureText;

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
  protected readonly counters = computed<readonly JobCounter[]>(() => {
    const job = this.store.job();
    return job ? jobCounters(job.progress) : [];
  });
  protected readonly attention = computed(() => {
    const job = this.store.job();
    return job ? attentionCount(job) : 0;
  });
  protected readonly isRefresh = computed(
    () => this.store.job()?.action === 'refresh-inventory',
  );
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
