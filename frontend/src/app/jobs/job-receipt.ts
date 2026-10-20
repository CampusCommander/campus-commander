import {
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { jobDetailSchema, type JobDetail } from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import {
  flowExpiry,
  type FlowActionId,
  type FlowProblem,
  type FlowProblemKind,
} from '../devices/device-update-flow';
import { DeviceUpdateFlow } from '../devices/device-update-flow';
import {
  DeviceUpdateConfirmationStore,
  type SubmittedConfirmation,
} from '../devices/device-update-confirmation.store';
import { DeviceUpdateProblem } from '../devices/device-update-problem';
import {
  RECEIPT_HEADING,
  RECEIPT_NEXT_STEP,
  receiptCountLine,
  receiptSubtitle,
} from './job-receipt-messages';

/**
 * The durable receipt of design 2.4 (frame 104:74). The confirm answer and a reload
 * both read `GET /api/jobs/:displayId`, so the page never depends on navigation state.
 */
@Component({
  selector: 'app-job-receipt',
  imports: [MatButtonModule, DeviceUpdateProblem],
  templateUrl: './job-receipt.html',
  styleUrl: './job-receipt.css',
})
export class JobReceiptPage {
  readonly displayId = input.required<string>();
  private readonly auth = inject(AuthStore);
  private readonly flow = inject(DeviceUpdateFlow);
  private readonly confirmations = inject(DeviceUpdateConfirmationStore);
  private readonly router = inject(Router);

  protected readonly job = signal<JobDetail | null>(null);
  protected readonly status = signal<'loading' | 'ready' | 'problem'>(
    'loading',
  );
  protected readonly problem = signal<FlowProblem | null>(null);
  /** The retained confirmation that a failed replay must send again. */
  protected readonly submitted = signal<SubmittedConfirmation | null>(null);
  protected readonly preparing = signal(false);
  protected readonly prepareDetail = signal('');
  protected readonly busyLabel = computed(() =>
    this.submitted() ? 'Retrying confirmation…' : 'Preparing preview…',
  );
  protected readonly heading = RECEIPT_HEADING;
  protected readonly nextStep = RECEIPT_NEXT_STEP;
  private generation = 0;

  protected readonly title = computed(
    () => this.problem()?.title ?? 'Update job created',
  );
  protected readonly subtitle = computed(() => {
    const problem = this.problem();
    if (problem) return problem.subtitle;
    const job = this.job();
    return job ? receiptSubtitle(job) : 'Job receipt';
  });
  protected readonly countLine = computed(() => {
    const job = this.job();
    return job ? receiptCountLine(job) : '';
  });

  constructor() {
    effect(() => {
      const id = this.displayId();
      untracked(() => void this.load(id));
    });
  }

  /** Read the job. A reload and the first view follow the same route. */
  async load(displayId: string): Promise<void> {
    const generation = ++this.generation;
    this.status.set('loading');
    this.job.set(null);
    this.problem.set(null);
    this.submitted.set(null);
    this.prepareDetail.set('');
    try {
      const response = await this.auth.request(
        `/api/jobs/${encodeURIComponent(displayId)}`,
      );
      const body: unknown = await response.json().catch(() => null);
      if (generation !== this.generation) return;
      if (response.ok) {
        const job = jobDetailSchema.safeParse(body);
        if (job.success) {
          this.job.set(job.data);
          this.status.set('ready');
          return;
        }
        this.showProblem('job-unavailable', null);
        return;
      }
      this.showProblem(jobAnswer(response.status, body), flowExpiry(body));
    } catch {
      if (generation !== this.generation) return;
      this.showProblem('offline', null);
      this.prepareDetail.set(
        'Cannot reach Campus Commander. Your draft stays in this tab.',
      );
    }
  }

  protected backToDevices(): void {
    void this.router.navigate(['/devices']);
  }

  protected viewJob(): void {
    void this.router.navigate(['/jobs', this.displayId()]);
  }

  protected act(id: FlowActionId): void {
    switch (id) {
      case 'return-to-draft':
        void this.router.navigate(['/devices/update']);
        break;
      case 'prepare-new-preview':
        void this.prepareNewPreview();
        break;
      case 'back-to-devices':
        void this.router.navigate(['/devices']);
        break;
      case 'back-to-jobs':
        void this.router.navigate(['/jobs']);
        break;
      case 'open-google-connection':
        void this.router.navigate(['/google-connection']);
        break;
      case 'retry':
        void this.retry();
        break;
    }
  }

  private async retry(): Promise<void> {
    if (!this.submitted()) {
      void this.load(this.displayId());
      return;
    }
    if (this.preparing()) return;
    this.preparing.set(true);
    this.prepareDetail.set('');
    const replay = await this.confirmations.resolvePending();
    this.preparing.set(false);
    if (replay.kind === 'receipt') {
      await this.router.navigate([
        '/jobs',
        replay.receipt.displayId,
        'receipt',
      ]);
      return;
    }
    if (replay.kind === 'problem') {
      this.submitted.set(null);
      this.showProblem(replay.answer, replay.expiresAt);
      return;
    }
    if (replay.kind === 'uncertain') {
      this.submitted.set(replay.submitted);
      this.showProblem('confirm-uncertain', null);
      return;
    }
    void this.load(this.displayId());
  }

  private async prepareNewPreview(): Promise<void> {
    if (this.preparing()) return;
    this.preparing.set(true);
    this.prepareDetail.set('');
    const preparation = await this.confirmations.preparePreview();
    this.preparing.set(false);
    switch (preparation.kind) {
      case 'receipt':
        await this.router.navigate([
          '/jobs',
          preparation.receipt.displayId,
          'receipt',
        ]);
        return;
      case 'preview':
        await this.router.navigate([
          '/devices/update/previews',
          preparation.preview.previewId,
        ]);
        return;
      case 'uncertain':
        this.submitted.set(preparation.submitted);
        this.showProblem('confirm-uncertain', null);
        return;
      case 'problem':
        this.showProblem(preparation.answer, preparation.expiresAt);
        if (preparation.answer === 'offline')
          this.prepareDetail.set(
            'Cannot reach Campus Commander. Your draft stays in this tab.',
          );
        return;
    }
  }

  private showProblem(kind: FlowProblemKind, expiresAt: string | null): void {
    this.problem.set(this.flow.problem(kind, { expiresAt }));
    this.status.set('problem');
  }
}

/** The job read has its own 404 and 403 answers. */
function jobAnswer(status: number, body: unknown): FlowProblemKind {
  const reason = (body as { reason?: unknown } | null)?.reason;
  if (status === 410 && reason === 'preview-expired') return 'preview-expired';
  if (status === 404) return 'job-not-found';
  if (status === 403) return 'job-forbidden';
  return 'job-unavailable';
}
