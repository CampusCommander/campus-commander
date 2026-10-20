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
import type {
  DeviceUpdateJobReceipt,
  DeviceUpdatePreview,
  DeviceUpdateTarget,
} from '@campus/application-contracts';
import { formatTimestamp } from '../jobs/job-fields';
import {
  FROZEN_TARGETS_SENTENCE,
  approvedValueText,
  observedValueText,
  previewCountLine,
  previewMetaLine,
  previewTitle,
  staleWarning,
  targetDeviceText,
  targetNote,
  type FlowActionId,
  type FlowProblem,
  type FlowProblemKind,
} from './device-update-flow';
import { DeviceUpdateFlow } from './device-update-flow';
import {
  DeviceUpdateConfirmationStore,
  type ConfirmationReplay,
  type SubmittedConfirmation,
} from './device-update-confirmation.store';
import { DeviceUpdateProblem } from './device-update-problem';

/**
 * The frozen preview of design 2.3 (frame 97:21). It reads the summary and pages
 * every target, so the operator can inspect the exact scope before confirmation.
 */
@Component({
  selector: 'app-device-update-preview',
  imports: [MatButtonModule, DeviceUpdateProblem],
  templateUrl: './device-update-preview.html',
  styleUrl: './device-update-preview.css',
})
export class DeviceUpdatePreviewPage {
  readonly previewId = input.required<string>();
  private readonly flow = inject(DeviceUpdateFlow);
  private readonly confirmations = inject(DeviceUpdateConfirmationStore);
  private readonly router = inject(Router);

  protected readonly preview = signal<DeviceUpdatePreview | null>(null);
  protected readonly targets = signal<DeviceUpdateTarget[]>([]);
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
  protected readonly frozen = FROZEN_TARGETS_SENTENCE;
  /** A late answer for another preview is dropped. */
  private generation = 0;

  protected readonly title = computed(() => {
    const problem = this.problem();
    if (problem) return problem.title;
    const preview = this.preview();
    return preview ? previewTitle(preview) : 'Review the preview';
  });
  protected readonly subtitle = computed(() => {
    const problem = this.problem();
    if (problem) return problem.subtitle;
    const preview = this.preview();
    return preview
      ? `Frozen preview · Prepared ${formatTimestamp(preview.preparedAt)}`
      : 'Frozen preview';
  });
  protected readonly countLine = computed(() => {
    const preview = this.preview();
    return preview ? previewCountLine(preview) : '';
  });
  protected readonly metaLine = computed(() => {
    const preview = this.preview();
    return preview ? previewMetaLine(preview) : '';
  });
  protected readonly staleNote = staleWarning;
  protected readonly canContinue = computed(
    () => (this.preview()?.eligible ?? 0) > 0,
  );
  protected readonly observed = observedValueText;
  protected readonly approved = approvedValueText;
  protected readonly device = targetDeviceText;
  protected readonly note = targetNote;

  constructor() {
    effect(() => {
      const id = this.previewId();
      untracked(() => void this.load(id));
    });
  }

  /** Read the summary, then every target page in ordinal order. */
  async load(id: string): Promise<void> {
    const generation = ++this.generation;
    this.status.set('loading');
    this.preview.set(null);
    this.targets.set([]);
    this.problem.set(null);
    this.prepareDetail.set('');
    this.submitted.set(null);
    const summary = await this.flow.readPreview(id);
    if (generation !== this.generation) return;
    if (!summary.ok) {
      if (await this.recover(null, generation)) return;
      this.showProblem(summary.answer, summary.expiresAt);
      return;
    }
    const targets = await this.flow.readTargets(id);
    if (generation !== this.generation) return;
    if (!targets.ok) {
      if (await this.recover(summary.value.displayId, generation)) return;
      this.showProblem(
        targets.answer,
        targets.expiresAt,
        summary.value.displayId,
      );
      return;
    }
    // The summary counts every frozen target. An empty list contradicts it.
    if (summary.value.selected > 0 && targets.value.length === 0) {
      this.showProblem('preview-unavailable', null, summary.value.displayId);
      return;
    }
    this.preview.set(summary.value);
    this.targets.set(targets.value);
    this.status.set('ready');
  }

  protected editDraft(): void {
    void this.router.navigate(['/devices/update']);
  }

  protected continueToConfirmation(): void {
    if (!this.canContinue()) return;
    void this.router.navigate([
      '/devices/update/previews',
      this.previewId(),
      'confirm',
    ]);
  }

  /** Run one recovery action of the problem card. */
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

  /** Resolve a retained confirmation before an expired or failed preview stands. */
  private async recover(
    displayId: string | null,
    generation: number,
  ): Promise<boolean> {
    const replay = await this.confirmations.resolvePending();
    if (generation !== this.generation) return true;
    return this.applyReplay(replay, displayId);
  }

  /**
   * Resolve a retained confirmation before this page claims that no job exists or
   * offers a replacement preview. Returns true when the replay replaced the
   * ordinary problem.
   */
  private async applyReplay(
    replay: ConfirmationReplay,
    displayId: string | null,
  ): Promise<boolean> {
    switch (replay.kind) {
      case 'none':
        return false;
      case 'expired':
        // The record cleared. The page presents the expired read it already has.
        return false;
      case 'receipt':
        await this.openReceipt(replay.receipt);
        return true;
      case 'problem':
        this.submitted.set(null);
        this.showProblem(replay.answer, replay.expiresAt, displayId);
        return true;
      case 'uncertain':
        this.submitted.set(replay.submitted);
        this.showProblem('confirm-uncertain', null, displayId);
        return true;
    }
  }

  /** Retry a failed replay, then fall back to the preview read. */
  private async retry(): Promise<void> {
    if (!this.submitted()) {
      void this.load(this.previewId());
      return;
    }
    if (this.preparing()) return;
    this.preparing.set(true);
    this.prepareDetail.set('');
    const replay = await this.confirmations.resolvePending();
    this.preparing.set(false);
    const displayId = this.preview()?.displayId ?? null;
    if (replay.kind === 'receipt') {
      await this.openReceipt(replay.receipt);
      return;
    }
    if (replay.kind === 'problem') {
      this.submitted.set(null);
      this.showProblem(replay.answer, replay.expiresAt, displayId);
      return;
    }
    if (replay.kind === 'uncertain') {
      this.submitted.set(replay.submitted);
      this.showProblem('confirm-uncertain', null, displayId);
      return;
    }
    // A 410 cleared the record, or another tab cleared it. Read the preview again.
    void this.load(this.previewId());
  }

  /** Prepare a new preview from the durable draft and open it (frame 104:434). */
  private async prepareNewPreview(): Promise<void> {
    if (this.preparing()) return;
    this.preparing.set(true);
    this.prepareDetail.set('');
    const preparation = await this.confirmations.preparePreview();
    this.preparing.set(false);
    const displayId = this.preview()?.displayId ?? null;
    switch (preparation.kind) {
      case 'receipt':
        await this.openReceipt(preparation.receipt);
        return;
      case 'preview':
        await this.router.navigate([
          '/devices/update/previews',
          preparation.preview.previewId,
        ]);
        return;
      case 'uncertain':
        this.submitted.set(preparation.submitted);
        this.showProblem('confirm-uncertain', null, displayId);
        return;
      case 'problem':
        this.showProblem(preparation.answer, preparation.expiresAt, displayId);
        if (preparation.answer === 'offline')
          this.prepareDetail.set(
            'Cannot reach Campus Commander. Your draft stays in this tab.',
          );
        return;
    }
  }

  private async openReceipt(receipt: DeviceUpdateJobReceipt): Promise<void> {
    await this.router.navigate(['/jobs', receipt.displayId, 'receipt']);
  }

  private showProblem(
    kind: FlowProblemKind,
    expiresAt: string | null,
    displayId: string | null = null,
  ): void {
    this.problem.set(this.flow.problem(kind, { displayId, expiresAt }));
    this.status.set('problem');
  }
}
