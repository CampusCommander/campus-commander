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
import { MatCheckboxModule } from '@angular/material/checkbox';
import type {
  DeviceUpdatePreview,
  DeviceUpdateTarget,
} from '@campus/application-contracts';
import {
  acknowledgementLabel,
  confirmationHeading,
  confirmationMayExist,
  confirmationMetaLine,
  confirmationSentence,
  confirmTitle,
  expiryLine,
  type FlowActionId,
  type FlowProblem,
  type FlowProblemKind,
} from './device-update-flow';
import { DeviceUpdateFlow } from './device-update-flow';
import {
  DeviceUpdateConfirmationStore,
  type SubmittedConfirmation,
} from './device-update-confirmation.store';
import { DeviceUpdateProblem } from './device-update-problem';

/**
 * The confirmation of design 2.4 (frame 97:57). It restates the frozen scope and
 * binds the confirmation to the reviewed preview through its manifest digest.
 */
@Component({
  selector: 'app-device-update-confirm',
  imports: [MatButtonModule, MatCheckboxModule, DeviceUpdateProblem],
  templateUrl: './device-update-confirm.html',
  styleUrl: './device-update-confirm.css',
})
export class DeviceUpdateConfirmPage {
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
  protected readonly acknowledged = signal(false);
  protected readonly creating = signal(false);
  protected readonly prepareDetail = signal('');
  /** The submitted confirmation, kept until its acceptance is known. */
  private readonly submitted = signal<SubmittedConfirmation | null>(null);
  private generation = 0;

  protected readonly title = computed(() => {
    const problem = this.problem();
    if (problem) return problem.title;
    const preview = this.preview();
    return preview ? confirmTitle(preview) : 'Confirm the update';
  });
  protected readonly subtitle = computed(
    () => this.problem()?.subtitle ?? 'Review the approved scope',
  );
  protected readonly heading = computed(() => {
    const preview = this.preview();
    return preview ? confirmationHeading(preview) : '';
  });
  protected readonly sentence = computed(() => {
    const preview = this.preview();
    return preview ? confirmationSentence(preview, this.targets()) : '';
  });
  protected readonly meta = computed(() => {
    const preview = this.preview();
    return preview ? confirmationMetaLine(preview) : '';
  });
  protected readonly expiry = computed(() => {
    const preview = this.preview();
    return preview ? expiryLine(preview.expiresAt) : '';
  });
  protected readonly label = computed(() => {
    const preview = this.preview();
    return preview ? acknowledgementLabel(preview) : '';
  });
  protected readonly canCreate = computed(
    () =>
      this.acknowledged() &&
      !this.creating() &&
      (this.preview()?.eligible ?? 0) > 0,
  );
  protected readonly busyLabel = computed(() =>
    this.submitted() ? 'Retrying confirmation…' : 'Preparing preview…',
  );

  constructor() {
    effect(() => {
      const id = this.previewId();
      untracked(() => void this.load(id));
    });
  }

  /** Read the frozen scope again. The sentence names the observed values. */
  async load(id: string): Promise<void> {
    const generation = ++this.generation;
    this.status.set('loading');
    this.preview.set(null);
    this.targets.set([]);
    this.problem.set(null);
    this.acknowledged.set(false);
    this.prepareDetail.set('');
    // A reload of an uncertain confirmation keeps the submitted request and its
    // recovery. The preview read would answer 410 after expiry and hide the job.
    const retained = this.confirmations.retained(id);
    if (retained) {
      this.submitted.set(retained);
      this.showProblem('confirm-uncertain', null);
      return;
    }
    this.submitted.set(null);
    const summary = await this.flow.readPreview(id);
    if (generation !== this.generation) return;
    if (!summary.ok) {
      this.showProblem(summary.answer, summary.expiresAt);
      return;
    }
    const targets = await this.flow.readTargets(id);
    if (generation !== this.generation) return;
    if (!targets.ok) {
      this.showProblem(
        targets.answer,
        targets.expiresAt,
        summary.value.displayId,
      );
      return;
    }
    this.preview.set(summary.value);
    this.targets.set(targets.value);
    this.status.set('ready');
    if (summary.value.eligible === 0)
      this.showProblem('nothing-to-update', null, summary.value.displayId);
  }

  protected setAcknowledged(checked: boolean): void {
    this.acknowledged.set(checked);
  }

  protected backToPreview(): void {
    void this.router.navigate(['/devices/update/previews', this.previewId()]);
  }

  /** POST the digest and the acknowledgment. A duplicate answer opens the receipt. */
  protected async create(): Promise<void> {
    const preview = this.preview();
    if (!preview || !this.canCreate()) return;
    await this.submit(
      {
        previewId: preview.previewId,
        manifestDigest: preview.manifestDigest,
      },
      false,
    );
  }

  /**
   * Send the confirmation, or replay the retained one. An uncertain answer keeps the
   * submitted identity and digest so a retry sends the identical request. Once the
   * preview expired a GET would answer `410`, but the POST still returns the receipt
   * of a job that the first request created.
   */
  private async submit(
    submitted: SubmittedConfirmation,
    replay: boolean,
  ): Promise<void> {
    this.submitted.set(submitted);
    this.confirmations.retain(submitted);
    this.creating.set(true);
    const result = await this.flow.confirm(
      submitted.previewId,
      submitted.manifestDigest,
    );
    this.creating.set(false);
    if (result.ok) {
      this.confirmations.release(submitted.previewId);
      this.submitted.set(null);
      await this.router.navigate(['/jobs', result.value.displayId, 'receipt']);
      return;
    }
    if (result.answer === 'confirm-uncertain') {
      this.showProblem('confirm-uncertain', null, this.preview()?.displayId);
      return;
    }
    if (replay && confirmationMayExist(result.answer)) {
      this.showProblem(
        'confirm-receipt-unavailable',
        null,
        this.preview()?.displayId,
      );
      return;
    }
    this.confirmations.release(submitted.previewId);
    this.submitted.set(null);
    this.showProblem(
      result.answer,
      result.expiresAt,
      this.preview()?.displayId,
    );
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
      case 'retry': {
        const submitted = this.submitted();
        if (submitted) void this.submit(submitted, true);
        else void this.load(this.previewId());
        break;
      }
    }
  }

  private async prepareNewPreview(): Promise<void> {
    if (this.creating()) return;
    this.creating.set(true);
    this.prepareDetail.set('');
    const preparation = await this.confirmations.preparePreview();
    this.creating.set(false);
    const displayId = this.preview()?.displayId ?? null;
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

  private showProblem(
    kind: FlowProblemKind,
    expiresAt: string | null,
    displayId: string | null = null,
  ): void {
    this.problem.set(this.flow.problem(kind, { displayId, expiresAt }));
    this.status.set('problem');
  }
}
