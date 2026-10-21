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
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatRadioModule } from '@angular/material/radio';
import { Router } from '@angular/router';
import {
  jobDetailSchema,
  type DeviceAction,
  type DeviceActionJobReceipt,
  type DeviceActionPreview,
  type DeviceActionTarget,
  type JobDetail,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { ConnectionStore } from '../google-connection/connection.store';
import { formatTimestamp } from '../jobs/job-fields';
import {
  RECEIPT_HEADING,
  RECEIPT_NEXT_STEP,
  receiptSubtitle,
} from '../jobs/job-receipt-messages';
import {
  ACTION_FROZEN_TARGETS,
  ACTION_LABELS,
  ACTION_SELECTION_CHANGED_NOTE,
  EXCLUDED_HELP,
  FAMILY_ACTIONS,
  FAMILY_COPY,
  SELECTED_DEVICES,
  acknowledgementLabel,
  actionConsequence,
  actionProblem,
  confirmationButton,
  confirmationHeading,
  confirmationMetaLine,
  confirmationParagraphs,
  confirmationTitle,
  expiryLine,
  observedStatusText,
  previewMetaLine,
  receiptActionLine,
  reviewCountLine,
  reviewTitle,
  targetColumnLabel,
  targetCommandText,
  targetDeviceText,
  targetNote,
  targetSummaryText,
  targetsCaption,
  targetsLabel,
  type DeviceActionFamily,
} from './device-action-messages';
import { DeviceActionFlow } from './device-action-flow';
import {
  DeviceActionConfirmationStore,
  type SubmittedActionConfirmation,
} from './device-action-confirmation.store';
import {
  confirmationMayExist,
  flowExpiry,
  type FlowActionId,
  type FlowProblem,
  type FlowProblemKind,
} from './device-update-flow';
import { DeviceUpdateProblem } from './device-update-problem';
import { DevicesStore } from './devices.store';
import { DEVICE_GRID_ID } from './device-selection';

export type ActionSheetStep = 'choose' | 'review' | 'confirm' | 'done';

/** One prepared preview and the selection signature it was prepared from. */
interface PreparedPreview {
  preview: DeviceActionPreview;
  selection: string | null;
}

const STEP_LABELS: readonly { id: ActionSheetStep; label: string }[] = [
  { id: 'choose', label: 'Choose' },
  { id: 'review', label: 'Review' },
  { id: 'confirm', label: 'Confirm' },
];

interface DisplayStep {
  id: ActionSheetStep;
  label: string;
  number: number;
  state: 'done' | 'active' | 'later';
}

/** Answers that prove the prepared preview can no longer become a job. */
const INVALID_PREVIEW_ANSWERS: ReadonlySet<FlowProblemKind> = new Set([
  'preview-expired',
  'preview-changed',
  'preview-not-found',
  'permission-changed',
  'connection-changed',
  'connection-required',
]);

interface ActionOption {
  action: DeviceAction;
  label: string;
  consequence: string;
  /** The count line of the prepared preview, or an empty string. */
  summary: string;
}

/**
 * The Send command and Change status sheets of the owner mockup of 2026-10-21. One
 * component holds both families: the Choose, Review, Confirm, and receipt steps share
 * one composition, and the family supplies the copy, the routes, and the action list.
 * Above 600 px it is a side sheet without a scrim or focus trap.
 */
@Component({
  selector: 'app-device-action-sheet',
  imports: [
    CdkTrapFocus,
    MatButtonModule,
    MatCheckboxModule,
    MatRadioModule,
    DeviceUpdateProblem,
  ],
  templateUrl: './device-action-sheet.html',
  styleUrls: ['./bulk-action-sheet.css', './device-action-sheet.css'],
})
export class DeviceActionSheet {
  /** The menu entry that opened the sheet. */
  readonly family = input.required<DeviceActionFamily>();
  /** The Devices page opens and closes the sheet. */
  readonly open = input.required<boolean>();
  /** The page returns focus to the Bulk Actions button. */
  readonly closed = output<void>();

  protected readonly store = inject(DevicesStore);
  private readonly flow = inject(DeviceActionFlow);
  private readonly confirmations = inject(DeviceActionConfirmationStore);
  private readonly connection = inject(ConnectionStore);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly sheetTitle =
    viewChild<ElementRef<HTMLHeadingElement>>('sheetTitle');
  private readonly width = signal(globalThis.innerWidth ?? 1024);
  private readonly resize = () => this.width.set(globalThis.innerWidth);
  protected readonly step = signal<ActionSheetStep>('choose');
  protected readonly status = signal<'loading' | 'ready' | 'problem'>('ready');
  protected readonly problem = signal<FlowProblem | null>(null);
  protected readonly problemDetail = signal('');
  /** The prepared preview of each action and the selection it came from. */
  private readonly previews = signal<
    Partial<Record<DeviceAction, PreparedPreview>>
  >({});
  protected readonly targets = signal<DeviceActionTarget[]>([]);
  protected readonly receipt = signal<DeviceActionJobReceipt | null>(null);
  protected readonly job = signal<JobDetail | null>(null);
  protected readonly acknowledged = signal(false);
  protected readonly creating = signal(false);
  protected readonly preparing = signal(false);
  protected readonly submitted = signal<SubmittedActionConfirmation | null>(
    null,
  );
  protected readonly loadingSelection = signal(true);
  protected readonly selectionExpired = signal(false);
  protected readonly selectionError = signal('');
  protected readonly chooseOffline = signal(false);
  private readonly loadedCount = signal<number | null>(null);
  /** The initial selection read of this opening has finished, one way or another. */
  private readonly selectionLoaded = signal(false);
  /** The selection that the frozen preview was prepared from. */
  private readonly frozenSelection = signal<string | null>(null);
  /** Late answers for an earlier open or step entry are dropped. */
  private generation = 0;

  protected readonly modal = computed(() => this.width() < 600);
  protected readonly copy = computed(() => FAMILY_COPY[this.family()]);
  protected readonly actions = computed(() => FAMILY_ACTIONS[this.family()]);
  protected readonly selected = signal<DeviceAction | null>(null);
  protected readonly frozen = ACTION_FROZEN_TARGETS;
  protected readonly excludedHelp = EXCLUDED_HELP;
  protected readonly selectionChangedNote = ACTION_SELECTION_CHANGED_NOTE;
  protected readonly receiptHeading = RECEIPT_HEADING;
  protected readonly nextStep = RECEIPT_NEXT_STEP;
  protected readonly device = targetDeviceText;
  protected readonly note = targetNote;
  protected readonly observed = (target: DeviceActionTarget) =>
    observedStatusText(target.observedStatus);

  protected readonly count = computed(
    () => this.store.selection.spec()?.selectedCount ?? this.loadedCount(),
  );
  /** A selection that expired while the sheet stayed open is an expired selection. */
  protected readonly expired = computed(
    () => this.selectionExpired() || !!this.store.selection.spec()?.expiredAt,
  );
  /** "8 selected devices · Not submitted". */
  protected readonly summary = computed(() => {
    const count = this.count() ?? 0;
    return `${count.toLocaleString('en-US')} selected ${
      count === 1 ? 'device' : 'devices'
    } · Not submitted`;
  });
  protected readonly options = computed<ActionOption[]>(() =>
    this.actions().map((action) => {
      const prepared = this.previews()[action];
      return {
        action,
        label: ACTION_LABELS[action],
        consequence: actionConsequence(action),
        summary: prepared
          ? targetSummaryText(
              action,
              prepared.preview.eligible,
              prepared.preview.selected,
            )
          : '',
      };
    }),
  );
  protected readonly chooseReady = computed(
    () =>
      !this.loadingSelection() &&
      !this.expired() &&
      !this.selectionError() &&
      !this.chooseOffline() &&
      (this.count() ?? 0) > 0,
  );
  protected readonly canReview = computed(
    () => this.chooseReady() && this.selected() !== null,
  );
  protected readonly reviewLabel = computed(() => {
    const action = this.selected();
    return action ? `Review ${ACTION_LABELS[action]}` : 'Review';
  });
  /** The preview of the chosen action, or null before its preparation. */
  protected readonly preview = computed<DeviceActionPreview | null>(() => {
    const action = this.selected();
    return action ? (this.previewEntry(action)?.preview ?? null) : null;
  });
  protected readonly countLine = computed(() => {
    const preview = this.preview();
    const action = this.selected();
    return preview && action ? reviewCountLine(action, preview) : '';
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
    const action = this.selected();
    return preview && action
      ? confirmationHeading(action, preview.eligible)
      : '';
  });
  protected readonly paragraphs = computed(() => {
    const preview = this.preview();
    const action = this.selected();
    return preview && action
      ? confirmationParagraphs(action, preview.eligible, preview.excluded)
      : [];
  });
  protected readonly confirmMeta = computed(() => {
    const preview = this.preview();
    const action = this.selected();
    return preview && action ? confirmationMetaLine(action, preview) : '';
  });
  protected readonly expiry = computed(() => {
    const preview = this.preview();
    return preview ? expiryLine(preview.expiresAt) : '';
  });
  protected readonly acknowledgement = computed(() => {
    const action = this.selected();
    return action ? acknowledgementLabel(action) : null;
  });
  protected readonly confirmButton = computed(() => {
    const preview = this.preview();
    const action = this.selected();
    return preview && action
      ? confirmationButton(action, preview.eligible)
      : 'Send';
  });
  /** The Disable confirmation is the filled destructive button (UI-05). */
  protected readonly destructive = computed(
    () => this.selected() === 'disable',
  );
  protected readonly canCreate = computed(
    () =>
      !this.creating() &&
      (this.preview()?.eligible ?? 0) > 0 &&
      (this.acknowledgement() === null || this.acknowledged()),
  );
  /** The current selection, independent of the frozen preview. */
  private readonly selectionSignature = computed(() => {
    const spec = this.store.selection.spec();
    if (!spec) return null;
    return JSON.stringify({
      terms: spec.terms,
      groups: spec.groups,
      added: spec.added,
      excluded: spec.excluded,
      selectedCount: spec.selectedCount,
      expiredAt: spec.expiredAt,
      revision: this.store.selection.revision(),
    });
  });
  protected readonly selectionChanged = computed(() => {
    // Only a frozen preview has a selection to compare. The Choose step prepares
    // previews without freezing one, so it never reports a change.
    const frozen = this.frozenSelection();
    return frozen !== null && frozen !== this.selectionSignature();
  });
  protected readonly busy = computed(() => this.preparing() || this.creating());
  protected readonly busyLabel = computed(() =>
    this.submitted() ? 'Retrying confirmation…' : 'Preparing preview…',
  );
  protected readonly createBusyLabel = computed(
    () => `Creating ${this.copy().jobNoun}…`,
  );
  protected readonly receiptLine = computed(() => {
    const job = this.job();
    // A recovered receipt opens without a chosen option, so the job names the action.
    const action = this.selected() ?? actionOfJob(job);
    return job && action ? receiptActionLine(action, job) : '';
  });
  protected readonly jobDisplayId = computed(
    () => this.job()?.displayId ?? this.receipt()?.displayId ?? null,
  );
  protected readonly targetColumn = computed(() => {
    const action = this.selected();
    return action ? targetColumnLabel(action) : 'Command';
  });
  protected readonly targetsLabelText = computed(() => {
    // The no-eligible card lists the selected devices, not the targets of a job.
    if (this.problem()?.kind === 'nothing-to-update') return SELECTED_DEVICES;
    const action = this.selected();
    return action ? targetsLabel(action) : '';
  });
  protected readonly targetsCaptionText = computed(() => {
    if (this.problem()?.kind === 'nothing-to-update') return SELECTED_DEVICES;
    const action = this.selected();
    return action ? targetsCaption(action) : '';
  });
  protected readonly command = (target: DeviceActionTarget) => {
    const action = this.selected();
    return action ? targetCommandText(action, target) : '';
  };
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
    const preview = this.preview();
    const action = this.selected();
    switch (this.step()) {
      case 'choose':
        return this.expired() ? 'Selection expired' : this.copy().chooseTitle;
      case 'review':
        return preview && action
          ? reviewTitle(action, preview.eligible)
          : 'Review the preview';
      case 'confirm':
        return preview && action
          ? confirmationTitle(action, preview.eligible)
          : 'Confirm the action';
      case 'done':
        return this.copy().receiptTitle;
    }
  });
  protected readonly subtitle = computed(() => {
    const problem = this.problem();
    if (problem) return problem.subtitle;
    const preview = this.preview();
    switch (this.step()) {
      case 'choose':
        return this.expired() ? 'No job created' : this.summary();
      case 'review':
        return preview
          ? `Frozen preview · Prepared ${formatTimestamp(preview.preparedAt)}`
          : 'Frozen preview';
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

  /** The element id prefix. Two mounted sheets never share an id. */
  protected id(name: string): string {
    return `${this.family()}-${name}`;
  }

  protected get titleId(): string {
    return this.id('sheet-title');
  }

  protected get groupLabelId(): string {
    return this.id('choose-label');
  }

  protected get targetsLabelId(): string {
    return this.id('targets-label');
  }

  /** Open at Choose with the one command, or with no status action. */
  private start(): void {
    this.generation++;
    this.step.set('choose');
    this.status.set('ready');
    this.problem.set(null);
    this.problemDetail.set('');
    this.previews.set({});
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
    this.chooseOffline.set(false);
    this.loadedCount.set(null);
    this.loadingSelection.set(true);
    this.selectionLoaded.set(false);
    // Send command preselected Reboot, the only command (mockup choice 3).
    this.selected.set(this.family() === 'command' ? 'reboot' : null);
    afterNextRender(() => this.sheetTitle()?.nativeElement.focus(), {
      injector: this.injector,
    });
    void this.begin();
  }

  /**
   * Open the sheet at Choose, but first resolve every uncertain confirmation of this
   * family. A retained record may already hold a job, so it answers before the sheet
   * prepares another preview.
   */
  private async begin(): Promise<void> {
    const generation = this.generation;
    const replay = await this.confirmations.resolvePending(this.family());
    if (generation !== this.generation) return;
    if (replay.kind === 'receipt') {
      this.openReceipt(replay.receipt);
      return;
    }
    if (replay.kind === 'uncertain') {
      this.submitted.set(replay.submitted);
      this.step.set('confirm');
      this.showProblem('confirm-uncertain', generation);
      return;
    }
    if (replay.kind === 'unresolved') {
      // The answer cannot prove that the first request created no job. Keep the
      // identity for another replay and send the person to the Jobs recovery.
      this.submitted.set(replay.submitted);
      this.step.set('confirm');
      this.showProblem('confirm-receipt-unavailable', generation);
      return;
    }
    if (replay.kind === 'problem') {
      this.step.set('confirm');
      this.showProblem(replay.answer, generation, {
        expiresAt: replay.expiresAt,
      });
      return;
    }
    await this.loadSelection();
  }

  /** Read the stored selection. It reports the count and an expired selection. */
  async loadSelection(): Promise<void> {
    const generation = this.generation;
    this.loadingSelection.set(true);
    this.selectionError.set('');
    this.chooseOffline.set(false);
    this.selectionExpired.set(false);
    try {
      await this.store.selection.getSpec(this.key);
      if (generation !== this.generation) return;
      const spec = this.store.selection.spec();
      this.loadedCount.set(spec?.selectedCount ?? 0);
      if (spec?.expiredAt) this.selectionExpired.set(true);
      if (!spec?.expiredAt && (spec?.selectedCount ?? 0) > 0)
        void this.preparePreviews(generation);
    } catch {
      if (generation !== this.generation) return;
      if (this.store.offline()) this.chooseOffline.set(true);
      else
        this.selectionError.set(
          'Campus Commander could not read the device selection.',
        );
    } finally {
      if (generation === this.generation) {
        this.loadingSelection.set(false);
        this.selectionLoaded.set(true);
      }
    }
  }

  /**
   * Prepare one preview per action of the family, so the Choose step names the
   * eligible count of each option (mockup choice 2). A failed preparation leaves the
   * option without its count; the Review step reports the answer.
   */
  private async preparePreviews(generation: number): Promise<void> {
    this.preparing.set(true);
    await Promise.all(
      this.actions().map(async (action) => {
        const selection = this.selectionSignature();
        const prepared = await this.flow.prepare(this.family(), action);
        if (generation !== this.generation) return;
        if (prepared.ok) this.storePreview(prepared.value, selection);
      }),
    );
    if (generation === this.generation) this.preparing.set(false);
  }

  protected select(action: DeviceAction): void {
    this.selected.set(action);
  }

  protected close(): void {
    if (!this.open()) return;
    // A closed sheet abandons every answer of this opening.
    this.generation++;
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

  /** Review re-reads the frozen preview of the chosen action, or prepares it. */
  protected async goReview(): Promise<void> {
    await this.enterReview(true);
  }

  /** Confirm returns to the reviewed preview. Its frozen scope does not change. */
  protected async backToPreview(): Promise<void> {
    await this.enterReview(false);
  }

  /**
   * Enter Review. A new scope from Choose replaces a preview of an older selection.
   * A return from Confirm re-reads the same frozen preview and keeps its signature.
   */
  private async enterReview(replaceStale: boolean): Promise<void> {
    const action = this.selected();
    if (!action) return;
    const generation = ++this.generation;
    this.acknowledged.set(false);
    this.problem.set(null);
    this.problemDetail.set('');
    this.preparing.set(false);
    this.step.set('review');
    this.targets.set([]);
    this.status.set('loading');
    const known = this.previewEntry(action);
    if (
      known &&
      (!replaceStale || known.selection === this.selectionSignature())
    ) {
      await this.readFrozen(
        known.preview.previewId,
        generation,
        known.selection,
      );
      return;
    }
    if (known) this.dropPreview(action);
    await this.prepareForReview(action, generation);
  }

  /**
   * Prepare the chosen action after every uncertain confirmation has an answer. A
   * retained confirmation can hold the receipt of a job that already exists, so it
   * answers before this sheet prepares a replacement preview.
   */
  private async prepareForReview(
    action: DeviceAction,
    generation: number,
  ): Promise<void> {
    this.problem.set(null);
    this.problemDetail.set('');
    this.targets.set([]);
    this.preparing.set(true);
    this.status.set('loading');
    const replay = await this.confirmations.resolvePending(this.family());
    if (generation !== this.generation) return;
    if (replay.kind === 'receipt') {
      this.preparing.set(false);
      this.openReceipt(replay.receipt);
      return;
    }
    if (replay.kind === 'uncertain') {
      this.preparing.set(false);
      this.submitted.set(replay.submitted);
      this.step.set('confirm');
      this.showProblem('confirm-uncertain', generation);
      return;
    }
    if (replay.kind === 'unresolved') {
      this.preparing.set(false);
      this.submitted.set(replay.submitted);
      this.step.set('confirm');
      this.showProblem('confirm-receipt-unavailable', generation);
      return;
    }
    if (replay.kind === 'problem') {
      this.preparing.set(false);
      this.showProblem(replay.answer, generation, {
        expiresAt: replay.expiresAt,
      });
      return;
    }
    const selection = this.selectionSignature();
    const prepared = await this.flow.prepare(this.family(), action);
    if (generation !== this.generation) return;
    this.preparing.set(false);
    if (!prepared.ok) {
      this.showProblem(prepared.answer, generation, {
        expiresAt: prepared.expiresAt,
      });
      return;
    }
    this.storePreview(prepared.value, selection);
    await this.readPrepared(prepared.value, selection, generation);
  }

  /** The Review step re-reads the frozen scope before it shows the confirmation. */
  protected async goConfirm(): Promise<void> {
    const preview = this.preview();
    if (!preview || !this.canContinue()) return;
    const generation = ++this.generation;
    this.acknowledged.set(false);
    this.problem.set(null);
    this.problemDetail.set('');
    this.step.set('confirm');
    this.status.set('loading');
    // A retained confirmation may already hold the job of this preview. A preview
    // read would answer 410 after expiry and hide the receipt.
    const retained = this.confirmations.retained(
      this.family(),
      preview.previewId,
    );
    if (retained) {
      this.submitted.set(retained);
      this.showProblem('confirm-uncertain', generation);
      return;
    }
    this.submitted.set(null);
    await this.readFrozen(
      preview.previewId,
      generation,
      this.frozenSelection(),
    );
  }

  /** Change action returns to the choice and keeps the prepared previews. */
  protected goChoose(): void {
    this.generation++;
    this.problem.set(null);
    this.problemDetail.set('');
    this.status.set('ready');
    this.targets.set([]);
    this.step.set('choose');
    // An opening replay can send the sheet to Confirm before the initial selection
    // read runs. Change action completes that read before Choose shows its options.
    if (!this.selectionLoaded()) void this.loadSelection();
  }

  protected setAcknowledged(checked: boolean): void {
    this.acknowledged.set(checked);
  }

  /** POST the digest and the acknowledgment. A duplicate answer opens the receipt. */
  protected async create(): Promise<void> {
    const preview = this.preview();
    if (!preview || !this.canCreate()) return;
    await this.submit(
      {
        family: this.family(),
        previewId: preview.previewId,
        manifestDigest: preview.manifestDigest,
      },
      false,
    );
  }

  /**
   * Send the confirmation, or replay the retained one. An uncertain answer keeps the
   * submitted identity and digest, so a retry sends the identical request.
   */
  private async submit(
    submitted: SubmittedActionConfirmation,
    replay: boolean,
  ): Promise<void> {
    const generation = this.generation;
    this.submitted.set(submitted);
    this.confirmations.retain(submitted);
    this.creating.set(true);
    const result = await this.flow.confirm(
      submitted.family,
      submitted.previewId,
      submitted.manifestDigest,
    );
    if (result.ok) {
      // The answer settles the retained record even after the sheet closed.
      this.confirmations.release(submitted.family, submitted.previewId);
      if (generation !== this.generation) return;
      this.creating.set(false);
      this.submitted.set(null);
      this.openReceipt(result.value);
      return;
    }
    if (result.answer === 'confirm-uncertain') {
      if (generation !== this.generation) return;
      this.creating.set(false);
      this.showProblem('confirm-uncertain', generation);
      return;
    }
    if (replay && confirmationMayExist(result.answer)) {
      if (generation !== this.generation) return;
      this.creating.set(false);
      this.showProblem('confirm-receipt-unavailable', generation);
      return;
    }
    // A named answer settles the record even after the sheet closed.
    this.confirmations.release(submitted.family, submitted.previewId);
    if (generation !== this.generation) return;
    this.creating.set(false);
    this.submitted.set(null);
    this.showProblem(result.answer, generation, {
      expiresAt: result.expiresAt,
      displayId: this.preview()?.displayId,
    });
  }

  /** Show the receipt and read the job that the confirmation created. */
  private openReceipt(receipt: DeviceActionJobReceipt): void {
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
        this.showProblem('job-unavailable', generation);
        return;
      }
      this.showProblem(jobAnswer(response.status, body), generation, {
        expiresAt: flowExpiry(body),
      });
    } catch {
      if (generation !== this.generation) return;
      this.showProblem('offline', generation);
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
      case 'back-to-devices':
        this.close();
        break;
      case 'back-to-jobs':
        void this.router.navigate(['/jobs']);
        break;
      case 'back-to-choose':
        this.goChoose();
        break;
      case 'open-google-connection':
        void this.router.navigate(['/google-connection']);
        break;
      case 'retry':
        void this.retry();
        break;
      default:
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
    if (this.step() === 'confirm') {
      const submitted = this.submitted();
      if (submitted) {
        await this.submit(submitted, true);
        return;
      }
      await this.goConfirm();
      return;
    }
    if (this.step() === 'review') {
      const action = this.selected();
      if (!action) return;
      const generation = ++this.generation;
      const known = this.previewEntry(action);
      if (known) {
        await this.readFrozen(
          known.preview.previewId,
          generation,
          known.selection,
        );
        return;
      }
      // The preparation itself failed, so Retry prepares a preview again.
      await this.prepareForReview(action, generation);
      return;
    }
    await this.loadSelection();
  }

  /** Read the frozen summary and every target of the active preview. */
  private async readFrozen(
    previewId: string,
    generation: number,
    selection: string | null,
  ): Promise<void> {
    this.status.set('loading');
    this.problem.set(null);
    const summary = await this.flow.readPreview(this.family(), previewId);
    if (generation !== this.generation) return;
    if (!summary.ok) {
      this.showProblem(summary.answer, generation, {
        expiresAt: summary.expiresAt,
        displayId: this.preview()?.displayId,
      });
      return;
    }
    const targets = await this.flow.readTargets(this.family(), previewId);
    if (generation !== this.generation) return;
    if (!targets.ok) {
      this.showProblem(targets.answer, generation, {
        expiresAt: targets.expiresAt,
        displayId: summary.value.displayId,
      });
      return;
    }
    this.storePreview(summary.value, selection);
    this.targets.set(targets.value);
    // The frozen signature is the selection that prepared this preview. A frozen
    // reread must not adopt a newer selection.
    this.frozenSelection.set(selection);
    if (summary.value.eligible === 0) {
      // The no-eligible state is not an error, and it lists every selected device.
      this.showProblem('nothing-to-update', generation, {
        displayId: summary.value.displayId,
        keepTargets: true,
      });
      return;
    }
    this.status.set('ready');
  }

  /** Read the targets of a preview that this sheet prepared. */
  private async readPrepared(
    preview: DeviceActionPreview,
    selection: string | null,
    generation: number,
  ): Promise<void> {
    const targets = await this.flow.readTargets(
      this.family(),
      preview.previewId,
    );
    if (generation !== this.generation) return;
    if (!targets.ok) {
      this.showProblem(targets.answer, generation, {
        expiresAt: targets.expiresAt,
        displayId: preview.displayId,
      });
      return;
    }
    this.targets.set(targets.value);
    this.frozenSelection.set(selection);
    if (preview.eligible === 0) {
      this.showProblem('nothing-to-update', generation, {
        displayId: preview.displayId,
        keepTargets: true,
      });
      return;
    }
    this.status.set('ready');
  }

  /** The prepared preview of one action, or null. */
  private previewEntry(action: DeviceAction): PreparedPreview | null {
    return this.previews()[action] ?? null;
  }

  private storePreview(
    preview: DeviceActionPreview,
    selection: string | null,
  ): void {
    this.previews.update((current) => ({
      ...current,
      [preview.action]: { preview, selection },
    }));
  }

  /** Remove a prepared preview that can no longer become a job. */
  private dropPreview(action: DeviceAction): void {
    this.previews.update((current) => {
      const next = { ...current };
      delete next[action];
      return next;
    });
  }

  private showProblem(
    kind: FlowProblemKind,
    generation: number,
    options: {
      displayId?: string | null;
      expiresAt?: string | null;
      keepTargets?: boolean;
    } = {},
  ): void {
    if (generation !== this.generation) return;
    const targets = options.keepTargets
      ? this.targets()
      : ([] as DeviceActionTarget[]);
    this.problem.set(
      actionProblem(kind, {
        family: this.family(),
        action: this.selected(),
        targets,
        displayId: options.displayId ?? this.preview()?.displayId ?? null,
        expiresAt: options.expiresAt ?? null,
        canOpenConnection: this.connection.readable(),
      }),
    );
    this.status.set('problem');
    // A dead preview cannot answer a later Review. The next Review prepares a new
    // preview instead of rereading the invalid one.
    const action = this.selected();
    if (action && INVALID_PREVIEW_ANSWERS.has(kind)) this.dropPreview(action);
    if (!options.keepTargets) this.targets.set([]);
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

/** The action of a durable job, for a receipt that opens without a choice. */
function actionOfJob(job: JobDetail | null): DeviceAction | null {
  if (!job) return null;
  if (job.commandType === 'REBOOT' || job.action === 'reboot-devices')
    return 'reboot';
  if (job.statusAction === 'reenable' || job.action === 'reenable-devices')
    return 'reenable';
  if (job.statusAction === 'disable' || job.action === 'disable-devices')
    return 'disable';
  return null;
}
