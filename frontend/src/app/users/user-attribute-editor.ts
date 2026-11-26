import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  type OnInit,
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
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import {
  MatChipsModule,
  type MatChipInputEvent,
} from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import type {
  UserAttributeCategory,
  UserAttributeDisposition,
  UserAttributePreview,
  UserAttributeRowValue,
  UserAttributeTarget,
  UserDetail,
} from '@campus/application-contracts';
import {
  UserAttributeEditFlow,
  attributeJobOutcome,
  type AttributeSaveOutcome,
} from './user-attribute-edit-flow';
import {
  UserAttributeConfirmationStore,
  type PendingAttributeConfirmation,
} from './user-attribute-confirmation';
import {
  ATTRIBUTE_BACK_TO_FORM_LABEL,
  ATTRIBUTE_BOOL_LABELS,
  ATTRIBUTE_CANCEL_LABEL,
  ATTRIBUTE_COLUMN_ATTRIBUTE,
  ATTRIBUTE_COLUMN_CURRENT,
  ATTRIBUTE_COLUMN_NEW,
  ATTRIBUTE_COLUMN_STATUS,
  ATTRIBUTE_CONFIRM_LABEL,
  ATTRIBUTE_CONFIRM_UNCERTAIN_HINT,
  ATTRIBUTE_CONFLICT_TITLE,
  ATTRIBUTE_CREATING_JOB_TEXT,
  ATTRIBUTE_NO_CHANGE_TEXT,
  ATTRIBUTE_PREPARING_TEXT,
  ATTRIBUTE_RETRY_ROWS_LABEL,
  ATTRIBUTE_REVIEW_TITLE,
  ATTRIBUTE_SAVE_LABEL,
  ATTRIBUTE_SAVING_TEXT,
  ATTRIBUTE_STATUS_CONFLICT,
  ATTRIBUTE_STATUS_NO_CHANGE,
  ATTRIBUTE_STATUS_READY,
  attributeConflictText,
} from './user-attribute-edit-messages';
import {
  attributeDraftResult,
  attributeEdits,
  attributeWireText,
  attributeDrafts,
  type AttributeDraft,
} from './user-attribute-value-rules';

/** The outcome of one save, for the saved line of the card (composition 13). */
export interface UserAttributeSaveResult {
  outcome: AttributeSaveOutcome;
  /** The user whose card opened this save. A result never moves to another user (R1-A). */
  userId: string;
  displayId: string;
  /** The display names of the attributes that the job writes. */
  attributeNames: string[];
}

/** The step of the card form. The flow ends where it starts (B section 4.2). */
type EditorStep =
  | 'edit'
  | 'preparing'
  | 'review'
  | 'confirming'
  | 'unconfirmed'
  | 'saving';

/**
 * The Custom attributes card form of K25. The whole card edits at once. One change
 * prepares the preview and confirms it in one step, and more changes show the review
 * rows first. Each edit carries the value that the card showed when the edit began.
 */
@Component({
  selector: 'app-user-attribute-editor',
  imports: [
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
  ],
  templateUrl: './user-attribute-editor.html',
  styleUrl: './user-attribute-editor.css',
})
export class UserAttributeEditor implements OnInit {
  readonly user = input.required<UserDetail>();
  readonly categories = input.required<UserAttributeCategory[]>();
  readonly cancelled = output<void>();
  readonly finished = output<UserAttributeSaveResult>();

  protected readonly flow = inject(UserAttributeEditFlow);
  private readonly confirmations = inject(UserAttributeConfirmationStore);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private destroyed = false;

  protected readonly drafts = signal<AttributeDraft[]>([]);
  protected readonly step = signal<EditorStep>('edit');
  /** The refusal of the preview or the confirmation, in the flow (B section 13). */
  protected readonly message = signal('');
  protected readonly preview = signal<UserAttributePreview | null>(null);
  protected readonly targets = signal<UserAttributeTarget[]>([]);
  protected readonly reviewError = signal('');
  protected readonly receiptId = signal<string | null>(null);
  /** The attribute names of the confirmation in flight, replayed after an uncertain answer. */
  private readonly pendingNames = signal<string[]>([]);
  /**
   * The user whose card opened this form. The inputs can point at a later route while the
   * form is alive, so every draft, edit, and result uses this identity (R1-A).
   */
  private subjectUserId = '';
  /**
   * This editor restored a confirmation that another editor left behind. Its store entry
   * drives the step until that one save settles (R3-A, R3-B).
   */
  private restored = false;
  /** The accepted receipt that this editor already observes, so one job has one reader. */
  private resumedDisplayId: string | null = null;

  protected readonly labels = {
    cancel: ATTRIBUTE_CANCEL_LABEL,
    save: ATTRIBUTE_SAVE_LABEL,
    confirm: ATTRIBUTE_CONFIRM_LABEL,
    yes: ATTRIBUTE_BOOL_LABELS.yes,
    no: ATTRIBUTE_BOOL_LABELS.no,
    unset: ATTRIBUTE_BOOL_LABELS.unset,
    preparing: ATTRIBUTE_PREPARING_TEXT,
    creating: ATTRIBUTE_CREATING_JOB_TEXT,
    saving: ATTRIBUTE_SAVING_TEXT,
    reviewTitle: ATTRIBUTE_REVIEW_TITLE,
    noChange: ATTRIBUTE_NO_CHANGE_TEXT,
    conflictTitle: ATTRIBUTE_CONFLICT_TITLE,
    retryRows: ATTRIBUTE_RETRY_ROWS_LABEL,
    backToForm: ATTRIBUTE_BACK_TO_FORM_LABEL,
    columnAttribute: ATTRIBUTE_COLUMN_ATTRIBUTE,
    columnCurrent: ATTRIBUTE_COLUMN_CURRENT,
    columnNew: ATTRIBUTE_COLUMN_NEW,
    columnStatus: ATTRIBUTE_COLUMN_STATUS,
    uncertainHint: ATTRIBUTE_CONFIRM_UNCERTAIN_HINT,
  };

  private readonly firstField =
    viewChild<ElementRef<HTMLElement>>('firstField');
  private readonly reviewTitle =
    viewChild<ElementRef<HTMLElement>>('reviewTitle');
  private readonly uncertainAction = viewChild('uncertainAction', {
    read: ElementRef,
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
    afterNextRender(
      () => {
        const host = this.firstField()?.nativeElement;
        (
          host?.querySelector('input') ?? host?.querySelector('button')
        )?.focus();
      },
      { injector: this.injector },
    );
    // A confirmation that another editor retained changes phase while this form is open:
    // it may leave the creating step, lose its answer, or hand over an accepted receipt.
    effect(() => {
      const entry = this.confirmations.pending(this.subjectUserId);
      untracked(() => {
        if (this.restored) this.applyEntry(entry);
      });
    });
  }

  ngOnInit(): void {
    this.subjectUserId = this.user().userId;
    const drafts = attributeDrafts(
      this.categories(),
      this.user().customSchemas,
    );
    this.drafts.set(drafts);
    // A retained confirmation outlives the editor. Reopening the same card continues the
    // one save instead of preparing another preview (R2-B, R3-A, R3-B).
    const pending = this.confirmations.pending(this.subjectUserId);
    if (pending) {
      this.restored = true;
      this.applyEntry(pending);
      // A page that reloaded cannot keep the first request. Replay its frozen preview
      // before any new preview is prepared (K25).
      if (
        pending.phase === 'confirming' &&
        this.confirmations.restored(this.subjectUserId)
      )
        void this.submit(pending.attributeNames);
    }
  }

  /** The category sections of the form, in the order of the category read. */
  protected readonly sections = computed(() =>
    this.categories().map((category) => {
      const fields = this.drafts().filter(
        (draft) => draft.schemaName === category.schemaName,
      );
      const first = fields[0];
      return {
        schemaName: category.schemaName,
        displayName: category.displayName,
        fields,
        // The approved form gives the outlined controls a 6 px inset after the heading.
        // The plain Yes and No label follows its heading directly (R3-C).
        inset: first
          ? first.field.multiValued || first.field.fieldType !== 'BOOL'
          : false,
      };
    }),
  );

  /** The changed fields with their value rules (B section 8.1). */
  protected readonly changed = computed(() =>
    this.drafts()
      .map((draft) => attributeDraftResult(draft, this.subjectUserId))
      .filter((result) => result.changed),
  );

  protected readonly canSave = computed(
    () =>
      this.step() === 'edit' &&
      this.changed().length > 0 &&
      this.changed().every((result) => result.error === null),
  );

  /** The conflict rows block the save and name their attributes (B section 8.4). */
  protected readonly conflictLabels = computed(() =>
    this.targets()
      .filter((target) => target.disposition === 'conflict')
      .map((target) => this.labelOf(target.attribute)),
  );

  protected readonly conflictText = computed(() =>
    attributeConflictText(this.conflictLabels()),
  );

  /** An Unchanged row needs no job, so a preview without an eligible row cannot confirm. */
  protected readonly canConfirm = computed(() => {
    const preview = this.preview();
    return (
      this.step() === 'review' &&
      preview !== null &&
      preview.conflicts === 0 &&
      preview.eligible > 0 &&
      this.reviewError() === ''
    );
  });

  protected readonly noChange = computed(() => {
    const preview = this.preview();
    return (
      preview !== null &&
      preview.eligible === 0 &&
      preview.conflicts === 0 &&
      this.reviewError() === ''
    );
  });

  protected draftOf(key: string): AttributeDraft | null {
    return this.drafts().find((draft) => draft.key === key) ?? null;
  }

  protected textValue(key: string): string {
    const value = this.draftOf(key)?.value;
    return typeof value === 'string' ? value : '';
  }

  protected chipValues(key: string): string[] {
    const value = this.draftOf(key)?.value;
    return Array.isArray(value) ? value : [];
  }

  /** The message under one field, or null. An unchanged field never blocks the save. */
  protected fieldError(key: string): string | null {
    const draft = this.drafts().find((candidate) => candidate.key === key);
    return draft ? attributeDraftResult(draft, this.subjectUserId).error : null;
  }

  protected setText(key: string, event: Event): void {
    this.update(key, (event.target as HTMLInputElement).value);
  }

  protected setBool(key: string, value: boolean | null): void {
    this.update(key, value);
  }

  protected addChip(key: string, event: MatChipInputEvent): void {
    const text = event.value;
    if (text.length === 0) {
      event.chipInput.clear();
      return;
    }
    const values = this.chipValues(key);
    this.update(key, [...values, text]);
    event.chipInput.clear();
  }

  protected removeChip(key: string, index: number): void {
    const values = [...this.chipValues(key)];
    values.splice(index, 1);
    this.update(key, values);
  }

  protected valueText(value: UserAttributeRowValue | null): string {
    return attributeWireText(value);
  }

  protected statusText(disposition: UserAttributeDisposition): string {
    if (disposition === 'eligible') return ATTRIBUTE_STATUS_READY;
    if (disposition === 'unchanged') return ATTRIBUTE_STATUS_NO_CHANGE;
    return ATTRIBUTE_STATUS_CONFLICT;
  }

  protected labelOf(attribute: string): string {
    const draft = this.drafts().find(
      (candidate) => candidate.key === attribute,
    );
    return draft?.label ?? attribute;
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    void this.save();
  }

  protected async save(): Promise<void> {
    if (!this.canSave()) return;
    const edits = attributeEdits(this.drafts(), this.subjectUserId);
    if (edits.length === 0) return;
    this.message.set('');
    this.reviewError.set('');
    this.step.set('preparing');
    const answer = await this.flow.prepare(edits);
    if (this.destroyed) return;
    if (!answer.ok) {
      this.step.set('edit');
      this.message.set(answer.message);
      return;
    }
    const preview = answer.value;
    this.preview.set(preview);
    // One change confirms at once (owner direction, 2026-10-23). Every other answer
    // shows the frozen rows, where a conflict blocks the confirmation.
    if (edits.length === 1 && preview.eligible === 1) {
      const edit = edits[0];
      if (edit) await this.submit([this.labelOf(edit.attribute)]);
      return;
    }
    const targets = await this.flow.readTargets(preview.previewId);
    if (this.destroyed) return;
    if (!targets.ok) {
      this.reviewError.set(targets.message);
      this.step.set('review');
      this.focusReview();
      return;
    }
    this.targets.set(targets.value);
    this.step.set('review');
    this.focusReview();
  }

  protected retryRows(): void {
    void this.loadRows();
  }

  protected confirmReview(): void {
    if (!this.canConfirm()) return;
    const names = this.targets()
      .filter((target) => target.disposition === 'eligible')
      .map((target) => this.labelOf(target.attribute));
    void this.submit(names);
  }

  protected backToForm(): void {
    this.preview.set(null);
    this.targets.set([]);
    this.reviewError.set('');
    this.message.set('');
    this.step.set('edit');
    this.focusFirstField();
  }

  protected cancel(): void {
    this.cancelled.emit();
  }

  /** Replay the confirmation of the preview that the uncertain answer left in place (R1-D). */
  protected retryConfirm(): void {
    if (this.step() !== 'unconfirmed') return;
    void this.submit(this.pendingNames());
  }

  private update(key: string, value: string | boolean | null | string[]): void {
    this.drafts.update((drafts) =>
      drafts.map((draft) => (draft.key === key ? { ...draft, value } : draft)),
    );
  }

  private async loadRows(): Promise<void> {
    const preview = this.preview();
    if (!preview) return;
    this.reviewError.set('');
    const targets = await this.flow.readTargets(preview.previewId);
    if (this.destroyed) return;
    if (!targets.ok) {
      this.reviewError.set(targets.message);
      return;
    }
    this.targets.set(targets.value);
  }

  private async submit(attributeNames: string[]): Promise<void> {
    const preview = this.preview();
    if (!preview) return;
    // A preview that already lost one answer stays unresolved through a later refusal (R2-B).
    const unresolved = this.confirmations.isPending(preview.previewId);
    this.pendingNames.set(attributeNames);
    this.message.set('');
    // Record the frozen identity before the first send. A form that opens while this answer
    // is in flight waits for the one save instead of preparing a second preview (R3-A).
    this.confirmations.begin(this.subjectUserId, preview, attributeNames);
    this.step.set('confirming');
    const receipt = await this.flow.confirm(
      preview.previewId,
      preview.manifestDigest,
    );
    if (!receipt.ok && (receipt.uncertain || unresolved)) {
      // The answer may have created the job. Keep the preview, its digest, and the submitted
      // names until a receipt answers this same confirmation (R2-B).
      this.confirmations.uncertain(
        this.subjectUserId,
        preview,
        attributeNames,
        receipt.message,
      );
      if (this.destroyed) return;
      this.message.set(receipt.message);
      this.step.set('unconfirmed');
      this.focusUncertain();
      return;
    }
    if (!receipt.ok) {
      // A definite refusal releases the preview identity. A form that reopens after this
      // answer shows the sentence and its editors again (R3-A).
      this.confirmations.refuse(
        this.subjectUserId,
        preview,
        attributeNames,
        receipt.message,
      );
      if (this.destroyed) return;
      this.confirmations.resolve(preview.previewId);
      this.preview.set(null);
      this.step.set('edit');
      this.message.set(receipt.message);
      return;
    }
    // Hand the accepted receipt and its submission context to the store before any state
    // clears, so a destroyed editor loses neither the job nor the card that owns it (R3-B).
    const displayId = receipt.value.displayId;
    this.confirmations.accept(
      this.subjectUserId,
      preview,
      attributeNames,
      displayId,
    );
    this.resumedDisplayId = displayId;
    if (this.destroyed) return;
    this.receiptId.set(displayId);
    this.step.set('saving');
    const job = await this.flow.waitForJob(
      displayId,
      120,
      1000,
      () => this.destroyed,
    );
    // A destroyed editor leaves the accepted entry for its next owner (R3-B).
    if (this.destroyed) return;
    // A job that never settled, or a job whose answer never arrived, keeps its receipt.
    // One save stays under recovery until its job answers, through the next owner (R4-A).
    const outcome: AttributeSaveOutcome = !job.ok
      ? 'unsettled'
      : attributeJobOutcome(job.value.status);
    if (outcome !== 'unsettled') this.confirmations.resolve(preview.previewId);
    this.finished.emit({
      outcome,
      userId: this.subjectUserId,
      displayId,
      attributeNames,
    });
  }

  /**
   * Bring the step in line with a retained confirmation. A reopened form honors the answer
   * that is still in flight, keeps the recovery screen after an unknown answer, observes
   * an accepted receipt, and returns to its editors after a definite refusal (R3-A, R3-B).
   */
  private applyEntry(entry: PendingAttributeConfirmation | null): void {
    if (!entry) {
      if (this.step() === 'confirming') {
        this.restored = false;
        this.preview.set(null);
        this.step.set('edit');
        this.focusFirstField();
      }
      return;
    }
    if (entry.phase === 'confirming') {
      this.preview.set(entry.preview);
      this.pendingNames.set(entry.attributeNames);
      this.message.set(entry.message);
      if (this.step() !== 'confirming') this.step.set('confirming');
      return;
    }
    if (entry.phase === 'uncertain') {
      this.preview.set(entry.preview);
      this.pendingNames.set(entry.attributeNames);
      this.message.set(entry.message);
      if (this.step() !== 'unconfirmed') {
        this.step.set('unconfirmed');
        this.focusUncertain();
      }
      return;
    }
    if (entry.phase === 'refused') {
      // The refusal released the one identity, so the form may edit and save again.
      this.restored = false;
      this.confirmations.resolve(entry.preview.previewId);
      this.preview.set(null);
      this.pendingNames.set([]);
      this.step.set('edit');
      this.message.set(entry.message);
      this.focusFirstField();
      return;
    }
    this.preview.set(entry.preview);
    this.pendingNames.set(entry.attributeNames);
    if (entry.displayId) this.receiptId.set(entry.displayId);
    this.step.set('saving');
    if (entry.displayId === null || this.resumedDisplayId === entry.displayId)
      return;
    this.resumedDisplayId = entry.displayId;
    void this.resumeAccepted(entry);
  }

  /** Observe the accepted receipt of a closed form, then report it to the card (R3-B). */
  private async resumeAccepted(
    entry: PendingAttributeConfirmation,
  ): Promise<void> {
    const displayId = entry.displayId;
    if (!displayId) return;
    const job = await this.flow.waitForJob(
      displayId,
      120,
      1000,
      () => this.destroyed,
    );
    if (this.destroyed) return;
    const outcome: AttributeSaveOutcome = !job.ok
      ? 'unsettled'
      : attributeJobOutcome(job.value.status);
    // The receipt keeps its recovery owner until the job answers (R4-A).
    if (outcome !== 'unsettled')
      this.confirmations.resolve(entry.preview.previewId);
    this.finished.emit({
      outcome,
      userId: entry.userId,
      displayId,
      attributeNames: entry.attributeNames,
    });
  }

  private focusFirstField(): void {
    afterNextRender(
      () => {
        const host = this.firstField()?.nativeElement;
        (
          host?.querySelector('input') ?? host?.querySelector('button')
        )?.focus();
      },
      { injector: this.injector },
    );
  }

  private focusReview(): void {
    afterNextRender(() => this.reviewTitle()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  private focusUncertain(): void {
    afterNextRender(() => this.uncertainAction()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }
}
