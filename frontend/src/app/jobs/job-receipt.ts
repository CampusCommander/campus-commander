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
  private readonly router = inject(Router);

  protected readonly job = signal<JobDetail | null>(null);
  protected readonly status = signal<'loading' | 'ready' | 'problem'>(
    'loading',
  );
  protected readonly problem = signal<FlowProblem | null>(null);
  protected readonly preparing = signal(false);
  protected readonly prepareDetail = signal('');
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
        void this.load(this.displayId());
        break;
    }
  }

  private async prepareNewPreview(): Promise<void> {
    if (this.preparing()) return;
    this.preparing.set(true);
    this.prepareDetail.set('');
    const result = await this.flow.prepareFromDraft();
    this.preparing.set(false);
    if (result.ok) {
      await this.router.navigate([
        '/devices/update/previews',
        result.value.previewId,
      ]);
      return;
    }
    this.showProblem(result.answer, result.expiresAt);
    if (result.answer === 'offline')
      this.prepareDetail.set(
        'Cannot reach Campus Commander. Your draft stays in this tab.',
      );
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
