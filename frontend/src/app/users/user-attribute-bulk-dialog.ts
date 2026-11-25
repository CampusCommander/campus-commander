import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CdkTrapFocus } from '@angular/cdk/a11y';
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
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import type {
  JobAttributeRow,
  JobAttributeRowView,
  JobAttributeRowsPage,
  JobDetail,
  UserAttributeCategory,
  UserAttributeChange,
  UserAttributeChangeMode,
  UserAttributeField,
  UserAttributePreview,
  UserAttributeTarget,
  UserAttributeTargetsPage,
  UserSelectionKey,
} from '@campus/application-contracts';
import {
  JOB_STATUS_LABELS,
  formatTimestamp,
  statusTone,
} from '../jobs/job-fields';
import { OUTCOME_LABELS, outcomeTone } from '../jobs/job-detail-fields';
import {
  ATTRIBUTE_BACK_TO_FORM_LABEL,
  ATTRIBUTE_BOOL_LABELS,
  ATTRIBUTE_COLUMN_CURRENT,
  ATTRIBUTE_COLUMN_NEW,
  ATTRIBUTE_CONFIRM_LABEL,
  ATTRIBUTE_CONFIRM_UNCERTAIN_HINT,
  ATTRIBUTE_CONFLICT_TITLE,
  ATTRIBUTE_CREATING_JOB_TEXT,
  ATTRIBUTE_PREPARING_TEXT,
  ATTRIBUTE_RETRY_ROWS_LABEL,
  ATTRIBUTE_SAVING_TEXT,
  ATTRIBUTE_STATUS_CONFLICT,
  ATTRIBUTE_STATUS_NO_CHANGE,
  ATTRIBUTE_STATUS_READY,
} from './user-attribute-edit-messages';
import {
  attributeEditorValue,
  attributeValueError,
  attributeWireText,
  attributeWireValue,
  type AttributeDraft,
} from './user-attribute-value-rules';
import { UserAttributeEditFlow } from './user-attribute-edit-flow';
import { UserAttributeHelp } from './user-attribute-help';
import { NO_FAILED_CHANGES } from './user-category-messages';
import {
  BULK_PAGE_SIZE,
  UserAttributeBulkFlow,
} from './user-attribute-bulk-flow';
import {
  BULK_ATTRIBUTE_LABEL,
  BULK_BACK_LABEL,
  BULK_CANCEL_LABEL,
  BULK_CATEGORIES_LOADING_TEXT,
  BULK_CATEGORY_LABEL,
  BULK_CHANGES_TERM,
  BULK_CONFLICT_TEXT,
  BULK_DONE_LABEL,
  BULK_EMAIL_COLUMN,
  BULK_EXECUTED_BY,
  BULK_FAILED_TERM,
  BULK_FINISHED,
  BULK_JOB_PREFIX,
  BULK_JOB_UNREADABLE_TEXT,
  BULK_LOADING_RESULTS_TEXT,
  BULK_MODE_LABEL,
  BULK_NO_CATEGORIES_TEXT,
  BULK_NO_FIELDS_TEXT,
  BULK_NO_RESULTS,
  BULK_NO_REVIEW_ROWS,
  BULK_OUTCOME_COLUMN,
  BULK_REVIEW_LABEL,
  BULK_ROWS_UNAVAILABLE_TEXT,
  BULK_SET_ATTRIBUTES_LABEL,
  BULK_STALE_TEXT,
  BULK_SUCCEEDED_TERM,
  BULK_USER_COLUMN,
  BULK_USERS_TERM,
  BULK_VALUE_LABEL,
  BULK_VALUE_REQUIRED_TEXT,
  BULK_VALUES_LABEL,
  BULK_VALUES_REQUIRED_TEXT,
  bulkConfirmLabel,
  bulkInfoHint,
  bulkModeLabel,
  bulkPagerText,
  bulkSelectedUsersText,
} from './user-attribute-bulk-messages';

/** The steps of the dialog (UM states 08 to 11). */
type BulkStep =
  | 'setup'
  | 'preparing'
  | 'review'
  | 'progress'
  | 'result'
  | 'unreadable';

type ReviewView = 'eligible' | 'unchanged';
type ResultView = JobAttributeRowView;

/**
 * The Set attributes dialog of the Users Bulk Actions (design cards K23, K24, J4, and
 * K27; UM states 08 to 11). It collects one attribute change, shows the server preview
 * one page at a time, then confirms the job and shows its result rows. The selection
 * travels as the grid key, so the browser never holds the selected users.
 */
@Component({
  selector: 'app-user-attribute-bulk-dialog',
  imports: [
    CdkTrapFocus,
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatRadioModule,
    MatSelectModule,
    MatTabsModule,
    UserAttributeHelp,
  ],
  templateUrl: './user-attribute-bulk-dialog.html',
  styleUrls: [
    '../devices/device-dialog.css',
    '../devices/device-export-import-dialog.css',
    '../devices/device-import-dialog.css',
    '../devices/device-results-dialog.css',
    './user-attribute-bulk-dialog.css',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserAttributeBulkDialog implements OnInit, OnDestroy {
  /** The grid key of the selection. The request never names a user. */
  readonly selection = input.required<UserSelectionKey>();
  /** The count that the page holds, for the setup subtitle. */
  readonly selected = input.required<number>();
  /** The category cache of the account. */
  readonly categories = input.required<readonly UserAttributeCategory[]>();
  readonly categoriesLoading = input(false);
  /** The read message of the category cache, when that read failed (UI-08). */
  readonly categoriesError = input('');
  /**
   * A preview that another card already prepared from its edit list (card K26). The
   * dialog opens at the review step and confirms that preview.
   */
  readonly prepared = input<UserAttributePreview | null>(null);

  readonly closed = output<void>();
  /** A caller that follows the one save (card K26). */
  readonly accepted = output<string>();
  /** Asks the page to read the category cache again. */
  readonly categoriesRetry = output<void>();

  private readonly flow = inject(UserAttributeBulkFlow);
  private readonly editFlow = inject(UserAttributeEditFlow);
  private readonly injector = inject(Injector);

  private readonly dialogTitle =
    viewChild<ElementRef<HTMLElement>>('dialogTitle');

  protected readonly step = signal<BulkStep>('setup');
  protected readonly helpOpen = signal(false);
  protected readonly confirming = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly attempted = signal(false);

  /** The setup form. The draft follows the chosen category, attribute, and mode. */
  protected readonly categoryName = signal<string | null>(null);
  protected readonly fieldName = signal<string | null>(null);
  protected readonly mode = signal<UserAttributeChangeMode>('set');
  private readonly editorValue = signal<{
    key: string;
    value: AttributeDraft['value'];
  } | null>(null);

  protected readonly chosenCategory = computed<UserAttributeCategory | null>(
    () => {
      const categories = this.categories();
      const chosen = categories.find(
        (category) => category.schemaName === this.categoryName(),
      );
      return (
        chosen ??
        categories.find((category) => category.fields.length > 0) ??
        categories[0] ??
        null
      );
    },
  );

  protected readonly chosenField = computed<UserAttributeField | null>(() => {
    const category = this.chosenCategory();
    if (!category) return null;
    return (
      category.fields.find((field) => field.fieldName === this.fieldName()) ??
      category.fields[0] ??
      null
    );
  });

  protected readonly modeOptions = computed(() => {
    const field = this.chosenField();
    if (!field) return [];
    const modes: UserAttributeChangeMode[] = field.multiValued
      ? ['add', 'remove', 'replace', 'clear']
      : ['set', 'clear'];
    return modes.map((mode) => ({
      mode,
      label: bulkModeLabel(mode, field.multiValued),
    }));
  });

  /** The mode to send. A kind change falls back to the first mode of the new kind. */
  protected readonly activeMode = computed<UserAttributeChangeMode>(() => {
    const options = this.modeOptions();
    return options.some((option) => option.mode === this.mode())
      ? this.mode()
      : (options[0]?.mode ?? 'set');
  });

  protected readonly draft = computed<AttributeDraft | null>(() => {
    const category = this.chosenCategory();
    const field = this.chosenField();
    if (!category || !field) return null;
    const key = `${category.schemaName}.${field.fieldName}`;
    const state = this.editorValue();
    return {
      key,
      schemaName: category.schemaName,
      fieldName: field.fieldName,
      label: field.displayName,
      field,
      baseline: null,
      value:
        state?.key === key ? state.value : attributeEditorValue(null, field),
    };
  });

  protected readonly chipValues = computed<string[]>(() => {
    const value = this.draft()?.value;
    return Array.isArray(value) ? value : [];
  });

  protected readonly textValue = computed(() => {
    const value = this.draft()?.value;
    return typeof value === 'string' ? value : '';
  });

  protected readonly boolValue = computed(() => {
    const value = this.draft()?.value;
    return typeof value === 'boolean' ? value : null;
  });

  /** The value message after the first Review attempt, or after an edit fixes it. */
  protected readonly valueError = computed(() => {
    if (!this.attempted()) return null;
    const draft = this.draft();
    if (!draft) return null;
    if (this.activeMode() === 'clear') return null;
    if (attributeWireValue(draft) === null)
      return draft.field.multiValued
        ? BULK_VALUES_REQUIRED_TEXT
        : BULK_VALUE_REQUIRED_TEXT;
    return attributeValueError(draft);
  });

  protected readonly valueLabel = computed(() =>
    this.chosenField()?.multiValued ? BULK_VALUES_LABEL : BULK_VALUE_LABEL,
  );

  /** The input control of composition 5: date, email, phone, or plain text. */
  protected readonly inputType = computed(() => {
    const type = this.chosenField()?.fieldType;
    if (type === 'DATE') return 'date';
    if (type === 'EMAIL') return 'email';
    if (type === 'PHONE') return 'tel';
    return 'text';
  });

  protected readonly inputMode = computed(() => {
    const type = this.chosenField()?.fieldType;
    if (type === 'INT64') return 'numeric';
    if (type === 'DOUBLE') return 'decimal';
    return null;
  });

  protected readonly hint = computed(() => {
    const field = this.chosenField();
    return field ? bulkInfoHint(field) : '';
  });

  protected readonly setupSubtitle = computed(() =>
    bulkSelectedUsersText(this.selected()),
  );

  /** The preview, its rows, and the page stack of the current review view. */
  protected readonly preview = signal<UserAttributePreview | null>(null);
  protected readonly reviewView = signal<ReviewView>('eligible');
  protected readonly reviewRows = signal<readonly UserAttributeTarget[]>([]);
  protected readonly reviewLoading = signal(false);
  protected readonly reviewError = signal<string | null>(null);
  protected readonly reviewNext = signal<string | null>(null);
  private readonly reviewStack = signal<readonly (string | null)[]>([null]);

  protected readonly reviewPage = computed(() => this.reviewStack().length - 1);
  protected readonly reviewCursor = computed(
    () => this.reviewStack()[this.reviewStack().length - 1] ?? null,
  );
  protected readonly canReviewBack = computed(() => this.reviewPage() > 0);
  protected readonly canReviewNext = computed(() => !!this.reviewNext());
  protected readonly reviewTabs = computed(() => {
    const preview = this.preview();
    return [
      {
        view: 'eligible' as const,
        label: ATTRIBUTE_STATUS_READY,
        count: preview?.eligible ?? 0,
      },
      {
        view: 'unchanged' as const,
        label: ATTRIBUTE_STATUS_NO_CHANGE,
        count: preview?.unchanged ?? 0,
      },
    ];
  });
  protected readonly reviewNoun = computed(() =>
    this.reviewView() === 'eligible' ? 'proposed changes' : 'changes',
  );
  protected readonly reviewPagerText = computed(() => {
    const preview = this.preview();
    const total =
      this.reviewView() === 'eligible'
        ? (preview?.eligible ?? 0)
        : (preview?.unchanged ?? 0);
    return bulkPagerText(
      this.reviewPage() * BULK_PAGE_SIZE + 1,
      this.reviewRows().length,
      total,
      this.reviewNoun(),
    );
  });

  /** The review subtitle and change line (state 09). */
  protected readonly reviewSubtitle = computed(() => {
    const preview = this.preview();
    if (!preview) return this.setupSubtitle();
    const change = preview.changes?.[0];
    if (!change) return bulkSelectedUsersText(preview.selected);
    const category = this.categories().find(
      (item) => item.schemaName === change.schemaName,
    );
    const field = category?.fields.find(
      (item) => item.fieldName === change.fieldName,
    );
    return `${bulkSelectedUsersText(preview.selected)} · ${
      category?.displayName ?? change.schemaName
    } · ${field?.displayName ?? change.fieldName}`;
  });

  protected readonly changeLine = computed(() => {
    const change = this.preview()?.changes?.[0];
    if (!change) return null;
    const field = this.fieldOf(change.schemaName, change.fieldName);
    const label = field?.displayName ?? change.fieldName;
    const modeLabel = bulkModeLabel(
      change.mode,
      field?.multiValued ?? change.mode !== 'set',
    );
    if (change.mode === 'clear') return `${label} · ${modeLabel}`;
    return `${label} · ${modeLabel} · ${attributeWireText(change.values)}`;
  });

  protected readonly confirmLabel = computed(() =>
    bulkConfirmLabel(this.preview()?.eligible ?? 0),
  );

  /** The accepted job, the result rows, and the page stack. */
  protected readonly displayId = signal<string | null>(null);
  protected readonly receiptStatus = signal<'accepted' | null>(null);
  protected readonly job = signal<JobDetail | null>(null);
  protected readonly resultView = signal<ResultView>('all');
  protected readonly resultRows = signal<readonly JobAttributeRow[]>([]);
  protected readonly resultTotals = signal({ all: 0, failed: 0 });
  protected readonly resultLoading = signal(false);
  protected readonly resultError = signal<string | null>(null);
  protected readonly resultNext = signal<string | null>(null);
  protected readonly jobError = signal<string | null>(null);
  private readonly resultStack = signal<readonly (string | null)[]>([null]);

  protected readonly resultPage = computed(() => this.resultStack().length - 1);
  protected readonly resultCursor = computed(
    () => this.resultStack()[this.resultStack().length - 1] ?? null,
  );
  protected readonly canResultBack = computed(() => this.resultPage() > 0);
  protected readonly canResultNext = computed(() => !!this.resultNext());
  protected readonly resultTabs = computed(() => {
    const totals = this.resultTotals();
    return [
      { view: 'all' as const, label: 'All', count: totals.all, tone: '' },
      {
        view: 'failed' as const,
        label: BULK_FAILED_TERM,
        count: totals.failed,
        tone: totals.failed ? 'error' : '',
      },
    ];
  });
  protected readonly resultPagerText = computed(() => {
    const total =
      this.resultView() === 'all'
        ? this.resultTotals().all
        : this.resultTotals().failed;
    return bulkPagerText(
      this.resultPage() * BULK_PAGE_SIZE + 1,
      this.resultRows().length,
      total,
      BULK_CHANGES_TERM,
    );
  });

  protected readonly resultCounts = computed(() => {
    const progress = this.job()?.progress;
    return [
      {
        label: BULK_CHANGES_TERM,
        count: progress?.total ?? this.resultTotals().all,
        tone: '',
      },
      {
        label: BULK_SUCCEEDED_TERM,
        count: progress?.succeeded ?? 0,
        tone: 'success',
      },
      {
        label: BULK_FAILED_TERM,
        count: progress?.failed ?? 0,
        tone: 'error',
      },
      ...(progress?.unknown
        ? [
            {
              label: OUTCOME_LABELS.unknown,
              count: progress.unknown,
              tone: 'warning',
            },
          ]
        : []),
    ];
  });

  protected readonly statusLabel = computed(() => {
    const job = this.job();
    if (job) return JOB_STATUS_LABELS[job.status];
    const receipt = this.receiptStatus();
    return receipt ? JOB_STATUS_LABELS[receipt] : '';
  });

  protected readonly statusTone = computed(() => {
    const job = this.job();
    return job ? statusTone(job.status) : 'neutral';
  });

  protected readonly finishedLine = computed(() => {
    const finished = this.job()?.finishedAt;
    return finished ? `${BULK_FINISHED} ${formatTimestamp(finished)}` : '';
  });

  protected readonly executedLine = computed(() => {
    const job = this.job();
    if (!job) return '';
    const person = job.confirmedBy ?? job.requestedBy;
    const at = job.finishedAt ?? job.createdAt;
    return `${BULK_EXECUTED_BY} ${person.displayName} · ${formatTimestamp(at)}`;
  });

  /** The dialog widens for the review and the result (UM notes owner direction). */
  protected readonly wide = computed(
    () => this.step() !== 'setup' && this.step() !== 'preparing',
  );

  protected readonly subtitle = computed(() => {
    if (this.step() === 'review') return this.reviewSubtitle();
    if (
      this.step() === 'result' ||
      this.step() === 'progress' ||
      this.step() === 'unreadable'
    )
      return `${BULK_JOB_PREFIX}${this.displayId()} · ${this.statusLabel() || ATTRIBUTE_SAVING_TEXT}`;
    return this.setupSubtitle();
  });

  private done = false;

  ngOnInit(): void {
    const prepared = this.prepared();
    if (!prepared) return;
    this.preview.set(prepared);
    this.step.set('review');
    this.resetReviewStack();
    void this.loadReviewPage('eligible', null);
  }

  ngOnDestroy(): void {
    this.done = true;
  }

  protected close(): void {
    if (this.done) return;
    this.done = true;
    this.closed.emit();
  }

  protected toggleHelp(): void {
    this.helpOpen.update((open) => !open);
  }

  protected chooseCategory(schemaName: string): void {
    this.categoryName.set(schemaName);
    this.fieldName.set(null);
    this.attempted.set(false);
    this.error.set(null);
  }

  protected chooseField(fieldName: string): void {
    this.fieldName.set(fieldName);
    this.attempted.set(false);
    this.error.set(null);
  }

  protected chooseMode(mode: UserAttributeChangeMode): void {
    this.mode.set(mode);
    this.attempted.set(false);
  }

  protected setText(event: Event): void {
    this.setValue((event.target as HTMLInputElement).value);
  }

  protected setBool(value: boolean | null): void {
    if (value === null) return;
    this.setValue(value);
  }

  protected addChip(event: MatChipInputEvent): void {
    const text = event.value;
    if (text.length === 0) {
      event.chipInput.clear();
      return;
    }
    this.setValue([...this.chipValues(), text]);
    event.chipInput.clear();
  }

  protected removeChip(index: number): void {
    const values = [...this.chipValues()];
    values.splice(index, 1);
    this.setValue(values);
  }

  private setValue(value: AttributeDraft['value']): void {
    const draft = this.draft();
    if (!draft) return;
    this.editorValue.set({ key: draft.key, value });
    this.attempted.set(true);
  }

  /** Validate, prepare the preview, and open the review (state 09). */
  protected async review(): Promise<void> {
    const draft = this.draft();
    const mode = this.activeMode();
    this.attempted.set(true);
    this.error.set(null);
    if (!draft) return;
    if (this.valueError()) return;
    const wire = mode === 'clear' ? null : attributeWireValue(draft);
    const values = wire === null ? [] : Array.isArray(wire) ? wire : [wire];
    const change: UserAttributeChange = {
      schemaName: draft.schemaName,
      fieldName: draft.fieldName,
      mode,
      values,
    };
    this.step.set('preparing');
    const answer = await this.flow.prepare(this.selection(), [change]);
    if (this.done) return;
    if (!answer.ok) {
      this.step.set('setup');
      this.error.set(answer.message);
      this.focusStep();
      return;
    }
    this.preview.set(answer.value);
    this.step.set('review');
    this.reviewView.set('eligible');
    this.resetReviewStack();
    this.reviewRows.set([]);
    this.reviewNext.set(null);
    this.reviewError.set(null);
    this.focusStep();
    void this.loadReviewPage('eligible', null);
  }

  /** Back from the review. A prepared edit-list preview returns to its caller. */
  protected back(): void {
    if (this.step() !== 'review') return;
    if (this.prepared()) {
      this.close();
      return;
    }
    this.preview.set(null);
    this.step.set('setup');
    this.focusStep();
  }

  protected setReviewView(view: ReviewView): void {
    if (view === this.reviewView()) return;
    this.reviewView.set(view);
    this.resetReviewStack();
    this.reviewRows.set([]);
    this.reviewNext.set(null);
    this.reviewError.set(null);
    void this.loadReviewPage(view, null);
  }

  private resetReviewStack(): void {
    this.reviewStack.set([null]);
  }

  private async loadReviewPage(
    view: ReviewView,
    cursor: string | null,
  ): Promise<void> {
    const preview = this.preview();
    if (!preview) return;
    this.reviewLoading.set(true);
    this.reviewError.set(null);
    this.reviewRows.set([]);
    this.reviewNext.set(null);
    const answer = await this.flow.readTargetsPage(
      preview.previewId,
      view,
      cursor,
    );
    if (this.done) return;
    this.reviewLoading.set(false);
    if (!answer.ok) {
      this.reviewError.set(answer.message);
      this.reviewRows.set([]);
      this.reviewNext.set(null);
      return;
    }
    this.applyReviewPage(answer.value);
  }

  private applyReviewPage(page: UserAttributeTargetsPage): void {
    this.reviewRows.set(page.targets);
    this.reviewNext.set(page.nextCursor);
  }

  protected retryReview(): void {
    void this.loadReviewPage(this.reviewView(), this.reviewCursor());
  }

  protected reviewNextPage(): void {
    const cursor = this.reviewNext();
    if (!cursor) return;
    this.reviewStack.update((stack) => [...stack, cursor]);
    void this.loadReviewPage(this.reviewView(), cursor);
  }

  protected reviewPrevPage(): void {
    if (this.reviewPage() === 0) return;
    this.reviewStack.update((stack) => stack.slice(0, -1));
    void this.loadReviewPage(this.reviewView(), this.reviewCursor());
  }

  protected readonly canConfirm = computed(
    () =>
      this.step() === 'review' &&
      !this.confirming() &&
      !this.reviewLoading() &&
      !this.reviewError() &&
      (this.preview()?.conflicts ?? 0) === 0 &&
      (this.preview()?.eligible ?? 0) > 0,
  );

  /** Confirm the preview, then follow the job to its result (state 10). */
  protected async confirm(): Promise<void> {
    const preview = this.preview();
    if (!preview || !this.canConfirm()) return;
    this.error.set(null);
    this.confirming.set(true);
    const answer = await this.editFlow.confirm(
      preview.previewId,
      preview.manifestDigest,
    );
    if (this.done) return;
    this.confirming.set(false);
    if (!answer.ok) {
      this.error.set(
        answer.uncertain
          ? `${answer.message} ${ATTRIBUTE_CONFIRM_UNCERTAIN_HINT}`
          : answer.message,
      );
      if (!answer.uncertain) {
        // The refusal keeps the setup so the person can correct the change.
        this.preview.set(null);
        this.step.set('setup');
      }
      this.focusStep();
      return;
    }
    this.displayId.set(answer.value.displayId);
    this.receiptStatus.set(answer.value.status);
    this.accepted.emit(answer.value.displayId);
    this.step.set('progress');
    this.focusStep();
    const settled = await this.editFlow.waitForJob(
      answer.value.displayId,
      120,
      1000,
      () => this.done,
    );
    if (this.done) return;
    if (!settled.ok) {
      this.jobError.set(settled.message);
      this.step.set('unreadable');
      this.focusStep();
      return;
    }
    this.job.set(settled.value);
    this.step.set('result');
    this.resultView.set('all');
    this.resetResultStack();
    this.resultRows.set([]);
    this.resultNext.set(null);
    this.resultError.set(null);
    this.focusStep();
    void this.loadResults('all', null);
  }

  protected setResultView(view: ResultView): void {
    if (view === this.resultView()) return;
    this.resultView.set(view);
    this.resetResultStack();
    this.resultRows.set([]);
    this.resultNext.set(null);
    this.resultError.set(null);
    void this.loadResults(view, null);
  }

  private resetResultStack(): void {
    this.resultStack.set([null]);
  }

  private async loadResults(
    view: ResultView,
    cursor: string | null,
  ): Promise<void> {
    const displayId = this.displayId();
    if (!displayId) return;
    this.resultLoading.set(true);
    this.resultError.set(null);
    this.resultRows.set([]);
    this.resultNext.set(null);
    const answer = await this.flow.readRowsPage(displayId, view, cursor);
    if (this.done) return;
    this.resultLoading.set(false);
    if (!answer.ok) {
      this.resultError.set(answer.message);
      this.resultRows.set([]);
      this.resultNext.set(null);
      return;
    }
    this.applyResultPage(answer.value);
  }

  private applyResultPage(page: JobAttributeRowsPage): void {
    this.resultRows.set(page.rows);
    this.resultTotals.set(page.totals);
    this.resultNext.set(page.nextCursor);
  }

  protected retryResults(): void {
    void this.loadResults(this.resultView(), this.resultCursor());
  }

  protected resultNextPage(): void {
    const cursor = this.resultNext();
    if (!cursor) return;
    this.resultStack.update((stack) => [...stack, cursor]);
    void this.loadResults(this.resultView(), cursor);
  }

  protected resultPrevPage(): void {
    if (this.resultPage() === 0) return;
    this.resultStack.update((stack) => stack.slice(0, -1));
    void this.loadResults(this.resultView(), this.resultCursor());
  }

  protected fieldOf(
    schemaName: string,
    fieldName: string,
  ): UserAttributeField | null {
    return (
      this.categories()
        .find((category) => category.schemaName === schemaName)
        ?.fields.find((field) => field.fieldName === fieldName) ?? null
    );
  }

  protected userText(row: {
    userName?: string | null;
    primaryEmail: string;
  }): string {
    return row.userName ?? row.primaryEmail;
  }

  protected valueText(value: JobAttributeRow['currentValue']): string {
    return attributeWireText(value);
  }

  protected outcomeLabel(row: JobAttributeRow): string {
    return OUTCOME_LABELS[row.outcome];
  }

  protected outcomeChipClass(row: JobAttributeRow): string {
    return `status-chip small tone-${outcomeTone(row.outcome)}`;
  }

  protected statusChipClass(): string {
    return `status-chip job-chip tone-${this.statusTone()}`;
  }

  protected reviewTabClass(tone: string): string {
    return tone ? `tab-count tone-${tone}` : 'tab-count';
  }

  /** The step heading takes focus after a step change (UI-09). */
  protected focusStep(): void {
    afterNextRender(() => this.dialogTitle()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected readonly BULK_SET_ATTRIBUTES_LABEL = BULK_SET_ATTRIBUTES_LABEL;
  protected readonly BULK_CATEGORY_LABEL = BULK_CATEGORY_LABEL;
  protected readonly BULK_ATTRIBUTE_LABEL = BULK_ATTRIBUTE_LABEL;
  protected readonly BULK_MODE_LABEL = BULK_MODE_LABEL;
  protected readonly BULK_VALUE_LABEL = BULK_VALUE_LABEL;
  protected readonly BULK_VALUES_LABEL = BULK_VALUES_LABEL;
  protected readonly BULK_REVIEW_LABEL = BULK_REVIEW_LABEL;
  protected readonly BULK_BACK_LABEL = BULK_BACK_LABEL;
  protected readonly BULK_CANCEL_LABEL = BULK_CANCEL_LABEL;
  protected readonly BULK_DONE_LABEL = BULK_DONE_LABEL;
  protected readonly BULK_USER_COLUMN = BULK_USER_COLUMN;
  protected readonly BULK_EMAIL_COLUMN = BULK_EMAIL_COLUMN;
  protected readonly BULK_USERS_TERM = BULK_USERS_TERM;
  protected readonly BULK_CHANGES_TERM = BULK_CHANGES_TERM;
  protected readonly BULK_OUTCOME_COLUMN = BULK_OUTCOME_COLUMN;
  protected readonly BULK_CONFLICT_TEXT = BULK_CONFLICT_TEXT;
  protected readonly BULK_STALE_TEXT = BULK_STALE_TEXT;
  protected readonly BULK_NO_CATEGORIES_TEXT = BULK_NO_CATEGORIES_TEXT;
  protected readonly BULK_NO_FIELDS_TEXT = BULK_NO_FIELDS_TEXT;
  protected readonly BULK_CATEGORIES_LOADING_TEXT =
    BULK_CATEGORIES_LOADING_TEXT;
  protected readonly BULK_NO_REVIEW_ROWS = BULK_NO_REVIEW_ROWS;
  protected readonly BULK_NO_RESULTS = BULK_NO_RESULTS;
  protected readonly BULK_LOADING_RESULTS_TEXT = BULK_LOADING_RESULTS_TEXT;
  protected readonly BULK_NO_FAILED_CHANGES = NO_FAILED_CHANGES;
  protected readonly BULK_JOB_PREFIX = BULK_JOB_PREFIX;
  protected readonly BULK_ROWS_UNAVAILABLE_TEXT = BULK_ROWS_UNAVAILABLE_TEXT;
  protected readonly BULK_JOB_UNREADABLE_TEXT = BULK_JOB_UNREADABLE_TEXT;
  protected readonly ATTRIBUTE_PREPARING_TEXT = ATTRIBUTE_PREPARING_TEXT;
  protected readonly ATTRIBUTE_CREATING_JOB_TEXT = ATTRIBUTE_CREATING_JOB_TEXT;
  protected readonly ATTRIBUTE_SAVING_TEXT = ATTRIBUTE_SAVING_TEXT;
  protected readonly ATTRIBUTE_CONFIRM_LABEL = ATTRIBUTE_CONFIRM_LABEL;
  protected readonly ATTRIBUTE_BACK_TO_FORM_LABEL =
    ATTRIBUTE_BACK_TO_FORM_LABEL;
  protected readonly ATTRIBUTE_RETRY_ROWS_LABEL = ATTRIBUTE_RETRY_ROWS_LABEL;
  protected readonly ATTRIBUTE_COLUMN_CURRENT = ATTRIBUTE_COLUMN_CURRENT;
  protected readonly ATTRIBUTE_COLUMN_NEW = ATTRIBUTE_COLUMN_NEW;
  protected readonly ATTRIBUTE_BOOL_LABELS = ATTRIBUTE_BOOL_LABELS;
  protected readonly ATTRIBUTE_CONFLICT_TITLE = ATTRIBUTE_CONFLICT_TITLE;
  protected readonly ATTRIBUTE_STATUS_CONFLICT = ATTRIBUTE_STATUS_CONFLICT;
  protected readonly ATTRIBUTE_STATUS_NO_CHANGE = ATTRIBUTE_STATUS_NO_CHANGE;
  protected readonly ATTRIBUTE_STATUS_READY = ATTRIBUTE_STATUS_READY;
}
