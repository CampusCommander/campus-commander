import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import {
  jobDetailSchema,
  type DeviceUpdateJobReceipt,
  type DeviceUpdateMode,
  type DeviceUpdatePreview,
  type DeviceUpdateTarget,
  type JobDetail,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { formatTimestamp } from '../jobs/job-fields';
import {
  RECEIPT_HEADING,
  RECEIPT_NEXT_STEP,
  receiptCountLine,
  receiptSubtitle,
} from '../jobs/job-receipt-messages';
import { DevicesStore } from './devices.store';
import { DEVICE_GRID_ID } from './device-selection';
import { DeviceUpdateDraftStore } from './device-update-draft.store';
import {
  DeviceUpdateConfirmationStore,
  type SubmittedConfirmation,
} from './device-update-confirmation.store';
import {
  FROZEN_TARGETS_SENTENCE,
  acknowledgementLabel,
  approvedValueText,
  confirmationHeading,
  confirmationMayExist,
  confirmationMetaLine,
  confirmationSentence,
  confirmTitle,
  expiryLine,
  flowExpiry,
  observedValueText,
  previewCountLine,
  previewMetaLine,
  previewTitle,
  problemSummary,
  staleWarning,
  targetDeviceText,
  targetNote,
  type FlowActionId,
  type FlowProblem,
  type FlowProblemKind,
} from './device-update-flow';
import { DeviceUpdateFlow } from './device-update-flow';
import {
  changedFieldsText,
  deviceCountText,
  deviceUpdateValueError,
} from './device-update-messages';
import { DeviceUpdateProblem } from './device-update-problem';

export type SheetStep = 'edit' | 'review' | 'confirm' | 'done';

/** The note of behavior item 12. The owner reviews this drafted string. */
export const SELECTION_CHANGED_NOTE =
  'The selection changed after this preview. Edit draft to preview the new selection.';

const STEP_LABELS: readonly { id: SheetStep; label: string }[] = [
  { id: 'edit', label: 'Edit' },
  { id: 'review', label: 'Review' },
  { id: 'confirm', label: 'Confirm' },
];

interface DisplayStep {
  id: SheetStep;
  label: string;
  number: number;
  state: 'done' | 'active' | 'later';
}

/**
 * The bulk action sheet of Update device (owner mockup of 2026-10-20). It holds the
 * draft, the frozen preview, the confirmation, and the receipt in one panel over the
 * grid. Above 600 px it is a standard side sheet without a scrim or focus trap.
 */
@Component({
  selector: 'app-device-update-sheet',
  imports: [
    FormsModule,
    CdkTrapFocus,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    DeviceUpdateProblem,
  ],
  templateUrl: './device-update-sheet.html',
  styleUrl: './device-update-sheet.css',
})
export class DeviceUpdateSheet {
  /** The Devices page opens and closes the sheet. */
  readonly open = input.required<boolean>();
  /** The page returns focus to the Bulk Actions button. */
  readonly closed = output<void>();

  protected readonly store = inject(DevicesStore);
  protected readonly draft = inject(DeviceUpdateDraftStore);
  private readonly flow = inject(DeviceUpdateFlow);
  private readonly confirmations = inject(DeviceUpdateConfirmationStore);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly sheetTitle =
    viewChild<ElementRef<HTMLHeadingElement>>('sheetTitle');
  private readonly width = signal(globalThis.innerWidth ?? 1024);
  private readonly resize = () => this.width.set(globalThis.innerWidth);
  /** The recessed action step. A closed sheet keeps its draft outside this state. */
  protected readonly step = signal<SheetStep>('edit');
  protected readonly status = signal<'loading' | 'ready' | 'problem'>('ready');
  protected readonly problem = signal<FlowProblem | null>(null);
  protected readonly problemDetail = signal('');
  protected readonly preview = signal<DeviceUpdatePreview | null>(null);
  protected readonly targets = signal<DeviceUpdateTarget[]>([]);
  protected readonly receipt = signal<DeviceUpdateJobReceipt | null>(null);
  protected readonly job = signal<JobDetail | null>(null);
  protected readonly acknowledged = signal(false);
  protected readonly creating = signal(false);
  protected readonly preparing = signal(false);
  protected readonly submitted = signal<SubmittedConfirmation | null>(null);
  /** The Edit step reads the stored selection at open. */
  protected readonly loadingSelection = signal(true);
  protected readonly selectionExpired = signal(false);
  protected readonly selectionError = signal('');
  protected readonly editOffline = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveError = signal('');
  protected readonly attempted = signal(false);
  private readonly loadedCount = signal<number | null>(null);
  /** The selection that the frozen preview was prepared from. */
  private readonly frozenSelection = signal<string | null>(null);
  /** Late answers for an earlier open or preview are dropped. */
  private generation = 0;

  protected readonly modal = computed(() => this.width() < 600);
  protected readonly SELECTION_CHANGED_NOTE = SELECTION_CHANGED_NOTE;
  protected readonly frozen = FROZEN_TARGETS_SENTENCE;
  protected readonly staleNote = staleWarning;
  protected readonly receiptHeading = RECEIPT_HEADING;
  protected readonly nextStep = RECEIPT_NEXT_STEP;
  protected readonly observed = observedValueText;
  protected readonly approved = approvedValueText;
  protected readonly device = targetDeviceText;
  protected readonly note = targetNote;

  protected readonly count = computed<number | null>(
    () => this.store.selection.spec()?.selectedCount ?? this.loadedCount(),
  );
  /** A selection that expired while the sheet stayed open is an expired selection. */
  protected readonly expired = computed(
    () => this.selectionExpired() || !!this.store.selection.spec()?.expiredAt,
  );
  protected readonly valueError = computed(() =>
    this.draft.mode() === 'replace'
      ? deviceUpdateValueError(this.draft.value())
      : null,
  );
  protected readonly showValueError = computed(
    () =>
      !!this.valueError() &&
      (this.draft.value().length > 0 || this.attempted()),
  );
  protected readonly length = computed(() => [...this.draft.value()].length);
  protected readonly summary = computed(
    () =>
      `${deviceCountText(this.count() ?? 0)} · ${changedFieldsText(
        this.draft.changed() ? 1 : 0,
      )} · Not submitted`,
  );
  protected readonly editReady = computed(
    () =>
      !this.loadingSelection() &&
      !this.expired() &&
      !this.selectionError() &&
      (this.count() ?? 0) > 0,
  );
  protected readonly canSave = computed(
    () =>
      this.editReady() &&
      !this.editOffline() &&
      !this.saving() &&
      this.valueError() === null,
  );
  protected readonly countLine = computed(() => {
    const preview = this.preview();
    return preview ? previewCountLine(preview) : '';
  });
  protected readonly metaLine = computed(() => {
    const preview = this.preview();
    return preview ? previewMetaLine(preview) : '';
  });
  protected readonly canContinue = computed(
    () => (this.preview()?.eligible ?? 0) > 0,
  );
  protected readonly heading = computed(() => {
    const preview = this.preview();
    return preview ? confirmationHeading(preview) : '';
  });
  protected readonly sentence = computed(() => {
    const preview = this.preview();
    return preview ? confirmationSentence(preview, this.targets()) : '';
  });
  protected readonly confirmMeta = computed(() => {
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
  /** The current selection, independent of the frozen preview. */
  private readonly selectionSignature = computed(() => {
    const spec = this.store.selection.spec();
    return spec
      ? JSON.stringify({
          terms: spec.terms,
          groups: spec.groups,
          added: spec.added,
          excluded: spec.excluded,
          selectedCount: spec.selectedCount,
          expiredAt: spec.expiredAt,
        })
      : null;
  });
  protected readonly selectionChanged = computed(
    () =>
      this.preview() !== null &&
      this.frozenSelection() !== this.selectionSignature(),
  );
  protected readonly busy = computed(() => this.preparing() || this.creating());
  protected readonly busyLabel = computed(() =>
    this.submitted() ? 'Retrying confirmation…' : 'Preparing preview…',
  );
  protected readonly receiptLine = computed(() => {
    const job = this.job();
    return job ? receiptCountLine(job) : '';
  });
  protected readonly jobDisplayId = computed(
    () => this.job()?.displayId ?? this.receipt()?.displayId ?? null,
  );
  protected readonly steps = computed<DisplayStep[]>(() => {
    const current =
      this.step() === 'done' ? STEP_LABELS.length : this.currentIndex();
    return STEP_LABELS.map((item, index) => ({
      ...item,
      number: index + 1,
      state: index < current ? 'done' : index === current ? 'active' : 'later',
    }));
  });
  protected readonly title = computed(() => {
    const problem = this.problem();
    if (problem) return problem.title;
    switch (this.step()) {
      case 'edit': {
        if (this.expired()) return 'Selection expired';
        const count = this.count();
        return count === null
          ? 'Update devices'
          : `Update ${deviceCountText(count)}`;
      }
      case 'review': {
        const preview = this.preview();
        return preview ? previewTitle(preview) : 'Review the preview';
      }
      case 'confirm': {
        const preview = this.preview();
        return preview ? confirmTitle(preview) : 'Confirm the update';
      }
      case 'done':
        return 'Update job created';
    }
  });
  protected readonly subtitle = computed(() => {
    const problem = this.problem();
    if (problem) return problem.subtitle;
    switch (this.step()) {
      case 'edit':
        return this.expired()
          ? 'No job created'
          : 'Draft changes · Not submitted';
      case 'review': {
        const preview = this.preview();
        return preview
          ? `Frozen preview · Prepared ${formatTimestamp(preview.preparedAt)}`
          : 'Frozen preview';
      }
      case 'confirm':
        return 'Review the approved scope';
      case 'done': {
        const job = this.job();
        return job ? receiptSubtitle(job) : 'Job receipt';
      }
    }
  });
  private readonly key = {
    gridId: DEVICE_GRID_ID,
    tabId: this.store.selectionTab,
  };

  constructor() {
    globalThis.addEventListener?.('resize', this.resize);
    this.destroyRef.onDestroy(() =>
      globalThis.removeEventListener?.('resize', this.resize),
    );
    effect(() => {
      if (!this.open()) return;
      untracked(() => this.start());
    });
  }

  /** Open at Edit with the kept draft, then read the current selection. */
  private start(): void {
    this.generation++;
    this.step.set('edit');
    this.status.set('ready');
    this.problem.set(null);
    this.problemDetail.set('');
    this.preview.set(null);
    this.targets.set([]);
    this.frozenSelection.set(null);
    this.receipt.set(null);
    this.job.set(null);
    this.acknowledged.set(false);
    this.creating.set(false);
    this.preparing.set(false);
    this.submitted.set(null);
    this.selectionExpired.set(false);
    this.selectionError.set('');
    this.editOffline.set(false);
    this.saving.set(false);
    this.saveError.set('');
    this.attempted.set(false);
    this.loadedCount.set(null);
    afterNextRender(() => this.sheetTitle()?.nativeElement.focus(), {
      injector: this.injector,
    });
    void this.loadSelection();
  }

  /** Read the stored selection. It reports the count and an expired selection. */
  async loadSelection(): Promise<void> {
    this.loadingSelection.set(true);
    this.selectionError.set('');
    this.editOffline.set(false);
    this.selectionExpired.set(false);
    try {
      await this.store.selection.getSpec(this.key);
      const spec = this.store.selection.spec();
      this.loadedCount.set(spec?.selectedCount ?? 0);
      if (spec?.expiredAt) this.selectionExpired.set(true);
    } catch {
      if (this.store.offline()) this.editOffline.set(true);
      else
        this.selectionError.set(
          'Campus Commander could not read the device selection.',
        );
    } finally {
      this.loadingSelection.set(false);
    }
  }

  protected close(): void {
    if (!this.open()) return;
    this.closed.emit();
  }

  /** A click on the scrim dismisses the modal sheet only. */
  protected dismiss(): void {
    if (this.modal()) this.close();
  }

  /** An open select or menu owns Escape; the sheet closes on the next Escape. */
  @HostListener('document:keydown', ['$event'])
  protected onDocumentKeydown(event: KeyboardEvent): void {
    if (!this.open() || event.defaultPrevented) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    this.close();
  }

  protected setMode(mode: DeviceUpdateMode): void {
    this.draft.setMode(mode);
  }

  protected reset(): void {
    this.attempted.set(false);
    this.saveError.set('');
    this.draft.reset();
  }

  /** Show the selected devices in the grid beside the sheet. The draft stays. */
  protected reviewPending(): void {
    this.store.selectedView.set(true);
  }

  /** Leave the problem card and keep the frozen preview. */
  protected goEdit(): void {
    this.problem.set(null);
    this.problemDetail.set('');
    this.status.set('ready');
    this.step.set('edit');
  }

  protected goReview(): void {
    if (!this.preview()) return;
    this.problem.set(null);
    this.problemDetail.set('');
    this.status.set('ready');
    this.step.set('review');
  }

  protected goConfirm(): void {
    if (!this.preview() || !this.canContinue()) return;
    this.acknowledged.set(false);
    this.problem.set(null);
    this.problemDetail.set('');
    this.status.set('ready');
    this.step.set('confirm');
  }

  protected setAcknowledged(checked: boolean): void {
    this.acknowledged.set(checked);
  }

  /** Save and preview prepares a frozen preview on the server. */
  protected async prepare(): Promise<void> {
    this.attempted.set(true);
    if (!this.canSave()) return;
    this.saving.set(true);
    this.saveError.set('');
    const generation = ++this.generation;
    const selection = this.selectionSignature();
    const preparation = await this.confirmations.preparePreview();
    if (generation !== this.generation) return;
    this.saving.set(false);
    if (preparation.kind === 'receipt') {
      this.openReceipt(preparation.receipt);
      return;
    }
    if (preparation.kind === 'preview') {
      await this.showPreview(preparation.preview, selection, generation);
      return;
    }
    if (preparation.kind === 'uncertain') {
      this.frozenSelection.set(selection);
      this.submitted.set(preparation.submitted);
      this.step.set('confirm');
      this.showProblem('confirm-uncertain');
      return;
    }
    this.showPrepareProblem(preparation.answer);
  }

  /** Keep the draft page's own inline answers for a failed preview request. */
  private showPrepareProblem(answer: FlowProblemKind): void {
    if (answer === 'selection-expired') {
      this.selectionExpired.set(true);
      return;
    }
    if (answer === 'connection-required') {
      this.saveError.set(
        'Connect Google Workspace before you prepare an update preview.',
      );
      return;
    }
    if (answer === 'nothing-selected') {
      this.saveError.set(
        'No devices are selected. Return to Devices and select the devices again.',
      );
      return;
    }
    if (answer === 'selection-too-large') {
      this.saveError.set(
        'The selection holds more than 100,000 devices. Narrow the filters and select again.',
      );
      return;
    }
    if (answer === 'forbidden') {
      this.saveError.set('Your access changed. Update device is unavailable.');
      return;
    }
    if (answer === 'offline') {
      this.editOffline.set(true);
      this.saveError.set(
        'Cannot reach Campus Commander. Your draft stays in this tab.',
      );
      return;
    }
    this.saveError.set(problemSummary(answer));
  }

  /** Read the frozen targets and show the Review step. */
  private async showPreview(
    preview: DeviceUpdatePreview,
    selection: string | null,
    generation: number,
  ): Promise<void> {
    this.preview.set(preview);
    this.frozenSelection.set(selection);
    this.targets.set([]);
    this.problem.set(null);
    this.problemDetail.set('');
    this.step.set('review');
    this.status.set('loading');
    await this.readTargets(preview, generation);
  }

  private async readTargets(
    preview: DeviceUpdatePreview,
    generation: number,
  ): Promise<void> {
    this.status.set('loading');
    this.problem.set(null);
    const targets = await this.flow.readTargets(preview.previewId);
    if (generation !== this.generation) return;
    if (!targets.ok) {
      this.showProblem(targets.answer, targets.expiresAt, preview.displayId);
      return;
    }
    // The summary counts every frozen target. An empty list contradicts it.
    if (preview.selected > 0 && targets.value.length === 0) {
      this.showProblem('preview-unavailable', null, preview.displayId);
      return;
    }
    this.targets.set(targets.value);
    this.status.set('ready');
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
   * submitted identity and digest so a retry sends the identical request.
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
      this.openReceipt(result.value);
      return;
    }
    if (result.answer === 'confirm-uncertain') {
      this.showProblem('confirm-uncertain');
      return;
    }
    if (replay && confirmationMayExist(result.answer)) {
      this.showProblem('confirm-receipt-unavailable');
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

  /** Show the receipt and read the job that the confirmation created. */
  private openReceipt(receipt: DeviceUpdateJobReceipt): void {
    this.generation++;
    this.receipt.set(receipt);
    this.job.set(null);
    this.creating.set(false);
    this.acknowledged.set(false);
    this.problem.set(null);
    this.problemDetail.set('');
    this.step.set('done');
    void this.loadJob(receipt.displayId);
  }

  /** Read the durable job. A reload and the first view follow the same read. */
  async loadJob(
    displayId: string,
    generation = this.generation,
  ): Promise<void> {
    this.status.set('loading');
    this.job.set(null);
    this.problem.set(null);
    this.problemDetail.set('');
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
        this.showProblem('job-unavailable');
        return;
      }
      this.showProblem(jobAnswer(response.status, body), flowExpiry(body));
    } catch {
      if (generation !== this.generation) return;
      this.showProblem('offline');
      this.problemDetail.set(
        'Cannot reach Campus Commander. Your draft stays in this tab.',
      );
    }
  }

  protected viewJob(): void {
    const displayId = this.jobDisplayId();
    if (!displayId) return;
    void this.router.navigate(['/jobs', displayId]);
  }

  /** Run one recovery action of the problem card. */
  protected act(id: FlowActionId): void {
    switch (id) {
      case 'return-to-draft':
        this.goEdit();
        break;
      case 'prepare-new-preview':
        void this.prepareNewPreview();
        break;
      case 'back-to-devices':
        this.close();
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

  /** Retry the failed read or replay of the active step. */
  private async retry(): Promise<void> {
    if (this.step() === 'done') {
      const displayId = this.jobDisplayId();
      if (displayId) void this.loadJob(displayId);
      return;
    }
    if (this.step() === 'confirm' && this.submitted()) {
      const submitted = this.submitted();
      if (submitted) await this.submit(submitted, true);
      return;
    }
    if (this.step() === 'confirm') {
      await this.reloadConfirm();
      return;
    }
    // Review: read the frozen targets again.
    const preview = this.preview();
    if (preview) await this.readTargets(preview, this.generation);
  }

  /** Re-read the preview and targets of the Confirm step. */
  private async reloadConfirm(): Promise<void> {
    const previewId = this.preview()?.previewId;
    if (!previewId) return;
    const generation = ++this.generation;
    this.status.set('loading');
    this.problem.set(null);
    const summary = await this.flow.readPreview(previewId);
    if (generation !== this.generation) return;
    if (!summary.ok) {
      this.showProblem(summary.answer, summary.expiresAt);
      return;
    }
    const targets = await this.flow.readTargets(previewId);
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
    this.acknowledged.set(false);
    if (summary.value.eligible === 0) {
      this.showProblem('nothing-to-update', null, summary.value.displayId);
      return;
    }
    this.status.set('ready');
  }

  /** Prepare a new preview from the durable draft and open Review. */
  private async prepareNewPreview(): Promise<void> {
    if (this.preparing()) return;
    this.preparing.set(true);
    this.problemDetail.set('');
    const generation = ++this.generation;
    const selection = this.selectionSignature();
    const preparation = await this.confirmations.preparePreview();
    if (generation !== this.generation) return;
    this.preparing.set(false);
    switch (preparation.kind) {
      case 'receipt':
        this.openReceipt(preparation.receipt);
        return;
      case 'preview':
        await this.showPreview(preparation.preview, selection, generation);
        return;
      case 'uncertain':
        this.frozenSelection.set(selection);
        this.submitted.set(preparation.submitted);
        this.step.set('confirm');
        this.showProblem('confirm-uncertain');
        return;
      case 'problem':
        this.showProblem(
          preparation.answer,
          preparation.expiresAt,
          this.preview()?.displayId,
        );
        if (preparation.answer === 'offline')
          this.problemDetail.set(
            'Cannot reach Campus Commander. Your draft stays in this tab.',
          );
        return;
    }
  }

  private showProblem(
    kind: FlowProblemKind,
    expiresAt: string | null = null,
    displayId: string | null = null,
  ): void {
    this.problem.set(this.flow.problem(kind, { displayId, expiresAt }));
    this.status.set('problem');
  }

  private currentIndex(): number {
    return STEP_LABELS.findIndex((item) => item.id === this.step());
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
